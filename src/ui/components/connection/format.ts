/**
 * Presentation-only hex formatting. Never mutates the underlying numeric
 * value used for native calls - callers must keep passing the original
 * vendorId/productId/deviceId to openDevice()/native code.
 */
export function formatHex(value: number, width = 4): string {
  return `0x${value.toString(16).toUpperCase().padStart(width, '0')}`;
}

/** Shortened form for normal-UI display; the full sessionId only appears in
 * the validation log/technical details. */
export function shortenSessionId(sessionId: string): string {
  return sessionId.length <= 8 ? sessionId : `${sessionId.slice(0, 8)}…`;
}
