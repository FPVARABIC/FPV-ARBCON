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
import {View} from 'react-native';
import renderer, {act} from 'react-test-renderer';

/**
 * Direction is INJECTED, not toggled through I18nManager.
 *
 * Two platform stubs make the global useless as a test lever, and both
 * were discovered the hard way: react-native-web's I18nManager is a
 * no-op (see layoutDirection.web.ts), and under the React Native Jest
 * preset forceRTL() does not move isRTL either - so an assertion that
 * "toggles" direction and compares the two results passes vacuously.
 * Mocking the one helper the component actually consults is the only
 * honest way to exercise both directions.
 */
let mockRtl = true;
jest.mock('../icons/layoutDirection', () => ({
  isRtlLayout: () => mockRtl,
}));

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

  it('derives slot -> physical position from data alone, with no direction input', () => {
    const snapshot = () =>
      computeMotorGlyphLayout().map(
        cell => `${cell.slot}:${cell.row}:${cell.side}`,
      );
    mockRtl = true;
    const underRtl = snapshot();
    const rowsUnderRtl = motorGlyphRows().map(row => row.map(c => c.slot));
    mockRtl = false;
    const underLtr = snapshot();
    const rowsUnderLtr = motorGlyphRows().map(row => row.map(c => c.slot));
    mockRtl = true;

    expect(underRtl).toEqual(underLtr);
    expect(rowsUnderRtl).toEqual(rowsUnderLtr);
    // The real wiring, not an accidental identity.
    expect(underLtr).toContain('2:FRONT:RIGHT');
    expect(underLtr).toContain('4:FRONT:LEFT');
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

  it('paints FRONT_RIGHT on the right and FRONT_LEFT on the left in BOTH directions', () => {
    // The defect this replaces: the row relied on `direction: 'ltr'`,
    // which react-native-web DROPS, so the aircraft rendered mirrored in
    // the browser while a style-object assertion still passed. Assert the
    // paint ORDER of the real rows instead - index 0 of a plain flex row
    // is the reading-start edge, which is the right under RTL and the
    // left under LTR.
    const sideOfFirstChild = (rtl: boolean): {front: string; rear: string} => {
      mockRtl = rtl;
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
        .filter(node => flattenStyle(node.props.style).justifyContent === 'space-between');
      const firstSlotOf = (row: (typeof rows)[number]): string => {
        const slotNode = row
          .findAllByProps({})
          .map(node => String(node.props.testID ?? ''))
          .find(id => id.startsWith('motors-diagram-slot-'));
        return (slotNode ?? '').replace('motors-diagram-slot-', '');
      };
      const result = {front: firstSlotOf(rows[0]), rear: firstSlotOf(rows[1])};
      act(() => tree!.unmount());
      return result;
    };

    // Slot 2 is FRONT_RIGHT and slot 1 is REAR_RIGHT (see ENTRIES).
    // Under RTL the reading-start edge is the RIGHT, so the right-hand
    // motor must be painted first...
    expect(sideOfFirstChild(true)).toEqual({front: '2', rear: '1'});
    // ...and under LTR the start edge is the LEFT, so the LEFT-hand
    // motors (4 = FRONT_LEFT, 3 = REAR_LEFT) come first. Either way the
    // same motor ends up on the same physical side of the aircraft.
    expect(sideOfFirstChild(false)).toEqual({front: '4', rear: '3'});
  });
});
