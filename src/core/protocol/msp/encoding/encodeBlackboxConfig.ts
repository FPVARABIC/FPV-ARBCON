/**
 * MSP_SET_BLACKBOX_CONFIG (81) - the wire write, and nothing else.
 *
 * Field order derived from the Betaflight reader at commit
 * 7348054f268f0058574719c134e9f149565bb8ea (API 1.47), case
 * MSP_SET_BLACKBOX_CONFIG, which consumes:
 *
 *   u8   device
 *   u8   rate numerator      - read, then discarded once pRatio is present
 *   u8   rate denominator    - same
 *   u16  pRatio              - taken directly when >= 2 bytes remain
 *   u8   sample_rate         - taken directly when >= 1 byte remains
 *   u32  fields_disabled_mask - taken when >= 4 bytes remain (API >= 1.45)
 *
 * TEN BYTES. The trailing groups are length-guarded by the firmware rather
 * than version-guarded, so writing the full frame is what an API-1.45+
 * board expects and is what the reference configurator sends.
 *
 * THIS BUILDS A PAYLOAD. IT DOES NOT SAVE ANYTHING. Persisting needs a
 * separate MSP_EEPROM_WRITE and, on the reference client, a reboot; none of
 * that belongs to an encoder and none of it happens here. The function is
 * named for what it does for exactly that reason.
 *
 * AND AN ACK IS NOT PROOF THE CONFIG WAS APPLIED. The firmware wraps this
 * whole case in `if (blackboxMayEditConfig())` - true only while
 * blackboxState <= BLACKBOX_STATE_STOPPED - and when it is false the frame
 * is consumed, nothing is written, and an ordinary success reply goes back.
 * Any caller that needs to know the config took effect must read
 * MSP_BLACKBOX_CONFIG back and compare. That readback is B-3's contract,
 * not this module's, but the reason for it is recorded here where the
 * write is built.
 */

/** Byte length of the frame this module emits. */
export const BLACKBOX_CONFIG_WRITE_BYTES = 10;

export interface BlackboxConfigWrite {
  /** Raw device selector. Validated by the semantic layer, not here. */
  readonly deviceRaw: number;
  /** The firmware discards this once pRatio is present; echo what was read. */
  readonly legacyRateNumerator: number;
  /** Same. */
  readonly legacyRateDenominator: number;
  /** u16 LE. */
  readonly pRatio: number;
  /** u8, raw sample-rate selector. */
  readonly sampleRateRaw: number;
  /** u32 LE. A SET BIT DISABLES its field. */
  readonly disabledFieldsMask: number;
}

function assertU8(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError(
      `MSP_SET_BLACKBOX_CONFIG: ${name} must be a u8, received ${value}.`,
    );
  }
  return value;
}

function assertU16(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError(
      `MSP_SET_BLACKBOX_CONFIG: ${name} must be a u16, received ${value}.`,
    );
  }
  return value;
}

function assertU32(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(
      `MSP_SET_BLACKBOX_CONFIG: ${name} must be a u32, received ${value}.`,
    );
  }
  return value;
}

export function encodeBlackboxConfig(write: BlackboxConfigWrite): Uint8Array {
  const device = assertU8('device', write.deviceRaw);
  const rateNumerator = assertU8('rate numerator', write.legacyRateNumerator);
  const rateDenominator = assertU8(
    'rate denominator',
    write.legacyRateDenominator,
  );
  const pRatio = assertU16('pRatio', write.pRatio);
  const sampleRate = assertU8('sample rate', write.sampleRateRaw);
  const mask = assertU32('disabled fields mask', write.disabledFieldsMask);

  const bytes = new Uint8Array(BLACKBOX_CONFIG_WRITE_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, device);
  view.setUint8(1, rateNumerator);
  view.setUint8(2, rateDenominator);
  view.setUint16(3, pRatio, true);
  view.setUint8(5, sampleRate);
  view.setUint32(6, mask, true);
  return bytes;
}
