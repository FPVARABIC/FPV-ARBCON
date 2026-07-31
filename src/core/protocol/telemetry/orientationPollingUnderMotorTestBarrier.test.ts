/**
 * Orientation polling AND motor-test barrier suspension, exercised
 * TOGETHER on one real link.
 *
 * WHY THIS FILE EXISTS. Two independently-accepted behaviours meet here
 * for the first time:
 *
 *   - the Orientation recovery work made every genuine telemetry sample
 *     carry a `sampleSeq`, so "which sample is on screen" and "sample
 *     N+1 superseded N" became decidable facts rather than timing
 *     inferences (telemetryTypes.ts);
 *   - the motor-test barrier suspends every scheduler of a session and
 *     proves the wire is quiet before a lease is granted
 *     (motorTestTelemetryBarrier.ts).
 *
 * Each side already has its own coverage. Neither side proved what
 * happens to ORIENTATION SAMPLE IDENTITY while a motor test holds the
 * link - which is exactly the composition a hardware session performs.
 * The risk being closed is a silent one: a barrier that let a sample
 * advance would mean the 3D model kept moving while the operator
 * believes telemetry is quiesced, and a barrier that fabricated or
 * renumbered a sample on release would make the model show a sample the
 * flight controller never sent.
 *
 * EVERYTHING REAL. Real `MspClient`, real `MspTelemetryScheduler`, real
 * `MotorTestTelemetryRegistry`. The only fakes are the byte transport,
 * the clock, and the barrier's deadline timer - the same fakes the
 * accepted barrier suite already uses. No motor command is constructed
 * or sent anywhere in this file: the barrier is the only motor-test
 * object involved, and it owns no command, payload or writer.
 */

import {
  MotorTestTelemetryRegistry,
  type MotorTestBarrierTimers,
} from './motorTestTelemetryBarrier';
import {createMspTelemetryScheduler} from './MspTelemetryScheduler';
import {FakeClock} from './clock';
import {MspClient} from '../mspClient';
import {FakeMspTransport} from '../__testUtils__/mspFakeTransport';
import {buildMspFrameBytes} from '../__testUtils__/mspFixtures';

/** MSP_ATTITUDE - the command the Orientation model is actually fed by. */
const MSP_ATTITUDE = 108;
const POLL_ID = 'attitude';
const INTERVAL_MS = 100;
const STALE_AFTER_MS = 1_000;

/** The barrier's deadline timer, driven manually. */
class ManualTimers implements MotorTestBarrierTimers {
  private pending = new Map<number, () => void>();
  private nextHandle = 1;

  setTimer(callback: () => void, _delayMs: number): unknown {
    const handle = this.nextHandle++;
    this.pending.set(handle, callback);
    return handle;
  }

  clearTimer(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
};

interface Harness {
  transport: FakeMspTransport;
  client: MspClient;
  clock: FakeClock;
  scheduler: ReturnType<typeof createMspTelemetryScheduler>;
  registry: MotorTestTelemetryRegistry;
  session: ReturnType<MotorTestTelemetryRegistry['openSession']>;
}

let sessionCounter = 0;

function makeHarness(): Harness {
  sessionCounter += 1;
  const transport = new FakeMspTransport();
  const client = new MspClient(transport, `orientation-barrier-${sessionCounter}`);
  const clock = new FakeClock(0);
  const scheduler = createMspTelemetryScheduler(client, {clock});
  const registry = new MotorTestTelemetryRegistry({timers: new ManualTimers()});
  const session = registry.openSession(client);
  registry.registerScheduler(session, scheduler);

  scheduler.registerPoll<number>({
    id: POLL_ID,
    command: MSP_ATTITUDE,
    intervalMs: INTERVAL_MS,
    staleAfterMs: STALE_AFTER_MS,
    priority: 0,
    // Deliberately trivial: this file is about SAMPLE IDENTITY under the
    // barrier, not about attitude decoding, which decodeAttitude.test.ts
    // already owns.
    decode: payload => payload.length,
  });

  return {transport, client, clock, scheduler, registry, session};
}

/**
 * Completes one genuine round trip for the attitude poll: the scheduler
 * dispatches, the transport write settles, the flight controller's
 * response is delivered, and the scheduler goes idle.
 */
async function deliverOneGenuineSample(h: Harness): Promise<void> {
  h.scheduler.tick();
  await flush();
  expect(h.transport.writes.length).toBeGreaterThan(0);
  h.transport.resolveNextWrite();
  await flush();
  h.transport.emitData(
    buildMspFrameBytes(MSP_ATTITUDE, Uint8Array.from([1, 2, 3, 4, 5, 6]), {
      wireFormat: 'v1',
      direction: 'response',
    }),
  );
  await h.scheduler.waitUntilIdle();
}

/** The current sampleSeq, whatever the freshness status is. */
function seqOf(h: Harness): number | undefined {
  const value = h.scheduler.getValue<number>(POLL_ID);
  if (value.status === 'FRESH' || value.status === 'STALE') {
    return value.sampleSeq;
  }
  return undefined;
}

describe('Orientation polling under a held motor-test barrier', () => {
  it('suspends the next orientation sample: no write leaves the link and sampleSeq does not advance', async () => {
    const h = makeHarness();
    await deliverOneGenuineSample(h);
    expect(seqOf(h)).toBe(1);

    const acquisition = await h.registry.acquireBarrier(h.session, h.client);
    expect(acquisition.kind).toBe('ACQUIRED');

    // The poll is long overdue, and tick() is called repeatedly - the
    // barrier, not luck, is what keeps the link quiet.
    h.transport.writes.length = 0;
    h.clock.advance(INTERVAL_MS * 5);
    h.scheduler.tick();
    h.scheduler.tick();
    await flush();

    expect(h.transport.writes).toHaveLength(0);
    expect(seqOf(h)).toBe(1);
  });

  it('never fabricates a sample while held: FRESH -> STALE keeps the SAME sampleSeq', async () => {
    const h = makeHarness();
    await deliverOneGenuineSample(h);
    expect(h.scheduler.getValue<number>(POLL_ID).status).toBe('FRESH');

    const acquisition = await h.registry.acquireBarrier(h.session, h.client);
    expect(acquisition.kind).toBe('ACQUIRED');

    // Age the cached sample past its staleness bound while the barrier
    // holds the link. Ageing is not a new sample.
    h.clock.advance(STALE_AFTER_MS + 1);
    h.scheduler.tick();
    await flush();

    const value = h.scheduler.getValue<number>(POLL_ID);
    expect(value.status).toBe('STALE');
    // Same sample, honestly relabelled as old - not a new one, and not a
    // renumbered one.
    expect(seqOf(h)).toBe(1);
    expect(h.transport.writes).toHaveLength(0);
  });

  it('resumes on release and the next genuine sample advances sampleSeq exactly once', async () => {
    const h = makeHarness();
    await deliverOneGenuineSample(h);
    expect(seqOf(h)).toBe(1);

    const acquisition = await h.registry.acquireBarrier(h.session, h.client);
    if (acquisition.kind !== 'ACQUIRED') {
      throw new Error('barrier was not acquired');
    }
    h.clock.advance(INTERVAL_MS * 3);
    h.scheduler.tick();
    await flush();
    expect(seqOf(h)).toBe(1);

    acquisition.release();

    // Exactly one genuine sample was skipped, not silently replayed: the
    // sequence advances by one, and only because a real response arrived.
    await deliverOneGenuineSample(h);
    expect(seqOf(h)).toBe(2);
    expect(h.scheduler.getValue<number>(POLL_ID).status).toBe('FRESH');
  });

  it('releasing the barrier does not resume orientation polling while an unrelated pause is still held', async () => {
    const h = makeHarness();
    await deliverOneGenuineSample(h);

    // An app-background pause and a motor-test barrier are owned by
    // different parties and released at different times; releasing one
    // must never release the other.
    const appPause = h.scheduler.acquirePauseLease('APP_BACKGROUND');
    const acquisition = await h.registry.acquireBarrier(h.session, h.client);
    if (acquisition.kind !== 'ACQUIRED') {
      throw new Error('barrier was not acquired');
    }

    acquisition.release();

    h.transport.writes.length = 0;
    h.clock.advance(INTERVAL_MS * 5);
    h.scheduler.tick();
    await flush();
    expect(h.transport.writes).toHaveLength(0);
    expect(seqOf(h)).toBe(1);

    // Only once the LAST owner releases does orientation polling resume.
    appPause.release();
    await deliverOneGenuineSample(h);
    expect(seqOf(h)).toBe(2);
  });
});
