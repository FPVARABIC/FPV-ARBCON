// ENTRY CLEANUP: SetupScreen now hosts the USB connection workspace
// (UsbConnectionScreen) for its disconnected state, so importing it pulls
// in the transport client whose TurboModule must be mocked under Jest -
// the exact mock App.test.tsx has always used.
jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

/**
 * A CONNECTED BOARD, so the connection gate is open.
 *
 * MainTabsScreen now refuses to mount a configuration screen unless the
 * coordinator reports a live, current, identified session
 * (ui/session/flightControllerGate.ts) - which is the point of that
 * gate, and is why an unconnected shell renders no panels at all.
 * This file is about something else entirely, so it presents the shell
 * with the session an operator would actually have. The REAL gate logic
 * still runs over these values; only the hardware underneath is faked.
 */
jest.mock(
  '../../platforms/react-native/protocol/useMspSessionState',
  () => {
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
  return ({
    /* ONE FROZEN OBJECT, returned by reference. The real hook caches its
       identification snapshot for exactly this reason - a fresh object
       per call makes every useSyncExternalStore consumer re-render, and
       here it would defeat the tab panels' memoisation and make this
       file fail while measuring nothing real. */
    useMspOwnershipState: () => 'ACTIVE',
    useMspIdentificationState: () => IDENTIFIED,
    useMspRecoveryState: () => undefined,
  });
  },
);


/**
 * THE TAB-SWITCH COST, AS A REGRESSION TEST (PART AB).
 *
 * WHAT WAS MEASURED, AND HOW. Every tab screen was replaced by a counting
 * probe and the REAL shell was driven through REAL tab switches. Before
 * this pass, one tap re-rendered EVERY mounted screen: 7 renders after 7
 * tabs had been opened, and the number grew with each tab the operator had
 * ever visited - 15 screens re-rendering per tap in a long session, among
 * them a 2,600-line Motors tree and a live Receiver workspace. That is the
 * reported "moving from one screen to another feels sluggish", and it
 * explains why it got worse the longer the app was used.
 *
 * WHAT IS ASSERTED HERE IS CAUSAL BEHAVIOUR, NOT MILLISECONDS. Jest cannot
 * promise a wall-clock figure and a test that tried would be noise. The
 * claim is exact and checkable: a tab switch re-renders the panel being
 * left and the panel being entered, and NOTHING else. Real phone latency
 * remains REQUIRES HARDWARE TEST.
 */
import React from 'react';
import {Text} from 'react-native';
import ReactTestRenderer from 'react-test-renderer';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({top: 44, bottom: 34, left: 0, right: 0}),
}));

const mockRenders: Record<string, number> = {};
const mockMounts: Record<string, number> = {};
const mockActive: Record<string, unknown> = {};

function mockProbe(name: string) {
  return {
    __esModule: true,
    default: function Probe(props: Record<string, unknown>) {
      mockRenders[name] = (mockRenders[name] ?? 0) + 1;
      mockActive[name] = props.active;
      React.useEffect(() => {
        mockMounts[name] = (mockMounts[name] ?? 0) + 1;
      }, []);
      return <Text>{name}</Text>;
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

import {mspSessionCoordinator} from '../../platforms/react-native/protocol';
import MainTabsScreen from './MainTabsScreen';

/** The coordinator's own answer for "which session is current". */
jest.spyOn(mspSessionCoordinator, 'getSessionKey').mockImplementation(
  sessionId =>
    sessionId === 'session-1'
      ? {sessionId: 'session-1', generation: 1}
      : undefined,
);


function renderShell() {
  const navigation = {addListener: () => () => {}, goBack: () => {}} as never;
  const route = {
    key: 'Setup-1',
    name: 'Setup' as const,
    params: {sessionKey: {sessionId: 'session-1', generation: 1}},
  } as never;
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <MainTabsScreen navigation={navigation} route={route} />,
    );
  });
  return {
    renderer,
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

/** Renders attributable to ONE switch, per screen. */
function costOf(shell: ReturnType<typeof renderShell>, tab: string) {
  const before = {...mockRenders};
  shell.press(tab);
  const delta: Record<string, number> = {};
  for (const key of Object.keys(mockRenders)) {
    const d = (mockRenders[key] ?? 0) - (before[key] ?? 0);
    if (d > 0) delta[key] = d;
  }
  return delta;
}

beforeEach(() => {
  for (const key of Object.keys(mockRenders)) delete mockRenders[key];
  for (const key of Object.keys(mockMounts)) delete mockMounts[key];
  for (const key of Object.keys(mockActive)) delete mockActive[key];
});

describe('PART AB: one tab switch costs two panel renders, not fifteen', () => {
  it('re-renders ONLY the panel being left and the panel being entered', () => {
    const shell = renderShell();
    for (const tab of ['MOTORS', 'RECEIVER', 'PORTS', 'MODES', 'PID', 'FAILSAFE']) {
      shell.press(tab);
    }
    const delta = costOf(shell, 'MOTORS');
    // Leaving FAILSAFE, entering MOTORS. Everything else stays put.
    expect(Object.keys(delta).sort()).toEqual(['FAILSAFE', 'MOTORS']);
    const total = Object.values(delta).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(2);
    shell.unmount();
  });

  it('the cost does NOT grow with the number of tabs already visited', () => {
    const shell = renderShell();
    shell.press('MOTORS');
    const early = costOf(shell, 'RECEIVER');
    for (const tab of ['PORTS', 'MODES', 'PID', 'POWER', 'OSD', 'VTX', 'GPS']) {
      shell.press(tab);
    }
    const late = costOf(shell, 'RECEIVER');
    const sum = (d: Record<string, number>) =>
      Object.values(d).reduce((total, n) => total + n, 0);
    // THIS is the property that made a long session feel worse than a
    // fresh one: it used to be O(tabs opened).
    expect(sum(late)).toBe(sum(early));
    shell.unmount();
  });

  it('keeps every visited tab MOUNTED - state is preserved, not discarded', () => {
    const shell = renderShell();
    for (const tab of ['MOTORS', 'RECEIVER', 'PORTS']) shell.press(tab);
    shell.press('SETUP');
    // One mount each, and no unmount/remount cycle on the way back.
    expect(mockMounts).toMatchObject({SETUP: 1, MOTORS: 1, RECEIVER: 1, PORTS: 1});
    shell.press('MOTORS');
    expect(mockMounts.MOTORS).toBe(1);
    shell.unmount();
  });

  it('hands Motors and Ports the SAME lifecycle signal every other tab gets', () => {
    const shell = renderShell();
    shell.press('MOTORS');
    expect(mockActive.MOTORS).toBe(true);
    expect(mockActive.SETUP).toBe(false);
    shell.press('PORTS');
    expect(mockActive.MOTORS).toBe(false);
    expect(mockActive.PORTS).toBe(true);
    shell.unmount();
  });

  it('exactly one panel is active at a time', () => {
    const shell = renderShell();
    for (const tab of ['MOTORS', 'RECEIVER', 'MODES']) shell.press(tab);
    const activeCount = Object.values(mockActive).filter(v => v === true).length;
    expect(activeCount).toBe(1);
    shell.unmount();
  });

  it('repeated switching does not remount or duplicate any panel', () => {
    const shell = renderShell();
    for (let round = 0; round < 5; round++) {
      shell.press('MOTORS');
      shell.press('RECEIVER');
    }
    expect(mockMounts.MOTORS).toBe(1);
    expect(mockMounts.RECEIVER).toBe(1);
    shell.unmount();
  });

  it('RECEIVER is unaffected while other tabs are switched between', () => {
    const shell = renderShell();
    shell.press('RECEIVER');
    shell.press('MOTORS');
    const before = mockRenders.RECEIVER ?? 0;
    // Four switches that never touch Receiver.
    for (const tab of ['PORTS', 'MODES', 'PORTS', 'MODES']) shell.press(tab);
    expect(mockRenders.RECEIVER ?? 0).toBe(before);
    shell.unmount();
  });

  it('ships no private tab-performance timer', () => {
    // The shell owns exactly ONE timer, the accepted departure backstop.
    // Nothing here may add a second clock to make switching feel faster.
    const source = require('fs').readFileSync(
      require('path').join(__dirname, 'MainTabsScreen.tsx'),
      'utf8',
    ) as string;
    const executable = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(executable).not.toMatch(/\bsetInterval\b/);
    expect(executable).not.toMatch(/\brequestAnimationFrame\b/);
    // Exactly ONE scheduled callback: the accepted departure backstop at
    // MOTOR_DEPARTURE_BOUND_MILLIS. The second textual match is the
    // `ReturnType<typeof setTimeout>` in its own type annotation, which
    // schedules nothing - so the call sites are counted, not the mentions.
    const calls = executable.match(/(?<!typeof )\bsetTimeout\s*\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });
});
