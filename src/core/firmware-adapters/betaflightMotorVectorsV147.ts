/**
 * Pass 1B - pure Betaflight API-1.47 motor VECTOR logic: which logical
 * external values belong in an MSP_SET_MOTOR request, for the one
 * narrowly approved configuration.
 *
 * PURE AND UNREACHABLE. No I/O, no transport, no MspClient, no timers,
 * no React/React Native, no state. Nothing in this repository calls it.
 * Producing a vector is inert; it becomes a motor command only if some
 * future, separately-approved code sends it, which Pass 1B does not
 * authorize.
 *
 * APPROVED SCOPE, ENFORCED NOT ASSUMED: exactly four motors, DSHOT600
 * only, 3D mode disabled. Anything else is rejected before a single
 * value is produced.
 *
 * WHY 3D IS A HARD REJECT, from drivers/dshot.c:75-94 @
 * BETAFLIGHT_2025_12_2_COMMIT (79065c96ba0bb5cdc675e67d7093e05dab8b330e):
 *
 *     if (featureIsEnabled(FEATURE_3D)) {
 *         if (externalValue == PWM_RANGE_MIDDLE) { motorValue = DSHOT_CMD_MOTOR_STOP; }
 *         else if (externalValue < PWM_RANGE_MIDDLE) { ... reverse ... }
 *         else { ... forward ... }
 *     } else {
 *         motorValue = (externalValue == PWM_RANGE_MIN) ? DSHOT_CMD_MOTOR_STOP : ...
 *     }
 *
 * With 3D enabled, stop moves to 1500 and 1000 becomes FULL REVERSE. A
 * stop vector computed for non-3D would therefore command full reverse
 * thrust on a 3D-configured aircraft. That inversion is why the check
 * happens first, and why it throws rather than adapting.
 *
 * WHAT THIS MODULE REFUSES TO DECIDE. It provides NO default,
 * recommended, calculated or fallback active value. A caller must supply
 * the external active value explicitly. It is never derived from
 * motorIdle, from "5.5%", from KV, from battery voltage, from ESC
 * firmware or from motor model. Accepting a value here means only that
 * the number is a legal DShot external value at this API version - never
 * that it is safe, sufficient, or enough to turn a propeller.
 *
 * NO PHYSICAL CLAIMS. This module maps output INDEXES only. It asserts
 * nothing about CW/CCW rotation, props-out installation, or which
 * airframe corner an index sits at, and it never remaps outputs.
 */

import {MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2} from '../protocol/msp/decoding/decodeAdvancedConfig';
import {
  MSP_SET_MOTOR_EXTERNAL_MAX_VALUE,
  MSP_SET_MOTOR_EXTERNAL_MIN_VALUE,
  MSP_SET_MOTOR_SUPPORTED_MOTOR_COUNT,
} from '../protocol/msp/encoding/encodeSetMotorPayload';

/** External value that means STOP in non-3D DShot (drivers/dshot.c:90).
 * Re-exported under a motor-domain name so a caller never has to know
 * that it is numerically the same as PWM_RANGE_MIN. */
export const MOTOR_EXTERNAL_STOP_VALUE = MSP_SET_MOTOR_EXTERNAL_MIN_VALUE;

/**
 * The lowest external value that is NOT stop in non-3D DShot, i.e.
 * MSP_SET_MOTOR_EXTERNAL_MIN_VALUE + 1. drivers/dshot.c:90 maps it to
 * DSHOT_MIN_THROTTLE (48, drivers/dshot.h:34).
 *
 * A PROTOCOL FLOOR, NOT A RECOMMENDATION. This is the boundary of the
 * encoding, published so tests can pin byte order against a stable
 * fixture. It is NOT an idle value, NOT a safe value, and NOT known to
 * spin any particular motor. Pulse magnitude is an undecided safety
 * question and is explicitly outside this pass.
 */
export const MOTOR_EXTERNAL_PROTOCOL_FLOOR_VALUE = MSP_SET_MOTOR_EXTERNAL_MIN_VALUE + 1;

/** Highest legal external value (drivers/dshot.c:79 constrains to this
 * firmware-side; this module rejects rather than relies on that). */
export const MOTOR_EXTERNAL_MAX_VALUE = MSP_SET_MOTOR_EXTERNAL_MAX_VALUE;

/** Approved scope: Quad X, four motors. */
export const MOTOR_VECTOR_MOTOR_COUNT = MSP_SET_MOTOR_SUPPORTED_MOTOR_COUNT;

/**
 * The already-decoded FC facts this module needs. Deliberately a narrow
 * structural type rather than the full static-facts model: nothing here
 * should be able to reach identity, session or battery data.
 *
 * `motorProtocolRaw` is the RAW motorProtocolTypes_e byte exactly as
 * MSP_ADVANCED_CONFIG offset 3 reports it - never a UI-adjusted value.
 * Betaflight Configurator's motor tab offsets this enum by one for
 * display; comparing against a display value instead of the wire value
 * would silently accept the wrong protocol.
 */
export interface MotorVectorScope {
  readonly motorCount: number;
  readonly motorProtocolRaw: number;
  readonly feature3dEnabled: boolean;
}

export class MotorVectorScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MotorVectorScopeError';
  }
}

export class MotorVectorValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MotorVectorValueError';
  }
}

/**
 * Throws unless the decoded configuration is inside the one approved
 * scope. 3D is checked FIRST because it inverts stop semantics; a caller
 * that ignored the ordering could otherwise build a "stop" vector for a
 * 3D aircraft.
 */
export function assertSupportedMotorScope(scope: MotorVectorScope): void {
  if (scope.feature3dEnabled) {
    throw new MotorVectorScopeError(
      'Motor vectors are refused while FEATURE_3D is enabled: with 3D on, stop is external 1500 and ' +
        '1000 is FULL REVERSE (drivers/dshot.c:81-88). This pass supports non-3D only.',
    );
  }
  if (!Number.isInteger(scope.motorCount) || scope.motorCount !== MOTOR_VECTOR_MOTOR_COUNT) {
    throw new MotorVectorScopeError(
      `Motor vectors are refused: only motorCount ${MOTOR_VECTOR_MOTOR_COUNT} is in scope, received ${String(scope.motorCount)}. ` +
        'Motor count must come from MSP_MOTOR_CONFIG offset 6.',
    );
  }
  if (scope.motorProtocolRaw !== MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2) {
    throw new MotorVectorScopeError(
      `Motor vectors are refused: only raw motor protocol ${MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2} (DSHOT600 at the pinned tag) ` +
        `is in scope, received ${String(scope.motorProtocolRaw)}. The raw MSP_ADVANCED_CONFIG byte is compared, never a display-adjusted value.`,
    );
  }
}

/**
 * The all-stop vector: every motor at the non-3D stop value. Returns a
 * fresh frozen array on every call.
 */
export function buildAllStopVector(scope: MotorVectorScope): readonly number[] {
  assertSupportedMotorScope(scope);
  const values: number[] = [];
  for (let index = 0; index < MOTOR_VECTOR_MOTOR_COUNT; index++) {
    values.push(MOTOR_EXTERNAL_STOP_VALUE);
  }
  return Object.freeze(values);
}

/**
 * A vector with exactly ONE output above stop and the rest at stop.
 *
 * `externalActiveValue` is REQUIRED and has no default. It must be an
 * integer strictly above stop and at most the maximum. Supplying it is
 * the caller's explicit decision; this function neither suggests nor
 * validates physical suitability.
 *
 * `motorIndex` selects an OUTPUT INDEX only - no airframe position and
 * no rotation direction is implied.
 */
export function buildSingleMotorVector(
  scope: MotorVectorScope,
  motorIndex: number,
  externalActiveValue: number,
): readonly number[] {
  assertSupportedMotorScope(scope);

  if (!Number.isInteger(motorIndex) || motorIndex < 0 || motorIndex >= MOTOR_VECTOR_MOTOR_COUNT) {
    throw new MotorVectorValueError(
      `motorIndex must be an integer in 0..${MOTOR_VECTOR_MOTOR_COUNT - 1}, received ${String(motorIndex)}.`,
    );
  }
  if (typeof externalActiveValue !== 'number' || !Number.isInteger(externalActiveValue)) {
    throw new MotorVectorValueError(
      `externalActiveValue must be an integer, received ${String(externalActiveValue)}. ` +
        'There is deliberately no default: pulse magnitude is an undecided safety question.',
    );
  }
  if (
    externalActiveValue <= MOTOR_EXTERNAL_STOP_VALUE ||
    externalActiveValue > MOTOR_EXTERNAL_MAX_VALUE
  ) {
    throw new MotorVectorValueError(
      `externalActiveValue must be within ${MOTOR_EXTERNAL_PROTOCOL_FLOOR_VALUE}..${MOTOR_EXTERNAL_MAX_VALUE}, ` +
        `received ${externalActiveValue}. ${MOTOR_EXTERNAL_STOP_VALUE} is stop, not an active value.`,
    );
  }

  const values: number[] = [];
  for (let index = 0; index < MOTOR_VECTOR_MOTOR_COUNT; index++) {
    values.push(index === motorIndex ? externalActiveValue : MOTOR_EXTERNAL_STOP_VALUE);
  }
  return Object.freeze(values);
}
