import {
  MSP_EEPROM_WRITE,
  MSP_SET_VTX_CONFIG,
  MSP_SET_VTXTABLE_BAND,
  MSP_SET_VTXTABLE_POWERLEVEL,
  MSP_STATUS_EX,
  MSP_VTX_CONFIG,
  MSP_VTXTABLE_BAND,
  MSP_VTXTABLE_POWERLEVEL,
  BoxIdsAcquisition,
  MspOperationOutcomeUnknownError,
  createMspOperationCoordinator,
  createVtxConfigurationDraft,
  decodeStatusExDiagnostics,
  decodeVtxBand,
  decodeVtxConfiguration,
  decodeVtxPowerLevel,
  encodeChangedVtxConfiguration,
  validateVtxDraft,
  vtxDraftsEqual,
  vtxSnapshotsEqual,
  type BoxIdsOwnerIdentity,
  type MspRequester,
  type MspTelemetryScheduler,
  type MspVtxSnapshot,
  type VtxConfigurationDraft,
  type VtxWriteGroup,
} from '../../../core';
import type { MspClientState } from '../../../core/protocol/mspClient';
import { deriveArmedState } from '../../../core/state/armingBlockers';
import { isMotorTestSessionActive } from './motorTestCapability';
import {isSupportedConfigurationApi} from './betaflightApiSupport';
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
const EMPTY = new Uint8Array(0);
const DEFINITELY_NOT_SENT = new Set([
  'MSP_ENCODE_FAILED',
  'MSP_QUEUE_FULL',
  'MSP_TRANSPORT_QUEUE_FULL',
  'MSP_RECOVERY_REQUIRED',
  'MSP_RECOVERING',
  'MSP_REMOTE_ERROR',
]);
interface VtxClient extends MspRequester {
  getEpoch(): number;
}
export interface VtxSessionCoordinator {
  getOwnershipState(sessionId: string): MspSessionOwnershipState;
  getIdentificationState(sessionId: string): MspIdentificationState;
  getSessionKey(sessionId: string): SetupUiSessionKey | undefined;
  getActiveMspClient(sessionId: string): VtxClient | undefined;
  getTelemetryScheduler(sessionId: string): MspTelemetryScheduler | undefined;
  getMspRecoveryState(sessionId: string): MspClientState | undefined;
}
export interface VtxAppStateOwner {
  getPhase(): SetupAppStatePhase;
}
export type VtxBlockReason =
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
export type VtxSaveStage =
  | { readonly group: VtxWriteGroup; readonly index?: number }
  | { readonly group: 'EEPROM' };
export type VtxLoadOutcome =
  | { readonly kind: 'LOADED'; readonly snapshot: MspVtxSnapshot }
  | { readonly kind: 'REJECTED'; readonly reason: VtxBlockReason }
  | { readonly kind: 'SESSION_ENDED' }
  | { readonly kind: 'FAILED'; readonly error: unknown };
export type VtxSaveOutcome =
  | { readonly kind: 'NO_CHANGES'; readonly snapshot: MspVtxSnapshot }
  | { readonly kind: 'SAVED_VERIFIED'; readonly snapshot: MspVtxSnapshot }
  | { readonly kind: 'SAVED_UNVERIFIED'; readonly error: unknown }
  | { readonly kind: 'REJECTED'; readonly reason: VtxBlockReason }
  | { readonly kind: 'UNCONFIRMED'; readonly stage: VtxSaveStage }
  | { readonly kind: 'SESSION_ENDED' }
  | { readonly kind: 'FAILED'; readonly error: unknown };
export interface VtxConfigurationControllerOptions {
  readonly coordinator?: VtxSessionCoordinator;
  readonly appStateOwner?: VtxAppStateOwner;
  readonly isMotorTestActive?: (sessionId: string) => boolean;
}
class VtxPreflightError extends Error {
  constructor(readonly reason: VtxBlockReason) {
    super(`VTX preflight rejected: ${reason}`);
    this.name = 'VtxPreflightError';
  }
}
interface AmbiguousVtxCause {
  readonly kind: 'VTX_AMBIGUOUS_WRITE';
  readonly stage: VtxSaveStage;
}
class AmbiguousVtxWriteError extends MspOperationOutcomeUnknownError {
  constructor(error: unknown, stage: VtxSaveStage) {
    super(Object.freeze({ kind: 'VTX_AMBIGUOUS_WRITE', stage, error }));
  }
}
function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}
function ambiguousCause(value: unknown): value is AmbiguousVtxCause {
  return (
    value !== null &&
    typeof value === 'object' &&
    'kind' in value &&
    value.kind === 'VTX_AMBIGUOUS_WRITE'
  );
}
export class VtxConfigurationController {
  private readonly coordinator: VtxSessionCoordinator;
  private readonly appStateOwner: VtxAppStateOwner;
  private readonly isMotorTestActive: (sessionId: string) => boolean;
  private readonly boxIds = new Map<
    string,
    { client: VtxClient; acquisition: BoxIdsAcquisition }
  >();
  constructor(options: VtxConfigurationControllerOptions = {}) {
    this.coordinator = options.coordinator ?? mspSessionCoordinator;
    this.appStateOwner = options.appStateOwner ?? setupAppStateTelemetryOwner;
    this.isMotorTestActive =
      options.isMotorTestActive ?? isMotorTestSessionActive;
  }
  async load(key: SetupUiSessionKey): Promise<VtxLoadOutcome> {
    const captured = this.capture(key);
    if ('reason' in captured)
      return { kind: 'REJECTED', reason: captured.reason };
    const { client, scheduler, epoch } = captured;
    let interlock;
    try {
      interlock = acquireMotorConfigurationInterlock(client);
    } catch (error) {
      return error instanceof MotorConfigurationTransactionInProgressError
        ? { kind: 'REJECTED', reason: 'CONFIGURATION_BUSY' }
        : { kind: 'FAILED', error };
    }
    try {
      const result = await this.operations(
        key.sessionId,
        client,
        scheduler,
      ).execute<MspVtxSnapshot>({
        id: `vtx:load:${key.sessionId}:${key.generation}`,
        sessionEffect: 'KEEP_SESSION',
        validate: context =>
          context.clientState === 'READY'
            ? { allowed: true }
            : {
                allowed: false,
                error: new VtxPreflightError('LINK_RECOVERING'),
              },
        execute: async requester => {
          this.assertLive(key, client, epoch);
          return this.readSnapshot(requester);
        },
      });
      if (result.status === 'SUCCEEDED')
        return { kind: 'LOADED', snapshot: result.result };
      if (
        result.status === 'SESSION_ENDED' ||
        result.status === 'OUTCOME_UNKNOWN'
      )
        return { kind: 'SESSION_ENDED' };
      return result.error instanceof VtxPreflightError
        ? { kind: 'REJECTED', reason: result.error.reason }
        : { kind: 'FAILED', error: result.error };
    } finally {
      interlock.release();
    }
  }
  async save(
    key: SetupUiSessionKey,
    original: MspVtxSnapshot,
    draft: VtxConfigurationDraft,
  ): Promise<VtxSaveOutcome> {
    if (vtxDraftsEqual(createVtxConfigurationDraft(original), draft))
      return { kind: 'NO_CHANGES', snapshot: original };
    if (validateVtxDraft(draft, original).length > 0)
      return { kind: 'REJECTED', reason: 'INVALID_CONFIGURATION' };
    const captured = this.capture(key);
    if ('reason' in captured)
      return { kind: 'REJECTED', reason: captured.reason };
    const { client, scheduler, epoch } = captured;
    let interlock;
    try {
      interlock = acquireMotorConfigurationInterlock(client);
    } catch (error) {
      return error instanceof MotorConfigurationTransactionInProgressError
        ? { kind: 'REJECTED', reason: 'CONFIGURATION_BUSY' }
        : { kind: 'FAILED', error };
    }
    try {
      const acquisition = this.boxIdsFor(key.sessionId, client);
      const identity: BoxIdsOwnerIdentity = {
        physicalGeneration: key.generation,
        mspEpoch: epoch,
      };
      const result = await this.operations(
        key.sessionId,
        client,
        scheduler,
      ).execute<{ snapshot?: MspVtxSnapshot; readbackError?: unknown }>({
        id: `vtx:save:${key.sessionId}:${key.generation}`,
        sessionEffect: 'KEEP_SESSION',
        validate: context =>
          context.clientState === 'READY'
            ? { allowed: true }
            : {
                allowed: false,
                error: new VtxPreflightError('LINK_RECOVERING'),
              },
        execute: async requester => {
          this.assertLive(key, client, epoch);
          const fresh = await this.readSnapshot(requester);
          if (!vtxSnapshotsEqual(fresh, original))
            throw new VtxPreflightError('STALE_BASE');
          await this.assertDisarmed(
            key,
            client,
            epoch,
            requester,
            acquisition,
            identity,
          );
          for (const write of encodeChangedVtxConfiguration(original, draft)) {
            const command =
              write.group === 'CONFIG'
                ? MSP_SET_VTX_CONFIG
                : write.group === 'BAND'
                ? MSP_SET_VTXTABLE_BAND
                : MSP_SET_VTXTABLE_POWERLEVEL;
            await this.writeOnce(requester, command, write.payload, {
              group: write.group,
              index: write.index,
            });
          }
          await this.writeOnce(requester, MSP_EEPROM_WRITE, EMPTY, {
            group: 'EEPROM',
          });
          try {
            const snapshot = await this.readSnapshot(requester);
            if (!vtxDraftsEqual(createVtxConfigurationDraft(snapshot), draft))
              throw new Error('VTX readback does not match saved values.');
            return { snapshot };
          } catch (error) {
            return { readbackError: error };
          }
        },
      });
      if (result.status === 'SUCCEEDED')
        return result.result.snapshot !== undefined
          ? { kind: 'SAVED_VERIFIED', snapshot: result.result.snapshot }
          : { kind: 'SAVED_UNVERIFIED', error: result.result.readbackError };
      if (result.status === 'OUTCOME_UNKNOWN')
        return ambiguousCause(result.reason)
          ? { kind: 'UNCONFIRMED', stage: result.reason.stage }
          : { kind: 'SESSION_ENDED' };
      if (result.status === 'SESSION_ENDED') return { kind: 'SESSION_ENDED' };
      return result.error instanceof VtxPreflightError
        ? { kind: 'REJECTED', reason: result.error.reason }
        : { kind: 'FAILED', error: result.error };
    } finally {
      interlock.release();
    }
  }
  private async readSnapshot(requester: MspRequester): Promise<MspVtxSnapshot> {
    const config = decodeVtxConfiguration(
      (await requester.request(MSP_VTX_CONFIG, EMPTY, { wireFormat: 'v1' }))
        .payload,
    );
    const bands = [];
    const powerLevels = [];
    if (config.tableAvailable) {
      for (let number = 1; number <= config.bandCount; number += 1)
        bands.push(
          decodeVtxBand(
            (
              await requester.request(
                MSP_VTXTABLE_BAND,
                Uint8Array.from([number]),
                { wireFormat: 'v1' },
              )
            ).payload,
          ),
        );
      for (let number = 1; number <= config.powerLevelCount; number += 1)
        powerLevels.push(
          decodeVtxPowerLevel(
            (
              await requester.request(
                MSP_VTXTABLE_POWERLEVEL,
                Uint8Array.from([number]),
                { wireFormat: 'v1' },
              )
            ).payload,
          ),
        );
    }
    return Object.freeze({
      config,
      bands: Object.freeze(bands),
      powerLevels: Object.freeze(powerLevels),
    });
  }
  private async writeOnce(
    requester: MspRequester,
    command: number,
    payload: Uint8Array,
    stage: VtxSaveStage,
  ): Promise<void> {
    try {
      await requester.request(command, payload, { wireFormat: 'v1' });
    } catch (error) {
      const code = errorCode(error);
      if (code !== undefined && DEFINITELY_NOT_SENT.has(code)) throw error;
      throw new AmbiguousVtxWriteError(error, stage);
    }
  }
  private capture(
    key: SetupUiSessionKey,
  ):
    | { client: VtxClient; scheduler: MspTelemetryScheduler; epoch: number }
    | { reason: VtxBlockReason } {
    if (this.appStateOwner.getPhase() !== 'ACTIVE')
      return { reason: 'APP_BACKGROUNDED' };
    if (this.isMotorTestActive(key.sessionId))
      return { reason: 'MOTOR_TEST_ACTIVE' };
    const identification = this.coordinator.getIdentificationState(
      key.sessionId,
    );
    if (identification.status === 'IDLE' || identification.status === 'RUNNING')
      return { reason: 'IDENTIFYING' };
    if (
      !isSupportedConfigurationApi(identification)
    )
      return { reason: 'UNSUPPORTED_FIRMWARE' };
    const client = this.coordinator.getActiveMspClient(key.sessionId);
    const scheduler = this.coordinator.getTelemetryScheduler(key.sessionId);
    if (
      this.coordinator.getOwnershipState(key.sessionId) !== 'ACTIVE' ||
      this.coordinator.getSessionKey(key.sessionId)?.generation !==
        key.generation ||
      client === undefined ||
      scheduler === undefined
    )
      return { reason: 'DISCONNECTED' };
    if (this.coordinator.getMspRecoveryState(key.sessionId) !== 'READY')
      return { reason: 'LINK_RECOVERING' };
    return { client, scheduler, epoch: client.getEpoch() };
  }
  private assertLive(
    key: SetupUiSessionKey,
    client: VtxClient,
    epoch: number,
  ): void {
    if (this.appStateOwner.getPhase() !== 'ACTIVE')
      throw new VtxPreflightError('APP_BACKGROUNDED');
    if (this.isMotorTestActive(key.sessionId))
      throw new VtxPreflightError('MOTOR_TEST_ACTIVE');
    if (
      this.coordinator.getOwnershipState(key.sessionId) !== 'ACTIVE' ||
      this.coordinator.getSessionKey(key.sessionId)?.generation !==
        key.generation ||
      this.coordinator.getActiveMspClient(key.sessionId) !== client ||
      client.getEpoch() !== epoch
    )
      throw new VtxPreflightError('DISCONNECTED');
    if (this.coordinator.getMspRecoveryState(key.sessionId) !== 'READY')
      throw new VtxPreflightError('LINK_RECOVERING');
  }
  private operations(
    sessionId: string,
    client: VtxClient,
    scheduler: MspTelemetryScheduler,
  ) {
    return createMspOperationCoordinator(
      client,
      scheduler,
      { captureCurrent: () => this.coordinator.getSessionKey(sessionId) },
      {
        getContext: () => ({
          clientState:
            this.coordinator.getMspRecoveryState(sessionId) ?? 'DISCONNECTED',
          isArmed: false,
        }),
      },
    );
  }
  private boxIdsFor(sessionId: string, client: VtxClient): BoxIdsAcquisition {
    const existing = this.boxIds.get(sessionId);
    if (existing?.client === client) return existing.acquisition;
    const acquisition = new BoxIdsAcquisition(client);
    this.boxIds.set(sessionId, { client, acquisition });
    return acquisition;
  }
  private async assertDisarmed(
    key: SetupUiSessionKey,
    client: VtxClient,
    epoch: number,
    requester: MspRequester,
    acquisition: BoxIdsAcquisition,
    identity: BoxIdsOwnerIdentity,
  ): Promise<void> {
    const mapping = await acquisition.acquire(
      identity,
      () =>
        this.coordinator.getSessionKey(key.sessionId)?.generation ===
          key.generation &&
        this.coordinator.getActiveMspClient(key.sessionId) === client &&
        client.getEpoch() === epoch,
    );
    this.assertLive(key, client, epoch);
    if (mapping.kind !== 'READY')
      throw new VtxPreflightError('ARMED_STATE_UNKNOWN');
    const frame = await requester.request(MSP_STATUS_EX, EMPTY, {
      wireFormat: 'v1',
    });
    const status = decodeStatusExDiagnostics(frame.payload);
    const armed = deriveArmedState(
      status.flightModeFlagsLow32,
      status.readiness.extraFlightModeFlagBytes,
      mapping.permanentIds,
    );
    if (armed === 'ARMED') throw new VtxPreflightError('FC_ARMED');
    if (armed !== 'DISARMED' || status.readiness.malformedTail)
      throw new VtxPreflightError('ARMED_STATE_UNKNOWN');
    this.assertLive(key, client, epoch);
  }
}
export const vtxConfigurationController = new VtxConfigurationController();
