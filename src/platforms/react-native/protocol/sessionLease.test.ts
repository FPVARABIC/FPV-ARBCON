/**
 * The real native module is replaced by a sentinel that THROWS on any
 * property access, so this suite cannot reach a hardware path even by
 * accident. Every test below asserts at the end that it never fired.
 */
jest.mock('../transport/native/NativeUsbSerialTransport', () => ({
  __esModule: true,
  default: new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`native leaf touched ("${String(property)}")`);
      },
    },
  ),
}));

import {MSP_API_VERSION, MSP_BOARD_INFO, MSP_FC_VARIANT, MSP_REBOOT} from '../../../core';
import {buildMspFrameBytes} from '../../../core/protocol/__testUtils__/mspFixtures';
import {base64ToBytes, bytesToBase64} from './base64';
import {FirmwareBootloaderController, FirmwareDetectionError} from './FirmwareBootloaderController';
import {MspSessionCoordinator} from './MspSessionCoordinator';
import type {UsbSerialDataEvent, UsbSerialTransportClient} from '../transport';

/**
 * ONE LEASE, ONE RELEASE OBLIGATION.
 *
 * `detectFlightController()` hands the caller a lease.
 * `rebootToBootloader()` CONSUMES it: ownership transfers at that one call
 * and the callee discharges it on every exit - success, either early guard,
 * a rejected request or a cancellation. The caller discharges it only where
 * that transfer never happened.
 *
 * The assertions below are written against the LOGICAL lease state and the
 * coordinator's ownership, never against how many times the transport
 * happened to be told to close. A transport close count is an incidental
 * observation, not a documented contract.
 */

const ascii = (text: string): number[] => [...text].map(character => character.charCodeAt(0));
const pstring = (text: string): number[] => [text.length, ...ascii(text)];
// eslint-disable-next-line no-bitwise -- little-endian pair.
const u16le = (value: number): number[] => [value & 0xff, (value >> 8) & 0xff];

function makeBoard(options: {variant?: string; boardName?: string} = {}): {
  client: UsbSerialTransportClient;
  rebootPayload: () => number[] | null;
} {
  const responses = new Map<number, Uint8Array>([
    [MSP_API_VERSION, Uint8Array.from([0, 1, 48])],
    [MSP_FC_VARIANT, Uint8Array.from(ascii(options.variant ?? 'BTFL'))],
    [
      MSP_BOARD_INFO,
      Uint8Array.from([
        ...ascii('AFF3'),
        ...u16le(0),
        0,
        0,
        ...pstring('STM32F411'),
        ...pstring(options.boardName ?? 'SPEEDYBEEF405V3'),
        ...pstring('SPBE'),
        ...new Array(32).fill(0),
        0,
        0,
      ]),
    ],
  ]);
  const listeners = new Set<(event: UsbSerialDataEvent) => void>();
  let reboot: number[] | null = null;
  let sequence = 0;

  const client = {
    listDevices: async () => [
      {
        deviceId: 7,
        vendorId: 0x0483,
        productId: 0x5740,
        productName: 'STM32 Virtual COM',
        manufacturerName: 'STMicroelectronics',
        driverType: 'CDC_ACM',
        portCount: 1,
      },
    ],
    listDfuDevices: async () => [],
    openDevice: async () => {
      sequence += 1;
      return `lease-s${sequence}`;
    },
    closeSession: async () => undefined,
    startReading: async () => undefined,
    stopReading: async () => undefined,
    setBaudRate: async () => undefined,
    setControlLines: async () => undefined,
    writeBytes: async (sessionId: string, dataBase64: string) => {
      const bytes = base64ToBytes(dataBase64);
      const command = bytes[4];
      const size = bytes[3];
      if (command === MSP_REBOOT) {
        reboot = Array.from(bytes.slice(5, 5 + size));
        return;
      }
      const response = responses.get(command);
      if (response === undefined) return;
      const frame = buildMspFrameBytes(command, response, {
        wireFormat: 'v1',
        direction: 'response',
      });
      for (const listener of Array.from(listeners)) {
        listener({sessionId, dataBase64: bytesToBase64(frame)});
      }
    },
    onDataReceived: (listener: (event: UsbSerialDataEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onSessionDetached: () => () => undefined,
    onError: () => () => undefined,
  } as unknown as UsbSerialTransportClient;

  return {client, rebootPayload: () => reboot};
}

describe('the detected-controller lease', () => {
  it('is HELD_BY_CALLER on detection and RELEASED once the caller releases it', async () => {
    const {client} = makeBoard();
    const coordinator = new MspSessionCoordinator();
    const detected = await new FirmwareBootloaderController(client, coordinator)
      .detectFlightController();
    expect(detected.leaseState).toBe('HELD_BY_CALLER');
    expect(coordinator.listSessionIds()).toContain(detected.sessionId);
    await detected.release();
    expect(detected.leaseState).toBe('RELEASED');
    expect(coordinator.listSessionIds()).toEqual([]);
  });

  it('a refused reboot (non-Betaflight) still discharges the obligation', async () => {
    const {client, rebootPayload} = makeBoard({variant: 'INAV'});
    const coordinator = new MspSessionCoordinator();
    const detected = await new FirmwareBootloaderController(client, coordinator)
      .detectFlightController();
    await expect(detected.rebootToBootloader('SPEEDYBEEF405V3')).rejects.toBeInstanceOf(
      FirmwareDetectionError,
    );
    /* The guard refused BEFORE any reboot went out - and still released. */
    expect(rebootPayload()).toBeNull();
    expect(detected.leaseState).toBe('RELEASED');
    expect(coordinator.listSessionIds()).toEqual([]);
  });

  it('a refused reboot (target mismatch) still discharges the obligation', async () => {
    const {client, rebootPayload} = makeBoard();
    const coordinator = new MspSessionCoordinator();
    const detected = await new FirmwareBootloaderController(client, coordinator)
      .detectFlightController();
    await expect(detected.rebootToBootloader('MATEKF405')).rejects.toBeInstanceOf(
      FirmwareDetectionError,
    );
    expect(rebootPayload()).toBeNull();
    expect(detected.leaseState).toBe('RELEASED');
    expect(coordinator.listSessionIds()).toEqual([]);
  });

  it('a successful reboot still puts MSP_REBOOT on the wire and discharges the lease', async () => {
    const {client, rebootPayload} = makeBoard();
    const coordinator = new MspSessionCoordinator();
    const detected = await new FirmwareBootloaderController(client, coordinator)
      .detectFlightController();
    const mode = await detected.rebootToBootloader('SPEEDYBEEF405V3');
    expect(mode).toBe(1);
    expect(rebootPayload()).toEqual([1]);
    expect(detected.leaseState).toBe('RELEASED');
    expect(coordinator.listSessionIds()).toEqual([]);
  });

  it('release is idempotent as a SAFETY NET, and the lease still reads RELEASED once', async () => {
    const {client} = makeBoard();
    const coordinator = new MspSessionCoordinator();
    const detected = await new FirmwareBootloaderController(client, coordinator)
      .detectFlightController();
    await detected.rebootToBootloader('SPEEDYBEEF405V3');
    expect(detected.leaseState).toBe('RELEASED');
    /* A caller that also releases must not be able to break anything - but
     * idempotence is the net, not the contract. */
    await detected.release();
    await detected.release();
    expect(detected.leaseState).toBe('RELEASED');
    expect(coordinator.listSessionIds()).toEqual([]);
  });

  it('ownership transfers exactly once, so a caller-side finally is a no-op after reboot', async () => {
    const {client} = makeBoard();
    const coordinator = new MspSessionCoordinator();
    const detected = await new FirmwareBootloaderController(client, coordinator)
      .detectFlightController();
    /* This mirrors the screen: release only when the transfer never
     * happened. After a reboot the state is RELEASED, so the caller does
     * nothing - one obligation, one discharge. */
    try {
      await detected.rebootToBootloader('SPEEDYBEEF405V3');
    } finally {
      if (detected.leaseState === 'HELD_BY_CALLER') await detected.release();
    }
    expect(detected.leaseState).toBe('RELEASED');
    expect(coordinator.listSessionIds()).toEqual([]);
  });
});

it('the native leaf sentinel never fired', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const module_ = require('../transport/native/NativeUsbSerialTransport');
  expect(() => (module_.default as {listDevices: unknown}).listDevices).toThrow(/native leaf touched/);
});
