/**
 * The CONTINUOUS SAFETY MONITORING DECISION POINT.
 *
 * WHAT CONTINUOUS SAFETY MONITORING MEANS HERE. A live, session-bound
 * source that keeps reporting armed state, arming-restriction loss and
 * battery condition FOR THE WHOLE TIME a motor may be commanded - not a
 * one-shot check taken before the session began.
 *
 * HISTORY, STATED PLAINLY. Repair Pass R1 introduced this module when NO
 * such source existed: `readContinuousSafetyMonitoring()` was
 * parameterless, branchless and hard-wired to
 * `UNAVAILABLE_NO_ACCEPTED_SOURCE`, so production activation failed
 * closed. That was the correct answer while the gap was open, and it is
 * no longer the correct answer: `motorTestSafetyMonitor.ts` now provides a
 * genuine dedicated observation path that runs on the motor-test lease for
 * as long as a motor can be commanded.
 *
 * WHAT THIS MODULE IS NOW. The ONE place that decides whether monitoring
 * counts as present, and the only thing the activation gate consults. It
 * holds no state, starts nothing, and cannot make monitoring exist: it
 * reports on a monitor it is handed, and answers
 * `UNAVAILABLE_NO_ACCEPTED_SOURCE` for every input that is not a running
 * monitor whose LAST COMPLETED observation both satisfied every accepted
 * requirement and is still inside `MOTOR_TEST_SAFETY_MAX_AGE_MILLIS`.
 *
 * FAIL-CLOSED IS PRESERVED, NOT RELAXED. No monitor, a monitor that has
 * never observed, a stopped monitor, a blocked or failed reading, or a
 * reading that has aged out all return UNAVAILABLE. Nothing here consults
 * a debug switch, `__DEV__`, `NODE_ENV`, `process.env` or remote
 * configuration, and there is no exported mutable to influence.
 *
 * HOW TESTS EXERCISE THE PULSE ENGINE. By replacing this MODULE with
 * `jest.mock(...)`, which substitutes it inside one test file's registry.
 * That replacement ships in nothing and is importable by no production
 * file. Tests that need the REAL decision drive a real
 * `MotorTestSafetyMonitor` instead - see motorTestSafetyMonitor.test.ts.
 */

import {
  deriveContinuousSafetyMonitoring,
  type MotorTestSafetyMonitorLike,
} from './motorTestSafetyMonitor';

/**
 * The two states the controller can reason about.
 *
 * `AVAILABLE_ACCEPTED_SOURCE` is now genuinely reachable - but only via a
 * running monitor with a fresh, satisfied observation.
 */
export type MotorTestContinuousSafetyMonitoringState =
  /** No accepted, fresh, session-bound continuous monitor exists. */
  | 'UNAVAILABLE_NO_ACCEPTED_SOURCE'
  /** An accepted continuous monitor is live for this session and its
   * latest observation is both satisfied and fresh. */
  | 'AVAILABLE_ACCEPTED_SOURCE';

/**
 * The production reader.
 *
 * Reads the monitor FRESH on every evaluation rather than caching a value,
 * which is what keeps the answer honest as an observation ages out between
 * two gate checks.
 */
export function readContinuousSafetyMonitoring(
  monitor: MotorTestSafetyMonitorLike | undefined,
  nowMonotonicMillis: number,
): MotorTestContinuousSafetyMonitoringState {
  return deriveContinuousSafetyMonitoring(monitor, nowMonotonicMillis);
}
