/**
 * THE GPS RESCUE CONTRACT, BYTE BY BYTE.
 *
 * These are not "does the function run" tests. Every offset below is the
 * one betaflight-configurator's MSPHelper.js reads and the one the
 * firmware's msp.c writes, and a single field out of order would send an
 * aircraft home at a descent rate it thinks is a satellite count. That is
 * why the fixtures are built from a field MAP rather than a literal
 * array: a swapped pair in a hand-written array would be invisible.
 *
 * The interesting cases are the LENGTHS. GPS Rescue grew across four API
 * generations and the payload is still forward-extensible, so this file
 * pins all four sizes plus a board newer than this build.
 */

import {
  decodeGpsRescue,
  GPS_RESCUE_BASE_BYTES,
  GPS_RESCUE_FULL_BYTES,
  GPS_RESCUE_WITH_MIN_START_BYTES,
  GPS_RESCUE_WITH_RATES_BYTES,
} from './decodeGpsRescue';
import {gpsRescuePayload} from '../../__testUtils__/gpsRescueFixtures';

describe('decodeGpsRescue, at the current 26-byte contract', () => {
  it('reads every field at the offset Betaflight writes it', () => {
    const decoded = decodeGpsRescue(gpsRescuePayload());
    expect(decoded).toEqual({
      returnAltitudeM: 120,
      descentDistanceM: 210,
      groundSpeedCmS: 850,
      sanityChecks: 2,
      minSats: 9,
      ascendRate: 640,
      descendRate: 155,
      allowArmingWithoutFix: 1,
      altitudeMode: 1,
      minStartDistM: 17,
      initialClimbM: 33,
      preserved: {angle: 45, throttleMin: 1150, throttleMax: 1850, throttleHover: 1275},
      presentFieldCount: GPS_RESCUE_FULL_BYTES,
    });
  });

  it('keeps the four autopilot fields separate from the rescue settings', () => {
    // They are in the payload but they are not GPS Rescue - they come
    // from PG_AUTOPILOT, shared with Altitude Hold. Anything that treats
    // them as editable rescue parameters is reading this wrong.
    const decoded = decodeGpsRescue(gpsRescuePayload());
    expect(Object.keys(decoded)).not.toContain('angle');
    expect(Object.keys(decoded)).not.toContain('throttleHover');
    expect(decoded.preserved.throttleHover).toBe(1275);
  });

  it('reads little-endian, which is the only endianness MSP uses', () => {
    const decoded = decodeGpsRescue(gpsRescuePayload({returnAltitudeM: 0x0102}));
    expect(decoded.returnAltitudeM).toBe(0x0102);
    expect(gpsRescuePayload({returnAltitudeM: 0x0102})[2]).toBe(0x02);
    expect(gpsRescuePayload({returnAltitudeM: 0x0102})[3]).toBe(0x01);
  });
});

describe('decodeGpsRescue, across the lengths the payload has had', () => {
  it('reads a 16-byte board and reports the appended fields as absent', () => {
    const decoded = decodeGpsRescue(gpsRescuePayload({}, GPS_RESCUE_BASE_BYTES));
    expect(decoded.presentFieldCount).toBe(GPS_RESCUE_BASE_BYTES);
    expect(decoded.minSats).toBe(9);
    // Not invented: zero, and presentFieldCount says why.
    expect(decoded.ascendRate).toBe(0);
    expect(decoded.altitudeMode).toBe(0);
    expect(decoded.initialClimbM).toBe(0);
  });

  it('reads a 22-byte board: rates and altitude mode, no minimum start distance', () => {
    const decoded = decodeGpsRescue(gpsRescuePayload({}, GPS_RESCUE_WITH_RATES_BYTES));
    expect(decoded.presentFieldCount).toBe(GPS_RESCUE_WITH_RATES_BYTES);
    expect(decoded.ascendRate).toBe(640);
    expect(decoded.altitudeMode).toBe(1);
    expect(decoded.minStartDistM).toBe(0);
  });

  it('reads a 24-byte board: minimum start distance, no initial climb', () => {
    const decoded = decodeGpsRescue(gpsRescuePayload({}, GPS_RESCUE_WITH_MIN_START_BYTES));
    expect(decoded.presentFieldCount).toBe(GPS_RESCUE_WITH_MIN_START_BYTES);
    expect(decoded.minStartDistM).toBe(17);
    expect(decoded.initialClimbM).toBe(0);
  });

  it('reads a board NEWER than this build and ignores what it does not know', () => {
    // The forward case, and the one that decides whether this app dies on
    // the next Betaflight release. Extra trailing bytes are not an error.
    const future = new Uint8Array(GPS_RESCUE_FULL_BYTES + 8);
    future.set(gpsRescuePayload());
    future.fill(0xab, GPS_RESCUE_FULL_BYTES);

    const decoded = decodeGpsRescue(future);

    expect(decoded.initialClimbM).toBe(33);
    // Capped at what this build understands, so a save cannot echo bytes
    // whose meaning it never learned.
    expect(decoded.presentFieldCount).toBe(GPS_RESCUE_FULL_BYTES);
  });

  it('refuses a payload too short to be GPS Rescue at all', () => {
    expect(() => decodeGpsRescue(new Uint8Array(10))).toThrow();
  });
});
