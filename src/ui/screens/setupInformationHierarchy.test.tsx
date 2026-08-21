// SetupScreen pulls in the transport client whose TurboModule must be
// mocked under Jest - the exact mock every other Setup suite uses.
jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

/**
 * SETUP R9 - THE INFORMATION-HIERARCHY REGRESSION SUITE.
 *
 * =====================================================================
 * WHAT THIS FILE IS FOR
 * =====================================================================
 *
 * The round that produced it asked for a specific set of guarantees,
 * each stated as "a test that fails if X comes back". Those are the
 * describe blocks below, one per guarantee:
 *
 *   1. the 139px TopSystemBar cannot return as Setup's chrome
 *   2. detected sensors and the battery precede the 3D model
 *   3. no Battery/Sensors section is duplicated after the 3D
 *   4. heading / pitch / roll come from telemetry, never from a constant
 *   5. the sensor chips follow the flight controller's real presence mask
 *   6. an unproven sensor never shows a misleading status
 *   7. the layout answers the four measured widths without a fixed width
 *      that could overflow the narrowest of them
 *
 * WHAT IS REAL HERE. The real coordinator, MspClient, framing, scheduler
 * and tick driver, the real identification handshake, the real BOXIDS
 * acquisition and the real Setup component tree. Only the USB transport
 * is faked, with frames built by the same MSP frame builder the client's
 * own tests use. No component is mocked except the Skia renderer, which
 * cannot mount under Jest at all.
 *
 * THE ONE THING THIS SUITE CANNOT DO is measure pixels: react-test-
 * renderer has no layout engine. Sections 1 and 7 therefore assert the
 * STRUCTURE that produces the geometry (declared heights, responsive
 * column rules, absence of fixed widths), and the pixel evidence is
 * captured separately in Chromium at 390 / 768 / 1366 / 1920.
 */

jest.mock('../orientation3d', () => ({
  OrientationRenderer: jest.fn(() => null),
}));

import * as fs from 'fs';
import * as path from 'path';

import React from 'react';
import {Text} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';

import SetupScreen from './SetupScreen';
import {resolveSetupInfoColumns} from '../components/setup';
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
  SETUP_SENSOR_TOKENS,
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
const u32 = (v: number) => [byteAt(v, 0), byteAt(v, 1), byteAt(v, 2), byteAt(v, 3)];
const s16 = (v: number) => u16(v < 0 ? v + 0x10000 : v);

/** ACC | BARO | MAG | GPS | GYRO - a fully equipped board. */
const FULL_SENSOR_MASK = 0x2f;
/** ACC | GYRO - the minimal board: no BARO, no MAG, no GPS. */
const MINIMAL_SENSOR_MASK = 0x21;

const boardInfoPayload = (): Uint8Array =>
  Uint8Array.from([
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

const statusExPayload = (sensorMask: number): Uint8Array =>
  Uint8Array.from([
    ...u16(312),
    ...u16(0),
    ...u16(sensorMask),
    ...u32(0),
    0,
    ...u16(17),
    4,
    0,
    0,
    ARMING_DISABLE_FLAG_TOKENS.length,
    ...u32(0),
    0,
    ...u16(250),
  ]);

const analogPayload = (): Uint8Array =>
  Uint8Array.from([164, ...u16(480), ...u16(812), ...s16(320), ...u16(1642)]);

const batteryPayload = (): Uint8Array =>
  Uint8Array.from([4, ...u16(1500), 164, ...u16(480), ...s16(320), 0, ...u16(1642)]);

const rawGpsPayload = (): Uint8Array =>
  Uint8Array.from([2, 13, ...new Array(16).fill(0)]);

/** MSP_ATTITUDE: roll and pitch in decidegrees, heading in whole degrees. */
const attitudePayload = (
  rollDecideg: number,
  pitchDecideg: number,
  headingDeg: number,
): Uint8Array =>
  Uint8Array.from([...s16(rollDecideg), ...s16(pitchDecideg), ...u16(headingDeg)]);

const BOXIDS_WITH_ARM = Uint8Array.from([0, 1, 2]);

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
    onDeviceDetached: jest.fn(() => jest.fn()),
    onError: jest.fn(() => jest.fn()),
    startReading: jest.fn(() => Promise.resolve(undefined)),
    stopReading: jest.fn(() => Promise.resolve(undefined)),
    closeSession: jest.fn(() => Promise.resolve(undefined)),
    setResponse: (command: number, payload: Uint8Array) => {
      responses.set(command, payload);
    },
  };
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 60; index += 1) {
    await Promise.resolve();
  }
}

async function mount(
  sessionId: string,
  options: {sensorMask?: number; attitude?: Uint8Array} = {},
) {
  const client = makeFakeClient(sessionId);
  client.setResponse(MSP_API_VERSION, Uint8Array.from([0, 1, 47]));
  client.setResponse(MSP_FC_VARIANT, Uint8Array.from(ascii('BTFL')));
  client.setResponse(MSP_BOARD_INFO, boardInfoPayload());
  client.setResponse(
    MSP_ATTITUDE,
    options.attitude ?? attitudePayload(0, 0, 0),
  );
  client.setResponse(MSP_BOXIDS, BOXIDS_WITH_ARM);
  client.setResponse(
    MSP_STATUS_EX,
    statusExPayload(options.sensorMask ?? FULL_SENSOR_MASK),
  );
  client.setResponse(MSP_ANALOG, analogPayload());
  client.setResponse(MSP_BATTERY_STATE, batteryPayload());
  client.setResponse(MSP_RAW_GPS, rawGpsPayload());

  const props = {
    route: {
      key: `Setup-${sessionId}`,
      name: 'Setup',
      params: {sessionKey: {sessionId, generation: 1}},
    },
    navigation: {goBack: () => undefined, addListener: () => () => undefined},
    onOpenGps: () => undefined,
    onOpenReceiver: () => undefined,
    onOpenPower: () => undefined,
    onOpenSensors: () => undefined,
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
    await jest.advanceTimersByTimeAsync(2200);
    await flushAsync();
  });
  return {client, renderer};
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

/** Every rendered HOST node's testID, in tree (reading) order. */
function hostOrder(renderer: ReactTestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll(n => typeof n.type === 'string' && typeof n.props?.testID === 'string')
    .map(n => n.props.testID as string);
}

function indexOfId(order: readonly string[], testID: string): number {
  return order.indexOf(testID);
}

function labelOf(
  renderer: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): string {
  const node = renderer.root.findAll(
    n => typeof n.type === 'string' && n.props?.testID === testID,
  )[0];
  return node === undefined ? '' : String(node.props.accessibilityLabel ?? '');
}

function textIn(
  renderer: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): string {
  const node = renderer.root.findAll(
    n => typeof n.type === 'string' && n.props?.testID === testID,
  )[0];
  if (node === undefined) {
    return '';
  }
  return node
    .findAllByType(Text)
    .map(child =>
      Array.isArray(child.props.children)
        ? child.props.children.join('')
        : String(child.props.children ?? ''),
    )
    .join('|');
}

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(async () => {
  await flushAsync();
  jest.clearAllTimers();
  jest.useRealTimers();
  await flushAsync();
});

/* ================================================================== *
 * 1. THE BLOATED TOP BAR CANNOT COME BACK
 * ================================================================== */

describe('the 139px system bar cannot return as Setup chrome', () => {
  const SETUP_DIR = path.join(__dirname, '..', 'components', 'setup');

  it('renders none of its parts', async () => {
    const sessionId = 'r9-no-top-bar';
    const {renderer} = await mount(sessionId);
    /* The bar's own testIDs, exactly as it published them. Any of them
       reappearing means the bar - or something wearing its identity -
       is back. */
    for (const gone of [
      'setup-top-bar',
      'setup-top-bar-back',
      'setup-top-bar-connection-indicator',
      'setup-top-bar-disconnect',
      'setup-top-bar-board-name',
      'setup-top-bar-firmware',
      'setup-top-bar-arming-badge',
      'setup-top-bar-notice',
    ]) {
      expect({gone, rendered: hostOrder(renderer).includes(gone)}).toEqual({
        gone,
        rendered: false,
      });
    }
    await teardown(sessionId, renderer);
  });

  it('has no source file, hidden copy, or compatibility wrapper left', () => {
    /* "Deleted" has to mean deleted. A file kept around unreferenced is
       one import away from returning, and a re-export in the barrel is
       an invitation. */
    expect(fs.existsSync(path.join(SETUP_DIR, 'TopSystemBar.tsx'))).toBe(false);
    expect(fs.existsSync(path.join(SETUP_DIR, 'TopSystemBar.test.tsx'))).toBe(
      false,
    );
    const barrel = fs.readFileSync(path.join(SETUP_DIR, 'index.ts'), 'utf8');
    expect(barrel).not.toMatch(/from '\.\/TopSystemBar'/);

    // And nothing anywhere in src still imports it.
    const walk = (dir: string, hits: string[]): string[] => {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') walk(full, hits);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        // Test files legitimately NAME the deleted module in order to
        // assert its absence - this one included. Only production
        // imports are evidence that it is reachable again.
        if (/\.test\.tsx?$/.test(entry.name)) continue;
        if (/from '.*TopSystemBar'/.test(fs.readFileSync(full, 'utf8'))) {
          hits.push(path.relative(SETUP_DIR, full));
        }
      }
      return hits;
    };
    expect(walk(path.join(__dirname, '..', '..'), [])).toEqual([]);
  });

  it('replaces it with fixed chrome that declares a small height', () => {
    /* THE NUMBER THIS ROUND WAS GIVEN: the old bar measured 139px at
       1920, 1366 and 390 alike. The replacement declares its height
       outright, so the ceiling is readable in the source rather than
       being an emergent property of its padding. */
    const chrome = fs.readFileSync(
      path.join(SETUP_DIR, 'SetupChromeBar.tsx'),
      'utf8',
    );
    const height = /height:\s*(\d+)/.exec(chrome);
    expect(height).not.toBeNull();
    expect(Number(height?.[1])).toBeLessThan(139);
    expect(Number(height?.[1])).toBeLessThanOrEqual(56);
  });
});

/* ================================================================== *
 * 2. SENSORS AND BATTERY COME BEFORE THE MODEL
 * ================================================================== */

describe('the critical status precedes the 3D model in reading order', () => {
  it('places the battery and every sensor chip before the hero', async () => {
    const sessionId = 'r9-order-before-hero';
    const {renderer} = await mount(sessionId);
    const order = hostOrder(renderer);

    const hero = indexOfId(order, 'orientation-hero');
    expect(hero).toBeGreaterThan(-1);

    const battery = indexOfId(order, 'setup-status-battery-live');
    expect(battery).toBeGreaterThan(-1);
    expect(battery).toBeLessThan(hero);

    for (const token of SETUP_SENSOR_TOKENS) {
      const chip = indexOfId(order, `setup-status-sensor-${token}`);
      expect({token, found: chip > -1, beforeHero: chip > -1 && chip < hero}).toEqual(
        {token, found: true, beforeHero: true},
      );
    }

    // The connection, the board and the firmware are up there too.
    for (const id of [
      'setup-status-connection',
      'setup-status-board',
      'setup-status-firmware',
      'setup-status-api',
      'setup-status-arming',
    ]) {
      expect({id, beforeHero: indexOfId(order, id) < hero}).toEqual({
        id,
        beforeHero: true,
      });
    }

    await teardown(sessionId, renderer);
  });

  it('places the dense information grid immediately after the hero, before every advanced surface', async () => {
    const sessionId = 'r9-order-after-hero';
    const {renderer} = await mount(sessionId);
    const order = hostOrder(renderer);
    const hero = indexOfId(order, 'orientation-hero');
    const grid = indexOfId(order, 'setup-info-grid');

    expect(grid).toBeGreaterThan(hero);
    for (const advanced of [
      'board-alignment-card',
      'orientation-stability-panel',
      'diagnostics-section',
      'fc-tools-section',
    ]) {
      const at = indexOfId(order, advanced);
      expect({advanced, found: at > -1, afterGrid: at > grid}).toEqual({
        advanced,
        found: true,
        afterGrid: true,
      });
    }

    await teardown(sessionId, renderer);
  });
});

/* ================================================================== *
 * 3. NOTHING IS REPORTED TWICE
 * ================================================================== */

describe('no battery or sensor section is duplicated after the 3D', () => {
  it('renders exactly one battery chip and one set of sensor chips, all above the model', async () => {
    const sessionId = 'r9-no-duplicates';
    const {renderer} = await mount(sessionId);
    const order = hostOrder(renderer);
    const hero = indexOfId(order, 'orientation-hero');

    const batteryChips = order.filter(id => id.startsWith('setup-status-battery'));
    expect(batteryChips).toHaveLength(1);

    const sensorChips = order.filter(id => id.startsWith('setup-status-sensor-'));
    expect(sensorChips).toHaveLength(SETUP_SENSOR_TOKENS.length);
    expect(new Set(sensorChips).size).toBe(SETUP_SENSOR_TOKENS.length);
    for (const [index, id] of order.entries()) {
      if (id.startsWith('setup-status-sensor-') || id.startsWith('setup-status-battery')) {
        expect({id, aboveHero: index < hero}).toEqual({id, aboveHero: true});
      }
    }

    /* And the cards that used to carry them below the model are not
       rendering anywhere at all. */
    for (const legacy of [
      'battery-card',
      'sensors-card',
      'receiver-card',
      'gps-card',
      'fc-card',
    ]) {
      expect({
        legacy,
        rendered: order.some(id => id.startsWith(legacy)),
      }).toEqual({legacy, rendered: false});
    }

    await teardown(sessionId, renderer);
  });

  /**
   * The ONE deliberate second appearance, stated so it cannot be
   * mistaken for the duplication this suite forbids: the diagnostics
   * disclosure at the foot of the screen lists the same sensor mask in
   * full detail. That is the DETAIL VIEW of the chips, collapsed by
   * default, and it renders the same derivation - so the two can never
   * disagree. It is not a second summary.
   */
  it('keeps the diagnostics sensor list as the detail view, from the same derivation', async () => {
    const sessionId = 'r9-detail-view';
    const {renderer} = await mount(sessionId);
    const order = hostOrder(renderer);
    expect(order).toContain('diagnostics-sensors');
    expect(indexOfId(order, 'diagnostics-sensors')).toBeGreaterThan(
      indexOfId(order, 'setup-info-grid'),
    );
    // Same verdict for the same bit, on both surfaces.
    expect(textIn(renderer, 'setup-status-sensor-GYRO')).toContain(
      i18n.t('diagnostics.sensorDetected'),
    );
    expect(textIn(renderer, 'diagnostics-sensors')).toContain(
      i18n.t('diagnostics.sensorDetected'),
    );
    await teardown(sessionId, renderer);
  });
});

/* ================================================================== *
 * 4. HEADING / PITCH / ROLL ARE TELEMETRY
 * ================================================================== */

describe('heading, pitch and roll come from the flight controller', () => {
  /**
   * THE FAILURE MODE THIS CATCHES. A hero that renders `0°` for a board
   * that has said nothing looks identical to a hero rendering a genuine
   * level attitude. So the same screen is driven three times, with three
   * different MSP_ATTITUDE payloads, and every readout has to move.
   */
  /**
   * PITCH IS NEGATED EXACTLY ONCE, in orientationViewModel.toViewDegrees,
   * and the expectations below carry that convention rather than
   * papering over it: MSP raw pitch is positive = physical nose DOWN,
   * while presentation pitch - renderer, numeric readout and
   * accessibility alike - is positive = physical nose UP. So a wire
   * pitch of +75 decidegrees reads -7.5° here, and that is correct.
   *
   * The assertions are EXACT text, not substrings: `toContain('7.5°')`
   * would happily accept '-7.5°', which is the sign error this
   * convention makes easy to introduce.
   */
  it.each([
    ['nose up, rolled left', attitudePayload(-42, 75, 287), '-4.2°', '-7.5°', '287°'],
    ['nose down, rolled right', attitudePayload(155, -230, 12), '15.5°', '23°', '12°'],
    ['level, heading south', attitudePayload(0, 0, 180), '0°', '0°', '180°'],
  ])(
    'renders %s exactly as the wire reported it',
    async (_name, attitude, roll, pitch, heading) => {
      const sessionId = `r9-attitude-${heading}`;
      const {renderer} = await mount(sessionId, {attitude});
      expect(textIn(renderer, 'orientation-hero-roll')).toBe(
        `${i18n.t('orientationHero.rollLabel')}|${roll}`,
      );
      expect(textIn(renderer, 'orientation-hero-pitch')).toBe(
        `${i18n.t('orientationHero.pitchLabel')}|${pitch}`,
      );
      expect(textIn(renderer, 'orientation-hero-heading')).toBe(
        `${i18n.t('orientationHero.headingLabel')}|${heading}`,
      );
      await teardown(sessionId, renderer);
    },
  );

  it('shows no attitude at all before a sample arrives - not a zero pose', async () => {
    /* Mounted with NO session behind it: the readouts must be absent
       rather than reading 0° / 0° / 0°, which an operator would take
       for a level aircraft. */
    const props = {
      route: {
        key: 'Setup-r9-no-sample',
        name: 'Setup',
        params: {sessionKey: {sessionId: 'r9-no-sample', generation: 1}},
      },
      navigation: {goBack: () => undefined, addListener: () => () => undefined},
    } as unknown as Props;
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<SetupScreen {...props} />);
    });
    const order = hostOrder(renderer);
    expect(order).toContain('orientation-hero-waiting');
    expect(order).not.toContain('orientation-hero-readouts');
    expect(order).not.toContain('orientation-hero-roll');
    act(() => {
      renderer.unmount();
    });
  });

  it('hardcodes no attitude anywhere in the hero', () => {
    /* A structural backstop for the behavioural checks above: the only
       degree-formatting in this component runs through the shared
       formatters, applied to `displayed`, which exists only when a
       genuine sample does. */
    const hero = fs.readFileSync(
      path.join(__dirname, '..', 'components', 'setup', 'OrientationHero.tsx'),
      'utf8',
    );
    expect(hero).toContain('formatTiltDegrees(displayed.rollDeg)');
    expect(hero).toContain('formatTiltDegrees(displayed.pitchDeg)');
    expect(hero).toContain('roundHeadingDegrees(\n            displayed.yawDeg,\n          )');
    // No literal degree value is ever emitted.
    expect(hero).not.toMatch(/['"`]\d+(\.\d+)?°['"`]/);
  });
});

/* ================================================================== *
 * 5-6. THE CHIPS FOLLOW THE MASK, AND NEVER MISLEAD
 * ================================================================== */

describe('the sensor chips follow the flight controller own presence mask', () => {
  const DETECTED = i18n.t('diagnostics.sensorDetected');
  const NOT_DETECTED = i18n.t('diagnostics.sensorNotDetected');
  const UNKNOWN = i18n.t('diagnostics.sensorUnknown');

  it('a fully equipped board reports its five sensors detected and the two it lacks as not detected', async () => {
    const sessionId = 'r9-mask-full';
    const {renderer} = await mount(sessionId, {sensorMask: FULL_SENSOR_MASK});
    for (const token of ['GYRO', 'ACC', 'BARO', 'MAG', 'GPS']) {
      expect({token, text: textIn(renderer, `setup-status-sensor-${token}`)}).toEqual(
        {token, text: `${token}|${DETECTED}`},
      );
    }
    /* RANGEFINDER and OPTICALFLOW are absent from this mask, and the
       chips say so rather than being hidden: a sensor that is not there
       is information an operator needs. */
    for (const token of ['RANGEFINDER', 'OPTICALFLOW']) {
      expect({token, text: textIn(renderer, `setup-status-sensor-${token}`)}).toEqual(
        {token, text: `${token}|${NOT_DETECTED}`},
      );
    }
    await teardown(sessionId, renderer);
  });

  it('a minimal board shows BARO, MAG and GPS as NOT DETECTED - never as detected, never blank', async () => {
    const sessionId = 'r9-mask-minimal';
    const {renderer} = await mount(sessionId, {sensorMask: MINIMAL_SENSOR_MASK});
    for (const token of ['GYRO', 'ACC']) {
      expect({token, text: textIn(renderer, `setup-status-sensor-${token}`)}).toEqual(
        {token, text: `${token}|${DETECTED}`},
      );
    }
    for (const token of ['BARO', 'MAG', 'GPS']) {
      expect({token, text: textIn(renderer, `setup-status-sensor-${token}`)}).toEqual(
        {token, text: `${token}|${NOT_DETECTED}`},
      );
    }
    await teardown(sessionId, renderer);
  });

  /**
   * THE ONE A MISREADING WOULD KILL SOMEBODY OVER. A missing gyro is the
   * single most consequential thing a flight controller can report about
   * itself, and it used to live three screens down behind a disclosure.
   */
  it('a board with no gyro says so, at the top, before the model', async () => {
    const sessionId = 'r9-mask-no-gyro';
    const {renderer} = await mount(sessionId, {sensorMask: 0x01}); // ACC only
    expect(textIn(renderer, 'setup-status-sensor-GYRO')).toBe(
      `GYRO|${NOT_DETECTED}`,
    );
    const order = hostOrder(renderer);
    expect(indexOfId(order, 'setup-status-sensor-GYRO')).toBeLessThan(
      indexOfId(order, 'orientation-hero'),
    );
    await teardown(sessionId, renderer);
  });

  /**
   * UNAVAILABLE IS NOT NOT-DETECTED. With no STATUS_EX reading at all,
   * nothing about the hardware is proven either way, and saying "not
   * detected" would be a claim the application cannot support. The
   * summary returns UNKNOWN for every entry and the chips say so.
   */
  it('says UNKNOWN, never NOT DETECTED, when no reading proves anything', () => {
    const props = {
      route: {
        key: 'Setup-r9-unconfirmed',
        name: 'Setup',
        params: {sessionKey: {sessionId: 'r9-unconfirmed', generation: 1}},
      },
      navigation: {goBack: () => undefined, addListener: () => () => undefined},
    } as unknown as Props;
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<SetupScreen {...props} />);
    });
    for (const token of SETUP_SENSOR_TOKENS) {
      expect({token, text: textIn(renderer, `setup-status-sensor-${token}`)}).toEqual(
        {token, text: `${token}|${UNKNOWN}`},
      );
    }
    expect(UNKNOWN).not.toBe(NOT_DETECTED);
    act(() => {
      renderer.unmount();
    });
  });

  it('never states a sensor by colour alone', async () => {
    const sessionId = 'r9-mask-colour';
    const {renderer} = await mount(sessionId, {sensorMask: MINIMAL_SENSOR_MASK});
    /* Each chip carries its state as TEXT beside the token, so the
       distinction survives a monochrome screen and a screen reader. The
       accessibility label restates the same pair. */
    for (const token of SETUP_SENSOR_TOKENS) {
      const label = labelOf(renderer, `setup-status-sensor-${token}`);
      expect({token, hasToken: label.includes(token)}).toEqual({
        token,
        hasToken: true,
      });
      expect({
        token,
        hasState: [DETECTED, NOT_DETECTED, UNKNOWN].some(state =>
          label.includes(state),
        ),
      }).toEqual({token, hasState: true});
    }
    await teardown(sessionId, renderer);
  });
});

/* ================================================================== *
 * 7. THE GEOMETRY CONTRACT
 * ================================================================== */

describe('the layout answers the four measured widths', () => {
  /**
   * react-test-renderer has no layout engine, so this asserts the RULES
   * that produce the geometry. The pixel evidence - no horizontal
   * scroll, no overlap, no clipping - is captured in Chromium at
   * 390 / 768 / 1366 / 1920 and reported alongside this suite.
   */
  it('resolves a sensible column count at every measured width', () => {
    expect(resolveSetupInfoColumns(390, 1)).toBe(1);
    expect(resolveSetupInfoColumns(768, 1)).toBe(2);
    expect(resolveSetupInfoColumns(1366, 1)).toBe(3);
    expect(resolveSetupInfoColumns(1920, 1)).toBe(3);
    // fontScale normalisation: 1200px at 200% text has a phone's worth of
    // effective room and must not be given three columns.
    expect(resolveSetupInfoColumns(1200, 2)).toBe(2);
    // Degenerate inputs fall back to the safest answer rather than NaN.
    expect(resolveSetupInfoColumns(Number.NaN, 1)).toBe(1);
    expect(resolveSetupInfoColumns(1920, 0)).toBe(3);
  });

  it('gives the three columns a basis that leaves room for the gaps between them', () => {
    /* An exact 33.333% basis plus a real gap overflows the row and wraps
       the third column onto its own line - which is how a "three column"
       grid silently becomes two columns and a widow. */
    const grid = fs.readFileSync(
      path.join(__dirname, '..', 'components', 'setup', 'SetupInfoGrid.tsx'),
      'utf8',
    );
    const third = /columnThird:\s*\{flexBasis:\s*'(\d+)%'\}/.exec(grid);
    const half = /columnHalf:\s*\{flexBasis:\s*'(\d+)%'\}/.exec(grid);
    expect(third).not.toBeNull();
    expect(half).not.toBeNull();
    expect(Number(third?.[1]) * 3).toBeLessThan(100);
    expect(Number(half?.[1]) * 2).toBeLessThan(100);
  });

  it('declares no fixed width that could overflow the narrowest viewport', () => {
    /* 390 minus the screen's own horizontal margins is the budget. A
       fixed pixel width above it cannot shrink and forces a horizontal
       scrollbar - the exact defect the geometry sweep looks for. */
    const NARROWEST_CONTENT_WIDTH = 390 - 2 * 12;
    for (const file of ['SetupStatusBar.tsx', 'SetupInfoGrid.tsx', 'SetupChromeBar.tsx']) {
      const source = fs.readFileSync(
        path.join(__dirname, '..', 'components', 'setup', file),
        'utf8',
      );
      const widths = [...source.matchAll(/\bwidth:\s*(\d+)\b/g)].map(m =>
        Number(m[1]),
      );
      const tooWide = widths.filter(width => width > NARROWEST_CONTENT_WIDTH);
      expect({file, tooWide}).toEqual({file, tooWide: []});
    }
  });

  it('never lets a chip or a row push the page sideways', async () => {
    const sessionId = 'r9-geometry-shrink';
    const {renderer} = await mount(sessionId);
    /* Every wrapping container declares flexWrap, and every chip that
       could hold a long board name declares flexShrink - so the content
       reflows instead of extending the row. */
    const statusBar = fs.readFileSync(
      path.join(__dirname, '..', 'components', 'setup', 'SetupStatusBar.tsx'),
      'utf8',
    );
    expect(statusBar).toMatch(/chip:\s*\{[\s\S]{0,400}flexShrink:\s*1/);
    expect(statusBar).toMatch(/chipValue:\s*\{[\s\S]{0,200}flexShrink:\s*1/);
    // And the screen has exactly one scroller, which is vertical.
    const scrollers = renderer.root.findAll(
      n => typeof n.type === 'string' && n.props?.horizontal === true,
    );
    expect(scrollers).toEqual([]);
    await teardown(sessionId, renderer);
  });
});
