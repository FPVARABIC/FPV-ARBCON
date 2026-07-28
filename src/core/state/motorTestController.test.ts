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
 *  - a session port (three members: a client reference, an identity read
 *    and an invalidation subscription) - a read/lifecycle dependency;
 *  - a telemetry scheduler stand-in implementing exactly the two methods
 *    the barrier is allowed to call.
 * Neither can mint a lease, an authority or a receipt.
 *
 * The forbidden motor command appears in no fixture - only as a value the
 * containment assertions at the end of this file prove absent.
 */

import {readFileSync} from 'fs';
import {join} from 'path';

import {
  applyMotorTestEffects,
  classifyArmingRestrictionFailure,
  classifyBoxIdsFailure,
  classifyDynamicObservationFailure,
  classifyFirmwareVersionFailure,
  classifyLeaseFailure,
  composeMotorTestProfileEvidence,
  createMotorTestController,
  EMPTY_MOTOR_TEST_EFFECT_RECORD,
  MOTOR_TEST_CONTROLLER_STOP_TRIGGERS,
  type MotorTestController,
  type MotorTestControllerSessionPort,
  type MotorTestControllerSnapshot,
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
import {ARMING_DISABLED_MSP_BIT_INDEX} from './motorArmingRestriction';
import {FakeMspTransport} from '../protocol/__testUtils__/mspFakeTransport';
import {buildMspFrameBytes} from '../protocol/__testUtils__/mspFixtures';
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
  MSP_MOTOR_CONFIG,
  MSP_STATUS_EX,
} from '../protocol/msp/commands/mspCommands';

const EMPTY = new Uint8Array(0);
const PHYSICAL_GENERATION = 7;

/** The one command the accepted restriction module sends. Named here only
 * so the fixture can answer it; this file builds no motor command. */
const MSP_SET_ARMING_DISABLED_FIXTURE = 99;

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
  ]);
}

/** Byte 4 of a v1 request frame is the command. */
function writtenCommand(data: Uint8Array): number {
  return data[4];
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
  /** Runs just before the reply for the named command is emitted. */
  beforeReply: ((command: number) => void) | undefined;
  identity: MspSessionCompositeIdentity | undefined;
  /** Makes the narrow identity read THROW, which is a different fact from
   * "there is no identity" and must not be reported as one. */
  failIdentityReads(): void;
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
  const state: {
    identity: MspSessionCompositeIdentity | undefined;
    throwOnRead: boolean;
  } = {
    identity: {physicalGeneration: PHYSICAL_GENERATION, mspEpoch: 0},
    throwOnRead: false,
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
    subscribeSessionInvalidated: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  let monotonic = 1_000;
  const controller = createMotorTestController({
    session,
    telemetryRegistry: registry,
    telemetrySession,
    readMonotonicMillis: () => {
      monotonic += 5;
      return monotonic;
    },
  });

  return {
    transport,
    client,
    telemetryOwner,
    scheduler,
    controller,
    script,
    commands: [],
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
  const command = writtenCommand(harness.transport.writes[0].data);
  harness.commands.push(command);
  harness.transport.resolveNextWrite();
  await flush();
  harness.beforeReply?.(command);
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
    expect(snapshot.capabilities?.status).toBe('PROFILE_SUPPORTED');
    expect(snapshot.staticCompatibility?.kind).toBe('EVALUATED');
    expect(snapshot.dynamicEvaluation?.kind).toBe('EVALUATED');
    expect(snapshot.armingRestriction).toMatchObject({
      kind: 'ESTABLISHED',
      evidenceScope: 'AGGREGATE_NOT_DESCRIPTOR_SPECIFIC',
      receiptCurrentAtPublish: true,
    });
    expect(snapshot.telemetryHeld).toBe(true);
  });

  it('sends every accepted read exactly once, in the required order', async () => {
    const harness = createHarness();
    await runSetup(harness);

    expect(harness.commands).toEqual([
      // (9a) trusted BOX evidence
      MSP_BOXIDS,
      // (9b) static facts: identification, then the four configs
      MSP_API_VERSION,
      MSP_FC_VARIANT,
      MSP_BOARD_INFO,
      MSP_MIXER_CONFIG,
      MSP_MOTOR_CONFIG,
      MSP_ADVANCED_CONFIG,
      MSP_FEATURE_CONFIG,
      // (9c) firmware version
      MSP_FC_VERSION,
      // (9f) the one-shot dynamic observation
      MSP_STATUS_EX,
      MSP_BATTERY_STATE,
      // (9h) the restriction: the disable request, then a FRESH status
      MSP_SET_ARMING_DISABLED_FIXTURE,
      MSP_STATUS_EX,
    ]);
    // MSP_BOXIDS keeps its at-most-once guarantee: the dynamic observer
    // is handed the trusted snapshot, never a second request.
    expect(
      harness.commands.filter(command => command === MSP_BOXIDS),
    ).toHaveLength(1);
  });

  it('never writes a motor command', async () => {
    const harness = createHarness();
    await runSetup(harness);
    expect(harness.commands).not.toContain(200 + 14);
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

  it('binds capabilities to the same authority the reducer uses', async () => {
    const harness = createHarness();
    const snapshot = await runSetup(harness);
    expect(snapshot.capabilities).toBeDefined();
    if (snapshot.capabilities !== undefined && snapshot.machine !== undefined) {
      expect(snapshot.capabilities.authority).toBe(snapshot.machine.authority);
    }
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
    expect(Object.isFrozen(snapshot.capabilities)).toBe(true);
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

  it('reports the continuous-monitoring gap rather than claiming coverage', async () => {
    const harness = createHarness();
    const snapshot = await runSetup(harness);
    expect(snapshot.continuousSafetyMonitoring).toBe(
      'UNAVAILABLE_NO_ACCEPTED_SOURCE',
    );
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

  it('locks on an unsupported static profile', async () => {
    const harness = createHarness([
      [MSP_BOARD_INFO, reply(boardInfoPayload('SOMEOTHERTARGET'))],
    ]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome).toEqual({
      kind: 'BLOCKED',
      reason: 'STATIC_PROFILE_UNSUPPORTED',
      requiresNewSession: true,
    });
    expect(snapshot.machine?.name).toBe('Locked');
    expect(snapshot.armingRestriction).toEqual({kind: 'NOT_ATTEMPTED'});
  });

  it('locks on a mixer the profile does not recognize', async () => {
    const harness = createHarness([[MSP_MIXER_CONFIG, reply(mixerConfigPayload(5))]]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome.kind).toBe('BLOCKED');
    expect(snapshot.machine?.name).toBe('Locked');
  });

  it('locks on a malformed static-facts response', async () => {
    const harness = createHarness([[MSP_MIXER_CONFIG, reply(EMPTY)]]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome).toMatchObject({
      kind: 'BLOCKED',
      reason: 'STATIC_FACTS_MALFORMED',
    });
  });

  it('locks on an unusable identification response', async () => {
    const harness = createHarness([[MSP_BOARD_INFO, reply(EMPTY)]]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome).toMatchObject({
      kind: 'BLOCKED',
      reason: 'STATIC_FACTS_MALFORMED',
    });
  });

  it('locks on firmware older than the accepted API version', async () => {
    const harness = createHarness([
      [MSP_API_VERSION, reply(Uint8Array.from([0, 1, 41]))],
    ]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome).toMatchObject({
      kind: 'BLOCKED',
      reason: 'STATIC_FACTS_MALFORMED',
    });
  });

  it('fails closed when a static-facts request is rejected', async () => {
    const harness = createHarness([[MSP_ADVANCED_CONFIG, REJECT]]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome).toMatchObject({
      kind: 'FAILED_CLOSED',
      reason: 'STATIC_FACTS_REQUEST_FAILED',
      faultReason: 'MSP_RESPONSE_TIMEOUT',
    });
  });

  it('fails closed when the firmware-version request is rejected', async () => {
    const harness = createHarness([[MSP_FC_VERSION, REJECT]]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome).toMatchObject({
      kind: 'FAILED_CLOSED',
      reason: 'FIRMWARE_VERSION_UNAVAILABLE',
    });
  });

  it('never reaches Ready with an armed flight controller', async () => {
    const harness = createHarness([
      [MSP_STATUS_EX, reply(statusPayload({armed: true}))],
    ]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome).toMatchObject({
      kind: 'BLOCKED',
      reason: 'DYNAMIC_REQUIREMENTS_NOT_SATISFIED',
    });
    // The one write in the bundle never happened.
    expect(harness.commands).not.toContain(MSP_SET_ARMING_DISABLED_FIXTURE);
  });

  it('never reaches Ready with a battery outside the accepted policy', async () => {
    const harness = createHarness([
      [MSP_BATTERY_STATE, reply(batteryPayload(6, 2500))],
    ]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome).toMatchObject({
      kind: 'BLOCKED',
      reason: 'DYNAMIC_REQUIREMENTS_NOT_SATISFIED',
    });
    expect(harness.commands).not.toContain(MSP_SET_ARMING_DISABLED_FIXTURE);
  });

  it('locks when the observation response is malformed', async () => {
    const harness = createHarness([[MSP_BATTERY_STATE, reply(EMPTY)]]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome).toMatchObject({
      kind: 'BLOCKED',
      reason: 'DYNAMIC_OBSERVATION_UNAVAILABLE',
    });
  });

  it('fails closed when the post-ACK evidence does not show the restriction', async () => {
    const harness = createHarness();
    // The FIRST status read (the dynamic observation) must still show the
    // restriction, or the run would block before the write. Only the
    // SECOND one - the fresh post-ACK read - is degraded.
    let statusReads = 0;
    harness.beforeReply = command => {
      if (command === MSP_STATUS_EX) {
        statusReads += 1;
        if (statusReads === 2) {
          harness.script.set(
            MSP_STATUS_EX,
            reply(statusPayload({mspRestrictionPresent: false})),
          );
        }
      }
    };
    const snapshot = await runSetup(harness);
    expect(statusReads).toBe(2);
    expect(snapshot.outcome).toMatchObject({
      kind: 'FAILED_CLOSED',
      reason: 'ARMING_RESTRICTION_NOT_ESTABLISHED',
      faultReason: 'WRITE_OUTCOME_UNKNOWN',
    });
    expect(snapshot.machine?.name).toBe('Fault');
    expect(snapshot.armingRestriction).toEqual({
      kind: 'NOT_ESTABLISHED',
      reason: 'MSP_ARMING_RESTRICTION_NOT_OBSERVED',
    });
  });

  it('fails closed when the arming-disable request itself is rejected', async () => {
    const harness = createHarness([
      [MSP_SET_ARMING_DISABLED_FIXTURE, REJECT],
    ]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome).toMatchObject({
      kind: 'FAILED_CLOSED',
      reason: 'ARMING_RESTRICTION_NOT_ESTABLISHED',
      faultReason: 'WRITE_OUTCOME_UNKNOWN',
    });
  });

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
  const BOUNDARY_COMMANDS: readonly number[] = [
    MSP_BOXIDS,
    MSP_API_VERSION,
    MSP_MIXER_CONFIG,
    MSP_FEATURE_CONFIG,
    MSP_FC_VERSION,
    MSP_STATUS_EX,
    MSP_BATTERY_STATE,
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

const TEARDOWN_STEPS = [
  'MARK_CLOSING',
  'REMOVE_LISTENERS',
  'KEEP_TELEMETRY_PAUSED',
  'AUTHORIZED_TEARDOWN_ONLY',
  'SETTLE_ARMING_RESTRICTION',
  'RELEASE_LEASE',
  'RELEASE_TELEMETRY_TOKENS',
];

describe('MotorTestController - teardown', () => {
  it('runs the seven required steps in order', async () => {
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

  it('never claims the arming restriction was removed', async () => {
    const harness = createHarness();
    await runSetup(harness);
    const snapshot = await drive(harness, harness.controller.close());
    expect(snapshot.teardown?.armingRestrictionRemovalSupported).toBe(false);
    expect(snapshot.teardown?.armingRestrictionRemovalPerformed).toBe(false);
    expect(
      snapshot.teardown?.armingRestrictionReceiptCurrentAtTeardown,
    ).toBe(true);
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
    expect(snapshot.teardown?.steps).toHaveLength(7);
    const third = await harness.controller.close();
    expect(third.teardown?.steps).toHaveLength(7);
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

  it('rolls a partial acquisition back through the same seven steps', async () => {
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
 * The public surface
 * ------------------------------------------------------------------ */

describe('MotorTestController - public surface', () => {
  it('exposes exactly five frozen operations', () => {
    const controller = createHarness().controller;
    expect(Object.keys(controller).sort()).toEqual([
      'close',
      'getSnapshot',
      'initializeSession',
      'requestStop',
      'subscribe',
    ]);
    expect(Object.isFrozen(controller)).toBe(true);
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
    expect(harness.commands).not.toContain(200 + 14);
  });

  it('exports no way to inject an authority, lease or live state', () => {
    const exported = Object.keys(controllerModule)
      .filter(name => name !== '__esModule')
      .sort();
    expect(exported).toEqual([
      'EMPTY_MOTOR_TEST_EFFECT_RECORD',
      'MOTOR_TEST_CONTROLLER_STOP_TRIGGERS',
      'applyMotorTestEffects',
      'classifyArmingRestrictionFailure',
      'classifyBoxIdsFailure',
      'classifyDynamicObservationFailure',
      'classifyFirmwareVersionFailure',
      'classifyLeaseFailure',
      'composeMotorTestProfileEvidence',
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

  it('fails closed for every post-submission arming-restriction reason', () => {
    for (const reason of [
      'ARMING_DISABLE_REQUEST_FAILED',
      'POST_ACK_STATUS_REQUEST_FAILED',
      'SESSION_CHANGED_DURING_ESTABLISHMENT',
      'FC_ARMED',
      'MSP_ARMING_RESTRICTION_NOT_OBSERVED',
      'INDEPENDENT_VERIFICATION_UNAVAILABLE',
      'MALFORMED_STATUS_RESPONSE',
    ] as const) {
      expect(classifyArmingRestrictionFailure(reason).disposition).toBe('FAULT');
    }
  });

  it('locks only for the two genuinely pre-traffic restriction reasons', () => {
    expect(classifyArmingRestrictionFailure('BOX_IDS_PROVENANCE_INVALID')).toEqual(
      {disposition: 'LOCK'},
    );
    expect(
      classifyArmingRestrictionFailure('ARMING_RESTRICTION_ALREADY_ESTABLISHED'),
    ).toEqual({disposition: 'LOCK'});
  });

  it('classifies lease, firmware and observation failures conservatively', () => {
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
    expect(classifyFirmwareVersionFailure('REQUEST_FAILED').disposition).toBe(
      'FAULT',
    );
    expect(classifyFirmwareVersionFailure('MALFORMED_RESPONSE')).toEqual({
      disposition: 'LOCK',
    });
    expect(
      classifyDynamicObservationFailure('SESSION_IDENTITY_CHANGED').disposition,
    ).toBe('FAULT');
    expect(classifyDynamicObservationFailure('MALFORMED_RESPONSE')).toEqual({
      disposition: 'LOCK',
    });
  });
});

/* ------------------------------------------------------------------ *
 * Evidence mapping
 * ------------------------------------------------------------------ */

describe('composeMotorTestProfileEvidence', () => {
  it('is a frozen projection that defaults nothing', () => {
    const evidence = composeMotorTestProfileEvidence(
      {
        sessionIdentity: {physicalGeneration: 1, mspEpoch: 0},
        facts: {
          flightControllerIdentity: {
            apiVersion: {
              mspProtocolVersion: 0,
              apiVersionMajor: 1,
              apiVersionMinor: 47,
            },
            firmware: {identifier: 'BTFL', knownFamily: 'BETAFLIGHT'},
            board: {
              boardIdentifier: 'S405',
              hardwareRevision: 0,
              boardType: 0,
              targetCapabilities: 0,
              targetName: 'SPEEDYBEEF405V4',
              boardName: 'SpeedyBee F405 V4',
              manufacturerId: 'SPBE',
              signature: Object.freeze([]),
              mcuTypeId: 1,
              trailingBytes: Object.freeze([]),
            },
          },
          mixerModeRaw: 99,
          yawMotorsReversedConfigured: true,
          motorCount: 4,
          motorPoleCount: 14,
          motorProtocolRaw: 99,
          motorIdleRaw: 550,
          feature3dEnabled: false,
          dshotTelemetryRaw: 0,
        },
      },
      {
        sessionIdentity: {physicalGeneration: 1, mspEpoch: 0},
        firmwareVersion: {
          yearOffsetRaw: 25,
          year: 2025,
          month: 12,
          patch: 2,
          versionString: '2025.12.2',
          suffix: null,
        },
      },
    );
    expect(Object.isFrozen(evidence)).toBe(true);
    // An unrecognized raw value becomes a distinct NON-MATCHING token, so
    // the accepted composer reports it as unsupported rather than missing.
    expect(evidence.mixerProfile).toBe('MIXER_MODE_RAW_99');
    expect(evidence.motorProtocol).toBe('MOTOR_PROTOCOL_RAW_99');
    expect(evidence.bidirectionalDshotEnabled).toBe(false);
    expect(evidence.propsOutConfigured).toBe(true);
    expect(evidence.boardTargetName).toBe('SPEEDYBEEF405V4');
  });

  it('blocks and never writes when the motor protocol is unrecognized', async () => {
    const harness = createHarness([
      [MSP_ADVANCED_CONFIG, reply(advancedConfigPayload(6))],
    ]);
    const snapshot = await runSetup(harness);
    expect(snapshot.outcome.kind).toBe('BLOCKED');
    expect(harness.commands).not.toContain(MSP_SET_ARMING_DISABLED_FIXTURE);
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

  it('contains no motor-command capability', () => {
    for (const forbidden of [
      'MSP_SET_MOTOR',
      'encodeSetMotorPayload',
      'MotorSafetyBridge',
      'writeBytes',
      'setInterval',
      'setTimeout',
      'requestAnimationFrame',
    ]) {
      expect(code).not.toContain(forbidden);
    }
    // The forbidden command id appears nowhere, in any form.
    expect(code).not.toMatch(/\b214\b/);
    expect(raw).not.toMatch(/\b214\b/);
  });

  it('never constructs an activation, start or pulse event', () => {
    for (const forbidden of [
      'ACTIVATION_ACCEPTED',
      'START_WRITE_CALLED',
      'START_ACKNOWLEDGED',
      'RECHECK_REQUESTED',
      'STOP_ACKNOWLEDGED',
    ]) {
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
