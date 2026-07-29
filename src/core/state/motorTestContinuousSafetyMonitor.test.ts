/**
 * Repair Pass R1 - the SOURCE BOUNDARY around the continuous-safety-monitor
 * reader.
 *
 * This file deliberately does NOT mock the module. It exercises the REAL
 * production reader and proves that nothing in production can make it
 * answer "available".
 *
 * NO HARDWARE. Nothing here opens a session, a transport or a device.
 */

import {readFileSync} from 'fs';
import {join} from 'path';

import {readContinuousSafetyMonitoring} from './motorTestContinuousSafetyMonitor';

const SRC_ROOT = join(__dirname, '..', '..');

/** Every production (non-test) TypeScript file under src/. */
function productionSources(): string[] {
  const results: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === '__testUtils__' || entry.name === '__mocks__') {
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

import {readdirSync} from 'fs';

describe('R1 - the production reader is hard-wired unavailable', () => {
  it('returns the unavailable state, with no argument and no configuration', () => {
    expect(readContinuousSafetyMonitoring()).toBe(
      'UNAVAILABLE_NO_ACCEPTED_SOURCE',
    );
    // Parameterless by construction: there is nothing a caller could pass
    // to influence the answer.
    expect(readContinuousSafetyMonitoring).toHaveLength(0);
  });

  it('returns the same answer no matter how often it is called', () => {
    for (let call = 0; call < 25; call++) {
      expect(readContinuousSafetyMonitoring()).toBe(
        'UNAVAILABLE_NO_ACCEPTED_SOURCE',
      );
    }
  });

  it('contains no branch, flag, environment check or escape hatch', () => {
    const executable = readFileSync(
      join(__dirname, 'motorTestContinuousSafetyMonitor.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

    for (const forbidden of [
      '__DEV__',
      'NODE_ENV',
      'process.env',
      'globalThis',
      'if (',
      'if(',
      '?',
      'let ',
      'var ',
    ]) {
      expect(executable).not.toContain(forbidden);
    }
    // The available state appears ONLY in the type union, never as a
    // returned value.
    expect(executable).not.toMatch(/return\s+'AVAILABLE_ACCEPTED_SOURCE'/);
    expect(
      (executable.match(/'AVAILABLE_ACCEPTED_SOURCE'/g) ?? []).length,
    ).toBe(1);
  });
});

describe('R1 - no production file can inject an accepted monitor', () => {
  const sources = productionSources();

  it('finds the production source set (guards against a vacuous scan)', () => {
    expect(sources.length).toBeGreaterThan(50);
    expect(
      sources.some(f => f.endsWith('motorTestController.ts')),
    ).toBe(true);
  });

  /** Executable text only - a doc comment naming a token is not a code
   * path, and treating it as one produces false positives that hide real
   * ones. */
  function executableOf(file: string): string {
    return readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  }

  it('lets no production file replace the monitor module', () => {
    const offenders = sources.filter(file =>
      /jest\.mock\s*\(/.test(executableOf(file)),
    );
    expect(offenders).toEqual([]);
  });

  it('lets no production file PRODUCE the accepted-monitor state', () => {
    // The distinction that matters: comparing against the available state
    // is the fail-closed gate itself; RETURNING or ASSIGNING it would be
    // the bypass. Only the latter is forbidden.
    const offenders: string[] = [];
    for (const file of sources) {
      if (file.endsWith('motorTestContinuousSafetyMonitor.ts')) {
        continue;
      }
      const executable = executableOf(file);
      if (
        /return\s+'AVAILABLE_ACCEPTED_SOURCE'/.test(executable) ||
        // An ASSIGNMENT, not a comparison: the lookbehind excludes
        // `!==`, `===`, `<=` and `>=`, so the gate's own negated check
        // does not read as a bypass.
        /(?<![=!<>])=\s*'AVAILABLE_ACCEPTED_SOURCE'/.test(executable) ||
        /:\s*'AVAILABLE_ACCEPTED_SOURCE'/.test(executable)
      ) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('references the accepted state in production only as the gate comparison', () => {
    const executable = executableOf(
      join(SRC_ROOT, 'core', 'state', 'motorTestController.ts'),
    );
    const occurrences =
      executable.match(/'AVAILABLE_ACCEPTED_SOURCE'/g) ?? [];
    expect(occurrences).toHaveLength(1);
    // ... and that single occurrence is a NEGATED comparison, so anything
    // other than an accepted live source fails closed.
    expect(executable).toMatch(
      /readContinuousSafetyMonitoring\(\)\s*!==\s*'AVAILABLE_ACCEPTED_SOURCE'/,
    );
  });

  it('lets only the controller import the monitor module at all', () => {
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
