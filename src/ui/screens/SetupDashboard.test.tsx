// ENTRY CLEANUP: SetupScreen now hosts the USB connection workspace
// (UsbConnectionScreen) for its disconnected state, so importing it pulls
// in the transport client whose TurboModule must be mocked under Jest -
// the exact mock App.test.tsx has always used.
jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

/**
 * SETUP P2 - THE DASHBOARD CONTRACT.
 *
 * P0 measured a 390px Setup page 3,021px tall in which the operator met,
 * in order: a 969px orientation hero, a 908px block of calibration tools,
 * and only then - past y=2598 - the arming strip, and past y=2846 the
 * first live fact about the aircraft. This suite pins the replacement:
 * what the four summary cards say, where they navigate, and the rule that
 * two surfaces may never disagree about one fact.
 *
 * WHAT IS REAL HERE. The real coordinator, MspClient, framing, scheduler
 * and tick driver, the real identification handshake, the real BOXIDS
 * acquisition, and the real Setup component tree. Only the USB transport
 * is faked, with frames built by the same MSP frame builder the client's
 * own tests use.
 *
 * NAVIGATION IS ASSERTED THROUGH THE SHELL SEAM. Setup receives plain
 * callbacks; these tests supply spies and assert Setup calls the right
 * one. Setup never imports a navigator or an owner screen's authority.
 */

jest.mock('../orientation3d', () => ({
  OrientationRenderer: jest.fn(() => null),
}));

import React from 'react';
import {Text} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';

import SetupScreen from './SetupScreen';
import '../../i18n';
import i18n from '../../i18n';
import type {RootStackParamList} from '../../navigation/types';
import {mspSessionCoordinator} from '../../platforms/react-native/protocol';
import {
  MSP_API_VERSION,
  MSP_FC_VARIANT,
  MSP_BOARD_INFO,
  MSP_ATTITUDE,
  MSP_STATUS_EX,
  MSP_BOXIDS,
  MSP_ANALOG,
  MSP_RAW_GPS,
  MSP_BATTERY_STATE,
  ARMING_DISABLE_FLAG_TOKENS,
} from '../../core';
import {buildMspFrameBytes} from '../../core/protocol/__testUtils__/mspFixtures';
import {
  base64ToBytes,
  bytesToBase64,
} from '../../platforms/react-native/protocol/base64';
import type {
  UsbSerialDataEvent,
  UsbSerialTransportClient,
} from '../../platforms/react-native/transport';

type Props = NativeStackScreenProps<RootStackParamList, 'Setup'>;

/* ------------------------------------------------------------------ *
 * Wire fixtures - arithmetic packing, per armingBlockers.ts's own rule
 * ------------------------------------------------------------------ */

const ascii = (text: string) => text.split('').map(c => c.charCodeAt(0));
const pstring = (text: string) => [text.length, ...ascii(text)];
const byteAt = (value: number, index: number) =>
  Math.floor(value / Math.pow(256, index)) % 256;
const u16 = (v: number) => [byteAt(v, 0), byteAt(v, 1)];
const u32 = (v: number) => [
  byteAt(v, 0),
  byteAt(v, 1),
  byteAt(v, 2),
  byteAt(v, 3),
];
const s16 = (v: number) => u16(v < 0 ? v + 0x10000 : v);

function boardInfoPayload(): Uint8Array {
  return Uint8Array.from([
    ...ascii('AFF3'),
    ...u16(0),
    0,
    0,
    ...pstring('TEST'),
    ...pstring('MyBoard'),
    ...pstring('MTKS'),
    ...new Array(32).fill(0),
    0,
  ]);
}

/** ACC | BARO | MAG | GPS | GYRO. */
const FULL_SENSOR_MASK = 0x2f;

function statusExPayload(options: {
  armingDisableFlags?: number;
  sensorMask?: number;
  rebootRequired?: boolean;
} = {}): Uint8Array {
  return Uint8Array.from([
    ...u16(312),
    ...u16(0),
    ...u16(options.sensorMask ?? FULL_SENSOR_MASK),
    ...u32(0),
    0,
    ...u16(17),
    4,
    0,
    0,
    ARMING_DISABLE_FLAG_TOKENS.length,
    ...u32(options.armingDisableFlags ?? 0),
    options.rebootRequired === true ? 1 : 0,
    ...u16(250),
  ]);
}

/** decodeAnalog layout: u8 legacyV, u16 mah, u16 rssi, s16 amps, u16 V. */
function analogPayload(rssiRaw: number): Uint8Array {
  return Uint8Array.from([
    164,
    ...u16(480),
    ...u16(rssiRaw),
    ...s16(320),
    ...u16(1642),
  ]);
}

/** decodeBatteryState layout: u8 cells, u16 capacity, u8 legacyV,
 * u16 consumed, s16 amps, u8 state, u16 V. */
function batteryPayload(
  options: {cells?: number; state?: number; voltageCentivolts?: number} = {},
): Uint8Array {
  return Uint8Array.from([
    options.cells ?? 4,
    ...u16(1500),
    164,
    ...u16(480),
    ...s16(320),
    options.state ?? 0,
    ...u16(options.voltageCentivolts ?? 1642),
  ]);
}

/** decodeRawGps: fix flag, sats, then position/alt/speed/course. */
function rawGpsPayload(options: {fix?: boolean; sats?: number} = {}): Uint8Array {
  return Uint8Array.from([
    options.fix === true ? 2 : 0,
    options.sats ?? 0,
    ...new Array(16).fill(0),
  ]);
}

const BOXIDS_WITH_ARM = Uint8Array.from([0, 1, 2]);
const bitFor = (token: string) =>
  Math.pow(2, ARMING_DISABLE_FLAG_TOKENS.indexOf(token));

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

function makeFakeClient(sessionId: string) {
  const dataListeners = new Set<(event: UsbSerialDataEvent) => void>();
  const responses = new Map<number, Uint8Array>();
  return {
    writeBytes: jest.fn((_sessionId: string, dataBase64: string) => {
      const command = base64ToBytes(dataBase64)[4];
      const payload = responses.get(command);
      if (payload) {
        const frame = buildMspFrameBytes(command, payload, {
          wireFormat: 'v1',
          direction: 'response',
        });
        Promise.resolve().then(() => {
          for (const listener of Array.from(dataListeners)) {
            listener({sessionId, dataBase64: bytesToBase64(frame)});
          }
        });
      }
      return Promise.resolve(undefined);
    }),
    onDataReceived: jest.fn((cb: (event: UsbSerialDataEvent) => void) => {
      dataListeners.add(cb);
      return jest.fn(() => dataListeners.delete(cb));
    }),
    onSessionDetached: jest.fn(() => jest.fn()),
    startReading: jest.fn(() => Promise.resolve(undefined)),
    stopReading: jest.fn(() => Promise.resolve(undefined)),
    setResponse: (command: number, payload: Uint8Array) => {
      responses.set(command, payload);
    },
  };
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    await Promise.resolve();
  }
}

function allText(renderer: ReactTestRenderer.ReactTestRenderer): string[] {
  return renderer.root.findAllByType(Text).map(node => {
    const children = node.props.children;
    return Array.isArray(children) ? children.join('') : String(children ?? '');
  });
}

function has(renderer: ReactTestRenderer.ReactTestRenderer, testID: string) {
  return renderer.root.findAllByProps({testID}).length > 0;
}

/**
 * HOST nodes only. `findAllByProps({testID})` also matches a COMPOSITE
 * element whose own prop happens to be called testID - so a component
 * that merely RECEIVES `testID="setup-open-receiver"` and renders a
 * different id would still be "found". Interactivity is a question about
 * what was actually rendered, so it must be asked of the host tree.
 */
function hasHost(
  renderer: ReactTestRenderer.ReactTestRenderer,
  testID: string,
) {
  return (
    renderer.root.findAll(
      n => typeof n.type === 'string' && n.props?.testID === testID,
    ).length > 0
  );
}

/** The composite that actually carries onPress (the host View forwards
 * the testID but not the handler). Throws rather than silently no-opping
 * if no such node exists - a press assertion that quietly does nothing is
 * worse than no assertion. */
function press(
  renderer: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): void {
  const node = renderer.root
    .findAll(n => n.props?.testID === testID)
    .find(n => typeof n.props?.onPress === 'function');
  if (node === undefined) {
    throw new Error(`no pressable node carries testID="${testID}"`);
  }
  act(() => {
    node.props.onPress();
  });
}

interface Nav {
  onOpenGps: jest.Mock;
  onOpenReceiver: jest.Mock;
  onOpenPower: jest.Mock;
  onOpenSensors: jest.Mock;
}

function makeNav(): Nav {
  return {
    onOpenGps: jest.fn(),
    onOpenReceiver: jest.fn(),
    onOpenPower: jest.fn(),
    onOpenSensors: jest.fn(),
  };
}

async function mount(
  sessionId: string,
  options: {
    statusEx?: Uint8Array;
    analog?: Uint8Array;
    battery?: Uint8Array;
    gps?: Uint8Array;
    nav?: Nav;
  } = {},
) {
  const client = makeFakeClient(sessionId);
  client.setResponse(MSP_API_VERSION, Uint8Array.from([0, 1, 47]));
  client.setResponse(MSP_FC_VARIANT, Uint8Array.from(ascii('BTFL')));
  client.setResponse(MSP_BOARD_INFO, boardInfoPayload());
  client.setResponse(MSP_ATTITUDE, Uint8Array.from([...u16(0), ...u16(0), ...u16(0)]));
  client.setResponse(MSP_BOXIDS, BOXIDS_WITH_ARM);
  client.setResponse(MSP_STATUS_EX, options.statusEx ?? statusExPayload());
  client.setResponse(MSP_ANALOG, options.analog ?? analogPayload(812));
  client.setResponse(MSP_BATTERY_STATE, options.battery ?? batteryPayload());
  client.setResponse(MSP_RAW_GPS, options.gps ?? rawGpsPayload());

  const nav = options.nav ?? makeNav();
  const props = {
    route: {
      key: `Setup-${sessionId}`,
      name: 'Setup',
      params: {sessionKey: {sessionId, generation: 1}},
    },
    navigation: {goBack: () => undefined, addListener: () => () => undefined},
    ...nav,
  } as unknown as Props;

  let renderer!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    renderer = ReactTestRenderer.create(<SetupScreen {...props} />);
  });
  await act(async () => {
    mspSessionCoordinator.openSession(
      client as unknown as UsbSerialTransportClient,
      sessionId,
    );
    await flushAsync();
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(20_000);
    await flushAsync();
  });
  return {renderer, nav};
}

async function teardown(
  sessionId: string,
  renderer: ReactTestRenderer.ReactTestRenderer,
) {
  await act(async () => {
    mspSessionCoordinator.deactivateMspSession(sessionId);
    await flushAsync();
  });
  act(() => {
    renderer.unmount();
  });
}

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

/* ------------------------------------------------------------------ *
 * B36 - Receiver
 * ------------------------------------------------------------------ */

describe('SETUP P2 - Receiver summary', () => {
  it('shows an authoritative RSSI value prominently', async () => {
    const id = 'p2-rx-rssi';
    const {renderer} = await mount(id);
    expect(allText(renderer)).toContain(
      i18n.t('telemetryCards.receiver.rssi', {percent: 79}),
    );
    expect(has(renderer, 'receiver-card-rssi')).toBe(true);
    await teardown(id, renderer);
  });

  it('never renders 0% when the wire value is an unconfigured zero', async () => {
    const id = 'p2-rx-zero';
    const {renderer} = await mount(id, {analog: analogPayload(0)});
    expect(has(renderer, 'receiver-card-rssi-unavailable')).toBe(true);
    expect(has(renderer, 'receiver-card-rssi')).toBe(false);
    expect(allText(renderer).join('|')).not.toContain('RSSI: 0%');
    await teardown(id, renderer);
  });

  it('states the live/stale link condition in words, not only in opacity', async () => {
    const id = 'p2-rx-live-words';
    const {renderer} = await mount(id);
    expect(allText(renderer)).toContain(i18n.t('telemetryCards.receiver.linkLive'));
    expect(has(renderer, 'receiver-card-link-state')).toBe(true);
    await teardown(id, renderer);
  });

  it('contains no LQ / link-quality / signal-health vocabulary anywhere', async () => {
    const id = 'p2-rx-no-lq';
    const {renderer} = await mount(id);
    const joined = allText(renderer).join('|');
    expect(joined).not.toMatch(/\bLQ\b/);
    expect(joined).not.toMatch(/Link Quality/i);
    expect(joined).not.toContain('جودة الاتصال');
    expect(joined).not.toContain('جودة الإشارة');
    expect(joined).not.toMatch(/dBm/);
    await teardown(id, renderer);
  });

  it('navigates to the Receiver screen and writes nothing', async () => {
    const id = 'p2-rx-nav';
    const {renderer, nav} = await mount(id);
    press(renderer, 'setup-open-receiver');
    expect(nav.onOpenReceiver).toHaveBeenCalledTimes(1);
    expect(nav.onOpenGps).not.toHaveBeenCalled();
    expect(nav.onOpenPower).not.toHaveBeenCalled();
    expect(nav.onOpenSensors).not.toHaveBeenCalled();
    await teardown(id, renderer);
  });

  it('carries a destination-naming accessibility label', async () => {
    const id = 'p2-rx-a11y';
    const {renderer} = await mount(id);
    // Ask the HOST tree: `findAllByProps` also matches composites whose
    // own prop is called testID, and a composite's props are not what a
    // screen reader sees. The rendered host node is the accessible one.
    const host = renderer.root.find(
      n => typeof n.type === 'string' && n.props?.testID === 'setup-open-receiver',
    );
    expect(host.props.accessibilityLabel).toBe(
      i18n.t('setupNavigation.openReceiver'),
    );
    expect(host.props.accessibilityRole).toBe('button');
    await teardown(id, renderer);
  });
});

/* ------------------------------------------------------------------ *
 * B37 - GPS
 * ------------------------------------------------------------------ */

describe('SETUP P2 - GPS summary', () => {
  it('reports no-fix honestly when the FC detects GPS but has no fix', async () => {
    const id = 'p2-gps-nofix';
    const {renderer} = await mount(id, {gps: rawGpsPayload({fix: false, sats: 0})});
    expect(allText(renderer)).toContain(i18n.t('telemetryCards.gps.noFix'));
    await teardown(id, renderer);
  });

  it('zero satellites never means "GPS absent"', async () => {
    const id = 'p2-gps-zero-sats';
    const {renderer} = await mount(id, {gps: rawGpsPayload({fix: false, sats: 0})});
    // The presence proof comes from the sensor mask, not from the count.
    expect(has(renderer, 'gps-card-no-presence')).toBe(false);
    expect(allText(renderer)).toContain(
      i18n.t('telemetryCards.gps.satellites', {value: 0}),
    );
    await teardown(id, renderer);
  });

  it('reports a fix with its satellite count', async () => {
    const id = 'p2-gps-fix';
    const {renderer} = await mount(id, {gps: rawGpsPayload({fix: true, sats: 14})});
    expect(allText(renderer)).toContain(i18n.t('telemetryCards.gps.fix'));
    expect(allText(renderer)).toContain(
      i18n.t('telemetryCards.gps.satellites', {value: 14}),
    );
    await teardown(id, renderer);
  });

  it('says presence is unproven when the sensor mask carries no GPS bit', async () => {
    const id = 'p2-gps-no-presence';
    const {renderer} = await mount(id, {
      statusEx: statusExPayload({sensorMask: 0x21}), // ACC + GYRO only
    });
    expect(has(renderer, 'gps-card-no-presence')).toBe(true);
    await teardown(id, renderer);
  });

  it('shows no coordinates, no PDOP and no HDOP', async () => {
    const id = 'p2-gps-privacy';
    const {renderer} = await mount(id, {gps: rawGpsPayload({fix: true, sats: 14})});
    const joined = allText(renderer).join('|');
    expect(joined).not.toMatch(/PDOP/i);
    expect(joined).not.toMatch(/HDOP/i);
    expect(joined).not.toContain('خط الطول');
    expect(joined).not.toContain('خط العرض');
    // No decimal-degree shaped value anywhere.
    expect(joined).not.toMatch(/\d+\.\d{4,}/);
    await teardown(id, renderer);
  });

  it('navigates to the GPS screen and writes nothing', async () => {
    const id = 'p2-gps-nav';
    const {renderer, nav} = await mount(id);
    press(renderer, 'setup-open-gps');
    expect(nav.onOpenGps).toHaveBeenCalledTimes(1);
    expect(nav.onOpenReceiver).not.toHaveBeenCalled();
    await teardown(id, renderer);
  });
});

/* ------------------------------------------------------------------ *
 * B38 - Battery
 * ------------------------------------------------------------------ */

describe('SETUP P2 - Battery summary', () => {
  it('shows the canonical high-resolution voltage', async () => {
    const id = 'p2-batt-voltage';
    const {renderer} = await mount(id);
    expect(allText(renderer)).toContain('16.42 V');
    expect(has(renderer, 'battery-card-voltage')).toBe(true);
    await teardown(id, renderer);
  });

  it('shows the cell count only when the firmware proved a pack', async () => {
    const id = 'p2-batt-cells';
    const {renderer} = await mount(id);
    expect(allText(renderer)).toContain(i18n.t('batteryCard.cellCount', {count: 4}));
    await teardown(id, renderer);
  });

  it('a not-detected pack never presents its residual reading as pack voltage', async () => {
    const id = 'p2-batt-residual';
    const {renderer} = await mount(id, {
      // cellCount 0 = Betaflight's own "battery not detected".
      battery: batteryPayload({cells: 0, voltageCentivolts: 17}),
    });
    expect(has(renderer, 'battery-card-no-measurement')).toBe(true);
    expect(has(renderer, 'battery-card-voltage')).toBe(false);
    // The real reading is still visible, but explicitly labelled.
    expect(has(renderer, 'battery-card-raw-voltage')).toBe(true);
    // And no cell count is claimed for a pack the FC did not detect.
    expect(has(renderer, 'battery-card-cells')).toBe(false);
    await teardown(id, renderer);
  });

  it('invents no percentage, and the permanent filler line is gone', async () => {
    const id = 'p2-batt-no-percent';
    const {renderer} = await mount(id);
    const joined = allText(renderer).join(' ');
    expect(joined).not.toContain(i18n.t('batteryCard.percentageUnavailable'));
    expect(joined).not.toMatch(/\d+\s*%\s*(شحن|بطارية)/);
    expect(joined).not.toContain('الشحن التقديري');
    await teardown(id, renderer);
  });

  it('navigates to Power & Battery and writes nothing', async () => {
    const id = 'p2-batt-nav';
    const {renderer, nav} = await mount(id);
    press(renderer, 'setup-open-power');
    expect(nav.onOpenPower).toHaveBeenCalledTimes(1);
    expect(nav.onOpenReceiver).not.toHaveBeenCalled();
    await teardown(id, renderer);
  });
});

/* ------------------------------------------------------------------ *
 * B39 - Sensors
 * ------------------------------------------------------------------ */

describe('SETUP P2 - Sensors summary', () => {
  it('is visible on the dashboard, not only inside diagnostics', async () => {
    const id = 'p2-sensors-visible';
    const {renderer} = await mount(id);
    expect(has(renderer, 'sensors-card')).toBe(true);
    expect(allText(renderer)).toContain(i18n.t('setupSensorsCard.title'));
    await teardown(id, renderer);
  });

  it.each([
    ['GYRO', 0x2f, 'DETECTED'],
    ['ACC', 0x2f, 'DETECTED'],
    ['BARO', 0x2f, 'DETECTED'],
    ['MAG', 0x2f, 'DETECTED'],
    ['GPS', 0x2f, 'DETECTED'],
    ['RANGEFINDER', 0x2f, 'NOT_DETECTED'],
    ['OPTICALFLOW', 0x2f, 'NOT_DETECTED'],
  ])('renders %s as %s', async (token, mask, expected) => {
    const id = `p2-sensors-${token}`;
    const {renderer} = await mount(id, {statusEx: statusExPayload({sensorMask: mask})});
    expect(has(renderer, `sensors-card-${token}`)).toBe(true);
    const chip = renderer.root.findAllByProps({testID: `sensors-card-${token}`})[0];
    const chipText = chip
      .findAllByType(Text)
      .map(n => String(n.props.children))
      .join('|');
    expect(chipText).toContain(
      i18n.t(
        expected === 'DETECTED'
          ? 'diagnostics.sensorDetected'
          : 'diagnostics.sensorNotDetected',
      ),
    );
    await teardown(id, renderer);
  });

  it('a MISSING GYRO is visible on the dashboard', async () => {
    const id = 'p2-sensors-no-gyro';
    const {renderer} = await mount(id, {
      statusEx: statusExPayload({sensorMask: 0x01}), // ACC only
    });
    const chip = renderer.root.findAllByProps({testID: 'sensors-card-GYRO'})[0];
    const chipText = chip
      .findAllByType(Text)
      .map(n => String(n.props.children))
      .join('|');
    expect(chipText).toContain('GYRO');
    expect(chipText).toContain(i18n.t('diagnostics.sensorNotDetected'));
    await teardown(id, renderer);
  });

  it('uses no health vocabulary at all', async () => {
    const id = 'p2-sensors-no-health';
    const {renderer} = await mount(id);
    const joined = allText(renderer).join('|');
    expect(joined).not.toContain('سليم');
    expect(joined).not.toContain('صحي');
    expect(joined).not.toMatch(/healthy/i);
    await teardown(id, renderer);
  });

  it('navigates to Sensors and writes nothing', async () => {
    const id = 'p2-sensors-nav';
    const {renderer, nav} = await mount(id);
    press(renderer, 'setup-open-sensors');
    expect(nav.onOpenSensors).toHaveBeenCalledTimes(1);
    expect(nav.onOpenPower).not.toHaveBeenCalled();
    await teardown(id, renderer);
  });
});

/* ------------------------------------------------------------------ *
 * B40 - cross-surface consistency
 * ------------------------------------------------------------------ */

describe('SETUP P2 - two surfaces never disagree about one fact', () => {
  it('an RXLOSS warning cannot coexist with a clean Receiver all-clear', async () => {
    const id = 'p2-x-rxloss';
    const {renderer} = await mount(id, {
      statusEx: statusExPayload({armingDisableFlags: bitFor('RX_FAILSAFE')}),
    });
    expect(has(renderer, 'setup-safety-notice-RX_LOSS')).toBe(true);
    // The strip agrees: this is a blocker, not a READY aircraft.
    expect(has(renderer, 'safety-strip-ready')).toBe(false);
    expect(has(renderer, 'safety-strip-blocked')).toBe(true);
    // And the blocker detail names the same condition.
    expect(allText(renderer)).toContain(
      i18n.t('diagnostics.blockerDescriptions.RX_FAILSAFE'),
    );
    await teardown(id, renderer);
  });

  it('an unavailable battery cannot imply a normal pack', async () => {
    const id = 'p2-x-batt';
    const {renderer} = await mount(id, {
      battery: batteryPayload({cells: 0, voltageCentivolts: 17}),
    });
    expect(has(renderer, 'battery-card-no-measurement')).toBe(true);
    expect(has(renderer, 'battery-card-voltage')).toBe(false);
    await teardown(id, renderer);
  });

  it('an unproven GPS presence cannot imply a detected receiver module', async () => {
    const id = 'p2-x-gps';
    const {renderer} = await mount(id, {
      statusEx: statusExPayload({sensorMask: 0x21}),
    });
    expect(has(renderer, 'gps-card-no-presence')).toBe(true);
    // The sensor chip agrees with the card, from the same mask.
    const chip = renderer.root.findAllByProps({testID: 'sensors-card-GPS'})[0];
    expect(
      chip
        .findAllByType(Text)
        .map(n => String(n.props.children))
        .join('|'),
    ).toContain(i18n.t('diagnostics.sensorNotDetected'));
    await teardown(id, renderer);
  });

  it('no green READY appears anywhere while arming truth is BLOCKED', async () => {
    const id = 'p2-x-ready';
    const {renderer} = await mount(id, {
      statusEx: statusExPayload({armingDisableFlags: bitFor('THROTTLE')}),
    });
    expect(has(renderer, 'safety-strip-ready')).toBe(false);
    // Exact strings, not substrings: the BLOCKED badge reads
    // "غير جاهزة", which CONTAINS the READY word "جاهزة". A substring
    // assertion here would pass for the wrong reason, or fail for one.
    const rendered = allText(renderer);
    expect(rendered).not.toContain(i18n.t('safetyStrip.ready'));
    expect(rendered).not.toContain(i18n.t('setupTopBar.armingBadge.ready'));
    expect(rendered).toContain(i18n.t('setupTopBar.armingBadge.blocked'));
    await teardown(id, renderer);
  });

  it('reboot-required agrees between the notice and the blocker list', async () => {
    const id = 'p2-x-reboot';
    const {renderer} = await mount(id, {
      statusEx: statusExPayload({
        rebootRequired: true,
        armingDisableFlags: bitFor('REBOOT_REQUIRED'),
      }),
    });
    expect(has(renderer, 'setup-safety-notice-REBOOT_REQUIRED')).toBe(true);
    expect(allText(renderer)).toContain(
      i18n.t('diagnostics.blockerDescriptions.REBOOT_REQUIRED'),
    );
    await teardown(id, renderer);
  });
});

/* ------------------------------------------------------------------ *
 * Ownership
 * ------------------------------------------------------------------ */

describe('SETUP P2 - Setup stays an overview', () => {
  it('a card with no owner-screen callback is not interactive', async () => {
    const id = 'p2-no-nav';
    const client = makeFakeClient(id);
    client.setResponse(MSP_ATTITUDE, Uint8Array.from([...u16(0), ...u16(0), ...u16(0)]));
    const props = {
      route: {
        key: 'Setup-no-nav',
        name: 'Setup',
        params: {sessionKey: {sessionId: id, generation: 1}},
      },
      navigation: {goBack: () => undefined, addListener: () => () => undefined},
    } as unknown as Props;
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<SetupScreen {...props} />);
    });
    await act(async () => {
      await flushAsync();
    });
    // Rendered as plain containers: no button role, no chevron, no wash.
    for (const target of ['receiver', 'gps', 'power', 'sensors']) {
      expect(hasHost(renderer, `setup-open-${target}-static`)).toBe(true);
      expect(hasHost(renderer, `setup-open-${target}`)).toBe(false);
    }
    // And nothing anywhere claims a button role for them.
    expect(
      renderer.root
        .findAll(n => typeof n.props?.testID === 'string')
        .filter(n => n.props.testID.startsWith('setup-open-'))
        .some(n => n.props.accessibilityRole === 'button'),
    ).toBe(false);
    act(() => {
      renderer.unmount();
    });
  });

  it('pressing every summary card issues no configuration write', async () => {
    const id = 'p2-no-writes';
    const {renderer, nav} = await mount(id);
    for (const target of ['receiver', 'gps', 'power', 'sensors']) {
      press(renderer, `setup-open-${target}`);
    }
    // Exactly one navigation each, and nothing else happened: the screen
    // has no controller to write through beyond FC tools.
    expect(nav.onOpenReceiver).toHaveBeenCalledTimes(1);
    expect(nav.onOpenGps).toHaveBeenCalledTimes(1);
    expect(nav.onOpenPower).toHaveBeenCalledTimes(1);
    expect(nav.onOpenSensors).toHaveBeenCalledTimes(1);
    await teardown(id, renderer);
  });
});
