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
jest.mock('../../platforms/react-native/protocol/receiverPresentation', () => {
  const actual = jest.requireActual('../../platforms/react-native/protocol/receiverPresentation');
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
import ReceiverScreen, {CHANNEL_SMOOTHING_MS, STICK_PAD_TRAVEL, channelDisplayFraction, type ReceiverControllerPort} from './ReceiverScreen';

const store = (jest.requireMock('../../platforms/react-native/protocol/receiverPresentation') as {__store: {
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

/** Resolves an Animated node (or a plain number) to its current value. */
function resolve(candidate: unknown): number | undefined {
  if (typeof candidate === 'number') return candidate;
  if (candidate !== null && typeof candidate === 'object' && '__getValue' in candidate) {
    return Number((candidate as {__getValue(): unknown}).__getValue());
  }
  return undefined;
}

/**
 * The channel fill's displayed FRACTION, read from its scaleX transform.
 *
 * The bar used to animate `width: 'x%'`. It now renders at full width and
 * is scaled on X, because `width` is a layout property that the native
 * animated driver cannot drive - see ChannelRow's own note. The number
 * this returns is the same 0..1 display fraction either way.
 */
function fillFraction(renderer: ReactTestRenderer.ReactTestRenderer, channel: number): number {
  const node = renderer.root.findByProps({testID: `receiver-channel-${channel}-fill`});
  const styles = ([] as unknown[]).concat(node.props.style as unknown[]).flat(4);
  for (const style of styles) {
    const transform = (style as {transform?: unknown} | null)?.transform;
    if (!Array.isArray(transform)) continue;
    for (const entry of transform) {
      const scaleX = resolve((entry as {scaleX?: unknown} | null)?.scaleX);
      if (scaleX !== undefined) return scaleX;
    }
  }
  throw new Error(`no scaleX found on receiver-channel-${channel}-fill`);
}

/** Every style property the fill's animated node drives. */
function fillDrivenProps(renderer: ReactTestRenderer.ReactTestRenderer, channel: number): string[] {
  const node = renderer.root.findByProps({testID: `receiver-channel-${channel}-fill`});
  const styles = ([] as unknown[]).concat(node.props.style as unknown[]).flat(4);
  const driven: string[] = [];
  for (const style of styles) {
    for (const [key, raw] of Object.entries((style ?? {}) as Record<string, unknown>)) {
      if (key === 'transform' && Array.isArray(raw)) {
        for (const entry of raw) {
          for (const [tKey, tRaw] of Object.entries((entry ?? {}) as Record<string, unknown>)) {
            if (tRaw !== null && typeof tRaw === 'object' && '__getValue' in tRaw) driven.push(tKey);
          }
        }
        continue;
      }
      if (raw !== null && typeof raw === 'object' && '__getValue' in raw) driven.push(key);
    }
  }
  return driven;
}

/** The printed integer in a channel row - the unsmoothed truth. */
function printedValue(renderer: ReactTestRenderer.ReactTestRenderer, channel: number): number {
  const texts = renderer.root
    .findByProps({testID: `receiver-channel-${channel}`})
    .findAllByType('Text' as never)
    .map(node => String(node.props.children));
  return Number(texts[texts.length - 1]);
}

function fractionOf(microseconds: number): number {
  return channelDisplayFraction(microseconds);
}

describe('Receiver P3 closure - bar smoothing is a presentation effect', () => {
  it('eases at approximately 50ms, on the NATIVE driver, with an easing curve', async () => {
    const renderer = await mount();
    timingCalls = [];
    await act(async () => { store.publish(fresh([...CHANNELS.slice(0, 15), 1900], 2)); });

    expect(timingCalls.length).toBeGreaterThan(0);
    // The stated window in the closure brief: 40-60ms, ~50 preferred.
    expect(CHANNEL_SMOOTHING_MS).toBeGreaterThanOrEqual(40);
    expect(CHANNEL_SMOOTHING_MS).toBeLessThanOrEqual(60);
    for (const call of timingCalls) {
      expect(call.duration).toBe(CHANNEL_SMOOTHING_MS);
      // CONTRACT CHANGED, DELIBERATELY (Receiver live-latency P2).
      //
      // This used to assert `false`, because the bar animated `width` -
      // a layout property the native driver cannot touch. Real Android
      // operator feedback then reported heavy visible lag and stepping
      // that no test reproduced. Phase 1 measured the wire, scheduler,
      // decoder, precision and sample backlog and cleared all of them
      // (MSP_RC held a flat 40ms/25Hz, request->publish 0ms, and a 120ms
      // slow link produced constant latency rather than a growing
      // queue), which left JS-driven layout animation as the only
      // remaining candidate. The geometry is now scaleX/translateX/
      // translateY, so the driver can be native - and asserting it here
      // is what stops a future edit from silently reintroducing a layout
      // property and dropping back onto the JS path.
      expect(call.useNativeDriver).toBe(true);
      expect(call.hasEasing).toBe(true);
    }
    act(() => renderer.unmount());
  });

  it('targets the LATEST sample and lands on it exactly', async () => {
    const renderer = await mount();
    await act(async () => { store.publish(fresh([...CHANNELS.slice(0, 15), 1900], 2)); });
    const target = channelDisplayFraction(1900);
    expect(timingCalls.some(call => call.toValue === target)).toBe(true);

    // The TARGET is the assertion, not a mid-flight JS value. Under the
    // native driver the frames are computed off the JS thread, so
    // __getValue() deliberately stops tracking the animation - that is
    // the whole point of the change. What must remain provable is that
    // the newest sample is the value the driver was aimed at, exactly.
    const targetsForChannel16 = timingCalls.map(call => call.toValue);
    expect(targetsForChannel16[targetsForChannel16.length - 1]).toBe(target);
    expect(target).toBe(fractionOf(1900));
    act(() => renderer.unmount());
  });

  it('never smooths the printed integer - the number is always the raw sample', async () => {
    const renderer = await mount();
    await act(async () => { store.publish(fresh([...CHANNELS.slice(0, 15), 1900], 2)); });
    // Read BEFORE advancing any timer: the bar has not moved yet, and
    // the number must already be the new one.
    expect(printedValue(renderer, 16)).toBe(1900);
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

    // And the driver is aimed at the LAST sample, not at an earlier one
    // it was still working through. (Under the native driver the JS-side
    // value no longer advances, so the target is what proves this.)
    const lastTarget = timingCalls[timingCalls.length - 1].toValue;
    expect(lastTarget).toBe(fractionOf(1000 + 13 * 50));
    act(() => renderer.unmount());
  });

  /**
   * THE STRUCTURAL GUARD for the live-latency change.
   *
   * Every style the live Animated.Value drives must be native-driver
   * capable. `width`, `left` and `top` are layout properties: the native
   * driver cannot animate them, so if any of them reappears here the
   * animation silently drops back onto the JavaScript execution path -
   * which is the condition Phase 1 identified as the remaining candidate
   * for the operator's reported Android lag. Asserting the exact driven
   * set is what makes that regression impossible to land unnoticed.
   */
  it('drives ONLY native-capable transform properties - no animated layout property remains', async () => {
    const renderer = await mount();
    await act(async () => { store.publish(fresh([...CHANNELS.slice(0, 15), 1900], 2)); });

    const driven = fillDrivenProps(renderer, 16);
    expect(driven).toContain('scaleX');
    expect(driven).toContain('translateX');
    for (const forbidden of ['width', 'left', 'top', 'right', 'bottom', 'height', 'margin', 'marginLeft', 'padding', 'flex']) {
      expect(driven).not.toContain(forbidden);
    }

    // The stick dot, same rule.
    const dot = renderer.root.findByProps({testID: 'receiver-stick-right-position'});
    const dotStyles = ([] as unknown[]).concat(dot.props.style as unknown[]).flat(4);
    const dotDriven: string[] = [];
    for (const style of dotStyles) {
      for (const [key, raw] of Object.entries((style ?? {}) as Record<string, unknown>)) {
        if (key === 'transform' && Array.isArray(raw)) {
          for (const entry of raw) {
            for (const [tKey, tRaw] of Object.entries((entry ?? {}) as Record<string, unknown>)) {
              if (tRaw !== null && typeof tRaw === 'object' && '__getValue' in tRaw) dotDriven.push(tKey);
            }
          }
          continue;
        }
        if (raw !== null && typeof raw === 'object' && '__getValue' in raw) dotDriven.push(key);
      }
    }
    expect(dotDriven.sort()).toEqual(['translateX', 'translateY']);
    act(() => renderer.unmount());
  });

  it('keeps the dot inside the pad at both extremes', async () => {
    const renderer = await mount();
    // Minimum and maximum of the display domain.
    for (const [value, expected] of [[800, 0], [2200, STICK_PAD_TRAVEL]] as const) {
      timingCalls = [];
      await act(async () => { store.publish(fresh([value, value, value, value, ...CHANNELS.slice(4)], value)); });
      // timingCalls[0] is CHANNEL 1 - the last entry is channel 16, which
      // this sample did not change.
      const target = timingCalls[0].toValue;
      expect(target * STICK_PAD_TRAVEL).toBeCloseTo(expected, 6);
      expect(target).toBeGreaterThanOrEqual(0);
      expect(target).toBeLessThanOrEqual(1);
    }
    act(() => renderer.unmount());
  });

  it('fast reversal retargets to the newest direction instead of finishing the old one', async () => {
    const renderer = await mount();
    const sequence = [1500, 2200, 800, 1500];
    const targets: number[] = [];
    for (const [i, value] of sequence.entries()) {
      timingCalls = [];
      await act(async () => { store.publish(fresh([value, ...CHANNELS.slice(1)], 100 + i)); });
      // Retarget WITHOUT letting the previous ease finish.
      await act(async () => { jest.advanceTimersByTime(Math.round(CHANNEL_SMOOTHING_MS / 4)); });
      targets.push(timingCalls[0].toValue);
    }
    // Each target is the newest sample, in order - never a replay.
    expect(targets.map(t => Math.round(t * 1000) / 1000)).toEqual(
      sequence.map(v => Math.round(channelDisplayFraction(v) * 1000) / 1000),
    );
    act(() => renderer.unmount());
  });

  it('preserves fine precision: a 1us change still moves the target', async () => {
    const renderer = await mount();
    timingCalls = [];
    await act(async () => { store.publish(fresh([1500, ...CHANNELS.slice(1)], 200)); });
    const a = timingCalls[0].toValue;
    timingCalls = [];
    await act(async () => { store.publish(fresh([1501, ...CHANNELS.slice(1)], 201)); });
    const b = timingCalls[0].toValue;
    expect(b).toBeGreaterThan(a);
    expect(b - a).toBeCloseTo(1 / 1400, 9);
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
    expect(fillFraction(renderer, 16)).toBeCloseTo(fractionOf(1100), 6);
    act(() => renderer.unmount());
  });

  it('does not glide in from zero on the first sample', async () => {
    // The very first sample after an empty screen is not motion, it is
    // the arrival of data; sweeping up from 0 would be an animation of
    // something that never happened.
    const renderer = await mount();
    expect(timingCalls).toHaveLength(0);
    expect(fillFraction(renderer, 1)).toBeCloseTo(fractionOf(CHANNELS[0]), 6);
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
    // The dot is now moved by translateX over the pad's fixed travel, so
    // the comparable quantity is the FRACTION that translation encodes.
    let translateX: number | undefined;
    for (const style of styles) {
      const transform = (style as {transform?: unknown} | null)?.transform;
      if (!Array.isArray(transform)) continue;
      for (const entry of transform) {
        const candidate = resolve((entry as {translateX?: unknown} | null)?.translateX);
        if (candidate !== undefined) translateX = candidate;
      }
    }
    expect(translateX).toBeDefined();
    expect((translateX as number) / STICK_PAD_TRAVEL).toBeCloseTo(fillFraction(renderer, 1), 6);
    act(() => renderer.unmount());
  });
});
