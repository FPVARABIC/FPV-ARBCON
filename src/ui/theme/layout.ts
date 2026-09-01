/**
 * RESPONSIVE LAYOUT TIERS - the shared vocabulary for adapting a screen
 * to the space it actually has.
 *
 * WHY THIS EXISTS. Three screens (GpsScreen, ConfigurationsScreen,
 * OrientationHero) already adapted using the same idiom - take
 * useWindowDimensions(), divide by fontScale, compare against a literal -
 * but each invented its own literal in its own file. That was fine while
 * the only question was "phone or tablet". It stopped being fine when a
 * measured desktop audit found the Start screen using 59% of a 1920px
 * viewport (docs/WEB_REAL_USER_AUDIT.md, AUD-003): answering that needs a
 * tier every screen agrees on, not a fourth private number.
 *
 * NORMALISING BY fontScale IS NOT COSMETIC, and it is copied from the
 * existing screens deliberately: a user at 200% text size on a 1200px
 * window has the same *effective* room as someone at 100% on 600px.
 * Comparing raw pixels would hand them a two-column layout with no space
 * for the words.
 *
 * WHY A CAP AND A NON-CAP RATHER THAN TWO NUMBERS. Raising the single
 * content cap would make paragraphs span a metre of screen - unreadable,
 * and explicitly not what the desktop complaint was about. So there are
 * two DIFFERENT IDEAS here, not two sizes of the same idea:
 *
 *   CONTENT_MAX_WIDTH (1180) bounds a READING column. A number, because
 *                            a line of text has a length past which the
 *                            eye loses its way back.
 *   THE TOOL WORKSPACE        has no number at all. A screen that has
 *                            actually split into columns is given the
 *                            room the shell handed it, because the right
 *                            width for a workspace is however much
 *                            monitor there is.
 *
 * A screen may only ask for the workspace in a tier where it genuinely
 * arranges content side by side.
 *
 * ANDROID SAFETY. Every threshold above TABLET is beyond what an Android
 * phone or tablet reports, so extending the ladder upward cannot change
 * Android behaviour - the same reason the existing 620/760 thresholds
 * were safe to add. There is no Platform.OS branch here, and there must
 * not be: this codebase splits platforms by file extension, never by
 * runtime check.
 */

/** Effective-width thresholds, in fontScale-normalised pixels. */
export const LAYOUT_BREAKPOINTS = {
  /** Below this, even a 2-up card grid is too tight (SetupScreen). */
  phoneNarrow: 360,
  /** Sidebars and 2-column cards become viable (GpsScreen, OrientationHero). */
  tablet: 620,
  /** Three-region two-column editing becomes viable (ConfigurationsScreen). */
  wide: 760,
  /** A genuine desktop window: primary/secondary columns side by side. */
  desktop: 1024,
  /** Enough room for a workspace with a persistent secondary rail. */
  desktopWide: 1440,
  /**
   * A genuinely large monitor. Measured, not guessed: at 2560 the
   * workspaces were painting 1564px of a 2352px content area - 394px of
   * dead ground down each side - because every one of them stopped at
   * the 1600 envelope that was sized for a 1920 window.
   */
  desktopUltra: 1920,
} as const;

export type LayoutTier =
  | 'compact'
  | 'tablet'
  | 'wide'
  | 'desktop'
  | 'desktopWide'
  | 'desktopUltra';

/** The reading-column envelope. Unchanged, and deliberately so. */
export const CONTENT_MAX_WIDTH = 1180;

/**
 * THE MEASURE - how wide a PARAGRAPH may be, inside any card, at any
 * window size.
 *
 * This exists because widening the workspace envelope has one specific
 * failure mode, and it was measured rather than imagined: at 1920 the
 * hero subtitles and safety notes on twelve screens ran 1650-1688px in
 * a single line, and at 2560 they reached 2016px. A card that is 2000px
 * wide is a legitimate way to put two things side by side; a SENTENCE
 * that is 2000px wide is unreadable, and the eye loses the line on the
 * way back.
 *
 * So the container gets the window and the prose keeps its measure.
 * Applied only to right-aligned paragraph styles: it never bites inside
 * a card narrower than this, and centred text is deliberately untouched
 * because capping a centred box moves it off centre.
 */
export const PROSE_MEASURE = 760;

/**
 * The effective width a layout decision should be made from: raw window
 * width divided by the user's text-scaling factor, floored at 1 so a
 * missing/zero fontScale can never divide by zero or invert the result.
 */
export function effectiveWidth(width: number, fontScale: number): number {
  return width / Math.max(1, fontScale);
}

export function resolveLayoutTier(width: number, fontScale: number): LayoutTier {
  const effective = effectiveWidth(width, fontScale);
  if (effective >= LAYOUT_BREAKPOINTS.desktopUltra) {
    return 'desktopUltra';
  }
  if (effective >= LAYOUT_BREAKPOINTS.desktopWide) {
    return 'desktopWide';
  }
  if (effective >= LAYOUT_BREAKPOINTS.desktop) {
    return 'desktop';
  }
  if (effective >= LAYOUT_BREAKPOINTS.wide) {
    return 'wide';
  }
  if (effective >= LAYOUT_BREAKPOINTS.tablet) {
    return 'tablet';
  }
  return 'compact';
}

/** True from the desktop tier upward - the tier at which a screen may
 * arrange primary and secondary content in parallel columns. */
export function isDesktopTier(tier: LayoutTier): boolean {
  return (
    tier === 'desktop' || tier === 'desktopWide' || tier === 'desktopUltra'
  );
}

/**
 * The envelope a screen should cap itself at for a given tier, or
 * `undefined` when it should not cap itself at all.
 *
 * `undefined` IS THE ANSWER, NOT A MISSING ONE. A desktop tool screen
 * already sits inside a box the shell sized to the viewport minus the
 * navigation rail (MainTabsScreen's `content` is `flex: 1`), and its own
 * container is `width: '100%'`. So the way to make a workspace fill the
 * monitor is to stop capping it: flex has already computed the right
 * number, and any constant put here would be somebody's monitor.
 *
 * MEASURED, which is why the old constants are gone rather than raised.
 * At a 2040 cap, Chromium reported the same figures on all eight tool
 * screens - identical because the cap, not the screen, was the owner:
 *
 *   1366 -> 1158 of 1158 usable  100%   (cap never reached)
 *   1920 -> 1712 of 1712 usable  100%   (cap never reached)
 *   2560 -> 2040 of 2352 usable   87%   156px dead down each side
 *   3440 -> 2040 of 3232 usable   63%   596px dead down each side
 *   3840 -> 2040 of 3632 usable   56%   796px dead down each side
 *
 * A previous pass here reasoned that a workspace running edge to edge on
 * a large monitor "puts its two ends a head-turn apart" and chose 2040 on
 * that basis. On a real 3440x1440 ultrawide the operator reported the
 * opposite complaint - an application sitting inside a page - so that
 * judgement is reversed deliberately, not lost.
 *
 * A screen that has NOT split into columns must keep passing `false`: it
 * gets the reading cap at every width, because a paragraph does have a
 * length past which it stops being readable. Full-width workspace is not
 * full-width prose, and PROSE_MEASURE above bounds the sentences inside
 * a workspace that no longer bounds itself.
 */
export function contentEnvelope(
  tier: LayoutTier,
  splitsIntoColumns: boolean,
): number | undefined {
  if (!splitsIntoColumns || !isDesktopTier(tier)) {
    return CONTENT_MAX_WIDTH;
  }
  return undefined;
}
