/**
 * MSP_BOARD_ALIGNMENT_CONFIG (38) - how the board is mounted.
 *
 * SIX BYTES, three signed little-endian 16-bit values, in this order:
 *
 *     s16 rollDegrees    s16 pitchDegrees    s16 yawDegrees
 *
 * Source, not memory: the firmware writes them with three
 * `sbufWriteU16(dst, boardAlignment()->{roll,pitch,yaw}Degrees)`
 * (msp.c:1440-1444) and betaflight-configurator reads them with three
 * SIGNED `data.read16()` (MSPHelper.js, case
 * MSPCodes.MSP_BOARD_ALIGNMENT_CONFIG).
 *
 * WHY SIGNED WHEN THE FIRMWARE WROTE "U16". The stored field is an
 * `int32_t` in whole degrees whose legal range is -180..360
 * (cli/settings.c:995-997); `sbufWriteU16` simply moves its low 16 bits.
 * Read unsigned, -180 would come back as 65356. Read signed, the whole
 * legal range - negatives and the 181..360 tail alike - decodes exactly.
 *
 * NO VERSION BRANCH, deliberately. Neither the firmware handler nor the
 * configurator's parser gates this command on API version, so the layout
 * is the same on 1.47, 1.48 and 1.49. A decoder that invented a version
 * check here would be inventing a difference that does not exist.
 *
 * STRICT LENGTH. Unlike the appended-field commands elsewhere in this
 * layer, this payload has never grown, so a short frame is a real fault
 * rather than an older board, and it is refused instead of being
 * padded with zeros that would read as "mounted flat".
 */

import {MspPayloadReader} from './MspPayloadReader';
import type {MspBoardAlignmentSnapshot} from '../../../state/boardAlignmentModel';

export const BOARD_ALIGNMENT_PAYLOAD_BYTES = 6;

export function decodeBoardAlignment(
  payload: Uint8Array,
): MspBoardAlignmentSnapshot {
  if (payload.length < BOARD_ALIGNMENT_PAYLOAD_BYTES) {
    throw new RangeError(
      `MSP_BOARD_ALIGNMENT_CONFIG needs ${BOARD_ALIGNMENT_PAYLOAD_BYTES} bytes, got ${payload.length}.`,
    );
  }
  const reader = new MspPayloadReader(payload, {lenient: true});
  return Object.freeze({
    rollDegrees: reader.readS16LE(),
    pitchDegrees: reader.readS16LE(),
    yawDegrees: reader.readS16LE(),
  });
}
