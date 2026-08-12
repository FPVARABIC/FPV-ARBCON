/**
 * RECEIVER P3-AQ - the contract this screen is now held to.
 *
 * P3 rebuilt the Receiver page: hierarchy, channel truth, failsafe
 * naming, stick/RTL geometry, channel map, firmware-derived mode, RSSI,
 * save/reboot semantics, i18n and the UI/protocol boundary. Those
 * decisions are spread across a 600-line screen and a 98-key namespace,
 * where each is one edit away from being quietly undone.
 *
 * This suite states them once, grouped the way the closure brief groups
 * them (A-J). Each assertion is a decision that was made deliberately
 * and that a reasonable future edit could reverse; where an existing
 * suite already owns a rule, this file does not restate it - the
 * pointer is written down instead.
 */

import React from 'react';
import {readFileSync} from 'fs';
import {join} from 'path';
import ReactTestRenderer, {act} from 'react-test-renderer';
import '../../i18n';
import ar from '../../i18n/locales/ar.json';
import {decodeRxConfig, type ReceiverConfigurationSnapshot} from '../../core';
// A TYPE-only import from the mocked module: erased at compile time, so
// it cannot pull the real protocol layer into this test.
import type {ReceiverRuntimeTruth} from '../../platforms/react-native/protocol';

const CHANNELS = [1612, 1478, 1500, 1185, 2000, 1000, 1500, 1000, 1712, 1000, 1000, 1500, 988, 1000, 1200, 1800];

let mockChannels: readonly number[] = CHANNELS;
let mockChannelStatus: 'FRESH' | 'STALE' | 'UNAVAILABLE' = 'FRESH';
let mockArmingDisableFlags = 0;
let mockRssi: number | undefined = 812;
let mockObservedHz: number | undefined = 24;

jest.mock('../../platforms/react-native/protocol', () => {
  const actual = jest.requireActual('../../platforms/react-native/protocol');
  return {
    ...actual,
    acquireReceiverTelemetry: () => () => undefined,
    getReceiverObservedRateHz: () => mockObservedHz,
    useTelemetryValue: (_sessionId: string, pollId: string) => {
      if (pollId === 'receiver-channels-live') {
        if (mockChannelStatus === 'UNAVAILABLE') return {status: 'UNAVAILABLE'};
        return mockChannelStatus === 'STALE'
          ? {status: 'STALE', value: {channels: mockChannels}, updatedAtMs: 1, ageMs: 4200, sampleSeq: 1}
          : {status: 'FRESH', value: {channels: mockChannels}, updatedAtMs: 1, sampleSeq: 1};
      }
      if (pollId === 'receiver') {
        return mockRssi === undefined ? {status: 'UNAVAILABLE'} : {status: 'FRESH', value: {rssi: mockRssi}, updatedAtMs: 1, sampleSeq: 1};
      }
      if (pollId === 'fcStatus') return {status: 'FRESH', value: {readiness: {armingDisableFlags: mockArmingDisableFlags}}, updatedAtMs: 1, sampleSeq: 1};
      return {status: 'UNAVAILABLE'};
    },
  };
});

// Imported after jest.mock() on purpose.
import ReceiverScreen, {channelDisplayFraction, type ReceiverControllerPort} from './ReceiverScreen';

const SOURCE = readFileSync(join(__dirname, 'ReceiverScreen.tsx'), 'utf8');
/** Comments stripped, so prose can never satisfy or trip a source rule. */
const EXECUTABLE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function snapshot(provider = 9): ReceiverConfigurationSnapshot {
  const bytes = new Uint8Array(39);
  const view = new DataView(bytes.buffer);
  bytes[0] = provider;
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

const SERIAL_RUNTIME: ReceiverRuntimeTruth = {
  mode: 'SERIAL', featureMaskRaw: 2 ** 3, providerMeaningful: true,
  portDependency: {kind: 'SERIAL_RX_READY', portIdentifier: 1},
  rssiSource: {kind: 'KNOWN', token: 'RX_PROTOCOL_CRSF', value: 6},
};

interface MountOptions {
  runtime?: ReceiverRuntimeTruth;
  save?: ReceiverControllerPort['save'];
  requestReboot?: ReceiverControllerPort['requestReboot'];
  provider?: number;
}

async function mount(options: MountOptions = {}) {
  const original = snapshot(options.provider);
  const controller: ReceiverControllerPort = {
    load: async () => ({kind: 'LOADED', snapshot: original}),
    save: options.save ?? (async () => ({kind: 'SAVED_VERIFIED', snapshot: original})),
    readRuntime: async () => ({kind: 'READ', runtime: options.runtime ?? SERIAL_RUNTIME}),
    requestReboot: options.requestReboot,
  };
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <ReceiverScreen sessionKey={{sessionId: 'receiver-contract', generation: 1}} active onOpenPorts={jest.fn()} onOpenMotors={jest.fn()} controller={controller} />,
    );
  });
  return {renderer, original};
}

function textUnder(renderer: ReactTestRenderer.ReactTestRenderer, testID: string): string {
  return renderer.root
    .findByProps({testID})
    .findAllByType('Text' as never)
    .map(node => (Array.isArray(node.props.children) ? node.props.children.join('') : String(node.props.children)))
    .join(' | ');
}
function pageText(renderer: ReactTestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType('Text' as never)
    .map(node => (Array.isArray(node.props.children) ? node.props.children.join('') : String(node.props.children)))
    .join(' | ');
}
function styleOf(node: ReactTestRenderer.ReactTestInstance): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const entry of ([] as unknown[]).concat(node.props.style as unknown[]).flat(4)) {
    if (entry !== null && typeof entry === 'object') Object.assign(merged, entry);
  }
  return merged;
}

beforeEach(() => {
  mockChannels = CHANNELS;
  mockChannelStatus = 'FRESH';
  mockArmingDisableFlags = 0;
  mockRssi = 812;
  mockObservedHz = 24;
});

/* ===================================================== A - HIERARCHY */
describe('P3-AQ A: the page leads with live data', () => {
  it('renders the live workspace BEFORE any configuration section', async () => {
    const {renderer} = await mount();
    const order = renderer.root
      .findAll(node => typeof node.props.testID === 'string' && ['receiver-live-monitor', 'receiver-source-card', 'receiver-map-card', 'receiver-range-card'].includes(node.props.testID as string))
      .map(node => node.props.testID as string);
    expect(order.indexOf('receiver-live-monitor')).toBeLessThan(order.indexOf('receiver-source-card'));
    expect(order.indexOf('receiver-source-card')).toBeLessThan(order.indexOf('receiver-map-card'));
    act(() => renderer.unmount());
  });

  it('states no cadence it has not measured', async () => {
    // The pre-P3 header carried a fixed "TARGET 20 HZ" claim that was
    // simply untrue after P1 changed the cadence.
    mockObservedHz = undefined;
    const {renderer} = await mount();
    const body = pageText(renderer);
    expect(body).not.toMatch(/\d+\s*Hz/);
    expect(body).not.toMatch(/TARGET/i);
    expect(textUnder(renderer, 'receiver-observed-rate')).toBe('—');
    act(() => renderer.unmount());
  });

  it('quotes only the rate the facade measured, verbatim', async () => {
    mockObservedHz = 24;
    const {renderer} = await mount();
    expect(textUnder(renderer, 'receiver-observed-rate')).toBe('24 Hz');
    // Not derived from the requested interval: 1000/33 would be 30.
    expect(textUnder(renderer, 'receiver-observed-rate')).not.toContain('30');
    act(() => renderer.unmount());
  });
});

/* ================================================= B - CHANNEL TRUTH */
describe('P3-AQ B: every bar states the delivered value', () => {
  it.each([[4], [8], [16], [18]])('renders exactly the %i channels the payload carried', async count => {
    mockChannels = Array.from({length: count}, (_, index) => 1000 + index * 50);
    const {renderer} = await mount();
    expect(renderer.root.findAllByProps({testID: `receiver-channel-${count}`}).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({testID: `receiver-channel-${count + 1}`})).toHaveLength(0);
    expect(textUnder(renderer, 'receiver-channel-count')).toBe(String(count));
    act(() => renderer.unmount());
  });

  it('prints the exact integer, never a rounded or rescaled one', async () => {
    mockChannels = [988, 1499, 1501, 2011, ...CHANNELS.slice(4)];
    const {renderer} = await mount();
    for (const [channel, value] of [[1, 988], [2, 1499], [3, 1501], [4, 2011]] as const) {
      expect(textUnder(renderer, `receiver-channel-${channel}`)).toContain(String(value));
    }
    act(() => renderer.unmount());
  });

  it('clamps only the BAR for a value outside the display window, and still prints it', async () => {
    // 750 and 2250 are the firmware's own valid pulse limits (rx.h:36-37)
    // and sit outside the 800-2200 visualisation window.
    mockChannels = [750, 2250, ...CHANNELS.slice(2)];
    const {renderer} = await mount();
    expect(channelDisplayFraction(750)).toBe(0);
    expect(channelDisplayFraction(2250)).toBe(1);
    expect(textUnder(renderer, 'receiver-channel-1')).toContain('750');
    expect(textUnder(renderer, 'receiver-channel-2')).toContain('2250');
    act(() => renderer.unmount());
  });

  it('says nothing at all rather than drawing empty bars with no link', async () => {
    mockChannelStatus = 'UNAVAILABLE';
    const {renderer} = await mount();
    expect(renderer.root.findAllByProps({testID: 'receiver-channel-1'})).toHaveLength(0);
    expect(textUnder(renderer, 'receiver-channel-count')).toBe('—');
    expect(textUnder(renderer, 'receiver-live-label')).toBe(ar.receiverScreen.liveWaiting);
    act(() => renderer.unmount());
  });
});

/* ===================================================== C - FAILSAFE */
describe('P3-AQ C: failsafe is named by cause', () => {
  /* runtime_config.h @ pinned 1.47: RX_FAILSAFE = 1<<2, BOXFAILSAFE = 1<<4. */
  it.each([
    [2 ** 2, ar.receiverScreen.failsafeRxLoss],
    [2 ** 4, ar.receiverScreen.failsafeBox],
  ])('flags %i as its own named cause', async (flags, expected) => {
    mockArmingDisableFlags = flags;
    const {renderer} = await mount();
    expect(textUnder(renderer, 'receiver-signal-alert')).toContain(expected);
    // The values behind the alert stay visible - a pilot needs to see
    // what the receiver is currently outputting.
    expect(textUnder(renderer, 'receiver-channel-1')).toContain('1612');
    act(() => renderer.unmount());
  });

  it('claims no failsafe when no failsafe bit is set', async () => {
    mockArmingDisableFlags = 1; // some other arming blocker
    const {renderer} = await mount();
    expect(renderer.root.findAllByProps({testID: 'receiver-signal-alert'})).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('distinguishes the two causes rather than collapsing them', () => {
    expect(ar.receiverScreen.failsafeRxLoss).not.toBe(ar.receiverScreen.failsafeBox);
    expect(ar.receiverScreen.failsafeActive).not.toBe(ar.receiverScreen.failsafeRxLoss);
    expect(ar.receiverScreen.failsafeUnknown).not.toBe(ar.receiverScreen.failsafeActive);
  });
});

/* ============================================ D - STICKS / RTL / BIDI */
describe('P3-AQ D: the stick pad is a physical diagram, not text', () => {
  it('pins the pad subtree to LTR on native, where Yoga would otherwise mirror it', async () => {
    const {renderer} = await mount();
    const pad = renderer.root
      .findByProps({testID: 'receiver-stick-right'})
      .findAll(node => typeof node.type === 'string' || node.props.style !== undefined)
      .map(styleOf)
      .find(style => style.direction !== undefined);
    // This preset reports a native platform, which is where the pin is
    // required and applied. The web half is asserted in
    // ReceiverScreen.web.test.tsx.
    expect(pad?.direction).toBe('ltr');
    act(() => renderer.unmount());
  });

  it('names the four axes in Arabic and leaves AUX as a Latin token', async () => {
    const {renderer} = await mount();
    expect(textUnder(renderer, 'receiver-channel-1')).toContain(ar.receiverScreen.axisRoll);
    expect(textUnder(renderer, 'receiver-channel-4')).toContain(ar.receiverScreen.axisThrottle);
    expect(textUnder(renderer, 'receiver-channel-5')).toContain('AUX 1');
    act(() => renderer.unmount());
  });

  it('keeps every Latin number in its own text run, so bidi cannot reorder it', async () => {
    const {renderer} = await mount();
    const pad = renderer.root.findByProps({testID: 'receiver-stick-right'});
    const runs = pad.findAllByType('Text' as never).map(node => String(node.props.children));
    // label, value, label, value - never one interpolated string, where
    // an Arabic label and a Latin number share a bidi run.
    expect(runs).toEqual([ar.receiverScreen.axisRoll, '1612', ar.receiverScreen.axisPitch, '1478']);
    act(() => renderer.unmount());
  });
});

/* ================================================== E - CHANNEL MAP */
describe('P3-AQ E: the channel map is edited as text and validated', () => {
  it('shows the loaded map and applies a preset to the same field', async () => {
    const {renderer} = await mount();
    const field = () => renderer.root.findAllByProps({testID: 'receiver-channel-map'}).find(node => node.props.value !== undefined);
    expect(field()?.props.value).toBe('AETR1234');
    const preset = renderer.root.findAll(node => node.props.onPress !== undefined && node.findAllByType('Text' as never).some(text => text.props.children === 'TAER1234'))[0];
    act(() => preset.props.onPress());
    expect(field()?.props.value).toBe('TAER1234');
    act(() => renderer.unmount());
  });

  it('marks an invalid map instead of silently sending it', async () => {
    const save = jest.fn(async () => ({kind: 'SAVED_VERIFIED' as const, snapshot: snapshot()}));
    const {renderer} = await mount({save: save as ReceiverControllerPort['save']});
    const field = renderer.root.findAllByProps({testID: 'receiver-channel-map'}).find(node => node.props.onChangeText !== undefined)!;
    act(() => field.props.onChangeText('ZZZZ'));
    const marked = renderer.root.findAllByProps({testID: 'receiver-channel-map'})
      .map(styleOf)
      .some(style => style.borderColor !== undefined && style.borderColor !== null);
    expect(marked).toBe(true);
    // And the save path refuses while the draft is invalid.
    const bar = renderer.root.findAllByProps({testID: 'receiver-save-bar-save'});
    if (bar.length > 0) await act(async () => { await bar[0].props.onPress(); });
    expect(save).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});

/* ======================================= F - MODE / PROVIDER / PORTS */
describe('P3-AQ F: firmware truth is shown, never authored', () => {
  it('shows the active mode as read-only text with no control attached', async () => {
    const {renderer} = await mount();
    const row = renderer.root.findByProps({testID: 'receiver-mode-row'});
    expect(textUnder(renderer, 'receiver-mode-row')).toContain(ar.receiverScreen.modeSerial);
    expect(row.findAll(node => node.props.onPress !== undefined || node.props.onChangeText !== undefined || node.props.onValueChange !== undefined)).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('omits the mode row entirely when the firmware could not be asked', async () => {
    const original = snapshot();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <ReceiverScreen sessionKey={{sessionId: 'receiver-contract', generation: 1}} active onOpenPorts={jest.fn()} onOpenMotors={jest.fn()}
          controller={{load: async () => ({kind: 'LOADED', snapshot: original}), save: async () => ({kind: 'SAVED_VERIFIED', snapshot: original})}} />,
      );
    });
    // No runtime read at all: better a missing row than a guessed mode.
    expect(renderer.root.findAllByProps({testID: 'receiver-mode-row'})).toHaveLength(0);
    expect(renderer.root.findAllByProps({testID: 'receiver-port-status'})).toHaveLength(0);
    expect(textUnder(renderer, 'receiver-provider-value')).toBe('CRSF');
    act(() => renderer.unmount());
  });

  it('keeps CRSF as the provider and explains ExpressLRS as a user of it', async () => {
    const {renderer} = await mount();
    expect(textUnder(renderer, 'receiver-provider-value')).toBe('CRSF');
    expect(renderer.root.findAllByProps({testID: 'receiver-provider-note'}).length).toBeGreaterThan(0);
    // ELRS is never introduced as its own serialrx_provider value.
    expect(pageText(renderer)).not.toMatch(/provider\s*[:=]\s*ExpressLRS/i);
    act(() => renderer.unmount());
  });

  it('says the stored provider is inert when the active mode is not SERIAL', async () => {
    const {renderer} = await mount({runtime: {...SERIAL_RUNTIME, mode: 'SPI', providerMeaningful: false, portDependency: {kind: 'NOT_APPLICABLE', mode: 'SPI'}}});
    expect(textUnder(renderer, 'receiver-mode-row')).toContain(ar.receiverScreen.modeSpi);
    expect(renderer.root.findAllByProps({testID: 'receiver-provider-stored-only'}).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({testID: 'receiver-provider-note'})).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('reports the Serial RX UART cross-check without offering to change it', async () => {
    const {renderer} = await mount({runtime: {...SERIAL_RUNTIME, portDependency: {kind: 'SERIAL_RX_UART_MISSING'}}});
    expect(textUnder(renderer, 'receiver-port-status')).toContain(ar.receiverScreen.portMissing);
    act(() => renderer.unmount());
  });

  it('writes no feature mask and no receiver mode, anywhere in this screen', () => {
    for (const forbidden of ['MSP_SET_FEATURE_CONFIG', 'setFeatureConfig', 'writeReceiverMode', 'setReceiverMode', 'MSP_SET_RX_CONFIG']) {
      expect(EXECUTABLE).not.toContain(forbidden);
    }
  });
});

/* ===================================================== G - RSSI / LQ */
describe('P3-AQ G: RSSI is reported, Link Quality is not invented', () => {
  it('shows a percentage derived from the analog frame', async () => {
    mockRssi = 812; // 0..1023 -> 79%
    const {renderer} = await mount();
    expect(textUnder(renderer, 'receiver-rssi-value')).toBe('79%');
    act(() => renderer.unmount());
  });

  it('says unavailable rather than zero when there is no analog frame', async () => {
    mockRssi = undefined;
    const {renderer} = await mount();
    expect(textUnder(renderer, 'receiver-rssi-value')).toBe(ar.receiverScreen.rssiUnavailable);
    expect(textUnder(renderer, 'receiver-rssi-value')).not.toContain('0%');
    act(() => renderer.unmount());
  });

  it('never shows a Link Quality figure, because MSP does not carry one', async () => {
    const {renderer} = await mount();
    const body = pageText(renderer);
    expect(body).not.toMatch(/\bLQ\b/);
    expect(body).not.toMatch(/Link\s*Quality/i);
    expect(JSON.stringify(ar.receiverScreen)).not.toMatch(/جودة الاتصال|Link Quality/i);
    act(() => renderer.unmount());
  });
});

/* ================================================ H - SAVE / REBOOT */
describe('P3-AQ H: a save that needs a reboot never reads as applied', () => {
  async function saveWith(kind: 'SAVED_VERIFIED' | 'SAVED_REBOOT_REQUIRED', evidence?: 'FC_REPORTED' | 'EXPECTED_UNCONFIRMED', requestReboot?: ReceiverControllerPort['requestReboot']) {
    const original = snapshot();
    const {renderer} = await mount({
      save: async () => (kind === 'SAVED_REBOOT_REQUIRED'
        ? {kind, snapshot: original, evidence: evidence ?? 'FC_REPORTED'}
        : {kind, snapshot: original}),
      requestReboot,
    });
    const preset = renderer.root.findAll(node => node.props.onPress !== undefined && node.findAllByType('Text' as never).some(text => text.props.children === 'TAER1234'))[0];
    act(() => preset.props.onPress());
    await act(async () => { await renderer.root.findByProps({testID: 'receiver-save-bar-save'}).props.onPress(); });
    return renderer;
  }

  it('shows nothing about rebooting after a verified save', async () => {
    const renderer = await saveWith('SAVED_VERIFIED');
    expect(renderer.root.findAllByProps({testID: 'receiver-reboot-required'})).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('separates "the FC said so" from "we could not read the flag"', async () => {
    const reported = await saveWith('SAVED_REBOOT_REQUIRED', 'FC_REPORTED');
    expect(textUnder(reported, 'receiver-reboot-required')).toContain(ar.receiverScreen.savedRebootReported);
    act(() => reported.unmount());

    const expected = await saveWith('SAVED_REBOOT_REQUIRED', 'EXPECTED_UNCONFIRMED');
    expect(textUnder(expected, 'receiver-reboot-required')).toContain(ar.receiverScreen.savedRebootExpected);
    expect(ar.receiverScreen.savedRebootReported).not.toBe(ar.receiverScreen.savedRebootExpected);
    act(() => expected.unmount());
  });

  it('routes the reboot through the controller and then stops offering it', async () => {
    const requestReboot = jest.fn(async () => ({kind: 'REBOOT_REQUESTED' as const}));
    const renderer = await saveWith('SAVED_REBOOT_REQUIRED', 'FC_REPORTED', requestReboot);
    // Warned about the disconnect BEFORE the action is offered.
    expect(textUnder(renderer, 'receiver-reboot-required')).toContain(ar.receiverScreen.rebootWillDisconnect);
    await act(async () => { await renderer.root.findByProps({testID: 'receiver-reboot-action'}).props.onPress(); });
    expect(requestReboot).toHaveBeenCalledTimes(1);
    expect(renderer.root.findAllByProps({testID: 'receiver-reboot-requested'}).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({testID: 'receiver-reboot-action'})).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('never issues the reboot command itself', () => {
    expect(EXECUTABLE).not.toContain('MSP_REBOOT');
    expect(EXECUTABLE).not.toContain('MSP_SET_REBOOT');
  });
});

/* ========================================= I - I18N / ACCESSIBILITY */
describe('P3-AQ I: every string is translated and every row is announced', () => {
  it('hard-codes no Arabic text in the screen source', () => {
    const arabic = EXECUTABLE.match(/[؀-ۿ]+/g) ?? [];
    expect(arabic).toEqual([]);
  });

  it('resolves every receiverScreen key the screen asks for', () => {
    const keys = [...EXECUTABLE.matchAll(/'receiverScreen\.([A-Za-z0-9]+)'/g)].map(match => match[1]);
    expect(keys.length).toBeGreaterThan(40);
    const namespace = ar.receiverScreen as Record<string, string>;
    expect(keys.filter(key => namespace[key] === undefined)).toEqual([]);
  });

  it('announces each channel row as its label and its value', async () => {
    const {renderer} = await mount();
    const row = renderer.root.findByProps({testID: 'receiver-channel-1'});
    expect(row.props.accessible).toBe(true);
    expect(row.props.accessibilityLabel).toBe(`${ar.receiverScreen.axisRoll}: 1612`);
    act(() => renderer.unmount());
  });
});

/* ============================================== J - SOURCE BOUNDARY */
describe('P3-AQ J: the screen stays on the UI side of the boundary', () => {
  it('imports no client, scheduler, transport, encoder or command constant', () => {
    const imports = EXECUTABLE.slice(0, EXECUTABLE.indexOf('export interface'));
    for (const forbidden of ['MspClient', 'MspTelemetryScheduler', 'mspSessionCoordinator', 'RNMspTransport', 'encodeChangedReceiverConfiguration', 'decodeRcChannels', 'MSP_RC', 'MSP_RX_CONFIG', 'MSP_SET_RX_MAP']) {
      expect(imports).not.toContain(forbidden);
    }
  });

  it('owns no clock of its own - the animation driver is the only one', () => {
    // setInterval/setTimeout/requestAnimationFrame would each be a second
    // cadence competing with the scheduler's. Animated has its own driver
    // and is not one of them.
    expect(EXECUTABLE).not.toMatch(/\bsetInterval\b/);
    expect(EXECUTABLE).not.toMatch(/\bsetTimeout\b/);
    expect(EXECUTABLE).not.toMatch(/\brequestAnimationFrame\b/);
  });

  it('reads the observed rate through the facade, never off a scheduler', () => {
    expect(EXECUTABLE).toContain('getReceiverObservedRateHz');
    expect(EXECUTABLE).not.toContain('describeDiagnostics');
    expect(EXECUTABLE).not.toContain('observedSampleRateHz');
  });
});
