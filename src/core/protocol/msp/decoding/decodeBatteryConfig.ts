import {MspPayloadReader} from './MspPayloadReader';

/**
 * Pass 7.6c - wire decoder for MSP_BATTERY_CONFIG (32), verified verbatim
 * at BOTH the pinned master (msp.c:926-936, API 1.48) and release 4.5.5
 * (msp.c:898-908, API 1.46) - identical layout, so the bench API 1.47
 * necessarily matches (mspCommandSources.ts). ONE-SHOT read only: this
 * command is requested once per compatible physical session and never
 * polled (Pass 7.6c battery-percentage contract).
 *
 *   offset 0  u8   min cell voltage, 0.1V steps
 *   offset 1  u8   max cell voltage, 0.1V steps
 *   offset 2  u8   warning cell voltage, 0.1V steps
 *   offset 3  u16  CONFIGURED battery capacity, mAh (CLI bat_capacity,
 *                  u16, range 0..20000 - cli/settings.c:996 @ pin)
 *   offset 5  u8   voltageMeterSource
 *   offset 6  u8   currentMeterSource - currentMeterSource_e
 *                  (sensors/current.h:26-33): NONE=0, ADC=1, VIRTUAL=2,
 *                  ESC=3, MSP=4     (7 bytes mandatory)
 *   offset 7+ 3x u16 high-resolution cell voltages - trailing, ignored.
 *
 * Raw wire truth only - the charge-estimate prerequisites live in
 * src/core/state/batteryChargeEstimate.ts, never here.
 */
export interface MspBatteryConfig {
  minCellVoltageDecivolts: number;
  maxCellVoltageDecivolts: number;
  warningCellVoltageDecivolts: number;
  configuredCapacityMah: number;
  voltageMeterSourceRaw: number;
  currentMeterSourceRaw: number;
}

/** Verified currentMeterSource_e values (sensors/current.h:26-33). */
export const CURRENT_METER_SOURCE = {
  NONE: 0,
  ADC: 1,
  VIRTUAL: 2,
  ESC: 3,
  MSP: 4,
} as const;

export function decodeBatteryConfig(payload: Uint8Array): MspBatteryConfig {
  const reader = new MspPayloadReader(payload);
  return {
    minCellVoltageDecivolts: reader.readU8(),
    maxCellVoltageDecivolts: reader.readU8(),
    warningCellVoltageDecivolts: reader.readU8(),
    configuredCapacityMah: reader.readU16LE(),
    voltageMeterSourceRaw: reader.readU8(),
    currentMeterSourceRaw: reader.readU8(),
  };
}
