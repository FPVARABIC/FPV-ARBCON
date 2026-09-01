/**
 * MSP_SENSOR_ALIGNMENT (126) - per-sensor orientation, READ side.
 *
 * Not the board angles. Those are MSP_BOARD_ALIGNMENT_CONFIG (38) and
 * they are whole degrees for the whole flight controller; this command is
 * a rotation ENUM per sensor plus a custom triple for the magnetometer.
 *
 * THE PAYLOAD, from the API-1.47 serializer at firmware revision
 * 7348054f268f0058574719c134e9f149565bb8ea (src/main/msp/msp.c, case
 * MSP_SENSOR_ALIGNMENT). Eleven bytes, unconditionally - the `#if
 * defined(USE_MAG)` branches choose the VALUE written, never whether a
 * byte is written:
 *
 *     byte 0     u8    gyroDeviceConfig(firstEnabledGyro())->alignment
 *     byte 1     u8    the same value again
 *     byte 2     u8    compassConfig()->mag_alignment
 *     byte 3     u8    getGyroDetectedFlags()
 *     byte 4     u8    gyroConfig()->gyro_enabled_bitmask
 *     bytes 5-6  s16   compassConfig()->mag_customAlignment.roll
 *     bytes 7-8  s16   ...pitch
 *     bytes 9-10 s16   ...yaw
 *
 * ==================================================================
 * THE READ AND THE WRITE ARE NOT THE SAME FRAME. BYTE 3 IS THE TRAP.
 * ==================================================================
 *
 * MSP_SET_SENSOR_ALIGNMENT (220) is ten bytes, not eleven, and its byte 3
 * is `gyro_enabled_bitmask` - the field that lives at byte FOUR on the
 * read. The read's byte 3, the detected-gyro flags, has no write
 * counterpart at all; it is a report, not a setting.
 *
 * So the obvious-looking implementation - read the eleven bytes, change
 * one, send them back - writes the DETECTED gyro flags into the ENABLED
 * gyro mask. On a dual-gyro board that had gyro 2 detected but
 * deliberately disabled, that silently switches it back on. On a board
 * where detection and enablement already agree it does nothing visible,
 * which is worse: the defect ships and waits.
 *
 * This is why the two directions live in two modules with two shapes and
 * why `encodeSensorAlignment` takes named fields rather than a decoded
 * snapshot. There is deliberately no `encodeChanged...(snapshot, draft)`
 * convenience here of the kind board alignment has - that shape is only
 * safe when the read and the write agree, and here they do not.
 *
 * WHY BYTE 1 IS KEPT EVEN THOUGH IT DUPLICATES BYTE 0. The firmware
 * writes the gyro alignment twice, with a comment that acc and gyro
 * alignment have been the same since 4.0. That is a statement about
 * today's firmware, not about the protocol: the byte exists, a board
 * could answer differently, and a decoder that dropped it would be
 * asserting a firmware implementation detail as a wire fact. It is
 * preserved, and whether the two agree is left visible rather than
 * assumed.
 *
 * THE CUSTOM ANGLES ARE SIGNED. The firmware writes them with
 * `sbufWriteU16`, but that is only the name of the byte-writing
 * primitive. The stored type is `sensorAlignment_t`, declared
 * `int16_t raw[XYZ_AXIS_COUNT]` with the comment "values are in
 * DECIDEGREES, and should be limited to +/- 3600"
 * (src/main/common/sensor_alignment.h). The reference client agrees, and
 * reads them with a signed `data.read16()`. Read unsigned, a mag rotated
 * -90 degrees would come back as 6193.6 degrees.
 *
 * DECIDEGREES STAY DECIDEGREES. The reference client divides by ten at
 * the parser and carries floats from there. This decoder does not: the
 * wire unit is a tenth of a degree and an integer, and converting inside
 * a decoder both loses the wire value and invites a float back into a
 * frame on the way out. Presentation can divide; the wire model does not.
 *
 * ELEVEN BYTES OR NOTHING. Below API 1.47 this command answered with
 * seven bytes in which byte 4 was `gyro_to_use` rather than
 * `gyro_enabled_bitmask` - a different field with different values. This
 * app's floor is API 1.47, and a short frame is refused rather than
 * partially decoded, because the one thing that must never happen is
 * reading a gyro-selection index as a gyro-enable bitmask.
 */

import {MspPayloadReader, MspPayloadReadError} from './MspPayloadReader';

/** The full API-1.47 read frame. Not a minimum - see the header. */
export const SENSOR_ALIGNMENT_PAYLOAD_BYTES = 11;

/**
 * `sensor_align_e` at the pinned revision
 * (src/main/common/sensor_alignment.h).
 *
 * CUSTOM is its own kind rather than a KNOWN rotation because it changes
 * what the rest of the frame means: it is the only value under which the
 * custom roll/pitch/yaw triple is the actual orientation.
 */
export type SensorAlignmentKind = 'DEFAULT' | 'ROTATION' | 'CUSTOM' | 'UNKNOWN';

export interface SensorAlignmentValue {
  readonly raw: number;
  readonly modelled: string;
  readonly kind: SensorAlignmentKind;
}

const ALIGNMENT_NAMES: readonly string[] = Object.freeze([
  'ALIGN_DEFAULT',
  'CW0_DEG',
  'CW90_DEG',
  'CW180_DEG',
  'CW270_DEG',
  'CW0_DEG_FLIP',
  'CW90_DEG_FLIP',
  'CW180_DEG_FLIP',
  'CW270_DEG_FLIP',
  'ALIGN_CUSTOM',
]);

export const ALIGN_DEFAULT_RAW = 0;
export const ALIGN_CUSTOM_RAW = 9;

/** Never throws. An index this revision does not define is a fact about
 *  the board, not a decode failure, and the raw byte survives. */
export function modelSensorAlignment(raw: number): SensorAlignmentValue {
  const name = raw >= 0 && raw < ALIGNMENT_NAMES.length ? ALIGNMENT_NAMES[raw] : undefined;
  if (name === undefined) {
    return Object.freeze({raw, modelled: `UNKNOWN(${raw})`, kind: 'UNKNOWN'});
  }
  const kind: SensorAlignmentKind =
    raw === ALIGN_DEFAULT_RAW
      ? 'DEFAULT'
      : raw === ALIGN_CUSTOM_RAW
        ? 'CUSTOM'
        : 'ROTATION';
  return Object.freeze({raw, modelled: name, kind});
}

/** Tenths of a degree, signed, exactly as the wire carries them. */
export interface CustomAlignmentDecidegrees {
  readonly rollDecidegrees: number;
  readonly pitchDecidegrees: number;
  readonly yawDecidegrees: number;
}

export interface SensorAlignment {
  /** Byte 0. The alignment of the first ENABLED gyro, not of gyro 1. */
  readonly gyro: SensorAlignmentValue;
  /**
   * Byte 1. The firmware currently copies byte 0 here; that is preserved
   * as its own field rather than collapsed, so `accMirrorsGyro` below is
   * something this decoder measured rather than something it assumed.
   */
  readonly acc: SensorAlignmentValue;
  /** Byte 2. Zero on a build without magnetometer support, which reads as
   *  ALIGN_DEFAULT - a reminder that this byte alone cannot tell you
   *  whether a magnetometer exists. */
  readonly mag: SensorAlignmentValue;
  /**
   * Byte 3. Bitmask of gyro device indices that were DETECTED at boot,
   * `GYRO_MASK(i) == 1 << i` (src/main/sensors/gyro.h). A report only.
   *
   * There is no "dual gyro" flag at this revision. The reference client
   * still carries a `DETECTED_DUAL_GYROS: 1 << 7` constant from an older
   * encoding; the 1.47 firmware never sets bit 7, and inventing meaning
   * for it here would invent a sensor.
   */
  readonly gyroDetectedFlagsRaw: number;
  /** Byte 4. Bitmask of gyro device indices the operator has ENABLED. A
   *  setting, and the one field of this frame that byte 3 of a WRITE
   *  corresponds to. */
  readonly gyroEnabledBitmaskRaw: number;
  /** Bytes 5-10. Only the orientation when `mag.kind` is CUSTOM; stored
   *  regardless, because the board stores them regardless. */
  readonly magCustom: CustomAlignmentDecidegrees;
  /** Whether bytes 0 and 1 actually matched on this frame. */
  readonly accMirrorsGyro: boolean;
}

export function decodeSensorAlignment(payload: Uint8Array): SensorAlignment {
  if (payload.length < SENSOR_ALIGNMENT_PAYLOAD_BYTES) {
    throw new MspPayloadReadError(
      `MSP_SENSOR_ALIGNMENT needs ${SENSOR_ALIGNMENT_PAYLOAD_BYTES} bytes at API 1.47; ` +
        `received ${payload.length}. A shorter frame is a pre-1.47 layout whose byte 4 is ` +
        `gyro_to_use rather than gyro_enabled_bitmask and must not be read as this one.`,
    );
  }
  const reader = new MspPayloadReader(payload);
  const gyro = modelSensorAlignment(reader.readU8());
  const acc = modelSensorAlignment(reader.readU8());
  const mag = modelSensorAlignment(reader.readU8());
  const gyroDetectedFlagsRaw = reader.readU8();
  const gyroEnabledBitmaskRaw = reader.readU8();
  const magCustom: CustomAlignmentDecidegrees = Object.freeze({
    rollDecidegrees: reader.readS16LE(),
    pitchDecidegrees: reader.readS16LE(),
    yawDecidegrees: reader.readS16LE(),
  });
  return Object.freeze({
    gyro,
    acc,
    mag,
    gyroDetectedFlagsRaw,
    gyroEnabledBitmaskRaw,
    magCustom,
    accMirrorsGyro: gyro.raw === acc.raw,
  });
}

/** The gyro device indices a detected-flags or enabled-bitmask byte
 *  names, low bit first. Shared by both bytes because they are the same
 *  encoding; what they MEAN is what differs, and that stays in the field
 *  names above. */
export function gyroIndicesFromBitmask(bitmask: number): readonly number[] {
  const indices: number[] = [];
  for (let index = 0; index < 8; index++) {
    if ((bitmask & (1 << index)) !== 0) {
      indices.push(index);
    }
  }
  return Object.freeze(indices);
}
