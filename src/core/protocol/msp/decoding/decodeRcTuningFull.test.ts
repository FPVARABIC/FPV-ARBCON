import {
  RC_TUNING_OFFSETS,
  RC_TUNING_RETIRED_OFFSETS,
  decodeRcTuningFull,
  projectRcTuningWrite,
} from './decodeRcTuningFull';
import {MspPayloadReadError} from './MspPayloadReader';
import {RC_TUNING_FIXTURE} from '../../__testUtils__/pidWireFixtures';

describe('P-B - MSP_RC_TUNING, all 24 bytes', () => {
  const decoded = decodeRcTuningFull(RC_TUNING_FIXTURE);

  it('places every axis field at the right offset', () => {
    // Roll, pitch and yaw all differ, so any swap is visible.
    expect(decoded.rcRate).toEqual([118, 124, 131]);
    expect(decoded.expo).toEqual([41, 44, 53]);
    expect(decoded.superRate).toEqual([73, 77, 81]);
    expect(decoded.rateLimit).toEqual([1750, 1680, 1500]);
  });

  it('reads the throttle group including the 1.47 hover byte', () => {
    expect(decoded.throttleMid).toBe(47);
    expect(decoded.throttleExpo).toBe(29);
    expect(decoded.throttleLimitType).toBe(2);
    expect(decoded.throttleLimitPercent).toBe(88);
    expect(decoded.throttleHover).toBe(39);
  });

  it('reads the rates type from offset 22', () => {
    expect(RC_TUNING_OFFSETS.ratesType).toBe(22);
    expect(decoded.ratesTypeRaw).toBe(3);
  });

  it('treats the three TPA bytes as retired, not as settings', () => {
    expect(RC_TUNING_RETIRED_OFFSETS).toEqual([5, 8, 9]);
    // The fixture puts sentinels where a real board sends zeros. They are
    // reported as retired bytes and never surface as a TPA value - TPA lives
    // in MSP_PID_ADVANCED at these API versions.
    expect(decoded.retiredTpaBytes).toEqual([0xd1, 0xd2, 0xd3]);
    expect(Object.keys(decoded)).not.toContain('tpaRate');
    expect(Object.keys(decoded)).not.toContain('tpaBreakpoint');
  });

  it('refuses a short payload', () => {
    expect(() => decodeRcTuningFull(RC_TUNING_FIXTURE.slice(0, 23))).toThrow(MspPayloadReadError);
  });
});

describe('P-B - writing roll can move pitch', () => {
  /** A board whose pitch already equals roll on both fields. */
  const linked = decodeRcTuningFull(Uint8Array.from((() => {
    const bytes = Array.from(RC_TUNING_FIXTURE);
    bytes[RC_TUNING_OFFSETS.rcRatePitch] = bytes[RC_TUNING_OFFSETS.rcRateRoll];
    bytes[RC_TUNING_OFFSETS.expoPitch] = bytes[RC_TUNING_OFFSETS.expoRoll];
    return bytes;
  })()));

  /** The fixture as written: pitch differs from roll on both fields. */
  const unlinked = decodeRcTuningFull(RC_TUNING_FIXTURE);

  it('starts from two genuinely different boards', () => {
    expect(linked.rcRate[0]).toBe(linked.rcRate[1]);
    expect(unlinked.rcRate[0]).not.toBe(unlinked.rcRate[1]);
  });

  it('reports the linkage when the stored axes matched and pitch was left alone', () => {
    // Change roll only; pitch and yaw are re-sent unchanged.
    const projection = projectRcTuningWrite(linked, {
      rcRate: [150, linked.rcRate[1], linked.rcRate[2]],
      expo: [60, linked.expo[1], linked.expo[2]],
    });
    expect(projection.pitchFollowedRollRcRate).toBe(true);
    expect(projection.pitchFollowedRollExpo).toBe(true);
  });

  it('reports no linkage on a board whose axes already differed', () => {
    const projection = projectRcTuningWrite(unlinked, {
      rcRate: [150, unlinked.rcRate[1], unlinked.rcRate[2]],
      expo: [60, unlinked.expo[1], unlinked.expo[2]],
    });
    // Same request, different board state, different answer. That is the
    // whole point: the side effect is state-dependent.
    expect(projection.pitchFollowedRollRcRate).toBe(false);
    expect(projection.pitchFollowedRollExpo).toBe(false);
  });

  it('lets an explicit pitch value win over the linkage', () => {
    const projection = projectRcTuningWrite(linked, {
      rcRate: [150, 199, linked.rcRate[2]],
      expo: [60, 61, linked.expo[2]],
    });
    // Pitch's own bytes arrive later in the payload and land on top.
    expect(projection.rcRate[1]).toBe(199);
    expect(projection.expo[1]).toBe(61);
  });

  it('never mutates the observation it was given', () => {
    const before = Array.from(linked.raw);
    projectRcTuningWrite(linked, {
      rcRate: [150, linked.rcRate[1], linked.rcRate[2]],
      expo: [60, linked.expo[1], linked.expo[2]],
    });
    expect(Array.from(linked.raw)).toEqual(before);
    expect(linked.rcRate).toEqual([118, 118, 131]);
  });
});
