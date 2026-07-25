import {MspPayloadReader} from './MspPayloadReader';

/**
 * Pass 7.6c - wire decoder for MSP_RAW_GPS (106), verified verbatim at
 * BOTH the pinned master (msp.c:1569-1579, API 1.48) and release 4.5.5
 * (msp.c:1508-1518, API 1.46) - identical layout for every mandatory
 * field, so the bench API 1.47 necessarily matches (mspCommandSources.ts):
 *
 *   offset 0   u8   STATE(GPS_FIX) - the RAW stateFlags bit. VERIFIED:
 *                   GPS_FIX = (1<<1) (fc/runtime_config.h:124), so this
 *                   byte is 0 or 2 - NEVER assume the value 1. A generic
 *                   fix flag only: no 2D/3D distinction exists here.
 *   offset 1   u8   numSat
 *   offset 2   u32  latitude   - PRIVACY: decoded past for cursor
 *   offset 6   u32  longitude  - integrity, NEVER retained
 *   offset 10  u16  altitude m
 *   offset 12  u16  ground speed
 *   offset 14  u16  ground course        (16 bytes mandatory)
 *   offset 16  u16  pdop - "Added in API version 1.44"; trailing/ignored
 *                   (the app's minimum accepted API is 1.42, so this
 *                   field may legitimately be absent).
 *
 * The compact model DELIBERATELY contains only {hasFix, satelliteCount}:
 * coordinates must never appear in state, UI, logs, snapshots, or test
 * artifacts (Pass 7.6c privacy rule) - enforced by the model shape
 * itself, not by discipline at call sites.
 */
export interface MspRawGpsCompact {
  /** True when the raw fix flag byte is nonzero (the wire value is the
   * raw GPS_FIX bit, i.e. 2 when set). */
  hasFix: boolean;
  satelliteCount: number;
}

export function decodeRawGps(payload: Uint8Array): MspRawGpsCompact {
  const reader = new MspPayloadReader(payload);
  const fixFlagRaw = reader.readU8();
  const satelliteCount = reader.readU8();
  // Structural integrity for the remaining MANDATORY fields (lat, lon,
  // alt, speed, course = 14 more bytes) without retaining any of them -
  // a shorter payload is corruption, not a legitimate variant, at every
  // accepted API version.
  reader.readBytes(14);
  return {
    hasFix: fixFlagRaw !== 0,
    satelliteCount,
  };
}
