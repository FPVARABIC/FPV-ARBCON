const mockMain = jest.fn(async () => 'ESP32-S3');
const mockWriteFlash = jest.fn(async () => undefined);
const mockAfter = jest.fn(async () => undefined);

jest.mock('esptool-js', () => ({
  ESPLoader: jest.fn().mockImplementation(() => ({main: mockMain, writeFlash: mockWriteFlash, after: mockAfter})),
}));

import {md5Hex} from '../../../core/firmware-flasher';
import {EspFirmwareFlasher} from './EspFirmwareFlasher';
import type {ReactNativeSerialPort} from './ReactNativeSerialPort';

describe('EspFirmwareFlasher', () => {
  beforeEach(() => {
    mockMain.mockClear();
    mockWriteFlash.mockClear();
    mockAfter.mockClear();
  });

  it('writes a merged BIN at address zero with MD5 verification and hard reset', async () => {
    const transport = {disconnect: jest.fn(async () => undefined)} as unknown as ReactNativeSerialPort;
    const progress = jest.fn();
    const firmware = Uint8Array.of(1, 2, 3);
    await expect(new EspFirmwareFlasher(transport, undefined, progress).flash(firmware)).resolves.toBe('ESP32-S3');
    const options = (mockWriteFlash.mock.calls as unknown[][])[0][0] as {
      fileArray: unknown;
      compress: boolean;
      calculateMD5Hash: (data: Uint8Array) => string;
    };
    expect(options.fileArray).toEqual([{data: firmware, address: 0}]);
    expect(options.compress).toBe(true);
    expect(options.calculateMD5Hash(firmware)).toBe(md5Hex(firmware));
    expect(mockAfter).toHaveBeenCalledWith('hard_reset');
    expect(transport.disconnect).toHaveBeenCalledTimes(1);
  });
});
