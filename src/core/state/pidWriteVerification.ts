import {
  classifyField,
  classifyGroup,
  projectDynamicLowpass,
  projectFilterLimit,
  projectGyroNotch,
  type FieldComparison,
  type GroupVerdict,
} from './pidNormalizationModel';
import {
  FILTER_CONFIG_OFFSETS,
  type MspFilterConfigFull,
} from '../protocol/msp/decoding/decodeFilterConfigFull';
import {TPA_RATE_MAX, type MspPidAdvanced} from '../protocol/msp/decoding/decodePidAdvancedFull';
import {
  projectRcTuningWrite,
  type MspRcTuningFull,
} from '../protocol/msp/decoding/decodeRcTuningFull';
import {
  classifySimplifiedPidsMode,
  type MspSimplifiedTuning,
} from '../protocol/msp/decoding/decodeSimplifiedTuning';
import {
  generateSimplifiedDtermFilters,
  generateSimplifiedGyroFilters,
  generateSimplifiedPids,
  simplifiedDefaultsFor,
  type PidOverwriteField,
  type SimplifiedGeneratorDefaults,
} from './simplifiedTuningGenerator';

/**
 * WHAT A READBACK ACTUALLY PROVES, FIELD BY FIELD.
 *
 * The controller's old contract compared a whole draft against a whole
 * readback and called any difference a failure. P-A found five places where
 * that is simply wrong about the firmware, and P-B built the vocabulary -
 * EXACT, NORMALISED, MISMATCH - to say so. This module is where that
 * vocabulary meets the actual payloads: it takes what was requested, what
 * the firmware's own rules predict, and what the board came back with, and
 * produces one verdict per group.
 *
 * Everything here is pure. The controller owns the wire; this owns the
 * question "did that work, and if the answer changed, was the change the
 * firmware's own documented behaviour or something we did not expect?"
 */

/* ------------------------------------------------------------------ */
/* Direct PID                                                          */
/* ------------------------------------------------------------------ */

/**
 * MSP_SET_PID stores what it is given, with no clamp and no derivation, so
 * every one of the fifteen bytes must come back exactly. LEVEL and MAG are
 * included deliberately: this screen does not edit them, which is precisely
 * why a save that quietly changed them has to fail.
 */
export function classifyPidReadback(
  requested: Uint8Array,
  observed: Uint8Array,
): GroupVerdict {
  const comparisons: FieldComparison[] = [];
  const labels = ['ROLL', 'PITCH', 'YAW', 'LEVEL', 'MAG'];
  const terms = ['P', 'I', 'D'];
  for (let index = 0; index < 15; index += 1) {
    const value = requested[index];
    comparisons.push({
      field: `${labels[Math.floor(index / 3)]}.${terms[index % 3]}`,
      // No rule can fire here, so `expected` is the request itself and any
      // difference is a mismatch by construction.
      verdict: classifyField(value, value, observed[index], 'SIMPLIFIED_REGENERATED'),
    });
  }
  return classifyGroup(comparisons);
}

/* ------------------------------------------------------------------ */
/* PID_ADVANCED                                                        */
/* ------------------------------------------------------------------ */

/** The advanced fields this app owns today. Unowned bytes are preserved by
 *  the encoder and are not part of the verdict. */
export interface OwnedAdvancedFields {
  readonly feedforward: readonly [number, number, number];
  readonly dMax: readonly [number, number, number];
  readonly dMaxGain: number;
  readonly tpaMode: number;
  readonly tpaRate: number;
  readonly tpaBreakpoint: number;
  readonly dynIdleMinRpm: number;
  readonly feedforwardAveraging: number;
  readonly feedforwardBoost: number;
  readonly feedforwardJitterFactor: number;
}

export function ownedAdvancedFields(advanced: MspPidAdvanced): OwnedAdvancedFields {
  return Object.freeze({
    feedforward: advanced.feedforward,
    dMax: advanced.dMax,
    dMaxGain: advanced.dMaxGain,
    tpaMode: advanced.tpaMode,
    tpaRate: advanced.tpaRate,
    tpaBreakpoint: advanced.tpaBreakpoint,
    dynIdleMinRpm: advanced.dynIdleMinRpm,
    feedforwardAveraging: advanced.feedforwardAveraging,
    feedforwardBoost: advanced.feedforwardBoost,
    feedforwardJitterFactor: advanced.feedforwardJitterFactor,
  });
}

/**
 * The one normalisation MSP_SET_PID_ADVANCED performs is the tpa_rate clamp.
 * Every other owned field is stored verbatim, so predicting it is predicting
 * the request.
 */
export function classifyAdvancedReadback(
  requested: OwnedAdvancedFields,
  observed: OwnedAdvancedFields,
): GroupVerdict {
  const comparisons: FieldComparison[] = [];
  const plain = (field: string, want: number, got: number): void => {
    comparisons.push({field, verdict: classifyField(want, want, got, 'SIMPLIFIED_REGENERATED')});
  };
  (['ROLL', 'PITCH', 'YAW'] as const).forEach((axis, index) => {
    plain(`${axis}.F`, requested.feedforward[index], observed.feedforward[index]);
    plain(`${axis}.D_MAX`, requested.dMax[index], observed.dMax[index]);
  });
  plain('dMaxGain', requested.dMaxGain, observed.dMaxGain);
  plain('tpaMode', requested.tpaMode, observed.tpaMode);
  comparisons.push({
    field: 'tpaRate',
    verdict: classifyField(
      requested.tpaRate,
      Math.min(requested.tpaRate, TPA_RATE_MAX),
      observed.tpaRate,
      'TPA_RATE_CLAMPED',
    ),
  });
  plain('tpaBreakpoint', requested.tpaBreakpoint, observed.tpaBreakpoint);
  plain('dynIdleMinRpm', requested.dynIdleMinRpm, observed.dynIdleMinRpm);
  plain('feedforwardAveraging', requested.feedforwardAveraging, observed.feedforwardAveraging);
  plain('feedforwardBoost', requested.feedforwardBoost, observed.feedforwardBoost);
  plain('feedforwardJitterFactor', requested.feedforwardJitterFactor, observed.feedforwardJitterFactor);
  return classifyGroup(comparisons);
}

/* ------------------------------------------------------------------ */
/* RC_TUNING                                                           */
/* ------------------------------------------------------------------ */

/**
 * Rates come back exactly, except that pitch may have followed roll through
 * the firmware's legacy linkage. `projectRcTuningWrite` decides whether that
 * rule fires for THIS board's stored state, so a pitch that moved on a
 * linked board is NORMALISED while the same movement on an unlinked board is
 * a mismatch.
 */
export function classifyRcTuningReadback(
  base: MspRcTuningFull,
  requested: MspRcTuningFull,
  observed: MspRcTuningFull,
): GroupVerdict {
  const projection = projectRcTuningWrite(base, {
    rcRate: requested.rcRate,
    expo: requested.expo,
  });
  const comparisons: FieldComparison[] = [];
  const axes = ['ROLL', 'PITCH', 'YAW'] as const;
  axes.forEach((axis, index) => {
    comparisons.push({
      field: `${axis}.rcRate`,
      verdict: classifyField(
        requested.rcRate[index],
        projection.rcRate[index],
        observed.rcRate[index],
        'RC_TUNING_PITCH_FOLLOWED_ROLL',
      ),
    });
    comparisons.push({
      field: `${axis}.expo`,
      verdict: classifyField(
        requested.expo[index],
        projection.expo[index],
        observed.expo[index],
        'RC_TUNING_PITCH_FOLLOWED_ROLL',
      ),
    });
    const superRate = requested.superRate[index];
    comparisons.push({
      field: `${axis}.superRate`,
      verdict: classifyField(superRate, superRate, observed.superRate[index], 'RC_TUNING_PITCH_FOLLOWED_ROLL'),
    });
    const limit = requested.rateLimit[index];
    comparisons.push({
      field: `${axis}.rateLimit`,
      verdict: classifyField(limit, limit, observed.rateLimit[index], 'RC_TUNING_PITCH_FOLLOWED_ROLL'),
    });
  });
  const plain = (field: string, want: number, got: number): void => {
    comparisons.push({field, verdict: classifyField(want, want, got, 'RC_TUNING_PITCH_FOLLOWED_ROLL')});
  };
  plain('ratesType', requested.ratesTypeRaw, observed.ratesTypeRaw);
  plain('throttleMid', requested.throttleMid, observed.throttleMid);
  plain('throttleExpo', requested.throttleExpo, observed.throttleExpo);
  plain('throttleHover', requested.throttleHover, observed.throttleHover);
  plain('throttleLimitType', requested.throttleLimitType, observed.throttleLimitType);
  plain('throttleLimitPercent', requested.throttleLimitPercent, observed.throttleLimitPercent);
  return classifyGroup(comparisons);
}

/* ------------------------------------------------------------------ */
/* FILTER_CONFIG                                                       */
/* ------------------------------------------------------------------ */

/** The filter fields this app owns, split by the scope that owns them. */
export interface OwnedFilterFields {
  readonly gyroLpf1StaticHz: number;
  readonly gyroLpf1DynMinHz: number;
  readonly gyroLpf1DynMaxHz: number;
  readonly gyroSoftNotchHz1: number;
  readonly gyroSoftNotchCutoff1: number;
  readonly dtermLpf1StaticHz: number;
  readonly dtermLpf1DynMinHz: number;
  readonly dtermLpf1DynMaxHz: number;
  readonly dynamicNotchQ: number;
  readonly dynamicNotchMinHz: number;
  readonly dynamicNotchMaxHz: number;
  readonly dynamicNotchCount: number;
}

export function ownedFilterFields(filters: MspFilterConfigFull): OwnedFilterFields {
  return Object.freeze({
    gyroLpf1StaticHz: filters.gyroLpf1StaticHz,
    gyroLpf1DynMinHz: filters.gyroLpf1DynMinHz,
    gyroLpf1DynMaxHz: filters.gyroLpf1DynMaxHz,
    gyroSoftNotchHz1: filters.gyroSoftNotchHz1,
    gyroSoftNotchCutoff1: filters.gyroSoftNotchCutoff1,
    dtermLpf1StaticHz: filters.dtermLpf1StaticHz,
    dtermLpf1DynMinHz: filters.dtermLpf1DynMinHz,
    dtermLpf1DynMaxHz: filters.dtermLpf1DynMaxHz,
    dynamicNotchQ: filters.dynNotchQ,
    dynamicNotchMinHz: filters.dynNotchMinHz,
    dynamicNotchMaxHz: filters.dynNotchMaxHz,
    dynamicNotchCount: filters.dynNotchCount,
  });
}

/**
 * Predict what the firmware's gyro validation will leave behind.
 *
 * Only the rules P-A proved are modelled - the ceiling reset with its
 * per-field reset value, the notch disabled by its own cutoff, and the
 * dynamic minimum above its maximum. This is deliberately not a port of the
 * whole validation routine; it is the minimum needed to read a readback
 * honestly.
 */
export function projectFilterWrite(requested: OwnedFilterFields): OwnedFilterFields {
  const notch = projectGyroNotch({
    centreHz: requested.gyroSoftNotchHz1,
    cutoffHz: requested.gyroSoftNotchCutoff1,
  });
  const gyroDynamic = projectDynamicLowpass({
    minHz: requested.gyroLpf1DynMinHz,
    maxHz: requested.gyroLpf1DynMaxHz,
  });
  return Object.freeze({
    gyroLpf1StaticHz: projectFilterLimit(requested.gyroLpf1StaticHz, 1000),
    gyroLpf1DynMinHz: gyroDynamic.minHz,
    gyroLpf1DynMaxHz: gyroDynamic.maxHz,
    gyroSoftNotchHz1: notch.centreHz,
    gyroSoftNotchCutoff1: notch.cutoffHz,
    dtermLpf1StaticHz: projectFilterLimit(requested.dtermLpf1StaticHz, 1000),
    dtermLpf1DynMinHz: requested.dtermLpf1DynMinHz,
    dtermLpf1DynMaxHz: requested.dtermLpf1DynMaxHz,
    dynamicNotchQ: requested.dynamicNotchQ,
    dynamicNotchMinHz: requested.dynamicNotchMinHz,
    dynamicNotchMaxHz: requested.dynamicNotchMaxHz,
    dynamicNotchCount: requested.dynamicNotchCount,
  });
}

export function classifyFilterReadback(
  requested: OwnedFilterFields,
  observed: OwnedFilterFields,
): GroupVerdict {
  const expected = projectFilterWrite(requested);
  const rules: Readonly<Record<keyof OwnedFilterFields, Parameters<typeof classifyField>[3]>> = {
    gyroLpf1StaticHz: 'FILTER_LIMIT_RESET',
    gyroLpf1DynMinHz: 'DYNAMIC_MIN_ABOVE_MAX',
    gyroLpf1DynMaxHz: 'FILTER_LIMIT_RESET',
    gyroSoftNotchHz1: 'NOTCH_DISABLED_BY_CUTOFF',
    gyroSoftNotchCutoff1: 'FILTER_LIMIT_RESET',
    dtermLpf1StaticHz: 'FILTER_LIMIT_RESET',
    dtermLpf1DynMinHz: 'DYNAMIC_MIN_ABOVE_MAX',
    dtermLpf1DynMaxHz: 'FILTER_LIMIT_RESET',
    dynamicNotchQ: 'FILTER_LIMIT_RESET',
    dynamicNotchMinHz: 'FILTER_LIMIT_RESET',
    dynamicNotchMaxHz: 'FILTER_LIMIT_RESET',
    dynamicNotchCount: 'FILTER_LIMIT_RESET',
  };
  const comparisons = (Object.keys(rules) as (keyof OwnedFilterFields)[]).map(field => ({
    field,
    verdict: classifyField(requested[field], expected[field], observed[field], rules[field]),
  }));
  return classifyGroup(comparisons);
}

/* ------------------------------------------------------------------ */
/* Cross-subsystem side effects                                        */
/* ------------------------------------------------------------------ */

/** The three MSP_ADVANCED_CONFIG fields a filter write can move. */
export interface AdvancedConfigWitness {
  readonly pidProcessDenom: number;
  readonly motorProtocolRaw: number;
  readonly motorPwmRate: number;
}

export type CrossSubsystemTruth = 'PID_PROCESS_DENOM' | 'MOTOR_PROTOCOL' | 'MOTOR_PWM_RATE';

export interface CrossSubsystemChange {
  readonly truth: CrossSubsystemTruth;
  readonly before: number;
  readonly after: number;
  /** True when the firmware's own documented validation explains it. */
  readonly expected: boolean;
}

export interface CrossSubsystemReport {
  readonly changes: readonly CrossSubsystemChange[];
  readonly unexpected: readonly CrossSubsystemChange[];
  /** Truths a caller must treat as stale, whether expected or not. */
  readonly requiresReobserve: readonly CrossSubsystemTruth[];
}

/** Betaflight's motorProtocolTypes_e: DSHOT300 = 5, DSHOT600 = 6. */
export const MOTOR_PROTOCOL_DSHOT300 = 5;
export const MOTOR_PROTOCOL_DSHOT600 = 6;

/**
 * Compare the advanced configuration either side of a filter write.
 *
 * The firmware's gyro validation may RAISE pid_process_denom, downgrade
 * DSHOT600 to DSHOT300, and LOWER the motor PWM rate. Those three directions
 * are what "expected" means here - a denom that fell, a protocol that
 * changed to anything else, or a PWM rate that rose is not something the
 * source predicts, and a caller must not report it as success.
 */
export function classifyAdvancedConfigSideEffects(
  before: AdvancedConfigWitness,
  after: AdvancedConfigWitness,
): CrossSubsystemReport {
  const changes: CrossSubsystemChange[] = [];
  if (after.pidProcessDenom !== before.pidProcessDenom) {
    changes.push({
      truth: 'PID_PROCESS_DENOM',
      before: before.pidProcessDenom,
      after: after.pidProcessDenom,
      expected: after.pidProcessDenom > before.pidProcessDenom,
    });
  }
  if (after.motorProtocolRaw !== before.motorProtocolRaw) {
    changes.push({
      truth: 'MOTOR_PROTOCOL',
      before: before.motorProtocolRaw,
      after: after.motorProtocolRaw,
      expected:
        before.motorProtocolRaw === MOTOR_PROTOCOL_DSHOT600 &&
        after.motorProtocolRaw === MOTOR_PROTOCOL_DSHOT300,
    });
  }
  if (after.motorPwmRate !== before.motorPwmRate) {
    changes.push({
      truth: 'MOTOR_PWM_RATE',
      before: before.motorPwmRate,
      after: after.motorPwmRate,
      expected: after.motorPwmRate < before.motorPwmRate,
    });
  }
  return Object.freeze({
    changes: Object.freeze(changes),
    unexpected: Object.freeze(changes.filter(change => !change.expected)),
    requiresReobserve: Object.freeze(changes.map(change => change.truth)),
  });
}

/* ------------------------------------------------------------------ */
/* Simplified tuning                                                   */
/* ------------------------------------------------------------------ */

/** Which direct fields the board's CURRENT simplified state owns. */
export function simplifiedOwnedFields(simplified: MspSimplifiedTuning): readonly PidOverwriteField[] {
  const mode = classifySimplifiedPidsMode(simplified.pids.modeRaw);
  if (mode.kind !== 'RP' && mode.kind !== 'RPY') return Object.freeze([]);
  const generated = generateSimplifiedPids(
    {
      mode: mode.kind === 'RP' ? 1 : 2,
      masterMultiplier: simplified.pids.masterMultiplier,
      rollPitchRatio: simplified.pids.rollPitchRatio,
      iGain: simplified.pids.iGain,
      dGain: simplified.pids.dGain,
      piGain: simplified.pids.piGain,
      dMaxGain: simplified.pids.dMaxGain,
      feedforwardGain: simplified.pids.feedforwardGain,
      pitchPiGain: simplified.pids.pitchPiGain,
    },
    simplifiedDefaultsFor('API_1_47'),
  );
  return generated.overwrites;
}

export interface SimplifiedConflict {
  readonly kind: 'DIRECT_EDIT_CONFLICTS_WITH_ACTIVE_SIMPLIFIED';
  readonly generatorOwnedFields: readonly string[];
  readonly conflictingEdits: readonly string[];
}

/**
 * Refuse a direct edit that the generator would immediately undo.
 *
 * With simplified PID tuning active the firmware regenerates P, I, D,
 * feedforward and D Max on the generated axes from the sliders. A manual
 * value typed into one of those fields does not lose a race - it is
 * overwritten by design, and telling the operator it was saved would be a
 * lie. So the controller refuses before the wire and names the fields the
 * generator owns.
 */
export function detectSimplifiedConflict(
  editedFields: readonly string[],
  simplified: MspSimplifiedTuning,
  filterEdits: readonly string[] = [],
): SimplifiedConflict | undefined {
  const owned = new Set<string>(simplifiedOwnedFields(simplified));
  if (simplified.dterm.enabled) {
    owned.add('dtermLpf1StaticHz');
    owned.add('dtermLpf1DynMinHz');
    owned.add('dtermLpf1DynMaxHz');
  }
  if (simplified.gyro.enabled) {
    owned.add('gyroLpf1StaticHz');
    owned.add('gyroLpf1DynMinHz');
    owned.add('gyroLpf1DynMaxHz');
  }
  const conflicting = [...editedFields, ...filterEdits].filter(field => owned.has(field));
  if (conflicting.length === 0) return undefined;
  return Object.freeze({
    kind: 'DIRECT_EDIT_CONFLICTS_WITH_ACTIVE_SIMPLIFIED',
    generatorOwnedFields: Object.freeze([...owned]),
    conflictingEdits: Object.freeze(conflicting),
  });
}

/** Everything a simplified write is expected to leave on the board. */
export interface SimplifiedProjection {
  readonly axes: readonly {readonly p: number; readonly i: number; readonly d: number; readonly f: number; readonly dMax: number}[];
  readonly gyroHz: {readonly lpf1StaticHz: number; readonly lpf2StaticHz: number; readonly lpf1DynMinHz: number; readonly lpf1DynMaxHz: number};
  readonly dtermHz: {readonly lpf1StaticHz: number; readonly lpf2StaticHz: number; readonly lpf1DynMinHz: number; readonly lpf1DynMaxHz: number};
  readonly overwrites: readonly PidOverwriteField[];
}

export function projectSimplifiedWrite(
  requested: MspSimplifiedTuning,
  defaults: SimplifiedGeneratorDefaults = simplifiedDefaultsFor('API_1_47'),
): SimplifiedProjection {
  const mode = classifySimplifiedPidsMode(requested.pids.modeRaw);
  const numericMode = mode.kind === 'RP' ? 1 : mode.kind === 'RPY' ? 2 : 0;
  const pids = generateSimplifiedPids(
    {
      mode: numericMode as 0 | 1 | 2,
      masterMultiplier: requested.pids.masterMultiplier,
      rollPitchRatio: requested.pids.rollPitchRatio,
      iGain: requested.pids.iGain,
      dGain: requested.pids.dGain,
      piGain: requested.pids.piGain,
      dMaxGain: requested.pids.dMaxGain,
      feedforwardGain: requested.pids.feedforwardGain,
      pitchPiGain: requested.pids.pitchPiGain,
    },
    defaults,
  );
  const gyro = generateSimplifiedGyroFilters(
    requested.gyro.enabled, requested.gyro.multiplier, requested.gyro.effectiveHz, defaults,
  );
  const dterm = generateSimplifiedDtermFilters(
    requested.dterm.enabled, requested.dterm.multiplier, requested.dterm.effectiveHz, defaults,
  );
  return Object.freeze({
    axes: pids.axes,
    gyroHz: Object.freeze({
      lpf1StaticHz: gyro.lpf1StaticHz,
      lpf2StaticHz: gyro.lpf2StaticHz,
      lpf1DynMinHz: gyro.lpf1DynMinHz,
      lpf1DynMaxHz: gyro.lpf1DynMaxHz,
    }),
    dtermHz: Object.freeze({
      lpf1StaticHz: dterm.lpf1StaticHz,
      lpf2StaticHz: dterm.lpf2StaticHz,
      lpf1DynMinHz: dterm.lpf1DynMinHz,
      lpf1DynMaxHz: dterm.lpf1DynMaxHz,
    }),
    overwrites: pids.overwrites,
  });
}

export interface SimplifiedReadbackInput {
  readonly requested: MspSimplifiedTuning;
  readonly observedSimplified: MspSimplifiedTuning;
  readonly observedPid: Uint8Array;
  readonly observedAdvanced: MspPidAdvanced;
  readonly observedFilters: MspFilterConfigFull;
}

/**
 * The five-way check a simplified write needs.
 *
 * The thirteen inputs must echo EXACTLY - they are stored verbatim. The
 * generated outputs must equal what our own reimplementation of the firmware
 * generator predicts. Both halves are required: an input echo alone proves
 * only that the board filed the sliders, and the firmware's VALIDATE opinion
 * is captured separately by the caller because it compares against a
 * temporary copy and says nothing about what was stored.
 */
export function classifySimplifiedReadback(input: SimplifiedReadbackInput): GroupVerdict {
  const projection = projectSimplifiedWrite(input.requested);
  const comparisons: FieldComparison[] = [];
  const echo = (field: string, want: number, got: number): void => {
    comparisons.push({field, verdict: classifyField(want, want, got, 'SIMPLIFIED_REGENERATED')});
  };
  const wantPids = input.requested.pids;
  const gotPids = input.observedSimplified.pids;
  echo('simplified.mode', wantPids.modeRaw, gotPids.modeRaw);
  echo('simplified.masterMultiplier', wantPids.masterMultiplier, gotPids.masterMultiplier);
  echo('simplified.rollPitchRatio', wantPids.rollPitchRatio, gotPids.rollPitchRatio);
  echo('simplified.iGain', wantPids.iGain, gotPids.iGain);
  echo('simplified.dGain', wantPids.dGain, gotPids.dGain);
  echo('simplified.piGain', wantPids.piGain, gotPids.piGain);
  echo('simplified.dMaxGain', wantPids.dMaxGain, gotPids.dMaxGain);
  echo('simplified.feedforwardGain', wantPids.feedforwardGain, gotPids.feedforwardGain);
  echo('simplified.pitchPiGain', wantPids.pitchPiGain, gotPids.pitchPiGain);
  echo('simplified.dtermEnabled', input.requested.dterm.enabledRaw, input.observedSimplified.dterm.enabledRaw);
  echo('simplified.dtermMultiplier', input.requested.dterm.multiplier, input.observedSimplified.dterm.multiplier);
  echo('simplified.gyroEnabled', input.requested.gyro.enabledRaw, input.observedSimplified.gyro.enabledRaw);
  echo('simplified.gyroMultiplier', input.requested.gyro.multiplier, input.observedSimplified.gyro.multiplier);

  // The generated outputs. `expected` is the projection, and `requested` is
  // the projection too - the operator did not ask for these numbers, the
  // generator did, so there is no separate request to be exact against.
  const axes = ['ROLL', 'PITCH', 'YAW'] as const;
  projection.axes.forEach((axis, index) => {
    const observedP = input.observedPid[index * 3];
    const observedI = input.observedPid[index * 3 + 1];
    const observedD = input.observedPid[index * 3 + 2];
    comparisons.push({field: `${axes[index]}.P`, verdict: classifyField(axis.p, axis.p, observedP, 'SIMPLIFIED_REGENERATED')});
    comparisons.push({field: `${axes[index]}.I`, verdict: classifyField(axis.i, axis.i, observedI, 'SIMPLIFIED_REGENERATED')});
    comparisons.push({field: `${axes[index]}.D`, verdict: classifyField(axis.d, axis.d, observedD, 'SIMPLIFIED_REGENERATED')});
    comparisons.push({
      field: `${axes[index]}.F`,
      verdict: classifyField(axis.f, axis.f, input.observedAdvanced.feedforward[index], 'SIMPLIFIED_REGENERATED'),
    });
    comparisons.push({
      field: `${axes[index]}.D_MAX`,
      verdict: classifyField(axis.dMax, axis.dMax, input.observedAdvanced.dMax[index], 'SIMPLIFIED_REGENERATED'),
    });
  });

  if (input.requested.gyro.enabled) {
    const want = projection.gyroHz;
    comparisons.push({field: 'gyroLpf1StaticHz', verdict: classifyField(want.lpf1StaticHz, want.lpf1StaticHz, input.observedFilters.gyroLpf1StaticHz, 'SIMPLIFIED_REGENERATED')});
    comparisons.push({field: 'gyroLpf1DynMinHz', verdict: classifyField(want.lpf1DynMinHz, want.lpf1DynMinHz, input.observedFilters.gyroLpf1DynMinHz, 'SIMPLIFIED_REGENERATED')});
    comparisons.push({field: 'gyroLpf1DynMaxHz', verdict: classifyField(want.lpf1DynMaxHz, want.lpf1DynMaxHz, input.observedFilters.gyroLpf1DynMaxHz, 'SIMPLIFIED_REGENERATED')});
  }
  if (input.requested.dterm.enabled) {
    const want = projection.dtermHz;
    comparisons.push({field: 'dtermLpf1StaticHz', verdict: classifyField(want.lpf1StaticHz, want.lpf1StaticHz, input.observedFilters.dtermLpf1StaticHz, 'SIMPLIFIED_REGENERATED')});
    comparisons.push({field: 'dtermLpf1DynMinHz', verdict: classifyField(want.lpf1DynMinHz, want.lpf1DynMinHz, input.observedFilters.dtermLpf1DynMinHz, 'SIMPLIFIED_REGENERATED')});
    comparisons.push({field: 'dtermLpf1DynMaxHz', verdict: classifyField(want.lpf1DynMaxHz, want.lpf1DynMaxHz, input.observedFilters.dtermLpf1DynMaxHz, 'SIMPLIFIED_REGENERATED')});
  }
  return classifyGroup(comparisons);
}

export {FILTER_CONFIG_OFFSETS};
