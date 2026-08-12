/**
 * RECEIVER P3 CLOSURE - the channel bars must EASE toward each new
 * sample, and the easing must never become a second source of truth.
 *
 * A 25Hz stream on a 60Hz display is a stair-step: the bar teleports
 * roughly every other frame. The fix is a short presentation ease. The
 * risk it introduces is exactly the opposite of the defect it fixes -
 * an animation that keeps gliding after the link dies looks like live
 * data, and a queue of animations behind a fast stream would make the
 * bar arrive late and keep moving after the stick stopped.
 *
 * So this suite pins the contract, not the pixels: what the screen asks
 * the animation driver to do, that a newer sample always supersedes an
 * older one, that nothing survives unmount, that a link which is no
 * longer fresh snaps instead of gliding, and that the eased value lands
 * on the exact delivered sample. The rendered proof at 60fps in a real
 * browser is captured separately under .dev-preview/audit/ (P3 closure);
 * this is what keeps it from regressing unnoticed.
 */

import React from 'react';
import {Animated} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';
import '../../i18n';
import {decodeRxConfig, type ReceiverConfigurationSnapshot} from '../../core';

const CHANNELS = [1612, 1478, 1500, 1185, 2000, 1000, 1500, 1000, 1712, 1000, 1000, 1500, 988, 1000, 1200, 1800];

/**
 * A real external store, so publishing a sample re-renders the live
 * workspace through the same path a scheduler notification does. A
 * plain mutable value would not: the workspace is memoised, so nothing
 * short of a store notification reaches it.
 */
jest.mock('../../platforms/react-native/protocol', () => {
  const actual = jest.requireActual('../../platforms/react-native/protocol');
  const {useSyncExternalStore} = require('react');
  const listeners = new Set<() => void>();
  const store = {
    state: {status: 'FRESH', value: {channels: CHANNELS_SEED}, updatedAtMs: 1, sampleSeq: 1} as Record<string, unknown>,
    publish(next: Record<string, unknown>) { store.state = next; for (const listener of [...listeners]) listener(); },
    reset() { store.state = {status: 'FRESH', value: {channels: CHANNELS_SEED}, updatedAtMs: 1, sampleSeq: 1}; },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return {
    ...actual,
    __store: store,
    acquireReceiverTelemetry: () => () => undefined,
    getReceiverObservedRateHz: () => 25,
    useTelemetryValue: (_sessionId: string, pollId: string) => {
      const live = useSyncExternalStore(store.subscribe, () => store.state, () => store.state);
      if (pollId === RECEIVER_CHANNELS_POLL_ID_MOCK) return live;
      if (pollId === RECEIVER_TELEMETRY_POLL_ID_MOCK) return {status: 'FRESH', value: {rssi: 812}, updatedAtMs: 1, sampleSeq: 1};
      if (pollId === FC_STATUS_POLL_ID_MOCK) return {status: 'FRESH', value: {readiness: {armingDisableFlags: 0}}, updatedAtMs: 1, sampleSeq: 1};
      return {status: 'UNAVAILABLE'};
    },
  };
});
// jest hoists the factory above every import, so anything it closes over
// must be `mock`-prefixed AND initialised by the hoisted var declarations
// below - not by the consts above, which have not run yet.
var CHANNELS_SEED = [1612, 1478, 1500, 1185, 2000, 1000, 1500, 1000, 1712, 1000, 1000, 1500, 988, 1000, 1200, 1800];
var RECEIVER_CHANNELS_POLL_ID_MOCK = 'receiver-channels-live';
var RECEIVER_TELEMETRY_POLL_ID_MOCK = 'receiver';
var FC_STATUS_POLL_ID_MOCK = 'fcStatus';

// Imported after jest.mock() on purpose: the screen must resolve the
// stubbed telemetry hook, not the real one.
import ReceiverScreen, {CHANNEL_SMOOTHING_MS, channelDisplayFraction, type ReceiverControllerPort} from './ReceiverScreen';

const store = (jest.requireMock('../../platforms/react-native/protocol') as {__store: {
  publish(next: Record<string, unknown>): void;
  reset(): void;
}}).__store;

interface TimingCall {readonly toValue: number; readonly duration: number; readonly useNativeDriver: boolean; readonly hasEasing: boolean}
let timingCalls: TimingCall[] = [];
let started = 0;
let stopped = 0;
let maxInFlight = 0;
const realTiming = Animated.timing;

beforeEach(() => {
  jest.useFakeTimers();
  // Every test mounts from the same seed. Without this the previous
  // test's last sample becomes the next test's mount value, and a
  // publish of the "new" value would be a publish of the same value -
  // an assertion that silently proves nothing.
  store.reset();
  timingCalls = []; started = 0; stopped = 0; maxInFlight = 0;
  jest.spyOn(Animated, 'timing').mockImplementation(((value: Animated.Value, config: Record<string, unknown>) => {
    timingCalls.push({
      toValue: config.toValue as number,
      duration: config.duration as number,
      useNativeDriver: config.useNativeDriver as boolean,
      hasEasing: config.easing !== undefined,
    });
    // The REAL animation underneath, so the assertions about the value
    // landing on target exercise React Native's own driver.
    const animation = realTiming(value, config as never);
    return {
      start: (callback?: (result: {finished: boolean}) => void) => {
        started += 1;
        maxInFlight = Math.max(maxInFlight, started - stopped);
        animation.start(callback);
      },
      stop: () => { stopped += 1; animation.stop(); },
      reset: () => animation.reset(),
    };
  }) as never);
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

function snapshot(): ReceiverConfigurationSnapshot {
  const bytes = new Uint8Array(39);
  const view = new DataView(bytes.buffer);
  bytes[0] = 9;
  view.setUint16(1, 1900, true); view.setUint16(3, 1500, true); view.setUint16(5, 1100, true);
  view.setUint16(8, 885, true); view.setUint16(10, 2115, true);
  bytes[27] = 30; bytes[30] = 30; bytes[31] = 1;
  return {
    rx: decodeRxConfig(bytes),
    channelMap: [0, 1, 3, 2, 4, 5, 6, 7],
    rssiChannel: 0,
    deadband: {deadband: 2, yawDeadband: 3, altitudeHoldDeadband: 4, throttle3dDeadband: 5},
  };
}

async function mount() {
  const original = snapshot();
  const controller: ReceiverControllerPort = {
    load: jest.fn(async () => ({kind: 'LOADED' as const, snapshot: original})),
    save: jest.fn(async () => ({kind: 'SAVED_VERIFIED' as const, snapshot: original})),
  };
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <ReceiverScreen sessionKey={{sessionId: 'receiver-smoothing', generation: 1}} active onOpenPorts={jest.fn()} onOpenMotors={jest.fn()} controller={controller} />,
    );
  });
  return renderer;
}

function fresh(channels: readonly number[], seq: number) {
  return {status: 'FRESH', value: {channels}, updatedAtMs: seq, sampleSeq: seq};
}
function stale(channels: readonly number[], seq: number) {
  return {status: 'STALE', value: {channels}, updatedAtMs: seq, ageMs: 4200, sampleSeq: seq};
}

/** The animated width of one channel's fill, resolved to its string. */
function fillWidth(renderer: ReactTestRenderer.ReactTestRenderer, channel: number): string {
  const node = renderer.root.findByProps({testID: `receiver-channel-${channel}-fill`});
  const styles = ([] as unknown[]).concat(node.props.style as unknown[]).flat(4);
  for (const style of styles) {
    const width = (style as {width?: unknown} | null)?.width;
    if (width !== undefined && width !== null && typeof width === 'object' && '__getValue' in width) {
      return String((width as {__getValue(): unknown}).__getValue());
    }
    if (typeof width === 'string') return width;
  }
  throw new Error(`no width found on receiver-channel-${channel}-fill`);
}

/** The printed integer in a channel row - the unsmoothed truth. */
function printedValue(renderer: ReactTestRenderer.ReactTestRenderer, channel: number): number {
  const texts = renderer.root
    .findByProps({testID: `receiver-channel-${channel}`})
    .findAllByType('Text' as never)
    .map(node => String(node.props.children));
  return Number(texts[texts.length - 1]);
}

function percentOf(microseconds: number): string {
  return `${channelDisplayFraction(microseconds) * 100}%`;
}

describe('Receiver P3 closure - bar smoothing is a presentation effect', () => {
  it('eases at approximately 50ms, on the JS driver, with an easing curve', async () => {
    const renderer = await mount();
    timingCalls = [];
    await act(async () => { store.publish(fresh([...CHANNELS.slice(0, 15), 1900], 2)); });

    expect(timingCalls.length).toBeGreaterThan(0);
    // The stated window in the closure brief: 40-60ms, ~50 preferred.
    expect(CHANNEL_SMOOTHING_MS).toBeGreaterThanOrEqual(40);
    expect(CHANNEL_SMOOTHING_MS).toBeLessThanOrEqual(60);
    for (const call of timingCalls) {
      expect(call.duration).toBe(CHANNEL_SMOOTHING_MS);
      // width is a layout property; the native driver cannot animate it,
      // and asking it to would silently do nothing on a device.
      expect(call.useNativeDriver).toBe(false);
      expect(call.hasEasing).toBe(true);
    }
    act(() => renderer.unmount());
  });

  it('targets the LATEST sample and lands on it exactly', async () => {
    const renderer = await mount();
    await act(async () => { store.publish(fresh([...CHANNELS.slice(0, 15), 1900], 2)); });
    const target = channelDisplayFraction(1900);
    expect(timingCalls.some(call => call.toValue === target)).toBe(true);

    // Let the ease finish; the eased position must equal the delivered
    // sample, not merely approach it.
    await act(async () => { jest.advanceTimersByTime(CHANNEL_SMOOTHING_MS * 4); });
    expect(fillWidth(renderer, 16)).toBe(percentOf(1900));
    act(() => renderer.unmount());
  });

  it('never smooths the printed integer - the number is always the raw sample', async () => {
    const renderer = await mount();
    await act(async () => { store.publish(fresh([...CHANNELS.slice(0, 15), 1900], 2)); });
    // Read BEFORE advancing any timer: the bar has not moved yet, and
    // the number must already be the new one.
    expect(printedValue(renderer, 16)).toBe(1900);
    expect(fillWidth(renderer, 16)).not.toBe(percentOf(1900));
    act(() => renderer.unmount());
  });

  it('supersedes rather than queues: a burst of samples leaves one animation per channel', async () => {
    const renderer = await mount();
    started = 0; stopped = 0; maxInFlight = 0;
    // 12 samples with no time in between at all - the pathological case
    // a queue would turn into 12 chained glides per bar.
    for (let seq = 2; seq <= 13; seq += 1) {
      await act(async () => { store.publish(fresh([...CHANNELS.slice(0, 15), 1000 + seq * 50], seq)); });
    }
    expect(started).toBeGreaterThan(0);
    // At no point may more animations be in flight than there are
    // channels: every new sample stops the previous one first.
    expect(maxInFlight).toBeLessThanOrEqual(CHANNELS.length);

    // And the bar converges on the LAST sample, not on an earlier one it
    // was still working through.
    await act(async () => { jest.advanceTimersByTime(CHANNEL_SMOOTHING_MS * 4); });
    expect(fillWidth(renderer, 16)).toBe(percentOf(1000 + 13 * 50));
    act(() => renderer.unmount());
  });

  it('stops every animation on unmount', async () => {
    const renderer = await mount();
    await act(async () => { store.publish(fresh([...CHANNELS.slice(0, 15), 1900], 2)); });
    const startedBefore = started;
    const stoppedBefore = stopped;
    expect(startedBefore).toBeGreaterThan(stoppedBefore);
    act(() => renderer.unmount());
    expect(stopped).toBe(startedBefore);
  });

  it('snaps instead of gliding once the link is no longer fresh', async () => {
    const renderer = await mount();
    await act(async () => { store.publish(fresh([...CHANNELS.slice(0, 15), 1900], 2)); });
    await act(async () => { jest.advanceTimersByTime(CHANNEL_SMOOTHING_MS * 4); });

    timingCalls = [];
    await act(async () => { store.publish(stale([...CHANNELS.slice(0, 15), 1100], 3)); });
    // No animation at all, and the bar is already on the true value with
    // no time advanced: a dead link must not appear to be moving.
    expect(timingCalls).toHaveLength(0);
    expect(fillWidth(renderer, 16)).toBe(percentOf(1100));
    act(() => renderer.unmount());
  });

  it('does not glide in from zero on the first sample', async () => {
    // The very first sample after an empty screen is not motion, it is
    // the arrival of data; sweeping up from 0 would be an animation of
    // something that never happened.
    const renderer = await mount();
    expect(timingCalls).toHaveLength(0);
    expect(fillWidth(renderer, 1)).toBe(percentOf(CHANNELS[0]));
    act(() => renderer.unmount());
  });

  it('draws one channel at ONE position: the bar and the stick pad share a node', async () => {
    const renderer = await mount();
    await act(async () => { store.publish(fresh([1900, ...CHANNELS.slice(1)], 2)); });
    // Mid-glide, deliberately: this is where two independent animations
    // would disagree.
    await act(async () => { jest.advanceTimersByTime(Math.round(CHANNEL_SMOOTHING_MS / 3)); });
    const dot = renderer.root.findByProps({testID: 'receiver-stick-right-position'});
    const styles = ([] as unknown[]).concat(dot.props.style as unknown[]).flat(4);
    const left = styles
      .map(style => (style as {left?: unknown} | null)?.left)
      .find(value => value !== undefined && value !== null && typeof value === 'object' && '__getValue' in value);
    expect(left).toBeDefined();
    expect(String((left as {__getValue(): unknown}).__getValue())).toBe(fillWidth(renderer, 1));
    act(() => renderer.unmount());
  });
});
