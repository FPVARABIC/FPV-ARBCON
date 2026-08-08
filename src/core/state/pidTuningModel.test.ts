import {decodePidTuningSnapshot} from '../protocol/msp/decoding/decodePidTuning';
import {encodeChangedPidTuning} from '../protocol/msp/encoding/encodePidTuning';
import {createPidTuningDraft, pidTuningDraftsEqual, validatePidTuningDraft} from './pidTuningModel';

function snapshot() {
  const pid = Uint8Array.from([42, 85, 35, 46, 90, 38, 45, 80, 0, 50, 50, 75, 40, 0, 0]);
  const advanced = Uint8Array.from({length: 64}, (_, index) => (index * 7) % 256);
  new DataView(advanced.buffer).setUint16(32, 120, true); new DataView(advanced.buffer).setUint16(34, 130, true); new DataView(advanced.buffer).setUint16(36, 140, true);
  return decodePidTuningSnapshot({pid, advanced, rates: new Uint8Array(24), filters: new Uint8Array(49)});
}

describe('PID tuning model and encoder', () => {
  it('maps only Roll/Pitch/Yaw and keeps LEVEL/MAG hidden from the draft', () => {
    expect(createPidTuningDraft(snapshot())).toEqual({roll: {p: 42, i: 85, d: 35, f: 120}, pitch: {p: 46, i: 90, d: 38, f: 130}, yaw: {p: 45, i: 80, d: 0, f: 140}});
  });

  it('patches only selected PID and feedforward bytes and preserves all other payload bytes', () => {
    const original = snapshot(); const base = createPidTuningDraft(original);
    const draft = {...base, roll: {...base.roll, p: 50}, yaw: {...base.yaw, f: 222}};
    const writes = encodeChangedPidTuning(original, draft);
    expect(writes.map(write => write.group)).toEqual(['PID', 'PID_ADVANCED']);
    const pid = writes[0].payload; expect(pid[0]).toBe(50); expect(pid.slice(1)).toEqual(original.pidRaw.slice(1));
    const advanced = writes[1].payload; expect(new DataView(advanced.buffer, advanced.byteOffset, advanced.byteLength).getUint16(36, true)).toBe(222);
    for (let index = 0; index < advanced.length; index += 1) if (index < 36 || index > 37) expect(advanced[index]).toBe(original.advancedRaw[index]);
  });

  it('uses Betaflight official gain limits and emits no write for an unchanged draft', () => {
    const original = snapshot(); const draft = createPidTuningDraft(original);
    expect(pidTuningDraftsEqual(draft, draft)).toBe(true); expect(encodeChangedPidTuning(original, draft)).toEqual([]);
    expect(validatePidTuningDraft({...draft, roll: {...draft.roll, p: 251}})).toContain('PID_GAIN_INVALID');
    expect(validatePidTuningDraft({...draft, yaw: {...draft.yaw, f: 1001}})).toContain('FEEDFORWARD_INVALID');
  });
});
