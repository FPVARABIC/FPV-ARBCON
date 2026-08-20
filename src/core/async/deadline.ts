/**
 * PUTTING A CLOCK BEHIND A PROMISE THAT MAY NEVER SETTLE.
 *
 * =====================================================================
 * WHY THIS EXISTS
 * =====================================================================
 *
 * Most of this application's waits are already bounded by something
 * concrete: an MSP request has MSP_RESPONSE_TIMEOUT_MILLIS, a port open
 * has CONNECT_TIMEOUT_MILLIS, a reboot has FC_REBOOT_RECOVERY_TIMEOUT_MS.
 * The dangerous ones are the waits whose bound was assumed to come from
 * somewhere else and did not - `waitUntilIdle()` resolving off the
 * `.finally()` of a poll that never settles, a writer whose driver
 * stopped draining, a `fetch` with no signal.
 *
 * Each of those is a spinner that never stops, on a screen that has no
 * other way out. This is the one shape they all need, written once so a
 * reviewer can find every bounded wait by looking for its callers rather
 * than by trusting that each site re-derived the pattern correctly.
 *
 * =====================================================================
 * WHAT IT PROMISES, AND WHAT IT DELIBERATELY DOES NOT
 * =====================================================================
 *
 * It promises exactly one thing: the returned Promise settles, at the
 * latest, `timeoutMs` from now. It resolves `{status:'SETTLED'}` with the
 * value, `{status:'REJECTED'}` with the reason, or `{status:'TIMED_OUT'}`
 * - three outcomes, no fourth, and it never rejects itself, so a caller
 * cannot accidentally leave one branch unhandled.
 *
 * It does NOT cancel the underlying work. Nothing here can - a Promise
 * has no cancel. What it does instead is take ownership of the late
 * settlement so it cannot become an unhandled rejection with no owner,
 * and hand the caller the decision about what to do with a resource that
 * may still be in flight (release the lease, drop the writer, close the
 * late-opened port). That decision is always site-specific, which is why
 * it is not made here.
 *
 * Timers are injectable for the same reason they are everywhere else in
 * this codebase: a deadline that can only be observed by waiting for it
 * is a deadline that is never tested.
 *
 * =====================================================================
 * THE BOUNDARY, STATED HONESTLY
 * =====================================================================
 *
 * "Completed at 5999ms with a 6000ms deadline" resolves as SETTLED, not
 * TIMED_OUT - but that is a property of the event loop, not of anything
 * written here. A timer callback is a macrotask, and the microtask queue
 * drains before it, so a `work` promise that had already settled has
 * always propagated through the `.then()` below by the time the timer
 * runs. There is no synchronous way to ask a Promise whether it settled,
 * so this cannot be enforced more strongly than that.
 *
 * The case this does NOT cover: a test that resolves `work` and then
 * synchronously fires a fake timer in the same block, with no microtask
 * flush between them. There the deadline wins, because `work`'s handler
 * has not run yet. That ordering does not occur with real timers.
 * deadline.test.ts asserts both halves of this so the limit is written
 * down rather than discovered later.
 */

/**
 * ABANDONING A WAIT THAT IS CORRECTLY UNBOUNDED.
 *
 * Some waits SHOULD have no clock: a native "where do you want to save
 * this file?" dialog is paced by a person, and timing it out at thirty
 * seconds because they went to find a USB stick would be a defect, not a
 * safeguard. But "no timeout" cannot mean "no way out" - a dialog whose
 * Promise never settles still leaves the screen busy, and on the flasher
 * a busy screen also blocks navigation.
 *
 * So the exit for those is CANCEL, not a deadline. This races the work
 * against an AbortSignal and rejects with an AbortError when the
 * operator cancels. The underlying dialog is not closed by this - nothing
 * here can close it - but the application stops waiting on it, which is
 * the part that was trapping the operator.
 *
 * Rejecting (rather than resolving a sentinel) is deliberate: every
 * caller here already has a catch that returns the screen to a terminal
 * state, so cancel travels the path that failure already travels.
 */
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, {once: true});
    work.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function abortError(): Error {
  const error = new Error('أُلغيت العملية.');
  error.name = 'AbortError';
  return error;
}

export type DeadlineTimers = {
  setTimer: (handler: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
};

export const REAL_DEADLINE_TIMERS: DeadlineTimers = {
  setTimer: (handler, ms) => setTimeout(handler, ms),
  clearTimer: handle => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export type DeadlineOutcome<T> =
  | {status: 'SETTLED'; value: T}
  | {status: 'REJECTED'; reason: unknown}
  | {status: 'TIMED_OUT'};

/**
 * Races `work` against `timeoutMs`. Always settles; never rejects.
 *
 * A late rejection is swallowed on purpose - the caller has already been
 * told TIMED_OUT and acted on it, and an un-owned rejection from a
 * Promise nobody is holding any more is a crash report with no defect
 * behind it.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  timers: DeadlineTimers = REAL_DEADLINE_TIMERS,
): Promise<DeadlineOutcome<T>> {
  let handle: unknown;
  const expired: DeadlineOutcome<T> = {status: 'TIMED_OUT'};
  const deadline = new Promise<DeadlineOutcome<T>>(resolve => {
    handle = timers.setTimer(() => resolve(expired), timeoutMs);
  });

  /* Attached BEFORE the race, so a rejection that arrives after the
     deadline already won still has a handler and never reaches the
     unhandled-rejection path. */
  const guarded: Promise<DeadlineOutcome<T>> = work.then(
    value => ({status: 'SETTLED', value}) as const,
    reason => ({status: 'REJECTED', reason}) as const,
  );

  try {
    return await Promise.race([guarded, deadline]);
  } finally {
    timers.clearTimer(handle);
  }
}
