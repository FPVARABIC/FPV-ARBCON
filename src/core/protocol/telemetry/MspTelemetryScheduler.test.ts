/**
 * Pull-driven, fully deterministic tests: FakeClock + explicit tick()
 * calls + a fake requester, never Jest fake timers - see
 * MspTelemetryScheduler.ts's own class-level doc comment on why tick()
 * is designed to make this possible at all.
 */

import {createMspTelemetryScheduler} from './MspTelemetryScheduler';
import {MspClientError} from '../mspClient';
import {FakeClock} from './clock';
import type {MspPollDefinition} from './telemetryTypes';
import type {MspRequester} from '../msp/identification/MspIdentificationService';
import type {MspFrame} from '../mspTypes';

function makeFrame(command: number, payload: Uint8Array): MspFrame {
  return {protocolVersion: 'v1', wireFormat: 'v1', direction: 'response', command, flags: 0, payload};
}

function definition(
  id: string,
  command: number,
  intervalMs: number,
  staleAfterMs: number,
  priority = 0,
): MspPollDefinition<number> {
  return {id, command, intervalMs, staleAfterMs, priority, decode: (payload: Uint8Array) => payload[0]};
}

/**
 * Same deferred-promise-per-call, oldest-pending-first manual-control
 * pattern established by pollingCapacityAudit.test.ts's own
 * createFakeClient() (and MspIdentificationService.test.ts's
 * FakeMspRequester) - necessary for the tests below that need to inspect
 * "still in flight" state precisely. When an `autoRespond` function is
 * given instead, every request() call resolves immediately (a plain
 * resolved Promise) - used by tests that just want dispatches to settle
 * promptly without per-call manual control (paired with
 * scheduler.waitUntilIdle(), never a timer, to know when a settle has
 * actually happened).
 */
function createFakeRequester(autoRespond?: (command: number, payload: Uint8Array) => MspFrame): MspRequester & {
  callCount: number;
  calls: Array<{command: number; payload: Uint8Array}>;
  resolveNext: (frame: MspFrame) => void;
  rejectNext: (error: unknown) => void;
} {
  const pending: Array<{resolve: (frame: MspFrame) => void; reject: (error: unknown) => void}> = [];
  const calls: Array<{command: number; payload: Uint8Array}> = [];
  const fake = {
    callCount: 0,
    calls,
    request(command: number, payload: Uint8Array): Promise<MspFrame> {
      fake.callCount += 1;
      calls.push({command, payload});
      if (autoRespond) {
        return Promise.resolve(autoRespond(command, payload));
      }
      return new Promise<MspFrame>((resolve, reject) => {
        pending.push({resolve, reject});
      });
    },
    resolveNext(frame: MspFrame): void {
      const next = pending.shift();
      if (!next) {
        throw new Error('resolveNext() called with no pending request() call');
      }
      next.resolve(frame);
    },
    rejectNext(error: unknown): void {
      const next = pending.shift();
      if (!next) {
        throw new Error('rejectNext() called with no pending request() call');
      }
      next.reject(error);
    },
  };
  return fake;
}

describe('MspTelemetryScheduler - coalescing', () => {
  it('coalesces multiple due-crossings into exactly one dispatch, never a growing backlog', () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester();
    const scheduler = createMspTelemetryScheduler(requester, {clock});
    scheduler.registerPoll(definition('a', 501, 200, 100_000));

    // Pause so tick() cannot dispatch while we cross the 200ms due
    // threshold repeatedly (700ms = 3.5 interval-lengths past due).
    const lease = scheduler.acquirePauseLease('EXCLUSIVE_OPERATION');
    clock.advance(700);
    scheduler.tick();
    scheduler.tick();
    scheduler.tick();
    expect(requester.callCount).toBe(0);

    // Releasing the lease and ticking once must produce exactly ONE
    // dispatch to catch up, not three (or any accumulated backlog).
    lease.release();
    scheduler.tick();
    expect(requester.callCount).toBe(1);

    // Further ticks while that single dispatch is still unsettled must
    // not start a second one either.
    scheduler.tick();
    scheduler.tick();
    expect(requester.callCount).toBe(1);
  });
});

describe('MspTelemetryScheduler - fairness', () => {
  it('a slow poll (~1000ms) is not starved by a fast poll (~220ms, matching the confirmed real MSP_ATTITUDE rate), and the fast poll is not meaningfully delayed by the slow one', async () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester((command, payload) => makeFrame(command, payload.length ? payload : Uint8Array.from([1])));
    const scheduler = createMspTelemetryScheduler(requester, {clock});

    const FAST_ID = 'fast-attitude';
    const SLOW_ID = 'slow-telemetry';
    scheduler.registerPoll(definition(FAST_ID, 108, 220, 10_000));
    scheduler.registerPoll(definition(SLOW_ID, 999, 1000, 10_000));

    const fastDispatchTimes: number[] = [];
    const slowDispatchTimes: number[] = [];
    let lastFastUpdatedAtMs: number | undefined;
    let lastSlowUpdatedAtMs: number | undefined;

    const STEP_MS = 20;
    const TOTAL_MS = 2500;
    for (let elapsed = 0; elapsed < TOTAL_MS; elapsed += STEP_MS) {
      clock.advance(STEP_MS);
      scheduler.tick();
      await scheduler.waitUntilIdle();

      const fastValue = scheduler.getValue<number>(FAST_ID);
      if ((fastValue.status === 'FRESH' || fastValue.status === 'STALE') && fastValue.updatedAtMs !== lastFastUpdatedAtMs) {
        fastDispatchTimes.push(fastValue.updatedAtMs);
        lastFastUpdatedAtMs = fastValue.updatedAtMs;
      }
      const slowValue = scheduler.getValue<number>(SLOW_ID);
      if ((slowValue.status === 'FRESH' || slowValue.status === 'STALE') && slowValue.updatedAtMs !== lastSlowUpdatedAtMs) {
        slowDispatchTimes.push(slowValue.updatedAtMs);
        lastSlowUpdatedAtMs = slowValue.updatedAtMs;
      }
    }

    // ~2500ms / 220ms =~ 11.4 expected fast dispatches; ~2500/1000 = 2.5
    // expected slow dispatches. Generous lower bounds, not exact counts,
    // since contention with the other poll can occasionally cost a tick.
    expect(fastDispatchTimes.length).toBeGreaterThanOrEqual(9);
    expect(slowDispatchTimes.length).toBeGreaterThanOrEqual(2);

    // Not starved: no gap between consecutive slow dispatches (or from
    // t=0 to the first one) meaningfully exceeds its own 1000ms interval.
    const slowGaps = slowDispatchTimes.map((t, i) => t - (i === 0 ? 0 : slowDispatchTimes[i - 1]));
    for (const gap of slowGaps) {
      expect(gap).toBeLessThanOrEqual(1000 + STEP_MS * 3);
    }

    // Not meaningfully delayed: no gap between consecutive fast
    // dispatches exceeds its own 220ms interval by more than a couple of
    // poll steps' worth of slack.
    const fastGaps = fastDispatchTimes.map((t, i) => t - (i === 0 ? 0 : fastDispatchTimes[i - 1]));
    for (const gap of fastGaps) {
      expect(gap).toBeLessThanOrEqual(220 + STEP_MS * 3);
    }
  });
});

describe('MspTelemetryScheduler - deadline-aware selection', () => {
  it('picks the poll most overdue RELATIVE TO ITS OWN INTERVAL, not the one with the larger raw-millisecond overdue amount', () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester();
    const scheduler = createMspTelemetryScheduler(requester, {clock});

    // "slow" (interval 1000ms) registered at t=0 -> due at 0.
    scheduler.registerPoll(definition('slow', 601, 1000, 100_000));
    // "fast" (interval 100ms) registered later, at t=420 -> due at 420.
    clock.advance(420);
    scheduler.registerPoll(definition('fast', 602, 100, 100_000));

    // At t=500: slow's raw overdue = 500 - 0 = 500ms (ratio 0.5).
    //           fast's raw overdue = 500 - 420 = 80ms (ratio 0.8).
    // Raw milliseconds favor "slow" (500 > 80); the actual ratio formula
    // favors "fast" (0.8 > 0.5). This proves the ratio, not raw ms, is
    // what tick() actually uses.
    clock.advance(80);
    scheduler.tick();

    expect(requester.calls).toHaveLength(1);
    expect(requester.calls[0].command).toBe(602);
  });

  it('breaks an exact overdue-ratio tie by priority (higher priority wins)', () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester();
    const scheduler = createMspTelemetryScheduler(requester, {clock});

    // Identical interval and identical due time -> identical ratio at
    // any shared "now" - a genuine tie.
    scheduler.registerPoll(definition('low-priority', 701, 200, 100_000, 1));
    scheduler.registerPoll(definition('high-priority', 702, 200, 100_000, 5));

    clock.advance(50);
    scheduler.tick();

    expect(requester.calls).toHaveLength(1);
    expect(requester.calls[0].command).toBe(702);
  });
});

describe('MspTelemetryScheduler - reference-counted pause', () => {
  it('polling resumes only once every outstanding lease has been released; releasing an already-released lease is a no-op', () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester();
    const scheduler = createMspTelemetryScheduler(requester, {clock});
    scheduler.registerPoll(definition('a', 801, 100, 100_000));

    const lease1 = scheduler.acquirePauseLease('EXCLUSIVE_OPERATION');
    const lease2 = scheduler.acquirePauseLease('MSP_RECOVERY');

    clock.advance(500);
    scheduler.tick();
    expect(requester.callCount).toBe(0);

    lease1.release();
    scheduler.tick();
    expect(requester.callCount).toBe(0); // lease2 still held

    lease1.release(); // already released - safe no-op
    scheduler.tick();
    expect(requester.callCount).toBe(0);

    lease2.release();
    scheduler.tick();
    expect(requester.callCount).toBe(1); // now, finally, dispatches
  });

  it('Pass 7.4: staleness is still detected via tick() even while paused - a paused telemetry poll genuinely IS going stale, and must be reported as such', async () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester();
    const scheduler = createMspTelemetryScheduler(requester, {clock});
    scheduler.registerPoll(definition('a', 802, 100_000, 500));

    scheduler.tick();
    requester.resolveNext(makeFrame(802, Uint8Array.from([5])));
    await scheduler.waitUntilIdle();
    expect(scheduler.getValue<number>('a')).toMatchObject({status: 'FRESH'});

    const lease = scheduler.acquirePauseLease('EXCLUSIVE_OPERATION');
    clock.advance(500);
    scheduler.tick(); // paused - no new dispatch, but staleness still checked
    expect(scheduler.getValue<number>('a')).toMatchObject({status: 'STALE', ageMs: 500});

    lease.release();
  });
});

describe('MspTelemetryScheduler - per-poll suppression', () => {
  it('yields a hidden fast poll until every suppression owner releases it', async () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester(command =>
      makeFrame(command, Uint8Array.from([command])),
    );
    const scheduler = createMspTelemetryScheduler(requester, {
      clock,
      singleFlight: true,
    });
    scheduler.registerPoll(definition('hidden-attitude', 108, 50, 500, 0));
    scheduler.registerPoll(definition('visible-receiver', 105, 50, 500, 2));

    const first = scheduler.acquirePollSuppression('hidden-attitude');
    const second = scheduler.acquirePollSuppression('hidden-attitude');
    for (let sample = 0; sample < 3; sample += 1) {
      scheduler.tick();
      await scheduler.waitUntilIdle();
      clock.advance(50);
    }
    expect(requester.calls.map(call => call.command)).toEqual([105, 105, 105]);

    first();
    scheduler.tick();
    await scheduler.waitUntilIdle();
    expect(requester.calls.at(-1)?.command).toBe(105);

    second();
    scheduler.tick();
    await scheduler.waitUntilIdle();
    expect(requester.calls.at(-1)?.command).toBe(108);

    // Releasing a lease twice must not suppress or corrupt another owner.
    second();
    clock.advance(50);
    scheduler.tick();
    await scheduler.waitUntilIdle();
    expect(requester.calls.at(-1)?.command).toBe(105);
  });

  it('does not stop unrelated polls or discard the suppressed cached sample', async () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester(command =>
      makeFrame(command, Uint8Array.from([7])),
    );
    const scheduler = createMspTelemetryScheduler(requester, {clock});
    scheduler.registerPoll(definition('a', 108, 50, 500));
    scheduler.registerPoll(definition('b', 105, 50, 500, 2));

    scheduler.tick();
    await scheduler.waitUntilIdle();
    const cached = scheduler.getValue<number>('b');
    const release = scheduler.acquirePollSuppression('b');
    clock.advance(50);
    scheduler.tick();
    await scheduler.waitUntilIdle();

    expect(requester.calls.at(-1)?.command).toBe(108);
    expect(scheduler.getValue<number>('b')).toBe(cached);
    release();
  });

  it('does not let a suppressed primary poll consume the alternation decision', async () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester(command =>
      makeFrame(command, Uint8Array.from([command])),
    );
    const scheduler = createMspTelemetryScheduler(requester, {
      clock,
      singleFlight: true,
    });
    scheduler.registerPoll(definition('hidden-attitude', 108, 50, 500, 0));
    scheduler.registerPoll(definition('visible-auxiliary', 105, 50, 500, -1));

    const release = scheduler.acquirePollSuppression('hidden-attitude');
    scheduler.tick();
    await scheduler.waitUntilIdle();
    clock.advance(50);
    scheduler.tick();
    await scheduler.waitUntilIdle();

    expect(requester.calls.map(call => call.command)).toEqual([105, 105]);
    release();
  });
});

describe('MspTelemetryScheduler - waitUntilIdle', () => {
  it('resolves immediately when nothing is in flight', async () => {
    const scheduler = createMspTelemetryScheduler(createFakeRequester(), {clock: new FakeClock()});
    await expect(scheduler.waitUntilIdle()).resolves.toBeUndefined();
  });

  it('genuinely waits for an in-flight dispatch to settle before resolving', async () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester();
    const scheduler = createMspTelemetryScheduler(requester, {clock});
    scheduler.registerPoll(definition('a', 901, 100, 100_000));

    scheduler.tick();
    expect(requester.callCount).toBe(1);

    let resolved = false;
    const idlePromise = scheduler.waitUntilIdle().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false); // still in flight - must not have resolved yet

    requester.resolveNext(makeFrame(901, Uint8Array.from([9])));
    await idlePromise;
    expect(resolved).toBe(true);
  });
});

describe('MspTelemetryScheduler - discardPendingDemands', () => {
  it('drops a due-but-not-yet-dispatched demand without affecting a currently in-flight one', async () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester();
    const scheduler = createMspTelemetryScheduler(requester, {clock});
    // Higher priority so 'inflight' deterministically wins the very
    // first dispatch, leaving 'pending' due-but-unserved.
    scheduler.registerPoll(definition('inflight', 1001, 100, 100_000, 10));
    scheduler.registerPoll(definition('pending', 1002, 100, 100_000, 0));

    const lease = scheduler.acquirePauseLease('EXCLUSIVE_OPERATION');
    clock.advance(500);
    scheduler.tick();
    expect(requester.callCount).toBe(0);
    lease.release();

    scheduler.tick(); // exactly one dispatch per tick - 'inflight' wins
    expect(requester.callCount).toBe(1);
    expect(requester.calls[0].command).toBe(1001);

    // 'pending' is still due and has not dispatched at all yet.
    scheduler.discardPendingDemands();

    // A further tick() must not fire 'pending' (its demand was
    // discarded) nor re-fire 'inflight' (guarded by inFlight).
    scheduler.tick();
    expect(requester.callCount).toBe(1);

    // 'inflight' itself was never touched by discardPendingDemands() -
    // it completes normally once resolved.
    requester.resolveNext(makeFrame(1001, Uint8Array.from([1])));
    await scheduler.waitUntilIdle();
    expect(scheduler.getValue<number>('inflight').status).toBe('FRESH');
  });
});

describe('MspTelemetryScheduler - requestRefresh', () => {
  it('marks a poll immediately due, without double-scheduling if called more than once or if already due', async () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester();
    const scheduler = createMspTelemetryScheduler(requester, {clock});
    scheduler.registerPoll(definition('a', 1101, 10_000, 100_000)); // long interval

    scheduler.tick(); // due-at-registration initial dispatch
    expect(requester.callCount).toBe(1);
    requester.resolveNext(makeFrame(1101, Uint8Array.from([1])));
    await scheduler.waitUntilIdle();

    clock.advance(50);
    scheduler.tick();
    expect(requester.callCount).toBe(1); // nowhere near its 10s interval - unchanged

    scheduler.requestRefresh(['a']);
    scheduler.requestRefresh(['a']); // calling twice must not double-schedule
    scheduler.tick();
    expect(requester.callCount).toBe(2); // exactly one new dispatch

    // An id with no registered definition is a safe no-op, not a throw.
    expect(() => scheduler.requestRefresh(['does-not-exist'])).not.toThrow();
  });
});

describe('MspTelemetryScheduler - TelemetryValue transitions', () => {
  it('WAITING before the first dispatch settles, FRESH on first success', async () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester();
    const scheduler = createMspTelemetryScheduler(requester, {clock});
    scheduler.registerPoll(definition('a', 1201, 200, 5000));

    expect(scheduler.getValue<number>('a')).toEqual({status: 'WAITING'});

    scheduler.tick();
    expect(scheduler.getValue<number>('a')).toEqual({status: 'WAITING'}); // dispatched but not yet settled

    requester.resolveNext(makeFrame(1201, Uint8Array.from([42])));
    await scheduler.waitUntilIdle();

    expect(scheduler.getValue<number>('a')).toEqual({status: 'FRESH', value: 42, updatedAtMs: 0, sampleSeq: 1});
  });

  it('FRESH -> STALE once staleAfterMs elapses without a fresh update, made visible via tick() (Pass 7.4: getValue() is a stable cache lookup, not a live computation - see MspTelemetryScheduler.ts\'s own class-level doc comment on why pure clock-advance alone, with no tick(), no longer transitions the reported status)', async () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester();
    const scheduler = createMspTelemetryScheduler(requester, {clock});
    // Huge interval so it never becomes due again during this test.
    scheduler.registerPoll(definition('a', 1202, 100_000, 500));

    scheduler.tick();
    requester.resolveNext(makeFrame(1202, Uint8Array.from([7])));
    await scheduler.waitUntilIdle();
    expect(scheduler.getValue<number>('a')).toEqual({status: 'FRESH', value: 7, updatedAtMs: 0, sampleSeq: 1});

    clock.advance(499);
    scheduler.tick();
    expect(scheduler.getValue<number>('a')).toEqual({status: 'FRESH', value: 7, updatedAtMs: 0, sampleSeq: 1});

    clock.advance(1); // now exactly staleAfterMs (500) old
    scheduler.tick();
    // The sample is unchanged, only older - so it keeps its own sampleSeq.
    expect(scheduler.getValue<number>('a')).toEqual({status: 'STALE', value: 7, updatedAtMs: 0, ageMs: 500, sampleSeq: 1});
  });

  it('a poll that is FRESH but not yet stale is left with the SAME cached reference across repeated getValue() calls (no tick, no dispatch, no change) - the referential-stability contract useSyncExternalStore requires', () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester();
    const scheduler = createMspTelemetryScheduler(requester, {clock});
    scheduler.registerPoll(definition('a', 1205, 100_000, 500));

    scheduler.tick();
    requester.resolveNext(makeFrame(1205, Uint8Array.from([3])));
    return scheduler.waitUntilIdle().then(() => {
      const first = scheduler.getValue<number>('a');
      const second = scheduler.getValue<number>('a');
      expect(first).toBe(second);
    });
  });

  it('ERROR on a failed dispatch - retains only the last-known-GOOD timestamp, never a stale value', async () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester();
    const scheduler = createMspTelemetryScheduler(requester, {clock});
    scheduler.registerPoll(definition('a', 1203, 100, 100_000));

    scheduler.tick();
    requester.resolveNext(makeFrame(1203, Uint8Array.from([3])));
    await scheduler.waitUntilIdle();
    expect(scheduler.getValue<number>('a')).toEqual({status: 'FRESH', value: 3, updatedAtMs: 0, sampleSeq: 1});

    clock.advance(100);
    scheduler.tick();
    const boom = new Error('boom');
    requester.rejectNext(boom);
    await scheduler.waitUntilIdle();

    // updatedAtMs is 0 (the last SUCCESS's time), not 100 (the failure's
    // time), and there is no `value` field at all.
    expect(scheduler.getValue<number>('a')).toEqual({status: 'ERROR', error: boom, updatedAtMs: 0});
  });

  it('a poll that has NEVER once succeeded reports ERROR with updatedAtMs undefined', async () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester();
    const scheduler = createMspTelemetryScheduler(requester, {clock});
    scheduler.registerPoll(definition('a', 1204, 100, 100_000));

    scheduler.tick();
    const boom = new Error('never worked');
    requester.rejectNext(boom);
    await scheduler.waitUntilIdle();

    expect(scheduler.getValue<number>('a')).toEqual({status: 'ERROR', error: boom, updatedAtMs: undefined});
  });
});

describe('MspTelemetryScheduler - getValue for unknown/never-settled ids', () => {
  it('returns UNAVAILABLE for an id with no registered definition at all', () => {
    const scheduler = createMspTelemetryScheduler(createFakeRequester(), {clock: new FakeClock()});
    expect(scheduler.getValue('nope')).toEqual({status: 'UNAVAILABLE'});
  });

  it('returns WAITING for a registered-but-never-yet-settled id', () => {
    const scheduler = createMspTelemetryScheduler(createFakeRequester(), {clock: new FakeClock()});
    scheduler.registerPoll(definition('a', 1301, 1000, 5000));
    expect(scheduler.getValue('a')).toEqual({status: 'WAITING'});
  });
});

describe('MspTelemetryScheduler - unregister', () => {
  it('stops further dispatches for that id and reverts getValue() to UNAVAILABLE', async () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester();
    const scheduler = createMspTelemetryScheduler(requester, {clock});
    const unregister = scheduler.registerPoll(definition('a', 1401, 100, 100_000));

    scheduler.tick();
    requester.resolveNext(makeFrame(1401, Uint8Array.from([1])));
    await scheduler.waitUntilIdle();
    expect(scheduler.getValue<number>('a').status).toBe('FRESH');

    unregister();
    expect(scheduler.getValue<number>('a')).toEqual({status: 'UNAVAILABLE'});

    clock.advance(1000);
    scheduler.tick();
    expect(requester.callCount).toBe(1); // no further dispatch after unregister
  });

  it('a stale unregister function from an OLD registration does not tear down a NEW registration made under the same id', () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester();
    const scheduler = createMspTelemetryScheduler(requester, {clock});

    const unregisterOld = scheduler.registerPoll(definition('a', 1601, 100, 100_000));
    // Fresh registration under the SAME id 'a' - registerPoll() does not
    // require the old one to be unregistered first.
    scheduler.registerPoll(definition('a', 1602, 100, 100_000));

    // The OLD, now-stale unregister function must not affect the NEW
    // registration currently on record for 'a'.
    unregisterOld();

    expect(scheduler.getValue<number>('a')).toEqual({status: 'WAITING'});
  });
});

describe('MspTelemetryScheduler - tick() no-op cases', () => {
  it('is a safe no-op when nothing is registered at all', () => {
    const scheduler = createMspTelemetryScheduler(createFakeRequester(), {clock: new FakeClock()});
    expect(() => scheduler.tick()).not.toThrow();
  });

  it('is a safe no-op when a registered poll is not yet due', () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester();
    const scheduler = createMspTelemetryScheduler(requester, {clock});
    scheduler.registerPoll(definition('a', 1501, 5000, 100_000));

    scheduler.tick(); // due at registration - dispatches once
    expect(requester.callCount).toBe(1);
    requester.resolveNext(makeFrame(1501, Uint8Array.from([1])));

    clock.advance(10); // nowhere near the 5000ms interval
    scheduler.tick();
    expect(requester.callCount).toBe(1); // unchanged
  });
});

describe('MspTelemetryScheduler - subscribe()', () => {
  it('notifies after a dispatch settles successfully', async () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester();
    const scheduler = createMspTelemetryScheduler(requester, {clock});
    scheduler.registerPoll(definition('a', 1601, 200, 100_000));

    const listener = jest.fn();
    scheduler.subscribe(listener);

    scheduler.tick(); // dispatch + one unconditional tick()-end notify
    expect(listener).toHaveBeenCalledTimes(1);

    requester.resolveNext(makeFrame(1601, Uint8Array.from([1])));
    await scheduler.waitUntilIdle();
    expect(listener).toHaveBeenCalledTimes(2); // settle notify
  });

  it('notifies after a dispatch settles with an error', async () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester();
    const scheduler = createMspTelemetryScheduler(requester, {clock});
    scheduler.registerPoll(definition('a', 1602, 200, 100_000));

    const listener = jest.fn();
    scheduler.subscribe(listener);

    scheduler.tick();
    expect(listener).toHaveBeenCalledTimes(1);

    requester.rejectNext(new Error('boom'));
    await scheduler.waitUntilIdle();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  // REWRITTEN BY RECEIVER P1, and the assertion is inverted on purpose.
  // This test previously asserted "notifies at the end of every tick()
  // call, even when nothing is due", which was the mechanism behind the
  // time-based FRESH->STALE transition. P1 drives tick() at 10ms instead
  // of 50ms so a poll's delivered cadence stops being quantised to its
  // own interval; under the old rule that would have meant 100
  // notifications per second to every mounted consumer, essentially all
  // of them reporting no change. Notification is now change-driven.
  // The FRESH->STALE guarantee the old rule existed for is NOT weakened -
  // it is proven by the very next test, which is unchanged.
  it('Receiver P1: a tick that changes nothing notifies nobody, and a genuine change still notifies exactly once', () => {
    const clock = new FakeClock(0);
    const scheduler = createMspTelemetryScheduler(createFakeRequester(), {clock});
    // No poll registered at all - nothing a subscriber could observe via
    // getValue() can possibly have changed.
    const listener = jest.fn();
    scheduler.subscribe(listener);

    scheduler.tick();
    scheduler.tick();
    scheduler.tick();
    expect(listener).toHaveBeenCalledTimes(0);

    // Registering replaces UNAVAILABLE with WAITING for that id - a real
    // snapshot change, so exactly one notification, and no more from the
    // idle ticks that follow it.
    scheduler.registerPoll(definition('a', 1604, 200, 100_000));
    scheduler.tick();
    expect(listener).toHaveBeenCalledTimes(1);
    scheduler.tick();
    scheduler.tick();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('a FRESH poll actually reads back as STALE via getValue() after enough ticks/clock-advances - proving subscribe() is the real mechanism a UI would rely on to notice this', async () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester();
    const scheduler = createMspTelemetryScheduler(requester, {clock});
    scheduler.registerPoll(definition('a', 1603, 100_000, 500)); // huge interval, staleAfterMs=500

    scheduler.tick();
    requester.resolveNext(makeFrame(1603, Uint8Array.from([9])));
    await scheduler.waitUntilIdle();
    expect(scheduler.getValue<number>('a')).toMatchObject({status: 'FRESH'});

    const listener = jest.fn();
    scheduler.subscribe(listener);

    clock.advance(500);
    scheduler.tick(); // no new dispatch (interval huge) - but still notifies
    expect(listener).toHaveBeenCalledTimes(1);
    expect(scheduler.getValue<number>('a')).toMatchObject({status: 'STALE'});
  });

  it('the returned unsubscribe function stops further notifications', () => {
    const clock = new FakeClock(0);
    const scheduler = createMspTelemetryScheduler(createFakeRequester(), {clock});
    const listener = jest.fn();
    const unsubscribe = scheduler.subscribe(listener);

    // Receiver P1: notification is change-driven, so this test now has to
    // produce a real change to observe. Registering a poll is one.
    scheduler.registerPoll(definition('a', 1605, 200, 100_000));
    scheduler.tick();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    scheduler.registerPoll(definition('b', 1606, 200, 100_000));
    scheduler.tick();
    expect(listener).toHaveBeenCalledTimes(1); // unchanged
  });

  it('a throwing listener does not prevent another listener from being notified', () => {
    const clock = new FakeClock(0);
    const scheduler = createMspTelemetryScheduler(createFakeRequester(), {clock});
    const throwing = jest.fn(() => {
      throw new Error('listener boom');
    });
    const normal = jest.fn();
    scheduler.subscribe(throwing);
    scheduler.subscribe(normal);
    // Receiver P1: change-driven notification - give the tick something
    // real to report.
    scheduler.registerPoll(definition('a', 1607, 200, 100_000));

    expect(() => scheduler.tick()).not.toThrow();
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(normal).toHaveBeenCalledTimes(1);
  });
});

describe('MspTelemetryScheduler - getValue() referential stability for WAITING/UNAVAILABLE', () => {
  it('returns the exact same reference across repeated calls for an unregistered id', () => {
    const scheduler = createMspTelemetryScheduler(createFakeRequester(), {clock: new FakeClock()});
    expect(scheduler.getValue('nope')).toBe(scheduler.getValue('nope'));
  });

  it('returns the exact same reference across repeated calls for a registered-but-never-settled id', () => {
    const clock = new FakeClock(0);
    const scheduler = createMspTelemetryScheduler(createFakeRequester(), {clock});
    scheduler.registerPoll(definition('a', 1701, 1000, 5000));
    expect(scheduler.getValue('a')).toBe(scheduler.getValue('a'));
  });
});

describe('MspTelemetryScheduler - Pass 7.6c initialDelayMs (phase stagger)', () => {
  it('defaults to immediately-due at registration when initialDelayMs is absent (pre-7.6c behavior preserved exactly)', () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester();
    const scheduler = createMspTelemetryScheduler(requester, {clock});
    scheduler.registerPoll(definition('a', 501, 200, 100_000));
    scheduler.tick();
    expect(requester.callCount).toBe(1);
  });

  it('delays the FIRST dispatch by exactly initialDelayMs, then resumes the normal interval cadence from the first dispatch time', async () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester((command, payload) => makeFrame(command, payload.length ? payload : Uint8Array.from([1])));
    const scheduler = createMspTelemetryScheduler(requester, {clock});
    scheduler.registerPoll({...definition('aux', 110, 4000, 12_000, -2), initialDelayMs: 700});

    // Not due before the stagger elapses - repeated ticks dispatch nothing.
    scheduler.tick();
    clock.advance(650);
    scheduler.tick();
    expect(requester.callCount).toBe(0);

    // Due exactly at the 700ms boundary.
    clock.advance(50);
    scheduler.tick();
    expect(requester.callCount).toBe(1);
    await scheduler.waitUntilIdle();

    // Next due time comes from the dispatch's own start + intervalMs
    // (700 + 4000 = 4700), NOT initialDelay-relative arithmetic.
    clock.advance(3999);
    scheduler.tick();
    expect(requester.callCount).toBe(1);
    clock.advance(1);
    scheduler.tick();
    expect(requester.callCount).toBe(2);
  });

  it("staggers three aux registrations (700/1400/2100ms, the coordinator's own phases) into distinct first-dispatch times", async () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester((command, payload) => makeFrame(command, payload.length ? payload : Uint8Array.from([1])));
    const scheduler = createMspTelemetryScheduler(requester, {clock});
    scheduler.registerPoll({...definition('receiver', 110, 4000, 12_000, -2), initialDelayMs: 700});
    scheduler.registerPoll({...definition('gps', 106, 5000, 15_000, -3), initialDelayMs: 1400});
    scheduler.registerPoll({...definition('fcStatus', 150, 8000, 24_000, -4), initialDelayMs: 2100});

    const firstDispatchOrder: number[] = [];
    for (let elapsed = 0; elapsed <= 2200; elapsed += 50) {
      scheduler.tick();
      await scheduler.waitUntilIdle();
      while (requester.calls.length > firstDispatchOrder.length) {
        firstDispatchOrder.push(requester.calls[firstDispatchOrder.length].command);
      }
      clock.advance(50);
    }
    expect(firstDispatchOrder).toEqual([110, 106, 150]);
  });
});

describe('MspTelemetryScheduler - Pass 7.6c singleFlight (global concurrency of one)', () => {
  it('default mode (flag absent) still allows overlapping dispatches - pre-7.6c behavior preserved exactly', () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester();
    const scheduler = createMspTelemetryScheduler(requester, {clock});
    scheduler.registerPoll(definition('a', 501, 200, 100_000));
    scheduler.registerPoll(definition('b', 502, 300, 100_000));
    scheduler.tick();
    scheduler.tick();
    expect(requester.callCount).toBe(2);
  });

  it('singleFlight mode never starts a dispatch while another is in flight, across DIFFERENT polls', async () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester();
    const scheduler = createMspTelemetryScheduler(requester, {clock, singleFlight: true});
    scheduler.registerPoll(definition('a', 501, 200, 100_000));
    scheduler.registerPoll(definition('b', 502, 300, 100_000));

    scheduler.tick();
    expect(requester.callCount).toBe(1);

    // b is due too, but a's dispatch is still unsettled - nothing new may
    // start no matter how often tick() runs or how late b becomes.
    scheduler.tick();
    clock.advance(1000);
    scheduler.tick();
    scheduler.tick();
    expect(requester.callCount).toBe(1);

    // The moment the outstanding dispatch settles, the next tick may
    // dispatch exactly one more.
    requester.resolveNext(makeFrame(501, Uint8Array.from([1])));
    await scheduler.waitUntilIdle();
    scheduler.tick();
    expect(requester.callCount).toBe(2);
  });

  it('singleFlight mode produces zero overlap over a long mixed-cadence run (max in-flight is exactly one)', async () => {
    const clock = new FakeClock(0);
    let inFlight = 0;
    let maxInFlight = 0;
    const requester: MspRequester = {
      request(command: number): Promise<MspFrame> {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return Promise.resolve().then(() => {
          inFlight -= 1;
          return makeFrame(command, Uint8Array.from([1]));
        });
      },
    };
    const scheduler = createMspTelemetryScheduler(requester, {clock, singleFlight: true});
    scheduler.registerPoll(definition('attitude', 108, 220, 700, 0));
    scheduler.registerPoll({...definition('receiver', 110, 4000, 12_000, -2), initialDelayMs: 700});
    scheduler.registerPoll({...definition('gps', 106, 5000, 15_000, -3), initialDelayMs: 1400});

    for (let elapsed = 0; elapsed < 20_000; elapsed += 50) {
      clock.advance(50);
      scheduler.tick();
      await scheduler.waitUntilIdle();
    }
    expect(maxInFlight).toBe(1);
  });
});

describe('MspTelemetryScheduler - Pass 7.6c aux alternation (primary never starved by auxiliaries)', () => {
  it('a 50ms primary cannot mathematically starve slow auxiliaries on a link whose service time is slower than that cadence', async () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester((command, payload) =>
      makeFrame(command, payload.length ? payload : Uint8Array.from([1])),
    );
    const scheduler = createMspTelemetryScheduler(requester, {clock, singleFlight: true});
    scheduler.registerPoll(definition('attitude', 108, 50, 500, 0));
    scheduler.registerPoll(definition('battery', 130, 3000, 9000, -1));

    // t=0 tie: primary wins. Thereafter model a slow 224ms round trip by
    // advancing the clock only after each dispatch settles. The primary's
    // overdue ratio is always much larger than battery's, so pure ratio
    // selection would starve battery forever.
    for (let slot = 0; slot < 7; slot++) {
      scheduler.tick();
      await scheduler.waitUntilIdle();
      clock.advance(224);
    }

    const commands = requester.calls.map(call => call.command);
    expect(commands.slice(0, 5)).toEqual([108, 108, 108, 108, 108]);
    expect(commands[5]).toBe(130);
    expect(commands[6]).toBe(108);
  });

  it('after an auxiliary (priority < 0) dispatch, a due primary (priority >= 0) poll wins the next slot even when an auxiliary is MORE overdue by ratio', async () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester((command, payload) => makeFrame(command, payload.length ? payload : Uint8Array.from([1])));
    const scheduler = createMspTelemetryScheduler(requester, {clock, singleFlight: true});
    // Two auxiliaries with SHORT intervals so their overdue ratios can
    // legitimately exceed the primary's, plus one primary.
    scheduler.registerPoll(definition('primary', 108, 220, 700, 0));
    scheduler.registerPoll(definition('auxA', 110, 100, 12_000, -2));
    scheduler.registerPoll(definition('auxB', 106, 100, 15_000, -3));

    // t=0: all three due at ratio 0; priority tiebreak picks the primary.
    scheduler.tick();
    await scheduler.waitUntilIdle();
    expect(requester.calls.map(c => c.command)).toEqual([108]);

    // t=400: auxA/auxB are 3+ intervals overdue (ratio >= 3), primary is
    // due again at a lower ratio. Aux wins ONCE by ratio...
    clock.advance(400);
    scheduler.tick();
    await scheduler.waitUntilIdle();
    expect(requester.calls.map(c => c.command)).toEqual([108, 110]);

    // ...but the next slot must go BACK to the still-due primary (the
    // alternation rule), even though auxB's ratio is still far higher.
    scheduler.tick();
    await scheduler.waitUntilIdle();
    expect(requester.calls.map(c => c.command)).toEqual([108, 110, 108]);

    // With the primary served, the remaining auxiliary now gets its turn.
    scheduler.tick();
    await scheduler.waitUntilIdle();
    expect(requester.calls.map(c => c.command)).toEqual([108, 110, 108, 106]);
  });

  it('two auxiliaries may still run consecutively when NO primary poll is due (the rule only protects a due primary)', async () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester((command, payload) => makeFrame(command, payload.length ? payload : Uint8Array.from([1])));
    const scheduler = createMspTelemetryScheduler(requester, {clock, singleFlight: true});
    scheduler.registerPoll(definition('primary', 108, 10_000, 30_000, 0));
    scheduler.registerPoll(definition('auxA', 110, 100, 12_000, -2));
    scheduler.registerPoll(definition('auxB', 106, 100, 15_000, -3));

    scheduler.tick(); // primary (priority tiebreak at ratio 0)
    await scheduler.waitUntilIdle();
    clock.advance(400); // primary NOT due again for ~10s; both auxes overdue
    scheduler.tick();
    await scheduler.waitUntilIdle();
    scheduler.tick();
    await scheduler.waitUntilIdle();
    expect(requester.calls.map(c => c.command)).toEqual([108, 110, 106]);
  });
});

/**
 * sampleSeq exists so a consumer can say WHICH genuine sample it is
 * looking at. That is what makes "the 3D model and the numeric readouts
 * are showing the same sample" and "sample N+1 superseded sample N"
 * checkable facts rather than timing guesses - see TelemetryValue's own
 * doc comment.
 */
describe('MspTelemetryScheduler - genuine-sample identity', () => {
  it('increments once per SUCCESSFUL decode, and is stable while nothing new arrives', async () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester();
    const scheduler = createMspTelemetryScheduler(requester, {clock});
    scheduler.registerPoll(definition('a', 1301, 100, 100_000));

    scheduler.tick();
    requester.resolveNext(makeFrame(1301, Uint8Array.from([1])));
    await scheduler.waitUntilIdle();
    const first = scheduler.getValue<number>('a');
    expect(first.status === 'FRESH' && first.sampleSeq).toBe(1);

    // Repeated reads of the same sample are the same sample.
    const reread = scheduler.getValue<number>('a');
    expect(reread.status === 'FRESH' && reread.sampleSeq).toBe(1);

    clock.advance(100);
    scheduler.tick();
    requester.resolveNext(makeFrame(1301, Uint8Array.from([2])));
    await scheduler.waitUntilIdle();
    const second = scheduler.getValue<number>('a');
    expect(second.status === 'FRESH' && second.sampleSeq).toBe(2);
  });

  it('does NOT advance on a failed dispatch - an error is not a new sample', async () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester();
    const scheduler = createMspTelemetryScheduler(requester, {clock});
    scheduler.registerPoll(definition('a', 1302, 100, 100_000));

    scheduler.tick();
    requester.resolveNext(makeFrame(1302, Uint8Array.from([1])));
    await scheduler.waitUntilIdle();

    clock.advance(100);
    scheduler.tick();
    requester.rejectNext(new Error('boom'));
    await scheduler.waitUntilIdle();

    clock.advance(100);
    scheduler.tick();
    requester.resolveNext(makeFrame(1302, Uint8Array.from([3])));
    await scheduler.waitUntilIdle();

    // 1 then 2 - the failure in between consumed no sequence number.
    const value = scheduler.getValue<number>('a');
    expect(value.status === 'FRESH' && value.sampleSeq).toBe(2);
  });

  it('survives the FRESH -> STALE transition unchanged - a stale value is still sample N', async () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester();
    const scheduler = createMspTelemetryScheduler(requester, {clock});
    scheduler.registerPoll(definition('a', 1303, 100_000, 500));

    scheduler.tick();
    requester.resolveNext(makeFrame(1303, Uint8Array.from([9])));
    await scheduler.waitUntilIdle();

    clock.advance(500);
    scheduler.tick();
    const value = scheduler.getValue<number>('a');
    expect(value.status).toBe('STALE');
    expect(value.status === 'STALE' && value.sampleSeq).toBe(1);
  });

  it('is scheduler-wide, so two polls never claim the same sample identity', async () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester();
    const scheduler = createMspTelemetryScheduler(requester, {clock});
    scheduler.registerPoll(definition('a', 1304, 100_000, 100_000));
    scheduler.registerPoll(definition('b', 1305, 100_000, 100_000));

    scheduler.tick();
    requester.resolveNext(makeFrame(1304, Uint8Array.from([1])));
    await scheduler.waitUntilIdle();
    scheduler.tick();
    requester.resolveNext(makeFrame(1305, Uint8Array.from([2])));
    await scheduler.waitUntilIdle();

    const a = scheduler.getValue<number>('a');
    const b = scheduler.getValue<number>('b');
    expect(a.status === 'FRESH' && a.sampleSeq).toBe(1);
    expect(b.status === 'FRESH' && b.sampleSeq).toBe(2);
  });

  it('a REPLACEMENT scheduler starts its own count - a sequence is only meaningful within one session', async () => {
    const clock = new FakeClock(0);
    const first = createFakeRequester();
    const schedulerA = createMspTelemetryScheduler(first, {clock});
    schedulerA.registerPoll(definition('a', 1306, 100_000, 100_000));
    schedulerA.tick();
    first.resolveNext(makeFrame(1306, Uint8Array.from([1])));
    await schedulerA.waitUntilIdle();

    const second = createFakeRequester();
    const schedulerB = createMspTelemetryScheduler(second, {clock});
    schedulerB.registerPoll(definition('a', 1306, 100_000, 100_000));
    schedulerB.tick();
    second.resolveNext(makeFrame(1306, Uint8Array.from([1])));
    await schedulerB.waitUntilIdle();

    const value = schedulerB.getValue<number>('a');
    expect(value.status === 'FRESH' && value.sampleSeq).toBe(1);
  });
});

/**
 * CHECKPOINT F - describeDiagnostics(), the read-only observability
 * surface added because a real flight controller reported a frozen Setup
 * orientation and NO boundary in this pipeline was observable from the
 * field. Every assertion below is about REPORTING ONLY: none of them can
 * pass because scheduling behaviour changed, and the last test exists
 * specifically to prove it did not.
 */
describe('MspTelemetryScheduler - Checkpoint F diagnostics', () => {
  it('reports an empty scheduler honestly rather than inventing polls', () => {
    const scheduler = createMspTelemetryScheduler(createFakeRequester(), {clock: new FakeClock(0)});
    expect(scheduler.describeDiagnostics()).toEqual({
      tickCount: 0,
      inFlightCount: 0,
      pauseReasons: [],
      polls: [],
    });
  });

  it('counts ticks, requests and responses against the real dispatch path', async () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester((command, payload) => makeFrame(command, payload.length ? payload : Uint8Array.from([7])));
    const scheduler = createMspTelemetryScheduler(requester, {clock});
    scheduler.registerPoll(definition('attitude', 108, 50, 500));

    scheduler.tick();
    await scheduler.waitUntilIdle();
    clock.advance(60);
    scheduler.tick();
    await scheduler.waitUntilIdle();

    const diagnostics = scheduler.describeDiagnostics();
    expect(diagnostics.tickCount).toBe(2);
    expect(diagnostics.inFlightCount).toBe(0);
    expect(diagnostics.polls).toHaveLength(1);
    expect(diagnostics.polls[0]).toMatchObject({
      id: 'attitude',
      command: 108,
      intervalMs: 50,
      staleAfterMs: 500,
      priority: 0,
      requestCount: 2,
      responseCount: 2,
      errorCount: 0,
      status: 'FRESH',
      inFlight: false,
    });
    expect(diagnostics.polls[0].sampleSeq).toBe(2);
    expect(diagnostics.polls[0].updatedAtMs).toBe(60);
  });

  it('reports a dispatch that is still in flight, rather than looking idle', () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester();
    const scheduler = createMspTelemetryScheduler(requester, {clock});
    scheduler.registerPoll(definition('attitude', 108, 50, 500));

    scheduler.tick();
    const diagnostics = scheduler.describeDiagnostics();
    expect(diagnostics.inFlightCount).toBe(1);
    expect(diagnostics.polls[0]).toMatchObject({requestCount: 1, responseCount: 0, inFlight: true, status: 'WAITING'});
  });

  it('records the failure CODE - never the message - and keeps it after a later success', async () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester();
    const scheduler = createMspTelemetryScheduler(requester, {clock});
    scheduler.registerPoll(definition('attitude', 108, 50, 500));

    scheduler.tick();
    requester.rejectNext(
      Object.assign(new Error('attempted to read 1 byte(s) with only 0 remaining'), {
        name: 'MspClientError',
        code: 'MSP_TIMEOUT',
      }),
    );
    await scheduler.waitUntilIdle();

    expect(scheduler.describeDiagnostics().polls[0]).toMatchObject({
      errorCount: 1,
      lastErrorCode: 'MSP_TIMEOUT',
      status: 'ERROR',
    });

    clock.advance(60);
    scheduler.tick();
    requester.resolveNext(makeFrame(108, Uint8Array.from([3])));
    await scheduler.waitUntilIdle();

    const after = scheduler.describeDiagnostics().polls[0];
    expect(after.status).toBe('FRESH');
    expect(after.responseCount).toBe(1);
    // "it recovered, but it had been failing" survives the recovery.
    expect(after.lastErrorCode).toBe('MSP_TIMEOUT');
    // The message - which MspPayloadReadError builds out of byte offsets
    // - never reaches the report.
    expect(JSON.stringify(after)).not.toContain('attempted to read');
  });

  it('falls back to the error CLASS name when a thrown value carries no code', async () => {
    const requester = createFakeRequester();
    const scheduler = createMspTelemetryScheduler(requester, {clock: new FakeClock(0)});
    scheduler.registerPoll(definition('attitude', 108, 50, 500));
    scheduler.tick();
    requester.rejectNext(new RangeError('anything at all'));
    await scheduler.waitUntilIdle();
    expect(scheduler.describeDiagnostics().polls[0].lastErrorCode).toBe('RangeError');
  });

  it('counts a DECODE failure as an error too, not as a response', async () => {
    const requester = createFakeRequester();
    const scheduler = createMspTelemetryScheduler(requester, {clock: new FakeClock(0)});
    scheduler.registerPoll({
      id: 'attitude',
      command: 108,
      intervalMs: 50,
      staleAfterMs: 500,
      priority: 0,
      decode: () => {
        throw Object.assign(new Error('short payload'), {name: 'MspPayloadReadError'});
      },
    });
    scheduler.tick();
    requester.resolveNext(makeFrame(108, new Uint8Array(0)));
    await scheduler.waitUntilIdle();

    expect(scheduler.describeDiagnostics().polls[0]).toMatchObject({
      requestCount: 1,
      responseCount: 0,
      errorCount: 1,
      lastErrorCode: 'MspPayloadReadError',
      status: 'ERROR',
    });
  });

  it('names every active pause lease and drops each name as it is released', () => {
    const scheduler = createMspTelemetryScheduler(createFakeRequester(), {clock: new FakeClock(0)});
    scheduler.registerPoll(definition('attitude', 108, 50, 500));
    const motorTest = scheduler.acquirePauseLease('MOTOR_TEST');
    const background = scheduler.acquirePauseLease('APP_BACKGROUND');

    expect(scheduler.describeDiagnostics().pauseReasons).toEqual(['MOTOR_TEST', 'APP_BACKGROUND']);

    motorTest.release();
    expect(scheduler.describeDiagnostics().pauseReasons).toEqual(['APP_BACKGROUND']);
    // Releasing twice is a documented no-op and must not corrupt the list.
    motorTest.release();
    expect(scheduler.describeDiagnostics().pauseReasons).toEqual(['APP_BACKGROUND']);

    background.release();
    expect(scheduler.describeDiagnostics().pauseReasons).toEqual([]);
  });

  it('an unregistered poll disappears from the report instead of lingering with stale counts', async () => {
    const requester = createFakeRequester(command => makeFrame(command, Uint8Array.from([1])));
    const scheduler = createMspTelemetryScheduler(requester, {clock: new FakeClock(0)});
    const unregister = scheduler.registerPoll(definition('attitude', 108, 50, 500));
    scheduler.tick();
    await scheduler.waitUntilIdle();
    expect(scheduler.describeDiagnostics().polls).toHaveLength(1);

    unregister();
    expect(scheduler.describeDiagnostics().polls).toHaveLength(0);
  });

  it('CHANGES NOTHING: reading diagnostics repeatedly never dispatches, never advances a deadline and never replaces a cached value', async () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester(command => makeFrame(command, Uint8Array.from([1])));
    const scheduler = createMspTelemetryScheduler(requester, {clock});
    scheduler.registerPoll(definition('attitude', 108, 50, 500));
    scheduler.tick();
    await scheduler.waitUntilIdle();

    const valueBefore = scheduler.getValue('attitude');
    const callsBefore = requester.callCount;
    for (let i = 0; i < 25; i++) {
      scheduler.describeDiagnostics();
    }
    await Promise.resolve();

    expect(requester.callCount).toBe(callsBefore);
    // Referential identity: getValue()'s useSyncExternalStore contract is
    // untouched by anything on this surface.
    expect(scheduler.getValue('attitude')).toBe(valueBefore);
    expect(scheduler.describeDiagnostics().tickCount).toBe(1);
  });
});

/**
 * CONSECUTIVE LINK FAILURES — the health evidence a session-liveness
 * verdict reads (see LINK_DEAD_AFTER_CONSECUTIVE_FAILURES in
 * MspSessionCoordinator.ts).
 *
 * Three properties. The second keeps a flaky link alive: any success on
 * any poll resets the count, because one poll answering proves the link
 * is not dead whatever the others are doing. The third is the one that
 * makes the count trustworthy at all - a dispatch that never reached the
 * hardware says nothing about the hardware.
 */
describe('consecutive link failures', () => {
  /** One dispatch that went out and was not answered. */
  function failAtLink(
    scheduler: ReturnType<typeof createMspTelemetryScheduler>,
    clock: FakeClock,
    requester: ReturnType<typeof createFakeRequester>,
    code: 'MSP_TIMEOUT' | 'MSP_WRITE_OUTCOME_UNKNOWN' | 'MSP_RECOVERY_REQUIRED' = 'MSP_TIMEOUT',
  ) {
    clock.advance(200);
    scheduler.tick();
    requester.rejectNext(new MspClientError(code));
    return scheduler.waitUntilIdle();
  }

  it('starts at zero and counts failures that follow one another', async () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester();
    const scheduler = createMspTelemetryScheduler(requester, {clock});
    scheduler.registerPoll(definition('a', 10, 100, 500));
    expect(scheduler.getConsecutiveLinkFailureCount()).toBe(0);

    for (let round = 1; round <= 3; round += 1) {
      await failAtLink(scheduler, clock, requester);
      expect(scheduler.getConsecutiveLinkFailureCount()).toBe(round);
    }
  });

  it('is reset to zero by a single success on ANY poll', async () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester();
    const scheduler = createMspTelemetryScheduler(requester, {clock});
    scheduler.registerPoll(definition('a', 10, 100, 500));
    scheduler.registerPoll(definition('b', 11, 100, 500));

    await failAtLink(scheduler, clock, requester);
    await failAtLink(scheduler, clock, requester);
    expect(scheduler.getConsecutiveLinkFailureCount()).toBe(2);

    // A DIFFERENT poll answers. The link is alive.
    clock.advance(200);
    scheduler.tick();
    requester.resolveNext(makeFrame(11, Uint8Array.from([7])));
    await scheduler.waitUntilIdle();
    expect(scheduler.getConsecutiveLinkFailureCount()).toBe(0);
  });

  /**
   * THE FALSE-LOSS REGRESSION, and it was a real one.
   *
   * A single unanswered auxiliary poll desynchronizes MspClient, which
   * then refuses every dispatch with MSP_RECOVERING - instantly, without
   * touching the wire - until its own recovery probe answers. Counting
   * those refusals killed a live session in milliseconds off ONE dropped
   * packet, which is exactly the false loss this count exists to avoid.
   * A refusal is not an answer, so it must move the count neither up
   * nor down.
   */
  it('ignores failures that never reached the link, and does not clear the count either', async () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester();
    const scheduler = createMspTelemetryScheduler(requester, {clock});
    scheduler.registerPoll(definition('a', 10, 100, 500));

    await failAtLink(scheduler, clock, requester); // a genuine timeout
    expect(scheduler.getConsecutiveLinkFailureCount()).toBe(1);

    // Everything MspClient can refuse locally, plus the FC answering with
    // an error frame - which proves the link is working, not broken.
    for (const code of [
      'MSP_RECOVERING',
      'MSP_QUEUE_FULL',
      'MSP_TRANSPORT_QUEUE_FULL',
      'MSP_ENCODE_FAILED',
      'MSP_REMOTE_ERROR',
    ] as const) {
      clock.advance(200);
      scheduler.tick();
      requester.rejectNext(new MspClientError(code));
      await scheduler.waitUntilIdle();
      expect(scheduler.getConsecutiveLinkFailureCount()).toBe(1);
    }

    // ...and a terminal RECOVERY_FAILED verdict IS link evidence: it is
    // what keeps a genuinely dead board detectable once no dispatch can
    // reach the wire to time out any more.
    await failAtLink(scheduler, clock, requester, 'MSP_RECOVERY_REQUIRED');
    expect(scheduler.getConsecutiveLinkFailureCount()).toBe(2);
  });
});
