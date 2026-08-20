/**
 * @format
 */

jest.mock('../src/platforms/react-native/transport/native/NativeUsbSerialTransport');

// Pass 7.4, Step 5 - the real SetupScreen (App.tsx's own navigation
// stack reaches it for real in this file) now imports OrientationHero,
// which imports the real Skia-backed OrientationRenderer - mounting it
// under Jest fails (per Step 2's own established finding: no real
// CanvasKit-WASM wired in). Mirrors SetupScreen.test.tsx's own identical
// mock.
jest.mock('../src/ui/orientation3d', () => ({
  OrientationRenderer: () => null,
}));

// Pass 7.1 BUGFIX test support - wraps the real NavigationContainer so a
// test can deterministically hold back its onReady callback (simulating
// the narrow real-world window where App.tsx's own isNavigationReady
// state is still false) and release it on demand, rather than fighting
// real container-readiness timing (which settles almost immediately and
// is not something this codebase's tooling can reliably delay). Fully
// transparent by default (holdReady starts false, and every describe
// block other than the one that sets it resets it in afterEach) - the
// other tests in this file render through the real, unmodified
// NavigationContainer underneath; only onReady's forwarding is ever
// intercepted, nothing about rendering/navigation itself.
jest.mock('@react-navigation/native', () => {
  const actualReactNavigation = jest.requireActual('@react-navigation/native');
  const ReactLib = require('react');
  // capturedRef: the SAME navigationRef object App.tsx's own
  // useNavigationContainerRef() call produced (captured via this
  // wrapper's own forwardRef argument, not a separate mock) - exposed so
  // a test can imperatively call .navigate() on it directly, the same way
  // App.tsx itself does, to construct scenarios (e.g. malformed params)
  // that aren't reachable through the real, type-checked
  // UsbConnectionScreen.tsx call site.
  const readyControl = {holdReady: false, heldCallback: null, capturedRef: null};
  const WrappedNavigationContainer = ReactLib.forwardRef((props: any, ref: any) => {
    readyControl.capturedRef = ref;
    const {onReady, ...rest} = props;
    const wrappedOnReady = () => {
      if (readyControl.holdReady) {
        readyControl.heldCallback = onReady ?? null;
        return;
      }
      if (onReady) {
        onReady();
      }
    };
    return ReactLib.createElement(actualReactNavigation.NavigationContainer, {
      ...rest,
      ref,
      onReady: wrappedOnReady,
    });
  });
  return {
    ...actualReactNavigation,
    NavigationContainer: WrappedNavigationContainer,
    __navigationReadyControl: readyControl,
  };
});

// Pass 7.1 - the navigation-foundation tests below (redirect-on-INACTIVE,
// hardware Back) drive App's real Connection -> Setup flow, so they need a
// controllable client. Rather than exercising the real native TurboModule
// bridge (NativeUsbSerialTransport, mocked above only for the pre-existing
// static-render test), this replaces usbSerialTransportClient itself with a
// fake of the same shape UsbConnectionScreen.test.tsx already establishes
// (createMockClient() there) - isSupportedDevice/localizeTransportError etc.
// stay real via requireActual. listDevices() defaults to resolving an empty
// array so the pre-existing test below (which never presses connect, but
// still triggers UsbConnectionScreen's own mount-time auto-scan) keeps
// working unchanged.
jest.mock('../src/platforms/react-native/transport', () => {
  const actual = jest.requireActual('../src/platforms/react-native/transport');
  const sessionDetachedListeners = new Set();
  const fakeClient = {
    listDevices: jest.fn().mockResolvedValue([]),
    openDevice: jest.fn(),
    closeSession: jest.fn(),
    onDeviceAttached: jest.fn(() => jest.fn()),
    onDeviceDetached: jest.fn(() => jest.fn()),
    onSessionDetached: jest.fn(listener => {
      sessionDetachedListeners.add(listener);
      return jest.fn(() => sessionDetachedListeners.delete(listener));
    }),
    onDataReceived: jest.fn(() => jest.fn()),
    onError: jest.fn(() => jest.fn()),
    // Never settle - same "quiet fake client" reasoning as
    // UsbConnectionScreen.test.tsx's own createMockClient(): identify()'s
    // requests never get a chance to arm a real timer, and startReading()
    // never resolving means MspSessionCoordinator's chained
    // beginIdentification() never even starts (see MspSessionCoordinator.ts's
    // openSession() doc comment) - these tests only care about ownership
    // reaching ACTIVE and about navigation, never about identification.
    writeBytes: jest.fn(() => new Promise<void>(() => undefined)),
    stopReading: jest.fn(() => new Promise<void>(() => undefined)),
    startReading: jest.fn(() => new Promise<void>(() => undefined)),
    // False = the Android posture (no browser chooser), which is what
    // every pre-existing test here always exercised implicitly. The
    // firmware screen calls this unconditionally on mount, and its
    // flash-progress subscription must return an unsubscribe like the
    // other listener fakes above.
    supportsDevicePicker: jest.fn(() => false),
    onDfuFlashProgress: jest.fn(() => jest.fn()),
  };
  return {...actual, usbSerialTransportClient: fakeClient};
});

import React from 'react';
import { BackHandler, I18nManager, Text } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';

import i18n from '../src/i18n';
import { usbSerialTransportClient } from '../src/platforms/react-native/transport';
import { mspSessionCoordinator } from '../src/platforms/react-native/protocol';
import * as ReactNavigationNative from '@react-navigation/native';

type FakeUsbClient = {
  listDevices: jest.Mock;
  openDevice: jest.Mock;
};

// The extra export the @react-navigation/native mock factory above adds -
// not part of the real module's own types, hence the cast.
const navigationReadyControl = (
  ReactNavigationNative as unknown as {
    __navigationReadyControl: {
      holdReady: boolean;
      heldCallback: (() => void) | null;
      capturedRef: {navigate: (name: string, params?: unknown) => void} | null;
    };
  }
).__navigationReadyControl;

const fakeClient = usbSerialTransportClient as unknown as FakeUsbClient;

// Pass 7.7B (A-6): these two spies MUST be installed before the App
// module graph is evaluated - App.tsx forces RTL at module scope, once,
// and Node's module cache means only the very first load can ever be
// observed. They therefore live here, immediately above the load, rather
// than inside the RTL test.
const allowRTLSpy = jest.spyOn(I18nManager, 'allowRTL');
const forceRTLSpy = jest.spyOn(I18nManager, 'forceRTL');

// Pass 7.7B (A-6): the App module graph (navigation, both screens, the
// whole protocol and UI stack) is loaded ONCE, here at module scope.
//
// It used to be require()d from inside the first test. That require is
// pure, synchronous fixture work - it awaits nothing and can be shortened
// by nothing - but under `jest --coverage` it costs seconds (measured:
// ~9.1 s on this machine) because every module in the graph executes its
// instrumented form for the first time. Charged to a test, it exhausted
// Jest's 5000 ms per-test budget on its own; Jest then abandoned the
// still-running test body, ran afterEach against it, and the abandoned
// continuation went on to touch an already-unmounted renderer. Module
// scope is not subject to the per-test timeout, so the cost is simply no
// longer charged to a test - nothing is skipped, deferred or hidden.
//
// require(), not import: the jest.mock() factories above are hoisted, but
// so are imports, and this load must happen AFTER the two spies.
const App = require('../App').default as () => React.JSX.Element;

/** A single supported, single-port device - the same shape
 * UsbConnectionScreen.test.tsx's own supportedDevice() fixture uses, kept
 * minimal here since only the safe-auto-select path (exactly one supported
 * device) is exercised. */
function supportedDevice() {
  return {
    deviceId: 1,
    vendorId: 0x1a86,
    productId: 0x7523,
    productName: 'CH340 Serial',
    manufacturerName: 'QinHeng',
    driverType: 'CH34X',
    portCount: 1,
  };
}

// Mirrors UsbConnectionScreen.test.tsx's own trackedRenderers/afterEach
// pattern: UsbConnectionScreen keeps rendering UsbSerialDebugPanel (Pass
// 5.3 temporary debug scaffolding, unrelated to Pass 7.1) even once
// navigated away from - native-stack keeps previously-visited screens
// mounted, it does not unmount them - and that panel's own real
// setInterval(1000ms) poll otherwise keeps running past test end, which is
// what leaves Jest's process unable to exit (or, with detectOpenHandles
// off, hangs the whole run).
const trackedRenderers: ReactTestRenderer.ReactTestRenderer[] = [];

/**
 * Pass 7.7B.1: COMPLETE renderer-lifetime ownership.
 *
 * Jest's per-test timeout stops AWAITING a test body; it does not cancel
 * it. Pass 7.7B tracked only the render helper's own Promise and argued
 * from Promise-callback order that the body would resume first. That
 * argument expires at the body's next await - and most tests here have
 * one (`await act(...)` around a deactivation, a hardware-Back press, a
 * held onReady release) followed by a further `renderer.root` read. A
 * test timing out inside one of those later awaits would find its render
 * Promise long settled, teardown would sail through, unmount, and the
 * body would then reach `.root` on a dead tree.
 *
 * So the unit of ownership is the WHOLE renderer-using operation. A
 * ticket is added synchronously, before the operation's first statement,
 * and removed in a `finally` - released on success, on failure and on an
 * abandoned continuation alike. Teardown waits until the set is empty
 * before it opens any act() scope or unmounts anything.
 *
 * DEADLOCK SAFETY: an owning operation must never await teardown. Only
 * afterEach and the two teardown regressions below call
 * teardownRenderers, and those regressions deliberately use plain `it`
 * rather than itOwningRenderer for exactly that reason. Every owning
 * operation here completes on its own - real scheduler ticks and the
 * screen's own scan Promise - and needs no unmount and no other
 * teardown-only action to finish.
 */
const rendererOwners = new Set<Promise<void>>();

function ownRendererOperation<T>(operation: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const ticket = new Promise<void>(resolve => {
    release = resolve;
  });
  rendererOwners.add(ticket);
  return (async () => {
    try {
      return await operation();
    } finally {
      rendererOwners.delete(ticket);
      release();
    }
  })();
}

/**
 * Waits until no renderer-owning operation is in flight. The loop (not a
 * single Promise.all) covers an operation that starts another while this
 * is waiting; the Set lets several be owned at once without any of them
 * overwriting an earlier owner. A ticket resolves rather than rejects,
 * so a failing operation still releases teardown - its rejection stays
 * with the test that started it and is never swallowed here.
 */
async function settleRendererOwners(): Promise<void> {
  while (rendererOwners.size > 0) {
    await Promise.all(Array.from(rendererOwners));
  }
}

/**
 * `it()` for a test whose ENTIRE body owns its renderer: creation, every
 * later await, every query, every press, and the final renderer access.
 * Jest still awaits the body normally - the ticket is an additional
 * teardown-safety contract, not a substitute for awaiting.
 */
function itOwningRenderer(name: string, body: () => Promise<void>): void {
  it(name, () => ownRendererOperation(body));
}

/** The top-level `test()` equivalent of itOwningRenderer. */
function testOwningRenderer(name: string, body: () => Promise<void>): void {
  test(name, () => ownRendererOperation(body));
}

/** The single teardown path for this file. Idempotent: a renderer that
 * was already unmounted reports toJSON() === null and is skipped. */
async function teardownRenderers(): Promise<void> {
  await settleRendererOwners();

  const renderers = trackedRenderers.splice(0, trackedRenderers.length);
  await act(async () => {
    for (const renderer of renderers) {
      if (renderer.toJSON() !== null) {
        renderer.unmount();
      }
    }
    await flushSchedulerTick();
  });
}

/**
 * THE BOARD IDENTIFIES ITSELF, because the wall now requires it.
 *
 * This file's fake transport client deliberately never settles a read,
 * so MspSessionCoordinator's own identification never even starts - and
 * that was fine while the app only cared about ownership reaching
 * ACTIVE. It is not fine any more: the configuration workspace is
 * registered in the navigator only when a session is ACTIVE *and*
 * IDENTIFIED (ui/session/verifiedConnection.ts), so a board that never
 * says what it is correctly leaves the operator on the connection
 * workspace.
 *
 * These tests are about navigation, not about identification - which has
 * its own coverage - so the coordinator is asked to report the answer a
 * real board would give. Everything else, including ownership, is the
 * real thing.
 */
const IDENTIFIED_BOARD = Object.freeze({
  status: 'SUCCEEDED' as const,
  identity: Object.freeze({
    firmware: Object.freeze({identifier: 'BTFL', knownFamily: 'BETAFLIGHT'}),
    apiVersion: Object.freeze({
      mspProtocolVersion: 0,
      apiVersionMajor: 1,
      apiVersionMinor: 47,
    }),
    board: Object.freeze({}),
  }),
});

beforeEach(() => {
  jest
    .spyOn(mspSessionCoordinator, 'getIdentificationState')
    .mockImplementation(() => IDENTIFIED_BOARD as never);
});

afterEach(async () => {
  await teardownRenderers();
  /**
   * THE COORDINATOR IS A MODULE SINGLETON, and since the entry flow
   * connects by itself, an ordinary render can leave a live session in
   * it. The next test's connect workspace then ADOPTS that session on
   * mount and renders the connected screen, so a test asserting the
   * disconnected posture fails for a reason that has nothing to do with
   * the behaviour it is testing. Ending them here keeps each test's
   * starting state its own.
   */
  for (const sessionId of mspSessionCoordinator.listSessionIds()) {
    mspSessionCoordinator.deactivateMspSession(sessionId);
  }
});

// Mirrors UsbConnectionScreen.test.tsx's own findPressableMatch()/
// findByTestID(): a Pressable's testID is matched by both the logical
// element (which carries onPress) and an underlying host node - the
// `'onPress' in node.props` filter is what disambiguates them there, kept
// identical here for the one pressable this file needs (اتصال).
function findByTestID(renderer: ReactTestRenderer.ReactTestRenderer, testID: string) {
  const matches = renderer.root.findAllByProps({testID});
  const match = matches.find(node => 'onPress' in node.props);
  if (!match) {
    throw new Error(`No pressable instance found with testID "${testID}"`);
  }
  return match;
}

/** Pass 7.4, Step 5: the real SetupScreen no longer renders a raw
 * sessionId:generation Text node (that was only ever Pass 7.1's own stub-
 * verification device) - "is the real Setup screen currently showing"
 * is now checked via its root View's own 'setup-screen' testID instead
 * (not Text-typed, so the Text-only filter above does not apply). */
function isOnSetupScreen(renderer: ReactTestRenderer.ReactTestRenderer): boolean {
  return renderer.root.findAllByProps({testID: 'setup-screen'}).length > 0;
}

/**
 * Reaches the CONNECTED state, however this build gets there.
 *
 * ENTRY CLEANUP changed who initiates the connection. Arriving at the
 * configurator IS the request to connect - the operator pressed "فتح
 * إعدادات متحكم الطيران" - so when exactly one authorized board is
 * present the workspace opens it itself and «اتصال» is never rendered.
 * Pressing a button that no longer exists is how these tests failed.
 *
 * This deliberately does NOT assert which path ran: both are correct
 * product behaviour (an ambiguous or absent board still waits for the
 * press), and every caller asserts the CONNECTED RESULT immediately
 * afterwards, which is the thing they actually care about. A build that
 * reached neither still fails there, loudly.
 */
async function reachConnected(renderer: ReactTestRenderer.ReactTestRenderer) {
  const button = renderer.root
    .findAllByProps({testID: 'usb-connect-button'})
    .find(node => 'onPress' in node.props);
  await act(async () => {
    if (button !== undefined) {
      await button.props.onPress();
      return;
    }
    // Auto-connect already ran; let its state settle exactly as a press
    // would have.
    await flushSchedulerTick();
  });
}

// RE-INVESTIGATED for the navigation-not-ready race fix: this is NOT the
// linking/getInitialURL() race the original comment here assumed - linking
// is never configured on NavigationContainer in App.tsx, so
// NavigationContainerInner's own isLinkingEnabled is false and
// isLinkingReady is therefore already true on the very first render,
// unconditionally (see node_modules/@react-navigation/native/src/
// NavigationContainer.tsx) - there is no getInitialURL() race to wait out
// here at all. onReady was investigated too (it now exists in App.tsx,
// added for the navigation-not-ready race fix) and is NOT usable as this
// wait's replacement either: it is the wrong signal for a different
// concern (App.tsx's own redirect-effect readiness, not whether
// UsbConnectionScreen's mount-time auto-scan has settled), and the
// dedicated race-condition test below deliberately holds onReady back
// while still needing this same connect flow to succeed, which awaiting
// onReady here would deadlock.
//
// The actual, confirmed cause: React's own `scheduler` package (used
// internally by react-native-screens/native-stack for the initial mount)
// schedules its passive-effect flush via MessageChannel, falling back to
// setTimeout(fn, 0) - see node_modules/scheduler/cjs/
// scheduler.development.js's use of MessageChannel/localSetTimeout. That
// is a real macrotask, not a microtask chain, so no amount of
// `await Promise.resolve()` hops (tried first; confirmed insufficient)
// can flush it inside act() - only yielding a REAL event-loop tick can.
// This is therefore not a time-based race with a duration to pad for
// margin - it is "has at least one such scheduler tick run yet", which
// setTimeout(fn, 0) answers deterministically regardless of how long that
// tick actually takes to fire. Two hops (not one) as a small, cheap
// (impact is single-digit milliseconds, not more) allowance for more than
// one such tick being scheduled; confirmed stable across 15+ repeated
// runs at one hop already, so this is a safety margin on an
// already-solid result, not a guess. Not fake timers - nothing else in
// this file uses them, and MessageChannel-based scheduling is not
// something Jest's fake timers intercept by default.
function flushSchedulerTick(): Promise<void> {
  return new Promise<void>(resolve => setTimeout(() => resolve(), 0));
}

/**
 * Pass 7.7B (A-6): UsbConnectionScreen's mount-time auto-scan
 * (hasAutoScannedRef -> handleRefresh) dispatches SCAN_SUCCESS only after
 * client.listDevices() resolves. Awaiting THAT promise - the very one the
 * screen itself awaited, read back off the jest.fn's recorded results -
 * is an observable readiness condition, not a guess about elapsed time:
 * once every recorded listDevices() call has settled, the reducer update
 * has either already been dispatched or is one microtask away, and the
 * scheduler tick that follows flushes it plus the passive effects React
 * queues off it. All of it inside the caller's own act() scope, which is
 * what removes the "update to UsbConnectionScreen was not wrapped in
 * act()" warning at UsbConnectionScreen.tsx's dispatch({type:
 * 'SCAN_SUCCESS'}).
 */
async function settlePendingScans(): Promise<void> {
  // One real scheduler tick so React's passive effects - the mount-time
  // auto-scan among them - actually run and call listDevices().
  await flushSchedulerTick();
  // Then the observable readiness condition itself: every scan promise
  // the screen is awaiting, positively settled.
  await Promise.all(
    fakeClient.listDevices.mock.results
      .filter(result => result.type === 'return')
      .map(result => Promise.resolve(result.value).then(undefined, () => undefined)),
  );
  // And one more tick for the dispatch that follows a resolved scan and
  // anything React schedules off it.
  await flushSchedulerTick();
}

/** Mounts App, then lets its mount-time device scan and its first
 * scheduler-queued passive effects settle inside a second awaited act()
 * (see settlePendingScans() and flushSchedulerTick()) - the shared
 * foundation every test in this file builds on. */
function renderApp(): Promise<ReactTestRenderer.ReactTestRenderer> {
  return ownRendererOperation(
    async () => {
      let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
      try {
        await act(async () => {
          renderer = ReactTestRenderer.create(<App />);
        });
        // ENTRY CLEANUP: the configure choice opens the 'Setup' route
        // DIRECTLY - no 'Connection' stop exists anymore. The route has
        // no sessionKey yet, so the tab shell renders the embedded
        // connection workspace (SetupConnectWorkspace), whose mount-time
        // auto-scan these lifecycle tests then observe exactly as they
        // observed the old standalone screen's.
        await act(async () => {
          findByTestID(renderer as ReactTestRenderer.ReactTestRenderer, 'start-configure').props.onPress();
          await flushSchedulerTick();
        });
        // Own the scan settlement in its own awaited act() scope: React
        // defers a mount's passive effects until the creating act()
        // scope pops, so the auto-scan cannot even have started inside
        // the scope above.
        await act(async () => {
          await settlePendingScans();
        });
      } finally {
        if (renderer !== undefined) {
          trackedRenderers.push(renderer);
        }
      }
      return renderer as ReactTestRenderer.ReactTestRenderer;
    },
  );
}

/** Mounts App, lets the safe auto-select policy pick the sole supported
 * device, and presses اتصال - reaching the CONNECTED Setup workspace
 * exactly the way a real user does now: the embedded connection
 * workspace's onSessionEstablished re-parameterizes the already-focused
 * 'Setup' route in place (SetupScreen.tsx), no navigation push involved. */
function renderAppConnectedToSetup(sessionId: string) {
  return ownRendererOperation(
    async () => {
      fakeClient.listDevices.mockResolvedValueOnce([supportedDevice()]);
      fakeClient.openDevice.mockResolvedValueOnce(sessionId);

      const renderer = await renderApp();
      await reachConnected(renderer);

      expect(isOnSetupScreen(renderer)).toBe(true);
      return renderer;
    },
  );
}

/** Every <Text> currently rendered, joined children included. */
function allText(renderer: ReactTestRenderer.ReactTestRenderer): unknown[] {
  return renderer.root
    .findAllByType(Text)
    .map(node => (Array.isArray(node.props.children) ? node.props.children.join('') : node.props.children));
}

testOwningRenderer('opens the CONNECTION workspace from Start - no tab shell exists yet - and forces RTL', async () => {
  const renderer = await renderApp();

  const texts = allText(renderer);

  /*
   * THE HARD WALL. This test used to assert the opposite: that the door
   * opened the tab shell, which then hosted the connection workspace
   * inside its Setup tab. That shape put the whole configurator - rail,
   * tab bar and fifteen destinations - in front of an operator with
   * nothing plugged in. The configuration workspace is now registered
   * in the navigator ONLY while a flight controller is verified, so
   * before that there is no shell to render at all.
   */
  expect(renderer.root.findAllByProps({testID: 'connect-workspace-screen'}).length).toBeGreaterThan(0);
  expect(renderer.root.findAllByProps({testID: 'setup-connect-workspace'}).length).toBeGreaterThan(0);
  expect(renderer.root.findAllByProps({testID: 'main-tabs'}).length).toBe(0);
  expect(texts).toContain(i18n.t('connection.instructionPrimary'));
  // The spies were installed above the module-scope load of ../App, so
  // these still assert on App.tsx's own one-time module-scope RTL forcing
  // - exactly what this test asserted before, from the only place that
  // can still observe it.
  expect(allowRTLSpy).toHaveBeenCalledWith(true);
  expect(forceRTLSpy).toHaveBeenCalledWith(true);
});

describe('App - Pass 7.7B: coverage lifecycle', () => {
  itOwningRenderer('completes the mount-time device scan INSIDE act(), with no act() warning', async () => {
    const recorded: string[] = [];
    const originalError = console.error.bind(console);
    // Recording, not suppressing: every argument list is still forwarded
    // to the real console.error, so nothing is hidden from the run.
    const errorSpy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      recorded.push(args.map(argument => String(argument)).join(' '));
      originalError(...args);
    });

    let connected = false;
    try {
      // A scan that settles LATER than any fixed number of scheduler
      // hops would cover. A microtask- or immediate-macrotask-resolved
      // scan would pass this test even with the settlement removed, so
      // it would prove nothing; this one is only inside the act() scope
      // if settlePendingScans() genuinely awaits the screen's own scan
      // promise. Verified as a negative control: deleting that await
      // fails this test with the screen still showing "جارٍ البحث".
      fakeClient.listDevices.mockImplementationOnce(
        () => new Promise(resolve => setTimeout(() => resolve([supportedDevice()]), 200)),
      );
      const renderer = await renderApp();
      // Read with NO further flushing of any kind between the mount and
      // this line - that is what makes it evidence about the act() scope.
      connected = isOnSetupScreen(renderer);
    } finally {
      errorSpy.mockRestore();
    }

    // THE SCAN SETTLED INSIDE renderApp()'s OWN act() SCOPE, proven by
    // the strongest observable this flow has: the app is CONNECTED. The
    // entry flow only opens a board the scan already returned, so
    // reaching the Setup screen with no further flushing of any kind is
    // only possible if that scan completed inside the scope. (This used
    // to read the device name off the connection workspace - correct
    // until the workspace stopped being where an unambiguous board
    // leaves you.)
    expect(connected).toBe(true);
    expect(recorded.filter(message => message.includes('not wrapped in act'))).toEqual([]);
    expect(recorded.filter(message => message.includes('overlapping act'))).toEqual([]);
  });

  /**
   * The DANGEROUS boundary, mirroring the Setup integration suite's own
   * regression: the render Promise has already settled, and the owning
   * operation is parked on a SECOND await when teardown starts. Waiting
   * only for the render Promise (Pass 7.7B) unmounts here; waiting for
   * the complete operation does not.
   *
   * A plain `it`, not itOwningRenderer: this test awaits teardown
   * itself, and an owning operation that awaits teardown would deadlock
   * against its own ticket.
   */
  it('teardown waits for the COMPLETE renderer-owning operation, not just its render', async () => {
    // A real deferred Promise, not a sleep: nothing advances until this
    // test releases it.
    let releaseGate!: () => void;
    const gate = new Promise<void>(resolve => {
      releaseGate = resolve;
    });
    let announceRendered!: (renderer: ReactTestRenderer.ReactTestRenderer) => void;
    const rendered = new Promise<ReactTestRenderer.ReactTestRenderer>(resolve => {
      announceRendered = resolve;
    });

    let textsAfterGate: unknown[] | undefined;
    let operationFinished = false;
    let operationError: unknown;

    const owning = ownRendererOperation(async () => {
      const renderer = await renderApp();
      announceRendered(renderer);
      await gate;
      textsAfterGate = allText(renderer);
      operationFinished = true;
    }).catch(error => {
      operationError = error;
    });

    const renderer = await rendered;
    expect(renderer.toJSON()).not.toBeNull();

    const teardown = teardownRenderers();

    // Teardown must be waiting, not unmounting - give it every tick it
    // would need to reach an unmount if it were going to.
    await flushSchedulerTick();
    await flushSchedulerTick();
    expect(renderer.toJSON()).not.toBeNull();
    expect(trackedRenderers).toContain(renderer);
    expect(textsAfterGate).toBeUndefined();
    expect(operationFinished).toBe(false);

    releaseGate();
    await owning;

    expect(operationError).toBeUndefined();
    expect(operationFinished).toBe(true);
    expect(textsAfterGate).toContain(i18n.t('connection.instructionPrimary'));

    await teardown;
    expect(renderer.toJSON()).toBeNull();
    expect(trackedRenderers).toHaveLength(0);

    // Idempotent - and the file-level afterEach makes it a third run.
    await teardownRenderers();
    expect(renderer.toJSON()).toBeNull();
  });

  it('teardown settles an un-awaited render continuation before it unmounts anything', async () => {
    let textsSeenWhileMounted: unknown[] | undefined;
    let continuationError: unknown;

    // Deliberately NOT awaited here - this is exactly the state Jest
    // leaves a test in when it exceeds its timeout mid-render.
    const abandoned = renderApp().then(
      renderer => {
        textsSeenWhileMounted = allText(renderer);
      },
      error => {
        continuationError = error;
      },
    );

    await teardownRenderers();

    // The continuation ran to completion against a still-mounted tree.
    expect(continuationError).toBeUndefined();
    expect(textsSeenWhileMounted).toContain(i18n.t('connection.instructionPrimary'));
    await abandoned;

    // ...and the renderer really is unmounted afterwards, so the
    // pre-fix ".root after unmount" access is now impossible by ordering.
    expect(trackedRenderers).toHaveLength(0);

    // Idempotent: running the same teardown again is harmless.
    await teardownRenderers();
  });
});

describe('App - Pass 7.1 navigation foundation', () => {
  itOwningRenderer('transitions the Setup tab from the embedded connection workspace to the real connected SetupScreen on a successful connect - in place, no route change', async () => {
    const sessionId = 'session-app-nav-1';
    const renderer = await renderAppConnectedToSetup(sessionId);

    // The real Setup screen no longer displays a raw sessionId:generation
    // Text node (that was only ever Pass 7.1's own stub-verification
    // device) - the coordinator having genuinely committed a session key
    // for THIS exact sessionId, combined with TopSystemBar's own
    // connection indicator showing "متصل" (CONNECTED - only reachable
    // via useMspOwnershipState(sessionId) reading real ACTIVE state AND
    // useMspRecoveryState(sessionId) reading the real MspClient's own
    // default READY state), is a STRONGER end-to-end proof that the
    // correct sessionId flowed through route.params all the way to the
    // real hooks than a static text comparison ever was: a wrong or
    // empty sessionId would read INACTIVE/undefined instead and show
    // "غير متصل".
    const expectedKey = mspSessionCoordinator.getSessionKey(sessionId);
    expect(expectedKey).toBeDefined();

    const texts = renderer.root
      .findAllByType(Text)
      .map(node => (Array.isArray(node.props.children) ? node.props.children.join('') : node.props.children));
    expect(texts).toContain(i18n.t('setupTopBar.connectionState.connected'));

    // Pass 7.4 CI-hang fix: this reaches a real, successful connect via
    // the real mspSessionCoordinator singleton (real MSP_ATTITUDE tick-
    // driver setInterval included) - unlike the renderer itself (cleaned
    // up by the file-level afterEach), nothing tears the session down
    // automatically on unmount. Must be torn down explicitly or it leaks
    // a real, permanently-ticking interval for the rest of the process.
    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    });
  });

  itOwningRenderer("the root redirect listener resets the stack to the DISCONNECTED configurator once the tracked session's ownership goes INACTIVE while 'Setup' has focus", async () => {
    const sessionId = 'session-app-redirect-1';
    const renderer = await renderAppConnectedToSetup(sessionId);
    expect(mspSessionCoordinator.getOwnershipState(sessionId)).toBe('ACTIVE');

    // deactivateMspSession() (a public, intentional-close method) is used
    // here as the pragmatic trigger - handlePhysicalDetach() is private and
    // unreachable directly from a test. They are two DISTINCT methods (one
    // passes through CLOSING, one skips it) that happen to both end at the
    // same OBSERVABLE signal this test actually cares about: ownership ->
    // INACTIVE. That is all the redirect listener (App.tsx) reacts to; it
    // does not care which of the coordinator's own code paths produced it.
    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    });

    /*
     * No screen is left holding the dead session - and, since the wall
     * moved up, no SHELL either. Losing the board removes the whole
     * configuration workspace from the navigator (App.tsx), so what the
     * operator gets is the connection workspace, not Motors or PID with
     * a disconnected message inside a tab bar. This assertion used to
     * require main-tabs to be PRESENT; requiring its absence is the
     * behaviour change, stated rather than softened.
     */
    expect(isOnSetupScreen(renderer)).toBe(false);
    expect(renderer.root.findAllByProps({testID: 'main-tabs'}).length).toBe(0);
    expect(renderer.root.findAllByProps({testID: 'connect-workspace-screen'}).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({testID: 'setup-connect-workspace'}).length).toBeGreaterThan(0);
    const texts = renderer.root
      .findAllByType(Text)
      .map(node => (Array.isArray(node.props.children) ? node.props.children.join('') : node.props.children));
    expect(texts).toContain(i18n.t('connection.instructionPrimary'));
  });

  itOwningRenderer('Android hardware Back from Setup returns HOME (Start) WITHOUT deactivating the still-active MSP session', async () => {
    const backHandlerSpy = jest.spyOn(BackHandler, 'addEventListener');
    const deactivateSpy = jest.spyOn(mspSessionCoordinator, 'deactivateMspSession');
    const sessionId = 'session-app-back-1';
    const renderer = await renderAppConnectedToSetup(sessionId);

    // react-navigation's own NavigationContainer wires Android hardware
    // Back entirely through the plain JS BackHandler module (see
    // @react-navigation/native's useBackButton.native.js: it registers one
    // 'hardwareBackPress' listener and calls navigation.goBack() from
    // inside it) - there is no native gesture/UI layer involved once the
    // press reaches JS, so invoking the exact listener function React
    // Navigation itself registered is a faithful simulation, not an
    // approximation. react-test-renderer alone cannot trigger this (there
    // is no host-visible "back" affordance to press), and this project has
    // no @testing-library/react-native install to reach for either -
    // spying on BackHandler.addEventListener to capture, then directly
    // invoke, the real registered callback is the correct approach for
    // this codebase's existing tooling.
    const hardwareBackCall = backHandlerSpy.mock.calls.find(([eventName]) => eventName === 'hardwareBackPress');
    expect(hardwareBackCall).toBeDefined();
    const hardwareBackHandler = hardwareBackCall![1] as () => boolean;

    await act(async () => {
      hardwareBackHandler();
    });

    expect(isOnSetupScreen(renderer)).toBe(false);
    // The stack under Setup is Start alone now - Back is one hop Home,
    // with no connection stop to loop through on the way.
    expect(renderer.root.findAllByProps({testID: 'start-route-group'}).length).toBeGreaterThan(0);
    expect(deactivateSpy).not.toHaveBeenCalled();
    expect(mspSessionCoordinator.getOwnershipState(sessionId)).toBe('ACTIVE');

    deactivateSpy.mockRestore();

    // Pass 7.4 CI-hang fix: the whole point of this test is that the
    // session stays ACTIVE (never deactivated) after a hardware Back
    // press - but it still must not stay ACTIVE past the test's own end,
    // or its real telemetry tick-driver setInterval leaks. Torn down
    // here, after every existing assertion above, once the spy itself is
    // no longer needed.
    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    });
  });

  itOwningRenderer('re-entering the configurator ADOPTS a still-active session instead of offering a second connect - no navigation loop, no duplicate connection surface', async () => {
    const sessionId = 'session-app-adopt-1';
    const renderer = await renderAppConnectedToSetup(sessionId);

    // Back to Start, session deliberately left ACTIVE (previous test's
    // own proven contract).
    const backHandlerSpy = jest.spyOn(BackHandler, 'addEventListener');
    const hardwareBackCall = backHandlerSpy.mock.calls.find(([eventName]) => eventName === 'hardwareBackPress');
    const hardwareBackHandler = hardwareBackCall![1] as () => boolean;
    await act(async () => {
      hardwareBackHandler();
    });
    expect(renderer.root.findAllByProps({testID: 'start-route-group'}).length).toBeGreaterThan(0);
    expect(mspSessionCoordinator.getOwnershipState(sessionId)).toBe('ACTIVE');

    // Configure again: SetupConnectWorkspace's adoption effect reads the
    // coordinator's real registry and re-parameterizes the route with
    // the LIVE session's own key - the connected workspace renders with
    // no second اتصال press and no second openDevice() call.
    const openDeviceCallsBefore = fakeClient.openDevice.mock.calls.length;
    await act(async () => {
      findByTestID(renderer, 'start-configure').props.onPress();
      await flushSchedulerTick();
    });
    await act(async () => {
      await settlePendingScans();
    });

    expect(isOnSetupScreen(renderer)).toBe(true);
    expect(fakeClient.openDevice.mock.calls.length).toBe(openDeviceCallsBefore);
    // Exactly one configurator instance - the adopted one; the embedded
    // connect surface is gone from the tree.
    expect(renderer.root.findAllByProps({testID: 'setup-connect-workspace'})).toHaveLength(0);

    backHandlerSpy.mockRestore();
    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    });
  });
});

describe('App - Pass 7.1 BUGFIX: navigation-not-ready race', () => {
  afterEach(() => {
    navigationReadyControl.holdReady = false;
    navigationReadyControl.heldCallback = null;
  });

  itOwningRenderer(
    "does not permanently drop the redirect when ownership goes INACTIVE before the navigator reports ready - " +
      'it stays pending and completes once onReady fires',
    async () => {
      navigationReadyControl.holdReady = true;
      const sessionId = 'session-app-race-1';
      const renderer = await renderAppConnectedToSetup(sessionId);
      // onReady was captured by the mock, not forwarded - App.tsx's own
      // isNavigationReady state is still false at this point.
      expect(isOnSetupScreen(renderer)).toBe(true);

      await act(async () => {
        mspSessionCoordinator.deactivateMspSession(sessionId);
      });

      /*
       * TWO SEPARATE GUARANTEES, and the wall changed which one acts
       * first.
       *
       * The configuration workspace is registered in the navigator on
       * the connection state alone (App.tsx), so it is gone the instant
       * the session dies - it does NOT wait for the navigator to report
       * ready. This assertion used to require Setup to still be showing
       * here; requiring its absence is the behaviour change.
       *
       * The bug this test exists for is the OTHER half: the pre-fix
       * redirect cleared trackedSessionId unconditionally before
       * checking readiness, permanently blocking its own re-entry guard
       * so the operator was never taken anywhere once the navigator did
       * become ready. The act() below is still what distinguishes a
       * PENDING redirect from a silently dropped one.
       */
      expect(isOnSetupScreen(renderer)).toBe(false);
      expect(renderer.root.findAllByProps({testID: 'main-tabs'}).length).toBe(0);

      // Release the held onReady callback - App.tsx's isNavigationReady
      // flips true, which (being a real dependency of the redirect
      // effect) re-runs it and this time completes the redirect.
      await act(async () => {
        navigationReadyControl.holdReady = false;
        navigationReadyControl.heldCallback?.();
      });

      // The pending redirect completed: the operator is on the
      // connection workspace, not stranded wherever the wall left them.
      expect(isOnSetupScreen(renderer)).toBe(false);
      expect(
        renderer.root.findAllByProps({testID: 'connect-workspace-screen'}).length,
      ).toBeGreaterThan(0);
      const texts = renderer.root
        .findAllByType(Text)
        .map(node => (Array.isArray(node.props.children) ? node.props.children.join('') : node.props.children));
      expect(texts).toContain(i18n.t('connection.instructionPrimary'));
    },
  );
});

describe('App - the firmware path stays fully independent of the connection stack', () => {
  itOwningRenderer('opens the Firmware Flasher DIRECTLY from Start - no connection surface renders and no USB session is opened on the way', async () => {
    // The module-scope fake accumulates calls across this file's tests
    // (established pattern: deltas, not absolute counts).
    const openDeviceCallsBefore = fakeClient.openDevice.mock.calls.length;
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    try {
      await act(async () => {
        renderer = ReactTestRenderer.create(<App />);
      });
      await act(async () => {
        findByTestID(renderer, 'start-firmware').props.onPress();
        await flushSchedulerTick();
      });
      await act(async () => {
        await flushSchedulerTick();
      });
    } finally {
      if (renderer !== undefined) {
        trackedRenderers.push(renderer);
      }
    }

    expect(renderer.root.findAllByProps({testID: 'firmware-flasher-simple-screen'}).length).toBeGreaterThan(0);
    // The flasher owns its own serial/DFU permission flows - nothing of
    // the configurator's connection workspace mounts on this path...
    expect(renderer.root.findAllByProps({testID: 'setup-connect-workspace'})).toHaveLength(0);
    expect(renderer.root.findAllByProps({testID: 'main-tabs'})).toHaveLength(0);
    // ...and no MSP transport session was opened as a side effect.
    expect(fakeClient.openDevice.mock.calls.length).toBe(openDeviceCallsBefore);
  });
});

describe('App - the Setup route does not exist while disconnected', () => {
  itOwningRenderer('an imperative navigate to Setup cannot leave the connection workspace', async () => {
    /*
     * THE DIRECT-URL / DEEP-LINK / RESTORED-STATE CASE, at its root.
     *
     * This used to assert that reaching Setup with no sessionKey
     * rendered the shell hosting the connection workspace. It no longer
     * can: while no flight controller is verified, `Setup` is not
     * registered in the navigator, so there is nothing for a URL, a deep
     * link, a restored navigation state or an imperative navigate to
     * resolve to - and therefore no frame in which a protected screen
     * could flash before a guard noticed.
     *
     * capturedRef is the exact navigationRef App.tsx itself uses, so
     * this is the most direct attack available from inside the app.
     */
    const renderer = await renderApp();

    expect(renderer.root.findAllByProps({testID: 'connect-workspace-screen'}).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({testID: 'main-tabs'}).length).toBe(0);

    await act(async () => {
      navigationReadyControl.capturedRef?.navigate('Setup', undefined);
    });

    // Unmoved, and still crash-free.
    expect(renderer.root.findAllByProps({testID: 'connect-workspace-screen'}).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({testID: 'main-tabs'}).length).toBe(0);
    expect(isOnSetupScreen(renderer)).toBe(false);
  });
});
