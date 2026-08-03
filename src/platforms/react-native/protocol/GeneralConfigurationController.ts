import {
  MSP2_GET_TEXT,
  MSP2_SET_TEXT,
  MSP_ADVANCED_CONFIG,
  MSP_ARMING_CONFIG,
  MSP_BEEPER_CONFIG,
  MSP_BUILD_INFO,
  MSP_EEPROM_WRITE,
  MSP_FEATURE_CONFIG,
  MSP_REBOOT,
  MSP_RX_CONFIG,
  MSP_SET_ADVANCED_CONFIG,
  MSP_SET_ARMING_CONFIG,
  MSP_SET_BEEPER_CONFIG,
  MSP_SET_FEATURE_CONFIG,
  MSP_SET_RX_CONFIG,
  MSP_STATUS_EX,
  BoxIdsAcquisition,
  createGeneralConfigurationDraft,
  createMspOperationCoordinator,
  decodeAdvancedConfig,
  decodeArmingConfig,
  decodeBeeperConfig,
  decodeBuildOptions,
  decodeFeatureConfig,
  decodeMspText,
  decodeRxConfig,
  decodeStatusExDiagnostics,
  encodeChangedGeneralConfiguration,
  encodeMspTextRequest,
  encodeRxCameraAngle,
  generalConfigurationDraftsEqual,
  generalConfigurationSnapshotsEqual,
  validateGeneralConfigurationDraft,
  MspOperationOutcomeUnknownError,
  MSP_TEXT_CRAFT_NAME,
  MSP_TEXT_PILOT_NAME,
  type BoxIdsOwnerIdentity,
  type GeneralConfigurationDraft,
  type GeneralConfigurationSnapshot,
  type GeneralConfigurationWriteGroup,
  type MspRequester,
  type MspTelemetryScheduler,
} from '../../../core';
import { deriveArmedState } from '../../../core/state/armingBlockers';
import type { MspClientState } from '../../../core/protocol/mspClient';
import { readMotorTestCapability } from './motorTestCapability';
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

interface GeneralConfigurationClient extends MspRequester {
  getEpoch(): number;
}

export interface GeneralConfigurationSessionCoordinator {
  getOwnershipState(sessionId: string): MspSessionOwnershipState;
  getIdentificationState(sessionId: string): MspIdentificationState;
  getSessionKey(sessionId: string): SetupUiSessionKey | undefined;
  getActiveMspClient(
    sessionId: string,
  ): GeneralConfigurationClient | undefined;
  getTelemetryScheduler(sessionId: string): MspTelemetryScheduler | undefined;
  getMspRecoveryState(sessionId: string): MspClientState | undefined;
}

export interface GeneralConfigurationAppStateOwner {
  getPhase(): SetupAppStatePhase;
}

export type GeneralConfigurationBlockReason =
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

export type GeneralConfigurationLoadOutcome =
  | { readonly kind: 'LOADED'; readonly snapshot: GeneralConfigurationSnapshot }
  | { readonly kind: 'REJECTED'; readonly reason: GeneralConfigurationBlockReason }
  | { readonly kind: 'SESSION_ENDED' }
  | { readonly kind: 'FAILED'; readonly error: unknown };

export type GeneralConfigurationSaveStage =
  | GeneralConfigurationWriteGroup
  | 'EEPROM';

export type GeneralConfigurationSaveOutcome =
  | { readonly kind: 'NO_CHANGES'; readonly snapshot: GeneralConfigurationSnapshot }
  | {
      readonly kind: 'SAVED_VERIFIED';
      readonly snapshot: GeneralConfigurationSnapshot;
      readonly rebootAcknowledged: boolean;
    }
  | {
      readonly kind: 'SAVED_UNVERIFIED';
      readonly rebootAcknowledged: boolean;
      readonly error: unknown;
    }
  | { readonly kind: 'REJECTED'; readonly reason: GeneralConfigurationBlockReason }
  | { readonly kind: 'UNCONFIRMED'; readonly stage: GeneralConfigurationSaveStage }
  | { readonly kind: 'SESSION_ENDED' }
  | { readonly kind: 'FAILED'; readonly error: unknown };

export interface GeneralConfigurationControllerOptions {
  readonly coordinator?: GeneralConfigurationSessionCoordinator;
  readonly appStateOwner?: GeneralConfigurationAppStateOwner;
  readonly isMotorTestActive?: (sessionId: string) => boolean;
}

class GeneralConfigurationPreflightError extends Error {
  constructor(readonly reason: GeneralConfigurationBlockReason) {
    super(`General configuration preflight rejected: ${reason}`);
    this.name = 'GeneralConfigurationPreflightError';
  }
}

interface AmbiguousGeneralConfigurationCause {
  readonly kind: 'GENERAL_CONFIGURATION_AMBIGUOUS_WRITE';
  readonly stage: GeneralConfigurationSaveStage;
}

class AmbiguousGeneralConfigurationWriteError extends MspOperationOutcomeUnknownError {
  constructor(error: unknown, stage: GeneralConfigurationSaveStage) {
    super(
      Object.freeze({
        kind: 'GENERAL_CONFIGURATION_AMBIGUOUS_WRITE',
        stage,
        error,
      }),
    );
  }
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function definitelyNotApplied(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && DEFINITELY_NOT_SENT.has(code);
}

function ambiguousCause(
  value: unknown,
): value is AmbiguousGeneralConfigurationCause {
  return (
    value !== null &&
    typeof value === 'object' &&
    'kind' in value &&
    value.kind === 'GENERAL_CONFIGURATION_AMBIGUOUS_WRITE'
  );
}

function defaultMotorTestActive(sessionId: string): boolean {
  const snapshot = readMotorTestCapability(sessionId)
    ?.lifecycleStopPort()
    ?.getSnapshot();
  return (
    snapshot !== undefined &&
    (snapshot.phase === 'PREPARING' ||
      snapshot.phase === 'ACTIVE' ||
      snapshot.phase === 'CLOSING' ||
      snapshot.pulse.mayHaveReachedFc ||
      snapshot.machine?.name === 'Starting' ||
      snapshot.machine?.name === 'Pulsing' ||
      snapshot.machine?.name === 'Stopping')
  );
}

const COMMAND_FOR_GROUP: Readonly<
  Record<GeneralConfigurationWriteGroup, { command: number; wireFormat: 'v1' | 'v2' }>
> = Object.freeze({
  FEATURE: Object.freeze({ command: MSP_SET_FEATURE_CONFIG, wireFormat: 'v1' }),
  BEEPER: Object.freeze({ command: MSP_SET_BEEPER_CONFIG, wireFormat: 'v1' }),
  ARMING: Object.freeze({ command: MSP_SET_ARMING_CONFIG, wireFormat: 'v1' }),
  CRAFT_NAME: Object.freeze({ command: MSP2_SET_TEXT, wireFormat: 'v2' }),
  PILOT_NAME: Object.freeze({ command: MSP2_SET_TEXT, wireFormat: 'v2' }),
  RX: Object.freeze({ command: MSP_SET_RX_CONFIG, wireFormat: 'v1' }),
  ADVANCED: Object.freeze({ command: MSP_SET_ADVANCED_CONFIG, wireFormat: 'v1' }),
});

export class GeneralConfigurationController {
  private readonly coordinator: GeneralConfigurationSessionCoordinator;
  private readonly appStateOwner: GeneralConfigurationAppStateOwner;
  private readonly isMotorTestActive: (sessionId: string) => boolean;
  private readonly boxIds = new Map<
    string,
    { client: GeneralConfigurationClient; acquisition: BoxIdsAcquisition }
  >();

  constructor(options: GeneralConfigurationControllerOptions = {}) {
    this.coordinator = options.coordinator ?? mspSessionCoordinator;
    this.appStateOwner = options.appStateOwner ?? setupAppStateTelemetryOwner;
    this.isMotorTestActive =
      options.isMotorTestActive ?? defaultMotorTestActive;
  }

  async load(
    sessionKey: SetupUiSessionKey,
  ): Promise<GeneralConfigurationLoadOutcome> {
    const captured = this.capture(sessionKey);
    if ('reason' in captured)
      return { kind: 'REJECTED', reason: captured.reason };
    const { client, scheduler, epoch, identity } = captured;
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
        sessionKey.sessionId,
        client,
        scheduler,
      ).execute<GeneralConfigurationSnapshot>({
        id: `configuration:load:${sessionKey.sessionId}:${sessionKey.generation}`,
        sessionEffect: 'KEEP_SESSION',
        validate: context =>
          context.clientState === 'READY'
            ? { allowed: true }
            : {
                allowed: false,
                error: new GeneralConfigurationPreflightError(
                  'LINK_RECOVERING',
                ),
              },
        execute: async requester => {
          this.assertLive(sessionKey, client, epoch);
          return this.readSnapshot(requester, identity.board.gyroSampleRateHz);
        },
      });
      if (result.status === 'SUCCEEDED')
        return { kind: 'LOADED', snapshot: result.result };
      if (
        result.status === 'SESSION_ENDED' ||
        result.status === 'OUTCOME_UNKNOWN'
      )
        return { kind: 'SESSION_ENDED' };
      return result.error instanceof GeneralConfigurationPreflightError
        ? { kind: 'REJECTED', reason: result.error.reason }
        : { kind: 'FAILED', error: result.error };
    } finally {
      interlock.release();
    }
  }

  async save(
    sessionKey: SetupUiSessionKey,
    original: GeneralConfigurationSnapshot,
    draft: GeneralConfigurationDraft,
  ): Promise<GeneralConfigurationSaveOutcome> {
    const originalDraft = createGeneralConfigurationDraft(original);
    if (generalConfigurationDraftsEqual(originalDraft, draft))
      return { kind: 'NO_CHANGES', snapshot: original };
    if (validateGeneralConfigurationDraft(original, draft).length > 0)
      return { kind: 'REJECTED', reason: 'INVALID_CONFIGURATION' };
    const writes = encodeChangedGeneralConfiguration(original, draft);
    const captured = this.capture(sessionKey);
    if ('reason' in captured)
      return { kind: 'REJECTED', reason: captured.reason };
    const { client, scheduler, epoch, identity } = captured;
    let interlock;
    try {
      interlock = acquireMotorConfigurationInterlock(client);
    } catch (error) {
      return error instanceof MotorConfigurationTransactionInProgressError
        ? { kind: 'REJECTED', reason: 'CONFIGURATION_BUSY' }
        : { kind: 'FAILED', error };
    }
    try {
      const acquisition = this.boxIdsFor(sessionKey.sessionId, client);
      const ownerIdentity: BoxIdsOwnerIdentity = {
        physicalGeneration: sessionKey.generation,
        mspEpoch: epoch,
      };
      const result = await this.operations(
        sessionKey.sessionId,
        client,
        scheduler,
      ).execute<{
        snapshot?: GeneralConfigurationSnapshot;
        readbackError?: unknown;
        rebootAcknowledged: boolean;
      }>({
        id: `configuration:save:${sessionKey.sessionId}:${sessionKey.generation}`,
        sessionEffect: 'EXPECT_REBOOT',
        validate: context =>
          context.clientState === 'READY'
            ? { allowed: true }
            : {
                allowed: false,
                error: new GeneralConfigurationPreflightError(
                  'LINK_RECOVERING',
                ),
              },
        execute: async requester => {
          this.assertLive(sessionKey, client, epoch);
          const fresh = await this.readSnapshot(
            requester,
            identity.board.gyroSampleRateHz,
          );
          if (!generalConfigurationSnapshotsEqual(fresh, original))
            throw new GeneralConfigurationPreflightError('STALE_BASE');
          await this.assertDisarmed(
            sessionKey,
            client,
            epoch,
            requester,
            acquisition,
            ownerIdentity,
          );
          for (const write of writes) {
            const command = COMMAND_FOR_GROUP[write.group];
            await this.writeOnce(
              requester,
              command.command,
              write.payload,
              command.wireFormat,
              write.group,
            );
          }
          await this.writeOnce(
            requester,
            MSP_EEPROM_WRITE,
            EMPTY,
            'v1',
            'EEPROM',
          );

          let snapshot: GeneralConfigurationSnapshot | undefined;
          let readbackError: unknown;
          try {
            snapshot = await this.readSnapshot(
              requester,
              identity.board.gyroSampleRateHz,
            );
            const expected = Object.freeze({
              ...original,
              featureMaskRaw: draft.featureMaskRaw,
              arming: Object.freeze({
                ...original.arming,
                autoDisarmDelaySeconds: draft.autoDisarmDelaySeconds,
                smallAngleDegrees: draft.smallAngleDegrees,
                gyroCalibrationOnFirstArm:
                  draft.gyroCalibrationOnFirstArm,
              }),
              beeper: Object.freeze({
                disabledMask: draft.disabledBeeperMask,
                disabledDshotBeaconMask: draft.disabledDshotBeaconMask,
                dshotBeaconTone: draft.dshotBeaconTone,
              }),
              advanced: Object.freeze({
                ...original.advanced,
                pidProcessDenom: draft.pidProcessDenom,
              }),
              rx: Object.freeze({
                ...original.rx,
                fpvCameraAngleDegrees: draft.fpvCameraAngleDegrees,
                raw: encodeRxCameraAngle(
                  original.rx,
                  draft.fpvCameraAngleDegrees,
                ),
              }),
              craftName: draft.craftName,
              pilotName: draft.pilotName,
            });
            if (!generalConfigurationSnapshotsEqual(snapshot, expected)) {
              throw new Error(
                'General configuration readback does not match the saved draft.',
              );
            }
          } catch (error) {
            snapshot = undefined;
            readbackError = error;
          }
          let rebootAcknowledged = false;
          try {
            await requester.request(MSP_REBOOT, EMPTY, { wireFormat: 'v1' });
            rebootAcknowledged = true;
          } catch {
            // EEPROM is already acknowledged; a dropped link can be reboot.
          }
          return { snapshot, readbackError, rebootAcknowledged };
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
      if (result.status === 'OUTCOME_UNKNOWN')
        return ambiguousCause(result.reason)
          ? { kind: 'UNCONFIRMED', stage: result.reason.stage }
          : { kind: 'SESSION_ENDED' };
      if (result.status === 'SESSION_ENDED') return { kind: 'SESSION_ENDED' };
      return result.error instanceof GeneralConfigurationPreflightError
        ? { kind: 'REJECTED', reason: result.error.reason }
        : { kind: 'FAILED', error: result.error };
    } finally {
      interlock.release();
    }
  }

  private async readSnapshot(
    requester: MspRequester,
    gyroSampleRateHz?: number,
  ): Promise<GeneralConfigurationSnapshot> {
    const featureMaskRaw = decodeFeatureConfig(
      (await requester.request(MSP_FEATURE_CONFIG, EMPTY, { wireFormat: 'v1' }))
        .payload,
    ).enabledFeaturesRaw;
    const beeper = decodeBeeperConfig(
      (await requester.request(MSP_BEEPER_CONFIG, EMPTY, { wireFormat: 'v1' }))
        .payload,
    );
    const arming = decodeArmingConfig(
      (await requester.request(MSP_ARMING_CONFIG, EMPTY, { wireFormat: 'v1' }))
        .payload,
    );
    const craftName = await this.readText(requester, MSP_TEXT_CRAFT_NAME);
    const pilotName = await this.readText(requester, MSP_TEXT_PILOT_NAME);
    const rx = decodeRxConfig(
      (await requester.request(MSP_RX_CONFIG, EMPTY, { wireFormat: 'v1' }))
        .payload,
    );
    const advanced = decodeAdvancedConfig(
      (await requester.request(MSP_ADVANCED_CONFIG, EMPTY, { wireFormat: 'v1' }))
        .payload,
    );
    const buildOptionIds = decodeBuildOptions(
      (await requester.request(MSP_BUILD_INFO, EMPTY, { wireFormat: 'v1' }))
        .payload,
    ).optionIds;
    return Object.freeze({
      featureMaskRaw,
      beeper,
      arming,
      craftName,
      pilotName,
      rx,
      advanced,
      buildOptionIds,
      gyroSampleRateHz,
    });
  }

  private async readText(
    requester: MspRequester,
    type: number,
  ): Promise<string> {
    const decoded = decodeMspText(
      (
        await requester.request(MSP2_GET_TEXT, encodeMspTextRequest(type), {
          wireFormat: 'v2',
        })
      ).payload,
    );
    if (decoded.type !== type)
      throw new Error(`MSP2_GET_TEXT returned type ${decoded.type}, expected ${type}.`);
    return decoded.value;
  }

  private async writeOnce(
    requester: MspRequester,
    command: number,
    payload: Uint8Array,
    wireFormat: 'v1' | 'v2',
    stage: GeneralConfigurationSaveStage,
  ): Promise<void> {
    try {
      await requester.request(command, payload, { wireFormat });
    } catch (error) {
      if (definitelyNotApplied(error)) throw error;
      throw new AmbiguousGeneralConfigurationWriteError(error, stage);
    }
  }

  private capture(
    sessionKey: SetupUiSessionKey,
  ):
    | {
        client: GeneralConfigurationClient;
        scheduler: MspTelemetryScheduler;
        epoch: number;
        identity: Extract<MspIdentificationState, { status: 'SUCCEEDED' }>['identity'];
      }
    | { reason: GeneralConfigurationBlockReason } {
    if (this.appStateOwner.getPhase() !== 'ACTIVE')
      return { reason: 'APP_BACKGROUNDED' };
    if (this.isMotorTestActive(sessionKey.sessionId))
      return { reason: 'MOTOR_TEST_ACTIVE' };
    const identification = this.coordinator.getIdentificationState(
      sessionKey.sessionId,
    );
    if (identification.status === 'IDLE' || identification.status === 'RUNNING')
      return { reason: 'IDENTIFYING' };
    if (
      identification.status !== 'SUCCEEDED' ||
      identification.identity.firmware.identifier !== 'BTFL' ||
      identification.identity.apiVersion.apiVersionMajor !== 1 ||
      identification.identity.apiVersion.apiVersionMinor !== 47
    )
      return { reason: 'UNSUPPORTED_FIRMWARE' };
    const currentKey = this.coordinator.getSessionKey(sessionKey.sessionId);
    const client = this.coordinator.getActiveMspClient(sessionKey.sessionId);
    const scheduler = this.coordinator.getTelemetryScheduler(
      sessionKey.sessionId,
    );
    if (
      this.coordinator.getOwnershipState(sessionKey.sessionId) !== 'ACTIVE' ||
      currentKey?.generation !== sessionKey.generation ||
      client === undefined ||
      scheduler === undefined
    )
      return { reason: 'DISCONNECTED' };
    if (this.coordinator.getMspRecoveryState(sessionKey.sessionId) !== 'READY')
      return { reason: 'LINK_RECOVERING' };
    return {
      client,
      scheduler,
      epoch: client.getEpoch(),
      identity: identification.identity,
    };
  }

  private assertLive(
    key: SetupUiSessionKey,
    client: GeneralConfigurationClient,
    epoch: number,
  ): void {
    if (this.appStateOwner.getPhase() !== 'ACTIVE')
      throw new GeneralConfigurationPreflightError('APP_BACKGROUNDED');
    if (this.isMotorTestActive(key.sessionId))
      throw new GeneralConfigurationPreflightError('MOTOR_TEST_ACTIVE');
    if (
      this.coordinator.getOwnershipState(key.sessionId) !== 'ACTIVE' ||
      this.coordinator.getSessionKey(key.sessionId)?.generation !==
        key.generation ||
      this.coordinator.getActiveMspClient(key.sessionId) !== client ||
      client.getEpoch() !== epoch
    )
      throw new GeneralConfigurationPreflightError('DISCONNECTED');
    if (this.coordinator.getMspRecoveryState(key.sessionId) !== 'READY')
      throw new GeneralConfigurationPreflightError('LINK_RECOVERING');
  }

  private operations(
    sessionId: string,
    client: GeneralConfigurationClient,
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

  private boxIdsFor(
    sessionId: string,
    client: GeneralConfigurationClient,
  ): BoxIdsAcquisition {
    const existing = this.boxIds.get(sessionId);
    if (existing?.client === client) return existing.acquisition;
    const acquisition = new BoxIdsAcquisition(client);
    this.boxIds.set(sessionId, { client, acquisition });
    return acquisition;
  }

  private async assertDisarmed(
    key: SetupUiSessionKey,
    client: GeneralConfigurationClient,
    epoch: number,
    requester: MspRequester,
    acquisition: BoxIdsAcquisition,
    identity: BoxIdsOwnerIdentity,
  ): Promise<void> {
    const stillOwned = () =>
      this.coordinator.getSessionKey(key.sessionId)?.generation ===
        key.generation &&
      this.coordinator.getActiveMspClient(key.sessionId) === client &&
      client.getEpoch() === epoch;
    const mapping = await acquisition.acquire(identity, stillOwned);
    this.assertLive(key, client, epoch);
    if (mapping.kind !== 'READY')
      throw new GeneralConfigurationPreflightError('ARMED_STATE_UNKNOWN');
    const frame = await requester.request(MSP_STATUS_EX, EMPTY, {
      wireFormat: 'v1',
    });
    const status = decodeStatusExDiagnostics(frame.payload);
    const armed = deriveArmedState(
      status.flightModeFlagsLow32,
      status.readiness.extraFlightModeFlagBytes,
      mapping.permanentIds,
    );
    if (armed === 'ARMED')
      throw new GeneralConfigurationPreflightError('FC_ARMED');
    if (armed !== 'DISARMED' || status.readiness.malformedTail)
      throw new GeneralConfigurationPreflightError('ARMED_STATE_UNKNOWN');
    this.assertLive(key, client, epoch);
  }
}

export const generalConfigurationController =
  new GeneralConfigurationController();
