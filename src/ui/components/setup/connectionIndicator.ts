/**
 * Pass 7.4, Step 4 - pure derivation for Setup Region 1's Row 1
 * connection indicator (exactly 5 states) and its notice banner. Lives
 * under src/ui, NOT src/core, for a real reason: this file's inputs
 * (MspSessionOwnershipState, MspIdentificationState) are platform-layer
 * types (src/platforms/react-native/protocol/MspSessionCoordinator.ts),
 * and src/core must stay platform-agnostic (zero React/RN dependency,
 * the same rule that keeps orientationViewModel.ts/armingReadiness.ts
 * importable without pulling in RN) - importing a platform type INTO
 * core would invert that established one-directional dependency.
 * pickTopNotice() (src/core/state/setupNotice.ts) itself stays fully
 * generic/reusable; only the REAL candidate-building below is
 * platform-aware.
 *
 * Deliberately separate from the rendering component (TopSystemBar.tsx)
 * - per this pass's own explicit instruction that the SetupNotice model
 * and top-bar tie-break exist as a pure, independently tested function.
 */

import {pickTopNotice} from '../../../core';
import type {SetupNotice} from '../../../core';
import type {MspClientState} from '../../../core';
import type {MspIdentificationState, MspSessionOwnershipState} from '../../../platforms/react-native/protocol';

export type SetupConnectionIndicatorState = 'CONNECTED' | 'ACTIVATING' | 'RECOVERING' | 'RECOVERY_FAILED' | 'DISCONNECTED';

/**
 * The exactly-5-states connection indicator (متصل / جارٍ التفعيل / جارٍ
 * استعادة الاتصال / تعذّرت الاستعادة / غير متصل - Arabic labels are
 * TopSystemBar.tsx's own concern, this function only picks WHICH of the
 * 5 applies).
 *
 * ownership is checked first (INACTIVE/ACTIVATING/CLOSING all have an
 * unambiguous answer with no MspClient recovery state to consult at
 * all); only ACTIVE defers to `recovery`. CLOSING maps to DISCONNECTED
 * (a stated decision - the design spec's own 5 states have no distinct
 * "closing" indicator, and CLOSING is a brief, terminal-bound
 * transition; showing "غير متصل" for it is more honest than inventing a
 * 6th state nothing asked for).
 *
 * `recovery === undefined` while ownership is ACTIVE should be
 * unreachable in practice (Pass 7.4's own openSession() creates the
 * session entry - and therefore a defined getMspRecoveryState() - in the
 * exact same synchronous span as the ownership->ACTIVE flip), but is
 * handled defensively as ACTIVATING rather than falsely claiming
 * CONNECTED without an actually-observed READY client state.
 *
 * DESYNCHRONIZED is included in the RECOVERING branch for completeness
 * even though mspClient.ts's own doc comment establishes it is never
 * externally observable as a distinct getMspRecoveryState() read (the
 * synchronous triggerDesyncLatch() -> startRecovery() chain always
 * reaches RESTARTING_READER before any consumer can read state again) -
 * kept here so this function's own switch is exhaustive over the real
 * MspClientState type, not because it is expected to ever be hit.
 */
export function deriveConnectionIndicatorState(
  ownership: MspSessionOwnershipState,
  recovery: MspClientState | undefined,
): SetupConnectionIndicatorState {
  switch (ownership) {
    case 'INACTIVE':
      return 'DISCONNECTED';
    case 'ACTIVATING':
      return 'ACTIVATING';
    case 'CLOSING':
      return 'DISCONNECTED';
    case 'ACTIVE':
      switch (recovery) {
        case 'READY':
          return 'CONNECTED';
        case 'DESYNCHRONIZED':
        case 'RESTARTING_READER':
        case 'PROBING':
          return 'RECOVERING';
        case 'RECOVERY_FAILED':
          return 'RECOVERY_FAILED';
        case 'DISCONNECTED':
        case 'CLOSING':
        case undefined:
          return 'ACTIVATING';
        default: {
          const exhaustive: never = recovery;
          throw new Error(`Unreachable MspClientState: ${String(exhaustive)}`);
        }
      }
  }
}

const CONNECTION_NOTICE_PRIORITY: Record<'DISCONNECTED' | 'RECOVERY_FAILED' | 'CLOSING' | 'RECOVERING', number> = {
  // Per the design spec's own top-bar priority order: DISCONNECTED >
  // RECOVERY_FAILED > CLOSING > RECOVERING > ... Only these 4 (plus
  // identification's own WARNING below) have a real data source this
  // pass - TELEMETRY-domain "live-data-stale/error" and further
  // identification-domain "info" notices are deliberately NOT
  // fabricated here (no real source yet), consistent with Step 3's own
  // placeholder philosophy for ARMING.
  DISCONNECTED: 100,
  RECOVERY_FAILED: 90,
  CLOSING: 80,
  RECOVERING: 70,
};

const IDENTIFICATION_WARNING_PRIORITY = 10;

/**
 * Builds the (at most one) real candidate SetupNotice for Region 1's
 * banner from live ownership/recovery/identification state - the SINGLE
 * source of truth for which candidates exist, consumed by BOTH
 * listTopBarNoticeCandidateIds() (the hook layer's own activation-time
 * bookkeeping, see useTopBarNotice.ts) and deriveTopBarNotice() (the
 * final picker) below, so the two can never drift out of sync with each
 * other.
 *
 * activatedAtMs is intentionally NOT set here - a placeholder 0, always
 * overwritten by deriveTopBarNotice() from the real activation-time map
 * it is given. This function has no notion of "when did this start";
 * that lives one layer up (useTopBarNotice.ts), on purpose - see this
 * pass's own architectural finding on why a PURE function of only
 * current-moment inputs cannot implement the anti-flicker guarantee by
 * itself.
 */
function buildTopBarNoticeCandidates(
  ownership: MspSessionOwnershipState,
  recovery: MspClientState | undefined,
  identification: MspIdentificationState,
): SetupNotice[] {
  const candidates: SetupNotice[] = [];
  const indicator = deriveConnectionIndicatorState(ownership, recovery);

  if (indicator === 'DISCONNECTED' && ownership !== 'CLOSING') {
    candidates.push({
      id: 'connection-disconnected',
      domain: 'CONNECTION',
      severity: 'ERROR',
      scope: 'WHOLE_SCREEN',
      priority: CONNECTION_NOTICE_PRIORITY.DISCONNECTED,
      activatedAtMs: 0,
      updatedAtMs: 0,
      title: 'تم فقدان الاتصال بمتحكم الطيران',
    });
  } else if (ownership === 'CLOSING') {
    candidates.push({
      id: 'connection-closing',
      domain: 'CONNECTION',
      severity: 'INFO',
      scope: 'WHOLE_SCREEN',
      priority: CONNECTION_NOTICE_PRIORITY.CLOSING,
      activatedAtMs: 0,
      updatedAtMs: 0,
      title: 'جارٍ قطع الاتصال',
    });
  } else if (indicator === 'RECOVERY_FAILED') {
    candidates.push({
      id: 'msp-recovery-failed',
      domain: 'MSP_SESSION',
      severity: 'CRITICAL',
      scope: 'WHOLE_SCREEN',
      priority: CONNECTION_NOTICE_PRIORITY.RECOVERY_FAILED,
      activatedAtMs: 0,
      updatedAtMs: 0,
      title: 'تعذّرت استعادة الاتصال',
      message: 'أعد توصيل متحكم الطيران للمتابعة.',
    });
  } else if (indicator === 'RECOVERING') {
    candidates.push({
      id: 'msp-recovering',
      domain: 'MSP_SESSION',
      severity: 'WARNING',
      scope: 'LIVE_DATA',
      priority: CONNECTION_NOTICE_PRIORITY.RECOVERING,
      activatedAtMs: 0,
      updatedAtMs: 0,
      title: 'جارٍ استعادة الاتصال تلقائيًا',
    });
  }

  if (indicator === 'CONNECTED' && identification.status === 'FAILED') {
    candidates.push({
      id: 'identification-failed',
      domain: 'MSP_SESSION',
      severity: 'WARNING',
      scope: 'SECTION',
      priority: IDENTIFICATION_WARNING_PRIORITY,
      activatedAtMs: 0,
      updatedAtMs: 0,
      title: 'تعذّر التعرف على متحكم الطيران',
      message: 'قد تكون بعض المعلومات غير متاحة.',
    });
  }

  return candidates;
}

/** The candidate ids only - what useTopBarNotice.ts's own activation-time
 * map needs to stay in sync (add newly-appeared ids, drop ids no longer
 * present), without needing a real (or placeholder) activatedAtMs at
 * all. */
export function listTopBarNoticeCandidateIds(
  ownership: MspSessionOwnershipState,
  recovery: MspClientState | undefined,
  identification: MspIdentificationState,
): string[] {
  return buildTopBarNoticeCandidates(ownership, recovery, identification).map(c => c.id);
}

/**
 * Builds the real candidates, stamps each with its REAL activatedAtMs
 * (looked up from `activatedAtMsById` - see useTopBarNotice.ts for where
 * that map is actually maintained across renders), then picks the winner
 * via the shared, generic pickTopNotice(). In practice these real
 * sources are mutually exclusive (a session cannot be both DISCONNECTED
 * and RECOVERY_FAILED at once), so at most one candidate is ever
 * produced this pass - the tie-break's own activatedAtMs ordering has no
 * OBSERVABLE effect yet (nothing to tie-break against), but is now
 * genuinely, correctly populated rather than a dead placeholder, ready
 * for whichever future pass wires a second notice domain (e.g.
 * TELEMETRY) through this same banner.
 *
 * Returns undefined when nothing needs attention - per this pass's own
 * instruction, the banner shows only THEN, never for a plain CONNECTED
 * state, and never surfaces USB/sessionId/internal error codes (every
 * title/message above is a fixed Arabic string, never raw error data).
 */
export function deriveTopBarNotice(
  ownership: MspSessionOwnershipState,
  recovery: MspClientState | undefined,
  identification: MspIdentificationState,
  activatedAtMsById: ReadonlyMap<string, number>,
): SetupNotice | undefined {
  const candidates = buildTopBarNoticeCandidates(ownership, recovery, identification).map(candidate => ({
    ...candidate,
    activatedAtMs: activatedAtMsById.get(candidate.id) ?? candidate.activatedAtMs,
  }));
  return pickTopNotice(candidates);
}

/**
 * Pure, genuinely idempotent under repeated invocation with its own
 * prior output fed back in as `previous` - this is what makes it safe
 * to call directly during render (useTopBarNotice.ts), not merely
 * inside a useEffect. Traced explicitly, not assumed:
 *
 * For any id in `currentCandidateIds`:
 *  - if it was ALREADY in `previous` (tracked from an earlier,
 *    already-committed render, OR written by an earlier invocation of
 *    THIS SAME render under React StrictMode's dev-mode double-render),
 *    its existing timestamp is kept - `nowMs` is never consulted.
 *  - if it was NOT in `previous`, it is stamped with `nowMs` - and that
 *    stamp is what a re-invocation of this same render (StrictMode)
 *    would then see as "already tracked", so a second invocation always
 *    reuses the first invocation's stamp rather than re-sampling
 *    `nowMs`. The first invocation to run for a given id always wins;
 *    every later invocation within the same logical render pass is a
 *    no-op for that id. This holds for any invocation count, not just
 *    exactly 2.
 *
 * An id present in `previous` but absent from `currentCandidateIds` is
 * dropped - its later reappearance is a genuinely new activation, per
 * the design's own "activatedAtMs only changes when a notice truly
 * disappears then reappears" rule, not a resumed old timestamp.
 */
export function updateNoticeActivationTimestamps(
  previous: ReadonlyMap<string, number>,
  currentCandidateIds: readonly string[],
  nowMs: number,
): Map<string, number> {
  const next = new Map<string, number>();
  for (const id of currentCandidateIds) {
    next.set(id, previous.get(id) ?? nowMs);
  }
  return next;
}
