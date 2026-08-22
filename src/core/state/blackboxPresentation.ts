/**
 * WHAT THE BLACKBOX SCREEN IS ALLOWED TO SAY, decided here instead of in
 * the screen.
 *
 * B-1 owns the bytes. B-2 owns what the bytes MEAN. This module owns the
 * last step - which sentence a meaning gets - and it is separate from the
 * screen for the same reason B-2 is separate from B-1: a component that
 * decided its own wording would be free to reach a different conclusion
 * from the one the storage model published, and "0 RPM beside an ESC that
 * had never spoken" is what that costs.
 *
 * NO ARABIC LIVES HERE. Every function returns an i18n KEY (and, where a
 * number is genuinely measured, the values to interpolate). The catalogue
 * holds the words; this holds the rules about which words are permitted.
 * `i18nCoverage.test.ts` then proves every key produced here exists.
 *
 * ===================================================================
 * UNITS: BASE-1024, AND LABELLED AS SUCH
 * ===================================================================
 *
 * Both storage sources report binary quantities, and that is a firmware
 * fact rather than a convention of ours:
 *
 *   FLASH - flashfsGetSize()/flashfsGetOffset() are byte counts of a chip
 *   whose geometry is powers of two.
 *
 *   SD CARD - msp.c writes `freeSpace = afatfs_getContiguousFreeSpace() /
 *   1024` and `totalSpace = sdcard_getMetadata()->numBlocks / 2`
 *   (512-byte blocks halved). Both are KiB. The firmware's own comment
 *   says "kilobytes"; the arithmetic says KiB.
 *   [betaflight/betaflight 7348054f, src/main/msp/msp.c, MSP_SDCARD_SUMMARY]
 *
 * So the divisor is 1024 and the symbols are the IEC ones - KiB, MiB, GiB.
 * Printing "16 MB" for 16777216 bytes would state a decimal quantity that
 * was never measured, which is the same class of error as printing a
 * capacity for a slot with no card in it.
 */

import {
  isBlackboxFieldDisabled,
  setBlackboxFieldDisabled,
  type DataflashStorage,
  type SdcardStorage,
  type BlackboxDeviceSelection,
  type BlackboxSampleRateSelection,
} from './blackboxStorageSemantics';

/* ================================================================== *
 * SIZES
 * ================================================================== */

export const BYTES_PER_KIB = 1024;

/** IEC symbols, smallest first. The index IS the power of 1024. */
const BINARY_UNIT_KEYS = [
  'blackbox.units.bytes',
  'blackbox.units.kibibytes',
  'blackbox.units.mebibytes',
  'blackbox.units.gibibytes',
  'blackbox.units.tebibytes',
] as const;

export interface BlackboxSize {
  /** Already formatted for display, western digits, LTR. */
  readonly amount: string;
  readonly unitKey: (typeof BINARY_UNIT_KEYS)[number];
}

/**
 * ONE formatter for both storage sources - the requirement is explicit
 * that flash bytes and SD kibibytes must not grow two different styles.
 *
 * Whole bytes stay whole (a `0` used figure is a real measurement and must
 * read as `0 بايت`, not `0.0 KiB`). Anything larger gets one decimal only
 * when it needs one, so `16 MiB` does not become `16.0 MiB`.
 */
export function formatBinarySize(bytes: number): BlackboxSize {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new RangeError(`Blackbox size must be a non-negative number, received ${bytes}.`);
  }
  let index = 0;
  let value = bytes;
  while (value >= BYTES_PER_KIB && index < BINARY_UNIT_KEYS.length - 1) {
    value /= BYTES_PER_KIB;
    index += 1;
  }
  const amount =
    index === 0
      ? String(Math.round(value))
      : // Two significant-ish digits: enough to distinguish 7.9 from 8.0
        // without implying a precision the chip never reported.
        String(Number(value.toFixed(1)));
  return Object.freeze({amount, unitKey: BINARY_UNIT_KEYS[index]});
}

/** SD capacities arrive in KiB; flash arrives in bytes. One conversion. */
export function kibibytesToBytes(kibibytes: number): number {
  return kibibytes * BYTES_PER_KIB;
}

/**
 * The fraction of a volume in use, for a bar.
 *
 * Returns undefined whenever the inputs are not both real measurements,
 * so a caller cannot accidentally draw a full or empty bar out of a zero
 * sentinel. Clamped, because a bar wider than its track is a rendering
 * bug rather than information.
 */
export function usedFraction(input: {
  readonly usedBytes: number | undefined;
  readonly totalBytes: number | undefined;
  readonly measurementsValid: boolean;
}): number | undefined {
  if (!input.measurementsValid) return undefined;
  const {usedBytes, totalBytes} = input;
  if (usedBytes === undefined || totalBytes === undefined) return undefined;
  if (totalBytes <= 0) return undefined;
  return Math.min(1, Math.max(0, usedBytes / totalBytes));
}

/* ================================================================== *
 * LOGGING DEVICE
 * ================================================================== */

export interface BlackboxDeviceLabel {
  readonly key: string;
  /** Only for UNKNOWN, where the number IS the honest answer. */
  readonly raw?: number;
}

/**
 * A device the board named but this build cannot. The raw value is kept
 * and shown, never normalised to NONE - a board logging to something we
 * do not model is not a board logging to nothing.
 */
export function describeBlackboxDevice(
  selection: BlackboxDeviceSelection,
): BlackboxDeviceLabel {
  return selection.modelled
    ? Object.freeze({key: `blackbox.device.${selection.device}`})
    : Object.freeze({key: 'blackbox.device.UNKNOWN', raw: selection.raw});
}

/**
 * The devices this screen may OFFER, which is a shorter list than the
 * ones it may DISPLAY.
 *
 * VIRTUAL is absent by construction: the value exists on the master branch
 * only, and offering a destination whose firmware behaviour we have never
 * read would be inviting the operator to configure something we cannot
 * describe. A board already reporting it keeps it, via the UNKNOWN path.
 */
export const OFFERABLE_BLACKBOX_DEVICES = Object.freeze([0, 1, 2, 3] as const);

/* ================================================================== *
 * LOGGING RATE
 * ================================================================== */

export interface BlackboxRateLabel {
  /** 'blackbox.rate.full' | 'blackbox.rate.fraction' | '…unknown'. */
  readonly key: string;
  readonly divider?: number;
  readonly raw?: number;
}

/**
 * THERE IS NO kHz HERE, and that is a decision with a source.
 *
 * A frequency for the logging rate is (gyro sample rate ÷
 * pid_process_denom) ÷ 2^sample_rate. The first term is not on the wire:
 * MSP_ADVANCED_CONFIG carries pid_process_denom and a DEPRECATED
 * gyro_sync_denom, and the base gyro rate depends on the fitted sensor
 * and its low-pass configuration, neither of which this screen reads. The
 * reference client fills the gap from a hard-coded per-gyro table.
 *
 * So the divider - which IS a protocol fact - is all that is shown. A
 * "4 kHz" beside it would be a number no command in this session produced.
 */
export function describeBlackboxRate(
  selection: BlackboxSampleRateSelection,
): BlackboxRateLabel {
  if (!selection.modelled || selection.divider === undefined) {
    return Object.freeze({key: 'blackbox.rate.unknown', raw: selection.raw});
  }
  return selection.divider === 1
    ? Object.freeze({key: 'blackbox.rate.full'})
    : Object.freeze({key: 'blackbox.rate.fraction', divider: selection.divider});
}

/* ================================================================== *
 * STORAGE STATES
 * ================================================================== */

/**
 * What a dataflash state is allowed to say, and - just as important -
 * whether numbers may appear beside it at all.
 */
export interface BlackboxStorageCopy {
  readonly headlineKey: string;
  /** True only where the model published real measurements. */
  readonly showsMeasurements: boolean;
}

export function describeDataflash(storage: DataflashStorage): BlackboxStorageCopy {
  return Object.freeze({
    headlineKey: `blackbox.flashState.${storage.state}`,
    // Not `state === READY_*`: the model is the authority on whether the
    // numbers are readings, and asking it twice is how the two answers
    // drift apart.
    showsMeasurements: storage.measurementsValid,
  });
}

export function describeSdcard(storage: SdcardStorage): BlackboxStorageCopy {
  return Object.freeze({
    headlineKey: `blackbox.sdState.${storage.state}`,
    showsMeasurements: storage.measurementsValid,
  });
}

/**
 * Whether a storage section should be RENDERED AT ALL.
 *
 * A board with no flash chip gets no flash card - not an empty one, not a
 * greyed one, not one reading "—". The absence is the information.
 */
export function dataflashSectionVisible(storage: DataflashStorage): boolean {
  return storage.state !== 'UNSUPPORTED';
}

/**
 * The SD section follows the CONFIGURED flag, which is the firmware's
 * "this board has an SD slot wired as a logging destination" - deliberately
 * not "a card is in it". A configured slot with no card is a real thing to
 * say; an unconfigured board has no slot to talk about.
 */
export function sdcardSectionVisible(storage: SdcardStorage): boolean {
  return storage.configured;
}

/** Neither medium exists on this board, so only the serial port is left. */
export function onlySerialRemains(
  flash: DataflashStorage,
  sdcard: SdcardStorage,
): boolean {
  return !dataflashSectionVisible(flash) && !sdcardSectionVisible(sdcard);
}

/* ================================================================== *
 * DEBUG MODE
 * ================================================================== */

/**
 * THE NAMED DEBUG MODES, AND WHY THE LIST STOPS AT 96.
 *
 * These are firmware identifiers - what `get debug_mode` prints in the
 * CLI - so showing them is showing the board's own data, and translating
 * them would make the value the operator sees stop matching the value
 * every other tool shows.
 *
 * The list is DELIBERATELY TRUNCATED. Comparing debugModeNames[] at the
 * two firmware revisions this project has verified:
 *
 *   API 1.47 (betaflight/betaflight 7348054f) and API 1.49 (master,
 *   1efac3e) agree exactly on indices 0..95.
 *   At index 96 they diverge: 1.47 says AUTOPILOT_POSITION, 1.49 says
 *   CHIRP. The enum is NOT append-only.
 *
 * So a hard-coded table beyond 95 would confidently mislabel a real
 * board's setting depending on which firmware it runs. Everything at or
 * above 96 - and everything at or above the board's own debugModeCount -
 * is reported as an unknown mode carrying its raw number, which is the
 * only thing that is true on every build.
 *
 * Source: src/main/build/debug.c at both revisions.
 */
export const NAMED_DEBUG_MODES: readonly string[] = Object.freeze([
  'NONE', 'CYCLETIME', 'BATTERY', 'GYRO_FILTERED', 'ACCELEROMETER',
  'PIDLOOP', 'RC_INTERPOLATION', 'ANGLERATE', 'ESC_SENSOR', 'SCHEDULER',
  'STACK', 'ESC_SENSOR_RPM', 'ESC_SENSOR_TMP', 'ALTITUDE', 'FFT',
  'FFT_TIME', 'FFT_FREQ', 'RX_FRSKY_SPI', 'RX_SFHSS_SPI', 'GYRO_RAW',
  'MULTI_GYRO_RAW', 'MULTI_GYRO_DIFF', 'MAX7456_SIGNAL', 'MAX7456_SPICLOCK',
  'SBUS', 'FPORT', 'RANGEFINDER', 'RANGEFINDER_QUALITY', 'OPTICALFLOW',
  'LIDAR_TF', 'ADC_INTERNAL', 'RUNAWAY_TAKEOFF', 'SDIO', 'CURRENT_SENSOR',
  'USB', 'SMARTAUDIO', 'RTH', 'ITERM_RELAX', 'ACRO_TRAINER', 'RC_SMOOTHING',
  'RX_SIGNAL_LOSS', 'RC_SMOOTHING_RATE', 'ANTI_GRAVITY', 'DYN_LPF',
  'RX_SPEKTRUM_SPI', 'DSHOT_RPM_TELEMETRY', 'RPM_FILTER', 'D_MAX',
  'AC_CORRECTION', 'AC_ERROR', 'MULTI_GYRO_SCALED', 'DSHOT_RPM_ERRORS',
  'CRSF_LINK_STATISTICS_UPLINK', 'CRSF_LINK_STATISTICS_PWR',
  'CRSF_LINK_STATISTICS_DOWN', 'BARO', 'AUTOPILOT_ALTITUDE', 'DYN_IDLE',
  'FEEDFORWARD_LIMIT', 'FEEDFORWARD', 'BLACKBOX_OUTPUT', 'GYRO_SAMPLE',
  'RX_TIMING', 'D_LPF', 'VTX_TRAMP', 'GHST', 'GHST_MSP',
  'SCHEDULER_DETERMINISM', 'TIMING_ACCURACY', 'RX_EXPRESSLRS_SPI',
  'RX_EXPRESSLRS_PHASELOCK', 'RX_STATE_TIME', 'GPS_RESCUE_VELOCITY',
  'GPS_RESCUE_HEADING', 'GPS_RESCUE_TRACKING', 'GPS_CONNECTION', 'ATTITUDE',
  'VTX_MSP', 'GPS_DOP', 'FAILSAFE', 'GYRO_CALIBRATION', 'ANGLE_MODE',
  'ANGLE_TARGET', 'CURRENT_ANGLE', 'DSHOT_TELEMETRY_COUNTS', 'RPM_LIMIT',
  'RC_STATS', 'MAG_CALIB', 'MAG_TASK_RATE', 'EZLANDING', 'TPA', 'S_TERM',
  'SPA', 'TASK', 'GIMBAL', 'WING_SETPOINT',
]);

export interface BlackboxDebugModeLabel {
  /** The firmware identifier, or undefined when it cannot be named. */
  readonly name: string | undefined;
  readonly raw: number;
}

export function describeDebugMode(raw: number): BlackboxDebugModeLabel {
  const name =
    Number.isInteger(raw) && raw >= 0 && raw < NAMED_DEBUG_MODES.length
      ? NAMED_DEBUG_MODES[raw]
      : undefined;
  return Object.freeze({name, raw});
}

/**
 * The modes this screen may OFFER for a board reporting `count` of them.
 *
 * Bounded by BOTH limits, and for different reasons: the board's own count
 * is the only statement about what its build actually has, and our table
 * length is the last index whose name is the same on every firmware we
 * have read. Offering past either is offering a guess.
 */
export function offerableDebugModes(count: number): readonly number[] {
  const limit = Math.max(
    0,
    Math.min(Number.isInteger(count) ? count : 0, NAMED_DEBUG_MODES.length),
  );
  return Object.freeze(Array.from({length: limit}, (_, index) => index));
}

/* ================================================================== *
 * DEBUG FIELDS
 * ================================================================== */

/**
 * flightLogFieldSelect_e, bit for bit.
 *
 * Identical at API 1.47 (7348054f) and API 1.49 (master, 1efac3e):
 * sixteen values, 0..15, in this order.
 * Source: src/main/blackbox/blackbox_fielddefs.h at both revisions.
 *
 * THE POLARITY TRAP LIVES ONE LAYER DOWN. The mask on the wire is
 * `fields_disabled_mask` - a SET bit means the field is OFF. Nothing in
 * this list encodes that; the conversion happens once, at
 * `fieldIncluded` / `withFieldIncluded` below, and the screen never
 * touches a bit directly.
 */
export const BLACKBOX_FIELD_BITS = Object.freeze([
  'PID', 'RC_COMMANDS', 'SETPOINT', 'BATTERY', 'MAG', 'ALTITUDE', 'RSSI',
  'GYRO', 'ATTITUDE', 'ACC', 'DEBUG_LOG', 'MOTOR', 'GPS', 'RPM',
  'GYROUNFILT', 'SERVO',
] as const);

export type BlackboxFieldName = (typeof BLACKBOX_FIELD_BITS)[number];

export function blackboxFieldBit(field: BlackboxFieldName): number {
  return BLACKBOX_FIELD_BITS.indexOf(field);
}

/**
 * THE ONE PLACE THE POLARITY FLIPS.
 *
 * On the wire, a SET bit DISABLES its field. On screen, a checkbox that
 * is ticked INCLUDES its field. Those are opposite, and every defect in
 * this area comes from somebody carrying the wire's polarity one layer too
 * far - a checkbox that reads "disable GPS" and then behaves like
 * "include GPS", or a save that writes the operator's intent inverted.
 *
 * So the inversion happens exactly here, in two functions, and nothing
 * above this line is allowed to see a bit again. The screen asks "is this
 * field included?" and says "include this field"; both sentences are the
 * ones a person actually means.
 */
export function blackboxFieldIncluded(
  disabledFieldsMask: number,
  field: BlackboxFieldName,
): boolean {
  return !isBlackboxFieldDisabled(disabledFieldsMask, blackboxFieldBit(field));
}

export function withBlackboxFieldIncluded(
  disabledFieldsMask: number,
  field: BlackboxFieldName,
  included: boolean,
): number {
  return setBlackboxFieldDisabled(
    disabledFieldsMask,
    blackboxFieldBit(field),
    // INCLUDED means the disable bit is CLEARED.
    !included,
  );
}

/**
 * Bits the board has set that this build has no name for.
 *
 * Not shown as fields - there is nothing to call them - but their presence
 * is why a save must carry the whole mask through untouched rather than
 * rebuilding it from the sixteen switches on screen.
 */
export function unnamedDisabledFieldBits(
  disabledFieldsMask: number,
): readonly number[] {
  const bits: number[] = [];
  for (let bit = BLACKBOX_FIELD_BITS.length; bit <= 31; bit += 1) {
    if (isBlackboxFieldDisabled(disabledFieldsMask, bit)) bits.push(bit);
  }
  return Object.freeze(bits);
}
