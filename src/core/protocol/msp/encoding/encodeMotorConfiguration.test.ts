import type { MspAdvancedConfig } from '../decoding/decodeAdvancedConfig';
import type { MspFeatureConfig } from '../decoding/decodeFeatureConfig';
import type {
  MotorConfigurationDraft,
  MotorConfigurationSnapshot,
} from '../../../state/motorConfigurationModel';
import {
  FEATURE_ESC_SENSOR_BIT,
  FEATURE_MOTOR_STOP_BIT,
  createMotorConfigurationDraft,
  hasFeature,
  validateMotorConfigurationDraft,
} from '../../../state/motorConfigurationModel';
import {
  MotorConfigurationEncodeError,
  deriveFeatureMask,
  encodeAdvancedMotorConfiguration,
  encodeChangedMotorConfiguration,
  encodeFeatureConfiguration,
  encodeMixerConfiguration,
  encodeMotor3dConfiguration,
  encodeMotorConfiguration,
} from './encodeMotorConfiguration';

function advanced(
  overrides: Partial<MspAdvancedConfig> = {},
): MspAdvancedConfig {
  return Object.freeze({
    deprecatedGyroSyncDenom: 1,
    pidProcessDenom: 2,
    useContinuousUpdate: 0,
    motorProtocolRaw: 7,
    motorPwmRate: 480,
    motorIdleRaw: 550,
    deprecatedGyroUse32kHz: 0,
    motorInversionRaw: 0,
    deprecatedGyroToUse: 0,
    gyroHighFsr: 1,
    gyroMovementCalibrationThreshold: 48,
    gyroCalibrationDuration: 125,
    gyroYawOffset: -17,
    checkOverflow: 2,
    debugMode: 9,
    debugModeCount: 77,
    ...overrides,
  });
}

function feature(mask = 0x80001000): MspFeatureConfig {
  return Object.freeze({
    enabledFeaturesRaw: mask,
    // eslint-disable-next-line no-bitwise -- fixture mirrors the feature decoder.
    feature3dEnabled: (mask & (2 ** 12)) !== 0,
  });
}

function snapshot(): MotorConfigurationSnapshot {
  return Object.freeze({
    mixer: Object.freeze({
      mixerModeRaw: 3,
      yawMotorsReversedConfigured: false,
      yawMotorsReversedRaw: 0,
    }),
    advanced: advanced(),
    motor: Object.freeze({
      deprecatedMinThrottle: 0,
      maxThrottle: 2000,
      minCommand: 1000,
      motorCount: 4,
      motorPoleCount: 14,
      dshotTelemetryRaw: 0,
      escSensorRaw: 0,
    }),
    motor3d: Object.freeze({
      deadband3dLow: 1406,
      deadband3dHigh: 1514,
      neutral3d: 1460,
    }),
    feature: feature(),
  });
}

function draft(
  overrides: Partial<MotorConfigurationDraft> = {},
): MotorConfigurationDraft {
  return Object.freeze({
    ...createMotorConfigurationDraft(snapshot()),
    ...overrides,
  });
}

/**
 * THE POLE COUNT BOUND, which this app had wrong.
 *
 * Betaflight bounds motor_poles at 4..255 in two places that agree:
 *
 *   cli/settings.c      PARAM_NAME_MOTOR_POLES ... { 4, UINT8_MAX }
 *   src/tabs/motors.html   <input name="motorPoles" min="4" max="255">
 *
 * and its MSP setter does NOT re-check it - MSP_SET_MOTOR_CONFIG assigns
 * the byte straight into motorConfig, so a value the CLI would refuse is
 * accepted and committed in silence. This build's own lower bound was 1,
 * which is neither of those, and a pole count below four silently rescales
 * every DShot RPM reading and the RPM filter that depends on it.
 */
describe('motor pole count is bounded where the firmware bounds it', () => {
  it.each([0, 1, 2, 3])('refuses %i poles, which the CLI refuses too', value => {
    const result = validateMotorConfigurationDraft(
      draft({ motorPoleCount: value }),
    );
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({
      field: 'motorPoleCount',
      code: 'OUT_OF_RANGE',
    });
  });

  it.each([4, 12, 14, 255])('accepts %i poles', value => {
    expect(
      validateMotorConfigurationDraft(draft({ motorPoleCount: value })).valid,
    ).toBe(true);
  });

  it('refuses 256, above the single byte the wire carries', () => {
    expect(
      validateMotorConfigurationDraft(draft({ motorPoleCount: 256 })).valid,
    ).toBe(false);
  });

  /** The encoder is the last gate before the wire, and it must refuse too -
   *  a caller that skipped validation must not be able to reach the FC. */
  it('never encodes an under-bound pole count', () => {
    expect(() =>
      encodeMotorConfiguration(draft({ motorPoleCount: 1 })),
    ).toThrow(MotorConfigurationEncodeError);
  });
});

describe('motor configuration API-1.47 payload encoders', () => {
  it('matches the official MSP_SET_MIXER_CONFIG byte order', () => {
    expect(
      Array.from(
        encodeMixerConfiguration(
          draft({
            mixerModeRaw: 26,
            yawMotorsReversed: true,
          }),
        ),
      ),
    ).toEqual([26, 1]);
  });

  it('encodes the 19-byte advanced write and preserves unrelated signed gyro fields', () => {
    const result = encodeAdvancedMotorConfiguration(
      advanced(),
      draft({
        useContinuousUpdate: true,
        motorProtocolRaw: 6,
        motorPwmRate: 32000,
        motorIdleRaw: 625,
        motorInversion: true,
      }),
    );

    expect(Array.from(result)).toEqual([
      1, 2, 1, 6, 0x00, 0x7d, 0x71, 0x02, 0, 1, 0, 1, 48, 125, 0, 0xef, 0xff, 2,
      9,
    ]);
    expect(result).toHaveLength(19);
    // DEBUG_COUNT is byte 20 of the read response, not a writable field.
    expect(Array.from(result)).not.toContain(77);
  });

  it('matches the official 8-byte MSP_SET_MOTOR_CONFIG layout', () => {
    expect(
      Array.from(
        encodeMotorConfiguration(
          draft({
            maxThrottle: 1995,
            minCommand: 995,
            motorPoleCount: 12,
            dshotTelemetryEnabled: true,
          }),
        ),
      ),
    ).toEqual([0, 0, 0xcb, 0x07, 0xe3, 0x03, 12, 1]);
  });

  it('matches the 3D low/high/neutral little-endian layout', () => {
    expect(Array.from(encodeMotor3dConfiguration(draft()))).toEqual([
      0x7e, 0x05, 0xea, 0x05, 0xb4, 0x05,
    ]);
  });

  it('preserves unrelated feature bits including bit 31 while editing owned bits', () => {
    const original = feature(0x80001001);
    const edited = draft({
      motorStopEnabled: true,
      escSensorEnabled: true,
      feature3dEnabled: false,
    });
    const mask = deriveFeatureMask(original, edited);

    expect(mask).toBe(0x88000011);
    expect(hasFeature(mask, FEATURE_MOTOR_STOP_BIT)).toBe(true);
    expect(hasFeature(mask, FEATURE_ESC_SENSOR_BIT)).toBe(true);
    expect(Array.from(encodeFeatureConfiguration(original, edited))).toEqual([
      0x11, 0x00, 0x00, 0x88,
    ]);
  });

  it('returns no writes for an untouched draft', () => {
    const original = snapshot();
    expect(
      encodeChangedMotorConfiguration(
        original,
        createMotorConfigurationDraft(original),
      ),
    ).toEqual([]);
  });

  it('returns only changed groups in deterministic order', () => {
    const original = snapshot();
    const writes = encodeChangedMotorConfiguration(
      original,
      draft({
        yawMotorsReversed: true,
        motorIdleRaw: 600,
        motorPoleCount: 12,
        feature3dEnabled: false,
      }),
    );
    expect(writes.map(write => write.group)).toEqual([
      'FEATURE',
      'MIXER',
      'MOTOR',
      'ADVANCED',
    ]);
  });

  it('rejects non-integers and never rounds or clamps them', () => {
    const invalid = draft({ motorIdleRaw: 550.5 });
    expect(validateMotorConfigurationDraft(invalid)).toMatchObject({
      valid: false,
      issues: [{ field: 'motorIdleRaw', code: 'NOT_INTEGER' }],
    });
    expect(() => encodeMotorConfiguration(invalid)).toThrow(
      MotorConfigurationEncodeError,
    );
  });

  it('rejects an impossible 3D band', () => {
    expect(
      validateMotorConfigurationDraft(
        draft({ deadband3dLow: 1500, neutral3d: 1460 }),
      ),
    ).toMatchObject({
      valid: false,
      issues: [{ field: 'neutral3d', code: 'INVALID_3D_BAND' }],
    });
  });

  it('rejects bidirectional DShot telemetry on a non-DSHOT protocol', () => {
    expect(
      validateMotorConfigurationDraft(
        draft({ motorProtocolRaw: 0, dshotTelemetryEnabled: true }),
      ),
    ).toMatchObject({
      valid: false,
      issues: [
        {
          field: 'dshotTelemetryEnabled',
          code: 'DSHOT_TELEMETRY_REQUIRES_DSHOT',
        },
      ],
    });
  });
});
