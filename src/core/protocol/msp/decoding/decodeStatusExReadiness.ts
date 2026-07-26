import {MspPayloadReader} from './MspPayloadReader';

/**
 * Pass 7.7 - BOUNDED readiness parse of MSP_STATUS_EX's OPTIONAL TAIL,
 * verified directly at the pinned API-1.47 authority
 * (BETAFLIGHT_API147_COMMIT = 7348054f268f0058574719c134e9f149565bb8ea):
 *
 *   msp.c:1094-1140 (case MSP_STATUS_EX), after the 13-byte fixed prefix
 *   already decoded by decodeStatusEx():
 *     offset 13  u8   PID_PROFILE_COUNT
 *     offset 14  u8   current control-rate profile index
 *     offset 15  u8   flight-mode-flags extension byteCount
 *                     ("Lowest 4 bits contain number of bytes that
 *                     follow", constrained 0..15 by the firmware)
 *     offset 16  byteCount bytes of additional flight-mode flags
 *     then       u8   ARMING_DISABLE_FLAGS_COUNT
 *     then       u32  armingDisableFlags   <-- UNSIGNED 32-bit
 *     then       u8   config-state flags (bit0 = reboot required)
 *     then       u16  core temperature (added in API 1.46)
 *
 * Everything from PID_PROFILE_COUNT onward is OPTIONAL as far as this
 * decoder is concerned: an older/shorter but VALID payload simply stops
 * earlier, and each field is read only when the whole field still fits.
 * A partially-present field (e.g. 2 of the 4 armingDisableFlags bytes) is
 * reported as absent rather than read out of bounds - the reader itself
 * also throws MspPayloadReadError on any over-read, so no truncated frame
 * can ever produce an invented value.
 *
 * armingDisableFlags is kept as an UNSIGNED value: JavaScript bitwise
 * operators are signed-32-bit, so bit 31 would flip the sign if `|` or
 * `>>` were used. The reader's readU32LE() returns an unsigned Number and
 * every consumer below tests bits arithmetically.
 */
export interface MspStatusExReadiness {
  /** Present only when the payload actually carried the field. */
  readonly pidProfileCount?: number;
  readonly controlRateProfileIndex?: number;
  /** Extra flight-mode-flag bytes beyond the first 32 bits, verbatim. */
  readonly extraFlightModeFlagBytes?: readonly number[];
  /** Firmware's own declared count (29 at the pinned authority). */
  readonly armingDisableFlagsCount?: number;
  /** UNSIGNED 32-bit mask; undefined when the payload ended first. */
  readonly armingDisableFlags?: number;
  readonly rebootRequired?: boolean;
}

/** Byte offset of the optional tail - the fixed prefix decodeStatusEx()
 * already covers is 13 bytes (msp.c @ the pinned authority). */
export const STATUS_EX_FIXED_PREFIX_BYTES = 13;

export function decodeStatusExReadiness(payload: Uint8Array): MspStatusExReadiness {
  if (payload.length <= STATUS_EX_FIXED_PREFIX_BYTES) {
    return {}; // valid shorter payload: prefix only, no readiness tail
  }
  const reader = new MspPayloadReader(payload.subarray(STATUS_EX_FIXED_PREFIX_BYTES));
  let consumed = 0;
  const remaining = () => payload.length - STATUS_EX_FIXED_PREFIX_BYTES - consumed;

  if (remaining() < 2) {
    return {};
  }
  const pidProfileCount = reader.readU8();
  const controlRateProfileIndex = reader.readU8();
  consumed += 2;

  if (remaining() < 1) {
    return {pidProfileCount, controlRateProfileIndex};
  }
  const byteCount = reader.readU8();
  consumed += 1;
  if (remaining() < byteCount) {
    // Declared more extension bytes than the frame actually holds:
    // malformed partial field - stop without reading out of bounds.
    return {pidProfileCount, controlRateProfileIndex};
  }
  const extraFlightModeFlagBytes = Array.from(reader.readBytes(byteCount));
  consumed += byteCount;

  if (remaining() < 5) {
    // The count byte plus the 4-byte mask must BOTH fit, otherwise the
    // blocker mask is absent (never partially reconstructed).
    return {pidProfileCount, controlRateProfileIndex, extraFlightModeFlagBytes};
  }
  const armingDisableFlagsCount = reader.readU8();
  const armingDisableFlags = reader.readU32LE(); // unsigned
  consumed += 5;

  if (remaining() < 1) {
    return {
      pidProfileCount,
      controlRateProfileIndex,
      extraFlightModeFlagBytes,
      armingDisableFlagsCount,
      armingDisableFlags,
    };
  }
  const configState = reader.readU8();
  consumed += 1;

  return {
    pidProfileCount,
    controlRateProfileIndex,
    extraFlightModeFlagBytes,
    armingDisableFlagsCount,
    armingDisableFlags,
    // bit0 = getRebootRequired() at the pinned authority.
    rebootRequired: configState % 2 === 1,
  };
}
