/**
 * THE ARMED-STATE EVIDENCE DECISION POINT.
 *
 * WHAT THE BENCH GATE ACTUALLY NEEDS. A live, session-bound source that
 * keeps proving the flight controller DISARMED for the whole time a motor
 * may be commanded - not a one-shot check taken before the session began.
 *
 * HISTORY, STATED PLAINLY. Repair Pass R1 introduced this module when NO
 * such source existed: the reader was parameterless, branchless and
 * hard-wired to "unavailable", so production activation failed closed.
 * `motorTestSafetyMonitor.ts` then supplied a genuine dedicated observation
 * path running on the motor-test lease. This pass narrows what that path
 * observes to the one fact the gate rests on, and narrows this reader to
 * match: the answer is now a THREE-VALUED fact rather than a presence flag,
 * so an ARMED flight controller can be told apart from an unreadable one
 * and the operator can be shown which of the two happened.
 *
 * WHAT THIS MODULE IS. The ONE place that turns a monitor into a gate
 * input. It holds no state, starts nothing, and cannot make monitoring
 * exist: it reports on a monitor it is handed, and answers
 * `UNKNOWN_OR_STALE` for every input that is not a running monitor whose
 * LAST COMPLETED observation proved DISARMED and is still inside
 * `MOTOR_TEST_SAFETY_MAX_AGE_MILLIS`.
 *
 * FAIL-CLOSED IS PRESERVED, NOT RELAXED. No monitor, a monitor that has
 * never observed, a stopped monitor, a failed reading, or a reading that
 * has aged out all return `UNKNOWN_OR_STALE`, which blocks. Nothing here
 * consults a debug switch, `__DEV__`, `NODE_ENV`, `process.env` or remote
 * configuration, and there is no exported mutable to influence.
 *
 * HOW TESTS EXERCISE THE PULSE ENGINE. By replacing this MODULE with
 * `jest.mock(...)`, which substitutes it inside one test file's registry.
 * That replacement ships in nothing and is importable by no production
 * file. Tests that need the REAL decision drive a real
 * `MotorTestSafetyMonitor` instead - see motorTestSafetyMonitor.test.ts and
 * motorTestBenchGate.test.ts.
 */

import type {MotorTestSafetyMonitorLike} from './motorTestSafetyMonitor';

/**
 * The three things the controller can learn about armed state.
 *
 * They are deliberately distinct: "the aircraft is armed" and "we cannot
 * currently tell" are different facts, they have different operator
 * instructions, and collapsing them would tell somebody their flight
 * controller is armed when in truth the link went quiet.
 */
export type MotorTestArmedStateEvidence =
  /** A running monitor's latest observation proved DISARMED and is still
   * inside the accepted age bound. The ONLY value that permits a pulse. */
  | 'FRESH_DISARMED'
  /** A completed observation proved the flight controller ARMED. */
  | 'FC_ARMED'
  /** Anything else: no monitor, never observed, stopped, failed, or a
   * reading that has aged past the bound. */
  | 'UNKNOWN_OR_STALE';

/**
 * The production reader.
 *
 * Reads the monitor FRESH on every evaluation rather than caching a value,
 * which is what keeps the answer honest as an observation ages out between
 * two gate checks.
 *
 * The ARMED status is consulted BEFORE `running`, deliberately: the monitor
 * stops itself the instant it observes an armed flight controller, so
 * checking liveness first would report the most dangerous state in the
 * vaguest possible terms.
 */
export function readMotorArmedStateEvidence(
  monitor: MotorTestSafetyMonitorLike | undefined,
  nowMonotonicMillis: number,
): MotorTestArmedStateEvidence {
  if (monitor === undefined) {
    return 'UNKNOWN_OR_STALE';
  }
  const snapshot = monitor.snapshot();
  if (snapshot.status.kind === 'ARMED') {
    return 'FC_ARMED';
  }
  if (!snapshot.running) {
    return 'UNKNOWN_OR_STALE';
  }
  return monitor.isFreshlySatisfied(nowMonotonicMillis)
    ? 'FRESH_DISARMED'
    : 'UNKNOWN_OR_STALE';
}
