import {MspPayloadReader} from './MspPayloadReader';

/**
 * src/main/msp/msp.c, `case MSP_ATTITUDE:` @ BETAFLIGHT_PINNED_COMMIT
 * (see ../commands/mspCommandSources.ts) - verbatim:
 *   sbufWriteU16(dst, attitude.values.roll);
 *   sbufWriteU16(dst, attitude.values.pitch);
 *   sbufWriteU16(dst, DECIDEGREES_TO_DEGREES(attitude.values.yaw));
 * Unconditionally 6 bytes, never version-gated (no "Added in API version"
 * comment or conditional near this case, unlike MSP_BOARD_INFO's fields -
 * see decodeBoardInfo.ts's own doc comment for that pattern; this command
 * has no such history at all).
 *
 * VERIFIED FINDING, NOT ASSUMED FROM MEMORY - roll/pitch and yaw are NOT
 * the same unit. src/main/flight/imu.h declares attitude.values.roll/
 * pitch/yaw as signed int16_t in DECIDEGREES (0.1 degree units - "eg
 * attitude.values.yaw 180 deg = 1800"). roll and pitch are sent as-is
 * (decidegrees); yaw is divided by 10 via DECIDEGREES_TO_DEGREES() before
 * being sent, so yaw on the wire is in WHOLE DEGREES, a different unit
 * from roll/pitch, not merely a different sign convention.
 *
 * Despite the C source using sbufWriteU16 (the "unsigned" write
 * primitive) for all three fields, that is only the raw byte-writing
 * function's name - it writes the 2-byte bit pattern of a signed
 * int16_t unchanged. roll/pitch genuinely go negative (bank/pitch angle
 * can be either direction) and MUST be decoded as signed
 * (MspPayloadReader.readS16LE()). yaw is separately normalized to
 * [0, 3600) decidegrees before the /10 conversion (src/main/flight/
 * imu.c: `if (attitude.values.yaw < 0) { attitude.values.yaw += 3600; }`),
 * so it is always non-negative (0-359) on the wire in practice - decoded
 * as signed here anyway for consistency with the field's actual declared
 * type and defensiveness against any future firmware change, never
 * assumed unsigned from the wire function name alone.
 */
export interface MspAttitude {
  /** Decidegrees (0.1 degree units), signed - e.g. 1800 means 180.0 degrees. */
  rollDecidegrees: number;
  /** Decidegrees (0.1 degree units), signed - e.g. 1800 means 180.0 degrees. */
  pitchDecidegrees: number;
  /** WHOLE degrees, NOT decidegrees - see this file's own doc comment. */
  yawDegrees: number;
}

export function decodeAttitude(payload: Uint8Array): MspAttitude {
  const reader = new MspPayloadReader(payload);
  return {
    rollDecidegrees: reader.readS16LE(),
    pitchDecidegrees: reader.readS16LE(),
    yawDegrees: reader.readS16LE(),
  };
}
