/**
 * Pass 3 - tests for the session-bound MSP arming restriction.
 *
 * NO HARDWARE OF ANY KIND is required, referenced or simulated: no flight
 * controller, no USB, no serial session, no ESC, no motor, no LiPo, no
 * emulator, no device. The transport is the repository's existing
 * FakeMspTransport and every frame is a hand-built byte array.
 *
 * A RECEIPT IS NOT MOTOR SAFETY OR AUTHORIZATION. These tests assert that
 * no such verdict exists on the public surface, that ACK alone never
 * produces one, and that no re-enable path exists.
 *
 * COMMAND 214 (MSP_SET_MOTOR) APPEARS IN NO FIXTURE - only as a forbidden
 * value in assertions.
 */

import {
  ARMING_DISABLE_COMMAND_BYTE,
  ARMING_DISABLED_MSP_BIT_INDEX,
  ARMING_ENABLE_COMMAND_BYTE,
  buildArmingDisablePayload,
  buildArmingReleasePayload,
  establishMotorArmingRestriction,
  MotorArmingRestrictionReceipt,
  MSP_SET_ARMING_DISABLED,
  MSP_STATUS_EX,
  recordMotorArmingRestrictionReleased,
  type MotorArmingRestrictionEstablishment,
} from './motorArmingRestriction';
import * as armingRestrictionModule from './motorArmingRestriction';
import {ARMING_DISABLE_FLAGS_COUNT} from './armingBlockers';
import {MspClient} from '../protocol/mspClient';
import {
  acquireMotorTestLease,
  MotorTestLease,
  type MspSessionCompositeIdentity,
} from '../protocol/motorTestLease';
import {acquireMotorTestBoxIds, MotorTestBoxIdsSnapshot} from './motorTestBoxIds';
import {MSP_BOXIDS} from '../protocol/msp/commands/mspCommands';
import {FakeMspTransport} from '../protocol/__testUtils__/mspFakeTransport';
import {buildMspFrameBytes} from '../protocol/__testUtils__/mspFixtures';

const SESSION_ID = 'session-arming-1';
const EMPTY = new Uint8Array(0);

/** BOXARM's permanent id is 0; placed at index 2 so a hardcoded bit-0
 * assumption would be caught. */
const BOX_ID_WIRE_BYTES = Uint8Array.from([5, 1, 0, 13]);
const ARM_BIT = 2;

/** Snapshots minted per lease, so the establishment helper can supply
 * genuine session-bound evidence without every call site threading it. */
const MINTED = new WeakMap<MotorTestLease, MotorTestBoxIdsSnapshot>();

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

function errorFrame(command: number): Uint8Array {
  return buildMspFrameBytes(command, EMPTY, {wireFormat: 'v1', direction: 'error'});
}

async function flushMicrotasks(times = 8): Promise<void> {
  for (let index = 0; index < times; index++) {
    await Promise.resolve();
  }
}

/** Arithmetic, never bitwise - a high bit must survive intact. */
function u16(value: number): number[] {
  return [value % 256, Math.floor(value / 256) % 256];
}

function u32(value: number): number[] {
  return [
    value % 256,
    Math.floor(value / 256) % 256,
    Math.floor(value / 65536) % 256,
    Math.floor(value / 16777216) % 256,
  ];
}

interface StatusFixture {
  readonly armed?: boolean;
  readonly mspRestrictionPresent?: boolean;
  readonly extraMask?: number;
  readonly truncateTo?: number;
  readonly declaredByteCount?: number;
}

/** MSP_STATUS_EX per msp.c:1094-1143 @ the pinned tag. */
function statusPayload(fixture: StatusFixture = {}): Uint8Array {
  const armedBits = fixture.armed === true ? Math.pow(2, ARM_BIT) : 0;
  const mspBit =
    fixture.mspRestrictionPresent === false ? 0 : Math.pow(2, ARMING_DISABLED_MSP_BIT_INDEX);
  const mask = mspBit + (fixture.extraMask ?? 0);
  const bytes = [
    ...u16(125),
    ...u16(0),
    ...u16(0x21),
    ...u32(armedBits),
    2,
    ...u16(15),
    // --- 13-byte fixed prefix ends ---
    4,
    1,
    fixture.declaredByteCount ?? 0,
    ARMING_DISABLE_FLAGS_COUNT,
    ...u32(mask),
    0,
    ...u16(3400),
    6,
  ];
  const all = Uint8Array.from(bytes);
  return fixture.truncateTo === undefined ? all : all.subarray(0, fixture.truncateTo);
}

interface RunOptions {
  readonly status?: StatusFixture;
  readonly boxIds?: MotorTestBoxIdsSnapshot | undefined;
  readonly currentIdentity?: MspSessionCompositeIdentity | undefined;
  readonly requestedIdentity?: MspSessionCompositeIdentity;
  /** Fails the arming-disable request instead of ACKing it. */
  readonly failArmingDisable?: 'WRITE' | 'ERROR_FRAME';
  /** Fails the status request. */
  readonly failStatus?: 'WRITE' | 'ERROR_FRAME';
  /** Mutated between the ACK and the status request. */
  readonly onAfterAck?: () => void;
  /** Mutated after the status response arrives. */
  readonly onAfterStatus?: () => void;
  /** Replaces the identity provider entirely, so a test can change the
   * answer on a specific call rather than at a transport milestone. */
  readonly readCurrentIdentity?: () => MspSessionCompositeIdentity | undefined;
}

/**
 * Drives a full establishment against a real MspClient and
 * FakeMspTransport, settling each request in order.
 */
async function runEstablishment(
  transport: FakeMspTransport,
  lease: MotorTestLease,
  identityBox: {current: MspSessionCompositeIdentity | undefined},
  options: RunOptions = {},
): Promise<MotorArmingRestrictionEstablishment> {
  const promise = establishMotorArmingRestriction({
    lease,
    requestedIdentity: options.requestedIdentity ?? identity(),
    readCurrentIdentity: options.readCurrentIdentity ?? (() => identityBox.current),
    boxIds: 'boxIds' in options ? options.boxIds : MINTED.get(lease),
  });

  // --- arming-disable request ---
  await flushMicrotasks();
  if (transport.writes.length === 0) {
    return promise; // admission refused before any traffic
  }
  if (options.failArmingDisable === 'WRITE') {
    transport.rejectNextWrite('WRITE_FAILED');
    return promise;
  }
  transport.resolveNextWrite();
  await flushMicrotasks();
  transport.emitData(
    options.failArmingDisable === 'ERROR_FRAME'
      ? errorFrame(MSP_SET_ARMING_DISABLED)
      : responseFrame(MSP_SET_ARMING_DISABLED),
  );
  await flushMicrotasks();
  options.onAfterAck?.();
  await flushMicrotasks();

  // --- fresh status request ---
  if (transport.writes.length === 0) {
    return promise;
  }
  if (options.failStatus === 'WRITE') {
    transport.rejectNextWrite('WRITE_FAILED');
    return promise;
  }
  transport.resolveNextWrite();
  await flushMicrotasks();
  transport.emitData(
    options.failStatus === 'ERROR_FRAME'
      ? errorFrame(MSP_STATUS_EX)
      : responseFrame(MSP_STATUS_EX, statusPayload(options.status)),
  );
  await flushMicrotasks();
  options.onAfterStatus?.();
  return promise;
}

/**
 * Performs the REAL lease-based MSP_BOXIDS acquisition, so every test
 * below uses genuine session-bound evidence rather than a hand-built
 * object the production code would now reject.
 */
async function mintBoxIds(
  transport: FakeMspTransport,
  lease: MotorTestLease,
  wire: Uint8Array = BOX_ID_WIRE_BYTES,
): Promise<MotorTestBoxIdsSnapshot> {
  const pending = acquireMotorTestBoxIds(lease);
  await flushMicrotasks();
  transport.resolveNextWrite();
  await flushMicrotasks();
  transport.emitData(responseFrame(MSP_BOXIDS, wire));
  const result = await pending;
  if (result.kind !== 'ACQUIRED') {
    throw new Error(`expected box-ids ACQUIRED, got ${result.reason}`);
  }
  MINTED.set(lease, result.snapshot);
  return result.snapshot;
}

async function standardSetup() {
  const {transport, client} = makeClient();
  const lease = leaseFor(client);
  const boxIds = await mintBoxIds(transport, lease);
  const identityBox = {current: identity() as MspSessionCompositeIdentity | undefined};
  return {transport, client, lease, identityBox, boxIds};
}

function expectNotEstablished(
  result: MotorArmingRestrictionEstablishment,
  reason: string,
): void {
  expect(result.kind).toBe('NOT_ESTABLISHED');
  if (result.kind !== 'NOT_ESTABLISHED') {
    throw new Error('unreachable');
  }
  expect(result.reason).toBe(reason);
  expect(Object.keys(result).sort()).toEqual(['kind', 'reason']);
}

/* ------------------------------------------------------------------ *
 * 13.1 Tagged protocol contract
 * ------------------------------------------------------------------ */

describe('tagged protocol contract (betaflight 2025.12.2 @ 79065c96)', () => {
  it('pins MSP_SET_ARMING_DISABLED to 99 (msp_protocol.h:169)', () => {
    expect(MSP_SET_ARMING_DISABLED).toBe(99);
  });

  it('pins MSP_STATUS_EX to 150 (msp_protocol.h:217)', () => {
    expect(MSP_STATUS_EX).toBe(150);
  });

  it('builds exactly one payload byte, value 1 (disable)', () => {
    const payload = buildArmingDisablePayload();
    expect(payload).toEqual(Uint8Array.from([1]));
    expect(payload).toHaveLength(1);
    expect(ARMING_DISABLE_COMMAND_BYTE).toBe(1);
  });

  it('returns a fresh payload buffer on every call', () => {
    const first = buildArmingDisablePayload();
    const second = buildArmingDisablePayload();
    expect(first).not.toBe(second);
    first[0] = 0;
    expect(buildArmingDisablePayload()[0]).toBe(1);
  });

  it('pins ARMING_DISABLED_MSP to bit 16 (runtime_config.h:59)', () => {
    expect(ARMING_DISABLED_MSP_BIT_INDEX).toBe(16);
  });

  /**
   * REWRITTEN IN P2-i, NOT DELETED.
   *
   * This assertion used to be "the module exposes NO inverse / re-enable
   * payload or operation", and it was correct for a pass that had no
   * teardown. It is wrong for a pass that owns one: leaving a flight
   * controller arming-disabled after a clean motor-control session is
   * itself a defect, so the release payload now exists.
   *
   * The SAFETY INTENT of the old assertion is preserved and made
   * narrower rather than dropped: the module must still expose exactly
   * two payload builders and NO operation that establishes or releases
   * anything by itself. Ordering - release only after an all-stop - is
   * the driver's obligation, enforced in the controller and its tests,
   * not by hiding the payload here.
   */
  it('exposes payload builders only - no self-issuing release operation', () => {
    const exported = Object.keys(armingRestrictionModule);
    const releaseLike = exported.filter(name =>
      /enable|clear|restore|reenable|allowArming|undo|release/i.test(name),
    );
    // Exactly the three intentional release-side symbols, nothing else.
    //
    // `recordMotorArmingRestrictionReleased` was added by the motor-session
    // reopen fix and is named on this list deliberately rather than
    // excluded from it. It is NOT a self-issuing release: it takes a
    // receipt and updates this module's own bookkeeping, and it has no
    // lease, no client, no transport and no payload - there is nothing in
    // it that could put a byte on a wire. The zero-traffic proof below is
    // the assertion; this list is only the inventory.
    expect(releaseLike.sort()).toEqual([
      'ARMING_ENABLE_COMMAND_BYTE',
      'buildArmingReleasePayload',
      'recordMotorArmingRestrictionReleased',
    ]);
    // Neither is an operation: both are inert value producers.
    expect(typeof armingRestrictionModule.buildArmingReleasePayload).toBe(
      'function',
    );
    expect(buildArmingReleasePayload()).toBeInstanceOf(Uint8Array);
    // The establish builder still produces the DISABLE byte, never 0.
    expect(buildArmingDisablePayload()[0]).not.toBe(0);
    // And the release builder produces exactly the inverse.
    expect(buildArmingReleasePayload()[0]).toBe(0);
  });

  it('never references command 214 in any fixture', () => {
    expect(MSP_SET_ARMING_DISABLED).not.toBe(214);
    expect(MSP_STATUS_EX).not.toBe(214);
  });
});

/* ------------------------------------------------------------------ *
 * 13.2 Establishment admission
 * ------------------------------------------------------------------ */

describe('establishment admission', () => {
  it('accepts independently allocated but value-equal identities', async () => {
    const {transport, lease, identityBox} = await standardSetup();
    const result = await runEstablishment(transport, lease, identityBox);
    expect(result.kind).toBe('ESTABLISHED');
  });

  it('fails with no lease and sends nothing', async () => {
    const {transport} = makeClient();
    const result = await establishMotorArmingRestriction({
      lease: undefined,
      requestedIdentity: identity(),
      readCurrentIdentity: () => identity(),
      boxIds: undefined,
    });
    expectNotEstablished(result, 'MOTOR_TEST_LEASE_INACTIVE');
    expect(transport.writes).toHaveLength(0);
  });

  it('fails with no authoritative identity and sends nothing', async () => {
    const {transport, client} = makeClient();
    const lease = leaseFor(client);
    await mintBoxIds(transport, lease);
    const result = await establishMotorArmingRestriction({
      lease,
      requestedIdentity: identity(),
      readCurrentIdentity: () => undefined,
      boxIds: MINTED.get(lease),
    });
    expectNotEstablished(result, 'CURRENT_SESSION_IDENTITY_UNAVAILABLE');
    expect(transport.writes).toHaveLength(0);
  });

  it('fails on a physicalGeneration mismatch and sends nothing', async () => {
    const {transport, lease, identityBox} = await standardSetup();
    const result = await runEstablishment(transport, lease, identityBox, {
      requestedIdentity: identity(9, 0),
    });
    expectNotEstablished(result, 'REQUESTED_SESSION_IDENTITY_MISMATCH');
    expect(transport.writes).toHaveLength(0);
  });

  it('fails on an mspEpoch mismatch and sends nothing', async () => {
    const {transport, lease, identityBox} = await standardSetup();
    const result = await runEstablishment(transport, lease, identityBox, {
      requestedIdentity: identity(2, 7),
    });
    expectNotEstablished(result, 'REQUESTED_SESSION_IDENTITY_MISMATCH');
    expect(transport.writes).toHaveLength(0);
  });

  it('fails when the lease belongs to a different identity', async () => {
    const {transport, client} = makeClient();
    const lease = leaseFor(client); // bound to (2, 0)
    const result = await establishMotorArmingRestriction({
      lease,
      requestedIdentity: identity(5, 0),
      readCurrentIdentity: () => identity(5, 0),
      boxIds: MINTED.get(lease),
    });
    expectNotEstablished(result, 'MOTOR_TEST_LEASE_IDENTITY_MISMATCH');
    expect(transport.writes).toHaveLength(0);
  });

  it('fails on a released lease and sends nothing', async () => {
    const {transport, lease, identityBox} = await standardSetup();
    expect(lease.release()).toBe('RELEASED');
    const result = await runEstablishment(transport, lease, identityBox);
    expectNotEstablished(result, 'MOTOR_TEST_LEASE_INACTIVE');
    expect(transport.writes).toHaveLength(0);
  });

  it('fails on an invalidated lease and sends nothing', async () => {
    const {transport, client, lease, identityBox} = await standardSetup();
    client.dispose();
    const result = await runEstablishment(transport, lease, identityBox);
    expectNotEstablished(result, 'MOTOR_TEST_LEASE_INACTIVE');
    expect(transport.writes).toHaveLength(0);
  });

  it('fails on a forged lease and sends nothing', async () => {
    const {transport, boxIds} = await standardSetup();
    const forged = new MotorTestLease(identity());
    // Genuine evidence presented with a forged capability must still
    // fail - the lease check fires first.
    const result = await establishMotorArmingRestriction({
      lease: forged,
      requestedIdentity: identity(),
      readCurrentIdentity: () => identity(),
      boxIds,
    });
    expectNotEstablished(result, 'MOTOR_TEST_LEASE_INACTIVE');
    expect(transport.writes).toHaveLength(0);
  });

  it('fails on a cross-client lease without touching the other transport', async () => {
    const first = makeClient();
    const second = makeClient();
    const leaseOnFirst = leaseFor(first.client);
    // Establish against the FIRST client's lease; the second transport
    // must see nothing at all.
    const identityBox = {current: identity() as MspSessionCompositeIdentity | undefined};
    await runEstablishment(first.transport, leaseOnFirst, identityBox);
    expect(second.transport.writes).toHaveLength(0);
  });

  it('fails when no box-id evidence is supplied at all, before any traffic', async () => {
    const fresh = await standardSetup();
    const result = await runEstablishment(fresh.transport, fresh.lease, fresh.identityBox, {
      boxIds: undefined,
    });
    expectNotEstablished(result, 'INDEPENDENT_VERIFICATION_UNAVAILABLE');
    expect(fresh.transport.writes).toHaveLength(0);
    expect(fresh.lease.isActive()).toBe(true);
  });

  it('fails when the trusted snapshot carries an empty mapping', async () => {
    // A real, correctly-minted snapshot whose wire reply was a single
    // byte that is not BOXARM: provenance is fine, the mapping is not.
    const {transport, client} = makeClient();
    const lease = leaseFor(client);
    const snapshot = await mintBoxIds(transport, lease, Uint8Array.from([7]));
    const identityBox = {current: identity() as MspSessionCompositeIdentity | undefined};
    const result = await runEstablishment(transport, lease, identityBox, {boxIds: snapshot});
    // BOXARM is absent from the mapping, so the ARM bit is unresolvable.
    expectNotEstablished(result, 'INDEPENDENT_VERIFICATION_UNAVAILABLE');
    expect(lease.isActive()).toBe(false); // faulted closed after the ACK
  });

  it('refuses a second concurrent establishment immediately', async () => {
    const {transport, lease, identityBox} = await standardSetup();
    const first = establishMotorArmingRestriction({
      lease,
      requestedIdentity: identity(),
      readCurrentIdentity: () => identityBox.current,
      boxIds: MINTED.get(lease),
    });
    const second = await establishMotorArmingRestriction({
      lease,
      requestedIdentity: identity(),
      readCurrentIdentity: () => identityBox.current,
      boxIds: MINTED.get(lease),
    });
    expectNotEstablished(second, 'ARMING_RESTRICTION_ALREADY_ESTABLISHING');

    // Let the first finish so nothing dangles.
    transport.resolveNextWrite();
    await flushMicrotasks();
    transport.emitData(responseFrame(MSP_SET_ARMING_DISABLED));
    await flushMicrotasks();
    transport.resolveNextWrite();
    await flushMicrotasks();
    transport.emitData(responseFrame(MSP_STATUS_EX, statusPayload()));
    expect((await first).kind).toBe('ESTABLISHED');
  });

  it('refuses a second establishment after a successful one', async () => {
    const {transport, lease, identityBox} = await standardSetup();
    expect((await runEstablishment(transport, lease, identityBox)).kind).toBe('ESTABLISHED');
    const again = await establishMotorArmingRestriction({
      lease,
      requestedIdentity: identity(),
      readCurrentIdentity: () => identityBox.current,
      boxIds: MINTED.get(lease),
    });
    expectNotEstablished(again, 'ARMING_RESTRICTION_ALREADY_ESTABLISHED');
  });

  it('never throws for any expected admission failure', async () => {
    const {client} = makeClient();
    const lease = leaseFor(client);
    await expect(
      establishMotorArmingRestriction({
        lease,
        requestedIdentity: identity(9, 9),
        readCurrentIdentity: () => identity(),
        boxIds: MINTED.get(lease),
      }),
    ).resolves.toMatchObject({kind: 'NOT_ESTABLISHED'});
  });
});

/* ------------------------------------------------------------------ *
 * 13.3 Request order
 * ------------------------------------------------------------------ */

describe('request order', () => {
  it('emits exactly MSP_SET_ARMING_DISABLED then MSP_STATUS_EX, through the lease FIFO', async () => {
    const {transport, lease, identityBox} = await standardSetup();
    const result = await runEstablishment(transport, lease, identityBox);
    expect(result.kind).toBe('ESTABLISHED');
    // FakeMspTransport shifts settled writes off `writes`, so capture the
    // command bytes as they are settled instead: verified below by the
    // dedicated recording test.
  });

  it('records exactly two requests, in order, with the exact payloads', async () => {
    const {transport, client} = makeClient();
    const lease = leaseFor(client);
    await mintBoxIds(transport, lease);
    const identityBox = {current: identity() as MspSessionCompositeIdentity | undefined};
    const seen: Array<{command: number; payload: number[]}> = [];

    const promise = establishMotorArmingRestriction({
      lease,
      requestedIdentity: identity(),
      readCurrentIdentity: () => identityBox.current,
      boxIds: MINTED.get(lease),
    });

    await flushMicrotasks();
    // MSP v1 frame: '$','M','<',size,cmd,...payload,crc
    let frame = transport.writes[0].data;
    seen.push({command: frame[4], payload: Array.from(frame.subarray(5, 5 + frame[3]))});
    transport.resolveNextWrite();
    await flushMicrotasks();
    // The status request must NOT have been issued yet - only after ACK.
    expect(transport.writes).toHaveLength(0);
    transport.emitData(responseFrame(MSP_SET_ARMING_DISABLED));
    await flushMicrotasks();

    frame = transport.writes[0].data;
    seen.push({command: frame[4], payload: Array.from(frame.subarray(5, 5 + frame[3]))});
    transport.resolveNextWrite();
    await flushMicrotasks();
    transport.emitData(responseFrame(MSP_STATUS_EX, statusPayload()));
    expect((await promise).kind).toBe('ESTABLISHED');

    expect(seen).toEqual([
      {command: 99, payload: [1]},
      {command: 150, payload: []},
    ]);
    expect(seen.map(entry => entry.command)).not.toContain(214);
  });

  it('never admits an ordinary request while establishing (lease exclusivity holds)', async () => {
    const {transport, client, lease, identityBox} = await standardSetup();
    const promise = establishMotorArmingRestriction({
      lease,
      requestedIdentity: identity(),
      readCurrentIdentity: () => identityBox.current,
      boxIds: MINTED.get(lease),
    });
    await flushMicrotasks();
    await expect(client.request(101, EMPTY, {wireFormat: 'v1'})).rejects.toMatchObject({
      code: 'MSP_MOTOR_TEST_LEASE_HELD',
    });

    transport.resolveNextWrite();
    await flushMicrotasks();
    transport.emitData(responseFrame(MSP_SET_ARMING_DISABLED));
    await flushMicrotasks();
    transport.resolveNextWrite();
    await flushMicrotasks();
    transport.emitData(responseFrame(MSP_STATUS_EX, statusPayload()));
    await promise;
  });

  it('produces NO receipt from the ACK alone', async () => {
    const {transport, client} = makeClient();
    const lease = leaseFor(client);
    await mintBoxIds(transport, lease);
    const identityBox = {current: identity() as MspSessionCompositeIdentity | undefined};
    const promise = establishMotorArmingRestriction({
      lease,
      requestedIdentity: identity(),
      readCurrentIdentity: () => identityBox.current,
      boxIds: MINTED.get(lease),
    });
    await flushMicrotasks();
    transport.resolveNextWrite();
    await flushMicrotasks();
    transport.emitData(responseFrame(MSP_SET_ARMING_DISABLED));
    await flushMicrotasks();

    // ACK has settled. The promise must still be pending - a second
    // request is outstanding - so no receipt exists yet.
    let settled = false;
    const watcher = promise.then(result => {
      settled = true;
      return result;
    });
    await flushMicrotasks();
    expect(settled).toBe(false);
    expect(transport.writes).toHaveLength(1); // the status request

    transport.resolveNextWrite();
    await flushMicrotasks();
    transport.emitData(responseFrame(MSP_STATUS_EX, statusPayload()));
    expect((await watcher).kind).toBe('ESTABLISHED');
  });
});

/* ------------------------------------------------------------------ *
 * 13.4 Verification
 * ------------------------------------------------------------------ */

describe('verification', () => {
  it('succeeds on ACK + disarmed + MSP restriction observed', async () => {
    const {transport, lease, identityBox} = await standardSetup();
    const result = await runEstablishment(transport, lease, identityBox, {
      status: {armed: false, mspRestrictionPresent: true},
    });
    expect(result.kind).toBe('ESTABLISHED');
    if (result.kind !== 'ESTABLISHED') {
      throw new Error('unreachable');
    }
    expect(result.receipt.isCurrent()).toBe(true);
  });

  it('fails closed when the FC reports ARMED, and faults the lease', async () => {
    const {transport, lease, identityBox} = await standardSetup();
    const result = await runEstablishment(transport, lease, identityBox, {
      status: {armed: true, mspRestrictionPresent: true},
    });
    expectNotEstablished(result, 'FC_ARMED');
    expect(lease.isActive()).toBe(false);
  });

  it('fails closed when the MSP restriction bit is absent, and faults the lease', async () => {
    const {transport, lease, identityBox} = await standardSetup();
    const result = await runEstablishment(transport, lease, identityBox, {
      status: {mspRestrictionPresent: false},
    });
    expectNotEstablished(result, 'MSP_ARMING_RESTRICTION_NOT_OBSERVED');
    expect(lease.isActive()).toBe(false);
  });

  it('does not accept an unrelated arming-disable flag as the MSP restriction', async () => {
    const {transport, lease, identityBox} = await standardSetup();
    const result = await runEstablishment(transport, lease, identityBox, {
      // THROTTLE (bit 7) and NO_GYRO (bit 0) set, MSP bit clear.
      status: {mspRestrictionPresent: false, extraMask: Math.pow(2, 7) + Math.pow(2, 0)},
    });
    expectNotEstablished(result, 'MSP_ARMING_RESTRICTION_NOT_OBSERVED');
  });

  it('fails closed on an ERROR-direction ACK', async () => {
    const {transport, lease, identityBox} = await standardSetup();
    const result = await runEstablishment(transport, lease, identityBox, {
      failArmingDisable: 'ERROR_FRAME',
    });
    expectNotEstablished(result, 'ARMING_DISABLE_REQUEST_FAILED');
    expect(lease.isActive()).toBe(false);
  });

  it('fails closed on an arming-disable write failure', async () => {
    const {transport, lease, identityBox} = await standardSetup();
    const result = await runEstablishment(transport, lease, identityBox, {
      failArmingDisable: 'WRITE',
    });
    expectNotEstablished(result, 'ARMING_DISABLE_REQUEST_FAILED');
    expect(lease.isActive()).toBe(false);
  });

  it('fails closed on a status write failure', async () => {
    const {transport, lease, identityBox} = await standardSetup();
    const result = await runEstablishment(transport, lease, identityBox, {failStatus: 'WRITE'});
    expectNotEstablished(result, 'POST_ACK_STATUS_REQUEST_FAILED');
    expect(lease.isActive()).toBe(false);
  });

  it('fails closed on an ERROR-direction status response', async () => {
    const {transport, lease, identityBox} = await standardSetup();
    const result = await runEstablishment(transport, lease, identityBox, {
      failStatus: 'ERROR_FRAME',
    });
    expectNotEstablished(result, 'POST_ACK_STATUS_REQUEST_FAILED');
    expect(lease.isActive()).toBe(false);
  });

  it('fails closed on a truncated status frame', async () => {
    const {transport, lease, identityBox} = await standardSetup();
    const result = await runEstablishment(transport, lease, identityBox, {
      status: {truncateTo: 9},
    });
    expectNotEstablished(result, 'MALFORMED_STATUS_RESPONSE');
    expect(lease.isActive()).toBe(false);
  });

  it('fails closed on a partially present status tail', async () => {
    const {transport, lease, identityBox} = await standardSetup();
    const result = await runEstablishment(transport, lease, identityBox, {
      status: {declaredByteCount: 9, truncateTo: 16},
    });
    expectNotEstablished(result, 'MALFORMED_STATUS_RESPONSE');
    expect(lease.isActive()).toBe(false);
  });

  it('fails closed when the status frame carried no arming-disable mask', async () => {
    const {transport, lease, identityBox} = await standardSetup();
    const result = await runEstablishment(transport, lease, identityBox, {
      status: {truncateTo: 16},
    });
    expectNotEstablished(result, 'INDEPENDENT_VERIFICATION_UNAVAILABLE');
    expect(lease.isActive()).toBe(false);
  });

  it('fails closed on an MSP response timeout for the status read', async () => {
    jest.useFakeTimers();
    try {
      const {transport, client} = makeClient();
      const lease = leaseFor(client);
      await mintBoxIds(transport, lease);
      const identityBox = {current: identity() as MspSessionCompositeIdentity | undefined};
      const promise = establishMotorArmingRestriction({
        lease,
        requestedIdentity: identity(),
        readCurrentIdentity: () => identityBox.current,
        boxIds: MINTED.get(lease),
      });
      await flushMicrotasks();
      transport.resolveNextWrite();
      await flushMicrotasks();
      transport.emitData(responseFrame(MSP_SET_ARMING_DISABLED));
      await flushMicrotasks();
      transport.resolveNextWrite();
      await flushMicrotasks();
      jest.advanceTimersByTime(5000);
      await flushMicrotasks();
      expectNotEstablished(await promise, 'POST_ACK_STATUS_REQUEST_FAILED');
      expect(lease.isActive()).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('fails closed when the identity changes after the ACK', async () => {
    const {transport, lease, identityBox} = await standardSetup();
    const result = await runEstablishment(transport, lease, identityBox, {
      onAfterAck: () => {
        identityBox.current = identity(2, 99);
      },
    });
    expectNotEstablished(result, 'SESSION_CHANGED_DURING_ESTABLISHMENT');
    expect(lease.isActive()).toBe(false);
  });

  it('fails closed when the identity disappears after the ACK', async () => {
    const {transport, lease, identityBox} = await standardSetup();
    const result = await runEstablishment(transport, lease, identityBox, {
      onAfterAck: () => {
        identityBox.current = undefined;
      },
    });
    expectNotEstablished(result, 'SESSION_CHANGED_DURING_ESTABLISHMENT');
  });

  it('fails closed when the identity changes after the status response but before settlement', async () => {
    // The provider is consulted exactly three times: at admission, after
    // the ACK, and after the status response. Changing the answer only on
    // that third call is precisely "changed after the response arrived,
    // before the result settled" - a transport-milestone callback would
    // fire too late, after the synchronous continuation already ran.
    const {transport, lease, identityBox} = await standardSetup();
    let calls = 0;
    const result = await runEstablishment(transport, lease, identityBox, {
      readCurrentIdentity: () => {
        calls += 1;
        return calls >= 3 ? identity(3, 0) : identity();
      },
    });
    expectNotEstablished(result, 'SESSION_CHANGED_DURING_ESTABLISHMENT');
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(lease.isActive()).toBe(false);
  });

  it('fails when the lease is invalidated mid-establishment', async () => {
    const {transport, client, lease, identityBox} = await standardSetup();
    const result = await runEstablishment(transport, lease, identityBox, {
      onAfterAck: () => {
        client.dispose();
      },
    });
    expect(result.kind).toBe('NOT_ESTABLISHED');
    expect(lease.isActive()).toBe(false);
  });

  it('never accepts a pre-ACK observation: the status read happens after the ACK', async () => {
    const {transport, client} = makeClient();
    const lease = leaseFor(client);
    await mintBoxIds(transport, lease);
    const identityBox = {current: identity() as MspSessionCompositeIdentity | undefined};
    const order: string[] = [];
    const promise = establishMotorArmingRestriction({
      lease,
      requestedIdentity: identity(),
      readCurrentIdentity: () => identityBox.current,
      boxIds: MINTED.get(lease),
    });
    await flushMicrotasks();
    order.push(`write:${transport.writes[0].data[4]}`);
    transport.resolveNextWrite();
    await flushMicrotasks();
    order.push('ack');
    transport.emitData(responseFrame(MSP_SET_ARMING_DISABLED));
    await flushMicrotasks();
    order.push(`write:${transport.writes[0].data[4]}`);
    transport.resolveNextWrite();
    await flushMicrotasks();
    transport.emitData(responseFrame(MSP_STATUS_EX, statusPayload()));
    await promise;
    expect(order).toEqual(['write:99', 'ack', 'write:150']);
  });

  it('a recovery probe does not resume a failed establishment', async () => {
    const {transport, client, lease, identityBox} = await standardSetup();
    const result = await runEstablishment(transport, lease, identityBox, {
      failArmingDisable: 'WRITE',
    });
    expect(result.kind).toBe('NOT_ESTABLISHED');
    // Let recovery run its full course.
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
    expect(lease.isActive()).toBe(false);
    expect(client.isMotorTestLeaseHeld()).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 13.5 Receipt ownership
 * ------------------------------------------------------------------ */

describe('receipt ownership', () => {
  async function established() {
    const setup = await standardSetup();
    const result = await runEstablishment(setup.transport, setup.lease, setup.identityBox);
    if (result.kind !== 'ESTABLISHED') {
      throw new Error(`expected ESTABLISHED, got ${result.reason}`);
    }
    return {...setup, receipt: result.receipt};
  }

  it('does not retain the caller identity object by reference', async () => {
    const {transport, client} = makeClient();
    const lease = leaseFor(client);
    await mintBoxIds(transport, lease);
    const caller = {physicalGeneration: 2, mspEpoch: 0};
    const identityBox = {current: caller as MspSessionCompositeIdentity | undefined};
    const result = await runEstablishment(transport, lease, identityBox, {});
    if (result.kind !== 'ESTABLISHED') {
      throw new Error('unreachable');
    }
    expect(result.receipt.sessionIdentity).not.toBe(caller);
    caller.physicalGeneration = 77;
    expect(result.receipt.sessionIdentity).toEqual({physicalGeneration: 2, mspEpoch: 0});
  });

  it('freezes the receipt and its identity snapshot', async () => {
    const {receipt} = await established();
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.sessionIdentity)).toBe(true);
    const mutable = receipt.sessionIdentity as {physicalGeneration: number};
    try {
      mutable.physicalGeneration = 42;
    } catch {
      // Strict mode throws, sloppy mode ignores - either is acceptable.
    }
    expect(receipt.sessionIdentity.physicalGeneration).toBe(2);
  });

  it('exposes no lease requester, client, transport or writeBytes', async () => {
    const {receipt} = await established();
    const names = new Set<string>([
      ...Object.keys(receipt),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(receipt) as object),
    ]);
    for (const forbidden of ['request', 'lease', 'client', 'transport', 'writeBytes', 'token']) {
      expect(names.has(forbidden)).toBe(false);
    }
    const asRecord = receipt as unknown as Record<string, unknown>;
    expect(asRecord.writeBytes).toBeUndefined();
    expect(asRecord.lease).toBeUndefined();
  });

  it('cannot be reconstructed from public fields or JSON', async () => {
    const {receipt} = await established();
    const spread = {...receipt} as Partial<MotorArmingRestrictionReceipt>;
    expect(spread.isCurrent).toBeUndefined();
    const revived = JSON.parse(JSON.stringify(receipt)) as Partial<MotorArmingRestrictionReceipt>;
    expect(revived.isCurrent).toBeUndefined();
    expect(JSON.stringify(receipt)).not.toContain('token');
    // A hand-built receipt has no authority.
    const forged = new MotorArmingRestrictionReceipt(identity());
    expect(forged.isCurrent()).toBe(false);
  });

  it('records the aggregate-only evidence scope', async () => {
    const {receipt} = await established();
    expect(receipt.evidenceScope).toBe('AGGREGATE_NOT_DESCRIPTOR_SPECIFIC');
    expect(receipt.receiptKind).toBe('MSP_ARMING_RESTRICTION_OBSERVED');
  });

  it('becomes non-current when the lease is released', async () => {
    const {receipt, lease} = await established();
    expect(receipt.isCurrent()).toBe(true);
    // A release requires an idle client, which it is.
    expect(lease.release()).toBe('RELEASED');
    expect(receipt.isCurrent()).toBe(false);
  });

  it('becomes non-current when the lease is invalidated', async () => {
    const {receipt, client} = await established();
    client.dispose();
    expect(receipt.isCurrent()).toBe(false);
  });

  it('becomes non-current when the lease is faulted', async () => {
    const {receipt, lease} = await established();
    expect(lease.failClosed()).toBe(true);
    expect(receipt.isCurrent()).toBe(false);
  });

  it('cannot become current again after recovery', async () => {
    const {receipt, client, transport} = await established();
    client.dispose();
    await flushMicrotasks();
    if (transport.restarts.length > 0) {
      transport.resolveNextRestart();
    }
    await flushMicrotasks();
    expect(receipt.isCurrent()).toBe(false);
  });

  it('cannot affect a new lease or a new session', async () => {
    const {receipt, client} = await established();
    client.dispose();

    const second = makeClient();
    const newLease = leaseFor(second.client);
    await mintBoxIds(second.transport, newLease);
    expect(receipt.isCurrent()).toBe(false);
    expect(newLease.isActive()).toBe(true);
    // The old receipt is not the new lease's receipt.
    const fresh = await runEstablishment(second.transport, newLease, {
      current: identity() as MspSessionCompositeIdentity | undefined,
    });
    if (fresh.kind !== 'ESTABLISHED') {
      throw new Error('unreachable');
    }
    expect(fresh.receipt).not.toBe(receipt);
    expect(receipt.isCurrent()).toBe(false);
    expect(fresh.receipt.isCurrent()).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 13.6 Fault boundary
 * ------------------------------------------------------------------ */

describe('fault boundary', () => {
  it('a semantic failure fault-latches the same composite identity', async () => {
    const {transport, client, lease, identityBox} = await standardSetup();
    const result = await runEstablishment(transport, lease, identityBox, {
      status: {mspRestrictionPresent: false},
    });
    expectNotEstablished(result, 'MSP_ARMING_RESTRICTION_NOT_OBSERVED');
    expect(lease.isActive()).toBe(false);
    // Reacquisition on the SAME identity is refused by the canonical
    // Pass 2 latch - no second fault manager was invented.
    const again = acquireMotorTestLease({
      client,
      requestedIdentity: identity(2, 0),
      readCurrentIdentity: () => identity(2, 0),
    });
    expect(again).toMatchObject({
      kind: 'NOT_ACQUIRED',
      reason: 'MOTOR_TEST_LEASE_FAULT_LATCHED',
    });
  });

  it('refuses a retry of establishment on the faulted lease', async () => {
    const {transport, lease, identityBox} = await standardSetup();
    await runEstablishment(transport, lease, identityBox, {status: {armed: true}});
    const retry = await establishMotorArmingRestriction({
      lease,
      requestedIdentity: identity(),
      readCurrentIdentity: () => identityBox.current,
      boxIds: MINTED.get(lease),
    });
    expectNotEstablished(retry, 'ARMING_RESTRICTION_FAULT_LATCHED');
  });

  it('a genuinely new session identity crosses the old fault boundary', async () => {
    const first = await standardSetup();
    await runEstablishment(first.transport, first.lease, first.identityBox, {
      status: {mspRestrictionPresent: false},
    });
    expect(first.lease.isActive()).toBe(false);

    // A new physical session is a new MspClient entirely.
    const second = makeClient();
    const newLease = leaseFor(second.client);
    await mintBoxIds(second.transport, newLease);
    expect(newLease.isActive()).toBe(true);
    const result = await runEstablishment(second.transport, newLease, {
      current: identity() as MspSessionCompositeIdentity | undefined,
    });
    expect(result.kind).toBe('ESTABLISHED');
  });

  it('an old capability cannot fault a newer lease', async () => {
    const {client} = makeClient();
    const older = leaseFor(client);
    expect(older.release()).toBe('RELEASED');
    const newer = leaseFor(client);
    expect(older.failClosed()).toBe(false);
    expect(newer.isActive()).toBe(true);
  });

  it('a successful establishment does not clear an unrelated existing fault', async () => {
    // Fault client A, then establish on a completely separate client B.
    const faulted = await standardSetup();
    await runEstablishment(faulted.transport, faulted.lease, faulted.identityBox, {
      status: {armed: true},
    });
    expect(faulted.lease.isActive()).toBe(false);

    const other = makeClient();
    const otherLease = leaseFor(other.client);
    await mintBoxIds(other.transport, otherLease);
    const ok = await runEstablishment(other.transport, otherLease, {
      current: identity() as MspSessionCompositeIdentity | undefined,
    });
    expect(ok.kind).toBe('ESTABLISHED');

    // Client A's latch is untouched.
    const stillBlocked = acquireMotorTestLease({
      client: faulted.client,
      requestedIdentity: identity(2, 0),
      readCurrentIdentity: () => identity(2, 0),
    });
    expect(stillBlocked).toMatchObject({reason: 'MOTOR_TEST_LEASE_FAULT_LATCHED'});
  });
});

/* ------------------------------------------------------------------ *
 * 13.7 Semantic exclusions
 * ------------------------------------------------------------------ */

describe('semantic exclusions', () => {
  const AUTHORIZATION_VOCABULARY =
    /^(is)?(safe|ready|authoriz|approved|allowed|permitted|permission|cantest|canpulse|canstart|go)$/i;

  it('exposes no field or method meaning motor safety or authorization', async () => {
    const setup = await standardSetup();
    const result = await runEstablishment(setup.transport, setup.lease, setup.identityBox);
    if (result.kind !== 'ESTABLISHED') {
      throw new Error('unreachable');
    }
    const names = [
      ...Object.keys(result.receipt),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(result.receipt) as object),
    ].filter(name => name !== 'constructor');
    expect(names.filter(name => AUTHORIZATION_VOCABULARY.test(name))).toEqual([]);
    expect(names.sort()).toEqual([
      'evidenceScope',
      'isCurrent',
      'receiptKind',
      'sessionIdentity',
    ]);
  });

  it('exports no motor command, vector, pulse or stop symbol', () => {
    for (const name of Object.keys(armingRestrictionModule)) {
      expect(name).not.toMatch(/motorVector|pulse|idle|throttle|percent|stop|setMotor|arm(?!ing)/i);
    }
  });

  it('converts no Pass 1E result into permission', async () => {
    const setup = await standardSetup();
    const result = await runEstablishment(setup.transport, setup.lease, setup.identityBox);
    const serialized = JSON.stringify(result);
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

  it('uses no timer, retry, TTL or automatic expiry of its own', async () => {
    jest.useFakeTimers();
    try {
      const setup = await standardSetup();
      const result = await runEstablishment(setup.transport, setup.lease, setup.identityBox);
      if (result.kind !== 'ESTABLISHED') {
        throw new Error('unreachable');
      }
      // No MspClient request is outstanding, so no timer should remain.
      expect(jest.getTimerCount()).toBe(0);
      jest.advanceTimersByTime(60 * 60 * 1000);
      // The receipt neither expires nor refreshes on its own.
      expect(result.receipt.isCurrent()).toBe(true);
      expect(setup.transport.writes).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('sends nothing further after establishment - no monitoring loop', async () => {
    const setup = await standardSetup();
    await runEstablishment(setup.transport, setup.lease, setup.identityBox);
    const after = setup.transport.writes.length;
    await flushMicrotasks(20);
    expect(setup.transport.writes.length).toBe(after);
  });

  it('establishment alone cannot pulse a motor - only two read/write commands exist', async () => {
    const {transport, client} = makeClient();
    const lease = leaseFor(client);
    await mintBoxIds(transport, lease);
    const identityBox = {current: identity() as MspSessionCompositeIdentity | undefined};
    const commands: number[] = [];
    const promise = establishMotorArmingRestriction({
      lease,
      requestedIdentity: identity(),
      readCurrentIdentity: () => identityBox.current,
      boxIds: MINTED.get(lease),
    });
    await flushMicrotasks();
    commands.push(transport.writes[0].data[4]);
    transport.resolveNextWrite();
    await flushMicrotasks();
    transport.emitData(responseFrame(MSP_SET_ARMING_DISABLED));
    await flushMicrotasks();
    commands.push(transport.writes[0].data[4]);
    transport.resolveNextWrite();
    await flushMicrotasks();
    transport.emitData(responseFrame(MSP_STATUS_EX, statusPayload()));
    await promise;

    expect(commands).toEqual([99, 150]);
    expect(commands).not.toContain(214);
    // A four-motor payload would be 8 bytes; nothing of that size exists.
    expect(buildArmingDisablePayload()).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * Pass 3 correction A - session-scoped establishment authority
 * ------------------------------------------------------------------ */

describe('correction A: cross-lease establishment within one official session', () => {
  it('refuses lease B after lease A established and was released idle', async () => {
    const {transport, client, lease: leaseA} = await standardSetup();
    const first = await runEstablishment(transport, leaseA, {
      current: identity() as MspSessionCompositeIdentity | undefined,
    });
    expect(first.kind).toBe('ESTABLISHED');
    expect(leaseA.release()).toBe('RELEASED');

    const leaseB = leaseFor(client); // same client, same official session
    const boxIdsB = await mintBoxIds(transport, leaseB);
    const writesBefore = transport.writes.length;

    const second = await establishMotorArmingRestriction({
      lease: leaseB,
      requestedIdentity: identity(),
      readCurrentIdentity: () => identity(),
      boxIds: boxIdsB,
    });
    expectNotEstablished(second, 'ARMING_RESTRICTION_ALREADY_ESTABLISHED');
    // Zero additional MSP requests and zero transport writes.
    expect(transport.writes.length).toBe(writesBefore);
  });

  it('keeps total command 99 submissions at exactly one for the session', async () => {
    const {transport, client, lease: leaseA} = await standardSetup();
    const commands: number[] = [];
    const record = () => {
      for (const write of transport.writes) {
        commands.push(write.data[4]);
      }
    };
    const promise = establishMotorArmingRestriction({
      lease: leaseA,
      requestedIdentity: identity(),
      readCurrentIdentity: () => identity(),
      boxIds: MINTED.get(leaseA),
    });
    await flushMicrotasks();
    record();
    transport.resolveNextWrite();
    await flushMicrotasks();
    transport.emitData(responseFrame(MSP_SET_ARMING_DISABLED));
    await flushMicrotasks();
    record();
    transport.resolveNextWrite();
    await flushMicrotasks();
    transport.emitData(responseFrame(MSP_STATUS_EX, statusPayload()));
    expect((await promise).kind).toBe('ESTABLISHED');

    expect(leaseA.release()).toBe('RELEASED');
    const leaseB = leaseFor(client);
    const boxIdsB = await mintBoxIds(transport, leaseB);
    await establishMotorArmingRestriction({
      lease: leaseB,
      requestedIdentity: identity(),
      readCurrentIdentity: () => identity(),
      boxIds: boxIdsB,
    });
    await flushMicrotasks();
    record();

    expect(commands.filter(command => command === MSP_SET_ARMING_DISABLED)).toHaveLength(1);
    expect(commands).not.toContain(214);
  });

  it('makes receipt A non-current on release without clearing the session record', async () => {
    const {transport, client, lease: leaseA} = await standardSetup();
    const first = await runEstablishment(transport, leaseA, {
      current: identity() as MspSessionCompositeIdentity | undefined,
    });
    if (first.kind !== 'ESTABLISHED') {
      throw new Error('unreachable');
    }
    expect(first.receipt.isCurrent()).toBe(true);
    expect(leaseA.release()).toBe('RELEASED');
    expect(first.receipt.isCurrent()).toBe(false); // non-current...

    const leaseB = leaseFor(client);
    const boxIdsB = await mintBoxIds(transport, leaseB);
    // ...but the session record survived, so B is refused.
    expectNotEstablished(
      await establishMotorArmingRestriction({
        lease: leaseB,
        requestedIdentity: identity(),
        readCurrentIdentity: () => identity(),
        boxIds: boxIdsB,
      }),
      'ARMING_RESTRICTION_ALREADY_ESTABLISHED',
    );
  });

  it('is not bypassed by caller-created value-equal identity objects', async () => {
    const {transport, client, lease: leaseA} = await standardSetup();
    await runEstablishment(transport, leaseA, {
      current: identity() as MspSessionCompositeIdentity | undefined,
    });
    expect(leaseA.release()).toBe('RELEASED');
    const leaseB = leaseFor(client);
    const boxIdsB = await mintBoxIds(transport, leaseB);
    // Freshly allocated, value-equal objects - different references.
    expectNotEstablished(
      await establishMotorArmingRestriction({
        lease: leaseB,
        requestedIdentity: {physicalGeneration: 2, mspEpoch: 0},
        readCurrentIdentity: () => ({physicalGeneration: 2, mspEpoch: 0}),
        boxIds: boxIdsB,
      }),
      'ARMING_RESTRICTION_ALREADY_ESTABLISHED',
    );
  });

  it('cannot be bypassed by inventing different scalar values', async () => {
    const {transport, client, lease: leaseA} = await standardSetup();
    await runEstablishment(transport, leaseA, {
      current: identity() as MspSessionCompositeIdentity | undefined,
    });
    expect(leaseA.release()).toBe('RELEASED');
    const leaseB = leaseFor(client);
    const boxIdsB = await mintBoxIds(transport, leaseB);
    const writesBefore = transport.writes.length;
    // Claiming a different session does not manufacture one: the lease's
    // own identity no longer matches, so it is refused - and still sends
    // nothing.
    const result = await establishMotorArmingRestriction({
      lease: leaseB,
      requestedIdentity: identity(9, 9),
      readCurrentIdentity: () => identity(9, 9),
      boxIds: boxIdsB,
    });
    expect(result.kind).toBe('NOT_ESTABLISHED');
    expect(transport.writes.length).toBe(writesBefore);
  });

  it('lets a genuinely different client/session establish independently', async () => {
    const first = await standardSetup();
    expect((await runEstablishment(first.transport, first.lease, first.identityBox)).kind).toBe(
      'ESTABLISHED',
    );
    const second = await standardSetup();
    expect((await runEstablishment(second.transport, second.lease, second.identityBox)).kind).toBe(
      'ESTABLISHED',
    );
  });

  it('does not let client A\'s record block or authorize client B', async () => {
    const a = await standardSetup();
    await runEstablishment(a.transport, a.lease, a.identityBox);
    const b = await standardSetup();
    // Not blocked...
    const result = await runEstablishment(b.transport, b.lease, b.identityBox);
    expect(result.kind).toBe('ESTABLISHED');
    if (result.kind !== 'ESTABLISHED') {
      throw new Error('unreachable');
    }
    // ...and not authorized by A either: B minted its own receipt.
    expect(result.receipt.isCurrent()).toBe(true);
  });

  it('creates no success record from a failed pre-write admission', async () => {
    const {transport, lease, identityBox} = await standardSetup();
    const writesBefore = transport.writes.length;
    expectNotEstablished(
      await runEstablishment(transport, lease, identityBox, {requestedIdentity: identity(4, 4)}),
      'REQUESTED_SESSION_IDENTITY_MISMATCH',
    );
    expect(transport.writes.length).toBe(writesBefore);
    // The session is still establishable afterwards.
    expect((await runEstablishment(transport, lease, identityBox)).kind).toBe('ESTABLISHED');
  });

  it('keeps concurrent-establishment protection atomic and session-scoped', async () => {
    const {transport, lease, identityBox} = await standardSetup();
    const first = establishMotorArmingRestriction({
      lease,
      requestedIdentity: identity(),
      readCurrentIdentity: () => identityBox.current,
      boxIds: MINTED.get(lease),
    });
    expectNotEstablished(
      await establishMotorArmingRestriction({
        lease,
        requestedIdentity: identity(),
        readCurrentIdentity: () => identityBox.current,
        boxIds: MINTED.get(lease),
      }),
      'ARMING_RESTRICTION_ALREADY_ESTABLISHING',
    );
    transport.resolveNextWrite();
    await flushMicrotasks();
    transport.emitData(responseFrame(MSP_SET_ARMING_DISABLED));
    await flushMicrotasks();
    transport.resolveNextWrite();
    await flushMicrotasks();
    transport.emitData(responseFrame(MSP_STATUS_EX, statusPayload()));
    expect((await first).kind).toBe('ESTABLISHED');
  });
});

/* ------------------------------------------------------------------ *
 * Pass 3 correction B - Box IDs provenance
 * ------------------------------------------------------------------ */

describe('correction B: session-bound Box IDs provenance', () => {
  it('accepts a legitimate current-session snapshot', async () => {
    const {transport, lease, identityBox, boxIds} = await standardSetup();
    expect(boxIds).toBeInstanceOf(MotorTestBoxIdsSnapshot);
    expect((await runEstablishment(transport, lease, identityBox, {boxIds})).kind).toBe(
      'ESTABLISHED',
    );
  });

  async function expectRejectedEvidence(
    boxIds: MotorTestBoxIdsSnapshot | undefined,
  ): Promise<void> {
    const {transport, lease, identityBox} = await standardSetup();
    const writesBefore = transport.writes.length;
    expectNotEstablished(
      await runEstablishment(transport, lease, identityBox, {boxIds}),
      'BOX_IDS_PROVENANCE_INVALID',
    );
    // Zero establishment requests and zero transport writes.
    expect(transport.writes.length).toBe(writesBefore);
    expect(lease.isActive()).toBe(true);
  }

  it('rejects a stale snapshot from a previous session on the same client', async () => {
    const {transport, client, lease: leaseA} = await standardSetup();
    const staleSnapshot = MINTED.get(leaseA);
    // Desync rotates the epoch, which is a new official session.
    const doomed = leaseA.request(MSP_STATUS_EX, EMPTY, {wireFormat: 'v1'});
    const settled = doomed.catch(() => undefined);
    transport.rejectNextWrite('WRITE_FAILED');
    await settled;
    await flushMicrotasks();
    expect(client.getEpoch()).toBe(1);
    expect(leaseA.isActive()).toBe(false);

    // A fresh lease in the NEW session must not accept the old evidence.
    const second = await standardSetup();
    expectNotEstablished(
      await runEstablishment(second.transport, second.lease, second.identityBox, {
        boxIds: staleSnapshot,
      }),
      'BOX_IDS_PROVENANCE_INVALID',
    );
  });

  it('rejects a cross-client snapshot before command 99', async () => {
    const other = await standardSetup();
    await expectRejectedEvidence(other.boxIds);
  });

  it('rejects a spread copy', async () => {
    const {boxIds} = await standardSetup();
    await expectRejectedEvidence({...boxIds} as unknown as MotorTestBoxIdsSnapshot);
  });

  it('rejects a JSON round-trip', async () => {
    const {boxIds} = await standardSetup();
    await expectRejectedEvidence(
      JSON.parse(JSON.stringify(boxIds)) as MotorTestBoxIdsSnapshot,
    );
  });

  it('rejects a structurally forged / hand-built object', async () => {
    await expectRejectedEvidence({
      snapshotKind: 'MOTOR_TEST_BOX_IDS_SNAPSHOT',
      permanentIds: [5, 1, 0, 13],
    } as unknown as MotorTestBoxIdsSnapshot);
    // Even a real class instance built by hand has no registry entry.
    await expectRejectedEvidence(new MotorTestBoxIdsSnapshot([5, 1, 0, 13]));
  });

  it('does not make a forgery authentic by copying session scalar fields', async () => {
    const {boxIds} = await standardSetup();
    // A genuine snapshot cannot even be decorated - it is frozen.
    expect(() =>
      Object.assign(boxIds as object, {physicalGeneration: 2, mspEpoch: 0}),
    ).toThrow(TypeError);
    // And a hand-built look-alike carrying every plausible session field
    // is still rejected: authenticity is registry membership, not shape.
    const withScalars = {
      snapshotKind: 'MOTOR_TEST_BOX_IDS_SNAPSHOT',
      permanentIds: [5, 1, 0, 13],
      physicalGeneration: 2,
      mspEpoch: 0,
      sessionIdentity: identity(),
    };
    await expectRejectedEvidence(withScalars as unknown as MotorTestBoxIdsSnapshot);
  });

  it('cannot be altered by mutating the original decoded input', async () => {
    const {transport, client} = makeClient();
    const lease = leaseFor(client);
    const wire = Uint8Array.from([5, 1, 0, 13]);
    const snapshot = await mintBoxIds(transport, lease, wire);
    wire[2] = 99; // BOXARM byte in the caller's own buffer
    expect(snapshot.permanentIds).toEqual([5, 1, 0, 13]);
    expect(Object.isFrozen(snapshot.permanentIds)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('exposes no transport, client, requester, token or write capability', async () => {
    const {boxIds} = await standardSetup();
    const names = new Set<string>([
      ...Object.keys(boxIds),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(boxIds) as object),
    ]);
    for (const forbidden of ['request', 'lease', 'client', 'transport', 'writeBytes', 'token']) {
      expect(names.has(forbidden)).toBe(false);
    }
    expect(Object.keys(boxIds).sort()).toEqual(['permanentIds', 'snapshotKind']);
  });
});

/* ------------------------------------------------------------------ *
 * Pass 3 correction 6.5 - identity-provider exceptions
 * ------------------------------------------------------------------ */

describe('correction 6.5: a throwing identity provider', () => {
  it('returns a typed failure with zero traffic when it throws pre-write', async () => {
    const {transport, lease} = await standardSetup();
    const writesBefore = transport.writes.length;
    const result = await establishMotorArmingRestriction({
      lease,
      requestedIdentity: identity(),
      readCurrentIdentity: () => {
        throw new Error('provider exploded');
      },
      boxIds: MINTED.get(lease),
    });
    expectNotEstablished(result, 'SESSION_IDENTITY_PROVIDER_FAILED');
    expect(transport.writes.length).toBe(writesBefore);
    expect(lease.isActive()).toBe(true); // nothing was sent, nothing faulted
  });

  it('faults the lease when it throws after command 99 was submitted', async () => {
    const {transport, lease, identityBox} = await standardSetup();
    let calls = 0;
    const result = await runEstablishment(transport, lease, identityBox, {
      readCurrentIdentity: () => {
        calls += 1;
        if (calls >= 2) {
          throw new Error('provider exploded after ACK');
        }
        return identity();
      },
    });
    expectNotEstablished(result, 'SESSION_IDENTITY_PROVIDER_FAILED');
    expect(lease.isActive()).toBe(false);
  });

  it('faults the lease when it throws after the status response', async () => {
    const {transport, lease, identityBox} = await standardSetup();
    let calls = 0;
    const result = await runEstablishment(transport, lease, identityBox, {
      readCurrentIdentity: () => {
        calls += 1;
        if (calls >= 3) {
          throw new Error('provider exploded after status');
        }
        return identity();
      },
    });
    expectNotEstablished(result, 'SESSION_IDENTITY_PROVIDER_FAILED');
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(lease.isActive()).toBe(false);
  });

  it('never throws from receipt.isCurrent()', async () => {
    const {transport, lease, identityBox} = await standardSetup();
    const result = await runEstablishment(transport, lease, identityBox);
    if (result.kind !== 'ESTABLISHED') {
      throw new Error('unreachable');
    }
    // isCurrent() consults only this module's own state - it never calls
    // a caller-supplied provider, so nothing a caller does can make it
    // throw, before or after the lease dies.
    expect(() => result.receipt.isCurrent()).not.toThrow();
    expect(result.receipt.isCurrent()).toBe(true);
    lease.failClosed();
    expect(() => result.receipt.isCurrent()).not.toThrow();
    expect(result.receipt.isCurrent()).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Pass 3 follow-up - the post-submission fail-closed boundary
 *
 * The defect these cover: once command 99 has been submitted, a lease
 * that dies underneath the attempt used to return MOTOR_TEST_LEASE_
 * INACTIVE without latching anything. Because a released lease leaves the
 * client READY, idle and un-latched, a second lease on the SAME client
 * and SAME client-owned epoch could then be acquired and send command 99
 * a second time in the same official session.
 *
 * The window is real and is exercised here through a real production
 * branch: readCurrentIdentity is caller-supplied code that this module
 * invokes AFTER the ACK and BEFORE its own lease.isActive() check, so a
 * provider with a side effect reaches exactly the state that used to
 * escape. Every test below asserts the branch was actually reached
 * rather than assuming it.
 * ------------------------------------------------------------------ */

describe('post-submission boundary: a dead lease cannot re-open the session', () => {
  /** Acquires lease B on the SAME client/epoch and proves it is refused
   * with zero requester calls and zero transport writes. */
  async function expectLeaseBRefused(
    transport: FakeMspTransport,
    client: MspClient,
    reason: string,
  ): Promise<void> {
    const leaseB = leaseFor(client);
    // Lease B genuinely belongs to the same official session.
    expect(leaseB.isActive()).toBe(true);
    const boxIdsB = await mintBoxIds(transport, leaseB);
    const writesBefore = transport.writes.length;

    const retry = await establishMotorArmingRestriction({
      lease: leaseB,
      requestedIdentity: identity(),
      readCurrentIdentity: () => identity(),
      boxIds: boxIdsB,
    });
    expectNotEstablished(retry, reason);
    // Rejected before lease.request, before MSP queue admission and
    // before any transport write: nothing new was ever issued.
    expect(transport.writes.length).toBe(writesBefore);
    await flushMicrotasks();
    expect(transport.writes.length).toBe(writesBefore);
  }

  /**
   * Runs an establishment whose identity provider releases lease A on its
   * `releaseOnCall`-th invocation - call 2 is the post-ACK revalidation,
   * call 3 the post-status one. Returns the outcome plus the observed
   * call count so the caller can prove the branch was reached.
   */
  async function establishWithReleaseAt(
    transport: FakeMspTransport,
    lease: MotorTestLease,
    releaseOnCall: 2 | 3,
  ): Promise<{result: MotorArmingRestrictionEstablishment; calls: number}> {
    let calls = 0;
    let released: string | undefined;
    const promise = establishMotorArmingRestriction({
      lease,
      requestedIdentity: identity(),
      readCurrentIdentity: () => {
        calls += 1;
        if (calls === releaseOnCall) {
          released = lease.release();
        }
        return identity();
      },
      boxIds: MINTED.get(lease),
    });

    await flushMicrotasks();
    transport.resolveNextWrite();
    await flushMicrotasks();
    transport.emitData(responseFrame(MSP_SET_ARMING_DISABLED));
    await flushMicrotasks();
    if (releaseOnCall === 3) {
      transport.resolveNextWrite();
      await flushMicrotasks();
      transport.emitData(responseFrame(MSP_STATUS_EX, statusPayload()));
    }
    const result = await promise;
    // The release really did happen, on the real lease, at the intended
    // point - not skipped, not refused as LEASE_WORK_UNSETTLED.
    expect(released).toBe('RELEASED');
    expect(calls).toBeGreaterThanOrEqual(releaseOnCall);
    expect(lease.isActive()).toBe(false);
    return {result, calls};
  }

  it('latches the session when the lease dies right after command 99', async () => {
    const {transport, client, lease: leaseA} = await standardSetup();
    const {result} = await establishWithReleaseAt(transport, leaseA, 2);
    // Typed reason fidelity is unchanged - it is still the truthful one.
    expectNotEstablished(result, 'MOTOR_TEST_LEASE_INACTIVE');
    await expectLeaseBRefused(transport, client, 'ARMING_RESTRICTION_FAULT_LATCHED');
  });

  it('latches the session when the lease dies after the command 150 response', async () => {
    const {transport, client, lease: leaseA} = await standardSetup();
    const {result} = await establishWithReleaseAt(transport, leaseA, 3);
    expectNotEstablished(result, 'MOTOR_TEST_LEASE_INACTIVE');
    await expectLeaseBRefused(transport, client, 'ARMING_RESTRICTION_FAULT_LATCHED');
  });

  it('keeps command 99 at exactly one submission across the whole session', async () => {
    const {transport, client, lease: leaseA} = await standardSetup();
    const commands: number[] = [];
    /** Drains the pending-write queue into a cumulative command log. */
    const record = () => {
      for (const write of transport.writes) {
        commands.push(write.data[4]);
      }
    };

    let calls = 0;
    const promise = establishMotorArmingRestriction({
      lease: leaseA,
      requestedIdentity: identity(),
      readCurrentIdentity: () => {
        calls += 1;
        if (calls === 2) {
          expect(leaseA.release()).toBe('RELEASED');
        }
        return identity();
      },
      boxIds: MINTED.get(leaseA),
    });
    await flushMicrotasks();
    record(); // the single command 99
    transport.resolveNextWrite();
    await flushMicrotasks();
    transport.emitData(responseFrame(MSP_SET_ARMING_DISABLED));
    expectNotEstablished(await promise, 'MOTOR_TEST_LEASE_INACTIVE');
    await flushMicrotasks();
    record();

    const leaseB = leaseFor(client);
    const boxIdsB = await mintBoxIds(transport, leaseB);
    expectNotEstablished(
      await establishMotorArmingRestriction({
        lease: leaseB,
        requestedIdentity: identity(),
        readCurrentIdentity: () => identity(),
        boxIds: boxIdsB,
      }),
      'ARMING_RESTRICTION_FAULT_LATCHED',
    );
    await flushMicrotasks();
    record();

    expect(commands.filter(command => command === MSP_SET_ARMING_DISABLED)).toHaveLength(1);
    expect(commands).not.toContain(214);
  });

  it('does not let releasing lease A clear the fault', async () => {
    const {transport, client, lease: leaseA} = await standardSetup();
    await establishWithReleaseAt(transport, leaseA, 2);
    // A already released once; releasing again changes nothing either.
    expect(leaseA.release()).toBe('ALREADY_RELEASED');
    await expectLeaseBRefused(transport, client, 'ARMING_RESTRICTION_FAULT_LATCHED');
  });

  it('cleans the in-progress marker without clearing the fault', async () => {
    const {transport, client, lease: leaseA} = await standardSetup();
    await establishWithReleaseAt(transport, leaseA, 2);
    const leaseB = leaseFor(client);
    const boxIdsB = await mintBoxIds(transport, leaseB);
    const retry = await establishMotorArmingRestriction({
      lease: leaseB,
      requestedIdentity: identity(),
      readCurrentIdentity: () => identity(),
      boxIds: boxIdsB,
    });
    // FAULT_LATCHED, never ALREADY_ESTABLISHING: the in-progress marker
    // was cleaned up, and the fault is what refuses the retry.
    expectNotEstablished(retry, 'ARMING_RESTRICTION_FAULT_LATCHED');
  });

  it('faults the session when the identity provider throws after command 99', async () => {
    const {transport, client, lease: leaseA} = await standardSetup();
    let calls = 0;
    const result = await runEstablishment(
      transport,
      leaseA,
      {current: identity() as MspSessionCompositeIdentity | undefined},
      {
        readCurrentIdentity: () => {
          calls += 1;
          if (calls >= 2) {
            throw new Error('provider exploded after ACK');
          }
          return identity();
        },
      },
    );
    expectNotEstablished(result, 'SESSION_IDENTITY_PROVIDER_FAILED');
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(leaseA.isActive()).toBe(false);

    // Here the lease was still LIVE when it faulted, so Pass 2's own
    // epoch latch fires too and lease B cannot even be acquired.
    const blocked = acquireMotorTestLease({
      client,
      requestedIdentity: identity(),
      readCurrentIdentity: () => identity(),
    });
    expect(blocked).toEqual({
      kind: 'NOT_ACQUIRED',
      reason: 'MOTOR_TEST_LEASE_FAULT_LATCHED',
    });
  });

  it('fails the session closed when an unexpected exception escapes after command 99', async () => {
    const {transport, client, lease: leaseA} = await standardSetup();
    let calls = 0;
    const promise = establishMotorArmingRestriction({
      lease: leaseA,
      requestedIdentity: identity(),
      readCurrentIdentity: () => {
        calls += 1;
        if (calls === 2) {
          // Not a throwing PROVIDER - the provider returns normally and
          // the exception escapes later, from the comparison itself. That
          // is an unexpected exception, outside every typed catch.
          return {
            physicalGeneration: 2,
            get mspEpoch(): number {
              throw new Error('unexpected defect after submission');
            },
          } as unknown as MspSessionCompositeIdentity;
        }
        return identity();
      },
      boxIds: MINTED.get(leaseA),
    });
    const settled = promise.catch((error: unknown) => error);
    await flushMicrotasks();
    transport.resolveNextWrite();
    await flushMicrotasks();
    transport.emitData(responseFrame(MSP_SET_ARMING_DISABLED));
    const escaped = await settled;
    // A genuine defect is NOT swallowed into a typed reason...
    expect(escaped).toBeInstanceOf(Error);
    expect((escaped as Error).message).toBe('unexpected defect after submission');
    expect(calls).toBeGreaterThanOrEqual(2);
    // ...but the session is fail-closed regardless.
    expect(leaseA.isActive()).toBe(false);
    const blocked = acquireMotorTestLease({
      client,
      requestedIdentity: identity(),
      readCurrentIdentity: () => identity(),
    });
    expect(blocked).toEqual({
      kind: 'NOT_ACQUIRED',
      reason: 'MOTOR_TEST_LEASE_FAULT_LATCHED',
    });
  });

  it('does not latch anything when admission fails before any traffic', async () => {
    const {transport, lease, identityBox} = await standardSetup();
    const writesBefore = transport.writes.length;
    expectNotEstablished(
      await runEstablishment(transport, lease, identityBox, {
        requestedIdentity: identity(4, 4),
      }),
      'REQUESTED_SESSION_IDENTITY_MISMATCH',
    );
    expect(transport.writes.length).toBe(writesBefore);
    expect(lease.isActive()).toBe(true);
    // No success record AND no fault record: the session is untouched and
    // still establishable.
    expect((await runEstablishment(transport, lease, identityBox)).kind).toBe('ESTABLISHED');
  });

  it('does not let one session\'s fault reach a genuinely new session', async () => {
    const faulted = await standardSetup();
    await establishWithReleaseAt(faulted.transport, faulted.lease, 2);
    await expectLeaseBRefused(
      faulted.transport,
      faulted.client,
      'ARMING_RESTRICTION_FAULT_LATCHED',
    );

    // A brand-new client is a brand-new official session.
    const fresh = await standardSetup();
    const result = await runEstablishment(fresh.transport, fresh.lease, fresh.identityBox);
    expect(result.kind).toBe('ESTABLISHED');
    if (result.kind !== 'ESTABLISHED') {
      throw new Error('unreachable');
    }
    expect(result.receipt.isCurrent()).toBe(true);
  });

  it('mints no receipt and no success record on any latched path', async () => {
    const {transport, client, lease: leaseA} = await standardSetup();
    const {result} = await establishWithReleaseAt(transport, leaseA, 3);
    expect(result.kind).toBe('NOT_ESTABLISHED');
    expect(Object.keys(result)).not.toContain('receipt');
    // The session record is a FAULT, so a later lease is refused with the
    // fault reason - never ALREADY_ESTABLISHED.
    await expectLeaseBRefused(transport, client, 'ARMING_RESTRICTION_FAULT_LATCHED');
  });

  it('keeps concurrent establishment atomic on the latched path', async () => {
    const {transport, lease, identityBox} = await standardSetup();
    let calls = 0;
    const first = establishMotorArmingRestriction({
      lease,
      requestedIdentity: identity(),
      readCurrentIdentity: () => {
        calls += 1;
        if (calls === 2) {
          expect(lease.release()).toBe('RELEASED');
        }
        return identityBox.current;
      },
      boxIds: MINTED.get(lease),
    });
    // While the first is in flight, a second attempt on the same session
    // is refused as ALREADY_ESTABLISHING - not admitted, not queued.
    expectNotEstablished(
      await establishMotorArmingRestriction({
        lease,
        requestedIdentity: identity(),
        readCurrentIdentity: () => identityBox.current,
        boxIds: MINTED.get(lease),
      }),
      'ARMING_RESTRICTION_ALREADY_ESTABLISHING',
    );
    transport.resolveNextWrite();
    await flushMicrotasks();
    transport.emitData(responseFrame(MSP_SET_ARMING_DISABLED));
    expectNotEstablished(await first, 'MOTOR_TEST_LEASE_INACTIVE');
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});

/* ===================================================================== *
 * P2-i - the RELEASE payload.
 *
 * Polarity is inverted from the command name, so it is asserted against
 * the pinned firmware branch rather than against the identifier:
 * MSP_SET_ARMING_DISABLED command==1 DISABLES arming, command==0 ENABLES
 * it (msp.c @ 79065c96). Building bytes is inert; nothing here sends
 * anything or claims a physical state.
 * ===================================================================== */
describe('P2-i arming restriction release payload', () => {
  it('encodes exactly one byte, zero, which is the ENABLE-arming command', () => {
    expect(ARMING_ENABLE_COMMAND_BYTE).toBe(0);
    expect(Array.from(buildArmingReleasePayload())).toEqual([0]);
  });

  it('is the exact inverse of the establish payload', () => {
    expect(Array.from(buildArmingDisablePayload())).toEqual([1]);
    expect(ARMING_DISABLE_COMMAND_BYTE).not.toBe(ARMING_ENABLE_COMMAND_BYTE);
  });

  it('returns a fresh buffer every call, so no caller can mutate a shared one', () => {
    const first = buildArmingReleasePayload();
    const second = buildArmingReleasePayload();
    expect(first).not.toBe(second);
    first[0] = 99;
    expect(Array.from(buildArmingReleasePayload())).toEqual([0]);
  });

  it('emits the one-byte form, leaving runaway-takeoff handling to the firmware default', () => {
    // msp.c reads the optional second byte only when bytes remain.
    expect(buildArmingReleasePayload()).toHaveLength(1);
  });
});

/* =====================================================================
 * RECORDING THE RELEASE - the deep half of the motor-session reopen bug.
 *
 * The establishment record is keyed by the OFFICIAL SESSION AUTHORITY and
 * deliberately outlives an ordinary lease release, so one physical
 * session sends command 99 exactly once. Nothing, however, ever told this
 * module when the hold was actually RELEASED: teardown owns that request,
 * because it owns the ordering rule that the all-stop must come first. So
 * after one clean motor session the record still read ESTABLISHED, and
 * the operator's SECOND session on the same cable was refused at
 * ARMING_RESTRICTION_ALREADY_ESTABLISHED and failed closed at setup.
 *
 * These pin the narrow contract that closes it, and - just as important -
 * the three cases that must NOT clear anything.
 * ===================================================================== */
describe('recording an arming-restriction release', () => {
  it('lets the NEXT session establish its own restriction', async () => {
    const {transport, client, lease: leaseA} = await standardSetup();
    const first = await runEstablishment(transport, leaseA, {
      current: identity() as MspSessionCompositeIdentity | undefined,
    });
    if (first.kind !== 'ESTABLISHED') {
      throw new Error('unreachable');
    }
    // Exactly what teardown does: release the hold, then say so.
    expect(recordMotorArmingRestrictionReleased(first.receipt)).toBe('CLEARED');
    expect(leaseA.release()).toBe('RELEASED');

    const leaseB = leaseFor(client); // same client, same official session
    const boxIdsB = await mintBoxIds(transport, leaseB);
    const second = await runEstablishment(
      transport,
      leaseB,
      {current: identity() as MspSessionCompositeIdentity | undefined},
      {boxIds: boxIdsB},
    );

    expect(second.kind).toBe('ESTABLISHED');
  });

  it('makes the cleared receipt non-current', async () => {
    const {transport, lease} = await standardSetup();
    const first = await runEstablishment(transport, lease, {
      current: identity() as MspSessionCompositeIdentity | undefined,
    });
    if (first.kind !== 'ESTABLISHED') {
      throw new Error('unreachable');
    }
    expect(first.receipt.isCurrent()).toBe(true);

    recordMotorArmingRestrictionReleased(first.receipt);

    // The record is gone, so the receipt describes nothing live - which
    // is true: this descriptor's hold has been released.
    expect(first.receipt.isCurrent()).toBe(false);
  });

  it('is idempotent - a second call clears nothing further', async () => {
    const {transport, lease} = await standardSetup();
    const first = await runEstablishment(transport, lease, {
      current: identity() as MspSessionCompositeIdentity | undefined,
    });
    if (first.kind !== 'ESTABLISHED') {
      throw new Error('unreachable');
    }
    expect(recordMotorArmingRestrictionReleased(first.receipt)).toBe('CLEARED');
    expect(recordMotorArmingRestrictionReleased(first.receipt)).toBe('NOT_CURRENT');
  });

  it('NEVER revives a session that has since failed closed', async () => {
    // The sequence a stale caller can really produce: session one closes
    // cleanly and records its release; session two fails closed and
    // latches; then something still holding session one's receipt records
    // the release again. That must not clear the latch - a failed-closed
    // session stays refused until a genuinely new authority exists.
    const {transport, client, lease: leaseA} = await standardSetup();
    const first = await runEstablishment(transport, leaseA, {
      current: identity() as MspSessionCompositeIdentity | undefined,
    });
    if (first.kind !== 'ESTABLISHED') {
      throw new Error('unreachable');
    }
    expect(recordMotorArmingRestrictionReleased(first.receipt)).toBe('CLEARED');
    expect(leaseA.release()).toBe('RELEASED');

    // Session two: the flight controller does NOT show the restriction
    // after acknowledging it, so establishment fails closed and latches.
    const leaseB = leaseFor(client);
    const boxIdsB = await mintBoxIds(transport, leaseB);
    const second = await runEstablishment(
      transport,
      leaseB,
      {current: identity() as MspSessionCompositeIdentity | undefined},
      {boxIds: boxIdsB, status: {mspRestrictionPresent: false}},
    );
    expectNotEstablished(second, 'MSP_ARMING_RESTRICTION_NOT_OBSERVED');

    // The stale record attempt changes nothing...
    expect(recordMotorArmingRestrictionReleased(first.receipt)).not.toBe(
      'CLEARED',
    );
    // ...and the latch still holds: the client cannot even take another
    // motor-test lease, let alone establish a restriction on one.
    const third = acquireMotorTestLease({
      client,
      requestedIdentity: identity(),
      readCurrentIdentity: () => identity(),
    });
    expect(third.kind).toBe('NOT_ACQUIRED');
    if (third.kind !== 'ACQUIRED') {
      expect(third.reason).toBe('MOTOR_TEST_LEASE_FAULT_LATCHED');
    }
  });

  it('puts NOTHING on the wire - it is bookkeeping, not a release', async () => {
    // The property the module-surface guard above actually protects. A
    // self-issuing release would let any holder of a receipt re-permit
    // arming without the all-stop that must come first; this function
    // cannot, because it has no lease, no client and no transport.
    const {transport, lease} = await standardSetup();
    const first = await runEstablishment(transport, lease, {
      current: identity() as MspSessionCompositeIdentity | undefined,
    });
    if (first.kind !== 'ESTABLISHED') {
      throw new Error('unreachable');
    }
    const writesBefore = transport.writeLog.length;

    expect(recordMotorArmingRestrictionReleased(first.receipt)).toBe('CLEARED');
    await flushMicrotasks();

    expect(transport.writeLog.length).toBe(writesBefore);
    expect(transport.writes).toHaveLength(0);
  });

  it('refuses a forged or copied receipt', async () => {
    const {transport, lease} = await standardSetup();
    const first = await runEstablishment(transport, lease, {
      current: identity() as MspSessionCompositeIdentity | undefined,
    });
    if (first.kind !== 'ESTABLISHED') {
      throw new Error('unreachable');
    }
    // Same anti-forgery rule as isCurrent(): strict instance identity.
    const hand = new MotorArmingRestrictionReceipt(identity());
    const spread = {...first.receipt} as MotorArmingRestrictionReceipt;

    expect(recordMotorArmingRestrictionReleased(hand)).toBe('NOT_CURRENT');
    expect(recordMotorArmingRestrictionReleased(spread)).toBe('NOT_CURRENT');
    // ...and the genuine record survived both attempts untouched.
    expect(first.receipt.isCurrent()).toBe(true);
  });
});
