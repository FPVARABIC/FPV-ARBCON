/**
 * User-facing error codes MspClient's request() can reject with.
 *
 * Kept as a SEPARATE list from transportErrors.ts's KNOWN_ERROR_CODES
 * (architectural choice, not an oversight): that list's own doc comment
 * scopes it to "every error code the Kotlin transport module currently
 * rejects with" - these MSP codes never come from Kotlin, they are
 * synthesized entirely within mspClient.ts (a pure core/protocol module).
 * transportErrors.ts also lives under src/platforms/react-native/transport
 * - importing it from src/core would cross the core/platform layering
 * boundary this project's ARCHITECTURE.md establishes, even though the
 * specific import (i18next's TFunction type) isn't itself RN-only. A
 * dedicated, dependency-free list here keeps mspClient.ts's "zero
 * React/RN/Android dependency" guarantee intact.
 *
 * As with every other error code in this project: no Arabic text lives in
 * src/core: translations live only in src/i18n/locales/ar.json, under the
 * same flat `errors.*` namespace transportErrors.ts's codes already use.
 */
export const MSP_CLIENT_ERROR_CODES = [
  'MSP_TIMEOUT',
  'MSP_REMOTE_ERROR',
  'MSP_SESSION_CLOSED',
  'MSP_DEVICE_DETACHED',
  'MSP_WRITE_OUTCOME_UNKNOWN',
  'MSP_QUEUE_FULL',
  'MSP_TRANSPORT_QUEUE_FULL',
  'MSP_RECOVERY_REQUIRED',
  'MSP_ENCODE_FAILED',
] as const;

export type MspClientErrorCode = (typeof MSP_CLIENT_ERROR_CODES)[number];
