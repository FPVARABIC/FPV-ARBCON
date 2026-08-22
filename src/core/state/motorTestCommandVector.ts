/**
 * THE CANONICAL MOTOR-TEST COMMAND VECTOR: exactly eight external slots,
 * always, for every airframe.
 *
 * M-B built this module inert. M-C WIRED IT: every MSP_SET_MOTOR payload
 * the motor-control command engine puts on the wire is now built and
 * encoded here, so there is exactly one shape for a motor command and it
 * does not vary with the airframe.
 *
 * ============================ SOURCE PIN ============================
 * Betaflight firmware commit 7348054f268f0058574719c134e9f149565bb8ea
 * (FC 2025.12.5), MSP API 1.47 (msp_protocol.h:61-62), cross-read against
 * master 1efac3ef1 (API 1.49). API 1.48 is NOT VERIFIED.
 *
 * ============== WHY EIGHT SLOTS, AND WHY THAT IS SAFE ==============
 *
 * MSP_SET_MOTOR (214) at API 1.47, msp.c:2927-2931:
 *
 *     for (int i = 0; i < getMotorCount(); i++) {
 *         motor_disarmed[i] = motorConvertFromExternal(sbufReadU16(src));
 *     }
 *
 * Four readings make the fixed-width form the SAFE one rather than merely
 * a convenient one:
 *
 *  1. THE FIRMWARE READS ONLY getMotorCount() VALUES. The loop bound is
 *     the motor count and nothing else. Bytes beyond it are never read by
 *     this handler.
 *
 *  2. TRAILING BYTES ARE DISCARDED, NOT MISINTERPRETED. The handler
 *     `break`s straight to MSP_RESULT_ACK, and mspFcProcessCommand()
 *     (msp.c:4421-4449) returns the handler's result without any check on
 *     unread input. There is no generic "leftover bytes" validation
 *     anywhere in the dispatch chain, so extra slots cannot become extra
 *     motors, cannot shift into another field and cannot fail the frame.
 *
 *  3. WRITES ARE BOUNDED BY THE ARRAY. `motor_disarmed` is declared
 *     `float motor_disarmed[MAX_SUPPORTED_MOTORS]` (mixer.c:79), and
 *     getMotorCount() can never exceed MAX_SUPPORTED_MOTORS because
 *     mixerConfigureOutput() clamps on its table branch
 *     (mixer_init.c:437-440) and bounds its custom walk by the same
 *     constant (mixer_init.c:429). MAX_SUPPORTED_MOTORS is 8 on a
 *     standard build and 4 under USE_QUAD_MIXER_ONLY
 *     (common_defaults_post.h:346-354).
 *
 *  4. THE DANGEROUS DIRECTION IS THE SHORT ONE. sbufReadU16() is a pair
 *     of unchecked pointer dereferences, and at API 1.47 this handler has
 *     NO minimum-length guard at all - so a payload SHORTER than
 *     getMotorCount() * 2 makes the flight controller read past its own
 *     receive buffer. At API 1.49 the handler grows exactly one guard
 *     (msp.c:3247-3250):
 *
 *         if (dataSize < getMotorCount() * sizeof(uint16_t)) {
 *             return MSP_RESULT_ERROR;
 *         }
 *
 *     A fixed eight-slot vector is the LONGEST legal payload, so it can
 *     never under-run the 1.47 firmware and always satisfies the 1.49
 *     guard - the same bytes are correct on both, with no version branch.
 *
 * That is the whole argument for the shape. It is also what the reference
 * Configurator does - it keeps a length-8 array and sends all sixteen
 * bytes regardless of motor count - and this module arrives at it from
 * the firmware rather than by copying the behaviour.
 *
 * ================= WHY THE PADDING IS THE STOP VALUE =================
 * Slots at and beyond the motor count are ignored by the pinned firmware,
 * so their content is formally free. They are filled with the resolved
 * STOP value anyway, for one reason: if this application's idea of the
 * motor count is ever LOWER than the running firmware's, the firmware
 * reads slots we thought were padding, and the only content that is safe
 * to be read by surprise is the value the firmware maps to its
 * stop/disarmed output. Filling with zero would send an analog board a
 * pulse width of 0, and filling with 1000 would be a reverse command on a
 * 3D configuration. The stop value comes from the resolved domain, which
 * derives it from the protocol family and FEATURE_3D
 * (betaflightMotorDomainV147.ts); it is never hard-coded here.
 *
 * NO PHYSICAL CLAIM. Producing a stop value is a protocol statement about
 * what the firmware maps to its disarmed output. It is not a claim that
 * any motor will stop, that any ESC will respond, or that anything is
 * safe. Physical behaviour remains REQUIRES HARDWARE TEST, and no part of
 * this module has been run against real hardware.
 */

import {
  motorCommandDomainBounds,
  type MotorTestValueDomain,
} from '../firmware-adapters/betaflightMotorDomainV147';
import {encodeSetMotorPayload} from '../protocol/msp/encoding/encodeSetMotorPayload';

/**
 * The number of external slots an MSP_SET_MOTOR payload carries in this
 * application's canonical form. It is MAX_SUPPORTED_MOTORS on a standard
 * build, and it is a property of the COMMAND SHAPE we send, not of any
 * airframe - a three-motor tricopter and an eight-motor octocopter both
 * get eight slots.
 */
export const MOTOR_TEST_COMMAND_VECTOR_SLOTS = 8;

/** Byte length of the encoded payload: eight little-endian u16 values. */
export const MOTOR_TEST_COMMAND_VECTOR_BYTES = MOTOR_TEST_COMMAND_VECTOR_SLOTS * 2;

/**
 * A ready-to-encode MSP_SET_MOTOR vector.
 *
 * `slots` is always MOTOR_TEST_COMMAND_VECTOR_SLOTS long. The indices are
 * LOGICAL FIRMWARE OUTPUT INDICES, zero-based, in the order the firmware
 * itself reads them - never reordered for a right-to-left interface, and
 * never renumbered to match a diagram.
 */
export interface MotorTestCommandVector {
  /** Exactly eight external values, logical output order. */
  readonly slots: readonly number[];
  /**
   * How many of those slots the firmware will actually read, from
   * MSP_MOTOR_CONFIG offset 6. Carried so a consumer can report what it
   * commanded versus what it padded, and never derived from MSP_MOTOR's
   * output slots.
   */
  readonly runtimeMotorCount: number;
  /** The external value every padding slot carries, and the value an
   * all-stop vector carries everywhere. Taken from the domain. */
  readonly stopValue: number;
  /**
   * The single slot this vector drives away from stop, if any. Absent for
   * an all-stop vector.
   */
  readonly commandedSlotIndex?: number;
}

export class MotorTestCommandVectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MotorTestCommandVectorError';
  }
}

function requireUsableRuntimeMotorCount(runtimeMotorCount: number): void {
  if (typeof runtimeMotorCount !== 'number' || !Number.isInteger(runtimeMotorCount)) {
    throw new MotorTestCommandVectorError(
      `motorTestCommandVector: runtimeMotorCount must be an integer, received ${String(runtimeMotorCount)}.`,
    );
  }
  if (runtimeMotorCount < 1 || runtimeMotorCount > MOTOR_TEST_COMMAND_VECTOR_SLOTS) {
    throw new MotorTestCommandVectorError(
      `motorTestCommandVector: runtimeMotorCount must be within 1..` +
        `${MOTOR_TEST_COMMAND_VECTOR_SLOTS} (MAX_SUPPORTED_MOTORS, ` +
        `common_defaults_post.h:351 @ 7348054f), received ${runtimeMotorCount}. ` +
        'It must come from MSP_MOTOR_CONFIG offset 6, never from MSP_MOTOR\'s eight output slots.',
    );
  }
}

function requireCommandableValue(value: number, domain: MotorTestValueDomain): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new MotorTestCommandVectorError(
      `motorTestCommandVector: the commanded external value must be an integer, received ${String(value)}. ` +
        'This module never rounds - a fractional value means the caller computed something wrong.',
    );
  }
  if (value < domain.commandDomainMin || value > domain.commandDomainMax) {
    throw new MotorTestCommandVectorError(
      `motorTestCommandVector: the commanded external value ${value} is outside the resolved ` +
        `command domain ${domain.commandDomainMin}..${domain.commandDomainMax} ` +
        `(${domain.domainSource}). Rejected rather than clamped, so a miscomputed value ` +
        'can never become a motor command.',
    );
  }
}

function filledWithStop(domain: MotorTestValueDomain): number[] {
  return new Array<number>(MOTOR_TEST_COMMAND_VECTOR_SLOTS).fill(domain.stopValue);
}

/**
 * Every slot at the resolved stop value.
 *
 * Works for any airframe the domain resolver accepts - three motors, six,
 * eight - because the vector's width never depended on the airframe in
 * the first place.
 */
export function buildAllStopCommandVector(
  domain: MotorTestValueDomain,
): MotorTestCommandVector {
  requireUsableRuntimeMotorCount(domain.motorCount);
  return Object.freeze({
    slots: Object.freeze(filledWithStop(domain)),
    runtimeMotorCount: domain.motorCount,
    stopValue: domain.stopValue,
  });
}

/**
 * One slot driven to `externalValue`, every other slot at the resolved
 * stop value - including the padding slots beyond the motor count, for
 * the reason in this module's header.
 *
 * `slotIndex` is a LOGICAL FIRMWARE OUTPUT INDEX, zero-based. Commanding
 * a slot the firmware will not read is rejected rather than quietly
 * dropped: the caller believes it is driving a motor and it is not.
 *
 * Throws on any input it cannot honour exactly. It never clamps, rounds,
 * substitutes or reorders.
 */
export function buildSingleOutputCommandVector(
  domain: MotorTestValueDomain,
  slotIndex: number,
  externalValue: number,
): MotorTestCommandVector {
  requireUsableRuntimeMotorCount(domain.motorCount);
  if (typeof slotIndex !== 'number' || !Number.isInteger(slotIndex)) {
    throw new MotorTestCommandVectorError(
      `motorTestCommandVector: slotIndex must be an integer, received ${String(slotIndex)}.`,
    );
  }
  if (slotIndex < 0 || slotIndex >= domain.motorCount) {
    throw new MotorTestCommandVectorError(
      `motorTestCommandVector: slotIndex ${slotIndex} is outside the ` +
        `0..${domain.motorCount - 1} range the firmware will read. ` +
        'MSP_SET_MOTOR reads exactly getMotorCount() values (msp.c:2928 @ 7348054f); ' +
        'a value written past that is discarded, so commanding it would look like ' +
        'driving a motor while driving nothing.',
    );
  }
  requireCommandableValue(externalValue, domain);

  const slots = filledWithStop(domain);
  slots[slotIndex] = externalValue;
  return Object.freeze({
    slots: Object.freeze(slots),
    runtimeMotorCount: domain.motorCount,
    stopValue: domain.stopValue,
    commandedSlotIndex: slotIndex,
  });
}

/**
 * Widens a caller's per-motor vector to the canonical eight slots.
 *
 * `values` carries exactly `domain.motorCount` external values, in
 * logical firmware output order - the shape the command engine keeps as
 * its own intent, and the shape the operator's sliders produce. The
 * slots beyond the motor count are filled with the resolved stop value
 * for the reason in this module's header; they are never zero and never
 * a copy of a commanded value.
 *
 * Every element is validated against the resolved command domain. It
 * never clamps, rounds, pads with a guess, or truncates.
 */
export function buildCommandVectorFromValues(
  domain: MotorTestValueDomain,
  values: readonly number[],
): MotorTestCommandVector {
  requireUsableRuntimeMotorCount(domain.motorCount);
  if (!Array.isArray(values)) {
    throw new MotorTestCommandVectorError(
      `motorTestCommandVector: values must be an array, received ${typeof values}.`,
    );
  }
  if (values.length !== domain.motorCount) {
    throw new MotorTestCommandVectorError(
      `motorTestCommandVector: expected exactly ${domain.motorCount} values - the count ` +
        `MSP_MOTOR_CONFIG reported - received ${values.length}. This builder widens a ` +
        'per-motor vector to the eight-slot wire form; it does not decide how many motors exist.',
    );
  }
  const slots = filledWithStop(domain);
  for (let index = 0; index < values.length; index++) {
    // A hole is not an own property; reading it would yield undefined and
    // a numeric check might coerce it.
    if (!Object.prototype.hasOwnProperty.call(values, index)) {
      throw new MotorTestCommandVectorError(
        `motorTestCommandVector: values[${index}] is a hole; a sparse array is not a valid motor vector.`,
      );
    }
    requireCommandableValue(values[index], domain);
    slots[index] = values[index];
  }
  return Object.freeze({
    slots: Object.freeze(slots),
    runtimeMotorCount: domain.motorCount,
    stopValue: domain.stopValue,
  });
}

/**
 * The MSP_SET_MOTOR payload for a command vector: ALWAYS
 * MOTOR_TEST_COMMAND_VECTOR_BYTES, whatever the airframe.
 *
 * The width is fixed here rather than at the call sites so that no future
 * caller can reintroduce a `motorCount * 2` payload by accident - the
 * short-payload hazard this module's header traces to msp.c:2927 @ 1.47
 * has exactly one place left where it could be reintroduced, and a test
 * watches it.
 *
 * Delegates the per-value and structural checks to the accepted encoder
 * rather than duplicating them; this function contributes the WIDTH and
 * nothing else.
 */
export function encodeMotorTestCommandVector(
  vector: MotorTestCommandVector,
  domain: MotorTestValueDomain,
): Uint8Array {
  return encodeSetMotorPayload(
    vector.slots,
    MOTOR_TEST_COMMAND_VECTOR_SLOTS,
    motorCommandDomainBounds(domain),
  );
}
