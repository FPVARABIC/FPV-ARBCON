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
 * THE PLACES WebUSB IS GENUINELY WEAKER:
 *
 *   1. (CORRECTED by the memory-layout P0.) An earlier revision of this
 *      header claimed WebUSB exposes no raw descriptors and no
 *      wTransferSize. That claim was FALSE, and it was load-bearing in a
 *      real-hardware failure: a real flight controller enumerated with
 *      `alternate.interfaceName` unpopulated, this module trusted only
 *      that convenience property, and flashing died with "DFU device did
 *      not expose a readable memory layout descriptor" even though the
 *      device was advertising its layout the whole time. The pinned
 *      Betaflight Configurator (2025.12.2, webusbdfu.js) reads the RAW
 *      configuration descriptor and the interface STRING descriptors
 *      with ordinary standard GET_DESCRIPTOR control transfers on the
 *      opened device - getInterfaceDescriptor()/getString() there - and
 *      reads wTransferSize from the DFU functional descriptor the same
 *      way (getFunctionalDescriptor(), fallback 2048 ONLY when that
 *      read itself fails). This module now does the same: see
 *      discoverDfuMemory() below. The 2048 default remains exactly as
 *      Betaflight's read-failure fallback, never a substitute for a
 *      readable descriptor.
 *
 *   2. NO DEVICE-LIST POLLING. Android resolves the "did it manifest, or
 *      did it just reset?" ambiguity by re-reading UsbManager.deviceList
 *      and checking whether the same identity is still attached. In a
 *      browser the equivalent evidence is that the USBDevice's connection
 *      has gone: after a reset, transfers throw NotFoundError /
 *      NetworkError and `device.opened` goes false. That is what is
 *      checked here, and it is weaker evidence - see deviceWentAway().
 *
 *   3. NO CONTROL-TRANSFER TIMEOUT. WebUSB has no timeout parameter and
 *      no AbortSignal, so a wedged device leaves a transfer promise
 *      pending FOREVER - the deterministic reproduction in
 *      .dev-preview/audit/flasher-p0 proved a single such transfer held
 *      the whole flash promise with zero timers remaining, which is the
 *      "98% forever" the operator reported. The poll loops' iteration
 *      caps bound only COMPLETED iterations and never engage on a pending
 *      one. Every transfer await here is therefore wrapped in a bounded
 *      OBSERVATION window (DFU_TRANSFER_DEADLINE_MS): when the window is
 *      exceeded the attempt is FROZEN and classified truthfully
 *      (classifyDfuOverrun), the device session is marked poisoned so no
 *      further destructive command can be issued against it, and the
 *      still-pending browser transfer is left alone - it cannot be
 *      cancelled, it is never retried, and its late settlement is
 *      deliberately inert. Android needs none of this: its every
 *      controlTransfer carries CONTROL_TIMEOUT_MS = 5000.
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
import {
  DFU_CODE_SESSION_POISONED,
  DFU_CODE_UNCONFIRMED_MANIFEST,
  classifyDfuOverrun,
} from '../../../../core/firmware-flasher/flashCompletionModel';
import type {DfuFlashStage} from '../../../../core/firmware-flasher/flashCompletionModel';
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

/* Standard USB descriptor machinery for the raw reads discoverDfuMemory()
 * performs - the same requests Betaflight's webusbdfu.js issues. */
const USB_REQUEST_GET_DESCRIPTOR = 6;
const USB_DESCRIPTOR_CONFIGURATION = 0x02;
const USB_DESCRIPTOR_STRING = 0x03;
const USB_DESCRIPTOR_INTERFACE = 0x04;
const USB_DESCRIPTOR_DFU_FUNCTIONAL = 0x21;

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
 * Bounded observation of unbounded WebUSB transfers
 * ------------------------------------------------------------------ */

/**
 * How long each stage's transfers are OBSERVED before the attempt is
 * frozen. These are observation windows, not protocol timeouts: nothing
 * is cancelled and nothing is retried when one closes.
 *
 * Two constraints picked every number. Each window sits ABOVE the UI's
 * advisory stall threshold for its phase (flashPhaseModel.ts: ERASING
 * 30s, WRITING/VERIFYING 15s, MANIFESTING/RESETTING 40s), so the operator
 * always sees the honest "stalled" notice before the attempt settles.
 * And each sits above the device's own legitimate worst case - a full
 * bank erase can hold GETSTATUS hostage for tens of seconds on some
 * bootloaders, which is why ERASE gets the longest window.
 */
export const DFU_TRANSFER_DEADLINE_MS: Readonly<Record<DfuFlashStage, number>> =
  Object.freeze({
    OPEN: 15_000,
    ERASE: 60_000,
    WRITE: 30_000,
    VERIFY: 30_000,
    FINALIZE: 45_000,
    MANIFEST: 60_000,
  });

/** Cleanup and presence probes get short windows of their own: they are
 * non-destructive, and a frozen attempt must not be held open by them. */
export const DFU_RELEASE_DEADLINE_MS = 5_000;
export const DFU_PRESENCE_PROBE_DEADLINE_MS = 2_000;

/** Internal: a transfer outlived its observation window. Never leaves
 * this module - flashDfuFirmware converts it into a truthful verdict. */
class DfuPendingTransferOverrun extends Error {
  constructor(
    readonly op: string,
    readonly deadlineMs: number,
  ) {
    super(`WebUSB ${op} still pending after ${deadlineMs}ms.`);
    this.name = 'DfuPendingTransferOverrun';
  }
}

const OVERRUN = Symbol('dfu-transfer-overrun');

/**
 * Awaits `work` for at most `deadlineMs`. On overrun the still-pending
 * promise is given no-op handlers - its late settlement must neither
 * throw unhandled nor do anything else, because the attempt it belonged
 * to is already terminally classified - and DfuPendingTransferOverrun is
 * thrown for the caller to classify. A settlement that wins the race
 * (either way) passes through untouched.
 */
async function awaitBounded<T>(
  work: Promise<T>,
  op: string,
  deadlineMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raced = await Promise.race([
      work,
      new Promise<typeof OVERRUN>(resolve => {
        timer = setTimeout(() => resolve(OVERRUN), deadlineMs);
      }),
    ]);
    if (raced === OVERRUN) {
      work.then(
        () => undefined,
        () => undefined,
      );
      throw new DfuPendingTransferOverrun(op, deadlineMs);
    }
    return raced as T;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Devices with a transfer left pending against them. A WebUSB session
 * that swallowed a transfer is POISONED: issuing further DFU commands
 * against it would race an operation the browser can neither cancel nor
 * report on, so every entry point refuses until the operator unplugs and
 * replugs the board - a replug enumerates a NEW USBDevice object, which
 * is exactly the "new device state" a safe fresh attempt needs. (A
 * successful post-manifestation reset also re-enumerates a new object,
 * so a poisoned SUCCESS never blocks the next flash.)
 */
let poisonedDevices = new WeakMap<USBDevice, string>();

function poisonDevice(device: USBDevice, pendingOp: string): void {
  if (!poisonedDevices.has(device)) {
    poisonedDevices.set(device, pendingOp);
  }
}

function assertSessionNotPoisoned(device: USBDevice): void {
  const pendingOp = poisonedDevices.get(device);
  if (pendingOp !== undefined) {
    throw new DfuError(
      DFU_CODE_SESSION_POISONED,
      `A WebUSB transfer (${pendingOp}) from a previous attempt is still pending against this device session. Unplug the board, plug it back in, and select it again.`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Memory layout - a direct port of DfuMemoryLayout.kt, extended with the
 * DfuSe per-group permission flags (ST UM0424): the trailing letter of
 * each sector group encodes readable/erasable/writable as bits 0/1/2 of
 * (letter - 'a' + 1). 'a' = readable, 'e' = readable+writable,
 * 'g' = readable+erasable+writable. A group WITHOUT a flag letter is
 * treated as fully accessible - deliberately matching the pinned
 * Betaflight Configurator, whose parser never reads the flags at all, so
 * a quirky bootloader Betaflight can flash is not refused here for
 * omitting a letter. A PRESENT flag is honoured strictly: option-byte
 * regions marked 'e' (not erasable) are excluded from erase planning and
 * their sectors never count as flash-writable space.
 * ------------------------------------------------------------------ */

export type DfuSector = {
  readonly address: number;
  readonly sizeBytes: number;
  readonly readable: boolean;
  readonly erasable: boolean;
  readonly writable: boolean;
};

const REGION_PATTERN = /\/(0x[0-9a-fA-F]+)\/([^/@]+)/g;
const SECTOR_PATTERN = /^\s*(\d+)\s*\*\s*(\d+)\s*([bBkKmM]?)\s*([a-gA-G]?)\s*$/;

/**
 * Known-broken bootloader strings, corrected EXACTLY as the pinned
 * Betaflight Configurator corrects them (webusbdfu.js parseDescriptor,
 * 2025.12.2) - each conditioned on the exact broken string so nothing
 * else is ever rewritten:
 *  - early SPRacing H7 EXST bootloaders advertise a layout whose group
 *    arithmetic does not match the hardware;
 *  - AT32F43x bootloaders misname their option-byte region.
 */
const KNOWN_DESCRIPTOR_CORRECTIONS: ReadonlyArray<readonly [string, string]> = [
  [
    '@External Flash /0x90000000/1001*128Kg,3*128Kg,20*128Ka',
    '@External Flash /0x90000000/998*128Kg,1*128Kg,4*128Kg,21*128Ka',
  ],
  ['@Option byte   /0x1FFFC000/01*4096 g', '@Option bytes   /0x1FFFC000/01*4096 g'],
  ['@Option byte   /0x1FFFC000/01*512 g', '@Option bytes   /0x1FFFC000/01*512 g'],
];

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

  /** True when [address, address+length) is fully covered by WRITABLE sectors. */
  containsWritable(address: number, length: number): boolean {
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
      if (!sector || !sector.writable) {
        return false;
      }
      cursor = Math.min(end, sector.address + sector.sizeBytes);
    }
    return true;
  }

  /** At least one sector may be written - the minimum for a flash target. */
  get hasWritableSectors(): boolean {
    return this.sectors.some(sector => sector.writable);
  }

  /**
   * Parses a DfuSe memory descriptor such as
   * `@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg`.
   */
  static parse(descriptor: string): DfuMemoryLayout {
    // Strip anything outside printable ASCII first: some bootloaders pad
    // the string descriptor with NULs, which would otherwise land inside a
    // sector token and fail the pattern for a reason nobody could read.
    let printable = Array.from(descriptor)
      .filter(character => {
        const code = character.charCodeAt(0);
        return code >= 0x20 && code <= 0x7e;
      })
      .join('');
    for (const [broken, corrected] of KNOWN_DESCRIPTOR_CORRECTIONS) {
      if (printable.trim() === broken) {
        printable = corrected;
      }
    }
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
        // The DfuSe permission letter (see the section comment). Absent =
        // fully accessible, exactly as permissive as the pinned Betaflight
        // parser which never decodes the letter at all.
        const flagLetter = match[4].toLowerCase();
        const flagBits = flagLetter === '' ? 0b111 : flagLetter.charCodeAt(0) - 96;
        const readable = (flagBits & 0b001) !== 0;
        const erasable = (flagBits & 0b010) !== 0;
        const writable = (flagBits & 0b100) !== 0;
        for (let index = 0; index < count; index += 1) {
          sectors.push({address, sizeBytes: size, readable, erasable, writable});
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
  /**
   * The stage the flash is currently in, set by flashDfuFirmware as it
   * advances. Chooses the observation window for every transfer, and is
   * the first fact classifyDfuOverrun reads when one overruns.
   */
  stage: DfuFlashStage = 'OPEN';
  /** The exact operation left pending when an overrun froze the attempt. */
  pendingOp: string | undefined;

  constructor(
    private readonly device: USBDevice,
    private interfaceNumber: number,
    private readonly isCancelled: () => boolean,
  ) {}

  /**
   * DFU class requests route by wIndex = interface number. When discovery
   * claims a DIFFERENT interface than the one open() claimed (legal per
   * the DFU spec even though ST bootloaders always use interface 0), every
   * subsequent class transfer must target the newly claimed interface or
   * the requests would be addressed to an interface the flash no longer
   * runs on.
   */
  rebindInterface(interfaceNumber: number): void {
    this.interfaceNumber = interfaceNumber;
  }

  private async bounded<T>(work: Promise<T>, op: string): Promise<T> {
    try {
      return await awaitBounded(work, op, DFU_TRANSFER_DEADLINE_MS[this.stage]);
    } catch (error) {
      if (error instanceof DfuPendingTransferOverrun) {
        this.pendingOp = op;
        poisonDevice(this.device, op);
      }
      throw error;
    }
  }

  static async open(
    target: DfuTarget,
    isCancelled: () => boolean,
  ): Promise<DfuConnection> {
    const {device, interfaceNumber, alternateSetting} = target;
    const connection = new DfuConnection(device, interfaceNumber, isCancelled);
    try {
      if (!device.opened) {
        await connection.bounded(device.open(), 'open()');
      }
    } catch (reason) {
      if (reason instanceof DfuPendingTransferOverrun) {
        throw new DfuError('DFU_OPEN_FAILED', reason.message);
      }
      throw new DfuError('DFU_OPEN_FAILED', describe(reason));
    }
    try {
      if (device.configuration === null) {
        await connection.bounded(device.selectConfiguration(1), 'selectConfiguration(1)');
      }
      await connection.bounded(device.claimInterface(interfaceNumber), 'claimInterface');
      // DfuSe puts each memory region on its own alternate setting; the
      // wrong one silently addresses option bytes instead of flash.
      await connection.bounded(
        device.selectAlternateInterface(interfaceNumber, alternateSetting),
        'selectAlternateInterface',
      );
    } catch (reason) {
      await device.close().catch(() => undefined);
      if (reason instanceof DfuPendingTransferOverrun) {
        throw new DfuError('DFU_CLAIM_FAILED', reason.message);
      }
      throw new DfuError('DFU_CLAIM_FAILED', describe(reason));
    }
    return connection;
  }

  async release(): Promise<void> {
    // Best-effort AND bounded: after a successful manifestation the
    // device has already reset and these calls throw - expected, not a
    // failure. Against a wedged device they can also HANG, and this
    // method sits on every exit path, so an unbounded await here would
    // hold an already-classified attempt open forever. On overrun the
    // pending cleanup is simply abandoned; it issues no DFU command.
    try {
      await awaitBounded(
        this.device
          .releaseInterface(this.interfaceNumber)
          .catch(() => undefined)
          .then(() => this.device.close())
          .catch(() => undefined),
        'release()',
        DFU_RELEASE_DEADLINE_MS,
      );
    } catch {
      // DfuPendingTransferOverrun only - swallowed by design.
    }
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
      // Bounded: this probe decides whether a frozen manifestation may
      // count as completion, and it must not itself pend forever. An
      // unanswerable probe reports PRESENT - the conservative answer,
      // because "gone" is completion evidence and "present" never is.
      const devices = await awaitBounded(
        navigator.usb.getDevices(),
        'getDevices() presence probe',
        DFU_PRESENCE_PROBE_DEADLINE_MS,
      );
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
      result = await this.bounded(
        this.device.controlTransferOut(
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
        ),
        `DNLOAD(block=${blockNumber}, length=${data.length})`,
      );
    } catch (reason) {
      if (reason instanceof DfuPendingTransferOverrun) {
        throw reason;
      }
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
      result = await this.bounded(
        this.device.controlTransferIn(
          {
            requestType: 'class',
            recipient: 'interface',
            request: DFU_UPLOAD,
            value: blockNumber,
            index: this.interfaceNumber,
          },
          length,
        ),
        `UPLOAD(block=${blockNumber}, length=${length})`,
      );
    } catch (reason) {
      if (reason instanceof DfuPendingTransferOverrun) {
        throw reason;
      }
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
      result = await this.bounded(
        this.device.controlTransferIn(
          {
            requestType: 'class',
            recipient: 'interface',
            request: DFU_GETSTATUS,
            value: 0,
            index: this.interfaceNumber,
          },
          6,
        ),
        'GETSTATUS',
      );
    } catch (reason) {
      if (reason instanceof DfuPendingTransferOverrun) {
        throw reason;
      }
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
      const result = await this.bounded(
        this.device.controlTransferOut({
          requestType: 'class',
          recipient: 'interface',
          request,
          value: 0,
          index: this.interfaceNumber,
        }),
        request === DFU_CLRSTATUS ? 'CLRSTATUS' : 'ABORT',
      );
      if (result.status !== 'ok') {
        throw new Error(`status ${result.status}`);
      }
    } catch (reason) {
      if (reason instanceof DfuPendingTransferOverrun) {
        throw reason;
      }
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

  /* ---- Standard GET_DESCRIPTOR reads on the OPENED device ----
   *
   * The exact mechanism the pinned Betaflight Configurator uses
   * (webusbdfu.js getInterfaceDescriptor/getString/getFunctionalDescriptor,
   * 2025.12.2): ordinary standard control transfers, which work on every
   * DfuSe bootloader regardless of whether the browser chose to populate
   * the WebUSB convenience properties. All bounded under the current
   * stage's observation window like every other transfer here. */

  async readConfigurationDescriptorBlob(): Promise<Uint8Array> {
    const header = await this.standardIn(USB_DESCRIPTOR_CONFIGURATION << 8, 9, 'GET_DESCRIPTOR(config header)');
    if (header.length < 4) {
      throw new DfuError('DFU_DESCRIPTOR_READ_FAILED', 'Configuration descriptor header was short.');
    }
    const totalLength = header[2] | (header[3] << 8);
    if (totalLength < 9 || totalLength > 4096) {
      throw new DfuError('DFU_DESCRIPTOR_READ_FAILED', `Configuration descriptor length ${totalLength} is not plausible.`);
    }
    const blob = await this.standardIn(USB_DESCRIPTOR_CONFIGURATION << 8, totalLength, 'GET_DESCRIPTOR(configuration)');
    if (blob.length < totalLength) {
      throw new DfuError('DFU_DESCRIPTOR_READ_FAILED', 'Configuration descriptor read returned fewer bytes than declared.');
    }
    return blob;
  }

  async readStringDescriptor(index: number): Promise<string> {
    if (index === 0) {
      return '';
    }
    // Language id table first (index 0), then the string itself in the
    // first advertised language - Betaflight passes langid 0 and relies on
    // bootloader leniency; asking with the device's own first langid works
    // on those same bootloaders and on stricter ones.
    let langId = 0x0409;
    try {
      const table = await this.standardIn(USB_DESCRIPTOR_STRING << 8, 255, 'GET_DESCRIPTOR(langids)');
      if (table.length >= 4) {
        langId = table[2] | (table[3] << 8);
      }
    } catch {
      // Keep the en-US default; the string read below decides the outcome.
    }
    const raw = await this.standardIn((USB_DESCRIPTOR_STRING << 8) | index, 255, `GET_DESCRIPTOR(string ${index})`, langId);
    // [bLength, bDescriptorType, UTF-16LE payload...]
    let text = '';
    const limit = Math.min(raw.length, raw[0] ?? raw.length);
    for (let offset = 2; offset + 1 < limit; offset += 2) {
      text += String.fromCharCode(raw[offset] | (raw[offset + 1] << 8));
    }
    return text;
  }

  private async standardIn(
    value: number,
    length: number,
    op: string,
    index = 0,
  ): Promise<Uint8Array> {
    let result: USBInTransferResult;
    try {
      result = await this.bounded(
        this.device.controlTransferIn(
          {
            requestType: 'standard',
            recipient: 'device',
            request: USB_REQUEST_GET_DESCRIPTOR,
            value,
            index,
          },
          length,
        ),
        op,
      );
    } catch (reason) {
      if (reason instanceof DfuPendingTransferOverrun) {
        throw reason;
      }
      throw new DfuError('DFU_DESCRIPTOR_READ_FAILED', describe(reason));
    }
    if (result.status !== 'ok' || !result.data) {
      throw new DfuError('DFU_DESCRIPTOR_READ_FAILED', `${op} returned status ${result.status}.`);
    }
    return new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
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

/* ------------------------------------------------------------------ *
 * DFU memory discovery - the real-hardware P0 correction.
 *
 * WHY THIS EXISTS. register() snapshots `alternate.interfaceName` from
 * the UNOPENED device because that is what lets listDfuDevices() report
 * a layout without claiming anything. A real flight controller
 * enumerated with that property empty, and the flash refused with
 * "DFU device did not expose a readable memory layout descriptor" while
 * the device was advertising its layout in its string descriptors the
 * whole time. The pinned Betaflight Configurator never trusts the
 * convenience property: it reads the raw configuration descriptor and
 * every alternate's string descriptor off the OPENED device and then
 * picks the region NAMED Internal Flash (falling back to External
 * Flash). discoverDfuMemory() is that algorithm, with the flag-aware
 * parser and an explicit error taxonomy on top.
 * ------------------------------------------------------------------ */

export type DfuAlternateCandidate = {
  readonly interfaceNumber: number;
  readonly alternateSetting: number;
  readonly interfaceClass: number;
  readonly interfaceSubclass: number;
  readonly interfaceProtocol: number;
  readonly stringIndex: number;
};

export type DfuConfigDescriptorSummary = {
  readonly candidates: readonly DfuAlternateCandidate[];
  /** wTransferSize from the DFU functional descriptor, when present. */
  readonly transferSize?: number;
};

/**
 * Walks a raw configuration-descriptor blob. Length-prefix driven, so
 * endpoint descriptors, class-specific blocks and vendor extensions are
 * skipped correctly instead of assumed absent (the pinned Betaflight
 * implementation uses fixed 9-byte offsets, which happens to work on ST
 * bootloaders; walking properly costs nothing and survives devices that
 * interleave other descriptors).
 */
export function parseConfigurationDescriptorBlob(
  blob: Uint8Array,
): DfuConfigDescriptorSummary {
  const candidates: DfuAlternateCandidate[] = [];
  let transferSize: number | undefined;
  let offset = 0;
  while (offset + 2 <= blob.length) {
    const length = blob[offset];
    const type = blob[offset + 1];
    if (length < 2 || offset + length > blob.length) {
      break;
    }
    if (type === USB_DESCRIPTOR_INTERFACE && length >= 9) {
      const interfaceClass = blob[offset + 5];
      const interfaceSubclass = blob[offset + 6];
      if (
        interfaceClass === DFU_INTERFACE_CLASS &&
        interfaceSubclass === DFU_INTERFACE_SUBCLASS
      ) {
        candidates.push({
          interfaceNumber: blob[offset + 2],
          alternateSetting: blob[offset + 3],
          interfaceClass,
          interfaceSubclass,
          interfaceProtocol: blob[offset + 7],
          stringIndex: blob[offset + 8],
        });
      }
    } else if (type === USB_DESCRIPTOR_DFU_FUNCTIONAL && length >= 9) {
      // DFU functional descriptor: bmAttributes(1) wDetachTimeOut(2)
      // wTransferSize(2) bcdDFUVersion(2) after the 2-byte header.
      const size = blob[offset + 5] | (blob[offset + 6] << 8);
      if (size > 0) {
        transferSize = size;
      }
    }
    offset += length;
  }
  return {candidates, transferSize};
}

export type DfuDiscoveredMemory = {
  readonly interfaceNumber: number;
  readonly alternateSetting: number;
  readonly layout: DfuMemoryLayout;
  readonly layoutText: string;
  readonly transferSize?: number;
};

export type DfuDiscoveryDiagnostics = {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName?: string;
  readonly manufacturerName?: string;
  readonly configurationValue?: number;
  readonly candidates: ReadonlyArray<{
    readonly interfaceNumber: number;
    readonly alternateSetting: number;
    readonly interfaceProtocol: number;
    readonly stringIndex: number;
    readonly descriptorText?: string;
    readonly parse: 'ok' | 'empty' | 'invalid';
    readonly parseError?: string;
    readonly regionName?: string;
    readonly writable?: boolean;
  }>;
  readonly transferSize?: number;
  readonly chosen?: {
    readonly interfaceNumber: number;
    readonly alternateSetting: number;
    readonly regionName: string;
  };
  readonly failureCode?: string;
};

/**
 * Developer diagnostics for the LAST discovery attempt - the record §21
 * of the P0 brief asks for, kept out of the operator UI. Read it from
 * the console (or a future diagnostics panel) after a failure to know
 * exactly which configuration/interface/alternate/string was seen.
 */
let lastDfuDiscoveryDiagnostics: DfuDiscoveryDiagnostics | undefined;
export function getLastDfuDiscoveryDiagnostics(): DfuDiscoveryDiagnostics | undefined {
  return lastDfuDiscoveryDiagnostics;
}

/** Region-name normalization for evidence-based selection. */
function normalizedRegionName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Reads every DFU alternate's memory descriptor off the OPENED device and
 * chooses the flash target by the same evidence Betaflight uses:
 * the region NAMED "Internal Flash", else "External Flash", else - going
 * one honest step further than Betaflight - the only writable parsed
 * candidate when the names are nonstandard. Vendor and board names play
 * no part. Every dead end throws its own taxonomy code.
 */
async function discoverDfuMemory(
  connection: DfuConnection,
  device: USBDevice,
  claimedInterfaceNumber: number,
): Promise<DfuDiscoveredMemory> {
  const diagnosticsCandidates: Array<DfuDiscoveryDiagnostics['candidates'][number]> = [];
  const finish = (
    failureCode: string | undefined,
    chosen?: DfuDiscoveredMemory,
    transferSize?: number,
  ): void => {
    lastDfuDiscoveryDiagnostics = {
      vendorId: device.vendorId,
      productId: device.productId,
      productName: device.productName ?? undefined,
      manufacturerName: device.manufacturerName ?? undefined,
      configurationValue: device.configuration?.configurationValue,
      candidates: diagnosticsCandidates,
      transferSize,
      ...(chosen
        ? {
            chosen: {
              interfaceNumber: chosen.interfaceNumber,
              alternateSetting: chosen.alternateSetting,
              regionName: chosen.layout.name,
            },
          }
        : {}),
      ...(failureCode ? {failureCode} : {}),
    };
  };

  const blob = await connection.readConfigurationDescriptorBlob();
  const summary = parseConfigurationDescriptorBlob(blob);
  if (summary.candidates.length === 0) {
    finish('DFU_INTERFACE_NOT_FOUND');
    throw new DfuError(
      'DFU_INTERFACE_NOT_FOUND',
      'The configuration descriptor exposes no DFU-class interface.',
    );
  }

  type Parsed = {
    readonly candidate: DfuAlternateCandidate;
    readonly text: string;
    readonly layout: DfuMemoryLayout;
  };
  const parsed: Parsed[] = [];
  let sawAnyText = false;
  for (const candidate of summary.candidates) {
    let text = '';
    let entry: DfuDiscoveryDiagnostics['candidates'][number];
    try {
      text = await connection.readStringDescriptor(candidate.stringIndex);
    } catch {
      // An unreadable string is recorded and the candidate skipped; the
      // taxonomy below reports MISSING only if nothing anywhere read.
    }
    if (text.trim().length === 0) {
      entry = {
        interfaceNumber: candidate.interfaceNumber,
        alternateSetting: candidate.alternateSetting,
        interfaceProtocol: candidate.interfaceProtocol,
        stringIndex: candidate.stringIndex,
        parse: 'empty',
      };
    } else {
      sawAnyText = true;
      try {
        const layout = DfuMemoryLayout.parse(text);
        parsed.push({candidate, text, layout});
        entry = {
          interfaceNumber: candidate.interfaceNumber,
          alternateSetting: candidate.alternateSetting,
          interfaceProtocol: candidate.interfaceProtocol,
          stringIndex: candidate.stringIndex,
          descriptorText: text,
          parse: 'ok',
          regionName: layout.name,
          writable: layout.hasWritableSectors,
        };
      } catch (reason) {
        entry = {
          interfaceNumber: candidate.interfaceNumber,
          alternateSetting: candidate.alternateSetting,
          interfaceProtocol: candidate.interfaceProtocol,
          stringIndex: candidate.stringIndex,
          descriptorText: text,
          parse: 'invalid',
          parseError: describe(reason),
        };
      }
    }
    diagnosticsCandidates.push(entry);
  }

  if (parsed.length === 0) {
    const code = sawAnyText ? 'DFU_MEMORY_LAYOUT_INVALID' : 'DFU_MEMORY_LAYOUT_MISSING';
    finish(code, undefined, summary.transferSize);
    throw new DfuError(
      code,
      sawAnyText
        ? 'Every DFU alternate advertised a memory descriptor this parser could not understand.'
        : 'No DFU alternate exposed a readable memory layout string descriptor.',
    );
  }

  // Selection by protocol evidence, in Betaflight's own order.
  const byName = (wanted: string): Parsed | undefined =>
    parsed.find(item => normalizedRegionName(item.layout.name) === wanted);
  let chosen = byName('internal flash') ?? byName('external flash');
  if (!chosen) {
    const writable = parsed.filter(item => item.layout.hasWritableSectors);
    if (writable.length === 1) {
      chosen = writable[0];
    } else if (writable.length === 0) {
      finish('DFU_MEMORY_LAYOUT_NOT_WRITABLE', undefined, summary.transferSize);
      throw new DfuError(
        'DFU_MEMORY_LAYOUT_NOT_WRITABLE',
        'No DFU alternate advertises writable flash sectors.',
      );
    } else {
      finish('DFU_FLASH_ALTERNATE_NOT_FOUND', undefined, summary.transferSize);
      throw new DfuError(
        'DFU_FLASH_ALTERNATE_NOT_FOUND',
        `Multiple writable DFU regions with nonstandard names (${writable
          .map(item => item.layout.name)
          .join(', ')}); refusing to guess the flash target.`,
      );
    }
  }
  if (!chosen.layout.hasWritableSectors) {
    finish('DFU_MEMORY_LAYOUT_NOT_WRITABLE', undefined, summary.transferSize);
    throw new DfuError(
      'DFU_MEMORY_LAYOUT_NOT_WRITABLE',
      `The ${chosen.layout.name} region advertises no writable sectors.`,
    );
  }

  // Bind the bus to the chosen region: re-claim only when the interface
  // genuinely differs, re-select the alternate when it differs. DfuSe
  // routes by absolute address, but UPLOAD/DNLOAD default to the selected
  // alternate's region - the read-back MUST run against the same one.
  if (chosen.candidate.interfaceNumber !== claimedInterfaceNumber) {
    try {
      await device.claimInterface(chosen.candidate.interfaceNumber);
    } catch (reason) {
      finish('DFU_INTERFACE_CLAIM_FAILED', undefined, summary.transferSize);
      throw new DfuError('DFU_INTERFACE_CLAIM_FAILED', describe(reason));
    }
    connection.rebindInterface(chosen.candidate.interfaceNumber);
  }
  try {
    await device.selectAlternateInterface(
      chosen.candidate.interfaceNumber,
      chosen.candidate.alternateSetting,
    );
  } catch (reason) {
    finish('DFU_ALTERNATE_SELECTION_FAILED', undefined, summary.transferSize);
    throw new DfuError('DFU_ALTERNATE_SELECTION_FAILED', describe(reason));
  }

  const result: DfuDiscoveredMemory = {
    interfaceNumber: chosen.candidate.interfaceNumber,
    alternateSetting: chosen.candidate.alternateSetting,
    layout: chosen.layout,
    layoutText: chosen.text,
    ...(summary.transferSize !== undefined ? {transferSize: summary.transferSize} : {}),
  };
  finish(undefined, result, summary.transferSize);
  return result;
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
  // A session with a transfer already pending must never be flashed
  // again: the new attempt's commands would race an operation the
  // browser can neither cancel nor observe. Replugging the board
  // enumerates a fresh USBDevice and clears this naturally.
  assertSessionNotPoisoned(target.device);

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

  /**
   * LAYOUT RESOLUTION - two sources, one truth.
   *
   * Fast path: the registry snapshot taken from WebUSB's
   * `alternate.interfaceName` at enumeration time. When the browser
   * populated it, it IS the device's own string descriptor, and it can
   * be validated without any extra bus traffic.
   *
   * Deep path (the real-hardware P0 correction): when the snapshot is
   * absent, unparseable, or does not cover the firmware, the layout is
   * read from the OPENED device exactly the way the pinned Betaflight
   * Configurator reads it - raw configuration descriptor, every DFU
   * alternate's string descriptor, evidence-based region choice
   * (discoverDfuMemory above). Only after BOTH sources fail may the
   * flash refuse for lack of a layout - and then with the taxonomy code
   * describing what was actually seen, never a blind fallback address.
   */
  let snapshotLayout: DfuMemoryLayout | undefined;
  if (target.memoryLayout) {
    try {
      snapshotLayout = DfuMemoryLayout.parse(target.memoryLayout);
    } catch {
      snapshotLayout = undefined;
    }
  }
  const snapshotCoversFirmware =
    snapshotLayout !== undefined &&
    firmware.segments.every(segment =>
      snapshotLayout.containsWritable(segment.address, segment.data.length),
    );

  const total = firmware.totalBytes;
  const connection = await DfuConnection.open(target, () => cancelRequested);

  let layout: DfuMemoryLayout;
  let transferSize = DEFAULT_DFU_TRANSFER_SIZE;
  try {
    if (snapshotLayout !== undefined && snapshotCoversFirmware) {
      layout = snapshotLayout;
      // §15: honour the device's advertised wTransferSize even on the
      // fast path. Fallback to 2048 happens ONLY when the descriptor
      // read itself fails - the exact condition under which the pinned
      // Betaflight Configurator falls back (webusbdfu.js, getFunctional-
      // Descriptor resultCode path).
      try {
        const summary = parseConfigurationDescriptorBlob(
          await connection.readConfigurationDescriptorBlob(),
        );
        if (summary.transferSize !== undefined) {
          transferSize = summary.transferSize;
        }
      } catch {
        // Betaflight-documented fallback: keep DEFAULT_DFU_TRANSFER_SIZE.
      }
    } else {
      try {
        const discovered = await discoverDfuMemory(
          connection,
          target.device,
          target.interfaceNumber,
        );
        layout = discovered.layout;
        if (discovered.transferSize !== undefined) {
          transferSize = discovered.transferSize;
        }
      } catch (discoveryError) {
        const code = discoveryError instanceof DfuError ? discoveryError.code : '';
        if (code !== 'DFU_DESCRIPTOR_READ_FAILED') {
          throw discoveryError;
        }
        if (snapshotLayout !== undefined) {
          // The bus refused standard descriptor reads - unusual, but the
          // snapshot is still the device's own earlier string. Validate
          // against it and let the segment checks below tell the truth
          // (this is how an out-of-range firmware still reports
          // DFU_ADDRESS_OUT_OF_RANGE rather than a descriptor error).
          layout = snapshotLayout;
        } else {
          throw new DfuError(
            'DFU_LAYOUT_MISSING',
            'DFU device did not expose a readable memory layout descriptor: WebUSB reported no interface name and standard descriptor reads failed.',
          );
        }
      }
    }

    // EVERY address is checked BEFORE the first erase - and against the
    // WRITABLE map specifically. A firmware built for a different target,
    // or aimed at a read-only region, must not get as far as destroying
    // the flash that is already on the board.
    for (const segment of firmware.segments) {
      if (!layout.contains(segment.address, segment.data.length)) {
        throw new DfuError(
          'DFU_ADDRESS_OUT_OF_RANGE',
          `Firmware address 0x${segment.address.toString(16)} is outside the ${layout.name} layout.`,
        );
      }
      if (!layout.containsWritable(segment.address, segment.data.length)) {
        throw new DfuError(
          'DFU_MEMORY_LAYOUT_NOT_WRITABLE',
          `Firmware address 0x${segment.address.toString(16)} falls in a non-writable ${layout.name} sector.`,
        );
      }
    }
  } catch (resolutionError) {
    // Nothing destructive has been issued; release the bus and let the
    // truthful taxonomy error reach the screen.
    await connection.release();
    throw resolutionError;
  }

  const sectors = fullErase
    ? layout.sectors.filter(sector => sector.erasable)
    : dedupeByAddress(
        firmware.segments.flatMap(segment =>
          layout.sectorsOverlapping(segment.address, segment.data.length),
        ),
      );
  const nonErasable = sectors.find(sector => !sector.erasable);
  if (nonErasable !== undefined) {
    await connection.release();
    throw new DfuError(
      'DFU_MEMORY_LAYOUT_NOT_WRITABLE',
      `Sector at 0x${nonErasable.address.toString(16)} is not erasable; refusing a write that could not be completed.`,
    );
  }

  /* Completion evidence, gathered as the attempt advances. When a
   * transfer overruns its observation window this - and nothing else -
   * decides the truthful verdict. */
  let written = 0;
  let verified = 0;
  let manifestationRequested = false;

  const complete = () =>
    onProgress({
      phase: 'complete',
      percent: 100,
      bytesProcessed: total,
      totalBytes: total,
    });

  try {
    connection.stage = 'ERASE';
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
    connection.stage = 'WRITE';
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
        // Counted only AFTER download-idle acknowledged the block:
        // "written" means confirmed landed, not merely transferred.
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
    connection.stage = 'VERIFY';
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
     * finished neither verification nor manifestation. Each step below
     * announces itself, so a stall names the operation it is stuck in -
     * and since every transfer is now a bounded observation, a wedge in
     * this phase ends in a truthful verdict instead of an eternal 99%.
     *
     * WebUSB LIMITATION, unchanged and deliberately not worked around:
     * controlTransferIn/controlTransferOut take no AbortSignal and cannot
     * be cancelled, so a pending transfer here can only be OBSERVED,
     * never interrupted. Nothing below retries an erase, a write or a
     * manifestation. */
    connection.stage = 'FINALIZE';
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
    connection.stage = 'MANIFEST';
    // Raised BEFORE the transfer is issued: if the leave command itself
    // swallows the promise and the board turns out to be gone, the
    // evidence must already say the manifestation was requested.
    manifestationRequested = true;
    let resetOnLeaveCommand = false;
    try {
      await connection.download(0, new Uint8Array(0));
    } catch (error) {
      // STM32 bootloaders set bitWillDetach: a fast board resets on the
      // leave command ITSELF, failing this very transfer. With every
      // byte verified and the device genuinely gone, that rejection IS
      // the completion signal - exactly how exitDfuMode, the Android
      // worker and the pinned Betaflight reference already treat it.
      // Reporting it as failure told operators a finished flash died.
      const code = error instanceof DfuError ? error.code : '';
      if (code !== 'DFU_TRANSFER_FAILED') {
        throw error;
      }
      if (await connection.deviceWentAway()) {
        resetOnLeaveCommand = true;
      } else {
        // The transfer was refused and the board is STILL PRESENT. Every
        // byte is already verified in flash; only the reset is unproven.
        // Calling this "فشل التفليش" would be a lie about the firmware -
        // it is the honest third result instead.
        throw new DfuError(
          DFU_CODE_UNCONFIRMED_MANIFEST,
          'DFU leave command was rejected without a reset; firmware bytes are verified but the reboot is unconfirmed.',
        );
      }
    }
    onProgress({
      phase: 'resetting',
      percent: 99,
      bytesProcessed: total,
      totalBytes: total,
    });
    if (!resetOnLeaveCommand) {
      try {
        await connection.waitForManifestation();
      } catch (error) {
        // A manifestation-tolerant device reports status; another resets
        // immediately and every further transfer fails. A transfer-level
        // rejection here is acceptable as COMPLETION only when the device
        // has genuinely gone. With the board still present it becomes the
        // honest UNCONFIRMED - the bytes are verified, the reset is not -
        // while a device-DECLARED failure (DFU_DEVICE_ERROR) and a poll
        // cap that ran out with the device still answering
        // (DFU_STATUS_TIMEOUT) keep their own codes.
        const code = error instanceof DfuError ? error.code : '';
        if (code !== 'DFU_STATUS_FAILED' && code !== 'DFU_TRANSFER_FAILED') {
          throw error;
        }
        if (!(await connection.deviceWentAway())) {
          throw new DfuError(
            DFU_CODE_UNCONFIRMED_MANIFEST,
            'DFU manifestation status was refused without a reset; firmware bytes are verified but the reboot is unconfirmed.',
          );
        }
      }
    }
    complete();
  } catch (error) {
    if (!(error instanceof DfuPendingTransferOverrun)) {
      throw error;
    }
    /* A transfer outlived its observation window. The device session is
     * already poisoned (DfuConnection.bounded did that the instant the
     * window closed) so no future attempt can race the pending transfer.
     * Classify the frozen attempt from measured evidence - never from
     * the timeout itself. */
    const verdict = classifyDfuOverrun({
      stage: connection.stage,
      allBytesWritten: written === total,
      allBytesVerified: verified === total,
      manifestationRequested,
      deviceGone: await connection.deviceWentAway(),
    });
    if (verdict.outcome === 'SUCCESS') {
      // Not a timeout converted into success: every byte was read back
      // equal, the manifestation was issued, and the board has
      // PHYSICALLY left the bus - the same disappearance evidence the
      // Android worker and Betaflight's own leave path accept. The
      // wedged GETSTATUS is exactly what MANIFEST-WAIT-RESET looks like
      // on a device that resets without answering.
      complete();
      return;
    }
    if (cancelRequested) {
      // The operator had already asked to stop; without completion
      // evidence the cancel is the truer terminal state.
      throw new DfuCancelledError();
    }
    throw new DfuError(
      verdict.code ?? 'DFU_DEVICE_UNRESPONSIVE_ERASE',
      `WebUSB ${connection.pendingOp ?? error.op} did not settle within its ${error.deadlineMs}ms observation window; the attempt was frozen without retrying. Unplug and replug the board before any new attempt.`,
    );
  } finally {
    await connection.release();
  }
}

/** Leaves DfuSe by selecting the application address then a zero-length DNLOAD. */
export async function exitDfuMode(deviceId: number): Promise<void> {
  const target = requireTarget(deviceId);
  assertSessionNotPoisoned(target.device);
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
      // itself carries no information worth keeping. (An overrun lands
      // here too: the transfer neither settled nor did the device leave,
      // so it is reported as a failed exit against a poisoned session.)
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
  assertSessionNotPoisoned(target.device);
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
  poisonedDevices = new WeakMap<USBDevice, string>();
  lastDfuDiscoveryDiagnostics = undefined;
}
