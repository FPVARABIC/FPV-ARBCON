import {
  MSP_EEPROM_WRITE,
  MSP_OSD_CANVAS,
  MSP_OSD_CONFIG,
  MSP_SET_OSD_CONFIG,
  MSP_STATUS_EX,
  BoxIdsAcquisition,
  MspOperationOutcomeUnknownError,
  createMspOperationCoordinator,
  createOsdConfigurationDraft,
  decodeOsdCanvas,
  decodeOsdConfiguration,
  decodeStatusExDiagnostics,
  encodeChangedOsdConfiguration,
  osdDraftsEqual,
  osdSnapshotsEqual,
  validateOsdDraft,
  type BoxIdsOwnerIdentity,
  type MspOsdSnapshot,
  type MspRequester,
  type MspTelemetryScheduler,
  type OsdConfigurationDraft,
  type OsdWriteGroup,
} from '../../../core';
import type {MspClientState} from '../../../core/protocol/mspClient';
import {deriveArmedState} from '../../../core/state/armingBlockers';
import {
  isOwnedByConfigurationSession,
  rememberConfigurationSession,
} from '../../../core/state/configurationSessionOwnership';
import {isMotorTestSessionActive} from './motorTestCapability';
import {mspSessionCoordinator, type MspIdentificationState, type MspSessionOwnershipState, type SetupUiSessionKey} from './MspSessionCoordinator';
import {setupAppStateTelemetryOwner, type SetupAppStatePhase} from './setupAppStateTelemetryOwner';
import {acquireMotorConfigurationInterlock, MotorConfigurationTransactionInProgressError} from './motorConfigurationInterlock';
import {MutationLedger, MutationStoppedError, type PartialApplyEvidence} from './configurationSaveLedger';
import {isSupportedConfigurationApi} from './betaflightApiSupport';

const EMPTY = new Uint8Array(0);
const DEFINITELY_NOT_SENT = new Set(['MSP_ENCODE_FAILED', 'MSP_QUEUE_FULL', 'MSP_TRANSPORT_QUEUE_FULL', 'MSP_RECOVERY_REQUIRED', 'MSP_RECOVERING', 'MSP_REMOTE_ERROR']);
interface OsdClient extends MspRequester {getEpoch(): number}
export interface OsdSessionCoordinator {
  getOwnershipState(sessionId: string): MspSessionOwnershipState;
  getIdentificationState(sessionId: string): MspIdentificationState;
  getSessionKey(sessionId: string): SetupUiSessionKey | undefined;
  getActiveMspClient(sessionId: string): OsdClient | undefined;
  getTelemetryScheduler(sessionId: string): MspTelemetryScheduler | undefined;
  getMspRecoveryState(sessionId: string): MspClientState | undefined;
}
export interface OsdAppStateOwner {getPhase(): SetupAppStatePhase}
export type OsdBlockReason = 'DISCONNECTED' | 'IDENTIFYING' | 'UNSUPPORTED_FIRMWARE' | 'APP_BACKGROUNDED' | 'LINK_RECOVERING' | 'FC_ARMED' | 'ARMED_STATE_UNKNOWN' | 'MOTOR_TEST_ACTIVE' | 'CONFIGURATION_BUSY' | 'STALE_BASE' | 'INVALID_CONFIGURATION' | 'SESSION_CHANGED';
export type OsdSaveStage = {readonly group: OsdWriteGroup; readonly index?: number} | {readonly group: 'EEPROM'};
export type OsdLoadOutcome = {readonly kind: 'LOADED'; readonly snapshot: MspOsdSnapshot} | {readonly kind: 'REJECTED'; readonly reason: OsdBlockReason} | {readonly kind: 'SESSION_ENDED'} | {readonly kind: 'FAILED'; readonly error: unknown};
export type OsdSaveOutcome = {readonly kind: 'NO_CHANGES'; readonly snapshot: MspOsdSnapshot} | {readonly kind: 'SAVED_VERIFIED'; readonly snapshot: MspOsdSnapshot} | {readonly kind: 'SAVED_UNVERIFIED'; readonly error: unknown} | {readonly kind: 'REJECTED'; readonly reason: OsdBlockReason} | {readonly kind: 'UNCONFIRMED'; readonly stage: OsdSaveStage; readonly confirmedStages: readonly OsdSaveStage[]}
  /** U-R1. At least one RAM write was ACKNOWLEDGED and the sequence then
   *  stopped before EEPROM was acknowledged. Nothing is persisted, but
   *  the aircraft's RAM has already moved. No rollback, no retry: see
   *  `configurationSaveLedger.ts`. */
  | {readonly kind: 'PARTIAL_UNPERSISTED'; readonly confirmedStages: readonly OsdSaveStage[]; readonly failedStage: OsdSaveStage; readonly definitelyNotSent: boolean}
  | {readonly kind: 'SESSION_ENDED'} | {readonly kind: 'FAILED'; readonly error: unknown};
export interface OsdConfigurationControllerOptions {readonly coordinator?: OsdSessionCoordinator; readonly appStateOwner?: OsdAppStateOwner; readonly isMotorTestActive?: (sessionId: string) => boolean}

class OsdPreflightError extends Error {constructor(readonly reason: OsdBlockReason) {super(`OSD preflight rejected: ${reason}`); this.name = 'OsdPreflightError';}}
interface AmbiguousOsdCause extends PartialApplyEvidence<OsdSaveStage> {readonly kind: 'OSD_AMBIGUOUS_WRITE'; readonly stage: OsdSaveStage}
class AmbiguousOsdWriteError extends MspOperationOutcomeUnknownError {constructor(error: unknown, stage: OsdSaveStage, confirmedStages: readonly OsdSaveStage[] = [], partial = false, definitelyNotSent = false) {super(Object.freeze({kind: 'OSD_AMBIGUOUS_WRITE', stage, error, confirmedStages: Object.freeze([...confirmedStages]), partial, definitelyNotSent}));}}
function errorCode(error: unknown): string | undefined {return error !== null && typeof error === 'object' && 'code' in error ? String((error as {code: unknown}).code) : undefined;}
function ambiguousCause(value: unknown): value is AmbiguousOsdCause {return value !== null && typeof value === 'object' && 'kind' in value && value.kind === 'OSD_AMBIGUOUS_WRITE';}

export class OsdConfigurationController {
  private readonly coordinator: OsdSessionCoordinator;
  private readonly appStateOwner: OsdAppStateOwner;
  private readonly isMotorTestActive: (sessionId: string) => boolean;
  private readonly boxIds = new Map<string, {client: OsdClient; acquisition: BoxIdsAcquisition}>();
  constructor(options: OsdConfigurationControllerOptions = {}) {this.coordinator = options.coordinator ?? mspSessionCoordinator; this.appStateOwner = options.appStateOwner ?? setupAppStateTelemetryOwner; this.isMotorTestActive = options.isMotorTestActive ?? isMotorTestSessionActive;}

  async load(key: SetupUiSessionKey): Promise<OsdLoadOutcome> {
    const captured = this.capture(key); if ('reason' in captured) return {kind: 'REJECTED', reason: captured.reason};
    const {client, scheduler, epoch} = captured; let interlock;
    try {interlock = acquireMotorConfigurationInterlock(client);} catch (error) {return error instanceof MotorConfigurationTransactionInProgressError ? {kind: 'REJECTED', reason: 'CONFIGURATION_BUSY'} : {kind: 'FAILED', error};}
    try {
      const result = await this.operations(key.sessionId, client, scheduler).execute<MspOsdSnapshot>({id: `osd:load:${key.sessionId}:${key.generation}`, sessionEffect: 'KEEP_SESSION', validate: context => context.clientState === 'READY' ? {allowed: true} : {allowed: false, error: new OsdPreflightError('LINK_RECOVERING')}, execute: async requester => {this.assertLive(key, client, epoch); return this.readSnapshot(requester);}});
      if (result.status === 'SUCCEEDED') return {kind: 'LOADED', snapshot: rememberConfigurationSession(result.result, key)};
      if (result.status === 'SESSION_ENDED' || result.status === 'OUTCOME_UNKNOWN') return {kind: 'SESSION_ENDED'};
      return result.error instanceof OsdPreflightError ? {kind: 'REJECTED', reason: result.error.reason} : {kind: 'FAILED', error: result.error};
    } finally {interlock.release();}
  }

  async save(key: SetupUiSessionKey, original: MspOsdSnapshot, draft: OsdConfigurationDraft): Promise<OsdSaveOutcome> {
    /* SESSION-BOUND DRAFT OWNERSHIP.
       FIRST, before the no-op check, before capture(), before any wire
       access at all: a baseline produced under a DIFFERENT session may
       not be written under this one. Two byte-identical boards defeat
       every other guard here - stale-base compares configuration, and
       assertLive compares liveness; neither asks which aircraft the
       operator was editing. See core/state/configurationSessionOwnership. */
    if (!isOwnedByConfigurationSession(original, key)) return {kind: 'REJECTED', reason: 'SESSION_CHANGED'};
    if (osdDraftsEqual(createOsdConfigurationDraft(original), draft)) return {kind: 'NO_CHANGES', snapshot: original};
    if (validateOsdDraft(draft, original).length > 0) return {kind: 'REJECTED', reason: 'INVALID_CONFIGURATION'};
    const captured = this.capture(key); if ('reason' in captured) return {kind: 'REJECTED', reason: captured.reason};
    const {client, scheduler, epoch} = captured; let interlock;
    try {interlock = acquireMotorConfigurationInterlock(client);} catch (error) {return error instanceof MotorConfigurationTransactionInProgressError ? {kind: 'REJECTED', reason: 'CONFIGURATION_BUSY'} : {kind: 'FAILED', error};}
    try {
      const acquisition = this.boxIdsFor(key.sessionId, client); const identity: BoxIdsOwnerIdentity = {physicalGeneration: key.generation, mspEpoch: epoch};
      const result = await this.operations(key.sessionId, client, scheduler).execute<{snapshot?: MspOsdSnapshot; readbackError?: unknown}>({
        id: `osd:save:${key.sessionId}:${key.generation}`, sessionEffect: 'KEEP_SESSION', validate: context => context.clientState === 'READY' ? {allowed: true} : {allowed: false, error: new OsdPreflightError('LINK_RECOVERING')},
        execute: async requester => {
          this.assertLive(key, client, epoch); const fresh = await this.readSnapshot(requester); if (!osdSnapshotsEqual(fresh, original)) throw new OsdPreflightError('STALE_BASE');
          await this.assertDisarmed(key, client, epoch, requester, acquisition, identity);
          const ledger = new MutationLedger<OsdSaveStage>();
          for (const write of encodeChangedOsdConfiguration(original, draft)) await this.writeOnce(requester, MSP_SET_OSD_CONFIG, write.payload, {group: write.group, index: write.index}, key, client, epoch, ledger);
          /* PERSISTENCE NEVER FOLLOWS LOST LIVENESS. */
          await this.writeOnce(requester, MSP_EEPROM_WRITE, EMPTY, {group: 'EEPROM'}, key, client, epoch, ledger);
          try {const snapshot = await this.readSnapshot(requester); if (!osdDraftsEqual(createOsdConfigurationDraft(snapshot), draft)) throw new Error('OSD readback does not match saved values.'); return {snapshot};} catch (error) {return {readbackError: error};}
        },
      });
      if (result.status === 'SUCCEEDED') return result.result.snapshot !== undefined ? {kind: 'SAVED_VERIFIED', snapshot: rememberConfigurationSession(result.result.snapshot, key)} : {kind: 'SAVED_UNVERIFIED', error: result.result.readbackError};
      if (result.status === 'OUTCOME_UNKNOWN') {
        if (!ambiguousCause(result.reason)) return {kind: 'SESSION_ENDED'};
        if (result.reason.partial) return {kind: 'PARTIAL_UNPERSISTED', confirmedStages: result.reason.confirmedStages, failedStage: result.reason.stage, definitelyNotSent: result.reason.definitelyNotSent};
        return {kind: 'UNCONFIRMED', stage: result.reason.stage, confirmedStages: result.reason.confirmedStages};
      }
      if (result.status === 'SESSION_ENDED') return {kind: 'SESSION_ENDED'};
      return result.error instanceof OsdPreflightError ? {kind: 'REJECTED', reason: result.error.reason} : {kind: 'FAILED', error: result.error};
    } finally {interlock.release();}
  }

  private async readSnapshot(requester: MspRequester): Promise<MspOsdSnapshot> {const config = decodeOsdConfiguration((await requester.request(MSP_OSD_CONFIG, EMPTY, {wireFormat: 'v1'})).payload); const canvas = decodeOsdCanvas((await requester.request(MSP_OSD_CANVAS, EMPTY, {wireFormat: 'v1'})).payload); return Object.freeze({config, canvas});}
  /**
   * THE SINGLE FUNNEL EVERY MUTATION PASSES THROUGH.
   *
   * U-R1. Liveness is asserted HERE, in the same synchronous turn as the
   * request it authorises - no `await` sits between the check and the
   * submission it guards. The ledger is what lets a stop at any stage
   * name the groups the board actually acknowledged, instead of an
   * ordinary failure that reads as "nothing happened".
   */
  private async writeOnce(requester: MspRequester, command: number, payload: Uint8Array, stage: OsdSaveStage, key: SetupUiSessionKey, client: OsdClient, epoch: number, ledger: MutationLedger<OsdSaveStage>): Promise<void> {
    try {this.assertLive(key, client, epoch);}
    catch (error) {
      if (!ledger.hasMutated) throw error;
      throw new AmbiguousOsdWriteError(new MutationStoppedError(stage, ledger.acknowledgedStages, error), stage, ledger.acknowledgedStages, true, true);
    }
    try {await requester.request(command, payload, {wireFormat: 'v1'});}
    catch (error) {
      const code = errorCode(error);
      if (code !== undefined && DEFINITELY_NOT_SENT.has(code)) {
        if (!ledger.hasMutated) throw error;
        throw new AmbiguousOsdWriteError(error, stage, ledger.acknowledgedStages, true, true);
      }
      throw new AmbiguousOsdWriteError(error, stage, ledger.acknowledgedStages, false, false);
    }
    ledger.acknowledge(stage);
  }
  private capture(key: SetupUiSessionKey): {client: OsdClient; scheduler: MspTelemetryScheduler; epoch: number} | {reason: OsdBlockReason} {if (this.appStateOwner.getPhase() !== 'ACTIVE') return {reason: 'APP_BACKGROUNDED'}; if (this.isMotorTestActive(key.sessionId)) return {reason: 'MOTOR_TEST_ACTIVE'}; const identification = this.coordinator.getIdentificationState(key.sessionId); if (identification.status === 'IDLE' || identification.status === 'RUNNING') return {reason: 'IDENTIFYING'}; if (!isSupportedConfigurationApi(identification)) return {reason: 'UNSUPPORTED_FIRMWARE'}; const client = this.coordinator.getActiveMspClient(key.sessionId); const scheduler = this.coordinator.getTelemetryScheduler(key.sessionId); if (this.coordinator.getOwnershipState(key.sessionId) !== 'ACTIVE' || this.coordinator.getSessionKey(key.sessionId)?.generation !== key.generation || client === undefined || scheduler === undefined) return {reason: 'DISCONNECTED'}; if (this.coordinator.getMspRecoveryState(key.sessionId) !== 'READY') return {reason: 'LINK_RECOVERING'}; return {client, scheduler, epoch: client.getEpoch()};}
  private assertLive(key: SetupUiSessionKey, client: OsdClient, epoch: number): void {if (this.appStateOwner.getPhase() !== 'ACTIVE') throw new OsdPreflightError('APP_BACKGROUNDED'); if (this.isMotorTestActive(key.sessionId)) throw new OsdPreflightError('MOTOR_TEST_ACTIVE'); if (this.coordinator.getOwnershipState(key.sessionId) !== 'ACTIVE' || this.coordinator.getSessionKey(key.sessionId)?.generation !== key.generation || this.coordinator.getActiveMspClient(key.sessionId) !== client || client.getEpoch() !== epoch) throw new OsdPreflightError('DISCONNECTED'); if (this.coordinator.getMspRecoveryState(key.sessionId) !== 'READY') throw new OsdPreflightError('LINK_RECOVERING');}
  private operations(sessionId: string, client: OsdClient, scheduler: MspTelemetryScheduler) {return createMspOperationCoordinator(client, scheduler, {captureCurrent: () => this.coordinator.getSessionKey(sessionId)}, {getContext: () => ({clientState: this.coordinator.getMspRecoveryState(sessionId) ?? 'DISCONNECTED', isArmed: false})});}
  private boxIdsFor(sessionId: string, client: OsdClient): BoxIdsAcquisition {const existing = this.boxIds.get(sessionId); if (existing?.client === client) return existing.acquisition; const acquisition = new BoxIdsAcquisition(client); this.boxIds.set(sessionId, {client, acquisition}); return acquisition;}
  private async assertDisarmed(key: SetupUiSessionKey, client: OsdClient, epoch: number, requester: MspRequester, acquisition: BoxIdsAcquisition, identity: BoxIdsOwnerIdentity): Promise<void> {const mapping = await acquisition.acquire(identity, () => this.coordinator.getSessionKey(key.sessionId)?.generation === key.generation && this.coordinator.getActiveMspClient(key.sessionId) === client && client.getEpoch() === epoch); this.assertLive(key, client, epoch); if (mapping.kind !== 'READY') throw new OsdPreflightError('ARMED_STATE_UNKNOWN'); const frame = await requester.request(MSP_STATUS_EX, EMPTY, {wireFormat: 'v1'}); const status = decodeStatusExDiagnostics(frame.payload); const armed = deriveArmedState(status.flightModeFlagsLow32, status.readiness.extraFlightModeFlagBytes, mapping.permanentIds); if (armed === 'ARMED') throw new OsdPreflightError('FC_ARMED'); if (armed !== 'DISARMED' || status.readiness.malformedTail) throw new OsdPreflightError('ARMED_STATE_UNKNOWN'); this.assertLive(key, client, epoch);}
}

export const osdConfigurationController = new OsdConfigurationController();
