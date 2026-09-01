/**
 * RATES, IN A PILOT'S WORDS.
 *
 * The PID screen used to carry its own table of rate-type names, display
 * scales and field labels, inline in the component. That table was a second
 * opinion about a subsystem P-A and P-B had already pinned to firmware
 * source, and a second opinion is how a screen drifts away from the engine
 * it is supposed to be showing.
 *
 * This module owns the PRESENTATION and nothing else:
 *
 *   what to call each formula;
 *   what to call each field, which changes meaning between formulas;
 *   how to render a stored byte as a number a pilot recognises.
 *
 * IT CONTAINS NO RATE MATHEMATICS. Every curve, every maximum and every
 * clamp comes from `rateFormulaEngine`, which is the firmware-equivalent
 * implementation. The display scales below convert a stored byte into the
 * number Betaflight's own UI shows beside it; they never touch the wire and
 * they never touch the preview, which both use the raw value.
 */

import {
  RATES_TYPE_ACTUAL,
  RATES_TYPE_BETAFLIGHT,
  RATES_TYPE_KISS,
  RATES_TYPE_QUICK,
  RATES_TYPE_RACEFLIGHT,
  RATE_SETTING_LIMITS,
  evaluateRate,
  maximumSetpointDegPerSec,
  ratePreviewAvailability,
  type RateAxisSettings,
  type RatePreviewAvailability,
  type RatesType,
} from '../../core/state/rateFormulaEngine';

/**
 * The five formulas, named as FPV pilots name them - with one exception.
 *
 * The default formula carries the name of the firmware project itself, and
 * `brandSurface.test.ts` forbids that name in anything this application
 * authors and shows: printing it in our own chip would read as a claim of
 * association we have no right to make. «قياسي» is what this screen called
 * it before P-D and it is accurate - it is the formula a board ships with.
 * The other four are not that project's name and stay as pilots know them.
 */
export function ratesTypeName(type: RatesType): string {
  switch (type.kind) {
    case 'BETAFLIGHT': return 'قياسي';
    case 'RACEFLIGHT': return 'Raceflight';
    case 'KISS': return 'KISS';
    case 'ACTUAL': return 'Actual';
    case 'QUICK': return 'Quick';
    case 'UNKNOWN': return `نوع غير معروف (${type.raw})`;
  }
}

/**
 * DISPLAY SCALES, TAKEN FROM THE FORMULA THAT READS THE BYTE.
 *
 * `rateFormulaEngine` reads the raw wire byte; a scale here turns that byte
 * into the figure beside it on screen. THE SCALE IS NOT A STYLE CHOICE - it
 * is the coefficient the firmware itself applies, so that the number a pilot
 * types and the number the aircraft flies are the same quantity:
 *
 *   BETAFLIGHT  rcRate/100      superRate/100     expo/100      (applyBetaflightRates)
 *   RACEFLIGHT  rcRate x10 °/s  superRate x0.01   expo x0.01    (applyRaceflightRates)
 *   KISS        rcRate/1000     superRate/100     expo/100      (applyKissRates)
 *   ACTUAL      rcRate x10 °/s  superRate x10 °/s expo/100      (applyActualRates)
 *   QUICK       rcRate x2 °/s   superRate x10 °/s expo/100      (applyQuickRates)
 *
 * Two of these were wrong in the table this module replaced and stayed wrong
 * here until a screenshot was read by eye: a QUICK profile showed its maximum
 * rate as `0.70 °/s` where the firmware reads 700. `ratesPresentation.test.ts`
 * now pins every one of them to the engine's own answer, so a scale can only
 * change if the formula does.
 */
interface RateFieldPresentation {
  readonly label: string;
  /** Displayed = raw × scale. */
  readonly scale: number;
  readonly max: number;
  readonly min: number;
  readonly unit?: string;
}

export interface RateAxisPresentation {
  readonly rcRate: RateFieldPresentation;
  readonly superRate: RateFieldPresentation;
  readonly expo: RateFieldPresentation;
  readonly rateLimit: RateFieldPresentation;
}

const RATE_LIMIT_FIELD: RateFieldPresentation = Object.freeze({
  label: 'الحد الأقصى', scale: 1, min: 200, max: 1998, unit: '°/s',
});

/**
 * The same four bytes mean different things under different formulas, so
 * they are labelled differently. Under ACTUAL and RACEFLIGHT the numbers map
 * far more directly onto angular velocity, and the labels say so instead of
 * calling everything "RC Rate".
 */
/**
 * The scale each formula applies to each byte, and nothing else.
 *
 * `degreesPerSecond` marks the fields whose scaled value IS an angular
 * velocity, so only those carry the °/s unit. The rest are coefficients and
 * carry none - labelling a fraction "°/s" is the exact mistake that shipped
 * `0.70 °/s` for a QUICK axis the firmware flies at 700.
 */
const FORMULA_SCALES: readonly {
  readonly rcRate: number; readonly rcRateDegreesPerSecond: boolean;
  readonly superRate: number; readonly superRateDegreesPerSecond: boolean;
  readonly expo: number;
}[] = Object.freeze([
  /* BETAFLIGHT */ Object.freeze({rcRate: 0.01, rcRateDegreesPerSecond: false, superRate: 0.01, superRateDegreesPerSecond: false, expo: 0.01}),
  /* RACEFLIGHT */ Object.freeze({rcRate: 10, rcRateDegreesPerSecond: true, superRate: 0.01, superRateDegreesPerSecond: false, expo: 0.01}),
  /* KISS       */ Object.freeze({rcRate: 0.001, rcRateDegreesPerSecond: false, superRate: 0.01, superRateDegreesPerSecond: false, expo: 0.01}),
  /* ACTUAL     */ Object.freeze({rcRate: 10, rcRateDegreesPerSecond: true, superRate: 10, superRateDegreesPerSecond: true, expo: 0.01}),
  /* QUICK      */ Object.freeze({rcRate: 2, rcRateDegreesPerSecond: true, superRate: 10, superRateDegreesPerSecond: true, expo: 0.01}),
]);

export function rateAxisPresentation(type: RatesType): RateAxisPresentation | undefined {
  const index = ratesTypeIndex(type);
  if (index === undefined) return undefined;
  const limits = RATE_SETTING_LIMITS[index];
  const scales = FORMULA_SCALES[index];
  return Object.freeze({
    rcRate: Object.freeze({
      label: scales.rcRateDegreesPerSecond ? 'حساسية المركز' : 'RC Rate',
      scale: scales.rcRate,
      min: 1,
      max: limits.rcRate,
      ...(scales.rcRateDegreesPerSecond ? {unit: '°/s'} : {}),
    }),
    superRate: Object.freeze({
      label: scales.superRateDegreesPerSecond ? 'أقصى معدل' : 'قوة المنحنى',
      scale: scales.superRate,
      min: 0,
      max: limits.superRate,
      ...(scales.superRateDegreesPerSecond ? {unit: '°/s'} : {}),
    }),
    expo: Object.freeze({
      label: 'ليونة المركز',
      scale: scales.expo,
      min: 0,
      max: limits.expo,
    }),
    rateLimit: RATE_LIMIT_FIELD,
  });
}

function ratesTypeIndex(type: RatesType): number | undefined {
  switch (type.kind) {
    case 'BETAFLIGHT': return RATES_TYPE_BETAFLIGHT;
    case 'RACEFLIGHT': return RATES_TYPE_RACEFLIGHT;
    case 'KISS': return RATES_TYPE_KISS;
    case 'ACTUAL': return RATES_TYPE_ACTUAL;
    case 'QUICK': return RATES_TYPE_QUICK;
    case 'UNKNOWN': return undefined;
  }
}

/**
 * How many decimals a scale needs to stay LOSSLESS.
 *
 * A fixed two was fine while every fractional field was hundredths, and
 * silently destroyed KISS the moment its true thousandths scale landed:
 * every RC Rate from 100 to 104 rendered as `0.10`, so four distinct tunes
 * looked identical and a stepper press appeared to do nothing.
 */
export function rateFieldDecimals(scale: number): number {
  if (scale >= 1) return 0;
  return Math.max(0, Math.round(-Math.log10(scale)));
}

/** Raw byte as the pilot-facing figure, with its unit where it has one. */
export function formatRateField(field: RateFieldPresentation, raw: number): string {
  const shown = (raw * field.scale).toFixed(rateFieldDecimals(field.scale));
  return field.unit === undefined ? shown : `${shown} ${field.unit}`;
}

/* ------------------------------------------------------------------ */
/* The response preview                                                */
/* ------------------------------------------------------------------ */

/** One point of the curve: normalised stick in, degrees per second out. */
export interface RateCurvePoint {
  readonly stick: number;
  readonly degPerSec: number;
  readonly clampedByRateLimit: boolean;
}

export interface RateCurve {
  readonly points: readonly RateCurvePoint[];
  readonly maxDegPerSec: number;
  /** True when the rate profile's own limit cut the curve short. */
  readonly clipped: boolean;
}

/**
 * Sample the firmware-equivalent engine across the stick range.
 *
 * DELIBERATELY A THIN LOOP. It chooses sample positions and calls
 * `evaluateRate`; it does not know what a super rate is. A curve that
 * disagreed with a save would mean the engine and the picture had diverged,
 * and there is only one place either can come from.
 */
export function buildRateCurve(
  type: RatesType,
  settings: RateAxisSettings,
  samples = 41,
): RateCurve | undefined {
  const points: RateCurvePoint[] = [];
  let maxDegPerSec = 0;
  let clipped = false;
  for (let index = 0; index < samples; index += 1) {
    const stick = -1 + (2 * index) / (samples - 1);
    const evaluation = evaluateRate(type, settings, stick);
    // QUICK, and any unrecognised type, decline to answer. One undefined
    // sample means the whole curve is unavailable - drawing the rest would
    // be a partial guess.
    if (evaluation === undefined) return undefined;
    points.push({
      stick,
      degPerSec: evaluation.setpointDegPerSec,
      clampedByRateLimit: evaluation.clampedByRateLimit,
    });
    maxDegPerSec = Math.max(maxDegPerSec, Math.abs(evaluation.setpointDegPerSec));
    if (evaluation.clampedByRateLimit) clipped = true;
  }
  return Object.freeze({points: Object.freeze(points), maxDegPerSec, clipped});
}

/** The full-stick figure, or undefined where no formula can be applied. */
export function axisMaximum(type: RatesType, settings: RateAxisSettings): number | undefined {
  return maximumSetpointDegPerSec(type, settings);
}

export interface PreviewCopy {
  readonly available: boolean;
  readonly title: string;
  readonly explanation?: string;
  /** The internal field name, for the technical details only. */
  readonly technicalReason?: string;
}

/**
 * Whether a curve can be drawn, and what to say when it cannot.
 *
 * QUICK is the honest one. `quickrates_rc_expo` selects between two
 * different firmware branches and has no MSP surface at 1.47, 1.48 or 1.49,
 * so the curve genuinely has two possible shapes and this app will not pick
 * one. Configuration is unaffected: a QUICK rate profile saves normally.
 */
export function previewCopy(availability: RatePreviewAvailability): PreviewCopy {
  if (availability.kind === 'EXACT_PREVIEW') {
    return Object.freeze({available: true, title: 'معاينة الاستجابة'});
  }
  if (availability.reason === 'QUICK_RATES_RC_EXPO_NOT_OBSERVABLE') {
    return Object.freeze({
      available: false,
      title: 'لا تتوفر معاينة دقيقة لـ Quick',
      explanation: 'يعتمد شكل المنحنى على إعداد داخلي لا يرسله المتحكم عبر MSP، ولن نرسم منحنى مبنيًا على تخمين. يمكنك ضبط Quick وحفظه كالمعتاد.',
      technicalReason: 'quickRatesRcExpo',
    });
  }
  return Object.freeze({
    available: false,
    title: `نوع Rates غير معروف (${availability.raw})`,
    explanation: 'لا نعرف المعادلة التي يستخدمها هذا النوع، فلا نرسم منحنى ولا نسمح بتعديل يعتمد عليها.',
  });
}

export {ratePreviewAvailability};
