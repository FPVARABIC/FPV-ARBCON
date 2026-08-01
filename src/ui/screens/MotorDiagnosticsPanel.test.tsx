import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';

import '../../i18n';
import i18n from '../../i18n';
import type { TelemetryValue } from '../../core';
import {
  MotorDiagnosticsPanel,
  motorOutputPercent,
  rpmMeterPercent,
} from './MotorDiagnosticsPanel';

let mockOutputValue: TelemetryValue<unknown> = { status: 'UNAVAILABLE' };
let mockEscValue: TelemetryValue<unknown> = { status: 'UNAVAILABLE' };

jest.mock('../../platforms/react-native/protocol', () => ({
  acquireMotorDiagnosticsTelemetry: jest.fn(() => () => undefined),
  getMotorDiagnosticsAvailability: jest.fn(() => ({
    outputs: 'ACTIVE',
    escTelemetry: 'ACTIVE',
  })),
  subscribeMotorDiagnosticsAvailability: jest.fn(() => () => undefined),
  MOTOR_OUTPUTS_TELEMETRY_POLL_ID: 'motorOutputs',
  MOTOR_ESC_TELEMETRY_POLL_ID: 'motorEscTelemetry',
  useTelemetryValue: jest.fn((_sessionId: string, pollId: string) =>
    pollId === 'motorOutputs' ? mockOutputValue : mockEscValue,
  ),
}));

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await i18n.init();
  }
});

describe('MotorDiagnosticsPanel', () => {
  beforeEach(() => {
    mockOutputValue = { status: 'UNAVAILABLE' };
    mockEscValue = { status: 'UNAVAILABLE' };
  });

  it('uses stable absolute scales for FC output and RPM meters', () => {
    expect(motorOutputPercent(1000)).toBe(0);
    expect(motorOutputPercent(1500)).toBe(50);
    expect(motorOutputPercent(2500)).toBe(100);
    expect(rpmMeterPercent(25_000)).toBe(50);
    expect(rpmMeterPercent(60_000)).toBe(100);
  });

  it('renders real FC output values and every available ESC metric', async () => {
    mockOutputValue = {
      status: 'FRESH',
      value: { values: [1000, 1050, 1250, 2000, 0, 0, 0, 0] },
      updatedAtMs: 1,
    };
    mockEscValue = {
      status: 'FRESH',
      value: {
        motorCount: 1,
        motors: [
          {
            rpm: 12_345,
            invalidPercentRaw: 250,
            temperatureCelsius: 44,
            voltageCentivolts: 1680,
            currentCentiamps: 325,
            consumptionMah: 91,
          },
        ],
      },
      updatedAtMs: 1,
    };
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(
        <MotorDiagnosticsPanel sessionId="fc-live" />,
      );
    });
    const text = JSON.stringify(tree.toJSON());
    expect(text).toContain('مراقبة المحركات وESC');
    expect(text).toContain('12345 RPM');
    expect(text).toContain('أخطاء 2.50٪');
    expect(text).toContain('حرارة 44°C');
    expect(text).toContain('جهد 16.80V');
    expect(text).toContain('تيار 3.25A');
    expect(text).toContain('استهلاك 91mAh');
    expect(
      tree.root.findByProps({ testID: 'esc-telemetry-quality-warning' }),
    ).toBeDefined();
    expect(
      tree.root.findByProps({ testID: 'motor-output-reading-2' }),
    ).toBeDefined();
    act(() => tree.unmount());
  });

  it('does not invent ESC values when the capability is unavailable', async () => {
    mockOutputValue = { status: 'WAITING' };
    mockEscValue = { status: 'UNAVAILABLE' };
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(
        <MotorDiagnosticsPanel sessionId="fc-no-esc" />,
      );
    });
    const text = JSON.stringify(tree.toJSON());
    expect(text).toContain('لن يعرض التطبيق أرقامًا تقديرية');
    expect(
      tree.root.findAllByProps({ testID: 'esc-telemetry-1' }),
    ).toHaveLength(0);
    act(() => tree.unmount());
  });
});
