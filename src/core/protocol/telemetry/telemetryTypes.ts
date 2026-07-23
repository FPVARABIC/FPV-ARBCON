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
 * FRESH vs STALE is derived dynamically at getValue() call time (age =
 * now - updatedAtMs, compared against the poll's own staleAfterMs), not
 * decided proactively during tick() - a value can silently transition
 * from FRESH to STALE purely because time passed, with no scheduler
 * activity in between, which is exactly the transition Pass 7.2's own
 * tests exercise via clock advance alone.
 */
export type TelemetryValue<T> =
  | {status: 'UNAVAILABLE'}
  | {status: 'WAITING'}
  | {status: 'FRESH'; value: T; updatedAtMs: number}
  | {status: 'STALE'; value: T; updatedAtMs: number; ageMs: number}
  | {status: 'ERROR'; error: unknown; updatedAtMs?: number};

export type TelemetryPauseReason = 'EXCLUSIVE_OPERATION' | 'MSP_RECOVERY' | 'SESSION_CLOSING' | 'APP_BACKGROUND';

export type TelemetryPauseLease = {
  id: string;
  release(): void;
};
