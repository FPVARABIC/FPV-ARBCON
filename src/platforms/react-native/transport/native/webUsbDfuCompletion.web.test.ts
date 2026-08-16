/**
 * @jest-environment jsdom
 *
 * THE 98% STALL, SETTLED - completion regression suite.
 *
 * The deterministic reproduction (.dev-preview/audit/flasher-p0, run at
 * eb54b3e before the fix) proved that a single WebUSB control transfer
 * that never settles left flashDfuFirmware() pending FOREVER with zero
 * timers remaining, at exactly the percentages the operator reported.
 * This suite pins the corrected contract on the same fake device, hang
 * scenario by hang scenario:
 *
 *   - every attempt SETTLES within its stage's observation window;
 *   - a deadline is never converted into success: the one overrun that
 *     completes carries full evidence (verified + manifestation issued +
 *     device physically gone - Android/Betaflight parity);
 *   - nothing destructive is ever re-sent: no second erase, no second
 *     write block, no second manifestation;
 *   - the wedged session is POISONED: no new flash may run against the
 *     same USBDevice object until it is replugged (re-enumerated);
 *   - the late settlement of a frozen transfer is inert.
 */

import {
  DFU_TRANSFER_DEADLINE_MS,
  __resetWebUsbDfuForTests,
  flashDfuFirmware,
  listDfuDevices,
  cancelDfuFlash,
} from './webUsbDfu.web';
import {
  DFU_CODE_SESSION_POISONED,
  DFU_CODE_UNCONFIRMED_MANIFEST,
  DFU_CODE_UNCONFIRMED_VERIFY,
  DFU_CODE_UNRESPONSIVE_WRITE,
} from '../../../../core/firmware-flasher/flashCompletionModel';
import type {DfuFlashProgressEvent} from './usbSerialTransportTypes';

/* eslint-disable no-bitwise -- the fake device decodes little-endian
   DfuSe addresses and builds GETSTATUS words, like the protocol does. */

const DFU_DNLOAD = 1;
const DFU_UPLOAD = 2;
const DFU_GETSTATUS = 3;
const DFU_CLRSTATUS = 4;
const DFU_ABORT = 6;

const STATE_IDLE = 2;
const STATE_DNLOAD_IDLE = 5;

const F405_LAYOUT = '@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg';

type UsbOp = {
  readonly kind: 'DNLOAD' | 'UPLOAD' | 'GETSTATUS' | 'CLRSTATUS' | 'ABORT' | 'OTHER';
  readonly blockNumber?: number;
  readonly length?: number;
  readonly firstByte?: number;
};

/** The webUsbDfu.web.test.ts protocol fake, extended with HANG injection:
 * when `hangWhen` matches, the transfer's promise never settles on its
 * own - the settlement controls are captured so the late-settlement
 * guard can be exercised deliberately. */
class HangableDfuDevice {
  readonly vendorId = 0x0483;
  readonly productId = 0xdf11;
  readonly productName = 'STM32 BOOTLOADER';
  readonly manufacturerName = 'STMicroelectronics';
  opened = false;
  configuration: unknown = null;

  readonly flash = new Map<number, number>();
  readonly ops: UsbOp[] = [];
  hangWhen: (op: UsbOp) => boolean = () => false;
  onHang: (op: UsbOp) => void = () => undefined;
  gone = false;
  resetOnManifest = false;
  /** Corrupt one byte on read-back, simulating a bad write. */
  corruptReadBackAt: number | null = null;
  readonly pendingSettlers: Array<{
    op: UsbOp;
    resolve: (value: never) => void;
    reject: (reason: unknown) => void;
  }> = [];

  private state = STATE_IDLE;
  private address = 0x08000000;

  constructor(readonly interfaceName: string = F405_LAYOUT) {}

  get configurations() {
    return [
      {
        configurationValue: 1,
        interfaces: [
          {
            interfaceNumber: 0,
            alternates: [
              {
                alternateSetting: 0,
                interfaceClass: 0xfe,
                interfaceSubclass: 0x01,
                interfaceProtocol: 0x02,
                interfaceName: this.interfaceName,
              },
            ],
          },
        ],
      },
    ];
  }

  async open() {
    this.opened = true;
  }
  async close() {
    this.opened = false;
  }
  async selectConfiguration(value: number) {
    this.configuration = this.configurations[value - 1];
  }
  async claimInterface() {}
  async selectAlternateInterface() {}
  async releaseInterface() {}

  private hangForever(op: UsbOp): Promise<never> {
    this.onHang(op);
    return new Promise<never>((resolve, reject) => {
      this.pendingSettlers.push({op, resolve, reject});
    });
  }

  controlTransferOut(
    setup: {request: number; value: number},
    data?: BufferSource,
  ): Promise<{status: string; bytesWritten: number}> {
    const bytes = data ? new Uint8Array(data as ArrayBufferLike) : new Uint8Array(0);
    const op: UsbOp = {
      kind:
        setup.request === DFU_DNLOAD
          ? 'DNLOAD'
          : setup.request === DFU_CLRSTATUS
            ? 'CLRSTATUS'
            : setup.request === DFU_ABORT
              ? 'ABORT'
              : 'OTHER',
      blockNumber: setup.value,
      length: bytes.length,
      firstByte: bytes.length > 0 ? bytes[0] : undefined,
    };
    this.ops.push(op);
    if (this.hangWhen(op)) {
      return this.hangForever(op);
    }
    if (this.gone) {
      return Promise.reject(new DOMException('device disconnected', 'NetworkError'));
    }
    if (setup.request === DFU_CLRSTATUS || setup.request === DFU_ABORT) {
      this.state = STATE_IDLE;
      return Promise.resolve({status: 'ok', bytesWritten: 0});
    }
    if (setup.request !== DFU_DNLOAD) {
      return Promise.resolve({status: 'stall', bytesWritten: 0});
    }
    if (setup.value === 0) {
      if (bytes.length === 0) {
        if (this.resetOnManifest) {
          this.gone = true;
          this.opened = false;
          return Promise.reject(new DOMException('device disconnected', 'NetworkError'));
        }
        this.state = STATE_IDLE;
        return Promise.resolve({status: 'ok', bytesWritten: 0});
      }
      const command = bytes[0];
      if (command === 0x21 && bytes.length === 5) {
        this.address =
          (bytes[1] | (bytes[2] << 8) | (bytes[3] << 16) | (bytes[4] << 24)) >>> 0;
        this.state = STATE_DNLOAD_IDLE;
        return Promise.resolve({status: 'ok', bytesWritten: bytes.length});
      }
      if (command === 0x41 && bytes.length === 5) {
        this.state = STATE_DNLOAD_IDLE;
        return Promise.resolve({status: 'ok', bytesWritten: bytes.length});
      }
      return Promise.resolve({status: 'stall', bytesWritten: 0});
    }
    const offset = (setup.value - 2) * 2048;
    for (let index = 0; index < bytes.length; index += 1) {
      this.flash.set(this.address + offset + index, bytes[index]);
    }
    this.state = STATE_DNLOAD_IDLE;
    return Promise.resolve({status: 'ok', bytesWritten: bytes.length});
  }

  controlTransferIn(
    setup: {request: number; value: number},
    length: number,
  ): Promise<{status: string; data?: DataView}> {
    const op: UsbOp = {
      kind:
        setup.request === DFU_GETSTATUS
          ? 'GETSTATUS'
          : setup.request === DFU_UPLOAD
            ? 'UPLOAD'
            : 'OTHER',
      blockNumber: setup.value,
      length,
    };
    this.ops.push(op);
    if (this.hangWhen(op)) {
      return this.hangForever(op);
    }
    if (this.gone) {
      return Promise.reject(new DOMException('device disconnected', 'NetworkError'));
    }
    if (setup.request === DFU_GETSTATUS) {
      const status = new Uint8Array(6);
      status[0] = 0;
      status[4] = this.state;
      return Promise.resolve({status: 'ok', data: new DataView(status.buffer)});
    }
    if (setup.request === DFU_UPLOAD) {
      const offset = (setup.value - 2) * 2048;
      const out = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        const address = this.address + offset + index;
        out[index] = this.flash.get(address) ?? 0xff;
        if (this.corruptReadBackAt === address) {
          out[index] = (out[index] ^ 0xff) & 0xff;
        }
      }
      return Promise.resolve({status: 'ok', data: new DataView(out.buffer)});
    }
    return Promise.resolve({status: 'stall'});
  }
}

type FakeUsb = {getDevices: jest.Mock; requestDevice: jest.Mock};

function installUsb(devices: HangableDfuDevice[]): FakeUsb {
  const usb: FakeUsb = {
    getDevices: jest.fn(async () => devices),
    requestDevice: jest.fn(async () => devices[0]),
  };
  Object.defineProperty(navigator, 'usb', {value: usb, configurable: true});
  Object.defineProperty(window, 'isSecureContext', {value: true, configurable: true});
  return usb;
}

function intelHexAt(address: number, bytes: number[]): string {
  const lines: string[] = [];
  const upper = (address >>> 16) & 0xffff;
  const checksum = (values: number[]) =>
    ((~values.reduce((sum, value) => sum + value, 0) + 1) & 0xff)
      .toString(16)
      .toUpperCase()
      .padStart(2, '0');
  const extended = [0x02, 0x00, 0x00, 0x04, (upper >> 8) & 0xff, upper & 0xff];
  lines.push(
    `:${extended.map(v => v.toString(16).toUpperCase().padStart(2, '0')).join('')}${checksum(extended)}`,
  );
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const chunk = bytes.slice(offset, offset + 16);
    const low = (address + offset) & 0xffff;
    const record = [chunk.length, (low >> 8) & 0xff, low & 0xff, 0x00, ...chunk];
    lines.push(
      `:${record.map(v => v.toString(16).toUpperCase().padStart(2, '0')).join('')}${checksum(record)}`,
    );
  }
  lines.push(':00000001FF');
  return lines.join('\n');
}

function encodeAscii(text: string): Uint8Array {
  return Uint8Array.from(text, character => character.charCodeAt(0));
}

/** 3000 bytes -> two 2048-byte DfuSe blocks: the LAST write block and the
 * LAST verify block are distinct, identifiable transfers. */
const PAYLOAD = Array.from({length: 3000}, (_, index) => (index * 7) & 0xff);
const HEX = encodeAscii(intelHexAt(0x08000000, PAYLOAD));

/** Runs a flash and drains fake time until it settles. Returns the
 * settlement plus the progress trail. (The device under test is already
 * installed on navigator.usb; the parameter documents which one.) */
async function driveFlash(_device: HangableDfuDevice) {
  const progress: DfuFlashProgressEvent[] = [];
  const [descriptor] = await listDfuDevices();
  let settled: {kind: 'resolved'} | {kind: 'rejected'; code?: string} | undefined;
  const promise = flashDfuFirmware(descriptor.deviceId, HEX, false, event =>
    progress.push(event),
  );
  promise.then(
    () => {
      settled = {kind: 'resolved'};
    },
    (error: unknown) => {
      settled = {kind: 'rejected', code: (error as {code?: string}).code};
    },
  );
  for (let round = 0; round < 400 && settled === undefined; round += 1) {
    if (jest.getTimerCount() === 0) {
      await Promise.resolve();
      await Promise.resolve();
      if (settled === undefined) break;
    } else {
      await jest.advanceTimersByTimeAsync(1_000);
    }
  }
  return {settled, progress, descriptor, promise};
}

const dataBlockWrites = (device: HangableDfuDevice) =>
  device.ops.filter(op => op.kind === 'DNLOAD' && (op.blockNumber ?? 0) >= 2);
const eraseCommands = (device: HangableDfuDevice) =>
  device.ops.filter(
    op => op.kind === 'DNLOAD' && op.blockNumber === 0 && op.firstByte === 0x41,
  );
const manifestations = (device: HangableDfuDevice) =>
  device.ops.filter(
    op => op.kind === 'DNLOAD' && op.blockNumber === 0 && (op.length ?? 0) === 0,
  );

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  __resetWebUsbDfuForTests();
  Reflect.deleteProperty(navigator as object, 'usb');
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('every hang scenario now ends in a terminal settlement', () => {
  it('F. a normal flash still resolves with monotonic progress ending complete/100', async () => {
    const device = new HangableDfuDevice();
    installUsb([device]);

    const {settled, progress} = await driveFlash(device);

    expect(settled).toEqual({kind: 'resolved'});
    const last = progress[progress.length - 1];
    expect(last.phase).toBe('complete');
    expect(last.percent).toBe(100);
    const percents = progress.map(event => event.percent);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
  });

  it('A. a frozen FINAL VERIFY UPLOAD settles as UNCONFIRMED - written, acknowledged, unproven', async () => {
    const device = new HangableDfuDevice();
    let uploads = 0;
    device.hangWhen = op => op.kind === 'UPLOAD' && (uploads += 1) === 2;
    installUsb([device]);

    const {settled} = await driveFlash(device);

    expect(settled).toEqual({
      kind: 'rejected',
      code: DFU_CODE_UNCONFIRMED_VERIFY,
    });
    // Nothing destructive was re-sent while frozen.
    expect(eraseCommands(device)).toHaveLength(1);
    expect(dataBlockWrites(device)).toHaveLength(2);
    expect(manifestations(device)).toHaveLength(0);
  });

  it('B/W. a frozen GETSTATUS while writing settles as FAILED - the image is incomplete', async () => {
    const device = new HangableDfuDevice();
    let sawLastDataBlock = false;
    device.hangWhen = op => {
      if (op.kind === 'DNLOAD' && op.blockNumber === 3) {
        sawLastDataBlock = true;
        return false;
      }
      return op.kind === 'GETSTATUS' && sawLastDataBlock;
    };
    installUsb([device]);

    const {settled} = await driveFlash(device);

    expect(settled).toEqual({
      kind: 'rejected',
      code: DFU_CODE_UNRESPONSIVE_WRITE,
    });
    expect(dataBlockWrites(device)).toHaveLength(2);
    expect(eraseCommands(device)).toHaveLength(1);
  });

  it('C. an instant reset on the manifestation DNLOAD is the SUCCESS it always was', async () => {
    // Pre-fix this rejected as DFU_TRANSFER_FAILED: a fully verified
    // flash whose board obeyed the leave command instantly was reported
    // as a failure. exitDfuMode, the Android worker and the pinned
    // Betaflight reference all accept this reset as completion.
    const device = new HangableDfuDevice();
    device.resetOnManifest = true;
    const usb = installUsb([device]);
    device.onHang = () => undefined;
    // After the reset the device is no longer enumerable.
    const originalManifest = device.controlTransferOut.bind(device);
    device.controlTransferOut = (setup, data) => {
      const bytes = data ? new Uint8Array(data as ArrayBufferLike) : new Uint8Array(0);
      if (setup.request === DFU_DNLOAD && setup.value === 0 && bytes.length === 0) {
        usb.getDevices.mockResolvedValue([]);
      }
      return originalManifest(setup, data);
    };

    const {settled, progress} = await driveFlash(device);

    expect(settled).toEqual({kind: 'resolved'});
    expect(progress[progress.length - 1]).toMatchObject({phase: 'complete', percent: 100});
    expect(manifestations(device)).toHaveLength(1);
  });

  it('D. a frozen manifestation GETSTATUS with the device GONE completes - full evidence', async () => {
    const device = new HangableDfuDevice();
    const usb = installUsb([device]);
    let manifested = false;
    device.hangWhen = op => {
      if (op.kind === 'DNLOAD' && op.blockNumber === 0 && (op.length ?? 0) === 0) {
        manifested = true;
        return false;
      }
      return op.kind === 'GETSTATUS' && manifested;
    };
    device.onHang = () => {
      usb.getDevices.mockResolvedValue([]);
    };

    const {settled, progress} = await driveFlash(device);

    // Not a timeout converted to success: all bytes verified, the
    // manifestation was issued, and the board physically left the bus -
    // MANIFEST-WAIT-RESET on a device that resets without answering.
    expect(settled).toEqual({kind: 'resolved'});
    expect(progress[progress.length - 1]).toMatchObject({phase: 'complete', percent: 100});
    expect(manifestations(device)).toHaveLength(1);
  });

  it('E. a PRESENT board that goes silent in manifestation is UNCONFIRMED - never success', async () => {
    const device = new HangableDfuDevice();
    installUsb([device]);
    let manifested = false;
    device.hangWhen = op => {
      if (op.kind === 'DNLOAD' && op.blockNumber === 0 && (op.length ?? 0) === 0) {
        manifested = true;
        return false;
      }
      return op.kind === 'GETSTATUS' && manifested;
    };

    const {settled} = await driveFlash(device);

    expect(settled).toEqual({
      kind: 'rejected',
      code: DFU_CODE_UNCONFIRMED_MANIFEST,
    });
    expect(manifestations(device)).toHaveLength(1);
  });

  it('an UNEXPECTED disconnect mid-write rejects as a real failure, never as completion', async () => {
    // Item 5 of the contract at the engine layer: disappearance is
    // completion evidence ONLY after the manifestation was issued.
    // Mid-write it is a plain failure - the image is incomplete.
    const device = new HangableDfuDevice();
    const usb = installUsb([device]);
    const original = device.controlTransferOut.bind(device);
    device.controlTransferOut = (setup, data) => {
      if (setup.request === DFU_DNLOAD && setup.value === 3) {
        device.gone = true;
        device.opened = false;
        usb.getDevices.mockResolvedValue([]);
      }
      return original(setup, data);
    };

    const {settled, progress} = await driveFlash(device);

    expect(settled).toEqual({kind: 'rejected', code: 'DFU_TRANSFER_FAILED'});
    expect(progress.some(event => event.phase === 'complete')).toBe(false);
    expect(manifestations(device)).toHaveLength(0);
  });

  it('settles within the stage observation window, not eventually', async () => {
    const device = new HangableDfuDevice();
    let uploads = 0;
    device.hangWhen = op => op.kind === 'UPLOAD' && (uploads += 1) === 2;
    installUsb([device]);
    const [descriptor] = await listDfuDevices();
    let settled = false;
    const promise = flashDfuFirmware(descriptor.deviceId, HEX, false, () => {});
    promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    // Give the flash time to reach the frozen upload, then cross the
    // VERIFY window plus the presence probe and one settling round.
    await jest.advanceTimersByTimeAsync(1_000);
    await jest.advanceTimersByTimeAsync(DFU_TRANSFER_DEADLINE_MS.VERIFY);
    await jest.advanceTimersByTimeAsync(DFU_RELEASE_GRACE);

    expect(settled).toBe(true);
    await expect(promise).rejects.toMatchObject({code: DFU_CODE_UNCONFIRMED_VERIFY});
  });
});

/** Presence probe + bounded release + microtask margin used above. */
const DFU_RELEASE_GRACE = 10_000;

describe('the poisoned session and the inert late settlement', () => {
  it('refuses a new flash against the same wedged USBDevice until it is replugged', async () => {
    const device = new HangableDfuDevice();
    let uploads = 0;
    device.hangWhen = op => op.kind === 'UPLOAD' && (uploads += 1) === 2;
    installUsb([device]);

    const first = await driveFlash(device);
    expect(first.settled).toEqual({
      kind: 'rejected',
      code: DFU_CODE_UNCONFIRMED_VERIFY,
    });
    const writesAfterFirst = dataBlockWrites(device).length;
    const erasesAfterFirst = eraseCommands(device).length;

    // The same USBDevice object (same session) must be refused outright -
    // no open, no erase, no write reaches it.
    await expect(
      flashDfuFirmware(first.descriptor.deviceId, HEX, false, () => {}),
    ).rejects.toMatchObject({code: DFU_CODE_SESSION_POISONED});
    expect(dataBlockWrites(device)).toHaveLength(writesAfterFirst);
    expect(eraseCommands(device)).toHaveLength(erasesAfterFirst);

    // A REPLUG enumerates a fresh USBDevice object - that new session
    // flashes normally.
    const replugged = new HangableDfuDevice();
    installUsb([replugged]);
    const second = await driveFlash(replugged);
    expect(second.settled).toEqual({kind: 'resolved'});
  });

  it('a late settlement of the frozen transfer changes nothing and throws nothing', async () => {
    const device = new HangableDfuDevice();
    let uploads = 0;
    device.hangWhen = op => op.kind === 'UPLOAD' && (uploads += 1) === 2;
    installUsb([device]);

    const {settled, progress} = await driveFlash(device);
    expect(settled).toEqual({kind: 'rejected', code: DFU_CODE_UNCONFIRMED_VERIFY});
    const progressCount = progress.length;
    const opsCount = device.ops.length;

    // The wedged UPLOAD finally "answers" - long after the attempt was
    // terminally classified. Resolve one run, reject another round.
    expect(device.pendingSettlers).toHaveLength(1);
    device.pendingSettlers[0].resolve(undefined as never);
    await jest.advanceTimersByTimeAsync(5_000);
    await Promise.resolve();

    // No new progress, no new transfers, no unhandled rejection (jest
    // fails the test on its own if one fires).
    expect(progress).toHaveLength(progressCount);
    expect(device.ops).toHaveLength(opsCount);
  });

  it('a late REJECTION of the frozen transfer is equally inert', async () => {
    const device = new HangableDfuDevice();
    let manifested = false;
    device.hangWhen = op => {
      if (op.kind === 'DNLOAD' && op.blockNumber === 0 && (op.length ?? 0) === 0) {
        manifested = true;
        return false;
      }
      return op.kind === 'GETSTATUS' && manifested;
    };
    installUsb([device]);

    const {settled, progress} = await driveFlash(device);
    expect(settled).toEqual({kind: 'rejected', code: DFU_CODE_UNCONFIRMED_MANIFEST});
    const progressCount = progress.length;

    device.pendingSettlers[0].reject(new DOMException('late disconnect', 'NetworkError'));
    await jest.advanceTimersByTimeAsync(5_000);
    await Promise.resolve();

    expect(progress).toHaveLength(progressCount);
  });

  it('cancel raised during a frozen transfer settles as the cancellation, still without retries', async () => {
    const device = new HangableDfuDevice();
    let uploads = 0;
    device.hangWhen = op => {
      if (op.kind === 'UPLOAD' && (uploads += 1) === 2) {
        // The operator presses Cancel while the transfer is wedged.
        cancelDfuFlash();
        return true;
      }
      return false;
    };
    installUsb([device]);

    const {settled} = await driveFlash(device);

    expect(settled).toEqual({kind: 'rejected', code: 'DFU_CANCELLED'});
    expect(dataBlockWrites(device)).toHaveLength(2);
    expect(eraseCommands(device)).toHaveLength(1);
    expect(manifestations(device)).toHaveLength(0);
  });

  it('a wedged release() cannot hold an otherwise-failed attempt open', async () => {
    const device = new HangableDfuDevice();
    device.corruptReadBackAt = 0x08000000;
    // releaseInterface never settles - the cleanup itself is wedged.
    device.releaseInterface = () => new Promise<never>(() => {});
    installUsb([device]);

    const {settled} = await driveFlash(device);

    expect(settled).toEqual({kind: 'rejected', code: 'DFU_VERIFY_FAILED'});
  });
});
