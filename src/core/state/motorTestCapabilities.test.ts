/**
 * Phase 2B - tests for the pure, session-bound motor-test capability
 * snapshot.
 *
 * NO HARDWARE, NO PROTOCOL, NO TRANSPORT, NO TIMERS. Every input is a
 * hand-written plain object and the module under test performs no I/O.
 *
 * These tests exercise the REAL exported implementation. The approved
 * profile is taken from the module's own exported constant rather than
 * restated here, so the tests cannot drift into re-implementing the
 * composer they are meant to check - and equally cannot silently agree
 * with a wrong expectation of their own making.
 *
 * The forbidden-token scan at the bottom builds every needle by string
 * concatenation, so the literals it forbids appear in neither file.
 */

import {readFileSync} from 'fs';
import {join} from 'path';

import {
  composeMotorTestCapabilities,
  isMotorTestProfileSupported,
  MOTOR_TEST_SUPPORTED_PROFILE,
  type MotorTestCapabilities,
  type MotorTestCapabilityBlocker,
  type MotorTestProfileEvidence,
  type MotorTestProfileFact,
  type MotorTestSessionAuthority,
} from './motorTestCapabilities';

/** Two distinct opaque authorities. Identity is all that matters. */
const AUTHORITY: MotorTestSessionAuthority = {};
const OTHER_AUTHORITY: MotorTestSessionAuthority = {};

/** A mutable, caller-owned evidence object that exactly matches the
 * approved profile. Deliberately a fresh object per call. */
function approvedEvidence(): Record<string, unknown> {
  return {...MOTOR_TEST_SUPPORTED_PROFILE};
}

function compose(
  evidence: MotorTestProfileEvidence,
  authority: MotorTestSessionAuthority = AUTHORITY,
): MotorTestCapabilities {
  return composeMotorTestCapabilities(authority, evidence);
}

const facts = (blockers: readonly MotorTestCapabilityBlocker[]): string[] =>
  blockers.map(blocker => blocker.fact);

function blockerFor(
  result: MotorTestCapabilities,
  fact: MotorTestProfileFact,
): MotorTestCapabilityBlocker {
  const found = result.blockers.find(blocker => blocker.fact === fact);
  if (found === undefined) {
    throw new Error(`expected a blocker for ${fact}`);
  }
  return found;
}

/** Every evidence field, with the fact it feeds, one malformed value and
 * one well-formed but unapproved value. */
const FIELD_CASES: readonly {
  readonly field: string;
  readonly fact: MotorTestProfileFact;
  readonly malformed: unknown;
  readonly unsupported: unknown;
}[] = [
  {
    field: 'fcVariantIdentifier',
    fact: 'FC_VARIANT',
    malformed: 4,
    unsupported: 'INAV',
  },
  {
    field: 'apiVersionMajor',
    fact: 'MSP_API_VERSION',
    malformed: Number.NaN,
    unsupported: 2,
  },
  {
    field: 'apiVersionMinor',
    fact: 'MSP_API_VERSION',
    malformed: Number.POSITIVE_INFINITY,
    unsupported: 46,
  },
  {
    field: 'firmwareYear',
    fact: 'FIRMWARE_VERSION',
    malformed: '2025',
    unsupported: 2024,
  },
  {
    field: 'firmwareMonth',
    fact: 'FIRMWARE_VERSION',
    malformed: 12.5,
    unsupported: 11,
  },
  {
    field: 'firmwarePatch',
    fact: 'FIRMWARE_VERSION',
    malformed: Number.NEGATIVE_INFINITY,
    unsupported: 3,
  },
  {
    field: 'boardTargetName',
    fact: 'BOARD_TARGET',
    malformed: null,
    unsupported: 'SPEEDYBEEF405',
  },
  {
    field: 'mixerProfile',
    fact: 'MIXER_PROFILE',
    malformed: {},
    unsupported: 'QUAD_X_1234',
  },
  {
    field: 'motorCount',
    fact: 'MOTOR_COUNT',
    malformed: '4',
    unsupported: 6,
  },
  {
    field: 'motorProtocol',
    fact: 'MOTOR_PROTOCOL',
    malformed: true,
    unsupported: 'DSHOT300',
  },
  {
    field: 'motorIdleHundredthsPercent',
    fact: 'MOTOR_IDLE',
    // 5.5 is the PERCENT, not the normalized hundredths - a real unit
    // mistake, and fractional, so it is unusable rather than merely
    // different.
    malformed: 5.5,
    unsupported: 551,
  },
  {
    field: 'feature3dEnabled',
    fact: 'FEATURE_3D',
    malformed: 'false',
    unsupported: true,
  },
  {
    field: 'propsOutConfigured',
    fact: 'PROPS_OUT_CONFIGURATION',
    malformed: 1,
    unsupported: false,
  },
  {
    field: 'bidirectionalDshotEnabled',
    fact: 'BIDIRECTIONAL_DSHOT',
    malformed: 0,
    unsupported: true,
  },
];

/** The module's own declared evaluation order. */
const EXPECTED_FACT_ORDER: readonly MotorTestProfileFact[] = [
  'FC_VARIANT',
  'MSP_API_VERSION',
  'FIRMWARE_VERSION',
  'BOARD_TARGET',
  'MIXER_PROFILE',
  'MOTOR_COUNT',
  'MOTOR_PROTOCOL',
  'MOTOR_IDLE',
  'FEATURE_3D',
  'PROPS_OUT_CONFIGURATION',
  'BIDIRECTIONAL_DSHOT',
];

/* ================================================================== *
 * The approved profile
 * ================================================================== */

describe('the approved profile', () => {
  it('accepts the exact approved evidence and reports zero blockers', () => {
    const result = compose(approvedEvidence());
    expect(result.status).toBe('PROFILE_SUPPORTED');
    expect(result.blockers).toEqual([]);
    expect(result.blockers).toHaveLength(0);
    expect(isMotorTestProfileSupported(result)).toBe(true);
  });

  it('exposes a normalized snapshot equal to the approved profile', () => {
    const result = compose(approvedEvidence());
    if (result.status !== 'PROFILE_SUPPORTED') {
      throw new Error('expected PROFILE_SUPPORTED');
    }
    expect(result.profile).toEqual({...MOTOR_TEST_SUPPORTED_PROFILE});
    // Never the shared constant itself - a fresh frozen copy.
    expect(result.profile).not.toBe(MOTOR_TEST_SUPPORTED_PROFILE);
  });

  it('pins the documented normalization units', () => {
    // 5.5% expressed in hundredths of a percent, exactly.
    expect(MOTOR_TEST_SUPPORTED_PROFILE.motorIdleHundredthsPercent).toBe(550);
    // Full calendar year, already offset-corrected by the adapter.
    expect(MOTOR_TEST_SUPPORTED_PROFILE.firmwareYear).toBe(2025);
    expect(MOTOR_TEST_SUPPORTED_PROFILE.firmwareMonth).toBe(12);
    expect(MOTOR_TEST_SUPPORTED_PROFILE.firmwarePatch).toBe(2);
    expect(MOTOR_TEST_SUPPORTED_PROFILE.apiVersionMajor).toBe(1);
    expect(MOTOR_TEST_SUPPORTED_PROFILE.apiVersionMinor).toBe(47);
    expect(MOTOR_TEST_SUPPORTED_PROFILE.motorCount).toBe(4);
    expect(MOTOR_TEST_SUPPORTED_PROFILE.fcVariantIdentifier).toBe('BTFL');
    expect(MOTOR_TEST_SUPPORTED_PROFILE.boardTargetName).toBe(
      'SPEEDYBEEF405V4',
    );
    expect(MOTOR_TEST_SUPPORTED_PROFILE.mixerProfile).toBe('QUAD_X');
    expect(MOTOR_TEST_SUPPORTED_PROFILE.motorProtocol).toBe('DSHOT600');
    expect(MOTOR_TEST_SUPPORTED_PROFILE.feature3dEnabled).toBe(false);
    expect(MOTOR_TEST_SUPPORTED_PROFILE.propsOutConfigured).toBe(true);
    expect(MOTOR_TEST_SUPPORTED_PROFILE.bidirectionalDshotEnabled).toBe(false);
  });
});

/* ================================================================== *
 * Session authority
 * ================================================================== */

describe('session-authority binding', () => {
  it('retains the EXACT authority reference on a supported result', () => {
    const result = compose(approvedEvidence(), AUTHORITY);
    expect(result.authority).toBe(AUTHORITY);
  });

  it('retains the EXACT authority reference on an unsupported result', () => {
    const result = compose({}, OTHER_AUTHORITY);
    expect(result.status).toBe('PROFILE_UNSUPPORTED');
    expect(result.authority).toBe(OTHER_AUTHORITY);
  });

  it('never clones or rebuilds the authority', () => {
    const first = compose(approvedEvidence(), AUTHORITY);
    const second = compose(approvedEvidence(), AUTHORITY);
    expect(first.authority).toBe(second.authority);
    expect(first.authority).toBe(AUTHORITY);
    // Identity-based, so two structurally identical authorities are NOT
    // interchangeable.
    expect(compose(approvedEvidence(), {}).authority).not.toBe(AUTHORITY);
  });

  it('binds different authorities to independent results', () => {
    const evidence = approvedEvidence();
    const a = compose(evidence, AUTHORITY);
    const b = compose(evidence, OTHER_AUTHORITY);
    expect(a).not.toBe(b);
    expect(a.authority).toBe(AUTHORITY);
    expect(b.authority).toBe(OTHER_AUTHORITY);
  });
});

/* ================================================================== *
 * Fail-closed rules
 * ================================================================== */

describe('fail-closed evaluation', () => {
  it('rejects a completely empty evidence object with every fact blocked', () => {
    const result = compose({});
    expect(result.status).toBe('PROFILE_UNSUPPORTED');
    expect(facts(result.blockers)).toEqual([...EXPECTED_FACT_ORDER]);
    for (const blocker of result.blockers) {
      expect(blocker.kind).toBe('EVIDENCE_MISSING_OR_INVALID');
    }
  });

  it.each(FIELD_CASES.map(c => [c.field, c.fact] as const))(
    'a MISSING %s blocks %s as missing-or-invalid',
    (field, fact) => {
      const evidence = approvedEvidence();
      delete evidence[field];
      const result = compose(evidence);
      expect(result.status).toBe('PROFILE_UNSUPPORTED');
      expect(blockerFor(result, fact).kind).toBe('EVIDENCE_MISSING_OR_INVALID');
    },
  );

  it.each(FIELD_CASES.map(c => [c.field, c.fact, c.malformed] as const))(
    'a MALFORMED %s blocks %s as missing-or-invalid',
    (field, fact, malformed) => {
      const evidence = approvedEvidence();
      evidence[field] = malformed;
      const result = compose(evidence);
      expect(result.status).toBe('PROFILE_UNSUPPORTED');
      expect(blockerFor(result, fact).kind).toBe('EVIDENCE_MISSING_OR_INVALID');
    },
  );

  it.each(FIELD_CASES.map(c => [c.field, c.fact, c.unsupported] as const))(
    'a valid but UNAPPROVED %s blocks %s as unsupported',
    (field, fact, unsupported) => {
      const evidence = approvedEvidence();
      evidence[field] = unsupported;
      const result = compose(evidence);
      expect(result.status).toBe('PROFILE_UNSUPPORTED');
      expect(blockerFor(result, fact).kind).toBe('EVIDENCE_UNSUPPORTED');
    },
  );

  it.each([
    ['btfl', 'lower case'],
    ['Btfl', 'mixed case'],
    [' BTFL', 'leading space'],
    ['BTFL ', 'trailing space'],
    ['\tBTFL\n', 'surrounding whitespace'],
    ['BTFL\u0000', 'trailing NUL'],
    ['BT FL', 'internal space'],
  ])('rejects %s (%s) rather than normalizing it', variant => {
    const evidence = approvedEvidence();
    evidence.fcVariantIdentifier = variant;
    const result = compose(evidence);
    expect(result.status).toBe('PROFILE_UNSUPPORTED');
    expect(blockerFor(result, 'FC_VARIANT').kind).toBe('EVIDENCE_UNSUPPORTED');
  });

  it.each([
    ['SPEEDYBEEF405V4 ', 'trailing space'],
    ['speedybeef405v4', 'lower case'],
  ])('rejects target %s (%s)', variant => {
    const evidence = approvedEvidence();
    evidence.boardTargetName = variant;
    expect(compose(evidence).status).toBe('PROFILE_UNSUPPORTED');
  });

  it.each([
    ['NaN', Number.NaN],
    ['+Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['fractional', 550.5],
    ['unit mistake 5.5', 5.5],
  ])('rejects a %s motor idle as unusable evidence', (_label, value) => {
    const evidence = approvedEvidence();
    evidence.motorIdleHundredthsPercent = value;
    const result = compose(evidence);
    expect(result.status).toBe('PROFILE_UNSUPPORTED');
    expect(blockerFor(result, 'MOTOR_IDLE').kind).toBe(
      'EVIDENCE_MISSING_OR_INVALID',
    );
  });

  it.each([549, 551, 0, -550])(
    'rejects a near-but-not-equal motor idle of %s as unsupported',
    value => {
      const evidence = approvedEvidence();
      evidence.motorIdleHundredthsPercent = value;
      const result = compose(evidence);
      expect(result.status).toBe('PROFILE_UNSUPPORTED');
      expect(blockerFor(result, 'MOTOR_IDLE').kind).toBe('EVIDENCE_UNSUPPORTED');
    },
  );

  it.each([
    ['motorCount', -4],
    ['apiVersionMinor', -47],
    ['firmwareYear', -2025],
  ])('rejects a negative %s', (field, value) => {
    const evidence = approvedEvidence();
    evidence[field] = value;
    expect(compose(evidence).status).toBe('PROFILE_UNSUPPORTED');
  });

  it.each([
    ['apiVersionMajor', 1.5],
    ['apiVersionMinor', 47.1],
    ['firmwareYear', 2025.5],
    ['firmwareMonth', 12.5],
    ['firmwarePatch', 2.5],
  ])('rejects a fractional version component %s', (field, value) => {
    const evidence = approvedEvidence();
    evidence[field] = value;
    const result = compose(evidence);
    expect(result.status).toBe('PROFILE_UNSUPPORTED');
    for (const blocker of result.blockers) {
      expect(blocker.kind).toBe('EVIDENCE_MISSING_OR_INVALID');
    }
  });

  it('gives no missing value a permissive default', () => {
    // Removing any single field must break the profile - there is no
    // field the composer is willing to assume.
    for (const {field} of FIELD_CASES) {
      const evidence = approvedEvidence();
      delete evidence[field];
      expect(compose(evidence).status).toBe('PROFILE_UNSUPPORTED');
    }
  });

  it('never throws for any unsupported or hostile evidence', () => {
    const hostile: readonly unknown[] = [
      {},
      {fcVariantIdentifier: null},
      {fcVariantIdentifier: Symbol('x')},
      {motorCount: {valueOf: () => 4}},
      {apiVersionMajor: []},
      {motorProtocol: ['DSHOT600']},
      {feature3dEnabled: null},
      Object.create(null),
    ];
    for (const evidence of hostile) {
      expect(() =>
        compose(evidence as MotorTestProfileEvidence),
      ).not.toThrow();
      expect(compose(evidence as MotorTestProfileEvidence).status).toBe(
        'PROFILE_UNSUPPORTED',
      );
    }
  });
});

/* ================================================================== *
 * Blocker taxonomy and ordering
 * ================================================================== */

describe('blocker list', () => {
  it('reports every failure, in the module-owned order', () => {
    const evidence = approvedEvidence();
    evidence.bidirectionalDshotEnabled = true;
    evidence.fcVariantIdentifier = 'INAV';
    evidence.motorCount = 6;
    evidence.mixerProfile = 'QUAD_X_1234';
    const result = compose(evidence);
    expect(facts(result.blockers)).toEqual([
      'FC_VARIANT',
      'MIXER_PROFILE',
      'MOTOR_COUNT',
      'BIDIRECTIONAL_DSHOT',
    ]);
  });

  it('order depends on the module, NOT on caller key order', () => {
    const broken = {
      bidirectionalDshotEnabled: true,
      motorCount: 6,
      fcVariantIdentifier: 'INAV',
    };
    const reversed = {
      fcVariantIdentifier: 'INAV',
      motorCount: 6,
      bidirectionalDshotEnabled: true,
    };
    const a = compose({...approvedEvidence(), ...broken});
    const b = compose({...approvedEvidence(), ...reversed});
    expect(facts(a.blockers)).toEqual(facts(b.blockers));
    expect(facts(a.blockers)).toEqual([
      'FC_VARIANT',
      'MOTOR_COUNT',
      'BIDIRECTIONAL_DSHOT',
    ]);
  });

  it('is stable across repeated identical calls', () => {
    const evidence = {...approvedEvidence(), motorCount: 6, motorProtocol: 'X'};
    const first = facts(compose(evidence).blockers);
    for (let i = 0; i < 5; i += 1) {
      expect(facts(compose(evidence).blockers)).toEqual(first);
    }
  });

  it('is duplicate-free even when one fact has several bad components', () => {
    const evidence = approvedEvidence();
    evidence.apiVersionMajor = 2;
    evidence.apiVersionMinor = 46;
    evidence.firmwareYear = 2024;
    evidence.firmwareMonth = 11;
    evidence.firmwarePatch = 3;
    const result = compose(evidence);
    expect(facts(result.blockers)).toEqual([
      'MSP_API_VERSION',
      'FIRMWARE_VERSION',
    ]);
    expect(new Set(facts(result.blockers)).size).toBe(result.blockers.length);
  });

  it('reports unusable evidence when a multi-part fact is partly unreadable', () => {
    const evidence = approvedEvidence();
    evidence.apiVersionMajor = 2; // unsupported
    evidence.apiVersionMinor = Number.NaN; // unusable
    // Unusable outranks unsupported: the fact was never established.
    expect(blockerFor(compose(evidence), 'MSP_API_VERSION').kind).toBe(
      'EVIDENCE_MISSING_OR_INVALID',
    );
  });

  it('distinguishes the two blocker kinds within one result', () => {
    const evidence = approvedEvidence();
    evidence.fcVariantIdentifier = 'INAV'; // unsupported
    evidence.motorCount = '4'; // unusable
    const result = compose(evidence);
    expect(blockerFor(result, 'FC_VARIANT').kind).toBe('EVIDENCE_UNSUPPORTED');
    expect(blockerFor(result, 'MOTOR_COUNT').kind).toBe(
      'EVIDENCE_MISSING_OR_INVALID',
    );
  });

  it('exposes no profile snapshot on an unsupported result', () => {
    const result = compose({});
    expect(Object.keys(result)).not.toContain('profile');
    expect(Object.keys(result).sort()).toEqual(
      ['authority', 'blockers', 'status'].sort(),
    );
  });
});

/* ================================================================== *
 * Deep immutability and detachment
 * ================================================================== */

describe('deep immutability', () => {
  it('freezes the result, the profile, the blocker array and each blocker', () => {
    const supported = compose(approvedEvidence());
    expect(Object.isFrozen(supported)).toBe(true);
    expect(Object.isFrozen(supported.blockers)).toBe(true);
    if (supported.status !== 'PROFILE_SUPPORTED') {
      throw new Error('expected PROFILE_SUPPORTED');
    }
    expect(Object.isFrozen(supported.profile)).toBe(true);

    const unsupported = compose({});
    expect(Object.isFrozen(unsupported)).toBe(true);
    expect(Object.isFrozen(unsupported.blockers)).toBe(true);
    for (const blocker of unsupported.blockers) {
      expect(Object.isFrozen(blocker)).toBe(true);
    }
  });

  it('freezes the exported approved-profile constant', () => {
    expect(Object.isFrozen(MOTOR_TEST_SUPPORTED_PROFILE)).toBe(true);
    expect(
      Reflect.set(MOTOR_TEST_SUPPORTED_PROFILE, 'motorCount', 6),
    ).toBe(false);
    expect(MOTOR_TEST_SUPPORTED_PROFILE.motorCount).toBe(4);
  });

  it('rejects real mutation and deletion on every exposed layer', () => {
    const result = compose(approvedEvidence());
    if (result.status !== 'PROFILE_SUPPORTED') {
      throw new Error('expected PROFILE_SUPPORTED');
    }
    const before = JSON.stringify(result);

    expect(Reflect.set(result, 'status', 'PROFILE_UNSUPPORTED')).toBe(false);
    expect(Reflect.set(result, 'authority', {})).toBe(false);
    expect(Reflect.set(result, 'profile', {})).toBe(false);
    expect(Reflect.set(result, 'blockers', [{fact: 'X'}])).toBe(false);
    expect(Reflect.deleteProperty(result, 'status')).toBe(false);
    expect(Reflect.deleteProperty(result, 'profile')).toBe(false);

    expect(Reflect.set(result.profile, 'motorCount', 6)).toBe(false);
    expect(Reflect.set(result.profile, 'feature3dEnabled', true)).toBe(false);
    expect(Reflect.deleteProperty(result.profile, 'motorCount')).toBe(false);

    expect(JSON.stringify(result)).toBe(before);
    expect(result.status).toBe('PROFILE_SUPPORTED');
    expect(result.profile.motorCount).toBe(4);
    expect(result.authority).toBe(AUTHORITY);
  });

  it('rejects mutation and deletion on blockers and the blocker array', () => {
    const result = compose({});
    const before = JSON.stringify(result);
    const first = result.blockers[0];

    expect(Reflect.set(first, 'fact', 'MOTOR_COUNT')).toBe(false);
    expect(Reflect.set(first, 'kind', 'EVIDENCE_UNSUPPORTED')).toBe(false);
    expect(Reflect.deleteProperty(first, 'fact')).toBe(false);
    expect(Reflect.set(result.blockers, 0, {fact: 'X', kind: 'Y'})).toBe(false);
    expect(Reflect.deleteProperty(result.blockers, 0)).toBe(false);

    expect(JSON.stringify(result)).toBe(before);
    expect(result.blockers[0]).toBe(first);
  });

  it('cannot be pushed to, popped from, or length-truncated', () => {
    const result = compose({});
    const length = result.blockers.length;
    const mutable = result.blockers as MotorTestCapabilityBlocker[];
    expect(() => mutable.push({fact: 'FC_VARIANT', kind: 'EVIDENCE_UNSUPPORTED'}))
      .toThrow();
    expect(() => mutable.pop()).toThrow();
    expect(Reflect.set(result.blockers, 'length', 0)).toBe(false);
    expect(result.blockers).toHaveLength(length);
  });

  it('freezes the shared empty blocker array of a supported result', () => {
    const result = compose(approvedEvidence());
    expect(Object.isFrozen(result.blockers)).toBe(true);
    expect(result.blockers).toHaveLength(0);
    expect(() =>
      (result.blockers as MotorTestCapabilityBlocker[]).push({
        fact: 'FC_VARIANT',
        kind: 'EVIDENCE_UNSUPPORTED',
      }),
    ).toThrow();
    expect(result.blockers).toHaveLength(0);
  });

  it('is detached: mutating the input afterwards cannot change the result', () => {
    const evidence = approvedEvidence();
    const result = compose(evidence);
    if (result.status !== 'PROFILE_SUPPORTED') {
      throw new Error('expected PROFILE_SUPPORTED');
    }
    const before = JSON.stringify(result);

    evidence.motorCount = 6;
    evidence.fcVariantIdentifier = 'INAV';
    evidence.feature3dEnabled = true;
    delete evidence.motorProtocol;

    expect(JSON.stringify(result)).toBe(before);
    expect(result.profile.motorCount).toBe(4);
    expect(result.profile.fcVariantIdentifier).toBe('BTFL');
    expect(result.profile.feature3dEnabled).toBe(false);
  });

  it('creates no aliasing when one input object is reused', () => {
    const evidence = approvedEvidence();
    const first = compose(evidence, AUTHORITY);
    const second = compose(evidence, OTHER_AUTHORITY);
    if (
      first.status !== 'PROFILE_SUPPORTED' ||
      second.status !== 'PROFILE_SUPPORTED'
    ) {
      throw new Error('expected both PROFILE_SUPPORTED');
    }
    expect(first).not.toBe(second);
    expect(first.profile).not.toBe(second.profile);
    expect(first.profile).toEqual(second.profile);
    // Neither shares storage with the caller's object.
    expect(first.profile as unknown).not.toBe(evidence);
    expect(second.profile as unknown).not.toBe(evidence);
  });

  it('is deterministic - same authority and evidence give an equal result', () => {
    const evidence = approvedEvidence();
    expect(compose(evidence)).toEqual(compose(evidence));
    const broken = {...approvedEvidence(), motorCount: 6};
    expect(compose(broken)).toEqual(compose(broken));
  });
});

/* ================================================================== *
 * Inertness - the result confers nothing
 * ================================================================== */

describe('the result is inert data', () => {
  /** Walks the whole exposed graph, skipping only the intentionally
   * opaque authority reference. */
  function walk(value: unknown, visit: (v: unknown, path: string) => void) {
    const seen = new Set<unknown>();
    const inner = (node: unknown, path: string) => {
      visit(node, path);
      if (node === null || typeof node !== 'object' || seen.has(node)) {
        return;
      }
      seen.add(node);
      for (const [key, child] of Object.entries(node)) {
        if (key === 'authority') {
          continue;
        }
        inner(child, `${path}.${key}`);
      }
    };
    inner(value, 'result');
  }

  it.each([
    ['supported', () => compose(approvedEvidence())],
    ['unsupported', () => compose({})],
  ])('a %s result exposes no function anywhere', (_label, build) => {
    walk(build(), (node, path) => {
      expect(typeof node).not.toBe('function');
      expect(path).toBeTruthy();
    });
  });

  it.each([
    ['supported', () => compose(approvedEvidence())],
    ['unsupported', () => compose({})],
  ])('every object in a %s result is frozen', (_label, build) => {
    walk(build(), node => {
      if (node !== null && typeof node === 'object') {
        expect(Object.isFrozen(node)).toBe(true);
      }
    });
  });

  it('exposes no command, payload, client, transport, lease or handle key', () => {
    const keys: string[] = [];
    walk(compose(approvedEvidence()), node => {
      if (node !== null && typeof node === 'object') {
        keys.push(...Object.keys(node));
      }
    });
    for (const forbidden of [
      'command',
      'commandId',
      'payload',
      'bytes',
      'buffer',
      'client',
      'transport',
      'requester',
      'writer',
      'lease',
      'token',
      'handle',
      'motorIndex',
      'motorValue',
      'stopValue',
      'pulse',
      'vector',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('exposes no authorization-shaped key - supported is not permission', () => {
    const keys: string[] = [];
    walk(compose(approvedEvidence()), node => {
      if (node !== null && typeof node === 'object') {
        keys.push(...Object.keys(node));
      }
    });
    for (const forbidden of [
      'authorized',
      'allowed',
      'permitted',
      'safe',
      'ready',
      'armed',
      'canStart',
      'canSend',
      'verdict',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
    // The discriminant says PROFILE, not READY or AUTHORIZED.
    expect(compose(approvedEvidence()).status).toBe('PROFILE_SUPPORTED');
  });
});

/* ================================================================== *
 * Structural containment
 * ================================================================== */

describe('structural containment', () => {
  const dir = __dirname;
  const source = readFileSync(join(dir, 'motorTestCapabilities.ts'), 'utf8');
  const testSource = readFileSync(
    join(dir, 'motorTestCapabilities.test.ts'),
    'utf8',
  );

  it('has exactly one import, and it is type-only', () => {
    const imports = source.match(/^\s*import[^\n]*$/gm) ?? [];
    expect(imports).toHaveLength(1);
    expect(imports[0]).toContain('import type');
    expect(imports[0]).toContain('./motorTestStateMachine');
    expect(source).not.toMatch(/\brequire\s*\(/);
  });

  /** Built by concatenation so the literals appear in neither file. */
  const FORBIDDEN: readonly string[] = [
    'MSP' + '_SET_' + 'MOTOR',
    '2' + '14',
    'Msp' + 'Client',
    'RNMsp' + 'Transport',
    'write' + 'Bytes',
    'requestWith' + 'MotorTestLease',
    'Uint8' + 'Array',
    'set' + 'Timeout',
    'set' + 'Interval',
  ];

  it.each(FORBIDDEN)('neither file contains %s', token => {
    expect(source).not.toContain(token);
    expect(testSource).not.toContain(token);
  });

  it('has no I/O, timer, clock, randomness, async work or mutable registry', () => {
    for (const token of [
      'Promise',
      'async ',
      'await ',
      'Date',
      'Math.random',
      'new Map',
      'new Set',
      'WeakMap',
      'WeakSet',
      'fetch',
      'process.',
      'console.',
      'globalThis',
    ]) {
      expect(source).not.toContain(token);
    }
  });

  it('documents that PROFILE_SUPPORTED is not authorization', () => {
    expect(source).toContain('STATIC PROFILE COMPATIBILITY');
    expect(source).toContain(
      'It does NOT mean, and must never be read as meaning, that motor testing',
    );
    expect(source).toContain('is authorized, safe, ready, armed-safe');
  });

  it('is not exported from any barrel', () => {
    for (const barrel of ['index.ts', '../index.ts']) {
      const contents = readFileSync(join(dir, barrel), 'utf8');
      expect(contents).not.toContain('motorTestCapabilities');
      expect(contents).not.toContain('composeMotorTestCapabilities');
    }
  });
});
