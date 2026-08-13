/** @jest-environment jsdom */
/**
 * RECEIVER P3 CLOSURE - the Receiver screen under REAL react-native-web.
 *
 * Every other Receiver UI suite runs against react-test-renderer, which
 * never produces a DOM: it proves the element tree, not that the screen
 * survives the web renderer. This product ships to a browser as well as
 * to Android, and the web path has its own failure modes - a native-only
 * API reached at render time, a style react-native-web drops, an
 * animated node the DOM never receives.
 *
 * This is the Receiver counterpart of MotorsScreen.web.test.tsx: the
 * real screen, the real react-native-web, a real DOM, and assertions
 * made against rendered nodes rather than against React elements.
 */
jest.mock('react-native', () => jest.requireActual('react-native-web'));

const CHANNELS = [1612, 1478, 1500, 1185, 2000, 1000, 1500, 1000, 1712, 1000, 1000, 1500, 988, 1000, 1200, 1800];

/** Swapped per test, before render. */
let mockObservedHz: number | undefined;
let mockChannelsState: Record<string, unknown> = {status: 'FRESH', value: {channels: CHANNELS}, updatedAtMs: 1, sampleSeq: 1};
let mockArmingDisableFlags = 0;

jest.mock('../../platforms/react-native/protocol/receiverPresentation', () => {
  const actual = jest.requireActual('../../platforms/react-native/protocol/receiverPresentation');
  return {
    ...actual,
    acquireReceiverTelemetry: () => () => undefined,
    // The screen must read the MEASURED rate through this facade and
    // never compute one itself.
    getReceiverObservedRateHz: () => mockObservedHz,
    useTelemetryValue: (_sessionId: string, pollId: string) => {
      if (pollId === 'receiver-channels-live') return mockChannelsState;
      if (pollId === 'receiver') return {status: 'FRESH', value: {rssi: 812}, updatedAtMs: 1, sampleSeq: 1};
      if (pollId === 'fcStatus') return {status: 'FRESH', value: {readiness: {armingDisableFlags: mockArmingDisableFlags}}, updatedAtMs: 1, sampleSeq: 1};
      return {status: 'UNAVAILABLE'};
    },
  };
});

import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import '../../i18n';
import {decodeRxConfig, type ReceiverConfigurationSnapshot} from '../../core';
// A TYPE-only import from the mocked module: erased at compile time, so
// it cannot pull the real protocol layer into this test.
import type {ReceiverRuntimeTruth} from '../../platforms/react-native/protocol/receiverPresentation';
import ReceiverScreen, {type ReceiverControllerPort} from './ReceiverScreen';

function snapshot(): ReceiverConfigurationSnapshot {
  const bytes = new Uint8Array(39);
  const view = new DataView(bytes.buffer);
  bytes[0] = 9; // serialrx_provider = CRSF
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

let host: HTMLDivElement;
let root: Root;
let saveKind: 'SAVED_VERIFIED' | 'SAVED_REBOOT_REQUIRED' = 'SAVED_VERIFIED';
let mockRuntimeMode: 'SERIAL' | 'SPI' | 'PPM' = 'SERIAL';
let mockDependency: {kind: string} = {kind: 'SATISFIED'};
let mockCapabilityProven = true;
let rebootCalls = 0;
let saveCalls = 0;

function controller(): ReceiverControllerPort {
  const original = snapshot();
  return {
    load: async () => ({kind: 'LOADED', snapshot: original}),
    save: async () => (saveCalls += 1, saveKind === 'SAVED_REBOOT_REQUIRED')
      ? {kind: 'SAVED_REBOOT_REQUIRED', snapshot: original, evidence: 'FC_REPORTED'}
      : {kind: 'SAVED_VERIFIED', snapshot: original},
    readRuntime: async () => ({kind: 'READ', runtime: {
      ...RUNTIME,
      mode: mockRuntimeMode,
      providerMeaningful: mockRuntimeMode === 'SERIAL',
      portDependency: mockRuntimeMode === 'SERIAL'
        ? {kind: 'SERIAL_RX_READY' as const, portIdentifier: 1}
        : {kind: 'NOT_APPLICABLE' as const, mode: mockRuntimeMode},
      serialTargetDependency: mockDependency,
      buildOptionsKnown: mockCapabilityProven,
      selectableModes: mockCapabilityProven ? ['PPM', 'SERIAL'] : [],
      selectableProviders: mockCapabilityProven ? [2, 9, 14] : [],
    } as never}),
    requestReboot: async () => { rebootCalls += 1; return {kind: 'REBOOT_REQUESTED'}; },
  };
}

async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <ReceiverScreen sessionKey={{sessionId: 'receiver-web', generation: 1}} active onOpenPorts={jest.fn()} onOpenMotors={jest.fn()} controller={controller()} />,
    );
  });
}

const q = (testID: string) => host.querySelector(`[data-testid="${testID}"]`);
const text = (testID: string) => q(testID)?.textContent ?? '';

beforeEach(() => {
  mockObservedHz = undefined;
  mockChannelsState = {status: 'FRESH', value: {channels: CHANNELS}, updatedAtMs: 1, sampleSeq: 1};
  mockArmingDisableFlags = 0;
  saveKind = 'SAVED_VERIFIED';
  mockRuntimeMode = 'SERIAL';
  mockDependency = {kind: 'SATISFIED'};
  mockCapabilityProven = true;
  rebootCalls = 0;
  saveCalls = 0;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('ReceiverScreen under real react-native-web', () => {
  it('renders in the DOM without reaching a native-only API', async () => {
    // A native-only call at render time throws here rather than on a
    // device; mounting at all is the assertion.
    await mount();
    expect(q('receiver-screen')).not.toBeNull();
    expect(text('receiver-title')).toBe('الريسيفر');
    expect(q('receiver-live-monitor')).not.toBeNull();
    expect(q('receiver-status-strip')).not.toBeNull();
  });

  it('puts the live workspace ABOVE the configuration in document order', async () => {
    await mount();
    const monitor = q('receiver-live-monitor')!;
    const source = q('receiver-source-card')!;
    // Node.DOCUMENT_POSITION_FOLLOWING: `source` comes after `monitor`.
    // eslint-disable-next-line no-bitwise
    expect(monitor.compareDocumentPosition(source) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('draws every delivered channel as a real element, RPYT first then AUX', async () => {
    await mount();
    for (let channel = 1; channel <= CHANNELS.length; channel += 1) {
      expect(q(`receiver-channel-${channel}`)).not.toBeNull();
    }
    expect(text('receiver-channel-1')).toContain('الدوران');
    expect(text('receiver-channel-2')).toContain('الميل');
    expect(text('receiver-channel-3')).toContain('الانحراف');
    expect(text('receiver-channel-4')).toContain('الخانق');
    expect(text('receiver-channel-5')).toContain('AUX 1');
    expect(text('receiver-channel-16')).toContain('AUX 12');
    // The delivered integers are printed, unrounded and unsmoothed.
    expect(text('receiver-channel-1')).toContain('1612');
    expect(text('receiver-channel-16')).toContain('1800');
  });

  /**
   * RECEIVER LIVE LATENCY P2: the bar's geometry moved from an animated
   * `width` percentage to a native-driver-capable `scaleX` transform, and
   * the stick dot from `left`/`top` to `translateX`/`translateY`. This
   * asserts react-native-web actually emits those transforms, because a
   * transform the web renderer silently dropped would leave the bar
   * frozen at full width and the dot pinned at the pad origin.
   */
  it('gives every bar a DOM transform the animated node actually drives', async () => {
    await mount();
    const fill = q('receiver-channel-1-fill') as HTMLElement;
    expect(fill).not.toBeNull();
    // Full-width layer, scaled on X. (1612-800)/1400 -> 0.58.
    expect(fill.style.transform).toContain('scaleX(0.58');
    const dot = q('receiver-stick-right-position') as HTMLElement;
    // 0.58 of the pad's 110px inner travel -> 63.8px.
    expect(dot.style.transform).toContain('translateX(63.8');
  });

  it('positions the stick dot physically, so the pad cannot mirror with the Arabic text', async () => {
    await mount();
    // A physical control diagram must not mirror with the text: right
    // stick right stays right regardless of language. On the web that is
    // achieved by `left` being a physical CSS offset rather than by a
    // direction pin, which react-native-web does not support (see the
    // stickPad style comment).
    const dot = q('receiver-stick-right-position') as HTMLElement;
    // translateX is a PHYSICAL displacement - it is not mirrored by RTL,
    // which is exactly the property this diagram needs.
    expect(dot.style.transform).toContain('translateX(63.8');
    expect(dot.style.right).toBe('');
    // While the Arabic labels around it stay in the page's RTL flow.
    expect(text('receiver-sticks-card')).toContain('حركة العصي');
  });

  it('renders no style react-native-web silently discards', async () => {
    // The web renderer reports an unsupported style property and then
    // drops it - the rule looks applied in the source and does nothing in
    // the browser. This is the general guard for that whole class of
    // cross-platform defect; it caught a real one (`direction: ltr` on
    // the stick pad) when it was written.
    const errors: string[] = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(String(args[0])); });
    try {
      await mount();
    } finally {
      spy.mockRestore();
    }
    expect(errors.filter(message => /Invalid style property|Unsupported style/i.test(message))).toEqual([]);
  });

  it('shows the MEASURED rate from the facade and invents nothing when there is none', async () => {
    mockObservedHz = 24;
    await mount();
    expect(text('receiver-observed-rate')).toBe('24 Hz');
    // No hard-coded frequency claim anywhere on the page.
    expect(host.textContent).not.toMatch(/20\s*Hz/);
    expect(host.textContent).not.toMatch(/TARGET/i);
  });

  it('renders a placeholder rather than a number when the rate is not yet known', async () => {
    mockObservedHz = undefined;
    await mount();
    expect(text('receiver-observed-rate')).toBe('—');
    expect(text('receiver-observed-rate')).not.toMatch(/Hz/);
  });

  it('stops quoting a rate the moment the link goes stale', async () => {
    mockObservedHz = 24;
    mockChannelsState = {status: 'STALE', value: {channels: CHANNELS}, updatedAtMs: 1, ageMs: 4200, sampleSeq: 1};
    await mount();
    expect(text('receiver-live-label')).toBe('بيانات متأخرة');
    expect(text('receiver-observed-rate')).toBe('—');
  });

  it('names failsafe by cause and still shows the values behind it', async () => {
    mockArmingDisableFlags = 2 ** 2; // RX_FAILSAFE, runtime_config.h @ 1.47
    await mount();
    expect(q('receiver-signal-alert')).not.toBeNull();
    expect(text('receiver-signal-alert')).toContain('فقدت إشارة الريسيفر');
    // The channels are NOT hidden behind the alert - a pilot needs to
    // see what the receiver is currently outputting.
    expect(q('receiver-channel-1')).not.toBeNull();
    expect(text('receiver-channel-1')).toContain('1612');
  });

  it('renders an operable receiver-mode control for a mode it can fully configure', async () => {
    // P2 held every mode read-only pending proven whole-mask mutation;
    // P4 discharged that for the modes the capability matrix clears.
    await mount();
    const row = q('receiver-mode-row') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain('تسلسلي (Serial RX)');
    expect(row.querySelector('[role="button"]')).not.toBeNull();
  });

  it('renders mode as read-only text with no control when the build proves nothing', async () => {
    // P4 closure: what makes it read-only is the connected build proving
    // no selectable implementation, not the active mode being exotic.
    mockRuntimeMode = 'SPI';
    mockCapabilityProven = false;
    await mount();
    const row = q('receiver-mode-row') as HTMLElement;
    expect(row.textContent).toContain('SPI');
    expect(row.querySelector('input,select,button,[role="button"],[tabindex]')).toBeNull();
    expect(q('receiver-mode-read-only')).not.toBeNull();
    // The stored provider is still displayed; only authoring is withheld.
    expect(text('receiver-provider-value')).toBe('CRSF');
    expect(q('receiver-provider-select')).toBeNull();
  });

  it('an unproven capability never renders as a functional unsupported selector', async () => {
    mockCapabilityProven = false;
    await mount();
    expect(q('receiver-mode-select')).toBeNull();
    expect(q('receiver-provider-select')).toBeNull();
    // Honest wording, not "unsupported".
    expect(text('receiver-provider-not-proven')).toContain('لا يمكن التحقق');
  });

  it('reaches the whole configuration surface through the DOM', async () => {
    await mount();
    for (const testID of ['receiver-source-card', 'receiver-map-card', 'receiver-range-card', 'receiver-deadband-card', 'receiver-smoothing-card', 'receiver-channel-map', 'receiver-stick-min', 'receiver-stick-max']) {
      expect(q(testID)).not.toBeNull();
    }
    expect(text('receiver-provider-value')).toBe('CRSF');
    expect(q('receiver-provider-note')).not.toBeNull();
    expect(text('receiver-port-status')).not.toBe('');
    // The save bar is deliberately absent while nothing is edited, and
    // appears the moment the draft diverges.
    expect(q('receiver-save-bar')).toBeNull();
    await act(async () => {
      (q('receiver-stick-min-plus') as HTMLElement).dispatchEvent(new MouseEvent('click', {bubbles: true}));
    });
    expect(q('receiver-save-bar')).not.toBeNull();
  });

  it('surfaces reboot-required after a save, and routes the reboot through the controller', async () => {
    saveKind = 'SAVED_REBOOT_REQUIRED';
    await mount();
    const map = q('receiver-channel-map') as HTMLInputElement;
    // A real DOM edit, through react-native-web's own input handling.
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(map, 'TAER1234');
      map.dispatchEvent(new Event('input', {bubbles: true}));
    });
    await act(async () => {
      (q('receiver-save-bar-save') as HTMLElement).dispatchEvent(new MouseEvent('click', {bubbles: true}));
    });
    expect(q('receiver-reboot-required')).not.toBeNull();
    expect(text('receiver-reboot-required')).toContain('يلزم إعادة تشغيل');

    await act(async () => {
      (q('receiver-reboot-action') as HTMLElement).dispatchEvent(new MouseEvent('click', {bubbles: true}));
    });
    // The screen never issues MSP_REBOOT itself.
    expect(rebootCalls).toBe(1);
    expect(q('receiver-reboot-requested')).not.toBeNull();
  });

  /* ------------------------------------------------ P4 on the web */
  it('renders the mode and provider controls through shared logic, no native-only API', async () => {
    await mount();
    const mode = q('receiver-mode-select');
    const provider = q('receiver-provider-select');
    expect(mode).not.toBeNull();
    expect(provider).not.toBeNull();
    // Real, operable DOM controls with accessible names and values.
    expect(mode!.getAttribute('role')).toBe('button');
    expect(mode!.getAttribute('aria-label')).toBe('وضع الريسيفر');
    expect(provider!.getAttribute('aria-label')).toBe('البروتوكول التسلسلي');
  });

  it('opens the mode list in the DOM and offers only fully-configurable modes', async () => {
    await mount();
    await act(async () => {
      (q('receiver-mode-select') as HTMLElement).dispatchEvent(new MouseEvent('click', {bubbles: true}));
    });
    const body = document.body.textContent ?? '';
    expect(body).toContain('تسلسلي (Serial RX)');
    expect(body).toContain('PPM');
    expect(body).not.toContain('بدون ريسيفر');
  });

  it('renders the dependency block and disables Save when a SERIAL target has no UART', async () => {
    mockDependency = {kind: 'DEPENDENCY_MISSING'};
    mockRuntimeMode = 'PPM';
    await mount();
    await act(async () => {
      (q('receiver-mode-select') as HTMLElement).dispatchEvent(new MouseEvent('click', {bubbles: true}));
    });
    const serial = document.querySelector('[data-testid="receiver-mode-select-option-SERIAL"]') as HTMLElement;
    expect(serial).not.toBeNull();
    await act(async () => { serial.dispatchEvent(new MouseEvent('click', {bubbles: true})); });
    expect(q('receiver-dependency-block')).not.toBeNull();
    expect(text('receiver-dependency-block')).toContain('افتح المنافذ');
    // And pressing Save does nothing: the transition is refused in the UI
    // before it can reach the controller.
    saveCalls = 0;
    const saveButton = q('receiver-save-bar-save') as HTMLElement | null;
    if (saveButton !== null) await act(async () => { saveButton.dispatchEvent(new MouseEvent('click', {bubbles: true})); });
    expect(saveCalls).toBe(0);
  });

  it('keeps the P3 bar animation working alongside the new controls', async () => {
    await mount();
    const fill = q('receiver-channel-1-fill') as HTMLElement;
    expect(fill.style.transform).toContain('scaleX(0.58');
    expect(q('receiver-live-monitor')).not.toBeNull();
  });

  it('never puts raw protocol vocabulary in front of the pilot', async () => {
    await mount();
    const body = host.textContent ?? '';
    for (const jargon of ['MSP_RC', 'MSP_SET_RX_CONFIG', 'MSP_RX_CONFIG', 'MSP_REBOOT', 'armingDisableFlags', 'featureMask']) {
      expect(body).not.toContain(jargon);
    }
  });
});
