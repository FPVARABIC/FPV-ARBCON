/**
 * ONE OWNED BYTE, EIGHTEEN PRESERVED ONES.
 *
 * MSP_SET_ADVANCED_CONFIG carries settings from several screens. Blackbox
 * owns `debugMode` and nothing else, so the encoder's job is to hand every
 * other field back exactly as the flight controller reported it.
 *
 * The fixture below uses a distinctive value for every unowned field, so a
 * substituted default is visible in the assertion rather than hidden behind
 * a plausible-looking zero.
 */

import {decodeAdvancedConfig} from '../decoding/decodeAdvancedConfig';
import {
  ADVANCED_CONFIG_WRITE_BYTES,
  encodeAdvancedConfigDebugMode,
} from './encodeAdvancedConfigDebugMode';

/**
 * A 20-byte MSP_ADVANCED_CONFIG response, hand-written:
 *   0  gyroSyncDenom 17        1  pidProcessDenom 4
 *   2  useContinuousUpdate 1   3  motorProtocol 6
 *   4  motorPwmRate 480 = 0x01E0 -> E0 01
 *   6  motorIdle 550 = 0x0226   -> 26 02
 *   8  gyroUse32kHz 0          9  motorInversion 1
 *  10  gyroToUse 2            11  gyroHighFsr 1
 *  12  gyroMovementCalThreshold 203
 *  13  gyroCalibrationDuration 125 = 0x007D -> 7D 00
 *  15  gyroYawOffset -1234 -> 0xFB2E signed LE -> 2E FB
 *  17  checkOverflow 1        18  debugMode 9
 *  19  debugModeCount 60      (read-only, never echoed)
 */
const RESPONSE = Uint8Array.from([
  17, 4, 1, 6,
  0xe0, 0x01,
  0x26, 0x02,
  0, 1, 2, 1, 203,
  0x7d, 0x00,
  0x2e, 0xfb,
  1,
  9,
  60,
]);

describe('MSP_SET_ADVANCED_CONFIG for a blackbox debug-mode change', () => {
  it('writes nineteen bytes and drops the read-only count byte', () => {
    const payload = encodeAdvancedConfigDebugMode(
      decodeAdvancedConfig(RESPONSE),
      42,
    );
    expect(payload).toHaveLength(ADVANCED_CONFIG_WRITE_BYTES);
    expect(payload).toHaveLength(19);
  });

  it('changes byte 18 and nothing else', () => {
    const original = decodeAdvancedConfig(RESPONSE);
    const payload = encodeAdvancedConfigDebugMode(original, 42);
    expect(Array.from(payload)).toEqual([
      17, 4, 1, 6,
      0xe0, 0x01,
      0x26, 0x02,
      0, 1, 2, 1, 203,
      0x7d, 0x00,
      0x2e, 0xfb,
      1,
      42,
    ]);
    // Stated the other way round: the first eighteen bytes are the response's.
    expect(Array.from(payload.slice(0, 18))).toEqual(
      Array.from(RESPONSE.slice(0, 18)),
    );
  });

  it('writes the negative yaw offset back with its sign intact', () => {
    // -1234 as a signed 16-bit little-endian pair is 2E FB. Asserting the
    // bytes rather than a decode keeps this a statement about the wire -
    // and the 19-byte write frame is deliberately one byte short of what
    // decodeAdvancedConfig requires, because DEBUG_COUNT is read-only.
    const payload = encodeAdvancedConfigDebugMode(
      decodeAdvancedConfig(RESPONSE),
      0,
    );
    expect(Array.from(payload.slice(15, 17))).toEqual([0x2e, 0xfb]);
    expect(new DataView(payload.buffer).getInt16(15, true)).toBe(-1234);
  });

  it('refuses a debug mode that does not fit its byte', () => {
    const original = decodeAdvancedConfig(RESPONSE);
    expect(() => encodeAdvancedConfigDebugMode(original, 256)).toThrow(
      RangeError,
    );
    expect(() => encodeAdvancedConfigDebugMode(original, -1)).toThrow(
      RangeError,
    );
    expect(() => encodeAdvancedConfigDebugMode(original, 1.5)).toThrow(
      RangeError,
    );
  });
});
