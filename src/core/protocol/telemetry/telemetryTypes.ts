/**
 * Pass 7.2: core types/contracts for MspTelemetryScheduler. Zero
 * React/RN/Android dependency, same convention as every other file under
 * src/core/protocol.
 */

/**
 * One registered, recurring poll. Deliberately does NOT include
 * isSupported(capabilities) (as an earlier sketch of this type did) -
 * capability filtering (should this poll even be registered for THIS
 * connected firmware) belongs to whatever code registers poll
 * definitions in a later pass, once a real capability model exists here.
 * Baking a capabilities check into the definition itself would force
 * every registration site to satisfy an interface this pass has no real
 * capability type to fill in yet. Flagging this explicitly per Pass
 * 7.2's own instruction to report rather than silently drop it.
 */
export type MspPollDefinition<T> = {
  id: string;
  command: number;
  intervalMs: number;
  staleAfterMs: number;
  /** Higher value = higher priority. Only consulted as a tie-breaker
   * when two due polls have an identical overdue ratio (see
   * MspTelemetryScheduler.ts's own doc comment on tick()'s selection
   * formula) - it never overrides a poll that is genuinely more overdue
   * relative to its own interval. */
  priority: number;
  requestPayload?: Uint8Array;
  decode: (payload: Uint8Array) => T;
  /** Pass 7.6c: optional startup phase offset - the poll first becomes
   * due at registration time + initialDelayMs instead of immediately.
   * Default 0 preserves every pre-7.6c registration's behavior exactly.
   * Used to stagger the auxiliary Region 3 polls so they cannot all
   * become due in the same startup burst on the serialized MSP queue. */
  initialDelayMs?: number;
};

/**
 * getValue()'s return shape. Justification for STALE and ERROR
 * specifically (per Pass 7.2's own instruction to report the reasoning,
 * not assume it):
 *
 * STALE carries `value` + `updatedAtMs` (not just a bare "it's stale"
 * flag) because the entire point of staleAfterMs is to let a UI keep
 * showing the last-known reading alongside its age ("attitude: 12.3°,
 * updated 1.4s ago") rather than blanking the display the instant a poll
 * misses its freshness window - a blank UI is a worse user experience
 * than a labeled slightly-old one, and the caller needs both the value
 * and the timestamp to render that label itself (this type doesn't
 * precompute a display string).
 *
 * ERROR does NOT carry the last-known value (no `value` field in that
 * variant) - a failed dispatch is a stronger, more specific signal than
 * "just old" (e.g. MSP_REMOTE_ERROR, a decode failure, a timeout against
 * a desynchronized link - see mspClient.ts's own error taxonomy) and
 * this type deliberately does not let a UI accidentally keep rendering a
 * value under an ERROR status as if it were still merely stale-but-
 * trustworthy. It DOES carry an optional `updatedAtMs`, but that field
 * means "when did we last succeed", not "when did this error happen" -
 * it lets a caller show "last good reading was 4s ago, and the most
 * recent attempt just failed" without exposing the stale value itself
 * for silent redisplay. `updatedAtMs` is undefined only when a poll has
 * NEVER once succeeded (its very first dispatch failed).
 *
 * FRESH vs STALE is driven by age (now - updatedAtMs, compared against
 * the poll's own staleAfterMs) becoming stale purely because time
 * passed, with no new dispatch in between. Pass 7.2 originally derived
 * this dynamically on every getValue() call; Pass 7.4 changed getValue()
 * to a stable cache lookup instead (required for useSyncExternalStore's
 * referential-stability contract - see MspTelemetryScheduler.ts's own
 * class-level doc comment), so as of Pass 7.4 this transition is only
 * ever made visible via tick() re-evaluating staleness and replacing the
 * cached value, not by a bare clock advance alone.
 */
/**
 * `sampleSeq` identifies WHICH genuine sample a value came from.
 *
 * It exists because `updatedAtMs` cannot serve as a sample identity: two
 * dispatches can legitimately settle inside the same clock millisecond
 * (trivially so under an injected FakeClock), and a STALE recomputation
 * deliberately keeps the ORIGINAL `updatedAtMs`. `sampleSeq` increments
 * once per successful decode and is carried unchanged through the
 * FRESH -> STALE transition, so "the model and the numbers are showing
 * the same sample" and "sample N+1 superseded sample N" are both
 * decidable facts rather than timing inferences.
 *
 * Scope: per scheduler, therefore per session (the coordinator creates
 * one scheduler per physical session), starting at 1. A replacement
 * session restarts the count - deliberately, since a sequence is only
 * ever compared within one session identity, and every consumer that
 * records it also records the composite session key.
 *
 * Optional purely so this addition cannot invalidate an existing
 * hand-built TelemetryValue literal; the scheduler always sets it.
 */
export type TelemetryValue<T> =
  | {status: 'UNAVAILABLE'}
  | {status: 'WAITING'}
  | {status: 'FRESH'; value: T; updatedAtMs: number; sampleSeq?: number}
  | {status: 'STALE'; value: T; updatedAtMs: number; ageMs: number; sampleSeq?: number}
  | {status: 'ERROR'; error: unknown; updatedAtMs?: number};

/**
 * Why telemetry polling is currently held off.
 *
 * Phase 2C adds MOTOR_TEST. It is a distinct reason on purpose: a
 * motor-test barrier and an APP_BACKGROUND pause (or an
 * EXCLUSIVE_OPERATION pause) can be in force simultaneously and are
 * released by different owners at different times, so releasing one must
 * never release another. See motorTestTelemetryBarrier.ts, which owns one
 * independent lease per barrier token rather than a per-reason flag.
 */
export type TelemetryPauseReason =
  | 'EXCLUSIVE_OPERATION'
  | 'MSP_RECOVERY'
  | 'SESSION_CLOSING'
  | 'APP_BACKGROUND'
  | 'MOTOR_TEST';

export type TelemetryPauseLease = {
  id: string;
  release(): void;
};

/**
 * Checkpoint F: READ-ONLY observability for one registered poll.
 *
 * WHY THIS EXISTS. A real flight controller reported a frozen Setup
 * orientation through the published preview, and every boundary in the
 * pipeline was invisible from the field: whether the poll was even
 * registered, whether requests reached the wire, whether responses came
 * back, and whether the scheduler was simply paused all looked
 * identical from the UI (a motionless model). The only pipeline
 * instrumentation that existed - orientationLatencyDebugLog.ts - is
 * `__DEV__`-gated and is therefore a no-op in exactly the build the
 * user runs.
 *
 * THIS CHANGES NO BEHAVIOR. These are counters the scheduler already
 * had the information to produce; nothing here is consulted by tick(),
 * dispatch selection, pausing, staleness or publication.
 *
 * NO PAYLOAD, EVER. `lastErrorCode` is an enumerated code/class NAME
 * (e.g. `MSP_TIMEOUT`), never an error message and never wire bytes -
 * see MspTelemetryScheduler.ts's own describeErrorCode().
 */
export type TelemetryPollDiagnostics = {
  readonly id: string;
  readonly command: number;
  readonly intervalMs: number;
  readonly staleAfterMs: number;
  readonly priority: number;
  /** Dispatches STARTED (i.e. requests handed to the requester). */
  readonly requestCount: number;
  /** Dispatches that settled with a successfully decoded value. */
  readonly responseCount: number;
  /** Dispatches that settled as a rejection or a decode failure. */
  readonly errorCount: number;
  /** The most recent failure's code, retained even after a later
   * success - "it recovered, but it had been failing" is exactly the
   * fact a one-shot snapshot of getValue() destroys. */
  readonly lastErrorCode?: string;
  readonly inFlight: boolean;
  readonly status: TelemetryValue<unknown>['status'];
  readonly sampleSeq?: number;
  readonly updatedAtMs?: number;
  /**
   * P1 (Receiver responsiveness): OBSERVED cadence, derived only from
   * samples this scheduler actually delivered. These exist because
   * `intervalMs` is a REQUEST, not an outcome - the whole Receiver P1
   * finding was that the achieved rate can be a fraction of the declared
   * one, and nothing in the app could tell the difference.
   *
   * Three separate concepts, deliberately not collapsed into one number:
   *   intervalMs            - what we ASK for (already above)
   *   meanSampleGapMs       - what we actually GET between delivered samples
   *   mean/min/maxServiceMs - what the LINK costs per round trip
   *
   * Bounded rolling window (see CADENCE_WINDOW_SAMPLES); no unbounded
   * history is retained. Undefined until enough samples exist to derive
   * the figure. Reset with the poll registration, and therefore with the
   * session, since the coordinator builds one scheduler per session.
   *
   * READ-ONLY OBSERVABILITY, exactly like the counters above: nothing
   * here is consulted by tick(), selection, pausing, staleness or
   * publication, nothing is transmitted anywhere, and no user-facing
   * string may present these as a promised rate.
   *
   * Every field here is optional for the same reason `sampleSeq` above
   * is: so this addition cannot invalidate an existing hand-built
   * diagnostics literal. The scheduler always sets deliveredSampleCount.
   */
  readonly deliveredSampleCount?: number;
  readonly meanSampleGapMs?: number;
  readonly worstSampleGapMs?: number;
  readonly observedSampleRateHz?: number;
  readonly meanServiceMs?: number;
  readonly minServiceMs?: number;
  readonly maxServiceMs?: number;
};

/** Checkpoint F: read-only whole-scheduler observability. `pauseReasons`
 * is what distinguishes "the link is silent" from "polling is held off"
 * - a stale MOTOR_TEST or APP_BACKGROUND lease looks exactly like a
 * dead flight controller from the UI, and that ambiguity is what this
 * exists to remove. */
export type TelemetrySchedulerDiagnostics = {
  readonly tickCount: number;
  readonly inFlightCount: number;
  readonly pauseReasons: readonly TelemetryPauseReason[];
  readonly polls: readonly TelemetryPollDiagnostics[];
};
