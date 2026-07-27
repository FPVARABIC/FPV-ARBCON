/**
 * Pass 1D - tests for the session-bound dynamic motor safety observation.
 *
 * NO HARDWARE OF ANY KIND is required, referenced or simulated: no flight
 * controller, no USB, no serial session, no real MspClient, no ESC, no
 * motor, no LiPo, no emulator, no timers. Every payload is a hand-built
 * byte array and the requester is a hand-written fake.
 *
 * AN `OBSERVED` OUTCOME IS NOT READINESS, SAFETY, AUTHORIZATION OR
 * PERMISSION TO PULSE ANYTHING. These tests deliberately assert that no
 * such verdict exists anywhere in the returned value.
 */

import {
  acquireMotorDynamicSafetyObservation,
  ARMING_DISABLED_MSP_BIT_INDEX,
  BATTERY_STATE_TOKENS,
  type MotorDynamicSafetyObservationOutcome,
} from './motorDynamicSafetyObservation';
import {ARMING_DISABLE_FLAGS_COUNT} from './armingBlockers';
import type {MotorStaticCompatibilityEvaluation} from './motorStaticCompatibility';
import type {MotorStaticFactsSessionIdentity} from './motorStaticFacts';
import type {BoxIdsResult} from '../protocol/msp/identification/BoxIdsAcquisition';
import type {MspRequester} from '../protocol/msp/identification/MspIdentificationService';
import type {MspRequestOptions} from '../protocol/mspClient';
import type {MspFrame} from '../protocol/mspTypes';
import {MSP_BATTERY_STATE, MSP_STATUS_EX} from '../protocol/msp/commands/mspCommands';

const IDENTITY: MotorStaticFactsSessionIdentity = {physicalGeneration: 3, mspEpoch: 11};
const OTHER_IDENTITY: MotorStaticFactsSessionIdentity = {physicalGeneration: 4, mspEpoch: 11};

/* ------------------------------------------------------------------ *
 * Wire fixtures, built byte by byte from the pinned authority layout
 * (msp.c:1094-1143 and msp.c:796-811 @ 79065c96, MSP API 1.47).
 * ------------------------------------------------------------------ */

/** Arithmetic, not bitwise - the same discipline the decoders use, so a
 * high bit can never be corrupted by JavaScript's signed-32-bit operators. */
function u16(value: number): number[] {
  return [value % 256, Math.floor(value / 256) % 256];
}

function u32(value: number): number[] {
  return [
    value % 256,
    Math.floor(value / 256) % 256,
    Math.floor(value / 65536) % 256,
    Math.floor(value / 16777216) % 256,
  ];
}

interface StatusExFixture {
  /** Low 32 packed flight-mode (active-box) bits. */
  readonly flightModeFlagsLow32?: number;
  readonly extensionBytes?: readonly number[];
  /** Declared extension byteCount; defaults to extensionBytes.length. */
  readonly declaredByteCount?: number;
  readonly armingDisableFlags?: number;
  readonly armingDisableFlagsCount?: number;
  readonly rebootRequired?: boolean;
  /** Stop the payload after this many bytes (truncation tests). */
  readonly truncateTo?: number;
}

function statusExPayload(fixture: StatusExFixture = {}): Uint8Array {
  const extensionBytes = fixture.extensionBytes ?? [];
  const bytes = [
    ...u16(125), // task delta time us
    ...u16(0), // i2c error counter
    ...u16(0x21), // sensor mask (ACC | GYRO)
    ...u32(fixture.flightModeFlagsLow32 ?? 0), // offset 6, low 32 flight-mode bits
    2, // current pid profile index
    ...u16(15), // average system load %
    // ---- 13-byte fixed prefix ends here ----
    4, // PID_PROFILE_COUNT
    1, // current control-rate profile index
    fixture.declaredByteCount ?? extensionBytes.length,
    ...extensionBytes,
    fixture.armingDisableFlagsCount ?? ARMING_DISABLE_FLAGS_COUNT,
    ...u32(fixture.armingDisableFlags ?? 0),
    fixture.rebootRequired === true ? 1 : 0, // config state, bit0
    ...u16(3400), // core temperature (API 1.46)
    6, // CONTROL_RATE_PROFILE_COUNT
  ];
  const all = Uint8Array.from(bytes);
  return fixture.truncateTo === undefined ? all : all.subarray(0, fixture.truncateTo);
}

interface BatteryFixture {
  readonly cellCount?: number;
  readonly voltageCentivolts?: number;
  readonly batteryStateRaw?: number;
}

function batteryPayload(fixture: BatteryFixture = {}): Uint8Array {
  return Uint8Array.from([
    fixture.cellCount ?? 4,
    ...u16(1500), // configured capacity mAh
    166, // legacy voltage, 0.1V steps
    ...u16(0), // consumed mAh
    ...u16(0), // amperage, 0.01A (signed on the wire)
    fixture.batteryStateRaw ?? 0, // batteryState_e
    ...u16(fixture.voltageCentivolts ?? 1660), // canonical voltage, 0.01V
  ]);
}

/* ------------------------------------------------------------------ *
 * Fakes
 * ------------------------------------------------------------------ */

type Scripted = {payload: Uint8Array} | {reject: unknown};

class FakeRequester implements MspRequester {
  readonly calls: Array<{command: number; payload: Uint8Array; options: MspRequestOptions}> = [];
  /** Invoked while a request is "in flight", so a test can change the
   * session identity exactly between send and settle. */
  onRequest: ((command: number) => void) | undefined;

  constructor(private readonly responses: Map<number, Scripted>) {}

  async request(
    command: number,
    payload: Uint8Array,
    options: MspRequestOptions,
  ): Promise<MspFrame> {
    this.calls.push({command, payload, options});
    this.onRequest?.(command);
    const scripted = this.responses.get(command);
    if (scripted === undefined) {
      throw new Error(`unscripted command ${command}`);
    }
    if ('reject' in scripted) {
      throw scripted.reject;
    }
    return {
      protocolVersion: 'v1',
      wireFormat: 'v1',
      direction: 'response',
      command,
      flags: 0,
      payload: scripted.payload,
    };
  }
}

function requesterFor(status: Scripted, battery: Scripted): FakeRequester {
  return new FakeRequester(
    new Map<number, Scripted>([
      [MSP_STATUS_EX, status],
      [MSP_BATTERY_STATE, battery],
    ]),
  );
}

function evaluation(
  status: 'SUPPORTED' | 'UNSUPPORTED',
  sessionIdentity: MotorStaticFactsSessionIdentity = IDENTITY,
): MotorStaticCompatibilityEvaluation {
  return {
    kind: 'EVALUATED',
    compatibility: {sessionIdentity, status, checks: [], mismatchedCheckIds: []},
  };
}

/** MSP_BOXIDS wire order: index === bit position. BOXARM's permanent id
 * is 0 (msp_box.c:49); here it lands at bit 2, never bit 0, so a
 * hardcoded assumption would be caught. */
const BOX_IDS: BoxIdsResult = {kind: 'READY', permanentIds: [5, 1, 0, 13]};
const ARM_BIT = 2;

interface RunOptions {
  readonly requester?: FakeRequester;
  readonly staticCompatibility?: MotorStaticCompatibilityEvaluation | undefined;
  readonly boxIds?: BoxIdsResult | undefined;
  readonly currentIdentity?: MotorStaticFactsSessionIdentity | undefined;
  readonly clockReadings?: readonly number[];
  /** Supplied by tests that must arm `onRequest` BEFORE the acquisition
   * starts - the first request is dispatched synchronously. */
  readonly identityBox?: {current: MotorStaticFactsSessionIdentity | undefined};
}

function run(options: RunOptions = {}): {
  outcome: Promise<MotorDynamicSafetyObservationOutcome>;
  requester: FakeRequester;
  identityBox: {current: MotorStaticFactsSessionIdentity | undefined};
} {
  const requester =
    options.requester ?? requesterFor({payload: statusExPayload()}, {payload: batteryPayload()});
  const identityBox = options.identityBox ?? {
    current:
      'currentIdentity' in options
        ? options.currentIdentity
        : (IDENTITY as MotorStaticFactsSessionIdentity | undefined),
  };
  const readings = options.clockReadings ?? [1000, 1042];
  let readIndex = 0;
  const outcome = acquireMotorDynamicSafetyObservation({
    requester,
    staticCompatibility:
      'staticCompatibility' in options ? options.staticCompatibility : evaluation('SUPPORTED'),
    boxIds: 'boxIds' in options ? options.boxIds : BOX_IDS,
    readCurrentIdentity: () => identityBox.current,
    readMonotonicMillis: () => readings[Math.min(readIndex++, readings.length - 1)],
  });
  return {outcome, requester, identityBox};
}

function expectNotObserved(
  outcome: MotorDynamicSafetyObservationOutcome,
  reason: string,
): void {
  expect(outcome.kind).toBe('NOT_OBSERVED');
  if (outcome.kind !== 'NOT_OBSERVED') {
    throw new Error('unreachable');
  }
  expect(outcome.reason).toBe(reason);
}

/* ------------------------------------------------------------------ *
 * Pinned-authority constants
 * ------------------------------------------------------------------ */

describe('pinned authority constants', () => {
  it('resolves ARMING_DISABLED_MSP to bit 16 (runtime_config.h:59)', () => {
    expect(ARMING_DISABLED_MSP_BIT_INDEX).toBe(16);
  });

  it('lists every batteryState_e value from battery.h:88-94 in enum order', () => {
    expect(BATTERY_STATE_TOKENS).toEqual([
      'BATTERY_OK',
      'BATTERY_WARNING',
      'BATTERY_CRITICAL',
      'BATTERY_NOT_PRESENT',
      'BATTERY_INIT',
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * Prerequisite gate - zero MSP requests
 * ------------------------------------------------------------------ */

describe('prerequisite gate', () => {
  it('sends ZERO requests when there is no static compatibility result', async () => {
    const {outcome, requester} = run({staticCompatibility: undefined});
    expectNotObserved(await outcome, 'STATIC_PROFILE_REQUIRED');
    expect(requester.calls).toHaveLength(0);
  });

  it('sends ZERO requests when the static evaluation is NOT_EVALUATED', async () => {
    const {outcome, requester} = run({
      staticCompatibility: {kind: 'NOT_EVALUATED', reason: 'SESSION_IDENTITY_MISMATCH'},
    });
    expectNotObserved(await outcome, 'STATIC_PROFILE_REQUIRED');
    expect(requester.calls).toHaveLength(0);
  });

  it('sends ZERO requests when the static profile is UNSUPPORTED', async () => {
    const {outcome, requester} = run({staticCompatibility: evaluation('UNSUPPORTED')});
    expectNotObserved(await outcome, 'STATIC_PROFILE_REQUIRED');
    expect(requester.calls).toHaveLength(0);
  });

  it('sends ZERO requests when there is no current session identity', async () => {
    const {outcome, requester} = run({currentIdentity: undefined});
    expectNotObserved(await outcome, 'SESSION_IDENTITY_UNAVAILABLE');
    expect(requester.calls).toHaveLength(0);
  });

  it('sends ZERO requests when the static profile belongs to another session', async () => {
    const {outcome, requester} = run({staticCompatibility: evaluation('SUPPORTED', OTHER_IDENTITY)});
    expectNotObserved(await outcome, 'SESSION_IDENTITY_MISMATCH');
    expect(requester.calls).toHaveLength(0);
  });

  it('sends ZERO requests when no box-id mapping was supplied', async () => {
    const {outcome, requester} = run({boxIds: undefined});
    expectNotObserved(await outcome, 'ARMING_BOX_MAPPING_REQUIRED');
    expect(requester.calls).toHaveLength(0);
  });

  it('sends ZERO requests when the box-id mapping is UNAVAILABLE', async () => {
    const {outcome, requester} = run({boxIds: {kind: 'UNAVAILABLE', reason: 'MALFORMED'}});
    expectNotObserved(await outcome, 'ARMING_BOX_MAPPING_REQUIRED');
    expect(requester.calls).toHaveLength(0);
  });

  it('sends ZERO requests when the box-id mapping is empty', async () => {
    const {outcome, requester} = run({boxIds: {kind: 'READY', permanentIds: []}});
    expectNotObserved(await outcome, 'ARMING_BOX_MAPPING_REQUIRED');
    expect(requester.calls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Request sequencing
 * ------------------------------------------------------------------ */

describe('request sequencing', () => {
  it('sends EXACTLY MSP_STATUS_EX then MSP_BATTERY_STATE, once each, empty v1', async () => {
    const {outcome, requester} = run();
    expect((await outcome).kind).toBe('OBSERVED');
    expect(requester.calls.map(call => call.command)).toEqual([MSP_STATUS_EX, MSP_BATTERY_STATE]);
    for (const call of requester.calls) {
      expect(call.payload).toHaveLength(0);
      expect(call.options).toEqual({wireFormat: 'v1'});
    }
  });

  it('never sends a write command - notably not MSP_SET_MOTOR (214) or 99', async () => {
    const {outcome, requester} = run();
    await outcome;
    for (const call of requester.calls) {
      expect(call.command).not.toBe(214);
      expect(call.command).not.toBe(99);
      expect(call.payload.length).toBe(0);
    }
  });

  it('does NOT send MSP_BATTERY_STATE when MSP_STATUS_EX rejects, and never retries', async () => {
    const requester = requesterFor({reject: new Error('MSP_TIMEOUT')}, {payload: batteryPayload()});
    const {outcome} = run({requester});
    expectNotObserved(await outcome, 'REQUEST_FAILED');
    expect(requester.calls.map(call => call.command)).toEqual([MSP_STATUS_EX]);
  });

  it('reports REQUEST_FAILED without retrying when MSP_BATTERY_STATE rejects', async () => {
    const requester = requesterFor({payload: statusExPayload()}, {reject: new Error('MSP_TIMEOUT')});
    const {outcome} = run({requester});
    expectNotObserved(await outcome, 'REQUEST_FAILED');
    expect(requester.calls.map(call => call.command)).toEqual([MSP_STATUS_EX, MSP_BATTERY_STATE]);
  });
});

/* ------------------------------------------------------------------ *
 * Armed state
 * ------------------------------------------------------------------ */

describe('armed state', () => {
  it('reads ARMED from the bit the BOXIDS mapping points at, not bit 0', async () => {
    const requester = requesterFor(
      {payload: statusExPayload({flightModeFlagsLow32: Math.pow(2, ARM_BIT)})},
      {payload: batteryPayload()},
    );
    const outcome = await run({requester}).outcome;
    expect(outcome.kind).toBe('OBSERVED');
    if (outcome.kind !== 'OBSERVED') {
      throw new Error('unreachable');
    }
    expect(outcome.observation.armedState).toBe('ARMED');
  });

  it('reports DISARMED when the mapped bit is clear even if bit 0 is set', async () => {
    const requester = requesterFor(
      {payload: statusExPayload({flightModeFlagsLow32: 1})}, // bit 0 = permanentId 5, not ARM
      {payload: batteryPayload()},
    );
    const outcome = await run({requester}).outcome;
    expect(outcome.kind).toBe('OBSERVED');
    if (outcome.kind !== 'OBSERVED') {
      throw new Error('unreachable');
    }
    expect(outcome.observation.armedState).toBe('DISARMED');
  });

  it('fails closed when BOXARM is absent from the mapping', async () => {
    const {outcome} = run({boxIds: {kind: 'READY', permanentIds: [5, 1, 13]}});
    expectNotObserved(await outcome, 'ARMED_STATE_UNOBSERVABLE');
  });

  it('fails closed when the ARM bit lies beyond the bits the frame carried', async () => {
    // BOXARM at index 40 needs extension byte 1, but the frame carries none.
    const permanentIds = Array.from({length: 41}, (_unused, index) => (index === 40 ? 0 : index + 1));
    const {outcome} = run({boxIds: {kind: 'READY', permanentIds}});
    expectNotObserved(await outcome, 'ARMED_STATE_UNOBSERVABLE');
  });

  it('reads the ARM bit out of the extension bytes when the index is >= 32', async () => {
    const permanentIds = Array.from({length: 35}, (_unused, index) => (index === 34 ? 0 : index + 1));
    const requester = requesterFor(
      // index 34 -> extension byte 0, bit 2.
      {payload: statusExPayload({extensionBytes: [0b0000_0100]})},
      {payload: batteryPayload()},
    );
    const outcome = await run({requester, boxIds: {kind: 'READY', permanentIds}}).outcome;
    expect(outcome.kind).toBe('OBSERVED');
    if (outcome.kind !== 'OBSERVED') {
      throw new Error('unreachable');
    }
    expect(outcome.observation.armedState).toBe('ARMED');
  });

  it('never infers armed state from the arming-disable mask', async () => {
    // NOT_DISARMED (bit 3) set, yet the ARM box bit is clear: DISARMED.
    const requester = requesterFor(
      {payload: statusExPayload({flightModeFlagsLow32: 0, armingDisableFlags: 8})},
      {payload: batteryPayload()},
    );
    const outcome = await run({requester}).outcome;
    if (outcome.kind !== 'OBSERVED') {
      throw new Error('expected OBSERVED');
    }
    expect(outcome.observation.armedState).toBe('DISARMED');
  });
});

/* ------------------------------------------------------------------ *
 * Arming restrictions
 * ------------------------------------------------------------------ */

describe('arming restrictions', () => {
  it('reports the complete blocker set, the raw mask and the declared count', async () => {
    const mask = Math.pow(2, 0) + Math.pow(2, 16) + Math.pow(2, 21); // NO_GYRO | MSP | REBOOT_REQUIRED
    const requester = requesterFor(
      {payload: statusExPayload({armingDisableFlags: mask})},
      {payload: batteryPayload()},
    );
    const outcome = await run({requester}).outcome;
    if (outcome.kind !== 'OBSERVED') {
      throw new Error('expected OBSERVED');
    }
    const restrictions = outcome.observation.armingRestrictions;
    expect(restrictions.rawMask).toBe(mask);
    expect(restrictions.declaredFlagCount).toBe(ARMING_DISABLE_FLAGS_COUNT);
    expect(restrictions.blockers.map(blocker => blocker.bit)).toEqual([0, 16, 21]);
    expect(restrictions.blockers.every(blocker => blocker.kind === 'KNOWN')).toBe(true);
    expect(restrictions.mspRestrictionPresent).toBe(true);
  });

  it('reports mspRestrictionPresent false when only other bits are set', async () => {
    const requester = requesterFor(
      {payload: statusExPayload({armingDisableFlags: Math.pow(2, 15) + Math.pow(2, 17)})},
      {payload: batteryPayload()},
    );
    const outcome = await run({requester}).outcome;
    if (outcome.kind !== 'OBSERVED') {
      throw new Error('expected OBSERVED');
    }
    expect(outcome.observation.armingRestrictions.mspRestrictionPresent).toBe(false);
  });

  it('preserves bit 31 without sign corruption and keeps unknown bits', async () => {
    const mask = Math.pow(2, 31) + Math.pow(2, 16);
    const requester = requesterFor(
      {payload: statusExPayload({armingDisableFlags: mask})},
      {payload: batteryPayload()},
    );
    const outcome = await run({requester}).outcome;
    if (outcome.kind !== 'OBSERVED') {
      throw new Error('expected OBSERVED');
    }
    const restrictions = outcome.observation.armingRestrictions;
    expect(restrictions.rawMask).toBe(mask);
    expect(restrictions.rawMask).toBeGreaterThan(0);
    expect(restrictions.mspRestrictionPresent).toBe(true);
    expect(restrictions.blockers).toContainEqual({kind: 'UNKNOWN', bit: 31, hex: '0x80000000'});
  });

  it('reports rebootRequired from config-state bit 0', async () => {
    for (const rebootRequired of [true, false]) {
      const requester = requesterFor(
        {payload: statusExPayload({rebootRequired})},
        {payload: batteryPayload()},
      );
      const outcome = await run({requester}).outcome;
      if (outcome.kind !== 'OBSERVED') {
        throw new Error('expected OBSERVED');
      }
      expect(outcome.observation.armingRestrictions.rebootRequired).toBe(rebootRequired);
    }
  });

  it('reports rebootRequired null - never false - when the frame ended before that byte', async () => {
    // 13 prefix + 2 profile + 1 byteCount + 1 count + 4 mask = 21 bytes.
    const requester = requesterFor(
      {payload: statusExPayload({truncateTo: 21})},
      {payload: batteryPayload()},
    );
    const outcome = await run({requester}).outcome;
    if (outcome.kind !== 'OBSERVED') {
      throw new Error('expected OBSERVED');
    }
    expect(outcome.observation.armingRestrictions.rebootRequired).toBeNull();
  });

  it('fails closed when the frame carried no arming-disable field at all', async () => {
    // 13 prefix + 2 profile + 1 byteCount = 16 bytes: honest absence.
    const requester = requesterFor(
      {payload: statusExPayload({truncateTo: 16})},
      {payload: batteryPayload()},
    );
    const {outcome} = run({requester});
    expectNotObserved(await outcome, 'ARMING_RESTRICTIONS_UNOBSERVABLE');
  });

  it('never treats a missing mask as an empty mask', async () => {
    const requester = requesterFor(
      {payload: statusExPayload({truncateTo: 16})},
      {payload: batteryPayload()},
    );
    const outcome = await run({requester}).outcome;
    expect(outcome.kind).toBe('NOT_OBSERVED');
  });
});

/* ------------------------------------------------------------------ *
 * Malformed frames
 * ------------------------------------------------------------------ */

describe('malformed frames', () => {
  it('fails closed on a partially present tail (declared extension exceeds the frame)', async () => {
    const requester = requesterFor(
      {payload: statusExPayload({extensionBytes: [], declaredByteCount: 9, truncateTo: 16})},
      {payload: batteryPayload()},
    );
    const {outcome} = run({requester});
    expectNotObserved(await outcome, 'MALFORMED_RESPONSE');
  });

  it('fails closed when only part of the four mask bytes arrived', async () => {
    // count byte present, 2 of 4 mask bytes: 13 + 2 + 1 + 1 + 2 = 19.
    const requester = requesterFor(
      {payload: statusExPayload({truncateTo: 19})},
      {payload: batteryPayload()},
    );
    const {outcome} = run({requester});
    expectNotObserved(await outcome, 'MALFORMED_RESPONSE');
  });

  it('fails closed when MSP_STATUS_EX is shorter than the fixed prefix', async () => {
    const requester = requesterFor(
      {payload: statusExPayload({truncateTo: 9})},
      {payload: batteryPayload()},
    );
    const {outcome} = run({requester});
    expectNotObserved(await outcome, 'MALFORMED_RESPONSE');
  });

  it('fails closed when MSP_BATTERY_STATE is truncated', async () => {
    const requester = requesterFor(
      {payload: statusExPayload()},
      {payload: batteryPayload().subarray(0, 7)},
    );
    const {outcome} = run({requester});
    expectNotObserved(await outcome, 'MALFORMED_RESPONSE');
  });

  it('does not throw on any malformed input', async () => {
    const requester = requesterFor({payload: new Uint8Array(0)}, {payload: new Uint8Array(0)});
    await expect(run({requester}).outcome).resolves.toEqual({
      kind: 'NOT_OBSERVED',
      reason: 'MALFORMED_RESPONSE',
    });
  });
});

/* ------------------------------------------------------------------ *
 * Battery
 * ------------------------------------------------------------------ */

describe('battery observation', () => {
  it('reports the cell count and the CANONICAL centivolt field verbatim', async () => {
    const requester = requesterFor(
      {payload: statusExPayload()},
      {payload: batteryPayload({cellCount: 4, voltageCentivolts: 1663})},
    );
    const outcome = await run({requester}).outcome;
    if (outcome.kind !== 'OBSERVED') {
      throw new Error('expected OBSERVED');
    }
    expect(outcome.observation.battery.cellCount).toBe(4);
    expect(outcome.observation.battery.voltageCentivolts).toBe(1663);
  });

  it('reports cellCount 0 as-is - the firmware\'s "battery not detected"', async () => {
    const requester = requesterFor(
      {payload: statusExPayload()},
      {payload: batteryPayload({cellCount: 0, voltageCentivolts: 0, batteryStateRaw: 3})},
    );
    const outcome = await run({requester}).outcome;
    if (outcome.kind !== 'OBSERVED') {
      throw new Error('expected OBSERVED');
    }
    expect(outcome.observation.battery.cellCount).toBe(0);
    expect(outcome.observation.battery.classification).toEqual({
      kind: 'KNOWN',
      raw: 3,
      token: 'BATTERY_NOT_PRESENT',
    });
  });

  it('classifies every batteryState_e value defined at the pinned authority', async () => {
    for (let raw = 0; raw < BATTERY_STATE_TOKENS.length; raw++) {
      const requester = requesterFor(
        {payload: statusExPayload()},
        {payload: batteryPayload({batteryStateRaw: raw})},
      );
      const outcome = await run({requester}).outcome;
      if (outcome.kind !== 'OBSERVED') {
        throw new Error('expected OBSERVED');
      }
      expect(outcome.observation.battery.classification).toEqual({
        kind: 'KNOWN',
        raw,
        token: BATTERY_STATE_TOKENS[raw],
      });
    }
  });

  it('preserves an undefined enum value as UNRECOGNIZED instead of coercing it', async () => {
    const requester = requesterFor(
      {payload: statusExPayload()},
      {payload: batteryPayload({batteryStateRaw: 200})},
    );
    const outcome = await run({requester}).outcome;
    if (outcome.kind !== 'OBSERVED') {
      throw new Error('expected OBSERVED');
    }
    expect(outcome.observation.battery.classification).toEqual({kind: 'UNRECOGNIZED', raw: 200});
  });
});

/* ------------------------------------------------------------------ *
 * Session identity
 * ------------------------------------------------------------------ */

describe('session identity', () => {
  /** The first request is dispatched SYNCHRONOUSLY, so the hook and the
   * identity box must both exist before the acquisition begins. */
  function armedRun(changeOn: number, next: MotorStaticFactsSessionIdentity | undefined) {
    const requester = requesterFor({payload: statusExPayload()}, {payload: batteryPayload()});
    const identityBox = {current: IDENTITY as MotorStaticFactsSessionIdentity | undefined};
    requester.onRequest = command => {
      if (command === changeOn) {
        identityBox.current = next;
      }
    };
    return run({requester, identityBox});
  }

  it('discards a response when the identity changed during MSP_STATUS_EX', async () => {
    const {outcome, requester} = armedRun(MSP_STATUS_EX, OTHER_IDENTITY);
    expectNotObserved(await outcome, 'SESSION_IDENTITY_CHANGED');
    // MSP_BATTERY_STATE is never even attempted for a dead scope.
    expect(requester.calls.map(call => call.command)).toEqual([MSP_STATUS_EX]);
  });

  it('discards a response when the identity changed during MSP_BATTERY_STATE', async () => {
    const {outcome, requester} = armedRun(MSP_BATTERY_STATE, OTHER_IDENTITY);
    expectNotObserved(await outcome, 'SESSION_IDENTITY_CHANGED');
    expect(requester.calls.map(call => call.command)).toEqual([MSP_STATUS_EX, MSP_BATTERY_STATE]);
  });

  it('discards everything when the identity disappears mid-flight', async () => {
    const {outcome} = armedRun(MSP_STATUS_EX, undefined);
    expectNotObserved(await outcome, 'SESSION_IDENTITY_CHANGED');
  });

  it('stamps a defensive copy of the identity that cannot be rewritten', async () => {
    const mutableIdentity = {physicalGeneration: 3, mspEpoch: 11};
    const outcome = await run({
      staticCompatibility: evaluation('SUPPORTED', mutableIdentity),
    }).outcome;
    if (outcome.kind !== 'OBSERVED') {
      throw new Error('expected OBSERVED');
    }
    mutableIdentity.physicalGeneration = 99;
    expect(outcome.observation.sessionIdentity).toEqual({physicalGeneration: 3, mspEpoch: 11});
  });
});

/* ------------------------------------------------------------------ *
 * Observation window
 * ------------------------------------------------------------------ */

describe('observation window', () => {
  it('records the monotonic window around the two reads', async () => {
    const outcome = await run({clockReadings: [5000, 5063]}).outcome;
    if (outcome.kind !== 'OBSERVED') {
      throw new Error('expected OBSERVED');
    }
    expect(outcome.observation.observationWindow).toEqual({
      startedAtMonotonicMillis: 5000,
      completedAtMonotonicMillis: 5063,
      durationMillis: 63,
    });
  });

  it('does not read the clock at all when the prerequisite gate fails', async () => {
    let reads = 0;
    const requester = requesterFor({payload: statusExPayload()}, {payload: batteryPayload()});
    const outcome = await acquireMotorDynamicSafetyObservation({
      requester,
      staticCompatibility: evaluation('UNSUPPORTED'),
      boxIds: BOX_IDS,
      readCurrentIdentity: () => IDENTITY,
      readMonotonicMillis: () => {
        reads++;
        return 0;
      },
    });
    expect(outcome.kind).toBe('NOT_OBSERVED');
    expect(reads).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Immutability
 * ------------------------------------------------------------------ */

describe('immutability', () => {
  it('freezes the outcome, the observation and every nested group', async () => {
    const outcome = await run().outcome;
    if (outcome.kind !== 'OBSERVED') {
      throw new Error('expected OBSERVED');
    }
    const observation = outcome.observation;
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation.sessionIdentity)).toBe(true);
    expect(Object.isFrozen(observation.armingRestrictions)).toBe(true);
    expect(Object.isFrozen(observation.armingRestrictions.blockers)).toBe(true);
    expect(Object.isFrozen(observation.battery)).toBe(true);
    expect(Object.isFrozen(observation.battery.classification)).toBe(true);
    expect(Object.isFrozen(observation.observationWindow)).toBe(true);
  });

  it('freezes NOT_OBSERVED outcomes too', async () => {
    const outcome = await run({boxIds: undefined}).outcome;
    expect(Object.isFrozen(outcome)).toBe(true);
  });

  it('does not let a write to a frozen field take effect', async () => {
    const outcome = await run().outcome;
    if (outcome.kind !== 'OBSERVED') {
      throw new Error('expected OBSERVED');
    }
    const mutable = outcome.observation.battery as {cellCount: number};
    try {
      mutable.cellCount = 42;
    } catch {
      // Strict mode throws; sloppy mode ignores. Either is acceptable -
      // what matters is that the value did not change.
    }
    expect(outcome.observation.battery.cellCount).toBe(4);
  });
});

/* ------------------------------------------------------------------ *
 * Semantic exclusions - the negative proof
 * ------------------------------------------------------------------ */

describe('semantic exclusions', () => {
  function collectKeys(value: unknown, keys: Set<string>, depth = 0): void {
    if (depth > 6 || value === null || typeof value !== 'object') {
      return;
    }
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      keys.add(key);
      collectKeys(nested, keys, depth + 1);
    }
  }

  it('exposes no readiness, safety, authorization or permission verdict anywhere', async () => {
    const outcome = await run().outcome;
    const keys = new Set<string>();
    collectKeys(outcome, keys);
    const forbidden =
      /^(is)?(safe|ready|authoriz|approved|allowed|permitted|cantest|canpulse|canstart|ok|healthy|acceptable|valid|pass(ed)?)/i;
    const offenders = Array.from(keys).filter(key => forbidden.test(key));
    expect(offenders).toEqual([]);
  });

  it('labels the value as a DYNAMIC_OBSERVATION and nothing stronger', async () => {
    const outcome = await run().outcome;
    if (outcome.kind !== 'OBSERVED') {
      throw new Error('expected OBSERVED');
    }
    expect(outcome.observation.observationKind).toBe('DYNAMIC_OBSERVATION');
  });

  it('returns exactly the documented top-level observation fields - no extras', async () => {
    const outcome = await run().outcome;
    if (outcome.kind !== 'OBSERVED') {
      throw new Error('expected OBSERVED');
    }
    expect(Object.keys(outcome.observation).sort()).toEqual([
      'armedState',
      'armingRestrictions',
      'battery',
      'observationKind',
      'observationWindow',
      'sessionIdentity',
    ]);
  });

  it('observes an ARMED, fully-blocked, empty-battery state without objecting to it', async () => {
    // The observation reports facts even when they are alarming: judging
    // them is a later gate's job, not this function's.
    const requester = requesterFor(
      {
        payload: statusExPayload({
          flightModeFlagsLow32: Math.pow(2, ARM_BIT),
          armingDisableFlags: Math.pow(2, 16),
          rebootRequired: true,
        }),
      },
      {payload: batteryPayload({cellCount: 0, voltageCentivolts: 0, batteryStateRaw: 2})},
    );
    const outcome = await run({requester}).outcome;
    if (outcome.kind !== 'OBSERVED') {
      throw new Error('expected OBSERVED');
    }
    expect(outcome.observation.armedState).toBe('ARMED');
    expect(outcome.observation.armingRestrictions.mspRestrictionPresent).toBe(true);
    expect(outcome.observation.armingRestrictions.rebootRequired).toBe(true);
    expect(outcome.observation.battery.classification).toEqual({
      kind: 'KNOWN',
      raw: 2,
      token: 'BATTERY_CRITICAL',
    });
  });
});
