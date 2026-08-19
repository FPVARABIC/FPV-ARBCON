/**
 * THE WRITE FRAME FOR MSP_SET_BOARD_ALIGNMENT_CONFIG (39).
 *
 * Two properties matter here beyond byte layout:
 *
 *   - an invalid draft must never become bytes. A value silently
 *     truncated into a 16-bit field is the "app showed one thing, board
 *     stored another" defect, and it must fail loudly at this boundary.
 *   - a save with no edits must produce no frame at all, so the app
 *     never spends an EEPROM erase cycle proving nothing changed.
 */

import {
  BOARD_ALIGNMENT_WRITE_BYTES,
  encodeBoardAlignment,
  encodeChangedBoardAlignment,
} from './encodeBoardAlignment';
import {decodeBoardAlignment} from '../decoding/decodeBoardAlignment';

const NEUTRAL = {rollDegrees: 0, pitchDegrees: 0, yawDegrees: 0};

describe('board alignment write frame (MSP 39)', () => {
  it('writes six bytes: roll, pitch, yaw, little-endian', () => {
    expect(
      encodeBoardAlignment({rollDegrees: 10, pitchDegrees: 20, yawDegrees: 30}),
    ).toEqual(Uint8Array.from([10, 0, 20, 0, 30, 0]));
    expect(BOARD_ALIGNMENT_WRITE_BYTES).toBe(6);
  });

  it('writes negative angles as two’s complement, matching the firmware', () => {
    expect(
      encodeBoardAlignment({rollDegrees: -180, pitchDegrees: -1, yawDegrees: 0}),
    ).toEqual(Uint8Array.from([0x4c, 0xff, 0xff, 0xff, 0, 0]));
  });

  it('carries all three axes in every frame - there is no partial write', () => {
    // MSP 39 has no per-axis form, so a save can never leave two axes
    // updated and one stale.
    const bytes = encodeBoardAlignment({
      rollDegrees: 1,
      pitchDegrees: 0,
      yawDegrees: 0,
    });
    expect(bytes).toHaveLength(6);
    expect(decodeBoardAlignment(bytes)).toEqual({
      rollDegrees: 1,
      pitchDegrees: 0,
      yawDegrees: 0,
    });
  });

  it('refuses an out-of-range angle rather than truncating it', () => {
    expect(() =>
      encodeBoardAlignment({rollDegrees: 361, pitchDegrees: 0, yawDegrees: 0}),
    ).toThrow(RangeError);
    expect(() =>
      encodeBoardAlignment({rollDegrees: 0, pitchDegrees: -181, yawDegrees: 0}),
    ).toThrow(RangeError);
    expect(() =>
      encodeBoardAlignment({rollDegrees: 0, pitchDegrees: 0, yawDegrees: 40000}),
    ).toThrow(RangeError);
  });

  it('refuses a fractional angle rather than rounding it silently', () => {
    expect(() =>
      encodeBoardAlignment({rollDegrees: 12.5, pitchDegrees: 0, yawDegrees: 0}),
    ).toThrow(RangeError);
    expect(() =>
      encodeBoardAlignment({rollDegrees: 0, pitchDegrees: 0, yawDegrees: NaN}),
    ).toThrow(RangeError);
  });

  it('emits nothing when the draft already matches the board', () => {
    expect(encodeChangedBoardAlignment(NEUTRAL, {...NEUTRAL})).toBeUndefined();
    expect(
      encodeChangedBoardAlignment(
        {rollDegrees: 5, pitchDegrees: -5, yawDegrees: 90},
        {rollDegrees: 5, pitchDegrees: -5, yawDegrees: 90},
      ),
    ).toBeUndefined();
  });

  it('emits the full frame when any single axis differs', () => {
    for (const draft of [
      {rollDegrees: 1, pitchDegrees: 0, yawDegrees: 0},
      {rollDegrees: 0, pitchDegrees: 1, yawDegrees: 0},
      {rollDegrees: 0, pitchDegrees: 0, yawDegrees: 1},
    ]) {
      const payload = encodeChangedBoardAlignment(NEUTRAL, draft);
      expect(payload).toBeDefined();
      expect(decodeBoardAlignment(payload as Uint8Array)).toEqual(draft);
    }
  });
});
