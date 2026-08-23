/**
 * WHAT THE SIMPLIFIED SLIDERS ACTUALLY DO, reimplemented from the pinned
 * firmware's behaviour rather than transcribed from its source.
 *
 * The single most important fact this module encodes: Betaflight's simplified
 * tuning does NOT scale your tune. It REGENERATES it. The firmware takes the
 * compile-time factory defaults, multiplies them by the slider positions, and
 * writes the result over `pid[axis].P/.I/.D/.F` and `d_max[axis]` in place.
 * Whatever you had typed there is gone. The same is true of the filter
 * frequencies. A pilot who has hand-tuned a quad and then nudges one slider
 * has not adjusted their tune - they have replaced it with a scaled default.
 *
 * That is why `overwrites` is part of the result. A caller can ask, before
 * sending anything, exactly which stored fields this write will destroy, and
 * say so in words.
 *
 * TWO ARITHMETIC DETAILS THAT CHANGE ANSWERS BY ONE:
 *
 *   PID path    the firmware computes in float, then hands the result to a
 *               constrain() whose parameters are `int`. C converts float to
 *               int by discarding the fraction, so the value truncates toward
 *               zero BEFORE it is clamped. Rounding instead would be wrong on
 *               roughly half of all slider positions.
 *   Filter path the firmware never leaves integer arithmetic: it multiplies
 *               the default by the slider and divides by 100 in ints, so the
 *               division truncates too.
 *
 * Both are reproduced exactly. Neither uses Math.round.
 */

/** flight/pid.h - PID_ROLL_DEFAULT / PID_PITCH_DEFAULT / PID_YAW_DEFAULT. */
export interface AxisPidDefaults {
  readonly p: number;
  readonly i: number;
  readonly d: number;
  readonly f: number;
}

export interface SimplifiedGeneratorDefaults {
  readonly pid: readonly [AxisPidDefaults, AxisPidDefaults, AxisPidDefaults];
  /** flight/pid.h - D_MAX_DEFAULT. A zero here means the axis has no D Max. */
  readonly dMax: readonly [number, number, number];
  readonly gyroLpf1DynMinHz: number;
  readonly gyroLpf1DynMaxHz: number;
  readonly gyroLpf2Hz: number;
  readonly dtermLpf1DynMinHz: number;
  readonly dtermLpf1DynMaxHz: number;
  readonly dtermLpf2Hz: number;
  readonly pidGainMax: number;
  readonly fGainMax: number;
  readonly dynLpfMaxHz: number;
  readonly lpfMaxHz: number;
}

/**
 * The defaults are VERSIONED even though all three pinned trees agree,
 * because "they happen to be identical today" is not a reason to hard-code
 * one table for firmware we have not read. `simplifiedDefaultsFor` is the
 * only way to obtain them, so a future divergence is a new table rather than
 * a silent wrong answer.
 *
 * Verified identical at 1.47 / 1.48 / 1.49 by diffing flight/pid.h and
 * sensors/gyro.h across the three pinned commits.
 */
const DEFAULTS_147_TO_149: SimplifiedGeneratorDefaults = Object.freeze({
  pid: Object.freeze([
    Object.freeze({p: 45, i: 80, d: 30, f: 120}),
    Object.freeze({p: 47, i: 84, d: 34, f: 125}),
    Object.freeze({p: 45, i: 80, d: 0, f: 120}),
  ]) as readonly [AxisPidDefaults, AxisPidDefaults, AxisPidDefaults],
  dMax: Object.freeze([40, 46, 0]) as readonly [number, number, number],
  gyroLpf1DynMinHz: 250,
  gyroLpf1DynMaxHz: 500,
  gyroLpf2Hz: 500,
  dtermLpf1DynMinHz: 75,
  dtermLpf1DynMaxHz: 150,
  dtermLpf2Hz: 150,
  pidGainMax: 250,
  fGainMax: 1000,
  dynLpfMaxHz: 1000,
  lpfMaxHz: 1000,
});

export type SimplifiedDefaultsContract = 'API_1_47' | 'API_1_48' | 'API_1_49';

export function simplifiedDefaultsFor(_contract: SimplifiedDefaultsContract): SimplifiedGeneratorDefaults {
  return DEFAULTS_147_TO_149;
}

/**
 * The firmware's constrain(): its parameters are `int`, so a float argument
 * loses its fraction on the way in, and the clamp happens afterwards.
 */
function truncateThenClamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** The filter path stays in integers throughout, so the divide truncates. */
function scaleHz(defaultHz: number, multiplier: number, max: number): number {
  return truncateThenClamp(Math.trunc((defaultHz * multiplier) / 100), 0, max);
}

export interface SimplifiedPidSliderInputs {
  /** 0 OFF, 1 RP, 2 RPY. An unknown raw value must be refused upstream. */
  readonly mode: 0 | 1 | 2;
  readonly masterMultiplier: number;
  readonly rollPitchRatio: number;
  readonly iGain: number;
  readonly dGain: number;
  readonly piGain: number;
  readonly dMaxGain: number;
  readonly feedforwardGain: number;
  readonly pitchPiGain: number;
}

export interface GeneratedAxisTune {
  readonly p: number;
  readonly i: number;
  readonly d: number;
  readonly f: number;
  readonly dMax: number;
}

export type PidOverwriteField =
  | 'ROLL.P' | 'ROLL.I' | 'ROLL.D' | 'ROLL.F' | 'ROLL.D_MAX'
  | 'PITCH.P' | 'PITCH.I' | 'PITCH.D' | 'PITCH.F' | 'PITCH.D_MAX'
  | 'YAW.P' | 'YAW.I' | 'YAW.D' | 'YAW.F' | 'YAW.D_MAX';

const AXIS_LABELS = ['ROLL', 'PITCH', 'YAW'] as const;

export interface SimplifiedPidGeneration {
  /** One entry per axis the mode actually generates. Empty when OFF. */
  readonly axes: readonly GeneratedAxisTune[];
  /** Exactly which stored fields this generation will replace. */
  readonly overwrites: readonly PidOverwriteField[];
}

/**
 * Project the PID half of simplified tuning.
 *
 * Pure. It is handed the defaults and the slider positions and returns what
 * the firmware would store - it never reads the board's current tune, because
 * the firmware does not either. Using the current values as a base is the
 * single most tempting wrong implementation of this function.
 */
export function generateSimplifiedPids(
  inputs: SimplifiedPidSliderInputs,
  defaults: SimplifiedGeneratorDefaults,
): SimplifiedPidGeneration {
  if (inputs.mode === 0) {
    return Object.freeze({axes: Object.freeze([]), overwrites: Object.freeze([])});
  }
  const master = inputs.masterMultiplier / 100;
  const pi = inputs.piGain / 100;
  const d = inputs.dGain / 100;
  const i = inputs.iGain / 100;
  const ff = inputs.feedforwardGain / 100;
  const dMaxGain = inputs.dMaxGain / 100;

  const axes: GeneratedAxisTune[] = [];
  const overwrites: PidOverwriteField[] = [];
  // mode 1 generates roll and pitch; mode 2 adds yaw. The firmware's loop
  // runs `axis <= simplified_pids_mode`, so the mode value IS the last axis.
  for (let axis = 0; axis <= inputs.mode; axis += 1) {
    const base = defaults.pid[axis];
    const dMaxDefault = defaults.dMax[axis];
    // Only pitch carries the two pitch-specific trims.
    const pitchD = axis === 1 ? inputs.rollPitchRatio / 100 : 1;
    const pitchPi = axis === 1 ? inputs.pitchPiGain / 100 : 1;

    const p = truncateThenClamp(base.p * master * pi * pitchPi, 0, defaults.pidGainMax);
    const iTerm = truncateThenClamp(base.i * master * pi * i * pitchPi, 0, defaults.pidGainMax);
    const dTerm = truncateThenClamp(base.d * master * d * pitchD, 0, defaults.pidGainMax);
    const f = truncateThenClamp(base.f * master * pitchPi * ff, 0, defaults.fGainMax);

    // A zero D Max default means the axis has no D Max at all - yaw. The
    // firmware still stores the (zero) result, so we report zero rather than
    // inventing a value from the roll/pitch shape.
    const dMaxScale = dMaxDefault > 0
      ? dMaxGain + (1 - dMaxGain) * (base.d / dMaxDefault)
      : 1;
    const dMax = truncateThenClamp(
      dMaxDefault * master * d * pitchD * dMaxScale,
      0,
      defaults.pidGainMax,
    );

    axes.push(Object.freeze({p, i: iTerm, d: dTerm, f, dMax}));
    const label = AXIS_LABELS[axis];
    overwrites.push(
      `${label}.P` as PidOverwriteField,
      `${label}.I` as PidOverwriteField,
      `${label}.D` as PidOverwriteField,
      `${label}.F` as PidOverwriteField,
      `${label}.D_MAX` as PidOverwriteField,
    );
  }
  return Object.freeze({axes: Object.freeze(axes), overwrites: Object.freeze(overwrites)});
}

/**
 * The frequencies a filter block currently holds. The generator needs them
 * because the firmware guards every assignment on the CURRENT value being
 * non-zero: a filter the operator has switched off stays off, and no
 * multiplier will bring it back.
 */
export interface ObservedFilterFrequencies {
  readonly lpf1StaticHz: number;
  readonly lpf2StaticHz: number;
  readonly lpf1DynMinHz: number;
  readonly lpf1DynMaxHz: number;
}

export interface GeneratedFilterFrequencies {
  readonly lpf1StaticHz: number;
  readonly lpf2StaticHz: number;
  readonly lpf1DynMinHz: number;
  readonly lpf1DynMaxHz: number;
  /** Which of the four the firmware would actually rewrite. */
  readonly overwrites: readonly (keyof ObservedFilterFrequencies)[];
}

function generateFilterBlock(
  enabled: boolean,
  multiplier: number,
  observed: ObservedFilterFrequencies,
  dynMinDefault: number,
  dynMaxDefault: number,
  lpf2Default: number,
  defaults: SimplifiedGeneratorDefaults,
): GeneratedFilterFrequencies {
  if (!enabled) {
    return Object.freeze({...observed, overwrites: Object.freeze([])});
  }
  const overwrites: (keyof ObservedFilterFrequencies)[] = [];
  // The dynamic pair is regenerated together, and only when the dynamic
  // minimum is currently non-zero - that is the firmware's own test for
  // "dynamic lowpass is in use here".
  const dynamicActive = observed.lpf1DynMinHz !== 0;
  const lpf1DynMinHz = dynamicActive
    ? scaleHz(dynMinDefault, multiplier, defaults.dynLpfMaxHz)
    : observed.lpf1DynMinHz;
  const lpf1DynMaxHz = dynamicActive
    ? scaleHz(dynMaxDefault, multiplier, defaults.dynLpfMaxHz)
    : observed.lpf1DynMaxHz;
  if (dynamicActive) overwrites.push('lpf1DynMinHz', 'lpf1DynMaxHz');

  const staticActive = observed.lpf1StaticHz !== 0;
  const lpf1StaticHz = staticActive
    ? scaleHz(dynMinDefault, multiplier, defaults.dynLpfMaxHz)
    : observed.lpf1StaticHz;
  if (staticActive) overwrites.push('lpf1StaticHz');

  const lpf2Active = observed.lpf2StaticHz !== 0;
  const lpf2StaticHz = lpf2Active
    ? scaleHz(lpf2Default, multiplier, defaults.lpfMaxHz)
    : observed.lpf2StaticHz;
  if (lpf2Active) overwrites.push('lpf2StaticHz');

  return Object.freeze({
    lpf1StaticHz,
    lpf2StaticHz,
    lpf1DynMinHz,
    lpf1DynMaxHz,
    overwrites: Object.freeze(overwrites),
  });
}

/** GLOBAL scope - these live in gyroConfig, not in the PID profile. */
export function generateSimplifiedGyroFilters(
  enabled: boolean,
  multiplier: number,
  observed: ObservedFilterFrequencies,
  defaults: SimplifiedGeneratorDefaults,
): GeneratedFilterFrequencies {
  return generateFilterBlock(
    enabled, multiplier, observed,
    defaults.gyroLpf1DynMinHz, defaults.gyroLpf1DynMaxHz, defaults.gyroLpf2Hz,
    defaults,
  );
}

/** PID-PROFILE scope - these live in the pid profile. */
export function generateSimplifiedDtermFilters(
  enabled: boolean,
  multiplier: number,
  observed: ObservedFilterFrequencies,
  defaults: SimplifiedGeneratorDefaults,
): GeneratedFilterFrequencies {
  return generateFilterBlock(
    enabled, multiplier, observed,
    defaults.dtermLpf1DynMinHz, defaults.dtermLpf1DynMaxHz, defaults.dtermLpf2Hz,
    defaults,
  );
}

/**
 * Turning the sliders off.
 *
 * The firmware clears the three enable flags and does NOTHING ELSE. It does
 * not remember what the tune was before generation, so there is nothing to
 * put back: whatever the generator last wrote stays as the direct values.
 * This function exists so that intent is written down and tested - an
 * implementation that "restores" anything here would be inventing a value the
 * flight controller never had.
 */
export interface SimplifiedDisableResult {
  readonly pidsMode: 0;
  readonly dtermFilterEnabled: false;
  readonly gyroFilterEnabled: false;
  readonly restoresPreviousValues: false;
}

export function disableSimplifiedTuning(): SimplifiedDisableResult {
  return Object.freeze({
    pidsMode: 0,
    dtermFilterEnabled: false,
    gyroFilterEnabled: false,
    restoresPreviousValues: false,
  });
}
