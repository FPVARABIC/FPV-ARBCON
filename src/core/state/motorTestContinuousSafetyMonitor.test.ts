/**
 * The SOURCE BOUNDARY around the continuous-safety-monitor decision point.
 *
 * This file deliberately does NOT mock the module. It exercises the REAL
 * production reader and proves that the only way to reach
 * `AVAILABLE_ACCEPTED_SOURCE` is a running monitor holding a fresh,
 * satisfied observation - and that every other input fails closed.
 *
 * R1 originally proved the reader was hard-wired unavailable. That guard
 * is now obsolete BY DESIGN (motorTestSafetyMonitor.ts supplies a genuine
 * source), so it is replaced here by the stronger guard that actually
 * matters: no production file may MANUFACTURE the accepted state, and the
 * controller may only ever COMPARE against it.
 *
 * NO HARDWARE. Nothing here opens a session, a transport or a device, and
 * no motor command is constructed anywhere in this file.
 */

import {readFileSync, readdirSync} from 'fs';
import {join} from 'path';

import {readContinuousSafetyMonitoring} from './motorTestContinuousSafetyMonitor';
import {
  MOTOR_TEST_SAFETY_MAX_AGE_MILLIS,
  MotorTestSafetyMonitor,
} from './motorTestSafetyMonitor';

const SRC_ROOT = join(__dirname, '..', '..');

/** Every production (non-test) TypeScript file under src/. */
function productionSources(): string[] {
  const results: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === '__tests__' ||
          entry.name === '__testUtils__' ||
          entry.name === '__mocks__'
        ) {
          continue;
        }
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) {
        continue;
      }
      if (/\.test\.tsx?$/.test(entry.name)) {
        continue;
      }
      results.push(full);
    }
  };
  walk(SRC_ROOT);
  return results;
}

/** Executable text only - a doc comment naming a token is not a code
 * path, and treating it as one produces false positives that hide real
 * ones. */
function executableOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/**
 * A monitor whose observations never settle, so its status stays exactly
 * where the test puts it. The requester hangs deliberately: this file is
 * about the DECISION, not about the read.
 */
function neverSettlingMonitor(): MotorTestSafetyMonitor {
  return new MotorTestSafetyMonitor({
    requester: {request: () => new Promise(() => {})},
    staticCompatibility: undefined,
    boxIds: undefined,
    readCurrentIdentity: () => undefined,
    readMonotonicMillis: () => 0,
    onUnsafe: () => {},
    setTimer: () => 1,
    clearTimer: () => {},
  });
}

describe('the continuous-safety-monitoring reader fails closed', () => {
  it('reports unavailable when there is no monitor at all', () => {
    expect(readContinuousSafetyMonitoring(undefined, 0)).toBe(
      'UNAVAILABLE_NO_ACCEPTED_SOURCE',
    );
  });

  it('reports unavailable for a monitor that has never observed', () => {
    const monitor = neverSettlingMonitor();
    monitor.start();
    expect(monitor.snapshot().status.kind).toBe('NEVER_OBSERVED');
    expect(readContinuousSafetyMonitoring(monitor, 0)).toBe(
      'UNAVAILABLE_NO_ACCEPTED_SOURCE',
    );
  });

  it('reports unavailable for a monitor that is not running', () => {
    const monitor = neverSettlingMonitor();
    expect(monitor.snapshot().running).toBe(false);
    expect(readContinuousSafetyMonitoring(monitor, 0)).toBe(
      'UNAVAILABLE_NO_ACCEPTED_SOURCE',
    );
  });

  it('never returns available for any age when nothing was observed', () => {
    const monitor = neverSettlingMonitor();
    monitor.start();
    for (const now of [0, 1, MOTOR_TEST_SAFETY_MAX_AGE_MILLIS, 10_000]) {
      expect(readContinuousSafetyMonitoring(monitor, now)).toBe(
        'UNAVAILABLE_NO_ACCEPTED_SOURCE',
      );
    }
  });
});

describe('no production file can manufacture the accepted-monitor state', () => {
  const sources = productionSources();

  it('finds the production source set (guards against a vacuous scan)', () => {
    expect(sources.length).toBeGreaterThan(50);
    expect(sources.some(f => f.endsWith('motorTestController.ts'))).toBe(true);
  });

  it('lets no production file replace the monitor module', () => {
    const offenders = sources.filter(file =>
      /jest\.mock\s*\(/.test(executableOf(file)),
    );
    expect(offenders).toEqual([]);
  });

  it('lets only the derivation itself PRODUCE the accepted state', () => {
    // Comparing against the available state is the fail-closed gate
    // itself; RETURNING or ASSIGNING it is what would be a bypass. Exactly
    // one production module is allowed to produce it - the derivation that
    // requires a running monitor with a fresh satisfied observation.
    const allowed = join('core', 'state', 'motorTestSafetyMonitor.ts');
    const offenders: string[] = [];
    for (const file of sources) {
      if (file.endsWith(allowed)) {
        continue;
      }
      const executable = executableOf(file);
      if (
        /return\s+'AVAILABLE_ACCEPTED_SOURCE'/.test(executable) ||
        /(?<![=!<>])=\s*'AVAILABLE_ACCEPTED_SOURCE'/.test(executable) ||
        /:\s*'AVAILABLE_ACCEPTED_SOURCE'/.test(executable)
      ) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('makes the single producer conditional on a fresh satisfied reading', () => {
    const executable = executableOf(
      join(SRC_ROOT, 'core', 'state', 'motorTestSafetyMonitor.ts'),
    );
    // The producer is a ternary guarded by isFreshlySatisfied(), and both
    // earlier returns are the unavailable state.
    expect(executable).toMatch(
      /isFreshlySatisfied\([\s\S]*?\?[\s\S]*?'AVAILABLE_ACCEPTED_SOURCE'/,
    );
    expect(
      (executable.match(/'UNAVAILABLE_NO_ACCEPTED_SOURCE'/g) ?? []).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('references the accepted state in the controller only as the gate comparison', () => {
    const executable = executableOf(
      join(SRC_ROOT, 'core', 'state', 'motorTestController.ts'),
    );
    const occurrences = executable.match(/'AVAILABLE_ACCEPTED_SOURCE'/g) ?? [];
    expect(occurrences).toHaveLength(1);
    // ... and that single occurrence is a NEGATED comparison against the
    // reader, so anything other than an accepted live source fails closed.
    expect(executable).toMatch(
      /readContinuousSafetyMonitoring\([\s\S]{0,120}?\)\s*!==\s*'AVAILABLE_ACCEPTED_SOURCE'/,
    );
  });

  it('lets no production file supply the controller test seam', () => {
    // `createSafetyMonitor` exists so the pulse-engine suites can run
    // without a live observation loop competing for the fake link. If a
    // production file ever supplied it, production could substitute a
    // monitor that lies - so the seam is declared in the dependency type
    // and set by NOTHING that ships.
    const offenders = sources.filter(
      file =>
        !file.endsWith(join('core', 'state', 'motorTestController.ts')) &&
        /createSafetyMonitor\s*:/.test(executableOf(file)),
    );
    expect(offenders).toEqual([]);

    // Inside the controller it appears only as the optional declaration
    // and the `?? real monitor` fallback - never assigned a value.
    const controller = executableOf(
      join(SRC_ROOT, 'core', 'state', 'motorTestController.ts'),
    );
    expect(controller).toMatch(
      /this\.deps\.createSafetyMonitor\s*\?\?\s*\(options => new MotorTestSafetyMonitor\(options\)\)/,
    );
  });

  it('lets only the controller import the decision module at all', () => {
    const importers = sources.filter(
      file =>
        !file.endsWith('motorTestContinuousSafetyMonitor.ts') &&
        readFileSync(file, 'utf8').includes('motorTestContinuousSafetyMonitor'),
    );
    expect(importers.map(f => f.replace(SRC_ROOT, 'src'))).toEqual([
      join('src', 'core', 'state', 'motorTestController.ts'),
    ]);
  });
});
