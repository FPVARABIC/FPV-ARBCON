import {RECEIVER_CHANNEL_MAX_COUNT, type MspReceiverDeadband, type MspRxConfig} from '../protocol/msp';

export const RECEIVER_MAP_LETTERS = Object.freeze(['A', 'E', 'R', 'T', '1', '2', '3', '4'] as const);

export interface ReceiverConfigurationSnapshot {
  readonly rx: MspRxConfig;
  readonly channelMap: readonly number[];
  readonly rssiChannel: number;
  readonly deadband: MspReceiverDeadband;
}

export interface ReceiverConfigurationDraft {
  readonly channelMapText: string;
  readonly rssiChannel: number;
  readonly stickMin: number;
  readonly stickCenter: number;
  readonly stickMax: number;
  readonly deadband: number;
  readonly yawDeadband: number;
  readonly throttle3dDeadband: number;
  readonly smoothingEnabled: boolean;
  readonly setpointCutoff: number;
  readonly throttleCutoff: number;
  readonly setpointAutoFactor: number;
  readonly throttleAutoFactor: number;
}

export type ReceiverConfigurationValidationCode =
  | 'CHANNEL_MAP_INVALID' | 'STICK_MIN_INVALID' | 'STICK_CENTER_INVALID'
  | 'STICK_MAX_INVALID' | 'STICK_ORDER_INVALID' | 'RSSI_CHANNEL_INVALID'
  | 'DEADBAND_INVALID' | 'YAW_DEADBAND_INVALID'
  | 'THROTTLE_3D_DEADBAND_INVALID' | 'SMOOTHING_INVALID';

export function receiverMapToText(map: readonly number[]): string {
  if (map.length !== 8) return '';
  const result = new Array<string>(8);
  map.forEach((position, logicalChannel) => {
    if (Number.isInteger(position) && position >= 0 && position < 8) {
      result[position] = RECEIVER_MAP_LETTERS[logicalChannel];
    }
  });
  return result.every(Boolean) ? result.join('') : '';
}

export function receiverMapFromText(text: string): readonly number[] | undefined {
  const normalized = text.trim().toUpperCase();
  if (normalized.length !== 8 || new Set(normalized).size !== 8) return undefined;
  if ([...normalized].some(letter => !RECEIVER_MAP_LETTERS.includes(letter as never))) return undefined;
  return Object.freeze(RECEIVER_MAP_LETTERS.map(letter => normalized.indexOf(letter)));
}

export function createReceiverConfigurationDraft(snapshot: ReceiverConfigurationSnapshot): ReceiverConfigurationDraft {
  return Object.freeze({
    channelMapText: receiverMapToText(snapshot.channelMap),
    rssiChannel: snapshot.rssiChannel,
    stickMin: snapshot.rx.stickMin,
    stickCenter: snapshot.rx.stickCenter,
    stickMax: snapshot.rx.stickMax,
    deadband: snapshot.deadband.deadband,
    yawDeadband: snapshot.deadband.yawDeadband,
    throttle3dDeadband: snapshot.deadband.throttle3dDeadband,
    smoothingEnabled: snapshot.rx.rcSmoothing === 1,
    setpointCutoff: snapshot.rx.rcSmoothingSetpointCutoff,
    throttleCutoff: snapshot.rx.rcSmoothingThrottleCutoff,
    setpointAutoFactor: snapshot.rx.rcSmoothingAutoFactor,
    throttleAutoFactor: snapshot.rx.rcSmoothingAutoFactorThrottle,
  });
}

export function receiverDraftsEqual(a: ReceiverConfigurationDraft, b: ReceiverConfigurationDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * RECEIVER P2 - the draft fields whose MSP_SET_RX_CONFIG handler marks the
 * flight controller's configuration as REBOOT REQUIRED.
 *
 * FIRMWARE FACT - src/main/msp/msp.c @ pinned Betaflight API 1.47
 * (79065c96ba0bb5cdc675e67d7093e05dab8b330e). `configRebootUpdateCheckU8`
 * (msp.c:353) calls `setRebootRequired()` when the incoming value differs
 * from the stored one, and inside MSP_SET_RX_CONFIG it is used at exactly
 * five sites - all of them rc_smoothing, and all five exposed by our UI:
 *
 *   msp.c:3779  rc_smoothing_setpoint_cutoff        -> setpointCutoff
 *   msp.c:3780  rc_smoothing_throttle_cutoff        -> throttleCutoff
 *   msp.c:3781  rc_smoothing_auto_factor_throttle   -> throttleAutoFactor
 *   msp.c:3807  rc_smoothing_auto_factor_rpy        -> setpointAutoFactor
 *   msp.c:3815  rc_smoothing                        -> smoothingEnabled
 *
 * No other Receiver field this screen writes (channel map, RSSI channel,
 * deadbands, mincheck/midrc/maxcheck) flags a reboot at this pin, and
 * none is added here on suspicion.
 *
 * THIS IS AN EXPECTATION, NOT THE VERDICT. The firmware only raises the
 * flag when the value actually CHANGED, which is why this compares the
 * two drafts rather than merely listing the fields; but the authoritative
 * answer still comes from re-reading the FC's own reboot-required bit
 * after the write (see ReceiverConfigurationController.save). This
 * function exists so the controller knows when to go and ask.
 */
export const RECEIVER_REBOOT_SENSITIVE_FIELDS = Object.freeze([
  'setpointCutoff',
  'throttleCutoff',
  'throttleAutoFactor',
  'setpointAutoFactor',
  'smoothingEnabled',
] as const satisfies readonly (keyof ReceiverConfigurationDraft)[]);

export function receiverChangeMayRequireReboot(
  original: ReceiverConfigurationDraft,
  draft: ReceiverConfigurationDraft,
): boolean {
  return RECEIVER_REBOOT_SENSITIVE_FIELDS.some(field => original[field] !== draft[field]);
}

export function receiverSnapshotsEqual(a: ReceiverConfigurationSnapshot, b: ReceiverConfigurationSnapshot): boolean {
  return a.rssiChannel === b.rssiChannel &&
    a.channelMap.length === b.channelMap.length && a.channelMap.every((v, i) => v === b.channelMap[i]) &&
    a.rx.raw.length === b.rx.raw.length && a.rx.raw.every((v, i) => v === b.rx.raw[i]) &&
    a.deadband.deadband === b.deadband.deadband &&
    a.deadband.yawDeadband === b.deadband.yawDeadband &&
    a.deadband.altitudeHoldDeadband === b.deadband.altitudeHoldDeadband &&
    a.deadband.throttle3dDeadband === b.deadband.throttle3dDeadband;
}

export function validateReceiverDraft(draft: ReceiverConfigurationDraft): readonly ReceiverConfigurationValidationCode[] {
  const issues: ReceiverConfigurationValidationCode[] = [];
  if (receiverMapFromText(draft.channelMapText) === undefined) issues.push('CHANNEL_MAP_INVALID');
  if (!Number.isInteger(draft.stickMin) || draft.stickMin < 1000 || draft.stickMin > 1200) issues.push('STICK_MIN_INVALID');
  if (!Number.isInteger(draft.stickCenter) || draft.stickCenter < 1401 || draft.stickCenter > 1599) issues.push('STICK_CENTER_INVALID');
  if (!Number.isInteger(draft.stickMax) || draft.stickMax < 1800 || draft.stickMax > 2000) issues.push('STICK_MAX_INVALID');
  if (!(draft.stickMin < draft.stickCenter && draft.stickCenter < draft.stickMax)) issues.push('STICK_ORDER_INVALID');
  // Betaflight exposes 0=disabled and AUX channels only (1-4 are the
  // primary Roll/Pitch/Yaw/Throttle controls). The firmware's hard API
  // 1.47 limit is MAX_SUPPORTED_RC_CHANNEL_COUNT=18.
  if (!Number.isInteger(draft.rssiChannel) || (draft.rssiChannel !== 0 && (draft.rssiChannel < 5 || draft.rssiChannel > RECEIVER_CHANNEL_MAX_COUNT))) issues.push('RSSI_CHANNEL_INVALID');
  if (!Number.isInteger(draft.deadband) || draft.deadband < 0 || draft.deadband > 32) issues.push('DEADBAND_INVALID');
  if (!Number.isInteger(draft.yawDeadband) || draft.yawDeadband < 0 || draft.yawDeadband > 100) issues.push('YAW_DEADBAND_INVALID');
  if (!Number.isInteger(draft.throttle3dDeadband) || draft.throttle3dDeadband < 0 || draft.throttle3dDeadband > 100) issues.push('THROTTLE_3D_DEADBAND_INVALID');
  if ([draft.setpointCutoff, draft.throttleCutoff].some(v => !Number.isInteger(v) || v < 0 || v > 255) ||
      [draft.setpointAutoFactor, draft.throttleAutoFactor].some(v => !Number.isInteger(v) || v < 0 || v > 250)) {
    issues.push('SMOOTHING_INVALID');
  }
  return Object.freeze([...new Set(issues)]);
}
