/**
 * THE SAME CHANNEL BAR ON THE NATIVE RENDERER.
 *
 * Its browser twin (receiverChannelAnchor.web.test.tsx) pins the DOM
 * transform react-native-web emits. This pins the other host: the values
 * the screen hands React Native's animation driver, read back through
 * the driver itself, so both platforms are held to ONE logical start
 * edge - right under Arabic, left under an LTR diagnostic layout.
 *
 * Both files assert the fill's EFFECTIVE EDGES rather than the sign of a
 * constant. A test that checked `anchorSign === 1` would keep passing if
 * the interpolation were rewritten to place the bar somewhere else
 * entirely, and would have to be rewritten itself for any refactor that
 * did not change what the pilot sees.
 *
 * This is a RENDER-LEVEL proof. It says nothing about an Android
 * device's compositor.
 */
import React from 'react';
import {Animated} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';
import '../../i18n';
import {decodeRxConfig, type ReceiverConfigurationSnapshot} from '../../core';

/** Direction is INJECTED: under the React Native Jest preset
 *  `forceRTL()` does not move `isRTL`, so toggling it that way would
 *  make an assertion pass without proving anything. */
let mockRtl = true;
jest.mock('../icons/layoutDirection', () => ({isRtlLayout: () => mockRtl}));

jest.mock('../../platforms/react-native/protocol/receiverPresentation', () => {
  const actual = jest.requireActual('../../platforms/react-native/protocol/receiverPresentation');
  const {useSyncExternalStore} = require('react');
  const listeners = new Set<() => void>();
  const store = {
    state: {status: 'FRESH', value: {channels: MOCK_SEED}, updatedAtMs: 1, sampleSeq: 1} as Record<string, unknown>,
    publish(next: Record<string, unknown>) { store.state = next; for (const listener of [...listeners]) listener(); },
    reset() { store.state = {status: 'FRESH', value: {channels: MOCK_SEED}, updatedAtMs: 1, sampleSeq: 1}; },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return {
    ...actual,
    __store: store,
    acquireReceiverTelemetry: () => () => undefined,
    getReceiverObservedRateHz: () => 25,
    useTelemetryValue: (_sessionId: string, pollId: string) => {
      const live = useSyncExternalStore(store.subscribe, () => store.state, () => store.state);
      if (pollId === 'receiver-channels-live') return live;
      if (pollId === 'receiver') return {status: 'FRESH', value: {rssi: 812}, updatedAtMs: 1, sampleSeq: 1};
      if (pollId === 'fcStatus') return {status: 'FRESH', value: {readiness: {armingDisableFlags: 0}}, updatedAtMs: 1, sampleSeq: 1};
      return {status: 'UNAVAILABLE'};
    },
  };
});
var MOCK_SEED = [1612, 1478, 1500, 1185, 2000, 1000, 1500, 1000, 1712, 1000, 1000, 1500, 988, 1000, 1200, 1800];

import ReceiverScreen, {CHANNEL_SMOOTHING_MS, channelDisplayFraction, type ReceiverControllerPort} from './ReceiverScreen';

const store = (jest.requireMock('../../platforms/react-native/protocol/receiverPresentation') as {__store: {
  publish(next: Record<string, unknown>): void;
  reset(): void;
}}).__store;

/** A width no default could produce, so a zero-width track cannot pass. */
const TRACK_WIDTH = 200;

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

function withChannel1(value: number): number[] {
  return [value, 1478, 1500, 1185, 2000, 1000, 1500, 1000, 1712, 1000, 1000, 1500, 988, 1000, 1200, 1800];
}

/** Resolves an Animated node (or a plain number) to its current value. */
function resolve(candidate: unknown): number | undefined {
  if (typeof candidate === 'number') return candidate;
  if (candidate !== null && typeof candidate === 'object' && '__getValue' in candidate) {
    return Number((candidate as {__getValue(): unknown}).__getValue());
  }
  return undefined;
}

function transformValue(renderer: ReactTestRenderer.ReactTestRenderer, testID: string, key: string): number {
  const node = renderer.root.findByProps({testID});
  const styles = ([] as unknown[]).concat(node.props.style as unknown[]).flat(4);
  for (const style of styles) {
    const transform = (style as {transform?: unknown[]} | null)?.transform;
    if (!Array.isArray(transform)) continue;
    for (const entry of transform) {
      const raw = (entry as Record<string, unknown>)[key];
      if (raw === undefined) continue;
      const value = resolve(raw);
      if (value !== undefined) return value;
    }
  }
  throw new Error(`${testID} has no ${key} the driver can resolve`);
}

/**
 * The fill's physical edges in track coordinates, derived from what the
 * driver will composite: a full-width layer scaled about its own centre
 * and then translated.
 */
function fillEdges(renderer: ReactTestRenderer.ReactTestRenderer, channel: number): {left: number; right: number; width: number} {
  const scaleX = transformValue(renderer, `receiver-channel-${channel}-fill`, 'scaleX');
  const translateX = transformValue(renderer, `receiver-channel-${channel}-fill`, 'translateX');
  const half = (scaleX * TRACK_WIDTH) / 2;
  return {left: TRACK_WIDTH / 2 - half + translateX, right: TRACK_WIDTH / 2 + half + translateX, width: scaleX * TRACK_WIDTH};
}

let lastController: {load: jest.Mock; save: jest.Mock; requestReboot: jest.Mock};

async function mountWithTrack(channels: number[]) {
  store.publish({status: 'FRESH', value: {channels}, updatedAtMs: 1, sampleSeq: 1});
  const original = snapshot();
  const controller = {
    load: jest.fn(async () => ({kind: 'LOADED' as const, snapshot: original})),
    save: jest.fn(async () => ({kind: 'SAVED_VERIFIED' as const, snapshot: original})),
    requestReboot: jest.fn(async () => ({kind: 'REBOOT_REQUESTED' as const})),
  };
  lastController = controller;
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <ReceiverScreen sessionKey={{sessionId: 'receiver-anchor-native', generation: 1}} active onOpenPorts={jest.fn()} onOpenMotors={jest.fn()} controller={controller as unknown as ReceiverControllerPort} />,
    );
  });
  // Deliver a real width through the component's own onLayout, the way
  // the layout system does. Every track gets it, not just channel 1.
  const fills = renderer.root.findAll(node => typeof node.props?.testID === 'string' && /^receiver-channel-\d+-fill$/.test(node.props.testID as string));
  const tracks = new Set<ReactTestRenderer.ReactTestInstance>();
  for (const fill of fills) {
    let track = fill.parent;
    while (track !== null && typeof track.props?.onLayout !== 'function') track = track.parent;
    if (track === null) throw new Error('no onLayout track above a channel fill');
    tracks.add(track);
  }
  await act(async () => {
    for (const track of tracks) {
      (track.props.onLayout as (event: unknown) => void)({nativeEvent: {layout: {x: 0, y: 0, width: TRACK_WIDTH, height: 8}}});
    }
  });
  return renderer;
}

const SWEEP = [1000, 1612, 2000];

beforeEach(() => { mockRtl = true; store.reset(); });

describe('Receiver channel bar anchor on the native renderer', () => {
  it('RTL: the right edge is the anchor and never moves', async () => {
    mockRtl = true;
    const rights: number[] = [];
    const lefts: number[] = [];
    for (const sample of SWEEP) {
      const renderer = await mountWithTrack(withChannel1(sample));
      const edges = fillEdges(renderer, 1);
      rights.push(Math.round(edges.right * 1e6) / 1e6);
      lefts.push(Math.round(edges.left * 1e6) / 1e6);
      expect(edges.width).toBeCloseTo(channelDisplayFraction(sample) * TRACK_WIDTH, 6);
      act(() => renderer.unmount());
    }
    expect(rights).toEqual([TRACK_WIDTH, TRACK_WIDTH, TRACK_WIDTH]);
    expect(new Set(lefts).size).toBe(SWEEP.length);
  });

  it('LTR: the left edge is the anchor and never moves', async () => {
    mockRtl = false;
    const lefts: number[] = [];
    const rights: number[] = [];
    for (const sample of SWEEP) {
      const renderer = await mountWithTrack(withChannel1(sample));
      const edges = fillEdges(renderer, 1);
      lefts.push(Math.round(edges.left * 1e6) / 1e6);
      rights.push(Math.round(edges.right * 1e6) / 1e6);
      expect(edges.width).toBeCloseTo(channelDisplayFraction(sample) * TRACK_WIDTH, 6);
      act(() => renderer.unmount());
    }
    expect(lefts).toEqual([0, 0, 0]);
    expect(new Set(rights).size).toBe(SWEEP.length);
  });

  it('the same sample covers the same width in both directions', async () => {
    const widths: number[] = [];
    for (const rtl of [true, false]) {
      mockRtl = rtl;
      const renderer = await mountWithTrack(withChannel1(1900));
      widths.push(fillEdges(renderer, 1).width);
      act(() => renderer.unmount());
    }
    expect(widths[0]).toBeCloseTo(widths[1] as number, 9);
    expect(widths[0]).toBeCloseTo(channelDisplayFraction(1900) * TRACK_WIDTH, 9);
  });

  /**
   * The anchor must survive a SECOND sample - the first one snaps, every
   * one after it eases, and an anchor recomputed per frame would drift.
   *
   * The assertion is the driver's TARGET plus the anchor invariant, not a
   * mid-flight number. Under `useNativeDriver: true` the frames are
   * computed off the JS thread and `__getValue()` deliberately stops
   * tracking the animation, so a "settled value" read here would be
   * asserting the driver had NOT gone native - the opposite of the
   * contract. ReceiverScreenSmoothing owns the easing behaviour itself.
   */
  it('a second sample retargets the driver without moving the anchor', async () => {
    const targets: number[] = [];
    const realTiming = Animated.timing;
    const spy = jest.spyOn(Animated, 'timing').mockImplementation(((value: Animated.Value, config: Record<string, unknown>) => {
      targets.push(config.toValue as number);
      return realTiming(value, config as never);
    }) as never);
    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
    try {
      mockRtl = true;
      renderer = await mountWithTrack(withChannel1(1000));
      expect(fillEdges(renderer, 1).right).toBeCloseTo(TRACK_WIDTH, 6);

      await act(async () => {
        store.publish({status: 'FRESH', value: {channels: withChannel1(2000)}, updatedAtMs: 2, sampleSeq: 2});
      });
      // The bar was aimed at the new sample, exactly.
      expect(targets[0]).toBeCloseTo(channelDisplayFraction(2000), 9);
      // And the fill's two transforms still describe a right-anchored
      // bar: same anchored edge, whatever the driver is currently on.
      expect(fillEdges(renderer, 1).right).toBeCloseTo(TRACK_WIDTH, 6);
      // The printed integer is the raw new sample, never the eased one.
      expect(renderer.root.findByProps({testID: 'receiver-channel-1'}).props.accessibilityLabel).toContain('2000');
    } finally {
      if (renderer !== undefined) act(() => renderer!.unmount());
      spy.mockRestore();
    }
  });

  /** A link that is no longer fresh keeps its anchor and its true value. */
  it('a stale link keeps the anchor', async () => {
    mockRtl = true;
    store.publish({status: 'STALE', value: {channels: withChannel1(1900)}, updatedAtMs: 1, ageMs: 4200, sampleSeq: 1});
    const original = snapshot();
    const controller: ReceiverControllerPort = {
      load: jest.fn(async () => ({kind: 'LOADED' as const, snapshot: original})),
      save: jest.fn(async () => ({kind: 'SAVED_VERIFIED' as const, snapshot: original})),
    };
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <ReceiverScreen sessionKey={{sessionId: 'receiver-anchor-stale', generation: 1}} active onOpenPorts={jest.fn()} onOpenMotors={jest.fn()} controller={controller} />,
      );
    });
    const fill = renderer.root.findByProps({testID: 'receiver-channel-1-fill'});
    let track = fill.parent;
    while (track !== null && typeof track.props?.onLayout !== 'function') track = track.parent;
    await act(async () => {
      (track!.props.onLayout as (event: unknown) => void)({nativeEvent: {layout: {x: 0, y: 0, width: TRACK_WIDTH, height: 8}}});
    });
    const edges = fillEdges(renderer, 1);
    expect(edges.right).toBeCloseTo(TRACK_WIDTH, 6);
    expect(edges.width).toBeCloseTo(channelDisplayFraction(1900) * TRACK_WIDTH, 6);
    act(() => renderer.unmount());
  });

  /**
   * The bar and the pad read the SAME channel through the SAME animated
   * value, and only one of them is allowed to follow the text direction.
   */
  it('the stick dot is not mirrored when the bar is', async () => {
    const dots: {x: number; y: number}[] = [];
    for (const rtl of [true, false]) {
      mockRtl = rtl;
      const renderer = await mountWithTrack(withChannel1(1612));
      dots.push({
        x: transformValue(renderer, 'receiver-stick-right-position', 'translateX'),
        y: transformValue(renderer, 'receiver-stick-right-position', 'translateY'),
      });
      act(() => renderer.unmount());
    }
    expect(dots[0]).toEqual(dots[1]);
  });

  /**
   * The anchor fix must not have introduced a second animation, a longer
   * ease, or a driver the native side cannot run. Those are the ways a
   * "small" rendering change turns into the lag defect P2 removed.
   */
  it('still asks for one native-driven 50ms ease per sample', async () => {
    const calls: {toValue: number; duration: number; useNativeDriver: boolean}[] = [];
    const realTiming = Animated.timing;
    const spy = jest.spyOn(Animated, 'timing').mockImplementation(((value: Animated.Value, config: Record<string, unknown>) => {
      calls.push({
        toValue: config.toValue as number,
        duration: config.duration as number,
        useNativeDriver: config.useNativeDriver as boolean,
      });
      return realTiming(value, config as never);
    }) as never);
    try {
      mockRtl = true;
      const renderer = await mountWithTrack(withChannel1(1000));
      // The first sample snaps; nothing is animated yet.
      expect(calls).toEqual([]);
      await act(async () => {
        store.publish({status: 'FRESH', value: {channels: withChannel1(2000)}, updatedAtMs: 2, sampleSeq: 2});
      });
      expect(calls.length).toBe(16);
      for (const call of calls) {
        expect({duration: call.duration, useNativeDriver: call.useNativeDriver})
          .toEqual({duration: CHANNEL_SMOOTHING_MS, useNativeDriver: true});
      }
      expect(calls[0]?.toValue).toBeCloseTo(channelDisplayFraction(2000), 9);
      act(() => renderer.unmount());
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * THIS CHANGE IS RENDERING ONLY.
   *
   * Choosing which edge a bar grows from must not reach the flight
   * controller. Opening the screen in either direction reads the
   * configuration once and writes nothing: no save, no reboot, and no
   * second load provoked by the direction lookup.
   */
  it('opening the screen writes nothing to the flight controller', async () => {
    for (const rtl of [true, false]) {
      mockRtl = rtl;
      const renderer = await mountWithTrack(withChannel1(1612));
      expect({
        direction: rtl ? 'rtl' : 'ltr',
        loads: lastController.load.mock.calls.length,
        saves: lastController.save.mock.calls.length,
        reboots: lastController.requestReboot.mock.calls.length,
      }).toEqual({direction: rtl ? 'rtl' : 'ltr', loads: 1, saves: 0, reboots: 0});
      act(() => renderer.unmount());
    }
  });

  /**
   * THE ROW ITSELF IS NOT THE BAR.
   *
   * Which edge the FILL starts from is a direction decision this
   * component makes. The order of the label, the track and the value is
   * not: the row is a plain `row`, and the page's own direction reverses
   * it - which is how the value lands on the physical left in Arabic and
   * on the right in the LTR layout. Reversing it here as well would
   * cancel that out and put the Arabic label back on the left.
   *
   * Asserted on this renderer because the resolved style is a plain
   * object here. In jsdom, react-native-web ships its styles as
   * generated classes that jsdom does not compute, so the same check in
   * the browser suite reported "row" even when the component asked for
   * "row-reverse" - measured, and the reason that check lives here.
   */
  it('keeps the row a plain row in both directions', async () => {
    for (const rtl of [true, false]) {
      mockRtl = rtl;
      const renderer = await mountWithTrack(withChannel1(1612));
      const row = renderer.root.findByProps({testID: 'receiver-channel-1'});
      const merged: Record<string, unknown> = {};
      for (const entry of ([] as unknown[]).concat(row.props.style as unknown[]).flat(4)) {
        if (entry !== null && typeof entry === 'object') Object.assign(merged, entry);
      }
      expect({direction: rtl ? 'rtl' : 'ltr', flexDirection: merged.flexDirection})
        .toEqual({direction: rtl ? 'rtl' : 'ltr', flexDirection: 'row'});
      // Source order is fixed too: name, track, value.
      expect(row.props.children.length).toBe(3);
      act(() => renderer.unmount());
    }
  });

  /**
   * The printed integer is the decoded MSP_RC sample itself. Direction
   * changes where the bar starts; it may never touch the number.
   */
  it('prints the raw sample, identically in both directions', async () => {
    const labels: string[] = [];
    for (const rtl of [true, false]) {
      mockRtl = rtl;
      const renderer = await mountWithTrack(withChannel1(1743));
      labels.push(String(renderer.root.findByProps({testID: 'receiver-channel-1'}).props.accessibilityLabel));
      act(() => renderer.unmount());
    }
    expect(labels[0]).toContain('1743');
    expect(labels[0]).toBe(labels[1]);
  });
});
