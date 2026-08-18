/**
 * THE THREE BYTES THAT DEFINE A FLIGHT STYLE.
 *
 * Betaflight's own OFFICIAL preset library (firmware-presets, authored by
 * a Betaflight maintainer) defines cinematic, freestyle and race by
 * changing exactly these, and nothing about P/I/D:
 *
 *   Generic 150Hz Cinematic        averaging OFF      jitter 12
 *   Generic 150Hz Ultra Cinematic  averaging OFF      jitter 16
 *   Generic 250Hz Freestyle        averaging 2_POINT  jitter 8
 *   Generic 500Hz Race             averaging 2_POINT  jitter 3   boost 18
 *
 * Until this round the app could not set any of them, so a flight-style
 * guide could not tell an operator to do the one thing that actually
 * produces the style. These tests pin the byte offsets, the firmware's
 * own ranges, and the property that matters most: everything else in the
 * payload is written back untouched.
 *
 * THE OFFSETS ARE THE DANGEROUS PART. A naive field count puts averaging
 * at 49 because it misses `autoProfileCellCount`, a SIGNED byte between
 * motorOutputLimit and idleMinRpm. Writing averaging into idleMinRpm
 * would set a dynamic-idle floor from a smoothing menu.
 */

import {
  decodePidTuningSnapshot,
  FEEDFORWARD_AVERAGING_OFFSET,
  FEEDFORWARD_BOOST_OFFSET,
  FEEDFORWARD_JITTER_FACTOR_OFFSET,
  IDLE_MIN_RPM_OFFSET,
} from '../protocol/msp/decoding/decodePidTuning';
import {encodeChangedPidTuning} from '../protocol/msp/encoding/encodePidTuning';
import {
  createPidTuningDraft,
  validatePidTuningDraft,
  FEEDFORWARD_AVERAGING_MAX,
  FEEDFORWARD_BOOST_MAX,
  FEEDFORWARD_JITTER_FACTOR_MAX,
} from './pidTuningModel';

/**
 * A rates payload the model accepts.
 *
 * Zeroes are not valid rates - rc rate 0 and a zero throttle curve both
 * fail validation - and this file is about feedforward, not about rates.
 * Same shape PidTuningController.test.ts already proves.
 */
function ratesPayload(): Uint8Array {
  const bytes = new Uint8Array(24);
  const view = new DataView(bytes.buffer);
  bytes[0] = 100; bytes[11] = 100; bytes[12] = 100; bytes[15] = 100;
  view.setUint16(16, 1998, true); view.setUint16(18, 1998, true); view.setUint16(20, 1998, true);
  bytes[23] = 50;
  return bytes;
}

/** A board payload set at the four offsets this file is about. */
function board(overrides: {averaging?: number; boost?: number; jitter?: number; idle?: number} = {}) {
  const advanced = new Uint8Array(80);
  advanced[IDLE_MIN_RPM_OFFSET] = overrides.idle ?? 30;
  advanced[FEEDFORWARD_AVERAGING_OFFSET] = overrides.averaging ?? 1;
  advanced[FEEDFORWARD_BOOST_OFFSET] = overrides.boost ?? 15;
  advanced[FEEDFORWARD_JITTER_FACTOR_OFFSET] = overrides.jitter ?? 7;
  return decodePidTuningSnapshot({
    pid: new Uint8Array(30),
    advanced,
    rates: ratesPayload(),
    filters: new Uint8Array(60),
    // The decoder refuses a snapshot without a coherent profile identity,
    // which is a different guarantee from the one under test here.
    pidProfileIndex: 0,
    pidProfileCount: 3,
    controlRateProfileIndex: 0,
  } as never);
}

describe('the feedforward feel bytes', () => {
  it('sits where the anchored offset sum puts them, not where a field count does', () => {
    // 48 is autoProfileCellCount. If these ever drift by one, this is the
    // assertion that says so before an aircraft does.
    expect(IDLE_MIN_RPM_OFFSET).toBe(49);
    expect(FEEDFORWARD_AVERAGING_OFFSET).toBe(50);
    expect(FEEDFORWARD_BOOST_OFFSET).toBe(52);
    expect(FEEDFORWARD_JITTER_FACTOR_OFFSET).toBe(54);
  });

  it('reads each one from its own byte', () => {
    const snapshot = board({averaging: 0, boost: 18, jitter: 12, idle: 30});
    expect(snapshot.feedforwardAveraging).toBe(0);
    expect(snapshot.feedforwardBoost).toBe(18);
    expect(snapshot.feedforwardJitterFactor).toBe(12);
    // The neighbour that a one-off error would corrupt.
    expect(snapshot.idleMinRpm).toBe(30);
  });

  it('reports zero rather than guessing when the bytes are absent', () => {
    // A board whose payload stops before these fields. The decoder's own
    // 1.47 floor is 61 bytes, so this is expressed by zeroing the bytes
    // rather than by truncating below a length it would refuse outright.
    const snapshot = board({averaging: 0, boost: 0, jitter: 0});
    expect(snapshot.feedforwardAveraging).toBe(0);
    expect(snapshot.feedforwardJitterFactor).toBe(0);
    expect(snapshot.feedforwardBoost).toBe(0);
  });
});

describe('writing the feel bytes', () => {
  it('changes ONLY the byte that was edited', () => {
    const snapshot = board();
    const draft = {...createPidTuningDraft(snapshot), feedforwardJitterFactor: 12};

    const writes = encodeChangedPidTuning(snapshot, draft);
    const advanced = writes.find(w => w.group === 'PID_ADVANCED');

    expect(advanced).toBeDefined();
    const differing = Array.from(advanced!.payload)
      .flatMap((byte, index) => (byte === snapshot.advancedRaw[index] ? [] : [index]));
    expect(differing).toEqual([FEEDFORWARD_JITTER_FACTOR_OFFSET]);
  });

  it('can apply Betaflight’s own cinematic and race presets', () => {
    // The exact values from the OFFICIAL presets, end to end.
    const snapshot = board();
    const cinematic = {...createPidTuningDraft(snapshot), feedforwardAveraging: 0, feedforwardJitterFactor: 12};
    const race = {...createPidTuningDraft(snapshot), feedforwardAveraging: 1, feedforwardJitterFactor: 3, feedforwardBoost: 18};

    const cine = encodeChangedPidTuning(snapshot, cinematic).find(w => w.group === 'PID_ADVANCED')!.payload;
    expect(cine[FEEDFORWARD_AVERAGING_OFFSET]).toBe(0);
    expect(cine[FEEDFORWARD_JITTER_FACTOR_OFFSET]).toBe(12);

    const racing = encodeChangedPidTuning(snapshot, race).find(w => w.group === 'PID_ADVANCED')!.payload;
    expect(racing[FEEDFORWARD_AVERAGING_OFFSET]).toBe(1);
    expect(racing[FEEDFORWARD_JITTER_FACTOR_OFFSET]).toBe(3);
    expect(racing[FEEDFORWARD_BOOST_OFFSET]).toBe(18);
  });

  it('sends nothing at all when the feel is unchanged', () => {
    const snapshot = board();
    const writes = encodeChangedPidTuning(snapshot, createPidTuningDraft(snapshot));
    expect(writes.find(w => w.group === 'PID_ADVANCED')).toBeUndefined();
  });
});

describe('the firmware’s own ranges are enforced', () => {
  it('pins the bounds settings.c declares', () => {
    expect(FEEDFORWARD_AVERAGING_MAX).toBe(3); // OFF, 2_POINT, 3_POINT, 4_POINT
    expect(FEEDFORWARD_BOOST_MAX).toBe(50);
    expect(FEEDFORWARD_JITTER_FACTOR_MAX).toBe(20);
  });

  it('refuses a value MSP would happily store and fly on', () => {
    // MSP_SET_PID_ADVANCED does not clamp: whatever arrives is assigned.
    const snapshot = board();
    const base = createPidTuningDraft(snapshot);
    expect(validatePidTuningDraft({...base, feedforwardJitterFactor: 21}, snapshot)).toContain('FEEDFORWARD_JITTER_INVALID');
    expect(validatePidTuningDraft({...base, feedforwardBoost: 51}, snapshot)).toContain('FEEDFORWARD_BOOST_INVALID');
    expect(validatePidTuningDraft({...base, feedforwardAveraging: 4}, snapshot)).toContain('FEEDFORWARD_AVERAGING_INVALID');
    expect(validatePidTuningDraft({...base, feedforwardBoost: -1}, snapshot)).toContain('FEEDFORWARD_BOOST_INVALID');
  });

  it('accepts every value the firmware does, including both ends', () => {
    const snapshot = board();
    const base = createPidTuningDraft(snapshot);
    for (const value of [0, FEEDFORWARD_JITTER_FACTOR_MAX]) {
      expect(validatePidTuningDraft({...base, feedforwardJitterFactor: value}, snapshot)).not.toContain('FEEDFORWARD_JITTER_INVALID');
    }
    for (const value of [0, FEEDFORWARD_AVERAGING_MAX]) {
      expect(validatePidTuningDraft({...base, feedforwardAveraging: value}, snapshot)).not.toContain('FEEDFORWARD_AVERAGING_INVALID');
    }
  });
});
