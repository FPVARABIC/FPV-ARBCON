/**
 * IS THE QUAD-X IDENTIFICATION MODEL APPLICABLE TO THIS AIRCRAFT AT ALL?
 *
 * WHY THIS EXISTS. `MOTOR_TEST_EXPECTED_CONFIGURATION` describes exactly
 * four outputs on four Quad-X arms, and everything built on it inherits
 * that shape: the verification entries, the four physical positions the
 * wizard offers, and the reorder proposal derived from those observations.
 * Motor CONTROL, by contrast, is already dynamic - the workspace renders a
 * slider per output from the count the flight controller reports.
 *
 * So on a hex or an octo the screen would ask an operator to place motors
 * on arms the airframe does not have, and would then offer to write a
 * mapping derived from those answers. That is not a layout problem. It is
 * the app claiming a physical identity it has no model for.
 *
 * WHAT THIS MODULE DOES, AND ALL IT DOES. It answers one question from one
 * fact, so the UI has a single place to consult instead of comparing
 * numbers at each call site. It performs no I/O, imports no controller and
 * decides nothing about motor commands: an unsupported result withdraws
 * POSITION CLAIMS ONLY. Numbered motor control stays available, because a
 * numbered output is addressable without knowing which arm it drives.
 *
 * UNKNOWN IS NOT SUPPORTED. A missing count is not a quad until proven
 * otherwise; treating it as one would restore the exact assumption this
 * module exists to remove.
 *
 * NOT A GENERALISED MODEL. Widening identification beyond Quad X is a
 * separate piece of work with its own airframe truth to establish. This
 * file only stops the current model from being applied where it does not
 * hold.
 */

import {MOTOR_TEST_EXPECTED_CONFIGURATION} from './motorVerificationModel';

/** How many outputs the shipped physical-identification model describes. */
export const MOTOR_IDENTIFICATION_MODEL_OUTPUT_COUNT =
  MOTOR_TEST_EXPECTED_CONFIGURATION.length;

export type MotorIdentificationCapability =
  /** The reported output count matches the model, so its four physical
   * positions can be offered. This is still an EXPECTATION about a Quad X
   * airframe, never a measurement - it says the model MAY apply, not that
   * the aircraft is wired the way the model describes. */
  | {readonly kind: 'SUPPORTED'}
  /** No output count has been read from the flight controller yet. */
  | {readonly kind: 'UNSUPPORTED'; readonly reason: 'MOTOR_COUNT_UNKNOWN'}
  /** A count was read and it is not the one the model describes. */
  | {
      readonly kind: 'UNSUPPORTED';
      readonly reason: 'MOTOR_COUNT_MISMATCH';
      readonly motorCount: number;
    };

/**
 * Total and pure. `motorCount` is the live figure the flight controller
 * reported (MSP_MOTOR_CONFIG's `getMotorCount()`), or undefined when
 * nothing has been read.
 */
export function evaluateMotorIdentificationCapability(
  motorCount: number | undefined,
): MotorIdentificationCapability {
  if (
    motorCount === undefined ||
    !Number.isInteger(motorCount) ||
    motorCount <= 0
  ) {
    // A zero, negative or fractional count is not a usable fact either, and
    // it must not be allowed to coincide with the model by accident.
    return Object.freeze({
      kind: 'UNSUPPORTED' as const,
      reason: 'MOTOR_COUNT_UNKNOWN' as const,
    });
  }
  if (motorCount !== MOTOR_IDENTIFICATION_MODEL_OUTPUT_COUNT) {
    return Object.freeze({
      kind: 'UNSUPPORTED' as const,
      reason: 'MOTOR_COUNT_MISMATCH' as const,
      motorCount,
    });
  }
  return Object.freeze({kind: 'SUPPORTED' as const});
}
