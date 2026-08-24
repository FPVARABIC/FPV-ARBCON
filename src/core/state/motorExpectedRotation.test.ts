/**
 * M-F2 - THE EXPECTED-ROTATION TABLE, CROSS-CHECKED AGAINST EVERYTHING
 * THE REPOSITORY ALREADY KNOWS.
 *
 * The yaw transcription cannot be proven from inside this repository the
 * way roll/pitch can (the drawing makes positions visible; rotation is
 * one bit per motor). So it is pinned three ways instead:
 *
 *   1. against the shipped Quad X props-out expectation, which was
 *      source-traced and reviewed in its own phase;
 *   2. against the firmware's own in-table direction comments (mixerY4
 *      names REAR_TOP CW and REAR_BOTTOM CCW at the default flag);
 *   3. against the structural physics no flat multirotor can escape -
 *      the yaw contributions must cancel, so every transcribed table
 *      must sum to zero.
 */

import {
  MIXERS_WITH_EXPECTED_ROTATION,
  expectedMotorRotation,
} from './motorExpectedRotation';
import {
  MOTOR_TEST_EXPECTED_CONFIGURATION,
  MOTOR_TEST_EXPECTED_MIXER_MODE,
} from './motorVerificationModel';
import {MIXERS_WITH_AUTHORED_LAYOUT, authoredAirframeLayout} from './motorAirframeLayout';

const TRI = 1;
const QUADX = 3;
const Y4 = 9;
const HEX6X = 10;
const OCTOX8 = 11;
const Y6 = 6;
const QUADX_1234 = 26;
const MIXER_CUSTOM = 23;

describe('the anchor: the shipped Quad X props-out reference', () => {
  it('reproduces MOTOR_TEST_EXPECTED_CONFIGURATION exactly, motor by motor', () => {
    // The shipped table is the props-out build, which is
    // yaw_motors_reversed = true. If this fails, the sign convention or
    // the transcription is wrong - never "adjust the expectation".
    for (const expected of MOTOR_TEST_EXPECTED_CONFIGURATION) {
      expect(
        expectedMotorRotation(
          MOTOR_TEST_EXPECTED_MIXER_MODE,
          expected.motorNumber,
          true,
        ),
      ).toBe(expected.direction);
    }
  });

  it('inverts, motor for motor, when the flag flips', () => {
    for (const expected of MOTOR_TEST_EXPECTED_CONFIGURATION) {
      const propsOut = expectedMotorRotation(QUADX, expected.motorNumber, true);
      const propsIn = expectedMotorRotation(QUADX, expected.motorNumber, false);
      expect(propsOut).toBeDefined();
      expect(propsIn).toBeDefined();
      expect(propsIn).not.toBe(propsOut);
    }
  });
});

describe("the firmware's own words: mixerY4's row comments", () => {
  it('REAR_TOP (M1) is CW and REAR_BOTTOM (M3) is CCW at the default flag', () => {
    expect(expectedMotorRotation(Y4, 1, false)).toBe('CW');
    expect(expectedMotorRotation(Y4, 3, false)).toBe('CCW');
  });

  it('the unconstrained front pair claims nothing, in either build', () => {
    // Their yaw coefficients are zero: the firmware comment describes the
    // conventional build, not a mixer requirement, so no arrow.
    for (const reversed of [false, true]) {
      expect(expectedMotorRotation(Y4, 2, reversed)).toBeUndefined();
      expect(expectedMotorRotation(Y4, 4, reversed)).toBeUndefined();
    }
  });
});

describe('structural physics: yaw authority balances', () => {
  it('every mixer with expectations pairs its CW and CCW motors equally', () => {
    for (const mixerId of MIXERS_WITH_EXPECTED_ROTATION) {
      const layout = authoredAirframeLayout(
        mixerId,
        expectedLayoutMotors(mixerId),
      );
      if (layout === undefined) {
        continue;
      }
      let clockwise = 0;
      let anticlockwise = 0;
      for (const placement of layout.placements) {
        const direction = expectedMotorRotation(
          mixerId,
          placement.motorNumber,
          false,
        );
        if (direction === 'CW') clockwise += 1;
        if (direction === 'CCW') anticlockwise += 1;
      }
      // V-tail and A-tail carry asymmetric MAGNITUDES but still one pair
      // each way; every symmetric multirotor is exactly half and half.
      expect(clockwise).toBe(anticlockwise);
    }
  });
});

/** The 1..N list an authored layout expects, for the physics sweep. */
function expectedLayoutMotors(mixerId: number): readonly number[] {
  for (let count = 1; count <= 8; count += 1) {
    const motors = Array.from({length: count}, (_unused, index) => index + 1);
    if (authoredAirframeLayout(mixerId, motors) !== undefined) {
      return motors;
    }
  }
  return [];
}

describe('what is deliberately not claimed', () => {
  it('a tricopter motor has no expected rotation - the tail servo yaws', () => {
    for (const motor of [1, 2, 3]) {
      expect(expectedMotorRotation(TRI, motor, false)).toBeUndefined();
      expect(expectedMotorRotation(TRI, motor, true)).toBeUndefined();
    }
  });

  it('an unknown flag is half an answer and yields none', () => {
    expect(expectedMotorRotation(QUADX, 1, undefined)).toBeUndefined();
  });

  it('an unknown or custom mixer yields none', () => {
    expect(expectedMotorRotation(undefined, 1, false)).toBeUndefined();
    expect(expectedMotorRotation(MIXER_CUSTOM, 1, false)).toBeUndefined();
    expect(expectedMotorRotation(199, 1, false)).toBeUndefined();
  });

  it('a motor number outside the table yields none', () => {
    expect(expectedMotorRotation(QUADX, 5, false)).toBeUndefined();
    expect(expectedMotorRotation(QUADX, 0, false)).toBeUndefined();
  });
});

describe('QUADX_1234 is its own aircraft numbering', () => {
  it('motor 1 (FRONT_L) rotates opposite to QUADX motor 1 (REAR_R)... no - it matches by POSITION, not by number', () => {
    /*
     * The two tables describe the SAME physical airframe, so the same
     * CORNER carries the same rotation - and the same NUMBER does not.
     * QUADX M1 is REAR_R; QUADX_1234 M3 is REAR_R. Both must agree.
     * QUADX_1234 M1 is FRONT_L, which on a quad X shares REAR_R's
     * direction (diagonals pair) - so the number-for-number comparison
     * happens to agree for 1 and disagree for 2/4... asserting the
     * POSITION identity is the claim that cannot pass by accident.
     */
    const quadx = authoredAirframeLayout(QUADX, [1, 2, 3, 4]);
    const renumbered = authoredAirframeLayout(QUADX_1234, [1, 2, 3, 4]);
    expect(quadx).toBeDefined();
    expect(renumbered).toBeDefined();
    for (const placement of renumbered?.placements ?? []) {
      const sameCorner = quadx?.placements.find(
        candidate =>
          candidate.x === placement.x && candidate.y === placement.y,
      );
      expect(sameCorner).toBeDefined();
      expect(
        expectedMotorRotation(QUADX_1234, placement.motorNumber, false),
      ).toBe(
        expectedMotorRotation(QUADX, sameCorner?.motorNumber ?? -1, false),
      );
    }
  });

  it('is not a copy of the QUADX rows: motor 2 differs from motor-2-of-QUADX by corner', () => {
    // QUADX M2 is FRONT_R; QUADX_1234 M2 is also FRONT_R - the FIRMWARE
    // tables happen to agree there. The distinguishing pair is M1/M3:
    expect(expectedMotorRotation(QUADX, 1, false)).toBe('CW'); // REAR_R
    expect(expectedMotorRotation(QUADX_1234, 1, false)).toBe('CW'); // FRONT_L (diagonal of REAR_R)
    expect(expectedMotorRotation(QUADX, 3, false)).toBe('CCW'); // REAR_L
    expect(expectedMotorRotation(QUADX_1234, 3, false)).toBe('CW'); // REAR_R
  });
});

describe('coaxial aircraft counter-rotate within each arm', () => {
  it.each([
    ['Y6', Y6, [[1, 4], [2, 5], [3, 6]] as const],
    ['OCTOX8', OCTOX8, [[1, 5], [2, 6], [3, 7], [4, 8]] as const],
  ])('%s upper and lower rotors oppose', (_name, mixerId, pairs) => {
    for (const [upper, lower] of pairs as ReadonlyArray<readonly number[]>) {
      const top = expectedMotorRotation(mixerId, upper ?? -1, false);
      const bottom = expectedMotorRotation(mixerId, lower ?? -1, false);
      expect(top).toBeDefined();
      expect(bottom).toBeDefined();
      expect(top).not.toBe(bottom);
    }
  });
});

describe('the roster', () => {
  it('claims rotation only where the drawing also exists or the table is quoted', () => {
    // Every mixer with expectations is an authored-layout mixer: an arrow
    // with no aircraft to sit on has nowhere truthful to render.
    for (const mixerId of MIXERS_WITH_EXPECTED_ROTATION) {
      expect(MIXERS_WITH_AUTHORED_LAYOUT).toContain(mixerId);
    }
  });

  it('HEX6X carries the transcribed alternation, not a quad pattern stretched', () => {
    expect(
      [1, 2, 3, 4, 5, 6].map(motor =>
        expectedMotorRotation(HEX6X, motor, false),
      ),
    ).toEqual(['CCW', 'CCW', 'CW', 'CW', 'CW', 'CCW']);
  });
});
