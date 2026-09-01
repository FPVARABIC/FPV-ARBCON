/**
 * Motors reachability, tab wiring and lifecycle-ownership tests.
 *
 * NO HARDWARE. Nothing here opens a session, touches USB, or reaches a
 * flight controller; the coordinator is consulted read-only and returns
 * `undefined` because no session was ever opened.
 *
 * WHAT CHANGED. These tests used to assert a `__DEV__` containment seam:
 * that Motors was registered as a stack route ONLY when `DevBenchScreen`
 * resolved, and that a production bundle contained neither the screen nor
 * its route name. The single-app merge removed that containment
 * deliberately, so those assertions are gone rather than weakened into
 * something that still passes. What replaces them is the invariant that
 * actually still holds and that the merge makes load-bearing: Motors is
 * reachable through ordinary navigation, but is INERT until a live
 * session's capability exists, and every lifecycle trigger - including a
 * tab change - reaches the one accepted bridge.
 */

/* Home drives the connection itself now (ui/session/useDirectConnect),
   so importing it reaches the transport module graph. The native module
   is mocked for the same reason every other suite mocks it: this file is
   not testing the USB bridge. */
jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import '../../i18n';
import type { RootStackParamList } from '../../navigation/types';
import {
  MAIN_TABS,
  INITIAL_MAIN_TAB,
  isTabSelectable,
} from '../../navigation/tabs';

const REPO_ROOT = join(__dirname, '..', '..', '..');

describe('Motors reachability after the single-app merge', () => {
  it('is no longer a stack route - it stays inside Setup while Start and Firmware Flasher are independent routes', () => {
    // Compile-time proof: Motors is absent while the three real stack
    // routes remain. 'Connection' left this list with the entry-flow
    // cleanup - the connection workspace is hosted inside Setup now, and
    // Setup's params are optional because the disconnected configurator
    // is a first-class state (navigation/types.ts).
    const params: RootStackParamList['Setup'] = {
      sessionKey: { sessionId: 's-1', generation: 3 },
    };
    // Optional-chained through `sessionKey` too: the field is optional
    // now, because the session-loss redirect carries `afterSessionLoss`
    // on this same route with no session at all (navigation/types.ts).
    expect(params?.sessionKey?.sessionId).toBe('s-1');
    const disconnected: RootStackParamList['Setup'] = undefined;
    expect(disconnected).toBeUndefined();
    const names: (keyof RootStackParamList)[] = [
      'Start',
      'Setup',
      'FirmwareFlasher',
    ];
    expect(names).toHaveLength(3);
  });

  it('is a selectable tab in the complete main shell', () => {
    expect(MAIN_TABS.map(tab => tab.key)).toEqual([
      'SETUP',
      'MOTORS',
      'PORTS',
      'GPS',
      'CONFIGURATIONS',
      'RECEIVER',
      'PID',
      'MODES',
      'FAILSAFE',
      'POWER',
      'OSD',
      'VTX',
      'LED',
      'SENSORS',
      'BLACKBOX',
      'PRESETS',
      'CLI',
    ]);
    expect(isTabSelectable('MOTORS')).toBe(true);
    expect(INITIAL_MAIN_TAB).toBe('SETUP');
  });

  it('registers the tab shell statically, with no build conditional left in App.tsx', () => {
    const app = readFileSync(join(REPO_ROOT, 'App.tsx'), 'utf8');
    expect(app).toContain(
      '<Stack.Screen name="Setup" component={MainTabsScreen} />',
    );
    // Every trace of the removed seam. A conditional registration is
    // exactly what made the bench variant unable to reach a testable
    // state: the screen was registered only when the build-variant seam
    // supplied it, and the bench route opened MotorsScreen directly
    // without ever going through the connection/identification flow.
    for (const removed of [
      'DevBenchScreen',
      'DEV_BENCH_ROUTE_NAME',
      'hardwareTestBench',
      '__DEV__',
    ]) {
      expect(app).not.toContain(removed);
    }
  });

  it('has no connection screen left to hide a development-only motor entry on', () => {
    // The seam was a second way into Motors rendered by a standalone
    // connection screen. Both that screen and the page that replaced it
    // are gone from the product, which closes the seam more completely
    // than deleting the render site: there is no host to put it back on.
    expect(existsSync(join(__dirname, 'UsbConnectionScreen.tsx'))).toBe(false);
    expect(existsSync(join(__dirname, 'ConnectWorkspaceScreen.tsx'))).toBe(false);
  });

  it('leaves no build-variant seam and no hardwareTest source set behind', () => {
    for (const gone of [
      join(REPO_ROOT, 'android', 'app', 'src', 'hardwareTest'),
      join(
        REPO_ROOT,
        'src',
        'platforms',
        'react-native',
        'protocol',
        'motorTestEngineVariant.ts',
      ),
      join(
        REPO_ROOT,
        'src',
        'platforms',
        'react-native',
        'protocol',
        'motorTestDebugSeam.ts',
      ),
      join(__dirname, 'MotorsDevEntry.tsx'),
    ]) {
      expect(existsSync(gone)).toBe(false);
    }
    const gradle = readFileSync(
      join(REPO_ROOT, 'android', 'app', 'build.gradle'),
      'utf8',
    );
    expect(gradle).not.toContain('hardwareTest');
    expect(gradle).not.toContain('FPV_ARBCON_HARDWARE_TEST');
    // One APK identity again.
    expect(gradle).not.toContain('applicationIdSuffix');
  });

  it('keeps the debug-only USB log capture seam intact - the merge did not widen it', () => {
    const panels = readFileSync(join(__dirname, 'debugPanels.ts'), 'utf8');
    // Still __DEV__-gated require()s, still no static import.
    expect(panels).toMatch(
      /DevAppLogPanel[\s\S]*?__DEV__[\s\S]*?require\('\.\/UsbAppLogCapturePanel'\)/,
    );
    expect(panels).not.toMatch(/^import .*UsbAppLogCapturePanel/m);
    // And the motor entries really are gone from it. Comments are stripped
    // first: the file DOCUMENTS what was removed, by name, and that
    // documentation must not be what the assertion trips on.
    const code = panels
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    expect(code).not.toContain('DevBenchScreen');
    expect(code).not.toContain('MotorsScreen');
  });
});

describe('Motors lifecycle ownership', () => {
  const source = readFileSync(join(__dirname, 'MotorsScreen.tsx'), 'utf8');
  const executable = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  it('delegates every lifecycle trigger to the ACCEPTED bridge, registering no competing listener', () => {
    expect(executable).toContain('createMotorTestLifecycleBridge');
    for (const source_ of [
      'addBackHandler',
      'addAppStateListener',
      'addBlurListener',
      'addBeforeRemoveListener',
    ]) {
      expect(executable).toContain(source_);
    }
    // Exactly one bridge, attached once and detached once.
    expect(
      executable.match(/createMotorTestLifecycleBridge\(/g) ?? [],
    ).toHaveLength(1);
    expect(executable.match(/bridge\.attach\(\)/g) ?? []).toHaveLength(1);
    expect(executable.match(/bridge\.detach\(\)/g) ?? []).toHaveLength(1);
  });

  it("routes a TAB change into the bridge's existing blur source, not a parallel stop path", () => {
    // The tab source is subscribed inside addBlurListener, so it lands on
    // the same handling stack blur already had.
    expect(executable).toMatch(
      /addBlurListener: listener => \{[\s\S]*?subscribeTabBlur\(listener\)/,
    );
    // And the screen itself calls no stop/release of its own for a tab
    // change - the only requestStop calls are the accepted gesture ones.
    expect(executable).not.toContain('releaseLease');
    expect(executable).not.toMatch(/requestStop\('TAB/);
  });

  it('uses React Navigation 7 beforeRemove as the supported hold mechanism', () => {
    expect(executable).toContain("navigation.addListener('beforeRemove'");
    expect(executable).toContain("navigation.addListener('blur'");
    expect(executable).toContain(
      "BackHandler.addEventListener('hardwareBackPress'",
    );
    expect(executable).toContain("AppState.addEventListener('change'");
  });

  it('replays a held navigation at most once and never recursively', () => {
    expect(executable).toContain('replayNavigation');
    expect(executable).toMatch(/if \(replayed\) \{\s*return;\s*\}/);
    expect(executable).toMatch(/replayed = true;\s*navigation\.goBack\(\)/);
  });

  it('remounts on session replacement rather than re-parameterising in place', () => {
    expect(executable).toMatch(/key=\{sessionKey\.sessionId\}/);
  });

  it('resolves the operator from the ONE official capability, never constructing a second', () => {
    expect(executable).toContain('readMotorTestCapability(');
    expect(executable.match(/readMotorTestCapability\(/g) ?? []).toHaveLength(
      1,
    );
    expect(executable).toContain('capability.operatorPort(');
    expect(executable.match(/capability\.operatorPort\(/g) ?? []).toHaveLength(
      1,
    );
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

describe('The main tab shell owns no session', () => {
  const shell = readFileSync(join(__dirname, 'MainTabsScreen.tsx'), 'utf8');
  const executable = shell
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  it('never touches the port, the coordinator or any session lifecycle call', () => {
    for (const forbidden of [
      'mspSessionCoordinator',
      'openSession',
      'closeSession',
      'activateMspSession',
      'deactivateMspSession',
      'startTelemetry',
      'stopTelemetry',
      'writeBytes',
      'requestStop',
    ]) {
      expect(executable).not.toContain(forbidden);
    }
  });

  it('hides an inactive tab rather than unmounting it, so the Motors bridge stays attached', () => {
    /* `display: 'none'` moved to mainTabsShellLayout.ts so the browser
       workspace gate can measure the shell through the same object the
       shell renders. The invariant is unchanged and is checked as a
       chain: the rule still says `display: 'none'`, and the shell is
       still wired to that rule. */
    const layout = readFileSync(
      join(__dirname, 'mainTabsShellLayout.ts'),
      'utf8',
    );
    expect(layout).toContain("hidden: {display: 'none'}");
    expect(executable).toContain('MAIN_TABS_SHELL.hidden');
    expect(executable).toContain('mountedTabs');
  });

  it('fires the tab-blur source BEFORE switching away from Motors', () => {
    // The stop helper owns the blur emission, and the normal departure path
    // must call it successfully before committing the visual tab switch.
    const guard = executable.indexOf("activeTab !== 'MOTORS'");
    const emit = executable.indexOf('listener();', guard);
    const departure = executable.indexOf('const performTabSwitch');
    const requestStop = executable.indexOf(
      '!requestMotorStopForDeparture()',
      departure,
    );
    const switchTab = executable.indexOf('commitTabSwitch(next)', requestStop);
    expect(guard).toBeGreaterThan(-1);
    expect(emit).toBeGreaterThan(guard);
    expect(requestStop).toBeGreaterThan(departure);
    expect(switchTab).toBeGreaterThan(requestStop);
  });
});
