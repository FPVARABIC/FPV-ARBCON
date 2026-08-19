/**
 * THE RANGES AND DEFAULTS ARE THE FIRMWARE'S, NOT OURS.
 *
 * Every constant asserted here has a named source in
 * boardAlignmentModel.ts. The point of pinning them in a test is that a
 * future "tidy-up" that narrows -180..360 to, say, -180..180 would then
 * fail loudly instead of quietly refusing settings the board accepts.
 */

import {
  BOARD_ALIGNMENT_AXES,
  BOARD_ALIGNMENT_DEFAULT_DEGREES,
  BOARD_ALIGNMENT_MAX_DEGREES,
  BOARD_ALIGNMENT_MIN_DEGREES,
  boardAlignmentDraftsEqual,
  boardAlignmentSnapshotsEqual,
  createBoardAlignmentDraft,
  isBoardAlignmentNeutral,
  validateBoardAlignmentDraft,
} from './boardAlignmentModel';

const NEUTRAL = {rollDegrees: 0, pitchDegrees: 0, yawDegrees: 0};

describe('board alignment model', () => {
  it('uses the firmware’s own bounds and defaults', () => {
    // cli/settings.c:995-997 and sensors/boardalignment.c:53-57.
    expect(BOARD_ALIGNMENT_MIN_DEGREES).toBe(-180);
    expect(BOARD_ALIGNMENT_MAX_DEGREES).toBe(360);
    expect(BOARD_ALIGNMENT_DEFAULT_DEGREES).toBe(0);
    expect([...BOARD_ALIGNMENT_AXES]).toEqual(['roll', 'pitch', 'yaw']);
  });

  it('accepts every angle the firmware accepts, at both ends', () => {
    expect(
      validateBoardAlignmentDraft({
        rollDegrees: -180,
        pitchDegrees: 360,
        yawDegrees: 0,
      }),
    ).toEqual([]);
    expect(validateBoardAlignmentDraft(NEUTRAL)).toEqual([]);
  });

  it('names the axis and the reason for each rejection', () => {
    expect(
      validateBoardAlignmentDraft({
        rollDegrees: -181,
        pitchDegrees: 361,
        yawDegrees: 0,
      }),
    ).toEqual([
      {axis: 'roll', reason: 'OUT_OF_RANGE'},
      {axis: 'pitch', reason: 'OUT_OF_RANGE'},
    ]);
    expect(
      validateBoardAlignmentDraft({
        rollDegrees: 0.5,
        pitchDegrees: 0,
        yawDegrees: 0,
      }),
    ).toEqual([{axis: 'roll', reason: 'NOT_AN_INTEGER'}]);
  });

  it('treats a non-finite angle as not an integer rather than in range', () => {
    // NaN compares false against both bounds, so a range-only check
    // would have let it through and encoded 0 to the board.
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(
        validateBoardAlignmentDraft({...NEUTRAL, yawDegrees: bad}),
      ).toEqual([{axis: 'yaw', reason: 'NOT_AN_INTEGER'}]);
    }
  });

  it('compares drafts and snapshots by every axis', () => {
    expect(boardAlignmentDraftsEqual(NEUTRAL, {...NEUTRAL})).toBe(true);
    expect(
      boardAlignmentDraftsEqual(NEUTRAL, {...NEUTRAL, pitchDegrees: 1}),
    ).toBe(false);
    expect(
      boardAlignmentSnapshotsEqual(NEUTRAL, {...NEUTRAL, yawDegrees: -1}),
    ).toBe(false);
  });

  it('copies a snapshot into an independent frozen draft', () => {
    const snapshot = {rollDegrees: 4, pitchDegrees: 5, yawDegrees: 6};
    const draft = createBoardAlignmentDraft(snapshot);
    expect(draft).toEqual(snapshot);
    expect(Object.isFrozen(draft)).toBe(true);
  });

  it('knows neutral from configured', () => {
    expect(isBoardAlignmentNeutral(NEUTRAL)).toBe(true);
    expect(isBoardAlignmentNeutral({...NEUTRAL, yawDegrees: 90})).toBe(false);
    expect(isBoardAlignmentNeutral({...NEUTRAL, rollDegrees: -180})).toBe(false);
  });
});
