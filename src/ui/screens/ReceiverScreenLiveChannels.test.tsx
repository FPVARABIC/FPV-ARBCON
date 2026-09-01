/**
 * RECEIVER P1: every live channel the flight controller reports must be
 * REACHABLE on screen.
 *
 * The defect this suite pins was measured in a real browser at 768px with
 * 16 live channels: `previewCard`/`channelsCard` carried `flex: 4`/`flex:
 * 5` unconditionally, and `flex: N` is flex-grow with a flex-basis of 0.
 * In the COLUMN layout (every width below 900) that sized the two cards
 * as a 4:5 split of the container instead of by their content, so the
 * channels card's box ended 90px above its own last row - AUX 10 was cut
 * mid-row and AUX 11 and AUX 12 were painted over by the following card,
 * unreachable at any scroll position. Live data was silently hidden on
 * the screen whose entire purpose is showing it.
 *
 * These are structural assertions. The pixel-level proof is the rendered
 * browser evidence captured under .dev-preview/audit/ (P1-S); this suite
 * is what keeps the fix from regressing unnoticed.
 */

import React from 'react';
import {readFileSync} from 'fs';
import {join} from 'path';
import ReactTestRenderer, {act} from 'react-test-renderer';
import '../../i18n';
import {decodeRxConfig, type ReceiverConfigurationSnapshot} from '../../core';

const RECEIVER_CHANNELS_POLL_ID = 'receiver-channels-live';
const RECEIVER_TELEMETRY_POLL_ID = 'receiver';
const FC_STATUS_TELEMETRY_POLL_ID = 'fcStatus';

/** 16 channels, the count a CRSF link actually reports. */
const LIVE_CHANNELS = [1612, 1478, 1500, 1185, 2000, 1000, 1500, 1000, 1712, 1000, 1000, 1500, 988, 1000, 1200, 1800];

let mockWindowWidth = 390;

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({width: mockWindowWidth, height: 844, scale: 2, fontScale: 1}),
}));

jest.mock('../../platforms/react-native/protocol/receiverPresentation', () => {
  const actual = jest.requireActual('../../platforms/react-native/protocol/receiverPresentation');
  return {
    ...actual,
    acquireReceiverTelemetry: () => () => undefined,
    useTelemetryValue: (_sessionId: string, pollId: string) => {
      if (pollId === RECEIVER_CHANNELS_POLL_ID) {
        return {status: 'FRESH', value: {channels: LIVE_CHANNELS}, updatedAtMs: 1, sampleSeq: 1};
      }
      if (pollId === RECEIVER_TELEMETRY_POLL_ID) {
        return {status: 'FRESH', value: {rssi: 812}, updatedAtMs: 1, sampleSeq: 1};
      }
      if (pollId === FC_STATUS_TELEMETRY_POLL_ID) {
        return {status: 'FRESH', value: {readiness: {armingDisableFlags: 0}}, updatedAtMs: 1, sampleSeq: 1};
      }
      return {status: 'UNAVAILABLE'};
    },
  };
});

// Imported after the jest.mock() calls above on purpose: the screen must
// resolve the stubbed telemetry hook, not the real one.
import ReceiverScreen, {type ReceiverControllerPort} from './ReceiverScreen';

function snapshot(): ReceiverConfigurationSnapshot {
  const bytes = new Uint8Array(39);
  const view = new DataView(bytes.buffer);
  bytes[0] = 9;
  view.setUint16(1, 1900, true);
  view.setUint16(3, 1500, true);
  view.setUint16(5, 1100, true);
  view.setUint16(8, 885, true);
  view.setUint16(10, 2115, true);
  bytes[27] = 30;
  bytes[30] = 30;
  bytes[31] = 1;
  return {
    rx: decodeRxConfig(bytes),
    channelMap: [0, 1, 3, 2, 4, 5, 6, 7],
    rssiChannel: 0,
    deadband: {deadband: 2, yawDeadband: 3, altitudeHoldDeadband: 4, throttle3dDeadband: 5},
  };
}

async function renderAt(width: number) {
  mockWindowWidth = width;
  const original = snapshot();
  const controller: ReceiverControllerPort = {
    load: jest.fn(async () => ({kind: 'LOADED' as const, snapshot: original})),
    save: jest.fn(async () => ({kind: 'SAVED_VERIFIED' as const, snapshot: original})),
  };
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <ReceiverScreen
        sessionKey={{sessionId: 'receiver-p1', generation: 1}}
        active
        onOpenPorts={jest.fn()}
        onOpenMotors={jest.fn()}
        controller={controller}
      />,
    );
  });
  return renderer;
}

/** Every style object applied anywhere in the tree, flattened. */
function allStyleObjects(renderer: ReactTestRenderer.ReactTestRenderer): Record<string, unknown>[] {
  const collected: Record<string, unknown>[] = [];
  const visit = (style: unknown): void => {
    if (Array.isArray(style)) {
      style.forEach(visit);
    } else if (style !== null && typeof style === 'object') {
      collected.push(style as Record<string, unknown>);
    }
  };
  renderer.root.findAll(() => true).forEach(node => visit(node.props.style));
  return collected;
}

describe('Receiver P1 - all live channels are reachable', () => {
  it.each([[390], [768], [1366]])(
    'P1-P items 27-32: renders every one of 16 live channels at %ipx',
    async width => {
      const renderer = await renderAt(width);
      for (let channel = 1; channel <= LIVE_CHANNELS.length; channel += 1) {
        expect(
          renderer.root.findAllByProps({testID: `receiver-channel-${channel}`}).length,
        ).toBeGreaterThan(0);
      }
      // Explicitly the three that were hidden at 768.
      expect(renderer.root.findAllByProps({testID: 'receiver-channel-10'}).length).toBeGreaterThan(0);
      expect(renderer.root.findAllByProps({testID: 'receiver-channel-11'}).length).toBeGreaterThan(0);
      expect(renderer.root.findAllByProps({testID: 'receiver-channel-12'}).length).toBeGreaterThan(0);
      act(() => renderer.unmount());
    },
  );

  it.each([[390], [768]])(
    'P1-M: in the %ipx COLUMN layout no card is sized by flex-grow, so none can be shorter than its content',
    async width => {
      const renderer = await renderAt(width);
      const flexValues = allStyleObjects(renderer)
        .map(style => style.flex)
        .filter(value => value === 2 || value === 3);
      // This is exactly the defect: a 4:5 proportional split applied in a
      // column layout, where flex-basis 0 detaches box height from
      // content height.
      expect(flexValues).toHaveLength(0);
      act(() => renderer.unmount());
    },
  );

  it('P1-M: the proportional split is still applied in the wide ROW layout, where it is correct', async () => {
    // P3 rebalanced the wide split from 4:5 to 3:2 so the LIVE CHANNELS
    // column is the larger one; the P1 contract itself is unchanged -
    // proportional flex only where the cards sit side by side.
    const renderer = await renderAt(1366);
    const flexValues = allStyleObjects(renderer)
      .map(style => style.flex)
      .filter(value => value === 2 || value === 3);
    expect(flexValues).toContain(3);
    expect(flexValues).toContain(2);
    act(() => renderer.unmount());
  });

  it('labels the four primary axes then AUX, matching the rcmap-normalised MSP_RC order', async () => {
    const renderer = await renderAt(1366);
    const textOf = (testID: string): string[] =>
      renderer.root
        .findByProps({testID})
        .findAllByType('Text' as never)
        .map(node => String(node.props.children));
    // P3-AC: the four primary axes are named in Arabic, AUX stays Latin.
    expect(textOf('receiver-channel-1')).toContain('الدوران');
    expect(textOf('receiver-channel-2')).toContain('الميل');
    expect(textOf('receiver-channel-3')).toContain('الانحراف');
    expect(textOf('receiver-channel-4')).toContain('الخانق');
    expect(textOf('receiver-channel-5')).toContain('AUX 1');
    expect(textOf('receiver-channel-16')).toContain('AUX 12');
    act(() => renderer.unmount());
  });
});

describe('Receiver P1 - the screen stays presentation-only (P1-Q)', () => {
  const source = readFileSync(join(__dirname, 'ReceiverScreen.tsx'), 'utf8');
  // Strip comments so prose can never satisfy or trip these checks.
  const executable = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('P1-P item 35: adds no timer or poller of its own', () => {
    expect(executable).not.toMatch(/\bsetInterval\b/);
    expect(executable).not.toMatch(/\bsetTimeout\b/);
    expect(executable).not.toMatch(/\brequestAnimationFrame\b/);
  });

  it('P1-P item 34: imports no MSP client, scheduler, transport, encoder or raw command constant', () => {
    const importBlock = executable.slice(0, executable.indexOf('export interface'));
    for (const forbidden of [
      'MspClient',
      'MspTelemetryScheduler',
      'createMspTelemetryScheduler',
      'RNMspTransport',
      'encodeChangedReceiverConfiguration',
      'encodeReceiverConfig',
      'decodeRcChannels',
      'MSP_SET_RX_CONFIG',
      'MSP_RX_CONFIG',
      'MSP_SET_RX_MAP',
    ]) {
      expect(importBlock).not.toContain(forbidden);
    }
  });
});
