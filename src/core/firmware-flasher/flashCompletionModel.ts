/**
 * FLASH COMPLETION TRUTH - the terminal-state contract, pure.
 *
 * WHY THIS EXISTS. A real operator watched a flash sit near 98% forever
 * with no SUCCESS and no FAILURE. The deterministic reproduction
 * (.dev-preview/audit/flasher-p0) proved why: WebUSB control transfers
 * take no timeout, the DFU engine awaited each one directly, and a single
 * wedged transfer left `flashDfuFirmware()`'s promise pending with ZERO
 * timers remaining - nothing in the program could ever settle it. The UI
 * stall watchdog only OBSERVED that state; nothing settled it.
 *
 * THE CONTRACT. Every flash attempt must end in exactly one of:
 *
 *   SUCCESS      - real completion evidence exists;
 *   FAILED       - a real, stated failure;
 *   UNCONFIRMED  - the attempt was frozen without enough evidence to
 *                  claim either, with a safe next step for the operator.
 *
 * A deadline is never converted into SUCCESS. The single overrun case
 * that classifies as SUCCESS carries the same evidence the Android worker
 * and the pinned Betaflight Configurator reference accept (see
 * docs/FIRMWARE_FLASHER_PARITY.md, reference commit 5ed74193a757,
 * `src/js/protocols/usbdfu.js`): every byte was read back and matched,
 * the manifestation (zero-length DNLOAD after SET_ADDRESS) was issued,
 * and the device has PHYSICALLY left the bus - which is precisely what a
 * successful DfuSe manifestation does (DFU 1.1: MANIFEST-SYNC ->
 * dfuMANIFEST -> MANIFEST-WAIT-RESET -> USB reset). A board that is still
 * present but silent is never SUCCESS, no matter how many bytes verified.
 *
 * WHAT THIS MODULE REFUSES TO DO. It has no transport, no device, no
 * timer and no command surface, and it never decides to retry anything:
 * re-sending an erase, a write or a manifestation against a wedged
 * session is how boards get corrupted. It only names the truth of an
 * attempt from the evidence the engine gathered.
 */

import type {FlashPhase} from './flashPhaseModel';

/** The stage a DfuSe flash attempt was in when it was frozen. */
export type DfuFlashStage =
  | 'OPEN'
  | 'ERASE'
  | 'WRITE'
  | 'VERIFY'
  | 'FINALIZE'
  | 'MANIFEST';

/** The only three ways a flash attempt is allowed to end. */
export type FlashOutcomeKind = 'SUCCESS' | 'FAILED' | 'UNCONFIRMED';

/**
 * THE PRODUCT-FACING TERMINAL MODEL - three separate truths, never merged.
 *
 *   VERIFIED_FLASH_SUCCESS
 *     erased as required, written, and read back byte-for-byte equal,
 *     AND the board's reset was observed.
 *   VERIFIED_FLASH_SUCCESS_RESET_UNCONFIRMED
 *     the same firmware truth; only the reset/return was not observed
 *     inside the observation window. This is NOT a failure and must never
 *     be presented as one.
 *   FLASH_FAILED
 *     the destructive work is not proven complete: erase or write failed,
 *     or the read-back proved a mismatch.
 *   FLASH_UNCONFIRMED
 *     genuinely ambiguous - bytes were sent but their read-back proof
 *     never completed, so byte truth is not established.
 */
export type FlashTerminalResult =
  | 'VERIFIED_FLASH_SUCCESS'
  | 'VERIFIED_FLASH_SUCCESS_RESET_UNCONFIRMED'
  | 'FLASH_FAILED'
  | 'FLASH_UNCONFIRMED';

/**
 * Names the terminal result from the two facts that are actually
 * independent. `resetConfirmed` may only refine a SUCCESS; it can never
 * turn one into a failure, which is the whole point of the split.
 */
export function flashTerminalResult(
  outcome: FlashOutcomeKind,
  resetConfirmed: boolean | undefined,
): FlashTerminalResult {
  if (outcome === 'FAILED') {
    return 'FLASH_FAILED';
  }
  if (outcome === 'UNCONFIRMED') {
    return 'FLASH_UNCONFIRMED';
  }
  return resetConfirmed === true
    ? 'VERIFIED_FLASH_SUCCESS'
    : 'VERIFIED_FLASH_SUCCESS_RESET_UNCONFIRMED';
}

/* Error codes the WebUSB engine mints for frozen attempts. They travel as
 * `code` on the rejection because the transport client's
 * normalizeNativeError() copies ONLY `code` and `message` - any richer
 * field would be stripped at that boundary. */
export const DFU_CODE_UNCONFIRMED_VERIFY = 'DFU_COMPLETION_UNCONFIRMED_VERIFY';
export const DFU_CODE_UNCONFIRMED_MANIFEST = 'DFU_COMPLETION_UNCONFIRMED_MANIFEST';
export const DFU_CODE_UNRESPONSIVE_ERASE = 'DFU_DEVICE_UNRESPONSIVE_ERASE';
export const DFU_CODE_UNRESPONSIVE_WRITE = 'DFU_DEVICE_UNRESPONSIVE_WRITE';
export const DFU_CODE_SESSION_POISONED = 'DFU_SESSION_POISONED';
/** Minted by the screen's last-resort backstop, never by the engine. */
export const FLASH_CODE_UI_BACKSTOP = 'FLASH_UI_BACKSTOP';
/** Minted by the screen when a flash attempt produced no transfer at all. */
export const FLASH_CODE_NEVER_STARTED = 'FLASH_NEVER_STARTED';

/** Everything the engine knows at the moment a transfer overran its
 * observation deadline. All of it is measured, none of it guessed. */
export interface DfuOverrunEvidence {
  readonly stage: DfuFlashStage;
  /** Every image byte was transferred AND acknowledged download-idle. */
  readonly allBytesWritten: boolean;
  /** Every image byte was read back and compared equal. */
  readonly allBytesVerified: boolean;
  /** The zero-length DNLOAD (DfuSe leave) was issued. */
  readonly manifestationRequested: boolean;
  /** The device is no longer present on the bus (bounded probe; an
   * unanswerable probe reports PRESENT, never absent). */
  readonly deviceGone: boolean;
}

export interface DfuOverrunVerdict {
  readonly outcome: FlashOutcomeKind;
  /** The rejection code for FAILED/UNCONFIRMED; undefined for SUCCESS. */
  readonly code?: string;
}

/**
 * The one decision table for a frozen WebUSB transfer. Kept pure and
 * exhaustive so the safety argument is readable in one place:
 *
 *   OPEN / ERASE / WRITE  -> FAILED. The image on the device is absent or
 *                            incomplete; that is a real failure and the
 *                            operator must re-flash before flying.
 *   VERIFY                -> UNCONFIRMED. Every byte was written and
 *                            acknowledged, but the read-back proof did not
 *                            finish - byte truth is not established, so
 *                            neither success nor failure is honest.
 *   FINALIZE / MANIFEST   -> SUCCESS whenever every byte was read back and
 *                            matched. Reaching these stages at all means
 *                            the read-back pass completed.
 *
 * WHY `deviceGone` IS NO LONGER PART OF THE SUCCESS TEST. It used to be,
 * and that is precisely what a real Pavo/BetaFPV F405 ran into: the board
 * was flashed and byte-for-byte verified, then the engine sampled the bus
 * once, still saw the device (a resetting STM32 stays enumerated for a
 * noticeable interval), and downgraded a finished flash to UNCONFIRMED
 * with restart doubt. Verified flash memory is a fact; USB disappearance
 * timing is not evidence about it. The reset observation still happens -
 * it travels separately as `resetConfirmed` on the terminal progress
 * event, so the operator learns whether the board came back WITHOUT that
 * answer being allowed to rewrite what is already on the board.
 */
export function classifyDfuOverrun(evidence: DfuOverrunEvidence): DfuOverrunVerdict {
  switch (evidence.stage) {
    case 'OPEN':
    case 'ERASE':
      return {outcome: 'FAILED', code: DFU_CODE_UNRESPONSIVE_ERASE};
    case 'WRITE':
      return {outcome: 'FAILED', code: DFU_CODE_UNRESPONSIVE_WRITE};
    case 'VERIFY':
      return {outcome: 'UNCONFIRMED', code: DFU_CODE_UNCONFIRMED_VERIFY};
    case 'FINALIZE':
    case 'MANIFEST':
      if (evidence.allBytesVerified) {
        return {outcome: 'SUCCESS'};
      }
      return {outcome: 'UNCONFIRMED', code: DFU_CODE_UNCONFIRMED_MANIFEST};
  }
}

/**
 * Maps a settled REJECTION to the operator-facing outcome kind. Shared by
 * both platforms:
 *
 *  - the WebUSB engine's own UNCONFIRMED codes pass through;
 *  - Android's DFU_STATUS_TIMEOUT is UNCONFIRMED exactly when it happened
 *    in the manifestation window (the Kotlin worker throws it there when
 *    a still-present board never confirmed its reset - the same
 *    present-but-silent situation the web engine names explicitly), and a
 *    plain FAILED everywhere else;
 *  - everything else is FAILED. Never SUCCESS: a rejection cannot carry
 *    completion evidence.
 */
export function classifyFlashRejection(
  code: string | undefined,
  phaseAtRejection: FlashPhase | undefined,
): Exclude<FlashOutcomeKind, 'SUCCESS'> {
  if (code === undefined) {
    return 'FAILED';
  }
  if (
    code === DFU_CODE_UNCONFIRMED_VERIFY ||
    code === DFU_CODE_UNCONFIRMED_MANIFEST ||
    code === FLASH_CODE_UI_BACKSTOP
  ) {
    return 'UNCONFIRMED';
  }
  if (
    code === 'DFU_STATUS_TIMEOUT' &&
    (phaseAtRejection === 'MANIFESTING' || phaseAtRejection === 'RESETTING')
  ) {
    return 'UNCONFIRMED';
  }
  return 'FAILED';
}

/** The i18n key carrying the short REAL reason for a rejection code.
 * Callers fall back to the raw sanitized message when no key exists. */
export function flashReasonLabelKey(code: string): string {
  return `firmwareFlasher.reason.${code}`;
}

/** The i18n key for the safe next action of an UNCONFIRMED result. */
export function flashNextActionLabelKey(code: string | undefined): string {
  if (code === DFU_CODE_UNCONFIRMED_VERIFY) {
    return 'firmwareFlasher.nextAction.VERIFY_UNFINISHED';
  }
  if (code === DFU_CODE_UNCONFIRMED_MANIFEST || code === 'DFU_STATUS_TIMEOUT') {
    return 'firmwareFlasher.nextAction.MANIFEST_SILENT';
  }
  return 'firmwareFlasher.nextAction.GENERIC';
}
