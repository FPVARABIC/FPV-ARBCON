import type {TFunction} from 'i18next';

/**
 * Every error code the Kotlin transport module currently rejects with
 * (UsbSerialTransportModule.kt / SerialConfigurationMapper.kt). Kept as a
 * plain string union (not imported from Kotlin) since there is no shared
 * source of truth across the JS/Kotlin boundary - this list must be updated
 * by hand if the native side ever adds a new code.
 */
export const KNOWN_ERROR_CODES = [
  'DEVICE_ENUMERATION_FAILED',
  'UNSUPPORTED_DEVICE',
  'INVALID_PORT_INDEX',
  'DEVICE_ALREADY_IN_USE',
  'PERMISSION_REQUEST_FAILED',
  'PERMISSION_DENIED',
  'DEVICE_CHANGED_DURING_OPEN',
  'OPEN_FAILED',
  'INVALID_CONFIGURATION',
  'UNSUPPORTED_SERIAL_CONFIGURATION',
  'UNKNOWN_SESSION',
  'CLOSE_FAILED',
  'NATIVE_OPERATION_FAILED',
  'NOT_IMPLEMENTED',
  'MODULE_INVALIDATED',
  'RX_ALREADY_ACTIVE',
  'READ_FAILED',
] as const;

export type KnownTransportErrorCode = (typeof KNOWN_ERROR_CODES)[number];

/**
 * Stable, sanitized shape the UI is allowed to see. Deliberately has no room
 * for a stack trace, a Java/Kotlin class name, or any other native-internal
 * field - normalizeNativeError() only ever copies `code` and `message` off
 * the raw rejection, so there is nothing else to leak even if the native
 * side attaches extra properties (e.g. nativeStackAndroid).
 */
export interface TransportError {
  code: string;
  nativeMessage: string;
}

function extractNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * React Native's TurboModule bridge turns a Promise.reject(code, message,
 * userInfo) call into a real JS Error whose own properties include `code`
 * and `userInfo`, copied verbatim from the native errorInfo map (see
 * createRejectionError in JavaTurboModule.cpp - verified against the
 * installed react-native source, not assumed). This function reads only the
 * two fields the UI is allowed to use and ignores everything else on the
 * rejection value, including any stack trace fields.
 */
export function normalizeNativeError(reason: unknown): TransportError {
  const source =
    reason && typeof reason === 'object' ? (reason as Record<string, unknown>) : {};
  const code = extractNonEmptyString(source.code) ?? 'UNKNOWN_ERROR';
  const nativeMessage =
    extractNonEmptyString(source.message) ??
    (typeof reason === 'string' ? reason : 'Unknown native error.');
  return {code, nativeMessage};
}

function isKnownErrorCode(code: string): code is KnownTransportErrorCode {
  return (KNOWN_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * Maps a normalized TransportError to the Arabic message to show the user.
 * Every known code has a dedicated ar.json key under `errors.*`; anything
 * else (including the client's own defensive UNKNOWN_ERROR code) falls back
 * to `errors.UNKNOWN`.
 */
export function localizeTransportError(t: TFunction, error: TransportError): string {
  const key = isKnownErrorCode(error.code) ? `errors.${error.code}` : 'errors.UNKNOWN';
  return t(key);
}
