/**
 * Pass 7.7, Region 5 - the exclusive FC-tool transaction, exercised
 * through the REAL MspSessionCoordinator, the REAL MspClient (its FIFO,
 * its single-in-flight rule and its real 2000ms response timeout) and
 * the REAL MspOperationCoordinator. Only the USB transport is a fake.
 */

import {FcToolsController} from './FcToolsController';
import {mspSessionCoordinator} from './MspSessionCoordinator';
import {SetupAppStateTelemetryOwner} from './setupAppStateTelemetryOwner';
import {base64ToBytes, bytesToBase64} from './base64';
import {
  MSP_ACC_CALIBRATION,
  MSP_ANALOG,
  MSP_API_VERSION,
  MSP_ATTITUDE,
  MSP_BATTERY_STATE,
  MSP_BOARD_INFO,
  MSP_BOXIDS,
  MSP_FC_VARIANT,
  MSP_MAG_CALIBRATION,
  MSP_RAW_GPS,
  MSP_REBOOT,
  MSP_STATUS_EX,
} from '../../../core';
import {buildMspFrameBytes} from '../../../core/protocol/__testUtils__/mspFixtures';
import type {UsbSerialDataEvent, UsbSerialTransportClient} from '../transport';
import type {AppStateStatus, NativeEventSubscription} from 'react-native';

function ascii(text: string): number[] {
  return text.split('').map(c => c.charCodeAt(0));
}

function pstring(text: string): number[] {
  return [text.length, ...ascii(text)];
}

function u16le(value: number): number[] {
  return [value % 256, Math.floor(value / 256) % 256];
}

function boardInfoPayload(): Uint8Array {
  return Uint8Array.from([
    ...ascii('AFF3'),
    ...u16le(0),
    0,
    0,
    ...pstring('TEST'),
    ...pstring('MyBoard'),
    ...pstring('MTKS'),
    ...new Array(32).fill(0),
    0,
  ]);
}

/** 13-byte prefix (sensors mask 41 = ACC|GPS|GYRO by default) + the full
 * API-1.47 optional tail. */
function statusExPayload(
  options: {sensorMask?: number; flightModeFlags?: number; blockerMask?: number; extension?: number[]} = {},
): Uint8Array {
  const flags = options.flightModeFlags ?? 0;
  const extension = options.extension ?? [];
  const mask = options.blockerMask ?? 0;
  return Uint8Array.from([
    ...u16le(312),
    ...u16le(0),
    ...u16le(options.sensorMask ?? 41),
    flags % 256,
    Math.floor(flags / 256) % 256,
    Math.floor(flags / 65536) % 256,
    Math.floor(flags / 16777216) % 256,
    0,
    ...u16le(12),
    3,
    0,
    extension.length,
    ...extension,
    29,
    mask % 256,
    Math.floor(mask / 256) % 256,
    Math.floor(mask / 65536) % 256,
    Math.floor(mask / 16777216) % 256,
    0,
  ]);
}

type WriteHook = (command: number) => void;

function makeFakeClient(sessionId: string) {
  const dataListeners = new Set<(event: UsbSerialDataEvent) => void>();
  const responses = new Map<number, Uint8Array>();
  const errorFrames = new Set<number>();
  const heldCommands = new Set<number>();
  const hooks: WriteHook[] = [];
  const commands: number[] = [];

  const fake = {
    commands,
    writeBytes: jest.fn((_sessionId: string, dataBase64: string) => {
      const bytes = base64ToBytes(dataBase64);
      const command = bytes[4];
      commands.push(command);
      for (const hook of Array.from(hooks)) {
        hook(command);
      }
      if (heldCommands.has(command)) {
        return Promise.resolve(undefined); // no response ever - real timeout
      }
      const payload = responses.get(command);
      if (payload !== undefined) {
        const frameBytes = buildMspFrameBytes(command, payload, {
          wireFormat: 'v1',
          direction: errorFrames.has(command) ? 'error' : 'response',
        });
        Promise.resolve().then(() => {
          const event: UsbSerialDataEvent = {sessionId, dataBase64: bytesToBase64(frameBytes)};
          for (const listener of Array.from(dataListeners)) {
            listener(event);
          }
        });
      }
      return Promise.resolve(undefined);
    }),
    onDataReceived: jest.fn((cb: (event: UsbSerialDataEvent) => void) => {
      dataListeners.add(cb);
      return jest.fn(() => dataListeners.delete(cb));
    }),
    onSessionDetached: jest.fn(() => jest.fn()),
    stopReading: jest.fn(() => Promise.resolve(undefined)),
    startReading: jest.fn(() => Promise.resolve(undefined)),
    setResponse: (command: number, payload: Uint8Array) => {
      responses.set(command, payload);
      errorFrames.delete(command);
    },
    setErrorFrame: (command: number) => {
      responses.set(command, Uint8Array.from([]));
      errorFrames.add(command);
    },
    hold: (command: number) => {
      heldCommands.add(command);
    },
    onWrite: (hook: WriteHook) => {
      hooks.push(hook);
    },
    countOf: (command: number) => commands.filter(c => c === command).length,
  };

  fake.setResponse(MSP_API_VERSION, Uint8Array.from([0, 1, 47]));
  fake.setResponse(MSP_FC_VARIANT, Uint8Array.from(ascii('BTFL')));
  fake.setResponse(MSP_BOARD_INFO, boardInfoPayload());
  // Benign responses for the polls the coordinator registers for an
  // identified Betaflight session - an unanswered one would occupy the
  // serialized link for a real 2000ms and distort these tests.
  // The 220ms attitude poll runs for every session; leaving it
  // unanswered would time out after a real 2000ms and desync the link.
  fake.setResponse(MSP_ATTITUDE, Uint8Array.from([0, 0, 0, 0, 0, 0]));
  fake.setResponse(MSP_BATTERY_STATE, Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0]));
  fake.setResponse(MSP_ANALOG, Uint8Array.from([168, ...u16le(0), ...u16le(540), ...u16le(0), ...u16le(1680)]));
  fake.setResponse(MSP_RAW_GPS, Uint8Array.from([2, 8, 0, 0, 0, 0, 0, 0, 0, 0, ...u16le(0), ...u16le(0), ...u16le(0)]));
  fake.setResponse(MSP_STATUS_EX, statusExPayload());
  // BOXARM (permanent id 0) is the FIRST active box -> flight-mode bit 0.
  fake.setResponse(MSP_BOXIDS, Uint8Array.from([0, 1, 2]));
  // Both calibrations and reboot ack with an empty payload.
  fake.setResponse(MSP_ACC_CALIBRATION, Uint8Array.from([]));
  fake.setResponse(MSP_MAG_CALIBRATION, Uint8Array.from([]));
  fake.setResponse(MSP_REBOOT, Uint8Array.from([0]));
  return fake;
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
  }
}

/** The transaction chains several real MspClient round trips (pause ->
 * wait-for-idle -> STATUS_EX -> BOXIDS -> the write), each settling on
 * its own microtask turn; a few short timer advances flush them all
 * without ever reaching the 2000ms response timeout. */
async function settleTransaction(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await jest.advanceTimersByTimeAsync(10);
    await flushAsync();
  }
}

function makeAppState(initial: AppStateStatus) {
  const listeners = new Set<(status: AppStateStatus) => void>();
  return {
    currentState: initial,
    addEventListener: (_type: 'change', listener: (status: AppStateStatus) => void): NativeEventSubscription => {
      listeners.add(listener);
      return {remove: () => listeners.delete(listener)} as NativeEventSubscription;
    },
    emit: (status: AppStateStatus) => {
      for (const listener of Array.from(listeners)) {
        listener(status);
      }
    },
  };
}

function makeOwner(initial: AppStateStatus = 'active') {
  const appState = makeAppState(initial);
  const owner = new SetupAppStateTelemetryOwner({appState});
  owner.start();
  return {owner, appState};
}

let openSessionIds: string[] = [];

async function openIdentifiedSession(sessionId: string, configure?: (client: ReturnType<typeof makeFakeClient>) => void) {
  const client = makeFakeClient(sessionId);
  configure?.(client);
  openSessionIds.push(sessionId);
  await jestAct(async () => {
    mspSessionCoordinator.openSession(client as unknown as UsbSerialTransportClient, sessionId);
    await flushAsync();
    // Let identification settle and the phase-staggered aux polls take
    // their first (benign) turn, so the serialized link is genuinely
    // idle before any FC-tool transaction starts.
    await jest.advanceTimersByTimeAsync(2200);
    await flushAsync();
  });
  return client;
}

/** No React here - just a named helper so the await/flush pairs read the
 * same way the screen-level suites do. */
async function jestAct(body: () => Promise<void>): Promise<void> {
  await body();
}

describe('FcToolsController - the exclusive FC-tool transaction', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    openSessionIds = [];
  });

  afterEach(async () => {
    for (const sessionId of openSessionIds) {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    }
    await flushAsync();
    jest.clearAllTimers();
    jest.useRealTimers();
    await flushAsync();
  });

  async function run(controller: FcToolsController, sessionId: string, tool: 'ACC_CALIBRATION' | 'MAG_CALIBRATION' | 'REBOOT') {
    expect(controller.requestConfirmation(sessionId, tool)).toBe(true);
    const settled = controller.confirm();
    await settleTransaction();
    return settled;
  }

  it('sends the write EXACTLY once, after ONE fresh preflight status read, and reports ACCEPTED (never "completed")', async () => {
    const sessionId = 'fc-tools-happy';
    const client = await openIdentifiedSession(sessionId);
    const {owner} = makeOwner();
    const controller = new FcToolsController({appStateOwner: owner});

    const statusBefore = client.countOf(MSP_STATUS_EX);
    const outcome = await run(controller, sessionId, 'ACC_CALIBRATION');

    expect(outcome).toEqual({kind: 'ACCEPTED', tool: 'ACC_CALIBRATION'});
    expect(client.countOf(MSP_ACC_CALIBRATION)).toBe(1);
    expect(client.countOf(MSP_STATUS_EX)).toBe(statusBefore + 1); // the fresh preflight read
    expect(client.countOf(MSP_BOXIDS)).toBe(1);
    // The mutex was released exactly once, at the single settle point.
    expect(controller.getPhase()).toEqual({kind: 'IDLE'});
    expect(controller.getLastOutcome()).toEqual(outcome);
  });

  it('acquires the BOXIDS mapping at most once across repeated actions in the same identity', async () => {
    const sessionId = 'fc-tools-boxids-once';
    const client = await openIdentifiedSession(sessionId);
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    await run(controller, sessionId, 'ACC_CALIBRATION');
    await run(controller, sessionId, 'ACC_CALIBRATION');
    await run(controller, sessionId, 'REBOOT');

    expect(client.countOf(MSP_BOXIDS)).toBe(1);
    expect(client.countOf(MSP_ACC_CALIBRATION)).toBe(2);
  });

  it('REJECTS while ARMED and sends NO write', async () => {
    const sessionId = 'fc-tools-armed';
    const client = await openIdentifiedSession(sessionId, c => {
      // BOXARM is bit 0 of the packed flags, and it is SET.
      c.setResponse(MSP_STATUS_EX, statusExPayload({flightModeFlags: 1}));
    });
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    const outcome = await run(controller, sessionId, 'ACC_CALIBRATION');
    expect(outcome).toEqual({kind: 'REJECTED', tool: 'ACC_CALIBRATION', reason: 'ARMED'});
    expect(client.countOf(MSP_ACC_CALIBRATION)).toBe(0);
  });

  it('REJECTS when the armed state cannot be proven (no BOXIDS mapping) and sends NO write', async () => {
    const sessionId = 'fc-tools-armed-unknown';
    const client = await openIdentifiedSession(sessionId, c => {
      c.setErrorFrame(MSP_BOXIDS); // the FC rejects the mapping request
    });
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    const outcome = await run(controller, sessionId, 'ACC_CALIBRATION');
    expect(outcome).toEqual({kind: 'REJECTED', tool: 'ACC_CALIBRATION', reason: 'ARMED_UNKNOWN'});
    expect(client.countOf(MSP_ACC_CALIBRATION)).toBe(0);
    // ...and the failed mapping is never retried inside this identity.
    await run(controller, sessionId, 'ACC_CALIBRATION');
    expect(client.countOf(MSP_BOXIDS)).toBe(1);
  });

  it('REJECTS a MALFORMED fresh preflight and dispatches ZERO commands', async () => {
    const sessionId = 'fc-tools-malformed';
    const client = await openIdentifiedSession(sessionId, c => {
      // A full, otherwise-authorizing frame whose extension byteCount
      // declares more bytes than the frame actually holds.
      c.setResponse(
        MSP_STATUS_EX,
        Uint8Array.from([
          ...u16le(312), ...u16le(0), ...u16le(41), 0, 0, 0, 0, 0, ...u16le(12),
          3, 0, 12, 0x01,
        ]),
      );
    });
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    const outcome = await run(controller, sessionId, 'ACC_CALIBRATION');
    expect(outcome).toEqual({kind: 'REJECTED', tool: 'ACC_CALIBRATION', reason: 'MALFORMED_READING'});
    expect(client.countOf(MSP_ACC_CALIBRATION)).toBe(0);
    expect(client.countOf(MSP_MAG_CALIBRATION)).toBe(0);
    expect(client.countOf(MSP_REBOOT)).toBe(0);
  });

  it('REJECTS a preflight whose blocker mask is only PARTIALLY present, dispatching ZERO commands', async () => {
    const sessionId = 'fc-tools-partial-mask';
    const client = await openIdentifiedSession(sessionId, c => {
      // The ARMING_DISABLE_FLAGS_COUNT byte is present, but only two of
      // the four mask bytes follow it.
      c.setResponse(
        MSP_STATUS_EX,
        Uint8Array.from([
          ...u16le(312), ...u16le(0), ...u16le(41), 0, 0, 0, 0, 0, ...u16le(12),
          3, 0, 0, 29, 0x00, 0x00,
        ]),
      );
    });
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    const outcome = await run(controller, sessionId, 'REBOOT');
    expect(outcome).toEqual({kind: 'REJECTED', tool: 'REBOOT', reason: 'MALFORMED_READING'});
    expect(client.countOf(MSP_REBOOT)).toBe(0);
  });

  it('REJECTS magnetometer calibration when no magnetometer is reported as detected', async () => {
    const sessionId = 'fc-tools-no-mag';
    const client = await openIdentifiedSession(sessionId, c => {
      c.setResponse(MSP_STATUS_EX, statusExPayload({sensorMask: 41})); // ACC|GPS|GYRO, no MAG
    });
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    const outcome = await run(controller, sessionId, 'MAG_CALIBRATION');
    expect(outcome).toEqual({kind: 'REJECTED', tool: 'MAG_CALIBRATION', reason: 'SENSOR_NOT_DETECTED'});
    expect(client.countOf(MSP_MAG_CALIBRATION)).toBe(0);
  });

  it('runs magnetometer calibration when the FRESH reading reports a magnetometer', async () => {
    const sessionId = 'fc-tools-mag';
    const client = await openIdentifiedSession(sessionId, c => {
      c.setResponse(MSP_STATUS_EX, statusExPayload({sensorMask: 41 + 4})); // + MAG (bit 2)
    });
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    expect(await run(controller, sessionId, 'MAG_CALIBRATION')).toEqual({
      kind: 'ACCEPTED',
      tool: 'MAG_CALIBRATION',
    });
    expect(client.countOf(MSP_MAG_CALIBRATION)).toBe(1);
  });

  it('REJECTS an incompatible FC/API and sends NO write', async () => {
    const sessionId = 'fc-tools-incompatible';
    const client = await openIdentifiedSession(sessionId, c => {
      c.setResponse(MSP_API_VERSION, Uint8Array.from([0, 1, 46]));
    });
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    const outcome = await run(controller, sessionId, 'REBOOT');
    expect(outcome).toEqual({kind: 'REJECTED', tool: 'REBOOT', reason: 'INCOMPATIBLE'});
    expect(client.countOf(MSP_REBOOT)).toBe(0);
    // The mapping is never even requested for an incompatible FC.
    expect(client.countOf(MSP_BOXIDS)).toBe(0);
  });

  it('sends NO write when the app is backgrounded BEFORE dispatch', async () => {
    const sessionId = 'fc-tools-bg-before';
    const client = await openIdentifiedSession(sessionId);
    const {owner} = makeOwner('background');
    const controller = new FcToolsController({appStateOwner: owner});

    const outcome = await run(controller, sessionId, 'ACC_CALIBRATION');
    expect(outcome).toEqual({kind: 'REJECTED', tool: 'ACC_CALIBRATION', reason: 'BACKGROUNDED'});
    expect(client.countOf(MSP_ACC_CALIBRATION)).toBe(0);
    expect(client.countOf(MSP_STATUS_EX)).toBeGreaterThanOrEqual(0);
  });

  it('backgrounding AFTER dispatch never retries and never fabricates an outcome', async () => {
    const sessionId = 'fc-tools-bg-after';
    const {owner, appState} = makeOwner();
    const client = await openIdentifiedSession(sessionId, c => {
      c.onWrite(command => {
        if (command === MSP_ACC_CALIBRATION) {
          appState.emit('background');
        }
      });
    });
    const controller = new FcToolsController({appStateOwner: owner});

    const outcome = await run(controller, sessionId, 'ACC_CALIBRATION');
    expect(outcome).toEqual({kind: 'ACCEPTED', tool: 'ACC_CALIBRATION'});
    expect(client.countOf(MSP_ACC_CALIBRATION)).toBe(1); // exactly once, no retry
    expect(owner.getPhase()).toBe('APP_BACKGROUND');
  });

  it('an MSP error frame is a DEFINITE failure, not an ambiguous one', async () => {
    const sessionId = 'fc-tools-error-frame';
    const client = await openIdentifiedSession(sessionId, c => {
      c.setErrorFrame(MSP_ACC_CALIBRATION);
    });
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    const outcome = await run(controller, sessionId, 'ACC_CALIBRATION');
    expect(outcome.kind).toBe('FAILED');
    expect(client.countOf(MSP_ACC_CALIBRATION)).toBe(1);
  });

  it('a real 2000ms response timeout is UNCONFIRMED - never success, never definite failure, never retried', async () => {
    const sessionId = 'fc-tools-timeout';
    const client = await openIdentifiedSession(sessionId, c => {
      c.hold(MSP_ACC_CALIBRATION);
    });
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    expect(controller.requestConfirmation(sessionId, 'ACC_CALIBRATION')).toBe(true);
    const settled = controller.confirm();
    await jest.advanceTimersByTimeAsync(2100); // the REAL MspClient timeout
    await flushAsync();

    expect(await settled).toEqual({kind: 'UNCONFIRMED', tool: 'ACC_CALIBRATION'});
    expect(client.countOf(MSP_ACC_CALIBRATION)).toBe(1);
    expect(controller.getPhase()).toEqual({kind: 'IDLE'});
  });

  it('reboot reports REBOOT_REQUESTED on ack and never claims the FC came back', async () => {
    const sessionId = 'fc-tools-reboot';
    const client = await openIdentifiedSession(sessionId);
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    const outcome = await run(controller, sessionId, 'REBOOT');
    expect(outcome).toEqual({kind: 'REBOOT_REQUESTED'});
    expect(client.countOf(MSP_REBOOT)).toBe(1);
  });

  it('a reboot whose ack never arrives is UNCONFIRMED, not a failure, and is never resent', async () => {
    const sessionId = 'fc-tools-reboot-silent';
    const client = await openIdentifiedSession(sessionId, c => {
      c.hold(MSP_REBOOT); // the FC rebooted before answering
    });
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    expect(controller.requestConfirmation(sessionId, 'REBOOT')).toBe(true);
    const settled = controller.confirm();
    await jest.advanceTimersByTimeAsync(2100);
    await flushAsync();

    expect(await settled).toEqual({kind: 'UNCONFIRMED', tool: 'REBOOT'});
    expect(client.countOf(MSP_REBOOT)).toBe(1);
  });

  it('reports SESSION_ENDED when the session is gone before the transaction can start', async () => {
    const sessionId = 'fc-tools-no-session';
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});
    expect(controller.requestConfirmation(sessionId, 'REBOOT')).toBe(true);
    expect(await controller.confirm()).toEqual({kind: 'SESSION_ENDED', tool: 'REBOOT'});
  });

  it('a disconnect during the preflight sends no write', async () => {
    const sessionId = 'fc-tools-disconnect-preflight';
    const client = await openIdentifiedSession(sessionId, c => {
      c.onWrite(command => {
        if (command === MSP_BOXIDS) {
          mspSessionCoordinator.deactivateMspSession(sessionId);
        }
      });
    });
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    const outcome = await run(controller, sessionId, 'ACC_CALIBRATION');
    expect(['REJECTED', 'SESSION_ENDED', 'UNCONFIRMED', 'FAILED']).toContain(outcome.kind);
    expect(client.countOf(MSP_ACC_CALIBRATION)).toBe(0);
  });
});

describe('FcToolsController - the single shared mutex', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    openSessionIds = [];
  });

  afterEach(async () => {
    for (const sessionId of openSessionIds) {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    }
    await flushAsync();
    jest.clearAllTimers();
    jest.useRealTimers();
    await flushAsync();
  });

  it('a double tap cannot open two confirmations', () => {
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});
    expect(controller.requestConfirmation('s', 'ACC_CALIBRATION')).toBe(true);
    expect(controller.requestConfirmation('s', 'ACC_CALIBRATION')).toBe(false);
    expect(controller.getPhase()).toEqual({kind: 'CONFIRMING', tool: 'ACC_CALIBRATION', sessionId: 's'});
  });

  it('two DIFFERENT tools compete for the same mutex - the second is refused', () => {
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});
    expect(controller.requestConfirmation('s', 'ACC_CALIBRATION')).toBe(true);
    expect(controller.requestConfirmation('s', 'REBOOT')).toBe(false);
    expect(controller.requestConfirmation('s', 'MAG_CALIBRATION')).toBe(false);
  });

  it('cancelling sends NO write, releases the mutex, and settles exactly once', async () => {
    const sessionId = 'fc-tools-cancel';
    const client = await openIdentifiedSession(sessionId);
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});
    const settles: unknown[] = [];
    controller.subscribe(() => settles.push(controller.getPhase()));

    controller.requestConfirmation(sessionId, 'ACC_CALIBRATION');
    controller.cancel();
    controller.cancel(); // a second cancel is a no-op

    expect(controller.getPhase()).toEqual({kind: 'IDLE'});
    expect(controller.getLastOutcome()).toEqual({kind: 'CANCELLED', tool: 'ACC_CALIBRATION'});
    expect(client.countOf(MSP_ACC_CALIBRATION)).toBe(0);
    // CONFIRMING then IDLE - exactly two notifications, not three.
    expect(settles).toEqual([{kind: 'CONFIRMING', tool: 'ACC_CALIBRATION', sessionId}, {kind: 'IDLE'}]);
  });

  it('a second confirm() while one is RUNNING starts nothing new', async () => {
    const sessionId = 'fc-tools-double-confirm';
    const client = await openIdentifiedSession(sessionId);
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    controller.requestConfirmation(sessionId, 'ACC_CALIBRATION');
    const first = controller.confirm();
    const second = controller.confirm(); // ignored: the mutex is held
    await jest.advanceTimersByTimeAsync(1);
    await flushAsync();

    await first;
    await second;
    expect(client.countOf(MSP_ACC_CALIBRATION)).toBe(1);
  });

  it('the outcome is published exactly once per action', async () => {
    const sessionId = 'fc-tools-callback-once';
    await openIdentifiedSession(sessionId);
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});
    const outcomes: unknown[] = [];
    controller.subscribe(() => {
      const outcome = controller.getLastOutcome();
      if (outcome !== undefined) {
        outcomes.push(outcome);
      }
    });

    controller.requestConfirmation(sessionId, 'ACC_CALIBRATION');
    await controller.confirm();
    await jest.advanceTimersByTimeAsync(1);
    await flushAsync();

    expect(outcomes).toEqual([{kind: 'ACCEPTED', tool: 'ACC_CALIBRATION'}]);
  });
});

describe('FcToolsController - telemetry pause and guaranteed resume', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    openSessionIds = [];
  });

  afterEach(async () => {
    for (const sessionId of openSessionIds) {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    }
    await flushAsync();
    jest.clearAllTimers();
    jest.useRealTimers();
    await flushAsync();
  });

  /** Observes the REAL scheduler's own lease API. */
  function watchLeases(sessionId: string) {
    const scheduler = mspSessionCoordinator.getTelemetryScheduler(sessionId)!;
    const acquired: string[] = [];
    const released: string[] = [];
    const original = scheduler.acquirePauseLease.bind(scheduler);
    scheduler.acquirePauseLease = reason => {
      const lease = original(reason);
      acquired.push(lease.id);
      return {
        id: lease.id,
        release: () => {
          released.push(lease.id);
          lease.release();
        },
      };
    };
    return {acquired, released};
  }

  it('pauses new periodic scheduling for the transaction and ALWAYS releases the lease on success', async () => {
    const sessionId = 'fc-tools-pause-success';
    await openIdentifiedSession(sessionId);
    const leases = watchLeases(sessionId);
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    controller.requestConfirmation(sessionId, 'ACC_CALIBRATION');
    const settled = controller.confirm();
    await jest.advanceTimersByTimeAsync(1);
    await flushAsync();
    await settled;

    expect(leases.acquired).toHaveLength(1);
    expect(leases.released).toEqual(leases.acquired);
  });

  it('releases the lease on a REJECTED preflight (nothing sent) and on an ambiguous timeout', async () => {
    const sessionId = 'fc-tools-pause-reject';
    await openIdentifiedSession(sessionId, c => {
      c.setResponse(MSP_STATUS_EX, statusExPayload({flightModeFlags: 1})); // ARMED
    });
    const leases = watchLeases(sessionId);
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    controller.requestConfirmation(sessionId, 'ACC_CALIBRATION');
    const rejected = controller.confirm();
    await jest.advanceTimersByTimeAsync(1);
    await flushAsync();
    expect((await rejected).kind).toBe('REJECTED');
    expect(leases.released).toEqual(leases.acquired);
    expect(leases.acquired).toHaveLength(1);
  });

  it('releases the lease even when the FC-tool write times out', async () => {
    const sessionId = 'fc-tools-pause-timeout';
    await openIdentifiedSession(sessionId, c => {
      c.hold(MSP_ACC_CALIBRATION);
    });
    const leases = watchLeases(sessionId);
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    controller.requestConfirmation(sessionId, 'ACC_CALIBRATION');
    const settled = controller.confirm();
    await jest.advanceTimersByTimeAsync(2100);
    await flushAsync();
    expect((await settled).kind).toBe('UNCONFIRMED');
    expect(leases.released).toEqual(leases.acquired);
  });

  it('releases the lease after a reboot too - the session-ending effect is not an excuse to leak it', async () => {
    const sessionId = 'fc-tools-pause-reboot';
    await openIdentifiedSession(sessionId);
    const leases = watchLeases(sessionId);
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    controller.requestConfirmation(sessionId, 'REBOOT');
    const settled = controller.confirm();
    await jest.advanceTimersByTimeAsync(1);
    await flushAsync();
    expect(await settled).toEqual({kind: 'REBOOT_REQUESTED'});
    expect(leases.released).toEqual(leases.acquired);
  });
});

describe('FcToolsController - generation binding', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    openSessionIds = [];
  });

  afterEach(async () => {
    for (const sessionId of openSessionIds) {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    }
    await flushAsync();
    jest.clearAllTimers();
    jest.useRealTimers();
    await flushAsync();
  });

  it('a replacement generation re-acquires its OWN mapping and never inherits the old one', async () => {
    const sessionId = 'fc-tools-generation';
    const first = await openIdentifiedSession(sessionId);
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    controller.requestConfirmation(sessionId, 'ACC_CALIBRATION');
    const settled = controller.confirm();
    await jest.advanceTimersByTimeAsync(1);
    await flushAsync();
    await settled;
    expect(first.countOf(MSP_BOXIDS)).toBe(1);

    mspSessionCoordinator.deactivateMspSession(sessionId);
    await flushAsync();

    const second = await openIdentifiedSession(sessionId);
    controller.requestConfirmation(sessionId, 'ACC_CALIBRATION');
    const settled2 = controller.confirm();
    await jest.advanceTimersByTimeAsync(1);
    await flushAsync();
    expect(await settled2).toEqual({kind: 'ACCEPTED', tool: 'ACC_CALIBRATION'});
    // The NEW physical session asked for its own mapping.
    expect(second.countOf(MSP_BOXIDS)).toBe(1);
  });

  it('peekArmedState never guesses: UNKNOWN without a mapping, and never derived from blockers', async () => {
    const sessionId = 'fc-tools-peek';
    await openIdentifiedSession(sessionId, c => {
      // Every blocker set, but the ARM bit clear.
      c.setResponse(MSP_STATUS_EX, statusExPayload({blockerMask: 0x1fffffff}));
    });
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    expect(controller.peekArmedState(sessionId, undefined)).toBe('UNKNOWN');
    controller.ensureBoxIdsMapping(sessionId);
    await jest.advanceTimersByTimeAsync(1);
    await flushAsync();

    // With the mapping in hand, the FULL blocker mask still yields
    // DISARMED - the armed state comes only from the BOXARM bit.
    const scheduler = mspSessionCoordinator.getTelemetryScheduler(sessionId);
    expect(scheduler).toBeDefined();
    await jest.advanceTimersByTimeAsync(2200);
    await flushAsync();
    const status = scheduler!.getValue<{flightModeFlagsLow32: number; readiness: {extraFlightModeFlagBytes?: number[]}}>(
      'fcStatus',
    );
    if (status.status === 'FRESH' || status.status === 'STALE') {
      expect(controller.peekArmedState(sessionId, status.value as never)).toBe('DISARMED');
    }
  });
});
