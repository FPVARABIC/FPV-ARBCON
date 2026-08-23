/**
 * THE SIMPLIFIED BENCH GATE, END TO END, WITH NOTHING MOCKED AWAY.
 *
 * WHAT MAKES THIS FILE DIFFERENT FROM motorTestController.test.ts. That
 * suite replaces the armed-state-evidence MODULE and injects a controlled
 * monitor stand-in, because it is about the pulse engine and a live
 * observation loop competing for the fake link would turn every
 * request-sequence assertion into a test of scheduling.
 *
 * THIS file does the opposite and mocks NOTHING. The real
 * `MotorTestSafetyMonitor` runs, issuing real MSP_STATUS_EX reads through
 * the real `MotorTestLease` on the real `MspClient`, and the real
 * `observeMotorArmedState` decodes real wire bytes to decide armed state.
 * The activation gate consults the real `readMotorArmedStateEvidence`.
 * Every "blocked" verdict below is produced by production code from
 * payloads a flight controller could actually send.
 *
 * NO HARDWARE OF ANY KIND: no flight controller, no USB, no serial
 * session, no ESC, no motor, no LiPo, no emulator, no device. The only
 * fake is the repository's existing FakeMspTransport, below the client.
 *
 * The forbidden motor command appears in no fixture - only as a value the
 * containment assertions prove absent.
 */

import {
  createMotorTestController,
  type MotorTestController,
  type MotorTestControllerSessionPort,
  type MotorTestControllerSnapshot,
  type MotorTestSessionInvalidationReason,
} from './motorTestController';
import {MOTOR_TEST_SAFETY_OBSERVATION_INTERVAL_MILLIS} from './motorTestSafetyMonitor';
import {
  MotorTestTelemetryRegistry,
  type MotorTestBarrierScheduler,
} from '../protocol/telemetry/motorTestTelemetryBarrier';
import type {
  TelemetryPauseLease,
  TelemetryPauseReason,
} from '../protocol/telemetry/telemetryTypes';
import {MSP_RESPONSE_TIMEOUT_MILLIS, MspClient} from '../protocol/mspClient';
import type {MspSessionCompositeIdentity} from '../protocol/motorTestLease';
import {FakeMspTransport} from '../protocol/__testUtils__/mspFakeTransport';
import {buildMspFrameBytes} from '../protocol/__testUtils__/mspFixtures';
import {betaflightApi147Identity} from '../protocol/__testUtils__/motorFirmwareFixtures';
import {ARMING_DISABLE_FLAGS_COUNT} from './armingBlockers';
import {
  ARMING_DISABLED_MSP_BIT_INDEX,
  MSP_SET_ARMING_DISABLED,
} from './motorArmingRestriction';
import {FEATURE_3D_BIT} from '../protocol/msp/decoding/decodeFeatureConfig';
import {
  MSP_ADVANCED_CONFIG,
  MSP_BOXIDS,
  MSP_FEATURE_CONFIG,
  MSP_MIXER_CONFIG,
  MSP_MOTOR_CONFIG,
  MSP_STATUS_EX,
  MSP_MOTOR_3D_CONFIG,
} from '../protocol/msp/commands/mspCommands';

const EMPTY = new Uint8Array(0);
const PHYSICAL_GENERATION = 11;

/** Command 214. Named only so the assertions can prove its absence. */
const MSP_SET_MOTOR_FIXTURE = 214;
/** Command 99. The arming restriction is gone from this bundle entirely. */
const MSP_SET_ARMING_DISABLED_FIXTURE = 99;
/**
 * The only all-stop payload this package may ever put on the wire.
 *
 * M-C: EIGHT slots, sixteen bytes, on every airframe. A payload sized to
 * the motor count would under-run the API-1.47 handler, which reads
 * getMotorCount() values with no length guard at all.
 */
const EXPECTED_STOP_PAYLOAD = [
  0xe8, 0x03, 0xe8, 0x03, 0xe8, 0x03, 0xe8, 0x03,
  0xe8, 0x03, 0xe8, 0x03, 0xe8, 0x03, 0xe8, 0x03,
];
/** 1050 little-endian in slot 0, stop in the other SEVEN. */
const EXPECTED_M1_PAYLOAD = [
  0x1a, 0x04, 0xe8, 0x03, 0xe8, 0x03, 0xe8, 0x03,
  0xe8, 0x03, 0xe8, 0x03, 0xe8, 0x03, 0xe8, 0x03,
];

/* ------------------------------------------------------------------ *
 * Byte helpers - arithmetic, never bitwise, so a high bit survives
 * ------------------------------------------------------------------ */

const u16 = (value: number): number[] => [
  value % 256,
  Math.floor(value / 256) % 256,
];

const u32 = (value: number): number[] => [
  value % 256,
  Math.floor(value / 256) % 256,
  Math.floor(value / 65536) % 256,
  Math.floor(value / 16777216) % 256,
];

/* ------------------------------------------------------------------ *
 * The supported-configuration fixture
 * ------------------------------------------------------------------ */

/** MSP_MOTOR_CONFIG per msp.c @ the pinned tag; offset 6 is motor count. */
function motorConfigPayload(motorCount = 4): Uint8Array {
  return Uint8Array.from([
    ...u16(0),
    ...u16(2000),
    ...u16(1000),
    motorCount,
    14,
    0,
    0,
  ]);
}

/** MSP_ADVANCED_CONFIG; offset 3 is the raw motorProtocolTypes_e. 7 is
 * DSHOT600 at the pinned tag. */
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

/** MSP_FEATURE_CONFIG; the whole u32 feature mask. Bit 12 is FEATURE_3D. */
function featureConfigPayload(enabledFeaturesRaw = 0): Uint8Array {
  return Uint8Array.from(u32(enabledFeaturesRaw));
}

/** BOXARM's permanent id is 0; placed at index 2 so a hardcoded bit-0
 * assumption would be caught. */
const BOX_IDS_PAYLOAD = Uint8Array.from([5, 1, 0, 13]);
const ARM_BIT = 2;

/** MSP_STATUS_EX per msp.c:1094-1143 @ the pinned tag. */
function statusPayload(armed = false, armingDisableFlags = 0): Uint8Array {
  return Uint8Array.from([
    ...u16(125),
    ...u16(0),
    ...u16(0x21),
    ...u32(armed ? Math.pow(2, ARM_BIT) : 0),
    2,
    ...u16(15),
    // --- 13-byte fixed prefix ends ---
    4,
    1,
    0,
    ARMING_DISABLE_FLAGS_COUNT,
    ...u32(armingDisableFlags),
    0,
    ...u16(3400),
    6,
  ]);
}

/**
 * P2-ii. The status a flight controller reports AFTER it has accepted
 * MSP_SET_ARMING_DISABLED [1]: ARMING_DISABLED_MSP (bit 16) is set in the
 * global armingDisableFlags mask. `establishMotorArmingRestriction`
 * re-reads MSP_STATUS_EX and refuses unless that bit is present, so a
 * harness that did not model this would be asserting against a flight
 * controller that ignored the write.
 */
const MSP_RESTRICTED_STATUS = () =>
  statusPayload(false, Math.pow(2, ARMING_DISABLED_MSP_BIT_INDEX));

/* ------------------------------------------------------------------ *
 * The scripted flight controller
 * ------------------------------------------------------------------ */

type ScriptedReply =
  | {readonly kind: 'RESPONSE'; readonly payload: Uint8Array}
  | {readonly kind: 'ERROR'};

const reply = (payload: Uint8Array): ScriptedReply => ({
  kind: 'RESPONSE',
  payload,
});
const REJECT: ScriptedReply = {kind: 'ERROR'};

function supportedScript(): Map<number, ScriptedReply> {
  return new Map<number, ScriptedReply>([
    [MSP_MOTOR_CONFIG, reply(motorConfigPayload())],
    [MSP_ADVANCED_CONFIG, reply(advancedConfigPayload())],
    [MSP_FEATURE_CONFIG, reply(featureConfigPayload())],
    // M-D: the setup now also reads WHICH AIRFRAME, so the view can tell
    // a QUAD X from a V-TAIL 4 rather than guessing from the motor count.
    // MIXER_QUADX (3), yaw not reversed - the default fixture, matching
    // the four-motor configuration the rest of this script describes.
    // Presentation only: no gate, scope or command reads it.
    [MSP_MIXER_CONFIG, reply(mixerConfigPayload(3))],
    [MSP_BOXIDS, reply(BOX_IDS_PAYLOAD)],
    [MSP_STATUS_EX, reply(statusPayload())],
    [MSP_SET_MOTOR_FIXTURE, reply(EMPTY)],
    // P2-ii: the enable path now establishes the FC-side arming
    // restriction. Command 99 is acknowledged with an empty payload,
    // exactly as Betaflight does.
    [MSP_SET_ARMING_DISABLED, reply(EMPTY)],
    // P2 closure: FEATURE_3D sessions resolve their domain from the real
    // deadband/neutral bytes. Deadbands 1406/1514, neutral 1460.
    [
      MSP_MOTOR_3D_CONFIG,
      reply(Uint8Array.from([126, 5, 234, 5, 180, 5])),
    ],
  ]);
}

/** Byte 4 of a v1 request frame is the command. Kept for the v1-only
 * assertions that inspect raw transport writes directly. */
const writtenCommand = (data: Uint8Array): number => data[4];

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

async function flush(times = 6): Promise<void> {
  for (let index = 0; index < times; index++) {
    await Promise.resolve();
  }
}

/* ------------------------------------------------------------------ *
 * Narrow fakes - exactly the two members the barrier may call
 * ------------------------------------------------------------------ */

class IdleScheduler implements MotorTestBarrierScheduler {
  readonly leases: {reason: TelemetryPauseReason; released: boolean}[] = [];

  acquirePauseLease(reason: TelemetryPauseReason): TelemetryPauseLease {
    const record = {reason, released: false};
    this.leases.push(record);
    return {
      id: `${reason}-${this.leases.length}`,
      release: () => {
        record.released = true;
      },
    };
  }

  waitUntilIdle(): Promise<void> {
    return Promise.resolve();
  }
}

/* ------------------------------------------------------------------ *
 * Harness - REAL monitor, REAL observation, REAL evidence reader
 * ------------------------------------------------------------------ */

interface Harness {
  readonly transport: FakeMspTransport;
  readonly client: MspClient;
  readonly controller: MotorTestController;
  readonly script: Map<number, ScriptedReply>;
  /** Every command served, in order. */
  readonly commands: number[];
  /** The exact payload bytes written per command, in order. */
  readonly writes: {command: number; payload: number[]}[];
  /** A monotonic clock the TEST owns, so freshness is deterministic and
   * never depends on wall-clock timing. */
  advanceMonotonic(millis: number): void;
  identity: MspSessionCompositeIdentity | undefined;
  invalidate(reason: MotorTestSessionInvalidationReason): void;
}

function createHarness(
  overrides: ReadonlyArray<readonly [number, ScriptedReply]> = [],
): Harness {
  const transport = new FakeMspTransport();
  const client = new MspClient(transport, 'motor-test-bench-gate-session');
  const registry = new MotorTestTelemetryRegistry();
  const telemetrySession = registry.openSession(client);
  registry.registerScheduler(telemetrySession, new IdleScheduler());

  const script = supportedScript();
  for (const [command, scripted] of overrides) {
    script.set(command, scripted);
  }

  const listeners = new Set<
    (reason: MotorTestSessionInvalidationReason) => void
  >();
  const state: {identity: MspSessionCompositeIdentity | undefined} = {
    identity: {physicalGeneration: PHYSICAL_GENERATION, mspEpoch: 0},
  };

  const session: MotorTestControllerSessionPort = {
    client,
    // A FRESH object every call, deliberately: composite identity must be
    // compared BY VALUE, never by reference.
    readCurrentIdentity: () =>
      state.identity === undefined
        ? undefined
        : {
            physicalGeneration: state.identity.physicalGeneration,
            mspEpoch: state.identity.mspEpoch,
          },
    readFirmwareIdentification: () => ({
      status: 'SUCCEEDED',
      identity: betaflightApi147Identity(),
    }),
    subscribeFirmwareIdentification: () => () => undefined,
    subscribeSessionInvalidated: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  // A clock the test drives. The monitor's freshness bound is evaluated
  // against THIS, so "the observation aged out" is an assertion rather
  // than a race with the wall clock.
  const clock = {now: 10_000};

  // NOTE: `createSafetyMonitor` is deliberately NOT supplied. The real
  // MotorTestSafetyMonitor is constructed by the controller, with the real
  // lease, and it does the real reads.
  const controller = createMotorTestController({
    session,
    telemetryRegistry: registry,
    telemetrySession,
    readMonotonicMillis: () => clock.now,
  });

  return {
    transport,
    client,
    controller,
    script,
    commands: [],
    writes: [],
    advanceMonotonic: millis => {
      clock.now += millis;
    },
    get identity() {
      return state.identity;
    },
    set identity(next: MspSessionCompositeIdentity | undefined) {
      state.identity = next;
    },
    invalidate: reason => {
      for (const listener of Array.from(listeners)) {
        listener(reason);
      }
    },
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
  const scripted = harness.script.get(command) ?? REJECT;
  // The reply travels the SAME wire format as the request - a v1 error
  // for a v2 request would never match and would wedge the FIFO.
  harness.transport.emitData(
    scripted.kind === 'RESPONSE'
      ? replyFrame(write, scripted.payload)
      : errorReplyFrame(write),
  );
  // A flight controller that ACCEPTED command 99 reports the restriction
  // in every later MSP_STATUS_EX. Modelled here so the establishment's own
  // independent re-read verifies against a truthful device rather than one
  // that silently ignored the write. Overrides that deliberately REJECT 99
  // never reach this, so a refusing device stays refusing.
  if (command === MSP_SET_ARMING_DISABLED && scripted.kind === 'RESPONSE') {
    harness.script.set(MSP_STATUS_EX, reply(MSP_RESTRICTED_STATUS()));
  }
  await flush();
  return true;
}

/**
 * Drives a controller operation to completion by serving whatever the REAL
 * client actually writes. Bounded, and it terminates naturally as soon as
 * the operation settles.
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
 * Every harness is torn down. The real monitor holds a real client request
 * with a real response timer, and an abandoned one would keep the Jest
 * process alive after the assertions have already passed.
 */
const OPEN_HARNESSES: Harness[] = [];

function harnessFor(
  overrides: ReadonlyArray<readonly [number, ScriptedReply]> = [],
): Harness {
  const harness = createHarness(overrides);
  OPEN_HARNESSES.push(harness);
  return harness;
}

afterEach(async () => {
  while (OPEN_HARNESSES.length > 0) {
    const harness = OPEN_HARNESSES.pop();
    if (harness === undefined) {
      continue;
    }
    try {
      await drive(harness, harness.controller.close());
    } catch {
      // Teardown of a deliberately broken fixture is allowed to fail; the
      // dispose below is what actually frees the timers.
    }
    harness.client.dispose();
  }
});

/* ================================================================== *
 * A. One valid disarmed bench state permits activation
 * ================================================================== */

describe('the bench gate, with the real observation path', () => {
  it('permits activation from ONE valid disarmed bench state', async () => {
    const harness = harnessFor();
    const snapshot = await runSetup(harness);

    expect(snapshot.outcome).toEqual({kind: 'READY'});
    expect(snapshot.setupStep).toBe('READY');
    // Decided by production code, from real MSP_STATUS_EX bytes.
    expect(snapshot.armedStateEvidence).toBe('FRESH_DISARMED');
    expect(snapshot.activation.allowed).toBe(true);
    expect(snapshot.activation.reasons).toEqual([]);
  });

  /**
   * REWRITTEN IN P2-ii, NOT DELETED, AND THE CHANGE IS INTENTIONAL.
   *
   * This used to assert that command 99 is NEVER sent. That was accurate
   * for a pass whose enable path had deliberately dropped the FC-side
   * arming restriction, relying on continuous armed-state observation
   * alone. P2-ii restores the restriction, because observation DETECTS an
   * aircraft arming underneath a commanded output while the restriction
   * PREVENTS it - they are complements, not alternatives.
   *
   * The property this test exists for is unchanged and still exact: the
   * enable path sends THIS list and nothing else, in THIS order. It has
   * grown by exactly two frames - command 99, and the establishment's own
   * independent MSP_STATUS_EX re-read that verifies bit 16 actually came
   * back set. No motor command is sent, which the final assertion still
   * pins down.
   */
  it('runs the whole simplified sequence and nothing else', async () => {
    const harness = harnessFor();
    await runSetup(harness);

    expect(harness.commands).toEqual([
      MSP_MOTOR_CONFIG,
      MSP_ADVANCED_CONFIG,
      MSP_FEATURE_CONFIG,
      // M-D: WHICH AIRFRAME. Added so the view can draw the aircraft it
      // actually has instead of guessing from the motor count. A READ,
      // presentation-only - the motor COUNT still comes from command 131
      // above and nothing else.
      MSP_MIXER_CONFIG,
      MSP_BOXIDS,
      // The monitor's own first observation, AWAITED before READY.
      MSP_STATUS_EX,
      // P2-ii: the restriction, established only after DISARMED is proven.
      MSP_SET_ARMING_DISABLED,
      // ...and its independent verification re-read.
      MSP_STATUS_EX,
    ]);
    // Still no motor command anywhere in the enable path.
    expect(harness.commands).not.toContain(MSP_SET_MOTOR_FIXTURE);
  });

  it('establishes the arming restriction AFTER disarmed is proven and BEFORE READY', async () => {
    const harness = harnessFor();
    const snapshot = await runSetup(harness);

    const firstObservation = harness.commands.indexOf(MSP_STATUS_EX);
    const restriction = harness.commands.indexOf(MSP_SET_ARMING_DISABLED);
    expect(firstObservation).toBeGreaterThanOrEqual(0);
    expect(restriction).toBeGreaterThan(firstObservation);
    // And the session only becomes usable once both are done.
    expect(snapshot.outcome).toEqual({kind: 'READY'});
    expect(snapshot.activation.allowed).toBe(true);
  });

  it('sends command 99 with payload [1] - establish, never release', async () => {
    const harness = harnessFor();
    await runSetup(harness);
    const write = harness.writes.find(
      entry => entry.command === MSP_SET_ARMING_DISABLED,
    );
    expect(write).toBeDefined();
    // Polarity is inverted from the command name: 1 DISABLES arming.
    expect(write?.payload).toEqual([1]);
  });

  it('refuses to publish READY when the FC rejects the restriction', async () => {
    const harness = harnessFor([[MSP_SET_ARMING_DISABLED, REJECT]]);
    const snapshot = await runSetup(harness);

    expect(snapshot.outcome.kind).not.toBe('READY');
    expect(snapshot.activation.allowed).toBe(false);
    // Command 99 may have reached the wire, so this is uncertainty.
    expect(snapshot.outcome).toMatchObject({
      reason: 'ARMING_RESTRICTION_NOT_ESTABLISHED',
    });
  });

  it('cannot publish READY before the first observation is served', async () => {
    const harness = harnessFor();
    let settled = false;
    const pending = harness.controller.initializeSession().then(value => {
      settled = true;
      return value;
    });

    // Serve everything EXCEPT the observation: the FIVE evidence reads,
    // then stop. Bounded by the command COUNT, never by loop iterations -
    // a write may not be pending on the first turn.
    //
    // It was four before M-D added the mixer read (command 42) so the
    // view could name the airframe. The count moved; the property this
    // test is named for did not.
    for (let step = 0; step < 60 && harness.commands.length < 5; step++) {
      await flush(3);
      await serveOne(harness);
    }
    await flush(20);
    expect(harness.commands).toHaveLength(5);

    // The observation is on the wire and unanswered. Setup is parked on
    // it, and the snapshot says so rather than claiming readiness.
    expect(settled).toBe(false);
    const midSetup = harness.controller.getSnapshot();
    expect(midSetup.setupStep).toBe('FIRST_OBSERVATION');
    expect(midSetup.outcome.kind).toBe('PENDING');
    expect(midSetup.activation.allowed).toBe(false);
    // The observation itself is on the wire and unanswered.
    expect(harness.transport.writes).toHaveLength(1);
    expect(writtenCommand(harness.transport.writes[0].data)).toBe(
      MSP_STATUS_EX,
    );

    const snapshot = await drive(harness, pending);
    expect(snapshot.outcome).toEqual({kind: 'READY'});
    expect(snapshot.activation.allowed).toBe(true);
  });

  it('makes the subscriber activatable from the observation alone', async () => {
    const harness = harnessFor();
    const allowedAtNotification: boolean[] = [];
    harness.controller.subscribe(() => {
      allowedAtNotification.push(
        harness.controller.getSnapshot().activation.allowed,
      );
    });

    await runSetup(harness);

    // No press, no re-render, no unrelated state change: resolving the
    // first real observation is what produced an activatable snapshot.
    expect(allowedAtNotification).toContain(true);
    expect(allowedAtNotification.indexOf(true)).toBe(
      allowedAtNotification.length - 1,
    );
  });
});

/* ================================================================== *
 * B. Every non-permitting observation blocks activation
 * ================================================================== */

describe('observations that must block activation', () => {
  it('blocks an ARMED flight controller, with its own reason', async () => {
    const harness = harnessFor([[MSP_STATUS_EX, reply(statusPayload(true))]]);
    const snapshot = await runSetup(harness);

    expect(snapshot.outcome).toMatchObject({
      kind: 'BLOCKED',
      reason: 'FIRST_OBSERVATION_NOT_DISARMED',
    });
    expect(snapshot.armedStateEvidence).toBe('FC_ARMED');
    expect(snapshot.activation.allowed).toBe(false);
    expect(snapshot.activation.reasons).toContain('FC_ARMED');
    expect(harness.controller.pulseMotor(1)).not.toBe('ACCEPTED');
  });

  it('blocks a REJECTED observation', async () => {
    const harness = harnessFor([[MSP_STATUS_EX, REJECT]]);
    const snapshot = await runSetup(harness);

    expect(snapshot.outcome).toMatchObject({
      kind: 'FAILED_CLOSED',
      reason: 'FIRST_OBSERVATION_UNAVAILABLE',
    });
    expect(snapshot.armedStateEvidence).toBe('UNKNOWN_OR_STALE');
    expect(harness.controller.pulseMotor(1)).not.toBe('ACCEPTED');
  });

  it('blocks a MALFORMED observation instead of reading it as disarmed', async () => {
    // Truncated below the 13-byte fixed prefix. Undecodable, and never
    // normalized into "no arm bit set".
    const harness = harnessFor([
      [MSP_STATUS_EX, reply(Uint8Array.from([1, 2, 3]))],
    ]);
    const snapshot = await runSetup(harness);

    expect(snapshot.outcome.kind).not.toBe('READY');
    expect(snapshot.armedStateEvidence).toBe('UNKNOWN_OR_STALE');
    expect(harness.controller.pulseMotor(1)).not.toBe('ACCEPTED');
  });

  it('blocks when the box mapping cannot locate the ARM bit', async () => {
    // A mapping without BOXARM (permanent id 0) proves nothing either way,
    // and an unprovable armed state is never guessed.
    const harness = harnessFor([
      [MSP_BOXIDS, reply(Uint8Array.from([5, 1, 13]))],
    ]);
    const snapshot = await runSetup(harness);

    expect(snapshot.outcome.kind).not.toBe('READY');
    expect(snapshot.armedStateEvidence).toBe('UNKNOWN_OR_STALE');
  });

  it('blocks an observation whose session moved under the read', async () => {
    const harness = harnessFor();
    let served = 0;
    const pending = harness.controller.initializeSession();
    for (let step = 0; step < 40; step++) {
      await flush(3);
      if (harness.transport.writes.length === 0) {
        continue;
      }
      const command = writtenCommand(harness.transport.writes[0].data);
      if (command === MSP_STATUS_EX) {
        // The bytes will be perfectly good; they simply describe a session
        // that no longer exists by the time they are decoded.
        harness.identity = {
          physicalGeneration: PHYSICAL_GENERATION + 1,
          mspEpoch: 0,
        };
      }
      await serveOne(harness);
      served += 1;
      if (command === MSP_STATUS_EX) {
        break;
      }
    }
    expect(served).toBeGreaterThan(0);

    const snapshot = await drive(harness, pending);
    expect(snapshot.outcome.kind).not.toBe('READY');
    expect(snapshot.armedStateEvidence).toBe('UNKNOWN_OR_STALE');
    expect(harness.controller.pulseMotor(1)).not.toBe('ACCEPTED');
  });

  it('blocks once a satisfied observation ages past the freshness bound', async () => {
    const harness = harnessFor();
    const ready = await runSetup(harness);
    expect(ready.activation.allowed).toBe(true);

    // No event, no callback, no new reading: the SAME observation simply
    // stops being fresh, and the gate is re-read at call time.
    harness.advanceMonotonic(5_000);
    expect(harness.controller.pulseMotor(1)).toBe('GATES_NOT_SATISFIED');

    harness.controller.requestStop('STOP_BUTTON_PRESSED');
    await flush(20);
    const stale = harness.controller.getSnapshot();
    expect(stale.armedStateEvidence).toBe('UNKNOWN_OR_STALE');
    expect(stale.activation.reasons).toContain('ARMED_STATE_UNKNOWN_OR_STALE');
  });
});

/* ================================================================== *
 * C. Motor scope, with 3D called out on its own
 * ================================================================== */

describe('motor scope through the real configuration reads', () => {
  it.each([
    [5, 'DSHOT150'],
    [6, 'DSHOT300'],
    [7, 'DSHOT600'],
    [8, 'PROSHOT1000'],
  ])('accepts raw protocol %i (%s) through the real setup path', async raw => {
    const harness = harnessFor([
      [MSP_ADVANCED_CONFIG, reply(advancedConfigPayload(raw))],
    ]);
    const snapshot = await runSetup(harness);

    expect(snapshot.outcome.kind).toBe('READY');
    expect(snapshot.motorScope?.motorProtocolRaw).toBe(raw);
    expect(snapshot.activation.allowed).toBe(true);
  });

  /**
   * REWRITTEN FOR THE P2 CLOSURE, and the split is the point. DIGITAL 3D
   * is a fully-resolved professional domain (the midpoint stop is the
   * firmware's own branch), so the SESSION now proceeds - while the OLD
   * pulse UI stays exactly as blocked as before, through the activation
   * gate it always used. What used to be one refusal is now two truthful
   * statements about two different consumers.
   */
  it('digital 3D: commandable end to end - the blanket 3D bar is gone', async () => {
    const harness = harnessFor([
      [MSP_FEATURE_CONFIG, reply(featureConfigPayload(FEATURE_3D_BIT))],
    ]);
    const snapshot = await runSetup(harness);

    expect(snapshot.outcome).toEqual({kind: 'READY'});
    expect(snapshot.motorScope?.feature3dEnabled).toBe(true);
    // The domain is the pinned 3D semantics - stop is the midpoint.
    expect(snapshot.motorDomain?.stopValue).toBe(1500);
    expect(snapshot.motorRuntimeScope?.eligible).toBe(true);
    // M-C: motorControlRuntimeScope is now the SOLE owner of the 3D
    // question, and it proves this domain. Digital 3D is commandable; what
    // stays refused is analog 3D, asserted below.
    expect(snapshot.activation.allowed).toBe(true);
    expect(harness.controller.pulseMotor(1)).toBe('ACCEPTED');
    harness.controller.requestStop('STOP_BUTTON_PRESSED');
    await flush();
  });

  it('non-four motor counts: commandable 1..N, and N+1 refused', async () => {
    const harness = harnessFor([
      [MSP_MOTOR_CONFIG, reply(motorConfigPayload(6))],
    ]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome).toEqual({kind: 'READY'});
    // M-C: the four-motor restriction was never a firmware fact.
    expect(snapshot.activation.allowed).toBe(true);
    expect(harness.controller.pulseMotor(6)).toBe('ACCEPTED');
    harness.controller.requestStop('STOP_BUTTON_PRESSED');
    await flush();
    expect(harness.controller.pulseMotor(7)).toBe('INVALID_MOTOR');
  });

  it('analog non-3D: commandable under CONFIGURATION_POLICY bounds', async () => {
    const harness = harnessFor([
      [MSP_ADVANCED_CONFIG, reply(advancedConfigPayload(4))],
    ]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome).toEqual({kind: 'READY'});
    expect(snapshot.motorDomain?.domainSource).toBe('CONFIGURATION_POLICY');
    expect(snapshot.activation.allowed).toBe(true);
  });

  it('analog 3D: refused outright, exactly as before - M-C weakened nothing', async () => {
    const harness = harnessFor([
      [MSP_ADVANCED_CONFIG, reply(advancedConfigPayload(4))],
      [MSP_FEATURE_CONFIG, reply(featureConfigPayload(FEATURE_3D_BIT))],
    ]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome).toMatchObject({
      kind: 'BLOCKED',
      reason: 'ANALOG_3D_ENDPOINTS_UNKNOWN',
    });
    // The refusal names what is MISSING, not a policy preference.
    expect(snapshot.motorRuntimeScope).toMatchObject({eligible: false});
  });
});

/* ================================================================== *
 * D. The command encoding, unchanged by the simplification
 * ================================================================== */

describe('the command encoding is byte-identical to before', () => {
  it('M1 produces exactly one slot above stop, in slot 0', async () => {
    const harness = harnessFor();
    await runSetup(harness);

    expect(harness.controller.pulseMotor(1)).toBe('ACCEPTED');
    await flush();
    // The write is on the transport before anything is served.
    expect(harness.transport.writes).toHaveLength(1);
    const data = harness.transport.writes[0].data;
    expect(writtenCommand(data)).toBe(MSP_SET_MOTOR_FIXTURE);
    expect(Array.from(data.subarray(5, 5 + data[3]))).toEqual(
      EXPECTED_M1_PAYLOAD,
    );
  });

  it.each([
    [1, 0],
    [2, 1],
    [3, 2],
    [4, 3],
  ])('motor %i drives payload slot %i and no other', async (motor, slot) => {
    const harness = harnessFor();
    await runSetup(harness);

    expect(harness.controller.pulseMotor(motor)).toBe('ACCEPTED');
    await flush();
    const data = harness.transport.writes[0].data;
    const payload = Array.from(data.subarray(5, 5 + data[3]));
    const values: number[] = [];
    for (let index = 0; index < 8; index++) {
      values.push(payload[index * 2] + payload[index * 2 + 1] * 256);
    }
    expect(values[slot]).toBe(1050);
    for (let index = 0; index < 8; index++) {
      if (index !== slot) {
        expect(values[index]).toBe(1000);
      }
    }
  });

  it('release produces the all-stop vector, every slot at stop', async () => {
    const harness = harnessFor();
    await runSetup(harness);

    expect(harness.controller.pulseMotor(2)).toBe('ACCEPTED');
    await flush();
    await serveOne(harness);

    harness.controller.requestStop('TOUCH_RELEASED');
    await flush(20);

    const stops = harness.writes.filter(
      write => write.command === MSP_SET_MOTOR_FIXTURE,
    );
    // The pulse, then the stop - and the stop is the all-stop vector.
    await serveOne(harness);
    const allWrites = harness.writes.filter(
      write => write.command === MSP_SET_MOTOR_FIXTURE,
    );
    expect(allWrites.length).toBeGreaterThan(stops.length - 1);
    expect(
      allWrites.map(write => write.payload),
    ).toContainEqual(EXPECTED_STOP_PAYLOAD);
  });
});

/* ================================================================== *
 * E. Nothing that must not write, can write
 * ================================================================== */

describe('states that must be incapable of writing', () => {
  /** Every command-214 payload that reached the transport. */
  const motorWrites = (harness: Harness): number[][] =>
    harness.writes
      .filter(write => write.command === MSP_SET_MOTOR_FIXTURE)
      .map(write => write.payload);

  it('a CLOSED controller cannot write', async () => {
    const harness = harnessFor();
    await runSetup(harness);
    await drive(harness, harness.controller.close());
    const before = motorWrites(harness).length;

    expect(harness.controller.pulseMotor(1)).toBe('CONTROLLER_CLOSED');
    await flush(20);
    expect(motorWrites(harness)).toHaveLength(before);
  });

  it('a CLOSING controller cannot write', async () => {
    const harness = harnessFor();
    await runSetup(harness);
    const closing = harness.controller.close();

    // Synchronously inside the teardown window.
    expect(harness.controller.pulseMotor(1)).toBe('CONTROLLER_CLOSED');
    await drive(harness, closing);

    // Teardown legitimately writes its OWN all-stop vector, so the probe
    // is not "no command 214" - it is that no slot was ever driven above
    // stop, i.e. the refused activation encoded nothing.
    for (const payload of motorWrites(harness)) {
      expect(payload).toEqual(EXPECTED_STOP_PAYLOAD);
    }
  });

  it('an INVALIDATED session cannot write', async () => {
    const harness = harnessFor();
    await runSetup(harness);
    const before = motorWrites(harness).length;

    harness.invalidate('USB_DETACHED');
    await flush();

    expect(harness.controller.pulseMotor(1)).not.toBe('ACCEPTED');
    await flush(20);
    expect(motorWrites(harness)).toHaveLength(before);
  });

  it('a REPLACED session cannot write', async () => {
    const harness = harnessFor();
    await runSetup(harness);
    const before = motorWrites(harness).length;

    // The composite identity moves without any invalidation callback: the
    // gate must notice on its own.
    harness.identity = {
      physicalGeneration: PHYSICAL_GENERATION + 1,
      mspEpoch: 0,
    };

    expect(harness.controller.pulseMotor(1)).not.toBe('ACCEPTED');
    await flush(20);
    expect(motorWrites(harness)).toHaveLength(before);
  });

  it('a FAULTED controller cannot write', async () => {
    const harness = harnessFor();
    await runSetup(harness);
    expect(harness.controller.pulseMotor(1)).toBe('ACCEPTED');
    await flush();
    const before = motorWrites(harness).length;

    // A genuine physical detach faults the session.
    harness.transport.emitSessionDetached('motor-test-bench-gate-session');
    await flush(20);
    expect(harness.controller.getSnapshot().machine?.name).toBe('Fault');

    expect(harness.controller.pulseMotor(2)).not.toBe('ACCEPTED');
    await flush(20);
    expect(motorWrites(harness)).toHaveLength(before);
  });

  it('a PULSE-LIVE controller starts no second motor', async () => {
    const harness = harnessFor();
    await runSetup(harness);
    expect(harness.controller.pulseMotor(1)).toBe('ACCEPTED');
    await flush();

    // A switch STOPS the live episode and starts nothing: two motors can
    // never be commanded by one gesture.
    expect(harness.controller.pulseMotor(3)).toBe(
      'SWITCH_REQUIRES_NEW_ACTIVATION',
    );
    await flush(20);
    for (const payload of motorWrites(harness)) {
      // Slot 2 (motor 3) is never above stop anywhere on the wire.
      expect(payload[4] + payload[5] * 256).toBe(1000);
    }
  });

  it('a STOP-IN-PROGRESS controller cannot start a new pulse', async () => {
    const harness = harnessFor();
    await runSetup(harness);
    expect(harness.controller.pulseMotor(1)).toBe('ACCEPTED');
    await flush();
    await serveOne(harness);

    harness.controller.requestStop('TOUCH_RELEASED');
    // The stop is registered SYNCHRONOUSLY, before this line runs.
    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.activation.reasons).toContain('PULSE_OR_STOP_IN_PROGRESS');
    expect(harness.controller.pulseMotor(1)).not.toBe('ACCEPTED');
  });
});

/* ================================================================== *
 * F. Every mandatory stop trigger still works
 * ================================================================== */

describe('the mandatory stop triggers', () => {
  const MANDATORY = [
    'TOUCH_RELEASED',
    'STOP_BUTTON_PRESSED',
    'MOTOR_SELECTION_CHANGED',
    'PULSE_DEADLINE_ELAPSED',
    'NAVIGATION_BLURRED',
    'ANDROID_BACK',
    'ANDROID_PREDICTIVE_BACK',
    'APP_STATE_BACKGROUNDED',
    'ARMED_STATE_DETECTED',
    'SAFETY_MONITORING_FAILED',
  ] as const;

  it.each(MANDATORY)(
    '%s stops a live pulse with the real all-stop vector',
    async trigger => {
      const harness = harnessFor();
      await runSetup(harness);
      expect(harness.controller.pulseMotor(1)).toBe('ACCEPTED');
      await flush();
      await serveOne(harness);

      expect(harness.controller.requestStop(trigger)).toBe('ACCEPTED');
      await flush(20);
      await serveOne(harness);
      await flush(20);

      const stops = harness.writes
        .filter(write => write.command === MSP_SET_MOTOR_FIXTURE)
        .map(write => write.payload);
      expect(stops).toContainEqual(EXPECTED_STOP_PAYLOAD);
    },
  );

  it('a USB detach stops without needing the operator', async () => {
    const harness = harnessFor();
    await runSetup(harness);
    expect(harness.controller.pulseMotor(1)).toBe('ACCEPTED');
    await flush();

    harness.invalidate('USB_DETACHED');
    await flush(20);

    // The session is closing and no further activation is possible - the
    // operator was never asked and never had to be.
    const snapshot = harness.controller.getSnapshot();
    expect(['CLOSING', 'CLOSED']).toContain(snapshot.phase);
    expect(snapshot.outcome).toMatchObject({requiresNewSession: true});
    expect(harness.controller.pulseMotor(1)).not.toBe('ACCEPTED');
  });

  it('a session replacement stops without needing the operator', async () => {
    const harness = harnessFor();
    await runSetup(harness);
    expect(harness.controller.pulseMotor(1)).toBe('ACCEPTED');
    await flush();

    harness.invalidate('SESSION_CHANGED');
    await flush(20);

    const snapshot = harness.controller.getSnapshot();
    expect(['CLOSING', 'CLOSED']).toContain(snapshot.phase);
    expect(snapshot.outcome).toMatchObject({requiresNewSession: true});
    expect(harness.controller.pulseMotor(1)).not.toBe('ACCEPTED');
  });

  it('rejects a trigger outside the whitelist without touching anything', async () => {
    const harness = harnessFor();
    await runSetup(harness);
    const before = harness.transport.writeLog.length;
    expect(
      harness.controller.requestStop(
        'NOT_A_REAL_TRIGGER' as unknown as 'TOUCH_RELEASED',
      ),
    ).toBe('UNRECOGNIZED_STOP_TRIGGER');
    await flush(20);
    expect(harness.transport.writeLog).toHaveLength(before);
  });
});

/* ================================================================== *
 * G. One requester, one writer
 * ================================================================== */

describe('one serialized MSP request path', () => {
  it('never has two requests outstanding at once', async () => {
    const harness = harnessFor();
    // The transport records every write. If the monitor were a second
    // requester with its own path, a configuration read and an observation
    // could be in flight together - so the invariant is checked at every
    // step of a real bring-up, not merely at the end.
    let settled = false;
    const pending = harness.controller.initializeSession().then(value => {
      settled = true;
      return value;
    });
    for (let step = 0; step < 400 && !settled; step++) {
      await flush(3);
      expect(harness.transport.writes.length).toBeLessThanOrEqual(1);
      if (settled) {
        break;
      }
      await serveOne(harness);
    }
    await pending;

    expect(harness.controller.getSnapshot().outcome).toEqual({kind: 'READY'});
  });

  it('runs the observation through the SAME lease as the pulse and the stop', async () => {
    const harness = harnessFor();
    await runSetup(harness);

    // A second lease cannot be acquired while this controller holds one,
    // and the observation demonstrably travelled it: MSP_STATUS_EX was
    // served on the very transport the pulse is about to use.
    expect(harness.commands).toContain(MSP_STATUS_EX);
    expect(harness.controller.pulseMotor(1)).toBe('ACCEPTED');
    await flush();
    expect(writtenCommand(harness.transport.writes[0].data)).toBe(
      MSP_SET_MOTOR_FIXTURE,
    );
  });
});

/* ================================================================== *
 * H. THE NORMAL RELEASE LIFECYCLE
 *
 * READY -> pulse M1 -> release -> confirmed all-stop -> READY -> M2.
 *
 * THE DEFECT THIS BLOCK EXISTS FOR, recorded from the device. Releasing
 * the hold control put the app into a terminal fault showing "stop could
 * not be confirmed - disconnect the LiPo", and a completely new session
 * was required to test a second motor. Three separate causes, each
 * sufficient on its own:
 *
 *   1. the controller never dispatched STOP_ACKNOWLEDGED, so the reducer
 *      could never leave `Stopping` even after a perfect stop;
 *   2. the priority stop displaced the safety monitor's in-flight
 *      MSP_STATUS_EX, and that EXPECTED cancellation was reported as
 *      SAFETY_OBSERVATION_FAILED -> SAFETY_MONITORING_FAILED -> Fault;
 *   3. when the pulse's own command 214 was still unsettled, the stop
 *      displaced it, the client raised attributionAmbiguous, and the
 *      controller failed the lease closed.
 *
 * Every test below drives the REAL monitor and the REAL client.
 * ================================================================== */

/** Lets the monitor's paced next observation reach the transport, so a
 * release genuinely races an in-flight MSP_STATUS_EX exactly as it does on
 * a device. Uses the production interval rather than assuming a zero-delay
 * loop. */
const nextMonitorTurn = (): Promise<void> =>
  new Promise<void>(resolve =>
    setTimeout(resolve, MOTOR_TEST_SAFETY_OBSERVATION_INTERVAL_MILLIS + 10),
  );

/** Serves pending writes until `until()` holds or the bound is reached. */
async function pump(harness: Harness, until: () => boolean): Promise<void> {
  for (let step = 0; step < 80 && !until(); step++) {
    await flush(4);
    if (until()) {
      return;
    }
    await serveOne(harness);
  }
  await flush(4);
}

const pendingCommands = (harness: Harness): number[] =>
  harness.transport.writes.map(write => writtenCommand(write.data));

const stopPayloads = (harness: Harness): number[][] =>
  harness.writes
    .filter(write => write.command === MSP_SET_MOTOR_FIXTURE)
    .map(write => write.payload)
    .filter(payload => payload.every((byte, index) => byte === EXPECTED_STOP_PAYLOAD[index]));

describe('the normal release lifecycle', () => {
  it('returns to READY when a release displaces an in-flight observation', async () => {
    const harness = harnessFor();
    await runSetup(harness);

    // The monitor's next observation is genuinely on the wire.
    await nextMonitorTurn();
    await flush(10);
    expect(pendingCommands(harness)).toContain(MSP_STATUS_EX);

    expect(harness.controller.pulseMotor(1)).toBe('ACCEPTED');
    await pump(harness, () => harness.controller.getSnapshot().pulse.acknowledged);
    expect(harness.controller.getSnapshot().machine?.name).toBe('Pulsing');

    harness.controller.requestStop('TOUCH_RELEASED');
    await pump(
      harness,
      () => harness.controller.getSnapshot().activation.allowed === true,
    );

    const snapshot = harness.controller.getSnapshot();
    // The displaced observation was EXPECTED - it is not evidence the FC
    // became unsafe, and it must not fault anything.
    expect(snapshot.machine?.name).toBe('Ready');
    expect(snapshot.outcome).toEqual({kind: 'READY'});
    expect(snapshot.phase).toBe('ACTIVE');
    expect(snapshot.stopExecution.commandAcknowledged).toBe(true);
    expect(snapshot.stopExecution.outcome).toEqual({kind: 'ACKNOWLEDGED'});
    // Monitoring resumed and proved the FC disarmed all over again.
    expect(snapshot.armedStateEvidence).toBe('FRESH_DISARMED');
    expect(snapshot.activation.allowed).toBe(true);
    // The session was NEVER torn down: same lease, same barrier.
    expect(snapshot.telemetryHeld).toBe(true);
    expect(snapshot.teardown).toBeUndefined();
    // And no LiPo instruction was ever warranted.
    expect(snapshot.warnings).toHaveLength(0);
  });

  it('runs M1 -> release -> M2 inside ONE session', async () => {
    const harness = harnessFor();
    await runSetup(harness);

    expect(harness.controller.pulseMotor(1)).toBe('ACCEPTED');
    await pump(harness, () => harness.controller.getSnapshot().pulse.acknowledged);

    harness.controller.requestStop('TOUCH_RELEASED');
    await pump(
      harness,
      () => harness.controller.getSnapshot().activation.allowed === true,
    );
    expect(harness.controller.getSnapshot().machine?.name).toBe('Ready');

    // The SECOND motor, in the same session - no reconnect, no new lease.
    expect(harness.controller.pulseMotor(2)).toBe('ACCEPTED');
    await flush(10);
    // UPDATED IN P2-ii, AND THE DIFFERENCE IS SCHEDULING, NOT SEMANTICS.
    // The stop now settles through the professional engine, which adds a
    // microtask hop before Ready republishes - so the resumed monitor's
    // MSP_STATUS_EX reaches the transport BEFORE this second pulse, and
    // the pulse queues behind it in the SAME serialized FIFO instead of
    // ahead of it. The wire content is identical; only the interleaving
    // moved. The assertion therefore serves the FIFO to the next motor
    // command instead of assuming the queue head.
    while (
      harness.transport.writes.length > 0 &&
      writtenCommand(harness.transport.writes[0].data) !== MSP_SET_MOTOR_FIXTURE
    ) {
      await serveOne(harness);
      await flush(4);
    }
    const write = harness.transport.writes[0];
    expect(writtenCommand(write.data)).toBe(MSP_SET_MOTOR_FIXTURE);
    // Slot 1 above stop, every other slot at stop - built from the shared
    // helper so the eight-slot padding rule is stated in one place.
    expect(
      Array.from(write.data.subarray(5, 5 + write.data[3])),
    ).toEqual(expectedPayloadForSlot(2));

    await pump(harness, () => harness.controller.getSnapshot().pulse.acknowledged);
    harness.controller.requestStop('TOUCH_RELEASED');
    await pump(
      harness,
      () => harness.controller.getSnapshot().activation.allowed === true,
    );

    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.machine?.name).toBe('Ready');
    expect(snapshot.pulse.attemptId).toBe(2);
    // Two genuinely separate stop episodes, never one replayed.
    expect(snapshot.stopExecution.episodeId).toBe(2);
    expect(snapshot.warnings).toHaveLength(0);
  });

  it('survives a release while the pulse is still WRITING', async () => {
    const harness = harnessFor();
    await runSetup(harness);

    expect(harness.controller.pulseMotor(1)).toBe('ACCEPTED');
    await flush(10);
    // The pulse's bytes are at the transport and its write has not settled.
    expect(harness.client.getActiveRequestPhase()).toBe('WRITING');

    harness.controller.requestStop('TOUCH_RELEASED');
    await pump(
      harness,
      () => harness.controller.getSnapshot().activation.allowed === true,
    );

    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.machine?.name).toBe('Ready');
    expect(snapshot.stopExecution.commandAcknowledged).toBe(true);
    // The stop waited for the uncancellable write rather than racing it -
    // two concurrent writeBytes() calls must never occur.
    expect(snapshot.stopExecution.deferredBehindActiveWrite).toBe(true);
    expect(snapshot.warnings).toHaveLength(0);
    // An all-stop vector genuinely reached the wire.
    expect(stopPayloads(harness).length).toBeGreaterThanOrEqual(1);
  });

  it('survives a release while the pulse AWAITS its reply', async () => {
    const harness = harnessFor();
    await runSetup(harness);

    expect(harness.controller.pulseMotor(1)).toBe('ACCEPTED');
    await flush(10);
    harness.transport.resolveNextWrite();
    await flush(10);
    // Written, unanswered: the ambiguous case, because the displaced
    // request carries command 214 exactly like the stop does.
    expect(harness.client.getActiveRequestPhase()).toBe('AWAITING_RESPONSE');

    harness.controller.requestStop('TOUCH_RELEASED');
    await pump(
      harness,
      () => harness.controller.getSnapshot().activation.allowed === true,
    );

    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.machine?.name).toBe('Ready');
    expect(snapshot.stopExecution.commandAcknowledged).toBe(true);
    // The ambiguity is RECORDED - it really happened - and it is recorded
    // as RESOLVED, by a second all-stop whose acknowledgement could not
    // have been the displaced pulse's response.
    expect(snapshot.stopExecution.attributionAmbiguous).toBe(true);
    expect(snapshot.stopExecution.attributionResolvedByConfirmation).toBe(true);
    expect(snapshot.warnings).toHaveLength(0);
  });

  it('survives a release AFTER the pulse was acknowledged', async () => {
    const harness = harnessFor();
    await runSetup(harness);

    expect(harness.controller.pulseMotor(1)).toBe('ACCEPTED');
    await pump(harness, () => harness.controller.getSnapshot().pulse.acknowledged);
    expect(harness.controller.getSnapshot().pulse.acknowledged).toBe(true);

    harness.controller.requestStop('TOUCH_RELEASED');
    await pump(
      harness,
      () => harness.controller.getSnapshot().activation.allowed === true,
    );

    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.machine?.name).toBe('Ready');
    expect(snapshot.stopExecution.outcome).toEqual({kind: 'ACKNOWLEDGED'});
    // Nothing was ambiguous: the pulse had already settled.
    expect(snapshot.stopExecution.attributionAmbiguous).toBe(false);
    expect(snapshot.warnings).toHaveLength(0);
  });

  it('stops the live motor on a selection change and starts nothing', async () => {
    const harness = harnessFor();
    await runSetup(harness);

    expect(harness.controller.pulseMotor(1)).toBe('ACCEPTED');
    await pump(harness, () => harness.controller.getSnapshot().pulse.acknowledged);

    // The switch STOPS motor 1 and refuses to start motor 3.
    expect(harness.controller.pulseMotor(3)).toBe('SWITCH_REQUIRES_NEW_ACTIVATION');
    await pump(
      harness,
      () => harness.controller.getSnapshot().activation.allowed === true,
    );

    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.machine?.name).toBe('Ready');
    // Motor 3 was NEVER commanded: slot 2 is at stop in every payload.
    for (const write of harness.writes) {
      if (write.command === MSP_SET_MOTOR_FIXTURE) {
        expect(write.payload[4] + write.payload[5] * 256).toBe(1000);
      }
    }
    // ... and a fresh long press is what starts it, in the same session.
    expect(harness.controller.pulseMotor(3)).toBe('ACCEPTED');
  });

  it('never reports an expected monitor displacement as SAFETY_MONITORING_FAILED', async () => {
    const harness = harnessFor();
    await runSetup(harness);

    await nextMonitorTurn();
    await flush(10);
    expect(pendingCommands(harness)).toContain(MSP_STATUS_EX);

    expect(harness.controller.pulseMotor(1)).toBe('ACCEPTED');
    await pump(harness, () => harness.controller.getSnapshot().pulse.acknowledged);
    harness.controller.requestStop('TOUCH_RELEASED');
    await pump(
      harness,
      () => harness.controller.getSnapshot().activation.allowed === true,
    );

    const reasons = harness.controller
      .getSnapshot()
      .stopDescriptors.map(descriptor => descriptor.stopReason);
    // The operator released. That is the ONLY stop reason that belongs in
    // this session's record.
    expect(reasons).toContain('TOUCH_RELEASED');
    expect(reasons).not.toContain('SAFETY_MONITORING_FAILED');
    expect(reasons).not.toContain('ARMED_STATE_DETECTED');
  });
});

/* ================================================================== *
 * I. WHAT MUST STILL BE TERMINAL
 * ================================================================== */

describe('genuinely unsafe outcomes stay terminal', () => {
  it('a REJECTED stop is terminal and demands the LiPo be disconnected', async () => {
    const harness = harnessFor();
    await runSetup(harness);
    expect(harness.controller.pulseMotor(1)).toBe('ACCEPTED');
    await pump(harness, () => harness.controller.getSnapshot().pulse.acknowledged);

    // The FC answers the all-stop with an MSP error.
    harness.script.set(MSP_SET_MOTOR_FIXTURE, REJECT);
    harness.controller.requestStop('TOUCH_RELEASED');
    await pump(
      harness,
      () => harness.controller.getSnapshot().machine?.name === 'Fault',
    );

    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.machine?.name).toBe('Fault');
    expect(snapshot.stopExecution.commandAcknowledged).toBe(false);
    expect(snapshot.activation.reasons).toContain('REQUIRES_NEW_CONNECTION');
    // The one case the red banner exists for.
    expect(snapshot.warnings.length).toBeGreaterThan(0);
    expect(harness.controller.pulseMotor(2)).not.toBe('ACCEPTED');
  });

  it('a stop that TIMES OUT is terminal and demands the LiPo be disconnected', async () => {
    jest.useFakeTimers();
    try {
      const harness = harnessFor();
      await runSetup(harness);
      expect(harness.controller.pulseMotor(1)).toBe('ACCEPTED');
      await flush(10);
      harness.transport.resolveNextWrite();
      await flush(10);
      harness.transport.emitData(
        buildMspFrameBytes(MSP_SET_MOTOR_FIXTURE, EMPTY, {
          wireFormat: 'v1',
          direction: 'response',
        }),
      );
      await flush(10);

      harness.controller.requestStop('TOUCH_RELEASED');
      await flush(10);
      // The all-stop reaches the transport and is NEVER answered.
      harness.transport.resolveNextWrite();
      await flush(10);
      expect(harness.controller.getSnapshot().machine?.name).toBe('Stopping');

      // The client's own response bound elapses.
      jest.advanceTimersByTime(MSP_RESPONSE_TIMEOUT_MILLIS + 50);
      await flush(30);

      const snapshot = harness.controller.getSnapshot();
      expect(snapshot.stopExecution.commandAcknowledged).toBe(false);
      expect(snapshot.stopExecution.outcome).toEqual({
        kind: 'FAILED',
        reason: 'REQUEST_FAILED',
      });
      expect(snapshot.machine?.name).toBe('Fault');
      expect(snapshot.warnings.length).toBeGreaterThan(0);
      expect(harness.controller.pulseMotor(2)).not.toBe('ACCEPTED');
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('an ARMED flight controller observed mid-session is terminal', async () => {
    const harness = harnessFor();
    await runSetup(harness);

    harness.script.set(MSP_STATUS_EX, reply(statusPayload(true)));
    await nextMonitorTurn();
    await pump(
      harness,
      () => harness.controller.getSnapshot().armedStateEvidence === 'FC_ARMED',
    );

    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.armedStateEvidence).toBe('FC_ARMED');
    expect(snapshot.activation.reasons).toContain('FC_ARMED');
    expect(harness.controller.pulseMotor(1)).not.toBe('ACCEPTED');
  });

  it('a USB detach is terminal', async () => {
    const harness = harnessFor();
    await runSetup(harness);
    harness.invalidate('USB_DETACHED');
    await flush(20);
    expect(harness.controller.getSnapshot().outcome).toMatchObject({
      requiresNewSession: true,
    });
    expect(harness.controller.pulseMotor(1)).not.toBe('ACCEPTED');
  });

  it('a session replacement is terminal', async () => {
    const harness = harnessFor();
    await runSetup(harness);
    harness.invalidate('SESSION_CHANGED');
    await flush(20);
    expect(harness.controller.getSnapshot().outcome).toMatchObject({
      requiresNewSession: true,
    });
    expect(harness.controller.pulseMotor(1)).not.toBe('ACCEPTED');
  });
});

/* ================================================================== *
 * J. ALL FOUR MOTORS, ANY ORDER, REPEATEDLY, IN ONE SESSION
 *
 * SCOPE CORRECTION, RECORDED. The release lifecycle was first proven with
 * "M1 then M2", and M1/M2 were only ever examples. The feature is four
 * equal output slots: an operator must be able to test M1, M2, M3 and M4
 * in ANY order, come back to one already tested, and repeat - all inside
 * one continuous session, with no LiPo cycle, no USB re-plug, no new
 * session and no repeated bring-up.
 *
 * These are ACCEPTANCE tests: they drive the real controller, the real
 * lease, the real monitor and the real client, and they assert on the
 * bytes that reached the wire per slot.
 * ================================================================== */

/** The exact MSP_SET_MOTOR payload for one slot at the fixed test value,
 * every other output at stop. Built here from the slot index rather than
 * copied, so a wrong-slot payload cannot pass by being pasted twice. */
function expectedPayloadForSlot(slot: number): number[] {
  const bytes: number[] = [];
  // M-C: EIGHT slots. The four past a quad's motor count are padding the
  // firmware never reads, and they carry the stop value rather than zero
  // so that a count we believed too low can only ever be read as stop.
  for (let index = 0; index < 8; index++) {
    bytes.push(...u16(index === slot - 1 ? 1050 : 1000));
  }
  return bytes;
}

/** One complete operator gesture: long press, confirm the FC saw it,
 * release, and wait for the session to be activatable again. */
async function testOneMotor(harness: Harness, slot: number): Promise<void> {
  expect(harness.controller.pulseMotor(slot)).toBe('ACCEPTED');
  await pump(harness, () => harness.controller.getSnapshot().pulse.acknowledged);
  expect(harness.controller.getSnapshot().pulse.motorNumber).toBe(slot);

  harness.controller.requestStop('TOUCH_RELEASED');
  await pump(
    harness,
    () => harness.controller.getSnapshot().activation.allowed === true,
  );
  expect(harness.controller.getSnapshot().machine?.name).toBe('Ready');
}

/** Every command-214 payload written, in order. */
const motorPayloads = (harness: Harness): number[][] =>
  harness.writes
    .filter(write => write.command === MSP_SET_MOTOR_FIXTURE)
    .map(write => write.payload);

/** Only the payloads that drove some slot above stop. */
const drivePayloads = (harness: Harness): number[][] =>
  motorPayloads(harness).filter(
    payload => payload.join(',') !== EXPECTED_STOP_PAYLOAD.join(','),
  );

describe('all four motors, one session', () => {
  it.each([1, 2, 3, 4])(
    'tests M%i and returns to READY without ending the session',
    async slot => {
      const harness = harnessFor();
      await runSetup(harness);
      const barrierHeldBefore = harness.controller.getSnapshot().telemetryHeld;

      await testOneMotor(harness, slot);

      const snapshot = harness.controller.getSnapshot();
      expect(snapshot.outcome).toEqual({kind: 'READY'});
      expect(snapshot.phase).toBe('ACTIVE');
      expect(snapshot.warnings).toHaveLength(0);
      // Same lease, same barrier, no teardown: no LiPo cycle, no re-plug.
      expect(snapshot.telemetryHeld).toBe(barrierHeldBefore);
      expect(snapshot.teardown).toBeUndefined();
      // Exactly this slot was driven, and exactly once.
      expect(drivePayloads(harness)).toEqual([expectedPayloadForSlot(slot)]);
    },
  );

  it('runs M1 -> M2 -> M3 -> M4 in one session', async () => {
    const harness = harnessFor();
    await runSetup(harness);

    for (const slot of [1, 2, 3, 4]) {
      await testOneMotor(harness, slot);
    }

    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.machine?.name).toBe('Ready');
    expect(snapshot.pulse.attemptId).toBe(4);
    expect(snapshot.stopExecution.episodeId).toBe(4);
    expect(snapshot.warnings).toHaveLength(0);
    // Four drives, one per slot, in the order requested.
    expect(drivePayloads(harness)).toEqual([1, 2, 3, 4].map(expectedPayloadForSlot));
  });

  it('runs an ARBITRARY order - M3, M1, M4, M2 - in one session', async () => {
    const harness = harnessFor();
    await runSetup(harness);

    const order = [3, 1, 4, 2];
    for (const slot of order) {
      await testOneMotor(harness, slot);
    }

    expect(harness.controller.getSnapshot().machine?.name).toBe('Ready');
    expect(drivePayloads(harness)).toEqual(order.map(expectedPayloadForSlot));
  });

  it('returns to a PREVIOUSLY TESTED motor in the same session', async () => {
    const harness = harnessFor();
    await runSetup(harness);

    // The exact sequence the operator asked for.
    const order = [1, 2, 3, 4, 1];
    for (const slot of order) {
      await testOneMotor(harness, slot);
    }

    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.machine?.name).toBe('Ready');
    expect(snapshot.activation.allowed).toBe(true);
    expect(snapshot.pulse.attemptId).toBe(5);
    // M1 was driven twice - the fifth drive is M1 again, not a stale
    // replay of the first and not a refusal.
    expect(drivePayloads(harness)).toEqual(order.map(expectedPayloadForSlot));
    expect(snapshot.warnings).toHaveLength(0);
    expect(snapshot.teardown).toBeUndefined();
  });

  it.each([1, 2, 3, 4])(
    'repeats M%i three times in a row without a new session',
    async slot => {
      const harness = harnessFor();
      await runSetup(harness);

      await testOneMotor(harness, slot);
      await testOneMotor(harness, slot);
      await testOneMotor(harness, slot);

      const snapshot = harness.controller.getSnapshot();
      expect(snapshot.machine?.name).toBe('Ready');
      expect(snapshot.pulse.attemptId).toBe(3);
      // Three genuinely separate stop episodes - never one replayed.
      expect(snapshot.stopExecution.episodeId).toBe(3);
      expect(drivePayloads(harness)).toEqual([
        expectedPayloadForSlot(slot),
        expectedPayloadForSlot(slot),
        expectedPayloadForSlot(slot),
      ]);
    },
  );

  it('never drives two slots at once, across a whole four-motor sweep', async () => {
    const harness = harnessFor();
    await runSetup(harness);
    for (const slot of [4, 2, 1, 3, 2]) {
      await testOneMotor(harness, slot);
    }

    // THE PAYLOAD-ISOLATION INVARIANT, checked on every byte that was
    // written rather than on the last one: at most one slot above stop.
    for (const payload of motorPayloads(harness)) {
      const values = [0, 1, 2, 3].map(
        index => payload[index * 2] + payload[index * 2 + 1] * 256,
      );
      expect(values.filter(value => value !== 1000).length).toBeLessThanOrEqual(1);
      for (const value of values) {
        expect(value === 1000 || value === 1050).toBe(true);
      }
    }
  });

  it.each([
    [1, 3],
    [2, 4],
    [3, 1],
    [4, 2],
  ])(
    'a selection change from M%i to M%i stops the first and starts nothing',
    async (from, to) => {
      const harness = harnessFor();
      await runSetup(harness);

      expect(harness.controller.pulseMotor(from)).toBe('ACCEPTED');
      await pump(harness, () => harness.controller.getSnapshot().pulse.acknowledged);

      expect(harness.controller.pulseMotor(to)).toBe(
        'SWITCH_REQUIRES_NEW_ACTIVATION',
      );
      await pump(
        harness,
        () => harness.controller.getSnapshot().activation.allowed === true,
      );

      // Only the FIRST motor was ever driven by that gesture.
      expect(drivePayloads(harness)).toEqual([expectedPayloadForSlot(from)]);
      // ... and a NEW deliberate press is what starts the second one.
      expect(harness.controller.pulseMotor(to)).toBe('ACCEPTED');
      await pump(harness, () => harness.controller.getSnapshot().pulse.acknowledged);
      expect(drivePayloads(harness)).toEqual([
        expectedPayloadForSlot(from),
        expectedPayloadForSlot(to),
      ]);
    },
  );

  it('does not repeat bring-up: no configuration or box read after setup', async () => {
    const harness = harnessFor();
    await runSetup(harness);
    const afterSetup = harness.commands.length;

    for (const slot of [1, 2, 3, 4]) {
      await testOneMotor(harness, slot);
    }

    // Everything after bring-up is motor commands and armed-state reads.
    // The configuration and the box mapping are read ONCE per session.
    const later = harness.commands.slice(afterSetup);
    expect(later).not.toContain(MSP_MOTOR_CONFIG);
    expect(later).not.toContain(MSP_ADVANCED_CONFIG);
    expect(later).not.toContain(MSP_FEATURE_CONFIG);
    expect(later).not.toContain(MSP_BOXIDS);
    expect(later).not.toContain(MSP_SET_ARMING_DISABLED_FIXTURE);
  });
});

/* ================================================================== *
 * P2-ii-A - THE P1 DOMAIN, RESOLVED INSIDE THE LIVE ENABLE PATH
 *
 * The domain is DESCRIPTIVE. Resolving one never widens what the shipping
 * pulse path will command - `motorScope` and the legacy scope guard still
 * decide that on their own terms, which the assertions below pin down.
 * Nothing here asserts a physical outcome.
 * ================================================================== */

describe('P2-ii-A - domain resolution in the live enable path', () => {
  it('resolves the P1 domain and finds the runtime scope ELIGIBLE', async () => {
    const harness = harnessFor([]);
    const snapshot = await runSetup(harness);

    expect(snapshot.outcome.kind).toBe('READY');
    expect(snapshot.motorDomain).toBeDefined();
    expect(snapshot.motorDomain?.protocolFamily).toBe('DSHOT');
    expect(snapshot.motorDomain?.feature3dEnabled).toBe(false);
    // Digital non-3D is firmware-constrained, and stop is 1000.
    expect(snapshot.motorDomain?.domainSource).toBe('FIRMWARE_CONSTRAIN');
    expect(snapshot.motorDomain?.stopValue).toBe(1000);
    expect(snapshot.motorRuntimeScope?.eligible).toBe(true);
  });

  it('sends NO MSP_MOTOR_3D_CONFIG frame for a non-3D aircraft', async () => {
    const harness = harnessFor([]);
    await runSetup(harness);
    // The shipping enable byte stream is unchanged: the read fires only
    // where its result can be used.
    expect(harness.commands).not.toContain(MSP_MOTOR_3D_CONFIG);
  });

  it('digital 3D reads 124 and resolves the FULL domain from its bytes', async () => {
    // REWRITTEN FOR THE P2 CLOSURE: this used to assert the refusal and
    // the ABSENCE of command 124. The professional runtime now owns 3D
    // eligibility, so the read fires and its result participates in
    // domain resolution - never a decorative request.
    const harness = harnessFor([
      [MSP_FEATURE_CONFIG, reply(featureConfigPayload(FEATURE_3D_BIT))],
    ]);
    const snapshot = await runSetup(harness);

    expect(harness.commands).toContain(MSP_MOTOR_3D_CONFIG);
    expect(snapshot.outcome).toEqual({kind: 'READY'});
    expect(snapshot.motorDomain?.neutral).toBe(1500);
    expect(snapshot.motorDomain?.provenReverseRegion).toEqual({
      min: 1000,
      max: 1499,
    });
    expect(snapshot.motorDomain?.provenForwardRegion).toEqual({
      min: 1501,
      max: 2000,
    });
  });

  it('carries the exact command-domain bounds the encoder would use', async () => {
    const harness = harnessFor([]);
    const snapshot = await runSetup(harness);
    expect(snapshot.motorDomain?.commandDomainMin).toBe(1000);
    expect(snapshot.motorDomain?.commandDomainMax).toBe(2000);
  });
});

/* ================================================================== *
 * P2-ii - HARNESS WIRE-FORMAT FIDELITY
 *
 * These drive the REAL MspClient over the fake transport and the same
 * reply helpers the whole suite uses. They exist because a v1 error frame
 * answering a v2 request wedged the FIFO for an entire session - the
 * client is CORRECT to require matching framing, and the harness must be
 * a faithful API 1.47 device, which speaks MSPv2.
 * ================================================================== */

describe('harness wire-format fidelity', () => {
  const CMD_V1 = MSP_STATUS_EX;
  const CMD_V2 = 0x3003; // MSP2_SEND_DSHOT_COMMAND

  interface ProtocolRig {
    readonly client: MspClient;
    readonly transport: FakeMspTransport;
    serveOnce(reply: 'RESPONSE' | 'ERROR', payload?: Uint8Array): Promise<ParsedHarnessWrite>;
  }

  function protocolRig(): ProtocolRig {
    const transport = new FakeMspTransport();
    const client = new MspClient(transport, 'wire-format-rig');
    return {
      client,
      transport,
      async serveOnce(reply, payload = EMPTY) {
        await flush();
        const data = transport.writes[transport.writes.length - 1].data;
        const write = parseHarnessWrite(data);
        transport.resolveNextWrite();
        await flush();
        transport.emitData(
          reply === 'RESPONSE'
            ? replyFrame(write, payload)
            : errorReplyFrame(write),
        );
        await flush();
        return write;
      },
    };
  }

  it('v1 request -> v1 success reply matches, preserving the command', async () => {
    const rig = protocolRig();
    const request = rig.client.request(CMD_V1, EMPTY, {wireFormat: 'v1'});
    const write = await rig.serveOnce('RESPONSE', statusPayload());
    expect(write.wireFormat).toBe('v1');
    expect(write.command).toBe(CMD_V1);
    await expect(request).resolves.toMatchObject({command: CMD_V1});
    rig.client.dispose();
  });

  it('v1 request -> v1 error reply settles as a rejection', async () => {
    const rig = protocolRig();
    const request = rig.client.request(CMD_V1, EMPTY, {wireFormat: 'v1'});
    const write = await rig.serveOnce('ERROR');
    expect(write.wireFormat).toBe('v1');
    await expect(request).rejects.toBeDefined();
    rig.client.dispose();
  });

  it('v2 request -> v2 success reply matches, preserving the 16-bit command', async () => {
    const rig = protocolRig();
    const request = rig.client.request(CMD_V2, Uint8Array.from([1, 255, 1, 0, 0]), {
      wireFormat: 'v2',
    });
    const write = await rig.serveOnce('RESPONSE');
    expect(write.wireFormat).toBe('v2');
    // The full 16-bit id - a v1-shaped parse would have read 0x03.
    expect(write.command).toBe(CMD_V2);
    await expect(request).resolves.toMatchObject({command: CMD_V2});
    rig.client.dispose();
  });

  it('v2 request -> v2 error reply settles instead of leaving it pending', async () => {
    const rig = protocolRig();
    const request = rig.client.request(CMD_V2, EMPTY, {wireFormat: 'v2'});
    const write = await rig.serveOnce('ERROR');
    expect(write.wireFormat).toBe('v2');
    await expect(request).rejects.toBeDefined();
    rig.client.dispose();
  });

  it('a settled v2 error does not wedge the FIFO: the next v1 request proceeds', async () => {
    const rig = protocolRig();
    // The exact shape that wedged a whole session: optional MSP2, rejected.
    const optional = rig.client.request(CMD_V2, EMPTY, {wireFormat: 'v2'});
    await rig.serveOnce('ERROR');
    await expect(optional).rejects.toBeDefined();

    // The FIFO is free: an ordinary v1 request goes out and completes.
    const next = rig.client.request(CMD_V1, EMPTY, {wireFormat: 'v1'});
    const write = await rig.serveOnce('RESPONSE', statusPayload());
    expect(write.wireFormat).toBe('v1');
    expect(write.command).toBe(CMD_V1);
    await expect(next).resolves.toMatchObject({command: CMD_V1});
    rig.client.dispose();
  });
});

/* ================================================================== *
 * M-C. THE AIRFRAME MATRIX, THROUGH THE REAL PRODUCTION PATH.
 *
 * Every case below runs the REAL MotorTestController over the REAL
 * MspClient and the REAL MotorTestLease, with the real safety monitor
 * polling real MSP_STATUS_EX bytes, against a scripted flight controller
 * that answers with the payloads a board of that shape would send. The
 * only fake is the transport.
 *
 * WHAT IS BEING PROVEN, and why each half matters:
 *
 *   1. A tricopter, a hexacopter, an octocopter, a fixed wing, a custom
 *      mixer and an unrecognised mixer all reach a commandable session,
 *      and each exposes EXACTLY its own motor outputs - N addressable,
 *      N+1 refused with nothing on the wire.
 *
 *   2. The MSP_SET_MOTOR frame is SIXTEEN BYTES in every one of those
 *      cases. That is the half a per-airframe payload would break, and
 *      it is the half that matters on API 1.47, where the handler reads
 *      getMotorCount() values with no length guard at all.
 *
 * NO HARDWARE. Nothing here claims a motor turned, an ESC responded, or
 * that any value is safe. Physical behaviour remains REQUIRES HARDWARE
 * TEST.
 * ================================================================== */

/** MSP_MIXER_CONFIG: u8 mixerMode, u8 yaw_motors_reversed. */
function mixerConfigPayload(mixerMode: number): Uint8Array {
  return Uint8Array.from([mixerMode, 0]);
}

/** One airframe, described exactly as its flight controller would answer.
 * `mixerMode` is carried so the fixture is a real airframe rather than a
 * motor count wearing a quad's mixer byte - and so the unknown-mixer case
 * can be stated at all. */
interface AirframeCase {
  readonly name: string;
  readonly mixerMode: number;
  readonly motorCount: number;
}

const AIRFRAMES: readonly AirframeCase[] = [
  {name: 'TRI', mixerMode: 1, motorCount: 3},
  {name: 'QUADX', mixerMode: 3, motorCount: 4},
  {name: 'HEX6X', mixerMode: 10, motorCount: 6},
  {name: 'OCTOX8', mixerMode: 11, motorCount: 8},
  {name: 'AIRPLANE', mixerMode: 14, motorCount: 1},
  {name: 'FLYING_WING', mixerMode: 8, motorCount: 1},
  // A custom mixer whose count only the running firmware knows: the CLI
  // `mmix` rows are on no MSP command at this pin, so five is observed
  // and could never have been predicted.
  {name: 'CUSTOM', mixerMode: 23, motorCount: 5},
  // A mixer byte outside the 27 the pinned table covers. Not knowing what
  // the airframe IS must not stop numbered motor control from working.
  {name: 'UNKNOWN MIXER', mixerMode: 250, motorCount: 3},
];

function airframeHarness(airframe: AirframeCase): Harness {
  return harnessFor([
    [MSP_MOTOR_CONFIG, reply(motorConfigPayload(airframe.motorCount))],
    [MSP_MIXER_CONFIG, reply(mixerConfigPayload(airframe.mixerMode))],
  ]);
}

/** Every MSP_SET_MOTOR frame this harness has put on the transport. */
function motorFrames(harness: Harness): number[][] {
  return harness.transport.writeLog
    .filter(data => writtenCommand(data) === MSP_SET_MOTOR_FIXTURE)
    .map(data => Array.from(data.subarray(5, 5 + data[3])));
}

describe('M-C - every airframe reaches a commandable session', () => {
  it.each(AIRFRAMES.map(a => [a.name, a] as const))(
    '%s: opens, and offers exactly its own motor outputs',
    async (_name, airframe) => {
      const harness = airframeHarness(airframe);
      const snapshot = await runSetup(harness);

      expect(snapshot.outcome).toEqual({kind: 'READY'});
      // The count comes from MSP_MOTOR_CONFIG offset 6 and nowhere else.
      expect(snapshot.motorScope?.motorCount).toBe(airframe.motorCount);
      expect(snapshot.activation.allowed).toBe(true);

      // Every logical motor this aircraft has is addressable, through a
      // complete gesture each time - press, acknowledge, release, and
      // wait for the session to be activatable again.
      for (let motor = 1; motor <= airframe.motorCount; motor++) {
        await testOneMotor(harness, motor);
      }
      // ...and the one past it is not, with nothing on the wire for it.
      const before = harness.transport.writeLog.length;
      expect(harness.controller.pulseMotor(airframe.motorCount + 1)).toBe(
        'INVALID_MOTOR',
      );
      expect(harness.controller.pulseMotor(0)).toBe('INVALID_MOTOR');
      expect(harness.transport.writeLog).toHaveLength(before);
    },
  );

  it.each(AIRFRAMES.map(a => [a.name, a] as const))(
    '%s: every MSP_SET_MOTOR frame is SIXTEEN bytes, never motorCount * 2',
    async (_name, airframe) => {
      const harness = airframeHarness(airframe);
      await runSetup(harness);

      expect(harness.controller.pulseMotor(airframe.motorCount)).toBe(
        'ACCEPTED',
      );
      await flush(10);
      harness.controller.requestStop('TOUCH_RELEASED');
      await flush(20);

      const frames = motorFrames(harness);
      expect(frames.length).toBeGreaterThan(0);
      for (const frame of frames) {
        expect(frame).toHaveLength(16);
      }
      // And it is NOT the width a per-airframe payload would have had,
      // except for the octocopter, where the two happen to coincide.
      if (airframe.motorCount !== 8) {
        expect(frames[0]).not.toHaveLength(airframe.motorCount * 2);
      }
    },
  );

  it.each(AIRFRAMES.map(a => [a.name, a] as const))(
    '%s: the slots past its motor count carry STOP, never zero',
    async (_name, airframe) => {
      const harness = airframeHarness(airframe);
      await runSetup(harness);
      expect(harness.controller.pulseMotor(1)).toBe('ACCEPTED');
      await flush(10);

      const frame = motorFrames(harness)[0];
      const values: number[] = [];
      for (let index = 0; index < 8; index++) {
        values.push(frame[index * 2] + frame[index * 2 + 1] * 256);
      }
      // Slot 0 is the commanded one; everything else, INCLUDING the
      // padding past the motor count, is the resolved stop value.
      expect(values[0]).toBe(1050);
      expect(values.slice(1)).toEqual(new Array(7).fill(1000));
      expect(values).not.toContain(0);
    },
  );

  /**
   * M-D. THIS EXISTS BECAUSE A MUTATION SURVIVED WITHOUT IT.
   *
   * Replacing the mixer read's result with the literal 3 - a hard-coded
   * QUADX - passed every test in the repository, because every fixture
   * happened to BE a quad. Nothing proved the byte the flight controller
   * sent was the byte that reached the view, which is the entire point of
   * reading it.
   *
   * The airframe matrix already varies the mixer mode per case, so it is
   * the right place to say so: eight different mixer bytes, each expected
   * back unchanged.
   */
  it.each(AIRFRAMES.map(a => [a.name, a] as const))(
    '%s: carries its own mixer byte through to the snapshot, unchanged',
    async (_name, airframe) => {
      const harness = airframeHarness(airframe);
      await runSetup(harness);
      expect(harness.controller.getSnapshot().mixerModeRaw).toBe(
        airframe.mixerMode,
      );
      // ...and it did not become a motor count on the way.
      expect(harness.controller.getSnapshot().motorScope?.motorCount).toBe(
        airframe.motorCount,
      );
    },
  );

  it.each(AIRFRAMES.map(a => [a.name, a] as const))(
    '%s: puts exactly this command set on the wire, and nothing else',
    async (_name, airframe) => {
      const harness = airframeHarness(airframe);
      await runSetup(harness);
      expect(harness.controller.pulseMotor(1)).toBe('ACCEPTED');
      await flush(10);
      await drive(harness, harness.controller.close());

      // M-D §0 CORRECTION. This assertion used to be a denylist that
      // named 42 as "MSP_SET_MIXER_CONFIG". Two errors:
      //
      //   msp_protocol.h:114-115 @ 7348054f
      //     MSP_MIXER_CONFIG      42   // out message: GET
      //     MSP_SET_MIXER_CONFIG  43   // in  message: SET
      //
      //   1. 42 is the READ. Forbidding it forbade the wrong thing -
      //      observing the mixer is exactly what a Motors screen should do.
      //   2. It passed VACUOUSLY. A denylist over commands this path has
      //      no code to emit can never fail, so it proved nothing.
      //
      // Replaced by an ALLOWLIST, which cannot be vacuous: any command
      // that appears - a mixer write, a servo write, a stray read, a
      // retry storm - breaks the equality.
      //
      // 42 IS IN THE LIST, AND WAS ADDED DELIBERATELY. M-D needed the
      // airframe so the view could tell a QUAD X from a V-TAIL 4 instead
      // of guessing from the motor count. It is a READ, it is
      // presentation-only, and the motor COUNT still comes from 131 and
      // nothing else. 43 remains absent, which is the invariant that
      // actually matters and is asserted separately below.
      const commands = [
        ...new Set(harness.transport.writeLog.map(writtenCommand)),
      ].sort((left, right) => left - right);
      expect(commands).toEqual([
        3, //   MSP_FC_VERSION            read - firmware identity gate
        36, //  MSP_FEATURE_CONFIG        read - 3D feature bit
        42, //  MSP_MIXER_CONFIG          read - WHICH AIRFRAME, for the view
        90, //  MSP_ADVANCED_CONFIG       read - protocol + idle
        99, //  MSP_SET_ARMING_DISABLED   write - the safety gate itself
        119, // MSP_BOXIDS                read - arming box discovery
        131, // MSP_MOTOR_CONFIG          read - THE motor count authority
        150, // MSP_STATUS_EX             read - live armed state
        214, // MSP_SET_MOTOR             write - the 8-slot command vector
      ]);
      // Named explicitly so a future reader sees the intent, not just the
      // numbers: no servo is ever driven - not even on a tricopter, whose
      // yaw comes from a tail servo - and the mixer is never WRITTEN.
      expect(commands).not.toContain(212); // MSP_SET_SERVO_CONFIGURATION
      expect(commands).not.toContain(242); // MSP_SET_SERVO_MIX_RULE
      expect(commands).not.toContain(43); //  MSP_SET_MIXER_CONFIG
    },
  );
});

describe('M-C - the motorless mixer, and a count outside the firmware bound', () => {
  it('a mixer that drives no motors opens no motor test at all', async () => {
    // MIXER_GIMBAL: mixers[5] is {0, true, NULL} - a real Betaflight mode
    // with no motor outputs. Nothing to command, and no fallback quad.
    const harness = harnessFor([
      [MSP_MOTOR_CONFIG, reply(motorConfigPayload(0))],
      [MSP_MIXER_CONFIG, reply(mixerConfigPayload(5))],
    ]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome).toMatchObject({reason: 'NO_RUNTIME_MOTORS'});
    expect(harness.controller.pulseMotor(1)).not.toBe('ACCEPTED');
    expect(harness.transport.writeLog.map(writtenCommand)).not.toContain(
      MSP_SET_MOTOR_FIXTURE,
    );
  });

  it('a count above MAX_SUPPORTED_MOTORS is refused as corrupt, not clamped', async () => {
    const harness = harnessFor([
      [MSP_MOTOR_CONFIG, reply(motorConfigPayload(9))],
    ]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome).toMatchObject({
      reason: 'MOTOR_COUNT_OUT_OF_RANGE',
    });
    expect(harness.controller.pulseMotor(1)).not.toBe('ACCEPTED');
  });
});

describe('M-C - the armed gate holds on every airframe, not just a quad', () => {
  it.each([
    ['TRI', 1, 3],
    ['HEX6X', 10, 6],
    ['OCTOX8', 11, 8],
  ] as const)(
    '%s: an ARMED board is refused, and nothing is written',
    async (_name, mixerMode, motorCount) => {
      // MSP_SET_MOTOR itself has NO armed guard in the firmware - msp.c
      // writes motor_disarmed[] whatever the arming state - so this gate
      // is entirely ours, and it must not have narrowed with the airframe.
      const harness = harnessFor([
        [MSP_MOTOR_CONFIG, reply(motorConfigPayload(motorCount))],
        [MSP_MIXER_CONFIG, reply(mixerConfigPayload(mixerMode))],
        [MSP_STATUS_EX, reply(statusPayload(true))],
      ]);
      const snapshot = await runSetup(harness);
      expect(snapshot.activation.allowed).toBe(false);
      expect(harness.controller.pulseMotor(motorCount)).not.toBe('ACCEPTED');
      expect(harness.transport.writeLog.map(writtenCommand)).not.toContain(
        MSP_SET_MOTOR_FIXTURE,
      );
    },
  );
});

/* ================================================================== *
 * M-C. THE STOP BASELINE ON THE WIRE, PER DOMAIN.
 *
 * The value that means "stop" is not a constant, and the eight-slot
 * padding carries whatever it is. These three cases put the actual bytes
 * under assertion so a hard-coded 1000 cannot survive: on a 3D aircraft
 * 1000 is FULL REVERSE, and on an analog board with mincommand 900 it is
 * simply the wrong number.
 * ================================================================== */

describe('M-C - the stop baseline reaches the wire, per domain', () => {
  const slotsOf = (frame: readonly number[]): number[] => {
    const values: number[] = [];
    for (let index = 0; index < 8; index++) {
      values.push(frame[index * 2] + frame[index * 2 + 1] * 256);
    }
    return values;
  };

  it('digital non-3D pads with 1000, the DShot stop', async () => {
    const harness = harnessFor();
    await runSetup(harness);
    expect(harness.controller.pulseMotor(1)).toBe('ACCEPTED');
    await flush(10);
    expect(slotsOf(motorFrames(harness)[0]).slice(1)).toEqual(
      new Array(7).fill(1000),
    );
  });

  it('digital 3D pads with 1500 - the midpoint, NOT 1000', async () => {
    // dshot.c: with FEATURE_3D on, PWM_RANGE_MIDDLE is DSHOT_CMD_MOTOR_STOP
    // and PWM_RANGE_MIN sits at the far end of the REVERSE region. A
    // padding slot at 1000 here would command full reverse on outputs the
    // operator never touched.
    const harness = harnessFor([
      [MSP_FEATURE_CONFIG, reply(featureConfigPayload(FEATURE_3D_BIT))],
    ]);
    const snapshot = await runSetup(harness);
    expect(snapshot.motorDomain?.stopValue).toBe(1500);
    expect(harness.controller.pulseMotor(1)).toBe('ACCEPTED');
    await flush(10);
    const slots = slotsOf(motorFrames(harness)[0]);
    expect(slots.slice(1)).toEqual(new Array(7).fill(1500));
    expect(slots).not.toContain(1000);
  });

  it('analog non-3D pads with mincommand, taken from the board', async () => {
    // analogInitEndpoints(): *disarm = motorConfig->mincommand. This board
    // reports 900, so 900 is what a stopped slot carries - a literal 1000
    // would be an active value on it.
    const analogMotorConfig = Uint8Array.from([
      ...u16(0), // deprecatedMinThrottle
      ...u16(2000), // maxThrottle
      ...u16(900), // minCommand
      4,
      14,
      0,
      0,
    ]);
    const harness = harnessFor([
      [MSP_ADVANCED_CONFIG, reply(advancedConfigPayload(1))], // ONESHOT125
      [MSP_MOTOR_CONFIG, reply(analogMotorConfig)],
    ]);
    const snapshot = await runSetup(harness);
    expect(snapshot.motorDomain?.stopValue).toBe(900);
    expect(harness.controller.setMaster(1200).kind).toBe('ACCEPTED');
    await flush(10);
    const frames = motorFrames(harness);
    expect(frames.length).toBeGreaterThan(0);
    const slots = slotsOf(frames[frames.length - 1]);
    expect(slots.slice(0, 4)).toEqual(new Array(4).fill(1200));
    expect(slots.slice(4)).toEqual(new Array(4).fill(900));
  });
});
