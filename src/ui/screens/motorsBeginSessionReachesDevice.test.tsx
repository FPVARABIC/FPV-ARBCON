/**
 * THE STEP-1 CONTROL MUST ACTUALLY BE THERE, ON THE REAL WIRING.
 *
 * WHY THIS FILE EXISTS. Three screenshots from a real device, running the
 * release APK built by run 30532042454, show the acknowledgement checklist
 * fully ticked and then, immediately below it, the blocked "no active
 * session" status - with NO begin-session control anywhere in the flow. The
 * installed bundle demonstrably contains the string
 * `motorsScreen.beginSession`, so the code shipped; it simply never
 * rendered.
 *
 * WHY THE EXISTING TESTS ALL PASSED ANYWAY - the honest reason. Every test
 * that renders the Motors tab and finds the control first calls
 * `openMotorTestCapability()` by hand, and
 * motorPayloadIndexIdentity.test.tsx additionally replaces
 * `mspSessionCoordinator` with a two-method stub. So they prove the SCREEN
 * renders the control when a capability exists, and prove nothing at all
 * about whether the real coordinator ever puts one there under the key the
 * screen looks it up by. That gap is exactly the shape of this defect, and
 * it is the gap this file closes.
 *
 * WHAT IS REAL HERE. The real `mspSessionCoordinator` singleton - the same
 * instance UsbConnectionScreen calls - the real `openSession()`, the real
 * RNMspTransport/MspClient construction, the real capability store, and the
 * real `MotorsTab` reached through `getSessionKey()` exactly as
 * MainTabsScreen reaches it. The only fake is the native USB client, which
 * cannot exist under Jest.
 *
 * NO HARDWARE. No flight controller, no USB, no motor, no battery. Nothing
 * here authorises or simulates a physical motor test: the session never
 * reaches Ready, because no identification response is ever scripted.
 */

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({top: 44, bottom: 34, left: 0, right: 0}),
}));

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import '../../i18n';
import MotorsTab from './MotorsScreen';
import {mspSessionCoordinator} from '../../platforms/react-native/protocol';
import {readMotorTestCapability} from '../../platforms/react-native/protocol/motorTestCapability';
import type {UsbSerialTransportClient} from '../../platforms/react-native/transport/UsbSerialTransportClient';

const SESSION_ID = 'device-session-1';

const flush = async (turns = 6): Promise<void> => {
  for (let index = 0; index < turns; index++) {
    await Promise.resolve();
  }
};

/**
 * The native client, and only the native client.
 *
 * `writeBytes` never settles: identification requests therefore stay
 * in flight forever, which is deliberate. It keeps the session in exactly
 * the state the device screenshots show - connected, ownership active,
 * nothing identified yet - and it means no MSP response is ever fabricated.
 */
function makeNativeClient(): UsbSerialTransportClient {
  return {
    writeBytes: () => new Promise<void>(() => undefined),
    startReading: () => Promise.resolve(undefined),
    stopReading: () => Promise.resolve(undefined),
    onDataReceived: () => ({remove: () => undefined}),
    onSessionDetached: () => ({remove: () => undefined}),
  } as unknown as UsbSerialTransportClient;
}

afterEach(() => {
  // Mandatory, not tidiness: MspSessionCoordinator.test.ts documents a real
  // 40-minute CI hang traced to a session left open by a test, because
  // startTelemetry()'s setInterval outlives it.
  mspSessionCoordinator.deactivateMspSession(SESSION_ID);
});

describe('the real coordinator path makes the Step-1 control reachable', () => {
  it('registers a motor-test capability under the SAME key getSessionKey() hands the UI', async () => {
    const coordinator = mspSessionCoordinator;
    coordinator.openSession(makeNativeClient(), SESSION_ID);
    await flush();

    const sessionKey = coordinator.getSessionKey(SESSION_ID);
    expect(sessionKey).toBeDefined();

    // THE JOIN. The screen looks the capability up by
    // `sessionKey.sessionId`; the coordinator stores it under its own
    // `sessionId`. If those two ever disagree, the lookup returns
    // undefined forever and the Step-1 control can never render - which is
    // precisely the reported symptom.
    expect(
      readMotorTestCapability(sessionKey?.sessionId ?? '<none>'),
    ).toBeDefined();
  });

  it('renders the begin-session control on a freshly opened real session', async () => {
    const coordinator = mspSessionCoordinator;
    coordinator.openSession(makeNativeClient(), SESSION_ID);
    await flush();
    const sessionKey = coordinator.getSessionKey(SESSION_ID);

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <MotorsTab
          sessionKey={sessionKey}
          navigation={
            {addListener: () => () => undefined, goBack: () => undefined} as never
          }
          subscribeTabBlur={() => () => undefined}
        />,
      );
      await flush();
    });

    // The card, the button, and the label the operator is looking for.
    expect(renderer.root.findAllByProps({testID: 'motors-begin-session-card'})
      .length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({testID: 'motors-begin-session'}).length)
      .toBeGreaterThan(0);

    await ReactTestRenderer.act(async () => {
      renderer.unmount();
    });
  });

  it('renders it even when the panel mounted BEFORE the capability existed', async () => {
    // The real ordering hazard: navigation happens when ownership flips to
    // ACTIVE, which is earlier than startTelemetry()'s creation of the
    // capability in the startReading() continuation. Under the tab shell
    // the panel is mounted once and kept alive, so a first read that came
    // back undefined must not become permanent.
    const coordinator = mspSessionCoordinator;
    coordinator.openSession(makeNativeClient(), SESSION_ID);
    // Deliberately NOT flushed: the capability does not exist yet.
    const sessionKey = coordinator.getSessionKey(SESSION_ID);
    expect(readMotorTestCapability(SESSION_ID)).toBeUndefined();

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <MotorsTab
          sessionKey={sessionKey}
          navigation={
            {addListener: () => () => undefined, goBack: () => undefined} as never
          }
          subscribeTabBlur={() => () => undefined}
        />,
      );
    });
    // The card is present but its control is DISABLED and says why - the
    // fix for the device report. Absence would be indistinguishable from a
    // build that shipped without the feature.
    expect(
      renderer.root.findAllByProps({testID: 'motors-begin-session-card'}).length,
    ).toBeGreaterThan(0);
    expect(
      renderer.root.findAllByProps({testID: 'motors-begin-no-session'}).length,
    ).toBeGreaterThan(0);
    expect(
      renderer.root.findAllByProps({testID: 'motors-begin-session'})[0].props
        .disabled,
    ).toBe(true);

    // Now let startTelemetry() run. The store subscription must pick it up.
    await ReactTestRenderer.act(async () => {
      await flush();
    });
    expect(
      renderer.root.findAllByProps({testID: 'motors-begin-session-card'}).length,
    ).toBeGreaterThan(0);
    expect(
      renderer.root.findAllByProps({testID: 'motors-begin-no-session'}).length,
    ).toBe(0);

    await ReactTestRenderer.act(async () => {
      renderer.unmount();
    });
  });

  it('never offers an ENABLED control without an operator port', async () => {
    // The gate itself, asserted directly: no session key at all is the
    // weakest possible state, and the control must be visible-but-refusing,
    // never actionable.
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <MotorsTab
          sessionKey={undefined}
          navigation={
            {addListener: () => () => undefined, goBack: () => undefined} as never
          }
          subscribeTabBlur={() => () => undefined}
        />,
      );
    });
    const button = renderer.root.findAllByProps({
      testID: 'motors-begin-session',
    })[0];
    expect(button).toBeDefined();
    expect(button.props.disabled).toBe(true);
    expect(
      renderer.root.findAllByProps({testID: 'motors-begin-no-session'}).length,
    ).toBeGreaterThan(0);
    ReactTestRenderer.act(() => {
      renderer.unmount();
    });
  });
});

describe('a bring-up throw is NAMED on screen, not swallowed', () => {
  /**
   * THE POINT OF THIS TEST. Before the try/catch in openSession()'s
   * startReading() continuation, a synchronous throw in
   * `beginIdentification()` skipped `startTelemetry()` and became an
   * unhandled rejection - no capability, no teardown, ownership still
   * ACTIVE, and a Motors tab that said only "no active session". The next
   * real-device run must not have to guess again.
   */
  it('startTelemetry() still runs when beginIdentification() throws, and the cause is recorded', async () => {
    // HOW THE THROW IS INDUCED, and why this way. A fake native client
    // cannot reach it: RNMspTransport multiplexes ONE client listener, so
    // bring-up's own `transport.onDataReceived` never calls the client
    // again, and everything else beginIdentification touches synchronously
    // belongs to the real MspClient. So the method itself is replaced on the
    // instance for exactly one openSession() call - `openSession` invokes it
    // as `this.beginIdentification(...)`, which an own property shadows.
    //
    // This tests the GUARD, not a fabricated failure mode: the question is
    // "if this step throws, does telemetry still come up and is the cause
    // recorded", and that question is answered honestly by making it throw.
    const coordinator = mspSessionCoordinator as unknown as Record<
      string,
      unknown
    >;
    const original = coordinator.beginIdentification;
    coordinator.beginIdentification = () => {
      throw new Error('native listener registration failed');
    };
    try {
      mspSessionCoordinator.openSession(makeNativeClient(), SESSION_ID);
      await flush(10);
    } finally {
      coordinator.beginIdentification = original;
    }

    // 1. The throw was caught and attributed to the right step.
    const failure = mspSessionCoordinator.getSessionBringUpFailure(SESSION_ID);
    expect(failure).toBeDefined();
    expect(failure).toContain('beginIdentification');
    expect(failure).toContain('native listener registration failed');

    // 2. AND telemetry still came up. This is the half the old bare
    //    sequential calls could not promise, and the half that decides
    //    whether the Motors tab is reachable at all.
    expect(readMotorTestCapability(SESSION_ID)).toBeDefined();

    // 3. The operator sees the cause instead of an unexplained blocked
    //    screen.
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <MotorsTab
          sessionKey={mspSessionCoordinator.getSessionKey(SESSION_ID)}
          navigation={
            {addListener: () => () => undefined, goBack: () => undefined} as never
          }
          subscribeTabBlur={() => () => undefined}
        />,
      );
      await flush();
    });
    // The capability DID open here, so the operator port resolves and the
    // developer string is correctly NOT shown - it is reserved for the
    // blocked state. Asserted so the display rule cannot silently widen.
    expect(
      renderer.root.findAllByProps({testID: 'motors-begin-bringup-error'}).length,
    ).toBe(0);
    await ReactTestRenderer.act(async () => {
      renderer.unmount();
    });
  });

  it('records nothing, and shows nothing, on a healthy bring-up', async () => {
    const coordinator = mspSessionCoordinator;
    coordinator.openSession(makeNativeClient(), SESSION_ID);
    await flush();

    // The no-change half of the guarantee: the guards add visibility to a
    // failure, and must not invent one where none happened.
    expect(coordinator.getSessionBringUpFailure(SESSION_ID)).toBeUndefined();

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <MotorsTab
          sessionKey={coordinator.getSessionKey(SESSION_ID)}
          navigation={
            {addListener: () => () => undefined, goBack: () => undefined} as never
          }
          subscribeTabBlur={() => () => undefined}
        />,
      );
      await flush();
    });
    expect(
      renderer.root.findAllByProps({testID: 'motors-begin-bringup-error'}).length,
    ).toBe(0);
    await ReactTestRenderer.act(async () => {
      renderer.unmount();
    });
  });

  it('displays the recorded cause in the blocked no-session state', async () => {
    // Driven through the VIEW directly, because what is under test here is
    // the display contract, not how the string was obtained.
    const {MotorsScreenView} = require('./MotorsScreen') as typeof import('./MotorsScreen');
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <MotorsScreenView
          operator={undefined}
          bringUpFailure="startTelemetry - Error: scheduler construction failed"
        />,
      );
    });
    const shown = renderer.root.findAllByProps({
      testID: 'motors-begin-bringup-error',
    })[0];
    expect(shown).toBeDefined();
    expect(shown.props.children).toContain('scheduler construction failed');
    ReactTestRenderer.act(() => {
      renderer.unmount();
    });
  });
});
