import type {MspMotorConfig} from '../protocol/msp/decoding/decodeMotorConfig';
import type {MspMotorTelemetryEntry} from '../protocol/msp/decoding/decodeMotorTelemetry';

/**
 * The two independent sources Betaflight can merge into
 * MSP_MOTOR_TELEMETRY.  This is deliberately derived from the raw
 * MSP_MOTOR_CONFIG bytes instead of from a successful command-139 reply:
 * Betaflight returns a structurally valid, all-zero reply even when neither
 * source is enabled.
 *
 * API-1.47 and API-1.48 source truth (msp.c, MSP_MOTOR_TELEMETRY):
 * - bidirectional DShot supplies RPM, invalid-packet percentage and may
 *   supply extended temperature/current/voltage fields;
 * - FEATURE_ESC_SENSOR supplies RPM, temperature, voltage, current and
 *   consumption;
 * - when neither is enabled, every field is serialized as zero.
 */
export type MotorEscTelemetrySource =
  | 'NONE'
  | 'BIDIRECTIONAL_DSHOT'
  | 'ESC_SENSOR'
  | 'BIDIRECTIONAL_DSHOT_AND_ESC_SENSOR';

export interface MotorDiagnosticsSupport {
  /** Authoritative airframe output count from MSP_MOTOR_CONFIG. */
  readonly motorCount: number;
  readonly dshotTelemetryEnabled: boolean;
  readonly escSensorEnabled: boolean;
  readonly escTelemetrySource: MotorEscTelemetrySource;
}

export function deriveMotorDiagnosticsSupport(
  motor: Pick<
    MspMotorConfig,
    'motorCount' | 'dshotTelemetryRaw' | 'escSensorRaw'
  >,
): MotorDiagnosticsSupport {
  const dshotTelemetryEnabled = motor.dshotTelemetryRaw !== 0;
  const escSensorEnabled = motor.escSensorRaw !== 0;
  const escTelemetrySource: MotorEscTelemetrySource = dshotTelemetryEnabled
    ? escSensorEnabled
      ? 'BIDIRECTIONAL_DSHOT_AND_ESC_SENSOR'
      : 'BIDIRECTIONAL_DSHOT'
    : escSensorEnabled
      ? 'ESC_SENSOR'
      : 'NONE';

  return Object.freeze({
    motorCount: motor.motorCount,
    dshotTelemetryEnabled,
    escSensorEnabled,
    escTelemetrySource,
  });
}

export function hasEscTelemetrySource(
  support: MotorDiagnosticsSupport | undefined,
): boolean {
  return support !== undefined && support.escTelemetrySource !== 'NONE';
}

/**
 * Field-level visibility. The wire payload has no presence bits for DShot
 * extended telemetry, so a DShot-only zero is ambiguous: it may be a real
 * zero or Betaflight's default for a field the ESC never supplied.  We hide
 * that zero rather than presenting it as a measurement. FEATURE_ESC_SENSOR
 * fields, by contrast, come from the enabled ESC sensor record and may
 * truthfully contain zero.
 */
export interface MotorTelemetryVisibleMetrics {
  readonly rpm: number | undefined;
  readonly invalidPercentRaw: number | undefined;
  readonly temperatureCelsius: number | undefined;
  /** Normalized physical value. The raw command-139 unit depends on source. */
  readonly voltageVolts: number | undefined;
  /** Normalized physical value. The raw command-139 unit depends on source. */
  readonly currentAmps: number | undefined;
  readonly consumptionMah: number | undefined;
}

function dshotExtendedOrUndefined(
  value: number,
  support: MotorDiagnosticsSupport,
): number | undefined {
  return support.escSensorEnabled || value !== 0 ? value : undefined;
}

export function visibleMotorTelemetryMetrics(
  entry: MspMotorTelemetryEntry,
  support: MotorDiagnosticsSupport | undefined,
): MotorTelemetryVisibleMetrics {
  if (!hasEscTelemetrySource(support)) {
    return Object.freeze({
      rpm: undefined,
      invalidPercentRaw: undefined,
      temperatureCelsius: undefined,
      voltageVolts: undefined,
      currentAmps: undefined,
      consumptionMah: undefined,
    });
  }
  const accepted = support as MotorDiagnosticsSupport;
  return Object.freeze({
    rpm: entry.rpm,
    invalidPercentRaw: accepted.dshotTelemetryEnabled
      ? entry.invalidPercentRaw
      : undefined,
    temperatureCelsius: dshotExtendedOrUndefined(
      entry.temperatureCelsius,
      accepted,
    ),
    // FEATURE_ESC_SENSOR writes hundredths of a volt/amp. The DShot-only
    // branch writes its already-quantized extended values directly: whole
    // volts after the firmware's >>2 conversion, and whole amps. Normalize
    // here so the presentation never assigns one source's units to another.
    voltageVolts: accepted.escSensorEnabled
      ? entry.voltageCentivolts / 100
      : dshotExtendedOrUndefined(entry.voltageCentivolts, accepted),
    currentAmps: accepted.escSensorEnabled
      ? entry.currentCentiamps / 100
      : dshotExtendedOrUndefined(entry.currentCentiamps, accepted),
    // Betaflight's DShot branch never writes consumption. Only the serial
    // ESC sensor branch populates it, so a DShot-only zero is never shown.
    consumptionMah: accepted.escSensorEnabled
      ? entry.consumptionMah
      : undefined,
  });
}
