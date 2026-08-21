/**
 * THE ESC / RPM TELEMETRY PRODUCTION PATH, END TO END.
 *
 * WHAT THIS ANSWERS. A person connected a real flight controller, spun
 * motors, waited, and saw no RPM. Every previous round proved a PIECE of
 * the path: the decoder decodes, the semantics hide an unproven zero, the
 * panel renders what it is given. None of them proved the WHOLE path -
 * that a byte leaving a flight controller arrives in the snapshot the
 * Motors screen reads, attributed to the right motor, at the right scale.
 *
 * So this drives the REAL stack. The only thing replaced is the USB
 * device itself:
 *
 *   virtual FC (this file)  ->  MspSessionCoordinator  ->  MSP framing
 *   ->  decodeMotorTelemetry  ->  MotorTestController.runDiagnosticsRefresh
 *   ->  published snapshot.diagnostics.escTelemetry
 *
 * EXPECTED BYTES ARE HAND-WRITTEN FROM THE PUBLISHED CONTRACT, never
 * produced by our own encoder. `Wire` below writes little-endian integers
 * by hand, and the MSP_MOTOR_TELEMETRY frame is laid out from
 * betaflight/betaflight src/main/msp/msp.c, case MSP_MOTOR_TELEMETRY,
 * which is byte-identical on 4.5-maintenance (API 1.47) and master
 * (API_VERSION_MINOR 49):
 *
 *   sbufWriteU8 (dst, getMotorCount());
 *   for each motor:
 *     sbufWriteU32(dst, (rpmDataAvailable ? rpm : 0));   // mechanical RPM
 *     sbufWriteU16(dst, invalidPct);                     // 10000 = 100.00%
 *     sbufWriteU8 (dst, escTemperature);                 // degrees C
 *     sbufWriteU16(dst, escVoltage);
 *     sbufWriteU16(dst, escCurrent);
 *     sbufWriteU16(dst, escConsumption);
 *
 * and cross-checked against betaflight-configurator
 * src/js/msp/MSPHelper.js, case MSPCodes.MSP_MOTOR_TELEMETRY, which reads
 * exactly readU8, then per motor readU32/readU16/readU8/readU16/readU16/
 * readU16.
 *
 * THE RPM ON THE WIRE IS ALREADY MECHANICAL. The firmware writes
 * `getDshotRpm(i)`, and `dshotRpm[k] = erpmToRpm(value)` where
 * `erpmToRpm(erpm) = erpm * erpmToHz * SECONDS_PER_MINUTE` and
 * `erpmToHz = ERPM_PER_LSB / SECONDS_PER_MINUTE / (motorPoleCount / 2)`
 * (src/main/drivers/dshot.c). The pole count is applied INSIDE the flight
 * controller. An app that divided by poles again would report a wrong
 * number, so this file also proves that we do not.
 */

import {
  MSP_ADVANCED_CONFIG,
  MSP_API_VERSION,
  MSP_BOARD_INFO,
  MSP_BOXIDS,
  MSP_FC_VARIANT,
  MSP_FEATURE_CONFIG,
  MSP_MIXER_CONFIG,
  MSP_MOTOR,
  MSP_MOTOR_3D_CONFIG,
  MSP_MOTOR_CONFIG,
  MSP_MOTOR_TELEMETRY,
  MSP_STATUS_EX,
} from '../../../core';
import {buildMspFrameBytes} from '../../../core/protocol/__testUtils__/mspFixtures';
import {ARMING_DISABLE_FLAG_TOKENS} from '../../../core/state/armingBlockers';
import {MSP_SET_ARMING_DISABLED} from '../../../core/state/motorArmingRestriction';
import {
  hasEscTelemetrySource,
  rpmIsUnprovenZero,
  visibleMotorTelemetryMetrics,
} from '../../../core/state/motorDiagnosticsSemantics';
import {base64ToBytes, bytesToBase64} from './base64';
import {
  acquireMotorDiagnosticsTelemetry,
  getMotorDiagnosticsAvailability,
  getMotorDiagnosticsSupport,
  MOTOR_ESC_TELEMETRY_POLL_ID,
} from './motorDiagnosticsTelemetry';
import {readMotorTestCapability} from './motorTestCapability';
import {
  MspSessionCoordinator,
  mspSessionCoordinator,
} from './MspSessionCoordinator';
import type {
  UsbSerialDataEvent,
  UsbSerialTransportClient,
} from '../transport';

/* ================================================================== *
 * A BYTE WRITER THAT KNOWS NOTHING ABOUT OUR ENCODER
 * ================================================================== */

class Wire {
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
  ascii(text: string): this {
    for (const character of text) this.u8(character.charCodeAt(0));
    return this;
  }
  pstring(text: string): this {
    this.u8(text.length);
    return this.ascii(text);
  }
  repeat(value: number, count: number): this {
    for (let index = 0; index < count; index += 1) this.u8(value);
    return this;
  }
  done(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

/** The bench: four distinct readings that cannot be confused for one another. */
interface BenchMotor {
  readonly rpm: number;
  readonly temperatureCelsius: number;
}

const BENCH: readonly BenchMotor[] = Object.freeze([
  Object.freeze({rpm: 1234, temperatureCelsius: 31}),
  Object.freeze({rpm: 2789, temperatureCelsius: 42}),
  Object.freeze({rpm: 4111, temperatureCelsius: 53}),
  Object.freeze({rpm: 5678, temperatureCelsius: 64}),
]);

/**
 * MSP_MOTOR_TELEMETRY (139), written from the firmware's own sbufWrite
 * sequence. `silent` is Betaflight's "bidirectional DShot is on and not
 * one valid packet has arrived": rpm 0 with invalidPct at the 10000
 * (100.00%) default the firmware assigns before any stats replace it.
 */
function motorTelemetryPayload(
  motors: readonly BenchMotor[],
  options: {readonly silent?: boolean} = {},
): Uint8Array {
  const wire = new Wire().u8(motors.length);
  for (const motor of motors) {
    wire.u32(options.silent === true ? 0 : motor.rpm);
    wire.u16(options.silent === true ? 10_000 : 0);
    wire.u8(options.silent === true ? 0 : motor.temperatureCelsius);
    wire.u16(0);
    wire.u16(0);
    wire.u16(0);
  }
  return wire.done();
}

/**
 * MSP_MOTOR_CONFIG (131), from msp.c case MSP_MOTOR_CONFIG:
 *   u16 0 (was minthrottle), u16 maxthrottle, u16 mincommand,
 *   u8 getMotorCount(), u8 motorPoleCount,
 *   u8 useDshotTelemetry, u8 featureIsEnabled(FEATURE_ESC_SENSOR)
 */
function motorConfigPayload(options: {
  readonly dshotBidir: boolean;
  readonly escSensor: boolean;
  readonly poles?: number;
  readonly motorCount?: number;
}): Uint8Array {
  return new Wire()
    .u16(0)
    .u16(2000)
    .u16(1000)
    .u8(options.motorCount ?? 4)
    .u8(options.poles ?? 14)
    .u8(options.dshotBidir ? 1 : 0)
    .u8(options.escSensor ? 1 : 0)
    .done();
}

/* ================================================================== *
 * THE VIRTUAL FLIGHT CONTROLLER
 * ================================================================== */

const SESSION_ID = 'esc-telemetry-bench';
/** The scheduler tests drive the module SINGLETON, which is what the
 * Motors screen uses. Each test gets its own session id so no test can
 * inherit another's coordinator state. */
let schedulerSessionSeq = 0;

const sleep = (millis: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, millis));

/** The bit Betaflight sets in armingDisableFlags for an MSP-held disable. */
const ARMING_DISABLED_MSP_BIT = ARMING_DISABLE_FLAG_TOKENS.indexOf('MSP');

/**
 * One MSP request as it actually left the app, decoded from the wire
 * without using our encoder: `$M<` v1, `$X<` v2-native, and the v2-over-v1
 * envelope the transport may pick for a longer frame.
 */
interface DecodedRequest {
  readonly command: number;
  readonly payload: Uint8Array;
  readonly wireFormat: 'v1' | 'v2' | 'v2-over-v1';
}

const MSP_V2_FRAME_ID_BYTE = 0xff;

function decodeRequestFrame(bytes: Uint8Array): DecodedRequest | undefined {
  if (bytes.length < 6 || bytes[0] !== 0x24) return undefined;
  if (bytes[1] === 0x58) {
    // $X< : flag, u16 command, u16 size.
    const command = bytes[4] | (bytes[5] << 8);
    const size = bytes[6] | (bytes[7] << 8);
    return {command, payload: bytes.slice(8, 8 + size), wireFormat: 'v2'};
  }
  if (bytes[1] !== 0x4d) return undefined;
  const size = bytes[3];
  const command = bytes[4];
  if (command === MSP_V2_FRAME_ID_BYTE) {
    // v2 carried inside a v1 envelope: flag, u16 command, u16 size.
    const inner = bytes.subarray(5);
    const innerCommand = inner[1] | (inner[2] << 8);
    const innerSize = inner[3] | (inner[4] << 8);
    return {
      command: innerCommand,
      payload: inner.slice(5, 5 + innerSize),
      wireFormat: 'v2-over-v1',
    };
  }
  return {command, payload: bytes.slice(5, 5 + size), wireFormat: 'v1'};
}

class VirtualFlightController {
  readonly requested: number[] = [];
  readonly writes: {readonly command: number; readonly payload: number[]}[] = [];
  /**
   * The flight controller's OWN arming state, changed only by a real
   * command-99 frame arriving on the wire. Nothing in the test sets it
   * directly, so "the restriction was established" is a fact this bench
   * observed rather than one it granted.
   */
  private armingDisabledByMsp = false;
  private readonly listeners = new Set<(event: UsbSerialDataEvent) => void>();
  private readonly responses = new Map<number, Uint8Array>();

  private readonly ackUnknownCommands: boolean;
  private readonly sessionId: string;

  constructor(options: {
    readonly dshotBidir: boolean;
    readonly escSensor: boolean;
    readonly telemetry?: Uint8Array;
    readonly motorCount?: number;
    /**
     * The canonical telemetry scheduler runs polls this bench has no
     * canned reply for (attitude, battery, ...). On a serialized MSP queue
     * silence means a full timeout each, and the queue stalls long before
     * the motor polls are reached. Answering an unknown command with an
     * empty frame keeps the QUEUE honest without inventing any value: an
     * empty payload fails its decoder, so those polls report errors -
     * exactly what a board that does not implement them would produce.
     */
    readonly ackUnknownCommands?: boolean;
    /** Which session the emitted frames belong to. */
    readonly sessionId?: string;
  }) {
    this.ackUnknownCommands = options.ackUnknownCommands === true;
    this.sessionId = options.sessionId ?? SESSION_ID;
    this.responses.set(MSP_API_VERSION, new Wire().u8(0).u8(1).u8(47).done());
    this.responses.set(MSP_FC_VARIANT, new Wire().ascii('BTFL').done());
    this.responses.set(
      MSP_BOARD_INFO,
      new Wire()
        .ascii('SPBE')
        .u16(0)
        .u8(0)
        .u8(0)
        .pstring('S405')
        .pstring('SPEEDYBEEF405V3')
        .pstring('SPBE')
        .repeat(0, 32)
        .u8(0)
        .done(),
    );
    this.responses.set(MSP_BOXIDS, new Wire().u8(0).u8(1).u8(2).done());
    this.responses.set(
      MSP_MOTOR_CONFIG,
      motorConfigPayload({
        dshotBidir: options.dshotBidir,
        escSensor: options.escSensor,
        motorCount: options.motorCount,
      }),
    );
    this.responses.set(
      MSP_MOTOR_3D_CONFIG,
      new Wire().u16(1406).u16(1514).u16(1460).done(),
    );
    this.responses.set(MSP_MIXER_CONFIG, new Wire().u8(3).u8(0).done());
    this.responses.set(
      MSP_ADVANCED_CONFIG,
      new Wire()
        .u8(1)
        .u8(1)
        .u8(0)
        .u8(6) // DSHOT600
        .u16(480)
        .u16(550)
        .u8(0)
        .u8(0)
        .u8(0)
        .u8(0)
        .u8(32)
        .u16(125)
        .u16(0)
        .u8(0)
        .u8(0)
        .u8(60)
        .done(),
    );
    this.responses.set(MSP_FEATURE_CONFIG, new Wire().u32(0x10).done());
    this.responses.set(
      MSP_MOTOR,
      new Wire()
        .u16(1090)
        .u16(1105)
        .u16(1078)
        .u16(1120)
        .u16(0)
        .u16(0)
        .u16(0)
        .u16(0)
        .done(),
    );
    if (options.telemetry !== undefined) {
      this.responses.set(MSP_MOTOR_TELEMETRY, options.telemetry);
    }
  }

  /**
   * MSP_STATUS_EX (150), built fresh on every request so it reports the
   * CURRENT arming state - exactly the property the restriction contract
   * depends on. Layout from msp.c case MSP_STATUS_EX:
   *   u16 cycleTime, u16 i2cErrorCount, u16 sensorMask,
   *   u32 flightModeFlags(low32), u8 pidProfileIndex, u16 cpuLoad,
   *   u8 pidProfileCount, u8 rateProfileIndex, u8 extraModeByteCount,
   *   u8 ARMING_DISABLE_FLAGS_COUNT, u32 armingDisableFlags,
   *   u8 configState, u16 cpuTemp
   */
  private statusExPayload(): Uint8Array {
    const armingDisableFlags = this.armingDisabledByMsp
      ? Math.pow(2, ARMING_DISABLED_MSP_BIT)
      : 0;
    return new Wire()
      .u16(312)
      .u16(0)
      .u16(0x2f)
      .u32(0) // no active box bits - DISARMED
      .u8(0)
      .u16(17)
      .u8(4)
      .u8(0)
      .u8(0)
      .u8(ARMING_DISABLE_FLAG_TOKENS.length)
      .u32(armingDisableFlags)
      .u8(0)
      .u16(250)
      .done();
  }

  private respondTo(request: DecodedRequest): Uint8Array | undefined {
    if (request.command === MSP_STATUS_EX) return this.statusExPayload();
    if (request.command === MSP_SET_ARMING_DISABLED) {
      // msp.c case MSP_SET_ARMING_DISABLED: a non-zero first byte sets the
      // MSP arming-disable flag, zero clears it. The reply is a bare ACK.
      this.armingDisabledByMsp = (request.payload[0] ?? 0) !== 0;
      return new Uint8Array(0);
    }
    return this.responses.get(request.command);
  }

  readonly client: UsbSerialTransportClient = {
    writeBytes: (_sessionId: string, dataBase64: string) => {
      const request = decodeRequestFrame(base64ToBytes(dataBase64));
      if (request === undefined) return Promise.resolve(undefined);
      this.requested.push(request.command);
      if (request.payload.length > 0) {
        this.writes.push({
          command: request.command,
          payload: Array.from(request.payload),
        });
      }
      const payload =
        this.respondTo(request) ??
        (this.ackUnknownCommands ? new Uint8Array(0) : undefined);
      if (payload === undefined) {
        // A flight controller that does not implement a command stays
        // silent here; nothing is invented on its behalf.
        return Promise.resolve(undefined);
      }
      const frame = buildMspFrameBytes(request.command, payload, {
        wireFormat: request.wireFormat,
        direction: 'response',
      });
      Promise.resolve().then(() => {
        for (const listener of Array.from(this.listeners)) {
          listener({
            sessionId: this.sessionId,
            dataBase64: bytesToBase64(frame),
          });
        }
      });
      return Promise.resolve(undefined);
    },
    onDataReceived: (listener: (event: UsbSerialDataEvent) => void) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },
    onSessionDetached: () => () => undefined,
    onDeviceDetached: () => () => undefined,
    onError: () => () => undefined,
    startReading: () => Promise.resolve(undefined),
    stopReading: () => Promise.resolve(undefined),
    closeSession: () => Promise.resolve(undefined),
  } as unknown as UsbSerialTransportClient;
}

const settle = async (turns = 60): Promise<void> => {
  for (let index = 0; index < turns; index += 1) {
    await Promise.resolve();
  }
};

/* ================================================================== *
 * THE EXPECTED BYTES, ASSERTED AS BYTES
 * ================================================================== */

describe('the MSP_MOTOR_TELEMETRY frame this bench sends', () => {
  it('is laid out exactly as the firmware writes it', () => {
    const payload = motorTelemetryPayload(BENCH);
    // 1 count byte + 4 motors x 13 bytes.
    expect(payload).toHaveLength(1 + 4 * 13);
    expect(payload[0]).toBe(4);
    // M1's RPM, little-endian u32: 1234 = 0x000004D2.
    expect(Array.from(payload.slice(1, 5))).toEqual([0xd2, 0x04, 0x00, 0x00]);
    // M2's RPM starts 13 bytes later: 2789 = 0x00000AE5.
    expect(Array.from(payload.slice(14, 18))).toEqual([0xe5, 0x0a, 0x00, 0x00]);
    // M3: 4111 = 0x0000100F. M4: 5678 = 0x0000162E.
    expect(Array.from(payload.slice(27, 31))).toEqual([0x0f, 0x10, 0x00, 0x00]);
    expect(Array.from(payload.slice(40, 44))).toEqual([0x2e, 0x16, 0x00, 0x00]);
    // Temperature is the 8th byte of each 13-byte record.
    expect(payload[7]).toBe(31);
    expect(payload[20]).toBe(42);
    expect(payload[33]).toBe(53);
    expect(payload[46]).toBe(64);
  });

  it('writes the firmware default for a stream that never arrived', () => {
    const payload = motorTelemetryPayload(BENCH, {silent: true});
    // rpm 0 ...
    expect(Array.from(payload.slice(1, 5))).toEqual([0x00, 0x00, 0x00, 0x00]);
    // ...and invalidPct at 10000 = 0x2710, little-endian.
    expect(Array.from(payload.slice(5, 7))).toEqual([0x10, 0x27]);
  });
});

/* ================================================================== *
 * THE WHOLE PATH
 * ================================================================== */

describe('a reading leaving the flight controller reaches the Motors snapshot', () => {
  let coordinator: MspSessionCoordinator;

  afterEach(async () => {
    await coordinator?.deactivateMspSession?.(SESSION_ID);
  });

  interface BenchOptions {
    readonly dshotBidir: boolean;
    readonly escSensor: boolean;
    readonly telemetry?: Uint8Array;
    readonly motorCount?: number;
  }

  async function bench(options: BenchOptions) {
    const fc = new VirtualFlightController(options);
    coordinator = new MspSessionCoordinator();
    coordinator.openSession(fc.client, SESSION_ID);
    await settle();
    return {fc, coordinator};
  }

  /** Opens a real motor-test session through the real capability. */
  async function openMotorTest(fcOptions: BenchOptions) {
    const {fc} = await bench(fcOptions);
    const capability = readMotorTestCapability(SESSION_ID);
    if (capability === undefined) {
      throw new Error('no motor-test capability for an identified session');
    }
    const operator = capability.operatorPort(
      {
        readCurrentIdentity: () =>
          coordinator.getMotorTestSessionIdentity(SESSION_ID),
        readFirmwareIdentification: () =>
          coordinator.getIdentificationState(SESSION_ID),
        subscribeFirmwareIdentification: listener =>
          coordinator.subscribeIdentificationState(listener),
        subscribeSessionInvalidated: listener =>
          coordinator.subscribeMotorTestSessionInvalidated(SESSION_ID, listener),
      },
      () => Date.now(),
    );
    const begun = await operator.beginSession();
    await settle();
    // EVERY test below inherits this. Without it, "command 139 was never
    // requested" would also be true of a session that never opened, and a
    // dead session would read as a proof about telemetry. It is not.
    if (begun.phase !== 'ACTIVE') {
      throw new Error(
        `the motor-test session did not open: ${JSON.stringify({
          phase: begun.phase,
          setupStep: begun.setupStep,
          outcome: begun.outcome,
        })}`,
      );
    }
    return {fc, operator, begun};
  }

  it('opens a real session and reports which source the controller proved', async () => {
    const {fc, operator, begun} = await openMotorTest({
      dshotBidir: true,
      escSensor: false,
      telemetry: motorTelemetryPayload(BENCH),
    });
    // THIS IS THE REAL SETUP PATH, not a shortcut into it: the session
    // read the motor configuration off the wire and wrote the FC-side
    // arming restriction, which this bench honoured as a real FC would.
    expect(fc.requested).toContain(MSP_MOTOR_CONFIG);
    expect(
      fc.writes.filter(write => write.command === MSP_SET_ARMING_DISABLED),
    ).toEqual([{command: MSP_SET_ARMING_DISABLED, payload: [1]}]);
    // The whole point of the audit: the SOURCE model comes from
    // MSP_MOTOR_CONFIG, not from a successful command-139 reply.
    expect(begun.motorDiagnosticsSupport).toEqual({
      motorCount: 4,
      dshotTelemetryEnabled: true,
      escSensorEnabled: false,
      escTelemetrySource: 'BIDIRECTIONAL_DSHOT',
    });
    expect({
      phase: begun.phase,
      setupStep: begun.setupStep,
      outcome: begun.outcome,
    }).toEqual({phase: 'ACTIVE', setupStep: 'READY', outcome: {kind: 'READY'}});
    await operator.endSession();
  });

  it('carries M1..M4 to M1..M4, at the scale the firmware sent', async () => {
    const {fc, operator} = await openMotorTest({
      dshotBidir: true,
      escSensor: false,
      telemetry: motorTelemetryPayload(BENCH),
    });
    const diagnostics = await operator.refreshDiagnostics();
    await settle();

    // It was actually asked for.
    expect(fc.requested).toContain(MSP_MOTOR_TELEMETRY);
    expect(diagnostics.escTelemetry.state).toBe('FRESH');
    const motors = diagnostics.escTelemetry.value?.motors ?? [];
    expect(motors).toHaveLength(4);
    // THE MAPPING. Entry i is M(i+1), and nothing else.
    expect(motors.map(motor => motor.rpm)).toEqual([1234, 2789, 4111, 5678]);
    expect(motors.map(motor => motor.temperatureCelsius)).toEqual([
      31, 42, 53, 64,
    ]);
    // THE SCALE. The wire already carries mechanical RPM - the pole count
    // was applied inside the flight controller by erpmToRpm(). Nothing on
    // this side divides by poles a second time, so M1 is 1234 and not
    // 1234/7 or 1234*7.
    const support = {
      motorCount: 4,
      dshotTelemetryEnabled: true,
      escSensorEnabled: false,
      escTelemetrySource: 'BIDIRECTIONAL_DSHOT' as const,
    };
    expect(
      motors.map(motor => visibleMotorTelemetryMetrics(motor, support).rpm),
    ).toEqual([1234, 2789, 4111, 5678]);
    await operator.endSession();
  });

  it('follows the order on the wire rather than a fixed answer', async () => {
    // THE ANTI-TAUTOLOGY. The previous test would also pass if the app
    // sorted, reversed or hard-coded the four readings. Send them
    // BACKWARDS and the app must report them backwards - the mapping is
    // positional, and position is the flight controller's to decide.
    const reversed = [...BENCH].reverse();
    const {operator} = await openMotorTest({
      dshotBidir: true,
      escSensor: false,
      telemetry: motorTelemetryPayload(reversed),
    });
    const diagnostics = await operator.refreshDiagnostics();
    await settle();
    const motors = diagnostics.escTelemetry.value?.motors ?? [];
    expect(motors.map(motor => motor.rpm)).toEqual([5678, 4111, 2789, 1234]);
    expect(motors.map(motor => motor.temperatureCelsius)).toEqual([
      64, 53, 42, 31,
    ]);
    await operator.endSession();
  });

  it('carries six outputs when the flight controller declares six', async () => {
    // "Does the decoder support the right motor count" - answered against
    // an airframe that is not a quad. getMotorCount() is 6, the frame
    // carries six 13-byte records, and all six arrive distinctly.
    const six: readonly BenchMotor[] = [
      ...BENCH,
      {rpm: 6321, temperatureCelsius: 71},
      {rpm: 7010, temperatureCelsius: 25},
    ];
    const {operator, begun} = await openMotorTest({
      dshotBidir: true,
      escSensor: false,
      motorCount: 6,
      telemetry: motorTelemetryPayload(six),
    });
    expect(begun.motorDiagnosticsSupport?.motorCount).toBe(6);
    const diagnostics = await operator.refreshDiagnostics();
    await settle();
    expect(diagnostics.escTelemetry.value?.motorCount).toBe(6);
    expect(
      (diagnostics.escTelemetry.value?.motors ?? []).map(motor => motor.rpm),
    ).toEqual([1234, 2789, 4111, 5678, 6321, 7010]);
    await operator.endSession();
  });

  it('reads a serial ESC sensor as its own source, with its own units', async () => {
    // FEATURE_ESC_SENSOR is a DIFFERENT source from bidirectional DShot
    // and must never be folded into it: its zero RPM is a measurement,
    // and its voltage/current are hundredths, not whole units.
    const sensor = new Wire().u8(4);
    for (let index = 0; index < 4; index += 1) {
      // rpm 0, invalidPct at the DShot floor - which is IRRELEVANT here,
      // because this record did not come from DShot.
      sensor.u32(0).u16(10_000).u8(28).u16(1655).u16(230).u16(412);
    }
    const {fc, operator, begun} = await openMotorTest({
      dshotBidir: false,
      escSensor: true,
      telemetry: sensor.done(),
    });
    expect(begun.motorDiagnosticsSupport).toEqual({
      motorCount: 4,
      dshotTelemetryEnabled: false,
      escSensorEnabled: true,
      escTelemetrySource: 'ESC_SENSOR',
    });
    const diagnostics = await operator.refreshDiagnostics();
    await settle();
    expect(fc.requested).toContain(MSP_MOTOR_TELEMETRY);
    expect(diagnostics.escTelemetry.state).toBe('FRESH');
    const support = {
      motorCount: 4,
      dshotTelemetryEnabled: false,
      escSensorEnabled: true,
      escTelemetrySource: 'ESC_SENSOR' as const,
    };
    for (const motor of diagnostics.escTelemetry.value?.motors ?? []) {
      const visible = visibleMotorTelemetryMetrics(motor, support);
      expect(visible.rpm).toBe(0); // a stopped motor, measured
      expect(rpmIsUnprovenZero(motor, support)).toBe(false);
      expect(visible.temperatureCelsius).toBe(28);
      expect(visible.voltageVolts).toBeCloseTo(16.55, 5);
      expect(visible.currentAmps).toBeCloseTo(2.3, 5);
      expect(visible.consumptionMah).toBe(412);
      // The DShot invalid-packet rate is not an ESC-sensor fact.
      expect(visible.invalidPercentRaw).toBeUndefined();
    }
    await operator.endSession();
  });

  it('never requests command 139 when the controller proved no source', async () => {
    // Betaflight answers a structurally valid ALL-ZERO payload when
    // neither bidirectional DShot nor FEATURE_ESC_SENSOR is on, so a
    // successful reply is not capability evidence. The controller refuses
    // the request instead of publishing those zeros as a reading.
    const {fc, operator} = await openMotorTest({
      dshotBidir: false,
      escSensor: false,
      telemetry: motorTelemetryPayload(
        [
          {rpm: 0, temperatureCelsius: 0},
          {rpm: 0, temperatureCelsius: 0},
          {rpm: 0, temperatureCelsius: 0},
          {rpm: 0, temperatureCelsius: 0},
        ],
      ),
    });
    const diagnostics = await operator.refreshDiagnostics();
    await settle();
    expect(fc.requested).not.toContain(MSP_MOTOR_TELEMETRY);
    expect(diagnostics.escTelemetry.state).toBe('NOT_ENABLED');
    expect(diagnostics.escTelemetry.value).toBeUndefined();
    await operator.endSession();
  });

  it('distinguishes a resting motor from a stream that never arrived', async () => {
    const {operator} = await openMotorTest({
      dshotBidir: true,
      escSensor: false,
      telemetry: motorTelemetryPayload(BENCH, {silent: true}),
    });
    const diagnostics = await operator.refreshDiagnostics();
    await settle();
    // The frame IS fresh - the flight controller answered. What it carries
    // is the firmware's own "nothing arrived" marker.
    expect(diagnostics.escTelemetry.state).toBe('FRESH');
    const support = {
      motorCount: 4,
      dshotTelemetryEnabled: true,
      escSensorEnabled: false,
      escTelemetrySource: 'BIDIRECTIONAL_DSHOT' as const,
    };
    for (const motor of diagnostics.escTelemetry.value?.motors ?? []) {
      expect(motor.rpm).toBe(0);
      expect(motor.invalidPercentRaw).toBe(10_000);
      // ...and it is reported as UNAVAILABLE, not as a measured zero.
      expect(visibleMotorTelemetryMetrics(motor, support).rpm).toBeUndefined();
      expect(rpmIsUnprovenZero(motor, support)).toBe(true);
    }
    await operator.endSession();
  });

  it('reports a genuine resting zero as a measurement, not as absence', async () => {
    // Same rpm, invalidPct BELOW the 100% floor: packets are arriving and
    // this motor is genuinely stopped. Hiding it would be the opposite lie.
    const resting = new Wire().u8(4);
    for (let index = 0; index < 4; index += 1) {
      resting.u32(0).u16(250).u8(30).u16(0).u16(0).u16(0);
    }
    const {operator} = await openMotorTest({
      dshotBidir: true,
      escSensor: false,
      telemetry: resting.done(),
    });
    const diagnostics = await operator.refreshDiagnostics();
    await settle();
    const support = {
      motorCount: 4,
      dshotTelemetryEnabled: true,
      escSensorEnabled: false,
      escTelemetrySource: 'BIDIRECTIONAL_DSHOT' as const,
    };
    for (const motor of diagnostics.escTelemetry.value?.motors ?? []) {
      expect(visibleMotorTelemetryMetrics(motor, support).rpm).toBe(0);
      expect(rpmIsUnprovenZero(motor, support)).toBe(false);
    }
    await operator.endSession();
  });
});

/* ================================================================== *
 * THE DEFECT THIS ROUND FOUND, AND THE PATH THAT NOW EXISTS
 * ================================================================== *
 *
 * WHAT WAS BROKEN. `MotorDiagnosticsPanel` gated the command-139 poll on
 * `hasEscTelemetrySource(support)`, and `support` came from ONE place:
 * `MotorTestControllerSnapshot.motorDiagnosticsSupport`, assigned during
 * motor-test session setup (motorTestController.ts:3441). Outside an open
 * motor-test session it is `undefined`, so:
 *
 *   - `acquireMotorDiagnosticsTelemetry(sessionId, false)` was called,
 *   - `reconcileEscTelemetryPoll` took the `escTelemetryReferences <= 0`
 *     branch and NEVER registered the poll, and
 *   - the channel published `NOT_ENABLED`, which the panel renders as
 *     "لا يوجد مصدر تليمترية مفعّل" - a statement about the operator's
 *     flight controller, made without ever reading MSP_MOTOR_CONFIG.
 *
 * Measured on this exact path before the fix:
 *   escTelemetry NOT_ENABLED, MSP_MOTOR_CONFIG requested 0,
 *   MSP_MOTOR_TELEMETRY requested 0.
 * After:
 *   MSP_MOTOR_CONFIG requested 1 -> BIDIRECTIONAL_DSHOT proven ->
 *   MSP_MOTOR_TELEMETRY requested 4, channel ACTIVE.
 *
 * These tests drive the CANONICAL scheduler through the singleton
 * coordinator - the same objects the Motors screen uses - with no motor
 * test open at any point.
 */

describe('the screen learns its telemetry source with no motor test open', () => {
  let sessionId = '';

  afterEach(async () => {
    if (sessionId !== '') {
      await mspSessionCoordinator.deactivateMspSession?.(sessionId);
      await settle();
    }
  });

  async function connect(options: {
    readonly dshotBidir: boolean;
    readonly escSensor: boolean;
    readonly telemetry?: Uint8Array;
  }) {
    schedulerSessionSeq += 1;
    sessionId = `esc-telemetry-scheduler-${schedulerSessionSeq}`;
    const fc = new VirtualFlightController({
      ...options,
      ackUnknownCommands: true,
      sessionId,
    });
    mspSessionCoordinator.openSession(fc.client, sessionId);
    await sleep(400);
    return fc;
  }

  it('says NOT READ YET before the motor configuration has arrived', async () => {
    const fc = await connect({dshotBidir: true, escSensor: false});
    // The panel's own call, with the motor-test snapshot absent.
    const release = acquireMotorDiagnosticsTelemetry(
      sessionId,
      hasEscTelemetrySource(undefined),
    );
    // Read IMMEDIATELY: no reply can have arrived yet.
    expect(getMotorDiagnosticsSupport(sessionId)).toBeUndefined();
    expect(
      getMotorDiagnosticsAvailability(sessionId).escTelemetry,
    ).toBe('SOURCE_UNKNOWN');
    release();
    expect(fc.requested).not.toContain(MSP_MOTOR_TELEMETRY);
  });

  it('reads MSP_MOTOR_CONFIG itself and then polls command 139', async () => {
    const fc = await connect({
      dshotBidir: true,
      escSensor: false,
      telemetry: motorTelemetryPayload(BENCH),
    });
    const release = acquireMotorDiagnosticsTelemetry(
      sessionId,
      hasEscTelemetrySource(undefined),
    );
    await sleep(2_000);

    // (1) It asked the ONE command that can answer the question.
    expect(fc.requested).toContain(MSP_MOTOR_CONFIG);
    // (2) And derived the source from the bytes, not from a default.
    expect(getMotorDiagnosticsSupport(sessionId)).toEqual({
      motorCount: 4,
      dshotTelemetryEnabled: true,
      escSensorEnabled: false,
      escTelemetrySource: 'BIDIRECTIONAL_DSHOT',
    });
    // (3) Which turned the ESC channel on - with NO motor test open.
    expect(
      getMotorDiagnosticsAvailability(sessionId).escTelemetry,
    ).toBe('ACTIVE');
    expect(fc.requested).toContain(MSP_MOTOR_TELEMETRY);

    // (4) And the readings that came back are the bench's own, in order.
    const value = mspSessionCoordinator
      .getTelemetryScheduler(sessionId)
      ?.getValue<{motors: readonly {rpm: number}[]}>(
        MOTOR_ESC_TELEMETRY_POLL_ID,
      );
    expect(value?.status).toBe('FRESH');
    expect(
      value?.status === 'FRESH' ? value.value.motors.map(m => m.rpm) : [],
    ).toEqual([1234, 2789, 4111, 5678]);
    release();
  }, 20_000);

  it('discovers a serial ESC sensor the same way', async () => {
    // The two sources are separate facts read from separate bytes, and
    // FEATURE_ESC_SENSOR must be discovered without a motor test just as
    // bidirectional DShot is.
    const fc = await connect({
      dshotBidir: false,
      escSensor: true,
      telemetry: motorTelemetryPayload(BENCH),
    });
    const release = acquireMotorDiagnosticsTelemetry(
      sessionId,
      hasEscTelemetrySource(undefined),
    );
    await sleep(2_000);
    expect(getMotorDiagnosticsSupport(sessionId)).toEqual({
      motorCount: 4,
      dshotTelemetryEnabled: false,
      escSensorEnabled: true,
      escTelemetrySource: 'ESC_SENSOR',
    });
    expect(getMotorDiagnosticsAvailability(sessionId).escTelemetry).toBe(
      'ACTIVE',
    );
    expect(fc.requested).toContain(MSP_MOTOR_TELEMETRY);
    release();
  }, 20_000);

  it('says NOT ENABLED only once the flight controller proved it', async () => {
    const fc = await connect({dshotBidir: false, escSensor: false});
    const release = acquireMotorDiagnosticsTelemetry(
      sessionId,
      hasEscTelemetrySource(undefined),
    );
    await sleep(2_000);
    expect(getMotorDiagnosticsSupport(sessionId)).toEqual({
      motorCount: 4,
      dshotTelemetryEnabled: false,
      escSensorEnabled: false,
      escTelemetrySource: 'NONE',
    });
    // NOW the definite sentence is earned - and command 139 is still
    // never sent, because its all-zero reply would prove nothing.
    expect(
      getMotorDiagnosticsAvailability(sessionId).escTelemetry,
    ).toBe('NOT_ENABLED');
    expect(fc.requested).not.toContain(MSP_MOTOR_TELEMETRY);
    release();
  }, 20_000);
});
