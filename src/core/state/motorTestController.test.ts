/**
 * Phase 2D - adversarial tests for the unreachable motor-test controller.
 *
 * NO HARDWARE OF ANY KIND is required, referenced or simulated: no flight
 * controller, no USB, no serial session, no ESC, no motor, no LiPo, no
 * emulator, no device. The only fake below the controller is the
 * repository's existing FakeMspTransport; every byte above it travels the
 * REAL MspClient, the REAL FIFO, the REAL MotorTestLease, the REAL
 * BOX-ID / facts / capability / observation / restriction modules, the
 * REAL Phase 2C MotorTestTelemetryRegistry and the REAL reducer.
 *
 * NOTHING IS REIMPLEMENTED HERE. The narrow fakes are exactly two:
 *  - a session port (client reference, physical and firmware identity
 *    reads, and lifecycle subscriptions) - a read-only dependency;
 *  - a telemetry scheduler stand-in implementing exactly the two methods
 *    the barrier is allowed to call.
 * Neither can mint a lease, an authority or a receipt.
 *
 * The forbidden motor command appears in no fixture - only as a value the
 * containment assertions at the end of this file prove absent.
 */

/**
 * JEST-ONLY MODULE REPLACEMENT for the armed-state-evidence reader.
 *
 * The pulse/stop/timeout/race/receipt/authority coverage below is about
 * the ENGINE, and a live observation loop competing for the fake link
 * would make every request-sequence assertion here a test of scheduling
 * instead. So this file replaces THE MODULE inside Jest's own registry -
 * it adds no production seam, flag, option or environment branch. The
 * replacement exists only here; no production file can import or reach it,
 * and a source-boundary test in motorTestContinuousSafetyMonitor.test.ts
 * proves that.
 *
 * The default is FRESH_DISARMED so the accepted engine paths stay
 * genuinely exercised. Individual tests below set it to FC_ARMED or
 * UNKNOWN_OR_STALE to prove the fail-closed behaviour at the controller
 * level. The REAL (unmocked) decision path is proven in
 * motorTestSafetyMonitor.test.ts, in the end-to-end bench-gate suite in
 * motorTestBenchGate.test.ts, and in the production-binding regression
 * test in motorTestSessionBinding.test.ts.
 */
let mockArmedStateEvidence: 'FRESH_DISARMED' | 'FC_ARMED' | 'UNKNOWN_OR_STALE' =
  'FRESH_DISARMED';

jest.mock('./motorTestContinuousSafetyMonitor', () => ({
  readMotorArmedStateEvidence: () => mockArmedStateEvidence,
}));

beforeEach(() => {
  mockArmedStateEvidence = 'FRESH_DISARMED';
});

import {readFileSync} from 'fs';
import {join} from 'path';

import {
  applyMotorTestEffects,
  classifyArmedStateObservationFailure,
  classifyBoxIdsFailure,
  classifyLeaseFailure,
  createMotorTestController,
  EMPTY_MOTOR_TEST_EFFECT_RECORD,
  MOTOR_TEST_CONTROLLER_STOP_TRIGGERS,
  MOTOR_TEST_HOLD_HEARTBEAT_TIMEOUT_MILLIS,
  type MotorTestController,
  type MotorTestControllerSessionPort,
  type MotorTestControllerSnapshot,
  type MotorTestFirmwareIdentificationState,
  type MotorTestPulseRequestResult,
  type MotorTestSessionInvalidationReason,
} from './motorTestController';
import * as controllerModule from './motorTestController';
import {
  MotorTestTelemetryRegistry,
  MotorTestTelemetrySession,
  type MotorTestBarrierScheduler,
} from '../protocol/telemetry/motorTestTelemetryBarrier';
import type {
  TelemetryPauseLease,
  TelemetryPauseReason,
} from '../protocol/telemetry/telemetryTypes';
import {MspClient} from '../protocol/mspClient';
import {
  MOTOR_DEPARTURE_BOUND_MILLIS,
  evaluateMotorDeparture,
} from './motorDepartureGate';
import {isMotorTestSnapshotActive} from '../../platforms/react-native/protocol/motorTestCapability';
import {
  acquireMotorTestLease,
  type MspSessionCompositeIdentity,
} from '../protocol/motorTestLease';
import {
  createMotorTestState,
  motorTestTransition,
  MOTOR_TEST_STOP_UNCONFIRMED_WARNING,
  type MotorTestEffect,
} from './motorTestStateMachine';
import {ARMING_DISABLE_FLAGS_COUNT} from './armingBlockers';
import {FEATURE_3D_BIT} from '../protocol/msp/decoding/decodeFeatureConfig';
import {ARMING_DISABLED_MSP_BIT_INDEX} from './motorArmingRestriction';
import {FakeMspTransport} from '../protocol/__testUtils__/mspFakeTransport';
import {buildMspFrameBytes} from '../protocol/__testUtils__/mspFixtures';
import {betaflightApi147Identity} from '../protocol/__testUtils__/motorFirmwareFixtures';
import {
  MSP_ADVANCED_CONFIG,
  MSP_API_VERSION,
  MSP_BATTERY_STATE,
  MSP_BOARD_INFO,
  MSP_BOXIDS,
  MSP_FC_VARIANT,
  MSP_FC_VERSION,
  MSP_FEATURE_CONFIG,
  MSP_MIXER_CONFIG,
  MSP_MOTOR,
  MSP_MOTOR_CONFIG,
  MSP_MOTOR_TELEMETRY,
  MSP_STATUS_EX,
  MSP2_SEND_DSHOT_COMMAND,
} from '../protocol/msp/commands/mspCommands';

const EMPTY = new Uint8Array(0);
const PHYSICAL_GENERATION = 7;

/** The one command the accepted restriction module sends. Named here only
 * so the fixture can answer it; this file builds no motor command. */
const MSP_SET_ARMING_DISABLED_FIXTURE = 99;
/** MSP_MOTOR_3D_CONFIG - deadband 1406/1514, neutral 1460, LE u16 x3. */
const MSP_MOTOR_3D_CONFIG_FIXTURE = 124;
const MOTOR_3D_CONFIG_PAYLOAD = Uint8Array.from([126, 5, 234, 5, 180, 5]);

/** Phase 2F: the stop command the controller now dispatches during
 * teardown. A real FC acknowledges it, so the fixture does too. */
const MSP_SET_MOTOR_FIXTURE = 214;
/** The only payload this package may ever put on the wire for it. */
const EXPECTED_STOP_PAYLOAD = [0xe8, 0x03, 0xe8, 0x03, 0xe8, 0x03, 0xe8, 0x03];

/* ------------------------------------------------------------------ *
 * Byte helpers - arithmetic, never bitwise, so a high bit survives
 * ------------------------------------------------------------------ */

function u16(value: number): number[] {
  return [value % 256, Math.floor(value / 256) % 256];
}

function u32(value: number): number[] {
  return [
    value % 256,
    Math.floor(value / 256) % 256,
    Math.floor(value / 65536) % 256,
    Math.floor(value / 16777216) % 256,
  ];
}

function ascii(text: string): number[] {
  return Array.from(text, character => character.charCodeAt(0));
}

/** Betaflight's sbufWritePString(): one length byte, then the bytes. */
function pstring(text: string): number[] {
  return [text.length, ...ascii(text)];
}

/* ------------------------------------------------------------------ *
 * The supported-profile fixture
 * (SpeedyBee F405 V4 @ Betaflight 2025.12.2, MSP API 1.47)
 * ------------------------------------------------------------------ */

const API_VERSION_PAYLOAD = Uint8Array.from([0, 1, 47]);
const FC_VARIANT_PAYLOAD = Uint8Array.from(ascii('BTFL'));

function boardInfoPayload(targetName = 'SPEEDYBEEF405V4'): Uint8Array {
  return Uint8Array.from([
    ...ascii('S405'),
    ...u16(0),
    0,
    0,
    ...pstring(targetName),
    ...pstring('SpeedyBee F405 V4'),
    ...pstring('SPBE'),
    ...new Array<number>(32).fill(0),
    1,
    2,
  ]);
}

function fcVersionPayload(text = '2025.12.2'): Uint8Array {
  return Uint8Array.from([25, 12, 2, text.length, ...ascii(text)]);
}

function mixerConfigPayload(mixerModeRaw = 3): Uint8Array {
  return Uint8Array.from([mixerModeRaw, 1]);
}

function motorConfigPayload(
  motorCount = 4,
  dshotTelemetryRaw = 0,
  escSensorRaw = 0,
): Uint8Array {
  return Uint8Array.from([
    ...u16(0),
    ...u16(2000),
    ...u16(1000),
    motorCount,
    14,
    dshotTelemetryRaw,
    escSensorRaw,
  ]);
}

function advancedConfigPayload(motorProtocolRaw = 7): Uint8Array {
  return Uint8Array.from([
    1,
    1,
    0,
    motorProtocolRaw,
    ...u16(480),
    ...u16(550),
    0,
    0,
    0,
    0,
    0,
    ...u16(125),
    ...u16(0),
    0,
    0,
    0,
  ]);
}

const FEATURE_CONFIG_PAYLOAD = Uint8Array.from(u32(0));

/** BOXARM's permanent id is 0; placed at index 2 so a hardcoded bit-0
 * assumption would be caught. */
const BOX_IDS_PAYLOAD = Uint8Array.from([5, 1, 0, 13]);
const ARM_BIT = 2;

interface StatusFixture {
  readonly armed?: boolean;
  readonly mspRestrictionPresent?: boolean;
}

/** MSP_STATUS_EX per msp.c:1094-1143 @ the pinned tag. */
function statusPayload(fixture: StatusFixture = {}): Uint8Array {
  const armedBits = fixture.armed === true ? Math.pow(2, ARM_BIT) : 0;
  const mask =
    fixture.mspRestrictionPresent === false
      ? 0
      : Math.pow(2, ARMING_DISABLED_MSP_BIT_INDEX);
  return Uint8Array.from([
    ...u16(125),
    ...u16(0),
    ...u16(0x21),
    ...u32(armedBits),
    2,
    ...u16(15),
    // --- 13-byte fixed prefix ends ---
    4,
    1,
    0,
    ARMING_DISABLE_FLAGS_COUNT,
    ...u32(mask),
    0,
    ...u16(3400),
    6,
  ]);
}

/** cellCount 4, 15.80 V, BATTERY_OK - inside the accepted policy band. */
function batteryPayload(cellCount = 4, voltageCentivolts = 1580): Uint8Array {
  return Uint8Array.from([
    cellCount,
    ...u16(1500),
    15,
    ...u16(0),
    ...u16(0),
    0,
    ...u16(voltageCentivolts),
  ]);
}

/* ------------------------------------------------------------------ *
 * The scripted flight controller
 * ------------------------------------------------------------------ */

type ScriptedReply =
  | {readonly kind: 'RESPONSE'; readonly payload: Uint8Array}
  | {readonly kind: 'ERROR'};

function reply(payload: Uint8Array): ScriptedReply {
  return {kind: 'RESPONSE', payload};
}

const REJECT: ScriptedReply = {kind: 'ERROR'};

function supportedScript(): Map<number, ScriptedReply> {
  return new Map<number, ScriptedReply>([
    [MSP_API_VERSION, reply(API_VERSION_PAYLOAD)],
    [MSP_FC_VARIANT, reply(FC_VARIANT_PAYLOAD)],
    [MSP_BOARD_INFO, reply(boardInfoPayload())],
    [MSP_FC_VERSION, reply(fcVersionPayload())],
    [MSP_MIXER_CONFIG, reply(mixerConfigPayload())],
    [MSP_MOTOR_CONFIG, reply(motorConfigPayload())],
    [MSP_ADVANCED_CONFIG, reply(advancedConfigPayload())],
    [MSP_FEATURE_CONFIG, reply(FEATURE_CONFIG_PAYLOAD)],
    [MSP_BOXIDS, reply(BOX_IDS_PAYLOAD)],
    [MSP_STATUS_EX, reply(statusPayload())],
    [MSP_BATTERY_STATE, reply(batteryPayload())],
    [MSP_SET_ARMING_DISABLED_FIXTURE, reply(EMPTY)],
    [MSP_SET_MOTOR_FIXTURE, reply(EMPTY)],
    // P2 closure: FEATURE_3D sessions read the real 3D config bytes.
    [MSP_MOTOR_3D_CONFIG_FIXTURE, reply(MOTOR_3D_CONFIG_PAYLOAD)],
  ]);
}

/** Byte 4 of a v1 request frame is the command. */

/**
 * P2-ii - WIRE-FORMAT-AWARE REQUEST PARSING AND REPLIES.
 *
 * The harness used to read only the v1 layout (`data[4]` as the command)
 * and answer EVERYTHING in v1. A real MSPv2 request - the engine's
 * supplemental DSHOT stop - was therefore misparsed, answered with a v1
 * error the real client rightly never matches to a v2 request, and the
 * FIFO wedged behind it forever. The pinned API 1.47 firmware speaks
 * MSPv2, so answering a v2 request in v2 is CORRECT simulation, not a
 * test convenience. The client is deliberately left strict.
 */
interface ParsedHarnessWrite {
  readonly wireFormat: 'v1' | 'v2';
  readonly command: number;
  readonly payload: number[];
}

function parseHarnessWrite(data: Uint8Array): ParsedHarnessWrite {
  if (data[1] === 0x58 /* 'X' - v2 native */) {
    const command = data[4] | (data[5] << 8);
    const length = data[6] | (data[7] << 8);
    return {
      wireFormat: 'v2',
      command,
      payload: Array.from(data.subarray(8, 8 + length)),
    };
  }
  return {
    wireFormat: 'v1',
    command: data[4],
    payload: Array.from(data.subarray(5, 5 + data[3])),
  };
}

/** A reply in the SAME wire format the request used. */
const replyFrame = (
  write: ParsedHarnessWrite,
  payload: Uint8Array,
): Uint8Array =>
  buildMspFrameBytes(write.command, payload, {
    wireFormat: write.wireFormat,
    direction: 'response',
  });

const errorReplyFrame = (write: ParsedHarnessWrite): Uint8Array =>
  buildMspFrameBytes(write.command, EMPTY, {
    wireFormat: write.wireFormat,
    direction: 'error',
  });

function writtenCommand(data: Uint8Array): number {
  return data[4];
}

function writtenV2Command(data: Uint8Array): number {
  expect(Array.from(data.subarray(0, 3))).toEqual([0x24, 0x58, 0x3c]);
  return data[4] + data[5] * 256;
}

function writtenV2Payload(data: Uint8Array): number[] {
  const payloadLength = data[6] + data[7] * 256;
  return Array.from(data.subarray(8, 8 + payloadLength));
}

function responseFrame(command: number, payload: Uint8Array): Uint8Array {
  return buildMspFrameBytes(command, payload, {
    wireFormat: 'v1',
    direction: 'response',
  });
}

function errorFrame(command: number): Uint8Array {
  return buildMspFrameBytes(command, EMPTY, {
    wireFormat: 'v1',
    direction: 'error',
  });
}

function v2ResponseFrame(
  command: number,
  direction: 'response' | 'error' = 'response',
): Uint8Array {
  return buildMspFrameBytes(command, EMPTY, {
    wireFormat: 'v2',
    direction,
  });
}

async function flush(times = 6): Promise<void> {
  for (let index = 0; index < times; index++) {
    await Promise.resolve();
  }
}

/* ------------------------------------------------------------------ *
 * Narrow fakes
 * ------------------------------------------------------------------ */

/**
 * Exactly the two methods the barrier may call. It cannot dispatch,
 * decode, read a value or reach a client through this interface.
 * `holdIdle()` represents work that has been dispatched and has not yet
 * settled - the only thing `waitUntilIdle()` reports.
 */
class RecordingScheduler implements MotorTestBarrierScheduler {
  readonly leases: {reason: TelemetryPauseReason; released: boolean}[] = [];
  /** Invoked when a MOTOR_TEST lease is released, so a test can observe
   * WHEN telemetry was allowed to resume. */
  onMotorTestRelease: (() => void) | undefined;

  private busy = false;
  private waiters: (() => void)[] = [];

  acquirePauseLease(reason: TelemetryPauseReason): TelemetryPauseLease {
    const record = {reason, released: false};
    this.leases.push(record);
    return {
      id: `${reason}-${this.leases.length}`,
      release: () => {
        record.released = true;
        if (reason === 'MOTOR_TEST') {
          this.onMotorTestRelease?.();
        }
      },
    };
  }

  waitUntilIdle(): Promise<void> {
    if (!this.busy) {
      return Promise.resolve();
    }
    return new Promise<void>(resolve => {
      this.waiters.push(resolve);
    });
  }

  holdIdle(): void {
    this.busy = true;
  }

  releaseIdle(): void {
    this.busy = false;
    const pending = this.waiters;
    this.waiters = [];
    for (const resolve of pending) {
      resolve();
    }
  }

  get activeMotorTestLeaseCount(): number {
    return this.leases.filter(
      lease => lease.reason === 'MOTOR_TEST' && !lease.released,
    ).length;
  }
}

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

interface Harness {
  /** The controlled safety-monitor stand-in injected into the controller.
   * `reportUnsafe` fires the very callback the real monitor calls. */
  safetyMonitor: {
    readonly started: number;
    readonly stopped: number;
    readonly observeNowCalls: number;
    readonly running: boolean;
    readonly firstObservationHeld: boolean;
    releaseFirstObservation(): void;
    requesterIsLease(): boolean;
    reportUnsafe(reason: string): void;
  };
  readonly transport: FakeMspTransport;
  /** The client the session port exposes - the one the controller would
   * lease and send every evidence request through. */
  readonly client: MspClient;
  /** The client the telemetry anchor was actually minted for. Equal to
   * `client` in a coherent composition, and deliberately different in the
   * A/B mismatch fixture. */
  readonly telemetryOwner: MspClient;
  readonly scheduler: RecordingScheduler;
  readonly controller: MotorTestController;
  readonly script: Map<number, ScriptedReply>;
  readonly commands: number[];
  /** Phase 2F: the exact payload bytes written per command, in order. */
  readonly writes: {command: number; payload: number[]}[];
  /** Runs just before the reply for the named command is emitted. */
  beforeReply: ((command: number) => void) | undefined;
  identity: MspSessionCompositeIdentity | undefined;
  /** Makes the narrow identity read THROW, which is a different fact from
   * "there is no identity" and must not be reported as one. */
  failIdentityReads(): void;
  setFirmwareIdentification(
    state: MotorTestFirmwareIdentificationState,
  ): void;
  firmwareIdentificationListenerCount(): number;
  invalidate(reason: MotorTestSessionInvalidationReason): void;
  invalidationListenerCount(): number;
}

interface HarnessOptions {
  /**
   * Correction B-1 fixture. `'FOREIGN'` mints the telemetry anchor for a
   * SECOND, genuinely different `MspClient` while the session port keeps
   * exposing the first one. Both clients report structurally equal
   * composite identities (a fresh client always starts at epoch 0), so
   * only a reference comparison can tell them apart.
   */
  readonly telemetryClient?: 'MATCHING' | 'FOREIGN';
  /** An anchor this registry never minted, for the forged-session case. */
  readonly telemetrySession?: MotorTestTelemetrySession;
  /** Makes the monitor stand-in's first `observeNow()` hang until
   * `releaseFirstObservation()` is called. */
  readonly holdFirstObservation?: boolean;
  readonly firmwareIdentification?: MotorTestFirmwareIdentificationState;
  /** Simulates a provider publishing from inside subscribe(). */
  readonly firmwareIdentificationOnSubscribe?:
    MotorTestFirmwareIdentificationState;
}

function createHarness(
  overrides: ReadonlyArray<readonly [number, ScriptedReply]> = [],
  options: HarnessOptions = {},
): Harness {
  const transport = new FakeMspTransport();
  const client = new MspClient(transport, 'motor-test-controller-session');
  const registry = new MotorTestTelemetryRegistry();
  // The anchor belongs to exactly one client. In the FOREIGN fixture that
  // client is NOT the one the controller will lease.
  const telemetryOwner =
    options.telemetryClient === 'FOREIGN'
      ? new MspClient(new FakeMspTransport(), 'motor-test-foreign-session')
      : client;
  const telemetrySession =
    options.telemetrySession ?? registry.openSession(telemetryOwner);
  const scheduler = new RecordingScheduler();
  registry.registerScheduler(telemetrySession, scheduler);

  const script = supportedScript();
  for (const [command, scripted] of overrides) {
    script.set(command, scripted);
  }

  const listeners = new Set<
    (reason: MotorTestSessionInvalidationReason) => void
  >();
  const firmwareListeners = new Set<() => void>();
  const state: {
    identity: MspSessionCompositeIdentity | undefined;
    throwOnRead: boolean;
    firmwareIdentification: MotorTestFirmwareIdentificationState;
  } = {
    identity: {physicalGeneration: PHYSICAL_GENERATION, mspEpoch: 0},
    throwOnRead: false,
    firmwareIdentification:
      options.firmwareIdentification ?? {
        status: 'SUCCEEDED',
        identity: betaflightApi147Identity(),
      },
  };

  const session: MotorTestControllerSessionPort = {
    client,
    // A FRESH object every call, deliberately: composite identity must be
    // compared BY VALUE, never by reference.
    readCurrentIdentity: () => {
      if (state.throwOnRead) {
        throw new Error('identity provider exploded');
      }
      return state.identity === undefined
        ? undefined
        : {
            physicalGeneration: state.identity.physicalGeneration,
            mspEpoch: state.identity.mspEpoch,
          };
    },
    readFirmwareIdentification: () => state.firmwareIdentification,
    subscribeFirmwareIdentification: listener => {
      firmwareListeners.add(listener);
      if (options.firmwareIdentificationOnSubscribe !== undefined) {
        state.firmwareIdentification =
          options.firmwareIdentificationOnSubscribe;
        listener();
      }
      return () => {
        firmwareListeners.delete(listener);
      };
    },
    subscribeSessionInvalidated: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  let monotonic = 1_000;

  /**
   * A CONTROLLED stand-in for the dedicated safety monitor.
   *
   * The real monitor runs a live observation loop on the lease. These
   * suites are about the PULSE ENGINE, and a second reader competing for
   * the fake link would make every request-sequence assertion here a test
   * of scheduling rather than of the engine. The real loop has its own
   * dedicated coverage in motorTestSafetyMonitor.test.ts, the whole
   * production path end to end in motorTestBenchGate.test.ts, and the
   * controller's reaction to an unsafe reading is exercised through
   * `safetyMonitor.reportUnsafe(...)` below - the same callback the real
   * monitor invokes.
   *
   * It never fabricates the GATE: the controller still asks
   * readMotorArmedStateEvidence(), which this file mocks explicitly.
   *
   * `holdFirstObservation` makes `observeNow()` hang until released, which
   * is how the setup boundary is proven: nothing may publish READY while
   * the first observation is still outstanding.
   */
  let monitorRunning = false;
  let onUnsafeCallback: ((reason: string) => void) | undefined;
  let monitorRequester: unknown;
  let releaseObservation: (() => void) | undefined;
  const safetyMonitor = {
    started: 0,
    stopped: 0,
    observeNowCalls: 0,
    get running() {
      return monitorRunning;
    },
    get firstObservationHeld() {
      return releaseObservation !== undefined;
    },
    releaseFirstObservation() {
      const release = releaseObservation;
      releaseObservation = undefined;
      release?.();
    },
    /** Reference identity: the monitor must be handed THE lease, not a
     * second requester built beside it. */
    requesterIsLease() {
      return (
        monitorRequester !== undefined &&
        typeof (monitorRequester as {request?: unknown}).request ===
          'function' &&
        typeof (monitorRequester as {isActive?: unknown}).isActive ===
          'function' &&
        typeof (monitorRequester as {emergencyStop?: unknown})
          .emergencyStop === 'function'
      );
    },
    reportUnsafe(reason: string) {
      onUnsafeCallback?.(reason);
    },
  };

  const controller = createMotorTestController({
    session,
    telemetryRegistry: registry,
    telemetrySession,
    readMonotonicMillis: () => {
      monotonic += 5;
      return monotonic;
    },
    createSafetyMonitor: monitorOptions => {
      onUnsafeCallback = monitorOptions.onUnsafe as (reason: string) => void;
      monitorRequester = monitorOptions.requester;
      return {
        start: () => {
          monitorRunning = true;
          safetyMonitor.started += 1;
        },
        stop: () => {
          monitorRunning = false;
          safetyMonitor.stopped += 1;
        },
        observeNow: () => {
          safetyMonitor.observeNowCalls += 1;
          if (options.holdFirstObservation !== true) {
            return Promise.resolve();
          }
          return new Promise<void>(resolve => {
            releaseObservation = resolve;
          });
        },
        snapshot: () => ({
          status: monitorRunning
            ? ({
                kind: 'SATISFIED' as const,
                observedAtMonotonicMillis: monotonic,
                sessionIdentity: {physicalGeneration: 0, mspEpoch: 0},
              })
            : ({kind: 'NEVER_OBSERVED' as const}),
          running: monitorRunning,
          completedObservations: monitorRunning ? 1 : 0,
        }),
        isFreshlySatisfied: () => monitorRunning,
      };
    },
  });

  return {
    safetyMonitor,
    transport,
    client,
    telemetryOwner,
    scheduler,
    controller,
    script,
    commands: [],
    writes: [],
    beforeReply: undefined,
    get identity() {
      return state.identity;
    },
    set identity(next: MspSessionCompositeIdentity | undefined) {
      state.identity = next;
    },
    failIdentityReads: () => {
      state.throwOnRead = true;
    },
    setFirmwareIdentification: next => {
      state.firmwareIdentification = next;
      for (const listener of Array.from(firmwareListeners)) {
        listener();
      }
    },
    firmwareIdentificationListenerCount: () => firmwareListeners.size,
    invalidate: reason => {
      for (const listener of Array.from(listeners)) {
        listener(reason);
      }
    },
    invalidationListenerCount: () => listeners.size,
  };
}

/** Serves the oldest pending transport write, if any. */
async function serveOne(harness: Harness): Promise<boolean> {
  if (harness.transport.writes.length === 0) {
    return false;
  }
  const data = harness.transport.writes[0].data;
  const write = parseHarnessWrite(data);
  const command = write.command;
  harness.commands.push(command);
  harness.writes.push({command, payload: write.payload});
  harness.transport.resolveNextWrite();
  await flush();
  harness.beforeReply?.(command);
  const scripted = harness.script.get(command) ?? REJECT;
  // The reply travels the SAME wire format as the request - a v1 error
  // for a v2 request would never match and would wedge the FIFO.
  harness.transport.emitData(
    scripted.kind === 'RESPONSE'
      ? replyFrame(write, scripted.payload)
      : errorReplyFrame(write),
  );
  await flush();
  return true;
}

/**
 * Drives a controller operation to completion by serving whatever the
 * REAL client actually writes. Bounded, and it terminates naturally as
 * soon as the operation settles.
 */
async function drive<T>(harness: Harness, operation: Promise<T>): Promise<T> {
  let settled = false;
  const observed = operation.then(value => {
    settled = true;
    return value;
  });
  for (let step = 0; step < 400 && !settled; step++) {
    await flush(3);
    if (settled) {
      break;
    }
    await serveOne(harness);
  }
  return observed;
}

function runSetup(harness: Harness): Promise<MotorTestControllerSnapshot> {
  return drive(harness, harness.controller.initializeSession());
}

/**
 * Serves transport writes until `until()` holds, or the bound is reached.
 *
 * Used where the operation must NOT be awaited - the whole point is to
 * observe the controller mid-setup, while it is deliberately parked on the
 * first observation.
 */
async function drivePending(
  harness: Harness,
  until: () => boolean,
): Promise<void> {
  for (let step = 0; step < 400 && !until(); step++) {
    await flush(3);
    if (until()) {
      return;
    }
    await serveOne(harness);
  }
}

/* ------------------------------------------------------------------ *
 * The happy path
 * ------------------------------------------------------------------ */

describe('MotorTestController - supported profile', () => {
  it('reaches Ready through the real accepted contracts', async () => {
    const harness = createHarness();
    const snapshot = await runSetup(harness);

    expect(snapshot.outcome).toEqual({kind: 'READY'});
    expect(snapshot.setupStep).toBe('READY');
    expect(snapshot.phase).toBe('ACTIVE');
    expect(snapshot.machine?.name).toBe('Ready');
    expect(snapshot.motorScope).toEqual({
      motorCount: 4,
      motorProtocolRaw: 7,
      feature3dEnabled: false,
    });
    expect(snapshot.telemetryHeld).toBe(true);
    // READY is published only with a fresh disarmed observation already in
    // hand, so the gate is open on the very snapshot setup returns.
    expect(snapshot.activation.allowed).toBe(true);
  });

  it('sends every accepted read exactly once, in the required order', async () => {
    const harness = createHarness();
    await runSetup(harness);

    // FOUR READS, AND NOT ONE MORE. The whole simplified chain is three
    // configuration reads plus the box mapping. The safety monitor's own
    // MSP_STATUS_EX does not appear here because this suite injects a
    // controlled monitor stand-in; the real read is proven end to end in
    // motorTestBenchGate.test.ts.
    // REWRITTEN IN P2-ii. The final assertion used to be "command 99 is
    // not in the bundle any more, at all". P2-ii restores the FC-side
    // arming restriction, so that statement is no longer true and could
    // only have been deleted. The EXACTNESS this test exists for is kept:
    // the enable path sends this list and nothing else, in this order.
    expect(harness.commands).toEqual([
      // (7) only what the encoder needs
      MSP_MOTOR_CONFIG,
      MSP_ADVANCED_CONFIG,
      MSP_FEATURE_CONFIG,
      // (8) only what armed state needs
      MSP_BOXIDS,
      // (10b) P2-ii: the restriction, plus its own verification re-read.
      MSP_SET_ARMING_DISABLED_FIXTURE,
      MSP_STATUS_EX,
    ]);
    // MSP_BOXIDS keeps its at-most-once guarantee.
    expect(
      harness.commands.filter(command => command === MSP_BOXIDS),
    ).toHaveLength(1);
    // The restriction is established exactly once, never repeatedly.
    expect(
      harness.commands.filter(
        command => command === MSP_SET_ARMING_DISABLED_FIXTURE,
      ),
    ).toHaveLength(1);
  });

  it('writes no motor command while the session is being prepared', async () => {
    const harness = createHarness();
    await runSetup(harness);
    // Setup itself never commands a motor: the only command-214 traffic in
    // this package is the teardown all-stop, which has not run yet.
    expect(harness.commands).not.toContain(MSP_SET_MOTOR_FIXTURE);
  });

  it('proves telemetry quiescence before it takes exclusive ownership', async () => {
    const harness = createHarness();
    // Work is dispatched and unsettled: quiescence cannot be proven.
    harness.scheduler.holdIdle();
    const pending = harness.controller.initializeSession();
    await flush(20);

    // Paused already...
    expect(harness.scheduler.activeMotorTestLeaseCount).toBe(1);
    // ...but no lease and no request, because idleness is unproven.
    expect(harness.transport.writes).toHaveLength(0);
    const contender = acquireMotorTestLease({
      client: harness.client,
      requestedIdentity: {physicalGeneration: PHYSICAL_GENERATION, mspEpoch: 0},
      readCurrentIdentity: () => ({
        physicalGeneration: PHYSICAL_GENERATION,
        mspEpoch: 0,
      }),
    });
    expect(contender.kind).toBe('ACQUIRED');
    if (contender.kind === 'ACQUIRED') {
      contender.lease.release();
    }

    harness.scheduler.releaseIdle();
    const snapshot = await drive(harness, pending);
    expect(snapshot.outcome).toEqual({kind: 'READY'});
  });

  it('holds the exclusive lease for the whole active window', async () => {
    const harness = createHarness();
    await runSetup(harness);

    const contender = acquireMotorTestLease({
      client: harness.client,
      requestedIdentity: {physicalGeneration: PHYSICAL_GENERATION, mspEpoch: 0},
      readCurrentIdentity: () => ({
        physicalGeneration: PHYSICAL_GENERATION,
        mspEpoch: 0,
      }),
    });
    expect(contender.kind).toBe('NOT_ACQUIRED');
    if (contender.kind === 'NOT_ACQUIRED') {
      expect(contender.reason).toBe('MOTOR_TEST_LEASE_ALREADY_HELD');
    }
  });

  it('constructs the safety monitor with the SAME lease, and only one', async () => {
    const harness = createHarness();
    await runSetup(harness);
    // One monitor, started once, and its requester is the very lease every
    // other request in this session travels.
    expect(harness.safetyMonitor.started).toBe(1);
    expect(harness.safetyMonitor.requesterIsLease()).toBe(true);
  });

  it('treats a structurally identical authority clone as foreign', async () => {
    const harness = createHarness();
    const snapshot = await runSetup(harness);
    const machine = snapshot.machine;
    expect(machine).toBeDefined();
    if (machine === undefined) {
      return;
    }
    // Same prototype, same (absent) own properties - and still a
    // different object, which the accepted reducer ignores entirely.
    const clone = Object.create(
      Object.getPrototypeOf(machine.authority) as object,
    ) as object;
    expect(clone).not.toBe(machine.authority);
    const result = motorTestTransition(machine, {
      authority: clone,
      kind: 'FAULT_RAISED',
      reason: 'SESSION_CHANGED',
    });
    expect(result.state).toBe(machine);
    expect(result.effects).toHaveLength(0);
  });

  it('accepts a structurally equal composite identity by value', async () => {
    // The harness returns a FRESH identity object on every read; reaching
    // Ready at all proves identity is compared by value, never by
    // reference - while the authority above is compared by identity.
    const harness = createHarness();
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome).toEqual({kind: 'READY'});
  });

  it('publishes an immutable snapshot', async () => {
    const harness = createHarness();
    const snapshot = await runSetup(harness);
    expect(Object.isFrozen(snapshot)).toBe(true);
    // Reflect.set reports refusal without depending on strict mode.
    expect(Reflect.set(snapshot, 'phase', 'IDLE')).toBe(false);
    expect(snapshot.phase).toBe('ACTIVE');
    expect(Object.isFrozen(snapshot.stopDescriptors)).toBe(true);
    expect(Object.isFrozen(snapshot.warnings)).toBe(true);
    expect(Object.isFrozen(snapshot.motorScope)).toBe(true);
  });

  it('returns the same operation for a repeated initializeSession()', async () => {
    const harness = createHarness();
    const first = harness.controller.initializeSession();
    const second = harness.controller.initializeSession();
    expect(second).toBe(first);
    await drive(harness, first);
    expect(
      harness.commands.filter(command => command === MSP_BOXIDS),
    ).toHaveLength(1);
  });

  it('refuses READY when the first observation never becomes fresh', async () => {
    // The monitor is joined and then judged. An evidence reader that never
    // reports a fresh disarmed reading must stop setup at step 10 rather
    // than publish a READY nothing is watching.
    mockArmedStateEvidence = 'UNKNOWN_OR_STALE';
    const harness = createHarness();
    const snapshot = await runSetup(harness);

    expect(snapshot.outcome).toMatchObject({
      kind: 'BLOCKED',
      reason: 'FIRST_OBSERVATION_UNAVAILABLE',
    });
    expect(snapshot.setupStep).toBe('FIRST_OBSERVATION');
    expect(snapshot.activation.allowed).toBe(false);
    expect(snapshot.activation.reasons).toContain('ARMED_STATE_UNKNOWN_OR_STALE');
  });

  it('refuses READY when the first observation proves the FC armed', async () => {
    mockArmedStateEvidence = 'FC_ARMED';
    const harness = createHarness();
    const snapshot = await runSetup(harness);

    expect(snapshot.outcome).toMatchObject({
      kind: 'BLOCKED',
      reason: 'FIRST_OBSERVATION_NOT_DISARMED',
    });
    expect(snapshot.activation.reasons).toContain('FC_ARMED');
  });

  it('awaits the first observation before publishing READY', async () => {
    // Nothing may publish READY while the very fact READY rests on is
    // still in flight. The stand-in holds its first observation open and
    // the setup promise must not settle until it is released.
    const harness = createHarness([], {holdFirstObservation: true});
    let settled = false;
    const pending = harness.controller
      .initializeSession()
      .then(value => {
        settled = true;
        return value;
      });

    await drivePending(harness, () => harness.safetyMonitor.firstObservationHeld);
    expect(settled).toBe(false);
    expect(harness.controller.getSnapshot().outcome.kind).toBe('PENDING');
    expect(harness.controller.getSnapshot().setupStep).toBe('FIRST_OBSERVATION');

    harness.safetyMonitor.releaseFirstObservation();
    const snapshot = await drive(harness, pending);

    expect(settled).toBe(true);
    expect(snapshot.outcome).toEqual({kind: 'READY'});
    expect(snapshot.activation.allowed).toBe(true);
  });

  it('notifies subscribers with an activatable snapshot the moment the observation lands', async () => {
    // The defect this closes: READY used to publish before the first
    // observation, so `allowed` only flipped when an UNRELATED render
    // rebuilt the snapshot. A subscriber must see it become true from the
    // observation alone.
    const harness = createHarness([], {holdFirstObservation: true});
    const allowedAtNotification: boolean[] = [];
    harness.controller.subscribe(() => {
      allowedAtNotification.push(
        harness.controller.getSnapshot().activation.allowed,
      );
    });

    const pending = harness.controller.initializeSession();
    await drivePending(harness, () => harness.safetyMonitor.firstObservationHeld);
    expect(allowedAtNotification).not.toContain(true);

    harness.safetyMonitor.releaseFirstObservation();
    await drive(harness, pending);

    // No pulse, no press, no re-render: resolving the observation is what
    // produced an activatable snapshot.
    expect(allowedAtNotification).toContain(true);
  });
});

/* ------------------------------------------------------------------ *
 * Correction B-1 - telemetry/client coherence
 *
 * The rejected revision could hold the barrier over session A's
 * schedulers while leasing client B, and still publish Ready with
 * telemetryHeld=true. These use the REAL registry, REAL MspClients and
 * the REAL lease issuer, exactly as the audit probe did.
 * ------------------------------------------------------------------ */

describe('MotorTestController - session/client coherence (B-1)', () => {
  it('A/A: the anchor client is the client that receives the lease', async () => {
    const harness = createHarness();
    // Same object, not merely equal values.
    expect(harness.telemetryOwner).toBe(harness.client);

    const snapshot = await runSetup(harness);
    expect(snapshot.outcome).toEqual({kind: 'READY'});
    expect(snapshot.telemetryHeld).toBe(true);
    expect(harness.scheduler.activeMotorTestLeaseCount).toBe(1);

    // The paused telemetry and the exclusive lease describe ONE link: the
    // client whose schedulers are held is the client no one else can lease.
    const contender = acquireMotorTestLease({
      client: harness.client,
      requestedIdentity: {physicalGeneration: PHYSICAL_GENERATION, mspEpoch: 0},
      readCurrentIdentity: () => ({
        physicalGeneration: PHYSICAL_GENERATION,
        mspEpoch: 0,
      }),
    });
    expect(contender.kind).toBe('NOT_ACQUIRED');
  });

  it('A/B: rejected even though both clients report equal composite values', async () => {
    const harness = createHarness([], {telemetryClient: 'FOREIGN'});
    expect(harness.telemetryOwner).not.toBe(harness.client);
    // The value-only view is IDENTICAL for both clients, which is exactly
    // why a structural comparison could not have caught this.
    expect(harness.telemetryOwner.getEpoch()).toBe(harness.client.getEpoch());
    expect({
      physicalGeneration: PHYSICAL_GENERATION,
      mspEpoch: harness.telemetryOwner.getEpoch(),
    }).toEqual({
      physicalGeneration: PHYSICAL_GENERATION,
      mspEpoch: harness.client.getEpoch(),
    });

    const snapshot = await runSetup(harness);

    expect(snapshot.outcome).toEqual({
      kind: 'BLOCKED',
      reason: 'TELEMETRY_SESSION_CLIENT_MISMATCH',
      requiresNewSession: true,
    });
    expect(snapshot.setupStep).toBe('TELEMETRY_BARRIER');
  });

  it('A/B: never reaches Ready and never reports telemetryHeld', async () => {
    const harness = createHarness([], {telemetryClient: 'FOREIGN'});
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome.kind).not.toBe('READY');
    expect(snapshot.machine).toBeUndefined();
    expect(snapshot.telemetryHeld).toBe(false);
    expect(harness.controller.getSnapshot().telemetryHeld).toBe(false);
  });

  it('A/B: no lease is taken on B and no request travels B', async () => {
    const harness = createHarness([], {telemetryClient: 'FOREIGN'});
    await runSetup(harness);

    // Zero bytes were written on the controller's client.
    expect(harness.commands).toHaveLength(0);
    expect(harness.transport.writes).toHaveLength(0);

    // And B was never leased: it is still freely acquirable.
    const probe = acquireMotorTestLease({
      client: harness.client,
      requestedIdentity: {physicalGeneration: PHYSICAL_GENERATION, mspEpoch: 0},
      readCurrentIdentity: () => ({
        physicalGeneration: PHYSICAL_GENERATION,
        mspEpoch: 0,
      }),
    });
    expect(probe.kind).toBe('ACQUIRED');
    if (probe.kind === 'ACQUIRED') {
      expect(probe.lease.release()).toBe('RELEASED');
    }
  });

  it("A/B: session A's telemetry is never paused", async () => {
    const harness = createHarness([], {telemetryClient: 'FOREIGN'});
    await runSetup(harness);
    // Not "paused then released" - never leased at all.
    expect(harness.scheduler.leases).toHaveLength(0);
    expect(harness.scheduler.activeMotorTestLeaseCount).toBe(0);
  });

  it('A/B: leaks no barrier token, and close() stays clean', async () => {
    const harness = createHarness([], {telemetryClient: 'FOREIGN'});
    const settled = await runSetup(harness);
    expect(settled.teardown?.telemetryTokensReleased).toBe(false);
    expect(settled.teardown?.leaseRelease).toBe('NOT_HELD');
    expect(settled.teardown?.complete).toBe(true);
    expect(harness.scheduler.activeMotorTestLeaseCount).toBe(0);

    const closed = await harness.controller.close();
    expect(closed.telemetryHeld).toBe(false);
    expect(harness.scheduler.activeMotorTestLeaseCount).toBe(0);
    expect(harness.invalidationListenerCount()).toBe(0);
  });

  it('Step-1 retry after teardown never hands back the stale settled promise', async () => {
    // THE CONFIRMED DEFECT (motorTestController.ts:1738-1745 before the
    // fix). `setupPromise` was checked BEFORE the closed check, so once
    // setup had run and teardown had reached CLOSED, every later
    // initializeSession() returned that same settled promise - resolving
    // to the snapshot captured WHEN IT SETTLED, not the current one.
    //
    // A SUCCESSFUL setup is used deliberately. A failing one tears down
    // inside the same settle, so its final snapshot IS the settled one and
    // both the fixed and unfixed orders return the same object - a test
    // built on that fixture passes either way and proves nothing. Here the
    // settled snapshot says READY/ACTIVE and the post-teardown snapshot
    // says CLOSED, so the two are genuinely distinguishable.
    const harness = createHarness();
    const first = await runSetup(harness);
    expect(first.outcome.kind).toBe('READY');
    expect(first.phase).toBe('ACTIVE');

    // Teardown of a LIVE session writes its stop vector, so the transport
    // has to be driven for close() to settle - the same idiom the other
    // close tests in this file use.
    const closing = harness.controller.close();
    await drive(harness, closing);
    expect(harness.controller.getSnapshot().phase).toBe('CLOSED');

    const writesBeforeRetry = harness.transport.writes.length;
    const retry = await harness.controller.initializeSession();

    // The retry reports the CLOSED reality, not the stale READY object.
    expect(retry.phase).toBe('CLOSED');
    expect(retry).toBe(harness.controller.getSnapshot());
    expect(retry).not.toBe(first);
    // NOTE, measured rather than assumed: after a CLEAN teardown the
    // outcome stays READY - teardown only overwrites it on failure. So
    // `phase` is the reliable terminal signal, and it is what the screen's
    // reconnect instruction keys on first. Asserting `outcome !== READY`
    // here would be asserting something untrue of a healthy close.
    expect(first.outcome.kind).toBe('READY');
    expect(retry.outcome.kind).toBe('READY');

    // Setup was NOT re-run on this instance: a closed controller still
    // holds its terminal outcome, teardown report, monitor and
    // lease/authority fields, and reusing that session-bound evidence is
    // exactly what must never happen.
    expect(harness.transport.writes.length).toBe(writesBeforeRetry);
    expect(harness.scheduler.activeMotorTestLeaseCount).toBe(0);
  });

  it('a closed controller can never write a motor command', async () => {
    const harness = createHarness([], {telemetryClient: 'FOREIGN'});
    await runSetup(harness);
    await harness.controller.close();

    const before = harness.transport.writes.length;
    const result = harness.controller.pulseMotor(1);
    expect(result).not.toBe('SUBMITTED');
    expect(harness.transport.writes.length).toBe(before);
    expect(harness.controller.getSnapshot().activation.allowed).toBe(false);
  });

  it('a fabricated session anchor cannot bypass the ownership check', async () => {
    // Constructed by the caller rather than minted by the registry: it has
    // no recorded owner, so it can never satisfy the check.
    const forged = new MotorTestTelemetrySession();
    const harness = createHarness([], {telemetrySession: forged});
    const snapshot = await runSetup(harness);

    expect(snapshot.outcome).toEqual({
      kind: 'BLOCKED',
      reason: 'TELEMETRY_SESSION_UNKNOWN',
      requiresNewSession: true,
    });
    expect(snapshot.telemetryHeld).toBe(false);
    expect(harness.commands).toHaveLength(0);
    expect(harness.scheduler.leases).toHaveLength(0);
  });

  it('a cancelled A/B attempt leaves nothing held either', async () => {
    const harness = createHarness([], {telemetryClient: 'FOREIGN'});
    const pending = harness.controller.initializeSession();
    const closing = harness.controller.close();
    await drive(harness, pending);
    const closed = await closing;
    expect(closed.telemetryHeld).toBe(false);
    expect(harness.scheduler.activeMotorTestLeaseCount).toBe(0);
    expect(harness.commands).toHaveLength(0);
    expect(harness.transport.writes).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Evidence failures - the LOCK / FAULT split
 * ------------------------------------------------------------------ */

describe('MotorTestController - evidence failures', () => {
  it('locks on malformed BOX evidence', async () => {
    const harness = createHarness([[MSP_BOXIDS, reply(EMPTY)]]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome).toEqual({
      kind: 'BLOCKED',
      reason: 'BOX_EVIDENCE_UNAVAILABLE',
      requiresNewSession: true,
    });
    expect(snapshot.machine?.name).toBe('Locked');
  });

  it('fails closed when the BOX request itself is rejected', async () => {
    const harness = createHarness([[MSP_BOXIDS, REJECT]]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome.kind).toBe('FAILED_CLOSED');
    expect(snapshot.machine?.name).toBe('Fault');
  });

  it('locks on a malformed configuration response', async () => {
    const harness = createHarness([[MSP_MOTOR_CONFIG, reply(EMPTY)]]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome).toMatchObject({
      kind: 'BLOCKED',
      reason: 'MOTOR_CONFIG_MALFORMED',
    });
  });

  it('fails closed when a configuration request is rejected', async () => {
    const harness = createHarness([[MSP_ADVANCED_CONFIG, REJECT]]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome).toMatchObject({
      kind: 'FAILED_CLOSED',
      reason: 'MOTOR_CONFIG_REQUEST_FAILED',
      faultReason: 'MSP_RESPONSE_TIMEOUT',
    });
  });

  it('reads configuration BEFORE the box mapping, and stops at the first failure', async () => {
    const harness = createHarness([[MSP_MOTOR_CONFIG, REJECT]]);
    await runSetup(harness);
    // The box read is never spent once the configuration has already
    // failed - ordering is what makes that true, not a guard.
    expect(harness.commands).not.toContain(MSP_BOXIDS);
  });
});

/* ------------------------------------------------------------------ *
 * Removed gates - these used to end a session and no longer do
 *
 * Each fixture below is one the OLD proof chain refused. None of them
 * affects how an MSP_SET_MOTOR frame is encoded, so refusing them was
 * refusing a safe bench test for an unrelated reason.
 * ------------------------------------------------------------------ */

describe('MotorTestController - the removed proof chain', () => {
  it('reaches READY on a board the old target profile did not recognize', async () => {
    const harness = createHarness([
      [MSP_BOARD_INFO, reply(boardInfoPayload('SOMEOTHERTARGET'))],
    ]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome).toEqual({kind: 'READY'});
  });

  it('reaches READY with a mixer mode the old profile did not recognize', async () => {
    const harness = createHarness([[MSP_MIXER_CONFIG, reply(mixerConfigPayload(5))]]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome).toEqual({kind: 'READY'});
  });

  it('reaches READY without any firmware-version pinning', async () => {
    const harness = createHarness([
      [MSP_FC_VERSION, REJECT],
      [MSP_API_VERSION, reply(Uint8Array.from([0, 1, 41]))],
    ]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome).toEqual({kind: 'READY'});
    expect(harness.commands).not.toContain(MSP_FC_VERSION);
    expect(harness.commands).not.toContain(MSP_API_VERSION);
  });

  it('reaches READY without reading the battery at all', async () => {
    const harness = createHarness([
      [MSP_BATTERY_STATE, reply(batteryPayload(6, 2500))],
    ]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome).toEqual({kind: 'READY'});
    // Not merely tolerated - never requested. This module makes no claim
    // about the pack, and the header says so.
    expect(harness.commands).not.toContain(MSP_BATTERY_STATE);
  });

  /**
   * INVERTED IN P2-ii, DELIBERATELY, AND THAT IS THE POINT.
   *
   * This asserted that a session reaches READY even when no arming
   * restriction is present - correct for a pass that had removed the
   * restriction and relied on continuous armed-state observation alone.
   * P2-ii restores it, so the SAME fixture must now produce the opposite
   * result: a flight controller that refuses command 99, or that reports
   * the restriction absent afterwards, must NOT yield a commandable
   * session.
   *
   * Kept rather than deleted because it pins the exact configuration that
   * used to be tolerated and must no longer be.
   */
  it('refuses READY when the arming restriction cannot be established', async () => {
    const harness = createHarness([
      [MSP_STATUS_EX, reply(statusPayload({mspRestrictionPresent: false}))],
      [MSP_SET_ARMING_DISABLED_FIXTURE, REJECT],
    ]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome.kind).not.toBe('READY');
    expect(snapshot.activation.allowed).toBe(false);
  });

  it('refuses READY when the FC acknowledges 99 but reports the flag absent', async () => {
    // The write was accepted and the device says the restriction is not in
    // force. Believing the ACK over the device would be exactly the
    // weakness the independent re-read exists to close.
    const harness = createHarness([
      [MSP_STATUS_EX, reply(statusPayload({mspRestrictionPresent: false}))],
    ]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome.kind).not.toBe('READY');
  });
});

describe('MotorTestController - evidence failures (continued)', () => {
  it('never publishes a Fault that claims a live motor command', async () => {
    const harness = createHarness([[MSP_BOXIDS, REJECT]]);
    const snapshot = await runSetup(harness);
    expect(snapshot.machine).toMatchObject({
      name: 'Fault',
      startMayHaveReachedFc: false,
    });
    expect(snapshot.warnings).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Session boundaries and cancellation
 * ------------------------------------------------------------------ */

describe('MotorTestController - session boundaries', () => {
  /** Every command the simplified setup actually sends. A session that
   * moves at ANY of these boundaries must fail closed. */
  const BOUNDARY_COMMANDS: readonly number[] = [
    MSP_MOTOR_CONFIG,
    MSP_ADVANCED_CONFIG,
    MSP_FEATURE_CONFIG,
    MSP_BOXIDS,
  ];

  it.each(BOUNDARY_COMMANDS)(
    'fails closed when the session changes at the command-%i boundary',
    async command => {
      const harness = createHarness();
      harness.beforeReply = written => {
        if (written === command) {
          harness.identity = {
            physicalGeneration: PHYSICAL_GENERATION + 1,
            mspEpoch: 0,
          };
        }
      };
      const snapshot = await runSetup(harness);
      expect(snapshot.outcome.kind).toBe('FAILED_CLOSED');
      expect(snapshot.machine?.name).toBe('Fault');
    },
  );

  it('refuses to spend a request when there is no session at all', async () => {
    const harness = createHarness();
    harness.identity = undefined;
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome).toMatchObject({
      kind: 'BLOCKED',
      reason: 'SESSION_IDENTITY_UNAVAILABLE',
    });
    expect(harness.commands).toHaveLength(0);
  });

  it('fails closed when the identity provider throws', async () => {
    const harness = createHarness();
    harness.beforeReply = command => {
      if (command === MSP_BOXIDS) {
        harness.failIdentityReads();
      }
    };
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome).toMatchObject({
      kind: 'FAILED_CLOSED',
      reason: 'UNEXPECTED_SERVICE_EXCEPTION',
      faultReason: 'NATIVE_EXCEPTION',
    });
  });

  it('fails closed and tears down on a USB detach signal', async () => {
    const harness = createHarness();
    const pending = harness.controller.initializeSession();
    await flush(20);
    harness.invalidate('USB_DETACHED');
    await drive(harness, pending);
    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.outcome.kind).toBe('FAILED_CLOSED');
    // The CAUSE is preserved on the terminal reducer state; the outcome
    // may additionally report that cleanup could not complete while a
    // request was still on the wire.
    expect(snapshot.machine).toMatchObject({
      name: 'Fault',
      faultReason: 'USB_DETACHED',
    });
    expect(snapshot.phase).toBe('CLOSED');
  });

  it('routes a desynchronization signal to its own fault reason', async () => {
    const harness = createHarness();
    await runSetup(harness);
    harness.invalidate('DESYNCHRONIZED');
    await flush(20);
    expect(harness.controller.getSnapshot().machine).toMatchObject({
      name: 'Fault',
      faultReason: 'DESYNCHRONIZED',
    });
  });

  it('cancellation prevents a stale completion from publishing Ready', async () => {
    const harness = createHarness();
    harness.scheduler.holdIdle();
    const pending = harness.controller.initializeSession();
    await flush(20);
    // Closed while the barrier is still being acquired: no lease exists,
    // so nothing is left half-owned.
    const closing = harness.controller.close();
    harness.scheduler.releaseIdle();
    const snapshot = await drive(harness, pending);
    await closing;
    expect(snapshot.outcome.kind).not.toBe('READY');
    expect(harness.controller.getSnapshot().phase).toBe('CLOSED');
    expect(harness.commands).toHaveLength(0);
    expect(harness.scheduler.activeMotorTestLeaseCount).toBe(0);
  });

  it('a stop during setup prevents Ready without any generic dispatcher', async () => {
    const harness = createHarness();
    const pending = harness.controller.initializeSession();
    await flush(20);
    await serveOne(harness);
    expect(harness.controller.requestStop('ANDROID_BACK')).toBe('ACCEPTED');
    const snapshot = await drive(harness, pending);
    expect(snapshot.outcome).toMatchObject({
      kind: 'BLOCKED',
      reason: 'STOP_REQUESTED_DURING_SETUP',
    });
  });

  it('a stop after setup does not tear the controller down', async () => {
    const harness = createHarness();
    await runSetup(harness);
    expect(harness.controller.requestStop('NAVIGATION_BLURRED')).toBe(
      'ACCEPTED',
    );
    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.phase).toBe('ACTIVE');
    expect(snapshot.telemetryHeld).toBe(true);
    expect(snapshot.teardown).toBeUndefined();
    expect(snapshot.machine?.name).toBe('Ready');
  });

  it('requires a full reset after a fault', async () => {
    const harness = createHarness([[MSP_BOXIDS, REJECT]]);
    await runSetup(harness);
    expect(harness.controller.getSnapshot().machine?.name).toBe('Fault');

    // Nothing recovers it: not a re-initialization, not a stop.
    const again = await harness.controller.initializeSession();
    expect(again.machine?.name).toBe('Fault');
    harness.controller.requestStop('STOP_BUTTON_PRESSED');
    const final = harness.controller.getSnapshot();
    expect(final.machine?.name).toBe('Fault');
    expect(final.outcome).toMatchObject({requiresNewSession: true});
  });
});

/* ------------------------------------------------------------------ *
 * Teardown
 * ------------------------------------------------------------------ */

/**
 * Phase 2F: the teardown contract is now EIGHT steps. The previous
 * seven-step array predates command 214; `EXECUTE_STOP_VECTOR` is ordered
 * after authority validation and before any arming-restriction
 * settlement, which is the whole point of the ordering.
 */
/**
 * EXTENDED IN P2-ii by one step. The comment above notes the array
 * predates command 214 and that EXECUTE_STOP_VECTOR is ordered "before
 * any arming-restriction settlement" - P2-ii is where that settlement
 * actually arrives, and it lands exactly where that sentence predicted:
 * after the all-stop, before the lease.
 */
const TEARDOWN_STEPS = [
  'MARK_CLOSING',
  'REMOVE_LISTENERS',
  'KEEP_TELEMETRY_PAUSED',
  'AUTHORIZED_TEARDOWN_ONLY',
  'EXECUTE_STOP_VECTOR',
  'STOP_SAFETY_MONITOR',
  'RELEASE_ARMING_RESTRICTION',
  'RELEASE_LEASE',
  'RELEASE_TELEMETRY_TOKENS',
];

describe('MotorTestController - teardown', () => {
  it('runs the required teardown steps in order', async () => {
    const harness = createHarness();
    await runSetup(harness);
    const snapshot = await drive(harness, harness.controller.close());

    expect(snapshot.teardown?.steps.map(step => step.step)).toEqual(
      TEARDOWN_STEPS,
    );
    expect(snapshot.teardown?.complete).toBe(true);
    expect(snapshot.teardown?.leaseRelease).toBe('RELEASED');
    expect(snapshot.phase).toBe('CLOSED');
    expect(snapshot.telemetryHeld).toBe(false);
  });

  it('releases the lease before it releases telemetry', async () => {
    const harness = createHarness();
    await runSetup(harness);

    let exclusiveOwnershipGoneAtResume: boolean | undefined;
    harness.scheduler.onMotorTestRelease = () => {
      const probe = acquireMotorTestLease({
        client: harness.client,
        requestedIdentity: {
          physicalGeneration: PHYSICAL_GENERATION,
          mspEpoch: 0,
        },
        readCurrentIdentity: () => ({
          physicalGeneration: PHYSICAL_GENERATION,
          mspEpoch: 0,
        }),
      });
      exclusiveOwnershipGoneAtResume = probe.kind === 'ACQUIRED';
      if (probe.kind === 'ACQUIRED') {
        probe.lease.release();
      }
    };

    await drive(harness, harness.controller.close());
    expect(exclusiveOwnershipGoneAtResume).toBe(true);
    expect(harness.scheduler.activeMotorTestLeaseCount).toBe(0);
  });

  it('stops the observation loop as part of teardown', async () => {
    const harness = createHarness();
    await runSetup(harness);
    const snapshot = await drive(harness, harness.controller.close());
    expect(snapshot.teardown?.safetyMonitorStopped).toBe(true);
    // No observation may be outstanding against a lease that is about to
    // be released.
    expect(harness.safetyMonitor.running).toBe(false);
    expect(harness.safetyMonitor.stopped).toBeGreaterThanOrEqual(1);
  });

  it('does not resume telemetry when the lease release is unresolved', async () => {
    const harness = createHarness();
    const pending = harness.controller.initializeSession();
    await flush(20);
    // The first accepted read is on the wire and stays there: the write
    // is resolved, the response never arrives, so the lease has genuinely
    // unsettled work.
    expect(harness.transport.writes).toHaveLength(1);
    harness.transport.resolveNextWrite();
    await flush(10);

    const closed = await harness.controller.close();
    expect(closed.teardown?.leaseRelease).toBe('LEASE_WORK_UNSETTLED');
    expect(closed.teardown?.telemetryTokensReleased).toBe(false);
    expect(closed.teardown?.complete).toBe(false);
    expect(closed.teardown?.incompleteReason).toBe('LEASE_RELEASE_UNRESOLVED');
    expect(closed.outcome).toMatchObject({
      kind: 'FAILED_CLOSED',
      reason: 'TEARDOWN_INCOMPLETE',
    });
    expect(harness.scheduler.activeMotorTestLeaseCount).toBe(1);

    // Let the outstanding request settle so nothing is left pending, and
    // confirm the terminal fault is not downgraded afterwards.
    harness.transport.emitData(errorFrame(MSP_BOXIDS));
    await drive(harness, pending);
    expect(harness.controller.getSnapshot().outcome).toMatchObject({
      kind: 'FAILED_CLOSED',
      reason: 'TEARDOWN_INCOMPLETE',
    });
  });

  it('is idempotent under concurrent close calls', async () => {
    const harness = createHarness();
    await runSetup(harness);
    const first = harness.controller.close();
    const second = harness.controller.close();
    expect(second).toBe(first);
    const snapshot = await drive(harness, first);
    // P2-ii adds RELEASE_ARMING_RESTRICTION; the property under test is
    // idempotency - the list must not GROW on repeated close() calls.
    expect(snapshot.teardown?.steps).toHaveLength(TEARDOWN_STEPS.length);
    const third = await harness.controller.close();
    expect(third.teardown?.steps).toHaveLength(TEARDOWN_STEPS.length);
    expect(third).toBe(snapshot);
  });

  it('removes its session listener exactly once', async () => {
    const harness = createHarness();
    await runSetup(harness);
    expect(harness.invalidationListenerCount()).toBe(1);
    await drive(harness, harness.controller.close());
    expect(harness.invalidationListenerCount()).toBe(0);
    await harness.controller.close();
    expect(harness.invalidationListenerCount()).toBe(0);
  });

  it('a retained invalidation callback is inert after cleanup', async () => {
    const harness = createHarness();
    await runSetup(harness);
    const closed = await drive(harness, harness.controller.close());
    harness.invalidate('USB_DETACHED');
    await flush(20);
    expect(harness.controller.getSnapshot()).toBe(closed);
  });

  it('a subscriber exception cannot break cleanup', async () => {
    const harness = createHarness();
    await runSetup(harness);
    harness.controller.subscribe(() => {
      throw new Error('subscriber blew up');
    });
    let saw = 0;
    harness.controller.subscribe(() => {
      saw += 1;
    });
    const snapshot = await drive(harness, harness.controller.close());
    expect(snapshot.teardown?.complete).toBe(true);
    expect(snapshot.telemetryHeld).toBe(false);
    expect(saw).toBeGreaterThan(0);
  });

  it('rolls a partial acquisition back through the same steps', async () => {
    const harness = createHarness([[MSP_BOXIDS, reply(EMPTY)]]);
    const snapshot = await runSetup(harness);
    expect(snapshot.teardown?.steps.map(step => step.step)).toEqual(
      TEARDOWN_STEPS,
    );
    expect(snapshot.teardown?.leaseRelease).toBe('RELEASED');
    expect(snapshot.telemetryHeld).toBe(false);
    expect(harness.scheduler.activeMotorTestLeaseCount).toBe(0);
  });

  it("an old controller's teardown cannot disturb a new session", async () => {
    const older = createHarness();
    await runSetup(older);
    const newer = createHarness();
    await runSetup(newer);

    await drive(older, older.controller.close());

    expect(newer.controller.getSnapshot().telemetryHeld).toBe(true);
    expect(newer.scheduler.activeMotorTestLeaseCount).toBe(1);
    expect(newer.controller.getSnapshot().outcome).toEqual({kind: 'READY'});
    await drive(newer, newer.controller.close());
  });

  it('refuses to start after close', async () => {
    const harness = createHarness();
    await drive(harness, harness.controller.close());
    const snapshot = await harness.controller.initializeSession();
    expect(snapshot.phase).toBe('CLOSED');
    expect(harness.commands).toHaveLength(0);
    expect(harness.controller.requestStop('ANDROID_BACK')).toBe(
      'CONTROLLER_CLOSED',
    );
  });
});

/* ------------------------------------------------------------------ *
 * Phase 2F - the command-214 stop executor
 *
 * Every byte below travels the REAL MspClient FIFO through the REAL
 * MotorTestLease held privately by the REAL controller. The encoder, the
 * stop vector and the scope guard are the accepted PROTECTED modules,
 * used unchanged. No hardware, no USB, no FC.
 * ------------------------------------------------------------------ */

describe('Phase 2F - stop execution', () => {
  it('dispatches command 214 with exactly E8 03 E8 03 E8 03 E8 03', async () => {
    const harness = createHarness();
    await runSetup(harness);
    expect(harness.commands).not.toContain(MSP_SET_MOTOR_FIXTURE);

    const closed = await drive(harness, harness.controller.close());

    const stopWrites = harness.writes.filter(
      w => w.command === MSP_SET_MOTOR_FIXTURE,
    );
    expect(stopWrites).toHaveLength(1);
    expect(stopWrites[0].payload).toEqual(EXPECTED_STOP_PAYLOAD);
    expect(stopWrites[0].payload).toHaveLength(8);
    expect(closed.stopExecution.outcome).toEqual({kind: 'ACKNOWLEDGED'});
  });

  it('encodes four little-endian uint16 values of 1000', () => {
    // Decoded back from the exact expected bytes, without re-deriving them.
    const values: number[] = [];
    for (let i = 0; i < 8; i += 2) {
      values.push(
        EXPECTED_STOP_PAYLOAD[i] + EXPECTED_STOP_PAYLOAD[i + 1] * 256,
      );
    }
    expect(values).toEqual([1000, 1000, 1000, 1000]);
    // Little-endian, not big-endian: the low byte is first.
    expect(EXPECTED_STOP_PAYLOAD[0]).toBe(1000 % 256);
    expect(EXPECTED_STOP_PAYLOAD[1]).toBe(Math.floor(1000 / 256));
  });

  it('runs the stop through the lease, after the last evidence read', async () => {
    const harness = createHarness();
    await runSetup(harness);
    await drive(harness, harness.controller.close());
    // UPDATED IN P2-ii. The stop used to be the LAST command of the
    // session. It is now the last MOTOR command, followed by the arming
    // restriction release - which is the correct order and the whole
    // point: outputs are commanded to stop while a command can still be
    // sent, and only then is the flight controller allowed to arm again.
    const stopIndex = harness.commands.lastIndexOf(MSP_SET_MOTOR_FIXTURE);
    const lastEvidenceIndex = harness.commands.lastIndexOf(MSP_BOXIDS);
    expect(lastEvidenceIndex).toBeGreaterThanOrEqual(0);
    expect(stopIndex).toBeGreaterThan(lastEvidenceIndex);
    // The release is the last command, and it comes AFTER the stop.
    expect(harness.commands[harness.commands.length - 1]).toBe(
      MSP_SET_ARMING_DISABLED_FIXTURE,
    );
    expect(harness.commands.lastIndexOf(MSP_SET_ARMING_DISABLED_FIXTURE))
      .toBeGreaterThan(stopIndex);
  });

  it('releases the restriction with payload [0], only after the stop', async () => {
    const harness = createHarness();
    await runSetup(harness);
    const closed = await drive(harness, harness.controller.close());
    const armingWrites = harness.writes.filter(
      write => write.command === MSP_SET_ARMING_DISABLED_FIXTURE,
    );
    // Exactly two: establish [1] at enable, release [0] at teardown.
    expect(armingWrites.map(write => write.payload)).toEqual([[1], [0]]);
    expect(closed.teardown?.armingRestrictionRelease).toBe('RELEASED');
  });

  it('orders the stop before the monitor stop and the lease release', async () => {
    const harness = createHarness();
    await runSetup(harness);
    const closed = await drive(harness, harness.controller.close());
    const steps = closed.teardown?.steps.map(s => s.step) ?? [];
    expect(steps.indexOf('EXECUTE_STOP_VECTOR')).toBeLessThan(
      steps.indexOf('STOP_SAFETY_MONITOR'),
    );
    expect(steps.indexOf('EXECUTE_STOP_VECTOR')).toBeLessThan(
      steps.indexOf('RELEASE_LEASE'),
    );
    expect(steps).toEqual(TEARDOWN_STEPS);
  });

  it('records the Phase 2G evidence boundary and never claims wire preemption', async () => {
    const harness = createHarness();
    await runSetup(harness);
    const closed = await drive(harness, harness.controller.close());

    expect(closed.stopExecution.outcome).toEqual({kind: 'ACKNOWLEDGED'});
    // The one thing this layer CAN prove: the stop was taken out of the
    // client's own stop slot, ahead of the FIFO, as the next submission.
    expect(closed.stopExecution.submittedNextOnTransport).toBe(true);
    // The three things it can NEVER prove, all pinned false.
    expect(closed.stopExecution.wirePreemptionClaimed).toBe(false);
    expect(closed.stopExecution.physicalStopConfirmed).toBe(false);
    expect(closed.stopExecution.attributionAmbiguous).toBe(false);
    // Nothing was in flight at teardown, so no latency caveat applies.
    expect(closed.stopExecution.deferredBehindActiveWrite).toBe(false);
  });

  it('cannot report an acknowledgement while attribution is ambiguous', async () => {
    // The ambiguous shape - a stop displacing an ALREADY-WRITTEN command
    // 214 - is not constructible through this controller's production
    // surface, and that is itself a safety property: exactly one dispatch
    // site for 214 exists in the whole file (asserted under containment),
    // so a second in-flight 214 cannot be created here. The displacement
    // behaviour is therefore proven where it lives, against the real
    // request engine, in mspClient.test.ts ('reports attribution as
    // ambiguous only when the displaced request carries the stop's own
    // command'). What is asserted HERE is this controller's consumption of
    // that flag: ambiguity must gate the acknowledgement, fail the lease
    // closed, and be reported as a FAILED outcome - never as a stop.
    // REWRITTEN IN P2-ii: the ambiguity algorithm MOVED, it did not
    // weaken. The controller no longer owns any stop dispatch - the
    // professional engine does - so the source assertions now hold against
    // motorControlCommandEngine.ts, where the counting argument, the
    // confirming second all-stop and the fail-closed second ambiguity all
    // live (and are behaviourally proven in its own suite with
    // deterministic deferreds).
    const source = readFileSync(
      join(__dirname, 'motorControlCommandEngine.ts'),
      'utf8',
    );
    const ambiguousBranch = source.slice(
      source.indexOf('if (attributionAmbiguous)'),
    );
    expect(source).toContain(
      'attributionAmbiguous = dispatch.attributionAmbiguous;',
    );
    expect(ambiguousBranch).toContain('lease.failClosed()');
    expect(ambiguousBranch).toContain("reason: 'ATTRIBUTION_AMBIGUOUS'");
    // The ambiguity check precedes the only ACKNOWLEDGED return, so an
    // ambiguous exchange can never fall through to it.
    expect(source.indexOf('if (attributionAmbiguous)')).toBeLessThan(
      source.indexOf("kind: 'ACKNOWLEDGED' as const"),
    );
    // ATTRIBUTION_AMBIGUOUS is a FAILED outcome, so the teardown's
    // stop-unsafe gate holds telemetry paused exactly as for any other
    // failed stop.
    const harness = createHarness([[MSP_SET_MOTOR_FIXTURE, REJECT]]);
    await runSetup(harness);
    const closed = await drive(harness, harness.controller.close());
    expect(closed.stopExecution.outcome?.kind).toBe('FAILED');
    expect(closed.stopExecution.commandAcknowledged).toBe(false);
    expect(closed.telemetryHeld).toBe(true);
  });

  it('never sets physicalStopConfirmed, even on a clean ACK', async () => {
    const harness = createHarness();
    await runSetup(harness);
    const closed = await drive(harness, harness.controller.close());
    expect(closed.stopExecution.commandDispatched).toBe(true);
    expect(closed.stopExecution.commandAcknowledged).toBe(true);
    // The three statements stay separate. ACK is reception, not motion.
    expect(closed.stopExecution.physicalStopConfirmed).toBe(false);
  });

  it('a rejected stop fails closed: Fault, no clean close, telemetry held', async () => {
    const harness = createHarness([[MSP_SET_MOTOR_FIXTURE, REJECT]]);
    await runSetup(harness);
    const closed = await drive(harness, harness.controller.close());

    expect(closed.stopExecution.outcome).toEqual({
      kind: 'FAILED',
      reason: 'REQUEST_FAILED',
    });
    expect(closed.stopExecution.commandDispatched).toBe(true);
    expect(closed.stopExecution.commandAcknowledged).toBe(false);
    expect(closed.stopExecution.physicalStopConfirmed).toBe(false);
    // Not a clean close.
    expect(closed.teardown?.complete).toBe(false);
    // Telemetry stays held: never resume onto a link that may be driving.
    expect(closed.teardown?.telemetryTokensReleased).toBe(false);
    expect(harness.scheduler.activeMotorTestLeaseCount).toBe(1);
    expect(closed.machine).toMatchObject({name: 'Fault'});
    expect(closed.outcome).toMatchObject({kind: 'FAILED_CLOSED'});
  });

  it('an unanswered stop fails closed rather than closing cleanly', async () => {
    const harness = createHarness();
    await runSetup(harness);
    // Start close() WITHOUT awaiting, observe the 214 write, then leave it
    // unanswered so the client's own bounded timeout decides.
    const closing = harness.controller.close();
    await flush(20);
    expect(harness.transport.writes).toHaveLength(1);
    expect(writtenCommand(harness.transport.writes[0].data)).toBe(
      MSP_SET_MOTOR_FIXTURE,
    );
    harness.transport.resolveNextWrite();
    await flush(20);
    // Deterministically settle it as a protocol error, the same outcome
    // the client's timeout would produce, so no real timer is needed.
    harness.transport.emitData(errorFrame(MSP_SET_MOTOR_FIXTURE));
    const closed = await drive(harness, closing);

    expect(closed.stopExecution.commandDispatched).toBe(true);
    expect(closed.stopExecution.commandAcknowledged).toBe(false);
    expect(closed.teardown?.complete).toBe(false);
    expect(closed.teardown?.telemetryTokensReleased).toBe(false);
    expect(closed.machine?.name).toBe('Fault');
  });

  it('an unsupported scope dispatches nothing at all', async () => {
    // P2 CLOSURE UPDATE: raw 4 (BRUSHED, analog family) is now a
    // professionally ELIGIBLE runtime, so it no longer models "unusable by
    // everyone". Raw 9 is unrecognised by the pinned resolver, refuses
    // BOTH gates, and preserves this test's actual property: a session
    // neither path can use encodes nothing and dispatches nothing.
    const harness = createHarness([
      [MSP_ADVANCED_CONFIG, reply(advancedConfigPayload(9))],
    ]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome.kind).toBe('BLOCKED');
    expect(harness.commands).not.toContain(MSP_SET_MOTOR_FIXTURE);
    expect(snapshot.stopExecution.commandDispatched).toBe(false);
  });

  it('never dispatches a stop when no lease was ever held', async () => {
    const harness = createHarness();
    harness.identity = undefined;
    const snapshot = await runSetup(harness);
    expect(harness.commands).toHaveLength(0);
    expect(snapshot.stopExecution).toMatchObject({
      attempts: 1,
      commandDispatched: false,
      commandAcknowledged: false,
      physicalStopConfirmed: false,
      outcome: {kind: 'NOT_ATTEMPTED', reason: 'NO_LEASE'},
    });
  });

  it('a detach signal with a live lease still attempts the stop', async () => {
    const harness = createHarness();
    await runSetup(harness);
    // A detach SIGNAL does not by itself kill the lease, and commanding
    // stop is exactly the right thing to attempt on detach.
    harness.invalidate('USB_DETACHED');
    await drive(harness, harness.controller.close());
    const stops = harness.writes.filter(
      w => w.command === MSP_SET_MOTOR_FIXTURE,
    );
    expect(stops).toHaveLength(1);
    expect(stops[0].payload).toEqual(EXPECTED_STOP_PAYLOAD);
  });

  it('a genuinely dead lease produces no new command-214 request', async () => {
    // A rejected lease-scoped read fails the LEASE closed through Pass 2's
    // own automatic route, so by teardown there is no live authority left
    // to command anything through - and teardown must not manufacture one.
    const harness = createHarness([[MSP_BOXIDS, REJECT]]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome).toMatchObject({
      kind: 'FAILED_CLOSED',
      reason: 'BOX_EVIDENCE_UNAVAILABLE',
    });
    expect(
      harness.writes.filter(w => w.command === MSP_SET_MOTOR_FIXTURE),
    ).toHaveLength(0);
    expect(snapshot.stopExecution.outcome).toEqual({
      kind: 'NOT_ATTEMPTED',
      reason: 'AUTHORITY_STALE',
    });
    expect(snapshot.stopExecution.commandDispatched).toBe(false);
  });

  it('concurrent closes join exactly one command-214 operation', async () => {
    const harness = createHarness();
    await runSetup(harness);
    const a = harness.controller.close();
    const b = harness.controller.close();
    const c = harness.controller.close();
    expect(b).toBe(a);
    expect(c).toBe(a);
    const closed = await drive(harness, a);
    expect(
      harness.writes.filter(w => w.command === MSP_SET_MOTOR_FIXTURE),
    ).toHaveLength(1);
    expect(closed.stopExecution.attempts).toBe(1);
  });

  /**
   * REWRITTEN IN P2-ii. The closing assertion was "the arming restriction
   * is gone from the bundle: no establishment at setup, and nothing to
   * settle at teardown". P2-ii restores both halves, so what this test now
   * pins is the ORDER, which is the safety-relevant part and was always
   * the reason the step indices were being compared:
   *
   *   all-stop  ->  release restriction  ->  release lease
   *
   * A restriction released before the stop would re-permit arming while an
   * output could still be commanded, which inverts the entire point of
   * establishing it.
   */
  it('orders teardown all-stop BEFORE the restriction release, and both before the lease', async () => {
    const harness = createHarness();
    await runSetup(harness);
    const closed = await drive(harness, harness.controller.close());
    const steps = closed.teardown?.steps.map(s => s.step) ?? [];
    expect(steps.indexOf('EXECUTE_STOP_VECTOR')).toBeLessThan(
      steps.indexOf('RELEASE_ARMING_RESTRICTION'),
    );
    expect(steps.indexOf('RELEASE_ARMING_RESTRICTION')).toBeLessThan(
      steps.indexOf('RELEASE_LEASE'),
    );
  });

  it('emits no pulse value anywhere on the wire', async () => {
    const harness = createHarness();
    await runSetup(harness);
    await drive(harness, harness.controller.close());
    for (const write of harness.writes) {
      // 1050 little-endian would be 1A 04. No payload may contain it.
      for (let i = 0; i + 1 < write.payload.length; i++) {
        const value = write.payload[i] + write.payload[i + 1] * 256;
        expect(value).not.toBe(1050);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * Same-session ESC direction and truthful diagnostic reads
 * ------------------------------------------------------------------ */

describe('MotorTestController - same-session ESC direction', () => {
  it('writes one persistent reverse command for the selected motor and remains ready', async () => {
    const harness = createHarness();
    await runSetup(harness);

    const changing = harness.controller.setEscDirection(3, 'REVERSED');
    await flush();

    expect(harness.transport.writes).toHaveLength(1);
    const frame = harness.transport.writes[0].data;
    expect(writtenV2Command(frame)).toBe(MSP2_SEND_DSHOT_COMMAND);
    expect(writtenV2Payload(frame)).toEqual([1, 2, 2, 8, 12]);

    harness.transport.resolveNextWrite();
    await flush();
    harness.transport.emitData(v2ResponseFrame(MSP2_SEND_DSHOT_COMMAND));

    await expect(changing).resolves.toEqual({
      kind: 'ACKNOWLEDGED',
      motorNumber: 3,
      direction: 'REVERSED',
      physicallyVerified: false,
    });
    expect(harness.controller.getSnapshot()).toMatchObject({
      phase: 'ACTIVE',
      outcome: {kind: 'READY'},
      activation: {allowed: true},
    });
  });

  it('treats a confirmed firmware rejection as unsupported without poisoning the session', async () => {
    const harness = createHarness();
    await runSetup(harness);

    const changing = harness.controller.setEscDirection(1, 'NORMAL');
    await flush();
    harness.transport.resolveNextWrite();
    await flush();
    harness.transport.emitData(
      v2ResponseFrame(MSP2_SEND_DSHOT_COMMAND, 'error'),
    );

    await expect(changing).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'UNSUPPORTED',
    });
    expect(harness.controller.getSnapshot()).toMatchObject({
      phase: 'ACTIVE',
      outcome: {kind: 'READY'},
      activation: {allowed: true},
    });
  });
});

describe('MotorTestController - live motor diagnostics', () => {
  it('publishes decoded MSP_MOTOR and ESC telemetry values from fresh replies', async () => {
    const harness = createHarness([
      [MSP_MOTOR_CONFIG, reply(motorConfigPayload(4, 1, 1))],
    ]);
    await runSetup(harness);

    const refreshing = harness.controller.refreshDiagnostics();
    await flush();
    expect(writtenCommand(harness.transport.writes[0].data)).toBe(MSP_MOTOR);
    harness.transport.resolveNextWrite();
    await flush();
    harness.transport.emitData(
      responseFrame(
        MSP_MOTOR,
        Uint8Array.from(
          [1000, 1050, 1075, 1100, 1000, 1000, 1000, 1000].flatMap(u16),
        ),
      ),
    );

    await flush();
    expect(writtenCommand(harness.transport.writes[0].data)).toBe(
      MSP_MOTOR_TELEMETRY,
    );
    harness.transport.resolveNextWrite();
    await flush();
    harness.transport.emitData(
      responseFrame(
        MSP_MOTOR_TELEMETRY,
        Uint8Array.from([
          1,
          ...u32(12_345),
          ...u16(125),
          47,
          ...u16(1_680),
          ...u16(1_234),
          ...u16(56),
        ]),
      ),
    );

    await expect(refreshing).resolves.toMatchObject({
      outputs: {
        state: 'FRESH',
        value: {values: [1000, 1050, 1075, 1100, 1000, 1000, 1000, 1000]},
      },
      escTelemetry: {
        state: 'FRESH',
        value: {
          motorCount: 1,
          motors: [
            {
              rpm: 12_345,
              invalidPercentRaw: 125,
              temperatureCelsius: 47,
              voltageCentivolts: 1_680,
              currentCentiamps: 1_234,
              consumptionMah: 56,
            },
          ],
        },
      },
    });
  });

  it('labels confirmed unsupported ESC telemetry without displaying invented values or closing', async () => {
    const harness = createHarness([
      [MSP_MOTOR_CONFIG, reply(motorConfigPayload(4, 1, 0))],
    ]);
    await runSetup(harness);

    const refreshing = harness.controller.refreshDiagnostics();
    await flush();
    harness.transport.resolveNextWrite();
    await flush();
    harness.transport.emitData(
      responseFrame(
        MSP_MOTOR,
        Uint8Array.from(new Array(8).fill(1000).flatMap(u16)),
      ),
    );
    await flush();
    harness.transport.resolveNextWrite();
    await flush();
    harness.transport.emitData(errorFrame(MSP_MOTOR_TELEMETRY));

    await expect(refreshing).resolves.toMatchObject({
      outputs: {state: 'FRESH'},
      escTelemetry: {state: 'UNSUPPORTED', value: undefined},
    });
    expect(harness.controller.getSnapshot()).toMatchObject({
      phase: 'ACTIVE',
      activation: {allowed: true},
    });
  });

  it('does not request command 139 when FC configuration proves no telemetry source', async () => {
    const harness = createHarness();
    await runSetup(harness);
    expect(harness.controller.getSnapshot()).toMatchObject({
      motorDiagnosticsSupport: {
        motorCount: 4,
        dshotTelemetryEnabled: false,
        escSensorEnabled: false,
        escTelemetrySource: 'NONE',
      },
      diagnostics: {escTelemetry: {state: 'NOT_ENABLED'}},
    });

    const refreshing = harness.controller.refreshDiagnostics();
    await flush();
    expect(writtenCommand(harness.transport.writes[0].data)).toBe(MSP_MOTOR);
    harness.transport.resolveNextWrite();
    await flush();
    harness.transport.emitData(
      responseFrame(
        MSP_MOTOR,
        Uint8Array.from(new Array(8).fill(1000).flatMap(u16)),
      ),
    );

    await expect(refreshing).resolves.toMatchObject({
      outputs: {state: 'FRESH'},
      escTelemetry: {state: 'NOT_ENABLED', value: undefined},
    });
    expect(harness.transport.writes).toHaveLength(0);
  });

  it('turns an ambiguous diagnostics link failure during a pulse into an immediate stop fault', async () => {
    const harness = createHarness();
    await runSetup(harness);
    expect(harness.controller.pulseMotor(2)).toBe('ACCEPTED');
    await flush();
    await settlePulseWrite(harness);
    await answer(harness, MSP_SET_MOTOR_FIXTURE);
    expect(harness.controller.getSnapshot().machine?.name).toBe('Pulsing');

    const refreshing = harness.controller.refreshDiagnostics();
    await flush();
    expect(writtenCommand(harness.transport.writes[0].data)).toBe(MSP_MOTOR);
    harness.transport.rejectNextWrite('WRITE_FAILED');
    await refreshing;
    await flush(20);

    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.diagnostics?.outputs.state).toBe('LINK_FAILED');
    expect(snapshot.machine?.name).toBe('Fault');
    expect(snapshot.activation.allowed).toBe(false);
    // The earlier pulse ACK remains an honest historical fact; the failed
    // all-stop is recorded separately and is what makes this terminal.
    expect(snapshot.pulse.outcome).toMatchObject({kind: 'ACKNOWLEDGED'});
    expect(snapshot.stopExecution.attempts).toBe(1);
    expect(snapshot.stopExecution.outcome?.kind).not.toBe('ACKNOWLEDGED');
  });
});

/* ------------------------------------------------------------------ *
 * The public surface
 * ------------------------------------------------------------------ */

describe('MotorTestController - public surface', () => {
  it('exposes exactly the frozen surface: legacy plus the professional facade', () => {
    const controller = createHarness().controller;
    // EXTENDED IN P2-ii by exactly the four professional operations, all
    // thin wrappers over the one session-owned engine. The exact-set
    // assertion is the point: nothing else can be added unnoticed.
    expect(Object.keys(controller).sort()).toEqual([
      'close',
      'getSnapshot',
      'initializeSession',
      // Phase 2G's ONE legacy activating operation. Superseded assertion:
      // this list was five before a pulse path existed.
      'pulseMotor',
      'refreshDiagnostics',
      'renewPulseHold',
      'requestStop',
      'setEscDirection',
      'setMaster',
      'setMotorValue',
      'setMotorValues',
      'stopAll',
      'subscribe',
    ]);
    expect(Object.isFrozen(controller)).toBe(true);
    // It takes an output slot and NOTHING else - no magnitude, no
    // duration, no vector, no command number, no options object.
    expect(controller.pulseMotor).toHaveLength(1);
  });

  it('has no generic dispatcher and no activation operation', () => {
    const controller = createHarness().controller as unknown as Record<
      string,
      unknown
    >;
    for (const forbidden of [
      'dispatch',
      'send',
      'emit',
      'apply',
      'handle',
      'activate',
      'start',
      'startMotor',
      'beginPulse',
      'pulse',
      'arm',
      'write',
      'setMotor',
      'submit',
      'injectState',
      'setState',
      'getLease',
      'getAuthority',
      'getClient',
      'getReceipt',
    ]) {
      expect(controller[forbidden]).toBeUndefined();
    }
  });

  it('rejects a stop trigger outside the whitelist', () => {
    const controller = createHarness().controller;
    type Trigger = Parameters<typeof controller.requestStop>[0];
    for (const smuggled of [
      'ACTIVATION_ACCEPTED',
      'START_WRITE_CALLED',
      'GATES_PASSED',
      '',
    ]) {
      expect(controller.requestStop(smuggled as unknown as Trigger)).toBe(
        'UNRECOGNIZED_STOP_TRIGGER',
      );
    }
  });

  it('accepts every whitelisted stop trigger', async () => {
    const harness = createHarness();
    await runSetup(harness);
    for (const trigger of MOTOR_TEST_CONTROLLER_STOP_TRIGGERS) {
      expect(harness.controller.requestStop(trigger)).toBe('ACCEPTED');
    }
    // A stop in an idle state manufactures no traffic and no descriptor.
    expect(harness.controller.getSnapshot().stopDescriptors).toHaveLength(0);
    expect(harness.commands).not.toContain(MSP_SET_MOTOR_FIXTURE);
  });

  it('exports no way to inject an authority, lease or live state', () => {
    const exported = Object.keys(controllerModule)
      .filter(name => name !== '__esModule')
      .sort();
    expect(exported).toEqual([
      'EMPTY_MOTOR_TEST_EFFECT_RECORD',
      'MOTOR_TEST_CONTROLLER_STOP_TRIGGERS',
      // Phase 2G adds three CONSTANTS and no new injection point: a
      // number, a duration and a frozen list of output slots. None of
      // them accepts an authority, a lease, a client or live state, and
      // none of them is a function.
      'MOTOR_TEST_FIXED_PULSE_VALUE',
      'MOTOR_TEST_HOLD_HEARTBEAT_TIMEOUT_MILLIS',
      'MOTOR_TEST_PULSE_MOTOR_NUMBERS',
      'applyMotorTestEffects',
      'classifyArmedStateObservationFailure',
      'classifyBoxIdsFailure',
      'classifyLeaseFailure',
      'createMotorTestController',
    ]);
  });

  it('notifies subscribers and honours unsubscribe', async () => {
    const harness = createHarness();
    let count = 0;
    const unsubscribe = harness.controller.subscribe(() => {
      count += 1;
    });
    await runSetup(harness);
    expect(count).toBeGreaterThan(0);
    const afterSetup = count;
    unsubscribe();
    await drive(harness, harness.controller.close());
    expect(count).toBe(afterSetup);
  });
});

/* ------------------------------------------------------------------ *
 * Inert effect records - driven by the REAL reducer
 * ------------------------------------------------------------------ */

describe('applyMotorTestEffects', () => {
  /**
   * Drives the REAL reducer along its own accepted path to a live
   * activation, so the REAL SUBMIT_STOP_INTENT effect arrays can be
   * captured. Nothing is injected into a controller anywhere - this is
   * the reducer's own public API.
   */
  function liveStopEffects(): {
    first: readonly MotorTestEffect[];
    second: readonly MotorTestEffect[];
  } {
    const authority = {};
    let state = createMotorTestState(authority);
    state = motorTestTransition(state, {authority, kind: 'GATES_PASSED'}).state;
    state = motorTestTransition(state, {
      authority,
      kind: 'ACTIVATION_ACCEPTED',
    }).state;
    state = motorTestTransition(state, {
      authority,
      kind: 'START_WRITE_CALLED',
    }).state;
    const firstStop = motorTestTransition(state, {
      authority,
      kind: 'STOP_TRIGGERED',
      reason: 'TOUCH_RELEASED',
    });
    const secondStop = motorTestTransition(firstStop.state, {
      authority,
      kind: 'STOP_TRIGGERED',
      reason: 'ANDROID_BACK',
    });
    return {first: firstStop.effects, second: secondStop.effects};
  }

  it('preserves repeated applicable stop descriptors separately', () => {
    const {first, second} = liveStopEffects();
    expect(first).toEqual([{kind: 'SUBMIT_STOP_INTENT'}]);
    expect(second).toEqual([{kind: 'SUBMIT_STOP_INTENT'}]);

    let record = applyMotorTestEffects(
      EMPTY_MOTOR_TEST_EFFECT_RECORD,
      first,
      'TOUCH_RELEASED',
    );
    record = applyMotorTestEffects(record, second, 'ANDROID_BACK');

    expect(record.stopDescriptors).toHaveLength(2);
    expect(record.stopDescriptors[0]).toEqual({
      descriptorKind: 'SUBMIT_STOP_INTENT',
      sequence: 0,
      stopReason: 'TOUCH_RELEASED',
    });
    expect(record.stopDescriptors[1]).toEqual({
      descriptorKind: 'SUBMIT_STOP_INTENT',
      sequence: 1,
      stopReason: 'ANDROID_BACK',
    });
    expect(record.stopDescriptors[0]).not.toBe(record.stopDescriptors[1]);
  });

  it('does not coalesce two identical triggers', () => {
    const {first} = liveStopEffects();
    let record = applyMotorTestEffects(
      EMPTY_MOTOR_TEST_EFFECT_RECORD,
      first,
      'TOUCH_RELEASED',
    );
    record = applyMotorTestEffects(record, first, 'TOUCH_RELEASED');
    expect(record.stopDescriptors).toHaveLength(2);
    expect(record.stopDescriptors[1].sequence).toBe(1);
  });

  it('produces descriptors that hold no executable capability', () => {
    const {first} = liveStopEffects();
    const record = applyMotorTestEffects(
      EMPTY_MOTOR_TEST_EFFECT_RECORD,
      first,
      'TOUCH_RELEASED',
    );
    const descriptor = record.stopDescriptors[0];
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.keys(descriptor).sort()).toEqual([
      'descriptorKind',
      'sequence',
      'stopReason',
    ]);
    for (const value of Object.values(descriptor)) {
      expect(typeof value).not.toBe('function');
      expect(typeof value).not.toBe('object');
    }
  });

  it('records a start effect as a tripwire and never as a descriptor', () => {
    const authority = {};
    let state = createMotorTestState(authority);
    state = motorTestTransition(state, {authority, kind: 'GATES_PASSED'}).state;
    const activation = motorTestTransition(state, {
      authority,
      kind: 'ACTIVATION_ACCEPTED',
    });
    expect(activation.effects).toEqual([{kind: 'SUBMIT_START_INTENT'}]);

    const record = applyMotorTestEffects(
      EMPTY_MOTOR_TEST_EFFECT_RECORD,
      activation.effects,
      undefined,
    );
    expect(record.startEffectObserved).toBe(true);
    expect(record.stopDescriptors).toHaveLength(0);
    expect(record.warnings).toHaveLength(0);
  });

  it('never invents a stop reason for an untriggered stop effect', () => {
    const {first} = liveStopEffects();
    const record = applyMotorTestEffects(
      EMPTY_MOTOR_TEST_EFFECT_RECORD,
      first,
      undefined,
    );
    expect(record.stopDescriptors).toHaveLength(0);
  });

  it('publishes the accepted warning verbatim', () => {
    const authority = {};
    let state = createMotorTestState(authority);
    state = motorTestTransition(state, {authority, kind: 'GATES_PASSED'}).state;
    state = motorTestTransition(state, {
      authority,
      kind: 'ACTIVATION_ACCEPTED',
    }).state;
    state = motorTestTransition(state, {
      authority,
      kind: 'START_WRITE_CALLED',
    }).state;
    const faulted = motorTestTransition(state, {
      authority,
      kind: 'FAULT_RAISED',
      reason: 'USB_DETACHED',
    });
    const record = applyMotorTestEffects(
      EMPTY_MOTOR_TEST_EFFECT_RECORD,
      faulted.effects,
      undefined,
    );
    expect(record.warnings).toHaveLength(1);
    expect(record.warnings[0].message).toBe(MOTOR_TEST_STOP_UNCONFIRMED_WARNING);
    expect(Object.isFrozen(record.warnings[0])).toBe(true);
  });

  it('returns the same record for an empty effect list', () => {
    expect(
      applyMotorTestEffects(EMPTY_MOTOR_TEST_EFFECT_RECORD, [], undefined),
    ).toBe(EMPTY_MOTOR_TEST_EFFECT_RECORD);
  });
});

/* ------------------------------------------------------------------ *
 * Classification
 * ------------------------------------------------------------------ */

describe('failure classification', () => {
  it('locks only where nothing uncertain happened', () => {
    expect(classifyBoxIdsFailure('BOX_IDS_MALFORMED')).toEqual({
      disposition: 'LOCK',
    });
    expect(classifyBoxIdsFailure('BOX_IDS_REQUEST_FAILED')).toEqual({
      disposition: 'FAULT',
      faultReason: 'MSP_RESPONSE_TIMEOUT',
    });
    expect(classifyBoxIdsFailure('MOTOR_TEST_LEASE_INACTIVE')).toEqual({
      disposition: 'FAULT',
      faultReason: 'SESSION_CHANGED',
    });
  });

  it('fails closed for a rejected or session-moved armed-state read', () => {
    // Transport uncertainty and a session that moved under the read are the
    // two cases where "we do not know" must be terminal.
    expect(classifyArmedStateObservationFailure('REQUEST_FAILED')).toEqual({
      disposition: 'FAULT',
      faultReason: 'MSP_RESPONSE_TIMEOUT',
    });
    expect(
      classifyArmedStateObservationFailure('SESSION_IDENTITY_CHANGED')
        .disposition,
    ).toBe('FAULT');
    expect(
      classifyArmedStateObservationFailure('SESSION_IDENTITY_UNAVAILABLE')
        .disposition,
    ).toBe('FAULT');
  });

  it('locks - never faults - for complete but unusable armed-state evidence', () => {
    // A read that answered badly leaves nothing pending on the aircraft, so
    // claiming the uncertainty a fault asserts would be false.
    for (const reason of [
      'ARMING_BOX_MAPPING_REQUIRED',
      'ARMED_STATE_UNOBSERVABLE',
      'MALFORMED_RESPONSE',
    ] as const) {
      expect(classifyArmedStateObservationFailure(reason)).toEqual({
        disposition: 'LOCK',
      });
    }
  });

  it('classifies lease failures conservatively', () => {
    expect(classifyLeaseFailure('MOTOR_TEST_LEASE_FAULT_LATCHED')).toEqual({
      disposition: 'FAULT',
      faultReason: 'DESYNCHRONIZED',
    });
    expect(classifyLeaseFailure('MOTOR_TEST_LEASE_ALREADY_HELD')).toEqual({
      disposition: 'LOCK',
    });
    expect(classifyLeaseFailure('MSP_CLIENT_UNAVAILABLE').disposition).toBe(
      'FAULT',
    );
  });
});

/* ------------------------------------------------------------------ *
 * Firmware identity and versioned adapter gate
 * ------------------------------------------------------------------ */

describe('the versioned motor firmware gate', () => {
  it('handles synchronous identification publication without leaking its subscription', async () => {
    const harness = createHarness([], {
      firmwareIdentification: {status: 'RUNNING'},
      firmwareIdentificationOnSubscribe: {
        status: 'SUCCEEDED',
        identity: betaflightApi147Identity(),
      },
    });

    const snapshot = await runSetup(harness);

    expect(snapshot.outcome.kind).toBe('READY');
    expect(harness.firmwareIdentificationListenerCount()).toBe(0);
    expect(snapshot.firmwareCompatibility).toMatchObject({
      status: 'SUPPORTED',
      adapterId: 'BETAFLIGHT_API_1_47',
    });
  });

  it('waits for the coordinator identification result before any MSP request', async () => {
    const harness = createHarness([], {
      firmwareIdentification: {status: 'RUNNING'},
    });
    const setup = harness.controller.initializeSession();
    await flush(10);

    expect(harness.controller.getSnapshot().setupStep).toBe(
      'FIRMWARE_COMPATIBILITY',
    );
    expect(harness.commands).toEqual([]);
    expect(harness.transport.writes).toEqual([]);

    harness.setFirmwareIdentification({
      status: 'SUCCEEDED',
      identity: betaflightApi147Identity(),
    });
    const snapshot = await drive(harness, setup);
    expect(snapshot.outcome.kind).toBe('READY');
    expect(snapshot.firmwareCompatibility).toMatchObject({
      status: 'SUPPORTED',
      adapterId: 'BETAFLIGHT_API_1_47',
    });
  });

  it('refuses INAV before pausing telemetry, leasing, or sending any request', async () => {
    const identity = betaflightApi147Identity();
    const harness = createHarness([], {
      firmwareIdentification: {
        status: 'SUCCEEDED',
        identity: {
          ...identity,
          apiVersion: {
            ...identity.apiVersion,
            apiVersionMajor: 2,
            apiVersionMinor: 5,
          },
          firmware: {identifier: 'INAV', knownFamily: 'INAV'},
        },
      },
    });
    const snapshot = await runSetup(harness);

    expect(snapshot.outcome).toMatchObject({
      kind: 'BLOCKED',
      reason: 'FIRMWARE_UNSUPPORTED',
    });
    expect(snapshot.firmwareCompatibility).toMatchObject({
      status: 'UNSUPPORTED',
      reason: 'FIRMWARE_FAMILY_UNSUPPORTED',
    });
    expect(snapshot.activation.reasons).toContain('FIRMWARE_UNSUPPORTED');
    expect(harness.commands).toEqual([]);
    expect(harness.scheduler.leases).toEqual([]);
  });

  it('admits the separately reviewed Betaflight API-1.48 bench adapter', async () => {
    const identity = betaflightApi147Identity();
    const harness = createHarness([], {
      firmwareIdentification: {
        status: 'SUCCEEDED',
        identity: {
          ...identity,
          apiVersion: {...identity.apiVersion, apiVersionMinor: 48},
        },
      },
    });
    const snapshot = await runSetup(harness);

    expect(snapshot.firmwareCompatibility).toMatchObject({
      status: 'SUPPORTED',
      adapterId: 'BETAFLIGHT_API_1_48',
    });
    expect(snapshot.outcome.kind).toBe('READY');
    expect(snapshot.activation.allowed).toBe(true);
  });

  it('admits the separately reviewed Betaflight API-1.46 bench adapter', async () => {
    const identity = betaflightApi147Identity();
    const harness = createHarness([], {
      firmwareIdentification: {
        status: 'SUCCEEDED',
        identity: {
          ...identity,
          apiVersion: {...identity.apiVersion, apiVersionMinor: 46},
        },
      },
    });
    const snapshot = await runSetup(harness);

    expect(snapshot.firmwareCompatibility).toMatchObject({
      status: 'SUPPORTED',
      adapterId: 'BETAFLIGHT_API_1_46',
    });
    expect(snapshot.outcome.kind).toBe('READY');
    expect(snapshot.activation.allowed).toBe(true);
  });

  it('refuses an unverified future Betaflight API before all requests', async () => {
    const identity = betaflightApi147Identity();
    const harness = createHarness([], {
      firmwareIdentification: {
        status: 'SUCCEEDED',
        identity: {
          ...identity,
          apiVersion: {...identity.apiVersion, apiVersionMinor: 49},
        },
      },
    });
    const snapshot = await runSetup(harness);

    expect(snapshot.firmwareCompatibility).toMatchObject({
      status: 'UNSUPPORTED',
      reason: 'API_VERSION_UNVERIFIED',
    });
    expect(harness.commands).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Motor scope - the only configuration the encoder depends on
 * ------------------------------------------------------------------ */

describe('the motor scope gate', () => {
  /**
   * REWRITTEN FOR THE P2 CLOSURE. These three used to assert that ONE gate
   * refused the whole session. There are now two consumers with two
   * truthful eligibilities: the professional runtime (P1 domain + runtime
   * scope) and the legacy pulse UI (exactly four DShot motors, non-3D).
   * The session refuses outright only when NEITHER can use it.
   */
  it('blocks and never writes when the motor protocol is unrecognized', async () => {
    const harness = createHarness([
      [MSP_ADVANCED_CONFIG, reply(advancedConfigPayload(9))],
    ]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome.kind).toBe('BLOCKED');
    expect(snapshot.outcome).toMatchObject({reason: 'MOTOR_SCOPE_UNSUPPORTED'});
    expect(harness.commands).not.toContain(MSP_SET_MOTOR_FIXTURE);
  });

  it('motor count 6: session proceeds professionally, legacy gate still refuses', async () => {
    const harness = createHarness([[MSP_MOTOR_CONFIG, reply(motorConfigPayload(6))]]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome).toEqual({kind: 'READY'});
    expect(snapshot.motorScope?.motorCount).toBe(6);
    expect(snapshot.activation.allowed).toBe(false);
    expect(snapshot.activation.reasons).toContain('MOTOR_SCOPE_UNSUPPORTED');
    expect(harness.controller.pulseMotor(1)).not.toBe('ACCEPTED');
  });

  it('digital 3D: session proceeds, legacy 3D reason still bars the old UI', async () => {
    const harness = createHarness([
      [MSP_FEATURE_CONFIG, reply(Uint8Array.from(u32(FEATURE_3D_BIT)))],
    ]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome).toEqual({kind: 'READY'});
    // The scope is RETAINED so the gate can name 3D specifically.
    expect(snapshot.motorScope?.feature3dEnabled).toBe(true);
    expect(snapshot.activation.allowed).toBe(false);
    expect(snapshot.activation.reasons).toContain('MOTOR_3D_ENABLED');
    expect(harness.controller.pulseMotor(1)).not.toBe('ACCEPTED');
  });

  it('reads exactly the three configuration commands the encoder needs', async () => {
    const harness = createHarness();
    await runSetup(harness);
    const configReads = harness.commands.filter(command =>
      [MSP_MOTOR_CONFIG, MSP_ADVANCED_CONFIG, MSP_FEATURE_CONFIG].includes(
        command,
      ),
    );
    expect(configReads).toEqual([
      MSP_MOTOR_CONFIG,
      MSP_ADVANCED_CONFIG,
      MSP_FEATURE_CONFIG,
    ]);
    // The long identification/capability chain is gone: none of these is
    // requested any more, and none of them ever affected encoding.
    for (const removed of [
      MSP_API_VERSION,
      MSP_FC_VARIANT,
      MSP_FC_VERSION,
      MSP_BOARD_INFO,
      MSP_MIXER_CONFIG,
      MSP_BATTERY_STATE,
    ]) {
      expect(harness.commands).not.toContain(removed);
    }
  });

  /**
   * REWRITTEN IN P2-ii. It asserted command 99 is never sent. The
   * restriction is restored, so the true statement is now about POLARITY
   * and COUNT: exactly one establish, carrying [1], and never [0] during
   * setup - a release issued at bring-up would undo the very protection
   * being established.
   */
  it('establishes the arming restriction exactly once, with payload [1]', async () => {
    const harness = createHarness();
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome.kind).toBe('READY');
    const writes = harness.writes.filter(
      write => write.command === MSP_SET_ARMING_DISABLED_FIXTURE,
    );
    expect(writes).toHaveLength(1);
    // 1 DISABLES arming. Polarity is inverted from the command name.
    expect(writes[0].payload).toEqual([1]);
  });
});

/* ------------------------------------------------------------------ *
 * Containment - proven against the production source, not its comments
 * ------------------------------------------------------------------ */

describe('containment', () => {
  /** Comments describe what the module must NOT do, so they are removed
   * before any forbidden-token scan; only executable text is examined. */
  function stripComments(text: string): string {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  }

  const raw = readFileSync(join(__dirname, 'motorTestController.ts'), 'utf8');
  const code = stripComments(raw);
  const testRaw = readFileSync(
    join(__dirname, 'motorTestController.test.ts'),
    'utf8',
  );

  it('introduces no second MSP requester and no parallel writer', () => {
    // ONE REQUESTER FOR THE WHOLE BUNDLE. The monitor is constructed with
    // the very lease every configuration read, the box read, the pulse and
    // the emergency stop travel, so the MSP request path stays serialized
    // and a stop can still displace whatever is on the wire.
    expect(code).toMatch(/createSafetyMonitor\(\{\s*requester: lease,/);
    // `requester:` appears exactly once in this file - there is no second
    // place a requester could be handed to anything.
    expect(code.match(/requester:/g) ?? []).toHaveLength(1);

    // Nothing here can build a client, a transport or a second lease.
    for (const forbidden of [
      'new MspClient',
      'acquireMotorTestLease({client: undefined',
      'writeBytes',
      'createMspTelemetryScheduler',
    ]) {
      expect(code).not.toContain(forbidden);
    }
    // Exactly one lease is ever acquired.
    expect(code.match(/acquireMotorTestLease\(/g) ?? []).toHaveLength(1);
    // FINAL P2-ii STATE: the controller no longer holds ANY emergency-stop
    // call site. The canonical priority stop lives in the engine, which is
    // where the single \`.emergencyStop(\` route is asserted (its own suite
    // and the boundary scan pin that). Zero here is the migration's end
    // state, not a loosening.
    expect(code.match(/\.emergencyStop\(/g) ?? []).toHaveLength(0);
  });

  it('contains no motor-command capability beyond the authorised stop', () => {
    for (const forbidden of [
      'MotorSafetyBridge',
      // No controller-level raw write, ever. The only way out of this
      // file is the lease.
      'writeBytes',
      // No repeating timer and no frame loop: a pulse is a single bounded
      // episode, never something that re-arms itself.
      'setInterval',
      'requestAnimationFrame',
    ]) {
      expect(code).not.toContain(forbidden);
    }
    // SUPERSEDED: setTimeout was forbidden outright before a pulse
    // existed. It is now required - the lost-touch heartbeat fail-safe
    // cannot exist without a timer - so the assertion is narrowed rather
    // than dropped: exactly ONE arm site and ONE clear site, both on the
    // pulse deadline.
    // THREE timer sites, all accounted for and none hidden: the pulse
    // deadline, the safety monitor's injected scheduler, and the bounded
    // wait for the coordinator's firmware identification result.
    expect(code.match(/setTimeout\(/g) ?? []).toHaveLength(3);
    expect(code.match(/clearTimeout\(/g) ?? []).toHaveLength(3);
    // The monitor's pair is an INJECTION into the monitor, never a timer
    // this controller arms against a motor output itself.
    expect(code).toMatch(/setTimer:\s*\(callback, delayMs\) =>\s*setTimeout\(callback, delayMs\)/);
    expect(code).toMatch(/clearTimer:\s*handle =>\s*clearTimeout\(/);
    expect(code).toContain('MOTOR_TEST_HOLD_HEARTBEAT_TIMEOUT_MILLIS');

    // Command 214 is never a numeric literal here.
    expect(code).not.toMatch(/\b214\b/);
    // The stop value is NEVER written here - it comes from the protected
    // accepted vector module, which is the only place that knows it.
    expect(code).not.toMatch(/\b1000\b/);
    // SUPERSEDED: 1050 was forbidden before a pulse existed. It now
    // appears EXACTLY ONCE, as the single authorized fixed constant, and
    // nowhere else - no second copy, no derivation, no scaling.
    expect(code.match(/\b1050\b/g) ?? []).toHaveLength(1);
    expect(code).toMatch(/MOTOR_TEST_FIXED_PULSE_VALUE = 1050;/);
    // No value above the approved fixed pulse exists anywhere.
    // 1200 is a time-only lost-heartbeat bound, not a motor magnitude.
    for (const forbiddenValue of [1100, 1500, 1800, 2000]) {
      expect(code).not.toMatch(new RegExp(`\\b${forbiddenValue}\\b`));
    }
    // Phase 2G: exactly TWO dispatch sites exist in this whole file - the
    // UPDATED IN P2-ii STEP 4. This used to be THREE mentions: the import,
    // the legacy pulse's own `lease.request(MSP_SET_MOTOR, ...)`, and the
    // stop. The legacy direct write is GONE - the pulse now routes through
    // MotorControlCommandEngine, which owns that dispatch - so the
    // controller retains exactly two: the import and the canonical
    // priority stop. The count shrinking is the migration's whole point,
    // and pinning it here is what stops a direct writer reappearing.
    // FINAL P2-ii STATE: down from 3 (import + pulse + stop) to ZERO.
    // Even the import is gone - the controller encodes and dispatches no
    // motor frame by any route, so the symbol has nothing to be consumed
    // by. Both write routes live in the engine.
    expect(code.match(/\bMSP_SET_MOTOR\b/g) ?? []).toHaveLength(0);
    // And there is no motor request left in this file by ANY route.
    expect(code).not.toMatch(/lease\.request\(\s*MSP_SET_MOTOR/);
    expect(code).not.toMatch(/emergencyStop\(\s*MSP_SET_MOTOR/);
    // FINAL P2-ii STATE: zero stop dispatches here. The priority route is
    // the engine's, asserted in its own suite and by the boundary scan.
    expect(code.match(/lease\.emergencyStop\(/g) ?? []).toHaveLength(0);
    // REWRITTEN IN P2-ii STEP 4. This asserted "exactly one pulse
    // dispatch, on the ORDINARY route" - true when the controller owned
    // the pulse write. It owns NO active motor dispatch any more: the
    // legacy pulse routes through MotorControlCommandEngine, which keeps
    // that same ordinary-route-vs-priority-stop split (proven in
    // motorControlCommandEngine.test.ts). The controller's remaining
    // motor traffic is the canonical stop, asserted above.
    //
    // The property is preserved and now stated as an absence, which is
    // strictly stronger: this file may not dispatch an active vector at
    // all, by any route.
    expect(code).not.toMatch(/lease\.request\(\s*MSP_SET_MOTOR/);
    expect(code).not.toContain('buildSingleMotorVector');
    // The single-output vector now comes from the P1 domain builder, and
    // is handed to the engine rather than encoded here.
    expect(code).toContain('buildSingleOutputVectorForDomain');
    expect(code).toContain('MotorControlCommandEngine');
    // FINAL P2-ii STATE: the encode symbols left this file with the
    // dispatches - the engine imports them now, under the boundary scan's
    // allowlist. The legacy scope guard alone remains, because refusing a
    // configuration is still this controller's job.
    expect(code).not.toContain('buildAllStopVector');
    expect(code).not.toContain('encodeSetMotorPayload');
    expect(code).toContain('assertSupportedMotorScope');
  });

  it('constructs exactly the three accepted activation events, and never fabricates a stop acknowledgement', () => {
    // SUPERSEDED BY THE PULSE LIFECYCLE. Before Phase 2G this file could
    // construct no activation event at all. It now constructs exactly
    // three, each exactly once, in the accepted order.
    for (const required of [
      'ACTIVATION_ACCEPTED',
      'START_WRITE_CALLED',
      'START_ACKNOWLEDGED',
    ]) {
      expect(code.match(new RegExp(`'${required}'`, 'g')) ?? []).toHaveLength(1);
    }
    expect(code.indexOf("'ACTIVATION_ACCEPTED'")).toBeLessThan(
      code.indexOf("'START_WRITE_CALLED'"),
    );

    // STOP_ACKNOWLEDGED IS NOW CONSTRUCTED, AND THE GUARD IS STRONGER
    // RATHER THAN GONE.
    //
    // It used to be forbidden outright, which was correct while nothing
    // could produce an attributable acknowledgement - but it also meant
    // the reducer could never leave `Stopping`, so a perfect release left
    // the session unusable and a second motor needed a whole new one.
    //
    // The safety meaning is preserved by CONFINEMENT instead: exactly one
    // construction site, inside one private helper, reached from exactly
    // one place - the stop operation's own ACKNOWLEDGED outcome. No timer,
    // no UI event, no late frame and no caller can reach it.
    expect(code.match(/'STOP_ACKNOWLEDGED'/g) ?? []).toHaveLength(1);
    expect(code).toMatch(
      /private dispatchStopAcknowledged\(\)[\s\S]{0,400}?kind: 'STOP_ACKNOWLEDGED'/,
    );
    expect(code.match(/this\.dispatchStopAcknowledged\(\)/g) ?? []).toHaveLength(1);
    // ... and that one call site is guarded by the acknowledged outcome.
    expect(code).toMatch(
      /outcome\.kind === 'ACKNOWLEDGED'[\s\S]{0,1200}?this\.dispatchStopAcknowledged\(\)/,
    );

    // RECHECK_REQUESTED stays forbidden outright: no self-clearing
    // re-arm path exists.
    for (const forbidden of ['RECHECK_REQUESTED']) {
      expect(code).not.toContain(forbidden);
    }
  });

  it('introduces no React or React Native dependency into src/core', () => {
    expect(raw).not.toMatch(/from '(react|react-native)[^']*'/);
  });

  it('sends every request through the lease, never a raw client', () => {
    expect(code).toContain('lease.request(');
    expect(code).not.toMatch(/\bclient\.request\(/);
    expect(code).not.toMatch(/\btransport\./);
  });

  it('carries no raw NUL byte, no suppression and no skipped test', () => {
    for (const contents of [raw, testRaw]) {
      expect(contents).not.toContain('\u0000');
    }
    expect(raw).not.toContain(['@ts', 'ignore'].join('-'));
    expect(raw).not.toContain(['eslint', 'disable'].join('-'));
    expect(testRaw).not.toMatch(/\b(it|describe|test)\.(only|skip|todo)\b/);
    expect(testRaw).not.toMatch(/\bxit\b/);
  });

  it('is imported by nothing but its own test', () => {
    const repoRoot = join(__dirname, '..', '..', '..');
    for (const relative of [
      'src/core/index.ts',
      'src/core/state/index.ts',
      'src/core/protocol/index.ts',
      'App.tsx',
    ]) {
      const contents = readFileSync(join(repoRoot, relative), 'utf8');
      expect(contents).not.toContain('motorTestController');
    }
  });
});

/* ------------------------------------------------------------------ *
 * Phase 2G Pass 2 - THE FIXED SINGLE-MOTOR PULSE ENGINE
 *
 * NO HARDWARE. No USB, no flight controller, no ESC, no LiPo, no motor,
 * no emulator, no device. Every byte is hand-built in memory and every
 * transport settlement is explicit.
 *
 * NOTHING HERE IS A PHYSICAL CLAIM. The payloads below identify MSP
 * OUTPUT SLOTS. They do not establish frame position, rotation direction,
 * motor mapping, RPM or temperature, and no assertion in this file says
 * otherwise - that evidence requires Phase 2I plus hardware observation.
 * ------------------------------------------------------------------ */

const PULSE_BYTES = [0x1a, 0x04]; // 1050, little-endian
const STOP_BYTES = [0xe8, 0x03]; // 1000, little-endian

const EXPECTED_PULSE_PAYLOADS: Readonly<Record<number, number[]>> = Object.freeze(
  {
    1: [...PULSE_BYTES, ...STOP_BYTES, ...STOP_BYTES, ...STOP_BYTES],
    2: [...STOP_BYTES, ...PULSE_BYTES, ...STOP_BYTES, ...STOP_BYTES],
    3: [...STOP_BYTES, ...STOP_BYTES, ...PULSE_BYTES, ...STOP_BYTES],
    4: [...STOP_BYTES, ...STOP_BYTES, ...STOP_BYTES, ...PULSE_BYTES],
  },
);

/** Every writeBytes() invocation, in order - `transport.writes` is
 * shifted as each settles, so only the log proves submission order. */
function submittedCommands(harness: Harness): number[] {
  return harness.transport.writeLog.map(writtenCommand);
}

function submittedPayloads(harness: Harness, command: number): number[][] {
  return harness.transport.writeLog
    .filter(data => writtenCommand(data) === command)
    .map(data => Array.from(data.subarray(5, 5 + data[3])));
}

/** Settles the oldest outstanding transport write WITHOUT answering it,
 * so the request sits in AWAITING_RESPONSE - the state a real pulse is in
 * while the operator is still holding the control. */
async function settlePulseWrite(harness: Harness): Promise<void> {
  harness.transport.resolveNextWrite();
  await flush();
}

async function answer(harness: Harness, command: number): Promise<void> {
  harness.transport.emitData(responseFrame(command, EMPTY));
  await flush();
}

/** Setup, then one accepted activation left in AWAITING_RESPONSE. */
async function pulseAwaitingAck(
  harness: Harness,
  motor = 1,
): Promise<MotorTestPulseRequestResult> {
  await runSetup(harness);
  const result = harness.controller.pulseMotor(motor);
  await flush();
  await settlePulseWrite(harness);
  return result;
}

describe('Phase 2G - pulse vectors are byte-exact', () => {
  it.each([1, 2, 3, 4])(
    'encodes motor %i as exactly one slot at 1050 and the rest at 1000',
    async motor => {
      const harness = createHarness();
      await runSetup(harness);
      expect(harness.controller.pulseMotor(motor)).toBe('ACCEPTED');
      await flush();

      const payloads = submittedPayloads(harness, MSP_SET_MOTOR_FIXTURE);
      expect(payloads).toHaveLength(1);
      expect(payloads[0]).toEqual(EXPECTED_PULSE_PAYLOADS[motor]);
      expect(payloads[0]).toHaveLength(8);

      // Decoded back: exactly one value above stop, and it is 1050.
      const values: number[] = [];
      for (let i = 0; i < 8; i += 2) {
        values.push(payloads[0][i] + payloads[0][i + 1] * 256);
      }
      expect(values.filter(v => v > 1000)).toEqual([1050]);
      expect(values.filter(v => v === 1000)).toHaveLength(3);
      // Little-endian: low byte first.
      expect(PULSE_BYTES[0]).toBe(1050 % 256);
      expect(PULSE_BYTES[1]).toBe(Math.floor(1050 / 256));
      // The selected slot is the requested one, and only that one.
      expect(values.indexOf(1050)).toBe(motor - 1);

      // Disarm the hold-heartbeat watchdog before the test ends. A live timer
      // outliving its test is exactly the open handle requirement 22
      // forbids - and leaving one here would also mean this suite depended
      // on real elapsed time.
      harness.controller.requestStop('STOP_BUTTON_PRESSED');
      await flush();
    },
  );

  it('never encodes more than one active output, at any motor', async () => {
    for (const motor of [1, 2, 3, 4]) {
      const harness = createHarness();
      await runSetup(harness);
      harness.controller.pulseMotor(motor);
      await flush();
      const payload = submittedPayloads(harness, MSP_SET_MOTOR_FIXTURE)[0];
      const above = [0, 2, 4, 6]
        .map(i => payload[i] + payload[i + 1] * 256)
        .filter(v => v > 1000);
      expect(above).toHaveLength(1);
      expect(above[0]).toBe(1050);
      expect(above[0]).toBeLessThanOrEqual(1050);
      harness.controller.requestStop('STOP_BUTTON_PRESSED');
      await flush();
    }
  });

  it('encodes the stop as all four slots at 1000', async () => {
    const harness = createHarness();
    await pulseAwaitingAck(harness);
    harness.controller.requestStop('TOUCH_RELEASED');
    await flush();
    const payloads = submittedPayloads(harness, MSP_SET_MOTOR_FIXTURE);
    expect(payloads[payloads.length - 1]).toEqual([
      ...STOP_BYTES,
      ...STOP_BYTES,
      ...STOP_BYTES,
      ...STOP_BYTES,
    ]);
  });
});

describe('Phase 2G - activation refusals dispatch nothing', () => {
  it.each([0, 5, -1, 1.5, NaN, Number.POSITIVE_INFINITY])(
    'refuses motor %p with no write at all',
    async motor => {
      const harness = createHarness();
      await runSetup(harness);
      const before = harness.transport.writeLog.length;
      expect(harness.controller.pulseMotor(motor)).toBe('INVALID_MOTOR');
      await flush();
      expect(harness.transport.writeLog).toHaveLength(before);
        expect(harness.controller.getSnapshot().pulse.submitted).toBe(false);
      expect(harness.controller.getSnapshot().pulse.attemptId).toBe(0);
    },
  );

  it('refuses to pulse when the profile never reached Ready', async () => {
    // An unsupported mixer blocks setup, so no pulse may ever be
    // attempted - and nothing is written when one is requested.
    const harness = createHarness([[MSP_MOTOR_CONFIG, REJECT]]);
    await runSetup(harness);
    expect(harness.controller.getSnapshot().outcome.kind).not.toBe('READY');
    const before = harness.transport.writeLog.length;
    const result = harness.controller.pulseMotor(1);
    expect(['GATES_NOT_SATISFIED', 'NOT_READY', 'CONTROLLER_CLOSED']).toContain(
      result,
    );
    await flush();
    expect(harness.transport.writeLog).toHaveLength(before);
    expect(submittedCommands(harness)).not.toContain(MSP_SET_MOTOR_FIXTURE);
  });

  it('refuses to pulse once a safety stop has moved the machine out of Ready', async () => {
    const harness = createHarness();
    await runSetup(harness);
    harness.controller.requestStop('ARMED_STATE_DETECTED');
    await flush();
    const before = harness.transport.writeLog.length;
    // The accepted reducer deliberately leaves `Ready` unchanged here -
    // nothing was submitted, so it must not manufacture stop traffic. The
    // CONTROLLER's own activation bar is what refuses: the precondition
    // that event invalidated has not come back, so the session is
    // terminally REQUIRES_NEW_CONNECTION.
    expect(harness.controller.pulseMotor(1)).toBe('NOT_READY');
    await flush();
    expect(harness.transport.writeLog).toHaveLength(before);
  });

  it('refuses to pulse after the controller is closing or closed', async () => {
    const harness = createHarness();
    await runSetup(harness);
    await drive(harness, harness.controller.close());
    expect(harness.controller.pulseMotor(1)).toBe('CONTROLLER_CLOSED');
    expect(harness.controller.getSnapshot().pulse.submitted).toBe(false);
  });
});

describe('Phase 2G - the renewable hold heartbeat', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('arms the deadline at submission start, not at acknowledgement', async () => {
    const harness = createHarness();
    await runSetup(harness);
    expect(jest.getTimerCount()).toBe(0);

    harness.controller.pulseMotor(1);
    // Armed synchronously, in the same call that submits - BEFORE the
    // write has settled and long before any acknowledgement exists.
    expect(jest.getTimerCount()).toBe(1);
    expect(harness.controller.getSnapshot().pulse).toMatchObject({
      submitted: true,
      acknowledged: false,
      deadlineArmedAtSubmission: true,
      mayHaveReachedFc: true,
    });
  });

  it('keeps a healthy held pulse alive beyond three seconds and stops after heartbeat loss', async () => {
    const harness = createHarness();
    await runSetup(harness);
    harness.controller.pulseMotor(1);
    await flush();
    await settlePulseWrite(harness);
    // The pulse is acknowledged first. From here duration is owned by the
    // original touch, not by an arbitrary three-second cap.
    await answer(harness, MSP_SET_MOTOR_FIXTURE);
    const beforeDeadline = submittedCommands(harness).length;

    for (let elapsed = 0; elapsed < 6_000; elapsed += 900) {
      jest.advanceTimersByTime(900);
      await flush();
      expect(harness.controller.renewPulseHold()).toBe('RENEWED');
      expect(submittedCommands(harness)).toHaveLength(beforeDeadline);
      expect(harness.controller.getSnapshot().machine?.name).toBe('Pulsing');
    }

    jest.advanceTimersByTime(MOTOR_TEST_HOLD_HEARTBEAT_TIMEOUT_MILLIS - 1);
    await flush();
    expect(submittedCommands(harness)).toHaveLength(beforeDeadline);

    jest.advanceTimersByTime(1);
    await flush();
    // Heartbeat silence registers and submits the all-stop immediately
    // when the short fail-safe window expires.
    expect(submittedCommands(harness)).toHaveLength(beforeDeadline + 1);
    expect(submittedCommands(harness)[beforeDeadline]).toBe(
      MSP_SET_MOTOR_FIXTURE,
    );
    expect(harness.controller.getSnapshot().machine?.name).not.toBe('Pulsing');
  });

  it('cannot use a heartbeat to start or resurrect a pulse', async () => {
    const harness = createHarness();
    expect(harness.controller.renewPulseHold()).toBe('NO_ACTIVE_PULSE');
    await runSetup(harness);
    const writesAfterSetup = harness.transport.writeLog.length;
    expect(harness.controller.renewPulseHold()).toBe('NO_ACTIVE_PULSE');
    expect(harness.transport.writeLog).toHaveLength(writesAfterSetup);
  });

  it('leaves no timer behind after a stop, a close, a detach or a fault', async () => {
    const stopped = createHarness();
    await runSetup(stopped);
    stopped.controller.pulseMotor(1);
    expect(jest.getTimerCount()).toBe(1);
    stopped.controller.requestStop('TOUCH_RELEASED');
    expect(jest.getTimerCount()).toBe(0);

    const closed = createHarness();
    await runSetup(closed);
    closed.controller.pulseMotor(2);
    expect(jest.getTimerCount()).toBe(1);
    closed.controller.close().catch(() => undefined);
    await flush();
    expect(jest.getTimerCount()).toBe(0);

    const invalidated = createHarness();
    await runSetup(invalidated);
    invalidated.controller.pulseMotor(3);
    expect(jest.getTimerCount()).toBe(1);
    invalidated.invalidate('USB_DETACHED');
    await flush();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not wait out the deadline after an earlier pulse failure', async () => {
    const harness = createHarness();
    await runSetup(harness);
    harness.controller.pulseMotor(1);
    await flush();
    // The pulse write itself fails outright.
    harness.transport.rejectNextWrite('WRITE_FAILED');
    await flush(20);

    // The timer is already gone - the stop route ran immediately rather
    // than leaving a possibly-live output commanded for the full window.
    expect(jest.getTimerCount()).toBe(0);
    expect(harness.controller.getSnapshot().pulse.outcome).toMatchObject({
      kind: 'FAILED',
    });
  });
});

describe('Phase 2G - stop dominance', () => {
  it('registers the stop synchronously, before anything is awaited', async () => {
    const harness = createHarness();
    await pulseAwaitingAck(harness);
    const before = submittedCommands(harness).length;

    // No await between the trigger and the assertion.
    harness.controller.requestStop('TOUCH_RELEASED');
    expect(harness.transport.writeLog).toHaveLength(before + 1);
    expect(submittedCommands(harness)[before]).toBe(MSP_SET_MOTOR_FIXTURE);
    expect(submittedPayloads(harness, MSP_SET_MOTOR_FIXTURE).pop()).toEqual(
      EXPECTED_STOP_PAYLOAD,
    );
  });

  it('stops while the pulse write is still in flight, without a second concurrent write', async () => {
    const harness = createHarness();
    await runSetup(harness);
    harness.controller.pulseMotor(1);
    await flush();
    const duringWrite = harness.transport.writeLog.length;
    expect(harness.transport.writes).toHaveLength(1); // unsettled

    harness.controller.requestStop('STOP_BUTTON_PRESSED');
    await flush();
    // The uncancellable write is NOT raced.
    expect(harness.transport.writeLog).toHaveLength(duringWrite);

    harness.transport.resolveNextWrite();
    await flush();
    // Now the stop is the next submission.
    expect(harness.transport.writeLog).toHaveLength(duringWrite + 1);
    expect(submittedCommands(harness)[duringWrite]).toBe(MSP_SET_MOTOR_FIXTURE);

    // The record only carries the displacement facts once the stop has
    // settled, so complete it before reading them. A displaced 214 makes
    // the first exchange ambiguous, so the operation issues one confirming
    // all-stop - two answers, not one.
    await settlePulseWrite(harness);
    await answer(harness, MSP_SET_MOTOR_FIXTURE);
    await flush(20);
    await answer(harness, MSP_SET_MOTOR_FIXTURE);
    await flush(20);
    expect(
      harness.controller.getSnapshot().stopExecution.deferredBehindActiveWrite,
    ).toBe(true);
  });

  it('releases during Starting, before any pulse acknowledgement', async () => {
    const harness = createHarness();
    await runSetup(harness);
    harness.controller.pulseMotor(1);
    await flush();
    // The ACCEPTED reducer enters `Pulsing` at the WRITE CALL, not at the
    // acknowledgement - deliberately, because that is when the command may
    // be live and when the deadline begins (reduceStarting's own comment).
    // What must never happen is an acknowledgement flag being set for an
    // attempt that was never attributably acknowledged.
    expect(harness.controller.getSnapshot().machine).toMatchObject({
      name: 'Pulsing',
      startAcknowledged: false,
    });

    harness.controller.requestStop('TOUCH_RELEASED');
    await flush();
    expect(harness.controller.getSnapshot().machine?.name).not.toBe('Pulsing');
    expect(harness.controller.getSnapshot().pulse).toMatchObject({
      acknowledged: false,
      outcome: {kind: 'FAILED', reason: 'STOP_DOMINATED'},
    });
  });

  it('never lets a stale pulse acknowledgement re-enter Pulsing or cancel the stop', async () => {
    const harness = createHarness();
    await pulseAwaitingAck(harness);
    harness.controller.requestStop('TOUCH_RELEASED');
    await flush();
    const machineAfterStop = harness.controller.getSnapshot().machine?.name;

    // The pulse's own answer finally arrives, long after it was displaced.
    await answer(harness, MSP_SET_MOTOR_FIXTURE);
    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.machine?.name).not.toBe('Pulsing');
    expect(snapshot.pulse.acknowledged).toBe(false);
    expect(snapshot.pulse.outcome).toMatchObject({kind: 'FAILED'});
    expect([machineAfterStop, 'Fault']).toContain(snapshot.machine?.name);
  });

  it('stops the live episode on a motor switch and refuses to start the second motor', async () => {
    const harness = createHarness();
    await pulseAwaitingAck(harness, 1);
    const beforeSwitch = submittedCommands(harness).length;

    expect(harness.controller.pulseMotor(2)).toBe(
      'SWITCH_REQUIRES_NEW_ACTIVATION',
    );
    await flush();

    // Exactly one new submission - the STOP. Motor 2 was never commanded.
    const payloads = submittedPayloads(harness, MSP_SET_MOTOR_FIXTURE);
    expect(harness.transport.writeLog).toHaveLength(beforeSwitch + 1);
    expect(payloads[payloads.length - 1]).toEqual(EXPECTED_STOP_PAYLOAD);
    expect(payloads).not.toContainEqual(EXPECTED_PULSE_PAYLOADS[2]);
    // Only motor 1 was ever pulsed.
    expect(payloads.filter(p => p[0] === 0x1a)).toHaveLength(1);
  });

  it('takes the stop route when touch ownership is not renewed during a stalled response', async () => {
    jest.useFakeTimers();
    try {
      const harness = createHarness();
      await runSetup(harness);
      harness.controller.pulseMotor(1);
      await flush();
      await settlePulseWrite(harness); // AWAITING_RESPONSE, no answer coming

      // No UI heartbeat is supplied in this controller-level test. The
      // lost-touch fail-safe therefore dominates the client's response
      // timeout and sends the all-stop first.
      jest.advanceTimersByTime(MOTOR_TEST_HOLD_HEARTBEAT_TIMEOUT_MILLIS);
      await flush(30);
      // The priority all-stop write now owns the transport. Settle its
      // native write, but deliberately provide no MSP acknowledgement.
      await settlePulseWrite(harness);
      jest.advanceTimersByTime(2000);
      await flush(30);

      const snapshot = harness.controller.getSnapshot();
      expect(snapshot.pulse.acknowledged).toBe(false);
      expect(snapshot.pulse.outcome).toMatchObject({
        kind: 'FAILED',
        reason: 'STOP_DOMINATED',
      });
      expect(snapshot.machine?.name).toBe('Fault');
      // Nothing is left armed.
      expect(jest.getTimerCount()).toBe(0);
      // A timed-out exchange desynchronizes the client, so the stop could
      // not be attempted at all - which, after a pulse, is unsafe.
      expect(snapshot.stopExecution.commandAcknowledged).toBe(false);
      expect(snapshot.stopExecution.physicalStopConfirmed).toBe(false);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('takes the stop route and faults on a rejected pulse exchange', async () => {
    const harness = createHarness();
    await runSetup(harness);
    harness.controller.pulseMotor(1);
    await flush();
    await settlePulseWrite(harness);
    // A remote error frame is the deterministic stand-in for a failed
    // exchange: it rejects the pulse request through the real client.
    harness.transport.emitData(errorFrame(MSP_SET_MOTOR_FIXTURE));
    await flush(20);

    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.pulse.acknowledged).toBe(false);
    expect(snapshot.pulse.outcome).toMatchObject({kind: 'FAILED'});
    expect(snapshot.machine?.name).toBe('Fault');
  });

  it.each([
    'ARMED_STATE_DETECTED',
    'ARMING_RESTRICTION_REMOVED',
    'BATTERY_BECAME_UNSAFE',
    'BATTERY_CHANGED',
    'NAVIGATION_BLURRED',
    'APP_STATE_BACKGROUNDED',
  ] as const)('safety event %s dominates a live pulse', async trigger => {
    const harness = createHarness();
    await pulseAwaitingAck(harness);
    const before = submittedCommands(harness).length;

    expect(harness.controller.requestStop(trigger)).toBe('ACCEPTED');
    // Registered synchronously, every time.
    expect(harness.transport.writeLog).toHaveLength(before + 1);
    expect(harness.controller.getSnapshot().machine?.name).not.toBe('Pulsing');
  });
});

describe('Phase 2G - same-command (214) attribution ambiguity', () => {
  it('never accepts the first frame as the stop, and resolves with a second all-stop', async () => {
    const harness = createHarness();
    await pulseAwaitingAck(harness);

    // The pulse write finished and its ACK is still outstanding. The stop
    // displaces it - and both are command 214, so the first frame back
    // could belong to either.
    harness.controller.requestStop('TOUCH_RELEASED');
    await flush();
    await settlePulseWrite(harness);
    await answer(harness, MSP_SET_MOTOR_FIXTURE);
    await flush(20);

    // THE FIRST FRAME PROVED NOTHING. The operation has not settled and
    // has claimed no acknowledgement.
    const midway = harness.controller.getSnapshot();
    expect(midway.stopExecution.commandAcknowledged).toBe(false);
    expect(midway.stopExecution.outcome).toBeUndefined();
    // A CONFIRMING all-stop is on the wire, carrying the identical vector.
    await settlePulseWrite(harness);
    const stops = submittedPayloads(harness, MSP_SET_MOTOR_FIXTURE).filter(
      payload => payload.join(',') === EXPECTED_STOP_PAYLOAD.join(','),
    );
    expect(stops).toHaveLength(2);

    await answer(harness, MSP_SET_MOTOR_FIXTURE);
    await flush(20);

    const snapshot = harness.controller.getSnapshot();
    // The ambiguity is RECORDED - it genuinely happened - and recorded as
    // resolved by something that could not have been the pulse's reply.
    expect(snapshot.stopExecution.attributionAmbiguous).toBe(true);
    expect(snapshot.stopExecution.attributionResolvedByConfirmation).toBe(true);
    expect(snapshot.stopExecution.commandAcknowledged).toBe(true);
    // An acknowledgement is still not a physical claim.
    expect(snapshot.stopExecution.physicalStopConfirmed).toBe(false);
    expect(snapshot.stopExecution.outcome).toEqual({kind: 'ACKNOWLEDGED'});
    // A normal early release is NOT terminal any more.
    expect(snapshot.machine?.name).toBe('Ready');
    expect(snapshot.warnings).toHaveLength(0);
    // Telemetry stays paused and the barrier is still held - the session
    // was never torn down.
    expect(snapshot.telemetryHeld).toBe(true);
    expect(harness.scheduler.leases.some(l => !l.released)).toBe(true);
  });

  it('stays terminal when the CONFIRMING all-stop is itself rejected', async () => {
    const harness = createHarness();
    await pulseAwaitingAck(harness);

    harness.controller.requestStop('TOUCH_RELEASED');
    await flush();
    await settlePulseWrite(harness);
    // First frame: consumed, proves nothing.
    await answer(harness, MSP_SET_MOTOR_FIXTURE);
    await flush(20);
    // The confirming all-stop is refused by the flight controller.
    await settlePulseWrite(harness);
    harness.transport.emitData(errorFrame(MSP_SET_MOTOR_FIXTURE));
    await flush(20);

    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.stopExecution.attributionResolvedByConfirmation).toBe(false);
    expect(snapshot.stopExecution.commandAcknowledged).toBe(false);
    expect(snapshot.stopExecution.physicalStopConfirmed).toBe(false);
    expect(snapshot.machine?.name).toBe('Fault');
    // The one case the LiPo instruction exists for.
    expect(snapshot.warnings.length).toBeGreaterThan(0);
    expect(snapshot.telemetryHeld).toBe(true);
  });

  it('an unresolved stop can never be rearmed - a full session reset is required', async () => {
    const harness = createHarness();
    await pulseAwaitingAck(harness);
    harness.controller.requestStop('TOUCH_RELEASED');
    await flush();
    await settlePulseWrite(harness);
    await answer(harness, MSP_SET_MOTOR_FIXTURE);
    await flush(20);
    await settlePulseWrite(harness);
    harness.transport.emitData(errorFrame(MSP_SET_MOTOR_FIXTURE));
    await flush(20);

    const afterUnresolved = submittedCommands(harness).length;
    const sealedEpisode = harness.controller.getSnapshot().stopExecution.episodeId;

    expect(harness.controller.pulseMotor(1)).toBe('NOT_READY');
    harness.controller.requestStop('STOP_BUTTON_PRESSED');
    await flush(20);
    expect(harness.transport.writeLog).toHaveLength(afterUnresolved);
    expect(harness.controller.getSnapshot().stopExecution.episodeId).toBe(
      sealedEpisode,
    );

    // Closing does not manufacture a clean representation either.
    const closed = await drive(harness, harness.controller.close());
    expect(closed.teardown?.complete).toBe(false);
    expect(closed.stopExecution.physicalStopConfirmed).toBe(false);
    expect(closed.telemetryHeld).toBe(true);
  });
});

describe('Phase 2G - stop-operation generations', () => {
  it('joins concurrent and repeated triggers onto exactly one stop write', async () => {
    const harness = createHarness();
    await pulseAwaitingAck(harness);
    const before = submittedCommands(harness).length;

    harness.controller.requestStop('TOUCH_RELEASED');
    harness.controller.requestStop('STOP_BUTTON_PRESSED');
    harness.controller.requestStop('NAVIGATION_BLURRED');
    await flush(20);

    // Three triggers, ONE registration, ONE write.
    expect(harness.transport.writeLog).toHaveLength(before + 1);

    await settlePulseWrite(harness);
    await answer(harness, MSP_SET_MOTOR_FIXTURE);
    await flush(20);
    // The displaced 214 made the first exchange ambiguous, so ONE
    // confirming all-stop follows. Still one operation, still one episode.
    await answer(harness, MSP_SET_MOTOR_FIXTURE);
    await flush(20);
    const record = harness.controller.getSnapshot().stopExecution;
    expect(record.episodeId).toBe(1);
    // One OPERATION, not three - attempts counts operations, not callers.
    expect(record.attempts).toBe(1);
  });

  it('gives a second pulse a fresh stop generation, never the first pulse’s settled one', async () => {
    const harness = createHarness();
    await runSetup(harness);

    // --- Episode 1: pulse 1, stop 1, both attributably acknowledged ---
    expect(harness.controller.pulseMotor(1)).toBe('ACCEPTED');
    await flush();
    await settlePulseWrite(harness);
    await answer(harness, MSP_SET_MOTOR_FIXTURE);
    expect(harness.controller.getSnapshot().pulse.acknowledged).toBe(true);

    harness.controller.requestStop('TOUCH_RELEASED');
    await flush();
    await settlePulseWrite(harness);
    await answer(harness, MSP_SET_MOTOR_FIXTURE);
    await flush(20);

    const afterFirst = harness.controller.getSnapshot();
    expect(afterFirst.stopExecution.outcome).toEqual({kind: 'ACKNOWLEDGED'});
    expect(afterFirst.stopExecution.episodeId).toBe(1);
    expect(afterFirst.stopExecution.attributionAmbiguous).toBe(false);

    // The order actually put on the transport: pulse 1 -> stop 1.
    const payloads = submittedPayloads(harness, MSP_SET_MOTOR_FIXTURE);
    expect(payloads).toEqual([
      EXPECTED_PULSE_PAYLOADS[1],
      EXPECTED_STOP_PAYLOAD,
    ]);
  });

  it('performs the final teardown stop before removing the arming restriction', async () => {
    const harness = createHarness();
    await runSetup(harness);
    harness.controller.pulseMotor(1);
    await flush();
    await settlePulseWrite(harness);
    await answer(harness, MSP_SET_MOTOR_FIXTURE);

    const closed = await drive(harness, harness.controller.close());
    const steps = closed.teardown?.steps.map(s => s.step) ?? [];
    expect(steps.indexOf('EXECUTE_STOP_VECTOR')).toBeLessThan(
      steps.indexOf('RELEASE_LEASE'),
    );
    // A stop really was put on the wire during teardown.
    expect(submittedPayloads(harness, MSP_SET_MOTOR_FIXTURE)).toContainEqual(
      EXPECTED_STOP_PAYLOAD,
    );
  });

  it('joins a close onto a stop that is already in flight', async () => {
    const harness = createHarness();
    await pulseAwaitingAck(harness);
    harness.controller.requestStop('TOUCH_RELEASED');
    const afterStopRegistered = harness.transport.writeLog.length;

    const closing = harness.controller.close();
    await flush();
    // The close did not start a SECOND command-214 operation.
    expect(harness.transport.writeLog).toHaveLength(afterStopRegistered);

    await settlePulseWrite(harness);
    await answer(harness, MSP_SET_MOTOR_FIXTURE);
    const closed = await drive(harness, closing);
    expect(closed.stopExecution.episodeId).toBe(1);
  });
});

describe('Phase 2G - stop uncertainty after a pulse', () => {
  it('treats every non-acknowledged stop as unsafe once a pulse may have reached the FC', async () => {
    const harness = createHarness();
    await runSetup(harness);
    harness.controller.pulseMotor(1);
    await flush();
    await settlePulseWrite(harness);
    await answer(harness, MSP_SET_MOTOR_FIXTURE);
    expect(harness.controller.getSnapshot().pulse.mayHaveReachedFc).toBe(true);

    // A REAL physical detach: the client invalidates the lease outright,
    // so the teardown stop cannot even be attempted. "Could not attempt
    // it" is now the worst case, not a benign one.
    harness.transport.emitSessionDetached('motor-test-controller-session');
    await flush();
    const closed = await drive(harness, harness.controller.close());
    expect(closed.stopExecution.outcome?.kind).toBe('NOT_ATTEMPTED');

    expect(closed.stopExecution.commandAcknowledged).toBe(false);
    expect(closed.stopExecution.physicalStopConfirmed).toBe(false);
    expect(closed.teardown?.complete).toBe(false);
    // Telemetry must NOT resume while the stop outcome is unknown.
    expect(closed.telemetryHeld).toBe(true);
    expect(harness.scheduler.leases.some(l => !l.released)).toBe(true);
  });

  it('keeps physicalStopConfirmed false even on a fully attributable stop ACK', async () => {
    const harness = createHarness();
    await runSetup(harness);
    harness.controller.pulseMotor(1);
    await flush();
    await settlePulseWrite(harness);
    await answer(harness, MSP_SET_MOTOR_FIXTURE);

    const closed = await drive(harness, harness.controller.close());
    expect(closed.stopExecution.commandAcknowledged).toBe(true);
    // The permanent boundary. An MSP acknowledgement is reception, never
    // mechanical proof.
    expect(closed.stopExecution.physicalStopConfirmed).toBe(false);
    expect(closed.stopExecution.wirePreemptionClaimed).toBe(false);
  });
});

describe('Phase 2G - the pulse record claims nothing physical', () => {
  it('carries no rpm, temperature, direction, mapping or physical-stop field', async () => {
    const harness = createHarness();
    await runSetup(harness);
    harness.controller.pulseMotor(3);
    await flush();
    const record = harness.controller.getSnapshot().pulse;

    expect(Object.keys(record).sort()).toEqual([
      'acknowledged',
      'attemptId',
      'deadlineArmedAtSubmission',
      'mayHaveReachedFc',
      'motorNumber',
      'outcome',
      'submitted',
    ]);
    for (const forbidden of [
      'rpm',
      'erpm',
      'temperature',
      'direction',
      'reversed',
      'spinning',
      'rotating',
      'frontLeft',
      'framePosition',
      'motorMapping',
      'physicalStopConfirmed',
      'verified',
      'confirmed',
    ]) {
      expect(forbidden in record).toBe(false);
    }
    expect(Object.isFrozen(record)).toBe(true);
    // motorNumber is an OUTPUT SLOT and says so by value alone.
    expect(record.motorNumber).toBe(3);

    harness.controller.requestStop('STOP_BUTTON_PRESSED');
    await flush();
  });

  it('names no physical claim anywhere in the module source', () => {
    // Executable text only. The module's COMMENTS necessarily use these
    // words to state that it makes no such claim; what must be absent is
    // any code that computes, stores or reports one.
    const executable = readFileSync(
      join(__dirname, 'motorTestController.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
      .toLowerCase();
    for (const forbidden of [
      'rpm',
      'temperature',
      'frontleft',
      'clockwise',
      'propeller',
      'spinning',
      'rotating',
    ]) {
      expect(executable).not.toContain(forbidden);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Phase 2I - THE VERIFICATION RECEIPT
 *
 * Proven against the REAL controller, the REAL request engine and the
 * REAL lease. NO HARDWARE: every byte is in-memory and every transport
 * settlement is explicit.
 * ------------------------------------------------------------------ */

describe('Phase 2I - receipt eligibility', () => {
  /** One complete, clean episode: pulse acknowledged, stop acknowledged. */
  async function completeEpisode(harness: Harness, motor = 1): Promise<void> {
    expect(harness.controller.pulseMotor(motor)).toBe('ACCEPTED');
    await flush();
    await settlePulseWrite(harness);
    await answer(harness, MSP_SET_MOTOR_FIXTURE);
    harness.controller.requestStop('TOUCH_RELEASED');
    await flush();
    await settlePulseWrite(harness);
    await answer(harness, MSP_SET_MOTOR_FIXTURE);
    await flush(20);
  }

  it('mints no receipt before any pulse has completed', async () => {
    const harness = createHarness();
    const snapshot = await runSetup(harness);
    // Ready, gates open, nothing attempted - and still no receipt.
    expect(snapshot.activation.allowed).toBe(true);
    expect(snapshot.verificationReceipt).toBeUndefined();
  });

  it('mints a receipt naming the exact session, attempt and output', async () => {
    const harness = createHarness();
    await runSetup(harness);
    await completeEpisode(harness, 3);

    const receipt = harness.controller.getSnapshot().verificationReceipt;
    expect(receipt).toBeDefined();
    expect(receipt).toMatchObject({
      motorNumber: 3,
      attemptId: 1,
      pulseAcknowledged: true,
      stopAcknowledged: true,
      attributionAmbiguous: false,
      stopUnsafe: false,
      // Permanently false - an ACK is reception, never mechanical proof.
      physicalStopConfirmed: false,
    });
    // The session anchor is a non-forgeable object, not a number.
    expect(typeof receipt?.sessionToken).toBe('object');
    expect(Object.isFrozen(receipt)).toBe(true);
  });

  it('mints no receipt while the pulse is unacknowledged', async () => {
    const harness = createHarness();
    await runSetup(harness);
    harness.controller.pulseMotor(1);
    await flush();
    await settlePulseWrite(harness);
    // Submitted, may be live, NOT acknowledged.
    expect(harness.controller.getSnapshot().verificationReceipt).toBeUndefined();

    // Disarm the hold-heartbeat watchdog before the test ends. A live timer
    // outliving its test is exactly the leak requirement 29 forbids.
    harness.controller.requestStop('STOP_BUTTON_PRESSED');
    await flush(20);
  });

  it('mints no receipt when the pulse itself was never acknowledged', async () => {
    const harness = createHarness();
    await runSetup(harness);
    harness.controller.pulseMotor(1);
    await flush();
    await settlePulseWrite(harness);
    // The stop displaces an already-written command 214, so the first
    // frame back cannot be told apart from the stop's own. The operation
    // resolves that with a confirming all-stop, and the SESSION survives.
    harness.controller.requestStop('TOUCH_RELEASED');
    await flush();
    await settlePulseWrite(harness);
    await answer(harness, MSP_SET_MOTOR_FIXTURE);
    await flush(20);
    await settlePulseWrite(harness);
    await answer(harness, MSP_SET_MOTOR_FIXTURE);
    await flush(20);

    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.stopExecution.attributionAmbiguous).toBe(true);
    expect(snapshot.stopExecution.attributionResolvedByConfirmation).toBe(true);
    expect(snapshot.stopExecution.commandAcknowledged).toBe(true);
    // ... and STILL no receipt. The displaced frame was consumed as the
    // ambiguous one, so this attempt has no attributable pulse
    // acknowledgement of its own - and an observation must never be
    // recorded against an attempt that was not cleanly completed.
    expect(snapshot.pulse.acknowledged).toBe(false);
    expect(snapshot.verificationReceipt).toBeUndefined();
  });

  it('mints no receipt after a fault', async () => {
    const harness = createHarness();
    await runSetup(harness);
    await completeEpisode(harness, 1);
    expect(harness.controller.getSnapshot().verificationReceipt).toBeDefined();

    harness.invalidate('USB_DETACHED');
    await flush(20);
    expect(harness.controller.getSnapshot().verificationReceipt).toBeUndefined();
  });

  it('mints no receipt when the stop was never acknowledged', async () => {
    const harness = createHarness([[MSP_SET_MOTOR_FIXTURE, REJECT]]);
    await runSetup(harness);
    harness.controller.pulseMotor(1);
    await flush();
    // The write must actually be SERVED for the rejection to arrive -
    // flushing microtasks alone leaves the request (and the hold-heartbeat
    // watchdog) outstanding, which is a real timer leaking out of the
    // test.
    await serveOne(harness);
    await flush(20);
    expect(harness.controller.getSnapshot().verificationReceipt).toBeUndefined();
    harness.controller.requestStop('STOP_BUTTON_PRESSED');
    await flush(20);
  });

  it('binds the receipt to the stop episode that ended THAT attempt', async () => {
    const harness = createHarness();
    await runSetup(harness);
    await completeEpisode(harness, 2);

    const receipt = harness.controller.getSnapshot().verificationReceipt;
    expect(receipt).toMatchObject({motorNumber: 2, attemptId: 1, stopEpisodeId: 1});
  });

  it('drops the receipt once the session is torn down', async () => {
    const harness = createHarness();
    await runSetup(harness);
    await completeEpisode(harness, 1);
    expect(harness.controller.getSnapshot().verificationReceipt).toBeDefined();

    const closed = await drive(harness, harness.controller.close());
    // A closed session's lease is released, so nothing remains eligible.
    expect(closed.verificationReceipt).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * FAIL CLOSED WITHOUT A FRESH DISARMED OBSERVATION
 *
 * NO HARDWARE. Every byte is in-memory; no USB, FC, ESC, LiPo or motor is
 * touched. These tests drive the Jest-only module replacement to each
 * non-permitting answer and prove the controller refuses to activate -
 * before any vector, payload, attempt record, timer or transport
 * submission exists.
 * ------------------------------------------------------------------ */

describe('armed-state evidence blocks activation', () => {
  /**
   * Reaches READY with good evidence, then withdraws it.
   *
   * The withdrawal must happen AFTER setup, because setup itself now
   * refuses to publish READY without a fresh disarmed reading - which is
   * the whole point of the boundary and is proven separately above. What
   * this block proves is the SECOND half: a session that legitimately
   * reached READY loses the gate the instant the evidence stops being
   * good, with no render, press or event required.
   */
  async function readyThenWithdrawEvidence(
    evidence: 'FC_ARMED' | 'UNKNOWN_OR_STALE',
  ): Promise<Harness> {
    const harness = createHarness();
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome).toEqual({kind: 'READY'});
    expect(snapshot.activation.allowed).toBe(true);
    mockArmedStateEvidence = evidence;
    return harness;
  }

  it('closes the gate the moment a satisfied reading goes stale', async () => {
    const harness = await readyThenWithdrawEvidence('UNKNOWN_OR_STALE');

    // Read FRESH on every evaluation: no publish, no event, no render.
    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.outcome).toEqual({kind: 'READY'});
    expect(harness.controller.pulseMotor(1)).toBe('GATES_NOT_SATISFIED');
  });

  it('reports an ARMED flight controller as its own operator-facing reason', async () => {
    const harness = await readyThenWithdrawEvidence('FC_ARMED');
    harness.controller.requestStop('STOP_BUTTON_PRESSED');
    await flush(20);

    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.activation.allowed).toBe(false);
    expect(snapshot.activation.reasons).toContain('FC_ARMED');
    // ... and never collapsed into the vaguer unreadable answer.
    expect(snapshot.activation.reasons).not.toContain(
      'ARMED_STATE_UNKNOWN_OR_STALE',
    );
  });

  it('refuses pulseMotor before any vector, payload, attempt or timer exists', async () => {
    jest.useFakeTimers();
    try {
      const harness = await readyThenWithdrawEvidence('UNKNOWN_OR_STALE');
      const writesBefore = harness.transport.writeLog.length;
      expect(jest.getTimerCount()).toBe(0);

      expect(harness.controller.pulseMotor(1)).toBe('GATES_NOT_SATISFIED');
      await flush(20);

      const snapshot = harness.controller.getSnapshot();
      // (a) no live attempt record was created
      expect(snapshot.pulse.attemptId).toBe(0);
      expect(snapshot.pulse.submitted).toBe(false);
      expect(snapshot.pulse.motorNumber).toBeUndefined();
      // (b) the "a command may have reached the FC" latch never set
      expect(snapshot.pulse.mayHaveReachedFc).toBe(false);
      // (c) no pulse/watchdog timer armed
      expect(snapshot.pulse.deadlineArmedAtSubmission).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
      // (d) nothing was submitted to the transport at all
      expect(harness.transport.writeLog).toHaveLength(writesBefore);
      // (e) the machine never left Ready - no Starting, no Pulsing
      expect(snapshot.machine?.name).toBe('Ready');
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('submits no MSP_SET_MOTOR (command 214) and encodes no motor payload', async () => {
    const harness = await readyThenWithdrawEvidence('UNKNOWN_OR_STALE');
    const before = submittedPayloads(harness, MSP_SET_MOTOR_FIXTURE).length;

    for (const motor of [1, 2, 3, 4]) {
      expect(harness.controller.pulseMotor(motor)).toBe('GATES_NOT_SATISFIED');
    }
    await flush(20);

    // Command 214 never reaches the transport, for any output.
    expect(submittedCommands(harness)).not.toContain(MSP_SET_MOTOR_FIXTURE);
    expect(submittedPayloads(harness, MSP_SET_MOTOR_FIXTURE)).toHaveLength(
      before,
    );
    // ... and therefore no pulse or stop vector was ever encoded.
    expect(harness.controller.getSnapshot().stopExecution.commandDispatched).toBe(
      false,
    );
  });

  it('keeps refusing across repeated attempts, with no cumulative state', async () => {
    const harness = await readyThenWithdrawEvidence('UNKNOWN_OR_STALE');
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(harness.controller.pulseMotor(2)).toBe('GATES_NOT_SATISFIED');
    }
    await flush(20);
    // A refusal publishes nothing, so the LAST PUBLISHED snapshot is
    // deliberately not the probe here - the five refusals above are, and
    // each one re-ran the gate at call time. What the snapshot does prove
    // is that no attempt state accumulated.
    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.pulse.attemptId).toBe(0);
    expect(snapshot.pulse.mayHaveReachedFc).toBe(false);
    expect(harness.transport.writeLog.map(writtenCommand)).not.toContain(
      MSP_SET_MOTOR_FIXTURE,
    );
  });

  it('mints no verification receipt while activation is blocked', async () => {
    const harness = await readyThenWithdrawEvidence('UNKNOWN_OR_STALE');
    harness.controller.pulseMotor(1);
    await flush(20);
    // No attempt happened, so nothing is observation-eligible.
    expect(harness.controller.getSnapshot().verificationReceipt).toBeUndefined();
  });

  it('is checked FRESH at CALL TIME, not from the last published snapshot', async () => {
    const harness = await readyThenWithdrawEvidence('UNKNOWN_OR_STALE');
    expect(harness.controller.pulseMotor(1)).toBe('GATES_NOT_SATISFIED');

    // Restoring the evidence re-opens the gate on the NEXT call, with no
    // publish in between. A previously rendered button is not evidence:
    // `pulseMotor()` re-runs the SAME evaluation at call time. (A cached
    // snapshot read is deliberately NOT the probe here - getSnapshot()
    // returns the last PUBLISHED snapshot, so it would prove nothing.)
    mockArmedStateEvidence = 'FRESH_DISARMED';
    expect(harness.controller.pulseMotor(1)).toBe('ACCEPTED');
    await flush(20);

    // Losing it again mid-session closes the gate immediately.
    mockArmedStateEvidence = 'UNKNOWN_OR_STALE';
    harness.controller.requestStop('STOP_BUTTON_PRESSED');
    await flush(20);
    expect(harness.controller.pulseMotor(1)).not.toBe('ACCEPTED');
    const closed = harness.controller.getSnapshot();
    expect(closed.activation.allowed).toBe(false);
    expect(closed.activation.reasons).toContain('ARMED_STATE_UNKNOWN_OR_STALE');
  });

  it('never renames an unproven armed state as available, safe or monitored', async () => {
    const harness = await readyThenWithdrawEvidence('UNKNOWN_OR_STALE');
    harness.controller.requestStop('STOP_BUTTON_PRESSED');
    await flush(20);
    const snapshot = harness.controller.getSnapshot();
    const serialized = JSON.stringify(snapshot);
    // Whole tokens only. A bare "SAFE" substring test would be satisfied
    // by an unrelated reason name and would prove nothing.
    for (const forbidden of [
      '"MONITORED"',
      '"SAFE"',
      'MONITORING_ACTIVE',
      'SAFETY_MONITORING_AVAILABLE',
      'FRESH_DISARMED',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(snapshot.armedStateEvidence).toBe('UNKNOWN_OR_STALE');
    // The blocker names the absence rather than describing any coverage.
    expect(snapshot.activation.reasons).toContain('ARMED_STATE_UNKNOWN_OR_STALE');
  });
});

/* ================================================================== *
 * The dedicated safety monitor, seen from the controller
 * ================================================================== */

describe('continuous safety monitoring is owned by the controller', () => {
  it('starts the monitor as part of reaching Ready, not at the first pulse', async () => {
    const harness = createHarness();
    expect(harness.safetyMonitor.started).toBe(0);

    await runSetup(harness);

    // Started BEFORE Ready is published, so monitoring covers the whole
    // window in which a pulse could be requested - never only the pulse.
    expect(harness.safetyMonitor.started).toBe(1);
    expect(harness.safetyMonitor.running).toBe(true);
  });

  it('stops the monitor when the session is torn down', async () => {
    const harness = createHarness();
    await runSetup(harness);
    expect(harness.safetyMonitor.running).toBe(true);

    await drive(harness, harness.controller.close());

    expect(harness.safetyMonitor.stopped).toBeGreaterThanOrEqual(1);
    expect(harness.safetyMonitor.running).toBe(false);
  });

  it('an ARMED reading reaches the ordinary priority-stop path', async () => {
    const harness = createHarness();
    // A LIVE pulse, so the reducer genuinely emits a stop intent and the
    // trigger NAME is observable rather than merely latched.
    await pulseAwaitingAck(harness);

    harness.safetyMonitor.reportUnsafe('FC_ARMED_OBSERVED');

    const snapshot = harness.controller.getSnapshot();
    // An armed flight controller is a LOCKING stop reason: the session may
    // not be re-armed without a genuinely new connection.
    expect(snapshot.activation.allowed).toBe(false);
    expect(snapshot.activation.reasons).toContain('REQUIRES_NEW_CONNECTION');
    // ... and it is the ACCEPTED armed-state trigger, named for what the
    // flight controller actually reported.
    expect(
      snapshot.stopDescriptors.map(descriptor => descriptor.stopReason),
    ).toContain('ARMED_STATE_DETECTED');
  });

  it('a FAILED reading stops AND faults, and stops the monitor', async () => {
    const harness = createHarness();
    await pulseAwaitingAck(harness);

    harness.safetyMonitor.reportUnsafe('SAFETY_OBSERVATION_FAILED');

    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.machine?.name).toBe('Fault');
    // A faulted session monitors nothing further.
    expect(harness.safetyMonitor.running).toBe(false);
    expect(snapshot.activation.allowed).toBe(false);
    // Named for what happened - never borrowed from the battery
    // vocabulary, which nothing in this bundle reads any more.
    expect(
      snapshot.stopDescriptors.map(descriptor => descriptor.stopReason),
    ).toContain('SAFETY_MONITORING_FAILED');
  });

  it('a STALE reading is treated exactly like a failed one', async () => {
    const harness = createHarness();
    await runSetup(harness);

    harness.safetyMonitor.reportUnsafe('SAFETY_OBSERVATION_STALE');

    expect(harness.controller.getSnapshot().machine?.name).toBe('Fault');
    expect(harness.safetyMonitor.running).toBe(false);
  });
});

/* ================================================================== *
 * THE FIELD REGRESSION, END TO END ON THE REAL CONTROLLER
 * ================================================================== */

describe('a safe Motors departure releases everything the shell depends on', () => {
  /**
   * The operator reported that after testing a motor, Configurations
   * demanded a return to Motors with nothing pending, Ports could not
   * apply a UART change, and only a physical USB replug recovered.
   *
   * This drives the REAL controller through the exact departure sequence
   * and asserts each link the shell reads: the stop is acknowledged, the
   * teardown completes, the exclusive lease is released, the departure
   * gate says SAFE, and the shared liveness predicate - the one four
   * configuration controllers consult - reports the session inactive
   * WITHOUT any physical reconnect.
   */
  it('pulse -> departure stop -> teardown -> lease released -> no longer MOTOR_TEST_ACTIVE', async () => {
    const harness = createHarness();
    await runSetup(harness);

    // A real accepted pulse: the permanent latch is now set.
    expect(harness.controller.pulseMotor(1)).toBe('ACCEPTED');
    await flush();
    await settlePulseWrite(harness);
    await answer(harness, MSP_SET_MOTOR_FIXTURE);
    const pulsing = harness.controller.getSnapshot();
    expect(pulsing.pulse.mayHaveReachedFc).toBe(true);
    expect(pulsing.pulse.acknowledged).toBe(true);
    // Mid-flight, departure must NOT be permitted yet.
    expect(evaluateMotorDeparture(pulsing, 0)).toBe('PENDING');
    expect(isMotorTestSnapshotActive(pulsing)).toBe(true);

    // The operator asks for another tab: the shell's blur fires this.
    harness.controller.requestStop('TOUCH_RELEASED');
    await flush();
    await settlePulseWrite(harness);
    await answer(harness, MSP_SET_MOTOR_FIXTURE);
    await flush(20);

    const stopped = harness.controller.getSnapshot();
    expect(stopped.stopExecution.outcome).toEqual({kind: 'ACKNOWLEDGED'});
    // A confirmed stop permits departure immediately.
    expect(evaluateMotorDeparture(stopped, 0)).toBe('SAFE');

    // Teardown, driven the way the release path drives it.
    const closed = await drive(harness, harness.controller.close());
    expect(closed.phase).toBe('CLOSED');
    expect(closed.teardown?.complete).toBe(true);
    expect(harness.scheduler.activeMotorTestLeaseCount).toBe(0);

    // The permanent latch is STILL set - that is the whole trap...
    expect(closed.pulse.mayHaveReachedFc).toBe(true);
    // ...and the shared predicate the configuration screens read now
    // correctly reports the session inactive, with no USB reconnect.
    expect(isMotorTestSnapshotActive(closed)).toBe(false);
  });

  it('an UNCONFIRMED stop keeps departure blocked AND keeps the screens locked', async () => {
    const harness = createHarness();
    await runSetup(harness);
    expect(harness.controller.pulseMotor(1)).toBe('ACCEPTED');
    await flush();
    await settlePulseWrite(harness);
    await answer(harness, MSP_SET_MOTOR_FIXTURE);

    // A stop is requested but the flight controller never answers it.
    harness.controller.requestStop('TOUCH_RELEASED');
    await flush();

    const unsettled = harness.controller.getSnapshot();
    expect(unsettled.stopExecution.outcome).not.toEqual({
      kind: 'ACKNOWLEDGED',
    });
    // Departure is held while the bounded window runs, then refused.
    expect(evaluateMotorDeparture(unsettled, 0)).toBe('PENDING');
    expect(
      evaluateMotorDeparture(unsettled, MOTOR_DEPARTURE_BOUND_MILLIS),
    ).toBe('UNCONFIRMED');
    // ...and every configuration screen stays locked meanwhile.
    expect(isMotorTestSnapshotActive(unsettled)).toBe(true);
  });

  it('transient motor testing alone never produces a persistent configuration change', async () => {
    const harness = createHarness();
    await runSetup(harness);
    expect(harness.controller.pulseMotor(1)).toBe('ACCEPTED');
    await flush();
    await settlePulseWrite(harness);
    await answer(harness, MSP_SET_MOTOR_FIXTURE);
    harness.controller.requestStop('TOUCH_RELEASED');
    await flush();
    await settlePulseWrite(harness);
    await answer(harness, MSP_SET_MOTOR_FIXTURE);
    await flush(20);

    // A pulse and its stop are TRANSIENT. Nothing about them is a
    // persistent motor-configuration edit, so nothing here may make a
    // configuration screen believe a save is outstanding.
    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.pulse.mayHaveReachedFc).toBe(true);
    expect(snapshot.stopExecution.outcome).toEqual({kind: 'ACKNOWLEDGED'});
    // The controller exposes no persistent-edit state at all - motor
    // CONFIGURATION lives in MotorConfigurationController, a separate
    // transaction with its own interlock.
    expect(Object.keys(snapshot)).not.toContain('configurationDirty');
    expect(Object.keys(snapshot)).not.toContain('pendingConfiguration');
  });
});

/* ================================================================== *
 * P2-ii STEP 5 - THE OLD REDUCER IS DEMOTED
 *
 * `motorTestStateMachine` may still own legacy UI and verification
 * semantics. It may NOT be sufficient, on its own, to put a motor value
 * on the wire. These are structural proofs against the production source,
 * not against comments.
 * ================================================================== */

describe('P2-ii - the old reducer cannot independently authorize a motor write', () => {
  /** Comments describe what the module must NOT do, so only executable
   * text is examined - the same rule the containment suite uses. */
  const controllerSource = (): string =>
    readFileSync(join(__dirname, 'motorTestController.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');

  it('has NO legacy direct write: no ordinary-route MSP_SET_MOTOR in the controller', () => {
    const code = controllerSource();
    // The one thing that must be zero for P2-ii to be complete.
    expect(code).not.toMatch(/lease\.request\(\s*MSP_SET_MOTOR/);
    expect(code).not.toMatch(/runPulse\s*\(/);
  });

  it('routes the legacy pulse through the professional engine', () => {
    const code = controllerSource();
    // pulseMotor must reach the engine, and must not encode for itself.
    // The IMPLEMENTATION, not the interface declaration that precedes it.
    const pulseStart = code.lastIndexOf('pulseMotor(motorNumber: number)');
    const pulseBody = code.slice(
      pulseStart,
      code.indexOf('renewPulseHold()', pulseStart),
    );
    expect(pulseBody).toContain('engine.setMotorValues');
    expect(pulseBody).not.toContain('encodeSetMotorPayload');
    expect(pulseBody).not.toContain('lease.request');
  });

  /**
   * STRUCTURAL RATHER THAN RUNTIME, AND THE REASON IS STATED.
   *
   * `createMotorTestController` returns a frozen facade, so a test cannot
   * reach in and remove the engine to observe the refusal at runtime -
   * which is itself the containment property working as designed. What
   * can be proven, and is proven here, is that the refusal branch exists
   * and precedes every side effect: `pulseMotor` returns
   * GATES_NOT_SATISFIED when there is no engine, BEFORE it mints an
   * attempt, arms the watchdog, or latches `pulseMayHaveReachedFc`.
   */
  it('has an engine-absent refusal that precedes every pulse side effect', () => {
    const code = controllerSource();
    const pulseStart = code.lastIndexOf('pulseMotor(motorNumber: number)');
    const pulseBody = code.slice(
      pulseStart,
      code.indexOf('renewPulseHold()', pulseStart),
    );
    const refusal = pulseBody.indexOf('engine === undefined');
    expect(refusal).toBeGreaterThan(0);
    // Every irreversible step comes AFTER the refusal.
    expect(pulseBody.indexOf('this.pulseAttempt = attempt')).toBeGreaterThan(
      refusal,
    );
    expect(pulseBody.indexOf('this.armPulseDeadline')).toBeGreaterThan(refusal);
    expect(
      pulseBody.indexOf('this.pulseMayHaveReachedFc = true'),
    ).toBeGreaterThan(refusal);
  });
});

/* ===================================================================== *
 * P2-ii FINAL CONVERGENCE - THE PROFESSIONAL FACADE, THROUGH THE REAL
 * CONTROLLER
 *
 * Everything below drives createMotorTestController's frozen surface over
 * the real client, lease, engine and harness-scripted flight controller.
 * No long press, no heartbeat and no fixed magnitude appear anywhere on
 * this path. Nothing asserts a physical outcome.
 * ===================================================================== */

const activeMotorWrites = (harness: Harness): number[][] =>
  harness.writes
    .filter(write => write.command === MSP_SET_MOTOR_FIXTURE)
    .map(write => write.payload)
    .filter(payload => {
      for (let index = 0; index + 1 < payload.length; index += 2) {
        if (payload[index] + payload[index + 1] * 256 !== 1000) {
          return true;
        }
      }
      return false;
    });

const armingWrites = (harness: Harness): number[][] =>
  harness.writes
    .filter(write => write.command === MSP_SET_ARMING_DISABLED_FIXTURE)
    .map(write => write.payload);

/** Serves pending traffic until nothing is outstanding. */
async function settleWire(harness: Harness, turns = 12): Promise<void> {
  for (let step = 0; step < turns; step++) {
    await flush(4);
    if (!(await serveOne(harness))) {
      break;
    }
  }
  await flush(4);
}

describe('P2-ii facade - professional command API through the controller', () => {
  it('setMotorValues works with no long press, no heartbeat and no 1050', async () => {
    const harness = createHarness();
    await runSetup(harness);
    const accepted = harness.controller.setMotorValues([1100, 1200, 1300, 1400]);
    expect(accepted).toEqual({kind: 'ACCEPTED', coalesced: false});
    await settleWire(harness);
    // Multiple independent non-stop values in ONE frame; 1050 nowhere.
    expect(activeMotorWrites(harness)).toEqual([
      [
        ...[1100, 1200, 1300, 1400].flatMap(v => [v % 256, Math.floor(v / 256)]),
      ],
    ]);
  });

  it('setMotorValue mutates one desired entry and sends the full vector', async () => {
    const harness = createHarness();
    await runSetup(harness);
    harness.controller.setMotorValues([1100, 1200, 1000, 1000]);
    await settleWire(harness);
    expect(harness.controller.setMotorValue(2, 1300).kind).toBe('ACCEPTED');
    await settleWire(harness);
    const writes = activeMotorWrites(harness);
    expect(writes[writes.length - 1]).toEqual(
      [1100, 1200, 1300, 1000].flatMap(v => [v % 256, Math.floor(v / 256)]),
    );
  });

  it('setMaster fills exactly N outputs at motorCount 4 through the LIVE controller', async () => {
    const harness = createHarness([
      [MSP_MOTOR_CONFIG, reply(motorConfigPayload(4))],
    ]);
    await runSetup(harness);
    expect(harness.controller.setMaster(1234).kind).toBe('ACCEPTED');
    await settleWire(harness);
    const writes = activeMotorWrites(harness);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toHaveLength(8);
    for (let index = 0; index < 4; index++) {
      expect(writes[0][index * 2] + writes[0][index * 2 + 1] * 256).toBe(1234);
    }
  });

  /**
   * P2 CLOSURE: the limitation that used to be pinned here is REMOVED.
   * Professional eligibility now comes from the P1 domain + runtime scope,
   * so every firmware-supported motor count commands through the LIVE
   * controller - while the legacy pulse UI stays four-motor-only through
   * its own unchanged activation gate, asserted separately below.
   */
  it.each([1, 2, 6, 8])(
    'motorCount %i: professional vector reaches the lease with N*2 bytes',
    async motorCount => {
      const harness = createHarness([
        [MSP_MOTOR_CONFIG, reply(motorConfigPayload(motorCount))],
      ]);
      const snapshot = await runSetup(harness);
      expect(snapshot.outcome).toEqual({kind: 'READY'});
      // From MSP_MOTOR_CONFIG offset 6 - never MSP_MOTOR's fixed slots.
      expect(snapshot.motorDomain?.motorCount).toBe(motorCount);

      const values: number[] = [];
      for (let index = 0; index < motorCount; index++) {
        values.push(1100 + index * 10);
      }
      expect(harness.controller.setMotorValues(values)).toEqual({
        kind: 'ACCEPTED',
        coalesced: false,
      });
      await settleWire(harness);
      const writes = activeMotorWrites(harness);
      expect(writes).toHaveLength(1);
      expect(writes[0]).toHaveLength(motorCount * 2);
      for (let index = 0; index < motorCount; index++) {
        expect(writes[0][index * 2] + writes[0][index * 2 + 1] * 256).toBe(
          1100 + index * 10,
        );
      }
      // THE LEGACY UI DID NOT WIDEN: its gate still refuses this count.
      expect(harness.controller.getSnapshot().activation.allowed).toBe(false);
      expect(harness.controller.pulseMotor(1)).not.toBe('ACCEPTED');
    },
  );

  it('digital 3D: professional session commands both proven regions and stops at 1500', async () => {
    const harness = createHarness([
      [MSP_FEATURE_CONFIG, reply(Uint8Array.from(u32(FEATURE_3D_BIT)))],
    ]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome).toEqual({kind: 'READY'});
    expect(snapshot.motorDomain?.stopValue).toBe(1500);

    // A reverse-region and a forward-region value in one dense vector.
    expect(
      harness.controller.setMotorValues([1200, 1800, 1500, 1500]).kind,
    ).toBe('ACCEPTED');
    await settleWire(harness);
    // stopAll stops at the RESOLVED midpoint - 1000 here is FULL REVERSE.
    expect(harness.controller.stopAll()).toBe('ACCEPTED');
    await settleWire(harness, 20);
    const stops = harness.writes
      .filter(write => write.command === MSP_SET_MOTOR_FIXTURE)
      .map(write => write.payload)
      .filter(payload =>
        payload.every(
          (byte, index) => (index % 2 === 0 ? byte === 220 : byte === 5),
        ),
      );
    expect(stops.length).toBeGreaterThan(0);
    // The legacy 3D bar never moved.
    expect(harness.controller.pulseMotor(1)).not.toBe('ACCEPTED');
  });

  it('analog non-3D: professional session commands inside CONFIGURATION_POLICY bounds', async () => {
    const harness = createHarness([
      [MSP_ADVANCED_CONFIG, reply(advancedConfigPayload(3))],
    ]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome).toEqual({kind: 'READY'});
    expect(snapshot.motorDomain?.domainSource).toBe('CONFIGURATION_POLICY');
    expect(harness.controller.setMaster(1500).kind).toBe('ACCEPTED');
    await settleWire(harness);
    // Out of the configured domain: refused as PRODUCT POLICY, zero write.
    expect(harness.controller.setMaster(2001).kind).toBe('REFUSED');
    expect(harness.controller.pulseMotor(1)).not.toBe('ACCEPTED');
  });

  it('analog 3D: refused for BOTH paths - the professional runtime does not guess', async () => {
    const harness = createHarness([
      [MSP_ADVANCED_CONFIG, reply(advancedConfigPayload(3))],
      [MSP_FEATURE_CONFIG, reply(Uint8Array.from(u32(FEATURE_3D_BIT)))],
    ]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome).toMatchObject({
      kind: 'BLOCKED',
      reason: 'MOTOR_SCOPE_UNSUPPORTED',
    });
    expect(harness.controller.setMaster(1500).kind).toBe('REFUSED');
    await settleWire(harness);
    expect(activeMotorWrites(harness)).toHaveLength(0);
  });

  it('refuses an out-of-domain value and a wrong-length vector with ZERO writes', async () => {
    const harness = createHarness();
    await runSetup(harness);
    expect(harness.controller.setMaster(2001)).toEqual({
      kind: 'REFUSED',
      reason: 'INVALID_VECTOR',
    });
    expect(harness.controller.setMotorValues([1100, 1100, 1100]).kind).toBe(
      'REFUSED',
    );
    await settleWire(harness);
    expect(activeMotorWrites(harness)).toHaveLength(0);
  });

  it('coalesces 20 rapid updates into at most two frames', async () => {
    const harness = createHarness();
    await runSetup(harness);
    for (let value = 1100; value < 1120; value++) {
      harness.controller.setMaster(value);
    }
    await settleWire(harness, 20);
    const writes = activeMotorWrites(harness);
    expect(writes.length).toBeLessThanOrEqual(2);
    // Last-value-wins: the final frame carries 1119.
    const last = writes[writes.length - 1];
    expect(last[0] + last[1] * 256).toBe(1119);
  });

  it('stopAll destroys the pending update and a late ACK cannot restore commanding', async () => {
    const harness = createHarness();
    await runSetup(harness);
    // A dispatched, B coalesced - neither served yet.
    harness.controller.setMaster(1100);
    harness.controller.setMaster(1200);
    // STOP through the SAME canonical funnel every other source uses.
    expect(harness.controller.stopAll()).toBe('ACCEPTED');
    await settleWire(harness, 20);
    // B (1200) never reached the wire - the pending vector was destroyed
    // by the stop, and A's late ACK could not resurrect it.
    const values = activeMotorWrites(harness).map(
      payload => payload[0] + payload[1] * 256,
    );
    expect(values).not.toContain(1200);
    // The canonical all-stop DID go on the wire.
    const stops = harness.writes.filter(
      write =>
        write.command === MSP_SET_MOTOR_FIXTURE &&
        write.payload.every(
          (byte, index) =>
            (index % 2 === 0 ? byte : byte * 256) ===
            (index % 2 === 0 ? 1000 % 256 : Math.floor(1000 / 256) * 256),
        ),
    );
    expect(stops.length).toBeGreaterThan(0);
    // An ORDINARY confirmed stop returns to commandable - that is the
    // professional model's EnabledIdle, not a defect - and a genuinely
    // new command is a fresh dispatch, never a resurrection of B.
    expect(harness.controller.setMaster(1300).kind).toBe('ACCEPTED');
  });

  it('a fresh session starts with no stale pending vector', async () => {
    const first = createHarness();
    await runSetup(first);
    first.controller.setMaster(1500);
    await drive(first, first.controller.close());

    const second = createHarness();
    await runSetup(second);
    await settleWire(second);
    // Nothing from the first session leaks: zero active writes until the
    // operator asks for one.
    expect(activeMotorWrites(second)).toHaveLength(0);
  });
});

describe('P2-ii convergence - monitor, lifecycle and session invalidation', () => {
  it('background routes through the canonical professional stop', async () => {
    const harness = createHarness();
    await runSetup(harness);
    harness.controller.setMaster(1100);
    await settleWire(harness);
    expect(harness.controller.requestStop('APP_STATE_BACKGROUNDED')).toBe(
      'ACCEPTED',
    );
    await settleWire(harness, 20);
    // A locking stop: the professional path refuses further commands.
    expect(harness.controller.setMaster(1100).kind).toBe('REFUSED');
  });

  it('departure routes through the same stop and refuses further commands', async () => {
    const harness = createHarness();
    await runSetup(harness);
    harness.controller.setMaster(1100);
    await settleWire(harness);
    expect(harness.controller.requestStop('NAVIGATION_BLURRED')).toBe(
      'ACCEPTED',
    );
    await settleWire(harness, 20);
    expect(harness.controller.setMaster(1100).kind).toBe('REFUSED');
  });

  it('disconnect invalidates pending work and refuses every later command', async () => {
    const harness = createHarness();
    await runSetup(harness);
    harness.controller.setMaster(1100);
    harness.controller.setMaster(1200); // pending, unserved
    harness.invalidate('USB_DETACHED');
    await settleWire(harness, 20);
    // The pending 1200 never reached the wire and never will.
    expect(
      activeMotorWrites(harness).filter(
        payload => payload[0] + payload[1] * 256 === 1200,
      ),
    ).toHaveLength(0);
    expect(harness.controller.setMaster(1300).kind).toBe('REFUSED');
  });

  it('session replacement invalidates continuations the same way', async () => {
    const harness = createHarness();
    await runSetup(harness);
    harness.controller.setMaster(1100);
    harness.invalidate('SESSION_CHANGED');
    await settleWire(harness, 20);
    expect(harness.controller.setMaster(1300).kind).toBe('REFUSED');
    expect(
      activeMotorWrites(harness).filter(
        payload => payload[0] + payload[1] * 256 === 1300,
      ),
    ).toHaveLength(0);
  });
});

describe('P2-ii convergence - arming restriction release contract', () => {
  it('a FAILED primary stop sends NO release [0] and is not clean', async () => {
    const harness = createHarness();
    await runSetup(harness);
    // A command may be live, and every 214 now fails.
    harness.controller.setMaster(1100);
    await settleWire(harness);
    harness.script.set(MSP_SET_MOTOR_FIXTURE, REJECT);
    const closed = await drive(harness, harness.controller.close());
    // Establish [1] only - the release was WITHHELD, deliberately.
    expect(armingWrites(harness)).toEqual([[1]]);
    expect(closed.teardown?.armingRestrictionRelease).toBe(
      'WITHHELD_STOP_UNPROVEN',
    );
    expect(closed.teardown?.complete).toBe(false);
  });

  it('a failed release [0] is a distinct recovery result, never clean', async () => {
    const harness = createHarness();
    await runSetup(harness);
    harness.controller.setMaster(1100);
    await settleWire(harness);
    // The stop succeeds; only the RELEASE is refused.
    harness.beforeReply = command => {
      if (command === MSP_SET_ARMING_DISABLED_FIXTURE) {
        harness.script.set(MSP_SET_ARMING_DISABLED_FIXTURE, REJECT);
      }
    };
    const closed = await drive(harness, harness.controller.close());
    expect(closed.teardown?.armingRestrictionRelease).toBe('RELEASE_FAILED');
    // NOT ordinary clean teardown: the report says recovery is required.
    expect(closed.teardown?.complete).toBe(false);
  });
});
