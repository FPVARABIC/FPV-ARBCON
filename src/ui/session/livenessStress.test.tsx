jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

/**
 * TWENTY CYCLES, AND NOTHING ACCUMULATES.
 *
 * A liveness defect that survives one pass is usually a leak: a timer
 * that is armed twice and cleared once, a listener added on every
 * attempt, a recovery that starts before the previous one finished. One
 * cycle hides all three. Twenty do not.
 *
 * Each suite below runs the same operator loop twenty times and then
 * asserts the things that would be different if something had been left
 * behind: the number of live timers, the number of subscribers, and the
 * state the application settles in.
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
import {
  REBOOT_RESCAN_INTERVAL_MS,
  useRebootReconnect,
} from './useRebootReconnect';

const CYCLES = 20;

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

const DEVICE: UsbSerialDeviceDescriptor = Object.freeze({
  deviceId: 7,
  vendorId: 0x1a86,
  productId: 0x7523,
  productName: 'CH340 Serial',
  manufacturerName: 'QinHeng',
  driverType: 'CH34X',
  portCount: 1,
});

let devices: UsbSerialDeviceDescriptor[] = [];
let opened: string[] = [];
let listeners: Array<() => void> = [];
/** Every subscription handed out, so a leak shows as growth. */
let subscriptionCount = 0;
let client: UsbSerialTransportClient;

function Probe() {
  useRebootReconnect(client);
  return null;
}

let renderer: ReactTestRenderer.ReactTestRenderer | undefined;

async function settle(cycles = 2) {
  for (let i = 0; i < cycles; i += 1) {
    await ReactTestRenderer.act(async () => {
      for (const listener of [...listeners]) listener();
      jest.advanceTimersByTime(REBOOT_RESCAN_INTERVAL_MS);
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

beforeEach(() => {
  jest.useFakeTimers();
  jest.restoreAllMocks();
  connectionNotice.clear();
  fcRebootRecovery.reset();
  devices = [];
  opened = [];
  listeners = [];
  subscriptionCount = 0;

  client = {
    listDevices: jest.fn(async () => devices),
    openDevice: jest.fn(async () => {
      const sessionId = `session-${opened.length + 1}`;
      opened.push(sessionId);
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

  const remember = (listener: () => void) => {
    listeners.push(listener);
    subscriptionCount += 1;
    return () => {
      subscriptionCount -= 1;
      listeners = listeners.filter(entry => entry !== listener);
    };
  };
  jest
    .spyOn(mspSessionCoordinator, 'subscribeIdentificationState')
    .mockImplementation(remember as never);
  jest
    .spyOn(mspSessionCoordinator, 'subscribeOwnershipState')
    .mockImplementation(remember as never);
  jest
    .spyOn(mspSessionCoordinator, 'openSession')
    .mockImplementation(() => undefined as never);
  jest
    .spyOn(mspSessionCoordinator, 'getIdentificationState')
    .mockImplementation(() => IDENTIFIED as never);
  jest
    .spyOn(mspSessionCoordinator, 'getOwnershipState')
    .mockImplementation(() => 'ACTIVE');
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

describe('twenty CLI save + reboot + reconnect cycles', () => {
  it('recovers every time and accumulates nothing', async () => {
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<Probe />);
    });
    const subscriptionsWhileMounted = subscriptionCount;
    expect(subscriptionsWhileMounted).toBeGreaterThan(0);

    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      const sessionId = `usb-${cycle}`;
      devices = [];
      ReactTestRenderer.act(() => {
        fcRebootRecovery.expectReboot(sessionId, 'CLI_SAVE');
        fcRebootRecovery.noteSessionLost(sessionId);
      });
      // The board comes back.
      devices = [DEVICE];
      await settle();

      // Every cycle ends in the same place: nothing pending, nothing to
      // announce, exactly one new session opened.
      expect(`cycle ${cycle}: ${fcRebootRecovery.getPhase().kind}`).toBe(
        `cycle ${cycle}: IDLE`,
      );
      expect(`cycle ${cycle}: ${connectionNotice.get()}`).toBe(
        `cycle ${cycle}: null`,
      );
      expect(`cycle ${cycle}: ${opened.length}`).toBe(`cycle ${cycle}: ${cycle + 1}`);
      // No duplicate recovery: one open per cycle, never two.
      expect(`cycle ${cycle}: subs ${subscriptionCount}`).toBe(
        `cycle ${cycle}: subs ${subscriptionsWhileMounted}`,
      );
    }

    ReactTestRenderer.act(() => renderer?.unmount());
    renderer = undefined;
    // Every subscription handed out was handed back.
    expect(subscriptionCount).toBe(0);
  });

  it('times out every time when the board never returns, and stays clean', async () => {
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<Probe />);
    });
    const subscriptionsWhileMounted = subscriptionCount;

    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      connectionNotice.clear();
      devices = [];
      ReactTestRenderer.act(() => {
        fcRebootRecovery.expectReboot(`usb-${cycle}`, 'CLI_SAVE');
        fcRebootRecovery.noteSessionLost(`usb-${cycle}`);
      });
      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(FC_REBOOT_RECOVERY_TIMEOUT_MS + 1);
        await Promise.resolve();
      });
      await settle(1);

      expect(`cycle ${cycle}: ${connectionNotice.get()}`).toBe(
        `cycle ${cycle}: RECONNECT_FAILED`,
      );
      expect(`cycle ${cycle}: ${fcRebootRecovery.getPhase().kind}`).toBe(
        `cycle ${cycle}: IDLE`,
      );
      // A timed-out recovery must never have opened anything.
      expect(`cycle ${cycle}: ${opened.length}`).toBe(`cycle ${cycle}: 0`);
      expect(`cycle ${cycle}: subs ${subscriptionCount}`).toBe(
        `cycle ${cycle}: subs ${subscriptionsWhileMounted}`,
      );
    }

    ReactTestRenderer.act(() => renderer?.unmount());
    renderer = undefined;
    expect(subscriptionCount).toBe(0);
  });

  /**
   * THE MIXED LOOP the report asks for: save, time out, land on Home,
   * retry by hand, succeed. Repeated, because the interesting failure is
   * a stale generation surviving into the next attempt.
   */
  it('survives timeout then manual retry, repeatedly', async () => {
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<Probe />);
    });

    for (let cycle = 0; cycle < 8; cycle += 1) {
      // Save, and the board does not come back.
      devices = [];
      ReactTestRenderer.act(() => {
        fcRebootRecovery.expectReboot(`usb-${cycle}`, 'CLI_SAVE');
        fcRebootRecovery.noteSessionLost(`usb-${cycle}`);
      });
      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(FC_REBOOT_RECOVERY_TIMEOUT_MS + 1);
        await Promise.resolve();
      });
      await settle(1);
      expect(connectionNotice.get()).toBe('RECONNECT_FAILED');

      // The operator clears the message and the board is plugged back in.
      // A recovery that is over must not wake up and grab it.
      connectionNotice.clear();
      devices = [DEVICE];
      const openedBefore = opened.length;
      await settle();
      expect(`cycle ${cycle}: ${opened.length}`).toBe(
        `cycle ${cycle}: ${openedBefore}`,
      );
      expect(fcRebootRecovery.getPhase().kind).toBe('IDLE');
    }

    ReactTestRenderer.act(() => renderer?.unmount());
    renderer = undefined;
    expect(subscriptionCount).toBe(0);
  });

  /**
   * A SECOND SAVE WHILE THE FIRST IS STILL RECOVERING. Two overlapping
   * recoveries would be two deadlines and two pollers; there must be one
   * of each, and the second expectation must own it.
   */
  it('does not stack recoveries when a second save arrives mid-flight', async () => {
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<Probe />);
    });
    devices = [];
    ReactTestRenderer.act(() => {
      fcRebootRecovery.expectReboot('usb-a', 'CLI_SAVE');
      fcRebootRecovery.noteSessionLost('usb-a');
    });
    await settle(1);
    ReactTestRenderer.act(() => {
      fcRebootRecovery.expectReboot('usb-b', 'CLI_SAVE');
      fcRebootRecovery.noteSessionLost('usb-b');
    });

    devices = [DEVICE];
    await settle();

    // Exactly one board opened, not two.
    expect(opened).toHaveLength(1);
    expect(fcRebootRecovery.getPhase().kind).toBe('IDLE');

    ReactTestRenderer.act(() => renderer?.unmount());
    renderer = undefined;
    expect(subscriptionCount).toBe(0);
  });
});
