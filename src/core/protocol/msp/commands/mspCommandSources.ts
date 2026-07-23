/**
 * Centralized citation for the exact upstream firmware source this pass's
 * (Pass 6.4a Step 0) MSP command values and MSP_BOARD_INFO wire-format
 * understanding were verified against - each a PINNED commit, never
 * `master`/any moving branch or tag, so this record stays accurate even as
 * each upstream project continues to change after this pass.
 *
 * BETAFLIGHT (primary verification - command numbers, MSP_API_VERSION/
 * MSP_FC_VARIANT/MSP_BOARD_INFO wire layout):
 *   Repository: https://github.com/betaflight/betaflight
 *   Pinned commit: 0ccf59553351860fcedbaed952dbf3694f10f768
 *     (was HEAD of `master` at verification time, 2026-07-22)
 *   Files read at that commit:
 *     - src/main/msp/msp_protocol.h
 *         MSP_API_VERSION=1, MSP_FC_VARIANT=2, MSP_BOARD_INFO=4;
 *         MSP_PROTOCOL_VERSION=0, API_VERSION_MAJOR=1, API_VERSION_MINOR=48;
 *         FLIGHT_CONTROLLER_IDENTIFIER_LENGTH=4, BOARD_IDENTIFIER_LENGTH=4.
 *     - src/main/msp/msp.c
 *         The real `case MSP_API_VERSION/MSP_FC_VARIANT/MSP_BOARD_INFO:`
 *         response-encoding blocks inside mspFcProcessOutCommand() - the
 *         actual, current field-by-field wire layout the decoders in
 *         ../decoding mirror. Confirms flightControllerIdentifier =
 *         FC_FIRMWARE_IDENTIFIER.
 *     - src/main/build/version.h
 *         FC_FIRMWARE_IDENTIFIER = "BTFL" (the real 4-byte value sent by
 *         MSP_FC_VARIANT, not assumed).
 *     - src/main/pg/board.h
 *         SIGNATURE_LENGTH=32 (NOT co-located with the other MSP length
 *         constants in msp_protocol.h - required checking three files to
 *         locate).
 *
 * INAV (secondary verification - MSP_FC_VARIANT family identifier only):
 *   Repository: https://github.com/iNavFlight/inav
 *   Pinned commit: c5c593d71d33c8e284bf9cd34381588fda7a98c8
 *     (was HEAD of `master` at verification time, 2026-07-22)
 *   File read at that commit:
 *     - src/main/msp/msp_protocol.h -> INAV_IDENTIFIER = "INAV"
 *
 * EMUFLIGHT (secondary verification - MSP_FC_VARIANT family identifier
 * only):
 *   Repository: https://github.com/emuflight/EmuFlight
 *   Pinned commit: 0a569000b9dfa5b6d8f807bd2e56b634027d84cd
 *     (was HEAD of `master` at verification time, 2026-07-22)
 *   Files read at that commit:
 *     - src/main/interface/msp_protocol.h -> BUTTERFLIGHT_IDENTIFIER = "EMUF"
 *         (EmuFlight's MSP files live under src/main/interface/, a
 *         genuinely different layout from Betaflight's src/main/msp/ -
 *         found only by browsing the repository tree, not guessed.)
 *     - src/main/interface/msp.c
 *         Confirms flightControllerIdentifier = BUTTERFLIGHT_IDENTIFIER,
 *         i.e. this constant is actually sent on the wire, not dead code.
 *
 * IMPORTANT, VERIFIED FINDING (Step 0): the "Added in API version X.Y"
 * comments throughout msp.c's MSP_BOARD_INFO case are historical/
 * documentation notes about when Betaflight's OWN codebase added each
 * field over successive releases - they are NOT runtime
 * `if (apiVersion >= ...)` conditionals. Current firmware writes every
 * field unconditionally; a field is only actually absent on the wire when
 * talking to an older COMPILED firmware build that predates that field's
 * addition. A decoder can only detect that by how many bytes actually
 * arrived, never by cross-referencing a separately-fetched API version
 * number - see decodeBoardInfo.ts's own doc comment for how this is
 * handled.
 *
 * MSP_ATTITUDE (Pass 7.0 - hardware polling-capacity audit measurement
 * harness): verified against the SAME BETAFLIGHT_PINNED_COMMIT above (no
 * separate/newer pin needed - the command definition and encoding were
 * both read at that exact commit, same as everything else in this file).
 *   Files read at that commit:
 *     - src/main/msp/msp_protocol.h
 *         `#define MSP_ATTITUDE 108  // out message: 2 angles 1 heading`
 *     - src/main/msp/msp.c, the real `case MSP_ATTITUDE:` block inside
 *       mspProcessOutCommand() - verbatim:
 *         sbufWriteU16(dst, attitude.values.roll);
 *         sbufWriteU16(dst, attitude.values.pitch);
 *         sbufWriteU16(dst, DECIDEGREES_TO_DEGREES(attitude.values.yaw));
 *       Unconditionally 6 bytes total - no "Added in API version" comment
 *       or `if (apiVersion >= ...)` conditional anywhere near this case,
 *       unlike MSP_BOARD_INFO's fields; this command has no version-gating
 *       history to account for at all.
 *     - src/main/flight/imu.h
 *         attitudeEulerAngles_t's `values` struct declares roll/pitch/yaw
 *         as signed `int16_t`, in DECIDEGREES (comment: "eg
 *         attitude.values.yaw 180 deg = 1800").
 *     - src/main/common/maths.h
 *         `#define DECIDEGREES_TO_DEGREES(angle) ((angle) / 10)` - plain
 *         integer division by 10.
 *     - src/main/flight/imu.c
 *         `if (attitude.values.yaw < 0) { attitude.values.yaw += 3600; }`
 *         - yaw is normalized to [0, 3600) decidegrees before the case
 *         block's /10 conversion, so it is always non-negative (0-359) on
 *         the wire in practice, despite being declared int16_t.
 *   VERIFIED FINDING, NOT ASSUMED FROM MEMORY: roll and pitch are NOT the
 *   same unit as yaw on the wire. roll/pitch are sent as their raw signed
 *   int16_t decidegree value (0.1 degree units) - sbufWriteU16 is only the
 *   byte-writing primitive's name, not a claim the value is unsigned; a
 *   decoder must treat them as signed since bank/pitch angle can be either
 *   direction. yaw, in contrast, is converted to WHOLE DEGREES
 *   (DECIDEGREES_TO_DEGREES) before being written, and is functionally
 *   always non-negative given the imu.c normalization above - a
 *   fundamentally different unit from roll/pitch, not merely a different
 *   sign convention. See decodeAttitude.ts's own doc comment.
 */

export const BETAFLIGHT_SOURCE_REPO = 'https://github.com/betaflight/betaflight';
export const BETAFLIGHT_PINNED_COMMIT = '0ccf59553351860fcedbaed952dbf3694f10f768';

export const INAV_SOURCE_REPO = 'https://github.com/iNavFlight/inav';
export const INAV_PINNED_COMMIT = 'c5c593d71d33c8e284bf9cd34381588fda7a98c8';

export const EMUFLIGHT_SOURCE_REPO = 'https://github.com/emuflight/EmuFlight';
export const EMUFLIGHT_PINNED_COMMIT = '0a569000b9dfa5b6d8f807bd2e56b634027d84cd';
