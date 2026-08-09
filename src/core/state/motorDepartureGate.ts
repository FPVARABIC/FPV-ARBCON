/**
 * MAY THE OPERATOR LEAVE MOTORS YET?
 *
 * THE GAP THIS CLOSES. MainTabsScreen fired the tab-blur listeners (which
 * raise the stop obligation) and then committed the visual tab switch in
 * the SAME synchronous turn. The only thing that could hold the switch was
 * a listener throwing - which is not how an unconfirmed stop presents. So
 * an operator whose stop had NOT been confirmed was switched away from the
 * Motors screen anyway, with no LiPo warning, while a command might still
 * be live. The stack-navigation path already had bounded confirmation
 * (beforeRemove + preventDefault + releaseHeldNavigation); tab switching
 * bypassed it entirely.
 *
 * WHAT THIS MODULE IS. Pure decision logic, no timers of its own, no
 * controller, no transport, no command. It answers one question from a
 * controller snapshot and an elapsed time, so the answer is testable
 * without hardware and identical on both platforms.
 *
 * IT NEVER SPEEDS THE STOP UP AND NEVER DELAYS IT. The stop request is
 * still issued immediately and synchronously by the caller before this is
 * ever consulted. This only decides whether the NAVIGATION may proceed.
 */

import type {MotorTestControllerSnapshot} from './motorTestController';

export type MotorDepartureVerdict =
  /** No command can be live. Leaving is safe. */
  | 'SAFE'
  /** A command may be live and the stop has not settled yet. Keep
   * waiting - the bounded window has not elapsed. */
  | 'PENDING'
  /** The bounded window elapsed with a command still possibly live. The
   * operator must be told, and must stay on Motors. */
  | 'UNCONFIRMED';

/**
 * The bound. Derived, not chosen: one in-flight request is bounded by the
 * client's own two-phase contract (transport write bound + MSP response
 * timeout), which is exactly what motorTestTelemetryBarrier.ts already
 * computes as MOTOR_TEST_QUIESCENCE_TIMEOUT_MILLIS. Restated as a literal
 * here only so this pure module imports nothing from the protocol layer;
 * a test pins the two together.
 */
export const MOTOR_DEPARTURE_BOUND_MILLIS = 3000;

/**
 * `mayHaveReachedFc` is a PERMANENT per-session latch, so it can never be
 * the liveness test on its own - see motorTestCapability's own
 * isMotorTestSnapshotActive for the field bug that mistake caused. What
 * decides departure is whether the stop for that command has reached a
 * decided, accepted outcome.
 */
function commandSettled(snapshot: MotorTestControllerSnapshot): boolean {
  // Nothing was ever commanded in this session.
  if (!snapshot.pulse.mayHaveReachedFc) {
    return true;
  }
  // A stop that the flight controller acknowledged is the strongest
  // statement this app is allowed to make. It proves the command was
  // received and processed - never that a motor physically stopped, which
  // is why the operator-facing copy still says so.
  if (snapshot.stopExecution.outcome?.kind === 'ACKNOWLEDGED') {
    return true;
  }
  return false;
}

/**
 * @param snapshot the controller's CURRENT published snapshot
 * @param elapsedMs how long since the departure stop was requested
 */
export function evaluateMotorDeparture(
  snapshot: MotorTestControllerSnapshot | undefined,
  elapsedMs: number,
): MotorDepartureVerdict {
  // No controller at all: there is nothing that could be commanding a
  // motor, so there is nothing to hold navigation for.
  if (snapshot === undefined) {
    return 'SAFE';
  }
  if (commandSettled(snapshot)) {
    return 'SAFE';
  }
  return elapsedMs >= MOTOR_DEPARTURE_BOUND_MILLIS ? 'UNCONFIRMED' : 'PENDING';
}
