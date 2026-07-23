/**
 * Deterministic tests: a controllable fake scheduler (deferred
 * waitUntilIdle(), spy-able acquirePauseLease()/discardPendingDemands()/
 * requestRefresh()), a controllable/deferred fake operation.execute(),
 * and a mutable fake session source - no real timers anywhere, FakeClock
 * only where a real timestamp needs checking.
 */

import {createMspOperationCoordinator, MspExclusiveOperationInProgressError} from './MspOperationCoordinator';
import type {MspOperationCoordinatorOptions, MspOperationSessionSource} from './MspOperationCoordinator';
import {FakeClock} from './clock';
import {MspOperationOutcomeUnknownError} from './operationTypes';
import type {MspExclusiveOperation, MspOperationContext} from './operationTypes';
import type {MspTelemetryScheduler} from './MspTelemetryScheduler';
import type {TelemetryPauseLease, TelemetryValue} from './telemetryTypes';
import type {MspRequester} from '../msp/identification/MspIdentificationService';

const DEFAULT_CONTEXT: MspOperationContext = {clientState: 'READY', isArmed: false};
const FAKE_REQUESTER: MspRequester = {request: jest.fn()};

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** Only the four scheduler methods this coordinator actually calls are
 * meaningfully implemented; registerPoll()/getValue()/tick() are trivial
 * stubs since the coordinator never calls them. waitUntilIdle() is
 * deferred/manually controllable (resolveIdle()), same manual-control
 * pattern established by pollingCapacityAudit.test.ts's/
 * MspTelemetryScheduler.test.ts's own fakes elsewhere in this project. */
function createFakeScheduler(): MspTelemetryScheduler & {
  callOrder: string[];
  acquirePauseLeaseCallCount: number;
  discardPendingDemandsCallCount: number;
  requestRefreshCalls: Array<readonly string[]>;
  leaseReleased: boolean;
  idleCalled: boolean;
  resolveIdle: () => void;
} {
  let idleResolve: (() => void) | undefined;
  const fake = {
    callOrder: [] as string[],
    acquirePauseLeaseCallCount: 0,
    discardPendingDemandsCallCount: 0,
    requestRefreshCalls: [] as Array<readonly string[]>,
    leaseReleased: false,
    idleCalled: false,
    registerPoll(): () => void {
      return () => undefined;
    },
    getValue<T>(): TelemetryValue<T> {
      return {status: 'UNAVAILABLE'};
    },
    tick(): void {
      // Never called by MspOperationCoordinator.
    },
    acquirePauseLease(): TelemetryPauseLease {
      fake.acquirePauseLeaseCallCount += 1;
      fake.leaseReleased = false;
      return {
        id: 'fake-lease',
        release: () => {
          fake.leaseReleased = true;
          fake.callOrder.push('release');
        },
      };
    },
    waitUntilIdle(): Promise<void> {
      fake.idleCalled = true;
      return new Promise<void>(resolve => {
        idleResolve = resolve;
      });
    },
    discardPendingDemands(): void {
      fake.discardPendingDemandsCallCount += 1;
    },
    requestRefresh(ids: readonly string[]): void {
      fake.requestRefreshCalls.push(ids);
      fake.callOrder.push('requestRefresh');
    },
    resolveIdle(): void {
      idleResolve?.();
    },
  };
  return fake;
}

function createFakeSessionSource(initial: {sessionId: string; generation: number} | undefined): MspOperationSessionSource & {
  current: {sessionId: string; generation: number} | undefined;
} {
  return {
    current: initial,
    captureCurrent() {
      return this.current;
    },
  };
}

function createControllableOperation<TResult>(
  overrides: Partial<MspExclusiveOperation<TResult>> = {},
): MspExclusiveOperation<TResult> & {
  resolveExecute: (result: TResult) => void;
  rejectExecute: (error: unknown) => void;
  executeCallCount: number;
} {
  let resolveFn: ((result: TResult) => void) | undefined;
  let rejectFn: ((error: unknown) => void) | undefined;
  const op = {
    id: 'op-1',
    validate: () => ({allowed: true as const}),
    sessionEffect: 'KEEP_SESSION' as const,
    executeCallCount: 0,
    execute(_requester: MspRequester): Promise<TResult> {
      op.executeCallCount += 1;
      return new Promise<TResult>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });
    },
    resolveExecute(result: TResult): void {
      resolveFn?.(result);
    },
    rejectExecute(error: unknown): void {
      rejectFn?.(error);
    },
    ...overrides,
  };
  return op;
}

function makeCoordinator(
  scheduler: MspTelemetryScheduler,
  sessionSource: MspOperationSessionSource,
  options: Partial<MspOperationCoordinatorOptions> = {},
) {
  return createMspOperationCoordinator(FAKE_REQUESTER, scheduler, sessionSource, {
    getContext: () => DEFAULT_CONTEXT,
    ...options,
  });
}

describe('MspOperationCoordinator - RUNNING guard', () => {
  it('rejects a second execute() call immediately while one is already RUNNING, without affecting the first operation in flight', async () => {
    const scheduler = createFakeScheduler();
    const sessionSource = createFakeSessionSource({sessionId: 's1', generation: 1});
    const coordinator = makeCoordinator(scheduler, sessionSource);

    const opA = createControllableOperation<number>({id: 'a'});
    const firstPromise = coordinator.execute(opA);
    expect(coordinator.getState()).toEqual({status: 'RUNNING', operationId: 'a', startedAtMs: expect.any(Number)});

    const opB = createControllableOperation<number>({id: 'b'});
    await expect(coordinator.execute(opB)).rejects.toBeInstanceOf(MspExclusiveOperationInProgressError);
    expect(opB.executeCallCount).toBe(0);

    // First operation is unaffected - still resolves normally.
    scheduler.resolveIdle();
    await flush();
    opA.resolveExecute(42);
    const result = await firstPromise;
    expect(result).toEqual({status: 'SUCCEEDED', result: 42});
  });
});

describe('MspOperationCoordinator - no active session', () => {
  it('returns SESSION_ENDED with the default reason when there is no active session at all, without ever acquiring a pause lease', async () => {
    const scheduler = createFakeScheduler();
    const sessionSource = createFakeSessionSource(undefined);
    const coordinator = makeCoordinator(scheduler, sessionSource);
    const op = createControllableOperation<number>();

    const result = await coordinator.execute(op);

    expect(result).toEqual({status: 'SESSION_ENDED', reason: 'SESSION_CLOSED'});
    expect(scheduler.acquirePauseLeaseCallCount).toBe(0);
    expect(op.executeCallCount).toBe(0);
    expect(coordinator.getState()).toEqual({status: 'IDLE'});
  });
});

describe('MspOperationCoordinator - validation', () => {
  it('returns FAILED with validate()\'s own error when validation disallows the operation, without ever acquiring a pause lease', async () => {
    const scheduler = createFakeScheduler();
    const sessionSource = createFakeSessionSource({sessionId: 's1', generation: 1});
    const coordinator = makeCoordinator(scheduler, sessionSource);
    const validationError = new Error('armed - refusing');
    const op = createControllableOperation<number>({validate: () => ({allowed: false, error: validationError})});

    const result = await coordinator.execute(op);

    expect(result).toEqual({status: 'FAILED', error: validationError});
    expect(scheduler.acquirePauseLeaseCallCount).toBe(0);
    expect(op.executeCallCount).toBe(0);
    expect(coordinator.getState()).toEqual({status: 'IDLE'});
  });
});

describe('MspOperationCoordinator - session identity re-check after waitUntilIdle()', () => {
  it('returns SESSION_ENDED with the default reason if the session disappears while waiting for the scheduler to go idle, and NEVER calls execute()', async () => {
    const scheduler = createFakeScheduler();
    const sessionSource = createFakeSessionSource({sessionId: 's1', generation: 1});
    const coordinator = makeCoordinator(scheduler, sessionSource);
    const op = createControllableOperation<number>();

    const resultPromise = coordinator.execute(op);
    expect(scheduler.idleCalled).toBe(true);

    sessionSource.current = undefined;
    scheduler.resolveIdle();
    const result = await resultPromise;

    expect(result).toEqual({status: 'SESSION_ENDED', reason: 'SESSION_CLOSED'});
    expect(op.executeCallCount).toBe(0);
    expect(scheduler.leaseReleased).toBe(true);
    expect(coordinator.getState()).toEqual({status: 'IDLE'});
  });

  it('returns SESSION_ENDED with reason SESSION_REPLACED specifically when the session identity changes generation (same id) while waiting for idle', async () => {
    const scheduler = createFakeScheduler();
    const sessionSource = createFakeSessionSource({sessionId: 's1', generation: 1});
    const coordinator = makeCoordinator(scheduler, sessionSource);
    const op = createControllableOperation<number>();

    const resultPromise = coordinator.execute(op);
    sessionSource.current = {sessionId: 's1', generation: 2};
    scheduler.resolveIdle();
    const result = await resultPromise;

    expect(result).toEqual({status: 'SESSION_ENDED', reason: 'SESSION_REPLACED'});
    expect(op.executeCallCount).toBe(0);
    expect(scheduler.leaseReleased).toBe(true);
    expect(coordinator.getState()).toEqual({status: 'IDLE'});
  });
});

describe('MspOperationCoordinator - happy path', () => {
  it('SUCCEEDED with the correct result, and calls requestRefresh() with the correct ids BEFORE releasing the pause lease', async () => {
    const scheduler = createFakeScheduler();
    const sessionSource = createFakeSessionSource({sessionId: 's1', generation: 1});
    const coordinator = makeCoordinator(scheduler, sessionSource);
    const op = createControllableOperation<number>({refreshAfterSuccess: ['attitude', 'battery']});

    const resultPromise = coordinator.execute(op);
    scheduler.resolveIdle();
    await flush();
    op.resolveExecute(99);
    const result = await resultPromise;

    expect(result).toEqual({status: 'SUCCEEDED', result: 99});
    expect(scheduler.requestRefreshCalls).toEqual([['attitude', 'battery']]);
    expect(scheduler.callOrder).toEqual(['requestRefresh', 'release']);
    expect(scheduler.leaseReleased).toBe(true);
    expect(coordinator.getState()).toEqual({status: 'IDLE'});
  });
});

describe('MspOperationCoordinator - execute() rejection outcomes', () => {
  it('returns OUTCOME_UNKNOWN (regardless of the thrown error) if the session identity changed while execute() was pending and it then rejects', async () => {
    const scheduler = createFakeScheduler();
    const sessionSource = createFakeSessionSource({sessionId: 's1', generation: 1});
    const coordinator = makeCoordinator(scheduler, sessionSource);
    const op = createControllableOperation<number>();

    const resultPromise = coordinator.execute(op);
    scheduler.resolveIdle();
    await flush();
    expect(op.executeCallCount).toBe(1);

    sessionSource.current = {sessionId: 's2', generation: 1};
    const plainError = new Error('some ordinary failure');
    op.rejectExecute(plainError);
    const result = await resultPromise;

    expect(result).toEqual({status: 'OUTCOME_UNKNOWN', reason: plainError});
    expect(scheduler.leaseReleased).toBe(true);
    expect(coordinator.getState()).toEqual({status: 'IDLE'});
  });

  it('unwraps MspOperationOutcomeUnknownError into OUTCOME_UNKNOWN with its cause, when the session is still current', async () => {
    const scheduler = createFakeScheduler();
    const sessionSource = createFakeSessionSource({sessionId: 's1', generation: 1});
    const coordinator = makeCoordinator(scheduler, sessionSource);
    const op = createControllableOperation<number>();

    const resultPromise = coordinator.execute(op);
    scheduler.resolveIdle();
    await flush();
    const underlyingCause = new Error('write may have landed');
    op.rejectExecute(new MspOperationOutcomeUnknownError(underlyingCause));
    const result = await resultPromise;

    expect(result).toEqual({status: 'OUTCOME_UNKNOWN', reason: underlyingCause});
    expect(scheduler.leaseReleased).toBe(true);
    expect(coordinator.getState()).toEqual({status: 'IDLE'});
  });

  it('returns FAILED with the exact thrown error when execute() rejects with an ordinary error and the session is still current', async () => {
    const scheduler = createFakeScheduler();
    const sessionSource = createFakeSessionSource({sessionId: 's1', generation: 1});
    const coordinator = makeCoordinator(scheduler, sessionSource);
    const op = createControllableOperation<number>();

    const resultPromise = coordinator.execute(op);
    scheduler.resolveIdle();
    await flush();
    const boom = new Error('MSP_REMOTE_ERROR');
    op.rejectExecute(boom);
    const result = await resultPromise;

    expect(result).toEqual({status: 'FAILED', error: boom});
    expect(scheduler.leaseReleased).toBe(true);
    expect(coordinator.getState()).toEqual({status: 'IDLE'});
  });
});

describe('MspOperationCoordinator - session-ending effects', () => {
  it('EXPECT_REBOOT success never calls requestRefresh(), even if refreshAfterSuccess is set - still releases the pause lease', async () => {
    const scheduler = createFakeScheduler();
    const sessionSource = createFakeSessionSource({sessionId: 's1', generation: 1});
    const coordinator = makeCoordinator(scheduler, sessionSource);
    const op = createControllableOperation<number>({sessionEffect: 'EXPECT_REBOOT', refreshAfterSuccess: ['attitude']});

    const resultPromise = coordinator.execute(op);
    scheduler.resolveIdle();
    await flush();
    op.resolveExecute(1);
    const result = await resultPromise;

    expect(result).toEqual({status: 'SUCCEEDED', result: 1});
    expect(scheduler.requestRefreshCalls).toEqual([]);
    expect(scheduler.leaseReleased).toBe(true);
    expect(coordinator.getState()).toEqual({status: 'IDLE'});
  });

  it('EXPECT_BOOTLOADER success also never calls requestRefresh()', async () => {
    const scheduler = createFakeScheduler();
    const sessionSource = createFakeSessionSource({sessionId: 's1', generation: 1});
    const coordinator = makeCoordinator(scheduler, sessionSource);
    const op = createControllableOperation<number>({sessionEffect: 'EXPECT_BOOTLOADER', refreshAfterSuccess: ['attitude']});

    const resultPromise = coordinator.execute(op);
    scheduler.resolveIdle();
    await flush();
    op.resolveExecute(1);
    await resultPromise;

    expect(scheduler.requestRefreshCalls).toEqual([]);
  });
});

describe('MspOperationCoordinator - getState()', () => {
  it('reports IDLE before any call, RUNNING with the correct operationId/startedAtMs (via an injected clock) while in flight, and back to IDLE after completion', async () => {
    const clock = new FakeClock(12345);
    const scheduler = createFakeScheduler();
    const sessionSource = createFakeSessionSource({sessionId: 's1', generation: 1});
    const coordinator = makeCoordinator(scheduler, sessionSource, {clock});

    expect(coordinator.getState()).toEqual({status: 'IDLE'});

    const op = createControllableOperation<number>({id: 'timed-op'});
    const resultPromise = coordinator.execute(op);
    expect(coordinator.getState()).toEqual({status: 'RUNNING', operationId: 'timed-op', startedAtMs: 12345});

    scheduler.resolveIdle();
    await flush();
    op.resolveExecute(1);
    await resultPromise;

    expect(coordinator.getState()).toEqual({status: 'IDLE'});
  });
});
