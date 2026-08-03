import { MspPayloadReadError } from './MspPayloadReader';
import { decodeDetailedGps } from './decodeDetailedGps';

function payload(
  latitude: number,
  longitude: number,
  withPdop = true,
): Uint8Array {
  const bytes = new Uint8Array(withPdop ? 18 : 16);
  const view = new DataView(bytes.buffer);
  bytes[0] = 2;
  bytes[1] = 14;
  view.setInt32(2, Math.round(latitude * 10_000_000), true);
  view.setInt32(6, Math.round(longitude * 10_000_000), true);
  view.setUint16(10, 123, true);
  view.setUint16(12, 456, true);
  view.setUint16(14, 2789, true);
  if (withPdop) view.setUint16(16, 145, true);
  return bytes;
}

describe('decodeDetailedGps', () => {
  it('decodes signed coordinates and API-1.47 flight fields exactly', () => {
    expect(decodeDetailedGps(payload(-33.1234567, 151.7654321))).toEqual({
      hasFix: true,
      fixFlagRaw: 2,
      satelliteCount: 14,
      latitudeDegrees: -33.1234567,
      longitudeDegrees: 151.7654321,
      altitudeMeters: 123,
      groundSpeedCentimetersPerSecond: 456,
      groundCourseDecidegrees: 2789,
      pdopHundredths: 145,
    });
  });

  it('accepts the historical 16-byte payload without inventing PDOP', () => {
    expect(
      decodeDetailedGps(payload(0, 0, false)).pdopHundredths,
    ).toBeUndefined();
  });

  it('rejects truncated coordinates', () => {
    expect(() => decodeDetailedGps(new Uint8Array(9))).toThrow(
      MspPayloadReadError,
    );
  });

  it('rejects a half-emitted PDOP field', () => {
    const truncated = new Uint8Array(17);
    truncated.set(payload(0, 0, false));
    expect(() => decodeDetailedGps(truncated)).toThrow(MspPayloadReadError);
  });
});
