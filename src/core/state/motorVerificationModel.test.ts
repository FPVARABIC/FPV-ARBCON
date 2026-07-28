/**
 * Phase 2I - tests for the pure verification/result model.
 *
 * NO HARDWARE. No USB, no flight controller, no ESC, no LiPo, no motor.
 * This module is pure data and total functions; it cannot reach any of
 * them, and a containment test proves it.
 */

import {readFileSync} from 'fs';
import {join} from 'path';

import {
  abortVerificationAsUnsafe,
  beginVerification,
  classifyObservation,
  confirmObservation,
  confirmedCount,
  deriveOverall,
  EMPTY_VERIFICATION_STATE,
  expectedFor,
  finalizeVerification,
  MOTOR_TEST_EXPECTED_CONFIGURATION,
  type MotorObservation,
  type MotorPhysicalPosition,
  type MotorRotationDirection,
  type MotorVerificationState,
} from './motorVerificationModel';
import type {MotorTestVerificationReceipt} from './motorTestController';

const SESSION = {};
const OTHER_SESSION = {};

function receiptFor(
  motorNumber: number,
  attemptId = motorNumber,
  sessionToken: object = SESSION,
): MotorTestVerificationReceipt {
  return Object.freeze({
    sessionToken,
    attemptId,
    motorNumber,
    stopEpisodeId: attemptId,
    pulseAcknowledged: true as const,
    stopAcknowledged: true as const,
    attributionAmbiguous: false as const,
    stopUnsafe: false as const,
    physicalStopConfirmed: false as const,
  });
}

function observed(
  position: MotorPhysicalPosition,
  direction: MotorRotationDirection,
): MotorObservation {
  return {kind: 'OBSERVED', position, direction};
}

function accept(
  state: MotorVerificationState,
  motorNumber: number,
  observation: MotorObservation,
  attemptId = motorNumber,
): MotorVerificationState {
  const result = confirmObservation(
    state,
    receiptFor(motorNumber, attemptId),
    observation,
  );
  if (result.kind !== 'ACCEPTED') {
    throw new Error(`expected ACCEPTED, got ${result.reason}`);
  }
  return result.state;
}

/** All four outputs observed exactly as expected, on distinct attempts. */
function fullyMatching(): MotorVerificationState {
  let state = beginVerification(SESSION);
  for (const entry of MOTOR_TEST_EXPECTED_CONFIGURATION) {
    state = accept(
      state,
      entry.motorNumber,
      observed(entry.position, entry.direction),
    );
  }
  return state;
}

describe('Phase 2I - the expected configuration', () => {
  it('matches the accepted Betaflight Quad X / props-out reference', () => {
    expect(
      MOTOR_TEST_EXPECTED_CONFIGURATION.map(e => [
        e.motorNumber,
        e.position,
        e.direction,
      ]),
    ).toEqual([
      [1, 'REAR_RIGHT', 'CCW'],
      [2, 'FRONT_RIGHT', 'CW'],
      [3, 'REAR_LEFT', 'CW'],
      [4, 'FRONT_LEFT', 'CCW'],
    ]);
    // Four distinct outputs mapped to four distinct physical positions.
    expect(new Set(MOTOR_TEST_EXPECTED_CONFIGURATION.map(e => e.position)).size).toBe(4);
    expect(Object.isFrozen(MOTOR_TEST_EXPECTED_CONFIGURATION)).toBe(true);
    expect(expectedFor(9)).toBeUndefined();
  });
});

describe('Phase 2I - the receipt is the only way in', () => {
  it('rejects an observation before any verification session is bound', () => {
    const result = confirmObservation(
      EMPTY_VERIFICATION_STATE,
      receiptFor(1),
      observed('REAR_RIGHT', 'CCW'),
    );
    expect(result).toEqual({kind: 'REJECTED', reason: 'SESSION_MISMATCH'});
  });

  it('rejects a receipt minted under a different session', () => {
    const state = beginVerification(SESSION);
    // Value-identical in every field except the session anchor itself.
    const stale = receiptFor(1, 1, OTHER_SESSION);
    const result = confirmObservation(state, stale, observed('REAR_RIGHT', 'CCW'));
    expect(result).toEqual({kind: 'REJECTED', reason: 'SESSION_MISMATCH'});
  });

  it('attaches the observation ONLY to the receipt’s own output and attempt', () => {
    const state = accept(beginVerification(SESSION), 3, observed('REAR_LEFT', 'CW'), 42);
    const entry = state.entries.find(e => e.motorNumber === 3);
    expect(entry).toMatchObject({outcome: 'MATCH', attemptId: 42});
    // No other output was touched.
    for (const other of [1, 2, 4]) {
      expect(state.entries.find(e => e.motorNumber === other)).toMatchObject({
        outcome: 'UNTESTED',
        observation: undefined,
        attemptId: undefined,
      });
    }
  });

  it('refuses an output outside the supported four', () => {
    const state = beginVerification(SESSION);
    expect(confirmObservation(state, receiptFor(5), observed('FRONT_LEFT', 'CW'))).toEqual({
      kind: 'REJECTED',
      reason: 'UNSUPPORTED_OUTPUT',
    });
  });
});

describe('Phase 2I - classification', () => {
  it('matches only when BOTH position and direction match', () => {
    expect(classifyObservation(1, observed('REAR_RIGHT', 'CCW'))).toBe('MATCH');
  });

  it('classifies a position mismatch', () => {
    expect(classifyObservation(1, observed('FRONT_LEFT', 'CCW'))).toBe(
      'POSITION_MISMATCH',
    );
  });

  it('classifies a direction mismatch', () => {
    expect(classifyObservation(1, observed('REAR_RIGHT', 'CW'))).toBe(
      'DIRECTION_MISMATCH',
    );
  });

  it('classifies a combined mismatch', () => {
    expect(classifyObservation(1, observed('FRONT_LEFT', 'CW'))).toBe(
      'POSITION_AND_DIRECTION_MISMATCH',
    );
  });

  it('classifies the explicit exceptional results', () => {
    expect(classifyObservation(1, {kind: 'NO_MOVEMENT'})).toBe('NO_MOVEMENT');
    expect(classifyObservation(1, {kind: 'MULTIPLE_MOTORS'})).toBe('MULTIPLE_MOTORS');
    // "Unable to determine" is INCOMPLETE, never matching.
    expect(classifyObservation(1, {kind: 'POSITION_UNCERTAIN'})).toBe('UNCERTAIN');
    expect(classifyObservation(1, {kind: 'DIRECTION_UNCERTAIN'})).toBe('UNCERTAIN');
  });
});

describe('Phase 2I - immutability after confirmation', () => {
  it('refuses a second observation for an already-confirmed output', () => {
    const state = accept(beginVerification(SESSION), 1, observed('FRONT_LEFT', 'CW'));
    // A later, "corrected" observation must NOT silently erase the
    // recorded contradiction.
    const second = confirmObservation(state, receiptFor(1), observed('REAR_RIGHT', 'CCW'));
    expect(second).toEqual({kind: 'REJECTED', reason: 'ALREADY_CONFIRMED'});
    expect(state.entries.find(e => e.motorNumber === 1)?.outcome).toBe(
      'POSITION_AND_DIRECTION_MISMATCH',
    );
    expect(deriveOverall(state)).toBe('MISMATCH_DETECTED');
  });

  it('refuses every mutation once finalized', () => {
    const state = finalizeVerification(beginVerification(SESSION));
    expect(confirmObservation(state, receiptFor(1), observed('REAR_RIGHT', 'CCW'))).toEqual(
      {kind: 'REJECTED', reason: 'FINALIZED'},
    );
    expect(Object.isFrozen(state)).toBe(true);
  });

  it('refuses every further observation once aborted', () => {
    const state = accept(beginVerification(SESSION), 1, {kind: 'MULTIPLE_MOTORS'});
    expect(state.aborted).toBe(true);
    expect(confirmObservation(state, receiptFor(2), observed('FRONT_RIGHT', 'CW'))).toEqual(
      {kind: 'REJECTED', reason: 'ABORTED'},
    );
  });
});

describe('Phase 2I - overall priority', () => {
  it('ranks unsafe/aborted above everything, including a mismatch', () => {
    let state = accept(beginVerification(SESSION), 1, observed('FRONT_LEFT', 'CW'));
    expect(deriveOverall(state)).toBe('MISMATCH_DETECTED');
    state = abortVerificationAsUnsafe(state);
    expect(deriveOverall(state)).toBe('UNSAFE_ABORTED');
  });

  it('ranks a mismatch above incomplete', () => {
    const state = accept(beginVerification(SESSION), 1, observed('FRONT_LEFT', 'CCW'));
    // Three outputs are still UNTESTED, yet the known contradiction wins.
    expect(confirmedCount(state)).toBe(1);
    expect(deriveOverall(state)).toBe('MISMATCH_DETECTED');
  });

  it('treats "unable to determine" as incomplete, never matching', () => {
    let state = beginVerification(SESSION);
    state = accept(state, 1, {kind: 'POSITION_UNCERTAIN'});
    for (const entry of MOTOR_TEST_EXPECTED_CONFIGURATION.slice(1)) {
      state = accept(state, entry.motorNumber, observed(entry.position, entry.direction));
    }
    expect(deriveOverall(state)).toBe('INCOMPLETE');
  });

  it('reports the qualified user-observation result only for four distinct matches', () => {
    const state = fullyMatching();
    expect(deriveOverall(state)).toBe('OBSERVATIONS_MATCH_EXPECTED');
    expect(confirmedCount(state)).toBe(4);
  });

  it('refuses to call duplicate observed positions a match', () => {
    // Every entry classifies as MATCH only if it equals its OWN
    // expectation, so a genuine duplicate requires two outputs whose
    // expectations differ - hence this constructs the duplicate directly.
    const state: MotorVerificationState = Object.freeze({
      sessionToken: SESSION,
      finalized: false,
      aborted: false,
      entries: Object.freeze(
        MOTOR_TEST_EXPECTED_CONFIGURATION.map((entry, index) =>
          Object.freeze({
            motorNumber: entry.motorNumber,
            outcome: 'MATCH' as const,
            // Two outputs reported at the SAME physical position - which a
            // single motor cannot be.
            observation: observed(
              index === 0 ? 'FRONT_LEFT' : entry.position,
              entry.direction,
            ),
            attemptId: entry.motorNumber,
          }),
        ),
      ),
    });
    expect(deriveOverall(state)).toBe('MISMATCH_DETECTED');
  });

  it('refuses to call repeated attempts a match', () => {
    const state: MotorVerificationState = Object.freeze({
      sessionToken: SESSION,
      finalized: false,
      aborted: false,
      entries: Object.freeze(
        MOTOR_TEST_EXPECTED_CONFIGURATION.map(entry =>
          Object.freeze({
            motorNumber: entry.motorNumber,
            outcome: 'MATCH' as const,
            observation: observed(entry.position, entry.direction),
            // Every entry claiming the SAME attempt - one pulse cannot
            // have produced four separate observations.
            attemptId: 7,
          }),
        ),
      ),
    });
    expect(deriveOverall(state)).toBe('INCOMPLETE');
  });
});

describe('Phase 2I - session binding and volatility', () => {
  it('starts empty and clears for a genuinely new session', () => {
    const first = fullyMatching();
    expect(deriveOverall(first)).toBe('OBSERVATIONS_MATCH_EXPECTED');
    const second = beginVerification(OTHER_SESSION);
    // Nothing carries across.
    expect(second.entries.every(e => e.outcome === 'UNTESTED')).toBe(true);
    expect(deriveOverall(second)).toBe('INCOMPLETE');
    expect(second.sessionToken).toBe(OTHER_SESSION);
  });

  it('marks every unobserved output unsafe when software evidence fails', () => {
    let state = accept(beginVerification(SESSION), 1, observed('REAR_RIGHT', 'CCW'));
    state = abortVerificationAsUnsafe(state);
    // The confirmed observation is retained; the rest become unsafe, not
    // "not finished yet".
    expect(state.entries.find(e => e.motorNumber === 1)?.outcome).toBe('MATCH');
    for (const other of [2, 3, 4]) {
      expect(state.entries.find(e => e.motorNumber === other)?.outcome).toBe(
        'UNSAFE_OR_AMBIGUOUS',
      );
    }
    expect(deriveOverall(state)).toBe('UNSAFE_ABORTED');
  });
});

describe('Phase 2I - model containment', () => {
  const executable = readFileSync(
    join(__dirname, 'motorVerificationModel.ts'),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  it('names no command, magnitude, encoder, transport or timer', () => {
    for (const forbidden of [
      'writeBytes',
      'MSP_SET_MOTOR',
      'encodeSetMotorPayload',
      'buildSingleMotorVector',
      'pulseMotor',
      'requestStop',
      'MspClient',
      'setTimeout',
      'setInterval',
      'AsyncStorage',
      'fetch(',
    ]) {
      expect(executable).not.toContain(forbidden);
    }
    expect(executable).not.toMatch(/\b214\b/);
    expect(executable).not.toMatch(/\b1050\b/);
    expect(executable).not.toMatch(/\b1000\b/);
  });

  it('makes no rpm, temperature, physical-stop or safe-to-fly claim', () => {
    for (const forbidden of ['rpm', 'temperature', 'physicalStopConfirmed: true', 'safeToFly']) {
      expect(executable.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('persists, exports and shares nothing', () => {
    for (const forbidden of ['localStorage', 'AsyncStorage', 'Share', 'upload', 'writeFile']) {
      expect(executable).not.toContain(forbidden);
    }
  });
});
