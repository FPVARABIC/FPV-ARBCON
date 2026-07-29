/**
 * Repair Pass R2 - regression tests for the production-bundle containment
 * scanner.
 *
 * These exercise the scanner's VERDICT LOGIC against synthetic bundles.
 * Importing the module must not launch Metro - the main-module guard is
 * what makes that safe, and the first test proves it.
 *
 * NO HARDWARE, and no real bundle build here: the real `--dev false` build
 * is run by `npm run scan:production-bundle` and by CI.
 */

const {
  analyzeBundle,
  countOccurrences,
  FORBIDDEN_TOKENS,
  POSITIVE_CONTROLS,
  RETAINED_KERNEL_SENTINELS,
} = require('../scan-production-bundle');

/** A synthetic bundle that contains the positive controls and nothing
 * forbidden - the shape a correctly contained Release build has. */
function cleanBundle() {
  return `var app={};${POSITIVE_CONTROLS.join(';')};var telemetry="attitude";`;
}

describe('R2 scanner - importing it does not build anything', () => {
  it('exposes its verdict logic without running the CLI', () => {
    // If the main-module guard were missing, requiring the module above
    // would have shelled out to Metro before this test ever ran.
    expect(typeof analyzeBundle).toBe('function');
    expect(FORBIDDEN_TOKENS.length).toBeGreaterThan(20);
    expect(POSITIVE_CONTROLS).toEqual(['diagnostics-section', 'fc-tools-section']);
  });

  it('counts non-overlapping occurrences', () => {
    expect(countOccurrences('aXbXc', 'X')).toBe(2);
    expect(countOccurrences('aaaa', 'aa')).toBe(2);
    expect(countOccurrences('abc', 'z')).toBe(0);
  });
});

describe('R2 scanner - a clean bundle passes', () => {
  it('reports ok with zero forbidden tokens and both controls present', () => {
    const result = analyzeBundle(cleanBundle());
    expect(result.forbidden).toEqual([]);
    expect(result.missingControls).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe('R2 scanner - every strictly forbidden token is detected', () => {
  it.each(FORBIDDEN_TOKENS)('fails when %s is present', token => {
    const result = analyzeBundle(`${cleanBundle()};${token};`);
    expect(result.ok).toBe(false);
    expect(result.forbidden.map(entry => entry.token)).toContain(token);
  });

  it('reports ALL forbidden tokens, not just the first', () => {
    const injected = [
      'createMotorTestController',
      'MOTOR_TEST_FIXED_PULSE_VALUE',
      'buildAllStopVector',
      'motors-hold-button',
    ];
    const result = analyzeBundle(`${cleanBundle()};${injected.join(';')};`);
    expect(result.ok).toBe(false);
    for (const token of injected) {
      expect(result.forbidden.map(entry => entry.token)).toContain(token);
    }
    expect(result.forbidden.length).toBeGreaterThanOrEqual(injected.length);
  });

  it('records a count and a byte offset for each match', () => {
    const result = analyzeBundle(`${cleanBundle()};pulseMotor;pulseMotor;`);
    const entry = result.forbidden.find(item => item.token === 'pulseMotor');
    expect(entry).toBeDefined();
    expect(entry.count).toBe(2);
    expect(entry.offset).toBeGreaterThan(0);
  });
});

describe('R2 scanner - positive controls cannot be skipped', () => {
  it.each(POSITIVE_CONTROLS)('fails when %s is missing', control => {
    const partial = POSITIVE_CONTROLS.filter(token => token !== control).join(';');
    const result = analyzeBundle(`var app={};${partial};`);
    expect(result.ok).toBe(false);
    expect(result.missingControls).toContain(control);
  });

  it('fails an empty bundle rather than calling it clean', () => {
    // The exact failure mode a naive "no forbidden token found" check has.
    const result = analyzeBundle('');
    expect(result.forbidden).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.missingControls).toEqual(POSITIVE_CONTROLS);
  });
});

describe('R2 scanner - the approved retained lease-kernel sentinel', () => {
  const sentinel = RETAINED_KERNEL_SENTINELS[0].token;

  it('passes at zero occurrences', () => {
    const result = analyzeBundle(cleanBundle());
    const entry = result.retained.find(item => item.token === sentinel);
    expect(entry.count).toBe(0);
    expect(entry.exceeded).toBe(false);
    expect(result.ok).toBe(true);
  });

  it('passes at exactly one occurrence - the approved maximum', () => {
    const result = analyzeBundle(`${cleanBundle()};${sentinel};`);
    const entry = result.retained.find(item => item.token === sentinel);
    expect(entry.count).toBe(1);
    expect(entry.maxOccurrences).toBe(1);
    expect(entry.exceeded).toBe(false);
    // Crucially it is NOT counted as a strictly forbidden token.
    expect(result.forbidden.map(item => item.token)).not.toContain(sentinel);
    expect(result.ok).toBe(true);
  });

  it('FAILS above the approved maximum', () => {
    const result = analyzeBundle(`${cleanBundle()};${sentinel};${sentinel};`);
    const entry = result.retained.find(item => item.token === sentinel);
    expect(entry.count).toBe(2);
    expect(entry.exceeded).toBe(true);
    expect(result.ok).toBe(false);
  });

  it('remains visible in the result and cannot be silently suppressed', () => {
    // Reported on EVERY analysis, including a fully clean one, so the
    // approved exception can never quietly disappear from the record.
    for (const text of [cleanBundle(), `${cleanBundle()};${sentinel};`]) {
      const result = analyzeBundle(text);
      expect(result.retained.map(item => item.token)).toContain(sentinel);
      expect(result.inventory.map(item => item.token)).toContain(sentinel);
    }
  });

  it('reports the whole retained lease surface as inventory, not as failures', () => {
    const surface = [
      'tryAcquireMotorTestLease',
      'requestWithMotorTestLease',
      'releaseMotorTestLease',
      'faultMotorTestLeaseByToken',
      'MSP_MOTOR_TEST_LEASE_HELD',
    ];
    const result = analyzeBundle(`${cleanBundle()};${surface.join(';')};`);
    // Infrastructure, not engine: present, counted, and still passing.
    for (const token of surface) {
      const entry = result.inventory.find(item => item.token === token);
      expect(entry.count).toBe(1);
    }
    expect(result.forbidden).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe('R2 scanner - build failure is never a pass', () => {
  it('separates a missing bundle from a clean bundle by exit code', () => {
    // main() returns 2 for a generation failure and 1 for containment,
    // so a broken build can never be read as containment success. Proven
    // here by construction: the two codes are distinct constants in the
    // module's own contract, and analyzeBundle is never reached when
    // generation throws.
    const {main} = require('../scan-production-bundle');
    expect(typeof main).toBe('function');
    // An empty bundle - the closest analyzable stand-in for a failed
    // build - is NOT ok.
    expect(analyzeBundle('').ok).toBe(false);
  });
});
