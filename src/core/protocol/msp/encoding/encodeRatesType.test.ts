/**
 * P-C2 - the rate FORMULA byte, on its own.
 *
 * A rates-type write is the smallest write this app makes and the one with
 * the largest behavioural consequence: it changes how every stored rate
 * number is interpreted without changing any of them.
 */

import {RC_TUNING_FIXTURE} from '../../__testUtils__/pidWireFixtures';
import {RC_TUNING_OFFSETS} from '../decoding/decodeRcTuningFull';
import {
  ENCODABLE_RATES_TYPES,
  RATES_TYPE_COUNT_SENTINEL,
  RATES_TYPE_RAW_ACTUAL,
  RATES_TYPE_RAW_BETAFLIGHT,
  RATES_TYPE_RAW_KISS,
  RATES_TYPE_RAW_QUICK,
  RATES_TYPE_RAW_RACEFLIGHT,
  encodeRcTuningRatesType,
  isEncodableRatesType,
} from './encodeRatesType';

describe('P-C2 - MSP_SET_RC_TUNING carrying only a new rates type', () => {
  it('names the five formulas the pinned trees define', () => {
    expect(ENCODABLE_RATES_TYPES).toEqual([
      RATES_TYPE_RAW_BETAFLIGHT, RATES_TYPE_RAW_RACEFLIGHT, RATES_TYPE_RAW_KISS,
      RATES_TYPE_RAW_ACTUAL, RATES_TYPE_RAW_QUICK,
    ]);
    expect(RATES_TYPE_COUNT_SENTINEL).toBe(5);
  });

  it.each([0, 1, 2, 3, 4])('accepts rates type %i', type => {
    expect(isEncodableRatesType(type)).toBe(true);
  });

  it.each([-1, 5, 6, 250, 1.5, Number.NaN])('refuses %p', type => {
    expect(isEncodableRatesType(type)).toBe(false);
    expect(() => encodeRcTuningRatesType(RC_TUNING_FIXTURE, type)).toThrow(RangeError);
  });

  it('never normalises an unknown type into a known one', () => {
    // RATES_TYPE_COUNT is the enum terminator. Silently turning it into
    // BETAFLIGHT would be this app choosing a flight model on the pilot's
    // behalf because a number was out of range.
    expect(() => encodeRcTuningRatesType(RC_TUNING_FIXTURE, RATES_TYPE_COUNT_SENTINEL))
      .toThrow(/not one of the five formulas/);
  });

  it('changes exactly one byte of twenty-four', () => {
    const payload = encodeRcTuningRatesType(RC_TUNING_FIXTURE, RATES_TYPE_RAW_ACTUAL);
    expect(payload).toHaveLength(24);
    expect(payload[RC_TUNING_OFFSETS.ratesType]).toBe(RATES_TYPE_RAW_ACTUAL);
    for (let offset = 0; offset < 24; offset += 1) {
      if (offset === RC_TUNING_OFFSETS.ratesType) continue;
      expect([offset, payload[offset]]).toEqual([offset, RC_TUNING_FIXTURE[offset]]);
    }
  });

  it('refuses to build a write from a short observation', () => {
    expect(() => encodeRcTuningRatesType(RC_TUNING_FIXTURE.slice(0, 20), RATES_TYPE_RAW_KISS))
      .toThrow(RangeError);
  });

  it('does not mutate the observation it was given', () => {
    const before = Uint8Array.from(RC_TUNING_FIXTURE);
    encodeRcTuningRatesType(RC_TUNING_FIXTURE, RATES_TYPE_RAW_QUICK);
    expect(RC_TUNING_FIXTURE).toEqual(before);
  });
});
