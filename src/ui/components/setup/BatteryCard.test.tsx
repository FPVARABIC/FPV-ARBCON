/**
 * Pass 7.6b - BatteryCard unit coverage: every visible state, exact
 * value/unit formatting, the approved Arabic copy, truthfulness rules
 * (no fabricated zeros, stale never presented as live), accessibility,
 * and the no-timer guarantee.
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';

import BatteryCard from './BatteryCard';
import i18n from '../../../i18n';
import type {MspBatteryState, TelemetryValue, BatteryChargeEstimate} from '../../../core';

const GOLDEN: MspBatteryState = {
  cellCount: 4,
  configuredCapacityMah: 1500,
  legacyVoltageDecivolts: 168,
  consumedMah: 350,
  amperageCentiamps: -250,
  batteryStateRaw: 0, // BATTERY_OK
  voltageCentivolts: 1685,
};

function render(
  telemetry: TelemetryValue<MspBatteryState>,
  chargeEstimate?: BatteryChargeEstimate,
): ReactTestRenderer.ReactTestRenderer {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    renderer = ReactTestRenderer.create(<BatteryCard telemetry={telemetry} chargeEstimate={chargeEstimate} />);
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

describe('BatteryCard', () => {
  it('UNAVAILABLE renders the approved unavailable copy with the title - and NO numeric value of any kind', () => {
    const renderer = render({status: 'UNAVAILABLE'});
    const text = allText(renderer);
    expect(text).toContain(i18n.t('batteryCard.title'));
    expect(text).toContain('بيانات البطارية غير متاحة');
    expect(text.join(' ')).not.toMatch(/\d+\.\d+ V/);
    expect(renderer.root.findAllByProps({testID: 'battery-card-unavailable'}).length).toBeGreaterThan(0);
    unmount(renderer);
  });

  it('WAITING renders the approved waiting copy - missing data never masquerades as "0.00 V"', () => {
    const renderer = render({status: 'WAITING'});
    const text = allText(renderer);
    expect(text).toContain('بانتظار بيانات البطارية');
    expect(text.join(' ')).not.toContain('0.00 V');
    unmount(renderer);
  });

  it('ERROR renders the approved error copy', () => {
    const renderer = render({status: 'ERROR', error: new Error('boom')});
    expect(allText(renderer)).toContain('تعذّر قراءة بيانات البطارية');
    unmount(renderer);
  });

  it('FRESH detected battery renders the exact canonical voltage (16.85 V from 1685 centivolts), the approved labels, the firmware state, and the honest percentage-unavailable line', () => {
    const renderer = render({status: 'FRESH', value: GOLDEN, updatedAtMs: 1000});
    const text = allText(renderer);
    expect(text).toContain('البطارية');
    expect(text).toContain('الجهد');
    expect(text).toContain('16.85 V');
    expect(text).toContain('طبيعية'); // BATTERY_OK mapping
    expect(text).toContain('نسبة الشحن غير متاحة');
    expect(renderer.root.findAllByProps({testID: 'battery-card-live'}).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({testID: 'battery-card-stale-label'})).toHaveLength(0);
    unmount(renderer);
  });

  it('maps every verified firmware state to its approved Arabic text', () => {
    const expected: Array<[number, string]> = [
      [0, 'طبيعية'],
      [1, 'تحذير'],
      [2, 'حرجة'],
      [4, 'جارٍ التحقق من البطارية'],
    ];
    for (const [raw, arabic] of expected) {
      const renderer = render({status: 'FRESH', value: {...GOLDEN, batteryStateRaw: raw}, updatedAtMs: 0});
      expect(allText(renderer)).toContain(arabic);
      unmount(renderer);
    }
  });

  it('cellCount 0 renders the approved "battery not detected" text while STILL showing the real measured voltage (a genuine reading is never hidden)', () => {
    const renderer = render({
      status: 'FRESH',
      value: {...GOLDEN, cellCount: 0, batteryStateRaw: 3, voltageCentivolts: 11},
      updatedAtMs: 0,
    });
    const text = allText(renderer);
    expect(text).toContain('لم تُكتشف بطارية');
    expect(text).toContain('0.11 V'); // real decoded USB-power residual, not a fabricated zero
    unmount(renderer);
  });

  it('an UNKNOWN firmware enum renders the approved "state unknown" copy - never a false all-clear', () => {
    const renderer = render({status: 'FRESH', value: {...GOLDEN, batteryStateRaw: 9}, updatedAtMs: 0});
    const text = allText(renderer);
    expect(text).toContain('حالة البطارية غير معروفة');
    expect(text).not.toContain('طبيعية');
    unmount(renderer);
  });

  it('STALE freezes the last real values, dims them, and shows the approved stale label - never presented as live', () => {
    const renderer = render({status: 'STALE', value: GOLDEN, updatedAtMs: 1000, ageMs: 9500});
    const text = allText(renderer);
    expect(text).toContain('16.85 V');
    expect(text).toContain('بيانات البطارية غير محدثة');
    expect(renderer.root.findAllByProps({testID: 'battery-card-stale'}).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({testID: 'battery-card-live'})).toHaveLength(0);
    unmount(renderer);
  });

  it('never renders current or consumed-mAh fields - their sensor validity is UNPROVEN by MSP_BATTERY_STATE alone', () => {
    const renderer = render({status: 'FRESH', value: GOLDEN, updatedAtMs: 0});
    const joined = allText(renderer).join(' ');
    expect(joined).not.toContain('التيار');
    expect(joined).not.toContain('الاستهلاك');
    expect(joined).not.toContain('-2.5'); // the decoded amperage never leaks into the UI
    unmount(renderer);
  });

  it('carries a complete Arabic accessibility label (title, voltage, state - plus staleness when stale)', () => {
    const live = render({status: 'FRESH', value: GOLDEN, updatedAtMs: 0});
    const liveCard = live.root.findAllByProps({testID: 'battery-card-live'})[0];
    expect(liveCard.props.accessible).toBe(true);
    expect(liveCard.props.accessibilityLabel).toBe('البطارية، الجهد 16.85 V، طبيعية');
    unmount(live);

    const stale = render({status: 'STALE', value: GOLDEN, updatedAtMs: 0, ageMs: 9500});
    const staleCard = stale.root.findAllByProps({testID: 'battery-card-stale'})[0];
    expect(staleCard.props.accessibilityLabel).toBe('البطارية، الجهد 16.85 V، طبيعية، بيانات البطارية غير محدثة');
    unmount(stale);
  });

  it('renders the numeric voltage LTR with tabular numerals inside the RTL layout', () => {
    const renderer = render({status: 'FRESH', value: GOLDEN, updatedAtMs: 0});
    const voltage = renderer.root.findAllByProps({testID: 'battery-card-voltage'})[0];
    const flat = Object.assign({}, ...[voltage.props.style].flat().filter(Boolean));
    expect(flat.writingDirection).toBe('ltr');
    expect(flat.fontVariant).toEqual(['tabular-nums']);
    unmount(renderer);
  });

  it('Pass 7.6c: a fully-qualified ESTIMATE replaces the percentage-unavailable line and announces the since-startup limitation as the accessibility hint', () => {
    const renderer = render({status: 'FRESH', value: GOLDEN, updatedAtMs: 0}, {kind: 'ESTIMATE', percent: 77});
    const text = allText(renderer);
    expect(text).toContain('الشحن التقديري: 77%');
    expect(text).not.toContain('نسبة الشحن غير متاحة');
    expect(renderer.root.findAllByProps({testID: 'battery-card-charge-estimate'}).length).toBeGreaterThan(0);
    const card = renderer.root.findAllByProps({testID: 'battery-card-live'})[0];
    expect(card.props.accessibilityHint).toBe(i18n.t('batteryCard.chargeEstimateHint'));
    expect(card.props.accessibilityLabel).toContain('الشحن التقديري: 77%');
    unmount(renderer);
  });

  it('Pass 7.6c: an UNAVAILABLE estimate (any reason) keeps the exact Pass 7.6b honest fallback line, with no hint', () => {
    const renderer = render(
      {status: 'FRESH', value: GOLDEN, updatedAtMs: 0},
      {kind: 'UNAVAILABLE', reason: 'METER_SOURCE_NOT_QUALIFIED'},
    );
    const text = allText(renderer);
    expect(text).toContain('نسبة الشحن غير متاحة');
    expect(text.join(' ')).not.toContain('الشحن التقديري');
    const card = renderer.root.findAllByProps({testID: 'battery-card-live'})[0];
    expect(card.props.accessibilityHint).toBeUndefined();
    unmount(renderer);
  });

  it('creates NO timer of any kind - it re-renders only with its caller', () => {
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
