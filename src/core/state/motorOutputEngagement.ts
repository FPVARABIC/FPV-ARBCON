/**
 * ONE QUESTION: COULD A MOTOR BE TURNING RIGHT NOW?
 *
 * The Motors configuration gate used to ask a different question - "does a
 * motor-test session object exist?" - and refuse configuration whenever one
 * did. That is not the dangerous condition. A session sitting open with every
 * motor at rest is exactly as safe as no session at all, and treating the two
 * alike is what forced the operator through
 *
 *     close session -> leave Motors -> open another screen -> come back ->
 *     start a session again
 *
 * to move between two things that both concern motors.
 *
 * This module answers the real question instead, and answers it CONSERVATIVELY.
 *
 * WHAT COUNTS AS PROOF OF REST
 *
 * There are exactly two ways to be sure:
 *
 *   1. Nothing was ever commanded. `outputMayBeLive` is false, which the
 *      controller computes from the SAME expression its wire-stop gate uses -
 *      both liveness latches, not just the legacy pulse one. A session where
 *      neither is latched provably never commanded anything.
 *
 *   2. Something was commanded, and an all-stop for it was ACKNOWLEDGED by
 *      the flight controller, with no unresolved doubt about which frame that
 *      acknowledgement belonged to.
 *
 * Everything else is engaged. Not "probably fine" - engaged.
 *
 * WHAT IS NOT PROOF, AND WHY
 *
 * `physicalStopConfirmed` is permanently false in this codebase, deliberately:
 * nothing reachable from software can confirm that a propeller has stopped
 * turning. So "at rest" here always means "the board acknowledged an all-stop",
 * never "the motors are physically still". A dispatched-but-unacknowledged
 * stop is NOT proof - that is the case where the command may have been lost on
 * the way out, which is precisely when a motor is most likely still spinning.
 *
 * An ambiguous attribution is not proof either. When a stop displaces an
 * already-written command, the first frame that comes back may belong to the
 * displaced pulse rather than to the stop, so that acknowledgement is
 * discarded; only `attributionResolvedByConfirmation` - a second, independently
 * issued all-stop whose answer provably belongs to an all-stop - restores it.
 *
 * A missing snapshot is not proof of anything at all. If the controller is
 * gone while a command may have been live - a disconnect mid-pulse, a session
 * torn down, a reconnect that produced a fresh controller with no history -
 * this reports ENGAGED. Losing the evidence is not the same as having evidence
 * of safety, and a reconnect must never launder an unknown state into a safe
 * one.
 *
 * This is the read side only. It relaxes nothing about STARTING motors: the
 * activation gate that decides whether a pulse may begin is untouched, and
 * this predicate never widens it.
 */

import type {MotorTestControllerSnapshot} from './motorTestController';

export type MotorOutputEngagement =
  /** Proven at rest by one of the two routes above. */
  | 'AT_REST'
  /** A command may be live, or we cannot prove it is not. */
  | 'ENGAGED';

export interface MotorOutputEngagementVerdict {
  readonly engagement: MotorOutputEngagement;
  /**
   * Why, in machine terms. Present for every verdict including AT_REST, so a
   * screen can explain a refusal without re-deriving the reasoning and
   * possibly disagreeing with it.
   */
  readonly reason: MotorOutputEngagementReason;
}

export type MotorOutputEngagementReason =
  /** No controller snapshot at all: no evidence either way. */
  | 'NO_SNAPSHOT'
  /**
   * The session exists and is open, but no motor-test controller was ever
   * built for it - so nothing could have been commanded. Decided at the
   * capability layer, which is the only place that can see it; see
   * motorTestCapability.ts's motorOutputEngagementForSession().
   */
  | 'NEVER_INITIATED'
  /** Neither liveness latch was ever set. */
  | 'NEVER_COMMANDED'
  /** A command may be live and no stop has been dispatched. */
  | 'COMMAND_LIVE_NO_STOP'
  /** A stop was dispatched but the board has not acknowledged it. */
  | 'STOP_UNACKNOWLEDGED'
  /** The stop was acknowledged, but that answer may belong to another frame. */
  | 'STOP_ATTRIBUTION_AMBIGUOUS'
  /** The stop operation reported a failure outcome. */
  | 'STOP_FAILED'
  /** An acknowledged, unambiguous all-stop covers the last command. */
  | 'STOP_ACKNOWLEDGED';

/**
 * Stop outcomes that report the operation itself did not succeed. Anything
 * outside this set still has to clear the acknowledgement test below, so a new
 * outcome kind added upstream cannot silently be read as success.
 */
const FAILED_STOP_OUTCOMES: ReadonlySet<string> = new Set([
  'FAILED',
  'TIMED_OUT',
  'REJECTED',
  'ABORTED',
  'LINK_LOST',
]);

export function evaluateMotorOutputEngagement(
  snapshot: MotorTestControllerSnapshot | undefined,
): MotorOutputEngagementVerdict {
  // No evidence is not evidence of safety.
  if (snapshot === undefined) {
    return {engagement: 'ENGAGED', reason: 'NO_SNAPSHOT'};
  }

  // Route 1: neither latch ever set - nothing was ever commanded.
  if (!snapshot.outputMayBeLive) {
    return {engagement: 'AT_REST', reason: 'NEVER_COMMANDED'};
  }

  // Route 2: a command may be live, so only an acknowledged all-stop counts.
  const stop = snapshot.stopExecution;
  if (!stop.commandDispatched) {
    return {engagement: 'ENGAGED', reason: 'COMMAND_LIVE_NO_STOP'};
  }
  const outcomeKind =
    stop.outcome === undefined
      ? undefined
      : (stop.outcome as {readonly kind?: string}).kind;
  if (outcomeKind !== undefined && FAILED_STOP_OUTCOMES.has(outcomeKind)) {
    return {engagement: 'ENGAGED', reason: 'STOP_FAILED'};
  }
  if (!stop.commandAcknowledged) {
    return {engagement: 'ENGAGED', reason: 'STOP_UNACKNOWLEDGED'};
  }
  if (stop.attributionAmbiguous && !stop.attributionResolvedByConfirmation) {
    return {engagement: 'ENGAGED', reason: 'STOP_ATTRIBUTION_AMBIGUOUS'};
  }
  return {engagement: 'AT_REST', reason: 'STOP_ACKNOWLEDGED'};
}

/** Convenience for gates that only need the boolean. Fails closed. */
export function isMotorOutputEngaged(
  snapshot: MotorTestControllerSnapshot | undefined,
): boolean {
  return evaluateMotorOutputEngagement(snapshot).engagement === 'ENGAGED';
}
