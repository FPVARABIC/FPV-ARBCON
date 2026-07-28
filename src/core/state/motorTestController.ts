/**
 * Phase 2D - the UNREACHABLE MOTOR-TEST CONTROLLER.
 *
 * WHAT THIS IS
 * ------------
 * The thinnest possible composition of the already-accepted motor-test
 * contracts. It captures one official session authority, holds the
 * coordinator-wide telemetry barrier, owns one genuine `MotorTestLease`,
 * gathers the accepted session-bound evidence, establishes the accepted
 * arming restriction, and drives the accepted pure reducer through
 * SAFETY-ONLY operations.
 *
 * WHAT IT IS NOT
 * --------------
 * It is NOT mounted. Nothing in the running application imports it; its
 * only consumers are its own tests (and, in a later separately-audited
 * pass, a lifecycle binding). Leaving it unmounted is a requirement of
 * this pre-wire bundle, not an oversight.
 *
 * IT CANNOT SPIN A MOTOR, and the impossibility is structural, not a
 * convention:
 *   - no public method can reach `Ready -> Starting`: `ACTIVATION_ACCEPTED`
 *     is never constructed anywhere in this file, so `Starting`,
 *     `Pulsing` and `SUBMIT_START_INTENT` are unreachable;
 *   - there is no generic `dispatch(event)`; the public surface is five
 *     named operations, and the only event any caller can influence is a
 *     whitelisted `STOP_TRIGGERED`;
 *   - no MSP command id, payload, motor index, motor value, output
 *     vector, duration or throttle mapping is chosen, encoded or imported
 *     here. The commands this file names are the accepted READ commands
 *     of the accepted evidence modules;
 *   - every request travels `MotorTestLease.request(...)`, i.e. the
 *     canonical FIFO. No transport, no raw byte writer, no raw client
 *     request, no second queue;
 *   - the reducer's effects are recorded as INERT FROZEN DATA. Nothing in
 *     this module executes an effect, and no descriptor holds a callback,
 *     promise, client, transport, writer, command, payload, lease, motor
 *     value or native handle.
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
 * THE SIGNAL GAP, STATED PLAINLY
 * ------------------------------
 * The governing requirement asks for armed-state, arming-restriction-loss
 * and battery-unsafe/change signals from "an existing accepted,
 * session-bound, FRESH source", with no new polling loop and no reuse of
 * paused telemetry.
 *
 * NO SUCH CONTINUOUS SOURCE EXISTS IN THIS REPOSITORY, and this module
 * claims no coverage it does not have:
 *   - `acquireMotorDynamicSafetyObservation` is a ONE-SHOT read. It is
 *     used here exactly once, as a Ready gate. It is not a monitor;
 *   - `MspTelemetryScheduler` is the only continuous source, and this
 *     controller has just PAUSED it. Reading its cache would be reading
 *     values the barrier itself froze - the requirement forbids that, and
 *     so does honesty;
 *   - `MotorArmingRestrictionReceipt.isCurrent()` proves only that the
 *     lease is still live and the receipt is still this session's
 *     recorded one. It does NOT re-read the FC, so it cannot detect
 *     restriction removal. Its own doc comment says so.
 * Therefore: continuous armed-state, restriction-loss and battery
 * monitoring is an OPEN GAP. It is reported, not papered over - the
 * snapshot carries it as data in `continuousSafetyMonitoring`. This is
 * acceptable for Phase 2D only because no motor command exists anywhere
 * in this bundle; it must be closed before any activation pass.
 * `requestStop` accepts the corresponding trigger reasons so that a
 * genuine source added later routes into the same safety path, but this
 * module never manufactures them.
 *
 * ARMING-RESTRICTION TEARDOWN, STATED PLAINLY
 * -------------------------------------------
 * The accepted abstraction has NO removal operation - motorArmingRestriction.ts
 * deliberately does not implement, expose or encode the inverse payload.
 * Teardown therefore SETTLES rather than releases: it records one final
 * `isCurrent()` observation while the lease is still valid, and reports
 * `removalSupported: false, removalPerformed: false`. This module never
 * claims the restriction was removed, and never claims physical safety.
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
import {
  MSP_ADVANCED_CONFIG,
  MSP_FEATURE_CONFIG,
  MSP_MIXER_CONFIG,
  MSP_MOTOR_CONFIG,
} from '../protocol/msp/commands/mspCommands';
import {
  decodeAdvancedConfig,
  MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2,
} from '../protocol/msp/decoding/decodeAdvancedConfig';
import {decodeFeatureConfig} from '../protocol/msp/decoding/decodeFeatureConfig';
import {
  decodeMixerConfig,
  MIXER_MODE_QUADX,
} from '../protocol/msp/decoding/decodeMixerConfig';
import {decodeMotorConfig} from '../protocol/msp/decoding/decodeMotorConfig';
import {MspIdentificationService} from '../protocol/msp/identification/MspIdentificationService';
import type {BoxIdsResult} from '../protocol/msp/identification/BoxIdsAcquisition';
import type {
  MotorTestBarrierHold,
  MotorTestTelemetryRegistry,
  MotorTestTelemetrySession,
} from '../protocol/telemetry/motorTestTelemetryBarrier';
import {
  establishMotorArmingRestriction,
  type MotorArmingRestrictionEvidenceScope,
  type MotorArmingRestrictionFailureReason,
  type MotorArmingRestrictionReceipt,
} from './motorArmingRestriction';
import {
  acquireMotorDynamicSafetyObservation,
  type MotorDynamicSafetyObservationBlockedReason,
} from './motorDynamicSafetyObservation';
import {
  evaluateMotorDynamicSafetyRequirements,
  type MotorDynamicSafetyRequirementsEvaluation,
} from './motorDynamicSafetyEvaluation';
import {
  acquireMotorFcFirmwareVersion,
  type MotorFcFirmwareVersionBinding,
  type MotorFcFirmwareVersionFailureReason,
} from './motorFcFirmwareVersion';
import {
  assembleMotorStaticFacts,
  bindMotorStaticFacts,
  type MotorStaticFactsBinding,
  type MotorStaticFactsSessionIdentity,
} from './motorStaticFacts';
import {
  evaluateMotorStaticCompatibility,
  type MotorStaticCompatibilityEvaluation,
} from './motorStaticCompatibility';
import {
  acquireMotorTestBoxIds,
  type MotorTestBoxIdsFailureReason,
  type MotorTestBoxIdsSnapshot,
} from './motorTestBoxIds';
import {
  composeMotorTestCapabilities,
  isMotorTestProfileSupported,
  type MotorTestCapabilities,
  type MotorTestProfileEvidence,
} from './motorTestCapabilities';
import {
  createMotorTestState,
  motorTestTransition,
  type MotorTestEffect,
  type MotorTestEvent,
  type MotorTestFaultReason,
  type MotorTestState,
  type MotorTestStopTriggerReason,
} from './motorTestStateMachine';

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
 * The narrow read/lifecycle slice of the platform session layer.
 *
 * Deliberately three members and nothing else. It exposes the canonical
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
  /** The registry's anchor for THIS physical session. */
  readonly telemetrySession: MotorTestTelemetrySession;
  /** Monotonic clock for the accepted observation window. A reading,
   * never a timer: nothing here schedules on it or compares it to a
   * deadline. */
  readonly readMonotonicMillis: () => number;
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

/** Exhaustive - adding a firmware-version failure reason must fail to
 * compile. */
export function classifyFirmwareVersionFailure(
  reason: MotorFcFirmwareVersionFailureReason,
): MotorTestFailureClass {
  switch (reason) {
    case 'SESSION_IDENTITY_UNAVAILABLE':
    case 'SESSION_IDENTITY_MISMATCH':
    case 'SESSION_IDENTITY_CHANGED':
      return fault('SESSION_CHANGED');
    case 'REQUEST_FAILED':
      return fault('MSP_RESPONSE_TIMEOUT');
    case 'MALFORMED_RESPONSE':
      return LOCK;
    default:
      assertExhaustiveReason(reason);
      return fault('NATIVE_EXCEPTION');
  }
}

/** Exhaustive - adding an observation blocked reason must fail to
 * compile. */
export function classifyDynamicObservationFailure(
  reason: MotorDynamicSafetyObservationBlockedReason,
): MotorTestFailureClass {
  switch (reason) {
    case 'SESSION_IDENTITY_UNAVAILABLE':
    case 'SESSION_IDENTITY_MISMATCH':
    case 'SESSION_IDENTITY_CHANGED':
      return fault('SESSION_CHANGED');
    case 'REQUEST_FAILED':
      return fault('MSP_RESPONSE_TIMEOUT');
    case 'STATIC_PROFILE_REQUIRED':
    case 'ARMING_BOX_MAPPING_REQUIRED':
    case 'ARMED_STATE_UNOBSERVABLE':
    case 'ARMING_RESTRICTIONS_UNOBSERVABLE':
    case 'MALFORMED_RESPONSE':
      // Incomplete or unusable evidence with zero uncertain side effects:
      // the accepted module sends only reads, and a read that answered
      // badly leaves nothing pending on the aircraft.
      return LOCK;
    default:
      assertExhaustiveReason(reason);
      return fault('NATIVE_EXCEPTION');
  }
}

/**
 * Exhaustive - adding an arming-restriction failure reason must fail to
 * compile.
 *
 * The split here is the sharpest in this file, because command 99 is the
 * only session-bound WRITE in the whole bundle. Everything that can only
 * happen BEFORE it was submitted may lock; everything reachable at or
 * after submission must fail closed, because the write outcome is no
 * longer knowable from here.
 */
export function classifyArmingRestrictionFailure(
  reason: MotorArmingRestrictionFailureReason,
): MotorTestFailureClass {
  switch (reason) {
    // --- Pre-submission, session-level ------------------------------
    case 'CURRENT_SESSION_IDENTITY_UNAVAILABLE':
    case 'REQUESTED_SESSION_IDENTITY_MISMATCH':
    case 'MOTOR_TEST_LEASE_IDENTITY_MISMATCH':
    case 'MOTOR_TEST_LEASE_INACTIVE':
      return fault('SESSION_CHANGED');
    case 'SESSION_IDENTITY_PROVIDER_FAILED':
      return fault('NATIVE_EXCEPTION');
    case 'ARMING_RESTRICTION_FAULT_LATCHED':
      return fault('DESYNCHRONIZED');
    case 'ARMING_RESTRICTION_ALREADY_ESTABLISHING':
      // Two establishments for one authority. This controller starts at
      // most one, so a second means something else is driving the same
      // session - never continue under that ambiguity.
      return fault('AUTHORITY_MISMATCH');
    case 'ARMING_RESTRICTION_ALREADY_ESTABLISHED':
      // A PREVIOUS controller established it for this same official
      // session and holds the only receipt. Nothing is uncertain and
      // nothing was written now - but this controller has no evidence of
      // its own, so it must not claim any. A genuinely new official
      // session (new client, or a rotated epoch) is required.
      return LOCK;
    case 'BOX_IDS_PROVENANCE_INVALID':
      return LOCK;

    // --- At or after submission -------------------------------------
    case 'ARMING_DISABLE_REQUEST_FAILED':
      // The write outcome is unknown by construction.
      return fault('WRITE_OUTCOME_UNKNOWN');
    case 'POST_ACK_STATUS_REQUEST_FAILED':
      return fault('MSP_RESPONSE_TIMEOUT');
    case 'SESSION_CHANGED_DURING_ESTABLISHMENT':
      return fault('SESSION_CHANGED');
    case 'FC_ARMED':
    case 'MSP_ARMING_RESTRICTION_NOT_OBSERVED':
    case 'INDEPENDENT_VERIFICATION_UNAVAILABLE':
    case 'MALFORMED_STATUS_RESPONSE':
      // Every one of these is reached only after command 99 went out, and
      // the accepted module has already failed the lease closed.
      return fault('WRITE_OUTCOME_UNKNOWN');
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
  | 'TELEMETRY_BARRIER'
  | 'POST_BARRIER_REVALIDATION'
  | 'LEASE_ACQUISITION'
  | 'AUTHORITY_CAPTURE'
  | 'POST_LEASE_REVALIDATION'
  | 'BOX_EVIDENCE'
  | 'STATIC_FACTS'
  | 'FIRMWARE_VERSION'
  | 'STATIC_COMPATIBILITY'
  | 'CAPABILITIES'
  | 'DYNAMIC_OBSERVATION'
  | 'DYNAMIC_EVALUATION'
  | 'ARMING_RESTRICTION'
  | 'READY';

export type MotorTestSetupBlockedReason =
  | 'SESSION_IDENTITY_UNAVAILABLE'
  | 'SESSION_CHANGED'
  | 'CONTROLLER_CANCELLED'
  | 'STOP_REQUESTED_DURING_SETUP'
  | 'TELEMETRY_SESSION_UNKNOWN'
  | 'TELEMETRY_SESSION_REPLACED'
  | 'TELEMETRY_QUIESCENCE_TIMEOUT'
  | 'LEASE_NOT_ACQUIRED'
  | 'OFFICIAL_AUTHORITY_UNAVAILABLE'
  | 'BOX_EVIDENCE_UNAVAILABLE'
  | 'STATIC_FACTS_REQUEST_FAILED'
  | 'STATIC_FACTS_MALFORMED'
  | 'FIRMWARE_VERSION_UNAVAILABLE'
  | 'STATIC_PROFILE_NOT_EVALUATED'
  | 'STATIC_PROFILE_UNSUPPORTED'
  | 'CAPABILITY_PROFILE_UNSUPPORTED'
  | 'DYNAMIC_OBSERVATION_UNAVAILABLE'
  | 'DYNAMIC_REQUIREMENTS_NOT_EVALUATED'
  | 'DYNAMIC_REQUIREMENTS_NOT_SATISFIED'
  | 'ARMING_RESTRICTION_NOT_ESTABLISHED'
  | 'ARMING_RESTRICTION_NOT_CURRENT'
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

/**
 * What is known about the arming restriction.
 *
 * `receiptCurrentAtPublish` is a POINT-IN-TIME record taken when this
 * snapshot was built. It proves the lease was live and the receipt was
 * this session's recorded one at that instant. It does not re-read the
 * FC and is never evidence that the restriction is still in force.
 */
export type MotorTestControllerArmingRestriction =
  | {readonly kind: 'NOT_ATTEMPTED'}
  | {
      readonly kind: 'ESTABLISHED';
      readonly evidenceScope: MotorArmingRestrictionEvidenceScope;
      readonly receiptCurrentAtPublish: boolean;
    }
  | {
      readonly kind: 'NOT_ESTABLISHED';
      readonly reason: MotorArmingRestrictionFailureReason;
    };

export type MotorTestTeardownStepOutcome = 'DONE' | 'SKIPPED' | 'THREW';

export type MotorTestTeardownStepName =
  | 'MARK_CLOSING'
  | 'REMOVE_LISTENERS'
  | 'KEEP_TELEMETRY_PAUSED'
  | 'AUTHORIZED_TEARDOWN_ONLY'
  | 'SETTLE_ARMING_RESTRICTION'
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
  /** The accepted abstraction has no removal operation, so this is
   * permanently false and permanently honest. */
  readonly armingRestrictionRemovalSupported: false;
  readonly armingRestrictionRemovalPerformed: false;
  /** Final `isCurrent()` observation, taken while the lease was still
   * valid, or undefined when no receipt existed. */
  readonly armingRestrictionReceiptCurrentAtTeardown: boolean | undefined;
  /** The lease's own release verdict, `'NOT_HELD'` when none was ever
   * acquired, or `'THREW'` when the accepted call itself threw. */
  readonly leaseRelease: MotorTestLeaseReleaseResult | 'NOT_HELD' | 'THREW';
  readonly telemetryTokensReleased: boolean;
  /** True only when exclusivity is conclusively gone AND every local step
   * completed. */
  readonly complete: boolean;
  /** Present exactly when `complete` is false. */
  readonly incompleteReason?:
    | 'LEASE_RELEASE_UNRESOLVED'
    | 'TEARDOWN_STEP_THREW';
}

export interface MotorTestControllerSnapshot {
  readonly phase: MotorTestControllerPhase;
  readonly setupStep: MotorTestSetupStep;
  /** The accepted reducer's state, once a genuine official authority
   * exists. Undefined before that, by construction. */
  readonly machine: MotorTestState | undefined;
  readonly outcome: MotorTestSetupOutcome;
  readonly capabilities: MotorTestCapabilities | undefined;
  readonly staticCompatibility: MotorStaticCompatibilityEvaluation | undefined;
  readonly dynamicEvaluation:
    | MotorDynamicSafetyRequirementsEvaluation
    | undefined;
  readonly armingRestriction: MotorTestControllerArmingRestriction;
  /** Whether this controller currently holds the telemetry barrier. */
  readonly telemetryHeld: boolean;
  readonly warnings: readonly MotorTestControllerWarning[];
  readonly stopDescriptors: readonly MotorTestStopDescriptor[];
  readonly teardown: MotorTestTeardownReport | undefined;
  /**
   * The open signal gap, carried in the data rather than only in a
   * comment: no accepted source can provide continuous armed-state,
   * arming-restriction-loss or battery monitoring while the barrier is
   * held, so this controller does not monitor them and does not claim to.
   */
  readonly continuousSafetyMonitoring: 'UNAVAILABLE_NO_ACCEPTED_SOURCE';
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
  ] as const);

const STOP_TRIGGER_SET: ReadonlySet<string> = new Set<string>(
  MOTOR_TEST_CONTROLLER_STOP_TRIGGERS,
);

/**
 * The entire public surface.
 *
 * Five operations. No generic dispatcher. No activation, start, pulse,
 * arm or write method. No accessor for the lease, the client, the
 * authority, the receipt or the barrier hold.
 */
export interface MotorTestController {
  /**
   * Prepares the safety session: barrier, lease, evidence, restriction.
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
  /** Idempotent. Concurrent callers observe the same operation. */
  close(): Promise<MotorTestControllerSnapshot>;
}

/* ------------------------------------------------------------------ *
 * Evidence mapping
 * ------------------------------------------------------------------ */

/**
 * Projects the accepted static facts plus the accepted firmware-version
 * binding onto the accepted capability evidence shape.
 *
 * Every mapping below is an explicit, documented rendering of a value the
 * FC actually reported. NOTHING IS DEFAULTED: a raw value the profile
 * does not recognize is rendered as a distinct non-matching token, which
 * the accepted composer reports as `EVIDENCE_UNSUPPORTED` - the honest
 * answer, and deliberately not `EVIDENCE_MISSING_OR_INVALID`, which would
 * claim the value could not be read when in fact it was.
 */
export function composeMotorTestProfileEvidence(
  staticFacts: MotorStaticFactsBinding,
  firmwareVersion: MotorFcFirmwareVersionBinding,
): MotorTestProfileEvidence {
  const facts = staticFacts.facts;
  const identity = facts.flightControllerIdentity;
  const version = firmwareVersion.firmwareVersion;
  return Object.freeze({
    fcVariantIdentifier: identity.firmware.identifier,
    apiVersionMajor: identity.apiVersion.apiVersionMajor,
    apiVersionMinor: identity.apiVersion.apiVersionMinor,
    firmwareYear: version.year,
    firmwareMonth: version.month,
    firmwarePatch: version.patch,
    boardTargetName: identity.board.targetName,
    // mixerMode_e raw -> token. QUAD_X is the only recognized value.
    mixerProfile:
      facts.mixerModeRaw === MIXER_MODE_QUADX
        ? 'QUAD_X'
        : `MIXER_MODE_RAW_${facts.mixerModeRaw}`,
    motorCount: facts.motorCount,
    // motorProtocolTypes_e raw -> token, pinned at 2025.12.2.
    motorProtocol:
      facts.motorProtocolRaw === MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2
        ? 'DSHOT600'
        : `MOTOR_PROTOCOL_RAW_${facts.motorProtocolRaw}`,
    motorIdleHundredthsPercent: facts.motorIdleRaw,
    feature3dEnabled: facts.feature3dEnabled,
    // MSP_MIXER_CONFIG offset 1. The FC's STORED FLAG only - it is not a
    // claim about physical propeller installation, and the accepted facts
    // module says so in the field's own name.
    propsOutConfigured: facts.yawMotorsReversedConfigured,
    // Mirrors the accepted static check exactly: raw 0 is the supported
    // value, anything else is treated as enabled. Raw 0 stays ambiguous
    // between "disabled" and "not compiled in", and nothing here resolves
    // that ambiguity.
    bidirectionalDshotEnabled: facts.dshotTelemetryRaw !== 0,
  });
}

/* ------------------------------------------------------------------ *
 * Implementation
 * ------------------------------------------------------------------ */

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

function failure(
  reason: MotorTestSetupBlockedReason,
  classification: MotorTestFailureClass,
): SetupFailure {
  return {reason, classification};
}

function isFailure(value: object): value is SetupFailure {
  return 'classification' in value;
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
  private barrier: MotorTestBarrierHold | undefined;
  private boxIds: MotorTestBoxIdsSnapshot | undefined;
  private receipt: MotorArmingRestrictionReceipt | undefined;

  private machine: MotorTestState | undefined;
  private effectRecord: MotorTestEffectRecord = EMPTY_MOTOR_TEST_EFFECT_RECORD;

  private capabilities: MotorTestCapabilities | undefined;
  private staticCompatibility: MotorStaticCompatibilityEvaluation | undefined;
  private dynamicEvaluation:
    | MotorDynamicSafetyRequirementsEvaluation
    | undefined;
  private armingRestriction: MotorTestControllerArmingRestriction =
    Object.freeze({kind: 'NOT_ATTEMPTED' as const});
  private teardownReport: MotorTestTeardownReport | undefined;

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
    let armingRestriction = this.armingRestriction;
    if (armingRestriction.kind === 'ESTABLISHED' && this.receipt !== undefined) {
      armingRestriction = Object.freeze({
        kind: 'ESTABLISHED' as const,
        evidenceScope: armingRestriction.evidenceScope,
        receiptCurrentAtPublish: this.receipt.isCurrent(),
      });
    }
    return Object.freeze({
      phase: this.phase,
      setupStep: this.setupStep,
      machine: this.machine,
      outcome: this.outcome,
      capabilities: this.capabilities,
      staticCompatibility: this.staticCompatibility,
      dynamicEvaluation: this.dynamicEvaluation,
      armingRestriction,
      telemetryHeld: this.barrier?.isHeld() ?? false,
      warnings: this.effectRecord.warnings,
      stopDescriptors: this.effectRecord.stopDescriptors,
      teardown: this.teardownReport,
      continuousSafetyMonitoring: 'UNAVAILABLE_NO_ACCEPTED_SOURCE' as const,
    });
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
    this.apply({authority, kind: 'FAULT_RAISED', reason}, undefined);
  }

  private dispatchStop(reason: MotorTestStopTriggerReason): void {
    const authority = this.authority;
    if (authority === undefined) {
      return;
    }
    this.apply({authority, kind: 'STOP_TRIGGERED', reason}, reason);
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
    if (this.setupPromise !== undefined) {
      return this.setupPromise;
    }
    if (this.closing || this.phase === 'CLOSED') {
      return Promise.resolve(this.snapshot);
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
    this.dispatchStop(trigger);
    this.publish();
    return 'ACCEPTED';
  }

  close(): Promise<MotorTestControllerSnapshot> {
    if (this.teardownPromise !== undefined) {
      return this.teardownPromise;
    }
    // (1) Mark closing and invalidate synchronously - before the first
    // await, so no in-flight continuation can act after this point.
    this.closing = true;
    this.invalidateContinuations();
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
    // Synchronous invalidation first, exactly as for a stop.
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

    // ---- (3)(4)(5) The coordinator-wide barrier. --------------------
    // One accepted call performs all three in the required order: it
    // closes the registration gate first, then takes a pause lease on
    // every registered scheduler synchronously, then awaits deterministic
    // quiescence. See motorTestTelemetryBarrier.acquireBarrier().
    this.setupStep = 'TELEMETRY_BARRIER';
    const acquisition = await this.deps.telemetryRegistry.acquireBarrier(
      this.deps.telemetrySession,
    );
    if (acquisition.kind !== 'ACQUIRED') {
      switch (acquisition.reason) {
        case 'SESSION_UNKNOWN':
          return failure('TELEMETRY_SESSION_UNKNOWN', LOCK);
        case 'SESSION_REPLACED':
          return failure(
            'TELEMETRY_SESSION_REPLACED',
            fault('SESSION_CHANGED'),
          );
        default:
          // A link that will not fall quiet is transport uncertainty.
          return failure(
            'TELEMETRY_QUIESCENCE_TIMEOUT',
            fault('MSP_RESPONSE_TIMEOUT'),
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

    // ---- (9) Accepted session-bound facts and the restriction. ------
    return this.runEvidenceSteps(generation, anchorIdentity, lease, authority);
  }

  private async runEvidenceSteps(
    generation: number,
    anchor: MspSessionCompositeIdentity,
    lease: MotorTestLease,
    authority: MspOfficialSessionAuthority,
  ): Promise<SetupFailure | undefined> {
    const session = this.deps.session;
    const readCurrentIdentity = () => session.readCurrentIdentity();
    const factsIdentity = asFactsIdentity(anchor);

    // ---- (9a) Trusted, session-bound BOX evidence. ------------------
    this.setupStep = 'BOX_EVIDENCE';
    const boxAcquisition = await acquireMotorTestBoxIds(lease);
    // A typed failure from an accepted module is more specific than the
    // generic boundary check and is therefore consulted FIRST - a
    // rejected request has already faulted the lease, and the boundary
    // check would attribute that to a session change.
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
    const boxIds = boxAcquisition.snapshot;
    this.boxIds = boxIds;
    // The plain mapping the dynamic observer takes, DERIVED from the
    // trusted snapshot rather than re-requested: MSP_BOXIDS keeps its
    // single owner and its at-most-once guarantee.
    const boxIdsResult: BoxIdsResult = Object.freeze({
      kind: 'READY' as const,
      permanentIds: boxIds.permanentIds,
    });

    // ---- (9b) Static facts. -----------------------------------------
    this.setupStep = 'STATIC_FACTS';
    const staticFacts = await this.readStaticFacts(
      generation,
      lease,
      factsIdentity,
    );
    if (isFailure(staticFacts)) {
      return staticFacts;
    }

    // ---- (9c) Firmware version. -------------------------------------
    this.setupStep = 'FIRMWARE_VERSION';
    const versionAcquisition = await acquireMotorFcFirmwareVersion({
      requester: lease,
      expectedIdentity: factsIdentity,
      readCurrentIdentity,
    });
    boundary = this.cancellation(generation);
    if (boundary !== undefined) {
      return boundary;
    }
    if (versionAcquisition.kind !== 'ACQUIRED') {
      return failure(
        'FIRMWARE_VERSION_UNAVAILABLE',
        classifyFirmwareVersionFailure(versionAcquisition.reason),
      );
    }
    boundary = this.revalidate(generation);
    if (boundary !== undefined) {
      return boundary;
    }

    // ---- (9d) Static compatibility. Pure. ---------------------------
    this.setupStep = 'STATIC_COMPATIBILITY';
    const compatibility = evaluateMotorStaticCompatibility(
      staticFacts.binding,
      versionAcquisition.binding,
    );
    this.staticCompatibility = compatibility;
    this.publish();
    if (compatibility.kind !== 'EVALUATED') {
      return failure('STATIC_PROFILE_NOT_EVALUATED', fault('SESSION_CHANGED'));
    }
    if (compatibility.compatibility.status !== 'SUPPORTED') {
      return failure('STATIC_PROFILE_UNSUPPORTED', LOCK);
    }

    // ---- (9e) Capabilities, bound to the captured authority. --------
    this.setupStep = 'CAPABILITIES';
    const capabilities = composeMotorTestCapabilities(
      authority,
      composeMotorTestProfileEvidence(
        staticFacts.binding,
        versionAcquisition.binding,
      ),
    );
    this.capabilities = capabilities;
    this.publish();
    if (!isMotorTestProfileSupported(capabilities)) {
      return failure('CAPABILITY_PROFILE_UNSUPPORTED', LOCK);
    }

    // ---- (9f) One-shot dynamic observation. -------------------------
    this.setupStep = 'DYNAMIC_OBSERVATION';
    const observation = await acquireMotorDynamicSafetyObservation({
      requester: lease,
      staticCompatibility: compatibility,
      boxIds: boxIdsResult,
      readCurrentIdentity,
      readMonotonicMillis: this.deps.readMonotonicMillis,
    });
    boundary = this.cancellation(generation);
    if (boundary !== undefined) {
      return boundary;
    }
    if (observation.kind !== 'OBSERVED') {
      return failure(
        'DYNAMIC_OBSERVATION_UNAVAILABLE',
        classifyDynamicObservationFailure(observation.reason),
      );
    }
    boundary = this.revalidate(generation);
    if (boundary !== undefined) {
      return boundary;
    }

    // ---- (9g) Dynamic requirements. Pure. ---------------------------
    this.setupStep = 'DYNAMIC_EVALUATION';
    const evaluation = evaluateMotorDynamicSafetyRequirements({
      staticCompatibility: compatibility,
      dynamicObservation: observation,
      currentSessionIdentity: readCurrentIdentity(),
    });
    this.dynamicEvaluation = evaluation;
    this.publish();
    if (evaluation.kind !== 'EVALUATED') {
      return failure(
        'DYNAMIC_REQUIREMENTS_NOT_EVALUATED',
        fault('SESSION_CHANGED'),
      );
    }
    if (evaluation.status !== 'REQUIREMENTS_SATISFIED') {
      return failure('DYNAMIC_REQUIREMENTS_NOT_SATISFIED', LOCK);
    }

    // ---- (9h) The arming restriction. The only write in the bundle. -
    this.setupStep = 'ARMING_RESTRICTION';
    const establishment = await establishMotorArmingRestriction({
      lease,
      requestedIdentity: anchor,
      readCurrentIdentity,
      boxIds,
    });
    if (establishment.kind !== 'ESTABLISHED') {
      this.armingRestriction = Object.freeze({
        kind: 'NOT_ESTABLISHED' as const,
        reason: establishment.reason,
      });
      this.publish();
      return failure(
        'ARMING_RESTRICTION_NOT_ESTABLISHED',
        classifyArmingRestrictionFailure(establishment.reason),
      );
    }
    this.receipt = establishment.receipt;
    this.armingRestriction = Object.freeze({
      kind: 'ESTABLISHED' as const,
      evidenceScope: establishment.receipt.evidenceScope,
      receiptCurrentAtPublish: establishment.receipt.isCurrent(),
    });
    this.publish();

    // ---- (10) Revalidate after the last asynchronous boundary. ------
    boundary = this.revalidate(generation);
    if (boundary !== undefined) {
      return boundary;
    }
    if (!establishment.receipt.isCurrent()) {
      return failure(
        'ARMING_RESTRICTION_NOT_CURRENT',
        fault('WRITE_OUTCOME_UNKNOWN'),
      );
    }

    // ---- (11) Ready - every mandatory fact valid for one authority. --
    this.setupStep = 'READY';
    this.dispatchGates(true);
    this.outcome = Object.freeze({kind: 'READY' as const});
    return undefined;
  }

  /**
   * The static-facts read sequence.
   *
   * Seven reads, every one through the lease and therefore through the
   * canonical FIFO. A REJECTED REQUEST and a MALFORMED RESPONSE are
   * separated deliberately: the first is transport uncertainty and must
   * fail closed, the second is complete-but-unusable evidence and locks.
   */
  private async readStaticFacts(
    generation: number,
    lease: MotorTestLease,
    identity: MotorStaticFactsSessionIdentity,
  ): Promise<{readonly binding: MotorStaticFactsBinding} | SetupFailure> {
    const identification = new MspIdentificationService(lease);
    let flightControllerIdentity;
    try {
      flightControllerIdentity = await identification.identify();
    } catch (error) {
      const cancelled = this.cancellation(generation);
      if (cancelled !== undefined) {
        return cancelled;
      }
      // identify() propagates a rejected request unchanged and throws its
      // own typed errors for an unusable answer. Both extend Error, so
      // the discriminator is the accepted contract's own error names.
      return isEvidenceQualityError(error)
        ? failure('STATIC_FACTS_MALFORMED', LOCK)
        : failure('STATIC_FACTS_REQUEST_FAILED', fault('MSP_RESPONSE_TIMEOUT'));
    }
    let boundary = this.revalidate(generation);
    if (boundary !== undefined) {
      return boundary;
    }

    const mixer = await this.readDecoded(
      generation,
      lease,
      MSP_MIXER_CONFIG,
      decodeMixerConfig,
    );
    if (isFailure(mixer)) {
      return mixer;
    }
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

    boundary = this.revalidate(generation);
    if (boundary !== undefined) {
      return boundary;
    }

    return {
      binding: bindMotorStaticFacts(
        identity,
        assembleMotorStaticFacts({
          flightControllerIdentity,
          mixerConfig: mixer.value,
          motorConfig: motor.value,
          advancedConfig: advanced.value,
          featureConfig: feature.value,
        }),
      ),
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
        'STATIC_FACTS_REQUEST_FAILED',
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
      return failure('STATIC_FACTS_MALFORMED', LOCK);
    }
  }

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

    // (5) Settle the arming restriction while the lease is still valid.
    let receiptCurrent: boolean | undefined;
    try {
      if (this.receipt !== undefined) {
        receiptCurrent = this.receipt.isCurrent();
        record('SETTLE_ARMING_RESTRICTION', 'DONE');
      } else {
        record('SETTLE_ARMING_RESTRICTION', 'SKIPPED');
      }
    } catch {
      threw = true;
      record('SETTLE_ARMING_RESTRICTION', 'THREW');
    }

    // (6) Release the genuine lease.
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

    // (7) Release the telemetry pause tokens LAST, and only then.
    let telemetryReleased = false;
    if (exclusivityGone) {
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

    const complete = exclusivityGone && !threw;
    if (!complete) {
      // Cleanup-incomplete is a FAULT condition requiring a full session
      // reset - never reported as a successful teardown.
      const faultReason: MotorTestFaultReason = exclusivityGone
        ? 'NATIVE_EXCEPTION'
        : 'STOP_FAILED';
      this.dispatchFault(faultReason);
      this.outcome = Object.freeze({
        kind: 'FAILED_CLOSED' as const,
        reason: 'TEARDOWN_INCOMPLETE' as const,
        faultReason,
        requiresNewSession: true as const,
      });
    }

    this.teardownReport = Object.freeze({
      steps: Object.freeze(steps),
      armingRestrictionRemovalSupported: false as const,
      armingRestrictionRemovalPerformed: false as const,
      armingRestrictionReceiptCurrentAtTeardown: receiptCurrent,
      leaseRelease,
      telemetryTokensReleased: telemetryReleased,
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
 * Recognizes "the exchange completed but the answer was unusable" from
 * the accepted identification contract. Name-based, because both accepted
 * error classes extend `Error` and only their names are part of the
 * contract this module may rely on.
 */
function isEvidenceQualityError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.name === 'MspPayloadReadError' ||
    error.name === 'MspIncompatibleFirmwareError'
  );
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
 * The returned object is a frozen literal with exactly five methods, so
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
    close: () => controller.close(),
  });
}
