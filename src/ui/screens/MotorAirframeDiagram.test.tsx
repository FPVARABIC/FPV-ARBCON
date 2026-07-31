import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { readFileSync } from 'fs';
import { join } from 'path';

import '../../i18n';
import i18n from '../../i18n';
import { MOTOR_TEST_EXPECTED_CONFIGURATION } from '../../core/state/motorVerificationModel';
import {
  MotorAirframeDiagram,
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
          entries={ENTRIES}
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
