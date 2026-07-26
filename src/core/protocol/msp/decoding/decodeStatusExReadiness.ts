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
  /**
   * Pass 7.7 closure: set ONLY when a tail field was PARTIALLY present -
   * i.e. the frame began a field it could not finish (a declared
   * extension byteCount larger than the bytes that remain, or the
   * arming-disable count byte followed by fewer than the four mask
   * bytes). This is categorically different from a valid shorter payload
   * that simply stopped before an optional field BEGAN, which leaves
   * this undefined.
   *
   * The distinction matters downstream and must never be normalized
   * away: "the FC did not send blockers" is honest absence, while "the
   * frame is inconsistent" means nothing decoded after the fixed prefix
   * can be trusted - so it can neither be shown as a readiness fact nor
   * authorize an FC write. The safely decoded fixed prefix is still
   * returned alongside it; no field is ever partially reconstructed and
   * no read ever goes out of bounds.
   */
  readonly malformedTail?: true;
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
    // One lone byte after the fixed prefix: PID_PROFILE_COUNT began but
    // the rate-profile index that must follow it is missing.
    return {malformedTail: true};
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
    // Declared more extension bytes than the frame actually holds: a
    // PARTIALLY PRESENT field, not an absent one. Stop without reading
    // out of bounds, keep the safely decoded prefix fields, and mark the
    // tail malformed so no consumer can mistake this for honest absence.
    return {pidProfileCount, controlRateProfileIndex, malformedTail: true};
  }
  const extraFlightModeFlagBytes = Array.from(reader.readBytes(byteCount));
  consumed += byteCount;

  if (remaining() === 0) {
    // The frame legitimately stopped BEFORE the blocker field began:
    // honest absence, not malformed.
    return {pidProfileCount, controlRateProfileIndex, extraFlightModeFlagBytes};
  }
  if (remaining() < 5) {
    // 1-4 bytes left: the ARMING_DISABLE_FLAGS_COUNT byte is present but
    // 0-3 of the four mask bytes are missing. The mask is NEVER partially
    // reconstructed, and this is NEVER normalized into "absent" or into a
    // zero-blocker reading - it is reported as malformed.
    return {pidProfileCount, controlRateProfileIndex, extraFlightModeFlagBytes, malformedTail: true};
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
