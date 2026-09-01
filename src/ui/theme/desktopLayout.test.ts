/**
 * THE DESKTOP ENVELOPE, AND THE TRAP THAT COMES WITH ADDING A TIER.
 *
 * This file was written when the answer to "a tool full of controls with
 * 400-600px of dead ground down each side" was a THIRD, WIDER CAP -
 * WORKSPACE_ULTRA_MAX_WIDTH, 2040. On a real 3440x1440 ultrawide that cap
 * became the defect it was meant to cure. Measured in Chromium on the
 * real shell, identically on all eight tool screens because the cap and
 * not the screen was the owner:
 *
 *   2560px window   2040 of 2352 usable  87%   156px dead down each side
 *   3440px window   2040 of 3232 usable  63%   596px dead down each side
 *   3840px window   2040 of 3632 usable  56%   796px dead down each side
 *
 * So there is no third cap any more, and no first or second one either
 * for a screen that has split into columns: `contentEnvelope` returns
 * `undefined` and the screen takes the width the shell gave it.
 *
 * BOTH HALVES ARE STILL HERE, and they are the halves that matter:
 * that the workspace is released, and that NOTHING SCALES to fill it -
 * the reading cap, the prose measure and the tier ladder are untouched.
 */

import {
  CONTENT_MAX_WIDTH,
  LAYOUT_BREAKPOINTS,
  PROSE_MEASURE,
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

describe('a large monitor gets its whole workspace, not a bigger one', () => {
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

  it('releases a split workspace from any cap, there and only there', () => {
    expect(contentEnvelope('desktop', true)).toBeUndefined();
    expect(contentEnvelope('desktopWide', true)).toBeUndefined();
    expect(contentEnvelope('desktopUltra', true)).toBeUndefined();
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

  it('keeps the tier ladder ordered', () => {
    expect(LAYOUT_BREAKPOINTS.desktopUltra).toBeGreaterThan(
      LAYOUT_BREAKPOINTS.desktopWide,
    );
    expect(LAYOUT_BREAKPOINTS.desktopWide).toBeGreaterThan(
      LAYOUT_BREAKPOINTS.desktop,
    );
  });

  /**
   * AND IT IS THE WHOLE WINDOW, WHICH REVERSES A DECISION THIS FILE USED
   * TO ASSERT.
   *
   * The old test here read `WORKSPACE_ULTRA_MAX_WIDTH < 2560 * 0.85` and
   * was called "stops well short of a 2560 viewport", on the reasoning
   * that an edge-to-edge workspace "puts its two ends a head-turn apart".
   * The operator, on the monitor in question, reported the opposite: an
   * application sitting inside a page. The reversal is deliberate and
   * recorded rather than deleted, and what replaces it is stronger,
   * because a constant cannot be checked against a viewport that does not
   * exist at unit-test time: `scripts/verify-desktop-workspace.mjs`
   * measures the RENDERED workspace against the RENDERED viewport in
   * Chromium at 1920/2560/3440/3840.
   *
   * What is still asserted here is the half that did not reverse: no
   * number in this module may quietly become a workspace cap again.
   */
  it('offers no constant that could serve as a workspace cap', () => {
    const layout: Record<string, unknown> = LAYOUT_BREAKPOINTS;
    for (const [name, value] of Object.entries(layout)) {
      /* Breakpoints decide WHICH LAYOUT to use; they must never be
         mistaken for how wide the result may be. */
      expect(typeof value).toBe('number');
      expect(name).not.toMatch(/max|width|envelope/i);
    }
    expect(contentEnvelope('desktopUltra', true)).toBeUndefined();
  });
});

describe('the prose measure is what keeps the extra width honest', () => {
  /**
   * Widening the container has exactly one failure mode, and it was
   * measured rather than imagined: hero subtitles and safety notes ran
   * 1650-1688px at 1920 and up to 2016px at 2560 - a single line of
   * Arabic across a metre of screen.
   */
  it('is a readable measure, well below even the reading column', () => {
    expect(PROSE_MEASURE).toBeGreaterThan(500);
    expect(PROSE_MEASURE).toBeLessThan(CONTENT_MAX_WIDTH);
    /* It is now the ONLY bound on a sentence inside a tool screen, since
       the container around it has none. Two thirds of a reading column
       keeps that margin obvious rather than incidental. */
    expect(PROSE_MEASURE).toBeLessThan(CONTENT_MAX_WIDTH * (2 / 3) + 1);
  });

  /** It bounds paragraphs; it must never bound a layout. */
  it('is smaller than the narrowest phone this app supports is wide', () => {
    expect(PROSE_MEASURE).toBeGreaterThan(LAYOUT_BREAKPOINTS.phoneNarrow);
  });
});
