/**
 * Pass 3 correction B - tests for session-bound Box IDs evidence.
 *
 * NO HARDWARE OF ANY KIND: no flight controller, no USB, no serial
 * session, no ESC, no motor, no LiPo, no emulator, no device. The
 * transport is the repository's existing FakeMspTransport.
 *
 * A SNAPSHOT IS EVIDENCE, NOT AUTHORIZATION. It proves only which BOXARM
 * bit position this session reported; it permits nothing.
 */

import {
  acquireMotorTestBoxIds,
  motorTestBoxIdsAuthorityOf,
  MotorTestBoxIdsSnapshot,
} from './motorTestBoxIds';
import {MspClient} from '../protocol/mspClient';
import {
  acquireMotorTestLease,
  MotorTestLease,
  type MspSessionCompositeIdentity,
} from '../protocol/motorTestLease';
import {MSP_BOXIDS} from '../protocol/msp/commands/mspCommands';
import {FakeMspTransport} from '../protocol/__testUtils__/mspFakeTransport';
import {buildMspFrameBytes} from '../protocol/__testUtils__/mspFixtures';

const SESSION_ID = 'session-boxids-1';
const EMPTY = new Uint8Array(0);
const WIRE = Uint8Array.from([5, 1, 0, 13]);

function identity(physicalGeneration = 2, mspEpoch = 0): MspSessionCompositeIdentity {
  return {physicalGeneration, mspEpoch};
}

function makeClient() {
  const transport = new FakeMspTransport();
  const client = new MspClient(transport, SESSION_ID);
  return {transport, client};
}

function leaseFor(client: MspClient, epoch = 0): MotorTestLease {
  const result = acquireMotorTestLease({
    client,
    requestedIdentity: identity(2, epoch),
    readCurrentIdentity: () => identity(2, epoch),
  });
  if (result.kind !== 'ACQUIRED') {
    throw new Error(`expected ACQUIRED, got ${result.reason}`);
  }
  return result.lease;
}

function responseFrame(command: number, payload: Uint8Array = EMPTY): Uint8Array {
  return buildMspFrameBytes(command, payload, {wireFormat: 'v1', direction: 'response'});
}

async function flushMicrotasks(times = 8): Promise<void> {
  for (let index = 0; index < times; index++) {
    await Promise.resolve();
  }
}

describe('acquireMotorTestBoxIds', () => {
  it('reads MSP_BOXIDS through the lease and mints a snapshot', async () => {
    const {transport, client} = makeClient();
    const lease = leaseFor(client);
    const pending = acquireMotorTestBoxIds(lease);
    await flushMicrotasks();
    expect(transport.writes).toHaveLength(1);
    expect(transport.writes[0].data[4]).toBe(MSP_BOXIDS);
    expect(transport.writes[0].data[3]).toBe(0); // empty payload

    transport.resolveNextWrite();
    await flushMicrotasks();
    transport.emitData(responseFrame(MSP_BOXIDS, WIRE));
    const result = await pending;

    expect(result.kind).toBe('ACQUIRED');
    if (result.kind !== 'ACQUIRED') {
      throw new Error('unreachable');
    }
    expect(result.snapshot.permanentIds).toEqual([5, 1, 0, 13]);
    expect(result.snapshot.snapshotKind).toBe('MOTOR_TEST_BOX_IDS_SNAPSHOT');
  });

  it('never sends a write command - only MSP_BOXIDS', async () => {
    const {transport, client} = makeClient();
    const lease = leaseFor(client);
    const pending = acquireMotorTestBoxIds(lease);
    await flushMicrotasks();
    for (const write of transport.writes) {
      expect(write.data[4]).toBe(MSP_BOXIDS);
      expect(write.data[4]).not.toBe(99);
      expect(write.data[4]).not.toBe(214);
    }
    transport.resolveNextWrite();
    await flushMicrotasks();
    transport.emitData(responseFrame(MSP_BOXIDS, WIRE));
    await pending;
  });

  it('refuses with no lease and sends nothing', async () => {
    const {transport} = makeClient();
    const result = await acquireMotorTestBoxIds(undefined);
    expect(result).toEqual({kind: 'NOT_ACQUIRED', reason: 'MOTOR_TEST_LEASE_INACTIVE'});
    expect(transport.writes).toHaveLength(0);
  });

  it('refuses on a released lease and sends nothing', async () => {
    const {transport, client} = makeClient();
    const lease = leaseFor(client);
    expect(lease.release()).toBe('RELEASED');
    const result = await acquireMotorTestBoxIds(lease);
    expect(result).toEqual({kind: 'NOT_ACQUIRED', reason: 'MOTOR_TEST_LEASE_INACTIVE'});
    expect(transport.writes).toHaveLength(0);
  });

  it('refuses on a forged lease and sends nothing', async () => {
    const {transport} = makeClient();
    const result = await acquireMotorTestBoxIds(new MotorTestLease(identity()));
    expect(result).toEqual({kind: 'NOT_ACQUIRED', reason: 'MOTOR_TEST_LEASE_INACTIVE'});
    expect(transport.writes).toHaveLength(0);
  });

  it('reports a request failure without retrying', async () => {
    const {transport, client} = makeClient();
    const lease = leaseFor(client);
    const pending = acquireMotorTestBoxIds(lease);
    await flushMicrotasks();
    transport.rejectNextWrite('WRITE_FAILED');
    const result = await pending;
    expect(result).toEqual({kind: 'NOT_ACQUIRED', reason: 'BOX_IDS_REQUEST_FAILED'});
    await flushMicrotasks();
    // No second attempt was issued for the mapping itself.
    const boxIdWrites = transport.writes.filter(write => write.data[4] === MSP_BOXIDS);
    expect(boxIdWrites).toHaveLength(0);
  });

  it('rejects an empty reply as malformed', async () => {
    const {transport, client} = makeClient();
    const lease = leaseFor(client);
    const pending = acquireMotorTestBoxIds(lease);
    await flushMicrotasks();
    transport.resolveNextWrite();
    await flushMicrotasks();
    transport.emitData(responseFrame(MSP_BOXIDS, EMPTY));
    expect(await pending).toEqual({kind: 'NOT_ACQUIRED', reason: 'BOX_IDS_MALFORMED'});
  });

  it('does not mint when the session rotated while the read was in flight', async () => {
    const {transport, client} = makeClient();
    const lease = leaseFor(client);
    const pending = acquireMotorTestBoxIds(lease);
    await flushMicrotasks();
    // Killing the client mid-flight ends the official session.
    transport.resolveNextWrite();
    await flushMicrotasks();
    client.dispose();
    const result = await pending;
    expect(result.kind).toBe('NOT_ACQUIRED');
  });
});

describe('snapshot immutability and provenance', () => {
  async function mint(transport: FakeMspTransport, lease: MotorTestLease, wire = WIRE) {
    const pending = acquireMotorTestBoxIds(lease);
    await flushMicrotasks();
    transport.resolveNextWrite();
    await flushMicrotasks();
    transport.emitData(responseFrame(MSP_BOXIDS, wire));
    const result = await pending;
    if (result.kind !== 'ACQUIRED') {
      throw new Error(`expected ACQUIRED, got ${result.reason}`);
    }
    return result.snapshot;
  }

  it('freezes the snapshot and its id array', async () => {
    const {transport, client} = makeClient();
    const snapshot = await mint(transport, leaseFor(client));
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.permanentIds)).toBe(true);
  });

  it('copies the decoded ids so wire-buffer mutation cannot reach it', async () => {
    const {transport, client} = makeClient();
    const wire = Uint8Array.from([5, 1, 0, 13]);
    const snapshot = await mint(transport, leaseFor(client), wire);
    wire[2] = 42;
    expect(snapshot.permanentIds).toEqual([5, 1, 0, 13]);
  });

  it('registers authority only for genuinely minted snapshots', async () => {
    const {transport, client} = makeClient();
    const snapshot = await mint(transport, leaseFor(client));
    expect(motorTestBoxIdsAuthorityOf(snapshot)).toBeDefined();

    // Every forgery route yields undefined.
    expect(motorTestBoxIdsAuthorityOf({...snapshot})).toBeUndefined();
    expect(motorTestBoxIdsAuthorityOf(JSON.parse(JSON.stringify(snapshot)))).toBeUndefined();
    expect(motorTestBoxIdsAuthorityOf(new MotorTestBoxIdsSnapshot([5, 1, 0, 13]))).toBeUndefined();
    expect(
      motorTestBoxIdsAuthorityOf({
        snapshotKind: 'MOTOR_TEST_BOX_IDS_SNAPSHOT',
        permanentIds: [5, 1, 0, 13],
      }),
    ).toBeUndefined();
    expect(motorTestBoxIdsAuthorityOf(undefined)).toBeUndefined();
    expect(motorTestBoxIdsAuthorityOf('snapshot')).toBeUndefined();
  });

  it('binds two snapshots from the same session to the SAME authority', async () => {
    const {transport, client} = makeClient();
    const leaseA = leaseFor(client);
    const first = await mint(transport, leaseA);
    expect(leaseA.release()).toBe('RELEASED');
    const leaseB = leaseFor(client);
    const second = await mint(transport, leaseB);
    expect(motorTestBoxIdsAuthorityOf(first)).toBe(motorTestBoxIdsAuthorityOf(second));
  });

  it('binds snapshots from different clients to DIFFERENT authorities', async () => {
    const a = makeClient();
    const b = makeClient();
    const first = await mint(a.transport, leaseFor(a.client));
    const second = await mint(b.transport, leaseFor(b.client));
    expect(motorTestBoxIdsAuthorityOf(first)).not.toBe(motorTestBoxIdsAuthorityOf(second));
  });

  it('exposes no requester, client, transport, token or write capability', async () => {
    const {transport, client} = makeClient();
    const snapshot = await mint(transport, leaseFor(client));
    const names = new Set<string>([
      ...Object.keys(snapshot),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(snapshot) as object).filter(
        name => name !== 'constructor',
      ),
    ]);
    expect(Array.from(names).sort()).toEqual(['permanentIds', 'snapshotKind']);
    for (const forbidden of ['request', 'lease', 'client', 'transport', 'writeBytes', 'token']) {
      expect(names.has(forbidden)).toBe(false);
    }
  });

  it('exposes no authorization vocabulary', async () => {
    const {transport, client} = makeClient();
    const snapshot = await mint(transport, leaseFor(client));
    const vocabulary =
      /^(is)?(safe|ready|authoriz|approved|allowed|permitted|permission|cantest|canpulse|canstart|go)$/i;
    for (const name of Object.keys(snapshot)) {
      expect(vocabulary.test(name)).toBe(false);
    }
  });
});
