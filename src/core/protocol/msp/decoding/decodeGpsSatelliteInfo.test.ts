import { MspPayloadReadError } from './MspPayloadReader';
import { decodeGpsSatelliteInfo } from './decodeGpsSatelliteInfo';

describe('decodeGpsSatelliteInfo', () => {
  it('keeps a short legacy list honest instead of inventing a constellation', () => {
    const decoded = decodeGpsSatelliteInfo(
      Uint8Array.from([1, 9, 22, 0x0d, 37]),
    );
    expect(decoded.usesGnssIdentifiers).toBe(false);
    expect(decoded.satellites[0]).toMatchObject({
      channelOrGnssId: 9,
      satelliteId: 22,
      quality: 5,
      used: true,
      signalToNoiseDbHz: 37,
      constellation: 'LEGACY',
    });
  });

  it('decodes GNSS identifiers in the extended representation', () => {
    const bytes = new Uint8Array(1 + 17 * 4);
    bytes[0] = 17;
    for (let index = 0; index < 17; index += 1) {
      bytes[1 + index * 4] = index === 0 ? 2 : 6;
      bytes[2 + index * 4] = index + 1;
      bytes[3 + index * 4] = 8;
      bytes[4 + index * 4] = 30;
    }
    const decoded = decodeGpsSatelliteInfo(bytes);
    expect(decoded.usesGnssIdentifiers).toBe(true);
    expect(decoded.satellites[0].constellation).toBe('GALILEO');
    expect(decoded.satellites[1].constellation).toBe('GLONASS');
  });

  it('rejects impossible counts and truncated records', () => {
    expect(() => decodeGpsSatelliteInfo(Uint8Array.from([65]))).toThrow(
      MspPayloadReadError,
    );
    expect(() =>
      decodeGpsSatelliteInfo(Uint8Array.from([2, 0, 1, 2, 3])),
    ).toThrow(MspPayloadReadError);
  });
});
