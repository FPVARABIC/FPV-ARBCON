/**
 * Pass 7.6c - the CONDITIONAL consumption-based battery charge estimate.
 *
 * MSP_BATTERY_STATE carries no direct state of charge. The ONLY permitted
 * derivation is consumption-based:
 *
 *   percent = round(((configuredCapacityMah - consumedMah) / configuredCapacityMah) * 100)
 *
 * and it may be shown ONLY when every prerequisite below is proven. This
 * function never clamps invalid inputs into a plausible number, never
 * infers charge from voltage (pack or cell), and never uses a LiPo curve.
 * The estimate is consumption-since-FC-startup and assumes the configured
 * capacity is correct and the pack started full - the UI surfaces that
 * limitation in the accessibility description.
 *
 * Prerequisites (each returns a distinct UNAVAILABLE reason for tests and
 * debug clarity; the UI shows the single approved fallback string):
 *  1. the battery sample is FRESH (not stale/error/waiting/unavailable);
 *  2. a battery is detected (cellCount > 0);
 *  3. the one-shot MSP_BATTERY_CONFIG read succeeded;
 *  4. configured capacity is positive and within the firmware-supported
 *     CLI range 0 < capacity <= 20000 (cli/settings.c:996 @ pin);
 *  5. capacity agrees between MSP_BATTERY_CONFIG and MSP_BATTERY_STATE;
 *  6. the configured current-meter source is a REAL measuring source
 *     proven suitable for consumption tracking - exactly ADC in this
 *     pass. NONE never qualifies; VIRTUAL never qualifies in this pass;
 *     ESC/MSP are real meters but deliberately NOT yet qualified here
 *     (their consumption-integration path was not audited this pass);
 *     an unknown enum value never qualifies.
 *  7. 0 <= consumedMah <= configuredCapacityMah (consumed above capacity
 *     means the assumptions are broken - no estimate, no clamping).
 *
 * Zero consumed mAh with every other prerequisite proven legitimately
 * yields 100%.
 */

import type {MspBatteryState, MspBatteryConfig, TelemetryValue} from '../protocol';
import {CURRENT_METER_SOURCE} from '../protocol';

export type BatteryChargeEstimate =
  | {kind: 'ESTIMATE'; percent: number}
  | {
      kind: 'UNAVAILABLE';
      reason:
        | 'SAMPLE_NOT_FRESH'
        | 'BATTERY_NOT_DETECTED'
        | 'CONFIG_UNAVAILABLE'
        | 'CAPACITY_NOT_CONFIGURED'
        | 'CAPACITY_OUT_OF_RANGE'
        | 'CAPACITY_MISMATCH'
        | 'METER_SOURCE_NOT_QUALIFIED'
        | 'CONSUMED_OUT_OF_RANGE';
    };

/** Firmware-supported bat_capacity CLI maximum (cli/settings.c:996). */
export const BATTERY_CAPACITY_MAX_MAH = 20000;

export function deriveBatteryChargeEstimate(
  battery: TelemetryValue<MspBatteryState>,
  config: MspBatteryConfig | undefined,
): BatteryChargeEstimate {
  if (battery.status !== 'FRESH') {
    return {kind: 'UNAVAILABLE', reason: 'SAMPLE_NOT_FRESH'};
  }
  if (battery.value.cellCount === 0) {
    return {kind: 'UNAVAILABLE', reason: 'BATTERY_NOT_DETECTED'};
  }
  if (config === undefined) {
    return {kind: 'UNAVAILABLE', reason: 'CONFIG_UNAVAILABLE'};
  }
  if (config.configuredCapacityMah === 0) {
    return {kind: 'UNAVAILABLE', reason: 'CAPACITY_NOT_CONFIGURED'};
  }
  if (config.configuredCapacityMah > BATTERY_CAPACITY_MAX_MAH) {
    return {kind: 'UNAVAILABLE', reason: 'CAPACITY_OUT_OF_RANGE'};
  }
  if (config.configuredCapacityMah !== battery.value.configuredCapacityMah) {
    return {kind: 'UNAVAILABLE', reason: 'CAPACITY_MISMATCH'};
  }
  if (config.currentMeterSourceRaw !== CURRENT_METER_SOURCE.ADC) {
    return {kind: 'UNAVAILABLE', reason: 'METER_SOURCE_NOT_QUALIFIED'};
  }
  const consumed = battery.value.consumedMah;
  const capacity = config.configuredCapacityMah;
  if (consumed < 0 || consumed > capacity) {
    return {kind: 'UNAVAILABLE', reason: 'CONSUMED_OUT_OF_RANGE'};
  }
  return {kind: 'ESTIMATE', percent: Math.round(((capacity - consumed) / capacity) * 100)};
}
