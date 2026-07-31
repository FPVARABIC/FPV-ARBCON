/**
 * Phase 2A - the PURE motor-test safety state machine.
 *
 * WHAT THIS MODULE IS
 * -------------------
 * A deterministic, synchronous reducer over an abstract domain model. It
 * decides WHAT SHOULD HAPPEN NEXT and describes it as inert intent
 * descriptors. It performs nothing.
 *
 * WHAT THIS MODULE IS NOT, BY CONSTRUCTION
 * ----------------------------------------
 * It has ZERO imports. It therefore cannot reach a protocol client, a
 * transport, a native module, React, React Native, navigation or the UI,
 * and no future edit can give it one of those without that import
 * becoming visible in review.
 *
 * It contains no command id, no byte buffer, no payload, no motor value
 * and no pulse magnitude. An "intent" here names an ACTION CATEGORY -
 * "submit the start", "submit the stop" - and deliberately carries no
 * value at all. Choosing any magnitude is a separate, unapproved safety
 * decision, and nothing in this file can express one.
 *
 * It schedules nothing. The pulse deadline is modelled ONLY as an
 * incoming event plus an outgoing "arm the deadline" intent. Whoever
 * drives this reducer owns the real clock; this file owns none.
 *
 * WHY THE SEMANTICS LOOK CONSERVATIVE
 * -----------------------------------
 * Three accepted findings shape every rule below:
 *
 *  1. A start that has been submitted CANNOT be cancelled. From the
 *     moment activation is accepted, the aircraft may become commanded,
 *     so every stop path assumes the start is live rather than assuming
 *     it was dropped.
 *  2. The flight controller applies a motor write BEFORE producing its
 *     acknowledgement. An acknowledgement is therefore evidence about a
 *     message, never about a propeller. Losing one does not mean the
 *     command was not applied.
 *  3. There is no firmware-side inactivity watchdog restoring stop
 *     values. Nothing in this file may be read as proving a motor has
 *     physically stopped.
 *
 * THREE CORRECTIONS MADE IN PHASE 2A.1
 * ------------------------------------
 *  A. A FOREIGN-AUTHORITY EVENT IS IGNORED, NOT FATAL. Phase 2A turned
 *     any event carrying a different authority into a terminal fault,
 *     from every state including the idle ones. That was wrong twice
 *     over: an unrelated or stale continuation could brick an idle
 *     machine, and - far worse - it could brick a LIVE one, after which
 *     the legitimate deadline and the legitimate stop for that same
 *     activation both became no-ops because `Fault` is terminal. A
 *     stranger's token is not permission to alter this machine, so it is
 *     now an identity no-op. Genuine loss of the CURRENT session is a
 *     different thing entirely and must be delivered as a
 *     matching-authority fault (see `motorTestTransition`).
 *
 *  B. EVERY OPERATIONAL FAULT WARNS, NOT ONLY A DETACH. Phase 2A emitted
 *     the physical-disconnect warning only for `USB_DETACHED`, so ten
 *     other reasons could end a live pulse silently. In this reducer a
 *     fault means transport viability is NOT PROVEN, which is exactly
 *     when a possibly-commanded motor cannot be stopped by software. The
 *     policy is now driven by an exhaustive switch, so a future reason
 *     cannot be added without deciding it.
 *
 *  C. AN UNACKNOWLEDGED STOP IS REASSERTED, NOT SUPPRESSED. Phase 2A
 *     emitted one stop intent and then swallowed every later trigger. If
 *     that single intent was lost, nothing ever asked again. Repeated
 *     triggers now re-emit the stop descriptor until it is acknowledged.
 *     STATE and DISPOSITION coalesce; the safety request does not.
 *
 * ONE FURTHER CORRECTION IN PHASE 2A.2
 * ------------------------------------
 *  D. `Fault` NO LONGER SWALLOWS A STILL-APPLICABLE STOP REQUEST.
 *     Correction C fixed reassertion inside `Stopping`, but `Fault`
 *     remained a blanket no-op, so the LAST descriptor emitted before a
 *     fault was the last one that could ever exist. That turned a bare
 *     historical emission into proof that no further stop was needed -
 *     which it never was.
 *
 *     Emitting `SUBMIT_STOP_INTENT` proves ONLY that this reducer asked.
 *     It does not prove that any executor accepted, queued, retained,
 *     began or wrote it, that an acknowledgement arrived, that an
 *     equivalent stop is otherwise guaranteed, or that a motor stopped.
 *     This module has no delivery handshake and must invent none, so it
 *     cannot know that a previous request survived - and therefore must
 *     not treat "one was emitted once" as a reason to stay silent.
 *
 *     So: while a command may be live, a matching-authority
 *     STOP_TRIGGERED arriving in `Fault` re-emits the inert descriptor.
 *     `Fault` stays `Fault` - the very same frozen object, with the same
 *     reason, authority and liveness - so this is emphatically NOT
 *     operational recovery. Nothing is unlocked; the machine merely
 *     keeps saying "a stop is still required" for as long as something
 *     keeps asking.
 *
 *     A fault raised from an idle state carries
 *     `startMayHaveReachedFc === false`, and there a stop request stays
 *     inert: no command was ever submitted, so asking for a stop would
 *     manufacture traffic for an activation that never happened.
 *
 * Consequently: an acknowledgement never starts, extends or resets the
 * pulse deadline; stop always outranks start progression; and `Fault`
 * remains terminal for operational purposes under the session authority
 * it was raised under.
 */

/**
 * One official MSP session, as an OPAQUE IDENTITY.
 *
 * Compared with `===` and never inspected, never enumerated, never
 * serialized. Declared structurally empty on purpose: this module must
 * not know, and must not be able to learn, anything about the session it
 * is scoped to. A driver passes whatever non-forgeable anchor object the
 * protocol layer already mints; this file only asks "is it the same one".
 */
export type MotorTestSessionAuthority = object;

/** The seven top-level states. There is deliberately no eighth. */
export type MotorTestStateName =
  | 'Checking'
  | 'Locked'
  | 'Ready'
  | 'Starting'
  | 'Pulsing'
  | 'Stopping'
  | 'Fault';

/**
 * Where a successful stop is allowed to leave the machine.
 *
 * Ordered by severity - see `escalateDisposition`. A stop that began as
 * an ordinary release can be escalated by a later, worse trigger, and can
 * never be de-escalated afterwards.
 */
export type MotorTestStopDisposition = 'Ready' | 'Locked' | 'Fault';

/**
 * Ordinary end-of-pulse reasons. A confirmed stop returns to `Ready`
 * without re-running the safety gates, because nothing observed suggests
 * the aircraft or session changed.
 */
export type MotorTestNormalStopReason =
  | 'TOUCH_RELEASED'
  | 'STOP_BUTTON_PRESSED'
  | 'MOTOR_SELECTION_CHANGED'
  /** The planned maximum-duration cutoff. This is a DESIGNED safety
   * limit, not a communication failure, so on a confirmed stop it is an
   * ordinary completion - never automatically a fault. */
  | 'PULSE_DEADLINE_ELAPSED';

/**
 * Reasons that invalidate the preconditions themselves. A confirmed stop
 * leaves the machine `Locked`, so the gates must pass again before any
 * further activation.
 */
export type MotorTestLockingStopReason =
  | 'NAVIGATION_BLURRED'
  | 'ANDROID_BACK'
  | 'ANDROID_PREDICTIVE_BACK'
  | 'APP_STATE_BACKGROUNDED'
  | 'ARMED_STATE_DETECTED'
  | 'ARMING_RESTRICTION_REMOVED'
  | 'BATTERY_CHANGED'
  | 'BATTERY_BECAME_UNSAFE'
  /**
   * The dedicated safety observation path stopped being able to prove the
   * flight controller disarmed - a rejected read, a malformed response, an
   * identity that moved under the read, or a reading that aged out.
   *
   * ADDED BECAUSE THE ALTERNATIVE WAS A LIE. A monitoring failure used to
   * be reported as `BATTERY_BECAME_UNSAFE`, which is the only locking
   * reason that happened to be close enough to reuse. Nothing had observed
   * the battery; the session was stopped for the right cause under the
   * wrong name, and the operator was told about a pack that was never read.
   */
  | 'SAFETY_MONITORING_FAILED';

export type MotorTestStopTriggerReason =
  | MotorTestNormalStopReason
  | MotorTestLockingStopReason;

/**
 * Conditions under which the session is no longer trustworthy at all.
 * Every one of these is terminal for the current authority.
 *
 * `SESSION_CHANGED` and `AUTHORITY_MISMATCH` are how a driver reports
 * GENUINE loss of the session this machine is bound to. They must be
 * delivered stamped with THIS machine's authority - the arrival of some
 * other authority's token is not itself such a report. See correction A
 * in this file's own doc comment.
 */
export type MotorTestFaultReason =
  | 'MSP_RESPONSE_TIMEOUT'
  | 'TRANSPORT_WRITE_TIMEOUT'
  | 'WRITE_FAILED'
  | 'WRITE_OUTCOME_UNKNOWN'
  | 'DESYNCHRONIZED'
  | 'SESSION_CHANGED'
  | 'USB_DETACHED'
  | 'NATIVE_EXCEPTION'
  | 'STOP_FAILED'
  | 'STOP_TIMEOUT'
  | 'AUTHORITY_MISMATCH';

/**
 * The exact operator-facing warning required whenever a motor may be
 * commanded and the machine can no longer even attempt a stop.
 *
 * Exported as a value so a UI layer references THIS constant rather than
 * retyping the sentence. This module never renders anything.
 */
export const MOTOR_TEST_STOP_UNCONFIRMED_WARNING =
  'Unable to confirm stop — disconnect LiPo immediately';

/* ------------------------------------------------------------------ *
 * Intents - inert descriptors, never actions
 * ------------------------------------------------------------------ */

/**
 * What the driver should do next.
 *
 * `SUBMIT_START_INTENT` and `SUBMIT_STOP_INTENT` carry NO value: not a
 * command id, not a motor index, not a magnitude, not a buffer. They say
 * only "a start was requested" and "a stop is required". Turning either
 * into anything that could reach an aircraft is a separate, unapproved
 * pass, and this file cannot describe it.
 *
 * `SUBMIT_STOP_INTENT` is IDEMPOTENT BY CONTRACT. It may be emitted more
 * than once for one activation - see correction C - and a driver must
 * treat a repeat as "the same stop is still required", never as a second
 * distinct stop.
 */
export type MotorTestEffect =
  | {readonly kind: 'SUBMIT_START_INTENT'}
  | {readonly kind: 'SUBMIT_STOP_INTENT'}
  /** Begin the maximum-duration cutoff. Emitted exactly once per
   * activation, at the moment the start write is called - never on an
   * acknowledgement, and never again once armed. */
  | {readonly kind: 'ARM_PULSE_DEADLINE'}
  /** Surface MOTOR_TEST_STOP_UNCONFIRMED_WARNING. Emitted when a fault
   * ends an activation while a command may be live. */
  | {readonly kind: 'SHOW_STOP_UNCONFIRMED_WARNING'; readonly message: string};

/* Deeply frozen singletons. Effect objects are shared and immutable, so
 * a consumer cannot mutate one and have that change observed by another
 * holder, and `readonly` (erased at runtime) is never the only defence.
 * Constructing these is the ONLY thing this module does at load time. */
const SUBMIT_START_INTENT: MotorTestEffect = Object.freeze({
  kind: 'SUBMIT_START_INTENT' as const,
});
const SUBMIT_STOP_INTENT: MotorTestEffect = Object.freeze({
  kind: 'SUBMIT_STOP_INTENT' as const,
});
const ARM_PULSE_DEADLINE: MotorTestEffect = Object.freeze({
  kind: 'ARM_PULSE_DEADLINE' as const,
});
const SHOW_STOP_UNCONFIRMED_WARNING: MotorTestEffect = Object.freeze({
  kind: 'SHOW_STOP_UNCONFIRMED_WARNING' as const,
  message: MOTOR_TEST_STOP_UNCONFIRMED_WARNING,
});

const NO_EFFECTS: readonly MotorTestEffect[] = Object.freeze([]);
const START_EFFECTS: readonly MotorTestEffect[] = Object.freeze([
  SUBMIT_START_INTENT,
]);
const STOP_EFFECTS: readonly MotorTestEffect[] = Object.freeze([
  SUBMIT_STOP_INTENT,
]);
const DEADLINE_EFFECTS: readonly MotorTestEffect[] = Object.freeze([
  ARM_PULSE_DEADLINE,
]);
const WARNING_EFFECTS: readonly MotorTestEffect[] = Object.freeze([
  SHOW_STOP_UNCONFIRMED_WARNING,
]);

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

/**
 * Every event carries the authority it was produced under, so a
 * continuation belonging to another session is recognizable as such
 * before it can influence anything.
 */
export interface MotorTestEventBase {
  readonly authority: MotorTestSessionAuthority;
}

export type MotorTestEvent = MotorTestEventBase &
  (
    | {readonly kind: 'GATES_PASSED'}
    | {readonly kind: 'GATES_FAILED'}
    | {readonly kind: 'RECHECK_REQUESTED'}
    /** Long-press accepted. Produces the start intent; from here on the
     * start is considered uncancellable. */
    | {readonly kind: 'ACTIVATION_ACCEPTED'}
    /** The transport write call for the start has been made. The command
     * may now have reached the aircraft. */
    | {readonly kind: 'START_WRITE_CALLED'}
    /** Acknowledgement for the start. Metadata only - see the file
     * comment on why this proves nothing physical. */
    | {readonly kind: 'START_ACKNOWLEDGED'}
    | {
        readonly kind: 'STOP_TRIGGERED';
        readonly reason: MotorTestStopTriggerReason;
      }
    | {readonly kind: 'STOP_ACKNOWLEDGED'}
    | {readonly kind: 'FAULT_RAISED'; readonly reason: MotorTestFaultReason}
  );

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

/**
 * Immutable bookkeeping for an in-progress stop.
 *
 * This is why there is no eighth top-level state: the difference between
 * "released normally" and "stopping because the battery went unsafe" is
 * DATA about one stop, not a different place in the machine.
 *
 * There is deliberately NO `stopIntentIssued` field. Phase 2A carried
 * one, wrote it once and never read it, and its name implied a
 * suppression rule that must not exist: an unacknowledged safety stop is
 * reasserted, not remembered as already done.
 */
export interface MotorTestStoppingMetadata {
  /** The trigger that first demanded the stop. Never overwritten by a
   * later trigger - only `requiredDisposition` escalates. */
  readonly stopReason: MotorTestStopTriggerReason;
  /** Conservatively true from the moment activation is accepted: a
   * submitted start cannot be recalled, so it may still reach the
   * aircraft even if the write call has not happened yet. */
  readonly startMayHaveReachedFc: boolean;
  /** Where a CONFIRMED stop is allowed to land. Monotonic. */
  readonly requiredDisposition: MotorTestStopDisposition;
  /** The authority everything here was captured under. */
  readonly authority: MotorTestSessionAuthority;
  /** Whether the start was acknowledged. Recorded for observability
   * only; it changes no decision. */
  readonly startAcknowledged: boolean;
}

export type MotorTestState =
  | {readonly name: 'Checking'; readonly authority: MotorTestSessionAuthority}
  | {readonly name: 'Locked'; readonly authority: MotorTestSessionAuthority}
  | {readonly name: 'Ready'; readonly authority: MotorTestSessionAuthority}
  | {
      readonly name: 'Starting';
      readonly authority: MotorTestSessionAuthority;
      /** Always true - the start intent was emitted on entry. */
      readonly startSubmitted: boolean;
    }
  | {
      readonly name: 'Pulsing';
      readonly authority: MotorTestSessionAuthority;
      /** Armed on entry, at the write call. Never re-armed. */
      readonly pulseDeadlineArmed: boolean;
      readonly startAcknowledged: boolean;
    }
  | {
      readonly name: 'Stopping';
      readonly authority: MotorTestSessionAuthority;
      readonly stopping: MotorTestStoppingMetadata;
    }
  | {
      readonly name: 'Fault';
      readonly authority: MotorTestSessionAuthority;
      readonly faultReason: MotorTestFaultReason;
      /**
       * Permanently recorded, because it is the difference between "an
       * idle screen failed" and "a motor may still be turning". A UI
       * reads THIS, not the fault reason, to decide whether the operator
       * must physically disconnect the battery.
       */
      readonly startMayHaveReachedFc: boolean;
    };

export interface MotorTestTransition {
  readonly state: MotorTestState;
  readonly effects: readonly MotorTestEffect[];
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Compile-time exhaustiveness. Deliberately does NOT throw: a reducer
 * on a safety path must not turn an unforeseen input into an exception.
 * If a variant is ever added without being handled, this stops
 * compiling, which is where the problem belongs. */
function assertExhaustive(value: never): void {
  // The parameter is deliberately returned rather than discarded: a
  // `never` value is assignable to `void`, so this both consumes it and
  // keeps the guard free of any runtime behaviour.
  return value;
}

/**
 * The disposition a stop reason asks for on its own. Normal reasons ask
 * for `Ready`; everything else invalidated a precondition and asks for
 * `Locked`. Neither ever asks for `Fault` - a fault is raised by its own
 * event, never inferred from a stop reason.
 *
 * An exhaustive switch rather than a lookup table: adding a stop reason
 * without deciding its disposition must fail to compile.
 */
export function dispositionForStopReason(
  reason: MotorTestStopTriggerReason,
): MotorTestStopDisposition {
  switch (reason) {
    case 'TOUCH_RELEASED':
    case 'STOP_BUTTON_PRESSED':
    case 'MOTOR_SELECTION_CHANGED':
    case 'PULSE_DEADLINE_ELAPSED':
      return 'Ready';
    case 'NAVIGATION_BLURRED':
    case 'ANDROID_BACK':
    case 'ANDROID_PREDICTIVE_BACK':
    case 'APP_STATE_BACKGROUNDED':
    case 'ARMED_STATE_DETECTED':
    case 'ARMING_RESTRICTION_REMOVED':
    case 'BATTERY_CHANGED':
    case 'BATTERY_BECAME_UNSAFE':
    case 'SAFETY_MONITORING_FAILED':
      return 'Locked';
    default:
      assertExhaustive(reason);
      // Unreachable. Chosen anyway as the strictest of the two values a
      // stop reason may request, so an unforeseen reason can never be
      // treated as an ordinary release.
      return 'Locked';
  }
}

/**
 * Whether a fault reason may end an activation silently.
 *
 * `WARN_IF_COMMAND_MAY_BE_LIVE` means: if the start may already have
 * crossed the write boundary, the operator must be told to disconnect
 * the battery, because this reducer cannot prove the transport is still
 * able to carry a stop.
 *
 * `NEVER_WARN` exists for a future reason that PROVABLY cannot leave a
 * motor commanded. No current reason qualifies, so nothing maps to it
 * today - and a new reason cannot be added without choosing one of the
 * two, because the switch below is exhaustive.
 */
export type MotorTestFaultWarningPolicy =
  | 'WARN_IF_COMMAND_MAY_BE_LIVE'
  | 'NEVER_WARN';

export function faultWarningPolicy(
  reason: MotorTestFaultReason,
): MotorTestFaultWarningPolicy {
  switch (reason) {
    case 'MSP_RESPONSE_TIMEOUT':
    case 'TRANSPORT_WRITE_TIMEOUT':
    case 'WRITE_FAILED':
    case 'WRITE_OUTCOME_UNKNOWN':
    case 'DESYNCHRONIZED':
    case 'SESSION_CHANGED':
    case 'USB_DETACHED':
    case 'NATIVE_EXCEPTION':
    case 'STOP_FAILED':
    case 'STOP_TIMEOUT':
    case 'AUTHORITY_MISMATCH':
      return 'WARN_IF_COMMAND_MAY_BE_LIVE';
    default:
      assertExhaustive(reason);
      // Unreachable. Defaults to warning, because a silent end to a
      // possibly-live command is the failure this policy exists to
      // prevent.
      return 'WARN_IF_COMMAND_MAY_BE_LIVE';
  }
}

function dispositionRank(disposition: MotorTestStopDisposition): number {
  switch (disposition) {
    case 'Ready':
      return 0;
    case 'Locked':
      return 1;
    case 'Fault':
      return 2;
    default:
      assertExhaustive(disposition);
      return 2;
  }
}

/** Monotonic: severity may only increase. A later, milder trigger can
 * never soften an earlier, worse one. */
export function escalateDisposition(
  current: MotorTestStopDisposition,
  next: MotorTestStopDisposition,
): MotorTestStopDisposition {
  return dispositionRank(next) > dispositionRank(current) ? next : current;
}

function transition(
  state: MotorTestState,
  effects: readonly MotorTestEffect[],
): MotorTestTransition {
  return Object.freeze({state, effects});
}

function stay(state: MotorTestState): MotorTestTransition {
  return transition(state, NO_EFFECTS);
}

const checking = (authority: MotorTestSessionAuthority): MotorTestState =>
  Object.freeze({name: 'Checking' as const, authority});
const locked = (authority: MotorTestSessionAuthority): MotorTestState =>
  Object.freeze({name: 'Locked' as const, authority});
const ready = (authority: MotorTestSessionAuthority): MotorTestState =>
  Object.freeze({name: 'Ready' as const, authority});

function stopping(
  authority: MotorTestSessionAuthority,
  metadata: MotorTestStoppingMetadata,
): MotorTestState {
  return Object.freeze({
    name: 'Stopping' as const,
    authority,
    stopping: Object.freeze(metadata),
  });
}

/**
 * The single place a fault is constructed.
 *
 * `startMayHaveReachedFc` is supplied by the caller from the state being
 * left, so it records what was true at the moment of failure and stays
 * true for the whole terminal life of the machine. The warning is
 * emitted iff a command may be live AND the reason's policy says so -
 * and a fault NEVER emits a stop intent, because a fault is exactly the
 * situation in which the transport cannot be trusted to carry one.
 */
function faulted(
  authority: MotorTestSessionAuthority,
  faultReason: MotorTestFaultReason,
  startMayHaveReachedFc: boolean,
): MotorTestTransition {
  const warn =
    startMayHaveReachedFc &&
    faultWarningPolicy(faultReason) === 'WARN_IF_COMMAND_MAY_BE_LIVE';
  return transition(
    Object.freeze({
      name: 'Fault' as const,
      authority,
      faultReason,
      startMayHaveReachedFc,
    }),
    warn ? WARNING_EFFECTS : NO_EFFECTS,
  );
}

/**
 * Entering a stop from an operational state.
 *
 * `startMayHaveReachedFc` is true for every caller here, because both
 * `Starting` and `Pulsing` sit after the point where the start became
 * uncancellable.
 */
function beginStopping(
  authority: MotorTestSessionAuthority,
  reason: MotorTestStopTriggerReason,
  startAcknowledged: boolean,
): MotorTestTransition {
  return transition(
    stopping(authority, {
      stopReason: reason,
      startMayHaveReachedFc: true,
      requiredDisposition: dispositionForStopReason(reason),
      authority,
      startAcknowledged,
    }),
    STOP_EFFECTS,
  );
}

/* ------------------------------------------------------------------ *
 * Construction
 * ------------------------------------------------------------------ */

/**
 * A fresh machine always begins in `Checking`: no activation is possible
 * until the gates have actually been evaluated for THIS authority.
 *
 * Recovery from `Fault` is deliberately NOT a transition. It is this
 * function, called again with a genuinely new authority.
 */
export function createMotorTestState(
  authority: MotorTestSessionAuthority,
): MotorTestState {
  return checking(authority);
}

/* ------------------------------------------------------------------ *
 * The reducer
 * ------------------------------------------------------------------ */

/**
 * Pure transition. Same state plus same event always yields the same
 * result; nothing here reads a clock, a random source or any ambient
 * value.
 *
 * Two rules apply before any per-state handling, in this order:
 *
 *  1. An event carrying a DIFFERENT authority is STALE OR UNRELATED and
 *     is IGNORED, in EVERY state including `Fault`: the state is
 *     returned unchanged, with zero effects and the machine's own
 *     authority intact. It does not fault, does not brick an idle
 *     machine, and above all does not consume the activation - a
 *     legitimate deadline, stop, acknowledgement or fault arriving
 *     afterwards under the RIGHT authority is handled normally. It can
 *     neither establish nor clear nor suppress anything belonging to the
 *     active authority.
 *
 *     Losing the current session is a different fact, and only the
 *     driver can know it. It must be reported as a matching-authority
 *     `FAULT_RAISED` with `SESSION_CHANGED` or `AUTHORITY_MISMATCH`,
 *     which then follows the ordinary operational-fault rules including
 *     the disconnect warning.
 *
 *     Checking authority FIRST is what makes correction D safe: only a
 *     same-authority request may reach the faulted-state handler below.
 *     For every other event this ordering is indistinguishable from the
 *     previous one, since both produced an identity no-op.
 *
 *  2. `Fault` is terminal for OPERATIONAL purposes: no sequence of later
 *     events can produce an operational state again, and the recorded
 *     authority, reason and `startMayHaveReachedFc` are preserved
 *     exactly. A new session means a new machine. It is NOT, however, a
 *     reason to fall silent about a stop that was never confirmed - see
 *     correction D and `reduceFault` below.
 */
export function motorTestTransition(
  state: MotorTestState,
  event: MotorTestEvent,
): MotorTestTransition {
  if (event.authority !== state.authority) {
    return stay(state);
  }
  if (state.name === 'Fault') {
    return reduceFault(state, event);
  }

  switch (state.name) {
    case 'Checking':
      return reduceChecking(state, event);
    case 'Locked':
      return reduceLocked(state, event);
    case 'Ready':
      return reduceReady(state, event);
    case 'Starting':
      return reduceStarting(state, event);
    case 'Pulsing':
      return reducePulsing(state, event);
    case 'Stopping':
      return reduceStopping(state, event);
    default:
      assertExhaustive(state);
      return stay(state);
  }
}

/**
 * Correction D - the ONLY thing a faulted machine still does.
 *
 * Every event returns the SAME frozen `Fault` object, so there is no
 * transition out of `Fault`, no field is rewritten, no authority is
 * substituted and no non-stop effect can be produced. Operational
 * recovery remains impossible; only a fresh machine under a genuinely
 * new authority can operate again.
 *
 * The single difference from a blanket no-op: while `startMayHaveReachedFc`
 * is true, a STOP_TRIGGERED re-emits the inert stop descriptor. The
 * reducer cannot observe whether any earlier descriptor was accepted,
 * delivered, acknowledged or dropped - it has no delivery handshake at
 * all - so refusing to ask again would be asserting a guarantee it does
 * not have. Something is still asking for a stop while a command may be
 * live; the honest answer is to keep asking.
 *
 * When the fault came from an idle state (`startMayHaveReachedFc` false)
 * nothing was ever submitted, so a stop request stays inert rather than
 * inventing traffic for an activation that never began.
 */
function reduceFault(
  state: Extract<MotorTestState, {name: 'Fault'}>,
  event: MotorTestEvent,
): MotorTestTransition {
  if (event.kind === 'STOP_TRIGGERED' && state.startMayHaveReachedFc) {
    return transition(state, STOP_EFFECTS);
  }
  return stay(state);
}

function reduceChecking(
  state: Extract<MotorTestState, {name: 'Checking'}>,
  event: MotorTestEvent,
): MotorTestTransition {
  switch (event.kind) {
    case 'GATES_PASSED':
      return stay(ready(state.authority));
    case 'GATES_FAILED':
      return stay(locked(state.authority));
    case 'FAULT_RAISED':
      // Idle: nothing was ever activated, so no command can be live and
      // a disconnect warning here would be false.
      return faulted(state.authority, event.reason, false);
    default:
      return stay(state);
  }
}

function reduceLocked(
  state: Extract<MotorTestState, {name: 'Locked'}>,
  event: MotorTestEvent,
): MotorTestTransition {
  switch (event.kind) {
    case 'RECHECK_REQUESTED':
      return stay(checking(state.authority));
    case 'FAULT_RAISED':
      return faulted(state.authority, event.reason, false);
    default:
      return stay(state);
  }
}

function reduceReady(
  state: Extract<MotorTestState, {name: 'Ready'}>,
  event: MotorTestEvent,
): MotorTestTransition {
  switch (event.kind) {
    case 'ACTIVATION_ACCEPTED':
      return transition(
        Object.freeze({
          name: 'Starting' as const,
          authority: state.authority,
          startSubmitted: true,
        }),
        START_EFFECTS,
      );
    case 'GATES_FAILED':
      return stay(locked(state.authority));
    case 'FAULT_RAISED':
      return faulted(state.authority, event.reason, false);
    case 'STOP_TRIGGERED':
      // Nothing was ever submitted, so there is nothing to stop and no
      // intent may be produced. Idle release must not manufacture
      // traffic.
      return stay(state);
    default:
      return stay(state);
  }
}

function reduceStarting(
  state: Extract<MotorTestState, {name: 'Starting'}>,
  event: MotorTestEvent,
): MotorTestTransition {
  switch (event.kind) {
    case 'START_WRITE_CALLED':
      // The command may now be live, so the maximum-duration cutoff
      // begins HERE - not at the acknowledgement.
      return transition(
        Object.freeze({
          name: 'Pulsing' as const,
          authority: state.authority,
          pulseDeadlineArmed: true,
          startAcknowledged: false,
        }),
        DEADLINE_EFFECTS,
      );
    case 'STOP_TRIGGERED':
      // The submitted start cannot be recalled. Assume it will reach the
      // aircraft and require a stop rather than hoping it was dropped.
      return beginStopping(state.authority, event.reason, false);
    case 'FAULT_RAISED':
      return faulted(state.authority, event.reason, true);
    case 'GATES_FAILED':
      // DELIBERATELY IGNORED while operational. A gate that goes bad
      // during a live activation is a SAFETY STOP, and this model
      // requires it to arrive as the typed stop reason that says which
      // gate failed (ARMED_STATE_DETECTED, ARMING_RESTRICTION_REMOVED,
      // BATTERY_BECAME_UNSAFE, ...). Silently locking here would end the
      // activation without ever asking for a stop.
      return stay(state);
    default:
      return stay(state);
  }
}

function reducePulsing(
  state: Extract<MotorTestState, {name: 'Pulsing'}>,
  event: MotorTestEvent,
): MotorTestTransition {
  switch (event.kind) {
    case 'START_ACKNOWLEDGED':
      // Metadata only. The deadline is NOT re-armed, NOT extended and
      // NOT restarted, and no intent is produced.
      return stay(
        Object.freeze({
          name: 'Pulsing' as const,
          authority: state.authority,
          pulseDeadlineArmed: state.pulseDeadlineArmed,
          startAcknowledged: true,
        }),
      );
    case 'START_WRITE_CALLED':
      // A duplicate report of the same write. Already pulsing and
      // already armed - re-arming would extend the cutoff, so this is an
      // identity no-op.
      return stay(state);
    case 'STOP_TRIGGERED':
      return beginStopping(
        state.authority,
        event.reason,
        state.startAcknowledged,
      );
    case 'FAULT_RAISED':
      return faulted(state.authority, event.reason, true);
    case 'GATES_FAILED':
      // See reduceStarting - live gate loss must arrive as a typed stop
      // reason, never as a bare gate result.
      return stay(state);
    default:
      return stay(state);
  }
}

function reduceStopping(
  state: Extract<MotorTestState, {name: 'Stopping'}>,
  event: MotorTestEvent,
): MotorTestTransition {
  const authority = state.authority;
  const current = state.stopping;

  switch (event.kind) {
    case 'STOP_TRIGGERED': {
      // Coalesce STATE and DISPOSITION, never the safety request itself.
      // The stop descriptor is re-emitted because the previous one may
      // have been lost, and the driver's contract is that a repeat means
      // "still required", not "a second stop".
      const escalated = escalateDisposition(
        current.requiredDisposition,
        dispositionForStopReason(event.reason),
      );
      return transition(
        stopping(authority, {...current, requiredDisposition: escalated}),
        STOP_EFFECTS,
      );
    }
    case 'START_ACKNOWLEDGED':
      // A late acknowledgement for the start that could not be cancelled
      // - so the aircraft definitely received it. It never revives the
      // pulse and never changes the disposition, and the stop is
      // reasserted because it is still unacknowledged.
      return transition(
        stopping(authority, {
          ...current,
          startAcknowledged: true,
          startMayHaveReachedFc: true,
        }),
        STOP_EFFECTS,
      );
    case 'START_WRITE_CALLED':
      // The uncancellable start crossed the write boundary AFTER the
      // stop was demanded. It never returns to `Pulsing` and never
      // re-arms the deadline; the stop is reasserted because a command
      // was just put on the wire behind it.
      return transition(
        stopping(authority, {...current, startMayHaveReachedFc: true}),
        STOP_EFFECTS,
      );
    case 'STOP_ACKNOWLEDGED':
      switch (current.requiredDisposition) {
        case 'Ready':
          return stay(ready(authority));
        case 'Locked':
          return stay(locked(authority));
        case 'Fault':
          // Kept for completeness of the lattice. A fault reason routes
          // straight to `Fault` via FAULT_RAISED, so a stop confirmed
          // while already required to end in `Fault` cannot arise today
          // - and if it ever does, it must still end there, with the
          // command-may-be-live fact preserved.
          return faulted(
            authority,
            'STOP_FAILED',
            current.startMayHaveReachedFc,
          );
        default:
          assertExhaustive(current.requiredDisposition);
          return faulted(
            authority,
            'STOP_FAILED',
            current.startMayHaveReachedFc,
          );
      }
    case 'FAULT_RAISED':
      return faulted(authority, event.reason, current.startMayHaveReachedFc);
    case 'GATES_FAILED':
      // See reduceStarting.
      return stay(state);
    default:
      return stay(state);
  }
}
