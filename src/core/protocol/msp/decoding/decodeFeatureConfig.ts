import {MspPayloadReader} from './MspPayloadReader';

/**
 * Motor read-capability pass - wire decoder for MSP_FEATURE_CONFIG (36),
 * verified verbatim against src/main/msp/msp.c:784-786 @
 * BETAFLIGHT_2025_12_2_COMMIT (see ../commands/mspCommandSources.ts for
 * the full citation record):
 *
 *   offset 0  u32  enabledFeatures - the whole feature bitmask
 *
 * Exactly 4 bytes are REQUIRED; a shorter payload is truncation and
 * throws MspPayloadReadError via the reader's own bounds check. Trailing
 * bytes beyond offset 3 are permitted and ignored, matching
 * decodeBoardInfo/decodeBatteryState's established forward-compatibility
 * posture.
 *
 * THE MASK IS UNSIGNED. Bit 31 is a legal set bit, so a raw value above
 * 0x7fffffff must survive as a positive number - MspPayloadReader's
 * readU32LE() already applies `>>> 0`, and this decoder must never
 * reinterpret it as signed.
 *
 * This decoder reports WIRE TRUTH only. It exposes the raw mask plus one
 * derived boolean for the single bit this codebase actually needs to
 * reason about; it applies no policy, and it is not a compatibility
 * verdict.
 */

/** src/main/config/feature.h:56 @ BETAFLIGHT_2025_12_2_COMMIT:
 * `FEATURE_3D = 1 << 12`. Exported because 3D state is safety-relevant
 * and callers must be able to check the bit against the raw mask
 * themselves rather than trusting a boolean they cannot audit. */
export const FEATURE_3D_BIT = 1 << 12;

export interface MspFeatureConfig {
  /** u32, unsigned. The complete mask exactly as the FC sent it - kept
   * raw because feature bit assignments are version-sensitive and this
   * decoder deliberately interprets only one of them. */
  readonly enabledFeaturesRaw: number;
  /** True only when FEATURE_3D (bit 12) is set in the raw mask.
   *
   * THE ONLY AUTHORITY FOR 3D STATE. It is never inferred from
   * MSP_MOTOR_3D_CONFIG's deadband/neutral values, which are present and
   * populated whether or not 3D is enabled. */
  readonly feature3dEnabled: boolean;
}

export function decodeFeatureConfig(payload: Uint8Array): MspFeatureConfig {
  const reader = new MspPayloadReader(payload);
  const enabledFeaturesRaw = reader.readU32LE();
  return Object.freeze({
    enabledFeaturesRaw,
    // Bitwise AND on a value above 0x7fffffff yields a negative number in
    // JavaScript, so the comparison is against 0 rather than against the
    // bit itself - `!== 0` is correct for every mask, signed-looking or
    // not.
    feature3dEnabled: (enabledFeaturesRaw & FEATURE_3D_BIT) !== 0,
  });
}
