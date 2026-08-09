/**
 * PHYSICAL GEOMETRY IS LOCALE-INDEPENDENT.
 *
 * A quad diagram is a map of real hardware. If the UI's reading direction
 * could move FRONT_RIGHT to the left of the screen, an operator reading
 * that diagram would conclude their outputs are mapped wrong and would
 * "correct" a correctly-wired aircraft. A mirroring bug must never be
 * mistakable for a motor-remapping operation.
 *
 * These tests pin the two halves of that guarantee:
 *  1. the DATA half - slot -> physical position, which no rendering
 *     concern may touch;
 *  2. the PAINT half - the row that draws the motors states its own
 *     direction instead of inheriting the document's, so the same slot
 *     lands on the same physical side under RTL and LTR alike.
 *
 * The row previously inherited direction, and in a dir="rtl" document
 * that inverted the drawing. See motorRow in MotorAirframeDiagram.tsx.
 */
import React from 'react';
import {I18nManager, View} from 'react-native';
import renderer, {act} from 'react-test-renderer';

import {
  MotorAirframeDiagram,
  computeMotorGlyphLayout,
  motorGlyphRows,
  orderAirframeEntries,
} from './MotorAirframeDiagram';
import type {MotorAirframeEntry} from './MotorAirframeDiagram';

/** The canonical wiring: slot N sits at a fixed physical corner. */
const ENTRIES: readonly MotorAirframeEntry[] = Object.freeze([
  {slot: 1, position: 'REAR_RIGHT', direction: 'CW'},
  {slot: 2, position: 'FRONT_RIGHT', direction: 'CCW'},
  {slot: 3, position: 'REAR_LEFT', direction: 'CCW'},
  {slot: 4, position: 'FRONT_LEFT', direction: 'CW'},
] as MotorAirframeEntry[]);

function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.map(flattenStyle));
  }
  return (style ?? {}) as Record<string, unknown>;
}

describe('motor airframe geometry', () => {
  it('maps every slot to one fixed physical corner', () => {
    const cells = computeMotorGlyphLayout();
    const bySlot = new Map(cells.map(cell => [cell.slot, cell]));
    expect(bySlot.get(1)).toMatchObject({row: 'REAR', side: 'RIGHT'});
    expect(bySlot.get(2)).toMatchObject({row: 'FRONT', side: 'RIGHT'});
    expect(bySlot.get(3)).toMatchObject({row: 'REAR', side: 'LEFT'});
    expect(bySlot.get(4)).toMatchObject({row: 'FRONT', side: 'LEFT'});
  });

  it('keeps slot -> physical position identical whichever way the UI reads', () => {
    const wasRTL = I18nManager.isRTL;
    try {
      const snapshot = () =>
        computeMotorGlyphLayout().map(
          cell => `${cell.slot}:${cell.row}:${cell.side}`,
        );

      I18nManager.forceRTL(true);
      const underRtl = snapshot();
      const rowsUnderRtl = motorGlyphRows().map(row =>
        row.map(cell => cell.slot),
      );

      I18nManager.forceRTL(false);
      const underLtr = snapshot();
      const rowsUnderLtr = motorGlyphRows().map(row =>
        row.map(cell => cell.slot),
      );

      expect(underRtl).toEqual(underLtr);
      expect(rowsUnderRtl).toEqual(rowsUnderLtr);
      // And the mapping is the real wiring, not an accidental identity.
      expect(underLtr).toContain('2:FRONT:RIGHT');
      expect(underLtr).toContain('4:FRONT:LEFT');
    } finally {
      I18nManager.forceRTL(wasRTL);
    }
  });

  it('orders entries right-then-left, and never drops or invents a motor', () => {
    const ordered = orderAirframeEntries(ENTRIES);
    expect(ordered.map(entry => entry.position)).toEqual([
      'FRONT_RIGHT',
      'FRONT_LEFT',
      'REAR_RIGHT',
      'REAR_LEFT',
    ]);
    // Same set of slots in, same set out: rendering reorders for PAINT
    // only and can never renumber an output.
    expect([...ordered.map(entry => entry.slot)].sort()).toEqual([1, 2, 3, 4]);
  });

  it('states the motor row direction instead of inheriting the document', () => {
    let tree: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <MotorAirframeDiagram
          entries={ENTRIES}
          selectedSlot={1}
          onSelectSlot={() => {}}
        />,
      );
    });
    const stage = tree!.root.findByProps({testID: 'motors-airframe-stage'});
    const rows = stage
      .findAllByType(View)
      .map(node => flattenStyle(node.props.style))
      .filter(style => style.flexDirection === 'row-reverse');
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      // Without this, a dir="rtl" document silently mirrors the aircraft.
      expect(row.direction).toBe('ltr');
    }
    act(() => tree!.unmount());
  });
});
