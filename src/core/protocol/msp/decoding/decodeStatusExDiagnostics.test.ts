/**
 * Pass 7.7 - the extended (single) MSP_STATUS_EX decode: the unchanged
 * fixed prefix, the previously-skipped flight-mode bits, and the bounded
 * optional readiness tail, all from ONE frame.
 */

import {decodeStatusExDiagnostics} from './decodeStatusExDiagnostics';
import {decodeStatusEx} from './decodeStatusEx';
import {MspPayloadReadError} from './MspPayloadReader';
import {STATUS_EX_FIXED_PREFIX_BYTES} from './decodeStatusExReadiness';

/** 13-byte fixed prefix, cycle=900us, i2c=0, sensors=41, flight-mode
 * flags=<supplied>, pid profile=1, cpu load=42. */
function prefix(flightModeFlagsLow32: number): number[] {
  return [
    0x84, 0x03,
    0x00, 0x00,
    0x29, 0x00,
    flightModeFlagsLow32 % 256,
    Math.floor(flightModeFlagsLow32 / 256) % 256,
    Math.floor(flightModeFlagsLow32 / 65536) % 256,
    Math.floor(flightModeFlagsLow32 / 16777216) % 256,
    1,
    0x2a, 0x00,
  ];
}

function withTail(flightModeFlagsLow32: number, tail: number[]): Uint8Array {
  return Uint8Array.from([...prefix(flightModeFlagsLow32), ...tail]);
}

describe('decodeStatusExDiagnostics', () => {
  it('keeps every field the existing compact decoder already produced', () => {
    const payload = withTail(0, []);
    const diagnostics = decodeStatusExDiagnostics(payload);
    const compact = decodeStatusEx(payload);
    expect(diagnostics.cycleTimeUs).toBe(compact.cycleTimeUs);
    expect(diagnostics.i2cErrorCount).toBe(compact.i2cErrorCount);
    expect(diagnostics.sensorPresenceMask).toBe(compact.sensorPresenceMask);
    expect(diagnostics.cpuLoadPercent).toBe(compact.cpuLoadPercent);
  });

  it('reads the flight-mode flags at offset 6 as an UNSIGNED 32-bit value', () => {
    expect(decodeStatusExDiagnostics(withTail(0, [])).flightModeFlagsLow32).toBe(0);
    expect(decodeStatusExDiagnostics(withTail(5, [])).flightModeFlagsLow32).toBe(5);
    // Bit 31 set: signed-32-bit handling would make this negative.
    const high = decodeStatusExDiagnostics(withTail(0x80000000, [])).flightModeFlagsLow32;
    expect(high).toBe(2147483648);
    expect(high).toBeGreaterThan(0);
  });

  it('a prefix-only payload is valid and carries an empty readiness tail', () => {
    const payload = withTail(0, []);
    expect(payload).toHaveLength(STATUS_EX_FIXED_PREFIX_BYTES);
    expect(decodeStatusExDiagnostics(payload).readiness).toEqual({});
  });

  it('decodes the readiness tail from the SAME frame', () => {
    // profiles=3, rate=0, 1 extension byte, count=29, mask=1<<7, config=1
    const payload = withTail(0, [3, 0, 1, 0b0000_0010, 29, 0x80, 0x00, 0x00, 0x00, 1]);
    const decoded = decodeStatusExDiagnostics(payload);
    expect(decoded.readiness.pidProfileCount).toBe(3);
    expect(decoded.readiness.extraFlightModeFlagBytes).toEqual([0b0000_0010]);
    expect(decoded.readiness.armingDisableFlags).toBe(128);
    expect(decoded.readiness.rebootRequired).toBe(true);
    // ...and the prefix fields are untouched by the tail.
    expect(decoded.sensorPresenceMask).toBe(41);
  });

  it('a shorter VALID payload simply reports fewer readiness fields', () => {
    const decoded = decodeStatusExDiagnostics(withTail(0, [3, 0]));
    expect(decoded.readiness.pidProfileCount).toBe(3);
    expect(decoded.readiness.armingDisableFlags).toBeUndefined();
    expect(decoded.flightModeFlagsLow32).toBe(0);
  });

  it('still rejects a frame shorter than the fixed prefix instead of inventing fields', () => {
    for (const length of [0, 6, 9, 12]) {
      expect(() => decodeStatusExDiagnostics(withTail(0, []).subarray(0, length))).toThrow(MspPayloadReadError);
    }
  });
});
