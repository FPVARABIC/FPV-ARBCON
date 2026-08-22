/**
 * HOW SENSOR TRUTH IS SAID, WITHOUT SAYING IT IN ANY ONE LANGUAGE.
 *
 * Every function here returns an i18n KEY (and its parameters), never a
 * sentence. Arabic lives in the locale file; this module decides WHICH
 * sentence is true, which is a different job and a testable one.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE. B-2 keeps configured,
 * detected and present apart; a presentation layer is exactly where they
 * get quietly merged back together, because one badge is easier to draw
 * than three facts. So each of the three has its own describe function,
 * none of them can see the other two, and the only thing that reads all
 * three is the contradiction list - which reports a DISAGREEMENT, never a
 * verdict.
 *
 * THERE IS NO HEALTH VOCABULARY HERE. No key contains healthy, ok,
 * working, good, fault or broken, and a test refuses one that does. None
 * of the three sources measures whether a sensor works: configured is a
 * setting somebody typed, detected is an ID register that answered once
 * at boot, present is the firmware's availability flag. A badge that said
 * "sensor OK" would be a guess wearing the clothes of a measurement.
 */

import {
  modelSensorHardware,
  sensorHardwareDefaultIndex,
  sensorHardwareIndices,
  sensorHardwareNoneIndex,
  type SensorHardwareFamily,
  type SensorHardwareValue,
} from '../protocol/msp/decoding/sensorHardwareCatalog';
import type {SensorConfigContract} from '../protocol/msp/decoding/decodeSensorConfig';
import type {
  SensorContradiction,
  SensorTruth,
  SensorTruthFamily,
} from './sensorTruthSemantics';

const NS = 'sensorsScreen';

/** A key plus whatever it interpolates. Keeps every caller from having to
 *  remember which strings take parameters. */
export interface SensorPhrase {
  readonly key: string;
  readonly params?: Readonly<Record<string, string | number>>;
}

const phrase = (key: string, params?: Record<string, string | number>): SensorPhrase =>
  Object.freeze(params === undefined ? {key} : {key, params});

/* ================================================================== *
 * FAMILIES
 * ================================================================== */

/** The families a screen can show, in the order it shows them. Gyro and
 *  accelerometer first because they are the two a quadcopter cannot fly
 *  without. */
export const SENSOR_DISPLAY_ORDER: readonly SensorTruthFamily[] = Object.freeze([
  'GYRO',
  'ACC',
  'BARO',
  'MAG',
  'GPS',
  'RANGEFINDER',
  'OPTICALFLOW',
] as const);

export function sensorFamilyLabelKey(family: SensorTruthFamily): string {
  return `${NS}.family.${family}`;
}

/* ================================================================== *
 * HARDWARE NAMES
 * ================================================================== */

/**
 * The part name an operator recognises, from the firmware identifier.
 *
 * `ACC_ICM42688P` is InvenSense's part number with Betaflight's family
 * prefix bolted on. The prefix is redundant beside a row already labelled
 * "accelerometer", so it comes off - but ONLY the prefix, and only when
 * it is the family's own. Nothing else about the identifier is touched,
 * because it is a part number and a part number that has been prettified
 * is a part number nobody can search for.
 */
export function hardwareDisplayName(
  family: SensorHardwareFamily,
  value: SensorHardwareValue,
): SensorPhrase {
  if (value.kind === 'UNKNOWN') {
    return phrase(`${NS}.hardware.unknown`, {raw: value.raw});
  }
  if (value.kind === 'DEFAULT') {
    return phrase(`${NS}.hardware.default`);
  }
  if (value.kind === 'NONE') {
    return phrase(`${NS}.hardware.none`);
  }
  const prefix = `${family}_`;
  const name = value.modelled.startsWith(prefix)
    ? value.modelled.slice(prefix.length)
    : value.modelled;
  return phrase(`${NS}.hardware.part`, {name});
}

/* ================================================================== *
 * THE THREE ANSWERS, SEPARATELY
 * ================================================================== */

/**
 * GPS is a truth family with no hardware enum: it appears only in the
 * presence mask. Reaching for a part name there would be reaching for a
 * table that does not exist, so it is answered rather than cast away.
 */
function hardwareOf(
  family: SensorTruthFamily,
  value: SensorHardwareValue,
): SensorPhrase {
  return family === 'GPS'
    ? phrase(`${NS}.hardware.unnamed`)
    : hardwareDisplayName(family, value);
}

export function describeConfigured(truth: SensorTruth): SensorPhrase {
  switch (truth.configured.kind) {
    case 'NOT_OBSERVED':
      return phrase(`${NS}.configured.notRead`);
    case 'NOT_AVAILABLE_IN_THIS_CONTRACT':
      return phrase(`${NS}.configured.notInProtocol`);
    case 'DEFAULT':
      return phrase(`${NS}.configured.default`);
    case 'DISABLED_BY_CONFIGURATION':
      return phrase(`${NS}.configured.disabled`);
    case 'PINNED':
      return hardwareOf(truth.family, truth.configured.hardware);
  }
}

export function describeDetected(truth: SensorTruth): SensorPhrase {
  switch (truth.detected.kind) {
    case 'NOT_OBSERVED':
      return phrase(`${NS}.detected.notRead`);
    case 'NOT_AVAILABLE_IN_THIS_CONTRACT':
      return phrase(`${NS}.detected.notInProtocol`);
    case 'NOT_SUPPORTED_BY_FIRMWARE_BUILD':
      return phrase(`${NS}.detected.notInFirmware`);
    case 'NONE_DETECTED':
      return phrase(`${NS}.detected.none`);
    case 'DETECTED':
      return hardwareOf(truth.family, truth.detected.hardware);
    case 'REPORTED_DEFAULT':
      return phrase(`${NS}.detected.reportedDefault`);
  }
}

export function describePresent(truth: SensorTruth): SensorPhrase {
  switch (truth.present.kind) {
    case 'NOT_OBSERVED':
      return phrase(`${NS}.present.notRead`);
    case 'PRESENT':
      return phrase(`${NS}.present.yes`);
    case 'ABSENT':
      return phrase(`${NS}.present.no`);
  }
}

/**
 * THE ONE LINE A ROW LEADS WITH, and the only place the three answers are
 * allowed near each other.
 *
 * It still does not merge them: it picks WHICH of the three is the most
 * useful opening sentence for this particular combination, and the other
 * two stay visible underneath. The choice is deliberate rather than a
 * priority list - a sensor the operator switched off should say so
 * instead of reporting an absence that looks like a fault, and a sensor
 * the firmware counts as present but cannot name is a different sentence
 * again from one it never found.
 */
export function describeHeadline(truth: SensorTruth): SensorPhrase {
  if (truth.configured.kind === 'DISABLED_BY_CONFIGURATION') {
    return phrase(`${NS}.headline.disabled`);
  }
  if (
    truth.present.kind === 'PRESENT' &&
    (truth.detected.kind === 'NOT_SUPPORTED_BY_FIRMWARE_BUILD' ||
      truth.detected.kind === 'NOT_OBSERVED' ||
      truth.detected.kind === 'NOT_AVAILABLE_IN_THIS_CONTRACT' ||
      (truth.detected.kind === 'DETECTED' &&
        truth.detected.hardware.kind === 'UNKNOWN'))
  ) {
    return phrase(`${NS}.headline.presentUnknownHardware`);
  }
  if (truth.present.kind === 'PRESENT') {
    return phrase(`${NS}.headline.present`);
  }
  if (truth.detected.kind === 'DETECTED') {
    return phrase(`${NS}.headline.detectedNotPresent`);
  }
  if (truth.present.kind === 'ABSENT') {
    return phrase(`${NS}.headline.absent`);
  }
  return phrase(`${NS}.headline.notRead`);
}

/* ================================================================== *
 * DISAGREEMENTS
 * ================================================================== */

export function describeContradiction(
  contradiction: SensorContradiction,
): SensorPhrase {
  return phrase(`${NS}.contradiction.${contradiction}`);
}

/**
 * The two values a mismatch is between, so the screen can print
 * "stored: A / found: B" rather than an adjective.
 */
export function describeMismatchPair(
  truth: SensorTruth,
): {readonly stored: SensorPhrase; readonly found: SensorPhrase} | undefined {
  if (
    truth.configured.kind !== 'PINNED' ||
    truth.detected.kind !== 'DETECTED'
  ) {
    return undefined;
  }
  return Object.freeze({
    stored: hardwareOf(truth.family, truth.configured.hardware),
    found: hardwareOf(truth.family, truth.detected.hardware),
  });
}

/* ================================================================== *
 * WHAT IS WORTH DRAWING AT ALL
 * ================================================================== */

/**
 * Whether a family deserves a row on this board.
 *
 * A quadcopter with no rangefinder should not get a rangefinder card full
 * of dashes; that is noise pretending to be information. But
 * "configured for something and not found" is exactly the diagnostic the
 * screen exists to surface, so it stays visible - the rule is about
 * emptiness, not about absence.
 */
export function sensorRowVisible(truth: SensorTruth): boolean {
  if (truth.present.kind === 'PRESENT') return true;
  if (truth.detected.kind === 'DETECTED') return true;
  if (truth.detected.kind === 'REPORTED_DEFAULT') return true;
  if (truth.contradictions.length > 0) return true;
  // Configured to something specific, or explicitly switched off: both are
  // statements somebody made and both are worth showing.
  if (truth.configured.kind === 'PINNED') return true;
  if (truth.configured.kind === 'DISABLED_BY_CONFIGURATION') return true;
  // Gyro and accelerometer are always shown: a quadcopter that reports
  // neither is the single most important thing on the screen, and hiding
  // the row would hide the problem.
  return truth.family === 'GYRO' || truth.family === 'ACC';
}

/* ================================================================== *
 * HARDWARE SELECTORS
 * ================================================================== */

/** Which families the board's OWN frame width makes editable. Never
 *  inferred from an API version - the contract came off the wire. */
export function editableHardwareFamilies(
  contract: SensorConfigContract,
): readonly SensorHardwareFamily[] {
  switch (contract) {
    case 'ACC_BARO_MAG':
      return Object.freeze(['ACC', 'BARO', 'MAG'] as const);
    case 'ACC_BARO_MAG_RANGEFINDER':
      return Object.freeze(['ACC', 'BARO', 'MAG', 'RANGEFINDER'] as const);
    case 'ACC_BARO_MAG_RANGEFINDER_OPTICALFLOW':
      return Object.freeze([
        'ACC',
        'BARO',
        'MAG',
        'RANGEFINDER',
        'OPTICALFLOW',
      ] as const);
  }
}

export interface SensorHardwareOption {
  readonly raw: number;
  readonly label: SensorPhrase;
  /** True for the value the board currently holds. */
  readonly current: boolean;
}

/**
 * The choices a selector offers.
 *
 * Every index this revision defines, plus the board's own value when that
 * is one we cannot name. An unknown index is OFFERED ONLY when the board
 * already holds it: keeping a value we cannot describe is preservation,
 * choosing one would be asking a flight controller for something we
 * cannot check.
 */
export function hardwareOptions(
  family: SensorHardwareFamily,
  currentRaw: number,
): readonly SensorHardwareOption[] {
  const options = sensorHardwareIndices(family).map(raw =>
    Object.freeze({
      raw,
      label: hardwareDisplayName(family, modelSensorHardware(family, raw)),
      current: raw === currentRaw,
    }),
  );
  if (!options.some(option => option.current)) {
    options.push(
      Object.freeze({
        raw: currentRaw,
        label: hardwareDisplayName(family, modelSensorHardware(family, currentRaw)),
        current: true,
      }),
    );
  }
  return Object.freeze(options);
}

/** Named so a screen never has to hard-code either index. */
export function hardwareSpecialIndices(family: SensorHardwareFamily): {
  readonly none: number;
  readonly default: number | undefined;
} {
  return Object.freeze({
    none: sensorHardwareNoneIndex(family),
    default: sensorHardwareDefaultIndex(family),
  });
}

/* ================================================================== *
 * MAGNETIC DECLINATION
 * ================================================================== */

/** From PARAM_NAME_IMU_MAG_DECLINATION: +/-300 decidegrees. */
export const DECLINATION_DECIDEGREE_LIMIT = 300;
export const DECLINATION_DEGREE_LIMIT = DECLINATION_DECIDEGREE_LIMIT / 10;

/**
 * Tenths of a degree to the degrees a person reads.
 *
 * The wire value stays an integer everywhere else in this codebase; this
 * is the one place it becomes a decimal, and it happens at the last
 * moment before it is drawn. `-50` reads as `-5.0`, never as 65486 and
 * never as `-50`.
 */
export function declinationDegreesText(decidegrees: number): string {
  const sign = decidegrees < 0 ? '-' : '';
  const magnitude = Math.abs(decidegrees);
  const whole = Math.trunc(magnitude / 10);
  const tenth = magnitude % 10;
  return `${sign}${whole}.${tenth}`;
}

/** The reverse, for a typed field. Returns undefined for anything that is
 *  not a legal declination - never a clamped guess. */
export function parseDeclinationDegrees(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^-?\d{1,2}(\.\d)?$/.test(trimmed)) return undefined;
  const decidegrees = Math.round(Number(trimmed) * 10);
  if (!Number.isFinite(decidegrees)) return undefined;
  return Math.abs(decidegrees) <= DECLINATION_DECIDEGREE_LIMIT
    ? decidegrees
    : undefined;
}

/* ================================================================== *
 * ACCELEROMETER TRIM
 * ================================================================== */

/** From acc_trim_pitch / acc_trim_roll in src/main/cli/settings.c. */
export const ACC_TRIM_LIMIT = 300;

/**
 * NO UNIT IS CLAIMED. The firmware stores two bounded integers and never
 * says what one unit of trim corresponds to; the CLI shows the number and
 * so does this. Printing a degree sign here would be inventing a physical
 * quantity out of a settings range.
 */
export function accTrimText(value: number): string {
  return String(value);
}

/* ================================================================== *
 * LIVE READINGS
 * ================================================================== */

/**
 * The unit each live vector is actually in, taken from the serializer.
 *
 * MSP_RAW_IMU writes `lrintf(acc.accADC.v[i])`, `gyroRateDps(i)` and
 * `lrintf(mag.magADC.v[i])`. Only the middle one has been converted to a
 * physical quantity, so only the middle one gets a physical unit:
 *
 *   GYRO  degrees per second, because gyroRateDps() says so.
 *   ACC   raw counts. Labelling these `g` would need acc_1G, which this
 *         command does not carry - the number would be off by a factor of
 *         several hundred and would look entirely plausible.
 *   MAG   raw counts. The magnetometer's scale is device dependent and
 *         nothing on the wire states it.
 */
export const LIVE_VECTOR_UNIT_KEYS: Readonly<
  Record<'GYRO' | 'ACC' | 'MAG', string>
> = Object.freeze({
  GYRO: `${NS}.unit.degreesPerSecond`,
  ACC: `${NS}.unit.rawCounts`,
  MAG: `${NS}.unit.rawCounts`,
});

/* ================================================================== *
 * CALIBRATION
 * ================================================================== */

export type SensorCalibrationTargetId = 'ACCELEROMETER' | 'MAGNETOMETER';

/**
 * Whether a calibration may even be offered.
 *
 * PRESENCE DECIDES, not configuration and not detection alone. Configured
 * says what somebody asked for; detected says what answered an ID
 * register at boot. Neither means the subsystem is available to calibrate
 * right now, and the firmware's own availability flag does - so that is
 * the one that gates the button.
 */
export type SensorCalibrationBlock =
  | 'SENSOR_NOT_PRESENT'
  | 'DISABLED_BY_CONFIGURATION'
  | 'NOT_READ'
  | 'BUSY';

export function calibrationBlock(
  truth: SensorTruth,
  busy: boolean,
): SensorCalibrationBlock | undefined {
  if (busy) return 'BUSY';
  if (truth.configured.kind === 'DISABLED_BY_CONFIGURATION') {
    return 'DISABLED_BY_CONFIGURATION';
  }
  if (truth.present.kind === 'NOT_OBSERVED') return 'NOT_READ';
  if (truth.present.kind === 'ABSENT') return 'SENSOR_NOT_PRESENT';
  return undefined;
}

export function describeCalibrationBlock(
  block: SensorCalibrationBlock,
): SensorPhrase {
  return phrase(`${NS}.calibration.blocked.${block}`);
}

/**
 * The stage keys, one per controller progress value.
 *
 * Deliberately NOT per sensor: the accelerometer and the magnetometer
 * report the same observation ("the board says it is calibrating"), and
 * two wordings for one fact would drift apart. Which sensor is being
 * calibrated is already on the card the stage appears in.
 */
export function describeCalibrationStage(
  progress: 'REQUESTED' | 'WAITING_FOR_MOVEMENT' | 'CALIBRATING' | 'VERIFYING',
): SensorPhrase {
  return phrase(`${NS}.calibration.stage.${progress}`);
}

/**
 * Outcome copy. Every one of these says exactly what was observed:
 *
 *  - an unconfirmed completion is NOT a failure, and does not read as one;
 *  - a cancelled observation does NOT claim the board stopped, because
 *    the firmware has no command that would stop it;
 *  - a lost link does NOT claim the calibration ended;
 *  - a magnetometer run with no movement says the board saw no movement,
 *    not that the compass is broken.
 */
export type SensorCalibrationOutcomeId =
  | 'SUCCEEDED'
  | 'NO_MOVEMENT_DETECTED'
  | 'START_NOT_OBSERVED'
  | 'COMPLETION_UNCONFIRMED'
  | 'TIMED_OUT'
  | 'LINK_LOST'
  | 'OBSERVATION_CANCELLED'
  | 'REFUSED_ARMED'
  | 'ARM_STATE_UNKNOWN'
  | 'REJECTED'
  | 'FAILED';

export function describeCalibrationOutcome(
  target: SensorCalibrationTargetId,
  outcome: SensorCalibrationOutcomeId,
): SensorPhrase {
  // Only the two success sentences differ per sensor; the rest describe
  // the observation, which is the same observation either way.
  return outcome === 'SUCCEEDED'
    ? phrase(`${NS}.calibration.outcome.SUCCEEDED.${target}`)
    : phrase(`${NS}.calibration.outcome.${outcome}`);
}

/** Whether an outcome is one an operator should act on. Not a health
 *  judgement about the sensor - a statement about the observation. */
export function calibrationOutcomeSeverity(
  outcome: SensorCalibrationOutcomeId,
): 'SUCCESS' | 'ATTENTION' | 'INFORMATION' {
  switch (outcome) {
    case 'SUCCEEDED':
      return 'SUCCESS';
    case 'NO_MOVEMENT_DETECTED':
    case 'START_NOT_OBSERVED':
    case 'REFUSED_ARMED':
    case 'ARM_STATE_UNKNOWN':
    case 'REJECTED':
    case 'FAILED':
      return 'ATTENTION';
    case 'COMPLETION_UNCONFIRMED':
    case 'TIMED_OUT':
    case 'LINK_LOST':
    case 'OBSERVATION_CANCELLED':
      return 'INFORMATION';
  }
}

/** Elapsed seconds, the only progress figure the firmware makes true.
 *  There is no percentage anywhere in this file, because the firmware
 *  sends none and inventing one would be inventing progress. */
export function elapsedSecondsText(elapsedMs: number): string {
  return String(Math.max(0, Math.floor(elapsedMs / 1000)));
}

/* ================================================================== *
 * SAVE OUTCOMES
 * ================================================================== */

export type SensorSaveOutcomeId =
  | 'NO_CHANGES'
  | 'AWAITING_REBOOT_VERIFICATION'
  | 'SUCCEEDED'
  | 'READBACK_MISMATCH'
  | 'PERSISTENCE_MISMATCH'
  | 'STALE_SESSION'
  | 'UNCONFIRMED'
  | 'SESSION_ENDED'
  | 'REJECTED'
  | 'FAILED';

export function describeSaveOutcome(outcome: SensorSaveOutcomeId): SensorPhrase {
  return phrase(`${NS}.save.outcome.${outcome}`);
}

export function describeSaveBlock(reason: string): SensorPhrase {
  return phrase(`${NS}.save.blocked.${reason}`);
}

/** The four stages a hardware save moves through, named for what is
 *  actually happening rather than for a spinner. */
export type SensorHardwareSaveStageId =
  | 'READING'
  | 'SENDING'
  | 'VERIFYING_APPLY'
  | 'PERSISTING'
  | 'VERIFYING_AFTER_REBOOT';

export function describeHardwareSaveStage(
  stage: SensorHardwareSaveStageId,
): SensorPhrase {
  return phrase(`${NS}.save.stage.${stage}`);
}
