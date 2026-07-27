/**
 * Pass 1C-P2 - the FC's own reported FIRMWARE version, acquired as a
 * NARROW, MOTOR-SCOPED, SESSION-BOUND fact.
 *
 * WHY THIS IS NOT PART OF GLOBAL IDENTIFICATION. An earlier attempt added
 * MSP_FC_VERSION as a fourth mandatory step inside
 * MspIdentificationService.identify(). Because a version response must
 * fail closed for the motor gate, that made the ENTIRE flight-controller
 * identification all-or-nothing on a newly required command: a firmware
 * that does not implement it, times out on it, or reports a version this
 * decoder considers incoherent would have taken down the top bar,
 * telemetry ownership and the FC tools - none of which need a version.
 * Eight unrelated platform/UI suites failed, which is exactly that
 * regression made visible.
 *
 * So global identification is UNTOUCHED and still requests exactly
 * MSP_API_VERSION -> MSP_FC_VARIANT -> MSP_BOARD_INFO. The version is
 * acquired only when something motor-related explicitly asks for it, and
 * a failure here is fatal ONLY to that request.
 *
 * SESSION COHERENCE IS THE POINT. A version read on one physical USB
 * session (or before a desync/recovery bumped the MSP epoch) says nothing
 * about the aircraft on the current one. The composite identity
 * `(physicalGeneration, mspEpoch)` is therefore checked THREE times -
 * before the request, after the awaited response, and immediately before
 * returning - and any change yields a typed failure with NO binding. A
 * later gate can then require this binding's identity to equal the
 * MotorStaticFactsBinding's identity, proving both were read coherently.
 *
 * An identity match means only that two identity values are equal. It
 * NEVER proves the session is still current after this function returns.
 *
 * NOT READINESS. A successfully decoded version is a fact about firmware.
 * It is not motor-test readiness, not safety, not authorization, and not
 * permission to pulse anything.
 */

import {MSP_FC_VERSION} from '../protocol/msp/commands/mspCommands';
import {decodeFcVersion} from '../protocol/msp/decoding/decodeFcVersion';
import type {MspFcVersion} from '../protocol/msp/decoding/decodeFcVersion';
import type {MspRequester} from '../protocol/msp/identification/MspIdentificationService';
import type {MotorStaticFactsSessionIdentity} from './motorStaticFacts';

/** Same empty request payload every other read command in this project
 * sends. MSP_FC_VERSION takes no parameters (msp.c:642-647). */
const EMPTY_REQUEST_PAYLOAD = new Uint8Array(0);

/** Matches the wire format the rest of this project's identification
 * reads use - a classic single-byte-command MSP v1 request. */
const FC_VERSION_REQUEST_OPTIONS = {wireFormat: 'v1'} as const;

/**
 * Immutable, explicitly-copied mirror of the decoded MspFcVersion. Field
 * by field, never a spread: only these six values may cross into the
 * snapshot, whatever the decoded object happens to carry.
 */
export interface MotorFcFirmwareVersionSnapshot {
  readonly yearOffsetRaw: number;
  readonly year: number;
  readonly month: number;
  readonly patch: number;
  /** The exact text the FC sent, suffix included. */
  readonly versionString: string;
  /** The suffix without its '-' delimiter, or null for a final release. */
  readonly suffix: string | null;
}

/**
 * The version snapshot together with the composite session identity it
 * was read under. Reuses MotorStaticFactsSessionIdentity verbatim - the
 * same `(physicalGeneration, mspEpoch)` pair MotorStaticFactsBinding
 * carries - so a later gate can compare the two directly.
 *
 * Holds DATA ONLY. No MspClient, transport, callback, mutable source
 * object or runtime owner is ever stored here.
 */
export interface MotorFcFirmwareVersionBinding {
  readonly sessionIdentity: MotorStaticFactsSessionIdentity;
  readonly firmwareVersion: MotorFcFirmwareVersionSnapshot;
}

export type MotorFcFirmwareVersionFailureReason =
  /** The identity provider had no current session at all. */
  | 'SESSION_IDENTITY_UNAVAILABLE'
  /** The expected identity did not match the current one before the
   * request was ever sent. */
  | 'SESSION_IDENTITY_MISMATCH'
  /** The identity changed while the request was in flight, or between the
   * response and the return. */
  | 'SESSION_IDENTITY_CHANGED'
  /** The request itself rejected - timeout, MSP error, transport failure.
   * Never retried here. */
  | 'REQUEST_FAILED'
  /** The response arrived but was truncated, incoherent or otherwise not
   * a valid MSP_FC_VERSION payload. */
  | 'MALFORMED_RESPONSE';

export type MotorFcFirmwareVersionAcquisition =
  | {readonly kind: 'ACQUIRED'; readonly binding: MotorFcFirmwareVersionBinding}
  | {readonly kind: 'UNAVAILABLE'; readonly reason: MotorFcFirmwareVersionFailureReason};

/**
 * Reads the identity currently in force. Supplied by the caller so this
 * pure-core module never reaches into the platform session layer itself;
 * returns undefined when there is no current session.
 */
export type MotorSessionIdentityProvider = () => MotorStaticFactsSessionIdentity | undefined;

export interface AcquireMotorFcFirmwareVersionOptions {
  readonly requester: MspRequester;
  /** The identity the caller believes it is operating under. */
  readonly expectedIdentity: MotorStaticFactsSessionIdentity;
  readonly readCurrentIdentity: MotorSessionIdentityProvider;
}

/**
 * Pure structural comparison of two composite session identities. No
 * exported comparator existed - BoxIdsAcquisition's own identityKey() is
 * module-private - so this narrowly typed helper is provided here.
 *
 * Equality means the two VALUES are equal. It does not, and cannot, prove
 * that either identity is still the current one.
 */
export function motorSessionIdentitiesMatch(
  left: MotorStaticFactsSessionIdentity | undefined,
  right: MotorStaticFactsSessionIdentity | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return false;
  }
  return left.physicalGeneration === right.physicalGeneration && left.mspEpoch === right.mspEpoch;
}

function snapshotFirmwareVersion(decoded: MspFcVersion): MotorFcFirmwareVersionSnapshot {
  return Object.freeze({
    yearOffsetRaw: decoded.yearOffsetRaw,
    year: decoded.year,
    month: decoded.month,
    patch: decoded.patch,
    versionString: decoded.versionString,
    suffix: decoded.suffix,
  });
}

function snapshotSessionIdentity(
  identity: MotorStaticFactsSessionIdentity,
): MotorStaticFactsSessionIdentity {
  // Projected field by field so a caller that keeps mutating its own
  // session key cannot rewrite which session this version was read on.
  return Object.freeze({
    physicalGeneration: identity.physicalGeneration,
    mspEpoch: identity.mspEpoch,
  });
}

function unavailable(
  reason: MotorFcFirmwareVersionFailureReason,
): MotorFcFirmwareVersionAcquisition {
  return Object.freeze({kind: 'UNAVAILABLE', reason});
}

/**
 * Requests MSP_FC_VERSION EXACTLY ONCE and returns a frozen binding, or a
 * typed failure and no binding.
 *
 * No retry, no polling, no timer, no cache, no fallback. It never
 * substitutes the MSP API version, the firmware variant, a user-supplied
 * string or a build-time provenance constant for the FC's own answer -
 * there is simply no other source in this function.
 *
 * Uses the caller's existing MspRequester (i.e. the existing MspClient
 * and therefore the existing FIFO, timeouts and recovery behaviour); it
 * opens nothing, owns nothing and changes no transport state.
 */
export async function acquireMotorFcFirmwareVersion(
  options: AcquireMotorFcFirmwareVersionOptions,
): Promise<MotorFcFirmwareVersionAcquisition> {
  const {requester, expectedIdentity, readCurrentIdentity} = options;

  // (1) Before the request: refuse to spend a request on a dead or
  // mismatched scope.
  const identityBeforeRequest = readCurrentIdentity();
  if (identityBeforeRequest === undefined) {
    return unavailable('SESSION_IDENTITY_UNAVAILABLE');
  }
  if (!motorSessionIdentitiesMatch(identityBeforeRequest, expectedIdentity)) {
    return unavailable('SESSION_IDENTITY_MISMATCH');
  }

  let payload: Uint8Array;
  try {
    const frame = await requester.request(
      MSP_FC_VERSION,
      EMPTY_REQUEST_PAYLOAD,
      FC_VERSION_REQUEST_OPTIONS,
    );
    payload = frame.payload;
  } catch {
    // Timeout, MSP error, transport failure - all one outcome, and never
    // retried inside this call.
    return unavailable('REQUEST_FAILED');
  }

  // (2) After the awaited response: a generation or epoch change while
  // the request was in flight means this payload describes a different
  // session, so it is discarded rather than decoded into a binding.
  if (!motorSessionIdentitiesMatch(readCurrentIdentity(), expectedIdentity)) {
    return unavailable('SESSION_IDENTITY_CHANGED');
  }

  let decoded: MspFcVersion;
  try {
    decoded = decodeFcVersion(payload);
  } catch {
    // Truncated, incoherent or otherwise invalid. Fail closed: no
    // partial binding, no cached value, nothing published.
    return unavailable('MALFORMED_RESPONSE');
  }

  // (3) Immediately before returning: the decode itself is synchronous,
  // but this keeps the guarantee unconditional - a binding is only ever
  // produced while the expected identity is still the current one.
  if (!motorSessionIdentitiesMatch(readCurrentIdentity(), expectedIdentity)) {
    return unavailable('SESSION_IDENTITY_CHANGED');
  }

  return Object.freeze({
    kind: 'ACQUIRED',
    binding: Object.freeze({
      sessionIdentity: snapshotSessionIdentity(expectedIdentity),
      firmwareVersion: snapshotFirmwareVersion(decoded),
    }),
  });
}
