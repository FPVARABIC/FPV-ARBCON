import { MspPayloadReader } from './MspPayloadReader';

/**
 * Pass 7.6c - wire decoder for MSP_RAW_GPS (106), verified DIRECTLY at
 * the immutable API-1.47 authority (release 2025.12.5, commit
 * BETAFLIGHT_API147_COMMIT, msp.c:1511-1521 - the API version the bench
 * reports; matching reads at API 1.46/1.48 are secondary regression
 * comparisons only, never proof of 1.47 - see mspCommandSources.ts):
 *
 *   offset 0   u8   STATE(GPS_FIX) - the RAW stateFlags bit. VERIFIED:
 *                   GPS_FIX = (1<<1) (fc/runtime_config.h:121 @
 *                   2025.12.5), so this byte is 0 or 2 - NEVER assume
 *                   the value 1. A generic fix flag only: no 2D/3D
 *                   distinction exists here.
 *   offset 1   u8   numSat
 *   offset 2   u32  latitude   - PRIVACY: decoded past for cursor
 *   offset 6   u32  longitude  - integrity, NEVER retained
 *   offset 10  u16  altitude, metres
 *   offset 12  u16  ground speed, cm/s
 *   offset 14  u16  ground course, decidegrees (16 bytes mandatory)
 *   offset 16  u16  pdop - always emitted at API 1.47 (the "Added in
 *                   API version 1.44" comment is historical, not a
 *                   runtime conditional); treated as trailing/ignored
 *                   (the app's minimum accepted API is 1.42, so this
 *                   field may legitimately be absent on older builds).
 *
 * Coordinates remain structurally excluded for privacy. The three
 * non-location flight facts that follow them are retained for the Setup
 * summary; none identifies a place on its own.
 */
export interface MspRawGpsCompact {
  /** True when the raw fix flag byte is nonzero (the wire value is the
   * raw GPS_FIX bit, i.e. 2 when set). */
  hasFix: boolean;
  satelliteCount: number;
  altitudeMeters?: number;
  groundSpeedCentimetersPerSecond?: number;
  groundCourseDecidegrees?: number;
}

export function decodeRawGps(payload: Uint8Array): MspRawGpsCompact {
  const reader = new MspPayloadReader(payload);
  const fixFlagRaw = reader.readU8();
  const satelliteCount = reader.readU8();
  // Coordinates are intentionally skipped and never enter the model.
  reader.readBytes(8);
  const altitudeMeters = reader.readU16LE();
  const groundSpeedCentimetersPerSecond = reader.readU16LE();
  const groundCourseDecidegrees = reader.readU16LE();
  return {
    hasFix: fixFlagRaw !== 0,
    satelliteCount,
    altitudeMeters,
    groundSpeedCentimetersPerSecond,
    groundCourseDecidegrees,
  };
}
