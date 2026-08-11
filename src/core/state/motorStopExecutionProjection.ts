/**
 * P2-ii - THE PURE LEGACY STOP PROJECTION.
 *
 * WHAT THIS IS. A total, deterministic function from ONE professional
 * stop outcome to the legacy `stopExecution` record the Motors screen,
 * the teardown report and the Phase 2I verification receipt already
 * consume. It has no lease, no transport, no client, no encoder, no timer
 * and no device access, and it dispatches nothing.
 *
 * WHY IT EXISTS AS ITS OWN MODULE. An earlier attempt at the stop
 * migration did this translation inline inside the controller, inventing
 * the fields it could not see rather than deriving them. It compiled and
 * broke roughly twenty legacy assertions - not because the routing was
 * wrong, but because the PROJECTION was. Splitting it out makes the
 * mapping testable on its own, before any of it is allowed near a
 * transport, which is exactly the order the failure argued for.
 *
 * THE RULE IT FOLLOWS. Every field is DERIVED from a semantic fact the
 * engine actually observed and reported on `MotorControlStopAttribution`.
 * Nothing is defaulted to whatever would make a test pass, and nothing is
 * inferred from controller state that may have moved since the stop began.
 * Where the professional model genuinely cannot know a legacy fact, the
 * caller supplies it as explicit input rather than this function guessing.
 *
 * MONOTONIC FIELDS ARE FOLDED, NOT OVERWRITTEN. `commandDispatched`,
 * `commandAcknowledged`, `attributionAmbiguous` and
 * `attributionResolvedByConfirmation` are facts about a SESSION, not about
 * one episode: once true they stay true, because they record that
 * something happened at all. The previous record is therefore an input.
 *
 * NO PHYSICAL CLAIM. `physicalStopConfirmed` is a literal `false` here as
 * everywhere else in this codebase. An acknowledgement proves the flight
 * controller received and processed a frame - never that a motor stopped.
 * Physical behaviour remains REQUIRES HARDWARE TEST.
 */

import type {
  MotorControlStopAttribution,
  MotorControlStopOutcome,
} from './motorControlCommandEngine';

/**
 * The legacy shape, restated structurally so this module does not import
 * the 3,900-line controller (which would be a cycle). The controller's own
 * `MotorTestStopExecutionRecord` is assignable to it, and a compile-time
 * check in the controller keeps them in step.
 */
export interface LegacyStopExecutionRecord {
  readonly attempts: number;
  readonly commandDispatched: boolean;
  readonly commandAcknowledged: boolean;
  readonly physicalStopConfirmed: false;
  readonly deferredBehindActiveWrite: boolean;
  readonly attributionAmbiguous: boolean;
  readonly attributionResolvedByConfirmation: boolean;
  readonly wirePreemptionClaimed: false;
  readonly submittedNextOnTransport: boolean;
  readonly episodeId: number;
  readonly outcome: LegacyStopExecutionOutcome | undefined;
}

export type LegacyStopExecutionOutcome =
  | {
      readonly kind: 'NOT_ATTEMPTED';
      readonly reason: 'NO_LEASE' | 'NO_SCOPE' | 'AUTHORITY_STALE';
    }
  | {readonly kind: 'SCOPE_REJECTED'}
  | {readonly kind: 'ACKNOWLEDGED'}
  | {
      readonly kind: 'FAILED';
      readonly reason:
        | 'REQUEST_FAILED'
        | 'AUTHORITY_CHANGED'
        | 'NATIVE_EXCEPTION'
        | 'ATTRIBUTION_AMBIGUOUS';
    };

/**
 * Everything the projection needs that the engine outcome does not carry.
 *
 * These are LEGACY IDENTITIES, deliberately passed in rather than read
 * from live controller state: the episode must stay bound to the exact
 * activation it ended, and by the time an awaited stop settles the
 * controller's idea of the "current" attempt may already have moved on.
 */
export interface LegacyStopProjectionContext {
  /** The record to fold into. Monotonic fields are carried forward. */
  readonly previous: LegacyStopExecutionRecord;
  /** The episode id allocated when this stop was DEMANDED. */
  readonly episodeId: number;
}

/**
 * Projects one professional stop outcome onto the legacy record.
 *
 * Total: every `MotorControlStopOutcome` variant is handled, and an
 * unforeseen one folds to the conservative FAILED shape rather than
 * silently reporting a stop that was never proven.
 */
export function projectStopOutcomeToLegacyRecord(
  outcome: MotorControlStopOutcome,
  context: LegacyStopProjectionContext,
): LegacyStopExecutionRecord {
  const previous = context.previous;
  const attribution = outcome.attribution;

  // DISPATCHED means a frame actually went to the transport. It is read
  // from the engine's own frame count, never inferred from the outcome
  // kind - a FAILED stop very often dispatched, and a NOT_ATTEMPTED one
  // never did.
  const dispatchedNow = attribution.stopFramesDispatched > 0;
  const acknowledgedNow = outcome.kind === 'ACKNOWLEDGED';

  return Object.freeze({
    // One projection call is one completed operation, whatever it
    // achieved. Concurrent triggers join upstream and never reach here
    // twice, so this counts operations rather than callers.
    attempts: previous.attempts + 1,
    commandDispatched: previous.commandDispatched || dispatchedNow,
    commandAcknowledged: previous.commandAcknowledged || acknowledgedNow,
    physicalStopConfirmed: false as const,
    deferredBehindActiveWrite:
      previous.deferredBehindActiveWrite ||
      attribution.deferredBehindActiveWrite,
    attributionAmbiguous:
      previous.attributionAmbiguous || attribution.attributionAmbiguous,
    attributionResolvedByConfirmation:
      previous.attributionResolvedByConfirmation ||
      attribution.resolvedByConfirmation,
    wirePreemptionClaimed: false as const,
    // The client took this out of its stop slot ahead of the FIFO. That
    // is a claim about SUBMISSION ORDER inside the request engine and
    // nothing more - it preempts nothing already handed to the transport.
    submittedNextOnTransport:
      previous.submittedNextOnTransport || dispatchedNow,
    episodeId: context.episodeId,
    outcome: projectStopOutcomeKind(outcome),
  });
}

/** The outcome half of the projection, exported for focused testing. */
export function projectStopOutcomeKind(
  outcome: MotorControlStopOutcome,
): LegacyStopExecutionOutcome {
  switch (outcome.kind) {
    case 'ACKNOWLEDGED':
      // The DShot MOTOR_STOP is deliberately NOT allowed to downgrade
      // this. The all-stop VECTOR was acknowledged, and that is the stop
      // the ordinary control path honours; a flight controller without
      // MSP2 support is not a failed stop.
      return {kind: 'ACKNOWLEDGED'};
    case 'SCOPE_REJECTED':
      return {kind: 'SCOPE_REJECTED'};
    case 'NOT_ATTEMPTED':
      return {kind: 'NOT_ATTEMPTED', reason: 'AUTHORITY_STALE'};
    case 'FAILED':
      return {kind: 'FAILED', reason: outcome.reason};
    default:
      // Unreachable today. Fails to the shape that keeps a session
      // terminal rather than one that looks recoverable.
      return {kind: 'FAILED', reason: 'NATIVE_EXCEPTION'};
  }
}

/**
 * Whether this outcome leaves an output possibly commanded and unproven.
 *
 * THE RULE, PRESERVED EXACTLY FROM THE LEGACY PATH. Once a motor command
 * may have reached the flight controller, ANY outcome that is not an
 * attributable acknowledgement is unsafe - including "we never even
 * attempted it", because a stop that never reached the wire cannot prove
 * anything about an output that may already be live. Before any command
 * exists, only a genuine failure is unsafe, so a session that was blocked
 * for an unrelated reason still reports its own specific cause.
 */
export function stopOutcomeIsUnsafe(
  outcome: LegacyStopExecutionOutcome,
  commandMayHaveReachedFc: boolean,
): boolean {
  return commandMayHaveReachedFc
    ? outcome.kind !== 'ACKNOWLEDGED'
    : outcome.kind === 'FAILED';
}

/**
 * Whether a verification receipt may be minted for this stop.
 *
 * PHASE 2I, RESTATED AGAINST THE PROFESSIONAL OUTCOME. A receipt requires
 * an attributable acknowledgement of BOTH the command and the stop that
 * ended it. An ambiguous exchange that was never resolved yields NO
 * receipt at all rather than a receipt carrying a warning flag - the
 * whole point of the type is that its existence IS the proof.
 *
 * Note `resolvedByConfirmation` does NOT disqualify: a confirmed
 * ambiguity is exactly the case where a second, independently issued
 * all-stop supplied proof the first frame could not.
 */
export function stopPermitsVerificationReceipt(
  outcome: MotorControlStopOutcome,
): boolean {
  if (outcome.kind !== 'ACKNOWLEDGED') {
    return false;
  }
  const {attributionAmbiguous, resolvedByConfirmation} = outcome.attribution;
  return !attributionAmbiguous || resolvedByConfirmation;
}

export const EMPTY_LEGACY_STOP_RECORD: LegacyStopExecutionRecord =
  Object.freeze({
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

/** Re-exported for callers assembling an outcome in tests. */
export type {MotorControlStopAttribution};
