/**
 * THE RESPONSIVE TIER LADDER.
 *
 * These are the numbers every adaptive screen now shares, so they need to
 * be pinned in one place rather than re-derived per screen. Two
 * properties matter beyond the arithmetic:
 *
 *   - fontScale normalisation. A user at 200% text on a 1200px window has
 *     the effective room of 600px, and must NOT be handed a two-column
 *     desktop layout with no space for the words.
 *   - The two envelopes are not interchangeable. A screen that has not
 *     split into columns keeps the reading cap however wide the window
 *     is; only a screen that genuinely arranges content in parallel
 *     earns the workspace width. Raising one number for everything was
 *     the explicitly rejected non-fix.
 */

import {
  CONTENT_MAX_WIDTH,
  LAYOUT_BREAKPOINTS,
  WORKSPACE_MAX_WIDTH,
  contentEnvelope,
  effectiveWidth,
  isDesktopTier,
  resolveLayoutTier,
} from './layout';

describe('resolveLayoutTier', () => {
  it.each([
    [320, 'compact'],
    [390, 'compact'],
    [619, 'compact'],
    [620, 'tablet'],
    [759, 'tablet'],
    [760, 'wide'],
    [1023, 'wide'],
    [1024, 'desktop'],
    [1439, 'desktop'],
    [1440, 'desktopWide'],
    [1919, 'desktopWide'],
    // A genuinely large monitor gets its own tier - see
    // desktopLayout.test.ts for what that tier is allowed to change.
    [1920, 'desktopUltra'],
    [2560, 'desktopUltra'],
  ])('resolves %ipx (fontScale 1) to %s', (width, expected) => {
    expect(resolveLayoutTier(width, 1)).toBe(expected);
  });

  it('normalises by fontScale, so large text drops the tier', () => {
    // 1200 raw pixels at 200% text is 600 effective - genuinely compact.
    expect(resolveLayoutTier(1200, 2)).toBe('compact');
    // 1200 raw at 125% is 960 effective - a wide tablet, not a desktop.
    expect(resolveLayoutTier(1200, 1.25)).toBe('wide');
    // 1400 raw at 125% is 1120 effective - clears desktop, not desktopWide.
    expect(resolveLayoutTier(1400, 1.25)).toBe('desktop');
    // A 1920 monitor at 125% text is 1536 effective and still the top tier.
    expect(resolveLayoutTier(1920, 1.25)).toBe('desktopWide');
  });

  it('never divides by a fontScale below 1', () => {
    // A zero/absent fontScale must not invert or explode the result.
    expect(effectiveWidth(1000, 0)).toBe(1000);
    expect(effectiveWidth(1000, 0.5)).toBe(1000);
    expect(resolveLayoutTier(1920, 0)).toBe('desktopUltra');
  });

  it('keeps the pre-existing thresholds the shipped screens already use', () => {
    // GpsScreen/OrientationHero use 620 and ConfigurationsScreen 760;
    // changing either silently would alter Android layouts that ship.
    expect(LAYOUT_BREAKPOINTS.tablet).toBe(620);
    expect(LAYOUT_BREAKPOINTS.wide).toBe(760);
  });
});

describe('contentEnvelope', () => {
  it('keeps the reading cap for a screen that has NOT split into columns', () => {
    // The whole point: a paragraph must not span a 1920px monitor.
    expect(contentEnvelope('desktopWide', false)).toBe(CONTENT_MAX_WIDTH);
    expect(contentEnvelope('desktop', false)).toBe(CONTENT_MAX_WIDTH);
  });

  it('grants the workspace width only when a desktop tier actually splits', () => {
    expect(contentEnvelope('desktop', true)).toBe(WORKSPACE_MAX_WIDTH);
    expect(contentEnvelope('desktopWide', true)).toBe(WORKSPACE_MAX_WIDTH);
  });

  it('never grants it below the desktop tier, even if a screen asks', () => {
    // A tablet claiming to split must still be capped for reading: the
    // columns there are too narrow to earn extra width.
    expect(contentEnvelope('wide', true)).toBe(CONTENT_MAX_WIDTH);
    expect(contentEnvelope('tablet', true)).toBe(CONTENT_MAX_WIDTH);
    expect(contentEnvelope('compact', true)).toBe(CONTENT_MAX_WIDTH);
  });

  it('keeps the reading cap at the value eight screens assert literally', () => {
    // TabletResponsiveLayout.test.ts asserts the literal 'maxWidth: 1180'
    // in each screen's own source. If this constant and that literal ever
    // disagree, one of the two is lying about what ships.
    expect(CONTENT_MAX_WIDTH).toBe(1180);
  });
});

describe('isDesktopTier', () => {
  it('is true only from the desktop tier upward', () => {
    expect(isDesktopTier('compact')).toBe(false);
    expect(isDesktopTier('tablet')).toBe(false);
    expect(isDesktopTier('wide')).toBe(false);
    expect(isDesktopTier('desktop')).toBe(true);
    expect(isDesktopTier('desktopWide')).toBe(true);
  });
});
