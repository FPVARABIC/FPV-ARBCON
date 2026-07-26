/**
 * Pass 7.7 - MSP_BOXIDS acquisition scoped to the composite
 * (physicalGeneration, mspEpoch) readiness-owner identity.
 */

import {BoxIdsAcquisition} from './BoxIdsAcquisition';
import type {BoxIdsOwnerIdentity} from './BoxIdsAcquisition';
import {MSP_BOXIDS} from '../commands/mspCommands';
import type {MspFrame} from '../../mspTypes';
import type {MspRequester} from './MspIdentificationService';

const GEN1_EPOCH0: BoxIdsOwnerIdentity = {physicalGeneration: 1, mspEpoch: 0};
const GEN1_EPOCH1: BoxIdsOwnerIdentity = {physicalGeneration: 1, mspEpoch: 1};
const GEN2_EPOCH0: BoxIdsOwnerIdentity = {physicalGeneration: 2, mspEpoch: 0};

function frame(payload: number[]): MspFrame {
  return {
    protocolVersion: 'v1',
    wireFormat: 'v1',
    direction: 'response',
    command: MSP_BOXIDS,
    flags: 0,
    payload: Uint8Array.from(payload),
  };
}

/** Manual-control requester: each call is resolved/rejected explicitly, so
 * "one shared in-flight request" is directly observable. */
function makeRequester() {
  const pending: Array<{resolve: (f: MspFrame) => void; reject: (e: unknown) => void}> = [];
  const commands: number[] = [];
  const requester: MspRequester & {
    commands: number[];
    pendingCount: () => number;
    resolveNext: (f: MspFrame) => void;
    rejectNext: (e: unknown) => void;
  } = {
    commands,
    pendingCount: () => pending.length,
    request(command: number): Promise<MspFrame> {
      commands.push(command);
      return new Promise<MspFrame>((resolve, reject) => pending.push({resolve, reject}));
    },
    resolveNext(f: MspFrame) {
      pending.shift()?.resolve(f);
    },
    rejectNext(e: unknown) {
      pending.shift()?.reject(e);
    },
  };
  return requester;
}

const alwaysCurrent = () => true;

describe('BoxIdsAcquisition - composite (physicalGeneration, mspEpoch) ownership', () => {
  it('issues MSP_BOXIDS at most once per composite identity and reuses the cached result', async () => {
    const requester = makeRequester();
    const acquisition = new BoxIdsAcquisition(requester);

    const first = acquisition.acquire(GEN1_EPOCH0, alwaysCurrent);
    requester.resolveNext(frame([0, 1, 2]));
    expect(await first).toEqual({kind: 'READY', permanentIds: [0, 1, 2]});

    // Repeated consumers (renders, status polls, tool preflights) reuse it.
    for (let i = 0; i < 5; i++) {
      expect(await acquisition.acquire(GEN1_EPOCH0, alwaysCurrent)).toEqual({
        kind: 'READY',
        permanentIds: [0, 1, 2],
      });
    }
    expect(requester.commands.filter(c => c === MSP_BOXIDS)).toHaveLength(1);
    expect(acquisition.requestCountFor(GEN1_EPOCH0)).toBe(1);
    expect(acquisition.peek(GEN1_EPOCH0)).toEqual({kind: 'READY', permanentIds: [0, 1, 2]});
  });

  it('concurrent consumers of the same identity share ONE in-flight request', async () => {
    const requester = makeRequester();
    const acquisition = new BoxIdsAcquisition(requester);

    const a = acquisition.acquire(GEN1_EPOCH0, alwaysCurrent);
    const b = acquisition.acquire(GEN1_EPOCH0, alwaysCurrent);
    const c = acquisition.acquire(GEN1_EPOCH0, alwaysCurrent);
    expect(requester.pendingCount()).toBe(1);
    expect(acquisition.requestCountFor(GEN1_EPOCH0)).toBe(1);

    requester.resolveNext(frame([0, 5]));
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(ra).toEqual(rb);
    expect(rb).toEqual(rc);
    expect(requester.commands).toHaveLength(1);
  });

  it('a failure settles the identity once and is NEVER retried within that identity', async () => {
    const requester = makeRequester();
    const acquisition = new BoxIdsAcquisition(requester);

    const first = acquisition.acquire(GEN1_EPOCH0, alwaysCurrent);
    requester.rejectNext(new Error('MSP_TIMEOUT'));
    expect(await first).toEqual({kind: 'UNAVAILABLE', reason: 'REQUEST_FAILED'});

    expect(await acquisition.acquire(GEN1_EPOCH0, alwaysCurrent)).toEqual({
      kind: 'UNAVAILABLE',
      reason: 'REQUEST_FAILED',
    });
    expect(acquisition.requestCountFor(GEN1_EPOCH0)).toBe(1); // no retry
  });

  it('an MSP error frame (rejected request) settles as UNAVAILABLE without retry', async () => {
    const requester = makeRequester();
    const acquisition = new BoxIdsAcquisition(requester);
    const pendingResult = acquisition.acquire(GEN1_EPOCH0, alwaysCurrent);
    requester.rejectNext({code: 'MSP_REMOTE_ERROR'});
    expect(await pendingResult).toEqual({kind: 'UNAVAILABLE', reason: 'REQUEST_FAILED'});
    expect(acquisition.requestCountFor(GEN1_EPOCH0)).toBe(1);
  });

  it('a malformed (empty) payload settles as MALFORMED - never a guessed mapping', async () => {
    const requester = makeRequester();
    const acquisition = new BoxIdsAcquisition(requester);
    const pendingResult = acquisition.acquire(GEN1_EPOCH0, alwaysCurrent);
    requester.resolveNext(frame([]));
    expect(await pendingResult).toEqual({kind: 'UNAVAILABLE', reason: 'MALFORMED'});
    expect(acquisition.requestCountFor(GEN1_EPOCH0)).toBe(1);
  });

  it('a mapping without BOXARM (permanent id 0) is still READY here - armed derivation reports UNKNOWN separately', async () => {
    const requester = makeRequester();
    const acquisition = new BoxIdsAcquisition(requester);
    const pendingResult = acquisition.acquire(GEN1_EPOCH0, alwaysCurrent);
    requester.resolveNext(frame([1, 2, 3]));
    const result = await pendingResult;
    expect(result).toEqual({kind: 'READY', permanentIds: [1, 2, 3]});
    if (result.kind === 'READY') {
      expect(result.permanentIds).not.toContain(0);
    }
  });

  it('an MSP-EPOCH replacement is a NEW scope: exactly one new acquisition, old mapping not reused', async () => {
    const requester = makeRequester();
    const acquisition = new BoxIdsAcquisition(requester);

    const beforeRecovery = acquisition.acquire(GEN1_EPOCH0, alwaysCurrent);
    requester.resolveNext(frame([0, 1]));
    await beforeRecovery;

    // Desync + recovery bumped MspClient.getEpoch() -> new composite id.
    const afterRecovery = acquisition.acquire(GEN1_EPOCH1, alwaysCurrent);
    expect(acquisition.requestCountFor(GEN1_EPOCH1)).toBe(1);
    requester.resolveNext(frame([0, 7, 9]));
    expect(await afterRecovery).toEqual({kind: 'READY', permanentIds: [0, 7, 9]});

    // Exactly two requests total: one per composite identity, no retry.
    expect(requester.commands).toHaveLength(2);
    expect(acquisition.requestCountFor(GEN1_EPOCH0)).toBe(1);
  });

  it('a PHYSICAL-GENERATION replacement clears every mapping, promise and settled state of the old generation', async () => {
    const requester = makeRequester();
    const acquisition = new BoxIdsAcquisition(requester);

    const old = acquisition.acquire(GEN1_EPOCH0, alwaysCurrent);
    requester.resolveNext(frame([0, 1]));
    await old;
    expect(acquisition.settledCount()).toBe(1);

    acquisition.clearGeneration(1);
    expect(acquisition.peek(GEN1_EPOCH0)).toBeUndefined();
    expect(acquisition.requestCountFor(GEN1_EPOCH0)).toBe(0);
    expect(acquisition.settledCount()).toBe(0);

    // The new generation acquires its own mapping exactly once.
    const fresh = acquisition.acquire(GEN2_EPOCH0, alwaysCurrent);
    requester.resolveNext(frame([0, 4]));
    expect(await fresh).toEqual({kind: 'READY', permanentIds: [0, 4]});
    expect(acquisition.requestCountFor(GEN2_EPOCH0)).toBe(1);
  });

  it('an old-generation/old-epoch callback is discarded and can never satisfy or overwrite the current identity', async () => {
    const requester = makeRequester();
    const acquisition = new BoxIdsAcquisition(requester);

    let current: BoxIdsOwnerIdentity = GEN1_EPOCH0;
    const isCurrent = (identity: BoxIdsOwnerIdentity) => () =>
      identity.physicalGeneration === current.physicalGeneration && identity.mspEpoch === current.mspEpoch;

    const staleRequest = acquisition.acquire(GEN1_EPOCH0, isCurrent(GEN1_EPOCH0));
    // The link desyncs (new epoch) BEFORE the old response lands.
    current = GEN1_EPOCH1;
    requester.resolveNext(frame([0, 1, 2]));

    expect(await staleRequest).toEqual({kind: 'UNAVAILABLE', reason: 'REQUEST_FAILED'});
    // Nothing was cached for the dead scope, and the current identity is
    // untouched - it has no mapping yet at all.
    expect(acquisition.peek(GEN1_EPOCH0)).toBeUndefined();
    expect(acquisition.peek(GEN1_EPOCH1)).toBeUndefined();
    expect(acquisition.settledCount()).toBe(0);
  });

  it('never dispatches when the scope is already dead, and never polls: no request without a consumer', async () => {
    const requester = makeRequester();
    const acquisition = new BoxIdsAcquisition(requester);

    // No consumer -> no request at all (no timer, no periodic poll).
    expect(requester.commands).toHaveLength(0);
    expect(acquisition.requestCountFor(GEN1_EPOCH0)).toBe(0);

    expect(await acquisition.acquire(GEN1_EPOCH0, () => false)).toEqual({
      kind: 'UNAVAILABLE',
      reason: 'REQUEST_FAILED',
    });
    expect(requester.commands).toHaveLength(0);
  });

  it('repeated tool-preflight-style calls after a settled result add no further requests', async () => {
    const requester = makeRequester();
    const acquisition = new BoxIdsAcquisition(requester);
    const firstCall = acquisition.acquire(GEN1_EPOCH0, alwaysCurrent);
    requester.resolveNext(frame([0]));
    await firstCall;

    // Simulate 3 preflights + 10 status polls + 20 renders.
    for (let i = 0; i < 33; i++) {
      await acquisition.acquire(GEN1_EPOCH0, alwaysCurrent);
    }
    expect(requester.commands).toHaveLength(1);
  });
});
