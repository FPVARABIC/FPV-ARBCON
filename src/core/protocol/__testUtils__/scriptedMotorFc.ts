/**
 * A SCRIPTED FLIGHT CONTROLLER, JUST BIG ENOUGH TO CLOSE A MOTOR SESSION.
 *
 * WHY THIS EXISTS. `FakeMspTransport` records writes and answers nothing.
 * That is enough for parser and submission-order proofs, but it means a
 * motor-test session can never be CLOSED in a test: the screen's canonical
 * shutdown waits for the controller to SETTLE before it will even call
 * `endSession()`, and a controller whose setup reads are unanswered never
 * settles - it sits in `Checking` for ever. The consequence was that the
 * one behaviour an operator complained about - close a session, open
 * another - had no harness that could reach it, and the bug shipped past
 * tests that were individually correct.
 *
 * WHAT IT DELIBERATELY IS NOT. Not a flight-controller emulator. It has no
 * state, no model of a motor, no arming logic, and no notion that one
 * command relates to another: it is a LOOKUP TABLE from command number to
 * a fixed reply, plus the framing needed to put that reply on the wire. It
 * cannot simulate a flight; it can only make the session lifecycle
 * reachable. Anything richer would be a second implementation of the
 * firmware for tests to disagree with.
 *
 * WHY THE PAYLOADS ARE REAL BYTES RATHER THAN EMPTY ONES. The first
 * attempt answered every request with an empty successful payload, on the
 * theory that the lifecycle only cares THAT a request was acknowledged.
 * That is false and made things strictly worse: setup DECODES these
 * replies, an empty one fails the decoder's own length contract, and the
 * session correctly fail-closed - so "answer everything" made the session
 * less reachable than answering nothing. Each payload below is therefore
 * the minimum well-formed frame its decoder accepts, and its bytes are
 * commented against that decoder.
 *
 * WHAT IT CAN DO, which is the whole point:
 *
 *   ACK           answer normally
 *   ACK late      answer only when the test says so (nothing is automatic)
 *   ACK never     leave a chosen command permanently outstanding
 *   ACK failure   answer a chosen command with an MSP error frame
 *   disconnect    stop answering and detach the session mid-operation
 *
 * It replies in the SAME wire format the request arrived in, parsed from
 * the bytes rather than assumed, so it cannot silently answer in a shape
 * the client would not have accepted - and it frames through the existing
 * `buildMspFrameBytes`, so there is no second framing implementation here.
 */

import {
  MSP2_SEND_DSHOT_COMMAND,
  MSP_ADVANCED_CONFIG,
  MSP_BOXIDS,
  MSP_FEATURE_CONFIG,
  MSP_MIXER_CONFIG,
  MSP_MOTOR,
  MSP_MOTOR_3D_CONFIG,
  MSP_MOTOR_CONFIG,
  MSP_STATUS_EX,
} from '../msp/commands/mspCommands';
import {MSP_SET_MOTOR} from '../msp/commands/motorTestCommands';
import {MSP_MOTOR_OUTPUT_SLOT_COUNT} from '../msp/decoding/decodeMotorOutputs';
import {MSP_V2_FRAME_ID} from '../mspTypes';
import type {MspWireFormat} from '../mspTypes';
import {buildMspFrameBytes} from './mspFixtures';
import type {FakeMspTransport} from './mspFakeTransport';

const DOLLAR = 0x24;
const MAGIC_V1 = 0x4d;
const MAGIC_V2_NATIVE = 0x58;
const JUMBO_SIZE_MARKER = 0xff;

/** Command 99. Deliberately absent from mspCommands.ts - see its comment
 * on why the production catalogue does not list it - so it is named here
 * rather than reached for through a back door. */
const MSP_SET_ARMING_DISABLED = 99;

export interface ScriptedRequest {
  readonly command: number;
  readonly wireFormat: MspWireFormat;
  /** The request's own payload bytes. Read for exactly one command - see
   * `armingRestrictionHeld` - and never interpreted otherwise. */
  readonly payload: Uint8Array;
}

/**
 * Little-endian encoders, ARITHMETIC rather than bitwise.
 *
 * The same rule motorArmingRestriction.test.ts follows and for the same
 * reason: JavaScript's bitwise operators coerce to SIGNED 32-bit, so a
 * mask with bit 31 set would come back negative and the byte it produced
 * would be wrong. Division and modulo have no such edge.
 */
const u8 = (value: number): number[] => [value % 256];
const u16 = (value: number): number[] => [
  value % 256,
  Math.floor(value / 256) % 256,
];
const u32 = (value: number): number[] => [
  value % 256,
  Math.floor(value / 256) % 256,
  Math.floor(value / 65536) % 256,
  Math.floor(value / 16777216) % 256,
];

/** The inverse: two wire bytes back into one number. */
const readU16 = (low: number, high: number): number => low + high * 256;

/** An acknowledged write. MSP answers a SET command with an empty frame. */
const ACK = new Uint8Array(0);

/**
 * THE SCRIPT: one fixed reply per command the motor-session lifecycle
 * issues, and nothing else. A command absent from this table is left
 * outstanding, exactly as the bare FakeMspTransport leaves it, and is
 * reported through `unscripted` so a test can see what it asked for
 * instead of hanging on a silence nobody chose.
 *
 * The values describe an ordinary, healthy DShot600 quad at rest. They are
 * not tuned to any assertion: nothing below is read back by a test, only
 * by the production decoders, which is the point.
 */
export const MOTOR_SESSION_SCRIPT: ReadonlyMap<number, Uint8Array> = new Map<
  number,
  Uint8Array
>([
  // decodeFeatureConfig: one u32 feature mask. 0 = no features, which
  // matters because 3D would take the session down an analog path.
  [MSP_FEATURE_CONFIG, Uint8Array.from(u32(0))],
  // decodeMixerConfig: u8 mixerMode, u8 yawMotorsReversed. 3 = QUADX.
  [MSP_MIXER_CONFIG, Uint8Array.from([...u8(3), ...u8(0)])],
  // decodeAdvancedConfig, in its own field order. motorProtocolRaw = 7 is
  // DSHOT600 at the pinned Betaflight authority; a protocol outside the
  // supported set would legitimately block the session.
  [
    MSP_ADVANCED_CONFIG,
    Uint8Array.from([
      ...u8(1), // deprecatedGyroSyncDenom
      ...u8(1), // pidProcessDenom
      ...u8(0), // useContinuousUpdate
      ...u8(7), // motorProtocolRaw - DSHOT600
      ...u16(480), // motorPwmRate
      ...u16(550), // motorIdleRaw
      ...u8(0), // deprecatedGyroUse32kHz
      ...u8(0), // motorInversionRaw - not reversed
      ...u8(0), // deprecatedGyroToUse
      ...u8(0), // gyroHighFsr
      ...u8(32), // gyroMovementCalibrationThreshold
      ...u16(125), // gyroCalibrationDuration
      ...u16(0), // gyroYawOffset (signed, 0)
      ...u8(0), // checkOverflow
      ...u8(0), // debugMode
      ...u8(0), // debugModeCount
    ]),
  ],
  // decodeMotor3dConfig: deadband3dLow, deadband3dHigh, neutral3d.
  [
    MSP_MOTOR_3D_CONFIG,
    Uint8Array.from([...u16(1406), ...u16(1514), ...u16(1460)]),
  ],
  // decodeMotorConfig: the authority for motorCount and the command
  // domain. Four motors, 14 poles, no DShot telemetry, no ESC sensor.
  [
    MSP_MOTOR_CONFIG,
    Uint8Array.from([
      ...u16(1070), // deprecatedMinThrottle
      ...u16(2000), // maxThrottle
      ...u16(1000), // minCommand
      ...u8(4), // motorCount
      ...u8(14), // motorPoleCount
      ...u8(0), // dshotTelemetryRaw
      ...u8(0), // escSensorRaw
    ]),
  ],
  // MSP_BOXIDS: the permanent-id list, in the same order as the flight
  // mode bits of MSP_STATUS_EX. ARM is permanent id 0 and is placed
  // first, so bit 0 below is the armed bit.
  [MSP_BOXIDS, Uint8Array.from([0, 1, 2])],
  // decodeMotorOutputs: always eight u16 SLOTS, whatever the airframe.
  // All at the stop value, because this responder never turns anything.
  [
    MSP_MOTOR,
    Uint8Array.from(
      Array.from({length: MSP_MOTOR_OUTPUT_SLOT_COUNT}, () => u16(1000)).flat(),
    ),
  ],
  // Writes. Each is acknowledged with an empty frame, which is what a
  // real flight controller sends for a SET command it accepted.
  [MSP_SET_ARMING_DISABLED, ACK],
  [MSP_SET_MOTOR, ACK],
  [MSP2_SEND_DSHOT_COMMAND, ACK],
]);

/** Bit 16 of the arming-disable mask - `ARMING_DISABLED_MSP`, which
 * `ARMING_DISABLE_FLAG_TOKENS.indexOf('MSP')` resolves to. Named here so
 * the fixture states the bit it is setting rather than a magic number. */
const ARMING_DISABLED_MSP_MASK = Math.pow(2, 16);

/**
 * MSP_STATUS_EX: the 13-byte fixed prefix `decodeStatusEx` reads, followed
 * by the readiness tail `decodeStatusExReadiness` reads.
 *
 * `flightModeFlags` is 0, so bit 0 - ARM, per the box-id list above - is
 * clear and the board reads DISARMED. That is the only state a motor
 * session may start from, and it never changes here: this responder has
 * no concept of arming and must not pretend to.
 */
export function buildStatusExPayload(armingRestrictionHeld: boolean): Uint8Array {
  return Uint8Array.from([
    ...u16(500), // cycleTimeUs
    ...u16(0), // i2cErrorCount
    ...u16(0x23), // sensorPresenceMask - acc/baro/mag detected
    ...u32(0), // flightModeFlags - bit 0 (ARM) clear: DISARMED
    ...u8(0), // pid profile index
    ...u16(12), // cpuLoadPercent
    // --- readiness tail ---
    ...u8(3), // pidProfileCount
    ...u8(0), // controlRateProfileIndex
    ...u8(0), // extra flight-mode flag byte count
    ...u8(4), // armingDisableFlagsCount
    ...u32(armingRestrictionHeld ? ARMING_DISABLED_MSP_MASK : 0),
    ...u8(0), // configState - no reboot required
  ]);
}

/**
 * Reads the command and wire format out of an outgoing request frame.
 *
 * Parsed rather than assumed: the client chooses its own format, and a
 * responder that guessed would answer in a shape the client rejects -
 * producing a timeout that looks like a lifecycle bug.
 */
export function parseRequest(bytes: Uint8Array): ScriptedRequest | undefined {
  if (bytes.length < 6 || bytes[0] !== DOLLAR) {
    return undefined;
  }
  const slice = (start: number, length: number): Uint8Array =>
    bytes.subarray(start, start + length);
  if (bytes[1] === MAGIC_V2_NATIVE) {
    // $X< [flags][command16][size16][payload][crc]
    return {
      command: readU16(bytes[4], bytes[5]),
      wireFormat: 'v2',
      payload: slice(8, readU16(bytes[6], bytes[7])),
    };
  }
  if (bytes[1] !== MAGIC_V1) {
    return undefined;
  }
  // v1 carries [size][command], and the jumbo form carries
  // [0xFF][command][size16] - the command byte is at the same offset in
  // both, so only the v2 tunnel needs distinguishing here.
  const jumbo = bytes[3] === JUMBO_SIZE_MARKER;
  const command = bytes[4];
  if (!jumbo && command === MSP_V2_FRAME_ID) {
    // v2 tunnelled through a v1 envelope: the inner header starts after
    // the frame id, and its own command is a little-endian u16.
    return {
      command: readU16(bytes[6], bytes[7]),
      wireFormat: 'v2-over-v1',
      payload: slice(10, readU16(bytes[8], bytes[9])),
    };
  }
  return {
    command,
    wireFormat: 'v1',
    payload: jumbo
      ? slice(7, readU16(bytes[5], bytes[6]))
      : slice(5, bytes[3]),
  };
}

/** A well-formed reply to `request`, in the format it arrived in. */
export function buildReply(
  request: ScriptedRequest,
  payload: Uint8Array = ACK,
  direction: 'response' | 'error' = 'response',
): Uint8Array {
  return buildMspFrameBytes(request.command, payload, {
    wireFormat: request.wireFormat,
    direction,
  });
}

export interface ScriptedMotorFcOptions {
  /** Extra or replacement scripted replies, merged over MOTOR_SESSION_SCRIPT. */
  readonly payloads?: ReadonlyMap<number, Uint8Array>;
  /** Commands answered with an MSP error frame instead of a response. */
  readonly failCommands?: readonly number[];
  /** Commands left permanently unanswered - the "no ACK" case. */
  readonly silentCommands?: readonly number[];
}

/**
 * Drives a FakeMspTransport as if a board were attached.
 *
 * `pump()` is explicit rather than automatic: a test that wants a LATE ack
 * simply does not pump until it is ready, and one that wants none never
 * pumps for that command. Nothing here runs on a timer, so no test can
 * become flaky because a reply raced a render.
 */
export class ScriptedMotorFc {
  private answered = 0;
  private disconnected = false;
  /**
   * THE ONE PIECE OF STATE, and the reason it is not a slippery slope.
   *
   * `establishMotorArmingRestriction` does not accept an ACK as proof: it
   * sends command 99 payload [1], then reads MSP_STATUS_EX back and
   * REQUIRES the aggregate `ARMING_DISABLED_MSP` bit to be set - correctly,
   * because an acknowledgement is not evidence a flight controller acted.
   * A responder that answered command 99 and then reported a clear mask
   * would not be "minimal", it would be SELF-CONTRADICTORY: acknowledging
   * a write and then denying it happened. This single boolean is what
   * makes the two replies consistent with each other, and it is the only
   * command whose payload this file inspects.
   */
  private armingRestrictionHeld = false;
  private readonly script: Map<number, Uint8Array>;
  private readonly overrides: ReadonlySet<number>;
  private readonly failCommands: ReadonlySet<number>;
  private readonly silentCommands: Set<number>;
  /** Requests withheld by `silentCommands`, kept so `releaseSilence()` can
   * answer them later - which is what makes a LATE acknowledgement a
   * distinct case from a missing one rather than a slower version of it. */
  private readonly withheld: ScriptedRequest[] = [];
  /** Every command this responder has answered, in order. */
  readonly acknowledged: number[] = [];
  /** Every command it was asked for and had no script for, in order. A
   * lifecycle that stalls names its missing reply here rather than
   * leaving a test to guess at a silence. */
  readonly unscripted: number[] = [];

  constructor(
    private readonly transport: FakeMspTransport,
    options: ScriptedMotorFcOptions = {},
  ) {
    this.script = new Map(MOTOR_SESSION_SCRIPT);
    const overrides = new Set<number>();
    for (const [command, payload] of options.payloads ?? []) {
      this.script.set(command, payload);
      overrides.add(command);
    }
    this.overrides = overrides;
    this.failCommands = new Set(options.failCommands ?? []);
    this.silentCommands = new Set(options.silentCommands ?? []);
  }

  /**
   * The reply body for one request, or undefined when nothing is scripted.
   *
   * MSP_STATUS_EX is built rather than looked up, so it can carry the
   * restriction bit consistently with the command 99 that preceded it. A
   * test that supplies its own MSP_STATUS_EX payload wins outright - that
   * is how a malformed or contradictory board is scripted.
   */
  private replyPayloadFor(request: ScriptedRequest): Uint8Array | undefined {
    if (request.command === MSP_STATUS_EX && !this.overrides.has(MSP_STATUS_EX)) {
      return buildStatusExPayload(this.armingRestrictionHeld);
    }
    return this.script.get(request.command);
  }

  /**
   * Settles every outstanding write and answers every request not yet
   * answered. Returns how many replies were emitted.
   */
  pump(): number {
    if (this.disconnected) {
      return 0;
    }
    // Writes must settle first: the client awaits the write before it can
    // be waiting on a reply.
    while (this.transport.writes.length > 0) {
      this.transport.resolveNextWrite();
    }
    let emitted = 0;
    while (this.answered < this.transport.writeLog.length) {
      const frame = this.transport.writeLog[this.answered];
      this.answered += 1;
      const request = parseRequest(frame);
      if (request === undefined) {
        continue;
      }
      if (this.silentCommands.has(request.command)) {
        this.withheld.push(request);
        continue;
      }
      emitted += this.answer(request);
    }
    return emitted;
  }

  /**
   * Answers requests withheld from `command` and stops withholding it.
   *
   * THE LATE ACKNOWLEDGEMENT, and the reason it is a separate case: an ack
   * that arrives after the caller has moved on is not the same event as
   * one that never arrives, and a lifecycle may treat them differently.
   * Returns how many withheld requests were answered.
   */
  releaseSilence(command: number): number {
    this.silentCommands.delete(command);
    if (this.disconnected) {
      return 0;
    }
    let emitted = 0;
    for (let index = this.withheld.length - 1; index >= 0; index -= 1) {
      const request = this.withheld[index];
      if (request.command !== command) {
        continue;
      }
      this.withheld.splice(index, 1);
      emitted += this.answer(request);
    }
    return emitted;
  }

  /** Emits one reply. Returns 1 when a reply went out, 0 otherwise. */
  private answer(request: ScriptedRequest): number {
    const failing = this.failCommands.has(request.command);
    const payload = this.replyPayloadFor(request);
    if (payload === undefined && !failing) {
      this.unscripted.push(request.command);
      return 0;
    }
    // Accepted before the reply goes out, so the very next status read
    // reports what this write did. Payload [1] establishes the
    // restriction, [0] releases this descriptor's hold - the polarity
    // motorArmingRestriction.ts pins to the firmware, not guessed here.
    // A REFUSED write changes nothing, which is the honest outcome.
    if (request.command === MSP_SET_ARMING_DISABLED && !failing) {
      this.armingRestrictionHeld = request.payload[0] === 1;
    }
    this.transport.emitData(
      buildReply(request, payload ?? ACK, failing ? 'error' : 'response'),
    );
    this.acknowledged.push(request.command);
    return 1;
  }

  /** Stops answering, and detaches the session as a cable pull would. */
  disconnect(sessionId: string): void {
    this.disconnected = true;
    this.transport.emitSessionDetached(sessionId);
  }
}
