/**
 * MAY THIS APPLICATION SEND AN ESC DIRECTION COMMAND FOR THIS MOTOR?
 *
 * WHY A SEPARATE PREDICATE FROM IDENTIFICATION. Physical identification is
 * unavailable on a hex because the shipped airframe TEMPLATE describes a
 * Quad X and nothing else. Direction commanding is unavailable on a hex
 * for a completely different reason: the motor-test facade this screen
 * calls is scoped to `MOTOR_VECTOR_MOTOR_COUNT` outputs and refuses any
 * other scope outright. Borrowing one limitation to explain the other
 * would give the operator a true-sounding sentence for the wrong reason.
 *
 * THE GATES MIRRORED HERE are the ones that actually run, in the order
 * they run, so the UI can name the first failure instead of guessing:
 *
 *   assertSupportedMotorScope (betaflightMotorVectorsV147.ts)
 *     1. FEATURE_3D enabled            -> refused
 *     2. motorCount != MOTOR_VECTOR_MOTOR_COUNT -> refused
 *     3. protocol outside the reviewed DShot family -> refused
 *   MotorTestController.setEscDirection
 *     4. motorNumber outside 1..MOTOR_VECTOR_MOTOR_COUNT -> INVALID_MOTOR
 *     5. activation not allowed        -> NOT_READY
 *     6. a pulse, stop or direction change in flight -> BUSY
 *
 * THIS PREDICATE AUTHORISES NOTHING. It is a presentation aid so a
 * disabled control can say WHY. The controller re-checks every one of
 * these itself, against live state, at the moment of the command - and a
 * disagreement between the two is a UI bug, never an opening.
 */

import {
  MOTOR_VECTOR_MOTOR_COUNT,
  type MotorVectorScope,
} from '../firmware-adapters/betaflightMotorVectorsV147';
// The SAME list the adapter compares against, imported from the SAME
// declaration site so the two can never drift apart.
import {MOTOR_PROTOCOL_RAWS_BETAFLIGHT_API_1_46_TO_1_48} from '../protocol/msp/decoding/decodeAdvancedConfig';

export type MotorDirectionCommandCapability =
  | {readonly kind: 'AVAILABLE'}
  | {
      readonly kind: 'UNAVAILABLE';
      readonly reason:
        /** No motor-test session is open. */
        | 'NO_SESSION'
        /** Nothing has been read from the flight controller yet. */
        | 'SCOPE_UNKNOWN'
        /** 3D mode inverts stop semantics; the reviewed path excludes it. */
        | 'THREE_D_ENABLED'
        /** The command path is scoped to a fixed number of outputs. */
        | 'MOTOR_COUNT_OUT_OF_SCOPE'
        /** Not a reviewed DShot-family protocol. */
        | 'PROTOCOL_UNSUPPORTED'
        /** The selected motor is outside the command path's range. */
        | 'MOTOR_OUT_OF_RANGE'
        /** The safety gate has not admitted commands. */
        | 'NOT_READY';
    };

export interface MotorDirectionCapabilityInput {
  /** False when no operator port or connection session exists at all. */
  readonly hasSession: boolean;
  readonly motorNumber: number;
  /**
   * THE DECODED SCOPE, PASSED WHOLE AND UNREAD BY THE CALLER.
   *
   * Deliberately not three named fields. MotorsScreen is guarded against
   * even SPELLING a safety identifier - a screen that can name one is one
   * edit away from deciding on it - so the field-level knowledge lives
   * here, in the module whose job it is, and the screen hands the object
   * through without looking inside.
   */
  readonly scope: MotorVectorScope | undefined;
  /** The controller's own activation verdict. */
  readonly activationAllowed: boolean;
}

/** How many outputs the reviewed direction command path covers. */
export const MOTOR_DIRECTION_COMMAND_MAX_MOTORS = MOTOR_VECTOR_MOTOR_COUNT;

export function evaluateMotorDirectionCommandCapability(
  input: MotorDirectionCapabilityInput,
): MotorDirectionCommandCapability {
  const unavailable = (
    reason: Extract<
      MotorDirectionCommandCapability,
      {kind: 'UNAVAILABLE'}
    >['reason'],
  ): MotorDirectionCommandCapability =>
    Object.freeze({kind: 'UNAVAILABLE' as const, reason});

  if (!input.hasSession) {
    return unavailable('NO_SESSION');
  }
  const scope = input.scope;
  if (scope === undefined) {
    return unavailable('SCOPE_UNKNOWN');
  }
  // Same order the adapter uses. 3D first, because it changes what a stop
  // value even means.
  if (scope.feature3dEnabled) {
    return unavailable('THREE_D_ENABLED');
  }
  if (
    !Number.isInteger(scope.motorCount) ||
    scope.motorCount !== MOTOR_DIRECTION_COMMAND_MAX_MOTORS
  ) {
    return unavailable('MOTOR_COUNT_OUT_OF_SCOPE');
  }
  if (
    !MOTOR_PROTOCOL_RAWS_BETAFLIGHT_API_1_46_TO_1_48.includes(
      scope.motorProtocolRaw,
    )
  ) {
    return unavailable('PROTOCOL_UNSUPPORTED');
  }
  if (
    !Number.isInteger(input.motorNumber) ||
    input.motorNumber < 1 ||
    input.motorNumber > MOTOR_DIRECTION_COMMAND_MAX_MOTORS
  ) {
    return unavailable('MOTOR_OUT_OF_RANGE');
  }
  if (!input.activationAllowed) {
    return unavailable('NOT_READY');
  }
  return Object.freeze({kind: 'AVAILABLE' as const});
}
