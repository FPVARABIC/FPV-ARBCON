/**
 * READING A RESPONSE BODY THAT MAY STOP ARRIVING.
 *
 * =====================================================================
 * THE GAP THIS CLOSES, STATED PRECISELY
 * =====================================================================
 *
 * `fetch()` settles when the response HEADERS arrive - not when the body
 * has been read. Bounding the fetch call therefore bounds only half the
 * transfer. The other half is `response.text()` / `response.arrayBuffer()`,
 * and those await the body stream: if the peer sends `200 OK`, a
 * `Content-Length`, and then stops sending bytes, that Promise never
 * settles and never rejects. No timer is left running by then, because
 * the header deadline was cleared the moment the headers arrived.
 *
 * That is a permanent busy state with a plausible-looking cause: the
 * Presets screen stays on its loading state, the flasher stays on its
 * LoadState, and the cloud-build poll loop never reaches the deadline
 * check it does between requests - because it never returns from one.
 *
 * =====================================================================
 * WHY A STALL DEADLINE AND NOT A TOTAL ONE
 * =====================================================================
 *
 * A total body timeout would be the wrong instrument. An 8 MB firmware
 * binary on a poor mobile link is SLOW, not broken, and killing it at
 * thirty seconds would turn a working download into a defect. What
 * distinguishes the two is not elapsed time, it is PROGRESS: a healthy
 * transfer keeps delivering bytes, a dead one delivers none.
 *
 * So where the runtime gives us the body as a stream, the deadline is
 * armed per chunk and re-armed every time bytes arrive. A download that
 * crawls for ten minutes but never goes quiet is never interrupted; a
 * download that goes quiet is ended promptly, however early it was.
 *
 * =====================================================================
 * THE RUNTIME THAT HAS NO STREAM
 * =====================================================================
 *
 * `response.body` is a real ReadableStream in browsers. React Native's
 * fetch is built on the whatwg-fetch shape and does not generally
 * expose one, so there is no progress signal to re-arm from.
 *
 * That path is bounded differently and the difference is admitted rather
 * than hidden: a single deadline covering the WHOLE body, derived from
 * how many bytes are actually expected and a floor throughput -
 * `MIN_BODY_THROUGHPUT_BYTES_PER_SECOND`. The floor is not a guess: the
 * MSP link this application exists to drive runs at 115200 baud, about
 * 11.5 kB/s, and the operator downloading firmware will flash it over
 * that same class of connection. A body that cannot sustain 8 kB/s
 * cannot finish the job it is being fetched for.
 *
 * Because the budget is derived from the DECLARED `Content-Length` when
 * the server sends one, the common case is tight: a 300 kB preset file
 * gets ~37 s, not the size cap's worst case.
 *
 * =====================================================================
 * ABORT, DO NOT MERELY WALK AWAY
 * =====================================================================
 *
 * On every non-success outcome the caller's `abort()` is invoked. That
 * matters for three separate reasons, none of them cosmetic:
 *
 *   - it releases the reader and errors the stream, so `text()` on the
 *     no-stream path REJECTS instead of staying pending forever;
 *   - it tears down a half-open connection that would otherwise hold a
 *     socket and keep delivering bytes nobody is reading;
 *   - it makes late bytes unobservable, so a stalled transfer that
 *     recovers cannot deliver a value into an operation that has
 *     already reported failure.
 *
 * Nothing here ever throws: every outcome is a value, so no caller can
 * leave a branch unhandled.
 */

import {withDeadline, type DeadlineTimers} from './deadline';

/**
 * The slowest transfer worth waiting for, in bytes per second. See the
 * derivation above - this is only used where the runtime gives no
 * progress signal to re-arm a stall deadline from.
 */
export const MIN_BODY_THROUGHPUT_BYTES_PER_SECOND = 8 * 1024;

export type BoundedBodyOptions = {
  /** Hard cap. Enforced WHILE reading, not after buffering it all. */
  readonly limitBytes: number;
  /** How long the transfer may deliver nothing before it is called dead. */
  readonly stallTimeoutMs: number;
  /** Tears the transfer down. See "ABORT, DO NOT MERELY WALK AWAY". */
  readonly abort: () => void;
  /** Declared Content-Length, when the server sent one. */
  readonly expectedBytes?: number;
  readonly timers?: DeadlineTimers;
};

export type BoundedBodyOutcome<T> =
  | {readonly status: 'READ'; readonly value: T}
  | {readonly status: 'STALLED'}
  | {readonly status: 'TOO_LARGE'}
  | {readonly status: 'FAILED'; readonly reason: unknown};

type StreamingResponse = {
  readonly body?: {getReader?: () => ReadableStreamDefaultReader<Uint8Array>} | null;
  text(): Promise<string>;
  /** Optional: only the BYTES reader needs it, and only where the
   *  runtime gives no stream to read chunk by chunk. */
  arrayBuffer?(): Promise<ArrayBuffer>;
};

/** Cheap predicate. Deliberately does NOT acquire the reader: asking
 *  twice would lock the stream on the first ask and fail on the second. */
function hasStream(response: StreamingResponse): boolean {
  return typeof response.body?.getReader === 'function';
}

function readerFor(
  response: StreamingResponse,
): ReadableStreamDefaultReader<Uint8Array> | undefined {
  const getReader = response.body?.getReader;
  if (typeof getReader !== 'function') return undefined;
  try {
    return getReader.call(response.body);
  } catch {
    // A body already disturbed or locked: fall back rather than fail.
    return undefined;
  }
}

/** The whole-body budget for a runtime with no progress signal. */
function fallbackBudgetMs(options: BoundedBodyOptions): number {
  const expected = options.expectedBytes ?? options.limitBytes;
  const derived =
    (expected / MIN_BODY_THROUGHPUT_BYTES_PER_SECOND) * 1_000;
  // Never shorter than the stall budget: a tiny body still deserves the
  // same patience a silent one gets.
  return Math.max(options.stallTimeoutMs, Math.ceil(derived));
}

async function consume(
  response: StreamingResponse,
  options: BoundedBodyOptions,
): Promise<BoundedBodyOutcome<Uint8Array>> {
  const reader = readerFor(response);
  if (reader === undefined) {
    if (typeof response.arrayBuffer !== 'function') {
      return {
        status: 'FAILED',
        reason: new Error(
          'This response exposes neither a body stream nor arrayBuffer().',
        ),
      };
    }
    const outcome = await withDeadline(
      response.arrayBuffer(),
      fallbackBudgetMs(options),
      options.timers,
    );
    if (outcome.status === 'TIMED_OUT') {
      options.abort();
      return {status: 'STALLED'};
    }
    if (outcome.status === 'REJECTED') {
      return {status: 'FAILED', reason: outcome.reason};
    }
    const bytes = new Uint8Array(outcome.value);
    return bytes.length > options.limitBytes
      ? {status: 'TOO_LARGE'}
      : {status: 'READ', value: bytes};
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      /* A FRESH DEADLINE PER CHUNK is what makes this a stall bound
         rather than a total one: every chunk that arrives buys the next
         one a full budget, so a slow-but-moving transfer is never
         interrupted. */
      const step = await withDeadline(
        reader.read(),
        options.stallTimeoutMs,
        options.timers,
      );
      if (step.status === 'TIMED_OUT') {
        options.abort();
        return {status: 'STALLED'};
      }
      if (step.status === 'REJECTED') {
        return {status: 'FAILED', reason: step.reason};
      }
      const {done, value} = step.value;
      if (done) break;
      if (value === undefined) continue;
      total += value.length;
      if (total > options.limitBytes) {
        /* Refused WHILE streaming. Buffering an unbounded body first and
           measuring afterwards is how a size cap becomes a memory
           exhaustion bug on the exact input it was meant to refuse. */
        options.abort();
        return {status: 'TOO_LARGE'};
      }
      chunks.push(value);
    }
  } finally {
    /* The reader is always handed back. A leaked reader keeps the
       stream locked, which makes every later use of this response - and
       on a shared connection, the next request - fail in a way that
       looks nothing like the timeout that caused it. */
    try {
      await reader.cancel();
    } catch {
      // Already errored or closed; the lock is released either way.
    }
    try {
      reader.releaseLock();
    } catch {
      // Some engines refuse after cancel(); the lock is gone regardless.
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return {status: 'READ', value: bytes};
}

export function readBytesBounded(
  response: StreamingResponse,
  options: BoundedBodyOptions,
): Promise<BoundedBodyOutcome<Uint8Array>> {
  return consume(response, options);
}

/**
 * The same bound, decoded.
 *
 * The no-stream runtime reads through `response.text()` rather than
 * decoding bytes itself, because the environments that lack a body
 * stream are also the ones where `TextDecoder` cannot be assumed
 * present - see webUsbDfu.web.ts, which avoids it for the same reason.
 * Where a stream exists, so does TextDecoder.
 */
export async function readTextBounded(
  response: StreamingResponse,
  options: BoundedBodyOptions,
): Promise<BoundedBodyOutcome<string>> {
  if (!hasStream(response)) {
    const outcome = await withDeadline(
      response.text(),
      fallbackBudgetMs(options),
      options.timers,
    );
    if (outcome.status === 'TIMED_OUT') {
      options.abort();
      return {status: 'STALLED'};
    }
    if (outcome.status === 'REJECTED') {
      return {status: 'FAILED', reason: outcome.reason};
    }
    return outcome.value.length > options.limitBytes
      ? {status: 'TOO_LARGE'}
      : {status: 'READ', value: outcome.value};
  }

  const outcome = await consume(response, options);
  if (outcome.status !== 'READ') return outcome;
  try {
    return {
      status: 'READ',
      value: new TextDecoder('utf-8').decode(outcome.value),
    };
  } catch (reason) {
    return {status: 'FAILED', reason};
  }
}
