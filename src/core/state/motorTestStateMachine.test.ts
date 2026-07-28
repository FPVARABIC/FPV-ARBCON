/**
 * Phase 2A - tests for the pure motor-test safety state machine.
 *
 * NO HARDWARE, NO PROTOCOL, NO TRANSPORT, NO TIMERS. Every input is a
 * hand-written plain object and the module under test performs no I/O, so
 * there is nothing here to fake: fake timers are deliberately NOT used
 * because no real timer exists in this pass.
 *
 * The forbidden-token scan at the bottom builds every needle by string
 * concatenation on purpose, so that the literals it forbids never appear
 * in EITHER new file - the scan can then be run over both of them and
 * still pass honestly.
 */

import {readFileSync} from 'fs';
import {join} from 'path';

import {
  createMotorTestState,
  dispositionForStopReason,
  escalateDisposition,
  motorTestTransition,
  MOTOR_TEST_STOP_UNCONFIRMED_WARNING,
  type MotorTestEffect,
  type MotorTestEvent,
  type MotorTestFaultReason,
  type MotorTestLockingStopReason,
  type MotorTestNormalStopReason,
  type MotorTestSessionAuthority,
  type MotorTestState,
  type MotorTestStopDisposition,
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
const activation = () => event('ACTIVATION_ACCEPTED');
const writeCalled = () => event('START_WRITE_CALLED');
const startAck = () => event('START_ACKNOWLEDGED');
const stopAck = () => event('STOP_ACKNOWLEDGED');
const stopTrigger = (reason: string) => event('STOP_TRIGGERED', {reason});
const fault = (reason: MotorTestFaultReason) => event('FAULT_RAISED', {reason});

/** Drives a sequence and returns the final state plus every effect
 * emitted along the way, in order. */
function run(events: readonly MotorTestEvent[]): {
  state: MotorTestState;
  effects: MotorTestEffect[];
} {
  let state = createMotorTestState(AUTHORITY);
  const effects: MotorTestEffect[] = [];
  for (const next of events) {
    const transition = motorTestTransition(state, next);
    state = transition.state;
    effects.push(...transition.effects);
  }
  return {state, effects};
}

const kinds = (effects: readonly MotorTestEffect[]): string[] =>
  effects.map(effect => effect.kind);

/** Ready -> Starting -> Pulsing, i.e. a live pulse. */
const TO_PULSING: readonly MotorTestEvent[] = [
  gatesPassed(),
  activation(),
  writeCalled(),
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

const TERMINAL_FAULT_REASONS: readonly MotorTestFaultReason[] = [
  'MSP_RESPONSE_TIMEOUT',
  'TRANSPORT_WRITE_TIMEOUT',
  'WRITE_FAILED',
  'WRITE_OUTCOME_UNKNOWN',
  'DESYNCHRONIZED',
  'SESSION_CHANGED',
  'NATIVE_EXCEPTION',
  'STOP_FAILED',
  'STOP_TIMEOUT',
];

describe('gates and entry (1, 2, 3)', () => {
  it('starts in Checking and reaches Ready ONLY after the gates pass', () => {
    expect(createMotorTestState(AUTHORITY).name).toBe('Checking');
    expect(run([gatesPassed()]).state.name).toBe('Ready');
  });

  it('produces Locked when the gates fail, and re-checks from there', () => {
    expect(run([gatesFailed()]).state.name).toBe('Locked');
    expect(run([gatesFailed(), event('RECHECK_REQUESTED')]).state.name).toBe(
      'Checking',
    );
  });

  it('cannot start from Checking or Locked - only from Ready', () => {
    const fromChecking = run([activation()]);
    expect(fromChecking.state.name).toBe('Checking');
    expect(fromChecking.effects).toEqual([]);

    const fromLocked = run([gatesFailed(), activation()]);
    expect(fromLocked.state.name).toBe('Locked');
    expect(fromLocked.effects).toEqual([]);

    const fromReady = run([gatesPassed(), activation()]);
    expect(fromReady.state.name).toBe('Starting');
    expect(kinds(fromReady.effects)).toEqual(['SUBMIT_START_INTENT']);
  });
});

describe('start timeline (4, 5, 6, 7, 8, 9)', () => {
  it('release before ANY start submission produces no traffic intent', () => {
    const result = run([gatesPassed(), stopTrigger('TOUCH_RELEASED')]);
    expect(result.state.name).toBe('Ready');
    expect(result.effects).toEqual([]);
  });

  it('release AFTER submission conservatively still requires a stop', () => {
    // The submitted start cannot be recalled, so the machine must not
    // assume it was dropped.
    const result = run([
      gatesPassed(),
      activation(),
      stopTrigger('TOUCH_RELEASED'),
    ]);
    expect(result.state.name).toBe('Stopping');
    expect(kinds(result.effects)).toEqual([
      'SUBMIT_START_INTENT',
      'SUBMIT_STOP_INTENT',
    ]);
    if (result.state.name !== 'Stopping') {
      throw new Error('unreachable');
    }
    expect(result.state.stopping.startMayHaveReachedFc).toBe(true);
    expect(result.state.stopping.stopIntentIssued).toBe(true);
  });

  it('the write call - not the ACK - enters Pulsing and arms the deadline', () => {
    const beforeWrite = run([gatesPassed(), activation()]);
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
    expect(acked.state.name).toBe('Pulsing');
    // Exactly ONE arming, from the write call, no matter how many ACKs.
    expect(kinds(acked.effects).filter(k => k === 'ARM_PULSE_DEADLINE')).toEqual(
      ['ARM_PULSE_DEADLINE'],
    );
    if (acked.state.name !== 'Pulsing') {
      throw new Error('unreachable');
    }
    expect(acked.state.startAcknowledged).toBe(true);
    expect(acked.state.pulseDeadlineArmed).toBe(true);
  });

  it('release after the write call but before the ACK enters Stopping', () => {
    const result = run([...TO_PULSING, stopTrigger('TOUCH_RELEASED')]);
    expect(result.state.name).toBe('Stopping');
    if (result.state.name !== 'Stopping') {
      throw new Error('unreachable');
    }
    expect(result.state.stopping.startAcknowledged).toBe(false);
    expect(result.state.stopping.startMayHaveReachedFc).toBe(true);
  });

  it('a late start ACK during Stopping never returns to Pulsing', () => {
    const result = run([
      ...TO_PULSING,
      stopTrigger('TOUCH_RELEASED'),
      startAck(),
      writeCalled(),
    ]);
    expect(result.state.name).toBe('Stopping');
    if (result.state.name !== 'Stopping') {
      throw new Error('unreachable');
    }
    expect(result.state.stopping.startAcknowledged).toBe(true);
    expect(result.state.stopping.requiredDisposition).toBe('Ready');
    // No SECOND stop intent was produced by either late event.
    expect(kinds(result.effects).filter(k => k === 'SUBMIT_STOP_INTENT')).toEqual(
      ['SUBMIT_STOP_INTENT'],
    );
  });
});

describe('normal stop reasons resolve to Ready (10, 11)', () => {
  it.each(NORMAL_REASONS)('%s + confirmed stop -> Ready', reason => {
    const result = run([...TO_PULSING, stopTrigger(reason), stopAck()]);
    expect(result.state.name).toBe('Ready');
  });

  it('the pulse deadline is a designed cutoff, NOT automatically a fault', () => {
    const stopping = run([...TO_PULSING, stopTrigger('PULSE_DEADLINE_ELAPSED')]);
    expect(stopping.state.name).toBe('Stopping');
    if (stopping.state.name !== 'Stopping') {
      throw new Error('unreachable');
    }
    expect(stopping.state.stopping.requiredDisposition).toBe('Ready');
    expect(dispositionForStopReason('PULSE_DEADLINE_ELAPSED')).toBe('Ready');

    const resolved = run([
      ...TO_PULSING,
      stopTrigger('PULSE_DEADLINE_ELAPSED'),
      stopAck(),
    ]);
    expect(resolved.state.name).toBe('Ready');
    expect(resolved.state.name).not.toBe('Fault');
  });
});

describe('locking stop reasons resolve to Locked (12)', () => {
  it.each(LOCKING_REASONS)('%s + confirmed stop -> Locked', reason => {
    const result = run([...TO_PULSING, stopTrigger(reason), stopAck()]);
    expect(result.state.name).toBe('Locked');
  });

  it.each(LOCKING_REASONS)('%s asks for the Locked disposition', reason => {
    expect(dispositionForStopReason(reason)).toBe('Locked');
  });
});

describe('terminal faults (13, 18, 19)', () => {
  it.each(TERMINAL_FAULT_REASONS)('%s during Pulsing is terminal', reason => {
    const result = run([...TO_PULSING, fault(reason)]);
    expect(result.state.name).toBe('Fault');
    if (result.state.name !== 'Fault') {
      throw new Error('unreachable');
    }
    expect(result.state.faultReason).toBe(reason);
    // A terminal fault emits no transport intent of any kind.
    expect(kinds(result.effects)).not.toContain('SUBMIT_STOP_INTENT');
  });

  it('a stop failure while Stopping produces Fault, never Ready', () => {
    const result = run([
      ...TO_PULSING,
      stopTrigger('TOUCH_RELEASED'),
      fault('STOP_FAILED'),
    ]);
    expect(result.state.name).toBe('Fault');

    const timedOut = run([
      ...TO_PULSING,
      stopTrigger('TOUCH_RELEASED'),
      fault('STOP_TIMEOUT'),
    ]);
    expect(timedOut.state.name).toBe('Fault');
  });

  it('Fault is terminal under the same authority - every event is inert', () => {
    const faulted = run([...TO_PULSING, fault('DESYNCHRONIZED')]);
    expect(faulted.state.name).toBe('Fault');

    for (const next of [
      gatesPassed(),
      event('RECHECK_REQUESTED'),
      activation(),
      writeCalled(),
      startAck(),
      stopTrigger('TOUCH_RELEASED'),
      stopAck(),
    ]) {
      const after = motorTestTransition(faulted.state, next);
      expect(after.state).toBe(faulted.state);
      expect(after.effects).toEqual([]);
    }
  });

  it('recovery is a NEW machine under a NEW authority, never a transition', () => {
    const fresh = createMotorTestState(OTHER_AUTHORITY);
    expect(fresh.name).toBe('Checking');
    expect(fresh.authority).toBe(OTHER_AUTHORITY);
  });
});

describe('USB detach (14)', () => {
  it('emits the warning intent and ZERO transport intent while a motor may be commanded', () => {
    const result = run([...TO_PULSING, fault('USB_DETACHED')]);
    expect(result.state.name).toBe('Fault');
    expect(kinds(result.effects)).toEqual([
      'SUBMIT_START_INTENT',
      'ARM_PULSE_DEADLINE',
      'SHOW_STOP_UNCONFIRMED_WARNING',
    ]);
    expect(kinds(result.effects)).not.toContain('SUBMIT_STOP_INTENT');

    const warning = result.effects.find(
      e => e.kind === 'SHOW_STOP_UNCONFIRMED_WARNING',
    );
    expect(warning).toBeDefined();
    if (warning === undefined || warning.kind !== 'SHOW_STOP_UNCONFIRMED_WARNING') {
      throw new Error('unreachable');
    }
    expect(warning.message).toBe(MOTOR_TEST_STOP_UNCONFIRMED_WARNING);
    expect(warning.message).toBe(
      'Unable to confirm stop — disconnect LiPo immediately',
    );
  });

  it('warns from Starting and from Stopping too - the start is uncancellable', () => {
    const fromStarting = run([gatesPassed(), activation(), fault('USB_DETACHED')]);
    expect(kinds(fromStarting.effects)).toContain('SHOW_STOP_UNCONFIRMED_WARNING');

    const fromStopping = run([
      ...TO_PULSING,
      stopTrigger('TOUCH_RELEASED'),
      fault('USB_DETACHED'),
    ]);
    expect(kinds(fromStopping.effects)).toContain('SHOW_STOP_UNCONFIRMED_WARNING');
  });

  it('does NOT warn when nothing was ever activated', () => {
    const fromReady = run([gatesPassed(), fault('USB_DETACHED')]);
    expect(fromReady.state.name).toBe('Fault');
    expect(kinds(fromReady.effects)).toEqual([]);
  });
});

describe('stale authority (15)', () => {
  it.each([
    ['ACTIVATION_ACCEPTED', {}],
    ['START_WRITE_CALLED', {}],
    ['START_ACKNOWLEDGED', {}],
    ['STOP_TRIGGERED', {reason: 'TOUCH_RELEASED'}],
    ['STOP_ACKNOWLEDGED', {}],
    ['GATES_PASSED', {}],
  ])('a %s from a replaced authority emits NO traffic intent', (kind, extra) => {
    let state = createMotorTestState(AUTHORITY);
    for (const next of TO_PULSING) {
      state = motorTestTransition(state, next).state;
    }
    expect(state.name).toBe('Pulsing');

    const stale = event(
      kind as MotorTestEvent['kind'],
      extra as Record<string, unknown>,
      OTHER_AUTHORITY,
    );
    const after = motorTestTransition(state, stale);

    expect(after.effects).toEqual([]);
    expect(kinds(after.effects)).not.toContain('SUBMIT_START_INTENT');
    expect(kinds(after.effects)).not.toContain('SUBMIT_STOP_INTENT');
    expect(after.state.name).toBe('Fault');
    if (after.state.name !== 'Fault') {
      throw new Error('unreachable');
    }
    expect(after.state.faultReason).toBe('AUTHORITY_MISMATCH');
    // The fault stays bound to the machine's OWN authority, never the
    // stranger's.
    expect(after.state.authority).toBe(AUTHORITY);
  });
});

describe('coalescing and escalation (16, 17)', () => {
  it('many concurrent triggers emit AT MOST one stop intent', () => {
    const result = run([
      ...TO_PULSING,
      stopTrigger('TOUCH_RELEASED'),
      stopTrigger('STOP_BUTTON_PRESSED'),
      stopTrigger('NAVIGATION_BLURRED'),
      stopTrigger('ANDROID_BACK'),
      stopTrigger('MOTOR_SELECTION_CHANGED'),
    ]);
    expect(
      kinds(result.effects).filter(k => k === 'SUBMIT_STOP_INTENT'),
    ).toEqual(['SUBMIT_STOP_INTENT']);
  });

  it('escalates Ready -> Locked and never downgrades', () => {
    const escalated = run([
      ...TO_PULSING,
      stopTrigger('TOUCH_RELEASED'),
      stopTrigger('BATTERY_BECAME_UNSAFE'),
      // A milder trigger AFTER the severe one must not soften it.
      stopTrigger('TOUCH_RELEASED'),
    ]);
    if (escalated.state.name !== 'Stopping') {
      throw new Error('unreachable');
    }
    expect(escalated.state.stopping.requiredDisposition).toBe('Locked');
    expect(run([...TO_PULSING,
      stopTrigger('TOUCH_RELEASED'),
      stopTrigger('BATTERY_BECAME_UNSAFE'),
      stopTrigger('TOUCH_RELEASED'),
      stopAck(),
    ]).state.name).toBe('Locked');
  });

  it('escalates Locked -> Fault when a fault follows a locking stop', () => {
    const result = run([
      ...TO_PULSING,
      stopTrigger('NAVIGATION_BLURRED'),
      fault('DESYNCHRONIZED'),
    ]);
    expect(result.state.name).toBe('Fault');
  });

  it('the disposition lattice itself is monotonic in both directions', () => {
    const order: readonly MotorTestStopDisposition[] = [
      'Ready',
      'Locked',
      'Fault',
    ];
    for (const current of order) {
      for (const next of order) {
        const result = escalateDisposition(current, next);
        const rank = (d: MotorTestStopDisposition) => order.indexOf(d);
        expect(rank(result)).toBe(Math.max(rank(current), rank(next)));
        // Never below where it already was.
        expect(rank(result)).toBeGreaterThanOrEqual(rank(current));
      }
    }
    expect(escalateDisposition('Fault', 'Ready')).toBe('Fault');
    expect(escalateDisposition('Locked', 'Ready')).toBe('Locked');
  });

  it('a start ACK during Stopping changes no disposition and adds no stop', () => {
    const result = run([
      ...TO_PULSING,
      stopTrigger('NAVIGATION_BLURRED'),
      startAck(),
    ]);
    if (result.state.name !== 'Stopping') {
      throw new Error('unreachable');
    }
    expect(result.state.stopping.requiredDisposition).toBe('Locked');
    expect(
      kinds(result.effects).filter(k => k === 'SUBMIT_STOP_INTENT'),
    ).toEqual(['SUBMIT_STOP_INTENT']);
  });
});

describe('immutability of the model', () => {
  it('every produced state, metadata object and effect list is frozen', () => {
    const transition = motorTestTransition(
      run([gatesPassed(), activation(), writeCalled()]).state,
      stopTrigger('TOUCH_RELEASED'),
    );
    expect(Object.isFrozen(transition)).toBe(true);
    expect(Object.isFrozen(transition.state)).toBe(true);
    expect(Object.isFrozen(transition.effects)).toBe(true);
    if (transition.state.name !== 'Stopping') {
      throw new Error('unreachable');
    }
    expect(Object.isFrozen(transition.state.stopping)).toBe(true);
  });

  it('is a pure function - the same input always yields the same result', () => {
    const state = run(TO_PULSING).state;
    const first = motorTestTransition(state, stopTrigger('TOUCH_RELEASED'));
    const second = motorTestTransition(state, stopTrigger('TOUCH_RELEASED'));
    expect(second.state).toEqual(first.state);
    expect(second.effects).toEqual(first.effects);
    // The input state was not mutated by either call.
    expect(state.name).toBe('Pulsing');
  });
});

describe('structural containment (20, 21)', () => {
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

  /** Built by concatenation so the literals appear in neither new file. */
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

  it.each(FORBIDDEN)('neither new file contains %s', token => {
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
});
