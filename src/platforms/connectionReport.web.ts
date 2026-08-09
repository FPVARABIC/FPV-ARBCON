/**
 * "COPY A CONNECTION REPORT" - the browser implementation.
 *
 * Thin adapter over connectionDiagnostics.ts so the shared connection
 * screen depends on ONE platform-neutral module name (this seam) rather
 * than on web-only internals. See the native sibling for why Android
 * renders nothing, and connectionDiagnostics.ts for exactly what the
 * report records and refuses to record.
 */

import {
  buildConnectionReport,
  copyConnectionReport,
  recordDiagnostic,
} from './web/connectionDiagnostics';

export type ConnectionReportSnapshot = Readonly<
  Record<string, string | number | boolean>
>;

export function isConnectionReportSupported(): boolean {
  return true;
}

export function recordConnectionStage(
  stage: string,
  detail?: Readonly<Record<string, string | number | boolean>>,
): void {
  recordDiagnostic(stage, detail);
}

export async function copyConnectionReportToClipboard(
  snapshot?: ConnectionReportSnapshot,
): Promise<boolean> {
  return copyConnectionReport(snapshot);
}

/** Exposed for the web tests, which assert report CONTENT, not clipboard
 * plumbing. */
export {buildConnectionReport};
