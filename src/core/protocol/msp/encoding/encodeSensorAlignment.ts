/**
 * MSP_SET_SENSOR_ALIGNMENT (220) - per-sensor orientation, WRITE side.
 *
 * A DIFFERENT SHAPE FROM THE READ. Ten bytes against the read's eleven,
 * and one field in a different place. From the firmware handler at
 * revision 7348054f268f0058574719c134e9f149565bb8ea (src/main/msp/msp.c,
 * case MSP_SET_SENSOR_ALIGNMENT):
 *
 *     sbufReadU8(src);                                  // byte 0 - read, discarded
 *     sbufReadU8(src);                                  // byte 1 - discarded deprecated acc_align
 *     mag_alignment          = sbufReadU8(src);         // byte 2
 *     gyro_enabled_bitmask   = sbufReadU8(src);         // byte 3
 *     if (sbufBytesRemaining(src) >= 6) {               // bytes 4-9, all six or none
 *         mag_customAlignment.roll  = sbufReadU16(src);
 *         mag_customAlignment.pitch = sbufReadU16(src);
 *         mag_customAlignment.yaw   = sbufReadU16(src);
 *     }
 *
 * THE ONE THING THAT MAKES THIS DANGEROUS. On the READ, byte 3 is
 * `getGyroDetectedFlags()` and byte 4 is `gyro_enabled_bitmask`. On the
 * WRITE, byte 3 IS the enabled bitmask. Feeding a read payload back as a
 * write therefore stores the DETECTED flags into the ENABLED mask and
 * drops the intended value on the floor. On a dual-gyro board configured
 * to run one gyro, that re-enables the other one.
 *
 * The defence is structural, not a comment: this function takes named
 * arguments and has no overload that accepts a decoded read. There is
 * nothing to pass it that could carry the mistake in.
 *
 * BYTES 0 AND 1 ARE DISCARDED BY THE FIRMWARE, and this encoder writes
 * zeros into them. It would be equally valid to echo the board's current
 * gyro alignment - the reference client does exactly that - but zero is
 * the more honest filler: the firmware reads these bytes and throws them
 * away, so any value here is decoration, and a decorative value that
 * looks like a setting is how somebody later concludes this command can
 * change gyro alignment. It cannot. Gyro alignment is not writable over
 * MSP at this revision; only the magnetometer's is.
 *
 * ALL SIX CUSTOM BYTES OR NONE. The firmware's guard is
 * `>= 6`, so a frame carrying four of them leaves all three angles
 * untouched rather than two of them updated. This encoder mirrors that:
 * the custom triple is one optional argument, whole.
 *
 * SIGNED, AND IN DECIDEGREES. `sensorAlignment_t` is `int16_t` and the
 * header says the values "should be limited to +/- 3600"
 * (src/main/common/sensor_alignment.h), so negative angles are ordinary
 * and out-of-range ones are refused here rather than wrapped into a frame.
 *
 * NO SENDER. A constant and an encoder are not a write path; nothing in
 * this pass calls this function.
 */

const U8_MAX = 0xff;

/** From `sensorAlignment_t`: decidegrees, limited to +/- 3600. */
export const CUSTOM_ALIGNMENT_DECIDEGREE_LIMIT = 3600;

export const SENSOR_ALIGNMENT_WRITE_BASE_BYTES = 4;
export const SENSOR_ALIGNMENT_WRITE_FULL_BYTES = 10;

export interface SensorAlignmentWrite {
  /** Byte 2. A `sensor_align_e` index. */
  readonly magAlignmentRaw: number;
  /**
   * Byte 3. The gyro devices to ENABLE - never the detected flags the
   * read reports at this offset. The name is long on purpose.
   */
  readonly gyroEnabledBitmaskRaw: number;
  /** Bytes 4-9. Omit to leave the board's stored angles untouched. */
  readonly magCustomDecidegrees?: {
    readonly rollDecidegrees: number;
    readonly pitchDecidegrees: number;
    readonly yawDecidegrees: number;
  };
}

function requireByte(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > U8_MAX) {
    throw new RangeError(
      `MSP_SET_SENSOR_ALIGNMENT ${name} must be an integer in 0..${U8_MAX}; received ${String(value)}.`,
    );
  }
}

function requireDecidegrees(name: string, value: number): void {
  if (
    !Number.isInteger(value) ||
    value < -CUSTOM_ALIGNMENT_DECIDEGREE_LIMIT ||
    value > CUSTOM_ALIGNMENT_DECIDEGREE_LIMIT
  ) {
    throw new RangeError(
      `MSP_SET_SENSOR_ALIGNMENT ${name} must be a whole number of decidegrees within ` +
        `+/-${CUSTOM_ALIGNMENT_DECIDEGREE_LIMIT}; received ${String(value)}.`,
    );
  }
}

export function encodeSensorAlignment(write: SensorAlignmentWrite): Uint8Array {
  requireByte('magAlignmentRaw', write.magAlignmentRaw);
  requireByte('gyroEnabledBitmaskRaw', write.gyroEnabledBitmaskRaw);

  const custom = write.magCustomDecidegrees;
  if (custom !== undefined) {
    requireDecidegrees('magCustom roll', custom.rollDecidegrees);
    requireDecidegrees('magCustom pitch', custom.pitchDecidegrees);
    requireDecidegrees('magCustom yaw', custom.yawDecidegrees);
  }

  const length =
    custom === undefined
      ? SENSOR_ALIGNMENT_WRITE_BASE_BYTES
      : SENSOR_ALIGNMENT_WRITE_FULL_BYTES;
  const payload = new Uint8Array(length);
  const view = new DataView(payload.buffer);

  // Bytes 0 and 1: read and discarded by the firmware. See the header.
  payload[0] = 0;
  payload[1] = 0;
  payload[2] = write.magAlignmentRaw;
  payload[3] = write.gyroEnabledBitmaskRaw;
  if (custom !== undefined) {
    view.setInt16(4, custom.rollDecidegrees, true);
    view.setInt16(6, custom.pitchDecidegrees, true);
    view.setInt16(8, custom.yawDecidegrees, true);
  }
  return payload;
}
