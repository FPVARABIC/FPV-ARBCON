/**
 * Real coordinator-to-Motors-screen reachability.
 *
 * Merely opening the tab never acquires the motor-test lease. The explicit
 * preparation action acquires the protected session, and the hold control
 * can pulse only after every controller gate passes. The only native
 * dependency replaced here is USB.
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

const flush = async (turns = 8): Promise<void> => {
  for (let index = 0; index < turns; index++) {
    await Promise.resolve();
  }
};

/** The fake USB write intentionally remains pending: no MSP reply, and no
 * fabricated claim that a controller or motor exists. */
function makeNativeClient(): UsbSerialTransportClient {
  return {
    writeBytes: () => new Promise<void>(() => undefined),
    startReading: () => Promise.resolve(undefined),
    stopReading: () => Promise.resolve(undefined),
    onDataReceived: () => ({remove: () => undefined}),
    onSessionDetached: () => ({remove: () => undefined}),
  } as unknown as UsbSerialTransportClient;
}

function renderMotors(
  sessionKey: ReturnType<typeof mspSessionCoordinator.getSessionKey>,
): ReactTestRenderer.ReactTestRenderer {
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
  return renderer;
}

afterEach(() => {
  mspSessionCoordinator.deactivateMspSession(SESSION_ID);
});

describe('the real coordinator makes the simplified motor action reachable', () => {
  it('registers the capability under the same session key used by the UI', async () => {
    mspSessionCoordinator.openSession(makeNativeClient(), SESSION_ID);
    await flush();
    const sessionKey = mspSessionCoordinator.getSessionKey(SESSION_ID);

    expect(sessionKey).toBeDefined();
    expect(
      readMotorTestCapability(sessionKey?.sessionId ?? '<none>'),
    ).toBeDefined();
  });

  it('renders an explicit preparation action and keeps hold blocked until Ready', async () => {
    mspSessionCoordinator.openSession(makeNativeClient(), SESSION_ID);
    await flush();
    const renderer = renderMotors(
      mspSessionCoordinator.getSessionKey(SESSION_ID),
    );

    const hold = renderer.root.findAllByProps({
      testID: 'motors-hold-button',
    })[0];
    expect(hold).toBeDefined();
    expect(hold.props.disabled).toBe(true);
    expect(hold.props.delayLongPress).toBe(800);
    expect(
      renderer.root.findAllByProps({testID: 'motors-begin-session-button'}).length,
    ).toBeGreaterThan(0);
    expect(
      renderer.root.findAllByProps({testID: 'motors-ack-propellers'}),
    ).toHaveLength(0);

    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('updates a panel mounted before the capability appears', async () => {
    mspSessionCoordinator.openSession(makeNativeClient(), SESSION_ID);
    const sessionKey = mspSessionCoordinator.getSessionKey(SESSION_ID);
    expect(readMotorTestCapability(SESSION_ID)).toBeUndefined();

    const renderer = renderMotors(sessionKey);
    expect(
      renderer.root.findAllByProps({testID: 'motors-hold-button'})[0].props
        .disabled,
    ).toBe(true);

    await ReactTestRenderer.act(async () => {
      await flush();
    });
    expect(readMotorTestCapability(SESSION_ID)).toBeDefined();
    expect(
      renderer.root.findAllByProps({testID: 'motors-begin-session-button'}).length,
    ).toBeGreaterThan(0);
    expect(
      renderer.root.findAllByProps({testID: 'motors-hold-button'})[0].props
        .disabled,
    ).toBe(true);

    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('keeps the hold control disabled when no operator port exists', () => {
    const renderer = renderMotors(undefined);
    const hold = renderer.root.findAllByProps({
      testID: 'motors-hold-button',
    })[0];
    expect(hold.props.disabled).toBe(true);
    expect(
      renderer.root.findAllByProps({testID: 'motors-status-NO_SESSION'}).length,
    ).toBeGreaterThan(0);
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('uses the explicit preparation action without submitting a motor pulse', async () => {
    mspSessionCoordinator.openSession(makeNativeClient(), SESSION_ID);
    await flush();
    const renderer = renderMotors(
      mspSessionCoordinator.getSessionKey(SESSION_ID),
    );
    const prepare = renderer.root.findAllByProps({
      testID: 'motors-begin-session-button',
    })[0];

    ReactTestRenderer.act(() => {
      prepare.props.onPress();
    });
    await ReactTestRenderer.act(async () => {
      await flush();
    });

    const capability = readMotorTestCapability(SESSION_ID);
    expect(capability).toBeDefined();
    const operator = capability?.operatorPort(
      {
        readCurrentIdentity: () => undefined,
        subscribeSessionInvalidated: () => () => undefined,
      } as never,
      () => Date.now(),
    );
    // This no-reply harness may either still be preparing or already have
    // failed closed because another coordinator request owns the link. Both
    // prove the explicit preparation path ran; IDLE would prove it did not.
    expect(operator?.getSnapshot().phase).not.toBe('IDLE');
    // No pulse can be sent while setup is still waiting for real evidence.
    expect(operator?.getSnapshot().pulse.submitted).toBe(false);

    await ReactTestRenderer.act(async () => {
      renderer.unmount();
      await flush(20);
    });
  });
});

describe('coordinator bring-up failures stay observable', () => {
  it('records an identification throw but still opens the capability', async () => {
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

    expect(
      mspSessionCoordinator.getSessionBringUpFailure(SESSION_ID),
    ).toContain('native listener registration failed');
    expect(readMotorTestCapability(SESSION_ID)).toBeDefined();
  });

  it('shows a late telemetry bring-up failure without another user action', async () => {
    const coordinator = mspSessionCoordinator as unknown as Record<
      string,
      unknown
    >;
    const original = coordinator.startTelemetry;
    coordinator.startTelemetry = () => {
      throw new Error('handshake failed on real FC');
    };
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    try {
      renderer = renderMotors({sessionId: SESSION_ID, generation: 1});
      expect(
        renderer.root.findAllByProps({testID: 'motors-begin-bringup-error'}),
      ).toHaveLength(0);

      await ReactTestRenderer.act(async () => {
        mspSessionCoordinator.openSession(makeNativeClient(), SESSION_ID);
        await flush(10);
      });

      const shown = renderer.root.findAllByProps({
        testID: 'motors-begin-bringup-error',
      });
      expect(shown.length).toBeGreaterThan(0);
      expect(String(shown[0].props.children)).toContain(
        'handshake failed on real FC',
      );
    } finally {
      coordinator.startTelemetry = original;
      if (renderer !== undefined) {
        ReactTestRenderer.act(() => renderer.unmount());
      }
    }
  });

  it('shows no diagnostic failure on healthy bring-up', async () => {
    mspSessionCoordinator.openSession(makeNativeClient(), SESSION_ID);
    await flush();
    const renderer = renderMotors(
      mspSessionCoordinator.getSessionKey(SESSION_ID),
    );
    expect(
      renderer.root.findAllByProps({testID: 'motors-begin-bringup-error'}),
    ).toHaveLength(0);
    ReactTestRenderer.act(() => renderer.unmount());
  });
});
