/**
 * Pass 7.6a - the SEMANTIC layer over decodeBatteryState()'s wire truth,
 * deliberately separate from the decoder (same split as decodeAttitude ->
 * orientationViewModel): the decoder reports exactly what the firmware
 * sent; this module states only what those bytes are PROVEN to mean, per
 * the pinned-source verification recorded in mspCommandSources.ts.
 *
 * What this module deliberately does NOT do (per the Pass 7.6a product
 * decisions): no application-owned voltage thresholds, no derived battery
 * health, no charge percentage, no remaining-capacity estimate, no
 * severity inferred from voltage, no fallback zeros. MSP_BATTERY_STATE
 * carries none of those, and inventing them here would fabricate safety
 * conclusions the protocol cannot support.
 */

import type { MspBatteryState } from '../protocol';

/**
 * Verified batteryState_e (src/main/sensors/battery.h:99-105 @
 * BETAFLIGHT_PINNED_COMMIT): OK=0, WARNING=1, CRITICAL=2, NOT_PRESENT=3,
 * INIT=4. An unrecognized raw value is preserved as {kind:'UNKNOWN'} -
 * it must NEVER default to 'OK' (a future firmware enum addition must
 * degrade to "unknown", not to a false all-clear).
 */
export type BatteryFirmwareState =
  | 'OK'
  | 'WARNING'
  | 'CRITICAL'
  | 'NOT_PRESENT'
  | 'INIT'
  | { kind: 'UNKNOWN'; raw: number };

/** MSP_BATTERY_STATE carries no current-meter-presence flag (verified:
 * battery.c getAmperage() returns the meter register with no validity
 * bit on this wire) - so a raw 0.00A / 0mAh cannot be distinguished from
 * a disabled, absent, or unconfigured sensor by this command alone. The
 * value is preserved, but its trustworthiness is explicitly UNPROVEN.
 * A non-zero value proves only that the FC reported a non-zero wire value,
 * so the UI may show it explicitly as "reported" without
 * claiming the sensor is configured or accurate. A zero remains
 * indistinguishable and stays hidden.
 */
export type BatterySensorValidity = 'UNPROVEN' | 'REPORTED_NONZERO';

export interface BatterySemantics {
  /** cellCount === 0 means "battery not detected" (the encoder's own
   * verified comment). NOT strengthened to "no physical battery is
   * connected" - detection is the firmware's judgment, nothing more. */
  detection: 'DETECTED' | 'NOT_DETECTED';
  firmwareState: BatteryFirmwareState;
  /** Canonical: the high-resolution 0.01V wire field / 100. */
  voltageVolts: number;
  /** Compatibility echo of the legacy 0.1V field (saturates at 25.5V) -
   * retained for diagnostics, never a substitute for voltageVolts. */
  legacyVoltageVolts: number;
  cellCount: number;
  /** CONFIGURED capacity - configuration, not remaining capacity. */
  configuredCapacityMah: number;
  current: { centiamps: number; sensorValidity: BatterySensorValidity };
  consumed: { mah: number; sensorValidity: BatterySensorValidity };
}

function mapFirmwareState(raw: number): BatteryFirmwareState {
  switch (raw) {
    case 0:
      return 'OK';
    case 1:
      return 'WARNING';
    case 2:
      return 'CRITICAL';
    case 3:
      return 'NOT_PRESENT';
    case 4:
      return 'INIT';
    default:
      return { kind: 'UNKNOWN', raw };
  }
}

export function deriveBatterySemantics(raw: MspBatteryState): BatterySemantics {
  return {
    detection: raw.cellCount === 0 ? 'NOT_DETECTED' : 'DETECTED',
    firmwareState: mapFirmwareState(raw.batteryStateRaw),
    voltageVolts: raw.voltageCentivolts / 100,
    legacyVoltageVolts: raw.legacyVoltageDecivolts / 10,
    cellCount: raw.cellCount,
    configuredCapacityMah: raw.configuredCapacityMah,
    current: {
      centiamps: raw.amperageCentiamps,
      sensorValidity:
        raw.amperageCentiamps === 0 ? 'UNPROVEN' : 'REPORTED_NONZERO',
    },
    consumed: {
      mah: raw.consumedMah,
      sensorValidity: raw.consumedMah === 0 ? 'UNPROVEN' : 'REPORTED_NONZERO',
    },
  };
}
