/**
 * P2-i - STOP DOMINATION RE-PROVEN FROM SCRATCH.
 *
 * The reducer is the stop-domination authority for the professional motor
 * control path. Every rule SD1..SD5 from its header is proven here against
 * the transition table itself, not against a driver that could be mocked
 * into agreeing.
 *
 * Nothing in this file asserts a physical outcome. An acknowledgement is
 * metadata; motor motion remains REQUIRES HARDWARE TEST.
 */
import {
  dispositionForStopReason,
  escalateDisposition,
  faultWarningPolicy,
  initialMotorControlState,
  MOTOR_CONTROL_STOP_UNCONFIRMED_WARNING,
  reduceMotorControl,
  type MotorControlEffect,
  type MotorControlEvent,
  type MotorControlFaultReason,
  type MotorControlPhase,
  type MotorControlState,
  type MotorControlStopReason,
} from './motorControlStateMachine';

const AUTHORITY: object = Object.freeze({session: 'A'});
const OTHER_AUTHORITY: object = Object.freeze({session: 'B'});

const kinds = (effects: readonly MotorControlEffect[]): string[] =>
  effects.map(effect => effect.kind);

/**
 * A plain `Omit<MotorControlEvent, 'authority'>` COLLAPSES the discriminated
 * union into one object type and silently loses every per-variant `reason`
 * field, so `{kind: 'STOP_TRIGGERED', reason: ...}` stops type-checking.
 * Distributing the omit over each member keeps the union intact - and keeps
 * an unknown reason a compile error, which is the point.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
type ScriptEvent = DistributiveOmit<MotorControlEvent, 'authority'>;

/** Drives the reducer through a script and returns the final state. */
function run(
  events: readonly ScriptEvent[],
  authority: object = AUTHORITY,
): {state: MotorControlState; effects: string[][]} {
  let state = initialMotorControlState(authority);
  const effects: string[][] = [];
  for (const event of events) {
    const transition = reduceMotorControl(state, {
      ...event,
      authority,
    } as MotorControlEvent);
    state = transition.state;
    effects.push(kinds(transition.effects));
  }
  return {state, effects};
}

/** The canonical route to a live commanding episode. */
const TO_COMMANDING: readonly ScriptEvent[] = [
  {kind: 'ENABLE_REQUESTED'},
  {kind: 'ENABLE_COMPLETED'},
  {kind: 'COMMAND_REQUESTED'},
];

const ALL_STOP_REASONS: readonly MotorControlStopReason[] = [
  'OPERATOR_STOP',
  'MASTER_TO_STOP',
  'VALUES_TO_STOP',
  'ARMED_STATE_DETECTED',
  'ARMED_STATE_UNKNOWN',
  'ARMING_RESTRICTION_LOST',
  'APP_BACKGROUNDED',
  'DEPARTURE_REQUESTED',
  'DISABLE_REQUESTED',
  'SAFETY_MONITORING_FAILED',
  'CONFIGURATION_CHANGED',
];

const ALL_FAULT_REASONS: readonly MotorControlFaultReason[] = [
  'ENABLE_FAILED',
  'COMMAND_FAILED',
  'COMMAND_UNCONFIRMED',
  'STOP_FAILED',
  'STOP_UNCONFIRMED',
  'SESSION_ENDED',
  'AUTHORITY_MISMATCH',
  'TRANSPORT_LOST',
  'UNSUPPORTED_DOMAIN',
];

/* ==================================================================== *
 * Baseline transitions
 * ==================================================================== */
describe('motorControl reducer - enable flow', () => {
  it('starts Disabled', () => {
    expect(initialMotorControlState(AUTHORITY).phase).toBe('Disabled');
  });

  it('Disabled -> Enabling -> EnabledIdle, and never straight to commanding', () => {
    const {state, effects} = run([
      {kind: 'ENABLE_REQUESTED'},
      {kind: 'ENABLE_COMPLETED'},
    ]);
    expect(state.phase).toBe('EnabledIdle');
    // The enable flow sends no active vector, so it emits no command intent.
    expect(effects.flat()).toEqual([]);
  });

  it('a failed enable lands Disabled and asks for teardown, never Fault', () => {
    const {state, effects} = run([
      {kind: 'ENABLE_REQUESTED'},
      {kind: 'ENABLE_FAILED', reason: 'ENABLE_FAILED'},
    ]);
    expect(state.phase).toBe('Disabled');
    expect(effects[1]).toEqual(['BEGIN_TEARDOWN']);
  });

  it('a failed enable emits no command intent at any point', () => {
    const {effects} = run([
      {kind: 'ENABLE_REQUESTED'},
      {kind: 'COMMAND_REQUESTED'},
      {kind: 'ENABLE_FAILED', reason: 'UNSUPPORTED_DOMAIN'},
    ]);
    expect(effects.flat()).not.toContain('SUBMIT_COMMAND_INTENT');
  });

  it('ENABLE_COMPLETED is ignored unless Enabling', () => {
    const {state} = run([{kind: 'ENABLE_COMPLETED'}]);
    expect(state.phase).toBe('Disabled');
  });

  it('a duplicate ENABLE_REQUESTED changes nothing', () => {
    const {state} = run([
      {kind: 'ENABLE_REQUESTED'},
      {kind: 'ENABLE_REQUESTED'},
    ]);
    expect(state.phase).toBe('Enabling');
  });
});

describe('motorControl reducer - commanding', () => {
  it('EnabledIdle -> EnabledCommanding emits exactly one command intent', () => {
    const {state, effects} = run(TO_COMMANDING);
    expect(state.phase).toBe('EnabledCommanding');
    expect(effects[2]).toEqual(['SUBMIT_COMMAND_INTENT']);
  });

  it('a newer request while commanding re-emits the intent and clears the ack', () => {
    const {state, effects} = run([
      ...TO_COMMANDING,
      {kind: 'COMMAND_ACKNOWLEDGED'},
      {kind: 'COMMAND_REQUESTED'},
    ]);
    expect(state.phase).toBe('EnabledCommanding');
    expect(state).toMatchObject({commandAcknowledged: false});
    expect(effects[4]).toEqual(['SUBMIT_COMMAND_INTENT']);
  });

  it('an acknowledgement records metadata and emits nothing', () => {
    const {state, effects} = run([
      ...TO_COMMANDING,
      {kind: 'COMMAND_ACKNOWLEDGED'},
    ]);
    expect(state).toMatchObject({
      phase: 'EnabledCommanding',
      commandAcknowledged: true,
    });
    expect(effects[3]).toEqual([]);
  });

  it('a failed command takes the stop route rather than faulting immediately', () => {
    const {state, effects} = run([
      ...TO_COMMANDING,
      {kind: 'COMMAND_FAILED', reason: 'COMMAND_UNCONFIRMED'},
    ]);
    expect(state.phase).toBe('Stopping');
    expect(effects[3]).toEqual(['SUBMIT_STOP_INTENT']);
  });
});

/* ==================================================================== *
 * SD1 - a command requested after a stop begins is REFUSED
 * ==================================================================== */
describe('SD1 - stop refuses new commands', () => {
  it('COMMAND_REQUESTED while Stopping does not re-enter commanding', () => {
    const {state, effects} = run([
      ...TO_COMMANDING,
      {kind: 'STOP_TRIGGERED', reason: 'OPERATOR_STOP'},
      {kind: 'COMMAND_REQUESTED'},
    ]);
    expect(state.phase).toBe('Stopping');
    expect(effects[4]).toEqual([]);
  });

  it('a whole burst of stale slider requests after STOP emits nothing', () => {
    const burst = Array.from({length: 20}, () => ({
      kind: 'COMMAND_REQUESTED' as const,
    }));
    const {state, effects} = run([
      ...TO_COMMANDING,
      {kind: 'STOP_TRIGGERED', reason: 'OPERATOR_STOP'},
      ...burst,
    ]);
    expect(state.phase).toBe('Stopping');
    expect(effects.slice(4).flat()).toEqual([]);
  });

  it('COMMAND_REQUESTED is refused in Fault, Disabled and Enabling too', () => {
    for (const script of [
      [{kind: 'FAULT_RAISED' as const, reason: 'SESSION_ENDED' as const}],
      [],
      [{kind: 'ENABLE_REQUESTED' as const}],
    ]) {
      const {state, effects} = run([
        ...script,
        {kind: 'COMMAND_REQUESTED'},
      ]);
      expect(state.phase).not.toBe('EnabledCommanding');
      expect(effects[effects.length - 1]).toEqual([]);
    }
  });

  it('no stop reason permits a command to follow it', () => {
    for (const reason of ALL_STOP_REASONS) {
      const {state, effects} = run([
        ...TO_COMMANDING,
        {kind: 'STOP_TRIGGERED', reason},
        {kind: 'COMMAND_REQUESTED'},
      ]);
      expect(state.phase).toBe('Stopping');
      expect(effects[4]).toEqual([]);
    }
  });
});

/* ==================================================================== *
 * SD2 - a late acknowledgement can never restore active state
 * ==================================================================== */
describe('SD2 - late acknowledgement is discarded', () => {
  it('COMMAND_ACKNOWLEDGED after STOP cannot re-enter commanding', () => {
    const {state, effects} = run([
      ...TO_COMMANDING,
      {kind: 'STOP_TRIGGERED', reason: 'OPERATOR_STOP'},
      {kind: 'COMMAND_ACKNOWLEDGED'},
    ]);
    expect(state.phase).toBe('Stopping');
    expect(effects[4]).toEqual([]);
  });

  it('COMMAND_ACKNOWLEDGED after a confirmed stop cannot revive the episode', () => {
    const {state} = run([
      ...TO_COMMANDING,
      {kind: 'STOP_TRIGGERED', reason: 'OPERATOR_STOP'},
      {kind: 'STOP_ACKNOWLEDGED'},
      {kind: 'COMMAND_ACKNOWLEDGED'},
    ]);
    expect(state.phase).toBe('EnabledIdle');
  });

  it('COMMAND_ACKNOWLEDGED cannot clear a fault', () => {
    const {state} = run([
      ...TO_COMMANDING,
      {kind: 'FAULT_RAISED', reason: 'TRANSPORT_LOST'},
      {kind: 'COMMAND_ACKNOWLEDGED'},
    ]);
    expect(state).toMatchObject({phase: 'Fault', faultReason: 'TRANSPORT_LOST'});
  });
});

/* ==================================================================== *
 * SD3 - stop is accepted everywhere and always reasserted
 * ==================================================================== */
describe('SD3 - stop is reasserted, never suppressed', () => {
  it('a repeated STOP_TRIGGERED re-emits the stop intent every time', () => {
    const {effects} = run([
      ...TO_COMMANDING,
      {kind: 'STOP_TRIGGERED', reason: 'OPERATOR_STOP'},
      {kind: 'STOP_TRIGGERED', reason: 'OPERATOR_STOP'},
      {kind: 'STOP_TRIGGERED', reason: 'OPERATOR_STOP'},
    ]);
    expect(effects[3]).toEqual(['SUBMIT_STOP_INTENT']);
    expect(effects[4]).toEqual(['SUBMIT_STOP_INTENT']);
    expect(effects[5]).toEqual(['SUBMIT_STOP_INTENT']);
  });

  it('stop is accepted from Enabling, EnabledIdle, EnabledCommanding and Fault', () => {
    const origins: readonly {
      readonly script: readonly ScriptEvent[];
      readonly phase: MotorControlPhase;
    }[] = [
      {script: [{kind: 'ENABLE_REQUESTED'}], phase: 'Enabling'},
      {
        script: [{kind: 'ENABLE_REQUESTED'}, {kind: 'ENABLE_COMPLETED'}],
        phase: 'EnabledIdle',
      },
      {script: TO_COMMANDING, phase: 'EnabledCommanding'},
      {
        script: [...TO_COMMANDING, {kind: 'FAULT_RAISED', reason: 'SESSION_ENDED'}],
        phase: 'Fault',
      },
    ];
    for (const origin of origins) {
      const before = run(origin.script);
      expect(before.state.phase).toBe(origin.phase);
      const {state, effects} = run([
        ...origin.script,
        {kind: 'STOP_TRIGGERED', reason: 'OPERATOR_STOP'},
      ]);
      expect(state.phase).toBe('Stopping');
      expect(effects[effects.length - 1]).toEqual(['SUBMIT_STOP_INTENT']);
    }
  });

  it('stop is the only thing Disabled refuses, because nothing can be live', () => {
    const {state, effects} = run([
      {kind: 'STOP_TRIGGERED', reason: 'OPERATOR_STOP'},
    ]);
    expect(state.phase).toBe('Disabled');
    expect(effects[0]).toEqual([]);
  });

  it('the original stop reason survives a later escalating trigger', () => {
    const {state} = run([
      ...TO_COMMANDING,
      {kind: 'STOP_TRIGGERED', reason: 'OPERATOR_STOP'},
      {kind: 'STOP_TRIGGERED', reason: 'ARMED_STATE_DETECTED'},
    ]);
    expect(state).toMatchObject({
      phase: 'Stopping',
      stopping: {stopReason: 'OPERATOR_STOP', requiredDisposition: 'Disabled'},
    });
  });
});

/* ==================================================================== *
 * SD4 - disposition is monotonic
 * ==================================================================== */
describe('SD4 - disposition escalates and never de-escalates', () => {
  it('escalateDisposition is monotonic across every pair', () => {
    const order = ['EnabledIdle', 'Disabled', 'Fault'] as const;
    for (let i = 0; i < order.length; i += 1) {
      for (let j = 0; j < order.length; j += 1) {
        const result = escalateDisposition(order[i], order[j]);
        expect(order.indexOf(result)).toBe(Math.max(i, j));
      }
    }
  });

  it('an ordinary stop escalated by an armed detection lands Disabled', () => {
    const {state} = run([
      ...TO_COMMANDING,
      {kind: 'STOP_TRIGGERED', reason: 'OPERATOR_STOP'},
      {kind: 'STOP_TRIGGERED', reason: 'ARMED_STATE_DETECTED'},
      {kind: 'STOP_ACKNOWLEDGED'},
    ]);
    expect(state.phase).toBe('Disabled');
  });

  it('a locking stop is NOT lowered by a later ordinary stop', () => {
    const {state} = run([
      ...TO_COMMANDING,
      {kind: 'STOP_TRIGGERED', reason: 'ARMED_STATE_UNKNOWN'},
      {kind: 'STOP_TRIGGERED', reason: 'OPERATOR_STOP'},
      {kind: 'STOP_ACKNOWLEDGED'},
    ]);
    expect(state.phase).toBe('Disabled');
  });

  it('every locking reason asks for Disabled, every normal reason for EnabledIdle', () => {
    for (const reason of ALL_STOP_REASONS) {
      const normal =
        reason === 'OPERATOR_STOP' ||
        reason === 'MASTER_TO_STOP' ||
        reason === 'VALUES_TO_STOP';
      expect(dispositionForStopReason(reason)).toBe(
        normal ? 'EnabledIdle' : 'Disabled',
      );
    }
  });
});

/* ==================================================================== *
 * SD5 - re-entering commanding requires a permitting phase
 * ==================================================================== */
describe('SD5 - resuming requires a commandable phase', () => {
  it('an ordinary confirmed stop returns to EnabledIdle and may command again', () => {
    const {state, effects} = run([
      ...TO_COMMANDING,
      {kind: 'STOP_TRIGGERED', reason: 'OPERATOR_STOP'},
      {kind: 'STOP_ACKNOWLEDGED'},
      {kind: 'COMMAND_REQUESTED'},
    ]);
    expect(state.phase).toBe('EnabledCommanding');
    expect(effects[5]).toEqual(['SUBMIT_COMMAND_INTENT']);
  });

  it('a locking confirmed stop lands Disabled and refuses a command', () => {
    const {state, effects} = run([
      ...TO_COMMANDING,
      {kind: 'STOP_TRIGGERED', reason: 'ARMED_STATE_DETECTED'},
      {kind: 'STOP_ACKNOWLEDGED'},
      {kind: 'COMMAND_REQUESTED'},
    ]);
    expect(state.phase).toBe('Disabled');
    expect(effects[5]).toEqual([]);
  });

  it('a locking stop asks for teardown when confirmed', () => {
    const {effects} = run([
      ...TO_COMMANDING,
      {kind: 'STOP_TRIGGERED', reason: 'DEPARTURE_REQUESTED'},
      {kind: 'STOP_ACKNOWLEDGED'},
    ]);
    expect(effects[4]).toEqual(['BEGIN_TEARDOWN']);
  });

  it('a full re-enable is required and sufficient after a locking stop', () => {
    const {state} = run([
      ...TO_COMMANDING,
      {kind: 'STOP_TRIGGERED', reason: 'ARMED_STATE_DETECTED'},
      {kind: 'STOP_ACKNOWLEDGED'},
      {kind: 'ENABLE_REQUESTED'},
      {kind: 'ENABLE_COMPLETED'},
      {kind: 'COMMAND_REQUESTED'},
    ]);
    expect(state.phase).toBe('EnabledCommanding');
  });

  it('STOP_ACKNOWLEDGED outside Stopping changes nothing', () => {
    const {state} = run([...TO_COMMANDING, {kind: 'STOP_ACKNOWLEDGED'}]);
    expect(state.phase).toBe('EnabledCommanding');
  });
});

/* ==================================================================== *
 * Faults
 * ==================================================================== */
describe('motorControl reducer - faults', () => {
  it('a fault while commanding warns, because a command may be live', () => {
    const {state, effects} = run([
      ...TO_COMMANDING,
      {kind: 'FAULT_RAISED', reason: 'TRANSPORT_LOST'},
    ]);
    expect(state).toMatchObject({phase: 'Fault', commandMayBeLive: true});
    expect(effects[3]).toEqual([
      'SHOW_STOP_UNCONFIRMED_WARNING',
      'BEGIN_TEARDOWN',
    ]);
  });

  it('the warning text is the exported constant', () => {
    const state = initialMotorControlState(AUTHORITY);
    let current = state;
    for (const event of TO_COMMANDING) {
      current = reduceMotorControl(current, {
        ...event,
        authority: AUTHORITY,
      } as MotorControlEvent).state;
    }
    const {effects} = reduceMotorControl(current, {
      kind: 'FAULT_RAISED',
      reason: 'STOP_FAILED',
      authority: AUTHORITY,
    });
    const warning = effects.find(
      effect => effect.kind === 'SHOW_STOP_UNCONFIRMED_WARNING',
    );
    expect(warning).toMatchObject({
      message: MOTOR_CONTROL_STOP_UNCONFIRMED_WARNING,
    });
  });

  it('a fault before any command does NOT warn', () => {
    const {state, effects} = run([
      {kind: 'ENABLE_REQUESTED'},
      {kind: 'ENABLE_COMPLETED'},
      {kind: 'FAULT_RAISED', reason: 'SESSION_ENDED'},
    ]);
    expect(state).toMatchObject({phase: 'Fault', commandMayBeLive: false});
    expect(effects[2]).toEqual(['BEGIN_TEARDOWN']);
  });

  it('ENABLE_FAILED and UNSUPPORTED_DOMAIN never warn, even mid-episode', () => {
    for (const reason of ['ENABLE_FAILED', 'UNSUPPORTED_DOMAIN'] as const) {
      expect(faultWarningPolicy(reason)).toBe('NEVER_WARN');
      const {effects} = run([...TO_COMMANDING, {kind: 'FAULT_RAISED', reason}]);
      expect(effects[3]).not.toContain('SHOW_STOP_UNCONFIRMED_WARNING');
    }
  });

  it('every other fault reason warns when a command may be live', () => {
    for (const reason of ALL_FAULT_REASONS) {
      if (reason === 'ENABLE_FAILED' || reason === 'UNSUPPORTED_DOMAIN') {
        continue;
      }
      expect(faultWarningPolicy(reason)).toBe('WARN_IF_COMMAND_MAY_BE_LIVE');
      const {effects} = run([...TO_COMMANDING, {kind: 'FAULT_RAISED', reason}]);
      expect(effects[3]).toContain('SHOW_STOP_UNCONFIRMED_WARNING');
    }
  });

  it('Fault is terminal and keeps the FIRST reason', () => {
    const {state} = run([
      ...TO_COMMANDING,
      {kind: 'FAULT_RAISED', reason: 'TRANSPORT_LOST'},
      {kind: 'FAULT_RAISED', reason: 'SESSION_ENDED'},
      {kind: 'ENABLE_REQUESTED'},
      {kind: 'ENABLE_COMPLETED'},
    ]);
    expect(state).toMatchObject({phase: 'Fault', faultReason: 'TRANSPORT_LOST'});
  });

  it('a stop that is confirmed after a fault-escalated disposition clears liveness', () => {
    const {state} = run([
      ...TO_COMMANDING,
      {kind: 'STOP_TRIGGERED', reason: 'OPERATOR_STOP'},
      {kind: 'STOP_ACKNOWLEDGED'},
    ]);
    expect(state.phase).toBe('EnabledIdle');
  });
});

/* ==================================================================== *
 * Authority isolation
 * ==================================================================== */
describe('motorControl reducer - authority isolation', () => {
  it('an event from another authority is ignored entirely', () => {
    let state = initialMotorControlState(AUTHORITY);
    for (const event of TO_COMMANDING) {
      state = reduceMotorControl(state, {
        ...event,
        authority: AUTHORITY,
      } as MotorControlEvent).state;
    }
    const {state: after, effects} = reduceMotorControl(state, {
      kind: 'STOP_TRIGGERED',
      reason: 'ARMED_STATE_DETECTED',
      authority: OTHER_AUTHORITY,
    });
    expect(after).toBe(state);
    expect(effects).toEqual([]);
  });

  it("a foreign acknowledgement cannot advance this machine's episode", () => {
    let state = initialMotorControlState(AUTHORITY);
    for (const event of TO_COMMANDING) {
      state = reduceMotorControl(state, {
        ...event,
        authority: AUTHORITY,
      } as MotorControlEvent).state;
    }
    const after = reduceMotorControl(state, {
      kind: 'COMMAND_ACKNOWLEDGED',
      authority: OTHER_AUTHORITY,
    }).state;
    expect(after).toMatchObject({commandAcknowledged: false});
  });
});

/* ==================================================================== *
 * Structural guarantees
 * ==================================================================== */
describe('motorControl reducer - structural guarantees', () => {
  it('every returned state and transition is frozen', () => {
    let state = initialMotorControlState(AUTHORITY);
    expect(Object.isFrozen(state)).toBe(true);
    for (const event of [
      ...TO_COMMANDING,
      {kind: 'STOP_TRIGGERED' as const, reason: 'OPERATOR_STOP' as const},
      {kind: 'STOP_ACKNOWLEDGED' as const},
    ]) {
      const transition = reduceMotorControl(state, {
        ...event,
        authority: AUTHORITY,
      } as MotorControlEvent);
      expect(Object.isFrozen(transition)).toBe(true);
      expect(Object.isFrozen(transition.state)).toBe(true);
      expect(Object.isFrozen(transition.effects)).toBe(true);
      state = transition.state;
    }
  });

  it('the reducer is pure - the same input always yields the same phase', () => {
    const state = initialMotorControlState(AUTHORITY);
    const event = {kind: 'ENABLE_REQUESTED', authority: AUTHORITY} as const;
    const first = reduceMotorControl(state, event);
    const second = reduceMotorControl(state, event);
    expect(first.state.phase).toBe(second.state.phase);
    expect(state.phase).toBe('Disabled');
  });

  it('no command intent is ever emitted alongside a stop intent', () => {
    const scripts: ScriptEvent[][] = [
      [...TO_COMMANDING, {kind: 'STOP_TRIGGERED', reason: 'OPERATOR_STOP'}],
      [...TO_COMMANDING, {kind: 'COMMAND_FAILED', reason: 'COMMAND_FAILED'}],
      [...TO_COMMANDING, {kind: 'STOP_TRIGGERED', reason: 'ARMED_STATE_UNKNOWN'}],
    ];
    for (const script of scripts) {
      const {effects} = run(script);
      for (const step of effects) {
        expect(
          step.includes('SUBMIT_COMMAND_INTENT') &&
            step.includes('SUBMIT_STOP_INTENT'),
        ).toBe(false);
      }
    }
  });
});
