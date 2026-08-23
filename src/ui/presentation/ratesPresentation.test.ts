/**
 * The presentation layer is allowed to RENAME the engine's numbers. It is
 * not allowed to have opinions about them.
 *
 * These tests exist to keep that line. Where a bound, a maximum or a curve
 * point appears, it is compared against `rateFormulaEngine` directly rather
 * than against a literal copied into the expectation - a literal would pass
 * just as happily if the two had silently drifted apart, which is the exact
 * failure the inline RATE_TYPES table in PidTuningScreen used to be.
 */
import {
  RATES_TYPE_ACTUAL, RATES_TYPE_BETAFLIGHT, RATES_TYPE_KISS, RATES_TYPE_QUICK,
  RATES_TYPE_RACEFLIGHT, RATE_SETTING_LIMITS, classifyRatesType, evaluateRate,
  maximumSetpointDegPerSec, ratePreviewAvailability,
  type RateAxisSettings,
} from '../../core/state/rateFormulaEngine';
import {
  axisMaximum, buildRateCurve, formatRateField, previewCopy, rateAxisPresentation,
  rateFieldDecimals, ratesTypeName,
} from './ratesPresentation';

const AXIS: RateAxisSettings = Object.freeze({rcRate: 100, superRate: 70, expo: 0, rateLimit: 1998});
const KNOWN_RAWS = [RATES_TYPE_BETAFLIGHT, RATES_TYPE_RACEFLIGHT, RATES_TYPE_KISS, RATES_TYPE_ACTUAL, RATES_TYPE_QUICK];

describe('ratesTypeName', () => {
  it('names each of the five formulas the way pilots name them', () => {
    // The default formula is named neutrally: `brandSurface.test.ts`
    // forbids the firmware project's own name in text we author.
    expect(ratesTypeName(classifyRatesType(RATES_TYPE_BETAFLIGHT))).toBe('قياسي');
    expect(ratesTypeName(classifyRatesType(RATES_TYPE_RACEFLIGHT))).toBe('Raceflight');
    expect(ratesTypeName(classifyRatesType(RATES_TYPE_KISS))).toBe('KISS');
    expect(ratesTypeName(classifyRatesType(RATES_TYPE_ACTUAL))).toBe('Actual');
    expect(ratesTypeName(classifyRatesType(RATES_TYPE_QUICK))).toBe('Quick');
  });

  it('keeps an unrecognised raw value visible instead of picking a name', () => {
    const name = ratesTypeName(classifyRatesType(9));
    expect(name).toContain('9');
    expect(KNOWN_RAWS.map(raw => ratesTypeName(classifyRatesType(raw)))).not.toContain(name);
  });
});

describe('rateAxisPresentation', () => {
  it('takes every bound from the engine table, never from a local copy', () => {
    for (const raw of KNOWN_RAWS) {
      const presentation = rateAxisPresentation(classifyRatesType(raw));
      if (presentation === undefined) throw new Error(`no presentation for rates type ${raw}`);
      expect(presentation.rcRate.max).toBe(RATE_SETTING_LIMITS[raw].rcRate);
      expect(presentation.superRate.max).toBe(RATE_SETTING_LIMITS[raw].superRate);
      expect(presentation.expo.max).toBe(RATE_SETTING_LIMITS[raw].expo);
    }
  });

  it('refuses to describe fields of a formula it does not know', () => {
    expect(rateAxisPresentation(classifyRatesType(200))).toBeUndefined();
  });

  it('renames the fields where the firmware changes what they mean', () => {
    // Under ACTUAL and RACEFLIGHT the stored numbers map far more directly
    // onto angular velocity, so calling them "RC Rate" would describe the
    // wrong quantity.
    const betaflight = rateAxisPresentation(classifyRatesType(RATES_TYPE_BETAFLIGHT));
    const actual = rateAxisPresentation(classifyRatesType(RATES_TYPE_ACTUAL));
    const raceflight = rateAxisPresentation(classifyRatesType(RATES_TYPE_RACEFLIGHT));
    expect(betaflight?.rcRate.label).toBe('RC Rate');
    expect(betaflight?.rcRate.unit).toBeUndefined();
    expect(actual?.rcRate.label).not.toBe('RC Rate');
    expect(actual?.rcRate.unit).toBe('°/s');
    expect(raceflight?.rcRate.unit).toBe('°/s');
  });

  it('gives the super-rate field a maximum-like name only where it is one', () => {
    expect(rateAxisPresentation(classifyRatesType(RATES_TYPE_ACTUAL))?.superRate.unit).toBe('°/s');
    expect(rateAxisPresentation(classifyRatesType(RATES_TYPE_QUICK))?.superRate.unit).toBe('°/s');
    expect(rateAxisPresentation(classifyRatesType(RATES_TYPE_BETAFLIGHT))?.superRate.unit).toBeUndefined();
    expect(rateAxisPresentation(classifyRatesType(RATES_TYPE_KISS))?.superRate.unit).toBeUndefined();
  });

  it('uses the same rate-limit field for every formula, because the firmware does', () => {
    const limits = KNOWN_RAWS.map(raw => rateAxisPresentation(classifyRatesType(raw))?.rateLimit);
    for (const limit of limits) {
      expect(limit?.min).toBe(200);
      expect(limit?.max).toBe(1998);
      expect(limit?.unit).toBe('°/s');
    }
  });
});

/**
 * EVERY DISPLAY SCALE, PINNED TO THE FORMULA THAT READS THE BYTE.
 *
 * This block exists because a hand-checked table is not evidence. Two scales
 * here were wrong - QUICK's rcRate and superRate - and every DOM test passed
 * anyway: the screen rendered `0.70 °/s` for an axis the firmware flies at
 * 700, and nothing in the suite compared the two. It was found by reading a
 * screenshot.
 *
 * So each assertion below drives `evaluateRate` into a corner where the
 * answer IS the scaled field - expo zero, or a super rate that cannot bind -
 * and demands the displayed number match what the engine returns.
 */
function present(raw: number) {
  const presentation = rateAxisPresentation(classifyRatesType(raw));
  if (presentation === undefined) throw new Error(`no presentation for rates type ${raw}`);
  return presentation;
}
const shown = (field: {scale: number}, raw: number): number => raw * field.scale;

describe('display scales agree with the firmware formulas', () => {
  it('BETAFLIGHT: 200 x the shown RC Rate is the peak with no expo and no super rate', () => {
    const type = classifyRatesType(RATES_TYPE_BETAFLIGHT);
    const axis: RateAxisSettings = {rcRate: 120, superRate: 0, expo: 0, rateLimit: 1998};
    expect(200 * shown(present(RATES_TYPE_BETAFLIGHT).rcRate, axis.rcRate))
      .toBeCloseTo(maximumSetpointDegPerSec(type, axis) ?? -1, 6);
  });

  it('BETAFLIGHT: the shown super rate is the fraction the boost divides by', () => {
    const type = classifyRatesType(RATES_TYPE_BETAFLIGHT);
    const base: RateAxisSettings = {rcRate: 120, superRate: 0, expo: 0, rateLimit: 1998};
    const boosted: RateAxisSettings = {...base, superRate: 70};
    const ratio = (maximumSetpointDegPerSec(type, boosted) ?? 0) / (maximumSetpointDegPerSec(type, base) ?? 1);
    expect(ratio).toBeCloseTo(1 / (1 - shown(present(RATES_TYPE_BETAFLIGHT).superRate, 70)), 6);
  });

  it('KISS: 2000 x the shown RC Rate is the peak with no expo and no super rate', () => {
    const type = classifyRatesType(RATES_TYPE_KISS);
    const axis: RateAxisSettings = {rcRate: 120, superRate: 0, expo: 0, rateLimit: 1998};
    expect(2000 * shown(present(RATES_TYPE_KISS).rcRate, axis.rcRate))
      .toBeCloseTo(maximumSetpointDegPerSec(type, axis) ?? -1, 6);
  });

  it('RACEFLIGHT: the shown RC Rate IS the peak in degrees per second', () => {
    const type = classifyRatesType(RATES_TYPE_RACEFLIGHT);
    const axis: RateAxisSettings = {rcRate: 80, superRate: 0, expo: 0, rateLimit: 1998};
    expect(shown(present(RATES_TYPE_RACEFLIGHT).rcRate, axis.rcRate))
      .toBeCloseTo(maximumSetpointDegPerSec(type, axis) ?? -1, 6);
    expect(present(RATES_TYPE_RACEFLIGHT).rcRate.unit).toBe('°/s');
  });

  it('RACEFLIGHT: the shown super rate is the fraction the peak is multiplied by', () => {
    const type = classifyRatesType(RATES_TYPE_RACEFLIGHT);
    const base: RateAxisSettings = {rcRate: 80, superRate: 0, expo: 0, rateLimit: 1998};
    const boosted: RateAxisSettings = {...base, superRate: 60};
    const ratio = (maximumSetpointDegPerSec(type, boosted) ?? 0) / (maximumSetpointDegPerSec(type, base) ?? 1);
    expect(ratio).toBeCloseTo(1 + shown(present(RATES_TYPE_RACEFLIGHT).superRate, 60), 6);
    // A fraction is not an angular velocity and must not wear the unit.
    expect(present(RATES_TYPE_RACEFLIGHT).superRate.unit).toBeUndefined();
  });

  it('ACTUAL: the shown centre sensitivity IS the peak when the super rate cannot add', () => {
    const type = classifyRatesType(RATES_TYPE_ACTUAL);
    const axis: RateAxisSettings = {rcRate: 60, superRate: 60, expo: 0, rateLimit: 1998};
    expect(shown(present(RATES_TYPE_ACTUAL).rcRate, axis.rcRate))
      .toBeCloseTo(maximumSetpointDegPerSec(type, axis) ?? -1, 6);
  });

  it('ACTUAL: the shown maximum rate IS the peak at full expo', () => {
    const type = classifyRatesType(RATES_TYPE_ACTUAL);
    const axis: RateAxisSettings = {rcRate: 40, superRate: 90, expo: 100, rateLimit: 1998};
    expect(shown(present(RATES_TYPE_ACTUAL).superRate, axis.superRate))
      .toBeCloseTo(maximumSetpointDegPerSec(type, axis) ?? -1, 6);
    expect(present(RATES_TYPE_ACTUAL).superRate.unit).toBe('°/s');
  });

  it('QUICK: the shown RC Rate IS the peak when the maximum rate cannot bind', () => {
    // THE DEFECT THIS PINS. `applyQuickRates` reads rcRate x2, and the table
    // said x0.01 - a factor of two hundred, shown to a pilot as a rate.
    const type = classifyRatesType(RATES_TYPE_QUICK);
    const axis: RateAxisSettings = {rcRate: 150, superRate: 10, expo: 0, rateLimit: 1998};
    const peak = evaluateRate(type, axis, 1, {quickRatesRcExpo: false})?.setpointDegPerSec;
    expect(shown(present(RATES_TYPE_QUICK).rcRate, axis.rcRate)).toBeCloseTo(peak ?? -1, 6);
    expect(present(RATES_TYPE_QUICK).rcRate.unit).toBe('°/s');
  });

  it('QUICK: the shown maximum rate IS the peak when it does bind', () => {
    const type = classifyRatesType(RATES_TYPE_QUICK);
    const axis: RateAxisSettings = {rcRate: 60, superRate: 90, expo: 0, rateLimit: 1998};
    const peak = evaluateRate(type, axis, 1, {quickRatesRcExpo: false})?.setpointDegPerSec;
    expect(shown(present(RATES_TYPE_QUICK).superRate, axis.superRate)).toBeCloseTo(peak ?? -1, 6);
    expect(present(RATES_TYPE_QUICK).superRate.unit).toBe('°/s');
  });

  it('every formula reads expo as hundredths', () => {
    for (const raw of KNOWN_RAWS) {
      expect(present(raw).expo.scale).toBe(0.01);
      expect(present(raw).expo.unit).toBeUndefined();
    }
  });
});

describe('formatRateField', () => {
  it('renders a scaled field losslessly, with its unit where it has one', () => {
    expect(formatRateField(present(RATES_TYPE_BETAFLIGHT).rcRate, 100)).toBe('1.00');
    expect(formatRateField(present(RATES_TYPE_ACTUAL).rcRate, 100)).toBe('1000 °/s');
    expect(formatRateField(present(RATES_TYPE_QUICK).rcRate, 100)).toBe('200 °/s');
  });

  it('gives a thousandths field the third decimal it needs to stay distinct', () => {
    // At a fixed two decimals every KISS RC Rate from 100 to 104 rendered as
    // `0.10`, so five distinct tunes looked identical and a stepper press
    // appeared to do nothing.
    const kiss = present(RATES_TYPE_KISS).rcRate;
    expect(rateFieldDecimals(kiss.scale)).toBe(3);
    expect(formatRateField(kiss, 100)).not.toBe(formatRateField(kiss, 101));
  });
});

describe('buildRateCurve', () => {
  it('returns exactly the sample count asked for, spanning the full stick', () => {
    const curve = buildRateCurve(classifyRatesType(RATES_TYPE_BETAFLIGHT), AXIS, 41);
    expect(curve?.points).toHaveLength(41);
    expect(curve?.points[0].stick).toBeCloseTo(-1, 10);
    expect(curve?.points[40].stick).toBeCloseTo(1, 10);
  });

  it('samples the engine rather than reimplementing it', () => {
    const type = classifyRatesType(RATES_TYPE_BETAFLIGHT);
    const curve = buildRateCurve(type, AXIS, 9);
    if (curve === undefined) throw new Error('curve unavailable');
    for (const point of curve.points) {
      expect(point.degPerSec).toBe(evaluateRate(type, AXIS, point.stick)?.setpointDegPerSec);
    }
  });

  it('reports the same peak the engine reports at full stick', () => {
    for (const raw of [RATES_TYPE_BETAFLIGHT, RATES_TYPE_RACEFLIGHT, RATES_TYPE_KISS, RATES_TYPE_ACTUAL]) {
      const type = classifyRatesType(raw);
      const curve = buildRateCurve(type, AXIS);
      expect(curve?.maxDegPerSec).toBeCloseTo(maximumSetpointDegPerSec(type, AXIS) ?? -1, 6);
      expect(axisMaximum(type, AXIS)).toBe(maximumSetpointDegPerSec(type, AXIS));
    }
  });

  it('declines the whole curve for QUICK rather than drawing one of its two shapes', () => {
    // `quickrates_rc_expo` selects between two firmware branches and has no
    // MSP surface, so a partial guess is the only thing on offer - and a
    // partial guess of a rate curve is a lie about how fast the aircraft
    // will rotate.
    expect(buildRateCurve(classifyRatesType(RATES_TYPE_QUICK), AXIS)).toBeUndefined();
  });

  it('declines an unrecognised formula instead of falling back to Betaflight', () => {
    expect(buildRateCurve(classifyRatesType(7), AXIS)).toBeUndefined();
  });

  it('flags clipping only when the profile limit actually bites', () => {
    const type = classifyRatesType(RATES_TYPE_BETAFLIGHT);
    expect(buildRateCurve(type, AXIS)?.clipped).toBe(false);
    const clipped = buildRateCurve(type, {...AXIS, rateLimit: 200});
    expect(clipped?.clipped).toBe(true);
    expect(clipped?.maxDegPerSec).toBeLessThanOrEqual(200);
  });
});

describe('previewCopy', () => {
  it('says nothing extra when the curve is exact', () => {
    const copy = previewCopy(ratePreviewAvailability(classifyRatesType(RATES_TYPE_BETAFLIGHT)));
    expect(copy.available).toBe(true);
    expect(copy.explanation).toBeUndefined();
  });

  it('explains the QUICK gap without claiming the type cannot be configured', () => {
    const copy = previewCopy(ratePreviewAvailability(classifyRatesType(RATES_TYPE_QUICK)));
    expect(copy.available).toBe(false);
    // The field name belongs in the technical detail, not in the sentence a
    // pilot reads.
    expect(copy.technicalReason).toBe('quickRatesRcExpo');
    expect(copy.title).not.toContain('quick_rates');
    // Saving a QUICK profile is a separate capability and stays available.
    expect(copy.explanation).toContain('حفظه');
  });

  it('carries the unrecognised raw value into the title', () => {
    const copy = previewCopy(ratePreviewAvailability(classifyRatesType(11)));
    expect(copy.available).toBe(false);
    expect(copy.title).toContain('11');
  });
});
