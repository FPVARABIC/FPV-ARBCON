import { MspClient, type MspClientDiagnosticEvent } from '../mspClient';
import { FakeMspTransport } from '../__testUtils__/mspFakeTransport';
import { buildMspFrameBytes } from '../__testUtils__/mspFixtures';

const SESSION_ID = 'session-1';
const EMPTY = new Uint8Array(0);

function makeClient(options?: ConstructorParameters<typeof MspClient>[2]) {
  const transport = new FakeMspTransport();
  const client = new MspClient(transport, SESSION_ID, options);
  return { transport, client };
}

/** Drains the microtask queue without depending on any timer API (real or
 * faked) - Promise microtask scheduling is untouched by jest.useFakeTimers,
 * so this is safe to use in both fake- and real-timer describe blocks. */
async function flushMicrotasks(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

function responseFrame(command: number, payload: Uint8Array = EMPTY): Uint8Array {
  return buildMspFrameBytes(command, payload, { wireFormat: 'v1', direction: 'response' });
}

function errorFrame(command: number, payload: Uint8Array = EMPTY): Uint8Array {
  return buildMspFrameBytes(command, payload, { wireFormat: 'v1', direction: 'error' });
}

describe('MspClient - basic round trip and FIFO', () => {
  it('resolves with the matching response frame on a basic round trip', async () => {
    const { transport, client } = makeClient();
    const promise = client.request(100, Uint8Array.from([1, 2, 3]), { wireFormat: 'v1' });
    expect(transport.writes).toHaveLength(1);

    transport.resolveNextWrite();
    transport.emitData(responseFrame(100, Uint8Array.from([9, 9])));

    const frame = await promise;
    expect(frame.command).toBe(100);
    expect(frame.payload).toEqual(Uint8Array.from([9, 9]));
    expect(client.getState()).toBe('READY');
  });

  it('processes multiple queued requests in strict FIFO order, one active at a time', async () => {
    const { transport, client } = makeClient();
    const p1 = client.request(1, EMPTY, { wireFormat: 'v1' });
    const p2 = client.request(2, EMPTY, { wireFormat: 'v1' });
    const p3 = client.request(3, EMPTY, { wireFormat: 'v1' });

    expect(transport.writes).toHaveLength(1); // only request 1 has reached the transport so far

    transport.resolveNextWrite();
    transport.emitData(responseFrame(1));
    expect((await p1).command).toBe(1);
    expect(transport.writes).toHaveLength(1); // request 2 now active

    transport.resolveNextWrite();
    transport.emitData(responseFrame(2));
    expect((await p2).command).toBe(2);
    expect(transport.writes).toHaveLength(1); // request 3 now active

    transport.resolveNextWrite();
    transport.emitData(responseFrame(3));
    expect((await p3).command).toBe(3);
  });
});

describe('MspClient - queue bound', () => {
  it('rejects immediately with MSP_QUEUE_FULL once the pending-queue bound is exceeded, never reaching the transport', async () => {
    const { transport, client } = makeClient({ maxPendingRequests: 2 });
    client.request(1, EMPTY, { wireFormat: 'v1' }); // becomes active
    client.request(2, EMPTY, { wireFormat: 'v1' }); // queued (1/2)
    client.request(3, EMPTY, { wireFormat: 'v1' }); // queued (2/2)
    const p4 = client.request(4, EMPTY, { wireFormat: 'v1' }); // bound exceeded

    await expect(p4).rejects.toMatchObject({ code: 'MSP_QUEUE_FULL' });
    expect(transport.writes).toHaveLength(1); // request 4 never reached the transport at all
  });
});

describe('MspClient - confirmed-not-sent transport rejections (no desync)', () => {
  it('SESSION_CLOSED from the transport rejects with MSP_SESSION_CLOSED, state stays READY, no desync', async () => {
    const { transport, client } = makeClient();
    const p1 = client.request(1, EMPTY, { wireFormat: 'v1' });
    transport.rejectNextWrite('SESSION_CLOSED');
    await expect(p1).rejects.toMatchObject({ code: 'MSP_SESSION_CLOSED' });
    expect(client.getState()).toBe('READY');
    expect(client.getEpoch()).toBe(0);
  });

  it('WRITE_QUEUE_FULL from the transport rejects with MSP_TRANSPORT_QUEUE_FULL, state stays READY, no desync', async () => {
    const { transport, client } = makeClient();
    const p1 = client.request(1, EMPTY, { wireFormat: 'v1' });
    transport.rejectNextWrite('WRITE_QUEUE_FULL');
    await expect(p1).rejects.toMatchObject({ code: 'MSP_TRANSPORT_QUEUE_FULL' });
    expect(client.getState()).toBe('READY');
    expect(client.getEpoch()).toBe(0);
  });

  it('the client keeps working normally for a subsequent request after a confirmed-not-sent rejection', async () => {
    const { transport, client } = makeClient();
    const p1 = client.request(1, EMPTY, { wireFormat: 'v1' });
    transport.rejectNextWrite('SESSION_CLOSED');
    await expect(p1).rejects.toMatchObject({ code: 'MSP_SESSION_CLOSED' });

    const p2 = client.request(2, EMPTY, { wireFormat: 'v1' });
    transport.resolveNextWrite();
    transport.emitData(responseFrame(2));
    expect((await p2).command).toBe(2);
  });
});

describe('MspClient - the desynchronization latch', () => {
  it('WRITE_FAILED rejects the active request with MSP_WRITE_OUTCOME_UNKNOWN and latches: epoch increments, state becomes DESYNCHRONIZED, queued requests rejected with MSP_RECOVERY_REQUIRED', async () => {
    const { transport, client } = makeClient();
    const p1 = client.request(1, EMPTY, { wireFormat: 'v1' });
    const p2 = client.request(2, EMPTY, { wireFormat: 'v1' });
    const p3 = client.request(3, EMPTY, { wireFormat: 'v1' });
    expect(client.getEpoch()).toBe(0);

    transport.rejectNextWrite('WRITE_FAILED');

    await expect(p1).rejects.toMatchObject({ code: 'MSP_WRITE_OUTCOME_UNKNOWN' });
    await expect(p2).rejects.toMatchObject({ code: 'MSP_RECOVERY_REQUIRED' });
    await expect(p3).rejects.toMatchObject({ code: 'MSP_RECOVERY_REQUIRED' });
    expect(client.getState()).toBe('DESYNCHRONIZED');
    expect(client.getEpoch()).toBe(1);
  });

  it('an unrecognized transport rejection code is also treated as write-outcome-unknown (never inspected further) and latches', async () => {
    const { transport, client } = makeClient();
    const p1 = client.request(1, EMPTY, { wireFormat: 'v1' });
    transport.rejectNextWrite('SOME_UNRECOGNIZED_NATIVE_CODE');
    await expect(p1).rejects.toMatchObject({ code: 'MSP_WRITE_OUTCOME_UNKNOWN' });
    expect(client.getState()).toBe('DESYNCHRONIZED');
  });

  describe('response timeout (fake timers - no real sleep)', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('MSP_RESPONSE_TIMEOUT_MILLIS elapsing with no matching response rejects with MSP_TIMEOUT and latches identically to WRITE_FAILED', async () => {
      const { transport, client } = makeClient();
      const p1 = client.request(1, EMPTY, { wireFormat: 'v1' });
      const p2 = client.request(2, EMPTY, { wireFormat: 'v1' });

      transport.resolveNextWrite();
      await flushMicrotasks();
      expect(client.getActiveRequestPhase()).toBe('AWAITING_RESPONSE');

      jest.advanceTimersByTime(2000);

      await expect(p1).rejects.toMatchObject({ code: 'MSP_TIMEOUT' });
      await expect(p2).rejects.toMatchObject({ code: 'MSP_RECOVERY_REQUIRED' });
      expect(client.getState()).toBe('DESYNCHRONIZED');
      expect(client.getEpoch()).toBe(1);
    });

    it('the response timer only starts after the write settles, not before (no timeout at 2000ms while still WRITING)', async () => {
      const { client } = makeClient();
      // Left deliberately pending, on purpose - this test only checks no
      // premature timeout, not the request's own eventual outcome.
      client.request(1, EMPTY, { wireFormat: 'v1' });
      // Deliberately do NOT resolve the write - stay in WRITING phase.
      jest.advanceTimersByTime(2000);
      expect(client.getState()).toBe('READY'); // no timeout fired - no timer was ever started
      expect(client.getActiveRequestPhase()).toBe('WRITING');
    });
  });
});

describe('MspClient - write-vs-response race (registration-before-write ordering)', () => {
  it('a correctly-matched response arriving before the write Promise resolves settles as success; the later write resolution is a no-op and no response timer ever starts', async () => {
    jest.useFakeTimers();
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    try {
      const { transport, client } = makeClient();
      const promise = client.request(1, Uint8Array.from([1]), { wireFormat: 'v1' });

      // Response arrives BEFORE resolveNextWrite() is ever called.
      transport.emitData(responseFrame(1, Uint8Array.from([5, 5])));
      const frame = await promise;
      expect(frame.payload).toEqual(Uint8Array.from([5, 5]));
      expect(client.getState()).toBe('READY');

      // The write settling late must be a no-op.
      transport.resolveNextWrite();
      await flushMicrotasks();
      expect(client.getState()).toBe('READY');

      // If a response timer had started, this would fire it and desync.
      jest.advanceTimersByTime(10_000);
      expect(client.getState()).toBe('READY');
      expect(setTimeoutSpy).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  it('REGRESSION: a correctly-matched response settling the request as success before a LATER write-Promise rejection (WRITE_FAILED) must NOT trigger desynchronization', async () => {
    const { transport, client } = makeClient();
    const promise = client.request(1, Uint8Array.from([1]), { wireFormat: 'v1' });

    transport.emitData(responseFrame(1, Uint8Array.from([5])));
    const frame = await promise;
    expect(frame.payload).toEqual(Uint8Array.from([5]));
    expect(client.getState()).toBe('READY');

    // Late WRITE_FAILED for the same, already-settled-by-success request.
    transport.rejectNextWrite('WRITE_FAILED');
    await flushMicrotasks();

    expect(client.getState()).toBe('READY');
    expect(client.getEpoch()).toBe(0);

    // The client must still work normally afterward.
    const p2 = client.request(2, Uint8Array.from([2]), { wireFormat: 'v1' });
    transport.resolveNextWrite();
    transport.emitData(responseFrame(2, Uint8Array.from([6])));
    expect((await p2).command).toBe(2);
  });
});

describe('MspClient - remote error frames and unsolicited frames', () => {
  it('a matching "!" (error direction) frame rejects with MSP_REMOTE_ERROR and does not desync', async () => {
    const { transport, client } = makeClient();
    const promise = client.request(1, EMPTY, { wireFormat: 'v1' });
    transport.resolveNextWrite();
    transport.emitData(errorFrame(1));

    await expect(promise).rejects.toMatchObject({ code: 'MSP_REMOTE_ERROR' });
    expect(client.getState()).toBe('READY');
    expect(client.getEpoch()).toBe(0);
  });

  it('an unsolicited/non-matching frame does not disturb the active request or client state, and is surfaced via onDiagnostic', async () => {
    const { transport, client } = makeClient();
    const events: MspClientDiagnosticEvent[] = [];
    client.onDiagnostic(e => events.push(e));

    const promise = client.request(1, EMPTY, { wireFormat: 'v1' });
    transport.resolveNextWrite();
    await flushMicrotasks();
    expect(client.getActiveRequestPhase()).toBe('AWAITING_RESPONSE');

    transport.emitData(responseFrame(99)); // unrelated command, while 1 is active

    expect(client.getState()).toBe('READY');
    expect(client.getActiveRequestPhase()).toBe('AWAITING_RESPONSE'); // undisturbed
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('UNSOLICITED_FRAME');
    if (events[0].type === 'UNSOLICITED_FRAME') {
      expect(events[0].frame.command).toBe(99);
    }

    transport.emitData(responseFrame(1, Uint8Array.from([7])));
    const frame = await promise;
    expect(frame.command).toBe(1);
  });
});

describe('MspClient - DESYNCHRONIZED rejects everything, does not self-heal', () => {
  it('every new request() call is rejected immediately with MSP_RECOVERY_REQUIRED, never enters the FIFO, across repeated calls', async () => {
    const { transport, client } = makeClient();
    const p1 = client.request(1, EMPTY, { wireFormat: 'v1' });
    transport.rejectNextWrite('WRITE_FAILED');
    await expect(p1).rejects.toMatchObject({ code: 'MSP_WRITE_OUTCOME_UNKNOWN' });
    expect(client.getState()).toBe('DESYNCHRONIZED');

    for (let i = 0; i < 5; i++) {
      const p = client.request(100 + i, EMPTY, { wireFormat: 'v1' });
      await expect(p).rejects.toMatchObject({ code: 'MSP_RECOVERY_REQUIRED' });
      expect(transport.writes).toHaveLength(0); // never reached the transport
      expect(client.getState()).toBe('DESYNCHRONIZED'); // does not self-heal
    }
  });
});

describe('MspClient - physical disconnect always wins', () => {
  it('a physical detach while DESYNCHRONIZED transitions to DISCONNECTED (not a no-op, not RECOVERY_FAILED)', async () => {
    const { transport, client } = makeClient();
    const p1 = client.request(1, EMPTY, { wireFormat: 'v1' });
    transport.rejectNextWrite('WRITE_FAILED');
    await expect(p1).rejects.toMatchObject({ code: 'MSP_WRITE_OUTCOME_UNKNOWN' });
    expect(client.getState()).toBe('DESYNCHRONIZED');

    transport.emitSessionDetached(SESSION_ID);
    expect(client.getState()).toBe('DISCONNECTED');

    const p2 = client.request(2, EMPTY, { wireFormat: 'v1' });
    await expect(p2).rejects.toMatchObject({ code: 'MSP_DEVICE_DETACHED' });
  });

  it('a physical detach while READY with an active request in flight transitions to DISCONNECTED and rejects active + pending requests with MSP_DEVICE_DETACHED', async () => {
    const { transport, client } = makeClient();
    const p1 = client.request(1, EMPTY, { wireFormat: 'v1' }); // active
    const p2 = client.request(2, EMPTY, { wireFormat: 'v1' }); // queued
    expect(client.getState()).toBe('READY');
    expect(transport.writes).toHaveLength(1);

    transport.emitSessionDetached(SESSION_ID);
    expect(client.getState()).toBe('DISCONNECTED'); // synchronous, immediate

    await expect(p1).rejects.toMatchObject({ code: 'MSP_DEVICE_DETACHED' });
    await expect(p2).rejects.toMatchObject({ code: 'MSP_DEVICE_DETACHED' });
  });

  it('ignores a session-detached event for a different sessionId', async () => {
    const { transport, client } = makeClient();
    const p1 = client.request(1, EMPTY, { wireFormat: 'v1' });
    transport.emitSessionDetached('some-other-session');
    expect(client.getState()).toBe('READY');

    transport.resolveNextWrite();
    transport.emitData(responseFrame(1));
    expect((await p1).command).toBe(1);
  });
});

describe('MspClient - getState() observability', () => {
  it('reflects synchronous transitions (frame arrival, physical detach) with zero delay', async () => {
    const { transport, client } = makeClient();
    expect(client.getState()).toBe('READY');

    const p1 = client.request(1, EMPTY, { wireFormat: 'v1' });
    expect(client.getState()).toBe('READY');

    transport.emitSessionDetached(SESSION_ID); // fully synchronous listener dispatch
    expect(client.getState()).toBe('DISCONNECTED'); // no await needed to observe this

    // The physical detach also synchronously rejects the in-flight request -
    // asserted here so the rejection is handled, not left dangling.
    await expect(p1).rejects.toMatchObject({ code: 'MSP_DEVICE_DETACHED' });
  });

  it('reflects the desync latch as soon as its triggering promise settles, with no further delay after that point', async () => {
    const { transport, client } = makeClient();
    const p1 = client.request(1, EMPTY, { wireFormat: 'v1' });
    transport.rejectNextWrite('WRITE_FAILED');
    await p1.catch(() => undefined);
    expect(client.getState()).toBe('DESYNCHRONIZED');
  });
});

describe('MspClient - dispose()', () => {
  it('rejects the active request and everything still queued with MSP_SESSION_CLOSED, and finalizes to DISCONNECTED', async () => {
    const { client } = makeClient();
    const p1 = client.request(1, EMPTY, { wireFormat: 'v1' }); // active
    const p2 = client.request(2, EMPTY, { wireFormat: 'v1' }); // queued
    const p3 = client.request(3, EMPTY, { wireFormat: 'v1' }); // queued

    client.dispose();

    await expect(p1).rejects.toMatchObject({ code: 'MSP_SESSION_CLOSED' });
    await expect(p2).rejects.toMatchObject({ code: 'MSP_SESSION_CLOSED' });
    await expect(p3).rejects.toMatchObject({ code: 'MSP_SESSION_CLOSED' });
    expect(client.getState()).toBe('DISCONNECTED');
  });

  it('rejects any request() made after dispose() with MSP_SESSION_CLOSED too', async () => {
    const { client } = makeClient();
    client.dispose();
    const p = client.request(1, EMPTY, { wireFormat: 'v1' });
    await expect(p).rejects.toMatchObject({ code: 'MSP_SESSION_CLOSED' });
  });

  it('genuinely unsubscribes from both transport listeners - events fired after dispose() have no effect', async () => {
    const { transport, client } = makeClient();
    const events: MspClientDiagnosticEvent[] = [];
    client.onDiagnostic(e => events.push(e));

    client.dispose();
    expect(client.getState()).toBe('DISCONNECTED');

    // A data event after dispose() must not be parsed/dispatched at all.
    transport.emitData(responseFrame(99));
    expect(events).toHaveLength(0);

    // A session-detached event after dispose() must not throw or change
    // the already-recorded MSP_SESSION_CLOSED cause.
    expect(() => transport.emitSessionDetached(SESSION_ID)).not.toThrow();
    expect(client.getState()).toBe('DISCONNECTED');
    const p = client.request(1, EMPTY, { wireFormat: 'v1' });
    await expect(p).rejects.toMatchObject({ code: 'MSP_SESSION_CLOSED' }); // not MSP_DEVICE_DETACHED
  });

  it('does not overwrite a more specific cause (MSP_DEVICE_DETACHED) already recorded by a physical detach', async () => {
    const { transport, client } = makeClient();
    transport.emitSessionDetached(SESSION_ID);
    expect(client.getState()).toBe('DISCONNECTED');

    client.dispose(); // cleanup call after the fact - must not relabel the cause

    const p = client.request(1, EMPTY, { wireFormat: 'v1' });
    await expect(p).rejects.toMatchObject({ code: 'MSP_DEVICE_DETACHED' });
  });

  it('is idempotent: calling dispose() twice does not throw and does not double-reject anything', async () => {
    const { client } = makeClient();
    const p1 = client.request(1, EMPTY, { wireFormat: 'v1' });

    client.dispose();
    expect(() => client.dispose()).not.toThrow();

    await expect(p1).rejects.toMatchObject({ code: 'MSP_SESSION_CLOSED' });
    expect(client.getState()).toBe('DISCONNECTED');
  });
});
