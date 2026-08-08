import {MspPayloadReadError, MspPayloadReader} from './MspPayloadReader';

export const PID_ITEM_COUNT = 5;
export const PID_AXIS_COUNT = 3;
export const PID_ADVANCED_API147_MIN_BYTES = 61;
export const RC_TUNING_API147_BYTES = 24;
export const FILTER_CONFIG_API147_BYTES = 49;

export interface MspPidTerm { readonly p: number; readonly i: number; readonly d: number }
export interface MspPidTuningSnapshot {
  readonly terms: readonly MspPidTerm[];
  readonly feedforward: readonly [number, number, number];
  readonly pidRaw: Uint8Array;
  readonly advancedRaw: Uint8Array;
  readonly ratesRaw: Uint8Array;
  readonly filtersRaw: Uint8Array;
}

function u16At(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
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
    pidRaw: input.pid.slice(),
    advancedRaw: input.advanced.slice(),
    ratesRaw: input.rates.slice(),
    filtersRaw: input.filters.slice(),
  });
}
