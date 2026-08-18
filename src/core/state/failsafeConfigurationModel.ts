import {
  RX_FAILSAFE_MAX,
  RX_FAILSAFE_MIN,
  RX_FAILSAFE_STEP,
  type FailsafeProcedure,
  type FailsafeSwitchMode,
  type MspFailsafeSnapshot,
  type RxFailsafeMode,
} from '../protocol/msp/decoding/decodeFailsafe';
import {
  createGpsRescueDraft,
  validateGpsRescueDraft,
  type GpsRescueDraft,
  type GpsRescueValidationCode,
} from './gpsRescueConfigurationModel';

export interface FailsafeChannelDraft {
  readonly mode: RxFailsafeMode;
  readonly value: number;
}

export interface FailsafeConfigurationDraft {
  readonly delayDeciseconds: number;
  readonly landingTimeSeconds: number;
  readonly throttle: number;
  readonly switchMode: FailsafeSwitchMode;
  readonly throttleLowDelayDeciseconds: number;
  readonly procedure: FailsafeProcedure;
  readonly channels: readonly FailsafeChannelDraft[];
  /**
   * Present exactly when the board answered MSP_GPS_RESCUE. Choosing GPS
   * Rescue and setting the altitude it returns at is one decision, so it
   * is one draft, one validation pass and one readback - see
   * MspFailsafeSnapshot.gpsRescue.
   */
  readonly gpsRescue?: GpsRescueDraft;
}

export type FailsafeValidationCode =
  | 'DELAY_INVALID'
  | 'LANDING_TIME_INVALID'
  | 'THROTTLE_INVALID'
  | 'SWITCH_MODE_INVALID'
  | 'THROTTLE_LOW_DELAY_INVALID'
  | 'PROCEDURE_INVALID'
  | 'GPS_RESCUE_UNSUPPORTED'
  | 'CHANNEL_COUNT_CHANGED'
  | 'CHANNEL_MODE_INVALID'
  | 'CHANNEL_VALUE_INVALID'
  | 'AUX_AUTO_FORBIDDEN'
  /** A draft carries rescue parameters the board never reported. Only
   * reachable through a programming error, and it must fail closed
   * rather than encode a frame from values that came from nowhere. */
  | 'GPS_RESCUE_NOT_READABLE'
  | GpsRescueValidationCode;

/**
 * PROJECTS the editable settings out of a snapshot - it does not spread it.
 *
 * A snapshot now also carries read-only diagnostics the decoder derived
 * (rawSwitchMode, rawProcedure, truncated; rawMode and outOfRange per
 * channel). Those describe what the FIRMWARE sent; they are not settings
 * and an operator cannot edit them. Spreading them into the draft would
 * put them inside the JSON comparison below, so a save whose readback was
 * otherwise byte-perfect could be reported UNVERIFIED purely because a
 * corrected value cleared its own `outOfRange` flag - a false negative on
 * the safety-critical screen, produced by a diagnostic.
 *
 * Listing the fields explicitly also means a future diagnostic added to
 * the snapshot cannot silently leak into drafts and equality again.
 */
export function createFailsafeConfigurationDraft(snapshot: MspFailsafeSnapshot): FailsafeConfigurationDraft {
  const {delayDeciseconds, landingTimeSeconds, throttle, switchMode, throttleLowDelayDeciseconds, procedure} =
    snapshot.config;
  return Object.freeze({
    delayDeciseconds,
    landingTimeSeconds,
    throttle,
    switchMode,
    throttleLowDelayDeciseconds,
    procedure,
    channels: Object.freeze(
      snapshot.channels.map(channel => Object.freeze({mode: channel.mode, value: channel.value})),
    ),
    // Absent, not empty, when the board does not answer MSP_GPS_RESCUE -
    // `gpsRescue: undefined` and a missing key stringify identically, so
    // equality is unaffected either way, but an absent key is the honest
    // shape for "there is nothing here to edit".
    ...(snapshot.gpsRescue !== undefined ? {gpsRescue: createGpsRescueDraft(snapshot.gpsRescue)} : {}),
  });
}

export function failsafeDraftsEqual(a: FailsafeConfigurationDraft, b: FailsafeConfigurationDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function failsafeSnapshotsEqual(a: MspFailsafeSnapshot, b: MspFailsafeSnapshot): boolean {
  return (
    a.supportsGpsRescue === b.supportsGpsRescue &&
    // Part of the STALE_BASE comparison on purpose. A board that answered
    // MSP_GPS_RESCUE on the base read and does not answer it on the
    // pre-write re-read is not in the state the draft was built from.
    a.gpsRescueAvailability === b.gpsRescueAvailability &&
    JSON.stringify(a.gpsRescue) === JSON.stringify(b.gpsRescue) &&
    JSON.stringify(a.config) === JSON.stringify(b.config) &&
    JSON.stringify(a.channels) === JSON.stringify(b.channels)
  );
}

export function validateFailsafeDraft(draft: FailsafeConfigurationDraft, snapshot: MspFailsafeSnapshot): readonly FailsafeValidationCode[] {
  const issues: FailsafeValidationCode[] = [];
  if (!Number.isInteger(draft.delayDeciseconds) || draft.delayDeciseconds < 1 || draft.delayDeciseconds > 200) issues.push('DELAY_INVALID');
  if (!Number.isInteger(draft.landingTimeSeconds) || draft.landingTimeSeconds < 0 || draft.landingTimeSeconds > 250) issues.push('LANDING_TIME_INVALID');
  if (!Number.isInteger(draft.throttle) || draft.throttle < RX_FAILSAFE_MIN || draft.throttle > RX_FAILSAFE_MAX) issues.push('THROTTLE_INVALID');
  if (draft.switchMode < 0 || draft.switchMode > 2 || !Number.isInteger(draft.switchMode)) issues.push('SWITCH_MODE_INVALID');
  if (!Number.isInteger(draft.throttleLowDelayDeciseconds) || draft.throttleLowDelayDeciseconds < 0 || draft.throttleLowDelayDeciseconds > 300) issues.push('THROTTLE_LOW_DELAY_INVALID');
  if (draft.procedure < 0 || draft.procedure > 2 || !Number.isInteger(draft.procedure)) issues.push('PROCEDURE_INVALID');
  if (draft.procedure === 2 && !snapshot.supportsGpsRescue) issues.push('GPS_RESCUE_UNSUPPORTED');
  if (draft.channels.length !== snapshot.channels.length) issues.push('CHANNEL_COUNT_CHANGED');
  draft.channels.forEach((channel, index) => {
    if (channel.mode < 0 || channel.mode > 2 || !Number.isInteger(channel.mode)) issues.push('CHANNEL_MODE_INVALID');
    if (index >= 4 && channel.mode === 0) issues.push('AUX_AUTO_FORBIDDEN');
    if (!Number.isInteger(channel.value) || channel.value < RX_FAILSAFE_MIN || channel.value > RX_FAILSAFE_MAX || (channel.value - RX_FAILSAFE_MIN) % RX_FAILSAFE_STEP !== 0) issues.push('CHANNEL_VALUE_INVALID');
  });
  if (draft.gpsRescue !== undefined) {
    if (snapshot.gpsRescue === undefined) issues.push('GPS_RESCUE_NOT_READABLE');
    else issues.push(...validateGpsRescueDraft(draft.gpsRescue, snapshot.gpsRescue));
  }
  return Object.freeze([...new Set(issues)]);
}
