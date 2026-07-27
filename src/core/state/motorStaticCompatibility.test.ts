/**
 * Pass 1C - tests for the pure static motor compatibility evaluation.
 *
 * NO HARDWARE OF ANY KIND is required, referenced or simulated: no
 * flight controller, no USB, no transport, no MspClient, no requester,
 * no ESC, no motor, no LiPo, no timers. Every input is a hand-written
 * immutable value and the module under test performs no I/O.
 *
 * `SUPPORTED` HERE MEANS STATIC CONFIGURATION MATCH ONLY. No test in
 * this file describes it as readiness, safety, authorization or
 * permission to pulse a motor.
 */

import {
  evaluateMotorStaticCompatibility,
  MOTOR_STATIC_CHECK_ORDER,
  SUPPORTED_API_VERSION_MAJOR,
  SUPPORTED_API_VERSION_MINOR,
  SUPPORTED_DSHOT_TELEMETRY_RAW,
  SUPPORTED_FIRMWARE_MONTH,
  SUPPORTED_FIRMWARE_PATCH,
  SUPPORTED_FIRMWARE_VARIANT_IDENTIFIER,
  SUPPORTED_FIRMWARE_VERSION_TEXT,
  SUPPORTED_FIRMWARE_YEAR,
  SUPPORTED_FIRMWARE_YEAR_OFFSET_RAW,
  SUPPORTED_MIXER_MODE_RAW,
  SUPPORTED_MOTOR_COUNT,
  SUPPORTED_MOTOR_IDLE_RAW,
  SUPPORTED_MOTOR_PROTOCOL_RAW,
  SUPPORTED_TARGET_NAME,
  type MotorStaticCheckId,
} from './motorStaticCompatibility';
import type {MotorFcFirmwareVersionBinding} from './motorFcFirmwareVersion';
import type {
  MotorStaticFacts,
  MotorStaticFactsBinding,
  MotorStaticFactsSessionIdentity,
} from './motorStaticFacts';

/* ------------------------------------------------------------------ *
 * Fixtures - the exact supported profile, then targeted overrides.
 * ------------------------------------------------------------------ */

const IDENTITY: MotorStaticFactsSessionIdentity = {physicalGeneration: 3, mspEpoch: 11};

function supportedFacts(): MotorStaticFacts {
  return {
    flightControllerIdentity: {
      apiVersion: {mspProtocolVersion: 0, apiVersionMajor: 1, apiVersionMinor: 47},
      firmware: {identifier: 'BTFL', knownFamily: 'BETAFLIGHT'},
      board: {
        boardIdentifier: 'S405',
        hardwareRevision: 0,
        boardType: 2,
        targetCapabilities: 0,
        targetName: 'SPEEDYBEEF405V4',
        boardName: 'SPEEDYBEEF405V4',
        manufacturerId: 'SPBE',
        signature: Object.freeze([]),
        mcuTypeId: 1,
        trailingBytes: Object.freeze([]),
      },
    },
    mixerModeRaw: 3,
    yawMotorsReversedConfigured: true,
    motorCount: 4,
    motorPoleCount: 14,
    motorProtocolRaw: 7,
    motorIdleRaw: 550,
    feature3dEnabled: false,
    dshotTelemetryRaw: 0,
  };
}

function staticBinding(
  factOverrides: Partial<MotorStaticFacts> = {},
  identity: MotorStaticFactsSessionIdentity = {...IDENTITY},
): MotorStaticFactsBinding {
  return {sessionIdentity: identity, facts: {...supportedFacts(), ...factOverrides}};
}

/** Overrides nested inside flightControllerIdentity, which the flat
 * Partial<MotorStaticFacts> above cannot reach. */
function staticBindingWithIdentityOverrides(overrides: {
  identifier?: string;
  apiVersionMajor?: number;
  apiVersionMinor?: number;
  targetName?: string;
}): MotorStaticFactsBinding {
  const facts = supportedFacts();
  const fcIdentity = facts.flightControllerIdentity;
  return {
    sessionIdentity: {...IDENTITY},
    facts: {
      ...facts,
      flightControllerIdentity: {
        apiVersion: {
          ...fcIdentity.apiVersion,
          apiVersionMajor: overrides.apiVersionMajor ?? fcIdentity.apiVersion.apiVersionMajor,
          apiVersionMinor: overrides.apiVersionMinor ?? fcIdentity.apiVersion.apiVersionMinor,
        },
        firmware: {
          ...fcIdentity.firmware,
          identifier: overrides.identifier ?? fcIdentity.firmware.identifier,
        },
        board: {...fcIdentity.board, targetName: overrides.targetName ?? fcIdentity.board.targetName},
      },
    },
  };
}

function versionBinding(
  overrides: Partial<MotorFcFirmwareVersionBinding['firmwareVersion']> = {},
  identity: MotorStaticFactsSessionIdentity = {...IDENTITY},
): MotorFcFirmwareVersionBinding {
  return {
    sessionIdentity: identity,
    firmwareVersion: {
      yearOffsetRaw: 25,
      year: 2025,
      month: 12,
      patch: 2,
      versionString: '2025.12.2',
      suffix: null,
      ...overrides,
    },
  };
}

/** Asserts EVALUATED and returns the compatibility result. */
function evaluated(
  staticFactsBinding: MotorStaticFactsBinding,
  firmwareVersionBinding: MotorFcFirmwareVersionBinding,
) {
  const result = evaluateMotorStaticCompatibility(staticFactsBinding, firmwareVersionBinding);
  expect(result.kind).toBe('EVALUATED');
  if (result.kind !== 'EVALUATED') {
    throw new Error('expected EVALUATED');
  }
  return result.compatibility;
}

/* ------------------------------------------------------------------ *
 * Supported-profile constants
 * ------------------------------------------------------------------ */

describe('supported profile constants', () => {
  it('pin the exact v1 profile in canonical decoded units', () => {
    expect(SUPPORTED_FIRMWARE_VARIANT_IDENTIFIER).toBe('BTFL');
    expect(SUPPORTED_FIRMWARE_VERSION_TEXT).toBe('2025.12.2');
    expect(SUPPORTED_FIRMWARE_YEAR_OFFSET_RAW).toBe(25);
    expect(SUPPORTED_FIRMWARE_YEAR).toBe(2025);
    expect(SUPPORTED_FIRMWARE_MONTH).toBe(12);
    expect(SUPPORTED_FIRMWARE_PATCH).toBe(2);
    expect(SUPPORTED_API_VERSION_MAJOR).toBe(1);
    expect(SUPPORTED_API_VERSION_MINOR).toBe(47);
    expect(SUPPORTED_TARGET_NAME).toBe('SPEEDYBEEF405V4');
    expect(SUPPORTED_MIXER_MODE_RAW).toBe(3);
    expect(SUPPORTED_MOTOR_COUNT).toBe(4);
    expect(SUPPORTED_MOTOR_PROTOCOL_RAW).toBe(7);
    // pg/motor.h:83 @ the pinned tag: motorIdle is "percent * 100",
    // so 5.5% is exactly the integer 550 - never a float, never a string.
    expect(SUPPORTED_MOTOR_IDLE_RAW).toBe(550);
    expect(Number.isInteger(SUPPORTED_MOTOR_IDLE_RAW)).toBe(true);
    expect(SUPPORTED_DSHOT_TELEMETRY_RAW).toBe(0);
  });

  it('declares all eleven checks exactly once, in a stable frozen order', () => {
    expect(MOTOR_STATIC_CHECK_ORDER).toEqual([
      'FIRMWARE_VARIANT',
      'FIRMWARE_VERSION',
      'MSP_API_VERSION',
      'TARGET_NAME',
      'MIXER_MODE',
      'MOTOR_COUNT',
      'MOTOR_PROTOCOL',
      'MOTOR_IDLE',
      'FEATURE_3D_DISABLED',
      'YAW_MOTORS_REVERSED_ENABLED',
      'BIDIRECTIONAL_DSHOT_DISABLED',
    ]);
    expect(new Set(MOTOR_STATIC_CHECK_ORDER).size).toBe(MOTOR_STATIC_CHECK_ORDER.length);
    expect(Object.isFrozen(MOTOR_STATIC_CHECK_ORDER)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Composite session identity gate
 * ------------------------------------------------------------------ */

describe('composite session identity gate', () => {
  it('evaluates when independently allocated identities are VALUE-equal', () => {
    const left: MotorStaticFactsSessionIdentity = {physicalGeneration: 3, mspEpoch: 11};
    const right: MotorStaticFactsSessionIdentity = {physicalGeneration: 3, mspEpoch: 11};
    expect(left).not.toBe(right);

    const compatibility = evaluated(staticBinding({}, left), versionBinding({}, right));
    expect(compatibility.status).toBe('SUPPORTED');
  });

  it('does NOT evaluate on a physicalGeneration mismatch', () => {
    const result = evaluateMotorStaticCompatibility(
      staticBinding({}, {physicalGeneration: 3, mspEpoch: 11}),
      versionBinding({}, {physicalGeneration: 4, mspEpoch: 11}),
    );
    expect(result).toEqual({kind: 'NOT_EVALUATED', reason: 'SESSION_IDENTITY_MISMATCH'});
  });

  it('does NOT evaluate on an mspEpoch mismatch', () => {
    const result = evaluateMotorStaticCompatibility(
      staticBinding({}, {physicalGeneration: 3, mspEpoch: 11}),
      versionBinding({}, {physicalGeneration: 3, mspEpoch: 12}),
    );
    expect(result).toEqual({kind: 'NOT_EVALUATED', reason: 'SESSION_IDENTITY_MISMATCH'});
  });

  it('does NOT evaluate when both identity fields mismatch', () => {
    const result = evaluateMotorStaticCompatibility(
      staticBinding({}, {physicalGeneration: 1, mspEpoch: 1}),
      versionBinding({}, {physicalGeneration: 9, mspEpoch: 9}),
    );
    expect(result).toEqual({kind: 'NOT_EVALUATED', reason: 'SESSION_IDENTITY_MISMATCH'});
  });

  it('returns NO checks, NO compatibility and NO partial profile on mismatch', () => {
    const result = evaluateMotorStaticCompatibility(
      staticBinding({}, {physicalGeneration: 3, mspEpoch: 11}),
      versionBinding({}, {physicalGeneration: 4, mspEpoch: 11}),
    );
    expect(Object.keys(result).sort()).toEqual(['kind', 'reason']);
    expect(Object.keys(result)).not.toContain('compatibility');
    expect(Object.keys(result)).not.toContain('checks');
    expect(Object.keys(result)).not.toContain('sessionIdentity');
  });

  it('never combines facts across mismatched bindings - even when both are otherwise perfect', () => {
    // Both sides are individually the supported profile; only the
    // session differs. That must still refuse evaluation outright rather
    // than reporting SUPPORTED.
    const result = evaluateMotorStaticCompatibility(
      staticBinding({}, {physicalGeneration: 3, mspEpoch: 11}),
      versionBinding({}, {physicalGeneration: 3, mspEpoch: 99}),
    );
    expect(result.kind).toBe('NOT_EVALUATED');
    expect(JSON.stringify(result)).not.toContain('SUPPORTED');
  });

  it('is an identity-mismatch outcome, NOT an ordinary unsupported configuration', () => {
    const result = evaluateMotorStaticCompatibility(
      staticBinding({}, {physicalGeneration: 3, mspEpoch: 11}),
      versionBinding({}, {physicalGeneration: 4, mspEpoch: 11}),
    );
    expect(result.kind).not.toBe('EVALUATED');
    if (result.kind === 'NOT_EVALUATED') {
      expect(result.reason).toBe('SESSION_IDENTITY_MISMATCH');
    }
  });

  it('copies the agreed identity fresh and frozen into the result', () => {
    const left: MotorStaticFactsSessionIdentity = {physicalGeneration: 3, mspEpoch: 11};
    const compatibility = evaluated(staticBinding({}, left), versionBinding());

    expect(compatibility.sessionIdentity).toEqual({physicalGeneration: 3, mspEpoch: 11});
    expect(compatibility.sessionIdentity).not.toBe(left);
    expect(Object.isFrozen(compatibility.sessionIdentity)).toBe(true);
    expect(Object.keys(compatibility.sessionIdentity).sort()).toEqual([
      'mspEpoch',
      'physicalGeneration',
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * The fully supported profile
 * ------------------------------------------------------------------ */

describe('fully supported profile', () => {
  it('matches every check and reports SUPPORTED', () => {
    const compatibility = evaluated(staticBinding(), versionBinding());

    expect(compatibility.status).toBe('SUPPORTED');
    expect(compatibility.mismatchedCheckIds).toEqual([]);
    expect(compatibility.checks.map(entry => entry.checkId)).toEqual([
      ...MOTOR_STATIC_CHECK_ORDER,
    ]);
    for (const entry of compatibility.checks) {
      expect(entry.status).toBe('STATIC_PROFILE_MATCH');
    }
  });

  it('reports every check exactly once', () => {
    const compatibility = evaluated(staticBinding(), versionBinding());
    const ids = compatibility.checks.map(entry => entry.checkId);
    expect(ids).toHaveLength(MOTOR_STATIC_CHECK_ORDER.length);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/* ------------------------------------------------------------------ *
 * Individual mismatches - each must be UNSUPPORTED, never SUPPORTED
 * ------------------------------------------------------------------ */

/** Asserts exactly which checks mismatched for a given pair. */
function expectMismatch(
  staticFactsBinding: MotorStaticFactsBinding,
  firmwareVersionBinding: MotorFcFirmwareVersionBinding,
  expectedIds: readonly MotorStaticCheckId[],
): void {
  const compatibility = evaluated(staticFactsBinding, firmwareVersionBinding);
  expect(compatibility.status).toBe('UNSUPPORTED');
  expect(compatibility.mismatchedCheckIds).toEqual(expectedIds);
  // Every check is still reported, in full and in order.
  expect(compatibility.checks.map(entry => entry.checkId)).toEqual([...MOTOR_STATIC_CHECK_ORDER]);
}

describe('firmware variant mismatches', () => {
  it('rejects a different variant', () => {
    expectMismatch(staticBindingWithIdentityOverrides({identifier: 'INAV'}), versionBinding(), [
      'FIRMWARE_VARIANT',
    ]);
  });

  it('rejects a CASE mismatch - comparison is case-sensitive', () => {
    expectMismatch(staticBindingWithIdentityOverrides({identifier: 'btfl'}), versionBinding(), [
      'FIRMWARE_VARIANT',
    ]);
  });
});

describe('firmware version mismatches', () => {
  it('rejects a different year', () => {
    expectMismatch(
      staticBinding(),
      versionBinding({yearOffsetRaw: 26, year: 2026, versionString: '2026.12.2'}),
      ['FIRMWARE_VERSION'],
    );
  });

  it('rejects a different month', () => {
    expectMismatch(staticBinding(), versionBinding({month: 11, versionString: '2025.11.2'}), [
      'FIRMWARE_VERSION',
    ]);
  });

  it('rejects a different patch', () => {
    expectMismatch(staticBinding(), versionBinding({patch: 5, versionString: '2025.12.5'}), [
      'FIRMWARE_VERSION',
    ]);
  });

  it('rejects the correct numeric base carrying a SUFFIX', () => {
    // 2025.12.2-RC1 is a different build, not the final release.
    expectMismatch(
      staticBinding(),
      versionBinding({versionString: '2025.12.2-RC1', suffix: 'RC1'}),
      ['FIRMWARE_VERSION'],
    );
    expectMismatch(
      staticBinding(),
      versionBinding({versionString: '2025.12.2-beta', suffix: 'beta'}),
      ['FIRMWARE_VERSION'],
    );
  });

  it('rejects a mismatched exact text even when the tuple matches', () => {
    expectMismatch(staticBinding(), versionBinding({versionString: '2025.12.20'}), [
      'FIRMWARE_VERSION',
    ]);
  });

  it('rejects a mismatched raw year offset even when the derived year matches', () => {
    expectMismatch(staticBinding(), versionBinding({yearOffsetRaw: 24}), ['FIRMWARE_VERSION']);
  });
});

describe('MSP API version mismatches', () => {
  it('rejects a wrong major', () => {
    expectMismatch(staticBindingWithIdentityOverrides({apiVersionMajor: 2}), versionBinding(), [
      'MSP_API_VERSION',
    ]);
  });

  it('rejects a wrong minor', () => {
    expectMismatch(staticBindingWithIdentityOverrides({apiVersionMinor: 46}), versionBinding(), [
      'MSP_API_VERSION',
    ]);
    expectMismatch(staticBindingWithIdentityOverrides({apiVersionMinor: 48}), versionBinding(), [
      'MSP_API_VERSION',
    ]);
  });

  it('compares NUMERICALLY, not lexicographically', () => {
    // Lexicographically "1.9" > "1.47"; numerically 9 !== 47. Minor 9
    // must be rejected either way, which pins the numeric comparison.
    expectMismatch(staticBindingWithIdentityOverrides({apiVersionMinor: 9}), versionBinding(), [
      'MSP_API_VERSION',
    ]);
    // And 147 must not be mistaken for 1.47.
    expectMismatch(staticBindingWithIdentityOverrides({apiVersionMinor: 147}), versionBinding(), [
      'MSP_API_VERSION',
    ]);
  });
});

describe('target name mismatches', () => {
  it('rejects a different target', () => {
    expectMismatch(
      staticBindingWithIdentityOverrides({targetName: 'SPEEDYBEEF405V3'}),
      versionBinding(),
      ['TARGET_NAME'],
    );
  });

  it('rejects a CASE mismatch - comparison is case-sensitive', () => {
    expectMismatch(
      staticBindingWithIdentityOverrides({targetName: 'speedybeef405v4'}),
      versionBinding(),
      ['TARGET_NAME'],
    );
  });

  it('reads the TARGET name, not the board identifier or manufacturer id', () => {
    // boardIdentifier/manufacturerId deliberately say something else;
    // only targetName is consulted.
    const compatibility = evaluated(staticBinding(), versionBinding());
    expect(compatibility.status).toBe('SUPPORTED');
    const targetCheck = compatibility.checks.find(entry => entry.checkId === 'TARGET_NAME');
    expect(targetCheck?.received).toBe('SPEEDYBEEF405V4');
  });
});

describe('mixer, motor count and protocol mismatches', () => {
  it('rejects a non-Quad-X mixer', () => {
    // MIXER_QUADX_1234 (26) is a genuinely different mixer.
    expectMismatch(staticBinding({mixerModeRaw: 26}), versionBinding(), ['MIXER_MODE']);
    expectMismatch(staticBinding({mixerModeRaw: 0}), versionBinding(), ['MIXER_MODE']);
  });

  it('rejects a motor count below four', () => {
    expectMismatch(staticBinding({motorCount: 3}), versionBinding(), ['MOTOR_COUNT']);
  });

  it('rejects a motor count above four', () => {
    expectMismatch(staticBinding({motorCount: 6}), versionBinding(), ['MOTOR_COUNT']);
    expectMismatch(staticBinding({motorCount: 8}), versionBinding(), ['MOTOR_COUNT']);
  });

  it('does NOT infer motor count from the Quad X mixer', () => {
    // Mixer is a perfectly valid Quad X, yet the independently decoded
    // motor count is wrong: the count check must still fail.
    const compatibility = evaluated(staticBinding({motorCount: 6}), versionBinding());
    expect(compatibility.mismatchedCheckIds).toEqual(['MOTOR_COUNT']);
    const mixerCheck = compatibility.checks.find(entry => entry.checkId === 'MIXER_MODE');
    expect(mixerCheck?.status).toBe('STATIC_PROFILE_MATCH');
  });

  it('rejects another DShot protocol - not "any DShot"', () => {
    // DSHOT300 = 6, DSHOT150 = 5 at the pinned tag.
    expectMismatch(staticBinding({motorProtocolRaw: 6}), versionBinding(), ['MOTOR_PROTOCOL']);
    expectMismatch(staticBinding({motorProtocolRaw: 5}), versionBinding(), ['MOTOR_PROTOCOL']);
  });

  it('rejects a non-DShot protocol', () => {
    // PWM = 0, BRUSHED = 4, PROSHOT1000 = 8, DISABLED = 9.
    for (const motorProtocolRaw of [0, 4, 8, 9]) {
      expectMismatch(staticBinding({motorProtocolRaw}), versionBinding(), ['MOTOR_PROTOCOL']);
    }
  });
});

describe('motor idle mismatches', () => {
  it('rejects the raw value immediately BELOW the required one', () => {
    expectMismatch(staticBinding({motorIdleRaw: 549}), versionBinding(), ['MOTOR_IDLE']);
  });

  it('rejects the raw value immediately ABOVE the required one', () => {
    expectMismatch(staticBinding({motorIdleRaw: 551}), versionBinding(), ['MOTOR_IDLE']);
  });

  it('uses exact integer comparison - no floating-point tolerance', () => {
    expectMismatch(staticBinding({motorIdleRaw: 550.0001}), versionBinding(), ['MOTOR_IDLE']);
    expectMismatch(staticBinding({motorIdleRaw: 5.5}), versionBinding(), ['MOTOR_IDLE']);
    expectMismatch(staticBinding({motorIdleRaw: 55}), versionBinding(), ['MOTOR_IDLE']);
  });
});

describe('boolean/raw flag mismatches', () => {
  it('rejects 3D enabled', () => {
    expectMismatch(staticBinding({feature3dEnabled: true}), versionBinding(), [
      'FEATURE_3D_DISABLED',
    ]);
  });

  it('rejects yaw motors reversed DISABLED', () => {
    expectMismatch(staticBinding({yawMotorsReversedConfigured: false}), versionBinding(), [
      'YAW_MOTORS_REVERSED_ENABLED',
    ]);
  });

  it('rejects bidirectional DShot enabled', () => {
    expectMismatch(staticBinding({dshotTelemetryRaw: 1}), versionBinding(), [
      'BIDIRECTIONAL_DSHOT_DISABLED',
    ]);
    expectMismatch(staticBinding({dshotTelemetryRaw: 2}), versionBinding(), [
      'BIDIRECTIONAL_DSHOT_DISABLED',
    ]);
  });
});

describe('missing, unknown and malformed values fail closed', () => {
  it('rejects undefined, null and NaN wherever the runtime can present them', () => {
    const cases: Array<[Partial<MotorStaticFacts>, MotorStaticCheckId]> = [
      [{motorCount: undefined as unknown as number}, 'MOTOR_COUNT'],
      [{motorCount: Number.NaN}, 'MOTOR_COUNT'],
      [{motorIdleRaw: undefined as unknown as number}, 'MOTOR_IDLE'],
      [{motorIdleRaw: Number.NaN}, 'MOTOR_IDLE'],
      [{motorProtocolRaw: null as unknown as number}, 'MOTOR_PROTOCOL'],
      [{mixerModeRaw: Number.POSITIVE_INFINITY}, 'MIXER_MODE'],
      [{feature3dEnabled: undefined as unknown as boolean}, 'FEATURE_3D_DISABLED'],
      [{yawMotorsReversedConfigured: undefined as unknown as boolean}, 'YAW_MOTORS_REVERSED_ENABLED'],
      [{dshotTelemetryRaw: undefined as unknown as number}, 'BIDIRECTIONAL_DSHOT_DISABLED'],
    ];
    for (const [override, expectedId] of cases) {
      expectMismatch(staticBinding(override), versionBinding(), [expectedId]);
    }
  });

  it('rejects a truthy non-boolean flag rather than coercing it', () => {
    expectMismatch(
      staticBinding({yawMotorsReversedConfigured: 1 as unknown as boolean}),
      versionBinding(),
      ['YAW_MOTORS_REVERSED_ENABLED'],
    );
  });

  it('rejects a missing or malformed version field', () => {
    expectMismatch(
      staticBinding(),
      versionBinding({versionString: undefined as unknown as string}),
      ['FIRMWARE_VERSION'],
    );
    expectMismatch(staticBinding(), versionBinding({suffix: '' as unknown as string}), [
      'FIRMWARE_VERSION',
    ]);
  });

  it('renders missing values honestly rather than throwing', () => {
    const compatibility = evaluated(
      staticBinding({motorCount: undefined as unknown as number}),
      versionBinding(),
    );
    const entry = compatibility.checks.find(item => item.checkId === 'MOTOR_COUNT');
    expect(entry?.received).toBe('MISSING');
    expect(entry?.expected).toBe('4');
  });
});

/* ------------------------------------------------------------------ *
 * Aggregation, immutability, purity
 * ------------------------------------------------------------------ */

describe('aggregation of multiple mismatches', () => {
  it('reports EVERY mismatching check, in the documented order, with no short-circuit', () => {
    const compatibility = evaluated(
      staticBinding({
        mixerModeRaw: 26,
        motorCount: 6,
        motorProtocolRaw: 6,
        motorIdleRaw: 700,
        feature3dEnabled: true,
        yawMotorsReversedConfigured: false,
        dshotTelemetryRaw: 1,
      }),
      versionBinding({patch: 5, versionString: '2025.12.5'}),
    );

    expect(compatibility.status).toBe('UNSUPPORTED');
    expect(compatibility.mismatchedCheckIds).toEqual([
      'FIRMWARE_VERSION',
      'MIXER_MODE',
      'MOTOR_COUNT',
      'MOTOR_PROTOCOL',
      'MOTOR_IDLE',
      'FEATURE_3D_DISABLED',
      'YAW_MOTORS_REVERSED_ENABLED',
      'BIDIRECTIONAL_DSHOT_DISABLED',
    ]);
    // The first check still ran and still passed - proof there is no
    // early exit on the first mismatch.
    expect(compatibility.checks[0].checkId).toBe('FIRMWARE_VARIANT');
    expect(compatibility.checks[0].status).toBe('STATIC_PROFILE_MATCH');
    expect(compatibility.checks).toHaveLength(MOTOR_STATIC_CHECK_ORDER.length);
  });

  it('reports all eleven as mismatching when everything is wrong', () => {
    const everythingWrong = staticBindingWithIdentityOverrides({
      identifier: 'INAV',
      apiVersionMajor: 2,
      targetName: 'OTHER',
    });
    const compatibility = evaluated(
      {
        sessionIdentity: everythingWrong.sessionIdentity,
        facts: {
          ...everythingWrong.facts,
          mixerModeRaw: 26,
          motorCount: 8,
          motorProtocolRaw: 0,
          motorIdleRaw: 0,
          feature3dEnabled: true,
          yawMotorsReversedConfigured: false,
          dshotTelemetryRaw: 1,
        },
      },
      versionBinding({patch: 9, versionString: '2025.12.9'}),
    );
    expect(compatibility.mismatchedCheckIds).toEqual([...MOTOR_STATIC_CHECK_ORDER]);
    expect(compatibility.status).toBe('UNSUPPORTED');
  });
});

describe('immutability and purity', () => {
  it('freezes the entire returned graph', () => {
    const result = evaluateMotorStaticCompatibility(staticBinding(), versionBinding());
    expect(result.kind).toBe('EVALUATED');
    if (result.kind !== 'EVALUATED') {
      return;
    }
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.compatibility)).toBe(true);
    expect(Object.isFrozen(result.compatibility.sessionIdentity)).toBe(true);
    expect(Object.isFrozen(result.compatibility.checks)).toBe(true);
    expect(Object.isFrozen(result.compatibility.mismatchedCheckIds)).toBe(true);
    for (const entry of result.compatibility.checks) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
    expect(Reflect.set(result.compatibility, 'status', 'SUPPORTED')).toBe(false);
    expect(Reflect.set(result.compatibility.checks[0], 'status', 'STATIC_PROFILE_MATCH')).toBe(
      false,
    );
  });

  it('freezes the NOT_EVALUATED outcome too', () => {
    const result = evaluateMotorStaticCompatibility(
      staticBinding({}, {physicalGeneration: 1, mspEpoch: 1}),
      versionBinding({}, {physicalGeneration: 2, mspEpoch: 2}),
    );
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('mutates neither input binding', () => {
    const staticInput = staticBinding();
    const versionInput = versionBinding();
    const staticSnapshot = JSON.parse(JSON.stringify(staticInput));
    const versionSnapshot = JSON.parse(JSON.stringify(versionInput));

    evaluateMotorStaticCompatibility(staticInput, versionInput);

    expect(JSON.parse(JSON.stringify(staticInput))).toEqual(staticSnapshot);
    expect(JSON.parse(JSON.stringify(versionInput))).toEqual(versionSnapshot);
  });

  it('retains no mutable reference to either input', () => {
    // The binding types are readonly, so the test holds its own MUTABLE
    // references to the very objects handed in - the post-evaluation
    // writes below are genuinely against the caller's data.
    const mutableIdentity = {physicalGeneration: 3, mspEpoch: 11};
    const mutableVersion = {
      yearOffsetRaw: 25,
      year: 2025,
      month: 12,
      patch: 2,
      versionString: '2025.12.2',
      suffix: null as string | null,
    };
    const staticInput: MotorStaticFactsBinding = {
      sessionIdentity: mutableIdentity,
      facts: supportedFacts(),
    };
    const versionInput: MotorFcFirmwareVersionBinding = {
      sessionIdentity: {physicalGeneration: 3, mspEpoch: 11},
      firmwareVersion: mutableVersion,
    };
    const compatibility = evaluated(staticInput, versionInput);

    expect(compatibility.sessionIdentity).not.toBe(mutableIdentity);
    expect(compatibility.sessionIdentity).not.toBe(versionInput.sessionIdentity);

    mutableIdentity.physicalGeneration = 99;
    mutableVersion.versionString = 'tampered';

    expect(compatibility.sessionIdentity.physicalGeneration).toBe(3);
    const versionCheck = compatibility.checks.find(e => e.checkId === 'FIRMWARE_VERSION');
    expect(versionCheck?.received).toContain('2025.12.2');
    expect(versionCheck?.received).not.toContain('tampered');
  });

  it('returns fresh objects with equal content on repeated evaluation', () => {
    const first = evaluated(staticBinding(), versionBinding());
    const second = evaluated(staticBinding(), versionBinding());
    expect(first).not.toBe(second);
    expect(first.checks).not.toBe(second.checks);
    expect(first).toEqual(second);
  });

  it('never throws on an expected configuration mismatch', () => {
    expect(() =>
      evaluateMotorStaticCompatibility(
        staticBinding({motorCount: 6, feature3dEnabled: true}),
        versionBinding({patch: 9, versionString: '2025.12.9'}),
      ),
    ).not.toThrow();
  });

  it('contains data only - it survives a JSON round trip', () => {
    const compatibility = evaluated(staticBinding(), versionBinding());
    expect(JSON.parse(JSON.stringify(compatibility))).toEqual(compatibility);
    const values = [
      ...Object.values(compatibility),
      ...compatibility.checks.flatMap(entry => Object.values(entry)),
    ];
    for (const value of values) {
      expect(typeof value).not.toBe('function');
    }
  });
});

describe('what the result deliberately does NOT claim', () => {
  it('uses no readiness, safety, authorization or permission vocabulary', () => {
    const compatibility = evaluated(staticBinding(), versionBinding());
    const keys = [
      ...Object.keys(compatibility),
      ...compatibility.checks.flatMap(entry => Object.keys(entry)),
    ];
    for (const key of keys) {
      expect(key).not.toMatch(/\bsafe\b|\bready\b|authorized|canTest|canPulse|permission/i);
    }
    expect(compatibility.status).toBe('SUPPORTED');
    // SUPPORTED is a configuration verdict, not a runtime one.
    expect(['SUPPORTED', 'UNSUPPORTED']).toContain(compatibility.status);
  });

  it('evaluates no dynamic or user-provided fact', () => {
    const compatibility = evaluated(staticBinding(), versionBinding());
    const serialized = JSON.stringify(compatibility);
    for (const forbidden of [
      'armed',
      'arming',
      'battery',
      'cellCount',
      'voltage',
      'telemetry',
      'lease',
      'stop',
      'pulse',
      'Mario',
      'BLS 55A',
      'J-H-40',
      'ECO II',
      'GNB',
      '4S',
      '6S',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(compatibility.checks.map(entry => entry.checkId)).toEqual([
      ...MOTOR_STATIC_CHECK_ORDER,
    ]);
  });
});
