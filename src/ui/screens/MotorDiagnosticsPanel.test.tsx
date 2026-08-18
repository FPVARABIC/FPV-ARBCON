import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';

import '../../i18n';
import i18n from '../../i18n';
import type { TelemetryValue } from '../../core';
import type { MotorTestDiagnosticsSnapshot } from '../../core/state/motorTestController';
import type { MotorTestOperatorPort } from '../../platforms/react-native/protocol';
import { acquireMotorDiagnosticsTelemetry } from '../../platforms/react-native/protocol';
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
    jest.mocked(acquireMotorDiagnosticsTelemetry).mockClear();
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
        <MotorDiagnosticsPanel
          sessionId="fc-live"
          support={{
            motorCount: 4,
            dshotTelemetryEnabled: true,
            escSensorEnabled: true,
            escTelemetrySource: 'BIDIRECTIONAL_DSHOT_AND_ESC_SENSOR',
          }}
        />,
      );
    });
    /* Bidi isolates (U+2066/U+2069) wrap the Latin runs in Arabic copy so
       an RTL layout does not print the conjunction to the left of the
       Latin word. They are invisible, so this asserts what a READER sees
       rather than the exact code points. */
    const text = JSON.stringify(tree.toJSON()).replace(/[\u2066-\u2069]/g, '');
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

  it('renders only fresh values read through the protected motor-test lease', async () => {
    const observedAtMillis = Date.now();
    const diagnostics: MotorTestDiagnosticsSnapshot = {
      outputs: {
        state: 'FRESH',
        value: {values: [1000, 1111, 1222, 1333]},
        observedAtMillis,
      },
      escTelemetry: {
        state: 'FRESH',
        value: {
          motorCount: 1,
          motors: [
            {
              rpm: 9_876,
              invalidPercentRaw: 25,
              temperatureCelsius: 39,
              voltageCentivolts: 1650,
              currentCentiamps: 210,
              consumptionMah: 44,
            },
          ],
        },
        observedAtMillis,
      },
    };
    const operator = {
      refreshDiagnostics: jest.fn(async () => diagnostics),
    } as unknown as MotorTestOperatorPort;
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(
        <MotorDiagnosticsPanel
          sessionId="fc-leased"
          operator={operator}
          activeMotorTest
          motorTestDiagnostics={diagnostics}
          support={{
            motorCount: 4,
            dshotTelemetryEnabled: true,
            escSensorEnabled: true,
            escTelemetrySource: 'BIDIRECTIONAL_DSHOT_AND_ESC_SENSOR',
          }}
        />,
      );
    });
    const text = JSON.stringify(tree.toJSON());
    expect(text).toContain('1111');
    expect(text).toContain('9876 RPM');
    expect(operator.refreshDiagnostics).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });

  it('expires a protected-session value when its own observation timestamp is old', async () => {
    const diagnostics: MotorTestDiagnosticsSnapshot = {
      outputs: {
        state: 'FRESH',
        value: {values: [1999, 1999, 1999, 1999]},
        observedAtMillis: Date.now() - 10_000,
      },
      escTelemetry: {
        state: 'UNSUPPORTED',
        value: undefined,
        observedAtMillis: Date.now(),
      },
    };
    const operator = {
      refreshDiagnostics: jest.fn(async () => diagnostics),
    } as unknown as MotorTestOperatorPort;
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(
        <MotorDiagnosticsPanel
          sessionId="fc-old-leased-value"
          operator={operator}
          activeMotorTest
          motorTestDiagnostics={diagnostics}
        />,
      );
    });
    const text = JSON.stringify(tree.toJSON());
    expect(text).toContain('قراءة قديمة');
    expect(text).toContain('غير مدعوم من البرنامج الثابت');
    expect(text).not.toContain('1999');
    act(() => tree.unmount());
  });

  it('never presents cached stale numbers or unsupported ESC zeros as live', async () => {
    mockOutputValue = {
      status: 'STALE',
      value: {values: [2000, 2000, 2000, 2000]},
      updatedAtMs: 1,
      ageMs: 10_000,
    };
    mockEscValue = {
      status: 'STALE',
      value: {
        motorCount: 1,
        motors: [
          {
            rpm: 54_321,
            invalidPercentRaw: 0,
            temperatureCelsius: 0,
            voltageCentivolts: 0,
            currentCentiamps: 0,
            consumptionMah: 0,
          },
        ],
      },
      updatedAtMs: 1,
      ageMs: 10_000,
    };
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(
        <MotorDiagnosticsPanel sessionId="fc-stale" />,
      );
    });
    const text = JSON.stringify(tree.toJSON());
    expect(text).toContain('قراءة قديمة');
    expect(text).not.toContain('54321 RPM');
    expect(text).not.toContain('2000');
    expect(text.match(/—/g)?.length).toBeGreaterThanOrEqual(4);
    act(() => tree.unmount());
  });

  it('suppresses a fresh all-zero reply when FC settings prove telemetry is disabled', async () => {
    mockEscValue = {
      status: 'FRESH',
      value: {
        motorCount: 1,
        motors: [
          {
            rpm: 0,
            invalidPercentRaw: 0,
            temperatureCelsius: 0,
            voltageCentivolts: 0,
            currentCentiamps: 0,
            consumptionMah: 0,
          },
        ],
      },
      updatedAtMs: 1,
    };
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(
        <MotorDiagnosticsPanel
          sessionId="fc-disabled-telemetry"
          support={{
            motorCount: 4,
            dshotTelemetryEnabled: false,
            escSensorEnabled: false,
            escTelemetrySource: 'NONE',
          }}
        />,
      );
    });
    const text = JSON.stringify(tree.toJSON());
    expect(text).toContain('لا يوجد مصدر تليمترية مفعّل');
    expect(text).toContain('أثبت متحكم الطيران');
    expect(tree.root.findAllByProps({testID: 'esc-telemetry-1'})).toHaveLength(
      0,
    );
    expect(text).not.toContain('0 RPM');
    expect(acquireMotorDiagnosticsTelemetry).toHaveBeenCalledWith(
      'fc-disabled-telemetry',
      false,
    );
    act(() => tree.unmount());
  });

  it('requests the background ESC poll only after a real source is proven', async () => {
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(
        <MotorDiagnosticsPanel
          sessionId="fc-source-enabled"
          support={{
            motorCount: 4,
            dshotTelemetryEnabled: true,
            escSensorEnabled: false,
            escTelemetrySource: 'BIDIRECTIONAL_DSHOT',
          }}
        />,
      );
    });
    expect(acquireMotorDiagnosticsTelemetry).toHaveBeenCalledWith(
      'fc-source-enabled',
      true,
    );
    act(() => tree.unmount());
  });
});
