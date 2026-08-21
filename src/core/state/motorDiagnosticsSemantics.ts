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

/**
 * 100.00%, in the hundredths-of-a-percent unit command 139 carries.
 *
 * THE FIRMWARE'S OWN "I HAVE NOTHING" MARKER, not a threshold this file
 * invented. Betaflight sets invalidPct to exactly this the moment DShot
 * telemetry is enabled, and replaces it ONLY where the motor's telemetry
 * is demonstrably active:
 *
 *     invalidPct = 10000; // 100.00%
 *   #ifdef USE_DSHOT_TELEMETRY_STATS
 *     if (isDshotMotorTelemetryActive(i)) {
 *         invalidPct = getDshotTelemetryMotorInvalidPercent(i);
 *     }
 *   #endif
 *
 * (betaflight/betaflight 4.5-maintenance, src/main/msp/msp.c, case
 * MSP_MOTOR_TELEMETRY.)
 */
const DSHOT_TELEMETRY_FULLY_INVALID = 10_000;

/**
 * WHETHER A ZERO IS A MEASUREMENT OR AN ABSENCE.
 *
 * Betaflight writes `rpm = 0` for a motor at rest AND for a motor whose
 * bidirectional-DShot telemetry never arrived - same four bytes, two
 * completely different facts. Presenting the second as "0 RPM" is the
 * fake-live-value this codebase refuses to produce: an operator reading
 * 0 beside a spinning motor would conclude the motor is stopped.
 *
 * The firmware hands over the discriminator itself, in the very next
 * field. Two rules, and both are deliberately conservative:
 *
 *   rpm > 0        the telemetry demonstrably works, whatever the stats
 *                  flag says. Always shown.
 *   rpm == 0 and
 *   invalidPct at  no evidence of an active telemetry stream. Shown as
 *   the 100% floor  UNAVAILABLE, never as a zero measurement.
 *
 * WHY NOT invalidPct ALONE. USE_DSHOT_TELEMETRY_STATS is an optional
 * compile flag. A build without it leaves invalidPct pinned at 10000
 * even while telemetry works perfectly, so hiding on that field alone
 * would blank real readings. Requiring rpm == 0 as well means the only
 * thing ever hidden is a zero we cannot tell from an absence.
 *
 * FEATURE_ESC_SENSOR is exempt: its rpm comes from erpmToRpm(escData->
 * rpm) on an enabled serial sensor record, where zero genuinely means a
 * motor at rest.
 */
function rpmOrUndefined(
  entry: MspMotorTelemetryEntry,
  support: MotorDiagnosticsSupport,
): number | undefined {
  if (support.escSensorEnabled) return entry.rpm;
  if (entry.rpm !== 0) return entry.rpm;
  return entry.invalidPercentRaw >= DSHOT_TELEMETRY_FULLY_INVALID
    ? undefined
    : entry.rpm;
}

/**
 * True when this motor is reporting a zero RPM that carries no evidence
 * of a live telemetry stream - the state a screen should explain rather
 * than draw a number for. Exported so the presentation can say WHY the
 * value is missing instead of printing a dash and leaving the operator
 * to guess.
 */
export function rpmIsUnprovenZero(
  entry: MspMotorTelemetryEntry,
  support: MotorDiagnosticsSupport | undefined,
): boolean {
  return (
    hasEscTelemetrySource(support) &&
    rpmOrUndefined(entry, support as MotorDiagnosticsSupport) === undefined
  );
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
  const rpm = rpmOrUndefined(entry, accepted);
  return Object.freeze({
    rpm,
    /**
     * THE SENTINEL IS NOT A MEASUREMENT.
     *
     * When `rpm` came back undefined on the DShot path, the reason is
     * that invalidPct is sitting at exactly its 10000 (100.00%) default
     * with rpm 0 - the firmware's "no packet ever arrived". Printing
     * that back as "errors 100.00%" turns the absence of a stream into a
     * measured error rate, which reads as a signal-quality problem on a
     * bench whose ESCs never spoke bidirectional DShot at all. The
     * screen says the true sentence instead, once, in words.
     */
    invalidPercentRaw:
      accepted.dshotTelemetryEnabled && rpm !== undefined
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
