jest.mock('./native/NativeUsbSerialTransport');

import NativeUsbSerialTransport from './native/NativeUsbSerialTransport';
import {UsbSerialTransportClient, isSupportedDevice} from './UsbSerialTransportClient';
import type {SerialConfiguration, UsbSerialDeviceDescriptor} from './native/NativeUsbSerialTransport';

const mockedNative = NativeUsbSerialTransport as unknown as {
  listDevices: jest.Mock;
  openDevice: jest.Mock;
  closeSession: jest.Mock;
  startReading: jest.Mock;
  stopReading: jest.Mock;
  writeBytes: jest.Mock;
  onDataReceived: jest.Mock;
  onError: jest.Mock;
  unprotectDfuDevice: jest.Mock;
};

const CONFIGURATION: SerialConfiguration = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: '1',
  parity: 'none',
  flowControl: 'off',
};

function device(overrides: Partial<UsbSerialDeviceDescriptor> = {}): UsbSerialDeviceDescriptor {
  return {
    deviceId: 1,
    vendorId: 0x1a86,
    productId: 0x7523,
    driverType: 'CH34X',
    portCount: 1,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('isSupportedDevice', () => {
  it('is supported when driverType is recognized and portCount > 0', () => {
    expect(isSupportedDevice(device())).toBe(true);
  });

  it('is not supported when driverType is UNSUPPORTED', () => {
    expect(isSupportedDevice(device({driverType: 'UNSUPPORTED', portCount: 0}))).toBe(false);
  });

  it('is not supported when portCount is 0 even with a recognized driver', () => {
    expect(isSupportedDevice(device({portCount: 0}))).toBe(false);
  });
});

describe('UsbSerialTransportClient.listDevices', () => {
  it('returns the descriptor list on a successful response', async () => {
    const devices = [device(), device({deviceId: 2})];
    mockedNative.listDevices.mockResolvedValueOnce(devices);
    const client = new UsbSerialTransportClient();
    await expect(client.listDevices()).resolves.toEqual(devices);
  });

  it('returns an empty array when the native side finds nothing', async () => {
    mockedNative.listDevices.mockResolvedValueOnce([]);
    const client = new UsbSerialTransportClient();
    await expect(client.listDevices()).resolves.toEqual([]);
  });

  it('drops malformed descriptors instead of failing the whole scan', async () => {
    const valid = device();
    mockedNative.listDevices.mockResolvedValueOnce([valid, {deviceId: 'not-a-number'}, null, 42]);
    const client = new UsbSerialTransportClient();
    await expect(client.listDevices()).resolves.toEqual([valid]);
  });

  it('normalizes a rejected native call', async () => {
    mockedNative.listDevices.mockRejectedValueOnce({
      code: 'DEVICE_ENUMERATION_FAILED',
      message: 'boom',
    });
    const client = new UsbSerialTransportClient();
    await expect(client.listDevices()).rejects.toEqual({
      code: 'DEVICE_ENUMERATION_FAILED',
      nativeMessage: 'boom',
    });
  });

  it('never retries automatically', async () => {
    mockedNative.listDevices.mockResolvedValueOnce([]);
    const client = new UsbSerialTransportClient();
    await client.listDevices();
    expect(mockedNative.listDevices).toHaveBeenCalledTimes(1);
  });
});

describe('UsbSerialTransportClient.openDevice', () => {
  it('resolves with the sessionId on success', async () => {
    mockedNative.openDevice.mockResolvedValueOnce('session-123');
    const client = new UsbSerialTransportClient();
    await expect(client.openDevice(1, 0, CONFIGURATION)).resolves.toBe('session-123');
    expect(mockedNative.openDevice).toHaveBeenCalledWith(1, 0, CONFIGURATION);
  });

  it('rejects an empty sessionId as an invalid native result', async () => {
    mockedNative.openDevice.mockResolvedValueOnce('');
    const client = new UsbSerialTransportClient();
    await expect(client.openDevice(1, 0, CONFIGURATION)).rejects.toMatchObject({
      code: 'UNKNOWN_ERROR',
    });
  });

  it('normalizes a rejected native call', async () => {
    mockedNative.openDevice.mockRejectedValueOnce({code: 'PERMISSION_DENIED', message: 'no'});
    const client = new UsbSerialTransportClient();
    await expect(client.openDevice(1, 0, CONFIGURATION)).rejects.toEqual({
      code: 'PERMISSION_DENIED',
      nativeMessage: 'no',
    });
  });
});

describe('UsbSerialTransportClient.closeSession', () => {
  it('resolves on success', async () => {
    mockedNative.closeSession.mockResolvedValueOnce(undefined);
    const client = new UsbSerialTransportClient();
    await expect(client.closeSession('session-123')).resolves.toBeUndefined();
    expect(mockedNative.closeSession).toHaveBeenCalledWith('session-123');
  });

  it('normalizes a rejected native call and never exposes nativeStackAndroid', async () => {
    mockedNative.closeSession.mockRejectedValueOnce({
      code: 'CLOSE_FAILED',
      message: 'failed',
      nativeStackAndroid: [{class: 'java.lang.Exception'}],
    });
    const client = new UsbSerialTransportClient();
    let caught: unknown;
    try {
      await client.closeSession('session-123');
    } catch (error) {
      caught = error;
    }
    expect(caught).toEqual({code: 'CLOSE_FAILED', nativeMessage: 'failed'});
    expect(Object.keys(caught as object).sort()).toEqual(['code', 'nativeMessage']);
  });
});

describe('UsbSerialTransportClient thrown non-Error normalization', () => {
  it('normalizes a thrown plain string without crashing', async () => {
    mockedNative.listDevices.mockRejectedValueOnce('native crash string');
    const client = new UsbSerialTransportClient();
    await expect(client.listDevices()).rejects.toEqual({
      code: 'UNKNOWN_ERROR',
      nativeMessage: 'native crash string',
    });
  });
});

describe('UsbSerialTransportClient.startReading', () => {
  it('resolves on success', async () => {
    mockedNative.startReading.mockResolvedValueOnce(undefined);
    const client = new UsbSerialTransportClient();
    await expect(client.startReading('session-123')).resolves.toBeUndefined();
    expect(mockedNative.startReading).toHaveBeenCalledWith('session-123');
  });

  it('normalizes a rejected native call', async () => {
    mockedNative.startReading.mockRejectedValueOnce({
      code: 'RX_ALREADY_ACTIVE',
      message: 'already reading',
    });
    const client = new UsbSerialTransportClient();
    await expect(client.startReading('session-123')).rejects.toEqual({
      code: 'RX_ALREADY_ACTIVE',
      nativeMessage: 'already reading',
    });
  });
});

describe('UsbSerialTransportClient.stopReading', () => {
  it('resolves on success', async () => {
    mockedNative.stopReading.mockResolvedValueOnce(undefined);
    const client = new UsbSerialTransportClient();
    await expect(client.stopReading('session-123')).resolves.toBeUndefined();
    expect(mockedNative.stopReading).toHaveBeenCalledWith('session-123');
  });

  it('normalizes a rejected native call', async () => {
    mockedNative.stopReading.mockRejectedValueOnce({code: 'UNKNOWN_ERROR', message: 'boom'});
    const client = new UsbSerialTransportClient();
    await expect(client.stopReading('session-123')).rejects.toEqual({
      code: 'UNKNOWN_ERROR',
      nativeMessage: 'boom',
    });
  });
});

describe('UsbSerialTransportClient DFU read-unprotect', () => {
  it('forwards the exact selected device and normalizes a native failure', async () => {
    mockedNative.unprotectDfuDevice.mockRejectedValueOnce({
      code: 'DFU_UNPROTECT_FAILED',
      message: 'protected',
    });
    const client = new UsbSerialTransportClient();
    await expect(client.unprotectDfuDevice(17)).rejects.toEqual({
      code: 'DFU_UNPROTECT_FAILED',
      nativeMessage: 'protected',
    });
    expect(mockedNative.unprotectDfuDevice).toHaveBeenCalledWith(17);
  });
});

describe('UsbSerialTransportClient.writeBytes', () => {
  it('resolves on success', async () => {
    mockedNative.writeBytes.mockResolvedValueOnce(undefined);
    const client = new UsbSerialTransportClient();
    await expect(client.writeBytes('session-123', 'AAECAwQ=')).resolves.toBeUndefined();
    expect(mockedNative.writeBytes).toHaveBeenCalledWith('session-123', 'AAECAwQ=');
  });

  it('normalizes a rejected native call', async () => {
    mockedNative.writeBytes.mockRejectedValueOnce({
      code: 'WRITE_QUEUE_FULL',
      message: 'queue full',
    });
    const client = new UsbSerialTransportClient();
    await expect(client.writeBytes('session-123', 'AAECAwQ=')).rejects.toEqual({
      code: 'WRITE_QUEUE_FULL',
      nativeMessage: 'queue full',
    });
  });
});

describe('UsbSerialTransportClient.onDataReceived', () => {
  it('forwards a valid event and preserves dataBase64 verbatim', () => {
    let captured: unknown;
    mockedNative.onDataReceived.mockImplementationOnce((handler: (event: unknown) => void) => {
      handler({sessionId: 'session-123', dataBase64: 'AAECAwQ='});
      return {remove: jest.fn()};
    });
    const client = new UsbSerialTransportClient();
    client.onDataReceived(event => {
      captured = event;
    });
    expect(captured).toEqual({sessionId: 'session-123', dataBase64: 'AAECAwQ='});
  });

  it('drops a malformed event instead of forwarding it', () => {
    const callback = jest.fn();
    mockedNative.onDataReceived.mockImplementationOnce((handler: (event: unknown) => void) => {
      handler({sessionId: 'session-123'}); // missing dataBase64
      handler(null);
      handler('not an object');
      return {remove: jest.fn()};
    });
    const client = new UsbSerialTransportClient();
    client.onDataReceived(callback);
    expect(callback).not.toHaveBeenCalled();
  });

  it('returns an unsubscribe function that calls remove()', () => {
    const remove = jest.fn();
    mockedNative.onDataReceived.mockReturnValueOnce({remove});
    const client = new UsbSerialTransportClient();
    const unsubscribe = client.onDataReceived(() => {});
    expect(remove).not.toHaveBeenCalled();
    unsubscribe();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe('UsbSerialTransportClient.onError', () => {
  it('forwards a valid error event, including the optional sessionId', () => {
    let captured: unknown;
    mockedNative.onError.mockImplementationOnce((handler: (event: unknown) => void) => {
      handler({
        sessionId: 'session-123',
        code: 'READ_FAILED',
        message: 'native read failed',
        recoverable: false,
      });
      return {remove: jest.fn()};
    });
    const client = new UsbSerialTransportClient();
    client.onError(event => {
      captured = event;
    });
    expect(captured).toEqual({
      sessionId: 'session-123',
      code: 'READ_FAILED',
      message: 'native read failed',
      recoverable: false,
    });
  });

  it('forwards a valid error event with no sessionId/deviceId (both optional)', () => {
    let captured: unknown;
    mockedNative.onError.mockImplementationOnce((handler: (event: unknown) => void) => {
      handler({code: 'DEVICE_ENUMERATION_FAILED', message: 'boom', recoverable: false});
      return {remove: jest.fn()};
    });
    const client = new UsbSerialTransportClient();
    client.onError(event => {
      captured = event;
    });
    expect(captured).toEqual({code: 'DEVICE_ENUMERATION_FAILED', message: 'boom', recoverable: false});
  });

  it('drops a malformed event instead of forwarding it', () => {
    const callback = jest.fn();
    mockedNative.onError.mockImplementationOnce((handler: (event: unknown) => void) => {
      handler({code: 'READ_FAILED', message: 'boom'}); // missing recoverable
      handler(null);
      return {remove: jest.fn()};
    });
    const client = new UsbSerialTransportClient();
    client.onError(callback);
    expect(callback).not.toHaveBeenCalled();
  });

  it('returns an unsubscribe function that calls remove()', () => {
    const remove = jest.fn();
    mockedNative.onError.mockReturnValueOnce({remove});
    const client = new UsbSerialTransportClient();
    const unsubscribe = client.onError(() => {});
    expect(remove).not.toHaveBeenCalled();
    unsubscribe();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
