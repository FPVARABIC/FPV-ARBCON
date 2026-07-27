import {MspPayloadReader} from './MspPayloadReader';

/**
 * Motor read-capability pass - wire decoder for MSP_ADVANCED_CONFIG (90),
 * verified verbatim against src/main/msp/msp.c:1846-1864 @
 * BETAFLIGHT_2025_12_2_COMMIT. Exactly 20 bytes, in this order:
 *
 *   offset  0  u8   deprecated gyro-sync denominator (hard-coded 1 since API 1.43)
 *   offset  1  u8   pid_process_denom
 *   offset  2  u8   dev.useContinuousUpdate
 *   offset  3  u8   dev.motorProtocol            <- motor-relevant
 *   offset  4  u16  dev.motorPwmRate
 *   offset  6  u16  motorIdle                    <- motor-relevant
 *   offset  8  u8   deprecated gyro_use_32kHz (hard-coded 0)
 *   offset  9  u8   dev.motorInversion           <- motor-relevant
 *   offset 10  u8   deprecated gyro_to_use (hard-coded 0)
 *   offset 11  u8   gyro_high_fsr
 *   offset 12  u8   gyroMovementCalibrationThreshold
 *   offset 13  u16  gyroCalibrationDuration
 *   offset 15  s16  gyro_offset_yaw              <- SIGNED
 *   offset 17  u8   checkOverflow
 *   offset 18  u8   debug_mode (added in MSP API 1.42)
 *   offset 19  u8   DEBUG_COUNT
 *
 * All 20 bytes are REQUIRED - every byte is written unconditionally at
 * this tag, so a shorter payload is truncation and throws
 * MspPayloadReadError. Trailing bytes are permitted and ignored.
 *
 * gyro_offset_yaw IS GENUINELY SIGNED: src/main/sensors/gyro.h:164
 * declares `int16_t gyro_offset_yaw;`. sbufWriteU16 in the encoder is
 * only the byte-writing primitive's name - the same lesson already
 * recorded for MSP_ATTITUDE and MSP_BATTERY_STATE. Reading it unsigned
 * would turn a small negative trim into a value near 65535.
 *
 * THE DEPRECATED FIELDS ARE DECODED, NOT SKIPPED. They are read into
 * named `deprecated*` fields rather than advanced over, so the 20-byte
 * layout is expressed once, explicitly, and a future field insertion
 * cannot silently shift every later offset unnoticed.
 *
 * WIRE TRUTH ONLY - motorProtocol and motorIdle are stored RAW. No pulse
 * value, throttle value or protocol name is derived here; see
 * ../commands/mspCommandSources.ts for why motorIdle in particular can
 * never produce an MSP motor value.
 */

/**
 * src/main/drivers/motor_types.h @ BETAFLIGHT_2025_12_2_COMMIT, by
 * declaration order: PWM 0, ONESHOT125 1, ONESHOT42 2, MULTISHOT 3,
 * BRUSHED 4, DSHOT150 5, DSHOT300 6, DSHOT600 7, PROSHOT1000 8,
 * DISABLED 9. (DSHOT1200 is removed at this tag, which is why 8 is
 * PROSHOT1000.)
 *
 * DELIBERATELY A LOCAL CONSTANT, NOT AN "OFFICIAL" IDENTIFIER. The
 * numeric value is version-sensitive: it is only guaranteed to mean
 * DSHOT600 at this pinned commit, so the name records this codebase's
 * interpretation rather than claiming an upstream API contract.
 */
export const MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2 = 7;

export interface MspAdvancedConfig {
  /** u8. Removed from the firmware in API 1.43; hard-coded 1. */
  readonly deprecatedGyroSyncDenom: number;
  readonly pidProcessDenom: number;
  readonly useContinuousUpdate: number;
  /** u8, RAW motorProtocolTypes_e. Never mapped to a name here - see
   * MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2. */
  readonly motorProtocolRaw: number;
  readonly motorPwmRate: number;
  /** u16, hundredths of a percent (raw 550 == 5.5%). CONFIGURATION for
   * the ARMED throttle curve's lower endpoint. NOT a pulse value, and no
   * motor command may be derived from it. */
  readonly motorIdleRaw: number;
  /** u8. Deprecated gyro_use_32kHz; hard-coded 0. */
  readonly deprecatedGyroUse32kHz: number;
  /** u8. Electrical output-signal inversion (dev.motorInversion). NOT
   * props-out configuration and NOT physical rotation direction. */
  readonly motorInversionRaw: number;
  /** u8. Deprecated gyro_to_use; hard-coded 0. */
  readonly deprecatedGyroToUse: number;
  readonly gyroHighFsr: number;
  readonly gyroMovementCalibrationThreshold: number;
  readonly gyroCalibrationDuration: number;
  /** SIGNED 16-bit - see the file comment. */
  readonly gyroYawOffset: number;
  readonly checkOverflow: number;
  readonly debugMode: number;
  readonly debugModeCount: number;
}

export function decodeAdvancedConfig(payload: Uint8Array): MspAdvancedConfig {
  const reader = new MspPayloadReader(payload);
  return Object.freeze({
    deprecatedGyroSyncDenom: reader.readU8(),
    pidProcessDenom: reader.readU8(),
    useContinuousUpdate: reader.readU8(),
    motorProtocolRaw: reader.readU8(),
    motorPwmRate: reader.readU16LE(),
    motorIdleRaw: reader.readU16LE(),
    deprecatedGyroUse32kHz: reader.readU8(),
    motorInversionRaw: reader.readU8(),
    deprecatedGyroToUse: reader.readU8(),
    gyroHighFsr: reader.readU8(),
    gyroMovementCalibrationThreshold: reader.readU8(),
    gyroCalibrationDuration: reader.readU16LE(),
    gyroYawOffset: reader.readS16LE(),
    checkOverflow: reader.readU8(),
    debugMode: reader.readU8(),
    debugModeCount: reader.readU8(),
  });
}
