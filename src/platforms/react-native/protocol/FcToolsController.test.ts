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

/**
 * SENSORS B-5: A CALIBRATION IS NO LONGER A ONE-ROUND-TRIP TRANSACTION.
 *
 * Both calibration tools are delegated to the Sensors verified lifecycle,
 * which watches the board's arming-disable flags until the run provably
 * ends. `settleTransaction()` - eighty milliseconds, sized for a single
 * acknowledgement - cannot reach the end of one, so a delegated tool
 * needs its own settle. The budget is the accelerometer's own absolute
 * deadline plus a margin, so a run the board never acknowledges as
 * started still reaches a terminal answer here instead of hanging.
 */
async function settleCalibration(totalMs = 9_000): Promise<void> {
  for (let elapsed = 0; elapsed < totalMs; elapsed += 250) {
    await jest.advanceTimersByTimeAsync(250);
    await flushAsync();
  }
}

/** Bit 12 of the arming-disable tail: ARMING_DISABLED_CALIBRATING, set by
 *  fc/core.c's isCalibrating(). Its RISE and then its FALL are the only
 *  evidence the lifecycle accepts as a completed run. */
const CALIBRATING_BLOCKER = 1 << 12;

/**
 * Drives the fake board through a complete accelerometer calibration:
 * the command is answered, the board reports it is calibrating, and then
 * it stops. Nothing here shortens a wait - the virtual clock does all of
 * it - and nothing asserts; a test that wants a DIFFERENT ending simply
 * does not call this.
 */
async function driveAccCalibration(
  client: ReturnType<typeof makeFakeClient>,
  options: {sensorMask?: number} = {},
): Promise<void> {
  await settleCalibration(500); // preflight, the command, the first polls
  client.setResponse(MSP_STATUS_EX, statusExPayload({...options, blockerMask: CALIBRATING_BLOCKER}));
  await settleCalibration(750);
  client.setResponse(MSP_STATUS_EX, statusExPayload(options));
  await settleCalibration(750);
}

/**
 * The same for the magnetometer, with the one difference the firmware
 * forces: compass.c stops at start+15s having saved nothing when the
 * aircraft was never moved, so a run that ends before the 20 s cutoff is
 * reported as NO_MOVEMENT_DETECTED rather than as a success. Staying in
 * calibration past that point is what makes this a completed run.
 */
async function driveMagCalibration(
  client: ReturnType<typeof makeFakeClient>,
  options: {sensorMask?: number} = {},
): Promise<void> {
  await settleCalibration(1_000);
  client.setResponse(MSP_STATUS_EX, statusExPayload({...options, blockerMask: CALIBRATING_BLOCKER}));
  await settleCalibration(22_000);
  client.setResponse(MSP_STATUS_EX, statusExPayload(options));
  await settleCalibration(1_500);
}

/** The sensor-presence mask bits the fake board reports. 41 is the
 *  default (ACC|GPS|GYRO); bit 2 adds the magnetometer. */
const SENSOR_MASK_WITH_MAG = 41 + 4;

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

  /**
   * SENSORS B-5: THE EXEMPLAR TOOL FOR THE GENERIC TRANSACTION IS NOW
   * THE REBOOT.
   *
   * It is the only tool left on this path - both calibrations are
   * delegated to the Sensors verified lifecycle - so testing the generic
   * machinery through a calibration would test the delegation instead
   * and quietly stop covering this code at all. The delegated shape gets
   * its own tests, immediately below and throughout.
   */
  it('sends the write EXACTLY once, after ONE fresh preflight status read, and never claims more than the ack', async () => {
    const sessionId = 'fc-tools-happy';
    const client = await openIdentifiedSession(sessionId);
    const {owner} = makeOwner();
    const controller = new FcToolsController({appStateOwner: owner});

    const statusBefore = client.countOf(MSP_STATUS_EX);
    const outcome = await run(controller, sessionId, 'REBOOT');

    expect(outcome).toEqual({kind: 'REBOOT_REQUESTED'});
    expect(client.countOf(MSP_REBOOT)).toBe(1);
    expect(client.countOf(MSP_STATUS_EX)).toBe(statusBefore + 1); // the fresh preflight read
    expect(client.countOf(MSP_BOXIDS)).toBe(1);
    // The mutex was released exactly once, at the single settle point.
    expect(controller.getPhase()).toEqual({kind: 'IDLE'});
    expect(controller.getLastOutcome()).toEqual(outcome);
  });

  it('a calibration is DELEGATED: one write after one fresh preflight read, and the result is an OBSERVATION', async () => {
    const sessionId = 'fc-tools-happy-calibration';
    const client = await openIdentifiedSession(sessionId);
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    let statusAtDispatch = -1;
    const statusBefore = client.countOf(MSP_STATUS_EX);
    client.onWrite(command => {
      if (command === MSP_ACC_CALIBRATION) {
        statusAtDispatch = client.countOf(MSP_STATUS_EX);
      }
    });

    expect(controller.requestConfirmation(sessionId, 'ACC_CALIBRATION')).toBe(true);
    const settled = controller.confirm();
    await driveAccCalibration(client);
    const outcome = await settled;

    expect(outcome?.kind).toBe('CALIBRATION_OBSERVED');
    expect(outcome).toMatchObject({tool: 'ACC_CALIBRATION', outcome: {kind: 'SUCCEEDED'}});
    expect(client.countOf(MSP_ACC_CALIBRATION)).toBe(1);
    // Exactly one fresh status read stood between the mapping and the
    // write; every LATER one is the watch, which is why the count after
    // the fact cannot be used for this.
    expect(statusAtDispatch).toBe(statusBefore + 1);
    expect(client.countOf(MSP_BOXIDS)).toBe(1);
    expect(controller.getPhase()).toEqual({kind: 'IDLE'});
  });

  it('acquires the BOXIDS mapping at most once across repeated actions in the same identity', async () => {
    const sessionId = 'fc-tools-boxids-once';
    const client = await openIdentifiedSession(sessionId);
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    await run(controller, sessionId, 'REBOOT');
    await run(controller, sessionId, 'REBOOT');
    await run(controller, sessionId, 'REBOOT');

    expect(client.countOf(MSP_BOXIDS)).toBe(1);
    expect(client.countOf(MSP_REBOOT)).toBe(3);
  });

  /**
   * DELEGATION COSTS EXACTLY ONE EXTRA MAPPING REQUEST PER SESSION, and
   * it is named here rather than left to be discovered. The Sensors
   * lifecycle proves the armed state from its own BOXIDS acquisition -
   * it has to, because it is also used from a screen this controller
   * knows nothing about - so a session that runs both a calibration and
   * a reboot asks the board for the mapping twice in total, once per
   * owner, and never again after that.
   */
  it('each owner acquires the BOXIDS mapping once - a calibration and a reboot cost two in total, never more', async () => {
    const sessionId = 'fc-tools-boxids-owners';
    const client = await openIdentifiedSession(sessionId);
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    controller.requestConfirmation(sessionId, 'ACC_CALIBRATION');
    const first = controller.confirm();
    await driveAccCalibration(client);
    await first;
    expect(client.countOf(MSP_BOXIDS)).toBe(1);

    controller.requestConfirmation(sessionId, 'ACC_CALIBRATION');
    const second = controller.confirm();
    await driveAccCalibration(client);
    await second;
    expect(client.countOf(MSP_BOXIDS)).toBe(1); // the lifecycle cached it

    await run(controller, sessionId, 'REBOOT');
    expect(client.countOf(MSP_BOXIDS)).toBe(2); // the generic path's own
    expect(client.countOf(MSP_ACC_CALIBRATION)).toBe(2);
  });

  it('REJECTS while ARMED and sends NO write', async () => {
    const sessionId = 'fc-tools-armed';
    const client = await openIdentifiedSession(sessionId, c => {
      // BOXARM is bit 0 of the packed flags, and it is SET.
      c.setResponse(MSP_STATUS_EX, statusExPayload({flightModeFlags: 1}));
    });
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    expect(await run(controller, sessionId, 'REBOOT')).toEqual({
      kind: 'REJECTED',
      tool: 'REBOOT',
      reason: 'ARMED',
    });
    expect(client.countOf(MSP_REBOOT)).toBe(0);

    // The delegated path refuses on its own evidence, and says which.
    controller.requestConfirmation(sessionId, 'ACC_CALIBRATION');
    const calibration = controller.confirm();
    await settleCalibration(1_000);
    expect(await calibration).toEqual({
      kind: 'CALIBRATION_OBSERVED',
      tool: 'ACC_CALIBRATION',
      outcome: {kind: 'REFUSED_ARMED'},
    });
    expect(client.countOf(MSP_ACC_CALIBRATION)).toBe(0);
  });

  it('REJECTS when the armed state cannot be proven (no BOXIDS mapping) and sends NO write', async () => {
    const sessionId = 'fc-tools-armed-unknown';
    const client = await openIdentifiedSession(sessionId, c => {
      c.setErrorFrame(MSP_BOXIDS); // the FC rejects the mapping request
    });
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    expect(await run(controller, sessionId, 'REBOOT')).toEqual({
      kind: 'REJECTED',
      tool: 'REBOOT',
      reason: 'ARMED_UNKNOWN',
    });
    expect(client.countOf(MSP_REBOOT)).toBe(0);
    // ...and the failed mapping is never retried inside this identity.
    await run(controller, sessionId, 'REBOOT');
    expect(client.countOf(MSP_BOXIDS)).toBe(1);

    // The delegated path reaches the same refusal from its own mapping.
    controller.requestConfirmation(sessionId, 'ACC_CALIBRATION');
    const calibration = controller.confirm();
    await settleCalibration(1_000);
    expect(await calibration).toEqual({
      kind: 'CALIBRATION_OBSERVED',
      tool: 'ACC_CALIBRATION',
      outcome: {kind: 'ARM_STATE_UNKNOWN'},
    });
    expect(client.countOf(MSP_ACC_CALIBRATION)).toBe(0);
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

    expect(await run(controller, sessionId, 'REBOOT')).toEqual({
      kind: 'REJECTED',
      tool: 'REBOOT',
      reason: 'MALFORMED_READING',
    });

    // A malformed tail is not a provable disarm on either path.
    controller.requestConfirmation(sessionId, 'ACC_CALIBRATION');
    const calibration = controller.confirm();
    await settleCalibration(1_000);
    expect(await calibration).toEqual({
      kind: 'CALIBRATION_OBSERVED',
      tool: 'ACC_CALIBRATION',
      outcome: {kind: 'ARM_STATE_UNKNOWN'},
    });

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

    controller.requestConfirmation(sessionId, 'MAG_CALIBRATION');
    const settled = controller.confirm();
    await settleCalibration(1_000);

    /* compassStartCalibration() sits inside `#ifdef USE_MAG` and the
       handler acknowledges either way, so a board with no magnetometer
       answers cheerfully and calibrates nothing. The refusal states only
       what the fresh status frame reported. */
    expect(await settled).toEqual({
      kind: 'CALIBRATION_OBSERVED',
      tool: 'MAG_CALIBRATION',
      outcome: {kind: 'REJECTED', reason: 'SENSOR_NOT_PRESENT'},
    });
    expect(client.countOf(MSP_MAG_CALIBRATION)).toBe(0);
  });

  it('runs magnetometer calibration when the FRESH reading reports a magnetometer', async () => {
    const sessionId = 'fc-tools-mag';
    const client = await openIdentifiedSession(sessionId, c => {
      c.setResponse(MSP_STATUS_EX, statusExPayload({sensorMask: 41 + 4})); // + MAG (bit 2)
    });
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    controller.requestConfirmation(sessionId, 'MAG_CALIBRATION');
    const settled = controller.confirm();
    await driveMagCalibration(client, {sensorMask: SENSOR_MASK_WITH_MAG});

    expect(await settled).toMatchObject({
      kind: 'CALIBRATION_OBSERVED',
      tool: 'MAG_CALIBRATION',
      outcome: {kind: 'SUCCEEDED'},
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

    expect(await run(controller, sessionId, 'REBOOT')).toEqual({
      kind: 'REJECTED',
      tool: 'REBOOT',
      reason: 'BACKGROUNDED',
    });
    expect(client.countOf(MSP_REBOOT)).toBe(0);

    controller.requestConfirmation(sessionId, 'ACC_CALIBRATION');
    const calibration = controller.confirm();
    await settleCalibration(1_000);
    expect(await calibration).toEqual({
      kind: 'CALIBRATION_OBSERVED',
      tool: 'ACC_CALIBRATION',
      outcome: {kind: 'REJECTED', reason: 'APP_BACKGROUNDED'},
    });
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

    controller.requestConfirmation(sessionId, 'ACC_CALIBRATION');
    const settled = controller.confirm();
    await settleCalibration(2_000);

    /* The cable, the port and the board may all be fine; only the app's
       ability to WATCH went away. Saying the connection was lost would
       assert something about hardware nobody observed, and claiming a
       result would invent one. */
    expect(await settled).toEqual({
      kind: 'CALIBRATION_OBSERVED',
      tool: 'ACC_CALIBRATION',
      outcome: {kind: 'OBSERVATION_CANCELLED', boardMayStillBeCalibrating: true},
    });
    expect(client.countOf(MSP_ACC_CALIBRATION)).toBe(1); // exactly once, no retry
    expect(owner.getPhase()).toBe('APP_BACKGROUND');
  });

  it('an MSP error frame is a DEFINITE failure, not an ambiguous one', async () => {
    const sessionId = 'fc-tools-error-frame';
    const client = await openIdentifiedSession(sessionId, c => {
      c.setErrorFrame(MSP_ACC_CALIBRATION);
    });
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    controller.requestConfirmation(sessionId, 'ACC_CALIBRATION');
    const settled = controller.confirm();
    await settleCalibration(2_000);

    /* The FC ANSWERED, with an error: the command provably started
       nothing, so this stays a definite failure rather than being
       softened into "we could not confirm the start". */
    expect(await settled).toMatchObject({
      kind: 'CALIBRATION_OBSERVED',
      tool: 'ACC_CALIBRATION',
      outcome: {kind: 'FAILED'},
    });
    expect(client.countOf(MSP_ACC_CALIBRATION)).toBe(1);
  });

  it('a real 2000ms response timeout on a calibration is an UNCONFIRMED START - never success, never a definite failure, never retried', async () => {
    const sessionId = 'fc-tools-timeout';
    const client = await openIdentifiedSession(sessionId, c => {
      c.hold(MSP_ACC_CALIBRATION);
    });
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    expect(controller.requestConfirmation(sessionId, 'ACC_CALIBRATION')).toBe(true);
    const settled = controller.confirm();
    await settleCalibration(3_000); // past the REAL MspClient timeout

    /* The bytes may have reached the board and it may be calibrating
       right now, so "the calibration could not be completed" would claim
       more than was observed. The start was never confirmed; that is all
       this says. */
    expect(await settled).toEqual({
      kind: 'CALIBRATION_OBSERVED',
      tool: 'ACC_CALIBRATION',
      outcome: {kind: 'START_NOT_OBSERVED'},
    });
    expect(client.countOf(MSP_ACC_CALIBRATION)).toBe(1);
    expect(controller.getPhase()).toEqual({kind: 'IDLE'});
  });

  it('a real 2000ms response timeout on the generic path is UNCONFIRMED and never retried', async () => {
    const sessionId = 'fc-tools-timeout-generic';
    const client = await openIdentifiedSession(sessionId, c => {
      c.hold(MSP_REBOOT);
    });
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    expect(controller.requestConfirmation(sessionId, 'REBOOT')).toBe(true);
    const settled = controller.confirm();
    await jest.advanceTimersByTimeAsync(2100); // the REAL MspClient timeout
    await flushAsync();

    expect(await settled).toEqual({kind: 'UNCONFIRMED', tool: 'REBOOT'});
    expect(client.countOf(MSP_REBOOT)).toBe(1);
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

  it('a link that dies right after the calibration ack reports the lost link, never a result, and never resends', async () => {
    const sessionId = 'fc-tools-detach-after-ack';
    const client = await openIdentifiedSession(sessionId, c => {
      c.onWrite(command => {
        if (command === MSP_ACC_CALIBRATION) {
          // The link dies immediately after the write - but the ack for
          // it still arrives and settles first.
          Promise.resolve().then(() => Promise.resolve()).then(() => {
            mspSessionCoordinator.deactivateMspSession(sessionId);
          });
        }
      });
    });
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    controller.requestConfirmation(sessionId, 'ACC_CALIBRATION');
    const settled = controller.confirm();
    await settleCalibration(2_000);

    /* The command was acknowledged and that is now the FIRST thing that
       happens inside an observation rather than its result. With the
       link gone there is nothing left to observe, and the honest answer
       says so instead of reporting an acceptance as an outcome. */
    expect(await settled).toEqual({
      kind: 'CALIBRATION_OBSERVED',
      tool: 'ACC_CALIBRATION',
      outcome: {kind: 'LINK_LOST'},
    });
    expect(client.countOf(MSP_ACC_CALIBRATION)).toBe(1); // never resent
  });

  it('a detach BEFORE any acknowledgement is UNCONFIRMED, never success and never definite failure', async () => {
    const sessionId = 'fc-tools-detach-before-ack';
    const client = await openIdentifiedSession(sessionId, c => {
      c.hold(MSP_ACC_CALIBRATION);
      c.onWrite(command => {
        if (command === MSP_ACC_CALIBRATION) {
          mspSessionCoordinator.deactivateMspSession(sessionId);
        }
      });
    });
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    expect(controller.requestConfirmation(sessionId, 'ACC_CALIBRATION')).toBe(true);
    const settled = controller.confirm();
    await settleCalibration(3_000);

    expect(await settled).toEqual({
      kind: 'CALIBRATION_OBSERVED',
      tool: 'ACC_CALIBRATION',
      outcome: {kind: 'LINK_LOST'},
    });
    expect(client.countOf(MSP_ACC_CALIBRATION)).toBe(1); // never retried
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

    controller.requestConfirmation(sessionId, 'ACC_CALIBRATION');
    const settled = controller.confirm();
    await settleCalibration(3_000);
    const outcome = await settled;
    expect(['REJECTED', 'SESSION_ENDED', 'UNCONFIRMED', 'FAILED', 'CALIBRATION_OBSERVED']).toContain(
      outcome?.kind,
    );
    // Whatever it is, it is never a claim that anything was calibrated.
    if (outcome?.kind === 'CALIBRATION_OBSERVED') {
      expect(outcome.outcome.kind).not.toBe('SUCCEEDED');
    }
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
    await driveAccCalibration(client);

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

    controller.requestConfirmation(sessionId, 'REBOOT');
    await controller.confirm();
    await jest.advanceTimersByTimeAsync(1);
    await flushAsync();

    expect(outcomes).toEqual([{kind: 'REBOOT_REQUESTED'}]);
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

    controller.requestConfirmation(sessionId, 'REBOOT');
    const settled = controller.confirm();
    await jest.advanceTimersByTimeAsync(1);
    await flushAsync();
    await settled;

    expect(leases.acquired).toHaveLength(1);
    expect(leases.released).toEqual(leases.acquired);
  });

  it('a DELEGATED calibration takes exactly one lease, for the whole observation, and always gives it back', async () => {
    const sessionId = 'fc-tools-pause-calibration';
    const client = await openIdentifiedSession(sessionId);
    const leases = watchLeases(sessionId);
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    controller.requestConfirmation(sessionId, 'ACC_CALIBRATION');
    const settled = controller.confirm();
    await settleCalibration(500);
    // Still watching: the lease is held for the WHOLE run, not just the
    // round trip that dispatched it.
    expect(leases.acquired).toHaveLength(1);
    expect(leases.released).toEqual([]);

    client.setResponse(MSP_STATUS_EX, statusExPayload({blockerMask: CALIBRATING_BLOCKER}));
    await settleCalibration(750);
    client.setResponse(MSP_STATUS_EX, statusExPayload());
    await settleCalibration(750);
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

    controller.requestConfirmation(sessionId, 'REBOOT');
    const rejected = controller.confirm();
    await jest.advanceTimersByTimeAsync(1);
    await flushAsync();
    expect((await rejected)?.kind).toBe('REJECTED');
    expect(leases.released).toEqual(leases.acquired);
    expect(leases.acquired).toHaveLength(1);
  });

  it('releases the lease even when the FC-tool write times out', async () => {
    const sessionId = 'fc-tools-pause-timeout';
    await openIdentifiedSession(sessionId, c => {
      c.hold(MSP_REBOOT);
    });
    const leases = watchLeases(sessionId);
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    controller.requestConfirmation(sessionId, 'REBOOT');
    const settled = controller.confirm();
    await jest.advanceTimersByTimeAsync(2100);
    await flushAsync();
    expect((await settled)?.kind).toBe('UNCONFIRMED');
    expect(leases.released).toEqual(leases.acquired);
  });

  it('releases the lease when a delegated calibration times out too', async () => {
    const sessionId = 'fc-tools-pause-calibration-timeout';
    await openIdentifiedSession(sessionId, c => {
      c.hold(MSP_ACC_CALIBRATION);
    });
    const leases = watchLeases(sessionId);
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    controller.requestConfirmation(sessionId, 'ACC_CALIBRATION');
    const settled = controller.confirm();
    await settleCalibration(3_000);
    expect((await settled)?.kind).toBe('CALIBRATION_OBSERVED');
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

describe('FcToolsController - preflight ordering and dispatch boundary (A-2)', () => {
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

  /** The commands written for THIS transaction, in order. */
  function tail(client: ReturnType<typeof makeFakeClient>, from: number): number[] {
    return client.commands.slice(from);
  }

  async function drive(controller: FcToolsController, sessionId: string, tool: 'ACC_CALIBRATION' | 'REBOOT') {
    // Only the generic path settles inside this budget; a delegated
    // calibration needs driveAccCalibration().
    expect(controller.requestConfirmation(sessionId, tool)).toBe(true);
    const settled = controller.confirm();
    for (let i = 0; i < 8; i++) {
      await jest.advanceTimersByTimeAsync(10);
      await flushAsync();
    }
    return settled;
  }

  it('FIRST consumer order is BOXIDS -> STATUS_EX -> exactly one tool request', async () => {
    const sessionId = 'a2-first-consumer';
    const client = await openIdentifiedSession(sessionId);
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});
    const from = client.commands.length;

    expect(await drive(controller, sessionId, 'REBOOT')).toEqual({kind: 'REBOOT_REQUESTED'});

    const order = tail(client, from).filter(c => c === MSP_BOXIDS || c === MSP_STATUS_EX || c === MSP_REBOOT);
    expect(order).toEqual([MSP_BOXIDS, MSP_STATUS_EX, MSP_REBOOT]);
  });

  /**
   * THE DELEGATED PATH KEEPS THE SAME ORDER, and it is pinned here as
   * well as in the Sensors suite: this is the ordering Setup depends on,
   * and delegation must not be a way for it to quietly change.
   */
  it('a delegated calibration keeps the order BOXIDS -> STATUS_EX -> exactly one tool request', async () => {
    const sessionId = 'a2-first-consumer-calibration';
    const client = await openIdentifiedSession(sessionId);
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});
    const from = client.commands.length;

    controller.requestConfirmation(sessionId, 'ACC_CALIBRATION');
    const settled = controller.confirm();
    await driveAccCalibration(client);
    await settled;

    const order = tail(client, from).filter(c => c === MSP_BOXIDS || c === MSP_ACC_CALIBRATION);
    expect(order).toEqual([MSP_BOXIDS, MSP_ACC_CALIBRATION]);
    // ...with a fresh status read between them, and no other round trip.
    const all = tail(client, from);
    const writeIndex = all.indexOf(MSP_ACC_CALIBRATION);
    expect(all[writeIndex - 1]).toBe(MSP_STATUS_EX);
    expect(all[writeIndex - 2]).toBe(MSP_BOXIDS);
  });

  it('CACHED mapping order is STATUS_EX -> exactly one tool request, with no second BOXIDS', async () => {
    const sessionId = 'a2-cached-mapping';
    const client = await openIdentifiedSession(sessionId);
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});
    await drive(controller, sessionId, 'REBOOT');

    const from = client.commands.length;
    await drive(controller, sessionId, 'REBOOT');
    const order = tail(client, from).filter(c => c === MSP_BOXIDS || c === MSP_STATUS_EX || c === MSP_REBOOT);
    expect(order).toEqual([MSP_STATUS_EX, MSP_REBOOT]);
    expect(client.countOf(MSP_BOXIDS)).toBe(1);
  });

  it('the FORBIDDEN order STATUS_EX -> BOXIDS -> tool request never occurs', async () => {
    const sessionId = 'a2-forbidden-order';
    const client = await openIdentifiedSession(sessionId);
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});
    controller.requestConfirmation(sessionId, 'ACC_CALIBRATION');
    const calibration = controller.confirm();
    await driveAccCalibration(client);
    await calibration;
    await drive(controller, sessionId, 'REBOOT');

    const relevant = client.commands.filter(
      c => c === MSP_BOXIDS || c === MSP_STATUS_EX || c === MSP_ACC_CALIBRATION || c === MSP_REBOOT,
    );
    for (let i = 0; i < relevant.length - 2; i++) {
      const window = [relevant[i], relevant[i + 1], relevant[i + 2]];
      expect(window).not.toEqual([MSP_STATUS_EX, MSP_BOXIDS, MSP_ACC_CALIBRATION]);
      expect(window).not.toEqual([MSP_STATUS_EX, MSP_BOXIDS, MSP_REBOOT]);
    }
  });

  it('no awaited MSP round trip exists between the fresh STATUS_EX and the tool request', async () => {
    const sessionId = 'a2-no-interposition';
    const client = await openIdentifiedSession(sessionId);
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});
    const from = client.commands.length;
    await drive(controller, sessionId, 'REBOOT');

    const order = tail(client, from);
    const statusIndex = order.lastIndexOf(MSP_STATUS_EX);
    const writeIndex = order.lastIndexOf(MSP_REBOOT);
    expect(statusIndex).toBeGreaterThanOrEqual(0);
    expect(writeIndex).toBe(statusIndex + 1); // strictly adjacent
  });

  it('a BOXIDS failure produces ZERO tool-request invocations and is not retried', async () => {
    const sessionId = 'a2-boxids-failure';
    const client = await openIdentifiedSession(sessionId, c => {
      c.setErrorFrame(MSP_BOXIDS);
    });
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    expect(await drive(controller, sessionId, 'REBOOT')).toEqual({
      kind: 'REJECTED',
      tool: 'REBOOT',
      reason: 'ARMED_UNKNOWN',
    });
    expect(client.countOf(MSP_REBOOT)).toBe(0);
    await drive(controller, sessionId, 'REBOOT');
    expect(client.countOf(MSP_BOXIDS)).toBe(1); // never retried
    expect(client.countOf(MSP_REBOOT)).toBe(0);
  });

  it('a GENERATION change during BOXIDS produces zero tool-request invocations and zero writes', async () => {
    const sessionId = 'a2-generation-during-boxids';
    const client = await openIdentifiedSession(sessionId, c => {
      c.onWrite(command => {
        if (command === MSP_BOXIDS) {
          mspSessionCoordinator.deactivateMspSession(sessionId);
        }
      });
    });
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    await drive(controller, sessionId, 'REBOOT');
    expect(client.countOf(MSP_REBOOT)).toBe(0);
    expect(client.countOf(MSP_STATUS_EX)).toBeGreaterThanOrEqual(0);
  });

  it('a GENERATION change during the fresh STATUS_EX produces zero tool-request invocations and zero writes', async () => {
    const sessionId = 'a2-generation-during-status';
    let armed = false;
    const client = await openIdentifiedSession(sessionId, c => {
      c.onWrite(command => {
        // Only the PREFLIGHT status read (after BOXIDS) kills the session.
        if (command === MSP_STATUS_EX && armed) {
          mspSessionCoordinator.deactivateMspSession(sessionId);
        }
      });
    });
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});
    armed = true;

    await drive(controller, sessionId, 'REBOOT');
    expect(client.countOf(MSP_REBOOT)).toBe(0);
  });

  it('the normal flow invokes exactly one state-changing request and writes it exactly once', async () => {
    const sessionId = 'a2-exactly-one';
    const client = await openIdentifiedSession(sessionId);
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});
    await drive(controller, sessionId, 'REBOOT');

    // Invocation and transport handoff are the SAME synchronous turn for
    // this path, so one invocation is exactly one transport write.
    expect(client.countOf(MSP_REBOOT)).toBe(1);
  });

  it('invalidation observed BEFORE invocation yields zero invocation and zero writes', async () => {
    const sessionId = 'a2-invalidate-before';
    const {owner, appState} = makeOwner();
    const client = await openIdentifiedSession(sessionId, c => {
      c.onWrite(command => {
        if (command === MSP_STATUS_EX) {
          appState.emit('background'); // observed by the final pre-dispatch check
        }
      });
    });
    const controller = new FcToolsController({appStateOwner: owner});

    expect(await drive(controller, sessionId, 'REBOOT')).toEqual({
      kind: 'REJECTED',
      tool: 'REBOOT',
      reason: 'BACKGROUNDED',
    });
    expect(client.countOf(MSP_REBOOT)).toBe(0);
  });

  it('invalidation AFTER transport handoff yields at most one write, UNCONFIRMED, and no retry', async () => {
    const sessionId = 'a2-invalidate-after';
    const client = await openIdentifiedSession(sessionId, c => {
      c.hold(MSP_ACC_CALIBRATION);
      c.onWrite(command => {
        if (command === MSP_ACC_CALIBRATION) {
          mspSessionCoordinator.deactivateMspSession(sessionId);
        }
      });
    });
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    expect(controller.requestConfirmation(sessionId, 'ACC_CALIBRATION')).toBe(true);
    const settled = controller.confirm();
    await settleCalibration(3_000);

    expect(await settled).toEqual({
      kind: 'CALIBRATION_OBSERVED',
      tool: 'ACC_CALIBRATION',
      outcome: {kind: 'LINK_LOST'},
    });
    expect(client.countOf(MSP_ACC_CALIBRATION)).toBe(1);
  });
});

describe('FcToolsController - settle-once, neutral confirm and bounded state (A-3, A-4, A-5)', () => {
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

  it('A-4: confirm() with no confirmation open returns the neutral result and publishes NOTHING', async () => {
    const sessionId = 'a4-neutral';
    await openIdentifiedSession(sessionId);
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});
    const notifications: unknown[] = [];
    controller.subscribe(() => notifications.push(controller.getPhase()));
    const before = controller.getPublicationSequence();

    const result = await controller.confirm();

    expect(result).toBeNull();
    expect(controller.getPhase()).toEqual({kind: 'IDLE'});
    expect(controller.getLastOutcome()).toBeUndefined();
    expect(controller.getVisibleOutcome(sessionId, before)).toBeUndefined();
    expect(controller.getPublicationSequence()).toBe(before);
    expect(notifications).toEqual([]);
  });

  it('A-4: the neutral result cannot clear or corrupt a legitimate newer outcome', async () => {
    const sessionId = 'a4-no-corruption';
    await openIdentifiedSession(sessionId);
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});
    const before = controller.getPublicationSequence();

    controller.requestConfirmation(sessionId, 'REBOOT');
    const settled = controller.confirm();
    for (let i = 0; i < 8; i++) {
      await jest.advanceTimersByTimeAsync(10);
      await flushAsync();
    }
    await settled;
    const published = controller.getVisibleOutcome(sessionId, before);
    expect(published).toBeDefined();

    expect(await controller.confirm()).toBeNull();
    expect(controller.getVisibleOutcome(sessionId, before)).toEqual(published);
  });

  it('A-3: an unexpected transaction rejection settles once, releases the mutex and stays conservative', async () => {
    const sessionId = 'a3-unexpected';
    await openIdentifiedSession(sessionId);
    // A legitimate injected seam - the controller's own coordinator
    // option - rather than a production-only failure path: this faulty
    // coordinator delegates everything except one lookup, which throws.
    const faulty = Object.create(mspSessionCoordinator) as typeof mspSessionCoordinator;
    (faulty as unknown as {getSessionKey: () => never}).getSessionKey = () => {
      throw new Error('unexpected internal failure');
    };
    const controller = new FcToolsController({coordinator: faulty, appStateOwner: makeOwner().owner});

    const phases: string[] = [];
    controller.subscribe(() => phases.push(controller.getPhase().kind));

    controller.requestConfirmation(sessionId, 'ACC_CALIBRATION');
    const outcome = await controller.confirm();

    expect(outcome).toEqual({kind: 'UNCONFIRMED', tool: 'ACC_CALIBRATION'});
    expect(controller.getPhase()).toEqual({kind: 'IDLE'});
    // CONFIRMING -> RUNNING -> IDLE, each notified exactly once.
    expect(phases).toEqual(['CONFIRMING', 'RUNNING', 'IDLE']);
    // The mutex is free: a later confirmation can proceed.
    expect(controller.requestConfirmation(sessionId, 'REBOOT')).toBe(true);
    controller.cancel();
  });

  it('A-5: state stays bounded across repeated open/close cycles and stale cleanup is harmless', async () => {
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});
    for (let i = 0; i < 6; i++) {
      const sessionId = `a5-cycle-${i}`;
      await openIdentifiedSession(sessionId);
      controller.ensureBoxIdsMapping(sessionId);
      await jest.advanceTimersByTimeAsync(20);
      await flushAsync();
      mspSessionCoordinator.deactivateMspSession(sessionId);
      await flushAsync();
      // Cleanup twice - idempotent.
      controller.ensureBoxIdsMapping(sessionId);
      controller.ensureBoxIdsMapping(sessionId);
    }
    expect(controller.trackedSessionCount()).toBe(0);
  });

  it('A-5: pruning an obsolete session never removes the CURRENT identity or forces a re-acquisition', async () => {
    const current = 'a5-current';
    const obsolete = 'a5-obsolete';
    await openIdentifiedSession(obsolete);
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});
    controller.ensureBoxIdsMapping(obsolete);
    await jest.advanceTimersByTimeAsync(20);
    await flushAsync();

    const liveClient = await openIdentifiedSession(current);
    controller.ensureBoxIdsMapping(current);
    await jest.advanceTimersByTimeAsync(20);
    await flushAsync();
    expect(liveClient.countOf(MSP_BOXIDS)).toBe(1);

    mspSessionCoordinator.deactivateMspSession(obsolete);
    await flushAsync();
    controller.ensureBoxIdsMapping(current); // prunes the obsolete entry

    // The current identity kept its cached mapping - no second request.
    expect(liveClient.countOf(MSP_BOXIDS)).toBe(1);
    expect(controller.trackedSessionCount()).toBe(1);
  });
});

describe('FcToolsController - outcome provenance and publication lifetime (A-1)', () => {
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

  /**
   * SENSORS B-5: provenance is proven on the DELEGATED path, because
   * that is the path Setup's calibration buttons now take. The board is
   * driven to a real completion so the published outcome is a genuine
   * observation rather than an acknowledgement.
   */
  async function runAcc(
    controller: FcToolsController,
    sessionId: string,
    client?: ReturnType<typeof makeFakeClient>,
  ) {
    expect(controller.requestConfirmation(sessionId, 'ACC_CALIBRATION')).toBe(true);
    const settled = controller.confirm();
    if (client === undefined) {
      await settleCalibration(9_000);
    } else {
      await driveAccCalibration(client);
    }
    return settled;
  }

  /** What a completed accelerometer run publishes. */
  const COMPLETED_ACC = {
    kind: 'CALIBRATION_OBSERVED',
    tool: 'ACC_CALIBRATION',
    outcome: {kind: 'SUCCEEDED'},
  };

  it('publishes with the captured composite origin and a monotonic sequence', async () => {
    const sessionId = 'a1-origin';
    const client = await openIdentifiedSession(sessionId);
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});
    const before = controller.getPublicationSequence();

    expect(await runAcc(controller, sessionId, client)).toMatchObject(COMPLETED_ACC);
    expect(controller.getPublicationSequence()).toBeGreaterThan(before);
    // Visible to a subscriber that mounted before publication...
    expect(controller.getVisibleOutcome(sessionId, before)).toMatchObject(COMPLETED_ACC);
    // ...and invisible to one that mounts after it.
    expect(controller.getVisibleOutcome(sessionId, controller.getPublicationSequence())).toBeUndefined();
  });

  it('an outcome is never visible to a DIFFERENT session', async () => {
    const sessionId = 'a1-other-session';
    const client = await openIdentifiedSession(sessionId);
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});
    const before = controller.getPublicationSequence();
    await runAcc(controller, sessionId, client);
    expect(controller.getVisibleOutcome('a-different-session', before)).toBeUndefined();
  });

  it('a TRANSIENT detach with no replacement keeps the observed result visible', async () => {
    const sessionId = 'a1-transient-detach';
    const client = await openIdentifiedSession(sessionId);
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});
    const before = controller.getPublicationSequence();
    await runAcc(controller, sessionId, client);

    mspSessionCoordinator.deactivateMspSession(sessionId);
    await flushAsync();

    expect(controller.getVisibleOutcome(sessionId, before)).toMatchObject(COMPLETED_ACC);
  });

  it('a REPLACEMENT generation revokes generation N\'s outcome immediately', async () => {
    const sessionId = 'a1-replacement';
    const client = await openIdentifiedSession(sessionId);
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});
    const before = controller.getPublicationSequence();
    await runAcc(controller, sessionId, client);
    expect(controller.getVisibleOutcome(sessionId, before)).toBeDefined();

    mspSessionCoordinator.deactivateMspSession(sessionId);
    await flushAsync();
    await openIdentifiedSession(sessionId); // generation N+1

    expect(controller.getVisibleOutcome(sessionId, before)).toBeUndefined();
  });

  it('an outcome settling AFTER a replacement became current cannot publish into it', async () => {
    const sessionId = 'a1-late-settle';
    const client = await openIdentifiedSession(sessionId, c => {
      c.onWrite(command => {
        if (command === MSP_ACC_CALIBRATION) {
          // The link dies and a replacement takes over before the
          // continuation that settles this action runs.
          mspSessionCoordinator.deactivateMspSession(sessionId);
        }
      });
    });
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});
    const before = controller.getPublicationSequence();
    await runAcc(controller, sessionId);
    expect(client.countOf(MSP_ACC_CALIBRATION)).toBe(1);

    await openIdentifiedSession(sessionId); // replacement becomes current
    expect(controller.getVisibleOutcome(sessionId, before)).toBeUndefined();
  });

  it('an epoch change AFTER the outcome revokes it, but the action\'s OWN desync does not', async () => {
    const sessionId = 'a1-epoch-revocation';
    const client = await openIdentifiedSession(sessionId, c => {
      c.hold(MSP_ACC_CALIBRATION); // times out -> the action's own desync
    });
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});
    const before = controller.getPublicationSequence();

    expect(controller.requestConfirmation(sessionId, 'ACC_CALIBRATION')).toBe(true);
    const settled = controller.confirm();
    await settleCalibration(3_000);
    const unconfirmedStart = {
      kind: 'CALIBRATION_OBSERVED',
      tool: 'ACC_CALIBRATION',
      outcome: {kind: 'START_NOT_OBSERVED'},
    };
    expect(await settled).toEqual(unconfirmedStart);
    expect(client.countOf(MSP_ACC_CALIBRATION)).toBe(1);

    // The action's own timeout bumped the epoch; its result stays visible.
    expect(controller.getVisibleOutcome(sessionId, before)).toEqual(unconfirmedStart);

    // A LATER epoch change (a new logical owner) revokes it.
    const live = mspSessionCoordinator.getActiveMspClient(sessionId);
    expect(live).toBeDefined();
    // An unanswered command times out -> MspClient's desync latch bumps
    // the epoch, i.e. a NEW logical owner for the same physical session.
    const timingOut = live!
      .request(0x2a, new Uint8Array(0), {wireFormat: 'v1', responseTimeoutMs: 5})
      .catch(() => undefined);
    await jest.advanceTimersByTimeAsync(50);
    await flushAsync();
    await timingOut;
    await flushAsync();
    expect(controller.getVisibleOutcome(sessionId, before)).toBeUndefined();
  });

  it('opening a new confirmation clears the previous publication', async () => {
    const sessionId = 'a1-new-confirmation';
    const client = await openIdentifiedSession(sessionId);
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});
    const before = controller.getPublicationSequence();
    await runAcc(controller, sessionId, client);
    expect(controller.getVisibleOutcome(sessionId, before)).toBeDefined();

    expect(controller.requestConfirmation(sessionId, 'REBOOT')).toBe(true);
    expect(controller.getVisibleOutcome(sessionId, before)).toBeUndefined();
    controller.cancel();
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
    await driveAccCalibration(first);
    await settled;
    expect(first.countOf(MSP_BOXIDS)).toBe(1);

    mspSessionCoordinator.deactivateMspSession(sessionId);
    await flushAsync();

    const second = await openIdentifiedSession(sessionId);
    controller.requestConfirmation(sessionId, 'ACC_CALIBRATION');
    const settled2 = controller.confirm();
    await driveAccCalibration(second);
    expect(await settled2).toMatchObject({
      kind: 'CALIBRATION_OBSERVED',
      tool: 'ACC_CALIBRATION',
      outcome: {kind: 'SUCCEEDED'},
    });
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

/**
 * The ACC-calibration repair pass. Everything above proves the transaction
 * MACHINERY; this block pins the accelerometer command itself down to the
 * bytes on the wire, because that is the part a hardware bug report is
 * about: which opcode left, with what payload, how many times, and what
 * the app is entitled to claim afterwards.
 */
describe('FcToolsController - the ACC calibration command on the wire', () => {
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

  /** Every frame this session actually handed to the transport, decoded
   * back from base64 - the only place the real bytes are observable. */
  function writtenFrames(client: ReturnType<typeof makeFakeClient>) {
    return client.writeBytes.mock.calls.map(call => base64ToBytes(call[1] as string));
  }

  async function pressCalibrate(
    controller: FcToolsController,
    sessionId: string,
    client: ReturnType<typeof makeFakeClient>,
  ) {
    expect(controller.requestConfirmation(sessionId, 'ACC_CALIBRATION')).toBe(true);
    const settled = controller.confirm();
    await driveAccCalibration(client);
    return settled;
  }

  it('sends opcode 205 with an EXACTLY empty payload - the parameterless MSP_ACC_CALIBRATION', async () => {
    const sessionId = 'acc-wire-opcode';
    const client = await openIdentifiedSession(sessionId);
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    await pressCalibrate(controller, sessionId, client);

    // The constant and the literal Betaflight opcode must agree; a rename
    // or a re-point of MSP_ACC_CALIBRATION would otherwise pass silently.
    expect(MSP_ACC_CALIBRATION).toBe(205);
    const accFrames = writtenFrames(client).filter(bytes => bytes[4] === 205);
    expect(accFrames).toHaveLength(1);
    // v1 frame: '$' 'M' '<' <len> <cmd> ...payload... <crc>. Betaflight's
    // msp.c takes "no param" literally, so len must be 0 and the frame
    // must be exactly 6 bytes with nothing between command and checksum.
    expect(accFrames[0][3]).toBe(0);
    expect(accFrames[0]).toHaveLength(6);
  });

  it('never sends MSP_EEPROM_WRITE (250) - the calibration persists FC-side on its own', async () => {
    const sessionId = 'acc-wire-no-eeprom';
    const client = await openIdentifiedSession(sessionId);
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    await pressCalibrate(controller, sessionId, client);

    expect(writtenFrames(client).map(bytes => bytes[4])).not.toContain(250);
  });

  it('dispatches EXACTLY ONE calibration per accepted press, and a duplicate press dispatches none', async () => {
    const sessionId = 'acc-wire-duplicate';
    const client = await openIdentifiedSession(sessionId);
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    // The press that is accepted.
    controller.requestConfirmation(sessionId, 'ACC_CALIBRATION');
    const first = controller.confirm();
    // Impatient taps, while the mutex is held by the run above: the
    // confirmation cannot reopen and confirm() has nothing to confirm.
    expect(controller.requestConfirmation(sessionId, 'ACC_CALIBRATION')).toBe(false);
    expect(await controller.confirm()).toBeNull();
    expect(controller.requestConfirmation(sessionId, 'ACC_CALIBRATION')).toBe(false);

    await driveAccCalibration(client);
    expect(await first).toMatchObject({
      kind: 'CALIBRATION_OBSERVED',
      tool: 'ACC_CALIBRATION',
      outcome: {kind: 'SUCCEEDED'},
    });
    expect(client.countOf(MSP_ACC_CALIBRATION)).toBe(1);
  });

  it('starts NO new periodic poll while the calibration is in flight, and polling resumes afterwards', async () => {
    const sessionId = 'acc-wire-poll-pause';
    // Held: the FC never answers, so the calibration genuinely stays in
    // flight across several 220ms attitude intervals - the only way to
    // observe the pause rather than assert it.
    const client = await openIdentifiedSession(sessionId, c => {
      c.hold(MSP_ACC_CALIBRATION);
    });
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    let attitudeAtDispatch = -1;
    client.onWrite(command => {
      if (command === MSP_ACC_CALIBRATION) {
        attitudeAtDispatch = client.countOf(MSP_ATTITUDE);
      }
    });

    controller.requestConfirmation(sessionId, 'ACC_CALIBRATION');
    const settled = controller.confirm();
    // Well past several attitude intervals, but short of the 2000ms
    // response timeout: the calibration is still outstanding here.
    await jest.advanceTimersByTimeAsync(1000);
    await flushAsync();
    expect(attitudeAtDispatch).toBeGreaterThanOrEqual(0); // it really was dispatched
    expect(client.countOf(MSP_ATTITUDE)).toBe(attitudeAtDispatch);

    await settleCalibration(2_000);
    /* No answer ever came, so the honest outcome is an unconfirmed START
       - and the pause must be released on that path exactly as on the
       happy one. */
    expect(await settled).toEqual({
      kind: 'CALIBRATION_OBSERVED',
      tool: 'ACC_CALIBRATION',
      outcome: {kind: 'START_NOT_OBSERVED'},
    });

    const attitudeAfterSettle = client.countOf(MSP_ATTITUDE);
    await jest.advanceTimersByTimeAsync(700);
    await flushAsync();
    // The attitude poll is alive again - exactly what the Orientation
    // view depends on once a calibration finishes.
    expect(client.countOf(MSP_ATTITUDE)).toBeGreaterThan(attitudeAfterSettle);
  });

  /**
   * SENSORS B-5 §44 AT THE CONTROLLER LEVEL. msp.c acks
   * MSP_ACC_CALIBRATION on receipt - even in states where it starts
   * nothing - so an acknowledgement was never a result. It used to be
   * reported as ACCEPTED, which was truthful but useless; it is now the
   * first thing that happens inside an observation that runs until the
   * board's own flags say the calibration ended.
   */
  it('an ack alone settles NOTHING - the run stays in flight until the board says it ended', async () => {
    const sessionId = 'acc-wire-ack-meaning';
    const client = await openIdentifiedSession(sessionId);
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    expect(controller.requestConfirmation(sessionId, 'ACC_CALIBRATION')).toBe(true);
    const settled = controller.confirm();

    // Acknowledged, and the board is still calibrating.
    await settleCalibration(500);
    expect(client.countOf(MSP_ACC_CALIBRATION)).toBe(1);
    client.setResponse(MSP_STATUS_EX, statusExPayload({blockerMask: CALIBRATING_BLOCKER}));
    await settleCalibration(2_000);
    expect(controller.getPhase()).toEqual({
      kind: 'RUNNING',
      tool: 'ACC_CALIBRATION',
      sessionId,
    });
    expect(controller.getLastOutcome()).toBeUndefined();

    // Only the falling edge ends it, and only then is there a result.
    client.setResponse(MSP_STATUS_EX, statusExPayload());
    await settleCalibration(750);
    const outcome = await settled;
    expect(outcome).toMatchObject({
      kind: 'CALIBRATION_OBSERVED',
      tool: 'ACC_CALIBRATION',
      outcome: {kind: 'SUCCEEDED', evidence: {observedCalibratingEdge: true}},
    });
    // The old ACCEPTED shape is gone from this path entirely.
    expect(outcome?.kind).not.toBe('ACCEPTED');
  });

  it('a cancel while the board is still calibrating hands the tool back at once, and claims nothing about the board', async () => {
    const sessionId = 'acc-wire-cancel';
    const client = await openIdentifiedSession(sessionId);
    const controller = new FcToolsController({appStateOwner: makeOwner().owner});

    expect(controller.requestConfirmation(sessionId, 'ACC_CALIBRATION')).toBe(true);
    const settled = controller.confirm();
    await settleCalibration(500);
    client.setResponse(MSP_STATUS_EX, statusExPayload({blockerMask: CALIBRATING_BLOCKER}));
    await settleCalibration(750);

    /* The firmware has no command that ends a calibration, so cancelling
       stops the WATCHING and nothing else. The mutex comes back
       synchronously - waiting for the watcher's next poll to notice would
       make "cancel" a request rather than a guarantee. */
    controller.cancel();
    expect(controller.getPhase()).toEqual({kind: 'IDLE'});
    expect(controller.getLastOutcome()).toEqual({
      kind: 'CALIBRATION_OBSERVED',
      tool: 'ACC_CALIBRATION',
      outcome: {kind: 'OBSERVATION_CANCELLED', boardMayStillBeCalibrating: true},
    });

    // The board "finishes" later; nothing may rewrite the settled answer.
    client.setResponse(MSP_STATUS_EX, statusExPayload());
    await settleCalibration(1_000);
    await settled;
    expect(controller.getLastOutcome()).toEqual({
      kind: 'CALIBRATION_OBSERVED',
      tool: 'ACC_CALIBRATION',
      outcome: {kind: 'OBSERVATION_CANCELLED', boardMayStillBeCalibrating: true},
    });
    expect(client.countOf(MSP_ACC_CALIBRATION)).toBe(1); // never resent
  });
});
