/**
 * THE FILTER FIELDS THE EXPERT TIER EDITS - AND WHICH SCOPE EACH LIVES IN.
 *
 * =====================================================================
 * THE SCOPE PROBLEM THIS FILE EXISTS TO KEEP HONEST
 * =====================================================================
 *
 * MSP_FILTER_CONFIG is ONE command carrying TWO different lifetimes. The
 * D-term chain belongs to the PID PROFILE; the gyro chain, the dynamic
 * notch and the RPM filter are GLOBAL. Presenting them side by side on
 * one screen is fine - and treating them as one scope is not: a PID
 * profile change must re-read the D-term half and must NOT imply anything
 * about the gyro half.
 *
 * `filterFieldScope()` in decodeFilterConfigFull.ts already models that
 * split. It is now checked against the firmware's own parameter groups at
 * the pinned tree (`src/main/cli/settings.c`, API_VERSION_MINOR 49):
 *
 *   PG_PID_PROFILE        dterm_lpf1/2 (+ type, dyn min/max, expo),
 *                         dterm_notch_hz, dterm_notch_cutoff,
 *                         yaw_lowpass_hz
 *   PG_GYRO_CONFIG        gyro_lpf1/2 (+ type, dyn min/max),
 *                         gyro_notch1/2 hz + cutoff
 *   PG_DYN_NOTCH_CONFIG   dyn_notch_count / q / min_hz / max_hz
 *   PG_RPM_FILTER_CONFIG  rpm_filter_harmonics / min_hz / q / fade_range
 *
 * The first group is per-profile; every other group is MASTER_VALUE, i.e.
 * global. That is exactly the split the decoder already draws, and the
 * test beside this file pins the two together so they cannot drift.
 *
 * =====================================================================
 * WHY THE RPM FILTER IS READ-ONLY HERE
 * =====================================================================
 *
 * Its fields sit in a TAIL that only exists from API 1.48, and the weights
 * are variable-length. This phase shows them where the board actually
 * reports them and offers no write: inventing a write contract for a tail
 * whose presence depends on the API version is precisely the "fake zeros
 * on 1.47" the phase forbids. Read-only is the honest surface, and it is
 * marked as such rather than disabled without explanation.
 */

import {FILTER_CONFIG_OFFSETS} from '../protocol/msp/decoding/decodeFilterConfigFull';

/**
 * sensors/gyro.h: `#define LPF_MAX_HZ 1000`, with the firmware's own note
 * that above it a lowpass filters so little that a pilot wanting less
 * delay should disable the filter instead. Defined here rather than
 * imported because the decoder does not export it - and a second copy of
 * a number is only safe when it carries where it came from.
 */
const LPF_MAX_HZ = 1000;

/**
 * settings.c's lowpass type tables - lookupTableLowpassType for the gyro
 * chain and lookupTableDtermLowpassType for the D-term chain. BOTH have
 * FOUR entries: PT1, BIQUAD, PT2, PT3. (An earlier reading of this file
 * that stopped at three would have made PT3 unselectable on a board
 * already using it.)
 */
const LPF_TYPE_CHOICES: readonly number[] = Object.freeze([0, 1, 2, 3]);

/**
 * The filter fields P-E adds to the editable draft.
 *
 * The six P-D already edits (gyro/dterm LPF1 static + dynamic pairs) and
 * the four dynamic-notch fields stay where they are, in `FiltersDraft`.
 * These are the additions.
 */
export interface AdvancedFilterDraft {
  /* ---- gyro chain: GLOBAL ------------------------------------------ */
  readonly gyroLpf1Type: number;
  readonly gyroLpf2StaticHz: number;
  readonly gyroLpf2Type: number;
  readonly gyroSoftNotchHz1: number;
  readonly gyroSoftNotchCutoff1: number;
  readonly gyroSoftNotchHz2: number;
  readonly gyroSoftNotchCutoff2: number;

  /* ---- D-term chain: PID PROFILE ----------------------------------- */
  readonly dtermLpf1Type: number;
  readonly dtermLpf1DynExpo: number;
  readonly dtermLpf2StaticHz: number;
  readonly dtermLpf2Type: number;
  readonly dtermNotchHz: number;
  readonly dtermNotchCutoff: number;
  readonly yawLowpassHz: number;
}

export type AdvancedFilterFieldKey = keyof AdvancedFilterDraft;

export interface AdvancedFilterBound {
  readonly min: number;
  readonly max: number;
  readonly choices?: readonly number[];
  readonly scope: 'GLOBAL' | 'PID_PROFILE';
  readonly source: string;
}

/** settings.c rows at the pinned tree; see the two constants above. */
export const ADVANCED_FILTER_BOUNDS: Readonly<
  Record<AdvancedFilterFieldKey, AdvancedFilterBound>
> = Object.freeze({
  gyroLpf1Type: {
    min: 0,
    max: 3,
    choices: LPF_TYPE_CHOICES,
    scope: 'GLOBAL',
    source: 'settings.c PARAM_NAME_GYRO_LPF1_TYPE lookup {PT1, BIQUAD, PT2, PT3}',
  },
  gyroLpf2StaticHz: {
    min: 0,
    max: LPF_MAX_HZ,
    scope: 'GLOBAL',
    source: 'settings.c PARAM_NAME_GYRO_LPF2_STATIC_HZ {0, LPF_MAX_HZ}',
  },
  gyroLpf2Type: {
    min: 0,
    max: 3,
    choices: LPF_TYPE_CHOICES,
    scope: 'GLOBAL',
    source: 'settings.c PARAM_NAME_GYRO_LPF2_TYPE lookup {PT1, BIQUAD, PT2, PT3}',
  },
  gyroSoftNotchHz1: {
    min: 0,
    max: LPF_MAX_HZ,
    scope: 'GLOBAL',
    source: 'settings.c gyro_notch1_hz {0, LPF_MAX_HZ}',
  },
  gyroSoftNotchCutoff1: {
    min: 0,
    max: LPF_MAX_HZ,
    scope: 'GLOBAL',
    source: 'settings.c gyro_notch1_cutoff {0, LPF_MAX_HZ}',
  },
  gyroSoftNotchHz2: {
    min: 0,
    max: LPF_MAX_HZ,
    scope: 'GLOBAL',
    source: 'settings.c gyro_notch2_hz {0, LPF_MAX_HZ}',
  },
  gyroSoftNotchCutoff2: {
    min: 0,
    max: LPF_MAX_HZ,
    scope: 'GLOBAL',
    source: 'settings.c gyro_notch2_cutoff {0, LPF_MAX_HZ}',
  },

  dtermLpf1Type: {
    min: 0,
    max: 3,
    choices: LPF_TYPE_CHOICES,
    scope: 'PID_PROFILE',
    source: 'settings.c PARAM_NAME_DTERM_LPF1_TYPE lookup {PT1, BIQUAD, PT2, PT3}',
  },
  dtermLpf1DynExpo: {
    min: 0,
    max: 10,
    scope: 'PID_PROFILE',
    source: 'settings.c dterm_lpf1_dyn_expo {0, 10}',
  },
  dtermLpf2StaticHz: {
    min: 0,
    max: LPF_MAX_HZ,
    scope: 'PID_PROFILE',
    source: 'settings.c PARAM_NAME_DTERM_LPF2_STATIC_HZ {0, LPF_MAX_HZ}',
  },
  dtermLpf2Type: {
    min: 0,
    max: 3,
    choices: LPF_TYPE_CHOICES,
    scope: 'PID_PROFILE',
    source: 'settings.c PARAM_NAME_DTERM_LPF2_TYPE lookup {PT1, BIQUAD, PT2, PT3}',
  },
  dtermNotchHz: {
    min: 0,
    max: LPF_MAX_HZ,
    scope: 'PID_PROFILE',
    source: 'settings.c PARAM_NAME_DTERM_NOTCH_HZ {0, LPF_MAX_HZ}',
  },
  dtermNotchCutoff: {
    min: 0,
    max: LPF_MAX_HZ,
    scope: 'PID_PROFILE',
    source: 'settings.c PARAM_NAME_DTERM_NOTCH_CUTOFF {0, LPF_MAX_HZ}',
  },
  yawLowpassHz: {
    min: 0,
    max: 500,
    scope: 'PID_PROFILE',
    source: 'settings.c PARAM_NAME_YAW_LOWPASS_HZ {0, 500}',
  },
} as const);

export const ADVANCED_FILTER_FIELD_KEYS: readonly AdvancedFilterFieldKey[] = Object.freeze(
  Object.keys(ADVANCED_FILTER_BOUNDS) as AdvancedFilterFieldKey[],
);

export function advancedFilterDraftsEqual(
  a: AdvancedFilterDraft,
  b: AdvancedFilterDraft,
): boolean {
  return ADVANCED_FILTER_FIELD_KEYS.every(key => a[key] === b[key]);
}

export function movedAdvancedFilterFields(
  stored: AdvancedFilterDraft,
  draft: AdvancedFilterDraft,
): readonly AdvancedFilterFieldKey[] {
  return ADVANCED_FILTER_FIELD_KEYS.filter(key => stored[key] !== draft[key]);
}

/** Change-scoped, exactly like the advanced PID bounds beside it. */
export function invalidAdvancedFilterFields(
  draft: AdvancedFilterDraft,
  stored?: AdvancedFilterDraft,
): readonly AdvancedFilterFieldKey[] {
  return ADVANCED_FILTER_FIELD_KEYS.filter(key => {
    if (stored !== undefined && stored[key] === draft[key]) return false;
    const bound = ADVANCED_FILTER_BOUNDS[key];
    const value = draft[key];
    if (!Number.isInteger(value)) return true;
    if (bound.choices !== undefined) return !bound.choices.includes(value);
    return value < bound.min || value > bound.max;
  });
}

/**
 * =====================================================================
 * READING AND WRITING THE BYTES
 * =====================================================================
 *
 * Both helpers work on the payload the BOARD sent, not on a payload this
 * app composes. `decodeFilterConfigFull()` already produces the decoded
 * view for display; these two exist for the draft/encode path, where the
 * rule is that the ~35 bytes this screen does not own must come back
 * byte-for-byte. Taking the offsets from `FILTER_CONFIG_OFFSETS` rather
 * than restating them keeps one table, not two.
 *
 * Every field here lives inside the API-1.47 fixed head (highest offset
 * touched is 47), so neither helper reaches into the 1.48 RPM tail and
 * neither needs a contract. The decoder refuses a payload shorter than
 * its contract's length before a snapshot ever exists, so a short buffer
 * cannot reach these.
 */

/** Widths are the decoder's own; u8 here, u16 little-endian everywhere else. */
const U8_FIELDS: readonly AdvancedFilterFieldKey[] = Object.freeze([
  'gyroLpf1Type',
  'gyroLpf2Type',
  'dtermLpf1Type',
  'dtermLpf1DynExpo',
  'dtermLpf2Type',
]);

export function createAdvancedFilterDraftFromRaw(payload: Uint8Array): AdvancedFilterDraft {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const o = FILTER_CONFIG_OFFSETS;
  const u16 = (offset: number): number => view.getUint16(offset, true);
  return Object.freeze({
    gyroLpf1Type: payload[o.gyroLpf1Type],
    gyroLpf2StaticHz: u16(o.gyroLpf2StaticHz),
    gyroLpf2Type: payload[o.gyroLpf2Type],
    gyroSoftNotchHz1: u16(o.gyroSoftNotchHz1),
    gyroSoftNotchCutoff1: u16(o.gyroSoftNotchCutoff1),
    gyroSoftNotchHz2: u16(o.gyroSoftNotchHz2),
    gyroSoftNotchCutoff2: u16(o.gyroSoftNotchCutoff2),
    dtermLpf1Type: payload[o.dtermLpf1Type],
    dtermLpf1DynExpo: payload[o.dtermLpf1DynExpo],
    dtermLpf2StaticHz: u16(o.dtermLpf2StaticHz),
    dtermLpf2Type: payload[o.dtermLpf2Type],
    dtermNotchHz: u16(o.dtermNotchHz),
    dtermNotchCutoff: u16(o.dtermNotchCutoff),
    yawLowpassHz: u16(o.yawLowpassHz),
  });
}

/** Patch a draft into a CLONE of the board's own MSP_FILTER_CONFIG payload. */
export function patchAdvancedFilterDraft(
  payload: Uint8Array,
  draft: AdvancedFilterDraft,
): void {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  for (const key of ADVANCED_FILTER_FIELD_KEYS) {
    const offset = FILTER_CONFIG_OFFSETS[key];
    if (U8_FIELDS.includes(key)) payload[offset] = draft[key];
    else view.setUint16(offset, draft[key], true);
  }
}
