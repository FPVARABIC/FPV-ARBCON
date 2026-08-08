import {
  MSP_EEPROM_WRITE, MSP_RSSI_CONFIG, MSP_RC_DEADBAND, MSP_RX_CONFIG, MSP_RX_MAP,
  MSP_SET_RSSI_CONFIG, MSP_SET_RC_DEADBAND, MSP_SET_RX_CONFIG, MSP_SET_RX_MAP,
  MSP_STATUS_EX, BoxIdsAcquisition, MspOperationOutcomeUnknownError,
  createMspOperationCoordinator, createReceiverConfigurationDraft,
  decodeReceiverDeadband, decodeReceiverMap, decodeRssiConfig, decodeRxConfig,
  decodeStatusExDiagnostics, encodeChangedReceiverConfiguration,
  receiverDraftsEqual, receiverSnapshotsEqual, validateReceiverDraft,
  type BoxIdsOwnerIdentity, type MspRequester, type MspTelemetryScheduler,
  type ReceiverConfigurationDraft, type ReceiverConfigurationSnapshot,
  type ReceiverWriteGroup,
} from '../../../core';
import {deriveArmedState} from '../../../core/state/armingBlockers';
import type {MspClientState} from '../../../core/protocol/mspClient';
import {isMotorTestSessionActive} from './motorTestCapability';
import {mspSessionCoordinator, type MspIdentificationState, type MspSessionOwnershipState, type SetupUiSessionKey} from './MspSessionCoordinator';
import {setupAppStateTelemetryOwner, type SetupAppStatePhase} from './setupAppStateTelemetryOwner';
import {acquireMotorConfigurationInterlock, MotorConfigurationTransactionInProgressError} from './motorConfigurationInterlock';

const EMPTY = new Uint8Array(0);
const DEFINITELY_NOT_SENT = new Set(['MSP_ENCODE_FAILED', 'MSP_QUEUE_FULL', 'MSP_TRANSPORT_QUEUE_FULL', 'MSP_RECOVERY_REQUIRED', 'MSP_RECOVERING', 'MSP_REMOTE_ERROR']);

interface ReceiverClient extends MspRequester { getEpoch(): number }
export interface ReceiverSessionCoordinator {
  getOwnershipState(sessionId: string): MspSessionOwnershipState;
  getIdentificationState(sessionId: string): MspIdentificationState;
  getSessionKey(sessionId: string): SetupUiSessionKey | undefined;
  getActiveMspClient(sessionId: string): ReceiverClient | undefined;
  getTelemetryScheduler(sessionId: string): MspTelemetryScheduler | undefined;
  getMspRecoveryState(sessionId: string): MspClientState | undefined;
}
export interface ReceiverAppStateOwner { getPhase(): SetupAppStatePhase }
export type ReceiverBlockReason = 'DISCONNECTED' | 'IDENTIFYING' | 'UNSUPPORTED_FIRMWARE' | 'APP_BACKGROUNDED' | 'LINK_RECOVERING' | 'FC_ARMED' | 'ARMED_STATE_UNKNOWN' | 'MOTOR_TEST_ACTIVE' | 'CONFIGURATION_BUSY' | 'STALE_BASE' | 'INVALID_CONFIGURATION';
export type ReceiverLoadOutcome =
  | {readonly kind: 'LOADED'; readonly snapshot: ReceiverConfigurationSnapshot}
  | {readonly kind: 'REJECTED'; readonly reason: ReceiverBlockReason}
  | {readonly kind: 'SESSION_ENDED'} | {readonly kind: 'FAILED'; readonly error: unknown};
export type ReceiverSaveOutcome =
  | {readonly kind: 'NO_CHANGES'; readonly snapshot: ReceiverConfigurationSnapshot}
  | {readonly kind: 'SAVED_VERIFIED'; readonly snapshot: ReceiverConfigurationSnapshot}
  | {readonly kind: 'SAVED_UNVERIFIED'; readonly error: unknown}
  | {readonly kind: 'REJECTED'; readonly reason: ReceiverBlockReason}
  | {readonly kind: 'UNCONFIRMED'; readonly stage: ReceiverWriteGroup | 'EEPROM'}
  | {readonly kind: 'SESSION_ENDED'} | {readonly kind: 'FAILED'; readonly error: unknown};
export interface ReceiverConfigurationControllerOptions {
  readonly coordinator?: ReceiverSessionCoordinator;
  readonly appStateOwner?: ReceiverAppStateOwner;
  readonly isMotorTestActive?: (sessionId: string) => boolean;
}

class ReceiverPreflightError extends Error {
  constructor(readonly reason: ReceiverBlockReason) { super(`Receiver preflight rejected: ${reason}`); this.name = 'ReceiverPreflightError'; }
}
interface AmbiguousReceiverCause { readonly kind: 'RECEIVER_AMBIGUOUS_WRITE'; readonly stage: ReceiverWriteGroup | 'EEPROM' }
class AmbiguousReceiverWriteError extends MspOperationOutcomeUnknownError {
  constructor(error: unknown, stage: ReceiverWriteGroup | 'EEPROM') { super(Object.freeze({kind: 'RECEIVER_AMBIGUOUS_WRITE', stage, error})); }
}
function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error ? String((error as {code: unknown}).code) : undefined;
}
function ambiguousCause(value: unknown): value is AmbiguousReceiverCause {
  return value !== null && typeof value === 'object' && 'kind' in value && value.kind === 'RECEIVER_AMBIGUOUS_WRITE';
}
const COMMAND_FOR_GROUP: Readonly<Record<ReceiverWriteGroup, number>> = Object.freeze({RX_MAP: MSP_SET_RX_MAP, RSSI: MSP_SET_RSSI_CONFIG, DEADBAND: MSP_SET_RC_DEADBAND, RX_CONFIG: MSP_SET_RX_CONFIG});

export class ReceiverConfigurationController {
  private readonly coordinator: ReceiverSessionCoordinator;
  private readonly appStateOwner: ReceiverAppStateOwner;
  private readonly isMotorTestActive: (sessionId: string) => boolean;
  private readonly boxIds = new Map<string, {client: ReceiverClient; acquisition: BoxIdsAcquisition}>();

  constructor(options: ReceiverConfigurationControllerOptions = {}) {
    this.coordinator = options.coordinator ?? mspSessionCoordinator;
    this.appStateOwner = options.appStateOwner ?? setupAppStateTelemetryOwner;
    this.isMotorTestActive = options.isMotorTestActive ?? isMotorTestSessionActive;
  }

  async load(sessionKey: SetupUiSessionKey): Promise<ReceiverLoadOutcome> {
    const captured = this.capture(sessionKey);
    if ('reason' in captured) return {kind: 'REJECTED', reason: captured.reason};
    const {client, scheduler, epoch} = captured;
    let interlock;
    try { interlock = acquireMotorConfigurationInterlock(client); }
    catch (error) { return error instanceof MotorConfigurationTransactionInProgressError ? {kind: 'REJECTED', reason: 'CONFIGURATION_BUSY'} : {kind: 'FAILED', error}; }
    try {
      const result = await this.operations(sessionKey.sessionId, client, scheduler).execute<ReceiverConfigurationSnapshot>({
        id: `receiver:load:${sessionKey.sessionId}:${sessionKey.generation}`,
        sessionEffect: 'KEEP_SESSION',
        validate: context => context.clientState === 'READY' ? {allowed: true} : {allowed: false, error: new ReceiverPreflightError('LINK_RECOVERING')},
        execute: async requester => { this.assertLive(sessionKey, client, epoch); return this.readSnapshot(requester); },
      });
      if (result.status === 'SUCCEEDED') return {kind: 'LOADED', snapshot: result.result};
      if (result.status === 'SESSION_ENDED' || result.status === 'OUTCOME_UNKNOWN') return {kind: 'SESSION_ENDED'};
      return result.error instanceof ReceiverPreflightError ? {kind: 'REJECTED', reason: result.error.reason} : {kind: 'FAILED', error: result.error};
    } finally { interlock.release(); }
  }

  async save(sessionKey: SetupUiSessionKey, original: ReceiverConfigurationSnapshot, draft: ReceiverConfigurationDraft): Promise<ReceiverSaveOutcome> {
    if (receiverDraftsEqual(createReceiverConfigurationDraft(original), draft)) return {kind: 'NO_CHANGES', snapshot: original};
    if (validateReceiverDraft(draft).length > 0) return {kind: 'REJECTED', reason: 'INVALID_CONFIGURATION'};
    const captured = this.capture(sessionKey);
    if ('reason' in captured) return {kind: 'REJECTED', reason: captured.reason};
    const {client, scheduler, epoch} = captured;
    let interlock;
    try { interlock = acquireMotorConfigurationInterlock(client); }
    catch (error) { return error instanceof MotorConfigurationTransactionInProgressError ? {kind: 'REJECTED', reason: 'CONFIGURATION_BUSY'} : {kind: 'FAILED', error}; }
    try {
      const acquisition = this.boxIdsFor(sessionKey.sessionId, client);
      const identity: BoxIdsOwnerIdentity = {physicalGeneration: sessionKey.generation, mspEpoch: epoch};
      const result = await this.operations(sessionKey.sessionId, client, scheduler).execute<{snapshot?: ReceiverConfigurationSnapshot; readbackError?: unknown}>({
        id: `receiver:save:${sessionKey.sessionId}:${sessionKey.generation}`,
        sessionEffect: 'KEEP_SESSION',
        validate: context => context.clientState === 'READY' ? {allowed: true} : {allowed: false, error: new ReceiverPreflightError('LINK_RECOVERING')},
        execute: async requester => {
          this.assertLive(sessionKey, client, epoch);
          const fresh = await this.readSnapshot(requester);
          if (!receiverSnapshotsEqual(fresh, original)) throw new ReceiverPreflightError('STALE_BASE');
          await this.assertDisarmed(sessionKey, client, epoch, requester, acquisition, identity);
          for (const write of encodeChangedReceiverConfiguration(original, draft)) await this.writeOnce(requester, COMMAND_FOR_GROUP[write.group], write.payload, write.group);
          await this.writeOnce(requester, MSP_EEPROM_WRITE, EMPTY, 'EEPROM');
          try {
            const snapshot = await this.readSnapshot(requester);
            if (!receiverDraftsEqual(createReceiverConfigurationDraft(snapshot), draft)) throw new Error('Receiver readback does not match saved configuration.');
            return {snapshot};
          } catch (error) { return {readbackError: error}; }
        },
      });
      if (result.status === 'SUCCEEDED') return result.result.snapshot !== undefined ? {kind: 'SAVED_VERIFIED', snapshot: result.result.snapshot} : {kind: 'SAVED_UNVERIFIED', error: result.result.readbackError};
      if (result.status === 'OUTCOME_UNKNOWN') return ambiguousCause(result.reason) ? {kind: 'UNCONFIRMED', stage: result.reason.stage} : {kind: 'SESSION_ENDED'};
      if (result.status === 'SESSION_ENDED') return {kind: 'SESSION_ENDED'};
      return result.error instanceof ReceiverPreflightError ? {kind: 'REJECTED', reason: result.error.reason} : {kind: 'FAILED', error: result.error};
    } finally { interlock.release(); }
  }

  private async writeOnce(requester: MspRequester, command: number, payload: Uint8Array, stage: ReceiverWriteGroup | 'EEPROM'): Promise<void> {
    try { await requester.request(command, payload, {wireFormat: 'v1'}); }
    catch (error) { const code = errorCode(error); if (code !== undefined && DEFINITELY_NOT_SENT.has(code)) throw error; throw new AmbiguousReceiverWriteError(error, stage); }
  }

  private capture(key: SetupUiSessionKey): {client: ReceiverClient; scheduler: MspTelemetryScheduler; epoch: number; identity: Extract<MspIdentificationState, {status: 'SUCCEEDED'}>['identity']} | {reason: ReceiverBlockReason} {
    if (this.appStateOwner.getPhase() !== 'ACTIVE') return {reason: 'APP_BACKGROUNDED'};
    if (this.isMotorTestActive(key.sessionId)) return {reason: 'MOTOR_TEST_ACTIVE'};
    const identification = this.coordinator.getIdentificationState(key.sessionId);
    if (identification.status === 'IDLE' || identification.status === 'RUNNING') return {reason: 'IDENTIFYING'};
    if (identification.status !== 'SUCCEEDED' || identification.identity.firmware.identifier !== 'BTFL' || identification.identity.apiVersion.apiVersionMajor !== 1 || identification.identity.apiVersion.apiVersionMinor < 47) return {reason: 'UNSUPPORTED_FIRMWARE'};
    const client = this.coordinator.getActiveMspClient(key.sessionId);
    const scheduler = this.coordinator.getTelemetryScheduler(key.sessionId);
    if (this.coordinator.getOwnershipState(key.sessionId) !== 'ACTIVE' || this.coordinator.getSessionKey(key.sessionId)?.generation !== key.generation || client === undefined || scheduler === undefined) return {reason: 'DISCONNECTED'};
    if (this.coordinator.getMspRecoveryState(key.sessionId) !== 'READY') return {reason: 'LINK_RECOVERING'};
    return {client, scheduler, epoch: client.getEpoch(), identity: identification.identity};
  }

  private assertLive(key: SetupUiSessionKey, client: ReceiverClient, epoch: number): void {
    if (this.appStateOwner.getPhase() !== 'ACTIVE') throw new ReceiverPreflightError('APP_BACKGROUNDED');
    if (this.isMotorTestActive(key.sessionId)) throw new ReceiverPreflightError('MOTOR_TEST_ACTIVE');
    if (this.coordinator.getOwnershipState(key.sessionId) !== 'ACTIVE' || this.coordinator.getSessionKey(key.sessionId)?.generation !== key.generation || this.coordinator.getActiveMspClient(key.sessionId) !== client || client.getEpoch() !== epoch) throw new ReceiverPreflightError('DISCONNECTED');
    if (this.coordinator.getMspRecoveryState(key.sessionId) !== 'READY') throw new ReceiverPreflightError('LINK_RECOVERING');
  }

  private operations(sessionId: string, client: ReceiverClient, scheduler: MspTelemetryScheduler) {
    return createMspOperationCoordinator(client, scheduler, {captureCurrent: () => this.coordinator.getSessionKey(sessionId)}, {getContext: () => ({clientState: this.coordinator.getMspRecoveryState(sessionId) ?? 'DISCONNECTED', isArmed: false})});
  }

  private boxIdsFor(sessionId: string, client: ReceiverClient): BoxIdsAcquisition {
    const existing = this.boxIds.get(sessionId); if (existing?.client === client) return existing.acquisition;
    const acquisition = new BoxIdsAcquisition(client); this.boxIds.set(sessionId, {client, acquisition}); return acquisition;
  }

  private async assertDisarmed(key: SetupUiSessionKey, client: ReceiverClient, epoch: number, requester: MspRequester, acquisition: BoxIdsAcquisition, identity: BoxIdsOwnerIdentity): Promise<void> {
    const mapping = await acquisition.acquire(identity, () => this.coordinator.getSessionKey(key.sessionId)?.generation === key.generation && this.coordinator.getActiveMspClient(key.sessionId) === client && client.getEpoch() === epoch);
    this.assertLive(key, client, epoch);
    if (mapping.kind !== 'READY') throw new ReceiverPreflightError('ARMED_STATE_UNKNOWN');
    const frame = await requester.request(MSP_STATUS_EX, EMPTY, {wireFormat: 'v1'});
    const status = decodeStatusExDiagnostics(frame.payload);
    const armed = deriveArmedState(status.flightModeFlagsLow32, status.readiness.extraFlightModeFlagBytes, mapping.permanentIds);
    if (armed === 'ARMED') throw new ReceiverPreflightError('FC_ARMED');
    if (armed !== 'DISARMED' || status.readiness.malformedTail) throw new ReceiverPreflightError('ARMED_STATE_UNKNOWN');
    this.assertLive(key, client, epoch);
  }

  private async readSnapshot(requester: MspRequester): Promise<ReceiverConfigurationSnapshot> {
    const rx = await requester.request(MSP_RX_CONFIG, EMPTY, {wireFormat: 'v1'});
    const map = await requester.request(MSP_RX_MAP, EMPTY, {wireFormat: 'v1'});
    const rssi = await requester.request(MSP_RSSI_CONFIG, EMPTY, {wireFormat: 'v1'});
    const deadband = await requester.request(MSP_RC_DEADBAND, EMPTY, {wireFormat: 'v1'});
    return Object.freeze({rx: decodeRxConfig(rx.payload), channelMap: decodeReceiverMap(map.payload), rssiChannel: decodeRssiConfig(rssi.payload), deadband: decodeReceiverDeadband(deadband.payload)});
  }
}

export const receiverConfigurationController = new ReceiverConfigurationController();
