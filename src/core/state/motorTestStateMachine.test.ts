/**
 * Phase 2A / 2A.1 - tests for the pure motor-test safety state machine.
 *
 * NO HARDWARE, NO PROTOCOL, NO TRANSPORT, NO TIMERS. Every input is a
 * hand-written plain object and the module under test performs no I/O, so
 * there is nothing here to fake: fake timers are deliberately NOT used
 * because no real timer exists in this pass.
 *
 * The Phase 2A.1 corrections these tests now pin:
 *  A. a foreign-authority event is an identity no-op, and crucially does
 *     NOT consume the activation - the legitimate deadline/stop that
 *     follows it still works;
 *  B. EVERY fault reason that ends a possibly-live activation emits the
 *     physical-disconnect warning, not only a detach;
 *  C. an unacknowledged stop is REASSERTED on every repeat trigger. The
 *     old "exactly one stop effect ever" assertion was itself the defect
 *     and has been replaced, not weakened.
 *
 * The forbidden-token scan at the bottom builds every needle by string
 * concatenation on purpose, so that the literals it forbids never appear
 * in EITHER file - the scan can then be run over both and still pass
 * honestly.
 */

import {readFileSync} from 'fs';
import {join} from 'path';

import {
  createMotorTestState,
  dispositionForStopReason,
  escalateDisposition,
  faultWarningPolicy,
  motorTestTransition,
  MOTOR_TEST_STOP_UNCONFIRMED_WARNING,
  type MotorTestEffect,
  type MotorTestEvent,
  type MotorTestFaultReason,
  type MotorTestLockingStopReason,
  type MotorTestNormalStopReason,
  type MotorTestSessionAuthority,
  type MotorTestState,
  type MotorTestStateName,
  type MotorTestStopDisposition,
  type MotorTestStopTriggerReason,
  type MotorTestTransition,
} from './motorTestStateMachine';

/** Two distinct opaque authorities. Identity is the only thing that
 * matters, so bare objects are exactly right. */
const AUTHORITY: MotorTestSessionAuthority = {};
const OTHER_AUTHORITY: MotorTestSessionAuthority = {};

function event(
  kind: MotorTestEvent['kind'],
  extra: Record<string, unknown> = {},
  authority: MotorTestSessionAuthority = AUTHORITY,
): MotorTestEvent {
  return {kind, authority, ...extra} as MotorTestEvent;
}

const gatesPassed = () => event('GATES_PASSED');
const gatesFailed = () => event('GATES_FAILED');
const recheck = () => event('RECHECK_REQUESTED');
const activation = () => event('ACTIVATION_ACCEPTED');
const writeCalled = () => event('START_WRITE_CALLED');
const startAck = () => event('START_ACKNOWLEDGED');
const stopAck = () => event('STOP_ACKNOWLEDGED');
const stopTrigger = (reason: MotorTestStopTriggerReason) =>
  event('STOP_TRIGGERED', {reason});
const fault = (reason: MotorTestFaultReason) => event('FAULT_RAISED', {reason});

/** The same event, but stamped with a session this machine never knew. */
function foreign(next: MotorTestEvent): MotorTestEvent {
  return {...next, authority: OTHER_AUTHORITY} as MotorTestEvent;
}

const step = (
  state: MotorTestState,
  next: MotorTestEvent,
): MotorTestTransition => motorTestTransition(state, next);

/** Drives a sequence from a fresh machine and returns the final state
 * plus every effect emitted along the way, in order. */
function run(events: readonly MotorTestEvent[]): {
  state: MotorTestState;
  effects: MotorTestEffect[];
} {
  let state = createMotorTestState(AUTHORITY);
  const effects: MotorTestEffect[] = [];
  for (const next of events) {
    const result = step(state, next);
    state = result.state;
    effects.push(...result.effects);
  }
  return {state, effects};
}

const stateAfter = (events: readonly MotorTestEvent[]): MotorTestState =>
  run(events).state;

const kinds = (effects: readonly MotorTestEffect[]): string[] =>
  effects.map(effect => effect.kind);

const countOf = (effects: readonly MotorTestEffect[], kind: string): number =>
  kinds(effects).filter(k => k === kind).length;

function expectName<N extends MotorTestStateName>(
  state: MotorTestState,
  name: N,
): Extract<MotorTestState, {name: N}> {
  expect(state.name).toBe(name);
  if (state.name !== name) {
    throw new Error(`expected ${name}, got ${state.name}`);
  }
  return state as Extract<MotorTestState, {name: N}>;
}

/** Ready -> Starting: the start is submitted but not yet written. */
const TO_STARTING: readonly MotorTestEvent[] = [gatesPassed(), activation()];
/** Ready -> Starting -> Pulsing, i.e. a possibly-live command. */
const TO_PULSING: readonly MotorTestEvent[] = [...TO_STARTING, writeCalled()];
/** ... and then a stop was demanded but not yet confirmed. */
const TO_STOPPING: readonly MotorTestEvent[] = [
  ...TO_PULSING,
  stopTrigger('TOUCH_RELEASED'),
];

const NORMAL_REASONS: readonly MotorTestNormalStopReason[] = [
  'TOUCH_RELEASED',
  'STOP_BUTTON_PRESSED',
  'MOTOR_SELECTION_CHANGED',
  'PULSE_DEADLINE_ELAPSED',
];

const LOCKING_REASONS: readonly MotorTestLockingStopReason[] = [
  'NAVIGATION_BLURRED',
  'ANDROID_BACK',
  'ANDROID_PREDICTIVE_BACK',
  'APP_STATE_BACKGROUNDED',
  'ARMED_STATE_DETECTED',
  'ARMING_RESTRICTION_REMOVED',
  'BATTERY_CHANGED',
  'BATTERY_BECAME_UNSAFE',
];

/** All eleven, including the two that report genuine session loss. */
const ALL_FAULT_REASONS: readonly MotorTestFaultReason[] = [
  'MSP_RESPONSE_TIMEOUT',
  'TRANSPORT_WRITE_TIMEOUT',
  'WRITE_FAILED',
  'WRITE_OUTCOME_UNKNOWN',
  'DESYNCHRONIZED',
  'SESSION_CHANGED',
  'USB_DETACHED',
  'NATIVE_EXCEPTION',
  'STOP_FAILED',
  'STOP_TIMEOUT',
  'AUTHORITY_MISMATCH',
];

const OPERATIONAL_ORIGINS: readonly {
  readonly name: MotorTestStateName;
  readonly prefix: readonly MotorTestEvent[];
}[] = [
  {name: 'Starting', prefix: TO_STARTING},
  {name: 'Pulsing', prefix: TO_PULSING},
  {name: 'Stopping', prefix: TO_STOPPING},
];

const DISPOSITIONS: readonly MotorTestStopDisposition[] = [
  'Ready',
  'Locked',
  'Fault',
];

/* ================================================================== *
 * Gates and entry
 * ================================================================== */

describe('gates and entry', () => {
  it('starts in Checking and reaches Ready ONLY after the gates pass', () => {
    expect(createMotorTestState(AUTHORITY).name).toBe('Checking');
    expect(stateAfter([gatesPassed()]).name).toBe('Ready');
  });

  it('produces Locked when the gates fail, and re-checks from there', () => {
    expect(stateAfter([gatesFailed()]).name).toBe('Locked');
    expect(stateAfter([gatesFailed(), recheck()]).name).toBe('Checking');
  });

  it('cannot start from Checking or Locked - only from Ready', () => {
    const fromChecking = run([activation()]);
    expect(fromChecking.state.name).toBe('Checking');
    expect(fromChecking.effects).toEqual([]);

    const fromLocked = run([gatesFailed(), activation()]);
    expect(fromLocked.state.name).toBe('Locked');
    expect(fromLocked.effects).toEqual([]);

    const fromReady = run(TO_STARTING);
    expect(fromReady.state.name).toBe('Starting');
    expect(kinds(fromReady.effects)).toEqual(['SUBMIT_START_INTENT']);
  });

  it('Ready + STOP_TRIGGERED is inert - idle release invents no traffic', () => {
    for (const reason of [...NORMAL_REASONS, ...LOCKING_REASONS]) {
      const readyState = stateAfter([gatesPassed()]);
      const result = step(readyState, stopTrigger(reason));
      expect(result.state).toBe(readyState);
      expect(result.effects).toEqual([]);
    }
  });

  it('Locked + FAULT_RAISED faults with no live command and no warning', () => {
    for (const reason of ALL_FAULT_REASONS) {
      const lockedState = stateAfter([gatesFailed()]);
      const result = step(lockedState, fault(reason));
      const faultState = expectName(result.state, 'Fault');
      expect(faultState.faultReason).toBe(reason);
      expect(faultState.startMayHaveReachedFc).toBe(false);
      expect(result.effects).toEqual([]);
    }
  });
});

/* ================================================================== *
 * Start timeline
 * ================================================================== */

describe('start timeline', () => {
  it('release before ANY start submission produces no traffic intent', () => {
    const result = run([gatesPassed(), stopTrigger('TOUCH_RELEASED')]);
    expect(result.state.name).toBe('Ready');
    expect(result.effects).toEqual([]);
  });

  it('release AFTER submission conservatively still requires a stop', () => {
    const result = run([...TO_STARTING, stopTrigger('TOUCH_RELEASED')]);
    const stopping = expectName(result.state, 'Stopping');
    expect(kinds(result.effects)).toEqual([
      'SUBMIT_START_INTENT',
      'SUBMIT_STOP_INTENT',
    ]);
    expect(stopping.stopping.startMayHaveReachedFc).toBe(true);
  });

  it('the write call - not the ACK - enters Pulsing and arms the deadline', () => {
    const beforeWrite = run(TO_STARTING);
    expect(beforeWrite.state.name).toBe('Starting');
    expect(kinds(beforeWrite.effects)).not.toContain('ARM_PULSE_DEADLINE');

    const afterWrite = run(TO_PULSING);
    expect(afterWrite.state.name).toBe('Pulsing');
    expect(kinds(afterWrite.effects)).toEqual([
      'SUBMIT_START_INTENT',
      'ARM_PULSE_DEADLINE',
    ]);
  });

  it('the ACK neither starts, re-arms nor extends the deadline', () => {
    const acked = run([...TO_PULSING, startAck(), startAck()]);
    const pulsing = expectName(acked.state, 'Pulsing');
    expect(countOf(acked.effects, 'ARM_PULSE_DEADLINE')).toBe(1);
    expect(pulsing.startAcknowledged).toBe(true);
    expect(pulsing.pulseDeadlineArmed).toBe(true);
  });

  it('a duplicate START_WRITE_CALLED in Pulsing is an identity no-op', () => {
    const pulsing = stateAfter(TO_PULSING);
    const again = step(pulsing, writeCalled());
    expect(again.state).toBe(pulsing);
    expect(again.effects).toEqual([]);
    // A second arming would silently extend the maximum pulse duration.
    expect(kinds(again.effects)).not.toContain('ARM_PULSE_DEADLINE');
  });

  it('release after the write call but before the ACK enters Stopping', () => {
    const stopping = expectName(stateAfter(TO_STOPPING), 'Stopping');
    expect(stopping.stopping.startAcknowledged).toBe(false);
    expect(stopping.stopping.startMayHaveReachedFc).toBe(true);
  });
});

/* ================================================================== *
 * Correction A - authority
 * ================================================================== */

describe('correction A - a foreign authority is ignored, never fatal', () => {
  const FOREIGN_EVENTS: readonly MotorTestEvent[] = [
    gatesPassed(),
    gatesFailed(),
    recheck(),
    activation(),
    writeCalled(),
    startAck(),
    stopTrigger('TOUCH_RELEASED'),
    stopTrigger('BATTERY_BECAME_UNSAFE'),
    stopAck(),
    fault('DESYNCHRONIZED'),
    fault('USB_DETACHED'),
    fault('SESSION_CHANGED'),
  ];

  const ORIGINS: readonly {
    readonly name: MotorTestStateName;
    readonly prefix: readonly MotorTestEvent[];
  }[] = [
    {name: 'Checking', prefix: []},
    {name: 'Locked', prefix: [gatesFailed()]},
    {name: 'Ready', prefix: [gatesPassed()]},
    ...OPERATIONAL_ORIGINS,
  ];

  it.each(ORIGINS.map(o => [o.name, o.prefix] as const))(
    'from %s every foreign event is an identity no-op with zero effects',
    (name, prefix) => {
      const before = stateAfter(prefix);
      expect(before.name).toBe(name);
      for (const next of FOREIGN_EVENTS) {
        const result = step(before, foreign(next));
        // Identity, not merely equality: nothing was rebuilt.
        expect(result.state).toBe(before);
        expect(result.effects).toEqual([]);
        expect(result.state.authority).toBe(AUTHORITY);
        expect(result.state.name).not.toBe('Fault');
      }
    },
  );

  it('a foreign event while Pulsing does NOT consume the deadline', () => {
    let state = stateAfter(TO_PULSING);
    state = step(state, foreign(fault('DESYNCHRONIZED'))).state;
    expect(state.name).toBe('Pulsing');

    const deadline = step(state, stopTrigger('PULSE_DEADLINE_ELAPSED'));
    expect(deadline.state.name).toBe('Stopping');
    expect(kinds(deadline.effects)).toEqual(['SUBMIT_STOP_INTENT']);
    expect(expectName(deadline.state, 'Stopping').stopping.requiredDisposition)
      .toBe('Ready');
  });

  it('a foreign event while Pulsing does NOT consume the stop button', () => {
    let state = stateAfter(TO_PULSING);
    state = step(state, foreign(stopAck())).state;
    expect(state.name).toBe('Pulsing');

    const stopped = step(state, stopTrigger('STOP_BUTTON_PRESSED'));
    expect(stopped.state.name).toBe('Stopping');
    expect(kinds(stopped.effects)).toEqual(['SUBMIT_STOP_INTENT']);
  });

  it('a foreign event while Stopping does NOT block the legitimate ACK', () => {
    let state = stateAfter(TO_STOPPING);
    state = step(state, foreign(fault('USB_DETACHED'))).state;
    expect(state.name).toBe('Stopping');

    const resolved = step(state, stopAck());
    expect(resolved.state.name).toBe('Ready');
    expect(resolved.effects).toEqual([]);
  });

  it('an old-authority event cannot affect a freshly created machine', () => {
    const fresh = createMotorTestState(OTHER_AUTHORITY);
    const stale = step(fresh, gatesPassed()); // stamped with AUTHORITY
    expect(stale.state).toBe(fresh);
    expect(stale.effects).toEqual([]);
    expect(stale.state.name).toBe('Checking');
    expect(stale.state.authority).toBe(OTHER_AUTHORITY);
  });

  it.each(['SESSION_CHANGED', 'AUTHORITY_MISMATCH'] as const)(
    'a MATCHING-authority %s is still a real terminal fault that warns',
    reason => {
      const result = step(stateAfter(TO_PULSING), fault(reason));
      const faultState = expectName(result.state, 'Fault');
      expect(faultState.faultReason).toBe(reason);
      expect(faultState.authority).toBe(AUTHORITY);
      expect(faultState.startMayHaveReachedFc).toBe(true);
      expect(kinds(result.effects)).toEqual(['SHOW_STOP_UNCONFIRMED_WARNING']);
      // Terminal: the legitimate stop that follows is now inert.
      const after = step(result.state, stopTrigger('TOUCH_RELEASED'));
      expect(after.state).toBe(result.state);
      expect(after.effects).toEqual([]);
    },
  );
});

/* ================================================================== *
 * Correction B - operational faults always warn
 * ================================================================== */

describe('correction B - every operational fault warns', () => {
  const CASES = OPERATIONAL_ORIGINS.flatMap(origin =>
    ALL_FAULT_REASONS.map(
      reason => [origin.name, reason, origin.prefix] as const,
    ),
  );

  it.each(CASES)('%s + %s warns and emits no stop intent', (
    _name,
    reason,
    prefix,
  ) => {
    const before = stateAfter(prefix);
    const result = step(before, fault(reason));
    const faultState = expectName(result.state, 'Fault');

    expect(faultState.faultReason).toBe(reason);
    expect(faultState.authority).toBe(AUTHORITY);
    expect(faultState.startMayHaveReachedFc).toBe(true);

    expect(result.effects).toHaveLength(1);
    const warning = result.effects[0];
    expect(warning.kind).toBe('SHOW_STOP_UNCONFIRMED_WARNING');
    if (warning.kind !== 'SHOW_STOP_UNCONFIRMED_WARNING') {
      throw new Error('unreachable');
    }
    expect(warning.message).toBe(MOTOR_TEST_STOP_UNCONFIRMED_WARNING);
    expect(warning.message).toBe(
      'Unable to confirm stop — disconnect LiPo immediately',
    );
    expect(Object.isFrozen(warning)).toBe(true);
    // A fault never asks for a stop: the transport is not trusted.
    expect(kinds(result.effects)).not.toContain('SUBMIT_STOP_INTENT');
  });

  it.each(['STOP_FAILED', 'STOP_TIMEOUT'] as const)(
    'a %s while Stopping warns rather than ending silently',
    reason => {
      const result = step(stateAfter(TO_STOPPING), fault(reason));
      const faultState = expectName(result.state, 'Fault');
      expect(faultState.faultReason).toBe(reason);
      expect(faultState.startMayHaveReachedFc).toBe(true);
      expect(kinds(result.effects)).toEqual(['SHOW_STOP_UNCONFIRMED_WARNING']);
    },
  );

  it.each(ALL_FAULT_REASONS)('every reason has an explicit policy: %s', r => {
    expect(faultWarningPolicy(r)).toBe('WARN_IF_COMMAND_MAY_BE_LIVE');
  });

  const IDLE_ORIGINS: readonly {
    readonly name: MotorTestStateName;
    readonly prefix: readonly MotorTestEvent[];
  }[] = [
    {name: 'Checking', prefix: []},
    {name: 'Locked', prefix: [gatesFailed()]},
    {name: 'Ready', prefix: [gatesPassed()]},
  ];

  it.each(
    IDLE_ORIGINS.flatMap(o =>
      ALL_FAULT_REASONS.map(reason => [o.name, reason, o.prefix] as const),
    ),
  )('%s + %s faults WITHOUT a false warning', (_name, reason, prefix) => {
    const result = step(stateAfter(prefix), fault(reason));
    const faultState = expectName(result.state, 'Fault');
    expect(faultState.startMayHaveReachedFc).toBe(false);
    expect(result.effects).toEqual([]);
  });

  it('Fault is terminal and preserves reason, authority and liveness', () => {
    const faulted = step(stateAfter(TO_PULSING), fault('DESYNCHRONIZED')).state;
    const before = expectName(faulted, 'Fault');

    for (const next of [
      gatesPassed(),
      gatesFailed(),
      recheck(),
      activation(),
      writeCalled(),
      startAck(),
      stopTrigger('TOUCH_RELEASED'),
      stopAck(),
      fault('USB_DETACHED'),
      foreign(stopTrigger('TOUCH_RELEASED')),
    ]) {
      const after = step(before, next);
      expect(after.state).toBe(before);
      expect(after.effects).toEqual([]);
    }
    expect(before.faultReason).toBe('DESYNCHRONIZED');
    expect(before.authority).toBe(AUTHORITY);
    expect(before.startMayHaveReachedFc).toBe(true);
  });

  it('recovery is a NEW machine under a NEW authority, never a transition', () => {
    const fresh = createMotorTestState(OTHER_AUTHORITY);
    expect(fresh.name).toBe('Checking');
    expect(fresh.authority).toBe(OTHER_AUTHORITY);
  });
});

/* ================================================================== *
 * Correction C - stop reassertion
 * ================================================================== */

describe('correction C - an unacknowledged stop is reasserted', () => {
  it('the first stop from Starting emits the stop intent', () => {
    const result = step(stateAfter(TO_STARTING), stopTrigger('TOUCH_RELEASED'));
    expect(result.state.name).toBe('Stopping');
    expect(kinds(result.effects)).toEqual(['SUBMIT_STOP_INTENT']);
  });

  it('the first stop from Pulsing emits the stop intent', () => {
    const result = step(stateAfter(TO_PULSING), stopTrigger('TOUCH_RELEASED'));
    expect(result.state.name).toBe('Stopping');
    expect(kinds(result.effects)).toEqual(['SUBMIT_STOP_INTENT']);
  });

  it.each(NORMAL_REASONS)('a repeated normal %s re-emits the stop', reason => {
    const result = step(stateAfter(TO_STOPPING), stopTrigger(reason));
    expect(result.state.name).toBe('Stopping');
    expect(kinds(result.effects)).toEqual(['SUBMIT_STOP_INTENT']);
  });

  it.each(LOCKING_REASONS)('a repeated locking %s re-emits the stop', reason => {
    const result = step(stateAfter(TO_STOPPING), stopTrigger(reason));
    expect(result.state.name).toBe('Stopping');
    expect(kinds(result.effects)).toEqual(['SUBMIT_STOP_INTENT']);
  });

  it('N triggers produce N stop descriptors - state still coalesces', () => {
    const result = run([
      ...TO_PULSING,
      stopTrigger('TOUCH_RELEASED'),
      stopTrigger('STOP_BUTTON_PRESSED'),
      stopTrigger('NAVIGATION_BLURRED'),
      stopTrigger('ANDROID_BACK'),
      stopTrigger('MOTOR_SELECTION_CHANGED'),
    ]);
    // Five triggers, five reassertions: a lost stop must be re-asked.
    expect(countOf(result.effects, 'SUBMIT_STOP_INTENT')).toBe(5);
    // One state, one disposition - THAT is what coalesces.
    const stopping = expectName(result.state, 'Stopping');
    expect(stopping.stopping.requiredDisposition).toBe('Locked');
    expect(stopping.stopping.stopReason).toBe('TOUCH_RELEASED');
  });

  it('a late START_WRITE_CALLED while Stopping reasserts and never re-enters Pulsing', () => {
    const before = stateAfter([...TO_STARTING, stopTrigger('NAVIGATION_BLURRED')]);
    const result = step(before, writeCalled());
    const stopping = expectName(result.state, 'Stopping');
    expect(stopping.stopping.startMayHaveReachedFc).toBe(true);
    expect(stopping.stopping.requiredDisposition).toBe('Locked');
    expect(kinds(result.effects)).toEqual(['SUBMIT_STOP_INTENT']);
    expect(kinds(result.effects)).not.toContain('ARM_PULSE_DEADLINE');
    expect(result.state.name).not.toBe('Pulsing');
  });

  it('a late START_ACKNOWLEDGED while Stopping reasserts without changing disposition', () => {
    const before = stateAfter([
      ...TO_PULSING,
      stopTrigger('BATTERY_BECAME_UNSAFE'),
    ]);
    const result = step(before, startAck());
    const stopping = expectName(result.state, 'Stopping');
    expect(stopping.stopping.startAcknowledged).toBe(true);
    expect(stopping.stopping.requiredDisposition).toBe('Locked');
    expect(kinds(result.effects)).toEqual(['SUBMIT_STOP_INTENT']);
    expect(result.state.name).not.toBe('Pulsing');
  });

  it('a stop ACK after a reasserted stop resolves to the stored disposition', () => {
    const resolved = run([
      ...TO_STOPPING,
      stopTrigger('TOUCH_RELEASED'),
      startAck(),
      stopTrigger('TOUCH_RELEASED'),
      stopAck(),
    ]);
    expect(resolved.state.name).toBe('Ready');
  });

  it('a duplicate stop ACK after the final disposition is inert', () => {
    const settled = stateAfter([...TO_STOPPING, stopAck()]);
    expect(settled.name).toBe('Ready');
    const again = step(settled, stopAck());
    expect(again.state).toBe(settled);
    expect(again.effects).toEqual([]);

    const lockedSettled = stateAfter([
      ...TO_PULSING,
      stopTrigger('ANDROID_BACK'),
      stopAck(),
    ]);
    expect(lockedSettled.name).toBe('Locked');
    const lockedAgain = step(lockedSettled, stopAck());
    expect(lockedAgain.state).toBe(lockedSettled);
    expect(lockedAgain.effects).toEqual([]);
  });

  it('the pulse deadline is never armed a second time by any stop path', () => {
    const result = run([
      ...TO_STOPPING,
      writeCalled(),
      startAck(),
      stopTrigger('ANDROID_BACK'),
      stopAck(),
    ]);
    expect(countOf(result.effects, 'ARM_PULSE_DEADLINE')).toBe(1);
  });
});

/* ================================================================== *
 * Dispositions
 * ================================================================== */

describe('stop dispositions and escalation', () => {
  it.each(NORMAL_REASONS)('%s + confirmed stop -> Ready', reason => {
    expect(stateAfter([...TO_PULSING, stopTrigger(reason), stopAck()]).name).toBe(
      'Ready',
    );
    expect(dispositionForStopReason(reason)).toBe('Ready');
  });

  it.each(LOCKING_REASONS)('%s + confirmed stop -> Locked', reason => {
    expect(stateAfter([...TO_PULSING, stopTrigger(reason), stopAck()]).name).toBe(
      'Locked',
    );
    expect(dispositionForStopReason(reason)).toBe('Locked');
  });

  it('the pulse deadline is a designed cutoff, NOT automatically a fault', () => {
    const stopping = expectName(
      stateAfter([...TO_PULSING, stopTrigger('PULSE_DEADLINE_ELAPSED')]),
      'Stopping',
    );
    expect(stopping.stopping.requiredDisposition).toBe('Ready');
    const resolved = stateAfter([
      ...TO_PULSING,
      stopTrigger('PULSE_DEADLINE_ELAPSED'),
      stopAck(),
    ]);
    expect(resolved.name).toBe('Ready');
    expect(resolved.name).not.toBe('Fault');
  });

  it('normal then locking escalates to Locked', () => {
    const result = stateAfter([
      ...TO_PULSING,
      stopTrigger('TOUCH_RELEASED'),
      stopTrigger('BATTERY_BECAME_UNSAFE'),
    ]);
    expect(expectName(result, 'Stopping').stopping.requiredDisposition).toBe(
      'Locked',
    );
  });

  it('locking then normal NEVER downgrades', () => {
    const result = stateAfter([
      ...TO_PULSING,
      stopTrigger('BATTERY_BECAME_UNSAFE'),
      stopTrigger('TOUCH_RELEASED'),
      stopTrigger('PULSE_DEADLINE_ELAPSED'),
    ]);
    expect(expectName(result, 'Stopping').stopping.requiredDisposition).toBe(
      'Locked',
    );
    expect(
      stateAfter([
        ...TO_PULSING,
        stopTrigger('BATTERY_BECAME_UNSAFE'),
        stopTrigger('TOUCH_RELEASED'),
        stopAck(),
      ]).name,
    ).toBe('Locked');
  });

  it.each([
    ['TOUCH_RELEASED', 'PULSE_DEADLINE_ELAPSED'],
    ['PULSE_DEADLINE_ELAPSED', 'TOUCH_RELEASED'],
  ] as const)('order %s then %s stays Ready', (first, second) => {
    const result = stateAfter([
      ...TO_PULSING,
      stopTrigger(first),
      stopTrigger(second),
    ]);
    expect(expectName(result, 'Stopping').stopping.requiredDisposition).toBe(
      'Ready',
    );
    expect(
      stateAfter([
        ...TO_PULSING,
        stopTrigger(first),
        stopTrigger(second),
        stopAck(),
      ]).name,
    ).toBe('Ready');
  });

  it.each([
    ['STOP_BUTTON_PRESSED', 'NAVIGATION_BLURRED'],
    ['NAVIGATION_BLURRED', 'STOP_BUTTON_PRESSED'],
  ] as const)('order %s then %s ends Locked either way', (first, second) => {
    const result = stateAfter([
      ...TO_PULSING,
      stopTrigger(first),
      stopTrigger(second),
    ]);
    expect(expectName(result, 'Stopping').stopping.requiredDisposition).toBe(
      'Locked',
    );
    expect(
      stateAfter([
        ...TO_PULSING,
        stopTrigger(first),
        stopTrigger(second),
        stopAck(),
      ]).name,
    ).toBe('Locked');
  });

  it('a fault after a locking stop escalates to terminal Fault', () => {
    const result = run([
      ...TO_PULSING,
      stopTrigger('NAVIGATION_BLURRED'),
      fault('DESYNCHRONIZED'),
    ]);
    expect(result.state.name).toBe('Fault');
    expect(kinds(result.effects)).toContain('SHOW_STOP_UNCONFIRMED_WARNING');
  });

  it('covers all nine disposition-lattice combinations, monotonically', () => {
    const rank = (d: MotorTestStopDisposition) => DISPOSITIONS.indexOf(d);
    let combinations = 0;
    for (const current of DISPOSITIONS) {
      for (const next of DISPOSITIONS) {
        const result = escalateDisposition(current, next);
        expect(rank(result)).toBe(Math.max(rank(current), rank(next)));
        expect(rank(result)).toBeGreaterThanOrEqual(rank(current));
        combinations += 1;
      }
    }
    expect(combinations).toBe(9);
    expect(escalateDisposition('Fault', 'Ready')).toBe('Fault');
    expect(escalateDisposition('Locked', 'Ready')).toBe('Locked');
  });
});

/* ================================================================== *
 * Documented non-transitions
 * ================================================================== */

describe('documented non-transitions', () => {
  it.each(OPERATIONAL_ORIGINS.map(o => [o.name, o.prefix] as const))(
    'GATES_FAILED during %s is intentionally ignored',
    (name, prefix) => {
      // Contract: a gate that goes bad during a live activation is a
      // SAFETY STOP and must arrive as the typed stop reason naming the
      // gate. Locking here instead would end the activation without ever
      // asking for a stop.
      const before = stateAfter(prefix);
      expect(before.name).toBe(name);
      const result = step(before, gatesFailed());
      expect(result.state).toBe(before);
      expect(result.effects).toEqual([]);
    },
  );

  it('the typed stop reasons ARE the supported way to report gate loss', () => {
    for (const reason of [
      'ARMED_STATE_DETECTED',
      'ARMING_RESTRICTION_REMOVED',
      'BATTERY_BECAME_UNSAFE',
      'BATTERY_CHANGED',
    ] as const) {
      const result = step(stateAfter(TO_PULSING), stopTrigger(reason));
      expect(result.state.name).toBe('Stopping');
      expect(kinds(result.effects)).toEqual(['SUBMIT_STOP_INTENT']);
      expect(dispositionForStopReason(reason)).toBe('Locked');
    }
  });
});

/* ================================================================== *
 * Immutability
 * ================================================================== */

describe('deep immutability', () => {
  const ALL_EFFECT_SAMPLES: readonly MotorTestEffect[] = [
    ...step(stateAfter([gatesPassed()]), activation()).effects,
    ...step(stateAfter(TO_STARTING), writeCalled()).effects,
    ...step(stateAfter(TO_PULSING), stopTrigger('TOUCH_RELEASED')).effects,
    ...step(stateAfter(TO_PULSING), fault('USB_DETACHED')).effects,
  ];

  it('produces one sample of every effect kind', () => {
    expect(kinds(ALL_EFFECT_SAMPLES).sort()).toEqual(
      [
        'ARM_PULSE_DEADLINE',
        'SHOW_STOP_UNCONFIRMED_WARNING',
        'SUBMIT_START_INTENT',
        'SUBMIT_STOP_INTENT',
      ].sort(),
    );
  });

  it.each(ALL_EFFECT_SAMPLES.map(e => [e.kind, e] as const))(
    '%s is frozen and rejects a real mutation',
    (_kind, effect) => {
      expect(Object.isFrozen(effect)).toBe(true);
      const before = JSON.stringify(effect);
      // Reflect.set returns false on a frozen target instead of throwing,
      // and needs no cast - the OBSERVED value is what matters.
      expect(Reflect.set(effect, 'kind', 'TAMPERED')).toBe(false);
      expect(Reflect.set(effect, 'message', 'tampered')).toBe(false);
      expect(Reflect.deleteProperty(effect, 'kind')).toBe(false);
      expect(JSON.stringify(effect)).toBe(before);
    },
  );

  it('freezes the transition, the state, the metadata and the effects array', () => {
    const result = step(stateAfter(TO_PULSING), stopTrigger('TOUCH_RELEASED'));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.state)).toBe(true);
    expect(Object.isFrozen(result.effects)).toBe(true);
    const stopping = expectName(result.state, 'Stopping');
    expect(Object.isFrozen(stopping.stopping)).toBe(true);
    expect(Reflect.set(result.effects, 0, undefined)).toBe(false);
    expect(Reflect.set(stopping.stopping, 'requiredDisposition', 'Ready')).toBe(
      false,
    );
    expect(stopping.stopping.requiredDisposition).toBe('Ready');
  });

  it('freezes the shared empty-effects array too', () => {
    const inert = step(stateAfter([gatesPassed()]), stopTrigger('ANDROID_BACK'));
    expect(Object.isFrozen(inert.effects)).toBe(true);
    expect(inert.effects).toHaveLength(0);
  });

  it('is a pure function - the same input always yields the same result', () => {
    const state = stateAfter(TO_PULSING);
    const first = step(state, stopTrigger('TOUCH_RELEASED'));
    const second = step(state, stopTrigger('TOUCH_RELEASED'));
    expect(second.state).toEqual(first.state);
    expect(second.effects).toEqual(first.effects);
    expect(state.name).toBe('Pulsing');
  });
});

/* ================================================================== *
 * Structural containment
 * ================================================================== */

describe('structural containment', () => {
  const source = readFileSync(
    join(__dirname, 'motorTestStateMachine.ts'),
    'utf8',
  );
  const testSource = readFileSync(
    join(__dirname, 'motorTestStateMachine.test.ts'),
    'utf8',
  );

  it('the state machine has NO imports at all', () => {
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/^\s*export\s+.*\bfrom\b/m);
  });

  /** Built by concatenation so the literals appear in neither file. */
  const FORBIDDEN: readonly string[] = [
    'MSP' + '_SET_' + 'MOTOR',
    '2' + '14',
    'Msp' + 'Client',
    'RNMsp' + 'Transport',
    'write' + 'Bytes',
    'requestWith' + 'MotorTestLease',
    'Uint8' + 'Array',
    'set' + 'Timeout',
    'set' + 'Interval',
  ];

  it.each(FORBIDDEN)('neither file contains %s', token => {
    expect(source).not.toContain(token);
    expect(testSource).not.toContain(token);
  });

  it('references no protocol, native, React or UI symbol, and no async work', () => {
    // Deliberately checks for REFERENCES, not for words. Reason names
    // such as TRANSPORT_WRITE_TIMEOUT and NAVIGATION_BLURRED are part of
    // this module's own vocabulary and prove nothing about coupling -
    // the "no imports at all" assertion above is what structurally
    // guarantees that none of these layers can be reached.
    for (const token of [
      'react',
      'Navigation.',
      'AppState',
      'Promise',
      'async ',
      'await ',
      'Date',
      'Math.random',
    ]) {
      expect(source).not.toContain(token);
    }
    // No construction of anything: the module allocates only frozen
    // object and array literals. (A bare "new " substring would also
    // match ordinary prose such as "a new session", so this checks for a
    // real constructor call instead.)
    expect(source).not.toMatch(/\bnew\s+[A-Z]\w*\s*\(/);
  });

  it('declares no numeric motor value or pulse magnitude', () => {
    // Any bare integer literal of three digits or more would be the
    // shape a motor value takes. There is deliberately none.
    expect(source).not.toMatch(/\b\d{3,}\b/);
  });

  it('carries no stopIntentIssued field - a stop is reasserted, not remembered', () => {
    // The Phase 2A field was write-only and its name implied a
    // suppression rule that must not exist.
    expect(source).not.toMatch(/readonly\s+stopIntentIssued/);
  });
});
