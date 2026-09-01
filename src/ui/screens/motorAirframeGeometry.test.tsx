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
} from './MotorAirframeDiagram';

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

  it('never drops or invents a motor', () => {
    const cells = computeMotorGlyphLayout();
    // Same set of slots the shipped expectation names, no more and no
    // fewer: rendering can never renumber an output.
    expect([...cells.map(cell => cell.slot)].sort()).toEqual([1, 2, 3, 4]);
    expect(new Set(cells.map(cell => `${cell.row}:${cell.side}`)).size).toBe(4);
  });

  it('places a motor from its coordinate, and never from the writing direction', () => {
    /*
     * THE DEFECT THIS REPLACES, and why the assertion changed shape.
     *
     * The old drawing was two flex rows, so "which side is this motor on"
     * was a question about PAINT ORDER, and paint order under RTL is the
     * reverse of paint order under LTR. The test therefore had to expect
     * a different first child in each direction and reason about which
     * edge "first" meant.
     *
     * M-E's drawing positions every node absolutely from the layout
     * table's own x coordinate. `left` is a PHYSICAL CSS offset - it is
     * measured from the left edge under `direction: rtl` exactly as under
     * ltr - so the same motor lands on the same pixel in both, and the
     * assertion is now simply that the two runs agree.
     */
    const offsets = (rtl: boolean): Record<number, number> => {
      mockRtl = rtl;
      let tree: renderer.ReactTestRenderer;
      act(() => {
        tree = renderer.create(
          <MotorAirframeDiagram
            mixerModeRaw={3}
            motorNumbers={[1, 2, 3, 4]}
            selectedSlot={1}
            onSelectSlot={() => {}}
          />,
        );
      });
      const out: Record<number, number> = {};
      for (const slot of [1, 2, 3, 4]) {
        const node = tree!.root.findAll(
          candidate => candidate.props?.testID === `motors-airframe-slot-${slot}`,
        )[0];
        out[slot] = flattenStyle(node.props.style).left as number;
      }
      act(() => tree!.unmount());
      return out;
    };

    const underRtl = offsets(true);
    const underLtr = offsets(false);
    mockRtl = true;
    expect(underRtl).toEqual(underLtr);
    // And the real wiring, not an accidental identity: on a QUADX motors
    // 1 and 2 are the right-hand pair, 3 and 4 the left-hand pair.
    expect(underLtr[1]).toBeGreaterThan(underLtr[3]);
    expect(underLtr[2]).toBeGreaterThan(underLtr[4]);
  });
});
