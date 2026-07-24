import {pickTopNotice} from './setupNotice';
import type {SetupNotice} from './setupNotice';

function notice(overrides: Partial<SetupNotice> & {id: string}): SetupNotice {
  return {
    domain: 'CONNECTION',
    severity: 'INFO',
    scope: 'NONE',
    priority: 0,
    activatedAtMs: 0,
    updatedAtMs: 0,
    title: `title-${overrides.id}`,
    ...overrides,
  };
}

describe('pickTopNotice', () => {
  it('returns undefined for an empty list', () => {
    expect(pickTopNotice([])).toBeUndefined();
  });

  it('returns the sole notice when only one exists', () => {
    const only = notice({id: 'a'});
    expect(pickTopNotice([only])).toBe(only);
  });

  it('higher priority wins, regardless of severity', () => {
    const low = notice({id: 'low', priority: 1, severity: 'CRITICAL'});
    const high = notice({id: 'high', priority: 2, severity: 'INFO'});
    expect(pickTopNotice([low, high])).toBe(high);
  });

  it('at equal priority, higher severity wins (CRITICAL > ERROR > WARNING > INFO)', () => {
    const info = notice({id: 'info', priority: 1, severity: 'INFO'});
    const warning = notice({id: 'warning', priority: 1, severity: 'WARNING'});
    const error = notice({id: 'error', priority: 1, severity: 'ERROR'});
    const critical = notice({id: 'critical', priority: 1, severity: 'CRITICAL'});

    expect(pickTopNotice([info, warning, error, critical])).toBe(critical);
    expect(pickTopNotice([info, warning, error])).toBe(error);
    expect(pickTopNotice([info, warning])).toBe(warning);
    expect(pickTopNotice([info])).toBe(info);
  });

  it('at equal priority AND severity, the EARLIEST activatedAtMs wins - not the latest, to prevent flicker', () => {
    const older = notice({id: 'older', priority: 1, severity: 'ERROR', activatedAtMs: 100});
    const newer = notice({id: 'newer', priority: 1, severity: 'ERROR', activatedAtMs: 500});
    expect(pickTopNotice([newer, older])).toBe(older);
  });

  it('at fully equal priority/severity/activatedAtMs, id is the final deterministic tiebreak (lexicographically smallest wins)', () => {
    const b = notice({id: 'b', priority: 1, severity: 'ERROR', activatedAtMs: 100});
    const a = notice({id: 'a', priority: 1, severity: 'ERROR', activatedAtMs: 100});
    expect(pickTopNotice([b, a])).toBe(a);
  });

  it('does not mutate the input array', () => {
    const notices = [notice({id: 'b', priority: 1}), notice({id: 'a', priority: 2})];
    const original = [...notices];
    pickTopNotice(notices);
    expect(notices).toEqual(original);
  });

  it('a full, realistic multi-notice list resolves deterministically end to end', () => {
    const notices: SetupNotice[] = [
      notice({id: 'info-1', priority: 1, severity: 'INFO'}),
      notice({id: 'recovering', priority: 5, severity: 'WARNING'}),
      notice({id: 'disconnected', priority: 10, severity: 'CRITICAL'}),
      notice({id: 'recovery-failed', priority: 8, severity: 'CRITICAL'}),
    ];
    expect(pickTopNotice(notices)?.id).toBe('disconnected');
  });
});
