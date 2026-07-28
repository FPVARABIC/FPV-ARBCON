/**
 * Phase 2C - adversarial tests for the coordinator-wide motor-test
 * telemetry barrier.
 *
 * These use the REAL exported `MotorTestTelemetryRegistry`. The only
 * fakes are narrow scheduler stands-in that implement exactly the two
 * methods the barrier is allowed to call (`acquirePauseLease`,
 * `waitUntilIdle`) - the barrier's own algorithm is never reimplemented
 * here.
 *
 * Some tests additionally drive REAL production objects end to end:
 *  - the REAL `MspTelemetryScheduler`, proving a real scheduler both
 *    satisfies this interface and is genuinely held off;
 *  - the REAL `MspClient` together with the real scheduler, proving the
 *    mandatory FIFO case - a poll ACCEPTED BY THE CLIENT BUT NOT YET
 *    WRITTEN, i.e. genuinely queued behind an active request, is awaited.
 *    That case is deliberately NOT represented by the scheduler fake:
 *    only the real client can queue.
 *
 * The FIFO tests prove queue position without touching any private
 * state: a request the client has accepted but not yet written produces
 * no transport write, and the poll's own frame appears on the transport
 * only after the preceding request settles.
 *
 * No hardware, no USB, no MSP motor command. The barrier cannot send
 * anything; it can only hold polling off and wait.
 */

import {
  MOTOR_TEST_QUIESCENCE_TIMEOUT_MILLIS,
  MotorTestTelemetryRegistry,
  MotorTestTelemetrySession,
  TRANSPORT_WRITE_BOUND_MILLIS,
  type MotorTestBarrierScheduler,
  type MotorTestBarrierTimers,
} from './motorTestTelemetryBarrier';
import {MSP_RESPONSE_TIMEOUT_MILLIS, MspClient} from '../mspClient';
import {createMspTelemetryScheduler} from './MspTelemetryScheduler';
import {FakeClock} from './clock';
import {FakeMspTransport} from '../__testUtils__/mspFakeTransport';
import {buildMspFrameBytes} from '../__testUtils__/mspFixtures';
import type {TelemetryPauseLease, TelemetryPauseReason} from './telemetryTypes';

/* ------------------------------------------------------------------ *
 * Narrow fakes
 * ------------------------------------------------------------------ */

/** Records every lease taken on it and lets a test hold `waitUntilIdle`
 * open, which is how "already dispatched / awaiting a response / already
 * in the client FIFO" is represented: in all three cases the scheduler's
 * own dispatch promise has not settled. */
class FakeScheduler implements MotorTestBarrierScheduler {
  readonly leases: {reason: TelemetryPauseReason; released: boolean}[] = [];
  private idleResolvers: (() => void)[] = [];
  private busy = false;

  acquirePauseLease(reason: TelemetryPauseReason): TelemetryPauseLease {
    const record = {reason, released: false};
    this.leases.push(record);
    return {
      id: `${reason}-${this.leases.length}`,
      release: () => {
        record.released = true;
      },
    };
  }

  waitUntilIdle(): Promise<void> {
    if (!this.busy) {
      return Promise.resolve();
    }
    return new Promise<void>(resolve => {
      this.idleResolvers.push(resolve);
    });
  }

  /** Simulates work that has been dispatched and not yet settled. */
  beginWork(): void {
    this.busy = true;
  }

  /** Simulates that work settling. */
  settleWork(): void {
    this.busy = false;
    const waiters = this.idleResolvers;
    this.idleResolvers = [];
    for (const resolve of waiters) {
      resolve();
    }
  }

  get activeLeaseCount(): number {
    return this.leases.filter(lease => !lease.released).length;
  }

  get motorTestLeaseCount(): number {
    return this.leases.filter(lease => lease.reason === 'MOTOR_TEST').length;
  }

  get activeMotorTestLeaseCount(): number {
    return this.leases.filter(
      lease => lease.reason === 'MOTOR_TEST' && !lease.released,
    ).length;
  }
}

/** Deterministic timers: nothing fires until a test says so. */
class ManualTimers implements MotorTestBarrierTimers {
  private pending = new Map<number, {callback: () => void; delayMs: number}>();
  private nextHandle = 1;
  cleared: number[] = [];

  setTimer(callback: () => void, delayMs: number): unknown {
    const handle = this.nextHandle++;
    this.pending.set(handle, {callback, delayMs});
    return handle;
  }

  clearTimer(handle: unknown): void {
    this.cleared.push(handle as number);
    this.pending.delete(handle as number);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  lastDelay(): number | undefined {
    let delay: number | undefined;
    for (const entry of this.pending.values()) {
      delay = entry.delayMs;
    }
    return delay;
  }

  /** Fires every pending deadline, exactly as elapsing time would. */
  fireAll(): void {
    const entries = Array.from(this.pending.values());
    this.pending.clear();
    for (const entry of entries) {
      entry.callback();
    }
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
};

function makeRegistry(timers: MotorTestBarrierTimers = new ManualTimers()) {
  return new MotorTestTelemetryRegistry({timers});
}

/**
 * A REAL `MspClient` over the repository's existing fake transport.
 *
 * Correction B-1 made a session anchor belong to one exact client, so
 * every test now mints its anchor for a genuine client rather than for
 * nothing at all. The client is never asked to do anything here - it is
 * the identity the barrier is coherent with.
 */
let clientCounter = 0;
function makeClient(): MspClient {
  clientCounter += 1;
  return new MspClient(new FakeMspTransport(), `barrier-client-${clientCounter}`);
}

/* ================================================================== *
 * Derived deadline
 * ================================================================== */

describe('the quiescence deadline is derived, not chosen', () => {
  it('equals the transport write bound plus the MSP response timeout', () => {
    expect(TRANSPORT_WRITE_BOUND_MILLIS).toBe(1000);
    expect(MOTOR_TEST_QUIESCENCE_TIMEOUT_MILLIS).toBe(
      TRANSPORT_WRITE_BOUND_MILLIS + MSP_RESPONSE_TIMEOUT_MILLIS,
    );
  });

  it('arms exactly one deadline, with that derived value', async () => {
    const timers = new ManualTimers();
    const registry = makeRegistry(timers);
    const client = makeClient();
    const session = registry.openSession(client);
    const scheduler = new FakeScheduler();
    registry.registerScheduler(session, scheduler);
    scheduler.beginWork();

    const pending = registry.acquireBarrier(session, client);
    await flush();
    expect(timers.pendingCount).toBe(1);
    expect(timers.lastDelay()).toBe(MOTOR_TEST_QUIESCENCE_TIMEOUT_MILLIS);

    scheduler.settleWork();
    await pending;
  });
});

/* ================================================================== *
 * Pausing every producer
 * ================================================================== */

describe('every registered scheduler is paused', () => {
  it('pauses all pre-existing schedulers', async () => {
    const registry = makeRegistry();
    const client = makeClient();
    const session = registry.openSession(client);
    const schedulers = [
      new FakeScheduler(),
      new FakeScheduler(),
      new FakeScheduler(),
    ];
    for (const scheduler of schedulers) {
      registry.registerScheduler(session, scheduler);
    }
    expect(registry.registeredSchedulerCount(session)).toBe(3);

    const result = await registry.acquireBarrier(session, client);
    expect(result.kind).toBe('ACQUIRED');
    for (const scheduler of schedulers) {
      expect(scheduler.activeMotorTestLeaseCount).toBe(1);
    }
  });

  it('pauses synchronously, before the first await', () => {
    const registry = makeRegistry();
    const client = makeClient();
    const session = registry.openSession(client);
    const scheduler = new FakeScheduler();
    registry.registerScheduler(session, scheduler);

    // Do NOT await: the pause must already be in force.
    const pending = registry.acquireBarrier(session, client);
    expect(scheduler.activeMotorTestLeaseCount).toBe(1);
    return pending;
  });

  it('holds a REAL MspTelemetryScheduler off through the registry', async () => {
    const clock = new FakeClock(0);
    const requester = {
      request: jest.fn(),
    };
    const scheduler = createMspTelemetryScheduler(
      requester as never,
      {clock},
    );
    const decode = jest.fn(() => 1);
    scheduler.registerPoll({
      id: 'p',
      command: 1,
      intervalMs: 10,
      staleAfterMs: 50,
      priority: 0,
      decode,
    });

    const registry = makeRegistry();
    const client = makeClient();
    const session = registry.openSession(client);
    registry.registerScheduler(session, scheduler);

    const held = await registry.acquireBarrier(session, client);
    expect(held.kind).toBe('ACQUIRED');

    clock.advance(100);
    scheduler.tick();
    scheduler.tick();
    // The real scheduler dispatched nothing while the barrier was held.
    expect(requester.request).not.toHaveBeenCalled();

    if (held.kind !== 'ACQUIRED') {
      throw new Error('unreachable');
    }
    held.release();
    clock.advance(100);
    scheduler.tick();
    // ... and resumes afterwards, proving the pause was the only reason.
    expect(requester.request).toHaveBeenCalledTimes(1);
  });
});

/* ================================================================== *
 * The registration gate
 * ================================================================== */

describe('the registration gate', () => {
  it('a scheduler registering while held is already paused on return', async () => {
    const registry = makeRegistry();
    const client = makeClient();
    const session = registry.openSession(client);
    const held = await registry.acquireBarrier(session, client);
    expect(held.kind).toBe('ACQUIRED');

    const late = new FakeScheduler();
    registry.registerScheduler(session, late);
    // Paused BEFORE registerScheduler returned - never observable
    // unpaused.
    expect(late.activeMotorTestLeaseCount).toBe(1);
  });

  it('a registration racing an in-progress acquisition cannot escape', async () => {
    const timers = new ManualTimers();
    const registry = makeRegistry(timers);
    const client = makeClient();
    const session = registry.openSession(client);
    const early = new FakeScheduler();
    registry.registerScheduler(session, early);
    early.beginWork();

    const pending = registry.acquireBarrier(session, client);
    await flush();

    // Registers midway through the awaited quiescence.
    const racing = new FakeScheduler();
    registry.registerScheduler(session, racing);
    expect(racing.activeMotorTestLeaseCount).toBe(1);

    early.settleWork();
    const result = await pending;
    expect(result.kind).toBe('ACQUIRED');
    // And the late arrival's own work was awaited too.
    expect(racing.activeMotorTestLeaseCount).toBe(1);
  });

  it('awaits a scheduler that registers with work already outstanding', async () => {
    const timers = new ManualTimers();
    const registry = makeRegistry(timers);
    const client = makeClient();
    const session = registry.openSession(client);
    const early = new FakeScheduler();
    registry.registerScheduler(session, early);
    early.beginWork();

    const pending = registry.acquireBarrier(session, client);
    await flush();

    const racing = new FakeScheduler();
    racing.beginWork();
    registry.registerScheduler(session, racing);
    early.settleWork();
    await flush();

    let settled = false;
    const observed = pending.then(() => {
      settled = true;
    });
    await flush();
    // Still waiting: the late scheduler has not settled.
    expect(settled).toBe(false);

    racing.settleWork();
    const result = await pending;
    await observed;
    expect(settled).toBe(true);
    expect(result.kind).toBe('ACQUIRED');
  });
});

/* ================================================================== *
 * Quiescence
 * ================================================================== */

describe('quiescence, not merely "paused"', () => {
  it('does not resolve while a dispatch is unsettled', async () => {
    const registry = makeRegistry();
    const client = makeClient();
    const session = registry.openSession(client);
    const scheduler = new FakeScheduler();
    registry.registerScheduler(session, scheduler);
    scheduler.beginWork();

    let settled = false;
    const pending = registry.acquireBarrier(session, client).then(result => {
      settled = true;
      return result;
    });
    await flush();
    expect(settled).toBe(false);

    scheduler.settleWork();
    const result = await pending;
    expect(result.kind).toBe('ACQUIRED');
  });

  it('a scheduler that unregisters with unsettled work still counts', async () => {
    const registry = makeRegistry();
    const client = makeClient();
    const session = registry.openSession(client);
    const scheduler = new FakeScheduler();
    const registration = registry.registerScheduler(session, scheduler);
    scheduler.beginWork();

    const pending = registry.acquireBarrier(session, client);
    await flush();

    // Unregistering does NOT cancel work already on the wire.
    registration.unregister();
    expect(registry.registeredSchedulerCount(session)).toBe(0);

    let settled = false;
    const observed = pending.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    scheduler.settleWork();
    const result = await pending;
    await observed;
    expect(settled).toBe(true);
    expect(result.kind).toBe('ACQUIRED');
  });

  it('fails closed when the deadline passes, holding nothing', async () => {
    const timers = new ManualTimers();
    const registry = makeRegistry(timers);
    const client = makeClient();
    const session = registry.openSession(client);
    const scheduler = new FakeScheduler();
    registry.registerScheduler(session, scheduler);
    scheduler.beginWork();

    const pending = registry.acquireBarrier(session, client);
    await flush();
    expect(scheduler.activeMotorTestLeaseCount).toBe(1);

    timers.fireAll();
    const result = await pending;

    expect(result.kind).toBe('NOT_ACQUIRED');
    if (result.kind !== 'NOT_ACQUIRED') {
      throw new Error('unreachable');
    }
    expect(result.reason).toBe('QUIESCENCE_TIMEOUT');
    // Rolled back: nothing is left paused.
    expect(scheduler.activeMotorTestLeaseCount).toBe(0);
    expect(timers.pendingCount).toBe(0);
  });
});

/* ================================================================== *
 * The real MspClient FIFO
 * ================================================================== */

describe('a poll already accepted into the REAL MspClient FIFO is awaited', () => {
  /** The one command the occupying request uses, and the one the poll
   * uses. Ordinary read commands; nothing motor-related exists here. */
  const OCCUPYING_COMMAND = 101;
  const POLL_COMMAND = 108;
  const EMPTY = new Uint8Array(0);

  const respondTo = (transport: FakeMspTransport, command: number): void => {
    transport.emitData(
      buildMspFrameBytes(command, Uint8Array.from([1, 2]), {
        wireFormat: 'v1',
        direction: 'response',
      }),
    );
  };

  /** The command byte of a written v1 request frame: `$ M < size cmd`. */
  const writtenCommand = (data: Uint8Array): number => data[4];

  it('stays unresolved until the queued poll itself settles', async () => {
    const transport = new FakeMspTransport();
    // REAL client, REAL scheduler, REAL registry. The only fake is the
    // transport (bytes in/out) and the barrier's deadline timer.
    const client = new MspClient(transport, 'fifo-session');
    const clock = new FakeClock(0);
    const scheduler = createMspTelemetryScheduler(client, {clock});
    const timers = new ManualTimers();
    const registry = new MotorTestTelemetryRegistry({timers});
    const session = registry.openSession(client);
    registry.registerScheduler(session, scheduler);

    const decode = jest.fn((payload: Uint8Array) => payload.length);
    scheduler.registerPoll({
      id: 'occupied-poll',
      command: POLL_COMMAND,
      intervalMs: 10,
      staleAfterMs: 1_000,
      priority: 0,
      decode,
    });

    // (1) One controlled request occupies the client's active slot.
    const occupying = client.request(OCCUPYING_COMMAND, EMPTY, {
      wireFormat: 'v1',
    });
    expect(transport.writes).toHaveLength(1);
    expect(writtenCommand(transport.writes[0].data)).toBe(OCCUPYING_COMMAND);
    transport.resolveNextWrite();
    await flush();
    expect(client.getActiveRequestPhase()).toBe('AWAITING_RESPONSE');

    // (2) The real scheduler dispatches its poll. The client accepts it
    // but CANNOT write it - the slot is taken - so it is sitting in the
    // real FIFO. Proof, with no private-state access: nothing new was
    // written to the transport.
    clock.advance(50);
    scheduler.tick();
    await flush();
    expect(transport.writes).toHaveLength(0); // the occupying write was consumed
    expect(client.getActiveRequestPhase()).toBe('AWAITING_RESPONSE');

    // (3) Barrier acquisition begins.
    let acquired = false;
    const pending = registry.acquireBarrier(session, client).then(result => {
      acquired = true;
      return result;
    });
    await flush();

    // (4) Unresolved while the poll is queued behind the active request.
    expect(acquired).toBe(false);

    // (5) Settling ONLY the preceding active request must not establish
    // quiescence: the poll is still outstanding.
    respondTo(transport, OCCUPYING_COMMAND);
    await expect(occupying).resolves.toMatchObject({
      command: OCCUPYING_COMMAND,
    });
    await flush();

    // (6) The poll has now been pumped out of the FIFO and is the active
    // request - proven by the transport receiving its frame - and
    // acquisition is STILL unresolved.
    expect(transport.writes).toHaveLength(1);
    expect(writtenCommand(transport.writes[0].data)).toBe(POLL_COMMAND);
    expect(acquired).toBe(false);
    transport.resolveNextWrite();
    await flush();
    expect(acquired).toBe(false);

    // (7) Only once the poll's own dispatch promise settles may the
    // barrier be acquired.
    respondTo(transport, POLL_COMMAND);
    const result = await pending;
    expect(acquired).toBe(true);
    expect(result.kind).toBe('ACQUIRED');
    expect(decode).toHaveBeenCalledTimes(1);

    // (8) Cleanup leaves nothing behind.
    if (result.kind !== 'ACQUIRED') {
      throw new Error('unreachable');
    }
    result.release();
    registry.closeSession(session);
    client.dispose();
    expect(timers.pendingCount).toBe(0);
    expect(transport.writes).toHaveLength(0);
    expect(transport.restarts).toHaveLength(0);
  });

  it('fails closed if a FIFO-queued poll never settles', async () => {
    const transport = new FakeMspTransport();
    const client = new MspClient(transport, 'fifo-timeout-session');
    const clock = new FakeClock(0);
    const scheduler = createMspTelemetryScheduler(client, {clock});
    const timers = new ManualTimers();
    const registry = new MotorTestTelemetryRegistry({timers});
    const session = registry.openSession(client);
    registry.registerScheduler(session, scheduler);
    scheduler.registerPoll({
      id: 'stuck-poll',
      command: POLL_COMMAND,
      intervalMs: 10,
      staleAfterMs: 1_000,
      priority: 0,
      decode: (payload: Uint8Array) => payload.length,
    });

    const occupying = client.request(OCCUPYING_COMMAND, EMPTY, {
      wireFormat: 'v1',
    });
    transport.resolveNextWrite();
    await flush();
    clock.advance(50);
    scheduler.tick();
    await flush();

    const pending = registry.acquireBarrier(session, client);
    await flush();
    timers.fireAll();
    const result = await pending;

    expect(result.kind).toBe('NOT_ACQUIRED');
    if (result.kind !== 'NOT_ACQUIRED') {
      throw new Error('unreachable');
    }
    expect(result.reason).toBe('QUIESCENCE_TIMEOUT');
    expect(timers.pendingCount).toBe(0);

    // Tidy the still-outstanding real work so nothing is left pending.
    client.dispose();
    await expect(occupying).rejects.toMatchObject({
      code: 'MSP_SESSION_CLOSED',
    });
    registry.closeSession(session);
  });
});

/* ================================================================== *
 * Token ownership and isolation
 * ================================================================== */

describe('token ownership', () => {
  it('two MOTOR_TEST barriers coexist independently', async () => {
    const registry = makeRegistry();
    const client = makeClient();
    const session = registry.openSession(client);
    const scheduler = new FakeScheduler();
    registry.registerScheduler(session, scheduler);

    const first = await registry.acquireBarrier(session, client);
    const second = await registry.acquireBarrier(session, client);
    expect(first.kind).toBe('ACQUIRED');
    expect(second.kind).toBe('ACQUIRED');
    // Two independent leases, not one shared flag.
    expect(scheduler.activeMotorTestLeaseCount).toBe(2);

    if (first.kind !== 'ACQUIRED' || second.kind !== 'ACQUIRED') {
      throw new Error('unreachable');
    }
    first.release();
    expect(first.isHeld()).toBe(false);
    expect(second.isHeld()).toBe(true);
    // The newer barrier is untouched and telemetry is still held off.
    expect(scheduler.activeMotorTestLeaseCount).toBe(1);

    second.release();
    expect(scheduler.activeMotorTestLeaseCount).toBe(0);
  });

  it('an older token released last cannot free a newer one', async () => {
    const registry = makeRegistry();
    const client = makeClient();
    const session = registry.openSession(client);
    const scheduler = new FakeScheduler();
    registry.registerScheduler(session, scheduler);

    const older = await registry.acquireBarrier(session, client);
    const newer = await registry.acquireBarrier(session, client);
    if (older.kind !== 'ACQUIRED' || newer.kind !== 'ACQUIRED') {
      throw new Error('unreachable');
    }
    newer.release();
    expect(scheduler.activeMotorTestLeaseCount).toBe(1);
    older.release();
    expect(scheduler.activeMotorTestLeaseCount).toBe(0);
    // Neither release resurrected the other.
    expect(older.isHeld()).toBe(false);
    expect(newer.isHeld()).toBe(false);
  });

  it('releasing MOTOR_TEST never releases another pause reason', async () => {
    const registry = makeRegistry();
    const client = makeClient();
    const session = registry.openSession(client);
    const scheduler = new FakeScheduler();
    registry.registerScheduler(session, scheduler);

    const background = scheduler.acquirePauseLease('APP_BACKGROUND');
    const exclusive = scheduler.acquirePauseLease('EXCLUSIVE_OPERATION');

    const held = await registry.acquireBarrier(session, client);
    if (held.kind !== 'ACQUIRED') {
      throw new Error('unreachable');
    }
    held.release();

    expect(scheduler.activeMotorTestLeaseCount).toBe(0);
    // The two foreign leases are still in force.
    expect(scheduler.activeLeaseCount).toBe(2);
    background.release();
    exclusive.release();
    expect(scheduler.activeLeaseCount).toBe(0);
  });

  it('release is idempotent', async () => {
    const registry = makeRegistry();
    const client = makeClient();
    const session = registry.openSession(client);
    const scheduler = new FakeScheduler();
    registry.registerScheduler(session, scheduler);
    const held = await registry.acquireBarrier(session, client);
    if (held.kind !== 'ACQUIRED') {
      throw new Error('unreachable');
    }
    held.release();
    held.release();
    held.release();
    expect(scheduler.activeMotorTestLeaseCount).toBe(0);
    expect(held.isHeld()).toBe(false);
  });
});

/* ================================================================== *
 * Session lifecycle
 * ================================================================== */

describe('session replacement and stale release', () => {
  it('an unknown or closed session cannot be acquired', async () => {
    const registry = makeRegistry();
    const never = new MotorTestTelemetrySession();
    const unknown = await registry.acquireBarrier(never, makeClient());
    expect(unknown.kind).toBe('NOT_ACQUIRED');
    if (unknown.kind !== 'NOT_ACQUIRED') {
      throw new Error('unreachable');
    }
    expect(unknown.reason).toBe('SESSION_UNKNOWN');

    const client = makeClient();
    const session = registry.openSession(client);
    registry.closeSession(session);
    const closed = await registry.acquireBarrier(session, client);
    if (closed.kind !== 'NOT_ACQUIRED') {
      throw new Error('unreachable');
    }
    expect(closed.reason).toBe('SESSION_UNKNOWN');
  });

  it('a session closed during acquisition fails closed and rolls back', async () => {
    const registry = makeRegistry();
    const client = makeClient();
    const session = registry.openSession(client);
    const scheduler = new FakeScheduler();
    registry.registerScheduler(session, scheduler);
    scheduler.beginWork();

    const pending = registry.acquireBarrier(session, client);
    await flush();
    expect(scheduler.activeMotorTestLeaseCount).toBe(1);

    registry.closeSession(session);
    scheduler.settleWork();
    const result = await pending;

    expect(result.kind).toBe('NOT_ACQUIRED');
    if (result.kind !== 'NOT_ACQUIRED') {
      throw new Error('unreachable');
    }
    expect(['SESSION_REPLACED', 'SESSION_UNKNOWN']).toContain(result.reason);
    expect(scheduler.activeMotorTestLeaseCount).toBe(0);
  });

  it('a stale release cannot touch the replacement session', async () => {
    const registry = makeRegistry();
    const oldClient = makeClient();
    const oldSession = registry.openSession(oldClient);
    const oldScheduler = new FakeScheduler();
    registry.registerScheduler(oldSession, oldScheduler);
    const stale = await registry.acquireBarrier(oldSession, oldClient);
    if (stale.kind !== 'ACQUIRED') {
      throw new Error('unreachable');
    }

    // The physical session is replaced.
    registry.closeSession(oldSession);
    const newClient = makeClient();
    const newSession = registry.openSession(newClient);
    const newScheduler = new FakeScheduler();
    registry.registerScheduler(newSession, newScheduler);
    const current = await registry.acquireBarrier(newSession, newClient);
    expect(current.kind).toBe('ACQUIRED');
    expect(newScheduler.activeMotorTestLeaseCount).toBe(1);

    // The old token releases late.
    stale.release();

    // The new session's pause is completely unaffected.
    expect(newScheduler.activeMotorTestLeaseCount).toBe(1);
    expect(registry.isSessionOpen(newSession)).toBe(true);
    expect(registry.isSessionOpen(oldSession)).toBe(false);
    // And the old scheduler was never touched by the new session.
    expect(oldScheduler.leases.every(l => l.released)).toBe(true);
  });

  it('closing a session releases any barrier still held for it', async () => {
    const registry = makeRegistry();
    const client = makeClient();
    const session = registry.openSession(client);
    const scheduler = new FakeScheduler();
    registry.registerScheduler(session, scheduler);
    const held = await registry.acquireBarrier(session, client);
    if (held.kind !== 'ACQUIRED') {
      throw new Error('unreachable');
    }
    expect(scheduler.activeMotorTestLeaseCount).toBe(1);

    registry.closeSession(session);
    expect(scheduler.activeMotorTestLeaseCount).toBe(0);
    expect(held.isHeld()).toBe(false);
    // A later release is a harmless no-op.
    held.release();
    expect(scheduler.activeMotorTestLeaseCount).toBe(0);
  });

  it('registering under a closed session is inert', () => {
    const registry = makeRegistry();
    const client = makeClient();
    const session = registry.openSession(client);
    registry.closeSession(session);
    const scheduler = new FakeScheduler();
    const registration = registry.registerScheduler(session, scheduler);
    expect(scheduler.leases).toHaveLength(0);
    expect(registry.registeredSchedulerCount(session)).toBe(0);
    registration.unregister();
    expect(scheduler.leases).toHaveLength(0);
  });
});

/* ================================================================== *
 * No leaks, no misreporting
 * ================================================================== */

describe('containment', () => {
  it('clears its deadline timer on success and on failure', async () => {
    const timers = new ManualTimers();
    const registry = makeRegistry(timers);
    const client = makeClient();
    const session = registry.openSession(client);
    const scheduler = new FakeScheduler();
    registry.registerScheduler(session, scheduler);

    const ok = await registry.acquireBarrier(session, client);
    expect(ok.kind).toBe('ACQUIRED');
    expect(timers.pendingCount).toBe(0);

    scheduler.beginWork();
    const failing = registry.acquireBarrier(session, client);
    await flush();
    timers.fireAll();
    await failing;
    expect(timers.pendingCount).toBe(0);
    expect(timers.cleared.length).toBeGreaterThanOrEqual(2);
  });

  it('a barrier with no schedulers still succeeds and holds nothing', async () => {
    const registry = makeRegistry();
    const client = makeClient();
    const session = registry.openSession(client);
    const result = await registry.acquireBarrier(session, client);
    expect(result.kind).toBe('ACQUIRED');
    if (result.kind !== 'ACQUIRED') {
      throw new Error('unreachable');
    }
    expect(result.session).toBe(session);
    result.release();
  });

  it('a paused poll is never dispatched, so it cannot be a telemetry error', async () => {
    const clock = new FakeClock(0);
    const requester = {request: jest.fn()};
    const scheduler = createMspTelemetryScheduler(requester as never, {clock});
    scheduler.registerPoll({
      id: 'p',
      command: 1,
      intervalMs: 10,
      staleAfterMs: 50,
      priority: 0,
      decode: () => 1,
    });
    const registry = makeRegistry();
    const client = makeClient();
    const session = registry.openSession(client);
    registry.registerScheduler(session, scheduler);
    const held = await registry.acquireBarrier(session, client);
    if (held.kind !== 'ACQUIRED') {
      throw new Error('unreachable');
    }

    clock.advance(1000);
    scheduler.tick();

    expect(requester.request).not.toHaveBeenCalled();
    // Not submitted, and therefore not reported as a failure either.
    expect(scheduler.getValue('p').status).not.toBe('ERROR');
    held.release();
  });

  it('exposes no client, transport, writer, command or payload', async () => {
    const registry = makeRegistry();
    const client = makeClient();
    const session = registry.openSession(client);
    const held = await registry.acquireBarrier(session, client);
    if (held.kind !== 'ACQUIRED') {
      throw new Error('unreachable');
    }
    expect(Object.keys(held).sort()).toEqual(
      ['isHeld', 'kind', 'release', 'session'].sort(),
    );
    for (const forbidden of [
      'client',
      'transport',
      'writer',
      'requester',
      'command',
      'payload',
      'lease',
      'motor',
    ]) {
      expect(Object.keys(held)).not.toContain(forbidden);
    }
    expect(Object.keys(registry)).not.toContain('client');
  });
});
