/* eslint-disable no-bitwise -- the expectations read single bits out of the
 * overlay and direction masks, because that is what the firmware stores. */
/**
 * THE DRAFT ENGINE'S SAFETY RULES, PROVEN.
 *
 * EVERY ENTRY WORD IN THIS FILE IS HAND-AUTHORED IN HEX AND ITS FIELD
 * DECOMPOSITION IS WRITTEN OUT BESIDE IT. Nothing here is produced by
 * `encodeLedEntry`, so a bug that lived in both the encoder and the editor
 * would still fail these tests instead of agreeing with itself. The first
 * test in the file exists purely to prove the hand-authored words really do
 * carry the fields the rest of the file assumes.
 */

import {
  appendLed,
  buildLedSaveRequest,
  buildTargetEntries,
  canDeleteSelectedLed,
  cancelPendingLed,
  clearLedSelection,
  composeLedWord,
  createLedStripDraft,
  deleteLastLed,
  discardLedStripDraft,
  draftEffectiveCount,
  draftModeColorValue,
  draftPalette,
  draftRuntimeValue,
  ledDraftCoordinateClusters,
  ledDraftDirtyGroups,
  ledDraftNode,
  ledDraftNodes,
  ledDraftSaveBlockers,
  moveLedEarlier,
  moveLedLater,
  selectAllLeds,
  selectedDirectionState,
  selectedFieldValue,
  selectedNodes,
  selectedOverlayState,
  selectLed,
  setLedBaseFunction,
  setLedColorIndex,
  setLedModeColor,
  setLedMultiSelect,
  setLedPaletteSlot,
  setLedPosition,
  setLedRuntimeValue,
  setLedX,
  setLedY,
  toggleLedDirection,
  toggleLedOverlay,
  type LedDraftObserved,
  type LedStripDraft,
} from './ledStripDraft';
import {
  decodeLedEntry,
  LedDirectionBit,
  LedOverlayBit,
  LED_OVERLAY_RESERVED_MASK,
} from '../protocol/msp/decoding/ledStripWireContract';
import {
  F11_MODECOLOR_EXPECTED,
  F12_CONFIG_VALUES_EXPECTED,
  F9_PALETTE_EXPECTED,
} from '../protocol/msp/__testUtils__/ledStripFixtures';

/* ------------------------------------------------------------------ *
 * HAND-AUTHORED ENTRY WORDS
 *
 * bit 31            26 25   22 21          12 11  8 7  4 3  0
 *    | DIRECTION 6    | COLOR 4 | OVERLAY 10   | FN 4 | X 4 | Y 4 |
 * ------------------------------------------------------------------ */

/** dir=NORTH(1) colour=1 overlay=0 fn=1 x=0 y=0 */
const WORD_A = 0x04400100;
/** dir=0 colour=2 overlay=0 fn=0 x=15 y=0 */
const WORD_B = 0x008000f0;
/** dir=EAST|WEST(0b001010) colour=3 overlay=0b1110000001 fn=6 x=8 y=15 */
const WORD_C = 0x28f8168f;
/** dir=0 colour=0 overlay=0 fn=15 (unknown) x=1 y=1 */
const WORD_D = 0x00000f11;
/** dir=0 colour=0 overlay=0 fn=0 x=1 y=0 - ONE EDIT AWAY FROM THE TERMINATOR */
const WORD_E = 0x00000010;

const PALETTE = F9_PALETTE_EXPECTED;
const MODE_COLORS = F11_MODECOLOR_EXPECTED;
const RUNTIME = F12_CONFIG_VALUES_EXPECTED;

function observedOf(
  words: readonly number[],
  overrides: Partial<LedDraftObserved> = {},
): LedDraftObserved {
  const maxLength = overrides.maxLength ?? 8;
  const padded = [...words];
  while (padded.length < maxLength) padded.push(0);
  return Object.freeze({
    capability: 'ADVANCED_STATUS_MODE' as const,
    palette: PALETTE,
    modeColors: MODE_COLORS,
    runtimeValues: RUNTIME,
    ...overrides,
    maxLength,
    entries: Object.freeze(padded.slice(0, maxLength).map((word, i) => decodeLedEntry(word, i))),
  });
}

const draftOf = (words: readonly number[], overrides?: Partial<LedDraftObserved>): LedStripDraft =>
  createLedStripDraft(observedOf(words, overrides));

/** Unwrap an outcome that must have succeeded. */
function ok(outcome: {
  readonly draft: LedStripDraft;
  readonly refused: string | undefined;
}): LedStripDraft {
  expect(outcome.refused).toBeUndefined();
  return outcome.draft;
}

describe('hand-authored entry words carry the fields the suite assumes', () => {
  it.each([
    ['WORD_A', WORD_A, {x: 0, y: 0, baseFunction: 1, overlayMask: 0, colorIndex: 1, directionMask: 0b000001}],
    ['WORD_B', WORD_B, {x: 15, y: 0, baseFunction: 0, overlayMask: 0, colorIndex: 2, directionMask: 0}],
    ['WORD_C', WORD_C, {x: 8, y: 15, baseFunction: 6, overlayMask: 0b1110000001, colorIndex: 3, directionMask: 0b001010}],
    ['WORD_D', WORD_D, {x: 1, y: 1, baseFunction: 15, overlayMask: 0, colorIndex: 0, directionMask: 0}],
    ['WORD_E', WORD_E, {x: 1, y: 0, baseFunction: 0, overlayMask: 0, colorIndex: 0, directionMask: 0}],
  ])('%s', (_name, word, fields) => {
    const entry = decodeLedEntry(word, 0);
    expect({
      x: entry.x,
      y: entry.y,
      baseFunction: entry.baseFunction,
      overlayMask: entry.overlayMask,
      colorIndex: entry.colorIndex,
      directionMask: entry.directionMask,
    }).toEqual(fields);
  });

  it('WORD_C carries all three reserved overlay bits, which is what makes it the preservation probe', () => {
    expect(decodeLedEntry(WORD_C, 0).overlayMask & LED_OVERLAY_RESERVED_MASK).toBe(
      LED_OVERLAY_RESERVED_MASK,
    );
  });
});

/* ================================================================== *
 * READING THE DRAFT
 * ================================================================== */

describe('reading the draft', () => {
  it('stops at the first terminator, exactly like the firmware counts', () => {
    const draft = draftOf([WORD_A, WORD_B, 0, WORD_C]);
    expect(ledDraftNodes(draft).map(node => node.raw)).toEqual([WORD_A, WORD_B]);
    expect(draftEffectiveCount(draft)).toBe(2);
  });

  it('numbers LEDs from 1 while the index stays the wire index', () => {
    const nodes = ledDraftNodes(draftOf([WORD_A, WORD_B, WORD_C]));
    expect(nodes.map(node => [node.index, node.number])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
  });

  it('keeps physical order even when the coordinates run the other way', () => {
    /* WORD_B is at x=15 and comes first; a grid- or RTL-driven sort would
       put it last. The wire order is the render order for every ordinal
       effect, so it is the only order this function may produce. */
    const nodes = ledDraftNodes(draftOf([WORD_B, WORD_A]));
    expect(nodes.map(node => node.x)).toEqual([15, 0]);
    expect(nodes.map(node => node.index)).toEqual([0, 1]);
  });

  it('reports both LEDs of a shared coordinate instead of hiding one', () => {
    /* Two entries at x=1,y=1: WORD_D and a copy of it with a colour. */
    const twin = (WORD_D | (5 << 22)) >>> 0;
    const clusters = ledDraftCoordinateClusters(draftOf([WORD_D, twin]));
    expect(clusters.get('1:1')).toEqual([0, 1]);
  });

  it('has no node for an index past the effective run', () => {
    const draft = draftOf([WORD_A]);
    expect(ledDraftNode(draft, 0)).toBeDefined();
    expect(ledDraftNode(draft, 1)).toBeUndefined();
  });

  it('counts the pending LED even though it is not in the entry array', () => {
    const draft = ok(appendLed(draftOf([WORD_A])));
    expect(draftEffectiveCount(draft)).toBe(2);
    expect(draft.entries[1]).toBe(0);
  });
});

/* ================================================================== *
 * SELECTION NEVER EDITS
 * ================================================================== */

describe('selection never edits', () => {
  const words = [WORD_A, WORD_B, WORD_C];

  it('leaves every entry word untouched no matter what is selected', () => {
    let draft = draftOf(words);
    const before = [...draft.entries];
    for (const index of [0, 1, 2, 2, 0, 1]) draft = selectLed(draft, index);
    draft = setLedMultiSelect(draft, true);
    for (const index of [0, 1, 2]) draft = selectLed(draft, index);
    draft = selectAllLeds(draft);
    draft = clearLedSelection(draft);
    expect([...draft.entries]).toEqual(before);
    expect(ledDraftDirtyGroups(draft)).toEqual([]);
  });

  it('does not create an entry for a cell that holds no LED', () => {
    const draft = draftOf([WORD_A]);
    const after = selectLed(draft, 4);
    expect(after).toBe(draft);
    expect(after.selection).toEqual([]);
    expect(ledDraftDirtyGroups(after)).toEqual([]);
  });

  it('replaces the pick in single mode and toggles it in multi mode', () => {
    let draft = draftOf(words);
    draft = selectLed(selectLed(draft, 0), 2);
    expect(draft.selection).toEqual([2]);

    draft = setLedMultiSelect(draft, true);
    draft = selectLed(selectLed(draft, 0), 1);
    expect(draft.selection).toEqual([2, 0, 1]);
    draft = selectLed(draft, 0);
    expect(draft.selection).toEqual([2, 1]);
  });

  it('keeps at most one LED when multi-select is switched off', () => {
    let draft = setLedMultiSelect(draftOf(words), true);
    draft = selectAllLeds(draft);
    expect(draft.selection).toHaveLength(3);
    draft = setLedMultiSelect(draft, false);
    expect(draft.selection).toHaveLength(1);
  });

  it('selects every LED and nothing beyond the effective run', () => {
    const draft = selectAllLeds(draftOf([WORD_A, WORD_B, 0, WORD_C]));
    expect(draft.selection).toEqual([0, 1]);
    expect(draft.multiSelect).toBe(true);
  });
});

/* ================================================================== *
 * MIXED VALUES
 * ================================================================== */

describe('mixed values across a multi-selection', () => {
  it('reports one shared value, or MIXED, or nothing at all', () => {
    const empty = draftOf([WORD_A, WORD_B]);
    expect(selectedFieldValue(empty, node => node.colorIndex)).toBeUndefined();

    const one = selectLed(empty, 0);
    expect(selectedFieldValue(one, node => node.colorIndex)).toBe(1);

    const both = selectAllLeds(empty);
    expect(selectedFieldValue(both, node => node.colorIndex)).toBe('MIXED');
    expect(selectedFieldValue(both, node => node.y)).toBe(0);
  });

  it('reports overlay and direction bits as ON, OFF or MIXED', () => {
    const draft = draftOf([WORD_A, WORD_C]);
    expect(selectedOverlayState(draft, LedOverlayBit.THROTTLE)).toBeUndefined();

    const onlyC = selectLed(draft, 1);
    expect(selectedOverlayState(onlyC, LedOverlayBit.THROTTLE)).toBe('ON');
    expect(selectedOverlayState(onlyC, LedOverlayBit.BLINK)).toBe('OFF');
    expect(selectedDirectionState(onlyC, LedDirectionBit.EAST)).toBe('ON');
    expect(selectedDirectionState(onlyC, LedDirectionBit.NORTH)).toBe('OFF');

    const both = selectAllLeds(draft);
    expect(selectedOverlayState(both, LedOverlayBit.THROTTLE)).toBe('MIXED');
    expect(selectedDirectionState(both, LedDirectionBit.NORTH)).toBe('MIXED');
    expect(selectedDirectionState(both, LedDirectionBit.UP)).toBe('OFF');
  });

  it('returns the selected nodes in selection order, not in physical order', () => {
    let draft = setLedMultiSelect(draftOf([WORD_A, WORD_B, WORD_C]), true);
    draft = selectLed(selectLed(draft, 2), 0);
    expect(selectedNodes(draft).map(node => node.index)).toEqual([2, 0]);
  });
});

/* ================================================================== *
 * EDITING PRESERVES EVERY BIT IT DOES NOT NAME
 * ================================================================== */

describe('editing patches the word and never rebuilds it', () => {
  const reservedProbe = () => selectLed(draftOf([WORD_C]), 0);

  it('keeps the three reserved overlay bits through a base-function change', () => {
    const after = ok(setLedBaseFunction(reservedProbe(), 3));
    const entry = decodeLedEntry(after.entries[0], 0);
    expect(entry.baseFunction).toBe(3);
    expect(entry.overlayMask & LED_OVERLAY_RESERVED_MASK).toBe(LED_OVERLAY_RESERVED_MASK);
    expect(entry.directionMask).toBe(0b001010);
    expect(entry.colorIndex).toBe(3);
  });

  it('keeps an unknown base-function value through a colour change', () => {
    const after = ok(setLedColorIndex(selectLed(draftOf([WORD_D]), 0), 9));
    const entry = decodeLedEntry(after.entries[0], 0);
    expect(entry.baseFunction).toBe(15);
    expect(entry.colorIndex).toBe(9);
  });

  it('toggling one overlay leaves the other nine bits alone', () => {
    const before = decodeLedEntry(WORD_C, 0).overlayMask;
    const after = ok(toggleLedOverlay(reservedProbe(), LedOverlayBit.BLINK));
    const mask = decodeLedEntry(after.entries[0], 0).overlayMask;
    expect(mask ^ before).toBe(1 << LedOverlayBit.BLINK);

    const back = ok(toggleLedOverlay(selectLed(after, 0), LedOverlayBit.BLINK));
    expect(decodeLedEntry(back.entries[0], 0).overlayMask).toBe(before);
  });

  it('turns a MIXED overlay ON for everyone rather than clearing the ones that had it', () => {
    const draft = selectAllLeds(draftOf([WORD_A, WORD_C]));
    expect(selectedOverlayState(draft, LedOverlayBit.THROTTLE)).toBe('MIXED');
    const after = ok(toggleLedOverlay(draft, LedOverlayBit.THROTTLE));
    expect(selectedOverlayState(after, LedOverlayBit.THROTTLE)).toBe('ON');
  });

  it('toggling one direction never collapses the mask to a single direction', () => {
    const after = ok(toggleLedDirection(reservedProbe(), LedDirectionBit.UP));
    const mask = decodeLedEntry(after.entries[0], 0).directionMask;
    expect(mask).toBe(0b011010);
    expect(mask & (1 << LedDirectionBit.EAST)).toBeTruthy();
    expect(mask & (1 << LedDirectionBit.WEST)).toBeTruthy();
  });

  it('applies a coordinate change to every selected LED and to nothing else', () => {
    let draft = setLedMultiSelect(draftOf([WORD_A, WORD_B, WORD_C]), true);
    draft = selectLed(selectLed(draft, 0), 2);
    const after = ok(setLedPosition(draft, 4, 6));
    expect(ledDraftNodes(after).map(node => [node.x, node.y])).toEqual([
      [4, 6],
      [15, 0],
      [4, 6],
    ]);
  });

  it('refuses a coordinate the packed nibble cannot hold, and changes nothing', () => {
    const draft = selectLed(draftOf([WORD_A]), 0);
    for (const bad of [-1, 16, 1.5, Number.NaN]) {
      const outcome = setLedX(draft, bad);
      expect(outcome.refused).toBe('VALUE_OUT_OF_RANGE');
      expect(outcome.draft).toBe(draft);
    }
    expect(setLedY(draft, 16).refused).toBe('VALUE_OUT_OF_RANGE');
    expect(setLedPosition(draft, 0, 16).refused).toBe('VALUE_OUT_OF_RANGE');
    expect(setLedColorIndex(draft, 16).refused).toBe('VALUE_OUT_OF_RANGE');
    expect(setLedBaseFunction(draft, 16).refused).toBe('VALUE_OUT_OF_RANGE');
    expect(toggleLedOverlay(draft, 10).refused).toBe('VALUE_OUT_OF_RANGE');
    expect(toggleLedDirection(draft, 6).refused).toBe('VALUE_OUT_OF_RANGE');
  });

  it('accepts both ends of the coordinate range', () => {
    const draft = selectLed(draftOf([WORD_A]), 0);
    expect(ledDraftNodes(ok(setLedPosition(draft, 0, 0)))[0]).toMatchObject({x: 0, y: 0});
    expect(ledDraftNodes(ok(setLedPosition(draft, 15, 15)))[0]).toMatchObject({x: 15, y: 15});
  });

  it('does nothing at all when nothing is selected', () => {
    const draft = draftOf([WORD_A, WORD_B]);
    for (const outcome of [
      setLedX(draft, 3),
      setLedY(draft, 3),
      setLedPosition(draft, 3, 3),
      setLedBaseFunction(draft, 2),
      setLedColorIndex(draft, 2),
      toggleLedOverlay(draft, LedOverlayBit.BLINK),
      toggleLedDirection(draft, LedDirectionBit.NORTH),
    ]) {
      expect(outcome.refused).toBe('NO_SELECTION');
      expect(outcome.draft).toBe(draft);
    }
  });
});

/* ================================================================== *
 * THE ZERO WORD IS NOT AN LED
 * ================================================================== */

describe('an edit that would serialise an LED to the terminator is refused', () => {
  it('refuses, names the LED, and leaves the draft exactly as it was', () => {
    /* WORD_E is x=1 and nothing else, so clearing x makes it all zeros. */
    const draft = selectLed(draftOf([WORD_A, WORD_E]), 1);
    const outcome = setLedX(draft, 0);
    expect(outcome.refused).toBe('WOULD_ENCODE_AS_TERMINATOR');
    expect(outcome.indexes).toEqual([1]);
    expect(outcome.draft).toBe(draft);
    expect(draftEffectiveCount(outcome.draft)).toBe(2);
  });

  it('refuses the WHOLE multi-selection rather than applying it to the LEDs it fits', () => {
    let draft = setLedMultiSelect(draftOf([WORD_B, WORD_E]), true);
    draft = selectAllLeds(draft);
    /* x=0 is fine for WORD_B (it keeps colour 2) and fatal for WORD_E. */
    const outcome = setLedX(draft, 0);
    expect(outcome.refused).toBe('WOULD_ENCODE_AS_TERMINATOR');
    expect(outcome.indexes).toEqual([1]);
    expect([...outcome.draft.entries]).toEqual([...draft.entries]);
  });

  it('allows the same edit once the LED carries something else', () => {
    let draft = selectLed(draftOf([WORD_E]), 0);
    draft = ok(setLedColorIndex(draft, 4));
    const after = ok(setLedX(draft, 0));
    expect(ledDraftNodes(after)[0]).toMatchObject({x: 0, y: 0, colorIndex: 4});
    expect(draftEffectiveCount(after)).toBe(1);
  });

  it('lets a pending LED sit at all-zeros, because that is where it starts', () => {
    const draft = ok(appendLed(draftOf([WORD_A])));
    expect(draft.pending).toEqual({index: 1, raw: 0});
    const outcome = setLedX(draft, 0);
    expect(outcome.refused).toBeUndefined();
    expect(outcome.draft.pending).toEqual({index: 1, raw: 0});
  });
});

/* ================================================================== *
 * APPENDING
 * ================================================================== */

describe('appending an LED', () => {
  it('opens the next physical index and selects it, and no further index', () => {
    const draft = ok(appendLed(draftOf([WORD_A, WORD_B])));
    expect(draft.pending).toEqual({index: 2, raw: 0});
    expect(draft.selection).toEqual([2]);
  });

  it('appends at index 0 on a strip with no LEDs at all', () => {
    const draft = ok(appendLed(draftOf([])));
    expect(draft.pending).toEqual({index: 0, raw: 0});
  });

  it('refuses a second pending LED', () => {
    const draft = ok(appendLed(draftOf([WORD_A])));
    const outcome = appendLed(draft);
    expect(outcome.refused).toBe('ALREADY_PENDING');
    expect(outcome.draft).toBe(draft);
  });

  it('refuses once the board array is full', () => {
    const full = draftOf([WORD_A, WORD_B, WORD_C], {maxLength: 3});
    expect(appendLed(full).refused).toBe('STRIP_FULL');
  });

  it('keeps a still-empty pending LED out of the array a save would send', () => {
    const draft = ok(appendLed(draftOf([WORD_A])));
    expect(buildTargetEntries(draft)[1]).toBe(0);
    expect(ledDraftSaveBlockers(draft)).toContain('PENDING_LED_ENCODES_AS_TERMINATOR');
  });

  it('commits the pending LED into the target as soon as its word is non-zero', () => {
    let draft = ok(appendLed(draftOf([WORD_A])));
    draft = ok(setLedPosition(draft, 3, 4));
    expect(draft.pending?.raw).not.toBe(0);
    expect(ledDraftSaveBlockers(draft)).not.toContain('PENDING_LED_ENCODES_AS_TERMINATOR');
    const target = buildTargetEntries(draft);
    expect(decodeLedEntry(target[1], 1)).toMatchObject({x: 3, y: 4});
    expect(ledDraftDirtyGroups(draft)).toContain('ENTRIES');
  });

  it('never invents a firmware default to get the new LED out of the zero state', () => {
    const draft = ok(appendLed(draftOf([WORD_A])));
    expect(draft.pending?.raw).toBe(0);
    expect(ledDraftNodes(draft)[1]).toMatchObject({
      isPending: true,
      encodesAsTerminator: true,
      baseFunction: 0,
      colorIndex: 0,
      overlayMask: 0,
      directionMask: 0,
    });
  });

  it('drops the pending LED and its selection when it is cancelled', () => {
    const draft = ok(appendLed(draftOf([WORD_A])));
    const after = cancelPendingLed(draft);
    expect(after.pending).toBeUndefined();
    expect(after.selection).toEqual([]);
    expect(ledDraftDirtyGroups(after)).toEqual([]);
  });
});

/* ================================================================== *
 * DELETING
 * ================================================================== */

describe('deleting an LED', () => {
  it('zeroes the last index and only the last index', () => {
    const after = ok(deleteLastLed(draftOf([WORD_A, WORD_B, WORD_C])));
    expect([...after.entries].slice(0, 3)).toEqual([WORD_A, WORD_B, 0]);
    expect(draftEffectiveCount(after)).toBe(2);
    expect(ledDraftSaveBlockers(after)).not.toContain('DRAFT_HAS_GAP');
  });

  it('cancels the pending LED instead of shortening the committed strip', () => {
    const draft = ok(appendLed(draftOf([WORD_A, WORD_B])));
    const after = ok(deleteLastLed(draft));
    expect(after.pending).toBeUndefined();
    expect([...after.entries].slice(0, 2)).toEqual([WORD_A, WORD_B]);
    expect(ledDraftDirtyGroups(after)).toEqual([]);
  });

  it('refuses on an empty strip', () => {
    const draft = draftOf([]);
    const outcome = deleteLastLed(draft);
    expect(outcome.refused).toBe('NOTHING_TO_DELETE');
    expect(outcome.draft).toBe(draft);
  });

  it('permits deletion only for a single selection sitting on the last LED', () => {
    const draft = draftOf([WORD_A, WORD_B, WORD_C]);
    expect(canDeleteSelectedLed(draft)).toEqual({allowed: false, reason: 'NOT_LAST'});
    expect(canDeleteSelectedLed(selectLed(draft, 0))).toEqual({allowed: false, reason: 'NOT_LAST'});
    expect(canDeleteSelectedLed(selectLed(draft, 1))).toEqual({allowed: false, reason: 'NOT_LAST'});
    expect(canDeleteSelectedLed(selectLed(draft, 2))).toEqual({allowed: true});
    expect(canDeleteSelectedLed(selectAllLeds(draft))).toEqual({allowed: false, reason: 'NOT_LAST'});
    expect(canDeleteSelectedLed(draftOf([]))).toEqual({
      allowed: false,
      reason: 'NOTHING_TO_DELETE',
    });
  });

  it('leaves no gap when the strip is emptied one LED at a time', () => {
    let draft = draftOf([WORD_A, WORD_B, WORD_C]);
    for (let expected = 3; expected > 0; expected--) {
      expect(draftEffectiveCount(draft)).toBe(expected);
      expect(ledDraftSaveBlockers(draft)).not.toContain('DRAFT_HAS_GAP');
      draft = ok(deleteLastLed(draft));
    }
    expect(draftEffectiveCount(draft)).toBe(0);
    expect([...draft.entries]).toEqual(Array.from({length: 8}, () => 0));
  });
});

/* ================================================================== *
 * WIRE ORDER
 * ================================================================== */

describe('reordering the chain', () => {
  it('moves the WHOLE word, reserved bits and unknown function included', () => {
    const after = ok(moveLedEarlier(draftOf([WORD_A, WORD_C]), 1));
    expect([...after.entries].slice(0, 2)).toEqual([WORD_C, WORD_A]);
    const moved = decodeLedEntry(after.entries[0], 0);
    expect(moved.overlayMask & LED_OVERLAY_RESERVED_MASK).toBe(LED_OVERLAY_RESERVED_MASK);
    expect(moved.directionMask).toBe(0b001010);
    expect(moved.baseFunction).toBe(6);
    expect(moved.colorIndex).toBe(3);
  });

  it('moves later as the exact inverse of moving earlier', () => {
    const words = [WORD_A, WORD_B, WORD_C];
    const there = ok(moveLedLater(draftOf(words), 0));
    expect([...there.entries].slice(0, 3)).toEqual([WORD_B, WORD_A, WORD_C]);
    const back = ok(moveLedEarlier(there, 1));
    expect([...back.entries].slice(0, 3)).toEqual(words);
  });

  it('refuses at either end of the chain instead of wrapping', () => {
    const draft = draftOf([WORD_A, WORD_B]);
    expect(moveLedEarlier(draft, 0).refused).toBe('NO_NEIGHBOUR');
    expect(moveLedEarlier(draft, 0).draft).toBe(draft);
    expect(moveLedLater(draft, 1).refused).toBe('NO_NEIGHBOUR');
    expect(moveLedLater(draft, 1).draft).toBe(draft);
    expect(moveLedLater(draft, 5).refused).toBe('NO_NEIGHBOUR');
  });

  it('carries the selection with the LED it is on', () => {
    const draft = selectLed(draftOf([WORD_A, WORD_B, WORD_C]), 2);
    const after = ok(moveLedEarlier(draft, 2));
    expect(after.selection).toEqual([1]);
    expect(ledDraftNode(after, 1)?.raw).toBe(WORD_C);
  });

  it('refuses while a new LED is half-built', () => {
    const draft = ok(appendLed(draftOf([WORD_A, WORD_B])));
    const outcome = moveLedEarlier(draft, 1);
    expect(outcome.refused).toBe('PENDING_BLOCKS_REORDER');
    expect(outcome.draft).toBe(draft);
  });

  it('keeps the effective count and never authors a gap, whatever the permutation', () => {
    let draft = draftOf([WORD_A, WORD_B, WORD_C, WORD_D]);
    for (const [fn, index] of [
      [moveLedLater, 0],
      [moveLedLater, 1],
      [moveLedEarlier, 3],
      [moveLedEarlier, 2],
      [moveLedLater, 2],
    ] as const) {
      draft = ok(fn(draft, index));
      expect(draftEffectiveCount(draft)).toBe(4);
      expect(ledDraftSaveBlockers(draft)).not.toContain('DRAFT_HAS_GAP');
    }
    expect([...draft.entries].slice(0, 4).sort()).toEqual(
      [WORD_A, WORD_B, WORD_C, WORD_D].sort(),
    );
  });
});

/* ================================================================== *
 * THE OTHER THREE GROUPS
 * ================================================================== */

describe('palette, mode colours and runtime values', () => {
  it('marks a palette slot dirty, and clean again when it returns to the board value', () => {
    const draft = draftOf([WORD_A]);
    const edited = setLedPaletteSlot(draft, 3, {hue: 120, whiteness: 0, value: 255});
    expect(ledDraftDirtyGroups(edited)).toEqual(['PALETTE']);
    expect(draftPalette(edited)?.[3]).toEqual({hue: 120, whiteness: 0, value: 255});

    const restored = setLedPaletteSlot(edited, 3, PALETTE[3]);
    expect(ledDraftDirtyGroups(restored)).toEqual([]);
    expect(restored.palette.size).toBe(0);
  });

  it('leaves the untouched palette slots reading straight off the board', () => {
    const edited = setLedPaletteSlot(draftOf([WORD_A]), 0, {hue: 1, whiteness: 2, value: 3});
    const shown = draftPalette(edited);
    expect(shown?.[0]).toEqual({hue: 1, whiteness: 2, value: 3});
    expect(shown?.slice(1)).toEqual(PALETTE.slice(1));
  });

  it('has no palette to show on a board that never sent one', () => {
    expect(draftPalette(draftOf([WORD_A], {palette: undefined}))).toBeUndefined();
  });

  it('marks a mode colour dirty, and clean again when it returns to the board value', () => {
    const draft = draftOf([WORD_A]);
    const observedValue = MODE_COLORS.find(t => t.mode === 6 && t.slot === 8)?.value ?? 0;
    const edited = setLedModeColor(draft, 6, 8, (observedValue + 1) % 16);
    expect(ledDraftDirtyGroups(edited)).toEqual(['MODE_COLORS']);
    expect(draftModeColorValue(edited, 6, 8)).toBe((observedValue + 1) % 16);

    const restored = setLedModeColor(edited, 6, 8, observedValue);
    expect(ledDraftDirtyGroups(restored)).toEqual([]);
    expect(draftModeColorValue(restored, 6, 8)).toBe(observedValue);
  });

  it('never keeps two owned tuples for one mode/slot pair', () => {
    let draft = draftOf([WORD_A]);
    draft = setLedModeColor(draft, 0, 0, 11);
    draft = setLedModeColor(draft, 0, 0, 12);
    expect(draft.modeColors).toEqual([{mode: 0, slot: 0, value: 12}]);
  });

  it('marks a runtime value dirty, and clean again when it returns to the board value', () => {
    const draft = draftOf([WORD_A]);
    const edited = ok(setLedRuntimeValue(draft, 'brightness', 42));
    expect(ledDraftDirtyGroups(edited)).toEqual(['RUNTIME_VALUES']);
    expect(draftRuntimeValue(edited, 'brightness')).toBe(42);

    const restored = ok(setLedRuntimeValue(edited, 'brightness', RUNTIME.brightness));
    expect(ledDraftDirtyGroups(restored)).toEqual([]);
    expect(draftRuntimeValue(restored, 'brightness')).toBe(RUNTIME.brightness);
  });

  /* THE LAST LINE BEFORE THE ENCODER. `encodeLedStripConfigValues` THROWS
     on a value outside the firmware's write range, so a draft that accepts
     one turns a bad number into a crash at save time. The step control is
     supposed to keep the UI from ever asking - this proves the draft
     refuses even when something else does ask. */
  it('refuses a runtime value the firmware would not accept as a write', () => {
    const draft = draftOf([WORD_A]);
    /* brightness writes 5..100 */
    expect(setLedRuntimeValue(draft, 'brightness', 4).refused).toBe('VALUE_OUT_OF_RANGE');
    expect(setLedRuntimeValue(draft, 'brightness', 101).refused).toBe('VALUE_OUT_OF_RANGE');
    /* rainbowDelta writes 0..359 */
    expect(setLedRuntimeValue(draft, 'rainbowDelta', -1).refused).toBe('VALUE_OUT_OF_RANGE');
    expect(setLedRuntimeValue(draft, 'rainbowDelta', 360).refused).toBe('VALUE_OUT_OF_RANGE');
    /* rainbowFreq writes 1..2000 - NOT capped at 360 */
    expect(setLedRuntimeValue(draft, 'rainbowFreq', 0).refused).toBe('VALUE_OUT_OF_RANGE');
    expect(setLedRuntimeValue(draft, 'rainbowFreq', 2001).refused).toBe('VALUE_OUT_OF_RANGE');
    expect(setLedRuntimeValue(draft, 'brightness', 42.5).refused).toBe('VALUE_OUT_OF_RANGE');
    /* refused means UNCHANGED, not silently clamped to the bound */
    expect(ledDraftDirtyGroups(setLedRuntimeValue(draft, 'brightness', 4).draft)).toEqual([]);
    /* 360 is out of range for delta and perfectly ordinary for freq */
    expect(setLedRuntimeValue(draft, 'rainbowFreq', 360).refused).toBeUndefined();
  });

  /* An unwritable observation must not become a trap. Returning the field
     to what the board reported drops our claim on it, so nothing is
     written - that is allowed at ANY value, in range or not. */
  it('lets an out-of-range board value be handed back untouched', () => {
    const zeroed = draftOf([WORD_A], {
      runtimeValues: {brightness: 0, rainbowDelta: 0, rainbowFreq: 0},
    });
    const moved = ok(setLedRuntimeValue(zeroed, 'brightness', 60));
    expect(ledDraftDirtyGroups(moved)).toEqual(['RUNTIME_VALUES']);

    const handedBack = setLedRuntimeValue(moved, 'brightness', 0);
    expect(handedBack.refused).toBeUndefined();
    expect(ledDraftDirtyGroups(handedBack.draft)).toEqual([]);
    expect(draftRuntimeValue(handedBack.draft, 'brightness')).toBe(0);
  });

  it('shows the board value for a runtime field nobody edited, zero included', () => {
    const zeroed = draftOf([WORD_A], {
      runtimeValues: {brightness: 0, rainbowDelta: 0, rainbowFreq: 0},
    });
    expect(draftRuntimeValue(zeroed, 'brightness')).toBe(0);
    expect(draftRuntimeValue(zeroed, 'rainbowFreq')).toBe(0);
    expect(ledDraftDirtyGroups(zeroed)).toEqual([]);
  });

  it('reports the groups in the order a save writes them', () => {
    let draft = selectLed(draftOf([WORD_A]), 0);
    draft = ok(setLedColorIndex(draft, 7));
    draft = setLedPaletteSlot(draft, 1, {hue: 9, whiteness: 9, value: 9});
    draft = setLedModeColor(draft, 1, 1, 13);
    draft = ok(setLedRuntimeValue(draft, 'rainbowFreq', 1999));
    expect(ledDraftDirtyGroups(draft)).toEqual([
      'ENTRIES',
      'PALETTE',
      'MODE_COLORS',
      'RUNTIME_VALUES',
    ]);
  });
});

/* ================================================================== *
 * SAVE BLOCKERS
 * ================================================================== */

describe('save blockers', () => {
  it('blocks a save with nothing to say', () => {
    expect(ledDraftSaveBlockers(draftOf([WORD_A]))).toEqual(['NO_CHANGES']);
  });

  it('reports the board arriving already truncated, and does not offer to repair it', () => {
    /* A configured entry sitting past a terminator: index 2 is unreachable. */
    const blockers = ledDraftSaveBlockers(draftOf([WORD_A, 0, WORD_C]));
    expect(blockers).toContain('OBSERVED_STRIP_HAS_GAP');
    expect(blockers).toContain('DRAFT_HAS_GAP');
  });

  it('blocks palette and mode-colour edits on a board without the status-mode build', () => {
    const basic = draftOf([WORD_A], {capability: 'BASIC_LED_STRIP'});
    expect(ledDraftSaveBlockers(setLedPaletteSlot(basic, 0, {hue: 1, whiteness: 1, value: 1})))
      .toContain('ADVANCED_CAPABILITY_REQUIRED');
    expect(ledDraftSaveBlockers(setLedModeColor(basic, 0, 0, 5)))
      .toContain('ADVANCED_CAPABILITY_REQUIRED');
  });

  it('does not block entry or runtime edits on a basic board', () => {
    const basic = draftOf([WORD_A], {capability: 'BASIC_LED_STRIP'});
    expect(ledDraftSaveBlockers(ok(setLedColorIndex(selectLed(basic, 0), 5)))).toEqual([]);
    expect(ledDraftSaveBlockers(ok(setLedRuntimeValue(basic, 'brightness', 60)))).toEqual([]);
  });

  it('clears once the pending LED becomes a real one', () => {
    let draft = ok(appendLed(draftOf([WORD_A])));
    expect(ledDraftSaveBlockers(draft)).toEqual(['PENDING_LED_ENCODES_AS_TERMINATOR']);
    draft = ok(setLedBaseFunction(draft, 2));
    expect(ledDraftSaveBlockers(draft)).toEqual([]);
  });
});

/* ================================================================== *
 * THE SAVE REQUEST
 * ================================================================== */

describe('the save request handed to the controller', () => {
  it('carries only the groups that changed', () => {
    const runtimeOnly = ok(setLedRuntimeValue(draftOf([WORD_A]), 'brightness', 60));
    expect(Object.keys(buildLedSaveRequest(runtimeOnly))).toEqual(['runtimeValues']);
    expect(buildLedSaveRequest(runtimeOnly).runtimeValues).toEqual({brightness: 60});
  });

  it('carries nothing at all when nothing changed', () => {
    expect(buildLedSaveRequest(draftOf([WORD_A, WORD_B]))).toEqual({});
  });

  it('declares the effective count the target array actually yields', () => {
    let draft = ok(appendLed(draftOf([WORD_A, WORD_B])));
    draft = ok(setLedPosition(draft, 2, 3));
    const request = buildLedSaveRequest(draft);
    expect(request.entries?.declaredEffectiveCount).toBe(3);
    expect(request.entries?.target).toHaveLength(8);
    expect(request.entries?.target.slice(0, 2)).toEqual([WORD_A, WORD_B]);
  });

  it('declares the shorter count after a deletion', () => {
    const after = ok(deleteLastLed(draftOf([WORD_A, WORD_B, WORD_C])));
    expect(buildLedSaveRequest(after).entries?.declaredEffectiveCount).toBe(2);
  });

  it('sends only the palette slots the operator owns', () => {
    const draft = setLedPaletteSlot(draftOf([WORD_A]), 5, {hue: 200, whiteness: 10, value: 20});
    const owned = buildLedSaveRequest(draft).palette;
    expect(owned?.size).toBe(1);
    expect(owned?.get(5)).toEqual({hue: 200, whiteness: 10, value: 20});
  });

  it('sends only the mode tuples the operator owns', () => {
    const draft = setLedModeColor(draftOf([WORD_A]), 7, 0, 4);
    expect(buildLedSaveRequest(draft).modeColors).toEqual([{mode: 7, slot: 0, value: 4}]);
  });
});

/* ================================================================== *
 * DISCARDING
 * ================================================================== */

describe('discarding the draft', () => {
  it('returns every group, the pending LED and the selection to the observed state', () => {
    let draft = selectLed(draftOf([WORD_A, WORD_B]), 0);
    draft = ok(setLedColorIndex(draft, 9));
    draft = setLedPaletteSlot(draft, 2, {hue: 5, whiteness: 5, value: 5});
    draft = setLedModeColor(draft, 3, 3, 3);
    draft = ok(setLedRuntimeValue(draft, 'rainbowDelta', 359));
    draft = ok(appendLed(draft));

    const discarded = discardLedStripDraft(draft);
    expect([...discarded.entries].slice(0, 2)).toEqual([WORD_A, WORD_B]);
    expect(discarded.palette.size).toBe(0);
    expect(discarded.modeColors).toEqual([]);
    expect(discarded.runtimeValues).toEqual({});
    expect(discarded.pending).toBeUndefined();
    expect(discarded.selection).toEqual([]);
    expect(ledDraftDirtyGroups(discarded)).toEqual([]);
  });

  it('never moves the observed state, however much the draft is edited', () => {
    const observed = observedOf([WORD_A, WORD_B]);
    let draft = selectLed(createLedStripDraft(observed), 0);
    draft = ok(setLedPosition(draft, 9, 9));
    draft = ok(deleteLastLed(draft));
    expect(draft.observed).toBe(observed);
    expect(observed.entries.map(entry => entry.raw).slice(0, 2)).toEqual([WORD_A, WORD_B]);
  });
});

/* ================================================================== *
 * FIELD COMPOSITION
 * ================================================================== */

describe('composeLedWord', () => {
  it('places every field where the hand-authored words say it belongs', () => {
    expect(
      composeLedWord({
        x: 8,
        y: 15,
        baseFunction: 6,
        overlayMask: 0b1110000001,
        colorIndex: 3,
        directionMask: 0b001010,
      }),
    ).toBe(WORD_C);
  });

  it('produces the terminator for the LED the firmware cannot represent', () => {
    expect(
      composeLedWord({
        x: 0,
        y: 0,
        baseFunction: 0,
        overlayMask: 0,
        colorIndex: 0,
        directionMask: 0,
      }),
    ).toBe(0);
  });
});
