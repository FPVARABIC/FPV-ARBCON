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
import {MSP2_GET_TEXT, MSP2_SET_TEXT, MSP_SELECT_SETTING} from '../../../core/protocol/msp/commands/mspCommands';
import {decodeMspText} from '../../../core/protocol/msp/decoding/decodeMspText';
import {
  MSP_CALCULATE_SIMPLIFIED_PID,
  MSP_COPY_PROFILE,
  MSP_SET_RESET_CURR_PID,
  MSP_SET_SIMPLIFIED_TUNING,
  MSP_SIMPLIFIED_TUNING,
  MSP_VALIDATE_SIMPLIFIED_TUNING,
} from '../../../core/protocol/msp/commands/pidProfileCommands';
import {encodeSelectSetting, isEncodableProfileIndex} from '../../../core/protocol/msp/encoding/encodeSelectSetting';
import {
  encodeCopyProfile,
  encodeGetProfileName,
  encodePidProfileReset,
  encodeSetProfileName,
  pidProfileResetRequest,
  projectCopyProfile,
  MSP2TEXT_PID_PROFILE_NAME,
  MSP2TEXT_RATE_PROFILE_NAME,
  type CopyProfileRequest,
} from '../../../core/protocol/msp/encoding/encodeProfileCommands';
import {encodeSimplifiedTuning, type SimplifiedTuningPatch} from '../../../core/protocol/msp/encoding/encodeSimplifiedTuning';
import {
  pidWriteAuthority,
  resolvePidApi,
  type PidApiContract,
} from '../../../core/protocol/msp/decoding/pidWireContracts';
import {decodePidAdvancedFull} from '../../../core/protocol/msp/decoding/decodePidAdvancedFull';
import {
  RC_TUNING_OFFSETS,
  RC_TUNING_RETIRED_OFFSETS,
} from '../../../core/protocol/msp/decoding/decodeRcTuningFull';
import {MSP_RC_TUNING_BYTES} from '../../../core/protocol/msp/decoding/pidWireContracts';
import {
  encodeRcTuningRatesType,
  isEncodableRatesType,
} from '../../../core/protocol/msp/encoding/encodeRatesType';
import {decodeFilterConfigFull} from '../../../core/protocol/msp/decoding/decodeFilterConfigFull';
import {decodeRcTuningFull} from '../../../core/protocol/msp/decoding/decodeRcTuningFull';
import {
  SIMPLIFIED_PID_BLOCK_BYTES,
  decodeCalculatedPidfs,
  decodeSimplifiedTuning,
  decodeSimplifiedTuningValidity,
  type CalculatedPidfAxis,
  type MspSimplifiedTuning,
  type SimplifiedTuningValidity,
} from '../../../core/protocol/msp/decoding/decodeSimplifiedTuning';
import {
  classifyAdvancedReadback,
  classifyFilterReadback,
  classifyPidReadback,
  classifyRcTuningReadback,
  classifySimplifiedReadback,
  detectSimplifiedConflict,
  classifyGyroValidationSideEffects,
  ownedAdvancedFields,
  ownedFilterFields,
  projectGyroValidation,
  projectSimplifiedWrite,
  type AdvancedConfigWitness,
  type CrossSubsystemReport,
  type SimplifiedConflict,
} from '../../../core/state/pidWriteVerification';
import {MSP_MOTOR_CONFIG} from '../../../core/protocol/msp/commands/mspCommands';
import {decodeMotorConfig} from '../../../core/protocol/msp/decoding/decodeMotorConfig';
import type {FieldComparison, GroupVerdict} from '../../../core/state/pidNormalizationModel';
import {
  pidProfileIdentity,
  rateProfileIdentity,
  profileIdentitiesEqual,
  type PidProfileIdentity,
  type RateProfileIdentity,
} from '../../../core/state/pidTuningScope';
import {deriveArmedState} from '../../../core/state/armingBlockers';
import type {MspClientState} from '../../../core/protocol/mspClient';
import {isMotorTestSessionActive} from './motorTestCapability';
import {mspSessionCoordinator, type MspIdentificationState, type MspSessionOwnershipState, type SetupUiSessionKey} from './MspSessionCoordinator';
import {setupAppStateTelemetryOwner, type SetupAppStatePhase} from './setupAppStateTelemetryOwner';
import {acquireMotorConfigurationInterlock, MotorConfigurationTransactionInProgressError} from './motorConfigurationInterlock';
import {MutationLedger, MutationStoppedError, type PartialApplyEvidence} from './configurationSaveLedger';
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
export type PidBlockReason =
  | 'DISCONNECTED' | 'IDENTIFYING' | 'UNSUPPORTED_FIRMWARE' | 'APP_BACKGROUNDED' | 'LINK_RECOVERING'
  | 'FC_ARMED' | 'ARMED_STATE_UNKNOWN' | 'MOTOR_TEST_ACTIVE' | 'CONFIGURATION_BUSY' | 'STALE_BASE'
  | 'INVALID_CONFIGURATION'
  /** The board speaks a layout newer than any this build has read from
   *  firmware source. Reads may still be attempted; writes never are. */
  | 'UNVERIFIED_FUTURE_API'
  /** The active profile moved between the draft being taken and the write.
   *  Distinct from STALE_BASE: the VALUES may be untouched, but they belong
   *  to a different profile now. */
  | 'PROFILE_CHANGED'
  /** The edit targets a field the active simplified generator owns and
   *  would immediately overwrite. */
  | 'DIRECT_EDIT_CONFLICTS_WITH_ACTIVE_SIMPLIFIED'
  /** Copying onto the profile that is currently running: permitted by the
   *  firmware, refused here, because no re-initialisation follows it. */
  | 'ACTIVE_DESTINATION_COPY_UNSAFE'
  /** The board answered nothing for the simplified command family, which is
   *  real evidence the feature is not built in. */
  | 'SIMPLIFIED_TUNING_UNSUPPORTED'
  /** The board's own CALCULATE result disagrees with our generator, so we
   *  cannot claim the projection is source-equivalent for these inputs. */
  | 'SIMPLIFIED_PROJECTION_ORACLE_DISAGREES'
  /** The requested rates type is not one of the five formulas we have read. */
  | 'UNKNOWN_RATES_TYPE';
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

/**
 * What a verified write actually established.
 *
 * `normalisations` names every field the board changed for a reason the
 * firmware's own rules predict - a clamped TPA rate, a notch its cutoff
 * disabled, pitch following roll. They are reported rather than swallowed,
 * because "saved" and "saved, and the board also did this" are different
 * facts and the operator is entitled to the second one.
 *
 * `sideEffects` carries truths OUTSIDE this screen that the write moved.
 */
export interface PidWriteEvidence {
  readonly normalisations: readonly FieldComparison[];
  readonly sideEffects?: CrossSubsystemReport;
  readonly simplifiedValidity?: SimplifiedTuningValidity;
  /**
   * What the board's own CALCULATE RPCs said our generator should produce.
   * A SECONDARY oracle: it runs on a temporary copy of the profile and
   * stores nothing, so it can corroborate our reimplementation but can
   * never stand in for the post-write readback.
   */
  readonly projectionOracle?: SimplifiedProjectionOracle;
}

/**
 * MSP_CALCULATE_SIMPLIFIED_PID (142) run as a cross-check.
 *
 *   ORACLE_AGREES      the board's temporary-copy result matches the tune our
 *                      own generator predicts, field for field
 *   ORACLE_DISAGREES   it does not - so our reimplementation is not proven
 *                      source-equivalent for these inputs, and the write is
 *                      abandoned BEFORE anything is stored
 *   ORACLE_UNAVAILABLE the command family is absent from this build; not an
 *                      error, and emphatically not an agreement
 */
export type SimplifiedProjectionOracle =
  | {readonly kind: 'ORACLE_AGREES'}
  | {readonly kind: 'ORACLE_DISAGREES'; readonly fields: readonly FieldComparison[]}
  | {readonly kind: 'ORACLE_UNAVAILABLE'};

/**
 * Every stage a PID-page write can be in doubt at.
 *
 * The four settings groups and the persist step were always here; the five
 * profile-lifecycle stages are new, and they are deliberately NOT folded into
 * the settings groups. "The copy may or may not have happened" and "the PID
 * values may or may not have arrived" are different facts for an operator.
 */
export type PidWriteStage =
  | PidTuningWriteGroup
  | 'EEPROM'
  | 'SIMPLIFIED'
  | 'COPY_PROFILE'
  | 'SELECT_PROFILE'
  | 'RESET_PID_PROFILE'
  | 'PROFILE_NAME';

export type PidSaveOutcome =
  | {readonly kind: 'NO_CHANGES'; readonly snapshot: MspPidTuningSnapshot}
  /** Applied AND persisted, both proven by a fresh read. */
  | {readonly kind: 'SAVED_VERIFIED'; readonly snapshot: MspPidTuningSnapshot; readonly evidence: PidWriteEvidence}
  /** The runtime is right and the persistence proof failed. Not success. */
  | {readonly kind: 'APPLIED_PERSISTENCE_UNVERIFIED'; readonly snapshot: MspPidTuningSnapshot; readonly evidence: PidWriteEvidence; readonly error: unknown}
  /** The board holds something neither requested nor predicted. */
  | {readonly kind: 'READBACK_MISMATCH'; readonly group: PidTuningWriteGroup; readonly fields: readonly FieldComparison[]}
  /** An unowned truth moved in a way the source does not explain. */
  | {readonly kind: 'UNEXPECTED_CROSS_SUBSYSTEM_CHANGE'; readonly sideEffects: CrossSubsystemReport}
  /**
   * A truth outside this screen moved, and the firmware rule that would
   * explain it is gated on a build-time target macro MSP never reports. We
   * decline to call that a normalisation, and decline to commit.
   */
  | {readonly kind: 'SIDE_EFFECT_PREDICTION_NOT_PROVEN'; readonly sideEffects: CrossSubsystemReport}
  | {readonly kind: 'SAVED_UNVERIFIED'; readonly error: unknown}
  | {readonly kind: 'REJECTED'; readonly reason: PidBlockReason; readonly conflict?: SimplifiedConflict}
  | {readonly kind: 'UNCONFIRMED'; readonly stage: PidWriteStage; readonly confirmedStages: readonly PidWriteStage[]}
  /** U-R1. At least one RAM write was ACKNOWLEDGED and the sequence then
   *  stopped before EEPROM was acknowledged. Nothing is persisted, but
   *  the aircraft's RAM has already moved. No rollback, no retry. */
  | {readonly kind: 'PARTIAL_UNPERSISTED'; readonly confirmedStages: readonly PidWriteStage[]; readonly failedStage: PidWriteStage; readonly definitelyNotSent: boolean}
  | {readonly kind: 'SESSION_ENDED'}
  | {readonly kind: 'FAILED'; readonly error: unknown};

/**
 * A simplified save reports the same verified/applied-only/mismatch triad as
 * a direct save, because it is subject to exactly the same doubts, plus the
 * firmware's own VALIDATE opinion carried as evidence.
 */
export type PidSimplifiedSaveOutcome =
  | {readonly kind: 'NO_CHANGES'; readonly snapshot: MspPidTuningSnapshot}
  | {readonly kind: 'SAVED_VERIFIED'; readonly snapshot: MspPidTuningSnapshot; readonly evidence: PidWriteEvidence}
  | {readonly kind: 'APPLIED_PERSISTENCE_UNVERIFIED'; readonly snapshot: MspPidTuningSnapshot; readonly evidence: PidWriteEvidence; readonly error: unknown}
  | {readonly kind: 'READBACK_MISMATCH'; readonly fields: readonly FieldComparison[]}
  | {readonly kind: 'REJECTED'; readonly reason: PidBlockReason}
  | {readonly kind: 'UNCONFIRMED'}
  | {readonly kind: 'SESSION_ENDED'}
  | {readonly kind: 'FAILED'; readonly error: unknown};

/**
 * `LEFT_ON_ANOTHER_PROFILE` is the outcome that must never be silent: the
 * board is running a profile the operator did not choose, and saying so is
 * the whole reason the copy lifecycle re-reads MSP_STATUS_EX after every
 * selection instead of trusting the acknowledgement.
 */
export type PidProfileCopyOutcome =
  | {readonly kind: 'COPIED_VERIFIED'; readonly snapshot: MspPidTuningSnapshot; readonly sourceIndex: number; readonly destinationIndex: number}
  | {readonly kind: 'COPY_MISMATCH'; readonly destinationIndex: number; readonly fields: readonly FieldComparison[]}
  | {readonly kind: 'LEFT_ON_ANOTHER_PROFILE'; readonly requestedIndex: number; readonly activeIndex: number}
  | {readonly kind: 'REJECTED'; readonly reason: PidBlockReason}
  | {readonly kind: 'UNCONFIRMED'}
  | {readonly kind: 'SESSION_ENDED'}
  | {readonly kind: 'FAILED'; readonly error: unknown};

/**
 * A RESOURCE THE RESET READBACK CAN TRY TO OBSERVE.
 *
 * These are identifiers, not sentences. The wording an operator reads is
 * the screen's job; the controller's job is to say WHICH resource it did
 * and did not manage to check.
 */
export type PidResetResource =
  | 'PID'
  | 'PID_ADVANCED'
  | 'FILTER_CONFIG'
  | 'PROFILE_NAME'
  | 'SIMPLIFIED_TUNING';

/**
 * WHY A RESOURCE IS MISSING FROM `verifiedScope`.
 *
 * There is exactly one member, and that is deliberate. Telling a timeout
 * apart from "this build does not implement the command" would need
 * evidence this controller does not have: support for MSP_SIMPLIFIED_TUNING
 * is inferred from whether the read answers, and MSP2_GET_TEXT has no
 * capability gate either. Emitting UNSUPPORTED here would be a guess
 * dressed as a finding, so the honest label is the one that says only what
 * happened - the read was attempted and produced no value.
 */
export type PidResetVerificationGapReason = 'READ_FAILED';

/** One resource this reset could NOT check, and why. */
export interface PidResetVerificationGap {
  readonly resource: PidResetResource;
  readonly reason: PidResetVerificationGapReason;
}

/**
 * The success case is named for what it actually is. The firmware command
 * persists nothing, so calling this SAVED would be a lie the operator would
 * discover on the next power cycle.
 */
export type PidProfileResetOutcome =
  /**
   * PARTIALLY, because `RESET_CONFIG` rewrites the entire `pidProfile_t` and
   * this screen can only read part of it.
   *
   * `verifiedScope` carries ONLY resources whose read actually succeeded on
   * THIS reset, and `verificationGaps` names the ones that did not. The two
   * together are the whole claim: everything outside both lists is untested
   * rather than assumed correct.
   *
   * It used to return the static OBSERVABLE_RESET_SCOPE constant here, which
   * meant a failed profile-name read still reported the name as verified -
   * an operator was told a check had passed that was never performed.
   */
  | {
      readonly kind: 'RESET_APPLIED_PARTIALLY_VERIFIED';
      readonly snapshot: MspPidTuningSnapshot;
      readonly persists: false;
      readonly verifiedScope: readonly PidResetResource[];
      readonly verificationGaps: readonly PidResetVerificationGap[];
    }
  | {readonly kind: 'READBACK_MISMATCH'; readonly fields: readonly FieldComparison[]}
  | {readonly kind: 'REJECTED'; readonly reason: PidBlockReason}
  | {readonly kind: 'UNCONFIRMED'}
  | {readonly kind: 'SESSION_ENDED'}
  | {readonly kind: 'FAILED'; readonly error: unknown};

/**
 * WHAT A RATES-TYPE WRITE ANSWERS.
 *
 * Deliberately separate from PidSaveOutcome: this changes which FORMULA
 * interprets the stored numbers, which is a different kind of act from
 * editing a value, and a pilot deserves to be told which one happened.
 */
export type PidRatesTypeOutcome =
  | {readonly kind: 'NO_CHANGES'; readonly snapshot: MspPidTuningSnapshot}
  | {readonly kind: 'PERSISTED_VERIFIED'; readonly snapshot: MspPidTuningSnapshot; readonly ratesTypeRaw: number}
  | {readonly kind: 'APPLIED_PERSISTENCE_UNVERIFIED'; readonly snapshot: MspPidTuningSnapshot; readonly error: unknown}
  | {readonly kind: 'READBACK_MISMATCH'; readonly fields: readonly FieldComparison[]}
  | {readonly kind: 'REJECTED'; readonly reason: PidBlockReason}
  | {readonly kind: 'UNCONFIRMED'}
  | {readonly kind: 'SESSION_ENDED'}
  | {readonly kind: 'FAILED'; readonly error: unknown};

/**
 * The simplified state, or an honest statement that it could not be read.
 *
 * UNSUPPORTED is real evidence: the command family is absent without
 * USE_SIMPLIFIED_TUNING, so a refusal proves something about the build.
 * A zero in a field proves nothing, which is why there is no third state
 * that quietly means "probably off".
 */
export type PidSimplifiedLoadOutcome =
  | {readonly kind: 'LOADED'; readonly simplified: MspSimplifiedTuning; readonly validity?: SimplifiedTuningValidity}
  | {readonly kind: 'UNSUPPORTED'}
  | {readonly kind: 'REJECTED'; readonly reason: PidBlockReason}
  | {readonly kind: 'SESSION_ENDED'}
  | {readonly kind: 'FAILED'; readonly error: unknown};

export type PidProfileNameOutcome =
  | {readonly kind: 'NAME'; readonly profile: PidProfileKind; readonly name: string}
  | {readonly kind: 'NAMED_VERIFIED'; readonly profile: PidProfileKind; readonly name: string}
  | {readonly kind: 'NAME_MISMATCH'; readonly profile: PidProfileKind; readonly requested: string; readonly observed: string}
  | {readonly kind: 'REJECTED'; readonly reason: PidBlockReason}
  | {readonly kind: 'UNCONFIRMED'}
  | {readonly kind: 'SESSION_ENDED'}
  | {readonly kind: 'FAILED'; readonly error: unknown};

export interface PidTuningControllerOptions { readonly coordinator?: PidSessionCoordinator; readonly appStateOwner?: PidAppStateOwner; readonly isMotorTestActive?: (sessionId: string) => boolean }

class PidPreflightError extends Error { constructor(readonly reason: PidBlockReason) { super(`PID preflight rejected: ${reason}`); this.name = 'PidPreflightError'; } }
interface AmbiguousPidCause extends PartialApplyEvidence<PidWriteStage> { readonly kind: 'PID_AMBIGUOUS_WRITE'; readonly stage: PidWriteStage }
class AmbiguousPidWriteError extends MspOperationOutcomeUnknownError { constructor(error: unknown, stage: PidWriteStage, confirmedStages: readonly PidWriteStage[] = [], partial = false, definitelyNotSent = false) { super(Object.freeze({kind: 'PID_AMBIGUOUS_WRITE', stage, error, confirmedStages: Object.freeze([...confirmedStages]), partial, definitelyNotSent})); } }
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
/** Raised before the wire when a direct edit collides with the generator. */
class SimplifiedConflictError extends Error {
  constructor(readonly conflict: SimplifiedConflict) {
    super('Direct edit conflicts with active simplified tuning.');
    this.name = 'SimplifiedConflictError';
  }
}

/**
 * The active profile must be the one the draft was read from.
 *
 * This is the check that closes the hazard P-A found in the reference
 * implementation: a radio switch moves the FC to another PID profile while a
 * draft is open, and the save lands in the wrong tune. Values are compared
 * separately - a profile that moved is refused even when every byte matches,
 * because identical numbers in a different profile are still the wrong
 * place to write them.
 */
function assertSameProfile(original: MspPidTuningSnapshot, fresh: MspPidTuningSnapshot): void {
  const was: PidProfileIdentity = pidProfileIdentity(original.pidProfileIndex, original.pidProfileCount);
  const now: PidProfileIdentity = pidProfileIdentity(fresh.pidProfileIndex, fresh.pidProfileCount);
  const wasRate: RateProfileIdentity = rateProfileIdentity(original.controlRateProfileIndex, original.rateProfileCount);
  const nowRate: RateProfileIdentity = rateProfileIdentity(fresh.controlRateProfileIndex, fresh.rateProfileCount);
  if (!profileIdentitiesEqual(was, now) || !profileIdentitiesEqual(wasRate, nowRate)) {
    throw new PidPreflightError('PROFILE_CHANGED');
  }
}

/** Which PID-gain fields the draft actually moved, in generator vocabulary. */
function editedDirectFields(original: MspPidTuningSnapshot, draft: PidTuningDraft): readonly string[] {
  const base = createPidTuningDraft(original);
  const out: string[] = [];
  (['roll', 'pitch', 'yaw'] as const).forEach((axis, index) => {
    const label = ['ROLL', 'PITCH', 'YAW'][index];
    if (draft[axis].p !== base[axis].p) out.push(`${label}.P`);
    if (draft[axis].i !== base[axis].i) out.push(`${label}.I`);
    if (draft[axis].d !== base[axis].d) out.push(`${label}.D`);
    if (draft[axis].f !== base[axis].f) out.push(`${label}.F`);
  });
  /* D MAX IS GENERATOR-OWNED. `simplifiedOwnedFields` already lists
     ROLL/PITCH/YAW.D_MAX because the firmware rewrites `d_max[axis]` from
     the sliders on every simplified write - it was simply unreachable
     until P-E made D Max editable. Emitting the same names here is what
     connects the new controls to the refusal that already existed. */
  const advancedBase = base.advanced;
  const dMaxKeys = ['dMaxRoll', 'dMaxPitch', 'dMaxYaw'] as const;
  dMaxKeys.forEach((key, index) => {
    if (draft.advanced[key] !== advancedBase[key]) out.push(`${['ROLL', 'PITCH', 'YAW'][index]}.D_MAX`);
  });
  return out;
}

/** Which filter frequencies the draft moved, by the generator's own names. */
function editedFilterFields(original: MspPidTuningSnapshot, draft: PidTuningDraft): readonly string[] {
  const base = createPidTuningDraft(original).filters;
  const out: string[] = [];
  const compare = (key: keyof typeof base, name: string): void => {
    if (draft.filters[key] !== base[key]) out.push(name);
  };
  compare('gyroLpf1StaticHz', 'gyroLpf1StaticHz');
  compare('gyroLpf1DynamicMinHz', 'gyroLpf1DynMinHz');
  compare('gyroLpf1DynamicMaxHz', 'gyroLpf1DynMaxHz');
  compare('dtermLpf1StaticHz', 'dtermLpf1StaticHz');
  compare('dtermLpf1DynamicMinHz', 'dtermLpf1DynMinHz');
  compare('dtermLpf1DynamicMaxHz', 'dtermLpf1DynMaxHz');
  /* The SECOND lowpasses, which P-E added to the expert tier. The
     simplified generator rescales them from the same multiplier, so they
     belong in the same conflict check as the first pair. */
  const advancedBase = createPidTuningDraft(original).advancedFilters;
  if (draft.advancedFilters.gyroLpf2StaticHz !== advancedBase.gyroLpf2StaticHz) {
    out.push('gyroLpf2StaticHz');
  }
  if (draft.advancedFilters.dtermLpf2StaticHz !== advancedBase.dtermLpf2StaticHz) {
    out.push('dtermLpf2StaticHz');
  }
  return out;
}

/** The three MSP_ADVANCED_CONFIG fields a filter write can disturb. */
function advancedWitness(snapshot: MspPidTuningSnapshot): AdvancedConfigWitness {
  return {
    pidProcessDenom: snapshot.pidProcessDenom ?? 0,
    motorProtocolRaw: snapshot.motorProtocolRaw ?? 0,
    motorPwmRate: snapshot.motorPwmRate ?? 0,
  };
}

interface GroupOutcome { readonly group: PidTuningWriteGroup; readonly verdict: GroupVerdict }

/**
 * Classify only the groups that were actually written, field by field.
 *
 * Deliberately NOT a whole-draft comparison: rates carry the pitch-link
 * rule, filters carry four firmware corrections, and advanced carries the
 * TPA clamp. Comparing whole objects would report every one of those as a
 * failed save on a board doing exactly what its firmware says.
 */
function classifySaveGroups(
  contract: PidApiContract,
  original: MspPidTuningSnapshot,
  observed: MspPidTuningSnapshot,
  writes: readonly {readonly group: PidTuningWriteGroup; readonly payload: Uint8Array}[],
): readonly GroupOutcome[] {
  const out: GroupOutcome[] = [];
  for (const write of writes) {
    switch (write.group) {
      case 'PID':
        out.push({group: 'PID', verdict: classifyPidReadback(write.payload, observed.pidRaw)});
        break;
      case 'PID_ADVANCED':
        out.push({
          group: 'PID_ADVANCED',
          verdict: classifyAdvancedReadback(
            ownedAdvancedFields(decodePidAdvancedFull(write.payload, contract)),
            ownedAdvancedFields(decodePidAdvancedFull(observed.advancedRaw, contract)),
          ),
        });
        break;
      case 'RC_TUNING':
        out.push({
          group: 'RC_TUNING',
          verdict: classifyRcTuningReadback(
            decodeRcTuningFull(original.ratesRaw),
            decodeRcTuningFull(write.payload),
            decodeRcTuningFull(observed.ratesRaw),
          ),
        });
        break;
      case 'FILTER_CONFIG':
        out.push({
          group: 'FILTER_CONFIG',
          verdict: classifyFilterReadback(
            ownedFilterFields(decodeFilterConfigFull(write.payload, contract)),
            ownedFilterFields(decodeFilterConfigFull(observed.filtersRaw, contract)),
          ),
        });
        break;
    }
  }
  return out;
}

type SaveInternal =
  | {readonly saved: {readonly snapshot: MspPidTuningSnapshot; readonly evidence: PidWriteEvidence}}
  | {readonly appliedOnly: {readonly snapshot: MspPidTuningSnapshot; readonly evidence: PidWriteEvidence; readonly error: unknown}}
  | {readonly mismatch: {readonly group: PidTuningWriteGroup; readonly fields: readonly FieldComparison[]}}
  | {readonly unexpected: CrossSubsystemReport}
  | {readonly notProven: CrossSubsystemReport};

type SimplifiedInternal =
  | {readonly unchanged: MspPidTuningSnapshot}
  | {readonly saved: {readonly snapshot: MspPidTuningSnapshot; readonly evidence: PidWriteEvidence}}
  | {readonly appliedOnly: {readonly snapshot: MspPidTuningSnapshot; readonly evidence: PidWriteEvidence; readonly error: unknown}}
  | {readonly mismatch: {readonly fields: readonly FieldComparison[]}};

type RatesTypeInternal =
  | {readonly unchanged: MspPidTuningSnapshot}
  | {readonly persisted: {readonly snapshot: MspPidTuningSnapshot; readonly ratesTypeRaw: number}}
  | {readonly appliedOnly: {readonly snapshot: MspPidTuningSnapshot; readonly error: unknown}}
  | {readonly mismatch: {readonly fields: readonly FieldComparison[]}};

/**
 * A rates-type write owns ONE byte. Every other byte of MSP_RC_TUNING must
 * come back exactly as it went out - including the ones this app never
 * edits - because a board that rescaled a rate while changing its formula
 * would have changed how the aircraft flies twice over.
 *
 * The three retired offsets are skipped: the firmware answers literal zeros
 * there whatever was written, so comparing them would fail every write.
 */
function ratesTypeWriteDifferences(
  before: MspPidTuningSnapshot,
  after: MspPidTuningSnapshot,
  ratesTypeRaw: number,
): readonly FieldComparison[] {
  const out: FieldComparison[] = [];
  const retired = new Set(RC_TUNING_RETIRED_OFFSETS);
  for (let offset = 0; offset < MSP_RC_TUNING_BYTES; offset += 1) {
    if (retired.has(offset)) continue;
    const want = offset === RC_TUNING_OFFSETS.ratesType ? ratesTypeRaw : (before.ratesRaw[offset] ?? 0);
    const got = after.ratesRaw[offset] ?? 0;
    if (want !== got) {
      out.push({
        field: offset === RC_TUNING_OFFSETS.ratesType ? 'ratesType' : `RC_TUNING[${offset}]`,
        verdict: {kind: 'MISMATCH', requested: want, expected: want, observed: got},
      });
    }
  }
  return out;
}

type CopyInternal =
  | {readonly copied: {readonly snapshot: MspPidTuningSnapshot; readonly sourceIndex: number; readonly destinationIndex: number}}
  | {readonly mismatch: {readonly destinationIndex: number; readonly fields: readonly FieldComparison[]}}
  | {readonly leftOnAnotherProfile: {readonly requestedIndex: number; readonly activeIndex: number}};

/**
 * A COPY IS A MEMCPY, SO THE ONLY HONEST CHECK IS BYTE FOR BYTE.
 *
 * No firmware rule normalises anything on this path - the handler copies the
 * struct and returns - so there is no `expected` that differs from the
 * request, and any difference at all is a mismatch. The offsets are reported
 * raw because a byte index inside a profile struct is exactly what a reviewer
 * needs to find the field, and inventing a friendly name for a byte we did
 * not decode would be worse than saying which byte it was.
 *
 * MSP_FILTER_CONFIG is compared in full even though only part of it belongs
 * to the PID profile: the global half is identical on both reads by
 * construction, so a difference there would itself be a real finding.
 */
function copiedProfileDifferences(
  kind: PidProfileKind,
  source: MspPidTuningSnapshot,
  destination: MspPidTuningSnapshot,
): readonly FieldComparison[] {
  const out: FieldComparison[] = [];
  const compare = (label: string, expected: Uint8Array, observed: Uint8Array): void => {
    const length = Math.max(expected.length, observed.length);
    for (let index = 0; index < length; index += 1) {
      const want = expected[index] ?? 0;
      const got = observed[index] ?? 0;
      if (want !== got) {
        out.push({field: `${label}[${index}]`, verdict: {kind: 'MISMATCH', requested: want, expected: want, observed: got}});
      }
    }
  };
  if (kind === 'RATE') {
    compare('RC_TUNING', source.ratesRaw, destination.ratesRaw);
    return out;
  }
  compare('PID', source.pidRaw, destination.pidRaw);
  compare('PID_ADVANCED', source.advancedRaw, destination.advancedRaw);
  compare('FILTER_CONFIG', source.filtersRaw, destination.filtersRaw);
  return out;
}

/**
 * WHAT `resetPidProfile()` PRODUCES, AND HOW MUCH OF IT WE CAN SEE.
 *
 * The command is `RESET_CONFIG(pidProfile_t, ...)`, which memcpys a static
 * const template over the WHOLE struct (config_reset.h:31-36). So it resets
 * far more than the gains: the D Max pair, TPA, the feedforward feel
 * settings, the D-term filter frequencies, the profile NAME, and the
 * simplified sliders - which it turns back ON in the RPY mode.
 *
 * We can observe a large part of that through MSP_PID, MSP_PID_ADVANCED,
 * MSP_FILTER_CONFIG, MSP2_GET_TEXT and MSP_SIMPLIFIED_TUNING, and that part
 * is checked below. We cannot observe the rest - iterm relax, anti-gravity,
 * the level-angle limits, the TPA curve parameters and more - because this
 * screen never reads those commands. So the outcome is named
 * RESET_APPLIED_PARTIALLY_VERIFIED and carries the scope it actually
 * checked, rather than claiming the whole profile was proven.
 */
const FIRMWARE_PID_DEFAULTS: readonly {readonly p: number; readonly i: number; readonly d: number}[] = Object.freeze([
  Object.freeze({p: 45, i: 80, d: 30}),   // PID_ROLL_DEFAULT
  Object.freeze({p: 47, i: 84, d: 34}),   // PID_PITCH_DEFAULT
  Object.freeze({p: 45, i: 80, d: 0}),    // PID_YAW_DEFAULT
  Object.freeze({p: 50, i: 75, d: 75}),   // [PID_LEVEL] = {50, 75, 75, 50, 0}
  Object.freeze({p: 40, i: 0, d: 0}),     // [PID_MAG] = {40, 0, 0, 0, 0}
]);
/** The `F` element of each PID_*_DEFAULT, which travels on MSP_PID_ADVANCED. */
const FIRMWARE_FEEDFORWARD_DEFAULTS: readonly number[] = Object.freeze([120, 125, 120]);
/** `.d_max = D_MAX_DEFAULT` and `.d_max_gain = 37`. */
const FIRMWARE_D_MAX_DEFAULTS: readonly number[] = Object.freeze([40, 46, 0]);
const FIRMWARE_D_MAX_GAIN_DEFAULT = 37;
/** `.tpa_rate = 65`, `.tpa_breakpoint = 1350`, `.dyn_idle_min_rpm = 0`. */
const FIRMWARE_TPA_RATE_DEFAULT = 65;
const FIRMWARE_TPA_BREAKPOINT_DEFAULT = 1350;
const FIRMWARE_DYN_IDLE_MIN_RPM_DEFAULT = 0;
/** `.feedforward_averaging = FEEDFORWARD_AVERAGING_2_POINT` (1), boost 15,
 *  jitter 7. */
const FIRMWARE_FEEDFORWARD_AVERAGING_DEFAULT = 1;
const FIRMWARE_FEEDFORWARD_BOOST_DEFAULT = 15;
const FIRMWARE_FEEDFORWARD_JITTER_DEFAULT = 7;
/** `.dterm_lpf1_static_hz = 75`, `lpf2 150`, `dyn min 75`, `dyn max 150`,
 *  `.yaw_lowpass_hz = 100`. */
const FIRMWARE_DTERM_LPF1_STATIC_DEFAULT = 75;
const FIRMWARE_DTERM_LPF2_STATIC_DEFAULT = 150;
const FIRMWARE_DTERM_LPF1_DYN_MIN_DEFAULT = 75;
const FIRMWARE_DTERM_LPF1_DYN_MAX_DEFAULT = 150;
const FIRMWARE_YAW_LOWPASS_DEFAULT = 100;
/** `.simplified_pids_mode = PID_SIMPLIFIED_TUNING_RPY`. */
const FIRMWARE_SIMPLIFIED_PIDS_MODE_DEFAULT = 2;

/**
 * WHAT THIS BUILD CAN ATTEMPT TO OBSERVE AFTER A RESET - A CAPABILITY
 * STATEMENT, NOT A RESULT.
 *
 * This is static: it describes the reader that ships in this build. It is
 * emphatically NOT evidence that any particular reset checked these things,
 * and `resetPidProfile` no longer returns it as such. What a given reset
 * actually managed to observe travels in that outcome's `verifiedScope`,
 * and what it could not travels in `verificationGaps`.
 */
export const OBSERVABLE_RESET_SCOPE: readonly string[] = Object.freeze([
  'MSP_PID: all five items, P/I/D',
  'MSP_PID_ADVANCED: feedforward, D Max, D Max gain, TPA rate/breakpoint, dynamic idle, feedforward feel',
  'MSP_FILTER_CONFIG: the PID-profile D-term frequencies and the yaw lowpass',
  'MSP2_GET_TEXT: the profile name',
  'MSP_SIMPLIFIED_TUNING: the generator mode',
]);

/**
 * The result of ONE optional post-reset read.
 *
 * `undefined` used to carry this, and that is precisely what made the
 * defect possible: a value that was never read and a value that came back
 * absent were the same thing to every caller downstream.
 */
type ResetObserved<T> =
  | {readonly kind: 'OBSERVED'; readonly value: T}
  | {readonly kind: 'READ_FAILED'};

interface ResetObservation {
  readonly snapshot: MspPidTuningSnapshot;
  readonly name: ResetObserved<string>;
  readonly simplified: ResetObserved<MspSimplifiedTuning>;
}

/**
 * The evidence a reset is entitled to claim.
 *
 * The three core groups are unconditional here because they all arrive on
 * one `readSnapshot`, which throws as a unit - reaching this function at
 * all means those three reads succeeded. The two optional resources are
 * listed only when their own read answered.
 */
function pidResetEvidence(observation: ResetObservation): {
  readonly verifiedScope: readonly PidResetResource[];
  readonly verificationGaps: readonly PidResetVerificationGap[];
} {
  const verifiedScope: PidResetResource[] = ['PID', 'PID_ADVANCED', 'FILTER_CONFIG'];
  const verificationGaps: PidResetVerificationGap[] = [];
  const record = (resource: PidResetResource, observed: ResetObserved<unknown>): void => {
    if (observed.kind === 'OBSERVED') verifiedScope.push(resource);
    else verificationGaps.push({resource, reason: 'READ_FAILED'});
  };
  record('PROFILE_NAME', observation.name);
  record('SIMPLIFIED_TUNING', observation.simplified);
  return {
    verifiedScope: Object.freeze(verifiedScope),
    verificationGaps: Object.freeze(verificationGaps),
  };
}

function pidProfileDefaultDifferences(
  observation: ResetObservation,
  contract: PidApiContract,
): readonly FieldComparison[] {
  const {snapshot} = observation;
  const advanced = decodePidAdvancedFull(snapshot.advancedRaw, contract);
  const filters = decodeFilterConfigFull(snapshot.filtersRaw, contract);
  const comparisons: FieldComparison[] = [];
  const expect = (field: string, want: number, got: number): void => {
    if (want !== got) comparisons.push({field, verdict: {kind: 'MISMATCH', requested: want, expected: want, observed: got}});
  };

  const items = ['ROLL', 'PITCH', 'YAW', 'LEVEL', 'MAG'] as const;
  FIRMWARE_PID_DEFAULTS.forEach((want, index) => {
    expect(`${items[index]}.P`, want.p, snapshot.pidRaw[index * 3]);
    expect(`${items[index]}.I`, want.i, snapshot.pidRaw[index * 3 + 1]);
    expect(`${items[index]}.D`, want.d, snapshot.pidRaw[index * 3 + 2]);
  });
  const axes = ['ROLL', 'PITCH', 'YAW'] as const;
  FIRMWARE_FEEDFORWARD_DEFAULTS.forEach((want, index) => {
    expect(`${axes[index]}.F`, want, advanced.feedforward[index]);
  });
  FIRMWARE_D_MAX_DEFAULTS.forEach((want, index) => {
    expect(`${axes[index]}.D_MAX`, want, advanced.dMax[index]);
  });
  expect('dMaxGain', FIRMWARE_D_MAX_GAIN_DEFAULT, advanced.dMaxGain);
  expect('tpaRate', FIRMWARE_TPA_RATE_DEFAULT, advanced.tpaRate);
  expect('tpaBreakpoint', FIRMWARE_TPA_BREAKPOINT_DEFAULT, advanced.tpaBreakpoint);
  expect('dynIdleMinRpm', FIRMWARE_DYN_IDLE_MIN_RPM_DEFAULT, advanced.dynIdleMinRpm);
  expect('feedforwardAveraging', FIRMWARE_FEEDFORWARD_AVERAGING_DEFAULT, advanced.feedforwardAveraging);
  expect('feedforwardBoost', FIRMWARE_FEEDFORWARD_BOOST_DEFAULT, advanced.feedforwardBoost);
  expect('feedforwardJitterFactor', FIRMWARE_FEEDFORWARD_JITTER_DEFAULT, advanced.feedforwardJitterFactor);
  expect('dtermLpf1StaticHz', FIRMWARE_DTERM_LPF1_STATIC_DEFAULT, filters.dtermLpf1StaticHz);
  expect('dtermLpf2StaticHz', FIRMWARE_DTERM_LPF2_STATIC_DEFAULT, filters.dtermLpf2StaticHz);
  expect('dtermLpf1DynMinHz', FIRMWARE_DTERM_LPF1_DYN_MIN_DEFAULT, filters.dtermLpf1DynMinHz);
  expect('dtermLpf1DynMaxHz', FIRMWARE_DTERM_LPF1_DYN_MAX_DEFAULT, filters.dtermLpf1DynMaxHz);
  expect('yawLowpassHz', FIRMWARE_YAW_LOWPASS_DEFAULT, filters.yawLowpassHz);
  /*
   * A MISMATCH IS A STATEMENT ABOUT AN OBSERVED VALUE.
   *
   * Both of these compare only when the read answered. A failed read is not
   * evidence of agreement and it is not evidence of disagreement either -
   * it produces no comparison at all, and shows up instead as a gap in
   * `pidResetEvidence`. Deriving "matches the default" from a read that
   * never happened is the whole defect this guards.
   */
  if (observation.simplified.kind === 'OBSERVED') {
    expect('simplifiedPidsMode', FIRMWARE_SIMPLIFIED_PIDS_MODE_DEFAULT, observation.simplified.value.pids.modeRaw);
  }
  if (observation.name.kind === 'OBSERVED' && observation.name.value !== '') {
    comparisons.push({
      field: 'profileName',
      verdict: {kind: 'MISMATCH', requested: 0, expected: 0, observed: observation.name.value.length},
    });
  }
  return comparisons;
}

function saveOutcomeFrom(internal: SaveInternal): PidSaveOutcome {
  if ('saved' in internal) return {kind: 'SAVED_VERIFIED', ...internal.saved};
  if ('appliedOnly' in internal) return {kind: 'APPLIED_PERSISTENCE_UNVERIFIED', ...internal.appliedOnly};
  if ('mismatch' in internal) return {kind: 'READBACK_MISMATCH', ...internal.mismatch};
  if ('notProven' in internal) return {kind: 'SIDE_EFFECT_PREDICTION_NOT_PROVEN', sideEffects: internal.notProven};
  return {kind: 'UNEXPECTED_CROSS_SUBSYSTEM_CHANGE', sideEffects: internal.unexpected};
}

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
    const {client, scheduler, epoch, gyroSampleRateHz, contract} = captured; let interlock;
    try { interlock = acquireMotorConfigurationInterlock(client); }
    catch (error) { return error instanceof MotorConfigurationTransactionInProgressError ? {kind: 'REJECTED', reason: 'CONFIGURATION_BUSY'} : {kind: 'FAILED', error}; }
    try {
      const result = await this.operations(key.sessionId, client, scheduler).execute<MspPidTuningSnapshot>({
        id: `pid:load:${key.sessionId}:${key.generation}`, sessionEffect: 'KEEP_SESSION',
        validate: context => context.clientState === 'READY' ? {allowed: true} : {allowed: false, error: new PidPreflightError('LINK_RECOVERING')},
        execute: async requester => { this.assertLive(key, client, epoch); return this.readSnapshot(requester, contract, gyroSampleRateHz); },
      });
      if (result.status === 'SUCCEEDED') return {kind: 'LOADED', snapshot: result.result};
      if (result.status === 'SESSION_ENDED' || result.status === 'OUTCOME_UNKNOWN') return {kind: 'SESSION_ENDED'};
      return result.error instanceof PidPreflightError ? {kind: 'REJECTED', reason: result.error.reason} : {kind: 'FAILED', error: result.error};
    } finally { interlock.release(); }
  }

  async save(key: SetupUiSessionKey, original: MspPidTuningSnapshot, draft: PidTuningDraft): Promise<PidSaveOutcome> {
    if (pidTuningDraftsEqual(createPidTuningDraft(original), draft)) return {kind: 'NO_CHANGES', snapshot: original};
    if (validatePidTuningDraft(draft, original).length > 0) return {kind: 'REJECTED', reason: 'INVALID_CONFIGURATION'};
    const captured = this.capture(key, 'WRITE'); if ('reason' in captured) return {kind: 'REJECTED', reason: captured.reason};
    const {client, scheduler, epoch, gyroSampleRateHz, contract} = captured; let interlock;
    try { interlock = acquireMotorConfigurationInterlock(client); }
    catch (error) { return error instanceof MotorConfigurationTransactionInProgressError ? {kind: 'REJECTED', reason: 'CONFIGURATION_BUSY'} : {kind: 'FAILED', error}; }
    try {
      const acquisition = this.boxIdsFor(key.sessionId, client); const identity: BoxIdsOwnerIdentity = {physicalGeneration: key.generation, mspEpoch: epoch};
      const result = await this.operations(key.sessionId, client, scheduler).execute<SaveInternal>({
        id: `pid:save:${key.sessionId}:${key.generation}`, sessionEffect: 'KEEP_SESSION',
        validate: context => context.clientState === 'READY' ? {allowed: true} : {allowed: false, error: new PidPreflightError('LINK_RECOVERING')},
        execute: async requester => {
          this.assertLive(key, client, epoch);
          const fresh = await this.readSnapshot(requester, contract, gyroSampleRateHz);
          // PROFILE FIRST, then values. A moved profile is not a stale
          // value - the draft may be byte-identical and still belong to
          // somebody else's tune - so it gets its own refusal.
          assertSameProfile(original, fresh);
          if (!pidTuningSnapshotsEqual(fresh, original)) throw new PidPreflightError('STALE_BASE');

          // A field the active generator owns cannot be edited directly:
          // the firmware would overwrite it on the next simplified write,
          // so reporting it saved would be false.
          const simplified = await this.readSimplifiedIfSupported(requester);
          if (simplified !== undefined) {
            const conflict = detectSimplifiedConflict(
              editedDirectFields(original, draft),
              simplified,
              editedFilterFields(original, draft),
            );
            if (conflict !== undefined) throw new SimplifiedConflictError(conflict);
          }

          await this.assertDisarmed(key, client, epoch, requester, acquisition, identity);
          const writes = encodeChangedPidTuning(original, draft);
          const wroteFilters = writes.some(write => write.group === 'FILTER_CONFIG');
          // A filter write runs validateAndFixGyroConfig, which can move
          // truths outside this screen. Predicting them EXACTLY needs
          // useDshotTelemetry, which lives on MSP_MOTOR_CONFIG and nothing
          // else here reads - so it is read once, here, and only when a
          // filter write is actually about to happen.
          const advancedBefore = wroteFilters ? advancedWitness(fresh) : undefined;
          const sideEffectProjection = wroteFilters
            ? projectGyroValidation({
              gyroSampleRateHz,
              pidProcessDenom: fresh.pidProcessDenom ?? 0,
              useContinuousUpdate: (fresh.useContinuousUpdate ?? 0) !== 0,
              motorProtocolRaw: fresh.motorProtocolRaw ?? 0,
              motorPwmRate: fresh.motorPwmRate ?? 0,
              useDshotTelemetry: await this.readDshotTelemetry(requester),
            })
            : undefined;
          const ledger = new MutationLedger<PidWriteStage>();
          for (const write of writes) await this.writeOnce(requester, COMMAND_FOR_GROUP[write.group], write.payload, write.group, key, client, epoch, ledger);

          // APPLIED proof, per group, per field.
          const applied = await this.readSnapshot(requester, contract, gyroSampleRateHz);
          const verdicts = classifySaveGroups(contract, original, applied, writes);
          const failed = verdicts.find(entry => entry.verdict.kind === 'MISMATCH');
          if (failed !== undefined && failed.verdict.kind === 'MISMATCH') {
            return {mismatch: {group: failed.group, fields: failed.verdict.fields}};
          }

          // A filter write can move truths this screen does not own. Every
          // one of them is compared against the EXACT projected value; a
          // change nothing predicts stops the save, and a change MSP cannot
          // let us predict stops it too rather than being blessed.
          let sideEffects: CrossSubsystemReport | undefined;
          if (advancedBefore !== undefined && sideEffectProjection !== undefined) {
            sideEffects = classifyGyroValidationSideEffects(
              advancedBefore, sideEffectProjection, advancedWitness(applied),
            );
            if (sideEffects.unexpected.length > 0) return {unexpected: sideEffects};
            if (sideEffects.notProven.length > 0) return {notProven: sideEffects};
          }

          const normalisations = verdicts.flatMap(entry =>
            entry.verdict.kind === 'NORMALISED' ? entry.verdict.fields : []);
          const evidence: PidWriteEvidence = {normalisations, ...(sideEffects === undefined ? {} : {sideEffects})};

          /* PERSISTENCE NEVER FOLLOWS LOST LIVENESS. */
          await this.writeOnce(requester, MSP_EEPROM_WRITE, EMPTY, 'EEPROM', key, client, epoch, ledger);
          // EEPROM acknowledging is not persistence. Read it back.
          try {
            const persisted = await this.readSnapshot(requester, contract, gyroSampleRateHz);
            const persistedVerdicts = classifySaveGroups(contract, original, persisted, writes);
            if (persistedVerdicts.some(entry => entry.verdict.kind === 'MISMATCH')) {
              return {appliedOnly: {snapshot: applied, evidence, error: new Error('Persisted PID readback does not match the applied state.')}};
            }
            return {saved: {snapshot: persisted, evidence}};
          } catch (error) {
            return {appliedOnly: {snapshot: applied, evidence, error}};
          }
        },
      });
      if (result.status === 'SUCCEEDED') return saveOutcomeFrom(result.result);
      if (result.status === 'OUTCOME_UNKNOWN') {
        if (!ambiguousCause(result.reason)) return {kind: 'SESSION_ENDED'};
        if (result.reason.partial) return {kind: 'PARTIAL_UNPERSISTED', confirmedStages: result.reason.confirmedStages, failedStage: result.reason.stage, definitelyNotSent: result.reason.definitelyNotSent};
        return {kind: 'UNCONFIRMED', stage: result.reason.stage, confirmedStages: result.reason.confirmedStages};
      }
      if (result.status === 'SESSION_ENDED') return {kind: 'SESSION_ENDED'};
      if (result.error instanceof SimplifiedConflictError) {
        return {kind: 'REJECTED', reason: 'DIRECT_EDIT_CONFLICTS_WITH_ACTIVE_SIMPLIFIED', conflict: result.error.conflict};
      }
      return result.error instanceof PidPreflightError ? {kind: 'REJECTED', reason: result.error.reason} : {kind: 'FAILED', error: result.error};
    } finally { interlock.release(); }
  }

  /**
   * WRITES THE SLIDERS, AND VERIFIES WHAT THE FIRMWARE GENERATED FROM THEM.
   *
   * MSP_SET_SIMPLIFIED_TUNING is not a settings write with a readback: the
   * board stores the thirteen inputs AND then regenerates the PID gains, D
   * Max, feedforward and filter frequencies from COMPILE-TIME DEFAULTS. So a
   * successful save has to prove two different things - that the inputs
   * echo, and that the generated outputs match what our own reimplementation
   * of the generator predicts. An input echo alone would only prove the
   * board filed the sliders.
   *
   * MSP_VALIDATE_SIMPLIFIED_TUNING is collected as evidence and is NOT the
   * verification: it compares the stored values against a TEMPORARY copy, so
   * it answers a related question rather than this one.
   */
  async saveSimplified(
    key: SetupUiSessionKey,
    original: MspPidTuningSnapshot,
    patch: SimplifiedTuningPatch,
  ): Promise<PidSimplifiedSaveOutcome> {
    const captured = this.capture(key, 'WRITE'); if ('reason' in captured) return {kind: 'REJECTED', reason: captured.reason};
    const {client, scheduler, epoch, gyroSampleRateHz, contract} = captured; let interlock;
    try { interlock = acquireMotorConfigurationInterlock(client); }
    catch (error) { return error instanceof MotorConfigurationTransactionInProgressError ? {kind: 'REJECTED', reason: 'CONFIGURATION_BUSY'} : {kind: 'FAILED', error}; }
    try {
      const acquisition = this.boxIdsFor(key.sessionId, client); const identity: BoxIdsOwnerIdentity = {physicalGeneration: key.generation, mspEpoch: epoch};
      const result = await this.operations(key.sessionId, client, scheduler).execute<SimplifiedInternal>({
        id: `pid:simplified:${key.sessionId}:${key.generation}`, sessionEffect: 'KEEP_SESSION',
        validate: context => context.clientState === 'READY' ? {allowed: true} : {allowed: false, error: new PidPreflightError('LINK_RECOVERING')},
        execute: async requester => {
          this.assertLive(key, client, epoch);
          const fresh = await this.readSnapshot(requester, contract, gyroSampleRateHz);
          assertSameProfile(original, fresh);
          const observed = await this.readSimplifiedIfSupported(requester);
          if (observed === undefined) throw new PidPreflightError('SIMPLIFIED_TUNING_UNSUPPORTED');
          const payload = encodeSimplifiedTuning(observed, patch);
          if (payload.every((byte, index) => byte === observed.raw[index])) return {unchanged: fresh};

          await this.assertDisarmed(key, client, epoch, requester, acquisition, identity);

          // The board's own calculator, consulted BEFORE anything is stored.
          // If it disagrees with our generator we have no business writing a
          // tune we cannot predict, so the transaction ends here.
          const requested = decodeSimplifiedTuning(payload);
          const oracle = await this.consultProjectionOracle(requester, requested, payload);
          if (oracle.kind === 'ORACLE_DISAGREES') throw new PidPreflightError('SIMPLIFIED_PROJECTION_ORACLE_DISAGREES');

          await this.writeOnce(requester, MSP_SET_SIMPLIFIED_TUNING, payload, 'SIMPLIFIED', key, client, epoch);

          const applied = await this.observeSimplified(requester, gyroSampleRateHz, contract, requested);
          if (applied.verdict.kind === 'MISMATCH') return {mismatch: {fields: applied.verdict.fields}};
          const validity = await this.readSimplifiedValidity(requester);
          const evidence: PidWriteEvidence = {
            normalisations: applied.verdict.kind === 'NORMALISED' ? applied.verdict.fields : [],
            ...(validity === undefined ? {} : {simplifiedValidity: validity}),
            projectionOracle: oracle,
          };

          /* PERSISTENCE NEVER FOLLOWS LOST LIVENESS. */
          await this.writeOnce(requester, MSP_EEPROM_WRITE, EMPTY, 'EEPROM', key, client, epoch);
          try {
            const persisted = await this.observeSimplified(requester, gyroSampleRateHz, contract, requested);
            if (persisted.verdict.kind === 'MISMATCH') {
              return {appliedOnly: {snapshot: applied.snapshot, evidence, error: new Error('Persisted simplified readback does not match the applied state.')}};
            }
            return {saved: {snapshot: persisted.snapshot, evidence}};
          } catch (error) {
            return {appliedOnly: {snapshot: applied.snapshot, evidence, error}};
          }
        },
      });
      if (result.status === 'SUCCEEDED') {
        const internal = result.result;
        if ('unchanged' in internal) return {kind: 'NO_CHANGES', snapshot: internal.unchanged};
        if ('saved' in internal) return {kind: 'SAVED_VERIFIED', ...internal.saved};
        if ('appliedOnly' in internal) return {kind: 'APPLIED_PERSISTENCE_UNVERIFIED', ...internal.appliedOnly};
        return {kind: 'READBACK_MISMATCH', fields: internal.mismatch.fields};
      }
      if (result.status === 'OUTCOME_UNKNOWN') return {kind: 'UNCONFIRMED'};
      if (result.status === 'SESSION_ENDED') return {kind: 'SESSION_ENDED'};
      return result.error instanceof PidPreflightError ? {kind: 'REJECTED', reason: result.error.reason} : {kind: 'FAILED', error: result.error};
    } finally { interlock.release(); }
  }

  /**
   * READS THE SIMPLIFIED STATE OF THE ACTIVE PID PROFILE.
   *
   * A plain read, so it takes the READ intent and works on a future API.
   * The board's own VALIDATE opinion travels alongside as evidence, never
   * as the answer to whether the sliders match what is stored.
   */
  async loadSimplified(key: SetupUiSessionKey): Promise<PidSimplifiedLoadOutcome> {
    const captured = this.capture(key); if ('reason' in captured) return {kind: 'REJECTED', reason: captured.reason};
    const {client, scheduler, epoch} = captured;
    const result = await this.operations(key.sessionId, client, scheduler).execute<PidSimplifiedLoadOutcome>({
      id: `pid:simplified:read:${key.sessionId}:${key.generation}`, sessionEffect: 'KEEP_SESSION',
      validate: context => context.clientState === 'READY' ? {allowed: true} : {allowed: false, error: new PidPreflightError('LINK_RECOVERING')},
      execute: async requester => {
        this.assertLive(key, client, epoch);
        const simplified = await this.readSimplifiedIfSupported(requester);
        if (simplified === undefined) return {kind: 'UNSUPPORTED'};
        const validity = await this.readSimplifiedValidity(requester);
        return {kind: 'LOADED', simplified, ...(validity === undefined ? {} : {validity})};
      },
    });
    if (result.status === 'SUCCEEDED') return result.result;
    if (result.status === 'OUTCOME_UNKNOWN' || result.status === 'SESSION_ENDED') return {kind: 'SESSION_ENDED'};
    return result.error instanceof PidPreflightError ? {kind: 'REJECTED', reason: result.error.reason} : {kind: 'FAILED', error: result.error};
  }

  /**
   * CHANGES WHICH RATE FORMULA THE ACTIVE RATE PROFILE USES.
   *
   * `rates_type` selects between the five formulas in `fc/rc.c`. It converts
   * nothing: the RC rate, super rate, expo and limits already stored keep
   * their numbers and acquire a new meaning. So this writes ONE byte of the
   * twenty-four and proves that the other twenty-three came back untouched -
   * a controller that "helpfully" rescaled them would be choosing a pilot's
   * rates for them, and no firmware behaviour asks for that.
   *
   * A type outside the five is refused before the wire. There is no
   * normalisation: an unknown formula is not a formula.
   */
  async setRatesType(key: SetupUiSessionKey, original: MspPidTuningSnapshot, ratesTypeRaw: number): Promise<PidRatesTypeOutcome> {
    if (!isEncodableRatesType(ratesTypeRaw)) return {kind: 'REJECTED', reason: 'UNKNOWN_RATES_TYPE'};
    const captured = this.capture(key, 'WRITE'); if ('reason' in captured) return {kind: 'REJECTED', reason: captured.reason};
    const {client, scheduler, epoch, gyroSampleRateHz, contract} = captured; let interlock;
    try { interlock = acquireMotorConfigurationInterlock(client); }
    catch (error) { return error instanceof MotorConfigurationTransactionInProgressError ? {kind: 'REJECTED', reason: 'CONFIGURATION_BUSY'} : {kind: 'FAILED', error}; }
    try {
      const acquisition = this.boxIdsFor(key.sessionId, client); const identity: BoxIdsOwnerIdentity = {physicalGeneration: key.generation, mspEpoch: epoch};
      const result = await this.operations(key.sessionId, client, scheduler).execute<RatesTypeInternal>({
        id: `pid:ratesType:${key.sessionId}:${key.generation}`, sessionEffect: 'KEEP_SESSION',
        validate: context => context.clientState === 'READY' ? {allowed: true} : {allowed: false, error: new PidPreflightError('LINK_RECOVERING')},
        execute: async requester => {
          this.assertLive(key, client, epoch);
          const fresh = await this.readSnapshot(requester, contract, gyroSampleRateHz);
          assertSameProfile(original, fresh);
          if (fresh.ratesRaw[RC_TUNING_OFFSETS.ratesType] === ratesTypeRaw) return {unchanged: fresh};

          await this.assertDisarmed(key, client, epoch, requester, acquisition, identity);
          const payload = encodeRcTuningRatesType(fresh.ratesRaw, ratesTypeRaw);
          await this.writeOnce(requester, MSP_SET_RC_TUNING, payload, 'RC_TUNING', key, client, epoch);

          const applied = await this.readSnapshot(requester, contract, gyroSampleRateHz);
          const drift = ratesTypeWriteDifferences(fresh, applied, ratesTypeRaw);
          if (drift.length > 0) return {mismatch: {fields: drift}};

          /* PERSISTENCE NEVER FOLLOWS LOST LIVENESS. */
          await this.writeOnce(requester, MSP_EEPROM_WRITE, EMPTY, 'EEPROM', key, client, epoch);
          try {
            const persisted = await this.readSnapshot(requester, contract, gyroSampleRateHz);
            const persistedDrift = ratesTypeWriteDifferences(fresh, persisted, ratesTypeRaw);
            if (persistedDrift.length > 0) {
              return {appliedOnly: {snapshot: applied, error: new Error('Persisted rates type does not match the applied state.')}};
            }
            return {persisted: {snapshot: persisted, ratesTypeRaw}};
          } catch (error) {
            return {appliedOnly: {snapshot: applied, error}};
          }
        },
      });
      if (result.status === 'SUCCEEDED') {
        const internal = result.result;
        if ('unchanged' in internal) return {kind: 'NO_CHANGES', snapshot: internal.unchanged};
        if ('persisted' in internal) return {kind: 'PERSISTED_VERIFIED', ...internal.persisted};
        if ('appliedOnly' in internal) return {kind: 'APPLIED_PERSISTENCE_UNVERIFIED', ...internal.appliedOnly};
        return {kind: 'READBACK_MISMATCH', fields: internal.mismatch.fields};
      }
      if (result.status === 'OUTCOME_UNKNOWN') return {kind: 'UNCONFIRMED'};
      if (result.status === 'SESSION_ENDED') return {kind: 'SESSION_ENDED'};
      return result.error instanceof PidPreflightError ? {kind: 'REJECTED', reason: result.error.reason} : {kind: 'FAILED', error: result.error};
    } finally { interlock.release(); }
  }

  /**
   * Ask the board what OUR generator's inputs would produce, on its own
   * temporary copy of the profile.
   *
   * MSP_CALCULATE_SIMPLIFIED_PID stores nothing - `simplified_tuning.c` runs
   * the generator against a scratch profile and serialises the result - so
   * this can corroborate the reimplementation and can never substitute for
   * reading back what was actually stored.
   */
  private async consultProjectionOracle(
    requester: MspRequester,
    requested: MspSimplifiedTuning,
    requestedPayload: Uint8Array,
  ): Promise<SimplifiedProjectionOracle> {
    let calculated: readonly CalculatedPidfAxis[];
    try {
      // `readSimplifiedPids(&tempPidProfile, src)` - the sliders travel in
      // the REQUEST, so the board answers about the tune we are proposing
      // rather than the one it already holds.
      const frame = await requester.request(
        MSP_CALCULATE_SIMPLIFIED_PID,
        requestedPayload.slice(0, SIMPLIFIED_PID_BLOCK_BYTES),
        {wireFormat: 'v1'},
      );
      calculated = decodeCalculatedPidfs(frame.payload);
    } catch { return {kind: 'ORACLE_UNAVAILABLE'}; }
    const ours = projectSimplifiedWrite(requested);
    const axes = ['ROLL', 'PITCH', 'YAW'] as const;
    const fields: FieldComparison[] = [];
    ours.axes.forEach((axis, index) => {
      const board = calculated[index];
      if (board === undefined) return;
      const compare = (name: string, want: number, got: number): void => {
        if (want !== got) fields.push({field: `${axes[index]}.${name}`, verdict: {kind: 'MISMATCH', requested: want, expected: want, observed: got}});
      };
      compare('P', axis.p, board.p);
      compare('I', axis.i, board.i);
      compare('D', axis.d, board.d);
      compare('D_MAX', axis.dMax, board.dMax);
      compare('F', axis.f, board.f);
    });
    return fields.length === 0 ? {kind: 'ORACLE_AGREES'} : {kind: 'ORACLE_DISAGREES', fields};
  }

  /** One read of everything a simplified write touches, already classified. */
  private async observeSimplified(
    requester: MspRequester,
    gyroSampleRateHz: number | undefined,
    contract: PidApiContract,
    requested: MspSimplifiedTuning,
  ): Promise<{snapshot: MspPidTuningSnapshot; verdict: GroupVerdict}> {
    const snapshot = await this.readSnapshot(requester, contract, gyroSampleRateHz);
    const observedSimplified = await this.readSimplifiedIfSupported(requester);
    if (observedSimplified === undefined) throw new Error('MSP_SIMPLIFIED_TUNING stopped answering mid-save.');
    return {
      snapshot,
      verdict: classifySimplifiedReadback({
        requested,
        observedSimplified,
        observedPid: snapshot.pidRaw,
        observedAdvanced: decodePidAdvancedFull(snapshot.advancedRaw, contract),
        observedFilters: decodeFilterConfigFull(snapshot.filtersRaw, contract),
      }),
    };
  }

  /** The firmware's own opinion, as evidence. Never as the verification. */
  private async readSimplifiedValidity(requester: MspRequester): Promise<SimplifiedTuningValidity | undefined> {
    try {
      const frame = await requester.request(MSP_VALIDATE_SIMPLIFIED_TUNING, EMPTY, {wireFormat: 'v1'});
      return decodeSimplifiedTuningValidity(frame.payload);
    } catch { return undefined; }
  }

  /**
   * COPIES ONE PROFILE ONTO ANOTHER, AND PROVES IT LANDED.
   *
   * Three source facts shape this whole method.
   *
   * The payload is `[type, DESTINATION, SOURCE]` - destination before
   * source - so the encoder takes named fields and this method never builds
   * a positional pair.
   *
   * The firmware runs NO re-initialisation after the memcpy, so copying onto
   * the profile that is currently running leaves the stored configuration and
   * the running behaviour disagreeing until something else re-inits. The
   * firmware permits it; this refuses it. That is a PRODUCT policy and is
   * named as one - it is not a claim about what the firmware does.
   *
   * And a profile that is not active cannot be read at all: MSP_PID and
   * friends answer for the active profile only. So proving the copy means
   * visiting the destination and coming back, which is why the ORDER here is
   * deliberate:
   *
   *   read source (switching to it only if it is not already active)
   *   copy
   *   switch to destination, read, compare byte for byte
   *   switch BACK, and prove the board really is back
   *   only then MSP_EEPROM_WRITE
   *
   * The commit is last because committing while parked on the destination
   * would persist a selected profile the operator never chose. And if the
   * restore cannot be proven, the outcome says so loudly rather than
   * returning success and leaving the aircraft on another tune.
   */
  async copyProfile(key: SetupUiSessionKey, request: CopyProfileRequest): Promise<PidProfileCopyOutcome> {
    const captured = this.capture(key, 'WRITE'); if ('reason' in captured) return {kind: 'REJECTED', reason: captured.reason};
    const {client, scheduler, epoch, gyroSampleRateHz, contract} = captured; let interlock;
    try { interlock = acquireMotorConfigurationInterlock(client); }
    catch (error) { return error instanceof MotorConfigurationTransactionInProgressError ? {kind: 'REJECTED', reason: 'CONFIGURATION_BUSY'} : {kind: 'FAILED', error}; }
    try {
      const acquisition = this.boxIdsFor(key.sessionId, client); const identity: BoxIdsOwnerIdentity = {physicalGeneration: key.generation, mspEpoch: epoch};
      const result = await this.operations(key.sessionId, client, scheduler).execute<CopyInternal>({
        id: `pid:copy:${request.kind}:${key.sessionId}:${key.generation}`, sessionEffect: 'KEEP_SESSION',
        validate: context => context.clientState === 'READY' ? {allowed: true} : {allowed: false, error: new PidPreflightError('LINK_RECOVERING')},
        execute: async requester => {
          this.assertLive(key, client, epoch);
          const before = await this.readSnapshot(requester, contract, gyroSampleRateHz);
          const home = request.kind === 'RATE' ? before.controlRateProfileIndex : before.pidProfileIndex;
          const projected = projectCopyProfile(request, home);
          if (projected.kind !== 'COPIED') throw new PidPreflightError('INVALID_CONFIGURATION');
          if (projected.writesActiveProfile) throw new PidPreflightError('ACTIVE_DESTINATION_COPY_UNSAFE');

          await this.assertDisarmed(key, client, epoch, requester, acquisition, identity);
          const source = request.sourceIndex === home
            ? before
            : await this.visitProfile(requester, gyroSampleRateHz, contract, request.kind, request.sourceIndex);
          if (source === undefined) return {leftOnAnotherProfile: {requestedIndex: request.sourceIndex, activeIndex: home}};

          await this.writeOnce(requester, MSP_COPY_PROFILE, encodeCopyProfile(request), 'COPY_PROFILE', key, client, epoch);

          const destination = await this.visitProfile(requester, gyroSampleRateHz, contract, request.kind, request.destinationIndex);
          const restored = await this.visitProfile(requester, gyroSampleRateHz, contract, request.kind, home);
          if (restored === undefined) {
            const active = await this.readSnapshot(requester, contract, gyroSampleRateHz);
            return {leftOnAnotherProfile: {
              requestedIndex: home,
              activeIndex: request.kind === 'RATE' ? active.controlRateProfileIndex : active.pidProfileIndex,
            }};
          }
          if (destination === undefined) return {leftOnAnotherProfile: {requestedIndex: request.destinationIndex, activeIndex: home}};

          const fields = copiedProfileDifferences(request.kind, source, destination);
          if (fields.length > 0) return {mismatch: {destinationIndex: request.destinationIndex, fields}};

          // Only now, with the operator's own profile selected again.
          /* PERSISTENCE NEVER FOLLOWS LOST LIVENESS. */
          await this.writeOnce(requester, MSP_EEPROM_WRITE, EMPTY, 'EEPROM', key, client, epoch);
          const after = await this.readSnapshot(requester, contract, gyroSampleRateHz);
          const stillHome = (request.kind === 'RATE' ? after.controlRateProfileIndex : after.pidProfileIndex) === home;
          if (!stillHome) {
            return {leftOnAnotherProfile: {
              requestedIndex: home,
              activeIndex: request.kind === 'RATE' ? after.controlRateProfileIndex : after.pidProfileIndex,
            }};
          }
          return {copied: {snapshot: after, sourceIndex: request.sourceIndex, destinationIndex: request.destinationIndex}};
        },
      });
      if (result.status === 'SUCCEEDED') {
        const internal = result.result;
        if ('copied' in internal) return {kind: 'COPIED_VERIFIED', ...internal.copied};
        if ('mismatch' in internal) return {kind: 'COPY_MISMATCH', ...internal.mismatch};
        return {kind: 'LEFT_ON_ANOTHER_PROFILE', ...internal.leftOnAnotherProfile};
      }
      if (result.status === 'OUTCOME_UNKNOWN') return {kind: 'UNCONFIRMED'};
      if (result.status === 'SESSION_ENDED') return {kind: 'SESSION_ENDED'};
      return result.error instanceof PidPreflightError ? {kind: 'REJECTED', reason: result.error.reason} : {kind: 'FAILED', error: result.error};
    } finally { interlock.release(); }
  }

  /**
   * Select a profile and read it, returning `undefined` when the board did
   * NOT end up on the index that was asked for.
   *
   * The firmware silently coerces an out-of-range index to zero and silently
   * ignores a PID switch while armed, in both cases with an ordinary
   * acknowledgement, so the reply proves nothing and the index in
   * MSP_STATUS_EX is the only authority.
   */
  private async visitProfile(
    requester: MspRequester,
    gyroSampleRateHz: number | undefined,
    contract: PidApiContract,
    kind: PidProfileKind,
    index: number,
  ): Promise<MspPidTuningSnapshot | undefined> {
    await this.writeOnce(requester, MSP_SELECT_SETTING, encodeSelectSetting(kind, index), 'SELECT_PROFILE');
    const snapshot = await this.readSnapshot(requester, contract, gyroSampleRateHz);
    const active = kind === 'RATE' ? snapshot.controlRateProfileIndex : snapshot.pidProfileIndex;
    return active === index ? snapshot : undefined;
  }

  /**
   * RESETS THE ACTIVE PID PROFILE TO FIRMWARE DEFAULTS - IN RAM ONLY.
   *
   * MSP_SET_RESET_CURR_PID (219) touches the current PID profile and nothing
   * else, persists nothing and reboots nothing. So this deliberately does NOT
   * follow it with MSP_EEPROM_WRITE: the operator gets the defaults to fly or
   * discard, and saving them is a separate, explicit act.
   *
   * It is emphatically NOT MSP_RESET_CONF (208), which wipes the entire
   * configuration and reboots. That id is not imported by this file.
   */
  async resetPidProfile(key: SetupUiSessionKey): Promise<PidProfileResetOutcome> {
    const captured = this.capture(key, 'WRITE'); if ('reason' in captured) return {kind: 'REJECTED', reason: captured.reason};
    const {client, scheduler, epoch, gyroSampleRateHz, contract} = captured; let interlock;
    try { interlock = acquireMotorConfigurationInterlock(client); }
    catch (error) { return error instanceof MotorConfigurationTransactionInProgressError ? {kind: 'REJECTED', reason: 'CONFIGURATION_BUSY'} : {kind: 'FAILED', error}; }
    try {
      const acquisition = this.boxIdsFor(key.sessionId, client); const identity: BoxIdsOwnerIdentity = {physicalGeneration: key.generation, mspEpoch: epoch};
      const request = pidProfileResetRequest();
      const result = await this.operations(key.sessionId, client, scheduler).execute<{
        snapshot: MspPidTuningSnapshot;
        fields: readonly FieldComparison[];
        evidence: {
          readonly verifiedScope: readonly PidResetResource[];
          readonly verificationGaps: readonly PidResetVerificationGap[];
        };
      }>({
        id: `pid:reset:${key.sessionId}:${key.generation}`, sessionEffect: 'KEEP_SESSION',
        validate: context => context.clientState === 'READY' ? {allowed: true} : {allowed: false, error: new PidPreflightError('LINK_RECOVERING')},
        execute: async requester => {
          this.assertLive(key, client, epoch);
          await this.assertDisarmed(key, client, epoch, requester, acquisition, identity);
          await this.writeOnce(requester, MSP_SET_RESET_CURR_PID, encodePidProfileReset(), 'RESET_PID_PROFILE', key, client, epoch);
          // The reset rewrites the name and the simplified sliders too, so
          // both are read back rather than left to an assumption.
          const snapshot = await this.readSnapshot(requester, contract, gyroSampleRateHz);
          const name = await this.observeNameForReset(requester);
          const simplified = await this.observeSimplifiedForReset(requester);
          const observation: ResetObservation = {snapshot, name, simplified};
          return {
            snapshot,
            fields: pidProfileDefaultDifferences(observation, contract),
            evidence: pidResetEvidence(observation),
          };
        },
      });
      if (result.status === 'SUCCEEDED') {
        return result.result.fields.length > 0
          ? {kind: 'READBACK_MISMATCH', fields: result.result.fields}
          : {
            kind: 'RESET_APPLIED_PARTIALLY_VERIFIED',
            snapshot: result.result.snapshot,
            persists: request.persists,
            verifiedScope: result.result.evidence.verifiedScope,
            verificationGaps: result.result.evidence.verificationGaps,
          };
      }
      if (result.status === 'OUTCOME_UNKNOWN') return {kind: 'UNCONFIRMED'};
      if (result.status === 'SESSION_ENDED') return {kind: 'SESSION_ENDED'};
      return result.error instanceof PidPreflightError ? {kind: 'REJECTED', reason: result.error.reason} : {kind: 'FAILED', error: result.error};
    } finally { interlock.release(); }
  }

  /**
   * READS THE ACTIVE PROFILE'S NAME.
   *
   * Both text selectors resolve through `currentPidProfile` and
   * `currentControlRateProfile`, so this can only ever answer for the profile
   * that is active right now - naming a different one means switching to it
   * first, and that is the caller's decision to make explicitly.
   */
  async readProfileName(key: SetupUiSessionKey, kind: PidProfileKind): Promise<PidProfileNameOutcome> {
    const captured = this.capture(key); if ('reason' in captured) return {kind: 'REJECTED', reason: captured.reason};
    const {client, scheduler, epoch} = captured;
    const result = await this.operations(key.sessionId, client, scheduler).execute<string>({
      id: `pid:name:read:${kind}:${key.sessionId}:${key.generation}`, sessionEffect: 'KEEP_SESSION',
      validate: context => context.clientState === 'READY' ? {allowed: true} : {allowed: false, error: new PidPreflightError('LINK_RECOVERING')},
      execute: async requester => { this.assertLive(key, client, epoch); return this.readName(requester, kind); },
    });
    if (result.status === 'SUCCEEDED') return {kind: 'NAME', profile: kind, name: result.result};
    if (result.status === 'OUTCOME_UNKNOWN' || result.status === 'SESSION_ENDED') return {kind: 'SESSION_ENDED'};
    return result.error instanceof PidPreflightError ? {kind: 'REJECTED', reason: result.error.reason} : {kind: 'FAILED', error: result.error};
  }

  /**
   * NAMES THE ACTIVE PROFILE, THEN READS THE NAME BACK BEFORE COMMITTING.
   *
   * The firmware takes `MIN(textSpace, length)` and acknowledges, so a
   * nine-character name would be silently stored as eight and reported as a
   * success. The encoder refuses over-long names before the wire; the
   * readback catches everything else.
   */
  async setProfileName(key: SetupUiSessionKey, kind: PidProfileKind, name: string): Promise<PidProfileNameOutcome> {
    let payload: Uint8Array;
    try { payload = encodeSetProfileName(kind, name); }
    catch { return {kind: 'REJECTED', reason: 'INVALID_CONFIGURATION'}; }
    const captured = this.capture(key, 'WRITE'); if ('reason' in captured) return {kind: 'REJECTED', reason: captured.reason};
    const {client, scheduler, epoch} = captured; let interlock;
    try { interlock = acquireMotorConfigurationInterlock(client); }
    catch (error) { return error instanceof MotorConfigurationTransactionInProgressError ? {kind: 'REJECTED', reason: 'CONFIGURATION_BUSY'} : {kind: 'FAILED', error}; }
    try {
      const acquisition = this.boxIdsFor(key.sessionId, client); const identity: BoxIdsOwnerIdentity = {physicalGeneration: key.generation, mspEpoch: epoch};
      const result = await this.operations(key.sessionId, client, scheduler).execute<{applied: string; persisted: string}>({
        id: `pid:name:write:${kind}:${key.sessionId}:${key.generation}`, sessionEffect: 'KEEP_SESSION',
        validate: context => context.clientState === 'READY' ? {allowed: true} : {allowed: false, error: new PidPreflightError('LINK_RECOVERING')},
        execute: async requester => {
          this.assertLive(key, client, epoch);
          await this.assertDisarmed(key, client, epoch, requester, acquisition, identity);
          await this.writeOnce(requester, MSP2_SET_TEXT, payload, 'PROFILE_NAME', key, client, epoch);
          const applied = await this.readName(requester, kind);
          if (applied !== name) return {applied, persisted: applied};
          /* PERSISTENCE NEVER FOLLOWS LOST LIVENESS. */
          await this.writeOnce(requester, MSP_EEPROM_WRITE, EMPTY, 'EEPROM', key, client, epoch);
          return {applied, persisted: await this.readName(requester, kind)};
        },
      });
      if (result.status === 'SUCCEEDED') {
        const {applied, persisted} = result.result;
        return applied === name && persisted === name
          ? {kind: 'NAMED_VERIFIED', profile: kind, name: persisted}
          : {kind: 'NAME_MISMATCH', profile: kind, requested: name, observed: persisted};
      }
      if (result.status === 'OUTCOME_UNKNOWN') return {kind: 'UNCONFIRMED'};
      if (result.status === 'SESSION_ENDED') return {kind: 'SESSION_ENDED'};
      return result.error instanceof PidPreflightError ? {kind: 'REJECTED', reason: result.error.reason} : {kind: 'FAILED', error: result.error};
    } finally { interlock.release(); }
  }

  private async readName(requester: MspRequester, kind: PidProfileKind): Promise<string> {
    const frame = await requester.request(MSP2_GET_TEXT, encodeGetProfileName(kind), {wireFormat: 'v2'});
    const decoded = decodeMspText(frame.payload);
    const selector = kind === 'PID' ? MSP2TEXT_PID_PROFILE_NAME : MSP2TEXT_RATE_PROFILE_NAME;
    if (decoded.type !== selector) {
      throw new Error(`MSP2_GET_TEXT answered for selector ${decoded.type}, expected ${selector}.`);
    }
    return decoded.value;
  }

  /**
   * `useDshotTelemetry`, from MSP_MOTOR_CONFIG.
   *
   * The PID page owns none of that command, and reads exactly one byte of
   * it: the flag that decides whether the unpredictable branch of
   * `validateAndFixGyroConfig` can fire at all. A board that will not answer
   * is treated as TELEMETRY ON, which is the conservative reading - it makes
   * the side effects unprovable rather than confidently predicted.
   */
  private async readDshotTelemetry(requester: MspRequester): Promise<boolean> {
    try {
      const frame = await requester.request(MSP_MOTOR_CONFIG, EMPTY, {wireFormat: 'v1'});
      return decodeMotorConfig(frame.payload).dshotTelemetryRaw !== 0;
    } catch { return true; }
  }

  /**
   * MSP_SIMPLIFIED_TUNING, or `undefined` when the board does not implement
   * it at all. The command family is absent without USE_SIMPLIFIED_TUNING,
   * so a refusal here is real evidence about the build - unlike a zero in a
   * field, which proves nothing.
   */
  private async readSimplifiedIfSupported(requester: MspRequester): Promise<MspSimplifiedTuning | undefined> {
    try {
      const frame = await requester.request(MSP_SIMPLIFIED_TUNING, EMPTY, {wireFormat: 'v1'});
      return decodeSimplifiedTuning(frame.payload);
    } catch { return undefined; }
  }

  /**
   * THE RESET'S OWN PROFILE-NAME OBSERVATION.
   *
   * Separate from `readName` because the reset needs a different ANSWER
   * SHAPE, not different wire behaviour: it has to be able to say "the read
   * did not answer" as a fact of its own, rather than collapsing that into
   * a missing value that later reads as agreement.
   */
  private async observeNameForReset(requester: MspRequester): Promise<ResetObserved<string>> {
    try { return {kind: 'OBSERVED', value: await this.readName(requester, 'PID')}; }
    catch { return {kind: 'READ_FAILED'}; }
  }

  /**
   * THE RESET'S OWN SIMPLIFIED-TUNING OBSERVATION.
   *
   * `readSimplifiedIfSupported` is deliberately left alone. Its four other
   * call sites - `save`, `saveSimplified`, `loadSimplified` and
   * `observeSimplified` - use `undefined` to mean "do not apply the generator
   * rules here", which is the right answer for them; only the reset needs to
   * distinguish a read that failed from a resource it may claim it checked.
   */
  private async observeSimplifiedForReset(requester: MspRequester): Promise<ResetObserved<MspSimplifiedTuning>> {
    try {
      const frame = await requester.request(MSP_SIMPLIFIED_TUNING, EMPTY, {wireFormat: 'v1'});
      return {kind: 'OBSERVED', value: decodeSimplifiedTuning(frame.payload)};
    } catch { return {kind: 'READ_FAILED'}; }
  }

  /**
   * THE SINGLE FUNNEL EVERY MUTATION PASSES THROUGH.
   *
   * U-R1. When the caller supplies the session identity, liveness is
   * asserted HERE - in the same synchronous turn as the request it
   * authorises - so a flight controller that restarted mid-sequence
   * never receives the rest of it, and above all never receives the
   * EEPROM write. Every PID operation that persists passes it.
   *
   * The ledger is supplied by the operations that also REPORT partial
   * application; where it is absent the safety behaviour is identical
   * and the result vocabulary is the pre-existing one.
   */
  private async writeOnce(requester: MspRequester, command: number, payload: Uint8Array, stage: PidWriteStage, key?: SetupUiSessionKey, client?: PidClient, epoch?: number, ledger?: MutationLedger<PidWriteStage>): Promise<void> {
    if (key !== undefined && client !== undefined && epoch !== undefined) {
      try { this.assertLive(key, client, epoch); }
      catch (error) {
        if (ledger === undefined || !ledger.hasMutated) throw error;
        throw new AmbiguousPidWriteError(new MutationStoppedError(stage, ledger.acknowledgedStages, error), stage, ledger.acknowledgedStages, true, true);
      }
    }
    try { await requester.request(command, payload, {wireFormat: 'v1'}); }
    catch (error) {
      const code = errorCode(error);
      const confirmed = ledger?.acknowledgedStages ?? [];
      if (code !== undefined && DEFINITELY_NOT_SENT.has(code)) {
        if (ledger === undefined || !ledger.hasMutated) throw error;
        throw new AmbiguousPidWriteError(error, stage, confirmed, true, true);
      }
      throw new AmbiguousPidWriteError(error, stage, confirmed, false, false);
    }
    ledger?.acknowledge(stage);
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
    const {client, scheduler, epoch, gyroSampleRateHz, contract} = captured;
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
          return this.readSnapshot(requester, contract, gyroSampleRateHz);
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

  /**
   * `intent` decides how a firmware newer than anything we have read is
   * treated. A READ may still be attempted against a known prefix, because
   * refusing to show a pilot their tune helps nobody. A WRITE never is: the
   * meanings inside a 61-byte structure and the length of FILTER_CONFIG
   * would both be guesses, and this app does not guess with a payload that
   * changes how an aircraft flies.
   */
  private capture(
    key: SetupUiSessionKey,
    intent: 'READ' | 'WRITE' = 'READ',
  ): {client: PidClient; scheduler: MspTelemetryScheduler; epoch: number; gyroSampleRateHz?: number; contract: PidApiContract} | {reason: PidBlockReason} {
    if (this.appStateOwner.getPhase() !== 'ACTIVE') return {reason: 'APP_BACKGROUNDED'};
    if (this.isMotorTestActive(key.sessionId)) return {reason: 'MOTOR_TEST_ACTIVE'};
    const identification = this.coordinator.getIdentificationState(key.sessionId);
    if (identification.status === 'IDLE' || identification.status === 'RUNNING') return {reason: 'IDENTIFYING'};
    if (!isSupportedConfigurationApi(identification)) return {reason: 'UNSUPPORTED_FIRMWARE'};
    const apiVersion = identification.status === 'SUCCEEDED' ? identification.identity.apiVersion : undefined;
    const resolution = resolvePidApi({
      major: apiVersion?.apiVersionMajor ?? 0,
      minor: apiVersion?.apiVersionMinor ?? 0,
    });
    const authority = pidWriteAuthority(resolution);
    if (intent === 'WRITE' && authority.kind === 'REFUSED') {
      return {reason: authority.reason === 'UNVERIFIED_FUTURE_API' ? 'UNVERIFIED_FUTURE_API' : 'UNSUPPORTED_FIRMWARE'};
    }
    // A read of a future API decodes against the newest layout we have read,
    // and the decoders preserve every byte they do not recognise.
    const contract: PidApiContract = resolution.kind === 'SOURCE_VERIFIED'
      ? resolution.contract
      : resolution.kind === 'UNVERIFIED_FUTURE_API' ? resolution.newestVerified : 'API_1_47';
    const client = this.coordinator.getActiveMspClient(key.sessionId); const scheduler = this.coordinator.getTelemetryScheduler(key.sessionId);
    if (this.coordinator.getOwnershipState(key.sessionId) !== 'ACTIVE' || this.coordinator.getSessionKey(key.sessionId)?.generation !== key.generation || client === undefined || scheduler === undefined) return {reason: 'DISCONNECTED'};
    if (this.coordinator.getMspRecoveryState(key.sessionId) !== 'READY') return {reason: 'LINK_RECOVERING'};
    return {client, scheduler, epoch: client.getEpoch(), gyroSampleRateHz: identification.identity.board.gyroSampleRateHz, contract};
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
  /**
   * `contract` is a REQUIRED parameter, taken from the same `capture()` that
   * decided whether this session may write at all. It travels with the bytes
   * into the snapshot so that nothing downstream has to re-derive a firmware
   * version from a payload length.
   */
  private async readSnapshot(requester: MspRequester, contract: PidApiContract, gyroSampleRateHz?: number): Promise<MspPidTuningSnapshot> {
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
      contract,
      pid: pid.payload,
      advanced: advanced.payload,
      rates: rates.payload,
      filters: filters.payload,
      gyroSampleRateHz,
      pidProcessDenom: generalAdvanced.pidProcessDenom,
      motorProtocolRaw: generalAdvanced.motorProtocolRaw,
      motorPwmRate: generalAdvanced.motorPwmRate,
      useContinuousUpdate: generalAdvanced.useContinuousUpdate,
      pidProfileIndex,
      pidProfileCount,
      rateProfileCount: status.readiness.rateProfileCount,
      controlRateProfileIndex,
    });
  }
}

export const pidTuningController = new PidTuningController();
