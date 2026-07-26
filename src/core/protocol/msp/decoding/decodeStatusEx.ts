import {MspPayloadReader} from './MspPayloadReader';

/**
 * Pass 7.6c - wire decoder for MSP_STATUS_EX (150), fixed-prefix only,
 * verified DIRECTLY at the immutable API-1.47 authority (release
 * 2025.12.5, commit BETAFLIGHT_API147_COMMIT, msp.c:1094-1110 - the API
 * version the bench reports; matching reads at API 1.46/1.48 are
 * secondary regression comparisons only, never proof of 1.47 - see
 * mspCommandSources.ts):
 *
 *   offset 0   u16  cycle time, microseconds (TASK_PID delta)
 *   offset 2   u16  i2c error counter - CUMULATIVE since boot, not a
 *                   currently-active fault indicator; builds without
 *                   USE_I2C emit a constant 0 (sentinel: 0 never proves
 *                   a healthy bus)
 *   offset 4   u16  sensor-presence mask: ACC=1, BARO=2, MAG=4, GPS=8,
 *                   RANGEFINDER=16, GYRO=32, OPTICALFLOW=64 (all present
 *                   at 2025.12.5). A set bit means DETECTED, never
 *                   "healthy".
 *   offset 6   u32  flightModeFlags (low 32) - skipped, not consumed
 *   offset 10  u8   pid profile index - skipped, not consumed
 *   offset 11  u16  average system load percent, constrained
 *                   0..LOAD_PERCENTAGE_ONE=100 (fc/core.h @ 2025.12.5)
 *
 * Everything past offset 12 (profile counts, the variable-length
 * flight-mode tail, arming-disable flags, config state, core temp - the
 * 1.46/1.48 additions) is version-variable trailing data and is
 * deliberately ignored.
 */
export interface MspStatusExCompact {
  cycleTimeUs: number;
  /** Cumulative since boot. */
  i2cErrorCount: number;
  /** Raw sensor-presence mask (detected, not healthy). */
  sensorPresenceMask: number;
  /** 0..100 whole percent. */
  cpuLoadPercent: number;
}

/** GPS bit of the sensor-presence mask (1<<3) - verified from the
 * encoder's own bit packing at msp.c (`sensors(SENSOR_GPS) << 3`). */
export const STATUS_SENSOR_GPS_BIT = 8;

export function decodeStatusEx(payload: Uint8Array): MspStatusExCompact {
  const reader = new MspPayloadReader(payload);
  const cycleTimeUs = reader.readU16LE();
  const i2cErrorCount = reader.readU16LE();
  const sensorPresenceMask = reader.readU16LE();
  reader.readBytes(4); // flightModeFlags low 32 bits - not consumed
  reader.readU8(); // pid profile index - not consumed
  const cpuLoadPercent = reader.readU16LE();
  return {cycleTimeUs, i2cErrorCount, sensorPresenceMask, cpuLoadPercent};
}
