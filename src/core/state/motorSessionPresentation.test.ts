/**
 * THE SESSION TOGGLE'S TRUTH TABLE.
 *
 * The defect these tests exist for was not hypothetical and was not found
 * by reading: it was measured. The controller's clean teardown leaves
 * `outcome.kind === 'READY'` untouched and only sets `phase = 'CLOSED'`
 * (motorTestController.ts:4295 and :4321), and the old workspace derived
 * its state from a UI-owned boolean, so a CLOSED session with a stale
 * `true` rendered READY. Every row below is the states a real teardown
 * actually produces, pinned so no future edit can quietly reintroduce a
 * toggle that reports ON for a session that is gone.
 */

import {
  deriveMotorSessionState,
  motorControlMayBeEnabled,
  motorSessionHoldsAuthority,
  motorSessionIsTransitioning,
  motorSessionSwitchValue,
  type MotorSessionState,
} from './motorSessionPresentation';
import type {MotorTestControllerSnapshot} from './motorTestController';

function snap(over: {
  phase: MotorTestControllerSnapshot['phase'];
  outcome?: 'READY' | 'PENDING' | 'BLOCKED' | 'FAILED_CLOSED';
  teardownComplete?: boolean;
}): MotorTestControllerSnapshot {
  const kind = over.outcome ?? 'READY';
  return {
    phase: over.phase,
    outcome:
      kind === 'BLOCKED'
        ? {kind, reason: 'MOTOR_SCOPE_UNSUPPORTED', requiresNewSession: true}
        : kind === 'FAILED_CLOSED'
          ? {kind, reason: 'TEARDOWN_INCOMPLETE', requiresNewSession: true}
          : {kind},
    ...(over.teardownComplete === undefined
      ? {}
      : {teardown: {complete: over.teardownComplete}}),
  } as unknown as MotorTestControllerSnapshot;
}

describe('the session state comes from the controller, never from a UI boolean', () => {
  it('THE MEASURED DEFECT: a clean teardown reads OFF, not ON', () => {
    // phase CLOSED + outcome READY is exactly what close() publishes on the
    // happy path. This is the pair that used to render READY.
    expect(
      deriveMotorSessionState(
        snap({phase: 'CLOSED', outcome: 'READY', teardownComplete: true}),
        false,
      ),
    ).toBe('OFF');
  });

  it('and it still reads OFF even if an open intent is somehow still set', () => {
    // Intent may NEVER hold a session open that the controller has closed.
    expect(
      deriveMotorSessionState(
        snap({phase: 'CLOSED', outcome: 'READY', teardownComplete: true}),
        true,
      ),
    ).toBe('OFF');
  });

  it('an INCOMPLETE teardown is ERROR - not OFF, because authority may still be held', () => {
    expect(
      deriveMotorSessionState(
        snap({phase: 'CLOSED', outcome: 'READY', teardownComplete: false}),
        false,
      ),
    ).toBe('ERROR');
  });

  it('a failed-closed session is ERROR whether open or closed', () => {
    expect(deriveMotorSessionState(snap({phase: 'CLOSED', outcome: 'FAILED_CLOSED'}), false)).toBe('ERROR');
    expect(deriveMotorSessionState(snap({phase: 'ACTIVE', outcome: 'FAILED_CLOSED'}), false)).toBe('ERROR');
  });

  it.each([
    ['IDLE', false, 'OFF'],
    ['IDLE', true, 'OPENING'],
    ['PREPARING', false, 'OPENING'],
    ['PREPARING', true, 'OPENING'],
    ['ACTIVE', false, 'ON'],
    ['CLOSING', false, 'CLOSING'],
    ['CLOSING', true, 'CLOSING'],
  ] as const)('phase %s with openRequested=%s reads %s', (phase, intent, expected) => {
    expect(
      deriveMotorSessionState(snap({phase: phase as never}), intent),
    ).toBe(expected);
  });

  it('no snapshot at all is UNKNOWN, which is not the same sentence as OFF', () => {
    expect(deriveMotorSessionState(undefined, false)).toBe('UNKNOWN');
    // ...but a press with nothing bound yet is still an honest OPENING.
    expect(deriveMotorSessionState(undefined, true)).toBe('OPENING');
  });
});

describe('what the switch is allowed to show', () => {
  it('ON is the ONLY state that reads as on', () => {
    const states: MotorSessionState[] = ['OFF', 'OPENING', 'ON', 'CLOSING', 'ERROR', 'UNKNOWN'];
    const on = states.filter(motorSessionSwitchValue);
    expect(on).toEqual(['ON']);
  });

  it('ERROR and UNKNOWN never read as ON', () => {
    expect(motorSessionSwitchValue('ERROR')).toBe(false);
    expect(motorSessionSwitchValue('UNKNOWN')).toBe(false);
  });

  it('the two transitional states are the ones that refuse a new instruction', () => {
    const states: MotorSessionState[] = ['OFF', 'OPENING', 'ON', 'CLOSING', 'ERROR', 'UNKNOWN'];
    expect(states.filter(motorSessionIsTransitioning)).toEqual(['OPENING', 'CLOSING']);
  });

  it('ERROR still counts as holding authority, so OFF has work to do', () => {
    expect(motorSessionHoldsAuthority('ERROR')).toBe(true);
    expect(motorSessionHoldsAuthority('ON')).toBe(true);
    expect(motorSessionHoldsAuthority('OPENING')).toBe(true);
    expect(motorSessionHoldsAuthority('OFF')).toBe(false);
    expect(motorSessionHoldsAuthority('UNKNOWN')).toBe(false);
  });
});

describe('motor control is a SECOND authority, not the session', () => {
  it('is impossible without a session, in every non-ON state', () => {
    for (const state of ['OFF', 'OPENING', 'CLOSING', 'ERROR', 'UNKNOWN'] as const) {
      expect(
        motorControlMayBeEnabled(state, snap({phase: 'ACTIVE', outcome: 'READY'})),
      ).toBe(false);
    }
  });

  it('needs the controller to be READY as well as the session to be ON', () => {
    expect(motorControlMayBeEnabled('ON', snap({phase: 'ACTIVE', outcome: 'PENDING'}))).toBe(false);
    expect(motorControlMayBeEnabled('ON', snap({phase: 'ACTIVE', outcome: 'BLOCKED'}))).toBe(false);
    expect(motorControlMayBeEnabled('ON', snap({phase: 'ACTIVE', outcome: 'READY'}))).toBe(true);
  });

  it('is false with no snapshot, whatever the session claims', () => {
    expect(motorControlMayBeEnabled('ON', undefined)).toBe(false);
  });
});
