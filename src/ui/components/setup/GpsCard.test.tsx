/**
 * Pass 7.6c - GpsCard unit coverage: shared lifecycle states, the
 * fix/no-fix/no-presence-proof trichotomy, satellite count, the absolute
 * no-coordinates rule, stale treatment, and the no-timer guarantee.
 */

import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';

import GpsCard from './GpsCard';
import '../../../i18n';
import type { MspRawGpsCompact, TelemetryValue } from '../../../core';
import type { AuxTelemetryChannelState } from '../../../platforms/react-native/protocol';

const FIX: MspRawGpsCompact = { hasFix: true, satelliteCount: 11 };
const NO_FIX: MspRawGpsCompact = { hasFix: false, satelliteCount: 3 };

function render(
  telemetry: TelemetryValue<MspRawGpsCompact>,
  options: {
    connected?: boolean;
    channelState?: AuxTelemetryChannelState;
    gpsPresent?: boolean | undefined;
  } = {},
): ReactTestRenderer.ReactTestRenderer {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    renderer = ReactTestRenderer.create(
      <GpsCard
        connected={options.connected ?? true}
        channelState={options.channelState ?? 'ACTIVE'}
        telemetry={telemetry}
        gpsPresent={'gpsPresent' in options ? options.gpsPresent : true}
      />,
    );
  });
  return renderer;
}

function allText(renderer: ReactTestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .map(node =>
      Array.isArray(node.props.children)
        ? node.props.children.join('')
        : String(node.props.children),
    );
}

function unmount(renderer: ReactTestRenderer.ReactTestRenderer): void {
  act(() => {
    renderer.unmount();
  });
}

describe('GpsCard', () => {
  it('disconnected renders the approved copy before anything else', () => {
    const renderer = render(
      { status: 'FRESH', value: FIX, updatedAtMs: 0 },
      { connected: false },
    );
    expect(allText(renderer)).toContain('غير متصل');
    expect(
      renderer.root.findAllByProps({ testID: 'gps-card-disconnected' }).length,
    ).toBeGreaterThan(0);
    unmount(renderer);
  });

  it('an UNSUPPORTED channel verdict renders the approved "غير مدعوم" copy (the FC rejected MSP_RAW_GPS)', () => {
    const renderer = render(
      { status: 'UNAVAILABLE' },
      { channelState: 'UNSUPPORTED' },
    );
    expect(allText(renderer)).toContain('غير مدعوم');
    expect(
      renderer.root.findAllByProps({ testID: 'gps-card-unsupported' }).length,
    ).toBeGreaterThan(0);
    unmount(renderer);
  });

  it('UNAVAILABLE / WAITING / ERROR values map to the shared approved copy', () => {
    const cases: Array<[TelemetryValue<MspRawGpsCompact>, string, string]> = [
      [{ status: 'UNAVAILABLE' }, 'البيانات غير متاحة', 'gps-card-unavailable'],
      [{ status: 'WAITING' }, 'بانتظار أول قراءة', 'gps-card-waiting'],
      [
        { status: 'ERROR', error: new Error('boom') },
        'تعذرت قراءة البيانات',
        'gps-card-error',
      ],
    ];
    for (const [value, copy, testID] of cases) {
      const renderer = render(value);
      expect(allText(renderer)).toContain(copy);
      expect(renderer.root.findAllByProps({ testID }).length).toBeGreaterThan(
        0,
      );
      unmount(renderer);
    }
  });

  it('a fix renders the approved located copy with the satellite count', () => {
    const renderer = render({ status: 'FRESH', value: FIX, updatedAtMs: 0 });
    const text = allText(renderer);
    expect(text).toContain('GPS');
    expect(text).toContain('تم تحديد الموقع');
    expect(text).toContain('عدد الأقمار: 11');
    expect(
      renderer.root.findAllByProps({ testID: 'gps-card-fix' }).length,
    ).toBeGreaterThan(0);
    unmount(renderer);
  });

  it('shows non-location GPS flight details when the payload carries them', () => {
    const renderer = render({
      status: 'FRESH',
      value: {
        hasFix: true,
        satelliteCount: 11,
        altitudeMeters: 300,
        groundSpeedCentimetersPerSecond: 125,
        groundCourseDecidegrees: 905,
      },
      updatedAtMs: 0,
    });
    const joined = allText(renderer).join(' ');
    expect(joined).toContain('الارتفاع المُبلّغ: 300 m');
    expect(joined).toContain('السرعة الأرضية: 1.3 m/s');
    expect(joined).toContain('مسار الحركة: 90.5°');
    expect(joined).not.toMatch(/123456789|987654321/);
    unmount(renderer);
  });

  it('does not render an out-of-range ground course as a real heading', () => {
    const renderer = render({
      status: 'FRESH',
      value: {
        hasFix: true,
        satelliteCount: 11,
        altitudeMeters: 300,
        groundSpeedCentimetersPerSecond: 125,
        groundCourseDecidegrees: 10_000,
      },
      updatedAtMs: 0,
    });
    const joined = allText(renderer).join(' ');
    expect(joined).toContain('السرعة الأرضية: 1.3 m/s');
    expect(joined).not.toContain('مسار الحركة');
    expect(joined).not.toContain('1000.0°');
    unmount(renderer);
  });

  it('a fix is its own presence proof - located copy renders even when the STATUS_EX bit is unavailable', () => {
    const renderer = render(
      { status: 'FRESH', value: FIX, updatedAtMs: 0 },
      { gpsPresent: undefined },
    );
    expect(allText(renderer)).toContain('تم تحديد الموقع');
    unmount(renderer);
  });

  it('no fix with PROVEN presence renders the approved "not yet located" copy (not an error) with the count', () => {
    const renderer = render(
      { status: 'FRESH', value: NO_FIX, updatedAtMs: 0 },
      { gpsPresent: true },
    );
    const text = allText(renderer);
    expect(text).toContain('لم يُحدَّد الموقع بعد');
    expect(text).toContain('عدد الأقمار: 3');
    expect(text.join(' ')).not.toContain('تعذرت');
    unmount(renderer);
  });

  it('no fix WITHOUT presence proof (false or unprovable) renders the honest unavailable copy - zero satellites never proves absence', () => {
    for (const gpsPresent of [false, undefined]) {
      const renderer = render(
        {
          status: 'FRESH',
          value: { hasFix: false, satelliteCount: 0 },
          updatedAtMs: 0,
        },
        { gpsPresent },
      );
      expect(allText(renderer)).toContain('البيانات غير متاحة');
      expect(
        renderer.root.findAllByProps({ testID: 'gps-card-no-presence' }).length,
      ).toBeGreaterThan(0);
      unmount(renderer);
    }
  });

  it('never renders coordinates in any state - the decoded model cannot even carry them (structural privacy)', () => {
    const renderer = render({ status: 'FRESH', value: FIX, updatedAtMs: 0 });
    const joined = allText(renderer).join(' ');
    expect(joined).not.toMatch(/\d+\.\d{4,}/); // no lat/lon-looking number can appear
    unmount(renderer);
  });

  it('STALE freezes the content dimmed with the approved stale label', () => {
    const renderer = render({
      status: 'STALE',
      value: FIX,
      updatedAtMs: 0,
      ageMs: 15500,
    });
    const text = allText(renderer);
    expect(text).toContain('تم تحديد الموقع');
    expect(text).toContain('القراءة غير محدثة');
    expect(
      renderer.root.findAllByProps({ testID: 'gps-card-stale' }).length,
    ).toBeGreaterThan(0);
    unmount(renderer);
  });

  it('carries a complete Arabic accessibility label including fix state and satellite count', () => {
    const renderer = render({ status: 'FRESH', value: FIX, updatedAtMs: 0 });
    const card = renderer.root.findAllByProps({ testID: 'gps-card-live' })[0];
    expect(card.props.accessible).toBe(true);
    expect(card.props.accessibilityLabel).toBe(
      'GPS، تم تحديد الموقع، عدد الأقمار: 11',
    );
    unmount(renderer);
  });

  it('creates NO timer of any kind', () => {
    jest.useFakeTimers();
    try {
      const renderer = render({ status: 'FRESH', value: FIX, updatedAtMs: 0 });
      expect(jest.getTimerCount()).toBe(0);
      unmount(renderer);
    } finally {
      jest.useRealTimers();
    }
  });
});
