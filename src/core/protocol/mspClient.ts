/**
 * MSP request/response engine with a "detect and latch" desynchronization
 * response - Pass 6.2a.
 *
 * This slice has NO recovery mechanism. On a write-outcome-unknown failure
 * or a response timeout, the client latches into DESYNCHRONIZED and stays
 * there for the rest of this instance's life - no stopReading/startReading,
 * no probing, no automatic path back to READY. Recovery is Pass 6.2b, built
 * on top of this once this slice is reviewed and approved.
 *
 * Zero React/RN/Android dependency, same as every other file in
 * src/core/protocol - depends only on mspEncoder/mspStreamParser and the
 * MspTransport interface (mspTransport.ts), never on a concrete adapter.
 * MspTransport carries raw Uint8Array, so no Base64 step exists anywhere in
 * this file - that conversion is strictly the future concrete adapter's own
 * concern, wrapping the lower Pass 5.3 UsbSerialTransportClient boundary.
 */

import { encode } from './mspEncoder';
import type { MspClientErrorCode } from './mspClientErrorCodes';
import { createMspStreamParser } from './mspStreamParser';
import type { MspDiagnostic, MspFrame, MspProtocolVersion, MspWireFormat } from './mspTypes';
import type { MspTransport, MspTransportSessionDetachedEvent } from './mspTransport';

/**
 * Bound on FIFO-queued (not-yet-started) requests. Does not count the one
 * currently active request. Justification: a realistic burst is a settings
 * screen firing every MSP_* GET it needs at mount time (on the order of
 * 10-20 requests for a typical Betaflight-style configurator sync); 32
 * comfortably covers that with headroom while still failing fast rather
 * than growing unbounded if a caller has a bug issuing requests in a tight
 * loop - worst case (every queued request eventually times out at 2000ms
 * each, one at a time) is bounded at roughly 32 * 2000ms, not unbounded.
 */
export const MSP_CLIENT_MAX_PENDING_REQUESTS_DEFAULT = 32;

/**
 * Phase 2 (AWAITING_RESPONSE) timeout, milliseconds. Starts only once the
 * transport's write Promise itself resolves (see the two-phase timeout
 * doc on MspClient.request below). ~10 RX read cycles of headroom after
 * write settles, per the existing Pass 6.2a architecture review.
 */
export const MSP_RESPONSE_TIMEOUT_MILLIS = 2000;

export type MspClientState = 'READY' | 'DESYNCHRONIZED' | 'RECOVERY_FAILED' | 'DISCONNECTED' | 'CLOSING';

/**
 * Independent of MspClientState. Only meaningful while state === 'READY'
 * and a request is actually in flight.
 */
export type MspRequestPhase = 'WRITING' | 'AWAITING_RESPONSE';

export interface MspRequestOptions {
  /** Required, never inferred or defaulted - mirrors mspEncoder.encode()'s
   * own standing "explicit wireFormat, no silent default" decision, which
   * this file must not silently relax just because it wasn't spelled out
   * in this slice's abbreviated request() signature sketch. */
  wireFormat: MspWireFormat;
  /** MSP v2 flags byte; forwarded to encode() as-is (including its own
   * validation, e.g. rejecting a nonzero value for wireFormat 'v1'). */
  flags?: number;
  /** Overrides MSP_RESPONSE_TIMEOUT_MILLIS for this request only. */
  responseTimeoutMs?: number;
}

export interface MspClientOptions {
  maxPendingRequests?: number;
}

export type MspClientDiagnosticEvent =
  | { type: 'UNSOLICITED_FRAME'; frame: MspFrame }
  | { type: 'PARSER_DIAGNOSTIC'; diagnostic: MspDiagnostic };

const MSP_CLIENT_ERROR_MESSAGES: Record<MspClientErrorCode, string> = {
  MSP_TIMEOUT: 'No matching MSP response arrived before the response timeout elapsed.',
  MSP_REMOTE_ERROR: 'The flight controller responded with an MSP error frame.',
  MSP_SESSION_CLOSED: 'The transport session was closed.',
  MSP_DEVICE_DETACHED: 'The USB device was physically detached.',
  MSP_WRITE_OUTCOME_UNKNOWN:
    'The transport write failed; whether the bytes reached the flight controller is unknown.',
  MSP_QUEUE_FULL: 'The MSP client request queue is full.',
  MSP_TRANSPORT_QUEUE_FULL: 'The transport write queue is full.',
  MSP_RECOVERY_REQUIRED: 'The MSP client is desynchronized and requires recovery before new requests can be sent.',
  MSP_ENCODE_FAILED: 'The request could not be encoded and was never sent to the flight controller.',
};

export class MspClientError extends Error {
  readonly code: MspClientErrorCode;
  readonly frame?: MspFrame;

  constructor(code: MspClientErrorCode, frame?: MspFrame) {
    super(MSP_CLIENT_ERROR_MESSAGES[code]);
    this.name = 'MspClientError';
    this.code = code;
    this.frame = frame;
  }
}

function deriveProtocolVersion(wireFormat: MspWireFormat): MspProtocolVersion {
  return wireFormat === 'v1' ? 'v1' : 'v2';
}

/**
 * Mirrors UsbPromiseSettleOnce's Boolean-return contract (Pass 5.4/5.7),
 * adapted for a plain TypeScript Promise's executor callbacks rather than a
 * React Native Promise object. JS's single-threaded event loop means a
 * plain boolean flag is sufficient - there is no true concurrent access to
 * race, only interleaved async callbacks, which are already serialized one
 * at a time.
 *
 * resolve()/reject() return whether THIS call's own attempt actually won -
 * false means some other settlement already reached the caller of
 * request() first. Every call site that races write-success, write-
 * failure, response-arrival, and timeout against each other MUST check
 * this return value rather than assume it won, exactly as
 * UsbPromiseSettleOnce's own callers must.
 */
class SettleOnce<T> {
  private settledFlag = false;

  constructor(
    private readonly onResolve: (value: T) => void,
    private readonly onReject: (error: unknown) => void,
  ) {}

  get settled(): boolean {
    return this.settledFlag;
  }

  resolve(value: T): boolean {
    if (this.settledFlag) {
      return false;
    }
    this.settledFlag = true;
    this.onResolve(value);
    return true;
  }

  reject(error: unknown): boolean {
    if (this.settledFlag) {
      return false;
    }
    this.settledFlag = true;
    this.onReject(error);
    return true;
  }
}

interface PendingRequest {
  command: number;
  payload: Uint8Array;
  wireFormat: MspWireFormat;
  flags?: number;
  responseTimeoutMs: number;
  settle: SettleOnce<MspFrame>;
}

interface ActiveRequest {
  command: number;
  protocolVersion: MspProtocolVersion;
  phase: MspRequestPhase;
  responseTimeoutMs: number;
  settle: SettleOnce<MspFrame>;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** Classifies a writeBytes() rejection reason into this slice's exact error
 * mapping. Per the Pass 5.3-era precedent already established in this
 * codebase, WRITE_FAILED's underlying exception/message is never inspected
 * further - any code other than the two explicitly recognized "confirmed-
 * not-sent" codes (including a literal WRITE_FAILED, or any unrecognized/
 * malformed rejection shape) is treated as write-outcome-unknown, the safe
 * default given the latch's purpose. */
function classifyWriteFailure(reason: unknown): MspClientErrorCode {
  const code =
    reason && typeof reason === 'object' && 'code' in reason
      ? String((reason as { code: unknown }).code)
      : undefined;
  switch (code) {
    case 'SESSION_CLOSED':
      return 'MSP_SESSION_CLOSED';
    case 'WRITE_QUEUE_FULL':
      return 'MSP_TRANSPORT_QUEUE_FULL';
    default:
      return 'MSP_WRITE_OUTCOME_UNKNOWN';
  }
}

/**
 * MSP request/response client bound to one already-open transport session
 * for its entire lifetime. Does not open, close, or otherwise manage the
 * session itself - that is the caller's responsibility, via whatever
 * concrete MspTransport adapter is in use.
 */
export class MspClient {
  private readonly transport: MspTransport;
  private readonly sessionId: string;
  private readonly maxPendingRequests: number;
  private readonly parser = createMspStreamParser();
  private readonly diagnosticListeners = new Set<(event: MspClientDiagnosticEvent) => void>();
  private readonly unsubscribeData: () => void;
  private readonly unsubscribeSessionDetached: () => void;

  private state: MspClientState = 'READY';
  private queue: PendingRequest[] = [];
  private active: ActiveRequest | undefined;
  /** Incremented every time the desync latch fires. Nothing outside this
   * file consumes it yet in this slice - introduced now, per the standing
   * instruction, because Pass 6.2b's recovery orchestration will need it
   * and retrofitting a generation counter later is riskier than designing
   * it in from the start (the same reasoning Pass 6.1's reset() was
   * pre-designed under, for a not-yet-existing caller). */
  private mspEpoch = 0;
  /** Which cause put the client into DISCONNECTED, so every request()
   * rejected afterward (not just the ones active/pending at the moment of
   * the transition) uses the same code, per the acceptance table. Only
   * MSP_DEVICE_DETACHED is ever actually produced by this slice's own code
   * (its one DISCONNECTED-causing path); MSP_SESSION_CLOSED remains valid
   * here for a future clean-close path this slice does not implement. */
  private disconnectCause: MspClientErrorCode | undefined;
  private disposed = false;

  constructor(transport: MspTransport, sessionId: string, options: MspClientOptions = {}) {
    this.transport = transport;
    this.sessionId = sessionId;
    this.maxPendingRequests = options.maxPendingRequests ?? MSP_CLIENT_MAX_PENDING_REQUESTS_DEFAULT;

    // No sessionId to filter by here - the transport itself is scoped to
    // this one session (see mspTransport.ts's doc comment), so every byte
    // this listener ever receives belongs to it.
    this.unsubscribeData = transport.onDataReceived(bytes => {
      this.handleBytes(bytes);
    });

    // Physical disconnect always wins, even over an already-latched
    // DESYNCHRONIZED state - this subscription is set up once, here, and
    // stays live for the lifetime of the instance regardless of state.
    this.unsubscribeSessionDetached = transport.onSessionDetached(
      (event: MspTransportSessionDetachedEvent) => {
        if (event.sessionId !== this.sessionId) {
          return;
        }
        this.handlePhysicalDetach();
      },
    );
  }

  getState(): MspClientState {
    return this.state;
  }

  getActiveRequestPhase(): MspRequestPhase | undefined {
    return this.active?.phase;
  }

  /** Exposed for the same reason getState() is explicit: so tests (and
   * later, 6.2b's recovery orchestration) can directly verify the latch
   * fired, without inferring it from side effects. */
  getEpoch(): number {
    return this.mspEpoch;
  }

  /** Subscribes to unsolicited (non-matching) frames and raw stream-parser
   * diagnostics - things that happened on the wire that are not the active
   * request's response, surfaced for visibility rather than silently
   * dropped. Returns an unsubscribe function. */
  onDiagnostic(callback: (event: MspClientDiagnosticEvent) => void): () => void {
    this.diagnosticListeners.add(callback);
    return () => this.diagnosticListeners.delete(callback);
  }

  /**
   * Explicit disposal. Rejects the active request (if any) and everything
   * still queued with MSP_SESSION_CLOSED, unsubscribes from both transport
   * listeners via their returned unsubscribe functions (so no subscription
   * outlives this instance), and finalizes to DISCONNECTED.
   *
   * State passes through CLOSING on the way to DISCONNECTED, but CLOSING is
   * not observable from outside this call in this slice: dispose() has no
   * asynchronous gap (this MspClient does not itself own or await closing
   * the underlying session), so it runs synchronously start to finish and
   * getState() can never be read while still CLOSING. CLOSING remains in
   * the type, and this method's ordering keeps it real rather than
   * skipped, for whenever a future pass gives it actual asynchronous work
   * to sit through.
   *
   * If the client already reached DISCONNECTED some other way (the
   * physical-detach override), dispose() still unsubscribes the listeners
   * but does NOT overwrite the more specific cause already recorded (e.g.
   * MSP_DEVICE_DETACHED) with MSP_SESSION_CLOSED - the acceptance table's
   * "whichever caused it" is decided by whichever cause actually happened
   * first, not by whichever cleanup call happens to run last.
   *
   * Idempotent: a second call is a no-op (no throw, nothing re-rejected,
   * listeners not double-unsubscribed).
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    // Best-effort, matching this codebase's existing "swallow and continue"
    // pattern (e.g. UsbSerialWriteQueue.runLoop()'s own task-wrapper catch,
    // android/.../transport/UsbSerialWriteQueue.kt): these unsubscribe
    // functions come from the external transport, outside this file's
    // control. Either one throwing must never prevent the rest of dispose()
    // from running - above all, rejecting the active + queued requests
    // below - which would otherwise leave those Promises hanging forever
    // even though `disposed` is already true and a retry cannot help.
    try {
      this.unsubscribeData();
    } catch {
      // Swallowed intentionally - see comment above.
    }
    try {
      this.unsubscribeSessionDetached();
    } catch {
      // Swallowed intentionally - see comment above.
    }

    if (this.state === 'DISCONNECTED') {
      return;
    }

    this.state = 'CLOSING';

    const active = this.active;
    if (active !== undefined) {
      if (active.timer !== undefined) {
        clearTimeout(active.timer);
      }
      active.settle.reject(new MspClientError('MSP_SESSION_CLOSED'));
      this.active = undefined;
    }
    const rejectedQueue = this.queue.splice(0, this.queue.length);
    for (const pending of rejectedQueue) {
      pending.settle.reject(new MspClientError('MSP_SESSION_CLOSED'));
    }

    this.disconnectCause = 'MSP_SESSION_CLOSED';
    this.state = 'DISCONNECTED';
  }

  /**
   * Enqueues an MSP request and returns a Promise that settles with the
   * matching response frame, or rejects per this slice's error
   * classification table.
   *
   * Two-phase timeout:
   *  - Phase 1 (WRITING): governed entirely by the transport's own internal
   *    write timeout (TX_WRITE_TIMEOUT_MILLIS on the Android side) - this
   *    method adds no timer of its own for this phase.
   *  - Phase 2 (AWAITING_RESPONSE): starts only once the transport's write
   *    Promise itself resolves, bounded by responseTimeoutMs (default
   *    MSP_RESPONSE_TIMEOUT_MILLIS).
   *
   * The response matcher (this request's protocolVersion + command) is
   * registered before the transport's write is ever called, so a
   * correctly-matched response that arrives before the write Promise
   * itself settles still wins normally; a later WRITE_FAILED for that
   * already-settled-by-success request is diagnostic-only and never
   * triggers desynchronization.
   */
  request(command: number, payload: Uint8Array, options: MspRequestOptions): Promise<MspFrame> {
    return new Promise<MspFrame>((resolve, reject) => {
      const settle = new SettleOnce<MspFrame>(resolve, reject);

      const rejectionCode = this.checkAcceptance();
      if (rejectionCode !== undefined) {
        settle.reject(new MspClientError(rejectionCode));
        return;
      }

      if (this.queue.length >= this.maxPendingRequests) {
        // This layer's own queue-bound rejection - never reaches the
        // transport at all.
        settle.reject(new MspClientError('MSP_QUEUE_FULL'));
        return;
      }

      const pending: PendingRequest = {
        command,
        payload,
        wireFormat: options.wireFormat,
        flags: options.flags,
        responseTimeoutMs: options.responseTimeoutMs ?? MSP_RESPONSE_TIMEOUT_MILLIS,
        settle,
      };
      this.queue.push(pending);
      this.pump();
    });
  }

  private checkAcceptance(): MspClientErrorCode | undefined {
    switch (this.state) {
      case 'READY':
        return undefined;
      case 'DESYNCHRONIZED':
      case 'RECOVERY_FAILED':
        return 'MSP_RECOVERY_REQUIRED';
      case 'DISCONNECTED':
        return this.disconnectCause ?? 'MSP_SESSION_CLOSED';
      case 'CLOSING':
        return 'MSP_SESSION_CLOSED';
      default: {
        const exhaustive: never = this.state;
        throw new Error(`Unreachable MspClientState: ${String(exhaustive)}`);
      }
    }
  }

  private pump(): void {
    if (this.state !== 'READY' || this.active !== undefined) {
      return;
    }
    const next = this.queue.shift();
    if (!next) {
      return;
    }
    this.startRequest(next);
  }

  private startRequest(pending: PendingRequest): void {
    let encoded: Uint8Array;
    try {
      encoded = encode(pending.command, pending.payload, {
        wireFormat: pending.wireFormat,
        flags: pending.flags,
      });
    } catch {
      // encode() throwing here means nothing was ever attempted on the wire
      // - a confirmed-not-sent failure, the same category as the
      // SESSION_CLOSED/WRITE_QUEUE_FULL transport rejections handled in
      // onWriteSettled(), so it must not touch this.active (the FIFO slot
      // stays free) and must not desynchronize (nothing was ever written).
      // MSP_WRITE_OUTCOME_UNKNOWN is deliberately not reused for this: that
      // code specifically means a write WAS attempted and its outcome is
      // unknown, which would be misleading here - the write was never even
      // attempted. This branch is only reachable for a request that is not
      // the first to become active: pump() is then invoked from
      // onWriteSettled()/handleFrame(), outside this specific request's own
      // Promise executor call stack, so an uncaught throw here would
      // otherwise never reach this request's own reject() and would hang it
      // forever instead of propagating into the transport's event dispatch.
      pending.settle.reject(new MspClientError('MSP_ENCODE_FAILED'));
      this.pump();
      return;
    }

    const active: ActiveRequest = {
      command: pending.command,
      protocolVersion: deriveProtocolVersion(pending.wireFormat),
      phase: 'WRITING',
      responseTimeoutMs: pending.responseTimeoutMs,
      settle: pending.settle,
      timer: undefined,
    };
    // Registered before the transport write is ever called - see request()'s
    // doc comment on the write-vs-response race this ordering exists for.
    this.active = active;

    let writePromise: Promise<void>;
    try {
      writePromise = this.transport.writeBytes(encoded);
    } catch {
      // MspTransport.writeBytes() is documented (mspTransport.ts) to always
      // return a Promise<void> and encapsulate every failure as a rejection
      // - a conforming implementation never throws synchronously. If a
      // non-conforming transport does anyway, this is genuinely different
      // from the encode() catch above: encode() runs strictly before this
      // point and can never have touched the transport, so that failure is
      // confirmed-not-sent; here writeBytes() itself was actually invoked,
      // so whether any bytes reached the wire is unknown - the same
      // ambiguity classifyWriteFailure()'s own safe default already
      // handles, so this is classified identically: MSP_WRITE_OUTCOME_UNKNOWN,
      // freeing the slot and desynchronizing.
      const won = active.settle.reject(new MspClientError('MSP_WRITE_OUTCOME_UNKNOWN'));
      if (won) {
        if (this.active === active) {
          this.active = undefined;
        }
        this.triggerDesyncLatch();
      }
      return;
    }

    writePromise.then(
      () => this.onWriteSettled(active, undefined),
      (reason: unknown) => this.onWriteSettled(active, reason),
    );
  }

  private onWriteSettled(active: ActiveRequest, failureReason: unknown): void {
    if (failureReason === undefined) {
      if (active.settle.settled) {
        // Early matching response already won the write-vs-response race -
        // the response timer must never even start for it.
        return;
      }
      active.phase = 'AWAITING_RESPONSE';
      active.timer = setTimeout(() => this.onResponseTimeout(active), active.responseTimeoutMs);
      return;
    }

    const code = classifyWriteFailure(failureReason);
    const won = active.settle.reject(new MspClientError(code));
    if (!won) {
      // Regression case: an early matching response already settled this
      // request as success. A later WRITE_FAILED (or any other write
      // rejection) for it is diagnostic-only and must never desync.
      return;
    }
    if (this.active === active) {
      this.active = undefined;
    }
    if (code === 'MSP_WRITE_OUTCOME_UNKNOWN') {
      this.triggerDesyncLatch();
    } else {
      this.pump();
    }
  }

  private onResponseTimeout(active: ActiveRequest): void {
    const won = active.settle.reject(new MspClientError('MSP_TIMEOUT'));
    if (!won) {
      return;
    }
    if (this.active === active) {
      this.active = undefined;
    }
    this.triggerDesyncLatch();
  }

  private handleBytes(bytes: Uint8Array): void {
    const result = this.parser.ingest(bytes);
    for (const event of result.events) {
      if (event.type === 'FRAME') {
        this.handleFrame(event.frame);
      } else {
        this.emitDiagnostic({ type: 'PARSER_DIAGNOSTIC', diagnostic: event.diagnostic });
      }
    }
  }

  private handleFrame(frame: MspFrame): void {
    const active = this.active;
    const matches =
      active !== undefined &&
      !active.settle.settled &&
      frame.protocolVersion === active.protocolVersion &&
      frame.command === active.command &&
      (frame.direction === 'response' || frame.direction === 'error');

    if (!matches || active === undefined) {
      this.emitDiagnostic({ type: 'UNSOLICITED_FRAME', frame });
      return;
    }

    if (active.timer !== undefined) {
      clearTimeout(active.timer);
    }

    const won =
      frame.direction === 'error'
        ? active.settle.reject(new MspClientError('MSP_REMOTE_ERROR', frame))
        : active.settle.resolve(frame);

    if (!won) {
      // Not reachable given the `!active.settle.settled` check above (JS is
      // single-threaded; nothing else can settle it between that check and
      // here) - kept as a defensive invariant, not relied on to be false.
      return;
    }
    if (this.active === active) {
      this.active = undefined;
    }
    // A remote-error response does NOT desynchronize (the FC responded,
    // communication is intact) - either outcome simply frees the slot.
    this.pump();
  }

  private triggerDesyncLatch(): void {
    const rejectedQueue = this.queue.splice(0, this.queue.length);
    for (const pending of rejectedQueue) {
      pending.settle.reject(new MspClientError('MSP_RECOVERY_REQUIRED'));
    }
    this.mspEpoch += 1;
    this.state = 'DESYNCHRONIZED';
  }

  private handlePhysicalDetach(): void {
    const code: MspClientErrorCode = 'MSP_DEVICE_DETACHED';
    this.disconnectCause = code;

    const active = this.active;
    if (active !== undefined) {
      if (active.timer !== undefined) {
        clearTimeout(active.timer);
      }
      active.settle.reject(new MspClientError(code));
      this.active = undefined;
    }

    const rejectedQueue = this.queue.splice(0, this.queue.length);
    for (const pending of rejectedQueue) {
      pending.settle.reject(new MspClientError(code));
    }

    // Hard override: unconditional, regardless of the state this instance
    // was previously latched into (including DESYNCHRONIZED).
    this.state = 'DISCONNECTED';
  }

  private emitDiagnostic(event: MspClientDiagnosticEvent): void {
    for (const listener of this.diagnosticListeners) {
      try {
        listener(event);
      } catch {
        // Best-effort, matching this codebase's existing "swallow and
        // continue" pattern (e.g. UsbSerialWriteQueue.runLoop()'s own
        // task-wrapper catch, android/.../transport/UsbSerialWriteQueue.kt):
        // a caller-supplied onDiagnostic() listener is external code this
        // file does not control. One listener throwing must never prevent
        // another registered listener from running, and must never abort
        // handleBytes()'s enclosing for-loop - which would otherwise
        // silently drop every remaining event in this same ingest() chunk,
        // including a real, matching response frame.
      }
    }
  }
}
