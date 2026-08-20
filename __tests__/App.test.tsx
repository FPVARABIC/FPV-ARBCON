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
 * REACHING THE WORKSPACE, the way an operator now does.
 *
 * There is no connection page and no «اتصال» button on a page. Pressing
 * the configuration door on HOME performs the whole connection - scan,
 * open, MSP activation - and the wall then registers the workspace and
 * the app moves there. This helper presses that door and lets the chain
 * settle.
 *
 * The fake client here reports no device picker, which is the Android
 * posture: no chooser, the system permission dialog is raised inside
 * open(), and the scan runs directly.
 */
async function pressConfigurationDoor(
  renderer: ReactTestRenderer.ReactTestRenderer,
) {
  await act(async () => {
    findByTestID(renderer, 'start-configure').props.onPress();
    await flushSchedulerTick();
  });
  await act(async () => {
    await settlePendingScans();
  });
}

// RE-INVESTIGATED for the navigation-not-ready race fix: this is NOT the
// linking/getInitialURL() race the original comment here assumed - linking
// is never configured on NavigationContainer in App.tsx, so
// NavigationContainerInner's own isLinkingEnabled is false and
// isLinkingReady is therefore already true on the very first render,
// unconditionally - there is no getInitialURL() race to wait out here.
//
// The actual, confirmed cause: React's own `scheduler` package (used
// internally by react-native-screens/native-stack for the initial mount)
// schedules its passive-effect flush via MessageChannel, falling back to
// setTimeout(fn, 0). That is a real macrotask, not a microtask chain, so
// no amount of `await Promise.resolve()` hops (tried first; confirmed
// insufficient) can flush it inside act() - only yielding a REAL
// event-loop tick can. This is therefore not a time-based race with a
// duration to pad for margin - it is "has at least one such scheduler
// tick run yet", which setTimeout(fn, 0) answers deterministically.
function flushSchedulerTick(): Promise<void> {
  return new Promise<void>(resolve => setTimeout(() => resolve(), 0));
}

/**
 * The connection service dispatches its state only after
 * client.listDevices() resolves. Awaiting THAT promise - the very one
 * the service itself awaited, read back off the jest.fn's recorded
 * results - is an observable readiness condition, not a guess about
 * elapsed time, and it keeps every resulting update inside the caller's
 * own act() scope.
 */
async function settlePendingScans(): Promise<void> {
  // One real scheduler tick so React's passive effects actually run.
  await flushSchedulerTick();
  await Promise.all(
    fakeClient.listDevices.mock.results
      .filter(result => result.type === 'return')
      .map(result => Promise.resolve(result.value).then(undefined, () => undefined)),
  );
  // And one more tick for the dispatch that follows a resolved scan and
  // anything React schedules off it.
  await flushSchedulerTick();
}

/** Mounts App and lets its first scheduler-queued passive effects settle
 * inside an awaited act() - the shared foundation every test builds on.
 * NOTHING is pressed: a cold start is Home and only Home. */
function renderApp(): Promise<ReactTestRenderer.ReactTestRenderer> {
  return ownRendererOperation(async () => {
    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = ReactTestRenderer.create(<App />);
      });
      await act(async () => {
        await flushSchedulerTick();
      });
    } finally {
      if (renderer !== undefined) {
        trackedRenderers.push(renderer);
      }
    }
    return renderer as ReactTestRenderer.ReactTestRenderer;
  });
}

/** Mounts App and connects the way a real operator does: one press on
 * Home's configuration door, no page in between. */
function renderAppConnectedToSetup(sessionId: string) {
  return ownRendererOperation(async () => {
    fakeClient.listDevices.mockResolvedValue([supportedDevice()]);
    fakeClient.openDevice.mockResolvedValueOnce(sessionId);

    const renderer = await renderApp();
    await pressConfigurationDoor(renderer);

    expect(isOnSetupScreen(renderer)).toBe(true);
    return renderer;
  });
}

/** Every <Text> currently rendered, joined children included. */
function allText(renderer: ReactTestRenderer.ReactTestRenderer): unknown[] {
  return renderer.root
    .findAllByType(Text)
    .map(node => (Array.isArray(node.props.children) ? node.props.children.join('') : node.props.children));
}

testOwningRenderer('a cold start is HOME and only Home - no configuration UI exists, and RTL is forced', async () => {
  const renderer = await renderApp();

  /*
   * THE HARD WALL, PLUS THE PAGE THAT IS NO LONGER BEHIND IT.
   *
   * This test has been rewritten twice, and the direction is the point.
   * It first asserted that the door opened the tab shell, which hosted a
   * connection workspace inside its Setup tab - putting rail, tab bar
   * and fifteen destinations in front of an operator with nothing
   * plugged in. It then asserted a dedicated connection route instead,
   * which was the same mistake with a smaller surface: still a place the
   * application could leave somebody.
   *
   * Now there is nothing to assert the presence of. A disconnected
   * operator is on Home; connecting is something Home DOES.
   */
  expect(renderer.root.findAllByProps({testID: 'start-screen'}).length).toBeGreaterThan(0);
  expect(renderer.root.findAllByProps({testID: 'main-tabs'}).length).toBe(0);
  expect(isOnSetupScreen(renderer)).toBe(false);
  // The spies were installed above the module-scope load of ../App, so
  // these still assert on App.tsx's own one-time module-scope RTL forcing.
  expect(allowRTLSpy).toHaveBeenCalledWith(true);
  expect(forceRTLSpy).toHaveBeenCalledWith(true);
});

describe('App - Pass 7.7B: coverage lifecycle', () => {
  itOwningRenderer('completes the connection press INSIDE act(), with no act() warning', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      fakeClient.listDevices.mockResolvedValue([supportedDevice()]);
      fakeClient.openDevice.mockResolvedValueOnce('session-lifecycle-1');
      const renderer = await renderApp();
      await pressConfigurationDoor(renderer);

      const actWarnings = errorSpy.mock.calls
        .map(call => String(call[0]))
        .filter(message => message.includes('was not wrapped in act'));
      expect(actWarnings).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('teardown waits for the COMPLETE renderer-owning operation, not just its render', async () => {
    fakeClient.listDevices.mockResolvedValue([supportedDevice()]);
    fakeClient.openDevice.mockResolvedValueOnce('session-teardown-1');

    let seenAfterTeardownRequest: string[] = [];
    const operation = ownRendererOperation(async () => {
      const renderer = await renderApp();
      await pressConfigurationDoor(renderer);
      // Reading the tree AFTER teardown was asked to run is the whole
      // point: ownership must have held it alive.
      seenAfterTeardownRequest = allText(renderer).map(String);
      return renderer;
    });

    const teardown = teardownRenderers();
    await operation;
    await teardown;

    expect(seenAfterTeardownRequest.length).toBeGreaterThan(0);
  });

  it('teardown settles an un-awaited render continuation before it unmounts anything', async () => {
    fakeClient.listDevices.mockResolvedValue([supportedDevice()]);
    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
    // Deliberately NOT awaited here - teardown must wait for it anyway.
    const pending = ownRendererOperation(async () => {
      renderer = await renderApp();
      return renderer;
    });

    await teardownRenderers();
    await pending;

    expect(renderer).toBeDefined();
    // Teardown ran to completion without touching a half-built tree.
    expect((renderer as ReactTestRenderer.ReactTestRenderer).toJSON()).toBeNull();
  });
});

describe('App - the flow: Home -> connection -> workspace', () => {
  itOwningRenderer('one press on Home connects and lands on the workspace, with no route in between', async () => {
    fakeClient.listDevices.mockResolvedValue([supportedDevice()]);
    fakeClient.openDevice.mockResolvedValueOnce('session-flow-1');
    // The fake client is module-scope and accumulates calls across this
    // file's tests: deltas, not absolute counts.
    const openDeviceCallsBefore = fakeClient.openDevice.mock.calls.length;

    const renderer = await renderApp();
    const routesSeen: string[] = [];
    const navigator = navigationReadyControl.capturedRef as unknown as {
      getCurrentRoute?: () => {name: string} | undefined;
    } | null;
    routesSeen.push(navigator?.getCurrentRoute?.()?.name ?? 'Start');

    await pressConfigurationDoor(renderer);
    routesSeen.push(navigator?.getCurrentRoute?.()?.name ?? '?');

    expect(isOnSetupScreen(renderer)).toBe(true);
    // Start, then Setup. Nothing between them.
    expect(routesSeen).toEqual(['Start', 'Setup']);
    expect(fakeClient.openDevice.mock.calls.length).toBe(openDeviceCallsBefore + 1);
  });

  itOwningRenderer("losing the tracked session resets the stack to HOME - not to a connection page, and not to Motors with a message", async () => {
    const sessionId = 'session-loss-1';
    const renderer = await renderAppConnectedToSetup(sessionId);

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
      await flushSchedulerTick();
    });

    expect(isOnSetupScreen(renderer)).toBe(false);
    expect(renderer.root.findAllByProps({testID: 'main-tabs'}).length).toBe(0);
    expect(renderer.root.findAllByProps({testID: 'start-screen'}).length).toBeGreaterThan(0);
    // And Home says why the operator is there.
    expect(allText(renderer).map(String)).toContain(
      i18n.t('directConnect.sessionLost'),
    );
  });

  itOwningRenderer('Android hardware Back from the workspace returns HOME WITHOUT deactivating the still-active MSP session', async () => {
    const sessionId = 'session-back-1';
    // Installed BEFORE the mount that registers the handler: a spy only
    // records calls made after it is in place.
    const backHandlerSpy = jest.spyOn(BackHandler, 'addEventListener');
    const renderer = await renderAppConnectedToSetup(sessionId);

    const deactivateSpy = jest.spyOn(mspSessionCoordinator, 'deactivateMspSession');
    const hardwareBackCall = backHandlerSpy.mock.calls.find(([eventName]) => eventName === 'hardwareBackPress');
    const hardwareBackHandler = hardwareBackCall![1] as () => boolean;
    await act(async () => {
      hardwareBackHandler();
      await flushSchedulerTick();
    });

    expect(renderer.root.findAllByProps({testID: 'start-route-group'}).length).toBeGreaterThan(0);
    expect(deactivateSpy).not.toHaveBeenCalled();
    expect(mspSessionCoordinator.getOwnershipState(sessionId)).toBe('ACTIVE');

    deactivateSpy.mockRestore();
    backHandlerSpy.mockRestore();
    // The whole point of this test is that the session stays ACTIVE - but
    // it must not stay ACTIVE past the test's own end, or its real
    // telemetry tick-driver setInterval leaks.
    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    });
  });

  itOwningRenderer('re-entering ADOPTS a still-active session instead of opening a second port', async () => {
    const sessionId = 'session-adopt-1';
    const backHandlerSpy = jest.spyOn(BackHandler, 'addEventListener');
    const renderer = await renderAppConnectedToSetup(sessionId);

    const hardwareBackCall = backHandlerSpy.mock.calls.find(([eventName]) => eventName === 'hardwareBackPress');
    const hardwareBackHandler = hardwareBackCall![1] as () => boolean;
    await act(async () => {
      hardwareBackHandler();
      await flushSchedulerTick();
    });
    expect(mspSessionCoordinator.getOwnershipState(sessionId)).toBe('ACTIVE');

    const openDeviceCallsBefore = fakeClient.openDevice.mock.calls.length;
    await pressConfigurationDoor(renderer);

    expect(isOnSetupScreen(renderer)).toBe(true);
    expect(fakeClient.openDevice.mock.calls.length).toBe(openDeviceCallsBefore);

    backHandlerSpy.mockRestore();
    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
    });
  });
});

describe('App - cancelling and failing never move the operator', () => {
  itOwningRenderer('an empty bench leaves the operator on Home with one short message', async () => {
    fakeClient.listDevices.mockResolvedValue([]);
    const openDeviceCallsBefore = fakeClient.openDevice.mock.calls.length;
    const renderer = await renderApp();
    await pressConfigurationDoor(renderer);

    expect(fakeClient.openDevice.mock.calls.length).toBe(openDeviceCallsBefore);
    expect(isOnSetupScreen(renderer)).toBe(false);
    expect(renderer.root.findAllByProps({testID: 'start-screen'}).length).toBeGreaterThan(0);
    expect(allText(renderer).map(String)).toContain(i18n.t('directConnect.noBoard'));
  });

  /**
   * IDENTIFICATION FAILURE IS A CONNECTION PROBLEM, and it must end.
   *
   * The link comes up, the board is asked what it is, and it cannot be
   * read. Without an ending here the card spins forever - the exact
   * "spinner that never stops" this flow forbids - and the operator is
   * left with no way to tell a slow board from a dead one.
   */
  itOwningRenderer('a board that cannot be identified never opens the workspace, and says so on Home', async () => {
    (mspSessionCoordinator.getIdentificationState as jest.Mock).mockImplementation(
      () => ({status: 'FAILED', error: new Error('unreadable')}) as never,
    );
    fakeClient.listDevices.mockResolvedValue([supportedDevice()]);
    fakeClient.openDevice.mockResolvedValueOnce('session-identify-fail');

    const renderer = await renderApp();
    await pressConfigurationDoor(renderer);

    expect(isOnSetupScreen(renderer)).toBe(false);
    expect(renderer.root.findAllByProps({testID: 'main-tabs'}).length).toBe(0);
    expect(renderer.root.findAllByProps({testID: 'start-screen'}).length).toBeGreaterThan(0);
    expect(allText(renderer).map(String)).toContain(
      i18n.t('directConnect.identifyFailed'),
    );

    await act(async () => {
      for (const sessionId of mspSessionCoordinator.listSessionIds()) {
        mspSessionCoordinator.deactivateMspSession(sessionId);
      }
    });
  });

  /**
   * BACK AND FORWARD CANNOT RESURRECT A CONNECTION SCREEN, because the
   * stack the redirect leaves behind has nothing in it but Home. A
   * history entry for a connection page is exactly what a route-based
   * connection surface would have created.
   */
  itOwningRenderer('going Back after a lost session finds Home, not a stale connection surface', async () => {
    const sessionId = 'session-history-1';
    const renderer = await renderAppConnectedToSetup(sessionId);

    await act(async () => {
      mspSessionCoordinator.deactivateMspSession(sessionId);
      await flushSchedulerTick();
    });

    const navigator = navigationReadyControl.capturedRef as unknown as {
      canGoBack?: () => boolean;
    } | null;
    // The reset left a single-entry stack: there is nowhere to go back to.
    expect(navigator?.canGoBack?.() ?? false).toBe(false);
    expect(renderer.root.findAllByProps({testID: 'start-screen'}).length).toBeGreaterThan(0);
    expect(isOnSetupScreen(renderer)).toBe(false);
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
      const sessionId = 'session-race-1';
      const renderer = await renderAppConnectedToSetup(sessionId);
      // onReady was captured by the mock, not forwarded - the redirect's
      // own isNavigationReady state is still false at this point.
      expect(isOnSetupScreen(renderer)).toBe(true);

      await act(async () => {
        mspSessionCoordinator.deactivateMspSession(sessionId);
        await flushSchedulerTick();
      });

      /*
       * TWO SEPARATE GUARANTEES, and the wall acts first.
       *
       * The workspace is registered on the connection state alone, so it
       * is gone the instant the session dies - it does NOT wait for the
       * navigator to report ready.
       *
       * The bug this test exists for is the OTHER half: the redirect
       * must not silently drop itself while the navigator is not ready.
       * It survived a not-ready navigator by keeping its tracked session
       * id - and then the wall removed the route, react-navigation
       * landed on Start, and onStateChange cleared that id before
       * onReady ever fired. The detected loss is now its own state, so
       * nothing that happens to the navigation state can erase it.
       */
      expect(isOnSetupScreen(renderer)).toBe(false);
      expect(renderer.root.findAllByProps({testID: 'main-tabs'}).length).toBe(0);

      await act(async () => {
        navigationReadyControl.holdReady = false;
        navigationReadyControl.heldCallback?.();
        await flushSchedulerTick();
      });

      // The pending return completed: Home, and Home saying why.
      expect(renderer.root.findAllByProps({testID: 'start-screen'}).length).toBeGreaterThan(0);
      expect(allText(renderer).map(String)).toContain(
        i18n.t('directConnect.sessionLost'),
      );
    },
  );
});

describe('App - the firmware path stays fully independent of the connection stack', () => {
  itOwningRenderer('opens the Firmware Flasher DIRECTLY from Home - no connection surface renders and no USB session is opened on the way', async () => {
    const openDeviceCallsBefore = fakeClient.openDevice.mock.calls.length;
    const renderer = await renderApp();

    await act(async () => {
      findByTestID(renderer, 'start-firmware').props.onPress();
      await flushSchedulerTick();
    });

    expect(fakeClient.openDevice.mock.calls.length).toBe(openDeviceCallsBefore);
    expect(renderer.root.findAllByProps({testID: 'main-tabs'}).length).toBe(0);
    expect(isOnSetupScreen(renderer)).toBe(false);
  });
});

describe('App - the Setup route does not exist while disconnected', () => {
  itOwningRenderer('an imperative navigate to Setup cannot leave Home', async () => {
    const renderer = await renderApp();
    expect(renderer.root.findAllByProps({testID: 'start-screen'}).length).toBeGreaterThan(0);

    /*
     * The strongest available stand-in for a typed URL, a bookmark or a
     * restored history entry: the navigator's own ref, asked directly
     * for the protected route. react-navigation warns and does nothing,
     * because there is no such screen registered to go to.
     */
    const warnSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await act(async () => {
      navigationReadyControl.capturedRef?.navigate('Setup', undefined);
      await flushSchedulerTick();
    });
    warnSpy.mockRestore();

    expect(isOnSetupScreen(renderer)).toBe(false);
    expect(renderer.root.findAllByProps({testID: 'main-tabs'}).length).toBe(0);
    expect(renderer.root.findAllByProps({testID: 'start-screen'}).length).toBeGreaterThan(0);
  });
});
