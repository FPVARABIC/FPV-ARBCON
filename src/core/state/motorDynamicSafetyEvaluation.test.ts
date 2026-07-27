/**
 * Pass 1E - tests for the pure, session-bound motor dynamic safety
 * requirements evaluation.
 *
 * NO HARDWARE OF ANY KIND is required, referenced or simulated: no flight
 * controller, no USB, no serial session, no MspClient, no MspRequester,
 * no transport, no ESC, no motor, no LiPo, no emulator, no timers, no
 * clock. Every input is an immutable hand-built fixture.
 *
 * `REQUIREMENTS_SATISFIED` IS NOT READINESS, SAFETY, AUTHORIZATION OR
 * PERMISSION TO PULSE ANYTHING. These tests deliberately assert that no
 * such verdict exists anywhere in the returned value.
 */

import {
  evaluateMotorDynamicSafetyRequirements,
  MOTOR_DYNAMIC_BLOCKING_REASON_ORDER,
  POLICY_MAX_VOLTAGE_CENTIVOLTS,
  POLICY_MIN_VOLTAGE_CENTIVOLTS,
  POLICY_REQUIRED_CELL_COUNT,
  type MotorDynamicSafetyBlockingReason,
  type MotorDynamicSafetyRequirementsEvaluation,
} from './motorDynamicSafetyEvaluation';
import type {
  MotorDynamicSafetyObservation,
  MotorDynamicSafetyObservationOutcome,
  MotorObservedArmedState,
  MotorObservedBatteryClassification,
} from './motorDynamicSafetyObservation';
import type {MotorStaticCompatibilityEvaluation} from './motorStaticCompatibility';
import type {MotorStaticFactsSessionIdentity} from './motorStaticFacts';
import type {ArmingBlockerBit} from './armingBlockers';

/* ------------------------------------------------------------------ *
 * Fixtures - every identity is INDEPENDENTLY ALLOCATED so equality can
 * only ever be established by scalar value, never by reference.
 * ------------------------------------------------------------------ */

function identity(
  physicalGeneration = 3,
  mspEpoch = 11,
): MotorStaticFactsSessionIdentity {
  return {physicalGeneration, mspEpoch};
}

function staticSupported(
  sessionIdentity: MotorStaticFactsSessionIdentity = identity(),
): MotorStaticCompatibilityEvaluation {
  return {
    kind: 'EVALUATED',
    compatibility: {
      sessionIdentity,
      status: 'SUPPORTED',
      checks: [],
      mismatchedCheckIds: [],
    },
  };
}

function staticUnsupported(
  sessionIdentity: MotorStaticFactsSessionIdentity = identity(),
): MotorStaticCompatibilityEvaluation {
  return {
    kind: 'EVALUATED',
    compatibility: {
      sessionIdentity,
      status: 'UNSUPPORTED',
      checks: [],
      mismatchedCheckIds: ['MOTOR_IDLE'],
    },
  };
}

interface ObservationFixture {
  readonly sessionIdentity?: MotorStaticFactsSessionIdentity;
  readonly armedState?: MotorObservedArmedState;
  readonly mspRestrictionPresent?: boolean;
  readonly rebootRequired?: boolean | null;
  readonly blockers?: readonly ArmingBlockerBit[];
  readonly cellCount?: number;
  readonly voltageCentivolts?: number;
  readonly classification?: MotorObservedBatteryClassification;
  readonly startedAtMonotonicMillis?: number;
  readonly completedAtMonotonicMillis?: number;
}

/** The canonical fully-satisfying observation: disarmed, MSP restriction
 * present, no reboot needed, 4S at 16.60 V, BATTERY_OK. */
function observation(fixture: ObservationFixture = {}): MotorDynamicSafetyObservation {
  const started = fixture.startedAtMonotonicMillis ?? 1000;
  const completed = fixture.completedAtMonotonicMillis ?? 1042;
  return {
    observationKind: 'DYNAMIC_OBSERVATION',
    sessionIdentity: fixture.sessionIdentity ?? identity(),
    armedState: fixture.armedState ?? 'DISARMED',
    armingRestrictions: {
      declaredFlagCount: 29,
      rawMask: 0,
      blockers: fixture.blockers ?? [],
      mspRestrictionPresent: fixture.mspRestrictionPresent ?? true,
      rebootRequired: fixture.rebootRequired === undefined ? false : fixture.rebootRequired,
    },
    battery: {
      cellCount: fixture.cellCount ?? 4,
      voltageCentivolts: fixture.voltageCentivolts ?? 1660,
      classification: fixture.classification ?? {kind: 'KNOWN', raw: 0, token: 'BATTERY_OK'},
    },
    observationWindow: {
      startedAtMonotonicMillis: started,
      completedAtMonotonicMillis: completed,
      durationMillis: completed - started,
    },
  };
}

function observed(fixture: ObservationFixture = {}): MotorDynamicSafetyObservationOutcome {
  return {kind: 'OBSERVED', observation: observation(fixture)};
}

function knownBlocker(bit: number, token: string): ArmingBlockerBit {
  return {kind: 'KNOWN', bit, token};
}

/** Evaluate against independently allocated but value-equal identities. */
function evaluate(
  overrides: {
    staticCompatibility?: MotorStaticCompatibilityEvaluation | undefined;
    dynamicObservation?: MotorDynamicSafetyObservationOutcome | undefined;
    currentSessionIdentity?: MotorStaticFactsSessionIdentity | undefined;
  } = {},
): MotorDynamicSafetyRequirementsEvaluation {
  return evaluateMotorDynamicSafetyRequirements({
    staticCompatibility:
      'staticCompatibility' in overrides ? overrides.staticCompatibility : staticSupported(),
    dynamicObservation:
      'dynamicObservation' in overrides ? overrides.dynamicObservation : observed(),
    currentSessionIdentity:
      'currentSessionIdentity' in overrides ? overrides.currentSessionIdentity : identity(),
  });
}

/** Evaluate a single observation fixture against the canonical happy
 * static/current inputs, returning the blocking reasons. */
function blockersFor(fixture: ObservationFixture): readonly MotorDynamicSafetyBlockingReason[] {
  const result = evaluate({dynamicObservation: observed(fixture)});
  if (result.kind !== 'EVALUATED') {
    throw new Error(`expected EVALUATED, got NOT_EVALUATED (${result.reason})`);
  }
  return result.blockingReasons;
}

function expectNotEvaluated(
  result: MotorDynamicSafetyRequirementsEvaluation,
  reason: string,
): void {
  expect(result.kind).toBe('NOT_EVALUATED');
  if (result.kind !== 'NOT_EVALUATED') {
    throw new Error('unreachable');
  }
  expect(result.reason).toBe(reason);
  // A prerequisite failure exposes NO condition data whatsoever.
  expect(Object.keys(result).sort()).toEqual(
    result.sourceObservationReason === undefined
      ? ['kind', 'reason']
      : ['kind', 'reason', 'sourceObservationReason'],
  );
}

/* ------------------------------------------------------------------ *
 * 9.1 Prerequisite behaviour
 * ------------------------------------------------------------------ */

describe('prerequisites', () => {
  it('evaluates when three independently allocated identities are value-equal', () => {
    const result = evaluateMotorDynamicSafetyRequirements({
      staticCompatibility: staticSupported(identity(7, 2)),
      dynamicObservation: observed({sessionIdentity: identity(7, 2)}),
      currentSessionIdentity: identity(7, 2),
    });
    expect(result.kind).toBe('EVALUATED');
    if (result.kind !== 'EVALUATED') {
      throw new Error('unreachable');
    }
    expect(result.status).toBe('REQUIREMENTS_SATISFIED');
    expect(result.sessionIdentity).toEqual({physicalGeneration: 7, mspEpoch: 2});
  });

  it('returns NOT_EVALUATED when the static result is missing', () => {
    expectNotEvaluated(
      evaluate({staticCompatibility: undefined}),
      'STATIC_COMPATIBILITY_NOT_EVALUATED',
    );
  });

  it('returns NOT_EVALUATED when the static result is NOT_EVALUATED', () => {
    expectNotEvaluated(
      evaluate({
        staticCompatibility: {kind: 'NOT_EVALUATED', reason: 'SESSION_IDENTITY_MISMATCH'},
      }),
      'STATIC_COMPATIBILITY_NOT_EVALUATED',
    );
  });

  it('returns NOT_EVALUATED - not a battery/arming failure - when static is UNSUPPORTED', () => {
    const result = evaluate({staticCompatibility: staticUnsupported()});
    expectNotEvaluated(result, 'STATIC_PROFILE_UNSUPPORTED');
  });

  it('returns NOT_EVALUATED when the dynamic observation is missing', () => {
    expectNotEvaluated(
      evaluate({dynamicObservation: undefined}),
      'DYNAMIC_OBSERVATION_NOT_AVAILABLE',
    );
  });

  it('preserves the Pass 1D reason as a copied scalar when it was NOT_OBSERVED', () => {
    const result = evaluate({
      dynamicObservation: {kind: 'NOT_OBSERVED', reason: 'ARMED_STATE_UNOBSERVABLE'},
    });
    expectNotEvaluated(result, 'DYNAMIC_OBSERVATION_NOT_AVAILABLE');
    if (result.kind !== 'NOT_EVALUATED') {
      throw new Error('unreachable');
    }
    expect(result.sourceObservationReason).toBe('ARMED_STATE_UNOBSERVABLE');
    expect(typeof result.sourceObservationReason).toBe('string');
  });

  it('does not retain the NOT_OBSERVED source result object', () => {
    const source: MotorDynamicSafetyObservationOutcome = {
      kind: 'NOT_OBSERVED',
      reason: 'REQUEST_FAILED',
    };
    const result = evaluate({dynamicObservation: source});
    for (const value of Object.values(result)) {
      expect(value).not.toBe(source);
    }
  });

  it('returns NOT_EVALUATED when no current identity is supplied', () => {
    expectNotEvaluated(
      evaluate({currentSessionIdentity: undefined}),
      'CURRENT_SESSION_IDENTITY_UNAVAILABLE',
    );
  });

  it('fails closed on a static physicalGeneration mismatch', () => {
    expectNotEvaluated(
      evaluate({staticCompatibility: staticSupported(identity(4, 11))}),
      'STATIC_BINDING_IDENTITY_MISMATCH',
    );
  });

  it('fails closed on a static mspEpoch mismatch', () => {
    expectNotEvaluated(
      evaluate({staticCompatibility: staticSupported(identity(3, 12))}),
      'STATIC_BINDING_IDENTITY_MISMATCH',
    );
  });

  it('fails closed on a dynamic physicalGeneration mismatch', () => {
    expectNotEvaluated(
      evaluate({dynamicObservation: observed({sessionIdentity: identity(4, 11)})}),
      'DYNAMIC_BINDING_IDENTITY_MISMATCH',
    );
  });

  it('fails closed on a dynamic mspEpoch mismatch', () => {
    expectNotEvaluated(
      evaluate({dynamicObservation: observed({sessionIdentity: identity(3, 12)})}),
      'DYNAMIC_BINDING_IDENTITY_MISMATCH',
    );
  });

  it('fails closed when the static and dynamic bindings disagree with each other', () => {
    expectNotEvaluated(
      evaluateMotorDynamicSafetyRequirements({
        staticCompatibility: staticSupported(identity(3, 11)),
        dynamicObservation: observed({sessionIdentity: identity(9, 9)}),
        currentSessionIdentity: identity(3, 11),
      }),
      'DYNAMIC_BINDING_IDENTITY_MISMATCH',
    );
  });

  it('fails closed when observation start is greater than completion', () => {
    expectNotEvaluated(
      evaluate({
        dynamicObservation: observed({
          startedAtMonotonicMillis: 2000,
          completedAtMonotonicMillis: 1999,
        }),
      }),
      'OBSERVATION_WINDOW_INVALID',
    );
  });

  it('accepts an equal start and completion as structurally valid', () => {
    const result = evaluate({
      dynamicObservation: observed({
        startedAtMonotonicMillis: 5000,
        completedAtMonotonicMillis: 5000,
      }),
    });
    expect(result.kind).toBe('EVALUATED');
    if (result.kind !== 'EVALUATED') {
      throw new Error('unreachable');
    }
    expect(result.observationWindow).toEqual({
      startedAtMonotonicMillis: 5000,
      completedAtMonotonicMillis: 5000,
      durationMillis: 0,
    });
  });

  it('fails closed on a non-integer observation window', () => {
    const broken = observation();
    const window = broken.observationWindow as {startedAtMonotonicMillis: number};
    expectNotEvaluated(
      evaluateMotorDynamicSafetyRequirements({
        staticCompatibility: staticSupported(),
        dynamicObservation: {
          kind: 'OBSERVED',
          observation: {
            ...broken,
            observationWindow: {...broken.observationWindow, startedAtMonotonicMillis: Number.NaN},
          },
        },
        currentSessionIdentity: identity(),
      }),
      'OBSERVATION_WINDOW_INVALID',
    );
    expect(window.startedAtMonotonicMillis).toBe(1000);
  });

  it('fails closed as INCOHERENT rather than normalizing an unknown armed state', () => {
    // The Pass 1D TYPE forbids this, so it can only be produced by a
    // cast. It must never be silently read as "disarmed".
    const cast = {
      ...observation(),
      armedState: 'UNKNOWN' as unknown as MotorObservedArmedState,
    };
    expectNotEvaluated(
      evaluateMotorDynamicSafetyRequirements({
        staticCompatibility: staticSupported(),
        dynamicObservation: {kind: 'OBSERVED', observation: cast},
        currentSessionIdentity: identity(),
      }),
      'DYNAMIC_OBSERVATION_INCOHERENT',
    );
  });

  it('fails closed as INCOHERENT on a negative cell count', () => {
    expectNotEvaluated(
      evaluate({dynamicObservation: observed({cellCount: -1})}),
      'DYNAMIC_OBSERVATION_INCOHERENT',
    );
  });

  it('fails closed as INCOHERENT on a non-integer voltage', () => {
    expectNotEvaluated(
      evaluate({dynamicObservation: observed({voltageCentivolts: 1660.5})}),
      'DYNAMIC_OBSERVATION_INCOHERENT',
    );
  });

  it('never throws for any expected prerequisite failure', () => {
    const cases: Array<() => MotorDynamicSafetyRequirementsEvaluation> = [
      () => evaluate({staticCompatibility: undefined}),
      () => evaluate({staticCompatibility: staticUnsupported()}),
      () => evaluate({dynamicObservation: undefined}),
      () => evaluate({dynamicObservation: {kind: 'NOT_OBSERVED', reason: 'MALFORMED_RESPONSE'}}),
      () => evaluate({currentSessionIdentity: undefined}),
      () => evaluate({staticCompatibility: staticSupported(identity(99, 99))}),
      () => evaluate({dynamicObservation: observed({sessionIdentity: identity(99, 99)})}),
      () =>
        evaluate({
          dynamicObservation: observed({
            startedAtMonotonicMillis: 9,
            completedAtMonotonicMillis: 8,
          }),
        }),
    ];
    for (const runCase of cases) {
      expect(runCase).not.toThrow();
      expect(runCase().kind).toBe('NOT_EVALUATED');
    }
  });

  it('never returns a status, blocker array or partial facts on a prerequisite failure', () => {
    const results = [
      evaluate({staticCompatibility: undefined}),
      evaluate({staticCompatibility: staticUnsupported()}),
      evaluate({dynamicObservation: undefined}),
      evaluate({dynamicObservation: {kind: 'NOT_OBSERVED', reason: 'REQUEST_FAILED'}}),
      evaluate({currentSessionIdentity: undefined}),
      evaluate({staticCompatibility: staticSupported(identity(4, 11))}),
      evaluate({dynamicObservation: observed({sessionIdentity: identity(3, 12)})}),
    ];
    for (const result of results) {
      const record = result as unknown as Record<string, unknown>;
      expect(record.status).toBeUndefined();
      expect(record.blockingReasons).toBeUndefined();
      expect(record.sessionIdentity).toBeUndefined();
      expect(record.observationWindow).toBeUndefined();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 9.2 Armed state and MSP arming restriction
 * ------------------------------------------------------------------ */

describe('armed state and MSP arming restriction', () => {
  it('satisfies the armed-state requirement when explicitly DISARMED', () => {
    expect(blockersFor({armedState: 'DISARMED'})).toEqual([]);
  });

  it('adds FC_ARMED when the FC reported itself ARMED', () => {
    expect(blockersFor({armedState: 'ARMED'})).toEqual(['FC_ARMED']);
  });

  it('satisfies the restriction requirement when the MSP flag is present', () => {
    expect(blockersFor({mspRestrictionPresent: true})).toEqual([]);
  });

  it('adds MSP_ARMING_RESTRICTION_NOT_OBSERVED when the MSP flag is absent', () => {
    expect(blockersFor({mspRestrictionPresent: false})).toEqual([
      'MSP_ARMING_RESTRICTION_NOT_OBSERVED',
    ]);
  });

  it('does not let ONE unrelated arming-disable flag substitute for the MSP flag', () => {
    expect(
      blockersFor({mspRestrictionPresent: false, blockers: [knownBlocker(7, 'THROTTLE')]}),
    ).toEqual(['MSP_ARMING_RESTRICTION_NOT_OBSERVED']);
  });

  it('does not let MANY unrelated arming-disable flags substitute for the MSP flag', () => {
    expect(
      blockersFor({
        mspRestrictionPresent: false,
        blockers: [
          knownBlocker(0, 'NO_GYRO'),
          knownBlocker(7, 'THROTTLE'),
          knownBlocker(12, 'CALIBRATING'),
          knownBlocker(28, 'ARM_SWITCH'),
          {kind: 'UNKNOWN', bit: 31, hex: '0x80000000'},
        ],
      }),
    ).toEqual(['MSP_ARMING_RESTRICTION_NOT_OBSERVED']);
  });

  it('does not fail an otherwise satisfied evaluation because unrelated blockers exist', () => {
    expect(
      blockersFor({
        blockers: [
          knownBlocker(0, 'NO_GYRO'),
          knownBlocker(7, 'THROTTLE'),
          knownBlocker(28, 'ARM_SWITCH'),
        ],
      }),
    ).toEqual([]);
  });

  it('does not infer armed state from any arming-disable flag', () => {
    // NOT_DISARMED (bit 3) is set, yet the canonical armed state is
    // DISARMED: the evaluation follows the canonical fact only.
    expect(blockersFor({armedState: 'DISARMED', blockers: [knownBlocker(3, 'NOT_DISARMED')]})).toEqual(
      [],
    );
    // And an ARMED canonical state blocks even with no blockers at all.
    expect(blockersFor({armedState: 'ARMED', blockers: []})).toEqual(['FC_ARMED']);
  });

  it('does not infer the MSP restriction from a disarmed state', () => {
    expect(blockersFor({armedState: 'DISARMED', mspRestrictionPresent: false})).toEqual([
      'MSP_ARMING_RESTRICTION_NOT_OBSERVED',
    ]);
  });

  it('has no ACK or write result in any fixture or result', () => {
    const serialized = JSON.stringify({
      fixture: observation(),
      result: evaluate(),
    });
    expect(serialized.toLowerCase()).not.toContain('ack');
    expect(serialized.toLowerCase()).not.toContain('write');
  });
});

/* ------------------------------------------------------------------ *
 * 9.3 Reboot requirement
 * ------------------------------------------------------------------ */

describe('reboot requirement', () => {
  it('satisfies the requirement when reboot-required is explicitly false', () => {
    expect(blockersFor({rebootRequired: false})).toEqual([]);
  });

  it('adds REBOOT_REQUIRED when explicitly true', () => {
    expect(blockersFor({rebootRequired: true})).toEqual(['REBOOT_REQUIRED']);
  });

  it('adds REBOOT_STATE_NOT_OBSERVED when the state is null', () => {
    expect(blockersFor({rebootRequired: null})).toEqual(['REBOOT_STATE_NOT_OBSERVED']);
  });

  it('adds REBOOT_REQUIRED from the canonical arming blocker alone', () => {
    // config-state byte says false; arming-disable bit 21 says otherwise.
    expect(
      blockersFor({rebootRequired: false, blockers: [knownBlocker(21, 'REBOOT_REQUIRED')]}),
    ).toEqual(['REBOOT_REQUIRED']);
  });

  it('emits REBOOT_REQUIRED exactly once when BOTH representations indicate it', () => {
    const reasons = blockersFor({
      rebootRequired: true,
      blockers: [knownBlocker(21, 'REBOOT_REQUIRED')],
    });
    expect(reasons).toEqual(['REBOOT_REQUIRED']);
    expect(reasons.filter(reason => reason === 'REBOOT_REQUIRED')).toHaveLength(1);
  });

  it('prefers the definite blocker over NOT_OBSERVED when the byte is null', () => {
    expect(
      blockersFor({rebootRequired: null, blockers: [knownBlocker(21, 'REBOOT_REQUIRED')]}),
    ).toEqual(['REBOOT_REQUIRED']);
  });

  it('does not infer reboot-required from static incompatibility', () => {
    // Static UNSUPPORTED is a PREREQUISITE failure, never a reboot reason.
    const result = evaluate({staticCompatibility: staticUnsupported()});
    expect(JSON.stringify(result)).not.toContain('REBOOT');
  });
});

/* ------------------------------------------------------------------ *
 * 9.4 Battery cell-count policy
 * ------------------------------------------------------------------ */

describe('battery cell-count policy', () => {
  it('requires exactly 4 cells', () => {
    expect(POLICY_REQUIRED_CELL_COUNT).toBe(4);
    expect(blockersFor({cellCount: 4})).toEqual([]);
  });

  it('maps cell count 0 to BATTERY_NOT_DETECTED', () => {
    expect(blockersFor({cellCount: 0, voltageCentivolts: 1500})).toEqual(['BATTERY_NOT_DETECTED']);
  });

  it.each([1, 2, 3, 5, 6, 8, 12])('rejects cell count %i as not allowed', cellCount => {
    expect(blockersFor({cellCount})).toEqual(['BATTERY_CELL_COUNT_NOT_ALLOWED']);
  });

  it('treats 6S as ordinary rejected data with no alternate policy path', () => {
    const reasons = blockersFor({cellCount: 6, voltageCentivolts: 2500});
    expect(reasons).toContain('BATTERY_CELL_COUNT_NOT_ALLOWED');
    expect(reasons).toContain('BATTERY_VOLTAGE_ABOVE_POLICY');
    // No 6S-specific token exists anywhere in the reason vocabulary.
    expect(MOTOR_DYNAMIC_BLOCKING_REASON_ORDER.join(',')).not.toMatch(/6S|SIX_?S/i);
  });

  it('does not infer cell count from voltage', () => {
    // A perfect 4S voltage cannot rescue a reported 0-cell pack...
    expect(blockersFor({cellCount: 0, voltageCentivolts: 1660})).toEqual(['BATTERY_NOT_DETECTED']);
    // ...and a reported 4 cells is accepted even at an out-of-range voltage.
    expect(blockersFor({cellCount: 4, voltageCentivolts: 100})).toEqual([
      'BATTERY_VOLTAGE_BELOW_POLICY',
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * 9.5 Voltage policy
 * ------------------------------------------------------------------ */

describe('voltage policy', () => {
  it('pins the inclusive integer centivolt bounds', () => {
    expect(POLICY_MIN_VOLTAGE_CENTIVOLTS).toBe(1400);
    expect(POLICY_MAX_VOLTAGE_CENTIVOLTS).toBe(1680);
    expect(Number.isInteger(POLICY_MIN_VOLTAGE_CENTIVOLTS)).toBe(true);
    expect(Number.isInteger(POLICY_MAX_VOLTAGE_CENTIVOLTS)).toBe(true);
  });

  it.each([
    [0, ['BATTERY_VOLTAGE_BELOW_POLICY']],
    [1, ['BATTERY_VOLTAGE_BELOW_POLICY']],
    [255, ['BATTERY_VOLTAGE_BELOW_POLICY']],
    [256, ['BATTERY_VOLTAGE_BELOW_POLICY']],
    [1399, ['BATTERY_VOLTAGE_BELOW_POLICY']],
    [1400, []],
    [1401, []],
    [1500, []],
    [1536, []],
    [1660, []],
    [1679, []],
    [1680, []],
    [1681, ['BATTERY_VOLTAGE_ABOVE_POLICY']],
    [2000, ['BATTERY_VOLTAGE_ABOVE_POLICY']],
    [65535, ['BATTERY_VOLTAGE_ABOVE_POLICY']],
  ] as Array<[number, MotorDynamicSafetyBlockingReason[]]>)(
    'voltage %i centivolts yields %p',
    (voltageCentivolts, expected) => {
      expect(blockersFor({voltageCentivolts})).toEqual(expected);
    },
  );

  it('treats both bounds as inclusive', () => {
    expect(blockersFor({voltageCentivolts: POLICY_MIN_VOLTAGE_CENTIVOLTS})).toEqual([]);
    expect(blockersFor({voltageCentivolts: POLICY_MAX_VOLTAGE_CENTIVOLTS})).toEqual([]);
    expect(blockersFor({voltageCentivolts: POLICY_MIN_VOLTAGE_CENTIVOLTS - 1})).toEqual([
      'BATTERY_VOLTAGE_BELOW_POLICY',
    ]);
    expect(blockersFor({voltageCentivolts: POLICY_MAX_VOLTAGE_CENTIVOLTS + 1})).toEqual([
      'BATTERY_VOLTAGE_ABOVE_POLICY',
    ]);
  });

  it('an in-range voltage alone does not satisfy the complete evaluation', () => {
    expect(blockersFor({voltageCentivolts: 1500, armedState: 'ARMED', cellCount: 3})).toEqual([
      'FC_ARMED',
      'BATTERY_CELL_COUNT_NOT_ALLOWED',
    ]);
  });

  it('an out-of-range voltage cannot be overridden by BATTERY_OK', () => {
    expect(
      blockersFor({
        voltageCentivolts: 1200,
        classification: {kind: 'KNOWN', raw: 0, token: 'BATTERY_OK'},
      }),
    ).toEqual(['BATTERY_VOLTAGE_BELOW_POLICY']);
  });
});

/* ------------------------------------------------------------------ *
 * 9.6 Battery-state classification
 * ------------------------------------------------------------------ */

describe('battery-state classification', () => {
  it.each([
    [0, 'BATTERY_OK', []],
    [1, 'BATTERY_WARNING', ['BATTERY_WARNING']],
    [2, 'BATTERY_CRITICAL', ['BATTERY_CRITICAL']],
    [3, 'BATTERY_NOT_PRESENT', ['BATTERY_NOT_PRESENT']],
    [4, 'BATTERY_INIT', ['BATTERY_INITIALIZING']],
  ] as Array<[number, string, MotorDynamicSafetyBlockingReason[]]>)(
    'maps raw %i (%s) independently',
    (raw, token, expected) => {
      expect(blockersFor({classification: {kind: 'KNOWN', raw, token}})).toEqual(expected);
    },
  );

  it('only BATTERY_OK satisfies the classification requirement', () => {
    const satisfying = [0, 1, 2, 3, 4].filter(
      raw =>
        blockersFor({
          classification: {
            kind: 'KNOWN',
            raw,
            token: ['BATTERY_OK', 'BATTERY_WARNING', 'BATTERY_CRITICAL', 'BATTERY_NOT_PRESENT', 'BATTERY_INIT'][raw],
          },
        }).length === 0,
    );
    expect(satisfying).toEqual([0]);
  });

  it.each([5, 42, 200, 255])('never normalizes unrecognized raw %i to OK', raw => {
    expect(blockersFor({classification: {kind: 'UNRECOGNIZED', raw}})).toEqual([
      'BATTERY_STATE_UNRECOGNIZED',
    ]);
  });

  it('treats a token outside the pinned enum as unrecognized, never as OK', () => {
    expect(
      blockersFor({classification: {kind: 'KNOWN', raw: 9, token: 'BATTERY_FUTURE_STATE'}}),
    ).toEqual(['BATTERY_STATE_UNRECOGNIZED']);
  });

  it('does not override cell-count or voltage failures', () => {
    expect(
      blockersFor({
        cellCount: 6,
        voltageCentivolts: 2400,
        classification: {kind: 'KNOWN', raw: 0, token: 'BATTERY_OK'},
      }),
    ).toEqual(['BATTERY_CELL_COUNT_NOT_ALLOWED', 'BATTERY_VOLTAGE_ABOVE_POLICY']);
  });
});

/* ------------------------------------------------------------------ *
 * 9.7 Combined behaviour
 * ------------------------------------------------------------------ */

describe('combined behaviour', () => {
  it('satisfies the canonical fixture with an empty frozen blocker collection', () => {
    const result = evaluate();
    expect(result.kind).toBe('EVALUATED');
    if (result.kind !== 'EVALUATED') {
      throw new Error('unreachable');
    }
    expect(result.status).toBe('REQUIREMENTS_SATISFIED');
    expect(result.blockingReasons).toEqual([]);
    expect(Object.isFrozen(result.blockingReasons)).toBe(true);
  });

  const isolated: Array<[MotorDynamicSafetyBlockingReason, ObservationFixture]> = [
    ['FC_ARMED', {armedState: 'ARMED'}],
    ['MSP_ARMING_RESTRICTION_NOT_OBSERVED', {mspRestrictionPresent: false}],
    ['REBOOT_REQUIRED', {rebootRequired: true}],
    ['REBOOT_STATE_NOT_OBSERVED', {rebootRequired: null}],
    ['BATTERY_NOT_DETECTED', {cellCount: 0}],
    ['BATTERY_CELL_COUNT_NOT_ALLOWED', {cellCount: 3}],
    ['BATTERY_VOLTAGE_BELOW_POLICY', {voltageCentivolts: 1399}],
    ['BATTERY_VOLTAGE_ABOVE_POLICY', {voltageCentivolts: 1681}],
    ['BATTERY_WARNING', {classification: {kind: 'KNOWN', raw: 1, token: 'BATTERY_WARNING'}}],
    ['BATTERY_CRITICAL', {classification: {kind: 'KNOWN', raw: 2, token: 'BATTERY_CRITICAL'}}],
    ['BATTERY_NOT_PRESENT', {classification: {kind: 'KNOWN', raw: 3, token: 'BATTERY_NOT_PRESENT'}}],
    ['BATTERY_INITIALIZING', {classification: {kind: 'KNOWN', raw: 4, token: 'BATTERY_INIT'}}],
    ['BATTERY_STATE_UNRECOGNIZED', {classification: {kind: 'UNRECOGNIZED', raw: 200}}],
  ];

  it.each(isolated)('produces %s in isolation', (reason, fixture) => {
    expect(blockersFor(fixture)).toEqual([reason]);
  });

  it('covers every reason in the canonical order table', () => {
    expect(isolated.map(([reason]) => reason).sort()).toEqual(
      Array.from(MOTOR_DYNAMIC_BLOCKING_REASON_ORDER).sort(),
    );
  });

  it('collects several simultaneous blockers in canonical order', () => {
    expect(
      blockersFor({
        armedState: 'ARMED',
        rebootRequired: true,
        voltageCentivolts: 1399,
      }),
    ).toEqual(['FC_ARMED', 'REBOOT_REQUIRED', 'BATTERY_VOLTAGE_BELOW_POLICY']);
  });

  it('collects the maximum simultaneous blocker set in canonical order', () => {
    // REBOOT_REQUIRED and REBOOT_STATE_NOT_OBSERVED are mutually
    // exclusive by construction, as are the two voltage reasons and the
    // two cell-count reasons - so this is the largest reachable set.
    expect(
      blockersFor({
        armedState: 'ARMED',
        mspRestrictionPresent: false,
        rebootRequired: true,
        cellCount: 0,
        voltageCentivolts: 0,
        classification: {kind: 'UNRECOGNIZED', raw: 7},
      }),
    ).toEqual([
      'FC_ARMED',
      'MSP_ARMING_RESTRICTION_NOT_OBSERVED',
      'REBOOT_REQUIRED',
      'BATTERY_NOT_DETECTED',
      'BATTERY_VOLTAGE_BELOW_POLICY',
      'BATTERY_STATE_UNRECOGNIZED',
    ]);
  });

  it('orders reasons deterministically regardless of which conditions failed', () => {
    const reasons = blockersFor({
      classification: {kind: 'KNOWN', raw: 2, token: 'BATTERY_CRITICAL'},
      cellCount: 5,
      armedState: 'ARMED',
      mspRestrictionPresent: false,
    });
    const positions = reasons.map(reason => MOTOR_DYNAMIC_BLOCKING_REASON_ORDER.indexOf(reason));
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(reasons).toEqual([
      'FC_ARMED',
      'MSP_ARMING_RESTRICTION_NOT_OBSERVED',
      'BATTERY_CELL_COUNT_NOT_ALLOWED',
      'BATTERY_CRITICAL',
    ]);
  });

  it('never emits a duplicate reason', () => {
    const reasons = blockersFor({
      armedState: 'ARMED',
      rebootRequired: true,
      blockers: [knownBlocker(21, 'REBOOT_REQUIRED'), knownBlocker(21, 'REBOOT_REQUIRED')],
      cellCount: 0,
    });
    expect(new Set(reasons).size).toBe(reasons.length);
  });

  it('produces equal content in fresh objects on repeated evaluation', () => {
    const first = evaluate();
    const second = evaluate();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    if (first.kind !== 'EVALUATED' || second.kind !== 'EVALUATED') {
      throw new Error('unreachable');
    }
    expect(first.sessionIdentity).not.toBe(second.sessionIdentity);
    expect(first.observationWindow).not.toBe(second.observationWindow);
    expect(first.blockingReasons).not.toBe(second.blockingReasons);
  });

  it('never turns an ordinary condition failure into NOT_EVALUATED', () => {
    for (const [, fixture] of isolated) {
      const result = evaluate({dynamicObservation: observed(fixture)});
      expect(result.kind).toBe('EVALUATED');
      if (result.kind !== 'EVALUATED') {
        throw new Error('unreachable');
      }
      expect(result.status).toBe('REQUIREMENTS_NOT_SATISFIED');
    }
  });

  it('never turns a prerequisite failure into REQUIREMENTS_NOT_SATISFIED', () => {
    const results = [
      evaluate({staticCompatibility: staticUnsupported()}),
      evaluate({dynamicObservation: {kind: 'NOT_OBSERVED', reason: 'REQUEST_FAILED'}}),
      evaluate({currentSessionIdentity: undefined}),
    ];
    for (const result of results) {
      expect(result.kind).toBe('NOT_EVALUATED');
      expect(JSON.stringify(result)).not.toContain('REQUIREMENTS_');
    }
  });
});

/* ------------------------------------------------------------------ *
 * 9.8 Immutability and serialization
 * ------------------------------------------------------------------ */

describe('immutability and serialization', () => {
  it('does not mutate any input', () => {
    const staticInput = staticSupported();
    const dynamicInput = observed({blockers: [knownBlocker(21, 'REBOOT_REQUIRED')]});
    const currentInput = identity();
    const snapshot = JSON.stringify({staticInput, dynamicInput, currentInput});
    evaluateMotorDynamicSafetyRequirements({
      staticCompatibility: staticInput,
      dynamicObservation: dynamicInput,
      currentSessionIdentity: currentInput,
    });
    expect(JSON.stringify({staticInput, dynamicInput, currentInput})).toBe(snapshot);
  });

  it('does not retain the input identity, window or flag collection by reference', () => {
    const currentInput = identity();
    const dynamicInput = observed({blockers: [knownBlocker(7, 'THROTTLE')]});
    if (dynamicInput.kind !== 'OBSERVED') {
      throw new Error('unreachable');
    }
    const result = evaluateMotorDynamicSafetyRequirements({
      staticCompatibility: staticSupported(),
      dynamicObservation: dynamicInput,
      currentSessionIdentity: currentInput,
    });
    if (result.kind !== 'EVALUATED') {
      throw new Error('unreachable');
    }
    expect(result.sessionIdentity).not.toBe(currentInput);
    expect(result.sessionIdentity).not.toBe(dynamicInput.observation.sessionIdentity);
    expect(result.observationWindow).not.toBe(dynamicInput.observation.observationWindow);
    const record = result as unknown as Record<string, unknown>;
    for (const value of Object.values(record)) {
      expect(value).not.toBe(dynamicInput.observation.armingRestrictions.blockers);
      expect(value).not.toBe(dynamicInput.observation);
    }
  });

  it('freezes the complete result graph', () => {
    const result = evaluate({dynamicObservation: observed({armedState: 'ARMED'})});
    if (result.kind !== 'EVALUATED') {
      throw new Error('unreachable');
    }
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.sessionIdentity)).toBe(true);
    expect(Object.isFrozen(result.observationWindow)).toBe(true);
    expect(Object.isFrozen(result.blockingReasons)).toBe(true);
  });

  it('freezes NOT_EVALUATED results too', () => {
    expect(Object.isFrozen(evaluate({currentSessionIdentity: undefined}))).toBe(true);
    expect(
      Object.isFrozen(evaluate({dynamicObservation: {kind: 'NOT_OBSERVED', reason: 'REQUEST_FAILED'}})),
    ).toBe(true);
  });

  it('does not let a mutation through the result take effect', () => {
    const result = evaluate({dynamicObservation: observed({armedState: 'ARMED'})});
    if (result.kind !== 'EVALUATED') {
      throw new Error('unreachable');
    }
    const mutableReasons = result.blockingReasons as MotorDynamicSafetyBlockingReason[];
    try {
      mutableReasons.push('BATTERY_CRITICAL');
    } catch {
      // Strict mode throws, sloppy mode ignores. Either is acceptable -
      // what matters is that the collection did not change.
    }
    const mutableIdentity = result.sessionIdentity as {physicalGeneration: number};
    try {
      mutableIdentity.physicalGeneration = 99;
    } catch {
      // As above.
    }
    expect(result.blockingReasons).toEqual(['FC_ARMED']);
    expect(result.sessionIdentity.physicalGeneration).toBe(3);
  });

  it('survives a JSON round trip unchanged', () => {
    const result = evaluate({
      dynamicObservation: observed({armedState: 'ARMED', cellCount: 6, rebootRequired: null}),
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('contains no function, class instance, requester, client, callback or transport', () => {
    function assertDataOnly(value: unknown, depth = 0): void {
      expect(depth).toBeLessThan(8);
      if (value === null) {
        return;
      }
      const type = typeof value;
      if (type === 'string' || type === 'number' || type === 'boolean') {
        return;
      }
      expect(type).toBe('object');
      const prototype = Object.getPrototypeOf(value);
      expect(prototype === Object.prototype || prototype === Array.prototype).toBe(true);
      for (const nested of Object.values(value as Record<string, unknown>)) {
        assertDataOnly(nested, depth + 1);
      }
    }
    assertDataOnly(evaluate());
    assertDataOnly(evaluate({dynamicObservation: observed({armedState: 'ARMED'})}));
    assertDataOnly(evaluate({currentSessionIdentity: undefined}));
  });
});

/* ------------------------------------------------------------------ *
 * 9.9 Semantic exclusions
 * ------------------------------------------------------------------ */

describe('semantic exclusions', () => {
  function collectKeysAndStrings(value: unknown, sink: Set<string>, depth = 0): void {
    if (depth > 8 || value === null) {
      return;
    }
    if (typeof value === 'string') {
      sink.add(value);
      return;
    }
    if (typeof value !== 'object') {
      return;
    }
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (!Array.isArray(value)) {
        sink.add(key);
      }
      collectKeysAndStrings(nested, sink, depth + 1);
    }
  }

  const AUTHORIZATION_VOCABULARY =
    /^(is)?(safe|ready|authoriz|approved|allowed|permitted|permission|cantest|canpulse|canstart|go)$/i;

  it('exposes no key or value meaning ready, safe, authorized, allowed or go', () => {
    const results = [
      evaluate(),
      evaluate({dynamicObservation: observed({armedState: 'ARMED', cellCount: 0})}),
      evaluate({staticCompatibility: staticUnsupported()}),
      evaluate({currentSessionIdentity: undefined}),
      evaluate({dynamicObservation: {kind: 'NOT_OBSERVED', reason: 'MALFORMED_RESPONSE'}}),
    ];
    for (const result of results) {
      const sink = new Set<string>();
      collectKeysAndStrings(result, sink);
      const offenders = Array.from(sink).filter(entry => AUTHORIZATION_VOCABULARY.test(entry));
      expect(offenders).toEqual([]);
    }
  });

  it('makes REQUIREMENTS_SATISFIED the strongest possible outcome', () => {
    const result = evaluate();
    if (result.kind !== 'EVALUATED') {
      throw new Error('unreachable');
    }
    expect(result.status).toBe('REQUIREMENTS_SATISFIED');
    // The status union has exactly two members and neither is stronger.
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      'READY',
      'SAFE',
      'AUTHORIZED',
      'CAN_TEST',
      'CAN_PULSE',
      'CAN_START',
      '"GO"',
      'LEASE',
      'PERMISSION',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('constructs no pulse value, motor vector, command or lease', () => {
    const serialized = JSON.stringify([
      evaluate(),
      evaluate({dynamicObservation: observed({armedState: 'ARMED'})}),
    ]).toLowerCase();
    for (const forbidden of ['pulse', 'throttle', 'motorvector', 'dshot', '214', 'lease', 'command']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('contains no battery brand, capacity, C-rating, age, chemistry or health fact', () => {
    const serialized = JSON.stringify(evaluate()).toLowerCase();
    for (const forbidden of ['brand', 'capacity', 'mah', 'crating', 'c_rating', 'chemistry', 'age', 'health', 'lipo']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('contains no user-provided motor, frame, ESC, KV or battery identity', () => {
    const serialized = JSON.stringify(evaluate()).toLowerCase();
    for (const forbidden of ['frame', 'esc', 'kv', 'motormodel', 'manufacturer', 'nominal']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('claims no atomicity, freshness, liveness or monitoring guarantee', () => {
    const result = evaluate();
    const sink = new Set<string>();
    collectKeysAndStrings(result, sink);
    const offenders = Array.from(sink).filter(entry =>
      /^(fresh|atomic|current|live|monitor|watchdog|valid(ity)?|age|stale)$/i.test(entry),
    );
    expect(offenders).toEqual([]);
  });

  it('exposes exactly the documented EVALUATED fields - no extras', () => {
    const result = evaluate();
    expect(Object.keys(result).sort()).toEqual([
      'blockingReasons',
      'kind',
      'observationWindow',
      'sessionIdentity',
      'status',
    ]);
  });
});
