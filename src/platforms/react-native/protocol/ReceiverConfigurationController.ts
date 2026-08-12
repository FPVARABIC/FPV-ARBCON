import {
  MSP_EEPROM_WRITE, MSP_FEATURE_CONFIG, MSP_REBOOT, MSP_RSSI_CONFIG,
  MSP_RC_DEADBAND, MSP_RX_CONFIG, MSP_RX_MAP, MSP_SET_RSSI_CONFIG,
  MSP_SET_RC_DEADBAND, MSP_SET_RX_CONFIG, MSP_SET_RX_MAP, MSP_STATUS_EX,
  MSP2_COMMON_SERIAL_CONFIG, MSP_TX_INFO,
  BoxIdsAcquisition, MspOperationOutcomeUnknownError,
  createMspOperationCoordinator, createReceiverConfigurationDraft,
  decodeFeatureConfig, decodeReceiverDeadband, decodeReceiverMap,
  decodeRssiConfig, decodeRxConfig, decodeSerialPorts, decodeStatusExDiagnostics,
  decodeTxInfo, encodeChangedReceiverConfiguration,
  receiverChangeMayRequireReboot, receiverDraftsEqual, receiverProviderIsMeaningful,
  receiverSnapshotsEqual, resolveReceiverMode, resolveReceiverPortDependency,
  resolveRssiSource, validateReceiverDraft,
  type BoxIdsOwnerIdentity, type MspRequester, type MspSerialPortRecord,
  type MspTelemetryScheduler, type ReceiverConfigurationDraft,
  type ReceiverConfigurationSnapshot, type ReceiverMode,
  type ReceiverPortDependency, type ReceiverRssiSource, type ReceiverWriteGroup,
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
/**
 * RECEIVER P2. Why the reboot requirement is its own outcome and not a
 * flag on SAVED_VERIFIED: read-back equality proves the flight
 * controller STORED the values, and nothing more. Five of the fields
 * this screen writes (all rc_smoothing - see
 * RECEIVER_REBOOT_SENSITIVE_FIELDS) make the firmware set its own
 * reboot-required bit, meaning the stored value is NOT the value in
 * force. Reporting that as a verified success is precisely the "looked
 * saved but was not applied" failure this phase exists to remove, so the
 * type makes it impossible to express.
 */
export type ReceiverRebootEvidence =
  /** The flight controller's own MSP_STATUS_EX config-state bit said so. */
  | 'FC_REPORTED'
  /** A reboot-sensitive field changed but the flag could not be re-read.
   * Reported conservatively: telling an operator to reboot unnecessarily
   * is safe, telling them a change is live when it is not, is not. */
  | 'EXPECTED_UNCONFIRMED';

export type ReceiverSaveOutcome =
  | {readonly kind: 'NO_CHANGES'; readonly snapshot: ReceiverConfigurationSnapshot}
  | {readonly kind: 'SAVED_VERIFIED'; readonly snapshot: ReceiverConfigurationSnapshot}
  | {
      readonly kind: 'SAVED_REBOOT_REQUIRED';
      readonly snapshot: ReceiverConfigurationSnapshot;
      readonly evidence: ReceiverRebootEvidence;
    }
  | {readonly kind: 'SAVED_UNVERIFIED'; readonly error: unknown}
  | {readonly kind: 'REJECTED'; readonly reason: ReceiverBlockReason}
  | {readonly kind: 'UNCONFIRMED'; readonly stage: ReceiverWriteGroup | 'EEPROM'}
  | {readonly kind: 'SESSION_ENDED'} | {readonly kind: 'FAILED'; readonly error: unknown};
/**
 * RECEIVER P2 - READ-ONLY firmware truth about the receiver the flight
 * controller is actually running.
 *
 * Deliberately NOT merged into ReceiverConfigurationSnapshot. That
 * snapshot is the editable configuration and is the base for the
 * STALE_BASE comparison; folding the global feature mask into it would
 * make an unrelated screen toggling any feature bit (GPS, telemetry,
 * ...) refuse a Receiver save. Keeping runtime truth separate preserves
 * the P1-reviewed stale-base semantics exactly.
 */
export interface ReceiverRuntimeTruth {
  /** Resolved from the feature mask by firmware precedence - never from
   * the serialrx_provider enum. */
  readonly mode: ReceiverMode;
  readonly featureMaskRaw: number;
  /** Whether the stored serial provider describes the ACTIVE receiver. */
  readonly providerMeaningful: boolean;
  readonly portDependency: ReceiverPortDependency;
  readonly rssiSource: ReceiverRssiSource;
}

export type ReceiverRuntimeOutcome =
  | {readonly kind: 'READ'; readonly runtime: ReceiverRuntimeTruth}
  | {readonly kind: 'REJECTED'; readonly reason: ReceiverBlockReason}
  | {readonly kind: 'SESSION_ENDED'}
  | {readonly kind: 'FAILED'; readonly error: unknown};

/**
 * RECEIVER P2. A reboot intentionally ENDS the session, so success here
 * means only "the flight controller accepted the reboot request" - never
 * that it came back. Reconnection is a separate, observable event and is
 * never inferred from an acknowledgement.
 */
export type ReceiverRebootOutcome =
  | {readonly kind: 'REBOOT_REQUESTED'}
  | {readonly kind: 'REJECTED'; readonly reason: ReceiverBlockReason}
  | {readonly kind: 'SESSION_ENDED'}
  | {readonly kind: 'FAILED'; readonly error: unknown};

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
      const rebootExpected = receiverChangeMayRequireReboot(
        createReceiverConfigurationDraft(original),
        draft,
      );
      const result = await this.operations(sessionKey.sessionId, client, scheduler).execute<{
        snapshot?: ReceiverConfigurationSnapshot;
        readbackError?: unknown;
        rebootRequired?: boolean;
      }>({
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
            // P2: read-back equality only proves the values are STORED.
            // Ask the flight controller whether they are in force. This
            // runs inside the same transaction, while the link is still
            // proven live, so the answer belongs to this save.
            return {snapshot, rebootRequired: await this.readRebootRequired(requester)};
          } catch (error) { return {readbackError: error}; }
        },
      });
      if (result.status === 'SUCCEEDED') {
        const {snapshot, readbackError, rebootRequired} = result.result;
        if (snapshot === undefined) return {kind: 'SAVED_UNVERIFIED', error: readbackError};
        // Authoritative FC truth first; the changed-field expectation is
        // only the fallback for when the flag could not be re-read.
        if (rebootRequired === true) return {kind: 'SAVED_REBOOT_REQUIRED', snapshot, evidence: 'FC_REPORTED'};
        if (rebootRequired === undefined && rebootExpected) return {kind: 'SAVED_REBOOT_REQUIRED', snapshot, evidence: 'EXPECTED_UNCONFIRMED'};
        return {kind: 'SAVED_VERIFIED', snapshot};
      }
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

  /**
   * P2-B: authoritative reboot-required truth, from the flight
   * controller's own MSP_STATUS_EX config-state byte (bit 0 =
   * getRebootRequired(), msp.c:1130-1132 @ pinned 1.47), through the
   * SHARED canonical decoder - Receiver adds no second status decode.
   *
   * Returns undefined rather than throwing when the flag cannot be
   * obtained: an unreadable flag must not turn a successful save into a
   * failure, it must fall back to the conservative expectation.
   */
  private async readRebootRequired(requester: MspRequester): Promise<boolean | undefined> {
    try {
      const frame = await requester.request(MSP_STATUS_EX, EMPTY, {wireFormat: 'v1'});
      return decodeStatusExDiagnostics(frame.payload).readiness.rebootRequired;
    } catch {
      return undefined;
    }
  }

  /**
   * P2-E/I/N: reads the receiver truth the operator cannot otherwise
   * see - which receiver the FC is actually running, whether the serial
   * port configuration agrees with it, and where RSSI comes from.
   *
   * Strictly read-only: no MSP_SET_*, no EEPROM, no reboot, and in
   * particular no write to Ports. Runs under the same interlock and
   * session guards as load() so it cannot interleave with a save.
   */
  async readRuntime(sessionKey: SetupUiSessionKey): Promise<ReceiverRuntimeOutcome> {
    const captured = this.capture(sessionKey);
    if ('reason' in captured) return {kind: 'REJECTED', reason: captured.reason};
    const {client, scheduler, epoch} = captured;
    let interlock;
    try { interlock = acquireMotorConfigurationInterlock(client); }
    catch (error) { return error instanceof MotorConfigurationTransactionInProgressError ? {kind: 'REJECTED', reason: 'CONFIGURATION_BUSY'} : {kind: 'FAILED', error}; }
    try {
      const result = await this.operations(sessionKey.sessionId, client, scheduler).execute<ReceiverRuntimeTruth>({
        id: `receiver:runtime:${sessionKey.sessionId}:${sessionKey.generation}`,
        sessionEffect: 'KEEP_SESSION',
        validate: context => context.clientState === 'READY' ? {allowed: true} : {allowed: false, error: new ReceiverPreflightError('LINK_RECOVERING')},
        execute: async requester => {
          this.assertLive(sessionKey, client, epoch);
          const featureFrame = await requester.request(MSP_FEATURE_CONFIG, EMPTY, {wireFormat: 'v1'});
          const featureMaskRaw = decodeFeatureConfig(featureFrame.payload).enabledFeaturesRaw;
          const mode = resolveReceiverMode(featureMaskRaw);
          // Ports are only consulted when the active mode actually
          // depends on a UART - reading them otherwise would spend link
          // time to answer a question that is NOT_APPLICABLE anyway.
          let ports: readonly MspSerialPortRecord[] | undefined;
          if (mode === 'SERIAL') {
            try {
              const portsFrame = await requester.request(MSP2_COMMON_SERIAL_CONFIG, EMPTY, {wireFormat: 'v2'});
              ports = decodeSerialPorts(portsFrame.payload);
            } catch {
              // Leave undefined -> PORT_STATE_UNKNOWN. An unreadable port
              // table must never be reported as "no UART assigned".
              ports = undefined;
            }
          }
          let rssiSourceValue: number | undefined;
          try {
            const txFrame = await requester.request(MSP_TX_INFO, EMPTY, {wireFormat: 'v1'});
            rssiSourceValue = decodeTxInfo(txFrame.payload).rssiSource;
          } catch {
            // Optional by design: a board that does not answer
            // MSP_TX_INFO reports UNAVAILABLE, never a fabricated source.
            rssiSourceValue = undefined;
          }
          return Object.freeze({
            mode,
            featureMaskRaw,
            providerMeaningful: receiverProviderIsMeaningful(mode),
            portDependency: resolveReceiverPortDependency(mode, ports),
            rssiSource: resolveRssiSource(rssiSourceValue),
          });
        },
      });
      if (result.status === 'SUCCEEDED') return {kind: 'READ', runtime: result.result};
      if (result.status === 'SESSION_ENDED' || result.status === 'OUTCOME_UNKNOWN') return {kind: 'SESSION_ENDED'};
      return result.error instanceof ReceiverPreflightError ? {kind: 'REJECTED', reason: result.error.reason} : {kind: 'FAILED', error: result.error};
    } finally { interlock.release(); }
  }

  /**
   * P2-C/D: the canonical reboot, reusing the same MSP_REBOOT +
   * EXPECT_REBOOT operation architecture GpsConfigurationController
   * already uses. No second reboot implementation, and no raw MSP_REBOOT
   * anywhere near the UI.
   *
   * DISARMED is proven first. FIRMWARE FACT (msp.c:409 @ pinned 1.47):
   * the reboot dispatch is guarded by ARMING_FLAG(ARMED), so an armed
   * board would refuse anyway - but a client that asks a flying aircraft
   * to reboot and then reports the refusal is not a safe client.
   *
   * SUCCESS MEANS "REQUEST ACCEPTED", NOT "FLIGHT CONTROLLER IS BACK".
   * sessionEffect EXPECT_REBOOT tells the operation coordinator this
   * transaction intentionally ends the session, so no post-success
   * telemetry refresh is scheduled against a link that is going away.
   */
  async requestReboot(sessionKey: SetupUiSessionKey): Promise<ReceiverRebootOutcome> {
    const captured = this.capture(sessionKey);
    if ('reason' in captured) return {kind: 'REJECTED', reason: captured.reason};
    const {client, scheduler, epoch} = captured;
    let interlock;
    try { interlock = acquireMotorConfigurationInterlock(client); }
    catch (error) { return error instanceof MotorConfigurationTransactionInProgressError ? {kind: 'REJECTED', reason: 'CONFIGURATION_BUSY'} : {kind: 'FAILED', error}; }
    try {
      const acquisition = this.boxIdsFor(sessionKey.sessionId, client);
      const identity: BoxIdsOwnerIdentity = {physicalGeneration: sessionKey.generation, mspEpoch: epoch};
      const result = await this.operations(sessionKey.sessionId, client, scheduler).execute<true>({
        id: `receiver:reboot:${sessionKey.sessionId}:${sessionKey.generation}`,
        sessionEffect: 'EXPECT_REBOOT',
        validate: context => context.clientState === 'READY' ? {allowed: true} : {allowed: false, error: new ReceiverPreflightError('LINK_RECOVERING')},
        execute: async requester => {
          this.assertLive(sessionKey, client, epoch);
          await this.assertDisarmed(sessionKey, client, epoch, requester, acquisition, identity);
          try {
            await requester.request(MSP_REBOOT, EMPTY, {wireFormat: 'v1'});
          } catch (error) {
            // A link that VANISHES mid-request is the reboot we asked
            // for - the board stops answering precisely because it is
            // rebooting - so a timeout or a dead transport is success.
            //
            // BUT NOT EVERY FAILURE IS THAT. The codes in
            // DEFINITELY_NOT_SENT are the ones whose meaning is "this
            // frame provably never reached the wire" (encode failure, a
            // full client or transport queue, a link already in
            // recovery, a remote error). Swallowing those would report
            // an ACCEPTED REBOOT for a reboot that was never submitted -
            // a false success, and the exact attribution defect this
            // closure pass exists to remove. They are rethrown, so the
            // outcome is FAILED and the operator is told to try again.
            const code = errorCode(error);
            if (code !== undefined && DEFINITELY_NOT_SENT.has(code)) {
              throw error;
            }
          }
          return true;
        },
      });
      if (result.status === 'SUCCEEDED') return {kind: 'REBOOT_REQUESTED'};
      if (result.status === 'SESSION_ENDED' || result.status === 'OUTCOME_UNKNOWN') return {kind: 'SESSION_ENDED'};
      return result.error instanceof ReceiverPreflightError ? {kind: 'REJECTED', reason: result.error.reason} : {kind: 'FAILED', error: result.error};
    } finally { interlock.release(); }
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
