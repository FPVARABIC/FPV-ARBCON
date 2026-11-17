/** Read the document direction; Dutch defaults to LTR, including SSR. */
export function isRtlLayout(): boolean {
  if (typeof document === 'undefined') {
    // Server-side or a non-DOM host: fall back to the product's
    // Dutch LTR default.
    return false;
  }
  const dir =
    document.documentElement.getAttribute('dir') ??
    document.body?.getAttribute('dir');
  if (dir !== null && dir !== undefined) {
    return dir.toLowerCase() === 'rtl';
  }
  // No explicit attribute: trust the computed style, then the default.
  const computed = window.getComputedStyle(document.documentElement).direction;
  return computed ? computed === 'rtl' : false;
}
