import {
  classifyExactField,
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
      // No firmware rule touches these bytes, so any difference at all is
      // a mismatch. Naming a rule here would have been fiction.
      verdict: classifyExactField(value, observed[index]),
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
  /* ---- added by P-E, once the screen could actually write them ----- */
  readonly dMaxAdvance: number;
  readonly feedforwardTransition: number;
  readonly feedforwardSmoothFactor: number;
  readonly feedforwardMaxRateLimit: number;
  readonly itermRelax: number;
  readonly itermRelaxType: number;
  readonly itermRelaxCutoff: number;
  readonly itermRotation: number;
  readonly antiGravityGain: number;
  readonly throttleBoost: number;
  readonly thrustLinearization: number;
  readonly vbatSagCompensation: number;
  readonly motorOutputLimit: number;
  readonly angleLimit: number;
  readonly acroTrainerAngleLimit: number;
  readonly rateAccelLimit: number;
  readonly yawRateAccelLimit: number;
  readonly autoProfileCellCount: number;
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
    dMaxAdvance: advanced.dMaxAdvance,
    feedforwardTransition: advanced.feedforwardTransition,
    feedforwardSmoothFactor: advanced.feedforwardSmoothFactor,
    feedforwardMaxRateLimit: advanced.feedforwardMaxRateLimit,
    itermRelax: advanced.itermRelax,
    itermRelaxType: advanced.itermRelaxType,
    itermRelaxCutoff: advanced.itermRelaxCutoff,
    itermRotation: advanced.itermRotation,
    antiGravityGain: advanced.antiGravityGain,
    throttleBoost: advanced.throttleBoost,
    thrustLinearization: advanced.thrustLinearization,
    vbatSagCompensation: advanced.vbatSagCompensation,
    motorOutputLimit: advanced.motorOutputLimit,
    angleLimit: advanced.angleLimit,
    acroTrainerAngleLimit: advanced.acroTrainerAngleLimit,
    rateAccelLimit: advanced.rateAccelLimit,
    yawRateAccelLimit: advanced.yawRateAccelLimit,
    autoProfileCellCount: advanced.autoProfileCellCount,
  });
}

/**
 * The one normalisation MSP_SET_PID_ADVANCED performs is the tpa_rate clamp.
 * Every other owned field is stored verbatim, so predicting it is predicting
 * the request.
 *
 * RE-CONFIRMED AT THE PINNED FIRMWARE TREE for the fields P-E added:
 * msp.c's `MSP_SET_PID_ADVANCED` case assigns each one straight from the
 * buffer. Its only value-changing step is `MIN(sbufReadU8(src), TPA_MAX)`
 * on tpa_rate, and its only other guard is a hard refusal - a
 * feedforward_averaging above 3 returns MSP_RESULT_ERROR and NOTHING in
 * the message is stored. That is a rejected write, not a normalisation,
 * which is why it is kept out of range by validation rather than modelled
 * here.
 *
 * A FIELD THE BOARD'S BUILD OMITS reads its byte and throws it away
 * (`#else sbufReadU8(src);`), so the readback returns the old value and
 * this classifier reports MISMATCH. That is the honest verdict: MSP gives
 * no way to distinguish "your build lacks this feature" from "the write
 * did not land", and naming a firmware rule that did not run would be
 * fiction. The save stops instead of claiming success.
 */
export function classifyAdvancedReadback(
  requested: OwnedAdvancedFields,
  observed: OwnedAdvancedFields,
): GroupVerdict {
  const comparisons: FieldComparison[] = [];
  const plain = (field: string, want: number, got: number): void => {
    comparisons.push({field, verdict: classifyExactField(want, got)});
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
  plain('dMaxAdvance', requested.dMaxAdvance, observed.dMaxAdvance);
  plain('feedforwardTransition', requested.feedforwardTransition, observed.feedforwardTransition);
  plain('feedforwardSmoothFactor', requested.feedforwardSmoothFactor, observed.feedforwardSmoothFactor);
  plain('feedforwardMaxRateLimit', requested.feedforwardMaxRateLimit, observed.feedforwardMaxRateLimit);
  plain('itermRelax', requested.itermRelax, observed.itermRelax);
  plain('itermRelaxType', requested.itermRelaxType, observed.itermRelaxType);
  plain('itermRelaxCutoff', requested.itermRelaxCutoff, observed.itermRelaxCutoff);
  plain('itermRotation', requested.itermRotation, observed.itermRotation);
  plain('antiGravityGain', requested.antiGravityGain, observed.antiGravityGain);
  plain('throttleBoost', requested.throttleBoost, observed.throttleBoost);
  plain('thrustLinearization', requested.thrustLinearization, observed.thrustLinearization);
  plain('vbatSagCompensation', requested.vbatSagCompensation, observed.vbatSagCompensation);
  plain('motorOutputLimit', requested.motorOutputLimit, observed.motorOutputLimit);
  plain('angleLimit', requested.angleLimit, observed.angleLimit);
  plain('acroTrainerAngleLimit', requested.acroTrainerAngleLimit, observed.acroTrainerAngleLimit);
  plain('rateAccelLimit', requested.rateAccelLimit, observed.rateAccelLimit);
  plain('yawRateAccelLimit', requested.yawRateAccelLimit, observed.yawRateAccelLimit);
  plain('autoProfileCellCount', requested.autoProfileCellCount, observed.autoProfileCellCount);
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
      verdict: classifyExactField(projection.rcRate[index], observed.rcRate[index]),
    });
    comparisons.push({
      field: `${axis}.expo`,
      verdict: classifyExactField(projection.expo[index], observed.expo[index]),
    });
    const superRate = requested.superRate[index];
    comparisons.push({
      field: `${axis}.superRate`,
      verdict: classifyExactField(superRate, observed.superRate[index]),
    });
    const limit = requested.rateLimit[index];
    comparisons.push({
      field: `${axis}.rateLimit`,
      verdict: classifyExactField(limit, observed.rateLimit[index]),
    });
  });
  const plain = (field: string, want: number, got: number): void => {
    comparisons.push({field, verdict: classifyExactField(want, got)});
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
  /* ---- added by P-E ------------------------------------------------ */
  readonly gyroLpf1Type: number;
  readonly gyroLpf2StaticHz: number;
  readonly gyroLpf2Type: number;
  readonly gyroSoftNotchHz2: number;
  readonly gyroSoftNotchCutoff2: number;
  readonly dtermLpf1Type: number;
  readonly dtermLpf1DynExpo: number;
  readonly dtermLpf2StaticHz: number;
  readonly dtermLpf2Type: number;
  readonly dtermNotchHz: number;
  readonly dtermNotchCutoff: number;
  readonly yawLowpassHz: number;
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
    gyroLpf1Type: filters.gyroLpf1Type,
    gyroLpf2StaticHz: filters.gyroLpf2StaticHz,
    gyroLpf2Type: filters.gyroLpf2Type,
    gyroSoftNotchHz2: filters.gyroSoftNotchHz2,
    gyroSoftNotchCutoff2: filters.gyroSoftNotchCutoff2,
    dtermLpf1Type: filters.dtermLpf1Type,
    dtermLpf1DynExpo: filters.dtermLpf1DynExpo,
    dtermLpf2StaticHz: filters.dtermLpf2StaticHz,
    dtermLpf2Type: filters.dtermLpf2Type,
    dtermNotchHz: filters.dtermNotchHz,
    dtermNotchCutoff: filters.dtermNotchCutoff,
    yawLowpassHz: filters.yawLowpassHz,
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
 *
 * WHICH FIELDS THAT ROUTINE ACTUALLY REACHES, at the pinned tree:
 * `MSP_SET_FILTER_CONFIG` calls `validateAndFixGyroConfig()` and nothing
 * else, and that function touches ONLY gyro-scope values - the two static
 * lowpasses, BOTH notches, and the dynamic minimum. The D-term chain has
 * the same-shaped corrections, but they live in `validateAndFixConfig()`,
 * which an MSP filter write never calls; it runs at EEPROM write and at
 * boot. So a D-term field reads back EXACT here, and the only way to be
 * honest about the later correction is to refuse to create the condition
 * in the first place - which is what `validatePidTuningDraft` does for a
 * D-term notch whose cutoff has swallowed its centre.
 */
export function projectFilterWrite(requested: OwnedFilterFields): OwnedFilterFields {
  const notch = projectGyroNotch({
    centreHz: requested.gyroSoftNotchHz1,
    cutoffHz: requested.gyroSoftNotchCutoff1,
  });
  /* The SECOND gyro notch gets the identical treatment, because the
     firmware gives it the identical two lines - `adjustFilterLimit` on
     both halves and `if (cutoff_2 >= hz_2) hz_2 = 0`. Reusing the same
     projection is what keeps the two notches from drifting apart. */
  const notch2 = projectGyroNotch({
    centreHz: requested.gyroSoftNotchHz2,
    cutoffHz: requested.gyroSoftNotchCutoff2,
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
    gyroLpf2StaticHz: projectFilterLimit(requested.gyroLpf2StaticHz, 1000),
    gyroSoftNotchHz2: notch2.centreHz,
    gyroSoftNotchCutoff2: notch2.cutoffHz,
    /* Everything below is returned UNCHANGED because the firmware returns
       it unchanged: the lowpass TYPES are enumerations no validation
       rewrites, and the whole D-term group is out of
       `validateAndFixGyroConfig`'s reach - see this function's header. */
    gyroLpf1Type: requested.gyroLpf1Type,
    gyroLpf2Type: requested.gyroLpf2Type,
    dtermLpf1Type: requested.dtermLpf1Type,
    dtermLpf1DynExpo: requested.dtermLpf1DynExpo,
    dtermLpf2StaticHz: requested.dtermLpf2StaticHz,
    dtermLpf2Type: requested.dtermLpf2Type,
    dtermNotchHz: requested.dtermNotchHz,
    dtermNotchCutoff: requested.dtermNotchCutoff,
    yawLowpassHz: requested.yawLowpassHz,
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
    gyroLpf2StaticHz: 'FILTER_LIMIT_RESET',
    gyroSoftNotchHz2: 'NOTCH_DISABLED_BY_CUTOFF',
    gyroSoftNotchCutoff2: 'FILTER_LIMIT_RESET',
    /* No firmware rule reaches these on an MSP filter write, so a
       difference has no name and must not be given one. The rule label is
       only consulted when the projection differs from the request, and for
       these the projection IS the request - so every one of them can only
       land as EXACT or MISMATCH. */
    gyroLpf1Type: 'FILTER_LIMIT_RESET',
    gyroLpf2Type: 'FILTER_LIMIT_RESET',
    dtermLpf1Type: 'FILTER_LIMIT_RESET',
    dtermLpf1DynExpo: 'FILTER_LIMIT_RESET',
    dtermLpf2StaticHz: 'FILTER_LIMIT_RESET',
    dtermLpf2Type: 'FILTER_LIMIT_RESET',
    dtermNotchHz: 'FILTER_LIMIT_RESET',
    dtermNotchCutoff: 'FILTER_LIMIT_RESET',
    yawLowpassHz: 'FILTER_LIMIT_RESET',
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

/**
 * THE CROSS-SUBSYSTEM MODEL LIVES IN ITS OWN MODULE NOW.
 *
 * It used to live here and classified by DIRECTION: any denominator that
 * rose, any PWM rate that fell, any change to DSHOT300 was called
 * "expected". That is not a readback verification - a board answering
 * `pid_process_denom = 8` where the rule predicts 2 would have passed - so it
 * was replaced by an exact value projection computed before the write.
 *
 * Re-exported so callers keep one import site for write verification.
 */
export {
  classifyGyroValidationSideEffects,
  motorUpdateRestrictionSeconds,
  profileIndexRepairPossible,
  projectGyroValidation,
  BRUSHLESS_MOTORS_PWM_RATE,
  MAX_PID_PROCESS_DENOM,
  PID_DENOM_FORCE_SAMPLE_RATE_HZ,
  type AdvancedConfigWitness,
  type CrossSubsystemEntry,
  type CrossSubsystemReport,
  type CrossSubsystemTruth,
  type CrossSubsystemVerdict,
  type GyroValidationInputs,
  type GyroValidationProjection,
  type SideEffectPrediction,
  type SideEffectUnknownReason,
} from './filterSideEffectProjection';

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
    owned.add('dtermLpf2StaticHz');
  }
  if (simplified.gyro.enabled) {
    owned.add('gyroLpf1StaticHz');
    owned.add('gyroLpf1DynMinHz');
    owned.add('gyroLpf1DynMaxHz');
    owned.add('gyroLpf2StaticHz');
  }
  /*
   * THE SECOND LOWPASS IS GENERATOR-OWNED TOO, which only became reachable
   * in P-E when the expert tier started offering it. `generateFilterBlock`
   * rescales lpf2 from the multiplier on every simplified write, exactly
   * as it does lpf1.
   *
   * DELIBERATELY CONSERVATIVE, and in the same way the three lpf1 entries
   * above already are: the generator skips a block whose CURRENT value is
   * zero, so an edit that switches lpf2 off would in fact survive. This
   * function is handed field names, not values, and would have to be given
   * the proposed numbers to draw that line. Refusing the edit costs the
   * operator one step - disable the simplified group first - while
   * allowing it would risk reporting a value saved that the next
   * regeneration silently replaces.
   */
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
    comparisons.push({field, verdict: classifyExactField(want, got)});
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
    comparisons.push({field: `${axes[index]}.P`, verdict: classifyExactField(axis.p, observedP)});
    comparisons.push({field: `${axes[index]}.I`, verdict: classifyExactField(axis.i, observedI)});
    comparisons.push({field: `${axes[index]}.D`, verdict: classifyExactField(axis.d, observedD)});
    comparisons.push({
      field: `${axes[index]}.F`,
      verdict: classifyExactField(axis.f, input.observedAdvanced.feedforward[index]),
    });
    comparisons.push({
      field: `${axes[index]}.D_MAX`,
      verdict: classifyExactField(axis.dMax, input.observedAdvanced.dMax[index]),
    });
  });

  if (input.requested.gyro.enabled) {
    const want = projection.gyroHz;
    comparisons.push({field: 'gyroLpf1StaticHz', verdict: classifyExactField(want.lpf1StaticHz, input.observedFilters.gyroLpf1StaticHz)});
    comparisons.push({field: 'gyroLpf1DynMinHz', verdict: classifyExactField(want.lpf1DynMinHz, input.observedFilters.gyroLpf1DynMinHz)});
    comparisons.push({field: 'gyroLpf1DynMaxHz', verdict: classifyExactField(want.lpf1DynMaxHz, input.observedFilters.gyroLpf1DynMaxHz)});
  }
  if (input.requested.dterm.enabled) {
    const want = projection.dtermHz;
    comparisons.push({field: 'dtermLpf1StaticHz', verdict: classifyExactField(want.lpf1StaticHz, input.observedFilters.dtermLpf1StaticHz)});
    comparisons.push({field: 'dtermLpf1DynMinHz', verdict: classifyExactField(want.lpf1DynMinHz, input.observedFilters.dtermLpf1DynMinHz)});
    comparisons.push({field: 'dtermLpf1DynMaxHz', verdict: classifyExactField(want.lpf1DynMaxHz, input.observedFilters.dtermLpf1DynMaxHz)});
  }
  return classifyGroup(comparisons);
}

export {FILTER_CONFIG_OFFSETS};
