import type {MspPidTuningSnapshot} from '../decoding/decodePidTuning';
import type {PidTuningDraft} from '../../../state/pidTuningModel';
import {createPidTuningDraft, pidTuningDraftsEqual, validatePidTuningDraft} from '../../../state/pidTuningModel';

export type PidTuningWriteGroup = 'PID' | 'PID_ADVANCED';
export interface EncodedPidTuningWrite { readonly group: PidTuningWriteGroup; readonly payload: Uint8Array }

function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(offset, value, true);
}

export function encodeChangedPidTuning(snapshot: MspPidTuningSnapshot, draft: PidTuningDraft): readonly EncodedPidTuningWrite[] {
  if (validatePidTuningDraft(draft).length > 0) throw new RangeError('Invalid PID tuning draft.');
  if (pidTuningDraftsEqual(createPidTuningDraft(snapshot), draft)) return Object.freeze([]);
  const axes = [draft.roll, draft.pitch, draft.yaw] as const;
  const pid = snapshot.pidRaw.slice();
  axes.forEach((axis, index) => { const offset = index * 3; pid[offset] = axis.p; pid[offset + 1] = axis.i; pid[offset + 2] = axis.d; });
  const advanced = snapshot.advancedRaw.slice();
  axes.forEach((axis, index) => writeU16(advanced, 32 + index * 2, axis.f));
  const writes: EncodedPidTuningWrite[] = [];
  if (pid.some((value, index) => value !== snapshot.pidRaw[index])) writes.push(Object.freeze({group: 'PID', payload: pid}));
  if (advanced.some((value, index) => value !== snapshot.advancedRaw[index])) writes.push(Object.freeze({group: 'PID_ADVANCED', payload: advanced}));
  return Object.freeze(writes);
}
