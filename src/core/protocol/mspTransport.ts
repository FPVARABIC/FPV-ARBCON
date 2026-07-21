/**
 * Abstract, transport-agnostic contract MspClient depends on.
 *
 * This is the INTERFACE ONLY. The concrete React Native adapter that
 * implements this at the native-bridge boundary (wrapping
 * UsbSerialTransportClient, per src/platforms/react-native/transport) is a
 * LATER TASK, not part of this slice - deliberately so mspClient.ts (and
 * this file) can have zero React/RN/Android dependency, matching every
 * other file in src/core/protocol.
 *
 * Carries raw Uint8Array payloads, not Base64 strings - Base64 encode/decode
 * is strictly the concrete React Native adapter's own concern (converting
 * to/from the lower Pass 5.3 UsbSerialTransportClient.writeBytes(sessionId,
 * dataBase64) signature it wraps), not this slice's. This is a distinct,
 * higher layer than that client.
 *
 * writeBytes() and onDataReceived() carry no sessionId: an MspTransport is
 * scoped to exactly one already-open physical session for its entire
 * lifetime (mirroring MspClient's own one-session-per-instance lifetime) -
 * disambiguating between sessions is the future concrete adapter's own
 * internal concern (e.g. constructing one MspTransport per open session),
 * not something this interface's callers need to do.
 */

/** Rejection shape for writeBytes(). Mirrors TransportError's {code,
 * message} shape at the native-bridge boundary (see transportErrors.ts's
 * TransportError), without importing that RN-layer type into src/core.
 * MspClient treats the caught reason as `unknown` and reads `code`
 * defensively rather than depending on this type at runtime. */
export interface MspTransportError {
  code: string;
  message: string;
}

/** The session's owning device was physically detached - the one event this
 * slice treats as a hard override of any latched MSP-level state. Mirrors
 * UsbSerialTransportClient.onSessionDetached: fires only when the detached
 * device owned an open session, never for an unrelated device. Retains a
 * sessionId field (unlike writeBytes/onDataReceived above) - unchanged by
 * this pass's session-scoping cleanup, per explicit instruction. */
export interface MspTransportSessionDetachedEvent {
  sessionId: string;
}

export type MspTransportUnsubscribe = () => void;

export interface MspTransport {
  /**
   * Writes raw bytes to this transport's one already-open session. Resolves
   * only once the underlying transport reports the write itself actually
   * completed - never merely once it was queued. Rejects with an
   * MspTransportError-shaped value on failure.
   */
  writeBytes(payload: Uint8Array): Promise<void>;

  /** Subscribes to this transport's one session's received bytes, delivered
   * directly (no wrapping event object - there is nothing to disambiguate).
   * Returns an unsubscribe function. */
  onDataReceived(listener: (bytes: Uint8Array) => void): MspTransportUnsubscribe;

  /** Subscribes to physical detach of the open session's owning device.
   * Returns an unsubscribe function. */
  onSessionDetached(
    callback: (event: MspTransportSessionDetachedEvent) => void,
  ): MspTransportUnsubscribe;

  /**
   * Pass 6.2b: a single, combined receive-loop recovery operation - stops
   * the current RX loop, then starts it again. Deliberately ONE method
   * rather than two separate stop/start calls: MspClient's recovery
   * orchestration (mspClient.ts) calls this exactly once and never
   * sequences stop/start itself - the ordering guarantee (stop fully
   * completes before start begins) is this transport's own responsibility.
   *
   * The concrete React Native adapter (a later task, wrapping
   * UsbSerialTransportClient.stopReading()/startReading() -
   * src/platforms/react-native/transport) is expected to implement this by
   * calling stopReading() (the underlying native module resolves that
   * immediately and synchronously - see
   * UsbSerialTransportModule.stopReading()) followed by startReading()
   * (bounded to at most one RX_RESTART_WAIT_MILLIS wait for the previous
   * attempt's worker thread to confirm its exit, with its own top-level
   * exception-safety net guaranteeing the call always settles - see
   * UsbSerialTransportModule.performStartReading()'s Pass 5.7 note).
   * MspClient relies on that already-verified bound and deliberately adds
   * no client-side timeout of its own for this call - see mspClient.ts's
   * Pass 6.2b recovery orchestration doc comment for the full reasoning.
   *
   * Resolves once the receive loop is running again; rejects (the reason
   * is not inspected further by MspClient - any rejection here is treated
   * identically) if either half of the restart failed.
   */
  restartReceiveLoop(): Promise<void>;
}
