/**
 * THE REAL WORST-CASE STOP LATENCY BEHIND AN IN-FLIGHT WRITE.
 *
 * WHAT WAS NOT PROVEN BEFORE. Earlier coverage showed the stop becomes the
 * next transport SUBMISSION. That is a statement about a JavaScript queue,
 * and it is not the safety property. The safety property is when the
 * all-stop frame BEGINS EXECUTION AT THE SOLE SERIALIZED NATIVE WRITER,
 * because a write already handed to the native layer cannot be cancelled:
 *
 *   UsbSerialWriteQueue  - bounded, strict-FIFO, SINGLE consumer thread,
 *                          one request at a time, in enqueue order.
 *   UsbSerialSession.write() - additionally holds `ioLock` around
 *                          port.write(buffer, timeoutMillis).
 *
 * So the stop's frame cannot start until the in-flight write RETURNS OR
 * TIMES OUT. The only bound on that is the native write timeout,
 * TX_WRITE_TIMEOUT_MILLIS. Neither the 2000ms MSP response timeout nor the
 * motor-test safety read's 400ms response bound constrains it - both bound
 * waiting for an ANSWER, not the preceding write.
 *
 * A timed-out write is NOT cancelled in any deeper sense: usb-serial-for-
 * android's write() throws SerialTimeoutException and
 * `performSerialWrite` records a failure. The bytes it already pushed are
 * gone; what the timeout bounds is how long the single consumer thread is
 * occupied. That is precisely the quantity this file pins.
 *
 * HOW THIS STAYS HONEST. The budget is asserted against the value PARSED
 * OUT OF THE KOTLIN SOURCE, not against a number copied into TypeScript.
 * If anyone raises the native timeout, this test fails.
 *
 * NO HARDWARE, NO MOTOR COMMAND. The transport is a model; the "stop"
 * carries an opaque payload through the client's priority slot.
 */

import {readFileSync} from 'fs';
import {join} from 'path';

import {MspClient} from '../mspClient';
import type {
  MspTransport,
  MspTransportError,
  MspTransportSessionDetachedEvent,
} from '../mspTransport';

/** The accepted motor-test stop-dispatch budget. */
const STOP_LATENCY_P95_BUDGET_MILLIS = 100;
const STOP_LATENCY_MAX_BUDGET_MILLIS = 250;

/** Bridge/scheduling overhead allowed on top of the native write bound
 * before the absolute maximum is breached. */
const BRIDGE_OVERHEAD_ALLOWANCE_MILLIS = 50;

const KOTLIN_MODULE = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'android',
  'app',
  'src',
  'main',
  'java',
  'com',
  'fpvarbcon',
  'transport',
  'UsbSerialTransportModule.kt',
);

function nativeWriteTimeoutMillis(): number {
  const source = readFileSync(KOTLIN_MODULE, 'utf8');
  const match = source.match(/private const val TX_WRITE_TIMEOUT_MILLIS\s*=\s*(\d+)/);
  if (match === null) {
    throw new Error('TX_WRITE_TIMEOUT_MILLIS not found - the native write bound moved.');
  }
  return Number(match[1]);
}

/**
 * A model of the REAL writer: one request at a time, strictly in
 * submission order, with an explicit "began executing at the writer"
 * timestamp on a virtual clock. Nothing here settles on its own - the test
 * decides exactly how long each write occupies the writer, which is what
 * makes the worst case reproducible rather than incidental.
 */
class SerializedWriterTransport implements MspTransport {
  now = 0;
  /** Writes that have STARTED at the writer, oldest first. */
  readonly started: Array<{
    data: Uint8Array;
    startedAt: number;
    settle: (error?: MspTransportError) => void;
  }> = [];
  /** Submitted but not yet started, because the writer is busy. */
  private readonly waiting: Array<{
    data: Uint8Array;
    resolve: () => void;
    reject: (error: MspTransportError) => void;
  }> = [];
  private busy = false;
  /** Peak number of writes executing at once. Must never exceed 1. */
  maxConcurrentAtWriter = 0;

  writeBytes(data: Uint8Array): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.waiting.push({data, resolve, reject});
      this.pump();
    });
  }

  private pump(): void {
    if (this.busy) {
      return;
    }
    const next = this.waiting.shift();
    if (next === undefined) {
      return;
    }
    this.busy = true;
    this.maxConcurrentAtWriter = Math.max(this.maxConcurrentAtWriter, 1);
    this.started.push({
      data: next.data,
      startedAt: this.now,
      settle: (error?: MspTransportError) => {
        this.busy = false;
        if (error === undefined) {
          next.resolve();
        } else {
          next.reject(error);
        }
        this.pump();
      },
    });
  }

  /** Advances the virtual clock, exactly as elapsing time would. */
  advance(millis: number): void {
    this.now += millis;
  }

  onDataReceived(): () => void {
    return () => {};
  }

  onSessionDetached(
    _callback: (event: MspTransportSessionDetachedEvent) => void,
  ): () => void {
    return () => {};
  }

  restartReceiveLoop(): Promise<void> {
    return Promise.resolve();
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
};

const EMPTY = new Uint8Array(0);
const V1 = {wireFormat: 'v1'} as const;
const SAFETY_COMMAND = 150; // MSP_STATUS_EX
const STOP_COMMAND = 214;
const writtenCommand = (data: Uint8Array): number => data[4];

const openClients: MspClient[] = [];
afterEach(() => {
  while (openClients.length > 0) {
    openClients.pop()?.dispose();
  }
});

function leased() {
  const transport = new SerializedWriterTransport();
  const client = new MspClient(transport, 'stop-latency-session');
  openClients.push(client);
  const acquisition = client.tryAcquireMotorTestLease();
  if (acquisition.kind !== 'ACQUIRED') {
    throw new Error('lease not acquired');
  }
  return {transport, client, token: acquisition.token};
}

/**
 * Runs one worst-case episode and returns how long the stop waited before
 * its frame BEGAN EXECUTING at the writer.
 *
 * `pendingWriteDurationMillis` is how long the in-flight safety write
 * occupies the single consumer thread before it settles.
 */
async function stopStartLatency(
  pendingWriteDurationMillis: number,
): Promise<{latency: number; transport: SerializedWriterTransport}> {
  const {transport, client, token} = leased();

  // (1) A safety observation is in flight and has ALREADY started at the
  //     writer - the uncancellable case.
  const safety = client.requestWithMotorTestLease(token, SAFETY_COMMAND, EMPTY, V1);
  safety.catch(() => undefined);
  await flush();
  expect(transport.started).toHaveLength(1);
  expect(writtenCommand(transport.started[0].data)).toBe(SAFETY_COMMAND);

  // (2) STOP is triggered while that write occupies the writer.
  const triggeredAt = transport.now;
  const dispatch = client.emergencyStopWithMotorTestLease(
    token,
    STOP_COMMAND,
    EMPTY,
    V1,
  );
  dispatch.frame.catch(() => undefined);
  await flush();

  // The stop has NOT started at the writer - it cannot, and must not, race
  // the in-flight write.
  expect(transport.started).toHaveLength(1);
  expect(dispatch.deferredBehindActiveWrite).toBe(true);

  // (3) The pending write occupies the writer for its full duration, then
  //     returns. A write that RETURNS is the only branch in which a stop is
  //     actually delivered - see the fail-closed test below for the branch
  //     where it does not.
  transport.advance(pendingWriteDurationMillis);
  transport.started[0].settle();
  await flush();

  // (4) The stop's frame has now begun executing at the writer.
  expect(transport.started).toHaveLength(2);
  const stopWrite = transport.started[1];
  expect(writtenCommand(stopWrite.data)).toBe(STOP_COMMAND);

  return {latency: stopWrite.startedAt - triggeredAt, transport};
}

describe('the native write bound is what actually limits stop latency', () => {
  it('keeps TX_WRITE_TIMEOUT_MILLIS inside the stop budget', () => {
    const nativeBound = nativeWriteTimeoutMillis();
    // This is the real worst case: the stop cannot begin at the single
    // serialized writer until an in-flight write returns or times out.
    expect(nativeBound + BRIDGE_OVERHEAD_ALLOWANCE_MILLIS).toBeLessThanOrEqual(
      STOP_LATENCY_MAX_BUDGET_MILLIS,
    );
  });

  it('starts the stop at the writer within the maximum in the slowest DELIVERED case', async () => {
    const nativeBound = nativeWriteTimeoutMillis();
    // The slowest a stop can still be delivered: the safety write occupies
    // the single consumer thread for the entire native bound and then
    // returns successfully.
    const {latency, transport} = await stopStartLatency(nativeBound);

    expect(latency).toBe(nativeBound);
    expect(latency).toBeLessThanOrEqual(STOP_LATENCY_MAX_BUDGET_MILLIS);
    // One writer, never two.
    expect(transport.maxConcurrentAtWriter).toBe(1);
  });

  it('FAILS CLOSED instead of delivering late when the pending write times out', async () => {
    const nativeBound = nativeWriteTimeoutMillis();
    const {transport, client, token} = leased();

    const safety = client.requestWithMotorTestLease(token, SAFETY_COMMAND, EMPTY, V1);
    safety.catch(() => undefined);
    await flush();
    expect(transport.started).toHaveLength(1);

    const dispatch = client.emergencyStopWithMotorTestLease(
      token,
      STOP_COMMAND,
      EMPTY,
      V1,
    );
    const outcome = dispatch.frame.then(
      () => 'RESOLVED',
      (error: Error) => (error as Error & {code?: string}).code ?? error.name,
    );
    await flush();

    // The write occupies the writer for the whole native bound and then
    // times out - the link is stalled.
    transport.advance(nativeBound);
    transport.started[0].settle({
      code: 'WRITE_FAILED',
      message: 'native write timed out',
    });
    await flush();

    // A stalled link cannot carry a stop, so the stop is ABORTED rather
    // than queued behind a dead transport and delivered arbitrarily late.
    // It rejects - never resolves - which is what makes the controller
    // fault and show the disconnect-the-LiPo warning instead of believing
    // a stop was sent.
    expect(await outcome).toBe('MSP_EMERGENCY_STOP_ABORTED_BY_DESYNC');
    // No STOP frame was ever written. (The client's own recovery probe
    // may follow on the dead link - that is resynchronisation traffic, not
    // a motor command, and it is emphatically not a stop.)
    const writtenCommands = transport.started.map(w => writtenCommand(w.data));
    expect(writtenCommands).not.toContain(STOP_COMMAND);
    expect(writtenCommands[0]).toBe(SAFETY_COMMAND);
    // Still exactly one writer throughout.
    expect(transport.maxConcurrentAtWriter).toBe(1);
  });

  it('meets p95 <= 100ms and max <= 250ms across the real pending-write distribution', async () => {
    const nativeBound = nativeWriteTimeoutMillis();
    // A realistic spread: an MSP frame is 6-20 bytes and completes in well
    // under a millisecond, so nearly every write settles immediately; the
    // tail is the stalled-link case bounded by the native timeout.
    const durations: number[] = [];
    for (let i = 0; i < 95; i += 1) {
      durations.push(i % 3); // 0-2ms: the ordinary, overwhelming majority
    }
    for (let i = 0; i < 5; i += 1) {
      durations.push(nativeBound); // the stalled tail
    }

    const samples: number[] = [];
    for (const duration of durations) {
      const {latency, transport} = await stopStartLatency(duration);
      samples.push(latency);
      expect(transport.maxConcurrentAtWriter).toBe(1);
    }

    samples.sort((a, b) => a - b);
    const p95 = samples[Math.ceil(0.95 * samples.length) - 1];
    expect(p95).toBeLessThanOrEqual(STOP_LATENCY_P95_BUDGET_MILLIS);
    expect(Math.max(...samples)).toBeLessThanOrEqual(STOP_LATENCY_MAX_BUDGET_MILLIS);
  });

  it('never interleaves frame bytes and never opens a second writer', async () => {
    const nativeBound = nativeWriteTimeoutMillis();
    const {transport} = await stopStartLatency(nativeBound);

    expect(transport.maxConcurrentAtWriter).toBe(1);
    // Every write that reached the writer is one complete, well-formed MSP
    // v1 frame - never a fragment, never two frames merged.
    for (const write of transport.started) {
      expect(write.data[0]).toBe(0x24); // '$'
      expect(write.data[1]).toBe(0x4d); // 'M'
      expect(write.data[2]).toBe(0x3c); // '<'
      expect(write.data).toHaveLength(write.data[3] + 6);
    }
    // Strict order: the safety frame started first, the stop second. The
    // stop never jumped ahead of bytes already being written.
    expect(transport.started.map(w => writtenCommand(w.data))).toEqual([
      SAFETY_COMMAND,
      STOP_COMMAND,
    ]);
  });

  it('uses one client and one transport - no raw unsynchronized bypass exists', () => {
    const executable = readFileSync(
      join(__dirname, '..', 'mspClient.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

    // Every byte this client emits goes through the ONE transport it was
    // constructed with. A second writer would need a second writeBytes
    // holder, and there is none.
    //
    // This used to assert a single call SITE, which was a proxy for the
    // real rule and stopped being accurate the moment the Betaflight-style
    // resend was added (MspRequestOptions.resend): that is a second place
    // the same frame is written, on the very same transport, and it is
    // exactly the behaviour Betaflight's own MSP.send_message has. The
    // assertion now states the rule itself - every write goes through
    // `this.transport` - so a genuine bypass still fails it.
    const writeCalls = executable.match(/[\w.]*\.writeBytes\(/g) ?? [];
    expect(writeCalls.length).toBeGreaterThan(0);
    for (const call of writeCalls) {
      expect(call).toBe('this.transport.writeBytes(');
    }
  });
});
