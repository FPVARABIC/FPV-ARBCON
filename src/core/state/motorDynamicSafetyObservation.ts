/**
 * Pass 1D - a SINGLE, ONE-SHOT, READ-ONLY observation of the dynamic FC
 * facts a future motor-test safety gate will need.
 *
 * WHAT THIS IS
 * ------------
 * It asks the flight controller two read commands, exactly once each, and
 * reports what came back. That is the whole contract.
 *
 * WHAT THIS IS NOT - AND CAN NEVER BECOME
 * ---------------------------------------
 * An `OBSERVED` outcome is a RECORD OF FACTS AT ONE MOMENT. It is not a
 * decision and carries no permission. Specifically it does NOT decide, and
 * must never be read as deciding:
 *   - that anything is READY, SAFE, AUTHORIZED, or CAN_PULSE;
 *   - that a motor test may begin;
 *   - that the measured voltage is acceptable;
 *   - that a 4S pack is safe;
 *   - that stopping a motor would be reliable;
 *   - that these facts are still true after this function returns.
 * There is deliberately no `isSafe`, `canTest`, `ready` or `ok` field
 * anywhere in the returned value, and a test asserts their absence. The
 * only vocabulary is OBSERVED / NOT_OBSERVED.
 *
 * FRESHNESS IS NOT PROVABLE HERE. The observation window below records
 * when the reads happened in monotonic units; it does NOT establish that
 * the facts are still current, and no consumer may treat it as doing so.
 * A pack can be unplugged, an arm switch flipped, or a session torn down
 * one millisecond after the last byte arrives.
 *
 * SCOPE - EXACTLY TWO READ COMMANDS
 * ---------------------------------
 * MSP_STATUS_EX (150) and MSP_BATTERY_STATE (130). Both are OUT messages
 * (read-only). No write command is built, encoded or sent here: no
 * MSP_SET_MOTOR, no command 214, no MSP_SET_ARMING_DISABLED, no motor
 * vector, no stop path. This module imports no encoder at all.
 *
 * The MSP_BOXIDS mapping needed to locate the ARM bit is NOT requested
 * here - it is supplied by the caller from the existing BoxIdsAcquisition,
 * which owns the at-most-once-per-identity guarantee for that command.
 * Re-requesting it would duplicate that ownership.
 *
 * NO POLLING, NO TIMERS, NO RETRIES, NO CACHE, NO SUBSCRIPTION. One call,
 * two awaited requests, one frozen value. A failure is returned, never
 * retried and never thrown.
 *
 * WIRE AUTHORITY (verified directly, not from memory) - betaflight
 * @ 79065c96ba0bb5cdc675e67d7093e05dab8b330e, tag 2025.12.2, MSP API 1.47:
 *
 *   MSP_STATUS_EX  = 150   msp_protocol.h:217 ; handler msp.c:1094-1143
 *     ... 13-byte fixed prefix (flight-mode bits, low 32, at offset 6) ...
 *     u8  PID_PROFILE_COUNT                         msp.c:1110
 *     u8  current control-rate profile index        msp.c:1111
 *     u8  extension byteCount, constrained 0..15    msp.c:1117-1119
 *     .. byteCount extra flight-mode flag bytes     msp.c:1120
 *     u8  ARMING_DISABLE_FLAGS_COUNT (29)           msp.c:1124
 *     u32 getArmingDisableFlags(), UNSIGNED LE      msp.c:1126-1127
 *     u8  config-state; bit0 = getRebootRequired()  msp.c:1132
 *     u16 core temperature (API 1.46)               msp.c:1136-1138
 *     u8  CONTROL_RATE_PROFILE_COUNT                msp.c:1140
 *
 *   MSP_BATTERY_STATE = 130  msp_protocol.h:197 ; handler msp.c:796-811
 *     u8  cell count, 0 = battery not detected      msp.c:798
 *     u16 CONFIGURED capacity mAh / u8 legacy 0.1V / u16 mAh drawn /
 *     s16 amperage 0.01A                            msp.c:799-804
 *     u8  batteryState_e                            msp.c:807
 *     u16 voltage in 0.01V steps - CANONICAL        msp.c:809
 *
 *   ARMING_DISABLED_MSP = (1 << 16)                 runtime_config.h:59
 *   ARMING_DISABLE_FLAGS_COUNT = 29                 runtime_config.h:74
 *   batteryState_e OK/WARNING/CRITICAL/NOT_PRESENT/INIT = 0..4
 *                                                   battery.h:88-94
 *   armed bit = index of BOXARM permanentId 0 in the MSP_BOXIDS reply
 *                     msp_box.c:49, msp_box.c:391-392, msp_box.c:402-418
 */

import {MSP_BATTERY_STATE, MSP_STATUS_EX} from '../protocol/msp/commands/mspCommands';
import {decodeBatteryState} from '../protocol/msp/decoding/decodeBatteryState';
import {decodeStatusExDiagnostics} from '../protocol/msp/decoding/decodeStatusExDiagnostics';
import type {MspRequester} from '../protocol/msp/identification/MspIdentificationService';
import type {BoxIdsResult} from '../protocol/msp/identification/BoxIdsAcquisition';
import {ARMING_DISABLE_FLAG_TOKENS, decodeArmingBlockers, deriveArmedState} from './armingBlockers';
import type {ArmingBlockerBit} from './armingBlockers';
import {motorSessionIdentitiesMatch} from './motorFcFirmwareVersion';
import type {MotorSessionIdentityProvider} from './motorFcFirmwareVersion';
import type {MotorStaticCompatibilityEvaluation} from './motorStaticCompatibility';
import type {MotorStaticFactsSessionIdentity} from './motorStaticFacts';

/** Both commands are classic single-byte-command MSP v1 reads with no
 * parameters, exactly like every other read in this project. */
const EMPTY_REQUEST_PAYLOAD = new Uint8Array(0);
const READ_REQUEST_OPTIONS = {wireFormat: 'v1'} as const;

/**
 * Bit index of ARMING_DISABLED_MSP in the u32 mask. Resolved from the
 * canonical token table rather than written as a literal, so it can never
 * drift away from the pinned enum order that armingBlockers.ts encodes.
 * runtime_config.h:59 gives (1 << 16), i.e. index 16.
 */
export const ARMING_DISABLED_MSP_BIT_INDEX = ARMING_DISABLE_FLAG_TOKENS.indexOf('MSP');

/** battery.h:88-94, complete at the pinned authority. Index === raw value. */
export const BATTERY_STATE_TOKENS: readonly string[] = Object.freeze([
  'BATTERY_OK',
  'BATTERY_WARNING',
  'BATTERY_CRITICAL',
  'BATTERY_NOT_PRESENT',
  'BATTERY_INIT',
]);

/**
 * The FC's OWN battery classification, mapped from its enum. This is a
 * translation of the firmware's byte, not an opinion about the pack: this
 * module never decides whether a voltage is acceptable or a cell count is
 * safe.
 */
export type MotorObservedBatteryClassification =
  | {readonly kind: 'KNOWN'; readonly raw: number; readonly token: string}
  /** A value the pinned authority does not define. Preserved numerically
   * and NEVER coerced into a known state. */
  | {readonly kind: 'UNRECOGNIZED'; readonly raw: number};

/** Armed state as PROVEN from the box mapping. There is no fourth value:
 * an unprovable armed state does not produce an observation at all. */
export type MotorObservedArmedState = 'ARMED' | 'DISARMED';

export interface MotorObservedArmingRestrictions {
  /** The firmware's own declared flag count (29 at the pinned tag). */
  readonly declaredFlagCount: number;
  /** The UNSIGNED u32 mask exactly as received. */
  readonly rawMask: number;
  /** EVERY set bit, known and unknown, in ascending bit order. Nothing is
   * filtered, renamed or dropped. */
  readonly blockers: readonly ArmingBlockerBit[];
  /** Presence of ARMING_DISABLED_MSP (bit 16) specifically. Presence is a
   * fact about the FC's restriction state; it is not a verdict, and its
   * ABSENCE is emphatically not permission to write anything. */
  readonly mspRestrictionPresent: boolean;
  /**
   * Config-state bit 0 (msp.c:1132), or null when the frame stopped
   * before that byte. Null is not a safety loss: REBOOT_REQUIRED is
   * independently carried as arming-disable bit 21, which is above and
   * always present in `blockers`.
   */
  readonly rebootRequired: boolean | null;
}

export interface MotorObservedBattery {
  /** u8 at offset 0. The firmware's own comment: 0 = battery not
   * detected. Reported verbatim; no cell count is inferred from voltage. */
  readonly cellCount: number;
  /** u16 at offset 9, 0.01 V steps - the canonical field. Kept in raw
   * centivolts: no rounding, no volts conversion, no per-cell division,
   * and explicitly no acceptability judgement. */
  readonly voltageCentivolts: number;
  readonly classification: MotorObservedBatteryClassification;
}

/**
 * When the two reads happened, in the caller's monotonic units. Recorded
 * so a later gate can reason about age. It does NOT prove freshness and
 * must never be treated as doing so.
 */
export interface MotorObservationWindow {
  readonly startedAtMonotonicMillis: number;
  readonly completedAtMonotonicMillis: number;
  readonly durationMillis: number;
}

export interface MotorDynamicSafetyObservation {
  /** Fixed discriminant naming what this value is - and is not. */
  readonly observationKind: 'DYNAMIC_OBSERVATION';
  /** Fresh frozen copy of the identity every read was performed under and
   * which the static profile agreed on. */
  readonly sessionIdentity: MotorStaticFactsSessionIdentity;
  readonly armedState: MotorObservedArmedState;
  readonly armingRestrictions: MotorObservedArmingRestrictions;
  readonly battery: MotorObservedBattery;
  readonly observationWindow: MotorObservationWindow;
}

export type MotorDynamicSafetyObservationBlockedReason =
  /** No Pass 1C result, or it was NOT_EVALUATED, or it was UNSUPPORTED.
   * A dynamic observation is never attempted without a proven static
   * profile. */
  | 'STATIC_PROFILE_REQUIRED'
  /** There is no current session identity at all. */
  | 'SESSION_IDENTITY_UNAVAILABLE'
  /** The static profile's identity is not the current one. Zero requests
   * are sent. */
  | 'SESSION_IDENTITY_MISMATCH'
  /** The identity changed while a request was in flight, or between the
   * last response and the return. Everything read is discarded. */
  | 'SESSION_IDENTITY_CHANGED'
  /** No usable MSP_BOXIDS mapping was supplied, so the ARM bit position
   * is unknown. Never guessed. */
  | 'ARMING_BOX_MAPPING_REQUIRED'
  /** A mapping exists but does not prove the armed state (BOXARM absent,
   * or its bit beyond the bits the frame carried). */
  | 'ARMED_STATE_UNOBSERVABLE'
  /** MSP_STATUS_EX arrived but carried no arming-disable mask at all. */
  | 'ARMING_RESTRICTIONS_UNOBSERVABLE'
  /** A request rejected - timeout, MSP error, transport failure. Never
   * retried here. */
  | 'REQUEST_FAILED'
  /** A response was truncated, inconsistent, or otherwise undecodable -
   * including a PARTIALLY PRESENT MSP_STATUS_EX tail. */
  | 'MALFORMED_RESPONSE';

export type MotorDynamicSafetyObservationOutcome =
  | {readonly kind: 'OBSERVED'; readonly observation: MotorDynamicSafetyObservation}
  | {readonly kind: 'NOT_OBSERVED'; readonly reason: MotorDynamicSafetyObservationBlockedReason};

export interface AcquireMotorDynamicSafetyObservationOptions {
  readonly requester: MspRequester;
  /**
   * The Pass 1C evaluation. Anything other than EVALUATED + SUPPORTED
   * stops this function before a single byte is sent.
   */
  readonly staticCompatibility: MotorStaticCompatibilityEvaluation | undefined;
  /**
   * The MSP_BOXIDS mapping ALREADY acquired for this same identity, from
   * the existing BoxIdsAcquisition. Passed in rather than requested so
   * that command keeps its single owner and its at-most-once guarantee.
   */
  readonly boxIds: BoxIdsResult | undefined;
  readonly readCurrentIdentity: MotorSessionIdentityProvider;
  /** Caller-supplied monotonic clock. A clock reading is not a timer: it
   * is never scheduled on, compared against a deadline, or looped. */
  readonly readMonotonicMillis: () => number;
}

function notObserved(
  reason: MotorDynamicSafetyObservationBlockedReason,
): MotorDynamicSafetyObservationOutcome {
  return Object.freeze({kind: 'NOT_OBSERVED', reason} as const);
}

function copySessionIdentity(
  identity: MotorStaticFactsSessionIdentity,
): MotorStaticFactsSessionIdentity {
  // Explicit field copy, never a spread of a caller-owned object.
  return Object.freeze({
    physicalGeneration: identity.physicalGeneration,
    mspEpoch: identity.mspEpoch,
  });
}

/** Arithmetic bit test - JavaScript's bitwise operators are signed 32-bit
 * and would corrupt bit 31 of an unsigned mask. */
function isBitSet(mask: number, index: number): boolean {
  return Math.floor(mask / Math.pow(2, index)) % 2 === 1;
}

function classifyBatteryState(raw: number): MotorObservedBatteryClassification {
  const token = BATTERY_STATE_TOKENS[raw];
  return token !== undefined
    ? Object.freeze({kind: 'KNOWN', raw, token} as const)
    : Object.freeze({kind: 'UNRECOGNIZED', raw} as const);
}

/**
 * Performs the Pass 1D observation.
 *
 * Sequence, and nothing else:
 *   0. prerequisite gate (zero requests if it fails)
 *   1. identity check BEFORE any request
 *   2. MSP_STATUS_EX      (exactly one request)
 *   3. identity check after the awaited response
 *   4. MSP_BATTERY_STATE  (exactly one request)
 *   5. identity check after the awaited response
 *   6. decode + derive; identity check immediately before returning
 *
 * Never throws. Every failure mode is a typed NOT_OBSERVED outcome with
 * no partial observation attached: facts are published all together or
 * not at all, so nothing downstream can act on half a picture.
 */
export async function acquireMotorDynamicSafetyObservation(
  options: AcquireMotorDynamicSafetyObservationOptions,
): Promise<MotorDynamicSafetyObservationOutcome> {
  const {requester, staticCompatibility, boxIds, readCurrentIdentity, readMonotonicMillis} = options;

  // (0) PREREQUISITE. Missing, not-evaluated or unsupported static profile
  // means no dynamic observation is attempted at all - zero MSP requests.
  if (staticCompatibility === undefined || staticCompatibility.kind !== 'EVALUATED') {
    return notObserved('STATIC_PROFILE_REQUIRED');
  }
  const compatibility = staticCompatibility.compatibility;
  if (compatibility.status !== 'SUPPORTED') {
    return notObserved('STATIC_PROFILE_REQUIRED');
  }
  const expectedIdentity = compatibility.sessionIdentity;

  // (1) BEFORE any request: refuse to spend requests on a dead or
  // mismatched scope.
  const identityBeforeRequest = readCurrentIdentity();
  if (identityBeforeRequest === undefined) {
    return notObserved('SESSION_IDENTITY_UNAVAILABLE');
  }
  if (!motorSessionIdentitiesMatch(identityBeforeRequest, expectedIdentity)) {
    return notObserved('SESSION_IDENTITY_MISMATCH');
  }

  // The box mapping is checked here, before the reads, so an unusable
  // mapping costs no MSP traffic either.
  if (boxIds === undefined || boxIds.kind !== 'READY' || boxIds.permanentIds.length === 0) {
    return notObserved('ARMING_BOX_MAPPING_REQUIRED');
  }

  const startedAtMonotonicMillis = readMonotonicMillis();

  // (2) MSP_STATUS_EX - one request, no retry.
  let statusPayload: Uint8Array;
  try {
    const frame = await requester.request(MSP_STATUS_EX, EMPTY_REQUEST_PAYLOAD, READ_REQUEST_OPTIONS);
    statusPayload = frame.payload;
  } catch {
    return notObserved('REQUEST_FAILED');
  }

  // (3) The response describes the session it was read on. If that is no
  // longer the current one, it is discarded rather than decoded.
  if (!motorSessionIdentitiesMatch(readCurrentIdentity(), expectedIdentity)) {
    return notObserved('SESSION_IDENTITY_CHANGED');
  }

  // (4) MSP_BATTERY_STATE - one request, no retry. Sequential, so the two
  // facts are as close together as the existing FIFO allows.
  let batteryPayload: Uint8Array;
  try {
    const frame = await requester.request(
      MSP_BATTERY_STATE,
      EMPTY_REQUEST_PAYLOAD,
      READ_REQUEST_OPTIONS,
    );
    batteryPayload = frame.payload;
  } catch {
    return notObserved('REQUEST_FAILED');
  }

  // (5) Same check again after the second awaited response.
  if (!motorSessionIdentitiesMatch(readCurrentIdentity(), expectedIdentity)) {
    return notObserved('SESSION_IDENTITY_CHANGED');
  }

  const completedAtMonotonicMillis = readMonotonicMillis();

  let status;
  let battery;
  try {
    status = decodeStatusExDiagnostics(statusPayload);
    battery = decodeBatteryState(batteryPayload);
  } catch {
    // Truncated or undecodable. Fail closed: nothing partial escapes.
    return notObserved('MALFORMED_RESPONSE');
  }

  const readiness = status.readiness;
  if (readiness.malformedTail === true) {
    // A field was PARTIALLY present. Nothing after the fixed prefix can
    // be trusted, and this is never normalized into "no blockers".
    return notObserved('MALFORMED_RESPONSE');
  }

  const armedState = deriveArmedState(
    status.flightModeFlagsLow32,
    readiness.extraFlightModeFlagBytes,
    boxIds.permanentIds,
  );
  if (armedState === 'UNKNOWN') {
    // BOXARM absent from the mapping, or its bit beyond the bits the
    // frame carried. Never guessed, and never inferred from the
    // arming-disable mask.
    return notObserved('ARMED_STATE_UNOBSERVABLE');
  }

  const rawMask = readiness.armingDisableFlags;
  const declaredFlagCount = readiness.armingDisableFlagsCount;
  if (rawMask === undefined || declaredFlagCount === undefined) {
    // Honest absence of the whole field, which is still unusable here: a
    // missing mask is NOT an empty mask.
    return notObserved('ARMING_RESTRICTIONS_UNOBSERVABLE');
  }

  // (6) Immediately before returning - keeps the guarantee unconditional:
  // an observation only ever exists while its identity is still current.
  if (!motorSessionIdentitiesMatch(readCurrentIdentity(), expectedIdentity)) {
    return notObserved('SESSION_IDENTITY_CHANGED');
  }

  return Object.freeze({
    kind: 'OBSERVED',
    observation: Object.freeze({
      observationKind: 'DYNAMIC_OBSERVATION',
      sessionIdentity: copySessionIdentity(expectedIdentity),
      armedState,
      armingRestrictions: Object.freeze({
        declaredFlagCount,
        rawMask,
        blockers: decodeArmingBlockers(rawMask),
        mspRestrictionPresent: isBitSet(rawMask, ARMING_DISABLED_MSP_BIT_INDEX),
        rebootRequired: readiness.rebootRequired ?? null,
      } as const),
      battery: Object.freeze({
        cellCount: battery.cellCount,
        voltageCentivolts: battery.voltageCentivolts,
        classification: classifyBatteryState(battery.batteryStateRaw),
      } as const),
      observationWindow: Object.freeze({
        startedAtMonotonicMillis,
        completedAtMonotonicMillis,
        durationMillis: completedAtMonotonicMillis - startedAtMonotonicMillis,
      } as const),
    } as const),
  } as const);
}
