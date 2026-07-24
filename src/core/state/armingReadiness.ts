/**
 * Pass 7.4, Step 3 - the safety-critical arming-readiness derivation for
 * Setup Region 2's Safety Strip. Zero React/RN dependency, same
 * convention as every other file under src/core - and per this pass's
 * own instruction, this rule lives here (src/core) rather than in a UI
 * component, precisely because it must be exhaustively unit-testable in
 * isolation from any rendering concern.
 *
 * ArmingBlockReason's shape (a real, stated decision, not the literal
 * {code,message} example given): a `severity` field was ADDED beyond
 * that minimal example. Without it there is no way to implement the
 * explicitly required "reasons ranked critical danger -> arming blocker
 * -> warning -> info" ordering (rankArmingBlockReasons() below) - the
 * given example was explicitly offered as "minimal, e.g.", not a ceiling,
 * and severity is not optional data once ranking is a hard requirement
 * elsewhere in this same design.
 */

import type {TelemetryValue} from '../protocol';

/** The four ranking tiers named explicitly in the design spec, in
 * highest-to-lowest priority order. */
export type ArmingBlockSeverity = 'CRITICAL_DANGER' | 'ARMING_BLOCKER' | 'WARNING' | 'INFO';

export type ArmingBlockReason = {
  /** Raw firmware blocker code (e.g. a Betaflight arming-disable-flag
   * name) - INTERNAL ONLY, never shown directly in the UI (per this
   * pass's own explicit instruction: "raw firmware codes internal only,
   * Arabic descriptions shown"). */
  code: string;
  /** User-facing Arabic description - what the Safety Strip actually
   * renders. */
  message: string;
  severity: ArmingBlockSeverity;
};

export type ArmingReadiness =
  | {status: 'ARMED'}
  | {status: 'READY'}
  | {status: 'BLOCKED'; reasons: ArmingBlockReason[]}
  | {status: 'UNKNOWN'; cause: 'WAITING' | 'STALE' | 'ERROR' | 'UNAVAILABLE'};

/**
 * THE CRITICAL SAFETY RULE (per this pass's own explicit instruction,
 * quoted near-verbatim): READY is only derivable when BOTH `armed` and
 * `blockers` are FRESH. Any non-FRESH status on either one - WAITING,
 * STALE, ERROR, or UNAVAILABLE - forces UNKNOWN, NEVER reusing a stale
 * "no blockers" reading to claim READY.
 *
 * ARMED IS A SEPARATE, STATED DECISION (not explicit in the literal
 * spec wording, which only defines when READY is derivable): once
 * `armed` itself is FRESH and true, this returns ARMED immediately,
 * WITHOUT waiting on `blockers` freshness at all. Reasoning: the armed
 * flag is its own independent, authoritative ground truth about whether
 * the aircraft is armed RIGHT NOW - once armed, "why can't I arm" reasons
 * are moot, and real flight controller configurators (Betaflight/INAV)
 * likewise always surface a live armed indicator from the armed flag
 * alone, never gated on a separate diagnostics channel's freshness. This
 * does NOT weaken the safety rule above: ARMED is not READY, and
 * `blockers` staleness never lets an actually-unarmed aircraft be
 * reported as safe to arm.
 *
 * PRIORITY WHEN BOTH ARE NON-FRESH: `armed`'s own freshness is checked
 * FIRST. If we do not reliably know whether the aircraft is currently
 * armed at all, that is a more fundamental unknown than "we don't know
 * the current blocker list" - so the UNKNOWN cause reported is always
 * `armed`'s own status in that case, never `blockers`'s.
 */
export function deriveArmingReadiness(
  armed: TelemetryValue<boolean>,
  blockers: TelemetryValue<ArmingBlockReason[]>,
): ArmingReadiness {
  if (armed.status !== 'FRESH') {
    return {status: 'UNKNOWN', cause: armed.status};
  }
  if (armed.value) {
    return {status: 'ARMED'};
  }
  if (blockers.status !== 'FRESH') {
    return {status: 'UNKNOWN', cause: blockers.status};
  }
  if (blockers.value.length === 0) {
    return {status: 'READY'};
  }
  return {status: 'BLOCKED', reasons: blockers.value};
}

const SEVERITY_RANK: Record<ArmingBlockSeverity, number> = {
  CRITICAL_DANGER: 3,
  ARMING_BLOCKER: 2,
  WARNING: 1,
  INFO: 0,
};

/** Ranked critical danger -> arming blocker -> warning -> info, per this
 * pass's own explicit instruction. A STABLE sort (Array.prototype.sort
 * has been stable since ES2019) - reasons of equal severity keep their
 * original relative order, i.e. whatever order the (future) decoder
 * emitted them in. ArmingBlockReason has no activatedAtMs of its own
 * (unlike SetupNotice - Step 4) to tie-break on more explicitly. */
export function rankArmingBlockReasons(reasons: ArmingBlockReason[]): ArmingBlockReason[] {
  return [...reasons].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

/** Default cap for the Safety Strip's compact BLOCKED view - "top 2-3 by
 * priority" per this pass's own instruction; 3 chosen as the upper bound
 * of that explicit range. */
const DEFAULT_TOP_REASON_COUNT = 3;

export type ArmingBlockReasonSelection = {
  shown: ArmingBlockReason[];
  /** > 0 exactly when there are more reasons beyond `shown` - the
   * Safety Strip shows its "عرض جميع الأسباب" link precisely when this
   * is non-zero. */
  remainingCount: number;
};

/** Ranks, then takes the top `limit` reasons - what the Safety Strip's
 * auto-expanded compact view actually renders before a user asks to see
 * every reason. */
export function selectTopArmingBlockReasons(
  reasons: ArmingBlockReason[],
  limit: number = DEFAULT_TOP_REASON_COUNT,
): ArmingBlockReasonSelection {
  const ranked = rankArmingBlockReasons(reasons);
  return {
    shown: ranked.slice(0, limit),
    remainingCount: Math.max(0, ranked.length - limit),
  };
}
