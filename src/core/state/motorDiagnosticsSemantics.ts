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

/**
 * DID A SERIAL ESC FRAME EVER ARRIVE FOR THIS OUTPUT?
 *
 * THE DEFECT THIS ANSWERS. A real flight controller with FEATURE_ESC_SENSOR
 * enabled and no telemetry wire connected reported, on every output:
 *
 *     0 RPM · 0°C · 0.00V · 0.00A · 0mAh          - labelled "مباشر"
 *
 * Every one of those was a zero-initialised struct field, presented as a
 * measurement. The firmware KNOWS the difference and does not transmit it:
 *
 *   escSensorInit()  sets escSensorData[i].dataAge = ESC_DATA_INVALID (255)
 *                    for every motor and leaves temperature / voltage /
 *                    current / consumption / rpm at their static zeros
 *                    (sensors/esc_sensor.c:222-226).
 *   escSensorProcess() increments dataAge toward ESC_DATA_INVALID whenever
 *                    a frame fails to arrive (esc_sensor.c:287-288); only
 *                    a decoded frame sets dataAge = 0 AND writes the five
 *                    values together (esc_sensor.c:263-268).
 *   getEscSensorData() returns that struct WHATEVER dataAge says
 *                    (esc_sensor.c:156-163), and MSP_MOTOR_TELEMETRY copies
 *                    the four extended fields out of it with no age check
 *                    at all (msp/msp.c:1254-1265 on 4.5-maintenance,
 *                    :1337-1348 on master - byte-identical).
 *
 * So `dataAge` never reaches the wire, and an all-zero record is EXACTLY
 * what "the port was opened and nothing was ever received" produces. The
 * only evidence available to a configurator is the record itself: the five
 * fields are written together by one frame decode, so a single non-zero
 * field proves a frame arrived, and a zero beside it is then a genuine
 * reading. All five zero proves nothing at all.
 *
 * DIRECTION OF THE ERROR. A powered-down ESC that genuinely reports 0V on a
 * working wire is reported here as "waiting" rather than as five zeros.
 * That is the safe direction to be wrong in: an operator who reads
 * "بانتظار بيانات ESC" checks their wiring, while one who reads "0.00V
 * مباشر" concludes their ESC is measuring and their battery is dead.
 *
 * WHY rpm IS EXCLUDED WHEN DSHOT IS ALSO ON. The firmware gives
 * bidirectional DShot precedence for rpm and only falls back to the serial
 * record "if (!rpmDataAvailable)" (msp.c, same case). With both sources
 * enabled the rpm bytes did not come from this record, so they are not
 * evidence about it.
 */
function escSensorRecordProven(
  entry: MspMotorTelemetryEntry,
  support: MotorDiagnosticsSupport,
): boolean {
  if (!support.escSensorEnabled) return false;
  const writtenByTheRecord = support.dshotTelemetryEnabled
    ? [
        entry.temperatureCelsius,
        entry.voltageCentivolts,
        entry.currentCentiamps,
        entry.consumptionMah,
      ]
    : [
        entry.rpm,
        entry.temperatureCelsius,
        entry.voltageCentivolts,
        entry.currentCentiamps,
        entry.consumptionMah,
      ];
  return writtenByTheRecord.some(value => value !== 0);
}

/**
 * One extended field - temperature, voltage or current - under whichever
 * source actually produced it. The two rules are different and are never
 * applied to each other's source:
 *
 *   ESC_SENSOR      the whole record must be proven (above). Once it is, a
 *                   zero in one field is a measurement.
 *   DShot extended  the firmware writes the field ONLY when the matching
 *                   bit is set in `telemetryTypes` and leaves it at 0
 *                   otherwise (msp.c, "Provide extended dshot telemetry").
 *                   The wire carries no presence bit, so a zero is
 *                   indistinguishable from "this ESC does not send it" and
 *                   is never shown.
 */
function escExtendedOrUndefined(
  value: number,
  entry: MspMotorTelemetryEntry,
  support: MotorDiagnosticsSupport,
): number | undefined {
  if (support.escSensorEnabled) {
    return escSensorRecordProven(entry, support) ? value : undefined;
  }
  return value !== 0 ? value : undefined;
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
  // WHICHEVER SOURCE THE FIRMWARE USED, THAT SOURCE'S RULE APPLIES.
  //
  // This branch used to be `if (support.escSensorEnabled) return entry.rpm`
  // FIRST, which had two consequences, both wrong. On an ESC_SENSOR board
  // with no wire it published the zero-initialised struct's rpm as a
  // reading; and on a board with BOTH sources it took the DShot rpm bytes
  // and exempted them from the DShot sentinel, so "not one valid packet
  // ever arrived" (invalidPct pinned at 10000) was shown as 0 RPM.
  if (support.dshotTelemetryEnabled) {
    // msp.c gives bidirectional DShot precedence for rpm whenever it is on.
    if (entry.rpm !== 0) return entry.rpm;
    return entry.invalidPercentRaw >= DSHOT_TELEMETRY_FULLY_INVALID
      ? undefined
      : entry.rpm;
  }
  if (support.escSensorEnabled) {
    return escSensorRecordProven(entry, support) ? entry.rpm : undefined;
  }
  return undefined;
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
    temperatureCelsius: escExtendedOrUndefined(
      entry.temperatureCelsius,
      entry,
      accepted,
    ),
    // FEATURE_ESC_SENSOR writes hundredths of a volt/amp. The DShot-only
    // branch writes its already-quantized extended values directly: whole
    // volts after the firmware's >>2 conversion, and whole amps. Normalize
    // here so the presentation never assigns one source's units to another.
    voltageVolts: accepted.escSensorEnabled
      ? divideOrUndefined(
          escExtendedOrUndefined(entry.voltageCentivolts, entry, accepted),
        )
      : escExtendedOrUndefined(entry.voltageCentivolts, entry, accepted),
    currentAmps: accepted.escSensorEnabled
      ? divideOrUndefined(
          escExtendedOrUndefined(entry.currentCentiamps, entry, accepted),
        )
      : escExtendedOrUndefined(entry.currentCentiamps, entry, accepted),
    // Betaflight's DShot branch never writes consumption at all - the field
    // is only ever assigned inside the FEATURE_ESC_SENSOR block - so a
    // DShot-only zero is not a zero reading, it is an absent field.
    consumptionMah: accepted.escSensorEnabled
      ? escExtendedOrUndefined(entry.consumptionMah, entry, accepted)
      : undefined,
  });
}

const divideOrUndefined = (value: number | undefined): number | undefined =>
  value === undefined ? undefined : value / 100;

/**
 * PACKET RECEIVED IS NOT MEASUREMENT AVAILABLE.
 *
 * A successful command-139 reply proves the link works and the firmware
 * answered. It proves nothing about whether any ESC spoke. These two say
 * so separately, so a presentation can report "the source is configured
 * and we are still waiting" instead of labelling a frame of zeros LIVE.
 */
export function motorTelemetryHasValidMeasurement(
  entry: MspMotorTelemetryEntry,
  support: MotorDiagnosticsSupport | undefined,
): boolean {
  const metrics = visibleMotorTelemetryMetrics(entry, support);
  return (
    metrics.rpm !== undefined ||
    metrics.temperatureCelsius !== undefined ||
    metrics.voltageVolts !== undefined ||
    metrics.currentAmps !== undefined ||
    metrics.consumptionMah !== undefined
  );
}

/** True when at least ONE output carries at least one valid field. */
export function escTelemetryHasValidMeasurement(
  motors: readonly MspMotorTelemetryEntry[] | undefined,
  support: MotorDiagnosticsSupport | undefined,
): boolean {
  return (motors ?? []).some(motor =>
    motorTelemetryHasValidMeasurement(motor, support),
  );
}

/**
 * True when FEATURE_ESC_SENSOR is configured and not one output has a
 * record that proves a serial frame arrived - the exact state a wired-up
 * feature with no telemetry wire produces.
 */
export function escSensorConfiguredButSilent(
  motors: readonly MspMotorTelemetryEntry[] | undefined,
  support: MotorDiagnosticsSupport | undefined,
): boolean {
  if (support === undefined || !support.escSensorEnabled) return false;
  const entries = motors ?? [];
  return (
    entries.length > 0 &&
    entries.every(motor => !escSensorRecordProven(motor, support))
  );
}
