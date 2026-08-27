/* eslint-disable no-bitwise -- one bit is read out of the overlay and
 * direction masks to answer "is this flag on across the selection"; the
 * masks are the firmware's. */
/**
 * THE EDITOR'S STATE, AND EVERY RULE THAT KEEPS IT SAFE.
 *
 * Pure. No React, no MSP, no Arabic. The screen renders this and calls
 * these functions; it does not decide any of it for itself.
 *
 * WHY THE DRAFT IS A SEPARATE THING FROM THE SNAPSHOT. The reference
 * configurator rebuilds its LED array from the grid on every selection,
 * every function change and every colour click, so "what the board holds"
 * and "what the operator is proposing" are the same object and there is
 * nothing left to compare. Here they are two: `observed` is the last
 * verified board state and never moves until a save is verified, and
 * everything the operator does lands somewhere else.
 *
 * THREE RULES THIS MODULE EXISTS TO MAKE UNBREAKABLE:
 *
 *  1. SELECTING NEVER EDITS. Selection lives beside the entries, not
 *     inside them, so there is no code path where looking at an LED
 *     changes one.
 *
 *  2. NO GAP CAN BE AUTHORED. A new LED can only ever be the next
 *     physical index, deletion is only ever the last one, and reordering
 *     is a permutation of a contiguous prefix. The firmware stops
 *     rendering at the first all-zero word, so a middle hole is not a
 *     cosmetic mistake - it silently switches off every LED after it.
 *
 *  3. AN LED THAT WOULD SERIALISE TO ZERO IS NOT A SAVEABLE LED. A new
 *     entry sits in `pending` until its word is non-zero. It is never
 *     given an invented firmware default to get it out of that state,
 *     because a default nobody chose is a value the operator did not set.
 */

import {
  decodeLedEntry,
  encodeLedEntry,
  isLedTerminatorWord,
  withLedBaseFunction,
  withLedColorIndex,
  withLedDirectionBit,
  withLedOverlayBit,
  withLedX,
  withLedY,
  LED_COLOR_INDEX_MAX,
  LED_COORDINATE_MAX,
  LED_DIRECTION_BIT_WIDTH,
  LED_OVERLAY_BIT_WIDTH,
  type LedEntry,
} from '../protocol/msp/decoding/ledStripWireContract';
import type {
  LedPaletteColor,
  LedModeColorTuple,
  LedStripRuntimeConfigValues,
} from '../protocol/msp/decoding/decodeLedStrip';
import {
  LED_BRIGHTNESS_MAX,
  LED_BRIGHTNESS_MIN,
  LED_RAINBOW_DELTA_MAX,
  LED_RAINBOW_DELTA_MIN,
  LED_RAINBOW_FREQ_MAX,
  LED_RAINBOW_FREQ_MIN,
} from '../protocol/msp/encoding/encodeLedStrip';
import type {LedStripBuildCapability} from './ledStripModel';
import {
  ledPaletteColorsEqual,
  type LedModeColorWrite,
  type LedPaletteEntry,
  type LedRuntimeValueField,
  type LedRuntimeValues,
  type LedSaveGroup,
} from './ledStripSaveModel';
import {deriveLedStripTruth} from './ledStripTruth';

/** What the screen needs from a loaded snapshot. Structural, so the draft
 *  layer carries no dependency on the controller module. */
export interface LedDraftObserved {
  readonly maxLength: number;
  readonly entries: readonly LedEntry[];
  readonly capability: LedStripBuildCapability;
  readonly palette: readonly LedPaletteColor[] | undefined;
  readonly modeColors: readonly LedModeColorTuple[] | undefined;
  readonly runtimeValues: LedStripRuntimeConfigValues;
}

/** A physical LED that exists only in the editor until it is valid. */
export interface LedPendingEntry {
  /** The next physical index after the current effective count. */
  readonly index: number;
  /** Starts at zero, which is exactly why it cannot be saved yet. */
  readonly raw: number;
}

export interface LedStripDraft {
  readonly observed: LedDraftObserved;
  /** The full target array, one word per board slot. */
  readonly entries: readonly number[];
  /** Owned palette slots only. */
  readonly palette: ReadonlyMap<number, LedPaletteEntry>;
  /** Owned mode/special/aux tuples only. */
  readonly modeColors: readonly LedModeColorWrite[];
  /** Owned runtime fields only. */
  readonly runtimeValues: Partial<LedRuntimeValues>;
  /** Physical indexes, in selection order. Never sorted by position. */
  readonly selection: readonly number[];
  readonly multiSelect: boolean;
  readonly pending: LedPendingEntry | undefined;
}

const EMPTY_SELECTION: readonly number[] = Object.freeze([]);

function rawsOf(entries: readonly LedEntry[]): number[] {
  return entries.map(entry => entry.raw);
}

export function createLedStripDraft(observed: LedDraftObserved): LedStripDraft {
  return Object.freeze({
    observed,
    entries: Object.freeze(rawsOf(observed.entries)),
    palette: new Map<number, LedPaletteEntry>(),
    modeColors: Object.freeze([]),
    runtimeValues: Object.freeze({}),
    selection: EMPTY_SELECTION,
    multiSelect: false,
    pending: undefined,
  });
}

/** A draft with the operator's work thrown away, selection included. */
export function discardLedStripDraft(draft: LedStripDraft): LedStripDraft {
  return createLedStripDraft(draft.observed);
}

/* ------------------------------------------------------------------ *
 * READING THE DRAFT
 * ------------------------------------------------------------------ */

/** How many LEDs the draft describes, pending one included. */
export function draftEffectiveCount(draft: LedStripDraft): number {
  const committed = deriveLedStripTruth(
    draft.entries.map((word, index) => decodeLedEntry(word, index)),
    draft.observed.maxLength,
  ).effectiveCount;
  return draft.pending === undefined ? committed : committed + 1;
}

export interface LedDraftNode {
  /** Physical position in the chain, from zero. */
  readonly index: number;
  /** What an operator is shown: index + 1. */
  readonly number: number;
  readonly raw: number;
  readonly x: number;
  readonly y: number;
  readonly baseFunction: number;
  readonly overlayMask: number;
  readonly colorIndex: number;
  readonly directionMask: number;
  /** True while this LED exists only in the editor. */
  readonly isPending: boolean;
  /** True when its word would be the strip terminator. */
  readonly encodesAsTerminator: boolean;
}

/**
 * Every LED the editor should draw, IN PHYSICAL ORDER.
 *
 * Never sorted by coordinate, by selection, or by anything a layout
 * direction could influence. The order of this array IS the order of the
 * wire, and several effects - the thrust ring, the rainbow, the Larson
 * sweep and both bars - render by walking exactly this sequence.
 */
export function ledDraftNodes(draft: LedStripDraft): readonly LedDraftNode[] {
  const nodes: LedDraftNode[] = [];
  for (const word of draft.entries) {
    if (isLedTerminatorWord(word)) break;
    nodes.push(nodeOf(nodes.length, word, false));
  }
  if (draft.pending !== undefined) {
    nodes.push(nodeOf(draft.pending.index, draft.pending.raw, true));
  }
  return Object.freeze(nodes);
}

function nodeOf(index: number, raw: number, isPending: boolean): LedDraftNode {
  const entry = decodeLedEntry(raw, index);
  return Object.freeze({
    index,
    number: index + 1,
    raw: entry.raw,
    x: entry.x,
    y: entry.y,
    baseFunction: entry.baseFunction,
    overlayMask: entry.overlayMask,
    colorIndex: entry.colorIndex,
    directionMask: entry.directionMask,
    isPending,
    encodesAsTerminator: isLedTerminatorWord(raw),
  });
}

/** The physical indexes sharing each occupied coordinate, so a cell with
 *  more than one can say so instead of hiding all but the last. */
export function ledDraftCoordinateClusters(
  draft: LedStripDraft,
): ReadonlyMap<string, readonly number[]> {
  const clusters = new Map<string, number[]>();
  for (const node of ledDraftNodes(draft)) {
    const key = `${node.x}:${node.y}`;
    const bucket = clusters.get(key);
    if (bucket === undefined) clusters.set(key, [node.index]);
    else bucket.push(node.index);
  }
  return clusters;
}

export function ledDraftNode(
  draft: LedStripDraft,
  index: number,
): LedDraftNode | undefined {
  return ledDraftNodes(draft).find(node => node.index === index);
}

/* ------------------------------------------------------------------ *
 * SELECTION - reads only, never writes
 * ------------------------------------------------------------------ */

export function selectLed(draft: LedStripDraft, index: number): LedStripDraft {
  const exists = ledDraftNode(draft, index) !== undefined;
  if (!exists) return draft;
  if (!draft.multiSelect) {
    return Object.freeze({...draft, selection: Object.freeze([index])});
  }
  const already = draft.selection.includes(index);
  const next = already
    ? draft.selection.filter(i => i !== index)
    : [...draft.selection, index];
  return Object.freeze({...draft, selection: Object.freeze(next)});
}

export function setLedMultiSelect(draft: LedStripDraft, on: boolean): LedStripDraft {
  if (draft.multiSelect === on) return draft;
  /* Leaving multi-select keeps at most the first pick rather than
     silently editing four LEDs on the next tap. */
  const selection = on ? draft.selection : draft.selection.slice(0, 1);
  return Object.freeze({...draft, multiSelect: on, selection: Object.freeze(selection)});
}

export function clearLedSelection(draft: LedStripDraft): LedStripDraft {
  return Object.freeze({...draft, selection: EMPTY_SELECTION});
}

export function selectAllLeds(draft: LedStripDraft): LedStripDraft {
  const all = ledDraftNodes(draft).map(node => node.index);
  return Object.freeze({...draft, multiSelect: true, selection: Object.freeze(all)});
}

/* ------------------------------------------------------------------ *
 * MIXED VALUES
 * ------------------------------------------------------------------ */

export type LedTriState = 'ON' | 'OFF' | 'MIXED';

/** A field's value across the selection, or `MIXED` when they disagree.
 *  Never the first selected LED's value dressed up as everyone's. */
export function selectedFieldValue(
  draft: LedStripDraft,
  read: (node: LedDraftNode) => number,
): number | 'MIXED' | undefined {
  const nodes = selectedNodes(draft);
  if (nodes.length === 0) return undefined;
  const first = read(nodes[0]);
  return nodes.every(node => read(node) === first) ? first : 'MIXED';
}

export function selectedOverlayState(
  draft: LedStripDraft,
  bit: number,
): LedTriState | undefined {
  return bitTriState(selectedNodes(draft).map(node => (node.overlayMask >>> bit) & 1));
}

export function selectedDirectionState(
  draft: LedStripDraft,
  bit: number,
): LedTriState | undefined {
  return bitTriState(selectedNodes(draft).map(node => (node.directionMask >>> bit) & 1));
}

function bitTriState(bits: readonly number[]): LedTriState | undefined {
  if (bits.length === 0) return undefined;
  if (bits.every(bit => bit === 1)) return 'ON';
  if (bits.every(bit => bit === 0)) return 'OFF';
  return 'MIXED';
}

export function selectedNodes(draft: LedStripDraft): readonly LedDraftNode[] {
  const nodes = ledDraftNodes(draft);
  return Object.freeze(
    draft.selection
      .map(index => nodes.find(node => node.index === index))
      .filter((node): node is LedDraftNode => node !== undefined),
  );
}

/* ------------------------------------------------------------------ *
 * THE OUTCOME OF AN EDIT
 * ------------------------------------------------------------------ */

export type LedEditRefusal =
  /** Nothing was selected, so there was nothing to change. */
  | 'NO_SELECTION'
  /** A coordinate or bit index outside what the packed word can hold. */
  | 'VALUE_OUT_OF_RANGE'
  /**
   * The edit would turn a real LED's word into the strip terminator.
   *
   * x=0, y=0, base function COLOUR (which is 0), colour index 0, no
   * overlays and no directions is a perfectly reasonable thing to want and
   * it serialises to all zeros, which the firmware reads as "the strip
   * ends here". There is no encoding of that LED, so the only honest
   * answer is to refuse the edit and say why.
   */
  | 'WOULD_ENCODE_AS_TERMINATOR'
  /** The board's array has no free slot left. */
  | 'STRIP_FULL'
  /** A new LED is already being created; finish or cancel it first. */
  | 'ALREADY_PENDING'
  /** Deletion was asked for on something that is not the last LED. */
  | 'NOT_LAST'
  /** The strip is already empty. */
  | 'NOTHING_TO_DELETE'
  /** Reordering while a new LED is half-built has no defined meaning. */
  | 'PENDING_BLOCKS_REORDER'
  /** There is no LED on that side to trade places with. */
  | 'NO_NEIGHBOUR';

/**
 * What an edit did, or why it did nothing.
 *
 * A refusal returns the draft UNCHANGED - never a partly applied edit. A
 * multi-selection change where one LED cannot take the new value refuses
 * for the whole selection, because "it worked for three of the four you
 * picked" is a state no operator asked for and none would notice.
 */
export interface LedEditOutcome {
  readonly draft: LedStripDraft;
  readonly refused: LedEditRefusal | undefined;
  /** Physical indexes the refusal is about, when it is about specific LEDs. */
  readonly indexes: readonly number[];
}

const applied = (draft: LedStripDraft): LedEditOutcome =>
  Object.freeze({draft, refused: undefined, indexes: EMPTY_SELECTION});

const refuse = (
  draft: LedStripDraft,
  refused: LedEditRefusal,
  indexes: readonly number[] = EMPTY_SELECTION,
): LedEditOutcome => Object.freeze({draft, refused, indexes: Object.freeze([...indexes])});

/* ------------------------------------------------------------------ *
 * EDITING - patches the word, never rebuilds it
 * ------------------------------------------------------------------ */

/**
 * Apply one field patch to every selected LED.
 *
 * `patch` receives the RAW WORD and returns a new one, so every bit the
 * patch does not name survives: the three reserved overlay bits, a base
 * function value this build has never heard of, and anything a future
 * firmware puts in a field we are not editing.
 *
 * The pending LED is exempt from the terminator guard - it STARTS as all
 * zeros, which is precisely why it is not in the entry array yet.
 */
function patchSelected(
  draft: LedStripDraft,
  patch: (raw: number) => number,
): LedEditOutcome {
  if (draft.selection.length === 0) return refuse(draft, 'NO_SELECTION');
  const live = new Set(ledDraftNodes(draft).map(node => node.index));
  const entries = [...draft.entries];
  let pending = draft.pending;
  const wouldTerminate: number[] = [];
  for (const index of draft.selection) {
    if (!live.has(index)) continue;
    if (pending !== undefined && pending.index === index) {
      pending = Object.freeze({index, raw: patch(pending.raw)});
    } else {
      const next = patch(entries[index]);
      if (isLedTerminatorWord(next)) wouldTerminate.push(index);
      entries[index] = next;
    }
  }
  if (wouldTerminate.length > 0) {
    return refuse(draft, 'WOULD_ENCODE_AS_TERMINATOR', wouldTerminate);
  }
  return applied(Object.freeze({...draft, entries: Object.freeze(entries), pending}));
}

export function setLedPosition(draft: LedStripDraft, x: number, y: number): LedEditOutcome {
  if (!inRange(x) || !inRange(y)) return refuse(draft, 'VALUE_OUT_OF_RANGE');
  return patchSelected(draft, raw => withLedY(withLedX(raw, x), y));
}

export function setLedX(draft: LedStripDraft, x: number): LedEditOutcome {
  if (!inRange(x)) return refuse(draft, 'VALUE_OUT_OF_RANGE');
  return patchSelected(draft, raw => withLedX(raw, x));
}

export function setLedY(draft: LedStripDraft, y: number): LedEditOutcome {
  if (!inRange(y)) return refuse(draft, 'VALUE_OUT_OF_RANGE');
  return patchSelected(draft, raw => withLedY(raw, y));
}

const inRange = (value: number): boolean =>
  Number.isInteger(value) && value >= 0 && value <= LED_COORDINATE_MAX;

export function setLedBaseFunction(draft: LedStripDraft, baseFunction: number): LedEditOutcome {
  if (!inRange(baseFunction)) return refuse(draft, 'VALUE_OUT_OF_RANGE');
  return patchSelected(draft, raw => withLedBaseFunction(raw, baseFunction));
}

/**
 * Set or clear ONE overlay bit across the selection.
 *
 * From a mixed state the first press turns it on for everybody, which is
 * the only unambiguous move: a tri-state control that went to "off" from
 * "mixed" would silently discard whichever LEDs already had it.
 */
export function toggleLedOverlay(draft: LedStripDraft, bit: number): LedEditOutcome {
  if (!Number.isInteger(bit) || bit < 0 || bit >= LED_OVERLAY_BIT_WIDTH) {
    return refuse(draft, 'VALUE_OUT_OF_RANGE');
  }
  const enabled = selectedOverlayState(draft, bit) !== 'ON';
  return patchSelected(draft, raw => withLedOverlayBit(raw, bit, enabled));
}

export function toggleLedDirection(draft: LedStripDraft, bit: number): LedEditOutcome {
  if (!Number.isInteger(bit) || bit < 0 || bit >= LED_DIRECTION_BIT_WIDTH) {
    return refuse(draft, 'VALUE_OUT_OF_RANGE');
  }
  const enabled = selectedDirectionState(draft, bit) !== 'ON';
  return patchSelected(draft, raw => withLedDirectionBit(raw, bit, enabled));
}

export function setLedColorIndex(draft: LedStripDraft, colorIndex: number): LedEditOutcome {
  if (!Number.isInteger(colorIndex) || colorIndex < 0 || colorIndex > LED_COLOR_INDEX_MAX) {
    return refuse(draft, 'VALUE_OUT_OF_RANGE');
  }
  return patchSelected(draft, raw => withLedColorIndex(raw, colorIndex));
}

/* ------------------------------------------------------------------ *
 * ADDING AND REMOVING
 * ------------------------------------------------------------------ */

/**
 * Start a new LED at the next physical index, and only there.
 *
 * There is no "add LED 7" while five and six do not exist: the firmware
 * counts from index zero and stops at the first empty word, so a strip
 * numbered 1,2,3,7 is a strip of three.
 */
export function appendLed(draft: LedStripDraft): LedEditOutcome {
  if (draft.pending !== undefined) return refuse(draft, 'ALREADY_PENDING');
  const index = draftEffectiveCount(draft);
  if (index >= draft.observed.maxLength) return refuse(draft, 'STRIP_FULL');
  return applied(
    Object.freeze({
      ...draft,
      pending: Object.freeze({index, raw: 0}),
      selection: Object.freeze([index]),
    }),
  );
}

/** Abandon the LED being created. */
export function cancelPendingLed(draft: LedStripDraft): LedStripDraft {
  const pending = draft.pending;
  if (pending === undefined) return draft;
  return Object.freeze({
    ...draft,
    pending: undefined,
    selection: Object.freeze(draft.selection.filter(i => i !== pending.index)),
  });
}

/**
 * Remove the LAST physical LED, and refuse anything else.
 *
 * Zeroing a middle entry would put a terminator in the middle of the
 * chain, and every LED after it would stop rendering while still sitting
 * in the board's memory. Shifting the later entries down instead would
 * silently reassign which physical LED on the aircraft carries which
 * configuration, which is a different aircraft, not a smaller edit.
 */
export function deleteLastLed(draft: LedStripDraft): LedEditOutcome {
  if (draft.pending !== undefined) return applied(cancelPendingLed(draft));
  const count = draftEffectiveCount(draft);
  if (count === 0) return refuse(draft, 'NOTHING_TO_DELETE');
  const entries = [...draft.entries];
  entries[count - 1] = 0;
  return applied(
    Object.freeze({
      ...draft,
      entries: Object.freeze(entries),
      selection: Object.freeze(draft.selection.filter(i => i !== count - 1)),
    }),
  );
}

/** Whether the selected LED may be removed, and why not when it may not. */
export function canDeleteSelectedLed(
  draft: LedStripDraft,
): {readonly allowed: true} | {readonly allowed: false; readonly reason: LedEditRefusal} {
  const count = draftEffectiveCount(draft);
  if (count === 0) return {allowed: false, reason: 'NOTHING_TO_DELETE'};
  if (draft.selection.length !== 1) return {allowed: false, reason: 'NOT_LAST'};
  return draft.selection[0] === count - 1
    ? {allowed: true}
    : {allowed: false, reason: 'NOT_LAST'};
}

/* ------------------------------------------------------------------ *
 * PHYSICAL WIRE ORDER
 * ------------------------------------------------------------------ */

/**
 * Swap an LED with its neighbour in the chain.
 *
 * The WHOLE word moves, so the coordinates, the function, every overlay
 * bit including the reserved ones, the colour and every direction travel
 * together. Reconstructing an entry from the fields the editor happens to
 * display is how unknown bits get quietly dropped, and a reorder is
 * exactly where nobody would look for that.
 *
 * A permutation of a contiguous prefix stays a contiguous prefix, so this
 * operation can never author a gap.
 */
export function moveLedEarlier(draft: LedStripDraft, index: number): LedEditOutcome {
  return swapEntries(draft, index, index - 1);
}

export function moveLedLater(draft: LedStripDraft, index: number): LedEditOutcome {
  return swapEntries(draft, index, index + 1);
}

function swapEntries(draft: LedStripDraft, a: number, b: number): LedEditOutcome {
  if (draft.pending !== undefined) return refuse(draft, 'PENDING_BLOCKS_REORDER');
  const count = draftEffectiveCount(draft);
  if (a < 0 || a >= count) return refuse(draft, 'NO_NEIGHBOUR', [a]);
  if (b < 0 || b >= count) return refuse(draft, 'NO_NEIGHBOUR', [a]);
  const entries = [...draft.entries];
  const carried = entries[a];
  entries[a] = entries[b];
  entries[b] = carried;
  const selection = draft.selection.map(i => (i === a ? b : i === b ? a : i));
  return applied(
    Object.freeze({
      ...draft,
      entries: Object.freeze(entries),
      selection: Object.freeze(selection),
    }),
  );
}

/* ------------------------------------------------------------------ *
 * THE OTHER THREE GROUPS
 * ------------------------------------------------------------------ */

export function setLedPaletteSlot(
  draft: LedStripDraft,
  slot: number,
  color: LedPaletteEntry,
): LedStripDraft {
  const observed = draft.observed.palette?.[slot];
  const palette = new Map(draft.palette);
  if (observed !== undefined && ledPaletteColorsEqual(observed, color)) {
    /* Back to where the board already is: no longer an edit. */
    palette.delete(slot);
  } else {
    palette.set(slot, Object.freeze({...color}));
  }
  return Object.freeze({...draft, palette});
}

export function setLedModeColor(
  draft: LedStripDraft,
  mode: number,
  slot: number,
  value: number,
): LedStripDraft {
  const observed = draft.observed.modeColors?.find(t => t.mode === mode && t.slot === slot);
  const others = draft.modeColors.filter(t => !(t.mode === mode && t.slot === slot));
  const next =
    observed !== undefined && observed.value === value
      ? others
      : [...others, Object.freeze({mode, slot, value})];
  return Object.freeze({...draft, modeColors: Object.freeze(next)});
}

/**
 * THE FIRMWARE'S OWN WRITE BOUNDS, restated where a draft can be refused
 * against them.
 *
 * These are the setting-table limits the encoder enforces, not a slider's.
 * The encoder throws a `RangeError` on a value outside them - which is
 * correct for a byte-builder and useless to an operator, because by then
 * the save is already in flight. Refusing the DRAFT turns that crash into
 * a sentence.
 */
const RUNTIME_BOUNDS: Readonly<
  Record<LedRuntimeValueField, {readonly min: number; readonly max: number}>
> = Object.freeze({
  brightness: {min: LED_BRIGHTNESS_MIN, max: LED_BRIGHTNESS_MAX},
  rainbowDelta: {min: LED_RAINBOW_DELTA_MIN, max: LED_RAINBOW_DELTA_MAX},
  rainbowFreq: {min: LED_RAINBOW_FREQ_MIN, max: LED_RAINBOW_FREQ_MAX},
});

export function ledRuntimeBounds(field: LedRuntimeValueField): {
  readonly min: number;
  readonly max: number;
} {
  return RUNTIME_BOUNDS[field];
}

/**
 * Whether a value is one the firmware would accept as a WRITE.
 *
 * A board may REPORT something outside this - `ledstrip_brightness` 0 is a
 * real observation and is displayed truthfully - but it is not something
 * this app may send back.
 */
export function ledRuntimeValueWritable(
  field: LedRuntimeValueField,
  value: number,
): boolean {
  const {min, max} = RUNTIME_BOUNDS[field];
  return Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Edit one runtime value.
 *
 * REFUSES ANYTHING THE FIRMWARE WOULD NOT TAKE. Returning to the board's
 * own observed value is always allowed even when that value is outside the
 * write range, because that is not an edit - it is putting back what was
 * there, and it drops the field from the owned set so nothing is sent.
 */
export function setLedRuntimeValue(
  draft: LedStripDraft,
  field: LedRuntimeValueField,
  value: number,
): LedEditOutcome {
  const observed = draft.observed.runtimeValues[field];
  if (observed === value) {
    const cleared = {...draft.runtimeValues};
    delete cleared[field];
    return applied(Object.freeze({...draft, runtimeValues: Object.freeze(cleared)}));
  }
  if (!ledRuntimeValueWritable(field, value)) {
    return refuse(draft, 'VALUE_OUT_OF_RANGE');
  }
  const runtimeValues = {...draft.runtimeValues, [field]: value};
  return applied(Object.freeze({...draft, runtimeValues: Object.freeze(runtimeValues)}));
}

/* ------------------------------------------------------------------ *
 * WHAT CHANGED, AND WHETHER IT CAN BE SAVED
 * ------------------------------------------------------------------ */

export function ledDraftDirtyGroups(draft: LedStripDraft): readonly LedSaveGroup[] {
  const groups: LedSaveGroup[] = [];
  const observedRaw = rawsOf(draft.observed.entries);
  const entriesChanged =
    draft.pending !== undefined ||
    draft.entries.length !== observedRaw.length ||
    draft.entries.some((word, i) => word !== observedRaw[i]);
  if (entriesChanged) groups.push('ENTRIES');
  if (draft.palette.size > 0) groups.push('PALETTE');
  if (draft.modeColors.length > 0) groups.push('MODE_COLORS');
  if (Object.keys(draft.runtimeValues).length > 0) groups.push('RUNTIME_VALUES');
  return Object.freeze(groups);
}

export type LedSaveBlocker =
  | 'NO_CHANGES'
  /** A new LED is still all zeros, which is the strip terminator. */
  | 'PENDING_LED_ENCODES_AS_TERMINATOR'
  /** The target array carries a configured entry past a terminator. */
  | 'DRAFT_HAS_GAP'
  /** The board arrived already truncated; repairing it is not a save. */
  | 'OBSERVED_STRIP_HAS_GAP'
  /** An edited group needs the status-mode build this board does not have. */
  | 'ADVANCED_CAPABILITY_REQUIRED';

/**
 * Every reason this draft must not be sent, gathered before the button is
 * ever enabled rather than discovered by the controller mid-transaction.
 *
 * `DRAFT_HAS_GAP` IS AN ASSERTION, NOT A USER-REACHABLE STATE, and saying
 * so is worth more than letting a reader assume it guards something. No
 * editing operation in this module can author a middle hole - appends only
 * extend, deletion only shortens, reorder only permutes a contiguous
 * prefix, and an edit that would zero a live LED is refused where it is
 * made. It can therefore only fire on a board that arrived with a gap, in
 * which case `OBSERVED_STRIP_HAS_GAP` fires beside it. It stays because it
 * is computed over the array a save would actually send, and that array is
 * the thing the claim is about.
 */
export function ledDraftSaveBlockers(draft: LedStripDraft): readonly LedSaveBlocker[] {
  const blockers: LedSaveBlocker[] = [];
  const groups = ledDraftDirtyGroups(draft);
  if (groups.length === 0) blockers.push('NO_CHANGES');

  if (draft.pending !== undefined && isLedTerminatorWord(draft.pending.raw)) {
    blockers.push('PENDING_LED_ENCODES_AS_TERMINATOR');
  }

  /* THE BOARD'S OWN GAP COMES FIRST, because it is the root cause and the
     only one the operator can act on: the draft can only inherit a hole,
     never author one. Reporting the derived assertion ahead of it would
     hand them a sentence about their own edit for a state that arrived
     with the board. */
  const observedTruth = deriveLedStripTruth(draft.observed.entries, draft.observed.maxLength);
  if (observedTruth.gapDetected) blockers.push('OBSERVED_STRIP_HAS_GAP');

  const target = buildTargetEntries(draft);
  const truth = deriveLedStripTruth(
    target.map((word, index) => decodeLedEntry(word, index)),
    draft.observed.maxLength,
  );
  if (truth.gapDetected) blockers.push('DRAFT_HAS_GAP');

  const needsAdvanced = groups.includes('PALETTE') || groups.includes('MODE_COLORS');
  if (needsAdvanced && draft.observed.capability !== 'ADVANCED_STATUS_MODE') {
    blockers.push('ADVANCED_CAPABILITY_REQUIRED');
  }
  return Object.freeze(blockers);
}

/** The target array a save would send: the committed entries, plus the
 *  pending LED only once it is a real one. */
export function buildTargetEntries(draft: LedStripDraft): readonly number[] {
  const target = [...draft.entries];
  const pending = draft.pending;
  if (pending !== undefined && !isLedTerminatorWord(pending.raw)) {
    target[pending.index] = pending.raw;
  }
  return Object.freeze(target);
}

/** The four owned groups, in the shape the controller's save takes. */
export function buildLedSaveRequest(draft: LedStripDraft): {
  readonly entries?: {readonly target: readonly number[]; readonly declaredEffectiveCount: number};
  readonly palette?: ReadonlyMap<number, LedPaletteEntry>;
  readonly modeColors?: readonly LedModeColorWrite[];
  readonly runtimeValues?: Partial<LedRuntimeValues>;
} {
  const groups = ledDraftDirtyGroups(draft);
  const target = buildTargetEntries(draft);
  const truth = deriveLedStripTruth(
    target.map((word, index) => decodeLedEntry(word, index)),
    draft.observed.maxLength,
  );
  return Object.freeze({
    ...(groups.includes('ENTRIES')
      ? {entries: {target, declaredEffectiveCount: truth.effectiveCount}}
      : {}),
    ...(groups.includes('PALETTE') ? {palette: draft.palette} : {}),
    ...(groups.includes('MODE_COLORS') ? {modeColors: draft.modeColors} : {}),
    ...(groups.includes('RUNTIME_VALUES') ? {runtimeValues: draft.runtimeValues} : {}),
  });
}

/** The palette a swatch row should draw: board truth, with the operator's
 *  unsaved edits on top. Never a hard-coded default table. */
export function draftPalette(draft: LedStripDraft): readonly LedPaletteEntry[] | undefined {
  const observed = draft.observed.palette;
  if (observed === undefined) return undefined;
  return Object.freeze(
    observed.map((color, slot) => draft.palette.get(slot) ?? Object.freeze({...color})),
  );
}

/** The value a mode-colour control should show: board truth plus edits. */
export function draftModeColorValue(
  draft: LedStripDraft,
  mode: number,
  slot: number,
): number | undefined {
  const owned = draft.modeColors.find(t => t.mode === mode && t.slot === slot);
  if (owned !== undefined) return owned.value;
  return draft.observed.modeColors?.find(t => t.mode === mode && t.slot === slot)?.value;
}

/** The runtime value a control should show: board truth plus edits. */
export function draftRuntimeValue(
  draft: LedStripDraft,
  field: LedRuntimeValueField,
): number {
  return draft.runtimeValues[field] ?? draft.observed.runtimeValues[field];
}

/** A word built from explicit fields, for a caller that has all of them.
 *  Exists so a screen never hand-rolls the bit arithmetic. */
export function composeLedWord(fields: {
  readonly x: number;
  readonly y: number;
  readonly baseFunction: number;
  readonly overlayMask: number;
  readonly colorIndex: number;
  readonly directionMask: number;
}): number {
  return encodeLedEntry(fields);
}
