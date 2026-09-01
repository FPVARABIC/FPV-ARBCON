/**
 * THE WIRE CONTRACT FOR MSP_BOARD_ALIGNMENT_CONFIG (38), asserted against
 * the bytes betaflight's own firmware emits rather than against our own
 * encoder alone.
 *
 * The fixtures below are hand-built little-endian frames, not
 * `encodeBoardAlignment(...)` output, precisely so that a matching pair of
 * mistakes in the decoder and the encoder cannot cancel out and leave the
 * suite green.
 */

import {
  BOARD_ALIGNMENT_PAYLOAD_BYTES,
  decodeBoardAlignment,
} from './decodeBoardAlignment';
import {encodeBoardAlignment} from '../encoding/encodeBoardAlignment';

/** Three little-endian 16-bit words, written by hand. */
function frame(roll: number, pitch: number, yaw: number): Uint8Array {
  const payload = new Uint8Array(6);
  const view = new DataView(payload.buffer);
  view.setInt16(0, roll, true);
  view.setInt16(2, pitch, true);
  view.setInt16(4, yaw, true);
  return payload;
}

describe('board alignment wire contract (MSP 38)', () => {
  it('reads roll, pitch and yaw in that order from six bytes', () => {
    // Deliberately three different values: a decoder that swapped two
    // axes would still pass a fixture of 0/0/0 or 90/90/90.
    expect(decodeBoardAlignment(frame(10, 20, 30))).toEqual({
      rollDegrees: 10,
      pitchDegrees: 20,
      yawDegrees: 30,
    });
    expect(BOARD_ALIGNMENT_PAYLOAD_BYTES).toBe(6);
  });

  it('reads the literal bytes betaflight sends for a board mounted 90 CW', () => {
    // yaw = 90 -> 0x005A little-endian -> 0x5A 0x00
    expect(decodeBoardAlignment(Uint8Array.from([0, 0, 0, 0, 0x5a, 0]))).toEqual(
      {rollDegrees: 0, pitchDegrees: 0, yawDegrees: 90},
    );
  });

  it('decodes negative angles as negative, not as 65356', () => {
    // The firmware serialises with sbufWriteU16, so -180 travels as
    // 0xFF4C. Read unsigned it would come back as 65356 - a value the
    // UI would then refuse as out of range, and the operator would be
    // told their perfectly legal board setup was invalid.
    expect(decodeBoardAlignment(Uint8Array.from([0x4c, 0xff, 0, 0, 0, 0]))).toEqual(
      {rollDegrees: -180, pitchDegrees: 0, yawDegrees: 0},
    );
    expect(decodeBoardAlignment(frame(-1, -45, -179))).toEqual({
      rollDegrees: -1,
      pitchDegrees: -45,
      yawDegrees: -179,
    });
  });

  it('decodes the whole legal range, including the 181..360 tail', () => {
    // 360 still fits a signed 16-bit word, so the upper end of
    // cli/settings.c's -180..360 needs no special handling.
    expect(decodeBoardAlignment(frame(-180, 181, 360))).toEqual({
      rollDegrees: -180,
      pitchDegrees: 181,
      yawDegrees: 360,
    });
  });

  it('round-trips every decoded value back to the identical bytes', () => {
    for (const [roll, pitch, yaw] of [
      [0, 0, 0],
      [90, -90, 180],
      [-180, 360, 45],
      [1, -1, 359],
    ]) {
      const bytes = frame(roll, pitch, yaw);
      expect(encodeBoardAlignment(decodeBoardAlignment(bytes))).toEqual(bytes);
    }
  });

  it('refuses a short frame instead of padding it with zeros', () => {
    // Zero-padding would read as "mounted perfectly flat" - the one
    // wrong answer an operator has no way to notice.
    expect(() => decodeBoardAlignment(new Uint8Array(5))).toThrow(RangeError);
    expect(() => decodeBoardAlignment(new Uint8Array(0))).toThrow(RangeError);
  });

  it('ignores trailing bytes a future firmware might append', () => {
    const extended = Uint8Array.from([...frame(5, 6, 7), 0xaa, 0xbb]);
    expect(decodeBoardAlignment(extended)).toEqual({
      rollDegrees: 5,
      pitchDegrees: 6,
      yawDegrees: 7,
    });
  });
});
