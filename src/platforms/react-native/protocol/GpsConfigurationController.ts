import {
  MSP2_COMMON_SERIAL_CONFIG,
  MSP_EEPROM_WRITE,
  MSP_FEATURE_CONFIG,
  MSP_GPS_CONFIG,
  MSP_REBOOT,
  MSP_SET_FEATURE_CONFIG,
  MSP_SET_GPS_CONFIG,
  MSP_STATUS_EX,
  BoxIdsAcquisition,
  createMspOperationCoordinator,
  decodeFeatureConfig,
  decodeGpsConfiguration,
  decodeSerialPorts,
  decodeStatusExDiagnostics,
  deriveGpsFeatureMask,
  encodeGpsConfiguration,
  gpsConfigurationsEqual,
  gpsDraftsEqual,
  validateGpsDraft,
  MspOperationOutcomeUnknownError,
  type BoxIdsOwnerIdentity,
  type GpsConfigurationDraft,
  type GpsConfigurationSnapshot,
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

interface GpsClient extends MspRequester {
  getEpoch(): number;
}

export interface GpsSessionCoordinator {
  getOwnershipState(sessionId: string): MspSessionOwnershipState;
  getIdentificationState(sessionId: string): MspIdentificationState;
  getSessionKey(sessionId: string): SetupUiSessionKey | undefined;
  getActiveMspClient(sessionId: string): GpsClient | undefined;
  getTelemetryScheduler(sessionId: string): MspTelemetryScheduler | undefined;
  getMspRecoveryState(sessionId: string): MspClientState | undefined;
}

export interface GpsAppStateOwner {
  getPhase(): SetupAppStatePhase;
}

export type GpsBlockReason =
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

export type GpsLoadOutcome =
  | { readonly kind: 'LOADED'; readonly snapshot: GpsConfigurationSnapshot }
  | { readonly kind: 'REJECTED'; readonly reason: GpsBlockReason }
  | { readonly kind: 'SESSION_ENDED' }
  | { readonly kind: 'FAILED'; readonly error: unknown };

export type GpsSaveOutcome =
  | { readonly kind: 'NO_CHANGES'; readonly snapshot: GpsConfigurationSnapshot }
  | {
      readonly kind: 'SAVED_VERIFIED';
      readonly snapshot: GpsConfigurationSnapshot;
      readonly rebootAcknowledged: boolean;
    }
  | {
      readonly kind: 'SAVED_UNVERIFIED';
      readonly rebootAcknowledged: boolean;
      readonly error: unknown;
    }
  | { readonly kind: 'REJECTED'; readonly reason: GpsBlockReason }
  | {
      readonly kind: 'UNCONFIRMED';
      readonly stage: 'FEATURE_CONFIG' | 'GPS_CONFIG' | 'EEPROM';
    }
  | { readonly kind: 'SESSION_ENDED' }
  | { readonly kind: 'FAILED'; readonly error: unknown };

export interface GpsConfigurationControllerOptions {
  readonly coordinator?: GpsSessionCoordinator;
  readonly appStateOwner?: GpsAppStateOwner;
  readonly isMotorTestActive?: (sessionId: string) => boolean;
}

class GpsPreflightError extends Error {
  constructor(readonly reason: GpsBlockReason) {
    super(`GPS preflight rejected: ${reason}`);
    this.name = 'GpsPreflightError';
  }
}

type GpsWriteStage = 'FEATURE_CONFIG' | 'GPS_CONFIG' | 'EEPROM';
interface AmbiguousGpsWriteCause {
  readonly kind: 'GPS_AMBIGUOUS_WRITE';
  readonly stage: GpsWriteStage;
}

class AmbiguousGpsWriteError extends MspOperationOutcomeUnknownError {
  constructor(error: unknown, stage: GpsWriteStage) {
    super(Object.freeze({ kind: 'GPS_AMBIGUOUS_WRITE', stage, error }));
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

function ambiguousCause(value: unknown): value is AmbiguousGpsWriteCause {
  return (
    value !== null &&
    typeof value === 'object' &&
    'kind' in value &&
    value.kind === 'GPS_AMBIGUOUS_WRITE'
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

export class GpsConfigurationController {
  private readonly coordinator: GpsSessionCoordinator;
  private readonly appStateOwner: GpsAppStateOwner;
  private readonly isMotorTestActive: (sessionId: string) => boolean;
  private readonly boxIds = new Map<
    string,
    { client: GpsClient; acquisition: BoxIdsAcquisition }
  >();

  constructor(options: GpsConfigurationControllerOptions = {}) {
    this.coordinator = options.coordinator ?? mspSessionCoordinator;
    this.appStateOwner = options.appStateOwner ?? setupAppStateTelemetryOwner;
    this.isMotorTestActive =
      options.isMotorTestActive ?? defaultMotorTestActive;
  }

  async load(sessionKey: SetupUiSessionKey): Promise<GpsLoadOutcome> {
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
      ).execute<GpsConfigurationSnapshot>({
        id: `gps:load:${sessionKey.sessionId}:${sessionKey.generation}`,
        sessionEffect: 'KEEP_SESSION',
        validate: context =>
          context.clientState === 'READY'
            ? { allowed: true }
            : {
                allowed: false,
                error: new GpsPreflightError('LINK_RECOVERING'),
              },
        execute: async requester => {
          this.assertLive(sessionKey, client, epoch);
          return this.readSnapshot(
            requester,
            identity.apiVersion.apiVersionMajor,
            identity.apiVersion.apiVersionMinor,
          );
        },
      });
      if (result.status === 'SUCCEEDED')
        return { kind: 'LOADED', snapshot: result.result };
      if (
        result.status === 'SESSION_ENDED' ||
        result.status === 'OUTCOME_UNKNOWN'
      )
        return { kind: 'SESSION_ENDED' };
      return result.error instanceof GpsPreflightError
        ? { kind: 'REJECTED', reason: result.error.reason }
        : { kind: 'FAILED', error: result.error };
    } finally {
      interlock.release();
    }
  }

  async save(
    sessionKey: SetupUiSessionKey,
    original: GpsConfigurationSnapshot,
    draft: GpsConfigurationDraft,
  ): Promise<GpsSaveOutcome> {
    const originalDraft: GpsConfigurationDraft = Object.freeze({
      enabled: this.featureEnabled(original.featureMaskRaw),
      ...original.configuration,
    });
    if (gpsDraftsEqual(originalDraft, draft))
      return { kind: 'NO_CHANGES', snapshot: original };
    if (validateGpsDraft(draft).length > 0)
      return { kind: 'REJECTED', reason: 'INVALID_CONFIGURATION' };
    const desiredMask = deriveGpsFeatureMask(
      original.featureMaskRaw,
      draft.enabled,
    );
    const desiredConfig = Object.freeze({
      provider: draft.provider,
      sbasMode: draft.sbasMode,
      autoConfig: draft.autoConfig,
      autoBaud: draft.autoBaud,
      homePointOnce: draft.homePointOnce,
      useGalileo: draft.useGalileo,
    });
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
        snapshot?: GpsConfigurationSnapshot;
        readbackError?: unknown;
        rebootAcknowledged: boolean;
      }>({
        id: `gps:save:${sessionKey.sessionId}:${sessionKey.generation}`,
        sessionEffect: 'EXPECT_REBOOT',
        validate: context =>
          context.clientState === 'READY'
            ? { allowed: true }
            : {
                allowed: false,
                error: new GpsPreflightError('LINK_RECOVERING'),
              },
        execute: async requester => {
          this.assertLive(sessionKey, client, epoch);
          const freshMask = await this.readFeatureMask(requester);
          const freshConfig = await this.readGpsConfig(requester);
          if (
            freshMask !== original.featureMaskRaw ||
            !gpsConfigurationsEqual(freshConfig, original.configuration)
          ) {
            throw new GpsPreflightError('STALE_BASE');
          }
          await this.assertDisarmed(
            sessionKey,
            client,
            epoch,
            requester,
            acquisition,
            ownerIdentity,
          );
          if (desiredMask !== original.featureMaskRaw) {
            const payload = new Uint8Array(4);
            new DataView(payload.buffer).setUint32(0, desiredMask, true);
            await this.writeOnce(
              requester,
              MSP_SET_FEATURE_CONFIG,
              payload,
              'FEATURE_CONFIG',
            );
          }
          if (!gpsConfigurationsEqual(desiredConfig, original.configuration)) {
            await this.writeOnce(
              requester,
              MSP_SET_GPS_CONFIG,
              encodeGpsConfiguration(desiredConfig),
              'GPS_CONFIG',
            );
          }
          await this.writeOnce(requester, MSP_EEPROM_WRITE, EMPTY, 'EEPROM');

          let snapshot: GpsConfigurationSnapshot | undefined;
          let readbackError: unknown;
          try {
            snapshot = await this.readSnapshot(
              requester,
              identity.apiVersion.apiVersionMajor,
              identity.apiVersion.apiVersionMinor,
            );
            if (
              snapshot.featureMaskRaw !== desiredMask ||
              !gpsConfigurationsEqual(snapshot.configuration, desiredConfig)
            ) {
              throw new Error(
                'GPS readback does not match saved configuration.',
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
            /* A disappearing link can be the requested reboot. */
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
      return result.error instanceof GpsPreflightError
        ? { kind: 'REJECTED', reason: result.error.reason }
        : { kind: 'FAILED', error: result.error };
    } finally {
      interlock.release();
    }
  }

  private featureEnabled(mask: number): boolean {
    // eslint-disable-next-line no-bitwise -- Betaflight GPS is feature bit 7.
    return (mask & (2 ** 7)) !== 0;
  }

  private async writeOnce(
    requester: MspRequester,
    command: number,
    payload: Uint8Array,
    stage: GpsWriteStage,
  ): Promise<void> {
    try {
      await requester.request(command, payload, { wireFormat: 'v1' });
    } catch (error) {
      if (definitelyNotApplied(error)) throw error;
      throw new AmbiguousGpsWriteError(error, stage);
    }
  }

  private capture(
    sessionKey: SetupUiSessionKey,
  ):
    | {
        client: GpsClient;
        scheduler: MspTelemetryScheduler;
        epoch: number;
        identity: Extract<
          MspIdentificationState,
          { status: 'SUCCEEDED' }
        >['identity'];
      }
    | { reason: GpsBlockReason } {
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
      identification.identity.apiVersion.apiVersionMinor < 46
    ) {
      return { reason: 'UNSUPPORTED_FIRMWARE' };
    }
    const key = this.coordinator.getSessionKey(sessionKey.sessionId);
    const client = this.coordinator.getActiveMspClient(sessionKey.sessionId);
    const scheduler = this.coordinator.getTelemetryScheduler(
      sessionKey.sessionId,
    );
    if (
      this.coordinator.getOwnershipState(sessionKey.sessionId) !== 'ACTIVE' ||
      key?.generation !== sessionKey.generation ||
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
    client: GpsClient,
    epoch: number,
  ): void {
    if (this.appStateOwner.getPhase() !== 'ACTIVE')
      throw new GpsPreflightError('APP_BACKGROUNDED');
    if (this.isMotorTestActive(key.sessionId))
      throw new GpsPreflightError('MOTOR_TEST_ACTIVE');
    if (
      this.coordinator.getOwnershipState(key.sessionId) !== 'ACTIVE' ||
      this.coordinator.getSessionKey(key.sessionId)?.generation !==
        key.generation ||
      this.coordinator.getActiveMspClient(key.sessionId) !== client ||
      client.getEpoch() !== epoch
    ) {
      throw new GpsPreflightError('DISCONNECTED');
    }
    if (this.coordinator.getMspRecoveryState(key.sessionId) !== 'READY')
      throw new GpsPreflightError('LINK_RECOVERING');
  }

  private operations(
    sessionId: string,
    client: GpsClient,
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

  private boxIdsFor(sessionId: string, client: GpsClient): BoxIdsAcquisition {
    const existing = this.boxIds.get(sessionId);
    if (existing?.client === client) return existing.acquisition;
    const acquisition = new BoxIdsAcquisition(client);
    this.boxIds.set(sessionId, { client, acquisition });
    return acquisition;
  }

  private async assertDisarmed(
    key: SetupUiSessionKey,
    client: GpsClient,
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
      throw new GpsPreflightError('ARMED_STATE_UNKNOWN');
    const frame = await requester.request(MSP_STATUS_EX, EMPTY, {
      wireFormat: 'v1',
    });
    const status = decodeStatusExDiagnostics(frame.payload);
    const armed = deriveArmedState(
      status.flightModeFlagsLow32,
      status.readiness.extraFlightModeFlagBytes,
      mapping.permanentIds,
    );
    if (armed === 'ARMED') throw new GpsPreflightError('FC_ARMED');
    if (armed !== 'DISARMED' || status.readiness.malformedTail)
      throw new GpsPreflightError('ARMED_STATE_UNKNOWN');
    this.assertLive(key, client, epoch);
  }

  private async readFeatureMask(requester: MspRequester): Promise<number> {
    return decodeFeatureConfig(
      (await requester.request(MSP_FEATURE_CONFIG, EMPTY, { wireFormat: 'v1' }))
        .payload,
    ).enabledFeaturesRaw;
  }

  private async readGpsConfig(requester: MspRequester) {
    return decodeGpsConfiguration(
      (await requester.request(MSP_GPS_CONFIG, EMPTY, { wireFormat: 'v1' }))
        .payload,
    );
  }

  private async readSnapshot(
    requester: MspRequester,
    apiVersionMajor: number,
    apiVersionMinor: number,
  ): Promise<GpsConfigurationSnapshot> {
    const featureMaskRaw = await this.readFeatureMask(requester);
    const configuration = await this.readGpsConfig(requester);
    const ports = decodeSerialPorts(
      (
        await requester.request(MSP2_COMMON_SERIAL_CONFIG, EMPTY, {
          wireFormat: 'v2',
        })
      ).payload,
    );
    return Object.freeze({
      featureMaskRaw,
      configuration,
      ports,
      apiVersionMajor,
      apiVersionMinor,
    });
  }
}

export const gpsConfigurationController = new GpsConfigurationController();
