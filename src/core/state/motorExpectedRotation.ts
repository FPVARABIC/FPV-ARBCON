/**
 * M-F2 - THE EXPECTED ROTATION OF EACH MOTOR, FROM THE MIXER TABLE.
 *
 * WHAT THIS IS. For a given mixer and a given yaw_motors_reversed flag,
 * which way each motor is REQUIRED to spin for the aircraft to have yaw
 * authority. It is a statement about the CONFIGURATION - the same kind of
 * statement the airframe drawing makes about positions - and never a
 * claim that any propeller actually turns that way. Only a person looking
 * at the aircraft can establish the physical rotation, and the
 * verification workflow is where that observation lives.
 *
 * WHERE THE DATA COMES FROM. mixer_init.c @ 7348054f gives every mixer a
 * table of per-motor { throttle, roll, pitch, yaw } coefficients. The YAW
 * column is transcribed below, sign for sign, with the firmware's own row
 * comment kept beside each entry. The roll/pitch columns of the same
 * tables are already transcribed in motorAirframeLayout.ts (positions);
 * this module is the other axis of the same source, kept separate because
 * a position is drawable for mixers whose rotation is NOT determined
 * (a tricopter yaws with its tail servo, so its motor yaw entries are all
 * zero and no rotation claim exists to make).
 *
 * THE SIGN CONVENTION, AND WHY IT IS NOT GUESSED. Two rows of the same
 * source file pin it independently:
 *
 *   1. mixerY4's own comments name the default rotation in text:
 *        { 1.0f,  0.0f,  1.0f, -1.0f },   // REAR_TOP CW
 *        { 1.0f,  0.0f,  1.0f,  1.0f },   // REAR_BOTTOM CCW
 *      So at yaw_motors_reversed = false: yaw -1 means CW, +1 means CCW
 *      (viewed from above).
 *   2. The shipped Quad X expectation (MOTOR_TEST_EXPECTED_CONFIGURATION,
 *      the accepted props-out reference) inverts exactly that mapping on
 *      mixerQuadX's yaw column (-1,+1,+1,-1 -> CCW,CW,CW,CCW), which is
 *      what yaw_motors_reversed = true does.
 *
 *   The physics agrees: positive yaw is nose-right; a clockwise propeller
 *   exerts an anticlockwise reaction torque on the frame, so speeding it
 *   up drives yaw negative - its yaw coefficient is negative.
 *
 * A ZERO IS AN ABSENCE, NEVER A DEFAULT. A motor whose yaw coefficient is
 * zero (every tricopter motor, both bicopter motors, Y4's two front
 * motors, single-prop wings and planes) has no mixer-determined rotation:
 * the firmware does not constrain it, so this module answers undefined
 * and nothing downstream may draw an arrow for it. mixerY4's front rows
 * do carry direction comments, but their yaw entries are zero - the
 * comment describes the conventional build, not a mixer requirement - so
 * they are deliberately NOT claimed here.
 *
 * yaw_motors_reversed IS A CONFIGURATION FLAG, NOT A MEASUREMENT. It is
 * MSP_MIXER_CONFIG offset 1 as stored by the flight controller. Flipping
 * it flips every non-zero expectation below ("props in" vs "props out"
 * builds); it proves nothing about how any propeller is mounted.
 */

import type {MotorRotationDirection} from './motorVerificationModel';

/* Mixer ids, from mixerMode_e (mixer.h @ 7348054f) - same spelling as
 * motorAirframeLayout.ts so the two transcriptions read side by side. */
const TRI = 1;
const QUADP = 2;
const QUADX = 3;
const BICOPTER = 4;
const Y6 = 6;
const HEX6 = 7;
const FLYING_WING = 8;
const Y4 = 9;
const HEX6X = 10;
const OCTOX8 = 11;
const OCTOFLATP = 12;
const OCTOFLATX = 13;
const AIRPLANE = 14;
const VTAIL4 = 17;
const ATAIL4 = 22;
const QUADX_1234 = 26;
const OCTOX8P = 27;

/**
 * The transcribed YAW column, one entry per motor in table order (motor
 * number = index + 1). Values are kept as written in the firmware -
 * including V-tail's fractional authority - because the SIGN is the
 * claim and rounding it away would hide a transcription error from the
 * cross-checking tests.
 */
const YAW_COEFFICIENTS: ReadonlyMap<number, readonly number[]> = new Map<
  number,
  readonly number[]
>([
  // mixerTricopter - yaw is the tail servo's job; all motor yaw is 0.
  [TRI, Object.freeze([0, 0, 0])],
  // mixerQuadP: REAR -1, RIGHT +1, LEFT +1, FRONT -1.
  [QUADP, Object.freeze([-1, 1, 1, -1])],
  // mixerQuadX: REAR_R -1, FRONT_R +1, REAR_L +1, FRONT_L -1.
  [QUADX, Object.freeze([-1, 1, 1, -1])],
  // mixerBicopter - rotor tilt servos yaw; both motor yaw entries 0.
  [BICOPTER, Object.freeze([0, 0])],
  // mixerY6: REAR +1, RIGHT -1, LEFT -1, UNDER_REAR -1, UNDER_RIGHT +1,
  // UNDER_LEFT +1. Coaxial pairs counter-rotate, as they must.
  [Y6, Object.freeze([1, -1, -1, -1, 1, 1])],
  // mixerHex6P: REAR_R +1, FRONT_R -1, REAR_L +1, FRONT_L -1, FRONT +1,
  // REAR -1.
  [HEX6, Object.freeze([1, -1, 1, -1, 1, -1])],
  // mixerSingleProp via mixers[8] - one motor, yaw 0.
  [FLYING_WING, Object.freeze([0])],
  // mixerY4: REAR_TOP -1 (the firmware's own comment says CW),
  // FRONT_R 0, REAR_BOTTOM +1 (comment: CCW), FRONT_L 0. The front pair
  // is unconstrained by the mixer and stays unclaimed - see the header.
  [Y4, Object.freeze([-1, 0, 1, 0])],
  // mixerHex6X: REAR_R +1, FRONT_R +1, REAR_L -1, FRONT_L -1, RIGHT -1,
  // LEFT +1.
  [HEX6X, Object.freeze([1, 1, -1, -1, -1, 1])],
  // mixerOctoX8: the quad-X pattern on top, inverted underneath.
  [OCTOX8, Object.freeze([-1, 1, 1, -1, 1, -1, -1, 1])],
  // mixerOctoFlatP: four corner motors +1, four axis motors -1.
  [OCTOFLATP, Object.freeze([1, 1, 1, 1, -1, -1, -1, -1])],
  // mixerOctoFlatX: first four rows +1, last four -1.
  [OCTOFLATX, Object.freeze([1, 1, 1, 1, -1, -1, -1, -1])],
  // mixerSingleProp via mixers[14] - one motor, yaw 0.
  [AIRPLANE, Object.freeze([0])],
  // mixerVtail4: REAR_R +1, FRONT_R -0.5, REAR_L -1, FRONT_L +0.5.
  [VTAIL4, Object.freeze([1, -0.5, -1, 0.5])],
  // mixerAtail4: REAR_R -1, FRONT_R +0.5, REAR_L +1, FRONT_L -0.5.
  [ATAIL4, Object.freeze([-1, 0.5, 1, -0.5])],
  // mixerQuadX1234: FRONT_L -1, FRONT_R +1, REAR_R -1, REAR_L +1.
  // NOT the QUADX row above renumbered by hand: it is the firmware's own
  // second table, and its motor 1 is a DIFFERENT corner with a DIFFERENT
  // rotation than QUADX's motor 1.
  [QUADX_1234, Object.freeze([-1, 1, -1, 1])],
  // mixerOctoX8P: the quad-plus pattern on top, inverted underneath.
  [OCTOX8P, Object.freeze([-1, 1, 1, -1, 1, -1, -1, 1])],
]);

/**
 * The expected rotation for one motor, or undefined where the source
 * does not determine one.
 *
 * Undefined when:
 *   - the mixer id is unknown or has no transcribed table (CUSTOM and
 *     friends: their rows live in customMotorMixer and are not readable
 *     here);
 *   - the motor number is outside the table;
 *   - the motor's yaw coefficient is zero (the mixer does not constrain
 *     its rotation);
 *   - `yawMotorsReversed` is not known. Half an answer is not an answer:
 *     the flag flips every expectation, so guessing it would draw exactly
 *     the wrong arrows on exactly the aircraft built the other way.
 */
export function expectedMotorRotation(
  mixerModeRaw: number | undefined,
  motorNumber: number,
  yawMotorsReversed: boolean | undefined,
): MotorRotationDirection | undefined {
  if (mixerModeRaw === undefined || yawMotorsReversed === undefined) {
    return undefined;
  }
  const table = YAW_COEFFICIENTS.get(mixerModeRaw);
  if (table === undefined || !Number.isInteger(motorNumber)) {
    return undefined;
  }
  const yaw = table[motorNumber - 1];
  if (yaw === undefined || yaw === 0) {
    return undefined;
  }
  // Default build: yaw < 0 -> CW, yaw > 0 -> CCW (see header anchors).
  // yaw_motors_reversed inverts the whole aircraft's convention.
  const defaultDirection: MotorRotationDirection = yaw < 0 ? 'CW' : 'CCW';
  if (!yawMotorsReversed) {
    return defaultDirection;
  }
  return defaultDirection === 'CW' ? 'CCW' : 'CW';
}

/** Every mixer id this module can answer for, for tests and for callers
 * that want to know whether arrows are possible at all before asking
 * per motor. */
export const MIXERS_WITH_EXPECTED_ROTATION: readonly number[] = Object.freeze(
  [...YAW_COEFFICIENTS.keys()]
    .filter(mixerId =>
      (YAW_COEFFICIENTS.get(mixerId) ?? []).some(value => value !== 0),
    )
    .sort((left, right) => left - right),
);
