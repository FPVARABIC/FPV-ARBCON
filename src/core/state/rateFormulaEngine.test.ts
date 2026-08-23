import {
  RATE_SETTING_LIMITS,
  RATES_TYPE_COUNT_SENTINEL,
  classifyRatesType,
  evaluateRate,
  maximumSetpointDegPerSec,
  normaliseStick,
  ratePreviewAvailability,
  type RateAxisSettings,
} from './rateFormulaEngine';

const UNLIMITED: number = 1998;

/**
 * Every expected value in this file was worked out by hand from the pinned
 * firmware's formulas before the engine existed. None of it came from running
 * the engine and recording what it said.
 */

describe('P-B - the rates enum', () => {
  it('names the five real types', () => {
    expect(classifyRatesType(0)).toEqual({kind: 'BETAFLIGHT'});
    expect(classifyRatesType(1)).toEqual({kind: 'RACEFLIGHT'});
    expect(classifyRatesType(2)).toEqual({kind: 'KISS'});
    expect(classifyRatesType(3)).toEqual({kind: 'ACTUAL'});
    expect(classifyRatesType(4)).toEqual({kind: 'QUICK'});
  });

  it('treats the enum COUNT and anything beyond it as unknown', () => {
    expect(RATES_TYPE_COUNT_SENTINEL).toBe(5);
    expect(classifyRatesType(5)).toEqual({kind: 'UNKNOWN', raw: 5});
    expect(classifyRatesType(200)).toEqual({kind: 'UNKNOWN', raw: 200});
  });

  it('carries the firmware per-type input ceilings', () => {
    expect(RATE_SETTING_LIMITS[0]).toEqual({rcRate: 255, superRate: 100, expo: 100});
    expect(RATE_SETTING_LIMITS[1]).toEqual({rcRate: 200, superRate: 255, expo: 100});
    expect(RATE_SETTING_LIMITS[2]).toEqual({rcRate: 255, superRate: 99, expo: 100});
    expect(RATE_SETTING_LIMITS[3]).toEqual({rcRate: 200, superRate: 200, expo: 100});
    expect(RATE_SETTING_LIMITS[4]).toEqual({rcRate: 255, superRate: 200, expo: 100});
  });
});

describe('P-B - stick normalisation', () => {
  it('divides by 500 minus the deadband, as the firmware does', () => {
    expect(normaliseStick(500, 0)).toBeCloseTo(1, 10);
    expect(normaliseStick(250, 0)).toBeCloseTo(0.5, 10);
    // With a deadband of 20 the usable travel is 480, so 480 is full stick.
    expect(normaliseStick(480, 20)).toBeCloseTo(1, 10);
    expect(normaliseStick(240, 20)).toBeCloseTo(0.5, 10);
  });

  it('is symmetric about centre', () => {
    expect(normaliseStick(-250, 0)).toBeCloseTo(-0.5, 10);
    expect(normaliseStick(0, 0)).toBe(0);
  });
});

describe('P-B - BETAFLIGHT rates', () => {
  // rcRate 118, super 73, expo 41.
  const settings: RateAxisSettings = {rcRate: 118, superRate: 73, expo: 41, rateLimit: UNLIMITED};
  const at = (stick: number): number =>
    evaluateRate({kind: 'BETAFLIGHT'}, settings, stick)!.setpointDegPerSec;

  it('is zero at centre', () => {
    expect(at(0)).toBeCloseTo(0, 6);
  });

  it('matches the hand-derived curve', () => {
    expect(at(0.25)).toBeCloseTo(43.04339, 4);
    expect(at(0.5)).toBeCloseTo(119.1614, 3);
    expect(at(0.75)).toBeCloseTo(298.4430, 3);
    expect(at(1)).toBeCloseTo(874.0741, 3);
  });

  it('is odd-symmetric', () => {
    expect(at(-0.75)).toBeCloseTo(-at(0.75), 6);
  });

  it('applies the incremental boost only above an RC rate of 2.00', () => {
    // rcRate 210 -> 2.10, so 2.10 + 14.54 x 0.10 = 3.554 replaces it.
    const boosted: RateAxisSettings = {rcRate: 210, superRate: 0, expo: 0, rateLimit: UNLIMITED};
    // No expo and no super rate, so the answer is just 200 x 3.554 x 1.
    expect(evaluateRate({kind: 'BETAFLIGHT'}, boosted, 1)!.setpointDegPerSec)
      .toBeCloseTo(710.8, 3);
  });
});

describe('P-B - ACTUAL rates', () => {
  // rcRate 63 -> 630 deg/s at centre; super 147 -> 1470 deg/s maximum.
  const settings: RateAxisSettings = {rcRate: 63, superRate: 147, expo: 41, rateLimit: UNLIMITED};
  const at = (stick: number): number =>
    evaluateRate({kind: 'ACTUAL'}, settings, stick)!.setpointDegPerSec;

  it('matches the hand-derived curve', () => {
    expect(at(0.25)).toBeCloseTo(188.5591, 3);
    expect(at(0.5)).toBeCloseTo(444.2813, 3);
    expect(at(0.75)).toBeCloseTo(812.5708, 3);
  });

  it('reaches exactly the configured maximum at full stick', () => {
    // That is the promise of ACTUAL rates: super rate x 10 IS the max deg/s.
    expect(at(1)).toBeCloseTo(1470, 6);
  });
});

describe('P-B - RACEFLIGHT rates use the raw stick, not the curved value', () => {
  // rcRate 63, super 47, expo 30.
  const settings: RateAxisSettings = {rcRate: 63, superRate: 47, expo: 30, rateLimit: UNLIMITED};
  const at = (stick: number): number =>
    evaluateRate({kind: 'RACEFLIGHT'}, settings, stick)!.setpointDegPerSec;

  it('matches the hand-derived firmware curve', () => {
    expect(at(0.25)).toBeCloseTo(126.5045, 3);
    expect(at(0.5)).toBeCloseTo(301.4944, 3);
    expect(at(0.75)).toBeCloseTo(555.1801, 3);
    expect(at(1)).toBeCloseTo(926.1, 3);
  });

  it('does not reproduce the official preview, which scales by the curve', () => {
    // At half stick the curved value is 0.3875 and the raw magnitude is 0.5.
    // Scaling by the curve would give 288.53; the firmware gives 301.49. A
    // vector where the two agreed would prove nothing, so this one is chosen
    // where they differ by thirteen degrees per second.
    expect(at(0.5)).toBeCloseTo(301.4944, 3);
    expect(at(0.5)).not.toBeCloseTo(288.5314, 2);
  });
});

describe('P-B - KISS rates constrain the denominator before dividing', () => {
  const settings: RateAxisSettings = {rcRate: 137, superRate: 91, expo: 40, rateLimit: UNLIMITED};
  const at = (stick: number, s: RateAxisSettings = settings): number =>
    evaluateRate({kind: 'KISS'}, s, stick)!.setpointDegPerSec;

  it('matches the hand-derived curve in the ordinary range', () => {
    expect(at(0.5)).toBeCloseTo(175.9633, 3);
  });

  it('survives a stored super rate the firmware never clamps on write', () => {
    // MSP_SET_RC_TUNING stores whatever arrives, and the CLI can set a super
    // rate of 150. At 0.8 stick the denominator goes NEGATIVE: 1 - 0.8 x 1.5
    // = -0.2. The firmware constrains it to 0.01 first, so the result is a
    // large POSITIVE rate that the setpoint limit then caps at 1998.
    // Without the constrain the reciprocal is -5 and the sign flips - the
    // aircraft would be commanded the opposite way.
    const wild: RateAxisSettings = {rcRate: 137, superRate: 150, expo: 40, rateLimit: UNLIMITED};
    const value = at(0.8, wild);
    expect(value).toBeCloseTo(1998, 6);
    expect(value).toBeGreaterThan(0);
    expect(value).not.toBeCloseTo(-938.176, 2);
  });
});

describe('P-B - QUICK rates have two branches and we implement both', () => {
  // rcRate 105 -> 210; super 87 -> 870 deg/s maximum; expo 40.
  const settings: RateAxisSettings = {rcRate: 105, superRate: 87, expo: 40, rateLimit: UNLIMITED};

  // Derived as exact fractions so the expectations do not depend on how many
  // decimal places I carried by hand. At 0.6 stick:
  //   rcRate           = 105 x 2 = 210
  //   maxDPS           = max(87 x 10, 210) = 870
  //   superFactorConfig= (870/210 - 1) / (870/210) = 660/870 = 22/29
  //   curve            = 0.6^3 x 0.4 + 0.6 x 0.6 = 0.4464
  // expo-on-command:   0.4464 x 210 x 29/15.8   = 2718.576/15.8  = 172.06177...
  // expo-on-magnitude: 0.6 x 210 x 18125/11987  = 2283750/11987  = 190.51889...
  it('matches the hand-derived value with expo on the command', () => {
    const value = evaluateRate({kind: 'QUICK'}, settings, 0.6, {quickRatesRcExpo: true});
    expect(value!.setpointDegPerSec).toBeCloseTo(2718.576 / 15.8, 6);
    expect(value!.setpointDegPerSec).toBeCloseTo(172.06177, 4);
  });

  it('matches the hand-derived value with expo on the magnitude', () => {
    const value = evaluateRate({kind: 'QUICK'}, settings, 0.6, {quickRatesRcExpo: false});
    expect(value!.setpointDegPerSec).toBeCloseTo(2283750 / 11987, 6);
    expect(value!.setpointDegPerSec).toBeCloseTo(190.51889, 4);
  });

  it('gives genuinely different answers, so a swapped branch cannot hide', () => {
    const on = evaluateRate({kind: 'QUICK'}, settings, 0.6, {quickRatesRcExpo: true})!;
    const off = evaluateRate({kind: 'QUICK'}, settings, 0.6, {quickRatesRcExpo: false})!;
    expect(Math.abs(on.setpointDegPerSec - off.setpointDegPerSec)).toBeGreaterThan(18);
  });
});

describe('P-B - what a board-derived preview may and may not claim', () => {
  const settings: RateAxisSettings = {rcRate: 105, superRate: 87, expo: 40, rateLimit: UNLIMITED};

  it('refuses to evaluate QUICK without the branch selector', () => {
    // quickRatesRcExpo lives in the rate profile and appears on NO MSP
    // command at 1.47, 1.48 or 1.49. Guessing it would draw one of two
    // curves and call it the aircraft's.
    expect(evaluateRate({kind: 'QUICK'}, settings, 0.6)).toBeUndefined();
  });

  it('names the missing field rather than reporting "unsupported"', () => {
    expect(ratePreviewAvailability({kind: 'QUICK'})).toEqual({
      kind: 'PREVIEW_UNAVAILABLE',
      reason: 'QUICK_RATES_RC_EXPO_NOT_OBSERVABLE',
    });
  });

  it('becomes exact the moment the value is supplied from elsewhere', () => {
    expect(ratePreviewAvailability({kind: 'QUICK'}, false)).toEqual({kind: 'EXACT_PREVIEW'});
    expect(ratePreviewAvailability({kind: 'QUICK'}, true)).toEqual({kind: 'EXACT_PREVIEW'});
  });

  it('is exact for the four types that need nothing beyond MSP', () => {
    for (const kind of ['BETAFLIGHT', 'RACEFLIGHT', 'KISS', 'ACTUAL'] as const) {
      expect(ratePreviewAvailability({kind})).toEqual({kind: 'EXACT_PREVIEW'});
    }
  });

  it('declines an unknown rates type instead of falling back to Betaflight', () => {
    expect(ratePreviewAvailability({kind: 'UNKNOWN', raw: 9}))
      .toEqual({kind: 'PREVIEW_UNAVAILABLE', reason: 'RATES_TYPE_UNKNOWN', raw: 9});
    expect(evaluateRate({kind: 'UNKNOWN', raw: 9}, settings, 0.5)).toBeUndefined();
  });

  it('has no maximum for an axis it cannot evaluate', () => {
    expect(maximumSetpointDegPerSec({kind: 'QUICK'}, settings)).toBeUndefined();
    expect(maximumSetpointDegPerSec({kind: 'ACTUAL'}, {
      rcRate: 63, superRate: 147, expo: 41, rateLimit: UNLIMITED,
    })).toBeCloseTo(1470, 6);
  });
});

describe('P-B - the rate limit applies to every type, not just Betaflight', () => {
  const limited = 400;

  it('clamps BETAFLIGHT', () => {
    const value = evaluateRate(
      {kind: 'BETAFLIGHT'},
      {rcRate: 118, superRate: 73, expo: 41, rateLimit: limited},
      1,
    )!;
    expect(value.angleRate).toBeCloseTo(874.0741, 3);
    expect(value.setpointDegPerSec).toBe(limited);
    expect(value.clampedByRateLimit).toBe(true);
  });

  it('clamps RACEFLIGHT, which the official preview does not', () => {
    const value = evaluateRate(
      {kind: 'RACEFLIGHT'},
      {rcRate: 63, superRate: 47, expo: 30, rateLimit: limited},
      1,
    )!;
    expect(value.angleRate).toBeCloseTo(926.1, 3);
    expect(value.setpointDegPerSec).toBe(limited);
  });

  it('clamps KISS', () => {
    const value = evaluateRate(
      {kind: 'KISS'},
      {rcRate: 137, superRate: 91, expo: 40, rateLimit: limited},
      1,
    )!;
    expect(value.setpointDegPerSec).toBe(limited);
  });

  it('clamps ACTUAL', () => {
    const value = evaluateRate(
      {kind: 'ACTUAL'},
      {rcRate: 63, superRate: 147, expo: 41, rateLimit: limited},
      1,
    )!;
    expect(value.angleRate).toBeCloseTo(1470, 6);
    expect(value.setpointDegPerSec).toBe(limited);
  });

  it('clamps QUICK on both branches', () => {
    const settings: RateAxisSettings = {rcRate: 105, superRate: 87, expo: 40, rateLimit: limited};
    for (const branch of [true, false]) {
      const value = evaluateRate({kind: 'QUICK'}, settings, 1, {quickRatesRcExpo: branch})!;
      expect(value.setpointDegPerSec).toBe(limited);
    }
  });

  it('reports the unclamped value alongside, so nothing is hidden', () => {
    const value = evaluateRate(
      {kind: 'BETAFLIGHT'},
      {rcRate: 118, superRate: 73, expo: 41, rateLimit: limited},
      1,
    )!;
    expect(value.angleRate).toBeGreaterThan(value.setpointDegPerSec);
  });

  it('does not flag a clamp that did not happen', () => {
    const value = evaluateRate(
      {kind: 'BETAFLIGHT'},
      {rcRate: 118, superRate: 73, expo: 41, rateLimit: UNLIMITED},
      0.5,
    )!;
    expect(value.clampedByRateLimit).toBe(false);
  });
});
