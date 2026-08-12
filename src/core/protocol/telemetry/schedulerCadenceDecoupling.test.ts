/**
 * RECEIVER P1: the scheduler's opportunity clock is decoupled from any
 * poll's requested interval.
 *
 * WHAT THIS SUITE EXISTS TO PIN. Before P1 the tick driver and the
 * fastest poll were both 50ms, so the achieved period of any poll was
 * quantised up to a whole number of 50ms ticks. A round trip of 51ms
 * therefore missed its own slot and waited a full extra period, halving
 * the delivered rate (~19Hz -> ~9Hz) on one millisecond of service time.
 * That cliff is the measured cause of the slow Receiver channel bars.
 *
 * Every number below is produced by driving the REAL, unmodified
 * MspTelemetryScheduler under a FakeClock with the REAL production poll
 * set. Nothing here measures hardware: `serviceMs` is an injected model
 * of link cost, and the achieved rates are a property of the SOFTWARE
 * only. Real service time remains REQUIRES HARDWARE TEST.
 */

import {createMspTelemetryScheduler, type MspTelemetryScheduler} from './MspTelemetryScheduler';
import {FakeClock} from './clock';
import {TELEMETRY_TICK_INTERVAL_MS} from '../../../platforms/react-native/protocol/MspSessionCoordinator';
import {RECEIVER_CHANNELS_POLL_INTERVAL_MS} from '../../../platforms/react-native/protocol/receiverTelemetry';

const RC_POLL_ID = 'receiver-channels-live';
const MSP_RC = 105;
const MSP_ATTITUDE = 108;

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

interface Pending {
  at: number;
  command: number;
  settle: () => void;
}

interface RunResult {
  rcSamples: number;
  rcHz: number;
  meanGapMs: number;
  worstGapMs: number;
  dispatchesByCommand: Map<number, number>;
  maxConcurrentInFlight: number;
  scheduler: MspTelemetryScheduler;
}

/**
 * Drives the real scheduler over `durationMs` of fake time on a
 * `tickMs` grid, answering every request after exactly `serviceMs`.
 *
 * Event-driven rather than millisecond-stepped: the clock only ever
 * advances to the next tick boundary or the next response, so the model
 * cannot silently skip either.
 */
async function run(options: {
  tickMs: number;
  rcIntervalMs: number;
  serviceMs: number;
  durationMs: number;
  withAuxiliaries?: boolean;
  suppressAttitude?: boolean;
}): Promise<RunResult> {
  const {
    tickMs,
    rcIntervalMs,
    serviceMs,
    durationMs,
    withAuxiliaries = true,
    suppressAttitude = true,
  } = options;

  const clock = new FakeClock(0);
  const pending: Pending[] = [];
  const dispatchesByCommand = new Map<number, number>();
  let inFlight = 0;
  let maxConcurrentInFlight = 0;

  const requester = {
    request: (command: number) => {
      dispatchesByCommand.set(command, (dispatchesByCommand.get(command) ?? 0) + 1);
      inFlight += 1;
      maxConcurrentInFlight = Math.max(maxConcurrentInFlight, inFlight);
      return new Promise(resolve => {
        pending.push({
          at: clock.now() + serviceMs,
          command,
          settle: () => {
            inFlight -= 1;
            resolve({
              protocolVersion: 'v1',
              wireFormat: 'v1',
              direction: 'in',
              command,
              flags: 0,
              payload: new Uint8Array(16),
            });
          },
        });
      });
    },
  };

  const scheduler = createMspTelemetryScheduler(requester as never, {clock, singleFlight: true});
  const rcSampleTimes: number[] = [];

  scheduler.registerPoll({
    id: 'attitude',
    command: MSP_ATTITUDE,
    intervalMs: 50,
    staleAfterMs: 500,
    priority: 0,
    decode: () => ({roll: 0}),
  });
  scheduler.registerPoll({
    id: RC_POLL_ID,
    command: MSP_RC,
    intervalMs: rcIntervalMs,
    staleAfterMs: 700,
    priority: 2,
    decode: () => {
      rcSampleTimes.push(clock.now());
      return {channels: []};
    },
  });
  if (withAuxiliaries) {
    scheduler.registerPoll({id: 'battery', command: 130, intervalMs: 3000, staleAfterMs: 9000, priority: -1, decode: () => ({})});
    scheduler.registerPoll({id: 'receiver', command: 110, intervalMs: 4000, staleAfterMs: 12000, priority: -2, initialDelayMs: 700, decode: () => ({})});
    scheduler.registerPoll({id: 'gps', command: 106, intervalMs: 5000, staleAfterMs: 15000, priority: -3, initialDelayMs: 1400, decode: () => ({})});
    scheduler.registerPoll({id: 'fcStatus', command: 150, intervalMs: 8000, staleAfterMs: 24000, priority: -4, initialDelayMs: 2100, decode: () => ({})});
  }
  if (suppressAttitude) {
    scheduler.acquirePollSuppression('attitude');
  }

  let nextTickAt = 0;
  for (let guard = 0; guard < 4_000_000; guard += 1) {
    const nextResponseAt = pending.length > 0 ? Math.min(...pending.map(p => p.at)) : Infinity;
    const target = Math.min(nextTickAt, nextResponseAt);
    if (!Number.isFinite(target) || target > durationMs) {
      break;
    }
    clock.set(target);
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      if (pending[i].at <= clock.now()) {
        const [settled] = pending.splice(i, 1);
        settled.settle();
      }
    }
    await flush();
    if (clock.now() >= nextTickAt) {
      scheduler.tick();
      nextTickAt += tickMs;
      await flush();
    }
  }

  const gaps: number[] = [];
  for (let i = 1; i < rcSampleTimes.length; i += 1) {
    gaps.push(rcSampleTimes[i] - rcSampleTimes[i - 1]);
  }
  return {
    rcSamples: rcSampleTimes.length,
    rcHz: Number(((rcSampleTimes.length / durationMs) * 1000).toFixed(1)),
    meanGapMs: gaps.length === 0 ? NaN : Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length),
    worstGapMs: gaps.length === 0 ? NaN : Math.max(...gaps),
    dispatchesByCommand,
    maxConcurrentInFlight,
    scheduler,
  };
}

const PRODUCTION = {tickMs: TELEMETRY_TICK_INTERVAL_MS, rcIntervalMs: RECEIVER_CHANNELS_POLL_INTERVAL_MS};

describe('Receiver P1 - opportunity clock is decoupled from poll interval', () => {
  jest.setTimeout(120_000);

  it('P1-A/13: the production tick period is strictly finer than the Receiver interval, so the interval no longer defines the ceiling', () => {
    expect(TELEMETRY_TICK_INTERVAL_MS).toBeLessThan(RECEIVER_CHANNELS_POLL_INTERVAL_MS);
    // The specific defect was the two being EQUAL. Pin that they are not.
    expect(TELEMETRY_TICK_INTERVAL_MS).not.toBe(RECEIVER_CHANNELS_POLL_INTERVAL_MS);
  });

  it('P1-A/13: a poll declared FASTER than the old 50ms grid is no longer capped at ~20Hz', async () => {
    // The pre-P1 proof of the defect: declaring MSP_RC at 10ms measured
    // exactly 20.0Hz because the 50ms tick, not the interval, was the
    // ceiling. On the decoupled grid the same declaration is free to run
    // far faster, which is what shows the ceiling has genuinely moved.
    const onOldGrid = await run({tickMs: 50, rcIntervalMs: 10, serviceMs: 5, durationMs: 5_000});
    expect(onOldGrid.rcHz).toBeLessThanOrEqual(20.2);

    const onNewGrid = await run({tickMs: TELEMETRY_TICK_INTERVAL_MS, rcIntervalMs: 10, serviceMs: 5, durationMs: 5_000});
    expect(onNewGrid.rcHz).toBeGreaterThan(50);
  });
});

describe('Receiver P1 - graceful degradation across service time (P1-C)', () => {
  jest.setTimeout(180_000);

  // One run per service time, at the real production configuration.
  const cases = [5, 15, 30, 49, 51, 75, 100, 150, 224];
  const measured = new Map<number, RunResult>();

  beforeAll(async () => {
    for (const serviceMs of cases) {
      measured.set(serviceMs, await run({...PRODUCTION, serviceMs, durationMs: 8_000}));
    }
  });

  /**
   * The rate a single poll can achieve on this grid, from first
   * principles: it may dispatch again once BOTH its own interval has
   * elapsed and the link is free, and only on a tick boundary.
   *
   *     period = ceil(max(interval, serviceMs) / tick) * tick
   *
   * Asserting a FRACTION of this - rather than nine hand-picked numbers -
   * is what makes the suite meaningful: it pins the architecture, and the
   * shortfall it tolerates is exactly the link time the scheduler is
   * expected to hand to the other telemetry families (P1-E). Numbers
   * copied from an observed run would only restate whatever the code did.
   */
  const gridLimitedHz = (serviceMs: number): number => {
    const tick = PRODUCTION.tickMs;
    const period = Math.ceil(Math.max(PRODUCTION.rcIntervalMs, serviceMs) / tick) * tick;
    return 1000 / period;
  };

  it.each(cases.map(serviceMs => [serviceMs] as const))(
    'P1-P items 4-12: service time %ims delivers at least 75%% of the grid-limited rate, the remainder being link time yielded to other telemetry',
    serviceMs => {
      const result = measured.get(serviceMs)!;
      expect(result.rcHz).toBeGreaterThanOrEqual(gridLimitedHz(serviceMs) * 0.75);
      // ...and never MORE than the grid physically allows, which would
      // mean overlapping requests.
      expect(result.rcHz).toBeLessThanOrEqual(gridLimitedHz(serviceMs) + 0.5);
    },
  );

  it('P1-P items 4-7: a fast link sustains the 25Hz-class cadence P1-B targets', () => {
    for (const serviceMs of [5, 15, 30]) {
      expect(measured.get(serviceMs)!.rcHz).toBeGreaterThanOrEqual(24);
    }
    // Pre-P1 the same configuration was capped at ~19Hz however fast the
    // link was, and this is the headline improvement.
    expect(measured.get(5)!.rcHz).toBeGreaterThan(19);
  });

  it('P1-P item 8 / P1-C: the 50ms quantisation cliff is gone - crossing 50ms no longer halves the rate', () => {
    const below = measured.get(49)!;
    const above = measured.get(51)!;
    // Pre-P1 this pair measured ~19Hz -> ~9Hz, a ratio of ~2.1x for one
    // millisecond of extra service time. The pathology is the SHARP STEP,
    // so the property asserted is the ratio, not either absolute rate.
    const ratio = below.rcHz / above.rcHz;
    expect(ratio).toBeLessThan(1.5);
    // And concretely: crossing the old boundary must not cost half.
    expect(above.rcHz).toBeGreaterThan(below.rcHz / 1.5);
  });

  it('P1-C: degradation is monotonic - a slower link never delivers MORE samples', () => {
    const rates = cases.map(serviceMs => measured.get(serviceMs)!.rcHz);
    for (let i = 1; i < rates.length; i += 1) {
      expect(rates[i]).toBeLessThanOrEqual(rates[i - 1] + 0.2);
    }
  });

  it('P1-C: mean and worst delivered gaps stay bounded and close together (no stalls hiding inside a good average)', () => {
    for (const serviceMs of cases) {
      const {meanGapMs, worstGapMs} = measured.get(serviceMs)!;
      expect(worstGapMs).toBeLessThanOrEqual(meanGapMs * 3);
    }
  });

  it('P1-D: no overlapping MSP_RC request at any service time - single-flight is preserved', () => {
    for (const serviceMs of cases) {
      expect(measured.get(serviceMs)!.maxConcurrentInFlight).toBe(1);
    }
  });

  it('P1-D: no catch-up burst - a slow link produces FEWER requests, never a replay of missed ones', () => {
    const fast = measured.get(5)!.dispatchesByCommand.get(MSP_RC)!;
    const slow = measured.get(224)!.dispatchesByCommand.get(MSP_RC)!;
    expect(slow).toBeLessThan(fast);
    // Latest-opportunity, not replay-every-missed-poll: an 8s window at a
    // 224ms service time can physically fit ~35 round trips. Anything
    // near 8000/33 (~242) would mean missed demands had been queued.
    expect(slow).toBeLessThanOrEqual(40);
  });
});

describe('Receiver P1 - telemetry fairness under mixed load (P1-E)', () => {
  jest.setTimeout(120_000);

  it('raising Receiver responsiveness does not starve any other registered telemetry family', async () => {
    const result = await run({...PRODUCTION, serviceMs: 15, durationMs: 30_000, suppressAttitude: false});
    const counts = result.dispatchesByCommand;

    // Every family must have been served, repeatedly, over 30s.
    // Expected minimums are derived from each poll's own interval with
    // generous slack, NOT from an observed run: battery 30000/3000 = 10,
    // analog 7, gps 6, status 3.
    expect(counts.get(130) ?? 0).toBeGreaterThanOrEqual(8);
    expect(counts.get(110) ?? 0).toBeGreaterThanOrEqual(6);
    expect(counts.get(106) ?? 0).toBeGreaterThanOrEqual(5);
    expect(counts.get(150) ?? 0).toBeGreaterThanOrEqual(3);
    // Attitude is unsuppressed here and must keep a responsive share.
    expect(counts.get(MSP_ATTITUDE) ?? 0).toBeGreaterThanOrEqual(500);
    // ...and Receiver still gets the responsive channel it asked for.
    expect(result.rcHz).toBeGreaterThanOrEqual(15);
  });

  it('P1-E: the existing MAX_CONSECUTIVE_PRIMARY_DISPATCHES policy remains sufficient - a due auxiliary is never deferred indefinitely', async () => {
    // Worst case for an auxiliary: a fast primary that is always due.
    // With attitude suppressed the Receiver poll is the only primary, so
    // if the aux-alternation rule were broken the slow polls would never
    // run at all.
    const result = await run({...PRODUCTION, serviceMs: 15, durationMs: 20_000});
    expect(result.dispatchesByCommand.get(130) ?? 0).toBeGreaterThanOrEqual(5);
    expect(result.dispatchesByCommand.get(150) ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('P1-F: attitude suppression still yields the link, and releasing it restores attitude', async () => {
    const suppressed = await run({...PRODUCTION, serviceMs: 15, durationMs: 5_000, suppressAttitude: true});
    expect(suppressed.dispatchesByCommand.get(MSP_ATTITUDE) ?? 0).toBe(0);

    const unsuppressed = await run({...PRODUCTION, serviceMs: 15, durationMs: 5_000, suppressAttitude: false});
    expect(unsuppressed.dispatchesByCommand.get(MSP_ATTITUDE) ?? 0).toBeGreaterThan(0);
  });
});

describe('Receiver P1 - notification discipline (P1-G)', () => {
  it('a faster clock does not multiply subscriber notifications: an idle scheduler notifies zero times per tick', async () => {
    const clock = new FakeClock(0);
    const scheduler = createMspTelemetryScheduler(
      {request: () => new Promise(() => {})} as never,
      {clock, singleFlight: true},
    );
    const listener = jest.fn();
    scheduler.subscribe(listener);

    // 100 ticks = one second at the production 10ms grid.
    for (let i = 0; i < 100; i += 1) {
      clock.advance(TELEMETRY_TICK_INTERVAL_MS);
      scheduler.tick();
    }
    // Pre-P1 this was exactly 100. Nothing changed, so nothing is said.
    expect(listener).toHaveBeenCalledTimes(0);
  });

  it('notification tracks actual snapshot changes, not ticks', async () => {
    const clock = new FakeClock(0);
    let settle: ((frame: unknown) => void) | undefined;
    const scheduler = createMspTelemetryScheduler(
      {request: () => new Promise(resolve => {settle = resolve;})} as never,
      {clock, singleFlight: true},
    );
    scheduler.registerPoll({
      id: RC_POLL_ID,
      command: MSP_RC,
      intervalMs: RECEIVER_CHANNELS_POLL_INTERVAL_MS,
      staleAfterMs: 700,
      priority: 2,
      decode: () => ({channels: [1500]}),
    });
    const listener = jest.fn();
    scheduler.subscribe(listener);

    // Registration marked the scheduler dirty, so the first tick reports
    // it once - then silence while the request is outstanding.
    scheduler.tick();
    expect(listener).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 20; i += 1) {
      clock.advance(TELEMETRY_TICK_INTERVAL_MS);
      scheduler.tick();
    }
    expect(listener).toHaveBeenCalledTimes(1);

    // A delivered sample is a real change.
    settle?.({protocolVersion: 'v1', wireFormat: 'v1', direction: 'in', command: MSP_RC, flags: 0, payload: new Uint8Array(2)});
    await flush();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(scheduler.getValue(RC_POLL_ID)).toMatchObject({status: 'FRESH'});
  });

  it('P1-H: FRESH -> STALE still fires without any new MSP response, and a new sample restores FRESH', async () => {
    const clock = new FakeClock(0);
    let settle: ((frame: unknown) => void) | undefined;
    const frame = {protocolVersion: 'v1', wireFormat: 'v1', direction: 'in', command: MSP_RC, flags: 0, payload: new Uint8Array(2)};
    const scheduler = createMspTelemetryScheduler(
      {request: () => new Promise(resolve => {settle = resolve;})} as never,
      {clock, singleFlight: true},
    );
    scheduler.registerPoll({
      id: RC_POLL_ID,
      command: MSP_RC,
      intervalMs: RECEIVER_CHANNELS_POLL_INTERVAL_MS,
      staleAfterMs: 700,
      priority: 2,
      decode: () => ({channels: [1500]}),
    });

    scheduler.tick();
    settle?.(frame);
    await flush();
    expect(scheduler.getValue(RC_POLL_ID)).toMatchObject({status: 'FRESH'});

    const listener = jest.fn();
    scheduler.subscribe(listener);

    // Cross staleAfterMs with no response at all. The poll re-dispatches
    // on the way (its interval is shorter), but nothing ever settles.
    clock.advance(700);
    scheduler.tick();
    expect(scheduler.getValue(RC_POLL_ID)).toMatchObject({status: 'STALE'});
    expect(listener).toHaveBeenCalledTimes(1);

    // A stale poll must not notify on every subsequent tick either.
    const afterStale = listener.mock.calls.length;
    for (let i = 0; i < 20; i += 1) {
      clock.advance(TELEMETRY_TICK_INTERVAL_MS);
      scheduler.tick();
    }
    // 20 ticks = 200ms, inside one STALE_AGE_REFRESH_INTERVAL_MS window.
    expect(listener).toHaveBeenCalledTimes(afterStale);

    // The age does keep advancing, just not on every tick.
    clock.advance(300);
    scheduler.tick();
    expect(listener.mock.calls.length).toBeGreaterThan(afterStale);
    expect(scheduler.getValue(RC_POLL_ID)).toMatchObject({status: 'STALE'});

    // And a genuine new sample restores FRESH.
    settle?.(frame);
    await flush();
    expect(scheduler.getValue(RC_POLL_ID)).toMatchObject({status: 'FRESH'});
  });
});

describe('Receiver P1 - observed cadence metrics (P1-K/P1-L)', () => {
  jest.setTimeout(60_000);

  it('reports delivered cadence and link service time derived from real samples, not from the declared interval', async () => {
    const {scheduler} = await run({...PRODUCTION, serviceMs: 15, durationMs: 5_000});
    const rc = scheduler.describeDiagnostics().polls.find(poll => poll.id === RC_POLL_ID)!;

    expect(rc.intervalMs).toBe(RECEIVER_CHANNELS_POLL_INTERVAL_MS);
    expect(rc.deliveredSampleCount).toBeGreaterThan(50);
    // The measurement path exists precisely so these can differ.
    expect(rc.meanServiceMs).toBe(15);
    expect(rc.minServiceMs).toBe(15);
    expect(rc.maxServiceMs).toBe(15);
    expect(rc.meanSampleGapMs).toBeGreaterThanOrEqual(35);
    expect(rc.meanSampleGapMs).toBeLessThanOrEqual(45);
    expect(rc.observedSampleRateHz).toBeGreaterThanOrEqual(22);
    expect(rc.observedSampleRateHz).toBeLessThanOrEqual(29);
    expect(rc.worstSampleGapMs).toBeGreaterThan(0);
  });

  it('the cadence window is bounded and resets with the registration (and therefore with the session)', async () => {
    const {scheduler} = await run({...PRODUCTION, serviceMs: 15, durationMs: 5_000});
    const before = scheduler.describeDiagnostics().polls.find(poll => poll.id === RC_POLL_ID)!;
    expect(before.deliveredSampleCount).toBeGreaterThan(50);

    // A fresh scheduler is what a replacement session gets.
    const fresh = await run({...PRODUCTION, serviceMs: 15, durationMs: 0});
    const after = fresh.scheduler.describeDiagnostics().polls.find(poll => poll.id === RC_POLL_ID)!;
    expect(after.deliveredSampleCount).toBe(0);
    expect(after.observedSampleRateHz).toBeUndefined();
    expect(after.meanServiceMs).toBeUndefined();
  });

  it('a slower link is visible in the metrics as a longer service time and a wider sample gap', async () => {
    const slow = await run({...PRODUCTION, serviceMs: 224, durationMs: 8_000});
    const rc = slow.scheduler.describeDiagnostics().polls.find(poll => poll.id === RC_POLL_ID)!;
    expect(rc.meanServiceMs).toBe(224);
    expect(rc.meanSampleGapMs).toBeGreaterThanOrEqual(225);
    expect(rc.observedSampleRateHz).toBeLessThan(6);
  });
});

describe('Receiver P1 - stale async safety (P1-I)', () => {
  it('a response that lands after its poll was unregistered cannot publish fresh data', async () => {
    const clock = new FakeClock(0);
    let settle: ((frame: unknown) => void) | undefined;
    const scheduler = createMspTelemetryScheduler(
      {request: () => new Promise(resolve => {settle = resolve;})} as never,
      {clock, singleFlight: true},
    );
    const unregister = scheduler.registerPoll({
      id: RC_POLL_ID,
      command: MSP_RC,
      intervalMs: RECEIVER_CHANNELS_POLL_INTERVAL_MS,
      staleAfterMs: 700,
      priority: 2,
      decode: () => ({channels: [1500]}),
    });

    scheduler.tick(); // dispatches; response still outstanding
    unregister(); // session/screen went away mid-flight

    settle?.({protocolVersion: 'v1', wireFormat: 'v1', direction: 'in', command: MSP_RC, flags: 0, payload: new Uint8Array(2)});
    await flush();

    // The in-flight dispatch was never cancelled - it simply has nowhere
    // registered left to publish to.
    expect(scheduler.getValue(RC_POLL_ID)).toEqual({status: 'UNAVAILABLE'});
  });
});
