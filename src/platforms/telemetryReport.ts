/**
 * "نسخ تقرير التليمترية" - the Android (native) side of the seam.
 *
 * The browser build resolves telemetryReport.web.ts instead (the same
 * file-extension seam the USB transport, the map link and the connection
 * report already use). Inert here for exactly the reasons the connection
 * report's native sibling is: Android already has adb logcat and the
 * in-app debug panels ([FPV-TELEM], [FPV-BATT], [FPV-ORIENT-LATENCY]),
 * the clipboard flow exists for a browser user who cannot be asked to
 * open DevTools, and a second untested Android reporting path is surface
 * this checkpoint has no evidence asking for.
 *
 * The screen asks isTelemetryReportSupported() first and renders no
 * button at all when it is false.
 */

import type {TelemetrySchedulerDiagnostics} from '../core';
import type {OrientationRenderObservation} from '../ui/orientation3d/orientationRenderObserver';

export type TelemetryReportSnapshot = {
  readonly sessionId?: string;
  readonly generation?: number;
  readonly ownershipState?: string;
  readonly identificationStatus?: string;
  readonly appStatePhase?: string;
  readonly setupActive?: boolean;
  readonly scheduler?: TelemetrySchedulerDiagnostics;
  readonly render?: OrientationRenderObservation;
  readonly wallClockMs?: number;
};

export function isTelemetryReportSupported(): boolean {
  return false;
}

/** No-op on Android; the web sibling keeps a bounded event ring. */
export function recordTelemetryStage(
  _stage: string,
  _detail?: Readonly<Record<string, string | number | boolean>>,
): void {}

/** Never called on Android (the button is not rendered); resolves false
 * defensively rather than pretending a copy happened. */
export async function copyTelemetryReportToClipboard(
  _snapshot?: TelemetryReportSnapshot,
): Promise<boolean> {
  return false;
}
