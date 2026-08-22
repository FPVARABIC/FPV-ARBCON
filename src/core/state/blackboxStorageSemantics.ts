/* eslint-disable no-bitwise -- the disabled-fields mask IS a bit field in a
   firmware payload; expressing it as arithmetic would hide the contract. */
import type {MspBlackboxConfig} from '../protocol/msp/decoding/decodeBlackboxConfig';
import type {MspDataflashSummary} from '../protocol/msp/decoding/decodeDataflashSummary';
import type {MspSdcardSummary} from '../protocol/msp/decoding/decodeSdcardSummary';

/**
 * WHAT THE STORAGE BYTES ACTUALLY MEAN.
 *
 * The three Blackbox read commands all answer with a full, well-formed
 * frame whatever the board's real state is - a board with no flash chip
 * sends thirteen zero bytes, an SD slot with no card sends a valid frame
 * whose capacities are zero. Nothing in the payload alone separates "the
 * measurement is zero" from "there was no measurement to make", and the
 * firmware does not transmit the distinction it uses internally.
 *
 * So it is reconstructed here, once, from the flags and states that ARE on
 * the wire - and this module is the only place allowed to do it. A screen
 * or controller that re-read the raw fields would be free to reach a
 * different conclusion, which is exactly how "0 RPM" once appeared beside
 * a motor whose ESC had never spoken.
 */

/* ================================================================== *
 * LOGGING DEVICE
 * ================================================================== */

/**
 * The devices proven to exist in the BlackboxDevice_e enum at the pinned
 * API-1.47 firmware commit.
 *
 * VIRTUAL (4) exists on master (API 1.49) only. It is deliberately not
 * modelled as a supported device: the reference configurator offers it
 * from API 1.47, but the 1.47 firmware enum has no such value, so we
 * cannot claim support we have no source for. A board that reports 4 - or
 * anything else unmodelled - decodes as UNKNOWN with its raw value intact.
 */
export type BlackboxLoggingDevice =
  | 'NONE'
  | 'FLASH'
  | 'SDCARD'
  | 'SERIAL'
  | 'UNKNOWN';

export const BLACKBOX_DEVICE_NONE = 0;
export const BLACKBOX_DEVICE_FLASH = 1;
export const BLACKBOX_DEVICE_SDCARD = 2;
export const BLACKBOX_DEVICE_SERIAL = 3;

export interface BlackboxDeviceSelection {
  readonly device: BlackboxLoggingDevice;
  /** Always the byte the board sent, including for UNKNOWN. */
  readonly raw: number;
  /** False for UNKNOWN - never present an unmodelled value as a feature. */
  readonly modelled: boolean;
}

export function classifyBlackboxDevice(raw: number): BlackboxDeviceSelection {
  switch (raw) {
    case BLACKBOX_DEVICE_NONE:
      return Object.freeze({device: 'NONE' as const, raw, modelled: true});
    case BLACKBOX_DEVICE_FLASH:
      return Object.freeze({device: 'FLASH' as const, raw, modelled: true});
    case BLACKBOX_DEVICE_SDCARD:
      return Object.freeze({device: 'SDCARD' as const, raw, modelled: true});
    case BLACKBOX_DEVICE_SERIAL:
      return Object.freeze({device: 'SERIAL' as const, raw, modelled: true});
    default:
      return Object.freeze({device: 'UNKNOWN' as const, raw, modelled: false});
  }
}

/* ================================================================== *
 * SAMPLE RATE
 * ================================================================== */

/**
 * BlackboxSampleRate_e is a divider exponent: the logged rate is
 * 1/(2^value) of the PID loop. Five values are defined, 0..4.
 *
 * The DIVIDER is a protocol fact and lives here. The frequency label a
 * person reads ("1/2 (4kHz)") is not: it depends on the gyro sample rate
 * and pid_process_denom from a different command, and inventing one here
 * would attach a number to a rate this module cannot compute.
 */
export const BLACKBOX_SAMPLE_RATE_MIN = 0;
export const BLACKBOX_SAMPLE_RATE_MAX = 4;

export interface BlackboxSampleRateSelection {
  readonly raw: number;
  /** 1, 2, 4, 8 or 16 - undefined when the raw value is unmodelled. */
  readonly divider: number | undefined;
  readonly modelled: boolean;
}

export function classifyBlackboxSampleRate(
  raw: number,
): BlackboxSampleRateSelection {
  const modelled =
    Number.isInteger(raw) &&
    raw >= BLACKBOX_SAMPLE_RATE_MIN &&
    raw <= BLACKBOX_SAMPLE_RATE_MAX;
  return Object.freeze({
    raw,
    divider: modelled ? Math.pow(2, raw) : undefined,
    modelled,
  });
}

/* ================================================================== *
 * DISABLED-FIELDS MASK
 * ================================================================== */

/**
 * A SET BIT MEANS THE FIELD IS DISABLED.
 *
 * The firmware member is `fields_disabled_mask`, and the reference client
 * builds it by setting a bit for every checkbox the operator turned OFF.
 * The inverted reading is the natural one and it is wrong, so the name
 * carries the polarity and no "enabled mask" exists anywhere in this
 * codebase to be confused with it.
 *
 * The mask is kept UNSIGNED end to end. JavaScript's bitwise operators are
 * signed 32-bit, so `1 << 31` is negative and a mask that merely round
 * trips through `|` would surface bit 31 as -2147483648 in a model a
 * screen reads. Every operation below ends in `>>> 0`.
 */
export const BLACKBOX_FIELD_BIT_MIN = 0;
export const BLACKBOX_FIELD_BIT_MAX = 31;

function assertFieldBit(bit: number): number {
  if (
    !Number.isInteger(bit) ||
    bit < BLACKBOX_FIELD_BIT_MIN ||
    bit > BLACKBOX_FIELD_BIT_MAX
  ) {
    throw new RangeError(
      `Blackbox field bit must be ${BLACKBOX_FIELD_BIT_MIN}..${BLACKBOX_FIELD_BIT_MAX}, received ${bit}.`,
    );
  }
  return bit;
}

export function isBlackboxFieldDisabled(mask: number, bit: number): boolean {
  assertFieldBit(bit);
  return ((mask >>> bit) & 1) === 1;
}

export function setBlackboxFieldDisabled(
  mask: number,
  bit: number,
  disabled: boolean,
): number {
  assertFieldBit(bit);
  const selector = (1 << bit) >>> 0;
  return (disabled ? mask | selector : mask & ~selector) >>> 0;
}

/* ================================================================== *
 * DATAFLASH
 * ================================================================== */

/**
 * WHY "NOT READY" IS ITS OWN STATE.
 *
 * flashfsIsReady() is flashfsIsSupported() AND the volume being idle AND
 * the chip answering. An erase in progress clears it while the sizes stay
 * populated, so a reader that only asked "is used zero?" would call a
 * mid-erase chip EMPTY. It is not empty; it is unmeasurable right now.
 *
 * INCONSISTENT is reported, never repaired. If used exceeds total, one of
 * the two numbers is wrong and there is no way to tell which; clamping
 * would publish a free space that no field on the wire supports.
 */
export type DataflashState =
  /** No flash filesystem on this board at all. */
  | 'UNSUPPORTED'
  /** Present, but the volume is not idle - sizes are not stable readings. */
  | 'BUSY_OR_NOT_READY'
  /** Ready, and genuinely holding nothing. */
  | 'READY_EMPTY'
  /** Ready, holding logs, with room left. */
  | 'READY_WITH_DATA'
  /** Ready and used == total: no room for another log. */
  | 'READY_FULL'
  /** used > total, or a zero-size volume claiming to be ready. */
  | 'INCONSISTENT';

export interface DataflashStorage {
  readonly state: DataflashState;
  /** Only ever set when the state makes the numbers meaningful. */
  readonly totalBytes: number | undefined;
  readonly usedBytes: number | undefined;
  /** Derived as total - used, and only where that subtraction is sound. */
  readonly freeBytes: number | undefined;
  /** True when a person may be shown these as measurements. */
  readonly measurementsValid: boolean;
}

const NO_DATAFLASH_MEASUREMENTS = {
  totalBytes: undefined,
  usedBytes: undefined,
  freeBytes: undefined,
  measurementsValid: false,
} as const;

export function classifyDataflash(
  summary: MspDataflashSummary,
): DataflashStorage {
  if (!summary.supported) {
    // No chip. The three zeros the firmware sent are structure, not size.
    return Object.freeze({state: 'UNSUPPORTED' as const, ...NO_DATAFLASH_MEASUREMENTS});
  }
  if (!summary.ready) {
    // Supported and busy. NOT empty, NOT absent - and the sizes it is
    // still reporting are not a stable reading of anything.
    return Object.freeze({
      state: 'BUSY_OR_NOT_READY' as const,
      ...NO_DATAFLASH_MEASUREMENTS,
    });
  }
  const {totalBytes, usedBytes} = summary;
  if (usedBytes > totalBytes || totalBytes === 0) {
    // Either number could be the wrong one. Say so instead of choosing.
    return Object.freeze({
      state: 'INCONSISTENT' as const,
      ...NO_DATAFLASH_MEASUREMENTS,
    });
  }
  const freeBytes = totalBytes - usedBytes;
  const state: DataflashState =
    usedBytes === 0
      ? 'READY_EMPTY'
      : freeBytes === 0
        ? 'READY_FULL'
        : 'READY_WITH_DATA';
  return Object.freeze({
    state,
    totalBytes,
    usedBytes,
    freeBytes,
    measurementsValid: true,
  });
}

/* ================================================================== *
 * SD CARD
 * ================================================================== */

/**
 * The merged card + filesystem state byte, exactly as the firmware builds
 * it. Anything outside 0..4 keeps its number and is called UNKNOWN - it is
 * never folded into FATAL (which would invent a fault), NOT_PRESENT (which
 * would invent an absence) or READY (which would invent a capacity).
 */
export type SdcardState =
  | 'NOT_PRESENT'
  | 'FATAL'
  | 'CARD_INITIALIZING'
  | 'FILESYSTEM_INITIALIZING'
  | 'READY'
  | 'UNKNOWN';

export const SDCARD_STATE_NOT_PRESENT = 0;
export const SDCARD_STATE_FATAL = 1;
export const SDCARD_STATE_CARD_INITIALIZING = 2;
export const SDCARD_STATE_FILESYSTEM_INITIALIZING = 3;
export const SDCARD_STATE_READY = 4;

export interface SdcardStorage {
  /** False when no SD slot is configured as a logging destination. */
  readonly configured: boolean;
  readonly state: SdcardState;
  /** The state byte verbatim - the only thing UNKNOWN can be reported by. */
  readonly stateRaw: number;
  /** afatfs_getLastError(), carried through opaquely. */
  readonly filesystemLastError: number;
  /** Kilobytes. Present ONLY in READY - see below. */
  readonly totalKilobytes: number | undefined;
  readonly freeKilobytes: number | undefined;
  readonly usedKilobytes: number | undefined;
  readonly measurementsValid: boolean;
}

function classifySdcardState(raw: number): SdcardState {
  switch (raw) {
    case SDCARD_STATE_NOT_PRESENT:
      return 'NOT_PRESENT';
    case SDCARD_STATE_FATAL:
      return 'FATAL';
    case SDCARD_STATE_CARD_INITIALIZING:
      return 'CARD_INITIALIZING';
    case SDCARD_STATE_FILESYSTEM_INITIALIZING:
      return 'FILESYSTEM_INITIALIZING';
    case SDCARD_STATE_READY:
      return 'READY';
    default:
      return 'UNKNOWN';
  }
}

export function classifySdcard(summary: MspSdcardSummary): SdcardStorage {
  const state = classifySdcardState(summary.stateRaw);
  const base = {
    configured: summary.configured,
    state,
    stateRaw: summary.stateRaw,
    filesystemLastError: summary.filesystemLastError,
  };
  /**
   * CAPACITY EXISTS ONLY IN READY, and this is the firmware's own rule
   * rather than a caution of ours: it writes freeSpace and totalSpace
   * inside `if (state == MSP_SDCARD_STATE_READY)` and leaves both at their
   * initial zero otherwise. Reporting "0 kB" for a slot with no card in it
   * would be reading an uninitialised local as a measurement.
   */
  if (state !== 'READY') {
    return Object.freeze({
      ...base,
      totalKilobytes: undefined,
      freeKilobytes: undefined,
      usedKilobytes: undefined,
      measurementsValid: false,
    });
  }
  const {totalKilobytes, freeKilobytes} = summary;
  if (freeKilobytes > totalKilobytes) {
    // Same refusal as the flash volume: no silent clamp, no invented used.
    return Object.freeze({
      ...base,
      totalKilobytes: undefined,
      freeKilobytes: undefined,
      usedKilobytes: undefined,
      measurementsValid: false,
    });
  }
  return Object.freeze({
    ...base,
    totalKilobytes,
    freeKilobytes,
    usedKilobytes: totalKilobytes - freeKilobytes,
    measurementsValid: true,
  });
}

/* ================================================================== *
 * THE CONFIG, READ SEMANTICALLY
 * ================================================================== */

export interface BlackboxConfiguration {
  /** Byte 0. False means this firmware build has no Blackbox at all. */
  readonly supported: boolean;
  readonly device: BlackboxDeviceSelection;
  readonly sampleRate: BlackboxSampleRateSelection;
  readonly disabledFieldsMask: number;
  /** Derived by the firmware; read-only, never sent back as an intent. */
  readonly legacyRateDenominator: number;
  readonly pRatio: number;
}

export function classifyBlackboxConfig(
  config: MspBlackboxConfig,
): BlackboxConfiguration {
  return Object.freeze({
    supported: config.supported,
    device: classifyBlackboxDevice(config.deviceRaw),
    sampleRate: classifyBlackboxSampleRate(config.sampleRateRaw),
    disabledFieldsMask: config.disabledFieldsMask >>> 0,
    legacyRateDenominator: config.legacyRateDenominator,
    pRatio: config.pRatio,
  });
}

/**
 * Whether an erase of the onboard flash could do anything at all.
 *
 * Not a UI helper and not an erase implementation - a fact this layer can
 * state and B-3 will need: blackboxEraseAll() switches on the CONFIGURED
 * device and does nothing unless it is FLASH. A board with a perfectly
 * good flash chip selected as SDCARD will accept the command and erase
 * nothing.
 */
export function dataflashEraseWouldApply(
  config: BlackboxConfiguration,
  storage: DataflashStorage,
): boolean {
  return (
    config.device.device === 'FLASH' &&
    (storage.state === 'READY_WITH_DATA' || storage.state === 'READY_FULL')
  );
}
