/**
 * TEMPORARY, Pass 7.0 measurement only - remove alongside
 * pollingCapacityAudit.ts once findings are recorded and acted on.
 */

import {
  runPollingCapacityAudit,
  summarizePollingCapacityAudit,
  DEFAULT_STATE_POLL_INTERVAL_MS,
} from './pollingCapacityAudit';
import type {
  PollingCapacityAuditClient,
  PollingCapacityAuditTransport,
  PollingCapacityAuditRunResult,
} from './pollingCapacityAudit';
import {MSP_ATTITUDE} from './commands/mspCommands';
import {MspClientError} from '../mspClient';
import type {MspClientState, MspClientDiagnosticEvent} from '../mspClient';
import type {MspFrame} from '../mspTypes';

function attitudePayload(rollDecidegrees: number, pitchDecidegrees: number, yawDegrees: number): Uint8Array {
  const s16le = (value: number) => {
    const unsigned = value < 0 ? value + 0x10000 : value;
    return [unsigned & 0xff, (unsigned >> 8) & 0xff];
  };
  return Uint8Array.from([...s16le(rollDecidegrees), ...s16le(pitchDecidegrees), ...s16le(yawDegrees)]);
}

function makeFrame(payload: Uint8Array): MspFrame {
  return {protocolVersion: 'v1', wireFormat: 'v1', direction: 'response', command: MSP_ATTITUDE, flags: 0, payload};
}

/** A minimal, fully controllable fake - `state` is mutated directly by the
 * test to script exactly when a recovery cycle "happens". Each request()
 * call returns a Promise that stays pending until the test explicitly
 * settles it via resolveNext()/rejectNext() (oldest-pending-first) - this
 * is what makes single-step control over the loop possible under fake
 * timers, rather than every request resolving instantly via a bare
 * microtask (which fake timers cannot meaningfully pace between). */
function createFakeClient(): PollingCapacityAuditClient & {
  state: MspClientState;
  requestCallCount: number;
  resolveNext: (frame: MspFrame) => void;
  rejectNext: (error: unknown) => void;
} {
  const pending: Array<{resolve: (frame: MspFrame) => void; reject: (error: unknown) => void}> = [];
  const fake = {
    state: 'READY' as MspClientState,
    requestCallCount: 0,
    getState(): MspClientState {
      return fake.state;
    },
    request(): Promise<MspFrame> {
      fake.requestCallCount += 1;
      return new Promise<MspFrame>((resolve, reject) => {
        pending.push({resolve, reject});
      });
    },
    onDiagnostic(): () => void {
      return () => undefined;
    },
    resolveNext(frame: MspFrame): void {
      const next = pending.shift();
      if (!next) {
        throw new Error('resolveNext() called with no pending request() call');
      }
      next.resolve(frame);
    },
    rejectNext(error: unknown): void {
      const next = pending.shift();
      if (!next) {
        throw new Error('rejectNext() called with no pending request() call');
      }
      next.reject(error);
    },
  };
  return fake;
}

function createFakeTransport(): PollingCapacityAuditTransport & {emit: (bytes: Uint8Array) => void} {
  const listeners = new Set<(bytes: Uint8Array) => void>();
  return {
    onDataReceived: cb => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    emit: bytes => {
      for (const listener of Array.from(listeners)) {
        listener(bytes);
      }
    },
  };
}

describe('runPollingCapacityAudit', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('stops at maxRequests when every request succeeds well before the duration limit', async () => {
    const client = createFakeClient();
    const transport = createFakeTransport();

    const resultPromise = runPollingCapacityAudit(client, transport, {maxRequests: 3, maxDurationMs: 60_000});
    for (let i = 0; i < 3; i++) {
      expect(client.requestCallCount).toBe(i + 1);
      client.resolveNext(makeFrame(attitudePayload(10, 20, 30)));
      await jest.advanceTimersByTimeAsync(0);
    }
    const result = await resultPromise;

    expect(result.stopReason).toBe('MAX_REQUESTS');
    expect(result.requestRecords).toHaveLength(3);
    expect(result.requestRecords.every(r => r.outcome.status === 'success')).toBe(true);
    expect(client.requestCallCount).toBe(3);
  });

  it('stops at maxDurationMs when requests keep succeeding but the time budget runs out first', async () => {
    const client = createFakeClient();
    const transport = createFakeTransport();

    const resultPromise = runPollingCapacityAudit(client, transport, {maxRequests: 100, maxDurationMs: 100});
    // Resolve one request at a time, advancing the virtual clock by 30ms
    // between each - after ~4 resolves elapsed time exceeds the 100ms
    // budget and the loop must stop itself, well short of 100 requests.
    // Full control over Date.now()'s progression this way, rather than
    // relying on the fake client's own request() latency.
    let resolvedCount = 0;
    for (let i = 0; i < 10 && client.requestCallCount > resolvedCount; i++) {
      client.resolveNext(makeFrame(attitudePayload(0, 0, 0)));
      resolvedCount += 1;
      await jest.advanceTimersByTimeAsync(30);
    }
    const result = await resultPromise;

    expect(result.stopReason).toBe('MAX_DURATION');
    expect(result.requestRecords.length).toBeGreaterThan(0);
    expect(result.requestRecords.length).toBeLessThan(100);
  });

  it('does NOT fire a new request while state is not READY - waits (polling) until it recovers, and records the recovery cycle', async () => {
    const client = createFakeClient();
    const transport = createFakeTransport();

    const resultPromise = runPollingCapacityAudit(client, transport, {maxRequests: 2, maxDurationMs: 60_000});
    expect(client.requestCallCount).toBe(1);

    // First request settles successfully. The state flip to
    // RESTARTING_READER is set BEFORE flushing (not after) - it must
    // already be in place the moment the loop's continuation re-checks
    // getState(), the same instant a real MSP_TIMEOUT's synchronous
    // desync-latch would have already flipped it (see mspClient.ts's own
    // class doc comment) - this fake just sets the flag directly, since
    // the loop only ever observes state via getState(), never how it got
    // there.
    client.resolveNext(makeFrame(attitudePayload(1, 1, 1)));
    client.state = 'RESTARTING_READER';
    await jest.advanceTimersByTimeAsync(0);

    // Advance through several poll intervals - request() must NOT be
    // called again while state stays non-READY.
    await jest.advanceTimersByTimeAsync(DEFAULT_STATE_POLL_INTERVAL_MS * 3);
    expect(client.requestCallCount).toBe(1);

    client.state = 'PROBING';
    await jest.advanceTimersByTimeAsync(DEFAULT_STATE_POLL_INTERVAL_MS * 2);
    expect(client.requestCallCount).toBe(1);

    // Recovers - the second (and final) request may now fire, as part of
    // the same flush that notices READY.
    client.state = 'READY';
    await jest.advanceTimersByTimeAsync(DEFAULT_STATE_POLL_INTERVAL_MS);
    expect(client.requestCallCount).toBe(2);
    client.resolveNext(makeFrame(attitudePayload(2, 2, 2)));
    const result = await resultPromise;

    expect(result.requestRecords).toHaveLength(2);
    expect(client.requestCallCount).toBe(2);
    expect(result.recoveryCycles).toHaveLength(1);
    expect(result.recoveryCycles[0].startState).toBe('RESTARTING_READER');
    expect(result.recoveryCycles[0].resolution).toBe('READY');
    expect(result.recoveryCycles[0].endedAtMs).toBeDefined();
  });

  it('stops entirely (does not keep waiting indefinitely) when state reaches RECOVERY_FAILED', async () => {
    const client = createFakeClient();
    const transport = createFakeTransport();

    const resultPromise = runPollingCapacityAudit(client, transport, {maxRequests: 10, maxDurationMs: 60_000});
    expect(client.requestCallCount).toBe(1);

    // Set BEFORE the flush that lets the loop's continuation re-check
    // getState() - see the READY-gating test's own comment for why.
    client.resolveNext(makeFrame(attitudePayload(1, 1, 1)));
    client.state = 'RESTARTING_READER';
    await jest.advanceTimersByTimeAsync(0);
    expect(client.requestCallCount).toBe(1);

    client.state = 'RECOVERY_FAILED';
    await jest.advanceTimersByTimeAsync(DEFAULT_STATE_POLL_INTERVAL_MS);
    const result = await resultPromise;

    expect(result.stopReason).toBe('RECOVERY_FAILED');
    expect(result.requestRecords).toHaveLength(1);
    expect(client.requestCallCount).toBe(1);
    expect(result.recoveryCycles).toHaveLength(1);
    expect(result.recoveryCycles[0].resolution).toBe('RECOVERY_FAILED');
  });

  it('records genuine per-request errors (not recovery waits) as error outcomes', async () => {
    const client = createFakeClient();
    const transport = createFakeTransport();

    const resultPromise = runPollingCapacityAudit(client, transport, {maxRequests: 2, maxDurationMs: 60_000});
    expect(client.requestCallCount).toBe(1);
    client.rejectNext(new MspClientError('MSP_REMOTE_ERROR'));
    await jest.advanceTimersByTimeAsync(0);

    expect(client.requestCallCount).toBe(2);
    client.resolveNext(makeFrame(attitudePayload(5, 5, 5)));
    const result = await resultPromise;

    expect(result.requestRecords).toHaveLength(2);
    expect(result.requestRecords[0].outcome.status).toBe('error');
    expect(result.requestRecords[1].outcome.status).toBe('success');
    expect(result.recoveryCycles).toHaveLength(0);
  });

  it('stops within the overall maxDurationMs budget (does not hang indefinitely) if state never reaches READY or RECOVERY_FAILED', async () => {
    const client = createFakeClient();
    const transport = createFakeTransport();

    const resultPromise = runPollingCapacityAudit(client, transport, {maxRequests: 10, maxDurationMs: 100});
    expect(client.requestCallCount).toBe(1);

    // Set BEFORE the flush, same ordering as the other recovery tests.
    // Unlike the RECOVERY_FAILED test, this state is never left - it is
    // meant to model an unexpected edge case MspClient's design does not
    // anticipate (neither READY nor RECOVERY_FAILED, forever), not a real
    // documented state transition.
    client.resolveNext(makeFrame(attitudePayload(1, 1, 1)));
    client.state = 'RESTARTING_READER';
    await jest.advanceTimersByTimeAsync(0);
    expect(client.requestCallCount).toBe(1);

    // Advance well past maxDurationMs (100ms) while state stays stuck -
    // the inner READY-wait loop must itself respect the overall budget,
    // not just the outer loop between full request attempts.
    await jest.advanceTimersByTimeAsync(500);
    const result = await resultPromise;

    expect(result.stopReason).toBe('MAX_DURATION');
    expect(result.requestRecords).toHaveLength(1);
    expect(client.requestCallCount).toBe(1);
    expect(result.recoveryCycles).toHaveLength(1);
    // Never resolved - the window ended while still inside this stretch.
    expect(result.recoveryCycles[0].resolution).toBeUndefined();
    expect(result.recoveryCycles[0].endedAtMs).toBeDefined();
  });

  it('taps transport.onDataReceived and client.onDiagnostic for the run duration, unsubscribing afterward', async () => {
    const client = createFakeClient();
    const transport = createFakeTransport();

    let diagnosticCallback: ((event: MspClientDiagnosticEvent) => void) | undefined;
    client.onDiagnostic = cb => {
      diagnosticCallback = cb;
      return () => {
        diagnosticCallback = undefined;
      };
    };

    const resultPromise = runPollingCapacityAudit(client, transport, {maxRequests: 1, maxDurationMs: 60_000});
    transport.emit(Uint8Array.from([1, 2, 3]));
    transport.emit(Uint8Array.from([4, 5]));
    // Only the discriminant `type` matters to this harness's counting - the
    // rest is cast rather than hand-building a fully valid discriminated
    // MspDiagnostic union member, same pragmatic casting this codebase's
    // other tests already use for fixtures irrelevant beyond one field.
    diagnosticCallback?.({type: 'PARSER_DIAGNOSTIC'} as unknown as MspClientDiagnosticEvent);
    diagnosticCallback?.({type: 'UNSOLICITED_FRAME'} as unknown as MspClientDiagnosticEvent);

    client.resolveNext(makeFrame(attitudePayload(0, 0, 0)));
    const result = await resultPromise;

    expect(result.nativeChunkCount).toBe(2);
    expect(result.receivedByteCount).toBe(5);
    expect(result.diagnosticCount).toBe(1);
    expect(result.unsolicitedFrameCount).toBe(1);

    // Unsubscribed - a later emit must not affect an already-returned result.
    transport.emit(Uint8Array.from([9, 9, 9]));
    expect(result.nativeChunkCount).toBe(2);
  });
});

describe('summarizePollingCapacityAudit', () => {
  function baseResult(overrides: Partial<PollingCapacityAuditRunResult> = {}): PollingCapacityAuditRunResult {
    return {
      requestRecords: [],
      recoveryCycles: [],
      startedAtMs: 0,
      endedAtMs: 1000,
      stopReason: 'MAX_REQUESTS',
      nativeChunkCount: 0,
      receivedByteCount: 0,
      diagnosticCount: 0,
      unsolicitedFrameCount: 0,
      ...overrides,
    };
  }

  it('computes min/max/average/median round-trip time correctly over a known set of successes', () => {
    // Round trips: 10, 20, 30, 40 ms.
    const result = baseResult({
      requestRecords: [
        {dispatchedAtMs: 0, settledAtMs: 10, outcome: {status: 'success', attitude: {rollDecidegrees: 0, pitchDecidegrees: 0, yawDegrees: 0}}},
        {dispatchedAtMs: 100, settledAtMs: 120, outcome: {status: 'success', attitude: {rollDecidegrees: 0, pitchDecidegrees: 0, yawDegrees: 0}}},
        {dispatchedAtMs: 200, settledAtMs: 230, outcome: {status: 'success', attitude: {rollDecidegrees: 0, pitchDecidegrees: 0, yawDegrees: 0}}},
        {dispatchedAtMs: 300, settledAtMs: 340, outcome: {status: 'success', attitude: {rollDecidegrees: 0, pitchDecidegrees: 0, yawDegrees: 0}}},
      ],
      endedAtMs: 1000,
    });

    const summary = summarizePollingCapacityAudit(result);

    expect(summary.minRoundTripMs).toBe(10);
    expect(summary.maxRoundTripMs).toBe(40);
    expect(summary.averageRoundTripMs).toBe(25);
    expect(summary.medianRoundTripMs).toBe(25); // (20+30)/2
  });

  it('computes the median correctly for an odd count too', () => {
    const result = baseResult({
      requestRecords: [
        {dispatchedAtMs: 0, settledAtMs: 10, outcome: {status: 'success', attitude: {rollDecidegrees: 0, pitchDecidegrees: 0, yawDegrees: 0}}},
        {dispatchedAtMs: 0, settledAtMs: 50, outcome: {status: 'success', attitude: {rollDecidegrees: 0, pitchDecidegrees: 0, yawDegrees: 0}}},
        {dispatchedAtMs: 0, settledAtMs: 30, outcome: {status: 'success', attitude: {rollDecidegrees: 0, pitchDecidegrees: 0, yawDegrees: 0}}},
      ],
    });

    expect(summarizePollingCapacityAudit(result).medianRoundTripMs).toBe(30);
  });

  it('counts successes and errors correctly, and reports undefined round-trip stats when there are zero successes', () => {
    const result = baseResult({
      requestRecords: [
        {dispatchedAtMs: 0, settledAtMs: 10, outcome: {status: 'error', error: new Error('boom')}},
        {dispatchedAtMs: 0, settledAtMs: 10, outcome: {status: 'error', error: new Error('boom')}},
      ],
    });

    const summary = summarizePollingCapacityAudit(result);
    expect(summary.totalAttempted).toBe(2);
    expect(summary.successCount).toBe(0);
    expect(summary.errorCount).toBe(2);
    expect(summary.minRoundTripMs).toBeUndefined();
    expect(summary.maxRoundTripMs).toBeUndefined();
    expect(summary.averageRoundTripMs).toBeUndefined();
    expect(summary.medianRoundTripMs).toBeUndefined();
  });

  it('computes effectiveRatePerSecond over actual elapsed time, not summed per-request time', () => {
    const result = baseResult({
      requestRecords: Array.from({length: 10}, (_, i) => ({
        dispatchedAtMs: i * 10,
        settledAtMs: i * 10 + 5,
        outcome: {
          status: 'success' as const,
          attitude: {rollDecidegrees: 0, pitchDecidegrees: 0, yawDegrees: 0},
        },
      })),
      startedAtMs: 0,
      endedAtMs: 2000, // 10 successes over 2 real seconds = 5/sec
    });

    expect(summarizePollingCapacityAudit(result).effectiveRatePerSecond).toBe(5);
  });

  it('aggregates recoveryCycleCount and totalNonReadyMs across multiple cycles, including one still-open at run end', () => {
    const result = baseResult({
      recoveryCycles: [
        {startState: 'RESTARTING_READER', startedAtMs: 100, endedAtMs: 250, resolution: 'READY'},
        {startState: 'RESTARTING_READER', startedAtMs: 500, endedAtMs: undefined, resolution: undefined},
      ],
      endedAtMs: 800,
    });

    const summary = summarizePollingCapacityAudit(result);
    expect(summary.recoveryCycleCount).toBe(2);
    // (250-100) + (800-500) = 150 + 300 = 450
    expect(summary.totalNonReadyMs).toBe(450);
  });

  it('flags an out-of-range decoded value as a glitch', () => {
    const result = baseResult({
      requestRecords: [
        {
          dispatchedAtMs: 0,
          settledAtMs: 10,
          outcome: {status: 'success', attitude: {rollDecidegrees: 1900, pitchDecidegrees: 0, yawDegrees: 0}},
        },
      ],
    });

    const summary = summarizePollingCapacityAudit(result);
    expect(summary.glitches).toHaveLength(1);
    expect(summary.glitches[0].reason).toBe('OUT_OF_RANGE');
  });

  it('flags a suspiciously large frame-to-frame jump between two otherwise-valid values', () => {
    const result = baseResult({
      requestRecords: [
        {dispatchedAtMs: 0, settledAtMs: 10, outcome: {status: 'success', attitude: {rollDecidegrees: 0, pitchDecidegrees: 0, yawDegrees: 0}}},
        {dispatchedAtMs: 20, settledAtMs: 30, outcome: {status: 'success', attitude: {rollDecidegrees: 1200, pitchDecidegrees: 0, yawDegrees: 0}}},
      ],
    });

    const summary = summarizePollingCapacityAudit(result);
    expect(summary.glitches).toHaveLength(1);
    expect(summary.glitches[0].reason).toBe('SUSPICIOUS_JUMP');
    expect(summary.glitches[0].index).toBe(1);
  });

  it('does NOT flag a yaw rotation that crosses the 359->0 wraparound boundary as a glitch (shortest angular distance, not naive |a - b|)', () => {
    // Yaw sequence 358 -> 0 -> 2: a tiny real rotation crossing the wrap
    // boundary. A naive |current - previous| would see |0 - 358| = 358 for
    // the first step - a false SUSPICIOUS_JUMP. The actual shortest
    // angular distance is 2 degrees either way.
    const result = baseResult({
      requestRecords: [
        {dispatchedAtMs: 0, settledAtMs: 10, outcome: {status: 'success', attitude: {rollDecidegrees: 0, pitchDecidegrees: 0, yawDegrees: 358}}},
        {dispatchedAtMs: 20, settledAtMs: 30, outcome: {status: 'success', attitude: {rollDecidegrees: 0, pitchDecidegrees: 0, yawDegrees: 0}}},
        {dispatchedAtMs: 40, settledAtMs: 50, outcome: {status: 'success', attitude: {rollDecidegrees: 0, pitchDecidegrees: 0, yawDegrees: 2}}},
      ],
    });

    expect(summarizePollingCapacityAudit(result).glitches).toHaveLength(0);
  });

  it('DOES flag a genuinely large yaw jump that does not cross the wraparound boundary', () => {
    // 10 -> 200: a real 190-degree jump (shortest angular distance is
    // 170, still well over the 90-degree threshold), nowhere near the
    // 359->0 boundary - must still be caught.
    const result = baseResult({
      requestRecords: [
        {dispatchedAtMs: 0, settledAtMs: 10, outcome: {status: 'success', attitude: {rollDecidegrees: 0, pitchDecidegrees: 0, yawDegrees: 10}}},
        {dispatchedAtMs: 20, settledAtMs: 30, outcome: {status: 'success', attitude: {rollDecidegrees: 0, pitchDecidegrees: 0, yawDegrees: 200}}},
      ],
    });

    const summary = summarizePollingCapacityAudit(result);
    expect(summary.glitches).toHaveLength(1);
    expect(summary.glitches[0].reason).toBe('SUSPICIOUS_JUMP');
    expect(summary.glitches[0].index).toBe(1);
  });

  it('does not flag ordinary small frame-to-frame deltas as glitches', () => {
    const result = baseResult({
      requestRecords: [
        {dispatchedAtMs: 0, settledAtMs: 10, outcome: {status: 'success', attitude: {rollDecidegrees: 0, pitchDecidegrees: 0, yawDegrees: 0}}},
        {dispatchedAtMs: 20, settledAtMs: 30, outcome: {status: 'success', attitude: {rollDecidegrees: 20, pitchDecidegrees: -15, yawDegrees: 1}}},
        {dispatchedAtMs: 40, settledAtMs: 50, outcome: {status: 'success', attitude: {rollDecidegrees: 35, pitchDecidegrees: -30, yawDegrees: 3}}},
      ],
    });

    expect(summarizePollingCapacityAudit(result).glitches).toHaveLength(0);
  });
});
