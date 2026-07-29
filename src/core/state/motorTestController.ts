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
 * There are 15 call sites of the two boundary guards in this file: 14
 * are boundary checks on the setup path, and the 15th is `revalidate`'s
 * own internal delegation to `cancellation` (a cancelled continuation is
 * cancelled first, whatever the session says). Two of the 14 live inside
 * `readDecoded`, which runs once per config read, so a full successful
 * setup evaluates more guards than there are sites.
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
 * request is sent, `Ready` is unreachable and `telemetryHeld` stays false.
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
 * snapshot carries it in `continuousSafetyMonitoring`.
 *
 * REPAIR PASS R1 CORRECTION. That report used to be INERT: the gap was
 * published as data and then ignored by the activation gate, so a session
 * whose one-shot setup checks all passed could still activate a motor
 * with nothing watching the live condition. It is now an AUTHORITATIVE
 * BLOCKER - `evaluateActivation()` checks it first, on every evaluation,
 * and refuses activation while no accepted source exists. R1 does not
 * implement such a source; it stops the absence from being survivable.
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
  MSP_SET_MOTOR,
} from '../protocol/msp/commands/mspCommands';
// Phase 2F. The encoder and the vector builders are ACCEPTED, PROTECTED
// modules and are reused unchanged - this controller neither duplicates
// their logic nor introduces a second encoder. `assertSupportedMotorScope`
// rejects 3D FIRST (3D inverts stop semantics), then a motor count other
// than four, then any raw protocol other than DSHOT600 at the pinned tag.
import {
  assertSupportedMotorScope,
  buildAllStopVector,
  buildSingleMotorVector,
  MOTOR_VECTOR_MOTOR_COUNT,
  type MotorVectorScope,
} from '../firmware-adapters/betaflightMotorVectorsV147';
import {
  readContinuousSafetyMonitoring,
  type MotorTestContinuousSafetyMonitoringState,
} from './motorTestContinuousSafetyMonitor';
import {
  encodeSetMotorPayload,
  MSP_SET_MOTOR_SUPPORTED_MOTOR_COUNT,
} from '../protocol/msp/encoding/encodeSetMotorPayload';
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
  dispositionForStopReason,
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
  /** Correction B-1: the telemetry anchor belongs to a different client
   * than the one this controller would lease, so quieting it would prove
   * nothing about the link actually used. */
  | 'TELEMETRY_SESSION_CLIENT_MISMATCH'
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
  /** Phase 2F: the required command-214 all-stop attempt. Ordered AFTER
   * authority validation and BEFORE any arming-restriction settlement, so
   * the outputs are commanded to stop before anything that could relax
   * the FC's arming restriction. */
  | 'EXECUTE_STOP_VECTOR'
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

/** Operator-facing motor numbers. These are MSP OUTPUT SLOTS, never
 * airframe positions and never rotation directions. */
export const MOTOR_TEST_PULSE_MOTOR_NUMBERS: readonly number[] = Object.freeze(
  [1, 2, 3, 4],
);

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
 * does. Nothing here re-derives battery, armed, lease, authority, scope or
 * capability safety.
 */
export type MotorTestActivationBlockReason =
  | 'CONTROLLER_CLOSED'
  /** A locking safety event has occurred. See the activation bar. */
  | 'SAFETY_EVENT_LATCHED'
  | 'STOP_IN_PROGRESS'
  /** A stop already ended unsafely. Permanent for this session. */
  | 'STOP_SEALED'
  | 'PULSE_ALREADY_LIVE'
  | 'SETUP_NOT_READY'
  | 'MACHINE_NOT_READY'
  | 'TELEMETRY_BARRIER_NOT_HELD'
  | 'ARMING_RESTRICTION_NOT_CURRENT'
  | 'MOTOR_SCOPE_UNSUPPORTED'
  | 'AUTHORITY_STALE'
  /**
   * R1 - NO ACCEPTED, FRESH, SESSION-BOUND CONTINUOUS SAFETY MONITOR.
   *
   * Every other gate in this list is ONE-SHOT: it proves a condition held
   * before the session began. None of them observes the seconds during
   * which an output may actually be live - if the aircraft arms, the
   * arming restriction is lost, or the battery becomes unsafe WHILE a
   * pulse is running, nothing in this repository would notice.
   *
   * That absence was previously published as data and then ignored by the
   * gate, so activation could proceed anyway. It is now an authoritative
   * blocker: no monitor, no activation.
   */
  | 'CONTINUOUS_SAFETY_MONITORING_UNAVAILABLE';

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
  /** True once the 3-second watchdog was armed. Armed from SUBMISSION
   * START, never from acknowledgement. */
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
    case 'CONTROLLER_CLOSED':
      return 'CONTROLLER_CLOSED';
    case 'STOP_IN_PROGRESS':
    case 'STOP_SEALED':
    case 'PULSE_ALREADY_LIVE':
      return 'STOP_PENDING';
    case 'MACHINE_NOT_READY':
      return 'NOT_READY';
    case 'AUTHORITY_STALE':
      return 'AUTHORITY_STALE';
    case 'SAFETY_EVENT_LATCHED':
    case 'SETUP_NOT_READY':
    case 'TELEMETRY_BARRIER_NOT_HELD':
    case 'ARMING_RESTRICTION_NOT_CURRENT':
    case 'MOTOR_SCOPE_UNSUPPORTED':
    case 'CONTINUOUS_SAFETY_MONITORING_UNAVAILABLE':
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

/** The maximum time a pulse may remain logically live, measured from
 * SUBMISSION START - not from acknowledgement. */
export const MOTOR_TEST_PULSE_MAX_DURATION_MILLIS = 3000;

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
   * 214, making any apparent acknowledgement unattributable. A full
   * session reset is required; the lease is failed closed.
   */
  readonly attributionAmbiguous: boolean;
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
  wirePreemptionClaimed: false as const,
  submittedNextOnTransport: false,
  episodeId: 0,
  outcome: undefined,
});

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
  /** Phase 2F: the command-214 stop execution record. */
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
   * The open signal gap, carried in the data rather than only in a
   * comment: no accepted source can provide continuous armed-state,
   * arming-restriction-loss or battery monitoring while the barrier is
   * held, so this controller does not monitor them and does not claim to.
   */
  /**
   * The live continuous-monitoring state, read fresh on every publish.
   *
   * R1: in production this is ALWAYS
   * `'UNAVAILABLE_NO_ACCEPTED_SOURCE'` - the reader is hard-wired (see
   * motorTestContinuousSafetyMonitor.ts) - and that value is now an
   * authoritative activation blocker rather than an inert note. The type
   * admits the available case only so the gate can express what it is
   * checking for; nothing in production produces it.
   */
  readonly continuousSafetyMonitoring: MotorTestContinuousSafetyMonitoringState;
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
  /** Phase 2F: the approved motor scope, captured from the SAME static
   * facts the profile gates were evaluated against. Undefined until those
   * facts exist, which is what makes a pre-evidence stop unattemptable. */
  private motorScope: MotorVectorScope | undefined;
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
  /**
   * Set once a stop episode ended unsafely (failed, ambiguous, or never
   * attributably completed). A sealed stop can NEVER be rearmed - the
   * session is finished and only a full reset may follow.
   */
  private stopSealed = false;

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
   * while idle (armed state detected, arming restriction removed, battery
   * changed or became unsafe, navigation blur, background) leaves the
   * machine in `Ready` - and `Ready` is exactly what this controller's
   * activation gate consults.
   *
   * Without this bar, a battery that just became unsafe would still admit
   * a fresh pulse. The precondition that event invalidated has not come
   * back, so activation is barred for the rest of this session. Normal
   * reasons - release, stop button, motor switch, deadline - never set it.
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
      stopExecution: this.stopExecution,
      pulse: this.pulse,
      activation: this.evaluateActivation(),
      verificationReceipt: this.evaluateVerificationReceipt(),
      // Read FRESH, never cached at construction: a value captured once
      // could outlive the condition it described.
      continuousSafetyMonitoring: readContinuousSafetyMonitoring(),
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
    this.clearPulseDeadline();
    const dominated = this.pulseAttempt !== undefined;
    if (dominated) {
      this.endPulseAttempt({kind: 'FAILED', reason: 'STOP_DOMINATED'});
    }
    this.dispatchStop(trigger);
    if (this.pulseMayHaveReachedFc) {
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
    if (
      !Number.isInteger(motorNumber) ||
      motorNumber < 1 ||
      motorNumber > MOTOR_VECTOR_MOTOR_COUNT
    ) {
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
    const scope = this.motorScope as MotorVectorScope;
    const lease = this.lease as MotorTestLease;
    const authority = this.authority as MspOfficialSessionAuthority;

    let payload: Uint8Array;
    try {
      payload = encodeSetMotorPayload(
        buildSingleMotorVector(
          scope,
          motorNumber - 1,
          MOTOR_TEST_FIXED_PULSE_VALUE,
        ),
        MSP_SET_MOTOR_SUPPORTED_MOTOR_COUNT,
      );
    } catch {
      // Zero transport traffic on any scope, index or encoding refusal.
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

    // (6) Submit through the ordinary lease FIFO. The stop deliberately
    //     does NOT share this route - it uses the priority route, which is
    //     what lets it displace this very request.
    this.runPulse(attempt, authority, lease, payload).catch(() => undefined);

    this.publish();
    return 'ACCEPTED';
  }

  /**
   * THE authoritative activation evaluation. Every accepted guard, all at
   * once, in one place. Called by `pulseMotor()` before any activation and
   * published verbatim on every snapshot.
   *
   * Deliberately collects EVERY blocking reason rather than short-
   * circuiting on the first: a screen that shows only "not ready" when
   * three separate preconditions are unmet teaches the operator nothing.
   */
  private evaluateActivation(): MotorTestActivationGate {
    const reasons: MotorTestActivationBlockReason[] = [];

    // R1 - CHECKED FIRST, and read FRESH on every evaluation.
    //
    // Placed ahead of every one-shot gate deliberately: those gates all
    // describe the past, and this one describes whether anything is
    // watching the present. A session whose setup checks all passed is
    // still not safe to activate if nothing is observing armed state,
    // arming-restriction loss or battery condition while an output is
    // live. Anything that is not an accepted live source fails closed.
    if (readContinuousSafetyMonitoring() !== 'AVAILABLE_ACCEPTED_SOURCE') {
      reasons.push('CONTINUOUS_SAFETY_MONITORING_UNAVAILABLE');
    }

    if (this.phase === 'CLOSED' || this.phase === 'CLOSING' || this.closing) {
      reasons.push('CONTROLLER_CLOSED');
    }
    if (this.activationBarred) {
      reasons.push('SAFETY_EVENT_LATCHED');
    }
    if (this.stopSealed) {
      reasons.push('STOP_SEALED');
    }
    if (this.stopInFlight !== undefined) {
      reasons.push('STOP_IN_PROGRESS');
    }
    if (this.pulseAttempt !== undefined) {
      reasons.push('PULSE_ALREADY_LIVE');
    }
    if (this.phase !== 'ACTIVE' || this.outcome.kind !== 'READY') {
      reasons.push('SETUP_NOT_READY');
    }
    if (this.machine === undefined || this.machine.name !== 'Ready') {
      reasons.push('MACHINE_NOT_READY');
    }
    if (this.barrier === undefined) {
      reasons.push('TELEMETRY_BARRIER_NOT_HELD');
    }
    if (
      this.armingRestriction.kind !== 'ESTABLISHED' ||
      this.receipt === undefined ||
      !this.receipt.isCurrent()
    ) {
      reasons.push('ARMING_RESTRICTION_NOT_CURRENT');
    }
    if (this.motorScope === undefined) {
      reasons.push('MOTOR_SCOPE_UNSUPPORTED');
    } else {
      try {
        // The accepted guard, re-run LIVE on every evaluation: 3D
        // disabled, exactly four motors, DSHOT600 raw. Never trusted from
        // setup alone.
        assertSupportedMotorScope(this.motorScope);
      } catch {
        reasons.push('MOTOR_SCOPE_UNSUPPORTED');
      }
    }
    // Authority and lease by REFERENCE, never by value.
    const lease = this.lease;
    const authority = this.authority;
    if (
      lease === undefined ||
      authority === undefined ||
      !lease.isActive() ||
      lease.officialSessionAuthority() !== authority ||
      this.machine?.authority !== authority
    ) {
      reasons.push('AUTHORITY_STALE');
    }

    if (reasons.length === 0) {
      return ACTIVATION_ALLOWED;
    }
    return Object.freeze({allowed: false, reasons: Object.freeze(reasons)});
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

  private async runPulse(
    attempt: object,
    authority: MspOfficialSessionAuthority,
    lease: MotorTestLease,
    payload: Uint8Array,
  ): Promise<void> {
    try {
      await lease.request(MSP_SET_MOTOR, payload, READ_REQUEST_OPTIONS);
    } catch {
      // Write failure, response timeout, desync, detach, close, or
      // displacement by our own stop. Every one of them ends the attempt
      // and takes the stop route - WITHOUT waiting for the 3-second
      // deadline, which would leave a possibly-live output commanded for
      // the full window after we already know something went wrong.
      if (this.pulseAttempt === attempt) {
        this.endPulseAttempt({kind: 'FAILED', reason: 'REQUEST_FAILED'});
        this.failPulseClosed('WRITE_OUTCOME_UNKNOWN');
      }
      return;
    }

    // A response arrived. It counts ONLY if this exact attempt is still
    // live and the session it was submitted under has not moved.
    if (this.pulseAttempt !== attempt) {
      // Stale: a stop, a fault, a close or a newer attempt already ended
      // this one. Discarded entirely - it cannot re-enter Pulsing, cannot
      // clear a Fault, cannot cancel a stop, and cannot touch whatever
      // session replaced this one.
      return;
    }
    if (
      this.closing ||
      this.lease !== lease ||
      this.authority !== authority ||
      !lease.isActive() ||
      lease.officialSessionAuthority() !== authority
    ) {
      this.endPulseAttempt({kind: 'FAILED', reason: 'AUTHORITY_CHANGED'});
      this.failPulseClosed('SESSION_CHANGED');
      return;
    }

    // Attributable, and no stop is pending. Only now may Pulsing be
    // entered. ACK is reception - it is not motion, not RPM, not
    // direction and not a frame position.
    this.pulse = Object.freeze({
      ...this.pulse,
      acknowledged: true,
      outcome: {kind: 'ACKNOWLEDGED' as const},
    });
    this.apply({authority, kind: 'START_ACKNOWLEDGED'}, undefined);
    this.publish();
  }

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
      // The DESIGNED maximum-duration cutoff. An ordinary stop reason, not
      // a fault: the machine only faults if the stop itself fails.
      this.requestStop('PULSE_DEADLINE_ELAPSED');
    }, MOTOR_TEST_PULSE_MAX_DURATION_MILLIS);
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

    // Phase 2F: capture the approved motor scope from the SAME facts the
    // profile gates are about to be evaluated against. Nothing is
    // re-read and nothing is defaulted, so a stop can never be encoded
    // from a different reading than the one that authorised the session.
    const facts = staticFacts.binding.facts;
    this.motorScope = Object.freeze({
      motorCount: facts.motorCount,
      motorProtocolRaw: facts.motorProtocolRaw,
      feature3dEnabled: facts.feature3dEnabled,
    });

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
        }
        // ALWAYS publish. A stop that completes outside teardown - the
        // interactive case, which is every release, deadline and safety
        // event - updates the stop record asynchronously, and a subscriber
        // that never sees it cannot report what actually happened.
        this.publish();
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

  private async runStopVector(): Promise<MotorTestStopExecutionOutcome> {
    const lease = this.lease;
    const authority = this.authority;
    const scope = this.motorScope;

    let deferred = false;
    let ambiguous = false;
    let submittedNext = false;

    const settle = (
      outcome: MotorTestStopExecutionOutcome,
      dispatched: boolean,
      acknowledged: boolean,
    ): MotorTestStopExecutionOutcome => {
      this.stopExecution = Object.freeze({
        attempts: this.stopExecution.attempts + 1,
        commandDispatched: this.stopExecution.commandDispatched || dispatched,
        commandAcknowledged:
          this.stopExecution.commandAcknowledged || acknowledged,
        physicalStopConfirmed: false as const,
        deferredBehindActiveWrite:
          this.stopExecution.deferredBehindActiveWrite || deferred,
        attributionAmbiguous:
          this.stopExecution.attributionAmbiguous || ambiguous,
        wirePreemptionClaimed: false as const,
        submittedNextOnTransport:
          this.stopExecution.submittedNextOnTransport || submittedNext,
        episodeId: this.stopEpisodeId,
        outcome,
      });
      return outcome;
    };

    if (lease === undefined) {
      return settle({kind: 'NOT_ATTEMPTED', reason: 'NO_LEASE'}, false, false);
    }
    if (scope === undefined) {
      return settle({kind: 'NOT_ATTEMPTED', reason: 'NO_SCOPE'}, false, false);
    }
    // Reference identity, before a single byte is built.
    if (
      authority === undefined ||
      !lease.isActive() ||
      lease.officialSessionAuthority() !== authority
    ) {
      return settle(
        {kind: 'NOT_ATTEMPTED', reason: 'AUTHORITY_STALE'},
        false,
        false,
      );
    }

    let payload: Uint8Array;
    try {
      // The accepted guard runs FIRST: 3D, motor count, raw protocol.
      assertSupportedMotorScope(scope);
      payload = encodeSetMotorPayload(
        buildAllStopVector(scope),
        MSP_SET_MOTOR_SUPPORTED_MOTOR_COUNT,
      );
    } catch {
      // Zero transport traffic on any scope or encoding refusal.
      return settle({kind: 'SCOPE_REJECTED'}, false, false);
    }

    // Phase 2G: the stop travels the PRIORITY route, not the ordinary
    // lease FIFO. The client purges everything still queued and makes this
    // the next transport submission. That is submission order only - it
    // preempts nothing already handed to the transport, and the dispatch's
    // own flags below are what keep this record honest about it.
    const dispatch = lease.emergencyStop(
      MSP_SET_MOTOR,
      payload,
      READ_REQUEST_OPTIONS,
    );
    deferred = dispatch.deferredBehindActiveWrite;
    ambiguous = dispatch.attributionAmbiguous;
    // True in every case: the client took this out of its stop slot ahead
    // of the FIFO. When `deferred` is also true it was still the next
    // SUBMISSION - it simply had to wait for an uncancellable write.
    submittedNext = true;

    try {
      await dispatch.frame;
    } catch {
      // Dispatched, outcome unknown. Never a stop.
      return settle(
        {kind: 'FAILED', reason: 'REQUEST_FAILED'},
        true,
        false,
      );
    }

    // The ACK belongs to THIS session or it belongs to nothing.
    if (
      !lease.isActive() ||
      lease.officialSessionAuthority() !== authority ||
      this.authority !== authority
    ) {
      return settle(
        {kind: 'FAILED', reason: 'AUTHORITY_CHANGED'},
        true,
        false,
      );
    }

    // Phase 2G: the response resolved, but it displaced an already-written
    // command 214, so this frame may belong to the DISPLACED request
    // rather than to this stop. Nothing here is an acknowledgement. The
    // lease is failed closed so the identity cannot be reused, forcing a
    // full session reset before any further attempt.
    if (ambiguous) {
      lease.failClosed();
      return settle(
        {kind: 'FAILED', reason: 'ATTRIBUTION_AMBIGUOUS'},
        true,
        false,
      );
    }

    // ACKNOWLEDGED means received and processed. It is NOT a physical
    // stop, and `physicalStopConfirmed` stays false.
    return settle({kind: 'ACKNOWLEDGED'}, true, true);
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
    // Reached directly when teardown is entered without close() - the
    // watchdog must not survive either route.
    this.clearPulseDeadline();
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
    // validated, and BEFORE anything that could settle or relax the FC's
    // arming restriction. Outputs are commanded to stop first.
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
        // actually ended the session (an unestablished arming restriction,
        // an unsupported profile).
        record('EXECUTE_STOP_VECTOR', 'SKIPPED');
      }
    } catch {
      stopUnsafe = true;
      record('EXECUTE_STOP_VECTOR', 'THREW');
    }

    // (6) Settle the arming restriction while the lease is still valid.
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
    pulseMotor: (motorNumber: number) => controller.pulseMotor(motorNumber),
    close: () => controller.close(),
  });
}
