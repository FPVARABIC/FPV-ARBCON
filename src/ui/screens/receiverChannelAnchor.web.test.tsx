/** @jest-environment jsdom */
/**
 * WHICH PHYSICAL EDGE DOES A CHANNEL BAR GROW FROM, IN THE BROWSER?
 *
 * The bar is a LEVEL readout: it starts at the reading-start edge and
 * grows away from it. Under Arabic that edge is the RIGHT; in the LTR
 * diagnostic layout it is the LEFT. The bar is drawn with a physical
 * `scaleX` + `translateX` pair, and a transform is NOT mirrored by
 * layout direction, so the anchor has to be chosen deliberately.
 *
 * It used to be chosen from `I18nManager.isRTL`. On react-native-web
 * that is a no-op stub which answers false whatever the document says,
 * so under an Arabic RTL page the web build anchored the bar to the
 * physical LEFT while the identical source anchored it RIGHT on
 * Android - one screen with two opposite start edges. Measured in
 * Chromium at 390/768/1366: the left gap stayed within 1px across a
 * 800-2200us sweep while the right gap moved by up to 614px.
 *
 * THE ORACLE HERE IS GEOMETRY, deliberately. Asserting that a helper
 * returned "rtl" would have passed against the broken build too, since
 * the helper was never the thing being consulted. So this reads the
 * transform react-native-web actually wrote onto the DOM node, turns it
 * back into the fill's two edges, and asserts that the ANCHORED EDGE
 * DOES NOT MOVE while the fraction changes. An anchor is by definition
 * the edge that stays put; at f = 0.5 both gaps are equal, so a
 * single-sample "which gap is smaller" test would be a coin flip.
 */
jest.mock('react-native', () => jest.requireActual('react-native-web'));

/**
 * Direction is INJECTED. Under the React Native Jest preset the module
 * resolver takes `layoutDirection.ts`, not the `.web.ts` sibling, and
 * `forceRTL()` does not move `isRTL` - so a test that "switches"
 * direction that way passes vacuously. This is the same seam the LED,
 * motor-diagram and scroll-offset suites use.
 */
let mockRtl = true;
jest.mock('../icons/layoutDirection', () => ({isRtlLayout: () => mockRtl}));

let mockChannels: number[] = [1612, 1478, 1500, 1185, 2000, 1000, 1500, 1000, 1712, 1000, 1000, 1500, 988, 1000, 1200, 1800];
let mockChannelStatus: 'FRESH' | 'STALE' = 'FRESH';

jest.mock('../../platforms/react-native/protocol/receiverPresentation', () => {
  const actual = jest.requireActual('../../platforms/react-native/protocol/receiverPresentation');
  return {
    ...actual,
    acquireReceiverTelemetry: () => () => undefined,
    getReceiverObservedRateHz: () => 25,
    useTelemetryValue: (_sessionId: string, pollId: string) => {
      if (pollId === 'receiver-channels-live') {
        return mockChannelStatus === 'STALE'
          ? {status: 'STALE', value: {channels: mockChannels}, updatedAtMs: 1, ageMs: 4200, sampleSeq: 1}
          : {status: 'FRESH', value: {channels: mockChannels}, updatedAtMs: 1, sampleSeq: 1};
      }
      if (pollId === 'receiver') return {status: 'FRESH', value: {rssi: 812}, updatedAtMs: 1, sampleSeq: 1};
      if (pollId === 'fcStatus') return {status: 'FRESH', value: {readiness: {armingDisableFlags: 0}}, updatedAtMs: 1, sampleSeq: 1};
      return {status: 'UNAVAILABLE'};
    },
  };
});

import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import '../../i18n';
import {decodeRxConfig, RECEIVER_CHANNEL_MAX_COUNT, type ReceiverConfigurationSnapshot} from '../../core';
import type {ReceiverRuntimeTruth} from '../../platforms/react-native/protocol/receiverPresentation';
import ReceiverScreen, {channelDisplayFraction, type ReceiverControllerPort} from './ReceiverScreen';

/** A width no real layout would produce by accident, so a zero-width
 *  fallback cannot be mistaken for a passing measurement. */
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

const RUNTIME: ReceiverRuntimeTruth = {
  mode: 'SERIAL',
  featureMaskRaw: 2 ** 3,
  providerMeaningful: true,
  portDependency: {kind: 'SERIAL_RX_READY', portIdentifier: 1},
  serialTargetDependency: {kind: 'SATISFIED'},
  buildOptionsKnown: true,
  selectableModes: ['PPM', 'SERIAL'],
  selectableProviders: [2, 9, 14],
  rssiSource: {kind: 'KNOWN', token: 'RX_PROTOCOL_CRSF', value: 6},
};

let host: HTMLElement;
let root: Root;

function controller(): ReceiverControllerPort {
  const original = snapshot();
  return {
    load: async () => ({kind: 'LOADED', snapshot: original}),
    save: async () => ({kind: 'SAVED_VERIFIED', snapshot: original}),
    readRuntime: async () => ({kind: 'READ', runtime: RUNTIME}),
  } as unknown as ReceiverControllerPort;
}

/**
 * Mount, then hand the track a REAL width through react-native-web's own
 * layout dispatch. RNW parks the component's `onLayout` on the DOM node
 * as `__reactLayoutHandler` and calls it from its shared ResizeObserver;
 * jsdom has no ResizeObserver and no layout engine, so the handler is
 * invoked directly with the box a browser would have measured. It is the
 * product's own callback, reached the way the web renderer reaches it -
 * not a prop poked into a React element tree.
 */
async function mountWithTrack(channels: number[]): Promise<void> {
  mockChannels = channels;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <ReceiverScreen sessionKey={{sessionId: 'receiver-anchor', generation: 1}} active onOpenPorts={jest.fn()} onOpenMotors={jest.fn()} controller={controller()} />,
    );
  });
  const fills = [...host.querySelectorAll('[data-testid$="-fill"]')];
  if (fills.length === 0) throw new Error('no channel fill in the DOM');
  const handlers = fills.map(fill => {
    const track = fill.parentElement;
    const handler = (track as unknown as {__reactLayoutHandler?: (event: unknown) => void} | null)?.__reactLayoutHandler;
    if (typeof handler !== 'function') {
      throw new Error('react-native-web attached no layout handler - the track would never learn its width');
    }
    return handler;
  });
  await act(async () => {
    for (const handler of handlers) {
      handler({nativeEvent: {layout: {x: 0, y: 0, width: TRACK_WIDTH, height: 8, left: 0, top: 0}}, timeStamp: 1});
    }
  });
}

/** The two numbers the browser will actually composite. */
function transformOf(testID: string): {scaleX: number; translateX: number} {
  const node = host.querySelector(`[data-testid="${testID}"]`) as HTMLElement | null;
  if (node === null) throw new Error(`${testID} is not in the DOM`);
  const css = node.style.transform;
  const scale = /scaleX\(([-\d.e]+)\)/.exec(css);
  const translate = /translateX\(([-\d.e]+)px\)/.exec(css);
  if (scale === null) throw new Error(`no scaleX in "${css}"`);
  return {scaleX: Number(scale[1]), translateX: translate === null ? 0 : Number(translate[1])};
}

/**
 * The fill's physical edges, in track coordinates.
 *
 * The fill is a full-width layer, so before the transform it spans
 * [0, W] about a centre at W/2. `scaleX(f)` scales about that centre and
 * `translateX(t)` shifts the result, giving edges at
 * W/2 -/+ f*W/2 + t. This is the geometry the compositor produces; it is
 * not a restatement of the component's formula, which is why an inverted
 * or hard-coded sign shows up here as a moving anchor.
 */
function fillEdges(testID: string): {left: number; right: number; width: number} {
  const {scaleX, translateX} = transformOf(testID);
  const half = (scaleX * TRACK_WIDTH) / 2;
  return {
    left: TRACK_WIDTH / 2 - half + translateX,
    right: TRACK_WIDTH / 2 + half + translateX,
    width: scaleX * TRACK_WIDTH,
  };
}

function withChannel1(value: number): number[] {
  return [value, 1478, 1500, 1185, 2000, 1000, 1500, 1000, 1712, 1000, 1000, 1500, 988, 1000, 1200, 1800];
}

/** Off-centre and unequal, so no sample sits at f = 0.5. */
const SWEEP = [1000, 1612, 2000];

beforeEach(() => { mockRtl = true; mockChannelStatus = 'FRESH'; });
afterEach(() => {
  if (root !== undefined) act(() => root.unmount());
  host?.remove();
});

describe('Receiver channel bar anchor in the browser', () => {
  it('RTL: the fill grows from the physical RIGHT, and that edge never moves', async () => {
    mockRtl = true;
    const rights: number[] = [];
    const lefts: number[] = [];
    for (const sample of SWEEP) {
      await mountWithTrack(withChannel1(sample));
      const edges = fillEdges('receiver-channel-1-fill');
      rights.push(Math.round(edges.right * 1000) / 1000);
      lefts.push(Math.round(edges.left * 1000) / 1000);
      // The magnitude is the product's own, unchanged by direction.
      expect(edges.width).toBeCloseTo(channelDisplayFraction(sample) * TRACK_WIDTH, 3);
      act(() => root.unmount());
      host.remove();
    }
    // The anchored edge is the track's right end, for every sample.
    expect(rights).toEqual([TRACK_WIDTH, TRACK_WIDTH, TRACK_WIDTH]);
    // And the free edge really did travel, so the test above is not
    // passing because nothing moved at all.
    expect(new Set(lefts).size).toBe(SWEEP.length);
  });

  it('LTR: the fill grows from the physical LEFT, and that edge never moves', async () => {
    mockRtl = false;
    const lefts: number[] = [];
    const rights: number[] = [];
    for (const sample of SWEEP) {
      await mountWithTrack(withChannel1(sample));
      const edges = fillEdges('receiver-channel-1-fill');
      lefts.push(Math.round(edges.left * 1000) / 1000);
      rights.push(Math.round(edges.right * 1000) / 1000);
      expect(edges.width).toBeCloseTo(channelDisplayFraction(sample) * TRACK_WIDTH, 3);
      act(() => root.unmount());
      host.remove();
    }
    expect(lefts).toEqual([0, 0, 0]);
    expect(new Set(rights).size).toBe(SWEEP.length);
  });

  it('the two directions cover the SAME fraction of the track', async () => {
    const widths: Record<string, number> = {};
    for (const rtl of [true, false]) {
      mockRtl = rtl;
      await mountWithTrack(withChannel1(1612));
      widths[String(rtl)] = fillEdges('receiver-channel-1-fill').width;
      act(() => root.unmount());
      host.remove();
    }
    expect(widths.true).toBeCloseTo(widths.false, 6);
    expect(widths.true).toBeCloseTo(channelDisplayFraction(1612) * TRACK_WIDTH, 6);
  });

  /**
   * One channel, a normal RC link, and the decoder's hard ceiling. A
   * direction chosen per index - or a row that silently stops rendering
   * past some count - shows up here and nowhere else.
   */
  it.each([
    ['a single channel', 1],
    ['a normal RC link', 16],
    ['the decoder ceiling', RECEIVER_CHANNEL_MAX_COUNT],
  ])('%s: every bar anchors right under RTL', async (_label, count) => {
    mockRtl = true;
    const channels = Array.from({length: count}, (_unused, index) => 1000 + index * 50);
    await mountWithTrack(channels);
    const fills = [...host.querySelectorAll('[data-testid$="-fill"]')];
    expect(fills.length).toBe(count);
    for (let channel = 1; channel <= count; channel += 1) {
      const edges = fillEdges(`receiver-channel-${channel}-fill`);
      expect({channel, right: Math.round(edges.right * 1000) / 1000})
        .toEqual({channel, right: TRACK_WIDTH});
      expect(edges.width).toBeCloseTo(channelDisplayFraction(channels[channel - 1]) * TRACK_WIDTH, 3);
    }
  });

  /**
   * THE ROW ITSELF IS NOT THE BAR.
   *
   * Which edge the FILL starts from is a direction decision. Which order
   * the label, track and value sit in is not one this component makes at
   * all: the row is a plain `row`, and the page's own direction reverses
   * it, which is how the value ends up on the physical left in Arabic
   * and on the right in the LTR layout. Reversing it a second time in
   * the component would cancel that out.
   *
   * Pinned because the anchor fix could plausibly have been "fixed" here
   * instead, and a mutation that flips the row to `row-reverse` under
   * RTL passed every other Receiver suite.
   */
  it('lays the row out in one fixed order, whatever the direction', async () => {
    for (const rtl of [true, false]) {
      mockRtl = rtl;
      await mountWithTrack(withChannel1(1612));
      const row = host.querySelector('[data-testid="receiver-channel-1"]') as HTMLElement;
      // Source order never changes: name, track, value.
      const children = [...row.children] as HTMLElement[];
      expect(children.length).toBe(3);
      expect(children[0].textContent).toContain('الدوران');
      expect(children[1].querySelector('[data-testid="receiver-channel-1-fill"]')).not.toBeNull();
      expect(children[2].textContent).toBe('1612');
      // The row must not reverse ITSELF - the document does that, and
      // doing it twice cancels out. That is asserted on the native
      // renderer, where the resolved style is a plain object: jsdom
      // computes nothing from react-native-web's generated classes, so
      // `getComputedStyle(row).flexDirection` here reports "row" even
      // when the component asked for "row-reverse". Measured, not
      // assumed - a mutation that flipped the row survived that check.
      act(() => root.unmount());
      host.remove();
    }
  });

  it('a stale link keeps the anchor and the exact printed value', async () => {
    mockRtl = true;
    mockChannelStatus = 'STALE';
    await mountWithTrack(withChannel1(1900));
    expect(fillEdges('receiver-channel-1-fill').right).toBeCloseTo(TRACK_WIDTH, 6);
    expect(host.querySelector('[data-testid="receiver-channel-1"]')?.textContent).toContain('1900');
  });

  it('the stick dot is NOT mirrored - it stays where the transmitter puts it', async () => {
    const dots: Record<string, string> = {};
    for (const rtl of [true, false]) {
      mockRtl = rtl;
      await mountWithTrack(withChannel1(1612));
      const dot = host.querySelector('[data-testid="receiver-stick-right-position"]') as HTMLElement;
      dots[String(rtl)] = dot.style.transform;
      act(() => root.unmount());
      host.remove();
    }
    // A physical control diagram: right stick right is right on the
    // transmitter whatever language the labels are in.
    expect(dots.true).toBe(dots.false);
    expect(dots.true).toContain('translateX(63.8');
  });
});
