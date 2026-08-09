/**
 * "COPY A CONNECTION REPORT" - the Android (native) side of the seam.
 *
 * The browser build resolves connectionReport.web.ts instead (same
 * extension seam as the USB transport and the map link). On Android this
 * capability deliberately does not exist: the platform already has adb
 * logcat and the in-app debug panels for evidence capture, the clipboard
 * flow here is designed around a browser user who cannot be asked to
 * open DevTools, and a second Android reporting path would be untested
 * surface. Everything is inert here: the screen asks `isSupported()`
 * first and renders nothing when it is false.
 */

export type ConnectionReportSnapshot = Readonly<
  Record<string, string | number | boolean>
>;

export function isConnectionReportSupported(): boolean {
  return false;
}

/** No-op on Android; the web sibling records staged evidence. */
export function recordConnectionStage(
  _stage: string,
  _detail?: Readonly<Record<string, string | number | boolean>>,
): void {}

/** Never called on Android (the button is not rendered); resolves false
 * defensively rather than pretending a copy happened. */
export async function copyConnectionReportToClipboard(
  _snapshot?: ConnectionReportSnapshot,
): Promise<boolean> {
  return false;
}
