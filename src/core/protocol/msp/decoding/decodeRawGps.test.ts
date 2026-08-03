import { decodeRawGps } from './decodeRawGps';
import { MspPayloadReadError } from './MspPayloadReader';

/** Hand-assembled little-endian payload - independent of the decoder's
 * own reader (verified MSP_RAW_GPS contract, mspCommandSources.ts). */
function payload(bytes: number[]): Uint8Array {
  return Uint8Array.from(bytes);
}

// Deliberately NON-ZERO coordinate bytes: the privacy assertions below
// must prove they are dropped even when real-looking data is present.
const GOLDEN = payload([
  2, // fix flag = raw GPS_FIX bit (1<<1) - the value is 2, NOT 1
  11, // numSat
  0x15,
  0xcd,
  0x5b,
  0x07, // lat u32le (dropped)
  0xa1,
  0x86,
  0x01,
  0x00, // lon u32le (dropped)
  0x2c,
  0x01, // altitude = 300 m
  0x64,
  0x00, // ground speed = 100 cm/s
  0x10,
  0x27, // ground course = 10000 decidegrees
]);

describe('decodeRawGps', () => {
  it('decodes fix, satellite count and the non-location flight facts', () => {
    expect(decodeRawGps(GOLDEN)).toEqual({
      hasFix: true,
      satelliteCount: 11,
      altitudeMeters: 300,
      groundSpeedCentimetersPerSecond: 100,
      groundCourseDecidegrees: 10000,
    });
  });

  it('treats the fix byte as the RAW GPS_FIX bit: 0 = no fix, 2 = fix (never assumes the value 1)', () => {
    const noFix = payload([0, 5, ...Array.from(GOLDEN.slice(2))]);
    const rawBit = payload([2, 5, ...Array.from(GOLDEN.slice(2))]);
    expect(decodeRawGps(noFix).hasFix).toBe(false);
    expect(decodeRawGps(rawBit).hasFix).toBe(true);
  });

  it('treats ANY nonzero flag value as a fix (generic flag - no 2D/3D distinction exists on this wire)', () => {
    for (const raw of [1, 2, 3, 0xff]) {
      expect(
        decodeRawGps(payload([raw, 0, ...Array.from(GOLDEN.slice(2))])).hasFix,
      ).toBe(true);
    }
  });

  it('NEVER retains coordinates while retaining non-location flight facts', () => {
    const decoded = decodeRawGps(GOLDEN);
    expect(Object.keys(decoded).sort()).toEqual(
      [
        'altitudeMeters',
        'groundCourseDecidegrees',
        'groundSpeedCentimetersPerSecond',
        'hasFix',
        'satelliteCount',
      ].sort(),
    );
    expect(JSON.stringify(decoded)).not.toContain('123456789'); // 0x075bcd15 = 123456789 (the lat bytes)
  });

  it('throws MspPayloadReadError for EVERY truncated length 0 through 15 - all 16 mandatory bytes are required', () => {
    for (let length = 0; length <= 15; length++) {
      expect(() => decodeRawGps(GOLDEN.slice(0, length))).toThrow(
        MspPayloadReadError,
      );
    }
  });

  it('accepts and ignores the pdop trailing field (API >=1.44) and any further trailing bytes', () => {
    const withPdop = payload([...Array.from(GOLDEN), 0x2c, 0x01]);
    const withMore = payload([...Array.from(GOLDEN), 0x2c, 0x01, 0xde]);
    expect(decodeRawGps(withPdop)).toEqual(decodeRawGps(GOLDEN));
    expect(decodeRawGps(withMore)).toEqual(decodeRawGps(GOLDEN));
  });

  it('covers satellite count extremes 0 and 255 verbatim', () => {
    expect(
      decodeRawGps(payload([2, 0, ...Array.from(GOLDEN.slice(2))]))
        .satelliteCount,
    ).toBe(0);
    expect(
      decodeRawGps(payload([2, 255, ...Array.from(GOLDEN.slice(2))]))
        .satelliteCount,
    ).toBe(255);
  });
});
