import {decodeAttitude} from './decodeAttitude';
import {MspPayloadReadError} from './MspPayloadReader';

/** Little-endian int16 byte pair for a signed decidegree/degree value. */
function s16le(value: number): number[] {
  const unsigned = value < 0 ? value + 0x10000 : value;
  return [unsigned & 0xff, (unsigned >> 8) & 0xff];
}

describe('decodeAttitude', () => {
  it('decodes a realistic full payload correctly: positive roll, negative pitch, non-zero yaw', () => {
    // rollDecidegrees=150 (15.0 deg), pitchDecidegrees=-300 (-30.0 deg),
    // yawDegrees=270 - roll/pitch in decidegrees, yaw in whole degrees,
    // per this decoder's own verified unit finding.
    const payload = Uint8Array.from([...s16le(150), ...s16le(-300), ...s16le(270)]);
    expect(decodeAttitude(payload)).toEqual({
      rollDecidegrees: 150,
      pitchDecidegrees: -300,
      yawDegrees: 270,
    });
  });

  it('decodes negative roll and pitch correctly - not merely non-negative values', () => {
    const payload = Uint8Array.from([...s16le(-150), ...s16le(-899), ...s16le(0)]);
    expect(decodeAttitude(payload)).toEqual({
      rollDecidegrees: -150,
      pitchDecidegrees: -899,
      yawDegrees: 0,
    });
  });

  it('decodes the int16 boundary values correctly: 32767 and -32768', () => {
    const payload = Uint8Array.from([...s16le(32767), ...s16le(-32768), ...s16le(359)]);
    expect(decodeAttitude(payload)).toEqual({
      rollDecidegrees: 32767,
      pitchDecidegrees: -32768,
      yawDegrees: 359,
    });
  });

  it('throws MspPayloadReadError for an empty payload', () => {
    expect(() => decodeAttitude(new Uint8Array(0))).toThrow(MspPayloadReadError);
  });

  it('throws MspPayloadReadError when truncated one byte short of roll (1 of 2 bytes)', () => {
    const payload = Uint8Array.from(s16le(150).slice(0, 1));
    expect(() => decodeAttitude(payload)).toThrow(MspPayloadReadError);
  });

  it('throws MspPayloadReadError when truncated mid-pitch (roll complete, pitch 1 of 2 bytes)', () => {
    const payload = Uint8Array.from([...s16le(150), ...s16le(-300).slice(0, 1)]);
    expect(() => decodeAttitude(payload)).toThrow(MspPayloadReadError);
  });

  it('throws MspPayloadReadError when truncated mid-yaw (roll+pitch complete, yaw 1 of 2 bytes)', () => {
    const payload = Uint8Array.from([...s16le(150), ...s16le(-300), ...s16le(270).slice(0, 1)]);
    expect(() => decodeAttitude(payload)).toThrow(MspPayloadReadError);
  });

  it('ignores trailing bytes beyond the 6 it needs (forward-only reader, no strict-length check)', () => {
    const payload = Uint8Array.from([...s16le(150), ...s16le(-300), ...s16le(270), 0xaa, 0xbb]);
    expect(decodeAttitude(payload)).toEqual({
      rollDecidegrees: 150,
      pitchDecidegrees: -300,
      yawDegrees: 270,
    });
  });
});
