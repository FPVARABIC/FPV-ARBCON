/**
 * Pass 7.2: a tiny clock abstraction so MspTelemetryScheduler never calls
 * Date.now() directly. Deliberately an object with a `.now()` method
 * (not a bare `() => number` function, unlike mspStreamParser.ts's own
 * `now?: () => number` option) - this pass's own explicit contract, kept
 * as specified rather than silently conformed to that older precedent;
 * the two shapes are trivially interchangeable at any call site that
 * needs one.
 *
 * FakeClock is exported as a first-class, reusable member of this module
 * (not tucked away under a __testUtils__/ path the way FakeMspTransport
 * is) because MspTelemetryScheduler is PERMANENT infrastructure this pass
 * builds on top of (unlike Pass 7.0's throwaway pollingCapacityAudit.ts) -
 * later passes wiring this scheduler into the real app will want the same
 * deterministic clock for their own tests too, so hiding it from the
 * public surface would only force it to be re-invented downstream.
 */

export type MonotonicClock = {
  now(): number;
};

/** Production default - the only place in this pass that touches the
 * real wall clock. */
export class RealClock implements MonotonicClock {
  now(): number {
    return Date.now();
  }
}

/**
 * Fully controllable clock for deterministic tests. Time only ever moves
 * when a test explicitly calls advance()/set() - never on its own, and
 * never via any real or Jest fake timer. This is what makes tick()'s
 * pull-based design (see MspTelemetryScheduler.ts's own doc comment)
 * sufficient on its own for deterministic scheduler tests: advance the
 * clock, call tick(), assert - no timer mechanics involved at all.
 */
export class FakeClock implements MonotonicClock {
  private currentMs: number;

  constructor(startAtMs = 0) {
    this.currentMs = startAtMs;
  }

  now(): number {
    return this.currentMs;
  }

  /** Moves time forward by `ms`. Negative durations are rejected rather
   * than silently going backwards - a monotonic clock, by construction,
   * never runs in reverse. */
  advance(ms: number): void {
    if (ms < 0) {
      throw new Error(`FakeClock.advance() cannot advance by a negative duration (${ms}ms).`);
    }
    this.currentMs += ms;
  }

  /** Jumps directly to an absolute time - useful for setting up a test's
   * starting point without an initial advance() call. */
  set(ms: number): void {
    this.currentMs = ms;
  }
}
