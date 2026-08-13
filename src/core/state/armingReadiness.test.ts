/**
 * SETUP P1: the poll-shaped `deriveArmingReadiness(armed, blockers)` this
 * file used to cover is gone. It was fed two telemetry ids nothing ever
 * registers, so its every production call returned UNKNOWN - a suite of
 * green tests over a derivation that could not work. The replacement
 * rule, and the twenty-plus cases that now pin it, live in
 * setupSafetyModel.test.ts alongside the derivation itself.
 *
 * What remains here is what still belongs to this module: the ranking and
 * top-N selection the Safety Strip renders with.
 */
import {rankArmingBlockReasons, selectTopArmingBlockReasons} from './armingReadiness';
import type {ArmingBlockReason} from './armingReadiness';

function reason(code: string, severity: ArmingBlockReason['severity']): ArmingBlockReason {
  return {code, messageKey: `diagnostics.blockerDescriptions.${code}`, severity};
}

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
