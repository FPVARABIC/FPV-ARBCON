/**
 * CONNECTION DIAGNOSTICS - the evidence a real user can hand back.
 *
 * WHY THIS EXISTS. A real flight controller failed to identify through
 * the published preview, and the only evidence available was "it did not
 * work" - the user cannot be asked to open DevTools, and the transport's
 * own knowledge (which stage died, how many bytes actually moved) was
 * discarded the moment it happened. This module keeps that knowledge, in
 * a bounded buffer, so the connection screen can offer one Arabic action:
 * copy a technical report.
 *
 * WHAT IT RECORDS - and, more importantly, what it refuses to record:
 *
 *   RECORDED: capability/secure-context status, vendorId/productId,
 *   the exact serial configuration requested, session lifecycle stages
 *   (open, read-start, baud change, close, detach), transport error
 *   codes, MSP activation stage transitions the screen reports, BYTE
 *   COUNTS in each direction, and the build identity (commit SHA).
 *
 *   REFUSED: payload bytes (firmware content, MSP frame bodies, anything
 *   that could embed configuration), device product strings beyond what
 *   the USB descriptor already exposes, browser fingerprinting beyond
 *   the two capability booleans, and any interpretation this module
 *   cannot prove ("probably a baud mismatch" is analysis, not evidence -
 *   the report carries facts only).
 *
 * The buffer is a module singleton for the same reason the transport's
 * event hubs are: the transport is a module singleton, and diagnostics
 * that reset when a component remounts would lose exactly the stages the
 * report exists to capture.
 */

export type DiagnosticEntry = {
  /** Milliseconds since the page loaded (performance.now()), integral. */
  readonly atMs: number;
  /** Machine-readable stage tag, e.g. TRANSPORT_OPEN_OK. */
  readonly stage: string;
  /** Small, non-secret detail payload - numbers, codes, booleans. */
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
};

const MAX_ENTRIES = 200;

let entries: DiagnosticEntry[] = [];

/** Byte totals are kept as running counters, not per-chunk entries: a
 * 4.5Hz telemetry stream would flush the whole buffer in seconds. */
let bytesReceived = 0;
let bytesWritten = 0;
let receiveChunks = 0;
let writeCount = 0;

function now(): number {
  return typeof performance !== 'undefined' ? Math.round(performance.now()) : 0;
}

export function recordDiagnostic(
  stage: string,
  detail?: Readonly<Record<string, string | number | boolean>>,
): void {
  entries.push({atMs: now(), stage, detail});
  if (entries.length > MAX_ENTRIES) {
    // Drop the OLDEST beyond the cap, but never the first ten: the
    // capability probe and first open attempt are precisely what a
    // report needs, and a long telemetry session must not push them out.
    entries = [...entries.slice(0, 10), ...entries.slice(entries.length - (MAX_ENTRIES - 10))];
  }
}

export function recordBytesReceived(count: number): void {
  bytesReceived += count;
  receiveChunks += 1;
}

export function recordBytesWritten(count: number): void {
  bytesWritten += count;
  writeCount += 1;
}

/** Test seam and page-lifetime reset. */
export function resetConnectionDiagnosticsForTests(): void {
  entries = [];
  bytesReceived = 0;
  bytesWritten = 0;
  receiveChunks = 0;
  writeCount = 0;
}

declare const __FPV_ARBCON_BUILD__: string | undefined;

function buildIdentity(): string {
  // Injected by vite.config.mts (define) - the deployed commit SHA. A
  // local dev build reports 'dev'. Guarded so Jest (no Vite define) and
  // any future bundler both stay safe.
  try {
    return typeof __FPV_ARBCON_BUILD__ === 'string' ? __FPV_ARBCON_BUILD__ : 'dev';
  } catch {
    return 'dev';
  }
}

export type ConnectionSnapshot = Readonly<Record<string, string | number | boolean>>;

/**
 * Builds the plain-text report. `snapshot` is whatever the connection
 * screen knows at the moment of the tap (its state machine phase and the
 * last localized error) - passed in rather than imported so this module
 * depends on nothing above the transport.
 */
export function buildConnectionReport(snapshot?: ConnectionSnapshot): string {
  const lines: string[] = [];
  lines.push('FPV-ARBCON — تقرير اتصال تقني');
  lines.push(`البنية: ${buildIdentity()}`);
  lines.push(`الوقت منذ فتح الصفحة: ${now()}ms`);
  if (typeof navigator !== 'undefined') {
    lines.push(`secureContext: ${typeof window !== 'undefined' && window.isSecureContext === true}`);
    lines.push(`webSerial: ${Boolean((navigator as Navigator).serial)}`);
    lines.push(`webUsb: ${Boolean((navigator as Navigator).usb)}`);
  }
  lines.push(
    `bytes: sent=${bytesWritten} (${writeCount} writes) received=${bytesReceived} (${receiveChunks} chunks)`,
  );
  if (snapshot) {
    lines.push('--- حالة الشاشة ---');
    for (const [key, value] of Object.entries(snapshot)) {
      lines.push(`${key}: ${String(value)}`);
    }
  }
  lines.push('--- المراحل ---');
  if (entries.length === 0) {
    lines.push('(لا أحداث مسجلة بعد)');
  }
  for (const entry of entries) {
    const detail = entry.detail
      ? ' ' +
        Object.entries(entry.detail)
          .map(([key, value]) => `${key}=${String(value)}`)
          .join(' ')
      : '';
    lines.push(`[${String(entry.atMs).padStart(8)}ms] ${entry.stage}${detail}`);
  }
  return lines.join('\n');
}

/**
 * Copies the report to the clipboard. Resolves true on success. Falls
 * back to a hidden textarea + execCommand for engines where
 * navigator.clipboard is absent outside user activation edge cases.
 */
export async function copyConnectionReport(
  snapshot?: ConnectionSnapshot,
): Promise<boolean> {
  const text = buildConnectionReport(snapshot);
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }
  try {
    if (typeof document === 'undefined') {
      return false;
    }
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  } catch {
    return false;
  }
}
