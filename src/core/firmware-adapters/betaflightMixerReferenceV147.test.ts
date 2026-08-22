/**
 * M-B - the mixer reference table, checked against an INDEPENDENT
 * transcription of Betaflight firmware commit 7348054f (FC 2025.12.5,
 * MSP API 1.47).
 *
 * WHY THE EXPECTATIONS ARE WRITTEN OUT IN FULL AND IN A DIFFERENT SHAPE.
 * The table below was transcribed by hand from the firmware sources named
 * against each column, as tuples rather than as the module's own object
 * shape, and it is compared field by field. It is NOT derived from
 * BETAFLIGHT_MIXER_REFERENCE_V147, not mapped from it and not generated
 * by anything. A fixture produced from the module under test proves only
 * that the module equals itself.
 *
 * COLUMNS, and the exact source each was read from at 7348054f:
 *   motors  - mixers[] motorCount (mixer_init.c:253-283) for a non-custom
 *             mode; 'custom' where mixerConfigureOutput()'s first branch
 *             (mixer_init.c:426-437) claims the mode.
 *   servos  - the number of writeServoWithTracking() calls the mode's
 *             branch in writeServos() makes (servos.c:342-404), plus the
 *             gimbal block's two for MIXER_GIMBAL (servos.c:400-403).
 *   family  - argued per mode in the module's AirframeFamily doc comment.
 *   svo     - mixers[] useServo (mixer_init.c:253-283).
 *   fw      - mixerModeIsFixedWing() (mixer_init.c:517-530).
 *   tri     - mixerIsTricopter() (mixer_init.c:325-328).
 *   rewrite - validateAndFixConfig() (config.c:209-217) substitution on a
 *             standard build, or null.
 */

import fs from 'fs';
import path from 'path';

import {
  BETAFLIGHT_MIXER_REFERENCE_V147,
  CUSTOM_MIXER_IS_CLI_ONLY,
  findMixerReference,
  mixerHasAuthoredPositionalLayout,
  MIXER_MODE_MAX,
  MIXER_MODE_MIN,
  MIXER_REFERENCE_MAX_SUPPORTED_MOTORS,
  MIXER_REFERENCE_MAX_SUPPORTED_SERVOS,
  MIXERS_WITH_AUTHORED_POSITIONAL_LAYOUT,
  type AirframeFamily,
} from './betaflightMixerReferenceV147';

type ExpectedMotors = number | 'custom';
type ExpectedRewrite = null | [toMixerId: number, rule: string];

type Row = readonly [
  mixerId: number,
  firmwareName: string,
  motors: ExpectedMotors,
  servos: number,
  family: AirframeFamily,
  useServo: boolean,
  fixedWing: boolean,
  tricopter: boolean,
  rewrite: ExpectedRewrite,
];

const MOTOR_COUNT_WITHOUT_MOTOR_TABLE = 'MOTOR_COUNT_WITHOUT_MOTOR_TABLE';
const USE_SERVO_WITHOUT_SERVO_RULES = 'USE_SERVO_WITHOUT_SERVO_RULES';
const MIXER_CUSTOM = 23;
const MIXER_CUSTOM_AIRPLANE = 24;

const HAND_TRANSCRIBED: readonly Row[] = [
  [1, 'TRI', 3, 1, 'MIXED_ACTUATOR', true, false, true, null],
  [2, 'QUADP', 4, 0, 'MULTIROTOR', false, false, false, null],
  [3, 'QUADX', 4, 0, 'MULTIROTOR', false, false, false, null],
  [4, 'BICOPTER', 2, 2, 'MIXED_ACTUATOR', true, false, false, null],
  [5, 'GIMBAL', 0, 2, 'SERVO_ONLY', true, false, false, null],
  [6, 'Y6', 6, 0, 'MULTIROTOR', false, false, false, null],
  [7, 'HEX6', 6, 0, 'MULTIROTOR', false, false, false, null],
  [8, 'FLYING_WING', 1, 2, 'FIXED_WING', true, true, false, null],
  [9, 'Y4', 4, 0, 'MULTIROTOR', false, false, false, null],
  [10, 'HEX6X', 6, 0, 'MULTIROTOR', false, false, false, null],
  [11, 'OCTOX8', 8, 0, 'MULTIROTOR', false, false, false, null],
  [12, 'OCTOFLATP', 8, 0, 'MULTIROTOR', false, false, false, null],
  [13, 'OCTOFLATX', 8, 0, 'MULTIROTOR', false, false, false, null],
  [14, 'AIRPLANE', 1, 6, 'FIXED_WING', true, true, false, null],
  [15, 'HELI_120_CCPM', 1, 4, 'ROTORCRAFT_OTHER', true, false, false, null],
  [
    16,
    'HELI_90_DEG',
    0,
    0,
    'ROTORCRAFT_OTHER',
    true,
    false,
    false,
    [MIXER_CUSTOM_AIRPLANE, USE_SERVO_WITHOUT_SERVO_RULES],
  ],
  [17, 'VTAIL4', 4, 0, 'MULTIROTOR', false, false, false, null],
  [18, 'HEX6H', 6, 0, 'MULTIROTOR', false, false, false, null],
  [
    19,
    'PPM_TO_SERVO',
    0,
    0,
    'SERVO_ONLY',
    true,
    false,
    false,
    [MIXER_CUSTOM_AIRPLANE, USE_SERVO_WITHOUT_SERVO_RULES],
  ],
  [20, 'DUALCOPTER', 2, 2, 'MIXED_ACTUATOR', true, false, false, null],
  [
    21,
    'SINGLECOPTER',
    1,
    4,
    'MIXED_ACTUATOR',
    true,
    false,
    false,
    [MIXER_CUSTOM, MOTOR_COUNT_WITHOUT_MOTOR_TABLE],
  ],
  [22, 'ATAIL4', 4, 0, 'MULTIROTOR', false, false, false, null],
  [23, 'CUSTOM', 'custom', 0, 'CUSTOM', false, false, false, null],
  [24, 'CUSTOM_AIRPLANE', 'custom', 6, 'FIXED_WING', true, true, false, null],
  [25, 'CUSTOM_TRI', 'custom', 1, 'MIXED_ACTUATOR', true, false, true, null],
  [26, 'QUADX_1234', 4, 0, 'MULTIROTOR', false, false, false, null],
  [27, 'OCTOX8P', 8, 0, 'MULTIROTOR', false, false, false, null],
];

describe('betaflightMixerReferenceV147 - the pinned table', () => {
  it('covers exactly the 27 mixer modes of mixerMode_e, with no gaps', () => {
    expect(BETAFLIGHT_MIXER_REFERENCE_V147).toHaveLength(27);
    expect(MIXER_MODE_MIN).toBe(1);
    expect(MIXER_MODE_MAX).toBe(27);
    const ids = BETAFLIGHT_MIXER_REFERENCE_V147.map(row => row.mixerId);
    expect(ids).toEqual(Array.from({length: 27}, (_, index) => index + 1));
  });

  it('carries the firmware maxima as named constants', () => {
    expect(MIXER_REFERENCE_MAX_SUPPORTED_MOTORS).toBe(8);
    expect(MIXER_REFERENCE_MAX_SUPPORTED_SERVOS).toBe(8);
  });

  it.each(HAND_TRANSCRIBED)(
    'mixer %i (%s) matches the hand-transcribed firmware reading',
    (
      mixerId,
      firmwareName,
      motors,
      servos,
      family,
      useServo,
      fixedWing,
      tricopter,
      rewrite,
    ) => {
      const row = findMixerReference(mixerId);
      expect(row).toBeDefined();
      if (row === undefined) {
        return;
      }
      expect(row.firmwareName).toBe(firmwareName);
      expect(row.family).toBe(family);
      expect(row.tableUseServo).toBe(useServo);
      expect(row.firmwareFixedWingPredicate).toBe(fixedWing);
      expect(row.firmwareTricopterPredicate).toBe(tricopter);

      if (motors === 'custom') {
        expect(row.motorCountStrategy).toEqual({kind: 'CUSTOM_RUNTIME_DERIVED'});
      } else if (motors === 0) {
        expect(row.motorCountStrategy).toEqual({kind: 'NO_MOTORS'});
      } else {
        expect(row.motorCountStrategy).toEqual({kind: 'TABLE_FIXED', count: motors});
      }

      if (servos === 0) {
        expect(row.baseServoOutputs).toEqual({kind: 'NO_SERVOS'});
      } else {
        expect(row.baseServoOutputs).toEqual({kind: 'TABLE_FIXED', count: servos});
      }

      if (rewrite === null) {
        expect(row.configValidationRewrite).toBeUndefined();
      } else {
        expect(row.configValidationRewrite).toEqual({
          toMixerId: rewrite[0],
          rule: rewrite[1],
        });
      }
    },
  );

  it('never claims more motors or servos than the firmware maxima', () => {
    for (const row of BETAFLIGHT_MIXER_REFERENCE_V147) {
      if (row.motorCountStrategy.kind === 'TABLE_FIXED') {
        expect(row.motorCountStrategy.count).toBeLessThanOrEqual(
          MIXER_REFERENCE_MAX_SUPPORTED_MOTORS,
        );
      }
      if (row.baseServoOutputs.kind === 'TABLE_FIXED') {
        expect(row.baseServoOutputs.count).toBeLessThanOrEqual(
          MIXER_REFERENCE_MAX_SUPPORTED_SERVOS,
        );
      }
    }
  });

  it('is frozen, so a consumer cannot edit the reference in place', () => {
    expect(Object.isFrozen(BETAFLIGHT_MIXER_REFERENCE_V147)).toBe(true);
    for (const row of BETAFLIGHT_MIXER_REFERENCE_V147) {
      expect(Object.isFrozen(row)).toBe(true);
      expect(Object.isFrozen(row.motorCountStrategy)).toBe(true);
    }
  });
});

/**
 * P0-A. M-A's own report contained two incompatible answers: one section
 * said all three custom modes derive their count by walking
 * customMotorMixer(), another listed CUSTOM_TRI as a fixed three-motor
 * airframe. The second was wrong, and these tests pin the reason so the
 * wrong answer cannot come back.
 *
 * mixerConfigureOutput() (mixer_init.c:422-451 @ 7348054f) tests all
 * THREE custom modes in one condition and returns from that branch. The
 * else-branch that reads mixers[mode].motorCount is unreachable for them,
 * so `{1, true, NULL}` at MIXER_CUSTOM_AIRPLANE and `{3, true, NULL}` at
 * MIXER_CUSTOM_TRI are dead numbers. `mmix reset` (cli.c:1856-1859) zeroes
 * all eight rows, which makes CUSTOM_TRI a ZERO-motor mixer at the next
 * boot - so 3 is not even a default.
 */
describe('betaflightMixerReferenceV147 - P0-A, the three custom modes', () => {
  it.each([
    [23, 'CUSTOM'],
    [24, 'CUSTOM_AIRPLANE'],
    [25, 'CUSTOM_TRI'],
  ])('mixer %i (%s) derives its motor count at runtime, never from the table', (id, name) => {
    const row = findMixerReference(id);
    expect(row?.firmwareName).toBe(name);
    expect(row?.motorCountStrategy).toEqual({kind: 'CUSTOM_RUNTIME_DERIVED'});
  });

  it('records no fixed count of 3 for CUSTOM_TRI and none of 1 for CUSTOM_AIRPLANE', () => {
    const customTri = findMixerReference(25);
    const customAirplane = findMixerReference(24);
    expect(JSON.stringify(customTri?.motorCountStrategy)).not.toContain('3');
    expect(JSON.stringify(customAirplane?.motorCountStrategy)).not.toContain('1');
  });

  it('states that the custom rows are unreadable over MSP rather than guessing them', () => {
    expect(CUSTOM_MIXER_IS_CLI_ONLY).toContain('CLI');
    expect(CUSTOM_MIXER_IS_CLI_ONLY).toContain('mmix');
    expect(CUSTOM_MIXER_IS_CLI_ONLY).toContain('never predicted');
  });

  it('still classifies the custom airframes the firmware itself classifies', () => {
    // Count strategy and family are independent axes: CUSTOM_AIRPLANE is
    // named by mixerModeIsFixedWing() and CUSTOM_TRI by mixerIsTricopter(),
    // whatever their counts turn out to be.
    expect(findMixerReference(24)?.family).toBe('FIXED_WING');
    expect(findMixerReference(24)?.firmwareFixedWingPredicate).toBe(true);
    expect(findMixerReference(25)?.family).toBe('MIXED_ACTUATOR');
    expect(findMixerReference(25)?.firmwareTricopterPredicate).toBe(true);
    // MIXER_CUSTOM is the one mode the firmware declines to classify.
    expect(findMixerReference(23)?.family).toBe('CUSTOM');
  });
});

/**
 * P0-C. The families are asserted as a partition, and specifically NOT as
 * "not fixed wing implies multirotor" - the rule this project refused to
 * adopt, because it files helicopters, gimbals, a servo relay, bicopters,
 * dualcopters and singlecopters as quadcopters.
 */
describe('betaflightMixerReferenceV147 - P0-C, explicit airframe families', () => {
  const idsOf = (family: AirframeFamily): number[] =>
    BETAFLIGHT_MIXER_REFERENCE_V147.filter(row => row.family === family).map(
      row => row.mixerId,
    );

  it('assigns MULTIROTOR only to the motor-only mixers', () => {
    expect(idsOf('MULTIROTOR')).toEqual([2, 3, 6, 7, 9, 10, 11, 12, 13, 17, 18, 22, 26, 27]);
  });

  it('assigns FIXED_WING to exactly the modes mixerModeIsFixedWing names', () => {
    expect(idsOf('FIXED_WING')).toEqual([8, 14, 24]);
    for (const row of BETAFLIGHT_MIXER_REFERENCE_V147) {
      expect(row.firmwareFixedWingPredicate).toBe(row.family === 'FIXED_WING');
    }
  });

  it('keeps helicopters, servo-only rigs and mixed-actuator airframes out of MULTIROTOR', () => {
    expect(idsOf('ROTORCRAFT_OTHER')).toEqual([15, 16]);
    expect(idsOf('SERVO_ONLY')).toEqual([5, 19]);
    expect(idsOf('MIXED_ACTUATOR')).toEqual([1, 4, 20, 21, 25]);
    expect(idsOf('CUSTOM')).toEqual([23]);
  });

  it('partitions all 27 modes with no mode left UNKNOWN', () => {
    const counted =
      idsOf('MULTIROTOR').length +
      idsOf('FIXED_WING').length +
      idsOf('ROTORCRAFT_OTHER').length +
      idsOf('SERVO_ONLY').length +
      idsOf('MIXED_ACTUATOR').length +
      idsOf('CUSTOM').length;
    expect(counted).toBe(27);
    expect(idsOf('UNKNOWN')).toEqual([]);
  });

  it('never derives a family from "not fixed wing"', () => {
    const notFixedWing = BETAFLIGHT_MIXER_REFERENCE_V147.filter(
      row => !row.firmwareFixedWingPredicate,
    );
    const asMultirotor = notFixedWing.filter(row => row.family === 'MULTIROTOR');
    // 24 modes are not fixed wing; only 14 of them are multirotors. If the
    // rejected shortcut had been used these two numbers would be equal.
    expect(notFixedWing).toHaveLength(24);
    expect(asMultirotor).toHaveLength(14);
  });
});

describe('betaflightMixerReferenceV147 - lookup and layout', () => {
  it('returns undefined for an id outside the pinned table instead of a default', () => {
    for (const id of [-1, 0, 28, 255, 1.5, Number.NaN]) {
      expect(findMixerReference(id)).toBeUndefined();
    }
  });

  it('claims an authored positional layout only for the two quad-X mixers', () => {
    expect([...MIXERS_WITH_AUTHORED_POSITIONAL_LAYOUT].sort((a, b) => a - b)).toEqual([3, 26]);
    expect(mixerHasAuthoredPositionalLayout(3)).toBe(true);
    expect(mixerHasAuthoredPositionalLayout(26)).toBe(true);
    for (const row of BETAFLIGHT_MIXER_REFERENCE_V147) {
      if (row.mixerId !== 3 && row.mixerId !== 26) {
        expect(mixerHasAuthoredPositionalLayout(row.mixerId)).toBe(false);
      }
    }
  });
});

/**
 * The reference model must stay a description of topology. It carries no
 * mixer coefficients, because this application never computes a mix, and
 * the coefficient tables are the part of the upstream sources that is
 * closest to transcription.
 */
describe('betaflightMixerReferenceV147 - what it deliberately does not hold', () => {
  const ROOT = path.resolve(__dirname, '..', '..', '..');
  const source = fs
    .readFileSync(
      path.join(ROOT, 'src/core/firmware-adapters/betaflightMixerReferenceV147.ts'),
      'utf8',
    )
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');

  it.each([
    ['a mixer coefficient field', /\b(throttle|roll|pitch|yaw)\s*:/i],
    ['a mix table', /\bmixTable\b/],
    ['a float coefficient literal', /-?\d\.\d+f?\s*,\s*-?\d\.\d+/],
    ['a rotation direction', /\b(clockwise|counterClockwise|cw|ccw|rotationDirection)\b/i],
  ])('holds no %s', (_label, pattern) => {
    expect(source).not.toMatch(pattern);
  });

  it('holds no Arabic text - the core emits no user-facing prose', () => {
    expect(source).not.toMatch(/[؀-ۿ]/);
  });
});
