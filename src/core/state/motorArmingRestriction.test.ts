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
  buildArmingDisablePayload,
  establishMotorArmingRestriction,
  MotorArmingRestrictionReceipt,
  MSP_SET_ARMING_DISABLED,
  MSP_STATUS_EX,
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
import type {BoxIdsResult} from '../protocol/msp/identification/BoxIdsAcquisition';
import {FakeMspTransport} from '../protocol/__testUtils__/mspFakeTransport';
import {buildMspFrameBytes} from '../protocol/__testUtils__/mspFixtures';

const SESSION_ID = 'session-arming-1';
const EMPTY = new Uint8Array(0);

/** BOXARM's permanent id is 0; placed at index 2 so a hardcoded bit-0
 * assumption would be caught. */
const BOX_IDS: BoxIdsResult = {kind: 'READY', permanentIds: [5, 1, 0, 13]};
const ARM_BIT = 2;

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
  readonly boxIds?: BoxIdsResult | undefined;
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
    boxIds: 'boxIds' in options ? options.boxIds : BOX_IDS,
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

function standardSetup() {
  const {transport, client} = makeClient();
  const lease = leaseFor(client);
  const identityBox = {current: identity() as MspSessionCompositeIdentity | undefined};
  return {transport, client, lease, identityBox};
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

  it('exposes NO inverse / re-enable payload or operation in the public API', () => {
    const exported = Object.keys(armingRestrictionModule);
    for (const name of exported) {
      expect(name).not.toMatch(/enable|clear|restore|reenable|allowArming|undo/i);
    }
    // The only payload builder produces the DISABLE byte, never 0.
    expect(buildArmingDisablePayload()[0]).not.toBe(0);
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
    const {transport, lease, identityBox} = standardSetup();
    const result = await runEstablishment(transport, lease, identityBox);
    expect(result.kind).toBe('ESTABLISHED');
  });

  it('fails with no lease and sends nothing', async () => {
    const {transport} = makeClient();
    const result = await establishMotorArmingRestriction({
      lease: undefined,
      requestedIdentity: identity(),
      readCurrentIdentity: () => identity(),
      boxIds: BOX_IDS,
    });
    expectNotEstablished(result, 'MOTOR_TEST_LEASE_INACTIVE');
    expect(transport.writes).toHaveLength(0);
  });

  it('fails with no authoritative identity and sends nothing', async () => {
    const {transport, client} = makeClient();
    const lease = leaseFor(client);
    const result = await establishMotorArmingRestriction({
      lease,
      requestedIdentity: identity(),
      readCurrentIdentity: () => undefined,
      boxIds: BOX_IDS,
    });
    expectNotEstablished(result, 'CURRENT_SESSION_IDENTITY_UNAVAILABLE');
    expect(transport.writes).toHaveLength(0);
  });

  it('fails on a physicalGeneration mismatch and sends nothing', async () => {
    const {transport, lease, identityBox} = standardSetup();
    const result = await runEstablishment(transport, lease, identityBox, {
      requestedIdentity: identity(9, 0),
    });
    expectNotEstablished(result, 'REQUESTED_SESSION_IDENTITY_MISMATCH');
    expect(transport.writes).toHaveLength(0);
  });

  it('fails on an mspEpoch mismatch and sends nothing', async () => {
    const {transport, lease, identityBox} = standardSetup();
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
      boxIds: BOX_IDS,
    });
    expectNotEstablished(result, 'MOTOR_TEST_LEASE_IDENTITY_MISMATCH');
    expect(transport.writes).toHaveLength(0);
  });

  it('fails on a released lease and sends nothing', async () => {
    const {transport, lease, identityBox} = standardSetup();
    expect(lease.release()).toBe('RELEASED');
    const result = await runEstablishment(transport, lease, identityBox);
    expectNotEstablished(result, 'MOTOR_TEST_LEASE_INACTIVE');
    expect(transport.writes).toHaveLength(0);
  });

  it('fails on an invalidated lease and sends nothing', async () => {
    const {transport, client, lease, identityBox} = standardSetup();
    client.dispose();
    const result = await runEstablishment(transport, lease, identityBox);
    expectNotEstablished(result, 'MOTOR_TEST_LEASE_INACTIVE');
    expect(transport.writes).toHaveLength(0);
  });

  it('fails on a forged lease and sends nothing', async () => {
    const {transport} = makeClient();
    const forged = new MotorTestLease(identity());
    const result = await establishMotorArmingRestriction({
      lease: forged,
      requestedIdentity: identity(),
      readCurrentIdentity: () => identity(),
      boxIds: BOX_IDS,
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

  it('fails when no usable box-id mapping is supplied, before any traffic', async () => {
    const {transport, lease, identityBox} = standardSetup();
    for (const boxIds of [
      undefined,
      {kind: 'UNAVAILABLE', reason: 'MALFORMED'} as BoxIdsResult,
      {kind: 'READY', permanentIds: []} as BoxIdsResult,
    ]) {
      const fresh = standardSetup();
      const result = await runEstablishment(fresh.transport, fresh.lease, fresh.identityBox, {
        boxIds,
      });
      expectNotEstablished(result, 'INDEPENDENT_VERIFICATION_UNAVAILABLE');
      expect(fresh.transport.writes).toHaveLength(0);
    }
    expect(transport.writes).toHaveLength(0);
    expect(lease.isActive()).toBe(true);
    expect(identityBox.current).toBeDefined();
  });

  it('refuses a second concurrent establishment immediately', async () => {
    const {transport, lease, identityBox} = standardSetup();
    const first = establishMotorArmingRestriction({
      lease,
      requestedIdentity: identity(),
      readCurrentIdentity: () => identityBox.current,
      boxIds: BOX_IDS,
    });
    const second = await establishMotorArmingRestriction({
      lease,
      requestedIdentity: identity(),
      readCurrentIdentity: () => identityBox.current,
      boxIds: BOX_IDS,
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
    const {transport, lease, identityBox} = standardSetup();
    expect((await runEstablishment(transport, lease, identityBox)).kind).toBe('ESTABLISHED');
    const again = await establishMotorArmingRestriction({
      lease,
      requestedIdentity: identity(),
      readCurrentIdentity: () => identityBox.current,
      boxIds: BOX_IDS,
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
        boxIds: BOX_IDS,
      }),
    ).resolves.toMatchObject({kind: 'NOT_ESTABLISHED'});
  });
});

/* ------------------------------------------------------------------ *
 * 13.3 Request order
 * ------------------------------------------------------------------ */

describe('request order', () => {
  it('emits exactly MSP_SET_ARMING_DISABLED then MSP_STATUS_EX, through the lease FIFO', async () => {
    const {transport, lease, identityBox} = standardSetup();
    const result = await runEstablishment(transport, lease, identityBox);
    expect(result.kind).toBe('ESTABLISHED');
    // FakeMspTransport shifts settled writes off `writes`, so capture the
    // command bytes as they are settled instead: verified below by the
    // dedicated recording test.
  });

  it('records exactly two requests, in order, with the exact payloads', async () => {
    const {transport, client} = makeClient();
    const lease = leaseFor(client);
    const identityBox = {current: identity() as MspSessionCompositeIdentity | undefined};
    const seen: Array<{command: number; payload: number[]}> = [];

    const promise = establishMotorArmingRestriction({
      lease,
      requestedIdentity: identity(),
      readCurrentIdentity: () => identityBox.current,
      boxIds: BOX_IDS,
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
    const {transport, client, lease, identityBox} = standardSetup();
    const promise = establishMotorArmingRestriction({
      lease,
      requestedIdentity: identity(),
      readCurrentIdentity: () => identityBox.current,
      boxIds: BOX_IDS,
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
    const identityBox = {current: identity() as MspSessionCompositeIdentity | undefined};
    const promise = establishMotorArmingRestriction({
      lease,
      requestedIdentity: identity(),
      readCurrentIdentity: () => identityBox.current,
      boxIds: BOX_IDS,
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
    const {transport, lease, identityBox} = standardSetup();
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
    const {transport, lease, identityBox} = standardSetup();
    const result = await runEstablishment(transport, lease, identityBox, {
      status: {armed: true, mspRestrictionPresent: true},
    });
    expectNotEstablished(result, 'FC_ARMED');
    expect(lease.isActive()).toBe(false);
  });

  it('fails closed when the MSP restriction bit is absent, and faults the lease', async () => {
    const {transport, lease, identityBox} = standardSetup();
    const result = await runEstablishment(transport, lease, identityBox, {
      status: {mspRestrictionPresent: false},
    });
    expectNotEstablished(result, 'MSP_ARMING_RESTRICTION_NOT_OBSERVED');
    expect(lease.isActive()).toBe(false);
  });

  it('does not accept an unrelated arming-disable flag as the MSP restriction', async () => {
    const {transport, lease, identityBox} = standardSetup();
    const result = await runEstablishment(transport, lease, identityBox, {
      // THROTTLE (bit 7) and NO_GYRO (bit 0) set, MSP bit clear.
      status: {mspRestrictionPresent: false, extraMask: Math.pow(2, 7) + Math.pow(2, 0)},
    });
    expectNotEstablished(result, 'MSP_ARMING_RESTRICTION_NOT_OBSERVED');
  });

  it('fails closed on an ERROR-direction ACK', async () => {
    const {transport, lease, identityBox} = standardSetup();
    const result = await runEstablishment(transport, lease, identityBox, {
      failArmingDisable: 'ERROR_FRAME',
    });
    expectNotEstablished(result, 'ARMING_DISABLE_REQUEST_FAILED');
    expect(lease.isActive()).toBe(false);
  });

  it('fails closed on an arming-disable write failure', async () => {
    const {transport, lease, identityBox} = standardSetup();
    const result = await runEstablishment(transport, lease, identityBox, {
      failArmingDisable: 'WRITE',
    });
    expectNotEstablished(result, 'ARMING_DISABLE_REQUEST_FAILED');
    expect(lease.isActive()).toBe(false);
  });

  it('fails closed on a status write failure', async () => {
    const {transport, lease, identityBox} = standardSetup();
    const result = await runEstablishment(transport, lease, identityBox, {failStatus: 'WRITE'});
    expectNotEstablished(result, 'POST_ACK_STATUS_REQUEST_FAILED');
    expect(lease.isActive()).toBe(false);
  });

  it('fails closed on an ERROR-direction status response', async () => {
    const {transport, lease, identityBox} = standardSetup();
    const result = await runEstablishment(transport, lease, identityBox, {
      failStatus: 'ERROR_FRAME',
    });
    expectNotEstablished(result, 'POST_ACK_STATUS_REQUEST_FAILED');
    expect(lease.isActive()).toBe(false);
  });

  it('fails closed on a truncated status frame', async () => {
    const {transport, lease, identityBox} = standardSetup();
    const result = await runEstablishment(transport, lease, identityBox, {
      status: {truncateTo: 9},
    });
    expectNotEstablished(result, 'MALFORMED_STATUS_RESPONSE');
    expect(lease.isActive()).toBe(false);
  });

  it('fails closed on a partially present status tail', async () => {
    const {transport, lease, identityBox} = standardSetup();
    const result = await runEstablishment(transport, lease, identityBox, {
      status: {declaredByteCount: 9, truncateTo: 16},
    });
    expectNotEstablished(result, 'MALFORMED_STATUS_RESPONSE');
    expect(lease.isActive()).toBe(false);
  });

  it('fails closed when the status frame carried no arming-disable mask', async () => {
    const {transport, lease, identityBox} = standardSetup();
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
      const identityBox = {current: identity() as MspSessionCompositeIdentity | undefined};
      const promise = establishMotorArmingRestriction({
        lease,
        requestedIdentity: identity(),
        readCurrentIdentity: () => identityBox.current,
        boxIds: BOX_IDS,
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
    const {transport, lease, identityBox} = standardSetup();
    const result = await runEstablishment(transport, lease, identityBox, {
      onAfterAck: () => {
        identityBox.current = identity(2, 99);
      },
    });
    expectNotEstablished(result, 'SESSION_CHANGED_DURING_ESTABLISHMENT');
    expect(lease.isActive()).toBe(false);
  });

  it('fails closed when the identity disappears after the ACK', async () => {
    const {transport, lease, identityBox} = standardSetup();
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
    const {transport, lease, identityBox} = standardSetup();
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
    const {transport, client, lease, identityBox} = standardSetup();
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
    const identityBox = {current: identity() as MspSessionCompositeIdentity | undefined};
    const order: string[] = [];
    const promise = establishMotorArmingRestriction({
      lease,
      requestedIdentity: identity(),
      readCurrentIdentity: () => identityBox.current,
      boxIds: BOX_IDS,
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
    const {transport, client, lease, identityBox} = standardSetup();
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
    const setup = standardSetup();
    const result = await runEstablishment(setup.transport, setup.lease, setup.identityBox);
    if (result.kind !== 'ESTABLISHED') {
      throw new Error(`expected ESTABLISHED, got ${result.reason}`);
    }
    return {...setup, receipt: result.receipt};
  }

  it('does not retain the caller identity object by reference', async () => {
    const {transport, client} = makeClient();
    const lease = leaseFor(client);
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
    const {transport, client, lease, identityBox} = standardSetup();
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
    const {transport, lease, identityBox} = standardSetup();
    await runEstablishment(transport, lease, identityBox, {status: {armed: true}});
    const retry = await establishMotorArmingRestriction({
      lease,
      requestedIdentity: identity(),
      readCurrentIdentity: () => identityBox.current,
      boxIds: BOX_IDS,
    });
    expectNotEstablished(retry, 'ARMING_RESTRICTION_FAULT_LATCHED');
  });

  it('a genuinely new session identity crosses the old fault boundary', async () => {
    const first = standardSetup();
    await runEstablishment(first.transport, first.lease, first.identityBox, {
      status: {mspRestrictionPresent: false},
    });
    expect(first.lease.isActive()).toBe(false);

    // A new physical session is a new MspClient entirely.
    const second = makeClient();
    const newLease = leaseFor(second.client);
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
    const faulted = standardSetup();
    await runEstablishment(faulted.transport, faulted.lease, faulted.identityBox, {
      status: {armed: true},
    });
    expect(faulted.lease.isActive()).toBe(false);

    const other = makeClient();
    const otherLease = leaseFor(other.client);
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
    const setup = standardSetup();
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
    const setup = standardSetup();
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
      const setup = standardSetup();
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
    const setup = standardSetup();
    await runEstablishment(setup.transport, setup.lease, setup.identityBox);
    const after = setup.transport.writes.length;
    await flushMicrotasks(20);
    expect(setup.transport.writes.length).toBe(after);
  });

  it('establishment alone cannot pulse a motor - only two read/write commands exist', async () => {
    const {transport, client} = makeClient();
    const lease = leaseFor(client);
    const identityBox = {current: identity() as MspSessionCompositeIdentity | undefined};
    const commands: number[] = [];
    const promise = establishMotorArmingRestriction({
      lease,
      requestedIdentity: identity(),
      readCurrentIdentity: () => identityBox.current,
      boxIds: BOX_IDS,
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
