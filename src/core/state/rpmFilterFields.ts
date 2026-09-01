/**
 * THE RPM FILTER, AND THE ONE THING ITS SHAPE DEPENDS ON.
 *
 * =====================================================================
 * TWO HALVES WITH TWO DIFFERENT LIFETIMES ON THE WIRE
 * =====================================================================
 *
 * MSP_FILTER_CONFIG carries the RPM filter in two pieces:
 *
 *   HEAD   rpm_filter_harmonics (offset 43) and rpm_filter_min_hz (44)
 *          exist in the 49-byte payload every supported API sends, and
 *          MSP_SET_FILTER_CONFIG reads both of them at 1.47 as well.
 *
 *   TAIL   rpm_filter_fade_range_hz (49), rpm_filter_q (51) and three
 *          rpm_filter_weights (53, 54, 55) exist ONLY from API 1.48,
 *          where the payload grows to 56 bytes.
 *
 * So the head is unconditional and the tail is version-defined. `tail`
 * being `undefined` means THE WIRE CONTRACT HAS NO SUCH FIELD - it is a
 * different fact from a board reporting zero, and the two are never
 * collapsed.
 *
 * =====================================================================
 * WHY LENGTH DEFINES PRESENCE BUT ZERO PROVES NOTHING
 * =====================================================================
 *
 * The firmware's own reply builder settles both halves of this. From 1.48
 * the tail is appended unconditionally - a target compiled WITHOUT
 * `USE_RPM_FILTER` still writes `sbufWriteU16(dst, 0)` twice and three
 * zero weights. So:
 *
 *   the API version tells you the FIELD EXISTS in the message;
 *   nothing in the message tells you the RUNTIME FEATURE is compiled in.
 *
 * That is why capability here is resolved from the source-verified API
 * contract - the same one decoding, encoding and write authority already
 * use - and never from a payload length measured in the UI, and never
 * from a value being zero.
 *
 * =====================================================================
 * SCOPE
 * =====================================================================
 *
 * Every field here is `PG_RPM_FILTER_CONFIG`, a MASTER_VALUE parameter
 * group: GLOBAL. Changing the PID profile changes none of them, and must
 * not make any of them look dirty.
 */

import {
  FILTER_CONFIG_OFFSETS,
} from '../protocol/msp/decoding/decodeFilterConfigFull';
import {
  RPM_FILTER_HARMONICS_MAX,
  type PidApiContract,
} from '../protocol/msp/decoding/pidWireContracts';

/**
 * Whether the wire contract this board speaks defines the 1.48 tail.
 *
 * THE ONLY PLACE THAT ANSWER IS COMPUTED. Decoding, the draft, the
 * encoder and the screen all ask this function rather than each forming
 * an opinion, so there is one version truth and not four.
 */
export function rpmTailInContract(contract: PidApiContract): boolean {
  return contract !== 'API_1_47';
}

export interface RpmFilterTailDraft {
  readonly fadeRangeHz: number;
  readonly q: number;
  readonly weights: readonly [number, number, number];
}

export interface RpmFilterDraft {
  /** Offset 43. Present at every supported API. 0 disables the filter. */
  readonly harmonics: number;
  /** Offset 44. Present at every supported API. */
  readonly minHz: number;
  /** `undefined` = NOT IN THIS WIRE CONTRACT. Never "zero". */
  readonly tail: RpmFilterTailDraft | undefined;
}

export interface RpmFilterBound {
  readonly min: number;
  readonly max: number;
  readonly source: string;
}

/**
 * settings.c rows at the pinned API 1.49 tree
 * (`e72a8e93695270d54897a8f128cffdf8f74a0245`).
 *
 * The weights row is MODE_ARRAY and carries no minmax of its own, so its
 * bound comes from the two places that DO state it: the struct comment in
 * `pg/rpm_filter.h` - "effect or 'weight' (0% - 100%) of each RPM filter
 * harmonic" - and `MSP_SET_FILTER_CONFIG`, which returns MSP_RESULT_ERROR
 * for any weight above 100. The percentage reading is therefore proven by
 * source, not assumed.
 *
 * `rpm_filter_lpf_hz` exists in the parameter group and is deliberately
 * ABSENT here: it is not carried on MSP_FILTER_CONFIG at any pinned tree,
 * so this screen cannot read or write it.
 */
export const RPM_FILTER_BOUNDS = Object.freeze({
  harmonics: {
    min: 0,
    max: 3,
    source: 'settings.c PARAM_NAME_RPM_FILTER_HARMONICS {0, 3}',
  },
  minHz: {
    min: 30,
    max: 200,
    source: 'settings.c PARAM_NAME_RPM_FILTER_MIN_HZ {30, 200}',
  },
  fadeRangeHz: {
    min: 0,
    max: 1000,
    source: 'settings.c PARAM_NAME_RPM_FILTER_FADE_RANGE_HZ {0, 1000}',
  },
  q: {
    min: 250,
    max: 3000,
    source: 'settings.c PARAM_NAME_RPM_FILTER_Q {250, 3000}',
  },
  weight: {
    min: 0,
    max: 100,
    source:
      'pg/rpm_filter.h "weight (0% - 100%)" + msp.c MSP_SET_FILTER_CONFIG '
      + 'returns MSP_RESULT_ERROR for a weight above 100',
  },
} as const);

export type RpmFilterFieldKey =
  | 'harmonics' | 'minHz' | 'fadeRangeHz' | 'q' | 'weight1' | 'weight2' | 'weight3';

/** Present at every supported API. */
export const RPM_FILTER_HEAD_KEYS: readonly RpmFilterFieldKey[] =
  Object.freeze(['harmonics', 'minHz']);
/** Present only where `rpmTailInContract` says so. */
export const RPM_FILTER_TAIL_KEYS: readonly RpmFilterFieldKey[] =
  Object.freeze(['fadeRangeHz', 'q', 'weight1', 'weight2', 'weight3']);

export function rpmFilterBoundFor(field: RpmFilterFieldKey): RpmFilterBound {
  switch (field) {
    case 'harmonics': return RPM_FILTER_BOUNDS.harmonics;
    case 'minHz': return RPM_FILTER_BOUNDS.minHz;
    case 'fadeRangeHz': return RPM_FILTER_BOUNDS.fadeRangeHz;
    case 'q': return RPM_FILTER_BOUNDS.q;
    default: return RPM_FILTER_BOUNDS.weight;
  }
}

/** Read one field out of a draft, or `undefined` when the tail is absent. */
export function rpmFilterValue(
  draft: RpmFilterDraft,
  field: RpmFilterFieldKey,
): number | undefined {
  switch (field) {
    case 'harmonics': return draft.harmonics;
    case 'minHz': return draft.minHz;
    case 'fadeRangeHz': return draft.tail?.fadeRangeHz;
    case 'q': return draft.tail?.q;
    case 'weight1': return draft.tail?.weights[0];
    case 'weight2': return draft.tail?.weights[1];
    default: return draft.tail?.weights[2];
  }
}

/** Set one field, refusing to invent a tail the contract does not define. */
export function withRpmFilterValue(
  draft: RpmFilterDraft,
  field: RpmFilterFieldKey,
  value: number,
): RpmFilterDraft {
  if (field === 'harmonics') return Object.freeze({...draft, harmonics: value});
  if (field === 'minHz') return Object.freeze({...draft, minHz: value});
  /* A TAIL EDIT ON A CONTRACT WITH NO TAIL IS DROPPED, not materialised.
     Creating one here would be exactly the fabricated 1.48 tail on a 1.47
     board that the whole module exists to prevent. */
  if (draft.tail === undefined) return draft;
  const weights: [number, number, number] = [...draft.tail.weights];
  if (field === 'weight1') weights[0] = value;
  else if (field === 'weight2') weights[1] = value;
  else if (field === 'weight3') weights[2] = value;
  return Object.freeze({
    ...draft,
    tail: Object.freeze({
      fadeRangeHz: field === 'fadeRangeHz' ? value : draft.tail.fadeRangeHz,
      q: field === 'q' ? value : draft.tail.q,
      weights: Object.freeze(weights) as readonly [number, number, number],
    }),
  });
}

export function createRpmFilterDraftFromRaw(
  payload: Uint8Array,
  contract: PidApiContract,
): RpmFilterDraft {
  const o = FILTER_CONFIG_OFFSETS;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  if (!rpmTailInContract(contract)) {
    return Object.freeze({
      harmonics: payload[o.rpmFilterHarmonics],
      minHz: payload[o.rpmFilterMinHz],
      tail: undefined,
    });
  }
  return Object.freeze({
    harmonics: payload[o.rpmFilterHarmonics],
    minHz: payload[o.rpmFilterMinHz],
    tail: Object.freeze({
      fadeRangeHz: view.getUint16(o.rpmFilterFadeRangeHz, true),
      q: view.getUint16(o.rpmFilterQ, true),
      weights: Object.freeze([
        payload[o.rpmFilterWeights],
        payload[o.rpmFilterWeights + 1],
        payload[o.rpmFilterWeights + 2],
      ]) as readonly [number, number, number],
    }),
  });
}

/**
 * Patch a draft into a CLONE of the board's own payload.
 *
 * BYTES 49-55 ARE NEVER TOUCHED WHEN THE CONTRACT HAS NO TAIL. On API
 * 1.47 the payload is 49 bytes long and those offsets do not exist; a
 * write there would either run off the end or, on a padded buffer, send a
 * board seven bytes it never asked for.
 */
export function patchRpmFilterDraft(
  payload: Uint8Array,
  draft: RpmFilterDraft,
  contract: PidApiContract,
): void {
  const o = FILTER_CONFIG_OFFSETS;
  payload[o.rpmFilterHarmonics] = draft.harmonics;
  payload[o.rpmFilterMinHz] = draft.minHz;
  if (!rpmTailInContract(contract) || draft.tail === undefined) return;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  view.setUint16(o.rpmFilterFadeRangeHz, draft.tail.fadeRangeHz, true);
  view.setUint16(o.rpmFilterQ, draft.tail.q, true);
  for (let index = 0; index < RPM_FILTER_HARMONICS_MAX; index += 1) {
    payload[o.rpmFilterWeights + index] = draft.tail.weights[index];
  }
}

export function rpmFilterDraftsEqual(a: RpmFilterDraft, b: RpmFilterDraft): boolean {
  if (a.harmonics !== b.harmonics || a.minHz !== b.minHz) return false;
  if (a.tail === undefined || b.tail === undefined) return a.tail === b.tail;
  return a.tail.fadeRangeHz === b.tail.fadeRangeHz
    && a.tail.q === b.tail.q
    && a.tail.weights.every((weight, index) => weight === b.tail?.weights[index]);
}

export function movedRpmFilterFields(
  stored: RpmFilterDraft,
  draft: RpmFilterDraft,
): readonly RpmFilterFieldKey[] {
  return [...RPM_FILTER_HEAD_KEYS, ...RPM_FILTER_TAIL_KEYS].filter(
    field => rpmFilterValue(stored, field) !== rpmFilterValue(draft, field),
  );
}

/**
 * Change-scoped, exactly like the two advanced catalogues beside it.
 *
 * Worth stating for this group in particular: `min_hz` has a firmware
 * floor of 30, so a board with the RPM filter switched off reports a value
 * this app would call out of range. Holding an untouched field to that
 * would make the screen unsaveable over a byte nobody edited.
 */
export function invalidRpmFilterFields(
  draft: RpmFilterDraft,
  stored?: RpmFilterDraft,
): readonly RpmFilterFieldKey[] {
  return [...RPM_FILTER_HEAD_KEYS, ...RPM_FILTER_TAIL_KEYS].filter(field => {
    const value = rpmFilterValue(draft, field);
    if (value === undefined) return false;
    if (stored !== undefined && rpmFilterValue(stored, field) === value) return false;
    const bound = rpmFilterBoundFor(field);
    if (!Number.isInteger(value)) return true;
    return value < bound.min || value > bound.max;
  });
}
