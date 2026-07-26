/**
 * Pass 7.7 - AppState pause/resume ownership. Uses the REAL coordinator +
 * real scheduler lease mechanism with a fake AppState source, so the
 * assertions are about genuine pause behavior, not a mocked stand-in.
 */

import {SetupAppStateTelemetryOwner} from './setupAppStateTelemetryOwner';
import {MspSessionCoordinator} from './MspSessionCoordinator';
import {ATTITUDE_TELEMETRY_POLL_ID} from './MspSessionCoordinator';
import {
  MSP_API_VERSION,
  MSP_FC_VARIANT,
  MSP_BOARD_INFO,
  MSP_ATTITUDE,
  MSP_BATTERY_STATE,
  MSP_ANALOG,
  MSP_RAW_GPS,
  MSP_STATUS_EX,
} from '../../../core';
import type {MspAttitude} from '../../../core';
import {buildMspFrameBytes} from '../../../core/protocol/__testUtils__/mspFixtures';
import {base64ToBytes, bytesToBase64} from './base64';
import type {UsbSerialDataEvent, UsbSerialSessionDetachedEvent, UsbSerialTransportClient} from '../transport';
import type {AppStateStatus, NativeEventSubscription} from 'react-native';

const SESSION_ID = 'appstate-session-1';

function ascii(text: string): number[] {
  return text.split('').map(c => c.charCodeAt(0));
}
/** Little-endian u16 without bitwise operators - this project's ESLint
 * baseline flags `no-bitwise`, and a new test helper must not add
 * warnings to it (arithmetic is exact for the 0..65535 range used here). */
function u16le(value: number): number[] {
  return [value % 256, Math.floor(value / 256) % 256];
}
function boardInfoPayload(): Uint8Array {
  return Uint8Array.from([
    ...ascii('AFF3'),
    ...u16le(0),
    0,
    0,
    4,
    ...ascii('TEST'),
    7,
    ...ascii('MyBoard'),
    4,
    ...ascii('MTKS'),
    ...new Array(32).fill(0),
    0,
  ]);
}
function attitudePayload(): Uint8Array {
  return Uint8Array.from([1, 0, 1, 0, 1, 0]);
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
}

function makeFakeClient(sessionId: string) {
  const dataListeners = new Set<(event: UsbSerialDataEvent) => void>();
  const detachListeners = new Set<(event: UsbSerialSessionDetachedEvent) => void>();
  const responses = new Map<number, Uint8Array>();
  const fake = {
    writeBytes: jest.fn((_sessionId: string, dataBase64: string) => {
      const command = base64ToBytes(dataBase64)[4];
      const payload = responses.get(command);
      if (payload) {
        Promise.resolve().then(() => {
          const frameBytes = buildMspFrameBytes(command, payload, {wireFormat: 'v1', direction: 'response'});
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
    stopReading: jest.fn().mockResolvedValue(undefined),
    startReading: jest.fn().mockResolvedValue(undefined),
    setResponse: (command: number, payload: Uint8Array) => {
      responses.set(command, payload);
    },
  };
  fake.setResponse(MSP_API_VERSION, Uint8Array.from([0, 1, 48]));
  fake.setResponse(MSP_FC_VARIANT, Uint8Array.from(ascii('BTFL')));
  fake.setResponse(MSP_BOARD_INFO, boardInfoPayload());
  fake.setResponse(MSP_ATTITUDE, attitudePayload());
  // Fixture isolation (same rationale as the coordinator/SetupScreen
  // suites): an identified BETAFLIGHT session also registers battery and
  // the three auxiliary Region 3 polls. Unanswered, each would occupy the
  // ONE serialized MSP link for a full 2000ms response timeout and starve
  // the attitude cadence this suite measures. Benign responses keep the
  // queue flowing; this suite is about AppState pausing, nothing else.
  fake.setResponse(MSP_BATTERY_STATE, Uint8Array.from([4, ...u16le(1500), 168, ...u16le(0), ...u16le(0), 0, ...u16le(1680)]));
  fake.setResponse(MSP_ANALOG, Uint8Array.from([168, ...u16le(0), ...u16le(540), ...u16le(0), ...u16le(1680)]));
  fake.setResponse(MSP_RAW_GPS, Uint8Array.from([2, 8, 0, 0, 0, 0, 0, 0, 0, 0, ...u16le(0), ...u16le(0), ...u16le(0)]));
  fake.setResponse(MSP_STATUS_EX, Uint8Array.from([...u16le(312), ...u16le(0), ...u16le(41), 0, 0, 0, 0, 0, ...u16le(12)]));
  return fake;
}

/** Fake AppState: one listener slot, exactly like the real module's
 * addEventListener contract, so "no duplicate listeners" is observable. */
function makeFakeAppState() {
  const listeners: Array<(status: AppStateStatus) => void> = [];
  let removals = 0;
  return {
    currentState: 'active' as AppStateStatus,
    listenerCount: () => listeners.length,
    removalCount: () => removals,
    addEventListener(_type: 'change', listener: (status: AppStateStatus) => void): NativeEventSubscription {
      listeners.push(listener);
      return {
        remove: () => {
          removals += 1;
          const index = listeners.indexOf(listener);
          if (index >= 0) {
            listeners.splice(index, 1);
          }
        },
      } as NativeEventSubscription;
    },
    emit(status: AppStateStatus) {
      for (const listener of Array.from(listeners)) {
        listener(status);
      }
    },
  };
}

describe('SetupAppStateTelemetryOwner', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(async () => {
    await flushAsync();
    jest.clearAllTimers();
    jest.useRealTimers();
    await flushAsync();
  });

  async function openSession(coordinator: MspSessionCoordinator, sessionId = SESSION_ID) {
    const client = makeFakeClient(sessionId);
    coordinator.openSession(client as unknown as UsbSerialTransportClient, sessionId);
    await flushAsync();
    return client;
  }

  const countAttitudeWrites = (client: ReturnType<typeof makeFakeClient>) =>
    client.writeBytes.mock.calls.filter(call => base64ToBytes(call[1] as string)[4] === MSP_ATTITUDE).length;

  it('backgrounding pauses NEW dispatches without closing the session or fabricating a disconnect', async () => {
    const coordinator = new MspSessionCoordinator();
    const appState = makeFakeAppState();
    const owner = new SetupAppStateTelemetryOwner({coordinator, appState});
    owner.start();
    const client = await openSession(coordinator);

    await jest.advanceTimersByTimeAsync(1000);
    await flushAsync();
    const beforeBackground = countAttitudeWrites(client);
    expect(beforeBackground).toBeGreaterThan(0);

    const stopReadingCallsBeforeBackground = client.stopReading.mock.calls.length;
    appState.emit('background');
    expect(owner.getPhase()).toBe('APP_BACKGROUND');
    expect(owner.isPausedFor(SESSION_ID)).toBe(true);

    await jest.advanceTimersByTimeAsync(3000);
    await flushAsync();
    expect(countAttitudeWrites(client)).toBe(beforeBackground); // zero new dispatches

    // The physical session is untouched - no fabricated disconnection and
    // no teardown of the reader caused BY backgrounding.
    expect(coordinator.getOwnershipState(SESSION_ID)).toBe('ACTIVE');
    expect(client.stopReading).toHaveBeenCalledTimes(stopReadingCallsBeforeBackground);

    owner.stop();
    coordinator.deactivateMspSession(SESSION_ID);
    await flushAsync();
  });

  it('resuming the SAME active generation restarts dispatches, and never re-presents an old sample as newly FRESH', async () => {
    const coordinator = new MspSessionCoordinator();
    const appState = makeFakeAppState();
    const owner = new SetupAppStateTelemetryOwner({coordinator, appState});
    owner.start();
    const client = await openSession(coordinator);

    await jest.advanceTimersByTimeAsync(500);
    await flushAsync();
    const scheduler = coordinator.getTelemetryScheduler(SESSION_ID)!;
    const beforeBackground = scheduler.getValue<MspAttitude>(ATTITUDE_TELEMETRY_POLL_ID);
    expect(beforeBackground.status).toBe('FRESH');
    const originalUpdatedAtMs = beforeBackground.status === 'FRESH' ? beforeBackground.updatedAtMs : 0;

    appState.emit('background');
    await jest.advanceTimersByTimeAsync(2000);
    await flushAsync();
    // Time passing while paused makes the sample honestly STALE - the
    // owner publishes nothing and does not touch freshness rules.
    expect(scheduler.getValue<MspAttitude>(ATTITUDE_TELEMETRY_POLL_ID).status).toBe('STALE');

    const pausedWrites = countAttitudeWrites(client);
    appState.emit('active');
    expect(owner.isPausedFor(SESSION_ID)).toBe(false);
    // Resuming alone does NOT relabel the old sample: only a genuinely new
    // reading (with its own newer timestamp) can be FRESH again.
    const immediatelyAfterResume = scheduler.getValue<MspAttitude>(ATTITUDE_TELEMETRY_POLL_ID);
    if (immediatelyAfterResume.status === 'STALE') {
      expect(immediatelyAfterResume.updatedAtMs).toBe(originalUpdatedAtMs);
    }

    await jest.advanceTimersByTimeAsync(500);
    await flushAsync();
    expect(countAttitudeWrites(client)).toBeGreaterThan(pausedWrites);
    const resumed = scheduler.getValue<MspAttitude>(ATTITUDE_TELEMETRY_POLL_ID);
    expect(resumed.status).toBe('FRESH');
    if (resumed.status === 'FRESH') {
      expect(resumed.updatedAtMs).toBeGreaterThan(originalUpdatedAtMs);
    }

    owner.stop();
    coordinator.deactivateMspSession(SESSION_ID);
    await flushAsync();
  });

  it('repeated background/active cycles never add duplicate listeners, leases, schedulers or pollers', async () => {
    const coordinator = new MspSessionCoordinator();
    const appState = makeFakeAppState();
    const owner = new SetupAppStateTelemetryOwner({coordinator, appState});
    owner.start();
    owner.start(); // idempotent
    expect(appState.listenerCount()).toBe(1);

    const client = await openSession(coordinator);
    const schedulerBefore = coordinator.getTelemetryScheduler(SESSION_ID);
    for (let i = 0; i < 5; i++) {
      appState.emit('background');
      appState.emit('background'); // duplicate same-phase event: ignored
      await jest.advanceTimersByTimeAsync(300);
      appState.emit('active');
      appState.emit('active');
      await jest.advanceTimersByTimeAsync(300);
      await flushAsync();
    }

    expect(appState.listenerCount()).toBe(1);
    expect(owner.isPausedFor(SESSION_ID)).toBe(false);
    expect(coordinator.getTelemetryScheduler(SESSION_ID)).toBe(schedulerBefore); // same scheduler, never recreated

    // Still polling normally after all those cycles.
    const before = countAttitudeWrites(client);
    await jest.advanceTimersByTimeAsync(500);
    await flushAsync();
    expect(countAttitudeWrites(client)).toBeGreaterThan(before);

    owner.stop();
    coordinator.deactivateMspSession(SESSION_ID);
    await flushAsync();
  });

  it('a session torn down while backgrounded cannot resume old work', async () => {
    const coordinator = new MspSessionCoordinator();
    const appState = makeFakeAppState();
    const owner = new SetupAppStateTelemetryOwner({coordinator, appState});
    owner.start();
    const client = await openSession(coordinator);

    appState.emit('background');
    expect(owner.isPausedFor(SESSION_ID)).toBe(true);

    // Detach/teardown happens while backgrounded.
    coordinator.deactivateMspSession(SESSION_ID);
    await flushAsync();
    const writesAtTeardown = countAttitudeWrites(client);

    appState.emit('active');
    await jest.advanceTimersByTimeAsync(2000);
    await flushAsync();

    expect(coordinator.getTelemetryScheduler(SESSION_ID)).toBeUndefined();
    expect(countAttitudeWrites(client)).toBe(writesAtTeardown); // nothing revived
    expect(owner.isPausedFor(SESSION_ID)).toBe(false);

    owner.stop();
    await flushAsync();
  });

  it('a REPLACEMENT generation opened while backgrounded is paused, and the replaced one never resumes', async () => {
    const coordinator = new MspSessionCoordinator();
    const appState = makeFakeAppState();
    const owner = new SetupAppStateTelemetryOwner({coordinator, appState});
    owner.start();
    await openSession(coordinator);

    appState.emit('background');
    coordinator.deactivateMspSession(SESSION_ID);
    await flushAsync();

    const client2 = await openSession(coordinator); // replacement, still backgrounded
    owner.track(SESSION_ID);
    expect(owner.isPausedFor(SESSION_ID)).toBe(true);
    const writesAfterOpen = countAttitudeWrites(client2);
    await jest.advanceTimersByTimeAsync(2000);
    await flushAsync();
    expect(countAttitudeWrites(client2)).toBe(writesAfterOpen); // paused immediately

    appState.emit('active');
    await jest.advanceTimersByTimeAsync(500);
    await flushAsync();
    expect(countAttitudeWrites(client2)).toBeGreaterThan(writesAfterOpen); // only the CURRENT one resumes

    owner.stop();
    coordinator.deactivateMspSession(SESSION_ID);
    await flushAsync();
  });

  it('stop() releases every lease, removes the single listener and leaves no timer', async () => {
    const coordinator = new MspSessionCoordinator();
    const appState = makeFakeAppState();
    const owner = new SetupAppStateTelemetryOwner({coordinator, appState});
    owner.start();
    await openSession(coordinator);
    appState.emit('background');
    expect(owner.isPausedFor(SESSION_ID)).toBe(true);

    owner.stop();
    expect(owner.isPausedFor(SESSION_ID)).toBe(false);
    expect(appState.listenerCount()).toBe(0);
    expect(appState.removalCount()).toBe(1);

    coordinator.deactivateMspSession(SESSION_ID);
    await flushAsync();
    await jest.advanceTimersByTimeAsync(2250);
    await flushAsync();
    expect(jest.getTimerCount()).toBe(0);
  });
});
