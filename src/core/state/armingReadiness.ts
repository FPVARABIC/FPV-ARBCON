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
 *
 * SETUP P1 - THE INPUT CHANGED, AND THE OLD INPUT IS GONE ON PURPOSE.
 *
 * This module used to take two TelemetryValues: `armed` and `blockers`.
 * That signature was correct in the abstract and unusable in practice,
 * because NOTHING in this application ever registers the `armed` or
 * `armingBlockers` poll ids (MspSessionCoordinator.ts documents both as
 * "a real, intentional placeholder"). Every shipping build therefore fed
 * this function UNAVAILABLE/UNAVAILABLE and rendered a permanent
 * "arming state not confirmed", while the FC Tools gate on the SAME
 * screen simultaneously reported "unavailable: the aircraft is ARMED"
 * from the real BOXIDS + STATUS_EX path.
 *
 * The poll-shaped signature is REMOVED rather than left exported and
 * unused: a safety derivation whose only inputs are two ids that can
 * never be fresh is not dormant, it is a trap. The replacement takes the
 * evidence that actually exists - the canonical ArmedState (which is
 * itself proven from BOXIDS + the packed flight-mode flags, never
 * inferred from the arming-disable mask) and the STATUS_EX blocker
 * verdict Setup already derives. `armed state` and `arming blockers`
 * remain two SEPARATE facts, exactly as before.
 */

/** The four ranking tiers named explicitly in the design spec, in
 * highest-to-lowest priority order. */
export type ArmingBlockSeverity = 'CRITICAL_DANGER' | 'ARMING_BLOCKER' | 'WARNING' | 'INFO';

export type ArmingBlockReason = {
  /** Raw firmware blocker code (e.g. a Betaflight arming-disable-flag
   * name, or `BIT_n` for a bit this app cannot name) - INTERNAL ONLY,
   * never shown directly in the UI (per this pass's own explicit
   * instruction: "raw firmware codes internal only, Arabic descriptions
   * shown"). Also the React key and testID suffix. */
  code: string;
  /**
   * SETUP P1: the i18n KEY of the user-facing Arabic description, not the
   * Arabic itself. src/core carries no Arabic in this project (the
   * convention flashPhaseModel.ts and mspClientErrorCodes.ts already
   * establish); the renderer translates. This also removed the last
   * reason for a screen to assemble safety copy by hand.
   */
  messageKey: string;
  /** Interpolation values for `messageKey` - e.g. the bit index and hex
   * of an unnameable blocker, which must never be dropped. */
  messageParams?: Readonly<Record<string, string | number>>;
  severity: ArmingBlockSeverity;
};

export type ArmingReadiness =
  | {status: 'ARMED'}
  | {status: 'READY'}
  | {status: 'BLOCKED'; reasons: ArmingBlockReason[]}
  | {status: 'UNKNOWN'; cause: ArmingReadinessUnknownCause};

/**
 * Why the current state cannot be proven. Each member names a DIFFERENT
 * missing proof, so a future surface can explain itself without any
 * caller having to re-derive the reason.
 */
export type ArmingReadinessUnknownCause =
  /** The canonical armed state itself is UNKNOWN - no BOXIDS mapping for
   * the current identity, no status reading, or a session/epoch
   * mismatch. The most fundamental unknown there is. */
  | 'ARMED_UNPROVEN'
  /** Armed is proven DISARMED, but the blocker evidence is absent,
   * stale, unsupported or disconnected. Never "no blockers". */
  | 'BLOCKERS_UNCONFIRMED'
  /** The frame began a readiness field it could not finish. Inconsistent
   * data, categorically not the same as absent data. */
  | 'BLOCKERS_MALFORMED';

/* The derivation itself lives in setupSafetyModel.ts, next to the blocker
 * describer it needs - importing that describer here would close a cycle
 * (setupSafetyModel already depends on these types), and injecting it as
 * a parameter would push an implementation detail onto every caller. This
 * file keeps the vocabulary and the ranking; that file keeps the rule. */

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
