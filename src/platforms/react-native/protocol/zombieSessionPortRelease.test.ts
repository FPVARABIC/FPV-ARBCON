/**
 * THE HALF OF THE ZOMBIE-SESSION FIX THAT NOBODY HAD LOOKED AT: THE PORT.
 *
 * The liveness verdict itself is already real and already proven. A board
 * that reboots without producing a detach event stops answering, three
 * telemetry dispatches in a row fail at the link, and the coordinator
 * ends the session exactly as a physical detach ends it - ownership
 * INACTIVE, session key gone, motor-test capability closed. That is
 * cliSessionLifecycle.test.ts, "ends the session when the link dies with
 * no detach event".
 *
 * WHAT THOSE TESTS COULD NOT SEE. Their fake USB client answers
 * `closeSession` and `openDevice` with trivial stubs, so a session that
 * was never closed looks exactly like one that was. But a serial port
 * admits ONE owner - the web transport rejects a second open on a port it
 * still holds (NativeUsbSerialTransport.web.ts, DEVICE_ALREADY_IN_USE:
 * "This port already has an open session"), and Android does the same -
 * so "did anything actually let go of the port?" is a question with real
 * consequences and no test.
 *
 * IT MATTERS MOST HERE, of all the teardown paths. The graceful path has
 * a caller that closes the port first (setupSessionHost.tsx: closeSession
 * THEN deactivateMspSession). A real detach has a device that is
 * physically gone. The zombie verdict has NEITHER: the coordinator tears
 * itself down with no caller involved, against a device that is still
 * enumerated. If nothing closes the port there, it stays open forever,
 * held by a session no layer of this application still knows about - the
 * coordinator deleted its entry, so even
 * releaseApplicationOwnedSessions() cannot find it. The next connect gets
 * DEVICE_ALREADY_IN_USE and the operator is told another application is
 * using their board, which is false.
 *
 * So the fake below models the ONE rule that matters and the other fakes
 * omit: a port that is already open cannot be opened again.
 */

import {
  MSP_API_VERSION,
  MSP_BOARD_INFO,
  MSP_FC_VARIANT,
  MSP_STATUS_EX,
} from '../../../core';
import {buildMspFrameBytes} from '../../../core/protocol/__testUtils__/mspFixtures';
import {base64ToBytes, bytesToBase64} from './base64';
import {
  LINK_DEAD_AFTER_CONSECUTIVE_FAILURES,
  MspSessionCoordinator,
} from './MspSessionCoordinator';
import type {
  UsbSerialDataEvent,
  UsbSerialSessionDetachedEvent,
  UsbSerialTransportClient,
} from '../transport';

const SESSION_ID = 'session-zombie-port';
const DEVICE_ID = 7;

function ascii(text: string): number[] {
  return text.split('').map(character => character.charCodeAt(0));
}

function pstring(text: string): number[] {
  return [text.length, ...ascii(text)];
}

function u16le(value: number): number[] {
  // eslint-disable-next-line no-bitwise -- little-endian split.
  return [value & 0xff, (value >> 8) & 0xff];
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 40; index += 1) {
    await Promise.resolve();
  }
}

class BusyPortError extends Error {
  readonly code = 'DEVICE_ALREADY_IN_USE';
  constructor() {
    super('This port already has an open session.');
  }
}

/**
 * A board that answers MSP, can fall silent WITHOUT a detach event, and -
 * unlike every other fake in this codebase - enforces the one-owner rule
 * that both real transports enforce.
 */
class PortOwningFakeBoard {
  readonly dataListeners = new Set<(event: UsbSerialDataEvent) => void>();
  readonly detachListeners = new Set<
    (event: UsbSerialSessionDetachedEvent) => void
  >();
  readonly responses = new Map<number, Uint8Array>();
  /** sessionId -> deviceId, exactly the map the web transport keeps. */
  readonly openSessions = new Map<string, number>();
  /** The board rebooted and answers nothing. NO detach is fired. */
  silent = false;

  constructor(readonly sessionId: string) {
    this.responses.set(MSP_API_VERSION, Uint8Array.from([0, 1, 48]));
    this.responses.set(MSP_FC_VARIANT, Uint8Array.from(ascii('BTFL')));
    this.responses.set(
      MSP_BOARD_INFO,
      Uint8Array.from([
        ...ascii('AFF3'),
        ...u16le(0),
        0,
        0,
        ...pstring('TEST'),
        ...pstring('MyBoard'),
        ...pstring('MTKS'),
        ...new Array(32).fill(0),
        0,
        0,
      ]),
    );
    this.responses.set(
      MSP_STATUS_EX,
      Uint8Array.from([...u16le(312), ...u16le(0), ...u16le(41), 0, 0, 0, 0, 0, ...u16le(12)]),
    );
    // The port this session was opened against, as openDevice() below
    // would have recorded it.
    this.openSessions.set(sessionId, DEVICE_ID);
  }

  /* ---- the UsbSerialTransportClient surface, with a real port rule --- */

  openDevice = jest.fn(async (deviceId: number = DEVICE_ID) => {
    for (const owned of this.openSessions.values()) {
      if (owned === deviceId) throw new BusyPortError();
    }
    const id = `${this.sessionId}-reopen-${this.openSessions.size}`;
    this.openSessions.set(id, deviceId);
    return id;
  });

  closeSession = jest.fn(async (sessionId: string) => {
    // Idempotent, exactly like the web transport's own closeSession.
    this.openSessions.delete(sessionId);
  });

  writeBytes = jest.fn(async (_sessionId: string, dataBase64: string) => {
    if (this.silent) return;
    const bytes = base64ToBytes(dataBase64);
    const command = bytes[4];
    const payload = this.responses.get(command);
    if (payload === undefined) return;
    const frame = buildMspFrameBytes(command, payload, {
      wireFormat: 'v1',
      direction: 'response',
    });
    const event: UsbSerialDataEvent = {
      sessionId: this.sessionId,
      dataBase64: bytesToBase64(frame),
    };
    for (const listener of Array.from(this.dataListeners)) listener(event);
  });

  onDataReceived = jest.fn((listener: (event: UsbSerialDataEvent) => void) => {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  });

  onSessionDetached = jest.fn(
    (listener: (event: UsbSerialSessionDetachedEvent) => void) => {
      this.detachListeners.add(listener);
      return () => this.detachListeners.delete(listener);
    },
  );

  stopReading = jest.fn(async () => undefined);
  startReading = jest.fn(async () => undefined);
  setBaudRate = jest.fn(async () => undefined);
  setControlLines = jest.fn(async () => undefined);
  saveFirmwareFile = jest.fn(async () => true);
  listDevices = jest.fn(async () => [
    {deviceId: DEVICE_ID, vendorId: 1, productId: 1, driverType: 'CDC', portCount: 1},
  ]);

  /** A REAL unplug: the port goes away and the transport says so. */
  detach(): void {
    this.silent = true;
    this.openSessions.delete(this.sessionId);
    for (const listener of Array.from(this.detachListeners)) {
      listener({sessionId: this.sessionId, reason: 'DEVICE_DETACHED'} as never);
    }
  }

  /** Is the physical port still held by anybody? */
  portHeld(): boolean {
    return [...this.openSessions.values()].includes(DEVICE_ID);
  }
}

const OPENED: MspSessionCoordinator[] = [];

afterEach(() => {
  while (OPENED.length > 0) {
    const coordinator = OPENED.pop();
    for (const id of coordinator?.listSessionIds() ?? []) {
      coordinator?.deactivateMspSession(id);
    }
  }
});

async function liveRig(): Promise<{
  coordinator: MspSessionCoordinator;
  board: PortOwningFakeBoard;
}> {
  const coordinator = new MspSessionCoordinator();
  OPENED.push(coordinator);
  const board = new PortOwningFakeBoard(SESSION_ID);
  coordinator.openSession(
    board as unknown as UsbSerialTransportClient,
    SESSION_ID,
  );
  await flushAsync();
  return {coordinator, board};
}

/**
 * Drives the session's OWN telemetry dispatches until `count` of them
 * have failed in a row. Not a fake counter: this calls the real
 * scheduler's tick(), which dispatches a real request against the silent
 * board and settles it - so what is counted is what would be counted on a
 * bench. Each failing dispatch costs one MSP response timeout, hence the
 * generous per-test budget.
 */
async function driveFailedDispatches(
  coordinator: MspSessionCoordinator,
  count = LINK_DEAD_AFTER_CONSECUTIVE_FAILURES,
): Promise<void> {
  const deadline = Date.now() + 25_000;
  for (let settled = 0; settled < count; ) {
    const scheduler = coordinator.getTelemetryScheduler(SESSION_ID);
    if (scheduler === undefined) return; // the session already ended
    const before = scheduler.getConsecutiveLinkFailureCount();
    scheduler.tick();
    await new Promise(resolve => setTimeout(resolve, 60));
    await flushAsync();
    const after =
      coordinator.getTelemetryScheduler(SESSION_ID)?.getConsecutiveLinkFailureCount() ??
      before + 1;
    if (after > before) settled += after - before;
    if (Date.now() > deadline) throw new Error('dispatches never settled');
  }
}

describe('a session killed by the liveness verdict lets go of the port', () => {
  it('reaches the verdict with no detach event at all - the premise', async () => {
    const {coordinator, board} = await liveRig();
    expect(coordinator.getOwnershipState(SESSION_ID)).toBe('ACTIVE');

    // The board reboots and answers nothing. NO detach listener is
    // called - that is the whole scenario.
    board.silent = true;
    await driveFailedDispatches(coordinator);

    expect({
      ownership: coordinator.getOwnershipState(SESSION_ID),
      hasKey: coordinator.getSessionKey(SESSION_ID) !== undefined,
      detachesFired: 0,
    }).toEqual({ownership: 'INACTIVE', hasKey: false, detachesFired: 0});
  }, 30_000);

  it('frees the serial port, so the next connect is not refused as busy', async () => {
    const {coordinator, board} = await liveRig();
    board.silent = true;
    await driveFailedDispatches(coordinator);
    await flushAsync();

    // THE ASSERTION THIS FILE EXISTS FOR. The coordinator has forgotten
    // the session, so nothing in the application can close it any more;
    // if it did not release the port on the way out, the port is held by
    // an owner that no longer exists anywhere.
    expect(coordinator.listSessionIds()).toEqual([]);
    expect(board.portHeld()).toBe(false);
    await expect(board.openDevice(DEVICE_ID)).resolves.toEqual(
      expect.any(String),
    );
  }, 30_000);

  it('stops the receive loop before closing, in that order', async () => {
    const {coordinator, board} = await liveRig();
    board.silent = true;
    await driveFailedDispatches(coordinator);
    await flushAsync();

    expect(board.stopReading).toHaveBeenCalledWith(SESSION_ID);
    expect(board.closeSession).toHaveBeenCalledWith(SESSION_ID);
    const stoppedAt = board.stopReading.mock.invocationCallOrder[0];
    const closedAt = board.closeSession.mock.invocationCallOrder[0];
    expect(stoppedAt).toBeLessThan(closedAt);
  }, 30_000);

  it('does not fight a REAL detach, whose port is already gone', async () => {
    const {coordinator, board} = await liveRig();

    // A physical unplug: the transport removes the session itself and
    // says so. Asking it to close again must be harmless - the web
    // transport's closeSession is idempotent by design - and must not
    // reopen or resurrect anything.
    board.detach();
    await flushAsync();

    expect(coordinator.getOwnershipState(SESSION_ID)).toBe('INACTIVE');
    expect(board.portHeld()).toBe(false);
    expect(coordinator.listSessionIds()).toEqual([]);
  }, 30_000);

  it('still lets go when the transport refuses the close', async () => {
    const {coordinator, board} = await liveRig();
    // A close that rejects must not leave the coordinator holding a dead
    // session: the port may still be stuck, but the application state
    // has to be truthful either way.
    board.closeSession.mockRejectedValue(new Error('close refused'));
    board.silent = true;
    await driveFailedDispatches(coordinator);
    await flushAsync();

    expect(coordinator.getOwnershipState(SESSION_ID)).toBe('INACTIVE');
    expect(coordinator.listSessionIds()).toEqual([]);
  }, 30_000);
});
