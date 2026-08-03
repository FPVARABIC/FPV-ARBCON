import {RSSI_MAX_VALUE, deriveGpsCard, deriveReceiverRssi, isGpsPresent} from './auxTelemetrySemantics';
import type {MspAnalog, MspRawGpsCompact, MspStatusExCompact} from '../protocol';
import {STATUS_SENSOR_GPS_BIT} from '../protocol';

function analog(rssi: number): MspAnalog {
  return {legacyVoltageDecivolts: 168, consumedMah: 350, rssi, amperageCentiamps: 1234, voltageCentivolts: 1685};
}

function statusEx(sensorPresenceMask: number): MspStatusExCompact {
  return {cycleTimeUs: 900, i2cErrorCount: 0, sensorPresenceMask, cpuLoadPercent: 42};
}

describe('deriveReceiverRssi', () => {
  it('maps a wire zero to NOT_DISTINGUISHABLE - never a misleading 0% (unconfigured source is indistinguishable)', () => {
    expect(deriveReceiverRssi(analog(0))).toEqual({kind: 'NOT_DISTINGUISHABLE'});
  });

  it('maps nonzero readings to round((rssi / 1023) * 100) against RSSI_MAX_VALUE = 1023', () => {
    expect(RSSI_MAX_VALUE).toBe(1023);
    expect(deriveReceiverRssi(analog(1023))).toEqual({kind: 'PERCENT', percent: 100});
    expect(deriveReceiverRssi(analog(512))).toEqual({kind: 'PERCENT', percent: 50}); // 50.048 -> 50
    expect(deriveReceiverRssi(analog(540))).toEqual({kind: 'PERCENT', percent: 53}); // 52.786 -> 53
  });

  it('keeps the smallest live reading (1) as a genuine percentage (0% after rounding), proving liveness != zero display value', () => {
    expect(deriveReceiverRssi(analog(1))).toEqual({kind: 'PERCENT', percent: 0});
  });
});

describe('isGpsPresent', () => {
  it('reads exactly the GPS bit (8) of the sensor-presence mask', () => {
    expect(isGpsPresent(statusEx(STATUS_SENSOR_GPS_BIT))).toBe(true);
    expect(isGpsPresent(statusEx(1 + 8 + 32))).toBe(true); // ACC|GPS|GYRO
    expect(isGpsPresent(statusEx(0))).toBe(false);
    expect(isGpsPresent(statusEx(1 + 2 + 4 + 16 + 32))).toBe(false); // every bit EXCEPT GPS
  });
});

describe('deriveGpsCard', () => {
  const noFix: MspRawGpsCompact = {hasFix: false, satelliteCount: 3};
  const fix: MspRawGpsCompact = {hasFix: true, satelliteCount: 11};

  it('a fix always yields FIX with the satellite count (presence proof is implied by the fix itself)', () => {
    expect(deriveGpsCard(fix, true)).toEqual({kind: 'FIX', satelliteCount: 11});
    expect(deriveGpsCard(fix, undefined)).toEqual({kind: 'FIX', satelliteCount: 11});
  });

  it('converts non-location GPS units and refuses an impossible course instead of displaying a plausible-looking value', () => {
    expect(deriveGpsCard({
      hasFix: true,
      satelliteCount: 11,
      altitudeMeters: 300,
      groundSpeedCentimetersPerSecond: 125,
      groundCourseDecidegrees: 905,
    }, true)).toEqual({
      kind: 'FIX',
      satelliteCount: 11,
      altitudeMeters: 300,
      groundSpeedMetersPerSecond: 1.25,
      groundCourseDegrees: 90.5,
    });
    expect(deriveGpsCard({
      hasFix: true,
      satelliteCount: 11,
      groundCourseDecidegrees: 10_000,
    }, true)).toEqual({kind: 'FIX', satelliteCount: 11});
    expect(deriveGpsCard({
      hasFix: true,
      satelliteCount: 11,
      groundCourseDecidegrees: 3_600,
    }, true)).toMatchObject({groundCourseDegrees: 0});
  });

  it('no fix with proven presence yields NO_FIX with the satellite count (not an error state)', () => {
    expect(deriveGpsCard(noFix, true)).toEqual({kind: 'NO_FIX', satelliteCount: 3});
  });

  it('no fix without presence proof (false or unprovable) yields NO_PRESENCE_PROOF', () => {
    expect(deriveGpsCard(noFix, false)).toEqual({kind: 'NO_PRESENCE_PROOF'});
    expect(deriveGpsCard(noFix, undefined)).toEqual({kind: 'NO_PRESENCE_PROOF'});
  });

  it('zero satellites with proven presence is still NO_FIX - zero satellites never proves hardware absence', () => {
    expect(deriveGpsCard({hasFix: false, satelliteCount: 0}, true)).toEqual({kind: 'NO_FIX', satelliteCount: 0});
  });
});
