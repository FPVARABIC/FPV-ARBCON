/**
 * OSD LAYOUT GEOMETRY - the pure bridge between what the operator drags
 * and what the flight controller actually stores.
 *
 * WHY THIS EXISTS. The OSD screen showed elements on a preview but they
 * could only be MOVED with +/- steppers: the preview items were plain
 * Pressables with an onPress that selected them and nothing that could
 * follow a finger. So the screen looked like a layout editor and behaved
 * like a read-out. Everything needed to move an element correctly -
 * where a point lands on the character grid, where a cell lands on the
 * preview, how a drag keeps its grab offset, how a position is clamped -
 * lives here, as pure functions with no React, no gesture system and no
 * platform.
 *
 * THE COORDINATE TRUTH IS THE FIRMWARE'S, NOT THE PREVIEW'S. Betaflight
 * stores each element as a 16-bit word whose low bits are a CHARACTER
 * CELL (column, row) - see osdConfigurationModel.ts for the bit layout.
 * There is no pixel coordinate anywhere in the protocol. The preview is
 * therefore only a scaled window onto that grid: every drag is resolved
 * to an integer cell before it touches the draft, so what is dragged and
 * what is written are the same number.
 *
 * DIRECTION IS PHYSICAL. The app is Arabic and RTL, but an OSD canvas is
 * the pilot's video, not a paragraph: its left column is physically left
 * on the goggles no matter what the interface language is. Every function
 * here works in physical coordinates and has no notion of locale - a
 * mirrored OSD would put the battery reading on the wrong side of a real
 * flight.
 */

import type {MspOsdCanvas} from '../protocol/msp/decoding/decodeOsdConfiguration';

export interface OsdCell {
  readonly column: number;
  readonly row: number;
}

export interface OsdPreviewBox {
  readonly width: number;
  readonly height: number;
}

export interface OsdPoint {
  readonly x: number;
  readonly y: number;
}

/* ------------------------------------------------------------------ *
 * Canvas resolution
 * ------------------------------------------------------------------ */

/** MSP_OSD_CONFIG videoSystem values, in Betaflight's own order. */
export const OSD_VIDEO_AUTO = 0;
export const OSD_VIDEO_PAL = 1;
export const OSD_VIDEO_NTSC = 2;
export const OSD_VIDEO_HD = 3;

/**
 * The analogue character grids, which are a property of the video
 * standard rather than of any board: a MAX7456-class analogue OSD gives
 * 30 columns, with 16 visible rows on PAL and 13 on NTSC. They are used
 * ONLY to size the preview when the operator selects an analogue system;
 * nothing here is ever written to the flight controller.
 */
export const OSD_PAL_GRID: MspOsdCanvas = Object.freeze({columns: 30, rows: 16});
export const OSD_NTSC_GRID: MspOsdCanvas = Object.freeze({columns: 30, rows: 13});

/**
 * A character cell is taller than it is wide, and that ratio - not the
 * column/row count - is what makes the preview the shape of real video.
 * 12x18 is the MAX7456 character box; it puts a 30x16 PAL grid at 5:4 and
 * a 53x20 HD canvas at ~16:9, which is what each standard actually is.
 */
export const OSD_CELL_WIDTH_UNITS = 12;
export const OSD_CELL_HEIGHT_UNITS = 18;

/**
 * The grid the preview must draw for the CURRENTLY SELECTED video system.
 *
 * AUTO and HD both defer to the canvas the flight controller reported
 * over MSP_OSD_CANVAS - for HD/DisplayPort that is the authoritative size
 * and it varies by goggle system, so it is never guessed. The analogue
 * systems use their own standard grid, because a board that reports a
 * 53x20 HD canvas still drives 30x16 when it is switched to PAL.
 */
export function resolveOsdCanvas(
  videoSystem: number,
  reported: MspOsdCanvas,
): MspOsdCanvas {
  if (videoSystem === OSD_VIDEO_PAL) {
    return OSD_PAL_GRID;
  }
  if (videoSystem === OSD_VIDEO_NTSC) {
    return OSD_NTSC_GRID;
  }
  return reported;
}

/** Width/height ratio of the video the preview is standing in for. */
export function osdPreviewAspectRatio(canvas: MspOsdCanvas): number {
  const width = Math.max(1, canvas.columns) * OSD_CELL_WIDTH_UNITS;
  const height = Math.max(1, canvas.rows) * OSD_CELL_HEIGHT_UNITS;
  return width / height;
}

/* ------------------------------------------------------------------ *
 * Cell <-> point
 * ------------------------------------------------------------------ */

export function osdCellSize(
  box: OsdPreviewBox,
  canvas: MspOsdCanvas,
): {readonly width: number; readonly height: number} {
  return {
    width: box.width / Math.max(1, canvas.columns),
    height: box.height / Math.max(1, canvas.rows),
  };
}

export function clampOsdCell(cell: OsdCell, canvas: MspOsdCanvas): OsdCell {
  const column = Math.min(Math.max(0, Math.trunc(cell.column)), Math.max(0, canvas.columns - 1));
  const row = Math.min(Math.max(0, Math.trunc(cell.row)), Math.max(0, canvas.rows - 1));
  return {column, row};
}

export function isCellWithinCanvas(cell: OsdCell, canvas: MspOsdCanvas): boolean {
  return (
    cell.column >= 0 &&
    cell.row >= 0 &&
    cell.column < canvas.columns &&
    cell.row < canvas.rows
  );
}

/**
 * Which character cell a preview point falls in.
 *
 * Truncating rather than rounding is what makes the cell the one the
 * operator is actually pointing AT: with rounding, the left half of
 * column 0 would resolve to column -1 and be clamped, so the first column
 * would be half as easy to hit as every other one.
 */
export function pointToOsdCell(
  point: OsdPoint,
  box: OsdPreviewBox,
  canvas: MspOsdCanvas,
): OsdCell {
  if (box.width <= 0 || box.height <= 0) {
    return {column: 0, row: 0};
  }
  const cell = osdCellSize(box, canvas);
  return clampOsdCell(
    {
      column: Math.floor(point.x / cell.width),
      row: Math.floor(point.y / cell.height),
    },
    canvas,
  );
}

/** The preview offset of a cell's top-left corner, in pixels. */
export function osdCellToPoint(
  cell: OsdCell,
  box: OsdPreviewBox,
  canvas: MspOsdCanvas,
): OsdPoint {
  const size = osdCellSize(box, canvas);
  return {x: cell.column * size.width, y: cell.row * size.height};
}

/** The same offset as a percentage, for styles that position by fraction. */
export function osdCellToFraction(
  cell: OsdCell,
  canvas: MspOsdCanvas,
): {readonly left: number; readonly top: number} {
  return {
    left: (cell.column / Math.max(1, canvas.columns)) * 100,
    top: (cell.row / Math.max(1, canvas.rows)) * 100,
  };
}

/* ------------------------------------------------------------------ *
 * Dragging
 * ------------------------------------------------------------------ */

export interface OsdDragGrab {
  /** Which element the gesture owns for its whole life. */
  readonly elementIndex: number;
  /**
   * Cell distance between the element's anchor and the cell the operator
   * first touched. Keeping it for the whole gesture is what stops the
   * element jumping so its corner snaps under the finger.
   */
  readonly columnOffset: number;
  readonly rowOffset: number;
}

/** Begins a drag: identifies the grab offset from the first touch. */
export function beginOsdDrag(
  elementIndex: number,
  anchor: OsdCell,
  point: OsdPoint,
  box: OsdPreviewBox,
  canvas: MspOsdCanvas,
): OsdDragGrab {
  const touched = pointToOsdCell(point, box, canvas);
  return {
    elementIndex,
    columnOffset: anchor.column - touched.column,
    rowOffset: anchor.row - touched.row,
  };
}

/**
 * Where the dragged element's anchor belongs for the current pointer
 * position. Always a valid cell: clamped to the canvas, so no gesture can
 * produce a position the firmware could not store.
 */
export function resolveOsdDragCell(
  grab: OsdDragGrab,
  point: OsdPoint,
  box: OsdPreviewBox,
  canvas: MspOsdCanvas,
): OsdCell {
  const touched = pointToOsdCell(point, box, canvas);
  return clampOsdCell(
    {
      column: touched.column + grab.columnOffset,
      row: touched.row + grab.rowOffset,
    },
    canvas,
  );
}

/* ------------------------------------------------------------------ *
 * Hit testing
 * ------------------------------------------------------------------ */

export interface OsdHitTarget {
  readonly index: number;
  readonly cell: OsdCell;
  /** How many character cells the element's preview token occupies. */
  readonly widthInCells: number;
}

/**
 * The element under a preview point, or undefined for empty video.
 *
 * Walked in REVERSE order so the element drawn last - the one visually on
 * top where two overlap - is the one the operator grabs, which is the
 * only choice that matches what they can see.
 */
export function hitTestOsdElements(
  point: OsdPoint,
  box: OsdPreviewBox,
  canvas: MspOsdCanvas,
  targets: readonly OsdHitTarget[],
): number | undefined {
  if (box.width <= 0 || box.height <= 0) {
    return undefined;
  }
  const size = osdCellSize(box, canvas);
  for (let index = targets.length - 1; index >= 0; index -= 1) {
    const target = targets[index];
    const left = target.cell.column * size.width;
    const top = target.cell.row * size.height;
    const right = left + Math.max(1, target.widthInCells) * size.width;
    const bottom = top + size.height;
    if (point.x >= left && point.x < right && point.y >= top && point.y < bottom) {
      return target.index;
    }
  }
  return undefined;
}
