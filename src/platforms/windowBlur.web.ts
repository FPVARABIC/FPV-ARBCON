/**
 * "THE APPLICATION WINDOW LOST FOCUS" - the browser implementation.
 *
 * WHY THIS SEAM EXISTS AT ALL. react-native-web's `AppState` subscribes
 * ONLY to `visibilitychange` (see AppState/index.js). Switching to
 * another application while this page remains VISIBLE therefore raises no
 * AppState change, so `motorTestLifecycleBridge` - which is driven by
 * AppState and by the navigation blur source - never hears about it. A
 * Chromium probe of that exact case came back inconclusive: headless
 * cannot produce a trustworthy OS-level window switch with a mouse button
 * held down. An unproven incidental behaviour is not something a live
 * motor command may rest on, so the browser gets an explicit signal
 * instead of an assumed one.
 *
 * `blur` on `window` rather than `document`: focus moving to a control
 * INSIDE the page bubbles a document-level blur, which would tear down a
 * legitimate in-page gesture. The window-level event fires when the whole
 * window loses focus, which is the condition being guarded.
 *
 * This module has no motor authority and cannot acquire any. It reports
 * one browser fact and returns an unsubscribe.
 */

/**
 * Subscribes to the window losing focus. Returns an unsubscribe function.
 *
 * Guarded for a non-browser global (jsdom without a window, SSR-style
 * evaluation) so a caller may subscribe unconditionally.
 */
export function subscribeWindowBlur(listener: () => void): () => void {
  if (
    typeof window === 'undefined' ||
    typeof window.addEventListener !== 'function'
  ) {
    return () => {};
  }
  window.addEventListener('blur', listener);
  return () => {
    window.removeEventListener('blur', listener);
  };
}
