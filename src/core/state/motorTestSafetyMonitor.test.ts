/**
 * The DEDICATED SAFETY OBSERVATION PATH, and its interaction with the
 * priority STOP.
 *
 * Two groups, deliberately separated:
 *
 *   A. THE MONITOR ITSELF, over a controlled requester. Single-flight,
 *      freshness, terminal handling of a blocked or failed reading, and
 *      the generation guard that stops a settling observation from
 *      publishing into a run that already ended.
 *
 *   B. STOP vs A SAFETY OBSERVATION, over the REAL `MspClient` and the
 *      repository's existing fake byte transport. This is the group that
 *      matters most: it proves a safety read can never delay a stop, that
 *      a preempted read's late response settles nothing, and that no two
 *      frames ever interleave on the wire.
 *
 * NO HARDWARE, AND NO MOTOR COMMAND. Nothing in this file constructs an
 * MSP_SET_MOTOR payload, imports the encoder, or reaches a real device.
 * The "stop" exercised here is the client's priority slot carrying an
 * opaque payload - the transport is a fake and the bytes go to an array.
 */

import {
  MOTOR_TEST_SAFETY_MAX_AGE_MILLIS,
  MOTOR_TEST_SAFETY_OBSERVATION_TIMEOUT_MILLIS,
  MotorTestSafetyMonitor,
  deriveContinuousSafetyMonitoring,
  type MotorTestSafetyUnsafeReason,
} from './motorTestSafetyMonitor';
import {MSP_RESPONSE_TIMEOUT_MILLIS, MspClient} from '../protocol/mspClient';
import {FakeMspTransport} from '../protocol/__testUtils__/mspFakeTransport';
import {buildMspFrameBytes} from '../protocol/__testUtils__/mspFixtures';
import type {MspFrame} from '../protocol/mspTypes';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
};

/* ================================================================== *
 * A. The monitor itself
 * ================================================================== */

interface ControlledRequest {
  command: number;
  resolve: (frame: MspFrame) => void;
  reject: (error: unknown) => void;
}

function controlledRequester() {
  const pending: ControlledRequest[] = [];
  return {
    pending,
    requester: {
      request(command: number): Promise<MspFrame> {
        return new Promise<MspFrame>((resolve, reject) => {
          pending.push({command, resolve, reject});
        });
      },
    },
  };
}

/** The monitor refuses to send anything without a proven static profile,
 * so a monitor built this way fails its observation without any traffic -
 * exactly the NOT_OBSERVED path we want for the failure tests. */
function monitorWithoutProfile(onUnsafe: (r: MotorTestSafetyUnsafeReason) => void) {
  const timers: Array<() => void> = [];
  const monitor = new MotorTestSafetyMonitor({
    requester: {request: () => new Promise<MspFrame>(() => {})},
    staticCompatibility: undefined,
    boxIds: undefined,
    readCurrentIdentity: () => ({physicalGeneration: 1, mspEpoch: 0}),
    readMonotonicMillis: () => 0,
    onUnsafe,
    setTimer: callback => {
      timers.push(callback);
      return timers.length;
    },
    clearTimer: () => {},
  });
  return {monitor, timers};
}

describe('the dedicated safety monitor', () => {
  it('starts fail-closed: never observed is not a licence to activate', () => {
    const {monitor} = monitorWithoutProfile(() => {});
    expect(monitor.snapshot().status.kind).toBe('NEVER_OBSERVED');
    expect(monitor.isFreshlySatisfied(0)).toBe(false);
    expect(deriveContinuousSafetyMonitoring(monitor, 0)).toBe(
      'UNAVAILABLE_NO_ACCEPTED_SOURCE',
    );
  });

  it('turns a failed observation into an unsafe report and stops running', async () => {
    const reasons: MotorTestSafetyUnsafeReason[] = [];
    const {monitor} = monitorWithoutProfile(r => reasons.push(r));

    monitor.start();
    await flush();

    expect(reasons).toEqual(['SAFETY_OBSERVATION_FAILED']);
    expect(monitor.snapshot().status).toEqual({
      kind: 'FAILED',
      reason: 'SAFETY_OBSERVATION_FAILED',
    });
    // Terminal: a failed read while an output may be live is a stop, not
    // something to retry underneath a pulse.
    expect(monitor.snapshot().running).toBe(false);
    expect(deriveContinuousSafetyMonitoring(monitor, 0)).toBe(
      'UNAVAILABLE_NO_ACCEPTED_SOURCE',
    );
  });

  it('never overlaps observations: a second request joins the outstanding one', async () => {
    const {pending, requester} = controlledRequester();
    const monitor = new MotorTestSafetyMonitor({
      requester,
      // A real profile is not needed to prove single-flight: what matters
      // is that only ONE request is ever outstanding.
      staticCompatibility: undefined,
      boxIds: undefined,
      readCurrentIdentity: () => ({physicalGeneration: 1, mspEpoch: 0}),
      readMonotonicMillis: () => 0,
      onUnsafe: () => {},
      setTimer: () => 1,
      clearTimer: () => {},
    });

    const first = monitor.observeNow();
    const second = monitor.observeNow();
    expect(second).toBe(first);
    await flush();
    // The profile gate refuses before any byte is sent, which is itself
    // the proof that a monitor cannot spend requests on an unproven scope.
    expect(pending).toHaveLength(0);
  });

  it('abandons an in-flight observation on stop() and lets it publish nothing', async () => {
    const reasons: MotorTestSafetyUnsafeReason[] = [];
    const {monitor} = monitorWithoutProfile(r => reasons.push(r));

    monitor.start();
    monitor.stop();
    await flush();

    // stop() bumped the generation before the observation settled, so the
    // late result publishes no status and raises no unsafe report.
    expect(reasons).toEqual([]);
    expect(monitor.snapshot().running).toBe(false);
  });

  it('is idempotent: repeated start() does not create a second loop', async () => {
    const reasons: MotorTestSafetyUnsafeReason[] = [];
    const {monitor} = monitorWithoutProfile(r => reasons.push(r));
    monitor.start();
    monitor.start();
    monitor.start();
    await flush();
    // One loop, therefore one report - not three.
    expect(reasons).toEqual(['SAFETY_OBSERVATION_FAILED']);
  });

  it('bounds a safety read far below the ordinary MSP response timeout', () => {
    expect(MOTOR_TEST_SAFETY_OBSERVATION_TIMEOUT_MILLIS).toBeLessThan(
      MSP_RESPONSE_TIMEOUT_MILLIS,
    );
    // A hung read must be detectable well inside the 3s pulse window.
    expect(MOTOR_TEST_SAFETY_OBSERVATION_TIMEOUT_MILLIS).toBeLessThanOrEqual(500);
    expect(MOTOR_TEST_SAFETY_MAX_AGE_MILLIS).toBeLessThan(3000);
  });

  it('applies the short response bound to every read it issues', async () => {
    const seen: Array<number | undefined> = [];
    const monitor = new MotorTestSafetyMonitor({
      requester: {
        request(_command: number, _payload: Uint8Array, options: {responseTimeoutMs?: number}) {
          seen.push(options.responseTimeoutMs);
          return Promise.reject(new Error('no answer'));
        },
      },
      staticCompatibility: {
        kind: 'EVALUATED',
        compatibility: {
          status: 'SUPPORTED',
          sessionIdentity: {physicalGeneration: 1, mspEpoch: 0},
        },
      } as never,
      boxIds: {kind: 'READY', permanentIds: [0]} as never,
      readCurrentIdentity: () => ({physicalGeneration: 1, mspEpoch: 0}),
      readMonotonicMillis: () => 0,
      onUnsafe: () => {},
      setTimer: () => 1,
      clearTimer: () => {},
    });

    await monitor.observeNow();
    expect(seen.length).toBeGreaterThan(0);
    for (const timeout of seen) {
      expect(timeout).toBe(MOTOR_TEST_SAFETY_OBSERVATION_TIMEOUT_MILLIS);
    }
  });
});

/* ================================================================== *
 * B. STOP vs a safety observation, on the real client
 * ================================================================== */

const SAFETY_COMMAND = 150; // MSP_STATUS_EX - a read, exactly what the monitor sends.
const ORDINARY_COMMAND = 108;
const STOP_COMMAND = 214; // The priority slot's payload is opaque to the client.
const EMPTY = new Uint8Array(0);
const V1 = {wireFormat: 'v1'} as const;

/** The command byte of a written MSP v1 request frame: `$ M < size cmd`. */
const writtenCommand = (data: Uint8Array): number => data[4];

/** Every client built here is disposed in afterEach: an unsettled request
 * keeps a real 2s response timer alive, which would otherwise hold the
 * Jest process open after the assertions have already passed. */
const openClients: MspClient[] = [];

afterEach(() => {
  while (openClients.length > 0) {
    openClients.pop()?.dispose();
  }
});

function leasedClient() {
  const transport = new FakeMspTransport();
  const client = new MspClient(transport, 'safety-stop-session');
  openClients.push(client);
  const acquisition = client.tryAcquireMotorTestLease();
  if (acquisition.kind !== 'ACQUIRED') {
    throw new Error(`lease not acquired: ${JSON.stringify(acquisition)}`);
  }
  return {transport, client, token: acquisition.token};
}

const respondTo = (transport: FakeMspTransport, command: number): void => {
  transport.emitData(
    buildMspFrameBytes(command, Uint8Array.from([1, 2]), {
      wireFormat: 'v1',
      direction: 'response',
    }),
  );
};

describe('STOP priority against the dedicated safety observation', () => {
  it('preempts a safety read that is AWAITING its response, without waiting out its timeout', async () => {
    const {transport, client, token} = leasedClient();

    const safety = client.requestWithMotorTestLease(token, SAFETY_COMMAND, EMPTY, {
      ...V1,
      responseTimeoutMs: MOTOR_TEST_SAFETY_OBSERVATION_TIMEOUT_MILLIS,
    });
    const safetyOutcome = safety.then(
      () => 'RESOLVED',
      (error: Error) => error.name,
    );
    await flush();
    expect(transport.writes).toHaveLength(1);
    transport.resolveNextWrite();
    await flush();
    expect(client.getActiveRequestPhase()).toBe('AWAITING_RESPONSE');

    // The stop is registered while the safety read is mid-flight.
    const dispatch = client.emergencyStopWithMotorTestLease(token, STOP_COMMAND, EMPTY, V1);
    await flush();

    // The displaced read is settled IMMEDIATELY - no timer was awaited -
    // and the stop is already the next write on the transport.
    expect(await safetyOutcome).toBe('MspMotorTestStopDisplacementError');
    expect(dispatch.deferredBehindActiveWrite).toBe(false);
    expect(transport.writes).toHaveLength(1);
    expect(writtenCommand(transport.writes[0].data)).toBe(STOP_COMMAND);
  });

  it('never races an in-flight safety WRITE: the stop waits for that one write, then goes next', async () => {
    const {transport, client, token} = leasedClient();

    const safety = client.requestWithMotorTestLease(token, SAFETY_COMMAND, EMPTY, V1);
    safety.catch(() => undefined);
    await flush();
    expect(transport.writes).toHaveLength(1);
    expect(client.getActiveRequestPhase()).toBe('WRITING');

    const dispatch = client.emergencyStopWithMotorTestLease(token, STOP_COMMAND, EMPTY, V1);
    await flush();

    // Deferred, and crucially NO second concurrent write was started:
    // exactly one write is outstanding, which is what keeps frames atomic.
    expect(dispatch.deferredBehindActiveWrite).toBe(true);
    expect(transport.writes).toHaveLength(1);

    transport.resolveNextWrite();
    await flush();

    // The moment the uncancellable write settled, the stop became the next
    // submission - it did NOT enter a response wait for the displaced read.
    expect(transport.writes).toHaveLength(1);
    expect(writtenCommand(transport.writes[0].data)).toBe(STOP_COMMAND);
  });

  it('purges queued ordinary work so nothing can precede the stop', async () => {
    const {transport, client, token} = leasedClient();

    const safety = client.requestWithMotorTestLease(token, SAFETY_COMMAND, EMPTY, V1);
    safety.catch(() => undefined);
    await flush();
    transport.resolveNextWrite();
    await flush();

    // A second lease request is admitted but cannot be written - the slot
    // is taken - so it is genuinely sitting in the FIFO.
    const queued = client.requestWithMotorTestLease(token, ORDINARY_COMMAND, EMPTY, V1);
    const queuedOutcome = queued.then(
      () => 'RESOLVED',
      (error: Error) => error.name,
    );
    await flush();
    expect(transport.writes).toHaveLength(0);

    client.emergencyStopWithMotorTestLease(token, STOP_COMMAND, EMPTY, V1);
    await flush();

    expect(await queuedOutcome).toBe('MspMotorTestStopDisplacementError');
    // The stop, not the queued request, is what reached the transport.
    expect(transport.writes).toHaveLength(1);
    expect(writtenCommand(transport.writes[0].data)).toBe(STOP_COMMAND);
  });

  it('quarantines the late response of a preempted safety read: it settles nothing', async () => {
    const {transport, client, token} = leasedClient();

    const safety = client.requestWithMotorTestLease(token, SAFETY_COMMAND, EMPTY, V1);
    const safetyOutcome = safety.then(
      () => 'RESOLVED',
      (error: Error) => error.name,
    );
    await flush();
    transport.resolveNextWrite();
    await flush();

    const dispatch = client.emergencyStopWithMotorTestLease(token, STOP_COMMAND, EMPTY, V1);
    let stopSettled = false;
    const stopOutcome = dispatch.frame.then(
      frame => {
        stopSettled = true;
        return frame;
      },
      () => {
        stopSettled = true;
        return undefined;
      },
    );
    await flush();
    transport.resolveNextWrite();
    await flush();

    // The displaced read's answer arrives LATE, after the stop was written.
    // Different command, so it cannot even be confused with the stop's ACK.
    respondTo(transport, SAFETY_COMMAND);
    await flush();

    expect(await safetyOutcome).toBe('MspMotorTestStopDisplacementError');
    // It settled nothing: the stop is still outstanding.
    expect(stopSettled).toBe(false);

    // Only the stop's OWN response settles the stop.
    respondTo(transport, STOP_COMMAND);
    const frame = await stopOutcome;
    expect(frame?.command).toBe(STOP_COMMAND);
    // A safety read shares no command id with the stop, so the client's
    // ordinary quarantine is sufficient and attribution is unambiguous.
    expect(dispatch.attributionAmbiguous).toBe(false);
  });

  it('writes whole frames only - a stop never interleaves bytes with a safety read', async () => {
    const {transport, client, token} = leasedClient();

    const safety = client.requestWithMotorTestLease(token, SAFETY_COMMAND, EMPTY, V1);
    safety.catch(() => undefined);
    await flush();
    client.emergencyStopWithMotorTestLease(token, STOP_COMMAND, EMPTY, V1);
    await flush();
    transport.resolveNextWrite();
    await flush();
    transport.resolveNextWrite();
    await flush();

    // Every write handed to the transport is one complete, well-formed MSP
    // v1 frame. No partial frame, and no frame built from two sources.
    expect(transport.writeLog.length).toBeGreaterThanOrEqual(2);
    for (const data of transport.writeLog) {
      expect(data[0]).toBe(0x24); // '$'
      expect(data[1]).toBe(0x4d); // 'M'
      expect(data[2]).toBe(0x3c); // '<'
      const size = data[3];
      expect(data).toHaveLength(size + 6);
    }
    const commands = transport.writeLog.map(writtenCommand);
    expect(commands).toContain(SAFETY_COMMAND);
    expect(commands).toContain(STOP_COMMAND);
    // Order is submission order: the safety read was already written, so
    // the stop follows it rather than replacing bytes already gone.
    expect(commands.indexOf(SAFETY_COMMAND)).toBeLessThan(
      commands.indexOf(STOP_COMMAND),
    );
  });

  it('joins repeated and concurrent stop triggers into exactly one write', async () => {
    const {transport, client, token} = leasedClient();

    const safety = client.requestWithMotorTestLease(token, SAFETY_COMMAND, EMPTY, V1);
    safety.catch(() => undefined);
    await flush();
    transport.resolveNextWrite();
    await flush();

    const first = client.emergencyStopWithMotorTestLease(token, STOP_COMMAND, EMPTY, V1);
    const second = client.emergencyStopWithMotorTestLease(token, STOP_COMMAND, EMPTY, V1);
    const third = client.emergencyStopWithMotorTestLease(token, STOP_COMMAND, EMPTY, V1);
    first.frame.catch(() => undefined);
    await flush();

    expect(second.joinedExistingStop).toBe(true);
    expect(third.joinedExistingStop).toBe(true);
    expect(second.frame).toBe(first.frame);
    // One stop, one write - repeated triggers never double-submit.
    expect(transport.writes).toHaveLength(1);
    expect(writtenCommand(transport.writes[0].data)).toBe(STOP_COMMAND);
  });

  it('dispatches the stop to the transport well inside the accepted latency budget', async () => {
    // Deterministic queue/bridge latency: the number of event-loop turns
    // between registering a stop and its bytes reaching the transport,
    // measured with a safety read already awaiting a response.
    const samples: number[] = [];
    for (let run = 0; run < 20; run += 1) {
      const {transport, client, token} = leasedClient();
      const safety = client.requestWithMotorTestLease(token, SAFETY_COMMAND, EMPTY, V1);
      safety.catch(() => undefined);
      await flush();
      transport.resolveNextWrite();
      await flush();

      const startedAt = Date.now();
      client.emergencyStopWithMotorTestLease(token, STOP_COMMAND, EMPTY, V1);
      await flush();
      samples.push(Date.now() - startedAt);

      expect(transport.writes).toHaveLength(1);
      expect(writtenCommand(transport.writes[0].data)).toBe(STOP_COMMAND);
    }

    samples.sort((a, b) => a - b);
    const p95 = samples[Math.min(samples.length - 1, Math.ceil(0.95 * samples.length) - 1)];
    expect(p95).toBeLessThanOrEqual(100);
    expect(Math.max(...samples)).toBeLessThanOrEqual(250);
  });
});
