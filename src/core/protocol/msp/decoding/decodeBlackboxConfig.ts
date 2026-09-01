import {MspPayloadReadError, MspPayloadReader} from './MspPayloadReader';

/**
 * MSP_BLACKBOX_CONFIG (80) - the wire read.
 *
 * Layout derived from the Betaflight serializer at commit
 * 7348054f268f0058574719c134e9f149565bb8ea (API 1.47), case
 * MSP_BLACKBOX_CONFIG, and re-checked byte-for-byte against master
 * (API 1.49) where the same seven writes appear unchanged:
 *
 *   offset 0   u8   1 when the build has USE_BLACKBOX, else 0
 *   offset 1   u8   blackboxConfig()->device
 *   offset 2   u8   rate numerator - the firmware hard-codes 1 and its own
 *                   comment marks it "not used anymore"
 *   offset 3   u8   blackboxGetRateDenom()  - derived, not a stored field
 *   offset 4   u16  blackboxGetPRatio()     - derived, not a stored field
 *   offset 6   u8   blackboxConfig()->sample_rate
 *   offset 7   u32  blackboxConfig()->fields_disabled_mask (API >= 1.45)
 *
 * ELEVEN BYTES, ALL REQUIRED. The unsupported branch of the same case
 * writes the identical eleven-byte shape with zeros, so a short payload is
 * not "an older board" - it is a frame this decoder cannot trust, and it
 * throws rather than inventing the tail.
 *
 * `supported` COMES FROM BYTE 0, NEVER FROM THE ARRIVAL OF A PACKET. The
 * firmware answers command 80 either way; only the first byte separates a
 * board that can log from one whose build omitted Blackbox entirely.
 *
 * DEVICE AND SAMPLE RATE ARE KEPT RAW HERE. Mapping them to a supported
 * enum is a semantic decision with its own API evidence, and it lives in
 * blackboxStorageSemantics.ts - a decoder that silently narrowed an
 * unrecognised device to "NONE" would erase the only evidence that a newer
 * board reported something we do not model.
 */

/** Payload length the API-1.47 serializer always writes. */
export const BLACKBOX_CONFIG_PAYLOAD_BYTES = 11;

export interface MspBlackboxConfig {
  /** Byte 0, bit 0. The build has Blackbox compiled in. */
  readonly supported: boolean;
  /** Byte 0 verbatim, so an unexpected value is never lost. */
  readonly supportedRaw: number;
  /** u8, raw device selector. Interpreted by the semantic layer. */
  readonly deviceRaw: number;
  /**
   * u8. The firmware writes a constant 1 and calls it unused; retained so
   * the round trip stays byte-faithful, never as an input to a decision.
   */
  readonly legacyRateNumerator: number;
  /** u8. Derived by the firmware from the sample rate. Read-only. */
  readonly legacyRateDenominator: number;
  /** u16 LE. Derived by the firmware. Read-only. */
  readonly pRatio: number;
  /** u8, raw. 0..4 are the modelled rates; anything else stays raw. */
  readonly sampleRateRaw: number;
  /**
   * u32 LE, unsigned. A SET BIT MEANS THE FIELD IS DISABLED - the firmware
   * field is named fields_disabled_mask and the polarity is inverted from
   * the way a reader instinctively wants to read it.
   */
  readonly disabledFieldsMask: number;
}

export function decodeBlackboxConfig(payload: Uint8Array): MspBlackboxConfig {
  if (payload.length < BLACKBOX_CONFIG_PAYLOAD_BYTES) {
    throw new MspPayloadReadError(
      `MSP_BLACKBOX_CONFIG: expected at least ${BLACKBOX_CONFIG_PAYLOAD_BYTES} ` +
        `byte(s), received ${payload.length}.`,
    );
  }
  const reader = new MspPayloadReader(payload);
  const supportedRaw = reader.readU8();
  return Object.freeze({
    supported: (supportedRaw & 1) !== 0,
    supportedRaw,
    deviceRaw: reader.readU8(),
    legacyRateNumerator: reader.readU8(),
    legacyRateDenominator: reader.readU8(),
    pRatio: reader.readU16LE(),
    sampleRateRaw: reader.readU8(),
    disabledFieldsMask: reader.readU32LE(),
  });
}
