/**
 * THE FIELD BUG: every configuration screen stayed blocked after one
 * motor test, until the USB cable was physically unplugged and replugged.
 *
 * The operator reported it as three separate symptoms - Motors not
 * releasing its session, Configurations demanding a return to Motors with
 * no pending change and no save action, and Ports being unable to apply a
 * UART6 change. All three were ONE predicate, duplicated across four
 * controllers, reading a permanent safety latch (`pulse.mayHaveReachedFc`,
 * documented in motorTestController.ts as "never cleared") as if it meant
 * "a motor-test session is running right now".
 *
 * NO HARDWARE: no USB, FC, ESC, LiPo or motor is touched.
 */

import {isMotorTestSnapshotActive} from './motorTestCapability';
import type {MotorTestControllerSnapshot} from '../../../core/state/motorTestController';

type Teardown = MotorTestControllerSnapshot['teardown'];

const COMPLETED_TEARDOWN = {
  steps: [],
  safetyMonitorStopped: true,
  leaseRelease: 'RELEASED',
  telemetryTokensReleased: true,
  complete: true,
} as unknown as Teardown;

const UNRESOLVED_TEARDOWN = {
  steps: [],
  safetyMonitorStopped: true,
  leaseRelease: 'LEASE_WORK_UNSETTLED',
  telemetryTokensReleased: false,
  complete: false,
  incompleteReason: 'LEASE_RELEASE_UNRESOLVED',
} as unknown as Teardown;

/** A snapshot whose `mayHaveReachedFc` latch is SET - i.e. the operator
 * has tested a motor at least once in this physical session, which is the
 * exact state the field report was taken in. */
function afterAMotorTest(
  overrides: Partial<MotorTestControllerSnapshot>,
): MotorTestControllerSnapshot {
  return {
    phase: 'CLOSED',
    machine: undefined,
    pulse: {
      attemptId: 1,
      motorNumber: 1,
      submitted: true,
      acknowledged: true,
      deadlineArmedAtSubmission: true,
      mayHaveReachedFc: true,
      outcome: {kind: 'ACKNOWLEDGED'},
    },
    teardown: undefined,
    ...overrides,
  } as unknown as MotorTestControllerSnapshot;
}

describe('isMotorTestSnapshotActive - liveness, not history', () => {
  it('no capability at all is not an active session', () => {
    expect(isMotorTestSnapshotActive(undefined)).toBe(false);
  });

  it('THE FIELD BUG: a CLOSED session whose teardown COMPLETED is not active, even though mayHaveReachedFc stays latched forever', () => {
    const snapshot = afterAMotorTest({phase: 'CLOSED', teardown: COMPLETED_TEARDOWN});
    expect(snapshot.pulse.mayHaveReachedFc).toBe(true);
    expect(isMotorTestSnapshotActive(snapshot)).toBe(false);
  });

  it('a CLOSED session whose lease release never resolved STILL blocks - an unresolved release is not a released one', () => {
    expect(
      isMotorTestSnapshotActive(afterAMotorTest({phase: 'CLOSED', teardown: UNRESOLVED_TEARDOWN})),
    ).toBe(true);
  });

  it('a CLOSED session with no teardown report at all STILL blocks', () => {
    expect(isMotorTestSnapshotActive(afterAMotorTest({phase: 'CLOSED', teardown: undefined}))).toBe(
      true,
    );
  });

  it.each(['PREPARING', 'ACTIVE', 'CLOSING'] as const)('a %s session is active', phase => {
    expect(isMotorTestSnapshotActive(afterAMotorTest({phase}))).toBe(true);
  });

  it('an IDLE capability that acquired nothing is not active', () => {
    expect(
      isMotorTestSnapshotActive(
        afterAMotorTest({
          phase: 'IDLE',
          pulse: {
            attemptId: 0,
            motorNumber: 0,
            submitted: false,
            acknowledged: false,
            deadlineArmedAtSubmission: false,
            mayHaveReachedFc: false,
            outcome: undefined,
          } as unknown as MotorTestControllerSnapshot['pulse'],
        }),
      ),
    ).toBe(false);
  });

  it('an ACTIVE session that has never pulsed is still active - the phase alone is enough', () => {
    expect(
      isMotorTestSnapshotActive(
        afterAMotorTest({
          phase: 'ACTIVE',
          pulse: {
            attemptId: 0,
            motorNumber: 0,
            submitted: false,
            acknowledged: false,
            deadlineArmedAtSubmission: false,
            mayHaveReachedFc: false,
            outcome: undefined,
          } as unknown as MotorTestControllerSnapshot['pulse'],
        }),
      ),
    ).toBe(true);
  });

  it.each(['Starting', 'Pulsing', 'Stopping'] as const)(
    'a live %s machine with no completed teardown is active',
    name => {
      expect(
        isMotorTestSnapshotActive(
          afterAMotorTest({
            phase: 'CLOSED',
            teardown: undefined,
            machine: {name} as unknown as MotorTestControllerSnapshot['machine'],
          }),
        ),
      ).toBe(true);
    },
  );
});
