/**
 * Pass 7.4, Step 4 - the Unified Notice Model: ONE data model, feeding
 * TWO separate visual channels (Region 1's top-bar banner, Region 2's
 * safety strip - Step 3), NEVER merged. This file owns only the generic,
 * platform-agnostic pieces: the SetupNotice type itself and the
 * deterministic tie-break pickTopNotice() - genuinely reusable by both
 * channels, since each channel just supplies its own priority-ordered
 * candidate list and gets back the single notice (if any) that channel
 * should show. Building the REAL candidate list for a specific channel
 * from live session state (which needs platform-layer types like
 * MspSessionOwnershipState) is deliberately NOT this file's job - see
 * src/ui/components/setup/connectionIndicator.ts for the top-bar's own
 * real candidate-building logic.
 */

export type SetupNoticeDomain =
  | 'CONNECTION'
  | 'MSP_SESSION'
  | 'TELEMETRY'
  | 'ARMING'
  | 'POWER'
  | 'SENSORS'
  | 'GPS'
  | 'NAVIGATION';

export type SetupNoticeSeverity = 'CRITICAL' | 'ERROR' | 'WARNING' | 'INFO';

export type SetupNoticeScope = 'WHOLE_SCREEN' | 'LIVE_DATA' | 'ARMING' | 'SECTION' | 'NONE';

export type SetupNotice = {
  id: string;
  domain: SetupNoticeDomain;
  severity: SetupNoticeSeverity;
  /** scope:'ARMING' is what makes a notice an "arming blocker" - NOT its
   * own severity tier (an arming blocker can itself be ERROR/WARNING/
   * INFO). */
  scope: SetupNoticeScope;
  priority: number;
  activatedAtMs: number;
  updatedAtMs: number;
  title: string;
  message?: string;
  /** Shape TBD by a later pass - deliberately unknown here. */
  action?: unknown;
};

const SEVERITY_RANK: Record<SetupNoticeSeverity, number> = {
  CRITICAL: 3,
  ERROR: 2,
  WARNING: 1,
  INFO: 0,
};

/**
 * Deterministic tie-break, exactly per the design spec: higher priority
 * -> higher severity -> EARLIEST activatedAtMs (not latest - prevents
 * flicker: a newer, still-active duplicate condition must not jump ahead
 * of an older one still in effect) -> id as the final, fully deterministic
 * tiebreak. Returns undefined for an empty list (no notice to show - the
 * banner/strip simply renders its "all clear" state). Only ONE notice is
 * ever returned - "only ONE notice shown per channel at a time" is
 * enforced by this function always picking exactly one winner, never a
 * list.
 */
export function pickTopNotice(notices: SetupNotice[]): SetupNotice | undefined {
  if (notices.length === 0) {
    return undefined;
  }
  return [...notices].sort((a, b) => {
    if (a.priority !== b.priority) {
      return b.priority - a.priority;
    }
    const severityDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (severityDiff !== 0) {
      return severityDiff;
    }
    if (a.activatedAtMs !== b.activatedAtMs) {
      return a.activatedAtMs - b.activatedAtMs;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0];
}
