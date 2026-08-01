/**
 * Pass 2 - the exclusive, session-bound MOTOR TEST LEASE capability.
 *
 * WHAT A LEASE IS
 * ---------------
 * A reservation of MSP REQUEST OWNERSHIP over one idle MspClient. While
 * it is held, ordinary external requests cannot enter that client's FIFO,
 * and only the exact live capability can submit lease-scoped requests.
 *
 * WHAT A LEASE IS NOT - AND CAN NEVER BECOME
 * ------------------------------------------
 * Holding a lease is NOT a motor-safety decision. It does not mean
 * anything is ready, safe, authorized, approved, allowed or permitted; it
 * grants no permission to test, pulse or start a motor. It establishes no
 * arming restriction, encodes no motor command, builds no motor vector,
 * computes no pulse or idle value, and cannot send MSP_SET_MOTOR. There
 * is deliberately no `safe`, `ready`, `authorized`, `approved`,
 * `allowed`, `permission`, `canTest`, `canPulse` or `canStart` field
 * anywhere on the public surface, and a test asserts their absence.
 *
 * A later controller, a real arming interlock and a native fail-safe stop
 * path all remain unwritten. None of them is implied by this pass.
 *
 * PHASE 2G PRECISION. `emergencyStop()` below adds SUBMISSION PRIORITY to
 * this capability - and nothing else. It is a generic channel exactly like
 * `request()`: the caller supplies the command and payload, this module
 * chooses none, encodes none, and builds no motor vector, pulse or idle
 * value. Priority means "next transport write", never "preempts bytes
 * already on the wire", never "bounded latency behind an in-flight write",
 * and never "a motor physically stopped". The absent-field test above
 * still holds: no `safe`, `ready`, `authorized`, `approved`, `allowed`,
 * `permission`, `canTest`, `canPulse` or `canStart` field exists here.
 *
 * WHERE OWNERSHIP ACTUALLY LIVES
 * ------------------------------
 * Not here. The lease state belongs to MspClient - the single class that
 * owns request admission - and this module is only a typed capability
 * wrapper over it. That is what makes exclusivity real rather than
 * decorative: two wrappers constructed over the same MspClient cannot
 * both acquire, because neither of them holds the state.
 *
 * ANTI-FORGERY
 * ------------
 * The ownership token is generated and retained by MspClient. It is never
 * a caller-supplied string, number, UUID, timestamp or persisted value.
 * This module keeps it in a module-private WeakMap keyed by the
 * capability instance, so the token is not an own property: spreading,
 * `JSON.stringify`, or rebuilding an object from public fields yields
 * something with no token AND no methods (they live on the prototype),
 * and the client would reject it at admission time regardless. The raw
 * transport and `writeBytes` are never exposed.
 *
 * NO TIMERS, NO EXPIRY, NO BACKGROUND WORK. Acquisition is a synchronous
 * try-once. There is no retry, no polling, no TTL, no automatic expiry
 * and no reacquisition.
 *
 * NO RUNTIME CALLER EXISTS. Nothing in the application acquires a lease
 * in this pass; telemetry polling is untouched and is not paused here.
 *
 * REQUIRED FUTURE RUNTIME SEQUENCE (not implemented, documented so no
 * later pass invents a shorter one):
 *   1. pause every relevant telemetry owner;
 *   2. allow or verify settlement of all existing MSP work;
 *   3. try to acquire this exclusive lease;
 *   4. fail closed if the client is not idle;
 *   5. establish AND independently verify the MSP arming restriction, in
 *      a later pass;
 *   6. reacquire the Pass 1D dynamic observation while holding the lease;
 *   7. reevaluate Pass 1E against the same current composite identity;
 *   8. only then may a later controller and a native safety gate even
 *      consider a motor command.
 * The admission gate below still rejects any polling request that slips
 * through after acquisition - but that is a backstop, not step 1.
 */

import {MspClient} from './mspClient';
import type {MspMotorTestLeaseToken, MspMotorTestLeaseRejectionReason} from './mspClient';
import type {MspFrame} from './mspTypes';
import type {MspEmergencyStopDispatch, MspRequestOptions} from './mspClient';

/**
 * The composite session identity a lease is bound to.
 *
 * Declared HERE rather than imported from src/core/state: `state` imports
 * `protocol`, never the reverse, and this module must not invert that.
 * The shape is structurally identical to the state layer's own identity
 * type, so a caller can pass either without a conversion.
 */
export interface MspSessionCompositeIdentity {
  readonly physicalGeneration: number;
  readonly mspEpoch: number;
}

/** Pure scalar comparison of BOTH components. Never a reference check -
 * two independently allocated but value-equal identities must match. */
export function mspSessionCompositeIdentitiesMatch(
  left: MspSessionCompositeIdentity | undefined,
  right: MspSessionCompositeIdentity | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return false;
  }
  return left.physicalGeneration === right.physicalGeneration && left.mspEpoch === right.mspEpoch;
}

export type MotorTestLeaseAcquireFailureReason =
  /** The identity provider had no current session at all. */
  | 'CURRENT_SESSION_IDENTITY_UNAVAILABLE'
  /** The requested identity is not the current one, or the client's own
   * epoch disagrees with the requested identity. */
  | 'REQUESTED_SESSION_IDENTITY_MISMATCH'
  /** No canonical MspClient was supplied. */
  | 'MSP_CLIENT_UNAVAILABLE'
  /** The request engine is not truly idle. */
  | 'MSP_CLIENT_NOT_IDLE'
  /** Another holder already owns this client. */
  | 'MOTOR_TEST_LEASE_ALREADY_HELD'
  /** A previous lease on this identity died from an MSP/client fault. */
  | 'MOTOR_TEST_LEASE_FAULT_LATCHED';

export type MotorTestLeaseAcquisition =
  | {readonly kind: 'ACQUIRED'; readonly lease: MotorTestLease}
  | {readonly kind: 'NOT_ACQUIRED'; readonly reason: MotorTestLeaseAcquireFailureReason};

export type MotorTestLeaseReleaseResult =
  | 'RELEASED'
  | 'ALREADY_RELEASED'
  | 'INVALIDATED'
  | 'NOT_OWNER'
  | 'LEASE_WORK_UNSETTLED';

/** Supplies the identity currently in force, so this module never reaches
 * into the platform session layer itself. Returns undefined when there is
 * no current session. */
export type MspSessionIdentityProvider = () => MspSessionCompositeIdentity | undefined;

export interface AcquireMotorTestLeaseOptions {
  readonly client: MspClient | undefined;
  /** The identity the prospective owner believes it is operating under. */
  readonly requestedIdentity: MspSessionCompositeIdentity;
  readonly readCurrentIdentity: MspSessionIdentityProvider;
}

/** Token storage, keyed by capability instance. Module-private and
 * weak, so the token is never an own property of the capability and
 * never survives serialization. */
const LEASE_TOKENS = new WeakMap<MotorTestLease, MspMotorTestLeaseToken>();
/** The client each capability belongs to - equally private, so a
 * capability can never be pointed at a different client. */
const LEASE_CLIENTS = new WeakMap<MotorTestLease, MspClient>();

/**
 * Pass 3 correction - the canonical, NON-FORGEABLE anchor for one
 * OFFICIAL MSP session.
 *
 * WHY THIS EXISTS. Callers supply `physicalGeneration` and `mspEpoch` as
 * plain numbers, and plain numbers are not authority: any caller can
 * invent a pair, or reuse an old one. Anything that must be true "once
 * per real session" therefore cannot be keyed on those scalars, and it
 * cannot be keyed on a lease object either, because a lease is released
 * and replaced many times within one session.
 *
 * WHAT IT IS ANCHORED TO. A fresh object identity minted per
 * `(MspClient instance, that client's own mspEpoch)`:
 *   - the MspClient instance is created by the session coordinator for a
 *     genuinely new physical session and disposed when it is replaced,
 *     closed or detached - a caller cannot fabricate one that this
 *     module has already registered;
 *   - `mspEpoch` is the client's OWN counter, readable but not writable
 *     from outside, and rotated only by triggerDesyncLatch() - which
 *     also faults any live lease.
 * So the authority changes exactly when the official session changes,
 * and never because a caller says so.
 *
 * It is a bare branded object with no data and no methods: it carries no
 * client, transport, token or writer, and is useful only as a WeakMap
 * key. Handing it out therefore grants nothing.
 */
export class MspOfficialSessionAuthority {
  /** Present only so the type is nominal to TypeScript; never read. */
  private readonly brand: undefined;

  constructor() {
    this.brand = undefined;
  }
}

/** Minted authorities, per client, per epoch. Weak on the client so a
 * discarded session's authorities are collectable and nothing leaks
 * across unrelated clients. */
const SESSION_AUTHORITIES = new WeakMap<MspClient, Map<number, MspOfficialSessionAuthority>>();

/**
 * The authority for a client's CURRENT epoch, minted once and then
 * returned identically for as long as that official session lasts - so
 * two different leases in the same session observe the SAME authority,
 * while a desync or a new client yields a different one.
 */
function officialSessionAuthorityFor(client: MspClient): MspOfficialSessionAuthority {
  let byEpoch = SESSION_AUTHORITIES.get(client);
  if (byEpoch === undefined) {
    byEpoch = new Map<number, MspOfficialSessionAuthority>();
    SESSION_AUTHORITIES.set(client, byEpoch);
  }
  const epoch = client.getEpoch();
  let authority = byEpoch.get(epoch);
  if (authority === undefined) {
    authority = new MspOfficialSessionAuthority();
    byEpoch.set(epoch, authority);
  }
  return authority;
}

function copyIdentity(identity: MspSessionCompositeIdentity): MspSessionCompositeIdentity {
  // Explicit scalar copy, never a spread of the caller's object, so a
  // caller that keeps mutating its own session key cannot rewrite which
  // session this lease claims to belong to.
  return Object.freeze({
    physicalGeneration: identity.physicalGeneration,
    mspEpoch: identity.mspEpoch,
  });
}

/**
 * The opaque runtime capability handed to the winner of an acquisition.
 *
 * A class on purpose: its methods live on the prototype, so `{...lease}`
 * and `JSON.parse(JSON.stringify(lease))` both produce a plain object
 * with no `request` and no `release` at all - copying the public fields
 * cannot manufacture a working lease. Even if a method were somehow
 * reached, the token lives in a module-private WeakMap and the client
 * revalidates it on every single admission.
 */
export class MotorTestLease {
  /** Names what this is, and by omission what it is not. */
  readonly leaseKind = 'MOTOR_TEST_LEASE' as const;
  /** Frozen copy of the composite identity this lease is bound to. */
  readonly sessionIdentity: MspSessionCompositeIdentity;

  /** @internal Constructed only by acquireMotorTestLease(). */
  constructor(identity: MspSessionCompositeIdentity) {
    this.sessionIdentity = copyIdentity(identity);
    Object.freeze(this);
  }

  /** Whether this exact capability is still the live owner. False after
   * release, invalidation, close, detach, desync or any lease-scoped
   * failure. */
  isActive(): boolean {
    const client = LEASE_CLIENTS.get(this);
    const token = LEASE_TOKENS.get(this);
    if (client === undefined || token === undefined) {
      return false;
    }
    return client.isMotorTestLeaseToken(token);
  }

  /**
   * Submits a lease-scoped request through the EXISTING canonical FIFO
   * and transport path. No second queue, no parallel write path, no
   * priority, no cancellation, no preemption.
   *
   * The client revalidates the exact live token before admission, so a
   * released, invalidated, stale, forged or cross-session capability
   * fails closed before the queue, before the transport and before any
   * timer.
   *
   * This is a generic MSP request channel. It neither knows nor cares
   * what command it carries, and it confers no authority to choose a
   * motor or arming command - no such command is constructed anywhere in
   * this pass.
   */
  request(command: number, payload: Uint8Array, options: MspRequestOptions): Promise<MspFrame> {
    const client = LEASE_CLIENTS.get(this);
    const token = LEASE_TOKENS.get(this);
    if (client === undefined || token === undefined) {
      // A forged or reconstructed object: it never had a token.
      return Promise.reject(
        new Error('MotorTestLease: capability is not a genuine lease'),
      );
    }
    return client.requestWithMotorTestLease(token, command, payload, options);
  }

  /** A fixed optional request whose confirmed MSP error means unsupported,
   * not a broken link. Every ambiguous transport failure still kills the
   * lease. This is used for diagnostics reads and the fixed DShot command. */
  requestOptional(
    command: number,
    payload: Uint8Array,
    options: MspRequestOptions,
  ): Promise<MspFrame> {
    const client = LEASE_CLIENTS.get(this);
    const token = LEASE_TOKENS.get(this);
    if (client === undefined || token === undefined) {
      return Promise.reject(
        new Error('MotorTestLease: capability is not a genuine lease'),
      );
    }
    return client.requestOptionalWithMotorTestLease(
      token,
      command,
      payload,
      options,
    );
  }

  /**
   * Phase 2G Pass 1 - submit an EMERGENCY STOP as the client's next
   * transport write.
   *
   * THE ONLY ROUTE TO STOP PRIORITY. Priority is not a flag on `request()`
   * and is not reachable from any ordinary caller: the underlying client
   * admits it only against the exact live token, which lives in a
   * module-private WeakMap and is never an own property of this object. A
   * forged or reconstructed capability has no token and is refused before
   * the FIFO, before the transport and before any timer.
   *
   * THIS METHOD CHOOSES NO COMMAND. Exactly like `request()`, it is a
   * generic channel: the caller supplies the command and payload. Holding
   * a lease still authorizes no motor command, and nothing here builds a
   * motor vector, encodes a pulse, or decides that stopping is safe.
   *
   * WHAT THE CALLER MUST HONOUR (see MspEmergencyStopDispatch):
   *   - `attributionAmbiguous` means the stop's apparent acknowledgement
   *     is UNPROVEN. Every acknowledgement and confirmation flag must stay
   *     false and a full session reset is required.
   *   - `deferredBehindActiveWrite` means no latency bound may be claimed.
   *   - A resolved promise proves the command was received and processed.
   *     It never proves a motor physically stopped.
   *
   * A forged capability yields a dispatch whose promise is already
   * rejected - never a thrown exception, and never a silent no-op that a
   * caller could mistake for a sent stop.
   */
  emergencyStop(
    command: number,
    payload: Uint8Array,
    options: MspRequestOptions,
  ): MspEmergencyStopDispatch {
    const client = LEASE_CLIENTS.get(this);
    const token = LEASE_TOKENS.get(this);
    if (client === undefined || token === undefined) {
      const frame = Promise.reject<MspFrame>(
        new Error('MotorTestLease: capability is not a genuine lease'),
      );
      frame.catch(() => {
        // See MspClient.failedStopDispatch() - the rejection still reaches
        // every real consumer; this only suppresses the unhandled warning.
      });
      return Object.freeze({
        frame,
        attributionAmbiguous: false,
        deferredBehindActiveWrite: false,
        joinedExistingStop: false,
      });
    }
    return client.emergencyStopWithMotorTestLease(token, command, payload, options);
  }

  /**
   * Explicit, idempotent release restricted to this exact capability.
   *
   * Refuses while lease-owned work is still active, queued or awaiting
   * write settlement: the lease stays held, the in-flight request is
   * neither cancelled nor discarded, and ordinary traffic stays blocked.
   *
   * A capability retired by an earlier release can never clear a lease
   * acquired afterwards.
   */
  release(): MotorTestLeaseReleaseResult {
    const client = LEASE_CLIENTS.get(this);
    const token = LEASE_TOKENS.get(this);
    if (client === undefined || token === undefined) {
      return 'NOT_OWNER';
    }
    return client.releaseMotorTestLease(token).kind;
  }

  /**
   * Pass 3: fails this lease closed after a SEMANTIC failure - one where
   * no MSP request rejected, so the automatic fault route never fired.
   *
   * This is the deliberate escape hatch for "the exchange succeeded but
   * the answer was unacceptable": an arming-restriction establishment
   * whose ACK and status read both worked, yet reported an armed FC or no
   * restriction at all. Continuing under that ambiguity is exactly what
   * must never happen, so the lease dies and the composite identity is
   * fault-latched through the SAME canonical client latch every other
   * failure uses - no second fault manager exists.
   *
   * Restricted to this exact live capability: a forged, stale, released,
   * invalidated, wrong-client or cross-session object cannot fault
   * anything, and an old capability can never fault a newer lease.
   *
   * Returns whether the fault actually took effect. Idempotent - a second
   * call on an already-dead capability simply returns false.
   */
  failClosed(): boolean {
    const client = LEASE_CLIENTS.get(this);
    const token = LEASE_TOKENS.get(this);
    if (client === undefined || token === undefined) {
      return false;
    }
    return client.faultMotorTestLeaseByToken(token);
  }

  /**
   * Pass 3 correction - the OFFICIAL SESSION this live capability belongs
   * to, as a non-forgeable anchor object.
   *
   * Returns the same authority for every lease taken on the same client
   * while its epoch is unchanged, so a "once per official session" rule
   * survives an ordinary release-and-reacquire. Returns a DIFFERENT
   * authority after a desync (epoch rotation) or on a different client,
   * and `undefined` whenever this capability is not the live owner - a
   * released, invalidated, faulted or forged object can obtain nothing.
   *
   * The returned object exposes no client, transport, token or writer:
   * it is an identity, not a capability, and confers no access at all.
   */
  officialSessionAuthority(): MspOfficialSessionAuthority | undefined {
    const client = LEASE_CLIENTS.get(this);
    const token = LEASE_TOKENS.get(this);
    if (client === undefined || token === undefined || !client.isMotorTestLeaseToken(token)) {
      return undefined;
    }
    return officialSessionAuthorityFor(client);
  }
}

function notAcquired(reason: MotorTestLeaseAcquireFailureReason): MotorTestLeaseAcquisition {
  return Object.freeze({kind: 'NOT_ACQUIRED', reason} as const);
}

/** Maps the client's own ownership refusal onto this module's vocabulary,
 * one to one - no reason is merged, softened or invented. */
function mapClientRejection(
  reason: MspMotorTestLeaseRejectionReason,
): MotorTestLeaseAcquireFailureReason {
  return reason;
}

/**
 * Synchronous, atomic, non-queued try-acquire of the exclusive lease.
 *
 * Never queued, never retried, never delayed, never continued later.
 * Exactly one caller can win; a second or re-entrant attempt fails
 * immediately with a typed reason rather than throwing. A failed
 * acquisition leaves no partial lease behind - no capability object is
 * constructed at all.
 *
 * Acquiring reserves MSP request ownership and nothing else.
 */
export function acquireMotorTestLease(
  options: AcquireMotorTestLeaseOptions,
): MotorTestLeaseAcquisition {
  const {client, requestedIdentity, readCurrentIdentity} = options;

  if (client === undefined) {
    return notAcquired('MSP_CLIENT_UNAVAILABLE');
  }

  const currentIdentity = readCurrentIdentity();
  if (currentIdentity === undefined) {
    return notAcquired('CURRENT_SESSION_IDENTITY_UNAVAILABLE');
  }
  // BOTH scalar components, by value. Independently allocated but equal
  // identities must be accepted; identical references are never required.
  if (!mspSessionCompositeIdentitiesMatch(currentIdentity, requestedIdentity)) {
    return notAcquired('REQUESTED_SESSION_IDENTITY_MISMATCH');
  }
  // The client's OWN epoch must agree too. This is what ties the claimed
  // identity to the actual object being leased: a caller cannot lease
  // client A while describing the epoch of client B, and a desync that
  // already bumped the epoch cannot be leased under the pre-desync value.
  if (client.getEpoch() !== requestedIdentity.mspEpoch) {
    return notAcquired('REQUESTED_SESSION_IDENTITY_MISMATCH');
  }

  const outcome = client.tryAcquireMotorTestLease();
  if (outcome.kind === 'REJECTED') {
    return notAcquired(mapClientRejection(outcome.reason));
  }

  const lease = new MotorTestLease(currentIdentity);
  LEASE_CLIENTS.set(lease, client);
  LEASE_TOKENS.set(lease, outcome.token);
  return Object.freeze({kind: 'ACQUIRED', lease} as const);
}
