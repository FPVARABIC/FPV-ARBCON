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
        | 'DUPLICATE_POSITION'
        | 'NOT_A_PERMUTATION';
    };

/** How many outputs the visual Quad-X observation covers. */
const OBSERVED_OUTPUT_COUNT = MOTOR_TEST_EXPECTED_CONFIGURATION.length;

/**
 * Derives the same mapping relationship used by Betaflight Configurator's
 * reorder wizard, but from this app's already-attributed visual
 * observations. `currentOrder[slot]` names the physical timer resource
 * currently driven by that logical slot. The result selects, for each
 * expected Quad-X position, the resource whose test was observed there.
 *
 * TWO FIRMWARE FACTS THIS FUNCTION EXISTS TO RESPECT, both read at the
 * pinned commit 79065c96ba0bb5cdc675e67d7093e05dab8b330e and both
 * previously got wrong here.
 *
 * 1. THE FC REPORTS `MAX_SUPPORTED_MOTORS`, NOT `motorCount`.
 *    `MSP2_MOTOR_OUTPUT_REORDERING` writes `MAX_SUPPORTED_MOTORS` as its
 *    count (msp.c:1283) and that constant is 8 on most targets and 4 only
 *    on the small ones (common_defaults_post.h:347/351). The earlier
 *    version required `currentOrder.length === 4` exactly, so on an
 *    ordinary 8-output target the derivation returned WRONG_OUTPUT_COUNT
 *    and the operator - who HAD completed all four observations - was
 *    told to go and complete them. The feature was unreachable on that
 *    hardware and the error message blamed the person using it.
 *
 * 2. A SHORT WRITE SILENTLY RESETS THE TAIL.
 *    `MSP2_SET_MOTOR_OUTPUT_REORDERING` reads an array size and then
 *    fills EVERY index up to `MAX_SUPPORTED_MOTORS`, taking `value = i`
 *    for every index at or beyond that size (msp.c:3559-3567). Writing
 *    the four observed outputs alone therefore rewrites outputs 5..8 to
 *    identity and destroys any mapping the operator had there - a
 *    destructive edit to outputs this workflow never looked at, reported
 *    as success. The full-length result below is what prevents it: the
 *    tail is carried through EXACTLY as the flight controller reported it.
 *
 * The result is always the same length as `currentOrder`, and is verified
 * to be a permutation of it before it is returned - PART J's "every motor
 * index appears exactly once, validated before I/O", enforced here rather
 * than hoped for at the encoder.
 */
export function deriveMotorOutputOrder(
  currentOrder: readonly number[],
  verification: MotorVerificationState,
): MotorOutputReorderDerivation {
  if (
    currentOrder.length < OBSERVED_OUTPUT_COUNT ||
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
  // Outputs the visual workflow never observed are carried through
  // unchanged. See firmware fact (2): omitting them is not "leaving them
  // alone", it is resetting them.
  for (let index = OBSERVED_OUTPUT_COUNT; index < currentOrder.length; index++) {
    values.push(currentOrder[index]);
  }

  // BEFORE ANY I/O: the result must be a rearrangement of what the flight
  // controller reported - same members, same count, no duplicate, nothing
  // dropped. A malformed observation set cannot reach the wire.
  if (
    values.length !== currentOrder.length ||
    new Set(values).size !== values.length ||
    !values.every(value => currentOrder.includes(value))
  ) {
    return { kind: 'INCOMPLETE', reason: 'NOT_A_PERMUTATION' };
  }

  return { kind: 'READY', values: Object.freeze(values) };
}
