/**
 * Pass 7.6c - ReceiverCard unit coverage: shared lifecycle states,
 * RSSI-only content (Latin "RSSI", percentage of the verified 0..1023
 * range), the zero-is-not-distinguishable policy, stale treatment,
 * accessibility, and the no-timer guarantee.
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';

import ReceiverCard from './ReceiverCard';
import i18n from '../../../i18n';
import type {MspAnalog, TelemetryValue} from '../../../core';
import type {AuxTelemetryChannelState} from '../../../platforms/react-native/protocol';

const GOLDEN: MspAnalog = {
  legacyVoltageDecivolts: 168,
  consumedMah: 350,
  rssi: 540, // round(540/1023*100) = 53
  amperageCentiamps: 1234,
  voltageCentivolts: 1685,
};

function render(
  telemetry: TelemetryValue<MspAnalog>,
  options: {connected?: boolean; channelState?: AuxTelemetryChannelState} = {},
): ReactTestRenderer.ReactTestRenderer {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    renderer = ReactTestRenderer.create(
      <ReceiverCard
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

describe('ReceiverCard', () => {
  it('disconnected takes precedence over everything and renders the approved copy', () => {
    const renderer = render({status: 'FRESH', value: GOLDEN, updatedAtMs: 0}, {connected: false});
    expect(allText(renderer)).toContain('غير متصل');
    expect(renderer.root.findAllByProps({testID: 'receiver-card-disconnected'}).length).toBeGreaterThan(0);
    expect(allText(renderer).join(' ')).not.toContain('RSSI');
    unmount(renderer);
  });

  it('an UNSUPPORTED channel verdict renders the approved unsupported copy', () => {
    const renderer = render({status: 'UNAVAILABLE'}, {channelState: 'UNSUPPORTED'});
    expect(allText(renderer)).toContain('غير مدعوم');
    expect(renderer.root.findAllByProps({testID: 'receiver-card-unsupported'}).length).toBeGreaterThan(0);
    unmount(renderer);
  });

  it.each(['DECODE_FAILED', 'DISABLED'] as const)('a %s channel verdict renders the approved error copy', state => {
    const renderer = render({status: 'UNAVAILABLE'}, {channelState: state});
    expect(allText(renderer)).toContain('تعذرت قراءة البيانات');
    expect(renderer.root.findAllByProps({testID: 'receiver-card-error'}).length).toBeGreaterThan(0);
    unmount(renderer);
  });

  it('UNAVAILABLE / WAITING / ERROR values map to the shared approved copy', () => {
    const cases: Array<[TelemetryValue<MspAnalog>, string, string]> = [
      [{status: 'UNAVAILABLE'}, 'البيانات غير متاحة', 'receiver-card-unavailable'],
      [{status: 'WAITING'}, 'بانتظار أول قراءة', 'receiver-card-waiting'],
      [{status: 'ERROR', error: new Error('boom')}, 'تعذرت قراءة البيانات', 'receiver-card-error'],
    ];
    for (const [value, copy, testID] of cases) {
      const renderer = render(value);
      expect(allText(renderer)).toContain(copy);
      expect(renderer.root.findAllByProps({testID}).length).toBeGreaterThan(0);
      unmount(renderer);
    }
  });

  it('FRESH nonzero RSSI renders "RSSI: {percent}%" against the verified 1023 maximum - Latin RSSI, never dBm, never "LQ"', () => {
    const renderer = render({status: 'FRESH', value: GOLDEN, updatedAtMs: 0});
    const text = allText(renderer);
    expect(text).toContain(i18n.t('telemetryCards.receiver.title'));
    expect(text).toContain('RSSI: 53%');
    expect(text.join(' ')).not.toContain('dBm');
    expect(text.join(' ')).not.toContain('LQ');
    expect(renderer.root.findAllByProps({testID: 'receiver-card-live'}).length).toBeGreaterThan(0);
    unmount(renderer);
  });

  it('covers the exact wire extremes: 1023 -> 100%, 1 -> 0% (a live source, honestly rounded)', () => {
    const max = render({status: 'FRESH', value: {...GOLDEN, rssi: 1023}, updatedAtMs: 0});
    expect(allText(max)).toContain('RSSI: 100%');
    unmount(max);
    const min = render({status: 'FRESH', value: {...GOLDEN, rssi: 1}, updatedAtMs: 0});
    expect(allText(min)).toContain('RSSI: 0%');
    unmount(min);
  });

  it('a wire zero renders the approved unavailable copy - NEVER a misleading "0%" (unconfigured source is indistinguishable)', () => {
    const renderer = render({status: 'FRESH', value: {...GOLDEN, rssi: 0}, updatedAtMs: 0});
    const text = allText(renderer);
    expect(text).toContain('البيانات غير متاحة');
    expect(text.join(' ')).not.toContain('0%');
    expect(renderer.root.findAllByProps({testID: 'receiver-card-rssi-unavailable'}).length).toBeGreaterThan(0);
    unmount(renderer);
  });

  it('never renders the duplicate battery fields MSP_ANALOG carries - they belong to the battery channel', () => {
    const renderer = render({status: 'FRESH', value: GOLDEN, updatedAtMs: 0});
    const joined = allText(renderer).join(' ');
    expect(joined).not.toContain('16.8');
    expect(joined).not.toContain('350');
    unmount(renderer);
  });

  it('STALE freezes the value dimmed with the approved stale label', () => {
    const renderer = render({status: 'STALE', value: GOLDEN, updatedAtMs: 0, ageMs: 12500});
    const text = allText(renderer);
    expect(text).toContain('RSSI: 53%');
    expect(text).toContain('القراءة غير محدثة');
    expect(renderer.root.findAllByProps({testID: 'receiver-card-stale'}).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({testID: 'receiver-card-live'})).toHaveLength(0);
    unmount(renderer);
  });

  it('renders the RSSI value LTR with tabular numerals and carries a complete Arabic accessibility label', () => {
    const renderer = render({status: 'FRESH', value: GOLDEN, updatedAtMs: 0});
    const rssi = renderer.root.findAllByProps({testID: 'receiver-card-rssi'})[0];
    const flat = Object.assign({}, ...[rssi.props.style].flat().filter(Boolean));
    expect(flat.writingDirection).toBe('ltr');
    expect(flat.fontVariant).toEqual(['tabular-nums']);
    const card = renderer.root.findAllByProps({testID: 'receiver-card-live'})[0];
    expect(card.props.accessible).toBe(true);
    expect(card.props.accessibilityLabel).toBe('جهاز الاستقبال، RSSI: 53%');
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
