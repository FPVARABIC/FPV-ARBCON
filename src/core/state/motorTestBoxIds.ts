/**
 * Pass 3 correction B - SESSION-BOUND BOX IDs EVIDENCE.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The ARM bit's position inside MSP_STATUS_EX's packed flight-mode flags
 * is configuration dependent: it is the index of BOXARM's permanent id
 * (0) in the MSP_BOXIDS reply. Everything the arming-restriction check
 * concludes about "is the FC armed?" therefore rests on that mapping
 * being the RIGHT one, from THIS session.
 *
 * The original Pass 3 accepted a plain `BoxIdsResult` - a bare
 * `{kind, permanentIds}` object. That is caller-supplied data with no
 * provenance whatsoever: a stale mapping from a previous session, a
 * mapping from another client, or an object typed into existence by hand
 * would all have been accepted. A wrong mapping can point at a clear bit
 * and make an ARMED aircraft look DISARMED, which is precisely the
 * conclusion that must never be reachable from untrusted input.
 *
 * WHAT THIS PROVIDES
 * ------------------
 * An opaque, immutable snapshot that can only be minted by actually
 * performing the MSP_BOXIDS read through the live motor-test lease, and
 * whose authenticity is recorded in a module-private registry keyed by
 * the snapshot instance. Authenticity is NOT a field, a brand string or
 * a wrapper the caller can reproduce - it is membership in a registry
 * this module alone can write to. Spreading, JSON round-tripping,
 * structural casting, hand construction and field copying all produce
 * objects the registry has never heard of, and every one of them is
 * rejected.
 *
 * The snapshot is bound to the `MspOfficialSessionAuthority` that was
 * live when it was minted - the same non-forgeable anchor the
 * establishment logic uses - so a stale or cross-client snapshot is
 * detected by identity comparison, not by trusting scalars.
 *
 * WHY NOT EXTEND BoxIdsAcquisition
 * --------------------------------
 * That service is keyed on caller-supplied `{physicalGeneration,
 * mspEpoch}` scalars and takes a raw MspRequester, so it cannot mint
 * trustworthy evidence without being redesigned; and it is shared with
 * Pass 1D and re-exported through three barrels, so widening it would
 * reach far outside this correction. This module is the smallest
 * lease-based acquisition boundary that produces real provenance, and it
 * leaves BoxIdsAcquisition completely untouched.
 *
 * SCOPE. Acquisition happens HERE, as its own operation, deliberately
 * BEFORE establishment - so the established request contract of
 * establishMotorArmingRestriction (99 then 150, and nothing else) is
 * preserved exactly. This module adds no timer, retry, poll, cache or
 * background work, and nothing here authorizes a motor command.
 *
 * OFFICIAL SOURCE, betaflight @ 79065c96ba0bb5cdc675e67d7093e05dab8b330e
 * (lightweight tag 2025.12.2, MSP API 1.47):
 *   MSP_BOXIDS = 119, msp_protocol.h; the reply is the active boxes'
 *   permanent ids in wire order, and that order IS the bit order of the
 *   packed flight-mode flags (msp_box.c:402-418 packFlightModeFlags).
 *   BOXARM's permanentId is 0 (msp_box.c:49).
 */

import {MSP_BOXIDS} from '../protocol/msp/commands/mspCommands';
import type {MotorTestLease, MspOfficialSessionAuthority} from '../protocol/motorTestLease';

const EMPTY_PAYLOAD = new Uint8Array(0);
const REQUEST_OPTIONS = {wireFormat: 'v1'} as const;

/**
 * Module-private provenance registry. Membership here - and nothing else
 * - is what makes a snapshot authentic. A caller cannot add to it,
 * observe it, or reproduce its effect, because it is not reachable from
 * any export.
 */
const SNAPSHOT_AUTHORITIES = new WeakMap<
  MotorTestBoxIdsSnapshot,
  MspOfficialSessionAuthority
>();

/**
 * An immutable, session-bound MSP_BOXIDS mapping.
 *
 * A class so its methods live on the prototype: `{...snapshot}` and
 * `JSON.parse(JSON.stringify(snapshot))` both yield a plain object that
 * the registry does not recognize. `permanentIds` is a frozen copy, so
 * mutating whatever the wire produced cannot reach inside it.
 *
 * The public surface carries no requester, client, lease, token,
 * transport, `writeBytes` or motor-control capability of any kind.
 */
export class MotorTestBoxIdsSnapshot {
  readonly snapshotKind = 'MOTOR_TEST_BOX_IDS_SNAPSHOT' as const;
  /** Permanent ids in wire order; index === bit position. Frozen copy. */
  readonly permanentIds: readonly number[];

  /** @internal Minted only by acquireMotorTestBoxIds(). */
  constructor(permanentIds: readonly number[]) {
    this.permanentIds = Object.freeze(Array.from(permanentIds));
    Object.freeze(this);
  }
}

export type MotorTestBoxIdsFailureReason =
  /** No lease, or it is released, invalidated, faulted or forged, so
   * there is no official session to bind evidence to. */
  | 'MOTOR_TEST_LEASE_INACTIVE'
  /** The MSP_BOXIDS request itself rejected. Never retried here. */
  | 'BOX_IDS_REQUEST_FAILED'
  /** The reply was empty or otherwise unusable as a mapping. */
  | 'BOX_IDS_MALFORMED';

export type MotorTestBoxIdsAcquisition =
  | {readonly kind: 'ACQUIRED'; readonly snapshot: MotorTestBoxIdsSnapshot}
  | {readonly kind: 'NOT_ACQUIRED'; readonly reason: MotorTestBoxIdsFailureReason};

/**
 * Reads MSP_BOXIDS exactly once through the live lease and mints a
 * session-bound snapshot.
 *
 * No retry, no poll, no timer, no cache. The request travels the
 * canonical FIFO via `lease.request(...)` like every other lease-scoped
 * read; this module never touches a client, a transport or `writeBytes`.
 *
 * A snapshot is only minted while the lease is genuinely live both
 * before and after the await, so evidence can never be stamped with an
 * authority that has already been replaced.
 */
export async function acquireMotorTestBoxIds(
  lease: MotorTestLease | undefined,
): Promise<MotorTestBoxIdsAcquisition> {
  if (lease === undefined) {
    return Object.freeze({kind: 'NOT_ACQUIRED', reason: 'MOTOR_TEST_LEASE_INACTIVE'} as const);
  }
  const authorityBefore = lease.officialSessionAuthority();
  if (authorityBefore === undefined) {
    return Object.freeze({kind: 'NOT_ACQUIRED', reason: 'MOTOR_TEST_LEASE_INACTIVE'} as const);
  }

  let payload: Uint8Array;
  try {
    const frame = await lease.request(MSP_BOXIDS, EMPTY_PAYLOAD, REQUEST_OPTIONS);
    payload = frame.payload;
  } catch {
    return Object.freeze({kind: 'NOT_ACQUIRED', reason: 'BOX_IDS_REQUEST_FAILED'} as const);
  }

  // The session must still be the SAME one after the await - otherwise
  // this mapping describes a session that no longer exists and must not
  // be stamped as current evidence.
  const authorityAfter = lease.officialSessionAuthority();
  if (authorityAfter === undefined || authorityAfter !== authorityBefore) {
    return Object.freeze({kind: 'NOT_ACQUIRED', reason: 'MOTOR_TEST_LEASE_INACTIVE'} as const);
  }

  if (payload.length === 0) {
    return Object.freeze({kind: 'NOT_ACQUIRED', reason: 'BOX_IDS_MALFORMED'} as const);
  }

  const snapshot = new MotorTestBoxIdsSnapshot(Array.from(payload));
  SNAPSHOT_AUTHORITIES.set(snapshot, authorityAfter);
  return Object.freeze({kind: 'ACQUIRED', snapshot} as const);
}

/**
 * Returns the snapshot's registered authority, or undefined when this
 * module never minted it.
 *
 * Deliberately NOT exported from any barrel and consumed only by the
 * arming-restriction module: it is the verification half of the
 * provenance mechanism, not a public capability. Returning `undefined`
 * is the answer for every spread copy, JSON revival, hand-built object
 * and structural cast.
 */
export function motorTestBoxIdsAuthorityOf(
  snapshot: unknown,
): MspOfficialSessionAuthority | undefined {
  if (!(snapshot instanceof MotorTestBoxIdsSnapshot)) {
    return undefined;
  }
  return SNAPSHOT_AUTHORITIES.get(snapshot);
}
