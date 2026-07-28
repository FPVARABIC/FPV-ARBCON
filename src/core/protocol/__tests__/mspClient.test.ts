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

/* ======================================================================
 * Phase 2G Pass 1 - EMERGENCY STOP SUBMISSION PRIORITY
 *
 * Every assertion below is about SUBMISSION ORDER inside this client.
 * None of them claims, or could claim, that bytes already handed to
 * transport.writeBytes() were preempted, recalled or cancelled, or that
 * any motor physically stopped. The transport boundary is where this
 * layer's evidence ends.
 * ====================================================================== */

/** Command byte of a v1 request frame: `$` `M` `<` len cmd ... */
function writtenCommand(bytes: Uint8Array): number {
  return bytes[4];
}

function writtenCommands(transport: FakeMspTransport): number[] {
  return transport.writeLog.map(writtenCommand);
}

const STOP_COMMAND = 214;

function acquireToken(client: MspClient): unknown {
  const outcome = client.tryAcquireMotorTestLease();
  if (outcome.kind !== 'ACQUIRED') {
    throw new Error(`expected ACQUIRED, got ${outcome.kind}`);
  }
  return outcome.token;
}

describe('MspClient - Phase 2G: drained boundary and unreachability', () => {
  it('refuses ownership unless the request engine is genuinely drained, so the lease always begins from an empty transport boundary', () => {
    const { transport, client } = makeClient();

    // One active request is enough to deny ownership.
    const active = client.request(1, EMPTY, { wireFormat: 'v1' });
    expect(client.tryAcquireMotorTestLease()).toMatchObject({
      kind: 'REJECTED',
      reason: 'MSP_CLIENT_NOT_IDLE',
    });

    // ... and so is a queued one, even once the active request is gone.
    const queued = client.request(2, EMPTY, { wireFormat: 'v1' });
    transport.resolveNextWrite();
    transport.emitData(responseFrame(1));
    expect(client.tryAcquireMotorTestLease()).toMatchObject({
      kind: 'REJECTED',
      reason: 'MSP_CLIENT_NOT_IDLE',
    });

    transport.resolveNextWrite();
    transport.emitData(responseFrame(2));
    // Only now, with nothing active and nothing queued, is the boundary
    // drained and ownership available.
    expect(client.tryAcquireMotorTestLease().kind).toBe('ACQUIRED');

    return Promise.all([active, queued]);
  });

  it('keeps ordinary callers out of the engine entirely while a lease is held, so nothing can ever be queued ahead of a stop', async () => {
    const { transport, client } = makeClient();
    acquireToken(client);

    const writesBefore = transport.writeLog.length;
    await expect(client.request(1, EMPTY, { wireFormat: 'v1' })).rejects.toMatchObject({
      code: 'MSP_MOTOR_TEST_LEASE_HELD',
    });
    // Never reached the FIFO, the transport, or any timer.
    expect(transport.writeLog).toHaveLength(writesBefore);
  });

  it('exposes no route to submission priority other than the exact live token', async () => {
    const { transport, client } = makeClient();
    acquireToken(client);

    for (const forged of [undefined, null, {}, 'token', 0, Symbol('token')]) {
      const dispatch = client.emergencyStopWithMotorTestLease(forged, STOP_COMMAND, EMPTY, {
        wireFormat: 'v1',
      });
      await expect(dispatch.frame).rejects.toMatchObject({
        code: 'MSP_MOTOR_TEST_LEASE_CAPABILITY_INVALID',
      });
      expect(dispatch.joinedExistingStop).toBe(false);
    }
    // A refused stop is inert: no write, no displacement, no registration.
    expect(transport.writeLog).toHaveLength(0);
    expect(client.isMotorTestLeaseHeld()).toBe(true);
  });
});

describe('MspClient - Phase 2G: the stop is the next transport submission', () => {
  it('submits the stop synchronously when the transport is free, with no queued work ahead of it', () => {
    const { transport, client } = makeClient();
    const token = acquireToken(client);
    expect(transport.writeLog).toHaveLength(0);

    const dispatch = client.emergencyStopWithMotorTestLease(token, STOP_COMMAND, EMPTY, {
      wireFormat: 'v1',
    });

    // Synchronously, in the same call - no await, no timer, no tick.
    expect(writtenCommands(transport)).toEqual([STOP_COMMAND]);
    expect(dispatch.deferredBehindActiveWrite).toBe(false);
    expect(dispatch.attributionAmbiguous).toBe(false);
    expect(dispatch.joinedExistingStop).toBe(false);
  });

  it('purges every queued request as confirmed-not-sent and puts the stop on the transport ahead of all of them', async () => {
    const { transport, client } = makeClient();
    const token = acquireToken(client);

    // One active (write outstanding) plus three queued behind it.
    const active = client.requestWithMotorTestLease(token, 1, EMPTY, { wireFormat: 'v1' });
    const queued = [2, 3, 4].map(command =>
      client.requestWithMotorTestLease(token, command, EMPTY, { wireFormat: 'v1' }),
    );
    expect(writtenCommands(transport)).toEqual([1]);

    const dispatch = client.emergencyStopWithMotorTestLease(token, STOP_COMMAND, EMPTY, {
      wireFormat: 'v1',
    });
    expect(dispatch.deferredBehindActiveWrite).toBe(true);

    for (const promise of queued) {
      await expect(promise).rejects.toMatchObject({
        code: 'MSP_DISPLACED_BY_EMERGENCY_STOP',
        // Never encoded, never written: no wire ambiguity at all.
        writeAttempted: false,
      });
    }

    // The uncancellable write settles; the stop is then the very next
    // submission, and none of the purged commands ever reached the wire.
    transport.resolveNextWrite();
    await flushMicrotasks();
    await expect(active).rejects.toMatchObject({
      code: 'MSP_DISPLACED_IN_FLIGHT_BY_EMERGENCY_STOP',
      writeAttempted: true,
    });
    expect(writtenCommands(transport)).toEqual([1, STOP_COMMAND]);

    transport.resolveNextWrite();
    transport.emitData(responseFrame(STOP_COMMAND));
    await expect(dispatch.frame).resolves.toMatchObject({ command: STOP_COMMAND });
  });

  it('never runs two concurrent transport writes: while a write is in flight the stop waits, and no second writeBytes is issued', async () => {
    const { transport, client } = makeClient();
    const token = acquireToken(client);

    client.requestWithMotorTestLease(token, 1, EMPTY, { wireFormat: 'v1' }).catch(() => {});
    expect(transport.writes).toHaveLength(1); // outstanding, unsettled

    client.emergencyStopWithMotorTestLease(token, STOP_COMMAND, EMPTY, { wireFormat: 'v1' });
    await flushMicrotasks();

    // Still exactly one write invocation, and still the ORIGINAL one.
    expect(transport.writeLog).toHaveLength(1);
    expect(transport.writes).toHaveLength(1);
    expect(writtenCommands(transport)).toEqual([1]);
  });
});

describe('MspClient - Phase 2G: displacement of an in-flight request', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('cancels the displaced response timer, so the stop never waits out a response timeout and no desync is triggered by it', async () => {
    const { transport, client } = makeClient();
    const token = acquireToken(client);

    const displaced = client.requestWithMotorTestLease(token, 1, EMPTY, { wireFormat: 'v1' });
    transport.resolveNextWrite();
    await flushMicrotasks(); // request 1 is now AWAITING_RESPONSE, timer armed
    const epochBefore = client.getEpoch();

    const dispatch = client.emergencyStopWithMotorTestLease(token, STOP_COMMAND, EMPTY, {
      wireFormat: 'v1',
    });

    // The transport was already free, so the stop is submitted in the same
    // synchronous call - no timer, no tick, no awaited write ahead of it.
    expect(writtenCommands(transport)).toEqual([1, STOP_COMMAND]);
    expect(dispatch.deferredBehindActiveWrite).toBe(false);

    await expect(displaced).rejects.toMatchObject({
      code: 'MSP_DISPLACED_IN_FLIGHT_BY_EMERGENCY_STOP',
      writeAttempted: true,
    });

    // The displaced request's 2000 ms timer is gone: firing it would have
    // rejected MSP_TIMEOUT and desynchronized the client out from under
    // the stop.
    jest.advanceTimersByTime(10_000);
    await flushMicrotasks();
    expect(client.getEpoch()).toBe(epochBefore);
    expect(client.getState()).toBe('READY');
  });

  it('arms no response timer for a request displaced during WRITING, so its uncancellable write settles straight into displacement', async () => {
    const { transport, client } = makeClient();
    const token = acquireToken(client);

    const displaced = client.requestWithMotorTestLease(token, 1, EMPTY, { wireFormat: 'v1' });
    const epochBefore = client.getEpoch();
    client.emergencyStopWithMotorTestLease(token, STOP_COMMAND, EMPTY, { wireFormat: 'v1' });

    transport.resolveNextWrite();
    await flushMicrotasks();
    await expect(displaced).rejects.toMatchObject({
      code: 'MSP_DISPLACED_IN_FLIGHT_BY_EMERGENCY_STOP',
    });
    expect(writtenCommands(transport)).toEqual([1, STOP_COMMAND]);

    // It never entered AWAITING_RESPONSE, so nothing can fire later.
    jest.advanceTimersByTime(10_000);
    await flushMicrotasks();
    expect(client.getEpoch()).toBe(epochBefore);
  });

  it('quarantines a late response for the displaced request per-request, without blacklisting that command for the session', async () => {
    const { transport, client } = makeClient();
    const token = acquireToken(client);
    const diagnostics: MspClientDiagnosticEvent[] = [];
    client.onDiagnostic(event => diagnostics.push(event));

    const displaced = client.requestWithMotorTestLease(token, 77, EMPTY, { wireFormat: 'v1' });
    transport.resolveNextWrite();
    await flushMicrotasks();

    const dispatch = client.emergencyStopWithMotorTestLease(token, STOP_COMMAND, EMPTY, {
      wireFormat: 'v1',
    });
    await expect(displaced).rejects.toMatchObject({
      code: 'MSP_DISPLACED_IN_FLIGHT_BY_EMERGENCY_STOP',
    });
    transport.resolveNextWrite();

    // The displaced request's answer finally arrives. It must not settle
    // the stop, whose command it does not match.
    transport.emitData(responseFrame(77));
    await flushMicrotasks();
    expect(diagnostics.some(e => e.type === 'UNSOLICITED_FRAME')).toBe(true);

    transport.emitData(responseFrame(STOP_COMMAND));
    await expect(dispatch.frame).resolves.toMatchObject({ command: STOP_COMMAND });

    // Displacement by this lease's OWN stop does not fault the lease: the
    // stop still needs it to travel on and to be released cleanly
    // afterwards. Every other lease-scoped rejection still faults.
    expect(client.releaseMotorTestLease(token)).toEqual({ kind: 'RELEASED' });
    expect(client.isMotorTestLeaseHeld()).toBe(false);

    // Quarantine was scoped to that one displaced request, not to command
    // 77 forever: a fresh request for the same command works normally, on
    // the same client, with no blacklist anywhere.
    const reused = client.request(77, EMPTY, { wireFormat: 'v1' });
    transport.resolveNextWrite();
    transport.emitData(responseFrame(77));
    await expect(reused).resolves.toMatchObject({ command: 77 });
  });

  it('reports attribution as ambiguous only when the displaced request carries the stop’s own command', async () => {
    const differentCommand = makeClient();
    const tokenA = acquireToken(differentCommand.client);
    differentCommand.client
      .requestWithMotorTestLease(tokenA, 101, EMPTY, { wireFormat: 'v1' })
      .catch(() => {});
    differentCommand.transport.resolveNextWrite();
    await flushMicrotasks();
    expect(
      differentCommand.client.emergencyStopWithMotorTestLease(tokenA, STOP_COMMAND, EMPTY, {
        wireFormat: 'v1',
      }).attributionAmbiguous,
    ).toBe(false);

    const sameCommand = makeClient();
    const tokenB = acquireToken(sameCommand.client);
    sameCommand.client
      .requestWithMotorTestLease(tokenB, STOP_COMMAND, EMPTY, { wireFormat: 'v1' })
      .catch(() => {});
    sameCommand.transport.resolveNextWrite();
    await flushMicrotasks();
    // A late frame for the displaced request is byte-indistinguishable
    // from the stop's own ACK, so acknowledgement is UNPROVEN.
    expect(
      sameCommand.client.emergencyStopWithMotorTestLease(tokenB, STOP_COMMAND, EMPTY, {
        wireFormat: 'v1',
      }).attributionAmbiguous,
    ).toBe(true);
  });
});

describe('MspClient - Phase 2G: one stop, one write, always settled', () => {
  it('joins every repeated trigger onto the single registered stop instead of writing again', async () => {
    const { transport, client } = makeClient();
    const token = acquireToken(client);

    // Deferred behind an in-flight write, so the joins happen while the
    // stop is still merely registered.
    client.requestWithMotorTestLease(token, 1, EMPTY, { wireFormat: 'v1' }).catch(() => {});
    const first = client.emergencyStopWithMotorTestLease(token, STOP_COMMAND, EMPTY, {
      wireFormat: 'v1',
    });
    const second = client.emergencyStopWithMotorTestLease(token, STOP_COMMAND, EMPTY, {
      wireFormat: 'v1',
    });
    const third = client.emergencyStopWithMotorTestLease(token, STOP_COMMAND, EMPTY, {
      wireFormat: 'v1',
    });

    expect(first.joinedExistingStop).toBe(false);
    expect(second.joinedExistingStop).toBe(true);
    expect(third.joinedExistingStop).toBe(true);
    expect(second.frame).toBe(first.frame);
    expect(third.frame).toBe(first.frame);

    transport.resolveNextWrite();
    await flushMicrotasks();
    transport.resolveNextWrite();
    transport.emitData(responseFrame(STOP_COMMAND));
    await expect(first.frame).resolves.toMatchObject({ command: STOP_COMMAND });

    // Exactly one stop reached the transport.
    expect(writtenCommands(transport).filter(c => c === STOP_COMMAND)).toHaveLength(1);
  });

  it('refuses to release the lease while a stop is registered but not yet submitted', async () => {
    const { transport, client } = makeClient();
    const token = acquireToken(client);

    client.requestWithMotorTestLease(token, 1, EMPTY, { wireFormat: 'v1' }).catch(() => {});
    const dispatch = client.emergencyStopWithMotorTestLease(token, STOP_COMMAND, EMPTY, {
      wireFormat: 'v1',
    });
    expect(client.releaseMotorTestLease(token)).toEqual({ kind: 'LEASE_WORK_UNSETTLED' });
    expect(client.isMotorTestLeaseHeld()).toBe(true);

    transport.resolveNextWrite();
    await flushMicrotasks();
    transport.resolveNextWrite();
    transport.emitData(responseFrame(STOP_COMMAND));
    await dispatch.frame;
  });

  it('fails a never-submitted stop CLOSED on desync and latches the identity, so only a full session reset can retry', async () => {
    const { transport, client } = makeClient();
    const token = acquireToken(client);
    const epochBefore = client.getEpoch();

    client.requestWithMotorTestLease(token, 1, EMPTY, { wireFormat: 'v1' }).catch(() => {});
    const dispatch = client.emergencyStopWithMotorTestLease(token, STOP_COMMAND, EMPTY, {
      wireFormat: 'v1',
    });

    // An ambiguous write outcome desynchronizes the client before the stop
    // could ever be submitted.
    transport.rejectNextWrite('WRITE_TIMEOUT');
    await expect(dispatch.frame).rejects.toMatchObject({
      code: 'MSP_EMERGENCY_STOP_ABORTED_BY_DESYNC',
    });

    // It rejected rather than resolving - a stop that was never written
    // must never look like one that was sent.
    expect(writtenCommands(transport)).toEqual([1]);
    expect(client.isMotorTestLeaseHeld()).toBe(false);
    expect(client.getEpoch()).not.toBe(epochBefore);

    // The identity the stop died under is fault-latched, and the latch
    // lands on the PRE-desync epoch: while recovery is still running,
    // reacquisition is refused outright.
    expect(client.tryAcquireMotorTestLease()).toMatchObject({ kind: 'REJECTED' });

    // Recovery then runs to completion and the client returns to READY.
    // The epoch has ROTATED, which is precisely what "a full session
    // reset" means at this layer: the client-level composite identity is
    // genuinely new, so it may be leased - while any holder still
    // describing the OLD identity is refused. That refusal is enforced
    // one layer up, where identity lives; see motorTestLease.test.ts,
    // 'a stop aborted by desync leaves the identity it ran under
    // unusable'.
    transport.resolveNextRestart();
    await flushMicrotasks();
    transport.resolveNextWrite();
    transport.emitData(responseFrame(1)); // MSP_PROBE_COMMAND === 1
    await flushMicrotasks();
    expect(client.getState()).toBe('READY');
    expect(client.getEpoch()).toBe(epochBefore + 1);
  });

  it('settles a never-submitted stop CLOSED when the session ends under it', async () => {
    const disposed = makeClient();
    const tokenA = acquireToken(disposed.client);
    disposed.client
      .requestWithMotorTestLease(tokenA, 1, EMPTY, { wireFormat: 'v1' })
      .catch(() => {});
    const viaDispose = disposed.client.emergencyStopWithMotorTestLease(
      tokenA,
      STOP_COMMAND,
      EMPTY,
      { wireFormat: 'v1' },
    );
    disposed.client.dispose();
    await expect(viaDispose.frame).rejects.toMatchObject({
      code: 'MSP_EMERGENCY_STOP_ABORTED_BY_SESSION_END',
    });
    expect(writtenCommands(disposed.transport)).toEqual([1]);

    const detached = makeClient();
    const tokenB = acquireToken(detached.client);
    detached.client
      .requestWithMotorTestLease(tokenB, 1, EMPTY, { wireFormat: 'v1' })
      .catch(() => {});
    const viaDetach = detached.client.emergencyStopWithMotorTestLease(
      tokenB,
      STOP_COMMAND,
      EMPTY,
      { wireFormat: 'v1' },
    );
    detached.transport.emitSessionDetached(SESSION_ID);
    await expect(viaDetach.frame).rejects.toMatchObject({
      code: 'MSP_EMERGENCY_STOP_ABORTED_BY_SESSION_END',
    });
    expect(writtenCommands(detached.transport)).toEqual([1]);
  });
});

describe('MspClient - Phase 2G: displacement is not an MSP fault', () => {
  it('keeps the lease alive across its own stop’s displacements, while every other lease-scoped failure still faults it', async () => {
    const survives = makeClient();
    const tokenA = acquireToken(survives.client);
    survives.client.requestWithMotorTestLease(tokenA, 1, EMPTY, { wireFormat: 'v1' }).catch(() => {});
    const purged = survives.client.requestWithMotorTestLease(tokenA, 2, EMPTY, {
      wireFormat: 'v1',
    });
    const dispatch = survives.client.emergencyStopWithMotorTestLease(
      tokenA,
      STOP_COMMAND,
      EMPTY,
      { wireFormat: 'v1' },
    );

    await expect(purged).rejects.toMatchObject({ code: 'MSP_DISPLACED_BY_EMERGENCY_STOP' });
    survives.transport.resolveNextWrite();
    await flushMicrotasks();
    // Both a queued and an in-flight displacement have now happened, and
    // the lease is still the live owner - otherwise the stop would be
    // travelling on a dead capability.
    expect(survives.client.isMotorTestLeaseHeld()).toBe(true);

    survives.transport.resolveNextWrite();
    survives.transport.emitData(responseFrame(STOP_COMMAND));
    await expect(dispatch.frame).resolves.toMatchObject({ command: STOP_COMMAND });
    expect(survives.client.isMotorTestLeaseHeld()).toBe(true);

    // Control: an ordinary lease-scoped failure, with no stop involved,
    // still kills the lease exactly as before.
    const faults = makeClient();
    const tokenB = acquireToken(faults.client);
    const doomed = faults.client.requestWithMotorTestLease(tokenB, 1, EMPTY, {
      wireFormat: 'v1',
    });
    faults.transport.rejectNextWrite('WRITE_FAILED');
    await expect(doomed).rejects.toMatchObject({ code: 'MSP_WRITE_OUTCOME_UNKNOWN' });
    expect(faults.client.isMotorTestLeaseHeld()).toBe(false);
  });

  it('still faults the lease when the STOP ITSELF fails', async () => {
    const { transport, client } = makeClient();
    const token = acquireToken(client);
    const dispatch = client.emergencyStopWithMotorTestLease(token, STOP_COMMAND, EMPTY, {
      wireFormat: 'v1',
    });
    expect(writtenCommands(transport)).toEqual([STOP_COMMAND]);

    transport.rejectNextWrite('SESSION_CLOSED'); // confirmed-not-sent, no desync
    await expect(dispatch.frame).rejects.toMatchObject({ code: 'MSP_SESSION_CLOSED' });
    expect(client.isMotorTestLeaseHeld()).toBe(false);
  });
});
