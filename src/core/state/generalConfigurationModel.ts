/* eslint-disable no-bitwise -- MSP feature/beeper fields are specified as bit masks. */
import type { MspAdvancedConfig } from '../protocol/msp/decoding/decodeAdvancedConfig';
import type { MspArmingConfig } from '../protocol/msp/decoding/decodeArmingConfig';
import type { MspBeeperConfig } from '../protocol/msp/decoding/decodeBeeperConfig';
import type { MspRxConfig } from '../protocol/msp/decoding/decodeRxConfig';

export interface GeneralFeatureDefinition {
  readonly bit: number;
  readonly key: string;
  readonly dependencyOptionIds?: readonly number[];
}

export const GENERAL_FEATURES: readonly GeneralFeatureDefinition[] =
  Object.freeze([
    Object.freeze({ bit: 2, key: 'inflightAccCalibration' }),
    Object.freeze({ bit: 5, key: 'servoTilt', dependencyOptionIds: [16420] }),
    Object.freeze({ bit: 6, key: 'softSerial', dependencyOptionIds: [16423] }),
    Object.freeze({ bit: 9, key: 'rangefinder', dependencyOptionIds: [16429] }),
    Object.freeze({ bit: 16, key: 'ledStrip', dependencyOptionIds: [16413] }),
    Object.freeze({ bit: 17, key: 'display', dependencyOptionIds: [16408] }),
    Object.freeze({ bit: 18, key: 'osd', dependencyOptionIds: [16416, 16417] }),
    Object.freeze({ bit: 20, key: 'channelForwarding', dependencyOptionIds: [16420] }),
    Object.freeze({ bit: 21, key: 'transponder' }),
    Object.freeze({ bit: 22, key: 'airmode' }),
  ]);

export interface BeeperConditionDefinition {
  readonly bit: number;
  readonly key: string;
}

export const BEEPER_CONDITIONS: readonly BeeperConditionDefinition[] =
  Object.freeze([
    Object.freeze({ bit: 0, key: 'gyroCalibrated' }),
    Object.freeze({ bit: 1, key: 'rxLost' }),
    Object.freeze({ bit: 2, key: 'rxLostLanding' }),
    Object.freeze({ bit: 3, key: 'disarming' }),
    Object.freeze({ bit: 4, key: 'arming' }),
    Object.freeze({ bit: 5, key: 'armingGpsFix' }),
    Object.freeze({ bit: 6, key: 'batteryCritical' }),
    Object.freeze({ bit: 7, key: 'batteryLow' }),
    Object.freeze({ bit: 8, key: 'gpsStatus' }),
    Object.freeze({ bit: 9, key: 'rxSet' }),
    Object.freeze({ bit: 10, key: 'accCalibration' }),
    Object.freeze({ bit: 11, key: 'accCalibrationFailed' }),
    Object.freeze({ bit: 12, key: 'ready' }),
    Object.freeze({ bit: 14, key: 'disarmRepeat' }),
    Object.freeze({ bit: 15, key: 'armed' }),
    Object.freeze({ bit: 16, key: 'systemInit' }),
    Object.freeze({ bit: 17, key: 'usb' }),
    Object.freeze({ bit: 18, key: 'blackboxErase' }),
    Object.freeze({ bit: 19, key: 'crashFlip' }),
    Object.freeze({ bit: 20, key: 'cameraOpen' }),
    Object.freeze({ bit: 21, key: 'cameraClose' }),
    Object.freeze({ bit: 22, key: 'rcSmoothingFailure' }),
  ]);

export const DSHOT_BEACON_CONDITIONS: readonly BeeperConditionDefinition[] =
  Object.freeze([
    Object.freeze({ bit: 1, key: 'rxLost' }),
    Object.freeze({ bit: 9, key: 'rxSet' }),
  ]);

function maskFor(bits: readonly number[]): number {
  return bits.reduce((mask, bit) => (mask | 2 ** bit) >>> 0, 0);
}

export const GENERAL_FEATURE_EDITABLE_MASK = maskFor(
  GENERAL_FEATURES.map(item => item.bit),
);
export const BEEPER_EDITABLE_MASK = maskFor(
  BEEPER_CONDITIONS.map(item => item.bit),
);
export const DSHOT_BEACON_EDITABLE_MASK = maskFor(
  DSHOT_BEACON_CONDITIONS.map(item => item.bit),
);

export interface GeneralConfigurationSnapshot {
  readonly featureMaskRaw: number;
  readonly arming: MspArmingConfig;
  readonly beeper: MspBeeperConfig;
  readonly advanced: MspAdvancedConfig;
  readonly rx: MspRxConfig;
  readonly craftName: string;
  readonly pilotName: string;
  readonly buildOptionIds: ReadonlySet<number>;
  readonly gyroSampleRateHz?: number;
}

export interface GeneralConfigurationDraft {
  readonly featureMaskRaw: number;
  readonly disabledBeeperMask: number;
  readonly disabledDshotBeaconMask: number;
  readonly dshotBeaconTone: number;
  readonly autoDisarmDelaySeconds: number;
  readonly smallAngleDegrees: number;
  readonly gyroCalibrationOnFirstArm: boolean;
  readonly pidProcessDenom: number;
  readonly fpvCameraAngleDegrees: number;
  readonly craftName: string;
  readonly pilotName: string;
}

export type GeneralConfigurationValidationCode =
  | 'CRAFT_NAME_INVALID'
  | 'PILOT_NAME_INVALID'
  | 'CAMERA_ANGLE_INVALID'
  | 'SMALL_ANGLE_INVALID'
  | 'AUTO_DISARM_INVALID'
  | 'PID_DENOM_INVALID'
  | 'DSHOT_TONE_INVALID'
  | 'UNOWNED_FEATURE_CHANGED'
  | 'UNOWNED_BEEPER_CHANGED'
  | 'UNOWNED_DSHOT_CHANGED';

export function createGeneralConfigurationDraft(
  snapshot: GeneralConfigurationSnapshot,
): GeneralConfigurationDraft {
  return Object.freeze({
    featureMaskRaw: snapshot.featureMaskRaw >>> 0,
    disabledBeeperMask: snapshot.beeper.disabledMask >>> 0,
    disabledDshotBeaconMask:
      snapshot.beeper.disabledDshotBeaconMask >>> 0,
    dshotBeaconTone: snapshot.beeper.dshotBeaconTone,
    autoDisarmDelaySeconds: snapshot.arming.autoDisarmDelaySeconds,
    smallAngleDegrees: snapshot.arming.smallAngleDegrees,
    gyroCalibrationOnFirstArm:
      snapshot.arming.gyroCalibrationOnFirstArm,
    pidProcessDenom: snapshot.advanced.pidProcessDenom,
    fpvCameraAngleDegrees: snapshot.rx.fpvCameraAngleDegrees,
    craftName: snapshot.craftName,
    pilotName: snapshot.pilotName,
  });
}

export function bitEnabled(mask: number, bit: number): boolean {
  return ((mask >>> 0) & 2 ** bit) !== 0;
}

export function setMaskBit(mask: number, bit: number, enabled: boolean): number {
  const flag = 2 ** bit;
  return (enabled ? mask | flag : mask & ~flag) >>> 0;
}

export function featureIsAvailable(
  feature: GeneralFeatureDefinition,
  buildOptionIds: ReadonlySet<number>,
): boolean {
  if (feature.dependencyOptionIds === undefined || buildOptionIds.size === 0)
    return true;
  return feature.dependencyOptionIds.some(id => buildOptionIds.has(id));
}

export function generalConfigurationDraftsEqual(
  left: GeneralConfigurationDraft,
  right: GeneralConfigurationDraft,
): boolean {
  return (
    left.featureMaskRaw === right.featureMaskRaw &&
    left.disabledBeeperMask === right.disabledBeeperMask &&
    left.disabledDshotBeaconMask === right.disabledDshotBeaconMask &&
    left.dshotBeaconTone === right.dshotBeaconTone &&
    left.autoDisarmDelaySeconds === right.autoDisarmDelaySeconds &&
    left.smallAngleDegrees === right.smallAngleDegrees &&
    left.gyroCalibrationOnFirstArm === right.gyroCalibrationOnFirstArm &&
    left.pidProcessDenom === right.pidProcessDenom &&
    left.fpvCameraAngleDegrees === right.fpvCameraAngleDegrees &&
    left.craftName === right.craftName &&
    left.pilotName === right.pilotName
  );
}

function validText(value: string): boolean {
  return (
    value.length <= 16 &&
    [...value].every(character => {
      const code = character.charCodeAt(0);
      return code >= 0x20 && code <= 0x7e;
    })
  );
}

function integerIn(value: number, minimum: number, maximum: number): boolean {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

export function validateGeneralConfigurationDraft(
  original: GeneralConfigurationSnapshot,
  draft: GeneralConfigurationDraft,
): readonly GeneralConfigurationValidationCode[] {
  const issues: GeneralConfigurationValidationCode[] = [];
  if (!validText(draft.craftName)) issues.push('CRAFT_NAME_INVALID');
  if (!validText(draft.pilotName)) issues.push('PILOT_NAME_INVALID');
  if (!integerIn(draft.fpvCameraAngleDegrees, 0, 90))
    issues.push('CAMERA_ANGLE_INVALID');
  if (!integerIn(draft.smallAngleDegrees, 0, 180))
    issues.push('SMALL_ANGLE_INVALID');
  if (!integerIn(draft.autoDisarmDelaySeconds, 0, 60))
    issues.push('AUTO_DISARM_INVALID');
  if (!integerIn(draft.pidProcessDenom, 1, 16))
    issues.push('PID_DENOM_INVALID');
  if (!integerIn(draft.dshotBeaconTone, 0, 5))
    issues.push('DSHOT_TONE_INVALID');
  if (
    (((draft.featureMaskRaw ^ original.featureMaskRaw) >>> 0) &
      ~GENERAL_FEATURE_EDITABLE_MASK) !==
    0
  )
    issues.push('UNOWNED_FEATURE_CHANGED');
  if (
    (((draft.disabledBeeperMask ^ original.beeper.disabledMask) >>> 0) &
      ~BEEPER_EDITABLE_MASK) !==
    0
  )
    issues.push('UNOWNED_BEEPER_CHANGED');
  if (
    (((draft.disabledDshotBeaconMask ^
      original.beeper.disabledDshotBeaconMask) >>>
      0) &
      ~DSHOT_BEACON_EDITABLE_MASK) !==
    0
  )
    issues.push('UNOWNED_DSHOT_CHANGED');
  return Object.freeze(issues);
}

export function generalConfigurationSnapshotsEqual(
  left: GeneralConfigurationSnapshot,
  right: GeneralConfigurationSnapshot,
): boolean {
  return (
    left.featureMaskRaw === right.featureMaskRaw &&
    left.craftName === right.craftName &&
    left.pilotName === right.pilotName &&
    left.arming.autoDisarmDelaySeconds ===
      right.arming.autoDisarmDelaySeconds &&
    left.arming.deprecatedDisarmKillsSwitch ===
      right.arming.deprecatedDisarmKillsSwitch &&
    left.arming.smallAngleDegrees === right.arming.smallAngleDegrees &&
    left.arming.gyroCalibrationOnFirstArm ===
      right.arming.gyroCalibrationOnFirstArm &&
    left.beeper.disabledMask === right.beeper.disabledMask &&
    left.beeper.dshotBeaconTone === right.beeper.dshotBeaconTone &&
    left.beeper.disabledDshotBeaconMask ===
      right.beeper.disabledDshotBeaconMask &&
    advancedEqual(left.advanced, right.advanced) &&
    bytesEqual(left.rx.raw, right.rx.raw)
  );
}

function advancedEqual(
  left: MspAdvancedConfig,
  right: MspAdvancedConfig,
): boolean {
  return (
    left.deprecatedGyroSyncDenom === right.deprecatedGyroSyncDenom &&
    left.pidProcessDenom === right.pidProcessDenom &&
    left.useContinuousUpdate === right.useContinuousUpdate &&
    left.motorProtocolRaw === right.motorProtocolRaw &&
    left.motorPwmRate === right.motorPwmRate &&
    left.motorIdleRaw === right.motorIdleRaw &&
    left.deprecatedGyroUse32kHz === right.deprecatedGyroUse32kHz &&
    left.motorInversionRaw === right.motorInversionRaw &&
    left.deprecatedGyroToUse === right.deprecatedGyroToUse &&
    left.gyroHighFsr === right.gyroHighFsr &&
    left.gyroMovementCalibrationThreshold ===
      right.gyroMovementCalibrationThreshold &&
    left.gyroCalibrationDuration === right.gyroCalibrationDuration &&
    left.gyroYawOffset === right.gyroYawOffset &&
    left.checkOverflow === right.checkOverflow &&
    left.debugMode === right.debugMode &&
    left.debugModeCount === right.debugModeCount
  );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function generalConfigurationChangedCount(
  original: GeneralConfigurationDraft,
  draft: GeneralConfigurationDraft,
): number {
  const keys = Object.keys(original) as (keyof GeneralConfigurationDraft)[];
  return keys.reduce(
    (count, key) => count + (original[key] === draft[key] ? 0 : 1),
    0,
  );
}
