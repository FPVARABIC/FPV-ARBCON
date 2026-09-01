/**
 * ONE BYTE, TWO MEANINGS - the asymmetry that makes this worth its own
 * module and its own test. A rate profile is the index OR'd with 0x80;
 * a PID profile is the bare index. Getting it backwards would switch the
 * wrong profile and the board would acknowledge it happily.
 */

import {
  encodeSelectSetting,
  isEncodableProfileIndex,
  SELECT_SETTING_MAX_INDEX,
  SELECT_SETTING_RATE_PROFILE_FLAG,
} from './encodeSelectSetting';

describe('encodeSelectSetting', () => {
  it('sends a PID profile as the bare index', () => {
    expect(Array.from(encodeSelectSetting('PID', 0))).toEqual([0]);
    expect(Array.from(encodeSelectSetting('PID', 2))).toEqual([2]);
  });

  it('sets the high bit for a rate profile, and only for a rate profile', () => {
    // Literal bytes, hand-computed from 0x80 | index. Building the
    // expectation from the same constant the encoder uses would assert
    // that the encoder equals itself.
    expect(Array.from(encodeSelectSetting('RATE', 0))).toEqual([128]);
    expect(Array.from(encodeSelectSetting('RATE', 2))).toEqual([130]);
    expect(SELECT_SETTING_RATE_PROFILE_FLAG).toBe(0x80);
  });

  it('refuses an index that would collide with the discriminator', () => {
    // 128 as a "PID profile" arrives at the board as rate profile 0.
    expect(isEncodableProfileIndex(SELECT_SETTING_MAX_INDEX)).toBe(true);
    expect(isEncodableProfileIndex(SELECT_SETTING_RATE_PROFILE_FLAG)).toBe(false);
    expect(() => encodeSelectSetting('PID', SELECT_SETTING_RATE_PROFILE_FLAG)).toThrow(RangeError);
  });

  it('refuses anything that is not a whole, non-negative index', () => {
    expect(isEncodableProfileIndex(-1)).toBe(false);
    expect(isEncodableProfileIndex(1.5)).toBe(false);
    expect(isEncodableProfileIndex(Number.NaN)).toBe(false);
    expect(() => encodeSelectSetting('RATE', -1)).toThrow(RangeError);
  });
});
