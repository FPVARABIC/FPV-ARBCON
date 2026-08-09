/**
 * TELEMETRY DIAGNOSTICS - the evidence a real user can hand back about a
 * frozen Setup screen.
 *
 * WHY THIS EXISTS, SEPARATELY FROM connectionDiagnostics.ts. That report
 * answers "why did the connection fail"; by the time Setup is on screen
 * the connection has already succeeded, and every remaining boundary -
 * poll registered? requests sent? responses returned? scheduler paused?
 * sample sequence advancing? decoded angles changing? renderer handed a
 * changed pose? - was invisible from the field. A real flight controller
 * showed a motionless 3D model, compass and artificial horizon through
 * the published preview, and the only pipeline instrumentation that
 * existed (orientationLatencyDebugLog.ts) is `__DEV__`-gated and
 * therefore does nothing in the build the user runs.
 *
 * WHAT IT RECORDS: build identity, session lifecycle/ownership state,
 * whether Setup considers itself active, per-poll registration/pause
 * state, request and response counts, byte counters (shared with the
 * connection report's own counters - the same transport wrote them),
 * FRESH/STALE/ERROR/UNAVAILABLE, sampleSeq, sample age, the DECODED and
 * already-display-normalized roll/pitch/yaw, the latest scheduler poll
 * error code, the latest MSP client error code, the latest transport
 * error code, and whether the renderer was handed a CHANGED pose.
 *
 * WHAT IT REFUSES TO RECORD: raw payload bytes, MSP frame bodies,
 * firmware content, error MESSAGES (only enumerated codes - a message
 * can be built out of wire offsets), browser fingerprinting, and any
 * value this module cannot read from a real source. Nothing here is
 * defaulted to a plausible-looking number: a fact that is not available
 * is printed as "غير متاح", never as 0.
 */

// TYPE-ONLY imports (erased at compile time): this module adds no
// runtime dependency on core or on the UI layer, and the report can
// therefore never drift from the real shapes it prints.
import type {TelemetrySchedulerDiagnostics} from '../../core';
import type {OrientationRenderObservation} from '../../ui/orientation3d/orientationRenderObserver';
import {readByteCounters} from './connectionDiagnostics';

/** A bounded ring of the notable telemetry transitions worth keeping
 * across a session. Small on purpose: this report's value is in the
 * counters and the current state, not in a log. */
const MAX_EVENTS = 60;

export type TelemetryDiagnosticEvent = {
  readonly atMs: number;
  readonly stage: string;
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
};

let events: TelemetryDiagnosticEvent[] = [];
/** Latest enumerated codes, retained past recovery - a snapshot of the
 * current value alone destroys "it had been failing". */
let lastMspErrorCode: string | undefined;
let lastTransportErrorCode: string | undefined;

function now(): number {
  return typeof performance !== 'undefined' ? Math.round(performance.now()) : 0;
}

export function recordTelemetryEvent(
  stage: string,
  detail?: Readonly<Record<string, string | number | boolean>>,
): void {
  events.push({atMs: now(), stage, detail});
  if (events.length > MAX_EVENTS) {
    // Keep the FIRST five (session start, poll registration) and drop
    // from the middle: a long session must not push the moment
    // telemetry began out of the report.
    events = [...events.slice(0, 5), ...events.slice(events.length - (MAX_EVENTS - 5))];
  }
}

/** Codes only - see this file's own header on why never a message. */
export function recordMspErrorCode(code: string): void {
  lastMspErrorCode = code;
}

export function recordTransportErrorCode(code: string): void {
  lastTransportErrorCode = code;
}

export function resetTelemetryDiagnosticsForTests(): void {
  events = [];
  lastMspErrorCode = undefined;
  lastTransportErrorCode = undefined;
}

declare const __FPV_ARBCON_BUILD__: string | undefined;

function buildIdentity(): string {
  try {
    return typeof __FPV_ARBCON_BUILD__ === 'string' ? __FPV_ARBCON_BUILD__ : 'dev';
  } catch {
    return 'dev';
  }
}

const UNKNOWN = 'غير متاح';

function orUnknown(value: string | number | boolean | undefined): string {
  return value === undefined ? UNKNOWN : String(value);
}

/**
 * Everything the SCREEN knows and this module cannot read for itself.
 * Passed in rather than imported so this module depends on nothing above
 * the platform layer - the same rule connectionDiagnostics.ts follows.
 */
export type TelemetryReportSnapshot = {
  readonly sessionId?: string;
  readonly generation?: number;
  /** Coordinator ownership: 'ACTIVE' / 'ACTIVATING' / 'INACTIVE'. */
  readonly ownershipState?: string;
  readonly identificationStatus?: string;
  /** AppState phase as the Setup screen sees it. */
  readonly appStatePhase?: string;
  /** Whether the Setup TAB is the visible one right now - the `active`
   * prop that gates every telemetry subscription on this screen. */
  readonly setupActive?: boolean;
  /** undefined = the session has no scheduler at all (telemetry never
   * started, or was torn down). */
  readonly scheduler?: TelemetrySchedulerDiagnostics;
  readonly render?: OrientationRenderObservation;
  /** Clock used to age the newest sample. Injectable for tests. */
  readonly wallClockMs?: number;
};

function describePoll(
  scheduler: TelemetrySchedulerDiagnostics | undefined,
  pollId: string,
  wallClockMs: number | undefined,
  lines: string[],
): void {
  if (scheduler === undefined) {
    lines.push(`${pollId}: لا يوجد مجدول تليمترية لهذه الجلسة إطلاقًا`);
    return;
  }
  const poll = scheduler.polls.find(entry => entry.id === pollId);
  if (poll === undefined) {
    // A registered-then-unregistered poll and a never-registered one are
    // both "missing" here; the events ring above is what separates them.
    lines.push(`${pollId}: غير مُسجَّل (MISSING)`);
    return;
  }
  const ageMs =
    wallClockMs !== undefined && poll.updatedAtMs !== undefined
      ? Math.max(0, Math.round(wallClockMs - poll.updatedAtMs))
      : undefined;
  lines.push(
    `${poll.id}: cmd=${poll.command} حالة=${poll.status} مسجَّل=نعم ` +
      `فترة=${poll.intervalMs}ms تقادم=${poll.staleAfterMs}ms أولوية=${poll.priority}`,
  );
  lines.push(
    `  طلبات=${poll.requestCount} استجابات=${poll.responseCount} أخطاء=${poll.errorCount} ` +
      `قيد التنفيذ=${poll.inFlight} آخر كود خطأ للمجدول=${orUnknown(poll.lastErrorCode)}`,
  );
  lines.push(`  sampleSeq=${orUnknown(poll.sampleSeq)} عمر العيّنة=${ageMs === undefined ? UNKNOWN : `${ageMs}ms`}`);
}

export function buildTelemetryReport(snapshot: TelemetryReportSnapshot = {}): string {
  const {scheduler, render} = snapshot;
  const lines: string[] = [];
  lines.push('FPV-ARBCON — تقرير تليمترية تقني');
  lines.push(`البنية: ${buildIdentity()}`);
  lines.push(`الوقت منذ فتح الصفحة: ${now()}ms`);

  lines.push('--- الجلسة ---');
  lines.push(`sessionId: ${orUnknown(snapshot.sessionId)}`);
  lines.push(`الجيل: ${orUnknown(snapshot.generation)}`);
  lines.push(`حالة الملكية: ${orUnknown(snapshot.ownershipState)}`);
  lines.push(`حالة التعريف: ${orUnknown(snapshot.identificationStatus)}`);
  lines.push(`طور التطبيق: ${orUnknown(snapshot.appStatePhase)}`);
  lines.push(
    `تبويب Setup نشط: ${
      snapshot.setupActive === undefined ? UNKNOWN : snapshot.setupActive ? 'نعم' : 'لا'
    }`,
  );

  lines.push('--- المجدول ---');
  if (scheduler === undefined) {
    lines.push('لا يوجد مجدول تليمترية لهذه الجلسة (لم يبدأ أو أُنهي)');
  } else {
    lines.push(`عدد النبضات (tick): ${scheduler.tickCount}`);
    lines.push(`طلبات قيد التنفيذ: ${scheduler.inFlightCount}`);
    lines.push(
      `أسباب الإيقاف المؤقت النشطة: ${
        scheduler.pauseReasons.length === 0 ? 'لا يوجد' : scheduler.pauseReasons.join('، ')
      }`,
    );
    lines.push(`عدد الاستطلاعات المسجّلة: ${scheduler.polls.length}`);
  }

  lines.push('--- الاستطلاعات ---');
  describePoll(scheduler, 'attitude', snapshot.wallClockMs, lines);
  describePoll(scheduler, 'battery', snapshot.wallClockMs, lines);

  lines.push('--- الوضعية المعروضة ---');
  if (render === undefined) {
    lines.push('لا توجد مشاهدة عرض');
  } else {
    lines.push(`مصدر الجلسة: ${orUnknown(render.sessionToken)}`);
    lines.push(`حالة العرض: ${orUnknown(render.lastStatus)}`);
    lines.push(`آخر sampleSeq وصل إلى الواجهة: ${orUnknown(render.lastSampleSeq)}`);
    lines.push(
      `roll=${orUnknown(render.lastRollDeg)} pitch=${orUnknown(render.lastPitchDeg)} yaw=${orUnknown(
        render.lastYawDeg,
      )}`,
    );
    lines.push(
      `عيّنات hero=${render.heroSampleCount} عيّنات الراسم=${render.rendererSampleCount} ` +
        `أوضاع مختلفة=${render.distinctPoseCount}`,
    );
    lines.push(`آخر تغيّر فعلي للوضعية: ${render.lastPoseChangeAtMs === undefined ? UNKNOWN : `${render.lastPoseChangeAtMs}ms`}`);
  }

  const bytes = readByteCounters();
  lines.push('--- البايتات والأخطاء ---');
  lines.push(
    `bytes: sent=${bytes.bytesWritten} (${bytes.writeCount} writes) received=${bytes.bytesReceived} (${bytes.receiveChunks} chunks)`,
  );
  lines.push(`آخر كود خطأ MSP: ${orUnknown(lastMspErrorCode)}`);
  lines.push(`آخر كود خطأ ناقل: ${orUnknown(lastTransportErrorCode)}`);

  lines.push('--- الأحداث ---');
  if (events.length === 0) {
    lines.push('(لا أحداث مسجلة بعد)');
  }
  for (const entry of events) {
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

/** Same two-step clipboard strategy connectionDiagnostics.ts uses, for
 * the same reason: navigator.clipboard is absent or rejected in enough
 * real browser situations that a silent failure would be worse than a
 * legacy fallback. */
export async function copyTelemetryReport(snapshot: TelemetryReportSnapshot = {}): Promise<boolean> {
  const text = buildTelemetryReport(snapshot);
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
