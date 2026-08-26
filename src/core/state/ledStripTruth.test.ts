import {classifyLedQuadrant, deriveLedStripTruth} from './ledStripTruth';
import {decodeLedEntry, type LedEntry} from '../protocol/msp/decoding/ledStripWireContract';
import {F3_GAP_WORDS, F4_DUPLICATE_WORDS} from '../protocol/msp/__testUtils__/ledStripFixtures';

/** Compose a word by hand, then decode it - no production encoder involved. */
const word = (x: number, y: number, extra = 0): number => ((y | (x << 4)) >>> 0 | extra) >>> 0;
const entryAt = (index: number, x: number, y: number, extra = 1 << 8): LedEntry =>
  decodeLedEntry(word(x, y, extra), index);
const entriesOf = (words: readonly number[]): LedEntry[] =>
  words.map((w, index) => decodeLedEntry(w, index));

describe('first zero terminates the effective strip', () => {
  it('stops counting at the first all-zero word', () => {
    const truth = deriveLedStripTruth(entriesOf(F3_GAP_WORDS));
    expect(truth.firstTerminatorIndex).toBe(1);
    expect(truth.effectiveCount).toBe(1);
    expect(truth.effectiveEntries.map((e) => e.raw)).toEqual([0x00400001]);
  });

  it('does NOT skip the zero and keep going', () => {
    /* This is the divergence that makes a holed strip render as complete in
       the reference and light three LEDs on the aircraft. */
    const truth = deriveLedStripTruth(entriesOf(F3_GAP_WORDS));
    expect(truth.effectiveCount).not.toBe(3);
    expect(truth.effectiveEntries.map((e) => e.raw)).not.toContain(0x00000223);
  });

  it('counts the whole array when no entry is ever zero', () => {
    const truth = deriveLedStripTruth([entryAt(0, 1, 1), entryAt(1, 2, 2), entryAt(2, 3, 3)]);
    expect(truth.firstTerminatorIndex).toBeUndefined();
    expect(truth.effectiveCount).toBe(3);
    expect(truth.gapDetected).toBe(false);
  });

  it('counts nothing when index 0 is the terminator', () => {
    const truth = deriveLedStripTruth(entriesOf([0, 0, 0, 0]));
    expect(truth.effectiveCount).toBe(0);
    expect(truth.firstTerminatorIndex).toBe(0);
    expect(truth.effectiveEntries).toHaveLength(0);
    expect(truth.gapDetected).toBe(false);
    expect(truth.bounds).toBeUndefined();
  });

  it('reports maxLength from the array unless told otherwise', () => {
    expect(deriveLedStripTruth(entriesOf(F3_GAP_WORDS)).maxLength).toBe(4);
    expect(deriveLedStripTruth(entriesOf(F3_GAP_WORDS), 64).maxLength).toBe(64);
  });
});

describe('gap detection', () => {
  it('names the configured entries the firmware can never reach', () => {
    const truth = deriveLedStripTruth(entriesOf(F3_GAP_WORDS));
    expect(truth.gapDetected).toBe(true);
    expect(truth.unreachableEntries).toEqual([
      {index: 2, raw: 0x00000223},
      {index: 3, raw: 0x00000345},
    ]);
  });

  it('does not call trailing zeros a gap', () => {
    const truth = deriveLedStripTruth(entriesOf([word(1, 1, 1 << 8), 0, 0, 0]));
    expect(truth.effectiveCount).toBe(1);
    expect(truth.gapDetected).toBe(false);
    expect(truth.unreachableEntries).toHaveLength(0);
  });

  it('keeps the unreachable entries rather than dropping them', () => {
    /* The board really holds those bytes. Silently discarding them means a
       save writes zeros over configuration the user never asked to lose. */
    const truth = deriveLedStripTruth(entriesOf(F3_GAP_WORDS));
    expect(truth.unreachableEntries.map((e) => e.raw)).toEqual([...F3_GAP_WORDS.slice(2)]);
  });
});

describe('duplicate coordinates are legal and are preserved', () => {
  it('reports both indexes at a shared coordinate', () => {
    const truth = deriveLedStripTruth(entriesOf(F4_DUPLICATE_WORDS));
    expect(truth.effectiveCount).toBe(3);
    expect(truth.duplicatePositions).toEqual([{x: 4, y: 6, indexes: [0, 2]}]);
  });

  it('does not collapse the duplicates into one entry', () => {
    const truth = deriveLedStripTruth(entriesOf(F4_DUPLICATE_WORDS));
    expect(truth.effectiveEntries).toHaveLength(3);
    expect(truth.effectiveEntries.map((e) => e.raw)).toEqual([...F4_DUPLICATE_WORDS]);
    /* Two LEDs at (4,6) with different base functions both survive - the
       reference loses one because it keys its grid by coordinate. */
    expect(truth.effectiveEntries[0].baseFunction).toBe(1);
    expect(truth.effectiveEntries[2].baseFunction).toBe(2);
  });

  it('reports nothing when every coordinate is unique', () => {
    const truth = deriveLedStripTruth([entryAt(0, 1, 1), entryAt(1, 2, 2), entryAt(2, 3, 3)]);
    expect(truth.duplicatePositions).toHaveLength(0);
  });

  it('groups three LEDs sharing one coordinate', () => {
    const truth = deriveLedStripTruth([
      entryAt(0, 5, 5), entryAt(1, 9, 1), entryAt(2, 5, 5), entryAt(3, 5, 5),
    ]);
    expect(truth.duplicatePositions).toEqual([{x: 5, y: 5, indexes: [0, 2, 3]}]);
  });
});

describe('derived geometry follows the firmware formulas', () => {
  const box = [entryAt(0, 2, 1), entryAt(1, 6, 1), entryAt(2, 2, 5), entryAt(3, 6, 5)];

  it('takes min and max from the effective LEDs only', () => {
    const truth = deriveLedStripTruth(box);
    expect(truth.bounds).toEqual({minX: 2, maxX: 6, minY: 1, maxY: 5});
  });

  it('splits the extent, it does not use a fixed grid midpoint', () => {
    const truth = deriveLedStripTruth(box);
    expect(truth.quadrantThresholds).toEqual({
      lowestXValueForEast: 5,
      highestXValueForWest: 3,
      lowestYValueForSouth: 4,
      highestYValueForNorth: 2,
    });
    /* A fixed 16x16 midpoint would have produced 8 and 7 on both axes. */
    expect(truth.quadrantThresholds.lowestXValueForEast).not.toBe(8);
  });

  it('falls back when an axis has no extent', () => {
    /* One LED, or a single row or column: the firmware seeds the boundary
       from half the coordinate mask instead, with integer division. */
    const single = deriveLedStripTruth([entryAt(0, 7, 7)]);
    expect(single.bounds).toEqual({minX: 7, maxX: 7, minY: 7, maxY: 7});
    expect(single.quadrantThresholds).toEqual({
      lowestXValueForEast: 7,
      highestXValueForWest: 6,
      lowestYValueForSouth: 7,
      highestYValueForNorth: 6,
    });
  });

  it('falls back on one axis while splitting the other', () => {
    const column = deriveLedStripTruth([entryAt(0, 3, 2), entryAt(1, 3, 10)]);
    expect(column.quadrantThresholds.lowestXValueForEast).toBe(7);
    expect(column.quadrantThresholds.highestXValueForWest).toBe(6);
    expect(column.quadrantThresholds.lowestYValueForSouth).toBe(7);
    expect(column.quadrantThresholds.highestYValueForNorth).toBe(5);
  });

  it('uses the fallback when there are no effective LEDs at all', () => {
    const empty = deriveLedStripTruth(entriesOf([0, 0]));
    expect(empty.quadrantThresholds).toEqual({
      lowestXValueForEast: 7,
      highestXValueForWest: 6,
      lowestYValueForSouth: 7,
      highestYValueForNorth: 6,
    });
  });

  it('ignores unreachable entries when deriving the extent', () => {
    /* The firmware's own loop runs to its effective count, so an entry past
       the terminator cannot stretch the grid. */
    const truth = deriveLedStripTruth(entriesOf([word(2, 1, 1 << 8), 0, word(15, 15, 1 << 8)]));
    expect(truth.bounds).toEqual({minX: 2, maxX: 2, minY: 1, maxY: 1});
  });
});

describe('quadrant classification is physical, never mirrored', () => {
  const truth = deriveLedStripTruth([entryAt(0, 2, 1), entryAt(1, 6, 1), entryAt(2, 2, 5), entryAt(3, 6, 5)]);
  const q = (x: number, y: number) => classifyLedQuadrant(x, y, truth.quadrantThresholds);

  it('puts low Y at the north and high Y at the south', () => {
    expect(q(2, 1).north).toBe(true);
    expect(q(2, 1).south).toBe(false);
    expect(q(2, 5).south).toBe(true);
    expect(q(2, 5).north).toBe(false);
  });

  it('puts low X at the west and high X at the east', () => {
    expect(q(2, 1).west).toBe(true);
    expect(q(2, 1).east).toBe(false);
    expect(q(6, 1).east).toBe(true);
    expect(q(6, 1).west).toBe(false);
  });

  it('classifies all four corners of the layout', () => {
    expect(q(2, 1)).toEqual({north: true, east: false, south: false, west: true});
    expect(q(6, 1)).toEqual({north: true, east: true, south: false, west: false});
    expect(q(2, 5)).toEqual({north: false, east: false, south: true, west: true});
    expect(q(6, 5)).toEqual({north: false, east: true, south: true, west: false});
  });

  it('leaves the middle band in no quadrant, as the firmware does', () => {
    expect(q(4, 3)).toEqual({north: false, east: false, south: false, west: false});
  });

  it('does not mirror X for any reason', () => {
    /* X is an aircraft axis. The east/west answer for a coordinate must be
       identical no matter what an interface's text direction is, and there
       is nothing in this module that could vary it. */
    const east = q(6, 1);
    const west = q(2, 1);
    expect(east.east).toBe(true);
    expect(west.west).toBe(true);
    expect(east.west).toBe(false);
    expect(west.east).toBe(false);
  });

  it('shows that moving one LED can reclassify an untouched one', () => {
    /* The boundaries come from the extent of the whole layout, so this is a
       real consequence a UI has to be able to explain - not a bug. */
    const before = deriveLedStripTruth([entryAt(0, 3, 6), entryAt(1, 3, 7)]);
    expect(classifyLedQuadrant(3, 7, before.quadrantThresholds).south).toBe(true);
    expect(classifyLedQuadrant(3, 7, before.quadrantThresholds).north).toBe(false);

    const after = deriveLedStripTruth([entryAt(0, 3, 6), entryAt(1, 3, 7), entryAt(2, 3, 15)]);
    expect(classifyLedQuadrant(3, 7, after.quadrantThresholds).north).toBe(true);
    expect(classifyLedQuadrant(3, 7, after.quadrantThresholds).south).toBe(false);
  });
});

describe('LED index is the physical strip position', () => {
  it('keeps the index the board sent, independent of coordinates', () => {
    /* Deliberately descending coordinates against ascending indexes: nothing
       here may sort, reverse, or re-derive an index from x/y. */
    const truth = deriveLedStripTruth([entryAt(0, 9, 9), entryAt(1, 5, 5), entryAt(2, 1, 1)]);
    expect(truth.effectiveEntries.map((e) => e.index)).toEqual([0, 1, 2]);
    expect(truth.effectiveEntries.map((e) => e.x)).toEqual([9, 5, 1]);
  });
});
