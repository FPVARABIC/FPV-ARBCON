/**
 * TEMPORARY, Pass 7.0 measurement only - remove once findings are recorded
 * and acted on, alongside its one call site in UsbSerialDebugPanel.tsx and
 * its own test file (pollingCapacityAudit.test.ts). This is throwaway
 * measurement scaffolding, unlike decodeAttitude.ts/MSP_ATTITUDE (added in
 * the same pass but permanent infrastructure).
 *
 * Measures how many sequential MSP_ATTITUDE request/response round trips a
 * real MspClient can sustain back-to-back, deliberately cooperating with
 * Pass 6.2b's desync/recovery machinery rather than fighting it:
 *
 * MspClient.request() itself rejects IMMEDIATELY (MSP_RECOVERING /
 * MSP_RECOVERY_REQUIRED - see mspClient.ts's checkAcceptance()) if called
 * while state !== 'READY', rather than queuing until recovery finishes.
 * Firing requests in a blind tight loop would therefore generate a burst
 * of spurious per-request "failures" for the whole duration of any real
 * recovery cycle, drowning out genuine per-request timing/error data.
 * This harness instead checks mspClient.getState() BEFORE every request
 * and, if not 'READY', waits (short-interval poll) rather than firing.
 *
 * MspClient exposes no dedicated state-change event/signal to await
 * instead of polling - onDiagnostic() only reports UNSOLICITED_FRAME/
 * PARSER_DIAGNOSTIC (mspClient.ts's own MspClientDiagnosticEvent union),
 * never a state transition. A short, cheap poll interval
 * (DEFAULT_STATE_POLL_INTERVAL_MS) is therefore the only mechanism
 * available given MspClient's current public API - confirmed by reading
 * the class, not assumed.
 *
 * Chunk/byte counting mirrors MspSessionCoordinator.beginIdentification()'s
 * own established technique exactly: a temporary transport.onDataReceived
 * listener plus mspClient.onDiagnostic(), both registered for the
 * measurement window's duration only and unsubscribed once it ends.
 */

import type {MspClientDiagnosticEvent, MspClientState, MspRequestOptions} from '../mspClient';
import type {MspFrame} from '../mspTypes';
import {MSP_ATTITUDE} from './commands/mspCommands';
import {decodeAttitude} from './decoding/decodeAttitude';
import type {MspAttitude} from './decoding/decodeAttitude';

/** Only the MspClient surface this harness actually needs - injectable so
 * tests can supply a fake client/state sequence without a real transport. */
export interface PollingCapacityAuditClient {
  getState(): MspClientState;
  request(command: number, payload: Uint8Array, options: MspRequestOptions): Promise<MspFrame>;
  onDiagnostic(callback: (event: MspClientDiagnosticEvent) => void): () => void;
}

/** Only the transport surface this harness needs - matches
 * RNMspTransport's onDataReceived() shape without importing the RN-layer
 * type into this zero-RN-dependency file. */
export interface PollingCapacityAuditTransport {
  onDataReceived(callback: (bytes: Uint8Array) => void): () => void;
}

export const DEFAULT_MAX_REQUESTS = 100;
export const DEFAULT_MAX_DURATION_MS = 15_000;
/** Cheap enough to not itself distort the measurement, short enough that
 * "wait for READY" doesn't meaningfully pad the reported non-READY time. */
export const DEFAULT_STATE_POLL_INTERVAL_MS = 20;

const EMPTY_PAYLOAD = new Uint8Array(0);
const REQUEST_OPTIONS: MspRequestOptions = {wireFormat: 'v1'};

/** A physically impossible decoded value - definite frame corruption or
 * misparsing, not merely a fast physical motion. roll/pitch are ±180
 * degrees (±1800 decidegrees) maximum by construction (atan2-derived);
 * yaw is normalized to [0, 360) degrees on the firmware side (see
 * decodeAttitude.ts's own doc comment) - see mspCommandSources.ts's
 * MSP_ATTITUDE citation for the imu.c normalization this range assumes. */
const VALID_ROLL_PITCH_DECIDEGREES = 1800;
const VALID_YAW_DEGREES_MAX = 359;

/** A same-poll-to-next-poll jump this large is suspicious (not
 * necessarily corrupt) even though still within the valid range above -
 * flagged separately from out-of-range values as a softer, heuristic
 * signal, not a hard corruption verdict. 90 degrees chosen as comfortably
 * larger than any plausible frame-to-frame change at this harness's
 * polling rate (a full quadrotor flip in under ~50-100ms is not a
 * realistic bench-test scenario), while conservative enough not to flag
 * ordinary hand-tilting during a real hardware test session. */
const SUSPICIOUS_JUMP_DECIDEGREES = 900;

/** Same real-world angular threshold as SUSPICIOUS_JUMP_DECIDEGREES above
 * (900 decidegrees = 90 degrees), expressed directly in whole degrees
 * since yawDegrees is already in that unit (see decodeAttitude.ts's own
 * doc comment on the roll/pitch-vs-yaw unit mismatch). Compared against
 * the WRAPAROUND-AWARE shortest angular distance between successive yaw
 * readings (min(rawDiff, 360 - rawDiff)), not a naive |a - b|: yawDegrees
 * is normalized to [0, 360) by the firmware (imu.c), so it wraps at the
 * 359->0 boundary - a real, tiny rotation crossing that boundary (e.g.
 * 358 -> 2) produces a naive linear difference of 356, which would be
 * catastrophically misidentified as a huge jump if compared directly.
 * roll/pitch have no equivalent wraparound (bounded to +-180 degrees by
 * construction, never normalized into a wrapping range), so they don't
 * need this treatment. */
const SUSPICIOUS_YAW_JUMP_DEGREES = 90;

/** Shortest angular distance between two yaw readings in [0, 360) degrees,
 * accounting for wraparound at the 359->0 boundary. */
function yawAngularDistanceDegrees(a: number, b: number): number {
  const rawDiff = Math.abs(a - b);
  return Math.min(rawDiff, 360 - rawDiff);
}

export type PollingCapacityAuditRequestOutcome =
  | {status: 'success'; attitude: MspAttitude}
  | {status: 'error'; error: unknown};

export interface PollingCapacityAuditRequestRecord {
  dispatchedAtMs: number;
  settledAtMs: number;
  outcome: PollingCapacityAuditRequestOutcome;
}

export interface PollingCapacityAuditRecoveryCycle {
  /** The state observed at the start of this non-READY stretch - the
   * genuinely-observable first state per mspClient.ts's own doc comment
   * (DESYNCHRONIZED itself is never externally observable). */
  startState: MspClientState;
  startedAtMs: number;
  /** undefined only for the terminal case: the window ended (ran out of
   * requests/time, or the harness stopped for RECOVERY_FAILED) while still
   * inside this stretch. */
  endedAtMs: number | undefined;
  /** 'READY' (recovered successfully) or 'RECOVERY_FAILED' (terminal) -
   * undefined if the stretch never resolved before the window ended. */
  resolution: 'READY' | 'RECOVERY_FAILED' | undefined;
}

export interface PollingCapacityAuditRunResult {
  requestRecords: PollingCapacityAuditRequestRecord[];
  recoveryCycles: PollingCapacityAuditRecoveryCycle[];
  startedAtMs: number;
  endedAtMs: number;
  /** Which condition actually stopped the run. */
  stopReason: 'MAX_REQUESTS' | 'MAX_DURATION' | 'RECOVERY_FAILED';
  nativeChunkCount: number;
  receivedByteCount: number;
  diagnosticCount: number;
  unsolicitedFrameCount: number;
}

export interface PollingCapacityAuditOptions {
  maxRequests?: number;
  maxDurationMs?: number;
  statePollIntervalMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Drives the actual request loop against a real (or fake, for tests)
 * MspClient/transport pair. See this file's own class-level doc comment
 * for the READY-gating design this implements.
 */
export async function runPollingCapacityAudit(
  client: PollingCapacityAuditClient,
  transport: PollingCapacityAuditTransport,
  options: PollingCapacityAuditOptions = {},
): Promise<PollingCapacityAuditRunResult> {
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  const statePollIntervalMs = options.statePollIntervalMs ?? DEFAULT_STATE_POLL_INTERVAL_MS;

  let nativeChunkCount = 0;
  let receivedByteCount = 0;
  let diagnosticCount = 0;
  let unsolicitedFrameCount = 0;

  const unsubscribeData = transport.onDataReceived(bytes => {
    nativeChunkCount += 1;
    receivedByteCount += bytes.length;
  });
  const unsubscribeDiagnostic = client.onDiagnostic(event => {
    if (event.type === 'UNSOLICITED_FRAME') {
      unsolicitedFrameCount += 1;
    } else {
      diagnosticCount += 1;
    }
  });

  const requestRecords: PollingCapacityAuditRequestRecord[] = [];
  const recoveryCycles: PollingCapacityAuditRecoveryCycle[] = [];
  const startedAtMs = Date.now();
  let stopReason: PollingCapacityAuditRunResult['stopReason'] = 'MAX_DURATION';

  try {
    while (requestRecords.length < maxRequests && Date.now() - startedAtMs < maxDurationMs) {
      let currentState = client.getState();

      if (currentState !== 'READY') {
        const cycle: PollingCapacityAuditRecoveryCycle = {
          startState: currentState,
          startedAtMs: Date.now(),
          endedAtMs: undefined,
          resolution: undefined,
        };
        recoveryCycles.push(cycle);

        // The overall maxDurationMs budget is checked here too (not just
        // between full request attempts, further down/up in the outer
        // loop) - a genuine, unconditional safety net. If MspClient ever
        // got stuck in some state that is neither 'READY' nor
        // 'RECOVERY_FAILED' forever (an unexpected edge case, not
        // expected by design but not ruled out on real hardware either),
        // this inner loop would otherwise spin/poll indefinitely with no
        // way to stop.
        while (
          currentState !== 'READY' &&
          currentState !== 'RECOVERY_FAILED' &&
          Date.now() - startedAtMs < maxDurationMs
        ) {
          await sleep(statePollIntervalMs);
          currentState = client.getState();
        }

        cycle.endedAtMs = Date.now();
        // Stays undefined (per this field's own doc comment) for the
        // timed-out-while-still-waiting case below - the stretch never
        // actually resolved before the window ended.
        cycle.resolution = currentState === 'READY' || currentState === 'RECOVERY_FAILED' ? currentState : undefined;

        if (currentState === 'RECOVERY_FAILED') {
          stopReason = 'RECOVERY_FAILED';
          break;
        }
        if (currentState !== 'READY') {
          // Timed out waiting for READY/RECOVERY_FAILED - stop here
          // rather than firing a request against a non-READY client.
          stopReason = 'MAX_DURATION';
          break;
        }
      }

      if (requestRecords.length >= maxRequests) {
        stopReason = 'MAX_REQUESTS';
        break;
      }
      if (Date.now() - startedAtMs >= maxDurationMs) {
        stopReason = 'MAX_DURATION';
        break;
      }

      const dispatchedAtMs = Date.now();
      try {
        const frame = await client.request(MSP_ATTITUDE, EMPTY_PAYLOAD, REQUEST_OPTIONS);
        requestRecords.push({
          dispatchedAtMs,
          settledAtMs: Date.now(),
          outcome: {status: 'success', attitude: decodeAttitude(frame.payload)},
        });
      } catch (error) {
        requestRecords.push({
          dispatchedAtMs,
          settledAtMs: Date.now(),
          outcome: {status: 'error', error},
        });
      }
    }

    if (stopReason !== 'RECOVERY_FAILED') {
      stopReason = requestRecords.length >= maxRequests ? 'MAX_REQUESTS' : 'MAX_DURATION';
    }
  } finally {
    unsubscribeData();
    unsubscribeDiagnostic();
  }

  return {
    requestRecords,
    recoveryCycles,
    startedAtMs,
    endedAtMs: Date.now(),
    stopReason,
    nativeChunkCount,
    receivedByteCount,
    diagnosticCount,
    unsolicitedFrameCount,
  };
}

export interface PollingCapacityAuditGlitch {
  index: number;
  reason: 'OUT_OF_RANGE' | 'SUSPICIOUS_JUMP';
  attitude: MspAttitude;
  previousAttitude?: MspAttitude;
}

export interface PollingCapacityAuditSummary {
  totalAttempted: number;
  successCount: number;
  errorCount: number;
  /** milliseconds; undefined if successCount === 0 (nothing to summarize). */
  minRoundTripMs: number | undefined;
  maxRoundTripMs: number | undefined;
  averageRoundTripMs: number | undefined;
  medianRoundTripMs: number | undefined;
  /** successful requests per second, over the run's actual elapsed
   * wall-clock time (endedAtMs - startedAtMs), NOT per-request time summed -
   * this is the achieved sustained rate, including any recovery pauses. */
  effectiveRatePerSecond: number;
  recoveryCycleCount: number;
  totalNonReadyMs: number;
  glitches: PollingCapacityAuditGlitch[];
}

function median(sortedAscending: number[]): number {
  const mid = Math.floor(sortedAscending.length / 2);
  if (sortedAscending.length % 2 === 0) {
    return (sortedAscending[mid - 1] + sortedAscending[mid]) / 2;
  }
  return sortedAscending[mid];
}

/** Pure aggregation over an already-completed run's raw records - no
 * timers, no I/O, directly unit-testable with hand-built fixtures. */
export function summarizePollingCapacityAudit(result: PollingCapacityAuditRunResult): PollingCapacityAuditSummary {
  const successRecords = result.requestRecords.filter(
    (r): r is PollingCapacityAuditRequestRecord & {outcome: {status: 'success'; attitude: MspAttitude}} =>
      r.outcome.status === 'success',
  );
  const errorCount = result.requestRecords.length - successRecords.length;

  const roundTrips = successRecords.map(r => r.settledAtMs - r.dispatchedAtMs).sort((a, b) => a - b);
  const totalElapsedMs = result.endedAtMs - result.startedAtMs;

  const glitches: PollingCapacityAuditGlitch[] = [];
  let previousAttitude: MspAttitude | undefined;
  successRecords.forEach((record, index) => {
    const {attitude} = record.outcome;
    const outOfRange =
      Math.abs(attitude.rollDecidegrees) > VALID_ROLL_PITCH_DECIDEGREES ||
      Math.abs(attitude.pitchDecidegrees) > VALID_ROLL_PITCH_DECIDEGREES ||
      attitude.yawDegrees < 0 ||
      attitude.yawDegrees > VALID_YAW_DEGREES_MAX;
    if (outOfRange) {
      glitches.push({index, reason: 'OUT_OF_RANGE', attitude, previousAttitude});
    } else if (previousAttitude) {
      const rollPitchJump = Math.max(
        Math.abs(attitude.rollDecidegrees - previousAttitude.rollDecidegrees),
        Math.abs(attitude.pitchDecidegrees - previousAttitude.pitchDecidegrees),
      );
      const yawJump = yawAngularDistanceDegrees(attitude.yawDegrees, previousAttitude.yawDegrees);
      if (rollPitchJump > SUSPICIOUS_JUMP_DECIDEGREES || yawJump > SUSPICIOUS_YAW_JUMP_DEGREES) {
        glitches.push({index, reason: 'SUSPICIOUS_JUMP', attitude, previousAttitude});
      }
    }
    previousAttitude = attitude;
  });

  return {
    totalAttempted: result.requestRecords.length,
    successCount: successRecords.length,
    errorCount,
    minRoundTripMs: roundTrips.length > 0 ? roundTrips[0] : undefined,
    maxRoundTripMs: roundTrips.length > 0 ? roundTrips[roundTrips.length - 1] : undefined,
    averageRoundTripMs:
      roundTrips.length > 0 ? roundTrips.reduce((sum, v) => sum + v, 0) / roundTrips.length : undefined,
    medianRoundTripMs: roundTrips.length > 0 ? median(roundTrips) : undefined,
    effectiveRatePerSecond: totalElapsedMs > 0 ? (successRecords.length / totalElapsedMs) * 1000 : 0,
    recoveryCycleCount: result.recoveryCycles.length,
    totalNonReadyMs: result.recoveryCycles.reduce(
      (sum, cycle) => sum + ((cycle.endedAtMs ?? result.endedAtMs) - cycle.startedAtMs),
      0,
    ),
    glitches,
  };
}
