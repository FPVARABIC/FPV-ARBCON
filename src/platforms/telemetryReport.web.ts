/**
 * "نسخ تقرير التليمترية" - the browser implementation.
 *
 * Thin adapter over web/telemetryDiagnostics.ts so the shared Setup
 * screen depends on ONE platform-neutral module name (this seam) rather
 * than on web-only internals. See the native sibling for why Android
 * renders nothing, and telemetryDiagnostics.ts for exactly what the
 * report records and refuses to record.
 */

import {
  buildTelemetryReport,
  copyTelemetryReport,
  recordTelemetryEvent,
} from './web/telemetryDiagnostics';
import type {TelemetryReportSnapshot} from './web/telemetryDiagnostics';

export type {TelemetryReportSnapshot};

export function isTelemetryReportSupported(): boolean {
  return true;
}

export function recordTelemetryStage(
  stage: string,
  detail?: Readonly<Record<string, string | number | boolean>>,
): void {
  recordTelemetryEvent(stage, detail);
}

export async function copyTelemetryReportToClipboard(
  snapshot?: TelemetryReportSnapshot,
): Promise<boolean> {
  return copyTelemetryReport(snapshot);
}

/** Exposed for the web tests, which assert report CONTENT, not clipboard
 * plumbing. */
export {buildTelemetryReport};
