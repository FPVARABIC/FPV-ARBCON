/**
 * @jest-environment jsdom
 *
 * DFU MEMORY DISCOVERY - the real-hardware P0 regression suite.
 *
 * A real flight controller reached DFU mode and the flash refused with
 * "DFU device did not expose a readable memory layout descriptor" - while
 * the board was advertising its layout in its string descriptors the whole
 * time. The old implementation trusted WebUSB's convenience property
 * `alternate.interfaceName` (which the browser may leave unpopulated) and
 * implicitly trusted the FIRST alternate. The pinned Betaflight
 * Configurator (webusbdfu.js, 2025.12.2) instead reads the raw
 * configuration descriptor and every DFU alternate's string descriptor off
 * the OPENED device, then picks the region NAMED Internal Flash.
 *
 * This suite drives the REAL engine against a descriptor-realistic fake
 * device: it serves GET_DESCRIPTOR(CONFIGURATION) as raw bytes, serves
 * string descriptors as UTF-16LE with a langid table, keeps the WebUSB
 * convenience tree INDEPENDENTLY controllable (so `interfaceName` can be
 * absent exactly like the real board), enforces its advertised
 * wTransferSize, and logs every lifecycle call and transfer in order.
 *
 * Every refusal path must be proven NON-DESTRUCTIVE: zero DNLOAD traffic,
 * zero erases, an untouched flash map. "DO NOT make the error disappear by
 * skipping memory-layout validation" - these tests make the validation
 * itself the thing that cannot be skipped.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  DfuMemoryLayout,
  __resetWebUsbDfuForTests,
  flashDfuFirmware,
  getLastDfuDiscoveryDiagnostics,
  listDfuDevices,
  parseConfigurationDescriptorBlob,
} from './webUsbDfu.web';
import type {DfuFlashProgressEvent} from './usbSerialTransportTypes';

/* eslint-disable no-bitwise -- the fake device assembles raw USB
   descriptors and decodes little-endian DfuSe addresses, as the wire
   format demands. */

const DFU_DNLOAD = 1;
const DFU_UPLOAD = 2;
const DFU_GETSTATUS = 3;
const DFU_CLRSTATUS = 4;
const DFU_ABORT = 6;
const USB_GET_DESCRIPTOR = 6;

const STATE_IDLE = 2;
const STATE_DNLOAD_IDLE = 5;

const INTERNAL_F4 = '@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg';
const INTERNAL_2X16K = '@Internal Flash  /0x08000000/02*016Kg';
const INTERNAL_F74X = '@Internal Flash  /0x08000000/04*032Kg,01*128Kg,03*256Kg';
const OPTION_BYTES = '@Option Bytes  /0x1FFFC000/01*016 e';
const OTP_REGION = '@OTP Memory /0x1FFF7800/01*512 e,01*016 e';

type UsbOp = {
  readonly kind:
    | 'DNLOAD'
    | 'UPLOAD'
    | 'GETSTATUS'
    | 'CLRSTATUS'
    | 'ABORT'
    | 'GET_CONFIG_DESC'
    | 'GET_STRING_DESC'
    | 'CLAIM'
    | 'SELECT_ALT'
    | 'SELECT_CONFIG'
    | 'OTHER';
  readonly blockNumber?: number;
  readonly length?: number;
  readonly firstByte?: number;
  readonly wIndex?: number;
};

type AlternateSpec = {
  readonly alternateSetting: number;
  /** iInterface - 0 means "no string descriptor", like real hardware. */
  readonly stringIndex: number;
  readonly interfaceClass?: number;
  readonly interfaceSubclass?: number;
  readonly interfaceProtocol?: number;
  /** WebUSB convenience-tree interfaceName; undefined = browser left it
   * unpopulated, which is exactly what the failing real board showed. */
  readonly treeName?: string;
};

type InterfaceSpec = {
  readonly interfaceNumber: number;
  readonly alternates: readonly AlternateSpec[];
};

type DeviceSpec = {
  readonly interfaces: readonly InterfaceSpec[];
  /** String-descriptor table served over GET_DESCRIPTOR(STRING). */
  readonly strings?: Readonly<Record<number, string>>;
  /** When set, a DFU functional descriptor advertising this wTransferSize
   * is appended to the configuration blob AND the device REJECTS any data
   * block larger than it - like real bootloader hardware. */
  readonly wTransferSize?: number;
  readonly failConfigDescriptorRead?: boolean;
  readonly failStringIndexes?: readonly number[];
  readonly refuseClaimOf?: readonly number[];
  readonly refuseAlternate?: {
    readonly interfaceNumber: number;
    readonly alternateSetting: number;
  };
};

/** Serves REAL descriptor bytes over standard control transfers while
 * running the same DfuSe state machine the completion suite proved. */
class DescriptorRealisticDfuDevice {
  readonly vendorId = 0x0483;
  readonly productId = 0xdf11;
  readonly productName = 'STM32  BOOTLOADER';
  readonly manufacturerName = 'STMicroelectronics';
  opened = false;
  configuration: unknown = null;

  readonly flash = new Map<number, number>();
  readonly ops: UsbOp[] = [];
  readonly eraseAddresses: number[] = [];
  readonly claimedInterfaces: number[] = [];
  readonly selectedAlternates: Array<{
    interfaceNumber: number;
    alternateSetting: number;
  }> = [];

  private state = STATE_IDLE;
  private address = 0;

  constructor(private readonly spec: DeviceSpec) {}

  /** The size the device itself uses for block-offset math and enforces
   * on incoming data blocks. */
  private get deviceTransferSize(): number {
    return this.spec.wTransferSize ?? 2048;
  }

  get configurations() {
    return [
      {
        configurationValue: 1,
        interfaces: this.spec.interfaces.map(intf => ({
          interfaceNumber: intf.interfaceNumber,
          alternates: intf.alternates.map(alt => ({
            alternateSetting: alt.alternateSetting,
            interfaceClass: alt.interfaceClass ?? 0xfe,
            interfaceSubclass: alt.interfaceSubclass ?? 0x01,
            interfaceProtocol: alt.interfaceProtocol ?? 0x02,
            interfaceName: alt.treeName,
          })),
        })),
      },
    ];
  }

  /** Raw configuration descriptor: header + one 9-byte interface
   * descriptor per alternate + optional DFU functional descriptor.
   * Public so the walker test can parse the exact bytes served. */
  buildConfigBlob(): Uint8Array {
    const body: number[] = [];
    for (const intf of this.spec.interfaces) {
      for (const alt of intf.alternates) {
        body.push(
          9,
          0x04,
          intf.interfaceNumber,
          alt.alternateSetting,
          0,
          alt.interfaceClass ?? 0xfe,
          alt.interfaceSubclass ?? 0x01,
          alt.interfaceProtocol ?? 0x02,
          alt.stringIndex,
        );
      }
    }
    if (this.spec.wTransferSize !== undefined) {
      body.push(
        9,
        0x21,
        0x0b,
        0xff,
        0x00,
        this.spec.wTransferSize & 0xff,
        (this.spec.wTransferSize >> 8) & 0xff,
        0x1a,
        0x01,
      );
    }
    const total = 9 + body.length;
    return Uint8Array.from([
      9,
      0x02,
      total & 0xff,
      (total >> 8) & 0xff,
      this.spec.interfaces.length,
      1,
      0,
      0x80,
      50,
      ...body,
    ]);
  }

  async open() {
    this.opened = true;
  }
  async close() {
    this.opened = false;
  }
  async selectConfiguration(value: number) {
    this.ops.push({kind: 'SELECT_CONFIG', blockNumber: value});
    this.configuration = this.configurations[value - 1];
  }
  async claimInterface(interfaceNumber: number) {
    if (this.spec.refuseClaimOf?.includes(interfaceNumber)) {
      throw new DOMException('claim refused by test spec', 'SecurityError');
    }
    this.claimedInterfaces.push(interfaceNumber);
    this.ops.push({kind: 'CLAIM', blockNumber: interfaceNumber});
  }
  async selectAlternateInterface(interfaceNumber: number, alternateSetting: number) {
    const refuse = this.spec.refuseAlternate;
    if (
      refuse &&
      refuse.interfaceNumber === interfaceNumber &&
      refuse.alternateSetting === alternateSetting
    ) {
      throw new DOMException('alternate selection refused by test spec', 'NetworkError');
    }
    this.selectedAlternates.push({interfaceNumber, alternateSetting});
    this.ops.push({kind: 'SELECT_ALT', blockNumber: interfaceNumber, length: alternateSetting});
  }
  async releaseInterface() {}

  controlTransferOut(
    setup: {requestType?: string; request: number; value: number; index?: number},
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
      wIndex: setup.index,
    };
    this.ops.push(op);
    if (setup.request === DFU_CLRSTATUS || setup.request === DFU_ABORT) {
      this.state = STATE_IDLE;
      return Promise.resolve({status: 'ok', bytesWritten: 0});
    }
    if (setup.request !== DFU_DNLOAD) {
      return Promise.resolve({status: 'stall', bytesWritten: 0});
    }
    if (setup.value === 0) {
      if (bytes.length === 0) {
        // Manifestation ZLP: this fake stays present and reports idle,
        // the manifestation-tolerant bootloader shape.
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
        this.eraseAddresses.push(
          (bytes[1] | (bytes[2] << 8) | (bytes[3] << 16) | (bytes[4] << 24)) >>> 0,
        );
        this.state = STATE_DNLOAD_IDLE;
        return Promise.resolve({status: 'ok', bytesWritten: bytes.length});
      }
      return Promise.resolve({status: 'stall', bytesWritten: 0});
    }
    // A real bootloader cannot accept a block beyond its advertised
    // wTransferSize - honoring §15 is enforced by the DEVICE here.
    if (bytes.length > this.deviceTransferSize) {
      return Promise.resolve({status: 'stall', bytesWritten: 0});
    }
    const offset = (setup.value - 2) * this.deviceTransferSize;
    for (let index = 0; index < bytes.length; index += 1) {
      this.flash.set(this.address + offset + index, bytes[index]);
    }
    this.state = STATE_DNLOAD_IDLE;
    return Promise.resolve({status: 'ok', bytesWritten: bytes.length});
  }

  controlTransferIn(
    setup: {requestType?: string; request: number; value: number; index?: number},
    length: number,
  ): Promise<{status: string; data?: DataView}> {
    if (setup.requestType === 'standard' && setup.request === USB_GET_DESCRIPTOR) {
      return this.standardGetDescriptor(setup.value, length);
    }
    const op: UsbOp = {
      kind:
        setup.request === DFU_GETSTATUS
          ? 'GETSTATUS'
          : setup.request === DFU_UPLOAD
            ? 'UPLOAD'
            : 'OTHER',
      blockNumber: setup.value,
      length,
      wIndex: setup.index,
    };
    this.ops.push(op);
    if (setup.request === DFU_GETSTATUS) {
      const status = new Uint8Array(6);
      status[0] = 0;
      status[4] = this.state;
      return Promise.resolve({status: 'ok', data: new DataView(status.buffer)});
    }
    if (setup.request === DFU_UPLOAD) {
      if (length > this.deviceTransferSize) {
        return Promise.resolve({status: 'stall'});
      }
      const offset = (setup.value - 2) * this.deviceTransferSize;
      const out = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        out[index] = this.flash.get(this.address + offset + index) ?? 0xff;
      }
      return Promise.resolve({status: 'ok', data: new DataView(out.buffer)});
    }
    return Promise.resolve({status: 'stall'});
  }

  private standardGetDescriptor(
    value: number,
    length: number,
  ): Promise<{status: string; data?: DataView}> {
    const descriptorType = value >> 8;
    const descriptorIndex = value & 0xff;
    if (descriptorType === 0x02) {
      this.ops.push({kind: 'GET_CONFIG_DESC', blockNumber: descriptorIndex, length});
      if (this.spec.failConfigDescriptorRead) {
        return Promise.resolve({status: 'stall'});
      }
      const blob = this.buildConfigBlob();
      const served = blob.subarray(0, Math.min(length, blob.length));
      return Promise.resolve({status: 'ok', data: new DataView(served.slice().buffer)});
    }
    if (descriptorType === 0x03) {
      this.ops.push({kind: 'GET_STRING_DESC', blockNumber: descriptorIndex, length});
      if (descriptorIndex === 0) {
        // Language-id table: en-US only, like ST bootloaders.
        return Promise.resolve({
          status: 'ok',
          data: new DataView(Uint8Array.from([4, 3, 0x09, 0x04]).buffer),
        });
      }
      if (this.spec.failStringIndexes?.includes(descriptorIndex)) {
        return Promise.resolve({status: 'stall'});
      }
      const text = this.spec.strings?.[descriptorIndex];
      if (text === undefined) {
        return Promise.resolve({status: 'stall'});
      }
      const payload: number[] = [2 + text.length * 2, 3];
      for (const character of text) {
        const code = character.charCodeAt(0);
        payload.push(code & 0xff, code >> 8);
      }
      const served = payload.slice(0, Math.min(length, payload.length));
      return Promise.resolve({status: 'ok', data: new DataView(Uint8Array.from(served).buffer)});
    }
    return Promise.resolve({status: 'stall'});
  }
}

type FakeUsb = {getDevices: jest.Mock; requestDevice: jest.Mock};

function installUsb(devices: DescriptorRealisticDfuDevice[]): FakeUsb {
  const usb: FakeUsb = {
    getDevices: jest.fn(async () => devices),
    requestDevice: jest.fn(async () => devices[0]),
  };
  Object.defineProperty(navigator, 'usb', {value: usb, configurable: true});
  Object.defineProperty(window, 'isSecureContext', {value: true, configurable: true});
  return usb;
}

/** Intel HEX for one or more absolute segments (none may cross a 64 KiB
 * upper-address boundary; the fixtures below are chosen not to). */
function intelHexSegments(
  segments: ReadonlyArray<{address: number; bytes: readonly number[]}>,
): Uint8Array {
  const checksum = (values: number[]) =>
    ((~values.reduce((sum, value) => sum + value, 0) + 1) & 0xff)
      .toString(16)
      .toUpperCase()
      .padStart(2, '0');
  const record = (values: number[]) =>
    `:${values.map(v => v.toString(16).toUpperCase().padStart(2, '0')).join('')}${checksum(values)}`;
  const lines: string[] = [];
  for (const segment of segments) {
    const upper = (segment.address >>> 16) & 0xffff;
    lines.push(record([0x02, 0x00, 0x00, 0x04, (upper >> 8) & 0xff, upper & 0xff]));
    for (let offset = 0; offset < segment.bytes.length; offset += 16) {
      const chunk = segment.bytes.slice(offset, offset + 16);
      const low = (segment.address + offset) & 0xffff;
      lines.push(record([chunk.length, (low >> 8) & 0xff, low & 0xff, 0x00, ...chunk]));
    }
  }
  lines.push(':00000001FF');
  return Uint8Array.from(lines.join('\n'), character => character.charCodeAt(0));
}

const patternBytes = (count: number): number[] =>
  Array.from({length: count}, (_, index) => (index * 13 + 7) & 0xff);

const PAYLOAD_3000 = patternBytes(3000);
const HEX_3000_AT_BASE = intelHexSegments([{address: 0x08000000, bytes: PAYLOAD_3000}]);

async function driveFlash(hex: Uint8Array, fullErase = false) {
  const progress: DfuFlashProgressEvent[] = [];
  const [descriptor] = await listDfuDevices();
  expect(descriptor).toBeDefined();
  let settled:
    | {kind: 'resolved'}
    | {kind: 'rejected'; code?: string; message?: string}
    | undefined;
  const promise = flashDfuFirmware(descriptor.deviceId, hex, fullErase, event =>
    progress.push(event),
  );
  promise.then(
    () => {
      settled = {kind: 'resolved'};
    },
    (error: unknown) => {
      settled = {
        kind: 'rejected',
        code: (error as {code?: string}).code,
        message: (error as {message?: string}).message,
      };
    },
  );
  for (let round = 0; round < 400 && settled === undefined; round += 1) {
    if (jest.getTimerCount() === 0) {
      await Promise.resolve();
      await Promise.resolve();
      if (settled === undefined) {
        break;
      }
    } else {
      await jest.advanceTimersByTimeAsync(1_000);
    }
  }
  return {settled, progress, descriptor};
}

const dnloadOps = (device: DescriptorRealisticDfuDevice) =>
  device.ops.filter(op => op.kind === 'DNLOAD');
const dataBlocks = (device: DescriptorRealisticDfuDevice) =>
  device.ops.filter(op => op.kind === 'DNLOAD' && (op.blockNumber ?? 0) >= 2);
const uploads = (device: DescriptorRealisticDfuDevice) =>
  device.ops.filter(op => op.kind === 'UPLOAD');
const stringReads = (device: DescriptorRealisticDfuDevice) =>
  device.ops.filter(op => op.kind === 'GET_STRING_DESC');
const configReads = (device: DescriptorRealisticDfuDevice) =>
  device.ops.filter(op => op.kind === 'GET_CONFIG_DESC');

const expectResolvedComplete = (
  settled: Awaited<ReturnType<typeof driveFlash>>['settled'],
  progress: DfuFlashProgressEvent[],
) => {
  expect(settled).toEqual({kind: 'resolved'});
  const last = progress[progress.length - 1];
  expect(last.phase).toBe('complete');
  expect(last.percent).toBe(100);
};

const expectNothingDestructive = (device: DescriptorRealisticDfuDevice) => {
  expect(dnloadOps(device)).toHaveLength(0);
  expect(device.eraseAddresses).toHaveLength(0);
  expect(device.flash.size).toBe(0);
};

/** One DFU interface whose single alternate carries the given string
 * index, with the convenience tree deliberately UNPOPULATED. */
const singleAltSpec = (overrides?: Partial<DeviceSpec>): DeviceSpec => ({
  interfaces: [{interfaceNumber: 0, alternates: [{alternateSetting: 0, stringIndex: 4}]}],
  strings: {4: INTERNAL_F4},
  ...overrides,
});

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  __resetWebUsbDfuForTests();
  Reflect.deleteProperty(navigator as object, 'usb');
  jest.useRealTimers();
  jest.restoreAllMocks();
});

/* ================================================================== *
 * §5 - the DfuSe layout parser: multi-region, K/M/bytes, flags,
 * corrections, malformed input.
 * ================================================================== */

describe('DfuSe layout parser (§5)', () => {
  it('expands the F74x-class mixed-sector group descriptor to exact addresses', () => {
    const layout = DfuMemoryLayout.parse(INTERNAL_F74X);
    expect(layout.name).toBe('Internal Flash');
    expect(layout.sectors.map(sector => [sector.address, sector.sizeBytes])).toEqual([
      [0x08000000, 32 * 1024],
      [0x08008000, 32 * 1024],
      [0x08010000, 32 * 1024],
      [0x08018000, 32 * 1024],
      [0x08020000, 128 * 1024],
      [0x08040000, 256 * 1024],
      [0x08080000, 256 * 1024],
      [0x080c0000, 256 * 1024],
    ]);
    expect(layout.sectors.every(sector => sector.readable && sector.erasable && sector.writable)).toBe(
      true,
    );
  });

  it('decodes DfuSe permission letters and treats an absent letter as fully accessible', () => {
    const layout = DfuMemoryLayout.parse(
      '@Mixed /0x08000000/01*016Ka,01*016Ke,01*016Kg,01*016K',
    );
    expect(
      layout.sectors.map(sector => [sector.readable, sector.erasable, sector.writable]),
    ).toEqual([
      [true, false, false],
      [true, false, true],
      [true, true, true],
      [true, true, true],
    ]);
  });

  it('understands M-suffixed, K-suffixed and bare-byte sector sizes with spaces before flags', () => {
    const layout = DfuMemoryLayout.parse('@Big /0x90000000/2*1Mg,4*064Kg,01*512 g');
    expect(layout.sectors.map(sector => sector.sizeBytes)).toEqual([
      1024 * 1024,
      1024 * 1024,
      64 * 1024,
      64 * 1024,
      64 * 1024,
      64 * 1024,
      512,
    ]);
  });

  it('applies the pinned exact-string corrections and nothing else', () => {
    const corrected = DfuMemoryLayout.parse('@Option byte   /0x1FFFC000/01*512 g');
    expect(corrected.name).toBe('Option bytes');
    // A string that merely RESEMBLES a known-broken one is not rewritten.
    const untouched = DfuMemoryLayout.parse('@Option byte X /0x1FFFC000/01*512 g');
    expect(untouched.name).toBe('Option byte X');
  });

  it('rejects malformed descriptors with DFU_LAYOUT_INVALID instead of guessing', () => {
    const expectInvalid = (text: string) => {
      try {
        DfuMemoryLayout.parse(text);
        throw new Error(`expected ${text} to be rejected`);
      } catch (error) {
        expect((error as {code?: string}).code).toBe('DFU_LAYOUT_INVALID');
      }
    };
    expectInvalid('STM32 BOOTLOADER');
    expectInvalid('@Internal Flash /0x08000000/garbage');
    expectInvalid('@Internal Flash /0x08000000/00*016Kg');
    expectInvalid('@Overlap /0x08000000/01*016Kg/0x08002000/01*016Kg');
  });
});

/* ================================================================== *
 * The raw configuration-descriptor walker.
 * ================================================================== */

describe('configuration descriptor walker', () => {
  it('collects every DFU alternate and the functional wTransferSize, skipping foreign descriptors', () => {
    const device = new DescriptorRealisticDfuDevice({
      interfaces: [
        {
          interfaceNumber: 0,
          alternates: [
            {alternateSetting: 0, stringIndex: 4},
            {alternateSetting: 1, stringIndex: 5},
          ],
        },
        {
          interfaceNumber: 1,
          alternates: [
            {alternateSetting: 0, stringIndex: 0, interfaceClass: 0x0a, interfaceSubclass: 0x00},
          ],
        },
      ],
      wTransferSize: 1024,
    });
    const summary = parseConfigurationDescriptorBlob(device.buildConfigBlob());
    expect(summary.candidates).toEqual([
      expect.objectContaining({interfaceNumber: 0, alternateSetting: 0, stringIndex: 4}),
      expect.objectContaining({interfaceNumber: 0, alternateSetting: 1, stringIndex: 5}),
    ]);
    expect(summary.transferSize).toBe(1024);
  });
});

/* ================================================================== *
 * §4/§6/§8 - discovery against descriptor-realistic devices.
 * ================================================================== */

describe('memory discovery on descriptor-realistic devices', () => {
  it('REAL-HARDWARE REPRO: flashes when the convenience interfaceName is absent and the layout lives in string descriptors', async () => {
    const device = new DescriptorRealisticDfuDevice(singleAltSpec());
    installUsb([device]);

    const {settled, progress} = await driveFlash(HEX_3000_AT_BASE);

    expectResolvedComplete(settled, progress);
    // The layout came off the opened device, not the (absent) snapshot.
    expect(configReads(device).length).toBeGreaterThan(0);
    expect(stringReads(device).length).toBeGreaterThan(0);
    // Erase exactly the one 16K sector the firmware occupies.
    expect(device.eraseAddresses).toEqual([0x08000000]);
    // Every byte landed where the image said.
    expect(device.flash.get(0x08000000)).toBe(PAYLOAD_3000[0]);
    expect(device.flash.get(0x08000000 + 2999)).toBe(PAYLOAD_3000[2999]);
  });

  it('pins the §7 order: configuration → claim → alternate → descriptor reads → first DFU command', async () => {
    const device = new DescriptorRealisticDfuDevice(singleAltSpec());
    installUsb([device]);

    const {settled} = await driveFlash(HEX_3000_AT_BASE);

    expect(settled).toEqual({kind: 'resolved'});
    const kinds = device.ops.map(op => op.kind);
    const firstClassOp = device.ops.findIndex(op =>
      ['DNLOAD', 'GETSTATUS', 'UPLOAD', 'CLRSTATUS', 'ABORT'].includes(op.kind),
    );
    const order = [
      kinds.indexOf('SELECT_CONFIG'),
      kinds.indexOf('CLAIM'),
      kinds.indexOf('SELECT_ALT'),
      kinds.indexOf('GET_CONFIG_DESC'),
      kinds.indexOf('GET_STRING_DESC'),
      firstClassOp,
    ];
    expect(order.every(index => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('empty-string interfaceName in the tree also routes through deep discovery', async () => {
    const device = new DescriptorRealisticDfuDevice(
      singleAltSpec({
        interfaces: [
          {interfaceNumber: 0, alternates: [{alternateSetting: 0, stringIndex: 4, treeName: ''}]},
        ],
      }),
    );
    installUsb([device]);

    const {settled, progress} = await driveFlash(HEX_3000_AT_BASE);

    expectResolvedComplete(settled, progress);
    expect(stringReads(device).length).toBeGreaterThan(0);
  });

  it('FIXTURE B: alternate 0 is option bytes, alternate 1 is internal flash - alternate 1 is chosen by NAME evidence', async () => {
    const device = new DescriptorRealisticDfuDevice({
      interfaces: [
        {
          interfaceNumber: 0,
          alternates: [
            {alternateSetting: 0, stringIndex: 4},
            {alternateSetting: 1, stringIndex: 5},
          ],
        },
      ],
      // BOTH regions are writable - only the NAME can pick correctly.
      strings: {4: OPTION_BYTES, 5: INTERNAL_F4},
    });
    installUsb([device]);

    const {settled, progress} = await driveFlash(HEX_3000_AT_BASE);

    expectResolvedComplete(settled, progress);
    const lastSelection = device.selectedAlternates[device.selectedAlternates.length - 1];
    expect(lastSelection).toEqual({interfaceNumber: 0, alternateSetting: 1});
    // All destructive traffic stayed inside internal flash.
    expect(device.eraseAddresses).toEqual([0x08000000]);
    // §16: the alternate is selected BEFORE the first write and never
    // re-selected between write and read-back.
    const firstData = device.ops.findIndex(
      op => op.kind === 'DNLOAD' && (op.blockNumber ?? 0) >= 2,
    );
    const lastUpload =
      device.ops.length -
      1 -
      [...device.ops].reverse().findIndex(op => op.kind === 'UPLOAD');
    expect(firstData).toBeGreaterThanOrEqual(0);
    expect(lastUpload).toBeGreaterThan(firstData);
    expect(
      device.ops.slice(firstData, lastUpload + 1).filter(op => op.kind === 'SELECT_ALT'),
    ).toHaveLength(0);
    // §11: the diagnostics record tells the whole story.
    const diagnostics = getLastDfuDiscoveryDiagnostics();
    expect(diagnostics).toMatchObject({
      vendorId: 0x0483,
      productId: 0xdf11,
      chosen: {interfaceNumber: 0, alternateSetting: 1, regionName: 'Internal Flash'},
    });
    expect(diagnostics?.failureCode).toBeUndefined();
    expect(diagnostics?.candidates).toHaveLength(2);
    expect(diagnostics?.candidates[0]).toMatchObject({parse: 'ok', regionName: 'Option Bytes'});
    expect(diagnostics?.candidates[1]).toMatchObject({parse: 'ok', regionName: 'Internal Flash'});
  });

  it('a snapshot naming only the WRONG region does not trap the flash - discovery still finds internal flash', async () => {
    const device = new DescriptorRealisticDfuDevice({
      interfaces: [
        {
          interfaceNumber: 0,
          alternates: [
            // The browser populated the FIRST alternate's name only - the
            // old implementation would have trusted it and failed.
            {alternateSetting: 0, stringIndex: 4, treeName: OPTION_BYTES},
            {alternateSetting: 1, stringIndex: 5},
          ],
        },
      ],
      strings: {4: OPTION_BYTES, 5: INTERNAL_F4},
    });
    installUsb([device]);

    const {settled, progress} = await driveFlash(HEX_3000_AT_BASE);

    expectResolvedComplete(settled, progress);
    expect(device.eraseAddresses).toEqual([0x08000000]);
    expect(
      device.selectedAlternates[device.selectedAlternates.length - 1],
    ).toEqual({interfaceNumber: 0, alternateSetting: 1});
  });

  it('FIXTURE C: a non-DFU first interface is skipped entirely; DFU traffic targets the DFU interface', async () => {
    const device = new DescriptorRealisticDfuDevice({
      interfaces: [
        {
          interfaceNumber: 0,
          alternates: [
            {alternateSetting: 0, stringIndex: 0, interfaceClass: 0x0a, interfaceSubclass: 0x00},
          ],
        },
        {interfaceNumber: 1, alternates: [{alternateSetting: 0, stringIndex: 4}]},
      ],
      strings: {4: INTERNAL_F4},
    });
    installUsb([device]);

    const {settled, progress} = await driveFlash(HEX_3000_AT_BASE);

    expectResolvedComplete(settled, progress);
    expect(device.claimedInterfaces).toEqual([1]);
    expect(dnloadOps(device).every(op => op.wIndex === 1)).toBe(true);
  });

  it('FIXTURE: two DFU interfaces - the one whose descriptor parses is claimed and all class traffic is rebound to it', async () => {
    const device = new DescriptorRealisticDfuDevice({
      interfaces: [
        {interfaceNumber: 0, alternates: [{alternateSetting: 0, stringIndex: 4}]},
        {interfaceNumber: 1, alternates: [{alternateSetting: 0, stringIndex: 5}]},
      ],
      strings: {4: 'NOT A LAYOUT', 5: INTERNAL_F4},
    });
    installUsb([device]);

    const {settled, progress} = await driveFlash(HEX_3000_AT_BASE);

    expectResolvedComplete(settled, progress);
    expect(device.claimedInterfaces).toEqual([0, 1]);
    // Class requests route by wIndex: after the re-claim every DFU
    // command must target interface 1, not the originally claimed 0.
    expect(dnloadOps(device).length).toBeGreaterThan(0);
    expect(dnloadOps(device).every(op => op.wIndex === 1)).toBe(true);
    expect(uploads(device).every(op => op.wIndex === 1)).toBe(true);
  });

  it('FIXTURE D: OTP and option-byte regions are never chosen over the region named Internal Flash', async () => {
    const device = new DescriptorRealisticDfuDevice({
      interfaces: [
        {
          interfaceNumber: 0,
          alternates: [
            {alternateSetting: 0, stringIndex: 4},
            {alternateSetting: 1, stringIndex: 5},
            {alternateSetting: 2, stringIndex: 6},
          ],
        },
      ],
      strings: {4: INTERNAL_F4, 5: OTP_REGION, 6: OPTION_BYTES},
    });
    installUsb([device]);

    const {settled, progress} = await driveFlash(HEX_3000_AT_BASE);

    expectResolvedComplete(settled, progress);
    expect(
      device.selectedAlternates[device.selectedAlternates.length - 1],
    ).toEqual({interfaceNumber: 0, alternateSetting: 0});
    // No erase or write ever touched the OTP/option address space.
    expect(device.eraseAddresses).toEqual([0x08000000]);
    for (const address of device.flash.keys()) {
      expect(address).toBeGreaterThanOrEqual(0x08000000);
      expect(address).toBeLessThan(0x08200000);
    }
  });

  it('a single writable region with a nonstandard name is accepted on that evidence', async () => {
    const device = new DescriptorRealisticDfuDevice({
      interfaces: [
        {
          interfaceNumber: 0,
          alternates: [
            {alternateSetting: 0, stringIndex: 4},
            {alternateSetting: 1, stringIndex: 5},
          ],
        },
      ],
      strings: {
        4: '@Program Memory /0x08000000/08*016Kg',
        5: '@Readback Cal /0x1FFF0000/01*016Ka',
      },
    });
    installUsb([device]);

    const {settled, progress} = await driveFlash(HEX_3000_AT_BASE);

    expectResolvedComplete(settled, progress);
    expect(device.eraseAddresses).toEqual([0x08000000]);
  });
});

/* ================================================================== *
 * §12 - the error taxonomy, each code with ZERO destructive traffic.
 * ================================================================== */

describe('taxonomy refusals are truthful and non-destructive (§12)', () => {
  it('DFU_MEMORY_LAYOUT_MISSING when no alternate carries a string index at all', async () => {
    const device = new DescriptorRealisticDfuDevice({
      interfaces: [{interfaceNumber: 0, alternates: [{alternateSetting: 0, stringIndex: 0}]}],
    });
    installUsb([device]);

    const {settled} = await driveFlash(HEX_3000_AT_BASE);

    expect(settled).toEqual({
      kind: 'rejected',
      code: 'DFU_MEMORY_LAYOUT_MISSING',
      message: expect.stringContaining('memory layout'),
    });
    expectNothingDestructive(device);
    expect(getLastDfuDiscoveryDiagnostics()).toMatchObject({
      failureCode: 'DFU_MEMORY_LAYOUT_MISSING',
    });
    expect(getLastDfuDiscoveryDiagnostics()?.candidates[0]).toMatchObject({parse: 'empty'});
  });

  it('DFU_MEMORY_LAYOUT_MISSING when every string read stalls on the bus', async () => {
    const device = new DescriptorRealisticDfuDevice(
      singleAltSpec({failStringIndexes: [4]}),
    );
    installUsb([device]);

    const {settled} = await driveFlash(HEX_3000_AT_BASE);

    expect(settled).toMatchObject({kind: 'rejected', code: 'DFU_MEMORY_LAYOUT_MISSING'});
    expectNothingDestructive(device);
  });

  it('DFU_LAYOUT_MISSING with the real-hardware wording when even the configuration descriptor is unreadable and no snapshot exists', async () => {
    const device = new DescriptorRealisticDfuDevice(
      singleAltSpec({failConfigDescriptorRead: true}),
    );
    installUsb([device]);

    const {settled} = await driveFlash(HEX_3000_AT_BASE);

    expect(settled).toEqual({
      kind: 'rejected',
      code: 'DFU_LAYOUT_MISSING',
      message: expect.stringContaining('did not expose a readable memory layout'),
    });
    expectNothingDestructive(device);
  });

  it('DFU_MEMORY_LAYOUT_INVALID when the advertised text is not a DfuSe layout', async () => {
    const device = new DescriptorRealisticDfuDevice(
      singleAltSpec({strings: {4: 'STM32 BOOTLOADER JUNK'}}),
    );
    installUsb([device]);

    const {settled} = await driveFlash(HEX_3000_AT_BASE);

    expect(settled).toMatchObject({kind: 'rejected', code: 'DFU_MEMORY_LAYOUT_INVALID'});
    expectNothingDestructive(device);
    const candidate = getLastDfuDiscoveryDiagnostics()?.candidates[0];
    expect(candidate).toMatchObject({parse: 'invalid'});
    expect(candidate?.parseError).toBeTruthy();
  });

  it('DFU_MEMORY_LAYOUT_NOT_WRITABLE when internal flash advertises read-only sectors', async () => {
    const device = new DescriptorRealisticDfuDevice(
      singleAltSpec({strings: {4: '@Internal Flash  /0x08000000/12*128Ka'}}),
    );
    installUsb([device]);

    const {settled} = await driveFlash(HEX_3000_AT_BASE);

    expect(settled).toMatchObject({kind: 'rejected', code: 'DFU_MEMORY_LAYOUT_NOT_WRITABLE'});
    expectNothingDestructive(device);
  });

  it('DFU_FLASH_ALTERNATE_NOT_FOUND when several writable regions have nonstandard names - it refuses to guess', async () => {
    const device = new DescriptorRealisticDfuDevice({
      interfaces: [
        {
          interfaceNumber: 0,
          alternates: [
            {alternateSetting: 0, stringIndex: 4},
            {alternateSetting: 1, stringIndex: 5},
          ],
        },
      ],
      strings: {
        4: '@Weird Region A /0x08000000/04*016Kg',
        5: '@Weird Region B /0x08100000/04*016Kg',
      },
    });
    installUsb([device]);

    const {settled} = await driveFlash(HEX_3000_AT_BASE);

    expect(settled).toMatchObject({kind: 'rejected', code: 'DFU_FLASH_ALTERNATE_NOT_FOUND'});
    expectNothingDestructive(device);
  });

  it('DFU_INTERFACE_CLAIM_FAILED when the flash interface cannot be claimed', async () => {
    const device = new DescriptorRealisticDfuDevice({
      interfaces: [
        {interfaceNumber: 0, alternates: [{alternateSetting: 0, stringIndex: 4}]},
        {interfaceNumber: 1, alternates: [{alternateSetting: 0, stringIndex: 5}]},
      ],
      strings: {4: 'NOT A LAYOUT', 5: INTERNAL_F4},
      refuseClaimOf: [1],
    });
    installUsb([device]);

    const {settled} = await driveFlash(HEX_3000_AT_BASE);

    expect(settled).toMatchObject({kind: 'rejected', code: 'DFU_INTERFACE_CLAIM_FAILED'});
    expectNothingDestructive(device);
  });

  it('DFU_ALTERNATE_SELECTION_FAILED when selecting the flash alternate is refused', async () => {
    const device = new DescriptorRealisticDfuDevice({
      interfaces: [
        {
          interfaceNumber: 0,
          alternates: [
            {alternateSetting: 0, stringIndex: 4},
            {alternateSetting: 1, stringIndex: 5},
          ],
        },
      ],
      strings: {4: 'NOT A LAYOUT', 5: INTERNAL_F4},
      refuseAlternate: {interfaceNumber: 0, alternateSetting: 1},
    });
    installUsb([device]);

    const {settled} = await driveFlash(HEX_3000_AT_BASE);

    expect(settled).toMatchObject({kind: 'rejected', code: 'DFU_ALTERNATE_SELECTION_FAILED'});
    expectNothingDestructive(device);
  });
});

/* ================================================================== *
 * §13/§14 - range validation against the writable map and erase
 * planning from parsed geometry.
 * ================================================================== */

describe('range validation and erase planning (§13/§14)', () => {
  it('DFU_ADDRESS_OUT_OF_RANGE before any DNLOAD when the image exceeds the layout', async () => {
    const device = new DescriptorRealisticDfuDevice(
      singleAltSpec({strings: {4: INTERNAL_2X16K}}),
    );
    installUsb([device]);

    const {settled} = await driveFlash(
      intelHexSegments([{address: 0x08007000, bytes: patternBytes(8192)}]),
    );

    expect(settled).toEqual({
      kind: 'rejected',
      code: 'DFU_ADDRESS_OUT_OF_RANGE',
      message: expect.stringContaining('outside the Internal Flash layout'),
    });
    expectNothingDestructive(device);
  });

  it('an image that EXACTLY fills the last writable byte flashes cleanly', async () => {
    const device = new DescriptorRealisticDfuDevice(
      singleAltSpec({strings: {4: INTERNAL_2X16K}}),
    );
    installUsb([device]);
    const payload = patternBytes(16384);

    const {settled, progress} = await driveFlash(
      intelHexSegments([{address: 0x08004000, bytes: payload}]),
    );

    expectResolvedComplete(settled, progress);
    expect(device.eraseAddresses).toEqual([0x08004000]);
    expect(device.flash.get(0x08004000)).toBe(payload[0]);
    expect(device.flash.get(0x08007fff)).toBe(payload[16383]);
    expect(device.flash.get(0x08008000)).toBeUndefined();
  });

  it('DFU_MEMORY_LAYOUT_NOT_WRITABLE when a segment runs into a read-only tail sector', async () => {
    const device = new DescriptorRealisticDfuDevice(
      singleAltSpec({strings: {4: '@Internal Flash  /0x08000000/01*016Kg,01*016Ka'}}),
    );
    installUsb([device]);

    const {settled} = await driveFlash(
      intelHexSegments([{address: 0x08003000, bytes: patternBytes(8192)}]),
    );

    expect(settled).toMatchObject({kind: 'rejected', code: 'DFU_MEMORY_LAYOUT_NOT_WRITABLE'});
    expectNothingDestructive(device);
  });

  it('plans erases per PARSED mixed-sector geometry: one erase per touched sector at its true base', async () => {
    const device = new DescriptorRealisticDfuDevice(
      singleAltSpec({strings: {4: INTERNAL_F74X}}),
    );
    installUsb([device]);

    // Three islands: one in a 32K sector, one in the 128K sector, one in
    // a 256K sector. Erase must hit exactly those three sector bases.
    const {settled, progress} = await driveFlash(
      intelHexSegments([
        {address: 0x08000000, bytes: patternBytes(200)},
        {address: 0x08021000, bytes: patternBytes(200)},
        {address: 0x08041000, bytes: patternBytes(200)},
      ]),
    );

    expectResolvedComplete(settled, progress);
    expect(device.eraseAddresses).toEqual([0x08000000, 0x08020000, 0x08040000]);
    expect(device.flash.get(0x08021000)).toBe(patternBytes(1)[0]);
  });

  it('full erase only erases sectors the layout marks erasable', async () => {
    const device = new DescriptorRealisticDfuDevice(
      singleAltSpec({strings: {4: '@Internal Flash  /0x08000000/01*016Kg,01*016Ka'}}),
    );
    installUsb([device]);

    const {settled, progress} = await driveFlash(
      intelHexSegments([{address: 0x08000000, bytes: patternBytes(256)}]),
      true,
    );

    expectResolvedComplete(settled, progress);
    expect(device.eraseAddresses).toEqual([0x08000000]);
  });
});

/* ================================================================== *
 * §15 - the device's advertised wTransferSize governs both directions.
 * ================================================================== */

describe('transfer size honoring (§15)', () => {
  it('splits writes and read-backs at the advertised 1024 bytes on a device that rejects anything larger', async () => {
    const device = new DescriptorRealisticDfuDevice(
      singleAltSpec({wTransferSize: 1024}),
    );
    installUsb([device]);

    const {settled, progress} = await driveFlash(HEX_3000_AT_BASE);

    expectResolvedComplete(settled, progress);
    expect(dataBlocks(device).map(op => op.length)).toEqual([1024, 1024, 952]);
    expect(uploads(device).map(op => op.length)).toEqual([1024, 1024, 952]);
    expect(device.flash.get(0x08000000 + 2999)).toBe(PAYLOAD_3000[2999]);
  });

  it('keeps the documented 2048-byte default when no functional descriptor is advertised', async () => {
    const device = new DescriptorRealisticDfuDevice(singleAltSpec());
    installUsb([device]);

    const {settled} = await driveFlash(HEX_3000_AT_BASE);

    expect(settled).toEqual({kind: 'resolved'});
    expect(dataBlocks(device).map(op => op.length)).toEqual([2048, 952]);
  });

  it('honors wTransferSize on the SNAPSHOT fast path too, without reading any strings', async () => {
    const device = new DescriptorRealisticDfuDevice({
      interfaces: [
        {
          interfaceNumber: 0,
          alternates: [{alternateSetting: 0, stringIndex: 4, treeName: INTERNAL_F4}],
        },
      ],
      strings: {4: INTERNAL_F4},
      wTransferSize: 1024,
    });
    installUsb([device]);

    const {settled, progress} = await driveFlash(HEX_3000_AT_BASE);

    expectResolvedComplete(settled, progress);
    expect(configReads(device).length).toBeGreaterThan(0);
    expect(stringReads(device)).toHaveLength(0);
    expect(dataBlocks(device).map(op => op.length)).toEqual([1024, 1024, 952]);
  });
});

/* ================================================================== *
 * §9/§10 - target independence and no blind fallbacks, at the source.
 * ================================================================== */

describe('source hygiene (§9/§10)', () => {
  it('the engine names no vendor or board and never indexes interfaces/alternates blindly', () => {
    const source = fs.readFileSync(path.join(__dirname, 'webUsbDfu.web.ts'), 'utf8');
    expect(
      /kakute|matek|speedybee|iflight|mamba|holybro|foxeer|geprc|diatone/i.test(source),
    ).toBe(false);
    expect(source.includes('interfaces[0]')).toBe(false);
    expect(source.includes('alternates[0]')).toBe(false);
  });
});
