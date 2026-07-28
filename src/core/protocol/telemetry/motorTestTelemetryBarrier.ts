/**
 * Phase 2C - the coordinator-wide MOTOR-TEST TELEMETRY BARRIER.
 *
 * WHAT THIS IS
 * ------------
 * A session-scoped registry of telemetry schedulers plus an atomic
 * "hold every one of them, then prove the wire is quiet" operation. It
 * is the smallest abstraction that can make the statement a motor-test
 * setup needs: *no telemetry request of this session is executing, and
 * none can start*.
 *
 * WHAT IT IS NOT
 * --------------
 * It is NOT mounted. Nothing in the running application constructs or
 * calls it in this pass; its only consumers are its own tests and (in a
 * later, separately audited pass) the motor-test controller. Leaving it
 * unmounted is a requirement of this pre-wire bundle, not an oversight -
 * wiring it into the live session coordinator would make it reachable.
 *
 * It owns no MSP command, no payload, no motor value, no transport and
 * no writer. It can pause polling and wait; it can never send anything.
 *
 * WHY A REGISTRY AND NOT A LOOP OVER KNOWN SCHEDULERS
 * --------------------------------------------------
 * A barrier that pauses only the schedulers it happened to see at
 * acquisition time has a registration race: a scheduler created a
 * microtask later would be born unpaused and could dispatch straight
 * past the barrier. So registration itself goes THROUGH this registry,
 * and while any barrier is held a newly registered scheduler is paused
 * *before* `registerScheduler` returns - it is never observable in an
 * unpaused state.
 *
 * WHY PER-TOKEN LEASES AND NOT A PER-REASON FLAG
 * ----------------------------------------------
 * Two motor-test barriers, or a motor-test barrier alongside an
 * APP_BACKGROUND pause, must coexist. Every barrier token therefore owns
 * its OWN `TelemetryPauseLease` per scheduler. Releasing a token
 * releases exactly the leases that token created - never a newer
 * motor-test token's, never another owner's, never a different reason's.
 *
 * QUIESCENCE IS NOT "PAUSED"
 * --------------------------
 * Pausing stops NEW dispatches synchronously. It says nothing about work
 * already running, already awaiting an MSP response, or already accepted
 * into the client's FIFO. Those are settled only when the scheduler's own
 * dispatch promise settles, which is what `waitUntilIdle()` reports. This
 * barrier therefore always pauses first and awaits idleness second, and
 * treats a scheduler that unregistered with work still outstanding as
 * still counting.
 */

import {MSP_RESPONSE_TIMEOUT_MILLIS} from '../mspClient';
import type {TelemetryPauseLease, TelemetryPauseReason} from './telemetryTypes';

/**
 * The transport's own write bound, in milliseconds.
 *
 * Quoted, not guessed: `TX_WRITE_TIMEOUT_MILLIS = 1000` in
 * android/app/src/main/java/com/fpvarbcon/transport/UsbSerialTransportModule.kt.
 * Restated here as a named constant because this module must not import
 * anything platform-specific; if that native bound ever changes, this
 * constant is the one place to follow it.
 */
export const TRANSPORT_WRITE_BOUND_MILLIS = 1000;

/**
 * How long the barrier will wait for the session's telemetry to fall
 * quiet before giving up.
 *
 * DERIVED, NOT CHOSEN. One in-flight telemetry request is bounded by the
 * client's own two-phase contract: the transport write bound above, then
 * `MSP_RESPONSE_TIMEOUT_MILLIS`. A request that has not settled by then
 * is one the client itself will have failed. There is no sleeping, no
 * polling interval and no wall-clock guess anywhere in this module - this
 * is a deadline, and reaching it FAILS CLOSED: no barrier is produced, so
 * no motor-test session can be built on an unproven-quiet link.
 */
export const MOTOR_TEST_QUIESCENCE_TIMEOUT_MILLIS =
  TRANSPORT_WRITE_BOUND_MILLIS + MSP_RESPONSE_TIMEOUT_MILLIS;

const MOTOR_TEST_PAUSE_REASON: TelemetryPauseReason = 'MOTOR_TEST';

/**
 * The narrow slice of a telemetry scheduler this barrier needs.
 *
 * Deliberately two methods and nothing else: it can hold polling off and
 * it can be asked whether work has settled. It cannot dispatch, decode,
 * read a value or reach a client through this interface.
 * `MspTelemetryScheduler` satisfies it structurally.
 */
export interface MotorTestBarrierScheduler {
  acquirePauseLease(reason: TelemetryPauseReason): TelemetryPauseLease;
  waitUntilIdle(): Promise<void>;
}

/** Opaque per-session anchor. Compared by identity only - never
 * inspected, never serialized, never rebuilt. A replaced physical
 * session gets a new one, which is what makes a stale release harmless. */
export class MotorTestTelemetrySession {
  private readonly brand: undefined;

  constructor() {
    this.brand = undefined;
  }
}

/** Handle returned by `registerScheduler`. Unregistering removes the
 * scheduler from future acquisitions but, deliberately, NOT from a
 * quiescence calculation that is already under way - see
 * `retiringSchedulers`. */
export interface MotorTestSchedulerRegistration {
  unregister(): void;
}

export type MotorTestBarrierFailureReason =
  /** The session was never opened here, or has already been closed. */
  | 'SESSION_UNKNOWN'
  /** The session was closed or replaced while the barrier was being
   * acquired. Anything acquired is rolled back. */
  | 'SESSION_REPLACED'
  /** Telemetry did not fall quiet within the derived deadline. Fails
   * closed: nothing is held afterwards. */
  | 'QUIESCENCE_TIMEOUT';

/** Held barrier. `release()` is idempotent and releases only the leases
 * this exact token created. */
export interface MotorTestBarrierHold {
  readonly kind: 'ACQUIRED';
  readonly session: MotorTestTelemetrySession;
  release(): void;
  /** Whether this token is still holding. Purely observational. */
  isHeld(): boolean;
}

export type MotorTestBarrierAcquisition =
  | MotorTestBarrierHold
  | {
      readonly kind: 'NOT_ACQUIRED';
      readonly reason: MotorTestBarrierFailureReason;
    };

/** Injectable so tests can drive the deadline deterministically instead
 * of waiting on a real clock. Defaults to the host timer. */
export interface MotorTestBarrierTimers {
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

const DEFAULT_TIMERS: MotorTestBarrierTimers = {
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: handle => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface MotorTestTelemetryRegistryOptions {
  readonly timers?: MotorTestBarrierTimers;
  readonly quiescenceTimeoutMs?: number;
}

/** One barrier token's private bookkeeping. */
interface BarrierToken {
  readonly leases: Map<MotorTestBarrierScheduler, TelemetryPauseLease>;
  released: boolean;
}

interface SessionState {
  /** Currently registered schedulers, in registration order. */
  readonly schedulers: Set<MotorTestBarrierScheduler>;
  /**
   * Schedulers that unregistered while at least one barrier was being
   * acquired or was held. They no longer receive NEW pauses, but they
   * still count for quiescence until their outstanding work settles -
   * unregistering does not cancel a request that is already on the wire.
   */
  readonly retiringSchedulers: Set<MotorTestBarrierScheduler>;
  /** Live barrier tokens for this session. Non-empty means the
   * registration gate is closed. */
  readonly gateHolders: Set<BarrierToken>;
  closed: boolean;
}

function notAcquired(
  reason: MotorTestBarrierFailureReason,
): MotorTestBarrierAcquisition {
  return Object.freeze({kind: 'NOT_ACQUIRED' as const, reason});
}

/**
 * The coordinator-wide registry. One instance owns every session's
 * telemetry schedulers and every motor-test barrier over them.
 */
export class MotorTestTelemetryRegistry {
  private readonly sessions = new Map<
    MotorTestTelemetrySession,
    SessionState
  >();
  private readonly timers: MotorTestBarrierTimers;
  private readonly quiescenceTimeoutMs: number;

  constructor(options: MotorTestTelemetryRegistryOptions = {}) {
    this.timers = options.timers ?? DEFAULT_TIMERS;
    this.quiescenceTimeoutMs =
      options.quiescenceTimeoutMs ?? MOTOR_TEST_QUIESCENCE_TIMEOUT_MILLIS;
  }

  /** Begins tracking a physical session. The returned anchor is the only
   * way to reach that session's state. */
  openSession(): MotorTestTelemetrySession {
    const session = new MotorTestTelemetrySession();
    this.sessions.set(session, {
      schedulers: new Set(),
      retiringSchedulers: new Set(),
      gateHolders: new Set(),
      closed: false,
    });
    return session;
  }

  /**
   * Ends a session - a close, a detach, or replacement by a newer
   * physical session.
   *
   * Any barrier still held for it is released here, because its
   * schedulers are going away with the session. A later `release()` from
   * one of those tokens is then a harmless no-op, and can never reach a
   * newer session: a token only ever holds leases on scheduler objects it
   * captured itself.
   */
  closeSession(session: MotorTestTelemetrySession): void {
    const state = this.sessions.get(session);
    if (state === undefined) {
      return;
    }
    state.closed = true;
    for (const token of Array.from(state.gateHolders)) {
      this.releaseToken(state, token);
    }
    state.schedulers.clear();
    state.retiringSchedulers.clear();
    this.sessions.delete(session);
  }

  /** Whether the session is still open here. */
  isSessionOpen(session: MotorTestTelemetrySession): boolean {
    const state = this.sessions.get(session);
    return state !== undefined && !state.closed;
  }

  /** Registered scheduler count - observational, for tests and
   * diagnostics. */
  registeredSchedulerCount(session: MotorTestTelemetrySession): number {
    return this.sessions.get(session)?.schedulers.size ?? 0;
  }

  /**
   * Registers a scheduler under a session.
   *
   * THE REGISTRATION GATE. If any barrier is currently held for this
   * session, the scheduler is paused HERE, synchronously, before this
   * method returns - so it can never be observed, ticked or dispatched in
   * an unpaused state, no matter how the registration races an
   * acquisition. Each live barrier token takes its own lease on it, so
   * whichever token is released first cannot free the scheduler for the
   * others.
   */
  registerScheduler(
    session: MotorTestTelemetrySession,
    scheduler: MotorTestBarrierScheduler,
  ): MotorTestSchedulerRegistration {
    const state = this.sessions.get(session);
    if (state === undefined || state.closed) {
      // Nothing to gate and nothing to pause; the registration is inert.
      return Object.freeze({unregister: () => undefined});
    }

    state.schedulers.add(scheduler);
    state.retiringSchedulers.delete(scheduler);

    for (const token of state.gateHolders) {
      if (!token.released && !token.leases.has(scheduler)) {
        token.leases.set(
          scheduler,
          scheduler.acquirePauseLease(MOTOR_TEST_PAUSE_REASON),
        );
      }
    }

    let unregistered = false;
    return Object.freeze({
      unregister: () => {
        if (unregistered) {
          return;
        }
        unregistered = true;
        if (!state.schedulers.delete(scheduler)) {
          return;
        }
        if (state.gateHolders.size > 0) {
          // Work already dispatched by this scheduler is still on the
          // wire. It stays in the quiescence calculation - and stays
          // paused - until the barrier that cares about it releases.
          state.retiringSchedulers.add(scheduler);
        }
      },
    });
  }

  /**
   * Acquires the barrier for one session: pause everything, then prove
   * quiet.
   *
   * Ordering is the whole safety argument:
   *  1. close the registration gate FIRST, synchronously, so a scheduler
   *     registering from here on is born paused;
   *  2. take a pause lease on every scheduler already registered, still
   *     synchronously - no `await` has happened yet, so no new dispatch
   *     can slip in between;
   *  3. only then await quiescence, bounded by a derived deadline;
   *  4. re-check the session after every await.
   *
   * ALL OR NOTHING. Any failure releases every lease this call took and
   * reopens the gate for this token; a partially-held barrier is never
   * returned and never observable.
   */
  async acquireBarrier(
    session: MotorTestTelemetrySession,
  ): Promise<MotorTestBarrierAcquisition> {
    const state = this.sessions.get(session);
    if (state === undefined || state.closed) {
      return notAcquired('SESSION_UNKNOWN');
    }

    const token: BarrierToken = {leases: new Map(), released: false};
    // (1) Gate first - before inspecting or leasing anything.
    state.gateHolders.add(token);

    // (2) Synchronous pause of everything currently known, including
    // schedulers already retiring with unsettled work.
    for (const scheduler of state.schedulers) {
      token.leases.set(
        scheduler,
        scheduler.acquirePauseLease(MOTOR_TEST_PAUSE_REASON),
      );
    }
    for (const scheduler of state.retiringSchedulers) {
      if (!token.leases.has(scheduler)) {
        token.leases.set(
          scheduler,
          scheduler.acquirePauseLease(MOTOR_TEST_PAUSE_REASON),
        );
      }
    }

    // (3) Now, and only now, wait.
    const quiet = await this.awaitQuiescence(state, token);
    if (!quiet) {
      this.releaseToken(state, token);
      return notAcquired('QUIESCENCE_TIMEOUT');
    }

    // (4) The session must still be the one we started on.
    if (state.closed || this.sessions.get(session) !== state) {
      this.releaseToken(state, token);
      return notAcquired('SESSION_REPLACED');
    }

    return Object.freeze({
      kind: 'ACQUIRED' as const,
      session,
      release: () => {
        this.releaseToken(state, token);
      },
      isHeld: () => !token.released,
    });
  }

  /**
   * Waits until every scheduler in scope has no unsettled dispatch, or
   * the derived deadline passes.
   *
   * Re-collects the scheduler set after each round because the gate lets
   * new schedulers register while this is running - they are already
   * paused by then, but a scheduler that registers with work in flight
   * still has to settle. A round completes only when a full pass finds
   * nothing new, so this converges rather than sampling.
   *
   * There is no sleep and no poll interval: each round awaits real
   * `waitUntilIdle()` promises that resolve on genuine settle events, and
   * the only timer is the single deadline, cleared unconditionally.
   */
  private awaitQuiescence(
    state: SessionState,
    token: BarrierToken,
  ): Promise<boolean> {
    let timerHandle: unknown;
    let timedOut = false;
    let settleDeadline: (() => void) | undefined;

    const deadline = new Promise<void>(resolve => {
      settleDeadline = resolve;
      timerHandle = this.timers.setTimer(() => {
        timedOut = true;
        resolve();
      }, this.quiescenceTimeoutMs);
    });

    const drain = async (): Promise<void> => {
      // Bounded by the deadline race below, not by a round count: each
      // iteration only continues while genuinely new work appeared.
      for (;;) {
        if (timedOut || token.released) {
          return;
        }
        const inScope = [
          ...state.schedulers,
          ...state.retiringSchedulers,
        ];
        if (inScope.length === 0) {
          return;
        }
        await Promise.all(inScope.map(scheduler => scheduler.waitUntilIdle()));
        if (timedOut || token.released) {
          return;
        }
        const stillInScope = [...state.schedulers, ...state.retiringSchedulers];
        const grew = stillInScope.some(
          scheduler => !inScope.includes(scheduler),
        );
        if (!grew) {
          return;
        }
      }
    };

    return Promise.race([drain(), deadline]).then(
      () => !timedOut,
      () => false,
    ).finally(() => {
      // (19) No timer or unsettled promise survives, on any path.
      if (timerHandle !== undefined) {
        this.timers.clearTimer(timerHandle);
        timerHandle = undefined;
      }
      settleDeadline?.();
    });
  }

  /**
   * Releases exactly one token: its own leases, its own gate hold.
   *
   * Idempotent, and structurally incapable of touching another token -
   * every lease it releases is one it created. A token captured against
   * an old session state can only ever reach that old state's gate set
   * and those old scheduler objects, so a late release cannot disturb a
   * replacement session's telemetry.
   */
  private releaseToken(state: SessionState, token: BarrierToken): void {
    if (token.released) {
      return;
    }
    token.released = true;
    state.gateHolders.delete(token);
    for (const lease of token.leases.values()) {
      lease.release();
    }
    token.leases.clear();
    if (state.gateHolders.size === 0) {
      // Nothing is holding any more, so retiring schedulers have nothing
      // left to be accounted against.
      state.retiringSchedulers.clear();
    }
  }
}
