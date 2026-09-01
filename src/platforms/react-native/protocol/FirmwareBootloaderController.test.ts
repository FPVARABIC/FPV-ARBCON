jest.mock('../transport/native/NativeUsbSerialTransport');

import {MSP_REBOOT} from '../../../core';
import type {FlightControllerIdentity} from '../../../core';
import {FirmwareBootloaderController} from './FirmwareBootloaderController';

const IDENTITY: FlightControllerIdentity = {
  apiVersion: {mspProtocolVersion: 0, apiVersionMajor: 1, apiVersionMinor: 47},
  firmware: {identifier: 'BTFL', knownFamily: 'BETAFLIGHT'},
  board: {
    boardIdentifier: 'S405',
    hardwareRevision: 1,
    boardType: 0,
    targetCapabilities: 1 << 3,
    targetName: 'SPEEDYBEEF405V4',
    boardName: 'SPEEDYBEEF405V4',
    manufacturerId: 'SPBE',
    signature: new Uint8Array(32),
    mcuTypeId: 3,
    trailingBytes: new Uint8Array(0),
    truncated: false,
  },
};

describe('FirmwareBootloaderController manual selection', () => {
  it('opens the exact selected device/port and uses capability-aware reboot mode 4', async () => {
    const client = {
      listDevices: jest.fn(async () => [
        {deviceId: 1, vendorId: 1, productId: 1, driverType: 'CDC', portCount: 1},
        {deviceId: 2, vendorId: 2, productId: 2, driverType: 'CDC', portCount: 3},
      ]),
      openDevice: jest.fn(async () => 'firmware-session'),
      stopReading: jest.fn(async () => undefined),
      closeSession: jest.fn(async () => undefined),
    };
    const request = jest.fn(async () => new Uint8Array(0));
    /*
     * The double TRACKS OWNERSHIP rather than answering with a constant.
     *
     * detectFlightController now releases whatever sessions this
     * application still owns before it opens the port (a serial port
     * admits one owner - see exclusiveDeviceAccess.ts), so a coordinator
     * stub whose listSessionIds() lies would let a broken release step
     * pass unnoticed. A set that openSession fills and
     * deactivateMspSession empties is the smallest faithful model.
     */
    const ownedSessions = new Set<string>();
    const coordinator = {
      listSessionIds: jest.fn(() => [...ownedSessions]),
      openSession: jest.fn((_client: unknown, sessionId: string) => {
        ownedSessions.add(sessionId);
        return {request};
      }),
      getIdentificationState: jest.fn(() => ({status: 'SUCCEEDED', identity: IDENTITY})),
      subscribeIdentificationState: jest.fn(() => jest.fn()),
      deactivateMspSession: jest.fn((sessionId: string) => {
        ownedSessions.delete(sessionId);
      }),
    };
    const controller = new FirmwareBootloaderController(client as never, coordinator as never);
    const detected = await controller.detectFlightController(undefined, {deviceId: 2, portIndex: 2});
    expect(client.openDevice).toHaveBeenCalledWith(2, 2, expect.objectContaining({baudRate: 115200}));
    expect(detected.targetMatches('SPEEDYBEEF405V4')).toBe(true);
    await expect(detected.rebootToBootloader('SPEEDYBEEF405V4')).resolves.toBe(4);
    expect(request).toHaveBeenCalledWith(MSP_REBOOT, Uint8Array.of(4), expect.any(Object));
    expect(client.closeSession).toHaveBeenCalledWith('firmware-session');
    // The reboot handed the board to the bootloader, so this application
    // must be holding nothing: an ownership record left behind here is
    // what makes the NEXT detect read a dead session's verdict.
    expect(coordinator.listSessionIds()).toEqual([]);
  });
});
