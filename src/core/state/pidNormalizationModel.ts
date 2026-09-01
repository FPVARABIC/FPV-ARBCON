/**
 * TELLING "THE BOARD CORRECTED ME" APART FROM "THE BOARD IGNORED ME".
 *
 * The existing PID save compares the whole draft against the whole readback
 * and calls any difference a failure. That works only while every field we
 * write is stored verbatim - and P-A found five places where it is not:
 *
 *   tpa_rate               clamped to 100 on the way in
 *   gyro notch hz          zeroed when its cutoff is not below it
 *   gyro lpf1 dyn min      zeroed when it exceeds the dynamic maximum
 *   any filter frequency   reset when it exceeds the lowpass ceiling
 *   simplified tuning      regenerates PIDs, D Max, feedforward and filter Hz
 *
 * Under whole-object equality every one of those would be reported to the
 * pilot as a failed save, on a board that did exactly what its firmware says
 * it does. So a readback needs three answers rather than two, and the third
 * one has to be earned by predicting the correction in advance rather than by
 * accepting whatever came back.
 *
 * EXACT       the board holds what was requested
 * NORMALISED  the board holds something else, and it is precisely what the
 *             firmware's own documented rule produces from that request
 * MISMATCH    neither - the write did not take, and no rule explains it
 *
 * NORMALISED is not a softer MISMATCH. It is only reachable when a projection
 * function computed the expected value BEFORE the comparison, which is why
 * every classifier below takes an `expected` as well as a `requested`.
 */

export type FieldVerdict =
  | {readonly kind: 'EXACT'}
  | {readonly kind: 'NORMALISED'; readonly requested: number; readonly observed: number; readonly rule: NormalisationRule}
  | {readonly kind: 'MISMATCH'; readonly requested: number; readonly expected: number; readonly observed: number};

/** Named so a report can say which firmware rule fired, not just "normalised". */
export type NormalisationRule =
  | 'TPA_RATE_CLAMPED'
  | 'FILTER_LIMIT_RESET'
  | 'NOTCH_DISABLED_BY_CUTOFF'
  | 'DYNAMIC_MIN_ABOVE_MAX'
  | 'SIMPLIFIED_REGENERATED';
// RC_TUNING_PITCH_FOLLOWED_ROLL used to be here. It was removed once the
// firmware's read order was traced properly: the explicit pitch bytes at
// offsets 12 and 13 overwrite the legacy link on every full-length write, so
// no production write can ever produce that normalisation. Naming a rule that
// cannot fire invites a classifier to accept a value it should refuse.

/**
 * Classify one field.
 *
 * `expected` is what our own projection of the firmware's rule says should
 * come back. When that differs from `requested`, an observation matching it
 * is a normalisation; an observation matching neither is a mismatch. Note the
 * order of the tests: an observation that equals the request is EXACT even if
 * a rule was predicted, because a rule that did not fire is not a correction.
 */
export function classifyField(
  requested: number,
  expected: number,
  observed: number,
  rule: NormalisationRule,
): FieldVerdict {
  if (observed === requested) return Object.freeze({kind: 'EXACT'});
  if (observed === expected) return Object.freeze({kind: 'NORMALISED', requested, observed, rule});
  return Object.freeze({kind: 'MISMATCH', requested, expected, observed});
}

/**
 * Classify a field NO firmware rule can touch.
 *
 * Most of the values this app writes come back verbatim or not at all: the
 * PID gains, the rate curve, the simplified sliders. Passing `classifyField`
 * a rule name for those fields would be inventing a firmware behaviour to
 * excuse a difference that nothing excuses, so they use this instead and can
 * only ever be EXACT or MISMATCH.
 */
export function classifyExactField(requested: number, observed: number): FieldVerdict {
  return observed === requested
    ? Object.freeze({kind: 'EXACT'})
    : Object.freeze({kind: 'MISMATCH', requested, expected: requested, observed});
}

export interface FieldComparison {
  readonly field: string;
  readonly verdict: FieldVerdict;
}

export type GroupVerdict =
  | {readonly kind: 'EXACT'}
  | {readonly kind: 'NORMALISED'; readonly fields: readonly FieldComparison[]}
  | {readonly kind: 'MISMATCH'; readonly fields: readonly FieldComparison[]};

/**
 * Roll a set of field verdicts into one answer for a write group.
 *
 * Any mismatch makes the group a mismatch - a normalisation somewhere else
 * does not excuse it. Only the offending fields are carried, so a caller
 * reports the two bytes that disagreed rather than the sixty that did not.
 */
export function classifyGroup(comparisons: readonly FieldComparison[]): GroupVerdict {
  const mismatches = comparisons.filter(entry => entry.verdict.kind === 'MISMATCH');
  if (mismatches.length > 0) return Object.freeze({kind: 'MISMATCH', fields: Object.freeze(mismatches)});
  const normalised = comparisons.filter(entry => entry.verdict.kind === 'NORMALISED');
  if (normalised.length > 0) return Object.freeze({kind: 'NORMALISED', fields: Object.freeze(normalised)});
  return Object.freeze({kind: 'EXACT'});
}

/* ------------------------------------------------------------------ */
/* The firmware's own filter corrections, reimplemented only as far as  */
/* is needed to predict a readback.                                     */
/* ------------------------------------------------------------------ */

/** sensors/gyro.h LPF_MAX_HZ. */
export const LPF_MAX_HZ = 1000;

/**
 * The firmware's filter-limit fix is a RESET, not a clamp, and the value it
 * resets to differs by field: a lowpass or notch centre above the ceiling
 * becomes the ceiling, but a notch CUTOFF above the ceiling becomes zero.
 * Reading it as a clamp would predict 1000 where the board holds 0.
 */
export function projectFilterLimit(value: number, resetValue: number): number {
  return value > LPF_MAX_HZ ? resetValue : value;
}

export interface GyroNotchPair {
  readonly centreHz: number;
  readonly cutoffHz: number;
}

/**
 * A notch whose cutoff is not strictly below its centre is switched off by
 * zeroing the CENTRE - the cutoff is left where it was, which is why the
 * result carries both.
 */
export function projectGyroNotch(pair: GyroNotchPair): GyroNotchPair {
  const centreHz = projectFilterLimit(pair.centreHz, LPF_MAX_HZ);
  const cutoffHz = projectFilterLimit(pair.cutoffHz, 0);
  return cutoffHz >= centreHz
    ? Object.freeze({centreHz: 0, cutoffHz})
    : Object.freeze({centreHz, cutoffHz});
}

export interface DynamicLowpassRange {
  readonly minHz: number;
  readonly maxHz: number;
}

/** A dynamic minimum above its maximum is zeroed; the maximum is untouched. */
export function projectDynamicLowpass(range: DynamicLowpassRange): DynamicLowpassRange {
  return range.minHz > range.maxHz
    ? Object.freeze({minHz: 0, maxHz: range.maxHz})
    : Object.freeze({...range});
}

/* ------------------------------------------------------------------ */
/* What else a filter write disturbs.                                   */
/* ------------------------------------------------------------------ */

/**
 * MSP_SET_FILTER_CONFIG DOES NOT ONLY WRITE FILTERS.
 *
 * Its handler ends in the firmware's gyro-config validation, which - beyond
 * correcting the filter fields themselves - may raise `pid_process_denom`,
 * lower a non-DShot motor's PWM rate, and downgrade DSHOT600 to DSHOT300 when
 * bidirectional DShot is on. Two of those belong to the Motors screen and one
 * of them is the very number this page divides by to compute the D-term
 * Nyquist ceiling. The same routine also re-resolves the active profile
 * pointers.
 *
 * All three mutable fields surface through a single read, MSP_ADVANCED_CONFIG,
 * and the profile indexes through MSP_STATUS_EX. So the invalidation set is
 * small and exact. P-B states it; P-C performs the reads; nothing here
 * touches Motors.
 */
export type ReobservableTruth =
  | 'MSP_ADVANCED_CONFIG'
  | 'MSP_STATUS_EX'
  | 'MSP_FILTER_CONFIG';

export interface PostWriteInvalidation {
  readonly requiresReobserve: readonly ReobservableTruth[];
  /** Named so a report can say WHY, not merely that a re-read is due. */
  readonly reasons: readonly string[];
}

const NOTHING_TO_REOBSERVE: PostWriteInvalidation = Object.freeze({
  requiresReobserve: Object.freeze([]),
  reasons: Object.freeze([]),
});

export type PidWriteGroupKind =
  | 'PID' | 'PID_ADVANCED' | 'RC_TUNING' | 'FILTER_CONFIG' | 'SIMPLIFIED_TUNING'
  | 'SELECT_SETTING' | 'COPY_PROFILE' | 'RESET_PID_PROFILE';

export function postWriteInvalidationFor(group: PidWriteGroupKind): PostWriteInvalidation {
  switch (group) {
    case 'FILTER_CONFIG':
      return Object.freeze({
        requiresReobserve: Object.freeze([
          'MSP_FILTER_CONFIG', 'MSP_ADVANCED_CONFIG', 'MSP_STATUS_EX',
        ]) as readonly ReobservableTruth[],
        reasons: Object.freeze([
          'gyro config validation may reset filter frequencies and disable notches',
          'gyro config validation may raise pid_process_denom, which sets the D-term Nyquist ceiling',
          'gyro config validation may downgrade the motor protocol and lower the motor PWM rate',
          'gyro config validation re-resolves the active PID and rate profile pointers',
        ]),
      });
    case 'SIMPLIFIED_TUNING':
      // The generator rewrites PID gains, D Max, feedforward and the filter
      // frequencies in place, so the two payloads that carry them are stale
      // the moment this write is acknowledged.
      return Object.freeze({
        requiresReobserve: Object.freeze([
          'MSP_FILTER_CONFIG',
        ]) as readonly ReobservableTruth[],
        reasons: Object.freeze([
          'the simplified generator overwrites PID gains, D Max, feedforward and filter frequencies',
        ]),
      });
    case 'SELECT_SETTING':
    case 'COPY_PROFILE':
    case 'RESET_PID_PROFILE':
      return Object.freeze({
        requiresReobserve: Object.freeze(['MSP_STATUS_EX']) as readonly ReobservableTruth[],
        reasons: Object.freeze(['the active profile identity may have moved']),
      });
    default:
      return NOTHING_TO_REOBSERVE;
  }
}

/* ------------------------------------------------------------------ */
/* Observed / draft / projected.                                        */
/* ------------------------------------------------------------------ */

/**
 * Three values for one setting, and the rule that keeps them apart.
 *
 * `observed` is the last thing the board actually said. `draft` is what the
 * operator has asked for and nothing has been sent. `projected` is what our
 * reimplementation of the firmware predicts would be stored if that draft
 * were written - a prediction, never evidence.
 *
 * A projection must never be written into `observed`. Doing so is how a UI
 * ends up showing a pilot a tune their aircraft is not flying, and it is the
 * reason this type exists instead of a single mutable number.
 */
export interface TripleTruth<T> {
  readonly observed: T;
  readonly draft: T | undefined;
  readonly projected: T | undefined;
}

export function observedOnly<T>(observed: T): TripleTruth<T> {
  return Object.freeze({observed, draft: undefined, projected: undefined});
}

export function withDraft<T>(current: TripleTruth<T>, draft: T, projected: T): TripleTruth<T> {
  return Object.freeze({observed: current.observed, draft, projected});
}

/** What a UI should display as "current". Never the projection. */
export function displayedCurrent<T>(truth: TripleTruth<T>): T {
  return truth.observed;
}
