/**
 * MSP_GPS_RESCUE (135) - the parameters that decide whether an aircraft
 * that lost its link comes home or comes down.
 *
 * WHY THIS EXISTS. The app could already SELECT GPS Rescue as the
 * failsafe stage-2 procedure and could not configure a single one of its
 * parameters, so a long-range pilot enabled it and then flew on whatever
 * defaults happened to be on the board - including a return altitude
 * that may sit below the trees they are flying over.
 *
 * THE CONTRACT, taken from betaflight-configurator's own MSPHelper.js
 * (case MSPCodes.MSP_GPS_RESCUE) rather than inferred. 26 bytes, in this
 * exact order:
 *
 *     u16 angle                  u16 returnAltitudeM
 *     u16 descentDistanceM       u16 groundSpeedCmS
 *     u16 throttleMin            u16 throttleMax
 *     u16 throttleHover          u8  sanityChecks
 *     u8  minSats
 *     --- appended at API 1.43 ---
 *     u16 ascendRate             u16 descendRate
 *     u8  allowArmingWithoutFix  u8  altitudeMode
 *     --- appended at API 1.44 ---
 *     u16 minStartDistM
 *     --- appended at API 1.46 ---
 *     u16 initialClimbM
 *
 * LENGTH-DRIVEN, NOT VERSION-DRIVEN. Every field appended by a later API
 * is read only if the bytes are actually there. That is the same rule the
 * rest of this decoder layer follows, and it is what lets a board newer
 * than this build be read rather than rejected: trailing bytes we do not
 * know are ignored, exactly as Betaflight ignores fields it does not know.
 *
 * FIELDS THIS APP DOES NOT OFFER FOR EDITING, and why they are still
 * decoded. `angle`, `throttleMin`, `throttleMax` and `throttleHover` are
 * carried inside this payload but they are NOT GPS Rescue settings. The
 * firmware serves them from `autopilotConfig()` - PG_AUTOPILOT in
 * settings.c - which is the shared autopilot block that also drives
 * Altitude Hold and Position Hold; only the other nine fields come from
 * `gpsRescueConfig()`. Presenting them on a card headed "GPS Rescue"
 * would let an operator change how Altitude Hold behaves while believing
 * they had adjusted a rescue, so they are read here for one purpose: a
 * save writes them back BYTE FOR BYTE unchanged.
 *
 * (`angle` is also the one field whose MSP width is wider than its
 * storage - autopilotConfig_t.maxAngle is a uint8 clamped 10..70 degrees
 * while MSP carries it as u16. Echoing the read value round-trips it
 * exactly; inventing one would not.)
 */

import {MspPayloadReader} from './MspPayloadReader';

export interface MspGpsRescueConfiguration {
  /** Metres. The altitude the aircraft climbs to before returning. */
  readonly returnAltitudeM: number;
  /** Metres from home at which the descent begins. */
  readonly descentDistanceM: number;
  /** cm/s. The speed held on the way home. */
  readonly groundSpeedCmS: number;
  /** 0 OFF, 1 ON, 2 FAILSAFE-ONLY (settings.c lookup table). */
  readonly sanityChecks: number;
  /** Satellites required before a rescue will start. */
  readonly minSats: number;
  /** cm/s climb rate. */
  readonly ascendRate: number;
  /** cm/s descent rate. */
  readonly descendRate: number;
  /** 0 OFF, 1 ON - whether arming is permitted with no GPS fix. */
  readonly allowArmingWithoutFix: number;
  /** 0 MAX_ALT, 1 FIXED_ALT, 2 CURRENT_ALT. */
  readonly altitudeMode: number;
  /** Metres from home below which a rescue will not start. */
  readonly minStartDistM: number;
  /** Metres of initial climb before turning for home. */
  readonly initialClimbM: number;
  /**
   * Carried by MSP, not offered for editing, written back unchanged.
   * See the file header - these are not fields this app claims to
   * understand on current firmware.
   */
  readonly preserved: MspGpsRescuePreservedFields;
  /**
   * How many of the appended blocks this board actually sent. A save
   * must not lengthen the frame beyond what the board itself uses.
   */
  readonly presentFieldCount: number;
}

export interface MspGpsRescuePreservedFields {
  readonly angle: number;
  readonly throttleMin: number;
  readonly throttleMax: number;
  readonly throttleHover: number;
}

/** Byte lengths of the payload as each API generation extended it. */
export const GPS_RESCUE_BASE_BYTES = 16;
export const GPS_RESCUE_WITH_RATES_BYTES = 22;
export const GPS_RESCUE_WITH_MIN_START_BYTES = 24;
export const GPS_RESCUE_FULL_BYTES = 26;

export function decodeGpsRescue(payload: Uint8Array): MspGpsRescueConfiguration {
  const reader = new MspPayloadReader(payload);
  const angle = reader.readU16LE();
  const returnAltitudeM = reader.readU16LE();
  const descentDistanceM = reader.readU16LE();
  const groundSpeedCmS = reader.readU16LE();
  const throttleMin = reader.readU16LE();
  const throttleMax = reader.readU16LE();
  const throttleHover = reader.readU16LE();
  const sanityChecks = reader.readU8();
  const minSats = reader.readU8();

  // Everything below is an APPENDED block. A board that predates it sends
  // a shorter frame, and the absent values are reported as zero rather
  // than invented - a screen decides what to show from presentFieldCount.
  let ascendRate = 0;
  let descendRate = 0;
  let allowArmingWithoutFix = 0;
  let altitudeMode = 0;
  let minStartDistM = 0;
  let initialClimbM = 0;
  let presentFieldCount = GPS_RESCUE_BASE_BYTES;

  if (payload.length >= GPS_RESCUE_WITH_RATES_BYTES) {
    ascendRate = reader.readU16LE();
    descendRate = reader.readU16LE();
    allowArmingWithoutFix = reader.readU8();
    altitudeMode = reader.readU8();
    presentFieldCount = GPS_RESCUE_WITH_RATES_BYTES;
  }
  if (payload.length >= GPS_RESCUE_WITH_MIN_START_BYTES) {
    minStartDistM = reader.readU16LE();
    presentFieldCount = GPS_RESCUE_WITH_MIN_START_BYTES;
  }
  if (payload.length >= GPS_RESCUE_FULL_BYTES) {
    initialClimbM = reader.readU16LE();
    presentFieldCount = GPS_RESCUE_FULL_BYTES;
  }

  return Object.freeze({
    returnAltitudeM,
    descentDistanceM,
    groundSpeedCmS,
    sanityChecks,
    minSats,
    ascendRate,
    descendRate,
    allowArmingWithoutFix,
    altitudeMode,
    minStartDistM,
    initialClimbM,
    preserved: Object.freeze({angle, throttleMin, throttleMax, throttleHover}),
    presentFieldCount,
  });
}
