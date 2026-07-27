import {MspPayloadReader} from './MspPayloadReader';

/**
 * Motor read-capability pass - wire decoder for MSP_MOTOR_3D_CONFIG
 * (124), verified verbatim against src/main/msp/msp.c @
 * BETAFLIGHT_2025_12_2_COMMIT. Exactly 6 bytes:
 *
 *   offset 0  u16  deadband3d_low
 *   offset 2  u16  deadband3d_high
 *   offset 4  u16  neutral3d
 *
 * All 6 bytes are REQUIRED; trailing bytes are permitted and ignored.
 *
 * THESE VALUES DO NOT DETERMINE WHETHER 3D IS ENABLED. They are stored
 * tuning parameters and are populated on every flight controller,
 * including one with 3D switched off. The single authority for 3D state
 * is FEATURE_3D in MSP_FEATURE_CONFIG (decodeFeatureConfig.ts). This is
 * called out because guessing 3D from a "3D-looking" neutral value is
 * exactly the mistake that would invert the meaning of a motor stop
 * value.
 */
export interface MspMotor3dConfig {
  readonly deadband3dLow: number;
  readonly deadband3dHigh: number;
  readonly neutral3d: number;
}

export function decodeMotor3dConfig(payload: Uint8Array): MspMotor3dConfig {
  const reader = new MspPayloadReader(payload);
  return Object.freeze({
    deadband3dLow: reader.readU16LE(),
    deadband3dHigh: reader.readU16LE(),
    neutral3d: reader.readU16LE(),
  });
}
