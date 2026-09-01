/**
 * M-B - MotorTestCommandVector.
 *
 * The domains under test are resolved by the production resolver from
 * HAND-WRITTEN configuration values (protocol byte, FEATURE_3D flag,
 * mincommand, maxthrottle, neutral3d), exactly as they would arrive from
 * the decoders. The expected stop values are transcribed independently
 * from the pinned firmware's conversion functions, never read back from
 * the resolver's own output.
 *
 * Nothing here sends anything. This module has no caller in production
 * and M-B does not give it one.
 */

import {
  resolveMotorProtocolFamily,
  resolveMotorTestValueDomain,
  type MotorTestValueDomain,
} from '../firmware-adapters/betaflightMotorDomainV147';
import {
  buildAllStopCommandVector,
  buildSingleOutputCommandVector,
  MOTOR_TEST_COMMAND_VECTOR_BYTES,
  MOTOR_TEST_COMMAND_VECTOR_SLOTS,
  MotorTestCommandVectorError,
} from './motorTestCommandVector';

/** MOTOR_PROTOCOL_DSHOT600, drivers/motor_types.h:44 @ 7348054f. */
const DSHOT600 = 7;
/** MOTOR_PROTOCOL_ONESHOT125, drivers/motor_types.h:39 @ 7348054f. */
const ONESHOT125 = 1;
/** MOTOR_PROTOCOL_DISABLED, drivers/motor_types.h:47 @ 7348054f. */
const DISABLED = 9;

function digitalDomain(motorCount: number): MotorTestValueDomain {
  return resolveMotorTestValueDomain({
    motorCount,
    motorProtocolRaw: DSHOT600,
    feature3dEnabled: false,
    minCommand: 1000,
    maxThrottle: 2000,
  });
}

function digital3dDomain(motorCount: number): MotorTestValueDomain {
  return resolveMotorTestValueDomain({
    motorCount,
    motorProtocolRaw: DSHOT600,
    feature3dEnabled: true,
    minCommand: 1000,
    maxThrottle: 2000,
    motor3d: {deadband3dLow: 1406, deadband3dHigh: 1514, neutral3d: 1460},
  });
}

function analogDomain(motorCount: number): MotorTestValueDomain {
  return resolveMotorTestValueDomain({
    motorCount,
    motorProtocolRaw: ONESHOT125,
    feature3dEnabled: false,
    minCommand: 900,
    maxThrottle: 2000,
  });
}

/**
 * The motor-protocol enum the command domain is resolved from, pinned
 * ordinal by ordinal from drivers/motor_types.h @ 7348054f.
 *
 * THE GAP WHERE DSHOT1200 USED TO BE IS REAL AND MATTERS. Upstream did not
 * renumber when it dropped that protocol - it left a commented-out line,
 * `/*  MOTOR_PROTOCOL_DSHOT1200, removed *``/`, between DSHOT600 and
 * PROSHOT1000 - so PROSHOT1000 is 8 and DISABLED is 9. A table that still
 * carried DSHOT1200 would shift both by one and would resolve every
 * PROSHOT board as disabled.
 *
 * STABLE ACROSS BOTH PINNED VERSIONS. At API 1.49 (master 1efac3ef1) the
 * enum gains MOTOR_PROTOCOL_DRONECAN, appended AFTER DISABLED at ordinal
 * 10 with an upstream comment saying it was placed there so existing
 * stored values keep their meaning. Ordinals 0..9 are therefore identical
 * at both, and raw 10 resolving to UNKNOWN here is the conservative
 * reading: it is out of range at 1.47 and a family this application has
 * not audited at 1.49.
 */
describe('motorTestCommandVector - the pinned motor protocol enum', () => {
  it.each([
    [0, 'PWM', 'PWM'],
    [1, 'ONESHOT125', 'PWM'],
    [2, 'ONESHOT42', 'PWM'],
    [3, 'MULTISHOT', 'PWM'],
    [4, 'BRUSHED', 'PWM'],
    [5, 'DSHOT150', 'DSHOT'],
    [6, 'DSHOT300', 'DSHOT'],
    [7, 'DSHOT600', 'DSHOT'],
    [8, 'PROSHOT1000', 'DSHOT'],
    [9, 'DISABLED', 'UNKNOWN'],
  ])('raw %i is %s and resolves to the %s family', (raw, _name, family) => {
    expect(resolveMotorProtocolFamily(raw)).toBe(family);
  });

  it('leaves no ordinal for DSHOT1200 - PROSHOT1000 is 8, not 9', () => {
    // If DSHOT1200 were still in the table PROSHOT1000 would be 9 and
    // DISABLED 10, so 9 would resolve to a DShot family instead of UNKNOWN.
    expect(resolveMotorProtocolFamily(8)).toBe('DSHOT');
    expect(resolveMotorProtocolFamily(9)).toBe('UNKNOWN');
  });

  it('resolves anything past the pinned range to UNKNOWN rather than a family', () => {
    for (const raw of [10, 11, 255, -1, 1.5]) {
      expect(resolveMotorProtocolFamily(raw)).toBe('UNKNOWN');
    }
  });
});

describe('motorTestCommandVector - the shape', () => {
  it('is eight slots and sixteen bytes, whatever the airframe', () => {
    expect(MOTOR_TEST_COMMAND_VECTOR_SLOTS).toBe(8);
    expect(MOTOR_TEST_COMMAND_VECTOR_BYTES).toBe(16);
    for (const motorCount of [1, 2, 3, 4, 6, 8]) {
      const vector = buildAllStopCommandVector(digitalDomain(motorCount));
      expect(vector.slots).toHaveLength(8);
      expect(vector.runtimeMotorCount).toBe(motorCount);
    }
  });

  it('is frozen, so a caller cannot edit a built command in place', () => {
    const vector = buildAllStopCommandVector(digitalDomain(4));
    expect(Object.isFrozen(vector)).toBe(true);
    expect(Object.isFrozen(vector.slots)).toBe(true);
  });

  it('returns a fresh vector each time and shares no array between calls', () => {
    const first = buildAllStopCommandVector(digitalDomain(4));
    const second = buildAllStopCommandVector(digitalDomain(4));
    expect(first.slots).not.toBe(second.slots);
    expect(first.slots).toEqual(second.slots);
  });
});

describe('motorTestCommandVector - the stop value comes from the domain', () => {
  it('uses PWM_RANGE_MIN for a non-3D digital configuration', () => {
    // dshot.c:90 @ 7348054f: external exactly PWM_RANGE_MIN is
    // DSHOT_CMD_MOTOR_STOP when FEATURE_3D is off.
    const vector = buildAllStopCommandVector(digitalDomain(4));
    expect(vector.stopValue).toBe(1000);
    expect(vector.slots).toEqual([1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000]);
  });

  it('uses PWM_RANGE_MIDDLE for a digital 3D configuration, not 1000', () => {
    // dshot.c:81-82: with FEATURE_3D on, external PWM_RANGE_MIDDLE is the
    // stop, and 1000 sits at the far end of the REVERSE region. Hard-coding
    // 1000 here would command full reverse on every slot.
    const vector = buildAllStopCommandVector(digital3dDomain(4));
    expect(vector.stopValue).toBe(1500);
    expect(vector.slots.every(slot => slot === 1500)).toBe(true);
    expect(vector.slots).not.toContain(1000);
  });

  it('uses mincommand for an analog configuration, not 1000', () => {
    // motor.c analogInitEndpoints(), non-3D branch: *disarm =
    // motorConfig->mincommand. An analog board may legally sit at 900.
    const vector = buildAllStopCommandVector(analogDomain(4));
    expect(vector.stopValue).toBe(900);
    expect(vector.slots.every(slot => slot === 900)).toBe(true);
  });

  it('hard-codes no stop value in its own source', () => {
    // Proven behaviourally by the three cases above: the same builder
    // produced 1000, 1500 and 900 from three configurations.
    const stops = [
      buildAllStopCommandVector(digitalDomain(4)).stopValue,
      buildAllStopCommandVector(digital3dDomain(4)).stopValue,
      buildAllStopCommandVector(analogDomain(4)).stopValue,
    ];
    expect(new Set(stops).size).toBe(3);
  });
});

describe('motorTestCommandVector - one output, everything else stopped', () => {
  it('drives exactly the addressed slot and stops the other seven', () => {
    const vector = buildSingleOutputCommandVector(digitalDomain(4), 2, 1150);
    expect(vector.slots).toEqual([1000, 1000, 1150, 1000, 1000, 1000, 1000, 1000]);
    expect(vector.commandedSlotIndex).toBe(2);
  });

  it('fills the padding slots with the stop value, never with zero', () => {
    // Slots at and beyond the motor count are ignored by the pinned
    // firmware, but if this application's count is ever LOWER than the
    // firmware's the padding is read - and the only content that is safe
    // to be read by surprise is stop.
    const vector = buildSingleOutputCommandVector(digitalDomain(3), 0, 1100);
    expect(vector.slots.slice(3)).toEqual([1000, 1000, 1000, 1000, 1000]);
    expect(vector.slots).not.toContain(0);
  });

  it('pads a 3D configuration with the neutral, not with a reverse command', () => {
    const vector = buildSingleOutputCommandVector(digital3dDomain(3), 1, 1700);
    expect(vector.slots).toEqual([1500, 1700, 1500, 1500, 1500, 1500, 1500, 1500]);
  });

  it('addresses logical firmware output indices and never reverses them', () => {
    // Slot 0 is the firmware's first output on every build. A right-to-left
    // interface may draw it wherever it likes; renumbering it here would
    // rename the machine's motors.
    for (let index = 0; index < 4; index++) {
      const vector = buildSingleOutputCommandVector(digitalDomain(4), index, 1200);
      expect(vector.slots.indexOf(1200)).toBe(index);
    }
  });

  it('rejects a slot the firmware would never read', () => {
    // MSP_SET_MOTOR reads exactly getMotorCount() values, so writing past
    // that looks like driving a motor while driving nothing.
    for (const index of [3, 4, 7, 8, 99]) {
      expect(() => buildSingleOutputCommandVector(digitalDomain(3), index, 1200)).toThrow(
        MotorTestCommandVectorError,
      );
    }
  });

  it('rejects a negative or fractional slot index', () => {
    for (const index of [-1, 1.5, Number.NaN]) {
      expect(() => buildSingleOutputCommandVector(digitalDomain(4), index, 1200)).toThrow(
        MotorTestCommandVectorError,
      );
    }
  });

  it('rejects a value outside the resolved command domain rather than clamping it', () => {
    const digital = digitalDomain(4);
    expect(() => buildSingleOutputCommandVector(digital, 0, 2001)).toThrow(
      MotorTestCommandVectorError,
    );
    expect(() => buildSingleOutputCommandVector(digital, 0, 999)).toThrow(
      MotorTestCommandVectorError,
    );
    // The analog domain's floor is mincommand, so 900 is legal there and
    // 899 is not - the bound moves with the configuration.
    const analog = analogDomain(4);
    expect(buildSingleOutputCommandVector(analog, 0, 900).slots[0]).toBe(900);
    expect(() => buildSingleOutputCommandVector(analog, 0, 899)).toThrow(
      MotorTestCommandVectorError,
    );
  });

  it('rejects a fractional value rather than rounding it', () => {
    expect(() => buildSingleOutputCommandVector(digitalDomain(4), 0, 1100.5)).toThrow(
      MotorTestCommandVectorError,
    );
  });
});

describe('motorTestCommandVector - counts it will not accept', () => {
  it('refuses a motor count above the firmware maximum', () => {
    // The domain resolver refuses first, which is the point: there is no
    // path from a nine-motor claim to a command vector.
    expect(() => digitalDomain(9)).toThrow();
  });

  it('refuses a zero motor count, which can produce no command at all', () => {
    expect(() => digitalDomain(0)).toThrow();
  });

  it('refuses a protocol with no external conversion', () => {
    expect(() =>
      resolveMotorTestValueDomain({
        motorCount: 4,
        motorProtocolRaw: DISABLED,
        feature3dEnabled: false,
        minCommand: 1000,
        maxThrottle: 2000,
      }),
    ).toThrow();
  });
});

/**
 * P0-D. A fixed eight-slot payload is the LONGEST legal MSP_SET_MOTOR
 * body, which is what makes it safe on both pinned API versions: it can
 * never under-run the 1.47 handler, which has no length guard at all, and
 * it always satisfies the 1.49 handler's `dataSize < getMotorCount() * 2`
 * rejection. These tests hold the property that argument depends on.
 */
describe('motorTestCommandVector - P0-D, the fixed-width safety argument', () => {
  it('is never shorter than the firmware will read, at any motor count', () => {
    for (const motorCount of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const vector = buildAllStopCommandVector(digitalDomain(motorCount));
      const payloadBytes = vector.slots.length * 2;
      expect(payloadBytes).toBeGreaterThanOrEqual(motorCount * 2);
      expect(payloadBytes).toBe(MOTOR_TEST_COMMAND_VECTOR_BYTES);
    }
  });

  it('carries a defined value in every slot, including the ones past the count', () => {
    const vector = buildSingleOutputCommandVector(digitalDomain(2), 1, 1300);
    expect(vector.slots).toHaveLength(8);
    for (const slot of vector.slots) {
      expect(Number.isInteger(slot)).toBe(true);
      expect(slot).toBeGreaterThan(0);
    }
  });

  it('never widens with the motor count - the width is a property of the command', () => {
    const widths = [1, 4, 8].map(
      count => buildAllStopCommandVector(digitalDomain(count)).slots.length,
    );
    expect(new Set(widths)).toEqual(new Set([8]));
  });
});
