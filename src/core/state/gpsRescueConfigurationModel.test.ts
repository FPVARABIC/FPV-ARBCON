/**
 * THE RULE ABOUT WHICH VALUES ARE REFUSED, and it is not "all of them".
 *
 * MSP_SET_GPS_RESCUE does not clamp - the firmware assigns whatever
 * arrives - so this validation is the only thing between a typo and a
 * rescue that flies into a hill. But validating the WHOLE draft would be
 * a different failure: firmware ranges move between releases, so an
 * ordinary board can hold a value the current table would refuse, and the
 * Failsafe screen would then refuse every save - including the failsafe
 * delay - over a rescue field nobody touched.
 *
 * So: a field the operator moved is held to the firmware's range; a field
 * they did not is written back with the value the board already has.
 */

import {decodeGpsRescue} from '../protocol/msp/decoding/decodeGpsRescue';
import {gpsRescuePayload} from '../protocol/__testUtils__/gpsRescueFixtures';
import {
  createGpsRescueDraft,
  gpsRescueDraftsEqual,
  gpsRescueSnapshotsEqual,
  gpsRescueSupportsInitialClimb,
  gpsRescueSupportsMinStartDistance,
  gpsRescueSupportsRates,
  validateGpsRescueDraft,
  GPS_RESCUE_RANGES,
} from './gpsRescueConfigurationModel';

const board = () => decodeGpsRescue(gpsRescuePayload());

describe('validateGpsRescueDraft', () => {
  it('accepts the board exactly as it reported itself', () => {
    const snapshot = board();
    expect(validateGpsRescueDraft(createGpsRescueDraft(snapshot), snapshot)).toEqual([]);
  });

  it('refuses an edit that leaves the range the firmware declares', () => {
    const snapshot = board();
    // settings.c: gps_rescue_return_alt is 5..1000.
    expect(validateGpsRescueDraft({...createGpsRescueDraft(snapshot), returnAltitudeM: 1001}, snapshot)).toContain('RETURN_ALTITUDE_INVALID');
    expect(validateGpsRescueDraft({...createGpsRescueDraft(snapshot), returnAltitudeM: 4}, snapshot)).toContain('RETURN_ALTITUDE_INVALID');
  });

  it('does NOT block a save over a stored value nobody touched', () => {
    // The whole reason validation is change-scoped. A board carrying a
    // minimum start distance from a firmware whose range was wider must
    // not make the failsafe delay unsaveable.
    const snapshot = decodeGpsRescue(gpsRescuePayload({minStartDistM: 100}));
    expect(snapshot.minStartDistM).toBeGreaterThan(GPS_RESCUE_RANGES.minStartDistM.max);

    const draft = {...createGpsRescueDraft(snapshot), minSats: 12};

    expect(validateGpsRescueDraft(draft, snapshot)).toEqual([]);
  });

  it('starts holding that same field to the range as soon as it is edited', () => {
    const snapshot = decodeGpsRescue(gpsRescuePayload({minStartDistM: 100}));
    const draft = {...createGpsRescueDraft(snapshot), minStartDistM: 99};
    expect(validateGpsRescueDraft(draft, snapshot)).toContain('MIN_START_DISTANCE_INVALID');
  });

  it('refuses an unknown enum even when the board is the one that sent it', () => {
    // A range can drift; a lookup table cannot. Echoing back a sanity
    // check value the firmware has no entry for is re-committing an
    // undefined setting, not leaving it alone.
    const snapshot = decodeGpsRescue(gpsRescuePayload({sanityChecks: 7, altitudeMode: 9}));
    const issues = validateGpsRescueDraft(createGpsRescueDraft(snapshot), snapshot);
    expect(issues).toContain('SANITY_CHECKS_INVALID');
    expect(issues).toContain('ALTITUDE_MODE_INVALID');
  });

  it('refuses a value that would be mangled by the wire format', () => {
    const snapshot = board();
    expect(validateGpsRescueDraft({...createGpsRescueDraft(snapshot), groundSpeedCmS: 70000}, snapshot)).toContain('GROUND_SPEED_INVALID');
    expect(validateGpsRescueDraft({...createGpsRescueDraft(snapshot), minSats: 12.5}, snapshot)).toContain('MIN_SATS_INVALID');
    expect(validateGpsRescueDraft({...createGpsRescueDraft(snapshot), descendRate: -1}, snapshot)).toContain('DESCEND_RATE_INVALID');
  });
});

describe('drafts and snapshots', () => {
  it('carries only the editable fields into the draft', () => {
    const draft = createGpsRescueDraft(board());
    expect(Object.keys(draft).sort()).toEqual([
      'allowArmingWithoutFix',
      'altitudeMode',
      'ascendRate',
      'descendRate',
      'descentDistanceM',
      'groundSpeedCmS',
      'initialClimbM',
      'minSats',
      'minStartDistM',
      'returnAltitudeM',
      'sanityChecks',
    ]);
  });

  it('treats a change of payload length as a different board state', () => {
    // Part of STALE_BASE: a re-read that came back shorter is not the
    // state the draft was built from, whatever the shared values say.
    const full = decodeGpsRescue(gpsRescuePayload());
    const short = decodeGpsRescue(gpsRescuePayload({}, 22));
    expect(gpsRescueSnapshotsEqual(full, short)).toBe(false);
    expect(gpsRescueSnapshotsEqual(full, decodeGpsRescue(gpsRescuePayload()))).toBe(true);
    expect(gpsRescueSnapshotsEqual(undefined, undefined)).toBe(true);
    expect(gpsRescueSnapshotsEqual(full, undefined)).toBe(false);
  });

  it('compares drafts by value', () => {
    const snapshot = board();
    expect(gpsRescueDraftsEqual(createGpsRescueDraft(snapshot), createGpsRescueDraft(snapshot))).toBe(true);
    expect(gpsRescueDraftsEqual(createGpsRescueDraft(snapshot), {...createGpsRescueDraft(snapshot), minSats: 10})).toBe(false);
  });
});

describe('what a given board can actually store', () => {
  it('reports the appended blocks by payload length, not by API version', () => {
    expect(gpsRescueSupportsRates(decodeGpsRescue(gpsRescuePayload({}, 16)))).toBe(false);
    expect(gpsRescueSupportsRates(decodeGpsRescue(gpsRescuePayload({}, 22)))).toBe(true);
    expect(gpsRescueSupportsMinStartDistance(decodeGpsRescue(gpsRescuePayload({}, 22)))).toBe(false);
    expect(gpsRescueSupportsMinStartDistance(decodeGpsRescue(gpsRescuePayload({}, 24)))).toBe(true);
    expect(gpsRescueSupportsInitialClimb(decodeGpsRescue(gpsRescuePayload({}, 24)))).toBe(false);
    expect(gpsRescueSupportsInitialClimb(decodeGpsRescue(gpsRescuePayload({}, 26)))).toBe(true);
  });
});
