import {
  MSP_BUILD_INFO, MSP_EEPROM_WRITE, MSP_FEATURE_CONFIG, MSP_REBOOT, MSP_RSSI_CONFIG,
  MSP_RC_DEADBAND, MSP_RX_CONFIG, MSP_RX_MAP, MSP_SET_RSSI_CONFIG,
  MSP_SET_FEATURE_CONFIG, MSP_SET_RC_DEADBAND, MSP_SET_RX_CONFIG,
  MSP_SET_RX_MAP, MSP_STATUS_EX,
  MSP2_COMMON_SERIAL_CONFIG, MSP_TX_INFO,
  BoxIdsAcquisition, MspOperationOutcomeUnknownError,
  createMspOperationCoordinator, createReceiverConfigurationDraft,
  decodeBuildOptions, decodeFeatureConfig, decodeReceiverDeadband, decodeReceiverMap,
  decodeRssiConfig, decodeRxConfig, decodeSerialPorts, decodeStatusExDiagnostics,
  decodeTxInfo, encodeChangedReceiverConfiguration, encodeFeatureConfig,
  applyReceiverModeToFeatureMask, providerWriteIsPermitted,
  receiverModeIsSelectable, resolveProviderAvailability, selectableProviders,
  selectableReceiverModes, receiverChangeMayRequireReboot,
  receiverDraftsEqual, receiverModeBaseIsStale, receiverModeIsWritable,
  receiverProviderIsMeaningful, receiverSnapshotsEqual, resolveReceiverMode,
  resolveReceiverPortDependency, resolveReceiverTargetDependency,
  resolveRssiSource, validateReceiverDraft,
  type BoxIdsOwnerIdentity, type MspRequester, type MspSerialPortRecord,
  type MspTelemetryScheduler, type ReceiverConfigurationDraft,
  type ReceiverConfigurationSnapshot, type ReceiverMode,
  type ReceiverDependencyVerdict, type ReceiverPortDependency,
  type ReceiverRssiSource, type ReceiverWriteGroup,
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
/**
 * RECEIVER P4 adds the three DEPENDENCY_* reasons. They are preflight
 * rejections in the same sense as STALE_BASE - nothing was written - but
 * they are kept distinct from INVALID_CONFIGURATION because the draft
 * itself is perfectly valid; what is missing lives on another screen.
 * Collapsing them would tell an operator their receiver settings are
 * wrong when the actual answer is "assign a UART in Ports first".
 */
export type ReceiverBlockReason = 'DISCONNECTED' | 'IDENTIFYING' | 'UNSUPPORTED_FIRMWARE' | 'APP_BACKGROUNDED' | 'LINK_RECOVERING' | 'FC_ARMED' | 'ARMED_STATE_UNKNOWN' | 'MOTOR_TEST_ACTIVE' | 'CONFIGURATION_BUSY' | 'STALE_BASE' | 'INVALID_CONFIGURATION' | 'DEPENDENCY_MISSING' | 'DEPENDENCY_AMBIGUOUS' | 'DEPENDENCY_UNKNOWN' | 'MODE_NOT_WRITABLE'
  /** P4 CLOSURE: the connected build reported its options and the driver
   * this change needs was NOT among them. */
  | 'CAPABILITY_UNAVAILABLE'
  /** P4 CLOSURE: the build reported nothing, so nothing is known either
   * way. Deliberately NOT collapsed into UNAVAILABLE - see receiverBuildCapability. */
  | 'CAPABILITY_NOT_PROVEN';
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
  /**
   * RECEIVER P4. Proven from firmware STRUCTURE rather than from the
   * FC's flag, because for these two settings the flag is always 0.
   *
   * FIRMWARE FACT (rx.c:284-299 and :338 @ pinned 1.47): `rxInit()` is
   * the only place the feature bits become `rxRuntimeState.rxProvider`
   * and the only caller of `serialRxInit()`, and it runs at init. Yet
   * msp.c calls `configRebootUpdateCheckU8` at exactly five sites, all
   * rc_smoothing - neither MSP_SET_FEATURE_CONFIG nor the
   * serialrx_provider byte raises the flag. So a mode or provider change
   * is stored, is NOT in force, and the FC will still report
   * rebootRequired=0. Reporting that as SAVED_VERIFIED would be the
   * "looked saved but was not applied" defect in its purest form.
   */
  | 'STRUCTURAL_REQUIRED'
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
  /**
   * RECEIVER P4-M. At least one write was CONFIRMED and a later one was
   * not, before EEPROM was reached.
   *
   * Nothing is persisted - the FC's stored configuration is untouched -
   * but its RAM now holds a mixture of old and new values. That is not
   * an ordinary failure and must not be reported as one: "save failed"
   * implies nothing changed, and something did.
   *
   * No rollback is attempted. Undoing the confirmed writes would mean
   * issuing MORE writes down a link that has just proven unreliable, and
   * the firmware offers no transactional abort; inventing one would risk
   * leaving a state neither the operator nor this code can predict. No
   * automatic retry either, for the same reason.
   */
  | {
      readonly kind: 'PARTIAL_UNPERSISTED';
      readonly confirmedStages: readonly (ReceiverWriteGroup | 'EEPROM')[];
      readonly failedStage: ReceiverWriteGroup | 'EEPROM';
      readonly definitelyNotSent: boolean;
    }
  | {readonly kind: 'SESSION_ENDED'} | {readonly kind: 'FAILED'; readonly error: unknown};

/**
 * RECEIVER P4 - the receiver MODE the operator is proposing, carried
 * beside the configuration draft rather than inside it.
 *
 * The mode lives in the GLOBAL feature mask, not in any Receiver
 * payload, so folding it into ReceiverConfigurationDraft would drag the
 * whole mask into the snapshot equality that guards STALE_BASE - and an
 * unrelated screen toggling GPS would then refuse a Receiver save. This
 * keeps P2's reviewed stale-base semantics exactly as they are and gives
 * the mode its own, narrower staleness rule (Receiver-owned bits only).
 *
 * `baseFeatureMaskRaw` is the mask the UI's mode selection was made
 * against. It is never used as write authority - see save() - only as
 * the thing a fresh read is compared to.
 */
export interface ReceiverModeTarget {
  readonly mode: ReceiverMode;
  readonly baseFeatureMaskRaw: number;
}
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
  /**
   * RECEIVER P4. The same read-only Ports cross-check asked about a
   * PROPOSED serial receiver rather than the active one.
   *
   * Needed separately because portDependency answers for whatever mode
   * the FC is running now, and that is NOT_APPLICABLE whenever the
   * active mode is not SERIAL - useless for deciding whether the
   * operator may switch TO serial. Computed in the controller so the
   * screen never has to see a port record, let alone write one.
   */
  readonly serialTargetDependency: ReceiverDependencyVerdict;
  /* --------------------------------------------------------------- *
   * P4 CLOSURE - what the CONNECTED build proves it can actually run.
   *
   * Resolved here, in the controller, so the screen never has to hold a
   * set of firmware option ids or know what one means. Every list below
   * is derived from a MSP_BUILD_INFO read taken in this same session.
   * -------------------------------------------------------------- */
  /** True when the board actually reported an option list at all. */
  readonly buildOptionsKnown: boolean;
  /** Modes this build proves it can run, already filtered by the
   * dependency-completeness matrix. May be empty. */
  readonly selectableModes: readonly ReceiverMode[];
  /** Serial providers this build proves it compiled in. May be empty. */
  readonly selectableProviders: readonly number[];
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
interface AmbiguousReceiverCause {
  readonly kind: 'RECEIVER_AMBIGUOUS_WRITE';
  readonly stage: ReceiverWriteGroup | 'EEPROM';
  /** P4-M: at least one earlier write in this transaction was CONFIRMED. */
  readonly partial: boolean;
  readonly confirmedStages: readonly (ReceiverWriteGroup | 'EEPROM')[];
  /** P4-N: the failing frame provably never reached the wire. Kept
   * distinct from an ambiguous frame even here - what is unknown in a
   * partial transaction is the SHAPE of the FC's RAM, not whether this
   * particular frame was sent. */
  readonly definitelyNotSent: boolean;
}
class AmbiguousReceiverWriteError extends MspOperationOutcomeUnknownError {
  constructor(error: unknown, stage: ReceiverWriteGroup | 'EEPROM', confirmedStages: readonly (ReceiverWriteGroup | 'EEPROM')[] = [], definitelyNotSent = false) {
    super(Object.freeze({
      kind: 'RECEIVER_AMBIGUOUS_WRITE', stage, error,
      partial: confirmedStages.length > 0,
      confirmedStages: Object.freeze([...confirmedStages]),
      definitelyNotSent,
    }));
  }
}
function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error ? String((error as {code: unknown}).code) : undefined;
}
function ambiguousCause(value: unknown): value is AmbiguousReceiverCause {
  return value !== null && typeof value === 'object' && 'kind' in value && value.kind === 'RECEIVER_AMBIGUOUS_WRITE';
}
const COMMAND_FOR_GROUP: Readonly<Record<ReceiverWriteGroup, number>> = Object.freeze({RX_MAP: MSP_SET_RX_MAP, RSSI: MSP_SET_RSSI_CONFIG, DEADBAND: MSP_SET_RC_DEADBAND, RX_CONFIG: MSP_SET_RX_CONFIG, FEATURE: MSP_SET_FEATURE_CONFIG});

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

  /**
   * RECEIVER P4 - ONE configuration transaction, whether the operator
   * changed the channel map, the serial provider, the receiver mode, or
   * all three. There is deliberately no second save entry point: two
   * save authorities racing for the same interlock is how a half-applied
   * receiver happens.
   */
  async save(sessionKey: SetupUiSessionKey, original: ReceiverConfigurationSnapshot, draft: ReceiverConfigurationDraft, modeTarget?: ReceiverModeTarget): Promise<ReceiverSaveOutcome> {
    const baseDraft = createReceiverConfigurationDraft(original);
    if (receiverDraftsEqual(baseDraft, draft) && modeTarget === undefined) return {kind: 'NO_CHANGES', snapshot: original};
    if (validateReceiverDraft(draft).length > 0) return {kind: 'REJECTED', reason: 'INVALID_CONFIGURATION'};
    // The capability matrix is enforced HERE, not only in the UI: a
    // caller that hand-built a target must not be able to route around
    // it and write a mode we cannot fully configure.
    if (modeTarget !== undefined && !receiverModeIsWritable(modeTarget.mode)) return {kind: 'REJECTED', reason: 'MODE_NOT_WRITABLE'};
    const captured = this.capture(sessionKey);
    if ('reason' in captured) return {kind: 'REJECTED', reason: captured.reason};
    const {client, scheduler, epoch} = captured;
    let interlock;
    try { interlock = acquireMotorConfigurationInterlock(client); }
    catch (error) { return error instanceof MotorConfigurationTransactionInProgressError ? {kind: 'REJECTED', reason: 'CONFIGURATION_BUSY'} : {kind: 'FAILED', error}; }
    try {
      const acquisition = this.boxIdsFor(sessionKey.sessionId, client);
      const identity: BoxIdsOwnerIdentity = {physicalGeneration: sessionKey.generation, mspEpoch: epoch};
      const rebootExpected = receiverChangeMayRequireReboot(baseDraft, draft);
      const providerChanged = baseDraft.serialRxProvider !== draft.serialRxProvider;
      const result = await this.operations(sessionKey.sessionId, client, scheduler).execute<{
        snapshot?: ReceiverConfigurationSnapshot;
        readbackError?: unknown;
        rebootRequired?: boolean;
        modeWritten?: boolean;
      }>({
        id: `receiver:save:${sessionKey.sessionId}:${sessionKey.generation}`,
        sessionEffect: 'KEEP_SESSION',
        validate: context => context.clientState === 'READY' ? {allowed: true} : {allowed: false, error: new ReceiverPreflightError('LINK_RECOVERING')},
        execute: async requester => {
          this.assertLive(sessionKey, client, epoch);
          const fresh = await this.readSnapshot(requester);
          if (!receiverSnapshotsEqual(fresh, original)) throw new ReceiverPreflightError('STALE_BASE');

          /* P4-C. The mask that is about to be written is derived from a
             read taken RIGHT HERE, inside the transaction, never from
             what the page loaded. Between page load and Save another
             screen may legitimately have enabled GPS or telemetry;
             mutating a stale mask would silently switch those back off,
             because MSP_SET_FEATURE_CONFIG replaces the whole word. */
          let freshMask: number | undefined;
          let desiredMask: number | undefined;
          if (modeTarget !== undefined || providerChanged) {
            const frame = await requester.request(MSP_FEATURE_CONFIG, EMPTY, {wireFormat: 'v1'});
            freshMask = decodeFeatureConfig(frame.payload).enabledFeaturesRaw;

            /* P4 CLOSURE. Build capability is re-read HERE, inside the
               transaction, exactly like the feature mask - so a
               capability answer obtained from an earlier session, or
               from a board that has since been replaced or reflashed,
               can never authorise this write. */
            let liveOptions: ReadonlySet<number> | undefined;
            try {
              const buildFrame = await requester.request(MSP_BUILD_INFO, EMPTY, {wireFormat: 'v1'});
              const decoded = decodeBuildOptions(buildFrame.payload).optionIds;
              liveOptions = decoded.size > 0 ? decoded : undefined;
            } catch { liveOptions = undefined; }

            if (providerChanged) {
              const availability = resolveProviderAvailability(draft.serialRxProvider, liveOptions);
              if (availability === 'UNAVAILABLE') throw new ReceiverPreflightError('CAPABILITY_UNAVAILABLE');
              if (availability !== 'AVAILABLE') throw new ReceiverPreflightError('CAPABILITY_NOT_PROVEN');
            }
            if (modeTarget !== undefined && !receiverModeIsSelectable(modeTarget.mode, liveOptions)) {
              throw new ReceiverPreflightError(liveOptions === undefined ? 'CAPABILITY_NOT_PROVEN' : 'CAPABILITY_UNAVAILABLE');
            }
            // A SERIAL target must also land on a provider this build has.
            if (modeTarget?.mode === 'SERIAL' && !providerWriteIsPermitted(draft.serialRxProvider, liveOptions)) {
              throw new ReceiverPreflightError(liveOptions === undefined ? 'CAPABILITY_NOT_PROVEN' : 'CAPABILITY_UNAVAILABLE');
            }
          }
          if (modeTarget !== undefined && freshMask !== undefined) {
            /* Staleness on the RECEIVER-OWNED BITS ONLY. An unrelated
               feature changing is not a Receiver conflict; the Receiver
               mode changing underneath the operator is. */
            if (receiverModeBaseIsStale(modeTarget.baseFeatureMaskRaw, freshMask)) throw new ReceiverPreflightError('STALE_BASE');
            desiredMask = applyReceiverModeToFeatureMask(freshMask, modeTarget.mode);
          }

          /* P4-E/F. The dependency is checked against the mode the FC
             will actually run after this save, using FRESH Ports state -
             Ports may have changed since the page loaded. Read-only:
             this returns a verdict and writes nothing. */
          const effectiveMode = modeTarget?.mode ?? (freshMask === undefined ? undefined : resolveReceiverMode(freshMask));
          if (effectiveMode === 'SERIAL') {
            let ports: readonly MspSerialPortRecord[] | undefined;
            try {
              const portsFrame = await requester.request(MSP2_COMMON_SERIAL_CONFIG, EMPTY, {wireFormat: 'v2'});
              ports = decodeSerialPorts(portsFrame.payload);
            } catch { ports = undefined; }
            const verdict = resolveReceiverTargetDependency('SERIAL', ports);
            if (verdict.kind !== 'SATISFIED') throw new ReceiverPreflightError(verdict.kind);
          }

          await this.assertDisarmed(sessionKey, client, epoch, requester, acquisition, identity);

          /* WRITE ORDER, chosen from firmware behaviour rather than
             convenience. RX_CONFIG (which carries serialrx_provider)
             goes BEFORE the feature mask.

             Nothing is in force until a restart and nothing is persisted
             until EEPROM, so the ordering matters only for what the FC's
             RAM holds if the second write fails. Provider-then-mode
             leaves "new provider, old mode" - and rx.c:338 shows the
             provider is only consulted by serialRxInit inside the SERIAL
             branch, so that combination is either inert or exactly what
             the operator asked for. Mode-then-provider would leave "new
             mode, old provider" - a pairing the operator never selected,
             and the one that boots into a new serial receiver with the
             wrong protocol. */
          const confirmed: (ReceiverWriteGroup | 'EEPROM')[] = [];
          for (const write of encodeChangedReceiverConfiguration(original, draft)) {
            await this.writeOnce(requester, COMMAND_FOR_GROUP[write.group], write.payload, write.group, confirmed);
          }
          const modeWritten = desiredMask !== undefined && desiredMask !== freshMask;
          if (modeWritten && desiredMask !== undefined) {
            await this.writeOnce(requester, MSP_SET_FEATURE_CONFIG, encodeFeatureConfig(desiredMask), 'FEATURE', confirmed);
          }
          await this.writeOnce(requester, MSP_EEPROM_WRITE, EMPTY, 'EEPROM', confirmed);
          try {
            const snapshot = await this.readSnapshot(requester);
            if (!receiverDraftsEqual(createReceiverConfigurationDraft(snapshot), draft)) throw new Error('Receiver readback does not match saved configuration.');
            /* P4-B read-back: the WHOLE mask, not just the mode. Equality
               with desiredMask proves both that the intended bit is set
               and that every unrelated bit survived the replace. */
            if (desiredMask !== undefined) {
              const verifyFrame = await requester.request(MSP_FEATURE_CONFIG, EMPTY, {wireFormat: 'v1'});
              const verifiedMask = decodeFeatureConfig(verifyFrame.payload).enabledFeaturesRaw;
              if (verifiedMask !== desiredMask) throw new Error('Receiver feature-mask readback does not match the written mask.');
            }
            // P2: read-back equality only proves the values are STORED.
            // Ask the flight controller whether they are in force. This
            // runs inside the same transaction, while the link is still
            // proven live, so the answer belongs to this save.
            return {snapshot, rebootRequired: await this.readRebootRequired(requester), modeWritten};
          } catch (error) { return {readbackError: error, modeWritten}; }
        },
      });
      if (result.status === 'SUCCEEDED') {
        const {snapshot, readbackError, rebootRequired, modeWritten} = result.result;
        if (snapshot === undefined) return {kind: 'SAVED_UNVERIFIED', error: readbackError};
        // Authoritative FC truth first; the changed-field expectation is
        // only the fallback for when the flag could not be re-read.
        if (rebootRequired === true) return {kind: 'SAVED_REBOOT_REQUIRED', snapshot, evidence: 'FC_REPORTED'};
        /* P4-P. The FC does not raise its flag for either of these, so
           the absence of the flag proves nothing about them. Structure
           does: rxInit is the only site that applies both. */
        if (modeWritten === true || providerChanged) return {kind: 'SAVED_REBOOT_REQUIRED', snapshot, evidence: 'STRUCTURAL_REQUIRED'};
        if (rebootRequired === undefined && rebootExpected) return {kind: 'SAVED_REBOOT_REQUIRED', snapshot, evidence: 'EXPECTED_UNCONFIRMED'};
        return {kind: 'SAVED_VERIFIED', snapshot};
      }
      if (result.status === 'OUTCOME_UNKNOWN') {
        if (!ambiguousCause(result.reason)) return {kind: 'SESSION_ENDED'};
        // P4-M: "some of it landed" is its own answer, never a failure.
        if (result.reason.partial) {
          return {
            kind: 'PARTIAL_UNPERSISTED',
            confirmedStages: result.reason.confirmedStages,
            failedStage: result.reason.stage,
            definitelyNotSent: result.reason.definitelyNotSent,
          };
        }
        return {kind: 'UNCONFIRMED', stage: result.reason.stage};
      }
      if (result.status === 'SESSION_ENDED') return {kind: 'SESSION_ENDED'};
      return result.error instanceof ReceiverPreflightError ? {kind: 'REJECTED', reason: result.error.reason} : {kind: 'FAILED', error: result.error};
    } finally { interlock.release(); }
  }

  /**
   * P4-N attribution, unchanged for the first write of a transaction: a
   * frame that provably never reached the wire is rethrown so the
   * outcome is FAILED (nothing happened), and anything else becomes an
   * ambiguous write (state unknown).
   *
   * P4-M adds the second dimension. Once ANY write in this transaction
   * has been confirmed, a later failure of either kind leaves the flight
   * controller's RAM holding a mixture - so it is reported as partial
   * regardless, with the attribution of the failing frame preserved in
   * `definitelyNotSent` rather than flattened away.
   */
  private async writeOnce(requester: MspRequester, command: number, payload: Uint8Array, stage: ReceiverWriteGroup | 'EEPROM', confirmed?: (ReceiverWriteGroup | 'EEPROM')[]): Promise<void> {
    try { await requester.request(command, payload, {wireFormat: 'v1'}); }
    catch (error) {
      const code = errorCode(error);
      const notSent = code !== undefined && DEFINITELY_NOT_SENT.has(code);
      /* PARTIAL applies to RAM writes only. A failure at the EEPROM step
         is NOT a partial configuration: every RAM write before it was
         confirmed, so the flight controller holds the complete intended
         state and only PERSISTENCE is unknown - which is precisely what
         P2's UNCONFIRMED at stage EEPROM already says. Widening partial
         to cover it would replace a precise answer with a vaguer one. */
      if (stage !== 'EEPROM' && confirmed !== undefined && confirmed.length > 0) throw new AmbiguousReceiverWriteError(error, stage, confirmed, notSent);
      if (notSent) throw error;
      throw new AmbiguousReceiverWriteError(error, stage);
    }
    confirmed?.push(stage);
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
          /* P2 read Ports only when the ACTIVE mode was SERIAL, because
             that was the only question being asked. P4 makes SERIAL a
             mode the operator can switch TO from anywhere, so the answer
             is needed on every load - a UI that only discovers the
             missing UART after the operator presses Save has already
             wasted their time. One extra request per page load, on a
             screen that is not cadence-critical. */
          let ports: readonly MspSerialPortRecord[] | undefined;
          try {
            const portsFrame = await requester.request(MSP2_COMMON_SERIAL_CONFIG, EMPTY, {wireFormat: 'v2'});
            ports = decodeSerialPorts(portsFrame.payload);
          } catch {
            // Leave undefined -> PORT_STATE_UNKNOWN. An unreadable port
            // table must never be reported as "no UART assigned".
            ports = undefined;
          }
          /* P4 CLOSURE. The authoritative per-driver evidence: the u16
             option list MSP_BUILD_INFO appends (API >= 1.46), compiled
             into this exact firmware from the same #ifdefs that guard
             the drivers themselves. Optional by design - a board that
             does not answer, or answers without a list, yields
             buildOptionsKnown=false and NOT_PROVEN everywhere, never a
             fabricated "supported". */
          let buildOptionIds: ReadonlySet<number> | undefined;
          try {
            const buildFrame = await requester.request(MSP_BUILD_INFO, EMPTY, {wireFormat: 'v1'});
            const decoded = decodeBuildOptions(buildFrame.payload).optionIds;
            buildOptionIds = decoded.size > 0 ? decoded : undefined;
          } catch {
            buildOptionIds = undefined;
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
            serialTargetDependency: resolveReceiverTargetDependency('SERIAL', ports),
            buildOptionsKnown: buildOptionIds !== undefined,
            selectableModes: selectableReceiverModes(buildOptionIds),
            selectableProviders: selectableProviders(buildOptionIds),
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
