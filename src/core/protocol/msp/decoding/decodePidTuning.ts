import {MspPayloadReadError, MspPayloadReader} from './MspPayloadReader';

export const PID_ITEM_COUNT = 5;
export const PID_AXIS_COUNT = 3;
export const PID_ADVANCED_API147_MIN_BYTES = 61;

/** MSP_PID_ADVANCED byte carrying idle_min_rpm. See MspPidTuningSnapshot. */
export const IDLE_MIN_RPM_OFFSET = 49;

/**
 * Betaflight's own input bound: max 100, raised to 200 for API >= 1.45
 * (src/js/tabs/pid_tuning.js). We speak 1.47, so 200.
 */
export const IDLE_MIN_RPM_MAX = 200;
export const RC_TUNING_API147_BYTES = 24;
export const FILTER_CONFIG_API147_BYTES = 49;

export interface MspPidTerm { readonly p: number; readonly i: number; readonly d: number }
export interface MspRcTuning {
  readonly ratesType: number;
  readonly rcRate: readonly [number, number, number];
  readonly expo: readonly [number, number, number];
  readonly superRate: readonly [number, number, number];
  readonly throttleMid: number;
  readonly throttleExpo: number;
  readonly throttleHover: number;
  readonly throttleLimitType: number;
  readonly throttleLimitPercent: number;
  readonly rateLimit: readonly [number, number, number];
}
export interface MspFilterConfiguration {
  readonly gyroLpf1StaticHz: number;
  readonly gyroLpf1DynamicMinHz: number;
  readonly gyroLpf1DynamicMaxHz: number;
  readonly dtermLpf1StaticHz: number;
  readonly dtermLpf1DynamicMinHz: number;
  readonly dtermLpf1DynamicMaxHz: number;
  readonly dynamicNotchQ: number;
  readonly dynamicNotchMinHz: number;
  readonly dynamicNotchMaxHz: number;
  readonly dynamicNotchCount: number;
}
export interface MspPidTuningSnapshot {
  readonly terms: readonly MspPidTerm[];
  readonly feedforward: readonly [number, number, number];
  readonly rcTuning: MspRcTuning;
  readonly filterConfig: MspFilterConfiguration;
  readonly gyroSampleRateHz?: number;
  readonly pidProcessDenom?: number;
  /** Zero-based active profiles from the same MSP_STATUS_EX snapshot. */
  readonly pidProfileIndex: number;
  readonly pidProfileCount: number;
  readonly controlRateProfileIndex: number;
  readonly pidRaw: Uint8Array;
  /**
   * Dynamic Idle floor, in units of 100 rpm. MSP_PID_ADVANCED offset 49.
   *
   * OFFSET DERIVATION, not a guess: summing Betaflight's own read order in
   * MSPHelper.js puts it at 49, and the same sum puts feedforwardRoll at 32 -
   * which is exactly where this file already reads it. The two agree, so the
   * offset model is confirmed against working code rather than asserted.
   *
   * Introduced in API 1.43. Only meaningful when bidirectional DShot is on:
   * without RPM telemetry the firmware has no rpm to hold a floor against,
   * which is why Betaflight disables the input in that case.
   */
  readonly idleMinRpm: number;
  readonly advancedRaw: Uint8Array;
  readonly ratesRaw: Uint8Array;
  readonly filtersRaw: Uint8Array;
}

function u16At(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

export function decodeRcTuning(payload: Uint8Array): MspRcTuning {
  // TOLERANT BY DESIGN, like Betaflight: it reads these fields
  // positionally with no length assertion, so a firmware that appends or
  // omits a trailing field still opens its PID tab. An exact-length gate
  // here meant a future Betaflight release would make PID tuning
  // unreachable rather than merely showing one unfamiliar value.
  return Object.freeze({
    ratesType: payload[22],
    rcRate: Object.freeze([payload[0], payload[12], payload[11]]) as readonly [number, number, number],
    expo: Object.freeze([payload[1], payload[13], payload[10]]) as readonly [number, number, number],
    superRate: Object.freeze([payload[2], payload[3], payload[4]]) as readonly [number, number, number],
    throttleMid: payload[6],
    throttleExpo: payload[7],
    throttleHover: payload[23],
    throttleLimitType: payload[14],
    throttleLimitPercent: payload[15],
    rateLimit: Object.freeze([u16At(payload, 16), u16At(payload, 18), u16At(payload, 20)]) as readonly [number, number, number],
  });
}

export function decodeFilterConfiguration(payload: Uint8Array): MspFilterConfiguration {
  // TOLERANT BY DESIGN, like Betaflight: it reads these fields
  // positionally with no length assertion, so a firmware that appends or
  // omits a trailing field still opens its PID tab. An exact-length gate
  // here meant a future Betaflight release would make PID tuning
  // unreachable rather than merely showing one unfamiliar value.
  return Object.freeze({
    gyroLpf1StaticHz: u16At(payload, 20),
    gyroLpf1DynamicMinHz: u16At(payload, 29),
    gyroLpf1DynamicMaxHz: u16At(payload, 31),
    dtermLpf1StaticHz: u16At(payload, 1),
    dtermLpf1DynamicMinHz: u16At(payload, 33),
    dtermLpf1DynamicMaxHz: u16At(payload, 35),
    dynamicNotchQ: u16At(payload, 39),
    dynamicNotchMinHz: u16At(payload, 41),
    dynamicNotchMaxHz: u16At(payload, 45),
    dynamicNotchCount: payload[48],
  });
}

export function decodePidTerms(payload: Uint8Array): readonly MspPidTerm[] {
  // TOLERANT BY DESIGN, like Betaflight: it reads these fields
  // positionally with no length assertion, so a firmware that appends or
  // omits a trailing field still opens its PID tab. An exact-length gate
  // here meant a future Betaflight release would make PID tuning
  // unreachable rather than merely showing one unfamiliar value.
  const reader = new MspPayloadReader(payload, {lenient: true});
  const terms: MspPidTerm[] = [];
  for (let index = 0; index < PID_ITEM_COUNT; index += 1) {
    terms.push(Object.freeze({p: reader.readU8(), i: reader.readU8(), d: reader.readU8()}));
  }
  return Object.freeze(terms);
}

export function decodePidTuningSnapshot(input: {
  readonly pid: Uint8Array;
  readonly advanced: Uint8Array;
  readonly rates: Uint8Array;
  readonly filters: Uint8Array;
  readonly gyroSampleRateHz?: number;
  readonly pidProcessDenom?: number;
  readonly pidProfileIndex: number;
  readonly pidProfileCount: number;
  readonly controlRateProfileIndex: number;
}): MspPidTuningSnapshot {
  if (input.advanced.length < PID_ADVANCED_API147_MIN_BYTES) {
    throw new MspPayloadReadError(`MSP_PID_ADVANCED requires at least ${PID_ADVANCED_API147_MIN_BYTES} bytes for API 1.47; received ${input.advanced.length}.`);
  }
  // MINIMUMS, not exact lengths - the same posture MSP_PID_ADVANCED above
  // already takes. Betaflight reads both of these positionally with version
  // gates and no length guard at all (MSPHelper.js, cases MSP_RC_TUNING and
  // MSP_FILTER_CONFIG), and both have grown across API versions - the
  // semver.lt(API_VERSION_1_45) branches in its own reader are the proof.
  // Demanding an exact length meant the next firmware to append one field
  // would have taken the whole PID screen down; enough bytes for the fields
  // this build reads is the real requirement.
  if (input.rates.length < RC_TUNING_API147_BYTES) {
    throw new MspPayloadReadError(`MSP_RC_TUNING requires at least ${RC_TUNING_API147_BYTES} bytes for API 1.47; received ${input.rates.length}.`);
  }
  if (input.filters.length < FILTER_CONFIG_API147_BYTES) {
    throw new MspPayloadReadError(`MSP_FILTER_CONFIG requires at least ${FILTER_CONFIG_API147_BYTES} bytes for API 1.47; received ${input.filters.length}.`);
  }
  if (!Number.isInteger(input.pidProfileIndex) || input.pidProfileIndex < 0 ||
    !Number.isInteger(input.pidProfileCount) || input.pidProfileCount < 1 ||
    input.pidProfileIndex >= input.pidProfileCount ||
    !Number.isInteger(input.controlRateProfileIndex) || input.controlRateProfileIndex < 0) {
    throw new MspPayloadReadError('MSP_STATUS_EX did not provide a valid PID/rates profile identity for API 1.47.');
  }
  return Object.freeze({
    terms: decodePidTerms(input.pid),
    feedforward: Object.freeze([u16At(input.advanced, 32), u16At(input.advanced, 34), u16At(input.advanced, 36)]) as readonly [number, number, number],
    rcTuning: decodeRcTuning(input.rates),
    filterConfig: decodeFilterConfiguration(input.filters),
    ...(input.gyroSampleRateHz !== undefined ? {gyroSampleRateHz: input.gyroSampleRateHz} : {}),
    ...(input.pidProcessDenom !== undefined ? {pidProcessDenom: input.pidProcessDenom} : {}),
    pidProfileIndex: input.pidProfileIndex,
    pidProfileCount: input.pidProfileCount,
    controlRateProfileIndex: input.controlRateProfileIndex,
    pidRaw: input.pid.slice(),
    idleMinRpm: input.advanced.length > IDLE_MIN_RPM_OFFSET
      ? input.advanced[IDLE_MIN_RPM_OFFSET]
      : 0,
    advancedRaw: input.advanced.slice(),
    ratesRaw: input.rates.slice(),
    filtersRaw: input.filters.slice(),
  });
}
