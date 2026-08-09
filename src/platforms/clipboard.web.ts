/**
 * "Copy this text" - the browser implementation.
 *
 * Same two-step strategy connectionDiagnostics.ts uses, for the same
 * reason: navigator.clipboard is absent or rejected in enough real
 * situations that a silent failure would be worse than a legacy
 * fallback.
 */
export async function copyPlainTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }
  try {
    if (typeof document === 'undefined') {
      return false;
    }
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  } catch {
    return false;
  }
}
