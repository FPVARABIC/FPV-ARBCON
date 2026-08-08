import {MspPayloadReadError, MspPayloadReader} from './MspPayloadReader';

export const PID_ITEM_COUNT = 5;
export const PID_AXIS_COUNT = 3;
export const PID_ADVANCED_API147_MIN_BYTES = 61;
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
  readonly pidRaw: Uint8Array;
  readonly advancedRaw: Uint8Array;
  readonly ratesRaw: Uint8Array;
  readonly filtersRaw: Uint8Array;
}

function u16At(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

export function decodeRcTuning(payload: Uint8Array): MspRcTuning {
  if (payload.length !== RC_TUNING_API147_BYTES) {
    throw new MspPayloadReadError(`MSP_RC_TUNING requires ${RC_TUNING_API147_BYTES} bytes for API 1.47; received ${payload.length}.`);
  }
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
  if (payload.length !== FILTER_CONFIG_API147_BYTES) {
    throw new MspPayloadReadError(`MSP_FILTER_CONFIG requires ${FILTER_CONFIG_API147_BYTES} bytes for API 1.47; received ${payload.length}.`);
  }
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
  if (payload.length !== PID_ITEM_COUNT * 3) {
    throw new MspPayloadReadError(`MSP_PID requires 15 bytes; received ${payload.length}.`);
  }
  const reader = new MspPayloadReader(payload);
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
}): MspPidTuningSnapshot {
  if (input.advanced.length < PID_ADVANCED_API147_MIN_BYTES) {
    throw new MspPayloadReadError(`MSP_PID_ADVANCED requires at least ${PID_ADVANCED_API147_MIN_BYTES} bytes for API 1.47; received ${input.advanced.length}.`);
  }
  if (input.rates.length !== RC_TUNING_API147_BYTES) {
    throw new MspPayloadReadError(`MSP_RC_TUNING requires ${RC_TUNING_API147_BYTES} bytes for API 1.47; received ${input.rates.length}.`);
  }
  if (input.filters.length !== FILTER_CONFIG_API147_BYTES) {
    throw new MspPayloadReadError(`MSP_FILTER_CONFIG requires ${FILTER_CONFIG_API147_BYTES} bytes for API 1.47; received ${input.filters.length}.`);
  }
  return Object.freeze({
    terms: decodePidTerms(input.pid),
    feedforward: Object.freeze([u16At(input.advanced, 32), u16At(input.advanced, 34), u16At(input.advanced, 36)]) as readonly [number, number, number],
    rcTuning: decodeRcTuning(input.rates),
    filterConfig: decodeFilterConfiguration(input.filters),
    ...(input.gyroSampleRateHz !== undefined ? {gyroSampleRateHz: input.gyroSampleRateHz} : {}),
    ...(input.pidProcessDenom !== undefined ? {pidProcessDenom: input.pidProcessDenom} : {}),
    pidRaw: input.pid.slice(),
    advancedRaw: input.advanced.slice(),
    ratesRaw: input.rates.slice(),
    filtersRaw: input.filters.slice(),
  });
}
