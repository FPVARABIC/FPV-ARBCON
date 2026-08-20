/**
 * ENDING THE MOTOR TEST SESSION CANNOT WAIT FOREVER.
 *
 * =====================================================================
 * THE SHAPE OF THE DEFECT
 * =====================================================================
 *
 * `endMotorTestSessionSafely()` settles on EVENTS: a snapshot reaching
 * CLOSED with a complete teardown, or `endSession()` itself settling.
 * Every one of its internal guards can legitimately decline to act -
 * the phase is already CLOSING, the controller is not settled for
 * release, no further notification arrives - so there was a shape in
 * which no event ever came and the Promise simply stayed pending.
 *
 * The screen above it sets `endingSession` before calling and clears it
 * in `.finally()`. A Promise that never settles never reaches that
 * `.finally()`, so «جارٍ إنهاء الجلسة» was permanent, on the one screen
 * where the operator most needs the application to be honest.
 *
 * =====================================================================
 * WHY EXPIRY REJECTS RATHER THAN RESOLVES
 * =====================================================================
 *
 * Resolving would say "the session is closed". It is not - that is the
 * whole point. Rejecting sends the caller down the failure path it
 * already had, which shows the close-failed banner and keeps the
 * operator on Motors. Nothing here claims a motor stopped; command
 * authority is withdrawn by the screen before this is ever called.
 */

import {
  MOTOR_TEST_TEARDOWN_BOUND_MILLIS,
  endMotorTestSessionSafely,
} from './MotorsScreen';
import type {MotorTestOperatorPort} from '../../platforms/react-native/protocol';
import type {MotorTestControllerSnapshot} from '../../core/state/motorTestController';

type Phase = 'IDLE' | 'ACTIVATING' | 'ACTIVE' | 'CLOSING' | 'CLOSED';

function snapshotFor(phase: Phase, teardownComplete?: boolean): MotorTestControllerSnapshot {
  return {
    phase,
    machine: {name: phase === 'ACTIVE' ? 'Ready' : 'Locked'},
    outcome: {kind: 'READY'},
    stopExecution: {attempts: 0},
    pulse: {attemptId: 0},
    ...(teardownComplete === undefined
      ? {teardown: undefined}
      : {teardown: {complete: teardownComplete, steps: []}}),
  } as unknown as MotorTestControllerSnapshot;
}

/**
 * A controller that answers requestStop and then goes quiet - the exact
 * shape that produced the permanent busy state. `endSession()` is
 * available but never settles, and no snapshot ever reaches CLOSED.
 */
function silentOperator(options: {phase: Phase; endSettles: boolean}) {
  const listeners = new Set<() => void>();
  let snapshot = snapshotFor(options.phase);
  const operator = {
    endCalls: 0,
    stopCalls: [] as string[],
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    requestStop(trigger: string) {
      operator.stopCalls.push(trigger);
      return 'ACCEPTED' as const;
    },
    endSession() {
      operator.endCalls += 1;
      if (!options.endSettles) return new Promise<never>(() => undefined);
      snapshot = snapshotFor('CLOSED', true);
      for (const listener of [...listeners]) listener();
      return Promise.resolve(snapshot);
    },
    publish(next: MotorTestControllerSnapshot) {
      snapshot = next;
      for (const listener of [...listeners]) listener();
    },
    get subscriberCount() {
      return listeners.size;
    },
  };
  return operator;
}

/** Injectable timers so the bound is observable without waiting for it. */
function controllableTimers() {
  let handler: (() => void) | undefined;
  return {
    armedMs: undefined as number | undefined,
    cleared: 0,
    setTimer(fn: () => void, ms: number) {
      this.armedMs = ms;
      handler = fn;
      return 'handle';
    },
    clearTimer() {
      this.cleared += 1;
    },
    fire() {
      handler?.();
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

describe('ending the motor test session is bounded', () => {
  it('rejects when the controller answers the stop and then never closes', async () => {
    const operator = silentOperator({phase: 'ACTIVE', endSettles: false});
    const timers = controllableTimers();

    const attempt = endMotorTestSessionSafely(
      operator as unknown as MotorTestOperatorPort,
      timers,
    );
    const settled = attempt.then(
      () => 'RESOLVED',
      () => 'REJECTED',
    );
    await flush();

    // The stop went out, and then nothing else happened.
    expect(operator.stopCalls).toEqual(['STOP_BUTTON_PRESSED']);
    expect(timers.armedMs).toBe(MOTOR_TEST_TEARDOWN_BOUND_MILLIS);

    timers.fire();
    // FAILS CLOSED. Resolving would assert a closed session that is not
    // closed; the screen's own catch shows the close-failed banner.
    expect(await settled).toBe('REJECTED');
    // And the subscription is handed back, or every abandoned teardown
    // would leave a listener on the controller.
    expect(operator.subscriberCount).toBe(0);
  });

  it('rejects when endSession() itself never settles', async () => {
    const operator = silentOperator({phase: 'IDLE', endSettles: false});
    const timers = controllableTimers();

    const attempt = endMotorTestSessionSafely(
      operator as unknown as MotorTestOperatorPort,
      timers,
    );
    const settled = attempt.then(
      () => 'RESOLVED',
      () => 'REJECTED',
    );
    await flush();
    expect(operator.endCalls).toBe(1);

    timers.fire();
    expect(await settled).toBe('REJECTED');
    expect(operator.subscriberCount).toBe(0);
  });

  it('clears its timer on the ordinary path, leaving no clock behind', async () => {
    const operator = silentOperator({phase: 'IDLE', endSettles: true});
    const timers = controllableTimers();

    await expect(
      endMotorTestSessionSafely(
        operator as unknown as MotorTestOperatorPort,
        timers,
      ),
    ).resolves.toMatchObject({phase: 'CLOSED'});
    expect(timers.cleared).toBe(1);
    expect(operator.subscriberCount).toBe(0);
  });

  it('lets a fresh attempt run after one timed out', async () => {
    const operator = silentOperator({phase: 'ACTIVE', endSettles: false});
    const first = controllableTimers();
    const attempt = endMotorTestSessionSafely(
      operator as unknown as MotorTestOperatorPort,
      first,
    );
    const settled = attempt.then(
      () => 'RESOLVED',
      () => 'REJECTED',
    );
    await flush();
    first.fire();
    expect(await settled).toBe('REJECTED');
    await flush();

    // The in-flight map must not still be holding the dead attempt, or
    // the operator's retry would be handed the rejection they just saw.
    const recovering = silentOperator({phase: 'IDLE', endSettles: true});
    await expect(
      endMotorTestSessionSafely(
        recovering as unknown as MotorTestOperatorPort,
        controllableTimers(),
      ),
    ).resolves.toMatchObject({phase: 'CLOSED'});
  });
});
