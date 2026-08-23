/**
 * THE AIRFRAME MAP'S OWN CONTRACTS.
 *
 * M-E rewrote this component from a four-cell grid into a coordinate-driven
 * drawing, so the assertions below are expressed against the new structure.
 * Every property the previous version pinned is still pinned:
 *
 *   - all N motor numbers are on screen as TEXT;
 *   - the aircraft front is stated in TEXT;
 *   - no state is ever conveyed by colour alone;
 *   - only the live output is marked;
 *   - a right-to-left interface does not move a motor to the other side;
 *   - no rotation is drawn, on any airframe;
 *   - the file remains a geometry and selection layer with no command path.
 *
 * What CHANGED is the size contract. The old test pinned "the stage grows
 * with the viewport" and asserted at least 400px on a desktop. M-E measured
 * the consequence - 462px of aircraft on a 900px viewport, with the Motor
 * Test controls 1288px down the phone page - and reversed the decision
 * deliberately rather than loosening it quietly. What is pinned now is a
 * CEILING, and that the stage is derived from the geometry it has to show.
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {readFileSync} from 'fs';
import {join} from 'path';
import {StyleSheet} from 'react-native';

import '../../i18n';
import i18n from '../../i18n';
import {authoredAirframeLayout} from '../../core/state/motorAirframeLayout';
import {
  MOTOR_AIRFRAME_STAGE_MAX_WIDTH,
  MOTOR_AIRFRAME_STAGE_MIN_WIDTH,
  MotorAirframeDiagram,
  computeAirframeStageWidth,
  computeDiagramNodes,
  motorGlyphRows,
} from './MotorAirframeDiagram';

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await i18n.init();
  }
});

const layoutFor = (mixerModeRaw: number, motors: number) => {
  const found = authoredAirframeLayout(
    mixerModeRaw,
    Array.from({length: motors}, (_, index) => index + 1),
  );
  if (found === undefined) {
    throw new Error(`no authored layout for mixer ${mixerModeRaw}`);
  }
  return found;
};

const render = (
  props: Partial<React.ComponentProps<typeof MotorAirframeDiagram>> = {},
): ReactTestRenderer.ReactTestRenderer => {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(
      <MotorAirframeDiagram
        mixerModeRaw={3}
        motorNumbers={[1, 2, 3, 4]}
        selectedSlot={1}
        verifiedSlots={[]}
        onSelectSlot={() => undefined}
        {...props}
      />,
    );
  });
  return tree;
};

describe('MotorAirframeDiagram', () => {
  it('renders every reported slot and selects only the requested one', () => {
    let selected = 0;
    const tree = render({
      selectedSlot: 2,
      liveSlot: 3,
      verifiedSlots: [1, 4],
      onSelectSlot: slot => {
        selected = slot;
      },
    });
    for (const slot of [1, 2, 3, 4]) {
      expect(
        tree.root.findAll(node => node.props?.testID === `motors-diagram-slot-${slot}`),
      ).not.toHaveLength(0);
    }
    expect(
      tree.root.find(node => node.props?.testID === 'motors-airframe-slot-2').props
        .accessibilityState.selected,
    ).toBe(true);
    act(() => {
      tree.root
        .find(node => node.props?.testID === 'motors-airframe-slot-4')
        .props.onPress();
    });
    expect(selected).toBe(4);
    act(() => tree.unmount());
  });

  it('never substitutes another aircraft for an unknown mixer', () => {
    // Mutation testing found this: the earlier check used a three-motor
    // list, which the count comparison rejected on its own, so a
    // substitution that fell back to the Quad X layout went unnoticed.
    // The count matches here, and the answer must still be nothing.
    const tree = render({mixerModeRaw: 250, motorNumbers: [1, 2, 3, 4]});
    expect(
      tree.root.findAll(node => node.props?.testID === 'motors-airframe-stage'),
    ).toHaveLength(0);
    expect(
      tree.root.findAll(node => node.props?.testID === 'motors-generic-outputs'),
    ).not.toHaveLength(0);
    act(() => tree.unmount());
  });

  it('draws nothing rather than an aircraft it cannot place', () => {
    // A hex with no authored layout, an unread mixer, and a QUADX byte with
    // six reported motors all reach the same numbered answer.
    for (const props of [
      {mixerModeRaw: 18, motorNumbers: [1, 2, 3, 4, 5, 6]},
      {mixerModeRaw: undefined, motorNumbers: [1, 2, 3, 4]},
      {mixerModeRaw: 3, motorNumbers: [1, 2, 3, 4, 5, 6]},
    ]) {
      const tree = render(props);
      expect(
        tree.root.findAll(node => node.props?.testID === 'motors-generic-outputs'),
      ).not.toHaveLength(0);
      expect(
        tree.root.findAll(node => node.props?.testID === 'motors-airframe-stage'),
      ).toHaveLength(0);
      act(() => tree.unmount());
    }
  });

  /* ---------------- M-E §0 / §1 / §2 / §3: the size budget --------------- */

  it('keeps every airframe inside the compact ceiling', () => {
    const cases: ReadonlyArray<readonly [number, number]> = [
      [1, 3],
      [2, 4],
      [3, 4],
      [6, 6],
      [7, 6],
      [8, 1],
      [9, 4],
      [10, 6],
      [11, 8],
      [12, 8],
      [13, 8],
      [14, 1],
      [17, 4],
      [22, 4],
      [26, 4],
      [27, 8],
    ];
    for (const [mixerModeRaw, motors] of cases) {
      const stage = computeAirframeStageWidth(layoutFor(mixerModeRaw, motors));
      expect([mixerModeRaw, stage]).toEqual([
        mixerModeRaw,
        expect.any(Number),
      ]);
      expect(stage).toBeGreaterThanOrEqual(MOTOR_AIRFRAME_STAGE_MIN_WIDTH);
      expect(stage).toBeLessThanOrEqual(MOTOR_AIRFRAME_STAGE_MAX_WIDTH);
      /* THE CEILING IS PINNED TO A NUMBER, NOT TO ITSELF.
         Mutation testing found this: comparing against the exported
         constant means raising the constant raises the bound with it, so
         a change that made the drawing 520px wide passed. 200 is the
         number M-E is willing to spend on a compact orientation tool - a
         fifth of a 1000px viewport - and moving past it is a decision
         that has to be argued for here. */
      expect(stage).toBeLessThanOrEqual(200);
    }
    expect(MOTOR_AIRFRAME_STAGE_MAX_WIDTH).toBeLessThanOrEqual(200);
  });

  it('derives the stage from the geometry, so a denser aircraft gets a little more room', () => {
    const quad = computeAirframeStageWidth(layoutFor(3, 4));
    const hex = computeAirframeStageWidth(layoutFor(10, 6));
    const flatOcto = computeAirframeStageWidth(layoutFor(12, 8));
    expect(hex).toBeGreaterThan(quad);
    expect(flatOcto).toBeGreaterThan(hex);
    // ...and the densest aircraft is still not a poster.
    expect(flatOcto).toBeLessThanOrEqual(MOTOR_AIRFRAME_STAGE_MAX_WIDTH);
  });

  it('keeps a 44px touch target and 46px of clearance at the derived size', () => {
    for (const [mixerModeRaw, motors] of [
      [3, 4],
      [10, 6],
      [12, 8],
      [13, 8],
    ] as const) {
      const layout = layoutFor(mixerModeRaw, motors);
      const stage = computeAirframeStageWidth(layout);
      const nodes = computeDiagramNodes(layout);
      const reach = (stage - 44) / 2;
      for (let left = 0; left < nodes.length; left += 1) {
        for (let right = left + 1; right < nodes.length; right += 1) {
          const gap = Math.hypot(
            (nodes[left].x - nodes[right].x) * reach,
            (nodes[left].y - nodes[right].y) * reach,
          );
          // Only aircraft whose required stage was clipped by the ceiling
          // may come in under the clearance, and none of these are.
          expect([mixerModeRaw, Math.round(gap) >= 46]).toEqual([mixerModeRaw, true]);
        }
      }
    }
  });

  it('renders a square stage no wider than the ceiling', () => {
    const tree = render();
    const style = StyleSheet.flatten(
      tree.root.find(node => node.props?.testID === 'motors-airframe-stage').props.style,
    );
    expect(style.width).toBe(style.height);
    expect(style.width).toBeLessThanOrEqual(MOTOR_AIRFRAME_STAGE_MAX_WIDTH);
    act(() => tree.unmount());
  });

  /* ---------------- §14: the front marker is not optional ---------------- */

  it('states the aircraft front, on every authored airframe', () => {
    for (const [mixerModeRaw, motors] of [
      [1, 3],
      [3, 4],
      [8, 1],
      [10, 6],
      [11, 8],
      [14, 1],
    ] as const) {
      const tree = render({
        mixerModeRaw,
        motorNumbers: Array.from({length: motors}, (_, index) => index + 1),
      });
      expect(
        tree.root.findAll(node => node.props?.testID === 'motors-diagram-front'),
      ).not.toHaveLength(0);
      expect(JSON.stringify(tree.toJSON())).toContain(
        i18n.t('motorsScreen.diagramFront'),
      );
      act(() => tree.unmount());
    }
  });

  /* ---------------- §22 / §23: coaxial aircraft read as coaxial ---------- */

  it('draws a coaxial arm as one node carrying both motor numbers', () => {
    const nodes = computeDiagramNodes(layoutFor(11, 8));
    expect(nodes).toHaveLength(4);
    expect(nodes.map(node => [...node.slots])).toEqual([
      [1, 5],
      [2, 6],
      [3, 7],
      [4, 8],
    ]);
  });

  it('walks between the two motors on a coaxial arm when it is pressed', () => {
    const picked: number[] = [];
    const tree = render({
      mixerModeRaw: 11,
      motorNumbers: [1, 2, 3, 4, 5, 6, 7, 8],
      selectedSlot: 1,
      onSelectSlot: slot => picked.push(slot),
    });
    const arm = tree.root.find(
      node => node.props?.testID === 'motors-airframe-slot-1',
    );
    act(() => arm.props.onPress());
    expect(picked).toEqual([5]);
    act(() => tree.unmount());
  });

  it('gives a flat octo eight separate nodes, because it has eight arms', () => {
    expect(computeDiagramNodes(layoutFor(12, 8))).toHaveLength(8);
    expect(computeDiagramNodes(layoutFor(13, 8))).toHaveLength(8);
  });

  /* ---------------- Colour is never the only carrier ---------------- */

  it('states the front and every motor number in TEXT, and no rotation at all', () => {
    const tree = render();
    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain(i18n.t('motorsScreen.diagramFront'));
    for (const slot of [1, 2, 3, 4]) {
      expect(json).toContain(`M${slot}`);
    }
    // An authored layout carries no direction field, so there is nothing
    // here to draw an arrow from - on any airframe.
    expect(json).not.toContain('"CW"');
    expect(json).not.toContain('"CCW"');
    expect(json).not.toContain(i18n.t('motorsScreen.directionCw'));
    expect(json).not.toContain(i18n.t('motorsScreen.directionCcw'));
    act(() => tree.unmount());
  });

  it.each([
    ['SUBMITTED', 'motorsScreen.slotStateSubmitted'],
    ['ACKNOWLEDGED', 'motorsScreen.slotStateAcknowledged'],
    ['STOPPING', 'motorsScreen.slotStateStopping'],
    ['UNSAFE', 'motorsScreen.slotStateUnsafe'],
  ] as const)('names the %s state in Arabic words, not only in colour', (activity, key) => {
    const tree = render({liveSlot: 3, liveActivity: activity});
    const line = tree.root.find(
      node => node.props?.testID === 'motors-diagram-live-state',
    );
    expect(String(line.props.children)).toContain(i18n.t(key));
    expect(String(line.props.children)).toContain('M3');
    // Only the live output is marked on the drawing.
    expect(
      tree.root.findAll(node => node.props?.testID === 'motors-diagram-state-3'),
    ).not.toHaveLength(0);
    expect(
      tree.root.findAll(node => node.props?.testID === 'motors-diagram-state-4'),
    ).toHaveLength(0);
    act(() => tree.unmount());
  });

  it('names an observed output in words once it is confirmed', () => {
    const tree = render({verifiedSlots: [2]});
    expect(
      String(
        tree.root.find(node => node.props?.testID === 'motors-diagram-live-state').props
          .children,
      ),
    ).toContain(i18n.t('motorsScreen.slotStateObserved'));
    act(() => tree.unmount());
  });

  it('says nothing about state when nothing is happening', () => {
    const tree = render();
    expect(
      tree.root.findAll(node => node.props?.testID === 'motors-diagram-live-state'),
    ).toHaveLength(0);
    act(() => tree.unmount());
  });

  it('speaks the motor number and its place, and never a rotation', () => {
    const tree = render({mixerModeRaw: 10, motorNumbers: [1, 2, 3, 4, 5, 6]});
    const label = tree.root.find(
      node => node.props?.testID === 'motors-airframe-slot-1',
    ).props.accessibilityLabel;
    expect(label).toContain('M1');
    expect(label).toContain(i18n.t('motorsScreen.stationRearRight'));
    expect(label).not.toContain(i18n.t('motorsScreen.directionCw'));
    expect(label).not.toContain(i18n.t('motorsScreen.directionCcw'));
    act(() => tree.unmount());
  });

  /* ---------------- §21 / §26 / §27: servos are never motors ------------- */

  it('marks the airframe servos and says they are not part of the motor test', () => {
    const tree = render({mixerModeRaw: 1, motorNumbers: [1, 2, 3]});
    expect(
      tree.root.findAll(node => node.props?.testID === 'motors-diagram-servo'),
    ).not.toHaveLength(0);
    expect(
      String(
        tree.root.find(node => node.props?.testID === 'motors-diagram-servo-note').props
          .children,
      ),
    ).toBe(i18n.t('motorsScreen.servoNote.TAIL_YAW'));
    // A tricopter has three motors and no fourth node.
    expect(
      tree.root.findAll(node => node.props?.testID === 'motors-airframe-slot-4'),
    ).toHaveLength(0);
    act(() => tree.unmount());
  });

  it('says nothing about servos on an airframe whose mixer has none', () => {
    const tree = render();
    expect(
      tree.root.findAll(node => node.props?.testID === 'motors-diagram-servo'),
    ).toHaveLength(0);
    act(() => tree.unmount());
  });

  /* ---------------- §54: RTL is language, not geometry ---------------- */

  it('does not consult the layout direction when placing a motor', () => {
    // The rows are physical and derived from the shipped expectation, with
    // no locale term anywhere in the calculation.
    expect(motorGlyphRows().map(row => row.map(cell => cell.slot))).toEqual([
      [2, 4],
      [1, 3],
    ]);
    // ...and neither does the drawing: motor 1's horizontal offset comes
    // from its own x coordinate alone.
    const tree = render();
    const node = tree.root.find(
      node => node.props?.testID === 'motors-airframe-slot-1',
    );
    const style = StyleSheet.flatten(node.props.style);
    const stage = StyleSheet.flatten(
      tree.root.find(item => item.props?.testID === 'motors-airframe-stage').props.style,
    );
    // QUADX motor 1 is REAR RIGHT: right of centre and below it.
    expect(style.left + 22).toBeGreaterThan(stage.width / 2);
    expect(style.top + 22).toBeGreaterThan(stage.height / 2);
    act(() => tree.unmount());
  });

  it('remains a geometry and selection layer with no command path', () => {
    const source = readFileSync(join(__dirname, 'MotorAirframeDiagram.tsx'), 'utf8');
    const executable = source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    for (const forbidden of [
      'MspClient',
      'MSP_SET_MOTOR',
      'pulseMotor',
      'writeBytes',
      'activation.allowed',
    ]) {
      expect(executable).not.toContain(forbidden);
    }
  });
});
