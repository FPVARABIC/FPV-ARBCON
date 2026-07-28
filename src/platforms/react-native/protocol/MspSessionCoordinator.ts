/**
 * Session-lifecycle coordinator (Pass 6.3 Step 2; Pass 6.4b adds ownership/
 * identification state) - owns the pairing of one RNMspTransport with one
 * MspClient per open physical session, AND (Pass 6.4b) owns running MSP
 * identification against that pairing automatically once it activates. NOT
 * owned by any screen: a module-level singleton, mirroring
 * usbSerialTransportClient's own established precedent (see
 * UsbSerialTransportClient.ts) - this codebase has no React Context usage
 * and no generic event-emitter/pub-sub pattern for cross-cutting state, so
 * a singleton is the only choice consistent with existing precedent.
 *
 * Call openSession() once a session is confirmed successfully open (the
 * hook point is UsbConnectionScreen.tsx's handleConnect(), immediately
 * after client.openDevice() resolves and CONNECT_SUCCESS is dispatched -
 * that is the only place a sessionId ever becomes known). Call
 * deactivateMspSession() for an intentional close (handleDisconnect()'s
 * success path, BEFORE DISCONNECT_SUCCESS dispatches). Physical detach
 * needs no explicit call from any screen at all: openSession() below
 * registers its own independent listener directly on the created
 * RNMspTransport (a second listener alongside MspClient's own internal
 * one, per Pass 6.3 Step 1's multi-listener support) that drives teardown
 * automatically the moment the transport reports the detach.
 *
 * Dispose ordering on every teardown path (intentional deactivate OR
 * physical detach): MspClient.dispose() FIRST, THEN RNMspTransport.dispose()
 * - MspClient.dispose() only removes MspClient's own two listeners from the
 * transport's internal Sets (via the unsubscribe functions the transport
 * returned to it); it does nothing to the transport's one real underlying
 * subscription, nothing to any other independently-registered listener
 * (the debug panel's own monitor - Pass 6.3 Step 3), and nothing to guard
 * the transport's writeBytes()/restartReceiveLoop() against further use.
 * RNMspTransport.dispose() is the only call that does all three - running
 * it first would fully kill the transport out from under MspClient while
 * MspClient's own state/API has not yet been updated to reflect that.
 *
 * PASS 6.4b - OWNERSHIP LIFECYCLE: a session's ownership state
 * (MspSessionOwnershipState) is tracked SEPARATELY from the `sessions` map
 * entry itself - ACTIVATING is set BEFORE any construction is attempted
 * (closing the race window where a consumer's mspActive-derived guard,
 * e.g. the debug panel's mspActiveRef, could otherwise run concurrently
 * with construction), so the ownership Map can report ACTIVATING for a
 * sessionId that has no `sessions` entry yet at all. Only once
 * construction genuinely succeeds is an entry committed and ownership
 * advanced to ACTIVE; a construction failure reverts ownership straight
 * back to INACTIVE with nothing ever committed - see openSession()'s own
 * doc comment for the exact sequence.
 *
 * PASS 6.4b - IDENTIFICATION IS A SEPARATE, INDEPENDENT AXIS from
 * ownership: MspIdentificationService.identify() (Pass 6.4a, unmodified)
 * is started fire-and-forget the moment ownership reaches ACTIVE, and its
 * eventual outcome (SUCCEEDED/FAILED) never touches ownership state either
 * way - ownership only ever cares about "is the transport/client pairing
 * alive", identification only ever cares about "do we know what firmware
 * this is yet". Every in-flight identify() attempt is tagged with a
 * generation token (mirrors mspClient.ts's own isCurrentRecoveryAttempt()
 * epoch-guard pattern exactly): if the session is torn down (deactivated
 * or physically detached) before identify() settles, the late result is
 * silently discarded rather than being recorded against a session that no
 * longer exists.
 */

import {
  MspClient,
  MspClientError,
  MspIdentificationService,
  MSP_ATTITUDE,
  MSP_BATTERY_STATE,
  MSP_ANALOG,
  MSP_RAW_GPS,
  MSP_STATUS_EX,
  MspPayloadReadError,
  decodeAttitude,
  decodeBatteryState,
  decodeAnalog,
  decodeRawGps,
  decodeStatusExDiagnostics,
} from '../../../core';
// Phase 2E (P4). The motor-test telemetry anchor and every scheduler that
// joins it are minted from ONE captured MspClient reference by this
// binding. The coordinator no longer constructs a scheduler directly, so
// there is no production path that could pair an anchor with a different
// client. Deep import on purpose: the motor-test modules stay out of
// `src/core`'s public barrel.
import {MotorTestTelemetryRegistry} from '../../../core/protocol/telemetry/motorTestTelemetryBarrier';
import {createMotorTestSessionBinding} from './motorTestSessionBinding';
import type {MotorTestSessionCapability} from './motorTestSessionBinding';
import type {
  FlightControllerIdentity,
  MspRequester,
  MspTelemetryScheduler,
  MspAttitude,
  MspBatteryState,
  MspClientState,
  TelemetryValue,
} from '../../../core';
import type {UsbSerialTransportClient} from '../transport';
import {RNMspTransport} from './RNMspTransport';
import {createBatteryDebugLogger} from './batteryDebugLog';
import type {BatteryDebugLogger} from './batteryDebugLog';
import {createAuxTelemetryDebugLogger} from './auxTelemetryDebugLog';
import type {AuxTelemetryDebugLogger} from './auxTelemetryDebugLog';

/** Pass 7.4: the one MSP_ATTITUDE poll every session's real
 * MspTelemetryScheduler registers - a stable exported id so the UI layer
 * (useTelemetryValue() consumers) never duplicates this string. */
export const ATTITUDE_TELEMETRY_POLL_ID = 'attitude';

/** Confirmed real-hardware ceiling (Pass 7.0, Betaflight STM32F405,
 * medianRtt=224ms across two separate runs) - NOT a 100ms/10Hz
 * placeholder. */
const ATTITUDE_POLL_INTERVAL_MS = 220;

/** ~3x the poll interval - tolerates a couple of missed cycles (e.g. one
 * Pass 6.2b desync/recovery pause) without immediately flipping the UI
 * to STALE, while still being short enough that genuinely stopped data
 * is flagged within roughly a second, not several. */
const ATTITUDE_POLL_STALE_AFTER_MS = 700;

/** How often the real tick() driver below fires - well under
 * ATTITUDE_POLL_INTERVAL_MS (Pass 7.2's own tick() is a safe, cheap
 * no-op when nothing is due, per that pass's own design). */
const TELEMETRY_TICK_INTERVAL_MS = 50;

/**
 * Pass 7.4, Step 3: RESERVED poll ids for a future pass's real armed-flag
 * / arming-blockers decoders - deliberately NEVER registered by
 * startTelemetry() in this pass (no real MSP decoder for either exists
 * yet). Exported now so SafetyStrip.tsx's useTelemetryValue() calls use
 * the exact same id string a future registerPoll() call will use, with
 * ZERO changes to the strip's own rendering logic once that pass lands -
 * a real, intentional placeholder, not a stub to be swapped out later.
 * Until then, useTelemetryValue() naturally returns {status:
 * 'UNAVAILABLE'} for these ids through the SAME real mechanism
 * ATTITUDE_TELEMETRY_POLL_ID itself relies on when no scheduler exists
 * yet (MspTelemetryScheduler.getValue() returns UNAVAILABLE_VALUE for
 * any poll id nothing ever registered) - no special-casing needed
 * anywhere in this file or in SafetyStrip.tsx.
 */
export const ARMED_TELEMETRY_POLL_ID = 'armed';
export const ARMING_BLOCKERS_TELEMETRY_POLL_ID = 'armingBlockers';

/** Pass 7.6a: the MSP_BATTERY_STATE poll - registered ONLY after
 * identification SUCCEEDS with knownFamily 'BETAFLIGHT' (see
 * beginIdentification()'s finish()), because the 11-byte payload contract
 * was verified against Betaflight source exclusively (mspCommandSources.ts).
 * Before identification settles, and for FAILED / INAV / EMUFLIGHT /
 * UNKNOWN outcomes, nothing registers this id, so useTelemetryValue()
 * reports UNAVAILABLE through the exact same mechanism the reserved
 * arming ids above already rely on - honest absence, never fabricated
 * telemetry. */
export const BATTERY_TELEMETRY_POLL_ID = 'battery';

/** Pass 7.6a - deliberately conservative (a BINDING product correction,
 * not a guess): Pass 7.0 measured the serialized MSP queue's real
 * capacity at ~4.54 successful requests/s with attitude alone already
 * demanding ~4.55/s at its 220ms cadence - there is NO demonstrated
 * spare 1-req/s headroom. Battery data changes slowly; 3000ms bounds the
 * added demand to ~0.33 req/s (~7%), the first poll is still immediately
 * due at registration (registerPoll() marks dueAtMs=now), and later
 * changes surface within ~3s. Perceptual impact on attitude smoothness
 * is checked on hardware in Pass 7.6b. */
const BATTERY_POLL_INTERVAL_MS = 3000;

/** 3x the poll interval - same missed-cycles tolerance ratio the
 * attitude poll's own stale threshold uses (220ms -> 700ms). */
const BATTERY_POLL_STALE_AFTER_MS = 9000;

/** Strictly below attitude's priority 0: the scheduler's overdue-ratio
 * fairness already prevents a slow poll from starving a fast one
 * (MspTelemetryScheduler.ts's own selection model); this only settles
 * EXACT ratio ties in attitude's favor. */
const BATTERY_POLL_PRIORITY = -1;

/**
 * Pass 7.6c: the three auxiliary Region 3 polls - Betaflight-gated exactly
 * like battery, registered in the SAME identification finish(). All three
 * are deliberately slow (the ~224ms serialized link has no spare fast-
 * cadence headroom - see BATTERY_POLL_INTERVAL_MS's own capacity note),
 * phase-staggered so they can never all become due in one startup burst,
 * and strictly below battery's priority so exact overdue-ratio ties
 * resolve toward the older channels. The scheduler runs in singleFlight
 * mode (one outstanding telemetry dispatch, ever - see
 * MspTelemetrySchedulerOptions.singleFlight).
 */
export const RECEIVER_TELEMETRY_POLL_ID = 'receiver';
export const GPS_TELEMETRY_POLL_ID = 'gps';
export const FC_STATUS_TELEMETRY_POLL_ID = 'fcStatus';

const RECEIVER_POLL_INTERVAL_MS = 4000;
const RECEIVER_POLL_STALE_AFTER_MS = 12000;
const RECEIVER_POLL_PRIORITY = -2;
const RECEIVER_POLL_INITIAL_DELAY_MS = 700;

const GPS_POLL_INTERVAL_MS = 5000;
const GPS_POLL_STALE_AFTER_MS = 15000;
const GPS_POLL_PRIORITY = -3;
const GPS_POLL_INITIAL_DELAY_MS = 1400;

const FC_STATUS_POLL_INTERVAL_MS = 8000;
const FC_STATUS_POLL_STALE_AFTER_MS = 24000;
const FC_STATUS_POLL_PRIORITY = -4;
const FC_STATUS_POLL_INITIAL_DELAY_MS = 2100;

/** Pass 7.6c circuit breaker: consecutive post-success NON-TIMEOUT
 * failures (fast-settling rejections that never hold the serialized
 * link) before a channel is disabled for the rest of the physical
 * session ("bounded recovery, never an unbounded retry loop"). A
 * response TIMEOUT is handled separately and more strictly - a single
 * MSP_TIMEOUT disables the channel immediately (closure correction; see
 * the supervisor's classification in registerAuxTelemetry()). */
const AUX_MAX_CONSECUTIVE_ERRORS_AFTER_SUCCESS = 10;

/** Per-channel lifecycle verdict for the CURRENT physical session. A new
 * physical session (new generation) probes capabilities again from
 * scratch. 'ACTIVE' is also returned for sessions where the channel never
 * registered (non-Betaflight) - the poll id simply reads UNAVAILABLE
 * through the normal scheduler mechanism there. */
export type AuxTelemetryChannelState = 'ACTIVE' | 'UNSUPPORTED' | 'DECODE_FAILED' | 'DISABLED';

export type MspSessionOwnershipState = 'INACTIVE' | 'ACTIVATING' | 'ACTIVE' | 'CLOSING';

export type MspIdentificationState =
  | {status: 'IDLE'}
  | {status: 'RUNNING'}
  | {status: 'SUCCEEDED'; identity: FlightControllerIdentity}
  | {status: 'FAILED'; error: unknown};

/** Pass 7.1 bugfix: getIdentificationState()'s own "no entry" fallback,
 * below - a single stable reference, not a fresh {status: 'IDLE'} object
 * literal per call. useMspIdentificationState() (useMspSessionState.ts)
 * wraps this in useSyncExternalStore(), whose contract requires repeated
 * getSnapshot() calls to return a referentially-STABLE value when nothing
 * has actually changed; a fresh object every call broke that contract for
 * any sessionId with no active entry (e.g. once a session is torn down
 * while UsbSerialDebugPanel - Pass 5.3 - is still mounted, exactly what
 * Pass 7.1's own "Setup has focus while the session goes INACTIVE"
 * scenario produces), which surfaced as a real
 * "Maximum update depth exceeded" crash under enough render pressure. */
const IDLE_IDENTIFICATION_STATE: MspIdentificationState = {status: 'IDLE'};

export type MspIdentificationMetrics = {
  startedAtMs: number;
  completedAtMs?: number;
  durationMs?: number;
  /** Count of underlying UsbSerialTransportClient.onDataReceived events
   * observed while identify() was in flight - one per native chunk, NOT
   * one per MSP frame (a chunk may contain a partial frame, multiple
   * frames, or leftover bytes from a previous chunk). */
  nativeChunkCount: number;
  /** Sum of decoded byte lengths across those same native chunks. */
  receivedByteCount: number;
  /** Every fully-parsed MSP frame observed during the window: identify()'s
   * own successful request/response round trips, PLUS any UNSOLICITED_FRAME
   * MspClient reports via onDiagnostic() (a correctly-framed byte sequence
   * that did not match the currently active request). */
  completedFrameCount: number;
  /** MspClient's own PARSER_DIAGNOSTIC onDiagnostic() events during the
   * window - stream-parser-level noise (e.g. a bad checksum, unexpected
   * bytes) distinct from a fully-completed frame either way. */
  diagnosticCount: number;
};

export type MspSessionCoordinatorUnsubscribe = () => void;

/** Pass 7.1: a composite identity for one activation of one sessionId,
 * exposed via getSessionKey() so UI-only state (SetupUiSessionStore) and
 * navigation (the Setup screen's route params) can distinguish a genuinely
 * new FC session from a same-physical-session MSP-level recovery, even when
 * the native sessionId string happens to be reused (see the existing
 * "reused sessionId" tests in MspSessionCoordinator.test.ts for why that
 * reuse is a real, already-tested scenario). The raw generation number
 * itself is deliberately not exposed anywhere else. */
export type SetupUiSessionKey = {
  sessionId: string;
  generation: number;
};

/** Thrown by openSession() ONLY when constructing the RNMspTransport/
 * MspClient pairing itself throws (Step 3.3) - the ONE failure mode
 * UsbConnectionScreen.tsx's handleConnect() should treat as a genuine
 * USB-connection-level failure, the same way an openDevice() rejection
 * already is. Never thrown for anything identify() does afterward -
 * identification failure is a separate, non-fatal axis (see the class
 * doc comment) surfaced via getIdentificationState(), not by throwing. */
export class MspOwnershipActivationError extends Error {
  readonly sessionId: string;
  readonly originalError: unknown;

  constructor(sessionId: string, originalError: unknown) {
    super(
      `Failed to activate MSP ownership for session ${sessionId}: ` +
        `${originalError instanceof Error ? originalError.message : String(originalError)}`,
    );
    this.name = 'MspOwnershipActivationError';
    this.sessionId = sessionId;
    this.originalError = originalError;
  }
}

interface SessionEntry {
  transport: RNMspTransport;
  mspClient: MspClient;
  /** This activation attempt's generation token. Set to
   * INVALIDATED_GENERATION the instant teardown begins (before mspClient/
   * transport.dispose() run) so a same-tick isCurrentGeneration() check
   * already sees it as stale, even though the entry itself is only removed
   * from `sessions` a step later - see deactivateMspSession()'s own doc
   * comment for why these are deliberately two separate steps. */
  generation: number;
  identification: MspIdentificationState;
  metrics: MspIdentificationMetrics | undefined;
  /** Pass 7.4: undefined until startTelemetry() runs (the same
   * startReading()-confirmed point beginIdentification() itself starts
   * from - see startTelemetry()'s own doc comment for why that point,
   * not the earlier synchronous ownership->ACTIVE flip, is what "once
   * ownership reaches ACTIVE" means here). */
  telemetryScheduler: MspTelemetryScheduler | undefined;
  /** Phase 2E (P4): the authoritative motor-test capability for THIS
   * entry's exact mspClient. Created alongside the scheduler in
   * startTelemetry() and closed in stopTelemetry(), so an anchor can never
   * outlive the client it names. */
  motorTestSession: MotorTestSessionCapability | undefined;
  tickIntervalHandle: ReturnType<typeof setInterval> | undefined;
  /** Pass 7.4, Step 4: unsubscribes this entry's own forwarding listener
   * from mspClient.subscribe() - see notifyMspRecoveryState()'s own doc
   * comment for why calling this during teardown is a deliberate
   * consistency choice, not something GC correctness actually requires. */
  mspClientStateUnsubscribe: () => void;
  /** Pass 7.6b: debug-build-only battery observability (batteryDebugLog.ts)
   * - set only when the battery poll actually registers, so teardown can
   * emit its bounded stop line. undefined for every non-Betaflight /
   * unidentified session. */
  batteryDebugLog: BatteryDebugLogger | undefined;
  /** Pass 7.7 - battery timeout latch (last-known-value retention): set
   * ONLY when the one-strike battery timeout breaker fires. If a real
   * value existed before the timeout it is retained here as a FROZEN
   * STALE snapshot (truthfully "no longer updating" - the DISABLED
   * channel verdict plus the stale label carry that meaning); with no
   * prior value it is a truthful ERROR read-timeout state. NEVER a
   * fabricated zero payload, never "not detected", never UNSUPPORTED. A
   * new physical generation starts a fresh entry, so this can never leak
   * across generations. */
  batteryLatchedValue: TelemetryValue<MspBatteryState> | undefined;
  /** Pass 7.6c: per-channel circuit-breaker verdicts + supervisor
   * tracking for the auxiliary Region 3 polls; empty/undefined for
   * non-Betaflight sessions. */
  auxChannelStates: Map<string, AuxTelemetryChannelState>;
  auxUnregisterFns: Map<string, () => void>;
  auxDebugLog: AuxTelemetryDebugLogger | undefined;
}

/** Never a real generation number (generationCounter starts at 1 and only
 * ever increments) - a session's generation is set to this the instant its
 * teardown begins, so isCurrentGeneration() reads false immediately. */
const INVALIDATED_GENERATION = -1;

/**
 * CI-hang investigation fix: startTelemetry()'s real setInterval() (below)
 * keeps Node's event loop alive by default for as long as it exists - if
 * something else (a missed deactivateMspSession()/detach, most commonly
 * an incomplete test) leaves it running, the owning process cannot exit
 * naturally. .unref() is the standard Node fix, but it is NOT safe to
 * call unconditionally here: this exact code also runs for real on a
 * physical Android device via Hermes/React Native's own JS runtime, not
 * Node.
 *
 * VERIFIED, NOT ASSUMED: this project's own tsc configuration (tsconfig.json
 * -> @react-native/typescript-config's "types": ["jest"] excludes
 * @types/node's ambient globals; "lib" excludes "dom" too) resolves
 * setInterval()'s return type to plain `number`, sourced from React
 * Native's OWN type declarations (node_modules/react-native/src/types/
 * globals.d.ts: `function setInterval(...): number`) - matching Hermes'
 * real runtime behavior (a plain numeric handle, browser-style, never a
 * NodeJS.Timeout object). Calling .unref() on that would not even
 * compile as a plain, typed call; casting past the type system to force
 * it would compile but throw "unref is not a function" the instant this
 * runs on a real device - a severe regression, not a theoretical one.
 *
 * Under Jest, by contrast, this code actually executes on a real Node.js
 * process at runtime (regardless of what RN's own .d.ts says at compile
 * time), where setInterval() genuinely does return a Timeout object with
 * a real .unref(). This guard calls it only when it is actually present
 * at runtime - true under Jest/Node, safely absent (a no-op) on real RN/
 * Hermes. Does not affect tick()'s own firing behavior at all - it only
 * changes whether this handle can block process exit.
 */
function unrefIfSupported(handle: unknown): void {
  const maybeUnrefable = handle as {unref?: () => void};
  if (typeof maybeUnrefable.unref === 'function') {
    maybeUnrefable.unref();
  }
}

export class MspSessionCoordinator {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly ownershipStates = new Map<string, MspSessionOwnershipState>();
  private readonly ownershipListeners = new Set<() => void>();
  private readonly auxTelemetryListeners = new Set<() => void>();
  private readonly identificationListeners = new Set<() => void>();
  /** Pass 7.4: a THIRD, dedicated axis alongside ownership/identification
   * - see startTelemetry()'s own doc comment for why this could not
   * reuse ownershipListeners. */
  private readonly telemetryAvailabilityListeners = new Set<() => void>();
  /** Pass 7.4, Step 4: a FOURTH dedicated axis - forwards MspClient's own
   * subscribe() (per-instance, per-sessionId) into one coordinator-wide
   * axis, the same "broad notify, narrow-in-getSnapshot" shape as the
   * other three. */
  private readonly mspRecoveryStateListeners = new Set<() => void>();
  private generationCounter = 0;
  /** Phase 2E (P4): one coordinator-wide motor-test telemetry registry.
   * Every anchor in the application is minted here, through the binding,
   * for a client this coordinator itself created. */
  private readonly motorTestRegistry = new MotorTestTelemetryRegistry();

  /**
   * Idempotent: exactly one MspClient ever exists per sessionId, and
   * exactly one identify() attempt is ever started per genuinely new
   * activation. A second call for a sessionId that already has a committed
   * entry (ownership ACTIVE) returns that SAME MspClient instance without
   * constructing anything new or starting a second identify() call. There
   * is no separate "already ACTIVATING" branch to handle: openSession()
   * runs fully synchronously from the ACTIVATING transition through to
   * either a committed ACTIVE entry or a reverted-to-INACTIVE failure, with
   * no `await` anywhere in between (identify() is started fire-and-forget,
   * never awaited here) - JavaScript's single-threaded execution means no
   * second call can ever observe this session mid-construction; by the
   * time any other code runs, this call has already fully settled one way
   * or the other.
   *
   * For a genuinely new activation (Pass 6.4b):
   *  1. Ownership -> ACTIVATING, synchronously, before anything else is
   *     constructed - closes the race window where a consumer's
   *     mspActive-derived guard (e.g. the debug panel's mspActiveRef) could
   *     run concurrently with construction.
   *  2. RNMspTransport, then MspClient, then the coordinator's own
   *     onSessionDetached listener are constructed/wired LOCALLY - nothing
   *     is committed to `sessions` yet.
   *  3. If construction throws: whatever was partially built is disposed
   *     best-effort (MspClient first, then transport - same ordering as
   *     every other teardown path), ownership reverts to INACTIVE, and a
   *     new MspOwnershipActivationError is thrown. Nothing was ever
   *     committed, so getActiveTransport()/getActiveMspClient() already
   *     correctly return undefined without any extra cleanup step.
   *  4. On success: the pairing is committed with a freshly-minted
   *     generation token, ownership -> ACTIVE, and the MspClient is
   *     returned (same contract as Pass 6.3).
   *  5. Still within this same synchronous call, immediately after step 4:
   *     client.startReading(sessionId) is called, fire-and-forget from
   *     openSession()'s own perspective - openSession() itself does not
   *     await it, still returning MspClient synchronously, unchanged. BUT
   *     beginIdentification() (and therefore identify()'s first
   *     writeBytes()) is deliberately CHAINED onto that same Promise's
   *     resolution, not fired independently alongside it - genuinely
   *     guaranteeing the native receive loop is confirmed running before
   *     the first MSP request is ever written, not merely "issued first
   *     and hoped to win a race." Found necessary by a real-hardware
   *     investigation: MspSessionCoordinator previously never called
   *     startReading() at all for a real session (only
   *     RNMspTransport.restartReceiveLoop() - MspClient's OWN Pass 6.2b
   *     recovery machinery - ever did, and only after a request had
   *     already timed out), so the very first identify() attempt on a
   *     fresh connection was reading from a receive loop that had never
   *     been started - see handleStartReadingFailure() for what happens
   *     if startReading() itself rejects instead of resolving.
   */
  openSession(client: UsbSerialTransportClient, sessionId: string): MspClient {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing.mspClient;
    }

    this.ownershipStates.set(sessionId, 'ACTIVATING');
    this.notifyOwnership();

    let transport: RNMspTransport | undefined;
    let mspClient: MspClient | undefined;
    try {
      transport = new RNMspTransport(client, sessionId);
      mspClient = new MspClient(transport, sessionId);
      transport.onSessionDetached(() => {
        this.handlePhysicalDetach(sessionId);
      });
    } catch (constructionError) {
      try {
        mspClient?.dispose();
      } catch {
        // Best-effort - see the class doc comment's dispose-ordering note.
      }
      try {
        transport?.dispose();
      } catch {
        // Best-effort - see above.
      }
      this.ownershipStates.delete(sessionId);
      this.notifyOwnership();
      throw new MspOwnershipActivationError(sessionId, constructionError);
    }

    // Pass 7.4, Step 4: subscribed from construction, not deferred to
    // startReading()'s resolution the way startTelemetry() is - unlike
    // MSP_ATTITUDE polling, recovery state is meaningful from the moment
    // an MspClient exists (e.g. a desync triggered by identify()'s own
    // requests, before startTelemetry() would even run).
    const mspClientStateUnsubscribe = mspClient.subscribe(() => {
      this.notifyMspRecoveryState();
    });

    const generation = ++this.generationCounter;
    this.sessions.set(sessionId, {
      transport,
      mspClient,
      generation,
      identification: {status: 'IDLE'},
      metrics: undefined,
      telemetryScheduler: undefined,
      motorTestSession: undefined,
      tickIntervalHandle: undefined,
      mspClientStateUnsubscribe,
      batteryDebugLog: undefined,
      batteryLatchedValue: undefined,
      auxChannelStates: new Map(),
      auxUnregisterFns: new Map(),
      auxDebugLog: undefined,
    });
    this.ownershipStates.set(sessionId, 'ACTIVE');
    this.notifyOwnership();
    // Pass 7.4, Step 4: a REAL bug, found by an actual hook test failing
    // (not inferred by analogy alone): mspClient.subscribe() only fires
    // on SUBSEQUENT transitions - it never announces the client's own
    // initial READY state from construction. Unlike telemetryAvailability
    // (whose scheduler genuinely does not exist until startTelemetry()
    // runs, later, asynchronously), getMspRecoveryState() already flips
    // from undefined to 'READY' RIGHT HERE, synchronously - so this
    // explicit notify() is required for that transition to ever reach a
    // useMspRecoveryState() subscriber; without it, a component mounted
    // before openSession() is called would stay stuck at its initial
    // undefined value forever, even though getMspRecoveryState() itself
    // already reports 'READY' correctly on the next read.
    this.notifyMspRecoveryState();

    // Fire-and-forget from openSession()'s own perspective (still returns
    // synchronously below, unchanged) - but beginIdentification() is
    // deliberately CHAINED onto startReading()'s resolution, not started
    // independently alongside it. See this method's own doc comment
    // (step 5) for why this ordering - not just issuing both calls in the
    // same synchronous turn - is required to actually close the race
    // rather than merely narrow it.
    client.startReading(sessionId).then(
      () => {
        if (!this.isCurrentGeneration(sessionId, generation)) {
          // Superseded - the session was torn down (deactivated or
          // physically detached) while startReading() was still in
          // flight. Never begin identification against a session that no
          // longer exists.
          return;
        }
        this.beginIdentification(sessionId, mspClient, transport, generation);
        this.startTelemetry(sessionId, mspClient);
      },
      error => this.handleStartReadingFailure(sessionId, generation, error),
    );

    return mspClient;
  }

  /**
   * A session whose native receive loop failed to start (e.g.
   * RX_ALREADY_ACTIVE, RX_RESTART_TIMEOUT, or any other real rejection
   * from UsbSerialTransportClient.startReading()) is exactly as unusable
   * as one that never activated at all - it can never receive data. But
   * unlike a genuine construction failure, this is discovered
   * asynchronously, after openSession() has already returned MspClient to
   * its caller - there is no synchronous throw left to raise. Treated the
   * same way a physical detach discovered mid-flight already is (NOT the
   * same way a construction failure is): the generation-token guard first
   * (an already-superseded session, e.g. reused sessionId reopened before
   * this settled, must never be torn down by a stale rejection), then the
   * identical handlePhysicalDetach() sequence - not a graceful,
   * in-progress close, so CLOSING is skipped entirely, same reasoning as
   * that method's own doc comment.
   */
  private handleStartReadingFailure(sessionId: string, generation: number, _error: unknown): void {
    if (!this.isCurrentGeneration(sessionId, generation)) {
      return;
    }
    this.handlePhysicalDetach(sessionId);
  }

  /**
   * Pass 6.4b: starts MspIdentificationService.identify() fire-and-forget
   * against the just-activated session, wrapping `mspClient` in a minimal
   * MspRequester that counts each successful request() call
   * (completedFrameCount's "successful" half) without modifying
   * MspIdentificationService.ts or MspClient.ts at all. Metrics are
   * assembled from three independent sources for the exact duration of
   * this one identify() call:
   *  - nativeChunkCount/receivedByteCount: a temporary transport.onDataReceived
   *    listener, registered here and unsubscribed the moment identify()
   *    settles.
   *  - completedFrameCount's "unsolicited" half, and diagnosticCount:
   *    mspClient.onDiagnostic() (Pass 6.2a), same temporary
   *    subscribe-for-the-duration pattern.
   *  - completedFrameCount's "successful" half: the counting MspRequester
   *    wrapper above.
   */
  private beginIdentification(
    sessionId: string,
    mspClient: MspClient,
    transport: RNMspTransport,
    generation: number,
  ): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      // Unreachable given openSession()'s own call-site ordering (this is
      // called synchronously immediately after committing the entry), kept
      // as a defensive invariant rather than relied on to be false.
      return;
    }

    const startedAtMs = Date.now();
    entry.identification = {status: 'RUNNING'};
    entry.metrics = {startedAtMs, nativeChunkCount: 0, receivedByteCount: 0, completedFrameCount: 0, diagnosticCount: 0};
    this.notifyIdentification();

    let nativeChunkCount = 0;
    let receivedByteCount = 0;
    let successfulFrameCount = 0;
    let unsolicitedFrameCount = 0;
    let diagnosticCount = 0;

    const unsubscribeData = transport.onDataReceived(bytes => {
      nativeChunkCount += 1;
      receivedByteCount += bytes.length;
    });
    const unsubscribeDiagnostic = mspClient.onDiagnostic(event => {
      if (event.type === 'UNSOLICITED_FRAME') {
        unsolicitedFrameCount += 1;
      } else {
        diagnosticCount += 1;
      }
    });

    const countingRequester: MspRequester = {
      request: async (command, payload, options) => {
        const frame = await mspClient.request(command, payload, options);
        successfulFrameCount += 1;
        return frame;
      },
    };

    const finish = (identification: MspIdentificationState) => {
      unsubscribeData();
      unsubscribeDiagnostic();
      if (!this.isCurrentGeneration(sessionId, generation)) {
        // Superseded - the session was torn down (deactivated or
        // physically detached) while identify() was still in flight. Never
        // recorded against a session that no longer exists.
        return;
      }
      const completedAtMs = Date.now();
      const current = this.sessions.get(sessionId);
      if (!current) {
        return;
      }
      current.identification = identification;
      current.metrics = {
        startedAtMs,
        completedAtMs,
        durationMs: completedAtMs - startedAtMs,
        nativeChunkCount,
        receivedByteCount,
        completedFrameCount: successfulFrameCount + unsolicitedFrameCount,
        diagnosticCount,
      };
      // Pass 7.6a: the ONE battery-poll registration point, deliberately
      // inside this generation-guarded finish() (a late result from a
      // replaced session already returned above and can never register
      // into the replacement). Betaflight-only per the verified payload
      // contract; every other outcome leaves the id unregistered ->
      // UNAVAILABLE. The scheduler is guaranteed to exist here in
      // practice (startTelemetry() runs synchronously in the same
      // startReading() continuation that starts identify(), which
      // settles later) - the undefined check is a defensive invariant,
      // same as startTelemetry()'s own entry guard. Teardown needs no
      // extra handling: deactivate/detach/replacement destroy the whole
      // scheduler, and this poll dies with it.
      if (
        identification.status === 'SUCCEEDED' &&
        identification.identity.firmware.knownFamily === 'BETAFLIGHT' &&
        current.telemetryScheduler !== undefined
      ) {
        const batteryUnregister = current.telemetryScheduler.registerPoll<MspBatteryState>({
          id: BATTERY_TELEMETRY_POLL_ID,
          command: MSP_BATTERY_STATE,
          intervalMs: BATTERY_POLL_INTERVAL_MS,
          staleAfterMs: BATTERY_POLL_STALE_AFTER_MS,
          priority: BATTERY_POLL_PRIORITY,
          decode: decodeBatteryState,
        });
        // Pass 7.6b: bounded debug observability (transition-driven only -
        // see batteryDebugLog.ts). The subscription lives exactly as long
        // as this session's scheduler: stopTelemetry() drops the scheduler
        // (and its listener set) wholesale, and onTeardown logs the end.
        //
        // Pass 7.6c battery-timeout closure: the SAME subscription also
        // hosts the battery one-strike timeout breaker (mirroring the
        // auxiliary channels' policy exactly): the FIRST battery
        // MSP_TIMEOUT unregisters the poll - the scheduler can never
        // dispatch an unregistered id again, so no queued or later tick
        // can send another battery request this physical session, and no
        // separate battery timer exists to cancel beyond the in-flight
        // response timer MspClient already consumed at the timeout
        // itself. getValue() then reports UNAVAILABLE (the approved
        // "بيانات البطارية غير متاحة" state - never UNSUPPORTED, never
        // "no LiPo", and an earlier FRESH value can never be shown as
        // live again). The verdict is recorded in auxChannelStates under
        // the battery poll id so tests/consumers can read it through the
        // existing getAuxTelemetryChannelState() surface; a genuinely
        // new physical session (new generation) starts a fresh entry and
        // polls battery normally. Screen navigation never touches this
        // coordinator state, so remounting Setup cannot reset the
        // breaker. NON-timeout battery errors keep the pre-existing
        // behavior (retry each 3000ms interval) unchanged.
        const batteryDebugLog = createBatteryDebugLogger(sessionId, generation);
        batteryDebugLog.onRegistered(BATTERY_POLL_INTERVAL_MS, BATTERY_POLL_STALE_AFTER_MS);
        const schedulerForLog = current.telemetryScheduler;
        current.auxChannelStates.set(BATTERY_TELEMETRY_POLL_ID, 'ACTIVE');
        let batteryLastRef: unknown;
        let batteryBroken = false;
        let batteryLastGood: {value: MspBatteryState; updatedAtMs: number} | undefined;
        schedulerForLog.subscribe(() => {
          if (!this.isCurrentGeneration(sessionId, generation)) {
            return; // late/old-generation outcome - discarded
          }
          const batteryValue = schedulerForLog.getValue<MspBatteryState>(BATTERY_TELEMETRY_POLL_ID);
          const isNewSettle = batteryValue !== batteryLastRef;
          batteryLastRef = batteryValue;
          if (batteryValue.status === 'FRESH' && isNewSettle) {
            batteryLastGood = {value: batteryValue.value, updatedAtMs: batteryValue.updatedAtMs};
          }
          batteryDebugLog.onValue(batteryValue);
          if (
            !batteryBroken &&
            isNewSettle &&
            batteryValue.status === 'ERROR' &&
            batteryValue.error instanceof MspClientError &&
            batteryValue.error.code === 'MSP_TIMEOUT'
          ) {
            batteryBroken = true;
            batteryUnregister();
            current.auxChannelStates.set(BATTERY_TELEMETRY_POLL_ID, 'DISABLED');
            // Pass 7.7 last-known-value latch: retain the pre-timeout real
            // reading (if any) as a frozen truthfully-STALE snapshot; with
            // no prior success, a truthful read-timeout ERROR. The
            // scheduler's own value for the unregistered poll stays
            // UNAVAILABLE - this latch is the UI-facing display override.
            current.batteryLatchedValue = Object.freeze(
              batteryLastGood !== undefined
                ? {
                    status: 'STALE' as const,
                    value: batteryLastGood.value,
                    updatedAtMs: batteryLastGood.updatedAtMs,
                    ageMs: Date.now() - batteryLastGood.updatedAtMs,
                  }
                : {status: 'ERROR' as const, error: batteryValue.error},
            ) as TelemetryValue<MspBatteryState>;
            batteryDebugLog.onCircuitBreak('timeout');
            this.notifyAuxTelemetry();
          }
        });
        current.batteryDebugLog = batteryDebugLog;

        // ---- Pass 7.6c: auxiliary Region 3 channels (same Betaflight
        // gate, same generation guard, same scheduler) - phase-staggered
        // slow polls plus a per-channel circuit breaker (see the
        // AuxTelemetryChannelState doc above). ----
        this.registerAuxTelemetry(sessionId, generation, current);
      }
      this.notifyIdentification();
    };

    new MspIdentificationService(countingRequester).identify().then(
      identity => finish({status: 'SUCCEEDED', identity}),
      error => finish({status: 'FAILED', error}),
    );
  }

  /**
   * Pass 7.4: creates this session's real MspTelemetryScheduler
   * (wrapping mspClient directly as its MspRequester - MspClient already
   * satisfies that interface structurally, same as
   * beginIdentification()'s own countingRequester's underlying call, no
   * wrapper needed here since no per-request counting is wanted for
   * telemetry), registers the MSP_ATTITUDE poll, and starts a real
   * setInterval driving tick() every TELEMETRY_TICK_INTERVAL_MS.
   *
   * Called from the SAME startReading()-confirmed continuation
   * beginIdentification() is - deliberately NOT at the earlier
   * synchronous ownership->ACTIVE flip inside openSession() itself,
   * despite this pass's own instructions phrasing the trigger as "once
   * ownership reaches ACTIVE": firing an MSP_ATTITUDE request before
   * startReading() has resolved would reintroduce the exact "receive
   * loop not started yet" race beginIdentification() was already built
   * to avoid (see that method's own doc comment) - "the same point
   * beginIdentification() already starts from" is read as the
   * authoritative, more specific instruction here.
   *
   * Also notifies subscribeTelemetryAvailability() listeners once the
   * scheduler is actually in place (found necessary while testing
   * useTelemetryValue.ts): the synchronous ownership->ACTIVE notification
   * inside openSession() fires BEFORE this method ever runs (this is
   * called later, from the startReading()-resolved continuation), so a
   * hook that only re-checks getTelemetryScheduler() in response to
   * ownership notifications would otherwise never learn the scheduler
   * now exists. A DEDICATED listener Set, not a reuse of
   * ownershipListeners: reusing ownershipListeners was tried first and
   * reverted - it broke an existing test asserting the EXACT ownership
   * notification sequence (['ACTIVATING', 'ACTIVE', 'INACTIVE']) by
   * inserting a redundant extra 'ACTIVE' firing with no actual status
   * change, exactly the kind of surprising cross-axis coupling
   * subscribeIdentificationState()'s own doc comment already warns
   * against for the ownership/identification split - the same reasoning
   * applies here.
   */
  private startTelemetry(sessionId: string, mspClient: MspClient): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      // Unreachable given this method's own call-site ordering (called
      // synchronously immediately after beginIdentification(), which
      // has the identical guard) - kept as a defensive invariant.
      return;
    }

    // Pass 7.6c: singleFlight - the real MSP link is serialized at
    // ~224ms per round trip, so at most ONE telemetry dispatch may be
    // outstanding at any moment (see MspTelemetrySchedulerOptions).
    // Phase 2E (P4) - THE AUTHORITATIVE CONSTRUCTION BOUNDARY.
    //
    // `mspClient` is this entry's exact client. It is handed to the
    // binding once; the binding mints the anchor for it and is the only
    // thing that can create a scheduler for it. Nothing downstream is
    // given the opportunity to name a different client, so the
    // scheduler-polls-A / anchor-labelled-B composition has no
    // representation in production code.
    const motorTestSession = createMotorTestSessionBinding(mspClient, {
      registry: this.motorTestRegistry,
    });
    const scheduler = motorTestSession.createScheduler({singleFlight: true});
    scheduler.registerPoll<MspAttitude>({
      id: ATTITUDE_TELEMETRY_POLL_ID,
      command: MSP_ATTITUDE,
      intervalMs: ATTITUDE_POLL_INTERVAL_MS,
      staleAfterMs: ATTITUDE_POLL_STALE_AFTER_MS,
      priority: 0,
      decode: decodeAttitude,
    });

    // No isCurrentGeneration() guard is needed inside this callback:
    // JavaScript's single-threaded execution means clearInterval() (both
    // teardown paths, below) always fully takes effect before any other
    // code (including a new openSession() for a reused sessionId) can
    // run - there is no window for this interval to fire again once
    // teardown has cleared it.
    const tickIntervalHandle = setInterval(() => {
      scheduler.tick();
    }, TELEMETRY_TICK_INTERVAL_MS);
    unrefIfSupported(tickIntervalHandle);

    entry.telemetryScheduler = scheduler;
    entry.motorTestSession = motorTestSession;
    entry.tickIntervalHandle = tickIntervalHandle;
    this.notifyTelemetryAvailability();
  }

  /** Mirrors mspClient.ts's own isCurrentRecoveryAttempt() epoch-guard
   * pattern: an identify() attempt is only "current" while the session it
   * belongs to still exists AND still carries the exact generation token
   * that attempt was tagged with. */
  private isCurrentGeneration(sessionId: string, generation: number): boolean {
    const entry = this.sessions.get(sessionId);
    return entry !== undefined && entry.generation === generation;
  }

  /** Pass 7.7: the ids of sessions with a live entry right now - the
   * AppState owner needs this to pause every running session's telemetry
   * on background. Read-only snapshot; never exposes the entries. */
  listSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  getOwnershipState(sessionId: string): MspSessionOwnershipState {
    return this.ownershipStates.get(sessionId) ?? 'INACTIVE';
  }

  /** Generic "something about ownership changed, for some session" signal -
   * not scoped to one sessionId, matching this codebase's existing
   * event-emitter conventions (RNMspTransport.ts): a Set<listener>,
   * snapshotted via Array.from() before iterating (so a listener that
   * synchronously unsubscribes another mid-dispatch can't cause a
   * later-registered listener to be silently skipped), with per-listener
   * try/catch so one throwing listener can never prevent another from
   * running. */
  subscribeOwnershipState(listener: () => void): MspSessionCoordinatorUnsubscribe {
    this.ownershipListeners.add(listener);
    return () => {
      this.ownershipListeners.delete(listener);
    };
  }

  getIdentificationState(sessionId: string): MspIdentificationState {
    return this.sessions.get(sessionId)?.identification ?? IDLE_IDENTIFICATION_STATE;
  }

  /** A SEPARATE Set from ownershipListeners (Step 2's own choice, reported
   * per the task instructions): identification changes far more often
   * during a session's life (IDLE -> RUNNING -> SUCCEEDED/FAILED, once,
   * shortly after activation) and for a genuinely different reason than
   * ownership does (which only changes on activate/deactivate/detach) - a
   * consumer that only cares about one axis should not be notified (and
   * forced to re-render, for a React consumer) on every change to the
   * other. */
  subscribeIdentificationState(listener: () => void): MspSessionCoordinatorUnsubscribe {
    this.identificationListeners.add(listener);
    return () => {
      this.identificationListeners.delete(listener);
    };
  }

  getIdentificationMetrics(sessionId: string): MspIdentificationMetrics | undefined {
    return this.sessions.get(sessionId)?.metrics;
  }

  /** Exposed for future consumers (Pass 6.4+ screens/hooks) - the same
   * MspClient instance every open session's openSession() call already
   * returned, reachable without needing to call openSession() again. */
  getActiveMspClient(sessionId: string): MspClient | undefined {
    return this.sessions.get(sessionId)?.mspClient;
  }

  /** Pass 6.3 Step 3: the same RNMspTransport instance openSession()
   * internally created, for consumers that need raw bytes (Uint8Array) -
   * MspClient never re-exposes those, only parsed MSP frames. The debug
   * panel's read-only monitor is the first such consumer: it registers
   * its own independent onDataReceived listener directly on this exact
   * instance (Step 1's multi-listener support), never a second, separate
   * subscription to the raw underlying client. */
  getActiveTransport(sessionId: string): RNMspTransport | undefined {
    return this.sessions.get(sessionId)?.transport;
  }

  /** Pass 7.1: mirrors getActiveMspClient()'s exact undefined-for-no-entry
   * convention above. Returns a fresh object each call (not a cached
   * reference) - callers must compare by value ({sessionId, generation}),
   * never by identity. */
  getSessionKey(sessionId: string): SetupUiSessionKey | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      return undefined;
    }
    return {sessionId, generation: entry.generation};
  }

  /** Pass 7.4: mirrors getActiveMspClient()'s exact undefined-for-
   * no-entry convention. undefined both when there is no active session
   * at all, AND while ownership is ACTIVE but startTelemetry() has not
   * run yet (the brief window between the synchronous ownership->ACTIVE
   * flip and startReading() actually resolving - see startTelemetry()'s
   * own doc comment). */
  getTelemetryScheduler(sessionId: string): MspTelemetryScheduler | undefined {
    return this.sessions.get(sessionId)?.telemetryScheduler;
  }

  /**
   * Phase 2E (P4): this session's PRE-COHERENT motor-test capability, or
   * undefined before startTelemetry() has run or after teardown.
   *
   * A consumer receives an object whose client and anchor were bound
   * together here; it can create further polls on that same link and can
   * close it, but it cannot relabel or replace either member. There is no
   * accessor that hands out the raw anchor or the raw client for
   * re-pairing, which is what keeps the A/B composition unrepresentable.
   */
  getMotorTestSessionCapability(
    sessionId: string,
  ): MotorTestSessionCapability | undefined {
    return this.sessions.get(sessionId)?.motorTestSession;
  }

  /**
   * Phase 2H - the composite identity currently in force for one session,
   * in exactly the shape the motor-test controller's session port expects.
   *
   * Both components come from THIS coordinator's own authoritative state:
   * `physicalGeneration` is the per-activation generation token (already
   * the basis of SetupUiSessionKey), and `mspEpoch` is the client's own
   * counter, readable but not writable from outside and rotated only by
   * its desync latch. Nothing here is caller-supplied, so a consumer
   * cannot describe a session it is not actually on.
   *
   * Returns undefined when no session exists - which the controller treats
   * as a hard refusal, not as a default.
   */
  getMotorTestSessionIdentity(
    sessionId: string,
  ): {physicalGeneration: number; mspEpoch: number} | undefined {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) {
      return undefined;
    }
    // A FRESH object every call, deliberately: composite identity is
    // compared BY VALUE by its consumer, never by reference.
    return {
      physicalGeneration: entry.generation,
      mspEpoch: entry.mspClient.getEpoch(),
    };
  }

  /**
   * Phase 2H - genuine invalidation signals for one session, mapped onto
   * the controller's own three accepted reasons.
   *
   * Built from the EXISTING ownership and recovery notifications rather
   * than a new listener axis: a session leaving ACTIVE is a real
   * replacement or teardown, and the client reaching DISCONNECTED or a
   * terminal recovery failure is a real loss. No new native subscription
   * is registered, so this never competes with the lifecycle bridge or
   * with the coordinator's own listeners.
   */
  subscribeMotorTestSessionInvalidated(
    sessionId: string,
    listener: (reason: 'USB_DETACHED' | 'SESSION_CHANGED' | 'DESYNCHRONIZED') => void,
  ): MspSessionCoordinatorUnsubscribe {
    const openedGeneration = this.sessions.get(sessionId)?.generation;
    let delivered = false;
    const evaluate = (): void => {
      if (delivered) {
        // Invalidation is terminal for a controller. Reporting it twice
        // could only ever re-fault an already-faulted session.
        return;
      }
      const entry = this.sessions.get(sessionId);
      if (entry === undefined || entry.generation !== openedGeneration) {
        delivered = true;
        listener('SESSION_CHANGED');
        return;
      }
      const clientState = entry.mspClient.getState();
      if (clientState === 'DISCONNECTED' || clientState === 'CLOSING') {
        delivered = true;
        listener('USB_DETACHED');
        return;
      }
      if (clientState === 'RECOVERY_FAILED') {
        delivered = true;
        listener('DESYNCHRONIZED');
      }
    };
    const unsubscribeOwnership = this.subscribeOwnershipState(evaluate);
    const unsubscribeRecovery = this.subscribeMspRecoveryState(evaluate);
    return () => {
      unsubscribeOwnership();
      unsubscribeRecovery();
    };
  }

  /** Pass 7.4: fires whenever getTelemetryScheduler() may now report
   * something different FOR ANY sessionId - specifically, once
   * startTelemetry() has just created one (same broad-notify, narrow-in-
   * getSnapshot convention as subscribeOwnershipState()/
   * subscribeIdentificationState()). A session's teardown (either path)
   * still only fires the EXISTING subscribeOwnershipState() notification
   * - getTelemetryScheduler() reverting to undefined there is a direct,
   * synchronous consequence of the same ownership transition, not a
   * separate event worth a second notification. */
  subscribeTelemetryAvailability(listener: () => void): MspSessionCoordinatorUnsubscribe {
    this.telemetryAvailabilityListeners.add(listener);
    return () => {
      this.telemetryAvailabilityListeners.delete(listener);
    };
  }

  /**
   * Pass 7.4, Step 4: the underlying MspClient's own recovery/connection
   * state - the raw MspClientState, not pre-collapsed to whatever subset
   * a particular UI need cares about (the same "expose the real
   * underlying type, let the caller derive" precedent
   * getOwnershipState()/getIdentificationState() already set - Region 1's
   * own 5-state top-bar derivation, a SEPARATE pure function, is the
   * right place for that collapsing, not this coordinator).
   *
   * NO OBJECT-CACHING NEEDED (unlike getTelemetryScheduler()'s own
   * cachedValue machinery): MspClientState is a bare string union, and a
   * live pass-through (`entry?.mspClient.getState()`) is ALREADY
   * referentially stable for useSyncExternalStore's purposes - two calls
   * with no transition in between return the exact same primitive via
   * ===, by JavaScript's own string-equality semantics, with no
   * wrapping object to construct fresh each time. undefined for no
   * active session - mirrors getTelemetryScheduler()'s own convention. */
  getMspRecoveryState(sessionId: string): MspClientState | undefined {
    return this.sessions.get(sessionId)?.mspClient.getState();
  }

  /** Pass 7.4, Step 4: fires whenever getMspRecoveryState() may now
   * report something different for ANY sessionId - forwards every one of
   * the underlying MspClient's own subscribe() notifications (wired up
   * once, in openSession(), for the entry's own MspClient instance - see
   * that call site's own doc comment for why subscription starts at
   * construction rather than being deferred like startTelemetry() is). */
  subscribeMspRecoveryState(listener: () => void): MspSessionCoordinatorUnsubscribe {
    this.mspRecoveryStateListeners.add(listener);
    return () => {
      this.mspRecoveryStateListeners.delete(listener);
    };
  }

  /**
   * Intentional close (Pass 6.4b rename - deliberately NOT named
   * closeSession(), to avoid any resemblance to UsbSerialTransportClient's
   * own closeSession(), a different operation at a different layer). Call
   * from UsbConnectionScreen.tsx's handleDisconnect() BEFORE
   * DISCONNECT_SUCCESS dispatches.
   *
   * Sequence, exactly in this order:
   *  1. Ownership -> CLOSING.
   *  2. This session's generation token is invalidated (set to
   *     INVALIDATED_GENERATION) - a DISTINCT step from removing the entry
   *     below: the entry is still needed for steps 3-4 (it holds the
   *     mspClient/transport references to dispose), but any identify()
   *     completion racing this teardown must already see itself as
   *     superseded from this point forward, not only once the entry is
   *     fully gone.
   *  3. Pass 7.4: the telemetry tick interval is cleared (if
   *     startTelemetry() ever ran for this session) - stops any further
   *     tick() from firing new requests against a client that is about
   *     to be disposed, same "stop generating new activity before
   *     tearing down what it depends on" principle as step 2 itself.
   *  4. mspClient.dispose() - itself a real, final state transition
   *     (CLOSING -> DISCONNECTED) that legitimately notifies this
   *     entry's recovery-state subscribers one last time (see
   *     notifyMspRecoveryState()'s own doc comment).
   *  5. Pass 7.4, Step 4: entry.mspClientStateUnsubscribe() - AFTER
   *     dispose(), not before, so that final DISCONNECTED notification
   *     above is not itself silently dropped.
   *  6. transport.dispose().
   *  7. The session is removed from the internal map.
   *  8. Ownership -> INACTIVE.
   */
  deactivateMspSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      return;
    }

    this.ownershipStates.set(sessionId, 'CLOSING');
    this.notifyOwnership();

    entry.generation = INVALIDATED_GENERATION;
    this.stopTelemetry(entry, 'deactivated');

    entry.mspClient.dispose();
    entry.mspClientStateUnsubscribe();
    entry.transport.dispose();

    this.sessions.delete(sessionId);
    this.ownershipStates.delete(sessionId);
    this.notifyOwnership();
  }

  /**
   * Own, independent listener registered directly on the transport by
   * openSession() - see the class doc comment. Not screen-driven: fires
   * automatically the moment the transport reports this session's
   * physical detach, regardless of what any screen is doing.
   *
   * DECIDED (Pass 6.4b): unlike deactivateMspSession(), this skips CLOSING
   * entirely - mirroring MspClient's own physical-detach-always-wins
   * immediate jump straight to DISCONNECTED with no intermediate tick
   * (Pass 6.2b, mspClient.ts's handlePhysicalDetach()). Ownership moves
   * DIRECTLY from ACTIVE to INACTIVE: generation invalidated -> both
   * dispose() calls, in the usual order -> removed from the map -> exactly
   * ONE ownership notification, for the final INACTIVE state. A physical
   * detach is not a graceful, in-progress close; nothing observing
   * ownership state needs (or should see) a transient CLOSING tick for it.
   */
  private handlePhysicalDetach(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      return;
    }

    entry.generation = INVALIDATED_GENERATION;
    this.stopTelemetry(entry, 'detached');

    entry.mspClient.dispose();
    entry.mspClientStateUnsubscribe();
    entry.transport.dispose();

    this.sessions.delete(sessionId);
    this.ownershipStates.delete(sessionId);
    this.notifyOwnership();
  }

  /** Shared by both teardown paths - clears the real tick() interval (if
   * startTelemetry() ever ran for this entry) and drops the scheduler
   * reference. The scheduler itself (Pass 7.2) has no dispose() of its
   * own to call - it owns no resource beyond what this coordinator added
   * (the interval cleared here). */
  private stopTelemetry(entry: SessionEntry, reason: 'deactivated' | 'detached'): void {
    if (entry.tickIntervalHandle !== undefined) {
      clearInterval(entry.tickIntervalHandle);
      entry.tickIntervalHandle = undefined;
    }
    // Phase 2E (P4): the anchor dies with the scheduler and before the
    // client/transport are disposed, so a detached or replaced client can
    // never leave an anchor usable against a newer one. closeSession()
    // also releases any barrier still held for it, so no pause token
    // survives teardown.
    entry.motorTestSession?.close();
    entry.motorTestSession = undefined;
    entry.telemetryScheduler = undefined;
    // Pass 7.6b: bounded debug observability - one stop line, only for
    // sessions whose battery poll ever registered.
    entry.batteryDebugLog?.onTeardown(reason);
    entry.batteryDebugLog = undefined;
    // Pass 7.6c: aux channels die with the scheduler (their unregister
    // functions are moot once the scheduler reference is dropped) - one
    // bounded stop line, then clear the per-session verdicts.
    entry.auxDebugLog?.onTeardown(reason);
    entry.auxDebugLog = undefined;
    entry.auxChannelStates.clear();
    entry.auxUnregisterFns.clear();
    entry.batteryLatchedValue = undefined;
    this.notifyAuxTelemetry();
  }

  /**
   * Pass 7.6c: registers the three auxiliary polls, wires the per-channel
   * circuit-breaker supervisor, and emits the bounded [FPV-TELEM]
   * observability. Runs only inside the generation-guarded,
   * Betaflight-identified finish() path.
   */
  private registerAuxTelemetry(sessionId: string, generation: number, entry: SessionEntry): void {
    const scheduler = entry.telemetryScheduler;
    if (scheduler === undefined) {
      return; // defensive - same invariant as the battery registration
    }

    const auxLog = createAuxTelemetryDebugLogger(sessionId, generation);
    entry.auxDebugLog = auxLog;

    const definitions: Array<{
      id: string;
      command: number;
      intervalMs: number;
      staleAfterMs: number;
      priority: number;
      initialDelayMs: number;
      decode: (payload: Uint8Array) => unknown;
      summarize: (value: unknown) => string;
    }> = [
      {
        id: RECEIVER_TELEMETRY_POLL_ID,
        command: MSP_ANALOG,
        intervalMs: RECEIVER_POLL_INTERVAL_MS,
        staleAfterMs: RECEIVER_POLL_STALE_AFTER_MS,
        priority: RECEIVER_POLL_PRIORITY,
        initialDelayMs: RECEIVER_POLL_INITIAL_DELAY_MS,
        decode: decodeAnalog,
        summarize: value => `rssi=${(value as {rssi: number}).rssi}`,
      },
      {
        id: GPS_TELEMETRY_POLL_ID,
        command: MSP_RAW_GPS,
        intervalMs: GPS_POLL_INTERVAL_MS,
        staleAfterMs: GPS_POLL_STALE_AFTER_MS,
        priority: GPS_POLL_PRIORITY,
        initialDelayMs: GPS_POLL_INITIAL_DELAY_MS,
        decode: decodeRawGps,
        // NEVER coordinates - the compact model cannot even carry them.
        summarize: value => {
          const gps = value as {hasFix: boolean; satelliteCount: number};
          return `fix=${gps.hasFix} sats=${gps.satelliteCount}`;
        },
      },
      {
        id: FC_STATUS_TELEMETRY_POLL_ID,
        command: MSP_STATUS_EX,
        intervalMs: FC_STATUS_POLL_INTERVAL_MS,
        staleAfterMs: FC_STATUS_POLL_STALE_AFTER_MS,
        priority: FC_STATUS_POLL_PRIORITY,
        initialDelayMs: FC_STATUS_POLL_INITIAL_DELAY_MS,
        // Pass 7.7: the SAME single poll, decoded further in place
        // (fixed prefix + flight-mode bits + bounded optional readiness
        // tail) so Region 4 needs no second STATUS_EX reader.
        decode: decodeStatusExDiagnostics,
        summarize: value => {
          const status = value as {cpuLoadPercent: number; cycleTimeUs: number};
          return `cpu=${status.cpuLoadPercent}% cycle=${status.cycleTimeUs}us`;
        },
      },
    ];

    for (const definition of definitions) {
      entry.auxChannelStates.set(definition.id, 'ACTIVE');
      const unregister = scheduler.registerPoll({
        id: definition.id,
        command: definition.command,
        intervalMs: definition.intervalMs,
        staleAfterMs: definition.staleAfterMs,
        priority: definition.priority,
        initialDelayMs: definition.initialDelayMs,
        decode: definition.decode,
      });
      entry.auxUnregisterFns.set(definition.id, unregister);
    }
    auxLog.onServiceStart(definitions.map(definition => definition.id));

    // Supervisor: classifies each NEW settle (cachedValue is replaced
    // with a fresh object exactly once per settle - object identity is
    // the settle detector) and applies the circuit-breaker rules.
    const tracking = new Map<
      string,
      {lastRef: unknown; lastStatus: string | undefined; hadSuccess: boolean; preSuccessFailures: number; consecutiveErrors: number; firstOutcomeLogged: boolean}
    >(definitions.map(definition => [definition.id, {lastRef: undefined, lastStatus: undefined, hadSuccess: false, preSuccessFailures: 0, consecutiveErrors: 0, firstOutcomeLogged: false}]));

    const breakChannel = (id: string, state: AuxTelemetryChannelState, cause: string) => {
      entry.auxUnregisterFns.get(id)?.();
      entry.auxUnregisterFns.delete(id);
      entry.auxChannelStates.set(id, state);
      auxLog.onCircuitBreak(id, state, cause);
      this.notifyAuxTelemetry();
    };

    scheduler.subscribe(() => {
      if (!this.isCurrentGeneration(sessionId, generation)) {
        return;
      }
      for (const definition of definitions) {
        if (entry.auxChannelStates.get(definition.id) !== 'ACTIVE') {
          continue;
        }
        const track = tracking.get(definition.id)!;
        const value = scheduler.getValue<unknown>(definition.id);
        const isNewSettle = value !== track.lastRef;
        const statusChanged = value.status !== track.lastStatus;
        if (!isNewSettle && !statusChanged) {
          continue;
        }
        track.lastRef = value;
        track.lastStatus = value.status;

        if (value.status === 'FRESH' && isNewSettle) {
          track.hadSuccess = true;
          track.consecutiveErrors = 0;
        }

        const summary =
          value.status === 'FRESH' || value.status === 'STALE' ? definition.summarize(value.value) : undefined;
        const settled = value.status === 'FRESH' || value.status === 'ERROR';
        if (settled && !track.firstOutcomeLogged) {
          track.firstOutcomeLogged = true;
          auxLog.onFirstOutcome(definition.id, value.status, summary);
        } else if (statusChanged) {
          auxLog.onChannelTransition(definition.id, value.status, summary);
        }

        if (value.status === 'ERROR' && isNewSettle) {
          const error = value.error;
          if (error instanceof MspPayloadReadError) {
            // Structurally invalid response - never poll it again this
            // physical session.
            breakChannel(definition.id, 'DECODE_FAILED', 'decode');
          } else if (error instanceof MspClientError && error.code === 'MSP_REMOTE_ERROR') {
            // The FC explicitly rejected the command - proven
            // unsupported for this session.
            breakChannel(definition.id, 'UNSUPPORTED', 'remote-error');
          } else if (error instanceof MspClientError && error.code === 'MSP_TIMEOUT') {
            // Pass 7.6c closure correction: a genuine response timeout
            // costs the ENTIRE serialized link its full 2000ms window
            // (MSP_RESPONSE_TIMEOUT_MILLIS) plus the desync recovery it
            // triggers - long enough to stall attitude past its 700ms
            // stale threshold. ONE timeout therefore disables this
            // channel for the remainder of the CURRENT physical session
            // - no automatic retry, whether or not the channel had
            // succeeded before. Classified as timeout/error (DISABLED),
            // NEVER 'UNSUPPORTED' (a timeout proves nothing about
            // command support). A genuinely new physical session (new
            // generation) probes again from scratch, and no other
            // channel is touched.
            breakChannel(definition.id, 'DISABLED', 'timeout');
          } else if (!track.hadSuccess) {
            // NON-timeout request failure BEFORE any success (e.g. a
            // fast-settling write failure or recovery-window rejection -
            // these never hold the serialized link): the next scheduled
            // attempt is the one permitted delayed retry.
            track.preSuccessFailures += 1;
            if (track.preSuccessFailures >= 2) {
              breakChannel(definition.id, 'DISABLED', 'pre-success-failures');
            }
          } else {
            // NON-timeout temporary failure after success: bounded
            // recovery via the normal cadence, but never an unbounded
            // loop.
            track.consecutiveErrors += 1;
            if (track.consecutiveErrors >= AUX_MAX_CONSECUTIVE_ERRORS_AFTER_SUCCESS) {
              breakChannel(definition.id, 'DISABLED', 'post-success-failures');
            }
          }
        }
      }
    });
    this.notifyAuxTelemetry();
  }

  /** Pass 7.6c: the current circuit-breaker verdict for an auxiliary
   * channel. 'ACTIVE' for unknown sessions/channels - the poll id then
   * simply reads UNAVAILABLE through the scheduler as always. */
  getAuxTelemetryChannelState(sessionId: string, pollId: string): AuxTelemetryChannelState {
    return this.sessions.get(sessionId)?.auxChannelStates.get(pollId) ?? 'ACTIVE';
  }

  /** Pass 7.7: the battery timeout latch (see SessionEntry doc) -
   * undefined unless the battery breaker has fired for the CURRENT
   * generation. Frozen, referentially stable snapshot (set exactly once
   * per generation), so useSyncExternalStore consumers are safe. */
  getBatteryLatchedValue(sessionId: string): TelemetryValue<MspBatteryState> | undefined {
    return this.sessions.get(sessionId)?.batteryLatchedValue;
  }

  /** Pass 7.6c: fires on any aux channel-state change - same Set/
   * snapshot/try-catch convention as every other subscribe here. */
  subscribeAuxTelemetry(listener: () => void): () => void {
    this.auxTelemetryListeners.add(listener);
    return () => {
      this.auxTelemetryListeners.delete(listener);
    };
  }

  private notifyAuxTelemetry(): void {
    for (const listener of Array.from(this.auxTelemetryListeners)) {
      try {
        listener();
      } catch {
        // Best-effort - same convention as notifyOwnership().
      }
    }
  }

  private notifyOwnership(): void {
    for (const listener of Array.from(this.ownershipListeners)) {
      try {
        listener();
      } catch {
        // Best-effort - see subscribeOwnershipState()'s own doc comment.
      }
    }
  }

  private notifyIdentification(): void {
    for (const listener of Array.from(this.identificationListeners)) {
      try {
        listener();
      } catch {
        // Best-effort - same reasoning as notifyOwnership() above.
      }
    }
  }

  private notifyTelemetryAvailability(): void {
    for (const listener of Array.from(this.telemetryAvailabilityListeners)) {
      try {
        listener();
      } catch {
        // Best-effort - same reasoning as notifyOwnership() above.
      }
    }
  }

  /**
   * Pass 7.4, Step 4: called from the per-entry forwarding listener
   * registered in openSession() (mspClient.subscribe(() =>
   * this.notifyMspRecoveryState())) - fires once per underlying
   * MspClient state transition, for whichever session that transition
   * belongs to (broad notify, same as every other axis here).
   *
   * DISPOSAL, TRACED EXPLICITLY (per this pass's own requirement): can
   * this ever fire after this coordinator has already torn the session
   * down? mspClient.dispose() (called from deactivateMspSession()/
   * handlePhysicalDetach(), BEFORE this.sessions.delete()) is itself a
   * real transition (CLOSING -> DISCONNECTED) and DOES fire this
   * forwarding listener - that is expected and correct: existing
   * subscribers (e.g. Region 1's connection indicator) deserve to learn
   * the client is now disconnected, and getMspRecoveryState(sessionId)
   * still resolves correctly at that exact moment, since the entry has
   * not been removed from `this.sessions` yet (dispose() runs before
   * the map delete - see deactivateMspSession()'s own numbered steps).
   * After that point, mspClient.ts's own Pass 6.2b isCurrentRecoveryAttempt()
   * guard (see mspClient.ts's subscribe() doc comment) makes any FURTHER
   * setState()/notify() call from that instance structurally
   * impossible - so this method can never fire again for an
   * already-torn-down session. entry.mspClientStateUnsubscribe() is
   * still called explicitly in both teardown paths below anyway, purely
   * for the same explicit-cleanup consistency stopTelemetry() already
   * follows - not because a leak is otherwise possible.
   */
  private notifyMspRecoveryState(): void {
    for (const listener of Array.from(this.mspRecoveryStateListeners)) {
      try {
        listener();
      } catch {
        // Best-effort - same reasoning as notifyOwnership() above.
      }
    }
  }
}

export const mspSessionCoordinator = new MspSessionCoordinator();
