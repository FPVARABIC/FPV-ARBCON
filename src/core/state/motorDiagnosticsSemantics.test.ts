import {
  deriveMotorDiagnosticsSupport,
  hasEscTelemetrySource,
  visibleMotorTelemetryMetrics,
} from './motorDiagnosticsSemantics';

const telemetry = Object.freeze({
  rpm: 12_345,
  invalidPercentRaw: 250,
  temperatureCelsius: 0,
  voltageCentivolts: 0,
  currentCentiamps: 0,
  consumptionMah: 0,
});

describe('motor diagnostics source semantics', () => {
  it('does not mistake Betaflight structural zeros for live ESC telemetry', () => {
    const support = deriveMotorDiagnosticsSupport({
      motorCount: 4,
      dshotTelemetryRaw: 0,
      escSensorRaw: 0,
    });
    expect(support.escTelemetrySource).toBe('NONE');
    expect(hasEscTelemetrySource(support)).toBe(false);
    expect(visibleMotorTelemetryMetrics(telemetry, support)).toEqual({
      rpm: undefined,
      invalidPercentRaw: undefined,
      temperatureCelsius: undefined,
      voltageVolts: undefined,
      currentAmps: undefined,
      consumptionMah: undefined,
    });
  });

  it('exposes DShot RPM/quality but hides ambiguous zero extended fields', () => {
    const support = deriveMotorDiagnosticsSupport({
      motorCount: 4,
      dshotTelemetryRaw: 1,
      escSensorRaw: 0,
    });
    expect(support.escTelemetrySource).toBe('BIDIRECTIONAL_DSHOT');
    expect(visibleMotorTelemetryMetrics(telemetry, support)).toEqual({
      rpm: 12_345,
      invalidPercentRaw: 250,
      temperatureCelsius: undefined,
      voltageVolts: undefined,
      currentAmps: undefined,
      consumptionMah: undefined,
    });
  });

  it('keeps non-zero extended DShot fields without inventing consumption', () => {
    const support = deriveMotorDiagnosticsSupport({
      motorCount: 4,
      dshotTelemetryRaw: 1,
      escSensorRaw: 0,
    });
    expect(
      visibleMotorTelemetryMetrics(
        {
          ...telemetry,
          temperatureCelsius: 41,
          // Betaflight's DShot-only branch serializes already-quantized
          // whole volts/amps, unlike the ESC-sensor centi-units.
          voltageCentivolts: 16,
          currentCentiamps: 3,
        },
        support,
      ),
    ).toEqual({
      rpm: 12_345,
      invalidPercentRaw: 250,
      temperatureCelsius: 41,
      voltageVolts: 16,
      currentAmps: 3,
      consumptionMah: undefined,
    });
  });

  it('treats enabled ESC-sensor values, including zeros, as measurements', () => {
    const support = deriveMotorDiagnosticsSupport({
      motorCount: 6,
      dshotTelemetryRaw: 0,
      escSensorRaw: 1,
    });
    expect(support).toEqual({
      motorCount: 6,
      dshotTelemetryEnabled: false,
      escSensorEnabled: true,
      escTelemetrySource: 'ESC_SENSOR',
    });
    expect(visibleMotorTelemetryMetrics(telemetry, support)).toEqual({
      rpm: 12_345,
      invalidPercentRaw: undefined,
      temperatureCelsius: 0,
      voltageVolts: 0,
      currentAmps: 0,
      consumptionMah: 0,
    });
  });

  it('normalizes serial ESC-sensor centi-units into physical units', () => {
    const support = deriveMotorDiagnosticsSupport({
      motorCount: 4,
      dshotTelemetryRaw: 1,
      escSensorRaw: 1,
    });
    expect(
      visibleMotorTelemetryMetrics(
        {
          ...telemetry,
          voltageCentivolts: 1680,
          currentCentiamps: 325,
        },
        support,
      ),
    ).toMatchObject({
      voltageVolts: 16.8,
      currentAmps: 3.25,
    });
  });
});
