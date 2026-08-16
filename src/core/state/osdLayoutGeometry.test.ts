/**
 * OSD GEOMETRY - the arithmetic that has to agree with the firmware.
 *
 * These are the guarantees a dragged element depends on: a preview point
 * resolves to the cell the operator is pointing at, a cell resolves back
 * to the same place on the preview, nothing can leave the canvas, and the
 * whole mapping is physical - it has no locale to mirror.
 */

import {
  OSD_CELL_HEIGHT_UNITS,
  OSD_CELL_WIDTH_UNITS,
  OSD_NTSC_GRID,
  OSD_PAL_GRID,
  OSD_VIDEO_AUTO,
  OSD_VIDEO_HD,
  OSD_VIDEO_NTSC,
  OSD_VIDEO_PAL,
  beginOsdDrag,
  clampOsdCell,
  hitTestOsdElements,
  isCellWithinCanvas,
  osdCellSize,
  osdCellToFraction,
  osdCellToPoint,
  osdPreviewAspectRatio,
  pointToOsdCell,
  resolveOsdCanvas,
  resolveOsdDragCell,
} from './osdLayoutGeometry';
import type {MspOsdCanvas} from '../protocol/msp/decoding/decodeOsdConfiguration';

/** A DisplayPort/HD canvas as a real flight controller reports it. */
const HD: MspOsdCanvas = {columns: 53, rows: 20};
const BOX = {width: 1060, height: 400}; // 20 px per cell horizontally, 20 vertically

describe('the canvas the preview must draw', () => {
  it('uses the flight controller ANSWER for AUTO and HD, never a guess', () => {
    expect(resolveOsdCanvas(OSD_VIDEO_AUTO, HD)).toEqual(HD);
    expect(resolveOsdCanvas(OSD_VIDEO_HD, HD)).toEqual(HD);
  });

  it('uses the analogue standard grids for PAL and NTSC', () => {
    // A board that reports a 53x20 HD canvas still drives 30x16 on PAL,
    // so the reported canvas must not win here.
    expect(resolveOsdCanvas(OSD_VIDEO_PAL, HD)).toEqual(OSD_PAL_GRID);
    expect(resolveOsdCanvas(OSD_VIDEO_NTSC, HD)).toEqual(OSD_NTSC_GRID);
  });

  it('shapes the preview like the video, not like the grid count', () => {
    // A character cell is taller than it is wide; ignoring that would
    // stretch a 30x16 PAL frame into something no camera produces.
    expect(osdPreviewAspectRatio(OSD_PAL_GRID)).toBeCloseTo(
      (30 * OSD_CELL_WIDTH_UNITS) / (16 * OSD_CELL_HEIGHT_UNITS),
      5,
    );
    expect(osdPreviewAspectRatio(OSD_PAL_GRID)).toBeCloseTo(1.25, 3);
    expect(osdPreviewAspectRatio(HD)).toBeCloseTo(1.767, 2);
  });
});

describe('a preview point resolves to the firmware cell', () => {
  it('maps the point to the cell it is inside, truncating not rounding', () => {
    const cell = osdCellSize(BOX, HD);
    expect(cell).toEqual({width: 20, height: 20});
    // Anywhere inside column 3 / row 2 is column 3 / row 2 - including
    // the very first pixel, which rounding would push to the neighbour.
    expect(pointToOsdCell({x: 60, y: 40}, BOX, HD)).toEqual({column: 3, row: 2});
    expect(pointToOsdCell({x: 79.9, y: 59.9}, BOX, HD)).toEqual({column: 3, row: 2});
    expect(pointToOsdCell({x: 0, y: 0}, BOX, HD)).toEqual({column: 0, row: 0});
  });

  it('clamps a point outside the canvas instead of inventing a cell', () => {
    expect(pointToOsdCell({x: -200, y: -200}, BOX, HD)).toEqual({column: 0, row: 0});
    expect(pointToOsdCell({x: 99_999, y: 99_999}, BOX, HD)).toEqual({column: 52, row: 19});
  });

  it('round-trips a cell through the preview and back', () => {
    for (const cell of [
      {column: 0, row: 0},
      {column: 17, row: 9},
      {column: 52, row: 19},
    ]) {
      const point = osdCellToPoint(cell, BOX, HD);
      expect(pointToOsdCell(point, BOX, HD)).toEqual(cell);
    }
  });

  it('survives a preview that has not been measured yet', () => {
    expect(pointToOsdCell({x: 10, y: 10}, {width: 0, height: 0}, HD)).toEqual({
      column: 0,
      row: 0,
    });
  });
});

describe('physical direction is not a locale', () => {
  it('places column 0 on the LEFT and the last column on the RIGHT', () => {
    // The interface is Arabic and RTL; the OSD canvas is the pilot's
    // video. A mirrored mapping would put the battery reading on the
    // wrong side of a real flight.
    expect(osdCellToFraction({column: 0, row: 0}, HD).left).toBe(0);
    expect(osdCellToFraction({column: 52, row: 0}, HD).left).toBeGreaterThan(90);
    expect(osdCellToPoint({column: 0, row: 0}, BOX, HD).x).toBe(0);
    expect(osdCellToPoint({column: 52, row: 0}, BOX, HD).x).toBe(1040);
  });

  it('gives the same answer whichever way the interface reads', () => {
    // The functions are pure and take no direction argument, so the only
    // way an RTL build could mirror them is by a caller flipping the
    // input. Pinned here so that stays impossible to do by accident.
    const {I18nManager} = jest.requireActual<typeof import('react-native')>('react-native');
    const before = pointToOsdCell({x: 60, y: 40}, BOX, HD);
    const original = I18nManager.isRTL;
    try {
      Object.defineProperty(I18nManager, 'isRTL', {value: true, configurable: true});
      expect(pointToOsdCell({x: 60, y: 40}, BOX, HD)).toEqual(before);
      expect(osdCellToFraction({column: 3, row: 2}, HD).left).toBeCloseTo((3 / 53) * 100, 6);
    } finally {
      Object.defineProperty(I18nManager, 'isRTL', {value: original, configurable: true});
    }
  });
});

describe('dragging keeps the grab and stays inside the canvas', () => {
  it('moves by the pointer delta, not by snapping the corner to the finger', () => {
    // Grab the element at its third cell: the anchor must stay three
    // cells to the left of the finger for the whole gesture.
    const grab = beginOsdDrag(7, {column: 10, row: 5}, {x: 260, y: 110}, BOX, HD);
    expect(grab).toEqual({elementIndex: 7, columnOffset: -3, rowOffset: 0});

    expect(resolveOsdDragCell(grab, {x: 460, y: 210}, BOX, HD)).toEqual({
      column: 20,
      row: 10,
    });
  });

  it('changes ONLY the column when the pointer moves horizontally', () => {
    const grab = beginOsdDrag(2, {column: 4, row: 6}, {x: 80, y: 120}, BOX, HD);
    expect(resolveOsdDragCell(grab, {x: 400, y: 120}, BOX, HD)).toEqual({
      column: 20,
      row: 6,
    });
  });

  it('changes ONLY the row when the pointer moves vertically', () => {
    const grab = beginOsdDrag(2, {column: 4, row: 6}, {x: 80, y: 120}, BOX, HD);
    expect(resolveOsdDragCell(grab, {x: 80, y: 300}, BOX, HD)).toEqual({
      column: 4,
      row: 15,
    });
  });

  it('cannot produce a position the firmware could not store', () => {
    const grab = beginOsdDrag(1, {column: 50, row: 18}, {x: 1000, y: 360}, BOX, HD);
    expect(resolveOsdDragCell(grab, {x: 100_000, y: 100_000}, BOX, HD)).toEqual({
      column: 52,
      row: 19,
    });
    expect(resolveOsdDragCell(grab, {x: -100_000, y: -100_000}, BOX, HD)).toEqual({
      column: 0,
      row: 0,
    });
  });

  it('clamps to a SMALLER canvas when the video system changes', () => {
    const pal = resolveOsdCanvas(OSD_VIDEO_PAL, HD);
    expect(clampOsdCell({column: 52, row: 19}, pal)).toEqual({column: 29, row: 15});
    expect(isCellWithinCanvas({column: 52, row: 19}, pal)).toBe(false);
    expect(isCellWithinCanvas({column: 29, row: 15}, pal)).toBe(true);
  });
});

describe('hit testing picks the element the operator can see', () => {
  const targets = [
    {index: 0, cell: {column: 2, row: 1}, widthInCells: 4},
    {index: 1, cell: {column: 10, row: 4}, widthInCells: 8},
    {index: 2, cell: {column: 10, row: 4}, widthInCells: 8}, // drawn on top
  ];

  it('finds an element anywhere across its token width', () => {
    expect(hitTestOsdElements({x: 41, y: 21}, BOX, HD, targets)).toBe(0);
    expect(hitTestOsdElements({x: 115, y: 25}, BOX, HD, targets)).toBe(0);
  });

  it('returns the topmost element where two overlap', () => {
    expect(hitTestOsdElements({x: 210, y: 90}, BOX, HD, targets)).toBe(2);
  });

  it('returns nothing for empty video, so a drag never starts on air', () => {
    expect(hitTestOsdElements({x: 700, y: 300}, BOX, HD, targets)).toBeUndefined();
    expect(hitTestOsdElements({x: 41, y: 21}, {width: 0, height: 0}, HD, targets)).toBeUndefined();
  });
});
