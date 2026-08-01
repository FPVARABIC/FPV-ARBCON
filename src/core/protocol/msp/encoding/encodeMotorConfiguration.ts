import type { MspAdvancedConfig } from '../decoding/decodeAdvancedConfig';
import type { MspFeatureConfig } from '../decoding/decodeFeatureConfig';
import type {
  MotorConfigurationDraft,
  MotorConfigurationSnapshot,
} from '../../../state/motorConfigurationModel';
import {
  FEATURE_ESC_SENSOR_BIT,
  FEATURE_MOTOR_STOP_BIT,
  setFeature,
  validateMotorConfigurationDraft,
} from '../../../state/motorConfigurationModel';
import { FEATURE_3D_BIT } from '../decoding/decodeFeatureConfig';

export class MotorConfigurationEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MotorConfigurationEncodeError';
  }
}

function assertValid(draft: MotorConfigurationDraft): void {
  const result = validateMotorConfigurationDraft(draft);
  if (!result.valid) {
    const detail = result.issues
      .map(item => `${String(item.field)}:${item.code}`)
      .join(',');
    throw new MotorConfigurationEncodeError(
      `Motor configuration draft is invalid (${detail}).`,
    );
  }
}

function payload(size: number): { bytes: Uint8Array; view: DataView } {
  const bytes = new Uint8Array(size);
  return { bytes, view: new DataView(bytes.buffer) };
}

/** MSP_SET_MIXER_CONFIG: u8 mixer + u8 reverse flag. */
export function encodeMixerConfiguration(
  draft: MotorConfigurationDraft,
): Uint8Array {
  assertValid(draft);
  return Uint8Array.from([draft.mixerModeRaw, draft.yawMotorsReversed ? 1 : 0]);
}

/**
 * MSP_SET_ADVANCED_CONFIG at API 1.47: 19 bytes. The read response carries
 * a twentieth DEBUG_COUNT byte; it is a read-only enum bound and is never
 * echoed back. Every unrelated writable field mirrors the original response
 * exactly, preventing a Motors-page edit from overwriting gyro configuration.
 */
export function encodeAdvancedMotorConfiguration(
  original: MspAdvancedConfig,
  draft: MotorConfigurationDraft,
): Uint8Array {
  assertValid(draft);
  const { bytes, view } = payload(19);
  view.setUint8(0, original.deprecatedGyroSyncDenom);
  view.setUint8(1, original.pidProcessDenom);
  view.setUint8(2, draft.useContinuousUpdate ? 1 : 0);
  view.setUint8(3, draft.motorProtocolRaw);
  view.setUint16(4, draft.motorPwmRate, true);
  view.setUint16(6, draft.motorIdleRaw, true);
  view.setUint8(8, original.deprecatedGyroUse32kHz);
  view.setUint8(9, draft.motorInversion ? 1 : 0);
  view.setUint8(10, original.deprecatedGyroToUse);
  view.setUint8(11, original.gyroHighFsr);
  view.setUint8(12, original.gyroMovementCalibrationThreshold);
  view.setUint16(13, original.gyroCalibrationDuration, true);
  view.setInt16(15, original.gyroYawOffset, true);
  view.setUint8(17, original.checkOverflow);
  view.setUint8(18, original.debugMode);
  return bytes;
}

/** MSP_SET_MOTOR_CONFIG at API 1.47: 3*u16 + poles + DShot telemetry. */
export function encodeMotorConfiguration(
  draft: MotorConfigurationDraft,
): Uint8Array {
  assertValid(draft);
  const { bytes, view } = payload(8);
  // API 1.47 keeps the removed min-throttle slot structurally present.
  view.setUint16(0, 0, true);
  view.setUint16(2, draft.maxThrottle, true);
  view.setUint16(4, draft.minCommand, true);
  view.setUint8(6, draft.motorPoleCount);
  view.setUint8(7, draft.dshotTelemetryEnabled ? 1 : 0);
  return bytes;
}

/** MSP_SET_MOTOR_3D_CONFIG: low, high, neutral u16 LE. */
export function encodeMotor3dConfiguration(
  draft: MotorConfigurationDraft,
): Uint8Array {
  assertValid(draft);
  const { bytes, view } = payload(6);
  view.setUint16(0, draft.deadband3dLow, true);
  view.setUint16(2, draft.deadband3dHigh, true);
  view.setUint16(4, draft.neutral3d, true);
  return bytes;
}

export function deriveFeatureMask(
  original: MspFeatureConfig,
  draft: MotorConfigurationDraft,
): number {
  assertValid(draft);
  let result = original.enabledFeaturesRaw;
  result = setFeature(result, FEATURE_MOTOR_STOP_BIT, draft.motorStopEnabled);
  result = setFeature(result, FEATURE_ESC_SENSOR_BIT, draft.escSensorEnabled);
  result = setFeature(result, FEATURE_3D_BIT, draft.feature3dEnabled);
  return result;
}

/** MSP_SET_FEATURE_CONFIG: complete u32 mask, unrelated bits preserved. */
export function encodeFeatureConfiguration(
  original: MspFeatureConfig,
  draft: MotorConfigurationDraft,
): Uint8Array {
  const { bytes, view } = payload(4);
  view.setUint32(0, deriveFeatureMask(original, draft), true);
  return bytes;
}

export type MotorConfigurationWriteGroup =
  | 'MIXER'
  | 'ADVANCED'
  | 'MOTOR'
  | 'MOTOR_3D'
  | 'FEATURE';

export interface EncodedMotorConfigurationWrite {
  readonly group: MotorConfigurationWriteGroup;
  readonly payload: Uint8Array;
}

/**
 * Produces only changed write groups, in deterministic order. EEPROM commit
 * is intentionally not included; the transaction sends it only after every
 * returned group is acknowledged.
 */
export function encodeChangedMotorConfiguration(
  original: MotorConfigurationSnapshot,
  draft: MotorConfigurationDraft,
): readonly EncodedMotorConfigurationWrite[] {
  assertValid(draft);
  const writes: EncodedMotorConfigurationWrite[] = [];

  // Match the upstream save ordering. The feature mask is complete and
  // preserves unrelated bits, so it is safe to apply before the parameter
  // groups it enables.
  const feature = encodeFeatureConfiguration(original.feature, draft);
  const originalFeature = payload(4);
  originalFeature.view.setUint32(0, original.feature.enabledFeaturesRaw, true);
  if (!equalBytes(originalFeature.bytes, feature)) {
    writes.push(Object.freeze({ group: 'FEATURE', payload: feature }));
  }

  const originalMixer = Uint8Array.from([
    original.mixer.mixerModeRaw,
    original.mixer.yawMotorsReversedRaw,
  ]);
  const mixer = encodeMixerConfiguration(draft);
  if (!equalBytes(originalMixer, mixer)) {
    writes.push(Object.freeze({ group: 'MIXER', payload: mixer }));
  }

  const motor = encodeMotorConfiguration(draft);
  const originalMotor = payload(8);
  originalMotor.view.setUint16(0, 0, true);
  originalMotor.view.setUint16(2, original.motor.maxThrottle, true);
  originalMotor.view.setUint16(4, original.motor.minCommand, true);
  originalMotor.view.setUint8(6, original.motor.motorPoleCount);
  originalMotor.view.setUint8(7, original.motor.dshotTelemetryRaw);
  if (!equalBytes(originalMotor.bytes, motor)) {
    writes.push(Object.freeze({ group: 'MOTOR', payload: motor }));
  }

  const motor3d = encodeMotor3dConfiguration(draft);
  const original3d = payload(6);
  original3d.view.setUint16(0, original.motor3d.deadband3dLow, true);
  original3d.view.setUint16(2, original.motor3d.deadband3dHigh, true);
  original3d.view.setUint16(4, original.motor3d.neutral3d, true);
  if (!equalBytes(original3d.bytes, motor3d)) {
    writes.push(Object.freeze({ group: 'MOTOR_3D', payload: motor3d }));
  }

  const advanced = encodeAdvancedMotorConfiguration(original.advanced, draft);
  if (!equalBytes(encodeOriginalAdvanced(original.advanced), advanced)) {
    writes.push(Object.freeze({ group: 'ADVANCED', payload: advanced }));
  }

  return Object.freeze(writes);
}

function encodeOriginalAdvanced(original: MspAdvancedConfig): Uint8Array {
  const { bytes, view } = payload(19);
  view.setUint8(0, original.deprecatedGyroSyncDenom);
  view.setUint8(1, original.pidProcessDenom);
  view.setUint8(2, original.useContinuousUpdate);
  view.setUint8(3, original.motorProtocolRaw);
  view.setUint16(4, original.motorPwmRate, true);
  view.setUint16(6, original.motorIdleRaw, true);
  view.setUint8(8, original.deprecatedGyroUse32kHz);
  view.setUint8(9, original.motorInversionRaw);
  view.setUint8(10, original.deprecatedGyroToUse);
  view.setUint8(11, original.gyroHighFsr);
  view.setUint8(12, original.gyroMovementCalibrationThreshold);
  view.setUint16(13, original.gyroCalibrationDuration, true);
  view.setInt16(15, original.gyroYawOffset, true);
  view.setUint8(17, original.checkOverflow);
  view.setUint8(18, original.debugMode);
  return bytes;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
