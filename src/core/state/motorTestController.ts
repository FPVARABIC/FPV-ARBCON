/**
 * The MOTOR-TEST CONTROLLER. SAFETY-CRITICAL: invoking it can command a
 * real motor.
 *
 * WHAT THIS IS
 * ------------
 * The thinnest possible composition of the already-accepted motor-test
 * contracts. It captures one official session authority, holds the
 * coordinator-wide telemetry barrier, owns one genuine `MotorTestLease`,
 * reads only the configuration the command encoder needs, acquires the box
 * mapping that makes armed state readable, and drives the accepted pure
 * reducer.
 *
 * THE GATE SIMPLIFICATION, AND WHAT IT COST
 * -----------------------------------------
 * Setup used to prove eleven things before it would publish READY: the
 * four-command identification chain, a pinned firmware version, a static
 * compatibility profile, a composed capability profile, a one-shot dynamic
 * observation, a 4S battery policy, and an MSP arming restriction it wrote
 * to the flight controller and then re-read. Most of that proved facts
 * unrelated to encoding a safe MSP_SET_MOTOR frame, and the arming
 * restriction in particular was a WRITE performed in the name of safety
 * whose receipt could never detect its own removal - its own doc comment
 * said so.
 *
 * What the simplified chain proves is smaller and all of it load-bearing:
 *
 *   1. one current session identity, captured and revalidated;
 *   2. one identified firmware/API with a reviewed motor-write adapter;
 *   3. the coordinator-wide telemetry barrier, so nothing else is talking;
 *   4. one genuine lease and its non-forgeable official authority;
 *   5. the configuration the encoder needs - motor count, motor protocol,
 *      and FEATURE_3D disabled, because 3D INVERTS STOP SEMANTICS;
 *   6. the MSP_BOXIDS mapping, because the ARM bit position is
 *      configuration dependent and must never be guessed;
 *   7. ONE FRESH PRODUCTION OBSERVATION, awaited before READY, proving the
 *      flight controller reports itself DISARMED.
 *
 * (7) IS AWAITED, NOT FIRED AND FORGOTTEN. The monitor used to be started
 * asynchronously and READY published immediately after, so the snapshot
 * said "not ready, nothing is watching" until some unrelated render
 * happened to rebuild it. The setup boundary now joins the first real
 * observation and refuses READY unless that observation is fresh,
 * session-bound and disarmed - see `MotorTestSafetyMonitorLike.observeNow`.
 *
 * NOTHING WAS TRADED AWAY ON THE WRITE PATH. Exactly one output at exactly
 * MOTOR_TEST_FIXED_PULSE_VALUE, every other output at stop, command 214,
 * the same encoder, the same watchdog, the same serialized transport, the
 * same emergency stop and the same all-stop vector.
 *
 * IT CAN REACH THE MOTOR-COMMAND PATH
 * -----------------------------------
 * This header previously described an inert module that "cannot spin a
 * motor", with `Starting`, `Pulsing` and `ACTIVATION_ACCEPTED` called
 * unreachable. That was true when Phase 2D wrote it and is FALSE NOW:
 * Phase 2G Pass 2 added the fixed single-motor pulse engine and Phase 2H
 * wired the module into a real screen, and the prose was not updated. The
 * corrected statement is below; nothing that follows should be read
 * through the old description.
 *
 * `pulseMotor(...)` is a public method. When its activation gate allows,
 * it builds a real `MSP_SET_MOTOR` output vector and sends it over the
 * lease. `ACTIVATION_ACCEPTED` IS constructed in this file, `Starting` and
 * `Pulsing` ARE reachable, and the command id, the payload encoder and the
 * vector builders ARE imported here. Treat any call into this controller
 * as capable of turning a physical motor.
 *
 * WHAT STILL CONSTRAINS IT. These are AUTHORITATIVE invariants, not
 * conventions, and they must keep holding on their own merits:
 *   - `evaluateActivation()` is the SINGLE gate. `pulseMotor` consults it
 *     and the published snapshot carries its verdict, so the UI projection
 *     IS the gate rather than a second, weaker copy of the rule. It is
 *     re-evaluated inside `pulseMotor()` at CALL TIME - a button that
 *     rendered enabled is not evidence, and a snapshot that was true when
 *     it was built may not be true when it is acted on;
 *   - a pulse is FIXED, never operator-shaped: exactly one motor of four
 *     at exactly `MOTOR_TEST_FIXED_PULSE_VALUE`, every other output at the
 *     accepted stop value. A touch-owner heartbeat renews a short
 *     fail-safe watchdog while the operator keeps holding; losing the
 *     gesture, the JS owner, or the heartbeat requests an all-stop;
 *   - there is no generic `dispatch(event)`; the public surface exposes
 *     only named, capability-scoped operations, and the only event any
 *     caller can influence
 *     directly is a whitelisted `STOP_TRIGGERED`. `SUBMIT_START_INTENT`
 *     is still never constructed anywhere in this file - the reducer's
 *     handling of it is a fail-closed tripwire, not a path;
 *   - every request travels `MotorTestLease.request(...)` and every stop
 *     travels `MotorTestLease.emergencyStop(...)`, i.e. the canonical
 *     FIFO. No transport, no raw byte writer, no raw client request, no
 *     second queue;
 *   - the reducer's effects are recorded as INERT FROZEN DATA. Nothing in
 *     this module executes an effect, and no descriptor holds a callback,
 *     promise, client, transport, writer, command, payload, lease, motor
 *     value or native handle.
 *
 * REACHABILITY IN THE UNIFIED APPLICATION
 * ---------------------------------------
 * This controller deliberately ships in the standalone application and is
 * reached from the Motors tab through the official session capability. The
 * old `__DEV__` containment seam and separate hardware-test application no
 * longer exist. The production-bundle scan therefore proves that the engine
 * and Arabic safety copy are present, while its source-boundary checks prove
 * that command encoding and MSP_SET_MOTOR dispatch remain confined here.
 * Runtime authority, lease, telemetry-barrier and armed-state checks are the
 * real activation boundary and may never be relaxed on UI assumptions.
 *
 * AN ACK IS NOT PHYSICAL MOTION, AND NOT A PHYSICAL STOP
 * ------------------------------------------------------
 * Every acknowledgement in this file proves one thing: the flight
 * controller received and processed a frame. It does not prove a motor
 * turned, and - critically - a stop ACK does NOT prove a motor stopped.
 * `physicalStopConfirmed` is therefore permanently `false` and no code
 * path sets it true. Only a human observing the hardware can establish
 * mechanical state.
 *
 * THE ORDERING DEVIATION, STATED PLAINLY
 * --------------------------------------
 * The governing requirement asks for "capture the official authority
 * exactly once" as step 1, before the telemetry barrier and before the
 * lease. THAT IS NOT REACHABLE UNDER THE ACCEPTED CONTRACTS, and this
 * module does not pretend otherwise.
 *
 * `MspOfficialSessionAuthority` is minted per `(MspClient instance, that
 * client's own mspEpoch)` and is obtainable ONLY through
 * `MotorTestLease.officialSessionAuthority()` on a LIVE lease
 * (motorTestLease.ts). The minting function is module-private there, by
 * design, precisely so that no caller can fabricate or pre-fetch an
 * authority. So the authority cannot exist before step 7.
 *
 * WHAT THIS MODULE DOES INSTEAD, and why every invariant still holds:
 *   - step 1 captures the COMPOSITE SESSION IDENTITY ANCHOR exactly once
 *     (`physicalGeneration` + `mspEpoch`, read from the session port).
 *     Every step from 1 to 7 is revalidated against that one anchor, by
 *     value, so a session that changes during the barrier is caught
 *     before a lease is ever requested;
 *   - `acquireMotorTestLease` itself re-checks the anchor against the
 *     live identity AND against `client.getEpoch()`, so the lease can
 *     only be granted for the very session the anchor described;
 *   - the authority is captured ONCE, immediately after acquisition and
 *     before the next `await`, and is never re-read into the field
 *     afterwards. From that instant it is the sole authority: every later
 *     boundary asserts `lease.officialSessionAuthority() === authority`
 *     by IDENTITY, and the state machine, the capability snapshot and
 *     every event are bound to that same object.
 * The result is strictly stronger than "capture something at step 1"
 * would have been: the anchor guards steps 1-7 and the non-forgeable
 * authority guards 7-11, with no window in between.
 *
 * STEP 7B, STATED PRECISELY (accepted clarification, semantics unchanged)
 * ----------------------------------------------------------------------
 * The post-barrier sequence is SYNCHRONOUS and in this exact order:
 *
 *     revalidation  ->  lease acquisition  ->  authority capture
 *
 * There is no `await` anywhere between those three, which is what makes
 * the pair sound: the identity proven by the revalidation is still the
 * identity `acquireMotorTestLease` sees, and the authority captured from
 * the fresh lease cannot belong to a session that replaced it in between.
 * This is a clarification of the existing behaviour, not a change to it.
 *
 * GUARD SITES
 * -----------
 * Every awaited boundary on the setup path is followed by either
 * `cancellation()` or `revalidate()`, and `revalidate` delegates to
 * `cancellation` first (a cancelled continuation is cancelled first,
 * whatever the session says). Two of the sites live inside `readDecoded`,
 * which runs once per config read, so a successful setup evaluates more
 * guards than there are literal call sites.
 *
 * SESSION/CLIENT COHERENCE (correction B-1)
 * -----------------------------------------
 * The telemetry barrier and the motor-test lease must describe the SAME
 * link. They are supplied as separate dependencies, so nothing structural
 * used to stop a caller from handing over session A's telemetry anchor and
 * client B - after which the barrier would faithfully quiet A, the lease
 * and every evidence read would travel B, and `telemetryHeld: true` would
 * be a true statement about the wrong link.
 *
 * The anchor is now minted for one exact client and privately remembers
 * it (see motorTestTelemetryBarrier.ts), and this controller passes
 * `deps.session.client` into `acquireBarrier`, which compares BY
 * REFERENCE. A value comparison would be useless here: a freshly
 * constructed second client reports `mspEpoch` 0 just like the first, so
 * two structurally equal composite identities routinely describe two
 * genuinely different links. On mismatch the registry pauses nothing and
 * returns a typed reason, this controller locks with
 * `TELEMETRY_SESSION_CLIENT_MISMATCH`, no lease is requested, no evidence
 * request is sent, and `telemetryHeld` stays false. That session is then
 * terminally `Locked`: it never reaches `Ready`, so it can never activate.
 * This is a statement about THAT failure path only - it is not a claim
 * that `Ready` or the pulse path is unreachable in general (see the
 * safety-critical note at the top of this file).
 *
 * ONE OBSERVATION PATH, ONE REQUESTER
 * -----------------------------------
 * `MotorTestSafetyMonitor` is constructed with THE SAME LEASE every
 * configuration read, every box read, every motor command and every
 * emergency stop travels. There is no second requester, no second client,
 * no second transport and no parallel writer anywhere in this bundle, which
 * is what keeps the MSP request path serialized and keeps a stop able to
 * displace whatever is on the wire.
 *
 * The monitor reads MSP_STATUS_EX and nothing else, imports no encoder, and
 * cannot construct a write command even in principle. It runs from the
 * moment before READY is published until teardown or the first fault.
 *
 * WHAT MONITORING STILL DOES NOT PROVE. Each observation proves what the
 * flight controller reported at one instant. It is not proof that a motor
 * is turning, that one stopped, or that the fact is still true between two
 * readings. Freshness is an AGE BOUND on a real reading, never a claim of
 * continuous truth.
 *
 * WHAT IS NO LONGER MONITORED, SAID OUT LOUD. Pack voltage, cell count and
 * the FC's own battery classification were previously part of the proof
 * chain via the Pass 1E policy. They are not read any more, so this module
 * makes NO claim about the battery and never will until something reads it
 * again. The operator-facing instruction therefore asks for a battery and
 * ESC combination suitable for the actual build; it does not claim that
 * 4S is universal or automatically verified.
 */

import {
  acquireMotorTestLease,
  mspSessionCompositeIdentitiesMatch,
  MotorTestLease,
  type MotorTestLeaseAcquireFailureReason,
  type MotorTestLeaseReleaseResult,
  type MspOfficialSessionAuthority,
  type MspSessionCompositeIdentity,
} from '../protocol/motorTestLease';
import type {MspClient} from '../protocol/mspClient';
import type {FlightControllerIdentity} from '../protocol/msp/identification/mspIdentificationTypes';
import {
  motorFirmwareSupports,
  resolveMotorFirmwareCompatibility,
  type MotorFirmwareCompatibility,
} from '../firmware-adapters/motorFirmwareCompatibility';
import {
  MSP_ADVANCED_CONFIG,
  MSP_FEATURE_CONFIG,
  MSP_MOTOR,
  MSP_MOTOR_CONFIG,
  MSP_MOTOR_TELEMETRY,
  MSP2_SEND_DSHOT_COMMAND,
} from '../protocol/msp/commands/mspCommands';
// P2-ii: MSP_SET_MOTOR is no longer imported here. The controller
// encodes and dispatches no motor frame by any route - the professional
// command engine owns both the ordinary command path and the canonical
// priority stop.
// Phase 2F. The encoder and the vector builders are ACCEPTED, PROTECTED
// modules and are reused unchanged - this controller neither duplicates
// their logic nor introduces a second encoder. `assertSupportedMotorScope`
// rejects 3D FIRST (3D inverts stop semantics), then a motor count other
// than four, then any raw protocol outside the reviewed DShot-family
// values at the pinned tag.
import {
  buildSingleOutputVectorForDomain,
  type MotorVectorScope,
} from '../firmware-adapters/betaflightMotorVectorsV147';
// M-C: the canonical wire width, and the only bound on how many logical
// motors any airframe may expose. Both come from MAX_SUPPORTED_MOTORS.
import {MOTOR_TEST_COMMAND_VECTOR_SLOTS} from './motorTestCommandVector';
import {
  readMotorArmedStateEvidence,
  type MotorTestArmedStateEvidence,
} from './motorTestContinuousSafetyMonitor';
import {
  MOTOR_TEST_SAFETY_OBSERVATION_INTERVAL_MILLIS,
  MotorTestSafetyMonitor,
  type MotorTestSafetyMonitorFactory,
  type MotorTestSafetyMonitorLike,
  type MotorTestSafetyUnsafeReason,
} from './motorTestSafetyMonitor';
import type {MotorArmedStateObservationFailure} from './motorArmedStateObservation';
import {decodeAdvancedConfig} from '../protocol/msp/decoding/decodeAdvancedConfig';
import {decodeFeatureConfig} from '../protocol/msp/decoding/decodeFeatureConfig';
import {decodeMotorConfig} from '../protocol/msp/decoding/decodeMotorConfig';
import {
  decodeMotorOutputs,
  type MspMotorOutputs,
} from '../protocol/msp/decoding/decodeMotorOutputs';
import {
  decodeMotorTelemetry,
  type MspMotorTelemetry,
} from '../protocol/msp/decoding/decodeMotorTelemetry';
import {
  deriveMotorDiagnosticsSupport,
  hasEscTelemetrySource,
  type MotorDiagnosticsSupport,
} from './motorDiagnosticsSemantics';
import {MspPayloadReadError} from '../protocol/msp/decoding/MspPayloadReader';
import {
  MspClientError,
  MspMotorTestStopDisplacementError,
} from '../protocol/mspClient';
import {
  encodeDshotEscDirection,
  type DshotEscDirection,
} from '../protocol/msp/encoding/encodeDshotEscDirection';
import type {
  MotorTestBarrierHold,
  MotorTestTelemetryRegistry,
  MotorTestTelemetrySession,
} from '../protocol/telemetry/motorTestTelemetryBarrier';
import type {MotorStaticFactsSessionIdentity} from './motorStaticFacts';
import {
  acquireMotorTestBoxIds,
  type MotorTestBoxIdsFailureReason,
  type MotorTestBoxIdsSnapshot,
} from './motorTestBoxIds';
import {
  createMotorTestState,
  motorTestTransition,
  type MotorTestEffect,
  dispositionForStopReason,
  type MotorTestEvent,
  type MotorTestFaultReason,
  type MotorTestState,
  type MotorTestStopTriggerReason,
} from './motorTestStateMachine';
// P2-ii-A. The P1 domain resolver and the P2-i runtime-scope policy, wired
// into the LIVE enable path. MSP_MOTOR_3D_CONFIG is read only where it
// participates in domain resolution - it is never a decorative request.
import {decodeMotor3dConfig} from '../protocol/msp/decoding/decodeMotor3dConfig';
import {MSP_MOTOR_3D_CONFIG} from '../protocol/msp/commands/mspCommands';
import {
  resolveMotorTestValueDomain,
  type MotorTestValueDomain,
} from '../firmware-adapters/betaflightMotorDomainV147';
import {
  classifyMotorControlRuntimeScope,
  type MotorControlRuntimeScope,
} from './motorControlRuntimeScope';
// P2-ii. The ONE professional command authority, and the reviewed arming
// restriction module that owns command 99's encoding in both directions.
import {
  MotorControlCommandEngine,
  type MotorControlCommandResult,
} from './motorControlCommandEngine';
import {projectStopOutcomeToLegacyRecord} from './motorStopExecutionProjection';
import {
  buildArmingReleasePayload,
  establishMotorArmingRestriction,
  MSP_SET_ARMING_DISABLED,
  recordMotorArmingRestrictionReleased,
  type MotorArmingRestrictionReceipt,
} from './motorArmingRestriction';
import type {
  MotorControlFaultReason,
  MotorControlStopReason,
} from './motorControlStateMachine';

/* ------------------------------------------------------------------ *
 * Ports - the only things a caller supplies
 * ------------------------------------------------------------------ */

/**
 * Why a session stopped being the one this controller is bound to.
 *
 * These name the GENUINE existing sources required by the governing
 * contract. A platform binding forwards them from the session
 * coordinator (physical detach, intentional close, replacement) and from
 * the client's own desynchronization latch. This module never
 * manufactures one.
 */
export type MotorTestSessionInvalidationReason =
  | 'USB_DETACHED'
  | 'SESSION_CHANGED'
  | 'DESYNCHRONIZED';

export type MotorTestControllerUnsubscribe = () => void;

/**
 * Identification is owned by the platform session coordinator, but the
 * motor write gate consumes only this narrow, read-only projection. The
 * shape intentionally matches the coordinator state without importing a
 * React Native module into core.
 */
export type MotorTestFirmwareIdentificationState =
  | {readonly status: 'IDLE'}
  | {readonly status: 'RUNNING'}
  | {
      readonly status: 'SUCCEEDED';
      readonly identity: FlightControllerIdentity;
    }
  | {readonly status: 'FAILED'; readonly error: unknown};

/**
 * The narrow read/lifecycle slice of the platform session layer.
 *
 * It exposes the canonical
 * `MspClient` ONLY so the production factory can hand it to
 * `acquireMotorTestLease`, which is the official issuer; this module
 * calls no method on it, and after acquisition every request goes through
 * the lease.
 */
export interface MotorTestControllerSessionPort {
  /** The canonical client for the physical session, or undefined. */
  readonly client: MspClient | undefined;
  /** The composite identity currently in force, or undefined. */
  readCurrentIdentity(): MspSessionCompositeIdentity | undefined;
  /** Current firmware-identification evidence for the same session. */
  readFirmwareIdentification(): MotorTestFirmwareIdentificationState;
  /** Notifies when identification moves IDLE -> RUNNING -> terminal. */
  subscribeFirmwareIdentification(
    listener: () => void,
  ): MotorTestControllerUnsubscribe;
  /** Genuine invalidation signals. Returns an unsubscribe function. */
  subscribeSessionInvalidated(
    listener: (reason: MotorTestSessionInvalidationReason) => void,
  ): MotorTestControllerUnsubscribe;
}

export interface MotorTestControllerDependencies {
  readonly session: MotorTestControllerSessionPort;
  /** The coordinator-wide Phase 2C registry. Never a controller-local
   * substitute, boolean or duplicate pause mechanism. */
  readonly telemetryRegistry: MotorTestTelemetryRegistry;
  /**
   * The registry's anchor for THIS physical session.
   *
   * It MUST have been minted by `registry.openSession(session.client)` for
   * the very client above. That is not a convention this interface asks
   * you to honour - the registry records the association privately and
   * `acquireBarrier` refuses a mismatch by reference, so an incoherent
   * pairing fails closed before anything is paused or leased.
   */
  readonly telemetrySession: MotorTestTelemetrySession;
  /** Monotonic clock for the accepted observation window. A reading,
   * never a timer: nothing here schedules on it or compares it to a
   * deadline. */
  readonly readMonotonicMillis: () => number;
  /**
   * TEST SEAM ONLY, and deliberately optional.
   *
   * Production NEVER supplies this - `motorTestSessionBinding.ts` builds
   * these dependencies and has no field for it, which a containment test
   * asserts. Its only purpose is to let the pulse-engine suites drive the
   * controller without a live observation loop competing for the fake
   * link; the SAFETY DECISION is unaffected either way, because the gate
   * always goes through `readContinuousSafetyMonitoring`, which requires a
   * running monitor holding a fresh satisfied reading.
   */
  readonly createSafetyMonitor?: MotorTestSafetyMonitorFactory;
}

/* ------------------------------------------------------------------ *
 * Inert effect records
 * ------------------------------------------------------------------ */

/**
 * One reducer-emitted `SUBMIT_STOP_INTENT`, preserved as data.
 *
 * DISTINCT PER EMISSION. Never debounced, never history-suppressed,
 * never coalesced with an earlier descriptor - the reducer has no
 * delivery handshake, so a repeat means "the same stop is STILL
 * required", and dropping it would assert a guarantee nobody has.
 *
 * Three scalars. There is no callback, promise, client, transport,
 * writer, command, payload, lease, motor value or native handle anywhere
 * in it, and no field from which one could be derived.
 */
export interface MotorTestStopDescriptor {
  readonly descriptorKind: 'SUBMIT_STOP_INTENT';
  /** Monotonic within one record. Two applicable descriptors always
   * differ here, which is what makes "preserved separately" observable. */
  readonly sequence: number;
  /** The trigger whose dispatch produced this emission. */
  readonly stopReason: MotorTestStopTriggerReason;
}

export interface MotorTestControllerWarning {
  readonly warningKind: 'STOP_UNCONFIRMED';
  readonly message: string;
  readonly sequence: number;
}

/**
 * The accumulated inert record of everything the reducer has emitted.
 *
 * `startEffectObserved` is a FAIL-CLOSED TRIPWIRE, not a feature. A
 * `SUBMIT_START_INTENT` cannot be produced by any path this controller
 * can drive, so observing one means an invariant has already been
 * violated. It is recorded and never forwarded, never executed and never
 * turned into a descriptor.
 */
export interface MotorTestEffectRecord {
  readonly stopDescriptors: readonly MotorTestStopDescriptor[];
  readonly warnings: readonly MotorTestControllerWarning[];
  readonly startEffectObserved: boolean;
  /** Next sequence number. Shared by both lists, so the ordering between
   * a warning and a descriptor is never ambiguous. */
  readonly nextSequence: number;
}

const NO_STOP_DESCRIPTORS: readonly MotorTestStopDescriptor[] = Object.freeze(
  [],
);
const NO_WARNINGS: readonly MotorTestControllerWarning[] = Object.freeze([]);

export const EMPTY_MOTOR_TEST_EFFECT_RECORD: MotorTestEffectRecord =
  Object.freeze({
    stopDescriptors: NO_STOP_DESCRIPTORS,
    warnings: NO_WARNINGS,
    startEffectObserved: false,
    nextSequence: 0,
  });

/**
 * Pure, total accumulation of one reducer transition's effects.
 *
 * Exported because it IS the production recorder - the controller calls
 * exactly this function and nothing else - and because it is the only
 * honest way to exercise repeated-descriptor preservation without a
 * test-only live-state backdoor: a test drives the REAL reducer through
 * the REAL accepted path and feeds the REAL effect array here.
 *
 * `stopReason` is the trigger of the dispatch being recorded, or
 * undefined for a dispatch that carried no stop trigger.
 */
export function applyMotorTestEffects(
  record: MotorTestEffectRecord,
  effects: readonly MotorTestEffect[],
  stopReason: MotorTestStopTriggerReason | undefined,
): MotorTestEffectRecord {
  if (effects.length === 0) {
    return record;
  }

  const stopDescriptors = Array.from(record.stopDescriptors);
  const warnings = Array.from(record.warnings);
  let startEffectObserved = record.startEffectObserved;
  let sequence = record.nextSequence;

  for (const effect of effects) {
    switch (effect.kind) {
      case 'SUBMIT_STOP_INTENT':
        if (stopReason === undefined) {
          // A stop effect with no trigger is an invariant violation, not
          // a reason to invent a plausible-looking one. Recorded as a
          // tripwire and NOT turned into a descriptor.
          startEffectObserved = record.startEffectObserved;
          sequence++;
          break;
        }
        stopDescriptors.push(
          Object.freeze({
            descriptorKind: 'SUBMIT_STOP_INTENT' as const,
            sequence: sequence++,
            stopReason,
          }),
        );
        break;
      case 'SHOW_STOP_UNCONFIRMED_WARNING':
        warnings.push(
          Object.freeze({
            warningKind: 'STOP_UNCONFIRMED' as const,
            message: effect.message,
            sequence: sequence++,
          }),
        );
        break;
      case 'SUBMIT_START_INTENT':
        // Unreachable through this controller. Recorded, never forwarded.
        startEffectObserved = true;
        sequence++;
        break;
      case 'ARM_PULSE_DEADLINE':
        // Unreachable through this controller (it follows a start), and
        // this bundle owns no timer. Consumed, never acted upon.
        sequence++;
        break;
      default:
        sequence++;
        break;
    }
  }

  return Object.freeze({
    stopDescriptors: Object.freeze(stopDescriptors),
    warnings: Object.freeze(warnings),
    startEffectObserved,
    nextSequence: sequence,
  });
}

/* ------------------------------------------------------------------ *
 * Failure classification
 * ------------------------------------------------------------------ */

/**
 * How a setup failure must land.
 *
 * `LOCK`  - unsupported or incomplete evidence with NO uncertain side
 *           effect. Nothing was written, or what was written is fully
 *           accounted for.
 * `FAULT` - timeout, transport uncertainty, stale authority, unknown
 *           write outcome, or any failure after a session-bound side
 *           effect began. Terminal until a full controller/session reset.
 */
export type MotorTestFailureClass =
  | {readonly disposition: 'LOCK'}
  | {
      readonly disposition: 'FAULT';
      readonly faultReason: MotorTestFaultReason;
    };

const LOCK: MotorTestFailureClass = Object.freeze({disposition: 'LOCK'});

function fault(faultReason: MotorTestFaultReason): MotorTestFailureClass {
  return Object.freeze({disposition: 'FAULT', faultReason});
}

/**
 * Compile-time exhaustiveness, mirroring the accepted reducer's own
 * guard: a `never` value is assignable to `void`, so the parameter is
 * genuinely consumed without `void` and without throwing on a safety
 * path. Each caller still returns a conservative value afterwards, so an
 * unforeseen RUNTIME value fails closed rather than returning undefined.
 */
function assertExhaustiveReason(value: never): void {
  return value;
}

/** Exhaustive - adding a lease failure reason must fail to compile. */
export function classifyLeaseFailure(
  reason: MotorTestLeaseAcquireFailureReason,
): MotorTestFailureClass {
  switch (reason) {
    case 'CURRENT_SESSION_IDENTITY_UNAVAILABLE':
    case 'REQUESTED_SESSION_IDENTITY_MISMATCH':
    case 'MSP_CLIENT_UNAVAILABLE':
      // The session this controller anchored on is gone or replaced.
      return fault('SESSION_CHANGED');
    case 'MOTOR_TEST_LEASE_FAULT_LATCHED':
      return fault('DESYNCHRONIZED');
    case 'MSP_CLIENT_NOT_IDLE':
    case 'MOTOR_TEST_LEASE_ALREADY_HELD':
      // Nothing was written and nothing is ambiguous - somebody else
      // simply holds the link right now.
      return LOCK;
    default:
      assertExhaustiveReason(reason);
      return fault('NATIVE_EXCEPTION');
  }
}

/** Exhaustive - adding a BOX-ID failure reason must fail to compile. */
export function classifyBoxIdsFailure(
  reason: MotorTestBoxIdsFailureReason,
): MotorTestFailureClass {
  switch (reason) {
    case 'MOTOR_TEST_LEASE_INACTIVE':
      return fault('SESSION_CHANGED');
    case 'BOX_IDS_REQUEST_FAILED':
      // A rejected lease-scoped request has already faulted the lease.
      return fault('MSP_RESPONSE_TIMEOUT');
    case 'BOX_IDS_MALFORMED':
      // The exchange completed; the answer was unusable. No uncertainty.
      return LOCK;
    default:
      assertExhaustiveReason(reason);
      return fault('NATIVE_EXCEPTION');
  }
}

/** Exhaustive - adding an armed-state observation failure must fail to
 * compile. */
export function classifyArmedStateObservationFailure(
  reason: MotorArmedStateObservationFailure,
): MotorTestFailureClass {
  switch (reason) {
    case 'SESSION_IDENTITY_UNAVAILABLE':
    case 'SESSION_IDENTITY_CHANGED':
      return fault('SESSION_CHANGED');
    case 'REQUEST_FAILED':
      return fault('MSP_RESPONSE_TIMEOUT');
    case 'ARMING_BOX_MAPPING_REQUIRED':
    case 'ARMED_STATE_UNOBSERVABLE':
    case 'MALFORMED_RESPONSE':
      // Incomplete or unusable evidence with zero uncertain side effects:
      // the accepted module sends only a read, and a read that answered
      // badly leaves nothing pending on the aircraft.
      return LOCK;
    default:
      assertExhaustiveReason(reason);
      return fault('NATIVE_EXCEPTION');
  }
}

/* ------------------------------------------------------------------ *
 * Snapshot model
 * ------------------------------------------------------------------ */

export type MotorTestControllerPhase =
  | 'IDLE'
  | 'PREPARING'
  | 'ACTIVE'
  | 'CLOSING'
  | 'CLOSED';

/** Which governing step the controller last entered. Purely
 * observational, and named after the requirement's own numbering so an
 * auditor can map a snapshot straight onto the contract. */
export type MotorTestSetupStep =
  | 'NOT_STARTED'
  | 'SESSION_ANCHOR'
  | 'FIRMWARE_COMPATIBILITY'
  | 'TELEMETRY_BARRIER'
  | 'POST_BARRIER_REVALIDATION'
  | 'LEASE_ACQUISITION'
  | 'AUTHORITY_CAPTURE'
  | 'POST_LEASE_REVALIDATION'
  /** Step 7 - the minimal configuration the command encoder needs. */
  | 'MOTOR_CONFIGURATION'
  /** Step 8 - the MSP_BOXIDS mapping that makes armed state readable. */
  | 'ARMED_STATE_EVIDENCE'
  /** Step 9 - the monitor, constructed with the SAME lease. */
  | 'SAFETY_MONITOR'
  /** Step 10 - one fresh, satisfied, disarmed observation, AWAITED. */
  | 'FIRST_OBSERVATION'
  /** Step 10b (P2-ii) - MSP_SET_ARMING_DISABLED [1], established AFTER
   * disarmed is proven and BEFORE READY is published. */
  | 'ARMING_RESTRICTION'
  | 'READY';

export type MotorTestSetupBlockedReason =
  | 'SESSION_IDENTITY_UNAVAILABLE'
  | 'SESSION_CHANGED'
  | 'CONTROLLER_CANCELLED'
  | 'STOP_REQUESTED_DURING_SETUP'
  | 'TELEMETRY_SESSION_UNKNOWN'
  /** Correction B-1: the telemetry anchor belongs to a different client
   * than the one this controller would lease, so quieting it would prove
   * nothing about the link actually used. */
  | 'TELEMETRY_SESSION_CLIENT_MISMATCH'
  | 'TELEMETRY_SESSION_REPLACED'
  | 'TELEMETRY_QUIESCENCE_TIMEOUT'
  | 'LEASE_NOT_ACQUIRED'
  | 'OFFICIAL_AUTHORITY_UNAVAILABLE'
  | 'FIRMWARE_IDENTITY_UNAVAILABLE'
  | 'FIRMWARE_UNSUPPORTED'
  | 'BOX_EVIDENCE_UNAVAILABLE'
  | 'MOTOR_CONFIG_REQUEST_FAILED'
  | 'MOTOR_CONFIG_MALFORMED'
  /** M-C: the configuration cannot be commanded at all - see
   * MotorCommandScopeRefusal. Complete decoded evidence, refused, and
   * nothing written. */
  | MotorCommandScopeRefusal
  /** The first production observation never completed usably. */
  | 'FIRST_OBSERVATION_UNAVAILABLE'
  /** The first production observation completed and proved ARMED. */
  | 'FIRST_OBSERVATION_NOT_DISARMED'
  /** P2-ii: command 99 was sent and its effect could not be established.
   * Uncertain by construction, so it fails closed rather than locking. */
  | 'ARMING_RESTRICTION_NOT_ESTABLISHED'
  | 'TEARDOWN_INCOMPLETE'
  | 'UNEXPECTED_SERVICE_EXCEPTION';

/**
 * Where setup landed.
 *
 * `BLOCKED` carries the exact semantics of the reducer's `Locked`, and
 * `FAILED_CLOSED` the exact semantics of `Fault`. Once the official
 * authority exists the reducer state says the same thing - the two are
 * published together and are always consistent. Before the authority
 * exists there is deliberately no reducer state at all (the accepted
 * machine cannot be created without one), so this field is the whole
 * answer.
 */
export type MotorTestSetupOutcome =
  | {readonly kind: 'PENDING'}
  | {readonly kind: 'READY'}
  | {
      readonly kind: 'BLOCKED';
      readonly reason: MotorTestSetupBlockedReason;
      readonly requiresNewSession: boolean;
    }
  | {
      readonly kind: 'FAILED_CLOSED';
      readonly reason: MotorTestSetupBlockedReason;
      readonly faultReason: MotorTestFaultReason;
      readonly requiresNewSession: true;
    };

export type MotorTestTeardownStepOutcome = 'DONE' | 'SKIPPED' | 'THREW';

export type MotorTestTeardownStepName =
  | 'MARK_CLOSING'
  | 'REMOVE_LISTENERS'
  | 'KEEP_TELEMETRY_PAUSED'
  | 'AUTHORIZED_TEARDOWN_ONLY'
  /** Phase 2F: the required command-214 all-stop attempt. Ordered AFTER
   * authority validation and BEFORE the lease is released, so the outputs
   * are commanded to stop while a command can still be sent at all. */
  | 'EXECUTE_STOP_VECTOR'
  /** Step 9's monitor. Stopped before the lease is released so no
   * observation can be outstanding against a dead lease. */
  | 'STOP_SAFETY_MONITOR'
  /** P2-ii: MSP_SET_ARMING_DISABLED [0]. Ordered AFTER the all-stop and
   * BEFORE the lease is released, and WITHHELD entirely when the stop
   * could not be established. */
  | 'RELEASE_ARMING_RESTRICTION'
  | 'RELEASE_LEASE'
  | 'RELEASE_TELEMETRY_TOKENS';

export interface MotorTestTeardownStepReport {
  readonly step: MotorTestTeardownStepName;
  readonly outcome: MotorTestTeardownStepOutcome;
}

/**
 * What teardown actually achieved. Every field is a fact about THIS
 * process, never a claim about the aircraft.
 */
export interface MotorTestTeardownReport {
  readonly steps: readonly MotorTestTeardownStepReport[];
  /** Whether the dedicated observation loop was running and was stopped
   * here. False when none had been constructed. */
  readonly safetyMonitorStopped: boolean;
  /** The lease's own release verdict, `'NOT_HELD'` when none was ever
   * acquired, or `'THREW'` when the accepted call itself threw. */
  readonly leaseRelease: MotorTestLeaseReleaseResult | 'NOT_HELD' | 'THREW';
  readonly telemetryTokensReleased: boolean;
  /**
   * P2-ii. What happened to the FC-side arming restriction.
   *
   * `WITHHELD_STOP_UNPROVEN` is the fail-closed case and is NOT a defect:
   * turning an uncertain motor-output state into an immediately armable
   * flight controller would be strictly worse than leaving the
   * restriction in force. It is never a claim about physical motor state.
   */
  readonly armingRestrictionRelease:
    | 'NOT_OWED'
    | 'RELEASED'
    | 'WITHHELD_STOP_UNPROVEN'
    | 'RELEASE_FAILED';
  /** True only when exclusivity is conclusively gone AND every local step
   * completed. */
  readonly complete: boolean;
  /** Present exactly when `complete` is false. */
  readonly incompleteReason?:
    | 'LEASE_RELEASE_UNRESOLVED'
    | 'TEARDOWN_STEP_THREW';
}

/**
 * Phase 2F - what the stop EXECUTION did.
 *
 * THE THREE STATEMENTS ARE STRUCTURALLY SEPARATE and must never be
 * collapsed:
 *   `commandDispatched`   - the request was handed to the leased FIFO.
 *   `commandAcknowledged` - the FC replied. Betaflight assigns
 *                           `reply->result` AFTER the handler switch
 *                           (msp.c:4421-4449), so an ACK proves the
 *                           command was RECEIVED AND PROCESSED - and
 *                           nothing more.
 *   `physicalStopConfirmed` - that a motor has actually stopped turning.
 *                           PERMANENTLY FALSE in this package: no
 *                           accepted physical evidence source exists, and
 *                           no ACK may be promoted into one.
 */
export type MotorTestStopExecutionOutcome =
  | {
      readonly kind: 'NOT_ATTEMPTED';
      readonly reason: 'NO_LEASE' | 'NO_SCOPE' | 'AUTHORITY_STALE';
    }
  /** The accepted scope guard refused before a single byte was built. */
  | {readonly kind: 'SCOPE_REJECTED'}
  /** Dispatched and acknowledged. NOT a physical claim. */
  | {readonly kind: 'ACKNOWLEDGED'}
  | {
      readonly kind: 'FAILED';
      readonly reason:
        | 'REQUEST_FAILED'
        | 'AUTHORITY_CHANGED'
        | 'NATIVE_EXCEPTION'
        /** Phase 2G: the stop displaced an already-written request
         * carrying command 214 itself, so a late response for the
         * DISPLACED request is byte-indistinguishable from this stop's
         * own acknowledgement. The exchange may have "succeeded" and it
         * proves nothing. Never an acknowledgement, never a stop. */
        | 'ATTRIBUTION_AMBIGUOUS';
    };

/**
 * Phase 2G - THE ONE FIXED PULSE MAGNITUDE, defined exactly once.
 *
 * This is the APPROVED FIXED LOW TEST VALUE for this pass. It is NOT
 * derived, computed or scaled from the configured 5.5% motor idle, and no
 * code anywhere may re-derive it: the accepted vector builder
 * (buildSingleMotorVector) deliberately refuses to supply a default,
 * because pulse magnitude is a safety decision and not an arithmetic one.
 *
 * The narrowest layer that may hold it is HERE - the motor-test
 * controller. betaflightMotorVectorsV147.ts is an accepted protected
 * module that deliberately names no pulse magnitude at all, and adding one
 * there would give every future caller a default it should never have.
 */
export const MOTOR_TEST_FIXED_PULSE_VALUE = 1050;

/**
 * Operator-facing motor numbers for a given runtime motor count.
 *
 * M-C REPLACED A CONSTANT WITH A FUNCTION. This used to be the frozen
 * literal `[1, 2, 3, 4]` - a fixed truth that was wrong for every airframe
 * that is not a quad, and that silently offered a tricopter a fourth motor
 * it does not have. The list is now derived from the ONLY authority for
 * how many motor outputs exist: MSP_MOTOR_CONFIG's own count.
 *
 * These are MSP OUTPUT SLOTS, never airframe positions and never rotation
 * directions. Motor N is always firmware output index N-1, on every
 * airframe and in every text direction - no right-to-left reversal is
 * applied here or anywhere below this line.
 *
 * An unusable count yields an EMPTY list rather than a quad: a missing or
 * corrupt figure is not four motors.
 */
export function motorTestPulseMotorNumbers(
  runtimeMotorCount: number | undefined,
): readonly number[] {
  if (
    runtimeMotorCount === undefined ||
    !Number.isInteger(runtimeMotorCount) ||
    runtimeMotorCount < 1 ||
    runtimeMotorCount > MOTOR_TEST_COMMAND_VECTOR_SLOTS
  ) {
    return Object.freeze([]);
  }
  return Object.freeze(
    Array.from({length: runtimeMotorCount}, (_, index) => index + 1),
  );
}

export type MotorTestPulseRequestResult =
  | 'ACCEPTED'
  /** Not 1..4. Nothing was encoded and nothing reached the transport. */
  | 'INVALID_MOTOR'
  | 'CONTROLLER_CLOSED'
  /** A guard in the activation contract was not simultaneously valid. */
  | 'GATES_NOT_SATISFIED'
  /** The reducer is not in Ready - a stop, lock or fault is in force. */
  | 'NOT_READY'
  /** Lease or official authority moved. */
  | 'AUTHORITY_STALE'
  /** A stop episode is in flight, or an earlier stop was unsafe. */
  | 'STOP_PENDING'
  /**
   * A pulse is already live. The current episode is STOPPED by this call
   * and the requested motor is deliberately NOT started - a switch is
   * never an implicit activation.
   */
  | 'SWITCH_REQUIRES_NEW_ACTIVATION';

/**
 * Phase 2H - THE AUTHORITATIVE ACTIVATION GATE, as read-only data.
 *
 * WHY THIS EXISTS. A UI must be able to ask "may a pulse begin, and if
 * not, why" WITHOUT reimplementing a single safety check. `Ready` alone is
 * provably insufficient: Phase 2G established that a locking safety event
 * arriving while idle leaves the accepted reducer in `Ready` (it correctly
 * refuses to manufacture stop traffic for an activation that never began)
 * while activation must nonetheless be barred.
 *
 * WHAT MAKES IT AUTHORITATIVE. It is not a parallel calculation. The one
 * private evaluator below produces this projection AND is the gate
 * `pulseMotor()` itself consults - there is exactly one implementation, so
 * a UI reading `allowed` can never disagree with what activation actually
 * does.
 *
 * THE REASON SET IS OPERATOR-FACING, AND THAT IS THE WHOLE POINT
 * -------------------------------------------------------------
 * There used to be twelve reasons, and a single teardown produced six of
 * them at once - SETUP_NOT_READY, MACHINE_NOT_READY, TELEMETRY_BARRIER_NOT_HELD,
 * ARMING_RESTRICTION_NOT_CURRENT, AUTHORITY_STALE and CONTROLLER_CLOSED are
 * all CONSEQUENCES of the session ending, not six separate things wrong
 * with the aircraft. Somebody reading that list learned nothing they could
 * act on.
 *
 * These seven are what an operator can actually do something about. The
 * INTERNAL protections are unchanged and remain strictly stronger: a
 * closed controller, a stale requester, an inactive lease, a replaced
 * session, a mismatched authority, an unheld barrier, a stop in progress
 * and a sealed stop each still make a write impossible - they simply fold
 * into the reason that is true and useful rather than being enumerated as
 * separate hardware faults. `evaluateActivation()` below shows exactly
 * which internal condition folds into which reason, and the full internal
 * state stays available behind the screen's collapsed diagnostics.
 */
/**
 * M-C - WHY A CONFIGURATION CANNOT BE COMMANDED AT ALL.
 *
 * Shared verbatim between bring-up and the activation gate, because the
 * two used to run different rules and could therefore disagree: a session
 * could open on a configuration its own pulse path would refuse. There is
 * one evaluator (`evaluateMotorCommandScope`) and one vocabulary.
 *
 * NONE of these names an airframe. There is no "unsupported airframe" and
 * no mixer in the set - a tricopter, a hexacopter and an octocopter all
 * pass, and what fails is a count outside the firmware's own bound, a
 * protocol with no resolvable conversion, or a 3D configuration whose
 * active endpoints MSP does not carry.
 */
export type MotorCommandScopeRefusal =
  /**
   * MSP_MOTOR_CONFIG reported a motor count of zero: this configuration
   * drives no motor outputs at all, so there is nothing a motor test
   * could command. Distinct from an unsupported one - the aircraft is
   * fine, it simply has no motors on this mixer.
   */
  | 'NO_RUNTIME_MOTORS'
  /**
   * The reported motor count is not a usable 1..MAX_SUPPORTED_MOTORS
   * figure. mixerConfigureOutput() clamps to that bound on both of its
   * branches, so a count outside it is a corrupt or unrecognised runtime
   * result rather than an airframe this app declines to support.
   */
  | 'MOTOR_COUNT_OUT_OF_RANGE'
  /**
   * The configured motor protocol has no external-value conversion this
   * app can resolve - MOTOR_PROTOCOL_DISABLED, or a raw byte outside the
   * pinned enum. Nothing is guessed: an unknown protocol is refused, not
   * assumed to be PWM or DShot.
   */
  | 'UNSUPPORTED_PROTOCOL_DOMAIN'
  /**
   * FEATURE_3D is on and the active endpoints are NOT observable over MSP
   * at this API version, so forward and reverse cannot be told apart.
   * This is the ANALOG 3D case specifically: `limit3d_low`/`limit3d_high`
   * exist in the firmware struct but are not on the wire at 1.47 or 1.49.
   * DIGITAL 3D is NOT refused - its neutral is the protocol constant
   * PWM_RANGE_MIDDLE and the split is the firmware's own branch.
   */
  | 'ANALOG_3D_ENDPOINTS_UNKNOWN';

export type MotorTestActivationBlockReason =
  | MotorCommandScopeRefusal
  /**
   * There is no live, current, writable session: not started, still
   * preparing, closing, closed, invalidated, replaced, barrier not held,
   * lease inactive, or an authority that no longer matches.
   */
  | 'CONTROLLER_LINK_UNAVAILABLE'
  /** A fresh production observation proved the flight controller ARMED. */
  | 'FC_ARMED'
  /**
   * No fresh production observation proves DISARMED: none has completed,
   * the read failed or was malformed, its session moved, or the last good
   * reading has aged past `MOTOR_TEST_SAFETY_MAX_AGE_MILLIS`.
   */
  | 'ARMED_STATE_UNKNOWN_OR_STALE'
  /** Firmware identification did not produce usable session-bound data. */
  | 'FIRMWARE_IDENTITY_UNAVAILABLE'
  /** No reviewed motor-write adapter matches the identified firmware/API. */
  | 'FIRMWARE_UNSUPPORTED'
  /**
   * The configuration this session was opened against is no longer the
   * configuration the flight controller reports: the motor count, the
   * mixer identity, the protocol or the 3D domain moved underneath an
   * active session. Fails closed rather than silently re-scoping - a
   * session opened for four motors must never quietly start commanding a
   * fifth.
   */
  | 'MOTOR_CONFIGURATION_DRIFTED'
  /** A pulse or a stop is already running. */
  | 'PULSE_OR_STOP_IN_PROGRESS'
  /**
   * A terminal safety fault for this connection: a locking stop, a sealed
   * stop, a faulted reducer or a failed-closed setup. Nothing short of a
   * genuinely new canonical connection can clear it.
   */
  | 'REQUIRES_NEW_CONNECTION';

export interface MotorTestActivationGate {
  /** True only when EVERY accepted guard is simultaneously satisfied. */
  readonly allowed: boolean;
  /** Every reason that currently blocks, not just the first. Frozen. */
  readonly reasons: readonly MotorTestActivationBlockReason[];
}

const ACTIVATION_ALLOWED: MotorTestActivationGate = Object.freeze({
  allowed: true,
  reasons: Object.freeze([]) as readonly MotorTestActivationBlockReason[],
});

/**
 * Phase 2I - THE VERIFICATION RECEIPT.
 *
 * WHY IT EXISTS. A physical observation is only meaningful if it can be
 * attributed to ONE exact commanded output on ONE exact attempt in ONE
 * exact session. Nothing weaker will do: not the selected UI card, not
 * `Ready`, not a component variable, not a generic command-214
 * acknowledgement, and not "whatever was rendered last". Any of those
 * would let an observation of one motor be recorded against another.
 *
 * WHAT IT IS. A pure PROJECTION of records this controller already keeps.
 * It introduces no new behaviour: no command, no timer, no vector, no
 * encoding, no state transition, and no change to the reducer, the lease
 * or the client. It is emitted only when every one of these is already
 * true, and it disappears the instant any of them stops being true.
 *
 * WHAT IT PROVES - and its exact limits. It proves the flight controller
 * acknowledged receiving a command for this output, and acknowledged
 * receiving an attributable, unambiguous software stop afterwards. It
 * proves NOTHING physical: no rotation, no direction, no position, and no
 * mechanical stop. `physicalStopConfirmed` stays permanently false, here
 * as everywhere else.
 */
export interface MotorTestVerificationReceipt {
  /**
   * The official session anchor, by REFERENCE. A receipt minted under one
   * session can never be mistaken for one minted under another, because
   * this is the same non-forgeable authority object the controller itself
   * operates under - not a number a caller could reproduce.
   */
  readonly sessionToken: object;
  /** The exact pulse attempt this receipt describes. */
  readonly attemptId: number;
  /** The exact MSP OUTPUT SLOT that was commanded, 1..4. Never an
   * airframe position and never a rotation direction. */
  readonly motorNumber: number;
  /** The stop episode that ended THIS attempt - not merely some stop. */
  readonly stopEpisodeId: number;
  /** Literal `true`: a receipt cannot exist without an attributable
   * acknowledgement of both the command and its stop. */
  readonly pulseAcknowledged: true;
  readonly stopAcknowledged: true;
  /** Literal `false`: ambiguity or an unsafe stop yields NO receipt at
   * all, rather than a receipt carrying a warning flag. */
  readonly attributionAmbiguous: false;
  readonly stopUnsafe: false;
  /** Permanently false. An MSP acknowledgement is not mechanical proof. */
  readonly physicalStopConfirmed: false;
}

export type MotorTestPulseOutcome =
  | {readonly kind: 'ACKNOWLEDGED'}
  | {
      readonly kind: 'FAILED';
      readonly reason:
        /** The lease-scoped request rejected: write failure, response
         * timeout, desync, detach, close or displacement by the stop. */
        | 'REQUEST_FAILED'
        /** Lease or authority moved across the await. */
        | 'AUTHORITY_CHANGED'
        /** The ACK arrived for an attempt that is no longer live. It is
         * discarded: it can never re-enter Pulsing, clear a Fault, cancel
         * a stop, or touch a replacement session. */
        | 'STALE_ATTEMPT'
        /** A stop dominated this attempt before it could be acknowledged. */
        | 'STOP_DOMINATED';
    };

/**
 * Phase 2G - the pulse-attempt record.
 *
 * NOTHING HERE IS A PHYSICAL CLAIM. `acknowledged` means an MSP response
 * frame was attributed to this attempt. It does not mean a motor turned,
 * at what speed, in what direction, or that any particular airframe arm
 * moved. No RPM, temperature, direction or frame-position value exists on
 * this type by construction.
 */
export interface MotorTestPulseRecord {
  /** Monotonic, per controller. 0 before any activation. */
  readonly attemptId: number;
  /** The OUTPUT SLOT selected, 1..4, or undefined when none is live. */
  readonly motorNumber: number | undefined;
  readonly submitted: boolean;
  readonly acknowledged: boolean;
  /** True once the touch-heartbeat watchdog was armed. Armed from
   * SUBMISSION START, never from acknowledgement. */
  readonly deadlineArmedAtSubmission: boolean;
  /**
   * Latched true the moment activation is accepted and NEVER cleared for
   * the lifetime of this controller. A submitted motor command cannot be
   * recalled, so from here on every non-acknowledged stop outcome is
   * unsafe - see the teardown's stop-uncertainty gate.
   */
  readonly mayHaveReachedFc: boolean;
  readonly outcome: MotorTestPulseOutcome | undefined;
}

/** Maps the first blocking reason onto the caller-facing refusal code.
 * Exhaustive: adding a reason without deciding its refusal fails to
 * compile. */
function mapActivationBlockToPulseResult(
  reason: MotorTestActivationBlockReason | undefined,
): MotorTestPulseRequestResult {
  switch (reason) {
    case 'CONTROLLER_LINK_UNAVAILABLE':
      return 'CONTROLLER_CLOSED';
    case 'PULSE_OR_STOP_IN_PROGRESS':
      return 'STOP_PENDING';
    case 'REQUIRES_NEW_CONNECTION':
      return 'NOT_READY';
    case 'FC_ARMED':
    case 'ARMED_STATE_UNKNOWN_OR_STALE':
    case 'FIRMWARE_IDENTITY_UNAVAILABLE':
    case 'FIRMWARE_UNSUPPORTED':
    case 'NO_RUNTIME_MOTORS':
    case 'MOTOR_COUNT_OUT_OF_RANGE':
    case 'UNSUPPORTED_PROTOCOL_DOMAIN':
    case 'ANALOG_3D_ENDPOINTS_UNKNOWN':
    case 'MOTOR_CONFIGURATION_DRIFTED':
      return 'GATES_NOT_SATISFIED';
    case undefined:
      // Unreachable: only called when at least one reason exists. Fails
      // CLOSED rather than inventing an acceptance.
      return 'GATES_NOT_SATISFIED';
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

const NO_PULSE: MotorTestPulseRecord = Object.freeze({
  attemptId: 0,
  motorNumber: undefined,
  submitted: false,
  acknowledged: false,
  deadlineArmedAtSubmission: false,
  mayHaveReachedFc: false,
  outcome: undefined,
});

/**
 * Maximum silence between two confirmations that the original touch still
 * owns the pulse. This is deliberately a short fail-safe window, NOT a
 * maximum motor-test duration: a healthy held gesture renews it and may run
 * for as long as the operator keeps their finger down.
 */
export const MOTOR_TEST_HOLD_HEARTBEAT_TIMEOUT_MILLIS = 1200;

/**
 * Identification normally finishes before an operator reaches the Motors
 * control. This bound exists for the real race where a very fast long press
 * arrives while identification is still RUNNING; it waits for real evidence
 * instead of either guessing or permanently killing the session at once.
 */
const MOTOR_TEST_FIRMWARE_IDENTIFICATION_TIMEOUT_MILLIS = 12_000;

export type MotorTestHoldHeartbeatResult =
  | 'RENEWED'
  | 'NO_ACTIVE_PULSE'
  | 'CONTROLLER_CLOSED';

export type MotorTestEscDirectionOutcome =
  | {
      readonly kind: 'ACKNOWLEDGED';
      readonly motorNumber: number;
      readonly direction: DshotEscDirection;
      readonly physicallyVerified: false;
    }
  | {
      readonly kind: 'REJECTED';
      readonly reason:
        | 'NOT_READY'
        | 'BUSY'
        | 'UNSUPPORTED'
        | 'INVALID_MOTOR';
    }
  | {readonly kind: 'UNCONFIRMED'};

export interface MotorTestStopExecutionRecord {
  /** How many real command-214 operations ran. Concurrent triggers join
   * one operation, so this counts operations, not callers. */
  readonly attempts: number;
  readonly commandDispatched: boolean;
  readonly commandAcknowledged: boolean;
  /** Permanently false. See the doc comment above. */
  readonly physicalStopConfirmed: false;
  /**
   * Phase 2G: true when the stop was submitted only AFTER an
   * uncancellable transport write ahead of it settled. While this is
   * true, NO deterministic latency bound may be claimed for the stop -
   * the write ahead of it settles on the transport's own schedule.
   */
  readonly deferredBehindActiveWrite: boolean;
  /**
   * Phase 2G: true when the stop displaced an already-written command
   * 214, so the FIRST frame that resolved could belong to the displaced
   * pulse rather than to this stop. It is a fact about that one exchange
   * and is never cleared.
   */
  readonly attributionAmbiguous: boolean;
  /**
   * True when the ambiguity above was RESOLVED by a second, independently
   * issued all-stop whose acknowledgement could not have been the
   * displaced pulse's response.
   *
   * WHY THIS EXISTS RATHER THAN JUST CLEARING THE FLAG. A normal early
   * release - the operator letting go while the pulse's own command 214
   * is still unanswered - used to be permanently terminal, because an
   * ambiguous first exchange was treated as unresolvable. It is not:
   * exactly ONE non-stop 214 can be confused with the stop, the FIFO
   * answers in order, and issuing a second all-stop therefore buys an
   * acknowledgement that provably belongs to an all-stop frame. The first
   * frame is still never accepted as proof - it is discarded, and this
   * flag records that something else supplied the proof instead.
   */
  readonly attributionResolvedByConfirmation: boolean;
  /**
   * Phase 2G: PERMANENTLY false. Nothing in this codebase can preempt
   * bytes already handed to the transport. The strongest true statement
   * is that the stop was the client's NEXT transport submission, which is
   * what `submittedNextOnTransport` records - a claim about submission
   * order inside the JS request engine and nothing more.
   */
  readonly wirePreemptionClaimed: false;
  readonly submittedNextOnTransport: boolean;
  /**
   * Phase 2G: which STOP EPISODE this record describes. Incremented for
   * every genuinely new stop operation, so a second pulse can never be
   * reported by - or joined onto - the first pulse's settled stop.
   */
  readonly episodeId: number;
  readonly outcome: MotorTestStopExecutionOutcome | undefined;
}

const NO_STOP_EXECUTION: MotorTestStopExecutionRecord = Object.freeze({
  attempts: 0,
  commandDispatched: false,
  commandAcknowledged: false,
  physicalStopConfirmed: false as const,
  deferredBehindActiveWrite: false,
  attributionAmbiguous: false,
  attributionResolvedByConfirmation: false,
  wirePreemptionClaimed: false as const,
  submittedNextOnTransport: false,
  episodeId: 0,
  outcome: undefined,
});

export type MotorTestDiagnosticsChannelState =
  | 'WAITING'
  | 'FRESH'
  | 'NOT_ENABLED'
  | 'UNSUPPORTED'
  | 'MALFORMED_RESPONSE'
  | 'LINK_FAILED';

export interface MotorTestDiagnosticsChannel<T> {
  readonly state: MotorTestDiagnosticsChannelState;
  readonly value: T | undefined;
  readonly observedAtMillis: number | undefined;
}

export interface MotorTestDiagnosticsSnapshot {
  readonly outputs: MotorTestDiagnosticsChannel<MspMotorOutputs>;
  readonly escTelemetry: MotorTestDiagnosticsChannel<MspMotorTelemetry>;
}

const WAITING_DIAGNOSTICS_CHANNEL = Object.freeze({
  state: 'WAITING' as const,
  value: undefined,
  observedAtMillis: undefined,
});
const WAITING_DIAGNOSTICS: MotorTestDiagnosticsSnapshot = Object.freeze({
  outputs: WAITING_DIAGNOSTICS_CHANNEL,
  escTelemetry: WAITING_DIAGNOSTICS_CHANNEL,
});

export interface MotorTestControllerSnapshot {
  readonly phase: MotorTestControllerPhase;
  readonly setupStep: MotorTestSetupStep;
  /** The accepted reducer's state, once a genuine official authority
   * exists. Undefined before that, by construction. */
  readonly machine: MotorTestState | undefined;
  readonly outcome: MotorTestSetupOutcome;
  /** Versioned adapter verdict consulted by the actual motor write gate. */
  readonly firmwareCompatibility: MotorFirmwareCompatibility | undefined;
  /**
   * The decoded configuration the encoder is scoped against, once read.
   * Undefined before step 7, which is why a pre-evidence stop is
   * unattemptable and a pre-evidence pulse is unencodable.
   */
  readonly motorScope: MotorVectorScope | undefined;
  /** Truthful source model for command-139 fields, derived from the same
   * MSP_MOTOR_CONFIG response as motorScope. */
  readonly motorDiagnosticsSupport: MotorDiagnosticsSupport | undefined;
  /** Whether this controller currently holds the telemetry barrier. */
  readonly telemetryHeld: boolean;
  readonly warnings: readonly MotorTestControllerWarning[];
  readonly stopDescriptors: readonly MotorTestStopDescriptor[];
  readonly teardown: MotorTestTeardownReport | undefined;
  /** Phase 2F: the command-214 stop execution record. */
  /**
   * Whether a motor command MAY BE LIVE right now, by the SAME expression
   * the real wire-stop gate uses (`pulseMayHaveReachedFc ||
   * engine.mayHaveReachedFc`), so a consumer that trusts this can never
   * disagree with the gate that actually stops motors.
   *
   * Reading `pulse.mayHaveReachedFc` alone is NOT equivalent and is the
   * specific mistake this field exists to prevent: a facade `setMaster`
   * latches the professional engine and never the legacy pulse, so a
   * consumer consulting only the legacy latch would call a
   * professionally-commanded, still-spinning output "at rest".
   *
   * False means NEITHER latch is set, which is the codebase's existing
   * statement that the session provably never commanded anything. It never
   * means "the motors have physically stopped" - see physicalStopConfirmed,
   * which is permanently false because that is not knowable from here.
   */
  readonly outputMayBeLive: boolean;
  readonly stopExecution: MotorTestStopExecutionRecord;
  /** Phase 2G: the fixed single-motor pulse-attempt record. */
  readonly pulse: MotorTestPulseRecord;
  /**
   * Phase 2H: whether a pulse may begin RIGHT NOW, and every reason it
   * may not. The SAME evaluation `pulseMotor()` performs - a consumer
   * that trusts this can never disagree with the real gate.
   */
  readonly activation: MotorTestActivationGate;
  /**
   * Phase 2I: the observation-eligible receipt for the LAST completed
   * attempt, or undefined when no attempt is currently eligible. See
   * MotorTestVerificationReceipt.
   */
  readonly verificationReceipt: MotorTestVerificationReceipt | undefined;
  /**
   * What the dedicated observation path currently proves about armed
   * state, read FRESH on every publish rather than cached: a value
   * captured once could outlive the condition it described.
   */
  readonly armedStateEvidence: MotorTestArmedStateEvidence;
  /** Fixed read-only probes sent through the SAME exclusive lease. */
  readonly diagnostics?: MotorTestDiagnosticsSnapshot;
  /**
   * P2-ii-A / P2-ii-S. The P1-resolved command domain for this exact
   * configuration - motor count, protocol family, 3D, the command-domain
   * bounds and their provenance, and the domain's own stop value.
   *
   * Undefined when the resolver refused the configuration. This is
   * DESCRIPTIVE only: it never widens what the shipping pulse path will
   * command, which `motorScope` and the legacy scope guard still decide
   * on their own terms.
   */
  readonly motorDomain: MotorTestValueDomain | undefined;
  /**
   * P2-ii-A / P2-ii-P. Whether the professional runtime path may command
   * that domain, and when it may not, exactly which firmware fact is
   * missing. Analog 3D is refused here - `limit3d_low`/`limit3d_high` are
   * not on the wire at API 1.47 - rather than approximated.
   */
  readonly motorRuntimeScope: MotorControlRuntimeScope | undefined;
}

export type MotorTestStopRequestResult =
  | 'ACCEPTED'
  | 'UNRECOGNIZED_STOP_TRIGGER'
  | 'CONTROLLER_CLOSED';

/**
 * The complete whitelist of stop triggers the public surface accepts.
 *
 * Every entry is an accepted `MotorTestStopTriggerReason`. Nothing else
 * is admitted - a caller-supplied value outside this set is rejected
 * without ever reaching the reducer, so the public surface can never be
 * used to smuggle an activation event in through the stop door.
 */
export const MOTOR_TEST_CONTROLLER_STOP_TRIGGERS: readonly MotorTestStopTriggerReason[] =
  Object.freeze([
    'TOUCH_RELEASED',
    'STOP_BUTTON_PRESSED',
    'MOTOR_SELECTION_CHANGED',
    'PULSE_DEADLINE_ELAPSED',
    'NAVIGATION_BLURRED',
    'ANDROID_BACK',
    'ANDROID_PREDICTIVE_BACK',
    'APP_STATE_BACKGROUNDED',
    'ARMED_STATE_DETECTED',
    'ARMING_RESTRICTION_REMOVED',
    'BATTERY_CHANGED',
    'BATTERY_BECAME_UNSAFE',
    'SAFETY_MONITORING_FAILED',
  ] as const);

const STOP_TRIGGER_SET: ReadonlySet<string> = new Set<string>(
  MOTOR_TEST_CONTROLLER_STOP_TRIGGERS,
);

/**
 * The entire public surface.
 *
 * Six operations. No generic dispatcher. No accessor for the lease, the
 * client, the authority, the receipt or the barrier hold, and no raw
 * write, priority or transport escape hatch of any kind.
 *
 * Phase 2G adds exactly ONE activating operation, `pulseMotor`. It takes
 * an output slot and nothing else: no magnitude, no duration, no vector,
 * no command number and no options. Every one of those is fixed by this
 * module and cannot be influenced by a caller.
 */
export interface MotorTestController {
  /**
   * Prepares the safety session: barrier, lease, motor scope and one fresh
   * disarmed-state observation.
   *
   * Named for what it does. It starts NO motor, submits no activation and
   * cannot reach `Starting` or `Pulsing`. Calling it again returns the
   * same operation without re-running anything.
   */
  initializeSession(): Promise<MotorTestControllerSnapshot>;
  getSnapshot(): MotorTestControllerSnapshot;
  subscribe(listener: () => void): MotorTestControllerUnsubscribe;
  /** Whitelist-only. Anything outside the whitelist is rejected. */
  requestStop(trigger: MotorTestStopTriggerReason): MotorTestStopRequestResult;
  /**
   * Phase 2G - the ONE activating operation.
   *
   * `motorNumber` selects an MSP OUTPUT SLOT, 1..4. It implies no airframe
   * position and no rotation direction. The magnitude is always the fixed
   * MOTOR_TEST_FIXED_PULSE_VALUE and every other output is always at stop;
   * neither is a parameter.
   *
   * Returns SYNCHRONOUSLY, before anything is awaited. A refusal has
   * dispatched nothing: no vector is built, no payload is encoded and the
   * transport is never touched.
   */
  pulseMotor(motorNumber: number): MotorTestPulseRequestResult;
  /**
   * Renews the fail-safe for the already-live pulse. It cannot start a
   * motor, select an output, change a magnitude or resurrect a stopped
   * attempt. The UI calls it only while the original Pressable owns touch.
   */
  renewPulseHold(): MotorTestHoldHeartbeatResult;
  /** Persists one selected DShot ESC direction without ending the session. */
  setEscDirection(
    motorNumber: number,
    direction: DshotEscDirection,
  ): Promise<MotorTestEscDirectionOutcome>;
  /** Refreshes the fixed read-only output and ESC telemetry channels. */
  refreshDiagnostics(): Promise<MotorTestDiagnosticsSnapshot>;
  /** Idempotent. Concurrent callers observe the same operation. */
  close(): Promise<MotorTestControllerSnapshot>;

  /* ---- P2-ii: THE PROFESSIONAL MOTOR-CONTROL FACADE. ----------------
   *
   * Thin, synchronous wrappers over the ONE session-owned
   * MotorControlCommandEngine. They add NO validation, coalescing,
   * encoding, stop logic or lease dispatch of their own - the engine owns
   * all of it - and they require no long press, no heartbeat, no fixed
   * magnitude and no one-motor-at-a-time restriction. A refusal has
   * dispatched nothing.
   */
  /** Sets the full desired vector - one value per motor, dense, inside
   * the resolved command domain. */
  setMotorValues(values: readonly number[]): MotorControlCommandResult;
  /** Mutates ONE entry of the desired full vector; travels the identical
   * full-vector path. */
  setMotorValue(motorIndex: number, value: number): MotorControlCommandResult;
  /** Every motor to one value: [value x motorCount]. */
  setMaster(value: number): MotorControlCommandResult;
  /** The canonical professional stop, through the same authority every
   * other stop source uses. */
  stopAll(): MotorTestStopRequestResult;
}

/* ------------------------------------------------------------------ *
 * Implementation
 * ------------------------------------------------------------------ */

/**
 * M-C - THE ONE MOTOR-COMMAND SCOPE RULE, generic over 1..8 motors.
 *
 * WHAT REPLACED WHAT. Until M-C this controller ran the legacy quad rule:
 * `assertSupportedMotorScope` refused FEATURE_3D outright and then refused
 * any motor count other than four. Both refusals were wrong for different
 * reasons and both are gone:
 *
 *  - THE COUNT. Nothing in the firmware makes four special. The mixer
 *    table carries counts from 0 to 8, MSP_SET_MOTOR is a plain vector
 *    write bounded by getMotorCount(), and MAX_SUPPORTED_MOTORS is 8. The
 *    rule is now the firmware's own bound.
 *
 *  - THE 3D BLANKET. Refusing every 3D configuration also refused DIGITAL
 *    3D, whose neutral is the protocol constant PWM_RANGE_MIDDLE and whose
 *    forward/reverse split is the firmware's own branch in
 *    dshotConvertFromExternal(). That is fully knowable. The case that is
 *    genuinely unknowable is ANALOG 3D, where `limit3d_low`/`limit3d_high`
 *    live in the firmware struct but are not on the wire at API 1.47 or
 *    1.49 - and `motorControlRuntimeScope` already refuses exactly that,
 *    by name. So there is now ONE owner of the 3D question instead of two
 *    that could disagree, and the strict half of the old rule is kept
 *    while the over-broad half is dropped.
 *
 * NO AIRFRAME BRANCHES. There is no `if TRI`, no `if HEX`, no `if OCTO`
 * and no mixer-mode test anywhere in this function or in anything it
 * calls. A tricopter and an octocopter reach the same three checks.
 *
 * Returns every reason that applies, so a caller sees the whole picture
 * rather than the first thing that happened to fail.
 */
/**
 * The fallback for a runtime-scope refusal this function does not name.
 *
 * The `never` parameter is the whole point: adding a refusal kind to
 * `MotorControlRuntimeScope` without handling it here FAILS TO COMPILE,
 * rather than silently producing no reason at all - which would be
 * fail-OPEN on a safety gate. At runtime it still refuses.
 */
function refusalForUnhandledScope(_unhandled: never): MotorCommandScopeRefusal {
  return 'UNSUPPORTED_PROTOCOL_DOMAIN';
}

function evaluateMotorCommandScope(
  scope: MotorVectorScope,
  runtimeScope: MotorControlRuntimeScope | undefined,
): readonly MotorCommandScopeRefusal[] {
  const reasons: MotorCommandScopeRefusal[] = [];

  // (1) THE RUNTIME COUNT, from MSP_MOTOR_CONFIG offset 6 and nothing
  // else. Never the mixer's expected count, never the telemetry frame's
  // count, never the first zero in MSP_MOTOR, and never a fallback of 4.
  const count = scope.motorCount;
  if (!Number.isInteger(count) || count < 0) {
    reasons.push('MOTOR_COUNT_OUT_OF_RANGE');
  } else if (count === 0) {
    reasons.push('NO_RUNTIME_MOTORS');
  } else if (count > MOTOR_TEST_COMMAND_VECTOR_SLOTS) {
    reasons.push('MOTOR_COUNT_OUT_OF_RANGE');
  }

  // (2) THE COMMAND DOMAIN, owned entirely by motorControlRuntimeScope.
  // An undefined runtime scope means the domain resolver refused this
  // configuration outright - an unknown protocol raw, or a 3D setup whose
  // required fields never arrived.
  if (runtimeScope === undefined) {
    reasons.push('UNSUPPORTED_PROTOCOL_DOMAIN');
  } else if (!runtimeScope.eligible) {
    switch (runtimeScope.refusal) {
      case 'ANALOG_3D_ACTIVE_ENDPOINTS_UNKNOWN':
      case 'THREE_D_ACTIVE_REGIONS_UNPROVEN':
      case 'THREE_D_NEUTRAL_UNRESOLVED':
        reasons.push('ANALOG_3D_ENDPOINTS_UNKNOWN');
        break;
      case 'PROTOCOL_FAMILY_UNKNOWN':
        reasons.push('UNSUPPORTED_PROTOCOL_DOMAIN');
        break;
      default:
        reasons.push(refusalForUnhandledScope(runtimeScope.refusal));
        break;
    }
  }

  return reasons;
}

/**
 * M-C - THE CONFIGURATION IDENTITY A SESSION IS BOUND TO.
 *
 * Captured once, when bring-up first resolves a usable configuration, and
 * compared on every activation evaluation afterwards. Every field is one
 * this controller would have to re-derive its command semantics from if it
 * changed:
 *
 *  - `motorCount` decides how many logical motors are commandable. A
 *    session opened for four must never quietly start commanding a fifth
 *    because a later read said six; that is a new session's decision, not
 *    a silent widening of this one.
 *  - `motorProtocolRaw` and `feature3dEnabled` decide the external-value
 *    conversion. A stale conversion is how 1000 stops one aircraft and
 *    drives another one backwards at full throttle.
 *  - `stopValue` is carried explicitly so a drift in the resolved stop is
 *    caught even if the three inputs above somehow matched.
 */
export interface MotorTestTopologyBinding {
  readonly motorCount: number;
  readonly motorProtocolRaw: number;
  readonly feature3dEnabled: boolean;
  readonly stopValue: number;
}

/**
 * Whether an observed configuration has moved away from the one a session
 * was bound to.
 *
 * EXPORTED, AND PURE, DELIBERATELY. The controller's own field-comparison
 * used to be a private method, and a mutation that deleted the comparison
 * outright survived every test in this repository - not because the tests
 * were weak, but because NO CURRENT CODE PATH RE-READS THE MOTOR SCOPE
 * DURING A LIVE SESSION. `runBenchSteps` reads it once at bring-up, the
 * diagnostics poller reads MSP_MOTOR and MSP_MOTOR_TELEMETRY only, and a
 * reconnect builds a whole new controller. So the guard cannot fire today.
 *
 * That is stated here rather than hidden, and the rule is tested directly
 * instead of being asserted through a path that cannot reach it. The guard
 * is a PRECONDITION for the migration that adds a mid-session refresh -
 * it exists so that refresh cannot be added without a decision - not a
 * claim that drift is currently detected in flight.
 *
 * Returns false when there is no binding: a session that never resolved a
 * configuration has nothing to have drifted FROM, and that case is already
 * reported as link unavailability.
 */
export function motorTopologyBindingHasDrifted(
  binding: MotorTestTopologyBinding | undefined,
  scope: MotorVectorScope | undefined,
  stopValue: number | undefined,
): boolean {
  if (binding === undefined || scope === undefined) {
    return false;
  }
  if (
    scope.motorCount !== binding.motorCount ||
    scope.motorProtocolRaw !== binding.motorProtocolRaw ||
    scope.feature3dEnabled !== binding.feature3dEnabled
  ) {
    return true;
  }
  // The resolved stop is compared separately: two configurations can agree
  // on all three inputs above and still resolve different stops if the
  // endpoints behind them moved.
  return stopValue !== undefined && stopValue !== binding.stopValue;
}

/** P2-ii. Whether the professional runtime path may command this domain. */
function runtimeScopeEligible(
  scope: MotorControlRuntimeScope | undefined,
): boolean {
  return scope !== undefined && scope.eligible;
}

/**
 * P2-ii. Projects an engine fault onto the legacy reducer's vocabulary.
 *
 * The engine's reasons are the professional model's; the legacy reducer
 * predates it and has its own smaller set. This mapping exists so the
 * legacy PROJECTION stays truthful - it never decides anything.
 */
function mapEngineFaultToLegacy(
  reason: MotorControlFaultReason,
): MotorTestFaultReason {
  switch (reason) {
    case 'STOP_FAILED':
    case 'STOP_UNCONFIRMED':
      return 'STOP_FAILED';
    case 'COMMAND_FAILED':
    case 'COMMAND_UNCONFIRMED':
      return 'WRITE_OUTCOME_UNKNOWN';
    case 'SESSION_ENDED':
    case 'ENABLE_FAILED':
    case 'UNSUPPORTED_DOMAIN':
      return 'SESSION_CHANGED';
    case 'AUTHORITY_MISMATCH':
      return 'AUTHORITY_MISMATCH';
    case 'TRANSPORT_LOST':
      return 'DESYNCHRONIZED';
    default:
      return 'NATIVE_EXCEPTION';
  }
}

/**
 * P2-ii. Projects a LEGACY stop trigger onto the professional reducer's
 * stop reason.
 *
 * The legacy vocabulary is the old pulse product's; the professional one
 * is the model P2-i proved SD1-SD5 against. This selects which
 * disposition a CONFIRMED stop lands in - it never decides whether the
 * stop happens, and every trigger from every source reaches the same
 * canonical engine stop.
 */
function mapLegacyStopReason(
  trigger: MotorTestStopTriggerReason,
): MotorControlStopReason {
  switch (trigger) {
    // Ordinary completions: the operator, or a designed cutoff.
    case 'TOUCH_RELEASED':
    case 'STOP_BUTTON_PRESSED':
    case 'MOTOR_SELECTION_CHANGED':
    case 'PULSE_DEADLINE_ELAPSED':
      return 'OPERATOR_STOP';
    case 'ARMED_STATE_DETECTED':
      return 'ARMED_STATE_DETECTED';
    case 'ARMING_RESTRICTION_REMOVED':
      return 'ARMING_RESTRICTION_LOST';
    case 'SAFETY_MONITORING_FAILED':
      return 'SAFETY_MONITORING_FAILED';
    case 'APP_STATE_BACKGROUNDED':
      return 'APP_BACKGROUNDED';
    case 'NAVIGATION_BLURRED':
    case 'ANDROID_BACK':
    case 'ANDROID_PREDICTIVE_BACK':
      return 'DEPARTURE_REQUESTED';
    default:
      // Battery and any future locking reason. Conservatively the
      // stricter class - an unforeseen trigger can never be treated as an
      // ordinary completion.
      return 'CONFIGURATION_CHANGED';
  }
}

const READ_REQUEST_OPTIONS = {wireFormat: 'v1'} as const;
const EMPTY_PAYLOAD = new Uint8Array(0);

function copyIdentity(
  identity: MspSessionCompositeIdentity,
): MspSessionCompositeIdentity {
  return Object.freeze({
    physicalGeneration: identity.physicalGeneration,
    mspEpoch: identity.mspEpoch,
  });
}

/**
 * The protocol layer's composite identity and the state layer's are
 * structurally identical by design (see motorTestLease.ts's own comment).
 * This copies rather than casts, so no caller-owned object crosses.
 */
function asFactsIdentity(
  identity: MspSessionCompositeIdentity,
): MotorStaticFactsSessionIdentity {
  return Object.freeze({
    physicalGeneration: identity.physicalGeneration,
    mspEpoch: identity.mspEpoch,
  });
}

interface SetupFailure {
  readonly reason: MotorTestSetupBlockedReason;
  readonly classification: MotorTestFailureClass;
}

interface FirmwareIdentityAcquisition {
  readonly identity: FlightControllerIdentity;
}

function failure(
  reason: MotorTestSetupBlockedReason,
  classification: MotorTestFailureClass,
): SetupFailure {
  return {reason, classification};
}

function isFailure(value: object): value is SetupFailure {
  return 'classification' in value;
}

function assertExhaustiveIdentificationState(
  _value: never,
): SetupFailure {
  return failure(
    'UNEXPECTED_SERVICE_EXCEPTION',
    fault('NATIVE_EXCEPTION'),
  );
}

class MotorTestControllerImpl {
  private readonly deps: MotorTestControllerDependencies;

  private phase: MotorTestControllerPhase = 'IDLE';
  private setupStep: MotorTestSetupStep = 'NOT_STARTED';
  private outcome: MotorTestSetupOutcome = Object.freeze({
    kind: 'PENDING' as const,
  });

  /** Step 2 - the controller cancellation/generation identity. Bumped
   * SYNCHRONOUSLY by every safety signal, so pending continuations are
   * invalidated before any cleanup is awaited. */
  private generation = 0;
  private closing = false;
  /** True once setup has settled, so a later stop cannot roll anything
   * back - it only reaches the reducer. */
  private setupSettled = false;

  /** Step 1 - the composite session anchor, captured exactly once. */
  private anchorIdentity: MspSessionCompositeIdentity | undefined;
  /** The official authority, captured exactly once (see file header). */
  private authority: MspOfficialSessionAuthority | undefined;
  private lease: MotorTestLease | undefined;
  /** The dedicated safety observation path for THIS session. Created and
   * started only once every setup fact is proven, stopped on teardown and
   * on any fault, and never shared with another session. */
  private safetyMonitor: MotorTestSafetyMonitorLike | undefined;
  private barrier: MotorTestBarrierHold | undefined;
  private boxIds: MotorTestBoxIdsSnapshot | undefined;
  /** Exact firmware/API adapter verdict for this physical session. */
  private firmwareCompatibility: MotorFirmwareCompatibility | undefined;

  private machine: MotorTestState | undefined;
  private effectRecord: MotorTestEffectRecord = EMPTY_MOTOR_TEST_EFFECT_RECORD;

  private teardownReport: MotorTestTeardownReport | undefined;
  /**
   * Phase 2F: the approved motor scope, captured from the SAME reads the
   * scope guard is evaluated against. Undefined until step 7, which is what
   * makes a pre-evidence stop unattemptable.
   *
   * IT IS RETAINED EVEN WHEN IT FAILS THE GUARD, deliberately: a session
   * refused because FEATURE_3D is on must be able to SAY that, and a scope
   * discarded on failure would leave the gate reporting nothing more useful
   * than "no link".
   */
  private motorScope: MotorVectorScope | undefined;
  private motorDiagnosticsSupport: MotorDiagnosticsSupport | undefined;
  /** P2-ii-A. The P1-resolved domain for this configuration, or undefined
   * when the resolver refused it. Never approximated. */
  private motorDomain: MotorTestValueDomain | undefined;
  /** P2-ii-A. Whether the professional runtime path may command that
   * domain, and if not, exactly what the pinned firmware could not tell
   * us. Analog 3D is refused here rather than guessed. */
  private motorRuntimeScope: MotorControlRuntimeScope | undefined;
  /**
   * M-C. The configuration identity this session was opened against.
   * Captured once at bring-up and never rewritten while the session
   * lives; see MotorTestTopologyBinding for what each field protects.
   */
  private topologyBinding: MotorTestTopologyBinding | undefined;
  /**
   * P2-ii. THE ONE session-scoped professional command authority.
   *
   * Constructed exactly once, in the enable path, after the flight
   * controller has been proven disarmed and the arming restriction has
   * been established. Every MSP_SET_MOTOR this controller issues after
   * that instant - professional or legacy-adapted - goes through it.
   */
  private engine: MotorControlCommandEngine | undefined;
  /** True once command 99 payload [1] has been acknowledged. Teardown
   * consults it to know whether a release is OWED, never as a gate. */
  private armingRestrictionEstablished = false;
  private armingRestrictionReceipt: MotorArmingRestrictionReceipt | undefined;
  /** P2-ii. Whether teardown actually released the restriction, and if
   * not, why it deliberately did not. */
  private armingRestrictionReleased:
    | 'NOT_OWED'
    | 'RELEASED'
    | 'WITHHELD_STOP_UNPROVEN'
    | 'RELEASE_FAILED' = 'NOT_OWED';
  private stopExecution: MotorTestStopExecutionRecord = NO_STOP_EXECUTION;
  /**
   * The ONE in-flight stop operation FOR THE CURRENT EPISODE. Concurrent
   * triggers await this exact promise rather than starting a second
   * command-214 request. Cleared only when that operation reaches a
   * terminal outcome, so a stale callback can never replace a stop that
   * is still running.
   */
  private stopInFlight: Promise<MotorTestStopExecutionOutcome> | undefined;
  /** Monotonic stop-episode counter. A later pulse always gets a fresh
   * episode; it can never reuse an earlier pulse's settled stop. */
  private stopEpisodeId = 0;
  /**
   * Phase 2I: which pulse attempt the CURRENT stop episode is ending.
   *
   * Pure bookkeeping - it changes no behaviour whatsoever. It exists
   * because `pulse.attemptId` and `stopExecution.episodeId` are
   * independent counters: without this link, "a pulse was acknowledged"
   * and "a stop was acknowledged" could belong to different attempts and
   * still look like a complete pair.
   */
  private stopEpisodeAttemptId: number | undefined;
  /** P2-ii. The legacy trigger that DEMANDED the episode currently
   * running, captured synchronously so the engine receives the reason
   * that actually caused it. Projection metadata: it selects the stop's
   * disposition, never whether the stop happens. */
  private stopTriggerForEpisode: MotorTestStopTriggerReason | undefined;
  /**
   * Set once a stop episode ended unsafely (failed, ambiguous, or never
   * attributably completed). A sealed stop can NEVER be rearmed - the
   * session is finished and only a full reset may follow.
   */
  private stopSealed = false;
  /** The most recent trigger passed to requestStop. */
  private lastStopTrigger: MotorTestStopTriggerReason | undefined;

  /* --- Phase 2G: the fixed single-motor pulse engine ---------------- */

  private pulse: MotorTestPulseRecord = NO_PULSE;
  /**
   * Identity of the LIVE pulse attempt. A late acknowledgement compares
   * against this by REFERENCE; anything else is stale by construction and
   * is discarded rather than applied.
   */
  private pulseAttempt: object | undefined;
  private pulseAttemptCounter = 0;
  private pulseDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  /** A persistent ESC command is serialized on the same lease and blocks
   * pulse activation until its post-write disarmed observation completes. */
  private directionChangeInFlight = false;
  private diagnostics: MotorTestDiagnosticsSnapshot = WAITING_DIAGNOSTICS;
  private diagnosticsPromise: Promise<MotorTestDiagnosticsSnapshot> | undefined;
  /** Latched at activation, never cleared. See MotorTestPulseRecord. */
  private pulseMayHaveReachedFc = false;
  /**
   * Phase 2G - the ACTIVATION BAR.
   *
   * WHY THIS EXISTS AT THE CONTROLLER LEVEL. The accepted reducer
   * deliberately leaves `Ready` unchanged on STOP_TRIGGERED when nothing
   * was ever submitted - it must not manufacture stop traffic for an
   * activation that never began, and that reasoning is correct for the
   * reducer's own job. But it means a LOCKING safety event that arrives
   * while idle (armed state detected, monitoring failure, navigation blur,
   * background or session invalidation) leaves the machine in `Ready` - and
   * `Ready` is exactly what this controller's activation gate consults.
   *
   * Without this bar, a controller that just reported itself armed or lost
   * its safety observation could still admit a fresh pulse. The precondition
   * that event invalidated has not come back, so activation is barred for the
   * rest of this session. Normal reasons - release, stop button, motor switch,
   * deadline - never set it.
   */
  private activationBarred = false;

  private readonly listeners = new Set<() => void>();
  private unsubscribeSession: MotorTestControllerUnsubscribe | undefined;

  private snapshot: MotorTestControllerSnapshot;
  private setupPromise: Promise<MotorTestControllerSnapshot> | undefined;
  private teardownPromise: Promise<MotorTestControllerSnapshot> | undefined;

  constructor(deps: MotorTestControllerDependencies) {
    this.deps = deps;
    this.snapshot = this.buildSnapshot();
  }

  /* --- publication ------------------------------------------------ */

  private buildSnapshot(): MotorTestControllerSnapshot {
    return Object.freeze({
      phase: this.phase,
      setupStep: this.setupStep,
      machine: this.machine,
      outcome: this.outcome,
      firmwareCompatibility: this.firmwareCompatibility,
      motorScope: this.motorScope,
      motorDiagnosticsSupport: this.motorDiagnosticsSupport,
      telemetryHeld: this.barrier?.isHeld() ?? false,
      warnings: this.effectRecord.warnings,
      stopDescriptors: this.effectRecord.stopDescriptors,
      teardown: this.teardownReport,
      outputMayBeLive:
        this.pulseMayHaveReachedFc || (this.engine?.mayHaveReachedFc ?? false),
      stopExecution: this.stopExecution,
      pulse: this.pulse,
      activation: this.evaluateActivation(),
      verificationReceipt: this.evaluateVerificationReceipt(),
      // Read FRESH, never cached at construction: a value captured once
      // could outlive the condition it described.
      armedStateEvidence: this.readArmedStateEvidence(),
      diagnostics: this.diagnostics,
      motorDomain: this.motorDomain,
      motorRuntimeScope: this.motorRuntimeScope,
    });
  }

  /** The one place the monitor is turned into a gate input. */
  private readArmedStateEvidence(): MotorTestArmedStateEvidence {
    return readMotorArmedStateEvidence(
      this.safetyMonitor,
      this.deps.readMonotonicMillis(),
    );
  }

  /**
   * Rebuilds and notifies.
   *
   * The snapshot is built BEFORE any listener runs and is never touched
   * again, so a listener that throws cannot leave a half-built snapshot
   * visible, cannot mutate controller state and cannot prevent a later
   * listener from running. The listener set is copied first, so a
   * listener that unsubscribes another mid-dispatch cannot skip it.
   */
  private publish(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of Array.from(this.listeners)) {
      try {
        listener();
      } catch {
        // A subscriber's failure is its own. It never mutates state,
        // never resumes telemetry and never interrupts cleanup.
      }
    }
  }

  getSnapshot(): MotorTestControllerSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): MotorTestControllerUnsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /* --- reducer driving -------------------------------------------- */

  /**
   * Applies one already-constructed event. PRIVATE, and every caller is
   * one of the three narrow helpers below - there is no path by which a
   * caller can hand in an arbitrary event.
   */
  private apply(
    event: MotorTestEvent,
    stopReason: MotorTestStopTriggerReason | undefined,
  ): void {
    const state = this.machine;
    if (state === undefined) {
      return;
    }
    const transition = motorTestTransition(state, event);
    this.machine = transition.state;
    this.effectRecord = applyMotorTestEffects(
      this.effectRecord,
      transition.effects,
      stopReason,
    );
  }

  private dispatchGates(passed: boolean): void {
    const authority = this.authority;
    if (authority === undefined) {
      return;
    }
    this.apply(
      {authority, kind: passed ? 'GATES_PASSED' : 'GATES_FAILED'},
      undefined,
    );
  }

  private dispatchFault(reason: MotorTestFaultReason): void {
    const authority = this.authority;
    if (authority === undefined) {
      return;
    }
    // A faulted session can never activate again, so monitoring it would
    // buy nothing and could only produce further stop requests against a
    // machine that is already dead. Stopped here, at the one choke point
    // every fault passes through, rather than at each call site.
    this.safetyMonitor?.stop();
    this.apply({authority, kind: 'FAULT_RAISED', reason}, undefined);
  }

  /**
   * The dedicated safety monitor proved the link unsafe.
   *
   * EVERY branch reaches the SAME idempotent priority-stop path as a
   * touch release or a deadline - `requestStop`, which registers the
   * emergency stop synchronously before it returns. Nothing here writes a
   * motor value, and nothing here waits on the monitor.
   *
   * AN ARMED READING is reported with the accepted `ARMED_STATE_DETECTED`
   * trigger, so the operator is told the condition the flight controller
   * itself reported. A FAILED or STALE reading additionally FAULTS under
   * `SAFETY_MONITORING_FAILED`: a read that timed out or could not be
   * trusted while an output may be live is exactly the case where the
   * session must not be reusable, and it is named for what happened rather
   * than borrowed from the battery vocabulary as it once was.
   */
  private onSafetyMonitorUnsafe(reason: MotorTestSafetyUnsafeReason): void {
    if (reason === 'FC_ARMED_OBSERVED') {
      this.requestStop('ARMED_STATE_DETECTED');
      return;
    }
    // Stop FIRST - the stop is registered before the fault is dispatched,
    // so a possibly-live output is addressed before the state machine is
    // told the session is dead.
    this.requestStop('SAFETY_MONITORING_FAILED');
    this.dispatchFault('MSP_RESPONSE_TIMEOUT');
    // requestStop() published BEFORE the fault existed, so without this a
    // subscriber would be left holding a snapshot that shows the stop but
    // not the Fault it caused.
    this.publish();
  }

  private dispatchStop(reason: MotorTestStopTriggerReason): void {
    const authority = this.authority;
    if (authority === undefined) {
      return;
    }
    this.apply({authority, kind: 'STOP_TRIGGERED', reason}, reason);
  }

  /**
   * Reports an ATTRIBUTABLE all-stop acknowledgement to the reducer.
   *
   * Reachable from exactly one place - the stop operation's own terminal
   * outcome - and only for `ACKNOWLEDGED`. There is no path by which a
   * caller, a timer, a late frame or a UI event can construct this event,
   * which is what keeps "the machine left Stopping" tied to a real,
   * attributable acknowledgement of a real all-stop frame.
   */
  private dispatchStopAcknowledged(): void {
    const authority = this.authority;
    if (authority === undefined) {
      return;
    }
    this.apply({authority, kind: 'STOP_ACKNOWLEDGED'}, undefined);
  }

  /**
   * Puts monitoring back after a stop that left the session genuinely
   * usable, and proves the flight controller disarmed all over again
   * before anything may be activated.
   *
   * EVERY CONDITION BELOW IS A REFUSAL TO RESUME, not a formality:
   *   - a closing or closed controller has nothing to monitor;
   *   - a reducer that did not land in `Ready` means the stop was a
   *     locking or faulting one, and that session is over;
   *   - a sealed stop or a latched safety event is terminal by
   *     construction;
   *   - a monitor whose last reading was ARMED or FAILED already reported
   *     itself unsafe, and restarting it would paper over that.
   *
   * The fresh observation is AWAITED and then published, exactly as the
   * setup boundary does, so the control becomes usable from the reading
   * itself rather than from some unrelated later render.
   */
  private resumeMonitoringAfterStop(): void {
    const monitor = this.safetyMonitor;
    if (monitor === undefined || this.closing || this.phase !== 'ACTIVE') {
      return;
    }
    if (this.stopSealed || this.activationBarred || this.stopInFlight !== undefined) {
      return;
    }
    if (this.machine === undefined || this.machine.name !== 'Ready') {
      return;
    }
    const status = monitor.snapshot().status;
    if (status.kind === 'ARMED' || status.kind === 'FAILED') {
      return;
    }
    monitor.start();
    monitor
      .observeNow()
      .then(() => {
        this.publish();
      })
      .catch(() => {
        // observeNow is documented never to reject; the monitor's own
        // failure path has already reported through `onUnsafe`.
        this.publish();
      });
  }

  /* --- cancellation ----------------------------------------------- */

  /** Synchronously invalidates every pending setup continuation. */
  private invalidateContinuations(): void {
    this.generation += 1;
  }

  private isCurrent(generation: number): boolean {
    return this.generation === generation && !this.closing;
  }

  /* --- public operations ------------------------------------------ */

  initializeSession(): Promise<MotorTestControllerSnapshot> {
    // ORDER IS THE FIX, AND IT IS NOT COSMETIC.
    //
    // The closed check used to sit BELOW the cache check. Once setup had
    // run and teardown had reached CLOSED, `setupPromise` was still a
    // settled promise, so every later Step-1 press returned it - resolving
    // to the snapshot captured WHEN THAT PROMISE SETTLED, not the current
    // post-teardown one. The operator pressed a button and got a stale
    // success/failure object back from a dead controller, with nothing
    // saying a new connection was needed.
    //
    // Checked first, the closed controller now answers with its CURRENT
    // snapshot, whose `outcome` carries `requiresNewSession: true` after
    // any teardown-completing failure. The screen renders that as an
    // explicit Arabic instruction to disconnect and reconnect.
    //
    // DELIBERATELY NOT "let runSetup() run again". This instance still
    // holds its terminal outcome, teardown report, listener set, monitor,
    // barrier and lease/authority fields. Re-running setup on top of that
    // would reuse session-bound evidence, which is exactly what must never
    // happen. A genuinely fresh attempt needs a genuinely fresh
    // controller - see the note in motorTestSessionBinding.ts on why that
    // cannot be minted under the current frozen-facade binding without a
    // change-notification path, and why the operator is told to reconnect
    // instead of being silently handed a corpse.
    if (this.closing || this.phase === 'CLOSED') {
      return Promise.resolve(this.snapshot);
    }
    if (this.setupPromise !== undefined) {
      return this.setupPromise;
    }
    this.setupPromise = this.runSetup();
    return this.setupPromise;
  }

  requestStop(trigger: MotorTestStopTriggerReason): MotorTestStopRequestResult {
    // Whitelist first: an unrecognized value never reaches the reducer,
    // never invalidates a continuation and never publishes.
    if (!STOP_TRIGGER_SET.has(trigger)) {
      return 'UNRECOGNIZED_STOP_TRIGGER';
    }
    if (this.phase === 'CLOSED') {
      return 'CONTROLLER_CLOSED';
    }
    // A stop is a SAFETY SIGNAL: pending setup continuations die
    // SYNCHRONOUSLY, before anything is awaited, so a slow gate can never
    // publish Ready behind a stop that already happened. It does NOT
    // destroy the controller: once setup has settled there is nothing
    // in flight to cancel, the acquired lease and barrier are retained,
    // and only the reducer sees the trigger.
    if (!this.setupSettled) {
      this.invalidateContinuations();
    }

    // Phase 2G - STOP DOMINANCE. Everything below happens SYNCHRONOUSLY,
    // before a single await, and in this order:
    //
    //   (a) the pulse watchdog is disarmed, so it can never fire against a
    //       session that is already stopping;
    //   (b) the live pulse attempt is invalidated by REFERENCE, so a
    //       command-214 response still in flight can never re-enter
    //       Pulsing, clear a Fault, cancel this stop, or touch whatever
    //       session replaces this one;
    //   (c) the emergency stop is REGISTERED - not merely planned - so it
    //       is already the client's next transport submission before this
    //       method returns.
    //
    // (c) is the reason this is not left to teardown: a stop that is only
    // scheduled is not a stop.
    // A reason that invalidates the preconditions themselves bars any
    // further activation for this session, whether or not anything was
    // live when it arrived. Classified by the ACCEPTED helper, so this can
    // never drift from the reducer's own disposition rules.
    if (dispositionForStopReason(trigger) === 'Locked') {
      this.activationBarred = true;
    }
    // Recorded BEFORE any stop runs, so the episode binds to the trigger
    // that actually demanded it.
    this.lastStopTrigger = trigger;
    this.clearPulseDeadline();
    const dominated = this.pulseAttempt !== undefined;
    if (dominated) {
      this.endPulseAttempt({kind: 'FAILED', reason: 'STOP_DOMINATED'});
    }
    this.dispatchStop(trigger);
    // P2-ii FINAL CONVERGENCE. The wire stop runs when a command MAY BE
    // LIVE by EITHER liveness latch: the legacy pulse's, or the
    // professional engine's own - a facade `setMaster` latches the second
    // and never the first, and a stop that consulted only the legacy one
    // would leave a professionally-commanded output spinning. A session
    // where NEITHER is latched provably never commanded anything, and
    // keeps the legacy contract of reporting its own specific cause
    // rather than manufacturing stop traffic.
    if (this.pulseMayHaveReachedFc || (this.engine?.mayHaveReachedFc ?? false)) {
      // Fire-and-join: the operation is registered now; its outcome is
      // consumed by whoever awaits it (teardown, or a later trigger that
      // joins this same episode). The catch is a guard against an
      // unhandled rejection only - executeStopVector never throws for an
      // expected failure, it returns a typed outcome.
      this.executeStopVector().catch(() => undefined);
    }
    this.publish();
    return 'ACCEPTED';
  }

  /* --- Phase 2G: the fixed single-motor pulse engine ---------------- */

  pulseMotor(motorNumber: number): MotorTestPulseRequestResult {
    // Every refusal below returns before ANY vector is built, ANY payload
    // is encoded, and ANY transport call is made.
    if (this.phase === 'CLOSED' || this.phase === 'CLOSING' || this.closing) {
      return 'CONTROLLER_CLOSED';
    }
    // M-C: 1..runtimeMotorCount, from MSP_MOTOR_CONFIG and nothing else.
    // A tricopter offers three, an octocopter eight, and a configuration
    // whose count was never read offers none - `commandableMotorCount()`
    // returns undefined rather than assuming four.
    if (!this.isCommandableMotorNumber(motorNumber)) {
      return 'INVALID_MOTOR';
    }

    // A live episode is STOPPED by a switch request, and the requested
    // motor is deliberately NOT started. Two motors can never be commanded
    // by one gesture, and a switch is never an implicit activation.
    if (this.pulseAttempt !== undefined) {
      this.requestStop('MOTOR_SELECTION_CHANGED');
      return 'SWITCH_REQUIRES_NEW_ACTIVATION';
    }

    // THE ONE GATE. Exactly the evaluation published on every snapshot as
    // `activation`, so a UI that reads `allowed` and a caller that reaches
    // here can never disagree. Nothing is re-checked below it.
    const gate = this.evaluateActivation();
    if (!gate.allowed) {
      return mapActivationBlockToPulseResult(gate.reasons[0]);
    }

    // Non-null by construction: the gate above rejects every one of these.
    const authority = this.authority as MspOfficialSessionAuthority;

    /* ---- P2-ii STEP 4: THE CONVERGENCE POINT. --------------------
     *
     * This used to encode the payload here and hand it straight to
     * `lease.request(...)`. That made the LEGACY reducer plus this gate a
     * SECOND, independent permission to put a motor value on the wire -
     * exactly the duplicate authority P2-ii exists to remove.
     *
     * The legacy pulse is now a COMPATIBILITY ADAPTER over the one
     * session-scoped professional engine. What survives here is legacy UI
     * SEMANTICS - the fixed magnitude, the one-motor-at-a-time rule, the
     * held-gesture watchdog, the activation episode - and every one of
     * them may only decide WHETHER TO ASK. The engine decides whether the
     * command happens, validates it against the resolved P1 domain,
     * encodes it, and owns the lease call.
     *
     * 1050 IS NOW JUST A VALUE THIS ADAPTER CHOOSES. It is not a
     * professional default, minimum, master value or safety invariant, and
     * nothing inside the engine knows it exists.
     */
    const engine = this.engine;
    const domain = this.motorDomain;
    if (engine === undefined || domain === undefined) {
      // No professional authority for this session means no motor command,
      // whatever the legacy gate concluded. Fails closed with zero traffic.
      return 'GATES_NOT_SATISFIED';
    }

    let desired: readonly number[];
    try {
      desired = buildSingleOutputVectorForDomain(
        domain,
        motorNumber - 1,
        MOTOR_TEST_FIXED_PULSE_VALUE,
      );
    } catch {
      return 'GATES_NOT_SATISFIED';
    }

    // ---- ACCEPTED. From here the activation is uncancellable. ----

    // (1) A fresh attempt identity. Reference equality is the ONLY test a
    //     later callback may use to prove it still belongs to this
    //     attempt; a counter or motor number could repeat, an object
    //     cannot.
    const attempt = {};
    this.pulseAttempt = attempt;
    this.pulseAttemptCounter += 1;
    const attemptId = this.pulseAttemptCounter;

    // (2) Enter Starting.
    this.apply({authority, kind: 'ACTIVATION_ACCEPTED'}, undefined);

    // (3) Arm the watchdog BEFORE submission, measured from submission
    //     start and never from acknowledgement. Deliberately earlier than
    //     strictly required: arming late is a safety failure, arming
    //     early only ever shortens the live window.
    this.armPulseDeadline(attempt);

    // (4) Latch that a motor command may now reach the FC. Never cleared.
    this.pulseMayHaveReachedFc = true;
    this.pulse = Object.freeze({
      attemptId,
      motorNumber,
      submitted: true,
      acknowledged: false,
      deadlineArmedAtSubmission: true,
      mayHaveReachedFc: true,
      outcome: undefined,
    });

    // (5) The write call is being made now.
    this.apply({authority, kind: 'START_WRITE_CALLED'}, undefined);

    // (6) Submit THROUGH THE PROFESSIONAL ENGINE. It validates against the
    //     resolved domain, encodes, and issues the lease request itself.
    //     A refusal here is authoritative even though the legacy gate
    //     already said yes - which is the entire point of the migration.
    const accepted = engine.setMotorValues(desired);
    if (accepted.kind !== 'ACCEPTED') {
      // The engine refused after the legacy gate allowed. Roll the legacy
      // projection back to a non-active episode; nothing was written.
      this.endPulseAttempt({kind: 'FAILED', reason: 'STOP_DOMINATED'});
      this.pulse = Object.freeze({
        ...this.pulse,
        submitted: false,
        outcome: {kind: 'FAILED' as const, reason: 'STOP_DOMINATED' as const},
      });
      this.publish();
      return 'GATES_NOT_SATISFIED';
    }

    this.publish();
    return 'ACCEPTED';
  }

  /**
   * P2-ii Step 4 - the legacy PROJECTION of one engine command outcome.
   *
   * This is where a dispatch result becomes legacy pulse state. It decides
   * NOTHING: by the time it runs the engine has already applied its own
   * reducer and already acted. Attribution is by REFERENCE to the live
   * attempt, exactly as the old `runPulse` did, so a late acknowledgement
   * cannot complete an episode that a stop, a fault or a newer activation
   * has already ended - and therefore cannot complete the WRONG
   * verification episode.
   */
  private onEngineCommandOutcome(
    outcome: 'ACKNOWLEDGED' | 'FAILED' | 'SUPERSEDED',
  ): void {
    const attempt = this.pulseAttempt;
    const authority = this.authority;
    if (attempt === undefined || authority === undefined) {
      // No live legacy episode. A professional-only command, or a result
      // for an episode already ended. Recorded nowhere, which is correct.
      return;
    }
    if (outcome === 'SUPERSEDED') {
      // Discarded entirely: it cannot re-enter Pulsing, clear a Fault,
      // cancel a stop, or touch a replacement session.
      return;
    }
    if (outcome === 'FAILED') {
      this.endPulseAttempt({kind: 'FAILED', reason: 'REQUEST_FAILED'});
      this.failPulseClosed('WRITE_OUTCOME_UNKNOWN');
      return;
    }
    // ACK is reception. It is not motion, not RPM, not direction and not a
    // frame position.
    this.pulse = Object.freeze({
      ...this.pulse,
      acknowledged: true,
      outcome: {kind: 'ACKNOWLEDGED' as const},
    });
    this.apply({authority, kind: 'START_ACKNOWLEDGED'}, undefined);
    this.publish();
  }

  renewPulseHold(): MotorTestHoldHeartbeatResult {
    if (this.phase === 'CLOSED' || this.phase === 'CLOSING' || this.closing) {
      return 'CONTROLLER_CLOSED';
    }
    const attempt = this.pulseAttempt;
    if (attempt === undefined) {
      return 'NO_ACTIVE_PULSE';
    }
    this.armPulseDeadline(attempt);
    return 'RENEWED';
  }

  /* ---- P2-ii: the professional facade. ----------------------------
   *
   * Each operation is a THIN wrapper: the engine validates against the
   * resolved P1 domain, coalesces, encodes and dispatches. The controller
   * contributes exactly two things - session phase gating, and the rule
   * that a session with no professional authority refuses rather than
   * improvising one. No long press, no heartbeat, no fixed 1050 and no
   * one-motor restriction exist on this path.
   */

  private professionalEngine(): MotorControlCommandEngine | undefined {
    if (this.phase === 'CLOSED' || this.phase === 'CLOSING' || this.closing) {
      return undefined;
    }
    return this.engine;
  }

  setMotorValues(values: readonly number[]): MotorControlCommandResult {
    const engine = this.professionalEngine();
    if (engine === undefined) {
      return {kind: 'REFUSED', reason: 'NOT_COMMANDABLE'};
    }
    return engine.setMotorValues(values);
  }

  setMotorValue(motorIndex: number, value: number): MotorControlCommandResult {
    const engine = this.professionalEngine();
    if (engine === undefined) {
      return {kind: 'REFUSED', reason: 'NOT_COMMANDABLE'};
    }
    return engine.setMotorValue(motorIndex, value);
  }

  setMaster(value: number): MotorControlCommandResult {
    const engine = this.professionalEngine();
    if (engine === undefined) {
      return {kind: 'REFUSED', reason: 'NOT_COMMANDABLE'};
    }
    return engine.setMaster(value);
  }

  /**
   * The canonical professional stop. Deliberately routed through
   * `requestStop` rather than straight at the engine: episode binding,
   * the seal, the legacy projection and the reducer dispatch all live on
   * that one funnel, and a second entrance would bypass them.
   */
  stopAll(): MotorTestStopRequestResult {
    return this.requestStop('STOP_BUTTON_PRESSED');
  }

  async setEscDirection(
    motorNumber: number,
    direction: DshotEscDirection,
  ): Promise<MotorTestEscDirectionOutcome> {
    if (!this.isCommandableMotorNumber(motorNumber)) {
      return {kind: 'REJECTED', reason: 'INVALID_MOTOR'};
    }
    if (
      this.directionChangeInFlight ||
      this.pulseAttempt !== undefined ||
      this.stopInFlight !== undefined
    ) {
      return {kind: 'REJECTED', reason: 'BUSY'};
    }
    if (!this.evaluateActivation().allowed) {
      return {kind: 'REJECTED', reason: 'NOT_READY'};
    }
    const lease = this.lease;
    const authority = this.authority;
    if (lease === undefined || authority === undefined) {
      return {kind: 'REJECTED', reason: 'NOT_READY'};
    }

    let payload: Uint8Array;
    try {
      // M-C: the same generic scope rule the activation gate runs. A
      // direction command is a DShot command, so it is refused for exactly
      // the configurations that cannot resolve a command domain - never
      // because the aircraft has a motor count this app used to dislike.
      const scope = this.motorScope;
      if (
        scope === undefined ||
        evaluateMotorCommandScope(scope, this.motorRuntimeScope).length > 0
      ) {
        return {kind: 'REJECTED', reason: 'UNSUPPORTED'};
      }
      payload = encodeDshotEscDirection(motorNumber - 1, direction);
    } catch {
      return {kind: 'REJECTED', reason: 'UNSUPPORTED'};
    }

    this.directionChangeInFlight = true;
    this.safetyMonitor?.stop();
    this.publish();
    let remoteUnsupported = false;
    try {
      await lease.requestOptional(MSP2_SEND_DSHOT_COMMAND, payload, {
        wireFormat: 'v2',
      });
    } catch (error) {
      remoteUnsupported =
        error instanceof MspClientError && error.code === 'MSP_REMOTE_ERROR';
      if (!remoteUnsupported) {
        this.directionChangeInFlight = false;
        this.activationBarred = true;
        this.dispatchFault('WRITE_OUTCOME_UNKNOWN');
        this.publish();
        return {kind: 'UNCONFIRMED'};
      }
    }
    this.directionChangeInFlight = false;

    if (
      !lease.isActive() ||
      lease.officialSessionAuthority() !== authority ||
      this.authority !== authority
    ) {
      this.activationBarred = true;
      this.dispatchFault('WRITE_OUTCOME_UNKNOWN');
      this.publish();
      return {kind: 'UNCONFIRMED'};
    }

    const monitor = this.safetyMonitor;
    if (monitor === undefined) {
      this.activationBarred = true;
      this.dispatchFault('MSP_RESPONSE_TIMEOUT');
      this.publish();
      return {kind: 'UNCONFIRMED'};
    }
    try {
      monitor.start();
      await monitor.observeNow();
    } catch {
      if (!this.closing && this.phase !== 'CLOSED') {
        this.activationBarred = true;
        this.dispatchFault('MSP_RESPONSE_TIMEOUT');
        this.publish();
      }
      return {kind: 'UNCONFIRMED'};
    }
    // The awaited observation cannot authorise a result after teardown,
    // replacement or lease invalidation. The direction command is never
    // retried; the caller receives an unconfirmed outcome.
    if (
      this.closing ||
      this.phase !== 'ACTIVE' ||
      !lease.isActive() ||
      lease.officialSessionAuthority() !== authority ||
      this.authority !== authority
    ) {
      return {kind: 'UNCONFIRMED'};
    }
    if (this.readArmedStateEvidence() !== 'FRESH_DISARMED') {
      this.activationBarred = true;
      this.dispatchFault('MSP_RESPONSE_TIMEOUT');
      this.publish();
      return {kind: 'UNCONFIRMED'};
    }
    this.publish();
    return remoteUnsupported
      ? {kind: 'REJECTED', reason: 'UNSUPPORTED'}
      : Object.freeze({
          kind: 'ACKNOWLEDGED' as const,
          motorNumber,
          direction,
          physicallyVerified: false as const,
        });
  }

  refreshDiagnostics(): Promise<MotorTestDiagnosticsSnapshot> {
    const existing = this.diagnosticsPromise;
    if (existing !== undefined) {
      return existing;
    }
    if (
      this.phase !== 'ACTIVE' ||
      this.closing ||
      this.directionChangeInFlight ||
      this.stopInFlight !== undefined ||
      this.lease?.isActive() !== true
    ) {
      return Promise.resolve(this.diagnostics);
    }
    const started = this.runDiagnosticsRefresh();
    this.diagnosticsPromise = started;
    return started.finally(() => {
      if (this.diagnosticsPromise === started) {
        this.diagnosticsPromise = undefined;
      }
    });
  }

  private async runDiagnosticsRefresh(): Promise<MotorTestDiagnosticsSnapshot> {
    const lease = this.lease;
    if (lease === undefined) {
      return this.diagnostics;
    }
    const read = async <T>(
      command: number,
      decode: (payload: Uint8Array) => T,
      previous: MotorTestDiagnosticsChannel<T>,
    ): Promise<MotorTestDiagnosticsChannel<T>> => {
      try {
        const frame = await lease.requestOptional(command, EMPTY_PAYLOAD, {
          wireFormat: 'v1',
          responseTimeoutMs: 500,
        });
        return Object.freeze({
          state: 'FRESH' as const,
          value: decode(frame.payload),
          observedAtMillis: this.deps.readMonotonicMillis(),
        });
      } catch (error) {
        if (error instanceof MspMotorTestStopDisplacementError) {
          return previous;
        }
        if (error instanceof MspClientError && error.code === 'MSP_REMOTE_ERROR') {
          return Object.freeze({
            state: 'UNSUPPORTED' as const,
            value: undefined,
            observedAtMillis: this.deps.readMonotonicMillis(),
          });
        }
        if (error instanceof MspPayloadReadError) {
          return Object.freeze({
            state: 'MALFORMED_RESPONSE' as const,
            value: undefined,
            observedAtMillis: this.deps.readMonotonicMillis(),
          });
        }
        return Object.freeze({
          state: 'LINK_FAILED' as const,
          value: undefined,
          observedAtMillis: this.deps.readMonotonicMillis(),
        });
      }
    };

    const outputs = await read(
      MSP_MOTOR,
      decodeMotorOutputs,
      this.diagnostics.outputs,
    );
    this.diagnostics = Object.freeze({...this.diagnostics, outputs});
    this.publish();
    if (outputs.state === 'LINK_FAILED') {
      // A transport-ambiguous read failure is a link failure, even though
      // the command itself was read-only. If a motor pulse is live, the
      // normal monitor-failure route clears its heartbeat and registers the
      // priority all-stop immediately; if no pulse has ever been submitted,
      // it simply faults the unusable test session.
      this.onSafetyMonitorUnsafe('SAFETY_OBSERVATION_FAILED');
      return this.diagnostics;
    }
    if (
      !lease.isActive() ||
      this.closing ||
      this.phase !== 'ACTIVE' ||
      this.stopInFlight !== undefined ||
      this.directionChangeInFlight
    ) {
      return this.diagnostics;
    }
    // Betaflight serializes a valid all-zero command-139 payload when
    // neither bidirectional DShot nor FEATURE_ESC_SENSOR is enabled. A
    // successful reply is therefore not capability evidence. Refuse the
    // request entirely when the earlier MSP_MOTOR_CONFIG read proved that
    // there is no source, preserving NOT_ENABLED instead of publishing
    // synthetic-looking zero measurements as FRESH.
    if (!hasEscTelemetrySource(this.motorDiagnosticsSupport)) {
      const escTelemetry = Object.freeze({
        state: 'NOT_ENABLED' as const,
        value: undefined,
        observedAtMillis: this.deps.readMonotonicMillis(),
      });
      this.diagnostics = Object.freeze({...this.diagnostics, escTelemetry});
      this.publish();
      return this.diagnostics;
    }
    const escTelemetry = await read(
      MSP_MOTOR_TELEMETRY,
      decodeMotorTelemetry,
      this.diagnostics.escTelemetry,
    );
    this.diagnostics = Object.freeze({...this.diagnostics, escTelemetry});
    this.publish();
    if (escTelemetry.state === 'LINK_FAILED') {
      this.onSafetyMonitorUnsafe('SAFETY_OBSERVATION_FAILED');
    }
    return this.diagnostics;
  }

  /**
   * THE authoritative activation evaluation. Every accepted guard, all at
   * once, in one place. Called by `pulseMotor()` before any activation and
   * published verbatim on every snapshot.
   *
   * THE FIVE THINGS IT DIRECTLY REQUIRES:
   *   1. a live current session/controller that is not closing, closed,
   *      invalidated or replaced;
   *   2. a fresh production observation proving the FC is DISARMED;
   *   3. a supported motor scope with 3D disabled;
   *   4. no pulse or stop operation already in progress;
   *   5. no terminal safety fault for the current connection.
   *
   * INTERNAL PROTECTIONS ARE STRICTLY STRONGER THAN THE REASONS SHOWN, and
   * that asymmetry is intentional. `hasLiveWritableSession()` below still
   * requires the barrier held, the lease active, the authority equal BY
   * REFERENCE on both the lease and the reducer, and the composite session
   * identity still equal to the one-time anchor. A closed controller, a
   * stale requester, an inactive lease, a replaced session or a mismatched
   * authority therefore remains structurally incapable of writing - each
   * simply folds into `CONTROLLER_LINK_UNAVAILABLE` instead of being
   * enumerated as a separate operator-facing hardware fault.
   *
   * Collects EVERY applicable reason rather than short-circuiting, so the
   * screen can pick the first CAUSAL one and keep the rest for diagnostics.
   */
  private evaluateActivation(): MotorTestActivationGate {
    const reasons: MotorTestActivationBlockReason[] = [];
    const machineName = this.machine?.name;

    // (5) A terminal safety fault for this connection. Checked first
    // because everything else it produces is a consequence of it.
    if (
      this.activationBarred ||
      this.stopSealed ||
      this.outcome.kind === 'FAILED_CLOSED' ||
      machineName === 'Fault'
    ) {
      reasons.push('REQUIRES_NEW_CONNECTION');
    }

    // (4) A pulse or a stop already running. Read from the controller's own
    // records AND from the reducer, so neither alone can hide one.
    if (
      this.pulseAttempt !== undefined ||
      this.stopInFlight !== undefined ||
      this.directionChangeInFlight ||
      machineName === 'Starting' ||
      machineName === 'Pulsing' ||
      machineName === 'Stopping'
    ) {
      reasons.push('PULSE_OR_STOP_IN_PROGRESS');
    }

    // (1) A live, current, writable session - every internal protection.
    if (!this.hasLiveWritableSession()) {
      reasons.push('CONTROLLER_LINK_UNAVAILABLE');
    }

    // Firmware capability is independent from the decoded motor scope.
    // A different firmware may expose fields that happen to decode to the
    // same numbers while assigning different semantics to command 214.
    if (this.firmwareCompatibility?.status === 'UNSUPPORTED') {
      reasons.push('FIRMWARE_UNSUPPORTED');
    } else if (
      this.outcome.kind === 'BLOCKED' &&
      this.outcome.reason === 'FIRMWARE_IDENTITY_UNAVAILABLE'
    ) {
      reasons.push('FIRMWARE_IDENTITY_UNAVAILABLE');
    }

    // (3) Motor scope, re-run LIVE on every evaluation and never trusted
    // from setup alone. A scope that was never read is setup
    // incompleteness, NOT a statement about the aircraft's configuration:
    // telling somebody their motor setup is unsupported when it has never
    // been inspected would be a lie, so that case is reported as link
    // unavailability instead.
    const scope = this.motorScope;
    if (scope === undefined) {
      if (!reasons.includes('CONTROLLER_LINK_UNAVAILABLE')) {
        reasons.push('CONTROLLER_LINK_UNAVAILABLE');
      }
    } else {
      for (const reason of evaluateMotorCommandScope(
        scope,
        this.motorRuntimeScope,
      )) {
        reasons.push(reason);
      }
      // M-C: the configuration this session was opened against must still
      // be the one the flight controller reports. Checked HERE, on every
      // evaluation, rather than only at bring-up - a binding that is only
      // proved once is a snapshot, and a snapshot is what this guard
      // exists to refuse.
      if (this.topologyBindingHasDrifted()) {
        reasons.push('MOTOR_CONFIGURATION_DRIFTED');
      }
    }

    // (2) A fresh production observation proving DISARMED. Read FRESH, so
    // an observation that ages out between two evaluations stops
    // authorising anything without waiting for a render.
    const armedEvidence = this.readArmedStateEvidence();
    if (armedEvidence === 'FC_ARMED') {
      reasons.push('FC_ARMED');
    } else if (armedEvidence !== 'FRESH_DISARMED') {
      reasons.push('ARMED_STATE_UNKNOWN_OR_STALE');
    }

    if (reasons.length === 0) {
      return ACTIVATION_ALLOWED;
    }
    return Object.freeze({allowed: false, reasons: Object.freeze(reasons)});
  }

  /**
   * M-C. How many logical motors this session may command, or undefined
   * when no count has been read.
   *
   * THE ONE AUTHORITY IS MSP_MOTOR_CONFIG offset 6. Deliberately NOT the
   * mixer's expected count (which is a compile-time constant that the
   * running firmware may disagree with, and which does not exist at all
   * for a custom mixer), NOT MSP_MOTOR_TELEMETRY's frame count, NOT the
   * first zero in MSP_MOTOR's eight slots, and never a fallback of four.
   */
  private commandableMotorCount(): number | undefined {
    const count = this.motorScope?.motorCount;
    if (
      count === undefined ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > MOTOR_TEST_COMMAND_VECTOR_SLOTS
    ) {
      return undefined;
    }
    return count;
  }

  /**
   * Whether an operator-facing motor number addresses a motor this
   * session may command: 1..runtimeMotorCount, and nothing else.
   *
   * Motor N is firmware output index N-1 on every airframe. No right-to-
   * left reversal is applied - mirroring is a drawing decision and
   * renumbering a machine's motors to suit a layout would be a defect.
   */
  private isCommandableMotorNumber(motorNumber: number): boolean {
    const count = this.commandableMotorCount();
    return (
      count !== undefined &&
      Number.isInteger(motorNumber) &&
      motorNumber >= 1 &&
      motorNumber <= count
    );
  }

  /**
   * M-C. Whether the flight controller's configuration has moved away
   * from the one this session was opened against.
   *
   * Returns false when no binding has been captured yet - a session that
   * has not resolved a configuration has nothing to have drifted FROM,
   * and that case is already reported as link unavailability.
   */
  private topologyBindingHasDrifted(): boolean {
    return motorTopologyBindingHasDrifted(
      this.topologyBinding,
      this.motorScope,
      this.motorDomain?.stopValue,
    );
  }

  /**
   * Every structural condition that must hold for this controller to be
   * able to put a byte on the wire at all.
   *
   * NOTHING HERE IS COSMETIC. Each clause was a separately displayed
   * activation reason before the simplification and each one still refuses
   * a write; they are collapsed into one operator-facing statement, not
   * into one weaker check.
   */
  private hasLiveWritableSession(): boolean {
    if (this.closing || this.phase !== 'ACTIVE') {
      return false;
    }
    if (
      this.firmwareCompatibility === undefined ||
      !motorFirmwareSupports(
        this.firmwareCompatibility,
        'MOTOR_TEST_WRITE',
      )
    ) {
      return false;
    }
    if (this.outcome.kind !== 'READY') {
      return false;
    }
    // The barrier must still be genuinely held - not merely once acquired.
    if (this.barrier === undefined || !this.barrier.isHeld()) {
      return false;
    }
    // Authority and lease by REFERENCE, never by value: a structurally
    // identical clone of either fails here, which is the whole point of
    // the authority being a non-forgeable object.
    const lease = this.lease;
    const authority = this.authority;
    if (lease === undefined || authority === undefined) {
      return false;
    }
    if (!lease.isActive() || lease.officialSessionAuthority() !== authority) {
      return false;
    }
    const machine = this.machine;
    if (machine === undefined || machine.authority !== authority) {
      return false;
    }
    if (machine.name !== 'Ready') {
      return false;
    }
    // The session must still be the very one the anchor described. A
    // replacement reports a different composite identity even when the
    // lease has not yet noticed.
    const anchor = this.anchorIdentity;
    if (anchor === undefined) {
      return false;
    }
    let current: MspSessionCompositeIdentity | undefined;
    try {
      current = this.deps.session.readCurrentIdentity();
    } catch {
      // An identity provider that throws proves nothing. Fail closed.
      return false;
    }
    return mspSessionCompositeIdentitiesMatch(current, anchor);
  }

  /**
   * Phase 2I - the receipt projection. Every clause is load-bearing, and
   * failing ANY of them yields `undefined` rather than a degraded receipt:
   * an observation must never be recorded against an attempt that was not
   * cleanly completed.
   */
  private evaluateVerificationReceipt():
    | MotorTestVerificationReceipt
    | undefined {
    const authority = this.authority;
    const lease = this.lease;
    const pulse = this.pulse;
    const stop = this.stopExecution;

    // (1) A live official session, by reference. A replaced, faulted,
    //     detached or released session mints nothing.
    if (
      authority === undefined ||
      lease === undefined ||
      !lease.isActive() ||
      lease.officialSessionAuthority() !== authority
    ) {
      return undefined;
    }
    // (2) The machine must not have faulted. A fault means something is
    //     unresolved; nothing observed under it is attributable.
    if (
      this.machine === undefined ||
      this.machine.name === 'Fault' ||
      this.machine.authority !== authority
    ) {
      return undefined;
    }
    // (3) A stop that ended unsafely permanently disqualifies the session.
    if (this.stopSealed) {
      return undefined;
    }
    // (4) An attempt that was actually submitted, for a real output slot,
    //     and attributably acknowledged.
    if (
      pulse.attemptId === 0 ||
      pulse.motorNumber === undefined ||
      !pulse.submitted ||
      !pulse.acknowledged ||
      pulse.outcome?.kind !== 'ACKNOWLEDGED'
    ) {
      return undefined;
    }
    // (5) A completed, attributable, UNAMBIGUOUS stop - and one that
    //     belongs to THIS attempt, not merely some earlier stop.
    if (
      this.stopEpisodeAttemptId !== pulse.attemptId ||
      stop.episodeId === 0 ||
      !stop.commandAcknowledged ||
      stop.attributionAmbiguous ||
      stop.outcome?.kind !== 'ACKNOWLEDGED'
    ) {
      return undefined;
    }
    // (6) Nothing may still be in flight.
    if (this.stopInFlight !== undefined || this.pulseAttempt !== undefined) {
      return undefined;
    }

    return Object.freeze({
      sessionToken: authority,
      attemptId: pulse.attemptId,
      motorNumber: pulse.motorNumber,
      stopEpisodeId: stop.episodeId,
      pulseAcknowledged: true as const,
      stopAcknowledged: true as const,
      attributionAmbiguous: false as const,
      stopUnsafe: false as const,
      // Permanently false, here as everywhere else in this codebase.
      physicalStopConfirmed: false as const,
    });
  }

  /*
   * `runPulse` WAS HERE, AND ITS REMOVAL IS THE POINT OF P2-ii STEP 4.
   *
   * It awaited `lease.request(MSP_SET_MOTOR, payload, ...)` directly, which
   * made the legacy pulse a SECOND, independent motor-command authority
   * alongside the professional engine. Its two real jobs - attributing a
   * response to the live attempt by reference, and turning that into legacy
   * pulse state - now live in `onEngineCommandOutcome`, driven by the
   * engine's own dispatch. There is no longer any path from a legacy pulse
   * intent to a transport call that does not pass through
   * MotorControlCommandEngine.
   */

  /** Ends the live attempt and records why. Idempotent by reference: a
   * second call for an attempt that is no longer live does nothing. */
  private endPulseAttempt(outcome: MotorTestPulseOutcome): void {
    if (this.pulseAttempt === undefined) {
      return;
    }
    this.pulseAttempt = undefined;
    this.clearPulseDeadline();
    this.pulse = Object.freeze({
      ...this.pulse,
      motorNumber: this.pulse.motorNumber,
      outcome: this.pulse.outcome ?? outcome,
    });
  }

  /** Every pulse-side failure takes the stop route and lands in Fault. */
  private failPulseClosed(reason: MotorTestFaultReason): void {
    this.requestStop('STOP_BUTTON_PRESSED');
    this.dispatchFault(reason);
    this.publish();
  }

  private armPulseDeadline(attempt: object): void {
    this.clearPulseDeadline();
    this.pulseDeadlineTimer = setTimeout(() => {
      this.pulseDeadlineTimer = undefined;
      if (this.pulseAttempt !== attempt) {
        // A stale timer can never act on a newer attempt or a replacement
        // session - the reference test is the whole guard.
        return;
      }
      // The touch owner stopped proving liveness. This is an ordinary stop
      // reason, not a fault: the machine only faults if the stop itself
      // fails. A healthy held gesture keeps renewing this timer.
      this.requestStop('PULSE_DEADLINE_ELAPSED');
    }, MOTOR_TEST_HOLD_HEARTBEAT_TIMEOUT_MILLIS);
  }

  private clearPulseDeadline(): void {
    if (this.pulseDeadlineTimer !== undefined) {
      clearTimeout(this.pulseDeadlineTimer);
      this.pulseDeadlineTimer = undefined;
    }
  }

  close(): Promise<MotorTestControllerSnapshot> {
    if (this.teardownPromise !== undefined) {
      return this.teardownPromise;
    }
    // (1) Mark closing and invalidate synchronously - before the first
    // await, so no in-flight continuation can act after this point.
    this.closing = true;
    this.invalidateContinuations();
    // Phase 2G: the watchdog dies with the session, synchronously, before
    // the first await - a timer that outlived its controller could only
    // ever act on a session that no longer exists.
    this.clearPulseDeadline();
    this.endPulseAttempt({kind: 'FAILED', reason: 'STOP_DOMINATED'});
    this.phase = 'CLOSING';
    this.publish();
    return this.ensureTeardown();
  }

  private ensureTeardown(): Promise<MotorTestControllerSnapshot> {
    if (this.teardownPromise === undefined) {
      this.teardownPromise = this.runTeardown();
    }
    return this.teardownPromise;
  }

  /* --- session invalidation --------------------------------------- */

  private attachSessionListener(): void {
    if (this.unsubscribeSession !== undefined) {
      return;
    }
    this.unsubscribeSession = this.deps.session.subscribeSessionInvalidated(
      reason => {
        this.onSessionInvalidated(reason);
      },
    );
  }

  private onSessionInvalidated(
    reason: MotorTestSessionInvalidationReason,
  ): void {
    if (this.phase === 'CLOSED' || this.closing) {
      return;
    }
    // Synchronous invalidation first, exactly as for a stop - and the
    // PROFESSIONAL engine's own command generation with it, so a delayed
    // continuation created before this instant can never dispatch another
    // vector, and the coalesced pending vector is destroyed. No traffic
    // is issued here; teardown's canonical stop still attempts the real
    // all-stop if the old transport can legitimately carry one, and
    // records an honest non-stop if it cannot. Nothing fabricates an ACK.
    this.engine?.invalidateForSessionLoss(
      reason === 'SESSION_CHANGED' ? 'SESSION_ENDED' : 'TRANSPORT_LOST',
    );
    this.invalidateContinuations();
    this.closing = true;
    const faultReason: MotorTestFaultReason =
      reason === 'USB_DETACHED'
        ? 'USB_DETACHED'
        : reason === 'DESYNCHRONIZED'
          ? 'DESYNCHRONIZED'
          : 'SESSION_CHANGED';
    this.recordOutcome(this.setupStep, failure('SESSION_CHANGED', fault(faultReason)));
    this.phase = 'CLOSING';
    this.publish();
    // Stored, never discarded: a later close() returns this exact
    // operation rather than starting a second teardown.
    this.teardownPromise = this.ensureTeardown();
  }

  /* --- outcome recording ------------------------------------------ */

  private recordOutcome(
    step: MotorTestSetupStep,
    failed: SetupFailure,
  ): void {
    this.setupStep = step;
    // A terminal fault is never downgraded. A stale setup continuation
    // that resumes after a detach or a close has already lost its race,
    // and must not overwrite the fault that ended the session with its
    // own (milder) cancellation reason.
    if (this.outcome.kind === 'FAILED_CLOSED') {
      return;
    }
    if (failed.classification.disposition === 'FAULT') {
      this.dispatchFault(failed.classification.faultReason);
      this.outcome = Object.freeze({
        kind: 'FAILED_CLOSED' as const,
        reason: failed.reason,
        faultReason: failed.classification.faultReason,
        requiresNewSession: true as const,
      });
      return;
    }
    this.dispatchGates(false);
    this.outcome = Object.freeze({
      kind: 'BLOCKED' as const,
      reason: failed.reason,
      // Locked is terminal for THIS controller: it owns no re-check path,
      // because re-checking would mean re-acquiring a lease it has just
      // rolled back. A new controller is required either way.
      requiresNewSession: true,
    });
  }

  /* --- revalidation ------------------------------------------------ */

  /**
   * Steps 6 / 8 / 10 - the boundary check, run after EVERY await.
   *
   * Four independent facts, all required:
   *  - this continuation is still the live one (cancellation identity);
   *  - the composite identity still equals the one-time anchor, by value;
   *  - the lease is still the live owner (once one exists);
   *  - the lease still reports the SAME authority object, by identity.
   * A structurally identical clone fails the last check, which is exactly
   * why the anchor for steps 7-11 is a non-forgeable object.
   */
  /**
   * The cancellation half of `revalidate`, on its own.
   *
   * Used in a REJECTED-REQUEST catch, where the session half would lie: a
   * lease-scoped request that rejects has ALREADY faulted the lease
   * through Pass 2's own automatic route, so `lease.isActive()` is false
   * as a CONSEQUENCE of the rejection. Reporting that as "the session
   * changed" would hide a transport failure behind a session story. Both
   * fail closed; only the recorded reason differs, and it must be true.
   */
  private cancellation(generation: number): SetupFailure | undefined {
    if (this.isCurrent(generation)) {
      return undefined;
    }
    return failure(
      this.closing ? 'CONTROLLER_CANCELLED' : 'STOP_REQUESTED_DURING_SETUP',
      LOCK,
    );
  }

  private revalidate(generation: number): SetupFailure | undefined {
    const cancelled = this.cancellation(generation);
    if (cancelled !== undefined) {
      return cancelled;
    }
    const anchor = this.anchorIdentity;
    if (anchor === undefined) {
      return failure('SESSION_IDENTITY_UNAVAILABLE', fault('SESSION_CHANGED'));
    }
    let current: MspSessionCompositeIdentity | undefined;
    try {
      current = this.deps.session.readCurrentIdentity();
    } catch {
      return failure('UNEXPECTED_SERVICE_EXCEPTION', fault('NATIVE_EXCEPTION'));
    }
    if (!mspSessionCompositeIdentitiesMatch(current, anchor)) {
      return failure('SESSION_CHANGED', fault('SESSION_CHANGED'));
    }
    const lease = this.lease;
    if (lease !== undefined) {
      if (!lease.isActive()) {
        return failure('SESSION_CHANGED', fault('SESSION_CHANGED'));
      }
      if (lease.officialSessionAuthority() !== this.authority) {
        return failure('SESSION_CHANGED', fault('AUTHORITY_MISMATCH'));
      }
    }
    return undefined;
  }

  /* --- setup ------------------------------------------------------- */

  /**
   * Joins the coordinator's one identification attempt for this physical
   * session. The subscription is installed before the second read, closing
   * the read/subscribe race; a replacement/detach and a bounded timeout both
   * settle the wait without manufacturing identity evidence.
   */
  private awaitFirmwareIdentity(
    generation: number,
  ): Promise<FirmwareIdentityAcquisition | SetupFailure> {
    const session = this.deps.session;
    const read = ():
      | FirmwareIdentityAcquisition
      | SetupFailure
      | undefined => {
      const cancelled = this.cancellation(generation);
      if (cancelled !== undefined) {
        return cancelled;
      }
      let state: MotorTestFirmwareIdentificationState;
      try {
        state = session.readFirmwareIdentification();
      } catch {
        return failure(
          'UNEXPECTED_SERVICE_EXCEPTION',
          fault('NATIVE_EXCEPTION'),
        );
      }
      switch (state.status) {
        case 'SUCCEEDED':
          return {identity: state.identity};
        case 'FAILED':
          return failure('FIRMWARE_IDENTITY_UNAVAILABLE', LOCK);
        case 'IDLE':
        case 'RUNNING':
          return undefined;
        default:
          return assertExhaustiveIdentificationState(state);
      }
    };

    const immediate = read();
    if (immediate !== undefined) {
      return Promise.resolve(immediate);
    }

    return new Promise(resolve => {
      let settled = false;
      let unsubscribeIdentification: MotorTestControllerUnsubscribe =
        () => undefined;
      let unsubscribeInvalidation: MotorTestControllerUnsubscribe =
        () => undefined;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

      const finish = (result: FirmwareIdentityAcquisition | SetupFailure) => {
        if (settled) {
          return;
        }
        settled = true;
        unsubscribeIdentification();
        unsubscribeInvalidation();
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
        }
        resolve(result);
      };
      const examine = () => {
        const result = read();
        if (result !== undefined) {
          finish(result);
        }
      };

      try {
        const identificationUnsubscribe =
          session.subscribeFirmwareIdentification(examine);
        // A valid implementation may publish the current value while the
        // listener is being registered. `finish()` then runs before the
        // returned unsubscriber can be assigned, so release it explicitly.
        if (settled) {
          identificationUnsubscribe();
          return;
        }
        unsubscribeIdentification = identificationUnsubscribe;

        const invalidationUnsubscribe =
          session.subscribeSessionInvalidated(() => {
            finish(failure('SESSION_CHANGED', fault('SESSION_CHANGED')));
          });
        if (settled) {
          invalidationUnsubscribe();
          unsubscribeIdentification();
          return;
        }
        unsubscribeInvalidation = invalidationUnsubscribe;

        timeoutHandle = setTimeout(() => {
          finish(failure('FIRMWARE_IDENTITY_UNAVAILABLE', LOCK));
        }, MOTOR_TEST_FIRMWARE_IDENTIFICATION_TIMEOUT_MILLIS);
        const unref = (
          timeoutHandle as unknown as {readonly unref?: () => void}
        ).unref;
        unref?.call(timeoutHandle);

        // Closes the transition that may have happened after the first read
        // and before the subscriptions were installed.
        examine();
      } catch {
        finish(
          failure(
            'UNEXPECTED_SERVICE_EXCEPTION',
            fault('NATIVE_EXCEPTION'),
          ),
        );
      }
    });
  }

  private async runSetup(): Promise<MotorTestControllerSnapshot> {
    // (2) Establish the controller cancellation/generation identity.
    this.invalidateContinuations();
    const generation = this.generation;
    this.phase = 'PREPARING';

    let failed: SetupFailure | undefined;
    try {
      failed = await this.runSetupSteps(generation);
    } catch {
      // An accepted service threw where its contract says it returns.
      failed = failure(
        'UNEXPECTED_SERVICE_EXCEPTION',
        fault('NATIVE_EXCEPTION'),
      );
    }

    this.setupSettled = true;
    if (failed === undefined) {
      this.publish();
      return this.snapshot;
    }

    this.recordOutcome(this.setupStep, failed);
    this.publish();
    // Partial acquisition rolls back in reverse order - the same seven
    // teardown steps, not a second, looser cleanup path.
    await this.ensureTeardown();
    return this.snapshot;
  }

  private async runSetupSteps(
    generation: number,
  ): Promise<SetupFailure | undefined> {
    const session = this.deps.session;

    // ---- (1) Capture the composite session anchor exactly once. -----
    this.setupStep = 'SESSION_ANCHOR';
    let anchor: MspSessionCompositeIdentity | undefined;
    try {
      anchor = session.readCurrentIdentity();
    } catch {
      return failure('UNEXPECTED_SERVICE_EXCEPTION', fault('NATIVE_EXCEPTION'));
    }
    if (anchor === undefined) {
      return failure('SESSION_IDENTITY_UNAVAILABLE', LOCK);
    }
    const anchorIdentity = copyIdentity(anchor);
    this.anchorIdentity = anchorIdentity;

    // Genuine interruption sources are wired BEFORE the first await, so a
    // detach during the barrier cannot be missed.
    this.attachSessionListener();
    this.publish();

    // ---- (2) Identify the exact reviewed firmware adapter. ----------
    // Generic MSP compatibility is not enough for a write: another
    // firmware can return payloads that happen to decode while assigning
    // different semantics to command 214 or to protocol enum values.
    this.setupStep = 'FIRMWARE_COMPATIBILITY';
    this.publish();
    const firmware = await this.awaitFirmwareIdentity(generation);
    if (isFailure(firmware)) {
      return firmware;
    }
    const afterIdentification = this.revalidate(generation);
    if (afterIdentification !== undefined) {
      return afterIdentification;
    }
    const firmwareCompatibility = resolveMotorFirmwareCompatibility(
      firmware.identity,
    );
    this.firmwareCompatibility = firmwareCompatibility;
    this.publish();
    if (
      !motorFirmwareSupports(
        firmwareCompatibility,
        'MOTOR_TEST_WRITE',
      )
    ) {
      return failure('FIRMWARE_UNSUPPORTED', LOCK);
    }

    // ---- (3)(4)(5) The coordinator-wide barrier. --------------------
    // One accepted call performs all three in the required order: it
    // closes the registration gate first, then takes a pause lease on
    // every registered scheduler synchronously, then awaits deterministic
    // quiescence. See motorTestTelemetryBarrier.acquireBarrier().
    //
    // CORRECTION B-1. The client is passed so the registry can prove, by
    // REFERENCE, that the telemetry anchor belongs to the very client this
    // controller is about to lease. Without it, a barrier held over
    // session A's schedulers could sit alongside a lease on client B, and
    // `telemetryHeld: true` would be a true statement about the wrong
    // link. The registry checks this before it closes its gate or takes
    // any pause lease, so a mismatch pauses nothing and leaks no token.
    this.setupStep = 'TELEMETRY_BARRIER';
    const acquisition = await this.deps.telemetryRegistry.acquireBarrier(
      this.deps.telemetrySession,
      session.client,
    );
    if (acquisition.kind !== 'ACQUIRED') {
      switch (acquisition.reason) {
        case 'SESSION_UNKNOWN':
          return failure('TELEMETRY_SESSION_UNKNOWN', LOCK);
        case 'SESSION_CLIENT_MISMATCH':
          // A wiring integrity violation, not an evidence problem. Nothing
          // was written, no lease exists, no request was sent and no
          // telemetry was paused, so this locks rather than claiming the
          // uncertainty a fault would assert. It is terminal for this
          // controller all the same: `requiresNewSession` is always true.
          return failure('TELEMETRY_SESSION_CLIENT_MISMATCH', LOCK);
        case 'SESSION_REPLACED':
          return failure(
            'TELEMETRY_SESSION_REPLACED',
            fault('SESSION_CHANGED'),
          );
        case 'QUIESCENCE_TIMEOUT':
          // A link that will not fall quiet is transport uncertainty.
          return failure(
            'TELEMETRY_QUIESCENCE_TIMEOUT',
            fault('MSP_RESPONSE_TIMEOUT'),
          );
        default:
          assertExhaustiveReason(acquisition.reason);
          return failure(
            'TELEMETRY_QUIESCENCE_TIMEOUT',
            fault('NATIVE_EXCEPTION'),
          );
      }
    }
    // A close or a safety signal may have landed WHILE the barrier was
    // being acquired. Nothing else has been acquired yet, so releasing
    // this one token IS the complete reverse-order rollback - and doing
    // it here is what guarantees the barrier can never outlive a teardown
    // that has already run.
    if (this.closing || !this.isCurrent(generation)) {
      acquisition.release();
      return failure(
        this.closing ? 'CONTROLLER_CANCELLED' : 'STOP_REQUESTED_DURING_SETUP',
        LOCK,
      );
    }
    this.barrier = acquisition;
    this.publish();

    // ---- (6) Revalidate anchor + cancellation identity. -------------
    // From here on the lease is acquired SYNCHRONOUSLY after this check,
    // with no await in between, so a lease can never be taken after a
    // close either.
    this.setupStep = 'POST_BARRIER_REVALIDATION';
    const afterBarrier = this.revalidate(generation);
    if (afterBarrier !== undefined) {
      return afterBarrier;
    }

    // ---- (7) The genuine lease, from its official issuer. -----------
    this.setupStep = 'LEASE_ACQUISITION';
    const leaseAcquisition = acquireMotorTestLease({
      client: session.client,
      requestedIdentity: anchorIdentity,
      readCurrentIdentity: () => session.readCurrentIdentity(),
    });
    if (leaseAcquisition.kind !== 'ACQUIRED') {
      return failure(
        'LEASE_NOT_ACQUIRED',
        classifyLeaseFailure(leaseAcquisition.reason),
      );
    }
    const lease = leaseAcquisition.lease;
    this.lease = lease;

    // ---- (7b) Capture the official authority exactly once. ----------
    // Synchronous, immediately after acquisition, before any await. See
    // this file's header for why this cannot happen at step 1.
    this.setupStep = 'AUTHORITY_CAPTURE';
    const authority = lease.officialSessionAuthority();
    if (authority === undefined) {
      return failure(
        'OFFICIAL_AUTHORITY_UNAVAILABLE',
        fault('AUTHORITY_MISMATCH'),
      );
    }
    this.authority = authority;
    this.machine = createMotorTestState(authority);
    this.phase = 'ACTIVE';
    this.publish();

    // ---- (8) Revalidate authority + lease. --------------------------
    this.setupStep = 'POST_LEASE_REVALIDATION';
    const afterLease = this.revalidate(generation);
    if (afterLease !== undefined) {
      return afterLease;
    }

    // ---- (9) The minimal evidence, the monitor, the first observation.
    return this.runBenchSteps(generation, anchorIdentity, lease);
  }

  /**
   * Steps 7 to 11 of the simplified sequence.
   *
   * WHAT IT NO LONGER DOES, and why each removal is safe:
   *   - a second four-command identification chain inside this exclusive
   *     lease. Firmware identity is mandatory again, but it is joined from
   *     the coordinator's canonical identification attempt before the
   *     telemetry barrier; it is not re-requested here;
   *   - MSP_MIXER_CONFIG and the composed capability profile. Mixer mode
   *     and the props-out flag never entered the vector builder;
   *   - the Pass 1E battery policy. It is no longer read at all, and this
   *     module makes no claim about the pack - see the file header;
   *   - the arming restriction: one MSP WRITE (command 99), its receipt,
   *     and the receipt's currentness as an activation gate. The receipt
   *     could not re-read the flight controller, so it could never detect
   *     its own removal - it proved the lease was alive, which the lease
   *     already proves. What replaces it is stronger: a repeated LIVE read
   *     of the armed state itself.
   *
   * WHAT IT STILL PROVES, in order: motor scope with 3D disabled, the box
   * mapping, and one fresh disarmed observation - AWAITED before READY.
   */
  private async runBenchSteps(
    generation: number,
    anchor: MspSessionCompositeIdentity,
    lease: MotorTestLease,
  ): Promise<SetupFailure | undefined> {
    const session = this.deps.session;
    const readCurrentIdentity = () => session.readCurrentIdentity();
    const expectedIdentity = asFactsIdentity(anchor);

    // ---- (7) Only the configuration the encoder needs. ---------------
    this.setupStep = 'MOTOR_CONFIGURATION';
    const scopeRead = await this.readMotorScope(generation, lease);
    if (isFailure(scopeRead)) {
      return scopeRead;
    }
    // Retained BEFORE the guard runs, so a refusal can still say which
    // configuration was refused. See the field's own comment.
    this.motorScope = scopeRead.scope;
    this.motorDiagnosticsSupport = scopeRead.diagnosticsSupport;
    // P2-ii-A. Retained whatever the legacy guard decides below: a
    // configuration the shipping pulse path refuses may still be one the
    // professional path could describe, and a refusal must be able to say
    // WHICH domain it refused.
    this.motorDomain = scopeRead.domain;
    this.motorRuntimeScope = scopeRead.runtimeScope;
    if (!hasEscTelemetrySource(scopeRead.diagnosticsSupport)) {
      this.diagnostics = Object.freeze({
        ...this.diagnostics,
        escTelemetry: Object.freeze({
          state: 'NOT_ENABLED' as const,
          value: undefined,
          observedAtMillis: this.deps.readMonotonicMillis(),
        }),
      });
    }
    this.publish();
    /* ---- M-C: ONE ELIGIBILITY, NOT TWO. ------------------------------
     *
     * P2 ran two rules at once: a professional one driven by the resolved
     * domain, and a legacy one that demanded exactly four motors, the
     * DShot family and no 3D. The session proceeded if EITHER passed,
     * while `pulseMotor` was governed by the legacy rule alone - so a hex
     * could open a session it could never use, and a digital-3D quad was
     * refused a pulse the professional path could prove safe.
     *
     * There is now ONE rule, `evaluateMotorCommandScope`, and it is the
     * same object the activation gate re-runs on every evaluation. The
     * strict half of the old rule survives intact: analog 3D is still
     * refused by name, an unresolvable protocol is still refused, and the
     * refusal still LOCKS with complete decoded evidence and nothing
     * written rather than claiming the ambiguity a fault would assert.
     * What is gone is the count restriction, which was never a firmware
     * fact, and the 3D blanket, which refused a case that is fully
     * knowable.
     */
    const scopeRefusals = evaluateMotorCommandScope(
      scopeRead.scope,
      scopeRead.runtimeScope,
    );
    if (scopeRefusals.length > 0) {
      return failure(scopeRefusals[0], LOCK);
    }
    // The configuration this session is bound to, captured the instant it
    // is first proven usable. From here on a disagreeing read fails the
    // activation gate rather than silently re-scoping the session.
    this.topologyBinding = Object.freeze({
      motorCount: scopeRead.scope.motorCount,
      motorProtocolRaw: scopeRead.scope.motorProtocolRaw,
      feature3dEnabled: scopeRead.scope.feature3dEnabled,
      stopValue: scopeRead.domain?.stopValue ?? Number.NaN,
    });

    // ---- (8) Only the BOX evidence armed state needs. ----------------
    this.setupStep = 'ARMED_STATE_EVIDENCE';
    const boxAcquisition = await acquireMotorTestBoxIds(lease);
    // A typed failure from an accepted module is more specific than the
    // generic boundary check and is therefore consulted FIRST - a rejected
    // request has already faulted the lease, and the boundary check would
    // attribute that to a session change.
    let boundary = this.cancellation(generation);
    if (boundary !== undefined) {
      return boundary;
    }
    if (boxAcquisition.kind !== 'ACQUIRED') {
      return failure(
        'BOX_EVIDENCE_UNAVAILABLE',
        classifyBoxIdsFailure(boxAcquisition.reason),
      );
    }
    boundary = this.revalidate(generation);
    if (boundary !== undefined) {
      return boundary;
    }
    this.boxIds = boxAcquisition.snapshot;

    // ---- (9) The monitor, on THE SAME LEASE. -------------------------
    //
    // One requester for the whole bundle: configuration reads, the box
    // read, every observation, every motor command and every emergency
    // stop all travel this one lease and therefore one serialized FIFO.
    // Nothing here constructs a second client, transport, queue or writer.
    this.setupStep = 'SAFETY_MONITOR';
    const createSafetyMonitor: MotorTestSafetyMonitorFactory =
      this.deps.createSafetyMonitor ??
      (options => new MotorTestSafetyMonitor(options));
    const monitor = createSafetyMonitor({
      requester: lease,
      expectedIdentity,
      boxIdPermanentIds: boxAcquisition.snapshot.permanentIds,
      readCurrentIdentity,
      readMonotonicMillis: this.deps.readMonotonicMillis,
      onUnsafe: reason => this.onSafetyMonitorUnsafe(reason),
      setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: handle =>
        clearTimeout(handle as ReturnType<typeof setTimeout>),
      intervalMillis: MOTOR_TEST_SAFETY_OBSERVATION_INTERVAL_MILLIS,
    });
    this.safetyMonitor = monitor;
    monitor.start();
    this.publish();

    // ---- (10) ONE FRESH DISARMED OBSERVATION, AWAITED. ---------------
    //
    // THE DEFECT THIS CLOSES, recorded so it is never re-introduced. The
    // monitor used to be started here and READY published on the very next
    // line. `start()` is fire-and-forget by design, so the published
    // snapshot said "nothing is watching" while the first observation was
    // still on the wire, and it only became READY when some UNRELATED
    // render happened to rebuild the snapshot. The operator saw a control
    // that was disabled for a reason that had already stopped being true.
    //
    // Joining the monitor's own first observation is what makes the
    // boundary deterministic. It is not a delay, a poll or a retry: it
    // resolves exactly when a real production observation publishes.
    this.setupStep = 'FIRST_OBSERVATION';
    // Published BEFORE the await, so a subscriber watching a slow bring-up
    // can see which step it is parked on rather than a step that already
    // finished.
    this.publish();
    await monitor.observeNow();

    // THE OBSERVATION'S OWN VERDICT IS CONSULTED FIRST, and the ordering
    // is load-bearing rather than stylistic - the same rule the box and
    // configuration reads already follow.
    //
    // An armed or failed reading calls `onUnsafe`, which routes into
    // `requestStop`, which invalidates pending setup continuations
    // SYNCHRONOUSLY. So by the time control returns here the generic
    // boundary check would report STOP_REQUESTED_DURING_SETUP and bury the
    // real cause - the operator would be told the bring-up was cancelled
    // when in truth their flight controller was armed.
    //
    // Both fail closed; only the recorded reason differs, and it must be
    // true. The boundary check still runs, immediately below.
    const evidence = this.readArmedStateEvidence();
    if (evidence === 'FC_ARMED') {
      // A complete, trustworthy reading that says the aircraft is armed.
      // Nothing is uncertain; this is a refusal, not a fault.
      return failure('FIRST_OBSERVATION_NOT_DISARMED', LOCK);
    }
    if (evidence !== 'FRESH_DISARMED') {
      const status = monitor.snapshot().status;
      return failure(
        'FIRST_OBSERVATION_UNAVAILABLE',
        // A read that failed is transport uncertainty and must fail
        // closed. A reading that merely never became fresh had no
        // uncertain side effect and locks.
        status.kind === 'FAILED' ? fault('MSP_RESPONSE_TIMEOUT') : LOCK,
      );
    }

    boundary = this.revalidate(generation);
    if (boundary !== undefined) {
      return boundary;
    }

    // ---- (10b) P2-ii: THE FC-SIDE ARMING RESTRICTION, RESTORED. -------
    //
    // WHY IT IS BACK. An earlier pass removed this write, correctly
    // observing that its receipt could never detect its own removal - it
    // proved the lease was alive, which the lease already proved. What was
    // NOT true is the implied conclusion that the write itself bought
    // nothing: the receipt is weak evidence, but the restriction is a real
    // effect on the flight controller, and it is the only thing standing
    // between a commanded output and an aircraft that could be armed
    // underneath it. Continuous armed-state observation DETECTS that
    // condition; the restriction PREVENTS it. They are complements, and
    // this pass keeps both.
    //
    // ORDER IS LOAD-BEARING AND IS PROVEN, NOT ASSUMED. It is established
    // AFTER the flight controller has been proven disarmed - restricting
    // arming on an aircraft that is already armed would be a false comfort
    // - and BEFORE READY is published, so no snapshot can ever report a
    // commandable session whose restriction is not in force.
    //
    // POLARITY IS NOT INFERRED FROM THE NAME. Command 99 with payload [1]
    // ESTABLISHES the restriction; [0] releases this descriptor's hold.
    // Proven at 79065c96 in motorArmingRestriction.ts, which owns the
    // encoding - nothing is duplicated here.
    this.setupStep = 'ARMING_RESTRICTION';
    this.publish();
    const restriction = await establishMotorArmingRestriction({
      lease,
      requestedIdentity: anchor,
      readCurrentIdentity,
      boxIds: boxAcquisition.snapshot,
    });
    // THE ESTABLISHMENT'S OWN VERDICT IS CONSULTED FIRST, and the ordering
    // is load-bearing rather than stylistic - the same rule the first
    // observation already follows. A rejected command-99 request FAULTS
    // the lease, so the generic boundary check would report SESSION_CHANGED
    // and bury the real cause: the operator would be told their session was
    // replaced when in truth their flight controller refused the
    // restriction. Both fail closed; only the recorded reason differs, and
    // it must be true. The boundary check still runs, immediately below.
    if (restriction.kind !== 'ESTABLISHED') {
      // Command 99 may have reached the wire, so this is uncertainty
      // rather than a clean refusal, and it must fail closed. The
      // restriction is deliberately NOT "released to tidy up": a release
      // issued into an unknown state is a second write with an unknown
      // outcome, and teardown handles it under its own contract.
      this.armingRestrictionEstablished = false;
      return failure(
        'ARMING_RESTRICTION_NOT_ESTABLISHED',
        fault('WRITE_OUTCOME_UNKNOWN'),
      );
    }
    boundary = this.revalidate(generation);
    if (boundary !== undefined) {
      // The restriction succeeded but the session moved underneath it. It
      // is recorded as established anyway, so teardown still knows a
      // release is owed rather than silently abandoning it on the FC.
      this.armingRestrictionEstablished = true;
      this.armingRestrictionReceipt = restriction.receipt;
      return boundary;
    }
    // Recorded so teardown knows a release is OWED. Nothing else consults
    // it as a safety gate - the live armed-state read remains the gate.
    this.armingRestrictionEstablished = true;
    this.armingRestrictionReceipt = restriction.receipt;
    this.publish();

    // ---- (10c) THE ONE SESSION-SCOPED PROFESSIONAL ENGINE. -----------
    //
    // Constructed EXACTLY ONCE per session, from the exact official
    // authority, the exact lease, and the P1 domain resolved from this
    // session's own reads. It starts at the domain's all-stop vector and
    // in the reducer's `EnabledIdle` phase - never `EnabledCommanding` -
    // because the enable flow sends no active value.
    //
    // From this instant it is the SINGLE authority for MSP_SET_MOTOR:
    // `pulseMotor` and every professional operation route through it, and
    // the legacy reducer can no longer authorize a write on its own.
    const engineAuthority = this.authority;
    if (
      engineAuthority !== undefined &&
      runtimeScopeEligible(this.motorRuntimeScope) &&
      this.motorDomain
    ) {
      this.engine = new MotorControlCommandEngine({
        lease,
        authority: engineAuthority,
        domain: this.motorDomain,
        requestOptions: READ_REQUEST_OPTIONS,
        readArmedStateEvidence: () => this.readArmedStateEvidence(),
        suspendSafetyMonitor: () => {
          this.safetyMonitor?.stop();
        },
        publish: () => this.publish(),
        onFault: reason => {
          this.dispatchFault(mapEngineFaultToLegacy(reason));
        },
        onCommandOutcome: outcome => this.onEngineCommandOutcome(outcome),
      });
      this.engine.markEnabled();
    }

    // ---- (11) Ready - every mandatory fact valid for one authority. --
    //
    // Reached only with the first observation already published, so the
    // snapshot built by the caller's `publish()` carries `allowed: true`
    // immediately. Every subsequent observation continues on the same
    // lease; an armed reading, a stale one, a rejected request, a
    // malformed response, a session replacement or a monitoring failure
    // all route into `onSafetyMonitorUnsafe` and from there into the
    // existing stop/fault behaviour.
    this.setupStep = 'READY';
    this.dispatchGates(true);
    this.outcome = Object.freeze({kind: 'READY' as const});
    return undefined;
  }

  /**
   * Step 7 - the three reads the command encoder actually depends on.
   *
   * MSP_MOTOR_CONFIG    offset 6  -> motor count, the ONLY authority for it
   * MSP_ADVANCED_CONFIG offset 3  -> raw motorProtocolTypes_e
   * MSP_FEATURE_CONFIG  bit 12    -> FEATURE_3D, the ONLY authority for it
   *
   * Every one travels the lease and therefore the canonical FIFO. A
   * REJECTED REQUEST and a MALFORMED RESPONSE are separated deliberately:
   * the first is transport uncertainty and must fail closed, the second is
   * complete-but-unusable evidence and locks.
   */
  private async readMotorScope(
    generation: number,
    lease: MotorTestLease,
  ): Promise<
    | {
        readonly scope: MotorVectorScope;
        readonly diagnosticsSupport: MotorDiagnosticsSupport;
        /** P2-ii-A: the P1 domain, resolved from these same reads. */
        readonly domain: MotorTestValueDomain | undefined;
        readonly runtimeScope: MotorControlRuntimeScope | undefined;
      }
    | SetupFailure
  > {
    const motor = await this.readDecoded(
      generation,
      lease,
      MSP_MOTOR_CONFIG,
      decodeMotorConfig,
    );
    if (isFailure(motor)) {
      return motor;
    }
    const advanced = await this.readDecoded(
      generation,
      lease,
      MSP_ADVANCED_CONFIG,
      decodeAdvancedConfig,
    );
    if (isFailure(advanced)) {
      return advanced;
    }
    const feature = await this.readDecoded(
      generation,
      lease,
      MSP_FEATURE_CONFIG,
      decodeFeatureConfig,
    );
    if (isFailure(feature)) {
      return feature;
    }

    // ---- P2-ii-A: MSP_MOTOR_3D_CONFIG, read only where it is USED. ----
    //
    // The three reads above cannot resolve a 3D domain on their own:
    // `resolveMotorTestValueDomain` requires deadband3d_low/high and
    // neutral3d when FEATURE_3D is on, and inventing them would mean
    // commanding a reversible aircraft against a guessed forward/reverse
    // split. So the request is made EXACTLY when FEATURE_3D is enabled and
    // its result feeds domain resolution directly - it is never issued as
    // an unused fourth request, and a non-3D bring-up sends no extra frame
    // at all, which is what keeps the shipping enable byte stream
    // unchanged for every configuration the current product supports.
    const scope = Object.freeze({
      motorCount: motor.value.motorCount,
      motorProtocolRaw: advanced.value.motorProtocolRaw,
      feature3dEnabled: feature.value.feature3dEnabled,
    });

    let motor3d: {
      readonly deadband3dLow: number;
      readonly deadband3dHigh: number;
      readonly neutral3d: number;
    } | undefined;
    // P2 CLOSURE: the read fires WHENEVER FEATURE_3D is on, because the
    // professional runtime - not the legacy pulse UI - is now what decides
    // whether a 3D session may proceed, and 3D domain resolution REQUIRES
    // deadband3d/neutral3d. A digital-3D aircraft resolves a full domain
    // and becomes professionally commandable; an analog-3D aircraft
    // resolves a domain the runtime then REFUSES (its active endpoints are
    // not on the wire at API 1.47). Either way the result participates in
    // domain resolution - it is never a decorative request. Every API-1.47
    // flight controller answers command 124; a link that rejects it is
    // genuinely faulting, and reporting that as transport trouble is
    // truthful.
    if (feature.value.feature3dEnabled) {
      const read3d = await this.readDecoded(
        generation,
        lease,
        MSP_MOTOR_3D_CONFIG,
        decodeMotor3dConfig,
      );
      if (isFailure(read3d)) {
        return read3d;
      }
      motor3d = read3d.value;
    }

    const boundary = this.revalidate(generation);
    if (boundary !== undefined) {
      return boundary;
    }

    // The resolver REFUSES rather than approximating an unknown protocol
    // family, so a configuration it cannot describe leaves both fields
    // undefined and the professional path simply never becomes eligible.
    // The legacy scope guard below is unaffected and still decides the
    // shipping pulse path on its own terms.
    let domain: MotorTestValueDomain | undefined;
    let runtimeScope: MotorControlRuntimeScope | undefined;
    try {
      domain = resolveMotorTestValueDomain({
        motorCount: motor.value.motorCount,
        motorProtocolRaw: advanced.value.motorProtocolRaw,
        feature3dEnabled: feature.value.feature3dEnabled,
        minCommand: motor.value.minCommand,
        maxThrottle: motor.value.maxThrottle,
        motor3d,
      });
      runtimeScope = classifyMotorControlRuntimeScope(domain);
    } catch {
      domain = undefined;
      runtimeScope = undefined;
    }

    return {
      scope,
      diagnosticsSupport: deriveMotorDiagnosticsSupport(motor.value),
      domain,
      runtimeScope,
    };
  }

  /** One accepted read: request through the lease, revalidate, decode. */
  private async readDecoded<T>(
    generation: number,
    lease: MotorTestLease,
    command: number,
    decode: (payload: Uint8Array) => T,
  ): Promise<{readonly value: T} | SetupFailure> {
    let payload: Uint8Array;
    try {
      const frame = await lease.request(
        command,
        EMPTY_PAYLOAD,
        READ_REQUEST_OPTIONS,
      );
      payload = frame.payload;
    } catch {
      const cancelled = this.cancellation(generation);
      if (cancelled !== undefined) {
        return cancelled;
      }
      return failure(
        'MOTOR_CONFIG_REQUEST_FAILED',
        fault('MSP_RESPONSE_TIMEOUT'),
      );
    }
    const boundary = this.revalidate(generation);
    if (boundary !== undefined) {
      return boundary;
    }
    try {
      return {value: decode(payload)};
    } catch {
      return failure('MOTOR_CONFIG_MALFORMED', LOCK);
    }
  }

  /* --- Phase 2F: the command-214 stop executor --------------------- */

  /**
   * Requests the all-stop vector through THIS controller's private lease.
   *
   * Reuses the accepted protected modules unchanged:
   *   assertSupportedMotorScope -> buildAllStopVector -> encodeSetMotorPayload
   * producing exactly four little-endian uint16 values, eight bytes,
   * `E8 03 E8 03 E8 03 E8 03`.
   *
   * JOINS ONE OPERATION. Concurrent callers await the same promise, so
   * repeated stop triggers never become a second command-214 request.
   *
   * FAILS CLOSED. A missing lease, a missing scope, an unsupported scope,
   * an authority that moved across the await, a rejected request or a
   * thrown exception all produce a non-acknowledged outcome; none of them
   * is ever reported as a stop.
   *
   * TIMING IS THE CLIENT'S. The request travels the existing serialized
   * FIFO under the client's own two-phase bound, so this never waits
   * indefinitely and never opens a parallel write path.
   */
  private executeStopVector(): Promise<MotorTestStopExecutionOutcome> {
    // (a) JOIN, scoped to ONE episode. Concurrent and repeated triggers
    //     for the same live pulse share exactly one registration and
    //     therefore exactly one command-214 write. The registration is
    //     cleared only when that operation reaches a terminal outcome, so
    //     a stale callback can never replace a stop still in flight.
    const existing = this.stopInFlight;
    if (existing !== undefined) {
      return existing;
    }
    // (b) SEALED. A stop that already ended unsafely can never be
    //     rearmed - re-running it would put a second command on the wire
    //     while the first one's outcome is still unknown, and would let a
    //     failed session look recoverable. Only a full session reset may
    //     follow. The previous terminal outcome is replayed unchanged.
    if (this.stopSealed) {
      return Promise.resolve(
        this.stopExecution.outcome ?? {kind: 'FAILED', reason: 'REQUEST_FAILED'},
      );
    }
    // (c) A genuinely NEW episode. A later pulse can never reuse an
    //     earlier pulse's settled promise or its record.
    this.stopEpisodeId += 1;
    // Captured BEFORE the operation runs, so the episode is bound to the
    // attempt that was live when the stop was demanded.
    this.stopEpisodeAttemptId = this.pulse.attemptId;
    this.stopTriggerForEpisode = this.lastStopTrigger;
    const started = this.runStopVector();
    this.stopInFlight = started;
    return started
      .then(outcome => {
        // Phase 2I: the registration is cleared BEFORE the publish below,
        // not after it. A `.finally` would run after `publish()`, so the
        // snapshot every consumer caches would still report a stop in
        // flight - and the verification receipt, which requires nothing
        // outstanding, would never appear even for a perfectly clean
        // episode.
        this.stopInFlight = undefined;
        // Once a pulse may have reached the FC, ANY outcome that is not an
        // attributable acknowledgement is unsafe - including "we never
        // even attempted it". Before any pulse exists, only a genuine
        // failure is (the Phase 2F rule, unchanged, so a pre-evidence
        // BLOCKED session still reports its own specific cause).
        const unsafe = this.pulseMayHaveReachedFc
          ? outcome.kind !== 'ACKNOWLEDGED'
          : outcome.kind === 'FAILED';
        if (unsafe) {
          // SEALED. No rearm is possible, ever - only a full session
          // reset. The controller faults immediately rather than waiting
          // for teardown, so a live screen cannot keep presenting a
          // session whose stop is unproven.
          this.stopSealed = true;
          this.dispatchFault('STOP_FAILED');
        } else if (outcome.kind === 'ACKNOWLEDGED') {
          // CORRECTION (2) - THE STOP IS REPORTED TO THE REDUCER.
          //
          // THE DEFECT THIS CLOSES. Nothing in this file had ever
          // constructed `STOP_ACKNOWLEDGED`, so the accepted machine could
          // not leave `Stopping` even after a perfect, fully attributable
          // all-stop. `READY -> pulse -> release -> READY` was therefore
          // structurally impossible: the operator was left in `Stopping`
          // forever and a second motor needed a whole new session.
          //
          // The reducer - not this controller - decides where a confirmed
          // stop lands, from the disposition the ORIGINAL trigger carried:
          // `Ready` for a release, a selection change or the deadline;
          // `Locked` for anything that invalidated a precondition. So a
          // safety stop is not quietly turned into a recoverable one by
          // this call.
          this.dispatchStopAcknowledged();
        }
        // ALWAYS publish. A stop that completes outside teardown - the
        // interactive case, which is every release, deadline and safety
        // event - updates the stop record asynchronously, and a subscriber
        // that never sees it cannot report what actually happened.
        this.publish();
        // Monitoring was suspended before the stop was registered, so a
        // session that is genuinely alive again has to be given a fresh
        // reading before it can activate anything. Fire-and-forget on
        // purpose: nothing may gate a stop's own completion on a read.
        this.resumeMonitoringAfterStop();
        return outcome;
      })
      .catch((error: unknown) => {
        // runStopVector returns typed outcomes for expected failures, so
        // this is only reachable if it throws unexpectedly. The
        // registration must still be released, or the lease could never
        // be released and no later stop could ever be registered.
        this.stopInFlight = undefined;
        this.stopSealed = true;
        this.publish();
        throw error;
      });
  }

  /**
   * P2-ii - THE STOP, DELEGATED TO THE ONE COMMAND AUTHORITY.
   *
   * WHAT THIS REPLACED. This method used to own a complete second stop
   * implementation: its own all-stop encoding, its own
   * `lease.emergencyStop(...)`, its own ambiguity counting argument, its
   * own confirmation stop and its own settle bookkeeping. The professional
   * engine owns every one of those, so keeping both meant TWO stop
   * authorities - the duplication P2-ii exists to remove.
   *
   * WHAT REMAINS IS PROJECTION, NOT AUTHORITY. The engine performs the
   * stop and reports semantic attribution facts it alone can observe
   * (`deferredBehindActiveWrite` and `attributionAmbiguous` come from the
   * lease AT REGISTRATION TIME and are gone by the time a frame settles).
   * `projectStopOutcomeToLegacyRecord` - pure, and proven on its own
   * before this routing existed - turns that into the legacy record.
   *
   * THE EPISODE IDENTITY IS ALREADY BOUND. `executeStopVector` captured
   * `stopEpisodeId` and `stopEpisodeAttemptId` synchronously, before this
   * runs, so the record cannot drift onto whatever attempt happens to be
   * live when the awaited stop settles.
   */
  private async runStopVector(): Promise<MotorTestStopExecutionOutcome> {
    const engine = this.engine;
    const episodeId = this.stopEpisodeId;

    if (engine === undefined) {
      // No professional authority for this session, so nothing this
      // controller did could have commanded an output. Recorded honestly
      // rather than reported as a stop that happened - and with the SAME
      // precedence the pre-engine implementation used: no lease, then no
      // decoded scope, then an authority that never came to exist (a
      // session that failed closed before the engine was constructed).
      const outcome: MotorTestStopExecutionOutcome = {
        kind: 'NOT_ATTEMPTED',
        reason:
          this.lease === undefined
            ? 'NO_LEASE'
            : this.motorScope === undefined
              ? 'NO_SCOPE'
              : 'AUTHORITY_STALE',
      };
      this.stopExecution = Object.freeze({
        ...this.stopExecution,
        attempts: this.stopExecution.attempts + 1,
        episodeId,
        outcome,
      });
      return outcome;
    }

    const engineOutcome = await engine.stopAll(
      mapLegacyStopReason(this.stopTriggerForEpisode ?? 'STOP_BUTTON_PRESSED'),
    );
    this.stopExecution = projectStopOutcomeToLegacyRecord(engineOutcome, {
      previous: this.stopExecution,
      episodeId,
    });
    return this.stopExecution.outcome as MotorTestStopExecutionOutcome;
  }

  /*
   * `dispatchAllStop` WAS HERE. It was the controller's single
   * `lease.emergencyStop(MSP_SET_MOTOR, ...)` call site - the last legacy
   * direct STOP write. The engine owns that dispatch now, together with
   * the ambiguity confirmation it sometimes needs, so this controller no
   * longer puts any motor frame on the wire by any route.
   */

  /* --- teardown ---------------------------------------------------- */

  /**
   * The required seven-step teardown, in order, concurrent-call safe and
   * idempotent.
   *
   * Every step is individually guarded, so one cleanup exception can
   * never skip the remaining safe local cleanup. Nothing here sends a
   * teardown write, and nothing acts on a replacement session - every
   * capability released is one this controller captured itself.
   */
  private async runTeardown(): Promise<MotorTestControllerSnapshot> {
    const steps: MotorTestTeardownStepReport[] = [];
    const record = (
      step: MotorTestTeardownStepName,
      outcome: MotorTestTeardownStepOutcome,
    ): void => {
      steps.push(Object.freeze({step, outcome}));
    };
    let threw = false;

    // (1) Mark closing and synchronously invalidate pending callbacks.
    this.closing = true;
    this.invalidateContinuations();
    // Reached directly when teardown is entered without close() - the
    // watchdog must not survive either route.
    this.clearPulseDeadline();
    // The dedicated safety monitor dies with the session, synchronously
    // and before anything is awaited. An observation still in flight is
    // ABANDONED rather than awaited - teardown must never be gated on a
    // read completing - and its late result publishes nothing because
    // stop() bumps the monitor's own generation.
    this.safetyMonitor?.stop();
    this.endPulseAttempt({kind: 'FAILED', reason: 'STOP_DOMINATED'});
    this.phase = 'CLOSING';
    record('MARK_CLOSING', 'DONE');

    // (2) Remove or deactivate lifecycle and session listeners.
    try {
      if (this.unsubscribeSession !== undefined) {
        const unsubscribe = this.unsubscribeSession;
        this.unsubscribeSession = undefined;
        unsubscribe();
        record('REMOVE_LISTENERS', 'DONE');
      } else {
        record('REMOVE_LISTENERS', 'SKIPPED');
      }
    } catch {
      threw = true;
      record('REMOVE_LISTENERS', 'THREW');
    }

    // (3) Keep telemetry paused. Explicit, not incidental: the barrier is
    // deliberately NOT touched here, and cannot be until step 7.
    record(
      'KEEP_TELEMETRY_PAUSED',
      this.barrier !== undefined ? 'DONE' : 'SKIPPED',
    );

    // (4) Only teardown authorized for the CAPTURED authority. The
    // accepted abstractions expose no removal, no re-enable and no
    // teardown write, so there is nothing to send - and this controller
    // never invents one. Recorded so the absence is visible.
    record(
      'AUTHORIZED_TEARDOWN_ONLY',
      this.authority !== undefined ? 'DONE' : 'SKIPPED',
    );

    // (5) Phase 2F: THE REQUIRED COMMAND-214 STOP ATTEMPT.
    //
    // Ordered here deliberately: after the captured authority has been
    // validated, and BEFORE the lease is released. Outputs are commanded to
    // stop while a command can still be sent at all.
    let stopUnsafe = false;
    try {
      const stopOutcome = await this.executeStopVector();
      if (stopOutcome.kind === 'ACKNOWLEDGED') {
        record('EXECUTE_STOP_VECTOR', 'DONE');
      } else if (stopOutcome.kind === 'FAILED') {
        // A command-214 request WAS put on the wire and its outcome is
        // unknown. This is the one genuinely uncertain case: an output may
        // be commanded and we cannot prove otherwise.
        stopUnsafe = true;
        record('EXECUTE_STOP_VECTOR', 'THREW');
      } else if (this.pulseMayHaveReachedFc) {
        // PHASE 2G - THE STOP-UNCERTAINTY OBLIGATION, now discharged.
        //
        // Phase 2F could treat NOT_ATTEMPTED and SCOPE_REJECTED as benign
        // because no pulse path existed: an output could only ever have
        // been commanded by the stop itself, so a stop that never reached
        // the wire left nothing uncertain. That reasoning DIES the moment
        // a pulse may have been submitted. From then on "we could not even
        // attempt a stop" is the worst case, not a harmless one - no
        // lease, no scope, a lost authority, a detach or a replacement
        // before attributable completion all mean an output may be
        // commanded and we cannot prove otherwise.
        stopUnsafe = true;
        record('EXECUTE_STOP_VECTOR', 'THREW');
      } else {
        // No pulse was ever submitted in this session, so nothing this
        // controller did could have commanded an output. Reporting
        // uncertainty here would clobber the far more specific cause that
        // actually ended the session (an unsupported motor scope, an
        // unreadable armed state).
        record('EXECUTE_STOP_VECTOR', 'SKIPPED');
      }
    } catch {
      stopUnsafe = true;
      record('EXECUTE_STOP_VECTOR', 'THREW');
    }

    // (6) Confirm the observation loop is down before the lease goes.
    //
    // It was already stopped synchronously in step 1 - a stop must never
    // wait on a read - so this step RECORDS rather than acts. It exists
    // because "no observation is outstanding against a dead lease" is a
    // teardown fact somebody auditing this report needs to be able to see.
    const safetyMonitorStopped = this.safetyMonitor !== undefined;
    try {
      this.safetyMonitor?.stop();
      record('STOP_SAFETY_MONITOR', safetyMonitorStopped ? 'DONE' : 'SKIPPED');
    } catch {
      threw = true;
      record('STOP_SAFETY_MONITOR', 'THREW');
    }

    // (6b) P2-ii: RELEASE THE FC-SIDE ARMING RESTRICTION - BUT ONLY IF
    //      THE STOP WAS ESTABLISHED.
    //
    // ORDER. This runs AFTER the all-stop attempt above and BEFORE the
    // lease is released. Releasing first would re-permit arming while an
    // output could still be commanded, which inverts the entire point of
    // establishing the restriction; releasing after the lease is gone
    // would be impossible, because the release travels that same lease.
    //
    // FAIL CLOSED, AND SAY SO. When the stop could not be established
    // under the contract above (`stopUnsafe`), the restriction is
    // deliberately LEFT IN FORCE. Releasing it merely to make teardown
    // look complete would turn an uncertain motor-output state into an
    // immediately armable flight controller - strictly worse than leaving
    // a flight controller temporarily unable to arm, which the operator
    // can always clear by reconnecting. This is fail-closed behaviour, not
    // a failure, and it is NEVER a claim about physical motor state.
    if (!this.armingRestrictionEstablished) {
      this.armingRestrictionReleased = 'NOT_OWED';
      record('RELEASE_ARMING_RESTRICTION', 'SKIPPED');
    } else if (stopUnsafe) {
      this.armingRestrictionReleased = 'WITHHELD_STOP_UNPROVEN';
      record('RELEASE_ARMING_RESTRICTION', 'SKIPPED');
    } else {
      try {
        const lease = this.lease;
        if (lease !== undefined && lease.isActive()) {
          // Payload [0] = release THIS descriptor's hold. The builder is
          // the reviewed module's; nothing is encoded here.
          await lease.request(
            MSP_SET_ARMING_DISABLED,
            buildArmingReleasePayload(),
            READ_REQUEST_OPTIONS,
          );
          this.armingRestrictionReleased = 'RELEASED';
          // THE RELEASE IS REPORTED BACK TO THE MODULE THAT RECORDED THE
          // ESTABLISHMENT, and this is not bookkeeping tidiness - it is
          // the second half of the reopen fix.
          //
          // motorArmingRestriction.ts records an establishment against the
          // OFFICIAL SESSION AUTHORITY, which deliberately outlives an
          // ordinary lease release-and-reacquire. This release travels the
          // lease, so without this call the module never learns the hold
          // is gone: the operator's NEXT motor session on the same cable
          // is refused with ARMING_RESTRICTION_ALREADY_ESTABLISHED and
          // fails closed at setup. Reached only after the request above
          // actually succeeded, so a withheld or failed release still
          // leaves the record - and the refusal - standing.
          if (this.armingRestrictionReceipt !== undefined) {
            recordMotorArmingRestrictionReleased(this.armingRestrictionReceipt);
          }
          record('RELEASE_ARMING_RESTRICTION', 'DONE');
        } else {
          // The transport is already gone. Nothing can be sent, and
          // nothing is pretended.
          this.armingRestrictionReleased = 'RELEASE_FAILED';
          record('RELEASE_ARMING_RESTRICTION', 'SKIPPED');
        }
      } catch {
        // The release itself failed. The restriction may still be in
        // force on the aircraft - the safe direction to be wrong in - but
        // the teardown must NOT present itself as ordinarily clean: the
        // operator's next connection starts against a flight controller
        // whose arming state this session could not settle. `threw` marks
        // the report incomplete, and `armingRestrictionRelease` carries
        // the distinct recovery cause.
        threw = true;
        this.armingRestrictionReleased = 'RELEASE_FAILED';
        record('RELEASE_ARMING_RESTRICTION', 'THREW');
      }
    }

    // (7) Release the genuine lease.
    let leaseRelease: MotorTestLeaseReleaseResult | 'NOT_HELD' | 'THREW' =
      'NOT_HELD';
    try {
      if (this.lease !== undefined) {
        leaseRelease = this.lease.release();
        record('RELEASE_LEASE', 'DONE');
      } else {
        record('RELEASE_LEASE', 'SKIPPED');
      }
    } catch {
      threw = true;
      leaseRelease = 'THREW';
      record('RELEASE_LEASE', 'THREW');
    }

    // Exclusivity is conclusively gone only for these verdicts:
    //   NOT_HELD         - none was ever acquired.
    //   RELEASED         - this controller released it.
    //   ALREADY_RELEASED - it was already gone.
    //   INVALIDATED      - the session itself is conclusively invalidated,
    //                      so the old local token owns nothing.
    // NOT_OWNER, LEASE_WORK_UNSETTLED and THREW leave ownership UNKNOWN,
    // and unknown must never resume telemetry.
    const exclusivityGone =
      leaseRelease === 'NOT_HELD' ||
      leaseRelease === 'RELEASED' ||
      leaseRelease === 'ALREADY_RELEASED' ||
      leaseRelease === 'INVALIDATED';

    // (8) Release the telemetry pause tokens LAST, and only then.
    //
    // Phase 2F adds a SECOND condition: an uncertain stop keeps the
    // barrier held too. Resuming ordinary polling onto a link where a
    // command-214 request was dispatched but never acknowledged would put
    // traffic on a link that may still be driving an output.
    let telemetryReleased = false;
    if (exclusivityGone && !stopUnsafe) {
      try {
        if (this.barrier !== undefined) {
          this.barrier.release();
          telemetryReleased = true;
          record('RELEASE_TELEMETRY_TOKENS', 'DONE');
        } else {
          record('RELEASE_TELEMETRY_TOKENS', 'SKIPPED');
        }
      } catch {
        threw = true;
        record('RELEASE_TELEMETRY_TOKENS', 'THREW');
      }
    } else {
      // Held deliberately: an unresolved release means somebody may still
      // own the link, and resuming polling into that is exactly what must
      // never happen.
      record('RELEASE_TELEMETRY_TOKENS', 'SKIPPED');
    }

    const complete = exclusivityGone && !threw && !stopUnsafe;
    if (!complete) {
      // Cleanup-incomplete is a FAULT condition requiring a full session
      // reset - never reported as a successful teardown.
      // An unsafe stop outcome is the most specific and most severe cause,
      // so it names the fault.
      const faultReason: MotorTestFaultReason = stopUnsafe
        ? 'STOP_FAILED'
        : exclusivityGone
          ? 'NATIVE_EXCEPTION'
          : 'STOP_FAILED';
      this.dispatchFault(faultReason);
      // Never clobber an earlier, MORE SPECIFIC terminal cause - the same
      // rule `recordOutcome` applies. A teardown that could not complete
      // because the session had already failed closed must not relabel
      // that failure as a teardown problem.
      if (this.outcome.kind !== 'FAILED_CLOSED') {
        this.outcome = Object.freeze({
          kind: 'FAILED_CLOSED' as const,
          reason: 'TEARDOWN_INCOMPLETE' as const,
          faultReason,
          requiresNewSession: true as const,
        });
      }
    }

    this.teardownReport = Object.freeze({
      steps: Object.freeze(steps),
      safetyMonitorStopped,
      leaseRelease,
      telemetryTokensReleased: telemetryReleased,
      armingRestrictionRelease: this.armingRestrictionReleased,
      complete,
      ...(complete
        ? {}
        : {
            incompleteReason: exclusivityGone
              ? ('TEARDOWN_STEP_THREW' as const)
              : ('LEASE_RELEASE_UNRESOLVED' as const),
          }),
    });

    this.phase = 'CLOSED';
    this.publish();
    return this.snapshot;
  }
}

/**
 * The production factory - the ONLY way to obtain a controller.
 *
 * There is deliberately no exported constructor and no exported class: a
 * caller cannot inject a fabricated authority, lease, receipt or barrier
 * hold, because none of them is a parameter. The authority comes from
 * `MotorTestLease.officialSessionAuthority()` and the lease from
 * `acquireMotorTestLease` - both official issuers - and both live in
 * private fields the returned surface never exposes.
 *
 * The returned object is a frozen literal with an explicit tested surface, so
 * the public surface is fixed at construction and cannot be extended,
 * replaced or reached around.
 */
export function createMotorTestController(
  dependencies: MotorTestControllerDependencies,
): MotorTestController {
  const controller = new MotorTestControllerImpl(dependencies);
  return Object.freeze({
    initializeSession: () => controller.initializeSession(),
    getSnapshot: () => controller.getSnapshot(),
    subscribe: (listener: () => void) => controller.subscribe(listener),
    requestStop: (trigger: MotorTestStopTriggerReason) =>
      controller.requestStop(trigger),
    pulseMotor: (motorNumber: number) => controller.pulseMotor(motorNumber),
    renewPulseHold: () => controller.renewPulseHold(),
    setEscDirection: (motorNumber: number, direction: DshotEscDirection) =>
      controller.setEscDirection(motorNumber, direction),
    refreshDiagnostics: () => controller.refreshDiagnostics(),
    close: () => controller.close(),
    // P2-ii: the professional facade, same frozen-literal rule - the
    // engine and its authority stay in private fields behind it.
    setMotorValues: (values: readonly number[]) =>
      controller.setMotorValues(values),
    setMotorValue: (motorIndex: number, value: number) =>
      controller.setMotorValue(motorIndex, value),
    setMaster: (value: number) => controller.setMaster(value),
    stopAll: () => controller.stopAll(),
  });
}
