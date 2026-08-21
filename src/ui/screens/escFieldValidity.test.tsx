/**
 * A PACKET IS NOT A MEASUREMENT.
 *
 * THE PHOTOGRAPH THIS FILE EXISTS FOR. A real flight controller, session
 * open, motor control allowed, M2 commanded to 1033 and the rest at 1000.
 * The ESC telemetry section said "مباشر", and every output read:
 *
 *     0 RPM · 0°C · 0.00V · 0.00A · 0mAh
 *
 * Not one of those was a measurement. FEATURE_ESC_SENSOR was enabled in the
 * configuration, no serial ESC frame had ever arrived, and every number was
 * a zero-initialised struct field that Betaflight copies onto the wire
 * without its own validity marker.
 *
 * THE FIRMWARE'S OWN EVIDENCE, read at betaflight/betaflight:
 *
 *   sensors/esc_sensor.h:33-42   escSensorData_t carries `uint8_t dataAge`
 *                                and `#define ESC_DATA_INVALID 255`.
 *   sensors/esc_sensor.c:222-226 escSensorInit() sets dataAge =
 *                                ESC_DATA_INVALID for every motor and
 *                                leaves the five values at static zero.
 *   sensors/esc_sensor.c:287-288 dataAge climbs back toward
 *                                ESC_DATA_INVALID whenever a frame is
 *                                missed.
 *   sensors/esc_sensor.c:263-268 only a decoded frame sets dataAge = 0 and
 *                                writes temperature, voltage, current,
 *                                consumption and rpm TOGETHER.
 *   sensors/esc_sensor.c:156-163 getEscSensorData() returns the struct
 *                                whatever dataAge says.
 *   msp/msp.c (case MSP_MOTOR_TELEMETRY, :1254-1265 on 4.5-maintenance and
 *                                :1337-1348 on master, byte-identical)
 *                                copies the four extended fields out of it
 *                                with NO age check.
 *
 * So dataAge never reaches the wire, and "all five zero" is exactly what a
 * port that has never received anything produces. The five fields are
 * written by one frame decode, so one non-zero field proves a frame
 * arrived - and only then is a zero beside it a reading.
 *
 * THE DSHOT SIDE IS A SEPARATE CONTRACT and is not merged with it. The
 * firmware writes the extended DShot fields only when the matching bit is
 * set in `telemetryTypes`, and never writes consumption on that path at
 * all. There is no presence bit on the wire, so a DShot zero in
 * temperature, voltage or current is not shown.
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import '../../i18n';
import i18n from '../../i18n';
import type {TelemetryValue} from '../../core';
import type {MspMotorTelemetryEntry} from '../../core/protocol/msp/decoding/decodeMotorTelemetry';
import {
  escSensorConfiguredButSilent,
  escTelemetryHasValidMeasurement,
  visibleMotorTelemetryMetrics,
  type MotorDiagnosticsSupport,
} from '../../core/state/motorDiagnosticsSemantics';
import {MotorDiagnosticsPanel} from './MotorDiagnosticsPanel';

let mockOutputValue: TelemetryValue<unknown> = {status: 'UNAVAILABLE'};
let mockEscValue: TelemetryValue<unknown> = {status: 'UNAVAILABLE'};

jest.mock('../../platforms/react-native/protocol', () => ({
  acquireMotorDiagnosticsTelemetry: jest.fn(() => () => undefined),
  getMotorDiagnosticsAvailability: jest.fn(() => ({
    outputs: 'ACTIVE',
    escTelemetry: 'ACTIVE',
  })),
  getMotorDiagnosticsSupport: jest.fn(() => undefined),
  subscribeMotorDiagnosticsAvailability: jest.fn(() => () => undefined),
  MOTOR_OUTPUTS_TELEMETRY_POLL_ID: 'motorOutputs',
  MOTOR_ESC_TELEMETRY_POLL_ID: 'motorEscTelemetry',
  useTelemetryValue: jest.fn((_sessionId: string, pollId: string) =>
    pollId === 'motorOutputs' ? mockOutputValue : mockEscValue,
  ),
}));

beforeAll(async () => {
  if (!i18n.isInitialized) await i18n.init();
});
beforeEach(() => {
  mockOutputValue = {status: 'UNAVAILABLE'};
  mockEscValue = {status: 'UNAVAILABLE'};
});

/* ================================================================== *
 * SOURCES AND RECORDS
 * ================================================================== */

const DSHOT: MotorDiagnosticsSupport = Object.freeze({
  motorCount: 4,
  dshotTelemetryEnabled: true,
  escSensorEnabled: false,
  escTelemetrySource: 'BIDIRECTIONAL_DSHOT',
});
const ESC_SENSOR: MotorDiagnosticsSupport = Object.freeze({
  motorCount: 4,
  dshotTelemetryEnabled: false,
  escSensorEnabled: true,
  escTelemetrySource: 'ESC_SENSOR',
});
const BOTH: MotorDiagnosticsSupport = Object.freeze({
  motorCount: 4,
  dshotTelemetryEnabled: true,
  escSensorEnabled: true,
  escTelemetrySource: 'BIDIRECTIONAL_DSHOT_AND_ESC_SENSOR',
});

function record(
  fields: Partial<MspMotorTelemetryEntry> = {},
): MspMotorTelemetryEntry {
  return Object.freeze({
    rpm: 0,
    invalidPercentRaw: 0,
    temperatureCelsius: 0,
    voltageCentivolts: 0,
    currentCentiamps: 0,
    consumptionMah: 0,
    ...fields,
  });
}

/** Exactly what escSensorInit() leaves behind on every output. */
const NEVER_RECEIVED = record();

const NOTHING_VISIBLE = {
  rpm: undefined,
  invalidPercentRaw: undefined,
  temperatureCelsius: undefined,
  voltageVolts: undefined,
  currentAmps: undefined,
  consumptionMah: undefined,
};

/* ================================================================== *
 * 1-9: THE MANDATORY CASES, AT THE SEMANTICS BOUNDARY
 * ================================================================== */

describe('a zero is only a measurement when its own source says so', () => {
  it('1. source enabled, packet received, all zeros - nothing is valid', () => {
    expect(visibleMotorTelemetryMetrics(NEVER_RECEIVED, ESC_SENSOR)).toEqual(
      NOTHING_VISIBLE,
    );
    expect(
      escTelemetryHasValidMeasurement([NEVER_RECEIVED], ESC_SENSOR),
    ).toBe(false);
    expect(escSensorConfiguredButSilent([NEVER_RECEIVED], ESC_SENSOR)).toBe(
      true,
    );
  });

  it('2. DShot with a valid RPM only - the unsupported fields stay absent', () => {
    const metrics = visibleMotorTelemetryMetrics(
      record({rpm: 4230, invalidPercentRaw: 120}),
      DSHOT,
    );
    expect(metrics.rpm).toBe(4230);
    expect(metrics.invalidPercentRaw).toBe(120);
    expect(metrics.temperatureCelsius).toBeUndefined();
    expect(metrics.voltageVolts).toBeUndefined();
    expect(metrics.currentAmps).toBeUndefined();
    // The DShot branch never writes consumption at all.
    expect(metrics.consumptionMah).toBeUndefined();
  });

  it('3. DShot with extended temperature - RPM and temperature, nothing else', () => {
    const metrics = visibleMotorTelemetryMetrics(
      record({rpm: 4230, invalidPercentRaw: 120, temperatureCelsius: 47}),
      DSHOT,
    );
    expect(metrics.rpm).toBe(4230);
    expect(metrics.temperatureCelsius).toBe(47);
    expect(metrics.voltageVolts).toBeUndefined();
    expect(metrics.currentAmps).toBeUndefined();
    expect(metrics.consumptionMah).toBeUndefined();
  });

  it('4. DShot extended voltage and current keep the firmware units', () => {
    // msp.c: voltage is telemetryData >> 2, i.e. WHOLE VOLTS after the
    // firmware's own conversion; current is "0-255A step 1A". Neither is
    // hundredths, and neither may borrow the ESC sensor's divisor.
    const metrics = visibleMotorTelemetryMetrics(
      record({
        rpm: 4230,
        invalidPercentRaw: 120,
        voltageCentivolts: 16,
        currentCentiamps: 3,
      }),
      DSHOT,
    );
    expect(metrics.voltageVolts).toBe(16);
    expect(metrics.currentAmps).toBe(3);
    expect(metrics.temperatureCelsius).toBeUndefined();
    expect(metrics.consumptionMah).toBeUndefined();
  });

  it('5. ESC_SENSOR reports a true stopped-motor zero once a frame proves it', () => {
    // A frame arrived: voltage 16.55V and temperature 28C are in the same
    // record, so the rpm zero beside them is a measurement of a motor at
    // rest - and it is shown.
    const metrics = visibleMotorTelemetryMetrics(
      record({
        rpm: 0,
        invalidPercentRaw: 10_000,
        temperatureCelsius: 28,
        voltageCentivolts: 1655,
        currentCentiamps: 0,
        consumptionMah: 0,
      }),
      ESC_SENSOR,
    );
    expect(metrics.rpm).toBe(0);
    expect(metrics.temperatureCelsius).toBe(28);
    expect(metrics.voltageVolts).toBeCloseTo(16.55, 5);
    // Zero current and zero consumption on a PROVEN record are readings.
    expect(metrics.currentAmps).toBe(0);
    expect(metrics.consumptionMah).toBe(0);
    // The DShot invalid-packet rate is not an ESC-sensor fact.
    expect(metrics.invalidPercentRaw).toBeUndefined();
  });

  it('8. one talking output does not lend its validity to the silent three', () => {
    const motors = [
      NEVER_RECEIVED,
      record({rpm: 4230, temperatureCelsius: 41, voltageCentivolts: 1620}),
      NEVER_RECEIVED,
      NEVER_RECEIVED,
    ];
    const visible = motors.map(motor =>
      visibleMotorTelemetryMetrics(motor, ESC_SENSOR),
    );
    expect(visible.map(m => m.rpm)).toEqual([undefined, 4230, undefined, undefined]);
    expect(visible.map(m => m.temperatureCelsius)).toEqual([
      undefined,
      41,
      undefined,
      undefined,
    ]);
    // The section as a whole DOES have a measurement...
    expect(escTelemetryHasValidMeasurement(motors, ESC_SENSOR)).toBe(true);
    // ...and is no longer "every output silent".
    expect(escSensorConfiguredButSilent(motors, ESC_SENSOR)).toBe(false);
  });

  it('both sources on: DShot owns RPM and its sentinel is not exempted', () => {
    // THE SECOND HALF OF THE SAME DEFECT. rpm comes from bidirectional
    // DShot when it is on ("We want DSHOT telemetry RPM data (if
    // available) to have precedence"), so the 10000 sentinel decides it -
    // it used to be skipped entirely because the ESC sensor flag was
    // checked first.
    expect(
      visibleMotorTelemetryMetrics(
        record({rpm: 0, invalidPercentRaw: 10_000}),
        BOTH,
      ).rpm,
    ).toBeUndefined();
    // And a DShot rpm still shows while the serial record is silent.
    const mixed = visibleMotorTelemetryMetrics(
      record({rpm: 5120, invalidPercentRaw: 30}),
      BOTH,
    );
    expect(mixed.rpm).toBe(5120);
    expect(mixed.temperatureCelsius).toBeUndefined();
    expect(mixed.voltageVolts).toBeUndefined();
  });
});

/* ================================================================== *
 * THE PHOTOGRAPH, RENDERED
 * ================================================================== */

/** The ESC section's own state word. The OUTPUTS badge at the top of the
 * panel is a different channel with its own - correct - "مباشر", so a
 * whole-tree search for the word would test the wrong thing. */
function escChannelWord(tree: ReactTestRenderer.ReactTestRenderer): string {
  const node = tree.root.findAllByProps({
    testID: 'esc-telemetry-channel-state',
  })[0];
  return JSON.stringify(node?.props?.children ?? '');
}

function renderPanel(props: {
  readonly support?: MotorDiagnosticsSupport;
}): ReactTestRenderer.ReactTestRenderer {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(
      <MotorDiagnosticsPanel sessionId="fc-bench" support={props.support} />,
    );
  });
  return tree;
}

describe('the screen that produced the photograph', () => {
  /** M2 commanded to 1033, the rest resting at 1000 - as in the picture. */
  const OUTPUTS: TelemetryValue<unknown> = {
    status: 'FRESH',
    value: {values: [1000, 1033, 1000, 1000, 0, 0, 0, 0]},
    updatedAtMs: 1,
  };

  it('never prints a zero it cannot defend, and never calls it مباشر', () => {
    mockOutputValue = OUTPUTS;
    mockEscValue = {
      status: 'FRESH',
      value: {motorCount: 4, motors: [0, 1, 2, 3].map(() => NEVER_RECEIVED)},
      updatedAtMs: 1,
    };
    const tree = renderPanel({support: ESC_SENSOR});
    const text = JSON.stringify(tree.toJSON());

    // NOT ONE OF THE FIVE ZEROS FROM THE PHOTOGRAPH.
    expect(text).not.toContain('0 RPM');
    expect(text).not.toContain('حرارة 0°C');
    expect(text).not.toContain('جهد 0.00V');
    expect(text).not.toContain('تيار 0.00A');
    expect(text).not.toContain('استهلاك 0mAh');
    // AND NOT THE WORD - on the ESC channel, which is the one making the
    // claim. (The motor-output channel above is genuinely live and keeps
    // its own badge; that is a different fact about a different reading.)
    expect(escChannelWord(tree)).not.toContain('مباشر');
    expect(escChannelWord(tree)).toContain('بانتظار بيانات ESC');
    expect(
      tree.root.findAllByProps({testID: 'esc-telemetry-sensor-silent'}).length,
    ).toBeGreaterThan(0);

    // 9. THE OUTPUT VALUE IS NOT EVIDENCE. M2 is commanded to 1033 and the
    // panel still reports no RPM for it - a commanded output says what the
    // flight controller is sending, never what an ESC is measuring.
    expect(text).toContain('1033');
    act(() => tree.unmount());
  });

  it('7. a reading that goes stale stops being called مباشر', () => {
    mockOutputValue = OUTPUTS;
    mockEscValue = {
      status: 'STALE',
      value: {
        motorCount: 4,
        motors: [record({rpm: 4230, invalidPercentRaw: 40})],
      },
      updatedAtMs: 1,
      ageMs: 4_000,
    };
    const tree = renderPanel({support: DSHOT});
    expect(escChannelWord(tree)).toContain('قراءة قديمة');
    expect(escChannelWord(tree)).not.toContain('مباشر');
    act(() => tree.unmount());
  });

  it('keeps مباشر when a field really is valid', () => {
    // THE OTHER DIRECTION, so this is not a test that simply deletes a
    // word: one proven record and the live label is correct again.
    mockOutputValue = OUTPUTS;
    mockEscValue = {
      status: 'FRESH',
      value: {
        motorCount: 4,
        motors: [
          record({rpm: 4230, invalidPercentRaw: 40}),
          record({rpm: 4310, invalidPercentRaw: 40}),
          record({rpm: 4180, invalidPercentRaw: 40}),
          record({rpm: 4260, invalidPercentRaw: 40}),
        ],
      },
      updatedAtMs: 1,
    };
    const tree = renderPanel({support: DSHOT});
    const text = JSON.stringify(tree.toJSON());
    expect(escChannelWord(tree)).toContain('مباشر');
    expect(text).toContain('4230 RPM');
    expect(escChannelWord(tree)).not.toContain('بانتظار');
    act(() => tree.unmount());
  });

  it('6. a configured source with no packet yet is waiting, not live', () => {
    mockOutputValue = OUTPUTS;
    mockEscValue = {status: 'WAITING'};
    const tree = renderPanel({support: ESC_SENSOR});
    const text = JSON.stringify(tree.toJSON());
    expect(escChannelWord(tree)).toContain('في انتظار أول قراءة');
    expect(escChannelWord(tree)).not.toContain('مباشر');
    expect(text).not.toContain('0 RPM');
    // And it does not tell an operator to enable what is already enabled.
    expect(text).not.toContain('فعّل تليمترية DShot');
    expect(text).toContain('بانتظار بيانات ESC');
    act(() => tree.unmount());
  });
});
