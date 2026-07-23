/**
 * Pull-driven, fully deterministic tests: FakeClock + explicit tick()
 * calls + a fake requester, never Jest fake timers - see
 * MspTelemetryScheduler.ts's own class-level doc comment on why tick()
 * is designed to make this possible at all.
 */

import {createMspTelemetryScheduler} from './MspTelemetryScheduler';
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

    expect(scheduler.getValue<number>('a')).toEqual({status: 'FRESH', value: 42, updatedAtMs: 0});
  });

  it('FRESH -> STALE once staleAfterMs elapses without a fresh update, via pure clock advance alone (no tick needed)', async () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester();
    const scheduler = createMspTelemetryScheduler(requester, {clock});
    // Huge interval so it never becomes due again during this test.
    scheduler.registerPoll(definition('a', 1202, 100_000, 500));

    scheduler.tick();
    requester.resolveNext(makeFrame(1202, Uint8Array.from([7])));
    await scheduler.waitUntilIdle();
    expect(scheduler.getValue<number>('a')).toEqual({status: 'FRESH', value: 7, updatedAtMs: 0});

    clock.advance(499);
    expect(scheduler.getValue<number>('a')).toEqual({status: 'FRESH', value: 7, updatedAtMs: 0});

    clock.advance(1); // now exactly staleAfterMs (500) old
    expect(scheduler.getValue<number>('a')).toEqual({status: 'STALE', value: 7, updatedAtMs: 0, ageMs: 500});
  });

  it('ERROR on a failed dispatch - retains only the last-known-GOOD timestamp, never a stale value', async () => {
    const clock = new FakeClock(0);
    const requester = createFakeRequester();
    const scheduler = createMspTelemetryScheduler(requester, {clock});
    scheduler.registerPoll(definition('a', 1203, 100, 100_000));

    scheduler.tick();
    requester.resolveNext(makeFrame(1203, Uint8Array.from([3])));
    await scheduler.waitUntilIdle();
    expect(scheduler.getValue<number>('a')).toEqual({status: 'FRESH', value: 3, updatedAtMs: 0});

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
