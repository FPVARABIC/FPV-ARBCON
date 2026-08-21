/**
 * A VIRTUAL FLIGHT CONTROLLER AND FOUR VIRTUAL ESCs, ANSWERING COMMAND
 * 139 THE WAY THE FIRMWARE DOES.
 *
 * =====================================================================
 * WHY THE BYTES ARE HAND-BUILT
 * =====================================================================
 *
 * Every expected frame in this file is assembled from the FIRMWARE
 * CONTRACT, byte by byte, by a writer that shares no code with the
 * decoder under test. Encoding an expectation with our own encoder and
 * then decoding it with our own decoder proves that two of our functions
 * agree with each other; it proves nothing at all about the aircraft.
 *
 * The contract, quoted from betaflight/betaflight 4.5-maintenance,
 * src/main/msp/msp.c, case MSP_MOTOR_TELEMETRY:
 *
 *     sbufWriteU8(dst, getMotorCount());
 *     for (unsigned i = 0; i < getMotorCount(); i++) {
 *         ...
 *         sbufWriteU32(dst, (rpmDataAvailable ? rpm : 0));
 *         sbufWriteU16(dst, invalidPct);
 *         sbufWriteU8(dst, escTemperature);
 *         sbufWriteU16(dst, escVoltage);
 *         sbufWriteU16(dst, escCurrent);
 *         sbufWriteU16(dst, escConsumption);
 *     }
 *
 * One u8 header, then 4+2+1+2+2+2 = 13 bytes per motor, little-endian.
 *
 * =====================================================================
 * WHAT THE FIRMWARE HAS ALREADY DONE TO THESE NUMBERS
 * =====================================================================
 *
 * RPM IS MECHANICAL, NOT eRPM, AND THE POLE COUNT IS ALREADY APPLIED.
 * dshot.c initDshotTelemetry():
 *
 *     erpmToHz = ERPM_PER_LSB / SECONDS_PER_MINUTE
 *                / (motorConfig()->motorPoleCount / 2.0f);
 *
 * and dshotUpdateTelemetryData(): `dshotRpm[k] = erpmToRpm(value)`.
 * msp.c then writes `lrintf(getDshotRpm(i))`. The ESC-sensor branch
 * writes `lrintf(erpmToRpm(escData->rpm))`. So a second pole-count
 * division anywhere in this application would be a defect, and these
 * tests assert the value arrives unscaled.
 *
 * VOLTAGE AND CURRENT CHANGE UNITS WITH THE SOURCE. The DShot branch
 * writes `telemetryData[VOLTAGE] >> 2` (the raw byte is 0.25V steps, so
 * the result is whole volts) and `telemetryData[CURRENT]` (whole amps,
 * "0-255A step 1A"). FEATURE_ESC_SENSOR writes escData->voltage and
 * ->current, which msp.c documents as "0.01V per unit" / "0.01A per
 * unit". Reading one source's numbers in the other's units is the
 * mistake this file exists to catch.
 */

import {
  decodeMotorTelemetry,
  deriveMotorDiagnosticsSupport,
  rpmIsUnprovenZero,
  visibleMotorTelemetryMetrics,
  type MotorDiagnosticsSupport,
} from '../index';

/* ------------------------------------------------------------------ *
 * An independent little-endian writer. Not the project's encoder.
 * ------------------------------------------------------------------ */

class WireWriter {
  private readonly bytes: number[] = [];
  u8(value: number): this {
    this.bytes.push(value & 0xff);
    return this;
  }
  u16(value: number): this {
    this.bytes.push(value & 0xff, (value >>> 8) & 0xff);
    return this;
  }
  u32(value: number): this {
    this.bytes.push(
      value & 0xff,
      (value >>> 8) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 24) & 0xff,
    );
    return this;
  }
  done(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

interface VirtualEsc {
  readonly rpm: number;
  readonly invalidPct: number;
  readonly temperatureC: number;
  readonly voltageRaw: number;
  readonly currentRaw: number;
  readonly consumptionMah: number;
}

/** Serializes command 139 exactly as msp.c does, from the values given. */
function motorTelemetryFrame(escs: readonly VirtualEsc[]): Uint8Array {
  const writer = new WireWriter().u8(escs.length);
  for (const esc of escs) {
    writer
      .u32(esc.rpm)
      .u16(esc.invalidPct)
      .u8(esc.temperatureC)
      .u16(esc.voltageRaw)
      .u16(esc.currentRaw)
      .u16(esc.consumptionMah);
  }
  return writer.done();
}

/** Distinct on purpose: no two motors share a digit pattern, so a
 *  transposed index cannot pass by coincidence. */
const BENCH: readonly VirtualEsc[] = Object.freeze([
  {rpm: 1234, invalidPct: 0, temperatureC: 31, voltageRaw: 16, currentRaw: 7, consumptionMah: 120},
  {rpm: 2789, invalidPct: 25, temperatureC: 42, voltageRaw: 16, currentRaw: 9, consumptionMah: 240},
  {rpm: 4111, invalidPct: 50, temperatureC: 53, voltageRaw: 15, currentRaw: 11, consumptionMah: 360},
  {rpm: 5678, invalidPct: 75, temperatureC: 64, voltageRaw: 15, currentRaw: 13, consumptionMah: 480},
]);

/** Bidirectional DShot on, no serial ESC sensor - the common bench. */
const DSHOT_ONLY: MotorDiagnosticsSupport = deriveMotorDiagnosticsSupport({
  motorCount: 4,
  dshotTelemetryRaw: 1,
  escSensorRaw: 0,
});

/** FEATURE_ESC_SENSOR on a serial telemetry wire. */
const ESC_SENSOR: MotorDiagnosticsSupport = deriveMotorDiagnosticsSupport({
  motorCount: 4,
  dshotTelemetryRaw: 0,
  escSensorRaw: 1,
});

const NO_SOURCE: MotorDiagnosticsSupport = deriveMotorDiagnosticsSupport({
  motorCount: 4,
  dshotTelemetryRaw: 0,
  escSensorRaw: 0,
});

describe('a virtual bench of four ESCs reaches the right motor', () => {
  it('decodes the hand-built frame with no scaling of its own', () => {
    const decoded = decodeMotorTelemetry(motorTelemetryFrame(BENCH));
    expect(decoded.motorCount).toBe(4);
    // The frame is 1 + 4*13 bytes; anything else means the layout drifted.
    expect(motorTelemetryFrame(BENCH)).toHaveLength(1 + 4 * 13);
    expect(decoded.motors.map(motor => motor.rpm)).toEqual([
      1234, 2789, 4111, 5678,
    ]);
    expect(decoded.motors.map(motor => motor.temperatureCelsius)).toEqual([
      31, 42, 53, 64,
    ]);
  });

  it('maps M1 to 1234 and M4 to 5678 - not to each other', () => {
    const decoded = decodeMotorTelemetry(motorTelemetryFrame(BENCH));
    const visible = decoded.motors.map(motor =>
      visibleMotorTelemetryMetrics(motor, DSHOT_ONLY),
    );
    // Index 0 IS M1 on this screen. A transposition would still produce
    // four plausible numbers, which is exactly why they are all distinct.
    expect(visible[0].rpm).toBe(1234);
    expect(visible[1].rpm).toBe(2789);
    expect(visible[2].rpm).toBe(4111);
    expect(visible[3].rpm).toBe(5678);
    expect(visible[0].temperatureCelsius).toBe(31);
    expect(visible[3].temperatureCelsius).toBe(64);
  });

  it('applies NO second pole-count conversion - the firmware already did', () => {
    /*
     * A 14-pole motor at 1234 mechanical RPM has an eRPM of 1234 * 7.
     * If this application divided again by poles/2 it would report 176;
     * if it multiplied it would report 8638. The wire value is the
     * answer, unchanged.
     */
    const decoded = decodeMotorTelemetry(motorTelemetryFrame(BENCH));
    const visible = visibleMotorTelemetryMetrics(decoded.motors[0], DSHOT_ONLY);
    expect(visible.rpm).toBe(1234);
    expect(visible.rpm).not.toBe(Math.round(1234 / 7));
    expect(visible.rpm).not.toBe(1234 * 7);
  });

  it('reads voltage and current in the units the SOURCE uses', () => {
    const decoded = decodeMotorTelemetry(motorTelemetryFrame(BENCH));
    // DShot branch: whole volts (already >>2 in firmware) and whole amps.
    const dshot = visibleMotorTelemetryMetrics(decoded.motors[0], DSHOT_ONLY);
    expect(dshot.voltageVolts).toBe(16);
    expect(dshot.currentAmps).toBe(7);
    // ESC sensor branch: the same 16 on the wire means 0.16V.
    const sensor = visibleMotorTelemetryMetrics(decoded.motors[0], ESC_SENSOR);
    expect(sensor.voltageVolts).toBeCloseTo(0.16, 5);
    expect(sensor.currentAmps).toBeCloseTo(0.07, 5);
  });

  it('shows consumption only for the source that actually writes it', () => {
    const decoded = decodeMotorTelemetry(motorTelemetryFrame(BENCH));
    // msp.c never assigns escConsumption in the DShot branch.
    expect(
      visibleMotorTelemetryMetrics(decoded.motors[0], DSHOT_ONLY)
        .consumptionMah,
    ).toBeUndefined();
    expect(
      visibleMotorTelemetryMetrics(decoded.motors[0], ESC_SENSOR)
        .consumptionMah,
    ).toBe(120);
  });
});

describe('a zero RPM is not the same fact as an absent one', () => {
  /**
   * THE BENCH REPORT THIS EXISTS FOR: motors were spun and the screen
   * showed nothing useful. With bidirectional DShot enabled but no valid
   * telemetry arriving, Betaflight answers rpm=0 with invalidPct pinned
   * at its 100.00% default - and the old code rendered that zero as a
   * live reading beside a spinning motor.
   */
  const silent: VirtualEsc = {
    rpm: 0,
    invalidPct: 10000,
    temperatureC: 0,
    voltageRaw: 0,
    currentRaw: 0,
    consumptionMah: 0,
  };
  const atRest: VirtualEsc = {...silent, invalidPct: 0};

  it('hides a zero the firmware gave no evidence for', () => {
    const decoded = decodeMotorTelemetry(motorTelemetryFrame([silent]));
    const visible = visibleMotorTelemetryMetrics(decoded.motors[0], DSHOT_ONLY);
    expect(visible.rpm).toBeUndefined();
    expect(rpmIsUnprovenZero(decoded.motors[0], DSHOT_ONLY)).toBe(true);
  });

  it('shows a zero the firmware DID vouch for - a motor genuinely at rest', () => {
    const decoded = decodeMotorTelemetry(motorTelemetryFrame([atRest]));
    const visible = visibleMotorTelemetryMetrics(decoded.motors[0], DSHOT_ONLY);
    expect(visible.rpm).toBe(0);
    expect(rpmIsUnprovenZero(decoded.motors[0], DSHOT_ONLY)).toBe(false);
  });

  it('never hides a NON-zero reading, whatever the stats flag reports', () => {
    /*
     * USE_DSHOT_TELEMETRY_STATS is optional. A build without it leaves
     * invalidPct at 10000 forever, so hiding on that field alone would
     * blank working telemetry. A moving motor is proof in itself.
     */
    const spinning: VirtualEsc = {...silent, rpm: 4111, invalidPct: 10000};
    const decoded = decodeMotorTelemetry(motorTelemetryFrame([spinning]));
    expect(
      visibleMotorTelemetryMetrics(decoded.motors[0], DSHOT_ONLY).rpm,
    ).toBe(4111);
    expect(rpmIsUnprovenZero(decoded.motors[0], DSHOT_ONLY)).toBe(false);
  });

  it('trusts a serial ESC sensor zero, because that record means at rest', () => {
    const decoded = decodeMotorTelemetry(motorTelemetryFrame([silent]));
    expect(
      visibleMotorTelemetryMetrics(decoded.motors[0], ESC_SENSOR).rpm,
    ).toBe(0);
    expect(rpmIsUnprovenZero(decoded.motors[0], ESC_SENSOR)).toBe(false);
  });

  it('shows nothing at all when the board proved there is no source', () => {
    // Betaflight still answers command 139 with a well-formed all-zero
    // frame in this configuration. A successful reply is not evidence.
    const decoded = decodeMotorTelemetry(motorTelemetryFrame(BENCH));
    const visible = visibleMotorTelemetryMetrics(decoded.motors[0], NO_SOURCE);
    expect(visible).toEqual({
      rpm: undefined,
      invalidPercentRaw: undefined,
      temperatureCelsius: undefined,
      voltageVolts: undefined,
      currentAmps: undefined,
      consumptionMah: undefined,
    });
    expect(rpmIsUnprovenZero(decoded.motors[0], NO_SOURCE)).toBe(false);
  });
});
