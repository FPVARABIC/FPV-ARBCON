/**
 * BOARD ALIGNMENT - read, edit, write, prove.
 *
 * This is the same shape as every other configuration controller in this
 * directory, and deliberately so: an operator changing how the board is
 * mounted deserves exactly the guarantees they get when changing a PID.
 * The guards are not decoration - each one closes a way the app could
 * otherwise tell someone a value was saved when it was not:
 *
 *   ownership / generation / epoch   a reply from BEFORE a reconnect can
 *                                    never be credited to the session
 *                                    that is on screen now
 *   STALE_BASE                       the board is re-read immediately
 *                                    before writing; if it no longer
 *                                    matches what the operator was shown,
 *                                    the write is refused rather than
 *                                    silently overwriting someone else's
 *                                    change (or a value the FC itself
 *                                    changed after a reboot)
 *   assertDisarmed                   writing mounting angles to an ARMED
 *                                    aircraft is refused outright
 *   UNCONFIRMED                      a write whose fate is genuinely
 *                                    unknown is reported as unknown, not
 *                                    as success and not as failure
 *   readback                         after EEPROM, the board is read
 *                                    again and compared; a mismatch
 *                                    downgrades to SAVED_UNVERIFIED
 *
 * ONE WRITE, NOT THREE. MSP 39 carries all three angles in a single
 * frame, so there is no partial-write state to reason about: either the
 * triple landed or it did not.
 *
 * WHY THE 3D VIEW IS NOT CONSULTED HERE. The aircraft model is a
 * rendering of what the board reports; it is never an input to what gets
 * written. The truth flows one way - FC -> snapshot -> UI -> 3D - so a
 * visual bug can never become a value on someone's flight controller.
 *
 * =====================================================================
 * WHY THIS SAVE REBOOTS, AND WHY A READBACK ALONE WOULD BE A LIE
 * =====================================================================
 *
 * Storing board alignment and APPLYING it are two different things in
 * the firmware, and the difference is not cosmetic - it is the whole
 * behaviour of the feature.
 *
 *   MSP 39's handler only assigns the parameter group:
 *     boardAlignmentMutable()->rollDegrees  = sbufReadU16(src);
 *     boardAlignmentMutable()->pitchDegrees = sbufReadU16(src);
 *     boardAlignmentMutable()->yawDegrees   = sbufReadU16(src);
 *     break;                                        (msp.c:4113-4117)
 *   There is no re-initialisation call after it.
 *
 *   The rotation matrix that actually turns sensor readings is built
 *   ONCE, by initBoardAlignment() -> buildRotationMatrix()
 *   (sensors/boardalignment.c), and initBoardAlignment() is called from
 *   exactly one place in the entire firmware: fc/init.c:713, at boot.
 *
 *   MSP_EEPROM_WRITE does not close that gap either. writeEEPROM() ->
 *   writeUnmodifiedConfigToEEPROM() runs validateAndFixConfig() and
 *   writes flash; it never calls activateConfig(), and activateConfig()
 *   does not call initBoardAlignment() in any case (config/config.c).
 *
 * So after a write plus an EEPROM save, the board has STORED the new
 * angles while STILL FLYING on the old ones. And the readback would
 * happily confirm the new values - MSP 38 serialises the same parameter
 * group MSP 39 just assigned - which is precisely why a readback on its
 * own is not evidence that anything changed about the aircraft.
 *
 * Betaflight itself resolves this the same way. Board alignment has no
 * configurator UI; the only official way to set it is the CLI, and
 * `save` there is writeEEPROM() followed unconditionally by cliReboot()
 * unless the operator types `save noreboot` (cli.c:5045-5058). Rebooting
 * after the persist is therefore not an invention of ours - it is the
 * official path, and it is the only path on which the value takes
 * effect.
 *
 * The reboot is sent AFTER the readback, so the comparison still happens
 * against a live board, and a link that vanishes while the reboot is
 * being requested is treated as the reboot happening rather than as a
 * failure.
 */

import {
  BoxIdsAcquisition,
  MSP_BOARD_ALIGNMENT_CONFIG,
  MSP_EEPROM_WRITE,
  MSP_REBOOT,
  MSP_SET_BOARD_ALIGNMENT_CONFIG,
  MSP_STATUS_EX,
  MspOperationOutcomeUnknownError,
  boardAlignmentDraftsEqual,
  boardAlignmentSnapshotsEqual,
  createBoardAlignmentDraft,
  createMspOperationCoordinator,
  decodeBoardAlignment,
  decodeStatusExDiagnostics,
  encodeChangedBoardAlignment,
  validateBoardAlignmentDraft,
  type BoardAlignmentDraft,
  type BoxIdsOwnerIdentity,
  type MspBoardAlignmentSnapshot,
  type MspRequester,
  type MspTelemetryScheduler,
} from '../../../core';
import type {MspClientState} from '../../../core/protocol/mspClient';
import {deriveArmedState} from '../../../core/state/armingBlockers';
import {isMotorTestSessionActive} from './motorTestCapability';
import {
  mspSessionCoordinator,
  type MspIdentificationState,
  type MspSessionOwnershipState,
  type SetupUiSessionKey,
} from './MspSessionCoordinator';
import {
  setupAppStateTelemetryOwner,
  type SetupAppStatePhase,
} from './setupAppStateTelemetryOwner';
import {
  acquireMotorConfigurationInterlock,
  MotorConfigurationTransactionInProgressError,
} from './motorConfigurationInterlock';
import {isSupportedConfigurationApi} from './betaflightApiSupport';

const EMPTY = new Uint8Array(0);

/** Failures where the frame provably never reached the transport, so the
 *  board cannot have acted on it. Anything else is ambiguous. */
const DEFINITELY_NOT_SENT = new Set([
  'MSP_ENCODE_FAILED',
  'MSP_QUEUE_FULL',
  'MSP_TRANSPORT_QUEUE_FULL',
  'MSP_RECOVERY_REQUIRED',
  'MSP_RECOVERING',
  'MSP_REMOTE_ERROR',
]);

interface BoardAlignmentClient extends MspRequester {
  getEpoch(): number;
}

export interface BoardAlignmentSessionCoordinator {
  getOwnershipState(sessionId: string): MspSessionOwnershipState;
  getIdentificationState(sessionId: string): MspIdentificationState;
  getSessionKey(sessionId: string): SetupUiSessionKey | undefined;
  getActiveMspClient(sessionId: string): BoardAlignmentClient | undefined;
  getTelemetryScheduler(sessionId: string): MspTelemetryScheduler | undefined;
  getMspRecoveryState(sessionId: string): MspClientState | undefined;
}

export interface BoardAlignmentAppStateOwner {
  getPhase(): SetupAppStatePhase;
}

export type BoardAlignmentBlockReason =
  | 'DISCONNECTED'
  | 'IDENTIFYING'
  | 'UNSUPPORTED_FIRMWARE'
  | 'APP_BACKGROUNDED'
  | 'LINK_RECOVERING'
  | 'FC_ARMED'
  | 'ARMED_STATE_UNKNOWN'
  | 'MOTOR_TEST_ACTIVE'
  | 'CONFIGURATION_BUSY'
  | 'STALE_BASE'
  | 'INVALID_CONFIGURATION';

/** Which step a genuinely unknown outcome stopped at. */
export type BoardAlignmentSaveStage = 'BOARD_ALIGNMENT' | 'EEPROM';

export type BoardAlignmentLoadOutcome =
  | {readonly kind: 'LOADED'; readonly snapshot: MspBoardAlignmentSnapshot}
  | {readonly kind: 'REJECTED'; readonly reason: BoardAlignmentBlockReason}
  | {readonly kind: 'SESSION_ENDED'}
  | {readonly kind: 'FAILED'; readonly error: unknown};

export type BoardAlignmentSaveOutcome =
  | {readonly kind: 'NO_CHANGES'; readonly snapshot: MspBoardAlignmentSnapshot}
  | {
      readonly kind: 'SAVED_VERIFIED';
      readonly snapshot: MspBoardAlignmentSnapshot;
      /** Whether the board answered the restart request. Either way the
       *  angles are stored; this says whether we saw the step that makes
       *  them take effect begin. */
      readonly rebootAcknowledged: boolean;
    }
  | {
      readonly kind: 'SAVED_UNVERIFIED';
      readonly rebootAcknowledged: boolean;
      readonly error: unknown;
    }
  | {readonly kind: 'REJECTED'; readonly reason: BoardAlignmentBlockReason}
  | {readonly kind: 'UNCONFIRMED'; readonly stage: BoardAlignmentSaveStage}
  | {readonly kind: 'SESSION_ENDED'}
  | {readonly kind: 'FAILED'; readonly error: unknown};

export interface BoardAlignmentControllerOptions {
  readonly coordinator?: BoardAlignmentSessionCoordinator;
  readonly appStateOwner?: BoardAlignmentAppStateOwner;
  readonly isMotorTestActive?: (sessionId: string) => boolean;
}

class BoardAlignmentPreflightError extends Error {
  constructor(readonly reason: BoardAlignmentBlockReason) {
    super(`Board alignment preflight rejected: ${reason}`);
    this.name = 'BoardAlignmentPreflightError';
  }
}

interface AmbiguousBoardAlignmentCause {
  readonly kind: 'BOARD_ALIGNMENT_AMBIGUOUS_WRITE';
  readonly stage: BoardAlignmentSaveStage;
}

class AmbiguousBoardAlignmentWriteError extends MspOperationOutcomeUnknownError {
  constructor(error: unknown, stage: BoardAlignmentSaveStage) {
    super(
      Object.freeze({kind: 'BOARD_ALIGNMENT_AMBIGUOUS_WRITE', stage, error}),
    );
  }
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String((error as {code: unknown}).code)
    : undefined;
}

function ambiguousCause(value: unknown): value is AmbiguousBoardAlignmentCause {
  return (
    value !== null &&
    typeof value === 'object' &&
    'kind' in value &&
    value.kind === 'BOARD_ALIGNMENT_AMBIGUOUS_WRITE'
  );
}

export class BoardAlignmentController {
  private readonly coordinator: BoardAlignmentSessionCoordinator;
  private readonly appStateOwner: BoardAlignmentAppStateOwner;
  private readonly isMotorTestActive: (sessionId: string) => boolean;
  private readonly boxIds = new Map<
    string,
    {client: BoardAlignmentClient; acquisition: BoxIdsAcquisition}
  >();

  constructor(options: BoardAlignmentControllerOptions = {}) {
    this.coordinator = options.coordinator ?? mspSessionCoordinator;
    this.appStateOwner = options.appStateOwner ?? setupAppStateTelemetryOwner;
    this.isMotorTestActive = options.isMotorTestActive ?? isMotorTestSessionActive;
  }

  async load(key: SetupUiSessionKey): Promise<BoardAlignmentLoadOutcome> {
    const captured = this.capture(key);
    if ('reason' in captured) return {kind: 'REJECTED', reason: captured.reason};
    const {client, scheduler, epoch} = captured;
    let interlock;
    try {
      interlock = acquireMotorConfigurationInterlock(client);
    } catch (error) {
      return error instanceof MotorConfigurationTransactionInProgressError
        ? {kind: 'REJECTED', reason: 'CONFIGURATION_BUSY'}
        : {kind: 'FAILED', error};
    }
    try {
      const result = await this.operations(key.sessionId, client, scheduler).execute<MspBoardAlignmentSnapshot>({
        id: `boardAlignment:load:${key.sessionId}:${key.generation}`,
        sessionEffect: 'KEEP_SESSION',
        validate: context =>
          context.clientState === 'READY'
            ? {allowed: true}
            : {allowed: false, error: new BoardAlignmentPreflightError('LINK_RECOVERING')},
        execute: async requester => {
          this.assertLive(key, client, epoch);
          return this.readSnapshot(requester);
        },
      });
      if (result.status === 'SUCCEEDED') return {kind: 'LOADED', snapshot: result.result};
      if (result.status === 'SESSION_ENDED' || result.status === 'OUTCOME_UNKNOWN') {
        return {kind: 'SESSION_ENDED'};
      }
      return result.error instanceof BoardAlignmentPreflightError
        ? {kind: 'REJECTED', reason: result.error.reason}
        : {kind: 'FAILED', error: result.error};
    } finally {
      interlock.release();
    }
  }

  async save(
    key: SetupUiSessionKey,
    original: MspBoardAlignmentSnapshot,
    draft: BoardAlignmentDraft,
  ): Promise<BoardAlignmentSaveOutcome> {
    if (boardAlignmentDraftsEqual(createBoardAlignmentDraft(original), draft)) {
      return {kind: 'NO_CHANGES', snapshot: original};
    }
    if (validateBoardAlignmentDraft(draft).length > 0) {
      return {kind: 'REJECTED', reason: 'INVALID_CONFIGURATION'};
    }
    const captured = this.capture(key);
    if ('reason' in captured) return {kind: 'REJECTED', reason: captured.reason};
    const {client, scheduler, epoch} = captured;
    let interlock;
    try {
      interlock = acquireMotorConfigurationInterlock(client);
    } catch (error) {
      return error instanceof MotorConfigurationTransactionInProgressError
        ? {kind: 'REJECTED', reason: 'CONFIGURATION_BUSY'}
        : {kind: 'FAILED', error};
    }
    try {
      const acquisition = this.boxIdsFor(key.sessionId, client);
      const identity: BoxIdsOwnerIdentity = {
        physicalGeneration: key.generation,
        mspEpoch: epoch,
      };
      const result = await this.operations(key.sessionId, client, scheduler).execute<{
        snapshot?: MspBoardAlignmentSnapshot;
        readbackError?: unknown;
        rebootAcknowledged: boolean;
      }>({
        id: `boardAlignment:save:${key.sessionId}:${key.generation}`,
        sessionEffect: 'EXPECT_REBOOT',
        validate: context =>
          context.clientState === 'READY'
            ? {allowed: true}
            : {allowed: false, error: new BoardAlignmentPreflightError('LINK_RECOVERING')},
        execute: async requester => {
          this.assertLive(key, client, epoch);
          const fresh = await this.readSnapshot(requester);
          if (!boardAlignmentSnapshotsEqual(fresh, original)) {
            throw new BoardAlignmentPreflightError('STALE_BASE');
          }
          await this.assertDisarmed(key, client, epoch, requester, acquisition, identity);
          const payload = encodeChangedBoardAlignment(original, draft);
          // Unreachable while the equality guard above stands, and kept
          // as a hard stop rather than a `!`: if that guard is ever
          // loosened, this refuses to send an empty frame instead of
          // writing zeros to all three axes.
          if (payload === undefined) {
            return {snapshot: original, rebootAcknowledged: false};
          }
          await this.writeOnce(
            requester,
            MSP_SET_BOARD_ALIGNMENT_CONFIG,
            payload,
            'BOARD_ALIGNMENT',
          );
          await this.writeOnce(requester, MSP_EEPROM_WRITE, EMPTY, 'EEPROM');

          // Readback first, while the board is still up: this proves the
          // angles are STORED. The reboot after it is what makes them
          // take effect - see the header.
          let snapshot: MspBoardAlignmentSnapshot | undefined;
          let readbackError: unknown;
          try {
            snapshot = await this.readSnapshot(requester);
            if (!boardAlignmentDraftsEqual(createBoardAlignmentDraft(snapshot), draft)) {
              throw new Error('Board alignment readback does not match saved values.');
            }
          } catch (error) {
            snapshot = undefined;
            readbackError = error;
          }
          let rebootAcknowledged = false;
          try {
            await requester.request(MSP_REBOOT, EMPTY, {wireFormat: 'v1'});
            rebootAcknowledged = true;
          } catch {
            /* A link that disappears here is the requested reboot, not a
             * failure: the angles are already persisted. */
          }
          return {snapshot, readbackError, rebootAcknowledged};
        },
      });
      if (result.status === 'SUCCEEDED') {
        return result.result.snapshot !== undefined
          ? {
              kind: 'SAVED_VERIFIED',
              snapshot: result.result.snapshot,
              rebootAcknowledged: result.result.rebootAcknowledged,
            }
          : {
              kind: 'SAVED_UNVERIFIED',
              rebootAcknowledged: result.result.rebootAcknowledged,
              error: result.result.readbackError,
            };
      }
      if (result.status === 'OUTCOME_UNKNOWN') {
        return ambiguousCause(result.reason)
          ? {kind: 'UNCONFIRMED', stage: result.reason.stage}
          : {kind: 'SESSION_ENDED'};
      }
      if (result.status === 'SESSION_ENDED') return {kind: 'SESSION_ENDED'};
      return result.error instanceof BoardAlignmentPreflightError
        ? {kind: 'REJECTED', reason: result.error.reason}
        : {kind: 'FAILED', error: result.error};
    } finally {
      interlock.release();
    }
  }

  private async writeOnce(
    requester: MspRequester,
    command: number,
    payload: Uint8Array,
    stage: BoardAlignmentSaveStage,
  ): Promise<void> {
    try {
      await requester.request(command, payload, {wireFormat: 'v1'});
    } catch (error) {
      const code = errorCode(error);
      if (code !== undefined && DEFINITELY_NOT_SENT.has(code)) throw error;
      throw new AmbiguousBoardAlignmentWriteError(error, stage);
    }
  }

  private capture(
    key: SetupUiSessionKey,
  ):
    | {client: BoardAlignmentClient; scheduler: MspTelemetryScheduler; epoch: number}
    | {reason: BoardAlignmentBlockReason} {
    if (this.appStateOwner.getPhase() !== 'ACTIVE') return {reason: 'APP_BACKGROUNDED'};
    if (this.isMotorTestActive(key.sessionId)) return {reason: 'MOTOR_TEST_ACTIVE'};
    const identification = this.coordinator.getIdentificationState(key.sessionId);
    if (identification.status === 'IDLE' || identification.status === 'RUNNING') {
      return {reason: 'IDENTIFYING'};
    }
    if (!isSupportedConfigurationApi(identification)) return {reason: 'UNSUPPORTED_FIRMWARE'};
    const client = this.coordinator.getActiveMspClient(key.sessionId);
    const scheduler = this.coordinator.getTelemetryScheduler(key.sessionId);
    if (
      this.coordinator.getOwnershipState(key.sessionId) !== 'ACTIVE' ||
      this.coordinator.getSessionKey(key.sessionId)?.generation !== key.generation ||
      client === undefined ||
      scheduler === undefined
    ) {
      return {reason: 'DISCONNECTED'};
    }
    if (this.coordinator.getMspRecoveryState(key.sessionId) !== 'READY') {
      return {reason: 'LINK_RECOVERING'};
    }
    return {client, scheduler, epoch: client.getEpoch()};
  }

  private assertLive(
    key: SetupUiSessionKey,
    client: BoardAlignmentClient,
    epoch: number,
  ): void {
    if (this.appStateOwner.getPhase() !== 'ACTIVE') {
      throw new BoardAlignmentPreflightError('APP_BACKGROUNDED');
    }
    if (this.isMotorTestActive(key.sessionId)) {
      throw new BoardAlignmentPreflightError('MOTOR_TEST_ACTIVE');
    }
    if (
      this.coordinator.getOwnershipState(key.sessionId) !== 'ACTIVE' ||
      this.coordinator.getSessionKey(key.sessionId)?.generation !== key.generation ||
      this.coordinator.getActiveMspClient(key.sessionId) !== client ||
      client.getEpoch() !== epoch
    ) {
      throw new BoardAlignmentPreflightError('DISCONNECTED');
    }
    if (this.coordinator.getMspRecoveryState(key.sessionId) !== 'READY') {
      throw new BoardAlignmentPreflightError('LINK_RECOVERING');
    }
  }

  private operations(
    sessionId: string,
    client: BoardAlignmentClient,
    scheduler: MspTelemetryScheduler,
  ) {
    return createMspOperationCoordinator(
      client,
      scheduler,
      {captureCurrent: () => this.coordinator.getSessionKey(sessionId)},
      {
        getContext: () => ({
          clientState: this.coordinator.getMspRecoveryState(sessionId) ?? 'DISCONNECTED',
          isArmed: false,
        }),
      },
    );
  }

  private boxIdsFor(sessionId: string, client: BoardAlignmentClient): BoxIdsAcquisition {
    const existing = this.boxIds.get(sessionId);
    if (existing?.client === client) return existing.acquisition;
    const acquisition = new BoxIdsAcquisition(client);
    this.boxIds.set(sessionId, {client, acquisition});
    return acquisition;
  }

  private async assertDisarmed(
    key: SetupUiSessionKey,
    client: BoardAlignmentClient,
    epoch: number,
    requester: MspRequester,
    acquisition: BoxIdsAcquisition,
    identity: BoxIdsOwnerIdentity,
  ): Promise<void> {
    const mapping = await acquisition.acquire(
      identity,
      () =>
        this.coordinator.getSessionKey(key.sessionId)?.generation === key.generation &&
        this.coordinator.getActiveMspClient(key.sessionId) === client &&
        client.getEpoch() === epoch,
    );
    this.assertLive(key, client, epoch);
    if (mapping.kind !== 'READY') {
      throw new BoardAlignmentPreflightError('ARMED_STATE_UNKNOWN');
    }
    const frame = await requester.request(MSP_STATUS_EX, EMPTY, {wireFormat: 'v1'});
    const status = decodeStatusExDiagnostics(frame.payload);
    const armed = deriveArmedState(
      status.flightModeFlagsLow32,
      status.readiness.extraFlightModeFlagBytes,
      mapping.permanentIds,
    );
    if (armed === 'ARMED') throw new BoardAlignmentPreflightError('FC_ARMED');
    if (armed !== 'DISARMED' || status.readiness.malformedTail) {
      throw new BoardAlignmentPreflightError('ARMED_STATE_UNKNOWN');
    }
    this.assertLive(key, client, epoch);
  }

  private async readSnapshot(requester: MspRequester): Promise<MspBoardAlignmentSnapshot> {
    const frame = await requester.request(MSP_BOARD_ALIGNMENT_CONFIG, EMPTY, {
      wireFormat: 'v1',
    });
    return decodeBoardAlignment(frame.payload);
  }
}

export const boardAlignmentController = new BoardAlignmentController();
