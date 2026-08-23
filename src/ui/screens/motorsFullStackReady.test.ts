/**
 * Full production path for the Motors readiness gate:
 * coordinator -> capability -> binding -> controller -> real MSP client.
 *
 * The existing screen and controller suites deliberately isolate those
 * layers. This regression keeps the browser-facing session assembly in the
 * test so a button can never remain disabled because the layers disagree.
 */

import {
  MSP_ADVANCED_CONFIG,
  MSP_API_VERSION,
  MSP_ATTITUDE,
  MSP_BOARD_INFO,
  MSP_BOXIDS,
  MSP_FC_VARIANT,
  MSP_FEATURE_CONFIG,
  MSP_MIXER_CONFIG,
  MSP_MOTOR_CONFIG,
  MSP_STATUS_EX,
} from '../../core';
import {MSP_SET_ARMING_DISABLED} from '../../core/state/motorArmingRestriction';
import {buildMspFrameBytes} from '../../core/protocol/__testUtils__/mspFixtures';
import {MOTOR_TEST_SAFETY_OBSERVATION_INTERVAL_MILLIS} from '../../core/state/motorTestSafetyMonitor';
import {
  MspSessionCoordinator,
} from '../../platforms/react-native/protocol';
import {readMotorTestCapability} from '../../platforms/react-native/protocol/motorTestCapability';
import {base64ToBytes, bytesToBase64} from '../../platforms/react-native/protocol/base64';
import type {
  UsbSerialDataEvent,
  UsbSerialSessionDetachedEvent,
  UsbSerialTransportClient,
} from '../../platforms/react-native/transport';

const SESSION_ID = 'motors-full-stack';
const RESPONSE_DELAY_MS = 224;

const ascii = (value: string): number[] =>
  value.split('').map(character => character.charCodeAt(0));
const u16 = (value: number): number[] => [value % 256, Math.floor(value / 256) % 256];
const u32 = (value: number): number[] => [
  value % 256,
  Math.floor(value / 256) % 256,
  Math.floor(value / 65536) % 256,
  Math.floor(value / 16777216) % 256,
];
const pstring = (value: string): number[] => [value.length, ...ascii(value)];

function motorConfig(): Uint8Array {
  return Uint8Array.from([...u16(0), ...u16(2000), ...u16(1000), 4, 14, 0, 0]);
}

function advancedConfig(): Uint8Array {
  return Uint8Array.from([1, 1, 0, 6, ...u16(480), ...u16(550), 0, 0, 0, 0, 0, ...u16(125), ...u16(0), 0, 0, 0]);
}

/**
 * P2-ii: `armingDisableFlags` gained a parameter so this fixture can model
 * a flight controller that has ACCEPTED the MSP arming restriction. The
 * enable path now establishes it and independently re-reads MSP_STATUS_EX
 * to verify bit 16 came back set, so a status that never reports the flag
 * would describe a device that ignored the write.
 */
function disarmedStatus(armingDisableFlags = 0): Uint8Array {
  return Uint8Array.from([
    ...u16(125), ...u16(0), ...u16(0x21), ...u32(0), 2, ...u16(15),
    4, 1, 0, 29, ...u32(armingDisableFlags), 0, ...u16(3400), 6,
  ]);
}

/** ARMING_DISABLED_MSP is bit 16 of the global mask. */
const MSP_RESTRICTION_BIT = 16;

function makeTransport(): UsbSerialTransportClient {
  const dataListeners = new Set<(event: UsbSerialDataEvent) => void>();
  const detachListeners = new Set<(event: UsbSerialSessionDetachedEvent) => void>();
  const responses = new Map<number, Uint8Array>([
    [MSP_API_VERSION, Uint8Array.from([0, 1, 48])],
    [MSP_ATTITUDE, Uint8Array.from([...u16(0), ...u16(0), ...u16(0)])],
    [MSP_FC_VARIANT, Uint8Array.from(ascii('BTFL'))],
    [MSP_BOARD_INFO, Uint8Array.from([
      ...ascii('AFF3'), ...u16(0), 0, 0,
      ...pstring('TEST'), ...pstring('MyBoard'), ...pstring('MTKS'),
      ...new Array(32).fill(0), 0,
    ])],
    [MSP_MOTOR_CONFIG, motorConfig()],
    [MSP_ADVANCED_CONFIG, advancedConfig()],
    [MSP_FEATURE_CONFIG, Uint8Array.from(u32(0))],
    // M-D: MIXER_QUADX (3), yaw not reversed. The setup reads which
    // airframe it is so the view can draw the right one; presentation
    // only - the motor COUNT still comes from MSP_MOTOR_CONFIG alone.
    [MSP_MIXER_CONFIG, Uint8Array.from([3, 0])],
    [MSP_BOXIDS, Uint8Array.from([0, 1, 2, 13])],
    [MSP_STATUS_EX, disarmedStatus()],
    // P2-ii: command 99 is acknowledged with an empty payload.
    [MSP_SET_ARMING_DISABLED, new Uint8Array(0)],
  ]);

  return {
    writeBytes: jest.fn((_sessionId: string, encoded: string) => {
      const command = base64ToBytes(encoded)[4];
      const payload = responses.get(command);
      // A device that accepted the restriction reports it in every later
      // status, which is what the establishment's re-read verifies.
      if (command === MSP_SET_ARMING_DISABLED) {
        responses.set(
          MSP_STATUS_EX,
          disarmedStatus(Math.pow(2, MSP_RESTRICTION_BIT)),
        );
      }
      if (payload !== undefined) {
        setTimeout(() => {
          const frame = buildMspFrameBytes(command, payload, {
            wireFormat: 'v1',
            direction: 'response',
          });
          for (const listener of dataListeners) {
            listener({sessionId: SESSION_ID, dataBase64: bytesToBase64(frame)});
          }
        }, RESPONSE_DELAY_MS);
      }
      return Promise.resolve();
    }),
    startReading: jest.fn().mockResolvedValue(undefined),
    stopReading: jest.fn().mockResolvedValue(undefined),
    onDataReceived: jest.fn(listener => {
      dataListeners.add(listener);
      return {remove: () => dataListeners.delete(listener)};
    }),
    onSessionDetached: jest.fn(listener => {
      detachListeners.add(listener);
      return {remove: () => detachListeners.delete(listener)};
    }),
  } as unknown as UsbSerialTransportClient;
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
}

async function serveRoundTrips(count: number): Promise<void> {
  for (let request = 0; request < count; request += 1) {
    await jest.advanceTimersByTimeAsync(RESPONSE_DELAY_MS + 10);
    await flush();
  }
}

async function driveUntil(settled: () => boolean, maximumTurns: number): Promise<void> {
  for (let turn = 0; turn < maximumTurns && !settled(); turn += 1) {
    await serveRoundTrips(1);
  }
}

describe('Motors full-stack readiness', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('reaches Ready through the same capability used by the web screen', async () => {
    const coordinator = new MspSessionCoordinator();
    const transport = makeTransport();
    coordinator.openSession(transport, SESSION_ID);
    await flush();

    // Identification is three serialized round trips. Drive one timer at a
    // time because each following request is registered by the previous
    // response's promise continuation.
    await driveUntil(
      () => coordinator.getIdentificationState(SESSION_ID).status !== 'RUNNING',
      8,
    );
    expect(coordinator.getIdentificationState(SESSION_ID).status).toBe('SUCCEEDED');

    const capability = readMotorTestCapability(SESSION_ID);
    expect(capability).toBeDefined();
    const operator = capability!.operatorPort(
      {
        readCurrentIdentity: () => coordinator.getMotorTestSessionIdentity(SESSION_ID),
        readFirmwareIdentification: () => coordinator.getIdentificationState(SESSION_ID),
        subscribeFirmwareIdentification: listener => coordinator.subscribeIdentificationState(listener),
        subscribeSessionInvalidated: listener => coordinator.subscribeMotorTestSessionInvalidated(SESSION_ID, listener),
      },
      () => Date.now(),
    );

    const beginning = operator.beginSession();
    // Configuration, BOXIDS and the first live DISARMED observation.
    // P2-ii adds two round trips to the enable path - command 99 and its
    // independent MSP_STATUS_EX verification re-read - so the bounded
    // drive needs headroom for them. It still stops as soon as READY is
    // reached, so the bound is a safety net, not a fixed step count.
    await driveUntil(() => operator.getSnapshot().setupStep === 'READY', 20);
    const ready = await beginning;

    expect(ready).toMatchObject({
      phase: 'ACTIVE',
      setupStep: 'READY',
      outcome: {kind: 'READY'},
      activation: {allowed: true, reasons: []},
      armedStateEvidence: 'FRESH_DISARMED',
      motorScope: {motorCount: 4, motorProtocolRaw: 6, feature3dEnabled: false},
    });

    const writeBytes = transport.writeBytes as jest.MockedFunction<
      UsbSerialTransportClient['writeBytes']
    >;
    const statusWriteCount = (): number =>
      writeBytes.mock.calls.filter(
        call => base64ToBytes(call[1])[4] === MSP_STATUS_EX,
      ).length;

    // READY must not be followed by an immediate back-to-back status read.
    // That exact zero-delay cycle was able to fault a healthy browser link
    // and produced READY + REQUIRES_NEW_CONNECTION in the operator's trace.
    //
    // UPDATED IN P2-ii: the baseline grew from 1 to 3 because the enable
    // path now establishes the arming restriction, which performs its own
    // independent MSP_STATUS_EX verification re-read, and the monitor takes
    // a fresh reading afterwards. The GUARD is unchanged and is what
    // matters: the count must be a small FIXED number at READY and must
    // then advance by exactly one per observation interval. A runaway
    // zero-delay loop would blow past both assertions.
    const READY_STATUS_READS = 3;
    expect(statusWriteCount()).toBe(READY_STATUS_READS);
    expect(MOTOR_TEST_SAFETY_OBSERVATION_INTERVAL_MILLIS).toBeGreaterThan(0);
    // The restriction's verification re-read leaves the monitor's own
    // interval freshly armed, so the next observation is one full interval
    // away from THAT read rather than from READY. Advancing the interval
    // plus one response delay lands after it deterministically.
    await jest.advanceTimersByTimeAsync(
      MOTOR_TEST_SAFETY_OBSERVATION_INTERVAL_MILLIS + RESPONSE_DELAY_MS,
    );
    await flush();
    expect(statusWriteCount()).toBe(READY_STATUS_READS + 1);
    await jest.advanceTimersByTimeAsync(RESPONSE_DELAY_MS);
    await flush();
    expect(operator.getSnapshot().activation).toEqual({
      allowed: true,
      reasons: [],
    });

    coordinator.deactivateMspSession(SESSION_ID);
    await flush();
  });
});
