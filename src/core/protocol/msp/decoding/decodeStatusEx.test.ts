import {decodeStatusEx, STATUS_SENSOR_GPS_BIT} from './decodeStatusEx';
import {MspPayloadReadError} from './MspPayloadReader';

/** Hand-assembled little-endian payload - independent of the decoder's
 * own reader (verified MSP_STATUS_EX 13-byte fixed prefix,
 * mspCommandSources.ts). */
function payload(bytes: number[]): Uint8Array {
  return Uint8Array.from(bytes);
}

const GOLDEN = payload([
  0x84, 0x03, // cycle time u16le = 900us
  0x07, 0x00, // i2c errors u16le = 7
  0x29, 0x00, // sensor mask u16le = 41 = ACC|GPS|GYRO (1+8+32)
  0xef, 0xbe, 0xad, 0xde, // flightModeFlags u32le - skipped
  1, // pid profile index u8 - skipped
  0x2a, 0x00, // cpu load u16le = 42%
]);

describe('decodeStatusEx', () => {
  it('decodes the exact 13-byte fixed prefix with independent expected literals', () => {
    expect(decodeStatusEx(GOLDEN)).toEqual({
      cycleTimeUs: 900,
      i2cErrorCount: 7,
      sensorPresenceMask: 41,
      cpuLoadPercent: 42,
    });
  });

  it('skips flightModeFlags and pid profile index without letting their values leak into any decoded field', () => {
    const zeroSkipped = payload([0x84, 0x03, 0x07, 0x00, 0x29, 0x00, 0, 0, 0, 0, 0, 0x2a, 0x00]);
    expect(decodeStatusEx(zeroSkipped)).toEqual(decodeStatusEx(GOLDEN));
  });

  it('exposes GPS presence through STATUS_SENSOR_GPS_BIT = 8 (the raw 1<<3 mask bit)', () => {
    expect(STATUS_SENSOR_GPS_BIT).toBe(8);
    // Masks asserted as exact decoded numbers (no bitwise re-derivation in
    // the test): 41 = GYRO(32) + GPS(8) + ACC(1); 33 = GYRO(32) + ACC(1) -
    // every bit of GOLDEN's mask except GPS.
    expect(decodeStatusEx(GOLDEN).sensorPresenceMask).toBe(41);
    const withoutGps = decodeStatusEx(payload([0x84, 0x03, 0x07, 0x00, 0x21, 0x00, 0, 0, 0, 0, 0, 0x2a, 0x00]));
    expect(withoutGps.sensorPresenceMask).toBe(33);
  });

  it('covers cpu load bounds 0 and 100 (firmware constrains to LOAD_PERCENTAGE_ONE=100) verbatim', () => {
    const zero = payload([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0x00]);
    const hundred = payload([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x64, 0x00]);
    expect(decodeStatusEx(zero).cpuLoadPercent).toBe(0);
    expect(decodeStatusEx(hundred).cpuLoadPercent).toBe(100);
  });

  it('preserves the cumulative i2c error counter exactly, including its u16 maximum', () => {
    const max = payload([0, 0, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(decodeStatusEx(max).i2cErrorCount).toBe(65535);
  });

  it('throws MspPayloadReadError for EVERY truncated length 0 through 12 - the full 13-byte prefix is mandatory', () => {
    for (let length = 0; length <= 12; length++) {
      expect(() => decodeStatusEx(GOLDEN.slice(0, length))).toThrow(MspPayloadReadError);
    }
  });

  it('accepts and ignores the version-variable tail past offset 12 (profile counts, flight-mode tail, etc.)', () => {
    const withTail = payload([...Array.from(GOLDEN), 3, 0, 4, 0x01, 0x02, 0x03, 0x04]);
    expect(decodeStatusEx(withTail)).toEqual(decodeStatusEx(GOLDEN));
  });
});
