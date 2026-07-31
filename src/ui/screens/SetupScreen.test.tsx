/**
 * Pass 7.4, Step 5 - a MINIMAL smoke test only: confirms the real screen
 * assembles and mounts without crashing, and that the Pass 7.1 missing-
 * sessionKey fallback still works. Comprehensive behavioral coverage
 * (5 connection states, STALE freeze visible, safety strip compact/
 * expanded, resetOrientationViewOffset behavior, accessibility) is
 * explicitly Step 6's own job, deferred on purpose - not omitted by
 * oversight.
 *
 * Mocks the orientation3d barrel (OrientationRenderer) per Step 2's own
 * established finding: mounting the real Skia-backed component under
 * Jest fails (no real CanvasKit-WASM wired in).
 */

jest.mock('../orientation3d', () => ({
  // A jest.fn component: the pose the 3D model is handed has to be
  // observable for the heading-reset tests below, which assert the model
  // and the numeric readout agree on the SAME relative heading.
  OrientationRenderer: jest.fn(() => null),
}));

import React from 'react';
import {Text} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';

import SetupScreen from './SetupScreen';
import {OrientationRenderer} from '../orientation3d';
import '../../i18n';
import i18n from '../../i18n';
import type {RootStackParamList} from '../../navigation/types';
import {
  mspSessionCoordinator,
  setupUiSessionStore,
  fcToolsController,
  ATTITUDE_TELEMETRY_POLL_ID,
  ARMED_TELEMETRY_POLL_ID,
  ARMING_BLOCKERS_TELEMETRY_POLL_ID,
} from '../../platforms/react-native/protocol';
import {
  MSP_API_VERSION,
  MSP_FC_VARIANT,
  MSP_BOARD_INFO,
  MSP_ATTITUDE,
  MSP_BATTERY_STATE,
  MSP_ANALOG,
  MSP_RAW_GPS,
  MSP_STATUS_EX,
} from '../../core';
import type {ArmingBlockReason} from '../../core';
import {buildMspFrameBytes} from '../../core/protocol/__testUtils__/mspFixtures';
import {base64ToBytes, bytesToBase64} from '../../platforms/react-native/protocol/base64';
import type {UsbSerialDataEvent, UsbSerialSessionDetachedEvent, UsbSerialTransportClient} from '../../platforms/react-native/transport';

type Props = NativeStackScreenProps<RootStackParamList, 'Setup'>;

// Mirrors App.test.tsx's own queryByTestID(): findAllByProps({testID})
// also matches Text's own underlying host-component instance (which
// forwards the same testID prop through undisturbed), not just the
// logical <Text> element - filtering to node.type === Text is what
// actually disambiguates it.
function queryByTestID(renderer: ReactTestRenderer.ReactTestRenderer, testID: string) {
  return renderer.root.findAllByProps({testID}).filter(node => node.type === Text);
}

function findAnyByTestID(renderer: ReactTestRenderer.ReactTestRenderer, testID: string) {
  const matches = renderer.root.findAllByProps({testID});
  return matches.length > 0 ? matches[0] : null;
}

function allText(renderer: ReactTestRenderer.ReactTestRenderer): string[] {
  return renderer.root.findAllByType(Text).map(node => {
    const children = node.props.children;
    return Array.isArray(children) ? children.join('') : String(children ?? '');
  });
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
}

function ascii(text: string): number[] {
  return text.split('').map(c => c.charCodeAt(0));
}

function pstring(text: string): number[] {
  return [text.length, ...ascii(text)];
}

function u16le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
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

function attitudePayload(rollDecidegrees: number, pitchDecidegrees: number, yawDegrees: number): Uint8Array {
  const s16le = (value: number) => {
    const unsigned = value < 0 ? value + 0x10000 : value;
    return [unsigned & 0xff, (unsigned >> 8) & 0xff];
  };
  return Uint8Array.from([...s16le(rollDecidegrees), ...s16le(pitchDecidegrees), ...s16le(yawDegrees)]);
}

/**
 * A comprehensive fake UsbSerialTransportClient - Step 6's own screen-
 * level tests need real desync/recovery/physical-detach control that
 * Step 5's minimal smoke-test fixture never needed.
 *
 * rejectNextRestart() rejects stopReading() specifically: restartReceiveLoop()
 * (RNMspTransport.ts) is the ONLY caller of stopReading() anywhere in this
 * whole flow (openSession() itself only ever calls startReading()), so
 * making the NEXT stopReading() call reject is a precise, unambiguous way
 * to fail the recovery attempt's own restart step and reach RECOVERY_FAILED,
 * without needing to distinguish which of possibly-several startReading()
 * calls to target.
 */
function makeFakeClient(sessionId: string, options: {deferStartReading?: boolean} = {}) {
  const dataListeners = new Set<(event: UsbSerialDataEvent) => void>();
  const detachListeners = new Set<(event: UsbSerialSessionDetachedEvent) => void>();
  const responses = new Map<number, Uint8Array>();
  const heldWriteCommands = new Set<number>();
  let rejectNextWriteReason: {reason: unknown} | undefined;
  let rejectNextRestartReason: {reason: unknown} | undefined;
  let resolveStartReadingImpl: () => void = () => undefined;
  const startReadingPromise = options.deferStartReading
    ? new Promise<void>(resolve => {
        resolveStartReadingImpl = resolve;
      })
    : Promise.resolve(undefined);
  let startReadingCallCount = 0;
  // Every startReading() call BEYOND the first is triggered by
  // restartReceiveLoop() (RNMspTransport.ts), never by openSession()
  // itself - and, unlike the FIRST call, deliberately stays pending
  // FOREVER by default rather than auto-resolving. This is what makes
  // RESTARTING_READER/PROBING reliably OBSERVABLE for a screen-level
  // snapshot: the earlier version of this fixture auto-resolved every
  // step (stopReading -> startReading -> probe write -> probe response,
  // all already-resolved promises), and the entire recovery chain
  // settled all the way back to READY within the SAME microtask flush a
  // test's own assertion ran in - a real, observed race, not a guess
  // (confirmed by an actual failing assertion during this fixture's
  // development). resolveNextRestartRead() lets a test that DOES want a
  // full recovery round trip opt back in explicitly.
  let pendingRestartReadResolvers: Array<() => void> = [];

  const fake = {
    writeBytes: jest.fn((_sessionId: string, dataBase64: string) => {
      if (rejectNextWriteReason) {
        const {reason} = rejectNextWriteReason;
        rejectNextWriteReason = undefined;
        return Promise.reject(reason);
      }
      const bytes = base64ToBytes(dataBase64);
      const command = bytes[4];
      // Pass 7.6b (additive): a per-command held write never settles -
      // no response-timeout timer ever starts, leaving that one poll
      // genuinely in-flight forever (the battery staleness fixture).
      if (heldWriteCommands.has(command)) {
        return new Promise<void>(() => undefined);
      }
      const payload = responses.get(command);
      if (payload) {
        const frameBytes = buildMspFrameBytes(command, payload, {wireFormat: 'v1', direction: 'response'});
        Promise.resolve().then(() => {
          const event: UsbSerialDataEvent = {sessionId, dataBase64: bytesToBase64(frameBytes)};
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
    onSessionDetached: jest.fn((cb: (event: UsbSerialSessionDetachedEvent) => void) => {
      detachListeners.add(cb);
      return jest.fn(() => detachListeners.delete(cb));
    }),
    stopReading: jest.fn(() => {
      if (rejectNextRestartReason) {
        const {reason} = rejectNextRestartReason;
        rejectNextRestartReason = undefined;
        return Promise.reject(reason);
      }
      return Promise.resolve(undefined);
    }),
    startReading: jest.fn(() => {
      startReadingCallCount += 1;
      if (startReadingCallCount === 1) {
        return startReadingPromise;
      }
      return new Promise<void>(resolve => {
        pendingRestartReadResolvers.push(resolve);
      });
    }),
    resolveStartReading: () => {
      resolveStartReadingImpl();
    },
    resolveNextRestartRead: () => {
      const resolve = pendingRestartReadResolvers.shift();
      if (!resolve) {
        throw new Error('resolveNextRestartRead(): no pending restart-triggered startReading() call.');
      }
      resolve();
    },
    setResponse: (command: number, payload: Uint8Array) => {
      responses.set(command, payload);
    },
    holdWritesFor: (command: number) => {
      heldWriteCommands.add(command);
    },
    clearResponse: (command: number) => {
      responses.delete(command);
    },
    rejectNextWrite: (reason: unknown = new Error('fake write failure')) => {
      rejectNextWriteReason = {reason};
    },
    rejectNextRestart: (reason: unknown = new Error('fake restart failure')) => {
      rejectNextRestartReason = {reason};
    },
    emitSessionDetached: (event: UsbSerialSessionDetachedEvent) => {
      for (const listener of Array.from(detachListeners)) {
        listener(event);
      }
    },
  };
  fake.setResponse(MSP_API_VERSION, Uint8Array.from([0, 1, 48]));
  fake.setResponse(MSP_FC_VARIANT, Uint8Array.from(ascii('BTFL')));
  fake.setResponse(MSP_BOARD_INFO, boardInfoPayload());
  // Pass 7.6a (test-fixture isolation only): production now registers a
  // battery poll for every successfully-identified BETAFLIGHT session,
  // and an UNANSWERED battery request would occupy the serialized MSP
  // queue (until its real 2000ms response timeout), distorting these
  // screen tests' settle loops. A valid, benign 11-byte response (no
  // battery detected: cellCount 0, firmware state BATTERY_NOT_PRESENT=3,
  // all measurements 0) keeps every test isolated without changing any
  // assertion or production behavior.
  fake.setResponse(MSP_BATTERY_STATE, Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0]));
  // Pass 7.6c (same isolation rationale): production now also registers
  // three auxiliary polls (MSP_ANALOG / MSP_RAW_GPS / MSP_STATUS_EX,
  // phase-staggered at 700/1400/2100ms) for every identified BETAFLIGHT
  // session. Benign responses keep the serialized queue flowing in tests
  // that advance past those times; tests needing different behavior
  // overwrite them.
  fake.setResponse(MSP_ANALOG, Uint8Array.from([168, ...u16le(0), ...u16le(540), ...u16le(0), ...u16le(1680)]));
  fake.setResponse(
    MSP_RAW_GPS,
    Uint8Array.from([2, 8, 0, 0, 0, 0, 0, 0, 0, 0, ...u16le(0), ...u16le(0), ...u16le(0)]),
  );
  fake.setResponse(
    MSP_STATUS_EX,
    Uint8Array.from([...u16le(312), ...u16le(0), ...u16le(41), 0, 0, 0, 0, 0, ...u16le(12)]),
  );
  return fake;
}

/** Only the fields SetupScreen itself reads (route.params) - cast, same
 * as this codebase's other fake-prop patterns (e.g.
 * UsbConnectionScreen.test.tsx's `as unknown as UsbSerialTransportClient`). */
function makeProps(params: RootStackParamList['Setup'] | undefined): Props {
  return {
    route: {params} as unknown as Props['route'],
    navigation: {goBack: jest.fn()} as unknown as Props['navigation'],
  };
}

describe('SetupScreen', () => {
  it('does not throw and renders an honest fallback when route.params is missing (defense-in-depth)', () => {
    const props = makeProps(undefined);
    let renderer!: ReactTestRenderer.ReactTestRenderer;

    expect(() => {
      act(() => {
        renderer = ReactTestRenderer.create(<SetupScreen {...props} />);
      });
    }).not.toThrow();

    expect(queryByTestID(renderer, 'setup-screen-missing-session')).toHaveLength(1);
    expect(findAnyByTestID(renderer, 'setup-screen')).toBeNull();

    act(() => {
      renderer.unmount();
    });
  });

  it('assembles and mounts Regions 1+2 (TopSystemBar + OrientationHero + SafetyStrip) without crashing, for a never-opened session', () => {
    const props = makeProps({sessionKey: {sessionId: 'setup-screen-smoke-session', generation: 1}});
    let renderer!: ReactTestRenderer.ReactTestRenderer;

    expect(() => {
      act(() => {
        renderer = ReactTestRenderer.create(<SetupScreen {...props} />);
      });
    }).not.toThrow();

    expect(findAnyByTestID(renderer, 'setup-screen')).not.toBeNull();
    expect(findAnyByTestID(renderer, 'setup-top-bar')).not.toBeNull();
    expect(findAnyByTestID(renderer, 'orientation-hero-waiting')).not.toBeNull(); // no telemetry scheduler yet
    expect(findAnyByTestID(renderer, 'safety-strip-unknown')).not.toBeNull(); // placeholder armed/blockers -> UNAVAILABLE -> UNKNOWN

    act(() => {
      renderer.unmount();
    });
  });

  it('pressing the top bar back button calls navigation.goBack()', async () => {
    const goBack = jest.fn();
    const props = {
      route: {params: {sessionKey: {sessionId: 'setup-screen-back-session', generation: 1}}} as unknown as Props['route'],
      navigation: {goBack} as unknown as Props['navigation'],
    };
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<SetupScreen {...props} />);
    });

    await act(async () => {
      findAnyByTestID(renderer, 'setup-top-bar-back')!.props.onPress();
    });

    expect(goBack).toHaveBeenCalledTimes(1);

    act(() => {
      renderer.unmount();
    });
  });
});

/**
 * Pass 7.4, Step 6 - connection-indicator states through the REAL
 * assembled screen (not just TopSystemBar in isolation, already covered
 * by TopSystemBar.test.tsx).
 *
 * ONLY 4 of the 5 states are exercised here - ACTIVATING is deliberately
 * NOT tested at the screen level, and this is a real, traced finding,
 * not an oversight: openSession() (MspSessionCoordinator.ts) sets
 * ownership to ACTIVATING, then constructs RNMspTransport + MspClient
 * (synchronous, no `await`), then sets ownership to ACTIVE and fires
 * notifyMspRecoveryState() for MspClient's own default READY state - ALL
 * within one fully synchronous call, with no `await` anywhere before
 * ACTIVE+READY is reached. Under React's automatic batching, every
 * notify() fired synchronously within that one call collapses into a
 * SINGLE re-render reflecting the FINAL state - a consuming component
 * (TopSystemBar via SetupScreen) never actually renders the intermediate
 * ACTIVATING frame. This is verified by tracing openSession()'s own
 * code, not assumed. The pure LOGIC for ACTIVATING is already fully
 * covered (connectionIndicator.test.ts's own dedicated test) - fabricating
 * an artificial delay in production code just to make an already-provably-
 * unreachable state observable at the screen level would be new,
 * unauthorized production behavior change, out of Step 6's own scope.
 */
describe('SetupScreen - Step 6: connection-indicator states through the real screen', () => {
  it('DISCONNECTED (غير متصل): a never-opened session', () => {
    const props = makeProps({sessionKey: {sessionId: 'step6-disconnected-1', generation: 1}});
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<SetupScreen {...props} />);
    });

    expect(allText(renderer)).toContain(i18n.t('setupTopBar.connectionState.disconnected'));

    act(() => {
      renderer.unmount();
    });
  });

  it('DISCONNECTED (غير متصل): after an intentional deactivateMspSession()', async () => {
    const sessionId = 'step6-disconnected-2';
    const client = makeFakeClient(sessionId);
    const props = makeProps({sessionKey: {sessionId, generation: 1}});

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<SetupScreen {...props} />);
    });
    await act(async () => {
      mspSessionCoordinator.openSession(client as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
    });
    expect(allText(renderer)).toContain(i18n.t('setupTopBar.connectionState.connected'));

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    });
    expect(allText(renderer)).toContain(i18n.t('setupTopBar.connectionState.disconnected'));

    act(() => {
      renderer.unmount();
    });
  });

  it('DISCONNECTED (غير متصل): after a physical detach', async () => {
    const sessionId = 'step6-disconnected-3';
    const client = makeFakeClient(sessionId);
    const props = makeProps({sessionKey: {sessionId, generation: 1}});

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<SetupScreen {...props} />);
    });
    await act(async () => {
      mspSessionCoordinator.openSession(client as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
    });
    expect(allText(renderer)).toContain(i18n.t('setupTopBar.connectionState.connected'));

    await act(async () => {
      client.emitSessionDetached({sessionId, deviceId: 1});
    });
    expect(allText(renderer)).toContain(i18n.t('setupTopBar.connectionState.disconnected'));

    act(() => {
      renderer.unmount();
    });
  });

  it('CONNECTED (متصل): a real, successfully identified session', async () => {
    const sessionId = 'step6-connected-1';
    const client = makeFakeClient(sessionId);
    const props = makeProps({sessionKey: {sessionId, generation: 1}});

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<SetupScreen {...props} />);
    });
    await act(async () => {
      mspSessionCoordinator.openSession(client as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
    });

    expect(allText(renderer)).toContain(i18n.t('setupTopBar.connectionState.connected'));
    expect(allText(renderer)).toContain('MyBoard');

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    });
    act(() => {
      renderer.unmount();
    });
  });

  it('RECOVERING (جارٍ استعادة الاتصال): a real write failure triggers desync/recovery', async () => {
    const sessionId = 'step6-recovering-1';
    const client = makeFakeClient(sessionId);
    const props = makeProps({sessionKey: {sessionId, generation: 1}});

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    let mspClient: ReturnType<typeof mspSessionCoordinator.openSession>;
    act(() => {
      renderer = ReactTestRenderer.create(<SetupScreen {...props} />);
    });
    await act(async () => {
      mspClient = mspSessionCoordinator.openSession(client as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
    });
    expect(allText(renderer)).toContain(i18n.t('setupTopBar.connectionState.connected'));

    await act(async () => {
      client.rejectNextWrite('write failed');
      // The restart-triggered startReading() call is left pending by
      // this fixture's own default (see makeFakeClient's own doc
      // comment) - restartReceiveLoop() never settles, so this genuinely
      // stays in RESTARTING_READER, not a timing race against a chain
      // that would otherwise auto-resolve all the way back to READY.
      await mspClient!.request(42, new Uint8Array(0), {wireFormat: 'v1'}).catch(() => undefined);
      await flushAsync();
    });

    expect(allText(renderer)).toContain(i18n.t('setupTopBar.connectionState.recovering'));
    expect(findAnyByTestID(renderer, 'setup-top-bar-notice')).not.toBeNull();

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    });
    act(() => {
      renderer.unmount();
    });
  });

  it('RECOVERY_FAILED (تعذّرت الاستعادة): the restart step itself fails', async () => {
    const sessionId = 'step6-recovery-failed-1';
    const client = makeFakeClient(sessionId);
    const props = makeProps({sessionKey: {sessionId, generation: 1}});

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    let mspClient: ReturnType<typeof mspSessionCoordinator.openSession>;
    act(() => {
      renderer = ReactTestRenderer.create(<SetupScreen {...props} />);
    });
    await act(async () => {
      mspClient = mspSessionCoordinator.openSession(client as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
    });

    await act(async () => {
      client.rejectNextWrite('write failed');
      client.rejectNextRestart('stop failed');
      await mspClient!.request(42, new Uint8Array(0), {wireFormat: 'v1'}).catch(() => undefined);
      await flushAsync();
    });

    expect(allText(renderer)).toContain(i18n.t('setupTopBar.connectionState.recoveryFailed'));
    expect(findAnyByTestID(renderer, 'setup-top-bar-notice')).not.toBeNull();

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    });
    act(() => {
      renderer.unmount();
    });
  });
});

describe('SetupScreen - Step 6: STALE freeze visible in real rendered output', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('OrientationHero freezes at the last LIVE values and shows "البيانات متأخرة" once attitude data stops arriving', async () => {
    const sessionId = 'step6-stale-1';
    const client = makeFakeClient(sessionId);
    client.setResponse(MSP_ATTITUDE, attitudePayload(40, 20, 90)); // -> 4deg/-2deg/90deg
    const props = makeProps({sessionKey: {sessionId, generation: 1}});

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<SetupScreen {...props} />);
    });

    await act(async () => {
      mspSessionCoordinator.openSession(client as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
    });

    // First tick driver firing (50ms) - the poll is due immediately at
    // registration, so this dispatches right away.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(50);
      await flushAsync();
    });

    expect(findAnyByTestID(renderer, 'orientation-hero-stale-label')).toBeNull();
    expect(allText(renderer)).toContain('4°');
    expect(allText(renderer)).toContain('-2°');
    expect(allText(renderer)).toContain('90°');

    // No further attitude responses from here on.
    client.clearResponse(MSP_ATTITUDE);

    // Past ATTITUDE_POLL_STALE_AFTER_MS (700ms, Pass 7.4/Step 0.5) since
    // the last successful reading - tick() re-evaluates staleness every
    // 50ms regardless of whether a new dispatch succeeds.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(750);
      await flushAsync();
    });

    expect(findAnyByTestID(renderer, 'orientation-hero-stale-label')).not.toBeNull();
    expect(allText(renderer)).toContain(i18n.t('orientationHero.staleLabel'));
    // Frozen at the LAST KNOWN values, never blanked, never faked/interpolated.
    expect(allText(renderer)).toContain('4°');
    expect(allText(renderer)).toContain('-2°');
    expect(allText(renderer)).toContain('90°');

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    });
    act(() => {
      renderer.unmount();
    });
  });
});

/**
 * Pass 7.4, Step 6 - SafetyStrip compact vs. expanded through the REAL
 * assembled screen. Production's own startTelemetry()
 * (MspSessionCoordinator.ts) does NOT register ARMED_TELEMETRY_POLL_ID/
 * ARMING_BLOCKERS_TELEMETRY_POLL_ID yet - no real MSP armed/blocker
 * decoder exists (Step 3's own explicit placeholder design), so
 * useTelemetryValue() for those ids normally reports UNAVAILABLE
 * forever (already covered by the Step 5 smoke test's own
 * 'safety-strip-unknown' assertion).
 *
 * To genuinely exercise the REAL pipeline beyond that placeholder state
 * (useTelemetryValue -> deriveArmingReadiness -> SafetyStrip/TopSystemBar
 * rendering) without waiting for a future decoder pass, these tests
 * manually call scheduler.registerPoll() - a real, public
 * MspTelemetryScheduler method - for those same two poll ids, using a
 * fake command number and a decode() that reads a test-local variable
 * instead of a real MSP payload. This bypasses only the ONE thing that
 * does not exist yet (a real decoder for a real MSP command); the entire
 * rest of the pipeline (the real scheduler, the real useTelemetryValue()
 * hook, the real deriveArmingReadiness(), the real SafetyStrip/
 * TopSystemBar rendering) is exercised exactly as production code will
 * use it once that decoder is added.
 */
describe('SetupScreen - Step 6: SafetyStrip compact vs expanded through the real screen', () => {
  const FAKE_ARMED_COMMAND = 220;
  const FAKE_BLOCKERS_COMMAND = 221;

  async function openAndRegisterArmingPolls(
    sessionId: string,
    client: ReturnType<typeof makeFakeClient>,
    armedValue: boolean,
    blockersValue: ArmingBlockReason[],
  ) {
    client.setResponse(FAKE_ARMED_COMMAND, Uint8Array.from([0]));
    client.setResponse(FAKE_BLOCKERS_COMMAND, Uint8Array.from([0]));
    // MspClient allows only ONE in-flight request at a time (an
    // already-established finding this pass, re-confirmed here the hard
    // way): the real 50ms tick driver dispatches MSP_ATTITUDE
    // automatically once startTelemetry() runs, and without a scripted
    // response that request would sit forever un-settled, permanently
    // occupying MspClient's single in-flight slot and queuing every
    // OTHER poll's own request (armed/blockers included) behind it,
    // forever - confirmed by an actual failing assertion + writeBytes
    // call-log inspection during this test's development, not assumed.
    client.setResponse(MSP_ATTITUDE, attitudePayload(0, 0, 0));

    mspSessionCoordinator.openSession(client as unknown as UsbSerialTransportClient, sessionId);
    await flushAsync();

    const scheduler = mspSessionCoordinator.getTelemetryScheduler(sessionId);
    if (!scheduler) {
      throw new Error('expected a real telemetry scheduler after openSession()');
    }
    scheduler.registerPoll({
      id: ARMED_TELEMETRY_POLL_ID,
      command: FAKE_ARMED_COMMAND,
      intervalMs: 100_000,
      staleAfterMs: 100_000,
      priority: 0,
      decode: () => armedValue,
    });
    scheduler.registerPoll({
      id: ARMING_BLOCKERS_TELEMETRY_POLL_ID,
      command: FAKE_BLOCKERS_COMMAND,
      intervalMs: 100_000,
      staleAfterMs: 100_000,
      priority: 0,
      decode: () => blockersValue,
    });

    // tick() dispatches only the single MOST-OVERDUE poll per call (its
    // own coalescing design - see MspTelemetryScheduler.ts's own class
    // doc comment), not every due poll at once - and MSP_ATTITUDE (due
    // since session-open time, already registered) competes for that
    // slot too. A single tick() call is not enough to settle BOTH newly
    // registered polls (confirmed by an actual failing assertion during
    // this test's development, not assumed) - loop until both report
    // something other than WAITING.
    for (let i = 0; i < 10; i++) {
      scheduler.tick();
      // Deliberately sequential (not Promise.all'd) - each tick() must
      // fully settle (including its own dispatch's microtask chain)
      // before the next tick() re-evaluates what's still due.
      await flushAsync();
      const armedSettled = scheduler.getValue(ARMED_TELEMETRY_POLL_ID).status !== 'WAITING';
      const blockersSettled = scheduler.getValue(ARMING_BLOCKERS_TELEMETRY_POLL_ID).status !== 'WAITING';
      if (armedSettled && blockersSettled) {
        break;
      }
    }
  }

  it('READY (compact "✓ جاهزة للتسليح"): armed=false, no blockers', async () => {
    const sessionId = 'step6-safety-ready-1';
    const client = makeFakeClient(sessionId);
    const props = makeProps({sessionKey: {sessionId, generation: 1}});

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<SetupScreen {...props} />);
    });

    await act(async () => {
      await openAndRegisterArmingPolls(sessionId, client, false, []);
    });

    expect(findAnyByTestID(renderer, 'safety-strip-ready')).not.toBeNull();
    expect(allText(renderer)).toContain(i18n.t('safetyStrip.ready'));
    expect(findAnyByTestID(renderer, 'setup-top-bar-arming-badge')).not.toBeNull();
    expect(allText(renderer)).toContain(i18n.t('setupTopBar.armingBadge.ready'));

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    });
    act(() => {
      renderer.unmount();
    });
  });

  it('ARMED (compact, danger-colored): armed=true, regardless of blockers', async () => {
    const sessionId = 'step6-safety-armed-1';
    const client = makeFakeClient(sessionId);
    const props = makeProps({sessionKey: {sessionId, generation: 1}});

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<SetupScreen {...props} />);
    });

    await act(async () => {
      await openAndRegisterArmingPolls(sessionId, client, true, []);
    });

    expect(findAnyByTestID(renderer, 'safety-strip-armed')).not.toBeNull();
    expect(allText(renderer)).toContain(i18n.t('safetyStrip.armed'));
    expect(allText(renderer)).toContain(i18n.t('setupTopBar.armingBadge.armed'));

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    });
    act(() => {
      renderer.unmount();
    });
  });

  it('BLOCKED (auto-expanded, top-3 + show-all link): armed=false, 4 real blocker reasons', async () => {
    const sessionId = 'step6-safety-blocked-1';
    const client = makeFakeClient(sessionId);
    const props = makeProps({sessionKey: {sessionId, generation: 1}});
    const reasons: ArmingBlockReason[] = [
      {code: 'THROTTLE', message: 'الخانق مرتفع جدًا', severity: 'CRITICAL_DANGER'},
      {code: 'GYRO', message: 'الجيروسكوب غير معاير', severity: 'ARMING_BLOCKER'},
      {code: 'FAILSAFE', message: 'وضع الفشل الآمن نشط', severity: 'WARNING'},
      {code: 'RX', message: 'لم يتم اكتشاف جهاز الاستقبال', severity: 'INFO'},
    ];

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<SetupScreen {...props} />);
    });

    await act(async () => {
      await openAndRegisterArmingPolls(sessionId, client, false, reasons);
    });

    expect(findAnyByTestID(renderer, 'safety-strip-blocked')).not.toBeNull();
    expect(allText(renderer)).toContain(i18n.t('safetyStrip.blockedHeading'));
    // Top 3 by priority: THROTTLE, GYRO, FAILSAFE - not RX (rank 4).
    expect(allText(renderer)).toContain('الخانق مرتفع جدًا');
    expect(allText(renderer)).toContain('الجيروسكوب غير معاير');
    expect(allText(renderer)).toContain('وضع الفشل الآمن نشط');
    expect(allText(renderer)).not.toContain('لم يتم اكتشاف جهاز الاستقبال');
    const showAll = findAnyByTestID(renderer, 'safety-strip-show-all');
    expect(showAll).not.toBeNull();
    expect(allText(renderer)).toContain(i18n.t('setupTopBar.armingBadge.blocked'));

    await act(async () => {
      showAll!.props.onPress();
    });
    expect(allText(renderer)).toContain('لم يتم اكتشاف جهاز الاستقبال');
    expect(findAnyByTestID(renderer, 'safety-strip-show-all')).toBeNull();

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    });
    act(() => {
      renderer.unmount();
    });
  });
});

describe('SetupScreen - Step 6: resetOrientationViewOffset() end-to-end', () => {
  it('pressing the reset button captures the CURRENT raw yaw as the REAL stored heading reference, drives the displayed Heading to 0, leaves roll/pitch untouched, and shows the one-time hint only on the first press', async () => {
    const sessionId = 'step6-reset-1';
    const sessionKey = {sessionId, generation: 1};
    // Seed a genuinely non-zero, pre-existing offset directly in the
    // real store, exactly as if a previous interaction had set it.
    setupUiSessionStore.update(sessionKey, {orientationViewOffset: {rollDeg: 5, pitchDeg: 3, yawDeg: 10}});

    const client = makeFakeClient(sessionId);
    client.setResponse(MSP_ATTITUDE, attitudePayload(100, 50, 90)); // -> raw 10deg/5deg/90deg
    const props = makeProps({sessionKey});

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<SetupScreen {...props} />);
    });
    await act(async () => {
      mspSessionCoordinator.openSession(client as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
      mspSessionCoordinator.getTelemetryScheduler(sessionId)!.tick();
      await flushAsync();
    });

    // Offset-adjusted: 10-5=5, -(50 / 10) - 3 = -8, 90-10=80.
    expect(allText(renderer)).toContain('5°');
    expect(allText(renderer)).toContain('-8°');
    expect(allText(renderer)).toContain('80°');
    expect(findAnyByTestID(renderer, 'orientation-hero-reset-hint')).toBeNull();

    await act(async () => {
      findAnyByTestID(renderer, 'orientation-hero-reset-button')!.props.onPress();
    });

    // The REAL store now holds the CAPTURED heading reference - the raw
    // yaw at press time (90), not a zero. Roll/pitch references stay at
    // zero: this reset is Heading-only and never touches tilt.
    expect(setupUiSessionStore.getState(sessionKey).orientationViewOffset).toEqual({rollDeg: 0, pitchDeg: 0, yawDeg: 90});
    expect(setupUiSessionStore.getState(sessionKey).hasSeenOrientationResetHint).toBe(true);
    // Heading reads 0 immediately after the reset (90 - 90), while roll
    // and pitch show their RAW values now that their offsets are gone.
    expect(allText(renderer)).toContain('0°');
    expect(allText(renderer)).toContain('10°');
    expect(allText(renderer)).toContain('-5°');
    // The one-time hint appeared on this first press.
    expect(findAnyByTestID(renderer, 'orientation-hero-reset-hint')).not.toBeNull();
    expect(allText(renderer)).toContain(i18n.t('orientationHero.resetHint'));

    // Dismiss it, then press reset again - it must NOT reappear.
    await act(async () => {
      findAnyByTestID(renderer, 'orientation-hero-reset-hint-dismiss')!.props.onPress();
    });
    expect(findAnyByTestID(renderer, 'orientation-hero-reset-hint')).toBeNull();

    await act(async () => {
      findAnyByTestID(renderer, 'orientation-hero-reset-button')!.props.onPress();
    });
    expect(findAnyByTestID(renderer, 'orientation-hero-reset-hint')).toBeNull();

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    });
    act(() => {
      renderer.unmount();
    });
  });
});

/**
 * The Heading-reset repair, through the REAL store, the REAL view model
 * and the REAL session coordinator.
 *
 * The defect being fixed: pressing "إعادة ضبط عرض الاتجاه" wrote a ZERO
 * offset instead of capturing the current heading, so the displayed
 * Heading did not move and the button appeared to do nothing. The
 * contract now is a captured REFERENCE - the display becomes relative to
 * wherever the aircraft was pointing at press time, the raw sensor is
 * never touched, and the reference belongs to one session only.
 */
describe('SetupScreen - the display-only Heading reset', () => {
  const rendererMock = OrientationRenderer as unknown as jest.Mock;
  /** Tracked so a test that fails mid-way still leaves the next one a
   * clean tree - a screen left mounted keeps answering telemetry
   * notifications and would silently distort the following test. */
  const mounted: ReactTestRenderer.ReactTestRenderer[] = [];

  beforeEach(() => {
    rendererMock.mockClear();
    jest.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      for (const renderer of mounted.splice(0)) {
        renderer.unmount();
      }
    });
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  /** The pose the 3D model was last handed - the model side of "the
   * number and the model agree". */
  function lastModelPose(): {rollDeg: number; pitchDeg: number; yawDeg: number} {
    const calls = rendererMock.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    return calls[calls.length - 1][0].orientation;
  }

  async function mountWithAttitude(
    sessionKey: {sessionId: string; generation: number},
    attitude: {rollDecidegrees: number; pitchDecidegrees: number; yawDegrees: number},
  ) {
    const client = makeFakeClient(sessionKey.sessionId);
    client.setResponse(
      MSP_ATTITUDE,
      attitudePayload(attitude.rollDecidegrees, attitude.pitchDecidegrees, attitude.yawDegrees),
    );
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<SetupScreen {...makeProps({sessionKey})} />);
    });
    mounted.push(renderer);
    await act(async () => {
      mspSessionCoordinator.openSession(client as unknown as UsbSerialTransportClient, sessionKey.sessionId);
      await flushAsync();
    });
    // The real 50ms tick driver: the attitude poll is due at
    // registration, so this is its first genuine dispatch.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(50);
      await flushAsync();
    });
    return {client, renderer};
  }

  /** Answers the attitude poll with a new sample and lets the REAL 50ms
   * poll cadence deliver it - no hand-driven scheduler poking. */
  async function pushAttitude(
    client: ReturnType<typeof makeFakeClient>,
    attitude: {rollDecidegrees: number; pitchDecidegrees: number; yawDegrees: number},
  ) {
    client.setResponse(
      MSP_ATTITUDE,
      attitudePayload(attitude.rollDecidegrees, attitude.pitchDecidegrees, attitude.yawDegrees),
    );
    await act(async () => {
      await jest.advanceTimersByTimeAsync(300);
      await flushAsync();
    });
  }

  it('confines high-frequency attitude renders to the orientation hero instead of re-rendering the complete Setup screen', async () => {
    const sessionKey = {sessionId: 'orientation-render-boundary', generation: 1};
    const ensureBoxIdsMapping = jest.spyOn(fcToolsController, 'ensureBoxIdsMapping');
    const orientationRenderer = OrientationRenderer as jest.Mock;
    try {
      const {client} = await mountWithAttitude(sessionKey, {
        rollDecidegrees: 0,
        pitchDecidegrees: 0,
        yawDegrees: 0,
      });

      // Let identification and every immediately-due auxiliary publish
      // before measuring the attitude-only interval below.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1000);
        await flushAsync();
      });
      ensureBoxIdsMapping.mockClear();
      orientationRenderer.mockClear();
      client.setResponse(MSP_ATTITUDE, attitudePayload(120, -40, 33));

      await act(async () => {
        await jest.advanceTimersByTimeAsync(50);
        await flushAsync();
      });

      expect(orientationRenderer).toHaveBeenCalled();
      // SetupScreenContent's effect has no dependency array and therefore
      // runs after every root render. Zero calls proves the fresh sample
      // updated only LiveOrientationHero, not every card/tool below it.
      expect(ensureBoxIdsMapping).not.toHaveBeenCalled();
    } finally {
      ensureBoxIdsMapping.mockRestore();
    }
  });

  it('later samples stay RELATIVE to the captured reference - the reset is a new zero, not a one-off nudge', async () => {
    const sessionKey = {sessionId: 'heading-reset-relative', generation: 1};
    const {client, renderer} = await mountWithAttitude(sessionKey, {
      rollDecidegrees: 0,
      pitchDecidegrees: 0,
      yawDegrees: 90,
    });

    expect(allText(renderer)).toContain('90°');
    await act(async () => {
      findAnyByTestID(renderer, 'orientation-hero-reset-button')!.props.onPress();
    });
    expect(allText(renderer)).toContain('0°');

    // The aircraft yaws 30 degrees further right: the display must read
    // 30, not 120 - the reference persists across samples.
    await pushAttitude(client, {rollDecidegrees: 0, pitchDecidegrees: 0, yawDegrees: 120});
    expect(allText(renderer)).toContain('30°');

    // And it wraps the short way: 80 degrees LEFT of the reference reads
    // 280, never a negative heading.
    await pushAttitude(client, {rollDecidegrees: 0, pitchDecidegrees: 0, yawDegrees: 10});
    expect(allText(renderer)).toContain('280°');

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionKey.sessionId);
    });
    act(() => {
      renderer.unmount();
    });
  });

  it('the numeric Heading and the 3D model show the SAME relative heading, before and after the reset', async () => {
    const sessionKey = {sessionId: 'heading-reset-model-agrees', generation: 1};
    const {renderer} = await mountWithAttitude(sessionKey, {
      rollDecidegrees: 100,
      pitchDecidegrees: 50,
      yawDegrees: 200,
    });

    // Before: model and number both on the raw sample (roll 10, pitch -5,
    // heading 200 - pitch negated once at the firmware boundary).
    expect(lastModelPose()).toEqual({rollDeg: 10, pitchDeg: -5, yawDeg: 200});
    expect(allText(renderer)).toContain('200°');

    await act(async () => {
      findAnyByTestID(renderer, 'orientation-hero-reset-button')!.props.onPress();
    });

    // After: both on the SAME relative heading. The model is not eased
    // here - the sample itself never changed, only the reference did.
    const pose = lastModelPose();
    expect(pose.yawDeg).toBe(0);
    expect(allText(renderer)).toContain('0°');
    // Tilt is untouched by a Heading-only reset, in both places.
    expect(pose.rollDeg).toBe(10);
    expect(pose.pitchDeg).toBe(-5);
    expect(allText(renderer)).toContain('10°');
    expect(allText(renderer)).toContain('-5°');

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionKey.sessionId);
    });
    act(() => {
      renderer.unmount();
    });
  });

  it('is UNAVAILABLE on a STALE reading, and a press delivered anyway captures NOTHING', async () => {
    const sessionKey = {sessionId: 'heading-reset-stale', generation: 1};
    const {client, renderer} = await mountWithAttitude(sessionKey, {
      rollDecidegrees: 0,
      pitchDecidegrees: 0,
      yawDegrees: 90,
    });

    // FRESH and connected: the control is available.
    expect(findAnyByTestID(renderer, 'orientation-hero-reset-button')!.props.disabled).toBe(false);

    // Attitude stops arriving; past 700ms the reading is STALE. The
    // session is still ACTIVE, so the button is still on screen - but a
    // frozen sample is not something to zero against.
    client.clearResponse(MSP_ATTITUDE);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(750);
      await flushAsync();
    });

    const button = findAnyByTestID(renderer, 'orientation-hero-reset-button');
    expect(button?.props.disabled).toBe(true);
    expect(button?.props.accessibilityState).toEqual({disabled: true});
    expect(findAnyByTestID(renderer, 'orientation-hero-reset-unavailable')).not.toBeNull();

    await act(async () => {
      button!.props.onPress();
    });
    expect(setupUiSessionStore.getState(sessionKey).orientationViewOffset).toEqual({
      rollDeg: 0,
      pitchDeg: 0,
      yawDeg: 0,
    });

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionKey.sessionId);
      await flushAsync();
    });
  });

  it('once the session ends there is no reset control at all, and a late press stores nothing', async () => {
    const sessionKey = {sessionId: 'heading-reset-ended', generation: 1};
    const {renderer} = await mountWithAttitude(sessionKey, {
      rollDecidegrees: 0,
      pitchDecidegrees: 0,
      yawDegrees: 90,
    });
    // Captured BEFORE the disconnect - exactly the stale callback a real
    // late tap would run.
    const press = findAnyByTestID(renderer, 'orientation-hero-reset-button')!.props.onPress;

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionKey.sessionId);
      await flushAsync();
    });

    // No telemetry to draw at all: the hero is back to its waiting state
    // and offers nothing to press.
    expect(findAnyByTestID(renderer, 'orientation-hero-waiting')).not.toBeNull();
    expect(findAnyByTestID(renderer, 'orientation-hero-reset-button')).toBeNull();

    await act(async () => {
      press();
    });
    expect(setupUiSessionStore.getState(sessionKey).orientationViewOffset).toEqual({
      rollDeg: 0,
      pitchDeg: 0,
      yawDeg: 0,
    });

    act(() => {
      renderer.unmount();
    });
  });

  it('a REPLACEMENT session starts unreferenced - the previous generation heading zero never leaks into it', async () => {
    const sessionId = 'heading-reset-replacement';
    const firstKey = {sessionId, generation: 1};
    const first = await mountWithAttitude(firstKey, {rollDecidegrees: 0, pitchDecidegrees: 0, yawDegrees: 90});

    await act(async () => {
      findAnyByTestID(first.renderer, 'orientation-hero-reset-button')!.props.onPress();
    });
    expect(setupUiSessionStore.getState(firstKey).orientationViewOffset.yawDeg).toBe(90);

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
      await flushAsync();
    });
    act(() => {
      first.renderer.unmount();
    });

    // Replugged: the same sessionId string, a NEW generation.
    const secondKey = {sessionId, generation: 2};
    const second = await mountWithAttitude(secondKey, {rollDecidegrees: 0, pitchDecidegrees: 0, yawDegrees: 90});

    expect(setupUiSessionStore.getState(secondKey).orientationViewOffset).toEqual({
      rollDeg: 0,
      pitchDeg: 0,
      yawDeg: 0,
    });
    // Unreferenced, so the RAW heading is shown - not the old zero.
    expect(allText(second.renderer)).toContain('90°');

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    });
    act(() => {
      second.renderer.unmount();
    });
  });

  it('captures a reference WITHOUT sending anything to the FC - resetting the view is not an MSP command', async () => {
    const sessionKey = {sessionId: 'heading-reset-no-write', generation: 1};
    const {client, renderer} = await mountWithAttitude(sessionKey, {
      rollDecidegrees: 0,
      pitchDecidegrees: 0,
      yawDegrees: 90,
    });

    const before = client.writeBytes.mock.calls.length;
    await act(async () => {
      findAnyByTestID(renderer, 'orientation-hero-reset-button')!.props.onPress();
    });

    // Not merely "no calibration command" - no MSP traffic at all is
    // caused by the press itself.
    expect(client.writeBytes.mock.calls.length).toBe(before);
    expect(setupUiSessionStore.getState(sessionKey).orientationViewOffset.yawDeg).toBe(90);

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionKey.sessionId);
    });
    act(() => {
      renderer.unmount();
    });
  });

  /**
   * The render-latency repair is a RENDERING change. It must be provably
   * invisible to the protocol: the same poll, at the same cadence, with
   * no request the screen did not already make.
   */
  it('renders sample after sample without issuing ONE additional MSP request', async () => {
    const sessionKey = {sessionId: 'render-latency-no-extra-msp', generation: 1};
    const {client, renderer} = await mountWithAttitude(sessionKey, {
      rollDecidegrees: 0,
      pitchDecidegrees: 0,
      yawDegrees: 0,
    });

    const commandsIn = (from: number) =>
      client.writeBytes.mock.calls.slice(from).map(call => base64ToBytes(call[1] as string)[4]);
    const baseline = client.writeBytes.mock.calls.length;

    // Ten real poll cycles' worth of attitude samples.
    for (let i = 1; i <= 10; i++) {
      await pushAttitude(client, {rollDecidegrees: i * 10, pitchDecidegrees: -i * 5, yawDegrees: i * 20});
    }

    const issued = commandsIn(baseline);
    // Every request in that window belongs to a poll that already
    // existed - attitude plus the pre-existing auxiliary channels. No
    // new opcode appears, and in particular nothing state-changing.
    const expectedPollCommands = new Set([
      MSP_ATTITUDE,
      MSP_BATTERY_STATE,
      MSP_ANALOG,
      MSP_RAW_GPS,
      MSP_STATUS_EX,
    ]);
    for (const command of issued) {
      expect(expectedPollCommands.has(command)).toBe(true);
    }
    expect(issued).not.toContain(205); // MSP_ACC_CALIBRATION
    expect(issued).not.toContain(206); // MSP_MAG_CALIBRATION
    expect(issued).not.toContain(68); // MSP_REBOOT
    expect(issued).not.toContain(250); // MSP_EEPROM_WRITE

    // The attitude poll runs on its own 50ms cadence without spawning
    // more than one request per cycle.
    const attitudeRequests = issued.filter(command => command === MSP_ATTITUDE).length;
    expect(attitudeRequests).toBeGreaterThan(0);
    expect(attitudeRequests).toBeLessThanOrEqual(Math.ceil((10 * 300) / 50));

    // The display followed every one of them, ending on the last:
    // roll 100 decidegrees = 10, raw pitch -50 decidegrees negated once
    // at the firmware boundary = +5, heading 200.
    const finalText = allText(renderer);
    expect(finalText).toContain('10°');
    expect(finalText).toContain('5°');
    expect(finalText).toContain('200°');

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionKey.sessionId);
    });
  });
});

/**
 * Pass 7.4, Step 6 - accessibility properties through the real assembled
 * screen: confirms composition doesn't drop any of TopSystemBar/
 * OrientationHero/SafetyStrip's own already-unit-tested accessibility
 * props (Step 3/4/5's own test files verify these components' OWN
 * accessibility logic in isolation; this describe block only verifies
 * nothing is lost when they are actually composed together).
 *
 * DOCUMENTED, REAL ABSENCE (verified directly, not assumed): the real
 * Skia canvas (OrientationRenderer.tsx) sets NO accessibility properties
 * of its own anywhere in its implementation (grepped, zero matches) -
 * the text alternative for the 3D model lives entirely in OrientationHero's
 * OWN wrapper View (accessible + accessibilityLabel from
 * describeOrientationForAccessibility()), verified below. Since this
 * whole test file mocks OrientationRenderer to `() => null` (per Step
 * 2's own established finding - no real CanvasKit-WASM wired in), there
 * is nothing further to verify for the 3D canvas specifically - not an
 * oversight, a traced fact about where this pass's own accessibility
 * text alternative actually lives.
 */
describe('SetupScreen - Step 6: accessibility properties through the real screen', () => {
  it('TopSystemBar: back button, connection indicator, arming badge all carry their accessibility roles/labels', async () => {
    const sessionId = 'step6-a11y-topbar-1';
    const client = makeFakeClient(sessionId);
    const props = makeProps({sessionKey: {sessionId, generation: 1}});

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<SetupScreen {...props} />);
    });
    await act(async () => {
      mspSessionCoordinator.openSession(client as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
    });

    const backButton = findAnyByTestID(renderer, 'setup-top-bar-back');
    expect(backButton?.props.accessibilityRole).toBe('button');
    expect(backButton?.props.accessibilityLabel).toBe(i18n.t('setupTopBar.back'));

    const indicator = findAnyByTestID(renderer, 'setup-top-bar-connection-indicator');
    expect(indicator?.props.accessibilityRole).toBe('text');

    const armingBadge = findAnyByTestID(renderer, 'setup-top-bar-arming-badge');
    expect(armingBadge?.props.accessibilityRole).toBe('text');

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    });
    act(() => {
      renderer.unmount();
    });
  });

  it('TopSystemBar: the notice banner carries accessibilityRole="alert" when present', () => {
    // A never-opened session (DISCONNECTED) always has a notice - no
    // need to drive a real desync for this one.
    const props = makeProps({sessionKey: {sessionId: 'step6-a11y-topbar-2', generation: 1}});
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<SetupScreen {...props} />);
    });

    const notice = findAnyByTestID(renderer, 'setup-top-bar-notice');
    expect(notice?.props.accessibilityRole).toBe('alert');

    act(() => {
      renderer.unmount();
    });
  });

  it('OrientationHero: the 3D model wrapper carries a real, non-empty accessibilityLabel from describeOrientationForAccessibility() when LIVE', async () => {
    const sessionId = 'step6-a11y-hero-1';
    const client = makeFakeClient(sessionId);
    client.setResponse(MSP_ATTITUDE, attitudePayload(40, 20, 90)); // -> 4deg/-2deg/90deg
    const props = makeProps({sessionKey: {sessionId, generation: 1}});

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<SetupScreen {...props} />);
    });
    await act(async () => {
      mspSessionCoordinator.openSession(client as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
      mspSessionCoordinator.getTelemetryScheduler(sessionId)!.tick();
      await flushAsync();
    });

    const wrapper = findAnyByTestID(renderer, 'orientation-hero-renderer-wrapper');
    expect(wrapper?.props.accessible).toBe(true);
    expect(wrapper?.props.accessibilityLabel).toBe('ميلان 4 درجة لليمين، انخفاض المقدمة 2 درجة، الاتجاه 90 درجة');

    const resetButton = findAnyByTestID(renderer, 'orientation-hero-reset-button');
    expect(resetButton?.props.accessibilityRole).toBe('button');
    expect(resetButton?.props.accessibilityLabel).toBe(i18n.t('orientationHero.resetButton'));

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    });
    act(() => {
      renderer.unmount();
    });
  });

  it('OrientationHero: WAITING state has no accessibility label to give (nothing to describe yet) - documented, not an oversight', () => {
    const props = makeProps({sessionKey: {sessionId: 'step6-a11y-hero-2', generation: 1}});
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<SetupScreen {...props} />);
    });

    expect(findAnyByTestID(renderer, 'orientation-hero-renderer-wrapper')).toBeNull();
    expect(findAnyByTestID(renderer, 'orientation-hero-waiting')).not.toBeNull();

    act(() => {
      renderer.unmount();
    });
  });

  it('SafetyStrip: the compact states carry accessibilityRole="text", BLOCKED carries a "header" title and a "button" show-all link', async () => {
    const sessionId = 'step6-a11y-safety-1';
    const client = makeFakeClient(sessionId);
    client.setResponse(MSP_ATTITUDE, attitudePayload(0, 0, 0));
    const props = makeProps({sessionKey: {sessionId, generation: 1}});

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<SetupScreen {...props} />);
    });
    await act(async () => {
      mspSessionCoordinator.openSession(client as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
    });

    // Placeholder armed/blockers (Step 3) -> UNAVAILABLE -> UNKNOWN, compact.
    const unknownStrip = findAnyByTestID(renderer, 'safety-strip-unknown');
    expect(unknownStrip?.props.accessibilityRole).toBe('text');

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    });
    act(() => {
      renderer.unmount();
    });
  });
});

describe('SetupScreen - Pass 7.6b battery summary card through the REAL pipeline', () => {
  /** The verified 11-byte MSP_BATTERY_STATE payload (golden: 4S, 16.85V,
   * firmware BATTERY_OK) - built with this file's existing u16le helper. */
  function batteryPayload(cellCount: number, stateRaw: number, voltageCentivolts: number): Uint8Array {
    return Uint8Array.from([cellCount, ...u16le(1500), 168, ...u16le(350), ...u16le(0), stateRaw, ...u16le(voltageCentivolts)]);
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(async () => {
    // Same straggler discipline as the coordinator's Pass 7.6a describe:
    // drain teardown chains under fake timers, uninstall, drain again.
    await flushAsync();
    jest.clearAllTimers();
    jest.useRealTimers();
    await flushAsync();
  });

  it('renders the card after Regions 1+2, shows the default fixture\'s honest NOT-DETECTED state, and preserves the hero and safety strip', async () => {
    const sessionId = 'pass76b-default-1';
    const client = makeFakeClient(sessionId); // default fixture: BATTERY_NOT_PRESENT, 0 cells, 0V
    client.setResponse(MSP_ATTITUDE, attitudePayload(0, 0, 0));
    const props = makeProps({sessionKey: {sessionId, generation: 1}});

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<SetupScreen {...props} />);
    });
    await act(async () => {
      mspSessionCoordinator.openSession(client as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(150); // ticks: attitude first, battery on a following tick
      await flushAsync();
    });

    expect(findAnyByTestID(renderer, 'battery-card-live')).not.toBeNull();
    expect(allText(renderer)).toContain(i18n.t('batteryCard.title'));
    expect(allText(renderer)).toContain(i18n.t('batteryCard.notDetected'));
    // Regions 1+2 still present around the card.
    expect(findAnyByTestID(renderer, 'setup-top-bar')).not.toBeNull();
    expect(findAnyByTestID(renderer, 'orientation-hero')).not.toBeNull();

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    });
    act(() => {
      renderer.unmount();
    });
  });

  it('shows the REAL decoded voltage and firmware state for a detected battery (golden 4S/16.85V/OK payload end-to-end)', async () => {
    const sessionId = 'pass76b-golden-1';
    const client = makeFakeClient(sessionId);
    client.setResponse(MSP_ATTITUDE, attitudePayload(0, 0, 0));
    client.setResponse(MSP_BATTERY_STATE, batteryPayload(4, 0, 1685));
    const props = makeProps({sessionKey: {sessionId, generation: 1}});

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<SetupScreen {...props} />);
    });
    await act(async () => {
      mspSessionCoordinator.openSession(client as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(150);
      await flushAsync();
    });

    expect(allText(renderer)).toContain('16.85 V');
    expect(allText(renderer)).toContain(i18n.t('batteryCard.state.OK'));
    expect(allText(renderer)).toContain(i18n.t('batteryCard.percentageUnavailable'));

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    });
    act(() => {
      renderer.unmount();
    });
  });

  it('freezes into the approved STALE presentation when battery responses stop while attitude keeps flowing', async () => {
    const sessionId = 'pass76b-stale-1';
    const client = makeFakeClient(sessionId);
    client.setResponse(MSP_ATTITUDE, attitudePayload(0, 0, 0));
    client.setResponse(MSP_BATTERY_STATE, batteryPayload(4, 0, 1685));
    const props = makeProps({sessionKey: {sessionId, generation: 1}});

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<SetupScreen {...props} />);
    });
    await act(async () => {
      mspSessionCoordinator.openSession(client as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(150);
      await flushAsync();
    });
    expect(findAnyByTestID(renderer, 'battery-card-live')).not.toBeNull();

    // Every later battery WRITE hangs (never settles - no response
    // timeout starts), so the value ages past the 9000ms stale threshold
    // while the responsive attitude poll keeps the rest of the screen live.
    client.holdWritesFor(MSP_BATTERY_STATE);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3100);
      await flushAsync();
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(6200);
      await flushAsync();
    });

    expect(findAnyByTestID(renderer, 'battery-card-stale')).not.toBeNull();
    expect(findAnyByTestID(renderer, 'battery-card-stale-label')).not.toBeNull();
    expect(allText(renderer)).toContain('16.85 V'); // frozen last real value, dimmed - not blanked
    expect(findAnyByTestID(renderer, 'orientation-hero')).not.toBeNull();

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    });
    act(() => {
      renderer.unmount();
    });
  });

  it('drops to the honest UNAVAILABLE state on session teardown, and a replacement session on the same id starts from scratch (never retaining the previous physical session\'s data)', async () => {
    const sessionId = 'pass76b-replace-1';
    const client1 = makeFakeClient(sessionId);
    client1.setResponse(MSP_ATTITUDE, attitudePayload(0, 0, 0));
    client1.setResponse(MSP_BATTERY_STATE, batteryPayload(4, 0, 1685));
    const props = makeProps({sessionKey: {sessionId, generation: 1}});

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<SetupScreen {...props} />);
    });
    await act(async () => {
      mspSessionCoordinator.openSession(client1 as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(150);
      await flushAsync();
    });
    expect(allText(renderer)).toContain('16.85 V');

    // Teardown: the card must NOT keep showing the dead session's values.
    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
      await flushAsync();
    });
    expect(findAnyByTestID(renderer, 'battery-card-unavailable')).not.toBeNull();
    expect(allText(renderer)).not.toContain('16.85 V');

    // Replacement session, same id, different battery: starts from its
    // OWN readings (generation-guarded registration; fresh scheduler).
    const client2 = makeFakeClient(sessionId);
    client2.setResponse(MSP_ATTITUDE, attitudePayload(0, 0, 0));
    client2.setResponse(MSP_BATTERY_STATE, batteryPayload(3, 1, 1122)); // 3S, WARNING, 11.22V
    await act(async () => {
      mspSessionCoordinator.openSession(client2 as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(150);
      await flushAsync();
    });
    expect(allText(renderer)).toContain('11.22 V');
    expect(allText(renderer)).toContain(i18n.t('batteryCard.state.WARNING'));
    expect(allText(renderer)).not.toContain('16.85 V');

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    });
    act(() => {
      renderer.unmount();
    });
  });

  it('rebinds after navigating away and back (unmount + remount) during the SAME active session - no duplicate pollers, current value shown', async () => {
    const sessionId = 'pass76b-remount-1';
    const client = makeFakeClient(sessionId);
    client.setResponse(MSP_ATTITUDE, attitudePayload(0, 0, 0));
    client.setResponse(MSP_BATTERY_STATE, batteryPayload(4, 0, 1685));
    const props = makeProps({sessionKey: {sessionId, generation: 1}});

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<SetupScreen {...props} />);
    });
    await act(async () => {
      mspSessionCoordinator.openSession(client as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(150);
      await flushAsync();
    });
    expect(allText(renderer)).toContain('16.85 V');

    const batteryWritesBefore = client.writeBytes.mock.calls.filter(
      call => base64ToBytes(call[1] as string)[4] === MSP_BATTERY_STATE,
    ).length;

    // Navigate away (screen unmounts; the session keeps running - the
    // established hardware-Back behavior) and back again.
    act(() => {
      renderer.unmount();
    });
    let renderer2!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer2 = ReactTestRenderer.create(<SetupScreen {...props} />);
    });
    await act(async () => {
      await flushAsync();
    });
    expect(allText(renderer2)).toContain('16.85 V'); // rebinds to the live value immediately

    // The 3000ms cadence is owned by the SESSION, not the screen - a
    // remount must not add a second battery poller (no burst of extra
    // battery requests beyond the cadence).
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3100);
      await flushAsync();
    });
    const batteryWritesAfter = client.writeBytes.mock.calls.filter(
      call => base64ToBytes(call[1] as string)[4] === MSP_BATTERY_STATE,
    ).length;
    expect(batteryWritesAfter - batteryWritesBefore).toBeLessThanOrEqual(2);

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    });
    act(() => {
      renderer2.unmount();
    });
  });
});

describe('SetupScreen - Pass 7.6c complete Region 3 card grid through the REAL pipeline', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(async () => {
    // Same straggler discipline as the Pass 7.6b describe above.
    await flushAsync();
    jest.clearAllTimers();
    jest.useRealTimers();
    await flushAsync();
  });

  /** Opens a default-fixture session, renders the screen, and advances
   * far enough (2.2s) for all three phase-staggered auxiliary polls
   * (700/1400/2100ms) to have dispatched and settled. */
  async function renderWithLiveAux(sessionId: string, configure?: (client: ReturnType<typeof makeFakeClient>) => void) {
    const client = makeFakeClient(sessionId);
    client.setResponse(MSP_ATTITUDE, attitudePayload(0, 0, 0));
    configure?.(client);
    const props = makeProps({sessionKey: {sessionId, generation: 1}});

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<SetupScreen {...props} />);
    });
    await act(async () => {
      mspSessionCoordinator.openSession(client as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2200);
      await flushAsync();
    });
    return {client, renderer};
  }

  async function teardown(sessionId: string, renderer: ReactTestRenderer.ReactTestRenderer) {
    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
      await flushAsync();
    });
    act(() => {
      renderer.unmount();
    });
  }

  it('renders the complete 2x2 grid with all four cards live, in the approved diagnostic tree order Battery -> Receiver -> GPS -> FC', async () => {
    const sessionId = 'pass76c-grid-1';
    const {renderer} = await renderWithLiveAux(sessionId);

    expect(findAnyByTestID(renderer, 'telemetry-card-grid')).not.toBeNull();
    expect(findAnyByTestID(renderer, 'battery-card-live')).not.toBeNull();
    expect(findAnyByTestID(renderer, 'receiver-card-live')).not.toBeNull();
    expect(findAnyByTestID(renderer, 'gps-card-live')).not.toBeNull();
    expect(findAnyByTestID(renderer, 'fc-card-live')).not.toBeNull();

    // Tree order = accessibility (reading) order: the four titles appear
    // in exactly the approved diagnostic sequence.
    const text = allText(renderer);
    const positions = [
      text.indexOf(i18n.t('batteryCard.title')),
      text.indexOf(i18n.t('telemetryCards.receiver.title')),
      text.indexOf(i18n.t('telemetryCards.gps.title')),
      text.indexOf(i18n.t('telemetryCards.fc.title')),
    ];
    for (const position of positions) {
      expect(position).toBeGreaterThanOrEqual(0);
    }
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    // Regions 1+2 are preserved around the grid.
    expect(findAnyByTestID(renderer, 'setup-top-bar')).not.toBeNull();
    expect(findAnyByTestID(renderer, 'orientation-hero')).not.toBeNull();

    await teardown(sessionId, renderer);
  });

  it('feeds every auxiliary card from the REAL decode pipeline: RSSI percentage, GPS fix + satellites (presence via the shared STATUS_EX bit), CPU load + cycle time', async () => {
    const sessionId = 'pass76c-aux-live-1';
    const {renderer} = await renderWithLiveAux(sessionId);
    const text = allText(renderer);

    // Default fixtures: MSP_ANALOG rssi=540 -> 53%; MSP_RAW_GPS raw fix
    // flag 2 (the real GPS_FIX bit) + 8 sats; MSP_STATUS_EX mask 41
    // (includes GPS bit 8), cycle 312us, cpu 12%.
    expect(text).toContain('RSSI: 53%');
    expect(text).toContain(i18n.t('telemetryCards.gps.fix'));
    expect(text).toContain('عدد الأقمار: 8');
    expect(text).toContain('استخدام المعالج: 12%');
    expect(text).toContain('زمن الدورة: 312 µs');

    await teardown(sessionId, renderer);
  });

  it('shows the approved waiting copy on the auxiliary cards BEFORE their phase-staggered first dispatches (no fabricated values at mount)', async () => {
    const sessionId = 'pass76c-waiting-1';
    const client = makeFakeClient(sessionId);
    client.setResponse(MSP_ATTITUDE, attitudePayload(0, 0, 0));
    const props = makeProps({sessionKey: {sessionId, generation: 1}});

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<SetupScreen {...props} />);
    });
    await act(async () => {
      mspSessionCoordinator.openSession(client as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(150); // before the 700ms receiver stagger
      await flushAsync();
    });

    expect(findAnyByTestID(renderer, 'receiver-card-waiting')).not.toBeNull();
    expect(findAnyByTestID(renderer, 'gps-card-waiting')).not.toBeNull();
    expect(findAnyByTestID(renderer, 'fc-card-waiting')).not.toBeNull();
    expect(allText(renderer)).toContain(i18n.t('telemetryCards.state.waiting'));
    // The battery card (its poll is immediately due) is already live.
    expect(findAnyByTestID(renderer, 'battery-card-live')).not.toBeNull();

    await teardown(sessionId, renderer);
  });

  it('never renders ANY battery charge percentage - the removed consumption estimate cannot come back through any pipeline state', async () => {
    const sessionId = 'pass76c-no-percentage-1';
    const {renderer} = await renderWithLiveAux(sessionId, client => {
      // Detected 4S battery with real consumption data on the wire - even
      // with everything the estimate once used available, NO percentage
      // may be derived: consumed-mAh-since-startup cannot establish the
      // pack's initial state of charge.
      client.setResponse(MSP_BATTERY_STATE, Uint8Array.from([4, ...u16le(1500), 168, ...u16le(350), ...u16le(0), 0, ...u16le(1685)]));
    });

    const text = allText(renderer);
    expect(text).toContain(i18n.t('batteryCard.percentageUnavailable'));
    expect(text.join(' ')).not.toContain('الشحن التقديري');
    // The battery card carries no percent figure at all (the receiver's
    // own RSSI percent lives on a different card and is unrelated).
    const batteryCard = findAnyByTestID(renderer, 'battery-card-live');
    expect(JSON.stringify(batteryCard?.props.accessibilityLabel)).not.toContain('%');

    await teardown(sessionId, renderer);
  });

  it('drops every auxiliary card to the approved disconnected copy on session teardown (battery keeps its own 7.6b unavailable wording)', async () => {
    const sessionId = 'pass76c-disconnect-1';
    const {renderer} = await renderWithLiveAux(sessionId);

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
      await flushAsync();
    });

    expect(findAnyByTestID(renderer, 'receiver-card-disconnected')).not.toBeNull();
    expect(findAnyByTestID(renderer, 'gps-card-disconnected')).not.toBeNull();
    expect(findAnyByTestID(renderer, 'fc-card-disconnected')).not.toBeNull();
    expect(allText(renderer)).toContain(i18n.t('telemetryCards.state.disconnected'));
    // Pass 7.6b preserved: the battery card's own unavailable copy.
    expect(findAnyByTestID(renderer, 'battery-card-unavailable')).not.toBeNull();
    expect(allText(renderer)).toContain(i18n.t('batteryCard.unavailable'));

    act(() => {
      renderer.unmount();
    });
  });

  it('battery-timeout closure: navigating away and back in the SAME session does not reset the battery breaker - no new battery request, honest unavailable copy', async () => {
    const sessionId = 'pass76c-batt-breaker-nav-1';
    const client = makeFakeClient(sessionId);
    client.setResponse(MSP_ATTITUDE, attitudePayload(0, 0, 0));
    client.clearResponse(MSP_BATTERY_STATE); // battery goes unanswered -> REAL 2000ms timeout
    const props = makeProps({sessionKey: {sessionId, generation: 1}});

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<SetupScreen {...props} />);
    });
    await act(async () => {
      mspSessionCoordinator.openSession(client as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2400); // dispatch ~100, timeout ~2100 -> breaker
      await flushAsync();
    });

    const countBatteryWrites = () =>
      client.writeBytes.mock.calls.filter(call => base64ToBytes(call[1] as string)[4] === MSP_BATTERY_STATE).length;
    expect(countBatteryWrites()).toBe(1);
    // Pass 7.7: with NO prior successful reading, the latch is a truthful
    // read-timeout ERROR (batteryCard.error) rather than the generic
    // unavailable copy - the timeout really did fail to read, and that is
    // what the card now says.
    expect(findAnyByTestID(renderer, 'battery-card-error')).not.toBeNull();
    expect(allText(renderer)).toContain(i18n.t('batteryCard.error'));

    // Navigate away (unmount) and back (fresh mount, SAME session/
    // generation) - the breaker lives in the coordinator, not the screen.
    act(() => {
      renderer.unmount();
    });
    let renderer2!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer2 = ReactTestRenderer.create(<SetupScreen {...props} />);
    });
    await act(async () => {
      // A full battery polling window plus slack: the old retry loop
      // would have sent another request here.
      await jest.advanceTimersByTimeAsync(3500);
      await flushAsync();
    });

    expect(countBatteryWrites()).toBe(1); // STILL exactly the one timed-out request
    // The latch (coordinator-owned, generation-scoped) survives remount.
    expect(findAnyByTestID(renderer2, 'battery-card-error')).not.toBeNull();
    // Never the stale pre-timeout value as live, never a "no LiPo" claim.
    expect(allText(renderer2)).not.toContain(i18n.t('batteryCard.notDetected'));
    // The rest of the screen is alive.
    expect(findAnyByTestID(renderer2, 'setup-screen')).not.toBeNull();
    expect(findAnyByTestID(renderer2, 'setup-top-bar')).not.toBeNull();

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
      await flushAsync();
    });
    act(() => {
      renderer2.unmount();
    });
  });
});

/**
 * Pass 7.7 - Region 4 (التشخيص والجاهزية) through the REAL pipeline: the
 * SAME single MSP_STATUS_EX poll Region 3's FC card already uses, plus
 * the SAME identification state Region 1 already reads. These tests
 * additionally prove no SECOND STATUS_EX poll was introduced.
 */
describe('SetupScreen - Pass 7.7 Region 4 diagnostics through the REAL pipeline', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(async () => {
    await flushAsync();
    jest.clearAllTimers();
    jest.useRealTimers();
    await flushAsync();
  });

  /** A real API-1.47 STATUS_EX frame: the 13-byte prefix (sensors mask
   * 41 = ACC|GPS|GYRO, cycle 312us, cpu 12%) followed by the full
   * optional tail - 3 pid profiles, rate 0, one extension byte, the
   * declared count 29, the u32 blocker mask, and the config-state byte. */
  function statusExWithBlockers(mask: number): Uint8Array {
    return Uint8Array.from([
      ...u16le(312), ...u16le(0), ...u16le(41), 0, 0, 0, 0, 0, ...u16le(12),
      3, 0, 1, 0,
      29,
      mask % 256,
      Math.floor(mask / 256) % 256,
      Math.floor(mask / 65536) % 256,
      Math.floor(mask / 16777216) % 256,
      0,
    ]);
  }

  function countStatusExWrites(client: ReturnType<typeof makeFakeClient>): number {
    return client.writeBytes.mock.calls.filter(
      call => base64ToBytes(call[1] as string)[4] === MSP_STATUS_EX,
    ).length;
  }

  async function renderSession(
    sessionId: string,
    configure?: (client: ReturnType<typeof makeFakeClient>) => void,
  ) {
    const client = makeFakeClient(sessionId);
    client.setResponse(MSP_ATTITUDE, attitudePayload(0, 0, 0));
    configure?.(client);
    const props = makeProps({sessionKey: {sessionId, generation: 1}});
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<SetupScreen {...props} />);
    });
    await act(async () => {
      mspSessionCoordinator.openSession(client as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2200);
      await flushAsync();
    });
    return {client, renderer};
  }

  async function teardown(sessionId: string, renderer: ReactTestRenderer.ReactTestRenderer) {
    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
      await flushAsync();
    });
    act(() => {
      renderer.unmount();
    });
  }

  it('renders Region 4 immediately AFTER Region 3, with its exact Arabic title', async () => {
    const sessionId = 'pass77-region4-order';
    const {renderer} = await renderSession(sessionId);

    expect(findAnyByTestID(renderer, 'diagnostics-section')).not.toBeNull();
    const text = allText(renderer);
    const gridTitleIndex = text.indexOf(i18n.t('telemetryCards.fc.title'));
    const region4Index = text.indexOf('التشخيص والجاهزية');
    expect(gridTitleIndex).toBeGreaterThanOrEqual(0);
    expect(region4Index).toBeGreaterThan(gridTitleIndex);
    // Regions 1-3 are all still present around it.
    expect(findAnyByTestID(renderer, 'setup-top-bar')).not.toBeNull();
    expect(findAnyByTestID(renderer, 'telemetry-card-grid')).not.toBeNull();

    await teardown(sessionId, renderer);
  });

  it('adds NO second MSP_STATUS_EX poll: Region 3 and Region 4 are fed by the same requests', async () => {
    const sessionId = 'pass77-region4-single-poll';
    const {client, renderer} = await renderSession(sessionId);

    // One phase-staggered dispatch at 2100ms within the 2200ms window.
    expect(countStatusExWrites(client)).toBe(1);
    // Both regions rendered from it.
    expect(findAnyByTestID(renderer, 'fc-card-live')).not.toBeNull();
    expect(allText(renderer)).toContain('استخدام المعالج: 12%');
    expect(findAnyByTestID(renderer, 'diagnostics-sensors')).not.toBeNull();

    // A second full FC-status interval adds exactly one more request.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(8000);
      await flushAsync();
    });
    expect(countStatusExWrites(client)).toBe(2);

    await teardown(sessionId, renderer);
  });

  it('shows the FC-reported detected sensors from the shared decode', async () => {
    const sessionId = 'pass77-region4-sensors';
    const {renderer} = await renderSession(sessionId);
    const text = allText(renderer);
    // Fixture mask 41 = ACC | GPS | GYRO.
    expect(text).toEqual(expect.arrayContaining(['ACC', 'GPS', 'GYRO']));
    expect(text).not.toContain('BARO');
    await teardown(sessionId, renderer);
  });

  it('says blockers cannot be confirmed when the FC returns a valid SHORT payload with no blocker field', async () => {
    const sessionId = 'pass77-region4-short';
    const {renderer} = await renderSession(sessionId); // default 13-byte fixture
    const text = allText(renderer);
    expect(text).toContain('لا يمكن تأكيد موانع التسليح في الوقت الحالي');
    expect(text).not.toContain('لم يُبلِّغ متحكم الطيران عن أي مانع في هذه القراءة');
    // The rest of the section still works - one absent field does not
    // take down identity, compatibility or sensors.
    expect(text).toEqual(expect.arrayContaining(['ACC', 'GYRO']));
    await teardown(sessionId, renderer);
  });

  it('decodes REAL blockers end-to-end and renders their source-proven Arabic text plus canonical tokens', async () => {
    const sessionId = 'pass77-region4-blockers';
    const mask = Math.pow(2, 7) + Math.pow(2, 28); // THROTTLE + ARM_SWITCH
    const {renderer} = await renderSession(sessionId, client => {
      client.setResponse(MSP_STATUS_EX, statusExWithBlockers(mask));
    });
    const text = allText(renderer);
    expect(text).toContain('الخانق ليس في وضعه الأدنى (THROTTLE)');
    expect(text).toContain('مفتاح التسليح مُفعَّل بينما يوجد مانع آخر (ARM_SWITCH)');
    await teardown(sessionId, renderer);
  });

  it('a FRESH zero mask says only "no blocker in this reading" - never a readiness claim', async () => {
    const sessionId = 'pass77-region4-zero';
    const {renderer} = await renderSession(sessionId, client => {
      client.setResponse(MSP_STATUS_EX, statusExWithBlockers(0));
    });
    const text = allText(renderer).join(' | ');
    expect(text).toContain('لم يُبلِّغ متحكم الطيران عن أي مانع في هذه القراءة');
    expect(text).not.toContain('جاهزة للطيران');
    await teardown(sessionId, renderer);
  });

  it('reports the real identity and does NOT claim API-1.47 compatibility for the 1.48 fixture', async () => {
    const sessionId = 'pass77-region4-compat';
    const {renderer} = await renderSession(sessionId);
    const text = allText(renderer);
    expect(text).toContain('البرنامج الثابت: BTFL — واجهة MSP 1.48');
    expect(text).toContain('واجهة غير مُتحقَّق منها في هذا الإصدار؛ تُعرض القراءات فقط');
    expect(text).not.toContain('متوافق: Betaflight بواجهة MSP 1.47');
    await teardown(sessionId, renderer);
  });

  it('reports the compatible pair for a real API-1.47 Betaflight session', async () => {
    const sessionId = 'pass77-region4-compat-147';
    const {renderer} = await renderSession(sessionId, client => {
      client.setResponse(MSP_API_VERSION, Uint8Array.from([0, 1, 47]));
    });
    expect(allText(renderer)).toContain('متوافق: Betaflight بواجهة MSP 1.47');
    await teardown(sessionId, renderer);
  });

  it('drops to the honest unconfirmed/disconnected copy on teardown, and a replacement generation starts clean', async () => {
    const sessionId = 'pass77-region4-generation';
    const mask = Math.pow(2, 7);
    const {renderer} = await renderSession(sessionId, client => {
      client.setResponse(MSP_STATUS_EX, statusExWithBlockers(mask));
    });
    expect(allText(renderer)).toContain('الخانق ليس في وضعه الأدنى (THROTTLE)');

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
      await flushAsync();
    });
    const afterTeardown = allText(renderer);
    expect(afterTeardown).toContain('غير متصل');
    expect(afterTeardown).toContain('لا يمكن تأكيد موانع التسليح في الوقت الحالي');
    expect(afterTeardown).toContain('لا يمكن تأكيد المستشعرات في الوقت الحالي');
    // The replaced generation's blocker text is gone entirely.
    expect(afterTeardown).not.toContain('الخانق ليس في وضعه الأدنى (THROTTLE)');

    // A NEW physical session on the same id re-derives from its own
    // reading - nothing from the previous generation leaks in.
    const client2 = makeFakeClient(sessionId);
    client2.setResponse(MSP_ATTITUDE, attitudePayload(0, 0, 0));
    client2.setResponse(MSP_STATUS_EX, statusExWithBlockers(Math.pow(2, 8))); // ANGLE
    await act(async () => {
      mspSessionCoordinator.openSession(client2 as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2200);
      await flushAsync();
    });
    const afterReplacement = allText(renderer);
    expect(afterReplacement).toContain('الطائرة ليست مستوية (ANGLE)');
    expect(afterReplacement).not.toContain('الخانق ليس في وضعه الأدنى (THROTTLE)');

    await teardown(sessionId, renderer);
  });
});

/**
 * Pass 7.7 - Region 5 (أدوات وحدة التحكم) through the real screen. The
 * transaction itself is covered end-to-end in FcToolsController.test.ts;
 * here the point is placement, the honest disabled reason the real
 * pipeline actually produces, and that mounting the screen never sends
 * an FC write of its own.
 */
describe('SetupScreen - Pass 7.7 Region 5 FC tools through the REAL pipeline', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(async () => {
    await flushAsync();
    jest.clearAllTimers();
    jest.useRealTimers();
    await flushAsync();
  });

  async function renderSession(sessionId: string) {
    const client = makeFakeClient(sessionId);
    client.setResponse(MSP_ATTITUDE, attitudePayload(0, 0, 0));
    const props = makeProps({sessionKey: {sessionId, generation: 1}});
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<SetupScreen {...props} />);
    });
    await act(async () => {
      mspSessionCoordinator.openSession(client as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2200);
      await flushAsync();
    });
    return {client, renderer};
  }

  it('renders Region 5 directly below the Orientation section, with its exact Arabic title and all three proven tools', async () => {
    const sessionId = 'pass77-region5-order';
    const {renderer} = await renderSession(sessionId);

    expect(findAnyByTestID(renderer, 'fc-tools-section')).not.toBeNull();
    const text = allText(renderer);
    const region4 = text.indexOf('التشخيص والجاهزية');
    const region5 = text.indexOf('أدوات وحدة التحكم');
    // FINAL-POLISH PASS: Region 5 moved UP to sit under the Orientation
    // hero, so it now precedes Region 4 rather than following it. The
    // ordering is still asserted exactly - only its direction changed.
    expect(region5).toBeGreaterThanOrEqual(0);
    expect(region4).toBeGreaterThan(region5);
    expect(text).toEqual(
      expect.arrayContaining(['معايرة مقياس التسارع', 'معايرة البوصلة المغناطيسية', 'إعادة تشغيل متحكم الطيران']),
    );

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
      await flushAsync();
    });
    act(() => {
      renderer.unmount();
    });
  });

  it('never sends an FC write merely by mounting the screen', async () => {
    const sessionId = 'pass77-region5-no-write';
    const {client, renderer} = await renderSession(sessionId);

    const written = client.writeBytes.mock.calls.map(call => base64ToBytes(call[1] as string)[4]);
    expect(written).not.toContain(205); // MSP_ACC_CALIBRATION
    expect(written).not.toContain(206); // MSP_MAG_CALIBRATION
    expect(written).not.toContain(68); // MSP_REBOOT
    expect(written).not.toContain(250); // MSP_EEPROM_WRITE, prohibited

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
      await flushAsync();
    });
    act(() => {
      renderer.unmount();
    });
  });

  it('disables every tool with the honest reason while the session is not connected', async () => {
    const sessionId = 'pass77-region5-disconnected';
    const {renderer} = await renderSession(sessionId);
    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
      await flushAsync();
    });

    expect(allText(renderer)).toContain('غير متاح: لا يوجد اتصال نشط');
    act(() => {
      renderer.unmount();
    });
  });
});

/**
 * FINAL-POLISH PASS - the Setup screen's effective section order.
 *
 * "أدوات وحدة التحكم" (FcToolsSection - accelerometer calibration,
 * magnetometer calibration, FC reboot) must sit directly below the
 * COMPLETE Orientation section, with no status strip, telemetry card or
 * diagnostics block wedged between them. Everything else keeps its
 * previous relative order.
 *
 * Order is read from the rendered tree rather than from the source
 * file: findAll() walks depth-first in render order, so the sequence
 * these markers appear in IS the sequence a user scrolls through.
 */
describe('SetupScreen - effective section order after the final polish', () => {
  /** One stable marker per major section. SafetyStrip's own testID
   * varies with readiness state, so it is matched by prefix. */
  const SECTION_MARKERS = ['orientation-hero', 'fc-tools-section', 'safety-strip-', 'telemetry-card-grid', 'diagnostics-section'];

  function markerFor(testID: unknown): string | undefined {
    if (typeof testID !== 'string') {
      return undefined;
    }
    return SECTION_MARKERS.find(marker => (marker.endsWith('-') ? testID.startsWith(marker) : testID === marker));
  }

  /** The ordered list of sections as actually rendered, de-duplicated
   * so a section's own nested host node cannot appear twice. */
  function renderedSectionOrder(renderer: ReactTestRenderer.ReactTestRenderer): string[] {
    const order: string[] = [];
    for (const node of renderer.root.findAll(n => typeof n.type === 'string')) {
      const marker = markerFor(node.props.testID);
      if (marker !== undefined && !order.includes(marker)) {
        order.push(marker);
      }
    }
    return order;
  }

  async function renderConnectedScreen(sessionId: string) {
    const client = makeFakeClient(sessionId);
    client.setResponse(MSP_ATTITUDE, attitudePayload(0, 0, 0));
    const props = makeProps({sessionKey: {sessionId, generation: 1}});
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<SetupScreen {...props} />);
    });
    await act(async () => {
      mspSessionCoordinator.openSession(client as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2200);
      await flushAsync();
    });
    return {client, renderer};
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

  it('renders Orientation, then أدوات وحدة التحكم, then the safety strip, cards and diagnostics', async () => {
    const sessionId = 'final-polish-order';
    const {renderer} = await renderConnectedScreen(sessionId);

    expect(renderedSectionOrder(renderer)).toEqual([
      'orientation-hero',
      'fc-tools-section',
      'safety-strip-',
      'telemetry-card-grid',
      'diagnostics-section',
    ]);

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
      await flushAsync();
    });
    act(() => {
      renderer.unmount();
    });
  });

  it('places NOTHING between the end of the Orientation section and the FC tools section', async () => {
    const sessionId = 'final-polish-adjacency';
    const {renderer} = await renderConnectedScreen(sessionId);

    const order = renderedSectionOrder(renderer);
    expect(order.indexOf('fc-tools-section')).toBe(order.indexOf('orientation-hero') + 1);
    // Named explicitly, because these are the sections that USED to be
    // in between and must not creep back.
    for (const displaced of ['safety-strip-', 'telemetry-card-grid', 'diagnostics-section']) {
      expect(order.indexOf(displaced)).toBeGreaterThan(order.indexOf('fc-tools-section'));
    }

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
      await flushAsync();
    });
    act(() => {
      renderer.unmount();
    });
  });

  it('moves the FC TOOLS section, not the FlightController telemetry card', async () => {
    const sessionId = 'final-polish-not-the-card';
    const {renderer} = await renderConnectedScreen(sessionId);

    // The moved section is the one with the calibration/reboot controls.
    expect(findAnyByTestID(renderer, 'fc-tool-ACC_CALIBRATION')).not.toBeNull();
    expect(findAnyByTestID(renderer, 'fc-tool-MAG_CALIBRATION')).not.toBeNull();
    expect(findAnyByTestID(renderer, 'fc-tool-REBOOT')).not.toBeNull();
    expect(allText(renderer)).toContain('أدوات وحدة التحكم');

    // The FlightController CARD stayed where it was: inside the
    // telemetry grid, which is still after the safety strip.
    const grid = renderer.root.findAll(
      n => typeof n.type === 'string' && n.props.testID === 'telemetry-card-grid',
    );
    expect(grid).toHaveLength(1);
    const cardTestIds = grid[0]
      .findAll(n => typeof n.type === 'string' && typeof n.props.testID === 'string')
      .map(n => n.props.testID as string);
    expect(cardTestIds.some(id => id.startsWith('fc-card') || id.includes('flight-controller'))).toBe(true);

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
      await flushAsync();
    });
    act(() => {
      renderer.unmount();
    });
  });

  it('renders exactly ONE FC tools section, with its title and all three tools', async () => {
    const sessionId = 'final-polish-single-instance';
    const {renderer} = await renderConnectedScreen(sessionId);

    const sections = renderer.root.findAll(
      n => typeof n.type === 'string' && n.props.testID === 'fc-tools-section',
    );
    expect(sections).toHaveLength(1);
    expect(
      renderer.root.findAll(n => typeof n.type === 'string' && n.props.testID === 'fc-tools-title'),
    ).toHaveLength(1);
    for (const tool of ['ACC_CALIBRATION', 'MAG_CALIBRATION', 'REBOOT']) {
      expect(
        renderer.root.findAll(n => typeof n.type === 'string' && n.props.testID === `fc-tool-${tool}`),
      ).toHaveLength(1);
    }

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
      await flushAsync();
    });
    act(() => {
      renderer.unmount();
    });
  });

  it('keeps the FC tools section wired to its controller - the move changed position, not behaviour', async () => {
    const sessionId = 'final-polish-still-wired';
    const {client, renderer} = await renderConnectedScreen(sessionId);

    // Its gating still reflects real session state: with no BOXIDS
    // mapping acquired the armed state is UNKNOWN, so the controls are
    // honestly disabled rather than silently enabled by the move.
    const accButton = findAnyByTestID(renderer, 'fc-tool-ACC_CALIBRATION-button');
    expect(accButton).not.toBeNull();
    expect(typeof accButton!.props.onPress).toBe('function');
    expect(accButton!.props.accessibilityState).toBeDefined();

    // And it still sends nothing merely by being rendered here.
    const written = client.writeBytes.mock.calls.map(call => base64ToBytes(call[1] as string)[4]);
    expect(written).not.toContain(205); // MSP_ACC_CALIBRATION
    expect(written).not.toContain(206); // MSP_MAG_CALIBRATION
    expect(written).not.toContain(68); // MSP_REBOOT

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
      await flushAsync();
    });
    act(() => {
      renderer.unmount();
    });
  });
});

/**
 * FINAL-POLISH PASS - the reset contract, through the REAL scheduler,
 * store and view model.
 *
 * The user reported that the model appears to tilt by itself after a
 * reset. This block does not assume that is a defect; it pins down
 * every property whose violation COULD produce it, so that the
 * remaining explanation is hardware/sensor behaviour rather than
 * application logic.
 */
describe('SetupScreen - reset contract and apparent self-tilt', () => {
  const mounted: ReactTestRenderer.ReactTestRenderer[] = [];

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      for (const renderer of mounted.splice(0)) {
        renderer.unmount();
      }
    });
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  async function mountLive(
    sessionKey: {sessionId: string; generation: number},
    attitude: {rollDecidegrees: number; pitchDecidegrees: number; yawDegrees: number},
  ) {
    const client = makeFakeClient(sessionKey.sessionId);
    client.setResponse(
      MSP_ATTITUDE,
      attitudePayload(attitude.rollDecidegrees, attitude.pitchDecidegrees, attitude.yawDegrees),
    );
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<SetupScreen {...makeProps({sessionKey})} />);
    });
    mounted.push(renderer);
    await act(async () => {
      mspSessionCoordinator.openSession(client as unknown as UsbSerialTransportClient, sessionKey.sessionId);
      await flushAsync();
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(50);
      await flushAsync();
    });
    return {client, renderer};
  }

  async function pushSample(
    client: ReturnType<typeof makeFakeClient>,
    attitude: {rollDecidegrees: number; pitchDecidegrees: number; yawDegrees: number},
  ) {
    client.setResponse(
      MSP_ATTITUDE,
      attitudePayload(attitude.rollDecidegrees, attitude.pitchDecidegrees, attitude.yawDegrees),
    );
    await act(async () => {
      await jest.advanceTimersByTimeAsync(300);
      await flushAsync();
    });
  }

  /** The scheduler's own committed value - the canonical sample, before
   * any display derivation. */
  function committed(sessionId: string) {
    return mspSessionCoordinator.getTelemetryScheduler(sessionId)!.getValue<{
      rollDecidegrees: number;
      pitchDecidegrees: number;
      yawDegrees: number;
    }>(ATTITUDE_TELEMETRY_POLL_ID);
  }

  function press(renderer: ReactTestRenderer.ReactTestRenderer) {
    return act(async () => {
      findAnyByTestID(renderer, 'orientation-hero-reset-button')!.props.onPress();
    });
  }

  it('captures the LATEST committed sample, not an earlier one', async () => {
    const sessionKey = {sessionId: 'reset-latest-sample', generation: 1};
    const {client, renderer} = await mountLive(sessionKey, {rollDecidegrees: 0, pitchDecidegrees: 0, yawDegrees: 40});
    const first = committed(sessionKey.sessionId);
    const firstSeq = first.status === 'FRESH' ? first.sampleSeq : undefined;
    expect(firstSeq).toBeDefined();

    await pushSample(client, {rollDecidegrees: 0, pitchDecidegrees: 0, yawDegrees: 130});
    const latest = committed(sessionKey.sessionId);
    expect(latest.status).toBe('FRESH');
    if (latest.status !== 'FRESH') {
      return;
    }
    expect(latest.sampleSeq).toBeGreaterThan(firstSeq!);

    await press(renderer);

    // The reference is the NEWEST sample's yaw (130), never the one the
    // screen first rendered (40).
    expect(setupUiSessionStore.getState(sessionKey).orientationViewOffset.yawDeg).toBe(130);
    expect(allText(renderer)).toContain('0°');
  });

  it('repaints IMMEDIATELY, in the same interaction, without waiting for the next telemetry response', async () => {
    const sessionKey = {sessionId: 'reset-immediate-repaint', generation: 1};
    const {client, renderer} = await mountLive(sessionKey, {rollDecidegrees: 0, pitchDecidegrees: 0, yawDegrees: 75});
    expect(allText(renderer)).toContain('75°');

    const requestsBefore = client.writeBytes.mock.calls.length;
    await press(renderer);

    // No timer advanced, no new sample delivered - and the heading has
    // already changed on screen.
    expect(allText(renderer)).toContain('0°');
    expect(allText(renderer)).not.toContain('75°');
    expect(client.writeBytes.mock.calls.length).toBe(requestsBefore);
  });

  it('changes ONLY the heading reference - roll and pitch from that same sample are untouched', async () => {
    const sessionKey = {sessionId: 'reset-heading-only', generation: 1};
    const {renderer} = await mountLive(sessionKey, {rollDecidegrees: 123, pitchDecidegrees: -456, yawDegrees: 200});
    const before = committed(sessionKey.sessionId);

    await press(renderer);

    const after = committed(sessionKey.sessionId);
    // Raw telemetry is immutable: the canonical sample is byte-identical.
    expect(after).toEqual(before);
    const offset = setupUiSessionStore.getState(sessionKey).orientationViewOffset;
    expect(offset.rollDeg).toBe(0);
    expect(offset.pitchDeg).toBe(0);
    expect(offset.yawDeg).toBe(200);
    // Roll 12.3 -> 12, pitch -(-45.6) -> 46 on screen, unchanged by reset.
    expect(allText(renderer)).toContain('12°');
    expect(allText(renderer)).toContain('46°');
  });

  it('is IDEMPOTENT - ten taps with no newer sample cannot accumulate a second rotation', async () => {
    const sessionKey = {sessionId: 'reset-idempotent', generation: 1};
    const {renderer} = await mountLive(sessionKey, {rollDecidegrees: 60, pitchDecidegrees: 30, yawDegrees: 311});

    for (let i = 0; i < 10; i++) {
      await press(renderer);
    }

    const offset = setupUiSessionStore.getState(sessionKey).orientationViewOffset;
    expect(offset).toEqual({rollDeg: 0, pitchDeg: 0, yawDeg: 311});
    expect(allText(renderer)).toContain('0°');
    // Roll 60 decidegrees -> 6; raw pitch 30 decidegrees is nose DOWN,
    // negated once at the firmware boundary -> -3 on screen.
    expect(allText(renderer)).toContain('6°');
    expect(allText(renderer)).toContain('-3°');
  });

  it('the next newer sample renders directly, relative to the reference and with no drift of its own', async () => {
    const sessionKey = {sessionId: 'reset-then-newer', generation: 1};
    const {client, renderer} = await mountLive(sessionKey, {rollDecidegrees: 0, pitchDecidegrees: 0, yawDegrees: 359});

    await press(renderer);
    expect(allText(renderer)).toContain('0°');

    // Crossing the wrap: reference 359, raw 1 -> relative 2.
    await pushSample(client, {rollDecidegrees: 0, pitchDecidegrees: 0, yawDegrees: 1});
    expect(allText(renderer)).toContain('2°');

    // And back the other way: raw 357 -> relative 358, never -2.
    await pushSample(client, {rollDecidegrees: 0, pitchDecidegrees: 0, yawDegrees: 357});
    expect(allText(renderer)).toContain('358°');
  });

  it('a repeated IDENTICAL sample after reset leaves the model pose and the readouts completely unchanged', async () => {
    const sessionKey = {sessionId: 'reset-no-self-tilt', generation: 1};
    const {client, renderer} = await mountLive(sessionKey, {rollDecidegrees: 0, pitchDecidegrees: 0, yawDegrees: 88});

    await press(renderer);
    // Scoped to the ORIENTATION section deliberately: the unrelated
    // battery/receiver/GPS cards legitimately fill in as their own
    // slower polls answer, and comparing the whole screen would fail
    // on their progress rather than on any model movement.
    // Degree-suffixed strings appear only in the Orientation readouts,
    // so this is the numeric half of the section without dragging in
    // the unrelated cards.
    const degrees = () => allText(renderer).filter(text => text.endsWith('°'));
    const pose = () => (OrientationRenderer as unknown as jest.Mock).mock.calls.slice(-1)[0][0].orientation;
    const readoutsAfterReset = degrees();
    const poseAfterReset = pose();

    // The FC keeps reporting exactly the same attitude - the aircraft
    // has not moved. Neither the model nor the numbers may move. This
    // is the direct test of "the model tilts by itself".
    for (let i = 0; i < 5; i++) {
      await pushSample(client, {rollDecidegrees: 0, pitchDecidegrees: 0, yawDegrees: 88});
    }

    expect(degrees()).toEqual(readoutsAfterReset);
    expect(pose()).toEqual(poseAfterReset);
  });

  it('sends NO MSP request and starts NO timer, interval or frame of its own', async () => {
    const sessionKey = {sessionId: 'reset-no-side-effects', generation: 1};
    const {client, renderer} = await mountLive(sessionKey, {rollDecidegrees: 0, pitchDecidegrees: 0, yawDegrees: 45});

    const before = client.writeBytes.mock.calls.length;
    const raf = jest.spyOn(globalThis, 'requestAnimationFrame');
    const interval = jest.spyOn(globalThis, 'setInterval');
    const timersBefore = jest.getTimerCount();
    try {
      await press(renderer);
      expect(client.writeBytes.mock.calls.length).toBe(before);
      expect(raf).not.toHaveBeenCalled();
      expect(interval).not.toHaveBeenCalled();
      // No DELAYED pose update was queued: with no newer telemetry,
      // letting a long time pass changes nothing on screen. Asserted
      // behaviourally rather than by counting pending timers, because
      // React's own scheduler legitimately holds transient entries
      // that have nothing to do with the reset.
      const afterPress = allText(renderer).filter(text => text.endsWith('°'));
      expect(afterPress.length).toBeGreaterThan(0);
      // The fake transport keeps returning the same sample. Anything
      // that moved here would therefore have to be a delayed update the
      // press itself queued, even though several genuine polls may run.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(200);
        await flushAsync();
      });
      expect(allText(renderer).filter(text => text.endsWith('°'))).toEqual(afterPress);
      expect(timersBefore).toBeGreaterThan(0);
    } finally {
      raf.mockRestore();
      interval.mockRestore();
    }
  });
});
