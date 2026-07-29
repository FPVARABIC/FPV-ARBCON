/**
 * The DEDICATED MOTOR-TEST SAFETY OBSERVATION PATH.
 *
 * WHY THIS EXISTS
 * ---------------
 * The motor-test barrier suspends every normal UI/telemetry scheduler for
 * the whole life of the lease - deliberately, because the link is
 * single-flight and a motor test must own it. That left a real gap: a
 * pulse could be authorised by SETUP-TIME facts and then run with nothing
 * observing armed state, the arming restriction, or the battery while an
 * output was live. A pre-pulse snapshot is NOT continuous monitoring, and
 * a cached UI telemetry value is NOT a live observation.
 *
 * This module closes that gap with the smallest thing that can: ONE
 * observation at a time, on the SAME lease every other motor-test request
 * travels, repeated for as long as the motor test is able to command a
 * motor. It adds no second client, no second writer, no second queue and
 * no raw-write bypass.
 *
 * WHAT IT READS, AND NOTHING ELSE
 * -------------------------------
 * Exactly what `acquireMotorDynamicSafetyObservation` reads - MSP_STATUS_EX
 * (150) and MSP_BATTERY_STATE (130), both OUT/read commands - plus the
 * identity checks that function already performs. This module imports no
 * encoder, builds no payload, and can send no write command: it cannot
 * construct MSP_SET_MOTOR even in principle.
 *
 * HOW IT INTERACTS WITH STOP - THE POINT THAT MATTERS MOST
 * --------------------------------------------------------
 * A safety observation is an ORDINARY lease request. It therefore travels
 * the ordinary FIFO, which is exactly what makes it preemptible:
 *
 *   - queued but unwritten  -> `emergencyStopWithMotorTestLease` purges the
 *     FIFO, so the observation is rejected having never reached the wire;
 *   - written, awaiting a response -> the stop displaces it IMMEDIATELY and
 *     the transport is free in that same synchronous call. The stop never
 *     waits out the observation's response timeout;
 *   - mid-write -> the stop waits only for that one uncancellable
 *     `writeBytes()` to settle, which is what keeps MSP frames atomic and
 *     is the only ordering guarantee the native layer actually offers.
 *
 * A late response belonging to a preempted observation is quarantined by
 * the client's own request identity: `handleFrame()` matches `this.active`
 * only, and a displaced request is no longer active, so its frame becomes
 * an UNSOLICITED_FRAME diagnostic and settles nothing. This module adds no
 * new matching rule and relies on no new one.
 *
 * THE SHORT RESPONSE TIMEOUT IS A SAFETY PROPERTY, NOT A TUNING KNOB.
 * An observation that hangs is indistinguishable from a link that died
 * while a motor may be turning. `MOTOR_TEST_SAFETY_OBSERVATION_TIMEOUT_MILLIS`
 * is therefore far below the ordinary MSP response timeout, so a hung read
 * becomes a STOP quickly instead of being discovered two seconds later.
 *
 * WHAT AN OBSERVATION STILL DOES NOT PROVE. It proves what the flight
 * controller reported at one instant. It is not proof that a motor is
 * turning, that it stopped, or that the facts are still true after this
 * function returns. Freshness here is an AGE BOUND on a real reading -
 * never a claim of continuous truth between readings.
 */

import {
  acquireMotorDynamicSafetyObservation,
  type MotorDynamicSafetyObservationOutcome,
} from './motorDynamicSafetyObservation';
import {
  evaluateMotorDynamicSafetyRequirements,
  type MotorDynamicSafetyBlockingReason,
} from './motorDynamicSafetyEvaluation';
import type {MotorStaticCompatibilityEvaluation} from './motorStaticCompatibility';
import type {MotorStaticFactsSessionIdentity} from './motorStaticFacts';
import type {MotorSessionIdentityProvider} from './motorFcFirmwareVersion';
import type {BoxIdsResult} from '../protocol/msp/identification/BoxIdsAcquisition';
import type {MspRequester} from '../protocol/msp/identification/MspIdentificationService';
import type {MspFrame} from '../protocol/mspTypes';
import type {MspRequestOptions} from '../protocol/mspClient';

/**
 * Response bound for ONE safety read. Deliberately far below
 * MSP_RESPONSE_TIMEOUT_MILLIS (2000): while an output may be live, a read
 * that has not answered in this long is treated as a lost link and becomes
 * a stop, rather than something to keep waiting on.
 */
export const MOTOR_TEST_SAFETY_OBSERVATION_TIMEOUT_MILLIS = 400;

/**
 * The maximum age a completed observation may have and still authorise
 * activation. Chosen as a small multiple of one real round trip
 * (~224 ms measured) so a single lost cycle is tolerated and a second one
 * is not.
 */
export const MOTOR_TEST_SAFETY_MAX_AGE_MILLIS = 750;

/** Why the monitor considers the link unsafe. Every one of these is a
 * STOP trigger for the controller - none is advisory. */
export type MotorTestSafetyUnsafeReason =
  /** The FC reported a state that fails the accepted requirements
   * (armed, arming restriction gone, battery not the approved 4S/OK). */
  | 'SAFETY_REQUIREMENTS_BLOCKED'
  /** A read failed: timeout, MSP error, transport failure, malformed
   * response, or an identity that moved under the read. */
  | 'SAFETY_OBSERVATION_FAILED'
  /** No observation has completed recently enough to be trusted. */
  | 'SAFETY_OBSERVATION_STALE';

export type MotorTestSafetyMonitorStatus =
  /** No observation has ever completed. Fails closed. */
  | {readonly kind: 'NEVER_OBSERVED'}
  | {
      readonly kind: 'SATISFIED';
      readonly observedAtMonotonicMillis: number;
      readonly sessionIdentity: MotorStaticFactsSessionIdentity;
    }
  | {
      readonly kind: 'BLOCKED';
      readonly observedAtMonotonicMillis: number;
      readonly reasons: readonly MotorDynamicSafetyBlockingReason[];
    }
  | {readonly kind: 'FAILED'; readonly reason: MotorTestSafetyUnsafeReason};

export interface MotorTestSafetyMonitorSnapshot {
  readonly status: MotorTestSafetyMonitorStatus;
  /** True only while the monitor is running AND an observation is in
   * flight or scheduled. Purely observational. */
  readonly running: boolean;
  /** How many observations have completed, successfully or not. */
  readonly completedObservations: number;
}

export interface MotorTestSafetyMonitorOptions {
  /** The LIVE lease. Every observation travels this and nothing else. */
  readonly requester: MspRequester;
  readonly staticCompatibility: MotorStaticCompatibilityEvaluation | undefined;
  readonly boxIds: BoxIdsResult | undefined;
  readonly readCurrentIdentity: MotorSessionIdentityProvider;
  readonly readMonotonicMillis: () => number;
  /**
   * Called when an observation proves the link unsafe, or when the
   * monitor's own freshness bound lapses. The controller turns this
   * straight into a priority stop; this module never stops anything
   * itself and owns no motor vocabulary.
   */
  readonly onUnsafe: (reason: MotorTestSafetyUnsafeReason) => void;
  /** Injectable so tests drive scheduling deterministically. */
  readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  /** Delay between the end of one observation and the start of the next.
   * Zero means back-to-back. */
  readonly intervalMillis?: number;
}

/**
 * Wraps the lease so every safety read carries the short response bound
 * without changing the lease's own contract or the shared read options
 * used elsewhere.
 */
function boundedRequester(requester: MspRequester): MspRequester {
  return {
    request(command: number, payload: Uint8Array, options: MspRequestOptions): Promise<MspFrame> {
      return requester.request(command, payload, {
        ...options,
        responseTimeoutMs: MOTOR_TEST_SAFETY_OBSERVATION_TIMEOUT_MILLIS,
      });
    },
  };
}

/**
 * The narrow surface the controller actually depends on. Declared so the
 * controller binds to BEHAVIOUR rather than to a class, and so a test
 * double can satisfy it without inheriting a real observation loop.
 */
export interface MotorTestSafetyMonitorLike {
  start(): void;
  stop(): void;
  snapshot(): MotorTestSafetyMonitorSnapshot;
  isFreshlySatisfied(nowMonotonicMillis: number): boolean;
}

export type MotorTestSafetyMonitorFactory = (
  options: MotorTestSafetyMonitorOptions,
) => MotorTestSafetyMonitorLike;

export class MotorTestSafetyMonitor implements MotorTestSafetyMonitorLike {
  private readonly options: MotorTestSafetyMonitorOptions;
  private readonly requester: MspRequester;
  private status: MotorTestSafetyMonitorStatus = Object.freeze({kind: 'NEVER_OBSERVED' as const});
  private started = false;
  /** Non-undefined exactly while one observation is outstanding. The
   * single-flight guard: observations never overlap, so the monitor can
   * never be the reason two reads are on the link at once. */
  private inFlight: Promise<void> | undefined;
  private timer: unknown;
  private completed = 0;
  /** Bumped on every stop()/start() so a settling observation from a
   * previous run can never publish into the current one. */
  private generation = 0;

  constructor(options: MotorTestSafetyMonitorOptions) {
    this.options = options;
    this.requester = boundedRequester(options.requester);
  }

  snapshot(): MotorTestSafetyMonitorSnapshot {
    return Object.freeze({
      status: this.status,
      running: this.started,
      completedObservations: this.completed,
    });
  }

  /**
   * True only when the LAST completed observation satisfied every
   * requirement AND is still inside the age bound. Anything else - never
   * observed, blocked, failed, or merely old - is false.
   */
  isFreshlySatisfied(nowMonotonicMillis: number): boolean {
    if (this.status.kind !== 'SATISFIED') {
      return false;
    }
    const age = nowMonotonicMillis - this.status.observedAtMonotonicMillis;
    return age >= 0 && age <= MOTOR_TEST_SAFETY_MAX_AGE_MILLIS;
  }

  /** Starts the loop. Idempotent: a second call while running does
   * nothing rather than starting a second, overlapping loop. */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.generation += 1;
    this.runOnce(this.generation).catch(() => undefined);
  }

  /**
   * Stops the loop. Any observation still in flight is ABANDONED, not
   * awaited: a stop must never be gated on a read completing. The
   * generation bump means its late result publishes nothing.
   */
  stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.generation += 1;
    if (this.timer !== undefined) {
      this.options.clearTimer(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Performs one observation immediately, outside the loop's schedule,
   * and resolves once it has published. Used by tests and by any caller
   * that needs a completed reading before deciding. Never overlaps: if
   * one is already outstanding, this joins it.
   */
  observeNow(): Promise<void> {
    if (this.inFlight !== undefined) {
      return this.inFlight;
    }
    return this.runOnce(this.generation);
  }

  private runOnce(generation: number): Promise<void> {
    const started = this.observe(generation).finally(() => {
      if (this.inFlight === started) {
        this.inFlight = undefined;
      }
    });
    this.inFlight = started;
    return started;
  }

  private async observe(generation: number): Promise<void> {
    let outcome: MotorDynamicSafetyObservationOutcome;
    try {
      outcome = await acquireMotorDynamicSafetyObservation({
        requester: this.requester,
        staticCompatibility: this.options.staticCompatibility,
        boxIds: this.options.boxIds,
        readCurrentIdentity: this.options.readCurrentIdentity,
        readMonotonicMillis: this.options.readMonotonicMillis,
      });
    } catch {
      // acquireMotorDynamicSafetyObservation is documented never to
      // throw; this is belt-and-braces so a monitor failure can never
      // become an unhandled rejection that silently ends monitoring.
      this.publishFailure(generation, 'SAFETY_OBSERVATION_FAILED');
      return;
    }

    // A result from a superseded run never publishes and never schedules.
    if (generation !== this.generation) {
      return;
    }
    this.completed += 1;

    if (outcome.kind !== 'OBSERVED') {
      this.publishFailure(generation, 'SAFETY_OBSERVATION_FAILED');
      return;
    }

    const evaluation = evaluateMotorDynamicSafetyRequirements({
      staticCompatibility: this.options.staticCompatibility,
      dynamicObservation: outcome,
      currentSessionIdentity: this.options.readCurrentIdentity(),
    });
    if (generation !== this.generation) {
      return;
    }

    if (evaluation.kind !== 'EVALUATED') {
      this.publishFailure(generation, 'SAFETY_OBSERVATION_FAILED');
      return;
    }
    if (evaluation.status !== 'REQUIREMENTS_SATISFIED') {
      this.status = Object.freeze({
        kind: 'BLOCKED' as const,
        observedAtMonotonicMillis: this.options.readMonotonicMillis(),
        reasons: evaluation.blockingReasons,
      });
      this.options.onUnsafe('SAFETY_REQUIREMENTS_BLOCKED');
      // Deliberately NOT rescheduled: a blocked observation is terminal
      // for this session. The controller faults, and only a full reset
      // may follow.
      this.started = false;
      return;
    }

    this.status = Object.freeze({
      kind: 'SATISFIED' as const,
      observedAtMonotonicMillis: this.options.readMonotonicMillis(),
      sessionIdentity: evaluation.sessionIdentity,
    });
    this.scheduleNext(generation);
  }

  private publishFailure(generation: number, reason: MotorTestSafetyUnsafeReason): void {
    if (generation !== this.generation) {
      return;
    }
    this.status = Object.freeze({kind: 'FAILED' as const, reason});
    // Terminal, same as BLOCKED: a read that failed while an output may
    // be live is a stop, never something to retry underneath a pulse.
    this.started = false;
    this.options.onUnsafe(reason);
  }

  private scheduleNext(generation: number): void {
    if (!this.started || generation !== this.generation) {
      return;
    }
    const delay = this.options.intervalMillis ?? 0;
    this.timer = this.options.setTimer(() => {
      this.timer = undefined;
      if (!this.started || generation !== this.generation) {
        return;
      }
      this.runOnce(generation).catch(() => undefined);
    }, delay);
  }
}

/**
 * The single decision point the activation gate consults.
 *
 * Fails closed on every path that is not a fresh, satisfied observation
 * from a running monitor: no monitor at all, a monitor that has never
 * observed, a blocked or failed reading, or a reading that has aged past
 * `MOTOR_TEST_SAFETY_MAX_AGE_MILLIS`.
 */
export function deriveContinuousSafetyMonitoring(
  monitor: MotorTestSafetyMonitorLike | undefined,
  nowMonotonicMillis: number,
): 'AVAILABLE_ACCEPTED_SOURCE' | 'UNAVAILABLE_NO_ACCEPTED_SOURCE' {
  if (monitor === undefined) {
    return 'UNAVAILABLE_NO_ACCEPTED_SOURCE';
  }
  if (!monitor.snapshot().running) {
    return 'UNAVAILABLE_NO_ACCEPTED_SOURCE';
  }
  return monitor.isFreshlySatisfied(nowMonotonicMillis)
    ? 'AVAILABLE_ACCEPTED_SOURCE'
    : 'UNAVAILABLE_NO_ACCEPTED_SOURCE';
}
