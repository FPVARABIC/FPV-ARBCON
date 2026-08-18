/**
 * THE EDITABLE PART OF GPS RESCUE, and the limits it is held to.
 *
 * WHERE THE LIMITS COME FROM. Every range below is copied from the
 * firmware's own settings table (src/main/cli/settings.c, the PG_GPS_RESCUE
 * block) - not from the configurator's HTML, which carries looser display
 * bounds, and not from a guess. This matters more here than on most
 * screens: MSP_SET_GPS_RESCUE does NOT clamp. The firmware handler assigns
 * whatever arrives straight into gpsRescueConfig, so a value the CLI would
 * have refused is accepted silently over MSP. This module is the only
 * thing standing between a typo and a rescue that flies into a hill.
 *
 * WHAT IS NOT HERE. `angle`, `throttleMin`, `throttleMax` and
 * `throttleHover` travel in the same payload but belong to PG_AUTOPILOT,
 * shared with Altitude Hold and Position Hold - see decodeGpsRescue.ts.
 * They are preserved, not edited, so they are not part of the draft and
 * cannot be changed by anything on this screen.
 *
 * VALIDATION IS SCOPED TO WHAT THE OPERATOR CHANGED, and that is a
 * deliberate decision rather than a looser one. Ranges move between
 * firmware releases - master declares gps_rescue_min_start_dist as 5..30
 * where older builds allowed far more - so a perfectly normal board can
 * be holding a value the CURRENT table would refuse. Validating the whole
 * draft would then refuse every save on the Failsafe screen, including
 * the failsafe delay, because of a rescue field nobody touched. A field
 * the operator did not edit is written back with the identical value the
 * board already holds, which cannot make the aircraft less safe than it
 * is right now; a field they DID edit must land inside the range this
 * firmware itself declares. The stepper bounds enforce the same limits at
 * the point of use, so an edit snaps into range on the first press.
 */

import type {MspGpsRescueConfiguration} from '../protocol/msp/decoding/decodeGpsRescue';

/** 0 OFF, 1 ON, 2 FAILSAFE-ONLY (settings.c lookupTableRescueSanityType). */
export type GpsRescueSanityCheck = 0 | 1 | 2;
/** 0 MAX_ALT, 1 FIXED_ALT, 2 CURRENT_ALT (lookupTableRescueAltitudeMode). */
export type GpsRescueAltitudeMode = 0 | 1 | 2;

export interface GpsRescueDraft {
  /** Metres. */
  readonly returnAltitudeM: number;
  /** Metres. */
  readonly descentDistanceM: number;
  /** cm/s on the wire; the screen shows m/s. */
  readonly groundSpeedCmS: number;
  readonly sanityChecks: GpsRescueSanityCheck;
  readonly minSats: number;
  /** cm/s on the wire; the screen shows m/s. */
  readonly ascendRate: number;
  /** cm/s on the wire; the screen shows m/s. */
  readonly descendRate: number;
  /** 0 or 1. */
  readonly allowArmingWithoutFix: number;
  readonly altitudeMode: GpsRescueAltitudeMode;
  /** Metres. */
  readonly minStartDistM: number;
  /** Metres. */
  readonly initialClimbM: number;
}

export interface GpsRescueRange {
  readonly min: number;
  readonly max: number;
}

/**
 * settings.c, PG_GPS_RESCUE. Exported because the steppers must not be
 * able to reach a value validation would then refuse - one source, two
 * uses.
 */
export const GPS_RESCUE_RANGES = Object.freeze({
  returnAltitudeM: Object.freeze({min: 5, max: 1000}),
  descentDistanceM: Object.freeze({min: 5, max: 500}),
  groundSpeedCmS: Object.freeze({min: 0, max: 3000}),
  minSats: Object.freeze({min: 5, max: 50}),
  ascendRate: Object.freeze({min: 50, max: 2500}),
  descendRate: Object.freeze({min: 25, max: 500}),
  minStartDistM: Object.freeze({min: 5, max: 30}),
  initialClimbM: Object.freeze({min: 0, max: 100}),
}) satisfies Readonly<Record<string, GpsRescueRange>>;

export type GpsRescueValidationCode =
  | 'RETURN_ALTITUDE_INVALID'
  | 'DESCENT_DISTANCE_INVALID'
  | 'GROUND_SPEED_INVALID'
  | 'SANITY_CHECKS_INVALID'
  | 'MIN_SATS_INVALID'
  | 'ASCEND_RATE_INVALID'
  | 'DESCEND_RATE_INVALID'
  | 'ALLOW_ARMING_INVALID'
  | 'ALTITUDE_MODE_INVALID'
  | 'MIN_START_DISTANCE_INVALID'
  | 'INITIAL_CLIMB_INVALID';

export function createGpsRescueDraft(snapshot: MspGpsRescueConfiguration): GpsRescueDraft {
  return Object.freeze({
    returnAltitudeM: snapshot.returnAltitudeM,
    descentDistanceM: snapshot.descentDistanceM,
    groundSpeedCmS: snapshot.groundSpeedCmS,
    sanityChecks: snapshot.sanityChecks as GpsRescueSanityCheck,
    minSats: snapshot.minSats,
    ascendRate: snapshot.ascendRate,
    descendRate: snapshot.descendRate,
    allowArmingWithoutFix: snapshot.allowArmingWithoutFix,
    altitudeMode: snapshot.altitudeMode as GpsRescueAltitudeMode,
    minStartDistM: snapshot.minStartDistM,
    initialClimbM: snapshot.initialClimbM,
  });
}

export function gpsRescueDraftsEqual(a: GpsRescueDraft, b: GpsRescueDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Compares two decoded payloads for the STALE_BASE check.
 *
 * `presentFieldCount` is part of the comparison on purpose: if a board
 * came back with a different payload length between the base read and the
 * pre-write re-read, it is not the same board state and a save must not
 * proceed on the older base.
 */
export function gpsRescueSnapshotsEqual(
  a: MspGpsRescueConfiguration | undefined,
  b: MspGpsRescueConfiguration | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

function outside(value: number, range: GpsRescueRange): boolean {
  return !Number.isInteger(value) || value < range.min || value > range.max;
}

export function validateGpsRescueDraft(
  draft: GpsRescueDraft,
  snapshot: MspGpsRescueConfiguration,
): readonly GpsRescueValidationCode[] {
  const stored = createGpsRescueDraft(snapshot);
  const issues: GpsRescueValidationCode[] = [];
  /** Only a value the operator actually moved is held to the range - see
   * the file header for why an untouched one is not. */
  const changed = <K extends keyof GpsRescueDraft>(key: K): boolean => draft[key] !== stored[key];

  if (changed('returnAltitudeM') && outside(draft.returnAltitudeM, GPS_RESCUE_RANGES.returnAltitudeM)) issues.push('RETURN_ALTITUDE_INVALID');
  if (changed('descentDistanceM') && outside(draft.descentDistanceM, GPS_RESCUE_RANGES.descentDistanceM)) issues.push('DESCENT_DISTANCE_INVALID');
  if (changed('groundSpeedCmS') && outside(draft.groundSpeedCmS, GPS_RESCUE_RANGES.groundSpeedCmS)) issues.push('GROUND_SPEED_INVALID');
  if (changed('minSats') && outside(draft.minSats, GPS_RESCUE_RANGES.minSats)) issues.push('MIN_SATS_INVALID');
  if (changed('ascendRate') && outside(draft.ascendRate, GPS_RESCUE_RANGES.ascendRate)) issues.push('ASCEND_RATE_INVALID');
  if (changed('descendRate') && outside(draft.descendRate, GPS_RESCUE_RANGES.descendRate)) issues.push('DESCEND_RATE_INVALID');
  if (changed('minStartDistM') && outside(draft.minStartDistM, GPS_RESCUE_RANGES.minStartDistM)) issues.push('MIN_START_DISTANCE_INVALID');
  if (changed('initialClimbM') && outside(draft.initialClimbM, GPS_RESCUE_RANGES.initialClimbM)) issues.push('INITIAL_CLIMB_INVALID');

  // ENUMS ARE CHECKED UNCONDITIONALLY, because these are not ranges that
  // drift - they are the firmware's own lookup tables, and a byte outside
  // them is a value the aircraft cannot act on. If a board reported one,
  // echoing it back is not "leaving it alone", it is re-committing an
  // undefined setting. Every one of these must be a number the wire
  // format can carry, too: a fractional or negative byte is a bug.
  if (!Number.isInteger(draft.sanityChecks) || draft.sanityChecks < 0 || draft.sanityChecks > 2) issues.push('SANITY_CHECKS_INVALID');
  if (draft.allowArmingWithoutFix !== 0 && draft.allowArmingWithoutFix !== 1) issues.push('ALLOW_ARMING_INVALID');
  if (!Number.isInteger(draft.altitudeMode) || draft.altitudeMode < 0 || draft.altitudeMode > 2) issues.push('ALTITUDE_MODE_INVALID');

  // A value that cannot be encoded at all is refused whether it moved or
  // not: a non-integer or out-of-u16 number would be silently mangled by
  // DataView.setUint16, which is exactly the class of write this app must
  // never make.
  for (const [key, code, width] of ENCODABLE_FIELDS) {
    const value = draft[key];
    if (!Number.isInteger(value) || value < 0 || value > width) issues.push(code);
  }
  return Object.freeze([...new Set(issues)]);
}

const U8_MAX = 0xff;
const U16_MAX = 0xffff;

/** Every numeric field, its issue code, and the wire width it must fit -
 * matching encodeGpsRescue.ts byte for byte. */
const ENCODABLE_FIELDS: readonly (readonly [keyof GpsRescueDraft, GpsRescueValidationCode, number])[] = Object.freeze([
  ['returnAltitudeM', 'RETURN_ALTITUDE_INVALID', U16_MAX],
  ['descentDistanceM', 'DESCENT_DISTANCE_INVALID', U16_MAX],
  ['groundSpeedCmS', 'GROUND_SPEED_INVALID', U16_MAX],
  ['minSats', 'MIN_SATS_INVALID', U8_MAX],
  ['ascendRate', 'ASCEND_RATE_INVALID', U16_MAX],
  ['descendRate', 'DESCEND_RATE_INVALID', U16_MAX],
  ['minStartDistM', 'MIN_START_DISTANCE_INVALID', U16_MAX],
  ['initialClimbM', 'INITIAL_CLIMB_INVALID', U16_MAX],
] as const);

/**
 * Which of the draft's fields this board can actually store.
 *
 * A board that sent only the 16-byte base payload has no ascend rate and
 * no altitude mode; showing an editor for one would be showing a control
 * that cannot reach the aircraft. The encoder already refuses to lengthen
 * the frame - this is the same fact, made available to the screen so it
 * can hide rather than lie.
 */
export function gpsRescueSupportsRates(snapshot: MspGpsRescueConfiguration): boolean {
  return snapshot.presentFieldCount >= 22;
}
export function gpsRescueSupportsMinStartDistance(snapshot: MspGpsRescueConfiguration): boolean {
  return snapshot.presentFieldCount >= 24;
}
export function gpsRescueSupportsInitialClimb(snapshot: MspGpsRescueConfiguration): boolean {
  return snapshot.presentFieldCount >= 26;
}
