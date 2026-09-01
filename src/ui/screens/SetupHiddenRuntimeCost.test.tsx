// ENTRY CLEANUP: SetupScreen now hosts the USB connection workspace
// (UsbConnectionScreen) for its disconnected state, so importing it pulls
// in the transport client whose TurboModule must be mocked under Jest -
// the exact mock App.test.tsx has always used.
jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

/**
 * SETUP P3 - what the hidden Setup tab actually costs, counted on the wire.
 *
 * This suite does not assert that a lease was taken. It counts the
 * MSP_ATTITUDE request bytes the transport is asked to write, with the
 * REAL coordinator, the REAL scheduler, the REAL tick driver and the
 * REAL single-flight MSP client in the loop - because "we acquired a
 * suppression lease" and "the flight controller stopped being asked 20
 * times a second" are different claims, and only the second one is the
 * defect P0 measured.
 *
 * MainTabsScreen keeps every opened tab MOUNTED behind display:'none'
 * (deliberately - see that file's header on the Motors stop-bridge), and
 * passes `active` to each screen. So `active: false` here is exactly what
 * a real backgrounded Setup tab looks like: still mounted, still
 * subscribed, simply not on screen.
 *
 * THE THREE THINGS THAT MUST ALL HOLD:
 *   1. hidden Setup issues NO attitude requests;
 *   2. the OTHER telemetry keeps flowing - this is a targeted suppression,
 *      not a pause of the session;
 *   3. becoming visible again resumes it, on the same registered poll -
 *      no re-registration, no new poll id, no second timer.
 */

jest.mock('../orientation3d', () => ({
  OrientationRenderer: jest.fn(() => null),
}));

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';

import SetupScreen from './SetupScreen';
import '../../i18n';
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

/* ---------------------------- fixtures ---------------------------- */

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

const FULL_SENSOR_MASK = 0x2f;

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

function statusExPayload(): Uint8Array {
  return Uint8Array.from([
    ...u16(312),
    ...u16(0),
    ...u16(FULL_SENSOR_MASK),
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
}

function analogPayload(): Uint8Array {
  return Uint8Array.from([164, ...u16(480), ...u16(812), ...s16(320), ...u16(1642)]);
}

function batteryPayload(): Uint8Array {
  return Uint8Array.from([
    4,
    ...u16(1500),
    164,
    ...u16(480),
    ...s16(320),
    0,
    ...u16(1642),
  ]);
}

function rawGpsPayload(): Uint8Array {
  return Uint8Array.from([0, 0, ...new Array(16).fill(0)]);
}

/* ---------------------------- harness ----------------------------- */

/** Counts every request the transport is actually asked to write, keyed
 * by MSP command. This is the measurement the whole suite rests on. */
function makeCountingClient(sessionId: string) {
  const dataListeners = new Set<(event: UsbSerialDataEvent) => void>();
  const responses = new Map<number, Uint8Array>();
  const sent = new Map<number, number>();
  return {
    sent,
    countOf: (command: number) => sent.get(command) ?? 0,
    resetCounts: () => sent.clear(),
    writeBytes: jest.fn((_sessionId: string, dataBase64: string) => {
      const command = base64ToBytes(dataBase64)[4];
      sent.set(command, (sent.get(command) ?? 0) + 1);
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

/**
 * The REAL session key, read back from the coordinator.
 *
 * Not a hand-written `{generation: 1}`: the coordinator increments a
 * process-wide generation counter per opened session, so a literal is
 * correct only for the first session in a file. The suppression helper
 * refuses a key whose generation is not the session's current one - by
 * design, so a stale screen cannot suppress a stranger's poll - and a
 * hardcoded generation would silently turn every assertion below into a
 * test of that guard instead of a test of the suppression.
 */
function propsFor(
  sessionKey: {sessionId: string; generation: number},
  active: boolean,
): Props {
  return {
    route: {
      key: `Setup-${sessionKey.sessionId}`,
      name: 'Setup',
      params: {sessionKey},
    },
    navigation: {goBack: () => undefined, addListener: () => () => undefined},
    active,
  } as unknown as Props;
}

async function mount(sessionId: string) {
  const client = makeCountingClient(sessionId);
  client.setResponse(MSP_API_VERSION, Uint8Array.from([0, 1, 47]));
  client.setResponse(MSP_FC_VARIANT, Uint8Array.from(ascii('BTFL')));
  client.setResponse(MSP_BOARD_INFO, boardInfoPayload());
  client.setResponse(
    MSP_ATTITUDE,
    Uint8Array.from([...u16(0), ...u16(0), ...u16(0)]),
  );
  client.setResponse(MSP_BOXIDS, Uint8Array.from([0, 1, 2]));
  client.setResponse(MSP_STATUS_EX, statusExPayload());
  client.setResponse(MSP_ANALOG, analogPayload());
  client.setResponse(MSP_BATTERY_STATE, batteryPayload());
  client.setResponse(MSP_RAW_GPS, rawGpsPayload());

  /**
   * MOUNT ORDER IS LOAD-BEARING, and not for a reason about P3.
   *
   * Setup's first effect starts the ONE AppState telemetry owner and
   * registers this session with it. That owner derives its phase from
   * `AppState.currentState`, and under React Native's jest environment
   * that value is not 'active' - so it reads APP_BACKGROUND and pauses
   * any session it can already see, through the scheduler's whole-session
   * pause lease. Opening the session BEFORE mounting therefore parks the
   * entire scheduler (measured: pauseReasons ["APP_BACKGROUND"], zero
   * dispatches of anything), and every count below would read zero for a
   * reason that has nothing to do with the attitude poll.
   *
   * Mounting first - the same order the P2 dashboard harness uses - means
   * `track()` finds no scheduler yet and takes no lease, and the session
   * that opens a moment later runs normally. This is a statement about
   * the test environment, not a claim about the product: on a device the
   * phase is ACTIVE and no pause lease is taken at all.
   *
   * The provisional generation 0 is replaced with the real key as soon as
   * the session exists. Nothing reads it in between: the screen mounts
   * VISIBLE, and the suppression effect only acts while hidden.
   */
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    renderer = ReactTestRenderer.create(
      <SetupScreen {...propsFor({sessionId, generation: 0}, true)} />,
    );
  });
  await act(async () => {
    mspSessionCoordinator.openSession(
      client as unknown as UsbSerialTransportClient,
      sessionId,
    );
    await flushAsync();
  });
  const sessionKey = mspSessionCoordinator.getSessionKey(sessionId);
  if (sessionKey === undefined) {
    throw new Error(`session ${sessionId} did not open`);
  }
  await act(async () => {
    renderer.update(<SetupScreen {...propsFor(sessionKey, true)} />);
    await flushAsync();
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(20_000);
    await flushAsync();
  });
  return {renderer, client, sessionKey};
}

/** The tab shell re-renders the SAME mounted element with a new `active`. */
async function setActive(
  renderer: ReactTestRenderer.ReactTestRenderer,
  sessionKey: {sessionId: string; generation: number},
  active: boolean,
) {
  await act(async () => {
    renderer.update(<SetupScreen {...propsFor(sessionKey, active)} />);
    await flushAsync();
  });
}

async function runFor(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
    await flushAsync();
  });
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

/* ----------------------------- tests ------------------------------ */

describe('SETUP P3 - the hidden orientation poll', () => {
  it('polls attitude while Setup is visible', async () => {
    const id = 'p3-cost-visible';
    const {renderer, client} = await mount(id);

    client.resetCounts();
    await runFor(2_000);

    expect(client.countOf(MSP_ATTITUDE)).toBeGreaterThan(0);
    await teardown(id, renderer);
  });

  it('sends NOT ONE attitude request while Setup is hidden', async () => {
    const id = 'p3-cost-hidden';
    const {renderer, client, sessionKey} = await mount(id);

    await setActive(renderer, sessionKey, false);
    client.resetCounts();
    // Two seconds at the registered 50ms cadence is ~40 requests before
    // P3; the assertion is exactly zero, not "fewer".
    await runFor(2_000);

    expect(client.countOf(MSP_ATTITUDE)).toBe(0);
    await teardown(id, renderer);
  });

  it('keeps the other telemetry flowing while hidden - this is not a pause', async () => {
    const id = 'p3-cost-others';
    const {renderer, client, sessionKey} = await mount(id);

    await setActive(renderer, sessionKey, false);
    client.resetCounts();
    await runFor(30_000);

    // Battery (3s), GPS (5s) and FC status (8s) all fall due inside this
    // window. A session-wide pause would have silenced them too.
    expect(client.countOf(MSP_ATTITUDE)).toBe(0);
    expect(client.countOf(MSP_BATTERY_STATE) + client.countOf(MSP_ANALOG)).toBeGreaterThan(0);
    expect(client.countOf(MSP_RAW_GPS)).toBeGreaterThan(0);
    expect(client.countOf(MSP_STATUS_EX)).toBeGreaterThan(0);
    await teardown(id, renderer);
  });

  it('resumes the moment Setup is visible again', async () => {
    const id = 'p3-cost-resume';
    const {renderer, client, sessionKey} = await mount(id);

    await setActive(renderer, sessionKey, false);
    await runFor(2_000);
    await setActive(renderer, sessionKey, true);
    client.resetCounts();
    await runFor(2_000);

    expect(client.countOf(MSP_ATTITUDE)).toBeGreaterThan(0);
    await teardown(id, renderer);
  });

  it('survives repeated hide/show cycles without leaking a lease', async () => {
    const id = 'p3-cost-cycles';
    const {renderer, client, sessionKey} = await mount(id);

    for (let cycle = 0; cycle < 4; cycle++) {
      await setActive(renderer, sessionKey, false);
      client.resetCounts();
      await runFor(1_000);
      expect(client.countOf(MSP_ATTITUDE)).toBe(0);

      await setActive(renderer, sessionKey, true);
      client.resetCounts();
      await runFor(1_000);
      // A leaked lease would keep this at zero on the second cycle
      // onwards; an over-release would be invisible here but is covered
      // by setupHiddenAttitudeSuppression.test.ts.
      expect(client.countOf(MSP_ATTITUDE)).toBeGreaterThan(0);
    }
    await teardown(id, renderer);
  });

  it('registers no new poll and does not unregister the attitude poll', async () => {
    const id = 'p3-cost-registry';
    const {renderer, sessionKey} = await mount(id);
    const scheduler = mspSessionCoordinator.getTelemetryScheduler(id);
    const idsWhileVisible = (scheduler?.describeDiagnostics().polls ?? [])
      .map(poll => poll.id)
      .sort();

    await setActive(renderer, sessionKey, false);
    await runFor(2_000);

    const idsWhileHidden = (scheduler?.describeDiagnostics().polls ?? [])
      .map(poll => poll.id)
      .sort();
    // The SAME registry, suppressed - not a poll torn down and rebuilt.
    // A re-registration would reset the cached sample and make the hero
    // flash empty on return.
    expect(idsWhileHidden).toEqual(idsWhileVisible);
    expect(idsWhileHidden).toContain('attitude');
    await teardown(id, renderer);
  });

  it('preserves the last attitude sample instead of discarding it', async () => {
    const id = 'p3-cost-cache';
    const {renderer, sessionKey} = await mount(id);
    const scheduler = mspSessionCoordinator.getTelemetryScheduler(id);

    // The claim is only worth making if a real sample got there first -
    // 'WAITING' would satisfy a bare not-UNAVAILABLE check while proving
    // nothing at all.
    expect(['FRESH', 'STALE']).toContain(
      scheduler?.getValue('attitude').status,
    );

    await setActive(renderer, sessionKey, false);
    await runFor(2_000);

    // Suppression removes the poll from dispatch selection only. The
    // value must NOT revert to UNAVAILABLE or WAITING - that is what
    // unregistering would do, and it would lose the truth that a real
    // sample was once received. It ages honestly into STALE instead.
    expect(scheduler?.getValue('attitude').status).toBe('STALE');
    await teardown(id, renderer);
  });
});
