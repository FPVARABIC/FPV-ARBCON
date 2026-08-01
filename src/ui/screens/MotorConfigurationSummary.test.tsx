import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { readFileSync } from 'fs';
import { join } from 'path';

import '../../i18n';
import i18n from '../../i18n';
import {
  formatMotorProtocol,
  MotorConfigurationSummary,
} from './MotorConfigurationSummary';

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await i18n.init();
  }
});

function render(
  scope: React.ComponentProps<typeof MotorConfigurationSummary>['scope'],
) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(
      <MotorConfigurationSummary scope={scope} />,
    );
  });
  return tree;
}

describe('MotorConfigurationSummary', () => {
  it('keeps unavailable values honest before the session reads them', () => {
    const tree = render(undefined);
    const text = JSON.stringify(tree.toJSON());
    expect(text).toContain('ستظهر القيم بعد أول ضغط مطوّل وتهيئة الاختبار');
    expect(text.match(/—/g)).toHaveLength(3);
    act(() => tree.unmount());
  });

  it('renders the exact decoded scope without adding a control', () => {
    const tree = render({
      motorCount: 4,
      motorProtocolRaw: 7,
      feature3dEnabled: false,
    });
    const text = JSON.stringify(tree.toJSON());
    expect(text).toContain('DSHOT600');
    expect(text).toContain('معطّل');
    expect(text).toContain('قراءة من متحكم الطيران');
    expect(
      tree.root.findAll(node => typeof node.props?.onPress === 'function'),
    ).toHaveLength(0);
    act(() => tree.unmount());
  });

  it('marks 3D enabled as a displayed fact, never as permission', () => {
    const tree = render({
      motorCount: 4,
      motorProtocolRaw: 7,
      feature3dEnabled: true,
    });
    expect(JSON.stringify(tree.toJSON())).toContain('مفعّل');
    act(() => tree.unmount());
  });

  it('names known protocol values and preserves unknown raw values', () => {
    expect(formatMotorProtocol(undefined)).toBe('—');
    expect(formatMotorProtocol(5)).toBe('DSHOT150');
    expect(formatMotorProtocol(7)).toBe('DSHOT600');
    expect(formatMotorProtocol(42)).toBe('RAW 42');
  });

  it('stays read-only and cannot request, configure or activate a motor', () => {
    const source = readFileSync(
      join(__dirname, 'MotorConfigurationSummary.tsx'),
      'utf8',
    );
    const executable = source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    for (const forbidden of [
      'Pressable',
      'MspClient',
      'MSP_SET_MOTOR',
      'request(',
      'pulseMotor',
      'activation.allowed',
    ]) {
      expect(executable).not.toContain(forbidden);
    }
  });
});
