/**
 * THE FIELD REGRESSION: leaving Motors switched tabs immediately, without
 * waiting for any bounded stop result, so an operator whose stop was never
 * confirmed was moved off the Motors screen with no LiPo warning.
 *
 * NO HARDWARE: no USB, FC, ESC, LiPo or motor is touched.
 */

import {
  MOTOR_DEPARTURE_BOUND_MILLIS,
  evaluateMotorDeparture,
} from './motorDepartureGate';
import {MOTOR_TEST_QUIESCENCE_TIMEOUT_MILLIS} from '../protocol/telemetry/motorTestTelemetryBarrier';
import type {MotorTestControllerSnapshot} from './motorTestController';

type Stop = MotorTestControllerSnapshot['stopExecution'];

function snapshotOf(options: {
  mayHaveReachedFc: boolean;
  stopOutcome?: Stop['outcome'];
}): MotorTestControllerSnapshot {
  return {
    pulse: {mayHaveReachedFc: options.mayHaveReachedFc},
    stopExecution: {outcome: options.stopOutcome},
  } as unknown as MotorTestControllerSnapshot;
}

describe('evaluateMotorDeparture', () => {
  it('the bound is the SAME derived quiescence bound the telemetry barrier uses', () => {
    expect(MOTOR_DEPARTURE_BOUND_MILLIS).toBe(
      MOTOR_TEST_QUIESCENCE_TIMEOUT_MILLIS,
    );
  });

  it('no controller at all is safe - there is nothing that could be commanding a motor', () => {
    expect(evaluateMotorDeparture(undefined, 0)).toBe('SAFE');
    expect(evaluateMotorDeparture(undefined, 10_000)).toBe('SAFE');
  });

  it('a session that never commanded a motor is safe immediately', () => {
    const snapshot = snapshotOf({mayHaveReachedFc: false});
    expect(evaluateMotorDeparture(snapshot, 0)).toBe('SAFE');
  });

  it('an ACKNOWLEDGED stop permits departure immediately', () => {
    const snapshot = snapshotOf({
      mayHaveReachedFc: true,
      stopOutcome: {kind: 'ACKNOWLEDGED'},
    });
    expect(evaluateMotorDeparture(snapshot, 0)).toBe('SAFE');
  });

  it('THE FIELD CASE: a command that may be live holds navigation while the bounded window runs', () => {
    const snapshot = snapshotOf({mayHaveReachedFc: true});
    expect(evaluateMotorDeparture(snapshot, 0)).toBe('PENDING');
    expect(
      evaluateMotorDeparture(snapshot, MOTOR_DEPARTURE_BOUND_MILLIS - 1),
    ).toBe('PENDING');
  });

  it('once the bounded window elapses with no accepted stop, departure is UNCONFIRMED - never silently allowed', () => {
    const snapshot = snapshotOf({mayHaveReachedFc: true});
    expect(evaluateMotorDeparture(snapshot, MOTOR_DEPARTURE_BOUND_MILLIS)).toBe(
      'UNCONFIRMED',
    );
    expect(evaluateMotorDeparture(snapshot, 60_000)).toBe('UNCONFIRMED');
  });

  it.each([
    [{kind: 'FAILED', reason: 'REQUEST_FAILED'}],
    [{kind: 'NOT_ATTEMPTED', reason: 'NO_LEASE'}],
    [{kind: 'SCOPE_REJECTED'}],
  ])('a non-acknowledged stop outcome (%p) never counts as safe', outcome => {
    const snapshot = snapshotOf({
      mayHaveReachedFc: true,
      stopOutcome: outcome as Stop['outcome'],
    });
    expect(evaluateMotorDeparture(snapshot, 0)).toBe('PENDING');
    expect(evaluateMotorDeparture(snapshot, MOTOR_DEPARTURE_BOUND_MILLIS)).toBe(
      'UNCONFIRMED',
    );
  });

  it('the permanent mayHaveReachedFc latch alone never blocks forever once the stop is acknowledged', () => {
    // The exact mistake that caused the configuration-screen lockout:
    // the latch stays true for the rest of the session.
    const snapshot = snapshotOf({
      mayHaveReachedFc: true,
      stopOutcome: {kind: 'ACKNOWLEDGED'},
    });
    expect(snapshot.pulse.mayHaveReachedFc).toBe(true);
    expect(evaluateMotorDeparture(snapshot, 60_000)).toBe('SAFE');
  });
});
