/**
 * A BODY THAT STOPS ARRIVING MUST NOT STOP THE APPLICATION.
 *
 * The previous round bounded `fetch()` and said so precisely: that call
 * settles on HEADERS. The body read after it had no clock at all, so a
 * peer that sent `200 OK` and then went quiet left `response.text()`
 * pending forever - and with it the Presets screen, the flasher's load
 * states, and the cloud-build poll loop that only checks its deadline
 * BETWEEN requests it never returned from.
 *
 * Every test below is written against that specific failure, and the
 * controls are as important as the failures: a bound that also kills
 * slow-but-healthy downloads would be a worse defect than the one it
 * replaced.
 */

import {
  MIN_BODY_THROUGHPUT_BYTES_PER_SECOND,
  readBytesBounded,
  readTextBounded,
} from './boundedBody';
import type {DeadlineTimers} from './deadline';

/* ------------------------------------------------------------------ *
 * A controllable clock, and a controllable body
 * ------------------------------------------------------------------ */

/**
 * Timers whose deadlines fire only when a test says so. Every armed
 * deadline is tracked, so "no leaked timer" is an observation rather
 * than an assumption.
 */
function fakeTimers(): DeadlineTimers & {
  fireLatest: () => void;
  live: number;
  armed: number[];
} {
  const handlers = new Map<number, () => void>();
  let next = 1;
  const timers = {
    armed: [] as number[],
    get live() {
      return handlers.size;
    },
    setTimer(handler: () => void, ms: number) {
      const id = next++;
      timers.armed.push(ms);
      handlers.set(id, handler);
      return id;
    },
    clearTimer(handle: unknown) {
      handlers.delete(handle as number);
    },
    fireLatest() {
      const id = Math.max(...handlers.keys());
      const handler = handlers.get(id);
      handlers.delete(id);
      handler?.();
    },
  };
  return timers as DeadlineTimers & {
    fireLatest: () => void;
    live: number;
    armed: number[];
  };
}

/** A response whose body is a stream the test drives chunk by chunk. */
function streamingResponse(options: {contentLength?: number} = {}) {
  const queue: Array<{value?: Uint8Array; done: boolean}> = [];
  let waiting: ((step: {value?: Uint8Array; done: boolean}) => void) | undefined;
  const state = {
    readerAcquired: 0,
    readerReleased: 0,
    cancelled: 0,
    /** Reads handed out that never settled - a leak, if any survive. */
    pendingReads: 0,
  };

  const push = (step: {value?: Uint8Array; done: boolean}) => {
    if (waiting !== undefined) {
      const resolve = waiting;
      waiting = undefined;
      state.pendingReads -= 1;
      resolve(step);
      return;
    }
    queue.push(step);
  };

  const response = {
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-length' && options.contentLength !== undefined
          ? String(options.contentLength)
          : null,
    },
    body: {
      getReader() {
        state.readerAcquired += 1;
        return {
          read() {
            const queued = queue.shift();
            if (queued !== undefined) return Promise.resolve(queued);
            state.pendingReads += 1;
            return new Promise<{value?: Uint8Array; done: boolean}>(resolve => {
              waiting = resolve;
            });
          },
          async cancel() {
            state.cancelled += 1;
            // A real cancel settles the pending read as done.
            if (waiting !== undefined) push({done: true});
          },
          releaseLock() {
            state.readerReleased += 1;
          },
        } as unknown as ReadableStreamDefaultReader<Uint8Array>;
      },
    },
    text: () => Promise.reject(new Error('the stream path must not call text()')),
    arrayBuffer: () =>
      Promise.reject(new Error('the stream path must not call arrayBuffer()')),
  };

  return {
    response,
    state,
    deliver: (bytes: Uint8Array) => push({value: bytes, done: false}),
    finish: () => push({done: true}),
  };
}

/** React Native's shape: no body stream, only text()/arrayBuffer(). */
function bufferedResponse(options: {contentLength?: number} = {}) {
  let settleText: ((value: string) => void) | undefined;
  let failText: ((reason: unknown) => void) | undefined;
  const response = {
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-length' && options.contentLength !== undefined
          ? String(options.contentLength)
          : null,
    },
    body: null,
    text: () =>
      new Promise<string>((resolve, reject) => {
        settleText = resolve;
        failText = reject;
      }),
    arrayBuffer: () => Promise.reject(new Error('unused')),
  };
  return {
    response,
    settle: (value: string) => settleText?.(value),
    fail: (reason: unknown) => failText?.(reason),
  };
}

const utf8 = (text: string) => new TextEncoder().encode(text);

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

/* ------------------------------------------------------------------ *
 * The gap that was left open
 * ------------------------------------------------------------------ */

describe('headers arrive, then the body stops forever', () => {
  it('reports STALLED and aborts the transfer instead of waiting', async () => {
    const {response, state, deliver} = streamingResponse({contentLength: 4096});
    const timers = fakeTimers();
    let aborts = 0;

    const reading = readTextBounded(response, {
      limitBytes: 1024 * 1024,
      stallTimeoutMs: 30_000,
      expectedBytes: 4096,
      abort: () => {
        aborts += 1;
      },
      timers,
    });

    // Some of the body arrives...
    deliver(utf8('{"targets":'));
    await flush();
    // ...and then the peer goes quiet. Nothing else happens.
    timers.fireLatest();

    const outcome = await reading;
    expect(outcome).toEqual({status: 'STALLED'});
    // The transfer is torn down, not merely abandoned.
    expect(aborts).toBe(1);
    // NO LEAKED READER: the lock is handed back either way.
    expect(state.readerReleased).toBe(state.readerAcquired);
    expect(state.cancelled).toBeGreaterThan(0);
    // NO LEAKED TIMER.
    expect(timers.live).toBe(0);
  });

  it('reports STALLED on the buffered runtime too, where there is no stream', async () => {
    const {response} = bufferedResponse({contentLength: 2048});
    const timers = fakeTimers();
    let aborts = 0;

    const reading = readTextBounded(response, {
      limitBytes: 1024 * 1024,
      stallTimeoutMs: 30_000,
      expectedBytes: 2048,
      abort: () => {
        aborts += 1;
      },
      timers,
    });
    await flush();
    timers.fireLatest();

    expect(await reading).toEqual({status: 'STALLED'});
    // Abort is what makes the pending text() reject in a real runtime,
    // rather than staying pending behind a Promise nobody holds.
    expect(aborts).toBe(1);
    expect(timers.live).toBe(0);
  });

  /**
   * THE CONTROL, and the reason this is a stall bound rather than a
   * total one. A transfer that keeps delivering must never be cut off,
   * however long it takes in total.
   */
  it('never interrupts a slow body that keeps making progress', async () => {
    const {response, state, deliver, finish} = streamingResponse();
    const timers = fakeTimers();
    let aborts = 0;

    const reading = readTextBounded(response, {
      limitBytes: 1024 * 1024,
      stallTimeoutMs: 1_000,
      abort: () => {
        aborts += 1;
      },
      timers,
    });

    // Forty chunks, each arriving just before its own deadline would
    // have fired. In wall-clock terms this transfer takes far longer
    // than any single deadline - and is completely healthy.
    for (let chunk = 0; chunk < 40; chunk += 1) {
      deliver(utf8('x'));
      await flush();
      expect(`chunk ${chunk}: aborts ${aborts}`).toBe(`chunk ${chunk}: aborts 0`);
    }
    finish();

    expect(await reading).toEqual({status: 'READ', value: 'x'.repeat(40)});
    expect(aborts).toBe(0);
    expect(timers.live).toBe(0);
    expect(state.readerReleased).toBe(state.readerAcquired);
  });

  it('re-arms the deadline per chunk rather than sharing one', async () => {
    const {response, deliver, finish} = streamingResponse();
    const timers = fakeTimers();

    const reading = readBytesBounded(response, {
      limitBytes: 1024,
      stallTimeoutMs: 5_000,
      abort: () => undefined,
      timers,
    });
    deliver(utf8('ab'));
    await flush();
    deliver(utf8('cd'));
    await flush();
    finish();
    await reading;

    // One deadline per read attempt, all with the same budget - which is
    // what "the clock restarts whenever bytes arrive" looks like.
    expect(timers.armed.every(ms => ms === 5_000)).toBe(true);
    expect(timers.armed.length).toBeGreaterThanOrEqual(3);
  });
});

/* ------------------------------------------------------------------ *
 * Cancel, late bytes, and size
 * ------------------------------------------------------------------ */

describe('cancel and late bytes', () => {
  it('surfaces a cancelled read as FAILED with the abort reason, and releases the reader', async () => {
    const {response, state} = streamingResponse();
    const timers = fakeTimers();
    const reader = response.body.getReader as unknown as () => {
      read: () => Promise<never>;
      cancel: () => Promise<void>;
      releaseLock: () => void;
    };
    void reader;

    // Model the runtime's own behaviour on abort: the pending read
    // rejects with an AbortError.
    const aborting = new Error('أُلغيت العملية.');
    aborting.name = 'AbortError';
    const failing = {
      ...response,
      body: {
        getReader() {
          state.readerAcquired += 1;
          return {
            read: () => Promise.reject(aborting),
            cancel: async () => {
              state.cancelled += 1;
            },
            releaseLock: () => {
              state.readerReleased += 1;
            },
          } as unknown as ReadableStreamDefaultReader<Uint8Array>;
        },
      },
    };

    const outcome = await readTextBounded(failing, {
      limitBytes: 1024,
      stallTimeoutMs: 30_000,
      abort: () => undefined,
      timers,
    });

    expect(outcome).toEqual({status: 'FAILED', reason: aborting});
    expect(state.readerReleased).toBe(state.readerAcquired);
    expect(timers.live).toBe(0);
  });

  /**
   * LATE BYTES AFTER A TIMEOUT must not reach the caller. The outcome
   * has already been reported; delivering a value into it afterwards
   * would be a result the operator was told did not arrive.
   */
  it('ignores bytes that arrive after the stall was declared', async () => {
    const {response, deliver, finish} = streamingResponse();
    const timers = fakeTimers();

    const reading = readTextBounded(response, {
      limitBytes: 1024,
      stallTimeoutMs: 10_000,
      abort: () => undefined,
      timers,
    });
    deliver(utf8('early'));
    await flush();
    timers.fireLatest();

    const outcome = await reading;
    expect(outcome).toEqual({status: 'STALLED'});

    // The peer recovers and sends the rest. Nobody is listening, and
    // nothing can turn a reported failure back into a success.
    deliver(utf8('late'));
    finish();
    await flush();
    expect(await reading).toEqual({status: 'STALLED'});
    expect(timers.live).toBe(0);
  });

  it('refuses an oversized body WHILE streaming, not after buffering it', async () => {
    const {response, deliver} = streamingResponse();
    const timers = fakeTimers();
    let aborts = 0;

    const reading = readBytesBounded(response, {
      limitBytes: 8,
      stallTimeoutMs: 10_000,
      abort: () => {
        aborts += 1;
      },
      timers,
    });
    deliver(new Uint8Array(4));
    await flush();
    deliver(new Uint8Array(4));
    await flush();
    // The chunk that crosses the cap ends it - the rest is never read.
    deliver(new Uint8Array(4));

    expect(await reading).toEqual({status: 'TOO_LARGE'});
    expect(aborts).toBe(1);
    expect(timers.live).toBe(0);
  });

  it('reads a normal body straight through with no drama', async () => {
    const {response, deliver, finish} = streamingResponse();
    const timers = fakeTimers();
    const reading = readTextBounded(response, {
      limitBytes: 1024,
      stallTimeoutMs: 10_000,
      abort: () => undefined,
      timers,
    });
    deliver(utf8('{"ok":'));
    await flush();
    deliver(utf8('true}'));
    await flush();
    finish();
    expect(await reading).toEqual({status: 'READ', value: '{"ok":true}'});
    expect(timers.live).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * The runtime with no progress signal
 * ------------------------------------------------------------------ */

describe('the buffered runtime gets a budget derived from the transfer', () => {
  it('derives the budget from the declared Content-Length, not the size cap', async () => {
    const declared = 320 * 1024;
    const {response, settle} = bufferedResponse({contentLength: declared});
    const timers = fakeTimers();

    const reading = readTextBounded(response, {
      limitBytes: 8 * 1024 * 1024,
      stallTimeoutMs: 30_000,
      expectedBytes: declared,
      abort: () => undefined,
      timers,
    });
    await flush();

    // A 320 kB file at the documented floor throughput, NOT the 8 MB
    // cap's worst case - which is the difference between 40 seconds and
    // seventeen minutes on a screen the operator is watching.
    const expected = Math.ceil(
      (declared / MIN_BODY_THROUGHPUT_BYTES_PER_SECOND) * 1_000,
    );
    expect(timers.armed).toEqual([expected]);

    settle('preset text');
    expect(await reading).toEqual({status: 'READ', value: 'preset text'});
    expect(timers.live).toBe(0);
  });

  it('never gives a tiny body less patience than a silent one', async () => {
    const {response, settle} = bufferedResponse({contentLength: 10});
    const timers = fakeTimers();
    const reading = readTextBounded(response, {
      limitBytes: 1024,
      stallTimeoutMs: 30_000,
      expectedBytes: 10,
      abort: () => undefined,
      timers,
    });
    await flush();
    expect(timers.armed).toEqual([30_000]);
    settle('tiny');
    await reading;
  });

  it('falls back to the size cap when the server declares no length', async () => {
    const {response, settle} = bufferedResponse();
    const timers = fakeTimers();
    const reading = readTextBounded(response, {
      limitBytes: 64 * 1024,
      stallTimeoutMs: 1_000,
      abort: () => undefined,
      timers,
    });
    await flush();
    expect(timers.armed).toEqual([
      Math.ceil(((64 * 1024) / MIN_BODY_THROUGHPUT_BYTES_PER_SECOND) * 1_000),
    ]);
    settle('ok');
    await reading;
  });

  it('reports a rejected read as FAILED rather than throwing', async () => {
    const {response, fail} = bufferedResponse({contentLength: 16});
    const timers = fakeTimers();
    const reading = readTextBounded(response, {
      limitBytes: 1024,
      stallTimeoutMs: 5_000,
      expectedBytes: 16,
      abort: () => undefined,
      timers,
    });
    await flush();
    const boom = new Error('network died mid-body');
    fail(boom);
    expect(await reading).toEqual({status: 'FAILED', reason: boom});
    expect(timers.live).toBe(0);
  });
});
