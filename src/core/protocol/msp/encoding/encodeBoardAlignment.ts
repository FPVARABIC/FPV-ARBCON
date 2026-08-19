/**
 * MSP_SET_BOARD_ALIGNMENT_CONFIG (39) - writing the mounting angles.
 *
 * The payload mirrors the read exactly: six bytes, three little-endian
 * 16-bit values, roll then pitch then yaw. betaflight-configurator builds
 * the identical frame with
 * `.push16(roll).push16(pitch).push16(yaw)` (MSPHelper.js, case
 * MSPCodes.MSP_SET_BOARD_ALIGNMENT_CONFIG), and the firmware reads it
 * back with three `sbufReadU16` (msp.c:4113-4117).
 *
 * WHY setInt16 RATHER THAN setUint16. Negative angles are legal
 * (-180..360, cli/settings.c:995-997). `setInt16` writes the correct
 * two's-complement bytes for them and is identical to `setUint16` for
 * every non-negative value, so one call is right across the whole range;
 * `setUint16(-180)` would throw or wrap depending on the runtime.
 *
 * ALL THREE AXES ALWAYS. There is no per-axis MSP command - 39 carries
 * the complete triple - so a partial write is not expressible. Sending
 * the whole frame is therefore not laziness: it is the only shape the
 * protocol has, and it means a save can never leave two axes updated and
 * one stale.
 *
 * VALIDATION BEFORE BYTES. An out-of-range or fractional value is
 * refused here rather than truncated into the frame, because a silently
 * truncated angle is exactly the "the app showed one thing and the board
 * stored another" defect this layer exists to prevent.
 */

import {
  boardAlignmentDraftsEqual,
  createBoardAlignmentDraft,
  validateBoardAlignmentDraft,
  type BoardAlignmentDraft,
  type MspBoardAlignmentSnapshot,
} from '../../../state/boardAlignmentModel';

export const BOARD_ALIGNMENT_WRITE_BYTES = 6;

/** The frame for a draft, unconditionally. Throws if the draft is not
 *  something the firmware would accept. */
export function encodeBoardAlignment(draft: BoardAlignmentDraft): Uint8Array {
  if (validateBoardAlignmentDraft(draft).length > 0) {
    throw new RangeError('Invalid board alignment draft.');
  }
  const payload = new Uint8Array(BOARD_ALIGNMENT_WRITE_BYTES);
  const view = new DataView(payload.buffer);
  view.setInt16(0, draft.rollDegrees, true);
  view.setInt16(2, draft.pitchDegrees, true);
  view.setInt16(4, draft.yawDegrees, true);
  return payload;
}

/**
 * The frame only when something actually changed - `undefined` when the
 * draft already matches the board, so a "save" with no edits never puts
 * a write on the wire and never spends an EEPROM erase cycle.
 */
export function encodeChangedBoardAlignment(
  snapshot: MspBoardAlignmentSnapshot,
  draft: BoardAlignmentDraft,
): Uint8Array | undefined {
  if (boardAlignmentDraftsEqual(createBoardAlignmentDraft(snapshot), draft)) {
    return undefined;
  }
  return encodeBoardAlignment(draft);
}
