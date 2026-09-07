import {resolveOperatorMessage} from './operatorMessage';

/**
 * THE ONE FLASH ERROR-CODE AUTHORITY.
 *
 * Before this module the STM32 serial engine threw errors carrying no code
 * at all, so the screen could only show their raw text; and the MSP layer's
 * English sentences reached an Arabic-first UI because the flasher looked
 * up `firmwareFlasher.reason.<code>` and never fell back to the shared
 * `errors.<code>` namespace that already had every one of them translated.
 *
 * Everything here is dependency-neutral: this file imports nothing from the
 * platform or UI layers, so the protocol code, the completion model and
 * both flasher screens can share it without a cycle.
 *
 * TWO ORTHOGONAL AXES, deliberately never merged:
 *
 *   FlashErrorCode        WHY the attempt ended - the root cause.
 *   FlashDestructiveState WHAT state the board's flash was left in.
 *
 * A post-erase failure is not a different reason; it is the SAME reason
 * plus a destructive-state advisory. Collapsing the two would hide the
 * cause behind the consequence.
 */

/* ------------------------------------------------------------------ *
 * Reason codes
 * ------------------------------------------------------------------ */

/** Raised by the STM32 ROM bootloader engine. */
export const STM32_FLASH_ERROR_CODES = [
  'STM32_MISSING_REQUIRED_COMMAND',
  'STM32_NO_ERASE_COMMAND',
  'STM32_CHIP_UNSUPPORTED',
  'STM32_GET_ID_SHAPE_INVALID',
  'STM32_IMAGE_TOO_LARGE',
  'STM32_IMAGE_OUT_OF_FLASH',
  'STM32_PAGE_COUNT_REQUIRES_EXTENDED_ERASE',
  'STM32_VERIFY_MISMATCH',
  'STM32_NACK',
  'STM32_UNEXPECTED_RESPONSE',
  'STM32_CANCELLED',
] as const;

/** Raised by the raw serial port beneath the engine. */
export const SERIAL_FLASH_ERROR_CODES = [
  'SERIAL_OPERATION_CANCELLED',
  'SERIAL_SESSION_CLOSED',
  'SERIAL_DEVICE_DETACHED',
] as const;

/**
 * Raised by the pre-destructive planning stages. Every one of these is
 * decided BEFORE any erase can be emitted - that is the whole point of
 * their existing.
 */
export const FLASH_PLAN_ERROR_CODES = [
  'FLASH_PLAN_UNENCODABLE_BLOCK',
  'FLASH_PLAN_GO_NOT_COVERED',
  'FLASH_PLAN_ADDRESS_RANGE_INVALID',
  'FLASH_PLAN_SEGMENT_BELOW_FLASH_BASE',
] as const;

export const FLASH_ERROR_CODES = [
  ...STM32_FLASH_ERROR_CODES,
  ...SERIAL_FLASH_ERROR_CODES,
  ...FLASH_PLAN_ERROR_CODES,
] as const;

export type FlashErrorCode = (typeof FLASH_ERROR_CODES)[number];

export function isFlashErrorCode(value: unknown): value is FlashErrorCode {
  return typeof value === 'string' && (FLASH_ERROR_CODES as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ *
 * Destructive state
 * ------------------------------------------------------------------ */

/**
 * What the board's flash contents were left in, as OBSERVED - never
 * guessed from a progress percentage or a message string.
 *
 * The distinction that matters is between CONFIRMED and UNKNOWN. If the
 * complete erase request reached the transport and the link then died
 * before any answer, the device may well have erased successfully even
 * though this application never saw the acknowledgement. Reporting that as
 * "not erased" would send an operator to fly a blank board.
 */
export type FlashDestructiveState =
  /** Nothing that can destroy flash contents has been transmitted. */
  | 'PRE_DESTRUCTIVE'
  /** Erase payload bytes have been handed to the transport; no answer yet. */
  | 'ERASE_REQUEST_IN_FLIGHT'
  /** The device refused the erase COMMAND frame; it never ran. */
  | 'ERASE_REJECTED'
  /** The request went out and no conclusive answer came back. */
  | 'ERASE_OUTCOME_UNKNOWN'
  /** The device acknowledged the erase. Flash contents are gone. */
  | 'ERASE_CONFIRMED'
  | 'WRITING'
  | 'GO_IN_FLIGHT'
  | 'COMPLETED';

/**
 * The advisory to show ALONGSIDE the reason - never instead of it.
 * `NONE` renders nothing.
 */
export type FlashRecoveryAdvisory = 'NONE' | 'ERASE_CONFIRMED' | 'ERASE_UNCERTAIN';

export function recoveryAdvisoryFor(
  state: FlashDestructiveState | undefined,
): FlashRecoveryAdvisory {
  switch (state) {
    case 'ERASE_CONFIRMED':
    case 'WRITING':
    case 'GO_IN_FLIGHT':
      return 'ERASE_CONFIRMED';
    case 'ERASE_REQUEST_IN_FLIGHT':
    case 'ERASE_OUTCOME_UNKNOWN':
      return 'ERASE_UNCERTAIN';
    default:
      return 'NONE';
  }
}

/** i18n key for the recovery advisory. `NONE` has no key by construction. */
export function flashRecoveryLabelKey(advisory: Exclude<FlashRecoveryAdvisory, 'NONE'>): string {
  return `firmwareFlasher.recovery.${advisory}`;
}

/* ------------------------------------------------------------------ *
 * Operator-text resolution
 * ------------------------------------------------------------------ */

/**
 * Minimal shape of i18next's `t`, so this module needs no i18n import. The
 * options bag is open because a trusted app-authored message carries
 * interpolation VALUES alongside its `defaultValue`.
 */
export type FlashTranslate = (key: string, options?: Record<string, unknown>) => string;

/**
 * THE RESOLUTION CHAIN.
 *
 *   1. firmwareFlasher.reason.<code>   flasher-specific copy
 *   2. errors.<code>                   the shared flat namespace, which
 *                                      already carries every MSP and
 *                                      transport code in Arabic
 *   3. errors.UNKNOWN                  localized terminal fallback
 *
 * RAW EXCEPTION TEXT IS NEVER RETURNED, in any language. The engine's own
 * hard-coded Arabic is no more suitable as operator copy than the MSP
 * layer's English: neither is translatable, neither is reviewable, and
 * neither belongs in the one line an operator reads before deciding
 * whether the aircraft is safe. Raw text stays on the diagnostic surface.
 */
export function resolveFlashReason(t: FlashTranslate, code: string | undefined): string {
  if (typeof code === 'string' && code.length > 0) {
    const specific = t(`firmwareFlasher.reason.${code}`, {defaultValue: ''});
    if (typeof specific === 'string' && specific.length > 0) return specific;
    const shared = t(`errors.${code}`, {defaultValue: ''});
    if (typeof shared === 'string' && shared.length > 0) return shared;
  }
  return t('errors.UNKNOWN');
}

/**
 * ANY string code an error carries, not only the eighteen this module owns.
 * MSP and transport codes live in the shared `errors.*` namespace and must
 * reach the operator through the catalogue exactly like the flasher's own.
 */
function anyErrorCode(error: unknown): string | undefined {
  const code = (error as {code?: unknown} | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

/**
 * THE ONE OPERATOR-TEXT CONTRACT, shared by both flasher screens.
 *
 *   1. a CODE -> firmwareFlasher.reason.<code> -> errors.<code> -> UNKNOWN
 *   2. a TRUSTED app-authored message -> its catalogue key + values
 *   3. anything else -> errors.UNKNOWN
 *
 * There is deliberately no fourth case. A raw `Error.message` is never
 * rendered, in any script: the previous Unicode-range test asked what
 * alphabet a string was written in, which is not a statement about who
 * wrote it or whether anyone reviewed it. Raw text stays on the diagnostic
 * surfaces, where unreviewed text belongs.
 */
export function resolveOperatorFacingText(t: FlashTranslate, error: unknown): string {
  const code = anyErrorCode(error);
  if (code !== undefined) return resolveFlashReason(t, code);
  const authored = resolveOperatorMessage(t, error);
  if (authored !== undefined) return authored;
  return t('errors.UNKNOWN');
}

/* ------------------------------------------------------------------ *
 * The carrier
 * ------------------------------------------------------------------ */

/**
 * Everything the UI needs from a failed flash, with the cause preserved.
 * `diagnostics` is for the log and the flash report; it never becomes the
 * rendered reason.
 */
export interface FlashFailureDetail {
  readonly code: FlashErrorCode;
  readonly destructiveState: FlashDestructiveState;
  readonly diagnostics?: string;
}

export function readFlashFailureDetail(error: unknown): FlashFailureDetail | undefined {
  const candidate = error as {code?: unknown; destructiveState?: unknown; diagnostics?: unknown} | null;
  if (candidate === null || typeof candidate !== 'object') return undefined;
  if (!isFlashErrorCode(candidate.code)) return undefined;
  const state = candidate.destructiveState;
  return {
    code: candidate.code,
    destructiveState: typeof state === 'string' ? (state as FlashDestructiveState) : 'PRE_DESTRUCTIVE',
    ...(typeof candidate.diagnostics === 'string' ? {diagnostics: candidate.diagnostics} : {}),
  };
}

/**
 * A pre-destructive planning refusal. Raised before any transport is
 * touched, so its destructive state is `PRE_DESTRUCTIVE` by construction.
 */
export class FlashPlanError extends Error {
  readonly code: FlashErrorCode;
  readonly destructiveState: FlashDestructiveState = 'PRE_DESTRUCTIVE';
  readonly diagnostics: string;

  constructor(code: FlashErrorCode, diagnostics: string) {
    super(diagnostics);
    this.name = 'FlashPlanError';
    this.code = code;
    this.diagnostics = diagnostics;
  }
}
