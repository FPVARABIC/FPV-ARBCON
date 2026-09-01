jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

/**
 * EVERY WAY A REBOOT CAN GO, AND NONE OF THEM SPINS FOREVER.
 *
 * Nine scenarios, taken from what a USB stack actually does rather than
 * from what it is supposed to do. Each one drives the REAL reconnect
 * driver against a fake transport and a fake clock, and each one has to
 * reach a terminal phase - RECOVERED or FAILED - with no timer left
 * running.
 *
 *   A  detach, device returns, identifies          -> RECOVERED
 *   B  no detach, port stays, board returns silent then answers
 *                                                  -> RECOVERED
 *   C  no detach, board silent forever             -> FAILED/TIMED_OUT
 *   D  detach, device never returns                -> FAILED/TIMED_OUT
 *   E  device returns, open() rejects              -> FAILED/REOPEN_FAILED
 *   F  session opens, identification FAILS         -> FAILED/REOPEN_FAILED
 *   G  identification stays RUNNING to the deadline-> FAILED/TIMED_OUT
 *   H  device returns as a DIFFERENT port          -> RECOVERED on the new one
 *   I  device returns AFTER the deadline           -> stays FAILED, no revival
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import '../../i18n';
import {mspSessionCoordinator} from '../../platforms/react-native/protocol';
import {
  fcRebootRecovery,
  FC_REBOOT_RECOVERY_TIMEOUT_MS,
} from '../../platforms/react-native/protocol/fcRebootRecovery';
import type {
  UsbSerialDeviceDescriptor,
  UsbSerialTransportClient,
} from '../../platforms/react-native/transport';
import {connectionNotice} from './connectionNotice';
import {useRebootReconnect} from './useRebootReconnect';
import {REBOOT_RESCAN_INTERVAL_MS} from './useRebootReconnect';

const IDENTIFIED = Object.freeze({
  status: 'SUCCEEDED',
  identity: Object.freeze({
    firmware: Object.freeze({identifier: 'BTFL', knownFamily: 'BETAFLIGHT'}),
    apiVersion: Object.freeze({
      mspProtocolVersion: 0,
      apiVersionMajor: 1,
      apiVersionMinor: 47,
    }),
    board: Object.freeze({}),
  }),
});

function device(
  overrides: Partial<UsbSerialDeviceDescriptor> = {},
): UsbSerialDeviceDescriptor {
  return {
    deviceId: 7,
    vendorId: 0x1a86,
    productId: 0x7523,
    productName: 'CH340 Serial',
    manufacturerName: 'QinHeng',
    driverType: 'CH34X',
    portCount: 1,
    ...overrides,
  };
}

/**
 * THE WORLD, as the driver can observe it. Every field is something a
 * scenario changes and the driver must cope with.
 */
type World = {
  devices: UsbSerialDeviceDescriptor[];
  /** Enumeration itself throws - a USB stack being re-entered under a
   *  rebooting board does this, transiently. */
  scanRejectsFor: number;
  openRejects: boolean;
  identification: 'IDLE' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  ownership: 'ACTIVE' | 'INACTIVE';
  openedSessions: string[];
};

let world: World;
let listeners: Array<() => void>;

function makeClient(): UsbSerialTransportClient {
  return {
    listDevices: jest.fn(async () => {
      if (world.scanRejectsFor > 0) {
        world.scanRejectsFor -= 1;
        throw new Error('USB enumeration failed while the stack re-entered');
      }
      return world.devices;
    }),
    openDevice: jest.fn(async () => {
      if (world.openRejects) {
        throw {code: 'DEVICE_NOT_FOUND', nativeMessage: 'gone'};
      }
      const sessionId = `reopened-${world.openedSessions.length + 1}`;
      world.openedSessions.push(sessionId);
      return sessionId;
    }),
    closeSession: jest.fn(async () => undefined),
    onDeviceAttached: jest.fn(() => jest.fn()),
    onDeviceDetached: jest.fn(() => jest.fn()),
    onSessionDetached: jest.fn(() => jest.fn()),
    onDataReceived: jest.fn(() => jest.fn()),
    onError: jest.fn(() => jest.fn()),
    writeBytes: jest.fn(() => new Promise<void>(() => undefined)),
    stopReading: jest.fn(() => new Promise<void>(() => undefined)),
    startReading: jest.fn(() => new Promise<void>(() => undefined)),
  } as unknown as UsbSerialTransportClient;
}

let client: UsbSerialTransportClient;

function Probe() {
  useRebootReconnect(client);
  return null;
}

let renderer: ReactTestRenderer.ReactTestRenderer | undefined;

function mount() {
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(<Probe />);
  });
}

/**
 * Let the driver see the world: fire its subscriptions, run its poll,
 * and - the part a synchronous act() cannot do - let the scan and open
 * PROMISES resolve. The driver awaits listDevices() and openDevice(),
 * so without an async act nothing it does after the await ever runs.
 */
async function settle(ms = REBOOT_RESCAN_INTERVAL_MS) {
  /* TWO poll cycles, not one. The driver fires an immediate attempt when
     it starts polling; a scenario that changes the world AFTER that
     attempt has already begun needs the next interval tick to see it,
     and the re-entry guard legitimately skips a tick that lands while a
     scan is still in flight. */
  for (let cycle = 0; cycle < 2; cycle += 1) {
    await ReactTestRenderer.act(async () => {
      for (const listener of [...listeners]) listener();
      jest.advanceTimersByTime(ms);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }
  await ReactTestRenderer.act(async () => {
    for (const listener of [...listeners]) listener();
    await Promise.resolve();
  });
}

/** Run the clock past the lifetime deadline in realistic slices. */
async function runPastDeadline() {
  for (let elapsed = 0; elapsed <= FC_REBOOT_RECOVERY_TIMEOUT_MS + 2_000; elapsed += REBOOT_RESCAN_INTERVAL_MS) {
    await settle();
  }
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.restoreAllMocks();
  connectionNotice.clear();
  fcRebootRecovery.reset();
  world = {
    devices: [],
    scanRejectsFor: 0,
    openRejects: false,
    identification: 'SUCCEEDED',
    ownership: 'ACTIVE',
    openedSessions: [],
  };
  listeners = [];
  client = makeClient();

  const remember = (listener: () => void) => {
    listeners.push(listener);
    return () => undefined;
  };
  jest
    .spyOn(mspSessionCoordinator, 'subscribeIdentificationState')
    .mockImplementation(remember as never);
  jest
    .spyOn(mspSessionCoordinator, 'subscribeOwnershipState')
    .mockImplementation(remember as never);
  jest.spyOn(mspSessionCoordinator, 'openSession').mockImplementation(() => undefined as never);
  jest
    .spyOn(mspSessionCoordinator, 'getIdentificationState')
    .mockImplementation(() =>
      world.identification === 'SUCCEEDED'
        ? (IDENTIFIED as never)
        : ({status: world.identification} as never),
    );
  jest
    .spyOn(mspSessionCoordinator, 'getOwnershipState')
    .mockImplementation(() => world.ownership);
  jest.spyOn(mspSessionCoordinator, 'listSessionIds').mockImplementation(() => []);
});

afterEach(() => {
  if (renderer !== undefined) {
    ReactTestRenderer.act(() => renderer?.unmount());
    renderer = undefined;
  }
  fcRebootRecovery.reset();
  connectionNotice.clear();
  jest.useRealTimers();
});

/** The CLI save, as RawCliSessionController performs it. */
function cliSave(sessionId = 'usb-1') {
  ReactTestRenderer.act(() => {
    fcRebootRecovery.expectReboot(sessionId, 'CLI_SAVE');
  });
}

function linkDied(sessionId = 'usb-1') {
  ReactTestRenderer.act(() => {
    fcRebootRecovery.noteSessionLost(sessionId);
  });
}

describe('every reboot scenario reaches a terminal state', () => {
  it('A: detach, the device returns, and it identifies', async () => {
    mount();
    cliSave();
    linkDied();
    world.devices = [device()];
    await settle();

    expect(fcRebootRecovery.getPhase().kind).toBe('IDLE'); // reset after RECOVERED
    expect(world.openedSessions).toHaveLength(1);
    expect(connectionNotice.get()).toBeNull();
  });

  /**
   * B: NO detach event at all. The port object survives the reboot and
   * the board is simply silent for a moment. The coordinator still
   * reports the session dead (that is the zombie-session fix), so the
   * lifecycle still hears about it and the device is still enumerable.
   */
  it('B: no detach event, the port stays, and the board comes back', async () => {
    mount();
    cliSave();
    world.devices = [device()]; // never left the enumeration
    linkDied();
    await settle();

    expect(world.openedSessions).toHaveLength(1);
    expect(fcRebootRecovery.getPhase().kind).toBe('IDLE');
  });

  it('C: no detach and the board is silent forever', async () => {
    mount();
    cliSave();
    linkDied();
    world.devices = [device()];
    world.identification = 'RUNNING'; // opens, never answers

    await runPastDeadline();

    expect(connectionNotice.get()).toBe('RECONNECT_FAILED');
    expect(fcRebootRecovery.getPhase().kind).toBe('IDLE');
  });

  it('D: the device never comes back at all', async () => {
    mount();
    cliSave();
    linkDied();
    world.devices = [];

    await runPastDeadline();

    expect(world.openedSessions).toHaveLength(0);
    expect(connectionNotice.get()).toBe('RECONNECT_FAILED');
  });

  it('E: the device comes back but the port refuses to open', async () => {
    mount();
    cliSave();
    linkDied();
    world.devices = [device()];
    world.openRejects = true;

    await settle();

    expect(connectionNotice.get()).toBe('RECONNECT_FAILED');
    expect(fcRebootRecovery.getPhase().kind).toBe('IDLE');
  });

  it('F: the session opens but identification fails', async () => {
    mount();
    cliSave();
    linkDied();
    world.devices = [device()];
    world.identification = 'FAILED';

    await settle();

    expect(world.openedSessions).toHaveLength(1);
    expect(connectionNotice.get()).toBe('RECONNECT_FAILED');
  });

  it('G: identification stays RUNNING right up to the deadline', async () => {
    mount();
    cliSave();
    linkDied();
    world.devices = [device()];
    world.identification = 'RUNNING';

    await settle();
    // Still trying, and still blocking - this is the legitimate window.
    expect(fcRebootRecovery.getPhase().kind).toBe('RECONNECTING');

    await runPastDeadline();

    expect(connectionNotice.get()).toBe('RECONNECT_FAILED');
  });

  it('H: the board comes back as a different port', async () => {
    mount();
    cliSave();
    linkDied();
    // Different deviceId AND different vid/pid - a re-enumeration that
    // does not look like the board that left.
    world.devices = [device({deviceId: 99, vendorId: 0x0483, productId: 0x5740})];

    await settle();

    expect(world.openedSessions).toHaveLength(1);
    expect(fcRebootRecovery.getPhase().kind).toBe('IDLE');
    expect(connectionNotice.get()).toBeNull();
  });

  /**
   * I: THE LATE ARRIVAL. The deadline already fired and the operator has
   * already been told. A device appearing now must not silently revive a
   * recovery that is over - the operator drives from here.
   */
  it('I: the device returns after the deadline has passed', async () => {
    mount();
    cliSave();
    linkDied();
    await runPastDeadline();
    expect(connectionNotice.get()).toBe('RECONNECT_FAILED');

    world.devices = [device()];
    await settle();
    await settle();

    expect(world.openedSessions).toHaveLength(0);
    expect(fcRebootRecovery.getPhase().kind).toBe('IDLE');
  });

  /**
   * AMBIGUITY IS NEVER GUESSED. Two boards on the bench and the driver
   * cannot know which one it rebooted, so it opens neither and lets the
   * deadline hand the question back to the operator.
   */

  /**
   * A TRANSIENT SCAN FAILURE IS NOT A REFUSED PORT.
   *
   * Enumeration throwing for a tick or two is ordinary while a board is
   * re-entering the USB stack. Treating that as a terminal reopen
   * failure would end a recovery that was seconds from succeeding - so
   * a scan error means "not yet", and the lifecycle's deadline is what
   * stops "not yet" from becoming "not ever".
   */
  it('J: enumeration throws a few times and the board still comes back', async () => {
    mount();
    cliSave();
    linkDied();
    world.scanRejectsFor = 3;
    world.devices = [device()];

    await settle();
    await settle();
    await settle();

    expect(world.openedSessions).toHaveLength(1);
    expect(fcRebootRecovery.getPhase().kind).toBe('IDLE');
    expect(connectionNotice.get()).toBeNull();
  });

  it('K: enumeration that never recovers still ends on the deadline', async () => {
    mount();
    cliSave();
    linkDied();
    world.scanRejectsFor = Number.MAX_SAFE_INTEGER;

    await runPastDeadline();

    expect(connectionNotice.get()).toBe('RECONNECT_FAILED');
    expect(fcRebootRecovery.getPhase().kind).toBe('IDLE');
    expect(world.openedSessions).toEqual([]);
  });

  it('opens nothing when two boards are present, and still ends', async () => {
    mount();
    cliSave();
    linkDied();
    world.devices = [device({deviceId: 1}), device({deviceId: 2})];

    await runPastDeadline();

    expect(world.openedSessions).toHaveLength(0);
    expect(connectionNotice.get()).toBe('RECONNECT_FAILED');
  });

  /**
   * UNMOUNTING MID-FLIGHT MUST STOP THE POLL.
   *
   * Measured by BEHAVIOUR rather than by jest.getTimerCount(): React's
   * own scheduler holds timers under fake timers, so an absolute count
   * measures the renderer, not this driver. A leaked interval has one
   * unmistakable symptom - it keeps calling listDevices() - and that is
   * what is asserted.
   */
  it('stops scanning the moment it is unmounted', async () => {
    mount();
    cliSave();
    linkDied();
    world.devices = [];
    await settle();
    // The recovery really is running - otherwise this proves nothing.
    expect(fcRebootRecovery.getPhase().kind).toBe('WAITING_FOR_LINK');
    const scansWhileMounted = (client.listDevices as jest.Mock).mock.calls.length;
    expect(scansWhileMounted).toBeGreaterThan(0);

    ReactTestRenderer.act(() => renderer?.unmount());
    renderer = undefined;

    // Far more than the interval, and with the recovery still pending.
    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(REBOOT_RESCAN_INTERVAL_MS * 20);
      await Promise.resolve();
    });

    expect((client.listDevices as jest.Mock).mock.calls.length).toBe(
      scansWhileMounted,
    );
    fcRebootRecovery.reset();
  });

  /**
   * And a late scan that WAS already in flight when the component went
   * away must not write anything back. An unmounted driver reviving a
   * recovery is the "late completion restores old state" defect.
   */
  it('does not act on a scan that lands after unmount', async () => {
    let releaseScan: (devices: UsbSerialDeviceDescriptor[]) => void = () => {};
    (client.listDevices as jest.Mock).mockImplementation(
      () =>
        new Promise<UsbSerialDeviceDescriptor[]>(resolve => {
          releaseScan = resolve;
        }),
    );
    mount();
    cliSave();
    linkDied();
    await settle();

    ReactTestRenderer.act(() => renderer?.unmount());
    renderer = undefined;

    await ReactTestRenderer.act(async () => {
      releaseScan([device()]);
      await Promise.resolve();
      await Promise.resolve();
    });

    // Nothing was opened by a driver that no longer exists.
    expect(world.openedSessions).toHaveLength(0);
    fcRebootRecovery.reset();
  });
});
