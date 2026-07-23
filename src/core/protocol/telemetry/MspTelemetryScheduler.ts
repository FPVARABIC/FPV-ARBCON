/**
 * Pass 7.2: pure scheduling logic for recurring MSP telemetry polls
 * (e.g. MSP_ATTITUDE). PURE LOGIC ONLY - no React, no wiring into
 * MspSessionCoordinator, no hardware, no UI, no MspOperationCoordinator.
 * Those are all later passes, built on top of this.
 *
 * ==========================================================================
 * DRIVING MECHANISM IS PULL-BASED, NOT SELF-TIMED
 * ==========================================================================
 * This scheduler never calls setTimeout/setInterval to decide when to
 * check what's due. tick() is the only entry point that advances
 * scheduling state, and it is entirely the CALLER's responsibility to
 * invoke it (periodically, via whatever real timer mechanism a later
 * pass chooses - that decision does not belong here). Combined with
 * FakeClock (clock.ts), this makes every test in this pass fully
 * deterministic with nothing but "advance the clock, call tick(),
 * assert" - no Jest fake timers layered on top, matching this project's
 * existing strong preference for deterministic control over real/fake
 * timer mechanics wherever avoidable (see pollingCapacityAudit.ts's own
 * DEFAULT_STATE_POLL_INTERVAL_MS precedent for the one case in this
 * codebase where a real poll loop genuinely was unavoidable - that
 * constraint does not apply here, since this scheduler owns no timer at
 * all).
 *
 * ==========================================================================
 * AT MOST ONE PENDING DEMAND PER POLL - NO GROWING BACKLOG
 * ==========================================================================
 * "Due" is not a queued/counted event - it is a pure boolean derived from
 * comparing the clock to each poll's own `dueAtMs` threshold
 * (now >= dueAtMs). A poll that crosses its due threshold three times
 * before actually being dispatched is simply still "due" the whole time;
 * there is nothing to coalesce because there was never a queue to begin
 * with. The instant it dispatches, `dueAtMs` is pushed forward from the
 * dispatch's OWN start time (not from the missed prior deadlines), so a
 * long-neglected poll never bursts multiple catch-up dispatches once it
 * finally gets served.
 *
 * ==========================================================================
 * DEADLINE-AWARE SELECTION FORMULA
 * ==========================================================================
 * On tick(), among all registered polls that are due (now >= dueAtMs),
 * not currently in flight, and not globally paused, at most ONE is
 * selected to dispatch this call - never more than one dispatch started
 * per tick() (see the note on this below). Selection ranks candidates by
 *
 *     overdueRatio = (now - dueAtMs) / intervalMs
 *
 * i.e. how overdue a poll is EXPRESSED AS A FRACTION OF ITS OWN INTERVAL,
 * not raw milliseconds - highest ratio wins; a strict tie in ratio is
 * broken by `priority` (higher wins). Raw-millisecond overdue was
 * deliberately rejected: a slow poll (e.g. 1000ms interval) is easily 5x
 * more raw-ms overdue than a fast poll (e.g. 220ms interval) can ever
 * get before the fast poll's own next deadline arrives, which would let
 * any slow poll systematically dominate selection purely by having a
 * long interval, starving the fast poll. Normalizing by each poll's own
 * interval instead measures "how much of my own cadence have I already
 * missed", which is the actual fairness question this scheduler needs to
 * answer, and is what the Fairness test in MspTelemetryScheduler.test.ts
 * exercises directly.
 *
 * Only one dispatch is started per tick() call, by design: this keeps
 * tick() itself synchronous and its cost bounded regardless of how many
 * polls are simultaneously overdue, and it's what makes the deadline-
 * aware ranking meaningful at all (if every due poll fired every tick(),
 * there would be nothing to rank). A caller driving tick() frequently
 * relative to the fastest registered interval (as this pass's own tests
 * do, and as the real hardware ceiling from Pass 7.0 - ~220-225ms per
 * MSP_ATTITUDE round trip - implies any real polling loop naturally
 * would) still serves every due poll promptly; a caller invoking tick()
 * only rarely would see the same ranking logic simply catch up over
 * several calls. This is believed to be correct for this scheduler's
 * scope; if a future pass finds a real need to start multiple
 * concurrent dispatches within one tick() (e.g. a burst of first-ever
 * registrations all becoming due simultaneously at startup), that is a
 * deliberate change to make explicitly then, not something silently
 * assumed here.
 *
 * ==========================================================================
 * REFERENCE-COUNTED PAUSE
 * ==========================================================================
 * acquirePauseLease() can be called multiple times concurrently (e.g.
 * one lease for an in-progress exclusive MSP_SET operation, another for
 * a simultaneous recovery cycle); polling only actually resumes once
 * EVERY outstanding lease has been release()'d. This is a single GLOBAL
 * pause, not per-poll - once any lease is held, tick() dispatches
 * nothing at all, matching the coalescing behavior above (a poll that
 * becomes due while paused simply stays due; nothing is lost).
 * Releasing an already-released lease is a safe no-op.
 *
 * ==========================================================================
 * IN-FLIGHT DISPATCHES ARE NEVER CANCELLED
 * ==========================================================================
 * waitUntilIdle() only ever WAITS for an in-flight dispatch to settle -
 * it never cancels one, mirroring MspClient's own "never cancel an
 * in-flight request" principle (mspClient.ts's own doc comment).
 * discardPendingDemands() only touches demands that have NOT yet
 * dispatched (by pushing their dueAtMs forward, same mechanism as a
 * normal dispatch would) - an in-flight dispatch is left completely
 * alone and will still update this scheduler's state when it settles.
 */

import type {MspFrame} from '../mspTypes';
import type {MspRequester} from '../msp/identification/MspIdentificationService';
import type {MspRequestOptions} from '../mspClient';
import type {MonotonicClock} from './clock';
import {RealClock} from './clock';
import type {MspPollDefinition, TelemetryPauseLease, TelemetryPauseReason, TelemetryValue} from './telemetryTypes';

const EMPTY_PAYLOAD = new Uint8Array(0);

/** All currently-envisioned polls (MSP_ATTITUDE and its likely near-term
 * siblings) are classic single-byte-command MSP v1 GET requests, the
 * same 'v1' wireFormat used throughout this codebase for that class of
 * command (see pollingCapacityAudit.ts's/MspIdentificationService.ts's
 * own REQUEST_OPTIONS precedent). MspPollDefinition deliberately has no
 * wireFormat field of its own - if a future poll genuinely needs MSP v2,
 * that is a deliberate addition to MspPollDefinition to make explicitly
 * then, not something this pass should speculatively add support for
 * now. Flagged here per this pass's own instruction to report design
 * choices rather than silently assume them. */
const REQUEST_OPTIONS: MspRequestOptions = {wireFormat: 'v1'};

type PollOutcome<T> = {type: 'success'; value: T; updatedAtMs: number} | {type: 'error'; error: unknown};

interface PollRuntimeState<T = unknown> {
  definition: MspPollDefinition<T>;
  /** The next time this poll becomes due. Advanced to
   * `dispatchStartMs + intervalMs` at the START of each dispatch (not at
   * settle time, and not incrementally from the previous dueAtMs) - see
   * this file's own class-level doc comment on why catch-up bursts are
   * deliberately avoided this way. */
  dueAtMs: number;
  inFlight: boolean;
  lastOutcome: PollOutcome<T> | undefined;
  /** Timestamp of the most recent SUCCESSFUL dispatch, independent of
   * lastOutcome (which reflects only the MOST RECENT dispatch, success
   * or failure). Used only to populate ERROR's optional `updatedAtMs` -
   * see telemetryTypes.ts's own doc comment on that field's meaning. */
  lastSuccessAtMs: number | undefined;
}

export interface MspTelemetryScheduler {
  /** Returns an unregister function. After unregistering, getValue(id)
   * reverts to UNAVAILABLE and no further dispatches are started for
   * this id - but see this file's own doc comment: an already in-flight
   * dispatch for this id is NOT cancelled, it simply has nowhere
   * registered left to write its result once it settles. */
  registerPoll<T>(definition: MspPollDefinition<T>): () => void;
  getValue<T>(id: string): TelemetryValue<T>;
  /** See this file's own class-level doc comment: the caller-driven,
   * pull-based entry point. Calling tick() with nothing currently due
   * (or while paused) is a safe no-op - no dispatch, no error. */
  tick(): void;
  acquirePauseLease(reason: TelemetryPauseReason): TelemetryPauseLease;
  /** Resolves once no poll dispatch is currently in flight. Never
   * cancels one - see this file's own class-level doc comment. */
  waitUntilIdle(): Promise<void>;
  /** Drops any NOT-yet-dispatched due demand (pushes its dueAtMs
   * forward, same as a normal dispatch would) without touching a
   * dispatch already in flight. */
  discardPendingDemands(): void;
  /** Marks the given poll ids as immediately due. A no-op per id that
   * has no registered definition, or that is already due - there is no
   * queue to duplicate into regardless (see this file's own class-level
   * doc comment on the coalescing model). */
  requestRefresh(ids: readonly string[]): void;
}

export interface MspTelemetrySchedulerOptions {
  /** Defaults to RealClock (Date.now()-based). Inject a FakeClock in
   * tests - see clock.ts. */
  clock?: MonotonicClock;
}

class MspTelemetrySchedulerImpl implements MspTelemetryScheduler {
  private readonly polls = new Map<string, PollRuntimeState>();
  private readonly activeLeaseIds = new Set<string>();
  private nextLeaseSeq = 0;
  private inFlightCount = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly requester: MspRequester,
    private readonly clock: MonotonicClock,
  ) {}

  registerPoll<T>(definition: MspPollDefinition<T>): () => void {
    const state: PollRuntimeState<T> = {
      definition,
      dueAtMs: this.clock.now(),
      inFlight: false,
      lastOutcome: undefined,
      lastSuccessAtMs: undefined,
    };
    this.polls.set(definition.id, state as PollRuntimeState);

    return () => {
      // Only remove if this exact registration is still the one on
      // record - guards against a same-id re-registration (a fresh
      // registerPoll() call for the same id) being torn down by an
      // older unregister function called late.
      if (this.polls.get(definition.id) === (state as PollRuntimeState)) {
        this.polls.delete(definition.id);
      }
    };
  }

  getValue<T>(id: string): TelemetryValue<T> {
    const poll = this.polls.get(id) as PollRuntimeState<T> | undefined;
    if (!poll) {
      return {status: 'UNAVAILABLE'};
    }
    const outcome = poll.lastOutcome;
    if (!outcome) {
      return {status: 'WAITING'};
    }
    if (outcome.type === 'error') {
      return {status: 'ERROR', error: outcome.error, updatedAtMs: poll.lastSuccessAtMs};
    }
    const ageMs = this.clock.now() - outcome.updatedAtMs;
    if (ageMs >= poll.definition.staleAfterMs) {
      return {status: 'STALE', value: outcome.value, updatedAtMs: outcome.updatedAtMs, ageMs};
    }
    return {status: 'FRESH', value: outcome.value, updatedAtMs: outcome.updatedAtMs};
  }

  tick(): void {
    if (this.activeLeaseIds.size > 0) {
      return;
    }
    const now = this.clock.now();

    let best: PollRuntimeState | undefined;
    let bestRatio = -Infinity;
    for (const poll of this.polls.values()) {
      if (poll.inFlight || now < poll.dueAtMs) {
        continue;
      }
      const ratio = (now - poll.dueAtMs) / poll.definition.intervalMs;
      const isBetter =
        best === undefined || ratio > bestRatio || (ratio === bestRatio && poll.definition.priority > best.definition.priority);
      if (isBetter) {
        best = poll;
        bestRatio = ratio;
      }
    }

    if (best) {
      this.dispatch(best, now);
    }
  }

  acquirePauseLease(reason: TelemetryPauseReason): TelemetryPauseLease {
    const id = `${reason}-${this.nextLeaseSeq++}`;
    this.activeLeaseIds.add(id);
    let released = false;
    return {
      id,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.activeLeaseIds.delete(id);
      },
    };
  }

  waitUntilIdle(): Promise<void> {
    if (this.inFlightCount === 0) {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      this.idleWaiters.push(resolve);
    });
  }

  discardPendingDemands(): void {
    const now = this.clock.now();
    for (const poll of this.polls.values()) {
      if (!poll.inFlight && now >= poll.dueAtMs) {
        poll.dueAtMs = now + poll.definition.intervalMs;
      }
    }
  }

  requestRefresh(ids: readonly string[]): void {
    const now = this.clock.now();
    for (const id of ids) {
      const poll = this.polls.get(id);
      if (poll && poll.dueAtMs > now) {
        poll.dueAtMs = now;
      }
    }
  }

  private dispatch(poll: PollRuntimeState, dispatchedAtMs: number): void {
    poll.inFlight = true;
    poll.dueAtMs = dispatchedAtMs + poll.definition.intervalMs;
    this.inFlightCount += 1;

    const payload = poll.definition.requestPayload ?? EMPTY_PAYLOAD;
    Promise.resolve(this.requester.request(poll.definition.command, payload, REQUEST_OPTIONS))
      .then((frame: MspFrame) => {
        const value = poll.definition.decode(frame.payload);
        const updatedAtMs = this.clock.now();
        poll.lastOutcome = {type: 'success', value, updatedAtMs};
        poll.lastSuccessAtMs = updatedAtMs;
      })
      .catch((error: unknown) => {
        poll.lastOutcome = {type: 'error', error};
      })
      .finally(() => {
        poll.inFlight = false;
        this.inFlightCount -= 1;
        if (this.inFlightCount === 0) {
          const waiters = this.idleWaiters;
          this.idleWaiters = [];
          waiters.forEach(resolve => resolve());
        }
      });
  }
}

/** Factory, mirroring createMspStreamParser()'s own established
 * interface+factory convention in this codebase. */
export function createMspTelemetryScheduler(
  requester: MspRequester,
  options: MspTelemetrySchedulerOptions = {},
): MspTelemetryScheduler {
  return new MspTelemetrySchedulerImpl(requester, options.clock ?? new RealClock());
}
