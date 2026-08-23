/**
 * THE FIVE RATE CURVES, AS THE FLIGHT CONTROLLER FLIES THEM.
 *
 * These are reimplementations of the pinned firmware's behaviour, not of the
 * Configurator's preview. That distinction is not pedantic: P-A found three
 * places where the official preview and the firmware disagree, and a preview
 * that inherits those bugs would draw a curve the aircraft does not fly.
 *
 *   RACEFLIGHT  the preview scales by the magnitude of the CURVED value; the
 *               firmware scales by the magnitude of the RAW stick.
 *   KISS        the preview divides by an unconstrained denominator; the
 *               firmware constrains it to [0.01, 1] before dividing.
 *   QUICK       the preview implements only one of the firmware's two
 *               branches, and never constrains its super factor.
 *   ALL FIVE    the firmware clamps the result to the rate profile's
 *               rate_limit for every type; the preview clamps only Betaflight.
 *
 * Where they differ, the firmware wins. Every one of those four divergences
 * is reproduced on the firmware's side here and is covered by a fixture whose
 * expected value was derived by hand from the pinned source.
 *
 * QUICK RATES CANNOT ALWAYS BE ANSWERED. The firmware picks between two
 * different QUICK formulas using `quickRatesRcExpo`, a rate-profile field that
 * appears in the CLI and in no MSP command at 1.47, 1.48 or 1.49. The engine
 * implements both branches and will compute either on demand, but a caller
 * working only from MSP evidence is told it cannot have an exact answer
 * rather than being handed a guess.
 */

export const RATES_TYPE_BETAFLIGHT = 0;
export const RATES_TYPE_RACEFLIGHT = 1;
export const RATES_TYPE_KISS = 2;
export const RATES_TYPE_ACTUAL = 3;
export const RATES_TYPE_QUICK = 4;
/** controlrate_profile.h RATES_TYPE_COUNT - a sentinel, never a stored type. */
export const RATES_TYPE_COUNT_SENTINEL = 5;

export type RatesType =
  | {readonly kind: 'BETAFLIGHT'}
  | {readonly kind: 'RACEFLIGHT'}
  | {readonly kind: 'KISS'}
  | {readonly kind: 'ACTUAL'}
  | {readonly kind: 'QUICK'}
  | {readonly kind: 'UNKNOWN'; readonly raw: number};

export function classifyRatesType(raw: number): RatesType {
  switch (raw) {
    case RATES_TYPE_BETAFLIGHT: return Object.freeze({kind: 'BETAFLIGHT'});
    case RATES_TYPE_RACEFLIGHT: return Object.freeze({kind: 'RACEFLIGHT'});
    case RATES_TYPE_KISS: return Object.freeze({kind: 'KISS'});
    case RATES_TYPE_ACTUAL: return Object.freeze({kind: 'ACTUAL'});
    case RATES_TYPE_QUICK: return Object.freeze({kind: 'QUICK'});
    default: return Object.freeze({kind: 'UNKNOWN', raw});
  }
}

/** fc/rc.c */
export const SETPOINT_RATE_LIMIT_MIN = -1998;
export const SETPOINT_RATE_LIMIT_MAX = 1998;
const RC_RATE_INCREMENTAL = 14.54;

/** fc/rc_controls.h */
export const CONTROL_RATE_CONFIG_RATE_LIMIT_MIN = 200;
export const CONTROL_RATE_CONFIG_RATE_LIMIT_MAX = 1998;

/** controlrate_profile.c ratesSettingLimits, indexed by rates type. */
export const RATE_SETTING_LIMITS: readonly {
  readonly rcRate: number;
  readonly superRate: number;
  readonly expo: number;
}[] = Object.freeze([
  Object.freeze({rcRate: 255, superRate: 100, expo: 100}),
  Object.freeze({rcRate: 200, superRate: 255, expo: 100}),
  Object.freeze({rcRate: 255, superRate: 99, expo: 100}),
  Object.freeze({rcRate: 200, superRate: 200, expo: 100}),
  Object.freeze({rcRate: 255, superRate: 200, expo: 100}),
]);

function constrainf(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const power3 = (x: number): number => x * x * x;
const power5 = (x: number): number => x * x * x * x * x;

/** The raw per-axis wire values, exactly as MSP_RC_TUNING carries them. */
export interface RateAxisSettings {
  readonly rcRate: number;
  readonly superRate: number;
  readonly expo: number;
  readonly rateLimit: number;
}

/**
 * Normalise a stick position the way the firmware does.
 *
 * The firmware divides rcCommand by (500 - deadband), using the yaw deadband
 * on the yaw axis. That is why the PID page has to read MSP_RC_DEADBAND at
 * all: without it the curve is scaled wrongly near centre.
 */
export function normaliseStick(rcCommand: number, deadband: number): number {
  const divider = 500 - deadband;
  if (divider <= 0) return 0;
  return rcCommand / divider;
}

function applyBetaflightRates(c: number, cAbs: number, s: RateAxisSettings): number {
  let curved = c;
  if (s.expo !== 0) {
    const expof = s.expo / 100;
    curved = c * power3(cAbs) * expof + c * (1 - expof);
  }
  let rcRate = s.rcRate / 100;
  if (rcRate > 2) {
    rcRate += RC_RATE_INCREMENTAL * (rcRate - 2);
  }
  let angleRate = 200 * rcRate * curved;
  if (s.superRate !== 0) {
    const superFactor = 1 / constrainf(1 - cAbs * (s.superRate / 100), 0.01, 1);
    angleRate *= superFactor;
  }
  return angleRate;
}

function applyRaceflightRates(c: number, cAbs: number, s: RateAxisSettings): number {
  const curved = (1 + 0.01 * s.expo * (c * c - 1)) * c;
  let angleRate = 10 * s.rcRate * curved;
  // The magnitude here is the RAW stick, not the curved value. The official
  // preview uses the curved magnitude; the firmware does not.
  angleRate = angleRate * (1 + cAbs * s.superRate * 0.01);
  return angleRate;
}

function applyKissRates(c: number, cAbs: number, s: RateAxisSettings): number {
  const rcCurvef = s.expo / 100;
  // Constrained before the reciprocal. Without the clamp this diverges as the
  // stick approaches full deflection at high super rates.
  const kissRpyUseRates = 1 / constrainf(1 - cAbs * (s.superRate / 100), 0.01, 1);
  const kissRcCommandf = (power3(c) * rcCurvef + c * (1 - rcCurvef)) * (s.rcRate / 1000);
  return constrainf(2000 * kissRpyUseRates * kissRcCommandf, SETPOINT_RATE_LIMIT_MIN, SETPOINT_RATE_LIMIT_MAX);
}

function applyActualRates(c: number, cAbs: number, s: RateAxisSettings): number {
  let expof = s.expo / 100;
  expof = cAbs * (power5(c) * expof + c * (1 - expof));
  const centreSensitivity = s.rcRate * 10;
  const stickMovement = Math.max(0, s.superRate * 10 - centreSensitivity);
  return c * centreSensitivity + stickMovement * expof;
}

function applyQuickRates(c: number, cAbs: number, s: RateAxisSettings, rcExpoOnCommand: boolean): number {
  const rcRate = s.rcRate * 2;
  const maxDps = Math.max(s.superRate * 10, rcRate);
  const expof = s.expo / 100;
  const superFactorConfig = (maxDps / rcRate - 1) / (maxDps / rcRate);
  if (rcExpoOnCommand) {
    const curve = power3(c) * expof + c * (1 - expof);
    const superFactor = 1 / constrainf(1 - cAbs * superFactorConfig, 0.01, 1);
    return constrainf(curve * rcRate * superFactor, SETPOINT_RATE_LIMIT_MIN, SETPOINT_RATE_LIMIT_MAX);
  }
  const curve = power3(cAbs) * expof + cAbs * (1 - expof);
  const superFactor = 1 / constrainf(1 - curve * superFactorConfig, 0.01, 1);
  return constrainf(c * rcRate * superFactor, SETPOINT_RATE_LIMIT_MIN, SETPOINT_RATE_LIMIT_MAX);
}

export interface RateEvaluation {
  /** Before the rate profile's own limit is applied. */
  readonly angleRate: number;
  /** After it - this is what actually reaches the PID controller. */
  readonly setpointDegPerSec: number;
  readonly clampedByRateLimit: boolean;
}

/**
 * Evaluate one axis at one stick position.
 *
 * `quickRatesRcExpo` is required only for QUICK and must be supplied
 * explicitly - there is deliberately no default, because a default here would
 * be exactly the guess this module refuses to make.
 */
export function evaluateRate(
  type: RatesType,
  settings: RateAxisSettings,
  normalisedStick: number,
  options: {readonly quickRatesRcExpo?: boolean} = {},
): RateEvaluation | undefined {
  const c = normalisedStick;
  const cAbs = Math.abs(c);
  let angleRate: number;
  switch (type.kind) {
    case 'BETAFLIGHT': angleRate = applyBetaflightRates(c, cAbs, settings); break;
    case 'RACEFLIGHT': angleRate = applyRaceflightRates(c, cAbs, settings); break;
    case 'KISS': angleRate = applyKissRates(c, cAbs, settings); break;
    case 'ACTUAL': angleRate = applyActualRates(c, cAbs, settings); break;
    case 'QUICK': {
      if (options.quickRatesRcExpo === undefined) return undefined;
      angleRate = applyQuickRates(c, cAbs, settings, options.quickRatesRcExpo);
      break;
    }
    // An unrecognised rates type has no formula. The firmware would fall
    // through to Betaflight rates, but it knows which build it is; we do not,
    // so we decline rather than draw somebody else's curve.
    default: return undefined;
  }
  // fc/rc.c applies this to EVERY rates type, outside the per-type function.
  const limited = constrainf(angleRate, -settings.rateLimit, settings.rateLimit);
  return Object.freeze({
    angleRate,
    setpointDegPerSec: limited,
    clampedByRateLimit: limited !== angleRate,
  });
}

/**
 * Whether a board-derived preview can be exact, and if not, why not.
 *
 * This is the contract P-A's P0-A asked for. QUICK is the only type that can
 * come back unavailable, and the reason names the missing field rather than
 * saying "unsupported".
 */
export type RatePreviewAvailability =
  | {readonly kind: 'EXACT_PREVIEW'}
  | {readonly kind: 'PREVIEW_UNAVAILABLE'; readonly reason: 'QUICK_RATES_RC_EXPO_NOT_OBSERVABLE' }
  | {readonly kind: 'PREVIEW_UNAVAILABLE'; readonly reason: 'RATES_TYPE_UNKNOWN'; readonly raw: number};

/**
 * `quickRatesRcExpo` is observable only if some source outside MSP supplied
 * it - the CLI, say. `observedQuickRatesRcExpo` is therefore optional and
 * absent by default; MSP alone can never populate it at these API versions.
 */
export function ratePreviewAvailability(
  type: RatesType,
  observedQuickRatesRcExpo?: boolean,
): RatePreviewAvailability {
  if (type.kind === 'UNKNOWN') {
    return Object.freeze({kind: 'PREVIEW_UNAVAILABLE', reason: 'RATES_TYPE_UNKNOWN', raw: type.raw});
  }
  if (type.kind === 'QUICK' && observedQuickRatesRcExpo === undefined) {
    return Object.freeze({kind: 'PREVIEW_UNAVAILABLE', reason: 'QUICK_RATES_RC_EXPO_NOT_OBSERVABLE'});
  }
  return Object.freeze({kind: 'EXACT_PREVIEW'});
}

/**
 * The highest setpoint the axis can reach - full stick, after the limit.
 *
 * Betaflight shows this number beside each axis and it is genuinely useful,
 * but it inherits the availability contract above: a QUICK axis with no
 * observed boolean has no single answer, so it returns undefined rather than
 * picking a branch.
 */
export function maximumSetpointDegPerSec(
  type: RatesType,
  settings: RateAxisSettings,
  options: {readonly quickRatesRcExpo?: boolean} = {},
): number | undefined {
  const evaluation = evaluateRate(type, settings, 1, options);
  return evaluation === undefined ? undefined : evaluation.setpointDegPerSec;
}
