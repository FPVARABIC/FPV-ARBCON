/**
 * MSP_SENSOR_CONFIG (96) - the CONFIGURED sensor hardware.
 *
 * This command answers "what did somebody tell this board to use". It
 * does not answer "what is fitted", it does not answer "what was found at
 * boot", and it never answers "is it working". Those are three other
 * questions with three other sources, and keeping them apart is the point
 * of the whole sensor layer.
 *
 * THE PAYLOAD, from the API-1.47 serializer at firmware revision
 * 7348054f268f0058574719c134e9f149565bb8ea (src/main/msp/msp.c, case
 * MSP_SENSOR_CONFIG):
 *
 *     byte 0   u8   accelerometerConfig()->acc_hardware
 *     byte 1   u8   barometerConfig()->baro_hardware
 *     byte 2   u8   compassConfig()->mag_hardware
 *     byte 3   u8   rangefinderConfig()->rangefinder_hardware   (API 1.46+)
 *     byte 4   u8   opticalflowConfig()->opticalflow_hardware   (API 1.47+)
 *
 * BYTE 0 IS THE ACCELEROMETER. NEVER THE GYRO.
 *
 * The firmware carries a comment directly above that block reading
 * "use sensorIndex_e index: 0:GyroHardware, 1:AccHardware, 2:BaroHardware,
 * 3:MagHardware, 4:RangefinderHardware 5:OpticalflowHardware". It is
 * wrong. The five `sbufWriteU8` calls underneath it write acc, baro, mag,
 * rangefinder, opticalflow - five values, no gyro - and the matching
 * MSP_SET_SENSOR_CONFIG handler reads them back into the same five
 * fields in the same order. The reference client parses it the same way
 * (MSPHelper.js reads acc_hardware first). Executable code decides; a
 * stale comment does not.
 *
 * The consequence for this decoder is absolute: there is no gyro field on
 * this command, so this module does not invent one. Which gyro the board
 * FOUND is a different command entirely (MSP2_SENSOR_CONFIG_ACTIVE and
 * MSP2_GYRO_SENSOR_ACTIVE); which gyro it was TOLD to use is not
 * expressible over MSP at this revision at all.
 *
 * THREE LEGAL LENGTHS, AND ONE ILLEGAL ONE. The last two bytes were
 * appended over two API releases, so a payload can legitimately be three,
 * four or five bytes long depending on which firmware answered. Anything
 * shorter than three is a truncated frame, not an older board - the first
 * three bytes have been unconditional for the whole life of the command -
 * and is refused rather than padded. Bytes past the fifth are recorded as
 * a count and otherwise ignored, so a future firmware that appends a
 * seventh sensor still decodes here instead of failing, and the fact that
 * something went unread is visible rather than silent.
 *
 * AN ABSENT BYTE IS NOT A ZERO. A three-byte payload does not mean "no
 * rangefinder"; it means the firmware never offered an answer. Writing
 * RANGEFINDER_NONE there would be manufacturing a configuration the board
 * never stated. Those fields are typed absence instead, and the type
 * system makes a caller confront it.
 */

import {MspPayloadReader, MspPayloadReadError} from './MspPayloadReader';
import {
  modelSensorHardware,
  type SensorHardwareValue,
} from './sensorHardwareCatalog';

/**
 * The marker for a field the frame did not carry. Distinct from every
 * hardware value, including NONE: "the board says there is no
 * rangefinder" and "the board did not say" are different facts.
 */
export const NOT_AVAILABLE_IN_THIS_CONTRACT = 'NOT_AVAILABLE_IN_THIS_CONTRACT';
export type NotAvailableInThisContract = typeof NOT_AVAILABLE_IN_THIS_CONTRACT;

/**
 * Which fields a frame carries, named by content rather than by API
 * version. A version number is a claim about a firmware release; a field
 * list is a claim about bytes, and only the second one is something this
 * layer can prove from a payload it is holding.
 */
export type SensorConfigContract =
  | 'ACC_BARO_MAG'
  | 'ACC_BARO_MAG_RANGEFINDER'
  | 'ACC_BARO_MAG_RANGEFINDER_OPTICALFLOW';

export const SENSOR_CONFIG_CONTRACT_BYTES: Readonly<
  Record<SensorConfigContract, number>
> = Object.freeze({
  ACC_BARO_MAG: 3,
  ACC_BARO_MAG_RANGEFINDER: 4,
  ACC_BARO_MAG_RANGEFINDER_OPTICALFLOW: 5,
});

/** Shortest frame that is a frame at all rather than a truncation. */
export const SENSOR_CONFIG_MIN_BYTES = 3;

export interface SensorConfig {
  /** Byte 0. Always present. */
  readonly acc: SensorHardwareValue;
  /** Byte 1. Always present. */
  readonly baro: SensorHardwareValue;
  /** Byte 2. Always present. */
  readonly mag: SensorHardwareValue;
  /** Byte 3, or typed absence on a three-byte frame. */
  readonly rangefinder: SensorHardwareValue | NotAvailableInThisContract;
  /** Byte 4, or typed absence on a three- or four-byte frame. */
  readonly opticalflow: SensorHardwareValue | NotAvailableInThisContract;
  /** Which of the three shapes actually arrived. */
  readonly contract: SensorConfigContract;
  /** Bytes past the fifth that this revision has no field for. Non-zero
   *  means the board knows about something this decoder does not. */
  readonly trailingByteCount: number;
}

export function decodeSensorConfig(payload: Uint8Array): SensorConfig {
  if (payload.length < SENSOR_CONFIG_MIN_BYTES) {
    throw new MspPayloadReadError(
      `MSP_SENSOR_CONFIG needs at least ${SENSOR_CONFIG_MIN_BYTES} bytes ` +
        `(acc, baro, mag); received ${payload.length}.`,
    );
  }
  const reader = new MspPayloadReader(payload);
  const acc = modelSensorHardware('ACC', reader.readU8());
  const baro = modelSensorHardware('BARO', reader.readU8());
  const mag = modelSensorHardware('MAG', reader.readU8());

  const hasRangefinder = reader.remaining() >= 1;
  const rangefinder = hasRangefinder
    ? modelSensorHardware('RANGEFINDER', reader.readU8())
    : NOT_AVAILABLE_IN_THIS_CONTRACT;

  const hasOpticalflow = reader.remaining() >= 1;
  const opticalflow = hasOpticalflow
    ? modelSensorHardware('OPTICALFLOW', reader.readU8())
    : NOT_AVAILABLE_IN_THIS_CONTRACT;

  const contract: SensorConfigContract = hasOpticalflow
    ? 'ACC_BARO_MAG_RANGEFINDER_OPTICALFLOW'
    : hasRangefinder
      ? 'ACC_BARO_MAG_RANGEFINDER'
      : 'ACC_BARO_MAG';

  return Object.freeze({
    acc,
    baro,
    mag,
    rangefinder,
    opticalflow,
    contract,
    trailingByteCount: reader.remaining(),
  });
}
