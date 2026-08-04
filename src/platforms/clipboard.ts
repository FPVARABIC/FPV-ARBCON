/**
 * "Copy this text" - the Android (native) side of the seam.
 *
 * The browser build resolves clipboard.web.ts. Inert here for the same
 * reason the connection and telemetry reports are: the clipboard flow
 * exists for a browser operator who cannot be asked to open DevTools,
 * and Android already has adb logcat and the in-app debug panels.
 * Resolves false rather than pretending a copy happened.
 */
export async function copyPlainTextToClipboard(_text: string): Promise<boolean> {
  return false;
}
