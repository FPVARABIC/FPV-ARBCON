jest.mock('./native/NativeUsbSerialTransport');

import NativeUsbSerialTransport from './native/NativeUsbSerialTransport';
import {
  DFU_WEBUSB_SILENCE_TIMEOUT_MS,
  DfuCompletionUnconfirmedError,
  UsbSerialTransportClient,
} from './UsbSerialTransportClient';
import type {DfuFlashProgressEvent} from './native/NativeUsbSerialTransport';

const mockedNative = NativeUsbSerialTransport as unknown as {
  requestDfuDevice?: jest.Mock;
  flashDfuFirmware: jest.Mock;
  cancelDfuFlash: jest.Mock;
  listDfuDevices: jest.Mock;
  onDfuFlashProgress: jest.Mock;
};

function enableWebUsbMode(): void {
  mockedNative.requestDfuDevice = jest.fn();
}

function disableWebUsbMode(): void {
  delete mockedNative.requestDfuDevice;
}

function progress(percent: number): DfuFlashProgressEvent {
  return {
    phase: percent >= 99 ? 'manifesting' : 'verifying',
    percent,
    bytesProcessed: percent,
    totalBytes: 100,
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  enableWebUsbMode();
  mockedNative.cancelDfuFlash.mockResolvedValue(undefined);
  mockedNative.listDfuDevices.mockResolvedValue([]);
});

afterEach(() => {
  disableWebUsbMode();
  jest.useRealTimers();
});

describe('WebUSB DFU terminal watchdog', () => {
  it('turns a permanently pending native transfer into an explicit unconfirmed result', async () => {
    mockedNative.flashDfuFirmware.mockReturnValue(new Promise<void>(() => undefined));
    mockedNative.onDfuFlashProgress.mockReturnValue({remove: jest.fn()});
    const client = new UsbSerialTransportClient();

    const attempt = client.flashDfuFirmware(1000001, 'HEX', false);
    const rejection = expect(attempt).rejects.toBeInstanceOf(DfuCompletionUnconfirmedError);

    await jest.advanceTimersByTimeAsync(DFU_WEBUSB_SILENCE_TIMEOUT_MS + 1_000);
    await rejection;

    expect(mockedNative.flashDfuFirmware).toHaveBeenCalledTimes(1);
    expect(mockedNative.cancelDfuFlash).toHaveBeenCalledTimes(1);
  });

  it('uses progress silence rather than total flash duration', async () => {
    let progressListener: ((event: DfuFlashProgressEvent) => void) | undefined;
    mockedNative.onDfuFlashProgress.mockImplementation((listener: (event: DfuFlashProgressEvent) => void) => {
      progressListener = listener;
      return {remove: jest.fn()};
    });

    let resolveNative: (() => void) | undefined;
    mockedNative.flashDfuFirmware.mockReturnValue(new Promise<void>(resolve => {
      resolveNative = resolve;
    }));
    const client = new UsbSerialTransportClient();
    const attempt = client.flashDfuFirmware(1000002, 'HEX', false);

    for (let cycle = 0; cycle < 4; cycle += 1) {
      await jest.advanceTimersByTimeAsync(DFU_WEBUSB_SILENCE_TIMEOUT_MS - 5_000);
      progressListener?.(progress(75 + cycle * 5));
    }

    resolveNative?.();
    await expect(attempt).resolves.toBeUndefined();
    expect(mockedNative.cancelDfuFlash).not.toHaveBeenCalled();
    expect(mockedNative.flashDfuFirmware).toHaveBeenCalledTimes(1);
  });

  it('poisons a timed-out device so no destructive retry can start on the same unresolved session', async () => {
    mockedNative.flashDfuFirmware.mockReturnValue(new Promise<void>(() => undefined));
    mockedNative.onDfuFlashProgress.mockReturnValue({remove: jest.fn()});
    const client = new UsbSerialTransportClient();

    const first = client.flashDfuFirmware(1000003, 'HEX', true);
    const firstRejection = expect(first).rejects.toBeInstanceOf(DfuCompletionUnconfirmedError);
    await jest.advanceTimersByTimeAsync(DFU_WEBUSB_SILENCE_TIMEOUT_MS + 1_000);
    await firstRejection;

    await expect(client.flashDfuFirmware(1000003, 'HEX', true))
      .rejects.toBeInstanceOf(DfuCompletionUnconfirmedError);

    expect(mockedNative.flashDfuFirmware).toHaveBeenCalledTimes(1);
  });

  it('also poisons the device when the lower WebUSB layer reports an early transfer timeout', async () => {
    mockedNative.flashDfuFirmware.mockRejectedValueOnce(
      Object.assign(new Error('pending WebUSB transfer exceeded its deadline'), {
        code: 'DFU_TRANSFER_TIMEOUT',
      }),
    );
    mockedNative.onDfuFlashProgress.mockReturnValue({remove: jest.fn()});
    const client = new UsbSerialTransportClient();

    await expect(client.flashDfuFirmware(1000005, 'HEX', false))
      .rejects.toBeInstanceOf(DfuCompletionUnconfirmedError);
    await expect(client.flashDfuFirmware(1000005, 'HEX', false))
      .rejects.toBeInstanceOf(DfuCompletionUnconfirmedError);

    expect(mockedNative.flashDfuFirmware).toHaveBeenCalledTimes(1);
    expect(mockedNative.cancelDfuFlash).toHaveBeenCalledTimes(1);

    mockedNative.listDfuDevices.mockResolvedValueOnce([]);
    await expect(client.listDfuDevices()).resolves.toEqual([]);
    mockedNative.flashDfuFirmware.mockResolvedValueOnce(undefined);
    await expect(client.flashDfuFirmware(1000005, 'HEX', false)).resolves.toBeUndefined();
    expect(mockedNative.flashDfuFirmware).toHaveBeenCalledTimes(2);
  });

  it('clears the poison only after the timed-out device id disappears from DFU enumeration', async () => {
    mockedNative.flashDfuFirmware.mockReturnValueOnce(new Promise<void>(() => undefined));
    mockedNative.onDfuFlashProgress.mockReturnValue({remove: jest.fn()});
    const client = new UsbSerialTransportClient();

    const first = client.flashDfuFirmware(1000004, 'HEX', false);
    const firstRejection = expect(first).rejects.toBeInstanceOf(DfuCompletionUnconfirmedError);
    await jest.advanceTimersByTimeAsync(DFU_WEBUSB_SILENCE_TIMEOUT_MS + 1_000);
    await firstRejection;

    mockedNative.listDfuDevices.mockResolvedValueOnce([]);
    await expect(client.listDfuDevices()).resolves.toEqual([]);

    mockedNative.flashDfuFirmware.mockResolvedValueOnce(undefined);
    await expect(client.flashDfuFirmware(1000004, 'HEX', false)).resolves.toBeUndefined();
    expect(mockedNative.flashDfuFirmware).toHaveBeenCalledTimes(2);
  });

  it('does not add the browser watchdog to the Android/native path', async () => {
    disableWebUsbMode();
    mockedNative.flashDfuFirmware.mockResolvedValueOnce(undefined);
    const client = new UsbSerialTransportClient();

    await expect(client.flashDfuFirmware(77, 'HEX', false)).resolves.toBeUndefined();
    expect(mockedNative.onDfuFlashProgress).not.toHaveBeenCalled();
    expect(mockedNative.cancelDfuFlash).not.toHaveBeenCalled();
  });
});