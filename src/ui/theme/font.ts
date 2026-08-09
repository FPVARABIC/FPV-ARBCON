import {Platform} from 'react-native';
import type {TextStyle} from 'react-native';

/**
 * Cairo — the single Arabic UI typeface, answered by BOTH platforms under
 * the same name so shared styles never fork:
 *
 *   WEB      src/web/cairo.css declares `font-family: 'Cairo'` as a
 *            variable font (wght 400–800), so the browser resolves any
 *            fontWeight the type scale asks for. The stack below keeps
 *            honest Arabic fallbacks for the instant before the woff2
 *            arrives (font-display: swap).
 *
 *   ANDROID  android/app/src/main/res/font/cairo.xml maps weights
 *            400/500/600/700 to static Cairo instances, registered as the
 *            family "Cairo" via ReactFontManager in MainApplication.kt.
 *            On API 28+ `fontWeight: '600'` selects the real SemiBold
 *            face; on API 24–27 Android's older Typeface API can only
 *            distinguish regular/bold, so 500/600 render as Regular there
 *            — a documented platform floor, not a styling bug.
 *
 * A bare fontFamily on native must be a SINGLE family name (no CSS-style
 * fallback list), which is why the stack only exists on web.
 */
const CAIRO_WEB_STACK =
  "'Cairo', 'Segoe UI', 'Noto Sans Arabic', 'Noto Naskh Arabic', Tahoma, sans-serif";

/**
 * The terminal/code stack. The CLI surface and raw technical values stay
 * monospace BY REQUIREMENT — Cairo must never reach terminal output.
 * react-native-web maps the literal 'monospace' to a spartan default, so
 * web spells out a modern stack; Android's 'monospace' is Roboto Mono.
 */
const MONO_WEB_STACK =
  "ui-monospace, 'Cascadia Mono', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

export const fonts = {
  family: Platform.OS === 'web' ? CAIRO_WEB_STACK : 'Cairo',
  mono: Platform.OS === 'web' ? MONO_WEB_STACK : 'monospace',
} as const;

/** The weights the product uses. 400/500 for reading text, 500/600 for
 * labels and controls, 600/700 for headings. Nothing thinner than 400 —
 * thin Arabic at UI sizes is unreadable — and nothing above 700. */
export type CairoWeight = '400' | '500' | '600' | '700';

/**
 * The one correct way to put Cairo on a text style outside the shared
 * typography tokens: `...cairo('600')`. Pairs family and weight so a
 * style can never name a weight the platforms don't ship.
 */
export function cairo(weight: CairoWeight): TextStyle {
  return {fontFamily: fonts.family, fontWeight: weight};
}
