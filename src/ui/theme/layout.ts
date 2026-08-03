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
} as const;

export type LayoutTier = 'compact' | 'tablet' | 'wide' | 'desktop' | 'desktopWide';

/** The reading-column envelope. Unchanged, and deliberately so. */
export const CONTENT_MAX_WIDTH = 1180;

/** The envelope for a screen that has actually split into columns. */
export const WORKSPACE_MAX_WIDTH = 1600;

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
  return tier === 'desktop' || tier === 'desktopWide';
}

/**
 * The envelope a screen should cap itself at for a given tier. A screen
 * that has NOT split into columns must keep passing `false` so its
 * paragraphs stay readable no matter how wide the window is.
 */
export function contentEnvelope(tier: LayoutTier, splitsIntoColumns: boolean): number {
  return splitsIntoColumns && isDesktopTier(tier)
    ? WORKSPACE_MAX_WIDTH
    : CONTENT_MAX_WIDTH;
}
