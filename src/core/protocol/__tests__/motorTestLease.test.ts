/**
 * Pass 2 - tests for the exclusive, session-bound motor test lease.
 *
 * NO HARDWARE OF ANY KIND is required, referenced or simulated: no flight
 * controller, no USB, no serial session, no ESC, no motor, no LiPo, no
 * emulator, no device. The transport is the repository's existing
 * FakeMspTransport and every frame is a hand-built byte array.
 *
 * HOLDING A LEASE IS NOT MOTOR SAFETY, READINESS OR AUTHORIZATION. These
 * tests deliberately assert that no such verdict exists on the public
 * surface, and that no motor or arming command can be produced here.
 *
 * COMMAND FIXTURES ARE HARMLESS AND IN-MEMORY. Command 214
 * (MSP_SET_MOTOR) and command 99 (MSP_SET_ARMING_DISABLED) appear in no
 * request fixture anywhere in this file - only as forbidden values in
 * assertions.
 */

import {
  MspClient,
  MspMotorTestLeaseBlockedError,
  MspMotorTestLeaseToken,
} from '../mspClient';
import {
  acquireMotorTestLease,
  MotorTestLease,
  mspSessionCompositeIdentitiesMatch,
  type MotorTestLeaseAcquisition,
  type MspSessionCompositeIdentity,
} from '../motorTestLease';
import {FakeMspTransport} from '../__testUtils__/mspFakeTransport';
import {buildMspFrameBytes} from '../__testUtils__/mspFixtures';

const SESSION_ID = 'session-lease-1';
const EMPTY = new Uint8Array(0);

/** A harmless read command used purely as an in-memory fixture. Never a
 * write, never a motor command, never 214, never 99. */
const HARMLESS_COMMAND = 101;

function identity(physicalGeneration = 2, mspEpoch = 0): MspSessionCompositeIdentity {
  // Freshly allocated on every call, so equality can only ever be proven
  // by scalar value - never by reference.
  return {physicalGeneration, mspEpoch};
}

function makeClient() {
  const transport = new FakeMspTransport();
  const client = new MspClient(transport, SESSION_ID);
  return {transport, client};
}

function responseFrame(command: number, payload: Uint8Array = EMPTY): Uint8Array {
  return buildMspFrameBytes(command, payload, {wireFormat: 'v1', direction: 'response'});
}

async function flushMicrotasks(times = 6): Promise<void> {
  for (let index = 0; index < times; index++) {
    await Promise.resolve();
  }
}

/**
 * NO DEFAULT PARAMETERS. JavaScript applies a default whenever the
 * argument is `undefined` - whether it was omitted or passed explicitly -
 * so a defaulted `current` would silently reinstate a valid identity and
 * make the no-current-identity tests vacuous. Every argument is explicit
 * here; `acquire()` below is the convenience wrapper for the happy path.
 */
function acquireWith(
  client: MspClient | undefined,
  current: MspSessionCompositeIdentity | undefined,
  requested: MspSessionCompositeIdentity,
): MotorTestLeaseAcquisition {
  return acquireMotorTestLease({
    client,
    requestedIdentity: requested,
    readCurrentIdentity: () => current,
  });
}

function acquire(
  client: MspClient | undefined,
  current: MspSessionCompositeIdentity = identity(),
  requested: MspSessionCompositeIdentity = identity(),
): MotorTestLeaseAcquisition {
  return acquireWith(client, current, requested);
}

function acquireOrThrow(client: MspClient, epoch = 0): MotorTestLease {
  const result = acquire(client, identity(2, epoch), identity(2, epoch));
  if (result.kind !== 'ACQUIRED') {
    throw new Error(`expected ACQUIRED, got ${result.reason}`);
  }
  return result.lease;
}

function expectNotAcquired(result: MotorTestLeaseAcquisition, reason: string): void {
  expect(result.kind).toBe('NOT_ACQUIRED');
  if (result.kind !== 'NOT_ACQUIRED') {
    throw new Error('unreachable');
  }
  expect(result.reason).toBe(reason);
  // A failed acquisition leaves no partial lease behind.
  expect(Object.keys(result).sort()).toEqual(['kind', 'reason']);
}

/**
 * Drives the client through its own REAL desynchronization path - a write
 * failure whose outcome is unknown - which is what actually calls
 * triggerDesyncLatch() and bumps the epoch. Uses an ordinary request, so
 * it is only valid while NO lease is held.
 */
async function desynchronizeUnleased(
  transport: FakeMspTransport,
  client: MspClient,
): Promise<void> {
  const doomed = client.request(HARMLESS_COMMAND, EMPTY, {wireFormat: 'v1'});
  const settled = doomed.catch(() => undefined);
  transport.rejectNextWrite('WRITE_FAILED');
  await settled;
  await flushMicrotasks();
}

/** The same real path, driven through a held lease's own request - which
 * is also the "failed lease-scoped request" case. */
async function desynchronizeViaLease(
  transport: FakeMspTransport,
  lease: MotorTestLease,
): Promise<void> {
  const doomed = lease.request(HARMLESS_COMMAND, EMPTY, {wireFormat: 'v1'});
  const settled = doomed.catch(() => undefined);
  transport.rejectNextWrite('WRITE_FAILED');
  await settled;
  await flushMicrotasks();
}

/** Runs whatever recovery work is pending all the way to its conclusion. */
async function driveRecoveryToCompletion(transport: FakeMspTransport): Promise<void> {
  await flushMicrotasks();
  if (transport.restarts.length > 0) {
    transport.resolveNextRestart();
  }
  await flushMicrotasks();
  if (transport.writes.length > 0) {
    transport.resolveNextWrite();
    await flushMicrotasks();
    transport.emitData(responseFrame(1));
    await flushMicrotasks();
  }
}

/* ------------------------------------------------------------------ *
 * 12.1 Acquisition
 * ------------------------------------------------------------------ */

describe('acquisition', () => {
  it('succeeds with independently allocated but value-equal identities', () => {
    const {client} = makeClient();
    const result = acquireMotorTestLease({
      client,
      requestedIdentity: {physicalGeneration: 2, mspEpoch: 0},
      readCurrentIdentity: () => ({physicalGeneration: 2, mspEpoch: 0}),
    });
    expect(result.kind).toBe('ACQUIRED');
    if (result.kind !== 'ACQUIRED') {
      throw new Error('unreachable');
    }
    expect(result.lease.sessionIdentity).toEqual({physicalGeneration: 2, mspEpoch: 0});
    expect(result.lease.isActive()).toBe(true);
  });

  it('compares identity by scalar value on both components', () => {
    expect(mspSessionCompositeIdentitiesMatch(identity(2, 0), {physicalGeneration: 2, mspEpoch: 0})).toBe(true);
    expect(mspSessionCompositeIdentitiesMatch(identity(2, 0), {physicalGeneration: 3, mspEpoch: 0})).toBe(false);
    expect(mspSessionCompositeIdentitiesMatch(identity(2, 0), {physicalGeneration: 2, mspEpoch: 1})).toBe(false);
    expect(mspSessionCompositeIdentitiesMatch(undefined, identity())).toBe(false);
  });

  it('fails when there is no authoritative current identity', () => {
    const {client} = makeClient();
    expectNotAcquired(
      acquireWith(client, undefined, identity()),
      'CURRENT_SESSION_IDENTITY_UNAVAILABLE',
    );
    expect(client.isMotorTestLeaseHeld()).toBe(false);
  });

  it('fails on a physicalGeneration mismatch', () => {
    const {client} = makeClient();
    expectNotAcquired(
      acquire(client, identity(2, 0), identity(3, 0)),
      'REQUESTED_SESSION_IDENTITY_MISMATCH',
    );
  });

  it('fails on an mspEpoch mismatch', () => {
    const {client} = makeClient();
    expectNotAcquired(
      acquire(client, identity(2, 0), identity(2, 5)),
      'REQUESTED_SESSION_IDENTITY_MISMATCH',
    );
  });

  it("fails when the client's own epoch disagrees with the requested identity", async () => {
    const {transport, client} = makeClient();
    await desynchronizeUnleased(transport, client); // bumps the client epoch to 1
    expect(client.getEpoch()).toBe(1);
    // Provider and request agree with each other, but not with the client.
    expectNotAcquired(
      acquire(client, identity(2, 0), identity(2, 0)),
      'REQUESTED_SESSION_IDENTITY_MISMATCH',
    );
  });

  it('fails when no client is supplied', () => {
    expectNotAcquired(acquireWith(undefined, identity(), identity()), 'MSP_CLIENT_UNAVAILABLE');
  });

  it('fails while a request is active (write awaiting settlement)', () => {
    const {transport, client} = makeClient();
    const inFlight = client.request(HARMLESS_COMMAND, EMPTY, {wireFormat: 'v1'});
    expect(transport.writes).toHaveLength(1);
    expectNotAcquired(acquire(client), 'MSP_CLIENT_NOT_IDLE');
    // Settle it so the pending Promise never dangles.
    transport.resolveNextWrite();
    transport.emitData(responseFrame(HARMLESS_COMMAND));
    return inFlight;
  });

  it('fails while a request is queued behind an active one', async () => {
    const {transport, client} = makeClient();
    const first = client.request(HARMLESS_COMMAND, EMPTY, {wireFormat: 'v1'});
    const second = client.request(HARMLESS_COMMAND + 1, EMPTY, {wireFormat: 'v1'});
    expect(transport.writes).toHaveLength(1); // second is queued, not active
    expectNotAcquired(acquire(client), 'MSP_CLIENT_NOT_IDLE');

    transport.resolveNextWrite();
    transport.emitData(responseFrame(HARMLESS_COMMAND));
    await first;
    transport.resolveNextWrite();
    transport.emitData(responseFrame(HARMLESS_COMMAND + 1));
    await second;
  });

  it('fails while awaiting a response after the write settled', async () => {
    const {transport, client} = makeClient();
    const inFlight = client.request(HARMLESS_COMMAND, EMPTY, {wireFormat: 'v1'});
    transport.resolveNextWrite();
    await flushMicrotasks();
    expect(client.getActiveRequestPhase()).toBe('AWAITING_RESPONSE');
    expectNotAcquired(acquire(client), 'MSP_CLIENT_NOT_IDLE');

    transport.emitData(responseFrame(HARMLESS_COMMAND));
    await inFlight;
  });

  it('fails in every non-requestable state (desynchronized/recovering/probing)', async () => {
    const {transport, client} = makeClient();
    await desynchronizeUnleased(transport, client);
    expect(['DESYNCHRONIZED', 'RESTARTING_READER', 'PROBING', 'RECOVERY_FAILED']).toContain(
      client.getState(),
    );
    // Ask with the post-desync epoch so the refusal is genuinely about
    // state, not about the identity check.
    expectNotAcquired(
      acquire(client, identity(2, client.getEpoch()), identity(2, client.getEpoch())),
      'MSP_CLIENT_NOT_IDLE',
    );
  });

  it('fails once the client is closed', () => {
    const {client} = makeClient();
    client.dispose();
    expectNotAcquired(acquire(client), 'MSP_CLIENT_NOT_IDLE');
  });

  it('lets the first of two immediate acquisitions win and refuses the second', () => {
    const {client} = makeClient();
    const first = acquire(client);
    const second = acquire(client);
    expect(first.kind).toBe('ACQUIRED');
    expectNotAcquired(second, 'MOTOR_TEST_LEASE_ALREADY_HELD');
  });

  it('refuses a re-entrant acquisition through a second independent wrapper', () => {
    // Ownership lives in the client, so no second "lease manager" can
    // exist over the same client.
    const {client} = makeClient();
    expect(acquire(client).kind).toBe('ACQUIRED');
    expectNotAcquired(acquire(client), 'MOTOR_TEST_LEASE_ALREADY_HELD');
    expect(client.isMotorTestLeaseHeld()).toBe(true);
  });

  it('leaves no partial lease and no held state after any failure', () => {
    const {client} = makeClient();
    for (const attempt of [
      () => acquireWith(undefined, identity(), identity()),
      () => acquireWith(client, undefined, identity()),
      () => acquireWith(client, identity(2, 0), identity(9, 9)),
    ]) {
      const result = attempt();
      expect(result.kind).toBe('NOT_ACQUIRED');
      expect(client.isMotorTestLeaseHeld()).toBe(false);
    }
  });

  it('is synchronous - never queued, delayed or retried', () => {
    const {transport, client} = makeClient();
    const inFlight = client.request(HARMLESS_COMMAND, EMPTY, {wireFormat: 'v1'});
    const before = transport.writes.length;
    const result = acquire(client);
    // Answered in the same synchronous turn, with no extra traffic and
    // no scheduled continuation.
    expect(result.kind).toBe('NOT_ACQUIRED');
    expect(transport.writes.length).toBe(before);
    transport.resolveNextWrite();
    transport.emitData(responseFrame(HARMLESS_COMMAND));
    return inFlight;
  });
});

/* ------------------------------------------------------------------ *
 * 12.2 Admission
 * ------------------------------------------------------------------ */

describe('request admission', () => {
  it('leaves ordinary request behaviour completely unchanged when no lease exists', async () => {
    const {transport, client} = makeClient();
    const promise = client.request(HARMLESS_COMMAND, Uint8Array.from([1, 2]), {wireFormat: 'v1'});
    expect(transport.writes).toHaveLength(1);
    transport.resolveNextWrite();
    transport.emitData(responseFrame(HARMLESS_COMMAND, Uint8Array.from([7])));
    const frame = await promise;
    expect(frame.command).toBe(HARMLESS_COMMAND);
    expect(frame.payload).toEqual(Uint8Array.from([7]));
    expect(client.getState()).toBe('READY');
  });

  it('rejects an ordinary request while leased, before FIFO admission', async () => {
    const {transport, client} = makeClient();
    acquireOrThrow(client);
    const rejection = client.request(HARMLESS_COMMAND, EMPTY, {wireFormat: 'v1'});
    await expect(rejection).rejects.toBeInstanceOf(MspMotorTestLeaseBlockedError);
    await rejection.catch((error: MspMotorTestLeaseBlockedError) => {
      expect(error.code).toBe('MSP_MOTOR_TEST_LEASE_HELD');
    });
    expect(transport.writes).toHaveLength(0);
  });

  it('causes zero transport writes and no state change for rejected ordinary traffic', async () => {
    const {transport, client} = makeClient();
    acquireOrThrow(client);
    const before = client.getState();
    await Promise.allSettled([
      client.request(HARMLESS_COMMAND, EMPTY, {wireFormat: 'v1'}),
      client.request(HARMLESS_COMMAND + 1, EMPTY, {wireFormat: 'v1'}),
      client.request(HARMLESS_COMMAND + 2, EMPTY, {wireFormat: 'v1'}),
    ]);
    expect(transport.writes).toHaveLength(0);
    expect(client.getState()).toBe(before);
    expect(client.getActiveRequestPhase()).toBeUndefined();
    // Still idle enough that a valid release works - proof nothing was
    // admitted or left behind.
    expect(client.isMotorTestLeaseHeld()).toBe(true);
  });

  it('admits a lease-scoped request through the existing FIFO and transport path', async () => {
    const {transport, client} = makeClient();
    const lease = acquireOrThrow(client);
    const promise = lease.request(HARMLESS_COMMAND, Uint8Array.from([4]), {wireFormat: 'v1'});
    expect(transport.writes).toHaveLength(1);
    transport.resolveNextWrite();
    transport.emitData(responseFrame(HARMLESS_COMMAND, Uint8Array.from([5])));
    const frame = await promise;
    expect(frame.command).toBe(HARMLESS_COMMAND);
    expect(frame.payload).toEqual(Uint8Array.from([5]));
  });

  it('keeps existing FIFO ordering for consecutive lease-scoped requests', async () => {
    const {transport, client} = makeClient();
    const lease = acquireOrThrow(client);
    const first = lease.request(HARMLESS_COMMAND, EMPTY, {wireFormat: 'v1'});
    const second = lease.request(HARMLESS_COMMAND + 1, EMPTY, {wireFormat: 'v1'});
    expect(transport.writes).toHaveLength(1); // single-flight preserved

    transport.resolveNextWrite();
    transport.emitData(responseFrame(HARMLESS_COMMAND));
    expect((await first).command).toBe(HARMLESS_COMMAND);
    transport.resolveNextWrite();
    transport.emitData(responseFrame(HARMLESS_COMMAND + 1));
    expect((await second).command).toBe(HARMLESS_COMMAND + 1);
  });

  it('preserves existing response-timeout semantics for a lease-scoped request', async () => {
    jest.useFakeTimers();
    try {
      const {transport, client} = makeClient();
      const lease = acquireOrThrow(client);
      const promise = lease.request(HARMLESS_COMMAND, EMPTY, {
        wireFormat: 'v1',
        responseTimeoutMs: 50,
      });
      transport.resolveNextWrite();
      await flushMicrotasks();
      expect(client.getActiveRequestPhase()).toBe('AWAITING_RESPONSE');
      jest.advanceTimersByTime(51);
      await expect(promise).rejects.toMatchObject({code: 'MSP_TIMEOUT'});
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects a capability rebuilt from copied public fields', async () => {
    const {transport, client} = makeClient();
    const lease = acquireOrThrow(client);
    const spread = {...lease} as Partial<MotorTestLease>;
    // Spreading a class instance copies own data only - the prototype
    // methods do not come along, so there is nothing to call.
    expect(spread.request).toBeUndefined();
    expect(spread.release).toBeUndefined();
    expect(spread.leaseKind).toBe('MOTOR_TEST_LEASE');
    expect(transport.writes).toHaveLength(0);
  });

  it('rejects a capability reconstructed from JSON', () => {
    const {client} = makeClient();
    const lease = acquireOrThrow(client);
    const revived = JSON.parse(JSON.stringify(lease)) as Partial<MotorTestLease>;
    expect(revived.request).toBeUndefined();
    expect(revived.release).toBeUndefined();
    // And nothing in the serialized form is the token.
    expect(JSON.stringify(lease)).not.toContain('token');
  });

  it('rejects a forged capability that never had a token', async () => {
    const {transport, client} = makeClient();
    acquireOrThrow(client);
    const forged = new MotorTestLease(identity());
    await expect(forged.request(HARMLESS_COMMAND, EMPTY, {wireFormat: 'v1'})).rejects.toThrow(
      /not a genuine lease/,
    );
    expect(forged.isActive()).toBe(false);
    expect(transport.writes).toHaveLength(0);
  });

  it('rejects a raw forged token at the client admission point', async () => {
    const {transport, client} = makeClient();
    acquireOrThrow(client);
    const forgedToken = new MspMotorTestLeaseToken();
    await expect(
      client.requestWithMotorTestLease(forgedToken, HARMLESS_COMMAND, EMPTY, {wireFormat: 'v1'}),
    ).rejects.toMatchObject({code: 'MSP_MOTOR_TEST_LEASE_CAPABILITY_INVALID'});
    expect(transport.writes).toHaveLength(0);
  });

  it('rejects a capability belonging to a different client', async () => {
    const first = makeClient();
    const second = makeClient();
    const leaseOnFirst = acquireOrThrow(first.client);
    // The second client has no lease at all; the first client's
    // capability must not work against it.
    expect(second.client.isMotorTestLeaseToken(leaseOnFirst)).toBe(false);
    const leaseOnSecond = acquireOrThrow(second.client);
    expect(leaseOnSecond).not.toBe(leaseOnFirst);
    // Each capability only drives its own client.
    const promise = leaseOnFirst.request(HARMLESS_COMMAND, EMPTY, {wireFormat: 'v1'});
    expect(first.transport.writes).toHaveLength(1);
    expect(second.transport.writes).toHaveLength(0);
    first.transport.resolveNextWrite();
    first.transport.emitData(responseFrame(HARMLESS_COMMAND));
    await promise;
  });

  it('rejects a released capability', async () => {
    const {transport, client} = makeClient();
    const lease = acquireOrThrow(client);
    expect(lease.release()).toBe('RELEASED');
    await expect(lease.request(HARMLESS_COMMAND, EMPTY, {wireFormat: 'v1'})).rejects.toMatchObject({
      code: 'MSP_MOTOR_TEST_LEASE_CAPABILITY_INVALID',
    });
    expect(transport.writes).toHaveLength(0);
  });

  it('rejects an invalidated capability', async () => {
    const {transport, client} = makeClient();
    const lease = acquireOrThrow(client);
    client.dispose();
    await expect(lease.request(HARMLESS_COMMAND, EMPTY, {wireFormat: 'v1'})).rejects.toMatchObject({
      code: 'MSP_MOTOR_TEST_LEASE_CAPABILITY_INVALID',
    });
    expect(transport.writes).toHaveLength(0);
  });

  it('stops a stale capability submitting once a later lease exists', async () => {
    const {transport, client} = makeClient();
    const older = acquireOrThrow(client);
    expect(older.release()).toBe('RELEASED');
    const newer = acquireOrThrow(client);
    expect(newer).not.toBe(older);

    await expect(older.request(HARMLESS_COMMAND, EMPTY, {wireFormat: 'v1'})).rejects.toMatchObject({
      code: 'MSP_MOTOR_TEST_LEASE_CAPABILITY_INVALID',
    });
    expect(transport.writes).toHaveLength(0);
    expect(newer.isActive()).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 12.3 Release
 * ------------------------------------------------------------------ */

describe('release', () => {
  it('succeeds for the exact capability on an idle client', () => {
    const {client} = makeClient();
    const lease = acquireOrThrow(client);
    expect(lease.release()).toBe('RELEASED');
    expect(client.isMotorTestLeaseHeld()).toBe(false);
    expect(lease.isActive()).toBe(false);
  });

  it('is idempotent for the same already-released capability', () => {
    const {client} = makeClient();
    const lease = acquireOrThrow(client);
    expect(lease.release()).toBe('RELEASED');
    expect(lease.release()).toBe('ALREADY_RELEASED');
    expect(lease.release()).toBe('ALREADY_RELEASED');
  });

  it('cannot be performed by a wrong capability', () => {
    const {client} = makeClient();
    const lease = acquireOrThrow(client);
    const forged = new MotorTestLease(identity());
    expect(forged.release()).toBe('NOT_OWNER');
    expect(client.releaseMotorTestLease(new MspMotorTestLeaseToken()).kind).toBe('NOT_OWNER');
    expect(client.releaseMotorTestLease('not-a-token').kind).toBe('NOT_OWNER');
    expect(lease.isActive()).toBe(true); // untouched
  });

  it('ABA: a stale capability cannot release the newer lease', () => {
    const {client} = makeClient();
    const older = acquireOrThrow(client);
    expect(older.release()).toBe('RELEASED');
    const newer = acquireOrThrow(client);

    expect(older.release()).toBe('ALREADY_RELEASED');
    // The decisive assertion: the newer lease is still held.
    expect(newer.isActive()).toBe(true);
    expect(client.isMotorTestLeaseHeld()).toBe(true);
  });

  it('fails closed while a lease-scoped request is active', async () => {
    const {transport, client} = makeClient();
    const lease = acquireOrThrow(client);
    const promise = lease.request(HARMLESS_COMMAND, EMPTY, {wireFormat: 'v1'});
    expect(transport.writes).toHaveLength(1);

    expect(lease.release()).toBe('LEASE_WORK_UNSETTLED');
    expect(lease.isActive()).toBe(true);
    // The in-flight request was neither cancelled nor discarded.
    transport.resolveNextWrite();
    transport.emitData(responseFrame(HARMLESS_COMMAND));
    expect((await promise).command).toBe(HARMLESS_COMMAND);
  });

  it('fails closed while lease-scoped work is queued', async () => {
    const {transport, client} = makeClient();
    const lease = acquireOrThrow(client);
    const first = lease.request(HARMLESS_COMMAND, EMPTY, {wireFormat: 'v1'});
    const second = lease.request(HARMLESS_COMMAND + 1, EMPTY, {wireFormat: 'v1'});

    expect(lease.release()).toBe('LEASE_WORK_UNSETTLED');

    transport.resolveNextWrite();
    transport.emitData(responseFrame(HARMLESS_COMMAND));
    await first;
    transport.resolveNextWrite();
    transport.emitData(responseFrame(HARMLESS_COMMAND + 1));
    await second;
  });

  it('keeps ordinary admission blocked after a failed release', async () => {
    const {transport, client} = makeClient();
    const lease = acquireOrThrow(client);
    const inFlight = lease.request(HARMLESS_COMMAND, EMPTY, {wireFormat: 'v1'});
    expect(lease.release()).toBe('LEASE_WORK_UNSETTLED');

    await expect(client.request(HARMLESS_COMMAND + 5, EMPTY, {wireFormat: 'v1'})).rejects.toMatchObject(
      {code: 'MSP_MOTOR_TEST_LEASE_HELD'},
    );
    expect(transport.writes).toHaveLength(1); // only the lease's own write

    transport.resolveNextWrite();
    transport.emitData(responseFrame(HARMLESS_COMMAND));
    await inFlight;
  });

  it('restores ordinary request behaviour after a valid release', async () => {
    const {transport, client} = makeClient();
    const lease = acquireOrThrow(client);
    expect(lease.release()).toBe('RELEASED');

    const promise = client.request(HARMLESS_COMMAND, EMPTY, {wireFormat: 'v1'});
    expect(transport.writes).toHaveLength(1);
    transport.resolveNextWrite();
    transport.emitData(responseFrame(HARMLESS_COMMAND));
    expect((await promise).command).toBe(HARMLESS_COMMAND);
  });

  it('returns a completely fresh capability on reacquisition', () => {
    const {client} = makeClient();
    const first = acquireOrThrow(client);
    expect(first.release()).toBe('RELEASED');
    const second = acquireOrThrow(client);
    expect(second).not.toBe(first);
    expect(first.isActive()).toBe(false);
    expect(second.isActive()).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 12.4 Invalidation and fault latching
 * ------------------------------------------------------------------ */

describe('invalidation and fault latching', () => {
  it('session close invalidates the lease', () => {
    const {client} = makeClient();
    const lease = acquireOrThrow(client);
    client.dispose();
    expect(lease.isActive()).toBe(false);
    expect(client.isMotorTestLeaseHeld()).toBe(false);
  });

  it('physical detach invalidates the lease', () => {
    const {transport, client} = makeClient();
    const lease = acquireOrThrow(client);
    transport.emitSessionDetached(SESSION_ID);
    expect(lease.isActive()).toBe(false);
    expect(client.getState()).toBe('DISCONNECTED');
  });

  it('desynchronization invalidates the lease and bumps the epoch', async () => {
    const {transport, client} = makeClient();
    const lease = acquireOrThrow(client);
    await desynchronizeViaLease(transport, lease);
    expect(lease.isActive()).toBe(false);
    expect(client.getEpoch()).toBe(1);
  });

  it('an mspEpoch change means the old identity can never be leased again', async () => {
    const {transport, client} = makeClient();
    const lease = acquireOrThrow(client, 0);
    await desynchronizeViaLease(transport, lease);
    // The pre-desync identity is simply not this client's identity now.
    expectNotAcquired(
      acquire(client, identity(2, 0), identity(2, 0)),
      'REQUESTED_SESSION_IDENTITY_MISMATCH',
    );
  });

  it('a physicalGeneration change means a different client entirely, and the old capability is dead', () => {
    // A new physical generation constructs a NEW MspClient and disposes
    // the old one, so a capability can never straddle generations.
    const oldSession = makeClient();
    const lease = acquireOrThrow(oldSession.client);
    oldSession.client.dispose();

    const newSession = makeClient();
    expect(lease.isActive()).toBe(false);
    expect(newSession.client.isMotorTestLeaseToken(lease)).toBe(false);
    const fresh = acquireMotorTestLease({
      client: newSession.client,
      requestedIdentity: identity(3, 0),
      readCurrentIdentity: () => identity(3, 0),
    });
    expect(fresh.kind).toBe('ACQUIRED');
  });

  it('a write failure invalidates the lease', async () => {
    const {transport, client} = makeClient();
    const lease = acquireOrThrow(client);
    const promise = lease.request(HARMLESS_COMMAND, EMPTY, {wireFormat: 'v1'});
    transport.rejectNextWrite('WRITE_FAILED');
    await expect(promise).rejects.toBeDefined();
    expect(lease.isActive()).toBe(false);
  });

  it('a response timeout invalidates the lease', async () => {
    jest.useFakeTimers();
    try {
      const {transport, client} = makeClient();
      const lease = acquireOrThrow(client);
      const promise = lease.request(HARMLESS_COMMAND, EMPTY, {
        wireFormat: 'v1',
        responseTimeoutMs: 30,
      });
      transport.resolveNextWrite();
      await flushMicrotasks();
      jest.advanceTimersByTime(31);
      await expect(promise).rejects.toMatchObject({code: 'MSP_TIMEOUT'});
      expect(lease.isActive()).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('any failed lease-scoped request invalidates the lease', async () => {
    const {transport, client} = makeClient();
    const lease = acquireOrThrow(client);
    const promise = lease.request(HARMLESS_COMMAND, EMPTY, {wireFormat: 'v1'});
    transport.resolveNextWrite();
    await flushMicrotasks();
    // An ERROR-direction frame is a failed request in the current code.
    transport.emitData(
      buildMspFrameBytes(HARMLESS_COMMAND, EMPTY, {wireFormat: 'v1', direction: 'error'}),
    );
    await expect(promise).rejects.toMatchObject({code: 'MSP_REMOTE_ERROR'});
    expect(lease.isActive()).toBe(false);
  });

  it('a recovery probe returning the client to READY never revives the capability', async () => {
    const {transport, client} = makeClient();
    const lease = acquireOrThrow(client);
    await desynchronizeViaLease(transport, lease);
    // Let recovery run its full course.
    await driveRecoveryToCompletion(transport);
    // Whatever state recovery reached, the dead capability stays dead.
    expect(lease.isActive()).toBe(false);
    expect(client.isMotorTestLeaseHeld()).toBe(false);
  });

  it('a fault latch prevents reacquisition for the same composite identity', async () => {
    const {transport, client} = makeClient();
    const lease = acquireOrThrow(client, 0);
    const promise = lease.request(HARMLESS_COMMAND, EMPTY, {wireFormat: 'v1'});
    transport.resolveNextWrite();
    await flushMicrotasks();
    transport.emitData(
      buildMspFrameBytes(HARMLESS_COMMAND, EMPTY, {wireFormat: 'v1', direction: 'error'}),
    );
    await expect(promise).rejects.toBeDefined();
    // Same identity, client back to READY and idle - still refused.
    expect(client.getState()).toBe('READY');
    expect(client.getEpoch()).toBe(0);
    expectNotAcquired(acquire(client, identity(2, 0), identity(2, 0)), 'MOTOR_TEST_LEASE_FAULT_LATCHED');
  });

  it('a genuinely new session identity clears the old fault boundary', async () => {
    const {transport, client} = makeClient();
    const lease = acquireOrThrow(client, 0);
    // A desync-driven failure faults epoch 0 and bumps the epoch to 1.
    await desynchronizeViaLease(transport, lease);
    await driveRecoveryToCompletion(transport);
    const newEpoch = client.getEpoch();
    expect(newEpoch).toBe(1);
    if (client.getState() === 'READY') {
      const again = acquire(client, identity(2, newEpoch), identity(2, newEpoch));
      // The new identity is NOT fault-latched: whatever refusal occurs, it
      // is never the latch.
      if (again.kind === 'NOT_ACQUIRED') {
        expect(again.reason).not.toBe('MOTOR_TEST_LEASE_FAULT_LATCHED');
      } else {
        expect(again.lease.isActive()).toBe(true);
      }
    }
  });

  it('a normal idle release never creates a fault latch', () => {
    const {client} = makeClient();
    const lease = acquireOrThrow(client);
    expect(lease.release()).toBe('RELEASED');
    expect(acquire(client).kind).toBe('ACQUIRED');
  });

  it('failClosed() lets the exact active capability fault itself after a SEMANTIC failure', () => {
    // Pass 3 needs this: an exchange that succeeded at the transport
    // level but whose ANSWER was unacceptable rejects no request, so the
    // automatic fault route never fires.
    const {client} = makeClient();
    const lease = acquireOrThrow(client, 0);
    expect(lease.failClosed()).toBe(true);
    expect(lease.isActive()).toBe(false);
    expect(client.isMotorTestLeaseHeld()).toBe(false);
  });

  it('failClosed() latches the exact composite identity through the canonical latch', () => {
    const {client} = makeClient();
    const lease = acquireOrThrow(client, 0);
    expect(lease.failClosed()).toBe(true);
    // Same identity, client still READY and idle - still refused, by the
    // SAME Pass 2 latch. No second fault manager exists.
    expect(client.getState()).toBe('READY');
    expect(client.getEpoch()).toBe(0);
    expectNotAcquired(acquire(client, identity(2, 0), identity(2, 0)), 'MOTOR_TEST_LEASE_FAULT_LATCHED');
  });

  it('failClosed() is idempotent and returns false once the capability is dead', () => {
    const {client} = makeClient();
    const lease = acquireOrThrow(client, 0);
    expect(lease.failClosed()).toBe(true);
    expect(lease.failClosed()).toBe(false);
    expect(lease.failClosed()).toBe(false);
  });

  it('failClosed() cannot be used by a forged, released or stale capability', () => {
    const {client} = makeClient();
    const forged = new MotorTestLease(identity());
    expect(forged.failClosed()).toBe(false);

    const older = acquireOrThrow(client, 0);
    expect(older.release()).toBe('RELEASED');
    expect(older.failClosed()).toBe(false);

    const newer = acquireOrThrow(client, 0);
    // The decisive assertion: a stale capability cannot fault the newer
    // lease.
    expect(older.failClosed()).toBe(false);
    expect(newer.isActive()).toBe(true);
    expect(client.isMotorTestLeaseHeld()).toBe(true);
  });

  it('failClosed() cannot fault another client', () => {
    const first = makeClient();
    const second = makeClient();
    const leaseOnFirst = acquireOrThrow(first.client, 0);
    const leaseOnSecond = acquireOrThrow(second.client, 0);
    expect(leaseOnFirst.failClosed()).toBe(true);
    // The other client's lease is untouched.
    expect(leaseOnSecond.isActive()).toBe(true);
    expect(second.client.isMotorTestLeaseHeld()).toBe(true);
  });

  it('a raw forged token cannot fault the lease at the client boundary', () => {
    const {client} = makeClient();
    const lease = acquireOrThrow(client, 0);
    expect(client.faultMotorTestLeaseByToken(new MspMotorTestLeaseToken())).toBe(false);
    expect(client.faultMotorTestLeaseByToken('not-a-token')).toBe(false);
    expect(client.faultMotorTestLeaseByToken(undefined)).toBe(false);
    expect(lease.isActive()).toBe(true);
  });

  it('officialSessionAuthority() is the SAME object across leases in one session', () => {
    // Pass 3 correction A depends on this: a "once per official session"
    // rule must survive an ordinary release-and-reacquire.
    const {client} = makeClient();
    const leaseA = acquireOrThrow(client, 0);
    const authorityA = leaseA.officialSessionAuthority();
    expect(authorityA).toBeDefined();
    expect(leaseA.release()).toBe('RELEASED');

    const leaseB = acquireOrThrow(client, 0);
    expect(leaseB.officialSessionAuthority()).toBe(authorityA);
  });

  it('officialSessionAuthority() differs after an epoch rotation', async () => {
    const {transport, client} = makeClient();
    const leaseA = acquireOrThrow(client, 0);
    const authorityA = leaseA.officialSessionAuthority();
    await desynchronizeViaLease(transport, leaseA);
    await driveRecoveryToCompletion(transport);
    expect(client.getEpoch()).toBe(1);
    // HARD assertion, never a conditional skip: driveRecoveryToCompletion
    // resolves the reader restart and answers the probe (MSP_PROBE_COMMAND
    // === 1, which is what responseFrame(1) replies to), so recovery
    // reaching READY is a deterministic property of this fixture. If it
    // ever stops holding, this test must FAIL rather than silently pass
    // without exercising the rotation it exists to prove.
    expect(client.getState()).toBe('READY');
    const leaseB = acquireOrThrow(client, 1);
    expect(leaseB.officialSessionAuthority()).not.toBe(authorityA);
  });

  it('officialSessionAuthority() differs across clients', () => {
    const first = makeClient();
    const second = makeClient();
    const a = acquireOrThrow(first.client, 0).officialSessionAuthority();
    const b = acquireOrThrow(second.client, 0).officialSessionAuthority();
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
  });

  it('officialSessionAuthority() is undefined for a dead or forged capability', () => {
    const {client} = makeClient();
    expect(new MotorTestLease(identity()).officialSessionAuthority()).toBeUndefined();

    const lease = acquireOrThrow(client, 0);
    expect(lease.officialSessionAuthority()).toBeDefined();
    expect(lease.release()).toBe('RELEASED');
    expect(lease.officialSessionAuthority()).toBeUndefined();

    const faulted = acquireOrThrow(client, 0);
    expect(faulted.failClosed()).toBe(true);
    expect(faulted.officialSessionAuthority()).toBeUndefined();
  });

  it('the authority object exposes no client, transport, token or write capability', () => {
    const {client} = makeClient();
    const authority = acquireOrThrow(client, 0).officialSessionAuthority();
    expect(authority).toBeDefined();
    const names = [
      ...Object.keys(authority as object),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(authority) as object).filter(
        name => name !== 'constructor',
      ),
    ];
    // The ONLY member is the inert nominal marker, which is always
    // undefined and is never read - TypeScript's `private` is
    // compile-time only, so it does exist as an own key at runtime. There
    // is no method of any kind, and no capability to reach.
    expect(names).toEqual(['brand']);
    expect((authority as unknown as Record<string, unknown>).brand).toBeUndefined();
    for (const forbidden of ['client', 'transport', 'writeBytes', 'token', 'request', 'lease']) {
      expect(names).not.toContain(forbidden);
    }
    // Carries no serializable data at all.
    expect(JSON.stringify(authority)).toBe('{}');
  });

  it('an old release cannot affect a new session lease', () => {
    const oldSession = makeClient();
    const oldLease = acquireOrThrow(oldSession.client);
    oldSession.client.dispose();

    const newSession = makeClient();
    const newLease = acquireOrThrow(newSession.client);
    expect(oldLease.release()).toBe('INVALIDATED');
    expect(newLease.isActive()).toBe(true);
    expect(newSession.client.isMotorTestLeaseHeld()).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 12.5 Immutability and ownership
 * ------------------------------------------------------------------ */

describe('immutability and ownership', () => {
  it('does not retain the caller identity object by reference', () => {
    const {client} = makeClient();
    const caller = {physicalGeneration: 2, mspEpoch: 0};
    const result = acquireMotorTestLease({
      client,
      requestedIdentity: caller,
      readCurrentIdentity: () => caller,
    });
    if (result.kind !== 'ACQUIRED') {
      throw new Error('unreachable');
    }
    expect(result.lease.sessionIdentity).not.toBe(caller);
    caller.physicalGeneration = 99;
    expect(result.lease.sessionIdentity).toEqual({physicalGeneration: 2, mspEpoch: 0});
  });

  it('does not mutate its inputs', () => {
    const {client} = makeClient();
    const caller = {physicalGeneration: 2, mspEpoch: 0};
    const snapshot = JSON.stringify(caller);
    acquireMotorTestLease({
      client,
      requestedIdentity: caller,
      readCurrentIdentity: () => caller,
    });
    expect(JSON.stringify(caller)).toBe(snapshot);
  });

  it('freezes the identity snapshot and the capability surface', () => {
    const {client} = makeClient();
    const lease = acquireOrThrow(client);
    expect(Object.isFrozen(lease)).toBe(true);
    expect(Object.isFrozen(lease.sessionIdentity)).toBe(true);

    const mutable = lease.sessionIdentity as {physicalGeneration: number};
    try {
      mutable.physicalGeneration = 42;
    } catch {
      // Strict mode throws, sloppy mode ignores - either is acceptable.
    }
    expect(lease.sessionIdentity.physicalGeneration).toBe(2);
  });

  it('exposes no raw transport and no writeBytes anywhere on the capability', () => {
    const {client} = makeClient();
    const lease = acquireOrThrow(client);
    const names = new Set<string>([
      ...Object.keys(lease),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(lease) as object),
    ]);
    // Exact names, not substrings: isActive() legitimately contains
    // "active" and must not be flagged.
    for (const forbidden of [
      'transport',
      'writeBytes',
      'client',
      'token',
      'queue',
      'active',
      'startReading',
      'dispose',
    ]) {
      expect(names.has(forbidden)).toBe(false);
    }
    const asRecord = lease as unknown as Record<string, unknown>;
    expect(asRecord.writeBytes).toBeUndefined();
    expect(asRecord.transport).toBeUndefined();
    expect(asRecord.client).toBeUndefined();
    expect(asRecord.token).toBeUndefined();
  });

  it('never lets a caller-selected token grant authority', async () => {
    const {transport, client} = makeClient();
    acquireOrThrow(client);
    for (const guess of ['lease', 0, 1, true, {}, [], null, undefined, 'MOTOR_TEST_LEASE']) {
      await expect(
        client.requestWithMotorTestLease(guess, HARMLESS_COMMAND, EMPTY, {wireFormat: 'v1'}),
      ).rejects.toMatchObject({code: 'MSP_MOTOR_TEST_LEASE_CAPABILITY_INVALID'});
    }
    expect(transport.writes).toHaveLength(0);
  });

  it('cannot hold two leases through two wrappers over the same client', () => {
    const {client} = makeClient();
    const first = acquire(client);
    const second = acquire(client);
    const third = acquire(client);
    const acquired = [first, second, third].filter(result => result.kind === 'ACQUIRED');
    expect(acquired).toHaveLength(1);
  });

  it('keeps the ownership token out of every serializable view', () => {
    const {client} = makeClient();
    const lease = acquireOrThrow(client);
    const serialized = JSON.stringify(lease);
    expect(JSON.parse(serialized)).toEqual({
      leaseKind: 'MOTOR_TEST_LEASE',
      sessionIdentity: {physicalGeneration: 2, mspEpoch: 0},
    });
  });
});

/* ------------------------------------------------------------------ *
 * 12.6 Semantic exclusions
 * ------------------------------------------------------------------ */

describe('semantic exclusions', () => {
  const AUTHORIZATION_VOCABULARY =
    /^(is)?(safe|ready|authoriz|approved|allowed|permitted|permission|cantest|canpulse|canstart|go)$/i;

  function publicSurfaceNames(lease: MotorTestLease): string[] {
    return [
      ...Object.keys(lease),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(lease) as object),
    ].filter(name => name !== 'constructor');
  }

  it('exposes no field or method meaning safety, readiness or authorization', () => {
    const {client} = makeClient();
    const lease = acquireOrThrow(client);
    const offenders = publicSurfaceNames(lease).filter(name => AUTHORIZATION_VOCABULARY.test(name));
    expect(offenders).toEqual([]);
  });

  it('exposes exactly the documented public surface', () => {
    const {client} = makeClient();
    const lease = acquireOrThrow(client);
    expect(Object.keys(lease).sort()).toEqual(['leaseKind', 'sessionIdentity']);
    expect(publicSurfaceNames(lease).sort()).toEqual([
      // Phase 2G Pass 1 added emergencyStop() - SUBMISSION PRIORITY over
      // the client's own FIFO, and nothing else. It chooses no command,
      // encodes no payload, and is not an authorization: like request(),
      // the caller supplies both. It is the ONLY route to priority, and
      // it is reachable only from a live, non-forgeable capability.
      'emergencyStop',
      // Pass 3 added failClosed() - the capability-bound semantic-fault
      // operation. It is a way to DIE, never a way to be authorized.
      'failClosed',
      'isActive',
      'leaseKind',
      // Pass 3 correction A added officialSessionAuthority() - an
      // identity anchor with no data and no methods. It grants nothing.
      'officialSessionAuthority',
      'release',
      'request',
      'sessionIdentity',
    ]);
  });

  it('converts no evaluation result into permission', () => {
    const {client} = makeClient();
    const lease = acquireOrThrow(client);
    const serialized = JSON.stringify(lease);
    for (const forbidden of [
      'REQUIREMENTS_SATISFIED',
      'READY',
      'SAFE',
      'AUTHORIZED',
      'CAN_TEST',
      'CAN_PULSE',
      'PERMISSION',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('encodes no motor command and builds no motor vector or pulse', async () => {
    const {transport, client} = makeClient();
    const lease = acquireOrThrow(client);
    const promise = lease.request(HARMLESS_COMMAND, EMPTY, {wireFormat: 'v1'});
    expect(transport.writes).toHaveLength(1);
    // The command byte actually written is the harmless fixture - never
    // 214 (MSP_SET_MOTOR) and never 99 (MSP_SET_ARMING_DISABLED).
    const written = transport.writes[0].data;
    expect(written[4]).toBe(HARMLESS_COMMAND);
    expect(written[4]).not.toBe(214);
    expect(written[4]).not.toBe(99);
    // A four-motor payload is 8 bytes; nothing here carries a payload.
    expect(written[3]).toBe(0);

    transport.resolveNextWrite();
    transport.emitData(responseFrame(HARMLESS_COMMAND));
    await promise;
  });

  it('establishes no arming restriction', () => {
    const {client} = makeClient();
    const lease = acquireOrThrow(client);
    const surface = publicSurfaceNames(lease).join(',').toLowerCase();
    expect(surface).not.toContain('arming');
    expect(surface).not.toContain('disable');
    expect(surface).not.toContain('motorcommand');
  });

  it('uses no timer, clock, retry or automatic expiry', async () => {
    jest.useFakeTimers();
    try {
      const {transport, client} = makeClient();
      const lease = acquireOrThrow(client);
      // No request outstanding, so no MspClient timer is pending either.
      expect(jest.getTimerCount()).toBe(0);
      // A very long fake-time jump must not expire the lease.
      jest.advanceTimersByTime(60 * 60 * 1000);
      expect(lease.isActive()).toBe(true);
      expect(transport.writes).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('lease acquisition alone produces no transport traffic at all', () => {
    const {transport, client} = makeClient();
    const lease = acquireOrThrow(client);
    expect(transport.writes).toHaveLength(0);
    expect(transport.restarts).toHaveLength(0);
    expect(lease.release()).toBe('RELEASED');
    expect(transport.writes).toHaveLength(0);
  });
});

/* ======================================================================
 * Phase 2G Pass 1 - emergencyStop() as the ONLY route to priority.
 *
 * Submission order only. Nothing here claims on-wire preemption, a
 * latency bound behind an in-flight write, or that a motor stopped.
 * ====================================================================== */
describe('MotorTestLease - Phase 2G emergency stop', () => {
  /** Command byte of a v1 request frame: `$` `M` `<` len cmd ... */
  function writtenCommands(transport: FakeMspTransport): number[] {
    return transport.writeLog.map(bytes => bytes[4]);
  }

  it('routes the stop through the exact live token, ahead of the lease’s own queued work', async () => {
    const {transport, client} = makeClient();
    const lease = acquireOrThrow(client);

    lease.request(HARMLESS_COMMAND, EMPTY, {wireFormat: 'v1'}).catch(() => {});
    const queued = lease.request(HARMLESS_COMMAND + 1, EMPTY, {wireFormat: 'v1'});
    queued.catch(() => {});
    expect(writtenCommands(transport)).toEqual([HARMLESS_COMMAND]);

    // Deliberately the SAME harmless fixture command, not 214: this pass
    // constructs no motor command anywhere, and the lease chooses none.
    const dispatch = lease.emergencyStop(HARMLESS_COMMAND + 2, EMPTY, {wireFormat: 'v1'});
    expect(dispatch.deferredBehindActiveWrite).toBe(true);
    expect(dispatch.attributionAmbiguous).toBe(false);

    await expect(queued).rejects.toMatchObject({
      code: 'MSP_DISPLACED_BY_EMERGENCY_STOP',
      writeAttempted: false,
    });

    transport.resolveNextWrite();
    await flushMicrotasks();
    // The stop is the next submission; the purged request never reached
    // the transport at all.
    expect(writtenCommands(transport)).toEqual([HARMLESS_COMMAND, HARMLESS_COMMAND + 2]);

    transport.resolveNextWrite();
    transport.emitData(responseFrame(HARMLESS_COMMAND + 2));
    await expect(dispatch.frame).resolves.toMatchObject({command: HARMLESS_COMMAND + 2});
  });

  it('gives a forged or reconstructed capability a rejected dispatch, never a write and never a silent no-op', async () => {
    const {transport, client} = makeClient();
    const lease = acquireOrThrow(client);

    const forged = JSON.parse(JSON.stringify(lease)) as MotorTestLease;
    expect(typeof (forged as {emergencyStop?: unknown}).emergencyStop).toBe('undefined');

    // Even borrowing the real prototype method cannot help: the token
    // lives in a module-private WeakMap keyed by the genuine instance.
    const borrowed = Object.create(Object.getPrototypeOf(lease)) as MotorTestLease;
    const dispatch = borrowed.emergencyStop(HARMLESS_COMMAND, EMPTY, {wireFormat: 'v1'});
    await expect(dispatch.frame).rejects.toThrow(/not a genuine lease/);
    expect(transport.writeLog).toHaveLength(0);
    expect(lease.isActive()).toBe(true);
  });

  it('refuses a stop from a released capability, so a stale lease can never preempt a newer one', async () => {
    const {transport, client} = makeClient();
    const stale = acquireOrThrow(client);
    expect(stale.release()).toBe('RELEASED');
    const current = acquireOrThrow(client);

    const dispatch = stale.emergencyStop(HARMLESS_COMMAND, EMPTY, {wireFormat: 'v1'});
    await expect(dispatch.frame).rejects.toMatchObject({
      code: 'MSP_MOTOR_TEST_LEASE_CAPABILITY_INVALID',
    });
    expect(transport.writeLog).toHaveLength(0);
    expect(current.isActive()).toBe(true);
  });

  it('a stop aborted by desync leaves the identity it ran under unusable, requiring a genuinely new session identity', async () => {
    const {transport, client} = makeClient();
    const lease = acquireOrThrow(client, 0);

    lease.request(HARMLESS_COMMAND, EMPTY, {wireFormat: 'v1'}).catch(() => {});
    const dispatch = lease.emergencyStop(HARMLESS_COMMAND + 1, EMPTY, {wireFormat: 'v1'});

    // Ambiguous write outcome: the client desynchronizes before the stop
    // could ever be submitted.
    transport.rejectNextWrite('WRITE_TIMEOUT');
    await expect(dispatch.frame).rejects.toMatchObject({
      code: 'MSP_EMERGENCY_STOP_ABORTED_BY_DESYNC',
    });
    // It REJECTED. A stop that was never written must never resolve.
    expect(writtenCommands(transport)).toEqual([HARMLESS_COMMAND]);
    expect(lease.isActive()).toBe(false);

    // Drive recovery to completion - the link is fully healthy again.
    transport.resolveNextRestart();
    await flushMicrotasks();
    transport.resolveNextWrite();
    transport.emitData(responseFrame(1)); // MSP_PROBE_COMMAND
    await flushMicrotasks();
    expect(client.getState()).toBe('READY');

    // A healthy link is NOT permission to retry. The identity the stop
    // died under (epoch 0) is refused; only the genuinely new identity
    // the desync produced can host another attempt.
    expectNotAcquired(
      acquire(client, identity(2, 0), identity(2, 0)),
      'REQUESTED_SESSION_IDENTITY_MISMATCH',
    );
    expect(acquire(client, identity(2, 1), identity(2, 1)).kind).toBe('ACQUIRED');
  });

  it('grants no authorization: the dispatch carries only displacement facts and never a safety verdict', () => {
    const {transport, client} = makeClient();
    const lease = acquireOrThrow(client);
    const dispatch = lease.emergencyStop(HARMLESS_COMMAND, EMPTY, {wireFormat: 'v1'});

    expect(Object.keys(dispatch).sort()).toEqual([
      'attributionAmbiguous',
      'deferredBehindActiveWrite',
      'frame',
      'joinedExistingStop',
    ]);
    // No field asserts safety, readiness, authorization or - above all -
    // that anything physically stopped.
    for (const forbidden of [
      'safe',
      'ready',
      'authorized',
      'approved',
      'allowed',
      'permission',
      'canTest',
      'canPulse',
      'canStart',
      'stopped',
      'physicalStopConfirmed',
      'motorsStopped',
      'preempted',
    ]) {
      expect(forbidden in dispatch).toBe(false);
    }
    expect(Object.isFrozen(dispatch)).toBe(true);
    // Settled explicitly rather than left to time out, so this test uses
    // no real clock at all.
    transport.resolveNextWrite();
    transport.emitData(responseFrame(HARMLESS_COMMAND));
    return dispatch.frame;
  });
});
