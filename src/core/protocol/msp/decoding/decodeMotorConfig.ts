import {MspPayloadReader} from './MspPayloadReader';

/**
 * Motor read-capability pass - wire decoder for MSP_MOTOR_CONFIG (131),
 * verified verbatim against src/main/msp/msp.c for the reviewed Betaflight
 * API-1.46, API-1.47 and API-1.48 read adapters. The semantic change in the
 * first field is recorded below; all offsets remain exactly 10 bytes:
 *
 *   offset 0  u16  minthrottle at API 1.46; structural 0 at API 1.47+
 *   offset 2  u16  maxthrottle
 *   offset 4  u16  mincommand
 *   offset 6  u8   getMotorCount()
 *   offset 7  u8   motorPoleCount
 *   offset 8  u8   useDshotTelemetry (0 when built without USE_DSHOT_TELEMETRY)
 *   offset 9  u8   featureIsEnabled(FEATURE_ESC_SENSOR) (0 without USE_ESC_SENSOR)
 *
 * All 10 bytes are REQUIRED; trailing bytes are permitted and ignored.
 *
 * The first field changes meaning across the reviewed boundary. API 1.46
 * still emits its historical minthrottle; API 1.47+ hard-code zero with the
 * comment "was minthrottle until after 4.5". It remains isolated under a
 * deprecated name because no shared write/configuration decision may treat
 * it as a portable throttle endpoint.
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
  /** u16. Historical minthrottle at API 1.46; structural zero at 1.47+. */
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
