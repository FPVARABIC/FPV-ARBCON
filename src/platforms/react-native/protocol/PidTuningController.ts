import {
  MSP_ADVANCED_CONFIG, MSP_EEPROM_WRITE, MSP_FILTER_CONFIG, MSP_PID, MSP_PID_ADVANCED,
  MSP_RC_TUNING, MSP_SET_FILTER_CONFIG, MSP_SET_PID, MSP_SET_PID_ADVANCED, MSP_SET_RC_TUNING, MSP_STATUS_EX,
  BoxIdsAcquisition, MspOperationOutcomeUnknownError, createMspOperationCoordinator,
  createPidTuningDraft, decodeAdvancedConfig, decodePidTuningSnapshot, decodeStatusExDiagnostics,
  encodeChangedPidTuning, pidTuningDraftsEqual, pidTuningSnapshotsEqual,
  validatePidTuningDraft, type BoxIdsOwnerIdentity, type MspPidTuningSnapshot,
  type MspRequester, type MspTelemetryScheduler, type PidTuningDraft,
  type PidTuningWriteGroup,
} from '../../../core';
import {MSP_SELECT_SETTING} from '../../../core/protocol/msp/commands/mspCommands';
import {encodeSelectSetting, isEncodableProfileIndex} from '../../../core/protocol/msp/encoding/encodeSelectSetting';
import {deriveArmedState} from '../../../core/state/armingBlockers';
import type {MspClientState} from '../../../core/protocol/mspClient';
import {isMotorTestSessionActive} from './motorTestCapability';
import {mspSessionCoordinator, type MspIdentificationState, type MspSessionOwnershipState, type SetupUiSessionKey} from './MspSessionCoordinator';
import {setupAppStateTelemetryOwner, type SetupAppStatePhase} from './setupAppStateTelemetryOwner';
import {acquireMotorConfigurationInterlock, MotorConfigurationTransactionInProgressError} from './motorConfigurationInterlock';
import {isSupportedConfigurationApi} from './betaflightApiSupport';

const EMPTY = new Uint8Array(0);
const DEFINITELY_NOT_SENT = new Set(['MSP_ENCODE_FAILED', 'MSP_QUEUE_FULL', 'MSP_TRANSPORT_QUEUE_FULL', 'MSP_RECOVERY_REQUIRED', 'MSP_RECOVERING', 'MSP_REMOTE_ERROR']);

interface PidClient extends MspRequester { getEpoch(): number }
export interface PidSessionCoordinator {
  getOwnershipState(sessionId: string): MspSessionOwnershipState;
  getIdentificationState(sessionId: string): MspIdentificationState;
  getSessionKey(sessionId: string): SetupUiSessionKey | undefined;
  getActiveMspClient(sessionId: string): PidClient | undefined;
  getTelemetryScheduler(sessionId: string): MspTelemetryScheduler | undefined;
  getMspRecoveryState(sessionId: string): MspClientState | undefined;
}
export interface PidAppStateOwner { getPhase(): SetupAppStatePhase }
export type PidBlockReason = 'DISCONNECTED' | 'IDENTIFYING' | 'UNSUPPORTED_FIRMWARE' | 'APP_BACKGROUNDED' | 'LINK_RECOVERING' | 'FC_ARMED' | 'ARMED_STATE_UNKNOWN' | 'MOTOR_TEST_ACTIVE' | 'CONFIGURATION_BUSY' | 'STALE_BASE' | 'INVALID_CONFIGURATION';
/**
 * Switching the ACTIVE profile is not a settings write, so it gets its
 * own outcome rather than being squeezed into PidSaveOutcome.
 *
 *   SWITCHED       the board acknowledged AND reads back as the profile
 *                  that was asked for, with its data reloaded
 *   NOT_APPLIED    acknowledged, but the board still reports a different
 *                  active profile - never presented as success
 *   UNCONFIRMED    the select itself may or may not have reached the FC
 */
export type PidProfileSwitchOutcome =
  | {readonly kind: 'SWITCHED'; readonly snapshot: MspPidTuningSnapshot}
  | {readonly kind: 'NOT_APPLIED'; readonly snapshot: MspPidTuningSnapshot}
  | {readonly kind: 'UNCONFIRMED'}
  | {readonly kind: 'REJECTED'; readonly reason: PidBlockReason}
  | {readonly kind: 'SESSION_ENDED'}
  | {readonly kind: 'FAILED'; readonly error: unknown};

/** Which of the two independent profile selectors to move. */
export type PidProfileKind = 'PID' | 'RATE';

export type PidLoadOutcome = {readonly kind: 'LOADED'; readonly snapshot: MspPidTuningSnapshot} | {readonly kind: 'REJECTED'; readonly reason: PidBlockReason} | {readonly kind: 'SESSION_ENDED'} | {readonly kind: 'FAILED'; readonly error: unknown};
export type PidSaveOutcome = {readonly kind: 'NO_CHANGES'; readonly snapshot: MspPidTuningSnapshot} | {readonly kind: 'SAVED_VERIFIED'; readonly snapshot: MspPidTuningSnapshot} | {readonly kind: 'SAVED_UNVERIFIED'; readonly error: unknown} | {readonly kind: 'REJECTED'; readonly reason: PidBlockReason} | {readonly kind: 'UNCONFIRMED'; readonly stage: PidTuningWriteGroup | 'EEPROM'} | {readonly kind: 'SESSION_ENDED'} | {readonly kind: 'FAILED'; readonly error: unknown};
export interface PidTuningControllerOptions { readonly coordinator?: PidSessionCoordinator; readonly appStateOwner?: PidAppStateOwner; readonly isMotorTestActive?: (sessionId: string) => boolean }

class PidPreflightError extends Error { constructor(readonly reason: PidBlockReason) { super(`PID preflight rejected: ${reason}`); this.name = 'PidPreflightError'; } }
interface AmbiguousPidCause { readonly kind: 'PID_AMBIGUOUS_WRITE'; readonly stage: PidTuningWriteGroup | 'EEPROM' }
class AmbiguousPidWriteError extends MspOperationOutcomeUnknownError { constructor(error: unknown, stage: PidTuningWriteGroup | 'EEPROM') { super(Object.freeze({kind: 'PID_AMBIGUOUS_WRITE', stage, error})); } }
/**
 * A profile select that may or may not have reached the board.
 *
 * Kept SEPARATE from AmbiguousPidWriteError on purpose: a save reports
 * which settings GROUP is in doubt, and "the active profile is in doubt"
 * is a different fact that must not be squeezed into that vocabulary.
 */
class AmbiguousPidProfileSelectError extends MspOperationOutcomeUnknownError {
  constructor(error: unknown) { super(Object.freeze({kind: 'PID_AMBIGUOUS_PROFILE_SELECT', error})); }
}
function errorCode(error: unknown): string | undefined { return error !== null && typeof error === 'object' && 'code' in error ? String((error as {code: unknown}).code) : undefined; }
function ambiguousCause(value: unknown): value is AmbiguousPidCause { return value !== null && typeof value === 'object' && 'kind' in value && value.kind === 'PID_AMBIGUOUS_WRITE'; }
const COMMAND_FOR_GROUP: Readonly<Record<PidTuningWriteGroup, number>> = Object.freeze({
  PID: MSP_SET_PID,
  PID_ADVANCED: MSP_SET_PID_ADVANCED,
  RC_TUNING: MSP_SET_RC_TUNING,
  FILTER_CONFIG: MSP_SET_FILTER_CONFIG,
});

export class PidTuningController {
  private readonly coordinator: PidSessionCoordinator;
  private readonly appStateOwner: PidAppStateOwner;
  private readonly isMotorTestActive: (sessionId: string) => boolean;
  private readonly boxIds = new Map<string, {client: PidClient; acquisition: BoxIdsAcquisition}>();

  constructor(options: PidTuningControllerOptions = {}) {
    this.coordinator = options.coordinator ?? mspSessionCoordinator;
    this.appStateOwner = options.appStateOwner ?? setupAppStateTelemetryOwner;
    this.isMotorTestActive = options.isMotorTestActive ?? isMotorTestSessionActive;
  }

  async load(key: SetupUiSessionKey): Promise<PidLoadOutcome> {
    const captured = this.capture(key); if ('reason' in captured) return {kind: 'REJECTED', reason: captured.reason};
    const {client, scheduler, epoch, gyroSampleRateHz} = captured; let interlock;
    try { interlock = acquireMotorConfigurationInterlock(client); }
    catch (error) { return error instanceof MotorConfigurationTransactionInProgressError ? {kind: 'REJECTED', reason: 'CONFIGURATION_BUSY'} : {kind: 'FAILED', error}; }
    try {
      const result = await this.operations(key.sessionId, client, scheduler).execute<MspPidTuningSnapshot>({
        id: `pid:load:${key.sessionId}:${key.generation}`, sessionEffect: 'KEEP_SESSION',
        validate: context => context.clientState === 'READY' ? {allowed: true} : {allowed: false, error: new PidPreflightError('LINK_RECOVERING')},
        execute: async requester => { this.assertLive(key, client, epoch); return this.readSnapshot(requester, gyroSampleRateHz); },
      });
      if (result.status === 'SUCCEEDED') return {kind: 'LOADED', snapshot: result.result};
      if (result.status === 'SESSION_ENDED' || result.status === 'OUTCOME_UNKNOWN') return {kind: 'SESSION_ENDED'};
      return result.error instanceof PidPreflightError ? {kind: 'REJECTED', reason: result.error.reason} : {kind: 'FAILED', error: result.error};
    } finally { interlock.release(); }
  }

  async save(key: SetupUiSessionKey, original: MspPidTuningSnapshot, draft: PidTuningDraft): Promise<PidSaveOutcome> {
    if (pidTuningDraftsEqual(createPidTuningDraft(original), draft)) return {kind: 'NO_CHANGES', snapshot: original};
    if (validatePidTuningDraft(draft, original).length > 0) return {kind: 'REJECTED', reason: 'INVALID_CONFIGURATION'};
    const captured = this.capture(key); if ('reason' in captured) return {kind: 'REJECTED', reason: captured.reason};
    const {client, scheduler, epoch, gyroSampleRateHz} = captured; let interlock;
    try { interlock = acquireMotorConfigurationInterlock(client); }
    catch (error) { return error instanceof MotorConfigurationTransactionInProgressError ? {kind: 'REJECTED', reason: 'CONFIGURATION_BUSY'} : {kind: 'FAILED', error}; }
    try {
      const acquisition = this.boxIdsFor(key.sessionId, client); const identity: BoxIdsOwnerIdentity = {physicalGeneration: key.generation, mspEpoch: epoch};
      const result = await this.operations(key.sessionId, client, scheduler).execute<{snapshot?: MspPidTuningSnapshot; readbackError?: unknown}>({
        id: `pid:save:${key.sessionId}:${key.generation}`, sessionEffect: 'KEEP_SESSION',
        validate: context => context.clientState === 'READY' ? {allowed: true} : {allowed: false, error: new PidPreflightError('LINK_RECOVERING')},
        execute: async requester => {
          this.assertLive(key, client, epoch);
          const fresh = await this.readSnapshot(requester, gyroSampleRateHz); if (!pidTuningSnapshotsEqual(fresh, original)) throw new PidPreflightError('STALE_BASE');
          await this.assertDisarmed(key, client, epoch, requester, acquisition, identity);
          for (const write of encodeChangedPidTuning(original, draft)) await this.writeOnce(requester, COMMAND_FOR_GROUP[write.group], write.payload, write.group);
          await this.writeOnce(requester, MSP_EEPROM_WRITE, EMPTY, 'EEPROM');
          try { const snapshot = await this.readSnapshot(requester, gyroSampleRateHz); if (!pidTuningDraftsEqual(createPidTuningDraft(snapshot), draft)) throw new Error('PID readback does not match saved values.'); return {snapshot}; }
          catch (error) { return {readbackError: error}; }
        },
      });
      if (result.status === 'SUCCEEDED') return result.result.snapshot !== undefined ? {kind: 'SAVED_VERIFIED', snapshot: result.result.snapshot} : {kind: 'SAVED_UNVERIFIED', error: result.result.readbackError};
      if (result.status === 'OUTCOME_UNKNOWN') return ambiguousCause(result.reason) ? {kind: 'UNCONFIRMED', stage: result.reason.stage} : {kind: 'SESSION_ENDED'};
      if (result.status === 'SESSION_ENDED') return {kind: 'SESSION_ENDED'};
      return result.error instanceof PidPreflightError ? {kind: 'REJECTED', reason: result.error.reason} : {kind: 'FAILED', error: result.error};
    } finally { interlock.release(); }
  }

  private async writeOnce(requester: MspRequester, command: number, payload: Uint8Array, stage: PidTuningWriteGroup | 'EEPROM'): Promise<void> {
    try { await requester.request(command, payload, {wireFormat: 'v1'}); }
    catch (error) { const code = errorCode(error); if (code !== undefined && DEFINITELY_NOT_SENT.has(code)) throw error; throw new AmbiguousPidWriteError(error, stage); }
  }
  /**
   * SELECTS THE ACTIVE PID OR RATE PROFILE ON THE BOARD.
   *
   * The screen used to display which profile was active and offer no way
   * to change it, so a pilot with a cruise profile and a freestyle
   * profile had to reach for the CLI or the radio.
   *
   * WHY THIS IS NOT A SAVE. MSP_SELECT_SETTING changes which profile is
   * running; it writes no setting and needs no EEPROM write. So this
   * deliberately does NOT run the save contract - there is no draft, no
   * diff and nothing to persist.
   *
   * WHAT IT DOES KEEP, because the risk is the same:
   *
   *   - the same preflight as a save (connected, identified, right
   *     generation and epoch, link READY, app foregrounded, no motor
   *     test) and the same interlock, so a profile cannot change
   *     underneath a configuration transaction;
   *
   *   - DISARMED is proven first. Betaflight's own firmware refuses a
   *     profile change while armed, and switching PID profiles under a
   *     spinning aircraft is exactly the kind of thing this app does not
   *     do on the operator's behalf;
   *
   *   - an ambiguous outcome is UNCONFIRMED, never success;
   *
   *   - and the acknowledgement is NOT the proof. The board is re-read
   *     afterwards, and the result is SWITCHED only if it now reports
   *     the profile that was asked for. An ACK that did not take
   *     reports NOT_APPLIED with the board's real state, so the screen
   *     shows what is actually active rather than what was requested.
   */
  async selectProfile(
    key: SetupUiSessionKey,
    kind: PidProfileKind,
    index: number,
  ): Promise<PidProfileSwitchOutcome> {
    if (!isEncodableProfileIndex(index)) {
      // The high bit is the PID/RATE discriminator, so an index that
      // reaches into it is not representable at all.
      return {kind: 'REJECTED', reason: 'INVALID_CONFIGURATION'};
    }
    const captured = this.capture(key);
    if ('reason' in captured) return {kind: 'REJECTED', reason: captured.reason};
    const {client, scheduler, epoch, gyroSampleRateHz} = captured;
    let interlock;
    try { interlock = acquireMotorConfigurationInterlock(client); }
    catch (error) { return error instanceof MotorConfigurationTransactionInProgressError ? {kind: 'REJECTED', reason: 'CONFIGURATION_BUSY'} : {kind: 'FAILED', error}; }
    try {
      const acquisition = this.boxIdsFor(key.sessionId, client);
      const identity: BoxIdsOwnerIdentity = {physicalGeneration: key.generation, mspEpoch: epoch};
      const selector = encodeSelectSetting(kind, index);
      const result = await this.operations(key.sessionId, client, scheduler).execute<MspPidTuningSnapshot>({
        id: `pid:profile:${kind}:${key.sessionId}:${key.generation}`, sessionEffect: 'KEEP_SESSION',
        validate: context => context.clientState === 'READY' ? {allowed: true} : {allowed: false, error: new PidPreflightError('LINK_RECOVERING')},
        execute: async requester => {
          this.assertLive(key, client, epoch);
          await this.assertDisarmed(key, client, epoch, requester, acquisition, identity);
          try {
            await requester.request(MSP_SELECT_SETTING, selector, {wireFormat: 'v1'});
          } catch (error) {
            const code = errorCode(error);
            // A frame that provably never left is a plain failure; only a
            // genuinely unknown outcome is ambiguous.
            if (code !== undefined && DEFINITELY_NOT_SENT.has(code)) throw error;
            throw new AmbiguousPidProfileSelectError(error);
          }
          this.assertLive(key, client, epoch);
          // The board is the authority on what is now active.
          return this.readSnapshot(requester, gyroSampleRateHz);
        },
      });
      if (result.status === 'SUCCEEDED') {
        const active = kind === 'RATE' ? result.result.controlRateProfileIndex : result.result.pidProfileIndex;
        return active === index
          ? {kind: 'SWITCHED', snapshot: result.result}
          : {kind: 'NOT_APPLIED', snapshot: result.result};
      }
      if (result.status === 'OUTCOME_UNKNOWN') return {kind: 'UNCONFIRMED'};
      if (result.status === 'SESSION_ENDED') return {kind: 'SESSION_ENDED'};
      return result.error instanceof PidPreflightError ? {kind: 'REJECTED', reason: result.error.reason} : {kind: 'FAILED', error: result.error};
    } finally { interlock.release(); }
  }

  private capture(key: SetupUiSessionKey): {client: PidClient; scheduler: MspTelemetryScheduler; epoch: number; gyroSampleRateHz?: number} | {reason: PidBlockReason} {
    if (this.appStateOwner.getPhase() !== 'ACTIVE') return {reason: 'APP_BACKGROUNDED'};
    if (this.isMotorTestActive(key.sessionId)) return {reason: 'MOTOR_TEST_ACTIVE'};
    const identification = this.coordinator.getIdentificationState(key.sessionId);
    if (identification.status === 'IDLE' || identification.status === 'RUNNING') return {reason: 'IDENTIFYING'};
    if (!isSupportedConfigurationApi(identification)) return {reason: 'UNSUPPORTED_FIRMWARE'};
    const client = this.coordinator.getActiveMspClient(key.sessionId); const scheduler = this.coordinator.getTelemetryScheduler(key.sessionId);
    if (this.coordinator.getOwnershipState(key.sessionId) !== 'ACTIVE' || this.coordinator.getSessionKey(key.sessionId)?.generation !== key.generation || client === undefined || scheduler === undefined) return {reason: 'DISCONNECTED'};
    if (this.coordinator.getMspRecoveryState(key.sessionId) !== 'READY') return {reason: 'LINK_RECOVERING'};
    return {client, scheduler, epoch: client.getEpoch(), gyroSampleRateHz: identification.identity.board.gyroSampleRateHz};
  }
  private assertLive(key: SetupUiSessionKey, client: PidClient, epoch: number): void {
    if (this.appStateOwner.getPhase() !== 'ACTIVE') throw new PidPreflightError('APP_BACKGROUNDED');
    if (this.isMotorTestActive(key.sessionId)) throw new PidPreflightError('MOTOR_TEST_ACTIVE');
    if (this.coordinator.getOwnershipState(key.sessionId) !== 'ACTIVE' || this.coordinator.getSessionKey(key.sessionId)?.generation !== key.generation || this.coordinator.getActiveMspClient(key.sessionId) !== client || client.getEpoch() !== epoch) throw new PidPreflightError('DISCONNECTED');
    if (this.coordinator.getMspRecoveryState(key.sessionId) !== 'READY') throw new PidPreflightError('LINK_RECOVERING');
  }
  private operations(sessionId: string, client: PidClient, scheduler: MspTelemetryScheduler) { return createMspOperationCoordinator(client, scheduler, {captureCurrent: () => this.coordinator.getSessionKey(sessionId)}, {getContext: () => ({clientState: this.coordinator.getMspRecoveryState(sessionId) ?? 'DISCONNECTED', isArmed: false})}); }
  private boxIdsFor(sessionId: string, client: PidClient): BoxIdsAcquisition { const existing = this.boxIds.get(sessionId); if (existing?.client === client) return existing.acquisition; const acquisition = new BoxIdsAcquisition(client); this.boxIds.set(sessionId, {client, acquisition}); return acquisition; }
  private async assertDisarmed(key: SetupUiSessionKey, client: PidClient, epoch: number, requester: MspRequester, acquisition: BoxIdsAcquisition, identity: BoxIdsOwnerIdentity): Promise<void> {
    const mapping = await acquisition.acquire(identity, () => this.coordinator.getSessionKey(key.sessionId)?.generation === key.generation && this.coordinator.getActiveMspClient(key.sessionId) === client && client.getEpoch() === epoch);
    this.assertLive(key, client, epoch); if (mapping.kind !== 'READY') throw new PidPreflightError('ARMED_STATE_UNKNOWN');
    const frame = await requester.request(MSP_STATUS_EX, EMPTY, {wireFormat: 'v1'}); const status = decodeStatusExDiagnostics(frame.payload);
    const armed = deriveArmedState(status.flightModeFlagsLow32, status.readiness.extraFlightModeFlagBytes, mapping.permanentIds);
    if (armed === 'ARMED') throw new PidPreflightError('FC_ARMED'); if (armed !== 'DISARMED' || status.readiness.malformedTail) throw new PidPreflightError('ARMED_STATE_UNKNOWN'); this.assertLive(key, client, epoch);
  }
  private async readSnapshot(requester: MspRequester, gyroSampleRateHz?: number): Promise<MspPidTuningSnapshot> {
    const pid = await requester.request(MSP_PID, EMPTY, {wireFormat: 'v1'}); const advanced = await requester.request(MSP_PID_ADVANCED, EMPTY, {wireFormat: 'v1'}); const rates = await requester.request(MSP_RC_TUNING, EMPTY, {wireFormat: 'v1'}); const filters = await requester.request(MSP_FILTER_CONFIG, EMPTY, {wireFormat: 'v1'});
    const generalAdvanced = decodeAdvancedConfig((await requester.request(MSP_ADVANCED_CONFIG, EMPTY, {wireFormat: 'v1'})).payload);
    const statusFrame = await requester.request(MSP_STATUS_EX, EMPTY, {wireFormat: 'v1'});
    const status = decodeStatusExDiagnostics(statusFrame.payload);
    const pidProfileIndex = statusFrame.payload[10];
    const pidProfileCount = status.readiness.pidProfileCount;
    const controlRateProfileIndex = status.readiness.controlRateProfileIndex;
    if (pidProfileIndex === undefined || pidProfileCount === undefined || controlRateProfileIndex === undefined) {
      throw new Error('MSP_STATUS_EX omitted PID/rates profile identity required by API 1.47.');
    }
    return decodePidTuningSnapshot({
      pid: pid.payload,
      advanced: advanced.payload,
      rates: rates.payload,
      filters: filters.payload,
      gyroSampleRateHz,
      pidProcessDenom: generalAdvanced.pidProcessDenom,
      pidProfileIndex,
      pidProfileCount,
      rateProfileCount: status.readiness.rateProfileCount,
      controlRateProfileIndex,
    });
  }
}

export const pidTuningController = new PidTuningController();
