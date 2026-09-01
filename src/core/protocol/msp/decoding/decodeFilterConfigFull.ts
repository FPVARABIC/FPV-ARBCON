import {MspPayloadReadError} from './MspPayloadReader';
import {
  FILTER_CONFIG_RPM_TAIL_BYTES,
  MSP_FILTER_CONFIG_BYTES_API147,
  MSP_FILTER_CONFIG_BYTES_API148,
  RPM_FILTER_HARMONICS_MAX,
  type PidApiContract,
} from './pidWireContracts';

/**
 * THE WHOLE OF MSP_FILTER_CONFIG, and the three different things it owns.
 *
 * This one command reaches into three separate configuration structures, and
 * treating it as a single scope is the mistake P-A named as architectural:
 *
 *   gyroConfig()      GLOBAL          gyro lowpasses, both static notches,
 *                                     the hardware lowpass
 *   currentPidProfile PID PROFILE     every D-term filter, the D-term notch,
 *                                     the yaw lowpass
 *   dynNotchConfig()  GLOBAL          the dynamic notch
 *   rpmFilterConfig() GLOBAL          the RPM filter
 *
 * So writing this payload while the wrong PID profile is active corrupts the
 * D-term half of somebody else's tune, while the gyro half would have been
 * written either way. `filterFieldScope()` below is the machine-readable form
 * of that, and P-C is expected to bind the two halves to different identities.
 *
 * TWO LENGTHS, ONE COMMAND. 49 bytes at API 1.47; from 1.48 a 7-byte RPM tail
 * is appended (u16 fade range, u16 q, three u8 weights). Those fields already
 * existed in the 1.47 struct - they were simply CLI-only there, which is why
 * the 1.47 decode reports them absent rather than zero.
 */

export const FILTER_CONFIG_OFFSETS = Object.freeze({
  /** The legacy truncated copy. NEVER the semantic source - see below. */
  gyroLpf1StaticHzLegacyU8: 0,
  dtermLpf1StaticHz: 1,
  yawLowpassHz: 3,
  gyroSoftNotchHz1: 5,
  gyroSoftNotchCutoff1: 7,
  dtermNotchHz: 9,
  dtermNotchCutoff: 11,
  gyroSoftNotchHz2: 13,
  gyroSoftNotchCutoff2: 15,
  dtermLpf1Type: 17,
  gyroHardwareLpf: 18,
  /** The authoritative full-width copy. */
  gyroLpf1StaticHz: 20,
  gyroLpf2StaticHz: 22,
  gyroLpf1Type: 24,
  gyroLpf2Type: 25,
  dtermLpf2StaticHz: 26,
  dtermLpf2Type: 28,
  gyroLpf1DynMinHz: 29,
  gyroLpf1DynMaxHz: 31,
  dtermLpf1DynMinHz: 33,
  dtermLpf1DynMaxHz: 35,
  dynNotchQ: 39,
  dynNotchMinHz: 41,
  rpmFilterHarmonics: 43,
  rpmFilterMinHz: 44,
  dynNotchMaxHz: 45,
  dtermLpf1DynExpo: 47,
  dynNotchCount: 48,
  /* API 1.48 tail */
  rpmFilterFadeRangeHz: 49,
  rpmFilterQ: 51,
  rpmFilterWeights: 53,
} as const);

export type FilterFieldScope = 'GLOBAL' | 'PID_PROFILE';

export type FilterFieldKey =
  | 'gyroLpf1StaticHz' | 'gyroLpf2StaticHz' | 'gyroLpf1Type' | 'gyroLpf2Type'
  | 'gyroLpf1DynMinHz' | 'gyroLpf1DynMaxHz' | 'gyroHardwareLpf'
  | 'gyroSoftNotchHz1' | 'gyroSoftNotchCutoff1' | 'gyroSoftNotchHz2' | 'gyroSoftNotchCutoff2'
  | 'dtermLpf1StaticHz' | 'dtermLpf2StaticHz' | 'dtermLpf1Type' | 'dtermLpf2Type'
  | 'dtermLpf1DynMinHz' | 'dtermLpf1DynMaxHz' | 'dtermLpf1DynExpo'
  | 'dtermNotchHz' | 'dtermNotchCutoff' | 'yawLowpassHz'
  | 'dynNotchQ' | 'dynNotchMinHz' | 'dynNotchMaxHz' | 'dynNotchCount'
  | 'rpmFilterHarmonics' | 'rpmFilterMinHz' | 'rpmFilterFadeRangeHz' | 'rpmFilterQ' | 'rpmFilterWeights';

const PID_PROFILE_FILTER_FIELDS: ReadonlySet<FilterFieldKey> = new Set<FilterFieldKey>([
  'dtermLpf1StaticHz', 'dtermLpf2StaticHz', 'dtermLpf1Type', 'dtermLpf2Type',
  'dtermLpf1DynMinHz', 'dtermLpf1DynMaxHz', 'dtermLpf1DynExpo',
  'dtermNotchHz', 'dtermNotchCutoff', 'yawLowpassHz',
]);

/**
 * Which configuration structure a MSP_FILTER_CONFIG field actually lives in.
 *
 * Read straight off the firmware serializer: anything it reaches through
 * `currentPidProfile` is PID-profile scoped, everything else is global.
 */
export function filterFieldScope(field: FilterFieldKey): FilterFieldScope {
  return PID_PROFILE_FILTER_FIELDS.has(field) ? 'PID_PROFILE' : 'GLOBAL';
}

/** Present only from API 1.48. At 1.47 the fields are CLI-only, not zero. */
export interface FilterRpmTail {
  readonly fadeRangeHz: number;
  readonly q: number;
  readonly weights: readonly number[];
}

export interface MspFilterConfigFull {
  readonly contract: PidApiContract;

  readonly gyroLpf1StaticHz: number;
  readonly gyroLpf2StaticHz: number;
  readonly gyroLpf1Type: number;
  readonly gyroLpf2Type: number;
  readonly gyroLpf1DynMinHz: number;
  readonly gyroLpf1DynMaxHz: number;
  readonly gyroHardwareLpf: number;
  readonly gyroSoftNotchHz1: number;
  readonly gyroSoftNotchCutoff1: number;
  readonly gyroSoftNotchHz2: number;
  readonly gyroSoftNotchCutoff2: number;

  readonly dtermLpf1StaticHz: number;
  readonly dtermLpf2StaticHz: number;
  readonly dtermLpf1Type: number;
  readonly dtermLpf2Type: number;
  readonly dtermLpf1DynMinHz: number;
  readonly dtermLpf1DynMaxHz: number;
  readonly dtermLpf1DynExpo: number;
  readonly dtermNotchHz: number;
  readonly dtermNotchCutoff: number;
  readonly yawLowpassHz: number;

  readonly dynNotchQ: number;
  readonly dynNotchMinHz: number;
  readonly dynNotchMaxHz: number;
  readonly dynNotchCount: number;

  readonly rpmFilterHarmonics: number;
  readonly rpmFilterMinHz: number;
  /**
   * `undefined` means NOT_AVAILABLE_IN_THIS_CONTRACT, which is a different
   * fact from "the board reports zero" and must never be flattened into it.
   */
  readonly rpmTail: FilterRpmTail | undefined;

  /**
   * The truncated u8 at offset 0, kept only so a decode can be shown to
   * DISAGREE with the authoritative u16 - never as a value to use.
   */
  readonly gyroLpf1StaticHzLegacyU8: number;
  /** True when the legacy byte cannot represent the real value. */
  readonly gyroLpf1StaticHzLegacyTruncated: boolean;

  /** Bytes past the contract this decoder knows. Preserved, never guessed. */
  readonly trailingBytes: Uint8Array;
  readonly raw: Uint8Array;
}

function u16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

export function decodeFilterConfigFull(payload: Uint8Array, contract: PidApiContract): MspFilterConfigFull {
  const required = contract === 'API_1_47'
    ? MSP_FILTER_CONFIG_BYTES_API147
    : MSP_FILTER_CONFIG_BYTES_API148;
  if (payload.length < required) {
    throw new MspPayloadReadError(
      `MSP_FILTER_CONFIG requires ${required} bytes under ${contract}; received ${payload.length}.`,
    );
  }
  const o = FILTER_CONFIG_OFFSETS;
  const gyroLpf1StaticHz = u16(payload, o.gyroLpf1StaticHz);
  const hasRpmTail = contract !== 'API_1_47';
  const rpmTail: FilterRpmTail | undefined = hasRpmTail
    ? Object.freeze({
      fadeRangeHz: u16(payload, o.rpmFilterFadeRangeHz),
      q: u16(payload, o.rpmFilterQ),
      weights: Object.freeze(
        Array.from({length: RPM_FILTER_HARMONICS_MAX}, (_unused, index) => payload[o.rpmFilterWeights + index]),
      ) as readonly number[],
    })
    : undefined;
  return Object.freeze({
    contract,
    gyroLpf1StaticHz,
    gyroLpf2StaticHz: u16(payload, o.gyroLpf2StaticHz),
    gyroLpf1Type: payload[o.gyroLpf1Type],
    gyroLpf2Type: payload[o.gyroLpf2Type],
    gyroLpf1DynMinHz: u16(payload, o.gyroLpf1DynMinHz),
    gyroLpf1DynMaxHz: u16(payload, o.gyroLpf1DynMaxHz),
    gyroHardwareLpf: payload[o.gyroHardwareLpf],
    gyroSoftNotchHz1: u16(payload, o.gyroSoftNotchHz1),
    gyroSoftNotchCutoff1: u16(payload, o.gyroSoftNotchCutoff1),
    gyroSoftNotchHz2: u16(payload, o.gyroSoftNotchHz2),
    gyroSoftNotchCutoff2: u16(payload, o.gyroSoftNotchCutoff2),
    dtermLpf1StaticHz: u16(payload, o.dtermLpf1StaticHz),
    dtermLpf2StaticHz: u16(payload, o.dtermLpf2StaticHz),
    dtermLpf1Type: payload[o.dtermLpf1Type],
    dtermLpf2Type: payload[o.dtermLpf2Type],
    dtermLpf1DynMinHz: u16(payload, o.dtermLpf1DynMinHz),
    dtermLpf1DynMaxHz: u16(payload, o.dtermLpf1DynMaxHz),
    dtermLpf1DynExpo: payload[o.dtermLpf1DynExpo],
    dtermNotchHz: u16(payload, o.dtermNotchHz),
    dtermNotchCutoff: u16(payload, o.dtermNotchCutoff),
    yawLowpassHz: u16(payload, o.yawLowpassHz),
    dynNotchQ: u16(payload, o.dynNotchQ),
    dynNotchMinHz: u16(payload, o.dynNotchMinHz),
    dynNotchMaxHz: u16(payload, o.dynNotchMaxHz),
    dynNotchCount: payload[o.dynNotchCount],
    rpmFilterHarmonics: payload[o.rpmFilterHarmonics],
    rpmFilterMinHz: payload[o.rpmFilterMinHz],
    rpmTail,
    gyroLpf1StaticHzLegacyU8: payload[o.gyroLpf1StaticHzLegacyU8],
    gyroLpf1StaticHzLegacyTruncated: gyroLpf1StaticHz > 0xff,
    trailingBytes: payload.slice(required),
    raw: payload.slice(),
  });
}

/**
 * Patch the two copies of gyro LPF1 so they cannot disagree.
 *
 * The firmware setter reads offset 0 into `gyro_lpf1_static_hz` and then
 * reads offsets 20-21 into the SAME field, so the later u16 wins and the u8
 * is decorative - but only when the payload is long enough to reach it. We
 * write both, in the firmware's own representation, so no short-payload path
 * and no third-party reader ever sees the two disagree.
 *
 * 300 Hz becomes 0x2C at offset 0 and 0x2C 0x01 at offsets 20-21.
 */
export function patchGyroLpf1StaticHz(payload: Uint8Array, hz: number): void {
  const o = FILTER_CONFIG_OFFSETS;
  // The firmware's legacy slot IS the low byte of the same value; arithmetic
  // would obscure that this is a truncation and not a conversion.
  // eslint-disable-next-line no-bitwise
  payload[o.gyroLpf1StaticHzLegacyU8] = hz & 0xff;
  new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    .setUint16(o.gyroLpf1StaticHz, hz, true);
}

export {FILTER_CONFIG_RPM_TAIL_BYTES};
