/**
 * Repair Pass R2 - the build-time containment seam and the Release/Debug
 * dependency boundary.
 *
 * NO HARDWARE: no USB, FC, ESC, LiPo or motor is touched.
 */

import {existsSync, readFileSync, readdirSync} from 'fs';
import {join} from 'path';

import {
  createMotorTestTelemetryRegistry,
  openMotorTestCapability,
  closeMotorTestCapability,
  readMotorTestCapability,
} from './motorTestCapability';
import {MspClient} from '../../../core/protocol/mspClient';
import {MotorTestTelemetryRegistry} from '../../../core/protocol/telemetry/motorTestTelemetryBarrier';
import {FakeMspTransport} from '../../../core/protocol/__testUtils__/mspFakeTransport';

const SRC_ROOT = join(__dirname, '..', '..', '..');

function productionSources(): string[] {
  const results: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['__tests__', '__testUtils__', '__mocks__'].includes(entry.name)) {
          continue;
        }
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
        continue;
      }
      results.push(full);
    }
  };
  walk(SRC_ROOT);
  return results;
}

function executableOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

describe('The capability store is the ONLY runtime route to the engine', () => {
  it('resolves the engine with no regard for __DEV__', () => {
    // The store does not consult __DEV__ at all any more. Asserting the
    // value of __DEV__ here would test Jest, not the product; what matters
    // is that the engine module resolves and the registry constructs.
    expect(createMotorTestTelemetryRegistry()).toBeDefined();
    expect(typeof openMotorTestCapability).toBe('function');
  });

  it('resolves the engine unconditionally - no build conditional survives', () => {
    // SINGLE-APP MERGE: the __DEV__ gate and the build-variant selection
    // are both gone on purpose. What must NOT come back is any branch at
    // all: one implementation, every build.
    const executable = executableOf(join(__dirname, 'motorTestCapability.ts'));
    expect(executable).not.toContain('__DEV__');
    expect(executable).not.toContain('FPV_ARBCON_HARDWARE_TEST');
    expect(executable).not.toContain('motorTestEngineVariant');
    // The binding is a STATIC import now - no require(), no deferral, no
    // cycle to break, because nothing here reaches a screen any more.
    expect(executable).not.toContain('require(');
    expect(executable).toMatch(
      /import\s*\{[\s\S]{0,80}createMotorTestSessionBinding/,
    );
    // And the registry factory really constructs one.
    expect(createMotorTestTelemetryRegistry()).toBeDefined();
  });

  it('uses no runtime feature flag, environment branch or escape hatch', () => {
    const executable = executableOf(join(__dirname, 'motorTestCapability.ts'));
    for (const forbidden of [
      'NODE_ENV',
      'process.env',
      'globalThis',
      'setEngineAvailable',
      'enableMotorTest',
    ]) {
      expect(executable).not.toContain(forbidden);
    }
  });

  it('is the only production module that requires the binding at runtime', () => {
    // Per-STATEMENT, not per-file: `import type` / `export type` erase
    // completely and pull no runtime module in, so only a value import,
    // a value re-export or a require() counts as a runtime reference.
    const offenders = productionSources().filter(file => {
      if (
        file.endsWith('motorTestCapability.ts') ||
        file.endsWith('motorTestSessionBinding.ts') ||
        // The ONE engine module. Exactly one file may require the
        // binding, which is what keeps a second, unregistered capability
        // for the same client unrepresentable.
        file.endsWith('motorTestCapability.ts')
      ) {
        return false;
      }
      return executableOf(file)
        .split(/\n/)
        .some(
          line =>
            /motorTestSessionBinding/.test(line) &&
            !/^\s*(import|export)\s+type\b/.test(line) &&
            !/^\s*\}\s*from/.test(line),
        );
    });
    expect(offenders).toEqual([]);
  });

  it('has no build-variant seam left to select between', () => {
    // Both halves of the R3 seam are deleted, not left with one branch
    // permanently taken. A dead seam is how a removed containment quietly
    // comes back.
    for (const gone of [
      'motorTestEngineVariant.ts',
      'motorTestEngineVariant.hardwareTest.ts',
      'motorTestEngine.ts',
      'motorTestDebugSeam.ts',
    ]) {
      expect(existsSync(join(__dirname, gone))).toBe(false);
    }
    // And the bundler rule that drove it is gone too.
    const metro = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'metro.config.js'),
      'utf8',
    );
    const metroCode = metro
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    expect(metroCode).not.toContain('resolveRequest');
    expect(metroCode).not.toContain('FPV_ARBCON_HARDWARE_TEST');
    expect(metroCode).not.toContain('hardwareTest');
  });

  it('leaves no Release-reachable barrel exporting the binding at runtime', () => {
    const barrel = executableOf(join(__dirname, 'index.ts'));
    // A runtime re-export IS a runtime import: it would pull the binding,
    // the controller, the encoder and the vectors straight back in.
    expect(barrel).not.toMatch(
      /export\s*\{[^}]*createMotorTestSessionBinding[^}]*\}\s*from/,
    );
  });

  it('keeps the coordinator free of any static motor-test runtime import', () => {
    const executable = executableOf(join(__dirname, 'MspSessionCoordinator.ts'));
    expect(executable).not.toMatch(
      /^import\s*\{[^}]*createMotorTestSessionBinding/m,
    );
    expect(executable).not.toMatch(
      /^import\s*\{\s*MotorTestTelemetryRegistry\s*\}/m,
    );
    // It reaches the engine only through the seam's generic hooks.
    expect(executable).toContain('openMotorTestCapability');
    expect(executable).toContain('closeMotorTestCapability');
  });
});

describe('R2 - the capability store preserves Debug behaviour', () => {
  function makeClient(): MspClient {
    return new MspClient(new FakeMspTransport(), 'seam-session');
  }

  it('creates the coherent capability Debug needs, and a scheduler from it', () => {
    const registry = new MotorTestTelemetryRegistry();
    const client = makeClient();
    const capability = openMotorTestCapability('s-1', client, registry);
    expect(capability).toBeDefined();
    // P4 coherence: the scheduler comes FROM the binding, which minted the
    // anchor for this exact client. Nothing can name a different client.
    const scheduler = capability?.createScheduler({singleFlight: true});
    expect(scheduler).toBeDefined();
    expect(readMotorTestCapability('s-1')).toBe(capability);
    closeMotorTestCapability('s-1');
    expect(readMotorTestCapability('s-1')).toBeUndefined();
  });

  it('is TOTAL - a registry is required by the type, so there is no no-capability shape', () => {
    // This replaces "returns undefined without a registry". That branch
    // described the Release build, which no longer exists. The registry is
    // now a required parameter and the coordinator holds it as a readonly
    // field initialised inline, so no caller can reach this function
    // without one - which is exactly why the coordinator's fallback that
    // read the undefined case was deleted rather than left unreachable.
    const registry = createMotorTestTelemetryRegistry();
    const capability = openMotorTestCapability('s-2', makeClient(), registry);
    expect(capability).toBeDefined();
    expect(readMotorTestCapability('s-2')).toBe(capability);
    closeMotorTestCapability('s-2');
  });

  it('closes idempotently and tolerates an unknown session', () => {
    expect(() => closeMotorTestCapability('never-opened')).not.toThrow();
    const registry = new MotorTestTelemetryRegistry();
    openMotorTestCapability('s-3', makeClient(), registry);
    closeMotorTestCapability('s-3');
    expect(() => closeMotorTestCapability('s-3')).not.toThrow();
    expect(readMotorTestCapability('s-3')).toBeUndefined();
  });

  it('keeps sessions independent', () => {
    const registry = new MotorTestTelemetryRegistry();
    const a = openMotorTestCapability('s-a', makeClient(), registry);
    const b = openMotorTestCapability('s-b', makeClient(), registry);
    expect(a).not.toBe(b);
    closeMotorTestCapability('s-a');
    expect(readMotorTestCapability('s-a')).toBeUndefined();
    expect(readMotorTestCapability('s-b')).toBe(b);
    closeMotorTestCapability('s-b');
  });
});
