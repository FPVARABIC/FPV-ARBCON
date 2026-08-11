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
 * RELEASE, ADDED IN P2-i. This module previously refused to encode the
 * inverse payload at all, on the grounds that teardown - which must also
 * have confirmed motor stop and lifecycle safety - belonged to a later
 * pass. That pass is now here, and leaving a flight controller
 * arming-disabled after a CLEAN motor-control session is itself a defect:
 * the operator disconnects, and the aircraft silently refuses to arm with
 * no indication why. The release payload is therefore encoded below, and
 * it is encoded ONLY as a builder - this module still issues nothing on
 * its own, and the driver must not call it until an all-stop has been
 * established. See `buildArmingReleasePayload`.
 *
 * WHY RELEASING IS SAFE FOR OTHER LINKS, traced at
 * 79065c96ba0bb5cdc675e67d7093e05dab8b330e (msp.c):
 *
 *     static void mspArmingDisableByDescriptor(mspDescriptor_t desc)
 *     { mspArmingDisableFlags |=  (1 << desc); }
 *     static void mspArmingEnableByDescriptor(mspDescriptor_t desc)
 *     { mspArmingDisableFlags &= ~(1 << desc); }
 *     static bool mspIsMspArmingEnabled(void)
 *     { return mspArmingDisableFlags == 0; }
 *
 * and in the handler's `command == 0` arm:
 *
 *     mspArmingEnableByDescriptor(srcDesc);
 *     if (mspIsMspArmingEnabled()) { unsetArmingDisabled(ARMING_DISABLED_MSP); }
 *
 * The release is therefore PER DESCRIPTOR: it clears only this link's bit,
 * and the global ARMING_DISABLED_MSP clears only once EVERY descriptor has
 * released. A release issued by this application cannot cancel a
 * restriction another MSP link is holding.
 *
 * POLARITY IS INVERTED FROM THE COMMAND NAME, which is exactly why it is
 * spelled out here rather than inferred: MSP_SET_ARMING_DISABLED with
 * `command == 1` DISABLES arming (establishes the restriction) and
 * `command == 0` ENABLES arming (releases it). The official Configurator's
 * own helper is named `setArmingEnabled(false)` for the establish case.
 *
 * WHAT WAS ACTUALLY TRACED about persistence, and nothing beyond it:
 *   - an explicit `command == 0` from a descriptor clears that
 *     descriptor's bit, and the global ARMING_DISABLED_MSP clears only
 *     once every descriptor has cleared (msp.c:236-243);
 *   - the release/reset paths that were inspected -
 *     `mspSerialReleasePortIfAllocated` (msp_serial.c:93-101) and
 *     `resetMspPort` (msp_serial.c:47-54) - do not themselves touch
 *     `mspArmingDisableFlags`, whose only three touch points are
 *     msp.c:232/238/243, and descriptors are allocated monotonically and
 *     never reused.
 * Whether the restriction therefore survives every real USB VCP detach
 * until the FC reboots was NOT proven: the full USB detach lifecycle was
 * not traced. Treat that as a CONDITIONAL INFERENCE, not a fact.
 * Independently of it, releasing a JavaScript receipt clears nothing on
 * the FC.
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
 *
 *     WHAT THE FIRMWARE REQUIRES vs WHAT THIS CODE SENDS - two different
 *     statements, never to be conflated:
 *       - the handler requires byte 0 to be present, MAY additionally
 *         read byte 1, and applies NO explicit length validation, so
 *         trailing bytes are simply ignored rather than rejected. There
 *         is no error path for an over-long payload. (`sbufReadU8` is
 *         `return *src->ptr++`, streambuf.c:98-101 - unbounded, so a
 *         zero-length payload would read out of bounds.)
 *       - THIS IMPLEMENTATION intentionally emits exactly `[1]`, the
 *         minimal sufficient disable payload. That is a choice made
 *         here, not a constraint the protocol enforces.
 *     Single bytes, so byte order does not apply.
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
  type MspOfficialSessionAuthority,
  type MspSessionCompositeIdentity,
  type MspSessionIdentityProvider,
} from '../protocol/motorTestLease';
import {MSP_STATUS_EX} from '../protocol/msp/commands/mspCommands';
import {decodeStatusExDiagnostics} from '../protocol/msp/decoding/decodeStatusExDiagnostics';
import {motorTestBoxIdsAuthorityOf, MotorTestBoxIdsSnapshot} from './motorTestBoxIds';
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

/**
 * Re-exported from the canonical command table rather than re-declared:
 * MSP_STATUS_EX is an ordinary read that the rest of the project already
 * owns, so a second local `= 150` would have been a drift risk for no
 * safety benefit. Command 99 stays local (above) because it is a WRITE
 * and must not join the general-purpose command surface.
 */
export {MSP_STATUS_EX};

/** The single mandatory payload byte, non-zero = disable arming. */
export const ARMING_DISABLE_COMMAND_BYTE = 1;

/**
 * The inverse command byte: zero = ENABLE arming, i.e. release this
 * descriptor's hold on ARMING_DISABLED_MSP.
 *
 * msp.c @ 79065c96, `case MSP_SET_ARMING_DISABLED`, the `else` arm:
 *
 *     mspArmingEnableByDescriptor(srcDesc);
 *     if (mspIsMspArmingEnabled()) { unsetArmingDisabled(ARMING_DISABLED_MSP); ... }
 *
 * Note the second, OPTIONAL payload byte on this path
 * (`disableRunawayTakeoff`) is read only when bytes remain. This module
 * emits the one-byte form, so runaway-takeoff handling is left exactly as
 * the firmware's own default for a one-byte request - it is not a setting
 * this application has any basis to change.
 */
export const ARMING_ENABLE_COMMAND_BYTE = 0;

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
 */
export function buildArmingDisablePayload(): Uint8Array {
  return Uint8Array.from([ARMING_DISABLE_COMMAND_BYTE]);
}

/**
 * Builds the one-byte arming-RELEASE payload (P2-i).
 *
 * ORDERING IS THE CALLER'S OBLIGATION, and it is not negotiable: this
 * payload must not be sent until an all-stop has been established for the
 * session. Releasing the restriction first would re-permit arming while an
 * output could still be commanded, which inverts the entire point of
 * establishing it.
 *
 * BUILDING BYTES IS INERT. This function has no transport and no caller
 * authority; producing the payload is not sending it, and sending it is
 * not a claim about any physical state.
 */
export function buildArmingReleasePayload(): Uint8Array {
  return Uint8Array.from([ARMING_ENABLE_COMMAND_BYTE]);
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
  | 'MALFORMED_STATUS_RESPONSE'
  /** The supplied Box IDs evidence was not minted by the trusted
   * lease-based acquisition, or belongs to a different official session
   * (stale, cross-session or cross-client). */
  | 'BOX_IDS_PROVENANCE_INVALID'
  /** The caller's identity provider THREW. Distinct from "no identity"
   * and from "identity mismatch": neither of those would be truthful,
   * and mislabelling a broken provider as an observed mismatch would
   * hide a real defect. */
  | 'SESSION_IDENTITY_PROVIDER_FAILED';

/**
 * How strong the post-ACK evidence actually is. There is exactly one
 * possible value at API 1.47, and it says the honest thing.
 */
export type MotorArmingRestrictionEvidenceScope = 'AGGREGATE_NOT_DESCRIPTOR_SPECIFIC';

/**
 * Module-private provenance for receipts. The vestigial RECEIPT_TOKENS
 * map was REMOVED in the Pass 3 correction: it stored an empty object
 * that nothing ever checked, so it provided no authenticity while
 * appearing to. The real anti-forgery mechanism is unchanged and is
 * strict instance identity - a receipt is current only if the session's
 * recorded outcome holds THIS exact object - which a spread copy, a JSON
 * revival or a hand-built instance can never satisfy.
 */
const RECEIPT_LEASES = new WeakMap<MotorArmingRestrictionReceipt, MotorTestLease>();

/**
 * Establishment bookkeeping, keyed by the OFFICIAL SESSION AUTHORITY -
 * not by the lease object, not by a caller-supplied identity object, and
 * not by caller-supplied scalars.
 *
 * This is Pass 3 correction A. Keying on the lease was wrong: a lease is
 * released and reacquired freely inside one session, so lease-object
 * keying let command 99 be sent a second time for the same official
 * session and issued a second receipt. Keying on the authority means the
 * record deliberately OUTLIVES an ordinary release, and ends only at a
 * genuine session boundary - a desync (epoch rotation) or a new client -
 * because that is exactly when a new authority is minted.
 *
 * Weak on the authority object, which is itself weakly held per client,
 * so nothing leaks across unrelated clients.
 */
const IN_PROGRESS = new WeakSet<MspOfficialSessionAuthority>();
type SessionOutcome =
  | {readonly kind: 'ESTABLISHED'; readonly receipt: MotorArmingRestrictionReceipt}
  | {readonly kind: 'FAULTED'};
const SESSION_OUTCOMES = new WeakMap<MspOfficialSessionAuthority, SessionOutcome>();

/**
 * Leases this module has failed closed.
 *
 * Purely for REASON FIDELITY, never for success tracking: faulting kills
 * the lease, so a retry with that same dead capability can no longer
 * reach its session authority, and the honest-but-vague
 * MOTOR_TEST_LEASE_INACTIVE would hide the fact that THIS module already
 * failed it closed. Success remains session-keyed (above) - this set is
 * only ever consulted to choose a truthful reason.
 */
const FAULTED_LEASES = new WeakSet<MotorTestLease>();

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
    // Never throws. Every lookup below is a plain map read or a pure
    // predicate on this module's own state; nothing here calls a
    // caller-supplied provider, so a broken provider cannot make a
    // currency check explode.
    const lease = RECEIPT_LEASES.get(this);
    if (lease === undefined || !lease.isActive()) {
      return false;
    }
    const authority = lease.officialSessionAuthority();
    if (authority === undefined) {
      return false;
    }
    const outcome = SESSION_OUTCOMES.get(authority);
    // Strict instance identity - the actual anti-forgery check.
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
   * TRUSTED, session-bound Box IDs evidence from acquireMotorTestBoxIds()
   * - never a bare `BoxIdsResult`. Its provenance is verified against
   * this lease's official session authority before command 99 is sent,
   * so a stale, cross-session, cross-client, spread, JSON-revived or
   * hand-built mapping is rejected with zero traffic.
   *
   * Acquired as its own operation BEFORE establishment, which is what
   * keeps this function's request contract at exactly 99 then 150.
   */
  readonly boxIds: MotorTestBoxIdsSnapshot | undefined;
}

function notEstablished(
  reason: MotorArmingRestrictionFailureReason,
): MotorArmingRestrictionEstablishment {
  return Object.freeze({kind: 'NOT_ESTABLISHED', reason} as const);
}

/**
 * THE canonical post-submission fail-closed boundary for one official
 * session. Every route that fails after command 99 may have reached the
 * wire goes through exactly this function - there is deliberately only
 * one.
 *
 * Order matters. The SESSION-wide record is written FIRST, because that
 * is what a later lease on the same client and client-owned epoch
 * consults at admission, before any `lease.request`, before MSP queue
 * admission and before any transport write. The per-capability set is
 * only reason fidelity. `lease.failClosed()` last: it is Pass 2's own
 * canonical latch (no second fault manager is introduced here) and it is
 * idempotent, returning false for a capability that is already dead -
 * which is exactly the case when the lease was released or invalidated
 * underneath an in-flight establishment. That `false` must never be read
 * as "nothing was faulted": the session record above is the guarantee,
 * and it survives the lease it was raised on.
 */
function latchSessionFault(
  authority: MspOfficialSessionAuthority,
  lease: MotorTestLease,
): void {
  SESSION_OUTCOMES.set(authority, Object.freeze({kind: 'FAULTED'} as const));
  FAULTED_LEASES.add(lease);
  lease.failClosed();
}

/**
 * Fails the whole attempt closed: the official session is latched, the
 * lease is faulted through the SAME canonical Pass 2 latch (no second
 * fault manager), and every receipt from that lease stops being current.
 */
function failClosed(
  authority: MspOfficialSessionAuthority,
  lease: MotorTestLease,
  reason: MotorArmingRestrictionFailureReason,
): MotorArmingRestrictionEstablishment {
  latchSessionFault(authority, lease);
  return notEstablished(reason);
}

/**
 * Reads the caller's identity provider without ever letting it reject
 * this operation in an untyped way. A provider that THROWS is a broken
 * caller contract, not an expected state, but it must still surface as a
 * typed result - so it is reported distinctly rather than being
 * mislabelled as "unavailable" or "mismatched".
 */
function readIdentitySafely(
  read: MspSessionIdentityProvider,
): {ok: true; identity: MspSessionCompositeIdentity | undefined} | {ok: false} {
  try {
    return {ok: true, identity: read()};
  } catch {
    return {ok: false};
  }
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
 * THE POST-SUBMISSION RULE (Pass 3 follow-up correction). Step 0 may
 * fail freely: it provably precedes all traffic, so it records nothing
 * and leaves the session establishable. From step 1 onward the opposite
 * holds absolutely - once lease.request() has been CALLED, whether or
 * not the frame reached the transport, EVERY exit leaves the official
 * session fail-closed. That covers a rejected request, a changed
 * identity, a throwing identity provider, unacceptable evidence, a lease
 * that died underneath the attempt, and any unexpected exception. The
 * latch is keyed on the official session, so it outlives the lease that
 * raised it: releasing that lease and acquiring another on the same
 * client and client-owned epoch cannot retry, and command 99 is
 * therefore submitted at most once per official session. A genuinely new
 * session - a new client, or a valid internal epoch rotation - mints a
 * different authority and inherits nothing.
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
  // Checked BEFORE the authority lookup: a lease this module already
  // failed closed is dead, so its authority is no longer reachable, and
  // reporting a bare "inactive" would lose the reason it died.
  if (FAULTED_LEASES.has(lease)) {
    return notEstablished('ARMING_RESTRICTION_FAULT_LATCHED');
  }
  // The official session anchor. undefined means this capability is not
  // the live owner, so there is no session to bind anything to.
  const authority = lease.officialSessionAuthority();
  if (authority === undefined) {
    return notEstablished('MOTOR_TEST_LEASE_INACTIVE');
  }
  // Correction A: these three checks are keyed on the SESSION, so they
  // survive an ordinary release-and-reacquire and are not defeated by a
  // fresh lease object or a re-created identity object.
  const priorOutcome = SESSION_OUTCOMES.get(authority);
  if (priorOutcome?.kind === 'FAULTED') {
    return notEstablished('ARMING_RESTRICTION_FAULT_LATCHED');
  }
  if (priorOutcome?.kind === 'ESTABLISHED') {
    return notEstablished('ARMING_RESTRICTION_ALREADY_ESTABLISHED');
  }
  if (IN_PROGRESS.has(authority)) {
    return notEstablished('ARMING_RESTRICTION_ALREADY_ESTABLISHING');
  }
  const initialRead = readIdentitySafely(readCurrentIdentity);
  if (!initialRead.ok) {
    return notEstablished('SESSION_IDENTITY_PROVIDER_FAILED');
  }
  const currentIdentity = initialRead.identity;
  if (currentIdentity === undefined) {
    return notEstablished('CURRENT_SESSION_IDENTITY_UNAVAILABLE');
  }
  // BOTH scalars, by value - never by object reference. Note these
  // scalars are a coherence check, NOT the authority: the authority is
  // the anchor object above, which no caller can mint.
  if (!mspSessionCompositeIdentitiesMatch(currentIdentity, requestedIdentity)) {
    return notEstablished('REQUESTED_SESSION_IDENTITY_MISMATCH');
  }
  if (!mspSessionCompositeIdentitiesMatch(lease.sessionIdentity, requestedIdentity)) {
    return notEstablished('MOTOR_TEST_LEASE_IDENTITY_MISMATCH');
  }
  if (!lease.isActive()) {
    return notEstablished('MOTOR_TEST_LEASE_INACTIVE');
  }
  // Correction B: Box IDs must be TRUSTED evidence minted by this
  // session's own lease-based acquisition. Provenance is registry
  // membership, so a spread copy, JSON revival, hand-built object or
  // cross-session snapshot all fail here - before any traffic.
  if (boxIds === undefined) {
    return notEstablished('INDEPENDENT_VERIFICATION_UNAVAILABLE');
  }
  if (motorTestBoxIdsAuthorityOf(boxIds) !== authority) {
    return notEstablished('BOX_IDS_PROVENANCE_INVALID');
  }
  if (boxIds.permanentIds.length === 0) {
    return notEstablished('INDEPENDENT_VERIFICATION_UNAVAILABLE');
  }

  IN_PROGRESS.add(authority);
  // Pass 3 follow-up correction - THE POST-SUBMISSION BOUNDARY.
  //
  // Set BEFORE lease.request() is called, never after it resolves. Once
  // the call has been made this module can no longer prove whether the
  // frame reached the transport, so the conservative reading is the only
  // safe one: treat the request as submitted from that instant. From
  // here every exit must leave the official session latched unless it
  // recorded a terminal outcome of its own - enforced unconditionally by
  // the finally block below.
  let submitted = false;
  try {
    // --- (1) The arming-disable request, through the lease only. ----
    try {
      submitted = true;
      await lease.request(MSP_SET_ARMING_DISABLED, buildArmingDisablePayload(), REQUEST_OPTIONS);
    } catch {
      // A rejected lease-scoped request has ALREADY faulted the lease via
      // Pass 2's own automatic route; latch the SESSION too so a retry
      // from any later lease is refused with the accurate reason.
      latchSessionFault(authority, lease);
      return notEstablished('ARMING_DISABLE_REQUEST_FAILED');
    }

    // --- (2)(3) ACK is only ACK. Revalidate before going further. ---
    const afterAck = readIdentitySafely(readCurrentIdentity);
    if (!afterAck.ok) {
      // Command 99 is already out. A provider that throws now leaves the
      // session ambiguous, so fail closed through the canonical latch.
      return failClosed(authority, lease, 'SESSION_IDENTITY_PROVIDER_FAILED');
    }
    if (!mspSessionCompositeIdentitiesMatch(afterAck.identity, requestedIdentity)) {
      return failClosed(authority, lease, 'SESSION_CHANGED_DURING_ESTABLISHMENT');
    }
    // Command 99 is already out. A lease that died underneath this
    // attempt - released, invalidated or faulted - leaves the session
    // ambiguous in exactly the same way a rejected request does, so it
    // takes the SAME canonical boundary rather than merely reporting
    // itself. The typed reason is unchanged.
    if (!lease.isActive()) {
      return failClosed(authority, lease, 'MOTOR_TEST_LEASE_INACTIVE');
    }

    // --- (4) A FRESH status read. Never cached, never pre-ACK. ------
    let statusPayload: Uint8Array;
    try {
      const frame = await lease.request(MSP_STATUS_EX, EMPTY_PAYLOAD, REQUEST_OPTIONS);
      statusPayload = frame.payload;
    } catch {
      latchSessionFault(authority, lease);
      return notEstablished('POST_ACK_STATUS_REQUEST_FAILED');
    }

    // --- (5) Revalidate again, after the second await. --------------
    const afterStatus = readIdentitySafely(readCurrentIdentity);
    if (!afterStatus.ok) {
      return failClosed(authority, lease, 'SESSION_IDENTITY_PROVIDER_FAILED');
    }
    if (!mspSessionCompositeIdentitiesMatch(afterStatus.identity, requestedIdentity)) {
      return failClosed(authority, lease, 'SESSION_CHANGED_DURING_ESTABLISHMENT');
    }
    // Same reasoning as after the ACK: both requests are already out.
    if (!lease.isActive()) {
      return failClosed(authority, lease, 'MOTOR_TEST_LEASE_INACTIVE');
    }
    // The session must not have rotated underneath the evidence either.
    if (lease.officialSessionAuthority() !== authority) {
      return failClosed(authority, lease, 'SESSION_CHANGED_DURING_ESTABLISHMENT');
    }

    let status;
    try {
      status = decodeStatusExDiagnostics(statusPayload);
    } catch {
      return failClosed(authority, lease, 'MALFORMED_STATUS_RESPONSE');
    }
    const readiness = status.readiness;
    if (readiness.malformedTail === true) {
      // A partially present tail: nothing after the fixed prefix can be
      // trusted, and it is never normalized into "no restriction".
      return failClosed(authority, lease, 'MALFORMED_STATUS_RESPONSE');
    }

    // --- (6) Not armed. Read from the canonical decoded armed state,
    // never inferred from the arming-disable mask. ------------------
    const armedState = deriveArmedState(
      status.flightModeFlagsLow32,
      readiness.extraFlightModeFlagBytes,
      boxIds.permanentIds,
    );
    if (armedState === 'UNKNOWN') {
      return failClosed(authority, lease, 'INDEPENDENT_VERIFICATION_UNAVAILABLE');
    }
    if (armedState === 'ARMED') {
      return failClosed(authority, lease, 'FC_ARMED');
    }

    // --- (7) The aggregate restriction bit. -------------------------
    const mask = readiness.armingDisableFlags;
    if (mask === undefined) {
      // A missing mask is NEVER an empty mask.
      return failClosed(authority, lease, 'INDEPENDENT_VERIFICATION_UNAVAILABLE');
    }
    if (!isBitSet(mask, ARMING_DISABLED_MSP_BIT_INDEX)) {
      return failClosed(authority, lease, 'MSP_ARMING_RESTRICTION_NOT_OBSERVED');
    }

    // --- (8) Only now. -----------------------------------------------
    const receipt = new MotorArmingRestrictionReceipt(currentIdentity);
    RECEIPT_LEASES.set(receipt, lease);
    SESSION_OUTCOMES.set(authority, Object.freeze({kind: 'ESTABLISHED', receipt} as const));
    return Object.freeze({kind: 'ESTABLISHED', receipt} as const);
  } finally {
    // Clearing the in-progress marker must NEVER be the thing that
    // re-opens a retry, so the session-wide backstop runs in the same
    // block, immediately after it.
    IN_PROGRESS.delete(authority);
    // Pass 3 follow-up correction. Any post-submission exit that did not
    // record a terminal outcome of its own - a lease that died
    // underneath the attempt, a future branch added here, or a genuinely
    // unexpected exception propagating out of this function - fails the
    // official session closed. Expected states still never throw and
    // still return their own typed reason; this only guarantees that
    // whatever the exit was, the session cannot be establishable again.
    //
    // An ESTABLISHED or FAULTED record already present is left exactly as
    // it is: success is not overwritten, and a fault is not re-raised.
    if (submitted && SESSION_OUTCOMES.get(authority) === undefined) {
      latchSessionFault(authority, lease);
    }
  }
}
