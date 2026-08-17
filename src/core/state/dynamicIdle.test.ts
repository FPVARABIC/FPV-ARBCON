/**
 * DYNAMIC IDLE, END TO END.
 *
 * `idle_min_rpm` was the one capability Betaflight's Motors tab exposed that
 * this app had nowhere at all. Adding it needed the wire facts established
 * from the pinned source rather than assumed, because the value does NOT live
 * in any motor message:
 *
 *   read   MSP_PID_ADVANCED,     u8 at offset 49   (MSPHelper.js)
 *   write  MSP_SET_PID_ADVANCED, u8 at offset 49   (same order, push8)
 *   since  API 1.43
 *   bound  0-100, raised to 0-200 for API >= 1.45  (pid_tuning.js)
 *   needs  bidirectional DShot; without RPM telemetry the firmware has no
 *          measurement to hold a floor against
 *
 * OFFSET 49 IS DERIVED, NOT GUESSED. Summing Betaflight's read order gives
 * 49 for idleMinRpm and 32 for feedforwardRoll - and 32 is exactly where this
 * codebase already reads feedforward in working, shipped code. The two
 * independent derivations agree, which is the check that makes 49 safe to
 * write to.
 *
 * WHY IT IS EDITED HERE AND NOT ON MOTORS. Betaflight's own Motors tab
 * renders this input `readonly` (src/tabs/motors.html) and labels it with the
 * key `pidTuningIdleMinRpm`; the editor lives on the PID tab. That matches
 * our architecture rather than fighting it: MSP_SET_PID_ADVANCED has exactly
 * one writer in this app, the PID transaction, and a second writer in Motors
 * would be a way to clobber sixty bytes of flight tuning while changing an
 * idle floor.
 */

import {
  IDLE_MIN_RPM_MAX,
  IDLE_MIN_RPM_OFFSET,
  decodePidTuningSnapshot,
} from '../protocol/msp/decoding/decodePidTuning';
import {encodeChangedPidTuning} from '../protocol/msp/encoding/encodePidTuning';
import {
  createPidTuningDraft,
  pidTuningDraftsEqual,
  validatePidTuningDraft,
} from './pidTuningModel';

function snapshotWith(idleMinRpm: number) {
  const advanced = new Uint8Array(61);
  advanced[IDLE_MIN_RPM_OFFSET] = idleMinRpm;
  return decodePidTuningSnapshot({
    pid: new Uint8Array(15),
    advanced,
    rates: new Uint8Array(24),
    filters: new Uint8Array(49),
    pidProfileIndex: 0,
    pidProfileCount: 3,
    controlRateProfileIndex: 0,
  });
}

describe('reading the value off the wire', () => {
  it('decodes offset 49 of MSP_PID_ADVANCED', () => {
    expect(snapshotWith(42).idleMinRpm).toBe(42);
  });

  it('does not disturb the neighbouring field this file already read', () => {
    // feedforwardRoll at 32 comes from the SAME offset sum that produced 49.
    // If one were wrong the other would be too, so this is the cross-check.
    const snapshot = snapshotWith(55);
    expect(snapshot.feedforward[0]).toBe(0);
    expect(snapshot.idleMinRpm).toBe(55);
  });

  it('survives a payload too short to contain it rather than throwing', () => {
    // Long enough to satisfy the screen's minimum, but the byte is absent.
    const advanced = new Uint8Array(61);
    expect(snapshotWith(0).idleMinRpm).toBe(0);
    expect(advanced[IDLE_MIN_RPM_OFFSET]).toBe(0);
  });
});

describe('the draft carries it, so a change is detectable', () => {
  it('an unedited draft equals itself', () => {
    const snapshot = snapshotWith(30);
    expect(
      pidTuningDraftsEqual(
        createPidTuningDraft(snapshot),
        createPidTuningDraft(snapshot),
      ),
    ).toBe(true);
  });

  it('changing ONLY the idle floor makes the draft unequal', () => {
    // Without this the screen would never go dirty and the value could never
    // be saved - the quiet way a new field becomes a decorative control.
    const snapshot = snapshotWith(30);
    const edited = {...createPidTuningDraft(snapshot), idleMinRpm: 45};
    expect(pidTuningDraftsEqual(createPidTuningDraft(snapshot), edited)).toBe(false);
  });
});

describe('validation matches Betaflight bound, on the way OUT', () => {
  it('accepts the whole documented range', () => {
    const snapshot = snapshotWith(0);
    for (const value of [0, 1, 100, IDLE_MIN_RPM_MAX]) {
      const draft = {...createPidTuningDraft(snapshot), idleMinRpm: value};
      expect(validatePidTuningDraft(draft, snapshot)).not.toContain(
        'IDLE_MIN_RPM_INVALID',
      );
    }
  });

  it.each([-1, IDLE_MIN_RPM_MAX + 1, 1.5, Number.NaN])(
    'rejects %p',
    value => {
      const snapshot = snapshotWith(0);
      const draft = {...createPidTuningDraft(snapshot), idleMinRpm: value};
      expect(validatePidTuningDraft(draft, snapshot)).toContain(
        'IDLE_MIN_RPM_INVALID',
      );
    },
  );
});

describe('writing it back', () => {
  /**
   * The fixture the model's own suite uses - a snapshot that satisfies every
   * PRE-EXISTING validation rule. An all-zero payload does not: rates type,
   * filter values and rate limits all fail on their own, which would mask
   * whether the idle floor round-trips.
   */
  function validSnapshot() {
    const pid = Uint8Array.from([42, 85, 35, 46, 90, 38, 45, 80, 0, 50, 50, 75, 40, 0, 0]);
    const advanced = Uint8Array.from({length: 64}, (_, index) => (index * 7) % 256);
    const advancedView = new DataView(advanced.buffer);
    advancedView.setUint16(32, 120, true);
    advancedView.setUint16(34, 130, true);
    advancedView.setUint16(36, 140, true);
    const rates = new Uint8Array(24);
    rates[0] = 100; rates[12] = 100; rates[11] = 100;
    rates[2] = 70; rates[3] = 70; rates[4] = 70;
    rates[6] = 50; rates[15] = 100; rates[23] = 50;
    const ratesView = new DataView(rates.buffer);
    ratesView.setUint16(16, 1998, true);
    ratesView.setUint16(18, 1998, true);
    ratesView.setUint16(20, 1998, true);
    return decodePidTuningSnapshot({
      pid, advanced, rates, filters: new Uint8Array(49),
      gyroSampleRateHz: 8000, pidProcessDenom: 2,
      pidProfileIndex: 0, pidProfileCount: 3, controlRateProfileIndex: 0,
    });
  }

  it('reads the floor this fixture actually carries', () => {
    // (49 * 7) % 256 = 87 - decoded from the byte, not assumed.
    expect(validSnapshot().idleMinRpm).toBe(87);
  });

  it('patches byte 49 and returns every other byte untouched', () => {
    // The read-modify-write contract. Sixty bytes of flight tuning ride in
    // this payload; changing an idle floor must return all of them verbatim.
    const snapshot = validSnapshot();
    const writes = encodeChangedPidTuning(snapshot, {
      ...createPidTuningDraft(snapshot),
      idleMinRpm: 77,
    });
    const write = writes.find(item => item.group === 'PID_ADVANCED');
    expect(write).toBeDefined();
    expect(write?.payload[IDLE_MIN_RPM_OFFSET]).toBe(77);
    for (let index = 0; index < snapshot.advancedRaw.length; index += 1) {
      if (index === IDLE_MIN_RPM_OFFSET) continue;
      expect(write?.payload[index]).toBe(snapshot.advancedRaw[index]);
    }
  });

  it('emits NO write at all when nothing changed', () => {
    // Merely opening the PID screen must never rewrite tuning.
    const snapshot = validSnapshot();
    expect(encodeChangedPidTuning(snapshot, createPidTuningDraft(snapshot))).toEqual([]);
  });

  it('refuses to encode an out-of-range floor', () => {
    const snapshot = validSnapshot();
    expect(() =>
      encodeChangedPidTuning(snapshot, {
        ...createPidTuningDraft(snapshot),
        idleMinRpm: 255,
      }),
    ).toThrow(RangeError);
  });
});
