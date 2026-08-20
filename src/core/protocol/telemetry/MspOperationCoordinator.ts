/**
 * Pass 7.3: mutual-exclusion + session-identity-aware coordinator for a
 * single "exclusive" MSP operation at a time (MSP_SET_* writes, reboot,
 * bootloader entry, etc.). PURE LOGIC ONLY - no React, no wiring into
 * the real MspSessionCoordinator/MspTelemetryScheduler singletons, no
 * UI, no hardware. Sits directly on top of Pass 7.2's MspTelemetryScheduler
 * (pauses it for the operation's duration) without depending on any of
 * Pass 7.2's concrete RN wiring.
 *
 * ==========================================================================
 * WHY getContext AND clock EXIST BEYOND THIS PASS'S EXPLICIT 3-PARAM LIST
 * ==========================================================================
 * This pass's own spec lists exactly three positional constructor/factory
 * parameters: an MspRequester, an MspTelemetryScheduler, and an
 * MspOperationSessionSource. But execute()'s own step 4
 * (operation.validate(context)) has no other source for `context` under
 * the given, fixed single-argument execute(operation) signature - and
 * ExclusiveOperationState's RUNNING variant requires a startedAtMs
 * timestamp with no clock ever mentioned either. Both are genuinely
 * required for this coordinator to function at all, not optional nice-
 * to-haves, so they are added inside a 4th parameter,
 * MspOperationCoordinatorOptions (mirroring Pass 7.2's own
 * createMspTelemetryScheduler(requester, options) trailing-options-
 * object convention) - `getContext` is REQUIRED within that object (no
 * silent default), matching this codebase's existing "no silent
 * defaults for safety-relevant parameters" discipline (see
 * mspClient.ts's own MspRequestOptions.wireFormat doc comment: "Required,
 * never inferred or defaulted") - a default context here would risk
 * silently masking a real integration bug (forgetting to wire in the
 * real clientState/isArmed) behind a plausible-looking fallback. `clock`
 * IS optional, defaulting to RealClock, exactly mirroring
 * MspTelemetrySchedulerOptions.clock's own precedent - a timestamp
 * default carries none of getContext's safety risk. Flagging this
 * explicitly per this pass's own "report design choices, don't silently
 * assume" instruction, not something to silently accept without
 * comment.
 *
 * ==========================================================================
 * SESSION_ENDED'S AMBIGUOUS-REASON DEFAULT
 * ==========================================================================
 * Both step 3 (no session at all when execute() is first called) and the
 * ambiguous branch of step 6's re-check (session identity comparison
 * inconclusive - current is undefined, or its sessionId doesn't match at
 * all) default to reason 'SESSION_CLOSED' - chosen over 'DEVICE_DETACHED'
 * as the more conservative, generic default: "closed" is the broader,
 * less specific claim (it asserts only "there is no usable session,"
 * without asserting anything about WHY), whereas DEVICE_DETACHED asserts
 * a specific physical cause this pass has no way to actually confirm
 * from identity alone. This pass genuinely CANNOT distinguish
 * DEVICE_DETACHED from SESSION_CLOSED given only
 * MspOperationSessionSource's tiny captureCurrent() surface - a later
 * integration pass wiring the real MspSessionCoordinator should supply
 * the real reason instead of this coordinator guessing. Known
 * limitation, not an oversight.
 *
 * ==========================================================================
 * RELEASING THE PAUSE LEASE ON A SESSION-ENDING SUCCESS
 * ==========================================================================
 * On SUCCEEDED for EXPECT_REBOOT/EXPECT_BOOTLOADER/EXPECT_DISCONNECT,
 * this coordinator still releases the pause lease it acquired (same as
 * every other exit path that acquired one) - it simply skips
 * requestRefresh() first, since there is nothing meaningful left to
 * refresh on a session that just intentionally ended. Whether releasing
 * THIS SPECIFIC lease on THIS SPECIFIC (now possibly stale) scheduler
 * instance is fully correct is flagged, not solved, here: Pass 7.2's
 * MspTelemetryScheduler is entirely session-agnostic in this pure-logic
 * pass (it has no idea a reboot/bootloader/disconnect just happened, or
 * that "its" session is gone) - a later integration pass will need to
 * decide what happens to a scheduler (and its registered polls) when the
 * session it was polling through ends, likely replacing it with a fresh
 * scheduler for the new session entirely rather than continuing to
 * release leases against the old one. Out of scope here.
 */

import type {MspRequester} from '../msp/identification/MspIdentificationService';
import type {MonotonicClock} from './clock';
import {RealClock} from './clock';
import type {MspTelemetryScheduler} from './MspTelemetryScheduler';
import {MspOperationOutcomeUnknownError} from './operationTypes';
import type {
  ExclusiveOperationState,
  MspExclusiveOperation,
  MspOperationContext,
  OperationExecutionPhase,
  SetupOperationResult,
} from './operationTypes';

/** Thrown (the returned Promise rejects) IMMEDIATELY, before any async
 * work, when execute() is called while another operation is already
 * RUNNING - a caller-misuse signal, never part of SetupOperationResult,
 * never silently queued. */
export class MspExclusiveOperationInProgressError extends Error {
  constructor(public readonly runningOperationId: string) {
    super(`MSP exclusive operation "${runningOperationId}" is already running`);
    this.name = 'MspExclusiveOperationInProgressError';
  }
}

export interface MspOperationCoordinator {
  execute<TResult>(operation: MspExclusiveOperation<TResult>): Promise<SetupOperationResult<TResult>>;
  getState(): ExclusiveOperationState;
}

export type MspOperationSessionSource = {
  /** undefined = no active session at all right now. Mirrors
   * MspSessionCoordinator.getSessionKey()'s real return shape from Pass
   * 7.1 exactly - tests inject a fake implementing this same tiny
   * interface; wiring to the real singleton is a later integration pass. */
  captureCurrent(): {sessionId: string; generation: number} | undefined;
};

export interface MspOperationCoordinatorOptions {
  /** See this file's own class-level doc comment on why this had to be
   * added beyond this pass's explicit 3-positional-parameter list, and
   * why it is required rather than defaulted. */
  getContext: () => MspOperationContext;
  /** Defaults to RealClock - see clock.ts. */
  clock?: MonotonicClock;
  /** Overrides WAIT_FOR_IDLE_TIMEOUT_MILLIS. Tests only. */
  waitForIdleTimeoutMs?: number;
  /** Injectable timers, so a test can drive the deadline. */
  setTimer?: (handler: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * HOW LONG THE SCHEDULER GETS TO GO QUIET, and why this exists at all.
 *
 * Step 5 below pauses telemetry and then AWAITS the scheduler becoming
 * idle. `waitUntilIdle()` resolves from the `.finally()` of the polls
 * that are in flight when it is called - so if a single poll never
 * settles, that promise never settles either, and there is no drain on
 * teardown that would release it.
 *
 * Every configuration screen's load and save funnels through here. An
 * unbounded wait at this line is therefore an unbounded LOADING or
 * SAVING on Modes, OSD, Ports, GPS, PID, Failsafe, Power, VTX,
 * Receiver, Configurations and Presets simultaneously - one line, ten
 * spinners that never stop.
 *
 * The number: an MSP request is bounded at MSP_RESPONSE_TIMEOUT_MILLIS
 * (2s), and quiescence may legitimately have to wait for a couple of
 * requests already on the wire plus the transport's own write bound. 6s
 * is comfortably longer than any honest quiescence and far shorter than
 * an operator's patience. Timing out here is not a failure of the
 * operation - it is a refusal to START one while the link is not quiet,
 * reported as SESSION_ENDED so the screen shows its ordinary
 * disconnected posture rather than a spinner.
 *
 * The RACE pattern is copied deliberately from
 * motorTestTelemetryBarrier.awaitQuiescence(), which already had it.
 */
export const WAIT_FOR_IDLE_TIMEOUT_MILLIS = 6_000;

/** The default SESSION_ENDED reason for both step 3 (no session at
 * execute()-start) and step 6's ambiguous re-check branch - see this
 * file's own class-level doc comment. */
const DEFAULT_SESSION_ENDED_REASON = 'SESSION_CLOSED';

type SessionIdentity = {sessionId: string; generation: number};

/** True only for the UNAMBIGUOUS same-session-different-generation case -
 * every other outcome (current undefined, or a wholly different
 * sessionId) is the ambiguous-default case per step 6's own spec. */
function isUnambiguousReplacement(captured: SessionIdentity, current: SessionIdentity | undefined): boolean {
  return current !== undefined && current.sessionId === captured.sessionId && current.generation !== captured.generation;
}

function isStillCurrent(captured: SessionIdentity, current: SessionIdentity | undefined): boolean {
  return current !== undefined && current.sessionId === captured.sessionId && current.generation === captured.generation;
}

class MspOperationCoordinatorImpl implements MspOperationCoordinator {
  private state: ExclusiveOperationState = {status: 'IDLE'};
  /** Internal only - OperationExecutionPhase has no getter on the
   * public MspOperationCoordinator interface this pass was given, so
   * this is tracked (per execute()'s own exact numbered sequence) but
   * not currently observable from outside this class. See this pass's
   * own report for whether a later pass should expose it. */
  private phase: OperationExecutionPhase = 'NOT_STARTED';

  constructor(
    private readonly requester: MspRequester,
    private readonly scheduler: MspTelemetryScheduler,
    private readonly sessionSource: MspOperationSessionSource,
    private readonly getContext: () => MspOperationContext,
    private readonly clock: MonotonicClock,
    private readonly waitForIdleTimeoutMs: number,
    private readonly setTimer: (handler: () => void, ms: number) => unknown,
    private readonly clearTimer: (handle: unknown) => void,
  ) {}

  /**
   * `waitUntilIdle()` with a deadline. Resolves true if the scheduler
   * genuinely went idle, false if the deadline won.
   *
   * The timer is cleared on BOTH outcomes: a lingering one would fire
   * into an operation that has already moved on.
   */
  private async waitUntilIdleBounded(): Promise<boolean> {
    let handle: unknown;
    let timedOut = false;
    const deadline = new Promise<void>(resolve => {
      handle = this.setTimer(() => {
        timedOut = true;
        resolve();
      }, this.waitForIdleTimeoutMs);
    });
    try {
      await Promise.race([this.scheduler.waitUntilIdle(), deadline]);
    } finally {
      this.clearTimer(handle);
    }
    return !timedOut;
  }

  getState(): ExclusiveOperationState {
    return this.state;
  }

  async execute<TResult>(operation: MspExclusiveOperation<TResult>): Promise<SetupOperationResult<TResult>> {
    // Step 1: reject immediately, before any async work, if already RUNNING.
    if (this.state.status === 'RUNNING') {
      throw new MspExclusiveOperationInProgressError(this.state.operationId);
    }

    // Step 2.
    this.state = {status: 'RUNNING', operationId: operation.id, startedAtMs: this.clock.now()};
    this.phase = 'NOT_STARTED';
    const captured = this.sessionSource.captureCurrent();

    // Step 3.
    if (!captured) {
      this.state = {status: 'IDLE'};
      return {status: 'SESSION_ENDED', reason: DEFAULT_SESSION_ENDED_REASON};
    }

    // Step 4.
    const validation = operation.validate(this.getContext());
    if (!validation.allowed) {
      this.state = {status: 'IDLE'};
      return {status: 'FAILED', error: validation.error};
    }

    // Step 5.
    this.phase = 'WAITING_FOR_IDLE';
    const lease = this.scheduler.acquirePauseLease('EXCLUSIVE_OPERATION');
    this.scheduler.discardPendingDemands();
    if (!(await this.waitUntilIdleBounded())) {
      /* The link would not go quiet. Refusing to start is the honest
         answer - starting an exclusive write on a link that still has
         unsettled traffic on it is exactly what the pause lease exists
         to prevent - and it is reported as a session-level outcome so
         the screen shows its ordinary disconnected posture instead of a
         spinner that never stops. */
      lease.release();
      this.state = {status: 'IDLE'};
      this.phase = 'NOT_STARTED';
      return {status: 'SESSION_ENDED', reason: DEFAULT_SESSION_ENDED_REASON};
    }

    // Step 6.
    const afterIdle = this.sessionSource.captureCurrent();
    if (isUnambiguousReplacement(captured, afterIdle)) {
      lease.release();
      this.state = {status: 'IDLE'};
      return {status: 'SESSION_ENDED', reason: 'SESSION_REPLACED'};
    }
    if (!isStillCurrent(captured, afterIdle)) {
      lease.release();
      this.state = {status: 'IDLE'};
      return {status: 'SESSION_ENDED', reason: DEFAULT_SESSION_ENDED_REASON};
    }

    // Step 7.
    this.phase = 'DISPATCHING';
    let result: TResult;
    try {
      this.phase = 'AWAITING_CONFIRMATION';
      result = await operation.execute(this.requester);
    } catch (error) {
      // Step 9.
      const postFailure = this.sessionSource.captureCurrent();
      const stillCurrent = isStillCurrent(captured, postFailure);
      lease.release();
      this.state = {status: 'IDLE'};
      if (!stillCurrent) {
        return {status: 'OUTCOME_UNKNOWN', reason: error};
      }
      if (error instanceof MspOperationOutcomeUnknownError) {
        return {status: 'OUTCOME_UNKNOWN', reason: error.cause};
      }
      return {status: 'FAILED', error};
    }

    // Step 8.
    this.phase = 'SUCCESS_CONFIRMED';
    if (operation.sessionEffect === 'KEEP_SESSION') {
      const postSuccess = this.sessionSource.captureCurrent();
      if (isStillCurrent(captured, postSuccess) && operation.refreshAfterSuccess) {
        this.scheduler.requestRefresh(operation.refreshAfterSuccess);
      }
    }
    lease.release();
    this.state = {status: 'IDLE'};
    return {status: 'SUCCEEDED', result};
  }
}

/** Factory, mirroring createMspTelemetryScheduler()'s own established
 * interface+factory convention in this codebase. */
export function createMspOperationCoordinator(
  requester: MspRequester,
  scheduler: MspTelemetryScheduler,
  sessionSource: MspOperationSessionSource,
  options: MspOperationCoordinatorOptions,
): MspOperationCoordinator {
  return new MspOperationCoordinatorImpl(
    requester,
    scheduler,
    sessionSource,
    options.getContext,
    options.clock ?? new RealClock(),
    options.waitForIdleTimeoutMs ?? WAIT_FOR_IDLE_TIMEOUT_MILLIS,
    options.setTimer ?? ((handler, ms) => setTimeout(handler, ms)),
    options.clearTimer ??
      (handle => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      }),
  );
}
