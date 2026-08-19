/**
 * BOARD ALIGNMENT - the three angles that tell the firmware how the
 * flight controller is physically mounted in the airframe.
 *
 * WHY THIS EXISTS. Until now this application could not set them at all.
 * A board mounted rotated - the arrow pointing 90 degrees off, or a stack
 * fitted upside down - flies wrong in a way the operator cannot diagnose
 * from the app: the horizon leans, self-levelling pulls to one side, and
 * every PID number they then reach for is the wrong lever. It is the
 * single largest software gap found in the pre-launch audit.
 *
 * BOARD ALIGNMENT IS NOT SENSOR ALIGNMENT. They are two different MSP
 * commands carrying two different kinds of value, and conflating them
 * would write nonsense to a board:
 *
 *   BOARD alignment    MSP 38 / 39     three signed ANGLES in degrees,
 *                                      a fine trim of the whole board
 *   SENSOR alignment   MSP 126 / 220   per-sensor enum (CW0/CW90/...)
 *                                      plus gyro-selection bytes
 *
 * Only BOARD alignment is implemented here. Sensor alignment has its own
 * payload that additionally branches on API 1.47, and it is deliberately
 * out of scope for this round.
 *
 * THE CONTRACT, taken from the official sources rather than inferred:
 *
 *   read     MSP_BOARD_ALIGNMENT_CONFIG      = 38
 *   write    MSP_SET_BOARD_ALIGNMENT_CONFIG  = 39
 *   payload  6 bytes, three little-endian 16-bit values, in the order
 *            roll, pitch, yaw
 *   units    WHOLE DEGREES - not decidegrees. `boardAlignment_t` holds
 *            `int32_t rollDegrees/pitchDegrees/yawDegrees`
 *            (sensors/boardalignment.h:29-33) and settings.c declares
 *            each as VAR_INT16.
 *   range    -180 .. 360 for all three axes, identical
 *            (cli/settings.c:995-997, `align_board_roll|pitch|yaw`)
 *   default  0 / 0 / 0 (sensors/boardalignment.c:53-57)
 *
 * SIGNEDNESS, AND WHY IT IS READ SIGNED. The firmware serialises with
 * `sbufWriteU16` and parses with `sbufReadU16` (msp.c:1440-1444 and
 * 4113-4117) - i.e. it moves the low 16 bits of an int32 without caring
 * about sign. betaflight-configurator reads the same bytes with the
 * SIGNED `read16()` (MSPHelper.js, case MSP_BOARD_ALIGNMENT_CONFIG), and
 * that is the correct reading: -180 travels as 0xFF4C and only a signed
 * interpretation turns it back into -180. The whole -180..360 range fits
 * a signed 16-bit value, so one signed read covers every legal setting.
 *
 * API COMPATIBILITY. Neither the firmware handler nor the configurator's
 * parser carries any version branch for command 38 or 39 - verified by
 * inspection of both. The payload is therefore identical on API 1.47,
 * 1.48 and 1.49, and this module needs no version gate. (Contrast
 * MSP_SENSOR_ALIGNMENT, which does branch at 1.47 - another reason the
 * two must not be treated as one feature.)
 */

/** Inclusive bounds, from cli/settings.c:995-997. Same for all axes. */
export const BOARD_ALIGNMENT_MIN_DEGREES = -180;
export const BOARD_ALIGNMENT_MAX_DEGREES = 360;

/** The firmware's own reset values (sensors/boardalignment.c:53-57). */
export const BOARD_ALIGNMENT_DEFAULT_DEGREES = 0;

export type BoardAlignmentAxis = 'roll' | 'pitch' | 'yaw';

export const BOARD_ALIGNMENT_AXES: readonly BoardAlignmentAxis[] =
  Object.freeze(['roll', 'pitch', 'yaw']);

/** What the board reported, in whole degrees. */
export interface MspBoardAlignmentSnapshot {
  readonly rollDegrees: number;
  readonly pitchDegrees: number;
  readonly yawDegrees: number;
}

/** What the operator is editing. Same shape - there is nothing derived
 *  here, and inventing a second representation would only create a place
 *  for the two to disagree. */
export type BoardAlignmentDraft = MspBoardAlignmentSnapshot;

export function createBoardAlignmentDraft(
  snapshot: MspBoardAlignmentSnapshot,
): BoardAlignmentDraft {
  return Object.freeze({
    rollDegrees: snapshot.rollDegrees,
    pitchDegrees: snapshot.pitchDegrees,
    yawDegrees: snapshot.yawDegrees,
  });
}

export function boardAlignmentDraftsEqual(
  a: BoardAlignmentDraft,
  b: BoardAlignmentDraft,
): boolean {
  return (
    a.rollDegrees === b.rollDegrees &&
    a.pitchDegrees === b.pitchDegrees &&
    a.yawDegrees === b.yawDegrees
  );
}

export function boardAlignmentSnapshotsEqual(
  a: MspBoardAlignmentSnapshot,
  b: MspBoardAlignmentSnapshot,
): boolean {
  return boardAlignmentDraftsEqual(a, b);
}

export interface BoardAlignmentValidationIssue {
  readonly axis: BoardAlignmentAxis;
  readonly reason: 'OUT_OF_RANGE' | 'NOT_AN_INTEGER';
}

function axisValue(draft: BoardAlignmentDraft, axis: BoardAlignmentAxis): number {
  return axis === 'roll'
    ? draft.rollDegrees
    : axis === 'pitch'
      ? draft.pitchDegrees
      : draft.yawDegrees;
}

/**
 * Every axis must be a whole number inside the firmware's own bounds.
 *
 * INTEGER IS A REAL CONSTRAINT, not tidiness: the value is written as a
 * 16-bit integer, so 12.5 would silently become 12 on the board while
 * the app went on showing 12.5 - the "shown but not saved" class of
 * defect this project treats as a bug rather than a rounding detail.
 */
export function validateBoardAlignmentDraft(
  draft: BoardAlignmentDraft,
): readonly BoardAlignmentValidationIssue[] {
  const issues: BoardAlignmentValidationIssue[] = [];
  for (const axis of BOARD_ALIGNMENT_AXES) {
    const value = axisValue(draft, axis);
    if (!Number.isInteger(value)) {
      issues.push(Object.freeze({axis, reason: 'NOT_AN_INTEGER' as const}));
      continue;
    }
    if (
      value < BOARD_ALIGNMENT_MIN_DEGREES ||
      value > BOARD_ALIGNMENT_MAX_DEGREES
    ) {
      issues.push(Object.freeze({axis, reason: 'OUT_OF_RANGE' as const}));
    }
  }
  return Object.freeze(issues);
}

/** True when the board is mounted exactly as the firmware assumes. */
export function isBoardAlignmentNeutral(
  snapshot: MspBoardAlignmentSnapshot,
): boolean {
  return (
    snapshot.rollDegrees === BOARD_ALIGNMENT_DEFAULT_DEGREES &&
    snapshot.pitchDegrees === BOARD_ALIGNMENT_DEFAULT_DEGREES &&
    snapshot.yawDegrees === BOARD_ALIGNMENT_DEFAULT_DEGREES
  );
}
