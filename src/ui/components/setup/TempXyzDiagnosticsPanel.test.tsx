/**
 * TEMP — Pass 7.5B pitch/front hardware diagnostics — DO NOT MERGE
 *
 * Panel-level checks: visible temporary labelling, accessibility
 * exclusion, dash-safe empty states, and — critically — that mounting
 * the panel creates NO timer of any kind (it must re-render only with
 * its caller, never self-schedule).
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import {act} from 'react-test-renderer';
import {Text} from 'react-native';

import TempXyzDiagnosticsPanel from './TempXyzDiagnosticsPanel';
import type {OrientationDiagnosticsSnapshot} from './orientationDiagnostics';

const FRESH_SNAPSHOT: OrientationDiagnosticsSnapshot = {
  status: 'FRESH',
  ageMs: 87,
  raw: {rollDecidegrees: 123, pitchDecidegrees: -271, yawDegrees: 184},
  converted: {rawRollDeg: 12.3, rawPitchDeg: -27.1, rawYawDeg: 184},
  render: {renderRollDeg: 12.3, renderPitchDeg: -27.1, renderYawDeg: 184},
  modelFrontAxis: '+X',
  frontMotors: 'BLUE PAIR',
  projectedFront: {
    centre: {x: 130, y: 130},
    front: {x: 148.4, y: 120.8},
    frontScreenDeltaX: 18.4,
    frontScreenDeltaY: -9.2,
    frontRiseFromZero: -4.4,
  },
};

function allText(renderer: ReactTestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => (Array.isArray(node.props.children) ? node.props.children.join('') : String(node.props.children)))
    .join('\n');
}

describe('TempXyzDiagnosticsPanel', () => {
  it('renders the mandatory temporary label, all three value rows, front identity, and age/status - and creates NO timer', () => {
    jest.useFakeTimers();
    try {
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      act(() => {
        renderer = ReactTestRenderer.create(<TempXyzDiagnosticsPanel snapshot={FRESH_SNAPSHOT} />);
      });

      const text = allText(renderer);
      expect(text).toContain('TEMP XYZ DIAGNOSTICS — DO NOT MERGE');
      expect(text).toContain('R:+12.3°');
      expect(text).toContain('P:-27.1°');
      expect(text).toContain('H:184°');
      expect(text).toContain('MODEL FRONT: +X / BLUE PAIR');
      expect(text).toContain('ΔX:+18.4');
      expect(text).toContain('ΔY:-9.2');
      expect(text).toContain('RISE:-4.4');
      expect(text).toContain('AGE: 87 ms / FRESH');

      expect(jest.getTimerCount()).toBe(0);

      act(() => {
        renderer.unmount();
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('is excluded from the accessibility tree (no screen-reader noise from rapidly updating numbers)', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<TempXyzDiagnosticsPanel snapshot={FRESH_SNAPSHOT} />);
    });
    const container = renderer.root.findAllByProps({testID: 'temp-xyz-diagnostics'})[0];
    expect(container.props.accessibilityElementsHidden).toBe(true);
    expect(container.props.importantForAccessibility).toBe('no-hide-descendants');
    act(() => {
      renderer.unmount();
    });
  });

  it('renders dashes safely when telemetry has no values yet (WAITING)', () => {
    const waiting: OrientationDiagnosticsSnapshot = {
      status: 'WAITING',
      modelFrontAxis: '+X',
      frontMotors: 'BLUE PAIR',
    };
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<TempXyzDiagnosticsPanel snapshot={waiting} />);
    });
    const text = allText(renderer);
    expect(text).toContain('R:—');
    expect(text).toContain('AGE: — / WAITING');
    act(() => {
      renderer.unmount();
    });
  });
});
