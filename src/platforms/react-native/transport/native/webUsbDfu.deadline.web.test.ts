/** @jest-environment jsdom */

import {
  WEBUSB_CONTROL_TRANSFER_TIMEOUT_MS,
  WEBUSB_MANIFEST_TRANSFER_TIMEOUT_MS,
  __resetWebUsbDfuForTests,
  flashDfuFirmware,
  listDfuDevices,
} from './webUsbDfu.web';

const DFU_DNLOAD = 1;
const DFU_UPLOAD = 2;
const DFU_GETSTATUS = 3;
const DFU_ABORT = 6;
const DFU_CLRSTATUS = 4;
const IDLE = 2;
const DNLOAD_IDLE = 5;
const UPLOAD_IDLE = 9;
const LAYOUT = '@Internal Flash /0x08000000/01*016Kg';

function pending<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function intelHex(bytes: readonly number[]): Uint8Array {
  const checksum = (values: readonly number[]) =>
    ((~values.reduce((sum, value) => sum + value, 0) + 1) & 0xff)
      .toString(16).toUpperCase().padStart(2, '0');
  const ext = [2, 0, 0, 4, 0x08, 0x00];
  const data = [bytes.length, 0, 0, 0, ...bytes];
  const text = [
    `:${ext.map(v => v.toString(16).toUpperCase().padStart(2, '0')).join('')}${checksum(ext)}`,
    `:${data.map(v => v.toString(16).toUpperCase().padStart(2, '0')).join('')}${checksum(data)}`,
    ':00000001FF',
  ].join('\n');
  return Uint8Array.from(text, value => value.charCodeAt(0));
}

class DeadlineDevice {
  readonly vendorId = 0x0483;
  readonly productId = 0xdf11;
  readonly productName = 'STM32 BOOTLOADER';
  readonly manufacturerName = 'STMicroelectronics';
  opened = false;
  configuration: unknown = null;
  state = IDLE;
  address = 0x08000000;
  flash = new Map<number, number>();
  eraseCount = 0;
  dataWriteCount = 0;
  uploadCount = 0;
  hangUpload = false;
  hangManifest = false;
  disappearOnManifest = false;
  usb!: {getDevices: jest.Mock};

  get configurations() {
    return [{
      configurationValue: 1,
      interfaces: [{
        interfaceNumber: 0,
        alternates: [{
          alternateSetting: 0,
          interfaceClass: 0xfe,
          interfaceSubclass: 0x01,
          interfaceProtocol: 2,
          interfaceName: LAYOUT,
        }],
      }],
    }];
  }

  async open() { this.opened = true; }
  async close() { this.opened = false; }
  async selectConfiguration(value: number) { this.configuration = this.configurations[value - 1]; }
  async claimInterface() {}
  async releaseInterface() {}
  async selectAlternateInterface() {}

  controlTransferOut(
    setup: {request: number; value: number},
    source?: BufferSource,
  ): Promise<{status: string; bytesWritten: number}> {
    const bytes = source ? new Uint8Array(source as ArrayBufferLike) : new Uint8Array(0);
    if (setup.request === DFU_ABORT || setup.request === DFU_CLRSTATUS) {
      this.state = IDLE;
      return Promise.resolve({status: 'ok', bytesWritten: 0});
    }
    if (setup.request !== DFU_DNLOAD) {
      return Promise.resolve({status: 'stall', bytesWritten: 0});
    }
    if (setup.value === 0 && bytes.length === 0) {
      if (this.disappearOnManifest) {
        this.opened = false;
        this.usb.getDevices.mockResolvedValue([]);
      }
      if (this.hangManifest) return pending();
      this.state = IDLE;
      return Promise.resolve({status: 'ok', bytesWritten: 0});
    }
    if (setup.value === 0) {
      if (bytes[0] === 0x21) {
        this.address = bytes[1] | (bytes[2] << 8) | (bytes[3] << 16) | (bytes[4] << 24);
        this.state = DNLOAD_IDLE;
      } else if (bytes[0] === 0x41) {
        this.eraseCount += 1;
        this.state = DNLOAD_IDLE;
      }
      return Promise.resolve({status: 'ok', bytesWritten: bytes.length});
    }
    this.dataWriteCount += 1;
    const offset = (setup.value - 2) * 2048;
    bytes.forEach((value, index) => this.flash.set(this.address + offset + index, value));
    this.state = DNLOAD_IDLE;
    return Promise.resolve({status: 'ok', bytesWritten: bytes.length});
  }

  controlTransferIn(
    setup: {request: number; value: number},
    length: number,
  ): Promise<{status: string; data?: DataView}> {
    if (setup.request === DFU_GETSTATUS) {
      const bytes = Uint8Array.from([0, 0, 0, 0, this.state, 0]);
      return Promise.resolve({status: 'ok', data: new DataView(bytes.buffer)});
    }
    if (setup.request === DFU_UPLOAD) {
      this.uploadCount += 1;
      if (this.hangUpload) return pending();
      const offset = (setup.value - 2) * 2048;
      const out = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        out[index] = this.flash.get(this.address + offset + index) ?? 0xff;
      }
      this.state = UPLOAD_IDLE;
      return Promise.resolve({status: 'ok', data: new DataView(out.buffer)});
    }
    return Promise.resolve({status: 'stall'});
  }
}

function install(device: DeadlineDevice): void {
  const usb = {
    getDevices: jest.fn(async () => [device]),
    requestDevice: jest.fn(async () => device),
  };
  device.usb = usb;
  Object.defineProperty(navigator, 'usb', {value: usb, configurable: true});
  Object.defineProperty(window, 'isSecureContext', {value: true, configurable: true});
}

async function registered(device: DeadlineDevice): Promise<number> {
  install(device);
  const [descriptor] = await listDfuDevices();
  return descriptor.deviceId;
}

beforeEach(() => {
  jest.useFakeTimers();
  __resetWebUsbDfuForTests();
});

afterEach(() => {
  __resetWebUsbDfuForTests();
  Reflect.deleteProperty(navigator as object, 'usb');
  jest.useRealTimers();
});

describe('WebUSB DFU terminal deadlines', () => {
  it('turns a permanently pending VERIFY upload into DFU_TRANSFER_TIMEOUT without retrying erase/write', async () => {
    const device = new DeadlineDevice();
    device.hangUpload = true;
    const id = await registered(device);
    const attempt = flashDfuFirmware(id, intelHex([1, 2, 3, 4]), false, () => undefined);
    const rejection = expect(attempt).rejects.toMatchObject({code: 'DFU_TRANSFER_TIMEOUT'});

    await jest.advanceTimersByTimeAsync(WEBUSB_CONTROL_TRANSFER_TIMEOUT_MS + 100);
    await rejection;

    expect(device.eraseCount).toBe(1);
    expect(device.dataWriteCount).toBe(1);
    expect(device.uploadCount).toBe(1);
  });

  it('settles an unresolved manifestation as UNCONFIRMED when the DFU device is still present', async () => {
    const device = new DeadlineDevice();
    device.hangManifest = true;
    const id = await registered(device);
    const attempt = flashDfuFirmware(id, intelHex([5, 6, 7, 8]), false, () => undefined);
    const rejection = expect(attempt).rejects.toMatchObject({code: 'DFU_COMPLETION_UNCONFIRMED'});

    await jest.advanceTimersByTimeAsync(WEBUSB_MANIFEST_TRANSFER_TIMEOUT_MS + 100);
    await rejection;

    expect(device.eraseCount).toBe(1);
    expect(device.dataWriteCount).toBe(1);
    expect(device.uploadCount).toBe(1);
  });

  it('accepts disappearance during manifestation only after read-back verification completed', async () => {
    const device = new DeadlineDevice();
    device.hangManifest = true;
    device.disappearOnManifest = true;
    const id = await registered(device);
    const updates: Array<{phase: string; percent: number}> = [];
    const attempt = flashDfuFirmware(
      id,
      intelHex([9, 10, 11, 12]),
      false,
      update => updates.push({phase: update.phase, percent: update.percent}),
    );

    await jest.advanceTimersByTimeAsync(WEBUSB_MANIFEST_TRANSFER_TIMEOUT_MS + 100);
    await expect(attempt).resolves.toBeUndefined();

    expect(device.uploadCount).toBe(1);
    expect(updates[updates.length - 1]).toEqual({phase: 'complete', percent: 100});
  });
});