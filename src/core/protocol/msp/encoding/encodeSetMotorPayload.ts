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
 * ONE-ACTIVE-MOTOR INVARIANT. A payload may be all-stop, or may carry
 * exactly one value above stop. This is enforced here as defense in
 * depth even though the vector builders enforce it too - two independent
 * layers must both fail before a multi-motor payload can be produced.
 *
 * NEVER derives motorCount from MSP_MOTOR's eight output slots: that
 * command always returns eight values regardless of airframe.
 */

/** src/main/rx/rx.h:32 @ BETAFLIGHT_2025_12_2_COMMIT: PWM_RANGE_MIN. In
 * non-3D DShot this exact value is motor stop (drivers/dshot.c:90). */
export const MSP_SET_MOTOR_EXTERNAL_MIN_VALUE = 1000;

/** src/main/rx/rx.h:33 @ BETAFLIGHT_2025_12_2_COMMIT: PWM_RANGE_MAX. */
export const MSP_SET_MOTOR_EXTERNAL_MAX_VALUE = 2000;

/** The only motor count this pass supports. Not a firmware limit - a
 * deliberately narrow approved scope (Quad X, four motors). */
export const MSP_SET_MOTOR_SUPPORTED_MOTOR_COUNT = 4;

/** Four u16 values, little-endian. */
export const MSP_SET_MOTOR_PAYLOAD_BYTES = MSP_SET_MOTOR_SUPPORTED_MOTOR_COUNT * 2;

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
  if (motorCount !== MSP_SET_MOTOR_SUPPORTED_MOTOR_COUNT) {
    throw new MspSetMotorEncodeError(
      `encodeSetMotorPayload: only motorCount ${MSP_SET_MOTOR_SUPPORTED_MOTOR_COUNT} is in scope for this pass, received ${motorCount}. ` +
        'Motor count must come from MSP_MOTOR_CONFIG offset 6, never from MSP_MOTOR\'s eight output slots.',
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

function rejectUnlessEncodableValue(value: number, index: number): void {
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
  if (value < MSP_SET_MOTOR_EXTERNAL_MIN_VALUE || value > MSP_SET_MOTOR_EXTERNAL_MAX_VALUE) {
    throw new MspSetMotorEncodeError(
      `encodeSetMotorPayload: values[${index}] must be within ` +
        `${MSP_SET_MOTOR_EXTERNAL_MIN_VALUE}..${MSP_SET_MOTOR_EXTERNAL_MAX_VALUE}, received ${value}. ` +
        'Firmware would clamp this; this encoder rejects it instead, so a miscomputed value can never become a motor command.',
    );
  }
}

function rejectUnlessAtMostOneActiveValue(values: readonly number[]): void {
  const activeIndexes: number[] = [];
  for (let index = 0; index < values.length; index++) {
    if (values[index] > MSP_SET_MOTOR_EXTERNAL_MIN_VALUE) {
      activeIndexes.push(index);
    }
  }
  if (activeIndexes.length > 1) {
    throw new MspSetMotorEncodeError(
      `encodeSetMotorPayload: at most ONE motor may be above stop, found ${activeIndexes.length} ` +
        `(indexes ${activeIndexes.join(', ')}). One motor per pulse is a hard safety rule.`,
    );
  }
}

/**
 * Encodes an MSP_SET_MOTOR payload: exactly `motorCount` u16
 * little-endian values, in firmware output order.
 *
 * Returns a NEWLY ALLOCATED buffer on every call and mutates nothing the
 * caller owns. Throws MspSetMotorEncodeError on any invalid input; it
 * never clamps, coerces, rounds, normalises, pads, truncates, infers or
 * substitutes a value.
 */
export function encodeSetMotorPayload(values: readonly number[], motorCount: number): Uint8Array {
  rejectUnlessSupportedMotorCount(motorCount);
  rejectUnlessDenseArrayOfLength(values, motorCount);
  for (let index = 0; index < motorCount; index++) {
    rejectUnlessEncodableValue(values[index], index);
  }
  rejectUnlessAtMostOneActiveValue(values);

  const payload = new Uint8Array(motorCount * 2);
  const view = new DataView(payload.buffer);
  for (let index = 0; index < motorCount; index++) {
    // Explicit little-endian argument: the wire order is stated by the
    // platform API rather than re-derived with shift-and-mask arithmetic.
    view.setUint16(index * 2, values[index], true);
  }
  return payload;
}
