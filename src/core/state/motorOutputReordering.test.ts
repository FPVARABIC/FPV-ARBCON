import { deriveMotorOutputOrder } from './motorOutputReordering';
import type {
  MotorPhysicalPosition,
  MotorVerificationState,
} from './motorVerificationModel';

function verified(
  positions: readonly MotorPhysicalPosition[],
): MotorVerificationState {
  return Object.freeze({
    sessionToken: {},
    finalized: false,
    aborted: false,
    entries: Object.freeze(
      positions.map((position, index) =>
        Object.freeze({
          motorNumber: index + 1,
          outcome: 'MATCH' as const,
          observation: Object.freeze({
            kind: 'OBSERVED' as const,
            position,
            direction: 'CW' as const,
          }),
          attemptId: index + 1,
        }),
      ),
    ),
  });
}

describe('deriveMotorOutputOrder', () => {
  it('keeps an already-correct default map unchanged', () => {
    expect(
      deriveMotorOutputOrder(
        [0, 1, 2, 3],
        verified(['REAR_RIGHT', 'FRONT_RIGHT', 'REAR_LEFT', 'FRONT_LEFT']),
      ),
    ).toEqual({ kind: 'READY', values: [0, 1, 2, 3] });
  });

  it('maps expected logical positions onto the physical resources observed', () => {
    expect(
      deriveMotorOutputOrder(
        [6, 4, 2, 0],
        verified(['FRONT_LEFT', 'REAR_LEFT', 'FRONT_RIGHT', 'REAR_RIGHT']),
      ),
    ).toEqual({ kind: 'READY', values: [0, 2, 4, 6] });
  });

  it('refuses incomplete and duplicate physical evidence', () => {
    const incomplete = verified([
      'REAR_RIGHT',
      'FRONT_RIGHT',
      'REAR_LEFT',
      'FRONT_LEFT',
    ]);
    const entries = [...incomplete.entries];
    entries[0] = Object.freeze({
      motorNumber: 1,
      outcome: 'UNTESTED' as const,
      observation: undefined,
      attemptId: undefined,
    });
    expect(
      deriveMotorOutputOrder([0, 1, 2, 3], {
        ...incomplete,
        entries,
      }),
    ).toEqual({ kind: 'INCOMPLETE', reason: 'MISSING_OBSERVATION' });
    expect(
      deriveMotorOutputOrder(
        [0, 1, 2, 3],
        verified(['REAR_RIGHT', 'REAR_RIGHT', 'REAR_LEFT', 'FRONT_LEFT']),
      ),
    ).toEqual({ kind: 'INCOMPLETE', reason: 'DUPLICATE_POSITION' });
  });
});
