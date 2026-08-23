import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { readFileSync } from 'fs';
import { join } from 'path';
import { StyleSheet, Text } from 'react-native';

import '../../i18n';
import i18n from '../../i18n';
import { MOTOR_TEST_EXPECTED_CONFIGURATION } from '../../core/state/motorVerificationModel';
import {
  MOTOR_AIRFRAME_STAGE_MIN_WIDTH,
  MotorAirframeDiagram,
  computeAirframeStageWidth,
  orderAirframeEntries,
} from './MotorAirframeDiagram';

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await i18n.init();
  }
});

const ENTRIES = MOTOR_TEST_EXPECTED_CONFIGURATION.map(entry => ({
  slot: entry.motorNumber,
  position: entry.position,
  direction: entry.direction,
}));

describe('MotorAirframeDiagram', () => {
  it('orders the visible aircraft front row then rear row without relying on RTL wrapping', () => {
    expect(orderAirframeEntries(ENTRIES).map(entry => entry.slot)).toEqual([
      2, 4, 1, 3,
    ]);
  });

  it('renders all four exact slots and selects only the requested one', () => {
    let selected = 0;
    let tree!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      tree = ReactTestRenderer.create(
        <MotorAirframeDiagram
          mixerModeRaw={3}
          motorNumbers={[1, 2, 3, 4]}
          selectedSlot={2}
          liveSlot={3}
          verifiedSlots={[1, 4]}
          onSelectSlot={slot => {
            selected = slot;
          }}
        />,
      );
    });

    for (const slot of [1, 2, 3, 4]) {
      expect(
        tree.root.findAll(
          node => node.props?.testID === `motors-diagram-slot-${slot}`,
        ),
      ).not.toHaveLength(0);
    }
    const selectedNode = tree.root.find(
      node => node.props?.testID === 'motors-airframe-slot-2',
    );
    expect(selectedNode.props.accessibilityState.selected).toBe(true);
    act(() => {
      tree.root
        .find(node => node.props?.testID === 'motors-airframe-slot-4')
        .props.onPress();
    });
    expect(selected).toBe(4);
    act(() => tree.unmount());
  });

  it('fails loudly rather than drawing an incomplete aircraft reference', () => {
    expect(() => orderAirframeEntries(ENTRIES.slice(0, 3))).toThrow(
      'Missing motor reference',
    );
  });

  /**
   * REPLACES the previous "about half the previous stage area" pin.
   *
   * That pin encoded a 2024 decision to shrink the diagram. A real
   * operator then reported the result as unusable: "not recognisably a
   * Quad X", front unclear, M1-M4 unclear, CW/CCW unclear. The decision
   * is therefore reversed deliberately here rather than the test being
   * quietly loosened - what is pinned now is that the diagram SCALES with
   * the viewport and never drops below the audited touch-target floor.
   */
  it('scales the stage with the viewport instead of capping every screen at a phone glyph', () => {
    const phone = computeAirframeStageWidth(390, 1);
    const tablet = computeAirframeStageWidth(820, 1);
    const desktop = computeAirframeStageWidth(1366, 1);
    const desktopWide = computeAirframeStageWidth(1920, 1);

    expect(phone).toBeGreaterThanOrEqual(MOTOR_AIRFRAME_STAGE_MIN_WIDTH);
    expect(tablet).toBeGreaterThan(phone);
    expect(desktop).toBeGreaterThan(tablet);
    expect(desktopWide).toBeGreaterThan(desktop);
    // A desktop operator gets a genuinely large drawing, not 156px.
    expect(desktop).toBeGreaterThanOrEqual(400);
  });

  it('never goes below the audited touch-target floor, however little room there is', () => {
    // A 240px window has 192px of usable room: above the floor, and the
    // diagram takes exactly that rather than overflowing to its tier size.
    expect(computeAirframeStageWidth(240, 1)).toBe(192);
    // With no room at all it still refuses to shrink past the floor.
    expect(computeAirframeStageWidth(0, 1)).toBe(MOTOR_AIRFRAME_STAGE_MIN_WIDTH);
    expect(computeAirframeStageWidth(100, 1)).toBe(MOTOR_AIRFRAME_STAGE_MIN_WIDTH);
    expect(computeAirframeStageWidth(Number.NaN, 1)).toBeGreaterThanOrEqual(
      MOTOR_AIRFRAME_STAGE_MIN_WIDTH,
    );
    // A large text scale reduces the effective width, so the diagram
    // steps back down a tier rather than crowding the labels out.
    expect(computeAirframeStageWidth(1366, 2)).toBeLessThan(
      computeAirframeStageWidth(1366, 1),
    );
  });

  it('never overflows the window it is drawn in', () => {
    for (const width of [320, 375, 600, 900, 1280, 1920]) {
      expect(computeAirframeStageWidth(width, 1)).toBeLessThanOrEqual(
        Math.max(MOTOR_AIRFRAME_STAGE_MIN_WIDTH, width),
      );
    }
  });

  it('renders a square stage whose width matches the computed size', () => {
    let tree!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      tree = ReactTestRenderer.create(
        <MotorAirframeDiagram
          mixerModeRaw={3}
          motorNumbers={[1, 2, 3, 4]}
          selectedSlot={1}
          verifiedSlots={[]}
          onSelectSlot={() => undefined}
        />,
      );
    });
    const stage = tree.root.find(
      node => node.props?.testID === 'motors-airframe-stage',
    );
    const style = StyleSheet.flatten(stage.props.style);
    expect(style.width).toBe(style.height);
    expect(style.width).toBeGreaterThanOrEqual(MOTOR_AIRFRAME_STAGE_MIN_WIDTH);
    act(() => tree.unmount());
  });

  it('states the aircraft front and every motor number in TEXT, not colour', () => {
    let tree!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      tree = ReactTestRenderer.create(
        <MotorAirframeDiagram
          mixerModeRaw={3}
          motorNumbers={[1, 2, 3, 4]}
          selectedSlot={1}
          verifiedSlots={[]}
          onSelectSlot={() => undefined}
        />,
      );
    });
    const json = JSON.stringify(tree.toJSON());
    expect(json).toContain(i18n.t('motorsScreen.diagramFront'));
    for (const slot of [1, 2, 3, 4]) {
      expect(json).toContain(`M${slot}`);
    }
    // M-D §25: and states NO rotation. An authored layout carries no
    // direction field, so there is nothing here to draw an arrow from.
    expect(json).not.toContain('"CW"');
    expect(json).not.toContain('"CCW"');
    // THE KEY DESCRIBES THIS MAP, NOT EVERY MAP THERE COULD BE.
    // Six state names used to be printed at all times, so before touching
    // anything an operator read five keys for colours that were not on
    // the drawing. The property that MATTERS - no state is ever conveyed
    // by colour alone - is unchanged and is proven per state below: the
    // key lists exactly what is drawn, and nothing that is not.
    expect(json).toContain(i18n.t('motorsScreen.legendSelected'));
    for (const absent of [
      'motorsScreen.legendSubmitted',
      'motorsScreen.legendAcknowledged',
      'motorsScreen.legendStopping',
      'motorsScreen.legendUnsafe',
      'motorsScreen.legendObserved',
    ]) {
      expect([absent, json.includes(i18n.t(absent))]).toEqual([absent, false]);
    }
    act(() => tree.unmount());
  });

  it.each([
    ['SUBMITTED', 'motorsScreen.legendSubmitted'],
    ['ACKNOWLEDGED', 'motorsScreen.legendAcknowledged'],
    ['STOPPING', 'motorsScreen.legendStopping'],
    ['UNSAFE', 'motorsScreen.legendUnsafe'],
  ] as const)(
    'names the %s state in the key exactly when that state is drawn',
    (activity, key) => {
      let tree!: ReactTestRenderer.ReactTestRenderer;
      act(() => {
        tree = ReactTestRenderer.create(
          <MotorAirframeDiagram
            mixerModeRaw={3}
          motorNumbers={[1, 2, 3, 4]}
            selectedSlot={1}
            liveSlot={1}
            liveActivity={activity}
            verifiedSlots={[]}
            onSelectSlot={() => undefined}
          />,
        );
      });
      expect(JSON.stringify(tree.toJSON())).toContain(i18n.t(key));
      act(() => tree.unmount());
    },
  );

  it('names the observed state in the key once an output is confirmed', () => {
    let tree!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      tree = ReactTestRenderer.create(
        <MotorAirframeDiagram
          mixerModeRaw={3}
          motorNumbers={[1, 2, 3, 4]}
          selectedSlot={1}
          verifiedSlots={[2]}
          onSelectSlot={() => undefined}
        />,
      );
    });
    expect(JSON.stringify(tree.toJSON())).toContain(
      i18n.t('motorsScreen.legendObserved'),
    );
    act(() => tree.unmount());
  });

  it.each([
    ['SUBMITTED', 'motorsScreen.slotStateSubmitted'],
    ['ACKNOWLEDGED', 'motorsScreen.slotStateAcknowledged'],
    ['STOPPING', 'motorsScreen.slotStateStopping'],
    ['UNSAFE', 'motorsScreen.slotStateUnsafe'],
  ] as const)('labels the live slot %s in words on the node itself', (activity, key) => {
    let tree!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      tree = ReactTestRenderer.create(
        <MotorAirframeDiagram
          mixerModeRaw={3}
          motorNumbers={[1, 2, 3, 4]}
          selectedSlot={1}
          liveSlot={3}
          liveActivity={activity}
          verifiedSlots={[]}
          onSelectSlot={() => undefined}
        />,
      );
    });
    const badge = tree.root.find(
      node => node.props?.testID === 'motors-diagram-state-3',
    );
    const badgeText = badge
      .findAllByType(Text)
      .map(node => String(node.props.children))
      .join(' ');
    expect(badgeText).toContain(i18n.t(key));
    // Only the live slot is labelled.
    expect(
      tree.root.findAll(node => node.props?.testID === 'motors-diagram-state-4'),
    ).toHaveLength(0);
    act(() => tree.unmount());
  });

  it('remains a geometry and selection layer with no command path', () => {
    const source = readFileSync(
      join(__dirname, 'MotorAirframeDiagram.tsx'),
      'utf8',
    );
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
