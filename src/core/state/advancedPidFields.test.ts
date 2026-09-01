/**
 * THE ADVANCED PID CATALOGUE, AGAINST HAND-PLACED BYTES.
 *
 * Every fixture here is written by hand from the firmware's own
 * `MSP_SET_PID_ADVANCED` reader (msp.c) - the byte positions come from
 * counting that function's sequential reads, not from running our own
 * encoder and copying what it produced. That direction of proof is the
 * whole point: an encoder-generated expectation would agree with the
 * encoder no matter how wrong both were.
 */

import {
  ADVANCED_PID_BOUNDS,
  ADVANCED_PID_FIELD_KEYS,
  advancedPidDraftsEqual,
  createAdvancedPidDraftFromRaw,
  invalidAdvancedFields,
  movedAdvancedFields,
  patchAdvancedPidDraft,
  type AdvancedPidDraft,
} from './advancedPidFields';

/**
 * A 61-byte payload with a distinct value at every offset this app owns.
 * Written positionally, so a wrong offset in the module shows up as a
 * wrong VALUE rather than as an off-by-one nobody notices.
 */
function advancedPayload(): Uint8Array {
  const bytes = new Uint8Array(61);
  const view = new DataView(bytes.buffer);
  bytes[8] = 37; // feedforward_transition
  view.setUint16(13, 400, true); // rateAccelLimit
  view.setUint16(15, 300, true); // yawRateAccelLimit
  bytes[17] = 55; // angle_limit
  view.setUint16(21, 3500 % 65536, true); // anti_gravity_gain (raw, unbounded here)
  bytes[25] = 1; // iterm_rotation
  bytes[27] = 3; // iterm_relax
  bytes[28] = 1; // iterm_relax_type
  bytes[30] = 12; // throttle_boost
  bytes[31] = 42; // acro_trainer_angle_limit
  bytes[39] = 47; // d_max roll
  bytes[40] = 48; // d_max pitch
  bytes[41] = 0; // d_max yaw
  bytes[42] = 37; // d_max_gain
  bytes[43] = 20; // d_max_advance
  bytes[46] = 15; // iterm_relax_cutoff
  bytes[47] = 100; // motor_output_limit
  bytes[48] = 0xff; // auto_profile_cell_count, i.e. -1
  bytes[51] = 25; // feedforward_smooth_factor
  bytes[53] = 90; // feedforward_max_rate_limit
  bytes[55] = 20; // vbat_sag_compensation
  bytes[56] = 30; // thrust_linearization
  bytes[57] = 1; // tpa_mode
  bytes[58] = 65; // tpa_rate
  view.setUint16(59, 1350, true); // tpa_breakpoint
  return bytes;
}

describe('advanced PID field catalogue', () => {
  it('reads every owned field from the offset the firmware reads it from', () => {
    const draft = createAdvancedPidDraftFromRaw(advancedPayload());
    expect(draft).toEqual({
      dMaxRoll: 47,
      dMaxPitch: 48,
      dMaxYaw: 0,
      dMaxGain: 37,
      dMaxAdvance: 20,
      feedforwardTransition: 37,
      feedforwardSmoothFactor: 25,
      feedforwardMaxRateLimit: 90,
      tpaMode: 1,
      tpaRate: 65,
      tpaBreakpoint: 1350,
      itermRelax: 3,
      itermRelaxType: 1,
      itermRelaxCutoff: 15,
      itermRotation: 1,
      antiGravityGain: 3500,
      throttleBoost: 12,
      thrustLinearization: 30,
      vbatSagCompensation: 20,
      motorOutputLimit: 100,
      angleLimit: 55,
      acroTrainerAngleLimit: 42,
      rateAccelLimit: 400,
      yawRateAccelLimit: 300,
      autoProfileCellCount: -1,
    });
  });

  it('reads auto profile cell count SIGNED, so the sentinel stays a sentinel', () => {
    // 0xFF is AUTO_PROFILE_CELL_COUNT_CHANGE (-1), not 255 cells. An
    // unsigned read here would silently offer "255" as a cell count.
    expect(createAdvancedPidDraftFromRaw(advancedPayload()).autoProfileCellCount).toBe(-1);
    const stay = advancedPayload();
    stay[48] = 0;
    expect(createAdvancedPidDraftFromRaw(stay).autoProfileCellCount).toBe(0);
    const sixCells = advancedPayload();
    sixCells[48] = 6;
    expect(createAdvancedPidDraftFromRaw(sixCells).autoProfileCellCount).toBe(6);
  });

  it('patches back byte for byte and leaves every unowned byte alone', () => {
    const board = Uint8Array.from({length: 61}, (_unused, index) => (index * 11) % 256);
    const clone = board.slice();
    const draft = createAdvancedPidDraftFromRaw(board);
    patchAdvancedPidDraft(clone, draft);
    expect([...clone]).toEqual([...board]);
  });

  it('writes -1 back as 0xFF rather than as 255 truncated', () => {
    const payload = new Uint8Array(61);
    const draft: AdvancedPidDraft = {
      ...createAdvancedPidDraftFromRaw(payload),
      autoProfileCellCount: -1,
    };
    patchAdvancedPidDraft(payload, draft);
    expect(payload[48]).toBe(0xff);
    expect(createAdvancedPidDraftFromRaw(payload).autoProfileCellCount).toBe(-1);
  });

  it('preserves the bytes between owned fields when one field moves', () => {
    const board = Uint8Array.from({length: 61}, (_unused, index) => (index * 11) % 256);
    const patched = board.slice();
    const draft = createAdvancedPidDraftFromRaw(board);
    patchAdvancedPidDraft(patched, {...draft, dMaxGain: 51});
    expect(patched[42]).toBe(51);
    // The two bytes either side of d_max_gain belong to d_max yaw and
    // d_max_advance, both owned; byte 44 (was use_integrated_yaw) is NOT
    // owned and must be untouched.
    expect(patched[44]).toBe(board[44]);
    expect(patched[38]).toBe(board[38]);
  });

  describe('bounds', () => {
    it('cites a firmware source for every field, with no empty citations', () => {
      for (const key of ADVANCED_PID_FIELD_KEYS) {
        expect(ADVANCED_PID_BOUNDS[key].source).toMatch(/settings\.c|\.h/);
      }
    });

    it('rejects a moved field outside the firmware bound', () => {
      const stored = createAdvancedPidDraftFromRaw(advancedPayload());
      expect(invalidAdvancedFields({...stored, dMaxRoll: 251}, stored)).toEqual(['dMaxRoll']);
      expect(invalidAdvancedFields({...stored, motorOutputLimit: 0}, stored)).toEqual(['motorOutputLimit']);
      expect(invalidAdvancedFields({...stored, tpaBreakpoint: 999}, stored)).toEqual(['tpaBreakpoint']);
    });

    it('exempts a field the operator never touched, however odd the stored byte', () => {
      // 3500 is far above the anti-gravity ceiling of 250. It came off the
      // board that way; holding an untouched field to a range would make
      // the whole screen unsaveable over a byte nobody edited.
      const stored = createAdvancedPidDraftFromRaw(advancedPayload());
      expect(stored.antiGravityGain).toBe(3500);
      expect(invalidAdvancedFields(stored, stored)).toEqual([]);
      // ...and the moment the operator moves it, it IS bounded.
      expect(invalidAdvancedFields({...stored, antiGravityGain: 3400}, stored))
        .toEqual(['antiGravityGain']);
    });

    it('bounds every field when there is no stored draft to compare against', () => {
      const stored = createAdvancedPidDraftFromRaw(advancedPayload());
      expect(invalidAdvancedFields(stored)).toEqual(['antiGravityGain']);
    });

    it('offers tpa_mode only the two modes a non-wing build defines', () => {
      // settings.c's lookup carries PD and PDS, but PDS is compiled in
      // behind USE_WING. Offering it on a build without it would be
      // offering a value the board cannot store.
      expect(ADVANCED_PID_BOUNDS.tpaMode.choices).toEqual([0, 1]);
      const stored = createAdvancedPidDraftFromRaw(advancedPayload());
      expect(invalidAdvancedFields({...stored, tpaMode: 2}, stored)).toEqual(['tpaMode']);
    });

    it('treats the auto-profile sentinel as a legal value and 9 cells as not', () => {
      const stored = createAdvancedPidDraftFromRaw(advancedPayload());
      expect(invalidAdvancedFields({...stored, autoProfileCellCount: 0}, stored)).toEqual([]);
      expect(invalidAdvancedFields({...stored, autoProfileCellCount: 8}, stored)).toEqual([]);
      expect(invalidAdvancedFields({...stored, autoProfileCellCount: 9}, stored))
        .toEqual(['autoProfileCellCount']);
      expect(invalidAdvancedFields({...stored, autoProfileCellCount: -2}, stored))
        .toEqual(['autoProfileCellCount']);
    });

    it('rejects a non-integer, which a text field can produce', () => {
      const stored = createAdvancedPidDraftFromRaw(advancedPayload());
      expect(invalidAdvancedFields({...stored, throttleBoost: 12.5}, stored))
        .toEqual(['throttleBoost']);
      expect(invalidAdvancedFields({...stored, throttleBoost: Number.NaN}, stored))
        .toEqual(['throttleBoost']);
    });
  });

  it('reports exactly which fields moved', () => {
    const stored = createAdvancedPidDraftFromRaw(advancedPayload());
    expect(movedAdvancedFields(stored, stored)).toEqual([]);
    expect(advancedPidDraftsEqual(stored, stored)).toBe(true);
    const moved = {...stored, dMaxYaw: 30, itermRelax: 4};
    expect(movedAdvancedFields(stored, moved)).toEqual(['dMaxYaw', 'itermRelax']);
    expect(advancedPidDraftsEqual(stored, moved)).toBe(false);
  });
});
