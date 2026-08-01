import {
  MOTOR_TEST_EXPECTED_CONFIGURATION,
  type MotorPhysicalPosition,
  type MotorVerificationState,
} from './motorVerificationModel';

export type MotorOutputReorderDerivation =
  | { readonly kind: 'READY'; readonly values: readonly number[] }
  | {
      readonly kind: 'INCOMPLETE';
      readonly reason:
        | 'WRONG_OUTPUT_COUNT'
        | 'MISSING_OBSERVATION'
        | 'DUPLICATE_POSITION';
    };

/**
 * Derives the same mapping relationship used by Betaflight Configurator's
 * reorder wizard, but from this app's already-attributed visual observations.
 * `currentOrder[slot]` names the physical timer resource currently driven by
 * that logical slot. The result selects, for each expected Quad-X position,
 * the resource whose test was observed at that position.
 */
export function deriveMotorOutputOrder(
  currentOrder: readonly number[],
  verification: MotorVerificationState,
): MotorOutputReorderDerivation {
  if (
    currentOrder.length !== MOTOR_TEST_EXPECTED_CONFIGURATION.length ||
    new Set(currentOrder).size !== currentOrder.length
  ) {
    return { kind: 'INCOMPLETE', reason: 'WRONG_OUTPUT_COUNT' };
  }

  const slotForPosition = new Map<MotorPhysicalPosition, number>();
  for (const entry of verification.entries) {
    if (entry.observation?.kind !== 'OBSERVED') {
      return { kind: 'INCOMPLETE', reason: 'MISSING_OBSERVATION' };
    }
    if (slotForPosition.has(entry.observation.position)) {
      return { kind: 'INCOMPLETE', reason: 'DUPLICATE_POSITION' };
    }
    slotForPosition.set(entry.observation.position, entry.motorNumber);
  }

  const values: number[] = [];
  for (const expected of MOTOR_TEST_EXPECTED_CONFIGURATION) {
    const observedSlot = slotForPosition.get(expected.position);
    if (observedSlot === undefined) {
      return { kind: 'INCOMPLETE', reason: 'MISSING_OBSERVATION' };
    }
    values.push(currentOrder[observedSlot - 1]);
  }
  return { kind: 'READY', values: Object.freeze(values) };
}
