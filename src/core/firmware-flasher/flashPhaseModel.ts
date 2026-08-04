/**
 * FLASH PHASES, NAMED - and stalls, detected without ever retrying.
 *
 * WHY THIS EXISTS. A real operator reported that flashing "reached
 * approximately 98% and stalled without completing or explaining the
 * exact phase". Two separate defects produced that:
 *
 *  1. the progress line was raw English protocol text
 *     ("DFU: verifying • 12345/67890"), so the operator could not tell
 *     what the board was doing;
 *  2. in the DfuSe path, read-back verification occupies 75-99% and
 *     NOTHING was emitted between the last verify block and `complete`,
 *     so the whole manifestation phase - the phase in which the board
 *     actually resets, and the one that can genuinely hang - looked like
 *     a frozen percentage.
 *
 * This module is the pure half of the correction: a stable phase
 * vocabulary shared by every flashing method, and a stall verdict derived
 * only from elapsed time since the last observed progress.
 *
 * WHAT IT REFUSES TO DO. It never decides to retry, resend, re-erase or
 * re-write anything, and it cannot: it has no transport, no device and no
 * command. A STALLED verdict is a statement to the operator, not an
 * instruction to the machine.
 *
 * THE WEBUSB LIMITATION IS REAL AND IS NOT WORKED AROUND HERE.
 * controlTransferIn/controlTransferOut accept no AbortSignal and cannot
 * be cancelled, so a pending transfer can only be OBSERVED. `stalled`
 * therefore describes the UI's knowledge, never the device's state, and
 * `transferMayBePending` says so explicitly.
 */

/** Every phase any supported flashing method can report. */
export type FlashPhase =
  | 'PREPARING'
  | 'VALIDATING_TARGET'
  | 'REQUESTING_BOOTLOADER'
  | 'WAITING_FOR_DEVICE'
  | 'ERASING'
  | 'WRITING'
  | 'VERIFYING'
  | 'FINALIZING'
  | 'MANIFESTING'
  | 'RESETTING'
  | 'WAITING_FOR_RECONNECT'
  | 'COMPLETE'
  | 'FAILED'
  | 'UNKNOWN';

/** Which code path is actually running - the operator's first question
 * when something stops, and previously not shown at all. */
export type FlashMethod = 'DFU_WEBUSB' | 'STM32_SERIAL' | 'ESP_SERIAL' | 'UNKNOWN';

/**
 * Maps a transport's own raw phase string onto the shared vocabulary.
 * Unrecognised input becomes UNKNOWN rather than being guessed into a
 * neighbouring phase - a wrong phase name is worse than an honest one.
 */
export function toFlashPhase(raw: string | undefined): FlashPhase {
  switch ((raw ?? '').trim().toLowerCase()) {
    case 'preparing':
      return 'PREPARING';
    case 'validating':
    case 'validating_target':
      return 'VALIDATING_TARGET';
    case 'requesting_bootloader':
    case 'reboot':
      return 'REQUESTING_BOOTLOADER';
    case 'waiting_for_device':
    case 'enumerating':
      return 'WAITING_FOR_DEVICE';
    case 'erasing':
    case 'erase':
      return 'ERASING';
    case 'writing':
    case 'write':
    case 'flashing':
      return 'WRITING';
    case 'verifying':
    case 'verify':
      return 'VERIFYING';
    case 'finalizing':
      return 'FINALIZING';
    case 'manifesting':
    case 'manifestation':
      return 'MANIFESTING';
    case 'resetting':
    case 'reset':
      return 'RESETTING';
    case 'waiting_for_reconnect':
      return 'WAITING_FOR_RECONNECT';
    case 'complete':
    case 'completed':
    case 'done':
      return 'COMPLETE';
    case 'failed':
    case 'error':
      return 'FAILED';
    default:
      return 'UNKNOWN';
  }
}

/** The i18n key for a phase. One place, so no screen invents wording. */
export function flashPhaseLabelKey(phase: FlashPhase): string {
  return `firmwareFlasher.phase.${phase}`;
}

/**
 * How long a phase may go without any progress before the UI is entitled
 * to call it stalled.
 *
 * Per phase, because they are not comparable: a single erase command on a
 * large sector legitimately takes many seconds, while a write block that
 * has gone quiet for that long has genuinely stopped. Manifestation gets
 * the longest window because the board is resetting inside it, which is
 * expected to be silent.
 */
export const FLASH_STALL_THRESHOLD_MS: Readonly<Record<FlashPhase, number>> =
  Object.freeze({
    PREPARING: 20_000,
    VALIDATING_TARGET: 20_000,
    REQUESTING_BOOTLOADER: 20_000,
    WAITING_FOR_DEVICE: 30_000,
    ERASING: 30_000,
    WRITING: 15_000,
    VERIFYING: 15_000,
    FINALIZING: 20_000,
    MANIFESTING: 40_000,
    RESETTING: 40_000,
    WAITING_FOR_RECONNECT: 45_000,
    // Terminal phases can never stall.
    COMPLETE: Number.POSITIVE_INFINITY,
    FAILED: Number.POSITIVE_INFINITY,
    UNKNOWN: 30_000,
  });

export interface FlashProgressSnapshot {
  readonly method: FlashMethod;
  readonly phase: FlashPhase;
  readonly percent: number;
  readonly bytesProcessed: number;
  readonly totalBytes: number;
  /** Monotonic-ish stamp of the LAST observed progress event. */
  readonly lastProgressAtMs: number;
  /** When the whole operation started. */
  readonly startedAtMs: number;
  /** DfuSe block number, when the method reports one. */
  readonly blockNumber?: number;
  /** Device identity the operation is running against. */
  readonly targetIdentity?: string;
  /** The last operation that completed successfully. */
  readonly lastCompletedOperation?: string;
  /** Whether a browser transfer promise may still be outstanding. Only
   * ever true for the WebUSB path, which cannot cancel one. */
  readonly transferMayBePending: boolean;
}

export interface FlashStallVerdict {
  readonly stalled: boolean;
  /** Milliseconds since the last progress event. */
  readonly silentForMs: number;
  readonly threshold: number;
}

/**
 * The ONLY stall decision in the app. Pure: same inputs, same verdict,
 * no timers of its own and no side effects.
 */
export function evaluateFlashStall(
  snapshot: FlashProgressSnapshot,
  nowMs: number,
): FlashStallVerdict {
  const threshold = FLASH_STALL_THRESHOLD_MS[snapshot.phase];
  const silentForMs = Math.max(0, nowMs - snapshot.lastProgressAtMs);
  return {
    stalled: Number.isFinite(threshold) && silentForMs >= threshold,
    silentForMs,
    threshold,
  };
}

/**
 * A phase-named, percentage-free description a UI can show beside the
 * bar. Percentage is deliberately NOT folded in here: 98% inside
 * verification and 98% inside manifestation are different situations and
 * the number alone cannot tell them apart - which is exactly what the
 * operator ran into.
 */
export function describeFlashPhase(
  snapshot: FlashProgressSnapshot,
  translate: (key: string) => string,
): string {
  return translate(flashPhaseLabelKey(snapshot.phase));
}

/**
 * The copyable Arabic technical report for one flash attempt.
 *
 * Facts only: method, target, phase, byte counters, block number, the
 * last successfully completed operation, elapsed time and whether a
 * browser transfer may still be pending. No firmware content, no payload
 * bytes and no interpretation.
 */
export function buildFlashReport(
  snapshot: FlashProgressSnapshot,
  nowMs: number,
  extra?: {readonly buildIdentity?: string; readonly lastErrorCode?: string},
): string {
  const verdict = evaluateFlashStall(snapshot, nowMs);
  const lines: string[] = [];
  lines.push('FPV-ARBCON — تقرير تفليش تقني');
  if (extra?.buildIdentity !== undefined) {
    lines.push(`البنية: ${extra.buildIdentity}`);
  }
  lines.push(`الطريقة: ${snapshot.method}`);
  lines.push(`الجهاز الهدف: ${snapshot.targetIdentity ?? 'غير متاح'}`);
  lines.push(`المرحلة: ${snapshot.phase}`);
  lines.push(`النسبة: ${snapshot.percent}%`);
  lines.push(`البايتات: ${snapshot.bytesProcessed}/${snapshot.totalBytes}`);
  lines.push(`رقم الكتلة: ${snapshot.blockNumber ?? 'غير متاح'}`);
  lines.push(`آخر عملية مكتملة: ${snapshot.lastCompletedOperation ?? 'غير متاح'}`);
  lines.push(`الزمن المنقضي: ${Math.max(0, Math.round(nowMs - snapshot.startedAtMs))}ms`);
  lines.push(`صمت منذ آخر تقدّم: ${verdict.silentForMs}ms`);
  lines.push(`مصنّفة متوقفة: ${verdict.stalled ? 'نعم' : 'لا'}`);
  lines.push(
    `قد يكون نقل المتصفح ما زال معلّقًا: ${snapshot.transferMayBePending ? 'نعم' : 'لا'}`,
  );
  lines.push(`آخر كود خطأ: ${extra?.lastErrorCode ?? 'غير متاح'}`);
  lines.push(
    'ملاحظة: لا يمكن إلغاء نقل WebUSB قيد التنفيذ؛ التصنيف أعلاه وصف لحالة الواجهة لا للجهاز.',
  );
  return lines.join('\n');
}
