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

/**
 * MOTOR POLE COUNT IS BOUNDED AT FOUR, NOT AT ONE.
 *
 * The firmware's own bound, unchanged across every reviewed revision:
 *
 *   cli/settings.c   PARAM_NAME_MOTOR_POLES, VAR_UINT8 | MASTER_VALUE,
 *                    .config.minmaxUnsigned = { 4, UINT8_MAX }
 *
 * and the official Configurator's Motors tab enforces the same thing on the
 * input itself (src/tabs/motors.html: `min="4" max="255"`).
 *
 * This matters because MSP DOES NOT RE-CHECK IT. The setter is a bare
 * assignment - `motorConfigMutable()->motorPoleCount = sbufReadU8(src);`
 * (msp.c, MSP_SET_MOTOR_CONFIG) - with no clamp, so a value the CLI would
 * have refused is accepted, stored and committed to EEPROM without a word.
 *
 * And it is not an inert number. The pole count is the divisor that turns
 * an ESC's electrical RPM into mechanical RPM, so a value below four
 * silently scales every DShot telemetry reading and everything downstream
 * of it - the RPM filter's notch centres above all. Nothing reports an
 * error; the aircraft simply filters the wrong frequencies.
 *
 * The lower bound was 1 here. That was this app's own invention, matching
 * neither of the two sources above.
 */
export const MOTOR_POLE_COUNT_MIN = 4;
export const MOTOR_POLE_COUNT_MAX = 255;

/**
 * THE PULSE WIDTHS A BETAFLIGHT CONFIGURATION MAY LEGALLY HOLD.
 *
 *   rx/rx.h   PWM_PULSE_MIN 750, PWM_PULSE_MAX 2250
 *             PWM_RANGE_MIDDLE = PWM_RANGE_MIN + PWM_RANGE / 2 = 1500
 *
 * These are not style limits. `cli/settings.c` refuses anything outside
 * them, and MSP does not re-check - the 3D setter is three bare
 * `sbufReadU16` assignments (msp.c, MSP_SET_MOTOR_3D_CONFIG).
 */
const PWM_PULSE_MIN = 750;
const PWM_PULSE_MAX = 2250;
const PWM_RANGE_MIDDLE = 1500;

/**
 * 3D DEADBANDS: WIDE ENOUGH TO BE WRONG WAS WIDE ENOUGH TO BE DANGEROUS.
 *
 * These three were bounded 0..2000 here - a number this app invented. The
 * firmware's own bounds, from cli/settings.c, are:
 *
 *   3d_deadband_low    { PWM_PULSE_MIN,     PWM_RANGE_MIDDLE }   750..1500
 *   3d_deadband_high   { PWM_RANGE_MIDDLE,  PWM_PULSE_MAX    }  1500..2250
 *   3d_neutral         { PWM_PULSE_MIN,     PWM_PULSE_MAX    }   750..2250
 *
 * and Betaflight Configurator's own inputs are tighter still
 * (1250..1600 / 1400..1750 / 1400..1600, src/tabs/motors.html).
 *
 * WHY THIS IS A SAFETY BOUND AND NOT A TIDINESS ONE. In 3D mode these
 * three numbers ARE the motor-stop band, and `neutral3d` is literally the
 * DISARMED OUTPUT:
 *
 *   drivers/pwm_output.c:38    *disarm = flight3DConfig()->neutral3d;
 *   drivers/pwm_output.c:41-42 *deadbandMotor3dHigh / Low
 *
 * The old bound accepted low=0, neutral=1, high=2 - which satisfies the
 * ordering rule below, passes validation, encodes cleanly, is stored by
 * MSP without complaint and survives EEPROM. On a 3D-enabled craft that
 * puts the entire throttle stick above `deadband3d_high` and hands the
 * ESCs a disarm pulse of one microsecond.
 *
 * The firmware bound is used rather than the Configurator's, because the
 * question this validator answers is "will the flight controller hold
 * this?", not "is this a sensible tune?".
 */
export const MOTOR_3D_DEADBAND_LOW_MIN = PWM_PULSE_MIN;
export const MOTOR_3D_DEADBAND_LOW_MAX = PWM_RANGE_MIDDLE;
export const MOTOR_3D_DEADBAND_HIGH_MIN = PWM_RANGE_MIDDLE;
export const MOTOR_3D_DEADBAND_HIGH_MAX = PWM_PULSE_MAX;
export const MOTOR_3D_NEUTRAL_MIN = PWM_PULSE_MIN;
export const MOTOR_3D_NEUTRAL_MAX = PWM_PULSE_MAX;

/**
 * Unsynced PWM output frequency, in Hz.
 *
 * Two independent sources agree and this app agreed with neither:
 *
 *   cli/settings.c        motor_pwm_rate      { 200, 32000 }
 *   src/tabs/motors.html  unsyncedpwmfreq     min="200" max="32000"
 *
 * The bound here was 0..65535 - the width of the u16 field, which is a
 * statement about the wire and not about the setting. Zero is not a
 * frequency, and `validateAndFixConfig` only clamps this for the PWM
 * protocol specifically (to BRUSHLESS_MOTORS_PWM_RATE, config.c), so on
 * every other analog protocol an out-of-range rate is simply kept.
 */
export const MOTOR_PWM_RATE_MIN = 200;
export const MOTOR_PWM_RATE_MAX = 32000;
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
  checkIntegerRange(
    draft,
    issues,
    'motorPwmRate',
    MOTOR_PWM_RATE_MIN,
    MOTOR_PWM_RATE_MAX,
  );
  // The official UI exposes motor idle as 0.0..20.0%; wire units are 0.01%.
  checkIntegerRange(draft, issues, 'motorIdleRaw', 0, 2000);
  checkIntegerRange(draft, issues, 'maxThrottle', 0, 2000);
  checkIntegerRange(draft, issues, 'minCommand', 0, 2000);
  checkIntegerRange(
    draft,
    issues,
    'motorPoleCount',
    MOTOR_POLE_COUNT_MIN,
    MOTOR_POLE_COUNT_MAX,
  );
  checkIntegerRange(
    draft,
    issues,
    'deadband3dLow',
    MOTOR_3D_DEADBAND_LOW_MIN,
    MOTOR_3D_DEADBAND_LOW_MAX,
  );
  checkIntegerRange(
    draft,
    issues,
    'deadband3dHigh',
    MOTOR_3D_DEADBAND_HIGH_MIN,
    MOTOR_3D_DEADBAND_HIGH_MAX,
  );
  checkIntegerRange(
    draft,
    issues,
    'neutral3d',
    MOTOR_3D_NEUTRAL_MIN,
    MOTOR_3D_NEUTRAL_MAX,
  );

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
