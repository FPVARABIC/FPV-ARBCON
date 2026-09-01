/**
 * THE DIRECTION OWNER, ON THE NATIVE SIDE.
 *
 * `isRtlLayout()` is the one place the app asks which way the layout
 * runs. Everything that has to choose a physical side - a chevron's
 * glyph, a horizontal scroll origin, an LED row, a Receiver channel
 * bar's start edge - resolves through it, and every one of those callers
 * injects it in their own tests. That is the right seam for them, but it
 * leaves the owner itself with no coverage: replacing its body with
 * `return false` kept every one of those suites green.
 *
 * So this exercises the REAL implementation. On a React Native host the
 * authority is I18nManager, whose flag the layout engine itself uses, so
 * the assertion is that the owner reports that flag and does not
 * substitute a guess of its own.
 *
 * The `.web.ts` sibling has its own test, because the browser cannot
 * answer this question the same way and the two must not drift.
 */
import {I18nManager} from 'react-native';
import {isRtlLayout} from './layoutDirection';

/**
 * `forceRTL()` does not move `isRTL` under the React Native Jest preset,
 * so the flag is set directly. Restored after every case: it is process
 * global, and a leaked value would quietly steer other suites.
 */
function withIsRtl<T>(value: boolean, body: () => T): T {
  const previous = I18nManager.isRTL;
  Object.defineProperty(I18nManager, 'isRTL', {value, configurable: true});
  try {
    return body();
  } finally {
    Object.defineProperty(I18nManager, 'isRTL', {value: previous, configurable: true});
  }
}

describe('isRtlLayout on a React Native host', () => {
  it('reports the layout engine flag rather than a guess', () => {
    expect(withIsRtl(true, isRtlLayout)).toBe(true);
    expect(withIsRtl(false, isRtlLayout)).toBe(false);
  });

  it('follows the flag when it changes, with no cached first answer', () => {
    const observed = [
      withIsRtl(true, isRtlLayout),
      withIsRtl(false, isRtlLayout),
      withIsRtl(true, isRtlLayout),
    ];
    expect(observed).toEqual([true, false, true]);
  });

  it('leaves the global flag exactly as it found it', () => {
    const before = I18nManager.isRTL;
    withIsRtl(!before, isRtlLayout);
    expect(I18nManager.isRTL).toBe(before);
  });
});
