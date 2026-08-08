import type {MspPidTuningSnapshot} from '../protocol/msp/decoding/decodePidTuning';

export type PidAxisKey = 'roll' | 'pitch' | 'yaw';
export interface PidAxisDraft { readonly p: number; readonly i: number; readonly d: number; readonly f: number }
export interface PidTuningDraft { readonly roll: PidAxisDraft; readonly pitch: PidAxisDraft; readonly yaw: PidAxisDraft }
export type PidTuningValidationCode = 'PID_GAIN_INVALID' | 'FEEDFORWARD_INVALID';

const AXES = Object.freeze(['roll', 'pitch', 'yaw'] as const);

export function createPidTuningDraft(snapshot: MspPidTuningSnapshot): PidTuningDraft {
  const axis = (index: number): PidAxisDraft => Object.freeze({
    p: snapshot.terms[index].p,
    i: snapshot.terms[index].i,
    d: snapshot.terms[index].d,
    f: snapshot.feedforward[index],
  });
  return Object.freeze({roll: axis(0), pitch: axis(1), yaw: axis(2)});
}

export function pidTuningDraftsEqual(a: PidTuningDraft, b: PidTuningDraft): boolean {
  return AXES.every(key => a[key].p === b[key].p && a[key].i === b[key].i && a[key].d === b[key].d && a[key].f === b[key].f);
}

export function pidTuningSnapshotsEqual(a: MspPidTuningSnapshot, b: MspPidTuningSnapshot): boolean {
  return a.pidRaw.length === b.pidRaw.length && a.pidRaw.every((value, index) => value === b.pidRaw[index]) &&
    a.advancedRaw.length === b.advancedRaw.length && a.advancedRaw.every((value, index) => value === b.advancedRaw[index]) &&
    a.ratesRaw.length === b.ratesRaw.length && a.ratesRaw.every((value, index) => value === b.ratesRaw[index]) &&
    a.filtersRaw.length === b.filtersRaw.length && a.filtersRaw.every((value, index) => value === b.filtersRaw[index]);
}

export function validatePidTuningDraft(draft: PidTuningDraft): readonly PidTuningValidationCode[] {
  const issues = new Set<PidTuningValidationCode>();
  for (const key of AXES) {
    const value = draft[key];
    if ([value.p, value.i, value.d].some(gain => !Number.isInteger(gain) || gain < 0 || gain > 250)) issues.add('PID_GAIN_INVALID');
    if (!Number.isInteger(value.f) || value.f < 0 || value.f > 1000) issues.add('FEEDFORWARD_INVALID');
  }
  return Object.freeze([...issues]);
}
