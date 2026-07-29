/**
 * Repair Pass R1 - the CONTINUOUS SAFETY MONITORING SOURCE.
 *
 * WHAT CONTINUOUS SAFETY MONITORING WOULD MEAN. A live, session-bound
 * source that keeps reporting armed state, arming-restriction loss and
 * battery condition FOR THE WHOLE TIME a motor may be commanded - not a
 * one-shot check taken before the session began. Every gate the motor-test
 * controller runs today is one-shot: it proves a condition held at setup,
 * and proves nothing about the seconds during which an output is actually
 * live.
 *
 * NO SUCH SOURCE EXISTS IN THIS REPOSITORY. None is implemented here, and
 * R1 deliberately does not implement one - it only stops the absence from
 * being silently survivable.
 *
 * WHY THIS IS A MODULE AND NOT AN OPTION. The production answer must not
 * be influenceable by anything: not a caller argument, not a dependency
 * field, not an exported mutable, not a debug switch, and not `__DEV__` or
 * `NODE_ENV`. `readContinuousSafetyMonitoring()` below therefore takes NO
 * parameters, reads NO state, contains NO branch, and returns one constant.
 * There is no reachable code path in production that can make it answer
 * anything else.
 *
 * HOW TESTS EXERCISE THE PULSE ENGINE. By replacing this MODULE with
 * `jest.mock(...)`, which substitutes the whole module inside one test
 * file's registry. That replacement exists only inside the Jest module
 * registry; it ships in nothing, is importable by no production file, and
 * cannot be reached from the application at runtime. The engine coverage
 * proven in earlier phases is preserved that way rather than by adding a
 * production seam.
 */

/**
 * The two states the controller can reason about.
 *
 * `AVAILABLE_ACCEPTED_SOURCE` exists in the TYPE so the controller can
 * express "monitoring is present" as a distinct case that its gate must
 * check for. Nothing in production ever produces it.
 */
export type MotorTestContinuousSafetyMonitoringState =
  /** No accepted, fresh, session-bound continuous monitor exists. */
  | 'UNAVAILABLE_NO_ACCEPTED_SOURCE'
  /** An accepted continuous monitor is live for this session. NEVER
   * returned by the production reader below. */
  | 'AVAILABLE_ACCEPTED_SOURCE';

/**
 * The production reader. Hard-wired unavailable.
 *
 * Deliberately parameterless and branchless: there is nothing to pass, and
 * nothing to configure. Reading it fresh on every evaluation (rather than
 * caching a value at construction) is what keeps the answer honest if a
 * later pass ever does introduce a real source.
 */
export function readContinuousSafetyMonitoring(): MotorTestContinuousSafetyMonitoringState {
  return 'UNAVAILABLE_NO_ACCEPTED_SOURCE';
}
