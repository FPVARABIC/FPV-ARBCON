import {
  disableSimplifiedTuning,
  generateSimplifiedDtermFilters,
  generateSimplifiedGyroFilters,
  generateSimplifiedPids,
  simplifiedDefaultsFor,
  type SimplifiedPidSliderInputs,
} from './simplifiedTuningGenerator';

const DEFAULTS = simplifiedDefaultsFor('API_1_47');

/**
 * P-A's reference vector, restated here as an independent fixture.
 *
 * These expectations were derived by hand from the pinned firmware before any
 * of this code existed: defaults times slider positions, truncated toward
 * zero by the firmware's int-parameter constrain(), then clamped. They are
 * NOT the output of the function under test.
 */
const PA_VECTOR: SimplifiedPidSliderInputs = Object.freeze({
  mode: 2,
  masterMultiplier: 113,
  rollPitchRatio: 93,
  iGain: 106,
  dGain: 88,
  piGain: 97,
  dMaxGain: 71,
  feedforwardGain: 124,
  pitchPiGain: 107,
});

describe('P-B - the simplified PID generator against the P-A reference vector', () => {
  const result = generateSimplifiedPids(PA_VECTOR, DEFAULTS);

  it('generates all three axes in RPY mode', () => {
    expect(result.axes).toHaveLength(3);
  });

  it('matches the hand-derived roll values', () => {
    expect(result.axes[0]).toEqual({p: 49, i: 92, d: 29, f: 168, dMax: 36});
  });

  it('matches the hand-derived pitch values, including both pitch trims', () => {
    expect(result.axes[1]).toEqual({p: 55, i: 104, d: 31, f: 187, dMax: 39});
  });

  it('matches the hand-derived yaw values, with no D and no D Max', () => {
    // Yaw's factory D is 0 and its D Max default is 0, so both stay 0 - the
    // generator must not borrow the roll/pitch shape for an axis that has
    // neither.
    expect(result.axes[2]).toEqual({p: 49, i: 92, d: 0, f: 168, dMax: 0});
  });

  it('names every direct field the write will destroy', () => {
    expect(result.overwrites).toEqual([
      'ROLL.P', 'ROLL.I', 'ROLL.D', 'ROLL.F', 'ROLL.D_MAX',
      'PITCH.P', 'PITCH.I', 'PITCH.D', 'PITCH.F', 'PITCH.D_MAX',
      'YAW.P', 'YAW.I', 'YAW.D', 'YAW.F', 'YAW.D_MAX',
    ]);
  });
});

describe('P-B - the generator starts from the factory defaults, never the current tune', () => {
  it('produces the same answer no matter what the board currently holds', () => {
    // The function is not even given the current tune, which is the point:
    // the firmware regenerates from compile-time defaults. If a future change
    // threaded the current PIDs in, this signature would have to change and
    // this test would have to be rewritten - deliberately.
    const first = generateSimplifiedPids(PA_VECTOR, DEFAULTS);
    const second = generateSimplifiedPids(PA_VECTOR, DEFAULTS);
    expect(second.axes).toEqual(first.axes);
  });

  it('reproduces the factory tune exactly when every slider sits at 100', () => {
    const neutral: SimplifiedPidSliderInputs = {
      mode: 2, masterMultiplier: 100, rollPitchRatio: 100, iGain: 100,
      dGain: 100, piGain: 100, dMaxGain: 100, feedforwardGain: 100, pitchPiGain: 100,
    };
    const result = generateSimplifiedPids(neutral, DEFAULTS);
    // Hand-checked against flight/pid.h: PID_ROLL_DEFAULT {45,80,30,120},
    // PID_PITCH_DEFAULT {47,84,34,125}, PID_YAW_DEFAULT {45,80,0,120},
    // D_MAX_DEFAULT {40,46,0}.
    expect(result.axes[0]).toEqual({p: 45, i: 80, d: 30, f: 120, dMax: 40});
    expect(result.axes[1]).toEqual({p: 47, i: 84, d: 34, f: 125, dMax: 46});
    expect(result.axes[2]).toEqual({p: 45, i: 80, d: 0, f: 120, dMax: 0});
  });
});

describe('P-B - which axes each mode touches', () => {
  it('generates nothing at all when the mode is OFF', () => {
    const result = generateSimplifiedPids({...PA_VECTOR, mode: 0}, DEFAULTS);
    expect(result.axes).toHaveLength(0);
    expect(result.overwrites).toHaveLength(0);
  });

  it('RP generates roll and pitch and leaves yaw alone', () => {
    const result = generateSimplifiedPids({...PA_VECTOR, mode: 1}, DEFAULTS);
    expect(result.axes).toHaveLength(2);
    expect(result.overwrites).not.toContain('YAW.P');
    expect(result.overwrites).toContain('PITCH.P');
  });

  it('RPY adds yaw to the same two', () => {
    const result = generateSimplifiedPids({...PA_VECTOR, mode: 2}, DEFAULTS);
    expect(result.axes).toHaveLength(3);
    expect(result.overwrites).toContain('YAW.P');
  });
});

describe('P-B - truncation, not rounding', () => {
  it('discards the fraction where the firmware discards it', () => {
    // master 113 x pi 97 on roll's P default of 45 gives 49.3245. Rounding
    // would also give 49, so that alone proves nothing - pitch is the
    // discriminator: 47 x 1.13 x 0.97 x 1.07 = 55.1228..., and I on pitch is
    // 104.4285..., where rounding still gives the same. The case that
    // separates them is below.
    const result = generateSimplifiedPids(PA_VECTOR, DEFAULTS);
    expect(result.axes[1].i).toBe(104);
  });

  it('truncates a value whose fraction would round up', () => {
    // Roll P = 45 x master x pi x 1. Choose master 175, pi 100:
    // 45 x 1.75 x 1.00 = 78.75 exactly. Truncation gives 78; rounding 79.
    const result = generateSimplifiedPids(
      {...PA_VECTOR, mode: 1, masterMultiplier: 175, piGain: 100},
      DEFAULTS,
    );
    expect(result.axes[0].p).toBe(78);
    expect(result.axes[0].p).not.toBe(79);
  });

  it('clamps a runaway gain to the firmware ceiling', () => {
    const result = generateSimplifiedPids(
      {...PA_VECTOR, mode: 1, masterMultiplier: 200, piGain: 200},
      DEFAULTS,
    );
    // 45 x 2 x 2 = 180 for P; I would be 80 x 2 x 2 x iGain, which exceeds
    // PID_GAIN_MAX and must stop at 250 rather than wrapping.
    expect(result.axes[0].p).toBe(180);
    expect(result.axes[0].i).toBe(250);
  });
});

describe('P-B - the filter generators', () => {
  const gyroObserved = {lpf1StaticHz: 250, lpf2StaticHz: 500, lpf1DynMinHz: 250, lpf1DynMaxHz: 500};
  const dtermObserved = {lpf1StaticHz: 75, lpf2StaticHz: 150, lpf1DynMinHz: 75, lpf1DynMaxHz: 150};

  it('matches the P-A gyro vector at multiplier 137', () => {
    // Hand-derived: 250x137/100 = 342 (integer), 500x137/100 = 685.
    const result = generateSimplifiedGyroFilters(true, 137, gyroObserved, DEFAULTS);
    expect(result.lpf1DynMinHz).toBe(342);
    expect(result.lpf1DynMaxHz).toBe(685);
    expect(result.lpf1StaticHz).toBe(342);
    expect(result.lpf2StaticHz).toBe(685);
  });

  it('matches the P-A D-term vector at multiplier 83', () => {
    // Hand-derived: 75x83/100 = 6225/100 = 62 (integer divide), 150x83/100 = 124.
    const result = generateSimplifiedDtermFilters(true, 83, dtermObserved, DEFAULTS);
    expect(result.lpf1DynMinHz).toBe(62);
    expect(result.lpf1DynMaxHz).toBe(124);
    expect(result.lpf1StaticHz).toBe(62);
    expect(result.lpf2StaticHz).toBe(124);
  });

  it('uses each block its own defaults - the two are not interchangeable', () => {
    const gyro = generateSimplifiedGyroFilters(true, 100, gyroObserved, DEFAULTS);
    const dterm = generateSimplifiedDtermFilters(true, 100, dtermObserved, DEFAULTS);
    expect(gyro.lpf1DynMinHz).toBe(250);
    expect(dterm.lpf1DynMinHz).toBe(75);
  });

  it('leaves a disabled filter disabled, whatever the multiplier says', () => {
    // The firmware guards each assignment on the current value being non-zero.
    // A filter the operator switched off is not switched back on by a slider.
    const off = {lpf1StaticHz: 0, lpf2StaticHz: 0, lpf1DynMinHz: 0, lpf1DynMaxHz: 0};
    const result = generateSimplifiedGyroFilters(true, 137, off, DEFAULTS);
    expect(result.lpf1StaticHz).toBe(0);
    expect(result.lpf2StaticHz).toBe(0);
    expect(result.lpf1DynMinHz).toBe(0);
    expect(result.overwrites).toHaveLength(0);
  });

  it('regenerates only the parts that were switched on', () => {
    const mixed = {lpf1StaticHz: 250, lpf2StaticHz: 0, lpf1DynMinHz: 0, lpf1DynMaxHz: 500};
    const result = generateSimplifiedGyroFilters(true, 137, mixed, DEFAULTS);
    expect(result.lpf1StaticHz).toBe(342);
    expect(result.lpf2StaticHz).toBe(0);
    expect(result.lpf1DynMinHz).toBe(0);
    expect(result.overwrites).toEqual(['lpf1StaticHz']);
  });

  it('does nothing when the block is not enabled', () => {
    const result = generateSimplifiedGyroFilters(false, 137, gyroObserved, DEFAULTS);
    expect(result.lpf1DynMinHz).toBe(250);
    expect(result.overwrites).toHaveLength(0);
  });

  it('truncates the integer divide at the boundary', () => {
    // 75 x 99 / 100 = 74.25 -> 74 in integer arithmetic. 75 would be rounding.
    const result = generateSimplifiedDtermFilters(true, 99, dtermObserved, DEFAULTS);
    expect(result.lpf1DynMinHz).toBe(74);
  });

  it('clamps a generated frequency to the firmware ceiling', () => {
    const high = {lpf1StaticHz: 900, lpf2StaticHz: 900, lpf1DynMinHz: 900, lpf1DynMaxHz: 900};
    const result = generateSimplifiedGyroFilters(true, 200, high, DEFAULTS);
    // 500 x 200 / 100 = 1000, exactly the ceiling; nothing may exceed it.
    expect(result.lpf1DynMaxHz).toBe(1000);
    expect(result.lpf2StaticHz).toBe(1000);
  });
});

describe('P-B - turning simplified tuning off restores nothing', () => {
  it('clears the three flags and makes no other claim', () => {
    const result = disableSimplifiedTuning();
    expect(result).toEqual({
      pidsMode: 0,
      dtermFilterEnabled: false,
      gyroFilterEnabled: false,
      restoresPreviousValues: false,
    });
  });

  it('has no way to give a previous tune back', () => {
    // The firmware keeps no copy of what the tune was before generation, so
    // there is nothing to restore. A function that accepted a "previous" and
    // returned it would be inventing state the flight controller never held.
    expect(disableSimplifiedTuning.length).toBe(0);
    expect(disableSimplifiedTuning().restoresPreviousValues).toBe(false);
  });
});
