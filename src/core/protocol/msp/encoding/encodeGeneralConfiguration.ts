import type { MspAdvancedConfig } from '../decoding/decodeAdvancedConfig';
import type { MspArmingConfig } from '../decoding/decodeArmingConfig';
import type { MspBeeperConfig } from '../decoding/decodeBeeperConfig';
import {
  MSP_TEXT_MAX_BYTES,
  type MspTextValue,
} from '../decoding/decodeMspText';
import type { MspRxConfig } from '../decoding/decodeRxConfig';
import {
  generalConfigurationDraftsEqual,
  createGeneralConfigurationDraft,
  validateGeneralConfigurationDraft,
  type GeneralConfigurationDraft,
  type GeneralConfigurationSnapshot,
} from '../../../state/generalConfigurationModel';

function createPayload(size: number): {
  readonly bytes: Uint8Array;
  readonly view: DataView;
} {
  const bytes = new Uint8Array(size);
  return { bytes, view: new DataView(bytes.buffer) };
}

export function encodeArmingConfiguration(
  value: MspArmingConfig,
): Uint8Array {
  return Uint8Array.from([
    value.autoDisarmDelaySeconds,
    value.deprecatedDisarmKillsSwitch,
    value.smallAngleDegrees,
    value.gyroCalibrationOnFirstArm ? 1 : 0,
  ]);
}

export function encodeBeeperConfiguration(
  value: MspBeeperConfig,
): Uint8Array {
  const { bytes, view } = createPayload(9);
  view.setUint32(0, value.disabledMask, true);
  view.setUint8(4, value.dshotBeaconTone);
  view.setUint32(5, value.disabledDshotBeaconMask, true);
  return bytes;
}

/**
 * MSP_SET_ADVANCED_CONFIG API 1.47 is the first 19 response bytes. Every
 * motor and gyro field is mirrored; only pidProcessDenom is supplied by the
 * caller. DEBUG_COUNT is a read-only twentieth response byte and is omitted.
 */
export function encodeAdvancedGeneralConfiguration(
  original: MspAdvancedConfig,
  pidProcessDenom: number,
): Uint8Array {
  const { bytes, view } = createPayload(19);
  view.setUint8(0, original.deprecatedGyroSyncDenom);
  view.setUint8(1, pidProcessDenom);
  view.setUint8(2, original.useContinuousUpdate);
  view.setUint8(3, original.motorProtocolRaw);
  view.setUint16(4, original.motorPwmRate, true);
  view.setUint16(6, original.motorIdleRaw, true);
  view.setUint8(8, original.deprecatedGyroUse32kHz);
  view.setUint8(9, original.motorInversionRaw);
  view.setUint8(10, original.deprecatedGyroToUse);
  view.setUint8(11, original.gyroHighFsr);
  view.setUint8(12, original.gyroMovementCalibrationThreshold);
  view.setUint16(13, original.gyroCalibrationDuration, true);
  view.setInt16(15, original.gyroYawOffset, true);
  view.setUint8(17, original.checkOverflow);
  view.setUint8(18, original.debugMode);
  return bytes;
}

/** Clone the complete receiver payload and alter the one owned byte. */
export function encodeRxCameraAngle(
  original: MspRxConfig,
  fpvCameraAngleDegrees: number,
): Uint8Array {
  if (original.raw.length < 23) {
    throw new RangeError('MSP_RX_CONFIG is too short for the camera angle.');
  }
  const bytes = original.raw.slice();
  bytes[22] = fpvCameraAngleDegrees;
  return bytes;
}

export function encodeMspTextRequest(type: number): Uint8Array {
  return Uint8Array.from([type]);
}

/** MSP2_SET_TEXT: type + u8 length + up to 16 printable ASCII bytes. */
export function encodeMspText(value: MspTextValue): Uint8Array {
  if (value.value.length > MSP_TEXT_MAX_BYTES) {
    throw new RangeError(`MSP text exceeds ${MSP_TEXT_MAX_BYTES} bytes.`);
  }
  const bytes = new Uint8Array(2 + value.value.length);
  bytes[0] = value.type;
  bytes[1] = value.value.length;
  for (let index = 0; index < value.value.length; index += 1) {
    const code = value.value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) {
      throw new RangeError('MSP text must contain printable ASCII only.');
    }
    bytes[index + 2] = code;
  }
  return bytes;
}

export type GeneralConfigurationWriteGroup =
  | 'FEATURE'
  | 'BEEPER'
  | 'ARMING'
  | 'CRAFT_NAME'
  | 'PILOT_NAME'
  | 'RX'
  | 'ADVANCED';

export interface EncodedGeneralConfigurationWrite {
  readonly group: GeneralConfigurationWriteGroup;
  readonly payload: Uint8Array;
}

/** Changed groups only, in the same deterministic order as the reference UI. */
export function encodeChangedGeneralConfiguration(
  original: GeneralConfigurationSnapshot,
  draft: GeneralConfigurationDraft,
): readonly EncodedGeneralConfigurationWrite[] {
  const issues = validateGeneralConfigurationDraft(original, draft);
  if (issues.length > 0) {
    throw new RangeError(`Invalid general configuration: ${issues.join(',')}.`);
  }
  const current = createGeneralConfigurationDraft(original);
  if (generalConfigurationDraftsEqual(current, draft)) return Object.freeze([]);
  const writes: EncodedGeneralConfigurationWrite[] = [];

  if (draft.featureMaskRaw !== current.featureMaskRaw) {
    const { bytes, view } = createPayload(4);
    view.setUint32(0, draft.featureMaskRaw, true);
    writes.push(Object.freeze({ group: 'FEATURE', payload: bytes }));
  }
  if (
    draft.disabledBeeperMask !== current.disabledBeeperMask ||
    draft.disabledDshotBeaconMask !== current.disabledDshotBeaconMask ||
    draft.dshotBeaconTone !== current.dshotBeaconTone
  ) {
    writes.push(
      Object.freeze({
        group: 'BEEPER',
        payload: encodeBeeperConfiguration({
          disabledMask: draft.disabledBeeperMask,
          disabledDshotBeaconMask: draft.disabledDshotBeaconMask,
          dshotBeaconTone: draft.dshotBeaconTone,
        }),
      }),
    );
  }
  if (
    draft.autoDisarmDelaySeconds !== current.autoDisarmDelaySeconds ||
    draft.smallAngleDegrees !== current.smallAngleDegrees ||
    draft.gyroCalibrationOnFirstArm !== current.gyroCalibrationOnFirstArm
  ) {
    writes.push(
      Object.freeze({
        group: 'ARMING',
        payload: encodeArmingConfiguration({
          autoDisarmDelaySeconds: draft.autoDisarmDelaySeconds,
          deprecatedDisarmKillsSwitch:
            original.arming.deprecatedDisarmKillsSwitch,
          smallAngleDegrees: draft.smallAngleDegrees,
          gyroCalibrationOnFirstArm: draft.gyroCalibrationOnFirstArm,
        }),
      }),
    );
  }
  if (draft.craftName !== current.craftName) {
    writes.push(
      Object.freeze({
        group: 'CRAFT_NAME',
        payload: encodeMspText({ type: 2, value: draft.craftName }),
      }),
    );
  }
  if (draft.pilotName !== current.pilotName) {
    writes.push(
      Object.freeze({
        group: 'PILOT_NAME',
        payload: encodeMspText({ type: 1, value: draft.pilotName }),
      }),
    );
  }
  if (draft.fpvCameraAngleDegrees !== current.fpvCameraAngleDegrees) {
    writes.push(
      Object.freeze({
        group: 'RX',
        payload: encodeRxCameraAngle(
          original.rx,
          draft.fpvCameraAngleDegrees,
        ),
      }),
    );
  }
  if (draft.pidProcessDenom !== current.pidProcessDenom) {
    writes.push(
      Object.freeze({
        group: 'ADVANCED',
        payload: encodeAdvancedGeneralConfiguration(
          original.advanced,
          draft.pidProcessDenom,
        ),
      }),
    );
  }
  return Object.freeze(writes);
}
