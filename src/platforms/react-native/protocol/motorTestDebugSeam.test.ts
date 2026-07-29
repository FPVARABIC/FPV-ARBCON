/**
 * Repair Pass R2 - the build-time containment seam and the Release/Debug
 * dependency boundary.
 *
 * NO HARDWARE: no USB, FC, ESC, LiPo or motor is touched.
 */

import {readFileSync, readdirSync} from 'fs';
import {join} from 'path';

import {
  devMotorTestBindingFactory,
  devMotorTestRegistryConstructor,
  isMotorTestEngineBundled,
  openMotorTestCapability,
  closeMotorTestCapability,
  readMotorTestCapability,
} from './motorTestDebugSeam';
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

describe('R2 - the seam is the ONLY runtime route to the engine', () => {
  it('resolves the engine in Jest, where __DEV__ is true', () => {
    expect(__DEV__).toBe(true);
    expect(devMotorTestBindingFactory).toBeDefined();
    expect(devMotorTestRegistryConstructor).toBeDefined();
    expect(isMotorTestEngineBundled()).toBe(true);
  });

  it('is reached only through a __DEV__-guarded require, never a static import', () => {
    const executable = executableOf(join(__dirname, 'motorTestDebugSeam.ts'));
    // A static import would be retained by Metro no matter what runtime
    // guard wrapped its use - which is the entire defect R2 closes.
    expect(executable).not.toMatch(
      /^import\s+\{[^}]*createMotorTestSessionBinding/m,
    );
    expect(executable).toMatch(
      /__DEV__[\s\S]{0,120}require\('\.\/motorTestSessionBinding'\)/,
    );
    expect(executable).toMatch(
      /__DEV__[\s\S]{0,160}require\('[^']*motorTestTelemetryBarrier'\)/,
    );
  });

  it('uses no runtime feature flag, environment branch or escape hatch', () => {
    const executable = executableOf(join(__dirname, 'motorTestDebugSeam.ts'));
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
        file.endsWith('motorTestDebugSeam.ts') ||
        file.endsWith('motorTestSessionBinding.ts')
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

  it('returns undefined - and stores nothing - without a registry', () => {
    // The Release shape: no registry, therefore no capability at all.
    expect(openMotorTestCapability('s-2', makeClient(), undefined)).toBeUndefined();
    expect(readMotorTestCapability('s-2')).toBeUndefined();
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
