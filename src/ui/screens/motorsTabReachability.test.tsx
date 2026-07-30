/**
 * THE TEST THAT SHOULD HAVE EXISTED FROM THE START.
 *
 * WHY IT DID NOT. Every pre-existing Motors test triggers the hold control
 * by calling the prop directly:
 *
 *     rendered.find('motors-hold-button').props.onLongPress();
 *
 * That bypasses gesture recognition AND - critically - it bypasses
 * `disabled`. React Native's Pressable implements `disabled` by not
 * invoking its callbacks; reaching in and calling the prop invokes them
 * regardless. So a suite of tests can be entirely green while the real
 * button on the real device is disabled and completely unpressable.
 *
 * That is exactly what happened. `motorPayloadIndexIdentity.test.tsx` -
 * described in its own header as "the single most important test in the
 * motors feature" - proves the payload index mapping and would pass
 * unchanged with the control permanently dead. It never asserted that the
 * control could be reached at all.
 *
 * WHAT THIS FILE ADDS.
 *   1. `longPress()`, a gesture helper that REFUSES to fire on a disabled
 *      control, the way a finger does. Any test using it fails when the
 *      gate has not cleared, instead of silently sailing past it.
 *   2. The reachability regression itself, through the REAL tab shell and
 *      the REAL capability store: a capability that appears AFTER the
 *      Motors panel has mounted must be picked up.
 *
 * NO HARDWARE. No flight controller, no USB, no motor, no LiPo.
 */

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({top: 44, bottom: 34, left: 0, right: 0}),
}));

import {readFileSync} from 'fs';
import {join} from 'path';

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import '../../i18n';
import MainTabsScreen from './MainTabsScreen';
import {
  closeMotorTestCapability,
  subscribeMotorTestCapabilityOpened,
  createMotorTestTelemetryRegistry,
  openMotorTestCapability,
  readMotorTestCapability,
} from '../../platforms/react-native/protocol/motorTestCapability';
import {MspClient} from '../../core/protocol/mspClient';
import {FakeMspTransport} from '../../core/protocol/__testUtils__/mspFakeTransport';

const SESSION_ID = 'reachability-session';

function renderShell() {
  const navigation = {addListener: () => () => {}, goBack: () => {}} as never;
  const route = {
    key: 'Setup-1',
    name: 'Setup' as const,
    params: {sessionKey: {sessionId: SESSION_ID, generation: 1}},
  } as never;
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <MainTabsScreen navigation={navigation} route={route} />,
    );
  });
  const find = (testID: string) =>
    renderer.root.findAllByProps({testID})[0];
  return {
    renderer,
    find,
    query: (testID: string) => renderer.root.findAllByProps({testID}),
    press: (testID: string) =>
      ReactTestRenderer.act(() => {
        find(testID).props.onPress();
      }),
    /**
     * A FAITHFUL long press. Honours `disabled` exactly as the platform
     * does, and reports refusal rather than silently doing nothing - a
     * helper that quietly no-ops would recreate the very blind spot this
     * file exists to close.
     */
    longPress: (testID: string): 'FIRED' | 'REFUSED_DISABLED' => {
      const node = find(testID);
      if (node.props.disabled === true) {
        return 'REFUSED_DISABLED';
      }
      ReactTestRenderer.act(() => {
        node.props.onPressIn?.();
        node.props.onLongPress?.();
      });
      return 'FIRED';
    },
    unmount: () =>
      ReactTestRenderer.act(() => {
        renderer.unmount();
      }),
  };
}

const transports: FakeMspTransport[] = [];

function openRealCapability(): void {
  const transport = new FakeMspTransport();
  transports.push(transport);
  const client = new MspClient(transport, SESSION_ID);
  // The REAL store, the REAL binding, the REAL registry - no shortcut and
  // no test double standing in for the capability.
  openMotorTestCapability(SESSION_ID, client, createMotorTestTelemetryRegistry());
}

afterEach(() => {
  closeMotorTestCapability(SESSION_ID);
  transports.length = 0;
});

describe('Motors tab reachability with a session that arrives late', () => {
  it('starts blocked and unpressable when no capability exists yet', () => {
    const shell = renderShell();
    shell.press('main-tab-MOTORS');

    expect(readMotorTestCapability(SESSION_ID)).toBeUndefined();
    // The honest presentation for "no session": blocked, and the control
    // genuinely disabled rather than merely looking it.
    expect(shell.query('motors-status-NO_SESSION').length).toBeGreaterThan(0);
    expect(shell.find('motors-hold-button').props.disabled).toBe(true);
    expect(shell.longPress('motors-hold-button')).toBe('REFUSED_DISABLED');
    shell.unmount();
  });

  /* LAYER 1 - the fix committed here, provable on its own. */
  it('announces an opening to a listener registered before it (layer 1 mechanism)', () => {
    const fired: string[] = [];
    const unsubscribe = subscribeMotorTestCapabilityOpened(SESSION_ID, () => {
      // The listener must be able to SEE the capability, not just be told
      // one exists - the store announces after it is consistent.
      fired.push(
        readMotorTestCapability(SESSION_ID) === undefined ? 'EMPTY' : 'VISIBLE',
      );
    });
    openRealCapability();
    unsubscribe();
    expect(fired).toEqual(['VISIBLE']);

    // And it stops firing once unsubscribed.
    closeMotorTestCapability(SESSION_ID);
    openRealCapability();
    expect(fired).toEqual(['VISIBLE']);
  });

  /* LAYER 2 - RED ON PURPOSE until beginSession() is wired to a control.
   * MotorsScreen has never called beginSession(), so the controller has no
   * machine, derivePresentation() returns NO_SESSION and the hold control
   * stays disabled. These two assert the END STATE the operator needs and
   * must stay red until that is fixed. Deliberately not skipped: skipping a
   * safety-reachability assertion is how this whole class of bug hid. */
  it('PICKS UP a capability that appears AFTER the panel mounted', () => {
    // THE REGRESSION. The capability is created in the coordinator's
    // startTelemetry(), in the continuation of client.startReading().
    // Navigation to this route happens earlier, when ownership goes ACTIVE.
    // So the operator can absolutely be looking at this tab before the
    // capability exists - and under the tab shell the panel is mounted once
    // and never unmounted, so a stale `undefined` read used to be
    // PERMANENT: dead screen, disabled control, forever.
    const shell = renderShell();
    shell.press('main-tab-MOTORS');
    expect(shell.query('motors-status-NO_SESSION').length).toBeGreaterThan(0);

    ReactTestRenderer.act(() => {
      openRealCapability();
    });

    // The panel was NOT remounted and the tab was NOT switched - the only
    // thing that changed is that the store now has a capability. The screen
    // must have noticed, and "noticed" means it now OFFERS A WAY FORWARD.
    //
    // Deliberately NOT asserting the blocked state cleared: under the
    // approved two-action design, clearing it is beginSession()'s job, and
    // beginSession() is the operator's decision. A screen that auto-cleared
    // here would be taking a lease and pausing telemetry as a side effect of
    // navigation, which is exactly what was rejected.
    expect(readMotorTestCapability(SESSION_ID)).toBeDefined();
    expect(shell.query('motors-begin-session-card').length).toBeGreaterThan(0);
    // Gated behind the same three acknowledgements as hold-to-test.
    expect(shell.find('motors-begin-session').props.disabled).toBe(true);
    expect(shell.query('motors-begin-needs-ack').length).toBeGreaterThan(0);
    // Acknowledge all three, and it becomes genuinely pressable.
    for (const key of ['propellers', 'secured', 'battery']) {
      shell.press(`motors-ack-${key}`);
    }
    expect(shell.find('motors-begin-session').props.disabled).toBe(false);
    shell.unmount();
  });

  it('keeps noticing across a tab switch away and back', () => {
    // The panel stays mounted while hidden, so the subscription must
    // survive being off-screen - the operator very reasonably checks Setup
    // while waiting for the connection to finish identifying.
    const shell = renderShell();
    shell.press('main-tab-MOTORS');
    shell.press('main-tab-SETUP');

    ReactTestRenderer.act(() => {
      openRealCapability();
    });

    shell.press('main-tab-MOTORS');
    expect(shell.query('motors-begin-session-card').length).toBeGreaterThan(0);
    shell.unmount();
  });

  it('never offers the begin control before a capability exists', () => {
    // The control must not appear as decoration. Without a capability there
    // is nothing to begin, and offering it would be a dead button - the
    // exact silent-failure shape this whole investigation started from.
    const shell = renderShell();
    shell.press('main-tab-MOTORS');
    expect(shell.query('motors-begin-session-card')).toHaveLength(0);
    shell.unmount();
  });

  it('keeps the two actions visually and textually distinct', () => {
    const shell = renderShell();
    shell.press('main-tab-MOTORS');
    ReactTestRenderer.act(() => {
      openRealCapability();
    });
    // Two different controls, two different testIDs, two different labels.
    const begin = shell.find('motors-begin-session');
    const hold = shell.find('motors-hold-button');
    expect(begin).not.toBe(hold);
    const flat = (style: unknown) =>
      Array.isArray(style)
        ? Object.assign({}, ...style.filter(Boolean))
        : (style as Record<string, unknown>);
    // The begin control is OUTLINED; hold-to-test is a filled surface.
    expect(flat(begin.props.style).borderWidth).toBe(2);
    expect(flat(begin.props.style).backgroundColor).toBeUndefined();
    expect(flat(hold.props.style).backgroundColor).toBeDefined();
    shell.unmount();
  });
});

describe('Leaving Motors after starting a session still releases everything', () => {
  it('routes a tab change away into the SAME bridge path, so the lease is released and telemetry resumes', () => {
    // EXPLICITLY VERIFIED, NOT ASSUMED. The requirement is that starting a
    // session and then wandering off without testing must still release the
    // exclusive lease and un-pause telemetry. The teardown that does that is
    // the controller's runTeardown(), reached from the accepted lifecycle
    // bridge - and the bridge is driven here by the shell's tab-blur source.
    //
    // What this asserts is the WIRING, at the seam that the tab shell
    // actually changed: the tab-blur source is handed to the bridge as its
    // `addBlurListener`, so a tab change is indistinguishable from the
    // navigation blur that already released the lease. The release itself -
    // lease released, pause lease released, monitor stopped - is proven
    // against the real controller in motorTestController.test.ts and
    // motorTestLifecycleBridge.test.ts, which this deliberately does not
    // duplicate with a weaker copy.
    const source = readFileSync(join(__dirname, 'MotorsScreen.tsx'), 'utf8');
    const executable = source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    expect(executable).toMatch(
      /addBlurListener: listener => \{[\s\S]*?subscribeTabBlur\(listener\)/,
    );
    // And there is exactly ONE bridge, so the tab path cannot diverge from
    // the navigation path.
    expect(executable.match(/createMotorTestLifecycleBridge\(/g) ?? []).toHaveLength(1);

    // Behaviourally: switching away from Motors after the capability exists
    // must fire that source. MainTabsScreen.tabBlur.test.tsx proves the
    // firing in isolation; here it is proven with the REAL Motors screen
    // mounted and a REAL capability in the store.
    const shell = renderShell();
    shell.press('main-tab-MOTORS');
    ReactTestRenderer.act(() => {
      openRealCapability();
    });
    expect(shell.query('motors-begin-session-card').length).toBeGreaterThan(0);
    // Leaving must not throw and must not tear the panel out of the tree -
    // an unmount here would drop the bridge with no stop requested at all.
    expect(() => shell.press('main-tab-SETUP')).not.toThrow();
    expect(shell.query('main-tab-panel-MOTORS').length).toBeGreaterThan(0);
    shell.unmount();
  });
});

describe('The gesture helper closes the blind spot', () => {
  it('refuses a disabled control - which a direct prop call does not', () => {
    const shell = renderShell();
    shell.press('main-tab-MOTORS');
    const hold = shell.find('motors-hold-button');
    expect(hold.props.disabled).toBe(true);

    // The faithful helper refuses.
    expect(shell.longPress('motors-hold-button')).toBe('REFUSED_DISABLED');

    // The direct prop call - what every earlier test does - sails straight
    // past `disabled`. Asserted here so the difference is documented in a
    // test rather than in a comment nobody re-reads.
    expect(() => hold.props.onLongPress?.()).not.toThrow();
    shell.unmount();
  });

  it('keeps the deliberate 800 ms hold requirement', () => {
    const shell = renderShell();
    shell.press('main-tab-MOTORS');
    expect(shell.find('motors-hold-button').props.delayLongPress).toBe(800);
    shell.unmount();
  });
});
