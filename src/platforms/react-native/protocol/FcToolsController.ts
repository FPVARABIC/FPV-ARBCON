/**
 * Pass 7.7, Region 5 - the exclusive FC-tool transaction owner.
 *
 * WHAT THIS IS NOT: it is not a second protocol client, not a second
 * scheduler, and not a queue bypass. Every request goes through the
 * session's EXISTING MspClient (its FIFO, its single-in-flight rule and
 * its 2000ms bounded response timeout are untouched), and the pause /
 * wait-for-idle / session-identity / settle-once machinery is Pass 7.3's
 * existing MspOperationCoordinator, reused rather than reimplemented.
 *
 * THE SHARED MUTEX is this controller's own phase: IDLE -> CONFIRMING ->
 * RUNNING -> IDLE. It is taken when the confirmation opens and released
 * only at the single settle point, so it genuinely covers opening the
 * confirmation, cancelling it, the preflight, the dispatch, the outcome
 * and the cleanup. A second tap, or a second tool, cannot start anything
 * while it is held; nothing is ever queued for later.
 *
 * THE TRANSACTION, in the contract's own order:
 *   1  mark in progress (phase RUNNING); every other action is rejected
 *   2  pause NEW periodic scheduling via the scheduler's own lease
 *   3  let the existing in-flight request settle (waitUntilIdle)
 *   4  verify the app is still active
 *   5  verify ownership is still ACTIVE
 *   6  verify the same physical generation AND MSP epoch still own it
 *   7  issue ONE fresh on-demand MSP_STATUS_EX through MspClient
 *   8  decode the actual armed state via the generation-bound BOXIDS
 *      mapping (never from the arming-disable mask)
 *   9  revalidate compatibility, sensor requirement and DISARMED
 *  10  if anything is unknown, stale, changed or armed: send NOTHING
 *  11  send the write EXACTLY once
 *  12  bind the outcome to the captured generation
 *  13  settle exactly once
 *  14  resume telemetry on every exit path (the operation coordinator
 *      releases the lease it took, including on reboot/detach)
 *
 * TRUTHFUL OUTCOMES: a calibration ack proves only that the command was
 * received (msp.c acks even when the FC is armed and nothing started),
 * so ACCEPTED never says "completed". An ambiguous write is UNCONFIRMED,
 * never success and never a definite failure. Nothing is ever retried
 * automatically.
 */

import {
  MSP_ACC_CALIBRATION,
  MSP_MAG_CALIBRATION,
  MSP_REBOOT,
  MSP_STATUS_EX,
  BoxIdsAcquisition,
  MspOperationOutcomeUnknownError,
  createMspOperationCoordinator,
  decodeSensorPresence,
  decodeStatusExDiagnostics,
  deriveArmedState,
  resolveFcToolAvailability,
} from '../../../core';
import type {
  ArmedState,
  BoxIdsOwnerIdentity,
  DiagnosticsCompatibility,
  FcToolBlockReason,
  FcToolId,
  MspRequester,
  MspStatusExDiagnostics,
  SensorPresenceBit,
} from '../../../core';
import {mspSessionCoordinator} from './MspSessionCoordinator';
import type {MspSessionCoordinator} from './MspSessionCoordinator';
import {setupAppStateTelemetryOwner} from './setupAppStateTelemetryOwner';
import type {SetupAppStateTelemetryOwner} from './setupAppStateTelemetryOwner';

const EMPTY_PAYLOAD = new Uint8Array(0);

const COMMAND_FOR_TOOL: Record<FcToolId, number> = {
  ACC_CALIBRATION: MSP_ACC_CALIBRATION,
  MAG_CALIBRATION: MSP_MAG_CALIBRATION,
  REBOOT: MSP_REBOOT,
};

export type FcToolPhase =
  | {readonly kind: 'IDLE'}
  | {readonly kind: 'CONFIRMING'; readonly tool: FcToolId; readonly sessionId: string}
  | {readonly kind: 'RUNNING'; readonly tool: FcToolId; readonly sessionId: string};

/**
 * Pass 7.7A (A-1): WHO an outcome belongs to. Captured when the action
 * starts, from the canonical identity the coordinator already owns
 * (getSessionKey().generation + MspClient.getEpoch()) - this introduces
 * no second definition of "the current session".
 *
 * A sentinel generation/epoch of -1 means the action began with no live
 * session at all; such an outcome is still truthful for the screen that
 * asked for it, and is revoked the moment any real owner appears.
 */
export interface FcToolOutcomeOrigin {
  readonly sessionId: string;
  readonly physicalGeneration: number;
  /** The epoch when the action STARTED - provenance. */
  readonly mspEpoch: number;
  /**
   * The epoch this action actually ENDED on. Revocation compares against
   * this, not against `mspEpoch`, for one concrete reason: a response
   * timeout inside the action itself bumps the epoch (MspClient's desync
   * latch), and an action must never revoke its own result. Only an
   * epoch change that happens AFTER the outcome settled means a new
   * logical owner has taken over.
   */
  readonly settledMspEpoch: number;
}

/**
 * A stored outcome plus its provenance and a monotonic publication
 * sequence. PROVENANCE and PUBLICATION LIFETIME are deliberately
 * separate concepts:
 *  - provenance (origin) decides whether a REPLACEMENT owner revokes it;
 *  - the sequence decides whether a given MOUNTED subscriber may ever see
 *    it at all (a subscriber only sees publications made after it
 *    mounted, so a remount can never replay - or re-announce - an old
 *    result).
 * A mere transient detach revokes nothing: the same mounted subscriber
 * keeps an acknowledgement it legitimately received.
 */
export interface FcToolPublication {
  readonly outcome: FcToolOutcome;
  readonly origin: FcToolOutcomeOrigin;
  readonly sequence: number;
}

export type FcToolOutcome =
  /** The FC acknowledged the command. For a calibration this means
   * ACCEPTED/STARTED - never completed. */
  | {readonly kind: 'ACCEPTED'; readonly tool: FcToolId}
  /** Reboot was acknowledged; the link is expected to drop. Reconnection
   * is a separate, observed fact - never assumed here. */
  | {readonly kind: 'REBOOT_REQUESTED'}
  /** A preflight precondition failed. NOTHING was sent. */
  | {readonly kind: 'REJECTED'; readonly tool: FcToolId; readonly reason: FcToolBlockReason}
  /** The user cancelled the confirmation. NOTHING was sent. */
  | {readonly kind: 'CANCELLED'; readonly tool: FcToolId}
  /** Definite failure: the FC rejected it, or it provably never left. */
  | {readonly kind: 'FAILED'; readonly tool: FcToolId; readonly error: unknown}
  /** The result could not be confirmed. Not success, not failure. */
  | {readonly kind: 'UNCONFIRMED'; readonly tool: FcToolId}
  | {readonly kind: 'SESSION_ENDED'; readonly tool: FcToolId};

/**
 * Pass 7.7A (A-4): the typed neutral result of calling confirm() with no
 * confirmation open. It is NOT an FC-tool outcome: it is never stored,
 * never emitted to subscribers, never rendered, never announced, and
 * never guesses a tool.
 */
export const NO_PENDING_CONFIRMATION = null;

/** Thrown by the operation's own execute() when a precondition fails
 * BEFORE any write is dispatched. Its existence is what proves "send
 * nothing" is a distinct outcome from "the write failed". */
class FcToolPreflightRejection extends Error {
  constructor(public readonly reason: FcToolBlockReason) {
    super(`FC tool preflight rejected: ${reason}`);
    this.name = 'FcToolPreflightRejection';
  }
}

/**
 * MspClient error codes that PROVE the bytes never reached the FC -
 * every one of them is raised BEFORE the transport write is attempted
 * (mspClient.ts: encode failure, either queue being full, and the two
 * recovery refusals). Everything else - including MSP_SESSION_CLOSED,
 * which can equally mean "the session closed while the already-written
 * request was still pending" - is ambiguous and must be reported as
 * unconfirmed rather than as a definite failure.
 */
const CONFIRMED_NOT_SENT_CODES: readonly string[] = Object.freeze([
  'MSP_ENCODE_FAILED',
  'MSP_QUEUE_FULL',
  'MSP_TRANSPORT_QUEUE_FULL',
  'MSP_RECOVERY_REQUIRED',
  'MSP_RECOVERING',
]);

function errorCodeOf(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String((error as {code: unknown}).code)
    : undefined;
}

export interface FcToolsControllerOptions {
  coordinator?: MspSessionCoordinator;
  appStateOwner?: SetupAppStateTelemetryOwner;
}

export class FcToolsController {
  private readonly coordinator: MspSessionCoordinator;
  private readonly appStateOwner: SetupAppStateTelemetryOwner;
  private phase: FcToolPhase = {kind: 'IDLE'};
  /** The ONE stored publication, with provenance and sequence (A-1). */
  private publication: FcToolPublication | undefined;
  /** Monotonic, never reset: a subscriber's mount baseline is a value of
   * this counter, so "published before I mounted" is decidable. */
  private publicationSequence = 0;
  private readonly listeners = new Set<() => void>();
  /** One acquisition per LIVE MspClient; internally scoped to the
   * composite (physicalGeneration, mspEpoch) identity. Keyed with the
   * client instance so a replacement session can never inherit the
   * previous physical session's mapping. */
  private readonly boxIds = new Map<string, {client: MspRequester; acquisition: BoxIdsAcquisition}>();
  private readonly lastGenerations = new Map<string, number>();

  constructor(options: FcToolsControllerOptions = {}) {
    this.coordinator = options.coordinator ?? mspSessionCoordinator;
    this.appStateOwner = options.appStateOwner ?? setupAppStateTelemetryOwner;
  }

  getPhase(): FcToolPhase {
    return this.phase;
  }

  isBusy(): boolean {
    return this.phase.kind !== 'IDLE';
  }

  /**
   * The raw stored outcome, IGNORING provenance and subscriber lifetime.
   * Diagnostics and controller-level tests only - never a UI source, and
   * deliberately not what the hook reads.
   */
  getLastOutcome(): FcToolOutcome | undefined {
    return this.publication?.outcome;
  }

  /** The current publication counter - a subscriber captures this when it
   * mounts and never sees anything published at or before it. */
  getPublicationSequence(): number {
    return this.publicationSequence;
  }

  /**
   * The outcome a MOUNTED subscriber for `sessionId` may show, given the
   * baseline it captured when it mounted.
   *
   * Hidden when: nothing is stored; it was published before this
   * subscriber mounted (so a remount can never replay or re-announce it);
   * it belongs to another screen's session; or a REPLACEMENT owner has
   * become current for that session. A transient detach with no
   * replacement revokes nothing.
   */
  getVisibleOutcome(sessionId: string, mountedAtSequence: number): FcToolOutcome | undefined {
    const published = this.publication;
    if (published === undefined) {
      return undefined;
    }
    if (published.sequence <= mountedAtSequence) {
      return undefined;
    }
    if (published.origin.sessionId !== sessionId) {
      return undefined;
    }
    return this.isRevoked(published.origin) ? undefined : published.outcome;
  }

  /**
   * True once a DIFFERENT owner is current for that session - a new
   * physical generation, or a new MSP epoch on the same generation.
   * Deliberately false while the session is merely absent (transient
   * detach with no replacement yet).
   */
  private isRevoked(origin: FcToolOutcomeOrigin): boolean {
    const key = this.coordinator.getSessionKey(origin.sessionId);
    if (key === undefined) {
      return origin.physicalGeneration < 0 ? false : false;
    }
    if (key.generation !== origin.physicalGeneration) {
      return true;
    }
    const client = this.coordinator.getActiveMspClient(origin.sessionId);
    if (client === undefined) {
      return false;
    }
    return client.getEpoch() !== origin.settledMspEpoch;
  }

  /** Captures the canonical composite identity that owns an action. */
  private captureOrigin(sessionId: string): FcToolOutcomeOrigin {
    const key = this.coordinator.getSessionKey(sessionId);
    const client = this.coordinator.getActiveMspClient(sessionId);
    const epoch = client?.getEpoch() ?? -1;
    return {
      sessionId,
      physicalGeneration: key?.generation ?? -1,
      mspEpoch: epoch,
      settledMspEpoch: epoch,
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Takes the shared mutex and opens the confirmation. Returns false -
   * changing nothing - when anything else already holds it, which is
   * exactly what makes a double tap a no-op. */
  requestConfirmation(sessionId: string, tool: FcToolId): boolean {
    if (this.phase.kind !== 'IDLE') {
      return false;
    }
    this.phase = {kind: 'CONFIRMING', tool, sessionId};
    // A new action supersedes the previous publication outright.
    this.publication = undefined;
    this.notify();
    return true;
  }

  /** Releases the mutex without sending anything. */
  cancel(): void {
    if (this.phase.kind !== 'CONFIRMING') {
      return;
    }
    const {tool, sessionId} = this.phase;
    // Same total contract as confirm(): capturing provenance must never
    // be able to leave the mutex held.
    let origin: FcToolOutcomeOrigin = {sessionId, physicalGeneration: -1, mspEpoch: -1, settledMspEpoch: -1};
    try {
      origin = this.captureOrigin(sessionId);
    } catch {
      // Fall through with the conservative sentinel origin.
    }
    this.settle({kind: 'CANCELLED', tool}, origin);
  }

  /**
   * Runs the one exclusive transaction. A second call while RUNNING is
   * ignored (the mutex is already held) and returns the outcome of the
   * run that is already in progress once it settles.
   */
  async confirm(): Promise<FcToolOutcome | null> {
    if (this.phase.kind !== 'CONFIRMING') {
      // A-4: fabricate nothing. No stored outcome, no notification, no
      // phase change, no guessed tool.
      return NO_PENDING_CONFIRMATION;
    }
    const {tool, sessionId} = this.phase;
    this.phase = {kind: 'RUNNING', tool, sessionId};
    this.notify();

    // A-3: total settle-once contract. EVERYTHING after the mutex is
    // taken - including capturing provenance - runs inside this guard,
    // so no unexpected synchronous throw or rejection anywhere can leave
    // the phase wedged. An unexpected failure is classified
    // conservatively: bytes may already have been handed to the
    // transport, so it is never a confirmed success and never a definite
    // failure, and nothing is retried.
    let origin: FcToolOutcomeOrigin = {
      sessionId,
      physicalGeneration: -1,
      mspEpoch: -1,
      settledMspEpoch: -1,
    };
    let outcome: FcToolOutcome = {kind: 'UNCONFIRMED', tool};
    try {
      // Provenance is captured BEFORE the transaction, so a detach or a
      // replacement during it cannot rewrite who the outcome belonged to.
      origin = this.captureOrigin(sessionId);
      outcome = await this.runTransaction(sessionId, tool);
    } catch {
      outcome = {kind: 'UNCONFIRMED', tool};
    } finally {
      // settle() is idempotent per action (it refuses once the phase is
      // no longer RUNNING), so this cannot double-publish.
      this.settle(outcome, origin);
    }
    return outcome;
  }

  private async runTransaction(sessionId: string, tool: FcToolId): Promise<FcToolOutcome> {
    this.pruneObsoleteSessions();
    const sessionKey = this.coordinator.getSessionKey(sessionId);
    const client = this.coordinator.getActiveMspClient(sessionId);
    const scheduler = this.coordinator.getTelemetryScheduler(sessionId);
    if (sessionKey === undefined || client === undefined || scheduler === undefined) {
      return {kind: 'SESSION_ENDED', tool};
    }
    const capturedGeneration = sessionKey.generation;
    const capturedEpoch = client.getEpoch();
    const identity: BoxIdsOwnerIdentity = {physicalGeneration: capturedGeneration, mspEpoch: capturedEpoch};

    // A generation change invalidates every mapping of the old one.
    const acquisition = this.boxIdsFor(sessionId, client);
    if (this.lastGenerations.get(sessionId) !== capturedGeneration) {
      const previous = this.lastGenerations.get(sessionId);
      if (previous !== undefined) {
        acquisition.clearGeneration(previous);
      }
      this.lastGenerations.set(sessionId, capturedGeneration);
    }

    const stillOwned = (): boolean =>
      this.coordinator.getSessionKey(sessionId)?.generation === capturedGeneration &&
      this.coordinator.getActiveMspClient(sessionId) === client &&
      client.getEpoch() === capturedEpoch;

    const operations = createMspOperationCoordinator(
      client,
      scheduler,
      {captureCurrent: () => this.coordinator.getSessionKey(sessionId)},
      {
        getContext: () => ({
          clientState: this.coordinator.getMspRecoveryState(sessionId) ?? 'DISCONNECTED',
          // Cached only - the AUTHORITATIVE armed check happens inside
          // execute() against a fresh reading.
          isArmed: false,
        }),
      },
    );

    const result = await operations.execute<'ACK'>({
      id: `fc-tool:${tool}:${sessionId}:${capturedGeneration}`,
      validate: context =>
        context.clientState === 'READY'
          ? {allowed: true}
          : {allowed: false, error: new FcToolPreflightRejection('RECOVERING')},
      sessionEffect: tool === 'REBOOT' ? 'EXPECT_REBOOT' : 'KEEP_SESSION',
      execute: async requester => {
        // Steps 4-6: app still active, ownership and identity unchanged.
        if (this.appStateOwner.getPhase() !== 'ACTIVE') {
          throw new FcToolPreflightRejection('BACKGROUNDED');
        }
        if (this.coordinator.getOwnershipState(sessionId) !== 'ACTIVE' || !stillOwned()) {
          throw new FcToolPreflightRejection('DISCONNECTED');
        }

        // The one-shot BOXIDS mapping may begin ONLY after a compatible
        // identity, so compatibility is checked before anything is
        // requested - and re-checked in the full gate below.
        if (this.compatibilityOf(sessionId) !== 'BETAFLIGHT_API_1_47') {
          throw new FcToolPreflightRejection(
            this.compatibilityOf(sessionId) === 'IDENTIFYING' ? 'IDENTIFYING' : 'INCOMPATIBLE',
          );
        }

        // A-2: the BOXIDS mapping is obtained BEFORE the fresh status
        // read, never after it. The forbidden order
        // STATUS_EX -> BOXIDS -> write would leave the readiness that
        // authorizes the write a full MSP round trip old.
        const mapping = await acquisition.acquire(identity, stillOwned);
        if (this.coordinator.getOwnershipState(sessionId) !== 'ACTIVE' || !stillOwned()) {
          throw new FcToolPreflightRejection('DISCONNECTED');
        }

        // ONE fresh reading. From here to the write there is NO awaited
        // MSP round trip: derivation and gating are synchronous.
        const fresh = await this.readFreshStatus(requester);
        const armedState: ArmedState =
          mapping.kind === 'READY'
            ? deriveArmedState(
                fresh.flightModeFlagsLow32,
                fresh.readiness.extraFlightModeFlagBytes,
                mapping.permanentIds,
              )
            : 'UNKNOWN';
        const gate = resolveFcToolAvailability(tool, {
          connected: true,
          appActive: this.appStateOwner.getPhase() === 'ACTIVE',
          busy: false,
          recovering: this.coordinator.getMspRecoveryState(sessionId) !== 'READY',
          compatibility: this.compatibilityOf(sessionId),
          dataState: 'FRESH',
          // A partially-present readiness tail invalidates the whole
          // preflight: nothing after the fixed prefix can be trusted, so
          // the write is refused and NOTHING is dispatched.
          readingMalformed: fresh.readiness.malformedTail === true,
          armedState,
          sensors: decodeSensorPresence(fresh.sensorPresenceMask) as readonly SensorPresenceBit[],
        });
        if (!gate.enabled) {
          // Step 10: nothing is sent.
          throw new FcToolPreflightRejection(gate.reason ?? 'ARMED_UNKNOWN');
        }
        // FINAL ownership boundary, evaluated synchronously in the same
        // turn as the dispatch below: app active, ownership ACTIVE, the
        // same composite identity, and the same EXACT MspClient instance.
        // MspClient.request() enqueues and, when READY and idle, hands
        // the bytes to transport.writeBytes() in this same synchronous
        // turn - so anything observed here is observed before any byte
        // can leave.
        if (this.appStateOwner.getPhase() !== 'ACTIVE') {
          throw new FcToolPreflightRejection('BACKGROUNDED');
        }
        if (
          this.coordinator.getOwnershipState(sessionId) !== 'ACTIVE' ||
          !stillOwned() ||
          this.coordinator.getActiveMspClient(sessionId) !== client
        ) {
          throw new FcToolPreflightRejection('DISCONNECTED');
        }

        // Step 11: exactly once, no retry anywhere in this function.
        try {
          await requester.request(COMMAND_FOR_TOOL[tool], EMPTY_PAYLOAD, {wireFormat: 'v1'});
        } catch (error) {
          const code = errorCodeOf(error);
          if (code === 'MSP_REMOTE_ERROR' || (code !== undefined && CONFIRMED_NOT_SENT_CODES.includes(code))) {
            throw error; // definite failure: rejected, or provably not sent
          }
          // Everything else (timeout, unknown write outcome, detach) may
          // still have reached the FC - especially for reboot.
          throw new MspOperationOutcomeUnknownError(error);
        }
        return 'ACK';
      },
    });

    // Step 12: the outcome belongs to the generation captured above.
    //
    // A SUCCEEDED result means the request RESOLVED through this
    // session's own MspClient - a valid acknowledgement genuinely
    // arrived from the captured generation (a replaced session's client
    // is disposed and its pending requests reject, so a resolved ack can
    // never come from a different one). A detach that happens AFTER that
    // ack must therefore not erase it: downgrading a confirmed
    // acknowledgement to "unconfirmed" would be less truthful, not more.
    // What the ack proves is bounded by the copy each outcome maps to -
    // acceptance, never completion, and never a physical reboot.
    switch (result.status) {
      case 'SUCCEEDED':
        return tool === 'REBOOT' ? {kind: 'REBOOT_REQUESTED'} : {kind: 'ACCEPTED', tool};
      case 'OUTCOME_UNKNOWN':
        return {kind: 'UNCONFIRMED', tool};
      case 'SESSION_ENDED':
        // A reboot that ends the session after dispatch is the expected
        // path, not a failure to report as one.
        return tool === 'REBOOT' ? {kind: 'UNCONFIRMED', tool} : {kind: 'SESSION_ENDED', tool};
      default:
        return result.error instanceof FcToolPreflightRejection
          ? {kind: 'REJECTED', tool, reason: result.error.reason}
          : {kind: 'FAILED', tool, error: result.error};
    }
  }

  private async readFreshStatus(requester: MspRequester) {
    const frame = await requester.request(MSP_STATUS_EX, EMPTY_PAYLOAD, {wireFormat: 'v1'});
    return decodeStatusExDiagnostics(frame.payload);
  }

  private compatibilityOf(sessionId: string): DiagnosticsCompatibility {
    const identification = this.coordinator.getIdentificationState(sessionId);
    if (identification.status === 'FAILED') {
      return 'IDENTIFICATION_FAILED';
    }
    if (identification.status !== 'SUCCEEDED') {
      return 'IDENTIFYING';
    }
    const {firmware, apiVersion} = identification.identity;
    return firmware.identifier === 'BTFL' && apiVersion.apiVersionMajor === 1 && apiVersion.apiVersionMinor === 47
      ? 'BETAFLIGHT_API_1_47'
      : 'OTHER_FIRMWARE_OR_API';
  }

  /**
   * A-5: drops per-session state whose owner no longer exists.
   *
   * The rule is exact rather than a heuristic bound: an entry is removed
   * only when the coordinator has NO session key and NO active client for
   * that sessionId (the session was torn down and not replaced), or when
   * the stored client is no longer the current one. A still-current
   * identity therefore always keeps its cached BOXIDS mapping, so pruning
   * can never cause a re-acquisition. Retention is bounded by the number
   * of sessions the coordinator itself still owns.
   *
   * Idempotent, and safe to run at any time: pruning session N after N+1
   * became current removes nothing belonging to N+1, because N+1's entry
   * is keyed by its own live client.
   */
  private pruneObsoleteSessions(): void {
    for (const sessionId of Array.from(this.boxIds.keys())) {
      const entry = this.boxIds.get(sessionId);
      const client = this.coordinator.getActiveMspClient(sessionId);
      const key = this.coordinator.getSessionKey(sessionId);
      if ((client === undefined && key === undefined) || (entry !== undefined && entry.client !== client)) {
        this.boxIds.delete(sessionId);
      }
    }
    for (const sessionId of Array.from(this.lastGenerations.keys())) {
      if (
        this.coordinator.getActiveMspClient(sessionId) === undefined &&
        this.coordinator.getSessionKey(sessionId) === undefined
      ) {
        this.lastGenerations.delete(sessionId);
      }
    }
  }

  /** Read-only diagnostic: how many sessions this controller still holds
   * identity state for. Exposes no mutable internals. */
  trackedSessionCount(): number {
    return Math.max(this.boxIds.size, this.lastGenerations.size);
  }

  private boxIdsFor(sessionId: string, client: MspRequester): BoxIdsAcquisition {
    const existing = this.boxIds.get(sessionId);
    if (existing !== undefined && existing.client === client) {
      return existing.acquisition;
    }
    const acquisition = new BoxIdsAcquisition(client);
    this.boxIds.set(sessionId, {client, acquisition});
    return acquisition;
  }

  /**
   * Kicks the at-most-once MSP_BOXIDS acquisition for the session's
   * CURRENT composite (physicalGeneration, mspEpoch) identity, so the
   * armed state the controls gate on can be proven at all. Idempotent
   * and safe to call from an effect on every render: BoxIdsAcquisition
   * itself enforces one request per identity, shares the in-flight
   * promise, and never retries inside an identity. It is NEVER polled,
   * and never runs before a compatible identification.
   */
  ensureBoxIdsMapping(sessionId: string): void {
    this.pruneObsoleteSessions();
    if (this.compatibilityOf(sessionId) !== 'BETAFLIGHT_API_1_47') {
      return;
    }
    if (this.coordinator.getOwnershipState(sessionId) !== 'ACTIVE') {
      return;
    }
    const sessionKey = this.coordinator.getSessionKey(sessionId);
    const client = this.coordinator.getActiveMspClient(sessionId);
    if (sessionKey === undefined || client === undefined) {
      return;
    }
    const identity: BoxIdsOwnerIdentity = {
      physicalGeneration: sessionKey.generation,
      mspEpoch: client.getEpoch(),
    };
    const acquisition = this.boxIdsFor(sessionId, client);
    if (acquisition.peek(identity) !== undefined || acquisition.requestCountFor(identity) > 0) {
      return; // already settled or already in flight for THIS identity
    }
    const stillOwned = (): boolean =>
      this.coordinator.getSessionKey(sessionId)?.generation === identity.physicalGeneration &&
      this.coordinator.getActiveMspClient(sessionId) === client &&
      client.getEpoch() === identity.mspEpoch;
    acquisition.acquire(identity, stillOwned).then(
      () => this.notify(),
      () => this.notify(),
    );
  }

  /**
   * The armed state for the CURRENT identity, from the already-acquired
   * mapping only - this never issues a request. UNKNOWN whenever the
   * mapping or the reading is missing; never guessed, and never derived
   * from the arming-disable flags.
   */
  peekArmedState(sessionId: string, status: MspStatusExDiagnostics | undefined): ArmedState {
    if (status === undefined) {
      return 'UNKNOWN';
    }
    const sessionKey = this.coordinator.getSessionKey(sessionId);
    const client = this.coordinator.getActiveMspClient(sessionId);
    const entry = this.boxIds.get(sessionId);
    if (sessionKey === undefined || client === undefined || entry === undefined || entry.client !== client) {
      return 'UNKNOWN';
    }
    const mapping = entry.acquisition.peek({
      physicalGeneration: sessionKey.generation,
      mspEpoch: client.getEpoch(),
    });
    if (mapping === undefined || mapping.kind !== 'READY') {
      return 'UNKNOWN';
    }
    return deriveArmedState(status.flightModeFlagsLow32, status.readiness.extraFlightModeFlagBytes, mapping.permanentIds);
  }

  /** The single settle point - the mutex is released here and nowhere
   * else, exactly once per action. */
  private settle(outcome: FcToolOutcome, capturedOrigin: FcToolOutcomeOrigin): void {
    if (this.phase.kind === 'IDLE') {
      return; // already settled - never publish or notify twice
    }
    this.phase = {kind: 'IDLE'};
    this.publicationSequence += 1;
    // Stamp the epoch the action ENDED on, so a desync the action itself
    // caused cannot revoke its own outcome.
    let settledEpoch = capturedOrigin.mspEpoch;
    try {
      settledEpoch = this.coordinator.getActiveMspClient(capturedOrigin.sessionId)?.getEpoch() ?? settledEpoch;
    } catch {
      // A coordinator lookup must never prevent the mutex from being
      // released; the captured epoch is the conservative fallback.
    }
    const origin: FcToolOutcomeOrigin = Object.freeze({...capturedOrigin, settledMspEpoch: settledEpoch});
    // Stored unconditionally, WITH its provenance: an acknowledgement
    // that genuinely arrived is never downgraded just because the
    // continuation later observes a detach. Whether it is VISIBLE is
    // decided by getVisibleOutcome(), not here.
    this.publication = Object.freeze({outcome, origin, sequence: this.publicationSequence});
    this.notify();
  }

  private notify(): void {
    for (const listener of Array.from(this.listeners)) {
      listener();
    }
  }
}

/** Module singleton, mirroring setupAppStateTelemetryOwner's precedent -
 * one shared mutex for the whole app, never one per screen instance. */
export const fcToolsController = new FcToolsController();
