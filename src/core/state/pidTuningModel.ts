import type {MspPidTuningSnapshot} from '../protocol/msp/decoding/decodePidTuning';

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
}
export type PidTuningValidationCode =
  | 'PID_GAIN_INVALID'
  | 'FEEDFORWARD_INVALID'
  | 'RATES_TYPE_INVALID'
  | 'RATES_TYPE_CHANGE_UNSUPPORTED'
  | 'RATE_VALUE_INVALID'
  | 'THROTTLE_CURVE_INVALID'
  | 'FILTER_VALUE_INVALID'
  | 'FILTER_ORDER_INVALID'
  | 'FILTER_CAPABILITY_UNPROVEN'
  | 'FILTER_RATE_UNKNOWN'
  | 'FILTER_EXCEEDS_NYQUIST';

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
  });
}

export function pidTuningDraftsEqual(a: PidTuningDraft, b: PidTuningDraft): boolean {
  return AXES.every(key => a[key].p === b[key].p && a[key].i === b[key].i && a[key].d === b[key].d && a[key].f === b[key].f) &&
    ratesEqual(a.rates, b.rates) && filtersEqual(a.filters, b.filters);
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
