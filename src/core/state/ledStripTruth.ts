/**
 * WHAT THE BOARD ACTUALLY LIGHTS, DERIVED FROM WHAT THE BOARD SENT.
 *
 * Two truths live in one array and they are not the same, which is the single
 * most consequential thing this subsystem has to get right:
 *
 *   OBSERVED  - every entry the board transmitted, in wire order, kept whole.
 *   EFFECTIVE - the prefix the firmware will actually render.
 *
 * The firmware counts LEDs by walking from index 0 and STOPPING at the first
 * entry whose whole 32-bit word is zero. Everything past that point is dead
 * no matter what it holds. The reference configurator's loader instead SKIPS
 * zero entries and keeps going, so a board with a hole in its numbering
 * displays as complete there and lights only the first few LEDs in the air,
 * with nothing anywhere reporting the difference. Separating the two truths
 * here, and naming the entries that fall between them, is how that stops
 * being a silent failure.
 *
 * Pure. No I/O, no React, no strings, no text direction. X and Y are physical
 * aircraft coordinates and are never mirrored for any reason.
 */

import {isLedTerminatorWord, type LedEntry} from '../protocol/msp/decoding/ledStripWireContract';

/** Both axes are four bits wide. */
export const LED_COORDINATE_MASK = 0x0f;

/**
 * Entries the board sent after the terminator.
 *
 * They are real bytes on a real board and are reported rather than dropped,
 * but the firmware will never render them - it stopped counting before it
 * reached them.
 */
export interface LedUnreachableEntry {
  readonly index: number;
  readonly raw: number;
}

/** Every effective LED that shares one coordinate with another. */
export interface LedDuplicatePosition {
  readonly x: number;
  readonly y: number;
  readonly indexes: readonly number[];
}

/**
 * The north/south and east/west boundaries, recomputed the way the firmware
 * recomputes them.
 *
 * THESE ARE NOT A FIXED GRID MIDPOINT. The firmware takes the minimum and
 * maximum X and Y over the EFFECTIVE LEDs only and splits that extent, so the
 * meaning of "north" is a property of the whole layout rather than of the
 * canvas. Adding one LED at the back of an aircraft can move the boundary and
 * change which quadrant several untouched LEDs fall into - a consequence a UI
 * has to be able to explain, which is why it is derived here rather than
 * assumed to be 8.
 */
export interface LedQuadrantThresholds {
  readonly lowestXValueForEast: number;
  readonly highestXValueForWest: number;
  readonly lowestYValueForSouth: number;
  readonly highestYValueForNorth: number;
}

export interface LedCoordinateBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

export interface LedStripTruth {
  /** Entries the board's array holds, from the payload length. */
  readonly maxLength: number;
  /** Consecutive non-zero entries from index 0. What the firmware renders. */
  readonly effectiveCount: number;
  /** Where the walk stopped, or `undefined` if no entry was ever zero. */
  readonly firstTerminatorIndex: number | undefined;
  /** The rendered prefix. */
  readonly effectiveEntries: readonly LedEntry[];
  /** Configured entries the firmware can never reach. */
  readonly unreachableEntries: readonly LedUnreachableEntry[];
  /** True when at least one configured entry sits past the terminator. */
  readonly gapDetected: boolean;
  /** Coordinates shared by more than one effective LED. Legal, not an error. */
  readonly duplicatePositions: readonly LedDuplicatePosition[];
  /** Extent of the effective LEDs, or `undefined` when there are none. */
  readonly bounds: LedCoordinateBounds | undefined;
  readonly quadrantThresholds: LedQuadrantThresholds;
}

/**
 * The firmware's fallback when an axis has no extent to split - a single LED,
 * a single row or column, or no LEDs at all. It seeds the boundary from half
 * the coordinate mask instead of from the layout, using integer division:
 * 15 / 2 is 7, and the opposite boundary sits one below it.
 */
const FALLBACK_LOW_FOR_HIGH_SIDE = Math.floor(LED_COORDINATE_MASK / 2);
const FALLBACK_HIGH_FOR_LOW_SIDE = FALLBACK_LOW_FOR_HIGH_SIDE - 1;

function splitAxis(min: number, max: number): {readonly lowForHighSide: number; readonly highForLowSide: number} {
  if (min < max) {
    return {
      lowForHighSide: Math.floor((min + max) / 2) + 1,
      highForLowSide: Math.floor((min + max - 1) / 2),
    };
  }
  return {lowForHighSide: FALLBACK_LOW_FOR_HIGH_SIDE, highForLowSide: FALLBACK_HIGH_FOR_LOW_SIDE};
}

/**
 * Derive both truths from the entries a strip GET produced.
 *
 * `maxLength` defaults to the array's own length, which is what the decoder
 * already derived from the payload. It is a parameter so that a caller
 * holding the snapshot can pass the observed value explicitly rather than
 * relying on the two agreeing by accident.
 */
export function deriveLedStripTruth(
  entries: readonly LedEntry[],
  maxLength: number = entries.length,
): LedStripTruth {
  let firstTerminatorIndex: number | undefined;
  for (let i = 0; i < entries.length; i++) {
    if (isLedTerminatorWord(entries[i].raw)) {
      firstTerminatorIndex = i;
      break;
    }
  }

  const effectiveCount = firstTerminatorIndex ?? entries.length;
  const effectiveEntries = entries.slice(0, effectiveCount);

  const unreachableEntries: LedUnreachableEntry[] = [];
  for (let i = effectiveCount; i < entries.length; i++) {
    if (!isLedTerminatorWord(entries[i].raw)) {
      unreachableEntries.push(Object.freeze({index: entries[i].index, raw: entries[i].raw}));
    }
  }

  /* Duplicates are computed over the EFFECTIVE entries: two LEDs sharing a
     coordinate only matter if the firmware renders both, and an unreachable
     entry cannot collide with anything. */
  const byPosition = new Map<number, number[]>();
  for (const entry of effectiveEntries) {
    const key = (entry.y << 4) | entry.x;
    const bucket = byPosition.get(key);
    if (bucket === undefined) byPosition.set(key, [entry.index]);
    else bucket.push(entry.index);
  }
  const duplicatePositions: LedDuplicatePosition[] = [];
  for (const [key, indexes] of byPosition) {
    if (indexes.length > 1) {
      duplicatePositions.push(
        Object.freeze({x: key & LED_COORDINATE_MASK, y: (key >> 4) & LED_COORDINATE_MASK, indexes: Object.freeze([...indexes])}),
      );
    }
  }
  duplicatePositions.sort((a, b) => a.indexes[0] - b.indexes[0]);

  let bounds: LedCoordinateBounds | undefined;
  if (effectiveEntries.length > 0) {
    let minX = LED_COORDINATE_MASK;
    let maxX = 0;
    let minY = LED_COORDINATE_MASK;
    let maxY = 0;
    for (const entry of effectiveEntries) {
      if (entry.x < minX) minX = entry.x;
      if (entry.x > maxX) maxX = entry.x;
      if (entry.y < minY) minY = entry.y;
      if (entry.y > maxY) maxY = entry.y;
    }
    bounds = Object.freeze({minX, maxX, minY, maxY});
  }

  /* With no effective LEDs the firmware's seeded min stays above its seeded
     max, so both axes take the fallback branch. Passing the fallback pair
     straight through reproduces that without pretending an extent exists. */
  const xSplit = bounds ? splitAxis(bounds.minX, bounds.maxX) : splitAxis(1, 0);
  const ySplit = bounds ? splitAxis(bounds.minY, bounds.maxY) : splitAxis(1, 0);

  return Object.freeze({
    maxLength,
    effectiveCount,
    firstTerminatorIndex,
    effectiveEntries: Object.freeze(effectiveEntries),
    unreachableEntries: Object.freeze(unreachableEntries),
    gapDetected: unreachableEntries.length > 0,
    duplicatePositions: Object.freeze(duplicatePositions),
    bounds,
    quadrantThresholds: Object.freeze({
      lowestXValueForEast: xSplit.lowForHighSide,
      highestXValueForWest: xSplit.highForLowSide,
      lowestYValueForSouth: ySplit.lowForHighSide,
      highestYValueForNorth: ySplit.highForLowSide,
    }),
  });
}

/**
 * Which physical quadrants a coordinate falls into.
 *
 * LOW Y IS NORTH AND HIGH Y IS SOUTH; low X is west, high X is east. That is
 * the firmware's own comparison, and it is a statement about the aircraft,
 * not about a screen. It is never mirrored for right-to-left text, because
 * the front of a drone does not move when the interface language changes.
 *
 * An LED can be in neither north nor south: when the extent has an even span
 * the two boundaries leave a middle band belonging to neither, and the
 * firmware's `else if` chain leaves that band unset. Reporting all four flags
 * independently keeps that case expressible.
 */
export interface LedQuadrantMembership {
  readonly north: boolean;
  readonly east: boolean;
  readonly south: boolean;
  readonly west: boolean;
}

export function classifyLedQuadrant(
  x: number,
  y: number,
  thresholds: LedQuadrantThresholds,
): LedQuadrantMembership {
  const north = y <= thresholds.highestYValueForNorth;
  const south = !north && y >= thresholds.lowestYValueForSouth;
  const east = x >= thresholds.lowestXValueForEast;
  const west = !east && x <= thresholds.highestXValueForWest;
  return Object.freeze({north, east, south, west});
}
