/**
 * "THE APPLICATION WINDOW LOST FOCUS" - the Android (native) side of the
 * seam.
 *
 * The browser build resolves windowBlur.web.ts instead, through the same
 * file-extension seam the USB transport, the map link and the clipboard
 * already use. Inert here, and deliberately so: Android has no window to
 * blur. Its equivalent transitions - the app going to background, a
 * navigation blur, a tab departure - are already owned by
 * `motorTestLifecycleBridge`, which listens to `AppState` and to the
 * shell's blur source and raises a stop obligation from there.
 *
 * Adding a second Android path to the same event would mean two
 * independent stop requesters for one transition, which is exactly the
 * duplication the bridge exists to prevent.
 *
 * Resolves to a no-op unsubscribe rather than throwing: a caller that
 * subscribes on every platform must be able to clean up on every
 * platform.
 */

/**
 * Subscribes to the window losing focus. Returns an unsubscribe function.
 *
 * The listener must be treated as a FAIL-SAFE signal only. It says the
 * operator's attention left the window; it says nothing about what a
 * motor is doing, and it must never be used to start anything.
 */
export function subscribeWindowBlur(_listener: () => void): () => void {
  return () => {};
}
