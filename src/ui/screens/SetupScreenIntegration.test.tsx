/**
 * Pass 7.7 - the INTEGRATED acceptance test for the complete Setup
 * screen: all five regions assembled over the real MspSessionCoordinator,
 * the real MspClient (real FIFO, real 2000ms response timeout), the real
 * telemetry scheduler, the real AppState owner and the real FC-tools
 * mutex. Only the USB transport and the Skia renderer are fakes.
 *
 * SCOPE HONESTY: this is a JavaScript/React test. It proves the app's own
 * logic and wiring. It does NOT prove real hardware behavior, real
 * Android process lifecycle, or anything about a real APK - native and
 * hardware evidence are separate and are reported separately.
 */

jest.mock('../orientation3d', () => ({
  OrientationRenderer: () => null,
}));

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {ScrollView, Text} from 'react-native';
import type {AppStateStatus, NativeEventSubscription} from 'react-native';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';

import SetupScreen from './SetupScreen';
import '../../i18n';
import type {RootStackParamList} from '../../navigation/types';
import {
  fcToolsController,
  mspSessionCoordinator,
  setupAppStateTelemetryOwner,
} from '../../platforms/react-native/protocol';
import {
  MSP_ACC_CALIBRATION,
  MSP_ANALOG,
  MSP_API_VERSION,
  MSP_ATTITUDE,
  MSP_BATTERY_STATE,
  MSP_BOARD_INFO,
  MSP_BOXIDS,
  MSP_FC_VARIANT,
  MSP_MAG_CALIBRATION,
  MSP_RAW_GPS,
  MSP_REBOOT,
  MSP_STATUS_EX,
} from '../../core';
import {buildMspFrameBytes} from '../../core/protocol/__testUtils__/mspFixtures';
import {base64ToBytes, bytesToBase64} from '../../platforms/react-native/protocol/base64';
import type {UsbSerialDataEvent, UsbSerialSessionDetachedEvent, UsbSerialTransportClient} from '../../platforms/react-native/transport';

type Props = NativeStackScreenProps<RootStackParamList, 'Setup'>;

const ARABIC = {
  region1Title: 'إعداد الطائرة',
  region4Title: 'التشخيص والجاهزية',
  region5Title: 'أدوات وحدة التحكم',
  disconnected: 'غير متصل',
  blockersUnconfirmed: 'لا يمكن تأكيد موانع التسليح في الوقت الحالي',
  sensorsUnconfirmed: 'لا يمكن تأكيد المستشعرات في الوقت الحالي',
  toolDisconnected: 'غير متاح: لا يوجد اتصال نشط',
  toolArmed: 'غير متاح: الطائرة مسلّحة',
  toolBackgrounded: 'غير متاح: التطبيق ليس في المقدمة',
  toolIncompatible: 'غير متاح: يتطلب Betaflight بواجهة MSP 1.47',
  toolArmedUnknown: 'غير متاح: تعذّر تأكيد أن الطائرة غير مسلّحة',
  confirmAction: 'نعم، المراوح مفكوكة — تابع',
};

/** The exact truthful acknowledgement copy (Pass 7.7 commit 13). */
const TRUTHFUL_ACK =
  'استلم التطبيق ردًا صالحًا من متحكم الطيران على أمر المعايرة، لكن هذا لا يؤكد أن المعايرة بدأت أو اكتملت أو حُفظت.';

function ascii(text: string): number[] {
  return text.split('').map(c => c.charCodeAt(0));
}

function pstring(text: string): number[] {
  return [text.length, ...ascii(text)];
}

function u16le(value: number): number[] {
  return [value % 256, Math.floor(value / 256) % 256];
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

function statusExPayload(options: {sensorMask?: number; flightModeFlags?: number; blockerMask?: number} = {}): Uint8Array {
  const flags = options.flightModeFlags ?? 0;
  const mask = options.blockerMask ?? 0;
  return Uint8Array.from([
    ...u16le(312),
    ...u16le(0),
    ...u16le(options.sensorMask ?? 45), // ACC | MAG | GPS | GYRO
    flags % 256,
    Math.floor(flags / 256) % 256,
    Math.floor(flags / 65536) % 256,
    Math.floor(flags / 16777216) % 256,
    0,
    ...u16le(12),
    3,
    0,
    0,
    29,
    mask % 256,
    Math.floor(mask / 256) % 256,
    Math.floor(mask / 65536) % 256,
    Math.floor(mask / 16777216) % 256,
    0,
  ]);
}

function makeFakeClient(sessionId: string) {
  const dataListeners = new Set<(event: UsbSerialDataEvent) => void>();
  const detachListeners = new Set<(event: UsbSerialSessionDetachedEvent) => void>();
  const responses = new Map<number, Uint8Array>();
  const held = new Set<number>();
  const commands: number[] = [];

  const fake = {
    commands,
    writeBytes: jest.fn((_sessionId: string, dataBase64: string) => {
      const command = base64ToBytes(dataBase64)[4];
      commands.push(command);
      if (held.has(command)) {
        return Promise.resolve(undefined);
      }
      const payload = responses.get(command);
      if (payload !== undefined) {
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
    stopReading: jest.fn(() => Promise.resolve(undefined)),
    startReading: jest.fn(() => Promise.resolve(undefined)),
    setResponse: (command: number, payload: Uint8Array) => responses.set(command, payload),
    hold: (command: number) => held.add(command),
    emitSessionDetached: (event: UsbSerialSessionDetachedEvent) => {
      for (const listener of Array.from(detachListeners)) {
        listener(event);
      }
    },
    countOf: (command: number) => commands.filter(c => c === command).length,
  };

  fake.setResponse(MSP_API_VERSION, Uint8Array.from([0, 1, 47]));
  fake.setResponse(MSP_FC_VARIANT, Uint8Array.from(ascii('BTFL')));
  fake.setResponse(MSP_BOARD_INFO, boardInfoPayload());
  fake.setResponse(MSP_ATTITUDE, Uint8Array.from([0, 0, 0, 0, 0, 0]));
  fake.setResponse(MSP_BATTERY_STATE, Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0]));
  fake.setResponse(MSP_ANALOG, Uint8Array.from([168, ...u16le(0), ...u16le(540), ...u16le(0), ...u16le(1680)]));
  fake.setResponse(MSP_RAW_GPS, Uint8Array.from([2, 8, 0, 0, 0, 0, 0, 0, 0, 0, ...u16le(0), ...u16le(0), ...u16le(0)]));
  fake.setResponse(MSP_STATUS_EX, statusExPayload());
  fake.setResponse(MSP_BOXIDS, Uint8Array.from([0, 1, 2])); // BOXARM at bit 0
  fake.setResponse(MSP_ACC_CALIBRATION, Uint8Array.from([]));
  fake.setResponse(MSP_MAG_CALIBRATION, Uint8Array.from([]));
  fake.setResponse(MSP_REBOOT, Uint8Array.from([0]));
  return fake;
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
  }
}

function makeProps(sessionId: string): Props {
  return {
    route: {key: 'Setup-1', name: 'Setup', params: {sessionKey: {sessionId, generation: 1}}},
    navigation: {goBack: jest.fn()},
  } as unknown as Props;
}

function allText(renderer: ReactTestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .map(node => (Array.isArray(node.props.children) ? node.props.children.join('') : String(node.props.children)));
}

function hasTestID(renderer: ReactTestRenderer.ReactTestRenderer, testID: string): boolean {
  return renderer.root.findAll(node => node.props.testID === testID).length > 0;
}

function pressable(renderer: ReactTestRenderer.ReactTestRenderer, testID: string) {
  return renderer.root.findAll(node => node.props.testID === testID && typeof node.props.onPress === 'function')[0];
}

/** A controllable AppState so background/foreground is deterministic. */
function installFakeAppState(initial: AppStateStatus = 'active') {
  const listeners = new Set<(status: AppStateStatus) => void>();
  const appState = {
    currentState: initial,
    addEventListener: (_type: 'change', listener: (status: AppStateStatus) => void): NativeEventSubscription => {
      listeners.add(listener);
      return {remove: () => listeners.delete(listener)} as NativeEventSubscription;
    },
  };
  // The screen starts the module singleton; replacing its injected source
  // requires stopping it first so start() re-reads this one.
  setupAppStateTelemetryOwner.stop();
  (setupAppStateTelemetryOwner as unknown as {appState: typeof appState}).appState = appState;
  return {
    emit: (status: AppStateStatus) => {
      appState.currentState = status;
      for (const listener of Array.from(listeners)) {
        listener(status);
      }
    },
  };
}

describe('Setup screen - integrated acceptance (Regions 1-5)', () => {
  let openIds: string[] = [];
  let appState: ReturnType<typeof installFakeAppState>;

  beforeEach(() => {
    jest.useFakeTimers();
    openIds = [];
    // The FC-tools mutex is an app-wide singleton: release it so one
    // test can never leave a confirmation open for the next.
    fcToolsController.cancel();
    appState = installFakeAppState('active');
  });

  afterEach(async () => {
    for (const sessionId of openIds) {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    }
    await flushAsync();
    setupAppStateTelemetryOwner.stop();
    jest.clearAllTimers();
    jest.useRealTimers();
    await flushAsync();
  });

  async function mount(sessionId: string, configure?: (client: ReturnType<typeof makeFakeClient>) => void) {
    const client = makeFakeClient(sessionId);
    configure?.(client);
    openIds.push(sessionId);
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<SetupScreen {...makeProps(sessionId)} />);
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

  async function settle(ms = 120) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
      await flushAsync();
    });
  }

  it('assembles Regions 1-5 exactly once, in the required logical order', async () => {
    const {renderer} = await mount('integration-order');
    const text = allText(renderer);

    const positions = [
      text.indexOf(ARABIC.region1Title),
      text.indexOf('نموذج الاتجاه'),
      text.indexOf(ARABIC.region4Title),
      text.indexOf(ARABIC.region5Title),
    ].filter(index => index >= 0);
    // Identity/orientation come first, diagnostics then tools last.
    expect(text.indexOf(ARABIC.region4Title)).toBeGreaterThan(0);
    expect(text.indexOf(ARABIC.region5Title)).toBeGreaterThan(text.indexOf(ARABIC.region4Title));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    for (const testID of [
      'setup-top-bar',
      'orientation-hero',
      'telemetry-card-grid',
      'diagnostics-section',
      'fc-tools-section',
    ]) {
      expect(
        renderer.root.findAll(node => typeof node.type === 'string' && node.props.testID === testID),
      ).toHaveLength(1);
    }
  });

  it('uses exactly ONE vertical scrolling container and never scrolls horizontally', async () => {
    const {renderer} = await mount('integration-scroll');
    const scrollViews = renderer.root.findAllByType(ScrollView);
    expect(scrollViews).toHaveLength(1);
    expect(scrollViews[0].props.horizontal).toBeFalsy();
  });

  it('connection and compatibility state reaches Regions 1, 3, 4 and 5 together', async () => {
    const {renderer} = await mount('integration-connected');
    const text = allText(renderer);
    // Region 1 identity, Region 3 live cards, Region 4 compatibility,
    // Region 5 enabled controls - all from the same session.
    expect(text).toContain('متوافق: Betaflight بواجهة MSP 1.47');
    expect(hasTestID(renderer, 'fc-card-live')).toBe(true);
    expect(text).toEqual(expect.arrayContaining(['ACC', 'GYRO']));
  });

  it('an incompatible FC blocks every Region-5 control while Region 4 still reports honestly', async () => {
    const {renderer} = await mount('integration-incompatible', client => {
      client.setResponse(MSP_API_VERSION, Uint8Array.from([0, 1, 46]));
    });
    const text = allText(renderer);
    expect(text).toContain(ARABIC.toolIncompatible);
    expect(text).toContain('واجهة غير مُتحقَّق منها في هذا الإصدار؛ تُعرض القراءات فقط');
    for (const tool of ['ACC_CALIBRATION', 'MAG_CALIBRATION', 'REBOOT']) {
      expect(pressable(renderer, `fc-tool-${tool}-button`).props.disabled).toBe(true);
    }
  });

  it('disconnect updates EVERY region truthfully, and a new generation re-populates them', async () => {
    const sessionId = 'integration-generation';
    const {renderer} = await mount(sessionId);
    expect(hasTestID(renderer, 'fc-card-live')).toBe(true);

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
      await flushAsync();
    });

    const afterDisconnect = allText(renderer);
    expect(afterDisconnect).toContain(ARABIC.disconnected); // Regions 1, 3, 4
    expect(afterDisconnect).toContain(ARABIC.blockersUnconfirmed);
    expect(afterDisconnect).toContain(ARABIC.sensorsUnconfirmed);
    expect(afterDisconnect).toContain(ARABIC.toolDisconnected); // Region 5
    expect(hasTestID(renderer, 'fc-card-live')).toBe(false);

    // A replacement physical session on the same id repopulates all of it.
    const replacement = makeFakeClient(sessionId);
    await act(async () => {
      mspSessionCoordinator.openSession(replacement as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
    });
    await settle(2200);

    expect(hasTestID(renderer, 'fc-card-live')).toBe(true);
    expect(allText(renderer)).not.toContain(ARABIC.toolDisconnected);
  });

  it('an old generation cannot update any region after it has been replaced', async () => {
    const sessionId = 'integration-old-generation';
    const {client, renderer} = await mount(sessionId);

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
      await flushAsync();
    });
    const replacement = makeFakeClient(sessionId);
    replacement.setResponse(MSP_STATUS_EX, statusExPayload({sensorMask: 32})); // GYRO only
    await act(async () => {
      mspSessionCoordinator.openSession(replacement as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
    });
    await settle(2200);
    expect(allText(renderer)).not.toContain('ACC');

    // The dead client emitting a late frame changes nothing.
    const beforeLateFrame = allText(renderer);
    await act(async () => {
      client.emitSessionDetached({sessionId} as UsbSerialSessionDetachedEvent);
      await flushAsync();
    });
    await settle();
    expect(allText(renderer)).toEqual(beforeLateFrame);
  });

  it('a battery read timeout blocks neither diagnostics nor a safe tool preflight', async () => {
    const sessionId = 'integration-battery-timeout';
    const {client, renderer} = await mount(sessionId, c => {
      c.hold(MSP_BATTERY_STATE); // never answered -> the real 2000ms timeout
    });
    // The held battery request occupies the serialized link for its full
    // real 2000ms; everything else resumes only after it settles.
    await settle(6000);

    // Region 4 still has its own live reading...
    expect(hasTestID(renderer, 'diagnostics-section')).toBe(true);
    expect(allText(renderer)).toContain('لم يُبلِّغ متحكم الطيران عن أي مانع في هذه القراءة');
    // ...and Region 5's controls are still enabled and still work.
    // Exactly one BOXIDS request per composite identity: the first
    // scope died when the battery timeout bumped the MSP epoch (its
    // result was discarded, never cached), and the new scope acquired
    // its own mapping once - a new scope, not a retry.
    expect(client.countOf(MSP_BOXIDS)).toBe(2);
    expect(pressable(renderer, 'fc-tool-REBOOT-button').props.disabled).toBe(false);

    act(() => {
      pressable(renderer, 'fc-tool-REBOOT-button').props.onPress();
    });
    act(() => {
      pressable(renderer, 'fc-tools-confirm').props.onPress();
    });
    await settle(200);
    expect(client.countOf(MSP_REBOOT)).toBe(1);
  });

  it('never writes from cached status alone: every write is preceded by a FRESH preflight read', async () => {
    const sessionId = 'integration-preflight';
    const {client, renderer} = await mount(sessionId);

    const statusBefore = client.countOf(MSP_STATUS_EX);
    act(() => {
      pressable(renderer, 'fc-tool-ACC_CALIBRATION-button').props.onPress();
    });
    act(() => {
      pressable(renderer, 'fc-tools-confirm').props.onPress();
    });
    await settle(200);

    expect(client.countOf(MSP_ACC_CALIBRATION)).toBe(1);
    expect(client.countOf(MSP_STATUS_EX)).toBeGreaterThan(statusBefore);
    // The preflight read happened BEFORE the write, in the same session.
    const order = client.commands;
    const writeIndex = order.lastIndexOf(MSP_ACC_CALIBRATION);
    const statusIndex = order.lastIndexOf(MSP_STATUS_EX);
    expect(statusIndex).toBeLessThan(writeIndex);
  });

  it('never writes while ARMED, and says exactly why', async () => {
    const sessionId = 'integration-armed';
    const {client, renderer} = await mount(sessionId, c => {
      c.setResponse(MSP_STATUS_EX, statusExPayload({flightModeFlags: 1})); // BOXARM bit set
    });
    await settle(200);

    expect(allText(renderer)).toContain(ARABIC.toolArmed);
    for (const tool of ['ACC_CALIBRATION', 'MAG_CALIBRATION', 'REBOOT']) {
      expect(pressable(renderer, `fc-tool-${tool}-button`).props.disabled).toBe(true);
    }
    expect(client.countOf(MSP_ACC_CALIBRATION)).toBe(0);
    expect(client.countOf(MSP_REBOOT)).toBe(0);
  });

  it('never writes while the armed state cannot be proven', async () => {
    const sessionId = 'integration-armed-unknown';
    const {client, renderer} = await mount(sessionId, c => {
      // A perfectly valid mapping that simply does not contain BOXARM
      // (permanent id 0): the armed state is then UNPROVABLE, and must
      // never be guessed from the blocker mask.
      c.setResponse(MSP_BOXIDS, Uint8Array.from([1, 2, 3]));
      c.setResponse(MSP_STATUS_EX, statusExPayload({blockerMask: 0}));
    });
    await settle(300);

    expect(allText(renderer)).toContain(ARABIC.toolArmedUnknown);
    expect(client.countOf(MSP_ACC_CALIBRATION)).toBe(0);
  });

  it('never writes while backgrounded, and re-enables on resume without a duplicate scheduler', async () => {
    const sessionId = 'integration-background';
    const {client, renderer} = await mount(sessionId);
    const schedulerBefore = mspSessionCoordinator.getTelemetryScheduler(sessionId);

    await act(async () => {
      appState.emit('background');
      await flushAsync();
    });
    expect(allText(renderer)).toContain(ARABIC.toolBackgrounded);
    for (const tool of ['ACC_CALIBRATION', 'REBOOT']) {
      expect(pressable(renderer, `fc-tool-${tool}-button`).props.disabled).toBe(true);
    }

    // Backgrounded: new periodic scheduling stops.
    const writesWhileBackgrounded = client.commands.length;
    await settle(2000);
    expect(client.commands.length).toBe(writesWhileBackgrounded);

    await act(async () => {
      appState.emit('active');
      await flushAsync();
    });
    await settle(400);
    // The SAME scheduler instance resumed - no duplicate was created.
    expect(mspSessionCoordinator.getTelemetryScheduler(sessionId)).toBe(schedulerBefore);
    expect(client.commands.length).toBeGreaterThan(writesWhileBackgrounded);
    expect(pressable(renderer, 'fc-tool-REBOOT-button').props.disabled).toBe(false);
  });

  it('a detach while backgrounded cannot revive stale work on resume', async () => {
    const sessionId = 'integration-detach-background';
    const {client, renderer} = await mount(sessionId);

    await act(async () => {
      appState.emit('background');
      await flushAsync();
    });
    await act(async () => {
      client.emitSessionDetached({sessionId} as UsbSerialSessionDetachedEvent);
      await flushAsync();
    });
    const afterDetach = client.commands.length;

    await act(async () => {
      appState.emit('active');
      await flushAsync();
    });
    await settle(2500);

    expect(client.commands.length).toBe(afterDetach); // nothing resumed
    expect(allText(renderer)).toContain(ARABIC.toolDisconnected);
    expect(mspSessionCoordinator.getTelemetryScheduler(sessionId)).toBeUndefined();
  });

  it('a remount during the SAME session creates no duplicate readers', async () => {
    const sessionId = 'integration-remount';
    const {client, renderer} = await mount(sessionId);
    const scheduler = mspSessionCoordinator.getTelemetryScheduler(sessionId);

    act(() => {
      renderer.unmount();
    });
    let remounted!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      remounted = ReactTestRenderer.create(<SetupScreen {...makeProps(sessionId)} />);
    });
    await settle(400);

    expect(mspSessionCoordinator.getTelemetryScheduler(sessionId)).toBe(scheduler);
    // One attitude poll cadence, not two: the count over a fixed window
    // stays within the single-poller range.
    const before = client.countOf(MSP_ATTITUDE);
    await settle(1100);
    const added = client.countOf(MSP_ATTITUDE) - before;
    expect(added).toBeGreaterThan(0);
    expect(added).toBeLessThanOrEqual(6); // ~1100ms / 220ms, never doubled
    act(() => {
      remounted.unmount();
    });
  });

  it('a double tap produces at most ONE command', async () => {
    const sessionId = 'integration-double-tap';
    const {client, renderer} = await mount(sessionId);

    act(() => {
      pressable(renderer, 'fc-tool-ACC_CALIBRATION-button').props.onPress();
    });
    act(() => {
      // A second delivered tap on the now-disabled control.
      pressable(renderer, 'fc-tool-ACC_CALIBRATION-button').props.onPress();
    });
    // Exactly one confirmation was opened by the two taps.
    expect(renderer.root.findAll(n => typeof n.type === 'string' && n.props.testID === 'fc-tools-confirmation')).toHaveLength(1);

    act(() => {
      pressable(renderer, 'fc-tools-confirm').props.onPress();
    });
    // The confirmation is gone the moment the transaction starts, so a
    // second confirm tap has nothing left to hit - the mutex, not the UI
    // alone, is what makes this safe.
    expect(pressable(renderer, 'fc-tools-confirm')).toBeUndefined();
    await settle(300);

    expect(client.countOf(MSP_ACC_CALIBRATION)).toBe(1);
  });

  it('cancelling the confirmation sends nothing at all', async () => {
    const sessionId = 'integration-cancel';
    const {client, renderer} = await mount(sessionId);

    act(() => {
      pressable(renderer, 'fc-tool-MAG_CALIBRATION-button').props.onPress();
    });
    expect(allText(renderer)).toContain(ARABIC.confirmAction);
    act(() => {
      pressable(renderer, 'fc-tools-cancel').props.onPress();
    });
    await settle(200);

    expect(client.countOf(MSP_MAG_CALIBRATION)).toBe(0);
    expect(fcToolsController.getPhase()).toEqual({kind: 'IDLE'});
  });

  it('generation N\'s accepted outcome NEVER appears under a replacement generation N+1', async () => {
    const sessionId = 'integration-outcome-scope';
    const {client, renderer} = await mount(sessionId);

    act(() => {
      pressable(renderer, 'fc-tool-ACC_CALIBRATION-button').props.onPress();
    });
    act(() => {
      pressable(renderer, 'fc-tools-confirm').props.onPress();
    });
    await settle(300);
    expect(client.countOf(MSP_ACC_CALIBRATION)).toBe(1);
    expect(allText(renderer)).toContain(TRUTHFUL_ACK);

    // Transient detach with NO replacement: the same mounted screen keeps
    // the acknowledgement it legitimately received.
    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
      await flushAsync();
    });
    expect(allText(renderer)).toContain(TRUTHFUL_ACK);

    // A replacement generation becomes current: revoked immediately.
    const replacement = makeFakeClient(sessionId);
    await act(async () => {
      mspSessionCoordinator.openSession(replacement as unknown as UsbSerialTransportClient, sessionId);
      await flushAsync();
    });
    await settle(2200);
    expect(allText(renderer)).not.toContain(TRUTHFUL_ACK);
    expect(renderer.root.findAll(n => n.props.testID === 'fc-tools-outcome')).toEqual([]);
  });

  it('a REMOUNT does not replay the previous outcome or re-announce it as an alert', async () => {
    const sessionId = 'integration-outcome-remount';
    const {renderer} = await mount(sessionId);
    act(() => {
      pressable(renderer, 'fc-tool-ACC_CALIBRATION-button').props.onPress();
    });
    act(() => {
      pressable(renderer, 'fc-tools-confirm').props.onPress();
    });
    await settle(300);
    expect(allText(renderer)).toContain(TRUTHFUL_ACK);

    act(() => {
      renderer.unmount();
    });
    let remounted!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      remounted = ReactTestRenderer.create(<SetupScreen {...makeProps(sessionId)} />);
    });
    await settle(300);

    expect(allText(remounted)).not.toContain(TRUTHFUL_ACK);
    expect(remounted.root.findAll(n => n.props.testID === 'fc-tools-outcome')).toEqual([]);
    act(() => {
      remounted.unmount();
    });
  });

  it('a detach BEFORE the response keeps the conservative unconfirmed result, not an acknowledgement', async () => {
    const sessionId = 'integration-outcome-detach-first';
    const {client, renderer} = await mount(sessionId, c => {
      c.hold(MSP_ACC_CALIBRATION);
    });
    act(() => {
      pressable(renderer, 'fc-tool-ACC_CALIBRATION-button').props.onPress();
    });
    act(() => {
      pressable(renderer, 'fc-tools-confirm').props.onPress();
    });
    await settle(2500);

    const text = allText(renderer);
    expect(text).toContain('تعذّر تأكيد النتيجة. لم يُعَد الإرسال تلقائيًا.');
    expect(text).not.toContain(TRUTHFUL_ACK);
    expect(client.countOf(MSP_ACC_CALIBRATION)).toBe(1);
  });

  it('teardown leaves no JS timer, listener or pending action behind', async () => {
    const sessionId = 'integration-teardown';
    const {client, renderer} = await mount(sessionId);

    act(() => {
      renderer.unmount();
    });
    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
      await flushAsync();
    });
    setupAppStateTelemetryOwner.stop();
    // Let any final response-timeout timer expire naturally.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2500);
      await flushAsync();
    });

    expect(jest.getTimerCount()).toBe(0);
    expect(mspSessionCoordinator.getTelemetryScheduler(sessionId)).toBeUndefined();
    expect(fcToolsController.getPhase()).toEqual({kind: 'IDLE'});
    const settledCommands = client.commands.length;
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3000);
      await flushAsync();
    });
    expect(client.commands.length).toBe(settledCommands); // nothing still polling
  });
});

describe('Setup screen - layout and accessibility', () => {
  let openIds: string[] = [];

  beforeEach(() => {
    jest.useFakeTimers();
    openIds = [];
    fcToolsController.cancel();
    installFakeAppState('active');
  });

  afterEach(async () => {
    for (const sessionId of openIds) {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    }
    await flushAsync();
    setupAppStateTelemetryOwner.stop();
    jest.clearAllTimers();
    jest.useRealTimers();
    await flushAsync();
  });

  async function mount(sessionId: string) {
    const client = makeFakeClient(sessionId);
    openIds.push(sessionId);
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<SetupScreen {...makeProps(sessionId)} />);
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

  it('every FC-tool control keeps a >=44dp touch target and a labelled button role', async () => {
    const {renderer} = await mount('layout-touch-targets');
    for (const tool of ['ACC_CALIBRATION', 'MAG_CALIBRATION', 'REBOOT']) {
      const control = pressable(renderer, `fc-tool-${tool}-button`);
      expect(control.props.accessibilityRole).toBe('button');
      expect(String(control.props.accessibilityLabel).length).toBeGreaterThan(0);
      const styles = control.props.style as Array<{minHeight?: number} | undefined>;
      expect(styles.find(style => style?.minHeight !== undefined)?.minHeight).toBeGreaterThanOrEqual(44);
    }
  });

  it('no region uses a fixed height that could truncate it, and no inner list scrolls vertically', async () => {
    const {renderer} = await mount('layout-heights');
    for (const testID of ['diagnostics-section', 'fc-tools-section']) {
      const node = renderer.root.find(n => typeof n.type === 'string' && n.props.testID === testID);
      const styles = ([] as Array<{height?: number; maxHeight?: number} | undefined>).concat(node.props.style);
      for (const style of styles) {
        expect(style?.height).toBeUndefined();
        expect(style?.maxHeight).toBeUndefined();
      }
    }
    // Only the screen's own ScrollView scrolls; nothing nests another.
    expect(renderer.root.findAllByType(ScrollView)).toHaveLength(1);
  });

  it('Region 4 blocks are accessibility nodes whose labels match their visible text order', async () => {
    const {renderer} = await mount('layout-a11y-order');
    const blocks = ['diagnostics-identity', 'diagnostics-compatibility', 'diagnostics-reading-state', 'diagnostics-sensors', 'diagnostics-blockers'];
    const text = allText(renderer);
    let previous = -1;
    for (const testID of blocks) {
      const node = renderer.root.find(n => typeof n.type === 'string' && n.props.testID === testID);
      expect(node.props.accessible).toBe(true);
      const label = String(node.props.accessibilityLabel);
      expect(label.length).toBeGreaterThan(0);
      const heading = label.split('،')[0];
      const index = text.indexOf(heading);
      expect(index).toBeGreaterThan(previous);
      previous = index;
    }
  });

  it('a disabled control never relies on color alone - the reason is always text', async () => {
    const sessionId = 'layout-color';
    const {renderer} = await mount(sessionId);
    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
      await flushAsync();
    });
    const text = allText(renderer);
    expect(text).toContain(ARABIC.toolDisconnected);
    for (const tool of ['ACC_CALIBRATION', 'MAG_CALIBRATION', 'REBOOT']) {
      const control = pressable(renderer, `fc-tool-${tool}-button`);
      expect(control.props.disabled).toBe(true);
      expect(String(control.props.accessibilityLabel)).toContain(ARABIC.toolDisconnected);
      expect(control.props.accessibilityState).toEqual({disabled: true});
    }
  });
});
