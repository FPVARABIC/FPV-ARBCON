import {MspPayloadReader} from './MspPayloadReader';

/**
 * Motor read-capability pass - wire decoder for MSP_MOTOR_CONFIG (131),
 * verified verbatim against src/main/msp/msp.c @
 * BETAFLIGHT_2025_12_2_COMMIT. Exactly 10 bytes:
 *
 *   offset 0  u16  0 - "was minthrottle until after 4.5" (REMOVED field)
 *   offset 2  u16  maxthrottle
 *   offset 4  u16  mincommand
 *   offset 6  u8   getMotorCount()
 *   offset 7  u8   motorPoleCount
 *   offset 8  u8   useDshotTelemetry (0 when built without USE_DSHOT_TELEMETRY)
 *   offset 9  u8   featureIsEnabled(FEATURE_ESC_SENSOR) (0 without USE_ESC_SENSOR)
 *
 * All 10 bytes are REQUIRED; trailing bytes are permitted and ignored.
 *
 * THE FIRST FIELD IS NOT A MINIMUM THROTTLE. The firmware hard-codes it
 * to 0 with the comment "was minthrottle until after 4.5". It is decoded
 * into an explicitly-named deprecated field so nothing downstream can
 * mistake a structural zero for a real throttle endpoint.
 *
 * THIS COMMAND IS THE ONLY AUTHORITY FOR MOTOR COUNT. MSP_MOTOR always
 * returns eight values regardless of the airframe, so counting its
 * non-zero entries is not a motor count and must never be used as one.
 *
 * The DShot-telemetry byte is stored RAW: a 0 means either "disabled" or
 * "not compiled into this firmware build", and this decoder cannot tell
 * those apart. Interpreting it is deliberately somebody else's job.
 */
export interface MspMotorConfig {
  /** u16, hard-coded 0 at this tag. A removed field, never a throttle. */
  readonly deprecatedMinThrottle: number;
  readonly maxThrottle: number;
  readonly minCommand: number;
  /** u8 - the authoritative motor count for this airframe. */
  readonly motorCount: number;
  readonly motorPoleCount: number;
  /** u8, raw. 0 is ambiguous between "off" and "not compiled in". */
  readonly dshotTelemetryRaw: number;
  /** u8, raw FEATURE_ESC_SENSOR state. */
  readonly escSensorRaw: number;
}

export function decodeMotorConfig(payload: Uint8Array): MspMotorConfig {
  const reader = new MspPayloadReader(payload);
  return Object.freeze({
    deprecatedMinThrottle: reader.readU16LE(),
    maxThrottle: reader.readU16LE(),
    minCommand: reader.readU16LE(),
    motorCount: reader.readU8(),
    motorPoleCount: reader.readU8(),
    dshotTelemetryRaw: reader.readU8(),
    escSensorRaw: reader.readU8(),
  });
}
