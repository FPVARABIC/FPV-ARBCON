/**
 * Pass 7.6c - FlightControllerCard unit coverage: shared lifecycle
 * states, the proven CPU-load/cycle-time content, the conditional
 * cumulative i2c error line, the no-invented-health rule, stale
 * treatment, and the no-timer guarantee.
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';

import FlightControllerCard from './FlightControllerCard';
import '../../../i18n';
import type {MspStatusExCompact, TelemetryValue} from '../../../core';
import type {AuxTelemetryChannelState} from '../../../platforms/react-native/protocol';

const GOLDEN: MspStatusExCompact = {
  cycleTimeUs: 900,
  i2cErrorCount: 0,
  sensorPresenceMask: 41,
  cpuLoadPercent: 42,
};

function render(
  telemetry: TelemetryValue<MspStatusExCompact>,
  options: {connected?: boolean; channelState?: AuxTelemetryChannelState} = {},
): ReactTestRenderer.ReactTestRenderer {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    renderer = ReactTestRenderer.create(
      <FlightControllerCard
        connected={options.connected ?? true}
        channelState={options.channelState ?? 'ACTIVE'}
        telemetry={telemetry}
      />,
    );
  });
  return renderer;
}

function allText(renderer: ReactTestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .map(node => (Array.isArray(node.props.children) ? node.props.children.join('') : String(node.props.children)));
}

function unmount(renderer: ReactTestRenderer.ReactTestRenderer): void {
  act(() => {
    renderer.unmount();
  });
}

describe('FlightControllerCard', () => {
  it('disconnected renders the approved copy before anything else', () => {
    const renderer = render({status: 'FRESH', value: GOLDEN, updatedAtMs: 0}, {connected: false});
    expect(allText(renderer)).toContain('غير متصل');
    expect(renderer.root.findAllByProps({testID: 'fc-card-disconnected'}).length).toBeGreaterThan(0);
    unmount(renderer);
  });

  it('channel verdicts map to the shared approved copy (UNSUPPORTED / DISABLED)', () => {
    const unsupported = render({status: 'UNAVAILABLE'}, {channelState: 'UNSUPPORTED'});
    expect(allText(unsupported)).toContain('غير مدعوم');
    unmount(unsupported);
    const disabled = render({status: 'UNAVAILABLE'}, {channelState: 'DISABLED'});
    expect(allText(disabled)).toContain('تعذرت قراءة البيانات');
    unmount(disabled);
  });

  it('UNAVAILABLE / WAITING map to the shared approved copy', () => {
    const unavailable = render({status: 'UNAVAILABLE'});
    expect(allText(unavailable)).toContain('البيانات غير متاحة');
    unmount(unavailable);
    const waiting = render({status: 'WAITING'});
    expect(allText(waiting)).toContain('بانتظار أول قراءة');
    unmount(waiting);
  });

  it('FRESH renders the approved CPU-load primary and cycle-time support lines with the exact decoded values', () => {
    const renderer = render({status: 'FRESH', value: GOLDEN, updatedAtMs: 0});
    const text = allText(renderer);
    expect(text).toContain('متحكم الطيران');
    expect(text).toContain('استخدام المعالج: 42%');
    expect(text).toContain('زمن الدورة: 900 µs');
    expect(renderer.root.findAllByProps({testID: 'fc-card-live'}).length).toBeGreaterThan(0);
    unmount(renderer);
  });

  it('hides the i2c line at zero and shows it with the approved since-startup label when nonzero (cumulative, not a live fault)', () => {
    const zero = render({status: 'FRESH', value: GOLDEN, updatedAtMs: 0});
    expect(zero.root.findAllByProps({testID: 'fc-card-i2c'})).toHaveLength(0);
    expect(allText(zero).join(' ')).not.toContain('I²C');
    unmount(zero);

    const some = render({status: 'FRESH', value: {...GOLDEN, i2cErrorCount: 7}, updatedAtMs: 0});
    expect(allText(some)).toContain('أخطاء I²C منذ التشغيل: 7');
    expect(some.root.findAllByProps({testID: 'fc-card-i2c'}).length).toBeGreaterThan(0);
    unmount(some);
  });

  it('never invents a health category - no "صحي" (healthy) or similar appears in any state', () => {
    const renderer = render({status: 'FRESH', value: GOLDEN, updatedAtMs: 0});
    const joined = allText(renderer).join(' ');
    expect(joined).not.toContain('صحي');
    expect(joined).not.toContain('سليم');
    unmount(renderer);
  });

  it('covers the firmware-constrained CPU bounds 0% and 100% verbatim', () => {
    const zero = render({status: 'FRESH', value: {...GOLDEN, cpuLoadPercent: 0}, updatedAtMs: 0});
    expect(allText(zero)).toContain('استخدام المعالج: 0%');
    unmount(zero);
    const hundred = render({status: 'FRESH', value: {...GOLDEN, cpuLoadPercent: 100}, updatedAtMs: 0});
    expect(allText(hundred)).toContain('استخدام المعالج: 100%');
    unmount(hundred);
  });

  it('STALE freezes the values dimmed with the approved stale label', () => {
    const renderer = render({status: 'STALE', value: GOLDEN, updatedAtMs: 0, ageMs: 24500});
    const text = allText(renderer);
    expect(text).toContain('استخدام المعالج: 42%');
    expect(text).toContain('القراءة غير محدثة');
    expect(renderer.root.findAllByProps({testID: 'fc-card-stale'}).length).toBeGreaterThan(0);
    unmount(renderer);
  });

  it('carries a complete Arabic accessibility label (title, CPU, cycle time - plus i2c when shown)', () => {
    const renderer = render({status: 'FRESH', value: {...GOLDEN, i2cErrorCount: 7}, updatedAtMs: 0});
    const card = renderer.root.findAllByProps({testID: 'fc-card-live'})[0];
    expect(card.props.accessible).toBe(true);
    expect(card.props.accessibilityLabel).toBe(
      'متحكم الطيران، استخدام المعالج: 42%، زمن الدورة: 900 µs، أخطاء I²C منذ التشغيل: 7',
    );
    unmount(renderer);
  });

  it('creates NO timer of any kind', () => {
    jest.useFakeTimers();
    try {
      const renderer = render({status: 'FRESH', value: GOLDEN, updatedAtMs: 0});
      expect(jest.getTimerCount()).toBe(0);
      unmount(renderer);
    } finally {
      jest.useRealTimers();
    }
  });
});
