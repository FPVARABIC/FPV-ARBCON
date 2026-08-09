/**
 * CHECKPOINT F - THE LIVE SETUP TELEMETRY PIPELINE, END TO END.
 *
 * Covers BOTH Setup telemetry paths reported broken on real hardware:
 * the attitude pipeline (HW-001, a frozen model/compass/horizon) and the
 * battery pipeline (HW-002, an implausible ~0.17 V reading).
 *
 * WHY THIS FILE EXISTS AND WHY IT IS NOT ANOTHER RENDERER TEST. A real
 * flight controller reported a frozen 3D model, compass and artificial
 * horizon while the board was being physically moved. Every existing
 * test covered ONE link of the chain: droneSceneGeometry.test.ts proves
 * the maths, OrientationHero.test.tsx injects an OrientationViewState
 * directly, MspSessionCoordinator.test.ts stops at the scheduler's
 * cached value. Not one of them could have failed if the LIVE path
 * between them were broken, and a renderer test fed hand-written values
 * is explicitly not accepted as proof that the live pipeline works.
 *
 * WHAT IS REAL HERE: the coordinator, RNMspTransport, MspClient (real
 * FIFO, real framing, real checksums), the real telemetry scheduler and
 * its real 50ms tick driver, the real registration path, the real
 * useTelemetryValue/useSyncExternalStore binding, the real
 * deriveOrientationViewState, the real OrientationHero, the real
 * FlightInstruments, and - unlike every other screen suite in this repo
 * - THE REAL BROWSER SVG RENDERER. The barrel is mocked to
 * OrientationRenderer.web.tsx rather than to `() => null`, precisely so
 * the final boundary ("did the SVG receive changed orientation props")
 * is exercised rather than asserted away.
 *
 * WHAT IS FAKE: only the USB transport client. Response frames are built
 * with the same real MSP v1 frame builder mspClient.test.ts uses, so the
 * bytes that reach the parser are the bytes a flight controller sends.
 *
 * SCOPE HONESTY: this is a JavaScript test. It proves the app's own
 * pipeline. It proves NOTHING about real USB, a real browser's Web
 * Serial implementation, or a real flight controller - HW-001 remains
 * REQUIRES HARDWARE RETEST BY USER regardless of this file passing.
 */

jest.mock('../orientation3d', () => ({
  // THE REAL browser renderer, loaded through require() because the
  // Android tsconfig deliberately excludes `.web.tsx` from typechecking
  // (see tsconfig.json's own comment on the platform seam).
  OrientationRenderer: require('../orientation3d/OrientationRenderer.web')
    .OrientationRenderer,
}));

import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import SetupScreen from './SetupScreen';
import '../../i18n';
import type { RootStackParamList } from '../../navigation/types';
import {
  mspSessionCoordinator,
  ATTITUDE_TELEMETRY_POLL_ID,
  BATTERY_TELEMETRY_POLL_ID,
} from '../../platforms/react-native/protocol';
import {
  MSP_ANALOG,
  MSP_API_VERSION,
  MSP_ATTITUDE,
  MSP_BATTERY_STATE,
  MSP_BOARD_INFO,
  MSP_BOXIDS,
  MSP_FC_VARIANT,
  MSP_RAW_GPS,
  MSP_STATUS_EX,
} from '../../core';
import { buildMspFrameBytes } from '../../core/protocol/__testUtils__/mspFixtures';
import {
  base64ToBytes,
  bytesToBase64,
} from '../../platforms/react-native/protocol/base64';
import { orientationRenderObserver } from '../orientation3d/orientationRenderObserver';
import type {
  UsbSerialDataEvent,
  UsbSerialSessionDetachedEvent,
  UsbSerialTransportClient,
} from '../../platforms/react-native/transport';

type Props = NativeStackScreenProps<RootStackParamList, 'Setup'>;

function ascii(text: string): number[] {
  return text.split('').map(c => c.charCodeAt(0));
}

function pstring(text: string): number[] {
  return [text.length, ...ascii(text)];
}

function u16le(value: number): number[] {
  return [value % 256, Math.floor(value / 256) % 256];
}

function s16le(value: number): number[] {
  const unsigned = value < 0 ? value + 0x10000 : value;
  return [unsigned & 0xff, (unsigned >> 8) & 0xff];
}

/** The REAL 6-byte MSP_ATTITUDE wire payload: roll/pitch in signed
 * decidegrees, yaw in signed WHOLE degrees (see decodeAttitude.ts). */
function attitudePayload(
  rollDecidegrees: number,
  pitchDecidegrees: number,
  yawDegrees: number,
): Uint8Array {
  return Uint8Array.from([
    ...s16le(rollDecidegrees),
    ...s16le(pitchDecidegrees),
    ...s16le(yawDegrees),
  ]);
}

function boardInfoPayload(): Uint8Array {
  return Uint8Array.from([
    ...ascii('AFF3'),
    ...u16le(0),
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
    ...u16le(312),
    ...u16le(0),
    ...u16le(45),
    0,
    0,
    0,
    0,
    0,
    ...u16le(12),
    3,
    0,
    0,
    29,
    0,
    0,
    0,
    0,
    0,
  ]);
}

/** A REAL 11-byte MSP_BATTERY_STATE payload (see decodeBatteryState.ts
 * for the verified offsets). */
function batteryPayload(options: {
  cellCount: number;
  capacityMah?: number;
  legacyDecivolts?: number;
  consumedMah?: number;
  amperageCentiamps?: number;
  stateRaw: number;
  voltageCentivolts: number;
}): Uint8Array {
  return Uint8Array.from([
    options.cellCount,
    ...u16le(options.capacityMah ?? 0),
    options.legacyDecivolts ?? 0,
    ...u16le(options.consumedMah ?? 0),
    ...s16le(options.amperageCentiamps ?? 0),
    options.stateRaw,
    ...u16le(options.voltageCentivolts),
  ]);
}

function makeFakeClient(sessionId: string) {
  const dataListeners = new Set<(event: UsbSerialDataEvent) => void>();
  const detachListeners = new Set<
    (event: UsbSerialSessionDetachedEvent) => void
  >();
  const responses = new Map<number, Uint8Array>();
  const commands: number[] = [];
  /** Commands whose WRITE never settles - MspClient therefore never
   * starts a response timer for them, so the dispatch stays genuinely
   * in flight and its cached value ages to STALE rather than failing.
   * The only way to reach a real STALE without a timeout. */
  const heldWrites = new Set<number>();

  const fake = {
    commands,
    writeBytes: jest.fn((_sessionId: string, dataBase64: string) => {
      const command = base64ToBytes(dataBase64)[4];
      commands.push(command);
      if (heldWrites.has(command)) {
        return new Promise<void>(() => undefined);
      }
      const payload = responses.get(command);
      if (payload !== undefined) {
        const frameBytes = buildMspFrameBytes(command, payload, {
          wireFormat: 'v1',
          direction: 'response',
        });
        Promise.resolve().then(() => {
          const event: UsbSerialDataEvent = {
            sessionId,
            dataBase64: bytesToBase64(frameBytes),
          };
          for (const listener of Array.from(dataListeners)) {
            listener(event);
          }
        });
      }
      return Promise.resolve(undefined);
    }),
    onDataReceived: jest.fn((cb: (event: UsbSerialDataEvent) => void) => {
      dataListeners.add(cb);
      return jest.fn(() => dataListeners.delete(cb));
    }),
    onSessionDetached: jest.fn(
      (cb: (event: UsbSerialSessionDetachedEvent) => void) => {
        detachListeners.add(cb);
        return jest.fn(() => detachListeners.delete(cb));
      },
    ),
    stopReading: jest.fn(() => Promise.resolve(undefined)),
    startReading: jest.fn(() => Promise.resolve(undefined)),
    setResponse: (command: number, payload: Uint8Array) =>
      responses.set(command, payload),
    clearResponse: (command: number) => responses.delete(command),
    holdWritesFor: (command: number) => heldWrites.add(command),
    countOf: (command: number) => commands.filter(c => c === command).length,
  };

  fake.setResponse(MSP_API_VERSION, Uint8Array.from([0, 1, 47]));
  fake.setResponse(MSP_FC_VARIANT, Uint8Array.from(ascii('BTFL')));
  fake.setResponse(MSP_BOARD_INFO, boardInfoPayload());
  fake.setResponse(MSP_ATTITUDE, attitudePayload(0, 0, 0));
  fake.setResponse(
    MSP_BATTERY_STATE,
    batteryPayload({ cellCount: 4, stateRaw: 0, voltageCentivolts: 1656 }),
  );
  fake.setResponse(
    MSP_ANALOG,
    Uint8Array.from([
      168,
      ...u16le(0),
      ...u16le(540),
      ...u16le(0),
      ...u16le(1680),
    ]),
  );
  fake.setResponse(
    MSP_RAW_GPS,
    Uint8Array.from([
      2,
      8,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      ...u16le(0),
      ...u16le(0),
      ...u16le(0),
    ]),
  );
  fake.setResponse(MSP_STATUS_EX, statusExPayload());
  fake.setResponse(MSP_BOXIDS, Uint8Array.from([0, 1, 2]));
  return fake;
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
  }
}

function makeProps(sessionId: string): Props {
  return {
    route: {
      key: 'Setup-1',
      name: 'Setup',
      params: { sessionKey: { sessionId, generation: 1 } },
    },
    navigation: { goBack: jest.fn() },
  } as unknown as Props;
}

/** Every `points` attribute the SVG model is currently painting, joined -
 * the single most direct answer to "did the drawn geometry change". */
function svgPolygonPoints(
  renderer: ReactTestRenderer.ReactTestRenderer,
): string {
  return renderer.root
    .findAll(node => node.type === 'polygon', { deep: false })
    .map(node => String(node.props.points))
    .join('|');
}

function textOf(
  renderer: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): string {
  const node = renderer.root.find(
    candidate => candidate.props.testID === testID,
  );
  return node
    .findAllByType(Text)
    .map(child =>
      Array.isArray(child.props.children)
        ? child.props.children.join('')
        : String(child.props.children),
    )
    .join(' ');
}

/** The rotate/translate transform actually applied to an instrument's
 * moving layer. Frozen instruments and a moving model would show up
 * here as an unchanged string while the polygons changed. */
function transformOf(
  renderer: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): string {
  const node = renderer.root.find(
    candidate => candidate.props.testID === testID,
  );
  return JSON.stringify(node.props.style);
}

function schedulerDiagnostics(sessionId: string) {
  return mspSessionCoordinator.getTelemetryScheduler(sessionId)?.describeDiagnostics();
}

function attitudePoll(sessionId: string) {
  return schedulerDiagnostics(sessionId)?.polls.find(
    poll => poll.id === ATTITUDE_TELEMETRY_POLL_ID,
  );
}

const mounted: ReactTestRenderer.ReactTestRenderer[] = [];
const openedSessions: string[] = [];

describe('Setup attitude pipeline - real coordinator, real scheduler, real SVG renderer', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    orientationRenderObserver.reset();
  });

  afterEach(async () => {
    await act(async () => {
      for (const renderer of mounted.splice(0)) {
        renderer.unmount();
      }
    });
    for (const sessionId of openedSessions.splice(0)) {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    }
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  async function mountConnectedSetup(
    sessionId: string,
    client: ReturnType<typeof makeFakeClient>,
    active = true,
  ): Promise<ReactTestRenderer.ReactTestRenderer> {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <SetupScreen {...makeProps(sessionId)} active={active} />,
      );
    });
    mounted.push(renderer);
    await act(async () => {
      mspSessionCoordinator.openSession(
        client as unknown as UsbSerialTransportClient,
        sessionId,
      );
      await flushAsync();
    });
    openedSessions.push(sessionId);
    return renderer;
  }

  it('an active Setup registers exactly one attitude poll on the real scheduler', async () => {
    const sessionId = 'f-pipeline-register';
    const client = makeFakeClient(sessionId);
    await mountConnectedSetup(sessionId, client);

    const diagnostics = schedulerDiagnostics(sessionId);
    expect(diagnostics).toBeDefined();
    expect(
      diagnostics!.polls.filter(poll => poll.id === ATTITUDE_TELEMETRY_POLL_ID),
    ).toHaveLength(1);
    expect(attitudePoll(sessionId)).toMatchObject({
      command: MSP_ATTITUDE,
      intervalMs: 50,
      staleAfterMs: 500,
      priority: 0,
      status: 'WAITING',
    });
    expect(diagnostics!.pauseReasons).toEqual([]);
  });

  it('genuinely different MSP_ATTITUDE bytes move the model, the compass and the artificial horizon, and advance sampleSeq and the timestamp', async () => {
    const sessionId = 'f-pipeline-moves';
    const client = makeFakeClient(sessionId);
    client.setResponse(MSP_ATTITUDE, attitudePayload(0, 0, 0));
    const renderer = await mountConnectedSetup(sessionId, client);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(50);
      await flushAsync();
    });

    const firstPoll = attitudePoll(sessionId);
    expect(firstPoll).toMatchObject({ status: 'FRESH' });
    expect(firstPoll!.responseCount).toBeGreaterThan(0);
    const firstSeq = firstPoll!.sampleSeq!;
    const firstUpdatedAt = firstPoll!.updatedAtMs!;
    const firstPolygons = svgPolygonPoints(renderer);
    const firstHorizon = transformOf(renderer, 'artificial-horizon-moving-world');
    const firstCompass = transformOf(renderer, 'direction-compass-dial');
    expect(firstPolygons.length).toBeGreaterThan(0);
    expect(textOf(renderer, 'orientation-hero-roll')).toContain('0°');

    // The board is physically moved: 12.5 degrees of roll, 7.0 degrees of
    // raw nose-down pitch (presented as -7.0), heading 214.
    client.setResponse(MSP_ATTITUDE, attitudePayload(125, 70, 214));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(400);
      await flushAsync();
    });

    const secondPoll = attitudePoll(sessionId)!;
    expect(secondPoll.status).toBe('FRESH');
    expect(secondPoll.sampleSeq!).toBeGreaterThan(firstSeq);
    expect(secondPoll.updatedAtMs!).toBeGreaterThan(firstUpdatedAt);

    // The decoded, presentation-normalized angles reached the readouts.
    expect(textOf(renderer, 'orientation-hero-roll')).toContain('12.5°');
    expect(textOf(renderer, 'orientation-hero-pitch')).toContain('-7°');
    expect(textOf(renderer, 'orientation-hero-heading')).toContain('214°');

    // ...and the DRAWN geometry, the horizon and the compass all changed
    // with them. This is the assertion an injected-value renderer test
    // can never make.
    expect(svgPolygonPoints(renderer)).not.toBe(firstPolygons);
    expect(transformOf(renderer, 'artificial-horizon-moving-world')).not.toBe(
      firstHorizon,
    );
    expect(transformOf(renderer, 'direction-compass-dial')).not.toBe(
      firstCompass,
    );

    // The render observer - the evidence the field report will carry -
    // agrees that the renderer was handed more than one distinct pose.
    const observation = orientationRenderObserver.read();
    expect(observation.lastStatus).toBe('LIVE');
    expect(observation.distinctPoseCount).toBeGreaterThan(1);
    expect(observation.lastRollDeg).toBeCloseTo(12.5);
    expect(observation.lastYawDeg).toBe(214);
  });

  it('a stalled link freezes the LAST REAL pose, marks it stale, and never relabels it live', async () => {
    const sessionId = 'f-pipeline-stale';
    const client = makeFakeClient(sessionId);
    client.setResponse(MSP_ATTITUDE, attitudePayload(125, 70, 214));
    const renderer = await mountConnectedSetup(sessionId, client);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(50);
      await flushAsync();
    });
    expect(attitudePoll(sessionId)!.status).toBe('FRESH');
    expect(textOf(renderer, 'orientation-hero-status-badge')).toContain(
      'مباشر',
    );
    const livePolygons = svgPolygonPoints(renderer);

    // The link stalls: the write never settles, so no response and no
    // timeout either - the sample simply ages out.
    client.holdWritesFor(MSP_ATTITUDE);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1200);
      await flushAsync();
    });

    expect(attitudePoll(sessionId)!.status).toBe('STALE');
    // The frozen pose is still the LAST REAL one - never reset to zero.
    expect(textOf(renderer, 'orientation-hero-roll')).toContain('12.5°');
    expect(svgPolygonPoints(renderer)).toBe(livePolygons);
    // ...and the screen says so, in words, rather than looking live.
    expect(textOf(renderer, 'orientation-hero-status-badge')).not.toContain(
      'مباشر',
    );
    expect(textOf(renderer, 'orientation-hero-stale-label')).toContain(
      'البيانات متأخرة',
    );
    expect(orientationRenderObserver.read().lastStatus).toBe('STALE');
  });

  it('a timed-out attitude read shows the error state and drops the pose entirely - it never falls back to a level model', async () => {
    const sessionId = 'f-pipeline-error';
    const client = makeFakeClient(sessionId);
    client.setResponse(MSP_ATTITUDE, attitudePayload(125, 70, 214));
    const renderer = await mountConnectedSetup(sessionId, client);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(50);
      await flushAsync();
    });
    expect(attitudePoll(sessionId)!.status).toBe('FRESH');

    // The board stops answering entirely. Requests still go out; the
    // client's own response timeout eventually rejects them.
    client.clearResponse(MSP_ATTITUDE);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3000);
      await flushAsync();
    });

    const poll = attitudePoll(sessionId)!;
    expect(poll.status).toBe('ERROR');
    expect(poll.errorCount).toBeGreaterThan(0);
    // An enumerated code, never a message and never wire bytes.
    expect(poll.lastErrorCode).toBe('MSP_TIMEOUT');
    // No readouts, no model - the error branch, not a zeroed pose.
    expect(
      renderer.root.findAll(
        node => node.props.testID === 'orientation-hero-error',
        { deep: false },
      ),
    ).toHaveLength(1);
    expect(svgPolygonPoints(renderer)).toBe('');
    expect(orientationRenderObserver.read().lastStatus).toBe('ERROR');
  });

  it('a session with no scheduler renders the waiting state, not a level model presented as live', async () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <SetupScreen {...makeProps('f-pipeline-never-opened')} active />,
      );
    });
    mounted.push(renderer);

    expect(
      renderer.root.findAll(
        node => node.props.testID === 'orientation-hero-waiting',
        { deep: false },
      ),
    ).toHaveLength(1);
    // No model is drawn at all while waiting - there is no pose to draw.
    expect(svgPolygonPoints(renderer)).toBe('');
  });

  it('leaving Setup stops the screen consuming samples and returning resumes it, without ever creating a second attitude poll', async () => {
    const sessionId = 'f-pipeline-tabs';
    const client = makeFakeClient(sessionId);
    client.setResponse(MSP_ATTITUDE, attitudePayload(0, 0, 0));
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <SetupScreen {...makeProps(sessionId)} active />,
      );
    });
    mounted.push(renderer);
    await act(async () => {
      mspSessionCoordinator.openSession(
        client as unknown as UsbSerialTransportClient,
        sessionId,
      );
      await flushAsync();
    });
    openedSessions.push(sessionId);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(50);
      await flushAsync();
    });
    expect(textOf(renderer, 'orientation-hero-roll')).toContain('0°');

    // The operator switches to another tab. MainTabsScreen keeps Setup
    // MOUNTED and only flips `active` - the same thing it does in
    // production.
    await act(async () => {
      renderer.update(<SetupScreen {...makeProps(sessionId)} active={false} />);
      await flushAsync();
    });

    client.setResponse(MSP_ATTITUDE, attitudePayload(125, 70, 214));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(400);
      await flushAsync();
    });

    // DOCUMENTED, DELIBERATE BEHAVIOR: `active` gates the screen's React
    // SUBSCRIPTION, not the poll. The scheduler keeps polling (the FC
    // status other tabs depend on rides the same scheduler), so the
    // sample count keeps climbing while the hidden screen stops
    // re-rendering for it.
    const pausedPoll = attitudePoll(sessionId)!;
    expect(pausedPoll.responseCount).toBeGreaterThan(1);
    expect(schedulerDiagnostics(sessionId)!.pauseReasons).toEqual([]);

    // Coming back re-subscribes and the newest real sample appears.
    await act(async () => {
      renderer.update(<SetupScreen {...makeProps(sessionId)} active />);
      await flushAsync();
      await jest.advanceTimersByTimeAsync(100);
      await flushAsync();
    });
    expect(textOf(renderer, 'orientation-hero-roll')).toContain('12.5°');
    expect(textOf(renderer, 'orientation-hero-heading')).toContain('214°');

    // Through all of it: exactly ONE attitude poll ever existed.
    expect(
      schedulerDiagnostics(sessionId)!.polls.filter(
        poll => poll.id === ATTITUDE_TELEMETRY_POLL_ID,
      ),
    ).toHaveLength(1);
  });

  it('a held pause lease is reported by name, so "paused" can never be mistaken for a dead link', async () => {
    const sessionId = 'f-pipeline-lease';
    const client = makeFakeClient(sessionId);
    await mountConnectedSetup(sessionId, client);

    const scheduler = mspSessionCoordinator.getTelemetryScheduler(sessionId)!;
    const lease = scheduler.acquirePauseLease('MOTOR_TEST');
    await act(async () => {
      await jest.advanceTimersByTimeAsync(200);
      await flushAsync();
    });
    expect(scheduler.describeDiagnostics().pauseReasons).toEqual(['MOTOR_TEST']);
    const heldRequests = attitudePoll(sessionId)!.requestCount;

    await act(async () => {
      await jest.advanceTimersByTimeAsync(300);
      await flushAsync();
    });
    expect(attitudePoll(sessionId)!.requestCount).toBe(heldRequests);

    lease.release();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(100);
      await flushAsync();
    });
    expect(scheduler.describeDiagnostics().pauseReasons).toEqual([]);
    expect(attitudePoll(sessionId)!.requestCount).toBeGreaterThan(heldRequests);
  });

  it('the battery poll is registered for an identified Betaflight session and its counters are visible', async () => {
    const sessionId = 'f-pipeline-battery-poll';
    const client = makeFakeClient(sessionId);
    await mountConnectedSetup(sessionId, client);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(200);
      await flushAsync();
    });

    const battery = schedulerDiagnostics(sessionId)!.polls.find(
      poll => poll.id === BATTERY_TELEMETRY_POLL_ID,
    );
    expect(battery).toMatchObject({ command: MSP_BATTERY_STATE });
    expect(battery!.requestCount).toBeGreaterThan(0);
  });
});

/**
 * CHECKPOINT F, HW-002 - the battery value, proven from the WIRE.
 *
 * Every case below drives real MSP_BATTERY_STATE bytes through the real
 * parser, the real decoder and the real scheduler into the real card, so
 * "which command produced the displayed number" and "what scaling was
 * applied to it" are answered by the pipeline rather than asserted about
 * it. MSP_ANALOG is scripted throughout with a DIFFERENT voltage (16.80
 * V) precisely so a card that ever read the wrong source would fail
 * loudly instead of coincidentally agreeing.
 */
describe('Setup battery telemetry - real coordinator, real decode, real card', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(async () => {
    await act(async () => {
      for (const renderer of mounted.splice(0)) {
        renderer.unmount();
      }
    });
    for (const sessionId of openedSessions.splice(0)) {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    }
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  async function mount(
    sessionId: string,
    client: ReturnType<typeof makeFakeClient>,
  ): Promise<ReactTestRenderer.ReactTestRenderer> {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <SetupScreen {...makeProps(sessionId)} active />,
      );
    });
    mounted.push(renderer);
    await act(async () => {
      mspSessionCoordinator.openSession(
        client as unknown as UsbSerialTransportClient,
        sessionId,
      );
      await flushAsync();
    });
    openedSessions.push(sessionId);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(300);
      await flushAsync();
    });
    return renderer;
  }

  function cardText(renderer: ReactTestRenderer.ReactTestRenderer): string {
    return [
      ...renderer.root.findAll(
        node =>
          typeof node.props.testID === 'string' &&
          node.props.testID.startsWith('battery-card'),
        { deep: false },
      ),
    ]
      .flatMap(node => node.findAllByType(Text))
      .map(child =>
        Array.isArray(child.props.children)
          ? child.props.children.join('')
          : String(child.props.children),
      )
      .join(' ');
  }

  it('a detected pack: 1656 wire centivolts become exactly 16.56 V in the primary slot', async () => {
    const sessionId = 'f-battery-valid';
    const client = makeFakeClient(sessionId);
    client.setResponse(
      MSP_BATTERY_STATE,
      batteryPayload({
        cellCount: 4,
        capacityMah: 1500,
        legacyDecivolts: 165,
        stateRaw: 0,
        voltageCentivolts: 1656,
      }),
    );
    const renderer = await mount(sessionId, client);

    expect(cardText(renderer)).toContain('16.56 V');
    // The 0.1V legacy field (16.5 V) is NEVER the displayed value...
    expect(cardText(renderer)).not.toContain('16.50 V');
    // ...and neither is MSP_ANALOG's own duplicate voltage field.
    expect(cardText(renderer)).not.toContain('16.80 V');
  });

  it('the ~0.17 V field case, decoded from real wire bytes, is presented as "no measurement" rather than as a pack voltage', async () => {
    const sessionId = 'f-battery-residual';
    const client = makeFakeClient(sessionId);
    client.setResponse(
      MSP_BATTERY_STATE,
      batteryPayload({ cellCount: 0, stateRaw: 3, voltageCentivolts: 17 }),
    );
    const renderer = await mount(sessionId, client);

    const text = cardText(renderer);
    expect(text).toContain('لا يوجد قياس جهد بطارية');
    expect(text).toContain('0.17 V');
    expect(text).toContain('ليست جهد حزمة بطارية');
    expect(
      renderer.root.findAllByProps({ testID: 'battery-card-voltage' }),
    ).toHaveLength(0);
  });

  it('a truncated MSP_BATTERY_STATE payload becomes an ERROR, never a partial or zeroed reading', async () => {
    const sessionId = 'f-battery-malformed';
    const client = makeFakeClient(sessionId);
    // 6 bytes where the verified layout requires 11.
    client.setResponse(MSP_BATTERY_STATE, Uint8Array.from([4, 0, 0, 0, 0, 0]));
    const renderer = await mount(sessionId, client);

    const battery = schedulerDiagnostics(sessionId)!.polls.find(
      poll => poll.id === BATTERY_TELEMETRY_POLL_ID,
    )!;
    expect(battery.status).toBe('ERROR');
    expect(battery.lastErrorCode).toBe('MspPayloadReadError');
    const text = cardText(renderer);
    expect(text).toContain('تعذّر قراءة بيانات البطارية');
    expect(text).not.toMatch(/\d+\.\d+ V/);
  });

  it('a non-Betaflight flight controller never registers the poll at all, and the card says unavailable', async () => {
    const sessionId = 'f-battery-unsupported';
    const client = makeFakeClient(sessionId);
    client.setResponse(MSP_FC_VARIANT, Uint8Array.from(ascii('INAV')));
    const renderer = await mount(sessionId, client);

    expect(
      schedulerDiagnostics(sessionId)!.polls.find(
        poll => poll.id === BATTERY_TELEMETRY_POLL_ID,
      ),
    ).toBeUndefined();
    expect(cardText(renderer)).toContain('بيانات البطارية غير متاحة');
    expect(cardText(renderer)).not.toMatch(/\d+\.\d+ V/);
  });

  it('the one-strike timeout latch freezes the LAST REAL reading as stale - the poll is dropped, and no live number survives it', async () => {
    const sessionId = 'f-battery-latch';
    const client = makeFakeClient(sessionId);
    client.setResponse(
      MSP_BATTERY_STATE,
      batteryPayload({ cellCount: 4, stateRaw: 0, voltageCentivolts: 1656 }),
    );
    const renderer = await mount(sessionId, client);
    expect(cardText(renderer)).toContain('16.56 V');

    // The battery channel stops answering: one MSP_TIMEOUT is enough.
    client.clearResponse(MSP_BATTERY_STATE);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(9000);
      await flushAsync();
    });

    // The poll is gone from the scheduler entirely...
    expect(
      schedulerDiagnostics(sessionId)!.polls.find(
        poll => poll.id === BATTERY_TELEMETRY_POLL_ID,
      ),
    ).toBeUndefined();
    // ...and the card shows the last real reading, explicitly stale.
    const text = cardText(renderer);
    expect(text).toContain('16.56 V');
    expect(text).toContain('بيانات البطارية غير محدثة');
  });
});
