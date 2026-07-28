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
import type {MspRequestOptions} from './mspClient';

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
