/**
 * Phase 2I - the PURE verification/result model.
 *
 * WHAT THIS MODULE IS. Data and total functions. It holds the accepted
 * expected configuration, the shape of one user observation, the
 * classification rules, and the overall report derivation. It is
 * deliberately in `src/core`, with no React, no navigation, no timers, no
 * I/O and no controller import: it cannot start, stop, encode or transmit
 * anything, and a test asserts that.
 *
 * THE THREE EVIDENCE SOURCES ARE KEPT SEPARATE, BY TYPE:
 *   1. EXPECTED       - MOTOR_TEST_EXPECTED_CONFIGURATION below. The
 *                       accepted Betaflight Quad X / props-out reference.
 *   2. SOFTWARE       - a MotorTestVerificationReceipt, minted only by the
 *                       controller. It proves the FC acknowledged a
 *                       command and an attributable software stop.
 *   3. PHYSICAL       - a MotorObservation. What a person saw with their
 *                       own eyes. Nothing in this repository can measure
 *                       it, and nothing here pretends to.
 *
 * WHAT SOFTWARE EVIDENCE NEVER MEANS. An acknowledgement is reception and
 * processing of a command. It is never proof that a motor rotated, that
 * the EXPECTED motor rotated, that the direction was right, that anything
 * mechanically stopped, or that the aircraft is safe to arm or fly. Even a
 * fully matching report says only that the OBSERVATIONS matched the
 * expected configuration.
 */

import type {MotorTestVerificationReceipt} from './motorTestController';

/* ------------------------------------------------------------------ *
 * Expected configuration - source (1)
 * ------------------------------------------------------------------ */

/** Physical airframe positions, viewed from above. */
export type MotorPhysicalPosition =
  | 'FRONT_LEFT'
  | 'FRONT_RIGHT'
  | 'REAR_LEFT'
  | 'REAR_RIGHT';

/** Rotation direction, viewed from above. */
export type MotorRotationDirection = 'CW' | 'CCW';

export interface MotorExpectedMapping {
  /** MSP OUTPUT SLOT, 1..4. */
  readonly motorNumber: number;
  readonly position: MotorPhysicalPosition;
  readonly direction: MotorRotationDirection;
}

/**
 * The accepted Betaflight Quad X / props-out reference for the approved
 * catalog profile.
 *
 * THIS IS THE EXPECTATION, NOT A RESULT. No software in this repository
 * has confirmed any of it - not the wiring, not the frame position, not
 * the rotation direction. Confirming it is precisely what the user's own
 * physical observation is for.
 */
export const MOTOR_TEST_EXPECTED_CONFIGURATION: readonly MotorExpectedMapping[] =
  Object.freeze([
    Object.freeze({motorNumber: 1, position: 'REAR_RIGHT' as const, direction: 'CCW' as const}),
    Object.freeze({motorNumber: 2, position: 'FRONT_RIGHT' as const, direction: 'CW' as const}),
    Object.freeze({motorNumber: 3, position: 'REAR_LEFT' as const, direction: 'CW' as const}),
    Object.freeze({motorNumber: 4, position: 'FRONT_LEFT' as const, direction: 'CCW' as const}),
  ]);

export function expectedFor(
  motorNumber: number,
): MotorExpectedMapping | undefined {
  return MOTOR_TEST_EXPECTED_CONFIGURATION.find(
    entry => entry.motorNumber === motorNumber,
  );
}

/* ------------------------------------------------------------------ *
 * Physical observation - source (3)
 * ------------------------------------------------------------------ */

/**
 * One deliberate user observation, or one explicit exceptional result.
 *
 * The exceptional variants are NOT failures to answer - they are answers.
 * Forcing a position/direction choice when the user genuinely could not
 * tell would manufacture evidence that does not exist.
 */
export type MotorObservation =
  | {
      readonly kind: 'OBSERVED';
      readonly position: MotorPhysicalPosition;
      readonly direction: MotorRotationDirection;
    }
  | {readonly kind: 'NO_MOVEMENT'}
  | {readonly kind: 'MULTIPLE_MOTORS'}
  | {readonly kind: 'POSITION_UNCERTAIN'}
  | {readonly kind: 'DIRECTION_UNCERTAIN'};

/* ------------------------------------------------------------------ *
 * Per-output result - the comparison of (1) against (3), given (2)
 * ------------------------------------------------------------------ */

export type MotorVerificationOutcome =
  /** Observed position AND direction both match the expectation. */
  | 'MATCH'
  | 'POSITION_MISMATCH'
  | 'DIRECTION_MISMATCH'
  | 'POSITION_AND_DIRECTION_MISMATCH'
  /** The user saw nothing move. */
  | 'NO_MOVEMENT'
  /** The user saw more than one motor move - a wiring/config fault that
   * ends the whole verification. */
  | 'MULTIPLE_MOTORS'
  /** The user could not determine position or direction. Incomplete, and
   * deliberately NOT a match. */
  | 'UNCERTAIN'
  /** No confirmed observation exists for this output yet. */
  | 'UNTESTED'
  /** Software evidence was unsafe or ambiguous, so no observation for
   * this output can mean anything. */
  | 'UNSAFE_OR_AMBIGUOUS';

export interface MotorVerificationEntry {
  readonly motorNumber: number;
  readonly outcome: MotorVerificationOutcome;
  /** The confirmed observation, when one exists. */
  readonly observation: MotorObservation | undefined;
  /** The exact attempt the observation was attached to. Undefined only
   * for UNTESTED. An entry can never be re-attributed to another attempt. */
  readonly attemptId: number | undefined;
}

/**
 * Classifies ONE output. Total, pure, and deliberately conservative:
 * every path that is not an unambiguous match returns something that is
 * not `MATCH`.
 */
export function classifyObservation(
  motorNumber: number,
  observation: MotorObservation,
): MotorVerificationOutcome {
  switch (observation.kind) {
    case 'NO_MOVEMENT':
      return 'NO_MOVEMENT';
    case 'MULTIPLE_MOTORS':
      return 'MULTIPLE_MOTORS';
    case 'POSITION_UNCERTAIN':
    case 'DIRECTION_UNCERTAIN':
      // "Unable to determine" is INCOMPLETE, never matching.
      return 'UNCERTAIN';
    case 'OBSERVED': {
      const expected = expectedFor(motorNumber);
      if (expected === undefined) {
        // An output outside the supported four cannot be compared at all.
        return 'UNCERTAIN';
      }
      const positionOk = observation.position === expected.position;
      const directionOk = observation.direction === expected.direction;
      if (positionOk && directionOk) {
        return 'MATCH';
      }
      if (!positionOk && !directionOk) {
        return 'POSITION_AND_DIRECTION_MISMATCH';
      }
      return positionOk ? 'DIRECTION_MISMATCH' : 'POSITION_MISMATCH';
    }
    default: {
      const exhaustive: never = observation;
      return exhaustive;
    }
  }
}

/* ------------------------------------------------------------------ *
 * The session-bound, volatile verification state
 * ------------------------------------------------------------------ */

export type MotorVerificationOverall =
  /** Software evidence was unsafe/ambiguous, or the user reported more
   * than one motor moving. Highest priority - it outranks everything. */
  | 'UNSAFE_ABORTED'
  /** At least one confirmed contradiction. */
  | 'MISMATCH_DETECTED'
  /** Not every output has a confirmed, determinate observation. */
  | 'INCOMPLETE'
  /** All four observations matched the expected configuration. This is a
   * statement about the USER'S OBSERVATIONS and nothing else. */
  | 'OBSERVATIONS_MATCH_EXPECTED';

export interface MotorVerificationState {
  /**
   * The session this data belongs to, by REFERENCE. Volatile and
   * memory-only: it is never persisted, exported, uploaded or shared, and
   * a genuinely new session starts from `EMPTY_VERIFICATION_STATE`.
   */
  readonly sessionToken: object | undefined;
  readonly entries: readonly MotorVerificationEntry[];
  /** True once the report has been finalized. No further mutation is
   * accepted after this. */
  readonly finalized: boolean;
  /** Set when the user reported more than one motor moving, or when
   * software evidence was unsafe. Verification stops. */
  readonly aborted: boolean;
}

function untestedEntries(): readonly MotorVerificationEntry[] {
  return Object.freeze(
    MOTOR_TEST_EXPECTED_CONFIGURATION.map(entry =>
      Object.freeze({
        motorNumber: entry.motorNumber,
        outcome: 'UNTESTED' as const,
        observation: undefined,
        attemptId: undefined,
      }),
    ),
  );
}

export const EMPTY_VERIFICATION_STATE: MotorVerificationState = Object.freeze({
  sessionToken: undefined,
  entries: untestedEntries(),
  finalized: false,
  aborted: false,
});

/** Starts (or restarts) verification for one exact session. */
export function beginVerification(sessionToken: object): MotorVerificationState {
  return Object.freeze({
    sessionToken,
    entries: untestedEntries(),
    finalized: false,
    aborted: false,
  });
}

export type MotorVerificationRejection =
  /** The receipt belongs to a different session, or none is bound. */
  | 'SESSION_MISMATCH'
  /** The report is finalized; it is read-only. */
  | 'FINALIZED'
  /** Verification was aborted; no further observation is accepted. */
  | 'ABORTED'
  /** This output already has a CONFIRMED observation. */
  | 'ALREADY_CONFIRMED'
  /** The receipt names an output outside the supported four. */
  | 'UNSUPPORTED_OUTPUT';

export type MotorVerificationResult =
  | {readonly kind: 'ACCEPTED'; readonly state: MotorVerificationState}
  | {readonly kind: 'REJECTED'; readonly reason: MotorVerificationRejection};

/**
 * Confirms ONE observation against ONE receipt.
 *
 * The receipt is the ONLY way in. An observation can never be recorded
 * from a selected card, a rendered value, a local variable or a bare
 * acknowledgement - only from a receipt the controller itself minted,
 * which names the exact session, attempt and output.
 *
 * Confirmation is immutable: a confirmed entry is never overwritten, so a
 * later observation cannot silently erase an earlier contradiction.
 */
export function confirmObservation(
  state: MotorVerificationState,
  receipt: MotorTestVerificationReceipt,
  observation: MotorObservation,
): MotorVerificationResult {
  if (state.finalized) {
    return {kind: 'REJECTED', reason: 'FINALIZED'};
  }
  if (state.aborted) {
    return {kind: 'REJECTED', reason: 'ABORTED'};
  }
  // Reference identity. A stale receipt from a replaced session cannot
  // open or confirm anything here.
  if (
    state.sessionToken === undefined ||
    state.sessionToken !== receipt.sessionToken
  ) {
    return {kind: 'REJECTED', reason: 'SESSION_MISMATCH'};
  }
  const index = state.entries.findIndex(
    entry => entry.motorNumber === receipt.motorNumber,
  );
  if (index < 0) {
    return {kind: 'REJECTED', reason: 'UNSUPPORTED_OUTPUT'};
  }
  if (state.entries[index].outcome !== 'UNTESTED') {
    return {kind: 'REJECTED', reason: 'ALREADY_CONFIRMED'};
  }

  const outcome = classifyObservation(receipt.motorNumber, observation);
  const entries = state.entries.map((entry, position) =>
    position === index
      ? Object.freeze({
          motorNumber: entry.motorNumber,
          outcome,
          observation,
          // Bound to THE receipt's attempt, permanently.
          attemptId: receipt.attemptId,
        })
      : entry,
  );

  return {
    kind: 'ACCEPTED',
    state: Object.freeze({
      sessionToken: state.sessionToken,
      entries: Object.freeze(entries),
      finalized: false,
      // A multiple-motor observation ends verification immediately.
      aborted: outcome === 'MULTIPLE_MOTORS',
    }),
  };
}

/**
 * WITHDRAWS ONE CONFIRMED OBSERVATION, DELIBERATELY.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A WEAKENING. Confirmation is
 * immutable so that a later observation cannot silently erase an earlier
 * contradiction - `confirmObservation` rejects ALREADY_CONFIRMED for
 * exactly that reason, and that rule is untouched. What was missing was a
 * way for a person who mis-tapped to say so OUT LOUD. Without one, the
 * only escape was to end the session, and a workflow whose only correction
 * path is "start again" is a workflow operators work around.
 *
 * This is the narrowest transition that helps: it names ONE output, it
 * returns that output to UNTESTED, and it touches nothing else. It cannot
 * write an observation, cannot change another entry, cannot unfinalize a
 * report, cannot revive an aborted verification, and - being a pure
 * function over state - cannot reach a flight controller, a mixer, an
 * output mapping, a direction command or a motor.
 *
 * WHAT IT IS NOT. It is not an undo of evidence in the sense of hiding a
 * problem: clearing MULTIPLE_MOTORS is impossible because that outcome
 * aborts the whole verification, and an aborted or finalized state is
 * refused outright.
 */
export function clearObservation(
  state: MotorVerificationState,
  motorNumber: number,
): MotorVerificationResult {
  if (state.finalized) {
    return {kind: 'REJECTED', reason: 'FINALIZED'};
  }
  // An aborted verification is not corrected by editing one row. The
  // session itself is the thing that has to be restarted.
  if (state.aborted) {
    return {kind: 'REJECTED', reason: 'ABORTED'};
  }
  if (state.sessionToken === undefined) {
    return {kind: 'REJECTED', reason: 'SESSION_MISMATCH'};
  }
  const index = state.entries.findIndex(
    entry => entry.motorNumber === motorNumber,
  );
  if (index < 0) {
    return {kind: 'REJECTED', reason: 'UNSUPPORTED_OUTPUT'};
  }
  if (state.entries[index].outcome === 'UNTESTED') {
    // Nothing to withdraw. Reported rather than treated as success, so a
    // caller cannot mistake "already empty" for "just cleared".
    return {kind: 'REJECTED', reason: 'ALREADY_CONFIRMED'};
  }

  const entries = state.entries.map((entry, position) =>
    position === index
      ? Object.freeze({
          motorNumber: entry.motorNumber,
          outcome: 'UNTESTED' as const,
          observation: undefined,
          // The attempt binding goes with the observation. A cleared entry
          // must not keep pointing at a pulse it no longer describes.
          attemptId: undefined,
        })
      : entry,
  );

  return {
    kind: 'ACCEPTED',
    state: Object.freeze({
      sessionToken: state.sessionToken,
      entries: Object.freeze(entries),
      finalized: false,
      aborted: false,
    }),
  };
}

/** One physical position claimed by more than one logical motor. */
export interface MotorPositionConflict {
  readonly position: MotorPhysicalPosition;
  /** Every logical motor confirmed at that position, in ascending order. */
  readonly motorNumbers: readonly number[];
}

/**
 * Reports duplicate observed positions so the UI can name them.
 *
 * `deriveOverall` already refuses to call a duplicated set a match, and
 * `deriveMotorOutputOrder` already refuses to derive a mapping from one.
 * Neither can say WHICH motors collide, and "there is a mismatch
 * somewhere" is not something a person standing next to an aircraft can
 * act on. This adds no rule - it reads the same entries and reports what
 * is already true.
 */
export function findPositionConflicts(
  state: MotorVerificationState,
): readonly MotorPositionConflict[] {
  const byPosition = new Map<MotorPhysicalPosition, number[]>();
  for (const entry of state.entries) {
    if (entry.observation?.kind !== 'OBSERVED') {
      continue;
    }
    const existing = byPosition.get(entry.observation.position);
    if (existing === undefined) {
      byPosition.set(entry.observation.position, [entry.motorNumber]);
    } else {
      existing.push(entry.motorNumber);
    }
  }
  const conflicts: MotorPositionConflict[] = [];
  for (const [position, motorNumbers] of byPosition) {
    if (motorNumbers.length > 1) {
      conflicts.push(
        Object.freeze({
          position,
          motorNumbers: Object.freeze([...motorNumbers].sort((a, b) => a - b)),
        }),
      );
    }
  }
  return Object.freeze(conflicts);
}

/**
 * Marks verification unsafe. Used when software evidence itself failed -
 * an unsafe or ambiguous stop, a fault, a detach or a session
 * replacement. Never derived from a user observation other than
 * MULTIPLE_MOTORS, which has its own path above.
 */
export function abortVerificationAsUnsafe(
  state: MotorVerificationState,
): MotorVerificationState {
  return Object.freeze({
    sessionToken: state.sessionToken,
    entries: Object.freeze(
      state.entries.map(entry =>
        entry.outcome === 'UNTESTED'
          ? Object.freeze({
              motorNumber: entry.motorNumber,
              outcome: 'UNSAFE_OR_AMBIGUOUS' as const,
              observation: undefined,
              attemptId: undefined,
            })
          : entry,
      ),
    ),
    finalized: state.finalized,
    aborted: true,
  });
}

/** Freezes the report. After this nothing may be added or changed. */
export function finalizeVerification(
  state: MotorVerificationState,
): MotorVerificationState {
  return Object.freeze({
    sessionToken: state.sessionToken,
    entries: state.entries,
    finalized: true,
    aborted: state.aborted,
  });
}

/**
 * Derives the overall report state, in the required priority order.
 *
 * The one-to-one rule is load-bearing: four `MATCH` entries whose observed
 * positions are not four DISTINCT positions cannot be a match, because a
 * single physical motor cannot occupy two arms. Without this check, an
 * operator who mistakenly reported the same position twice would be shown
 * a matching report.
 */
export function deriveOverall(
  state: MotorVerificationState,
): MotorVerificationOverall {
  const outcomes = state.entries.map(entry => entry.outcome);

  // (1) Unsafe/aborted outranks everything, including a mismatch.
  if (
    state.aborted ||
    outcomes.includes('UNSAFE_OR_AMBIGUOUS') ||
    outcomes.includes('MULTIPLE_MOTORS')
  ) {
    return 'UNSAFE_ABORTED';
  }
  // (2) Any confirmed contradiction. Checked BEFORE completeness, so a
  //     known mismatch is never softened into "incomplete".
  if (
    outcomes.some(
      outcome =>
        outcome === 'POSITION_MISMATCH' ||
        outcome === 'DIRECTION_MISMATCH' ||
        outcome === 'POSITION_AND_DIRECTION_MISMATCH' ||
        outcome === 'NO_MOVEMENT',
    )
  ) {
    return 'MISMATCH_DETECTED';
  }
  // (3) Anything not yet determinately observed.
  if (outcomes.some(outcome => outcome === 'UNTESTED' || outcome === 'UNCERTAIN')) {
    return 'INCOMPLETE';
  }
  // (4) Every entry matched. Now the one-to-one check.
  const positions = state.entries
    .map(entry =>
      entry.observation?.kind === 'OBSERVED' ? entry.observation.position : undefined,
    )
    .filter((position): position is MotorPhysicalPosition => position !== undefined);
  if (positions.length !== state.entries.length) {
    return 'INCOMPLETE';
  }
  if (new Set(positions).size !== positions.length) {
    // Duplicate observed positions. Not a match, and not "complete".
    return 'MISMATCH_DETECTED';
  }
  // Every attempt must also be distinct - one pulse, one observation.
  const attempts = state.entries
    .map(entry => entry.attemptId)
    .filter((id): id is number => id !== undefined);
  if (
    attempts.length !== state.entries.length ||
    new Set(attempts).size !== attempts.length
  ) {
    return 'INCOMPLETE';
  }
  return 'OBSERVATIONS_MATCH_EXPECTED';
}

/** How many outputs have a confirmed observation, for progress display. */
export function confirmedCount(state: MotorVerificationState): number {
  return state.entries.filter(entry => entry.outcome !== 'UNTESTED').length;
}
