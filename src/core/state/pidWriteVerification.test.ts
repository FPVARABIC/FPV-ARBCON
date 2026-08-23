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
  classifyGyroValidationSideEffects,
  classifyPidReadback,
  classifySimplifiedReadback,
  detectSimplifiedConflict,
  profileIndexRepairPossible,
  projectGyroValidation,
  projectSimplifiedWrite,
  simplifiedOwnedFields,
  type GyroValidationInputs,
} from './pidWriteVerification';
import {profileNameByteLength} from '../protocol/msp/encoding/encodeProfileCommands';
import {
  MOTOR_PROTOCOL_RAW_BRUSHED,
  MOTOR_PROTOCOL_RAW_MULTISHOT,
  MOTOR_PROTOCOL_RAW_ONESHOT125,
  MOTOR_PROTOCOL_RAW_ONESHOT42,
  MOTOR_PROTOCOL_RAW_PWM,
} from './filterSideEffectProjection';
import {
  MOTOR_PROTOCOL_RAW_DSHOT150_AT_2025_12_2,
  MOTOR_PROTOCOL_RAW_DSHOT300_AT_2025_12_2,
  MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2,
} from '../protocol/msp/decoding/decodeAdvancedConfig';
import {
  MOTOR_PROTOCOL_RAW_BRUSHED_AT_2025_12_2,
  MOTOR_PROTOCOL_RAW_MULTISHOT_AT_2025_12_2,
  MOTOR_PROTOCOL_RAW_ONESHOT125_AT_2025_12_2,
  MOTOR_PROTOCOL_RAW_ONESHOT42_AT_2025_12_2,
  MOTOR_PROTOCOL_RAW_PWM_AT_2025_12_2,
} from '../firmware-adapters/betaflightMotorDomainV147';

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

describe('a filter write reaches outside this screen, and the EXACT VALUE decides', () => {
  /** ONESHOT125 under continuous update: the one fully predictable clamp. */
  const oneshot: GyroValidationInputs = {
    gyroSampleRateHz: 8000,
    pidProcessDenom: 1,
    useContinuousUpdate: true,
    motorProtocolRaw: MOTOR_PROTOCOL_RAW_ONESHOT125,
    motorPwmRate: 8000,
    useDshotTelemetry: false,
  };
  const witness = (inputs: GyroValidationInputs) => ({
    pidProcessDenom: inputs.pidProcessDenom,
    motorProtocolRaw: inputs.motorProtocolRaw,
    motorPwmRate: inputs.motorPwmRate,
  });

  it('predicts the PWM clamp to the exact ESC rate, not merely "lower"', () => {
    // 1 / 0.0005 = 2000.
    const projection = projectGyroValidation(oneshot);
    expect(projection.motorPwmRate).toEqual({kind: 'EXACT', value: 2000});

    const report = classifyGyroValidationSideEffects(
      witness(oneshot), projection, {...witness(oneshot), motorPwmRate: 2000},
    );
    expect(report.unexpected).toEqual([]);
    expect(report.notProven).toEqual([]);
    expect(report.normalised.map(entry => entry.truth)).toEqual(['MOTOR_PWM_RATE']);
    expect(report.requiresReobserve).toEqual(['MOTOR_PWM_RATE']);
  });

  it('refuses a PWM rate that merely moved in the right direction', () => {
    const projection = projectGyroValidation(oneshot);
    // 1999 is lower than 8000 and lower than the clamp. A direction test
    // would have blessed it; an exact test cannot.
    const report = classifyGyroValidationSideEffects(
      witness(oneshot), projection, {...witness(oneshot), motorPwmRate: 1999},
    );
    expect(report.unexpected.map(entry => entry.truth)).toEqual(['MOTOR_PWM_RATE']);
  });

  it('leaves a DShot PWM rate alone, because the clamp does not apply', () => {
    const dshot = {...oneshot, motorProtocolRaw: MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2};
    expect(projectGyroValidation(dshot).motorPwmRate).toEqual({kind: 'EXACT', value: 8000});

    // DSHOT150 inverts to 4000, so a rate ABOVE that would be clamped if the
    // DShot exemption were dropped. checkMotorProtocolEnabled says it is not.
    const dshot150 = {
      ...oneshot,
      motorProtocolRaw: MOTOR_PROTOCOL_RAW_DSHOT150_AT_2025_12_2,
      motorPwmRate: 8000,
    };
    expect(projectGyroValidation(dshot150).motorPwmRate).toEqual({kind: 'EXACT', value: 8000});
  });

  it('doubles the restriction when DShot telemetry is on', () => {
    // ONESHOT125 at 4 kHz, telemetry ON, continuous update OFF. The forced
    // floor cannot fire (4000 is not > 4000) and the protocol is not
    // DSHOT600, so this stays exactly predictable - and the doubling is what
    // makes the answer 4 rather than 2.
    const inputs: GyroValidationInputs = {
      gyroSampleRateHz: 4000,
      pidProcessDenom: 1,
      useContinuousUpdate: false,
      motorProtocolRaw: MOTOR_PROTOCOL_RAW_ONESHOT125,
      motorPwmRate: 480,
      useDshotTelemetry: true,
    };
    expect(projectGyroValidation(inputs).pidProcessDenom).toEqual({kind: 'EXACT', value: 4});
    expect(projectGyroValidation({...inputs, useDshotTelemetry: false}).pidProcessDenom)
      .toEqual({kind: 'EXACT', value: 2});
  });

  it('predicts the exact denominator floor, not merely "higher"', () => {
    // ONESHOT125, no continuous update, 8 kHz gyro: restriction 0.0005 s,
    // samplingTime 0.000125 s, pidLooptime 0.000125 < 0.0005 so the floor
    // applies and is exactly 0.0005 / 0.000125 = 4.
    const inputs: GyroValidationInputs = {...oneshot, useContinuousUpdate: false, motorPwmRate: 480};
    const projection = projectGyroValidation(inputs);
    expect(projection.pidProcessDenom).toEqual({kind: 'EXACT', value: 4});

    const good = classifyGyroValidationSideEffects(
      witness(inputs), projection, {...witness(inputs), pidProcessDenom: 4},
    );
    expect(good.normalised.map(entry => entry.truth)).toEqual(['PID_PROCESS_DENOM']);

    const wrong = classifyGyroValidationSideEffects(
      witness(inputs), projection, {...witness(inputs), pidProcessDenom: 8},
    );
    expect(wrong.unexpected.map(entry => entry.truth)).toEqual(['PID_PROCESS_DENOM']);
  });

  it('rounds the denominator floor UP when the division leaves a remainder', () => {
    // DSHOT150 at 4 kHz: restriction 0.00025, samplingTime 0.00025, ratio 1.
    // Take a rate that does not divide: 4800 Hz -> samplingTime 1/4800,
    // ratio 0.00025 * 4800 = 1.2 -> truncates to 1, rounds up to 2.
    const inputs: GyroValidationInputs = {
      gyroSampleRateHz: 4800,
      pidProcessDenom: 1,
      useContinuousUpdate: false,
      motorProtocolRaw: MOTOR_PROTOCOL_RAW_DSHOT150_AT_2025_12_2,
      motorPwmRate: 480,
      useDshotTelemetry: false,
    };
    expect(projectGyroValidation(inputs).pidProcessDenom).toEqual({kind: 'EXACT', value: 2});
  });

  it('never lowers a denominator that is already above the floor', () => {
    const inputs: GyroValidationInputs = {...oneshot, useContinuousUpdate: false, pidProcessDenom: 8};
    expect(projectGyroValidation(inputs).pidProcessDenom).toEqual({kind: 'EXACT', value: 8});
  });

  it('refuses to predict the protocol at all when DShot telemetry is on', () => {
    // USE_PID_DENOM_CHECK is a target macro and cpu_overclock never reaches
    // us, so whether DSHOT600 becomes DSHOT300 is genuinely unknowable here.
    const inputs: GyroValidationInputs = {
      ...oneshot,
      motorProtocolRaw: MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2,
      useDshotTelemetry: true,
    };
    const projection = projectGyroValidation(inputs);
    expect(projection.motorProtocolRaw).toEqual({
      kind: 'NOT_PROVEN', reason: 'TARGET_PID_DENOM_CHECK_NOT_OBSERVABLE',
    });

    const moved = classifyGyroValidationSideEffects(
      witness(inputs), projection,
      {...witness(inputs), motorProtocolRaw: MOTOR_PROTOCOL_RAW_DSHOT300_AT_2025_12_2},
    );
    expect(moved.notProven.map(entry => entry.truth)).toEqual(['MOTOR_PROTOCOL']);
    expect(moved.normalised).toEqual([]);

    // Nothing moved: there is nothing to bless and nothing to refuse.
    const still = classifyGyroValidationSideEffects(witness(inputs), projection, witness(inputs));
    expect(still.notProven).toEqual([]);
    expect(still.requiresReobserve).toEqual([]);
  });

  it('refuses to predict the denominator when the forced floor might apply', () => {
    const inputs: GyroValidationInputs = {
      ...oneshot, useContinuousUpdate: false, gyroSampleRateHz: 8000, useDshotTelemetry: true,
    };
    expect(projectGyroValidation(inputs).pidProcessDenom).toEqual({
      kind: 'NOT_PROVEN', reason: 'TARGET_PID_DENOM_CHECK_NOT_OBSERVABLE',
    });
  });

  it('refuses to predict anything without a loop rate', () => {
    const projection = projectGyroValidation({...oneshot, gyroSampleRateHz: undefined});
    expect(projection.motorProtocolRaw.kind).toBe('NOT_PROVEN');
    expect(projection.pidProcessDenom.kind).toBe('NOT_PROVEN');
    expect(projection.motorPwmRate.kind).toBe('NOT_PROVEN');
  });

  it('cannot repair a profile index this transaction already proved in range', () => {
    expect(profileIndexRepairPossible(1, 4, 2, 4)).toBe(false);
    expect(profileIndexRepairPossible(4, 4, 0, 4)).toBe(true);
    expect(profileIndexRepairPossible(0, 4, 9, 4)).toBe(true);
  });

  it('measures a profile name in BYTES, not characters', () => {
    // Under the ASCII-only product policy these are the same number. They
    // stop being the same the moment that policy is revisited, which is why
    // the encoder measures the one the firmware measures.
    expect(profileNameByteLength('race')).toBe(4);
    expect(profileNameByteLength('ثم')).toBe(4);
    expect(profileNameByteLength('12345678')).toBe(8);
  });

  it('keeps the same protocol numbering as the Motors domain module', () => {
    // Two modules, one enum. P-C briefly had DSHOT300 = 5 here while the
    // decoder next door had 6, which is exactly the kind of drift this
    // catches.
    expect(MOTOR_PROTOCOL_RAW_PWM).toBe(MOTOR_PROTOCOL_RAW_PWM_AT_2025_12_2);
    expect(MOTOR_PROTOCOL_RAW_ONESHOT125).toBe(MOTOR_PROTOCOL_RAW_ONESHOT125_AT_2025_12_2);
    expect(MOTOR_PROTOCOL_RAW_ONESHOT42).toBe(MOTOR_PROTOCOL_RAW_ONESHOT42_AT_2025_12_2);
    expect(MOTOR_PROTOCOL_RAW_MULTISHOT).toBe(MOTOR_PROTOCOL_RAW_MULTISHOT_AT_2025_12_2);
    expect(MOTOR_PROTOCOL_RAW_BRUSHED).toBe(MOTOR_PROTOCOL_RAW_BRUSHED_AT_2025_12_2);
    expect(MOTOR_PROTOCOL_RAW_DSHOT300_AT_2025_12_2).toBe(6);
    expect(MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2).toBe(7);
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
