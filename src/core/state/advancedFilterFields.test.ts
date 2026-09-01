/**
 * THE ADVANCED FILTER CATALOGUE, AND THE SCOPE SPLIT IT MUST NOT LOSE.
 *
 * Offsets are counted by hand off the firmware's own
 * `MSP_SET_FILTER_CONFIG` reader (msp.c), never taken from our encoder.
 * The scope assertions are pinned against `filterFieldScope()`, which the
 * decoder derives independently, so the two cannot drift without a
 * failure here.
 */

import {
  filterFieldScope,
  type FilterFieldKey,
} from '../protocol/msp/decoding/decodeFilterConfigFull';
import {
  ADVANCED_FILTER_BOUNDS,
  ADVANCED_FILTER_FIELD_KEYS,
  advancedFilterDraftsEqual,
  createAdvancedFilterDraftFromRaw,
  invalidAdvancedFilterFields,
  movedAdvancedFilterFields,
  patchAdvancedFilterDraft,
} from './advancedFilterFields';

/** 49 bytes - the API 1.47 fixed head - with a distinct value per field. */
function filterPayload(): Uint8Array {
  const bytes = new Uint8Array(49);
  const view = new DataView(bytes.buffer);
  view.setUint16(3, 120, true); // yaw_lowpass_hz
  view.setUint16(5, 265, true); // gyro_notch1_hz
  view.setUint16(7, 160, true); // gyro_notch1_cutoff
  view.setUint16(9, 275, true); // dterm_notch_hz
  view.setUint16(11, 170, true); // dterm_notch_cutoff
  view.setUint16(13, 190, true); // gyro_notch2_hz
  view.setUint16(15, 110, true); // gyro_notch2_cutoff
  bytes[17] = 2; // dterm_lpf1_type = PT2
  view.setUint16(22, 500, true); // gyro_lpf2_static_hz
  bytes[24] = 3; // gyro_lpf1_type = PT3
  bytes[25] = 1; // gyro_lpf2_type = BIQUAD
  view.setUint16(26, 150, true); // dterm_lpf2_static_hz
  bytes[28] = 0; // dterm_lpf2_type = PT1
  bytes[47] = 7; // dterm_lpf1_dyn_expo
  return bytes;
}

describe('advanced filter field catalogue', () => {
  it('reads every owned field from the offset the firmware reads it from', () => {
    expect(createAdvancedFilterDraftFromRaw(filterPayload())).toEqual({
      gyroLpf1Type: 3,
      gyroLpf2StaticHz: 500,
      gyroLpf2Type: 1,
      gyroSoftNotchHz1: 265,
      gyroSoftNotchCutoff1: 160,
      gyroSoftNotchHz2: 190,
      gyroSoftNotchCutoff2: 110,
      dtermLpf1Type: 2,
      dtermLpf1DynExpo: 7,
      dtermLpf2StaticHz: 150,
      dtermLpf2Type: 0,
      dtermNotchHz: 275,
      dtermNotchCutoff: 170,
      yawLowpassHz: 120,
    });
  });

  it('patches back byte for byte and leaves every unowned byte alone', () => {
    const board = Uint8Array.from({length: 49}, (_unused, index) => (index * 5) % 256);
    const clone = board.slice();
    patchAdvancedFilterDraft(clone, createAdvancedFilterDraftFromRaw(board));
    expect([...clone]).toEqual([...board]);
  });

  it('never reaches the API 1.48 RPM tail', () => {
    // The tail starts at offset 49. A payload that carries one must come
    // back with it untouched: this phase reads the RPM filter and offers
    // no write for it.
    const board = Uint8Array.from({length: 56}, (_unused, index) => (index * 3 + 1) % 256);
    const clone = board.slice();
    patchAdvancedFilterDraft(clone, {
      ...createAdvancedFilterDraftFromRaw(board),
      gyroLpf2StaticHz: 480,
    });
    expect([...clone.slice(49)]).toEqual([...board.slice(49)]);
  });

  it('writes a u16 field as two little-endian bytes, not as one', () => {
    const payload = new Uint8Array(49);
    patchAdvancedFilterDraft(payload, {
      ...createAdvancedFilterDraftFromRaw(payload),
      gyroSoftNotchHz2: 300,
    });
    // 300 = 0x012C: low byte first at 13, high byte at 14.
    expect(payload[13]).toBe(0x2c);
    expect(payload[14]).toBe(0x01);
  });

  describe('scope', () => {
    it('agrees field for field with the decoder\'s own parameter-group split', () => {
      // The decoder derives this from the firmware's PG_ assignments. Two
      // tables saying the same thing is only safe if something checks.
      for (const key of ADVANCED_FILTER_FIELD_KEYS) {
        expect(ADVANCED_FILTER_BOUNDS[key].scope).toBe(filterFieldScope(key as FilterFieldKey));
      }
    });

    it('keeps the D-term chain per-profile and the gyro chain global', () => {
      expect(ADVANCED_FILTER_BOUNDS.dtermLpf2StaticHz.scope).toBe('PID_PROFILE');
      expect(ADVANCED_FILTER_BOUNDS.dtermNotchHz.scope).toBe('PID_PROFILE');
      expect(ADVANCED_FILTER_BOUNDS.yawLowpassHz.scope).toBe('PID_PROFILE');
      expect(ADVANCED_FILTER_BOUNDS.gyroLpf2StaticHz.scope).toBe('GLOBAL');
      expect(ADVANCED_FILTER_BOUNDS.gyroSoftNotchHz2.scope).toBe('GLOBAL');
    });
  });

  describe('bounds', () => {
    it('cites a firmware source for every field', () => {
      for (const key of ADVANCED_FILTER_FIELD_KEYS) {
        expect(ADVANCED_FILTER_BOUNDS[key].source).toMatch(/settings\.c/);
      }
    });

    it('offers all FOUR lowpass types, PT3 included', () => {
      // Both lookup tables are PT1, BIQUAD, PT2, PT3. Stopping at three
      // would make PT3 unselectable on a board already running it.
      for (const key of ['gyroLpf1Type', 'gyroLpf2Type', 'dtermLpf1Type', 'dtermLpf2Type'] as const) {
        expect(ADVANCED_FILTER_BOUNDS[key].choices).toEqual([0, 1, 2, 3]);
      }
      const stored = createAdvancedFilterDraftFromRaw(filterPayload());
      expect(invalidAdvancedFilterFields({...stored, dtermLpf2Type: 3}, stored)).toEqual([]);
      expect(invalidAdvancedFilterFields({...stored, dtermLpf2Type: 4}, stored))
        .toEqual(['dtermLpf2Type']);
    });

    it('rejects a moved frequency above the firmware ceiling', () => {
      const stored = createAdvancedFilterDraftFromRaw(filterPayload());
      expect(invalidAdvancedFilterFields({...stored, gyroLpf2StaticHz: 1001}, stored))
        .toEqual(['gyroLpf2StaticHz']);
      // The yaw lowpass has its OWN, lower ceiling of 500.
      expect(invalidAdvancedFilterFields({...stored, yawLowpassHz: 500}, stored)).toEqual([]);
      expect(invalidAdvancedFilterFields({...stored, yawLowpassHz: 501}, stored))
        .toEqual(['yawLowpassHz']);
    });

    it('bounds the D-term dynamic expo to the firmware row, not to a guess', () => {
      const stored = createAdvancedFilterDraftFromRaw(filterPayload());
      expect(invalidAdvancedFilterFields({...stored, dtermLpf1DynExpo: 10}, stored)).toEqual([]);
      expect(invalidAdvancedFilterFields({...stored, dtermLpf1DynExpo: 11}, stored))
        .toEqual(['dtermLpf1DynExpo']);
    });

    it('exempts an untouched field so one odd stored byte cannot lock the screen', () => {
      const odd = filterPayload();
      new DataView(odd.buffer).setUint16(22, 4000, true); // gyro lpf2 far past 1000
      const stored = createAdvancedFilterDraftFromRaw(odd);
      expect(invalidAdvancedFilterFields(stored, stored)).toEqual([]);
      expect(invalidAdvancedFilterFields(stored)).toEqual(['gyroLpf2StaticHz']);
    });
  });

  it('reports exactly which fields moved', () => {
    const stored = createAdvancedFilterDraftFromRaw(filterPayload());
    expect(movedAdvancedFilterFields(stored, stored)).toEqual([]);
    expect(advancedFilterDraftsEqual(stored, stored)).toBe(true);
    const moved = {...stored, gyroLpf1Type: 0, dtermNotchCutoff: 180};
    expect(movedAdvancedFilterFields(stored, moved)).toEqual(['gyroLpf1Type', 'dtermNotchCutoff']);
    expect(advancedFilterDraftsEqual(stored, moved)).toBe(false);
  });
});
