import {
  RX_FAILSAFE_MAX,
  RX_FAILSAFE_MIN,
  RX_FAILSAFE_STEP,
  type FailsafeProcedure,
  type FailsafeSwitchMode,
  type MspFailsafeSnapshot,
  type RxFailsafeMode,
} from '../protocol/msp/decoding/decodeFailsafe';

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
  | 'AUX_AUTO_FORBIDDEN';

export function createFailsafeConfigurationDraft(snapshot: MspFailsafeSnapshot): FailsafeConfigurationDraft {
  return Object.freeze({...snapshot.config, channels: Object.freeze(snapshot.channels.map(channel => Object.freeze({...channel})))});
}

export function failsafeDraftsEqual(a: FailsafeConfigurationDraft, b: FailsafeConfigurationDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function failsafeSnapshotsEqual(a: MspFailsafeSnapshot, b: MspFailsafeSnapshot): boolean {
  return a.supportsGpsRescue === b.supportsGpsRescue && JSON.stringify(a.config) === JSON.stringify(b.config) && JSON.stringify(a.channels) === JSON.stringify(b.channels);
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
  return Object.freeze([...new Set(issues)]);
}
