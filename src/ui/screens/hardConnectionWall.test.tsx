jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

/**
 * THE HARD WALL, ASSERTED AT THE APPLICATION LEVEL.
 *
 * Not "the controls are disabled", not "a gate card is shown" - the
 * claim is that no FC-dependent screen component EXISTS before a flight
 * controller is verified. Each configuration screen is replaced by a
 * probe that records every mount, so "did Motors render?" is answered by
 * whether Motors ever ran, not by what happened to be in the tree when
 * somebody looked.
 *
 * WHY THAT IS THE ONLY CLAIM WORTH MAKING. A screen that never mounts
 * cannot start a poll, take a lease, fire an effect, or flash for a
 * frame before a guard notices; and a route that is not registered in
 * the navigator cannot be reached by a direct URL, a deep link, a
 * restored navigation state, or browser back/forward. The wall is the
 * navigator's own screen list (App.tsx), which is why this file drives
 * the REAL App rather than a screen.
 */

import React from 'react';
import {Text} from 'react-native';
import ReactTestRenderer from 'react-test-renderer';

/* Only the insets are faked. Replacing the whole module strips
   SafeAreaInsetsContext, which react-navigation's own
   SafeAreaProviderCompat reads with useContext - and useContext(undefined)
   throws before anything under test has rendered. */
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({top: 44, bottom: 34, left: 0, right: 0}),
}));

const mockMounts: Record<string, number> = {};
/**
 * Every generation a screen has ever been rendered with, in order.
 * "Was the workspace re-parameterized?" is a question about which key
 * actually reached the screens, and a boolean cannot answer it.
 */
const mockGenerations: Record<string, number[]> = {};
function mockProbe(name: string) {
  return {
    __esModule: true,
    default: function Probe(props: {
      readonly sessionKey?: {readonly generation: number};
      readonly route?: {
        readonly params?: {readonly sessionKey?: {readonly generation: number}};
      };
    }) {
      React.useEffect(() => {
        mockMounts[name] = (mockMounts[name] ?? 0) + 1;
      }, []);
      /* The shell hands most screens a plain `sessionKey` prop and hands
         Setup the whole route (see MainTabsScreen). Both are the same
         key; read whichever this screen was given. */
      const generation = (props.sessionKey ?? props.route?.params?.sessionKey)
        ?.generation;
      React.useEffect(() => {
        if (generation === undefined) return;
        const seen = (mockGenerations[name] ??= []);
        if (seen[seen.length - 1] !== generation) seen.push(generation);
      }, [generation]);
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
jest.mock('./BlackboxScreen', () => mockProbe('BLACKBOX'));
jest.mock('./PresetsScreen', () => mockProbe('PRESETS'));
jest.mock('./CliScreen', () => mockProbe('CLI'));
/* Home drives the connection itself; the transport bridge underneath it
   is not what this file is testing. */
jest.mock('./setupSessionHost', () => ({
  useSetupSessionDisconnect: () => () => undefined,
  SetupScreenContent: () => null,
}));

import '../../i18n';
import {mspSessionCoordinator} from '../../platforms/react-native/protocol';
import {fcRebootRecovery} from '../../platforms/react-native/protocol/fcRebootRecovery';
import App from '../../../App';

/** Every FC-dependent screen the configuration workspace hosts. */
const FC_SCREENS = [
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
  'SENSORS',
  'BLACKBOX',
  'PRESETS',
  'CLI',
] as const;

const SESSION_ID = 'wall-session';
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

/**
 * The coordinator as a board in a given condition. Every listener it
 * hands out is captured so a test can push a change and have the app
 * re-evaluate exactly the way the hardware would make it.
 */
let listeners: Array<() => void> = [];
function presentBoard(
  options: {
    present?: boolean;
    ownership?: 'ACTIVE' | 'INACTIVE' | 'ACTIVATING' | 'CLOSING';
    generation?: number;
    identified?: boolean;
  } = {},
) {
  const {
    present = true,
    ownership = 'ACTIVE',
    generation = 1,
    identified = true,
  } = options;
  jest
    .spyOn(mspSessionCoordinator, 'listSessionIds')
    .mockImplementation(() => (present ? [SESSION_ID] : []));
  jest
    .spyOn(mspSessionCoordinator, 'getOwnershipState')
    .mockImplementation(() => ownership);
  jest
    .spyOn(mspSessionCoordinator, 'getSessionKey')
    .mockImplementation(id =>
      present && id === SESSION_ID ? {sessionId: SESSION_ID, generation} : undefined,
    );
  jest
    .spyOn(mspSessionCoordinator, 'getIdentificationState')
    .mockImplementation(() => (identified ? IDENTIFIED : IDLE) as never);
}

function captureSubscriptions() {
  const remember = (listener: () => void) => {
    listeners.push(listener);
    return () => undefined;
  };
  jest
    .spyOn(mspSessionCoordinator, 'subscribeOwnershipState')
    .mockImplementation(remember as never);
  jest
    .spyOn(mspSessionCoordinator, 'subscribeIdentificationState')
    .mockImplementation(remember as never);
  jest.spyOn(fcRebootRecovery, 'subscribe').mockImplementation(remember);
}

function renderApp() {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(<App />);
  });
  return {
    renderer,
    has: (testID: string) =>
      renderer.root.findAllByProps({testID}).length > 0,
    /** Push the hardware change the mocks now describe. */
    settle: () =>
      ReactTestRenderer.act(() => {
        for (const listener of [...listeners]) listener();
      }),
    unmount: () =>
      ReactTestRenderer.act(() => {
        renderer.unmount();
      }),
  };
}

/** Presses Home's "open drone setup" door. */
function openConfigurationDoor(app: ReturnType<typeof renderApp>) {
  ReactTestRenderer.act(() => {
    app.renderer.root
      .findAllByProps({testID: 'start-configure'})[0]
      .props.onPress();
  });
}

beforeEach(() => {
  for (const key of Object.keys(mockMounts)) delete mockMounts[key];
  for (const key of Object.keys(mockGenerations)) delete mockGenerations[key];
  listeners = [];
  jest.restoreAllMocks();
  fcRebootRecovery.reset();
  captureSubscriptions();
});

afterEach(() => {
  fcRebootRecovery.reset();
});

describe('before a flight controller is verified there is no configuration UI', () => {
  it('mounts NO FC-dependent screen, and no tab shell, on a cold start', () => {
    presentBoard({present: false, ownership: 'INACTIVE'});
    const app = renderApp();
    for (const screen of FC_SCREENS) {
      expect(`${screen}: ${mockMounts[screen] ?? 0}`).toBe(`${screen}: 0`);
    }
    expect(mockMounts.SETUP ?? 0).toBe(0);
    app.unmount();
  });

  it('keeps the operator on Home when the configuration door is pressed', () => {
    presentBoard({present: false, ownership: 'INACTIVE'});
    const app = renderApp();
    openConfigurationDoor(app);
    // Home, not a connection page - there is no such page to go to.
    expect(app.has('start-screen')).toBe(true);
    // And still nothing from the configuration workspace.
    for (const screen of FC_SCREENS) {
      expect(`${screen}: ${mockMounts[screen] ?? 0}`).toBe(`${screen}: 0`);
    }
    app.unmount();
  });

  it('offers no navigation INTO a configuration screen - no sidebar, no tabs', () => {
    presentBoard({present: false, ownership: 'INACTIVE'});
    const app = renderApp();
    openConfigurationDoor(app);
    for (const tab of ['SETUP', ...FC_SCREENS]) {
      expect(`tab ${tab}: ${app.has(`main-tab-${tab}`)}`).toBe(
        `tab ${tab}: false`,
      );
    }
    expect(app.has('main-tab-panel-MOTORS')).toBe(false);
    app.unmount();
  });

  /**
   * THE DIRECT-URL / RESTORED-STATE CASE, asserted at its root: the
   * protected route is not in the navigator at all, so there is nothing
   * for a URL, a deep link or a restored state to resolve to.
   */
  it('does not register the Setup route while disconnected', () => {
    presentBoard({present: false, ownership: 'INACTIVE'});
    const app = renderApp();
    const names = app.renderer.root
      .findAllByProps({testID: 'probe-SETUP'})
      .concat(app.renderer.root.findAllByProps({testID: 'probe-MOTORS'}));
    expect(names.length).toBe(0);
    app.unmount();
  });

  it.each(['ACTIVATING', 'CLOSING', 'INACTIVE'] as const)(
    'keeps the workspace shut while ownership is %s',
    ownership => {
      presentBoard({ownership});
      const app = renderApp();
      openConfigurationDoor(app);
      expect(mockMounts.MOTORS ?? 0).toBe(0);
      expect(app.has('start-screen')).toBe(true);
      app.unmount();
    },
  );

  it('an ACTIVE link that has not identified yet does NOT open the workspace', () => {
    presentBoard({identified: false});
    const app = renderApp();
    openConfigurationDoor(app);
    expect(mockMounts.MOTORS ?? 0).toBe(0);
    expect(mockMounts.SETUP ?? 0).toBe(0);
    app.unmount();
  });
});

describe('identification success is what opens the application', () => {
  it('mounts the workspace only once the board is identified', () => {
    presentBoard({identified: false});
    const app = renderApp();
    openConfigurationDoor(app);
    expect(mockMounts.SETUP ?? 0).toBe(0);

    presentBoard({identified: true});
    app.settle();

    expect(mockMounts.SETUP ?? 0).toBeGreaterThan(0);
    expect(app.has('main-tab-MOTORS')).toBe(true);
    app.unmount();
  });
});

describe('losing the board returns the operator to Home', () => {
  it('unmounts the configuration workspace and shows Home', () => {
    presentBoard();
    const app = renderApp();
    openConfigurationDoor(app);
    ReactTestRenderer.act(() => {
      app.renderer.root
        .findAllByProps({testID: 'main-tab-MOTORS'})[0]
        .props.onPress();
    });
    expect(mockMounts.MOTORS ?? 0).toBeGreaterThan(0);
    const mountedBefore = mockMounts.MOTORS ?? 0;

    presentBoard({present: false, ownership: 'INACTIVE'});
    app.settle();

    // Gone from the tree, and NOT re-mounted behind a notice.
    expect(app.has('probe-MOTORS')).toBe(false);
    expect(app.has('main-tab-MOTORS')).toBe(false);
    expect(mockMounts.MOTORS).toBe(mountedBefore);
    expect(app.has('start-screen')).toBe(true);
    app.unmount();
  });

  it('a reconnect on a NEW generation opens the workspace again', () => {
    presentBoard({present: false, ownership: 'INACTIVE'});
    const app = renderApp();
    openConfigurationDoor(app);
    expect(mockMounts.SETUP ?? 0).toBe(0);

    presentBoard({generation: 9});
    app.settle();
    expect(mockMounts.SETUP ?? 0).toBeGreaterThan(0);
    // The NEW board's key, and only it - a workspace that opened on a
    // generation the hardware no longer has is the stale-session defect
    // wearing a connected face.
    expect(mockGenerations.SETUP).toEqual([9]);
    app.unmount();
  });

  /**
   * A STALE GENERATION IS A STALE SESSION.
   *
   * The board re-enumerates - unplugged and back in, or rebooted by
   * something other than us - and the coordinator issues a new
   * generation for what is, to the operating system, a new device. The
   * navigation params still name the old one. Nothing may keep running
   * against it: the screens have to end up holding the generation the
   * hardware actually has, or none at all.
   */
  it('never leaves a screen holding the generation the board has moved past', () => {
    presentBoard({generation: 1});
    const app = renderApp();
    openConfigurationDoor(app);
    expect(mockGenerations.SETUP).toEqual([1]);

    // The link drops and comes back as a different device generation.
    presentBoard({present: false, ownership: 'INACTIVE'});
    app.settle();
    presentBoard({generation: 4});
    app.settle();

    const seen = mockGenerations.SETUP ?? [];
    expect(seen[seen.length - 1]).toBe(4);
    app.unmount();
  });
});

describe('an expected reboot is a transitional state, not a disconnection', () => {
  it('shows the reconnect message and no configuration screen', () => {
    presentBoard();
    const app = renderApp();
    openConfigurationDoor(app);
    expect(mockMounts.SETUP ?? 0).toBeGreaterThan(0);

    // A CLI save: the app declares the reboot, then the board goes.
    fcRebootRecovery.expectReboot(SESSION_ID, 'CLI_SAVE');
    presentBoard({present: false, ownership: 'INACTIVE'});
    app.settle();

    expect(app.has('reboot-overlay')).toBe(true);
    expect(app.has('probe-MOTORS')).toBe(false);
    app.unmount();
  });

  it('reopens the workspace when the reconnect succeeds', () => {
    presentBoard();
    const app = renderApp();
    openConfigurationDoor(app);

    fcRebootRecovery.expectReboot(SESSION_ID, 'CLI_SAVE');
    presentBoard({present: false, ownership: 'INACTIVE'});
    app.settle();
    expect(app.has('reboot-overlay')).toBe(true);

    fcRebootRecovery.noteSessionLost(SESSION_ID);
    fcRebootRecovery.noteRecovered();
    presentBoard({generation: 2});
    app.settle();

    expect(app.has('main-tab-MOTORS')).toBe(true);
    app.unmount();
  });

  /**
   * A BOARD THAT DOES NOT COME BACK. fcRebootRecovery leaves its
   * in-flight phases on a deadline of its own, so the transitional
   * state cannot become a place the operator is stranded.
   */
  it('returns the operator to Home on timeout', () => {
    presentBoard();
    const app = renderApp();
    openConfigurationDoor(app);

    fcRebootRecovery.expectReboot(SESSION_ID, 'CLI_SAVE');
    presentBoard({present: false, ownership: 'INACTIVE'});
    app.settle();
    expect(app.has('reboot-overlay')).toBe(true);

    // The recovery gives up; nothing else about the world changes.
    fcRebootRecovery.noteReopenFailed();
    app.settle();

    expect(app.has('reboot-overlay')).toBe(false);
    expect(app.has('start-screen')).toBe(true);
    expect(mockMounts.MOTORS ?? 0).toBe(0);
    app.unmount();
  });
});
