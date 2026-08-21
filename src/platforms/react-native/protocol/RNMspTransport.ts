/**
 * Concrete React Native MspTransport adapter (Pass 6.3), wrapping the
 * Pass 5.x UsbSerialTransportClient at the boundary MspTransport's own
 * doc comment (src/core/protocol/mspTransport.ts) always anticipated.
 * Pure glue: Base64 encode/decode, session-id filtering, and the
 * stopReading() -> startReading() sequencing restartReceiveLoop()
 * requires - no MSP command constants, no payload decoding, no UI. That
 * is Pass 6.4+.
 *
 * One instance is scoped to exactly one already-open session for its
 * entire lifetime, exactly as MspTransport's own contract requires - the
 * sessionId is fixed at construction and never changes.
 *
 * KNOWN, DOCUMENTED, ACCEPTED TIMING GAP (Pass 6.3 Step 0.4 investigation):
 * a physical detach can cause startReading() (called from
 * restartReceiveLoop() below) to reject with UNKNOWN_SESSION before the
 * underlying client's onSessionDetached event for that same detach has
 * been delivered - UsbSerialTransportModule.handleDeviceDetached()
 * removes the session from its native registries BEFORE emitting
 * onSessionDetached, so a startReading() call racing that same detach can
 * observe the removal first. This is self-correcting, not silent data
 * loss: the detach event has already been queued for delivery by the
 * native side by the time this race is even possible, and once it
 * arrives, MspClient's own physical-detach-always-wins handling (Pass
 * 6.2b, unconditional regardless of prior state) corrects the client to
 * DISCONNECTED regardless of whatever state a racing restartReceiveLoop()
 * rejection put it in first. The only real exposure is a narrow, self-
 * healing window where getState()/a rejected request's error code briefly
 * reads RECOVERY_FAILED/MSP_RECOVERY_REQUIRED instead of
 * DISCONNECTED/MSP_DEVICE_DETACHED. Accepted as documented rather than
 * engineered around, per explicit review - see that review's own findings
 * for the two fix options considered and why neither was taken up here.
 */

import type {
  MspTransport,
  MspTransportError,
  MspTransportSessionDetachedEvent,
  MspTransportUnsubscribe,
} from '../../../core';
import type {
  TransportError,
  UsbSerialDataEvent,
  UsbSerialSessionDetachedEvent,
  UsbSerialTransportClient,
} from '../transport';
import { base64ToBytes, bytesToBase64 } from './base64';

/**
 * Re-wraps UsbSerialTransportClient's TransportError ({code,
 * nativeMessage}) into MspTransport's own MspTransportError shape ({code,
 * message}) - `code` is passed through byte-for-byte unchanged and never
 * inspected/reclassified here; only the field NAME carrying the
 * human-readable text is corrected, so the rejection genuinely satisfies
 * MspTransportError's documented shape instead of silently carrying a
 * `nativeMessage` field MspClient's own type never declared. Applied at
 * every rejection point sourced from normalizeNativeError(): writeBytes(),
 * and restartReceiveLoop()'s propagation of a stopReading()/startReading()
 * rejection.
 */
function toMspTransportError(reason: unknown): MspTransportError {
  const source = reason as Partial<TransportError> | undefined;
  return {
    code: source?.code ?? 'UNKNOWN_ERROR',
    message: source?.nativeMessage ?? 'Unknown transport error.',
  };
}

/** SESSION_CLOSED is reused deliberately (not a new code): classifyWriteFailure()
 * in mspClient.ts already maps it to MSP_SESSION_CLOSED, the accurate
 * classification for "this transport is gone" - avoiding a spurious
 * desync-latch trigger (MSP_WRITE_OUTCOME_UNKNOWN's default) for what is
 * fundamentally a closed condition, not an unknown-outcome one. In normal
 * operation this is unreachable: the session coordinator (Step 2) always
 * disposes the owning MspClient before this transport, so MspClient's own
 * checkAcceptance() rejects new work before ever reaching this transport
 * again - this exists purely as the defensive guard Step 1.6 requires. */
function disposedError(): MspTransportError {
  return {
    code: 'SESSION_CLOSED',
    message: 'This RNMspTransport instance has been disposed.',
  };
}

export class RNMspTransport implements MspTransport {
  private readonly dataListeners = new Set<(bytes: Uint8Array) => void>();
  private readonly sessionDetachedListeners = new Set<
    (event: MspTransportSessionDetachedEvent) => void
  >();
  private readonly unsubscribeRealData: () => void;
  private readonly unsubscribeRealSessionDetached: () => void;
  private disposed = false;
  /**
   * A CLI exchange uses the same already-open serial session, but its
   * printable response is not MSP and must never reach MspClient's stream
   * parser.  This single listener is installed only after the coordinator
   * has paused telemetry and reserved the idle client.  While present it
   * receives every byte for this session and the ordinary MSP listeners
   * receive none.
   */
  private rawModeListener: ((bytes: Uint8Array) => void) | undefined;

  constructor(
    private readonly client: UsbSerialTransportClient,
    private readonly sessionId: string,
  ) {
    // Subscribed eagerly, here, exactly once, for this instance's entire
    // lifetime - not lazily on first listener registration. Chosen for a
    // single, simple invariant ("the real subscription's lifetime is
    // exactly this adapter instance's lifetime, full stop") over lazy
    // init's extra "is this the first listener" branching; constructing an
    // RNMspTransport is already tightly coupled to a just-opened real
    // session (Step 2), so the eager subscription costs nothing extra in
    // practice - by the time this constructor returns, the owning
    // MspClient's own constructor is about to subscribe anyway.
    //
    // This is the ONE real subscription for this instance's whole life.
    // An individual listener's own unsubscribe function (returned from
    // onDataReceived()/onSessionDetached() below) ONLY ever removes that
    // one listener from the Sets above - it must NEVER touch this real
    // subscription, even if removing it empties a Set to zero. MspClient
    // and the debug panel's read-only monitor (Step 3) share this one real
    // subscription without competing: one unsubscribing (e.g. the debug
    // panel unmounting) must never disturb the other's still-live
    // delivery. Only dispose() itself may tear this down.
    this.unsubscribeRealData = client.onDataReceived(event => {
      this.handleRealData(event);
    });
    this.unsubscribeRealSessionDetached = client.onSessionDetached(event => {
      this.handleRealSessionDetached(event);
    });
  }

  private handleRealData(event: UsbSerialDataEvent): void {
    // Filtered BEFORE any decoding is attempted - never decode bytes
    // belonging to a different session (Step 0.2's real, unfiltered event
    // shape: every open session's bytes arrive on this same callback).
    if (event.sessionId !== this.sessionId) {
      return;
    }
    // Decoded synchronously, inline, in the real client's own callback -
    // no async step that could let a later event overtake an earlier one
    // still mid-decode. Fan-out below preserves the exact delivery order
    // the underlying client used, since it is itself synchronous.
    const bytes = base64ToBytes(event.dataBase64);
    if (this.rawModeListener !== undefined) {
      try {
        this.rawModeListener(bytes);
      } catch {
        // The native receive callback must never be broken by UI code.
      }
      return;
    }
    // Snapshot into a plain array BEFORE iterating: a listener that
    // synchronously mutates dataListeners mid-dispatch (e.g. one that
    // calls dispose(), which clears this Set - exactly
    // MspSessionCoordinator's own onSessionDetached -> disposeSession() ->
    // transport.dispose() pattern) must never cause a listener registered
    // before this fan-out began to be silently skipped. Standard
    // event-emitter safety pattern: every listener present at the moment
    // dispatch started is invoked exactly once, regardless of what any of
    // them does mid-dispatch.
    for (const listener of Array.from(this.dataListeners)) {
      try {
        listener(bytes);
      } catch {
        // Best-effort, matching mspClient.ts's emitDiagnostic() precedent:
        // a caller-supplied listener is external code this file does not
        // control. One listener throwing must never prevent another
        // registered listener from running, and - critically here - must
        // never escape this method at all: this is called directly as the
        // real UsbSerialTransportClient's own onDataReceived callback, so
        // an uncaught throw would propagate into that client's own event
        // dispatch, potentially disrupting delivery to its other,
        // unrelated listeners, not just this adapter's own fan-out.
      }
    }
  }

  private handleRealSessionDetached(
    event: UsbSerialSessionDetachedEvent,
  ): void {
    if (event.sessionId !== this.sessionId) {
      return;
    }
    const mspEvent: MspTransportSessionDetachedEvent = {
      sessionId: this.sessionId,
    };
    // Snapshot BEFORE iterating - same reasoning as handleRealData() above.
    // Concretely real, not theoretical: MspSessionCoordinator.openSession()
    // registers an onSessionDetached listener that synchronously calls
    // disposeSession() -> transport.dispose() ->
    // sessionDetachedListeners.clear() from INSIDE this very fan-out - any
    // listener registered after it (e.g. a future third consumer) would be
    // silently dropped from the live Set before this loop ever reached it.
    for (const listener of Array.from(this.sessionDetachedListeners)) {
      try {
        listener(mspEvent);
      } catch {
        // Best-effort - see handleRealData()'s identical comment above;
        // same reasoning, same real-client-callback escape risk.
      }
    }
  }

  async writeBytes(payload: Uint8Array): Promise<void> {
    if (this.disposed) {
      throw disposedError();
    }
    try {
      await this.client.writeBytes(this.sessionId, bytesToBase64(payload));
    } catch (reason) {
      throw toMspTransportError(reason);
    }
  }

  /**
   * Diverts this transport's receive stream to one exclusive raw consumer.
   * Ownership and quiescence are deliberately NOT inferred here; the CLI
   * controller must establish them before calling this low-level seam.
   */
  enterRawMode(listener: (bytes: Uint8Array) => void): () => void {
    if (this.disposed) {
      throw disposedError();
    }
    if (this.rawModeListener !== undefined) {
      throw new Error('RNMspTransport raw mode is already active.');
    }
    this.rawModeListener = listener;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.rawModeListener === listener) {
        this.rawModeListener = undefined;
      }
    };
  }

  /** Raw writes share the exact native session and ordering as MSP writes. */
  async writeRawBytes(payload: Uint8Array): Promise<void> {
    await this.writeBytes(payload);
  }

  async saveTextFile(filename: string, text: string): Promise<boolean> {
    if (this.disposed) throw disposedError();
    return this.client.saveFirmwareFile(
      filename,
      'text/plain',
      bytesToBase64(
        Uint8Array.from(text, character => character.charCodeAt(0) % 256),
      ),
    );
  }

  onDataReceived(
    listener: (bytes: Uint8Array) => void,
  ): MspTransportUnsubscribe {
    this.dataListeners.add(listener);
    return () => {
      this.dataListeners.delete(listener);
    };
  }

  onSessionDetached(
    listener: (event: MspTransportSessionDetachedEvent) => void,
  ): MspTransportUnsubscribe {
    this.sessionDetachedListeners.add(listener);
    return () => {
      this.sessionDetachedListeners.delete(listener);
    };
  }

  /**
   * client.stopReading() THEN, only once it resolves, client.startReading()
   * - strictly sequential, never parallel, no retry, never
   * closeSession()/openDevice(). If stopReading() rejects, startReading()
   * is never called - this Promise rejects with stopReading()'s own
   * reason (re-wrapped per toMspTransportError() above), unchanged
   * otherwise. Resolves only once startReading() itself genuinely
   * resolves.
   */
  async restartReceiveLoop(): Promise<void> {
    if (this.disposed) {
      throw disposedError();
    }
    try {
      await this.client.stopReading(this.sessionId);
    } catch (reason) {
      throw toMspTransportError(reason);
    }
    try {
      await this.client.startReading(this.sessionId);
    } catch (reason) {
      throw toMspTransportError(reason);
    }
  }

  /**
   * HANDS THE PHYSICAL PORT BACK. Fire-and-forget, best effort.
   *
   * A serial port admits one owner. Every other teardown path in this
   * application has somebody to close it: the graceful disconnect closes
   * it from the screen (setupSessionHost.tsx - closeSession THEN
   * deactivateMspSession), and a real unplug has a device that is
   * physically gone. The LIVENESS VERDICT has neither - the coordinator
   * decides on its own that a silent board is dead, against a device that
   * is still enumerated and a transport that was never told anything.
   *
   * Without this the port stayed open forever, held by a session no layer
   * still knew about: the coordinator had deleted its entry, so even
   * releaseApplicationOwnedSessions() could not find it, and the next
   * connect was refused DEVICE_ALREADY_IN_USE with the operator told that
   * another application had their board.
   *
   * DELIBERATELY NOT GATED ON `disposed`. This is a release, not a use;
   * the coordinator calls it after teardown has already dropped every
   * listener, which is exactly what makes re-entry impossible.
   * `stopReading` before `closeSession` is the proven order (the same one
   * exclusiveDeviceAccess.ts uses), and both are allowed to fail: a
   * session the transport has already forgotten rejects here and is not a
   * problem - closeSession is idempotent on both platforms.
   */
  releaseSerialSession(): void {
    Promise.resolve()
      .then(() => this.client.stopReading(this.sessionId))
      .catch(() => undefined)
      .then(() => this.client.closeSession(this.sessionId))
      .catch(() => undefined);
  }

  /**
   * Idempotent. Unsubscribes from the real client's underlying
   * subscriptions (best-effort - swallows an unsubscribe function itself
   * throwing, matching mspClient.ts's dispose() precedent), clears every
   * internally-registered listener, and makes writeBytes()/
   * restartReceiveLoop() reject immediately afterward instead of reaching
   * the real client - not merely a no-op on the listener side.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    try {
      this.unsubscribeRealData();
    } catch {
      // Swallowed intentionally - external unsubscribe function, same
      // "swallow and continue" pattern as mspClient.ts's dispose().
    }
    try {
      this.unsubscribeRealSessionDetached();
    } catch {
      // Swallowed intentionally - see above.
    }

    this.dataListeners.clear();
    this.sessionDetachedListeners.clear();
    this.rawModeListener = undefined;
  }
}
