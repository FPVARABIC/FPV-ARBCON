/**
 * The SOURCE BOUNDARY around the armed-state-evidence decision point.
 *
 * This file deliberately does NOT mock the module. It exercises the REAL
 * production reader and proves that the only way to reach
 * `FRESH_DISARMED` is a running monitor holding a fresh, satisfied
 * observation - and that every other input fails closed.
 *
 * R1 originally proved the reader was hard-wired unavailable. That guard
 * is now obsolete BY DESIGN (motorTestSafetyMonitor.ts supplies a genuine
 * source), so it is replaced here by the stronger guard that actually
 * matters: no production file may MANUFACTURE the permitting state, and the
 * controller may only ever COMPARE against it.
 *
 * NO HARDWARE. Nothing here opens a session, a transport or a device, and
 * no motor command is constructed anywhere in this file.
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

import { readMotorArmedStateEvidence } from './motorTestContinuousSafetyMonitor';
import {
  MOTOR_TEST_SAFETY_MAX_AGE_MILLIS,
  MotorTestSafetyMonitor,
} from './motorTestSafetyMonitor';

const SRC_ROOT = join(__dirname, '..', '..');

/** Every production (non-test) TypeScript file under src/. */
function productionSources(): string[] {
  const results: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
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
    requester: { request: () => new Promise(() => {}) },
    expectedIdentity: { physicalGeneration: 1, mspEpoch: 0 },
    boxIdPermanentIds: [0],
    readCurrentIdentity: () => ({ physicalGeneration: 1, mspEpoch: 0 }),
    readMonotonicMillis: () => 0,
    onUnsafe: () => {},
    setTimer: () => 1,
    clearTimer: () => {},
  });
}

describe('the armed-state-evidence reader fails closed', () => {
  it('reports unavailable when there is no monitor at all', () => {
    expect(readMotorArmedStateEvidence(undefined, 0)).toBe('UNKNOWN_OR_STALE');
  });

  it('reports unavailable for a monitor that has never observed', () => {
    const monitor = neverSettlingMonitor();
    monitor.start();
    expect(monitor.snapshot().status.kind).toBe('NEVER_OBSERVED');
    expect(readMotorArmedStateEvidence(monitor, 0)).toBe('UNKNOWN_OR_STALE');
  });

  it('reports unavailable for a monitor that is not running', () => {
    const monitor = neverSettlingMonitor();
    expect(monitor.snapshot().running).toBe(false);
    expect(readMotorArmedStateEvidence(monitor, 0)).toBe('UNKNOWN_OR_STALE');
  });

  it('never returns available for any age when nothing was observed', () => {
    const monitor = neverSettlingMonitor();
    monitor.start();
    for (const now of [0, 1, MOTOR_TEST_SAFETY_MAX_AGE_MILLIS, 10_000]) {
      expect(readMotorArmedStateEvidence(monitor, now)).toBe(
        'UNKNOWN_OR_STALE',
      );
    }
  });
});

describe('no production file can manufacture the permitting armed-state answer', () => {
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

  it('lets only the derivation itself PRODUCE the permitting state', () => {
    // Comparing against the permitting state is the fail-closed gate
    // itself; RETURNING or ASSIGNING it is what would be a bypass. Exactly
    // one production module is allowed to produce it - the derivation that
    // requires a running monitor with a fresh satisfied observation.
    const allowed = join(
      'core',
      'state',
      'motorTestContinuousSafetyMonitor.ts',
    );
    const offenders: string[] = [];
    for (const file of sources) {
      if (file.endsWith(allowed)) {
        continue;
      }
      const executable = executableOf(file);
      if (
        /return\s+'FRESH_DISARMED'/.test(executable) ||
        /(?<![=!<>])=\s*'FRESH_DISARMED'/.test(executable) ||
        /:\s*'FRESH_DISARMED'/.test(executable)
      ) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('makes the single producer conditional on a fresh satisfied reading', () => {
    const executable = executableOf(
      join(SRC_ROOT, 'core', 'state', 'motorTestContinuousSafetyMonitor.ts'),
    );
    // The producer is a ternary guarded by isFreshlySatisfied(), and every
    // earlier return is the fail-closed answer.
    expect(executable).toMatch(
      /isFreshlySatisfied\([\s\S]*?\?[\s\S]*?'FRESH_DISARMED'/,
    );
    expect(
      (executable.match(/'UNKNOWN_OR_STALE'/g) ?? []).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('lets the controller only COMPARE against the permitting state', () => {
    const executable = executableOf(
      join(SRC_ROOT, 'core', 'state', 'motorTestController.ts'),
    );
    // Never produced here: only ever compared against, and both
    // comparisons are the fail-closed direction.
    expect(/return\s+'FRESH_DISARMED'/.test(executable)).toBe(false);
    expect(/(?<![=!<>])=\s*'FRESH_DISARMED'/.test(executable)).toBe(false);
    expect(executable).toMatch(/!==\s*'FRESH_DISARMED'/);
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

/* ================================================================== *
 * ESC-DIRECTION COMMAND CONFINEMENT
 *
 * Persistent DShot direction changes are now an intentional Motors-page
 * feature. They must remain confined to the configuration transaction and
 * its encoder: the screen never owns the command, broadcast is forbidden,
 * and an acknowledgement is never presented as physical CW/CCW proof.
 * ================================================================== */

describe('the ESC-direction command stays inside its dedicated transaction', () => {
  const sources = productionSources();

  it('allows the MSP command only in declarations, re-exports, and the guarded controller', () => {
    const users = sources
      .filter(file => executableOf(file).includes('MSP2_SEND_DSHOT_COMMAND'))
      .map(file => file.replace(SRC_ROOT, 'src'))
      .sort();
    expect(users).toEqual(
      [
        join('src', 'core', 'index.ts'),
        join('src', 'core', 'protocol', 'index.ts'),
        join('src', 'core', 'protocol', 'msp', 'commands', 'mspCommands.ts'),
        join('src', 'core', 'protocol', 'msp', 'index.ts'),
        join(
          'src',
          'platforms',
          'react-native',
          'protocol',
          'MotorConfigurationController.ts',
        ),
      ].sort(),
    );
  });

  it('does not introduce an unrestricted ESC passthrough path', () => {
    const offenders: { file: string; token: string }[] = [];
    for (const file of sources) {
      const executable = executableOf(file);
      for (const token of [
        'MSP_SET_PASSTHROUGH',
        'fourWayInterface',
        'blheliPassthrough',
      ]) {
        if (executable.includes(token)) {
          offenders.push({ file: file.replace(SRC_ROOT, 'src'), token });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps yaw_motors_reversed out of physical ESC-direction decisions', () => {
    // The one MSP field that LOOKS like it means rotation direction. At
    // the pinned tag the firmware uses it in exactly one place - to flip
    // the sign of the yaw PID term. It may be edited as FC configuration,
    // but it must never select a DShot ESC direction or alter the diagram.
    const decisionFiles = [
      join(
        SRC_ROOT,
        'core',
        'protocol',
        'msp',
        'encoding',
        'encodeDshotEscDirection.ts',
      ),
      join(SRC_ROOT, 'core', 'state', 'motorOutputReordering.ts'),
      join(
        SRC_ROOT,
        'platforms',
        'react-native',
        'protocol',
        'MotorConfigurationController.ts',
      ),
      join(SRC_ROOT, 'ui', 'screens', 'EscDirectionPanel.tsx'),
      join(SRC_ROOT, 'ui', 'screens', 'MotorAirframeDiagram.tsx'),
    ];
    const offenders = decisionFiles.filter(file =>
      /yawMotorsReversed/.test(executableOf(file)),
    );
    expect(offenders.map(file => file.replace(SRC_ROOT, 'src'))).toEqual([]);
  });
});
