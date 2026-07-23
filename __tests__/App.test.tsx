/**
 * @format
 */

jest.mock('../src/platforms/react-native/transport/native/NativeUsbSerialTransport');

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

afterEach(() => {
  act(() => {
    for (const renderer of trackedRenderers.splice(0, trackedRenderers.length)) {
      try {
        renderer.unmount();
      } catch {
        // Best-effort - see UsbConnectionScreen.test.tsx's own identical
        // afterEach() comment.
      }
    }
  });
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

// Only ever used here for setup-screen-session-key, a plain <Text> - but
// findAllByProps({testID}) also matches an internal react-native-screens
// wrapper that forwards the same testID prop through undisturbed (a
// distinct artifact from the Pressable-vs-host-node duplication
// findByTestID() above already accounts for). Filtering to the real Text
// element is what actually disambiguates it.
function queryByTestID(renderer: ReactTestRenderer.ReactTestRenderer, testID: string) {
  return renderer.root.findAllByProps({testID}).filter(node => node.type === Text);
}

async function pressConnect(renderer: ReactTestRenderer.ReactTestRenderer) {
  await act(async () => {
    await findByTestID(renderer, 'usb-connect-button').props.onPress();
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

/** Mounts App and lets its first scheduler-queued passive effects settle
 * (see flushSchedulerTick's own doc comment) - the shared foundation both
 * renderAppConnectedToSetup() and the malformed-params guard test below
 * build on. */
async function renderApp() {
  const App = require('../App').default;
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = ReactTestRenderer.create(<App />);
  });
  trackedRenderers.push(renderer);
  await act(async () => {
    await flushSchedulerTick();
    await flushSchedulerTick();
  });
  return renderer;
}

/** Mounts App, lets the safe auto-select policy pick the sole supported
 * device, and presses اتصال - landing on the Setup screen exactly the way
 * a real user reaching it would, via UsbConnectionScreen's own
 * navigation.navigate('Setup', {sessionKey}) call (Pass 7.1). Returns the
 * sessionId the fake client resolved openDevice() with. */
async function renderAppConnectedToSetup(sessionId: string) {
  fakeClient.listDevices.mockResolvedValueOnce([supportedDevice()]);
  fakeClient.openDevice.mockResolvedValueOnce(sessionId);

  const renderer = await renderApp();
  await pressConnect(renderer);

  expect(queryByTestID(renderer, 'setup-screen-session-key')).toHaveLength(1);
  return renderer;
}

test('renders the USB connection screen and forces RTL', async () => {
  const allowRTLSpy = jest.spyOn(I18nManager, 'allowRTL');
  const forceRTLSpy = jest.spyOn(I18nManager, 'forceRTL');

  const App = require('../App').default;

  let renderer: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(<App />);
  });
  trackedRenderers.push(renderer!);

  const texts = renderer!.root
    .findAllByType(Text)
    .map(node => (Array.isArray(node.props.children) ? node.props.children.join('') : node.props.children));

  expect(texts).toContain(i18n.t('app.name'));
  expect(texts).toContain(i18n.t('connection.instructionPrimary'));
  expect(allowRTLSpy).toHaveBeenCalledWith(true);
  expect(forceRTLSpy).toHaveBeenCalledWith(true);
});

describe('App - Pass 7.1 navigation foundation', () => {
  it('navigates Connection -> Setup on a successful connect, reaching the real SetupScreen with the coordinator\'s own session key', async () => {
    const renderer = await renderAppConnectedToSetup('session-app-nav-1');

    const sessionKeyText = queryByTestID(renderer, 'setup-screen-session-key')[0].props.children;
    const expectedKey = mspSessionCoordinator.getSessionKey('session-app-nav-1');
    expect(expectedKey).toBeDefined();
    expect(sessionKeyText).toBe(`${expectedKey!.sessionId}:${expectedKey!.generation}`);
  });

  it("the root redirect listener resets the stack to 'Connection' once the tracked session's ownership goes INACTIVE while 'Setup' has focus", async () => {
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

    expect(queryByTestID(renderer, 'setup-screen-session-key')).toHaveLength(0);
    const texts = renderer.root
      .findAllByType(Text)
      .map(node => (Array.isArray(node.props.children) ? node.props.children.join('') : node.props.children));
    expect(texts).toContain(i18n.t('connection.instructionPrimary'));
  });

  it('Android hardware Back from Setup returns to Connection WITHOUT deactivating the still-active MSP session', async () => {
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

    expect(queryByTestID(renderer, 'setup-screen-session-key')).toHaveLength(0);
    expect(deactivateSpy).not.toHaveBeenCalled();
    expect(mspSessionCoordinator.getOwnershipState(sessionId)).toBe('ACTIVE');

    deactivateSpy.mockRestore();
  });
});

describe('App - Pass 7.1 BUGFIX: navigation-not-ready race', () => {
  afterEach(() => {
    navigationReadyControl.holdReady = false;
    navigationReadyControl.heldCallback = null;
  });

  it(
    "does not permanently drop the redirect when ownership goes INACTIVE before the navigator reports ready - " +
      'it stays pending and completes once onReady fires',
    async () => {
      navigationReadyControl.holdReady = true;
      const sessionId = 'session-app-race-1';
      const renderer = await renderAppConnectedToSetup(sessionId);
      // onReady was captured by the mock, not forwarded - App.tsx's own
      // isNavigationReady state is still false at this point.
      expect(queryByTestID(renderer, 'setup-screen-session-key')).toHaveLength(1);

      await act(async () => {
        mspSessionCoordinator.deactivateMspSession(sessionId);
      });

      // THE BUG this test guards against: the pre-fix code cleared
      // trackedSessionId unconditionally here (before checking
      // readiness), permanently blocking its own re-entry guard from
      // ever letting this effect complete the redirect once ready - Setup
      // would incorrectly keep showing forever. With the fix, Setup is
      // ALSO still showing right here, but only because the redirect is
      // genuinely PENDING (trackedSessionId deliberately left set), not
      // because it was silently dropped - the next act() below is what
      // actually distinguishes the two.
      expect(queryByTestID(renderer, 'setup-screen-session-key')).toHaveLength(1);

      // Release the held onReady callback - App.tsx's isNavigationReady
      // flips true, which (being a real dependency of the redirect
      // effect) re-runs it and this time completes the redirect.
      await act(async () => {
        navigationReadyControl.holdReady = false;
        navigationReadyControl.heldCallback?.();
      });

      expect(queryByTestID(renderer, 'setup-screen-session-key')).toHaveLength(0);
      const texts = renderer.root
        .findAllByType(Text)
        .map(node => (Array.isArray(node.props.children) ? node.props.children.join('') : node.props.children));
      expect(texts).toContain(i18n.t('connection.instructionPrimary'));
    },
  );
});

describe('App - Pass 7.1 defensive guard: malformed Setup route params', () => {
  it('does not throw and falls back gracefully when the Setup route is reached without sessionKey params', async () => {
    const renderer = await renderApp();

    await act(async () => {
      // Bypasses the real, type-checked call site (UsbConnectionScreen.tsx
      // always supplies sessionKey) to simulate what a future call site
      // (e.g. a linking config, per App.tsx's own guard comment) could
      // reach without it - exactly the scenario both App.tsx's
      // handleNavigationStateChange guard and SetupScreen.tsx's own guard
      // exist for. capturedRef is the SAME navigationRef object App.tsx
      // itself uses (see the @react-navigation/native mock above).
      navigationReadyControl.capturedRef?.navigate('Setup', undefined);
    });

    // SetupScreen's own guard: an honest fallback, not a crash.
    expect(queryByTestID(renderer, 'setup-screen-missing-session')).toHaveLength(1);
    expect(queryByTestID(renderer, 'setup-screen-session-key')).toHaveLength(0);
  });
});
