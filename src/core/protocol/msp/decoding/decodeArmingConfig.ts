import { MspPayloadReader } from './MspPayloadReader';

export interface MspArmingConfig {
  readonly autoDisarmDelaySeconds: number;
  readonly deprecatedDisarmKillsSwitch: number;
  readonly smallAngleDegrees: number;
  readonly gyroCalibrationOnFirstArm: boolean;
}

/** Betaflight MSP_ARMING_CONFIG at API 1.47: four unconditional u8 fields. */
export function decodeArmingConfig(payload: Uint8Array): MspArmingConfig {
  const reader = new MspPayloadReader(payload);
  return Object.freeze({
    autoDisarmDelaySeconds: reader.readU8(),
    deprecatedDisarmKillsSwitch: reader.readU8(),
    smallAngleDegrees: reader.readU8(),
    gyroCalibrationOnFirstArm: reader.readU8() !== 0,
  });
}
