/**
 * STM32 DFU / DfuSe OVER WebUSB.
 *
 * A DIRECT PORT OF THE ANDROID WORKERS, not a reimplementation. The state
 * machine, the sector arithmetic, the status polling, the progress bands
 * (erase 0-20%, write 20-75%, verify 75-99%, complete 100%) and the
 * manifestation quirk handling all mirror DfuFlashWorker.kt,
 * DfuExitWorker.kt, DfuUnprotectWorker.kt and DfuMemoryLayout.kt
 * line-for-line in behaviour. Where the two differ, it is because WebUSB
 * genuinely cannot do what libusb can, and every such point is called out
 * below rather than papered over.
 *
 * THE THREE PLACES WebUSB IS GENUINELY WEAKER:
 *
 *   1. NO RAW DESCRIPTORS, SO NO wTransferSize. Android reads the DFU
 *      functional descriptor off `connection.rawDescriptors` to learn the
 *      device's advertised transfer size. WebUSB exposes no equivalent, so
 *      this uses the same 2048-byte default Android falls back to and
 *      Betaflight Configurator's own WebUSB path uses. A device
 *      advertising a SMALLER transfer size than 2048 would reject the
 *      write - which surfaces as a real DFU_TRANSFER_FAILED, not as
 *      silent corruption.
 *
 *   2. NO DEVICE-LIST POLLING. Android resolves the "did it manifest, or
 *      did it just reset?" ambiguity by re-reading UsbManager.deviceList
 *      and checking whether the same identity is still attached. In a
 *      browser the equivalent evidence is that the USBDevice's connection
 *      has gone: after a reset, transfers throw NotFoundError /
 *      NetworkError and `device.opened` goes false. That is what is
 *      checked here, and it is weaker evidence - see deviceWentAway().
 *
 *   3. NO CONTROL-TRANSFER TIMEOUT. WebUSB has no timeout parameter, so a
 *      wedged device would hang a transfer forever. Every poll loop here
 *      is therefore bounded by its own iteration count exactly as the
 *      Android workers are, and the flash is additionally bounded by the
 *      cancellation flag the UI's Cancel button sets.
 *
 * SAFETY POSTURE, unchanged from Android: the firmware's addresses are
 * checked against the device's OWN parsed memory layout BEFORE anything is
 * erased, every written byte is read back and compared, and a mismatch
 * fails the operation rather than reporting success.
 */

// Imported from the MODULE, not the `firmware-flasher` barrel. The barrel
// also re-exports buildApi.ts, which constructs a BetaflightBuildApi at
// module scope and captures the global `fetch` as it does. Pulling that in
// here would drag the cloud-build client into the transport's import graph
// for no reason - and it fails outright in any environment without
// `fetch`, which is how this was noticed.
import {parseIntelHex} from '../../../../core/firmware-flasher/intelHex';
import type {IntelHexImage} from '../../../../core/firmware-flasher/intelHex';
import type {DfuDeviceDescriptor, DfuFlashProgressEvent} from './usbSerialTransportTypes';

/* eslint-disable no-bitwise -- DfuSe is a byte-level USB protocol: status
   words, little-endian addresses and sector sizes are all assembled and
   taken apart with shifts and masks. Every use below is an ordinary
   protocol encode/decode, the same allowance src/platforms/react-native/
   protocol/base64.ts already takes for the same reason. */

/* ------------------------------------------------------------------ *
 * Protocol constants - identical values to DfuFlashWorker.kt
 * ------------------------------------------------------------------ */

const DFU_DNLOAD = 1;
const DFU_UPLOAD = 2;
const DFU_GETSTATUS = 3;
const DFU_CLRSTATUS = 4;
const DFU_ABORT = 6;

const DFU_STATE_IDLE = 2;
const DFU_STATE_DNLOAD_BUSY = 4;
const DFU_STATE_DNLOAD_IDLE = 5;
const DFU_STATE_MANIFEST_WAIT_RESET = 8;
const DFU_STATE_UPLOAD_IDLE = 9;
const DFU_STATE_ERROR = 10;

const DFUSE_SET_ADDRESS = 0x21;
const DFUSE_ERASE = 0x41;
const DFUSE_READ_UNPROTECT = 0x92;

/** See note 1 in the file header: WebUSB cannot read wTransferSize. */
const DEFAULT_DFU_TRANSFER_SIZE = 2048;
const MAX_STATUS_POLLS = 100;
const MAX_SINGLE_POLL_DELAY_MS = 500;
const MAX_REPORTED_ERASE_DELAY_MS = 30_000;
const ERASE_SAFETY_DELAY_MS = 20_000;

const DFU_INTERFACE_CLASS = 0xfe;
const DFU_INTERFACE_SUBCLASS = 0x01;

/** The same identities android/.../DfuFlashWorker.kt's SUPPORTED_DFU_IDS lists. */
const SUPPORTED_DFU_IDS: ReadonlyArray<readonly [number, number]> = [
  [0x0483, 0xdf11],
  [0x28e9, 0x0189],
  [0x2e3c, 0xdf11],
  [0x314b, 0x0106],
  [0x3997, 0xdf11],
];

/**
 * DFU device ids live in their own numeric range, deliberately far from the
 * serial transport's. Android hands both surfaces the same OS device id;
 * the browser has no such id and this module invents one, so keeping the
 * ranges disjoint means a serial id accidentally passed to a DFU call
 * fails loudly instead of selecting the wrong device.
 */
const DFU_DEVICE_ID_BASE = 1_000_000;

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

export class DfuError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DfuError';
    this.code = code;
  }
}

export class DfuCancelledError extends DfuError {
  constructor() {
    super('DFU_CANCELLED', 'DFU flash cancelled.');
    this.name = 'DfuCancelledError';
  }
}

/* ------------------------------------------------------------------ *
 * Memory layout - a direct port of DfuMemoryLayout.kt
 * ------------------------------------------------------------------ */

export type DfuSector = {readonly address: number; readonly sizeBytes: number};

const REGION_PATTERN = /\/(0x[0-9a-fA-F]+)\/([^/]+)/g;
const SECTOR_PATTERN = /^\s*(\d+)\s*\*\s*(\d+)\s*([bBkKmM]?)\s*[a-gA-G]?\s*$/;

export class DfuMemoryLayout {
  constructor(
    readonly name: string,
    readonly sectors: readonly DfuSector[],
  ) {}

  /** True when [address, address+length) is fully covered by real sectors. */
  contains(address: number, length: number): boolean {
    if (length <= 0) {
      return false;
    }
    let cursor = address;
    const end = address + length;
    while (cursor < end) {
      const sector = this.sectors.find(
        candidate =>
          cursor >= candidate.address &&
          cursor < candidate.address + candidate.sizeBytes,
      );
      if (!sector) {
        return false;
      }
      cursor = Math.min(end, sector.address + sector.sizeBytes);
    }
    return true;
  }

  sectorsOverlapping(address: number, length: number): DfuSector[] {
    const end = address + length;
    return this.sectors.filter(
      sector => sector.address < end && sector.address + sector.sizeBytes > address,
    );
  }

  /**
   * Parses a DfuSe memory descriptor such as
   * `@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg`.
   */
  static parse(descriptor: string): DfuMemoryLayout {
    // Strip anything outside printable ASCII first: some bootloaders pad
    // the string descriptor with NULs, which would otherwise land inside a
    // sector token and fail the pattern for a reason nobody could read.
    const printable = Array.from(descriptor)
      .filter(character => {
        const code = character.charCodeAt(0);
        return code >= 0x20 && code <= 0x7e;
      })
      .join('');
    if (!printable.trim().startsWith('@')) {
      throw new DfuError(
        'DFU_LAYOUT_INVALID',
        'DFU memory descriptor must start with @.',
      );
    }
    const name = printable.split('/')[0].trim().replace(/^@/, '').trim();
    const sectors: DfuSector[] = [];

    REGION_PATTERN.lastIndex = 0;
    let region: RegExpExecArray | null;
    while ((region = REGION_PATTERN.exec(printable)) !== null) {
      let address = Number.parseInt(region[1].replace(/^0x/, ''), 16);
      for (const token of region[2].split(',')) {
        const match = SECTOR_PATTERN.exec(token);
        if (!match) {
          throw new DfuError(
            'DFU_LAYOUT_INVALID',
            `Unrecognized DFU sector descriptor: ${token}`,
          );
        }
        const count = Number.parseInt(match[1], 10);
        const rawSize = Number.parseInt(match[2], 10);
        const multiplier =
          match[3].toUpperCase() === 'K'
            ? 1024
            : match[3].toUpperCase() === 'M'
              ? 1024 * 1024
              : 1;
        const size = rawSize * multiplier;
        if (!(count > 0) || !(size >= 1) || !Number.isSafeInteger(size)) {
          throw new DfuError('DFU_LAYOUT_INVALID', 'Invalid DFU sector size/count.');
        }
        for (let index = 0; index < count; index += 1) {
          sectors.push({address, sizeBytes: size});
          address += size;
          if (!Number.isSafeInteger(address)) {
            throw new DfuError('DFU_LAYOUT_INVALID', 'DFU sector address overflowed.');
          }
        }
      }
    }

    if (sectors.length === 0) {
      throw new DfuError(
        'DFU_LAYOUT_INVALID',
        'DFU memory descriptor contains no usable sectors.',
      );
    }
    const ordered = [...sectors].sort((left, right) => left.address - right.address);
    for (let index = 0; index + 1 < ordered.length; index += 1) {
      const left = ordered[index];
      const right = ordered[index + 1];
      if (left.address + left.sizeBytes > right.address) {
        throw new DfuError('DFU_LAYOUT_INVALID', 'DFU memory sectors overlap.');
      }
    }
    return new DfuMemoryLayout(name, ordered);
  }
}

/* ------------------------------------------------------------------ *
 * Device registry
 * ------------------------------------------------------------------ */

type DfuTarget = {
  readonly device: USBDevice;
  readonly interfaceNumber: number;
  readonly alternateSetting: number;
  readonly memoryLayout?: string;
};

let nextDfuOrdinal = 0;
const idByDevice = new Map<USBDevice, number>();
const targetById = new Map<number, DfuTarget>();

function usbApi(): USB {
  if (typeof navigator === 'undefined' || !navigator.usb) {
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      throw new DfuError(
        'INSECURE_CONTEXT',
        'WebUSB requires a secure context (HTTPS or localhost).',
      );
    }
    throw new DfuError('WEB_USB_UNSUPPORTED', 'This browser does not implement WebUSB.');
  }
  return navigator.usb;
}

function isSupportedDfuDevice(device: USBDevice): boolean {
  return SUPPORTED_DFU_IDS.some(
    ([vendorId, productId]) =>
      device.vendorId === vendorId && device.productId === productId,
  );
}

/**
 * Finds the DFU interface the same way findDfuInterface() does on Android:
 * by CLASS/SUBCLASS, never by index or by name.
 *
 * `alternates` is walked because DfuSe exposes each memory region as its
 * own alternate setting - alt 0 Internal Flash, alt 1 Option Bytes, and so
 * on. The FIRST is taken, which is Internal Flash on every STM32
 * bootloader; picking a later one would point the whole flash at option
 * bytes.
 */
function findDfuInterface(
  device: USBDevice,
): {interfaceNumber: number; alternateSetting: number; memoryLayout?: string} | null {
  // `configurations` is populated from the device descriptors and is
  // readable WITHOUT opening the device, which is what lets listDevices()
  // report a memory layout without claiming anything.
  const configuration = device.configuration ?? device.configurations[0];
  if (!configuration) {
    return null;
  }
  for (const usbInterface of configuration.interfaces) {
    for (const alternate of usbInterface.alternates) {
      if (
        alternate.interfaceClass === DFU_INTERFACE_CLASS &&
        alternate.interfaceSubclass === DFU_INTERFACE_SUBCLASS
      ) {
        return {
          interfaceNumber: usbInterface.interfaceNumber,
          alternateSetting: alternate.alternateSetting,
          memoryLayout: alternate.interfaceName ?? undefined,
        };
      }
    }
  }
  return null;
}

function register(device: USBDevice): DfuDeviceDescriptor | null {
  const found = findDfuInterface(device);
  if (!found) {
    return null;
  }
  let deviceId = idByDevice.get(device);
  if (deviceId === undefined) {
    deviceId = DFU_DEVICE_ID_BASE + nextDfuOrdinal;
    nextDfuOrdinal += 1;
    idByDevice.set(device, deviceId);
  }
  targetById.set(deviceId, {device, ...found});
  return {
    deviceId,
    vendorId: device.vendorId,
    productId: device.productId,
    // Unlike Web Serial, WebUSB DOES expose these, so they are reported
    // as the device gave them rather than left blank.
    productName: device.productName ?? undefined,
    manufacturerName: device.manufacturerName ?? undefined,
    interfaceNumber: found.interfaceNumber,
    alternateSetting: found.alternateSetting,
    memoryLayout: found.memoryLayout,
  };
}

function requireTarget(deviceId: number): DfuTarget {
  const target = targetById.get(deviceId);
  if (!target) {
    throw new DfuError('DFU_DEVICE_NOT_FOUND', `No authorized DFU device with id ${deviceId}.`);
  }
  return target;
}

/* ------------------------------------------------------------------ *
 * A claimed DFU session
 * ------------------------------------------------------------------ */

const delay = (milliseconds: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

class DfuConnection {
  constructor(
    private readonly device: USBDevice,
    private readonly interfaceNumber: number,
    private readonly isCancelled: () => boolean,
  ) {}

  static async open(
    target: DfuTarget,
    isCancelled: () => boolean,
  ): Promise<DfuConnection> {
    const {device, interfaceNumber, alternateSetting} = target;
    try {
      if (!device.opened) {
        await device.open();
      }
    } catch (reason) {
      throw new DfuError('DFU_OPEN_FAILED', describe(reason));
    }
    try {
      if (device.configuration === null) {
        await device.selectConfiguration(1);
      }
      await device.claimInterface(interfaceNumber);
      // DfuSe puts each memory region on its own alternate setting; the
      // wrong one silently addresses option bytes instead of flash.
      await device.selectAlternateInterface(interfaceNumber, alternateSetting);
    } catch (reason) {
      await device.close().catch(() => undefined);
      throw new DfuError('DFU_CLAIM_FAILED', describe(reason));
    }
    return new DfuConnection(device, interfaceNumber, isCancelled);
  }

  async release(): Promise<void> {
    // Both are best-effort: after a successful manifestation or an
    // unprotect the device has already reset, and every call here throws.
    // That is the expected outcome, not a failure to report.
    await this.device.releaseInterface(this.interfaceNumber).catch(() => undefined);
    await this.device.close().catch(() => undefined);
  }

  /**
   * True when the device has reset out from under us - the browser's
   * equivalent of Android re-reading UsbManager.deviceList. See note 2 in
   * the file header: this is weaker evidence than Android's, so it is used
   * ONLY to accept an expected post-manifestation disappearance, never to
   * claim a flash succeeded.
   */
  async deviceWentAway(): Promise<boolean> {
    if (!this.device.opened) {
      return true;
    }
    try {
      const devices = await navigator.usb.getDevices();
      return !devices.includes(this.device);
    } catch {
      return false;
    }
  }

  private checkCancelled(): void {
    if (this.isCancelled()) {
      throw new DfuCancelledError();
    }
  }

  async download(blockNumber: number, data: Uint8Array): Promise<void> {
    this.checkCancelled();
    let result: USBOutTransferResult;
    try {
      result = await this.device.controlTransferOut(
        {
          requestType: 'class',
          recipient: 'interface',
          request: DFU_DNLOAD,
          value: blockNumber,
          index: this.interfaceNumber,
        },
        // A fresh copy: WebUSB detaches the backing buffer of a view it is
        // given, and `data` here is a subarray of the firmware image that
        // the read-back pass compares against afterwards.
        data.slice(),
      );
    } catch (reason) {
      throw new DfuError('DFU_TRANSFER_FAILED', describe(reason));
    }
    if (result.status !== 'ok' || (result.bytesWritten ?? 0) !== data.length) {
      throw new DfuError(
        'DFU_TRANSFER_FAILED',
        'DFU download transfer failed or was incomplete.',
      );
    }
  }

  /** A DfuSe command is a DNLOAD to block 0. */
  async command(data: Uint8Array): Promise<void> {
    await this.download(0, data);
  }

  async upload(blockNumber: number, length: number): Promise<Uint8Array> {
    this.checkCancelled();
    let result: USBInTransferResult;
    try {
      result = await this.device.controlTransferIn(
        {
          requestType: 'class',
          recipient: 'interface',
          request: DFU_UPLOAD,
          value: blockNumber,
          index: this.interfaceNumber,
        },
        length,
      );
    } catch (reason) {
      throw new DfuError('DFU_TRANSFER_FAILED', describe(reason));
    }
    if (result.status !== 'ok' || !result.data) {
      throw new DfuError('DFU_TRANSFER_FAILED', 'DFU upload transfer failed.');
    }
    return new Uint8Array(
      result.data.buffer,
      result.data.byteOffset,
      result.data.byteLength,
    );
  }

  /** GETSTATUS: [status, pollTimeout(3 bytes LE), state, iString]. */
  async status(): Promise<Uint8Array> {
    let result: USBInTransferResult;
    try {
      result = await this.device.controlTransferIn(
        {
          requestType: 'class',
          recipient: 'interface',
          request: DFU_GETSTATUS,
          value: 0,
          index: this.interfaceNumber,
        },
        6,
      );
    } catch (reason) {
      throw new DfuError('DFU_STATUS_FAILED', describe(reason));
    }
    if (result.status !== 'ok' || !result.data || result.data.byteLength !== 6) {
      throw new DfuError('DFU_STATUS_FAILED', 'DFU GETSTATUS returned an invalid response.');
    }
    return new Uint8Array(
      result.data.buffer,
      result.data.byteOffset,
      result.data.byteLength,
    );
  }

  private async controlNoData(request: number): Promise<void> {
    try {
      const result = await this.device.controlTransferOut({
        requestType: 'class',
        recipient: 'interface',
        request,
        value: 0,
        index: this.interfaceNumber,
      });
      if (result.status !== 'ok') {
        throw new Error(`status ${result.status}`);
      }
    } catch (reason) {
      throw new DfuError('DFU_TRANSFER_FAILED', describe(reason));
    }
  }

  /** Honours the device's own requested poll interval, capped. */
  private async sleepPoll(status: Uint8Array): Promise<void> {
    const reported = status[1] | (status[2] << 8) | (status[3] << 16);
    if (reported > 0) {
      await delay(Math.min(reported, MAX_SINGLE_POLL_DELAY_MS));
    }
  }

  async ensureIdle(): Promise<void> {
    for (let poll = 0; poll < MAX_STATUS_POLLS; poll += 1) {
      this.checkCancelled();
      const status = await this.status();
      await this.sleepPoll(status);
      const state = status[4];
      if (state === DFU_STATE_IDLE) {
        return;
      }
      if (state === DFU_STATE_ERROR) {
        await this.controlNoData(DFU_CLRSTATUS);
      } else if (state === DFU_STATE_DNLOAD_IDLE || state === DFU_STATE_UPLOAD_IDLE) {
        await this.controlNoData(DFU_ABORT);
      }
    }
    throw new DfuError('DFU_STATUS_TIMEOUT', 'DFU device did not return to idle state.');
  }

  async waitForDownloadIdle(): Promise<void> {
    for (let poll = 0; poll < MAX_STATUS_POLLS; poll += 1) {
      this.checkCancelled();
      const status = await this.status();
      await this.sleepPoll(status);
      const state = status[4];
      if (state === DFU_STATE_DNLOAD_IDLE) {
        return;
      }
      if (state === DFU_STATE_ERROR) {
        throw new DfuError(
          'DFU_DEVICE_ERROR',
          `DFU device reported status ${status[0]}.`,
        );
      }
    }
    throw new DfuError(
      'DFU_STATUS_TIMEOUT',
      'DFU write did not reach download-idle state.',
    );
  }

  async waitForManifestation(): Promise<void> {
    for (let poll = 0; poll < MAX_STATUS_POLLS; poll += 1) {
      this.checkCancelled();
      const status = await this.status();
      await this.sleepPoll(status);
      const state = status[4];
      if (state === DFU_STATE_IDLE || state === DFU_STATE_MANIFEST_WAIT_RESET) {
        return;
      }
      if (state === DFU_STATE_ERROR) {
        throw new DfuError('DFU_DEVICE_ERROR', 'DFU manifestation failed.');
      }
    }
    throw new DfuError(
      'DFU_STATUS_TIMEOUT',
      'DFU manifestation did not complete in time.',
    );
  }

  async setAddress(address: number): Promise<void> {
    await this.command(Uint8Array.from([DFUSE_SET_ADDRESS, ...u32le(address)]));
    await this.waitForDownloadIdle();
  }

  async readUnprotect(): Promise<void> {
    await this.download(0, Uint8Array.from([DFUSE_READ_UNPROTECT]));
  }
}

function u32le(value: number): number[] {
  return [
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ];
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : 'Unknown WebUSB error.';
}

/** Chunked so a megabyte-scale image cannot overflow the argument stack. */
const ASCII_DECODE_CHUNK = 8192;

/**
 * Intel HEX is ASCII by specification, so this decodes it directly rather
 * than reaching for TextDecoder. Two reasons, in order: any byte outside
 * ASCII is not valid HEX and must reach parseIntelHex() as a character it
 * will reject, rather than being quietly repaired into U+FFFD by a UTF-8
 * decoder; and TextDecoder is absent from some non-browser environments,
 * which would make this path untestable for a dependency it does not need.
 */
function decodeAscii(bytes: Uint8Array): string {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += ASCII_DECODE_CHUNK) {
    text += String.fromCharCode(
      ...bytes.subarray(offset, offset + ASCII_DECODE_CHUNK),
    );
  }
  return text;
}

/* ------------------------------------------------------------------ *
 * Public surface
 * ------------------------------------------------------------------ */

/** Previously-authorized WebUSB devices ONLY. Never opens a chooser. */
export async function listDfuDevices(): Promise<DfuDeviceDescriptor[]> {
  const usb = usbApi();
  let devices: USBDevice[];
  try {
    devices = await usb.getDevices();
  } catch (reason) {
    throw new DfuError('DEVICE_ENUMERATION_FAILED', describe(reason));
  }
  const descriptors: DfuDeviceDescriptor[] = [];
  for (const device of devices) {
    if (!isSupportedDfuDevice(device)) {
      continue;
    }
    const descriptor = register(device);
    if (descriptor) {
      descriptors.push(descriptor);
    }
  }
  return descriptors;
}

/**
 * The ONLY path that may open the browser's WebUSB chooser. Must be called
 * from a user gesture. Resolves null when the operator dismissed it.
 */
export async function requestDfuDevice(): Promise<DfuDeviceDescriptor | null> {
  const usb = usbApi();
  let device: USBDevice;
  try {
    device = await usb.requestDevice({
      // Filtered to the bootloader identities this app supports, so the
      // chooser cannot offer an unrelated USB device to be flashed.
      filters: SUPPORTED_DFU_IDS.map(([vendorId, productId]) => ({
        vendorId,
        productId,
      })),
    });
  } catch (reason) {
    if (reason instanceof DOMException && reason.name === 'NotFoundError') {
      return null;
    }
    if (reason instanceof DOMException && reason.name === 'SecurityError') {
      throw new DfuError('PERMISSION_DENIED', describe(reason));
    }
    throw new DfuError('PERMISSION_REQUEST_FAILED', describe(reason));
  }
  const descriptor = register(device);
  if (!descriptor) {
    throw new DfuError(
      'DFU_INTERFACE_MISSING',
      'The selected device exposes no DFU interface.',
    );
  }
  return descriptor;
}

let cancelRequested = false;

/** Raises the cancellation flag every poll loop and transfer checks. */
export function cancelDfuFlash(): void {
  cancelRequested = true;
}

export type DfuProgressReporter = (progress: DfuFlashProgressEvent) => void;

/**
 * The full DfuSe flash: parse, validate against the device's own layout,
 * erase, write, READ BACK AND COMPARE, then manifest.
 *
 * The read-back pass is not optional and is not a debug aid. Without it
 * the only evidence of a successful write is the device's own status byte,
 * which reports the transfer, not the contents of flash.
 */
export async function flashDfuFirmware(
  deviceId: number,
  intelHexBytes: Uint8Array,
  fullErase: boolean,
  onProgress: DfuProgressReporter,
): Promise<void> {
  cancelRequested = false;
  const target = requireTarget(deviceId);

  let firmware: IntelHexImage;
  try {
    // The SAME strict parser the Android DFU and STM32-ROM paths use.
    firmware = parseIntelHex(decodeAscii(intelHexBytes));
  } catch (reason) {
    throw new DfuError('DFU_FIRMWARE_INVALID', describe(reason));
  }
  if (firmware.totalBytes === 0) {
    throw new DfuError('DFU_FIRMWARE_INVALID', 'The firmware image contains no data.');
  }

  const layoutText = target.memoryLayout;
  if (!layoutText) {
    throw new DfuError(
      'DFU_LAYOUT_MISSING',
      'DFU device did not expose a readable memory layout descriptor.',
    );
  }
  const layout = DfuMemoryLayout.parse(layoutText);

  // EVERY address is checked BEFORE the first erase. A firmware built for
  // a different target must not get as far as destroying the flash that is
  // already on the board.
  for (const segment of firmware.segments) {
    if (!layout.contains(segment.address, segment.data.length)) {
      throw new DfuError(
        'DFU_ADDRESS_OUT_OF_RANGE',
        `Firmware address 0x${segment.address.toString(16)} is outside the DFU memory layout.`,
      );
    }
  }

  const sectors = fullErase
    ? layout.sectors
    : dedupeByAddress(
        firmware.segments.flatMap(segment =>
          layout.sectorsOverlapping(segment.address, segment.data.length),
        ),
      );

  const total = firmware.totalBytes;
  const connection = await DfuConnection.open(target, () => cancelRequested);
  try {
    await connection.ensureIdle();

    /* ---- Erase: 0-20% ---- */
    onProgress({phase: 'erasing', percent: 0, bytesProcessed: 0, totalBytes: total});
    for (let index = 0; index < sectors.length; index += 1) {
      await connection.command(
        Uint8Array.from([DFUSE_ERASE, ...u32le(sectors[index].address)]),
      );
      await connection.waitForDownloadIdle();
      onProgress({
        phase: 'erasing',
        percent: Math.min(20, Math.floor(((index + 1) * 20) / Math.max(1, sectors.length))),
        bytesProcessed: 0,
        totalBytes: total,
      });
    }

    /* ---- Write: 20-75% ---- */
    const transferSize = DEFAULT_DFU_TRANSFER_SIZE;
    let written = 0;
    for (const segment of firmware.segments) {
      await connection.ensureIdle();
      await connection.setAddress(segment.address);
      // DfuSe data blocks start at 2; 0 and 1 are reserved for commands.
      let blockNumber = 2;
      let offset = 0;
      while (offset < segment.data.length) {
        const length = Math.min(transferSize, segment.data.length - offset);
        await connection.download(blockNumber, segment.data.subarray(offset, offset + length));
        await connection.waitForDownloadIdle();
        offset += length;
        written += length;
        blockNumber += 1;
        onProgress({
          phase: 'writing',
          percent: 20 + Math.floor((written * 55) / total),
          bytesProcessed: written,
          totalBytes: total,
        });
      }
    }

    /* ---- Read back and compare: 75-99% ---- */
    let verified = 0;
    for (const segment of firmware.segments) {
      await connection.ensureIdle();
      await connection.setAddress(segment.address);
      await connection.ensureIdle();
      let blockNumber = 2;
      let offset = 0;
      while (offset < segment.data.length) {
        const length = Math.min(transferSize, segment.data.length - offset);
        const actual = await connection.upload(blockNumber, length);
        if (actual.length !== length) {
          throw new DfuError('DFU_VERIFY_FAILED', 'DFU read-back returned a short block.');
        }
        for (let index = 0; index < actual.length; index += 1) {
          if (actual[index] !== segment.data[offset + index]) {
            throw new DfuError(
              'DFU_VERIFY_FAILED',
              `DFU read-back mismatch at 0x${(segment.address + offset + index).toString(16)}.`,
            );
          }
        }
        offset += length;
        verified += length;
        blockNumber += 1;
        onProgress({
          phase: 'verifying',
          percent: 75 + Math.floor((verified * 24) / total),
          bytesProcessed: verified,
          totalBytes: total,
        });
      }
    }

    /* ---- Manifest: 99% ---- *
     *
     * THE ~98% STALL THE OPERATOR REPORTED LIVES HERE. Read-back
     * verification occupies 75-99%, so a bar sitting near 98% has
     * finished neither verification nor manifestation - and until this
     * change NOTHING was emitted between the last verify block and
     * `complete`, so the UI went silent for the whole of the phase in
     * which the board actually resets. Each step below now announces
     * itself, so a stall names the operation it is stuck in instead of
     * looking like a frozen percentage.
     *
     * WebUSB LIMITATION, unchanged and deliberately not worked around:
     * controlTransferIn/controlTransferOut take no AbortSignal and cannot
     * be cancelled, so a pending transfer here can only be OBSERVED, never
     * interrupted. Nothing below retries an erase or a write. */
    onProgress({
      phase: 'finalizing',
      percent: 99,
      bytesProcessed: total,
      totalBytes: total,
    });
    await connection.ensureIdle();
    // DfuSe manifestation selects the beginning of the programmed image,
    // matching Betaflight Configurator. Intel HEX type-05 may carry a
    // reset-handler PC (including a Thumb bit), not a DfuSe base address.
    await connection.setAddress(firmware.segments[0].address);
    onProgress({
      phase: 'manifesting',
      percent: 99,
      bytesProcessed: total,
      totalBytes: total,
    });
    await connection.download(0, new Uint8Array(0));
    onProgress({
      phase: 'resetting',
      percent: 99,
      bytesProcessed: total,
      totalBytes: total,
    });
    try {
      await connection.waitForManifestation();
    } catch (error) {
      // A manifestation-tolerant device reports status; another resets
      // immediately and every further transfer fails. Only the second is
      // acceptable, and only when the device has genuinely gone.
      const wentAway = await connection.deviceWentAway();
      const code = error instanceof DfuError ? error.code : '';
      if (!((code === 'DFU_STATUS_FAILED' || code === 'DFU_TRANSFER_FAILED') && wentAway)) {
        throw error;
      }
    }
    onProgress({
      phase: 'complete',
      percent: 100,
      bytesProcessed: total,
      totalBytes: total,
    });
  } finally {
    await connection.release();
  }
}

/** Leaves DfuSe by selecting the application address then a zero-length DNLOAD. */
export async function exitDfuMode(deviceId: number): Promise<void> {
  const target = requireTarget(deviceId);
  const connection = await DfuConnection.open(target, () => false);
  try {
    // 0x08000000 - the STM32 application base, the same constant
    // DfuExitWorker.kt sends.
    await connection.command(Uint8Array.from([DFUSE_SET_ADDRESS, 0x00, 0x00, 0x00, 0x08]));
    const status = await connection.status().catch(() => null);
    if (status) {
      const reported = status[1] | (status[2] << 8) | (status[3] << 16);
      if (reported > 0) {
        await delay(Math.min(reported, MAX_SINGLE_POLL_DELAY_MS));
      }
    }
    try {
      await connection.download(0, new Uint8Array(0));
    } catch {
      // The board resetting into the application is the SUCCESS case here,
      // and it makes this very transfer fail. Only a device that is still
      // present has actually failed to leave DFU - so the rejection value
      // itself carries no information worth keeping.
      if (!(await connection.deviceWentAway())) {
        throw new DfuError(
          'DFU_EXIT_FAILED',
          'DFU manifestation request failed without a reset.',
        );
      }
    }
  } finally {
    await connection.release();
  }
}

/**
 * DfuSe read-unprotect. STM32 ROM erases protected flash and then resets,
 * so success is defined exactly as on Android: the command is accepted, the
 * device enters the busy erase state, and afterwards it has either returned
 * to idle or physically gone.
 */
export async function unprotectDfuDevice(deviceId: number): Promise<void> {
  const target = requireTarget(deviceId);
  const connection = await DfuConnection.open(target, () => false);
  try {
    await connection.readUnprotect();
    const initial = await connection.status().catch(() => null);
    if (!initial) {
      if (await connection.deviceWentAway()) {
        return;
      }
      throw new DfuError(
        'DFU_UNPROTECT_FAILED',
        'DFU did not enter the read-unprotect erase state.',
      );
    }
    if (initial[4] !== DFU_STATE_DNLOAD_BUSY) {
      throw new DfuError(
        'DFU_UNPROTECT_FAILED',
        `DFU rejected read-unprotect with state ${initial[4]} and status ${initial[0]}.`,
      );
    }
    const reported = initial[1] | (initial[2] << 8) | (initial[3] << 16);
    // The safety margin matches Betaflight's own: a mass erase that is
    // interrupted early leaves the board unbootable.
    await delay(Math.min(reported, MAX_REPORTED_ERASE_DELAY_MS) + ERASE_SAFETY_DELAY_MS);

    const final = await connection.status().catch(() => null);
    if (!final) {
      return;
    }
    if (await connection.deviceWentAway()) {
      return;
    }
    if (final[4] === DFU_STATE_IDLE || final[4] === DFU_STATE_MANIFEST_WAIT_RESET) {
      return;
    }
    throw new DfuError(
      'DFU_UNPROTECT_FAILED',
      'Read-unprotect completed its erase window but the device did not reset.',
    );
  } finally {
    await connection.release();
  }
}

function dedupeByAddress(sectors: readonly DfuSector[]): DfuSector[] {
  const seen = new Set<number>();
  const result: DfuSector[] = [];
  for (const sector of sectors) {
    if (!seen.has(sector.address)) {
      seen.add(sector.address);
      result.push(sector);
    }
  }
  return result;
}

/** Test seam only. Never called by the application. */
export function __resetWebUsbDfuForTests(): void {
  idByDevice.clear();
  targetById.clear();
  nextDfuOrdinal = 0;
  cancelRequested = false;
}
