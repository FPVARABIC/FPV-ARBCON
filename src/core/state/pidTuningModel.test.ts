import {decodePidTuningSnapshot} from '../protocol/msp/decoding/decodePidTuning';
import {encodeChangedPidTuning} from '../protocol/msp/encoding/encodePidTuning';
import {createPidTuningDraft, pidTuningDraftsEqual, pidTuningSnapshotsEqual, validatePidTuningDraft} from './pidTuningModel';

function snapshot() {
  const pid = Uint8Array.from([42, 85, 35, 46, 90, 38, 45, 80, 0, 50, 50, 75, 40, 0, 0]);
  const advanced = Uint8Array.from({length: 64}, (_, index) => (index * 7) % 256);
  new DataView(advanced.buffer).setUint16(32, 120, true); new DataView(advanced.buffer).setUint16(34, 130, true); new DataView(advanced.buffer).setUint16(36, 140, true);
  const rates = new Uint8Array(24);
  rates[0] = 100; rates[12] = 100; rates[11] = 100;
  rates[2] = 70; rates[3] = 70; rates[4] = 70;
  rates[6] = 50; rates[15] = 100; rates[23] = 50;
  const ratesView = new DataView(rates.buffer);
  ratesView.setUint16(16, 1998, true); ratesView.setUint16(18, 1998, true); ratesView.setUint16(20, 1998, true);
  return decodePidTuningSnapshot({
    // A 49-byte MSP_FILTER_CONFIG is the API 1.47 contract.
    contract: 'API_1_47',
    pid,
    advanced,
    rates,
    filters: new Uint8Array(49),
    gyroSampleRateHz: 8000,
    pidProcessDenom: 2,
    pidProfileIndex: 0,
    pidProfileCount: 3,
    controlRateProfileIndex: 0,
  });
}

function dynamicFilterSnapshot() {
  const base = snapshot(); const filters = base.filtersRaw.slice(); const view = new DataView(filters.buffer);
  view.setUint16(29, 180, true); view.setUint16(31, 420, true);
  view.setUint16(33, 90, true); view.setUint16(35, 180, true);
  view.setUint16(39, 300, true); view.setUint16(41, 100, true); view.setUint16(45, 600, true); filters[48] = 3;
  return decodePidTuningSnapshot({contract: 'API_1_47', pid: base.pidRaw, advanced: base.advancedRaw, rates: base.ratesRaw, filters, gyroSampleRateHz: 8000, pidProcessDenom: 2, pidProfileIndex: 0, pidProfileCount: 3, controlRateProfileIndex: 0});
}

describe('PID tuning model and encoder', () => {
  it('maps only Roll/Pitch/Yaw and keeps LEVEL/MAG hidden from the draft', () => {
    expect(createPidTuningDraft(snapshot())).toEqual(expect.objectContaining({
      roll: {p: 42, i: 85, d: 35, f: 120},
      pitch: {p: 46, i: 90, d: 38, f: 130},
      yaw: {p: 45, i: 80, d: 0, f: 140},
      rates: expect.objectContaining({
        type: 0,
        roll: {rcRate: 100, superRate: 70, expo: 0, limit: 1998},
      }),
      filters: expect.objectContaining({gyroLpf1StaticHz: 0, dynamicNotchCount: 0}),
    }));
  });

  it('patches only reviewed rates and filter offsets while preserving opaque bytes', () => {
    const original = snapshot();
    const base = createPidTuningDraft(original);
    const draft = {
      ...base,
      rates: {...base.rates, roll: {...base.rates.roll, rcRate: 120, limit: 900}},
      filters: {...base.filters, gyroLpf1StaticHz: 300},
    };
    const writes = encodeChangedPidTuning(original, draft);
    expect(writes.map(write => write.group)).toEqual(['RC_TUNING', 'FILTER_CONFIG']);
    const rates = writes[0].payload;
    expect(rates[0]).toBe(120);
    expect(new DataView(rates.buffer, rates.byteOffset, rates.byteLength).getUint16(16, true)).toBe(900);
    for (let index = 0; index < rates.length; index += 1) {
      if (index !== 0 && index !== 16 && index !== 17) expect(rates[index]).toBe(original.ratesRaw[index]);
    }
    const filters = writes[1].payload;
    expect(filters[0]).toBe(44);
    expect(new DataView(filters.buffer, filters.byteOffset, filters.byteLength).getUint16(20, true)).toBe(300);
    for (let index = 0; index < filters.length; index += 1) {
      if (index !== 0 && index !== 20 && index !== 21) expect(filters[index]).toBe(original.filtersRaw[index]);
    }
  });

  it('edits already-active dynamic filter fields at the pinned MSP offsets', () => {
    const original = dynamicFilterSnapshot(); const base = createPidTuningDraft(original);
    const draft = {...base, filters: {...base.filters, gyroLpf1DynamicMinHz: 200, dtermLpf1DynamicMaxHz: 190, dynamicNotchQ: 350, dynamicNotchCount: 4}};
    expect(validatePidTuningDraft(draft, original)).toEqual([]);
    const writes = encodeChangedPidTuning(original, draft);
    expect(writes.map(write => write.group)).toEqual(['FILTER_CONFIG']);
    const view = new DataView(writes[0].payload.buffer, writes[0].payload.byteOffset, writes[0].payload.byteLength);
    expect(view.getUint16(29, true)).toBe(200);
    expect(view.getUint16(35, true)).toBe(190);
    expect(view.getUint16(39, true)).toBe(350);
    expect(writes[0].payload[48]).toBe(4);
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

  it('treats an active PID or Rates profile switch as a stale snapshot', () => {
    const original = snapshot();
    expect(pidTuningDraftsEqual(createPidTuningDraft(original), createPidTuningDraft({...original, pidProfileIndex: 1}))).toBe(true);
    expect(pidTuningSnapshotsEqual(original, {...original, pidProfileIndex: 1})).toBe(false);
    expect(pidTuningSnapshotsEqual(original, {...original, controlRateProfileIndex: 1})).toBe(false);
  });

  it('applies the selected Betaflight rate algorithm limits', () => {
    const original = snapshot(); const draft = createPidTuningDraft(original);
    expect(validatePidTuningDraft({...draft, rates: {...draft.rates, type: 3, roll: {...draft.rates.roll, rcRate: 201}}})).toContain('RATE_VALUE_INVALID');
    expect(validatePidTuningDraft({...draft, rates: {...draft.rates, type: 99}})).toContain('RATES_TYPE_INVALID');
    expect(validatePidTuningDraft({...draft, rates: {...draft.rates, type: 3}}, original)).toContain('RATES_TYPE_CHANGE_UNSUPPORTED');
    expect(validatePidTuningDraft({...draft, rates: {...draft.rates, throttleLimitPercent: 24}})).toContain('THROTTLE_CURVE_INVALID');
  });

  it('rejects filter edits without sample-rate evidence or above Nyquist', () => {
    const original = snapshot(); const draft = createPidTuningDraft(original);
    const noEvidence = {...original, gyroSampleRateHz: undefined, pidProcessDenom: undefined};
    expect(validatePidTuningDraft({...draft, filters: {...draft.filters, gyroLpf1StaticHz: 300}}, noEvidence)).toContain('FILTER_RATE_UNKNOWN');
    expect(validatePidTuningDraft({...draft, filters: {...draft.filters, dtermLpf1StaticHz: 2000}}, original)).toContain('FILTER_VALUE_INVALID');
    expect(validatePidTuningDraft({...draft, filters: {...draft.filters, dtermLpf1StaticHz: 1000}}, {...original, gyroSampleRateHz: 2000, pidProcessDenom: 2})).toContain('FILTER_EXCEEDS_NYQUIST');
  });

  it('does not enable an unproven dynamic filter capability through a forged draft', () => {
    const original = snapshot(); const draft = createPidTuningDraft(original);
    expect(validatePidTuningDraft({...draft, filters: {...draft.filters, gyroLpf1DynamicMinHz: 100, gyroLpf1DynamicMaxHz: 400}}, original)).toContain('FILTER_CAPABILITY_UNPROVEN');
    expect(validatePidTuningDraft({...draft, filters: {...draft.filters, dynamicNotchCount: 3, dynamicNotchQ: 300, dynamicNotchMinHz: 100, dynamicNotchMaxHz: 600}}, original)).toContain('FILTER_CAPABILITY_UNPROVEN');
  });
});
