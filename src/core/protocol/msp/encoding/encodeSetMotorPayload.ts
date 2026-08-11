/**
 * Pass 1B - the PAYLOAD BYTES of an MSP_SET_MOTOR (214) request, and
 * nothing else.
 *
 * WHAT THIS MODULE IS NOT:
 *  - It is not a frame encoder. It returns the payload only; it never
 *    builds a header, length, command byte or checksum.
 *  - It never imports, accepts, retains or calls a transport, an
 *    MspClient, or anything that could reach a USB device.
 *  - It has no caller in this repository. Nothing invokes it at runtime.
 *
 * Producing these bytes is therefore INERT. It is not a motor command
 * until some future, separately-approved code sends it, and Pass 1B does
 * not authorize that.
 *
 * WHY THE VALIDATION IS THIS STRICT. Three facts read from Betaflight
 * 2025.12.2 (79065c96ba0bb5cdc675e67d7093e05dab8b330e):
 *
 *  1. msp.c:2927-2931 reads getMotorCount() u16 values with NO dataSize
 *     check, and common/streambuf.c:103-109 shows sbufReadU16 is two
 *     bare pointer dereferences with no bounds check. A payload of the
 *     wrong length makes the FLIGHT CONTROLLER read past its buffer.
 *     Hence: the byte count is derived from an explicitly supplied
 *     motorCount, never guessed, never defaulted, never padded.
 *
 *  2. drivers/dshot.c:79 constrains the external value into
 *     PWM_RANGE_MIN..PWM_RANGE_MAX firmware-side. This encoder REJECTS
 *     out-of-range values instead of relying on that clamp: an
 *     out-of-range number means the caller computed something wrong, and
 *     silently clamping it would turn a bug into a motor command.
 *
 *  3. drivers/dshot.c:90 - in NON-3D DShot, external exactly 1000 is
 *     DSHOT_CMD_MOTOR_STOP and anything above it is throttle. 1001 is
 *     therefore the protocol floor for "not stopped". That is a protocol
 *     fact, NOT a recommendation: this module takes no position on which
 *     value is safe, sufficient, or effective for any motor or ESC.
 *
 * MOTOR COUNT IS THE FC'S, BOUNDED BY THE FIRMWARE MAXIMUM. P1 removed
 * the previous four-only restriction, which was an approved-scope choice
 * rather than a protocol fact. The firmware bound is
 * src/main/target/common_defaults_post.h:346-354 @ the pinned commit:
 *
 *     #if defined(USE_QUAD_MIXER_ONLY)
 *     #define MAX_SUPPORTED_MOTORS 4
 *     ...
 *     #else
 *     #ifndef MAX_SUPPORTED_MOTORS
 *     #define MAX_SUPPORTED_MOTORS 8
 *     #endif
 *
 * so 8 is the maximum any non-QUAD_MIXER_ONLY target compiles with, and a
 * QUAD_MIXER_ONLY board simply reports a smaller motorCount. The caller
 * still supplies the count explicitly; it is never guessed, never
 * defaulted, and NEVER derived from MSP_MOTOR's eight output slots, which
 * that command always returns regardless of airframe.
 *
 * NO ONE-ACTIVE-MOTOR INVARIANT. P1 also removed that restriction from
 * this layer. src/main/msp/msp.c, case MSP_SET_MOTOR, is a plain vector
 * write - `for (i = 0; i < getMotorCount(); i++) motor_disarmed[i] =
 * motorConvertFromExternal(sbufReadU16(src));` - and both reference
 * configurators drive every element independently. Restricting the pure
 * encoder to one active element described the old single-pulse product,
 * not the protocol. Whether a caller MAY command several outputs remains
 * a decision for the layers above; this module only refuses to
 * misrepresent MSP_SET_MOTOR.
 *
 * EXTERNAL DOMAIN IS SUPPLIED, NOT ASSUMED. The default bound below is
 * PWM_RANGE, which is correct for the DShot family (drivers/dshot.c:79
 * constrains to it). It is NOT correct for every configuration: an analog
 * board's `mincommand` may legally be 900 (src/main/pg/motor.h:85). A
 * caller that knows the resolved domain passes it in; see
 * betaflightMotorDomainV147.ts.
 */

/** src/main/rx/rx.h:32 @ BETAFLIGHT_2025_12_2_COMMIT: PWM_RANGE_MIN. In
 * non-3D DShot this exact value is motor stop (drivers/dshot.c:90). */
export const MSP_SET_MOTOR_EXTERNAL_MIN_VALUE = 1000;

/** src/main/rx/rx.h:33 @ BETAFLIGHT_2025_12_2_COMMIT: PWM_RANGE_MAX. */
export const MSP_SET_MOTOR_EXTERNAL_MAX_VALUE = 2000;

/** Lowest motor count that can produce a payload at all. */
export const MSP_SET_MOTOR_MIN_MOTOR_COUNT = 1;

/**
 * MAX_SUPPORTED_MOTORS, src/main/target/common_defaults_post.h:351 @
 * BETAFLIGHT_2025_12_2_COMMIT. A firmware bound, not a product choice.
 */
export const MSP_SET_MOTOR_MAX_MOTOR_COUNT = 8;

/**
 * LEGACY SCOPE CONSTANT, retained unchanged for the shipping single-pulse
 * path in motorTestController.ts. It is the approved scope of that older
 * pass (Quad X, four motors) and has never been a firmware limit - the
 * firmware limit is MSP_SET_MOTOR_MAX_MOTOR_COUNT above.
 */
export const MSP_SET_MOTOR_SUPPORTED_MOTOR_COUNT = 4;

/** Four u16 values, little-endian - the legacy scope's payload size. */
export const MSP_SET_MOTOR_PAYLOAD_BYTES = MSP_SET_MOTOR_SUPPORTED_MOTOR_COUNT * 2;

/** Exact payload byte length for a vector of `motorCount` u16 values. */
export function mspSetMotorPayloadByteLength(motorCount: number): number {
  return motorCount * 2;
}

/**
 * The external-value bounds a payload is checked against. Supplied by the
 * caller so that an analog or 3D configuration is not measured against
 * DShot's PWM_RANGE.
 */
export interface MspSetMotorExternalDomain {
  readonly externalMin: number;
  readonly externalMax: number;
}

const DEFAULT_EXTERNAL_DOMAIN: MspSetMotorExternalDomain = Object.freeze({
  externalMin: MSP_SET_MOTOR_EXTERNAL_MIN_VALUE,
  externalMax: MSP_SET_MOTOR_EXTERNAL_MAX_VALUE,
});

export class MspSetMotorEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MspSetMotorEncodeError';
  }
}

function rejectUnlessSupportedMotorCount(motorCount: number): void {
  if (typeof motorCount !== 'number' || !Number.isInteger(motorCount)) {
    throw new MspSetMotorEncodeError(
      `encodeSetMotorPayload: motorCount must be an integer, received ${String(motorCount)}.`,
    );
  }
  if (
    motorCount < MSP_SET_MOTOR_MIN_MOTOR_COUNT ||
    motorCount > MSP_SET_MOTOR_MAX_MOTOR_COUNT
  ) {
    throw new MspSetMotorEncodeError(
      `encodeSetMotorPayload: motorCount must be within ${MSP_SET_MOTOR_MIN_MOTOR_COUNT}..` +
        `${MSP_SET_MOTOR_MAX_MOTOR_COUNT} (MAX_SUPPORTED_MOTORS, target/common_defaults_post.h:351), received ${motorCount}. ` +
        'Motor count must come from MSP_MOTOR_CONFIG offset 6, never from MSP_MOTOR\'s eight output slots.',
    );
  }
}

function rejectUnlessUsableDomain(domain: MspSetMotorExternalDomain): void {
  const {externalMin, externalMax} = domain;
  if (!Number.isInteger(externalMin) || !Number.isInteger(externalMax)) {
    throw new MspSetMotorEncodeError(
      `encodeSetMotorPayload: external domain bounds must be integers, received ` +
        `${String(externalMin)}..${String(externalMax)}.`,
    );
  }
  if (externalMin > externalMax) {
    throw new MspSetMotorEncodeError(
      `encodeSetMotorPayload: external domain ${externalMin}..${externalMax} is inverted.`,
    );
  }
  // The wire field is u16; a domain outside it could never be encoded.
  if (externalMin < 0 || externalMax > 0xffff) {
    throw new MspSetMotorEncodeError(
      `encodeSetMotorPayload: external domain ${externalMin}..${externalMax} leaves the u16 wire field.`,
    );
  }
}

function rejectUnlessDenseArrayOfLength(values: readonly number[], motorCount: number): void {
  if (!Array.isArray(values)) {
    throw new MspSetMotorEncodeError(
      `encodeSetMotorPayload: values must be an array, received ${typeof values}.`,
    );
  }
  if (values.length !== motorCount) {
    throw new MspSetMotorEncodeError(
      `encodeSetMotorPayload: expected exactly ${motorCount} values, received ${values.length}. ` +
        'A wrong-length payload makes the flight controller read past its own buffer.',
    );
  }
  for (let index = 0; index < motorCount; index++) {
    // A hole in a sparse array is NOT an own property. Reading it would
    // yield undefined, which a numeric check might otherwise coerce.
    if (!Object.prototype.hasOwnProperty.call(values, index)) {
      throw new MspSetMotorEncodeError(
        `encodeSetMotorPayload: values[${index}] is a hole; a sparse array is not a valid motor vector.`,
      );
    }
  }
}

function rejectUnlessEncodableValue(
  value: number,
  index: number,
  domain: MspSetMotorExternalDomain,
): void {
  if (typeof value !== 'number') {
    throw new MspSetMotorEncodeError(
      `encodeSetMotorPayload: values[${index}] must be a number, received ${typeof value}.`,
    );
  }
  if (!Number.isFinite(value)) {
    throw new MspSetMotorEncodeError(
      `encodeSetMotorPayload: values[${index}] must be finite, received ${String(value)}.`,
    );
  }
  if (!Number.isInteger(value)) {
    throw new MspSetMotorEncodeError(
      `encodeSetMotorPayload: values[${index}] must be an integer, received ${value}. ` +
        'This encoder never rounds - a fractional value means the caller computed something wrong.',
    );
  }
  if (value < domain.externalMin || value > domain.externalMax) {
    throw new MspSetMotorEncodeError(
      `encodeSetMotorPayload: values[${index}] must be within ` +
        `${domain.externalMin}..${domain.externalMax}, received ${value}. ` +
        'Firmware may clamp or pass this through; this encoder rejects it instead, so a miscomputed value can never become a motor command.',
    );
  }
}

/**
 * Encodes an MSP_SET_MOTOR payload: exactly `motorCount` u16
 * little-endian values, in firmware output order, i.e. exactly
 * `motorCount * 2` bytes and never one byte more.
 *
 * `domain` bounds the legal external values. Omitting it keeps the
 * PWM_RANGE default, which is the correct bound for the DShot family and
 * preserves the contract every existing caller already relies on.
 *
 * Returns a NEWLY ALLOCATED buffer on every call and mutates nothing the
 * caller owns. Throws MspSetMotorEncodeError on any invalid input; it
 * never clamps, coerces, rounds, normalises, pads, truncates, infers or
 * substitutes a value.
 *
 * PRODUCING BYTES IS INERT. This module has no transport and no caller
 * authority; it makes no claim that any value it encodes will have any
 * physical effect on an ESC or a motor.
 */
export function encodeSetMotorPayload(
  values: readonly number[],
  motorCount: number,
  domain: MspSetMotorExternalDomain = DEFAULT_EXTERNAL_DOMAIN,
): Uint8Array {
  rejectUnlessSupportedMotorCount(motorCount);
  rejectUnlessUsableDomain(domain);
  rejectUnlessDenseArrayOfLength(values, motorCount);
  for (let index = 0; index < motorCount; index++) {
    rejectUnlessEncodableValue(values[index], index, domain);
  }

  const payload = new Uint8Array(mspSetMotorPayloadByteLength(motorCount));
  const view = new DataView(payload.buffer);
  for (let index = 0; index < motorCount; index++) {
    // Explicit little-endian argument: the wire order is stated by the
    // platform API rather than re-derived with shift-and-mask arithmetic.
    view.setUint16(index * 2, values[index], true);
  }
  return payload;
}
