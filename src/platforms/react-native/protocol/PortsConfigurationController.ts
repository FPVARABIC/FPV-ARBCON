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
  MutationLedger,
  MutationStoppedError,
  type PartialApplyEvidence,
} from './configurationSaveLedger';
import {
  normalizeSerialPortsForSave,
  deriveSerialPortsFeatureMask,
  refusalsForUnverifiedEvidence,
  serialPortsEqual,
  validateSerialPorts,
  observedEvidence,
  EVIDENCE_READ_FAILED,
  type SerialEvidence,
  type SerialPortsEvidenceRefusal,
  type SerialPortsSnapshot,
  type SerialPortsValidationIssue,
  type VtxTableEvidence,
} from '../../../core/state/serialPortsModel';
import type { MspClientState } from '../../../core/protocol/mspClient';
import {
  isMotorTestSessionActive,
} from './motorTestCapability';
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
  | 'INVALID_CONFIGURATION'
  /** The write depends on optional evidence that could not be obtained. */
  | 'EVIDENCE_NOT_VERIFIED';

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
      /** Present only with reason EVIDENCE_NOT_VERIFIED. */
      readonly refusals?: readonly SerialPortsEvidenceRefusal[];
    }
  | {
      readonly kind: 'UNCONFIRMED';
      readonly stage: PortsWriteStage;
      /** RAM writes the board acknowledged before the doubt began. */
      readonly confirmedStages: readonly PortsWriteStage[];
    }
  /**
   * At least one RAM write was ACKNOWLEDGED and the sequence then
   * stopped - because a later frame was provably refused, or because the
   * session/epoch changed under it - before EEPROM was acknowledged.
   *
   * Nothing is persisted: the flight controller's STORED configuration
   * is untouched. But its RAM has already moved, and the aircraft flies
   * on RAM. Reporting this as an ordinary failure would tell the
   * operator nothing happened, and something did.
   *
   * No rollback and no retry - see `configurationSaveLedger.ts`.
   */
  | {
      readonly kind: 'PARTIAL_UNPERSISTED';
      readonly confirmedStages: readonly PortsWriteStage[];
      readonly failedStage: PortsWriteStage;
      readonly definitelyNotSent: boolean;
    }
  | { readonly kind: 'SESSION_ENDED' }
  | { readonly kind: 'FAILED'; readonly error: unknown };

/** The ordered mutating stages of a Ports save. EEPROM is persistence,
 *  not another configuration group - see §18 of the repair brief. */
export type PortsWriteStage = 'SERIAL_CONFIG' | 'FEATURE_CONFIG' | 'EEPROM';

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

/**
 * Refused because the evidence this specific write depends on never
 * arrived - distinct from "the configuration is invalid", which is a
 * claim about the configuration itself.
 */
class PortsEvidenceError extends Error {
  constructor(readonly refusals: readonly SerialPortsEvidenceRefusal[]) {
    super(
      `Ports save refused for want of evidence: ${refusals
        .map(refusal => refusal.reason)
        .join(',')}`,
    );
    this.name = 'PortsEvidenceError';
  }
}

interface AmbiguousPortsWriteCause extends PartialApplyEvidence<PortsWriteStage> {
  readonly kind: 'PORTS_AMBIGUOUS_WRITE';
  readonly stage: PortsWriteStage;
}

class AmbiguousPortsWriteError extends MspOperationOutcomeUnknownError {
  constructor(
    error: unknown,
    stage: PortsWriteStage,
    confirmedStages: readonly PortsWriteStage[] = [],
    partial = false,
    definitelyNotSent = false,
  ) {
    super(
      Object.freeze({
        kind: 'PORTS_AMBIGUOUS_WRITE',
        stage,
        error,
        confirmedStages: Object.freeze([...confirmedStages]),
        partial,
        definitelyNotSent,
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

function ambiguousCause(value: unknown): value is AmbiguousPortsWriteCause {
  return (
    value !== null &&
    typeof value === 'object' &&
    'kind' in value &&
    value.kind === 'PORTS_AMBIGUOUS_WRITE'
  );
}

/** The ONE shared liveness predicate - see
 * motorTestCapability.ts's own isMotorTestSessionActive() for why a
 * per-controller copy that read `mayHaveReachedFc` as liveness blocked
 * every configuration screen until the cable was replugged. */
const defaultMotorTestActive = isMotorTestSessionActive;

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
          /*
           * THE CONTROLLER IS THE FINAL AUTHORITY ON UNPROVEN EVIDENCE.
           *
           * MSP2_COMMON_SET_SERIAL_CONFIG replaces the WHOLE table, so
           * "the operator only touched another card" is not a safety
           * argument - the bytes are. Any port whose validity rests on
           * evidence we never obtained must come out of normalisation
           * byte-identical, or this write is asserting something it
           * cannot support.
           *
           * Evidence is RE-READ here rather than trusted from page load:
           * a provider read that timed out ten minutes ago is not a
           * reason to refuse an edit the board can answer for now. Only
           * the evidence the proposed delta actually needs is fetched.
           *
           * This gate sits LAST in the preflight chain, after stale-base
           * and after the armed proof. It is a new refusal and it does
           * not get to pre-empt an older one: an armed board is told it
           * is armed, which is the more urgent thing to say, and the
           * extra reads are not spent on a save that was refused anyway.
           */
          const needsEvidence = refusalsForUnverifiedEvidence(
            original,
            normalized,
          );
          if (needsEvidence.length > 0) {
            const refreshed: SerialPortsSnapshot = Object.freeze({
              ...original,
              serialRxProvider: needsEvidence.some(
                r => r.reason === 'RX_PROVIDER_REQUIRED_FOR_SHARING_VALIDATION',
              )
                ? await this.readRxProvider(requester)
                : original.serialRxProvider,
              buildOptionIds: needsEvidence.some(
                r => r.reason === 'BUILD_CAPABILITY_NOT_VERIFIED',
              )
                ? await this.readBuildOptions(requester)
                : original.buildOptionIds,
            });
            this.assertLive(sessionKey, client, epoch);
            const stillUnproven = refusalsForUnverifiedEvidence(
              refreshed,
              normalized,
            );
            if (stillUnproven.length > 0)
              throw new PortsEvidenceError(stillUnproven);
            /* Fresh evidence can also reveal the edit is genuinely
               invalid - that is an ordinary validation failure, not an
               uncertainty. */
            const freshIssues = validateSerialPorts(
              Object.freeze({
                ...refreshed,
                ports: normalized,
                featureMaskRaw: desiredFeatureMask,
              }),
            );
            if (freshIssues.length > 0)
              throw new PortsPreflightError('INVALID_CONFIGURATION');
          }
          /*
           * THE MUTATION SEQUENCE.
           *
           * Every frame below is preceded by its OWN liveness check, in
           * the same synchronous turn as the request it guards - no
           * `await` sits between the check and the submission it
           * authorises, or the board could change in the gap the check
           * was supposed to close.
           *
           * Checking once at the top of `execute` was the confirmed
           * defect: a flight controller that restarted after
           * SET_SERIAL_CONFIG went on to receive SET_FEATURE_CONFIG and
           * an EEPROM_WRITE, and the flash then held the feature mask
           * without the port table it describes - one operator intent
           * split durably across two FC lifetimes.
           */
          const ledger = new MutationLedger<PortsWriteStage>();
          this.stopIfNotLive(sessionKey, client, epoch, 'SERIAL_CONFIG', ledger);
          try {
            await requester.request(
              MSP2_COMMON_SET_SERIAL_CONFIG,
              encodeSerialPorts(normalized),
              { wireFormat: 'v2' },
            );
          } catch (error) {
            throw this.writeFailure(error, 'SERIAL_CONFIG', ledger);
          }
          ledger.acknowledge('SERIAL_CONFIG');

          if (desiredFeatureMask !== original.featureMaskRaw) {
            const featurePayload = new Uint8Array(4);
            new DataView(featurePayload.buffer).setUint32(
              0,
              desiredFeatureMask,
              true,
            );
            this.stopIfNotLive(
              sessionKey,
              client,
              epoch,
              'FEATURE_CONFIG',
              ledger,
            );
            try {
              await requester.request(MSP_SET_FEATURE_CONFIG, featurePayload, {
                wireFormat: 'v1',
              });
            } catch (error) {
              throw this.writeFailure(error, 'FEATURE_CONFIG', ledger);
            }
            ledger.acknowledge('FEATURE_CONFIG');
          }

          /* PERSISTENCE NEVER FOLLOWS LOST LIVENESS. This check is the
             hard invariant of the repair: if the board is not the one
             the RAM writes went to, its flash must not be written. */
          this.stopIfNotLive(sessionKey, client, epoch, 'EEPROM', ledger);
          try {
            await requester.request(MSP_EEPROM_WRITE, EMPTY, {
              wireFormat: 'v1',
            });
          } catch (error) {
            throw this.writeFailure(error, 'EEPROM', ledger);
          }
          ledger.markPersisted();

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
        if (!ambiguousCause(result.reason)) return { kind: 'SESSION_ENDED' };
        /* "Some of it landed and none of it was saved" is its own
           answer, never an ordinary failure. */
        if (result.reason.partial) {
          return {
            kind: 'PARTIAL_UNPERSISTED',
            confirmedStages: result.reason.confirmedStages,
            failedStage: result.reason.stage,
            definitelyNotSent: result.reason.definitelyNotSent,
          };
        }
        return {
          kind: 'UNCONFIRMED',
          stage: result.reason.stage,
          confirmedStages: result.reason.confirmedStages,
        };
      }
      if (result.status === 'SESSION_ENDED') return { kind: 'SESSION_ENDED' };
      /* A refusal for want of evidence is NOT the same answer as
         "your configuration is wrong", and it carries which resource. */
      if (result.error instanceof PortsEvidenceError)
        return {
          kind: 'REJECTED',
          reason: 'EVIDENCE_NOT_VERIFIED',
          refusals: result.error.refusals,
        };
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

  /**
   * THE LIVENESS CHECK THAT GUARDS ONE MUTATION, and knows what has
   * already been written.
   *
   * Before anything has been acknowledged this is an ordinary preflight
   * refusal and is rethrown untouched: the aircraft was never modified,
   * so `REJECTED(DISCONNECTED)` is the whole truth.
   *
   * AFTER a write has been acknowledged it is not. The flight
   * controller's RAM has already moved, and answering `DISCONNECTED`
   * would tell the operator nothing happened. The ledger is carried out
   * so the outcome can name exactly which groups landed.
   */
  private stopIfNotLive(
    sessionKey: SetupUiSessionKey,
    client: PortsClient,
    epoch: number,
    stage: PortsWriteStage,
    ledger: MutationLedger<PortsWriteStage>,
  ): void {
    try {
      this.assertLive(sessionKey, client, epoch);
    } catch (error) {
      if (!ledger.hasMutated) throw error;
      throw new AmbiguousPortsWriteError(
        new MutationStoppedError(stage, ledger.acknowledgedStages, error),
        stage,
        ledger.acknowledgedStages,
        true,
        /* The frame was never submitted, so it provably did not reach
           the flight controller. */
        true,
      );
    }
  }

  /**
   * Classify a failed mutation against what this save has already
   * written.
   *
   * DEFINITELY-NOT-APPLIED after an acknowledged write is a PARTIAL
   * application: the earlier groups are in RAM, this one is not, and
   * nothing is persisted. Before any acknowledged write it stays an
   * ordinary failure, because nothing happened.
   *
   * AMBIGUOUS stays ambiguous at every stage - it is never upgraded to
   * acknowledged and never downgraded to definitely-not-applied. The
   * ledger rides along so `UNCONFIRMED` can still say which groups are
   * known to have landed.
   */
  private writeFailure(
    error: unknown,
    stage: PortsWriteStage,
    ledger: MutationLedger<PortsWriteStage>,
  ): unknown {
    if (definitelyNotApplied(error)) {
      if (!ledger.hasMutated) return error;
      return new AmbiguousPortsWriteError(
        error,
        stage,
        ledger.acknowledgedStages,
        true,
        true,
      );
    }
    return new AmbiguousPortsWriteError(
      error,
      stage,
      ledger.acknowledgedStages,
      false,
      false,
    );
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
    return Object.freeze({
      ports,
      featureMaskRaw,
      apiVersionMajor,
      apiVersionMinor,
      serialRxProvider: await this.readRxProvider(requester),
      buildOptionIds: await this.readBuildOptions(requester),
      vtxTable: await this.readVtxTable(requester),
    });
  }

  /*
   * THE THREE OPTIONAL READS.
   *
   * Each one answers with what it OBSERVED or says it failed. None of
   * them substitutes a plausible value: a failed MSP_RX_CONFIG used to
   * become provider 0, which is a real provider (SERIALRX_NONE) and one
   * that happens to fail the RX/telemetry sharing rule - so a single
   * timed-out read reported a working board as misconfigured and blocked
   * every save on the page. A failed MSP_BUILD_INFO used to become
   * "no build gating", presenting every gated role as compiled.
   *
   * The transport CAN distinguish MSP_REMOTE_ERROR from MSP_TIMEOUT from
   * MSP_DEVICE_DETACHED, and that distinction is deliberately NOT
   * carried here. Calling an error frame "unsupported" would be an
   * inference - a board can refuse a frame for other reasons - and the
   * three produce the same consequence for every consumer: we did not
   * learn the thing. READ_FAILED is what is actually known.
   */
  private async readRxProvider(
    requester: MspRequester,
  ): Promise<SerialEvidence<number>> {
    try {
      const frame = await requester.request(MSP_RX_CONFIG, EMPTY, {
        wireFormat: 'v1',
      });
      return observedEvidence(decodeSerialRxProvider(frame.payload));
    } catch {
      return EVIDENCE_READ_FAILED;
    }
  }

  /* No API-version branch here: capture() already refuses anything below
     1.46, so a version guard in this method could never run and could
     never be tested. A firmware that does not know the command answers
     with an error frame, which is READ_FAILED like any other silence. */
  private async readBuildOptions(
    requester: MspRequester,
  ): Promise<SerialEvidence<ReadonlySet<number>>> {
    try {
      const frame = await requester.request(MSP_BUILD_INFO, EMPTY, {
        wireFormat: 'v1',
      });
      return observedEvidence(decodeBuildOptions(frame.payload).optionIds);
    } catch {
      return EVIDENCE_READ_FAILED;
    }
  }

  private async readVtxTable(
    requester: MspRequester,
  ): Promise<SerialEvidence<VtxTableEvidence>> {
    try {
      const frame = await requester.request(MSP_VTX_CONFIG, EMPTY, {
        wireFormat: 'v1',
      });
      const status = decodeVtxTableStatus(frame.payload);
      return observedEvidence({
        tableAvailable: status.tableAvailable,
        tableConfigured:
          status.tableAvailable &&
          status.bands > 0 &&
          status.channels > 0 &&
          status.powerLevels > 0,
      });
    } catch {
      return EVIDENCE_READ_FAILED;
    }
  }
}

export const portsConfigurationController = new PortsConfigurationController();
