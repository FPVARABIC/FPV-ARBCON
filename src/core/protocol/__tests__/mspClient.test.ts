import { MspClient, type MspClientDiagnosticEvent } from '../mspClient';
import type { MspTransport } from '../mspTransport';
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

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
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

describe('MspClient - the desynchronization latch and automatic recovery kickoff', () => {
  it('WRITE_FAILED rejects the active request with MSP_WRITE_OUTCOME_UNKNOWN, latches (epoch increments), queued requests rejected with MSP_RECOVERING, and recovery begins immediately (RESTARTING_READER, not a lingering DESYNCHRONIZED)', async () => {
    const { transport, client } = makeClient();
    const p1 = client.request(1, EMPTY, { wireFormat: 'v1' });
    const p2 = client.request(2, EMPTY, { wireFormat: 'v1' });
    const p3 = client.request(3, EMPTY, { wireFormat: 'v1' });
    expect(client.getEpoch()).toBe(0);

    transport.rejectNextWrite('WRITE_FAILED');

    await expect(p1).rejects.toMatchObject({ code: 'MSP_WRITE_OUTCOME_UNKNOWN' });
    await expect(p2).rejects.toMatchObject({ code: 'MSP_RECOVERING' });
    await expect(p3).rejects.toMatchObject({ code: 'MSP_RECOVERING' });
    expect(client.getEpoch()).toBe(1);
    // Recovery already kicked off synchronously - DESYNCHRONIZED is never
    // externally observable as a distinct tick (see mspClient.ts's Pass
    // 6.2b doc comment).
    expect(client.getState()).toBe('RESTARTING_READER');
    expect(transport.restarts).toHaveLength(1);
  });

  it('an unrecognized transport rejection code is also treated as write-outcome-unknown (never inspected further) and latches into recovery', async () => {
    const { transport, client } = makeClient();
    const p1 = client.request(1, EMPTY, { wireFormat: 'v1' });
    transport.rejectNextWrite('SOME_UNRECOGNIZED_NATIVE_CODE');
    await expect(p1).rejects.toMatchObject({ code: 'MSP_WRITE_OUTCOME_UNKNOWN' });
    expect(client.getState()).toBe('RESTARTING_READER');
    expect(client.getEpoch()).toBe(1);
  });

  describe('response timeout (fake timers - no real sleep)', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('MSP_RESPONSE_TIMEOUT_MILLIS elapsing with no matching response rejects with MSP_TIMEOUT and latches into recovery identically to WRITE_FAILED', async () => {
      const { transport, client } = makeClient();
      const p1 = client.request(1, EMPTY, { wireFormat: 'v1' });
      const p2 = client.request(2, EMPTY, { wireFormat: 'v1' });

      transport.resolveNextWrite();
      await flushMicrotasks();
      expect(client.getActiveRequestPhase()).toBe('AWAITING_RESPONSE');

      jest.advanceTimersByTime(2000);

      await expect(p1).rejects.toMatchObject({ code: 'MSP_TIMEOUT' });
      await expect(p2).rejects.toMatchObject({ code: 'MSP_RECOVERING' });
      expect(client.getState()).toBe('RESTARTING_READER');
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

describe('MspClient - RECOVERY_FAILED rejects everything, terminal, does not self-heal', () => {
  it('once recovery fails (restartReceiveLoop() rejects), every new request() call is rejected immediately with MSP_RECOVERY_REQUIRED, never enters the FIFO, across repeated calls', async () => {
    const { transport, client } = makeClient();
    const p1 = client.request(1, EMPTY, { wireFormat: 'v1' });
    transport.rejectNextWrite('WRITE_FAILED');
    await expect(p1).rejects.toMatchObject({ code: 'MSP_WRITE_OUTCOME_UNKNOWN' });
    expect(client.getState()).toBe('RESTARTING_READER');

    transport.rejectNextRestart();
    await flushMicrotasks();
    expect(client.getState()).toBe('RECOVERY_FAILED');

    for (let i = 0; i < 5; i++) {
      const p = client.request(100 + i, EMPTY, { wireFormat: 'v1' });
      await expect(p).rejects.toMatchObject({ code: 'MSP_RECOVERY_REQUIRED' });
      expect(transport.writes).toHaveLength(0); // never reached the transport
      expect(client.getState()).toBe('RECOVERY_FAILED'); // does not self-heal
    }
  });
});

describe('MspClient - physical disconnect always wins', () => {
  it('a physical detach while RESTARTING_READER transitions to DISCONNECTED (not a no-op, not RECOVERY_FAILED), the recovery attempt is abandoned silently, and a late restartReceiveLoop() resolution afterward does nothing', async () => {
    const { transport, client } = makeClient();
    const p1 = client.request(1, EMPTY, { wireFormat: 'v1' });
    transport.rejectNextWrite('WRITE_FAILED');
    await expect(p1).rejects.toMatchObject({ code: 'MSP_WRITE_OUTCOME_UNKNOWN' });
    expect(client.getState()).toBe('RESTARTING_READER');

    transport.emitSessionDetached(SESSION_ID);
    expect(client.getState()).toBe('DISCONNECTED');

    // The stale attempt's restartReceiveLoop() call resolving late must be
    // silently ignored (isCurrentRecoveryAttempt() guard) - no crash, no
    // state change, no resurrection out of DISCONNECTED.
    expect(() => transport.resolveNextRestart()).not.toThrow();
    expect(client.getState()).toBe('DISCONNECTED');

    const p2 = client.request(2, EMPTY, { wireFormat: 'v1' });
    await expect(p2).rejects.toMatchObject({ code: 'MSP_DEVICE_DETACHED' });
  });

  it('a physical detach while PROBING transitions to DISCONNECTED, the recovery attempt is abandoned silently, and a late probe response afterward does not resurrect the client', async () => {
    const { transport, client } = makeClient();
    const p1 = client.request(1, EMPTY, { wireFormat: 'v1' });
    transport.rejectNextWrite('WRITE_FAILED');
    await expect(p1).rejects.toMatchObject({ code: 'MSP_WRITE_OUTCOME_UNKNOWN' });
    expect(client.getState()).toBe('RESTARTING_READER');

    transport.resolveNextRestart();
    await flushMicrotasks();
    expect(client.getState()).toBe('PROBING');
    expect(transport.writes).toHaveLength(1); // the probe's own write

    transport.emitSessionDetached(SESSION_ID);
    expect(client.getState()).toBe('DISCONNECTED');

    // A late, correctly-matched probe response arriving afterward must be
    // silently ignored, not resurrect the client out of DISCONNECTED.
    // MSP_PROBE_COMMAND === 1 (MSP_API_VERSION) - see mspClient.ts.
    expect(() => transport.emitData(responseFrame(1))).not.toThrow();
    expect(client.getState()).toBe('DISCONNECTED');
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

describe('MspClient - encode() failure for a not-first queued request', () => {
  it('a second (not-first) queued request that fails to encode is rejected with MSP_ENCODE_FAILED, does not hang, does not desync, and the FIFO continues normally for a third request', async () => {
    const { transport, client } = makeClient();
    const p1 = client.request(1, EMPTY, { wireFormat: 'v1' }); // active, encodes fine
    // Nonzero flags is invalid for wireFormat 'v1' (mspEncoder.ts's encode()
    // throws a RangeError for it) - this request never becomes the first
    // active one, so startRequest() for it runs from pump() called inside
    // handleFrame(), not inside this request's own Promise executor.
    const p2 = client.request(2, EMPTY, { wireFormat: 'v1', flags: 1 }); // queued - fails to encode
    const p3 = client.request(3, EMPTY, { wireFormat: 'v1' }); // queued - must still succeed after p2's failure

    expect(transport.writes).toHaveLength(1); // only p1 has reached the transport so far

    transport.resolveNextWrite();
    transport.emitData(responseFrame(1)); // settles p1, synchronously pumps p2 (fails) then p3 (succeeds)
    expect((await p1).command).toBe(1);

    await expect(p2).rejects.toMatchObject({ code: 'MSP_ENCODE_FAILED' });
    expect(client.getState()).toBe('READY'); // confirmed-not-sent - must not desync
    expect(client.getEpoch()).toBe(0);

    expect(transport.writes).toHaveLength(1); // p3 now active; p2 never reached the transport at all
    transport.resolveNextWrite();
    transport.emitData(responseFrame(3));
    expect((await p3).command).toBe(3);
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

  it('reflects the desync latch AND the automatic recovery kickoff as soon as the triggering promise settles, with no further delay after that point', async () => {
    const { transport, client } = makeClient();
    const p1 = client.request(1, EMPTY, { wireFormat: 'v1' });
    transport.rejectNextWrite('WRITE_FAILED');
    await p1.catch(() => undefined);
    expect(client.getState()).toBe('RESTARTING_READER');
    expect(client.getEpoch()).toBe(1);
  });
});

describe('MspClient - a throwing onDiagnostic() listener does not break processing of later events', () => {
  it('a throwing first listener does not prevent a second listener from running or a later matching FRAME in the SAME ingest() chunk from settling the active request', async () => {
    const { transport, client } = makeClient();
    const events: MspClientDiagnosticEvent[] = [];
    client.onDiagnostic(() => {
      throw new Error('boom - simulated throwing diagnostic listener');
    });
    client.onDiagnostic(e => events.push(e));

    const promise = client.request(1, EMPTY, { wireFormat: 'v1' });
    transport.resolveNextWrite();
    await flushMicrotasks();

    // One chunk containing an unsolicited frame (command 99, triggers the
    // throwing listener via emitDiagnostic()) immediately followed by the
    // real matching response (command 1) - both delivered in a SINGLE
    // onDataReceived dispatch / ingest() call, so they land in the same
    // handleBytes() for-loop iteration.
    const chunk = concatBytes([responseFrame(99), responseFrame(1, Uint8Array.from([7]))]);

    expect(() => transport.emitData(chunk)).not.toThrow();

    // The second listener still ran despite the first one throwing.
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('UNSOLICITED_FRAME');

    // The real response, later in the same chunk, was still processed - not
    // silently dropped by the earlier listener's throw aborting the loop.
    const frame = await promise;
    expect(frame.command).toBe(1);
    expect(frame.payload).toEqual(Uint8Array.from([7]));
    expect(client.getState()).toBe('READY');
  });
});

describe('MspClient - recursive pump() depth on consecutive encode() failures', () => {
  it('a full queue (maxPendingRequests) of consecutive encode failures all settle with MSP_ENCODE_FAILED, without throwing or hanging, leaving the client READY', async () => {
    const MAX = 32;
    const { transport, client } = makeClient({ maxPendingRequests: MAX });

    const active = client.request(0, EMPTY, { wireFormat: 'v1' }); // occupies the active slot, encodes fine
    const queued = Array.from({ length: MAX }, (_, i) =>
      client.request(i + 1, EMPTY, { wireFormat: 'v1', flags: 1 }), // invalid for v1 - all fail to encode
    );

    expect(transport.writes).toHaveLength(1); // only the active request has reached the transport

    transport.resolveNextWrite();
    // Settling the active request's response synchronously triggers a
    // single pump() call that recursively drains all MAX queued,
    // encode-failing requests in one nested call chain (pump() ->
    // startRequest() -> catch -> pump() -> ...) before returning - at the
    // default bound this is a trivially shallow ~32-frame chain, well
    // within any JS engine's default stack depth, so this must not throw.
    expect(() => transport.emitData(responseFrame(0))).not.toThrow();
    expect((await active).command).toBe(0);

    for (const p of queued) {
      await expect(p).rejects.toMatchObject({ code: 'MSP_ENCODE_FAILED' });
    }

    expect(client.getState()).toBe('READY');
    expect(client.getEpoch()).toBe(0); // confirmed-not-sent failures never desync
    expect(transport.writes).toHaveLength(0); // none of the 32 ever reached the transport
  });
});

describe('MspClient - transport.writeBytes() throwing synchronously (contract violation)', () => {
  it('is treated as MSP_WRITE_OUTCOME_UNKNOWN, latches, and begins recovery, exactly like an unrecognized write rejection, instead of hanging or throwing out of request()', async () => {
    const dataListeners = new Set<(bytes: Uint8Array) => void>();
    const throwingTransport: MspTransport = {
      writeBytes: () => {
        throw new Error('simulated non-conforming transport: synchronous throw instead of a rejected Promise');
      },
      onDataReceived: listener => {
        dataListeners.add(listener);
        return () => dataListeners.delete(listener);
      },
      onSessionDetached: () => () => undefined,
      restartReceiveLoop: () => new Promise<void>(() => undefined), // left pending - irrelevant to this test
    };
    const client = new MspClient(throwingTransport, SESSION_ID);

    const p1 = client.request(1, EMPTY, { wireFormat: 'v1' });
    await expect(p1).rejects.toMatchObject({ code: 'MSP_WRITE_OUTCOME_UNKNOWN' });
    expect(client.getState()).toBe('RESTARTING_READER');
    expect(client.getEpoch()).toBe(1);
  });
});

describe('MspClient - dispose() when a transport unsubscribe function throws', () => {
  it('still rejects the active + queued requests and finalizes to DISCONNECTED even if unsubscribeData() throws', async () => {
    const dataListeners = new Set<(bytes: Uint8Array) => void>();
    const throwingUnsubscribeTransport: MspTransport = {
      writeBytes: () => new Promise<void>(() => undefined), // never settles - irrelevant to this test
      onDataReceived: listener => {
        dataListeners.add(listener);
        return () => {
          throw new Error('simulated non-conforming transport: unsubscribe throws');
        };
      },
      onSessionDetached: () => () => undefined,
      restartReceiveLoop: () => new Promise<void>(() => undefined), // never settles - irrelevant to this test
    };
    const client = new MspClient(throwingUnsubscribeTransport, SESSION_ID);

    const p1 = client.request(1, EMPTY, { wireFormat: 'v1' }); // active, write never settles

    expect(() => client.dispose()).not.toThrow();

    await expect(p1).rejects.toMatchObject({ code: 'MSP_SESSION_CLOSED' });
    expect(client.getState()).toBe('DISCONNECTED');
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

describe('MspClient - Pass 6.2b recovery orchestration', () => {
  it('full happy path: WRITE_FAILED -> RESTARTING_READER -> (restart succeeds) -> PROBING -> (probe succeeds) -> READY, and a new request afterward succeeds normally', async () => {
    const { transport, client } = makeClient();
    const p1 = client.request(1, EMPTY, { wireFormat: 'v1' });
    transport.rejectNextWrite('WRITE_FAILED');
    await expect(p1).rejects.toMatchObject({ code: 'MSP_WRITE_OUTCOME_UNKNOWN' });
    expect(client.getState()).toBe('RESTARTING_READER');
    expect(client.getEpoch()).toBe(1);

    transport.resolveNextRestart();
    await flushMicrotasks();
    expect(client.getState()).toBe('PROBING');
    expect(transport.writes).toHaveLength(1); // the probe's own write

    transport.resolveNextWrite();
    transport.emitData(responseFrame(1)); // MSP_PROBE_COMMAND === 1 (MSP_API_VERSION)
    await flushMicrotasks();
    expect(client.getState()).toBe('READY');
    expect(client.getEpoch()).toBe(1); // unchanged by a successful recovery

    // A brand new request works completely normally afterward.
    const p2 = client.request(2, EMPTY, { wireFormat: 'v1' });
    transport.resolveNextWrite();
    transport.emitData(responseFrame(2, Uint8Array.from([9])));
    const frame = await p2;
    expect(frame.command).toBe(2);
    expect(client.getState()).toBe('READY');
  });

  it('restartReceiveLoop() rejecting transitions directly to RECOVERY_FAILED, with no retry', async () => {
    const { transport, client } = makeClient();
    const p1 = client.request(1, EMPTY, { wireFormat: 'v1' });
    transport.rejectNextWrite('WRITE_FAILED');
    await expect(p1).rejects.toMatchObject({ code: 'MSP_WRITE_OUTCOME_UNKNOWN' });
    expect(client.getState()).toBe('RESTARTING_READER');

    transport.rejectNextRestart();
    await flushMicrotasks();

    expect(client.getState()).toBe('RECOVERY_FAILED');
    expect(client.getEpoch()).toBe(1); // a restart failure does not itself re-desync
    expect(transport.restarts).toHaveLength(0); // exactly one attempt was made - no retry
  });

  it('a probe write failure transitions directly to RECOVERY_FAILED - NOT back through DESYNCHRONIZED - without incrementing mspEpoch again', async () => {
    const { transport, client } = makeClient();
    const p1 = client.request(1, EMPTY, { wireFormat: 'v1' });
    transport.rejectNextWrite('WRITE_FAILED');
    await expect(p1).rejects.toMatchObject({ code: 'MSP_WRITE_OUTCOME_UNKNOWN' });
    expect(client.getEpoch()).toBe(1);

    transport.resolveNextRestart();
    await flushMicrotasks();
    expect(client.getState()).toBe('PROBING');

    // The probe's own write fails - this must NOT go through
    // classifyWriteFailure()/triggerDesyncLatch() (which would increment
    // mspEpoch and re-enter DESYNCHRONIZED - a forbidden re-entrant
    // recovery cycle for the probe).
    transport.rejectNextWrite('WRITE_FAILED');
    await flushMicrotasks();

    expect(client.getState()).toBe('RECOVERY_FAILED');
    expect(client.getEpoch()).toBe(1); // unchanged - proves the isProbe branch was genuinely taken
  });

  it('a probe response timeout transitions directly to RECOVERY_FAILED - NOT back through DESYNCHRONIZED - without incrementing mspEpoch again', async () => {
    jest.useFakeTimers();
    try {
      const { transport, client } = makeClient();
      const p1 = client.request(1, EMPTY, { wireFormat: 'v1' });
      transport.rejectNextWrite('WRITE_FAILED');
      await p1.catch(() => undefined);
      expect(client.getEpoch()).toBe(1);

      transport.resolveNextRestart();
      await flushMicrotasks();
      expect(client.getState()).toBe('PROBING');

      transport.resolveNextWrite();
      await flushMicrotasks();

      // MSP_PROBE_TIMEOUT_MILLIS reuses MSP_RESPONSE_TIMEOUT_MILLIS (2000) -
      // see mspClient.ts.
      jest.advanceTimersByTime(2000);

      expect(client.getState()).toBe('RECOVERY_FAILED');
      expect(client.getEpoch()).toBe(1); // unchanged - proves the isProbe branch was genuinely taken
    } finally {
      jest.useRealTimers();
    }
  });

  it('a probe receiving a correctly-matched ERROR-direction ("!") frame is treated as SUCCESS (READY), not failure - a matched frame of either direction proves the link is resynchronized, regardless of the FC\'s semantic answer', async () => {
    const { transport, client } = makeClient();
    const p1 = client.request(1, EMPTY, { wireFormat: 'v1' });
    transport.rejectNextWrite('WRITE_FAILED');
    await expect(p1).rejects.toMatchObject({ code: 'MSP_WRITE_OUTCOME_UNKNOWN' });
    expect(client.getEpoch()).toBe(1);

    transport.resolveNextRestart();
    await flushMicrotasks();
    expect(client.getState()).toBe('PROBING');
    expect(transport.writes).toHaveLength(1);

    transport.resolveNextWrite();
    transport.emitData(errorFrame(1)); // MSP_PROBE_COMMAND === 1 - matched, but error-direction
    await flushMicrotasks();

    expect(client.getState()).toBe('READY'); // NOT RECOVERY_FAILED
    expect(client.getEpoch()).toBe(1); // unchanged - never re-entered DESYNCHRONIZED

    // A subsequent request succeeds completely normally.
    const p2 = client.request(2, EMPTY, { wireFormat: 'v1' });
    transport.resolveNextWrite();
    transport.emitData(responseFrame(2, Uint8Array.from([3])));
    const frame = await p2;
    expect(frame.command).toBe(2);
    expect(client.getState()).toBe('READY');
  });

  it('request() is rejected with MSP_RECOVERING while RESTARTING_READER, and again while PROBING', async () => {
    const { transport, client } = makeClient();
    const p1 = client.request(1, EMPTY, { wireFormat: 'v1' });
    transport.rejectNextWrite('WRITE_FAILED');
    await expect(p1).rejects.toMatchObject({ code: 'MSP_WRITE_OUTCOME_UNKNOWN' });
    expect(client.getState()).toBe('RESTARTING_READER');

    const duringRestart = client.request(100, EMPTY, { wireFormat: 'v1' });
    await expect(duringRestart).rejects.toMatchObject({ code: 'MSP_RECOVERING' });
    expect(transport.writes).toHaveLength(0);

    transport.resolveNextRestart();
    await flushMicrotasks();
    expect(client.getState()).toBe('PROBING');

    const duringProbe = client.request(101, EMPTY, { wireFormat: 'v1' });
    await expect(duringProbe).rejects.toMatchObject({ code: 'MSP_RECOVERING' });
    expect(transport.writes).toHaveLength(1); // only the probe's own write
  });

  it('the probe genuinely reuses the write-vs-response race handling: a matching response arriving before the probe write Promise itself settles still succeeds', async () => {
    const { transport, client } = makeClient();
    const p1 = client.request(1, EMPTY, { wireFormat: 'v1' });
    transport.rejectNextWrite('WRITE_FAILED');
    await expect(p1).rejects.toMatchObject({ code: 'MSP_WRITE_OUTCOME_UNKNOWN' });

    transport.resolveNextRestart();
    await flushMicrotasks();
    expect(client.getState()).toBe('PROBING');
    expect(transport.writes).toHaveLength(1);

    // Response arrives BEFORE resolveNextWrite() is ever called for the probe.
    transport.emitData(responseFrame(1)); // MSP_PROBE_COMMAND === 1
    await flushMicrotasks();
    expect(client.getState()).toBe('READY');

    // The probe's write settling late must be a no-op.
    transport.resolveNextWrite();
    await flushMicrotasks();
    expect(client.getState()).toBe('READY');
  });
});

describe('MspClient - stale recovery attempts are ignored (isCurrentRecoveryAttempt guard)', () => {
  // Reachability note: a genuinely OVERLAPPING second desync while an
  // earlier attempt's own async work (restartReceiveLoop()/the probe) is
  // still outstanding is NOT reachable through the public request() API
  // under this implementation. The only MspClient-level "active request"
  // slot is empty throughout RESTARTING_READER and holds only the probe
  // throughout PROBING - and the probe's own failures are deliberately
  // routed away from triggerDesyncLatch() (see sendProbe()'s doc comment)
  // - while RECOVERY_FAILED rejects every new request() outright. So
  // nothing can independently fail and re-trigger triggerDesyncLatch()
  // while a prior attempt is still in flight. This test instead proves the
  // property that IS reachable: two SEQUENTIAL recovery cycles each get
  // their own epoch, with no bleed-through from the first. Genuine overlap
  // (a pending recovery step raced by something else that supersedes it)
  // IS exercised above, by the physical-detach-during-RESTARTING_READER
  // and physical-detach-during-PROBING tests.
  it('two independent, sequential desync/recovery cycles each get their own epoch, with no leftover state from the first', async () => {
    const { transport, client } = makeClient();

    // Cycle 1: full recovery to READY.
    const p1 = client.request(1, EMPTY, { wireFormat: 'v1' });
    transport.rejectNextWrite('WRITE_FAILED');
    await expect(p1).rejects.toMatchObject({ code: 'MSP_WRITE_OUTCOME_UNKNOWN' });
    expect(client.getEpoch()).toBe(1);

    transport.resolveNextRestart();
    await flushMicrotasks();
    transport.resolveNextWrite();
    transport.emitData(responseFrame(1));
    await flushMicrotasks();
    expect(client.getState()).toBe('READY');

    // Cycle 2: a brand new, independent desync.
    const p2 = client.request(2, EMPTY, { wireFormat: 'v1' });
    transport.rejectNextWrite('WRITE_FAILED');
    await expect(p2).rejects.toMatchObject({ code: 'MSP_WRITE_OUTCOME_UNKNOWN' });

    expect(client.getEpoch()).toBe(2); // a fresh epoch, not a leftover from cycle 1
    expect(client.getState()).toBe('RESTARTING_READER');
    expect(transport.restarts).toHaveLength(1); // cycle 1's own restart call is long gone, not re-counted
  });
});

describe('MspClient - subscribe()/notify() (Pass 7.4, Step 4)', () => {
  it('fires on a state transition (READY -> DESYNCHRONIZED/RESTARTING_READER)', async () => {
    const { transport, client } = makeClient();
    const listener = jest.fn();
    client.subscribe(listener);

    const p1 = client.request(1, EMPTY, { wireFormat: 'v1' });
    transport.rejectNextWrite('WRITE_FAILED');
    await expect(p1).rejects.toMatchObject({ code: 'MSP_WRITE_OUTCOME_UNKNOWN' });

    // DESYNCHRONIZED then RESTARTING_READER, both in the same synchronous
    // call (triggerDesyncLatch() -> startRecovery()) - see mspClient.ts's
    // own doc comment on why DESYNCHRONIZED is never externally observable
    // as a distinct getState() read, but subscribe() still fires for it.
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('fires on EVERY transition across a full recovery happy path, not just the 3 states Step 4 UI cares about', async () => {
    const { transport, client } = makeClient();
    const listener = jest.fn();
    client.subscribe(listener);

    const p1 = client.request(1, EMPTY, { wireFormat: 'v1' });
    transport.rejectNextWrite('WRITE_FAILED'); // -> DESYNCHRONIZED, RESTARTING_READER (2 calls)
    await expect(p1).rejects.toMatchObject({ code: 'MSP_WRITE_OUTCOME_UNKNOWN' });

    transport.resolveNextRestart(); // -> PROBING (1 call)
    await flushMicrotasks();

    transport.resolveNextWrite();
    transport.emitData(responseFrame(1)); // -> READY (1 call)
    await flushMicrotasks();

    expect(client.getState()).toBe('READY');
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('the returned unsubscribe function stops further notifications', async () => {
    const { transport, client } = makeClient();
    const listener = jest.fn();
    const unsubscribe = client.subscribe(listener);

    const p1 = client.request(1, EMPTY, { wireFormat: 'v1' });
    transport.rejectNextWrite('WRITE_FAILED');
    await expect(p1).rejects.toMatchObject({ code: 'MSP_WRITE_OUTCOME_UNKNOWN' });
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();

    transport.resolveNextRestart();
    await flushMicrotasks();
    transport.resolveNextWrite();
    transport.emitData(responseFrame(1));
    await flushMicrotasks();

    expect(client.getState()).toBe('READY');
    expect(listener).toHaveBeenCalledTimes(2); // no further calls after unsubscribe
  });

  it('a throwing listener does not prevent another registered listener from being notified', async () => {
    const { transport, client } = makeClient();
    const throwingListener = jest.fn(() => {
      throw new Error('boom');
    });
    const goodListener = jest.fn();
    client.subscribe(throwingListener);
    client.subscribe(goodListener);

    const p1 = client.request(1, EMPTY, { wireFormat: 'v1' });
    transport.rejectNextWrite('WRITE_FAILED');
    await expect(p1).rejects.toMatchObject({ code: 'MSP_WRITE_OUTCOME_UNKNOWN' });

    expect(throwingListener).toHaveBeenCalledTimes(2);
    expect(goodListener).toHaveBeenCalledTimes(2);
  });

  it('two consecutive getState() calls with no transition in between return the exact same value (trivially true for a string primitive, verified explicitly per this pass\'s own referential-stability requirement)', () => {
    const { client } = makeClient();
    const first = client.getState();
    const second = client.getState();
    expect(first).toBe(second);
  });

  it('notify() never fires after dispose() has returned, even from an in-flight recovery continuation (restartReceiveLoop()) that resolves afterward', async () => {
    const { transport, client } = makeClient();
    const listener = jest.fn();
    client.subscribe(listener);

    const p1 = client.request(1, EMPTY, { wireFormat: 'v1' });
    transport.rejectNextWrite('WRITE_FAILED'); // -> DESYNCHRONIZED, RESTARTING_READER
    await expect(p1).rejects.toMatchObject({ code: 'MSP_WRITE_OUTCOME_UNKNOWN' });
    expect(client.getState()).toBe('RESTARTING_READER');
    const callsBeforeDispose = listener.mock.calls.length;

    // The restart's own Promise is left deliberately pending (never
    // resolved/rejected) - dispose() runs while it is still in flight.
    client.dispose();
    expect(client.getState()).toBe('DISCONNECTED');
    // dispose() itself is a real transition (CLOSING -> DISCONNECTED) and
    // DOES notify - that is expected and correct (existing subscribers
    // deserve to learn the client is now disconnected).
    expect(listener.mock.calls.length).toBeGreaterThan(callsBeforeDispose);
    const callsAfterDispose = listener.mock.calls.length;

    // NOW resolve the stale restart - isCurrentRecoveryAttempt(epoch)
    // must see DISCONNECTED and silently abandon, per mspClient.ts's own
    // Pass 6.2b guard - no further setState()/notify() call should occur.
    transport.resolveNextRestart();
    await flushMicrotasks();

    expect(client.getState()).toBe('DISCONNECTED'); // unchanged
    expect(listener.mock.calls.length).toBe(callsAfterDispose); // no further notifications
  });

  it('notify() never fires after dispose() has returned, even from an in-flight probe response that arrives afterward', async () => {
    const { transport, client } = makeClient();
    const listener = jest.fn();

    const p1 = client.request(1, EMPTY, { wireFormat: 'v1' });
    transport.rejectNextWrite('WRITE_FAILED');
    await expect(p1).rejects.toMatchObject({ code: 'MSP_WRITE_OUTCOME_UNKNOWN' });
    transport.resolveNextRestart();
    await flushMicrotasks();
    expect(client.getState()).toBe('PROBING');

    client.subscribe(listener);
    const callsBeforeDispose = listener.mock.calls.length;

    // The probe's own write is left deliberately unresolved - dispose()
    // runs while the probe is still outstanding.
    client.dispose();
    expect(client.getState()).toBe('DISCONNECTED');
    expect(listener.mock.calls.length).toBeGreaterThan(callsBeforeDispose);
    const callsAfterDispose = listener.mock.calls.length;

    // A late-arriving probe response must not resurrect the client or
    // fire a stale notification - dispose() already unsubscribed the
    // transport's own onDataReceived listener (see dispose()'s own doc
    // comment), so this is a genuine no-op at the transport layer too.
    transport.resolveNextWrite();
    transport.emitData(responseFrame(1));
    await flushMicrotasks();

    expect(client.getState()).toBe('DISCONNECTED');
    expect(listener.mock.calls.length).toBe(callsAfterDispose);
  });

  it('calling dispose() twice does not double-notify for the second, no-op call', () => {
    const { client } = makeClient();
    const listener = jest.fn();
    client.subscribe(listener);

    client.dispose();
    const callsAfterFirstDispose = listener.mock.calls.length;
    expect(callsAfterFirstDispose).toBeGreaterThan(0);

    client.dispose();
    expect(listener.mock.calls.length).toBe(callsAfterFirstDispose);
  });
});
