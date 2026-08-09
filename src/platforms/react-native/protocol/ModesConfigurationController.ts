import {
  MSP_BOXIDS,
  MSP_BOXNAMES,
  MSP_EEPROM_WRITE,
  MSP_MODE_RANGES,
  MSP_MODE_RANGES_EXTRA,
  MSP_SET_MODE_RANGE,
  MSP_STATUS_EX,
  BoxIdsAcquisition,
  MspOperationOutcomeUnknownError,
  createModesConfigurationDraft,
  createMspOperationCoordinator,
  decodeModesConfiguration,
  decodeStatusExDiagnostics,
  encodeModeRangeWrites,
  modesDraftsEqual,
  modesSnapshotsEqual,
  validateModesDraft,
  type BoxIdsOwnerIdentity,
  type ModesConfigurationDraft,
  type MspModesConfiguration,
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
import {setupAppStateTelemetryOwner, type SetupAppStatePhase} from './setupAppStateTelemetryOwner';
import {
  acquireMotorConfigurationInterlock,
  MotorConfigurationTransactionInProgressError,
} from './motorConfigurationInterlock';

const EMPTY = new Uint8Array(0);
const DEFINITELY_NOT_SENT = new Set([
  'MSP_ENCODE_FAILED',
  'MSP_QUEUE_FULL',
  'MSP_TRANSPORT_QUEUE_FULL',
  'MSP_RECOVERY_REQUIRED',
  'MSP_RECOVERING',
  'MSP_REMOTE_ERROR',
]);

interface ModesClient extends MspRequester { getEpoch(): number }

export interface ModesSessionCoordinator {
  getOwnershipState(sessionId: string): MspSessionOwnershipState;
  getIdentificationState(sessionId: string): MspIdentificationState;
  getSessionKey(sessionId: string): SetupUiSessionKey | undefined;
  getActiveMspClient(sessionId: string): ModesClient | undefined;
  getTelemetryScheduler(sessionId: string): MspTelemetryScheduler | undefined;
  getMspRecoveryState(sessionId: string): MspClientState | undefined;
}

export interface ModesAppStateOwner { getPhase(): SetupAppStatePhase }

export type ModesBlockReason =
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

export type ModesWriteStage = {readonly kind: 'MODE_RANGE'; readonly index: number} | {readonly kind: 'EEPROM'};

export type ModesLoadOutcome =
  | {readonly kind: 'LOADED'; readonly snapshot: MspModesConfiguration}
  | {readonly kind: 'REJECTED'; readonly reason: ModesBlockReason}
  | {readonly kind: 'SESSION_ENDED'}
  | {readonly kind: 'FAILED'; readonly error: unknown};

export type ModesSaveOutcome =
  | {readonly kind: 'NO_CHANGES'; readonly snapshot: MspModesConfiguration}
  | {readonly kind: 'SAVED_VERIFIED'; readonly snapshot: MspModesConfiguration}
  | {readonly kind: 'SAVED_UNVERIFIED'; readonly error: unknown}
  | {readonly kind: 'REJECTED'; readonly reason: ModesBlockReason}
  | {readonly kind: 'UNCONFIRMED'; readonly stage: ModesWriteStage}
  | {readonly kind: 'SESSION_ENDED'}
  | {readonly kind: 'FAILED'; readonly error: unknown};

export interface ModesConfigurationControllerOptions {
  readonly coordinator?: ModesSessionCoordinator;
  readonly appStateOwner?: ModesAppStateOwner;
  readonly isMotorTestActive?: (sessionId: string) => boolean;
}

class ModesPreflightError extends Error {
  constructor(readonly reason: ModesBlockReason) {
    super(`Modes preflight rejected: ${reason}`);
    this.name = 'ModesPreflightError';
  }
}

interface AmbiguousModesCause {
  readonly kind: 'MODES_AMBIGUOUS_WRITE';
  readonly stage: ModesWriteStage;
}

class AmbiguousModesWriteError extends MspOperationOutcomeUnknownError {
  constructor(error: unknown, stage: ModesWriteStage) {
    super(Object.freeze({kind: 'MODES_AMBIGUOUS_WRITE', stage, error}));
  }
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String((error as {code: unknown}).code)
    : undefined;
}

function ambiguousCause(value: unknown): value is AmbiguousModesCause {
  return value !== null && typeof value === 'object' && 'kind' in value && value.kind === 'MODES_AMBIGUOUS_WRITE';
}

export class ModesConfigurationController {
  private readonly coordinator: ModesSessionCoordinator;
  private readonly appStateOwner: ModesAppStateOwner;
  private readonly isMotorTestActive: (sessionId: string) => boolean;
  private readonly boxIds = new Map<string, {client: ModesClient; acquisition: BoxIdsAcquisition}>();

  constructor(options: ModesConfigurationControllerOptions = {}) {
    this.coordinator = options.coordinator ?? mspSessionCoordinator;
    this.appStateOwner = options.appStateOwner ?? setupAppStateTelemetryOwner;
    this.isMotorTestActive = options.isMotorTestActive ?? isMotorTestSessionActive;
  }

  async load(key: SetupUiSessionKey): Promise<ModesLoadOutcome> {
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
      const result = await this.operations(key.sessionId, client, scheduler).execute<MspModesConfiguration>({
        id: `modes:load:${key.sessionId}:${key.generation}`,
        sessionEffect: 'KEEP_SESSION',
        validate: context => context.clientState === 'READY'
          ? {allowed: true}
          : {allowed: false, error: new ModesPreflightError('LINK_RECOVERING')},
        execute: async requester => {
          this.assertLive(key, client, epoch);
          return this.readSnapshot(requester);
        },
      });
      if (result.status === 'SUCCEEDED') return {kind: 'LOADED', snapshot: result.result};
      if (result.status === 'SESSION_ENDED' || result.status === 'OUTCOME_UNKNOWN') return {kind: 'SESSION_ENDED'};
      return result.error instanceof ModesPreflightError
        ? {kind: 'REJECTED', reason: result.error.reason}
        : {kind: 'FAILED', error: result.error};
    } finally {
      interlock.release();
    }
  }

  async save(key: SetupUiSessionKey, original: MspModesConfiguration, draft: ModesConfigurationDraft): Promise<ModesSaveOutcome> {
    if (modesDraftsEqual(createModesConfigurationDraft(original), draft)) return {kind: 'NO_CHANGES', snapshot: original};
    if (validateModesDraft(draft, original).length > 0) return {kind: 'REJECTED', reason: 'INVALID_CONFIGURATION'};
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
      const identity: BoxIdsOwnerIdentity = {physicalGeneration: key.generation, mspEpoch: epoch};
      const result = await this.operations(key.sessionId, client, scheduler).execute<{snapshot?: MspModesConfiguration; readbackError?: unknown}>({
        id: `modes:save:${key.sessionId}:${key.generation}`,
        sessionEffect: 'KEEP_SESSION',
        validate: context => context.clientState === 'READY'
          ? {allowed: true}
          : {allowed: false, error: new ModesPreflightError('LINK_RECOVERING')},
        execute: async requester => {
          this.assertLive(key, client, epoch);
          const fresh = await this.readSnapshot(requester);
          if (!modesSnapshotsEqual(fresh, original)) throw new ModesPreflightError('STALE_BASE');
          await this.assertDisarmed(key, client, epoch, requester, acquisition, identity);
          for (const write of encodeModeRangeWrites(original, draft)) {
            await this.writeOnce(requester, MSP_SET_MODE_RANGE, write.payload, {kind: 'MODE_RANGE', index: write.index});
          }
          await this.writeOnce(requester, MSP_EEPROM_WRITE, EMPTY, {kind: 'EEPROM'});
          try {
            const snapshot = await this.readSnapshot(requester);
            if (!modesDraftsEqual(createModesConfigurationDraft(snapshot), draft)) {
              throw new Error('Modes readback does not match saved configuration.');
            }
            return {snapshot};
          } catch (error) {
            return {readbackError: error};
          }
        },
      });
      if (result.status === 'SUCCEEDED') {
        return result.result.snapshot !== undefined
          ? {kind: 'SAVED_VERIFIED', snapshot: result.result.snapshot}
          : {kind: 'SAVED_UNVERIFIED', error: result.result.readbackError};
      }
      if (result.status === 'OUTCOME_UNKNOWN') {
        return ambiguousCause(result.reason)
          ? {kind: 'UNCONFIRMED', stage: result.reason.stage}
          : {kind: 'SESSION_ENDED'};
      }
      if (result.status === 'SESSION_ENDED') return {kind: 'SESSION_ENDED'};
      return result.error instanceof ModesPreflightError
        ? {kind: 'REJECTED', reason: result.error.reason}
        : {kind: 'FAILED', error: result.error};
    } finally {
      interlock.release();
    }
  }

  private async writeOnce(requester: MspRequester, command: number, payload: Uint8Array, stage: ModesWriteStage): Promise<void> {
    try {
      await requester.request(command, payload, {wireFormat: 'v1'});
    } catch (error) {
      const code = errorCode(error);
      if (code !== undefined && DEFINITELY_NOT_SENT.has(code)) throw error;
      throw new AmbiguousModesWriteError(error, stage);
    }
  }

  private capture(key: SetupUiSessionKey): {client: ModesClient; scheduler: MspTelemetryScheduler; epoch: number} | {reason: ModesBlockReason} {
    if (this.appStateOwner.getPhase() !== 'ACTIVE') return {reason: 'APP_BACKGROUNDED'};
    if (this.isMotorTestActive(key.sessionId)) return {reason: 'MOTOR_TEST_ACTIVE'};
    const identification = this.coordinator.getIdentificationState(key.sessionId);
    if (identification.status === 'IDLE' || identification.status === 'RUNNING') return {reason: 'IDENTIFYING'};
    if (
      identification.status !== 'SUCCEEDED' ||
      identification.identity.firmware.identifier !== 'BTFL' ||
      identification.identity.apiVersion.apiVersionMajor !== 1 ||
      identification.identity.apiVersion.apiVersionMinor !== 47
    ) return {reason: 'UNSUPPORTED_FIRMWARE'};
    const client = this.coordinator.getActiveMspClient(key.sessionId);
    const scheduler = this.coordinator.getTelemetryScheduler(key.sessionId);
    if (
      this.coordinator.getOwnershipState(key.sessionId) !== 'ACTIVE' ||
      this.coordinator.getSessionKey(key.sessionId)?.generation !== key.generation ||
      client === undefined || scheduler === undefined
    ) return {reason: 'DISCONNECTED'};
    if (this.coordinator.getMspRecoveryState(key.sessionId) !== 'READY') return {reason: 'LINK_RECOVERING'};
    return {client, scheduler, epoch: client.getEpoch()};
  }

  private assertLive(key: SetupUiSessionKey, client: ModesClient, epoch: number): void {
    if (this.appStateOwner.getPhase() !== 'ACTIVE') throw new ModesPreflightError('APP_BACKGROUNDED');
    if (this.isMotorTestActive(key.sessionId)) throw new ModesPreflightError('MOTOR_TEST_ACTIVE');
    if (
      this.coordinator.getOwnershipState(key.sessionId) !== 'ACTIVE' ||
      this.coordinator.getSessionKey(key.sessionId)?.generation !== key.generation ||
      this.coordinator.getActiveMspClient(key.sessionId) !== client ||
      client.getEpoch() !== epoch
    ) throw new ModesPreflightError('DISCONNECTED');
    if (this.coordinator.getMspRecoveryState(key.sessionId) !== 'READY') throw new ModesPreflightError('LINK_RECOVERING');
  }

  private operations(sessionId: string, client: ModesClient, scheduler: MspTelemetryScheduler) {
    return createMspOperationCoordinator(
      client,
      scheduler,
      {captureCurrent: () => this.coordinator.getSessionKey(sessionId)},
      {getContext: () => ({clientState: this.coordinator.getMspRecoveryState(sessionId) ?? 'DISCONNECTED', isArmed: false})},
    );
  }

  private boxIdsFor(sessionId: string, client: ModesClient): BoxIdsAcquisition {
    const existing = this.boxIds.get(sessionId);
    if (existing?.client === client) return existing.acquisition;
    const acquisition = new BoxIdsAcquisition(client);
    this.boxIds.set(sessionId, {client, acquisition});
    return acquisition;
  }

  private async assertDisarmed(
    key: SetupUiSessionKey,
    client: ModesClient,
    epoch: number,
    requester: MspRequester,
    acquisition: BoxIdsAcquisition,
    identity: BoxIdsOwnerIdentity,
  ): Promise<void> {
    const mapping = await acquisition.acquire(
      identity,
      () => this.coordinator.getSessionKey(key.sessionId)?.generation === key.generation &&
        this.coordinator.getActiveMspClient(key.sessionId) === client && client.getEpoch() === epoch,
    );
    this.assertLive(key, client, epoch);
    if (mapping.kind !== 'READY') throw new ModesPreflightError('ARMED_STATE_UNKNOWN');
    const frame = await requester.request(MSP_STATUS_EX, EMPTY, {wireFormat: 'v1'});
    const status = decodeStatusExDiagnostics(frame.payload);
    const armed = deriveArmedState(
      status.flightModeFlagsLow32,
      status.readiness.extraFlightModeFlagBytes,
      mapping.permanentIds,
    );
    if (armed === 'ARMED') throw new ModesPreflightError('FC_ARMED');
    if (armed !== 'DISARMED' || status.readiness.malformedTail) throw new ModesPreflightError('ARMED_STATE_UNKNOWN');
    this.assertLive(key, client, epoch);
  }

  private async readSnapshot(requester: MspRequester): Promise<MspModesConfiguration> {
    const names = await requester.request(MSP_BOXNAMES, EMPTY, {wireFormat: 'v1'});
    const boxIds = await requester.request(MSP_BOXIDS, EMPTY, {wireFormat: 'v1'});
    const ranges = await requester.request(MSP_MODE_RANGES, EMPTY, {wireFormat: 'v1'});
    const rangesExtra = await requester.request(MSP_MODE_RANGES_EXTRA, EMPTY, {wireFormat: 'v1'});
    return decodeModesConfiguration({
      names: names.payload,
      boxIds: boxIds.payload,
      ranges: ranges.payload,
      rangesExtra: rangesExtra.payload,
    });
  }
}

export const modesConfigurationController = new ModesConfigurationController();
