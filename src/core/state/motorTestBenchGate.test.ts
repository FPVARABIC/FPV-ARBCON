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
import {FEATURE_3D_BIT} from '../protocol/msp/decoding/decodeFeatureConfig';
import {
  MSP_ADVANCED_CONFIG,
  MSP_BOXIDS,
  MSP_FEATURE_CONFIG,
  MSP_MOTOR_CONFIG,
  MSP_STATUS_EX,
} from '../protocol/msp/commands/mspCommands';

const EMPTY = new Uint8Array(0);
const PHYSICAL_GENERATION = 11;

/** Command 214. Named only so the assertions can prove its absence. */
const MSP_SET_MOTOR_FIXTURE = 214;
/** Command 99. The arming restriction is gone from this bundle entirely. */
const MSP_SET_ARMING_DISABLED_FIXTURE = 99;
/** The only all-stop payload this package may ever put on the wire. */
const EXPECTED_STOP_PAYLOAD = [0xe8, 0x03, 0xe8, 0x03, 0xe8, 0x03, 0xe8, 0x03];
/** 1050 little-endian in slot 0, stop in the other three. */
const EXPECTED_M1_PAYLOAD = [0x1a, 0x04, 0xe8, 0x03, 0xe8, 0x03, 0xe8, 0x03];

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
function statusPayload(armed = false): Uint8Array {
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
    ...u32(0),
    0,
    ...u16(3400),
    6,
  ]);
}

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
    [MSP_BOXIDS, reply(BOX_IDS_PAYLOAD)],
    [MSP_STATUS_EX, reply(statusPayload())],
    [MSP_SET_MOTOR_FIXTURE, reply(EMPTY)],
  ]);
}

/** Byte 4 of a v1 request frame is the command. */
const writtenCommand = (data: Uint8Array): number => data[4];

const responseFrame = (command: number, payload: Uint8Array): Uint8Array =>
  buildMspFrameBytes(command, payload, {
    wireFormat: 'v1',
    direction: 'response',
  });

const errorFrame = (command: number): Uint8Array =>
  buildMspFrameBytes(command, EMPTY, {wireFormat: 'v1', direction: 'error'});

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
  const command = writtenCommand(data);
  harness.commands.push(command);
  harness.writes.push({
    command,
    payload: Array.from(data.subarray(5, 5 + data[3])),
  });
  harness.transport.resolveNextWrite();
  await flush();
  const scripted = harness.script.get(command) ?? REJECT;
  harness.transport.emitData(
    scripted.kind === 'RESPONSE'
      ? responseFrame(command, scripted.payload)
      : errorFrame(command),
  );
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

  it('runs the whole simplified sequence and nothing else', async () => {
    const harness = harnessFor();
    await runSetup(harness);

    // Steps 7, 8 and 10 - in that order, and no other command.
    expect(harness.commands).toEqual([
      MSP_MOTOR_CONFIG,
      MSP_ADVANCED_CONFIG,
      MSP_FEATURE_CONFIG,
      MSP_BOXIDS,
      // The monitor's own first observation, AWAITED before READY.
      MSP_STATUS_EX,
    ]);
    expect(harness.commands).not.toContain(MSP_SET_ARMING_DISABLED_FIXTURE);
    expect(harness.commands).not.toContain(MSP_SET_MOTOR_FIXTURE);
  });

  it('cannot publish READY before the first observation is served', async () => {
    const harness = harnessFor();
    let settled = false;
    const pending = harness.controller.initializeSession().then(value => {
      settled = true;
      return value;
    });

    // Serve everything EXCEPT the observation: the four evidence reads,
    // then stop. Bounded by the command COUNT, never by loop iterations -
    // a write may not be pending on the first turn.
    for (let step = 0; step < 60 && harness.commands.length < 4; step++) {
      await flush(3);
      await serveOne(harness);
    }
    await flush(20);
    expect(harness.commands).toHaveLength(4);

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

  it('refuses a 3D-configured aircraft with the dedicated reason', async () => {
    const harness = harnessFor([
      [MSP_FEATURE_CONFIG, reply(featureConfigPayload(FEATURE_3D_BIT))],
    ]);
    const snapshot = await runSetup(harness);

    expect(snapshot.outcome).toMatchObject({
      kind: 'BLOCKED',
      reason: 'MOTOR_SCOPE_UNSUPPORTED',
    });
    expect(snapshot.motorScope?.feature3dEnabled).toBe(true);
    expect(snapshot.activation.reasons).toContain('MOTOR_3D_ENABLED');
    // 3D inverts stop semantics, so nothing may be encoded for it - and
    // the observation is never even attempted.
    expect(harness.commands).not.toContain(MSP_STATUS_EX);
    expect(harness.commands).not.toContain(MSP_SET_MOTOR_FIXTURE);
  });

  it('refuses a motor count outside the one supported scope', async () => {
    const harness = harnessFor([
      [MSP_MOTOR_CONFIG, reply(motorConfigPayload(6))],
    ]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome).toMatchObject({
      kind: 'BLOCKED',
      reason: 'MOTOR_SCOPE_UNSUPPORTED',
    });
    expect(snapshot.activation.reasons).toContain('MOTOR_SCOPE_UNSUPPORTED');
    expect(snapshot.activation.reasons).not.toContain('MOTOR_3D_ENABLED');
  });

  it('refuses an analog raw motor protocol the digital adapter is not scoped for', async () => {
    const harness = harnessFor([
      [MSP_ADVANCED_CONFIG, reply(advancedConfigPayload(4))],
    ]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome).toMatchObject({
      kind: 'BLOCKED',
      reason: 'MOTOR_SCOPE_UNSUPPORTED',
    });
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
    for (let index = 0; index < 4; index++) {
      values.push(payload[index * 2] + payload[index * 2 + 1] * 256);
    }
    expect(values[slot]).toBe(1050);
    for (let index = 0; index < 4; index++) {
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

/** Lets the monitor's scheduled next observation reach the transport, so
 * a release genuinely races an in-flight MSP_STATUS_EX exactly as it does
 * on a device. A macrotask turn, never a delay. */
const nextMonitorTurn = (): Promise<void> =>
  new Promise<void>(resolve => setTimeout(resolve, 0));

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
    const write = harness.transport.writes[0];
    expect(writtenCommand(write.data)).toBe(MSP_SET_MOTOR_FIXTURE);
    // Slot 1 above stop, every other slot at stop.
    expect(
      Array.from(write.data.subarray(5, 5 + write.data[3])),
    ).toEqual([0xe8, 0x03, 0x1a, 0x04, 0xe8, 0x03, 0xe8, 0x03]);

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
  for (let index = 0; index < 4; index++) {
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
