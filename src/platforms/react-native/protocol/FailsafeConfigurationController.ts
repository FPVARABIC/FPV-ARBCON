import {
  BUILD_OPTION_GPS,
  MSP_BUILD_INFO,
  MSP_EEPROM_WRITE,
  MSP_FAILSAFE_CONFIG,
  MSP_GPS_RESCUE,
  MSP_RXFAIL_CONFIG,
  MSP_SET_FAILSAFE_CONFIG,
  MSP_SET_GPS_RESCUE,
  MSP_SET_RXFAIL_CONFIG,
  MSP_STATUS_EX,
  BoxIdsAcquisition,
  MspOperationOutcomeUnknownError,
  createFailsafeConfigurationDraft,
  createMspOperationCoordinator,
  decodeBuildOptions,
  decodeFailsafeConfiguration,
  decodeGpsRescue,
  decodeRxFailsafeConfiguration,
  decodeStatusExDiagnostics,
  encodeChangedFailsafeConfiguration,
  failsafeDraftsEqual,
  failsafeSnapshotsEqual,
  validateFailsafeDraft,
  type BoxIdsOwnerIdentity,
  type FailsafeConfigurationDraft,
  type FailsafeWriteGroup,
  type GpsRescueAvailability,
  type MspFailsafeSnapshot,
  type MspGpsRescueConfiguration,
  type MspRequester,
  type MspTelemetryScheduler,
} from '../../../core';
import type {MspClientState} from '../../../core/protocol/mspClient';
import {deriveArmedState} from '../../../core/state/armingBlockers';
import {isMotorTestSessionActive} from './motorTestCapability';
import {mspSessionCoordinator, type MspIdentificationState, type MspSessionOwnershipState, type SetupUiSessionKey} from './MspSessionCoordinator';
import {setupAppStateTelemetryOwner, type SetupAppStatePhase} from './setupAppStateTelemetryOwner';
import {acquireMotorConfigurationInterlock, MotorConfigurationTransactionInProgressError} from './motorConfigurationInterlock';
import {isSupportedConfigurationApi} from './betaflightApiSupport';

const EMPTY = new Uint8Array(0);
/** One table instead of a nested ternary, so adding a write group is a
 * compile error here rather than a silent fall-through to RXFAIL. */
const WRITE_COMMANDS: Readonly<Record<FailsafeWriteGroup, number>> = {FAILSAFE_CONFIG: MSP_SET_FAILSAFE_CONFIG, RXFAIL_CONFIG: MSP_SET_RXFAIL_CONFIG, GPS_RESCUE: MSP_SET_GPS_RESCUE};
const DEFINITELY_NOT_SENT = new Set(['MSP_ENCODE_FAILED', 'MSP_QUEUE_FULL', 'MSP_TRANSPORT_QUEUE_FULL', 'MSP_RECOVERY_REQUIRED', 'MSP_RECOVERING', 'MSP_REMOTE_ERROR']);
interface FailsafeClient extends MspRequester {getEpoch(): number}
export interface FailsafeSessionCoordinator {
  getOwnershipState(sessionId: string): MspSessionOwnershipState;
  getIdentificationState(sessionId: string): MspIdentificationState;
  getSessionKey(sessionId: string): SetupUiSessionKey | undefined;
  getActiveMspClient(sessionId: string): FailsafeClient | undefined;
  getTelemetryScheduler(sessionId: string): MspTelemetryScheduler | undefined;
  getMspRecoveryState(sessionId: string): MspClientState | undefined;
}
export interface FailsafeAppStateOwner {getPhase(): SetupAppStatePhase}
export type FailsafeBlockReason = 'DISCONNECTED' | 'IDENTIFYING' | 'UNSUPPORTED_FIRMWARE' | 'APP_BACKGROUNDED' | 'LINK_RECOVERING' | 'FC_ARMED' | 'ARMED_STATE_UNKNOWN' | 'MOTOR_TEST_ACTIVE' | 'CONFIGURATION_BUSY' | 'STALE_BASE' | 'INVALID_CONFIGURATION';
export type FailsafeSaveStage = {readonly group: FailsafeWriteGroup; readonly index?: number} | {readonly group: 'EEPROM'};
export type FailsafeLoadOutcome = {readonly kind: 'LOADED'; readonly snapshot: MspFailsafeSnapshot} | {readonly kind: 'REJECTED'; readonly reason: FailsafeBlockReason} | {readonly kind: 'SESSION_ENDED'} | {readonly kind: 'FAILED'; readonly error: unknown};
export type FailsafeSaveOutcome = {readonly kind: 'NO_CHANGES'; readonly snapshot: MspFailsafeSnapshot} | {readonly kind: 'SAVED_VERIFIED'; readonly snapshot: MspFailsafeSnapshot} | {readonly kind: 'SAVED_UNVERIFIED'; readonly error: unknown} | {readonly kind: 'REJECTED'; readonly reason: FailsafeBlockReason} | {readonly kind: 'UNCONFIRMED'; readonly stage: FailsafeSaveStage} | {readonly kind: 'SESSION_ENDED'} | {readonly kind: 'FAILED'; readonly error: unknown};
export interface FailsafeConfigurationControllerOptions {readonly coordinator?: FailsafeSessionCoordinator; readonly appStateOwner?: FailsafeAppStateOwner; readonly isMotorTestActive?: (sessionId: string) => boolean}

class FailsafePreflightError extends Error {constructor(readonly reason: FailsafeBlockReason) {super(`Failsafe preflight rejected: ${reason}`); this.name = 'FailsafePreflightError';}}
interface AmbiguousFailsafeCause {readonly kind: 'FAILSAFE_AMBIGUOUS_WRITE'; readonly stage: FailsafeSaveStage}
class AmbiguousFailsafeWriteError extends MspOperationOutcomeUnknownError {constructor(error: unknown, stage: FailsafeSaveStage) {super(Object.freeze({kind: 'FAILSAFE_AMBIGUOUS_WRITE', stage, error}));}}
function errorCode(error: unknown): string | undefined {return error !== null && typeof error === 'object' && 'code' in error ? String((error as {code: unknown}).code) : undefined;}
function ambiguousCause(value: unknown): value is AmbiguousFailsafeCause {return value !== null && typeof value === 'object' && 'kind' in value && value.kind === 'FAILSAFE_AMBIGUOUS_WRITE';}

export class FailsafeConfigurationController {
  private readonly coordinator: FailsafeSessionCoordinator;
  private readonly appStateOwner: FailsafeAppStateOwner;
  private readonly isMotorTestActive: (sessionId: string) => boolean;
  private readonly boxIds = new Map<string, {client: FailsafeClient; acquisition: BoxIdsAcquisition}>();
  constructor(options: FailsafeConfigurationControllerOptions = {}) {this.coordinator = options.coordinator ?? mspSessionCoordinator; this.appStateOwner = options.appStateOwner ?? setupAppStateTelemetryOwner; this.isMotorTestActive = options.isMotorTestActive ?? isMotorTestSessionActive;}

  async load(key: SetupUiSessionKey): Promise<FailsafeLoadOutcome> {
    const captured = this.capture(key); if ('reason' in captured) return {kind: 'REJECTED', reason: captured.reason};
    const {client, scheduler, epoch} = captured; let interlock;
    try {interlock = acquireMotorConfigurationInterlock(client);} catch (error) {return error instanceof MotorConfigurationTransactionInProgressError ? {kind: 'REJECTED', reason: 'CONFIGURATION_BUSY'} : {kind: 'FAILED', error};}
    try {
      const result = await this.operations(key.sessionId, client, scheduler).execute<MspFailsafeSnapshot>({id: `failsafe:load:${key.sessionId}:${key.generation}`, sessionEffect: 'KEEP_SESSION', validate: context => context.clientState === 'READY' ? {allowed: true} : {allowed: false, error: new FailsafePreflightError('LINK_RECOVERING')}, execute: async requester => {this.assertLive(key, client, epoch); return this.readSnapshot(requester);}});
      if (result.status === 'SUCCEEDED') return {kind: 'LOADED', snapshot: result.result};
      if (result.status === 'SESSION_ENDED' || result.status === 'OUTCOME_UNKNOWN') return {kind: 'SESSION_ENDED'};
      return result.error instanceof FailsafePreflightError ? {kind: 'REJECTED', reason: result.error.reason} : {kind: 'FAILED', error: result.error};
    } finally {interlock.release();}
  }

  async save(key: SetupUiSessionKey, original: MspFailsafeSnapshot, draft: FailsafeConfigurationDraft): Promise<FailsafeSaveOutcome> {
    if (failsafeDraftsEqual(createFailsafeConfigurationDraft(original), draft)) return {kind: 'NO_CHANGES', snapshot: original};
    if (validateFailsafeDraft(draft, original).length > 0) return {kind: 'REJECTED', reason: 'INVALID_CONFIGURATION'};
    const captured = this.capture(key); if ('reason' in captured) return {kind: 'REJECTED', reason: captured.reason};
    const {client, scheduler, epoch} = captured; let interlock;
    try {interlock = acquireMotorConfigurationInterlock(client);} catch (error) {return error instanceof MotorConfigurationTransactionInProgressError ? {kind: 'REJECTED', reason: 'CONFIGURATION_BUSY'} : {kind: 'FAILED', error};}
    try {
      const acquisition = this.boxIdsFor(key.sessionId, client); const identity: BoxIdsOwnerIdentity = {physicalGeneration: key.generation, mspEpoch: epoch};
      const result = await this.operations(key.sessionId, client, scheduler).execute<{snapshot?: MspFailsafeSnapshot; readbackError?: unknown}>({
        id: `failsafe:save:${key.sessionId}:${key.generation}`, sessionEffect: 'KEEP_SESSION', validate: context => context.clientState === 'READY' ? {allowed: true} : {allowed: false, error: new FailsafePreflightError('LINK_RECOVERING')},
        execute: async requester => {
          this.assertLive(key, client, epoch); const fresh = await this.readSnapshot(requester); if (!failsafeSnapshotsEqual(fresh, original)) throw new FailsafePreflightError('STALE_BASE');
          await this.assertDisarmed(key, client, epoch, requester, acquisition, identity);
          for (const write of encodeChangedFailsafeConfiguration(original, draft)) {
            await this.writeOnce(requester, WRITE_COMMANDS[write.group], write.payload, {group: write.group, index: write.index});
          }
          await this.writeOnce(requester, MSP_EEPROM_WRITE, EMPTY, {group: 'EEPROM'});
          try {const snapshot = await this.readSnapshot(requester); if (!failsafeDraftsEqual(createFailsafeConfigurationDraft(snapshot), draft)) throw new Error('Failsafe readback does not match saved values.'); return {snapshot};} catch (error) {return {readbackError: error};}
        },
      });
      if (result.status === 'SUCCEEDED') return result.result.snapshot !== undefined ? {kind: 'SAVED_VERIFIED', snapshot: result.result.snapshot} : {kind: 'SAVED_UNVERIFIED', error: result.result.readbackError};
      if (result.status === 'OUTCOME_UNKNOWN') return ambiguousCause(result.reason) ? {kind: 'UNCONFIRMED', stage: result.reason.stage} : {kind: 'SESSION_ENDED'};
      if (result.status === 'SESSION_ENDED') return {kind: 'SESSION_ENDED'};
      return result.error instanceof FailsafePreflightError ? {kind: 'REJECTED', reason: result.error.reason} : {kind: 'FAILED', error: result.error};
    } finally {interlock.release();}
  }

  private async writeOnce(requester: MspRequester, command: number, payload: Uint8Array, stage: FailsafeSaveStage): Promise<void> {try {await requester.request(command, payload, {wireFormat: 'v1'});} catch (error) {const code = errorCode(error); if (code !== undefined && DEFINITELY_NOT_SENT.has(code)) throw error; throw new AmbiguousFailsafeWriteError(error, stage);}}
  private capture(key: SetupUiSessionKey): {client: FailsafeClient; scheduler: MspTelemetryScheduler; epoch: number} | {reason: FailsafeBlockReason} {
    if (this.appStateOwner.getPhase() !== 'ACTIVE') return {reason: 'APP_BACKGROUNDED'}; if (this.isMotorTestActive(key.sessionId)) return {reason: 'MOTOR_TEST_ACTIVE'};
    const identification = this.coordinator.getIdentificationState(key.sessionId); if (identification.status === 'IDLE' || identification.status === 'RUNNING') return {reason: 'IDENTIFYING'};
    if (!isSupportedConfigurationApi(identification)) return {reason: 'UNSUPPORTED_FIRMWARE'};
    const client = this.coordinator.getActiveMspClient(key.sessionId); const scheduler = this.coordinator.getTelemetryScheduler(key.sessionId);
    if (this.coordinator.getOwnershipState(key.sessionId) !== 'ACTIVE' || this.coordinator.getSessionKey(key.sessionId)?.generation !== key.generation || client === undefined || scheduler === undefined) return {reason: 'DISCONNECTED'};
    if (this.coordinator.getMspRecoveryState(key.sessionId) !== 'READY') return {reason: 'LINK_RECOVERING'}; return {client, scheduler, epoch: client.getEpoch()};
  }
  private assertLive(key: SetupUiSessionKey, client: FailsafeClient, epoch: number): void {if (this.appStateOwner.getPhase() !== 'ACTIVE') throw new FailsafePreflightError('APP_BACKGROUNDED'); if (this.isMotorTestActive(key.sessionId)) throw new FailsafePreflightError('MOTOR_TEST_ACTIVE'); if (this.coordinator.getOwnershipState(key.sessionId) !== 'ACTIVE' || this.coordinator.getSessionKey(key.sessionId)?.generation !== key.generation || this.coordinator.getActiveMspClient(key.sessionId) !== client || client.getEpoch() !== epoch) throw new FailsafePreflightError('DISCONNECTED'); if (this.coordinator.getMspRecoveryState(key.sessionId) !== 'READY') throw new FailsafePreflightError('LINK_RECOVERING');}
  private operations(sessionId: string, client: FailsafeClient, scheduler: MspTelemetryScheduler) {return createMspOperationCoordinator(client, scheduler, {captureCurrent: () => this.coordinator.getSessionKey(sessionId)}, {getContext: () => ({clientState: this.coordinator.getMspRecoveryState(sessionId) ?? 'DISCONNECTED', isArmed: false})});}
  private boxIdsFor(sessionId: string, client: FailsafeClient): BoxIdsAcquisition {const existing = this.boxIds.get(sessionId); if (existing?.client === client) return existing.acquisition; const acquisition = new BoxIdsAcquisition(client); this.boxIds.set(sessionId, {client, acquisition}); return acquisition;}
  private async assertDisarmed(key: SetupUiSessionKey, client: FailsafeClient, epoch: number, requester: MspRequester, acquisition: BoxIdsAcquisition, identity: BoxIdsOwnerIdentity): Promise<void> {const mapping = await acquisition.acquire(identity, () => this.coordinator.getSessionKey(key.sessionId)?.generation === key.generation && this.coordinator.getActiveMspClient(key.sessionId) === client && client.getEpoch() === epoch); this.assertLive(key, client, epoch); if (mapping.kind !== 'READY') throw new FailsafePreflightError('ARMED_STATE_UNKNOWN'); const frame = await requester.request(MSP_STATUS_EX, EMPTY, {wireFormat: 'v1'}); const status = decodeStatusExDiagnostics(frame.payload); const armed = deriveArmedState(status.flightModeFlagsLow32, status.readiness.extraFlightModeFlagBytes, mapping.permanentIds); if (armed === 'ARMED') throw new FailsafePreflightError('FC_ARMED'); if (armed !== 'DISARMED' || status.readiness.malformedTail) throw new FailsafePreflightError('ARMED_STATE_UNKNOWN'); this.assertLive(key, client, epoch);}
  private async readSnapshot(requester: MspRequester): Promise<MspFailsafeSnapshot> {const config = decodeFailsafeConfiguration((await requester.request(MSP_FAILSAFE_CONFIG, EMPTY, {wireFormat: 'v1'})).payload); const channels = decodeRxFailsafeConfiguration((await requester.request(MSP_RXFAIL_CONFIG, EMPTY, {wireFormat: 'v1'})).payload); const build = decodeBuildOptions((await requester.request(MSP_BUILD_INFO, EMPTY, {wireFormat: 'v1'})).payload); const supportsGpsRescue = build.optionIds.has(BUILD_OPTION_GPS); const rescue = await this.readGpsRescue(requester, supportsGpsRescue); return Object.freeze({config, channels, supportsGpsRescue, ...rescue});}

  /**
   * MSP_GPS_RESCUE is an OPTIONAL command, and that is the whole reason
   * this is a separate method rather than another line in readSnapshot.
   *
   * The firmware compiles the handler out under `#ifdef USE_GPS_RESCUE`
   * and `#ifndef USE_WING`, so a wing build - or any build without rescue
   * - answers with an MSP error frame. That must degrade the GPS Rescue
   * card to "not on this board", NOT take the whole Failsafe screen down;
   * an operator who cannot reach the failsafe delay because the board has
   * no rescue support is strictly worse off.
   *
   * The tolerance is deliberately narrow. Only an error frame the BOARD
   * sent (MSP_REMOTE_ERROR) means "unsupported", and only a payload this
   * app could not decode means "unreadable". A timeout, a queue failure
   * or a link recovery is NOT swallowed - it propagates and fails the
   * load, because those say the link is unwell and reporting them as an
   * absent feature would hide that.
   */
  private async readGpsRescue(requester: MspRequester, supportsGpsRescue: boolean): Promise<{gpsRescue?: MspGpsRescueConfiguration; gpsRescueAvailability: GpsRescueAvailability}> {
    if (!supportsGpsRescue) return {gpsRescueAvailability: 'NO_GPS_IN_BUILD'};
    let payload: Uint8Array;
    try {
      payload = (await requester.request(MSP_GPS_RESCUE, EMPTY, {wireFormat: 'v1'})).payload;
    } catch (error) {
      if (errorCode(error) === 'MSP_REMOTE_ERROR') return {gpsRescueAvailability: 'COMMAND_UNSUPPORTED'};
      throw error;
    }
    try {
      return {gpsRescue: decodeGpsRescue(payload), gpsRescueAvailability: 'PRESENT'};
    } catch {
      return {gpsRescueAvailability: 'UNREADABLE'};
    }
  }
}

export const failsafeConfigurationController = new FailsafeConfigurationController();
