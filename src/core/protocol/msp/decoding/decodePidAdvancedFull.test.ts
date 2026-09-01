import {
  PID_ADVANCED_OFFSETS,
  PID_ADVANCED_RESERVED_OFFSETS,
  TPA_RATE_MAX,
  decodePidAdvancedFull,
  projectPidAdvancedWrite,
} from './decodePidAdvancedFull';
import {MspPayloadReadError} from './MspPayloadReader';
import {PID_ADVANCED_FIXTURE} from '../../__testUtils__/pidWireFixtures';

describe('P-B - MSP_PID_ADVANCED, all 61 bytes', () => {
  const decoded = decodePidAdvancedFull(PID_ADVANCED_FIXTURE, 'API_1_47');

  it('reads every owned field from the hand-written payload', () => {
    expect(decoded.feedforwardTransition).toBe(37);
    expect(decoded.rateAccelLimit).toBe(1234);
    expect(decoded.yawRateAccelLimit).toBe(4321);
    expect(decoded.angleLimit).toBe(53);
    expect(decoded.antiGravityGain).toBe(3800);
    expect(decoded.itermRotation).toBe(1);
    expect(decoded.itermRelax).toBe(3);
    expect(decoded.itermRelaxType).toBe(1);
    expect(decoded.throttleBoost).toBe(11);
    expect(decoded.acroTrainerAngleLimit).toBe(23);
    expect(decoded.itermRelaxCutoff).toBe(17);
    expect(decoded.motorOutputLimit).toBe(97);
    expect(decoded.dynIdleMinRpm).toBe(61);
    expect(decoded.vbatSagCompensation).toBe(71);
    expect(decoded.thrustLinearization).toBe(41);
  });

  it('keeps the three feedforward gains in axis order', () => {
    // Roll 137, pitch 141, yaw 149 - three different values, so a swapped
    // pair cannot pass.
    expect(decoded.feedforward).toEqual([137, 141, 149]);
  });

  it('reads the whole feedforward feel group at its own offsets', () => {
    expect(decoded.feedforwardAveraging).toBe(2);
    expect(decoded.feedforwardSmoothFactor).toBe(63);
    expect(decoded.feedforwardBoost).toBe(19);
    expect(decoded.feedforwardMaxRateLimit).toBe(91);
    expect(decoded.feedforwardJitterFactor).toBe(13);
  });

  it('reads D Max as three axes plus a gain and an advance', () => {
    expect(decoded.dMax).toEqual([43, 47, 0]);
    expect(decoded.dMaxGain).toBe(29);
    expect(decoded.dMaxAdvance).toBe(31);
  });

  it('finds TPA here rather than in RC tuning', () => {
    expect(decoded.tpaMode).toBe(1);
    expect(decoded.tpaRate).toBe(67);
    expect(decoded.tpaBreakpoint).toBe(1350);
  });

  it('decodes auto_profile_cell_count signed, as flight/pid.h declares it', () => {
    // The fixture holds 0xFF. Unsigned that is 255, which is not a cell count.
    expect(decoded.autoProfileCellCount).toBe(-1);
  });

  it('carries the payload verbatim so unowned bytes can be written back', () => {
    expect(Array.from(decoded.raw)).toEqual(Array.from(PID_ADVANCED_FIXTURE));
    // The reserved slots hold sentinels in the fixture; nothing may read them
    // as settings, and the encoder must return them untouched.
    for (const offset of PID_ADVANCED_RESERVED_OFFSETS) {
      expect(decoded.raw[offset]).toBe(PID_ADVANCED_FIXTURE[offset]);
    }
  });

  it('refuses a short payload rather than inventing a tail', () => {
    expect(() => decodePidAdvancedFull(PID_ADVANCED_FIXTURE.slice(0, 60), 'API_1_47'))
      .toThrow(MspPayloadReadError);
  });

  it('anchors the offsets that later phases will patch', () => {
    expect(PID_ADVANCED_OFFSETS.feedforwardRoll).toBe(32);
    expect(PID_ADVANCED_OFFSETS.dMaxRoll).toBe(39);
    expect(PID_ADVANCED_OFFSETS.dynIdleMinRpm).toBe(49);
    expect(PID_ADVANCED_OFFSETS.feedforwardAveraging).toBe(50);
    expect(PID_ADVANCED_OFFSETS.feedforwardBoost).toBe(52);
    expect(PID_ADVANCED_OFFSETS.feedforwardJitterFactor).toBe(54);
    expect(PID_ADVANCED_OFFSETS.tpaRate).toBe(58);
  });
});

describe('P-B - the same 61 bytes mean different things per version', () => {
  it('absolute control is a setting at 1.47 and a retired slot afterwards', () => {
    expect(decodePidAdvancedFull(PID_ADVANCED_FIXTURE, 'API_1_47').absControlGain)
      .toEqual({raw: 7, lifetime: 'LIVE'});
    expect(decodePidAdvancedFull(PID_ADVANCED_FIXTURE, 'API_1_48').absControlGain)
      .toEqual({raw: 7, lifetime: 'RETIRED'});
    expect(decodePidAdvancedFull(PID_ADVANCED_FIXTURE, 'API_1_49').absControlGain)
      .toEqual({raw: 7, lifetime: 'RETIRED'});
  });

  it('integrated yaw survives 1.48 and retires at 1.49', () => {
    for (const contract of ['API_1_47', 'API_1_48'] as const) {
      const value = decodePidAdvancedFull(PID_ADVANCED_FIXTURE, contract);
      expect(value.useIntegratedYaw.lifetime).toBe('LIVE');
      expect(value.integratedYawRelax.lifetime).toBe('LIVE');
    }
    const latest = decodePidAdvancedFull(PID_ADVANCED_FIXTURE, 'API_1_49');
    expect(latest.useIntegratedYaw.lifetime).toBe('RETIRED');
    expect(latest.integratedYawRelax.lifetime).toBe('RETIRED');
    // The raw byte is still reported. Retired does not mean invisible - it
    // means "do not read this as a setting".
    expect(latest.useIntegratedYaw.raw).toBe(1);
    expect(latest.integratedYawRelax.raw).toBe(199);
  });

  it('never turns a retired zero into a capability claim', () => {
    const zeroed = PID_ADVANCED_FIXTURE.slice();
    zeroed[PID_ADVANCED_OFFSETS.absControlGain] = 0;
    const at147 = decodePidAdvancedFull(zeroed, 'API_1_47').absControlGain;
    const at148 = decodePidAdvancedFull(zeroed, 'API_1_48').absControlGain;
    // Identical raw byte, different meaning. A model that only carried the
    // number could not tell "switched off" from "no longer exists".
    expect(at147.raw).toBe(at148.raw);
    expect(at147.lifetime).not.toBe(at148.lifetime);
  });
});

describe('P-B - the one normalisation MSP_SET_PID_ADVANCED performs', () => {
  it('clamps tpa_rate to the firmware maximum', () => {
    expect(TPA_RATE_MAX).toBe(100);
    expect(projectPidAdvancedWrite({tpaRate: 120}).tpaRate).toBe(100);
  });

  it('leaves an in-range tpa_rate exactly alone', () => {
    expect(projectPidAdvancedWrite({tpaRate: 67}).tpaRate).toBe(67);
    expect(projectPidAdvancedWrite({tpaRate: 100}).tpaRate).toBe(100);
  });
});
