import {
  MSP2_COMMON_SERIAL_CONFIG,
  MSP2_COMMON_SET_SERIAL_CONFIG,
  MSP_BUILD_INFO,
  MSP_EEPROM_WRITE,
  MSP_FEATURE_CONFIG,
  MSP_REBOOT,
  MSP_RX_CONFIG,
  MSP_SET_FEATURE_CONFIG,
  MSP_STATUS_EX,
  MSP_VTX_CONFIG,
  BoxIdsAcquisition,
  createMspOperationCoordinator,
  decodeBuildOptions,
  decodeFeatureConfig,
  decodeSerialPorts,
  decodeSerialRxProvider,
  decodeStatusExDiagnostics,
  decodeVtxTableStatus,
  encodeSerialPorts,
  MspOperationOutcomeUnknownError,
  type BoxIdsOwnerIdentity,
  type MspRequester,
  type MspSerialPortRecord,
  type MspTelemetryScheduler,
} from '../../../core';
import { deriveArmedState } from '../../../core/state/armingBlockers';
import {
  normalizeSerialPortsForSave,
  deriveSerialPortsFeatureMask,
  serialPortsEqual,
  validateSerialPorts,
  type SerialPortsSnapshot,
  type SerialPortsValidationIssue,
} from '../../../core/state/serialPortsModel';
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

interface PortsClient extends MspRequester {
  getEpoch(): number;
}

export interface PortsSessionCoordinator {
  getOwnershipState(sessionId: string): MspSessionOwnershipState;
  getIdentificationState(sessionId: string): MspIdentificationState;
  getSessionKey(sessionId: string): SetupUiSessionKey | undefined;
  getActiveMspClient(sessionId: string): PortsClient | undefined;
  getTelemetryScheduler(sessionId: string): MspTelemetryScheduler | undefined;
  getMspRecoveryState(sessionId: string): MspClientState | undefined;
}

export interface PortsAppStateOwner {
  getPhase(): SetupAppStatePhase;
}

export type PortsBlockReason =
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

export type PortsLoadOutcome =
  | { readonly kind: 'LOADED'; readonly snapshot: SerialPortsSnapshot }
  | { readonly kind: 'REJECTED'; readonly reason: PortsBlockReason }
  | { readonly kind: 'SESSION_ENDED' }
  | { readonly kind: 'FAILED'; readonly error: unknown };

export type PortsSaveOutcome =
  | { readonly kind: 'NO_CHANGES'; readonly snapshot: SerialPortsSnapshot }
  | {
      readonly kind: 'SAVED_VERIFIED';
      readonly snapshot: SerialPortsSnapshot;
      readonly rebootAcknowledged: boolean;
    }
  | {
      readonly kind: 'SAVED_UNVERIFIED';
      readonly rebootAcknowledged: boolean;
      readonly error: unknown;
    }
  | {
      readonly kind: 'REJECTED';
      readonly reason: PortsBlockReason;
      readonly issues?: readonly SerialPortsValidationIssue[];
    }
  | {
      readonly kind: 'UNCONFIRMED';
      readonly stage: 'SERIAL_CONFIG' | 'FEATURE_CONFIG' | 'EEPROM';
    }
  | { readonly kind: 'SESSION_ENDED' }
  | { readonly kind: 'FAILED'; readonly error: unknown };

export interface PortsConfigurationControllerOptions {
  readonly coordinator?: PortsSessionCoordinator;
  readonly appStateOwner?: PortsAppStateOwner;
  readonly isMotorTestActive?: (sessionId: string) => boolean;
}

class PortsPreflightError extends Error {
  constructor(readonly reason: PortsBlockReason) {
    super(`Ports preflight rejected: ${reason}`);
    this.name = 'PortsPreflightError';
  }
}

interface AmbiguousPortsWriteCause {
  readonly kind: 'PORTS_AMBIGUOUS_WRITE';
  readonly stage: 'SERIAL_CONFIG' | 'FEATURE_CONFIG' | 'EEPROM';
}

class AmbiguousPortsWriteError extends MspOperationOutcomeUnknownError {
  constructor(
    error: unknown,
    stage: 'SERIAL_CONFIG' | 'FEATURE_CONFIG' | 'EEPROM',
  ) {
    super(Object.freeze({ kind: 'PORTS_AMBIGUOUS_WRITE', stage, error }));
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

function ambiguousCause(value: unknown): value is AmbiguousPortsWriteCause {
  return (
    value !== null &&
    typeof value === 'object' &&
    'kind' in value &&
    value.kind === 'PORTS_AMBIGUOUS_WRITE'
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

export class PortsConfigurationController {
  private readonly coordinator: PortsSessionCoordinator;
  private readonly appStateOwner: PortsAppStateOwner;
  private readonly isMotorTestActive: (sessionId: string) => boolean;
  private readonly boxIds = new Map<
    string,
    { client: PortsClient; acquisition: BoxIdsAcquisition }
  >();

  constructor(options: PortsConfigurationControllerOptions = {}) {
    this.coordinator = options.coordinator ?? mspSessionCoordinator;
    this.appStateOwner = options.appStateOwner ?? setupAppStateTelemetryOwner;
    this.isMotorTestActive =
      options.isMotorTestActive ?? defaultMotorTestActive;
  }

  async load(sessionKey: SetupUiSessionKey): Promise<PortsLoadOutcome> {
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
      ).execute<SerialPortsSnapshot>({
        id: `ports:load:${sessionKey.sessionId}:${sessionKey.generation}`,
        sessionEffect: 'KEEP_SESSION',
        validate: context =>
          context.clientState === 'READY'
            ? { allowed: true }
            : {
                allowed: false,
                error: new PortsPreflightError('LINK_RECOVERING'),
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
      return result.error instanceof PortsPreflightError
        ? { kind: 'REJECTED', reason: result.error.reason }
        : { kind: 'FAILED', error: result.error };
    } finally {
      interlock.release();
    }
  }

  async save(
    sessionKey: SetupUiSessionKey,
    original: SerialPortsSnapshot,
    desiredPorts: readonly MspSerialPortRecord[],
  ): Promise<PortsSaveOutcome> {
    if (serialPortsEqual(original.ports, desiredPorts))
      return { kind: 'NO_CHANGES', snapshot: original };
    const normalized = normalizeSerialPortsForSave(desiredPorts);
    const desiredFeatureMask = deriveSerialPortsFeatureMask(
      original.featureMaskRaw,
      normalized,
    );
    const desired: SerialPortsSnapshot = Object.freeze({
      ...original,
      ports: normalized,
      featureMaskRaw: desiredFeatureMask,
    });
    const issues = validateSerialPorts(desired);
    if (issues.length > 0)
      return { kind: 'REJECTED', reason: 'INVALID_CONFIGURATION', issues };

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
        snapshot?: SerialPortsSnapshot;
        readbackError?: unknown;
        rebootAcknowledged: boolean;
      }>({
        id: `ports:save:${sessionKey.sessionId}:${sessionKey.generation}`,
        sessionEffect: 'EXPECT_REBOOT',
        validate: context =>
          context.clientState === 'READY'
            ? { allowed: true }
            : {
                allowed: false,
                error: new PortsPreflightError('LINK_RECOVERING'),
              },
        execute: async requester => {
          this.assertLive(sessionKey, client, epoch);
          const freshPorts = await this.readSerialPorts(requester);
          const freshFeatureMask = await this.readFeatureMask(requester);
          if (
            !serialPortsEqual(freshPorts, original.ports) ||
            freshFeatureMask !== original.featureMaskRaw
          ) {
            throw new PortsPreflightError('STALE_BASE');
          }
          await this.assertDisarmed(
            sessionKey,
            client,
            epoch,
            requester,
            acquisition,
            ownerIdentity,
          );
          this.assertLive(sessionKey, client, epoch);
          try {
            await requester.request(
              MSP2_COMMON_SET_SERIAL_CONFIG,
              encodeSerialPorts(normalized),
              { wireFormat: 'v2' },
            );
          } catch (error) {
            if (definitelyNotApplied(error)) throw error;
            throw new AmbiguousPortsWriteError(error, 'SERIAL_CONFIG');
          }
          if (desiredFeatureMask !== original.featureMaskRaw) {
            const featurePayload = new Uint8Array(4);
            new DataView(featurePayload.buffer).setUint32(
              0,
              desiredFeatureMask,
              true,
            );
            try {
              await requester.request(MSP_SET_FEATURE_CONFIG, featurePayload, {
                wireFormat: 'v1',
              });
            } catch (error) {
              if (definitelyNotApplied(error)) throw error;
              throw new AmbiguousPortsWriteError(error, 'FEATURE_CONFIG');
            }
          }
          try {
            await requester.request(MSP_EEPROM_WRITE, EMPTY, {
              wireFormat: 'v1',
            });
          } catch (error) {
            if (definitelyNotApplied(error)) throw error;
            throw new AmbiguousPortsWriteError(error, 'EEPROM');
          }

          let snapshot: SerialPortsSnapshot | undefined;
          let readbackError: unknown;
          try {
            snapshot = await this.readSnapshot(
              requester,
              identity.apiVersion.apiVersionMajor,
              identity.apiVersion.apiVersionMinor,
            );
            if (
              !serialPortsEqual(snapshot.ports, normalized) ||
              snapshot.featureMaskRaw !== desiredFeatureMask
            ) {
              readbackError = new Error(
                'Ports readback does not match saved configuration.',
              );
              snapshot = undefined;
            }
          } catch (error) {
            readbackError = error;
          }
          let rebootAcknowledged = false;
          try {
            await requester.request(MSP_REBOOT, EMPTY, { wireFormat: 'v1' });
            rebootAcknowledged = true;
          } catch {
            // EEPROM is already acknowledged. A disappearing link can be the
            // requested reboot, so never lie that the durable save failed.
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
      if (result.status === 'OUTCOME_UNKNOWN') {
        return ambiguousCause(result.reason)
          ? { kind: 'UNCONFIRMED', stage: result.reason.stage }
          : { kind: 'SESSION_ENDED' };
      }
      if (result.status === 'SESSION_ENDED') return { kind: 'SESSION_ENDED' };
      return result.error instanceof PortsPreflightError
        ? { kind: 'REJECTED', reason: result.error.reason }
        : { kind: 'FAILED', error: result.error };
    } finally {
      interlock.release();
    }
  }

  private capture(
    sessionKey: SetupUiSessionKey,
  ):
    | {
        client: PortsClient;
        scheduler: MspTelemetryScheduler;
        epoch: number;
        identity: Extract<
          MspIdentificationState,
          { status: 'SUCCEEDED' }
        >['identity'];
      }
    | { reason: PortsBlockReason } {
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
    ) {
      return { reason: 'DISCONNECTED' };
    }
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
    sessionKey: SetupUiSessionKey,
    client: PortsClient,
    epoch: number,
  ): void {
    if (this.appStateOwner.getPhase() !== 'ACTIVE')
      throw new PortsPreflightError('APP_BACKGROUNDED');
    if (this.isMotorTestActive(sessionKey.sessionId))
      throw new PortsPreflightError('MOTOR_TEST_ACTIVE');
    if (
      this.coordinator.getOwnershipState(sessionKey.sessionId) !== 'ACTIVE' ||
      this.coordinator.getSessionKey(sessionKey.sessionId)?.generation !==
        sessionKey.generation ||
      this.coordinator.getActiveMspClient(sessionKey.sessionId) !== client ||
      client.getEpoch() !== epoch
    ) {
      throw new PortsPreflightError('DISCONNECTED');
    }
    if (this.coordinator.getMspRecoveryState(sessionKey.sessionId) !== 'READY')
      throw new PortsPreflightError('LINK_RECOVERING');
  }

  private operations(
    sessionId: string,
    client: PortsClient,
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

  private boxIdsFor(sessionId: string, client: PortsClient): BoxIdsAcquisition {
    const existing = this.boxIds.get(sessionId);
    if (existing?.client === client) return existing.acquisition;
    const acquisition = new BoxIdsAcquisition(client);
    this.boxIds.set(sessionId, { client, acquisition });
    return acquisition;
  }

  private async assertDisarmed(
    key: SetupUiSessionKey,
    client: PortsClient,
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
      throw new PortsPreflightError('ARMED_STATE_UNKNOWN');
    const frame = await requester.request(MSP_STATUS_EX, EMPTY, {
      wireFormat: 'v1',
    });
    const status = decodeStatusExDiagnostics(frame.payload);
    const armed = deriveArmedState(
      status.flightModeFlagsLow32,
      status.readiness.extraFlightModeFlagBytes,
      mapping.permanentIds,
    );
    if (armed === 'ARMED') throw new PortsPreflightError('FC_ARMED');
    if (armed !== 'DISARMED' || status.readiness.malformedTail)
      throw new PortsPreflightError('ARMED_STATE_UNKNOWN');
    this.assertLive(key, client, epoch);
  }

  private async readSerialPorts(
    requester: MspRequester,
  ): Promise<readonly MspSerialPortRecord[]> {
    const frame = await requester.request(MSP2_COMMON_SERIAL_CONFIG, EMPTY, {
      wireFormat: 'v2',
    });
    return decodeSerialPorts(frame.payload);
  }

  private async readFeatureMask(requester: MspRequester): Promise<number> {
    const frame = await requester.request(MSP_FEATURE_CONFIG, EMPTY, {
      wireFormat: 'v1',
    });
    return decodeFeatureConfig(frame.payload).enabledFeaturesRaw;
  }

  private async readSnapshot(
    requester: MspRequester,
    apiVersionMajor: number,
    apiVersionMinor: number,
  ): Promise<SerialPortsSnapshot> {
    const ports = await this.readSerialPorts(requester);
    const featureMaskRaw = await this.readFeatureMask(requester);
    let serialRxProvider = 0;
    let buildOptionIds: ReadonlySet<number> | undefined;
    let vtxTableAvailable: boolean | undefined;
    let vtxTableConfigured: boolean | undefined;
    try {
      const frame = await requester.request(MSP_RX_CONFIG, EMPTY, {
        wireFormat: 'v1',
      });
      serialRxProvider = decodeSerialRxProvider(frame.payload);
    } catch {
      /* Optional evidence; conservative sharing rules remain. */
    }
    if (apiVersionMajor === 1 && apiVersionMinor >= 46) {
      try {
        const frame = await requester.request(MSP_BUILD_INFO, EMPTY, {
          wireFormat: 'v1',
        });
        buildOptionIds = decodeBuildOptions(frame.payload).optionIds;
      } catch {
        /* Older/custom targets may omit build option ids. */
      }
    }
    try {
      const frame = await requester.request(MSP_VTX_CONFIG, EMPTY, {
        wireFormat: 'v1',
      });
      const status = decodeVtxTableStatus(frame.payload);
      vtxTableAvailable = status.tableAvailable;
      vtxTableConfigured =
        status.tableAvailable &&
        status.bands > 0 &&
        status.channels > 0 &&
        status.powerLevels > 0;
    } catch {
      /* VTX is optional. */
    }
    return Object.freeze({
      ports,
      featureMaskRaw,
      apiVersionMajor,
      apiVersionMinor,
      serialRxProvider,
      buildOptionIds,
      vtxTableAvailable,
      vtxTableConfigured,
    });
  }
}

export const portsConfigurationController = new PortsConfigurationController();
