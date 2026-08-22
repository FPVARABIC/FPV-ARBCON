/**
 * Pass 1B - byte-level tests for the pure MSP_SET_MOTOR payload encoder.
 *
 * NO HARDWARE OF ANY KIND is required, referenced or simulated: no
 * flight controller, no USB, no transport, no MspClient, no ESC, no
 * motor, no LiPo, no timers. Every expectation is a hand-written byte
 * array compared against a pure function.
 *
 * NOTHING HERE DESCRIBES ANY VALUE AS SAFE. 1001 appears only as the
 * protocol floor - the lowest external value that is not stop - so byte
 * order can be pinned against a stable fixture. It is not an idle value,
 * not a recommendation, and not known to spin any motor.
 */

import {
  encodeSetMotorPayload,
  MspSetMotorEncodeError,
  MSP_SET_MOTOR_EXTERNAL_MAX_VALUE,
  MSP_SET_MOTOR_EXTERNAL_MIN_VALUE,
  MSP_SET_MOTOR_MAX_MOTOR_COUNT,
  MSP_SET_MOTOR_MIN_MOTOR_COUNT,
} from './encodeSetMotorPayload';

const STOP = MSP_SET_MOTOR_EXTERNAL_MIN_VALUE;
/** Protocol floor only - see this file's own doc comment. */
const PROTOCOL_FLOOR = STOP + 1;
const ALL_STOP = [STOP, STOP, STOP, STOP];

const bytes = (payload: Uint8Array): number[] => Array.from(payload);

describe('encodeSetMotorPayload - constants', () => {
  it('pins the firmware bounds and the external range to the verified values', () => {
    // M-C: the two QUAD-ONLY constants that used to be pinned here -
    // MSP_SET_MOTOR_SUPPORTED_MOTOR_COUNT (4) and
    // MSP_SET_MOTOR_PAYLOAD_BYTES (8) - are GONE. The first was a product
    // scope rather than a firmware limit; the second named eight bytes as
    // "the" payload size when the canonical body is sixteen. What remains
    // is what the firmware actually says.
    expect(MSP_SET_MOTOR_MIN_MOTOR_COUNT).toBe(1);
    expect(MSP_SET_MOTOR_MAX_MOTOR_COUNT).toBe(8);
    expect(MSP_SET_MOTOR_EXTERNAL_MIN_VALUE).toBe(1000);
    expect(MSP_SET_MOTOR_EXTERNAL_MAX_VALUE).toBe(2000);
  });

  it('encodes the CANONICAL sixteen-byte body when asked for eight slots', () => {
    // The width the motor-test path now always uses. Proven here, at the
    // encoder, so the property survives even if a caller changes.
    const eightStops = new Array<number>(8).fill(1000);
    expect(encodeSetMotorPayload(eightStops, 8)).toHaveLength(16);
  });
});

describe('encodeSetMotorPayload - accepted vectors', () => {
  it('encodes the all-stop vector as exactly eight bytes', () => {
    const payload = encodeSetMotorPayload(ALL_STOP, 4);
    expect(payload).toBeInstanceOf(Uint8Array);
    expect(payload.length).toBe(8);
    expect(bytes(payload)).toEqual([0xe8, 0x03, 0xe8, 0x03, 0xe8, 0x03, 0xe8, 0x03]);
  });

  it('encodes the M2 protocol-floor fixture in little-endian order', () => {
    // PROTOCOL-FLOOR ENCODING FIXTURE ONLY. Output index 1 at the lowest
    // non-stop external value. This pins byte order and offsets; it is
    // NOT a recommended, safe or effective hardware pulse.
    const payload = encodeSetMotorPayload([STOP, PROTOCOL_FLOOR, STOP, STOP], 4);
    expect(bytes(payload)).toEqual([0xe8, 0x03, 0xe9, 0x03, 0xe8, 0x03, 0xe8, 0x03]);
  });

  it('places the active value at the requested index and nowhere else', () => {
    for (let index = 0; index < 4; index++) {
      const values = [STOP, STOP, STOP, STOP];
      values[index] = 1234;
      const payload = bytes(encodeSetMotorPayload(values, 4));
      expect(payload[index * 2]).toBe(0xd2);
      expect(payload[index * 2 + 1]).toBe(0x04);
      for (let other = 0; other < 4; other++) {
        if (other === index) {
          continue;
        }
        expect(payload[other * 2]).toBe(0xe8);
        expect(payload[other * 2 + 1]).toBe(0x03);
      }
    }
  });

  it('encodes the maximum legal value little-endian', () => {
    const payload = encodeSetMotorPayload([STOP, STOP, STOP, MSP_SET_MOTOR_EXTERNAL_MAX_VALUE], 4);
    expect(bytes(payload).slice(6)).toEqual([0xd0, 0x07]);
  });

  it('accepts exactly one non-stop value', () => {
    expect(() => encodeSetMotorPayload([1500, STOP, STOP, STOP], 4)).not.toThrow();
  });
});

describe('encodeSetMotorPayload - allocation and immutability', () => {
  it('returns a freshly allocated buffer on every call', () => {
    const first = encodeSetMotorPayload(ALL_STOP, 4);
    const second = encodeSetMotorPayload(ALL_STOP, 4);
    expect(first).not.toBe(second);
    expect(first.buffer).not.toBe(second.buffer);
    first[0] = 0xff;
    expect(second[0]).toBe(0xe8);
    // A later call is unaffected by mutating an earlier result.
    expect(bytes(encodeSetMotorPayload(ALL_STOP, 4))[0]).toBe(0xe8);
  });

  it('does not mutate the caller-owned input array', () => {
    const values = [STOP, PROTOCOL_FLOOR, STOP, STOP];
    const snapshot = [...values];
    encodeSetMotorPayload(values, 4);
    expect(values).toEqual(snapshot);
  });

  it('is unaffected by mutating the input array afterwards', () => {
    const values = [STOP, PROTOCOL_FLOOR, STOP, STOP];
    const payload = encodeSetMotorPayload(values, 4);
    values[1] = 2000;
    expect(bytes(payload)).toEqual([0xe8, 0x03, 0xe9, 0x03, 0xe8, 0x03, 0xe8, 0x03]);
  });
});

describe('encodeSetMotorPayload - motorCount validation', () => {
  /* REWRITTEN IN P1-A. The old assertion was "every motorCount except 4
   * throws", which encoded an approved product scope rather than the
   * protocol. MAX_SUPPORTED_MOTORS is 8
   * (target/common_defaults_post.h:351 @ 79065c96), so 1..8 are legal
   * counts and only counts outside that range - or a length mismatch
   * against the supplied vector - are rejected here. */
  it('rejects motorCounts outside 1..8, and length mismatches inside it', () => {
    for (const motorCount of [0, -1, -4, 9, 12]) {
      expect(() => encodeSetMotorPayload(ALL_STOP, motorCount)).toThrow(MspSetMotorEncodeError);
    }
    // In-range counts are legal, but the vector must match them exactly.
    for (const motorCount of [1, 2, 3, 5, 6, 8]) {
      expect(() => encodeSetMotorPayload(ALL_STOP, motorCount)).toThrow(MspSetMotorEncodeError);
    }
  });

  it('rejects fractional, NaN and infinite motorCount', () => {
    for (const motorCount of [3.5, 4.1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => encodeSetMotorPayload(ALL_STOP, motorCount)).toThrow(MspSetMotorEncodeError);
    }
  });

  it('requires motorCount explicitly - there is no default overload', () => {
    expect(encodeSetMotorPayload).toHaveLength(2);
  });
});

describe('encodeSetMotorPayload - array shape validation', () => {
  it('rejects a wrong number of values', () => {
    expect(() => encodeSetMotorPayload([STOP, STOP, STOP], 4)).toThrow(MspSetMotorEncodeError);
    expect(() => encodeSetMotorPayload([STOP, STOP, STOP, STOP, STOP], 4)).toThrow(
      MspSetMotorEncodeError,
    );
    expect(() => encodeSetMotorPayload([], 4)).toThrow(MspSetMotorEncodeError);
  });

  it('rejects a sparse array even when its length is correct', () => {
    const sparse: number[] = [STOP, STOP, STOP, STOP];
    delete sparse[1];
    expect(sparse).toHaveLength(4);
    expect(Object.prototype.hasOwnProperty.call(sparse, 1)).toBe(false);
    expect(() => encodeSetMotorPayload(sparse, 4)).toThrow(MspSetMotorEncodeError);
  });

  it('rejects non-array input', () => {
    const notArrays = [null, undefined, 1000, 'stop', {0: STOP, length: 4}];
    for (const candidate of notArrays) {
      expect(() =>
        encodeSetMotorPayload(candidate as unknown as readonly number[], 4),
      ).toThrow(MspSetMotorEncodeError);
    }
  });
});

describe('encodeSetMotorPayload - value validation', () => {
  const withValue = (value: number): number[] => [value, STOP, STOP, STOP];

  it('rejects values outside 1000..2000, never clamping them', () => {
    for (const value of [0, 1, 999, -1, -1000, 2001, 3000, 65535]) {
      expect(() => encodeSetMotorPayload(withValue(value), 4)).toThrow(MspSetMotorEncodeError);
    }
  });

  it('rejects fractional, NaN and infinite values, never rounding them', () => {
    for (const value of [
      1000.5,
      1500.0001,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(() => encodeSetMotorPayload(withValue(value), 4)).toThrow(MspSetMotorEncodeError);
    }
  });

  it('rejects non-number values without coercing them', () => {
    const notNumbers = [null, undefined, '1500', true, {}, []];
    for (const value of notNumbers) {
      expect(() =>
        encodeSetMotorPayload([value as unknown as number, STOP, STOP, STOP], 4),
      ).toThrow(MspSetMotorEncodeError);
    }
  });

  it('accepts both boundary values', () => {
    expect(() => encodeSetMotorPayload(ALL_STOP, 4)).not.toThrow();
    expect(() =>
      encodeSetMotorPayload([MSP_SET_MOTOR_EXTERNAL_MAX_VALUE, STOP, STOP, STOP], 4),
    ).not.toThrow();
  });
});

/**
 * REWRITTEN IN P1-A, NOT DELETED.
 *
 * This block previously asserted a ONE-ACTIVE-MOTOR INVARIANT: a payload
 * could be all-stop or carry exactly one value above stop, and anything
 * else threw. That rule described the old single-pulse product, not
 * MSP_SET_MOTOR. src/main/msp/msp.c @ 79065c96 reads the request as a
 * plain vector -
 *
 *     case MSP_SET_MOTOR:
 *         for (int i = 0; i < getMotorCount(); i++) {
 *             motor_disarmed[i] = motorConvertFromExternal(sbufReadU16(src));
 *         }
 *
 * - and both reference configurators drive every element independently.
 *
 * The SAFETY INTENT the old block carried is preserved and moved, not
 * dropped: how many outputs a caller may command is decided by the layers
 * above (the lease, the armed-state evidence, the arming restriction and,
 * for the shipping path, `assertSupportedMotorScope` +
 * `buildSingleMotorVector`, all unchanged by P1). What is removed is only
 * this pure encoder's claim that the protocol forbids a multi-element
 * vector, which it never did.
 */
describe('encodeSetMotorPayload - full motor vectors (P1-A contract)', () => {
  it('accepts the all-stop vector', () => {
    expect(() => encodeSetMotorPayload(ALL_STOP, 4)).not.toThrow();
  });

  it('accepts several independently different values in one vector', () => {
    const payload = encodeSetMotorPayload([1100, 1200, 1300, 1400], 4);
    expect(Array.from(payload)).toEqual([
      1100 & 0xff, 1100 >> 8,
      1200 & 0xff, 1200 >> 8,
      1300 & 0xff, 1300 >> 8,
      1400 & 0xff, 1400 >> 8,
    ]);
  });

  it('accepts a master-style vector where every element is equal', () => {
    const payload = encodeSetMotorPayload([1250, 1250, 1250, 1250], 4);
    const view = new DataView(payload.buffer);
    for (let index = 0; index < 4; index += 1) {
      expect(view.getUint16(index * 2, true)).toBe(1250);
    }
  });

  it('accepts a multi-element vector at the protocol floor', () => {
    expect(() =>
      encodeSetMotorPayload([PROTOCOL_FLOOR, PROTOCOL_FLOOR, STOP, STOP], 4),
    ).not.toThrow();
  });
});

describe('encodeSetMotorPayload - motor count range (P1-A contract)', () => {
  const stopVector = (motorCount: number): number[] =>
    Array.from({length: motorCount}, () => STOP);

  it('encodes exactly motorCount * 2 bytes for every supported count', () => {
    for (let motorCount = 1; motorCount <= 8; motorCount += 1) {
      const payload = encodeSetMotorPayload(stopVector(motorCount), motorCount);
      expect(payload).toHaveLength(motorCount * 2);
    }
  });

  it('rejects motorCount 0 and motorCount above MAX_SUPPORTED_MOTORS', () => {
    for (const motorCount of [0, -1, 9, 12, 255]) {
      expect(() =>
        encodeSetMotorPayload(stopVector(Math.max(0, motorCount)), motorCount),
      ).toThrow(MspSetMotorEncodeError);
    }
  });

  it('rejects a values array whose length does not equal motorCount', () => {
    expect(() => encodeSetMotorPayload(stopVector(3), 4)).toThrow(MspSetMotorEncodeError);
    expect(() => encodeSetMotorPayload(stopVector(5), 4)).toThrow(MspSetMotorEncodeError);
    expect(() => encodeSetMotorPayload(stopVector(6), 6)).not.toThrow();
  });
});

describe('encodeSetMotorPayload - supplied external domain (P1-A contract)', () => {
  it('measures values against a supplied analog domain, not PWM_RANGE', () => {
    // An analog board may legally report mincommand 900 (pg/motor.h:85).
    const analog = {externalMin: 900, externalMax: 1900};
    expect(() => encodeSetMotorPayload([900, 900, 900, 900], 4, analog)).not.toThrow();
    expect(() => encodeSetMotorPayload([1950, 900, 900, 900], 4, analog)).toThrow(
      MspSetMotorEncodeError,
    );
    // The same 900 is out of range under the default DShot domain.
    expect(() => encodeSetMotorPayload([900, 900, 900, 900], 4)).toThrow(
      MspSetMotorEncodeError,
    );
  });

  it('rejects an inverted or non-integer domain', () => {
    expect(() =>
      encodeSetMotorPayload(ALL_STOP, 4, {externalMin: 2000, externalMax: 1000}),
    ).toThrow(MspSetMotorEncodeError);
    expect(() =>
      encodeSetMotorPayload(ALL_STOP, 4, {externalMin: 1000.5, externalMax: 2000}),
    ).toThrow(MspSetMotorEncodeError);
  });

  it('rejects a domain outside the u16 wire field', () => {
    expect(() =>
      encodeSetMotorPayload([70000, 70000, 70000, 70000], 4, {
        externalMin: 0,
        externalMax: 70000,
      }),
    ).toThrow(MspSetMotorEncodeError);
  });
});

describe('encodeSetMotorPayload - containment', () => {
  it('exposes no transport, client, frame, timer or hardware surface', () => {
    const module: Record<string, unknown> = {
      encodeSetMotorPayload,
      MspSetMotorEncodeError,
      MSP_SET_MOTOR_EXTERNAL_MAX_VALUE,
      MSP_SET_MOTOR_EXTERNAL_MIN_VALUE,
      MSP_SET_MOTOR_MAX_MOTOR_COUNT,
      MSP_SET_MOTOR_MIN_MOTOR_COUNT,
    };
    for (const key of Object.keys(module)) {
      expect(key).not.toMatch(/transport|client|send|write|request|frame|usb|timer|interval/i);
    }
  });

  it('returns payload bytes only - never a framed MSP request', () => {
    const payload = encodeSetMotorPayload(ALL_STOP, 4);
    // A framed MSP v1 request would begin with '$' 'M' '<'; a payload
    // never does, and is exactly motorCount * 2 bytes long.
    expect(payload.length).toBe(8);
    expect(payload[0]).not.toBe(0x24);
  });
});
