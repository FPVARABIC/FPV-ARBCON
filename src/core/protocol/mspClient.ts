/**
 * MSP request/response engine with a "detect and latch" desynchronization
 * response (Pass 6.2a) and automatic recovery orchestration (Pass 6.2b).
 *
 * On a write-outcome-unknown failure or a response timeout, the client
 * latches into DESYNCHRONIZED and, in the SAME synchronous call
 * (triggerDesyncLatch() -> startRecovery()), begins recovery immediately:
 * RESTARTING_READER (transport.restartReceiveLoop()) -> PROBING (one
 * lightweight, read-only MSP request) -> READY on success, or
 * RECOVERY_FAILED (terminal for this instance - a full reconnect or
 * MspClient replacement is required, out of scope for this slice) on
 * failure at either step. Because recovery starts synchronously from the
 * same code path that sets DESYNCHRONIZED, that state is never externally
 * observable as a distinct tick - see startRecovery()'s doc comment.
 *
 * Every recovery step is guarded by isCurrentRecoveryAttempt(epoch),
 * checked immediately before each transition/action, not only after an
 * await resolves - a second desync, a physical detach, or dispose() during
 * an in-flight recovery attempt's async work silently retires that
 * attempt's remaining continuations instead of racing them. See
 * isCurrentRecoveryAttempt()'s own doc comment for the one interleaving
 * this project's own review found unreachable under this design.
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

export type MspClientState =
  | 'READY'
  | 'DESYNCHRONIZED'
  | 'RESTARTING_READER'
  | 'PROBING'
  | 'RECOVERY_FAILED'
  | 'DISCONNECTED'
  | 'CLOSING';

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
  /**
   * BETAFLIGHT'S OWN RESEND, and the reason this option exists.
   *
   * Betaflight Configurator's MSP.send_message (src/js/msp.js) arms a
   * `MSP.TIMEOUT` (1000 ms) timer per request whose ONLY job is to write
   * the SAME encoded frame to the port a second time. The pending
   * callback is not rejected, not dequeued, and not reported to anyone -
   * the request simply stays outstanding until a matching response
   * arrives. That is why a board which misses the very first MSP request
   * after its port opens - a flight controller whose USB stack is still
   * coming up is the ordinary case, not an exotic one - still connects in
   * Betaflight: it gets asked again.
   *
   * This client had no equivalent. One request, one timeout, and the
   * timeout latched desync (see onResponseTimeout), so identification
   * failed permanently on a board that had merely been slow to answer
   * once. Retrying from ABOVE the client cannot fix that - a retry loop
   * in the identification service was tried and reverted precisely
   * because the latch refuses every later attempt with MSP_RECOVERING
   * before it reaches the wire (docs/IDENTIFICATION_RETRY_DECISION.md).
   * The resend has to live where Betaflight puts it: inside the request,
   * before the request is considered to have failed at all.
   *
   * Deliberate difference from Betaflight: Betaflight resends once and
   * then waits forever. This keeps the overall responseTimeoutMs deadline
   * so a genuinely silent port still fails in bounded time instead of
   * hanging the UI - the retry is bounded by BOTH attempts and the
   * deadline, whichever comes first.
   *
   * Resends are only ever written while the request is in
   * AWAITING_RESPONSE - i.e. after its own first write已 settled - so
   * this never overlaps two writes, and the single-flight invariant is
   * untouched.
   */
  resend?: MspResendPolicy;
}

export interface MspResendPolicy {
  /** Milliseconds of silence before the same frame is written again. */
  intervalMs: number;
  /** How many EXTRA writes are permitted. 1 matches Betaflight exactly. */
  maxResends: number;
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
  MSP_RECOVERING: 'The MSP client is automatically recovering from a communication desync; retry shortly.',
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

/** Pass 6.2b recovery probe: a small, fixed, read-only MSP command,
 * deliberately different from whatever command caused the original
 * desync - independently verified against Betaflight's own
 * src/main/msp/msp_protocol.h (MSP_API_VERSION = 1), not assumed from
 * memory, per this project's standing "verify, don't assume" convention.
 *
 * KNOWN GAP, DEFERRED (found investigating a Pass 6.4b real-hardware
 * timeout): this happens to be the SAME command as MSP_API_VERSION,
 * which MspIdentificationService.identify() (Pass 6.4a) sends first - so
 * a probe fired shortly after an identify()-driven MSP_API_VERSION
 * timeout produces a reply indistinguishable, by raw bytes, from a
 * second reply to the original request. Confirmed NOT the cause of that
 * timeout (a missing startReading() call was - fixed separately in
 * MspSessionCoordinator.openSession()); this collision only made the
 * symptom read as "duplicate response" instead of a plain hang. Left
 * unfixed here, deliberately - tracked as its own separate future task. */
const MSP_PROBE_COMMAND = 1; // MSP_API_VERSION
const MSP_PROBE_PAYLOAD = new Uint8Array(0);
const MSP_PROBE_WIRE_FORMAT: MspWireFormat = 'v1';
/** Reuses MSP_RESPONSE_TIMEOUT_MILLIS rather than a distinct constant: the
 * probe is an ordinary, lightweight, zero-payload request through the
 * exact same pipeline as any other - there is no justified reason to
 * expect it to need a shorter or longer bound than a real request's own
 * response timeout, so this pass does not introduce a second timeout knob
 * with no distinct value to justify it. */
const MSP_PROBE_TIMEOUT_MILLIS = MSP_RESPONSE_TIMEOUT_MILLIS;

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
  /** Betaflight-style resend; see MspRequestOptions.resend. */
  resend: MspResendPolicy | undefined;
  settle: SettleOnce<MspFrame>;
  /** Required, never defaulted (same "no silent default" convention as
   * MspRequestOptions.wireFormat) - true only for the internal Pass 6.2b
   * recovery probe built by sendProbe(), false for every real request()
   * call. Threaded onto ActiveRequest and consulted at every failure exit
   * in this request's lifecycle to skip classifyWriteFailure()/
   * triggerDesyncLatch() for the probe - see sendProbe()'s doc comment. */
  isProbe: boolean;
  /** Phase 2G: true only for the single lease-owned emergency stop built
   * by emergencyStopWithMotorTestLease(). Never defaulted, same "no silent
   * default" convention as isProbe. The stop does NOT live in `queue` at
   * all - it occupies its own one-slot register that pump() drains ahead
   * of the FIFO - so this flag exists to make the record self-describing
   * at every later exit, not to select it out of the queue. */
  isEmergencyStop: boolean;
}

interface ActiveRequest {
  command: number;
  protocolVersion: MspProtocolVersion;
  phase: MspRequestPhase;
  responseTimeoutMs: number;
  settle: SettleOnce<MspFrame>;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** The exact bytes written for this request, kept so a resend writes the
   * SAME frame Betaflight would rather than re-encoding it. */
  encoded: Uint8Array;
  resend: MspResendPolicy | undefined;
  /** Extra writes still permitted; counts down from resend.maxResends. */
  resendsLeft: number;
  resendTimer: ReturnType<typeof setTimeout> | undefined;
  /** True once this request has actually been written more than once, so
   * its settlement can arm the duplicate-response quarantine below. */
  wasResent: boolean;
  isProbe: boolean;
  isEmergencyStop: boolean;
  /** Phase 2G: set when an emergency stop was registered while THIS
   * request was still in phase WRITING. The transport write already
   * handed to writeBytes() cannot be cancelled and must never be raced by
   * a second concurrent write, so the stop waits for it. When that write
   * finally settles, onWriteSettled() consults this flag and settles this
   * request as displaced INSTEAD of entering AWAITING_RESPONSE and arming
   * a 2000 ms response timer - which would otherwise make the stop wait
   * out a full response timeout it has no reason to wait for. */
  displacedByEmergencyStop: boolean;
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

/* ------------------------------------------------------------------ *
 * Pass 2 - exclusive motor-test lease primitives.
 *
 * These are OWNERSHIP primitives over MSP request admission. Nothing here
 * decides, implies or grants motor safety, readiness or authorization,
 * and no name in this section may ever be read that way.
 * ------------------------------------------------------------------ */

/**
 * Opaque ownership token. Deliberately a class with NO public data: an
 * instance carries no own enumerable property, so `{...token}`,
 * `JSON.stringify(token)` and `structuredClone`-style reconstruction all
 * produce something that can never be `===` the real token. Identity
 * comparison is the only test that exists.
 */
export class MspMotorTestLeaseToken {
  /** Present only so the type is nominal to TypeScript; never read. */
  private readonly brand: undefined;

  constructor() {
    this.brand = undefined;
  }
}

/** Why an exclusive lease could not be taken. These are ownership facts,
 * never safety verdicts. */
export type MspMotorTestLeaseRejectionReason =
  /** The request engine is not truly idle - an active request, a queued
   * request, a write awaiting settlement, a probe, or a state that is not
   * plainly READY. */
  | 'MSP_CLIENT_NOT_IDLE'
  /** Some other holder already owns this exact client. */
  | 'MOTOR_TEST_LEASE_ALREADY_HELD'
  /** A previous lease on this same composite identity died from an
   * MSP/client fault. A new session identity is required. */
  | 'MOTOR_TEST_LEASE_FAULT_LATCHED';

export type MspMotorTestLeaseAcquireOutcome =
  | {readonly kind: 'ACQUIRED'; readonly token: MspMotorTestLeaseToken}
  | {readonly kind: 'REJECTED'; readonly reason: MspMotorTestLeaseRejectionReason};

export type MspMotorTestLeaseReleaseOutcome =
  /** The exact active token released an idle client. */
  | {readonly kind: 'RELEASED'}
  /** Same token, already released. Idempotent no-op - crucially it does
   * NOT touch a newer lease. */
  | {readonly kind: 'ALREADY_RELEASED'}
  /** The token was killed by close/detach/desync/fault. No-op. */
  | {readonly kind: 'INVALIDATED'}
  /** Not the active token (forged, stale, or from another client). */
  | {readonly kind: 'NOT_OWNER'}
  /** Lease-owned work is still active, queued or awaiting write
   * settlement. The lease stays HELD and ordinary traffic stays blocked. */
  | {readonly kind: 'LEASE_WORK_UNSETTLED'};

export type MspMotorTestLeaseBlockedCode =
  /** An ordinary request was refused because a lease is held. It never
   * reached the FIFO, the transport, or any timer. */
  | 'MSP_MOTOR_TEST_LEASE_HELD'
  /** A lease-scoped request presented a token that is not the active one. */
  | 'MSP_MOTOR_TEST_LEASE_CAPABILITY_INVALID';

/**
 * Rejection raised by request admission while a lease is in force.
 *
 * Deliberately NOT a member of MSP_CLIENT_ERROR_CODES: that list is
 * documented as the USER-FACING codes request() can reject with, and its
 * test requires an ar.json translation for every entry. Pass 2 adds no UI
 * and no runtime caller, so inventing user-facing Arabic copy for it
 * would be wrong. It still carries a `code` field, so any consumer that
 * reads `error.code` keeps working, while `instanceof MspClientError`
 * checks correctly do NOT match - a lease refusal is not a timeout, a
 * remote error, or any other MSP outcome.
 */
export class MspMotorTestLeaseBlockedError extends Error {
  readonly code: MspMotorTestLeaseBlockedCode;

  constructor(code: MspMotorTestLeaseBlockedCode) {
    super(code);
    this.name = 'MspMotorTestLeaseBlockedError';
    this.code = code;
  }
}

/* ---------------- Phase 2G Pass 1: emergency stop priority ----------------
 *
 * WHAT THIS ADDS, EXACTLY. One extra submission slot, drained by pump()
 * ahead of the FIFO, writable only by the live motor-test lease. Nothing
 * else about the request engine changes: still one active request at a
 * time, still one writeBytes() in flight at a time, still the same
 * two-phase timeout, still the same settle precedence.
 *
 * WHAT IT DOES **NOT** ADD - and what must never be claimed of it:
 *   - It does NOT cancel, abort or recall bytes already handed to
 *     transport.writeBytes(). Nothing at this layer can.
 *   - It does NOT preempt anything ON THE WIRE. The strongest true
 *     statement is submission-order only: the stop is the NEXT
 *     transport.writeBytes() invocation this client makes.
 *   - It does NOT bound end-to-end latency while a real write is still in
 *     flight. The deterministic bound applies only when the transport is
 *     free, or when the displaced request has already reached
 *     AWAITING_RESPONSE (its write settled, so the transport IS free).
 *   - It does NOT confirm any motor physically stopped. An ACK proves the
 *     command was received and processed, nothing mechanical.
 *
 * WHAT LIES BEYOND THIS FILE (read-only inspection of the Android native
 * write path, recorded here so no later pass has to re-derive it, and so
 * the boundary is stated in code rather than only in a review):
 *   - UsbSerialTransportModule.writeBytes() enqueues a
 *     UsbSerialWriteRequest and resolves its Promise from that request's
 *     onComplete callback. performSerialWrite() invokes onComplete only
 *     AFTER sink.write() has returned or thrown - so the Promise this
 *     file awaits settles after the native serial write finished, not
 *     when it was merely handed over.
 *   - UsbSerialSession.write() delegates to port.write(buffer, timeout)
 *     under an ioLock, and is documented confirmed-as-written: every byte
 *     written and returns, or throws. The native attempt is bounded by
 *     TX_WRITE_TIMEOUT_MILLIS (1000 ms) and is never auto-retried.
 *   - Writes ARE serialized natively, twice over: UsbSerialWriteQueue is a
 *     bounded strict-FIFO single-consumer queue with one dedicated thread
 *     per session, and UsbSerialSession.write() additionally holds ioLock.
 *   - THE LIMIT: that native queue has NO priority path and NO
 *     cancellation. stopAndDrainPending() drains everything and stops the
 *     queue permanently; it belongs to session close, not to a stop. So
 *     anything already sitting in the native queue would be written
 *     BEFORE a stop submitted afterwards. What keeps that from mattering
 *     here is this client's own single-flight rule - it never has more
 *     than one writeBytes() outstanding - and NOT any native priority. A
 *     second caller writing to the same session outside this MspClient
 *     would break that assumption, and no mechanism in this file could
 *     detect it.
 */

export type MspMotorTestStopDisplacementCode =
  /** The displaced request was still queued. It never reached encode(),
   * never reached the transport, and never started a timer - so there is
   * no wire ambiguity whatsoever for it. */
  | 'MSP_DISPLACED_BY_EMERGENCY_STOP'
  /** The displaced request had already been written (or was mid-write).
   * Its bytes may be on the wire and a late response for it may still
   * arrive; it is quarantined per-request, see handleFrame(). */
  | 'MSP_DISPLACED_IN_FLIGHT_BY_EMERGENCY_STOP';

/**
 * Rejection raised when an emergency stop displaces other lease-owned or
 * in-flight work. Deliberately NOT an MspClientError and NOT a member of
 * MSP_CLIENT_ERROR_CODES: displacement is not an MSP outcome, has no
 * user-facing copy, and must not be confused with a timeout, a write
 * failure or a remote error by any `instanceof MspClientError` consumer.
 */
export class MspMotorTestStopDisplacementError extends Error {
  readonly code: MspMotorTestStopDisplacementCode;
  /** Whether transport.writeBytes() had already been invoked for the
   * displaced request. False means confirmed-not-sent. */
  readonly writeAttempted: boolean;

  constructor(code: MspMotorTestStopDisplacementCode, writeAttempted: boolean) {
    super(code);
    this.name = 'MspMotorTestStopDisplacementError';
    this.code = code;
    this.writeAttempted = writeAttempted;
  }
}

export type MspEmergencyStopAbortCode =
  /** The client desynchronized before the stop could be submitted. The
   * lease is faulted and the epoch latched - recovery cannot revive it. */
  | 'MSP_EMERGENCY_STOP_ABORTED_BY_DESYNC'
  /** The session closed or the device detached before submission. */
  | 'MSP_EMERGENCY_STOP_ABORTED_BY_SESSION_END';

/**
 * Rejection for a registered emergency stop that was never submitted
 * because the engine died underneath it. Always settles - a stop must
 * never hang - and always fails CLOSED: the caller may not treat this as
 * a stop that was sent.
 */
export class MspEmergencyStopAbortedError extends Error {
  readonly code: MspEmergencyStopAbortCode;

  constructor(code: MspEmergencyStopAbortCode) {
    super(code);
    this.name = 'MspEmergencyStopAbortedError';
    this.code = code;
  }
}

/**
 * The synchronous result of registering an emergency stop. Returned
 * SYNCHRONOUSLY, before any await, so the caller learns the displacement
 * facts at registration time rather than after the exchange.
 */
export interface MspEmergencyStopDispatch {
  /** Settles with the stop's own response frame, or rejects. Never hangs. */
  readonly frame: Promise<MspFrame>;
  /**
   * TRUE when the request this stop displaced carried the SAME command
   * and protocol version as the stop itself, AND had already been
   * written (or was mid-write).
   *
   * Why it matters: the ordinary quarantine of a displaced request's late
   * response is automatic - handleFrame() matches against `this.active`,
   * and a displaced request is no longer active, so its late frame
   * becomes an UNSOLICITED_FRAME diagnostic and settles nothing. That
   * automatic quarantine fails for exactly one shape: when the displaced
   * command EQUALS the stop's command, a late frame belonging to the
   * displaced request is byte-indistinguishable from the stop's own ACK
   * and WILL match the stop. The caller must therefore treat the stop's
   * apparent acknowledgement as unproven, keep every acknowledgement and
   * confirmation flag false, and require a full session reset.
   */
  readonly attributionAmbiguous: boolean;
  /**
   * TRUE when a real transport write was still in flight at registration.
   * The stop is the next submission, but the caller may NOT claim any
   * deterministic upper latency bound for it - the uncancellable write
   * ahead of it settles on the transport's own schedule.
   */
  readonly deferredBehindActiveWrite: boolean;
  /** TRUE when this call joined the one already-registered stop instead
   * of registering a second one. Repeated triggers never produce a second
   * writeBytes(). */
  readonly joinedExistingStop: boolean;
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
  /** Pass 7.4, Step 4: fires on every `state` transition (READY <->
   * DESYNCHRONIZED/RESTARTING_READER/PROBING/RECOVERY_FAILED, and the
   * DISCONNECTED/CLOSING terminal transitions) - see setState() below,
   * the ONE place `this.state` is ever assigned. Deliberately GENERIC
   * (every transition, not just the ones a particular UI need happens to
   * care about right now) - the exact same "narrow producer, let
   * consumers filter" precedent as onDiagnostic() itself. Mirrors the
   * Set<listener>/Array.from()-snapshot/per-listener-try-catch idiom
   * MspTelemetryScheduler.subscribe() and MspSessionCoordinator's own
   * three axes already established this pass - NOT emitDiagnostic()'s
   * own older (Pass 6.2a) plain `for...of` loop below, which predates
   * that idiom. */
  private readonly stateListeners = new Set<() => void>();
  private readonly unsubscribeData: () => void;
  private readonly unsubscribeSessionDetached: () => void;

  private state: MspClientState = 'READY';
  private queue: PendingRequest[] = [];
  private active: ActiveRequest | undefined;
  /* ---------------- Pass 2: exclusive motor-test lease ----------------
   * The lease lives HERE, in the one class that owns request admission,
   * and nowhere else. That placement is the whole point: two wrappers
   * built over the same MspClient cannot both hold a lease, because
   * neither of them holds the state - this instance does.
   *
   * Holding a lease is an MSP OWNERSHIP reservation and nothing else. It
   * is not a motor-safety decision and grants no authority to send any
   * motor or arming command. */

  /** The one active ownership token, or undefined when unleased. A fresh
   * object identity generated HERE - never a caller-supplied string,
   * number, UUID or timestamp - so it cannot be forged, guessed, cloned,
   * serialized or reconstructed. */
  private motorTestLeaseToken: MspMotorTestLeaseToken | undefined;
  /** Tokens retired by a normal release. Kept so a stale token's release
   * is idempotent WITHOUT touching whatever lease is current now (the
   * ABA case). */
  private readonly retiredMotorTestLeaseTokens = new WeakSet<MspMotorTestLeaseToken>();
  /** Tokens killed by close, detach, desync or a lease-scoped failure.
   * Permanently unusable; a recovery probe never revives one. */
  private readonly invalidatedMotorTestLeaseTokens = new WeakSet<MspMotorTestLeaseToken>();
  /** Epochs at which a lease died from an MSP/client fault. Reacquisition
   * is refused until the epoch changes, i.e. until the established
   * session-reset mechanism produces a genuinely new composite identity.
   * A normal idle release never adds to this set. */
  private readonly motorTestLeaseFaultEpochs = new Set<number>();
  /** The epoch the current lease was acquired under, so a fault latches
   * that epoch rather than whatever the epoch became afterwards. */
  private motorTestLeaseEpoch: number | undefined;
  /* ------------- Phase 2G Pass 1: the one emergency stop slot -------------
   * A ONE-slot register, not a second queue: at most one emergency stop
   * can be registered at a time and a repeated trigger joins it. It sits
   * outside `queue` so pump() can take it ahead of the FIFO without
   * reordering, scanning or mutating the FIFO itself. */

  /** The registered stop awaiting submission, or undefined once pump()
   * has started it (or once it settled). */
  private emergencyStopPending: PendingRequest | undefined;
  /**
   * R5 - THE DISPLACED-RESPONSE QUARANTINE.
   *
   * MSP frames carry NO per-request correlation id: a response is matched
   * by command alone. So when an emergency stop displaces a request whose
   * bytes were ALREADY WRITTEN, that request's late response is
   * byte-identical to the response of any later request carrying the same
   * command - and would settle it with stale data.
   *
   * The concrete case this exists for: a safety observation of
   * MSP_STATUS_EX is displaced by a stop, the stop is acknowledged, a
   * FRESH MSP_STATUS_EX becomes active for the next safety gate, and the
   * displaced read's answer finally arrives. Without this ledger that
   * answer settles the fresh read, and a stale snapshot authorises the
   * next pulse.
   *
   * `command -> how many late responses for it must be swallowed`. Armed
   * only for a WRITTEN displaced request, and only when its command
   * differs from the stop's own (an equal command is the pre-existing
   * `attributionAmbiguous` case, which fails closed by caller contract and
   * must not have the stop's own ACK eaten here).
   *
   * Released when the stop settles: the link answers in FIFO order, so by
   * the time the stop's own response arrives, the displaced request's
   * answer has either already been swallowed or is never coming.
   */
  private quarantinedResponses = new Map<number, number>();
  /** The command of the registered stop, so a displacement settled later
   * (the WRITING case) can compare against it. */
  private emergencyStopCommand: number | undefined;
  /** Identity of the registered stop for as long as it is unsettled, used
   * to join repeat triggers and to clear the registration exactly once. */
  private emergencyStopSettle: SettleOnce<MspFrame> | undefined;
  /** The joinable promise for the registered stop. */
  private emergencyStopFrame: Promise<MspFrame> | undefined;
  /** Displacement facts captured at registration, replayed to joiners. */
  private emergencyStopAttributionAmbiguous = false;
  private emergencyStopDeferredBehindActiveWrite = false;
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

  /**
   * Pass 7.4, Step 4: subscribes to every `state` transition. Unlike
   * MspTelemetryScheduler.getValue() (Pass 7.2/Step 0.5), getState()
   * itself needs NO parallel object-caching machinery for
   * useSyncExternalStore's referential-stability contract: MspClientState
   * is a bare string union, and JavaScript string primitives are always
   * reference-stable via ===/Object.is() regardless of how or when they
   * were computed - two consecutive getState() calls with no transition
   * in between are trivially `===` already, with no wrapping object and
   * no cached-value field required. This is a genuinely different
   * situation from Step 0.5's bug, which was specifically about a freshly
   * CONSTRUCTED OBJECT's identity, not a primitive value - confirmed by
   * tracing the actual JS semantics, not assumed by analogy.
   *
   * DISPOSAL: setState() (the only place notify() is ever called from) is
   * reachable only from this class's own state-transition sites, every
   * one of which outside dispose()/handlePhysicalDetach() is already
   * gated by isCurrentRecoveryAttempt(epoch) - which explicitly excludes
   * CLOSING and DISCONNECTED, the exact two states dispose() sets (and
   * handlePhysicalDetach() sets DISCONNECTED directly). Since dispose()
   * runs fully synchronously (no `await` inside it - see its own doc
   * comment) and permanently prevents its own re-entry (`this.disposed`),
   * no further setState() call - and therefore no further notify() call -
   * can EVER happen once dispose() has returned: every async recovery
   * continuation that might still resolve afterward checks
   * isCurrentRecoveryAttempt() first and silently no-ops instead. This
   * existing Pass 6.2b guard (built to stop stale recovery attempts from
   * resurrecting state, for an unrelated reason) already fully satisfies
   * "no listener call after dispose()" for free - no additional guard was
   * added here, and none is needed. subscribe() itself deliberately does
   * NOT clear stateListeners in dispose() either: an already-registered
   * listener simply stops being invoked (nothing can trigger it again),
   * the same way onDiagnostic() listeners are left as-is by dispose()
   * today.
   */
  subscribe(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  /** The ONE place `this.state` is ever assigned - guarantees every
   * transition is paired with a notify() call, with no site able to
   * forget it. Notifies unconditionally, even on a same-value
   * reassignment (e.g. a defensive double handlePhysicalDetach() call) -
   * the same "notify every call, let useSyncExternalStore's own bail-out
   * absorb a no-op" precedent MspTelemetryScheduler.tick() already
   * established, rather than adding an equality check no other axis in
   * this pass bothers with either. */
  private setState(next: MspClientState): void {
    this.state = next;
    this.notify();
  }

  private notify(): void {
    for (const listener of Array.from(this.stateListeners)) {
      try {
        listener();
      } catch {
        // Best-effort - same reasoning as emitDiagnostic()'s own catch
        // below: a caller-supplied listener is external code this file
        // does not control, and one throwing must never block another.
      }
    }
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
    // Pass 2: a closing client can never own anything again. Done first so
    // the rejections below cannot be observed by a still-live capability.
    this.invalidateMotorTestLease();
    // R5: the displaced-response ledger belongs to THIS session's identity.
    // Surviving disposal would let it swallow the first genuine frame of
    // whatever session replaces this one.
    this.quarantinedResponses.clear();

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

    this.setState('CLOSING');

    const active = this.active;
    if (active !== undefined) {
      this.clearRequestTimers(active);
      active.settle.reject(new MspClientError('MSP_SESSION_CLOSED'));
      this.active = undefined;
    }
    this.abortRegisteredEmergencyStop('MSP_EMERGENCY_STOP_ABORTED_BY_SESSION_END');
    const rejectedQueue = this.queue.splice(0, this.queue.length);
    for (const pending of rejectedQueue) {
      pending.settle.reject(new MspClientError('MSP_SESSION_CLOSED'));
    }

    this.disconnectCause = 'MSP_SESSION_CLOSED';
    this.setState('DISCONNECTED');
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
    // Pass 2: the ONE exclusivity gate for ordinary traffic. Placed before
    // every other step on purpose - a refused request never reaches
    // checkAcceptance(), never enters the FIFO, never becomes active,
    // never calls writeBytes(), never starts or clears a timer, and never
    // triggers recovery. When no lease is held this is a plain
    // `undefined` comparison and every pre-existing behaviour below is
    // reached exactly as before.
    if (this.motorTestLeaseToken !== undefined) {
      return Promise.reject(new MspMotorTestLeaseBlockedError('MSP_MOTOR_TEST_LEASE_HELD'));
    }
    return this.enqueue(command, payload, options);
  }

  private enqueue(
    command: number,
    payload: Uint8Array,
    options: MspRequestOptions,
  ): Promise<MspFrame> {
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
        resend: options.resend,
        settle,
        isProbe: false,
        isEmergencyStop: false,
      };
      this.queue.push(pending);
      this.pump();
    });
  }

  /* ---------------- Pass 2: exclusive motor-test lease ---------------- */

  /**
   * TRUE idle, as required before ownership may be reserved. Every clause
   * is load-bearing:
   *  - state READY excludes DESYNCHRONIZED, RESTARTING_READER, PROBING,
   *    RECOVERY_FAILED, DISCONNECTED and CLOSING;
   *  - `active === undefined` excludes BOTH request phases, i.e. a write
   *    still awaiting settlement (WRITING) and a response still awaited
   *    (AWAITING_RESPONSE), and also every recovery probe, which is only
   *    ever active while state is PROBING;
   *  - an empty queue excludes work that has been admitted but not yet
   *    started;
   *  - `!disposed` excludes an instance already torn down.
   *
   * Phase 2G Pass 1 adds the emergency-stop slot to the same conjunction.
   * It can only ever be non-empty while a lease is already held (only a
   * live lease can register one), so in practice tryAcquireMotorTestLease()
   * is already refused by the ALREADY_HELD check before reaching here -
   * but "idle" must mean idle including the slot, not idle except for the
   * one submission that matters most. This is the DRAINED BOUNDARY the
   * lease acquires over: no ordinary request can be queued, active, or
   * mid-write at the instant ownership is taken.
   */
  private isRequestEngineIdle(): boolean {
    return (
      !this.disposed &&
      this.state === 'READY' &&
      this.active === undefined &&
      this.queue.length === 0 &&
      this.emergencyStopPending === undefined
    );
  }

  /**
   * Synchronous, atomic, non-queued try-acquire. Never retries, never
   * waits, never schedules a later attempt, and never throws for an
   * expected refusal. Exactly one caller can win; a second or re-entrant
   * attempt is refused immediately.
   *
   * Acquiring reserves MSP request ownership. It is NOT a motor-safety
   * decision and authorizes no motor or arming command.
   */
  tryAcquireMotorTestLease(): MspMotorTestLeaseAcquireOutcome {
    if (this.motorTestLeaseToken !== undefined) {
      return {kind: 'REJECTED', reason: 'MOTOR_TEST_LEASE_ALREADY_HELD'};
    }
    if (this.motorTestLeaseFaultEpochs.has(this.mspEpoch)) {
      return {kind: 'REJECTED', reason: 'MOTOR_TEST_LEASE_FAULT_LATCHED'};
    }
    if (!this.isRequestEngineIdle()) {
      return {kind: 'REJECTED', reason: 'MSP_CLIENT_NOT_IDLE'};
    }
    const token = new MspMotorTestLeaseToken();
    this.motorTestLeaseToken = token;
    this.motorTestLeaseEpoch = this.mspEpoch;
    return {kind: 'ACQUIRED', token};
  }

  /** Whether this exact token is the live owner right now. */
  isMotorTestLeaseToken(token: unknown): boolean {
    return this.motorTestLeaseToken !== undefined && token === this.motorTestLeaseToken;
  }

  /** Whether ANY lease is currently held on this client. */
  isMotorTestLeaseHeld(): boolean {
    return this.motorTestLeaseToken !== undefined;
  }

  /**
   * The only way a lease-scoped request may be admitted. The token is
   * revalidated HERE, at admission time, on every single call - so a
   * stale, released, invalidated, forged, cross-session or wrong-client
   * token fails closed before the FIFO, before the transport and before
   * any timer.
   *
   * An admitted request then goes through the SAME enqueue -> pump ->
   * startRequest -> writeBytes pipeline as any other: the existing FIFO,
   * the existing single-flight rule, the existing two-phase timeout and
   * the existing settle precedence, with no second queue and no parallel
   * write path. No priority, cancellation or preemption is introduced.
   *
   * Any failure of a lease-scoped request kills the lease and latches the
   * fault for the identity it was acquired under.
   */
  requestWithMotorTestLease(
    token: unknown,
    command: number,
    payload: Uint8Array,
    options: MspRequestOptions,
  ): Promise<MspFrame> {
    if (!this.isMotorTestLeaseToken(token)) {
      return Promise.reject(
        new MspMotorTestLeaseBlockedError('MSP_MOTOR_TEST_LEASE_CAPABILITY_INVALID'),
      );
    }
    const promise = this.enqueue(command, payload, options);
    // One place, covering every rejection route the existing engine
    // already has - write failure, write-outcome-unknown, write timeout
    // surfaced as a transport rejection, response timeout, remote error,
    // desync, queue bound, encode failure, close and detach.
    promise.catch((reason: unknown) => {
      // Phase 2G Pass 1 - ONE exception, and only one. A request displaced
      // by this same lease's own emergency stop is not an MSP fault: it is
      // a deterministic, deliberate cancellation with a known cause, and
      // for a still-queued request there is no wire ambiguity at all.
      // Faulting here would be actively harmful - it would kill the very
      // lease the stop is travelling on, before the stop has been
      // answered and before teardown can release it cleanly. The stop's
      // OWN failure still faults through this same route (see
      // emergencyStopWithMotorTestLease), and an in-flight displacement
      // whose late response could be mistaken for the stop's ACK is
      // reported separately as attributionAmbiguous. Every other rejection
      // reason behaves exactly as before.
      if (reason instanceof MspMotorTestStopDisplacementError) {
        return;
      }
      this.faultMotorTestLease();
    });
    return promise;
  }

  /**
   * Lease-scoped optional request. A confirmed MSP error frame is a
   * definite firmware-level "unsupported/refused" answer and therefore
   * does not poison the lease. Every transport-ambiguous failure remains
   * fail-closed exactly as on requestWithMotorTestLease().
   */
  requestOptionalWithMotorTestLease(
    token: unknown,
    command: number,
    payload: Uint8Array,
    options: MspRequestOptions,
  ): Promise<MspFrame> {
    if (!this.isMotorTestLeaseToken(token)) {
      return Promise.reject(
        new MspMotorTestLeaseBlockedError('MSP_MOTOR_TEST_LEASE_CAPABILITY_INVALID'),
      );
    }
    const promise = this.enqueue(command, payload, options);
    promise.catch((reason: unknown) => {
      if (
        reason instanceof MspMotorTestStopDisplacementError ||
        (reason instanceof MspClientError && reason.code === 'MSP_REMOTE_ERROR')
      ) {
        return;
      }
      this.faultMotorTestLease();
    });
    return promise;
  }

  /**
   * Phase 2G Pass 1 - submit the lease-owned EMERGENCY STOP as the next
   * transport write.
   *
   * Reachable ONLY with the exact live lease token. There is no ordinary
   * caller, no public priority flag on request(), and no way to reach this
   * slot from the FIFO: an ordinary caller is already refused at
   * request()'s exclusivity gate while a lease is held, and without a
   * lease there is nothing to present here.
   *
   * WHAT IT GUARANTEES
   *   1. Every request still sitting in the FIFO is purged immediately,
   *      each rejected exactly once with MSP_DISPLACED_BY_EMERGENCY_STOP.
   *      None of them was ever written, so none of them is ambiguous.
   *   2. If a request is active in AWAITING_RESPONSE, its response timer
   *      is cancelled, it is rejected deterministically, and the active
   *      slot is freed - so the stop starts on the transport in this same
   *      synchronous call.
   *   3. If a request is active in WRITING, its writeBytes() cannot be
   *      cancelled and is NOT raced: the stop is registered, the real
   *      write is allowed to settle, and the stop is started the moment it
   *      does. Two concurrent writeBytes() calls never occur.
   *   4. Repeated triggers join the one registered stop. One stop, one
   *      write.
   *   5. The returned promise always settles. If the engine dies before
   *      submission (desync, close, detach) it REJECTS - never hangs, and
   *      never resolves.
   *
   * WHAT IT DOES NOT GUARANTEE. See MspEmergencyStopDispatch and the
   * Phase 2G block above: submission order only, no on-wire preemption, no
   * latency bound behind an in-flight write, no mechanical confirmation.
   */
  emergencyStopWithMotorTestLease(
    token: unknown,
    command: number,
    payload: Uint8Array,
    options: MspRequestOptions,
  ): MspEmergencyStopDispatch {
    if (!this.isMotorTestLeaseToken(token)) {
      return this.failedStopDispatch(
        new MspMotorTestLeaseBlockedError('MSP_MOTOR_TEST_LEASE_CAPABILITY_INVALID'),
      );
    }

    // Join before touching anything: a second trigger must not purge,
    // displace or write a second time.
    const joinable = this.emergencyStopFrame;
    if (joinable !== undefined) {
      return Object.freeze({
        frame: joinable,
        attributionAmbiguous: this.emergencyStopAttributionAmbiguous,
        deferredBehindActiveWrite: this.emergencyStopDeferredBehindActiveWrite,
        joinedExistingStop: true,
      });
    }

    // Acceptance is checked BEFORE any displacement, so a stop that cannot
    // be submitted at all leaves the engine exactly as it found it rather
    // than destroying in-flight work for nothing. In practice this is
    // unreachable with a valid token - every non-READY transition
    // invalidates or faults the lease first - but a stop path must fail
    // closed on its own evidence, not on another method's invariant.
    const rejectionCode = this.checkAcceptance();
    if (rejectionCode !== undefined) {
      return this.failedStopDispatch(new MspClientError(rejectionCode));
    }

    const stopProtocolVersion = deriveProtocolVersion(options.wireFormat);
    // Recorded BEFORE displacement so quarantineDisplacedResponse() can
    // compare against it, including from the deferred WRITING path.
    this.emergencyStopCommand = command;

    // (1) Purge the FIFO. Confirmed-not-sent, every one of them.
    const purged = this.queue.splice(0, this.queue.length);
    for (const pending of purged) {
      pending.settle.reject(
        new MspMotorTestStopDisplacementError('MSP_DISPLACED_BY_EMERGENCY_STOP', false),
      );
    }

    // (2) Displace the active request, if there is one.
    let attributionAmbiguous = false;
    let deferredBehindActiveWrite = false;
    const active = this.active;
    if (active !== undefined && !active.settle.settled) {
      // The one shape the automatic per-request quarantine cannot cover:
      // a displaced request whose late response is indistinguishable from
      // the stop's own. Computed for BOTH phases - the WRITING request's
      // bytes are already at the transport too.
      attributionAmbiguous =
        active.command === command && active.protocolVersion === stopProtocolVersion;

      if (active.phase === 'AWAITING_RESPONSE') {
        // Its write already settled, so the transport is free RIGHT NOW.
        this.clearRequestTimers(active);
        const won = active.settle.reject(
          new MspMotorTestStopDisplacementError(
            'MSP_DISPLACED_IN_FLIGHT_BY_EMERGENCY_STOP',
            true,
          ),
        );
        if (won && this.active === active) {
          this.active = undefined;
        }
        // Its bytes are already on the wire, so exactly one late response
        // for this command may still arrive. Quarantine it so it can never
        // settle a later request that happens to share the command.
        this.quarantineDisplacedResponse(active.command);
      } else {
        // WRITING. Do NOT settle it here and do NOT start a second write:
        // its writeBytes() promise is still outstanding and the engine's
        // single-flight rule is what keeps the transport coherent. Mark it
        // so onWriteSettled() settles it as displaced and pumps the stop
        // instead of arming a response timer.
        active.displacedByEmergencyStop = true;
        deferredBehindActiveWrite = true;
      }
    }

    // (3) Register the stop in its own slot and pump.
    let settleRef: SettleOnce<MspFrame> | undefined;
    const frame = new Promise<MspFrame>((resolve, reject) => {
      // The executor runs synchronously, so settleRef is assigned before
      // the constructor returns.
      settleRef = new SettleOnce<MspFrame>(resolve, reject);
    });
    const settle = settleRef as SettleOnce<MspFrame>;

    const stop: PendingRequest = {
      command,
      payload,
      wireFormat: options.wireFormat,
      flags: options.flags,
      responseTimeoutMs: options.responseTimeoutMs ?? MSP_RESPONSE_TIMEOUT_MILLIS,
      // NEVER RESENT, whatever the caller asked for. A motor stop is a
      // safety command whose write count is part of its meaning: the
      // attribution contract around it (attributionAmbiguous, the
      // quarantine exemption for emergencyStopCommand) is written for
      // exactly one write, and a second copy would arrive with nothing
      // able to tell the two acknowledgements apart.
      resend: undefined,
      settle,
      isProbe: false,
      isEmergencyStop: true,
    };
    this.emergencyStopPending = stop;
    this.emergencyStopSettle = settle;
    this.emergencyStopFrame = frame;
    this.emergencyStopAttributionAmbiguous = attributionAmbiguous;
    this.emergencyStopDeferredBehindActiveWrite = deferredBehindActiveWrite;

    frame.then(
      () => this.clearEmergencyStopRegistration(settle),
      () => {
        this.clearEmergencyStopRegistration(settle);
        // Same policy as every other lease-scoped request: a failed stop
        // kills the lease and latches the identity. A stop that did not
        // demonstrably complete must never leave a reusable capability
        // behind. A stop that RESOLVES does not fault here - the caller
        // decides, and must fault explicitly when attributionAmbiguous.
        this.faultMotorTestLease();
      },
    );

    this.pump();

    return Object.freeze({
      frame,
      attributionAmbiguous,
      deferredBehindActiveWrite,
      joinedExistingStop: false,
    });
  }

  /** A dispatch whose promise is already rejected. The `catch` keeps a
   * refused stop from surfacing as an unhandled rejection when the caller
   * reads only the synchronous displacement facts. */
  private failedStopDispatch(error: Error): MspEmergencyStopDispatch {
    const frame = Promise.reject<MspFrame>(error);
    frame.catch(() => {
      // Intentionally swallowed - the rejection is still delivered to
      // every real consumer of `frame`; this only suppresses the
      // process-level unhandled-rejection warning.
    });
    return Object.freeze({
      frame,
      attributionAmbiguous: false,
      deferredBehindActiveWrite: false,
      joinedExistingStop: false,
    });
  }

  /**
   * Arms the quarantine for ONE late response of `command`.
   *
   * Called only for a request whose bytes reached the transport. A request
   * purged from the FIFO was never written, has no response coming, and is
   * deliberately not quarantined - swallowing a frame for it would eat a
   * genuine answer belonging to something else.
   */
  private quarantineDisplacedResponse(command: number): void {
    if (command === this.emergencyStopCommand) {
      // Same command as the stop itself: the pre-existing
      // attributionAmbiguous contract owns this case. Quarantining here
      // would swallow the stop's own acknowledgement.
      return;
    }
    this.quarantinedResponses.set(command, (this.quarantinedResponses.get(command) ?? 0) + 1);
  }

  /**
   * Swallows one quarantined late response, if this frame is one.
   *
   * Returns true when the frame was consumed, in which case it settles
   * NOTHING - not the active request, not a stop, not anything.
   */
  private consumeQuarantinedResponse(frame: MspFrame): boolean {
    const remaining = this.quarantinedResponses.get(frame.command);
    if (remaining === undefined || remaining <= 0) {
      return false;
    }
    if (remaining === 1) {
      this.quarantinedResponses.delete(frame.command);
    } else {
      this.quarantinedResponses.set(frame.command, remaining - 1);
    }
    this.emitDiagnostic({ type: 'UNSOLICITED_FRAME', frame });
    return true;
  }

  /** Clears the one-slot register, but only for the stop that actually
   * owns it - a late settle from a superseded stop can never clear a
   * newer registration. */
  private clearEmergencyStopRegistration(settle: SettleOnce<MspFrame>): void {
    if (this.emergencyStopSettle !== settle) {
      return;
    }
    this.emergencyStopSettle = undefined;
    this.emergencyStopFrame = undefined;
    this.emergencyStopPending = undefined;
    this.emergencyStopCommand = undefined;
    this.emergencyStopAttributionAmbiguous = false;
    this.emergencyStopDeferredBehindActiveWrite = false;
    // DELIBERATELY NOT cleared here. The adversarial case this exists for
    // is a displaced request's answer arriving AFTER the stop's own ACK -
    // clearing on stop-settle would disarm the quarantine exactly one
    // moment before the frame it must swallow. It is released only by
    // consumption, or by a session/epoch reset below.
  }

  /**
   * Settles a registered-but-unsubmitted stop when the engine dies under
   * it. Called from every route that tears the engine down. Rejecting is
   * the ONLY correct outcome: the stop was never written, so it must fail
   * closed rather than appear to have been sent.
   */
  private abortRegisteredEmergencyStop(code: MspEmergencyStopAbortCode): void {
    const stop = this.emergencyStopPending;
    if (stop === undefined) {
      return;
    }
    this.emergencyStopPending = undefined;
    stop.settle.reject(new MspEmergencyStopAbortedError(code));
  }

  /**
   * Explicit release, restricted to the exact active token.
   *
   * Refuses while lease-owned work is still active, queued or awaiting
   * write settlement: the lease stays held, the request is neither
   * cancelled nor discarded, and ordinary traffic stays blocked.
   *
   * ABA protection: a token retired by an earlier release can never clear
   * a lease acquired afterwards - it is recognized as already-released
   * and does nothing.
   */
  releaseMotorTestLease(token: unknown): MspMotorTestLeaseReleaseOutcome {
    if (token instanceof MspMotorTestLeaseToken) {
      if (this.invalidatedMotorTestLeaseTokens.has(token)) {
        return {kind: 'INVALIDATED'};
      }
      if (this.retiredMotorTestLeaseTokens.has(token)) {
        return {kind: 'ALREADY_RELEASED'};
      }
    }
    if (!this.isMotorTestLeaseToken(token)) {
      return {kind: 'NOT_OWNER'};
    }
    if (
      this.active !== undefined ||
      this.queue.length > 0 ||
      this.emergencyStopPending !== undefined
    ) {
      // Phase 2G: an emergency stop registered but not yet submitted is
      // the LAST thing a release may discard. The lease stays held and
      // ordinary traffic stays blocked until it settles.
      return {kind: 'LEASE_WORK_UNSETTLED'};
    }
    this.retiredMotorTestLeaseTokens.add(this.motorTestLeaseToken as MspMotorTestLeaseToken);
    this.motorTestLeaseToken = undefined;
    this.motorTestLeaseEpoch = undefined;
    return {kind: 'RELEASED'};
  }

  /**
   * Pass 3: lets the EXACT active lease fault itself after a SEMANTIC
   * failure - one where no request rejected, so the automatic
   * failure route in requestWithMotorTestLease() never fires. The
   * motivating case is an arming-restriction establishment whose ACK and
   * status read both succeeded but whose evidence was unacceptable (FC
   * reported armed, or the required restriction was absent).
   *
   * Reuses the SAME canonical latch as every other fault - it does not
   * introduce a second fault manager. Only the exact live token can
   * trigger it, so a forged, stale, released, invalidated, wrong-client
   * or cross-session capability cannot affect ownership, and an old
   * capability can never fault a newer lease.
   *
   * Returns whether the fault actually took effect.
   */
  faultMotorTestLeaseByToken(token: unknown): boolean {
    if (!this.isMotorTestLeaseToken(token)) {
      return false;
    }
    this.faultMotorTestLease();
    return true;
  }

  /**
   * Kills the active lease without latching a fault. Used for lifecycle
   * ends (close, detach) where the client itself is finished anyway.
   * The token is permanently unusable: no recovery probe returning the
   * client to READY can ever revive it.
   */
  private invalidateMotorTestLease(): void {
    const token = this.motorTestLeaseToken;
    if (token === undefined) {
      return;
    }
    this.invalidatedMotorTestLeaseTokens.add(token);
    this.motorTestLeaseToken = undefined;
    this.motorTestLeaseEpoch = undefined;
  }

  /**
   * Kills the active lease AND latches the fault against the composite
   * identity it was acquired under, so reacquisition is refused until a
   * genuinely new session identity exists. Idempotent.
   *
   * The epoch latched is the lease's OWN acquisition epoch, not whatever
   * the epoch became afterwards: a desync bumps mspEpoch as part of the
   * failure, and latching the post-bump value would wrongly punish the
   * new identity that the established reset mechanism just produced.
   */
  private faultMotorTestLease(): void {
    const epoch = this.motorTestLeaseEpoch;
    if (epoch !== undefined) {
      this.motorTestLeaseFaultEpochs.add(epoch);
    }
    this.invalidateMotorTestLease();
  }

  private checkAcceptance(): MspClientErrorCode | undefined {
    switch (this.state) {
      case 'READY':
        return undefined;
      case 'DESYNCHRONIZED':
      case 'RESTARTING_READER':
      case 'PROBING':
        // DESYNCHRONIZED itself is never actually observable here in
        // practice: triggerDesyncLatch() immediately, synchronously calls
        // startRecovery(), which transitions to RESTARTING_READER before
        // this method (or anything else) can ever run while state is
        // still DESYNCHRONIZED. Kept as an explicit case anyway, for the
        // same "defensive invariant, not relied on to be false" reason
        // handleFrame()'s own already-unreachable branch is kept (see its
        // comment) - not worth losing type-exhaustiveness over.
        return 'MSP_RECOVERING';
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
    // Phase 2G Pass 1: the one place stop priority is expressed. The
    // emergency-stop slot is drained ahead of the FIFO, which is exactly
    // what makes the stop the NEXT transport.writeBytes() invocation this
    // client performs. The single-flight rule above is untouched - this
    // reorders SUBMISSION, it does not overlap writes, and it makes no
    // claim about bytes already handed to the transport.
    const stop = this.emergencyStopPending;
    if (stop !== undefined) {
      this.emergencyStopPending = undefined;
      this.startRequest(stop);
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
      encoded,
      resend: pending.resend,
      resendsLeft: pending.resend?.maxResends ?? 0,
      resendTimer: undefined,
      wasResent: false,
      isProbe: pending.isProbe,
      isEmergencyStop: pending.isEmergencyStop,
      displacedByEmergencyStop: false,
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
      //
      // Pass 6.2b: for the recovery probe (isProbe), desynchronizing here
      // would be a forbidden re-entrant recovery cycle - see sendProbe()'s
      // doc comment - so classifyWriteFailure()/triggerDesyncLatch() are
      // skipped entirely and the probe's own settle.reject() callback (its
      // own guarded RECOVERY_FAILED transition) is used instead.
      if (active.isProbe) {
        const won = active.settle.reject(new Error('MSP recovery probe: writeBytes() threw synchronously'));
        if (won && this.active === active) {
          this.active = undefined;
        }
        return;
      }
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
    if (active.settle.settled) {
      // A matching response settled this request while the transport write
      // was still pending. Its late write resolution OR rejection is
      // diagnostic-only, but this is the first point at which the physical
      // write slot is genuinely free. Release and pump exactly once.
      if (this.active === active) {
        this.active = undefined;
        this.pump();
      }
      return;
    }
    if (failureReason === undefined) {
      if (active.displacedByEmergencyStop) {
        // Phase 2G Pass 1: the uncancellable write has now settled, so the
        // transport is free. Settle this request as displaced INSTEAD of
        // entering AWAITING_RESPONSE - arming its 2000 ms response timer
        // here would make the stop wait out a full response timeout for a
        // request nobody is waiting on any more. Its late response, if one
        // ever arrives, is quarantined automatically: handleFrame() only
        // matches `this.active`, and this request is no longer it.
        const wonDisplaced = active.settle.reject(
          new MspMotorTestStopDisplacementError(
            'MSP_DISPLACED_IN_FLIGHT_BY_EMERGENCY_STOP',
            true,
          ),
        );
        if (wonDisplaced && this.active === active) {
          this.active = undefined;
        }
        // Same reasoning as the AWAITING_RESPONSE branch: this request's
        // bytes reached the transport, so its late response must never be
        // allowed to settle a later same-command request.
        this.quarantineDisplacedResponse(active.command);
        // Frees the slot for the registered stop, which pump() takes ahead
        // of the FIFO. This is the moment the stop becomes the next
        // transport submission.
        this.pump();
        return;
      }
      active.phase = 'AWAITING_RESPONSE';
      active.timer = setTimeout(() => this.onResponseTimeout(active), active.responseTimeoutMs);
      this.armResend(active);
      return;
    }

    if (active.isProbe) {
      // Pass 6.2b: see startRequest()'s writeBytes() catch above for why
      // classifyWriteFailure()/triggerDesyncLatch() must never run for the
      // probe - its own settle.reject() callback does the guarded
      // RECOVERY_FAILED transition instead.
      const wonProbe = active.settle.reject(failureReason);
      if (wonProbe && this.active === active) {
        this.active = undefined;
      }
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

  /**
   * Betaflight's `MSP.send_message` resend timer, transcribed.
   *
   * Arms only in AWAITING_RESPONSE (this request's own write has already
   * settled, so nothing is in flight) and writes the SAME bytes again.
   * The pending request is deliberately left completely alone: not
   * rejected, not dequeued, not reported - exactly as Betaflight leaves
   * its queued callback alone. Only the overall response timeout, or a
   * matching response, ends the request.
   */
  private armResend(active: ActiveRequest): void {
    const policy = active.resend;
    if (policy === undefined || active.resendsLeft <= 0) {
      return;
    }
    active.resendTimer = setTimeout(() => {
      active.resendTimer = undefined;
      // Every reason not to write: the request is over, the slot moved on,
      // or the client is no longer in a state where writing is meaningful.
      if (
        active.settle.settled ||
        this.active !== active ||
        active.phase !== 'AWAITING_RESPONSE' ||
        this.state !== 'READY'
      ) {
        return;
      }
      active.resendsLeft -= 1;
      active.wasResent = true;
      try {
        // Fire and forget, like Betaflight. A resend that fails to write
        // is not a request failure: the original write may still be
        // answered, and the response timeout remains the single authority
        // on when this request is actually over. Rejecting here would
        // convert a harmless retry into the very failure the retry exists
        // to prevent.
        this.transport.writeBytes(active.encoded).catch(() => undefined);
      } catch {
        // A non-conforming transport that throws synchronously is treated
        // identically - the resend is best-effort by construction.
      }
      this.armResend(active);
    }, policy.intervalMs);
  }

  /** Clears both of a request's timers. Every exit path uses this so a
   * resend can never outlive the request that armed it. */
  private clearRequestTimers(active: ActiveRequest): void {
    if (active.timer !== undefined) {
      clearTimeout(active.timer);
      active.timer = undefined;
    }
    if (active.resendTimer !== undefined) {
      clearTimeout(active.resendTimer);
      active.resendTimer = undefined;
    }
  }

  private onResponseTimeout(active: ActiveRequest): void {
    this.clearRequestTimers(active);
    if (active.isProbe) {
      // Pass 6.2b: same isProbe branching as onWriteSettled() above - a
      // probe response timeout must never call triggerDesyncLatch().
      const wonProbe = active.settle.reject(new Error('MSP recovery probe: response timeout'));
      if (wonProbe && this.active === active) {
        this.active = undefined;
      }
      return;
    }

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
    // R5: a quarantined late response is swallowed BEFORE any matching is
    // attempted. Placing it here - rather than after the match - is the
    // whole point: by the time `matches` is computed, a same-command frame
    // is already indistinguishable from a genuine one.
    if (this.consumeQuarantinedResponse(frame)) {
      return;
    }
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

    this.clearRequestTimers(active);

    let won: boolean;
    if (frame.direction === 'error' && active.isProbe) {
      // Pass 6.2b correction: a correctly-matched '!' frame for the probe
      // still proves the byte stream is genuinely resynchronized - the
      // physical link is readable and correctly framed again, regardless
      // of whether the FC's answer was itself a semantic error for
      // MSP_PROBE_COMMAND. That is the actual recovery criterion ("is
      // communication working again"), not "did this specific probe
      // command succeed" - so this is probe SUCCESS, unlike a normal
      // request's own MSP_REMOTE_ERROR rejection below (unaffected).
      // MSP_TIMEOUT and a probe write failure remain probe FAILURE - see
      // onResponseTimeout()/onWriteSettled()'s isProbe branches, both
      // still routed through settle.reject() untouched by this change.
      won = active.settle.resolve(frame);
    } else if (frame.direction === 'error') {
      won = active.settle.reject(new MspClientError('MSP_REMOTE_ERROR', frame));
    } else {
      won = active.settle.resolve(frame);
    }

    if (!won) {
      // Not reachable given the `!active.settle.settled` check above (JS is
      // single-threaded; nothing else can settle it between that check and
      // here) - kept as a defensive invariant, not relied on to be false.
      return;
    }
    // A REQUEST THAT WAS ASKED TWICE CAN BE ANSWERED TWICE.
    //
    // Betaflight tolerates this by accident: its callback is spliced out
    // of the queue on the first answer, so the duplicate finds no callback
    // and is dropped. This client matches on (command, protocolVersion)
    // against whatever is active NOW, so a duplicate arriving later could
    // settle a LATER request for the same command with a stale payload.
    // One quarantine slot per extra write closes that for good - and it is
    // armed on success as well as on failure, because success is exactly
    // when the duplicate is still on its way.
    const duplicatesInFlight = active.resend === undefined
      ? 0
      : active.resend.maxResends - active.resendsLeft;
    for (let i = 0; i < duplicatesInFlight; i += 1) {
      this.quarantineDisplacedResponse(active.command);
    }

    if (active.phase === 'WRITING') {
      // The response won before the transport write settled. The caller's
      // result is final, but the transport slot is not: onWriteSettled()
      // performs the release/pump once the write Promise genuinely ends.
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
    // Pass 2: desynchronization is exactly the ambiguity a lease must not
    // survive. Faulted (not merely invalidated) and latched against the
    // acquisition epoch BEFORE mspEpoch is bumped below, so the latch
    // lands on the identity that failed - and the new identity the bump
    // produces is free to be leased again. Recovery returning the client
    // to READY never revives the dead capability.
    this.faultMotorTestLease();

    // Phase 2G Pass 1: a stop registered but never submitted dies with the
    // session it belonged to. It rejects (never resolves, never hangs), the
    // lease is already faulted above and the epoch is latched below, so
    // reacquisition on this identity is refused and a full session reset is
    // required before any further stop attempt.
    this.abortRegisteredEmergencyStop('MSP_EMERGENCY_STOP_ABORTED_BY_DESYNC');

    // The epoch rotates here, so nothing written under the old identity can
    // still be answered under the new one. Carrying the quarantine across
    // would swallow a genuine frame belonging to a different session.
    this.quarantinedResponses.clear();

    const rejectedQueue = this.queue.splice(0, this.queue.length);
    for (const pending of rejectedQueue) {
      // MSP_RECOVERING, not MSP_RECOVERY_REQUIRED: per Pass 6.2b's updated
      // acceptance table, MSP_RECOVERY_REQUIRED is now reserved for the
      // terminal RECOVERY_FAILED state ("permanent, user action needed").
      // At the moment this latch fires, recovery hasn't even started yet
      // (startRecovery() runs at the end of this same method) - telling
      // the caller "recovering, retry shortly" is the accurate signal.
      pending.settle.reject(new MspClientError('MSP_RECOVERING'));
    }
    this.mspEpoch += 1;
    this.setState('DESYNCHRONIZED');

    // Recovery begins automatically and immediately, in this same
    // synchronous call - see the class-level Pass 6.2b doc comment and
    // startRecovery()'s own note on why DESYNCHRONIZED is never externally
    // observable as a distinct tick.
    this.startRecovery(this.mspEpoch);
  }

  /**
   * Pass 6.2b: begins immediately, synchronously, from within
   * triggerDesyncLatch() - the same tick DESYNCHRONIZED is set - so that
   * state is never externally observable as a distinct tick from
   * RESTARTING_READER. `epoch` is captured once by the caller
   * (triggerDesyncLatch(), as `this.mspEpoch` immediately after
   * incrementing it) and threaded through every subsequent step;
   * isCurrentRecoveryAttempt(epoch) is checked before every transition
   * below so a second desync, a physical detach, or dispose() that starts
   * a newer attempt - or ends this instance entirely - silently retires
   * this attempt's remaining async work instead of racing it.
   */
  private startRecovery(epoch: number): void {
    if (!this.isCurrentRecoveryAttempt(epoch)) {
      return;
    }
    this.setState('RESTARTING_READER');

    let restartPromise: Promise<void>;
    try {
      restartPromise = this.transport.restartReceiveLoop();
    } catch {
      // Same "external dependency call can throw synchronously" guard
      // already applied to encode()/writeBytes() in the prior audit sweep
      // - restartReceiveLoop() is documented (mspTransport.ts) to always
      // return a Promise<void>, but a non-conforming transport throwing
      // here must not go unhandled.
      if (this.isCurrentRecoveryAttempt(epoch)) {
        this.setState('RECOVERY_FAILED');
      }
      return;
    }

    restartPromise.then(
      () => {
        if (!this.isCurrentRecoveryAttempt(epoch)) {
          return;
        }
        this.sendProbe(epoch);
      },
      () => {
        // Reason not inspected further - see mspTransport.ts's
        // restartReceiveLoop() doc comment.
        if (this.isCurrentRecoveryAttempt(epoch)) {
          this.setState('RECOVERY_FAILED');
        }
      },
    );
  }

  /**
   * Sends exactly one probe request as part of Pass 6.2b recovery, reusing
   * startRequest()'s entire encode -> write -> (write-vs-response race) ->
   * response-match pipeline verbatim - including both audit-sweep
   * exception guards - by constructing an ordinary PendingRequest tagged
   * `isProbe: true` and calling startRequest() directly. This deliberately
   * bypasses pump()'s FIFO queue and READY-state gate: the probe is not a
   * queued user request.
   *
   * Success is any correctly matched frame - RESPONSE-direction OR
   * ERROR-direction - and transitions to READY via this method's own
   * `settle` resolve callback below: a matched frame of either direction
   * proves the byte stream is genuinely resynchronized (the link is
   * readable and correctly framed again), which is the actual recovery
   * criterion, not whether the FC's answer was itself a semantic success
   * for MSP_PROBE_COMMAND specifically. See handleFrame()'s own isProbe
   * branch for where this is decided. Only a write failure or a response
   * timeout - genuinely nothing matched at all - end the probe as a
   * failure, transitioning directly to RECOVERY_FAILED via the reject
   * callback; neither goes through classifyWriteFailure()/
   * triggerDesyncLatch() (see the isProbe branches in
   * startRequest()/onWriteSettled()/onResponseTimeout()), since that would
   * increment mspEpoch and re-enter DESYNCHRONIZED - a forbidden
   * re-entrant recovery cycle.
   */
  private sendProbe(epoch: number): void {
    if (!this.isCurrentRecoveryAttempt(epoch)) {
      return;
    }
    this.setState('PROBING');

    const settle = new SettleOnce<MspFrame>(
      () => {
        if (this.isCurrentRecoveryAttempt(epoch)) {
          this.setState('READY');
        }
      },
      () => {
        if (this.isCurrentRecoveryAttempt(epoch)) {
          this.setState('RECOVERY_FAILED');
        }
      },
    );

    const pending: PendingRequest = {
      command: MSP_PROBE_COMMAND,
      payload: MSP_PROBE_PAYLOAD,
      wireFormat: MSP_PROBE_WIRE_FORMAT,
      responseTimeoutMs: MSP_PROBE_TIMEOUT_MILLIS,
      // The recovery probe is its own retry mechanism; resending it would
      // nest one retry policy inside another.
      resend: undefined,
      settle,
      isProbe: true,
      isEmergencyStop: false,
    };

    this.startRequest(pending);
  }

  /**
   * Guards every Pass 6.2b recovery transition/action, checked immediately
   * before each one rather than only after an await resolves. `epoch` is
   * the value `this.mspEpoch` held at the moment this specific recovery
   * attempt began (captured once, in triggerDesyncLatch()); the attempt is
   * still "current" only while nothing else has superseded it - no newer
   * desync (this.mspEpoch has since changed) and no terminal transition
   * that ends the instance outright (DISCONNECTED via physical detach, or
   * CLOSING/DISCONNECTED via dispose()).
   *
   * This project's own review (Pass 6.2b) found exactly one interleaving
   * this guard defends against that is NOT actually reachable under this
   * implementation: a second desync firing while an earlier attempt's own
   * async work (restartReceiveLoop() or the probe) is still outstanding.
   * That can't happen here because only one MspClient-level "active
   * request" slot ever exists, no normal (non-probe) request occupies it
   * during RESTARTING_READER (this.active is undefined) or PROBING (the
   * only active request is the probe, whose own failures are deliberately
   * routed away from triggerDesyncLatch() - see sendProbe()'s doc
   * comment), and RECOVERY_FAILED rejects every new request() outright.
   * The guard is kept exactly as specified regardless - it is still
   * exercised by, and correctly resolves, physical detach and dispose()
   * racing a pending recovery step, and it costs nothing to keep for
   * whatever a future pass (recovery retries, a different trigger source)
   * might add.
   */
  private isCurrentRecoveryAttempt(epoch: number): boolean {
    return this.state !== 'DISCONNECTED' && this.state !== 'CLOSING' && this.mspEpoch === epoch;
  }

  private handlePhysicalDetach(): void {
    const code: MspClientErrorCode = 'MSP_DEVICE_DETACHED';
    // Pass 2: USB detach ends ownership immediately, before anything else
    // in this method can settle a lease-owned request.
    this.invalidateMotorTestLease();
    this.disconnectCause = code;
    // Set BEFORE rejecting active/queued below (not after, as a naive
    // ordering might do) - isCurrentRecoveryAttempt(), called synchronously
    // from within a probe's own settle.reject() callback triggered by the
    // active.settle.reject() call just below, must already see
    // DISCONNECTED and abandon silently, rather than transiently (even if
    // harmlessly, since nothing observes it in between) writing
    // RECOVERY_FAILED only to have this method immediately overwrite it.
    this.setState('DISCONNECTED');

    const active = this.active;
    if (active !== undefined) {
      this.clearRequestTimers(active);
      active.settle.reject(new MspClientError(code));
      this.active = undefined;
    }

    this.abortRegisteredEmergencyStop('MSP_EMERGENCY_STOP_ABORTED_BY_SESSION_END');
    this.quarantinedResponses.clear();

    const rejectedQueue = this.queue.splice(0, this.queue.length);
    for (const pending of rejectedQueue) {
      pending.settle.reject(new MspClientError(code));
    }
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
