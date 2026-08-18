/**
 * The bands are Betaflight's, so the boundaries are the whole test.
 *
 * getPositionalDopQuality() in GpsTab.vue uses strict `<` at 1, 2, 5, 10
 * and 20. A reading of exactly 2.00 is therefore GOOD, not EXCELLENT -
 * an off-by-one here would make this app disagree with the official
 * configurator about the same satellites.
 */

import {
  classifyGpsPositionQuality,
  isGpsPositionTrustworthyForRescue,
  GPS_PDOP_BANDS,
} from './gpsPositionQuality';

/** The board sends hundredths; these tests speak in real PDOP. */
const at = (pdop: number) => classifyGpsPositionQuality(Math.round(pdop * 100));

describe('classifyGpsPositionQuality', () => {
  it('uses Betaflight’s own cut points', () => {
    expect(GPS_PDOP_BANDS).toEqual([1, 2, 5, 10, 20]);
  });

  it('classifies each band', () => {
    expect(at(0.8)).toBe('IDEAL');
    expect(at(1.5)).toBe('EXCELLENT');
    expect(at(3.2)).toBe('GOOD');
    expect(at(7)).toBe('MODERATE');
    expect(at(15)).toBe('FAIR');
    expect(at(25)).toBe('POOR');
  });

  it('puts every boundary on the SAME side Betaflight does', () => {
    // Strict `<`: the cut point itself falls into the worse band.
    expect(at(1)).toBe('EXCELLENT');
    expect(at(2)).toBe('GOOD');
    expect(at(5)).toBe('MODERATE');
    expect(at(10)).toBe('FAIR');
    expect(at(20)).toBe('POOR');
  });

  it('reports UNKNOWN rather than inventing a verdict', () => {
    // A board that never sent the field, or a value that makes no sense.
    expect(classifyGpsPositionQuality(undefined)).toBe('UNKNOWN');
    expect(classifyGpsPositionQuality(Number.NaN)).toBe('UNKNOWN');
    expect(classifyGpsPositionQuality(-1)).toBe('UNKNOWN');
  });

  it('treats a perfect zero as a real reading, not as missing', () => {
    // 0 is falsy, and a naive `!value` check would silently downgrade
    // the best possible fix to "no data".
    expect(classifyGpsPositionQuality(0)).toBe('IDEAL');
  });
});

describe('isGpsPositionTrustworthyForRescue', () => {
  it('trusts the top three bands and nothing else', () => {
    expect(isGpsPositionTrustworthyForRescue('IDEAL')).toBe(true);
    expect(isGpsPositionTrustworthyForRescue('EXCELLENT')).toBe(true);
    expect(isGpsPositionTrustworthyForRescue('GOOD')).toBe(true);
    expect(isGpsPositionTrustworthyForRescue('MODERATE')).toBe(false);
    expect(isGpsPositionTrustworthyForRescue('FAIR')).toBe(false);
    expect(isGpsPositionTrustworthyForRescue('POOR')).toBe(false);
  });

  it('does NOT treat an absent reading as good enough', () => {
    // The failure that would matter: a pilot flying out of sight on a
    // rescue whose fix quality was never measured.
    expect(isGpsPositionTrustworthyForRescue('UNKNOWN')).toBe(false);
  });
});
