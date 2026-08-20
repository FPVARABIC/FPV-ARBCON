jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

/**
 * WHAT STAYS PUBLIC, AND WHY IT IS NOT A SIDE DOOR.
 *
 * The hard connection wall removes the configuration workspace from the
 * navigator until a flight controller is verified. Two surfaces
 * deliberately stay reachable before that, and each one had to be
 * decided rather than assumed:
 *
 *   THE FIRMWARE FLASHER. Putting it behind an MSP session would be
 *   wrong in the exact case it exists for. A board with no firmware, a
 *   bricked board, or a board sitting in DFU has no MSP session to
 *   offer - conditioning the flasher on one would lock the operator out
 *   of the only tool that can rescue it. So it stays public.
 *
 *   THE FLIGHT STYLE GUIDE. It is educational content about flying -
 *   captures, explanations, recommended setups. It reads no hardware and
 *   writes none. Tying it to a session would mean an operator cannot
 *   read about a style unless a drone happens to be plugged in.
 *
 * The risk that comes with both decisions is the same one: a public
 * route becoming a way INTO the configuration workspace that skips the
 * wall. That is what this file asserts against. Being reachable is
 * proven by rendering them with no board at all; not being a side door
 * is proven by the configuration screens never mounting while they are
 * open, and by no production module other than the two application
 * roots ever naming the 'Setup' route.
 */

import React from 'react';
import {Text} from 'react-native';
import ReactTestRenderer from 'react-test-renderer';

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({top: 44, bottom: 34, left: 0, right: 0}),
}));

const mockMounts: Record<string, number> = {};
function mockProbe(name: string) {
  return {
    __esModule: true,
    default: function Probe() {
      React.useEffect(() => {
        mockMounts[name] = (mockMounts[name] ?? 0) + 1;
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
/* The two public screens are replaced by probes as well: what is under
   test here is REACHABILITY and ISOLATION, not their content, and the
   real ones pull esptool and every guide capture into this suite. */
jest.mock('./FirmwareFlasherSimpleScreen', () => mockProbe('FLASHER'));
jest.mock('./FlightStyleGuideScreen', () => mockProbe('GUIDE'));
jest.mock('./setupSessionHost', () => ({
  SetupConnectWorkspace: () => null,
  SetupScreenContent: () => null,
}));

import * as fs from 'fs';
import * as path from 'path';

import '../../i18n';
import {mspSessionCoordinator} from '../../platforms/react-native/protocol';
import {fcRebootRecovery} from '../../platforms/react-native/protocol/fcRebootRecovery';
import App from '../../../App';

/** Every screen that only exists once a board is verified. */
const FC_SCREENS = [
  'SETUP',
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
  'PRESETS',
  'CLI',
] as const;

const ROOT = path.join(__dirname, '..', '..', '..');

/** Source with comments removed - a mention in prose proves nothing. */
function readCode(file: string): string {
  return fs
    .readFileSync(path.join(ROOT, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** NO BOARD, in every sense the resolver understands. */
function presentNoBoard() {
  jest
    .spyOn(mspSessionCoordinator, 'listSessionIds')
    .mockImplementation(() => []);
  jest
    .spyOn(mspSessionCoordinator, 'getOwnershipState')
    .mockImplementation(() => 'INACTIVE');
  jest
    .spyOn(mspSessionCoordinator, 'getSessionKey')
    .mockImplementation(() => undefined);
  jest
    .spyOn(mspSessionCoordinator, 'getIdentificationState')
    .mockImplementation(() => ({status: 'IDLE'}) as never);
  const ignore = () => () => undefined;
  jest
    .spyOn(mspSessionCoordinator, 'subscribeOwnershipState')
    .mockImplementation(ignore as never);
  jest
    .spyOn(mspSessionCoordinator, 'subscribeIdentificationState')
    .mockImplementation(ignore as never);
  jest.spyOn(fcRebootRecovery, 'subscribe').mockImplementation(ignore);
}

function renderApp() {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(<App />);
  });
  return {
    renderer,
    has: (testID: string) => renderer.root.findAllByProps({testID}).length > 0,
    press: (testID: string) =>
      ReactTestRenderer.act(() => {
        renderer.root.findAllByProps({testID})[0].props.onPress();
      }),
    unmount: () =>
      ReactTestRenderer.act(() => {
        renderer.unmount();
      }),
  };
}

beforeEach(() => {
  for (const key of Object.keys(mockMounts)) delete mockMounts[key];
  jest.restoreAllMocks();
  fcRebootRecovery.reset();
  presentNoBoard();
});

afterEach(() => {
  fcRebootRecovery.reset();
});

describe('the firmware flasher is reachable with no flight controller', () => {
  it('opens from Home with no session and no board', () => {
    const app = renderApp();
    app.press('start-firmware');
    expect(app.has('probe-FLASHER')).toBe(true);
    app.unmount();
  });

  /**
   * THE SIDE-DOOR TEST. Reaching the flasher must not reach anything
   * else: no tab shell appears around it, and not one configuration
   * screen runs while it is open.
   */
  it('is not a way into the configuration workspace', () => {
    const app = renderApp();
    app.press('start-firmware');

    expect(app.has('main-tabs')).toBe(false);
    for (const screen of FC_SCREENS) {
      expect(mockMounts[screen] ?? 0).toBe(0);
    }
    app.unmount();
  });

  /**
   * AND IT DOES NOT OPEN A SESSION TO GET THERE. Conditioning the
   * flasher on MSP is exactly what would break DFU recovery, so the
   * absence of any such condition is asserted on the source itself.
   */
  it('carries no MSP session condition anywhere in its own path', () => {
    const flasher = readCode('src/ui/screens/FirmwareFlasherSimpleScreen.tsx');
    expect(flasher).not.toContain('useVerifiedFcConnection');
    expect(flasher).not.toContain('configurationWorkspaceUnlocked');
    expect(flasher).not.toContain('sessionKey');
  });
});

describe('the flight style guide is public educational content', () => {
  it('opens from Home with no session and no board', () => {
    const app = renderApp();
    app.press('start-flight-style-guide');
    expect(app.has('probe-GUIDE')).toBe(true);
    app.unmount();
  });

  it('is not a way into the configuration workspace', () => {
    const app = renderApp();
    app.press('start-flight-style-guide');

    expect(app.has('main-tabs')).toBe(false);
    for (const screen of FC_SCREENS) {
      expect(mockMounts[screen] ?? 0).toBe(0);
    }
    app.unmount();
  });

  it('reads no hardware and holds no session key', () => {
    const guide = readCode('src/ui/screens/FlightStyleGuideScreen.tsx');
    expect(guide).not.toContain('mspSessionCoordinator');
    expect(guide).not.toContain('sessionKey');
  });
});

/**
 * THE STRUCTURAL CLAIM BEHIND BOTH DECISIONS.
 *
 * A public screen cannot be a side door into a route it cannot name.
 * The two application roots own that route; nothing else in the product
 * refers to it, so there is no navigate('Setup') anywhere for a public
 * screen - present or future - to reach it through.
 */
describe('only the application roots name the configuration route', () => {
  it('finds no other production reference to it', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '__testUtils__') {
            continue;
          }
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
          continue;
        }
        const code = fs
          .readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        if (/navigate\(\s*['"]Setup['"]/.test(code)) {
          offenders.push(path.relative(ROOT, full));
        }
      }
    };
    walk(path.join(ROOT, 'src'));
    expect(offenders).toEqual([]);
  });
});

/**
 * THE TWO ROOTS MUST AGREE, and this test exists because they did not.
 *
 * App.web.tsx was found registering `Setup` unconditionally while
 * App.tsx walled it off - so the browser build, the one an operator can
 * reach by typing a URL, had no wall at all. A safety rule that holds on
 * one platform and not the other is not a safety rule.
 */
describe('the wall is identical on both application roots', () => {
  it.each(['App.tsx', 'App.web.tsx'])(
    '%s registers the configuration workspace only while it is unlocked',
    file => {
      const code = readCode(file).replace(/\s+/g, ' ');
      expect(code).toContain('useVerifiedFcConnection()');
      expect(code).toContain(
        'configurationWorkspaceUnlocked(connection)',
      );
      // The conditional registration itself: Setup in the true branch,
      // Connect in the false one.
      expect(code).toMatch(
        /\{workspaceUnlocked \? \( <Stack\.Screen name="Setup"[\s\S]*?\) : \( <Stack\.Screen name="Connect"/,
      );
    },
  );
});
