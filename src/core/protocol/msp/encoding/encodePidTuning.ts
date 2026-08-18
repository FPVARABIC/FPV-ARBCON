import type {MspPidTuningSnapshot} from '../decoding/decodePidTuning';
import {IDLE_MIN_RPM_OFFSET, FEEDFORWARD_AVERAGING_OFFSET, FEEDFORWARD_BOOST_OFFSET, FEEDFORWARD_JITTER_FACTOR_OFFSET} from '../decoding/decodePidTuning';
import type {PidTuningDraft} from '../../../state/pidTuningModel';
import {createPidTuningDraft, pidTuningDraftsEqual, validatePidTuningDraft} from '../../../state/pidTuningModel';

export type PidTuningWriteGroup = 'PID' | 'PID_ADVANCED' | 'RC_TUNING' | 'FILTER_CONFIG';
export interface EncodedPidTuningWrite { readonly group: PidTuningWriteGroup; readonly payload: Uint8Array }

function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(offset, value, true);
}

export function encodeChangedPidTuning(snapshot: MspPidTuningSnapshot, draft: PidTuningDraft): readonly EncodedPidTuningWrite[] {
  if (validatePidTuningDraft(draft, snapshot).length > 0) throw new RangeError('Invalid PID tuning draft.');
  if (pidTuningDraftsEqual(createPidTuningDraft(snapshot), draft)) return Object.freeze([]);
  const axes = [draft.roll, draft.pitch, draft.yaw] as const;
  const pid = snapshot.pidRaw.slice();
  axes.forEach((axis, index) => { const offset = index * 3; pid[offset] = axis.p; pid[offset + 1] = axis.i; pid[offset + 2] = axis.d; });
  const advanced = snapshot.advancedRaw.slice();
  axes.forEach((axis, index) => writeU16(advanced, 32 + index * 2, axis.f));
  // Patched into a CLONE of the payload the board just sent, like every other
  // field here, so the ~60 bytes this screen does not own are returned
  // byte-for-byte. A PID_ADVANCED write is emitted below only if some byte
  // actually changed, so reading this screen never rewrites tuning.
  if (advanced.length > IDLE_MIN_RPM_OFFSET) advanced[IDLE_MIN_RPM_OFFSET] = draft.idleMinRpm;
  // Patched into the board's OWN payload, like every other field here, so
  // a byte this app does not understand is written back untouched.
  if (advanced.length > FEEDFORWARD_AVERAGING_OFFSET) advanced[FEEDFORWARD_AVERAGING_OFFSET] = draft.feedforwardAveraging;
  if (advanced.length > FEEDFORWARD_BOOST_OFFSET) advanced[FEEDFORWARD_BOOST_OFFSET] = draft.feedforwardBoost;
  if (advanced.length > FEEDFORWARD_JITTER_FACTOR_OFFSET) advanced[FEEDFORWARD_JITTER_FACTOR_OFFSET] = draft.feedforwardJitterFactor;
  const rates = snapshot.ratesRaw.slice();
  rates[0] = draft.rates.roll.rcRate;
  rates[12] = draft.rates.pitch.rcRate;
  rates[11] = draft.rates.yaw.rcRate;
  rates[1] = draft.rates.roll.expo;
  rates[13] = draft.rates.pitch.expo;
  rates[10] = draft.rates.yaw.expo;
  rates[2] = draft.rates.roll.superRate;
  rates[3] = draft.rates.pitch.superRate;
  rates[4] = draft.rates.yaw.superRate;
  rates[6] = draft.rates.throttleMid;
  rates[7] = draft.rates.throttleExpo;
  rates[14] = draft.rates.throttleLimitType;
  rates[15] = draft.rates.throttleLimitPercent;
  writeU16(rates, 16, draft.rates.roll.limit);
  writeU16(rates, 18, draft.rates.pitch.limit);
  writeU16(rates, 20, draft.rates.yaw.limit);
  rates[22] = draft.rates.type;
  rates[23] = draft.rates.throttleHover;
  const filters = snapshot.filtersRaw.slice();
  // API 1.47 still carries the legacy u8 Gyro LPF1 value at byte 0 before
  // the authoritative u16 copy at bytes 20-21. Betaflight's setter reads
  // both, in that order. Keep the duplicate coherent instead of sending a
  // transiently conflicting payload; the u8 assignment keeps the official
  // configurator's legacy low-byte encoding while the later u16 stays exact.
  filters[0] = draft.filters.gyroLpf1StaticHz % 256;
  writeU16(filters, 20, draft.filters.gyroLpf1StaticHz);
  writeU16(filters, 29, draft.filters.gyroLpf1DynamicMinHz);
  writeU16(filters, 31, draft.filters.gyroLpf1DynamicMaxHz);
  writeU16(filters, 1, draft.filters.dtermLpf1StaticHz);
  writeU16(filters, 33, draft.filters.dtermLpf1DynamicMinHz);
  writeU16(filters, 35, draft.filters.dtermLpf1DynamicMaxHz);
  writeU16(filters, 39, draft.filters.dynamicNotchQ);
  writeU16(filters, 41, draft.filters.dynamicNotchMinHz);
  writeU16(filters, 45, draft.filters.dynamicNotchMaxHz);
  filters[48] = draft.filters.dynamicNotchCount;
  const writes: EncodedPidTuningWrite[] = [];
  if (pid.some((value, index) => value !== snapshot.pidRaw[index])) writes.push(Object.freeze({group: 'PID', payload: pid}));
  if (advanced.some((value, index) => value !== snapshot.advancedRaw[index])) writes.push(Object.freeze({group: 'PID_ADVANCED', payload: advanced}));
  if (rates.some((value, index) => value !== snapshot.ratesRaw[index])) writes.push(Object.freeze({group: 'RC_TUNING', payload: rates}));
  if (filters.some((value, index) => value !== snapshot.filtersRaw[index])) writes.push(Object.freeze({group: 'FILTER_CONFIG', payload: filters}));
  return Object.freeze(writes);
}
