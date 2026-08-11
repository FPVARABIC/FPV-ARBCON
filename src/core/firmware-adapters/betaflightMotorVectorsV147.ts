/**
 * Pass 1B - pure Betaflight API-1.47 motor VECTOR logic: which logical
 * external values belong in an MSP_SET_MOTOR request, for the reviewed
 * Betaflight API-1.46/1.47/1.48 digital-motor configuration.
 *
 * PURE PRODUCTION BUILDING BLOCK. No I/O, no transport, no MspClient, no
 * timers, no React/React Native and no mutable state. The live controller
 * reaches it only after the versioned firmware gate, session lease and
 * safety evidence have passed. Producing a vector alone remains inert and
 * never authorizes its use.
 *
 * APPROVED SCOPE, ENFORCED NOT ASSUMED: exactly four motors, one of the
 * DShot-family protocols (DSHOT150/300/600 or PROSHOT1000), and 3D mode
 * disabled. Betaflight routes those four protocols through the same
 * DShot external-value converter; analog PWM-family protocols use a
 * different motor-device conversion and remain rejected until their own
 * reviewed adapter exists.
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

import {MOTOR_PROTOCOL_RAWS_BETAFLIGHT_API_1_46_TO_1_48} from '../protocol/msp/decoding/decodeAdvancedConfig';
import type {MotorTestValueDomain} from './betaflightMotorDomainV147';
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
 * Throws unless the decoded configuration is inside the reviewed
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
  if (
    !MOTOR_PROTOCOL_RAWS_BETAFLIGHT_API_1_46_TO_1_48.includes(
      scope.motorProtocolRaw,
    )
  ) {
    throw new MotorVectorScopeError(
      'Motor vectors are refused: only the reviewed Betaflight API-1.46..1.48 DShot-family raw protocols ' +
        `[${MOTOR_PROTOCOL_RAWS_BETAFLIGHT_API_1_46_TO_1_48.join(', ')}] are in scope, received ${String(scope.motorProtocolRaw)}. ` +
        'The raw MSP_ADVANCED_CONFIG byte is compared, never a display-adjusted value.',
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

/* ===================================================================== *
 * P1-C - THE GENERAL MOTOR VECTOR PRIMITIVES.
 *
 * The three functions above describe the SHIPPING single-pulse scope and
 * are deliberately left byte-identical: `motorTestController.ts` still
 * calls them, and P1 changes no runtime behaviour. The primitives below
 * are the general form the professional workspace will use once P2
 * migrates the controller. Nothing in this repository calls them yet.
 *
 * They are driven by a resolved MotorTestValueDomain rather than by the
 * old MotorVectorScope, because stop is not a constant: it moves with the
 * protocol family and with FEATURE_3D. See betaflightMotorDomainV147.ts
 * for the source trace of every bound.
 *
 * NO PHYSICAL CLAIMS. A vector is a list of external protocol values. It
 * asserts nothing about rotation, direction, airframe position, or
 * whether any output will do anything at all. Physical consequences
 * remain REQUIRES HARDWARE TEST.
 * ===================================================================== */

/**
 * The all-stop vector for a resolved domain: every element at that
 * configuration's own stop value - PWM_RANGE_MIN for non-3D DShot,
 * `mincommand` for non-3D analog, and the 3D neutral when FEATURE_3D is
 * enabled. Returns a fresh frozen array on every call.
 */
export function buildAllStopVectorForDomain(
  domain: MotorTestValueDomain,
): readonly number[] {
  const values: number[] = [];
  for (let index = 0; index < domain.motorCount; index++) {
    values.push(domain.stopValue);
  }
  return Object.freeze(values);
}

/**
 * A full motor vector: one external value per output, all supplied by the
 * caller. Every element is validated against the resolved domain; there
 * is no default, no fill, no padding and no truncation, and no limit on
 * how many elements may sit above the stop value - `MSP_SET_MOTOR` is a
 * vector write (msp.c, `for (i = 0; i < getMotorCount(); i++)`), and the
 * decision about how many outputs a caller MAY drive belongs to the
 * layers above this one.
 */
export function buildMotorVector(
  domain: MotorTestValueDomain,
  values: readonly number[],
): readonly number[] {
  if (!Array.isArray(values)) {
    throw new MotorVectorValueError(
      `buildMotorVector: values must be an array, received ${typeof values}.`,
    );
  }
  if (values.length !== domain.motorCount) {
    throw new MotorVectorValueError(
      `buildMotorVector: expected exactly ${domain.motorCount} values (the FC-reported motor count), ` +
        `received ${values.length}.`,
    );
  }
  for (let index = 0; index < values.length; index++) {
    if (!Object.prototype.hasOwnProperty.call(values, index)) {
      throw new MotorVectorValueError(
        `buildMotorVector: values[${index}] is a hole; a sparse array is not a valid motor vector.`,
      );
    }
    const value = values[index];
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new MotorVectorValueError(
        `buildMotorVector: values[${index}] must be an integer, received ${String(value)}.`,
      );
    }
    if (value < domain.commandDomainMin || value > domain.commandDomainMax) {
      throw new MotorVectorValueError(
        `buildMotorVector: values[${index}] must be within the command domain ` +
          `${domain.commandDomainMin}..${domain.commandDomainMax} for this configuration (source: ` +
          `${domain.domainSource}), received ${value}. Being inside the command domain is not a claim ` +
          'that the value lies in any proven active region.',
      );
    }
  }
  return Object.freeze([...values]);
}

/**
 * A vector with one output at `externalValue` and every other output at
 * the domain's stop value. The general-domain counterpart of
 * `buildSingleMotorVector`; unlike that legacy helper it works for any
 * FC-reported motor count, any protocol family, and 3D configurations,
 * and it accepts the stop value itself (a caller may legitimately build a
 * vector that commands nothing).
 */
export function buildSingleOutputVectorForDomain(
  domain: MotorTestValueDomain,
  motorIndex: number,
  externalValue: number,
): readonly number[] {
  if (
    !Number.isInteger(motorIndex) ||
    motorIndex < 0 ||
    motorIndex >= domain.motorCount
  ) {
    throw new MotorVectorValueError(
      `buildSingleOutputVectorForDomain: motorIndex must be an integer in 0..${domain.motorCount - 1}, ` +
        `received ${String(motorIndex)}.`,
    );
  }
  const values: number[] = [];
  for (let index = 0; index < domain.motorCount; index++) {
    values.push(index === motorIndex ? externalValue : domain.stopValue);
  }
  return buildMotorVector(domain, values);
}
