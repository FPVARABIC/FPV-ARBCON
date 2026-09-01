/**
 * P2-i - the PURE professional motor-control state machine.
 *
 * WHAT THIS MODULE IS. A deterministic, synchronous reducer over an
 * abstract domain model. It decides WHAT SHOULD HAPPEN NEXT and describes
 * it as inert intent descriptors. It performs nothing.
 *
 * WHAT THIS MODULE IS NOT, BY CONSTRUCTION. It has ZERO imports. It
 * therefore cannot reach a protocol client, a transport, a timer, a
 * device, React, or any motor value. An intent is a word, not a command:
 * `SUBMIT_COMMAND_INTENT` says "the latest desired vector should now be
 * sent", and it carries no vector, no motor index, no magnitude and no
 * bytes. Turning an intent into something that can reach an aircraft is
 * the driver's job, under the lease, and this file cannot describe it.
 *
 * WHY IT REPLACES THE PULSE MODEL. `motorTestStateMachine.ts` models one
 * momentary pulse held by a touch: `Starting -> Pulsing`, a deadline armed
 * at the write call, and a heartbeat that must keep renewing. A
 * professional workspace has no touch to hold and no pulse to time out -
 * it has a desired vector that changes as fast as a slider moves. Layering
 * that onto the pulse phases would have meant reusing `Pulsing` to mean
 * something it does not mean, so the phases are restated instead.
 *
 * WHAT IS CARRIED OVER UNCHANGED, because it was right:
 *   - every event is stamped with the authority it was produced under, and
 *     an event from another authority is ignored entirely;
 *   - `SUBMIT_STOP_INTENT` is IDEMPOTENT BY CONTRACT and may be emitted
 *     more than once for one activation; a driver treats a repeat as "the
 *     same stop is still required", never as a second distinct stop;
 *   - a stop's required disposition is MONOTONIC - it escalates and never
 *     de-escalates;
 *   - `Fault` is terminal for the authority it was raised under;
 *   - an acknowledgement is metadata. It proves the flight controller
 *     processed a frame. It is never motion, never RPM, never direction,
 *     and never a physical claim of any kind.
 *
 * ============================ STOP DOMINATION ========================
 *
 * The single most important property in this file, stated as five rules
 * that the transition table below implements and the tests re-prove:
 *
 *  SD1. Once `Stopping` is entered, a command request is REFUSED. It does
 *       not queue, it does not become pending, and it does not survive
 *       into whatever state the stop lands in.
 *  SD2. A `COMMAND_ACKNOWLEDGED` that arrives after a stop began is
 *       DISCARDED. A late acknowledgement can never move the machine back
 *       into `EnabledCommanding`, and can never clear a stop or a fault.
 *  SD3. `STOP_TRIGGERED` is accepted from every state except `Disabled`,
 *       and always re-emits `SUBMIT_STOP_INTENT`. An unacknowledged safety
 *       stop is REASSERTED, never remembered as already done.
 *  SD4. A stop's `requiredDisposition` only ever escalates
 *       (`EnabledIdle` < `Disabled` < `Fault`). A later, worse trigger
 *       raises where the stop may land; nothing lowers it.
 *  SD5. Re-entering `EnabledCommanding` after any stop requires the driver
 *       to pass through a state that permits commanding again. A confirmed
 *       ordinary stop lands in `EnabledIdle`; anything worse lands in
 *       `Disabled` or `Fault`, from which a fresh enable flow is the only
 *       way back.
 *
 * There is deliberately no "pending command" field. A desired vector that
 * could outlive a stop is exactly the hazard SD1 exists to prevent, so the
 * coalescing buffer belongs to the driver and is discarded by it on stop -
 * this reducer's contract is that it will never ask for that buffer to be
 * sent again after `Stopping` is entered.
 */

/**
 * One official MSP session, as an OPAQUE IDENTITY.
 *
 * Compared with `===` and never inspected, never enumerated, never
 * serialized. Declared structurally empty on purpose: this module must not
 * know, and must not be able to learn, anything about the session it is
 * scoped to.
 */
export type MotorControlAuthority = object;

/** The six phases. There is deliberately no seventh. */
export type MotorControlPhase =
  | 'Disabled'
  | 'Enabling'
  | 'EnabledIdle'
  | 'EnabledCommanding'
  | 'Stopping'
  | 'Fault';

/**
 * Where a CONFIRMED stop is allowed to leave the machine, ordered by
 * severity for `escalateDisposition`.
 *
 *  EnabledIdle - nothing observed suggests the session or the aircraft
 *                changed, so commanding may resume without a new enable.
 *  Disabled    - a precondition was invalidated. The enable flow must run
 *                again before any further command.
 *  Fault       - the session is no longer trustworthy at all.
 */
export type MotorControlStopDisposition =
  | 'EnabledIdle'
  | 'Disabled'
  | 'Fault';

/**
 * Ordinary stop reasons. A confirmed stop returns to `EnabledIdle` without
 * re-running the enable flow.
 *
 * `OPERATOR_STOP` is the visible STOP control. `MASTER_TO_STOP` and
 * `VALUES_TO_STOP` are an all-stop vector the operator composed themselves
 * - the machine treats reaching stop deliberately as an ordinary
 * completion, not an incident.
 */
export type MotorControlNormalStopReason =
  | 'OPERATOR_STOP'
  | 'MASTER_TO_STOP'
  | 'VALUES_TO_STOP';

/**
 * Reasons that invalidate the preconditions themselves. A confirmed stop
 * leaves the machine `Disabled`, so the enable flow must pass again.
 *
 * `ARMED_STATE_DETECTED` and `ARMED_STATE_UNKNOWN` are deliberately
 * SEPARATE. Proving the aircraft armed and losing the ability to prove
 * anything are different observations, and P2-K requires that UNKNOWN is
 * never treated as DISARMED. Collapsing them would have made the machine
 * unable to say which one happened.
 */
export type MotorControlLockingStopReason =
  | 'ARMED_STATE_DETECTED'
  | 'ARMED_STATE_UNKNOWN'
  | 'ARMING_RESTRICTION_LOST'
  | 'APP_BACKGROUNDED'
  | 'DEPARTURE_REQUESTED'
  | 'DISABLE_REQUESTED'
  | 'SAFETY_MONITORING_FAILED'
  | 'CONFIGURATION_CHANGED';

export type MotorControlStopReason =
  | MotorControlNormalStopReason
  | MotorControlLockingStopReason;

/**
 * Conditions under which the session is not trustworthy at all. Every one
 * is terminal for the current authority.
 */
export type MotorControlFaultReason =
  | 'ENABLE_FAILED'
  | 'COMMAND_FAILED'
  | 'COMMAND_UNCONFIRMED'
  | 'STOP_FAILED'
  | 'STOP_UNCONFIRMED'
  | 'SESSION_ENDED'
  | 'AUTHORITY_MISMATCH'
  | 'TRANSPORT_LOST'
  | 'UNSUPPORTED_DOMAIN';

/**
 * The exact operator-facing warning required whenever a motor may be
 * commanded and the machine can no longer even attempt a stop. Exported as
 * a value so a UI layer references THIS constant rather than retyping the
 * sentence. This module never renders anything.
 */
export const MOTOR_CONTROL_STOP_UNCONFIRMED_WARNING =
  'Unable to confirm stop — disconnect LiPo immediately';

/* ------------------------------------------------------------------ *
 * Intents - inert descriptors, never actions
 * ------------------------------------------------------------------ */

/**
 * What the driver should do next.
 *
 * `SUBMIT_COMMAND_INTENT` carries NO vector. It means "your latest desired
 * vector is now eligible to be sent". The driver owns the coalescing
 * buffer and decides what the latest vector is; this reducer only says
 * when sending is permitted, and - far more importantly - stops saying it
 * the instant a stop begins.
 */
export type MotorControlEffect =
  | {readonly kind: 'SUBMIT_COMMAND_INTENT'}
  | {readonly kind: 'SUBMIT_STOP_INTENT'}
  /** Release the lease, the arming restriction and the interlock, in the
   * driver's own documented order. Emitted only after a stop has been
   * confirmed or has provably failed. */
  | {readonly kind: 'BEGIN_TEARDOWN'}
  | {
      readonly kind: 'SHOW_STOP_UNCONFIRMED_WARNING';
      readonly message: string;
    };

/* Deeply frozen singletons: effect objects are shared and immutable, so a
 * consumer cannot mutate one and have that change observed by another
 * holder. Constructing these is the ONLY thing this module does at load
 * time. */
const SUBMIT_COMMAND_INTENT: MotorControlEffect = Object.freeze({
  kind: 'SUBMIT_COMMAND_INTENT' as const,
});
const SUBMIT_STOP_INTENT: MotorControlEffect = Object.freeze({
  kind: 'SUBMIT_STOP_INTENT' as const,
});
const BEGIN_TEARDOWN: MotorControlEffect = Object.freeze({
  kind: 'BEGIN_TEARDOWN' as const,
});
const SHOW_STOP_UNCONFIRMED_WARNING: MotorControlEffect = Object.freeze({
  kind: 'SHOW_STOP_UNCONFIRMED_WARNING' as const,
  message: MOTOR_CONTROL_STOP_UNCONFIRMED_WARNING,
});

const NO_EFFECTS: readonly MotorControlEffect[] = Object.freeze([]);
const COMMAND_EFFECTS: readonly MotorControlEffect[] = Object.freeze([
  SUBMIT_COMMAND_INTENT,
]);
const STOP_EFFECTS: readonly MotorControlEffect[] = Object.freeze([
  SUBMIT_STOP_INTENT,
]);
const TEARDOWN_EFFECTS: readonly MotorControlEffect[] = Object.freeze([
  BEGIN_TEARDOWN,
]);
const WARN_AND_TEARDOWN_EFFECTS: readonly MotorControlEffect[] = Object.freeze(
  [SHOW_STOP_UNCONFIRMED_WARNING, BEGIN_TEARDOWN],
);

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

export interface MotorControlEventBase {
  readonly authority: MotorControlAuthority;
}

export type MotorControlEvent = MotorControlEventBase &
  (
    | {readonly kind: 'ENABLE_REQUESTED'}
    /** Every load-bearing enable step succeeded, INCLUDING the proven
     * disarmed observation and the arming restriction. The driver must not
     * emit this earlier - see the enable ordering in the controller. */
    | {readonly kind: 'ENABLE_COMPLETED'}
    | {
        readonly kind: 'ENABLE_FAILED';
        readonly reason: MotorControlFaultReason;
      }
    /** A new desired vector was accepted by the driver's validation. From
     * here the command is considered uncancellable: it may reach the
     * aircraft even before the write call returns. */
    | {readonly kind: 'COMMAND_REQUESTED'}
    /** Metadata only. Never motion, never RPM, never a physical claim. */
    | {readonly kind: 'COMMAND_ACKNOWLEDGED'}
    | {
        readonly kind: 'COMMAND_FAILED';
        readonly reason: MotorControlFaultReason;
      }
    | {readonly kind: 'STOP_TRIGGERED'; readonly reason: MotorControlStopReason}
    | {readonly kind: 'STOP_ACKNOWLEDGED'}
    | {readonly kind: 'FAULT_RAISED'; readonly reason: MotorControlFaultReason}
  );

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

/**
 * Immutable bookkeeping for an in-progress stop. The difference between
 * "operator pressed STOP" and "the aircraft armed underneath us" is DATA
 * about one stop, not a different phase.
 */
export interface MotorControlStoppingMetadata {
  /** The trigger that first demanded the stop. Never overwritten by a
   * later trigger - only `requiredDisposition` escalates. */
  readonly stopReason: MotorControlStopReason;
  /** Conservatively true from the moment a command was requested: a
   * submitted vector cannot be recalled, so it may still reach the
   * aircraft even if the write call has not returned. */
  readonly commandMayBeLive: boolean;
  /** Where a CONFIRMED stop is allowed to land. Monotonic - SD4. */
  readonly requiredDisposition: MotorControlStopDisposition;
  readonly authority: MotorControlAuthority;
}

export type MotorControlState =
  | {readonly phase: 'Disabled'; readonly authority: MotorControlAuthority}
  | {readonly phase: 'Enabling'; readonly authority: MotorControlAuthority}
  | {readonly phase: 'EnabledIdle'; readonly authority: MotorControlAuthority}
  | {
      readonly phase: 'EnabledCommanding';
      readonly authority: MotorControlAuthority;
      /** True once at least one command write has been acknowledged in
       * this commanding episode. Observability only; changes no decision. */
      readonly commandAcknowledged: boolean;
    }
  | {
      readonly phase: 'Stopping';
      readonly authority: MotorControlAuthority;
      readonly stopping: MotorControlStoppingMetadata;
    }
  | {
      readonly phase: 'Fault';
      readonly authority: MotorControlAuthority;
      readonly faultReason: MotorControlFaultReason;
      /** True when the fault ended an episode in which a command may have
       * reached the aircraft and no stop was confirmed afterwards. */
      readonly commandMayBeLive: boolean;
    };

export interface MotorControlTransition {
  readonly state: MotorControlState;
  readonly effects: readonly MotorControlEffect[];
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Compile-time exhaustiveness. Deliberately does NOT throw: a reducer on
 * a safety path must not turn an unforeseen input into an exception. */
function assertExhaustive(value: never): void {
  return value;
}

/**
 * The disposition a stop reason asks for on its own. An exhaustive switch
 * rather than a lookup table: adding a stop reason without deciding its
 * disposition must fail to compile.
 */
export function dispositionForStopReason(
  reason: MotorControlStopReason,
): MotorControlStopDisposition {
  switch (reason) {
    case 'OPERATOR_STOP':
    case 'MASTER_TO_STOP':
    case 'VALUES_TO_STOP':
      return 'EnabledIdle';
    case 'ARMED_STATE_DETECTED':
    case 'ARMED_STATE_UNKNOWN':
    case 'ARMING_RESTRICTION_LOST':
    case 'APP_BACKGROUNDED':
    case 'DEPARTURE_REQUESTED':
    case 'DISABLE_REQUESTED':
    case 'SAFETY_MONITORING_FAILED':
    case 'CONFIGURATION_CHANGED':
      return 'Disabled';
    default:
      assertExhaustive(reason);
      // Unreachable. Chosen anyway as the stricter of the two values a
      // stop reason may request, so an unforeseen reason can never be
      // treated as an ordinary completion.
      return 'Disabled';
  }
}

const DISPOSITION_SEVERITY: Readonly<
  Record<MotorControlStopDisposition, number>
> = Object.freeze({EnabledIdle: 0, Disabled: 1, Fault: 2});

/** SD4: monotonic. Returns whichever disposition is more severe. */
export function escalateDisposition(
  current: MotorControlStopDisposition,
  next: MotorControlStopDisposition,
): MotorControlStopDisposition {
  return DISPOSITION_SEVERITY[next] > DISPOSITION_SEVERITY[current]
    ? next
    : current;
}

/**
 * Whether a fault reason may end an episode silently.
 *
 * `WARN_IF_COMMAND_MAY_BE_LIVE` means: if a command may already have
 * crossed the write boundary, the operator must be told to disconnect the
 * battery, because this reducer cannot prove the transport is still able
 * to carry a stop.
 */
export type MotorControlFaultWarningPolicy =
  | 'WARN_IF_COMMAND_MAY_BE_LIVE'
  | 'NEVER_WARN';

export function faultWarningPolicy(
  reason: MotorControlFaultReason,
): MotorControlFaultWarningPolicy {
  switch (reason) {
    case 'COMMAND_FAILED':
    case 'COMMAND_UNCONFIRMED':
    case 'STOP_FAILED':
    case 'STOP_UNCONFIRMED':
    case 'SESSION_ENDED':
    case 'AUTHORITY_MISMATCH':
    case 'TRANSPORT_LOST':
      return 'WARN_IF_COMMAND_MAY_BE_LIVE';
    /* An enable that failed, or a domain the product refuses to command,
     * both end BEFORE any vector could be submitted - the enable flow
     * sends no active vector at all. These are the only reasons that
     * provably cannot leave a motor commanded. */
    case 'ENABLE_FAILED':
    case 'UNSUPPORTED_DOMAIN':
      return 'NEVER_WARN';
    default:
      assertExhaustive(reason);
      return 'WARN_IF_COMMAND_MAY_BE_LIVE';
  }
}

/** Whether a phase is one in which a command may already be live. */
function commandMayBeLiveIn(state: MotorControlState): boolean {
  switch (state.phase) {
    case 'EnabledCommanding':
      return true;
    case 'Stopping':
      return state.stopping.commandMayBeLive;
    case 'Fault':
      return state.commandMayBeLive;
    case 'Disabled':
    case 'Enabling':
    case 'EnabledIdle':
      return false;
    default:
      assertExhaustive(state);
      return true;
  }
}

const NO_CHANGE = (state: MotorControlState): MotorControlTransition =>
  Object.freeze({state, effects: NO_EFFECTS});

/** The initial state for a fresh authority. */
export function initialMotorControlState(
  authority: MotorControlAuthority,
): MotorControlState {
  return Object.freeze({phase: 'Disabled' as const, authority});
}

/* ------------------------------------------------------------------ *
 * Reducer
 * ------------------------------------------------------------------ */

function enterStopping(
  state: MotorControlState,
  reason: MotorControlStopReason,
): MotorControlTransition {
  const requested = dispositionForStopReason(reason);
  if (state.phase === 'Stopping') {
    // SD3: reassert the same stop, escalating where it may land. The
    // ORIGINAL reason is kept - it is what actually demanded the stop.
    return Object.freeze({
      state: Object.freeze({
        phase: 'Stopping' as const,
        authority: state.authority,
        stopping: Object.freeze({
          ...state.stopping,
          requiredDisposition: escalateDisposition(
            state.stopping.requiredDisposition,
            requested,
          ),
        }),
      }),
      effects: STOP_EFFECTS,
    });
  }
  return Object.freeze({
    state: Object.freeze({
      phase: 'Stopping' as const,
      authority: state.authority,
      stopping: Object.freeze({
        stopReason: reason,
        commandMayBeLive: commandMayBeLiveIn(state),
        requiredDisposition: requested,
        authority: state.authority,
      }),
    }),
    effects: STOP_EFFECTS,
  });
}

function enterFault(
  state: MotorControlState,
  reason: MotorControlFaultReason,
): MotorControlTransition {
  const mayBeLive = commandMayBeLiveIn(state);
  const warn =
    faultWarningPolicy(reason) === 'WARN_IF_COMMAND_MAY_BE_LIVE' && mayBeLive;
  return Object.freeze({
    state: Object.freeze({
      phase: 'Fault' as const,
      authority: state.authority,
      faultReason: reason,
      commandMayBeLive: mayBeLive,
    }),
    effects: warn ? WARN_AND_TEARDOWN_EFFECTS : TEARDOWN_EFFECTS,
  });
}

/**
 * The transition table.
 *
 * An event stamped with a DIFFERENT authority is ignored entirely and
 * returns the state unchanged - it is a continuation from a session this
 * machine is not bound to, and the arrival of some other authority's token
 * is not a report about this one.
 */
export function reduceMotorControl(
  state: MotorControlState,
  event: MotorControlEvent,
): MotorControlTransition {
  if (event.authority !== state.authority) {
    return NO_CHANGE(state);
  }

  switch (event.kind) {
    case 'ENABLE_REQUESTED':
      // Only a disabled machine may begin enabling. A request arriving in
      // any other phase is a duplicate or a race and changes nothing.
      return state.phase === 'Disabled'
        ? Object.freeze({
            state: Object.freeze({
              phase: 'Enabling' as const,
              authority: state.authority,
            }),
            effects: NO_EFFECTS,
          })
        : NO_CHANGE(state);

    case 'ENABLE_COMPLETED':
      // Enabling lands IDLE, never commanding: the enable flow establishes
      // an all-stop desired vector and sends no active value.
      return state.phase === 'Enabling'
        ? Object.freeze({
            state: Object.freeze({
              phase: 'EnabledIdle' as const,
              authority: state.authority,
            }),
            effects: NO_EFFECTS,
          })
        : NO_CHANGE(state);

    case 'ENABLE_FAILED':
      // A failed enable never leaves a command live, so it lands Disabled
      // rather than Fault, and asks for teardown of whatever partial
      // authority the driver acquired.
      return state.phase === 'Enabling'
        ? Object.freeze({
            state: Object.freeze({
              phase: 'Disabled' as const,
              authority: state.authority,
            }),
            effects: TEARDOWN_EFFECTS,
          })
        : NO_CHANGE(state);

    case 'COMMAND_REQUESTED':
      switch (state.phase) {
        case 'EnabledIdle':
          return Object.freeze({
            state: Object.freeze({
              phase: 'EnabledCommanding' as const,
              authority: state.authority,
              commandAcknowledged: false,
            }),
            effects: COMMAND_EFFECTS,
          });
        case 'EnabledCommanding':
          // A newer desired vector while already commanding. The driver
          // coalesces; the machine simply says "send the latest" again and
          // clears the per-episode acknowledgement, because the value that
          // was acknowledged is no longer the desired one.
          return Object.freeze({
            state: Object.freeze({
              phase: 'EnabledCommanding' as const,
              authority: state.authority,
              commandAcknowledged: false,
            }),
            effects: COMMAND_EFFECTS,
          });
        /* SD1 - the whole point of this file. A command requested while
         * stopping, faulted, disabled or still enabling is REFUSED. It does
         * not queue and it does not survive; the driver must reach a
         * commandable phase again first. */
        case 'Stopping':
        case 'Fault':
        case 'Disabled':
        case 'Enabling':
          return NO_CHANGE(state);
        default:
          assertExhaustive(state);
          return NO_CHANGE(state);
      }

    case 'COMMAND_ACKNOWLEDGED':
      /* SD2 - a late acknowledgement is discarded everywhere except the
       * commanding phase it belongs to. It can never re-enter commanding,
       * clear a stop, or clear a fault. */
      return state.phase === 'EnabledCommanding'
        ? Object.freeze({
            state: Object.freeze({
              phase: 'EnabledCommanding' as const,
              authority: state.authority,
              commandAcknowledged: true,
            }),
            effects: NO_EFFECTS,
          })
        : NO_CHANGE(state);

    case 'COMMAND_FAILED':
      // A command write that failed or is unconfirmed may still have
      // reached the aircraft, so it takes the stop route rather than
      // faulting straight away - the machine tries to stop first.
      return state.phase === 'EnabledCommanding'
        ? enterStopping(state, 'OPERATOR_STOP')
        : NO_CHANGE(state);

    case 'STOP_TRIGGERED':
      /* SD3 - accepted from every phase except Disabled, and always
       * re-emits the stop intent. */
      return state.phase === 'Disabled'
        ? NO_CHANGE(state)
        : enterStopping(state, event.reason);

    case 'STOP_ACKNOWLEDGED': {
      if (state.phase !== 'Stopping') {
        return NO_CHANGE(state);
      }
      /* SD5 - the disposition decides where a confirmed stop lands.
       * `EnabledIdle` is the only landing from which commanding may resume
       * without a fresh enable flow, and only an ordinary stop reason can
       * ask for it. */
      switch (state.stopping.requiredDisposition) {
        case 'EnabledIdle':
          return Object.freeze({
            state: Object.freeze({
              phase: 'EnabledIdle' as const,
              authority: state.authority,
            }),
            effects: NO_EFFECTS,
          });
        case 'Disabled':
          return Object.freeze({
            state: Object.freeze({
              phase: 'Disabled' as const,
              authority: state.authority,
            }),
            effects: TEARDOWN_EFFECTS,
          });
        case 'Fault':
          return Object.freeze({
            state: Object.freeze({
              phase: 'Fault' as const,
              authority: state.authority,
              faultReason: 'STOP_FAILED' as const,
              // The stop WAS acknowledged, so nothing is left commanded.
              commandMayBeLive: false,
            }),
            effects: TEARDOWN_EFFECTS,
          });
        default:
          assertExhaustive(state.stopping.requiredDisposition);
          return NO_CHANGE(state);
      }
    }

    case 'FAULT_RAISED':
      // Terminal for this authority. Raising a fault on an already-faulted
      // machine keeps the FIRST reason: it is the one that broke the
      // session, and later noise must not overwrite it.
      return state.phase === 'Fault'
        ? NO_CHANGE(state)
        : enterFault(state, event.reason);

    default:
      assertExhaustive(event);
      return NO_CHANGE(state);
  }
}
