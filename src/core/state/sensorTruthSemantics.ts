/**
 * THREE ANSWERS TO THREE DIFFERENT QUESTIONS, KEPT APART.
 *
 * A flight controller will tell you three separate things about a sensor,
 * over three separate commands, and they are not versions of one another:
 *
 *   CONFIGURED   MSP_SENSOR_CONFIG (96)
 *                What somebody asked this board to use. A stored setting.
 *                Says nothing about whether the part exists.
 *
 *   DETECTED     MSP2_SENSOR_CONFIG_ACTIVE (0x300A)
 *                What the board found when it booted. A one-off result
 *                from probing an ID register, recorded at startup and
 *                never revisited.
 *
 *   PRESENT      the sensor mask inside MSP_STATUS / MSP_STATUS_EX
 *                Whether the firmware currently counts that subsystem as
 *                available. Recomputed as the board runs.
 *
 * Collapsing them into one field is the single most tempting mistake in
 * this whole area, and every version of it lies. "Configured to BMP280"
 * does not mean a barometer is fitted. "Detected an ICM42688P" does not
 * mean the gyro is producing usable numbers now. A set presence bit does
 * not mean the readings are trustworthy. This module therefore keeps all
 * three, forever, and reports where they disagree instead of picking a
 * winner.
 *
 * ============================================================
 * THERE IS NO HEALTH FIELD HERE, AND THERE WILL NOT BE ONE.
 * ============================================================
 *
 * Nothing in this file returns `healthy`, `ok`, `working`, `good` or any
 * synonym, and nothing computes one privately either. None of the three
 * sources measures whether a sensor is working:
 *
 *   - Configured is a setting somebody typed.
 *   - Detected is an ID register that answered once, at boot, possibly
 *     minutes ago, possibly before the part got warm, possibly before the
 *     wire fell off.
 *   - Present is the firmware's own availability flag, which is set on
 *     successful detection and is not a data-quality measurement.
 *
 * A "healthy" derived from those three would be a guess wearing the
 * clothes of a measurement, and an operator who trusts it arms an
 * aircraft. Whether a sensor is producing sane data is answered by
 * looking at the data - which is a different feature, with a different
 * source, and is not this module's business.
 *
 * WHAT IT DOES INSTEAD. Every family gets all three answers plus a list
 * of CONTRADICTIONS: named, specific disagreements between two sources
 * that both claim to be true. A contradiction is an observation, not a
 * verdict - it says "these two things cannot both be right", never "this
 * sensor is broken" and never "this sensor is fine". An empty list means
 * the three sources agree, which is not the same as working.
 *
 * NONE IS NOT AN ERROR. A magnetometer configured to MAG_NONE on a
 * quadcopter that has no magnetometer is a correctly configured
 * aircraft, not a fault, and it produces zero contradictions here.
 * Treating a deliberate "off" as a problem trains an operator to ignore
 * the one place problems get reported.
 *
 * DEFAULT KEEPS BOTH SIDES. "Detect it for me" plus "an ICM42688P was
 * found" is agreement. The configured answer stays DEFAULT because that
 * is what is stored, the detected answer stays the part that was found,
 * and neither overwrites the other - the setting and the outcome are
 * different facts and a later write needs the setting, not the outcome.
 *
 * TWO FAMILIES HAVE MISSING SOURCES, AND THAT IS SAID OUT LOUD.
 * The gyro has no CONFIGURED byte at all - MSP_SENSOR_CONFIG carries acc,
 * baro, mag, rangefinder and optical flow, and no gyro, at this API
 * revision. GPS has neither a configured nor a detected byte; it appears
 * only in the presence mask. Both are modelled as typed absence rather
 * than as a plausible-looking default, because "the protocol has no field
 * for this" and "the field said zero" are different facts.
 */

import {SENSOR_PRESENCE_TOKENS} from './armingBlockers';
import {
  NOT_AVAILABLE_IN_THIS_CONTRACT,
  type SensorConfig,
} from '../protocol/msp/decoding/decodeSensorConfig';
import {
  SENSOR_NOT_AVAILABLE,
  type DetectedSensor,
  type SensorConfigActive,
} from '../protocol/msp/decoding/decodeSensorConfigActive';
import {
  sensorHardwareDefaultIndex,
  sensorHardwareNoneIndex,
  type SensorHardwareFamily,
  type SensorHardwareValue,
} from '../protocol/msp/decoding/sensorHardwareCatalog';

/** The seven families this app can say anything about. GPS is here
 *  because the presence mask carries it; dropping it would silently
 *  discard a wire fact. */
export type SensorTruthFamily =
  | 'GYRO'
  | 'ACC'
  | 'BARO'
  | 'MAG'
  | 'GPS'
  | 'RANGEFINDER'
  | 'OPTICALFLOW';

export const SENSOR_TRUTH_FAMILIES: readonly SensorTruthFamily[] = Object.freeze(
  ['GYRO', 'ACC', 'BARO', 'MAG', 'GPS', 'RANGEFINDER', 'OPTICALFLOW'] as const,
);

/**
 * Where each family sits in the MSP_STATUS_EX sensor mask.
 *
 * DERIVED, NOT RETYPED. The bit order lives in SENSOR_PRESENCE_TOKENS
 * (armingBlockers.ts), which was checked against the firmware's own
 * packing - `sensors(SENSOR_ACC) | sensors(SENSOR_BARO) << 1 |
 * sensors(SENSOR_MAG) << 2 | sensors(SENSOR_GPS) << 3 |
 * sensors(SENSOR_RANGEFINDER) << 4 | sensors(SENSOR_GYRO) << 5 |
 * sensors(SENSOR_OPTICALFLOW) << 6` - and found correct. Copying those
 * seven numbers into a second table here would create a second thing to
 * keep right; looking them up means one table can never drift from the
 * other.
 *
 * NOTE THAT THIS ORDER IS NOT `sensors_e`. The internal enum is GYRO
 * 1<<0, ACC 1<<1, BARO 1<<2, MAG 1<<3, RANGEFINDER 1<<4, GPS 1<<5. The
 * serializer repacks it before it goes on the wire, so gyro is bit 5 on
 * the wire and bit 0 internally. Reading the wire with the internal enum
 * reports a board's accelerometer state as its gyro state.
 */
const PRESENCE_BIT_INDEX: Readonly<Record<SensorTruthFamily, number>> = (() => {
  const entries = SENSOR_TRUTH_FAMILIES.map(family => {
    const index = SENSOR_PRESENCE_TOKENS.indexOf(family);
    if (index < 0) {
      throw new Error(
        `sensorTruthSemantics: SENSOR_PRESENCE_TOKENS has no entry for ${family}. ` +
          'The wire bit order and the truth families have diverged.',
      );
    }
    return [family, index] as const;
  });
  return Object.freeze(Object.fromEntries(entries)) as Readonly<
    Record<SensorTruthFamily, number>
  >;
})();

/** The bit index a family occupies in the MSP_STATUS_EX sensor mask. */
export function sensorPresenceBitIndex(family: SensorTruthFamily): number {
  return PRESENCE_BIT_INDEX[family];
}

/* ---------------------------------------------------------------- *
 * THE THREE ANSWERS
 * ---------------------------------------------------------------- */

export type SensorConfiguredTruth =
  /** MSP_SENSOR_CONFIG was never read in this session. */
  | {readonly kind: 'NOT_OBSERVED'}
  /** The command carries no byte for this family, or the frame this board
   *  sent was too short to include it. */
  | {readonly kind: 'NOT_AVAILABLE_IN_THIS_CONTRACT'}
  /** The family's DEFAULT index: "go and find one". */
  | {readonly kind: 'DEFAULT'}
  /** The family's NONE index. A deliberate off, not a fault. */
  | {readonly kind: 'DISABLED_BY_CONFIGURATION'}
  /** A specific part was named. `hardware.kind` is KNOWN or UNKNOWN and
   *  UNKNOWN stays UNKNOWN - an index this build cannot name is not
   *  rewritten to DEFAULT or NONE. */
  | {readonly kind: 'PINNED'; readonly hardware: SensorHardwareValue};

export type SensorDetectedTruth =
  /** MSP2_SENSOR_CONFIG_ACTIVE was never read in this session. */
  | {readonly kind: 'NOT_OBSERVED'}
  /** No detected byte exists for this family (GPS). */
  | {readonly kind: 'NOT_AVAILABLE_IN_THIS_CONTRACT'}
  /** 0xFF: the firmware was built without support for this sensor. Not
   *  the same as "supported and nothing found". */
  | {readonly kind: 'NOT_SUPPORTED_BY_FIRMWARE_BUILD'}
  /** The family's own NONE value. Probing ran and found nothing. */
  | {readonly kind: 'NONE_DETECTED'}
  | {readonly kind: 'DETECTED'; readonly hardware: SensorHardwareValue}
  /**
   * The byte modelled as the family's DEFAULT index.
   *
   * The firmware never writes a DEFAULT into `detectedSensors[]` -
   * DEFAULT means "go and look" and by the time that array is filled the
   * looking is finished. So this value cannot come from a working 1.47
   * board, and it is surfaced as itself rather than folded into
   * NONE_DETECTED, because quietly reinterpreting it would erase the
   * evidence that something upstream is wrong.
   */
  | {readonly kind: 'REPORTED_DEFAULT'; readonly hardware: SensorHardwareValue};

export type SensorPresenceTruth =
  /** No MSP_STATUS / MSP_STATUS_EX reading was supplied. */
  | {readonly kind: 'NOT_OBSERVED'}
  | {readonly kind: 'PRESENT'}
  | {readonly kind: 'ABSENT'};

/* ---------------------------------------------------------------- *
 * DISAGREEMENTS
 * ---------------------------------------------------------------- */

/**
 * Two sources that cannot both be right. Each is a statement about the
 * evidence, never about the sensor's condition.
 *
 * CONFIGURED_OFF_BUT_REPORTED_PRESENT
 *   Configured NONE, yet the firmware counts the subsystem as available.
 *
 * CONFIGURED_ON_BUT_NONE_DETECTED
 *   Configured DEFAULT or a named part, yet probing found nothing.
 *
 * DETECTED_BUT_NOT_REPORTED_PRESENT
 *   A part answered at boot, yet the subsystem is not counted available.
 *
 * REPORTED_PRESENT_BUT_FIRMWARE_HAS_NO_SUPPORT
 *   The presence bit is set while the detected byte is 0xFF - the build
 *   claims it cannot have this sensor at all.
 *
 * CONFIGURED_DEVICE_DIFFERS_FROM_DETECTED
 *   A specific part was pinned and a different one was found. Only
 *   raised where configured and detected index the SAME firmware enum -
 *   acc, baro, mag, rangefinder and optical flow all do. The gyro has no
 *   configured byte, so it can never reach this comparison, which
 *   matters because the gyro and accelerometer enums are NOT parallel:
 *   raw 4 is MPU6000 on one list and MPU6500 on the other.
 *
 * DETECTION_REPORTED_A_DEFAULT_VALUE
 *   The detected byte modelled as DEFAULT, which no working 1.47 board
 *   can produce.
 */
export type SensorContradiction =
  | 'CONFIGURED_OFF_BUT_REPORTED_PRESENT'
  | 'CONFIGURED_ON_BUT_NONE_DETECTED'
  | 'DETECTED_BUT_NOT_REPORTED_PRESENT'
  | 'REPORTED_PRESENT_BUT_FIRMWARE_HAS_NO_SUPPORT'
  | 'CONFIGURED_DEVICE_DIFFERS_FROM_DETECTED'
  | 'DETECTION_REPORTED_A_DEFAULT_VALUE';

export interface SensorTruth {
  readonly family: SensorTruthFamily;
  readonly configured: SensorConfiguredTruth;
  readonly detected: SensorDetectedTruth;
  readonly present: SensorPresenceTruth;
  /** Empty means the sources agree. It does not mean the sensor works. */
  readonly contradictions: readonly SensorContradiction[];
}

export type SensorTruthSet = Readonly<Record<SensorTruthFamily, SensorTruth>>;

/** Whatever has actually been read. Every field is optional because a
 *  session legitimately has some of these and not others, and "not read
 *  yet" must never look like "read, and the answer was zero". */
export interface SensorObservation {
  readonly configured?: SensorConfig;
  readonly detected?: SensorConfigActive;
  /** The raw u16 from MSP_STATUS / MSP_STATUS_EX. */
  readonly presenceMask?: number;
}

/* ---------------------------------------------------------------- *
 * DERIVATION
 * ---------------------------------------------------------------- */

/** Which hardware family's enum a truth family reads, or `undefined`
 *  where the family has no hardware byte in either direction. */
const HARDWARE_FAMILY: Readonly<
  Record<SensorTruthFamily, SensorHardwareFamily | undefined>
> = Object.freeze({
  GYRO: 'GYRO',
  ACC: 'ACC',
  BARO: 'BARO',
  MAG: 'MAG',
  GPS: undefined,
  RANGEFINDER: 'RANGEFINDER',
  OPTICALFLOW: 'OPTICALFLOW',
});

const NOT_OBSERVED = Object.freeze({kind: 'NOT_OBSERVED' as const});
const NOT_IN_CONTRACT = Object.freeze({
  kind: 'NOT_AVAILABLE_IN_THIS_CONTRACT' as const,
});

/** The configured byte for a family, or the reason there isn't one.
 *  GYRO and GPS have no configured byte on MSP_SENSOR_CONFIG at all. */
function configuredValueFor(
  family: SensorTruthFamily,
  config: SensorConfig,
): SensorHardwareValue | undefined {
  switch (family) {
    case 'ACC':
      return config.acc;
    case 'BARO':
      return config.baro;
    case 'MAG':
      return config.mag;
    case 'RANGEFINDER':
      return config.rangefinder === NOT_AVAILABLE_IN_THIS_CONTRACT
        ? undefined
        : config.rangefinder;
    case 'OPTICALFLOW':
      return config.opticalflow === NOT_AVAILABLE_IN_THIS_CONTRACT
        ? undefined
        : config.opticalflow;
    case 'GYRO':
    case 'GPS':
      return undefined;
  }
}

function detectedValueFor(
  family: SensorTruthFamily,
  active: SensorConfigActive,
): DetectedSensor | undefined {
  switch (family) {
    case 'GYRO':
      return active.gyro;
    case 'ACC':
      return active.acc;
    case 'BARO':
      return active.baro;
    case 'MAG':
      return active.mag;
    case 'RANGEFINDER':
      return active.rangefinder;
    case 'OPTICALFLOW':
      return active.opticalflow;
    case 'GPS':
      return undefined;
  }
}

function classifyConfigured(
  family: SensorTruthFamily,
  observation: SensorObservation,
): SensorConfiguredTruth {
  if (observation.configured === undefined) {
    return NOT_OBSERVED;
  }
  const hardwareFamily = HARDWARE_FAMILY[family];
  const value = configuredValueFor(family, observation.configured);
  if (hardwareFamily === undefined || value === undefined) {
    return NOT_IN_CONTRACT;
  }
  if (value.raw === sensorHardwareNoneIndex(hardwareFamily)) {
    return Object.freeze({kind: 'DISABLED_BY_CONFIGURATION' as const});
  }
  if (value.raw === sensorHardwareDefaultIndex(hardwareFamily)) {
    return Object.freeze({kind: 'DEFAULT' as const});
  }
  return Object.freeze({kind: 'PINNED' as const, hardware: value});
}

function classifyDetected(
  family: SensorTruthFamily,
  observation: SensorObservation,
): SensorDetectedTruth {
  if (observation.detected === undefined) {
    return NOT_OBSERVED;
  }
  const hardwareFamily = HARDWARE_FAMILY[family];
  const value = detectedValueFor(family, observation.detected);
  if (hardwareFamily === undefined || value === undefined) {
    return NOT_IN_CONTRACT;
  }
  if (value === SENSOR_NOT_AVAILABLE) {
    return Object.freeze({kind: 'NOT_SUPPORTED_BY_FIRMWARE_BUILD' as const});
  }
  if (value.raw === sensorHardwareNoneIndex(hardwareFamily)) {
    return Object.freeze({kind: 'NONE_DETECTED' as const});
  }
  if (value.raw === sensorHardwareDefaultIndex(hardwareFamily)) {
    return Object.freeze({kind: 'REPORTED_DEFAULT' as const, hardware: value});
  }
  return Object.freeze({kind: 'DETECTED' as const, hardware: value});
}

function classifyPresence(
  family: SensorTruthFamily,
  observation: SensorObservation,
): SensorPresenceTruth {
  if (observation.presenceMask === undefined) {
    return NOT_OBSERVED;
  }
  const bit = 1 << PRESENCE_BIT_INDEX[family];
  return (observation.presenceMask & bit) !== 0
    ? Object.freeze({kind: 'PRESENT' as const})
    : Object.freeze({kind: 'ABSENT' as const});
}

function findContradictions(
  configured: SensorConfiguredTruth,
  detected: SensorDetectedTruth,
  present: SensorPresenceTruth,
): readonly SensorContradiction[] {
  const found: SensorContradiction[] = [];

  if (
    configured.kind === 'DISABLED_BY_CONFIGURATION' &&
    present.kind === 'PRESENT'
  ) {
    found.push('CONFIGURED_OFF_BUT_REPORTED_PRESENT');
  }

  if (
    (configured.kind === 'DEFAULT' || configured.kind === 'PINNED') &&
    detected.kind === 'NONE_DETECTED'
  ) {
    found.push('CONFIGURED_ON_BUT_NONE_DETECTED');
  }

  if (detected.kind === 'DETECTED' && present.kind === 'ABSENT') {
    found.push('DETECTED_BUT_NOT_REPORTED_PRESENT');
  }

  if (
    detected.kind === 'NOT_SUPPORTED_BY_FIRMWARE_BUILD' &&
    present.kind === 'PRESENT'
  ) {
    found.push('REPORTED_PRESENT_BUT_FIRMWARE_HAS_NO_SUPPORT');
  }

  if (
    configured.kind === 'PINNED' &&
    detected.kind === 'DETECTED' &&
    configured.hardware.raw !== detected.hardware.raw
  ) {
    found.push('CONFIGURED_DEVICE_DIFFERS_FROM_DETECTED');
  }

  if (detected.kind === 'REPORTED_DEFAULT') {
    found.push('DETECTION_REPORTED_A_DEFAULT_VALUE');
  }

  return Object.freeze(found);
}

export function deriveSensorTruth(family: SensorTruthFamily, observation: SensorObservation): SensorTruth {
  const configured = classifyConfigured(family, observation);
  const detected = classifyDetected(family, observation);
  const present = classifyPresence(family, observation);
  return Object.freeze({
    family,
    configured,
    detected,
    present,
    contradictions: findContradictions(configured, detected, present),
  });
}

export function deriveSensorTruthSet(observation: SensorObservation): SensorTruthSet {
  const entries = SENSOR_TRUTH_FAMILIES.map(
    family => [family, deriveSensorTruth(family, observation)] as const,
  );
  return Object.freeze(Object.fromEntries(entries)) as SensorTruthSet;
}

/** Every family that reported at least one disagreement, in the fixed
 *  family order. A caller that wants to show them gets a stable list; a
 *  caller that wants a count gets a length. Neither is a health score. */
export function sensorsWithContradictions(
  truthSet: SensorTruthSet,
): readonly SensorTruth[] {
  return Object.freeze(
    SENSOR_TRUTH_FAMILIES.map(family => truthSet[family]).filter(
      truth => truth.contradictions.length > 0,
    ),
  );
}
