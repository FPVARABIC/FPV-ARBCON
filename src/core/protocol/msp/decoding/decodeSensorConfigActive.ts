/**
 * MSP2_SENSOR_CONFIG_ACTIVE (0x300A) - the DETECTED sensor hardware.
 *
 * A different question from MSP_SENSOR_CONFIG (96). That one reports what
 * somebody asked for; this one reports what the board found when it
 * booted. They disagree routinely and legitimately - "detect it for me"
 * against "an ICM42688P was found" is agreement, not conflict - and
 * merging them is a job for the semantic layer, never for a decoder.
 *
 * THE PAYLOAD, from the API-1.47 serializer at firmware revision
 * 7348054f268f0058574719c134e9f149565bb8ea (src/main/msp/msp.c, case
 * MSP2_SENSOR_CONFIG_ACTIVE). Six bytes, in `sensorIndex_e` order - and
 * note that this order is NOT the order of MSP_SENSOR_CONFIG, which has
 * no gyro byte at all:
 *
 *     byte 0   u8   detectedSensors[SENSOR_INDEX_GYRO]
 *     byte 1   u8   detectedSensors[SENSOR_INDEX_ACC]
 *     byte 2   u8   detectedSensors[SENSOR_INDEX_BARO]
 *     byte 3   u8   detectedSensors[SENSOR_INDEX_MAG]
 *     byte 4   u8   detectedSensors[SENSOR_INDEX_RANGEFINDER]
 *     byte 5   u8   detectedSensors[SENSOR_INDEX_OPTICALFLOW]
 *
 * 0xFF IS NOT A SENSOR. The handler wraps each write in an `#ifdef` and
 * substitutes `SENSOR_NOT_AVAILABLE`, defined right there as 0xFF, when
 * the firmware was COMPILED WITHOUT that sensor. That is a statement
 * about the build, not about the aircraft: "this firmware cannot have a
 * barometer" is a different fact from "this firmware supports barometers
 * and did not find one", and only the first one is 0xFF.
 *
 * WHAT "NOTHING FOUND" ACTUALLY LOOKS LIKE, and why it is not uniform.
 * `detectedSensors[]` is initialised to each family's own NONE constant
 * (src/main/sensors/initialisation.c):
 *
 *     { GYRO_NONE, ACC_NONE, BARO_NONE, MAG_NONE,
 *       RANGEFINDER_NONE, OPTICALFLOW_NONE }
 *
 * GYRO_NONE, RANGEFINDER_NONE and OPTICALFLOW_NONE are 0. ACC_NONE,
 * BARO_NONE and MAG_NONE are 1. So the byte meaning "nothing was found"
 * is 0 on three of these fields and 1 on the other three, and a decoder
 * that applied one rule to all six would report half of a bare board as
 * fitted. The per-family tables in sensorHardwareCatalog.ts exist for
 * precisely this.
 *
 * A DETECTION RESULT IS NEVER "DEFAULT". Nothing in the firmware ever
 * writes a `_DEFAULT` index into `detectedSensors[]` - DEFAULT is a
 * request to go and look, and by the time this array is filled the
 * looking is over. A byte that models as DEFAULT here is therefore a
 * contradiction rather than a reading, and this decoder reports it
 * faithfully and lets the semantic layer name it. Silently rewriting it
 * to NONE would erase evidence of a firmware or transport fault.
 *
 * NO HEALTH. A detected part is a part that answered its ID register
 * once, at boot. It is not a part that is producing usable data now.
 * Nothing in this module returns, computes or implies "healthy".
 *
 * SIX BYTES EXACTLY, at minimum. The handler emits all six
 * unconditionally at this revision. Anything shorter is a truncation.
 * Anything longer is a firmware that knows about a seventh sensor
 * family, which is recorded as a count rather than dropped.
 */

import {MspPayloadReader, MspPayloadReadError} from './MspPayloadReader';
import {
  modelSensorHardware,
  type SensorHardwareFamily,
  type SensorHardwareValue,
} from './sensorHardwareCatalog';

/**
 * `#define SENSOR_NOT_AVAILABLE 0xFF`, declared inside the handler
 * itself. Means the firmware has no support for this sensor compiled in.
 */
export const SENSOR_NOT_AVAILABLE = 'SENSOR_NOT_AVAILABLE';
export type SensorNotAvailable = typeof SENSOR_NOT_AVAILABLE;

export const SENSOR_NOT_AVAILABLE_RAW = 0xff;

export const SENSOR_CONFIG_ACTIVE_BYTES = 6;

/** Either what was found, or the fact that this build cannot look. */
export type DetectedSensor = SensorHardwareValue | SensorNotAvailable;

export interface SensorConfigActive {
  readonly gyro: DetectedSensor;
  readonly acc: DetectedSensor;
  readonly baro: DetectedSensor;
  readonly mag: DetectedSensor;
  readonly rangefinder: DetectedSensor;
  readonly opticalflow: DetectedSensor;
  /** Bytes past the sixth. Non-zero means the board reports a sensor
   *  family this revision does not define. */
  readonly trailingByteCount: number;
}

function detected(
  family: SensorHardwareFamily,
  raw: number,
): DetectedSensor {
  return raw === SENSOR_NOT_AVAILABLE_RAW
    ? SENSOR_NOT_AVAILABLE
    : modelSensorHardware(family, raw);
}

export function decodeSensorConfigActive(
  payload: Uint8Array,
): SensorConfigActive {
  if (payload.length < SENSOR_CONFIG_ACTIVE_BYTES) {
    throw new MspPayloadReadError(
      `MSP2_SENSOR_CONFIG_ACTIVE needs ${SENSOR_CONFIG_ACTIVE_BYTES} bytes ` +
        `(gyro, acc, baro, mag, rangefinder, opticalflow); received ${payload.length}.`,
    );
  }
  const reader = new MspPayloadReader(payload);
  const gyro = detected('GYRO', reader.readU8());
  const acc = detected('ACC', reader.readU8());
  const baro = detected('BARO', reader.readU8());
  const mag = detected('MAG', reader.readU8());
  const rangefinder = detected('RANGEFINDER', reader.readU8());
  const opticalflow = detected('OPTICALFLOW', reader.readU8());
  return Object.freeze({
    gyro,
    acc,
    baro,
    mag,
    rangefinder,
    opticalflow,
    trailingByteCount: reader.remaining(),
  });
}
