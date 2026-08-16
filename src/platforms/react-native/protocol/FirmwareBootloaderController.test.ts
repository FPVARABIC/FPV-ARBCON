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
    const coordinator = {
      openSession: jest.fn(() => ({request})),
      getIdentificationState: jest.fn(() => ({status: 'SUCCEEDED', identity: IDENTITY})),
      subscribeIdentificationState: jest.fn(() => jest.fn()),
      deactivateMspSession: jest.fn(),
    };
    const controller = new FirmwareBootloaderController(client as never, coordinator as never);
    const detected = await controller.detectFlightController(undefined, {deviceId: 2, portIndex: 2});
    expect(client.openDevice).toHaveBeenCalledWith(2, 2, expect.objectContaining({baudRate: 115200}));
    expect(detected.targetMatches('SPEEDYBEEF405V4')).toBe(true);
    await expect(detected.rebootToBootloader('SPEEDYBEEF405V4')).resolves.toBe(4);
    expect(request).toHaveBeenCalledWith(MSP_REBOOT, Uint8Array.of(4), expect.any(Object));
    expect(client.closeSession).toHaveBeenCalledWith('firmware-session');
  });
});
