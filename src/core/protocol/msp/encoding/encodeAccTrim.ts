/**
 * MSP_SET_ACC_TRIM (239) - writing the accelerometer angle trim.
 *
 * Note the opcode: the SET is 239 and the GET is 240. The lower number is
 * the write, which is the opposite of the usual arrangement in this
 * protocol and has caught people out before.
 *
 * THE PAYLOAD, from the firmware handler at revision
 * 7348054f268f0058574719c134e9f149565bb8ea (src/main/msp/msp.c, case
 * MSP_SET_ACC_TRIM):
 *
 *     accelerometerTrims.values.pitch = sbufReadU16(src);
 *     accelerometerTrims.values.roll  = sbufReadU16(src);
 *
 * PITCH FIRST, exactly as on the read, and for the same reason the read
 * documents at length: the struct declares roll first, the wire does not.
 *
 * THE RANGE IS ENFORCED HERE, NOT DISCOVERED LATER. `acc_trim_pitch` and
 * `acc_trim_roll` are both `VAR_INT16 | MASTER_VALUE` with
 * `.config.minmax = { -300, 300 }` (src/main/cli/settings.c). The MSP
 * handler itself does NOT clamp - it assigns whatever two 16-bit values
 * arrive - so a frame carrying 5000 is accepted by the board and stored,
 * and the limit exists only in the CLI's own validation. Refusing it here
 * is the difference between an app that cannot ask for an illegal trim
 * and an app that finds out afterwards.
 *
 * `setInt16` RATHER THAN `setUint16`. Negative trims are the normal case
 * on half the axes; `setInt16` writes the right two's-complement bytes
 * for them and is identical for non-negative values, so one call covers
 * the whole legal range.
 *
 * NO SENDER. Nothing in this pass calls this function.
 */

export const ACC_TRIM_WRITE_BYTES = 4;

/** From `acc_trim_pitch` / `acc_trim_roll` in src/main/cli/settings.c. */
export const ACC_TRIM_LIMIT = 300;

export interface AccTrimWrite {
  readonly pitch: number;
  readonly roll: number;
}

function requireTrim(name: string, value: number): void {
  if (!Number.isInteger(value) || value < -ACC_TRIM_LIMIT || value > ACC_TRIM_LIMIT) {
    throw new RangeError(
      `MSP_SET_ACC_TRIM ${name} must be a whole number within +/-${ACC_TRIM_LIMIT}; ` +
        `received ${String(value)}.`,
    );
  }
}

export function encodeAccTrim(write: AccTrimWrite): Uint8Array {
  requireTrim('pitch', write.pitch);
  requireTrim('roll', write.roll);
  const payload = new Uint8Array(ACC_TRIM_WRITE_BYTES);
  const view = new DataView(payload.buffer);
  view.setInt16(0, write.pitch, true);
  view.setInt16(2, write.roll, true);
  return payload;
}
