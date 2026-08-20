jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

/**
 * NO FLIGHT CONTROLLER, NO CONFIGURATION SCREEN.
 *
 * THE DEFECT THIS PINS. Every tab mounted its screen whether or not
 * anything was plugged in. Measured on the real Motors tab with no
 * session: 90 labelled nodes over 3.4 screens of scroll, five controls
 * still enabled, a propeller-removal warning, a throttle slider and an
 * emergency STOP bar - a screen that looked like it was talking to a
 * board that was not there.
 *
 * WHAT IS ASSERTED, and it is stronger than "the controls are
 * disabled": the screen is NOT MOUNTED. A screen that never mounts
 * cannot start a poll, take a lease, or fire an effect at a session
 * that does not exist, so there is nothing left to get wrong.
 *
 * The gate's decision table lives in
 * ui/session/flightControllerGate.test.ts. This file is about what the
 * SHELL does with that decision.
 */

import React from 'react';
import {Text} from 'react-native';
import ReactTestRenderer from 'react-test-renderer';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({top: 44, bottom: 34, left: 0, right: 0}),
}));

const mockMounted: Record<string, number> = {};
function mockProbe(name: string) {
  return {
    __esModule: true,
    default: function Probe() {
      React.useEffect(() => {
        mockMounted[name] = (mockMounted[name] ?? 0) + 1;
      }, []);
      return <Text testID={`probe-${name}`}>{name}</Text>;
    },
  };
}
jest.mock('./SetupScreen', () => mockProbe('SETUP'));
jest.mock('./MotorsScreen', () => mockProbe('MOTORS'));
jest.mock('./PortsScreen', () => mockProbe('PORTS'));
jest.mock('./GpsScreen', () => mockProbe('GPS'));
jest.mock('./ConfigurationsScreen', () => mockProbe('CONFIGURATIONS'));
jest.mock('./ReceiverScreen', () => mockProbe('RECEIVER'));
jest.mock('./PidTuningScreen', () => mockProbe('PID'));
jest.mock('./ModesScreen', () => mockProbe('MODES'));
jest.mock('./FailsafeScreen', () => mockProbe('FAILSAFE'));
jest.mock('./PowerBatteryScreen', () => mockProbe('POWER'));
jest.mock('./OsdScreen', () => mockProbe('OSD'));
jest.mock('./VideoTransmitterScreen', () => mockProbe('VTX'));
jest.mock('./SensorsScreen', () => mockProbe('SENSORS'));
jest.mock('./PresetsScreen', () => mockProbe('PRESETS'));
jest.mock('./CliScreen', () => mockProbe('CLI'));

import '../../i18n';
import {mspSessionCoordinator} from '../../platforms/react-native/protocol';
import * as sessionState from '../../platforms/react-native/protocol/useMspSessionState';
import MainTabsScreen from './MainTabsScreen';
import {FC_DEPENDENT_TABS} from '../session';

const IDENTIFIED = Object.freeze({
  status: 'SUCCEEDED',
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
const IDLE = Object.freeze({status: 'IDLE'});
const KEY = {sessionId: 'session-1', generation: 2};

/**
 * Presents the coordinator as a board in a given condition. Everything
 * downstream - the real gate, the real shell - runs unchanged.
 */
function board(
  options: {
    ownership?: 'ACTIVE' | 'INACTIVE';
    generation?: number | undefined;
    identified?: boolean;
  } = {},
) {
  const {ownership = 'ACTIVE', generation = 2, identified = true} = options;
  jest
    .spyOn(sessionState, 'useMspOwnershipState')
    .mockImplementation(() => ownership);
  jest
    .spyOn(sessionState, 'useMspIdentificationState')
    .mockImplementation(() => (identified ? IDENTIFIED : IDLE) as never);
  jest
    .spyOn(mspSessionCoordinator, 'getSessionKey')
    .mockImplementation(sessionId =>
      generation === undefined || sessionId !== 'session-1'
        ? undefined
        : {sessionId: 'session-1', generation},
    );
}

function renderShell(params: Record<string, unknown> | undefined) {
  const navigation = {addListener: () => () => {}, goBack: () => {}} as never;
  const route = {key: 'Setup-1', name: 'Setup' as const, params} as never;
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <MainTabsScreen navigation={navigation} route={route} />,
    );
  });
  const has = (testID: string) =>
    renderer.root.findAllByProps({testID}).length > 0;
  return {
    renderer,
    has,
    press: (tab: string) =>
      ReactTestRenderer.act(() => {
        renderer.root
          .findAllByProps({testID: `main-tab-${tab}`})[0]
          .props.onPress();
      }),
    unmount: () =>
      ReactTestRenderer.act(() => {
        renderer.unmount();
      }),
  };
}

beforeEach(() => {
  for (const key of Object.keys(mockMounted)) delete mockMounted[key];
  jest.restoreAllMocks();
});

describe('a configuration screen does not exist without a flight controller', () => {
  it.each(['MOTORS', 'PID', 'PORTS', 'RECEIVER'])(
    '%s is never mounted when nothing is connected',
    tab => {
      board({ownership: 'INACTIVE', generation: undefined});
      const shell = renderShell(undefined);
      shell.press(tab);

      expect(mockMounted[tab]).toBeUndefined();
      expect(shell.has(`probe-${tab}`)).toBe(false);
      // And the operator is told why, with one way forward.
      expect(shell.has(`connection-gate-${tab}`)).toBe(true);
      expect(shell.has('connection-gate-action')).toBe(true);
      shell.unmount();
    },
  );

  it('gates every FC-dependent tab, not just the ones with a bug report', () => {
    board({ownership: 'INACTIVE', generation: undefined});
    const shell = renderShell(undefined);
    for (const tab of FC_DEPENDENT_TABS) {
      shell.press(tab);
      expect(`${tab}:${shell.has(`probe-${tab}`)}`).toBe(`${tab}:false`);
      expect(`${tab}:${shell.has(`connection-gate-${tab}`)}`).toBe(
        `${tab}:true`,
      );
    }
    shell.unmount();
  });

  /**
   * SETUP IS THE WAY OUT, so it is never gated. If it were, the gate's
   * own button would lead to another gate and the operator would have no
   * route to a session at all.
   */
  it('still mounts SETUP, which is where connecting happens', () => {
    board({ownership: 'INACTIVE', generation: undefined});
    const shell = renderShell(undefined);
    expect(shell.has('probe-SETUP')).toBe(true);
    expect(shell.has('connection-gate-SETUP')).toBe(false);
    shell.unmount();
  });
});

describe('the same screens work normally once a board is there', () => {
  it.each(['MOTORS', 'PID', 'PORTS', 'RECEIVER'])(
    '%s mounts against a live, current, identified session',
    tab => {
      board();
      const shell = renderShell({sessionKey: KEY});
      shell.press(tab);
      expect(shell.has(`probe-${tab}`)).toBe(true);
      expect(shell.has(`connection-gate-${tab}`)).toBe(false);
      shell.unmount();
    },
  );
});

describe('the gate follows the session, not the route parameter', () => {
  /**
   * THE DIRECT-ROUTE CASE. A navigation parameter is just data: it
   * survives a browser back/forward, a restored navigation state and a
   * deep link, none of which reopen a port. Carrying a key proves only
   * that a session existed once.
   */
  it('refuses a route that arrives carrying a key with no live session', () => {
    board({ownership: 'INACTIVE', generation: undefined});
    const shell = renderShell({sessionKey: KEY});
    shell.press('MOTORS');
    expect(shell.has('probe-MOTORS')).toBe(false);
    expect(shell.has('connection-gate-MOTORS')).toBe(true);
    shell.unmount();
  });

  it('refuses a STALE key - the board came back as a new generation', () => {
    // The route still names generation 2; the coordinator has moved to 3.
    board({generation: 3});
    const shell = renderShell({sessionKey: KEY});
    shell.press('PID');
    expect(shell.has('probe-PID')).toBe(false);
    expect(shell.has('connection-gate-PID')).toBe(true);
    shell.unmount();
  });

  it('holds the screen closed while the board is still being identified', () => {
    board({identified: false});
    const shell = renderShell({sessionKey: KEY});
    shell.press('PORTS');
    expect(shell.has('probe-PORTS')).toBe(false);
    expect(shell.has('connection-gate-PORTS')).toBe(true);
    // Nothing to press: the link is already up and the answer is coming.
    expect(shell.has('connection-gate-action')).toBe(false);
    shell.unmount();
  });

  /**
   * DISCONNECTING WHILE THE SCREEN IS OPEN. The gate reads the
   * coordinator through useSyncExternalStore, so this is not a
   * navigation event - the screen drops the moment ownership does.
   */
  it('drops an open screen to the disconnected state when the board goes away', () => {
    board();
    const shell = renderShell({sessionKey: KEY});
    shell.press('MOTORS');
    expect(shell.has('probe-MOTORS')).toBe(true);

    ReactTestRenderer.act(() => {
      board({ownership: 'INACTIVE', generation: undefined});
      shell.renderer.update(
        <MainTabsScreen
          navigation={{addListener: () => () => {}, goBack: () => {}} as never}
          route={
            {key: 'Setup-1', name: 'Setup', params: {sessionKey: KEY}} as never
          }
        />,
      );
    });

    expect(shell.has('probe-MOTORS')).toBe(false);
    expect(shell.has('connection-gate-MOTORS')).toBe(true);
    shell.unmount();
  });

  it('comes back to life on the NEW generation after a reconnect', () => {
    board({ownership: 'INACTIVE', generation: undefined});
    const shell = renderShell({sessionKey: {sessionId: 'session-1', generation: 7}});
    shell.press('RECEIVER');
    expect(shell.has('probe-RECEIVER')).toBe(false);

    ReactTestRenderer.act(() => {
      board({generation: 7});
      shell.renderer.update(
        <MainTabsScreen
          navigation={{addListener: () => () => {}, goBack: () => {}} as never}
          route={
            {
              key: 'Setup-1',
              name: 'Setup',
              params: {sessionKey: {sessionId: 'session-1', generation: 7}},
            } as never
          }
        />,
      );
    });

    expect(shell.has('probe-RECEIVER')).toBe(true);
    expect(shell.has('connection-gate-RECEIVER')).toBe(false);
    shell.unmount();
  });
});
