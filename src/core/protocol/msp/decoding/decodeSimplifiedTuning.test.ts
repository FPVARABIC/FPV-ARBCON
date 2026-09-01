import {
  SIMPLIFIED_PIDS_MODE_COUNT_SENTINEL,
  classifySimplifiedPidsMode,
  decodeCalculatedPidfs,
  decodeSimplifiedTuning,
  decodeSimplifiedTuningValidity,
} from './decodeSimplifiedTuning';
import {MspPayloadReadError} from './MspPayloadReader';
import {encodeSimplifiedTuning} from '../encoding/encodeSimplifiedTuning';
import {
  CALCULATED_PIDFS_FIXTURE,
  SIMPLIFIED_TUNING_FIXTURE,
  SIMPLIFIED_VALIDITY_FIXTURE,
} from '../../__testUtils__/pidWireFixtures';

describe('P-B - MSP_SIMPLIFIED_TUNING, all 53 bytes', () => {
  const decoded = decodeSimplifiedTuning(SIMPLIFIED_TUNING_FIXTURE);

  it('reads all nine PID generator inputs, each distinct', () => {
    expect(decoded.pids.modeRaw).toBe(2);
    expect(decoded.pids.masterMultiplier).toBe(113);
    expect(decoded.pids.rollPitchRatio).toBe(93);
    expect(decoded.pids.iGain).toBe(106);
    expect(decoded.pids.dGain).toBe(88);
    expect(decoded.pids.piGain).toBe(97);
    expect(decoded.pids.dMaxGain).toBe(71);
    expect(decoded.pids.feedforwardGain).toBe(124);
    expect(decoded.pids.pitchPiGain).toBe(107);
  });

  it('reads the D-term block, keeping its inputs apart from its output Hz', () => {
    expect(decoded.dterm.enabled).toBe(true);
    expect(decoded.dterm.multiplier).toBe(83);
    expect(decoded.dterm.effectiveHz).toEqual({
      lpf1StaticHz: 62, lpf2StaticHz: 124, lpf1DynMinHz: 62, lpf1DynMaxHz: 124,
    });
    // The multiplier is 83 and the frequencies are 62/124. Nothing anywhere
    // should be able to read 83 as a frequency.
    expect(decoded.dterm.multiplier).not.toBe(decoded.dterm.effectiveHz.lpf1StaticHz);
  });

  it('reads the gyro block, and keeps it separate from the D-term block', () => {
    expect(decoded.gyro.enabled).toBe(true);
    expect(decoded.gyro.multiplier).toBe(137);
    expect(decoded.gyro.effectiveHz).toEqual({
      lpf1StaticHz: 342, lpf2StaticHz: 685, lpf1DynMinHz: 342, lpf1DynMaxHz: 685,
    });
    expect(decoded.gyro.multiplier).not.toBe(decoded.dterm.multiplier);
  });

  it('preserves the reserved words the firmware currently zeroes', () => {
    expect(decoded.pids.reserved).toEqual([0x11223344, 0x55667788]);
    expect(decoded.dterm.reserved).toEqual([0x99aabbcc, 0xddeeff00]);
    expect(decoded.gyro.reserved).toEqual([0x0f1e2d3c, 0x4b5a6978]);
  });

  it('refuses a short payload', () => {
    expect(() => decodeSimplifiedTuning(SIMPLIFIED_TUNING_FIXTURE.slice(0, 52)))
      .toThrow(MspPayloadReadError);
  });
});

describe('P-B - the simplified mode enum', () => {
  it('names the three real modes', () => {
    expect(classifySimplifiedPidsMode(0)).toEqual({kind: 'OFF'});
    expect(classifySimplifiedPidsMode(1)).toEqual({kind: 'RP'});
    expect(classifySimplifiedPidsMode(2)).toEqual({kind: 'RPY'});
  });

  it('treats the enum COUNT as unknown, because it is a sentinel', () => {
    expect(SIMPLIFIED_PIDS_MODE_COUNT_SENTINEL).toBe(3);
    expect(classifySimplifiedPidsMode(3)).toEqual({kind: 'UNKNOWN', raw: 3});
  });

  it('never normalises an unknown mode to OFF', () => {
    // OFF is a claim that no generation is happening. Making it the fallback
    // would tell a pilot their direct PIDs are safe when we do not know that.
    for (const raw of [3, 4, 17, 200, 255]) {
      expect(classifySimplifiedPidsMode(raw)).toEqual({kind: 'UNKNOWN', raw});
    }
  });
});

describe('P-B - MSP_SET_SIMPLIFIED_TUNING patches the board payload', () => {
  const observed = decodeSimplifiedTuning(SIMPLIFIED_TUNING_FIXTURE);

  it('changes only what was asked for', () => {
    const payload = encodeSimplifiedTuning(observed, {pids: {masterMultiplier: 120}});
    expect(payload).toHaveLength(53);
    // Hand-written expectation: offset 1 is the master multiplier.
    expect(payload[1]).toBe(120);
    for (let index = 0; index < payload.length; index += 1) {
      if (index !== 1) expect(payload[index]).toBe(SIMPLIFIED_TUNING_FIXTURE[index]);
    }
  });

  it('carries the reserved words through untouched', () => {
    const payload = encodeSimplifiedTuning(observed, {gyro: {multiplier: 90}});
    const round = decodeSimplifiedTuning(payload);
    expect(round.pids.reserved).toEqual([0x11223344, 0x55667788]);
    expect(round.dterm.reserved).toEqual([0x99aabbcc, 0xddeeff00]);
    expect(round.gyro.reserved).toEqual([0x0f1e2d3c, 0x4b5a6978]);
    expect(round.gyro.multiplier).toBe(90);
  });

  it('writes the gyro block at its own offsets, not the D-term block', () => {
    const payload = encodeSimplifiedTuning(observed, {gyro: {multiplier: 90}});
    // Hand-written: PID block is 17 bytes, D-term 18, so gyro starts at 35 and
    // its multiplier is at 36.
    expect(payload[36]).toBe(90);
    expect(payload[18]).toBe(83);
  });

  it('writes the D-term block at its own offsets, not the gyro block', () => {
    const payload = encodeSimplifiedTuning(observed, {dterm: {multiplier: 55}});
    expect(payload[18]).toBe(55);
    expect(payload[36]).toBe(137);
  });

  it('turns a block off by clearing its flag, without touching its Hz', () => {
    const payload = encodeSimplifiedTuning(observed, {dterm: {enabled: false}});
    const round = decodeSimplifiedTuning(payload);
    expect(round.dterm.enabled).toBe(false);
    expect(round.dterm.effectiveHz).toEqual(observed.dterm.effectiveHz);
  });

  it('refuses a value the wire cannot carry', () => {
    expect(() => encodeSimplifiedTuning(observed, {pids: {masterMultiplier: 300}}))
      .toThrow(RangeError);
    expect(() => encodeSimplifiedTuning(observed, {gyro: {effectiveHz: {lpf1StaticHz: 70000}}}))
      .toThrow(RangeError);
  });
});

describe('P-B - the firmware calculation and validation RPCs', () => {
  it('reads the three validity flags in the firmware order: PIDs, gyro, D-term', () => {
    const validity = decodeSimplifiedTuningValidity(SIMPLIFIED_VALIDITY_FIXTURE);
    expect(validity).toEqual({pidsValid: true, gyroValid: false, dtermValid: true});
  });

  it('reads the calculate response in its own shape, not the request shape', () => {
    // 18 bytes out for a 17-byte block in. It is a calculator, not an echo.
    expect(CALCULATED_PIDFS_FIXTURE).toHaveLength(18);
    const axes = decodeCalculatedPidfs(CALCULATED_PIDFS_FIXTURE);
    expect(axes).toHaveLength(3);
    expect(axes[0]).toEqual({p: 49, i: 92, d: 29, dMax: 36, f: 168});
    expect(axes[1]).toEqual({p: 55, i: 104, d: 31, dMax: 39, f: 187});
    expect(axes[2]).toEqual({p: 49, i: 92, d: 0, dMax: 0, f: 168});
  });

  it('refuses short RPC responses', () => {
    expect(() => decodeSimplifiedTuningValidity(Uint8Array.from([1, 0])))
      .toThrow(MspPayloadReadError);
    expect(() => decodeCalculatedPidfs(CALCULATED_PIDFS_FIXTURE.slice(0, 17)))
      .toThrow(MspPayloadReadError);
  });
});
