/**
 * WHAT A SENSOR HARDWARE BYTE MEANS, PER FAMILY, AT API 1.47.
 *
 * Every sensor byte on the wire - configured (MSP_SENSOR_CONFIG) and
 * detected (MSP2_SENSOR_CONFIG_ACTIVE, MSP2_GYRO_SENSOR_ACTIVE) alike -
 * is an index into ONE OF SIX SEPARATE C ENUMS. They are not variants of
 * a single list, they are six independent lists, and the differences
 * between them are the whole reason this file exists rather than a single
 * shared table.
 *
 * SOURCE. All six tables were transcribed from the firmware headers at
 * the pinned API-1.47 revision 7348054f268f0058574719c134e9f149565bb8ea:
 *
 *   accelerationSensor_e   src/main/sensors/acceleration.h
 *   gyroHardware_e         src/main/drivers/accgyro/accgyro.h
 *   baroSensor_e           src/main/sensors/barometer.h
 *   magSensor_e            src/main/sensors/compass.h
 *   rangefinderType_e      src/main/sensors/rangefinder.h
 *   opticalflowType_e      src/main/sensors/opticalflow.h
 *
 * THREE FACTS THAT A SHARED TABLE WOULD DESTROY
 *
 *  1. THE GYRO LIST PUTS NONE AND DEFAULT THE OTHER WAY ROUND. Every
 *     other family starts `X_DEFAULT = 0, X_NONE = 1`. The gyro list
 *     starts `GYRO_NONE = 0, GYRO_DEFAULT = 1`. A rule of the form
 *     "raw 0 means default" - which is what a single shared table
 *     forces - reports a board with no gyro at all as "using the default
 *     gyro". The `kind` field below is therefore per-entry, never
 *     derived from the index.
 *
 *  2. RANGEFINDER AND OPTICAL FLOW HAVE NO DEFAULT AT ALL. Their zero is
 *     NONE, and the firmware comment beside the rangefinder byte says so
 *     out loud ("no RANGEFINDER_DEFAULT value"). There is nothing to
 *     auto-detect: absent means absent.
 *
 *  3. THE INDICES DIVERGE BETWEEN GYRO AND ACC AFTER 2. gyroHardware_e
 *     carries GYRO_L3GD20 at index 3, which has no accelerometer
 *     counterpart, so every later entry is offset by one relative to
 *     accelerationSensor_e. Raw 4 is MPU6000 on the gyro list and MPU6500
 *     on the accelerometer list. Sharing one table would silently rename
 *     half the parts on every board.
 *
 * A KNOWN DEFECT IN THE REFERENCE CLIENT, RECORDED SO IT IS NOT COPIED.
 * betaflight-configurator's barometer list (src/js/sensor_types.js at the
 * 2026.6.1 tag) is DEFAULT, NONE, BMP085, MS5611, BMP280, LPS, QMP6988,
 * BMP388, DPS310, 2SMPB_02B, VIRTUAL - eleven entries, with VIRTUAL at
 * index 10 - and its API-1.47 fix-up block edits only the gyro and
 * accelerometer lists, never the barometer one. The 1.47 firmware has
 * BARO_LPS22DF = 10 and BARO_VIRTUAL = 11. A board with an LPS22DF
 * therefore reports raw 10 and the reference client names it "VIRTUAL" -
 * it tells the operator the barometer is simulated when a real part is
 * fitted. The table below follows the firmware: 10 is LPS22DF.
 *
 * WHY THE VALUES ARE PINNED AND NOT FUTURE-PROOFED. BARO_VIRTUAL moved
 * from 11 to 13 between this revision and the 1.49 line. An enum index is
 * only meaningful together with the API version that produced it, so
 * these tables carry the revision in their name and an index this
 * revision does not define is modelled as UNKNOWN rather than guessed at.
 *
 * NO DIRECT SOURCE REUSE. The part names are hardware designations -
 * "ICM42688P" is InvenSense's name for a physical chip, not Betaflight's
 * expression of anything - and the ordering is a protocol fact that has
 * to match byte for byte to be correct at all. Nothing here is copied
 * prose or copied code.
 */

/**
 * What an index means, independent of which number it happens to be.
 *
 * DEFAULT  the configuration value meaning "detect it for me". It is a
 *          request, never a detection result.
 * NONE     the family's explicit "no such sensor" value.
 * KNOWN    a specific part this revision defines.
 * UNKNOWN  an index this revision does not define. Never rewritten to
 *          DEFAULT or NONE - a byte we cannot name is a byte we cannot
 *          name, and pretending otherwise is how a newer board gets
 *          reported as having no barometer.
 */
export type SensorHardwareKind = 'DEFAULT' | 'NONE' | 'KNOWN' | 'UNKNOWN';

export interface SensorHardwareValue {
  /** The byte exactly as it arrived. Always present, including for
   *  UNKNOWN, so nothing downstream has to re-read the payload. */
  readonly raw: number;
  /** The firmware's identifier for this index, or `UNKNOWN(<raw>)`. */
  readonly modelled: string;
  readonly kind: SensorHardwareKind;
}

export type SensorHardwareFamily =
  | 'ACC'
  | 'GYRO'
  | 'BARO'
  | 'MAG'
  | 'RANGEFINDER'
  | 'OPTICALFLOW';

/** One family's table: index -> firmware identifier, in firmware order. */
type HardwareTable = readonly string[];

/** accelerationSensor_e - DEFAULT first, then NONE. */
const ACC_TABLE: HardwareTable = [
  'ACC_DEFAULT',
  'ACC_NONE',
  'ACC_MPU6050',
  'ACC_MPU6000',
  'ACC_MPU6500',
  'ACC_MPU9250',
  'ACC_ICM20601',
  'ACC_ICM20602',
  'ACC_ICM20608G',
  'ACC_ICM20649',
  'ACC_ICM20689',
  'ACC_ICM42605',
  'ACC_ICM42688P',
  'ACC_BMI160',
  'ACC_BMI270',
  'ACC_LSM6DSO',
  'ACC_LSM6DSV16X',
  'ACC_IIM42653',
  'ACC_ICM45605',
  'ACC_ICM45686',
  'ACC_ICM40609D',
  'ACC_IIM42652',
  'ACC_VIRTUAL',
];

/** gyroHardware_e - NONE FIRST, then DEFAULT. See fact 1 in the header. */
const GYRO_TABLE: HardwareTable = [
  'GYRO_NONE',
  'GYRO_DEFAULT',
  'GYRO_MPU6050',
  'GYRO_L3GD20',
  'GYRO_MPU6000',
  'GYRO_MPU6500',
  'GYRO_MPU9250',
  'GYRO_ICM20601',
  'GYRO_ICM20602',
  'GYRO_ICM20608G',
  'GYRO_ICM20649',
  'GYRO_ICM20689',
  'GYRO_ICM42605',
  'GYRO_ICM42688P',
  'GYRO_BMI160',
  'GYRO_BMI270',
  'GYRO_LSM6DSO',
  'GYRO_LSM6DSV16X',
  'GYRO_IIM42653',
  'GYRO_ICM45605',
  'GYRO_ICM45686',
  'GYRO_ICM40609D',
  'GYRO_IIM42652',
  'GYRO_VIRTUAL',
];

/** baroSensor_e. Index 10 is LPS22DF at this revision, NOT VIRTUAL. */
const BARO_TABLE: HardwareTable = [
  'BARO_DEFAULT',
  'BARO_NONE',
  'BARO_BMP085',
  'BARO_MS5611',
  'BARO_BMP280',
  'BARO_LPS',
  'BARO_QMP6988',
  'BARO_BMP388',
  'BARO_DPS310',
  'BARO_2SMPB_02B',
  'BARO_LPS22DF',
  'BARO_VIRTUAL',
];

/** magSensor_e. */
const MAG_TABLE: HardwareTable = [
  'MAG_DEFAULT',
  'MAG_NONE',
  'MAG_HMC5883',
  'MAG_AK8975',
  'MAG_AK8963',
  'MAG_QMC5883',
  'MAG_LIS2MDL',
  'MAG_LIS3MDL',
  'MAG_MPU925X_AK8963',
  'MAG_IST8310',
];

/** rangefinderType_e - starts at NONE, has no DEFAULT. */
const RANGEFINDER_TABLE: HardwareTable = [
  'RANGEFINDER_NONE',
  'RANGEFINDER_HCSR04',
  'RANGEFINDER_TFMINI',
  'RANGEFINDER_TF02',
  'RANGEFINDER_MTF01',
  'RANGEFINDER_MTF02',
  'RANGEFINDER_MTF01P',
  'RANGEFINDER_MTF02P',
  'RANGEFINDER_TFNOVA',
];

/** opticalflowType_e - starts at NONE, has no DEFAULT. Two entries at
 *  this revision; the 1.49 line adds OPTICALFLOW_UPT1 = 2, which this
 *  revision does not define and which therefore models as UNKNOWN(2)
 *  rather than being back-ported into a 1.47 table. */
const OPTICALFLOW_TABLE: HardwareTable = ['OPTICALFLOW_NONE', 'OPTICALFLOW_MT'];

/* Frozen at runtime as well as in the type system. The header above
 * claims these tables are the pinned contract; a `readonly` annotation
 * alone is erased at build time and would leave the claim unbacked. */
const TABLES: Readonly<Record<SensorHardwareFamily, HardwareTable>> =
  Object.freeze({
    ACC: Object.freeze(ACC_TABLE),
    GYRO: Object.freeze(GYRO_TABLE),
    BARO: Object.freeze(BARO_TABLE),
    MAG: Object.freeze(MAG_TABLE),
    RANGEFINDER: Object.freeze(RANGEFINDER_TABLE),
    OPTICALFLOW: Object.freeze(OPTICALFLOW_TABLE),
  });

/**
 * The two special indices per family, by name rather than by number.
 *
 * `undefined` for DEFAULT is not an oversight and not a zero: the
 * rangefinder and optical-flow enums genuinely have no auto-detect value,
 * and a caller that asks "which index means default here" deserves the
 * honest answer rather than a plausible one.
 */
interface FamilySpecialIndices {
  readonly none: number;
  readonly default: number | undefined;
}

const SPECIAL_INDICES: Readonly<
  Record<SensorHardwareFamily, FamilySpecialIndices>
> = Object.freeze({
  ACC: {none: 1, default: 0},
  GYRO: {none: 0, default: 1},
  BARO: {none: 1, default: 0},
  MAG: {none: 1, default: 0},
  RANGEFINDER: {none: 0, default: undefined},
  OPTICALFLOW: {none: 0, default: undefined},
});

/** Which index this family uses for "no such sensor". */
export function sensorHardwareNoneIndex(family: SensorHardwareFamily): number {
  return SPECIAL_INDICES[family].none;
}

/** Which index this family uses for "detect it for me", or `undefined`
 *  where the family has no such value at all. */
export function sensorHardwareDefaultIndex(
  family: SensorHardwareFamily,
): number | undefined {
  return SPECIAL_INDICES[family].default;
}

/**
 * A wire byte, modelled. Never throws: an index outside the table is a
 * fact about a newer or stranger board, not a decoding failure, and the
 * raw value survives so a caller can still show or log it.
 */
export function modelSensorHardware(
  family: SensorHardwareFamily,
  raw: number,
): SensorHardwareValue {
  const table = TABLES[family];
  const special = SPECIAL_INDICES[family];
  const name = raw >= 0 && raw < table.length ? table[raw] : undefined;
  if (name === undefined) {
    return Object.freeze({raw, modelled: `UNKNOWN(${raw})`, kind: 'UNKNOWN'});
  }
  const kind: SensorHardwareKind =
    raw === special.none ? 'NONE' : raw === special.default ? 'DEFAULT' : 'KNOWN';
  return Object.freeze({raw, modelled: name, kind});
}

/** Every index this revision defines for a family, for callers that need
 *  to offer a choice. Deliberately a copy: the tables are the pinned
 *  contract and nothing outside this file may edit them. */
export function sensorHardwareIndices(
  family: SensorHardwareFamily,
): readonly number[] {
  return TABLES[family].map((_entry, index) => index);
}
