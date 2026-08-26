/**
 * HOW AN LED SAVE IS PLANNED, BEFORE ANY BYTE GOES OUT.
 *
 * Pure. No MSP client, no session, no React, no strings. Everything here is
 * a decision the controller makes once, with the board's FRESH state in
 * hand, so that by the time a write is issued there is nothing left to
 * discover.
 *
 * THE ENTRY PLANNER IS THE REASON THIS MODULE EXISTS. The reference
 * configurator saves the strip by sending every index from 0 to the array
 * length, in order, unconditionally - thirty-two or sixty-four writes to
 * change one colour. That is not merely wasteful: because the firmware
 * re-counts the strip after EVERY accepted write, the ORDER of those writes
 * decides what the aircraft looks like at each intermediate moment, and a
 * naive order can pass through a state where a configured LED sits past a
 * terminator and is simply gone. The planner below writes only what changed
 * and orders what it writes so that no intermediate state ever contains a
 * gap the firmware would truncate at.
 */

import {
  decodeLedEntry,
  isLedTerminatorWord,
  type LedEntry,
} from '../protocol/msp/decoding/ledStripWireContract';
import {deriveLedStripTruth} from './ledStripTruth';

/* ------------------------------------------------------------------ *
 * WHAT A SAVE IS ALLOWED TO OWN
 * ------------------------------------------------------------------ */

/**
 * The four independently writable resources.
 *
 * They are four because the protocol makes them four: the strip array is
 * written one index at a time, the palette only ever as a whole sixteen-slot
 * frame, mode colours one tuple at a time, and the three MSP2 values
 * together. A single "dirty" boolean over all of that would be a claim the
 * wire cannot honour.
 */
export type LedSaveGroup = 'ENTRIES' | 'PALETTE' | 'MODE_COLORS' | 'RUNTIME_VALUES';

/**
 * The order every save follows, always the same one.
 *
 * Entries first because they are the resource whose intermediate states can
 * be visible on the aircraft, so they get the freshest link and the longest
 * remaining budget. The persistence commit is deliberately not in this list:
 * it happens once, after every group in it has been written AND read back.
 */
export const LED_SAVE_GROUP_ORDER: readonly LedSaveGroup[] = Object.freeze([
  'ENTRIES',
  'PALETTE',
  'MODE_COLORS',
  'RUNTIME_VALUES',
]);

/* ------------------------------------------------------------------ *
 * ENTRY WRITE PLANNING
 * ------------------------------------------------------------------ */

/**
 * Which part of the strip transition a write belongs to.
 *
 * Carried on every planned write so a failure can be reported against the
 * phase it happened in rather than against a bare index - "the terminator
 * went in but the cleanup did not" is a materially different board state
 * from "the third LED failed", and an operator-facing message later has to
 * be able to tell them apart.
 */
export type LedEntryWritePhase =
  /** An index that exists both before and after, whose word changed. */
  | 'RETAINED'
  /** A new LED beyond the old terminator. Written ascending, never before
   *  the index below it. */
  | 'EXTEND'
  /** The single deliberate zero that shortens the strip. */
  | 'TERMINATE'
  /** Old trailing entries zeroed AFTER the new terminator is in place. */
  | 'CLEANUP';

export interface LedEntryWrite {
  readonly index: number;
  readonly raw: number;
  readonly phase: LedEntryWritePhase;
}

export type LedEntryPlanRefusal =
  /** The target array is not the length the board's own frame reported. */
  | {readonly kind: 'TARGET_LENGTH_MISMATCH'; readonly expected: number; readonly actual: number}
  /** A target word is not a u32. */
  | {readonly kind: 'TARGET_WORD_INVALID'; readonly index: number}
  /** The target has a configured entry sitting past its own terminator. */
  | {readonly kind: 'TARGET_HAS_GAP'; readonly terminatorIndex: number; readonly unreachable: readonly number[]}
  /**
   * The caller said it wanted N effective LEDs and the array it supplied
   * yields a different number - which means one of its own LEDs serialised
   * to all-zeros and silently became the end of the strip.
   */
  | {readonly kind: 'TARGET_EFFECTIVE_COUNT_MISMATCH'; readonly declared: number; readonly derived: number}
  /** The BOARD already has a gap. Saving over it would write on top of a
   *  state nobody chose; repairing it is not this phase's decision. */
  | {readonly kind: 'OBSERVED_STRIP_HAS_GAP'; readonly terminatorIndex: number; readonly unreachable: readonly number[]}
  /** Someone else changed the strip since the draft's baseline was read. */
  | {readonly kind: 'STALE_ENTRIES_STATE'; readonly firstDivergentIndex: number};

export type LedEntryPlan =
  | {readonly kind: 'PLANNED'; readonly writes: readonly LedEntryWrite[]; readonly targetEffectiveCount: number}
  | {readonly kind: 'REFUSED'; readonly refusal: LedEntryPlanRefusal};

const U32_MAX = 0xffffffff;

function rawsOf(entries: readonly LedEntry[]): number[] {
  return entries.map(entry => entry.raw);
}

function firstDivergence(a: readonly number[], b: readonly number[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) return i;
  }
  return -1;
}

/**
 * Plan the writes that turn the board's fresh strip into the target one.
 *
 * `baseline` is the array the draft was built from. It is compared against
 * `fresh` in FULL, not per edited index, and that strictness is deliberate:
 * the strip's meaning is globally coupled. Its length decides the count, its
 * order decides every ordinal animation, and its extent decides which
 * quadrant each LED belongs to. Merging somebody else's entry edit into ours
 * would produce a strip neither of us asked for, so a divergence anywhere
 * refuses the whole save.
 */
export function planLedEntryWrites(params: {
  readonly fresh: readonly LedEntry[];
  readonly baseline: readonly number[];
  readonly target: readonly number[];
  readonly declaredEffectiveCount?: number;
}): LedEntryPlan {
  const {fresh, baseline, target, declaredEffectiveCount} = params;
  const observedRaw = rawsOf(fresh);

  if (target.length !== observedRaw.length) {
    return refuse({kind: 'TARGET_LENGTH_MISMATCH', expected: observedRaw.length, actual: target.length});
  }
  for (let i = 0; i < target.length; i++) {
    const word = target[i];
    if (!Number.isInteger(word) || word < 0 || word > U32_MAX) {
      return refuse({kind: 'TARGET_WORD_INVALID', index: i});
    }
  }

  /* The board's own state first: writing over a strip that is ALREADY
     truncated would silently adopt whatever caused that. */
  const observedTruth = deriveLedStripTruth(fresh);
  if (observedTruth.gapDetected) {
    return refuse({
      kind: 'OBSERVED_STRIP_HAS_GAP',
      terminatorIndex: observedTruth.firstTerminatorIndex ?? 0,
      unreachable: Object.freeze(observedTruth.unreachableEntries.map(entry => entry.index)),
    });
  }

  const targetEntries = target.map((word, index) => decodeLedEntry(word, index));
  const targetTruth = deriveLedStripTruth(targetEntries);
  if (targetTruth.gapDetected) {
    return refuse({
      kind: 'TARGET_HAS_GAP',
      terminatorIndex: targetTruth.firstTerminatorIndex ?? 0,
      unreachable: Object.freeze(targetTruth.unreachableEntries.map(entry => entry.index)),
    });
  }
  if (
    declaredEffectiveCount !== undefined &&
    declaredEffectiveCount !== targetTruth.effectiveCount
  ) {
    return refuse({
      kind: 'TARGET_EFFECTIVE_COUNT_MISMATCH',
      declared: declaredEffectiveCount,
      derived: targetTruth.effectiveCount,
    });
  }

  /* Concurrency. Already being at the target is not a conflict - it is the
     save having nothing left to do. */
  const divergent = firstDivergence(observedRaw, baseline);
  if (divergent !== -1 && firstDivergence(observedRaw, target) !== -1) {
    return refuse({kind: 'STALE_ENTRIES_STATE', firstDivergentIndex: divergent});
  }

  const observedCount = observedTruth.effectiveCount;
  const targetCount = targetTruth.effectiveCount;
  const writes: LedEntryWrite[] = [];

  /* 1. The prefix both strips keep. Every one of these target words is
        non-zero, so the count cannot move while they are written. */
  const retained = Math.min(observedCount, targetCount);
  for (let i = 0; i < retained; i++) {
    if (observedRaw[i] !== target[i]) {
      writes.push(Object.freeze({index: i, raw: target[i], phase: 'RETAINED' as const}));
    }
  }

  if (targetCount > observedCount) {
    /* 2a. GROW, ASCENDING FROM THE OLD TERMINATOR. Writing the far end
           first would leave the hole below it in place and the firmware
           would stop counting there - the new LED would exist in the
           board's memory and be invisible on the aircraft. Written in
           this order the count rises by exactly one per accepted write. */
    for (let i = observedCount; i < targetCount; i++) {
      writes.push(Object.freeze({index: i, raw: target[i], phase: 'EXTEND' as const}));
    }
  } else if (targetCount < observedCount) {
    /* 2b. SHRINK. One deliberate zero at the new end, and it goes in
           BEFORE the old tail is cleared. Clearing from the far end first
           would walk the strip down one LED at a time through counts
           nobody asked for; this way the count moves once, at a point
           chosen on purpose. */
    writes.push(Object.freeze({index: targetCount, raw: 0, phase: 'TERMINATE' as const}));
    /* 3. Only now the leftovers, so the raw array ends up canonical
          rather than carrying old words past the terminator. */
    for (let i = targetCount + 1; i < observedCount; i++) {
      if (observedRaw[i] !== target[i]) {
        writes.push(Object.freeze({index: i, raw: target[i], phase: 'CLEANUP' as const}));
      }
    }
  }

  return Object.freeze({
    kind: 'PLANNED' as const,
    writes: Object.freeze(writes),
    targetEffectiveCount: targetCount,
  });
}

function refuse(refusal: LedEntryPlanRefusal): LedEntryPlan {
  return Object.freeze({kind: 'REFUSED' as const, refusal: Object.freeze(refusal)});
}

/** True when every word past the effective count is zero and no configured
 *  entry is stranded. Used by readback to check the whole array, not just
 *  the indexes that were written. */
export function ledEntryArrayIsCanonical(words: readonly number[]): boolean {
  let seenTerminator = false;
  for (const word of words) {
    if (isLedTerminatorWord(word)) seenTerminator = true;
    else if (seenTerminator) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * PALETTE MERGE
 * ------------------------------------------------------------------ */

export interface LedPaletteEntry {
  readonly hue: number;
  readonly whiteness: number;
  readonly value: number;
}

export function ledPaletteColorsEqual(a: LedPaletteEntry, b: LedPaletteEntry): boolean {
  return a.hue === b.hue && a.whiteness === b.whiteness && a.value === b.value;
}

export type LedPaletteMerge =
  | {readonly kind: 'MERGED'; readonly colors: readonly LedPaletteEntry[]; readonly changed: boolean}
  | {readonly kind: 'STALE_PALETTE_SLOT'; readonly slot: number};

/**
 * The sixteen colours to send, built from the board's CURRENT palette with
 * only the operator's own slots replaced.
 *
 * The palette command has no index and no length - the firmware loops
 * sixteen times over whatever arrives - so every save necessarily restates
 * fifteen colours nobody touched. Taking those from a snapshot read when the
 * screen opened is how a save silently reverts somebody else's change while
 * looking perfectly successful; taking them from the fresh read is the whole
 * point of doing the fresh read.
 *
 * A slot the operator DID edit is different: if it moved underneath them,
 * writing over it would destroy a change they never saw. That refuses.
 * Moving to the value they were asking for anyway does not - there is
 * nothing left to lose.
 */
export function mergeLedPalette(params: {
  readonly fresh: readonly LedPaletteEntry[];
  readonly baseline: readonly LedPaletteEntry[];
  readonly owned: ReadonlyMap<number, LedPaletteEntry>;
}): LedPaletteMerge {
  const {fresh, baseline, owned} = params;
  const merged = fresh.map(color => Object.freeze({...color}));
  let changed = false;
  for (const [slot, wanted] of owned) {
    const current = fresh[slot];
    const was = baseline[slot];
    if (current === undefined || was === undefined) {
      return Object.freeze({kind: 'STALE_PALETTE_SLOT' as const, slot});
    }
    if (!ledPaletteColorsEqual(current, was) && !ledPaletteColorsEqual(current, wanted)) {
      return Object.freeze({kind: 'STALE_PALETTE_SLOT' as const, slot});
    }
    if (!ledPaletteColorsEqual(current, wanted)) changed = true;
    merged[slot] = Object.freeze({...wanted});
  }
  return Object.freeze({kind: 'MERGED' as const, colors: Object.freeze(merged), changed});
}

/* ------------------------------------------------------------------ *
 * MODE-COLOUR TUPLE PLANNING
 * ------------------------------------------------------------------ */

export interface LedModeColorKey {
  readonly mode: number;
  readonly slot: number;
}

export interface LedModeColorWrite {
  readonly mode: number;
  readonly slot: number;
  readonly value: number;
}

export type LedModeColorPlan =
  | {readonly kind: 'PLANNED'; readonly writes: readonly LedModeColorWrite[]}
  | {readonly kind: 'STALE_MODE_COLOR'; readonly mode: number; readonly slot: number}
  | {readonly kind: 'TUPLE_ABSENT'; readonly mode: number; readonly slot: number};

const tupleKey = (mode: number, slot: number): string => `${mode}:${slot}`;

function indexTuples(
  tuples: readonly LedModeColorWrite[],
): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  for (const tuple of tuples) map.set(tupleKey(tuple.mode, tuple.slot), tuple.value);
  return map;
}

/**
 * Only the tuples that actually changed, and only if nobody else moved them.
 *
 * Unlike the palette this command IS per tuple, so there is no whole-array
 * to preserve - the forty-seven tuples nobody edited are simply never sent.
 * That includes the three unnamed special slots and the runtime-inert mode:
 * not writing them is what preserves them.
 */
export function planLedModeColorWrites(params: {
  readonly fresh: readonly LedModeColorWrite[];
  readonly baseline: readonly LedModeColorWrite[];
  readonly owned: readonly LedModeColorWrite[];
}): LedModeColorPlan {
  const {fresh, baseline, owned} = params;
  const freshByKey = indexTuples(fresh);
  const baselineByKey = indexTuples(baseline);
  const writes: LedModeColorWrite[] = [];
  for (const wanted of owned) {
    const key = tupleKey(wanted.mode, wanted.slot);
    const current = freshByKey.get(key);
    const was = baselineByKey.get(key);
    if (current === undefined || was === undefined) {
      return Object.freeze({kind: 'TUPLE_ABSENT' as const, mode: wanted.mode, slot: wanted.slot});
    }
    if (current !== was && current !== wanted.value) {
      return Object.freeze({
        kind: 'STALE_MODE_COLOR' as const,
        mode: wanted.mode,
        slot: wanted.slot,
      });
    }
    if (current !== wanted.value) {
      writes.push(Object.freeze({mode: wanted.mode, slot: wanted.slot, value: wanted.value}));
    }
  }
  return Object.freeze({kind: 'PLANNED' as const, writes: Object.freeze(writes)});
}

/* ------------------------------------------------------------------ *
 * RUNTIME VALUE MERGE
 * ------------------------------------------------------------------ */

export interface LedRuntimeValues {
  readonly brightness: number;
  readonly rainbowDelta: number;
  readonly rainbowFreq: number;
}

export type LedRuntimeValueField = keyof LedRuntimeValues;

export const LED_RUNTIME_VALUE_FIELDS: readonly LedRuntimeValueField[] = Object.freeze([
  'brightness',
  'rainbowDelta',
  'rainbowFreq',
]);

export type LedRuntimeMerge =
  | {readonly kind: 'MERGED'; readonly values: LedRuntimeValues; readonly changed: boolean}
  | {readonly kind: 'STALE_RUNTIME_VALUE'; readonly field: LedRuntimeValueField};

/**
 * All three values to send, with only the edited ones replaced.
 *
 * The MSP2 frame carries all three together, so the same reasoning as the
 * palette applies at field granularity: an untouched field comes from the
 * fresh read, and an edited one that moved underneath the operator refuses.
 */
export function mergeLedRuntimeValues(params: {
  readonly fresh: LedRuntimeValues;
  readonly baseline: LedRuntimeValues;
  readonly owned: Partial<LedRuntimeValues>;
}): LedRuntimeMerge {
  const {fresh, baseline, owned} = params;
  const merged: {[K in LedRuntimeValueField]: number} = {
    brightness: fresh.brightness,
    rainbowDelta: fresh.rainbowDelta,
    rainbowFreq: fresh.rainbowFreq,
  };
  let changed = false;
  for (const field of LED_RUNTIME_VALUE_FIELDS) {
    const wanted = owned[field];
    if (wanted === undefined) continue;
    if (fresh[field] !== baseline[field] && fresh[field] !== wanted) {
      return Object.freeze({kind: 'STALE_RUNTIME_VALUE' as const, field});
    }
    if (fresh[field] !== wanted) changed = true;
    merged[field] = wanted;
  }
  return Object.freeze({
    kind: 'MERGED' as const,
    values: Object.freeze(merged),
    changed,
  });
}

export function ledRuntimeValuesEqual(a: LedRuntimeValues, b: LedRuntimeValues): boolean {
  return (
    a.brightness === b.brightness &&
    a.rainbowDelta === b.rainbowDelta &&
    a.rainbowFreq === b.rainbowFreq
  );
}
