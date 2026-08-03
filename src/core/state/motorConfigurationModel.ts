import type { MspAdvancedConfig } from '../protocol/msp/decoding/decodeAdvancedConfig';
import type { MspFeatureConfig } from '../protocol/msp/decoding/decodeFeatureConfig';
import type { MspMixerConfig } from '../protocol/msp/decoding/decodeMixerConfig';
import type { MspMotor3dConfig } from '../protocol/msp/decoding/decodeMotor3dConfig';
import type { MspMotorConfig } from '../protocol/msp/decoding/decodeMotorConfig';

/** Feature bits used by the Motors settings surface at MSP API 1.47. */
export const FEATURE_MOTOR_STOP_BIT = 2 ** 4;
export const FEATURE_ESC_SENSOR_BIT = 2 ** 27;

/** Raw motor protocol enum at the pinned API-1.47 firmware. */
export const MOTOR_PROTOCOL_RAW_MIN = 0;
export const MOTOR_PROTOCOL_RAW_MAX = 9;
export const MOTOR_PROTOCOL_DSHOT_MIN = 5;
// The configurator's API-1.47 protocol table treats PROSHOT1000 (raw 8)
// as part of the digital DShot-family feature surface as well.
export const MOTOR_PROTOCOL_DSHOT_MAX = 8;

/**
 * A complete, immutable read of the five FC configuration groups owned by
 * the Motors page. Each member is wire truth from one MSP response. It is
 * deliberately separate from MotorVectorScope: that type is the narrow
 * pulse-safety contract and must not grow merely because the settings UI
 * needs more information.
 */
export interface MotorConfigurationSnapshot {
  readonly mixer: MspMixerConfig;
  readonly advanced: MspAdvancedConfig;
  readonly motor: MspMotorConfig;
  readonly motor3d: MspMotor3dConfig;
  readonly feature: MspFeatureConfig;
}

/** Editable projection. Non-motor fields in MSP_ADVANCED_CONFIG remain in
 * the immutable snapshot and are mirrored byte-for-byte by the encoder. */
export interface MotorConfigurationDraft {
  readonly mixerModeRaw: number;
  readonly yawMotorsReversed: boolean;
  readonly motorProtocolRaw: number;
  readonly useContinuousUpdate: boolean;
  readonly motorPwmRate: number;
  readonly motorIdleRaw: number;
  readonly motorInversion: boolean;
  readonly maxThrottle: number;
  readonly minCommand: number;
  readonly motorPoleCount: number;
  readonly dshotTelemetryEnabled: boolean;
  readonly motorStopEnabled: boolean;
  readonly escSensorEnabled: boolean;
  readonly feature3dEnabled: boolean;
  readonly deadband3dLow: number;
  readonly deadband3dHigh: number;
  readonly neutral3d: number;
}

export type MotorConfigurationValidationCode =
  | 'NOT_INTEGER'
  | 'OUT_OF_RANGE'
  | 'INVALID_BOOLEAN'
  | 'INVALID_3D_BAND'
  | 'DSHOT_TELEMETRY_REQUIRES_DSHOT';

export interface MotorConfigurationValidationIssue {
  readonly field: keyof MotorConfigurationDraft;
  readonly code: MotorConfigurationValidationCode;
}

export interface MotorConfigurationValidationResult {
  readonly valid: boolean;
  readonly issues: readonly MotorConfigurationValidationIssue[];
}

export function createMotorConfigurationDraft(
  snapshot: MotorConfigurationSnapshot,
): MotorConfigurationDraft {
  return Object.freeze({
    mixerModeRaw: snapshot.mixer.mixerModeRaw,
    yawMotorsReversed: snapshot.mixer.yawMotorsReversedConfigured,
    motorProtocolRaw: snapshot.advanced.motorProtocolRaw,
    useContinuousUpdate: snapshot.advanced.useContinuousUpdate !== 0,
    motorPwmRate: snapshot.advanced.motorPwmRate,
    motorIdleRaw: snapshot.advanced.motorIdleRaw,
    motorInversion: snapshot.advanced.motorInversionRaw !== 0,
    maxThrottle: snapshot.motor.maxThrottle,
    minCommand: snapshot.motor.minCommand,
    motorPoleCount: snapshot.motor.motorPoleCount,
    dshotTelemetryEnabled: snapshot.motor.dshotTelemetryRaw !== 0,
    motorStopEnabled: hasFeature(
      snapshot.feature.enabledFeaturesRaw,
      FEATURE_MOTOR_STOP_BIT,
    ),
    escSensorEnabled: hasFeature(
      snapshot.feature.enabledFeaturesRaw,
      FEATURE_ESC_SENSOR_BIT,
    ),
    feature3dEnabled: snapshot.feature.feature3dEnabled,
    deadband3dLow: snapshot.motor3d.deadband3dLow,
    deadband3dHigh: snapshot.motor3d.deadband3dHigh,
    neutral3d: snapshot.motor3d.neutral3d,
  });
}

export function hasFeature(mask: number, bit: number): boolean {
  // eslint-disable-next-line no-bitwise -- MSP feature configuration is an unsigned 32-bit bitmask.
  return (mask & bit) !== 0;
}

export function setFeature(
  mask: number,
  bit: number,
  enabled: boolean,
): number {
  // Bitwise operators are signed in JS, so normalize the result back to the
  // unsigned u32 domain expected by MSP_SET_FEATURE_CONFIG.
  // eslint-disable-next-line no-bitwise -- MSP feature configuration is an unsigned 32-bit bitmask.
  return (enabled ? mask | bit : mask & ~bit) >>> 0;
}

function issue(
  issues: MotorConfigurationValidationIssue[],
  field: keyof MotorConfigurationDraft,
  code: MotorConfigurationValidationCode,
): void {
  issues.push(Object.freeze({ field, code }));
}

function checkIntegerRange(
  draft: MotorConfigurationDraft,
  issues: MotorConfigurationValidationIssue[],
  field: keyof MotorConfigurationDraft,
  minimum: number,
  maximum: number,
): void {
  const value = draft[field];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    issue(issues, field, 'NOT_INTEGER');
    return;
  }
  if (value < minimum || value > maximum) {
    issue(issues, field, 'OUT_OF_RANGE');
  }
}

function checkBoolean(
  draft: MotorConfigurationDraft,
  issues: MotorConfigurationValidationIssue[],
  field: keyof MotorConfigurationDraft,
): void {
  if (typeof draft[field] !== 'boolean') {
    issue(issues, field, 'INVALID_BOOLEAN');
  }
}

/**
 * Rejects malformed data before any exclusive operation or write can start.
 * Values are never rounded, clamped, defaulted, or coerced.
 */
export function validateMotorConfigurationDraft(
  draft: MotorConfigurationDraft,
): MotorConfigurationValidationResult {
  const issues: MotorConfigurationValidationIssue[] = [];

  checkIntegerRange(draft, issues, 'mixerModeRaw', 0, 255);
  checkIntegerRange(
    draft,
    issues,
    'motorProtocolRaw',
    MOTOR_PROTOCOL_RAW_MIN,
    MOTOR_PROTOCOL_RAW_MAX,
  );
  checkIntegerRange(draft, issues, 'motorPwmRate', 0, 65535);
  // The official UI exposes motor idle as 0.0..20.0%; wire units are 0.01%.
  checkIntegerRange(draft, issues, 'motorIdleRaw', 0, 2000);
  checkIntegerRange(draft, issues, 'maxThrottle', 0, 2000);
  checkIntegerRange(draft, issues, 'minCommand', 0, 2000);
  checkIntegerRange(draft, issues, 'motorPoleCount', 1, 255);
  checkIntegerRange(draft, issues, 'deadband3dLow', 0, 2000);
  checkIntegerRange(draft, issues, 'deadband3dHigh', 0, 2000);
  checkIntegerRange(draft, issues, 'neutral3d', 0, 2000);

  const booleanFields: readonly (keyof MotorConfigurationDraft)[] = [
    'yawMotorsReversed',
    'useContinuousUpdate',
    'motorInversion',
    'dshotTelemetryEnabled',
    'motorStopEnabled',
    'escSensorEnabled',
    'feature3dEnabled',
  ];
  for (const field of booleanFields) {
    checkBoolean(draft, issues, field);
  }

  if (
    Number.isInteger(draft.deadband3dLow) &&
    Number.isInteger(draft.neutral3d) &&
    Number.isInteger(draft.deadband3dHigh) &&
    !(
      draft.deadband3dLow < draft.neutral3d &&
      draft.neutral3d < draft.deadband3dHigh
    )
  ) {
    issue(issues, 'neutral3d', 'INVALID_3D_BAND');
  }

  if (
    draft.dshotTelemetryEnabled === true &&
    !(
      draft.motorProtocolRaw >= MOTOR_PROTOCOL_DSHOT_MIN &&
      draft.motorProtocolRaw <= MOTOR_PROTOCOL_DSHOT_MAX
    )
  ) {
    issue(issues, 'dshotTelemetryEnabled', 'DSHOT_TELEMETRY_REQUIRES_DSHOT');
  }

  return Object.freeze({
    valid: issues.length === 0,
    issues: Object.freeze(issues),
  });
}

export function motorConfigurationDraftsEqual(
  left: MotorConfigurationDraft,
  right: MotorConfigurationDraft,
): boolean {
  return (Object.keys(left) as (keyof MotorConfigurationDraft)[]).every(
    key => left[key] === right[key],
  );
}
