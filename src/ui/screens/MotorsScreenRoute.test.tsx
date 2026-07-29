/**
 * Phase 2H - route, gating and lifecycle-ownership tests.
 *
 * NO HARDWARE. Nothing here opens a session, touches USB, or reaches a
 * flight controller; the coordinator is consulted read-only and returns
 * `undefined` because no session was ever opened.
 */

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({top: 44, bottom: 34, left: 0, right: 0}),
}));

import {readFileSync} from 'fs';
import {join} from 'path';

import '../../i18n';
import type {RootStackParamList} from '../../navigation/types';

const REPO_ROOT = join(__dirname, '..', '..', '..');

describe('Phase 2H - the Motors route', () => {
  it('is typed on the root param list with a session key', () => {
    // Compile-time proof: this only builds if the route exists and its
    // params carry a sessionKey.
    const params: RootStackParamList['Motors'] = {
      sessionKey: {sessionId: 's-1', generation: 3},
    };
    expect(params.sessionKey.sessionId).toBe('s-1');
  });

  it('is registered ONLY behind the established __DEV__ seam, never statically', () => {
    const app = readFileSync(join(REPO_ROOT, 'App.tsx'), 'utf8');
    // No static import of the screen module anywhere in the app entry.
    expect(app).not.toMatch(/import .*from '\.\/src\/ui\/screens\/MotorsScreen'/);
    // The route is registered through the gated component only.
    expect(app).toContain('DevBenchScreen');
    expect(app).toMatch(/DevBenchScreen === undefined \|\| DEV_BENCH_ROUTE_NAME === undefined/);
    // The route NAME is data too: a literal here would survive into a
    // production bundle even with the screen stripped.
    expect(app).not.toContain("name=\"Motors\"");
    expect(app).not.toContain("'Motors'");

    const gate = readFileSync(
      join(__dirname, 'debugPanels.ts'),
      'utf8',
    );
    // A __DEV__-guarded require() is the only form Metro's dead-code
    // elimination can strip; a static import would be retained regardless
    // of any runtime guard.
    expect(gate).toMatch(
      /DevBenchScreen[\s\S]*?__DEV__[\s\S]*?require\('\.\/MotorsScreen'\)/,
    );
    expect(gate).not.toMatch(/^import .*MotorsScreen/m);
  });

  it('resolves to undefined - and therefore registers no route - when __DEV__ is false', () => {
    const previous = (global as {__DEV__?: boolean}).__DEV__;
    jest.resetModules();
    (global as {__DEV__?: boolean}).__DEV__ = false;
    try {
      const seam = require('./debugPanels');
      expect(seam.DevBenchScreen).toBeUndefined();
    } finally {
      (global as {__DEV__?: boolean}).__DEV__ = previous;
      jest.resetModules();
    }
  });

  it('resolves to a real component when __DEV__ is true', () => {
    const previous = (global as {__DEV__?: boolean}).__DEV__;
    jest.resetModules();
    (global as {__DEV__?: boolean}).__DEV__ = true;
    try {
      const seam = require('./debugPanels');
      expect(typeof seam.DevBenchScreen).toBe('function');
    } finally {
      (global as {__DEV__?: boolean}).__DEV__ = previous;
      jest.resetModules();
    }
  });
});

describe('Phase 2H - lifecycle ownership', () => {
  const source = readFileSync(join(__dirname, 'MotorsScreen.tsx'), 'utf8');
  const executable = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  it('delegates every lifecycle trigger to the ACCEPTED bridge, registering no competing listener', () => {
    expect(executable).toContain('createMotorTestLifecycleBridge');
    // The bridge owns them; the screen only supplies the platform APIs.
    for (const source_ of [
      'addBackHandler',
      'addAppStateListener',
      'addBlurListener',
      'addBeforeRemoveListener',
    ]) {
      expect(executable).toContain(source_);
    }
    // Exactly one bridge, attached once and detached once.
    expect(executable.match(/createMotorTestLifecycleBridge\(/g) ?? []).toHaveLength(1);
    expect(executable.match(/bridge\.attach\(\)/g) ?? []).toHaveLength(1);
    expect(executable.match(/bridge\.detach\(\)/g) ?? []).toHaveLength(1);
  });

  it('uses React Navigation 7 beforeRemove as the supported hold mechanism', () => {
    expect(executable).toContain("navigation.addListener('beforeRemove'");
    expect(executable).toContain("navigation.addListener('blur'");
    expect(executable).toContain("BackHandler.addEventListener('hardwareBackPress'");
    expect(executable).toContain("AppState.addEventListener('change'");
  });

  it('replays a held navigation at most once and never recursively', () => {
    expect(executable).toContain('replayNavigation');
    // A one-shot latch guards the replay, so a duplicated source event
    // cannot dispatch navigation twice or re-enter beforeRemove.
    expect(executable).toMatch(/if \(replayed\) \{\s*return;\s*\}/);
    expect(executable).toMatch(/replayed = true;\s*navigation\.goBack\(\)/);
  });

  it('remounts on session replacement rather than re-parameterising in place', () => {
    // Keying on sessionId tears down the stale screen's state, refs and
    // effects before the replacement mounts, so no old callback, timer or
    // subscription can reach the new session.
    expect(executable).toMatch(/key=\{sessionKey\.sessionId\}/);
  });

  it('resolves the operator from the ONE official capability, never constructing a second', () => {
    // R2: the capability now comes from the build-time containment seam
    // rather than a motor-named coordinator accessor, so no motor surface
    // survives into a Release bundle. It is still exactly ONE capability,
    // resolved once, and still the official one.
    expect(executable).toContain('readMotorTestCapability(');
    expect(executable.match(/readMotorTestCapability\(/g) ?? []).toHaveLength(1);
    expect(executable).toContain('capability.operatorPort(');
    expect(executable.match(/capability\.operatorPort\(/g) ?? []).toHaveLength(1);
    for (const forbidden of [
      'new MspClient',
      'createMotorTestSessionBinding',
      'createMspTelemetryScheduler',
      'openSession',
    ]) {
      expect(executable).not.toContain(forbidden);
    }
  });
});
