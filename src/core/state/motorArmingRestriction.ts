/**
 * Pass 3 - the SESSION-BOUND MSP ARMING RESTRICTION primitive.
 *
 * WHAT THIS DOES
 * --------------
 * Issues Betaflight's officially verified arming-disable request through
 * the exact active Pass 2 motor-test lease, then acquires ONE fresh
 * post-ACK status observation through that same lease and checks it. A
 * positive receipt is produced only when every piece of required evidence
 * was obtained under one unchanged composite session identity.
 *
 * WHAT A POSITIVE RECEIPT MEANS - EXACTLY
 * ---------------------------------------
 *   "An arming-disable request was acknowledged, and the required fresh
 *    post-ACK evidence was observed, for this lease and this composite
 *    identity."
 *
 * That is the whole claim. A receipt is NOT motor safety and NOT
 * authorization. It does not authorize a motor command, does not prevent
 * MSP_SET_MOTOR, does not prove mechanical stop, does not replace
 * exclusive ownership, does not replace a native stop/watchdog, and does
 * not stay true without later continuous monitoring. There is no `safe`,
 * `ready`, `authorized`, `approved`, `allowed`, `permission`, `canTest`,
 * `canPulse` or `canStart` field on the public surface, and a test
 * asserts their absence.
 *
 * A receipt is NOT permission to pulse a motor.
 *
 * THE AGGREGATE-VERSUS-DESCRIPTOR LIMITATION (read this before trusting
 * a receipt for anything)
 * ------------------------------------------------------------------
 * At the pinned tag the firmware keeps TWO separate things:
 *   - a per-MSP-descriptor bitmask, `mspArmingDisableFlags`
 *     (msp.c:227-244), set by `mspArmingDisableByDescriptor(srcDesc)`;
 *   - the global `armingDisableFlags` (runtime_config.c:71-91), which
 *     receives `setArmingDisabled(ARMING_DISABLED_MSP)`.
 * Only the GLOBAL one is ever serialized - MSP_STATUS_EX reports
 * `getArmingDisableFlags()`. The per-descriptor bitmask is exposed
 * nowhere in the protocol.
 *
 * Therefore the fresh post-ACK read is AGGREGATE CORROBORATION ONLY. It
 * proves that some MSP descriptor holds the restriction; it can NEVER
 * prove that THIS descriptor owns it, because API 1.47 offers no way to
 * ask. Another MSP client on another port could have produced the same
 * observed bit. This limitation is recorded on the receipt itself, in
 * `evidenceScope`, so no consumer can quietly forget it.
 *
 * ACK IS ONLY ACK. `mspFcProcessCommand` (msp.c:4421-4449) assigns
 * `reply->result` after the handler switch, so an ACK does prove the
 * command was received and processed - and nothing more. It is never, on
 * its own, promoted into a positive result here.
 *
 * NO CLEARING, NO RE-ENABLE. The inverse payload (byte 0) exists in the
 * firmware, and this module deliberately does not implement, expose or
 * encode it. Teardown - which must also have confirmed motor stop and
 * lifecycle safety - belongs to a later pass. Note that at the pinned tag
 * the restriction is STICKY: `mspArmingDisableFlags` is never cleared on
 * port release, disconnect, detach or descriptor destruction (its only
 * three touch points are msp.c:232/238/243), and `resetMspPort`
 * (msp_serial.c:47-54) allocates a brand-new, never-reused descriptor. So
 * after a detach the old descriptor's bit remains set and arming stays
 * disabled until the FC reboots. Releasing a JavaScript receipt clears
 * nothing on the FC.
 *
 * NO TIMERS, NO RETRIES, NO POLLING, NO TTL, NO CLOCK, NO EXPIRY, NO
 * AUTOMATIC CONTINUATION. One attempt, two requests, one answer.
 *
 * NO RUNTIME CALLER EXISTS. Nothing in the application establishes the
 * restriction in this pass, and telemetry polling is untouched.
 *
 * OFFICIAL SOURCE, verified at the exact lightweight tag `2025.12.2`
 * (betaflight/betaflight @ 79065c96ba0bb5cdc675e67d7093e05dab8b330e,
 * API_VERSION_MAJOR 1 / API_VERSION_MINOR 47, msp_protocol.h:61-62):
 *
 *   MSP_SET_ARMING_DISABLED = 99        msp_protocol.h:169
 *     handler msp.c:3623-3653, inside
 *     `static mspResult_e mspProcessInCommand(mspDescriptor_t srcDesc,
 *      int16_t cmdMSP, sbuf_t *src)` (msp.c:2647)
 *
 *     byte 0  REQUIRED  `const uint8_t command = sbufReadU8(src);`
 *                       non-zero => disable arming
 *     byte 1  OPTIONAL  `if (sbufBytesRemaining(src)) { disableRunawayTakeoff
 *                       = sbufReadU8(src); }` - consulted ONLY in the
 *                       enable branch; the disable branch calls
 *                       `runawayTakeoffTemporaryDisable(false)` with a
 *                       hardcoded literal and ignores it entirely.
 *     => the disable request is EXACTLY ONE BYTE. Single bytes, so byte
 *        order does not apply.
 *
 *     disable branch:  mspArmingDisableByDescriptor(srcDesc);
 *                      setArmingDisabled(ARMING_DISABLED_MSP);
 *                      if (ARMING_FLAG(ARMED)) disarm(DISARM_REASON_ARMING_DISABLED);
 *       - NOT rejected while armed; it actively DISARMS.
 *       - idempotent (`|=` on a bitmask; runtime_config.c:73-76).
 *
 *   ARMING_DISABLED_MSP = (1 << 16)     runtime_config.h:59
 *   MSP_STATUS_EX = 150                 msp_protocol.h:217
 *     armed state via the BOXARM bit of the packed flight-mode flags
 *     (msp_box.c:49 permanentId 0, msp_box.c:402-418 packing order);
 *     arming-disable mask is an UNSIGNED u32 (msp.c:1126-1127).
 */

import {
  MotorTestLease,
  mspSessionCompositeIdentitiesMatch,
  type MspSessionCompositeIdentity,
  type MspSessionIdentityProvider,
} from '../protocol/motorTestLease';
import {decodeStatusExDiagnostics} from '../protocol/msp/decoding/decodeStatusExDiagnostics';
import type {BoxIdsResult} from '../protocol/msp/identification/BoxIdsAcquisition';
import {ARMING_DISABLE_FLAG_TOKENS, deriveArmedState} from './armingBlockers';

/* ------------------------------------------------------------------ *
 * Officially verified wire constants
 * ------------------------------------------------------------------ */

/**
 * msp_protocol.h:169 @ the pinned tag:
 *   `#define MSP_SET_ARMING_DISABLED 99   // in message: Enable/disable arming`
 *
 * Declared HERE rather than in the shared command table on purpose: this
 * is the only module in the project permitted to build it, and keeping it
 * local means no other code can reach for it by accident.
 */
export const MSP_SET_ARMING_DISABLED = 99;

/** msp_protocol.h:217. Re-declared locally for the same reason. */
export const MSP_STATUS_EX = 150;

/** The single mandatory payload byte, non-zero = disable arming. */
export const ARMING_DISABLE_COMMAND_BYTE = 1;

/** Bit index of ARMING_DISABLED_MSP, resolved from the canonical token
 * table rather than written as a literal so it cannot drift from the
 * pinned enum order. runtime_config.h:59 gives (1 << 16). */
export const ARMING_DISABLED_MSP_BIT_INDEX = ARMING_DISABLE_FLAG_TOKENS.indexOf('MSP');

/** Classic single-byte-command MSP v1, as every other request here. */
const REQUEST_OPTIONS = {wireFormat: 'v1'} as const;

const EMPTY_PAYLOAD = new Uint8Array(0);

/**
 * Builds the one-byte arming-DISABLE payload. A fresh array every call,
 * so no caller can mutate a shared buffer.
 *
 * There is deliberately NO inverse builder anywhere in this module: the
 * re-enable payload (byte 0) is not encoded, not exposed and not
 * reachable from any exported symbol.
 */
export function buildArmingDisablePayload(): Uint8Array {
  return Uint8Array.from([ARMING_DISABLE_COMMAND_BYTE]);
}

/* ------------------------------------------------------------------ *
 * Result model
 * ------------------------------------------------------------------ */

export type MotorArmingRestrictionFailureReason =
  /** No current session identity was available. */
  | 'CURRENT_SESSION_IDENTITY_UNAVAILABLE'
  /** Requested identity is not the current one. */
  | 'REQUESTED_SESSION_IDENTITY_MISMATCH'
  /** No lease, or it is released, invalidated, faulted or forged. */
  | 'MOTOR_TEST_LEASE_INACTIVE'
  /** The lease belongs to a different composite identity. */
  | 'MOTOR_TEST_LEASE_IDENTITY_MISMATCH'
  /** Another establishment attempt is already running for this lease. */
  | 'ARMING_RESTRICTION_ALREADY_ESTABLISHING'
  /** This lease already holds a positive receipt. */
  | 'ARMING_RESTRICTION_ALREADY_ESTABLISHED'
  /** A previous attempt on this lease failed closed. */
  | 'ARMING_RESTRICTION_FAULT_LATCHED'
  /** The arming-disable request itself rejected. */
  | 'ARMING_DISABLE_REQUEST_FAILED'
  /** The fresh post-ACK status request rejected. */
  | 'POST_ACK_STATUS_REQUEST_FAILED'
  /** Composite identity changed across an await. */
  | 'SESSION_CHANGED_DURING_ESTABLISHMENT'
  /** The FC reported itself ARMED after the ACK. */
  | 'FC_ARMED'
  /** The aggregate MSP arming-disable bit was not set after the ACK. */
  | 'MSP_ARMING_RESTRICTION_NOT_OBSERVED'
  /** The status frame carried no usable arming-disable mask, or the ARM
   * bit could not be located, so no independent evidence exists. */
  | 'INDEPENDENT_VERIFICATION_UNAVAILABLE'
  /** The status response was truncated or otherwise undecodable. */
  | 'MALFORMED_STATUS_RESPONSE';

/**
 * How strong the post-ACK evidence actually is. There is exactly one
 * possible value at API 1.47, and it says the honest thing.
 */
export type MotorArmingRestrictionEvidenceScope = 'AGGREGATE_NOT_DESCRIPTOR_SPECIFIC';

/** Token storage - module-private, weak, never an own property of the
 * receipt, so spreading and JSON round-tripping cannot carry it. */
const RECEIPT_TOKENS = new WeakMap<MotorArmingRestrictionReceipt, object>();
const RECEIPT_LEASES = new WeakMap<MotorArmingRestrictionReceipt, MotorTestLease>();

/** Per-lease establishment bookkeeping. Weak, so nothing leaks and no
 * global identity registry is invented - the canonical same-session fault
 * latch still lives in MspClient, exactly where Pass 2 put it. */
const IN_PROGRESS = new WeakSet<MotorTestLease>();
type LeaseOutcome =
  | {readonly kind: 'ESTABLISHED'; readonly receipt: MotorArmingRestrictionReceipt}
  | {readonly kind: 'FAULTED'};
const LEASE_OUTCOMES = new WeakMap<MotorTestLease, LeaseOutcome>();

function copyIdentity(identity: MspSessionCompositeIdentity): MspSessionCompositeIdentity {
  return Object.freeze({
    physicalGeneration: identity.physicalGeneration,
    mspEpoch: identity.mspEpoch,
  });
}

/**
 * Opaque proof-of-observation. A class, so its methods live on the
 * prototype: `{...receipt}` and `JSON.parse(JSON.stringify(receipt))`
 * both yield a plain object with no methods and no token, and the module
 * would reject it anyway. Never persisted, never transferable.
 */
export class MotorArmingRestrictionReceipt {
  /** Names precisely what was observed - not what it permits. */
  readonly receiptKind = 'MSP_ARMING_RESTRICTION_OBSERVED' as const;
  /** Frozen copy of the composite identity everything happened under. */
  readonly sessionIdentity: MspSessionCompositeIdentity;
  /**
   * The honest strength of the evidence. API 1.47 exposes only the
   * GLOBAL arming-disable mask, never the per-descriptor bitmask, so this
   * can never say "descriptor specific".
   */
  readonly evidenceScope: MotorArmingRestrictionEvidenceScope =
    'AGGREGATE_NOT_DESCRIPTOR_SPECIFIC';

  /** @internal Constructed only by establishMotorArmingRestriction(). */
  constructor(identity: MspSessionCompositeIdentity) {
    this.sessionIdentity = copyIdentity(identity);
    Object.freeze(this);
  }

  /**
   * Whether this receipt still describes live ownership.
   *
   * Point-in-time only: `true` means the lease that produced it is still
   * the live owner and this is still that lease's recorded receipt. It
   * does NOT re-read the FC and does NOT prove the restriction is still
   * in force - the FC could have changed a microsecond later, and
   * detecting removal remains unsolved.
   */
  isCurrent(): boolean {
    const lease = RECEIPT_LEASES.get(this);
    const token = RECEIPT_TOKENS.get(this);
    if (lease === undefined || token === undefined || !lease.isActive()) {
      return false;
    }
    const outcome = LEASE_OUTCOMES.get(lease);
    return outcome?.kind === 'ESTABLISHED' && outcome.receipt === this;
  }
}

export type MotorArmingRestrictionEstablishment =
  | {readonly kind: 'ESTABLISHED'; readonly receipt: MotorArmingRestrictionReceipt}
  | {readonly kind: 'NOT_ESTABLISHED'; readonly reason: MotorArmingRestrictionFailureReason};

export interface EstablishMotorArmingRestrictionOptions {
  /** The exact active Pass 2 capability. Only a lease is accepted - there
   * is no parameter for a raw MspClient, transport or writeBytes. */
  readonly lease: MotorTestLease | undefined;
  readonly requestedIdentity: MspSessionCompositeIdentity;
  readonly readCurrentIdentity: MspSessionIdentityProvider;
  /**
   * The already-acquired MSP_BOXIDS mapping for this same session, used
   * to locate the ARM bit. Supplied rather than re-requested so
   * BoxIdsAcquisition keeps its at-most-once-per-identity ownership, and
   * so this pass adds exactly the two authorized requests.
   */
  readonly boxIds: BoxIdsResult | undefined;
}

function notEstablished(
  reason: MotorArmingRestrictionFailureReason,
): MotorArmingRestrictionEstablishment {
  return Object.freeze({kind: 'NOT_ESTABLISHED', reason} as const);
}

/**
 * Fails the whole attempt closed: the lease is faulted through the SAME
 * canonical Pass 2 latch (no second fault manager), the identity is
 * latched there, and every receipt from that lease stops being current.
 */
function failClosed(
  lease: MotorTestLease,
  reason: MotorArmingRestrictionFailureReason,
): MotorArmingRestrictionEstablishment {
  LEASE_OUTCOMES.set(lease, Object.freeze({kind: 'FAULTED'} as const));
  lease.failClosed();
  return notEstablished(reason);
}

/** Arithmetic bit test - JavaScript bitwise operators are signed 32-bit
 * and would corrupt bit 31 of an unsigned mask. */
function isBitSet(mask: number, index: number): boolean {
  return Math.floor(mask / Math.pow(2, index)) % 2 === 1;
}

/**
 * Establishes the session-bound MSP arming restriction, exactly once, for
 * one lease.
 *
 * Sequence, and nothing else:
 *   0. admission checks (zero requests if any fails)
 *   1. send MSP_SET_ARMING_DISABLED [1] through lease.request()
 *   2. treat the ACK as acknowledgement ONLY
 *   3. revalidate lease + BOTH identity scalars
 *   4. acquire a FRESH MSP_STATUS_EX through the same lease - never a
 *      cached result and never a Pass 1D observation captured before the
 *      ACK
 *   5. revalidate lease + BOTH identity scalars again
 *   6. require NOT armed
 *   7. require the aggregate ARMING_DISABLED_MSP bit
 *   8. only then mint a receipt
 *
 * Never throws for an expected state. No retry, no poll, no delay, no
 * timer, no queued second attempt, no automatic continuation, no
 * automatic lease reacquisition, no automatic session reset.
 */
export async function establishMotorArmingRestriction(
  options: EstablishMotorArmingRestrictionOptions,
): Promise<MotorArmingRestrictionEstablishment> {
  const {lease, requestedIdentity, readCurrentIdentity, boxIds} = options;

  // --- (0) Admission. No transport traffic on any failure here. -----
  if (lease === undefined) {
    return notEstablished('MOTOR_TEST_LEASE_INACTIVE');
  }
  const priorOutcome = LEASE_OUTCOMES.get(lease);
  if (priorOutcome?.kind === 'FAULTED') {
    return notEstablished('ARMING_RESTRICTION_FAULT_LATCHED');
  }
  if (priorOutcome?.kind === 'ESTABLISHED') {
    return notEstablished('ARMING_RESTRICTION_ALREADY_ESTABLISHED');
  }
  if (IN_PROGRESS.has(lease)) {
    return notEstablished('ARMING_RESTRICTION_ALREADY_ESTABLISHING');
  }
  const currentIdentity = readCurrentIdentity();
  if (currentIdentity === undefined) {
    return notEstablished('CURRENT_SESSION_IDENTITY_UNAVAILABLE');
  }
  // BOTH scalars, by value - never by object reference.
  if (!mspSessionCompositeIdentitiesMatch(currentIdentity, requestedIdentity)) {
    return notEstablished('REQUESTED_SESSION_IDENTITY_MISMATCH');
  }
  if (!mspSessionCompositeIdentitiesMatch(lease.sessionIdentity, requestedIdentity)) {
    return notEstablished('MOTOR_TEST_LEASE_IDENTITY_MISMATCH');
  }
  if (!lease.isActive()) {
    return notEstablished('MOTOR_TEST_LEASE_INACTIVE');
  }
  // Without the box mapping the ARM bit position is unknown, so no
  // independent verification is possible at all. Refuse before spending
  // a request rather than after.
  if (boxIds === undefined || boxIds.kind !== 'READY' || boxIds.permanentIds.length === 0) {
    return notEstablished('INDEPENDENT_VERIFICATION_UNAVAILABLE');
  }

  IN_PROGRESS.add(lease);
  try {
    // --- (1) The arming-disable request, through the lease only. ----
    try {
      await lease.request(MSP_SET_ARMING_DISABLED, buildArmingDisablePayload(), REQUEST_OPTIONS);
    } catch {
      // A rejected lease-scoped request has ALREADY faulted the lease via
      // Pass 2's own automatic route; record it here so a retry through
      // this module is refused with the accurate reason.
      LEASE_OUTCOMES.set(lease, Object.freeze({kind: 'FAULTED'} as const));
      return notEstablished('ARMING_DISABLE_REQUEST_FAILED');
    }

    // --- (2)(3) ACK is only ACK. Revalidate before going further. ---
    if (!mspSessionCompositeIdentitiesMatch(readCurrentIdentity(), requestedIdentity)) {
      return failClosed(lease, 'SESSION_CHANGED_DURING_ESTABLISHMENT');
    }
    if (!lease.isActive()) {
      return notEstablished('MOTOR_TEST_LEASE_INACTIVE');
    }

    // --- (4) A FRESH status read. Never cached, never pre-ACK. ------
    let statusPayload: Uint8Array;
    try {
      const frame = await lease.request(MSP_STATUS_EX, EMPTY_PAYLOAD, REQUEST_OPTIONS);
      statusPayload = frame.payload;
    } catch {
      LEASE_OUTCOMES.set(lease, Object.freeze({kind: 'FAULTED'} as const));
      return notEstablished('POST_ACK_STATUS_REQUEST_FAILED');
    }

    // --- (5) Revalidate again, after the second await. --------------
    if (!mspSessionCompositeIdentitiesMatch(readCurrentIdentity(), requestedIdentity)) {
      return failClosed(lease, 'SESSION_CHANGED_DURING_ESTABLISHMENT');
    }
    if (!lease.isActive()) {
      return notEstablished('MOTOR_TEST_LEASE_INACTIVE');
    }

    let status;
    try {
      status = decodeStatusExDiagnostics(statusPayload);
    } catch {
      return failClosed(lease, 'MALFORMED_STATUS_RESPONSE');
    }
    const readiness = status.readiness;
    if (readiness.malformedTail === true) {
      // A partially present tail: nothing after the fixed prefix can be
      // trusted, and it is never normalized into "no restriction".
      return failClosed(lease, 'MALFORMED_STATUS_RESPONSE');
    }

    // --- (6) Not armed. Read from the canonical decoded armed state,
    // never inferred from the arming-disable mask. ------------------
    const armedState = deriveArmedState(
      status.flightModeFlagsLow32,
      readiness.extraFlightModeFlagBytes,
      boxIds.permanentIds,
    );
    if (armedState === 'UNKNOWN') {
      return failClosed(lease, 'INDEPENDENT_VERIFICATION_UNAVAILABLE');
    }
    if (armedState === 'ARMED') {
      return failClosed(lease, 'FC_ARMED');
    }

    // --- (7) The aggregate restriction bit. -------------------------
    const mask = readiness.armingDisableFlags;
    if (mask === undefined) {
      // A missing mask is NEVER an empty mask.
      return failClosed(lease, 'INDEPENDENT_VERIFICATION_UNAVAILABLE');
    }
    if (!isBitSet(mask, ARMING_DISABLED_MSP_BIT_INDEX)) {
      return failClosed(lease, 'MSP_ARMING_RESTRICTION_NOT_OBSERVED');
    }

    // --- (8) Only now. -----------------------------------------------
    const receipt = new MotorArmingRestrictionReceipt(currentIdentity);
    RECEIPT_LEASES.set(receipt, lease);
    RECEIPT_TOKENS.set(receipt, {});
    LEASE_OUTCOMES.set(lease, Object.freeze({kind: 'ESTABLISHED', receipt} as const));
    return Object.freeze({kind: 'ESTABLISHED', receipt} as const);
  } finally {
    IN_PROGRESS.delete(lease);
  }
}
