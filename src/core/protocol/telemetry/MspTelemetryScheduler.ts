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
 * deliberately rejected: a slow poll (e.g. 1000ms interval) is easily 20x
 * more raw-ms overdue than a fast poll (e.g. 50ms interval) can ever
 * get before the fast poll's own next deadline arrives, which would let
 * any slow poll systematically dominate selection purely by having a
 * long interval, starving the fast poll. Normalizing by each poll's own
 * interval instead measures "how much of my own cadence have I already
 * missed", which is the actual fairness question this scheduler needs to
 * answer, and is what the Fairness test in MspTelemetryScheduler.test.ts
 * exercises directly.
 *
 * SINGLE-FLIGHT LIVENESS CAP. A primary whose interval is intentionally
 * shorter than the link's temporary service time can remain more overdue
 * by ratio forever, making a slow auxiliary mathematically unable to win.
 * In singleFlight mode only, five consecutive priority>=0 dispatches
 * therefore reserve the next slot for one due priority<0 poll. The
 * existing reverse rule still reserves the slot after an auxiliary for a
 * due primary. Together these bounds prevent starvation in either
 * direction while never permitting concurrent requests or a backlog.
 *
 * Only one dispatch is started per tick() call, by design: this keeps
 * tick() itself synchronous and its cost bounded regardless of how many
 * polls are simultaneously overdue, and it's what makes the deadline-
 * aware ranking meaningful at all (if every due poll fired every tick(),
 * there would be nothing to rank). A caller driving tick() frequently
 * relative to the fastest registered interval (as this pass's own tests
 * do) still serves every due poll promptly; a caller invoking tick() only
 * rarely would see the same ranking logic simply catch up over several
 * calls. This is believed to be correct for this scheduler's scope; if a
 * future pass finds a real need to start multiple
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
 *
 * ==========================================================================
 * PASS 7.4: subscribe() AND THE TIME-BASED FRESH->STALE NOTIFICATION
 * ==========================================================================
 * getValue() had no subscription/notification mechanism at all before
 * this pass - nothing for a React consumer (useSyncExternalStore) to
 * subscribe to. subscribe() fires on two occasions: (1) whenever a
 * dispatch settles (success or error) - the obvious case, new data
 * genuinely arrived; and (2) at the end of EVERY tick() call,
 * unconditionally. (2) exists specifically for the FRESH->STALE
 * transition, which happens purely from time passing and involves no
 * dispatch settling at all. tick() is already called regularly by
 * whatever real driver a later pass wires up (Pass 7.4's own
 * MspSessionCoordinator integration runs it via a real setInterval), so
 * piggybacking the staleness check on that existing cadence needs no new
 * timer of its own.
 *
 * ==========================================================================
 * PASS 7.4: getValue() MUST BE A STABLE CACHE LOOKUP, NOT A LIVE COMPUTATION
 * ==========================================================================
 * getValue() originally (Pass 7.2) computed FRESH/STALE freshly on every
 * single call, deriving STALE's ageMs from `clock.now() - updatedAtMs`
 * each time. That is fundamentally incompatible with subscribe() feeding
 * a real useSyncExternalStore consumer: React requires getSnapshot() to
 * return a REFERENTIALLY STABLE value across repeated calls unless
 * subscribe()'s listener was actually invoked in between - violating
 * this produces a genuine "Maximum update depth exceeded" crash (caught
 * via real Pass 7.4 integration testing against useTelemetryValue.ts,
 * not by inspection alone), the SAME bug class already documented and
 * fixed once in this codebase (MspSessionCoordinator.ts's own
 * IDLE_IDENTIFICATION_STATE fix, Pass 7.1).
 *
 * Fixed by caching the actual TelemetryValue object per poll
 * (PollRuntimeState.cachedValue) and only ever REPLACING that reference
 * at two well-defined moments, both of which already call notify()
 * immediately afterward: a dispatch settling (success/error), or
 * refreshStaleness() detecting a FRESH poll has now crossed its own
 * staleAfterMs threshold during a tick() call. getValue() itself is now
 * a pure, side-effect-free Map+field lookup - it never touches the
 * clock at all.
 *
 * KNOWN, DELIBERATE BEHAVIOR CHANGE from Pass 7.2's original design:
 * advancing a FakeClock alone, with no tick() call in between, no longer
 * transitions a poll's reported status to STALE - only an actual tick()
 * call (or a dispatch settling) can update the cached value now. This is
 * NOT a regression for any real consumer: tick() is already the
 * mandated, unconditional driving mechanism for exactly this transition
 * (see the section above), and Pass 7.4's real integration always drives
 * it on a real interval - only a test that advances the clock without
 * ever calling tick() would notice, and that was already an artificial
 * scenario divorced from how this scheduler is actually driven.
 *
 * Once STALE, a poll's cachedValue (and therefore its ageMs) continues
 * to be replaced on every subsequent tick() for as long as it stays
 * stale - not merely once at the FRESH->STALE boundary - so a live
 * consumer sees a genuinely incrementing age, not a value frozen at the
 * instant staleness was first detected. This does NOT reintroduce the
 * instability bug: every such replacement is paired with a real
 * notify() call, which is exactly the condition under which
 * useSyncExternalStore expects (and requires) a new reference - the bug
 * was specifically about getSnapshot() changing BETWEEN or WITHOUT
 * notify() calls, never about it changing correctly alongside one.
 */

import type {MspFrame} from '../mspTypes';
import type {MspRequester} from '../msp/identification/MspIdentificationService';
import type {MspRequestOptions} from '../mspClient';
import type {MonotonicClock} from './clock';
import {RealClock} from './clock';
import type {
  MspPollDefinition,
  TelemetryPauseLease,
  TelemetryPauseReason,
  TelemetryPollDiagnostics,
  TelemetrySchedulerDiagnostics,
  TelemetryValue,
} from './telemetryTypes';

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
  /** Pass 7.4: the exact object getValue() returns for this poll -
   * replaced ONLY at a dispatch settling or at a tick()-driven staleness
   * recomputation (refreshStaleness()), NEVER computed fresh inside
   * getValue() itself. See this file's own class-level doc comment
   * ("getValue() MUST BE A STABLE CACHE LOOKUP") for why this exists. */
  cachedValue: TelemetryValue<T>;
  /** Checkpoint F observability - see telemetryTypes.ts's own
   * TelemetryPollDiagnostics doc comment. Written only; never read by
   * any scheduling decision. */
  requestCount: number;
  responseCount: number;
  errorCount: number;
  lastErrorCode: string | undefined;
}

export interface MspTelemetryScheduler {
  /** Returns an unregister function. After unregistering, getValue(id)
   * reverts to UNAVAILABLE and no further dispatches are started for
   * this id - but see this file's own doc comment: an already in-flight
   * dispatch for this id is NOT cancelled, it simply has nowhere
   * registered left to write its result once it settles. */
  registerPoll<T>(definition: MspPollDefinition<T>): () => void;
  /**
   * Temporarily suppresses one registered poll without discarding its
   * cached value or disturbing any other telemetry channel. Leases are
   * reference-counted per poll id: the poll becomes dispatchable again
   * only after every owner releases its lease.
   *
   * This is intentionally narrower than acquirePauseLease(), which stops
   * the entire scheduler for exclusive operations. A visible high-rate
   * surface can use this to yield bandwidth from a hidden high-rate poll
   * while the real MSP link remains globally single-flight.
   */
  acquirePollSuppression(id: string): () => void;
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
  /** Pass 7.4: fires after any dispatch settles (success or error) AND
   * after every tick() call (see this file's own class-level doc
   * comment on why tick() itself is the chosen mechanism for the
   * time-based FRESH->STALE transition, which involves no dispatch at
   * all). Mirrors MspSessionCoordinator's own subscribeOwnershipState()
   * pattern exactly: a Set<listener>, Array.from()-snapshot before
   * iterating, per-listener try/catch. Not scoped to one poll id - same
   * "notify broadly, narrow in the caller's own getSnapshot()"
   * convention already established by subscribeOwnershipState()/
   * subscribeIdentificationState(). */
  subscribe(listener: () => void): () => void;
  /** Checkpoint F: a read-only snapshot for a diagnostics report.
   * Allocates a fresh object every call and is therefore NOT a
   * useSyncExternalStore snapshot source - it is read on demand, at the
   * moment a user asks for evidence. */
  describeDiagnostics(): TelemetrySchedulerDiagnostics;
}

export interface MspTelemetrySchedulerOptions {
  /** Defaults to RealClock (Date.now()-based). Inject a FakeClock in
   * tests - see clock.ts. */
  clock?: MonotonicClock;
  /** Pass 7.6c - capacity-safe mode for the real serialized MSP link:
   * when true, tick() starts NO new
   * dispatch while ANY poll is still in flight (global concurrency of
   * exactly one), and never dispatches two sub-zero-priority (auxiliary)
   * polls consecutively while a priority>=0 poll is due. Default false
   * preserves pre-7.6c behavior exactly (existing tests and any consumer
   * relying on overlapping dispatches are untouched); the coordinator
   * opts in explicitly. */
  singleFlight?: boolean;
}

/** Pass 7.4: stable singleton references for getValue()'s two payload-
 * free variants - the SAME lesson already learned and fixed once in this
 * codebase (MspSessionCoordinator.ts's own IDLE_IDENTIFICATION_STATE
 * fix, Pass 7.1): useSyncExternalStore's contract requires getSnapshot()
 * to return a referentially-stable value when nothing has actually
 * changed, or React can spin into "Maximum update depth exceeded". A
 * fresh `{status: 'WAITING'}`/`{status: 'UNAVAILABLE'}` object literal
 * every call would break that the instant subscribe()'s new tick()-driven
 * notifications (below) start firing regularly for a poll that never
 * settles. Safe as `TelemetryValue<T>` for any T - neither variant
 * carries a T-typed payload. */
const WAITING_VALUE: TelemetryValue<never> = {status: 'WAITING'};
const UNAVAILABLE_VALUE: TelemetryValue<never> = {status: 'UNAVAILABLE'};
const MAX_CONSECUTIVE_PRIMARY_DISPATCHES = 5;

/**
 * Checkpoint F: reduces any thrown value to a SHORT, ENUMERATED tag for
 * the diagnostics report.
 *
 * Deliberately never the error MESSAGE. A message is free text that a
 * decoder can (and MspPayloadReader does) build out of byte offsets and
 * lengths; a report a user pastes into a public issue must carry a code
 * class, not something derived from the wire. `code` is MspClientError's
 * own enumerated taxonomy ('MSP_TIMEOUT', 'MSP_RECOVERING', ...);
 * everything else degrades to the constructor name, then to a bare
 * 'UNKNOWN'.
 */
function describeErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as {code?: unknown}).code;
    if (typeof code === 'string' && code.length > 0) {
      return code;
    }
    const name = (error as {name?: unknown}).name;
    if (typeof name === 'string' && name.length > 0) {
      return name;
    }
  }
  return 'UNKNOWN';
}

class MspTelemetrySchedulerImpl implements MspTelemetryScheduler {
  private readonly polls = new Map<string, PollRuntimeState>();
  private readonly suppressedPollReferences = new Map<string, number>();
  private readonly activeLeaseIds = new Set<string>();
  /** Checkpoint F: the REASON behind each active lease id, so a
   * diagnostics report can say WHICH owner is holding polling off
   * ('MOTOR_TEST' vs 'APP_BACKGROUND' vs 'EXCLUSIVE_OPERATION') rather
   * than only that something is. Kept strictly in step with
   * activeLeaseIds; consulted by nothing else. */
  private readonly activeLeaseReasons = new Map<string, TelemetryPauseReason>();
  private readonly listeners = new Set<() => void>();
  /** Checkpoint F: how many times tick() has run. A report showing zero
   * ticks proves the driving interval never fired - a completely
   * different failure from "ticks fired but nothing was due". */
  private tickCount = 0;
  private nextLeaseSeq = 0;
  /** Monotonic genuine-sample counter, scheduler-wide (therefore
   * session-wide - one scheduler per physical session). Incremented
   * once per successful decode, never on an error, a staleness
   * recomputation or a tick. See TelemetryValue's own doc comment on
   * why updatedAtMs cannot serve as a sample identity. */
  private nextSampleSeq = 1;
  private inFlightCount = 0;
  private idleWaiters: Array<() => void> = [];

  private lastDispatchedPriority: number | undefined;
  /**
   * A fast primary cadence must not make every slow auxiliary's normalized
   * overdue ratio mathematically unable to catch up on a degraded link.
   * MAX_CONSECUTIVE_PRIMARY_DISPATCHES slots preserve responsive attitude
   * updates; the next due auxiliary then gets one bounded slot before
   * primary service resumes.
   */
  private consecutivePrimaryDispatches = 0;

  constructor(
    private readonly requester: MspRequester,
    private readonly clock: MonotonicClock,
    private readonly singleFlight: boolean = false,
  ) {}

  registerPoll<T>(definition: MspPollDefinition<T>): () => void {
    const state: PollRuntimeState<T> = {
      definition,
      // Pass 7.6c: optional phase stagger - default 0 keeps the
      // long-established immediately-due-at-registration behavior.
      dueAtMs: this.clock.now() + (definition.initialDelayMs ?? 0),
      inFlight: false,
      lastOutcome: undefined,
      lastSuccessAtMs: undefined,
      cachedValue: WAITING_VALUE,
      requestCount: 0,
      responseCount: 0,
      errorCount: 0,
      lastErrorCode: undefined,
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

  acquirePollSuppression(id: string): () => void {
    this.suppressedPollReferences.set(
      id,
      (this.suppressedPollReferences.get(id) ?? 0) + 1,
    );
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const current = this.suppressedPollReferences.get(id) ?? 0;
      if (current <= 1) {
        this.suppressedPollReferences.delete(id);
      } else {
        this.suppressedPollReferences.set(id, current - 1);
      }
    };
  }

  /** Pure cache lookup - see this file's own class-level doc comment
   * ("getValue() MUST BE A STABLE CACHE LOOKUP") for why this never
   * computes anything itself. */
  getValue<T>(id: string): TelemetryValue<T> {
    const poll = this.polls.get(id) as PollRuntimeState<T> | undefined;
    return poll ? poll.cachedValue : UNAVAILABLE_VALUE;
  }

  /** Recomputes (and replaces) a single poll's cachedValue if it is
   * currently FRESH and has now crossed its own staleAfterMs threshold.
   * A no-op for WAITING/UNAVAILABLE/ERROR (staleness only applies to a
   * value that was once genuinely fresh) and for a FRESH poll that
   * hasn't crossed the threshold yet (cachedValue reference deliberately
   * left untouched - see this file's own class-level doc comment on
   * referential stability). Called from tick() for every registered
   * poll, not only the one selected for dispatch this tick. */
  private refreshStaleness(poll: PollRuntimeState, now: number): void {
    if (poll.cachedValue.status !== 'FRESH' && poll.cachedValue.status !== 'STALE') {
      return;
    }
    const ageMs = now - poll.cachedValue.updatedAtMs;
    if (ageMs >= poll.definition.staleAfterMs) {
      // The sample itself is unchanged - only its age is - so it keeps
      // its own sampleSeq. A STALE value is still sample N.
      poll.cachedValue = {
        status: 'STALE',
        value: poll.cachedValue.value,
        updatedAtMs: poll.cachedValue.updatedAtMs,
        ageMs,
        sampleSeq: poll.cachedValue.sampleSeq,
      };
    }
  }

  tick(): void {
    this.tickCount += 1;
    const now = this.clock.now();

    // Staleness is a property of "time since last update," genuinely
    // true regardless of whether the scheduler happens to be paused
    // right now - checked for EVERY registered poll unconditionally,
    // before the pause/due-selection logic below (which only concerns
    // whether a NEW dispatch may start this tick).
    for (const poll of this.polls.values()) {
      this.refreshStaleness(poll, now);
    }

    // Pass 7.6c singleFlight: with a genuinely serialized MSP link,
    // starting a second dispatch while one is outstanding only
    // builds a client-side queue (backlog) - so in this mode at most ONE
    // telemetry dispatch may be outstanding at any moment, scheduler-wide.
    const dispatchBlocked = this.singleFlight && this.inFlightCount > 0;
    if (this.activeLeaseIds.size <= 0 && !dispatchBlocked) {
      // Pass 7.6c aux alternation (singleFlight mode only): never run two
      // auxiliary (priority < 0) polls back-to-back while a primary
      // (priority >= 0, i.e. attitude) poll is due - the primary gets the
      // slot first, keeping the high-frequency channel responsive.
      let restrictToPrimary = false;
      if (this.singleFlight && this.lastDispatchedPriority !== undefined && this.lastDispatchedPriority < 0) {
        for (const poll of this.polls.values()) {
          if (
            !poll.inFlight &&
            !this.suppressedPollReferences.has(poll.definition.id) &&
            now >= poll.dueAtMs &&
            poll.definition.priority >= 0
          ) {
            restrictToPrimary = true;
            break;
          }
        }
      }

      let restrictToAuxiliary = false;
      if (
        this.singleFlight &&
        !restrictToPrimary &&
        this.consecutivePrimaryDispatches >= MAX_CONSECUTIVE_PRIMARY_DISPATCHES
      ) {
        for (const poll of this.polls.values()) {
          if (
            !poll.inFlight &&
            !this.suppressedPollReferences.has(poll.definition.id) &&
            now >= poll.dueAtMs &&
            poll.definition.priority < 0
          ) {
            restrictToAuxiliary = true;
            break;
          }
        }
      }

      let best: PollRuntimeState | undefined;
      let bestRatio = -Infinity;
      for (const poll of this.polls.values()) {
        if (
          poll.inFlight ||
          this.suppressedPollReferences.has(poll.definition.id) ||
          now < poll.dueAtMs
        ) {
          continue;
        }
        if (restrictToPrimary && poll.definition.priority < 0) {
          continue;
        }
        if (restrictToAuxiliary && poll.definition.priority >= 0) {
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
        this.lastDispatchedPriority = best.definition.priority;
        this.consecutivePrimaryDispatches =
          best.definition.priority >= 0 ? this.consecutivePrimaryDispatches + 1 : 0;
        this.dispatch(best, now);
      }
    }

    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener();
      } catch {
        // Best-effort - mirrors MspSessionCoordinator's own
        // notifyOwnership()/notifyIdentification().
      }
    }
  }

  acquirePauseLease(reason: TelemetryPauseReason): TelemetryPauseLease {
    const id = `${reason}-${this.nextLeaseSeq++}`;
    this.activeLeaseIds.add(id);
    this.activeLeaseReasons.set(id, reason);
    let released = false;
    return {
      id,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.activeLeaseIds.delete(id);
        this.activeLeaseReasons.delete(id);
      },
    };
  }

  /** Checkpoint F. Pure read: allocates a snapshot, mutates nothing,
   * touches neither the clock's scheduling role nor any poll's state. */
  describeDiagnostics(): TelemetrySchedulerDiagnostics {
    const polls: TelemetryPollDiagnostics[] = [];
    for (const poll of this.polls.values()) {
      const cached = poll.cachedValue;
      polls.push({
        id: poll.definition.id,
        command: poll.definition.command,
        intervalMs: poll.definition.intervalMs,
        staleAfterMs: poll.definition.staleAfterMs,
        priority: poll.definition.priority,
        requestCount: poll.requestCount,
        responseCount: poll.responseCount,
        errorCount: poll.errorCount,
        lastErrorCode: poll.lastErrorCode,
        inFlight: poll.inFlight,
        status: cached.status,
        sampleSeq: cached.status === 'FRESH' || cached.status === 'STALE' ? cached.sampleSeq : undefined,
        updatedAtMs:
          cached.status === 'FRESH' || cached.status === 'STALE' || cached.status === 'ERROR'
            ? cached.updatedAtMs
            : undefined,
      });
    }
    return {
      tickCount: this.tickCount,
      inFlightCount: this.inFlightCount,
      // Insertion-ordered, so the report reads as the order the holds
      // were actually taken.
      pauseReasons: Array.from(this.activeLeaseReasons.values()),
      polls,
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
    poll.requestCount += 1;

    const payload = poll.definition.requestPayload ?? EMPTY_PAYLOAD;
    Promise.resolve(this.requester.request(poll.definition.command, payload, REQUEST_OPTIONS))
      .then((frame: MspFrame) => {
        const value = poll.definition.decode(frame.payload);
        const updatedAtMs = this.clock.now();
        poll.lastOutcome = {type: 'success', value, updatedAtMs};
        poll.lastSuccessAtMs = updatedAtMs;
        // THE canonical publication boundary for a genuine sample.
        poll.cachedValue = {status: 'FRESH', value, updatedAtMs, sampleSeq: this.nextSampleSeq++};
        poll.responseCount += 1;
      })
      .catch((error: unknown) => {
        poll.lastOutcome = {type: 'error', error};
        poll.cachedValue = {status: 'ERROR', error, updatedAtMs: poll.lastSuccessAtMs};
        poll.errorCount += 1;
        poll.lastErrorCode = describeErrorCode(error);
      })
      .finally(() => {
        poll.inFlight = false;
        this.inFlightCount -= 1;
        if (this.inFlightCount === 0) {
          const waiters = this.idleWaiters;
          this.idleWaiters = [];
          waiters.forEach(resolve => resolve());
        }
        this.notify();
      });
  }
}

/** Factory, mirroring createMspStreamParser()'s own established
 * interface+factory convention in this codebase. */
export function createMspTelemetryScheduler(
  requester: MspRequester,
  options: MspTelemetrySchedulerOptions = {},
): MspTelemetryScheduler {
  return new MspTelemetrySchedulerImpl(requester, options.clock ?? new RealClock(), options.singleFlight ?? false);
}
