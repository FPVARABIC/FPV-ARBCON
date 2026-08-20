/**
 * The whole point of this helper is that it settles when the thing it is
 * wrapping does not. So the tests are mostly about the promise that
 * NEVER resolves - the case that is impossible to observe by waiting.
 */

import {withDeadline} from './deadline';
import type {DeadlineTimers} from './deadline';

function controllableTimers(): DeadlineTimers & {
  fire: () => void;
  armedMs: number | undefined;
  cleared: number;
  live: number;
} {
  let handler: (() => void) | undefined;
  const timers = {
    armedMs: undefined as number | undefined,
    cleared: 0,
    live: 0,
    setTimer(fn: () => void, ms: number) {
      timers.armedMs = ms;
      timers.live += 1;
      handler = fn;
      return 'handle';
    },
    clearTimer(handle: unknown) {
      expect(handle).toBe('handle');
      timers.cleared += 1;
      timers.live -= 1;
    },
    fire() {
      handler?.();
    },
  };
  return timers;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

describe('withDeadline', () => {
  it('reports TIMED_OUT for a promise that never settles, and clears its timer', async () => {
    const timers = controllableTimers();
    const forever = new Promise<number>(() => undefined);

    const outcome = withDeadline(forever, 6_000, timers);
    await flush();
    expect(timers.armedMs).toBe(6_000);

    timers.fire();

    expect(await outcome).toEqual({status: 'TIMED_OUT'});
    expect(timers.live).toBe(0);
  });

  it('reports SETTLED with the value when the work wins', async () => {
    const timers = controllableTimers();
    expect(await withDeadline(Promise.resolve('ok'), 1_000, timers)).toEqual({
      status: 'SETTLED',
      value: 'ok',
    });
    expect(timers.live).toBe(0);
  });

  it('reports REJECTED with the reason rather than throwing, so no caller can leave a branch unhandled', async () => {
    const timers = controllableTimers();
    const boom = new Error('boom');
    const outcome = await withDeadline(Promise.reject(boom), 1_000, timers);
    expect(outcome).toEqual({status: 'REJECTED', reason: boom});
    expect(timers.live).toBe(0);
  });

  it('resolves with undefined values without mistaking them for "no outcome"', async () => {
    const timers = controllableTimers();
    expect(
      await withDeadline(Promise.resolve(undefined), 1_000, timers),
    ).toEqual({status: 'SETTLED', value: undefined});
  });

  /**
   * THE BOUNDARY CASE, BOTH HALVES.
   *
   * With real timers the microtask queue drains before a timer callback
   * runs, so work that finished at 5999ms of a 6000ms deadline has
   * always propagated by the time the deadline fires. That is the case
   * that matters in production and the first assertion below models it
   * exactly: settle, let microtasks drain, then fire.
   */
  it('reports a completion that landed before the deadline as a completion', async () => {
    const timers = controllableTimers();
    let settle: ((value: string) => void) | undefined;
    const work = new Promise<string>(resolve => {
      settle = resolve;
    });
    const outcome = withDeadline(work, 10, timers);
    await flush();

    settle?.('just in time');
    await flush(); // What a real event loop does before running a timer.
    timers.fire();

    expect(await outcome).toEqual({status: 'SETTLED', value: 'just in time'});
  });

  /**
   * The other half, written down rather than left to be discovered: if a
   * TEST resolves the work and fires a fake timer in the same
   * synchronous block, the deadline wins - `work`'s handler has not run
   * yet and no Promise can be asked synchronously whether it settled.
   * This ordering does not occur with real timers. It is asserted so
   * that a future fake-timer test which hits it recognises the artifact
   * instead of filing a defect against the helper.
   */
  it('lets the deadline win when a fake timer fires before the work handler has run', async () => {
    const timers = controllableTimers();
    let settle: ((value: string) => void) | undefined;
    const work = new Promise<string>(resolve => {
      settle = resolve;
    });
    const outcome = withDeadline(work, 10, timers);
    await flush();

    settle?.('same synchronous block');
    timers.fire();

    expect(await outcome).toEqual({status: 'TIMED_OUT'});
  });

  /**
   * A late rejection with no owner is an unhandled-rejection crash
   * report with no defect behind it. The handler is attached before the
   * race for exactly this reason.
   */
  it('swallows a rejection that arrives after the deadline already won', async () => {
    const timers = controllableTimers();
    let fail: ((reason: unknown) => void) | undefined;
    const work = new Promise<string>((_resolve, reject) => {
      fail = reject;
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const outcome = withDeadline(work, 10, timers);
      await flush();
      timers.fire();
      expect(await outcome).toEqual({status: 'TIMED_OUT'});

      fail?.(new Error('too late'));
      await flush();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('clears the timer on every outcome, so a finished operation leaves no clock behind', async () => {
    for (const work of [
      Promise.resolve(1),
      Promise.reject(new Error('x')).catch(reason => {
        throw reason;
      }),
    ]) {
      const timers = controllableTimers();
      await withDeadline(work, 1_000, timers);
      expect(timers.cleared).toBe(1);
      expect(timers.live).toBe(0);
    }
  });
});
