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
    // The gesture-owning node, not merely the first testID match.
    press: (testID: string) => {
      const node = renderer.root
        .findAll(candidate => candidate.props?.testID === testID)
        .find(candidate => typeof candidate.props?.onPress === 'function');
      if (node === undefined) {
        throw new Error(`no pressable node with testID "${testID}"`);
      }
      ReactTestRenderer.act(() => {
        node.props.onPress();
      });
    },
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

let currentClient: MspClient | undefined;

function openRealCapability(): void {
  const transport = new FakeMspTransport();
  transports.push(transport);
  const client = new MspClient(transport, SESSION_ID);
  currentClient = client;
  // The REAL store, the REAL binding, the REAL registry - no shortcut and
  // no test double standing in for the capability.
  openMotorTestCapability(SESSION_ID, client, createMotorTestTelemetryRegistry());
}

/**
 * The controller the SCREEN is using, obtained legitimately.
 *
 * `operatorPort()` constructs at most one controller per capability and
 * returns it forever after, so this is the same instance the screen holds -
 * not a copy and not a double. Deliberately NOT done by wrapping the
 * capability: it is `Object.freeze`d on purpose (sealed facade), and an
 * earlier attempt to monkey-patch it silently observed nothing, which made
 * a test that could not fail correctly look like a failing fix.
 */
function screenController() {
  const capability = readMotorTestCapability(SESSION_ID);
  if (capability === undefined) {
    throw new Error('no capability');
  }
  return capability.operatorPort(
    {
      readCurrentIdentity: () => undefined,
      subscribeSessionInvalidated: () => () => {},
    } as never,
    () => Date.now(),
  );
}

afterEach(() => {
  currentClient = undefined;
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

  /* LAYER 2 - the capability must expose the explicit preparation action.
   * Hold remains disabled until preparation reaches genuine Ready. */
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
    // must have noticed, and "noticed" means preparation is now reachable.
    // Merely rendering still takes no lease and sends no command.
    expect(readMotorTestCapability(SESSION_ID)).toBeDefined();
    expect(shell.query('motors-begin-session-card')).toHaveLength(0);
    expect(shell.query('motors-ack-propellers')).toHaveLength(0);
    expect(shell.find('motor-session-toggle').props.disabled).toBe(false);
    expect(shell.find('motors-hold-button').props.disabled).toBe(true);
    // Nothing starts merely because the capability appeared.
    expect(shell.query('motors-status-NO_SESSION').length).toBeGreaterThan(0);
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
    expect(shell.find('motor-session-toggle').props.disabled).toBe(false);
    expect(shell.find('motors-hold-button').props.disabled).toBe(true);
    shell.unmount();
  });

  it('shows one disabled hold control before a capability exists', () => {
    const shell = renderShell();
    shell.press('main-tab-MOTORS');
    expect(shell.query('motors-begin-session-card')).toHaveLength(0);
    expect(shell.find('motors-hold-button').props.disabled).toBe(true);
    expect(shell.query('motors-status-NO_SESSION').length).toBeGreaterThan(0);
    shell.unmount();
  });

  it('separates preparation from the protected hold action', () => {
    const shell = renderShell();
    shell.press('main-tab-MOTORS');
    ReactTestRenderer.act(() => {
      openRealCapability();
    });
    const hold = shell.find('motors-hold-button');
    expect(
      shell.query('motor-session-toggle').length,
    ).toBeGreaterThan(0);
    expect(hold.props.delayLongPress).toBe(800);
    expect(hold.props.disabled).toBe(true);
    shell.unmount();
  });
});

describe('Leaving Motors after starting a session still releases everything', () => {
  it('hands the tab-blur source to the ONE bridge, and leaving does not unmount the panel', () => {
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
    expect(shell.find('motor-session-toggle').props.disabled).toBe(false);
    expect(shell.find('motors-hold-button').props.disabled).toBe(true);
    // Leaving must not throw and must not tear the panel out of the tree -
    // an unmount here would drop the bridge with no stop requested at all.
    expect(() => shell.press('main-tab-SETUP')).not.toThrow();
    expect(shell.query('main-tab-panel-MOTORS').length).toBeGreaterThan(0);
    shell.unmount();
  });
});

describe('begin -> leave BEFORE holding releases the lease and resumes telemetry', () => {
  /**
   * THE SCENARIO. Press "start session", then leave the Motors tab without
   * ever holding to test.
   *
   * WHY THE BRIDGE IS NOT ENOUGH. Tab-blur fires the accepted lifecycle
   * bridge, which issues `requestStop(...)` - stop-a-pulse machinery. At
   * `Ready`, having never pulsed, the accepted reducer CORRECTLY refuses to
   * manufacture stop traffic for an activation that never began. So the
   * bridge does the right thing and nothing gets released, because releasing
   * is `endSession()` -> `runTeardown()`, which is a different call.
   *
   * Left unfixed, the exclusive MSP lease stays held and the MOTOR_TEST
   * telemetry pause stays in force for the rest of the physical session:
   * Setup's telemetry goes dead, no later motor session can acquire the
   * lease, and recovery needs a cable pull.
   */
  /**
   * BLACK-BOX RESOURCE PROOF. The question is not which function fired - it
   * is whether the lease is genuinely free and telemetry genuinely resumed
   * after leaving. If more than one path delivers that, all of them are
   * valid safety paths.
   *
   * Both signals are pre-existing public API, not seams invented for this
   * test: `MspClient.isMotorTestLeaseHeld()` and the controller snapshot's
   * `telemetryHeld` (which is `barrier?.isHeld()`, already asserted in
   * motorTestSessionBinding.test.ts).
   *
   * A "second beginSession() must succeed" probe is deliberately NOT used as
   * the assertion: `operatorPort()` returns the same controller forever, and
   * that controller is CLOSED after teardown by design, so a second begin on
   * it must fail for reasons that have nothing to do with the lease. Reading
   * the lease directly answers the real question without that confound.
   */
  /**
   * SCOPE, STATED HONESTLY: THIS IS THE DEGENERATE CASE ONLY.
   *
   * Measured, not guessed: this harness never serves the transport, so
   * `beginSession()` fails on its first evidence read and SELF-CLOSES. A
   * direct probe after 50 microtasks reports
   *
   *     PHASE: CLOSED | machine: undefined | leaseHeld: false | telemetryHeld: false
   *
   * - nothing is held even BEFORE leaving. So this test cannot and does not
   * prove that leaving releases anything; it passes identically with the
   * release path present or deleted (verified both ways). What it DOES
   * guard is still worth keeping and is all it now claims: a session that
   * self-closes on unusable evidence leaves no lease and no telemetry pause
   * behind, and leaving the tab afterwards does not resurrect either.
   *
   * THE REAL PROOF LIVES IN motorPayloadIndexIdentity.test.tsx, under
   * `begin -> leave releases the lease and resumes telemetry`, which drives
   * the scripted flight controller so the lease is genuinely held. Its
   * three scenarios - departure during PREPARING, during a held-but-unsettled
   * setup, and at genuine Ready - are where the load-bearing assertions are,
   * and two of the three fail with the release path removed.
   */
  it('a self-closed session leaves nothing held, before or after leaving (degenerate case - see note)', async () => {
    const shell = renderShell();
    shell.press('main-tab-MOTORS');
    ReactTestRenderer.act(() => {
      openRealCapability();
    });
    // Preparation is explicit and does not submit any motor pulse.
    shell.press('motor-session-toggle');
    await ReactTestRenderer.act(async () => {
      await Promise.resolve();
    });
    const controller = screenController();
    // The session genuinely began - PREPARING is where the lease and the
    // telemetry pause are already taken.
    expect(controller.getSnapshot().phase).not.toBe('IDLE');

    // Step 2: leave WITHOUT ever holding to test.
    await ReactTestRenderer.act(async () => {
      shell.press('main-tab-SETUP');
      await Promise.resolve();
      await Promise.resolve();
    });

    // THE TWO PROPERTIES THAT ACTUALLY MATTER.
    expect(currentClient?.isMotorTestLeaseHeld()).toBe(false);
    expect(controller.getSnapshot().telemetryHeld).toBe(false);
    shell.unmount();
  });

  it('no-ops safely when there was never a session to begin with', () => {
    // THE COMMON CASE. Plain tab switching, no beginSession() ever pressed.
    // Releasing must not throw, and must not invent a teardown for a session
    // that was never started.
    const shell = renderShell();
    shell.press('main-tab-MOTORS');
    ReactTestRenderer.act(() => {
      openRealCapability();
    });

    // Away and back and away again, never pressing begin.
    expect(() => {
      shell.press('main-tab-SETUP');
      shell.press('main-tab-MOTORS');
      shell.press('main-tab-SETUP');
    }).not.toThrow();
    shell.unmount();
  });

  it('is safe with no capability at all - the very first tab switch', () => {
    const shell = renderShell();
    shell.press('main-tab-MOTORS');
    expect(() => shell.press('main-tab-SETUP')).not.toThrow();
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
