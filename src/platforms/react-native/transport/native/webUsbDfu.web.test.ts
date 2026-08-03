/**
 * @jest-environment jsdom
 *
 * STM32 DfuSe OVER WebUSB.
 *
 * The fake device below implements the DFU state machine for real: it
 * tracks idle/download-idle/busy states, answers GETSTATUS with the six
 * bytes the protocol defines, honours DfuSe SET_ADDRESS and ERASE, and
 * keeps a byte-addressed flash array that UPLOAD reads back from. That
 * matters because the properties worth testing are protocol properties,
 * and a mock that merely records calls would let a wrong block number, a
 * wrong erase address or a skipped read-back pass unnoticed.
 *
 * What is asserted, in order of how much damage the absence would do:
 *
 *   1. A firmware whose addresses fall outside the device's OWN reported
 *      memory layout is refused BEFORE anything is erased. Getting this
 *      wrong destroys the working firmware on the board.
 *   2. Every written byte is read back and compared, and a mismatch fails
 *      the flash. Without it the only evidence of success is the device's
 *      own status byte, which reports the transfer, not the flash.
 *   3. Selective erase touches only the sectors the firmware covers;
 *      full erase touches all of them.
 *   4. Nothing is fabricated - no device, no layout, no success.
 */

import {
  DfuMemoryLayout,
  __resetWebUsbDfuForTests,
  exitDfuMode,
  flashDfuFirmware,
  listDfuDevices,
  requestDfuDevice,
  unprotectDfuDevice,
} from './webUsbDfu.web';
import type {DfuFlashProgressEvent} from './usbSerialTransportTypes';

/* eslint-disable no-bitwise -- the fake device below decodes little-endian
   DfuSe addresses and builds GETSTATUS words, so it does the same byte
   arithmetic the protocol itself does. */

const DFU_DNLOAD = 1;
const DFU_UPLOAD = 2;
const DFU_GETSTATUS = 3;
const DFU_CLRSTATUS = 4;
const DFU_ABORT = 6;

const STATE_IDLE = 2;
const STATE_DNLOAD_BUSY = 4;
const STATE_DNLOAD_IDLE = 5;

/** A real STM32F405 layout string, as the bootloader reports it. */
const F405_LAYOUT = '@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg';

/* ------------------------------------------------------------------ *
 * A DfuSe device that actually implements the protocol
 * ------------------------------------------------------------------ */

class FakeDfuDevice {
  readonly vendorId = 0x0483;
  readonly productId = 0xdf11;
  readonly productName = 'STM32 BOOTLOADER';
  readonly manufacturerName = 'STMicroelectronics';
  opened = false;
  configuration: unknown = null;

  /** address -> byte. Sparse, so an unerased read is distinguishable. */
  readonly flash = new Map<number, number>();
  readonly erasedSectors: number[] = [];
  readonly writtenBlocks: Array<{block: number; length: number}> = [];
  uploadCount = 0;
  releaseCalled = false;
  closeCalled = false;

  /** Set to corrupt a byte on read-back, simulating a bad write. */
  corruptReadBackAt: number | null = null;
  /** Set to reject the read-unprotect command. */
  rejectUnprotect = false;
  /** Set to make every transfer throw, as a reset device does. */
  gone = false;

  private state = STATE_IDLE;
  private address = 0x08000000;
  private pendingBusy = false;

  /**
   * `null` models a bootloader that exposes no memory-layout string.
   * Deliberately not `undefined`: that is what the default parameter
   * substitutes for, so passing it would silently give back the normal
   * layout and the "no layout" test would assert nothing.
   */
  constructor(readonly interfaceName: string | null = F405_LAYOUT) {}

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
                interfaceName: this.interfaceName ?? undefined,
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
    this.closeCalled = true;
    this.opened = false;
  }
  async selectConfiguration(value: number) {
    this.configuration = this.configurations[value - 1];
  }
  async claimInterface() {}
  async selectAlternateInterface() {}
  async releaseInterface() {
    this.releaseCalled = true;
  }

  async controlTransferOut(
    setup: {request: number; value: number},
    data?: BufferSource,
  ): Promise<{status: string; bytesWritten: number}> {
    if (this.gone) {
      throw new DOMException('device disconnected', 'NetworkError');
    }
    const bytes = data ? new Uint8Array(data as ArrayBufferLike) : new Uint8Array(0);

    if (setup.request === DFU_CLRSTATUS) {
      this.state = STATE_IDLE;
      return {status: 'ok', bytesWritten: 0};
    }
    if (setup.request === DFU_ABORT) {
      this.state = STATE_IDLE;
      return {status: 'ok', bytesWritten: 0};
    }
    if (setup.request !== DFU_DNLOAD) {
      return {status: 'stall', bytesWritten: 0};
    }

    if (setup.value === 0) {
      // Block 0 is a DfuSe command.
      if (bytes.length === 0) {
        // Zero-length DNLOAD - manifestation.
        this.state = STATE_IDLE;
        return {status: 'ok', bytesWritten: 0};
      }
      const command = bytes[0];
      if (command === 0x21 && bytes.length === 5) {
        this.address =
          bytes[1] | (bytes[2] << 8) | (bytes[3] << 16) | (bytes[4] << 24);
        this.state = STATE_DNLOAD_IDLE;
        return {status: 'ok', bytesWritten: bytes.length};
      }
      if (command === 0x41 && bytes.length === 5) {
        const sector =
          bytes[1] | (bytes[2] << 8) | (bytes[3] << 16) | (bytes[4] << 24);
        this.erasedSectors.push(sector);
        this.state = STATE_DNLOAD_IDLE;
        return {status: 'ok', bytesWritten: bytes.length};
      }
      if (command === 0x92) {
        if (this.rejectUnprotect) {
          this.state = STATE_IDLE;
          return {status: 'ok', bytesWritten: bytes.length};
        }
        this.pendingBusy = true;
        this.state = STATE_DNLOAD_BUSY;
        return {status: 'ok', bytesWritten: bytes.length};
      }
      return {status: 'stall', bytesWritten: 0};
    }

    // Data block. DfuSe block numbering starts at 2.
    const offset = (setup.value - 2) * 2048;
    for (let index = 0; index < bytes.length; index += 1) {
      this.flash.set(this.address + offset + index, bytes[index]);
    }
    this.writtenBlocks.push({block: setup.value, length: bytes.length});
    this.state = STATE_DNLOAD_IDLE;
    return {status: 'ok', bytesWritten: bytes.length};
  }

  async controlTransferIn(
    setup: {request: number; value: number},
    length: number,
  ): Promise<{status: string; data?: DataView}> {
    if (this.gone) {
      throw new DOMException('device disconnected', 'NetworkError');
    }
    if (setup.request === DFU_GETSTATUS) {
      const status = new Uint8Array(6);
      status[0] = 0; // OK
      status[1] = 0; // poll timeout, 0 so tests do not sleep
      status[2] = 0;
      status[3] = 0;
      status[4] = this.state;
      status[5] = 0;
      if (this.pendingBusy) {
        // One busy report, then idle - the read-unprotect erase window.
        this.pendingBusy = false;
        this.state = STATE_IDLE;
      }
      return {status: 'ok', data: new DataView(status.buffer)};
    }
    if (setup.request === DFU_UPLOAD) {
      this.uploadCount += 1;
      const offset = (setup.value - 2) * 2048;
      const out = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        const address = this.address + offset + index;
        out[index] = this.flash.get(address) ?? 0xff;
        if (this.corruptReadBackAt === address) {
          out[index] = (out[index] ^ 0xff) & 0xff;
        }
      }
      return {status: 'ok', data: new DataView(out.buffer)};
    }
    return {status: 'stall'};
  }
}

type FakeUsb = {getDevices: jest.Mock; requestDevice: jest.Mock};

function installUsb(devices: FakeDfuDevice[]): FakeUsb {
  const usb: FakeUsb = {
    getDevices: jest.fn(async () => devices),
    requestDevice: jest.fn(async () => devices[0]),
  };
  Object.defineProperty(navigator, 'usb', {value: usb, configurable: true});
  Object.defineProperty(window, 'isSecureContext', {value: true, configurable: true});
  return usb;
}

/** Builds an Intel HEX file for `bytes` placed at `address`. */
function intelHexAt(address: number, bytes: number[]): string {
  const lines: string[] = [];
  const upper = (address >>> 16) & 0xffff;
  const checksum = (values: number[]) =>
    ((~values.reduce((sum, value) => sum + value, 0) + 1) & 0xff)
      .toString(16)
      .toUpperCase()
      .padStart(2, '0');

  const extended = [0x02, 0x00, 0x00, 0x04, (upper >> 8) & 0xff, upper & 0xff];
  lines.push(`:${extended.map(v => v.toString(16).toUpperCase().padStart(2, '0')).join('')}${checksum(extended)}`);

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

/** Intel HEX is ASCII, and jsdom provides no TextEncoder. */
function encodeAscii(text: string): Uint8Array {
  return Uint8Array.from(text, character => character.charCodeAt(0));
}

function hexBytes(address: number, bytes: number[]): Uint8Array {
  return encodeAscii(intelHexAt(address, bytes));
}

const noProgress = () => {};

afterEach(() => {
  __resetWebUsbDfuForTests();
  Reflect.deleteProperty(navigator as object, 'usb');
  jest.restoreAllMocks();
});

/* ------------------------------------------------------------------ *
 * Memory layout parsing
 * ------------------------------------------------------------------ */

describe('DfuMemoryLayout.parse', () => {
  it('expands an STM32F405 descriptor into real sectors', () => {
    const layout = DfuMemoryLayout.parse(F405_LAYOUT);

    expect(layout.name).toBe('Internal Flash');
    // 4 x 16K + 1 x 64K + 7 x 128K = 12 sectors, 1MB total.
    expect(layout.sectors).toHaveLength(12);
    expect(layout.sectors[0]).toEqual({address: 0x08000000, sizeBytes: 16 * 1024});
    expect(layout.sectors[4]).toEqual({address: 0x08010000, sizeBytes: 64 * 1024});
    expect(layout.sectors[5]).toEqual({address: 0x08020000, sizeBytes: 128 * 1024});
    const last = layout.sectors[11];
    expect(last.address + last.sizeBytes).toBe(0x08100000);
  });

  it('knows which addresses it covers, across a sector boundary', () => {
    const layout = DfuMemoryLayout.parse(F405_LAYOUT);

    expect(layout.contains(0x08000000, 1024)).toBe(true);
    // Spanning sector 0 into sector 1 is still fully covered.
    expect(layout.contains(0x08003000, 32 * 1024)).toBe(true);
    // One byte past the end of flash is not.
    expect(layout.contains(0x080ffff0, 32)).toBe(false);
    expect(layout.contains(0x20000000, 4)).toBe(false);
    expect(layout.contains(0x08000000, 0)).toBe(false);
  });

  it('reports the sectors a write overlaps, and no others', () => {
    const layout = DfuMemoryLayout.parse(F405_LAYOUT);

    const overlapping = layout.sectorsOverlapping(0x08000000, 20 * 1024);
    expect(overlapping.map(sector => sector.address)).toEqual([0x08000000, 0x08004000]);
  });

  it('strips non-printable padding some bootloaders append', () => {
    const layout = DfuMemoryLayout.parse(`${F405_LAYOUT}  `);

    expect(layout.sectors).toHaveLength(12);
  });

  it.each([
    ['no leading @', 'Internal Flash/0x08000000/04*016Kg'],
    ['an unparsable sector token', '@Internal Flash /0x08000000/four*016Kg'],
    ['no sectors at all', '@Internal Flash'],
  ])('rejects a descriptor with %s', (_label, descriptor) => {
    // A guessed layout is worse than none: it would authorize erases at
    // addresses the device never reported.
    expect(() => DfuMemoryLayout.parse(descriptor)).toThrow(
      expect.objectContaining({code: 'DFU_LAYOUT_INVALID'}),
    );
  });
});

/* ------------------------------------------------------------------ *
 * Discovery
 * ------------------------------------------------------------------ */

describe('listDfuDevices', () => {
  it('uses getDevices() only and never opens a chooser', async () => {
    const usb = installUsb([new FakeDfuDevice()]);

    await listDfuDevices();

    expect(usb.getDevices).toHaveBeenCalledTimes(1);
    expect(usb.requestDevice).not.toHaveBeenCalled();
  });

  it('reports the DFU interface and the layout the device itself declared', async () => {
    installUsb([new FakeDfuDevice()]);

    const [device] = await listDfuDevices();

    expect(device.vendorId).toBe(0x0483);
    expect(device.productId).toBe(0xdf11);
    expect(device.interfaceNumber).toBe(0);
    expect(device.alternateSetting).toBe(0);
    expect(device.memoryLayout).toBe(F405_LAYOUT);
    // WebUSB does expose these, unlike Web Serial, so they are reported.
    expect(device.productName).toBe('STM32 BOOTLOADER');
  });

  it('ignores a device that is not a supported bootloader identity', async () => {
    const foreign = new FakeDfuDevice();
    Object.defineProperty(foreign, 'vendorId', {value: 0x1234});
    installUsb([foreign]);

    await expect(listDfuDevices()).resolves.toEqual([]);
  });

  it('rejects with WEB_USB_UNSUPPORTED rather than an empty list', async () => {
    Reflect.deleteProperty(navigator as object, 'usb');
    Object.defineProperty(window, 'isSecureContext', {value: true, configurable: true});

    await expect(listDfuDevices()).rejects.toMatchObject({
      code: 'WEB_USB_UNSUPPORTED',
    });
  });

  it('returns null - not an error - when the chooser is dismissed', async () => {
    const usb = installUsb([new FakeDfuDevice()]);
    usb.requestDevice.mockRejectedValueOnce(
      new DOMException('No device selected', 'NotFoundError'),
    );

    await expect(requestDfuDevice()).resolves.toBeNull();
  });

  it('filters the chooser to supported bootloader identities', async () => {
    // An unfiltered chooser would offer any USB device on the machine as
    // something to flash.
    const usb = installUsb([new FakeDfuDevice()]);

    await requestDfuDevice();

    const filters = usb.requestDevice.mock.calls[0][0].filters;
    expect(filters).toContainEqual({vendorId: 0x0483, productId: 0xdf11});
    expect(filters.length).toBeGreaterThan(1);
  });
});

/* ------------------------------------------------------------------ *
 * Flashing
 * ------------------------------------------------------------------ */

describe('flashDfuFirmware', () => {
  const PAYLOAD = Array.from({length: 300}, (_, index) => (index * 7) & 0xff);

  it('erases, writes and READS BACK the exact bytes', async () => {
    const device = new FakeDfuDevice();
    installUsb([device]);
    const [descriptor] = await listDfuDevices();

    await flashDfuFirmware(
      descriptor.deviceId,
      hexBytes(0x08000000, PAYLOAD),
      false,
      noProgress,
    );

    for (let index = 0; index < PAYLOAD.length; index += 1) {
      expect(device.flash.get(0x08000000 + index)).toBe(PAYLOAD[index]);
    }
    // The read-back pass actually ran - without it a corrupt write is
    // indistinguishable from a good one.
    expect(device.uploadCount).toBeGreaterThan(0);
  });

  it('starts data blocks at 2, as DfuSe requires', async () => {
    // Blocks 0 and 1 are reserved for commands; writing payload to block 0
    // would be interpreted as a DfuSe command instead of data.
    const device = new FakeDfuDevice();
    installUsb([device]);
    const [descriptor] = await listDfuDevices();

    await flashDfuFirmware(descriptor.deviceId, hexBytes(0x08000000, PAYLOAD), false, noProgress);

    expect(device.writtenBlocks[0].block).toBe(2);
  });

  it('REFUSES firmware outside the declared layout, before erasing anything', async () => {
    // The single most destructive failure mode: erasing a working board's
    // flash on behalf of an image built for a different target.
    const device = new FakeDfuDevice();
    installUsb([device]);
    const [descriptor] = await listDfuDevices();

    await expect(
      flashDfuFirmware(descriptor.deviceId, hexBytes(0x20000000, PAYLOAD), false, noProgress),
    ).rejects.toMatchObject({code: 'DFU_ADDRESS_OUT_OF_RANGE'});
    expect(device.erasedSectors).toEqual([]);
    expect(device.writtenBlocks).toEqual([]);
  });

  it('fails the flash when read-back does not match what was written', async () => {
    const device = new FakeDfuDevice();
    device.corruptReadBackAt = 0x08000010;
    installUsb([device]);
    const [descriptor] = await listDfuDevices();

    await expect(
      flashDfuFirmware(descriptor.deviceId, hexBytes(0x08000000, PAYLOAD), false, noProgress),
    ).rejects.toMatchObject({code: 'DFU_VERIFY_FAILED'});
  });

  it('selective erase touches only the sectors the firmware covers', async () => {
    const device = new FakeDfuDevice();
    installUsb([device]);
    const [descriptor] = await listDfuDevices();

    await flashDfuFirmware(descriptor.deviceId, hexBytes(0x08000000, PAYLOAD), false, noProgress);

    expect(device.erasedSectors).toEqual([0x08000000]);
  });

  it('full erase covers every sector in the layout', async () => {
    const device = new FakeDfuDevice();
    installUsb([device]);
    const [descriptor] = await listDfuDevices();

    await flashDfuFirmware(descriptor.deviceId, hexBytes(0x08000000, PAYLOAD), true, noProgress);

    expect(device.erasedSectors).toHaveLength(12);
    expect(device.erasedSectors[0]).toBe(0x08000000);
  });

  it('reports monotonic progress through erase, write, verify and complete', async () => {
    const device = new FakeDfuDevice();
    installUsb([device]);
    const [descriptor] = await listDfuDevices();
    const updates: DfuFlashProgressEvent[] = [];

    await flashDfuFirmware(
      descriptor.deviceId,
      hexBytes(0x08000000, PAYLOAD),
      false,
      update => updates.push(update),
    );

    expect(updates.map(update => update.phase)).toEqual(
      expect.arrayContaining(['erasing', 'writing', 'verifying', 'complete']),
    );
    const percents = updates.map(update => update.percent);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
    expect(percents[percents.length - 1]).toBe(100);
    expect(updates[updates.length - 1]).toMatchObject({
      phase: 'complete',
      bytesProcessed: PAYLOAD.length,
      totalBytes: PAYLOAD.length,
    });
  });

  it('rejects a device that declared no memory layout', async () => {
    // Guessing a layout would authorize erases at addresses the device
    // never reported.
    const device = new FakeDfuDevice(null);
    installUsb([device]);
    const [descriptor] = await listDfuDevices();

    await expect(
      flashDfuFirmware(descriptor.deviceId, hexBytes(0x08000000, PAYLOAD), false, noProgress),
    ).rejects.toMatchObject({code: 'DFU_LAYOUT_MISSING'});
    expect(device.erasedSectors).toEqual([]);
  });

  it('rejects an unparsable firmware file without touching the device', async () => {
    const device = new FakeDfuDevice();
    installUsb([device]);
    const [descriptor] = await listDfuDevices();

    await expect(
      flashDfuFirmware(
        descriptor.deviceId,
        encodeAscii('this is not Intel HEX'),
        false,
        noProgress,
      ),
    ).rejects.toMatchObject({code: 'DFU_FIRMWARE_INVALID'});
    expect(device.opened).toBe(false);
  });

  it('releases the interface and closes the device even when the flash fails', async () => {
    const device = new FakeDfuDevice();
    device.corruptReadBackAt = 0x08000000;
    installUsb([device]);
    const [descriptor] = await listDfuDevices();

    await expect(
      flashDfuFirmware(descriptor.deviceId, hexBytes(0x08000000, PAYLOAD), false, noProgress),
    ).rejects.toBeDefined();
    expect(device.releaseCalled).toBe(true);
    expect(device.closeCalled).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Exit and unprotect
 * ------------------------------------------------------------------ */

describe('exitDfuMode', () => {
  it('selects the application base address then manifests', async () => {
    const device = new FakeDfuDevice();
    installUsb([device]);
    const [descriptor] = await listDfuDevices();
    const spy = jest.spyOn(device, 'controlTransferOut');

    await exitDfuMode(descriptor.deviceId);

    const setAddress = spy.mock.calls.find(
      call => call[1] && new Uint8Array(call[1] as ArrayBufferLike)[0] === 0x21,
    );
    expect(setAddress).toBeDefined();
    // 0x08000000, little-endian - the STM32 application base.
    expect(Array.from(new Uint8Array(setAddress![1] as ArrayBufferLike))).toEqual([
      0x21, 0x00, 0x00, 0x00, 0x08,
    ]);
  });

  it('treats a device that reset into the application as success', async () => {
    // The board leaving DFU is the SUCCESS case, and it makes the
    // manifestation transfer itself fail. Reporting that as an error
    // would tell the operator a working flash had failed.
    const device = new FakeDfuDevice();
    const usb = installUsb([device]);
    const [descriptor] = await listDfuDevices();
    const original = device.controlTransferOut.bind(device);
    let calls = 0;
    jest.spyOn(device, 'controlTransferOut').mockImplementation(async (setup, data) => {
      calls += 1;
      if (calls > 1) {
        device.opened = false;
        usb.getDevices.mockResolvedValue([]);
        throw new DOMException('device disconnected', 'NetworkError');
      }
      return original(setup, data);
    });

    await expect(exitDfuMode(descriptor.deviceId)).resolves.toBeUndefined();
  });
});

describe('unprotectDfuDevice', () => {
  it('succeeds when the device enters the erase window and then resets to idle', async () => {
    jest.spyOn(global, 'setTimeout').mockImplementation((callback: TimerHandler) => {
      // The real implementation waits out a ~20s mass-erase safety window
      // (matching Betaflight's own). Waiting it out here would make the
      // suite unusable; the DELAY is not what is being tested, the
      // accept/reject decision is.
      (callback as () => void)();
      return 0 as unknown as NodeJS.Timeout;
    });
    const device = new FakeDfuDevice();
    installUsb([device]);
    const [descriptor] = await listDfuDevices();

    await expect(unprotectDfuDevice(descriptor.deviceId)).resolves.toBeUndefined();
  });

  it('fails when the device never enters the erase state', async () => {
    // A read-unprotect that was silently ignored must not be reported as
    // an unprotected device - the next flash would fail confusingly.
    jest.spyOn(global, 'setTimeout').mockImplementation((callback: TimerHandler) => {
      (callback as () => void)();
      return 0 as unknown as NodeJS.Timeout;
    });
    const device = new FakeDfuDevice();
    device.rejectUnprotect = true;
    installUsb([device]);
    const [descriptor] = await listDfuDevices();

    await expect(unprotectDfuDevice(descriptor.deviceId)).rejects.toMatchObject({
      code: 'DFU_UNPROTECT_FAILED',
    });
  });
});
