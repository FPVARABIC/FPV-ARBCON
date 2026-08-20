/**
 * THE DESKTOP ENVELOPE, AND THE TRAP THAT COMES WITH ADDING A TIER.
 *
 * Measured before this pass, in Chromium, on the real application:
 *
 *   1920px window   workspaces painted 1564 of 1712 usable px  (91%)
 *                   Failsafe painted 1144                      (67%)
 *   2560px window   workspaces painted 1564 of 2352            (67%)
 *                   Failsafe painted 1144                      (49%)
 *
 * - 400 to 600px of dead ground down each side of a tool full of
 * controls. The fix is a THIRD envelope for genuinely large monitors,
 * and this file holds both halves of it: that the envelope exists, and
 * that nothing scales to fill it.
 */

import {
  CONTENT_MAX_WIDTH,
  LAYOUT_BREAKPOINTS,
  PROSE_MEASURE,
  WORKSPACE_MAX_WIDTH,
  WORKSPACE_ULTRA_MAX_WIDTH,
  contentEnvelope,
  isDesktopTier,
  resolveLayoutTier,
} from './layout';
import type {LayoutTier} from './layout';

const ALL_TIERS: readonly LayoutTier[] = [
  'compact',
  'tablet',
  'wide',
  'desktop',
  'desktopWide',
  'desktopUltra',
];

describe('a large monitor gets a wider workspace, not a bigger one', () => {
  it('resolves the ultra tier only at the measured threshold', () => {
    expect(resolveLayoutTier(1919, 1)).toBe('desktopWide');
    expect(resolveLayoutTier(1920, 1)).toBe('desktopUltra');
    expect(resolveLayoutTier(2560, 1)).toBe('desktopUltra');
  });

  /** The same normalisation every other tier uses: a user at 200% text
   *  on a 2560 monitor has the effective room of 1280, not of 2560. */
  it('normalises by fontScale like every tier before it', () => {
    expect(resolveLayoutTier(2560, 2)).toBe('desktop');
    expect(resolveLayoutTier(3840, 2)).toBe('desktopUltra');
  });

  it('gives a split workspace the wider envelope there and only there', () => {
    expect(contentEnvelope('desktop', true)).toBe(WORKSPACE_MAX_WIDTH);
    expect(contentEnvelope('desktopWide', true)).toBe(WORKSPACE_MAX_WIDTH);
    expect(contentEnvelope('desktopUltra', true)).toBe(
      WORKSPACE_ULTRA_MAX_WIDTH,
    );
  });

  /**
   * A READING COLUMN NEVER GETS IT. The whole reason there are two
   * envelopes is that widening a column of prose makes it worse, not
   * better - so the wider one is unreachable without a real split.
   */
  it.each(ALL_TIERS)('keeps a reading column at the reading cap (%s)', tier => {
    expect(contentEnvelope(tier, false)).toBe(CONTENT_MAX_WIDTH);
  });

  it('leaves every tier below desktop exactly where it was', () => {
    for (const tier of ['compact', 'tablet', 'wide'] as const) {
      expect(contentEnvelope(tier, true)).toBe(CONTENT_MAX_WIDTH);
    }
  });

  /**
   * THE TRAP, and it caught two real screens the day the tier was added.
   *
   * `MotorAirframeDiagram` sized itself with a chain of
   * `tier === 'desktopWide' ? ... : tier === 'desktop' ? ...`, and
   * `MotorIdentitySection` decided its two-column layout with
   * `tier === 'desktop' || tier === 'desktopWide'`. A NEW desktop tier
   * matched neither, so on a 1920 monitor the diagram silently fell back
   * to its phone size and the identity section collapsed to one column -
   * measured as fonts and icons SHRINKING between two runs of the same
   * sweep.
   *
   * The rule this asserts: a desktop tier is asked about through the
   * predicate, never by listing names.
   */
  it('reports every desktop tier as a desktop tier', () => {
    expect(isDesktopTier('desktopUltra')).toBe(true);
    expect(isDesktopTier('desktopWide')).toBe(true);
    expect(isDesktopTier('desktop')).toBe(true);
    expect(isDesktopTier('wide')).toBe(false);
    expect(isDesktopTier('tablet')).toBe(false);
    expect(isDesktopTier('compact')).toBe(false);
  });

  it('has an ultra breakpoint above the wide one, and an envelope to match', () => {
    expect(LAYOUT_BREAKPOINTS.desktopUltra).toBeGreaterThan(
      LAYOUT_BREAKPOINTS.desktopWide,
    );
    expect(WORKSPACE_ULTRA_MAX_WIDTH).toBeGreaterThan(WORKSPACE_MAX_WIDTH);
  });

  /**
   * AND IT IS NOT THE WHOLE WINDOW. A workspace that runs edge to edge
   * on a 2560 monitor puts its two ends a head-turn apart.
   */
  it('stops well short of a 2560 viewport', () => {
    expect(WORKSPACE_ULTRA_MAX_WIDTH).toBeLessThan(2560 * 0.85);
  });
});

describe('the prose measure is what keeps the extra width honest', () => {
  /**
   * Widening the container has exactly one failure mode, and it was
   * measured rather than imagined: hero subtitles and safety notes ran
   * 1650-1688px at 1920 and up to 2016px at 2560 - a single line of
   * Arabic across a metre of screen.
   */
  it('is a readable measure, far below either workspace envelope', () => {
    expect(PROSE_MEASURE).toBeGreaterThan(500);
    expect(PROSE_MEASURE).toBeLessThan(CONTENT_MAX_WIDTH);
    expect(PROSE_MEASURE).toBeLessThan(WORKSPACE_MAX_WIDTH / 2);
  });

  /** It bounds paragraphs; it must never bound a layout. */
  it('is smaller than the narrowest phone this app supports is wide', () => {
    expect(PROSE_MEASURE).toBeGreaterThan(LAYOUT_BREAKPOINTS.phoneNarrow);
  });
});
