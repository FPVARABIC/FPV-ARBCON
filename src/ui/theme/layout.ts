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
 * WHY TWO ENVELOPES RATHER THAN ONE BIGGER NUMBER. Raising the single
 * content cap would make paragraphs span a metre of screen - unreadable,
 * and explicitly not what the desktop complaint was about. So:
 *
 *   CONTENT_MAX_WIDTH  (1180) bounds a READING column and is unchanged.
 *   WORKSPACE_MAX_WIDTH (1600) bounds a screen that has actually split
 *                              into columns, where the extra width buys
 *                              parallel information rather than longer
 *                              lines.
 *
 * A screen may only use the wider envelope in a tier where it genuinely
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

/** The envelope for a screen that has actually split into columns. */
export const WORKSPACE_MAX_WIDTH = 1600;

/**
 * The same envelope on a genuinely large monitor.
 *
 * NOT A SCALING FACTOR, and the distinction is the whole point: nothing
 * about type, controls, icons or touch targets changes with this. It
 * only lets a layout that ALREADY arranges content in parallel columns
 * use the room those columns have, instead of stopping at a number
 * chosen for a 1920 window and leaving 400px of ground down each side.
 *
 * It is not 100% of the viewport either, deliberately. A workspace that
 * runs edge to edge on a 2560 monitor puts its two ends a head-turn
 * apart, and the reading cap below still bounds every paragraph inside
 * it - so widening here buys parallel information, never longer lines.
 */
export const WORKSPACE_ULTRA_MAX_WIDTH = 2040;

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
 * The envelope a screen should cap itself at for a given tier. A screen
 * that has NOT split into columns must keep passing `false` so its
 * paragraphs stay readable no matter how wide the window is.
 */
export function contentEnvelope(tier: LayoutTier, splitsIntoColumns: boolean): number {
  if (!splitsIntoColumns || !isDesktopTier(tier)) {
    return CONTENT_MAX_WIDTH;
  }
  return tier === 'desktopUltra'
    ? WORKSPACE_ULTRA_MAX_WIDTH
    : WORKSPACE_MAX_WIDTH;
}
