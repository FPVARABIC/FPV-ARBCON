import { MspPayloadReadError, MspPayloadReader } from './MspPayloadReader';

/** MSP_MOTOR_TELEMETRY uses the same maximum output count as MSP_MOTOR. */
export const MSP_MOTOR_TELEMETRY_MAX_COUNT = 8;

export interface MspMotorTelemetryEntry {
  readonly rpm: number;
  /** Raw hundredths of a percent: 10000 means 100.00%. */
  readonly invalidPercentRaw: number;
  readonly temperatureCelsius: number;
  /** Raw u16 field. Centivolts for FEATURE_ESC_SENSOR; whole volts for the
   * reviewed DShot-only firmware branch. Normalize only after source proof. */
  readonly voltageCentivolts: number;
  /** Raw u16 field. Centiamps for FEATURE_ESC_SENSOR; whole amps for the
   * reviewed DShot-only firmware branch. Normalize only after source proof. */
  readonly currentCentiamps: number;
  readonly consumptionMah: number;
}

export interface MspMotorTelemetry {
  readonly motorCount: number;
  readonly motors: readonly MspMotorTelemetryEntry[];
}

/**
 * Decodes the reviewed Betaflight API-1.47/API-1.48
 * MSP_MOTOR_TELEMETRY (139) layout:
 * u8 count, then count * (u32 RPM, u16 invalid%, u8 °C, u16 voltage,
 * u16 current, u16 mAh). Voltage/current units are source-dependent (see
 * the entry fields); this decoder preserves raw wire values. A count above
 * the firmware's eight output slots is malformed,
 * never a reason to allocate or read an attacker-selected number of entries.
 */
export function decodeMotorTelemetry(payload: Uint8Array): MspMotorTelemetry {
  const reader = new MspPayloadReader(payload);
  const motorCount = reader.readU8();
  if (motorCount > MSP_MOTOR_TELEMETRY_MAX_COUNT) {
    throw new MspPayloadReadError(
      `MSP_MOTOR_TELEMETRY declared ${motorCount} motors; maximum is ${MSP_MOTOR_TELEMETRY_MAX_COUNT}.`,
    );
  }
  const motors: MspMotorTelemetryEntry[] = [];
  for (let index = 0; index < motorCount; index++) {
    motors.push(
      Object.freeze({
        rpm: reader.readU32LE(),
        invalidPercentRaw: reader.readU16LE(),
        temperatureCelsius: reader.readU8(),
        voltageCentivolts: reader.readU16LE(),
        currentCentiamps: reader.readU16LE(),
        consumptionMah: reader.readU16LE(),
      }),
    );
  }
  return Object.freeze({ motorCount, motors: Object.freeze(motors) });
}
