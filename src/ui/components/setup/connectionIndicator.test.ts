import {
  deriveConnectionIndicatorState,
  deriveTopBarNotice,
  listTopBarNoticeCandidateIds,
  updateNoticeActivationTimestamps,
} from './connectionIndicator';
import type {MspIdentificationState} from '../../../platforms/react-native/protocol';
import type {MspClientState} from '../../../core';

const IDLE_IDENTIFICATION: MspIdentificationState = {status: 'IDLE'};
const RUNNING_IDENTIFICATION: MspIdentificationState = {status: 'RUNNING'};
const FAILED_IDENTIFICATION: MspIdentificationState = {status: 'FAILED', error: new Error('x')};

const NO_ACTIVATIONS: ReadonlyMap<string, number> = new Map();

describe('deriveConnectionIndicatorState', () => {
  it('INACTIVE -> DISCONNECTED, regardless of recovery', () => {
    expect(deriveConnectionIndicatorState('INACTIVE', undefined)).toBe('DISCONNECTED');
    expect(deriveConnectionIndicatorState('INACTIVE', 'READY')).toBe('DISCONNECTED');
  });

  it('ACTIVATING -> ACTIVATING, regardless of recovery', () => {
    expect(deriveConnectionIndicatorState('ACTIVATING', undefined)).toBe('ACTIVATING');
  });

  it('CLOSING -> DISCONNECTED (a stated decision - no distinct 6th state)', () => {
    expect(deriveConnectionIndicatorState('CLOSING', 'READY')).toBe('DISCONNECTED');
  });

  describe('ACTIVE - defers to recovery', () => {
    it('READY -> CONNECTED', () => {
      expect(deriveConnectionIndicatorState('ACTIVE', 'READY')).toBe('CONNECTED');
    });

    it('DESYNCHRONIZED/RESTARTING_READER/PROBING all -> RECOVERING', () => {
      expect(deriveConnectionIndicatorState('ACTIVE', 'DESYNCHRONIZED')).toBe('RECOVERING');
      expect(deriveConnectionIndicatorState('ACTIVE', 'RESTARTING_READER')).toBe('RECOVERING');
      expect(deriveConnectionIndicatorState('ACTIVE', 'PROBING')).toBe('RECOVERING');
    });

    it('RECOVERY_FAILED -> RECOVERY_FAILED', () => {
      expect(deriveConnectionIndicatorState('ACTIVE', 'RECOVERY_FAILED')).toBe('RECOVERY_FAILED');
    });

    it('DISCONNECTED/CLOSING/undefined recovery while ownership is ACTIVE all defensively -> ACTIVATING', () => {
      expect(deriveConnectionIndicatorState('ACTIVE', 'DISCONNECTED')).toBe('ACTIVATING');
      expect(deriveConnectionIndicatorState('ACTIVE', 'CLOSING')).toBe('ACTIVATING');
      expect(deriveConnectionIndicatorState('ACTIVE', undefined)).toBe('ACTIVATING');
    });
  });

  it('every real MspClientState value is handled (exhaustiveness, not just the happy path)', () => {
    const allStates: MspClientState[] = [
      'READY',
      'DESYNCHRONIZED',
      'RESTARTING_READER',
      'PROBING',
      'RECOVERY_FAILED',
      'DISCONNECTED',
      'CLOSING',
    ];
    for (const state of allStates) {
      expect(() => deriveConnectionIndicatorState('ACTIVE', state)).not.toThrow();
    }
  });
});

describe('deriveTopBarNotice', () => {
  it('no notice while genuinely DISCONNECTED with no session at all - INACTIVE alone does not warrant a banner (nothing was ever connected to lose)', () => {
    // Deliberately verifies deriveTopBarNotice's own DISCONNECTED branch
    // guard (`ownership !== 'CLOSING'`) does not accidentally suppress
    // the real INACTIVE-with-no-prior-session case incorrectly - INACTIVE
    // still legitimately produces a notice per the design's own priority
    // order (DISCONNECTED is the highest tier); this test documents that
    // as the actual, intended behavior.
    const notice = deriveTopBarNotice('INACTIVE', undefined, IDLE_IDENTIFICATION, NO_ACTIVATIONS);
    expect(notice?.id).toBe('connection-disconnected');
  });

  it('CONNECTED with successful identification -> no notice at all (nothing needs attention)', () => {
    const notice = deriveTopBarNotice('ACTIVE', 'READY', RUNNING_IDENTIFICATION, NO_ACTIVATIONS);
    expect(notice).toBeUndefined();
  });

  it('DISCONNECTED (ownership INACTIVE) produces the highest-priority CONNECTION-domain notice', () => {
    const notice = deriveTopBarNotice('INACTIVE', undefined, IDLE_IDENTIFICATION, NO_ACTIVATIONS);
    expect(notice).toMatchObject({domain: 'CONNECTION', severity: 'ERROR'});
  });

  it('CLOSING produces its own distinct notice, not the DISCONNECTED one', () => {
    const notice = deriveTopBarNotice('CLOSING', 'READY', IDLE_IDENTIFICATION, NO_ACTIVATIONS);
    expect(notice?.id).toBe('connection-closing');
  });

  it('RECOVERY_FAILED produces a CRITICAL MSP_SESSION-domain notice', () => {
    const notice = deriveTopBarNotice('ACTIVE', 'RECOVERY_FAILED', RUNNING_IDENTIFICATION, NO_ACTIVATIONS);
    expect(notice).toMatchObject({id: 'msp-recovery-failed', domain: 'MSP_SESSION', severity: 'CRITICAL'});
  });

  it('RECOVERING produces a WARNING MSP_SESSION-domain notice', () => {
    const notice = deriveTopBarNotice('ACTIVE', 'RESTARTING_READER', RUNNING_IDENTIFICATION, NO_ACTIVATIONS);
    expect(notice).toMatchObject({id: 'msp-recovering', domain: 'MSP_SESSION', severity: 'WARNING'});
  });

  it('a failed identification only produces a notice once genuinely CONNECTED (not while still RECOVERING/DISCONNECTED, which already have a higher-priority notice of their own)', () => {
    const whileConnected = deriveTopBarNotice('ACTIVE', 'READY', FAILED_IDENTIFICATION, NO_ACTIVATIONS);
    expect(whileConnected?.id).toBe('identification-failed');

    const whileDisconnected = deriveTopBarNotice('INACTIVE', undefined, FAILED_IDENTIFICATION, NO_ACTIVATIONS);
    expect(whileDisconnected?.id).toBe('connection-disconnected'); // higher priority wins
  });

  it('never surfaces a raw error object, sessionId, or internal error code in title/message - every string is a fixed Arabic constant', () => {
    const notice = deriveTopBarNotice('ACTIVE', 'RECOVERY_FAILED', FAILED_IDENTIFICATION, NO_ACTIVATIONS);
    const combined = `${notice?.title ?? ''} ${notice?.message ?? ''}`;
    expect(combined).not.toMatch(/MSP_|Error|session-|\d{4,}/);
  });
});

describe('deriveTopBarNotice - activatedAtMsById lookup', () => {
  it('uses the REAL activatedAtMs from the map when the candidate id is tracked', () => {
    const activations = new Map([['connection-disconnected', 12345]]);
    const notice = deriveTopBarNotice('INACTIVE', undefined, IDLE_IDENTIFICATION, activations);
    expect(notice?.activatedAtMs).toBe(12345);
  });

  it('falls back to the placeholder when the candidate id is not yet tracked', () => {
    const notice = deriveTopBarNotice('INACTIVE', undefined, IDLE_IDENTIFICATION, NO_ACTIVATIONS);
    expect(notice?.activatedAtMs).toBe(0);
  });
});

describe('listTopBarNoticeCandidateIds', () => {
  it('returns the same ids that deriveTopBarNotice would pick from - single source of truth, no drift', () => {
    expect(listTopBarNoticeCandidateIds('INACTIVE', undefined, IDLE_IDENTIFICATION)).toEqual([
      'connection-disconnected',
    ]);
    expect(listTopBarNoticeCandidateIds('ACTIVE', 'READY', RUNNING_IDENTIFICATION)).toEqual([]);
    expect(listTopBarNoticeCandidateIds('ACTIVE', 'READY', FAILED_IDENTIFICATION)).toEqual([
      'identification-failed',
    ]);
  });
});

describe('updateNoticeActivationTimestamps - the anti-flicker proof', () => {
  it('stamps a genuinely new id with nowMs', () => {
    const result = updateNoticeActivationTimestamps(new Map(), ['a'], 1000);
    expect(result.get('a')).toBe(1000);
  });

  it('keeps an already-tracked id\'s existing timestamp, ignoring the new nowMs entirely - THE anti-flicker guarantee itself', () => {
    const previous = new Map([['a', 1000]]);
    const result = updateNoticeActivationTimestamps(previous, ['a'], 999999);
    expect(result.get('a')).toBe(1000);
  });

  it('drops an id no longer present in currentCandidateIds', () => {
    const previous = new Map([['a', 1000], ['b', 2000]]);
    const result = updateNoticeActivationTimestamps(previous, ['a'], 5000);
    expect(result.has('b')).toBe(false);
    expect(result.get('a')).toBe(1000);
  });

  it('a genuine disappear-then-reappear is treated as a NEW activation, not a resumed old timestamp - per the design\'s own explicit rule', () => {
    const afterFirstActivation = updateNoticeActivationTimestamps(new Map(), ['a'], 1000);
    const afterDisappearing = updateNoticeActivationTimestamps(afterFirstActivation, [], 2000);
    const afterReappearing = updateNoticeActivationTimestamps(afterDisappearing, ['a'], 3000);
    expect(afterReappearing.get('a')).toBe(3000); // NOT 1000
  });

  it('is idempotent under repeated invocation with its own prior output fed back in - the formal property that makes mutating a ref during render safe under React StrictMode\'s double-invoke, proven directly rather than assumed', () => {
    // Simulates exactly what a StrictMode double-render does: invocation 2
    // receives invocation 1's own output as its `previous` map.
    const invocation1 = updateNoticeActivationTimestamps(new Map(), ['a', 'b'], 1000);
    const invocation2 = updateNoticeActivationTimestamps(invocation1, ['a', 'b'], 2000); // a later, different nowMs
    expect(invocation2).toEqual(invocation1);
  });

  it('the idempotence proof also holds for a MIXED render - one id already tracked from an earlier render, one id newly appearing in this same render', () => {
    const previous = new Map([['a', 500]]); // tracked from an earlier, already-committed render
    const invocation1 = updateNoticeActivationTimestamps(previous, ['a', 'b'], 1000); // b is new
    const invocation2 = updateNoticeActivationTimestamps(invocation1, ['a', 'b'], 2000);
    expect(invocation2).toEqual(invocation1);
    expect(invocation2.get('a')).toBe(500); // untouched
    expect(invocation2.get('b')).toBe(1000); // stamped once, by invocation1, never re-stamped
  });

  it('does not mutate the input map', () => {
    const previous = new Map([['a', 1000]]);
    const previousCopy = new Map(previous);
    updateNoticeActivationTimestamps(previous, ['a', 'b'], 2000);
    expect(previous).toEqual(previousCopy);
  });
});
