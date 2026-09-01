import {
  GLOBAL_SCOPE,
  bindDraft,
  capabilityNotProven,
  capabilitySupported,
  capabilityUnsupported,
  checkBinding,
  initialWriteLifecycle,
  pidProfileIdentity,
  pidProfileScope,
  rateProfileIdentity,
  rateProfileScope,
  scopesEqual,
} from './pidTuningScope';
import {
  LPF_MAX_HZ,
  classifyField,
  classifyGroup,
  displayedCurrent,
  observedOnly,
  postWriteInvalidationFor,
  projectDynamicLowpass,
  projectFilterLimit,
  projectGyroNotch,
  withDraft,
} from './pidNormalizationModel';

describe('P-B - three scopes, kept apart', () => {
  it('distinguishes PID profiles from rate profiles at the same index', () => {
    expect(scopesEqual(pidProfileScope(1), rateProfileScope(1))).toBe(false);
    expect(scopesEqual(pidProfileScope(1), pidProfileScope(1))).toBe(true);
    expect(scopesEqual(pidProfileScope(1), pidProfileScope(2))).toBe(false);
  });

  it('treats GLOBAL as belonging to no profile', () => {
    expect(scopesEqual(GLOBAL_SCOPE, GLOBAL_SCOPE)).toBe(true);
    expect(scopesEqual(GLOBAL_SCOPE, pidProfileScope(0))).toBe(false);
  });
});

describe('P-B - a draft is bound to the profile it was read from', () => {
  const identity = pidProfileIdentity(1, 4);
  const binding = bindDraft(identity, {p: 45});

  it('stays bound while the board reports the same identity', () => {
    expect(checkBinding(binding, pidProfileIdentity(1, 4))).toEqual({kind: 'BOUND'});
  });

  it('reports a profile change when the index moves underneath it', () => {
    // This is the hazard P-A found in the reference implementation: a radio
    // switch moves the active profile while a draft is open.
    const result = checkBinding(binding, pidProfileIdentity(2, 4));
    expect(result.kind).toBe('PROFILE_CHANGED');
  });

  it('reports a change when the profile COUNT moves too', () => {
    // A board reporting a different number of profiles is not the board this
    // draft was taken from.
    expect(checkBinding(binding, pidProfileIdentity(1, 3)).kind).toBe('PROFILE_CHANGED');
  });

  it('never confuses a PID binding with a rate binding', () => {
    const rateBinding = bindDraft(rateProfileIdentity(1, 4), {rcRate: 118});
    expect(checkBinding(rateBinding, pidProfileIdentity(1, 4)).kind).toBe('PROFILE_CHANGED');
  });

  it('treats an unreported rate-profile count as its own identity', () => {
    // MSP_STATUS_EX only began carrying the count at 1.47. Absent is a fact,
    // not a four.
    const unknownCount = bindDraft(rateProfileIdentity(0, undefined), {});
    expect(checkBinding(unknownCount, rateProfileIdentity(0, undefined))).toEqual({kind: 'BOUND'});
    expect(checkBinding(unknownCount, rateProfileIdentity(0, 4)).kind).toBe('PROFILE_CHANGED');
  });
});

describe('P-B - applied and persisted are two different facts', () => {
  it('starts as neither', () => {
    expect(initialWriteLifecycle()).toEqual({applied: 'NOT_SENT', persisted: 'NOT_PERSISTED'});
  });
});

describe('P-B - what a zero on the wire proves', () => {
  it('records the evidence, not just a boolean', () => {
    expect(capabilitySupported('COMMAND_ANSWERED').kind).toBe('SUPPORTED');
    expect(capabilityUnsupported('COMMAND_ABSENT').kind).toBe('UNSUPPORTED');
  });

  it('defaults to NOT_PROVEN, because a zero is ambiguous', () => {
    // A compiled-out field and a field genuinely set to zero look identical
    // on the wire. Only a missing COMMAND is real evidence of absence.
    const unknown = capabilityNotProven();
    expect(unknown.kind).toBe('NOT_PROVEN');
    expect(unknown.because).toBe('ZERO_IS_AMBIGUOUS');
  });
});

describe('P-B - EXACT, NORMALISED and MISMATCH', () => {
  it('calls an untouched value exact', () => {
    expect(classifyField(67, 67, 67, 'TPA_RATE_CLAMPED')).toEqual({kind: 'EXACT'});
  });

  it('calls a predicted correction normalised', () => {
    // Requested 120, the firmware clamps to 100, the board reports 100.
    expect(classifyField(120, 100, 100, 'TPA_RATE_CLAMPED')).toEqual({
      kind: 'NORMALISED', requested: 120, observed: 100, rule: 'TPA_RATE_CLAMPED',
    });
  });

  it('calls an unexplained difference a mismatch', () => {
    expect(classifyField(120, 100, 55, 'TPA_RATE_CLAMPED')).toEqual({
      kind: 'MISMATCH', requested: 120, expected: 100, observed: 55,
    });
  });

  it('does not call a value normalised just because a rule was predicted', () => {
    // A rule that was predicted but did not fire leaves the value exact.
    expect(classifyField(90, 100, 90, 'TPA_RATE_CLAMPED')).toEqual({kind: 'EXACT'});
  });

  it('never lets a normalisation excuse a mismatch elsewhere', () => {
    const verdict = classifyGroup([
      {field: 'tpaRate', verdict: classifyField(120, 100, 100, 'TPA_RATE_CLAMPED')},
      {field: 'dMaxGain', verdict: classifyField(29, 29, 31, 'SIMPLIFIED_REGENERATED')},
    ]);
    expect(verdict.kind).toBe('MISMATCH');
    if (verdict.kind === 'MISMATCH') {
      expect(verdict.fields).toHaveLength(1);
      expect(verdict.fields[0].field).toBe('dMaxGain');
    }
  });

  it('reports a group as normalised when only corrections happened', () => {
    const verdict = classifyGroup([
      {field: 'tpaRate', verdict: classifyField(120, 100, 100, 'TPA_RATE_CLAMPED')},
      {field: 'angleLimit', verdict: classifyField(53, 53, 53, 'TPA_RATE_CLAMPED')},
    ]);
    expect(verdict.kind).toBe('NORMALISED');
  });

  it('reports a clean group as exact', () => {
    expect(classifyGroup([
      {field: 'a', verdict: classifyField(1, 1, 1, 'TPA_RATE_CLAMPED')},
    ])).toEqual({kind: 'EXACT'});
  });
});

describe('P-B - the filter corrections the firmware performs', () => {
  it('resets rather than clamps, and the reset value differs by field', () => {
    expect(LPF_MAX_HZ).toBe(1000);
    // A lowpass above the ceiling becomes the ceiling...
    expect(projectFilterLimit(1500, LPF_MAX_HZ)).toBe(1000);
    // ...but a notch CUTOFF above the ceiling becomes zero, not 1000.
    expect(projectFilterLimit(1500, 0)).toBe(0);
    expect(projectFilterLimit(900, LPF_MAX_HZ)).toBe(900);
  });

  it('switches a notch off by zeroing its centre when the cutoff is not below it', () => {
    expect(projectGyroNotch({centreHz: 200, cutoffHz: 200})).toEqual({centreHz: 0, cutoffHz: 200});
    expect(projectGyroNotch({centreHz: 200, cutoffHz: 260})).toEqual({centreHz: 0, cutoffHz: 260});
    expect(projectGyroNotch({centreHz: 233, cutoffHz: 147})).toEqual({centreHz: 233, cutoffHz: 147});
  });

  it('zeroes a dynamic minimum that exceeds its maximum, leaving the maximum', () => {
    expect(projectDynamicLowpass({minHz: 600, maxHz: 500})).toEqual({minHz: 0, maxHz: 500});
    expect(projectDynamicLowpass({minHz: 213, maxHz: 517})).toEqual({minHz: 213, maxHz: 517});
  });
});

describe('P-B - what has to be re-read after a write', () => {
  it('names all three truths a filter write can disturb', () => {
    const invalidation = postWriteInvalidationFor('FILTER_CONFIG');
    expect(invalidation.requiresReobserve).toEqual([
      'MSP_FILTER_CONFIG', 'MSP_ADVANCED_CONFIG', 'MSP_STATUS_EX',
    ]);
    expect(invalidation.reasons.length).toBeGreaterThan(3);
  });

  it('explains why the advanced configuration is in the set', () => {
    // pid_process_denom, the motor protocol and the motor PWM rate all live
    // behind MSP_ADVANCED_CONFIG, and a filter save can move all three.
    const reasons = postWriteInvalidationFor('FILTER_CONFIG').reasons.join(' ');
    expect(reasons).toContain('pid_process_denom');
    expect(reasons).toContain('motor protocol');
  });

  it('knows a simplified write invalidates the values it regenerates', () => {
    const invalidation = postWriteInvalidationFor('SIMPLIFIED_TUNING');
    expect(invalidation.requiresReobserve).toContain('MSP_FILTER_CONFIG');
    expect(invalidation.reasons.join(' ')).toContain('overwrites');
  });

  it('knows a profile command can move the active identity', () => {
    for (const group of ['SELECT_SETTING', 'COPY_PROFILE', 'RESET_PID_PROFILE'] as const) {
      expect(postWriteInvalidationFor(group).requiresReobserve).toContain('MSP_STATUS_EX');
    }
  });

  it('asks for nothing after a plain PID write', () => {
    expect(postWriteInvalidationFor('PID').requiresReobserve).toHaveLength(0);
    expect(postWriteInvalidationFor('RC_TUNING').requiresReobserve).toHaveLength(0);
  });
});

describe('P-B - observed, draft and projected are three different values', () => {
  it('starts with only an observation', () => {
    const truth = observedOnly(45);
    expect(truth.observed).toBe(45);
    expect(truth.draft).toBeUndefined();
    expect(truth.projected).toBeUndefined();
  });

  it('adds a draft and a projection without disturbing the observation', () => {
    const truth = withDraft(observedOnly(45), 113, 49);
    expect(truth.observed).toBe(45);
    expect(truth.draft).toBe(113);
    expect(truth.projected).toBe(49);
  });

  it('shows the observation as current, never the projection', () => {
    // A projection is a prediction about a write that has not happened. A UI
    // that displayed it as current would be telling a pilot their aircraft
    // holds a tune it has never been sent.
    const truth = withDraft(observedOnly(45), 113, 49);
    expect(displayedCurrent(truth)).toBe(45);
    expect(displayedCurrent(truth)).not.toBe(truth.projected);
  });

  it('does not mutate the value it was handed', () => {
    const before = observedOnly(45);
    withDraft(before, 113, 49);
    expect(before.draft).toBeUndefined();
    expect(before.projected).toBeUndefined();
  });
});
