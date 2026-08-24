/**
 * P-E: THE ADVANCED TIER REACHES THE WIRE, AND CANNOT LIE ON THE WAY.
 *
 * The two catalogue suites beside this one prove the offsets. This one
 * proves the wiring: that a moved advanced field produces a write, that it
 * produces only the write it should, that the draft refuses a value the
 * firmware would silently discard, and that the fields the simplified
 * generator owns are still refused now that the expert tier can reach
 * them.
 */

import {decodePidTuningSnapshot} from '../protocol/msp/decoding/decodePidTuning';
import {decodeSimplifiedTuning} from '../protocol/msp/decoding/decodeSimplifiedTuning';
import {encodeChangedPidTuning} from '../protocol/msp/encoding/encodePidTuning';
import {SIMPLIFIED_TUNING_FIXTURE} from '../protocol/__testUtils__/pidWireFixtures';
import {createPidTuningDraft, pidTuningDraftsEqual, validatePidTuningDraft} from './pidTuningModel';
import {detectSimplifiedConflict} from './pidWriteVerification';

/** A coherent board: valid rates, a filter set nothing has to correct. */
function snapshot() {
  const pid = Uint8Array.from([42, 85, 35, 46, 90, 38, 45, 80, 0, 50, 50, 75, 40, 0, 0]);
  const advanced = new Uint8Array(61);
  const advancedView = new DataView(advanced.buffer);
  advancedView.setUint16(32, 120, true);
  advancedView.setUint16(34, 130, true);
  advancedView.setUint16(36, 140, true);
  advanced[39] = 47; advanced[40] = 48; advanced[41] = 0; // d_max
  advanced[42] = 37; advanced[43] = 20; // d_max gain, advance
  advanced[47] = 100; // motor_output_limit
  advanced[57] = 1; advanced[58] = 65; // tpa mode, rate
  advancedView.setUint16(59, 1350, true); // tpa_breakpoint
  const rates = new Uint8Array(24);
  rates[0] = 100; rates[12] = 100; rates[11] = 100;
  rates[2] = 70; rates[3] = 70; rates[4] = 70;
  rates[6] = 50; rates[15] = 100; rates[23] = 50;
  const ratesView = new DataView(rates.buffer);
  ratesView.setUint16(16, 1998, true);
  ratesView.setUint16(18, 1998, true);
  ratesView.setUint16(20, 1998, true);
  const filters = new Uint8Array(49);
  const filterView = new DataView(filters.buffer);
  filterView.setUint16(22, 500, true); // gyro_lpf2_static_hz
  filters[24] = 0; filters[25] = 0; // lowpass types
  return decodePidTuningSnapshot({
    pid,
    advanced,
    rates,
    filters,
    gyroSampleRateHz: 8000,
    pidProcessDenom: 2,
    pidProfileIndex: 0,
    pidProfileCount: 3,
    controlRateProfileIndex: 0,
  });
}

describe('the advanced tier in the draft', () => {
  it('is part of the draft, so reading the screen alone changes nothing', () => {
    const original = snapshot();
    const draft = createPidTuningDraft(original);
    expect(pidTuningDraftsEqual(createPidTuningDraft(original), draft)).toBe(true);
    expect(encodeChangedPidTuning(original, draft)).toEqual([]);
  });

  it('counts as dirty when only an advanced field moves', () => {
    const original = snapshot();
    const base = createPidTuningDraft(original);
    const moved = {...base, advanced: {...base.advanced, dMaxGain: 45}};
    expect(pidTuningDraftsEqual(base, moved)).toBe(false);
  });

  it('emits ONLY a PID_ADVANCED write for an advanced PID edit', () => {
    const original = snapshot();
    const base = createPidTuningDraft(original);
    const writes = encodeChangedPidTuning(original, {
      ...base,
      advanced: {...base.advanced, itermRelaxCutoff: 20, motorOutputLimit: 90},
    });
    expect(writes.map(write => write.group)).toEqual(['PID_ADVANCED']);
    expect(writes[0].payload[46]).toBe(20);
    expect(writes[0].payload[47]).toBe(90);
  });

  it('emits ONLY a FILTER_CONFIG write for an advanced filter edit', () => {
    const original = snapshot();
    const base = createPidTuningDraft(original);
    const writes = encodeChangedPidTuning(original, {
      ...base,
      advancedFilters: {...base.advancedFilters, gyroLpf2StaticHz: 480, dtermLpf2Type: 2},
    });
    expect(writes.map(write => write.group)).toEqual(['FILTER_CONFIG']);
    const payload = writes[0].payload;
    expect(new DataView(payload.buffer, payload.byteOffset).getUint16(22, true)).toBe(480);
    expect(payload[28]).toBe(2);
  });

  it('leaves every byte it does not own byte-identical', () => {
    const original = snapshot();
    const base = createPidTuningDraft(original);
    const [write] = encodeChangedPidTuning(original, {
      ...base,
      advanced: {...base.advanced, throttleBoost: 15},
    });
    const changed = [...write.payload]
      .map((value, index) => (value === original.advancedRaw[index] ? undefined : index))
      .filter(index => index !== undefined);
    expect(changed).toEqual([30]);
  });

  it('refuses a moved advanced value outside the firmware bound', () => {
    const original = snapshot();
    const base = createPidTuningDraft(original);
    const issues = validatePidTuningDraft(
      {...base, advanced: {...base.advanced, dMaxGain: 101}},
      original,
    );
    expect(issues).toContain('ADVANCED_PID_VALUE_INVALID');
    expect(() =>
      encodeChangedPidTuning(original, {...base, advanced: {...base.advanced, dMaxGain: 101}}),
    ).toThrow(RangeError);
  });

  it('refuses a moved advanced FILTER value outside the firmware bound', () => {
    const original = snapshot();
    const base = createPidTuningDraft(original);
    const issues = validatePidTuningDraft(
      {...base, advancedFilters: {...base.advancedFilters, yawLowpassHz: 900}},
      original,
    );
    expect(issues).toContain('ADVANCED_FILTER_VALUE_INVALID');
  });

  it('refuses a D-term notch whose cutoff has swallowed its centre', () => {
    // The firmware would take this value, hand it back unchanged, and then
    // zero the centre at the next EEPROM write - `validateAndFixConfig`,
    // which an MSP filter write never calls. There is no readback verdict
    // that reports that honestly, so the draft refuses it instead.
    const original = snapshot();
    const base = createPidTuningDraft(original);
    const issues = validatePidTuningDraft(
      {
        ...base,
        advancedFilters: {...base.advancedFilters, dtermNotchHz: 200, dtermNotchCutoff: 200},
      },
      original,
    );
    expect(issues).toContain('FILTER_ORDER_INVALID');
  });

  it('still allows switching the D-term notch OFF by its centre frequency', () => {
    const original = snapshot();
    const base = createPidTuningDraft(original);
    const issues = validatePidTuningDraft(
      {
        ...base,
        advancedFilters: {...base.advancedFilters, dtermNotchHz: 0, dtermNotchCutoff: 160},
      },
      original,
    );
    expect(issues).not.toContain('FILTER_ORDER_INVALID');
  });
});

describe('the simplified generator still owns what it owns', () => {
  const simplified = decodeSimplifiedTuning(SIMPLIFIED_TUNING_FIXTURE);

  it('refuses a direct D Max edit, which P-E made reachable for the first time', () => {
    // `simplifiedOwnedFields` has always listed ROLL/PITCH/YAW.D_MAX -
    // the firmware rewrites d_max[axis] from the sliders. Until P-E no
    // control could produce that edit, so the refusal was unreachable.
    const conflict = detectSimplifiedConflict(['ROLL.D_MAX'], simplified, []);
    expect(conflict?.conflictingEdits).toEqual(['ROLL.D_MAX']);
  });

  it('refuses a direct SECOND-lowpass edit while the group is enabled', () => {
    expect(detectSimplifiedConflict([], simplified, ['gyroLpf2StaticHz'])?.conflictingEdits)
      .toEqual(['gyroLpf2StaticHz']);
    expect(detectSimplifiedConflict([], simplified, ['dtermLpf2StaticHz'])?.conflictingEdits)
      .toEqual(['dtermLpf2StaticHz']);
  });

  it('does not claim ownership of the advanced fields the generator never writes', () => {
    // d_max_gain and d_max_advance are STORED fields the generator reads
    // nothing from: it uses `simplified_d_max_gain`, a different byte. A
    // conflict here would be a refusal with no cause.
    expect(detectSimplifiedConflict(['dMaxGain'], simplified, [])).toBeUndefined();
    expect(detectSimplifiedConflict([], simplified, ['dtermNotchHz'])).toBeUndefined();
    expect(detectSimplifiedConflict([], simplified, ['gyroSoftNotchHz2'])).toBeUndefined();
  });

  it('refuses nothing at all once the generator is switched off', () => {
    const bytes = Uint8Array.from(SIMPLIFIED_TUNING_FIXTURE);
    bytes[0] = 0; // simplified_pids_mode = OFF
    bytes[19] = 0; // dterm block disabled
    bytes[35] = 0; // gyro block disabled
    const off = decodeSimplifiedTuning(bytes);
    expect(detectSimplifiedConflict(['ROLL.D_MAX'], off, ['gyroLpf2StaticHz'])).toBeUndefined();
  });
});
