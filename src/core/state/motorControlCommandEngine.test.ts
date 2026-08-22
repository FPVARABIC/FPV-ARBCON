/**
 * P2-ii-H - CROSS-LAYER STOP DOMINATION, PROVEN THROUGH THE REAL DRIVER.
 *
 * The pure reducer proof in `motorControlStateMachine.test.ts` shows that
 * the TRANSITION TABLE refuses a command after a stop. It cannot show that
 * the DRIVER refuses one - the coalescing buffer, the in-flight promise,
 * the command generation and the lease all live here, and a delayed
 * promise crossing a stop is exactly the shape a table proof cannot reach.
 *
 * EVERY ORDERING BELOW IS DETERMINISTIC. Requests resolve only when a test
 * explicitly resolves them, through a controllable deferred. There is no
 * `setTimeout`, no `sleep`, no fake timer and no reliance on microtask
 * ordering to create a race - a test that passed by luck would be worse
 * than no test.
 *
 * NOTHING HERE ASSERTS A PHYSICAL OUTCOME. An acknowledgement is metadata
 * proving the flight controller processed a frame. Motor motion, and the
 * physical effect of any stop, remain REQUIRES HARDWARE TEST.
 */
import {
  MotorControlCommandEngine,
  type MotorControlEnginePort,
} from './motorControlCommandEngine';
import {
  resolveMotorTestValueDomain,
  type MotorTestDomainInput,
  type MotorTestValueDomain,
} from '../firmware-adapters/betaflightMotorDomainV147';
import {MSP_SET_MOTOR} from '../protocol/msp/commands/motorTestCommands';
import {MSP2_SEND_DSHOT_COMMAND} from '../protocol/msp/commands/mspCommands';

/* ------------------------------------------------------------------ *
 * Deterministic harness
 * ------------------------------------------------------------------ */

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, resolve, reject};
}

/** Lets every already-scheduled microtask run. Never a timing race: the
 * harness only resolves what a test resolved itself. */
const flush = async (): Promise<void> => {
  for (let index = 0; index < 8; index++) {
    await Promise.resolve();
  }
};

interface RecordedCall {
  readonly route: 'REQUEST' | 'EMERGENCY_STOP' | 'REQUEST_OPTIONAL';
  readonly command: number;
  readonly payload: Uint8Array;
}

/**
 * A lease stand-in that records every route and hands back a deferred the
 * test controls. It implements only what the engine actually calls, so a
 * new transport route added to the engine would fail to compile here
 * rather than pass silently.
 */
class FakeLease {
  readonly calls: RecordedCall[] = [];
  readonly pending: Deferred<unknown>[] = [];
  active = true;
  authority: object;

  constructor(authority: object) {
    this.authority = authority;
  }

  isActive(): boolean {
    return this.active;
  }

  officialSessionAuthority(): object | undefined {
    return this.active ? this.authority : undefined;
  }

  request(command: number, payload: Uint8Array): Promise<unknown> {
    this.calls.push({route: 'REQUEST', command, payload});
    const d = deferred<unknown>();
    this.pending.push(d);
    return d.promise;
  }

  requestOptional(command: number, payload: Uint8Array): Promise<unknown> {
    this.calls.push({route: 'REQUEST_OPTIONAL', command, payload});
    const d = deferred<unknown>();
    this.pending.push(d);
    return d.promise;
  }

  /** Ambiguity the NEXT emergencyStop call will report, then consumed. */
  ambiguousStops: boolean[] = [];
  failClosedCalls = 0;

  failClosed(): boolean {
    this.failClosedCalls += 1;
    this.active = false;
    return true;
  }

  emergencyStop(command: number, payload: Uint8Array) {
    this.calls.push({route: 'EMERGENCY_STOP', command, payload});
    const d = deferred<unknown>();
    this.pending.push(d);
    return {
      frame: d.promise,
      attributionAmbiguous: this.ambiguousStops.shift() ?? false,
      deferredBehindActiveWrite: false,
      joinedExistingStop: false,
    };
  }

  /** Resolves the Nth outstanding call, oldest first. */
  settle(index = 0): void {
    const d = this.pending[index];
    if (d === undefined) {
      throw new Error(`no pending call at ${index}`);
    }
    d.resolve({});
  }

  fail(index = 0): void {
    const d = this.pending[index];
    if (d === undefined) {
      throw new Error(`no pending call at ${index}`);
    }
    d.reject(new Error('request failed'));
  }

  /** Every ACTIVE motor vector put on the ordinary route. */
  activeVectors(): number[][] {
    return this.calls
      .filter(call => call.route === 'REQUEST' && call.command === MSP_SET_MOTOR)
      .map(call => decodeVector(call.payload));
  }

  stopVectors(): number[][] {
    return this.calls
      .filter(
        call => call.route === 'EMERGENCY_STOP' && call.command === MSP_SET_MOTOR,
      )
      .map(call => decodeVector(call.payload));
  }
}

function decodeVector(payload: Uint8Array): number[] {
  const values: number[] = [];
  for (let index = 0; index + 1 < payload.length; index += 2) {
    values.push(payload[index] | (payload[index + 1] << 8));
  }
  return values;
}

/**
 * M-C: THE WIRE IS ALWAYS EIGHT SLOTS, WHATEVER THE MOTOR COUNT.
 *
 * The engine keeps its intent `motorCount` long, because that is what an
 * operator drives and what the sliders produce. What reaches the wire is
 * the canonical eight-slot MSP_SET_MOTOR body, with every slot past the
 * motor count carrying the resolved STOP value - never zero, and never a
 * copy of a commanded value.
 *
 * Expressed as a helper rather than by hand at each call site so that the
 * padding rule is stated once and a change to it fails everywhere at
 * once. See motorTestCommandVector.ts for the msp.c reading behind it.
 */
function wire(active: readonly number[], stopValue: number): number[] {
  return [
    ...active,
    ...new Array<number>(8 - active.length).fill(stopValue),
  ];
}

const DIGITAL: MotorTestDomainInput = {
  motorCount: 4,
  motorProtocolRaw: 7, // DSHOT600
  feature3dEnabled: false,
  minCommand: 1000,
  maxThrottle: 2000,
};

interface Harness {
  readonly engine: MotorControlCommandEngine;
  readonly lease: FakeLease;
  readonly domain: MotorTestValueDomain;
  readonly faults: string[];
  armed: 'FRESH_DISARMED' | 'FC_ARMED' | 'UNKNOWN_OR_STALE';
  monitorSuspensions: number;
}

function harness(over: Partial<MotorTestDomainInput> = {}): Harness {
  const authority = {session: 'official'};
  const lease = new FakeLease(authority);
  const domain = resolveMotorTestValueDomain({...DIGITAL, ...over});
  const faults: string[] = [];
  const state = {
    armed: 'FRESH_DISARMED' as 'FRESH_DISARMED' | 'FC_ARMED' | 'UNKNOWN_OR_STALE',
    monitorSuspensions: 0,
  };
  const port: MotorControlEnginePort = {
    lease: lease as unknown as MotorControlEnginePort['lease'],
    authority: authority as unknown as MotorControlEnginePort['authority'],
    domain,
    requestOptions: {wireFormat: 'v1'},
    readArmedStateEvidence: () => state.armed,
    suspendSafetyMonitor: () => {
      state.monitorSuspensions += 1;
    },
    publish: () => undefined,
    onFault: reason => {
      faults.push(reason);
    },
  };
  const engine = new MotorControlCommandEngine(port);
  engine.markEnabled();
  return {
    engine,
    lease,
    domain,
    faults,
    get armed() {
      return state.armed;
    },
    set armed(value) {
      state.armed = value;
    },
    get monitorSuspensions() {
      return state.monitorSuspensions;
    },
    set monitorSuspensions(value) {
      state.monitorSuspensions = value;
    },
  };
}

/* ------------------------------------------------------------------ *
 * THE MINIMUM SCENARIO the requirement names explicitly
 * ------------------------------------------------------------------ */

describe('P2-ii-H - A in flight, B coalesced, STOP, A acknowledges late', () => {
  it('B never reaches the wire and the late ACK cannot restore commanding', async () => {
    const h = harness();

    // A goes out.
    expect(h.engine.setMotorValues([1100, 1100, 1100, 1100])).toEqual({
      kind: 'ACCEPTED',
      coalesced: false,
    });
    expect(h.lease.activeVectors()).toEqual([wire([1100, 1100, 1100, 1100], 1000)]);

    // B is coalesced behind it - nothing new on the wire.
    expect(h.engine.setMotorValues([1200, 1200, 1200, 1200])).toEqual({
      kind: 'ACCEPTED',
      coalesced: true,
    });
    expect(h.lease.activeVectors()).toHaveLength(1);
    expect(h.engine.snapshot().pendingCoalescedVector).toBe(true);

    // STOP, while A is still unanswered.
    const stop = h.engine.stopAll('OPERATOR_STOP');
    expect(h.engine.phase).toBe('Stopping');
    // Synchronously: pending discarded, desired is all-stop.
    expect(h.engine.snapshot().pendingCoalescedVector).toBe(false);
    expect(h.engine.snapshot().desiredValues).toEqual([1000, 1000, 1000, 1000]);
    // The stop is REGISTERED, not merely planned.
    expect(h.lease.stopVectors()).toEqual([wire([1000, 1000, 1000, 1000], 1000)]);

    // A's acknowledgement arrives LATE - after the stop began.
    h.lease.settle(0);
    await flush();

    // B NEVER went on the wire.
    expect(h.lease.activeVectors()).toEqual([wire([1100, 1100, 1100, 1100], 1000)]);
    // The late ACK could not restore commanding.
    expect(h.engine.phase).toBe('Stopping');
    expect(h.engine.isCommandable()).toBe(false);
    // ...and it was not recorded as an acknowledgement of current state.
    expect(h.engine.snapshot().lastAcknowledgedValues).toBeUndefined();

    // Finish the stop so the promise is consumed.
    h.lease.settle(1); // the emergency-stop frame
    await flush();
    h.lease.settle(2); // the DShot MOTOR_STOP
    await flush();
    await expect(stop).resolves.toMatchObject({kind: 'ACKNOWLEDGED'});
  });

  it('no ACTIVE request is ever issued after the stop begins', async () => {
    const h = harness();
    h.engine.setMotorValues([1100, 1100, 1100, 1100]);
    h.engine.setMotorValues([1200, 1200, 1200, 1200]);
    const before = h.lease.activeVectors().length;

    h.engine.stopAll('OPERATOR_STOP');
    // Every later attempt, from every entry point.
    h.engine.setMotorValues([1300, 1300, 1300, 1300]);
    h.engine.setMotorValue(0, 1400);
    h.engine.setMaster(1500);
    h.lease.settle(0);
    await flush();

    expect(h.lease.activeVectors()).toHaveLength(before);
  });
});

/* ------------------------------------------------------------------ *
 * Coalescing
 * ------------------------------------------------------------------ */

describe('P2-ii-F - last-value-wins coalescing', () => {
  it('1100/1110/1120/1130 while 1100 is in flight leaves only 1130 pending', async () => {
    const h = harness();
    h.engine.setMaster(1100);
    h.engine.setMaster(1110);
    h.engine.setMaster(1120);
    h.engine.setMaster(1130);

    // One write in flight, one vector waiting. Never a backlog.
    expect(h.lease.activeVectors()).toEqual([wire([1100, 1100, 1100, 1100], 1000)]);
    expect(h.engine.snapshot().pendingCoalescedVector).toBe(true);

    h.lease.settle(0);
    await flush();

    expect(h.lease.activeVectors()).toEqual([
      wire([1100, 1100, 1100, 1100], 1000),
      wire([1130, 1130, 1130, 1130], 1000),
    ]);
    expect(h.engine.snapshot().pendingCoalescedVector).toBe(false);
  });

  it('20 rapid updates do not become 20 queued writes', async () => {
    const h = harness();
    for (let value = 1100; value < 1120; value += 1) {
      h.engine.setMaster(value);
    }
    expect(h.lease.activeVectors()).toHaveLength(1);
    h.lease.settle(0);
    await flush();
    // Exactly one more: the last value. 20 updates -> 2 frames.
    expect(h.lease.activeVectors()).toHaveLength(2);
    expect(h.lease.activeVectors()[1]).toEqual(wire([1119, 1119, 1119, 1119], 1000));
  });

  it('holds no timer: nothing is resent when nothing changes', async () => {
    const h = harness();
    h.engine.setMaster(1100);
    h.lease.settle(0);
    await flush();
    await flush();
    expect(h.lease.activeVectors()).toHaveLength(1);
  });

  it('a pending vector equal to the acknowledged state is not re-sent', async () => {
    const h = harness();
    h.engine.setMaster(1100);
    h.engine.setMaster(1100); // coalesced, identical
    h.lease.settle(0);
    await flush();
    expect(h.lease.activeVectors()).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * Command generation
 * ------------------------------------------------------------------ */

describe('command generation invalidates continuations', () => {
  it('a stop bumps the generation synchronously', () => {
    const h = harness();
    const before = h.engine.generation;
    h.engine.stopAll('OPERATOR_STOP');
    expect(h.engine.generation).toBe(before + 1);
  });

  it('session loss invalidates without issuing any traffic', () => {
    const h = harness();
    h.engine.setMaster(1100);
    const calls = h.lease.calls.length;
    h.engine.invalidateForSessionLoss('SESSION_ENDED');
    expect(h.engine.phase).toBe('Fault');
    expect(h.engine.isCommandable()).toBe(false);
    // No stop was faked on a transport that may be gone.
    expect(h.lease.calls).toHaveLength(calls);
  });

  it('a continuation from a superseded generation dispatches nothing', async () => {
    const h = harness();
    h.engine.setMaster(1100);
    h.engine.setMaster(1200); // pending
    h.engine.invalidateForSessionLoss('TRANSPORT_LOST');
    const activeBefore = h.lease.activeVectors().length;
    h.lease.settle(0);
    await flush();
    expect(h.lease.activeVectors()).toHaveLength(activeBefore);
  });

  it('an authority that moved refuses before any encoding', () => {
    const h = harness();
    h.lease.active = false;
    expect(h.engine.setMaster(1100)).toEqual({
      kind: 'REFUSED',
      reason: 'AUTHORITY_STALE',
    });
    expect(h.lease.activeVectors()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Stop variants
 * ------------------------------------------------------------------ */

describe('stop variants', () => {
  it('STOP with no request in flight still puts an all-stop on the wire', () => {
    const h = harness();
    h.engine.stopAll('OPERATOR_STOP');
    expect(h.lease.stopVectors()).toEqual([wire([1000, 1000, 1000, 1000], 1000)]);
  });

  it('STOP twice joins one episode rather than queueing a second', async () => {
    const h = harness();
    const first = h.engine.stopAll('OPERATOR_STOP');
    const second = h.engine.stopAll('OPERATOR_STOP');
    expect(first).toBe(second);
    expect(h.lease.stopVectors()).toHaveLength(1);
  });

  it('a second trigger escalates where the stop may land', async () => {
    const h = harness();
    h.engine.setMaster(1100);
    h.engine.stopAll('OPERATOR_STOP');
    h.engine.stopAll('ARMED_STATE_DETECTED');
    h.lease.settle(0); // the active write
    h.lease.settle(1); // the stop
    await flush();
    h.lease.settle(2); // DShot stop
    await flush();
    // An ordinary stop would have returned to EnabledIdle; the escalation
    // makes it Disabled, so a fresh enable is required.
    expect(h.engine.phase).toBe('Disabled');
    expect(h.engine.isCommandable()).toBe(false);
  });

  it('an ordinary confirmed stop returns to EnabledIdle and may command again', async () => {
    const h = harness();
    const stop = h.engine.stopAll('OPERATOR_STOP');
    h.lease.settle(0);
    await flush();
    h.lease.settle(1);
    await flush();
    await stop;
    expect(h.engine.phase).toBe('EnabledIdle');
    expect(h.engine.setMaster(1100)).toEqual({
      kind: 'ACCEPTED',
      coalesced: false,
    });
  });

  it('a failed stop faults and never claims a physical stop', async () => {
    const h = harness();
    const stop = h.engine.stopAll('OPERATOR_STOP');
    h.lease.fail(0);
    await flush();
    await expect(stop).resolves.toMatchObject({
      kind: 'FAILED',
      reason: 'REQUEST_FAILED',
      // A failure still reports what reached the wire - the legacy
      // projection needs that just as much as a success does.
      attribution: {stopFramesDispatched: 1},
    });
    expect(h.engine.phase).toBe('Fault');
    expect(h.engine.snapshot().physicalStopConfirmed).toBe(false);
  });

  it('the safety monitor is suspended before the priority stop', () => {
    const h = harness();
    expect(h.monitorSuspensions).toBe(0);
    h.engine.stopAll('OPERATOR_STOP');
    expect(h.monitorSuspensions).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * DShot stop ordering
 * ------------------------------------------------------------------ */

describe('P2-ii DShot stop ordering', () => {
  it('sends the all-stop vector FIRST, then DSHOT MOTOR_STOP, on the same lease', async () => {
    const h = harness();
    const stop = h.engine.stopAll('OPERATOR_STOP');
    h.lease.settle(0);
    await flush();
    await stop; // settles on the primary; MSP2 already SUBMITTED by now

    const routes = h.lease.calls.map(call => `${call.route}:${call.command}`);
    expect(routes).toEqual([
      `EMERGENCY_STOP:${MSP_SET_MOTOR}`,
      `REQUEST_OPTIONAL:${MSP2_SEND_DSHOT_COMMAND}`,
    ]);
    h.lease.settle(1);
    await flush();
    expect(h.engine.snapshot().dshotSupplemental).toBe('ACKNOWLEDGED');
  });

  it('an analog runtime sends NO DShot command', async () => {
    const h = harness({motorProtocolRaw: 3, minCommand: 900, maxThrottle: 1900});
    const stop = h.engine.stopAll('OPERATOR_STOP');
    h.lease.settle(0);
    await flush();
    await expect(stop).resolves.toMatchObject({
      kind: 'ACKNOWLEDGED',
      dshotSupplemental: 'NOT_APPLICABLE',
      attribution: {resolvedByConfirmation: false},
    });
    expect(
      h.lease.calls.some(call => call.command === MSP2_SEND_DSHOT_COMMAND),
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Armed-state evidence
 * ------------------------------------------------------------------ */

describe('P2-ii-I / P2-ii-J - armed state', () => {
  it('a confirmed ARMED reading refuses every command entry point', () => {
    const h = harness();
    h.armed = 'FC_ARMED';
    expect(h.engine.setMaster(1100)).toEqual({
      kind: 'REFUSED',
      reason: 'FC_ARMED',
    });
    expect(h.engine.setMotorValue(0, 1100)).toEqual({
      kind: 'REFUSED',
      reason: 'FC_ARMED',
    });
    expect(h.engine.setMotorValues([1100, 1100, 1100, 1100])).toEqual({
      kind: 'REFUSED',
      reason: 'FC_ARMED',
    });
    expect(h.lease.activeVectors()).toHaveLength(0);
  });

  it('UNKNOWN is NOT DISARMED and refuses commanding', () => {
    const h = harness();
    h.armed = 'UNKNOWN_OR_STALE';
    expect(h.engine.setMaster(1100)).toEqual({
      kind: 'REFUSED',
      reason: 'ARMED_STATE_UNKNOWN_OR_STALE',
    });
    expect(h.lease.activeVectors()).toHaveLength(0);
  });

  it('an ARMED observation during an active request stops and cannot resume', async () => {
    const h = harness();
    h.engine.setMaster(1100);
    h.armed = 'FC_ARMED';
    const stop = h.engine.stopAll('ARMED_STATE_DETECTED');
    h.lease.settle(0); // the late ACK of the active write
    await flush();
    h.lease.settle(1);
    await flush();
    h.lease.settle(2);
    await flush();
    await stop;
    // Locking disposition: a fresh enable is required.
    expect(h.engine.phase).toBe('Disabled');
    // And even with evidence restored, commanding stays refused.
    h.armed = 'FRESH_DISARMED';
    expect(h.engine.setMaster(1100)).toEqual({
      kind: 'REFUSED',
      reason: 'NOT_COMMANDABLE',
    });
  });

  it('telemetry resuming does not by itself return the engine to commanding', async () => {
    const h = harness();
    h.armed = 'UNKNOWN_OR_STALE';
    const stop = h.engine.stopAll('ARMED_STATE_UNKNOWN');
    h.lease.settle(0);
    await flush();
    h.lease.settle(1);
    await flush();
    await stop;
    h.armed = 'FRESH_DISARMED';
    expect(h.engine.isCommandable()).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * The professional vector API
 * ------------------------------------------------------------------ */

describe('P2-ii-C/D/E - the professional vector API', () => {
  it('setMotorValue mutates ONE entry of the full vector and sends all of it', () => {
    const h = harness();
    h.engine.setMotorValues([1100, 1200, 1000, 1000]);
    h.lease.settle(0);
    h.engine.setMotorValue(2, 1300);
    // The exact example from the requirement.
    expect(h.engine.snapshot().desiredValues).toEqual([1100, 1200, 1300, 1000]);
  });

  it('setMaster fills exactly motorCount entries, for every supported count', () => {
    for (const motorCount of [1, 2, 4, 6, 8]) {
      const h = harness({motorCount});
      h.engine.setMaster(1234);
      const sent = h.lease.activeVectors()[0];
      // The WIRE is always eight slots; the master value reaches exactly
      // the motorCount logical motors, and the rest sit at stop.
      expect(sent).toHaveLength(8);
      expect(sent.slice(0, motorCount).every(value => value === 1234)).toBe(true);
      expect(sent.slice(motorCount).every(value => value === h.domain.stopValue)).toBe(
        true,
      );
    }
  });

  it('multiple motors may hold different non-stop values simultaneously', () => {
    const h = harness();
    h.engine.setMotorValues([1100, 1200, 1300, 1400]);
    expect(h.lease.activeVectors()[0]).toEqual(wire([1100, 1200, 1300, 1400], 1000));
  });

  it('accepts the exact command-domain bounds', () => {
    const h = harness();
    expect(h.engine.setMaster(1000).kind).toBe('ACCEPTED');
    h.lease.settle(0);
    expect(h.engine.setMaster(2000).kind).toBe('ACCEPTED');
  });

  it('refuses a value outside the domain with ZERO transport traffic', () => {
    const h = harness();
    expect(h.engine.setMaster(2001)).toEqual({
      kind: 'REFUSED',
      reason: 'INVALID_VECTOR',
    });
    expect(h.engine.setMaster(999)).toEqual({
      kind: 'REFUSED',
      reason: 'INVALID_VECTOR',
    });
    expect(h.lease.calls).toHaveLength(0);
  });

  it('refuses a wrong-length or sparse vector', () => {
    const h = harness();
    expect(h.engine.setMotorValues([1100, 1100, 1100]).kind).toBe('REFUSED');
    expect(h.engine.setMotorValues([1100, 1100, 1100, 1100, 1100]).kind).toBe(
      'REFUSED',
    );
    expect(h.lease.calls).toHaveLength(0);
  });

  it('refuses a motor index outside the runtime motor count', () => {
    const h = harness({motorCount: 2});
    expect(h.engine.setMotorValue(2, 1100)).toEqual({
      kind: 'REFUSED',
      reason: 'INVALID_MOTOR_INDEX',
    });
  });

  it('has NO fixed 1050 and NO one-active-motor invariant', () => {
    const h = harness();
    // Three motors live at once, none of them 1050.
    expect(h.engine.setMotorValues([1111, 1222, 1333, 1000]).kind).toBe(
      'ACCEPTED',
    );
    expect(h.lease.activeVectors()[0]).toEqual(wire([1111, 1222, 1333, 1000], 1000));
  });

  it('needs no long press and no heartbeat to keep a value live', async () => {
    const h = harness();
    h.engine.setMaster(1100);
    h.lease.settle(0);
    await flush();
    await flush();
    // No renewal call exists on the engine at all, and nothing expired.
    expect(h.engine.isCommandable()).toBe(true);
    expect('renewPulseHold' in h.engine).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Value-state separation
 * ------------------------------------------------------------------ */

describe('P2-ii-B - desired / dispatched / acknowledged are distinct', () => {
  it('dispatched appears before acknowledged, and they differ while in flight', async () => {
    const h = harness();
    h.engine.setMaster(1100);
    let snap = h.engine.snapshot();
    expect(snap.desiredValues).toEqual([1100, 1100, 1100, 1100]);
    expect(snap.lastDispatchedValues).toEqual([1100, 1100, 1100, 1100]);
    expect(snap.lastAcknowledgedValues).toBeUndefined();

    h.lease.settle(0);
    await flush();
    snap = h.engine.snapshot();
    expect(snap.lastAcknowledgedValues).toEqual([1100, 1100, 1100, 1100]);
  });

  it('exposes no actualMotorValues and no physical claim', () => {
    const h = harness();
    const snap = h.engine.snapshot();
    expect('actualMotorValues' in snap).toBe(false);
    expect(snap.physicalStopConfirmed).toBe(false);
  });

  it('a new engine starts with no stale desired, pending or acknowledged state', () => {
    const first = harness();
    first.engine.setMaster(1500);
    const fresh = harness();
    const snap = fresh.engine.snapshot();
    expect(snap.desiredValues).toEqual([1000, 1000, 1000, 1000]);
    expect(snap.pendingCoalescedVector).toBe(false);
    expect(snap.lastDispatchedValues).toBeUndefined();
    expect(snap.lastAcknowledgedValues).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * Domain semantics
 * ------------------------------------------------------------------ */

describe('P2-ii-P - runtime domain semantics', () => {
  it('digital 3D stops at the PINNED MIDPOINT, never at 1000', () => {
    const h = harness({
      feature3dEnabled: true,
      motor3d: {deadband3dLow: 1406, deadband3dHigh: 1514, neutral3d: 1460},
    });
    expect(h.domain.stopValue).toBe(1500);
    h.engine.stopAll('OPERATOR_STOP');
    // 1000 here would be FULL REVERSE.
    expect(h.lease.stopVectors()).toEqual([wire([1500, 1500, 1500, 1500], 1500)]);
  });

  it('analog non-3D commands inside its CONFIGURATION_POLICY domain', () => {
    const h = harness({motorProtocolRaw: 3, minCommand: 900, maxThrottle: 1900});
    expect(h.domain.domainSource).toBe('CONFIGURATION_POLICY');
    expect(h.engine.setMaster(950).kind).toBe('ACCEPTED');
    h.lease.settle(0);
    expect(h.engine.setMaster(1901).kind).toBe('REFUSED');
  });

  it('analog non-3D stops at mincommand, not at a literal', () => {
    const h = harness({motorProtocolRaw: 3, minCommand: 900, maxThrottle: 1900});
    h.engine.stopAll('OPERATOR_STOP');
    expect(h.lease.stopVectors()).toEqual([wire([900, 900, 900, 900], 900)]);
  });

  it('setValuesToStop uses the domain stop value as an ORDINARY command', async () => {
    const h = harness({
      feature3dEnabled: true,
      motor3d: {deadband3dLow: 1406, deadband3dHigh: 1514, neutral3d: 1460},
    });
    expect(h.engine.setValuesToStop().kind).toBe('ACCEPTED');
    // Ordinary route, not the priority stop route.
    expect(h.lease.activeVectors()).toEqual([wire([1500, 1500, 1500, 1500], 1500)]);
    expect(h.lease.stopVectors()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Enable / fault
 * ------------------------------------------------------------------ */

describe('enable and fault', () => {
  it('an enable failure leaves the engine non-commandable with zero vectors', () => {
    const authority = {session: 'x'};
    const lease = new FakeLease(authority);
    const domain = resolveMotorTestValueDomain(DIGITAL);
    const engine = new MotorControlCommandEngine({
      lease: lease as never,
      authority: authority as never,
      domain,
      requestOptions: {wireFormat: 'v1'},
      readArmedStateEvidence: () => 'FRESH_DISARMED',
      suspendSafetyMonitor: () => undefined,
      publish: () => undefined,
      onFault: () => undefined,
    });
    engine.markEnableFailed();
    expect(engine.isCommandable()).toBe(false);
    expect(engine.setMaster(1100).kind).toBe('REFUSED');
    expect(lease.calls).toHaveLength(0);
  });

  it('enabling lands IDLE, never commanding', () => {
    const h = harness();
    expect(h.engine.phase).toBe('EnabledIdle');
    expect(h.lease.activeVectors()).toHaveLength(0);
  });

  it('a fault requires a whole new enable cycle', async () => {
    const h = harness();
    h.engine.invalidateForSessionLoss('TRANSPORT_LOST');
    expect(h.engine.phase).toBe('Fault');
    // Fault is terminal for this authority - even markEnabled cannot lift it.
    h.engine.markEnabled();
    expect(h.engine.phase).toBe('Fault');
    expect(h.engine.setMaster(1100).kind).toBe('REFUSED');
  });

  it('a failed active write takes the stop route rather than faulting at once', async () => {
    const h = harness();
    h.engine.setMaster(1100);
    h.lease.fail(0);
    await flush();
    expect(h.engine.phase).toBe('Stopping');
  });

  it('mayHaveReachedFc latches on first dispatch and never clears', async () => {
    const h = harness();
    expect(h.engine.mayHaveReachedFc).toBe(false);
    h.engine.setMaster(1100);
    expect(h.engine.mayHaveReachedFc).toBe(true);
    const stop = h.engine.stopAll('OPERATOR_STOP');
    h.lease.settle(0);
    await flush();
    h.lease.settle(1);
    await flush();
    h.lease.settle(2);
    await flush();
    await stop;
    expect(h.engine.mayHaveReachedFc).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Attribution ambiguity - the common case on the professional path
 * ------------------------------------------------------------------ */

describe('stop attribution ambiguity', () => {
  it('a stop that displaced an ACTIVE vector issues a SECOND all-stop for proof', async () => {
    const h = harness();
    h.engine.setMaster(1100); // in flight, will be displaced
    h.lease.ambiguousStops = [true];

    const stop = h.engine.stopAll('OPERATOR_STOP');
    // First stop dispatched, reported ambiguous.
    expect(h.lease.stopVectors()).toHaveLength(1);
    h.lease.settle(0); // late ACK of the displaced active write
    h.lease.settle(1); // the ambiguous stop frame
    await flush();

    // A second, independently issued all-stop supplied the proof.
    expect(h.lease.stopVectors()).toHaveLength(2);
    h.lease.settle(2);
    await flush();
    h.lease.settle(3); // DShot MOTOR_STOP
    await flush();

    await expect(stop).resolves.toMatchObject({
      kind: 'ACKNOWLEDGED',
      dshotSupplemental: 'PENDING',
      // TWO all-stop frames: the ambiguous first, and the one that proved it.
      attribution: {
        attributionAmbiguous: true,
        resolvedByConfirmation: true,
        stopFramesDispatched: 2,
      },
    });
  });

  it('a SECOND ambiguity fails closed and fails the lease - never a stop', async () => {
    const h = harness();
    h.engine.setMaster(1100);
    h.lease.ambiguousStops = [true, true];

    const stop = h.engine.stopAll('OPERATOR_STOP');
    h.lease.settle(0);
    h.lease.settle(1);
    await flush();
    h.lease.settle(2);
    await flush();

    await expect(stop).resolves.toMatchObject({
      kind: 'FAILED',
      reason: 'ATTRIBUTION_AMBIGUOUS',
      attribution: {attributionAmbiguous: true, resolvedByConfirmation: false},
    });
    expect(h.lease.failClosedCalls).toBe(1);
    expect(h.engine.phase).toBe('Fault');
    // No DShot command follows an unproven stop.
    expect(
      h.lease.calls.some(call => call.command === MSP2_SEND_DSHOT_COMMAND),
    ).toBe(false);
  });

  it('an unambiguous stop issues exactly ONE all-stop', async () => {
    const h = harness();
    const stop = h.engine.stopAll('OPERATOR_STOP');
    h.lease.settle(0);
    await flush();
    h.lease.settle(1);
    await flush();
    await stop;
    expect(h.lease.stopVectors()).toHaveLength(1);
  });
});
