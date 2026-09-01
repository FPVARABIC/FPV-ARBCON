/**
 * Is the layout laid out right-to-left RIGHT NOW? — the BROWSER answer.
 *
 * WHY THIS FILE EXISTS, measured rather than assumed: react-native-web's
 * I18nManager is a no-op stub. Reading its source
 * (node_modules/react-native-web/dist/exports/I18nManager/index.js),
 * `allowRTL()` and `forceRTL()` have empty bodies and there is no `isRTL`
 * property at all — only `getConstants().isRTL`, hard-coded to false. So
 * the `I18nManager.forceRTL(true)` call in App.web.tsx changes NOTHING,
 * and every `I18nManager.isRTL` read in shared code silently evaluated to
 * `undefined` in the browser.
 *
 * That was not a theoretical problem: the Start screen's two call-to-action
 * buttons drew a RIGHT-pointing "continue" chevron in an Arabic,
 * right-to-left interface, because the icon layer asked I18nManager which
 * way the layout ran and was told "left-to-right".
 *
 * THE DOCUMENT IS THE AUTHORITY HERE. index.html ships `dir="rtl"` on
 * <html> itself, before any JavaScript runs, and that attribute is what
 * actually drives the browser's layout of every flex row, inset and text
 * run. Asking the document therefore matches what the user is looking at,
 * and keeps working if a future locale flips the attribute.
 */
export function isRtlLayout(): boolean {
  if (typeof document === 'undefined') {
    // Server-side or a non-DOM host: fall back to the product's
    // Arabic-first default rather than silently claiming LTR.
    return true;
  }
  const dir =
    document.documentElement.getAttribute('dir') ??
    document.body?.getAttribute('dir');
  if (dir !== null && dir !== undefined) {
    return dir.toLowerCase() === 'rtl';
  }
  // No explicit attribute: trust the computed style, then the default.
  const computed = window.getComputedStyle(document.documentElement).direction;
  return computed ? computed === 'rtl' : true;
}
