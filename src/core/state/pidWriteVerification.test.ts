/**
 * WHAT A READBACK PROVES, FIELD BY FIELD.
 *
 * P-B built the classifiers; this exercises the judgements they make, using
 * the hand-written wire fixtures rather than anything our own encoder
 * produced. Three questions run through all of it:
 *
 *   which fields does a write OWN, and therefore have to account for;
 *   which differences does a firmware rule EXPLAIN;
 *   and which differences does nothing explain, and must never be reported
 *   as a save.
 */

import {decodePidAdvancedFull, PID_ADVANCED_OFFSETS} from '../protocol/msp/decoding/decodePidAdvancedFull';
import {decodeFilterConfigFull, FILTER_CONFIG_OFFSETS} from '../protocol/msp/decoding/decodeFilterConfigFull';
import {decodeSimplifiedTuning} from '../protocol/msp/decoding/decodeSimplifiedTuning';
import {
  FILTER_CONFIG_API147_FIXTURE,
  PID_ADVANCED_FIXTURE,
  MSP_PID_FIXTURE,
  SIMPLIFIED_TUNING_FIXTURE,
} from '../protocol/__testUtils__/pidWireFixtures';
import {
  classifyAdvancedConfigSideEffects,
  classifyPidReadback,
  classifySimplifiedReadback,
  detectSimplifiedConflict,
  MOTOR_PROTOCOL_DSHOT300,
  MOTOR_PROTOCOL_DSHOT600,
  projectSimplifiedWrite,
  simplifiedOwnedFields,
} from './pidWriteVerification';

const CONTRACT = 'API_1_47' as const;

function mutate(source: Uint8Array, index: number, value: number): Uint8Array {
  const copy = Uint8Array.from(source);
  copy[index] = value;
  return copy;
}

describe('MSP_PID readback covers all five items, not just the three axes', () => {
  it('accepts an exact echo of every one of the fifteen bytes', () => {
    expect(classifyPidReadback(MSP_PID_FIXTURE, MSP_PID_FIXTURE)).toEqual({kind: 'EXACT'});
  });

  it.each([
    [0, 'ROLL.P'], [4, 'PITCH.I'], [8, 'YAW.D'],
    // LEVEL and MAG are NOT edited by this screen, which is exactly why a
    // board that changed them underneath a PID write has to be caught.
    [9, 'LEVEL.P'], [11, 'LEVEL.D'], [12, 'MAG.P'], [14, 'MAG.D'],
  ])('catches a board that changed byte %i (%s)', (index, field) => {
    const observed = mutate(MSP_PID_FIXTURE, index, MSP_PID_FIXTURE[index] + 1);
    const verdict = classifyPidReadback(MSP_PID_FIXTURE, observed);

    expect(verdict.kind).toBe('MISMATCH');
    if (verdict.kind !== 'MISMATCH') throw new Error(verdict.kind);
    expect(verdict.fields.map(entry => entry.field)).toEqual([field]);
  });
});

describe('a filter write reaches outside this screen, and the DIRECTION decides', () => {
  const before = {pidProcessDenom: 1, motorProtocolRaw: MOTOR_PROTOCOL_DSHOT600, motorPwmRate: 480};

  it('sees nothing when nothing moved', () => {
    const report = classifyAdvancedConfigSideEffects(before, before);
    expect(report.changes).toEqual([]);
    expect(report.unexpected).toEqual([]);
    expect(report.requiresReobserve).toEqual([]);
  });

  it('explains the three corrections the gyro validation is allowed to make', () => {
    const report = classifyAdvancedConfigSideEffects(before, {
      pidProcessDenom: 2,
      motorProtocolRaw: MOTOR_PROTOCOL_DSHOT300,
      motorPwmRate: 240,
    });

    expect(report.changes.map(change => change.truth)).toEqual([
      'PID_PROCESS_DENOM', 'MOTOR_PROTOCOL', 'MOTOR_PWM_RATE',
    ]);
    expect(report.unexpected).toEqual([]);
    // Expected does NOT mean ignorable: all three are now stale elsewhere.
    expect(report.requiresReobserve).toHaveLength(3);
  });

  it('refuses to explain a process denom that FELL', () => {
    const report = classifyAdvancedConfigSideEffects({...before, pidProcessDenom: 4}, {...before, pidProcessDenom: 2});
    expect(report.unexpected.map(change => change.truth)).toEqual(['PID_PROCESS_DENOM']);
  });

  it('refuses to explain a PWM rate that ROSE', () => {
    const report = classifyAdvancedConfigSideEffects(before, {...before, motorPwmRate: 960});
    expect(report.unexpected.map(change => change.truth)).toEqual(['MOTOR_PWM_RATE']);
  });

  it('explains only the DSHOT600 to DSHOT300 downgrade, not any protocol change', () => {
    const upgraded = classifyAdvancedConfigSideEffects(
      {...before, motorProtocolRaw: MOTOR_PROTOCOL_DSHOT300},
      {...before, motorProtocolRaw: MOTOR_PROTOCOL_DSHOT600},
    );
    expect(upgraded.unexpected.map(change => change.truth)).toEqual(['MOTOR_PROTOCOL']);

    const sideways = classifyAdvancedConfigSideEffects(before, {...before, motorProtocolRaw: 0});
    expect(sideways.unexpected.map(change => change.truth)).toEqual(['MOTOR_PROTOCOL']);
  });
});

describe('what an active simplified generator owns', () => {
  const simplified = decodeSimplifiedTuning(SIMPLIFIED_TUNING_FIXTURE);

  it('owns yaw in the RPY mode', () => {
    const owned = simplifiedOwnedFields(simplified);
    expect(owned).toContain('ROLL.P');
    expect(owned).toContain('YAW.P');
    expect(owned).toContain('YAW.I');
  });

  it('does NOT own yaw in the roll/pitch mode', () => {
    const rollPitchOnly = decodeSimplifiedTuning(mutate(SIMPLIFIED_TUNING_FIXTURE, 0, 1));
    const owned = simplifiedOwnedFields(rollPitchOnly);

    expect(owned).toContain('ROLL.P');
    expect(owned).toContain('PITCH.P');
    expect(owned.filter(field => field.startsWith('YAW'))).toEqual([]);
  });

  it('owns nothing at all when the generator is off', () => {
    const off = decodeSimplifiedTuning(mutate(SIMPLIFIED_TUNING_FIXTURE, 0, 0));
    expect(simplifiedOwnedFields(off)).toEqual([]);
  });

  it('reports a direct PID edit that the generator would overwrite', () => {
    const conflict = detectSimplifiedConflict(['ROLL.P'], simplified, []);
    expect(conflict?.conflictingEdits).toEqual(['ROLL.P']);
  });

  it('reports a FILTER edit that the generator would overwrite too', () => {
    // The gyro and D-term blocks are enabled in the fixture, so their
    // frequencies are generated - and an edit to one of them is just as
    // doomed as an edit to a PID gain. A conflict check that only looked at
    // PID gains would let it through.
    const conflict = detectSimplifiedConflict([], simplified, ['gyroLpf1StaticHz']);
    expect(conflict?.conflictingEdits).toEqual(['gyroLpf1StaticHz']);

    const dterm = detectSimplifiedConflict([], simplified, ['dtermLpf1StaticHz']);
    expect(dterm?.conflictingEdits).toEqual(['dtermLpf1StaticHz']);
  });

  it('reports no conflict for a field nothing generates', () => {
    expect(detectSimplifiedConflict([], simplified, ['gyroLpf1DynMaxHz'])).toBeDefined();
    const off = decodeSimplifiedTuning(mutate(SIMPLIFIED_TUNING_FIXTURE, 35, 0));
    expect(detectSimplifiedConflict([], off, ['gyroLpf1StaticHz'])).toBeUndefined();
  });
});

describe('a simplified readback is judged on the OUTPUTS, not the echo', () => {
  const requested = decodeSimplifiedTuning(SIMPLIFIED_TUNING_FIXTURE);
  const projection = projectSimplifiedWrite(requested);

  /** A board that generated exactly what our reimplementation predicts. */
  function obedientBoard() {
    const pid = Uint8Array.from(MSP_PID_FIXTURE);
    const advanced = Uint8Array.from(PID_ADVANCED_FIXTURE);
    const advancedView = new DataView(advanced.buffer);
    projection.axes.forEach((axis, index) => {
      pid[index * 3] = axis.p;
      pid[index * 3 + 1] = axis.i;
      pid[index * 3 + 2] = axis.d;
      advancedView.setUint16(PID_ADVANCED_OFFSETS.feedforwardRoll + index * 2, axis.f, true);
      advanced[PID_ADVANCED_OFFSETS.dMaxRoll + index] = axis.dMax;
    });
    const filters = Uint8Array.from(FILTER_CONFIG_API147_FIXTURE);
    const filterView = new DataView(filters.buffer);
    const o = FILTER_CONFIG_OFFSETS;
    filterView.setUint16(o.gyroLpf1StaticHz, projection.gyroHz.lpf1StaticHz, true);
    filters[o.gyroLpf1StaticHzLegacyU8] = projection.gyroHz.lpf1StaticHz % 256;
    filterView.setUint16(o.gyroLpf1DynMinHz, projection.gyroHz.lpf1DynMinHz, true);
    filterView.setUint16(o.gyroLpf1DynMaxHz, projection.gyroHz.lpf1DynMaxHz, true);
    filterView.setUint16(o.dtermLpf1StaticHz, projection.dtermHz.lpf1StaticHz, true);
    filterView.setUint16(o.dtermLpf1DynMinHz, projection.dtermHz.lpf1DynMinHz, true);
    filterView.setUint16(o.dtermLpf1DynMaxHz, projection.dtermHz.lpf1DynMaxHz, true);
    return {pid, advanced, filters};
  }

  it('accepts a board whose generator agrees with ours', () => {
    const board = obedientBoard();
    const verdict = classifySimplifiedReadback({
      requested,
      observedSimplified: requested,
      observedPid: board.pid,
      observedAdvanced: decodePidAdvancedFull(board.advanced, CONTRACT),
      observedFilters: decodeFilterConfigFull(board.filters, CONTRACT),
    });

    expect(verdict).toEqual({kind: 'EXACT'});
  });

  it('rejects a board whose SLIDERS echo but whose TUNE differs by one count', () => {
    const board = obedientBoard();
    board.pid[0] = (board.pid[0] + 1) % 251;
    const verdict = classifySimplifiedReadback({
      requested,
      observedSimplified: requested,
      observedPid: board.pid,
      observedAdvanced: decodePidAdvancedFull(board.advanced, CONTRACT),
      observedFilters: decodeFilterConfigFull(board.filters, CONTRACT),
    });

    expect(verdict.kind).toBe('MISMATCH');
    if (verdict.kind !== 'MISMATCH') throw new Error(verdict.kind);
    expect(verdict.fields.map(entry => entry.field)).toEqual(['ROLL.P']);
  });

  it('rejects a board whose TUNE is right but whose sliders came back wrong', () => {
    const board = obedientBoard();
    const wrongEcho = decodeSimplifiedTuning(mutate(SIMPLIFIED_TUNING_FIXTURE, 1, 100));
    const verdict = classifySimplifiedReadback({
      requested,
      observedSimplified: wrongEcho,
      observedPid: board.pid,
      observedAdvanced: decodePidAdvancedFull(board.advanced, CONTRACT),
      observedFilters: decodeFilterConfigFull(board.filters, CONTRACT),
    });

    expect(verdict.kind).toBe('MISMATCH');
    if (verdict.kind !== 'MISMATCH') throw new Error(verdict.kind);
    expect(verdict.fields.map(entry => entry.field)).toContain('simplified.masterMultiplier');
  });

  it('rejects a board whose generated FILTER frequency differs', () => {
    const board = obedientBoard();
    new DataView(board.filters.buffer).setUint16(FILTER_CONFIG_OFFSETS.gyroLpf1StaticHz, projection.gyroHz.lpf1StaticHz + 1, true);
    const verdict = classifySimplifiedReadback({
      requested,
      observedSimplified: requested,
      observedPid: board.pid,
      observedAdvanced: decodePidAdvancedFull(board.advanced, CONTRACT),
      observedFilters: decodeFilterConfigFull(board.filters, CONTRACT),
    });

    expect(verdict.kind).toBe('MISMATCH');
    if (verdict.kind !== 'MISMATCH') throw new Error(verdict.kind);
    expect(verdict.fields.map(entry => entry.field)).toEqual(['gyroLpf1StaticHz']);
  });
});
