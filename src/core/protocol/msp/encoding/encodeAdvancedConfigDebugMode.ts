import type {MspAdvancedConfig} from '../decoding/decodeAdvancedConfig';

/**
 * MSP_SET_ADVANCED_CONFIG, written for ONE owned field.
 *
 * Blackbox owns exactly `debugMode` inside this structure. Everything else -
 * the PID process denominator, the motor protocol, the PWM rate, the idle
 * value, the gyro settings - belongs to other screens and to the flight
 * controller, and this encoder's whole job is to hand every one of them back
 * exactly as the board reported it moments earlier.
 *
 * NINETEEN BYTES. The read response carries a twentieth DEBUG_COUNT byte,
 * which is a read-only enum bound and is never echoed - the same rule the
 * motor-configuration encoder already follows.
 *
 * THE ORIGINAL MUST BE A FRESH READ. Passing a cached snapshot here is the
 * stale-overwrite defect this codebase has already been bitten by once: a
 * Blackbox save would quietly restore whatever motor protocol was in force
 * when the screen was last opened. The controller re-reads immediately
 * before calling this, under the same operation ownership as the write, and
 * a regression test pins that.
 */
export const ADVANCED_CONFIG_WRITE_BYTES = 19;

export function encodeAdvancedConfigDebugMode(
  original: MspAdvancedConfig,
  debugMode: number,
): Uint8Array {
  if (!Number.isInteger(debugMode) || debugMode < 0 || debugMode > 0xff) {
    throw new RangeError(
      `MSP_SET_ADVANCED_CONFIG: debugMode must be a u8, received ${debugMode}.`,
    );
  }
  const bytes = new Uint8Array(ADVANCED_CONFIG_WRITE_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, original.deprecatedGyroSyncDenom);
  view.setUint8(1, original.pidProcessDenom);
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
  // The one owned byte.
  view.setUint8(18, debugMode);
  return bytes;
}
