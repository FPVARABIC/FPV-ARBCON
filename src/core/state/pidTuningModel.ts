import type {MspPidTuningSnapshot} from '../protocol/msp/decoding/decodePidTuning';
import {IDLE_MIN_RPM_MAX} from '../protocol/msp/decoding/decodePidTuning';
import type {AdvancedPidDraft} from './advancedPidFields';
import {
  createAdvancedPidDraftFromRaw,
  advancedPidDraftsEqual,
  invalidAdvancedFields,
} from './advancedPidFields';
import type {AdvancedFilterDraft} from './advancedFilterFields';
import {
  createAdvancedFilterDraftFromRaw,
  advancedFilterDraftsEqual,
  invalidAdvancedFilterFields,
} from './advancedFilterFields';

export type PidAxisKey = 'roll' | 'pitch' | 'yaw';
export interface PidAxisDraft { readonly p: number; readonly i: number; readonly d: number; readonly f: number }
export interface RateAxisDraft {
  readonly rcRate: number;
  readonly superRate: number;
  readonly expo: number;
  readonly limit: number;
}
export interface RatesDraft {
  readonly type: number;
  readonly roll: RateAxisDraft;
  readonly pitch: RateAxisDraft;
  readonly yaw: RateAxisDraft;
  readonly throttleMid: number;
  readonly throttleExpo: number;
  readonly throttleHover: number;
  readonly throttleLimitType: number;
  readonly throttleLimitPercent: number;
}
export interface FiltersDraft {
  readonly gyroLpf1StaticHz: number;
  readonly gyroLpf1DynamicMinHz: number;
  readonly gyroLpf1DynamicMaxHz: number;
  readonly dtermLpf1StaticHz: number;
  readonly dtermLpf1DynamicMinHz: number;
  readonly dtermLpf1DynamicMaxHz: number;
  readonly dynamicNotchQ: number;
  readonly dynamicNotchMinHz: number;
  readonly dynamicNotchMaxHz: number;
  readonly dynamicNotchCount: number;
}
export interface PidTuningDraft {
  readonly roll: PidAxisDraft;
  readonly pitch: PidAxisDraft;
  readonly yaw: PidAxisDraft;
  readonly rates: RatesDraft;
  readonly filters: FiltersDraft;
  /**
   * Dynamic Idle floor, in units of 100 rpm, exactly as the wire carries it.
   * Betaflight's own bound is 0-100, raised to 0-200 for API >= 1.45.
   */
  readonly idleMinRpm: number;
  /**
   * The three feedforward "feel" settings, in wire units.
   *
   * Ranges are the firmware's own (settings.c): averaging is a lookup of
   * four entries, boost 0-50, jitter factor 0-20. They are what
   * Betaflight's official presets change to define a flight style, which
   * is why they are editable here rather than left to the CLI.
   */
  readonly feedforwardAveraging: number;
  readonly feedforwardBoost: number;
  readonly feedforwardJitterFactor: number;

  /**
   * The P-E advanced tier, kept in TWO named groups rather than flattened
   * into this interface.
   *
   * They stay separate because they are separate on the wire and in the
   * firmware: `advanced` is MSP_PID_ADVANCED and belongs entirely to the
   * PID profile, while `advancedFilters` is MSP_FILTER_CONFIG and carries
   * BOTH lifetimes - which is why `ADVANCED_FILTER_BOUNDS` records a scope
   * per field. Flattening the two would make it possible to write code
   * that forgets which is which, and P-E §13 exists precisely to stop
   * that.
   *
   * Every field in both is EXPOSED, not merely carried: the encode path
   * patches each one into the board's own payload, so a value here that no
   * control ever moves is written back unchanged.
   */
  readonly advanced: AdvancedPidDraft;
  readonly advancedFilters: AdvancedFilterDraft;
}

/** settings.c: lookupTableFeedforwardAveraging has four entries. */
export const FEEDFORWARD_AVERAGING_MAX = 3;
/** settings.c: PARAM_NAME_FEEDFORWARD_BOOST minmaxUnsigned {0, 50}. */
export const FEEDFORWARD_BOOST_MAX = 50;
/** settings.c: PARAM_NAME_FEEDFORWARD_JITTER_FACTOR minmaxUnsigned {0, 20}. */
export const FEEDFORWARD_JITTER_FACTOR_MAX = 20;

export type PidTuningValidationCode =
  | 'PID_GAIN_INVALID'
  | 'FEEDFORWARD_INVALID'
  | 'FEEDFORWARD_AVERAGING_INVALID'
  | 'FEEDFORWARD_BOOST_INVALID'
  | 'FEEDFORWARD_JITTER_INVALID'
  | 'RATES_TYPE_INVALID'
  | 'RATES_TYPE_CHANGE_UNSUPPORTED'
  | 'RATE_VALUE_INVALID'
  | 'THROTTLE_CURVE_INVALID'
  | 'FILTER_VALUE_INVALID'
  | 'IDLE_MIN_RPM_INVALID'
  | 'FILTER_ORDER_INVALID'
  | 'FILTER_CAPABILITY_UNPROVEN'
  | 'FILTER_RATE_UNKNOWN'
  | 'FILTER_EXCEEDS_NYQUIST'
  | 'ADVANCED_PID_VALUE_INVALID'
  | 'ADVANCED_FILTER_VALUE_INVALID';

const AXES = Object.freeze(['roll', 'pitch', 'yaw'] as const);

export function createPidTuningDraft(snapshot: MspPidTuningSnapshot): PidTuningDraft {
  const axis = (index: number): PidAxisDraft => Object.freeze({
    p: snapshot.terms[index].p,
    i: snapshot.terms[index].i,
    d: snapshot.terms[index].d,
    f: snapshot.feedforward[index],
  });
  const rateAxis = (index: number): RateAxisDraft => Object.freeze({
    rcRate: snapshot.rcTuning.rcRate[index],
    superRate: snapshot.rcTuning.superRate[index],
    expo: snapshot.rcTuning.expo[index],
    limit: snapshot.rcTuning.rateLimit[index],
  });
  return Object.freeze({
    roll: axis(0),
    pitch: axis(1),
    yaw: axis(2),
    rates: Object.freeze({
      type: snapshot.rcTuning.ratesType,
      roll: rateAxis(0),
      pitch: rateAxis(1),
      yaw: rateAxis(2),
      throttleMid: snapshot.rcTuning.throttleMid,
      throttleExpo: snapshot.rcTuning.throttleExpo,
      throttleHover: snapshot.rcTuning.throttleHover,
      throttleLimitType: snapshot.rcTuning.throttleLimitType,
      throttleLimitPercent: snapshot.rcTuning.throttleLimitPercent,
    }),
    filters: Object.freeze({...snapshot.filterConfig}),
    idleMinRpm: snapshot.idleMinRpm,
    feedforwardAveraging: snapshot.feedforwardAveraging,
    feedforwardBoost: snapshot.feedforwardBoost,
    feedforwardJitterFactor: snapshot.feedforwardJitterFactor,
    /* Built from the RAW payloads rather than from a decoded view, so no
       API contract has to be threaded through this function. Both groups
       read strictly inside the minimum length `decodePidTuning` already
       enforces (61 advanced bytes, 49 filter bytes) - a snapshot that
       could not satisfy those never becomes a snapshot at all. */
    advanced: createAdvancedPidDraftFromRaw(snapshot.advancedRaw),
    advancedFilters: createAdvancedFilterDraftFromRaw(snapshot.filtersRaw),
  });
}

export function pidTuningDraftsEqual(a: PidTuningDraft, b: PidTuningDraft): boolean {
  return a.idleMinRpm === b.idleMinRpm &&
    a.feedforwardAveraging === b.feedforwardAveraging &&
    a.feedforwardBoost === b.feedforwardBoost &&
    a.feedforwardJitterFactor === b.feedforwardJitterFactor &&
    AXES.every(key => a[key].p === b[key].p && a[key].i === b[key].i && a[key].d === b[key].d && a[key].f === b[key].f) &&
    ratesEqual(a.rates, b.rates) && filtersEqual(a.filters, b.filters) &&
    advancedPidDraftsEqual(a.advanced, b.advanced) &&
    advancedFilterDraftsEqual(a.advancedFilters, b.advancedFilters);
}

export function ratesEqual(a: RatesDraft, b: RatesDraft): boolean {
  return a.type === b.type && a.throttleMid === b.throttleMid && a.throttleExpo === b.throttleExpo &&
    a.throttleHover === b.throttleHover && a.throttleLimitType === b.throttleLimitType &&
    a.throttleLimitPercent === b.throttleLimitPercent && AXES.every(key =>
      a[key].rcRate === b[key].rcRate && a[key].superRate === b[key].superRate &&
      a[key].expo === b[key].expo && a[key].limit === b[key].limit);
}

export function filtersEqual(a: FiltersDraft, b: FiltersDraft): boolean {
  return Object.keys(a).every(key => a[key as keyof FiltersDraft] === b[key as keyof FiltersDraft]);
}

export function pidTuningSnapshotsEqual(a: MspPidTuningSnapshot, b: MspPidTuningSnapshot): boolean {
  return a.gyroSampleRateHz === b.gyroSampleRateHz && a.pidProcessDenom === b.pidProcessDenom &&
    a.pidProfileIndex === b.pidProfileIndex && a.pidProfileCount === b.pidProfileCount &&
    a.controlRateProfileIndex === b.controlRateProfileIndex &&
    a.pidRaw.length === b.pidRaw.length && a.pidRaw.every((value, index) => value === b.pidRaw[index]) &&
    a.advancedRaw.length === b.advancedRaw.length && a.advancedRaw.every((value, index) => value === b.advancedRaw[index]) &&
    a.ratesRaw.length === b.ratesRaw.length && a.ratesRaw.every((value, index) => value === b.ratesRaw[index]) &&
    a.filtersRaw.length === b.filtersRaw.length && a.filtersRaw.every((value, index) => value === b.filtersRaw[index]);
}

const RATE_LIMITS = Object.freeze([
  Object.freeze({rcRate: 255, superRate: 100, expo: 100}),
  Object.freeze({rcRate: 200, superRate: 255, expo: 100}),
  Object.freeze({rcRate: 255, superRate: 99, expo: 100}),
  Object.freeze({rcRate: 200, superRate: 200, expo: 100}),
  Object.freeze({rcRate: 255, superRate: 200, expo: 100}),
]);
const integerIn = (value: number, min: number, max: number) => Number.isInteger(value) && value >= min && value <= max;
const enabledFrequencyBelow = (value: number, nyquist: number) => value === 0 || value < nyquist;

export function validatePidTuningDraft(draft: PidTuningDraft, snapshot?: MspPidTuningSnapshot): readonly PidTuningValidationCode[] {
  const issues = new Set<PidTuningValidationCode>();
  // Betaflight's own bound: 0-100, raised to 0-200 for API >= 1.45. We speak
  // 1.47. Enforced on the way OUT, which is where Betaflight enforces it.
  if (
    !Number.isInteger(draft.idleMinRpm) ||
    draft.idleMinRpm < 0 ||
    draft.idleMinRpm > IDLE_MIN_RPM_MAX
  ) {
    issues.add('IDLE_MIN_RPM_INVALID');
  }
  /*
   * CHANGE-SCOPED, for the reason gpsRescueConfigurationModel.ts spells
   * out at length: holding a field the operator never touched to a range
   * would let one stored byte make the WHOLE screen unsaveable. These
   * three offsets are only populated from API 1.44, and a board can
   * present bytes there this app has no business judging - but the moment
   * an operator moves one, it must land inside the firmware's own bound,
   * because MSP_SET_PID_ADVANCED does not clamp and will store whatever
   * arrives.
   */
  // The snapshot is optional on this function. With no board to compare
  // against there is no "unchanged" to exempt, so every field is bounded -
  // the stricter reading, which is the right default when in doubt.
  const stored = snapshot === undefined ? undefined : createPidTuningDraft(snapshot);
  const moved = (key: 'feedforwardAveraging' | 'feedforwardBoost' | 'feedforwardJitterFactor'): boolean =>
    stored === undefined || draft[key] !== stored[key];
  const bounded = (value: number, max: number): boolean =>
    Number.isInteger(value) && value >= 0 && value <= max;
  if (moved('feedforwardAveraging') && !bounded(draft.feedforwardAveraging, FEEDFORWARD_AVERAGING_MAX)) issues.add('FEEDFORWARD_AVERAGING_INVALID');
  if (moved('feedforwardBoost') && !bounded(draft.feedforwardBoost, FEEDFORWARD_BOOST_MAX)) issues.add('FEEDFORWARD_BOOST_INVALID');
  if (moved('feedforwardJitterFactor') && !bounded(draft.feedforwardJitterFactor, FEEDFORWARD_JITTER_FACTOR_MAX)) issues.add('FEEDFORWARD_JITTER_INVALID');
  /* The advanced tier, held to the SAME change-scoped rule as the three
     above and for the same reason: these are fifty-odd bytes of somebody
     else's tune, and one stored value this app judges out of range must
     not make the whole screen unsaveable. Bounds are the firmware's own -
     see the `source` citation carried beside every entry. */
  if (invalidAdvancedFields(draft.advanced, stored?.advanced).length > 0) {
    issues.add('ADVANCED_PID_VALUE_INVALID');
  }
  if (invalidAdvancedFilterFields(draft.advancedFilters, stored?.advancedFilters).length > 0) {
    issues.add('ADVANCED_FILTER_VALUE_INVALID');
  }
  for (const key of AXES) {
    const value = draft[key];
    if ([value.p, value.i, value.d].some(gain => !Number.isInteger(gain) || gain < 0 || gain > 250)) issues.add('PID_GAIN_INVALID');
    if (!Number.isInteger(value.f) || value.f < 0 || value.f > 1000) issues.add('FEEDFORWARD_INVALID');
  }
  const rateLimits = RATE_LIMITS[draft.rates.type];
  if (rateLimits === undefined) issues.add('RATES_TYPE_INVALID');
  else for (const key of AXES) {
    const value = draft.rates[key];
    if (!integerIn(value.rcRate, 1, rateLimits.rcRate) || !integerIn(value.superRate, 0, rateLimits.superRate) ||
      !integerIn(value.expo, 0, rateLimits.expo) || !integerIn(value.limit, 200, 1998)) issues.add('RATE_VALUE_INVALID');
  }
  if (!integerIn(draft.rates.throttleMid, 0, 100) || !integerIn(draft.rates.throttleExpo, 0, 100) ||
    !integerIn(draft.rates.throttleHover, 0, 100) || !integerIn(draft.rates.throttleLimitType, 0, 2) ||
    !integerIn(draft.rates.throttleLimitPercent, 25, 100)) issues.add('THROTTLE_CURVE_INVALID');
  if (snapshot !== undefined && draft.rates.type !== snapshot.rcTuning.ratesType) {
    issues.add('RATES_TYPE_CHANGE_UNSUPPORTED');
  }

  const f = draft.filters;
  if (![f.gyroLpf1StaticHz, f.gyroLpf1DynamicMinHz, f.gyroLpf1DynamicMaxHz, f.dtermLpf1StaticHz,
    f.dtermLpf1DynamicMinHz, f.dtermLpf1DynamicMaxHz].every(value => integerIn(value, 0, 1000)) ||
    !integerIn(f.dynamicNotchCount, 0, 7) || !integerIn(f.dynamicNotchQ, 0, 1000) ||
    !integerIn(f.dynamicNotchMinHz, 0, 250) || !integerIn(f.dynamicNotchMaxHz, 0, 1000)) issues.add('FILTER_VALUE_INVALID');
  /*
   * A D-TERM NOTCH WHOSE CUTOFF HAS SWALLOWED ITS CENTRE IS REFUSED, NOT
   * WRITTEN AND THEN EXPLAINED.
   *
   * The firmware has the same `cutoff >= hz -> hz = 0` correction for the
   * D-term notch as for the gyro notches, but it lives in
   * `validateAndFixConfig()`, which an MSP filter write never calls - it
   * runs at EEPROM write and at boot. So the board would accept this
   * value, hand it straight back, and then discard it the next time the
   * configuration is persisted. There is no verdict that reports that
   * honestly after the fact; the only honest move is not to send it. The
   * operator's real way to switch the notch off is dterm_notch_hz = 0,
   * which this rule leaves alone.
   */
  const af = draft.advancedFilters;
  if (af.dtermNotchHz > 0 && af.dtermNotchCutoff >= af.dtermNotchHz) {
    issues.add('FILTER_ORDER_INVALID');
  }
  if ((f.gyroLpf1DynamicMinHz > 0 && f.gyroLpf1DynamicMinHz > f.gyroLpf1DynamicMaxHz) ||
    (f.dtermLpf1DynamicMinHz > 0 && f.dtermLpf1DynamicMinHz > f.dtermLpf1DynamicMaxHz) ||
    (f.dynamicNotchCount > 0 && (f.dynamicNotchQ < 1 || f.dynamicNotchMinHz < 20 ||
      f.dynamicNotchMaxHz < 200 || f.dynamicNotchMinHz >= f.dynamicNotchMaxHz))) issues.add('FILTER_ORDER_INVALID');

  if (snapshot !== undefined && !filtersEqual(f, createPidTuningDraft(snapshot).filters)) {
    const original = createPidTuningDraft(snapshot).filters;
    const gyroDynamicWasActive = original.gyroLpf1DynamicMinHz > 0;
    const dtermDynamicWasActive = original.dtermLpf1DynamicMinHz > 0;
    const notchWasActive = original.dynamicNotchCount > 0;
    if ((!gyroDynamicWasActive && (f.gyroLpf1DynamicMinHz !== original.gyroLpf1DynamicMinHz ||
      f.gyroLpf1DynamicMaxHz !== original.gyroLpf1DynamicMaxHz)) ||
      (gyroDynamicWasActive && (f.gyroLpf1DynamicMinHz === 0 || f.gyroLpf1StaticHz !== original.gyroLpf1StaticHz)) ||
      (!dtermDynamicWasActive && (f.dtermLpf1DynamicMinHz !== original.dtermLpf1DynamicMinHz ||
        f.dtermLpf1DynamicMaxHz !== original.dtermLpf1DynamicMaxHz)) ||
      (dtermDynamicWasActive && (f.dtermLpf1DynamicMinHz === 0 || f.dtermLpf1StaticHz !== original.dtermLpf1StaticHz)) ||
      (!notchWasActive && (f.dynamicNotchCount !== original.dynamicNotchCount ||
        f.dynamicNotchQ !== original.dynamicNotchQ || f.dynamicNotchMinHz !== original.dynamicNotchMinHz ||
        f.dynamicNotchMaxHz !== original.dynamicNotchMaxHz)) ||
      (notchWasActive && f.dynamicNotchCount === 0)) issues.add('FILTER_CAPABILITY_UNPROVEN');
    if (snapshot.gyroSampleRateHz === undefined || snapshot.pidProcessDenom === undefined || snapshot.pidProcessDenom < 1) {
      issues.add('FILTER_RATE_UNKNOWN');
    } else {
      const gyroNyquist = snapshot.gyroSampleRateHz / 2;
      const pidNyquist = snapshot.gyroSampleRateHz / snapshot.pidProcessDenom / 2;
      const gyroValues = f.gyroLpf1DynamicMinHz > 0
        ? [f.gyroLpf1DynamicMinHz, f.gyroLpf1DynamicMaxHz]
        : [f.gyroLpf1StaticHz];
      const dtermValues = f.dtermLpf1DynamicMinHz > 0
        ? [f.dtermLpf1DynamicMinHz, f.dtermLpf1DynamicMaxHz]
        : [f.dtermLpf1StaticHz];
      const notchValues = f.dynamicNotchCount > 0 ? [f.dynamicNotchMinHz, f.dynamicNotchMaxHz] : [];
      if (!gyroValues.every(value => enabledFrequencyBelow(value, gyroNyquist)) ||
        !dtermValues.every(value => enabledFrequencyBelow(value, pidNyquist)) ||
        !notchValues.every(value => enabledFrequencyBelow(value, gyroNyquist))) issues.add('FILTER_EXCEEDS_NYQUIST');
    }
  }
  return Object.freeze([...issues]);
}
