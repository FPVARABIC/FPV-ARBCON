/**
 * Pass 7.7 - runtime MSP_BOXIDS acquisition, scoped to the COMPOSITE
 * readiness-owner identity `(physicalGeneration, mspEpoch)`.
 *
 * Both identity components already exist in this codebase and are reused
 * verbatim - no new counter is introduced:
 *  - physicalGeneration: MspSessionCoordinator's own per-session
 *    `generation` (SessionEntry.generation; the value getSessionKey()
 *    exposes), incremented for a genuinely new physical USB session;
 *  - mspEpoch: MspClient's own `getEpoch()` (mspClient.ts:395), bumped by
 *    triggerDesyncLatch() when the link desynchronises and recovers.
 *
 * WHY BOTH: the box ORDER packed into MSP_STATUS_EX's flight-mode bits is
 * configuration dependent (packFlightModeFlags, msp_box.c:402-418 @
 * BETAFLIGHT_API147_COMMIT), so a mapping is only trustworthy for the link
 * state it was read on. A desync/recovery cycle is a new ownership scope:
 * the previous mapping is invalidated and exactly ONE fresh acquisition is
 * permitted for the new composite identity - that is a new scope, NOT a
 * retry of the failed request.
 *
 * INVARIANTS (each covered by a focused test):
 *  - at most ONE MSP_BOXIDS request per composite identity, ever;
 *  - concurrent consumers of the same identity share the one in-flight
 *    promise and then the same cached result;
 *  - success, failure, malformed payload and MSP error all settle that
 *    identity exactly once - no retry inside the identity;
 *  - a physical-generation change clears every mapping, promise and
 *    settled state belonging to the old generation;
 *  - a result arriving from an old generation/epoch is discarded and can
 *    never settle, overwrite or satisfy the current identity;
 *  - never polled: acquisition happens only when a consumer asks, and only
 *    once per identity - no timer, no per-render/per-status/per-preflight
 *    request;
 *  - uses only the caller-supplied MspRequester (the existing MspClient,
 *    hence the existing FIFO) - no second client, no queue bypass, and no
 *    duplication of the MSP_STATUS_EX polling path.
 */

import {MSP_BOXIDS} from '../commands/mspCommands';
import type {MspRequester} from './MspIdentificationService';

export interface BoxIdsOwnerIdentity {
  readonly physicalGeneration: number;
  readonly mspEpoch: number;
}

export type BoxIdsResult =
  /** permanentIds in wire order: index === bit position in the packed
   * flight-mode flags (msp_box.c serializeBoxReply / packFlightModeFlags). */
  | {readonly kind: 'READY'; readonly permanentIds: readonly number[]}
  /** Request failed, was rejected by the FC, or returned an unusable
   * payload. Never retried within this identity. */
  | {readonly kind: 'UNAVAILABLE'; readonly reason: 'REQUEST_FAILED' | 'MALFORMED'};

const EMPTY_REQUEST_PAYLOAD = new Uint8Array(0);

function identityKey(identity: BoxIdsOwnerIdentity): string {
  return `${identity.physicalGeneration}:${identity.mspEpoch}`;
}

export class BoxIdsAcquisition {
  private readonly inFlight = new Map<string, Promise<BoxIdsResult>>();
  private readonly settled = new Map<string, BoxIdsResult>();
  private readonly requestCounts = new Map<string, number>();

  constructor(private readonly requester: MspRequester) {}

  /** Cached result for this exact composite identity, or undefined when
   * nothing has settled for it yet. Never triggers a request. */
  peek(identity: BoxIdsOwnerIdentity): BoxIdsResult | undefined {
    return this.settled.get(identityKey(identity));
  }

  /** How many MSP_BOXIDS requests were actually dispatched for this
   * identity - the at-most-once invariant made observable. */
  requestCountFor(identity: BoxIdsOwnerIdentity): number {
    return this.requestCounts.get(identityKey(identity)) ?? 0;
  }

  /**
   * Returns the mapping for this identity, acquiring it at most once.
   * Concurrent callers receive the SAME in-flight promise.
   *
   * `isCurrent` is consulted again when the response settles: a result
   * belonging to a generation/epoch that is no longer current is discarded
   * (and never cached), so an old-scope callback can neither satisfy nor
   * corrupt the current identity.
   */
  async acquire(identity: BoxIdsOwnerIdentity, isCurrent: () => boolean): Promise<BoxIdsResult> {
    const key = identityKey(identity);
    const cached = this.settled.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const existing = this.inFlight.get(key);
    if (existing !== undefined) {
      return existing;
    }
    if (!isCurrent()) {
      // The scope died before the request could even start.
      return {kind: 'UNAVAILABLE', reason: 'REQUEST_FAILED'};
    }

    this.requestCounts.set(key, (this.requestCounts.get(key) ?? 0) + 1);
    const request = this.requester
      .request(MSP_BOXIDS, EMPTY_REQUEST_PAYLOAD, {wireFormat: 'v1'})
      .then((frame): BoxIdsResult => {
        if (frame.payload.length === 0) {
          return {kind: 'UNAVAILABLE', reason: 'MALFORMED'};
        }
        return {kind: 'READY', permanentIds: Object.freeze(Array.from(frame.payload))};
      })
      .catch((): BoxIdsResult => ({kind: 'UNAVAILABLE', reason: 'REQUEST_FAILED'}))
      .then(result => {
        this.inFlight.delete(key);
        if (!isCurrent()) {
          // Old-generation / old-epoch outcome: discard it entirely - do
          // not cache, do not let it satisfy any current identity. The
          // caller still gets an honest UNAVAILABLE for its dead scope.
          return {kind: 'UNAVAILABLE', reason: 'REQUEST_FAILED'} as BoxIdsResult;
        }
        this.settled.set(key, result); // settles this identity exactly once
        return result;
      });

    this.inFlight.set(key, request);
    return request;
  }

  /** Clears every mapping, promise and settled state belonging to a
   * replaced physical generation. Called on teardown/replacement. */
  clearGeneration(physicalGeneration: number): void {
    const prefix = `${physicalGeneration}:`;
    for (const key of Array.from(this.settled.keys())) {
      if (key.startsWith(prefix)) {
        this.settled.delete(key);
      }
    }
    for (const key of Array.from(this.inFlight.keys())) {
      if (key.startsWith(prefix)) {
        this.inFlight.delete(key);
      }
    }
    for (const key of Array.from(this.requestCounts.keys())) {
      if (key.startsWith(prefix)) {
        this.requestCounts.delete(key);
      }
    }
  }

  /** Total identities with a settled mapping - teardown proof. */
  settledCount(): number {
    return this.settled.size;
  }
}
