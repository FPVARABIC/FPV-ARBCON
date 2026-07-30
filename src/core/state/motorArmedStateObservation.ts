/**
 * ONE READ, ONE QUESTION: is the flight controller ARMED right now?
 *
 * WHY THIS EXISTS SEPARATELY FROM Pass 1D
 * ---------------------------------------
 * `motorDynamicSafetyObservation.ts` answers a much larger question - armed
 * state, the whole arming-disable mask, cell count, pack voltage and the
 * FC's own battery classification - and it will not answer any of it
 * without a full Pass 1C static-compatibility evaluation, which in turn
 * needs the identification chain and a pinned firmware version. That whole
 * apparatus exists to serve a policy this bench mode no longer runs.
 *
 * The simplified bench gate needs exactly one live fact, repeatedly: the
 * FC says it is disarmed. This module is that fact and nothing more:
 *
 *   ONE command  - MSP_STATUS_EX (150), an OUT/read message.
 *   ONE decoding - the already-accepted decodeStatusExDiagnostics.
 *   ONE derivation - the already-accepted deriveArmedState, against the
 *                    caller-supplied MSP_BOXIDS mapping.
 *
 * IT CANNOT WRITE. No encoder is imported, no payload is built, and the
 * only command constant in scope is a read. It cannot construct
 * MSP_SET_MOTOR even in principle. It takes a `MspRequester` - in
 * production always the ONE live motor-test lease - and adds no client, no
 * transport, no second queue and no raw-write bypass.
 *
 * NO TIMER, NO RETRY, NO POLL, NO CACHE. One call, one awaited request,
 * one frozen value. Repetition is the caller's business; this function
 * never schedules itself.
 *
 * WHAT AN `OBSERVED` RESULT PROVES, EXACTLY. That at the instant the
 * response was decoded, the flight controller on THIS session reported the
 * BOXARM bit clear (or set). It is not a claim that the state is still
 * true after this function returns, and `observedAtMonotonicMillis` is an
 * AGE BOUND for a later freshness test - never a claim of continuous
 * truth between readings.
 *
 * WIRE AUTHORITY (unchanged from Pass 1D, restated so this file stands on
 * its own) - betaflight @ 79065c96ba0bb5cdc675e67d7093e05dab8b330e, tag
 * 2025.12.2, MSP API 1.47:
 *
 *   MSP_STATUS_EX = 150   msp_protocol.h:217 ; handler msp.c:1094-1143
 *     ... 13-byte fixed prefix, flight-mode bits low 32 at offset 6 ...
 *     u8  extension byteCount, constrained 0..15    msp.c:1117-1119
 *     .. byteCount extra flight-mode flag bytes     msp.c:1120
 *
 *   armed bit = index of BOXARM permanentId 0 in the MSP_BOXIDS reply
 *                     msp_box.c:49, msp_box.c:391-392, msp_box.c:402-418
 */

import {MSP_STATUS_EX} from '../protocol/msp/commands/mspCommands';
import {decodeStatusExDiagnostics} from '../protocol/msp/decoding/decodeStatusExDiagnostics';
import type {MspRequester} from '../protocol/msp/identification/MspIdentificationService';
import {deriveArmedState} from './armingBlockers';
import {motorSessionIdentitiesMatch} from './motorFcFirmwareVersion';
import type {MotorSessionIdentityProvider} from './motorFcFirmwareVersion';
import type {MotorStaticFactsSessionIdentity} from './motorStaticFacts';

/** MSP_STATUS_EX is a classic parameterless MSP v1 read. */
const EMPTY_REQUEST_PAYLOAD = new Uint8Array(0);
const READ_REQUEST_OPTIONS = {wireFormat: 'v1'} as const;

/** There is no third value. An unprovable armed state produces no
 * observation at all, so nothing downstream can normalize "unknown" into
 * "disarmed". */
export type MotorObservedArmedStateValue = 'ARMED' | 'DISARMED';

export interface MotorArmedStateObservation {
  /** Fixed discriminant naming what this value is - and is not. */
  readonly observationKind: 'ARMED_STATE_OBSERVATION';
  readonly armedState: MotorObservedArmedStateValue;
  /** Fresh frozen copy of the identity the read was performed under. */
  readonly sessionIdentity: MotorStaticFactsSessionIdentity;
  /** When the response was decoded, in the caller's monotonic units. An
   * age bound for a later freshness test, never a freshness claim. */
  readonly observedAtMonotonicMillis: number;
}

export type MotorArmedStateObservationFailure =
  /** There is no current session identity at all. Zero requests sent. */
  | 'SESSION_IDENTITY_UNAVAILABLE'
  /** The identity is not the expected one, or moved under the read.
   * Everything read is discarded. */
  | 'SESSION_IDENTITY_CHANGED'
  /** No usable MSP_BOXIDS mapping was supplied, so the ARM bit position is
   * unknown. Never guessed. Zero requests sent. */
  | 'ARMING_BOX_MAPPING_REQUIRED'
  /** A mapping exists but does not prove the armed state (BOXARM absent,
   * or its bit beyond the bits the frame carried). */
  | 'ARMED_STATE_UNOBSERVABLE'
  /** The request rejected - timeout, MSP error, transport failure. Never
   * retried here. */
  | 'REQUEST_FAILED'
  /** The response was truncated, undecodable, or carried a PARTIALLY
   * PRESENT tail. Never normalized. */
  | 'MALFORMED_RESPONSE';

export type MotorArmedStateObservationOutcome =
  | {
      readonly kind: 'OBSERVED';
      readonly observation: MotorArmedStateObservation;
    }
  | {
      readonly kind: 'NOT_OBSERVED';
      readonly reason: MotorArmedStateObservationFailure;
    };

export interface ObserveMotorArmedStateOptions {
  /** In production, the ONE live motor-test lease. Never a second path. */
  readonly requester: MspRequester;
  /** The identity every read must belong to, captured once at setup. */
  readonly expectedIdentity: MotorStaticFactsSessionIdentity;
  /**
   * MSP_BOXIDS permanent ids in wire order, already acquired for this same
   * session. Supplied rather than re-requested so that command keeps its
   * single owner and its at-most-once guarantee.
   */
  readonly boxIdPermanentIds: readonly number[] | undefined;
  readonly readCurrentIdentity: MotorSessionIdentityProvider;
  /** A clock READING, never a timer: nothing here schedules on it. */
  readonly readMonotonicMillis: () => number;
}

function notObserved(
  reason: MotorArmedStateObservationFailure,
): MotorArmedStateObservationOutcome {
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

/**
 * Performs one armed-state observation.
 *
 * Sequence, and nothing else:
 *   0. box mapping present (zero requests if not)
 *   1. identity check BEFORE the request
 *   2. MSP_STATUS_EX - exactly one request
 *   3. identity check after the awaited response
 *   4. decode + derive; identity check immediately before returning
 *
 * NEVER THROWS. Every failure mode is a typed NOT_OBSERVED outcome with no
 * partial observation attached.
 */
export async function observeMotorArmedState(
  options: ObserveMotorArmedStateOptions,
): Promise<MotorArmedStateObservationOutcome> {
  const {
    requester,
    expectedIdentity,
    boxIdPermanentIds,
    readCurrentIdentity,
    readMonotonicMillis,
  } = options;

  // (0) An unusable mapping costs no MSP traffic.
  if (boxIdPermanentIds === undefined || boxIdPermanentIds.length === 0) {
    return notObserved('ARMING_BOX_MAPPING_REQUIRED');
  }

  // (1) Refuse to spend a request on a dead or mismatched session.
  const identityBefore = readCurrentIdentity();
  if (identityBefore === undefined) {
    return notObserved('SESSION_IDENTITY_UNAVAILABLE');
  }
  if (!motorSessionIdentitiesMatch(identityBefore, expectedIdentity)) {
    return notObserved('SESSION_IDENTITY_CHANGED');
  }

  // (2) One request, no retry.
  let statusPayload: Uint8Array;
  try {
    const frame = await requester.request(
      MSP_STATUS_EX,
      EMPTY_REQUEST_PAYLOAD,
      READ_REQUEST_OPTIONS,
    );
    statusPayload = frame.payload;
  } catch {
    return notObserved('REQUEST_FAILED');
  }

  // (3) The response describes the session it was read on. If that is no
  // longer the current one it is discarded rather than decoded.
  if (!motorSessionIdentitiesMatch(readCurrentIdentity(), expectedIdentity)) {
    return notObserved('SESSION_IDENTITY_CHANGED');
  }

  let status;
  try {
    status = decodeStatusExDiagnostics(statusPayload);
  } catch {
    return notObserved('MALFORMED_RESPONSE');
  }
  if (status.readiness.malformedTail === true) {
    // A field was PARTIALLY present. Nothing after the fixed prefix can be
    // trusted, and this is never normalized into "disarmed".
    return notObserved('MALFORMED_RESPONSE');
  }

  const armedState = deriveArmedState(
    status.flightModeFlagsLow32,
    status.readiness.extraFlightModeFlagBytes,
    boxIdPermanentIds,
  );
  if (armedState === 'UNKNOWN') {
    // BOXARM absent from the mapping, or its bit beyond the bits the frame
    // carried. Never guessed, never inferred from the arming-disable mask.
    return notObserved('ARMED_STATE_UNOBSERVABLE');
  }

  const observedAtMonotonicMillis = readMonotonicMillis();

  // (4) Immediately before returning - keeps the guarantee unconditional:
  // an observation only ever exists while its identity is still current.
  if (!motorSessionIdentitiesMatch(readCurrentIdentity(), expectedIdentity)) {
    return notObserved('SESSION_IDENTITY_CHANGED');
  }

  return Object.freeze({
    kind: 'OBSERVED',
    observation: Object.freeze({
      observationKind: 'ARMED_STATE_OBSERVATION',
      armedState,
      sessionIdentity: copySessionIdentity(expectedIdentity),
      observedAtMonotonicMillis,
    } as const),
  } as const);
}
