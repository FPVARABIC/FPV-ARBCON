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

import {MspClient, MspIdentificationService} from '../../../core';
import type {FlightControllerIdentity, MspRequester} from '../../../core';
import type {UsbSerialTransportClient} from '../transport';
import {RNMspTransport} from './RNMspTransport';
import {describeMspIdentificationError} from './mspIdentificationDiagnostics';

export type MspSessionOwnershipState = 'INACTIVE' | 'ACTIVATING' | 'ACTIVE' | 'CLOSING';

export type MspIdentificationState =
  | {status: 'IDLE'}
  | {status: 'RUNNING'}
  | {status: 'SUCCEEDED'; identity: FlightControllerIdentity}
  | {status: 'FAILED'; error: unknown};

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
}

/** Never a real generation number (generationCounter starts at 1 and only
 * ever increments) - a session's generation is set to this the instant its
 * teardown begins, so isCurrentGeneration() reads false immediately. */
const INVALIDATED_GENERATION = -1;

export class MspSessionCoordinator {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly ownershipStates = new Map<string, MspSessionOwnershipState>();
  private readonly ownershipListeners = new Set<() => void>();
  private readonly identificationListeners = new Set<() => void>();
  private generationCounter = 0;

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
   *     identification -> RUNNING and MspIdentificationService.identify()
   *     starts fire-and-forget against the just-created MspClient, tagged
   *     with this attempt's generation token (see beginIdentification()).
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

    const generation = ++this.generationCounter;
    this.sessions.set(sessionId, {
      transport,
      mspClient,
      generation,
      identification: {status: 'IDLE'},
      metrics: undefined,
    });
    this.ownershipStates.set(sessionId, 'ACTIVE');
    this.notifyOwnership();

    this.beginIdentification(sessionId, mspClient, transport, generation);

    return mspClient;
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
      // TEMPORARY DIAGNOSTIC SCAFFOLDING - see mspIdentificationDiagnostics.ts's
      // own class-level note. Surfaces the actual error identify() rejected
      // with (via the same shared formatter UsbSerialDebugPanel.tsx's
      // error-detail Text element uses) into this app's own process
      // logcat, reachable with no adb via the existing "Capture App Log"
      // button (UsbAppLogCapturePanel.tsx). Delete this block once the
      // real-hardware investigation it was added for is resolved.
      if (identification.status === 'FAILED') {
        console.error(
          `[MSP identification failed] session=${sessionId}: ${describeMspIdentificationError(identification.error)}`,
        );
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
      this.notifyIdentification();
    };

    new MspIdentificationService(countingRequester).identify().then(
      identity => finish({status: 'SUCCEEDED', identity}),
      error => finish({status: 'FAILED', error}),
    );
  }

  /** Mirrors mspClient.ts's own isCurrentRecoveryAttempt() epoch-guard
   * pattern: an identify() attempt is only "current" while the session it
   * belongs to still exists AND still carries the exact generation token
   * that attempt was tagged with. */
  private isCurrentGeneration(sessionId: string, generation: number): boolean {
    const entry = this.sessions.get(sessionId);
    return entry !== undefined && entry.generation === generation;
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
    return this.sessions.get(sessionId)?.identification ?? {status: 'IDLE'};
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
   *  3. mspClient.dispose().
   *  4. transport.dispose().
   *  5. The session is removed from the internal map.
   *  6. Ownership -> INACTIVE.
   */
  deactivateMspSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      return;
    }

    this.ownershipStates.set(sessionId, 'CLOSING');
    this.notifyOwnership();

    entry.generation = INVALIDATED_GENERATION;

    entry.mspClient.dispose();
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

    entry.mspClient.dispose();
    entry.transport.dispose();

    this.sessions.delete(sessionId);
    this.ownershipStates.delete(sessionId);
    this.notifyOwnership();
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
}

export const mspSessionCoordinator = new MspSessionCoordinator();
