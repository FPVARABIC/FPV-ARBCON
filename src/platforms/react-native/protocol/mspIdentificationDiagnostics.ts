/**
 * TEMPORARY DIAGNOSTIC SCAFFOLDING - added to investigate a real-hardware
 * finding (identify() settling FAILED despite a confirmed valid, compatible
 * MSP_API_VERSION response actually being received). NOT a permanent
 * feature - delete this file, its one export, and both call sites
 * (MspSessionCoordinator.ts's finish() console line, UsbSerialDebugPanel.tsx's
 * error-detail Text element) once the root cause is confirmed and no longer
 * needs this visibility.
 *
 * ONE shared implementation, used by both diagnostic call sites, so the
 * console log and the in-app display can never format the same error
 * differently:
 *  - An MspClientError-shaped value (has both `code` and `message`, e.g.
 *    MspClientError itself - MSP_TIMEOUT, MSP_REMOTE_ERROR, etc.) is
 *    formatted as `${code}: ${message}` - the code is the more actionable
 *    signal for this project's own typed MSP errors.
 *  - Any other real Error instance (e.g. MspPayloadReadError,
 *    MspIncompatibleFirmwareError, or a plain Error) is formatted as
 *    `${name}: ${message}`.
 *  - Anything else (a thrown non-Error value) falls back to String(error).
 */
export function describeMspIdentificationError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && 'message' in error) {
    const code = (error as {code: unknown}).code;
    const message = (error as {message: unknown}).message;
    if (typeof code === 'string' && typeof message === 'string') {
      return `${code}: ${message}`;
    }
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}
