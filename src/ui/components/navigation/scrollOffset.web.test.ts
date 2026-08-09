/**
 * The browser's horizontal scroll coordinate is the MIRROR of Android's
 * under RTL, and that is why this file exists as a platform pair at all.
 *
 * Measured in Chromium on the real tab bar at 390px: the scroller
 * accepted `scrollLeft = -1314` (the far end of a 1723px strip) and
 * clamped `+99999` to 1. A left-origin offset handed straight to
 * react-native-web - which assigns `node.scrollLeft = x` verbatim - would
 * therefore clamp to 0 and the strip would never move.
 *
 * Direction is INJECTED rather than toggled through I18nManager: under
 * the React Native Jest preset `forceRTL()` does not move `isRTL`, so an
 * assertion that "switches" direction that way passes vacuously.
 */
let mockRtl = true;
jest.mock('../../icons/layoutDirection', () => ({
  isRtlLayout: () => mockRtl,
}));

import {horizontalScrollOffset} from './scrollOffset.web';

describe('horizontalScrollOffset (browser)', () => {
  it('mirrors a left-origin offset into the non-positive RTL range', () => {
    mockRtl = true;
    // The reading-start edge - the RIGHT under RTL - is scrollLeft 0.
    expect(horizontalScrollOffset(1333, 1333)).toBe(0);
    // The far end is the full range, negative.
    expect(horizontalScrollOffset(0, 1333)).toBe(-1333);
    expect(horizontalScrollOffset(640, 1333)).toBe(-693);
  });

  it('passes a left-origin offset straight through under LTR', () => {
    mockRtl = false;
    expect(horizontalScrollOffset(0, 1333)).toBe(0);
    expect(horizontalScrollOffset(1333, 1333)).toBe(1333);
    expect(horizontalScrollOffset(640, 1333)).toBe(640);
  });

  it('never leaves the platform range in either direction', () => {
    for (const rtl of [true, false]) {
      mockRtl = rtl;
      for (const leftOrigin of [0, 1, 640, 1332, 1333]) {
        const offset = horizontalScrollOffset(leftOrigin, 1333);
        expect(offset).toBeGreaterThanOrEqual(rtl ? -1333 : 0);
        expect(offset).toBeLessThanOrEqual(rtl ? 0 : 1333);
      }
    }
  });
});
