import {deriveArmingReadiness, rankArmingBlockReasons, selectTopArmingBlockReasons} from './armingReadiness';
import type {ArmingBlockReason} from './armingReadiness';
import type {TelemetryValue} from '../protocol';

const FRESH_ARMED_TRUE: TelemetryValue<boolean> = {status: 'FRESH', value: true, updatedAtMs: 100};
const FRESH_ARMED_FALSE: TelemetryValue<boolean> = {status: 'FRESH', value: false, updatedAtMs: 100};
const FRESH_NO_BLOCKERS: TelemetryValue<ArmingBlockReason[]> = {status: 'FRESH', value: [], updatedAtMs: 100};

function reason(code: string, severity: ArmingBlockReason['severity']): ArmingBlockReason {
  return {code, message: `message for ${code}`, severity};
}

const ONE_BLOCKER: TelemetryValue<ArmingBlockReason[]> = {
  status: 'FRESH',
  value: [reason('ARMING_DISABLED_THROTTLE', 'ARMING_BLOCKER')],
  updatedAtMs: 100,
};

describe('deriveArmingReadiness', () => {
  it('ARMED: armed FRESH+true returns ARMED regardless of blockers freshness', () => {
    const nonFreshBlockers: TelemetryValue<ArmingBlockReason[]> = {status: 'WAITING'};
    expect(deriveArmingReadiness(FRESH_ARMED_TRUE, nonFreshBlockers)).toEqual({status: 'ARMED'});
    expect(deriveArmingReadiness(FRESH_ARMED_TRUE, FRESH_NO_BLOCKERS)).toEqual({status: 'ARMED'});
    expect(deriveArmingReadiness(FRESH_ARMED_TRUE, ONE_BLOCKER)).toEqual({status: 'ARMED'});
  });

  it('READY: armed FRESH+false AND blockers FRESH+empty', () => {
    expect(deriveArmingReadiness(FRESH_ARMED_FALSE, FRESH_NO_BLOCKERS)).toEqual({status: 'READY'});
  });

  it('BLOCKED: armed FRESH+false AND blockers FRESH+non-empty, reasons passed through unranked', () => {
    const blockers: TelemetryValue<ArmingBlockReason[]> = {
      status: 'FRESH',
      value: [reason('B', 'WARNING'), reason('A', 'CRITICAL_DANGER')],
      updatedAtMs: 100,
    };
    expect(deriveArmingReadiness(FRESH_ARMED_FALSE, blockers)).toEqual({
      status: 'BLOCKED',
      reasons: blockers.value,
    });
  });

  describe('UNKNOWN when armed itself is not FRESH - checked FIRST, cause is always armed\'s own status', () => {
    (['WAITING', 'STALE', 'ERROR', 'UNAVAILABLE'] as const).forEach(cause => {
      it(`armed=${cause}, blockers=FRESH -> UNKNOWN(${cause})`, () => {
        const armed: TelemetryValue<boolean> =
          cause === 'STALE'
            ? {status: 'STALE', value: true, updatedAtMs: 0, ageMs: 1000}
            : cause === 'ERROR'
              ? {status: 'ERROR', error: new Error('x')}
              : {status: cause};
        expect(deriveArmingReadiness(armed, FRESH_NO_BLOCKERS)).toEqual({status: 'UNKNOWN', cause});
      });

      it(`armed=${cause}, blockers ALSO not fresh -> UNKNOWN(${cause}) - armed's own status wins, never blockers'`, () => {
        const armed: TelemetryValue<boolean> = {status: cause} as TelemetryValue<boolean>;
        const blockers: TelemetryValue<ArmingBlockReason[]> = {status: 'ERROR', error: new Error('unrelated')};
        expect(deriveArmingReadiness(armed, blockers)).toEqual({status: 'UNKNOWN', cause});
      });
    });
  });

  describe('UNKNOWN when armed is FRESH+false but blockers is not FRESH - never reuses a stale "no blockers" reading as READY', () => {
    (['WAITING', 'STALE', 'ERROR', 'UNAVAILABLE'] as const).forEach(cause => {
      it(`blockers=${cause} -> UNKNOWN(${cause}), never READY`, () => {
        const blockers: TelemetryValue<ArmingBlockReason[]> =
          cause === 'STALE'
            ? {status: 'STALE', value: [], updatedAtMs: 0, ageMs: 1000}
            : cause === 'ERROR'
              ? {status: 'ERROR', error: new Error('x')}
              : {status: cause};
        const result = deriveArmingReadiness(FRESH_ARMED_FALSE, blockers);
        expect(result).toEqual({status: 'UNKNOWN', cause});
        expect(result.status).not.toBe('READY');
      });
    });

    it('a STALE blockers reading that HAPPENS to carry an empty last-known list is still UNKNOWN, not READY (the exact "reusing stale no-blockers" trap this rule exists to prevent)', () => {
      const staleEmptyBlockers: TelemetryValue<ArmingBlockReason[]> = {
        status: 'STALE',
        value: [],
        updatedAtMs: 0,
        ageMs: 5000,
      };
      expect(deriveArmingReadiness(FRESH_ARMED_FALSE, staleEmptyBlockers)).toEqual({
        status: 'UNKNOWN',
        cause: 'STALE',
      });
    });
  });
});

describe('rankArmingBlockReasons', () => {
  it('sorts critical danger -> arming blocker -> warning -> info', () => {
    const reasons = [reason('info1', 'INFO'), reason('crit1', 'CRITICAL_DANGER'), reason('warn1', 'WARNING'), reason('block1', 'ARMING_BLOCKER')];
    expect(rankArmingBlockReasons(reasons).map(r => r.code)).toEqual(['crit1', 'block1', 'warn1', 'info1']);
  });

  it('is a stable sort - equal-severity reasons keep their original relative order', () => {
    const reasons = [reason('warnA', 'WARNING'), reason('critA', 'CRITICAL_DANGER'), reason('warnB', 'WARNING'), reason('critB', 'CRITICAL_DANGER')];
    expect(rankArmingBlockReasons(reasons).map(r => r.code)).toEqual(['critA', 'critB', 'warnA', 'warnB']);
  });

  it('does not mutate the input array', () => {
    const reasons = [reason('info1', 'INFO'), reason('crit1', 'CRITICAL_DANGER')];
    const original = [...reasons];
    rankArmingBlockReasons(reasons);
    expect(reasons).toEqual(original);
  });

  it('returns an empty array for an empty input', () => {
    expect(rankArmingBlockReasons([])).toEqual([]);
  });
});

describe('selectTopArmingBlockReasons', () => {
  it('defaults to the top 3 by priority, reporting the remaining count', () => {
    const reasons = [
      reason('info1', 'INFO'),
      reason('crit1', 'CRITICAL_DANGER'),
      reason('warn1', 'WARNING'),
      reason('block1', 'ARMING_BLOCKER'),
      reason('crit2', 'CRITICAL_DANGER'),
    ];
    const selection = selectTopArmingBlockReasons(reasons);
    expect(selection.shown.map(r => r.code)).toEqual(['crit1', 'crit2', 'block1']);
    expect(selection.remainingCount).toBe(2);
  });

  it('remainingCount is 0 when everything fits within the limit', () => {
    const reasons = [reason('crit1', 'CRITICAL_DANGER'), reason('warn1', 'WARNING')];
    const selection = selectTopArmingBlockReasons(reasons);
    expect(selection.shown).toHaveLength(2);
    expect(selection.remainingCount).toBe(0);
  });

  it('respects an explicit limit override', () => {
    const reasons = [reason('crit1', 'CRITICAL_DANGER'), reason('crit2', 'CRITICAL_DANGER'), reason('crit3', 'CRITICAL_DANGER')];
    const selection = selectTopArmingBlockReasons(reasons, 2);
    expect(selection.shown).toHaveLength(2);
    expect(selection.remainingCount).toBe(1);
  });

  it('handles an empty reasons list', () => {
    const selection = selectTopArmingBlockReasons([]);
    expect(selection.shown).toEqual([]);
    expect(selection.remainingCount).toBe(0);
  });
});
