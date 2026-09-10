/**
 * THE EIGHTEEN GATED DESTINATIONS, SPLIT INTO WHAT NEEDS A BOARD AND WHAT
 * DOES NOT.
 *
 * =====================================================================
 * WHY THIS FILE EXISTS
 * =====================================================================
 *
 * androidDestinationCensus.test.ts establishes the denominator: 22
 * destinations, each with a named harness. DestinationInteractionTest.kt
 * drives 4 of them on an emulator and asserts the other 18 stay shut,
 * because the product gates them:
 *
 *     configurationWorkspaceUnlocked(connection) =
 *         connection.kind === 'CONNECTED'
 *
 * What neither file says is the thing an audit actually needs: for each of
 * those 18, WHICH PART needs a flight controller and which part does not.
 * "Eighteen destinations need hardware" is the sentence a campaign hides
 * behind, and left at that it is indistinguishable from eighteen
 * destinations nobody tested.
 *
 * So every gated destination is classified here on two axes at once, and
 * neither may be empty:
 *
 *   A  PHYSICAL_USB_END_TO_END_REQUIRES_REAL_HARDWARE
 *      the part that cannot be had without a board on the other end of a
 *      cable, named specifically rather than as a category
 *
 *   B  UI_AND_STATE_PATH_TESTABLE_WITH_TEST_ONLY_VIRTUAL_FC
 *      the part that is driven, today, by harnesses in this repository
 *      over the virtual flight controllers in __testUtils__ - files this
 *      suite checks exist and checks actually reach a virtual board
 *
 * =====================================================================
 * WHY B IS NOT ALSO DRIVEN ON THE EMULATOR, STATED PLAINLY
 * =====================================================================
 *
 * A virtual session cannot be handed to the app on a device without a seam
 * in the SHIPPED APK, and the brief forbids exactly that: no demo mode, no
 * test-only path inside the release build. The reason is mechanical, not a
 * preference. Reaching CONNECTED runs through METHOD CALLS into the native
 * module - listDevices, requestPermission, openDevice, write - and every
 * one of them starts at UsbManager.getDeviceList(), which on an emulator is
 * empty. An androidTest can emit events into the running bundle, but it
 * cannot make those four calls return a device without replacing the module
 * that MainApplication registers, and that module is release-APK code.
 *
 * That is a measurement, not an assumption. Three device cases stand behind
 * it, each of which fails if the fact stops holding:
 *
 *   DestinationInteractionTest#theEmulatorHasNoUsbDeviceSoTheChainTo
 *     ConnectedCannotEvenStart
 *       reads UsbManager.getDeviceList() on the emulator and prints it
 *   ReactHostCampaignTest#listDevicesResolvesWithAnEmptyListRatherThan
 *     HangingOrFailing
 *       asks the SHIPPED module on the same device and gets an empty list
 *   DestinationInteractionTest#theWorkspaceStaysLockedWithoutABoardSoThe
 *     OtherEighteenAreUnreachableHere
 *       presses the configure card and requires the tab host never to appear
 *
 * So the honest statement of coverage for the eighteen is: A is
 * NOT VERIFIED ON REAL HARDWARE, and B is verified off-device against a
 * virtual flight controller. Neither half is claimed as the other.
 *
 * NOT VERIFIED ON REAL HARDWARE.
 */

import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

import {MAIN_TABS} from '../../navigation/tabs';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const APP_SOURCE = join(REPO_ROOT, 'App.tsx');
const DEVICE_SUITE = join(
  REPO_ROOT,
  'android',
  'app',
  'src',
  'androidTest',
  'java',
  'com',
  'fpvarbcon',
  'DestinationInteractionTest.kt',
);
const GATE_SOURCE = join(REPO_ROOT, 'src', 'ui', 'session', 'verifiedConnection.ts');
const CENSUS_FIXTURE = 'src/ui/screens/__censusFixtures__/censusScreens.tsx';
const CENSUS_RUNNER = 'src/ui/screens/interactionCensus.test.tsx';

/** How the UI and state path of a destination is driven off-device. */
type Driver =
  | {readonly over: 'VIRTUAL_FLIGHT_CONTROLLER'; readonly files: readonly string[]}
  | {readonly over: 'NO_BOARD_INVOLVED'; readonly files: readonly string[]; readonly why: string};

interface Gated {
  /** A: the part that needs a board, named specifically. */
  readonly physical: string;
  /** B: the part that does not, and what drives it. */
  readonly uiAndState: Driver;
}

const CENSUS: Driver = {
  over: 'VIRTUAL_FLIGHT_CONTROLLER',
  files: [CENSUS_FIXTURE, CENSUS_RUNNER],
};

/**
 * THE EIGHTEEN. Each `physical` line says what specifically cannot be had
 * without a board - not "it needs hardware", which would be the same
 * sentence eighteen times and would carry no information.
 */
const GATED: Readonly<Record<string, Gated>> = {
  Setup: {
    physical:
      'the tab host only exists once a board is CONNECTED, so its first mount ' +
      'and its teardown on disconnect are ordered by a real link coming up and going away',
    uiAndState: {
      over: 'NO_BOARD_INVOLVED',
      files: [
        'src/ui/screens/MainTabsScreen.tabBlur.test.tsx',
        'src/navigation/blackboxTabPlacement.test.ts',
      ],
      why:
        'the host itself draws a strip and mounts whichever panel is active. ' +
        'Tab switching, blur and mount policy are decisions it makes with no board ' +
        'in them at all, so a virtual one would add nothing to drive.',
    },
  },
  SETUP: {
    physical:
      'accelerometer and magnetometer calibration, and reboot, are MSP commands whose ' +
      'effect is a physical sensor settling and a board restarting',
    uiAndState: {
      over: 'VIRTUAL_FLIGHT_CONTROLLER',
      files: [
        'src/ui/screens/SetupScreen.test.tsx',
        'src/ui/screens/SetupScreenIntegration.test.tsx',
        'src/ui/screens/setupInformationHierarchy.test.tsx',
      ],
    },
  },
  MOTORS: {
    physical: 'spinning a motor, and the arming interlock that must prevent it',
    uiAndState: CENSUS,
  },
  PORTS: {
    physical: 'a UART actually carrying the reassigned function after a save and reboot',
    uiAndState: CENSUS,
  },
  GPS: {
    physical: 'satellite acquisition and a fix from a receiver under a sky',
    uiAndState: CENSUS,
  },
  CONFIGURATIONS: {
    physical: 'board orientation and feature flags taking effect on the flight controller',
    uiAndState: CENSUS,
  },
  RECEIVER: {
    physical: 'live channel values arriving from a bound transmitter',
    uiAndState: CENSUS,
  },
  PID: {
    physical: 'a tuned loop flying, which no bench can answer',
    uiAndState: CENSUS,
  },
  MODES: {
    physical: 'a mode actually switching when a real channel crosses its range',
    uiAndState: CENSUS,
  },
  FAILSAFE: {
    physical: 'the board entering failsafe when the radio link is genuinely lost',
    uiAndState: CENSUS,
  },
  POWER: {
    physical: 'voltage and current read from a real battery through a real sensor',
    uiAndState: CENSUS,
  },
  OSD: {
    physical: 'the layout appearing on a video feed from the flight controller',
    uiAndState: CENSUS,
  },
  VTX: {
    physical: 'a transmitter changing band, channel and power, which is regulated radio',
    uiAndState: CENSUS,
  },
  LED: {
    physical: 'the strip lighting in the configured colours',
    uiAndState: CENSUS,
  },
  SENSORS: {
    physical: 'gyro, accelerometer, barometer and magnetometer traces from moving hardware',
    uiAndState: CENSUS,
  },
  BLACKBOX: {
    physical: 'flash or SD storage on the board being erased, filled and downloaded',
    uiAndState: CENSUS,
  },
  PRESETS: {
    physical: 'a preset applied to a board and surviving its reboot',
    uiAndState: CENSUS,
  },
  CLI: {
    physical: 'the firmware CLI answering over the serial link',
    uiAndState: CENSUS,
  },
};

/** Every `<Stack.Screen name="X"` in App.tsx, in source order. */
function stackRoutes(): string[] {
  const source = readFileSync(APP_SOURCE, 'utf8');
  return [...source.matchAll(/<Stack\.Screen\s+name="([A-Za-z]+)"/g)].map(match => match[1]);
}

function destinations(): string[] {
  return [...stackRoutes(), ...MAIN_TABS.map(tab => tab.key as string)];
}

/** The four the device suite says it drives, read from the device suite. */
function deviceReachable(): string[] {
  const source = readFileSync(DEVICE_SUITE, 'utf8');
  const block = /val REACHABLE = listOf\(([\s\S]*?)\n {4}\)/.exec(source);
  if (!block) throw new Error('DestinationInteractionTest.kt no longer declares REACHABLE');
  return [...block[1].matchAll(/Destination\(\s*"([A-Za-z]+)"/g)].map(match => match[1]);
}

/** The eighteen the device suite says it cannot, read from the device suite. */
function deviceHardwareGated(): string[] {
  const source = readFileSync(DEVICE_SUITE, 'utf8');
  const block = /val REAL_HARDWARE_REQUIRED = listOf\(([\s\S]*?)\n {4}\)/.exec(source);
  if (!block) {
    throw new Error('DestinationInteractionTest.kt no longer declares REAL_HARDWARE_REQUIRED');
  }
  return [...block[1].matchAll(/"([A-Za-z]+)"/g)].map(match => match[1]);
}

function filesOf(driver: Driver): readonly string[] {
  return driver.files;
}

describe('the gated destinations are split, not written off', () => {
  it('the classification covers exactly the destinations the device suite could not reach', () => {
    const gated = Object.keys(GATED).sort();
    const fromDevice = deviceHardwareGated().sort();

    // Read from the Kotlin file rather than repeated here, so the two
    // cannot drift apart without this failing.
    expect(gated).toEqual(fromDevice);
    expect(gated.length).toBe(18);
  });

  it('reachable plus gated is the whole destination set - unclassified 0, overlap 0', () => {
    const all = destinations();
    const reachable = deviceReachable();
    const gated = Object.keys(GATED);

    const unclassified = all.filter(
      name => !reachable.includes(name) && !gated.includes(name),
    );
    const overlap = reachable.filter(name => gated.includes(name));
    const unknown = [...reachable, ...gated].filter(name => !all.includes(name));

    expect({unclassified, overlap, unknown}).toEqual({
      unclassified: [],
      overlap: [],
      unknown: [],
    });
    expect(reachable.length + gated.length).toBe(all.length);
    expect(all.length).toBe(22);
  });

  it('not one of the eighteen is left without a UI and state path that is driven', () => {
    const undriven = Object.entries(GATED)
      .filter(([, entry]) => filesOf(entry.uiAndState).length === 0)
      .map(([name]) => name);
    expect(undriven).toEqual([]);
  });

  it('every harness file named here exists', () => {
    const missing = Object.entries(GATED).flatMap(([name, entry]) =>
      filesOf(entry.uiAndState)
        .filter(file => !existsSync(join(REPO_ROOT, file)))
        .map(file => `${name} -> ${file}`),
    );
    expect(missing).toEqual([]);
  });

  it('every VIRTUAL_FLIGHT_CONTROLLER harness really reaches a virtual board', () => {
    const notReaching = Object.entries(GATED)
      .filter(([, entry]) => entry.uiAndState.over === 'VIRTUAL_FLIGHT_CONTROLLER')
      .flatMap(([name, entry]) =>
        filesOf(entry.uiAndState)
          .filter(file => {
            const source = readFileSync(join(REPO_ROOT, file), 'utf8');
            return !source.includes('__testUtils__') && !source.includes('censusScreens');
          })
          .map(file => `${name} -> ${file} names no virtual board and no census fixture`),
      );
    expect(notReaching).toEqual([]);
  });

  it('the virtual flight controllers it relies on are test-only files', () => {
    // The production bundle scan (scripts/scan-production-bundle.js) skips
    // __testUtils__ when it collects source, which is what keeps these out
    // of the shipped build. Naming the directory here ties this claim to
    // that rule instead of asserting it twice.
    const virtualBoards = [
      'src/platforms/react-native/protocol/__testUtils__/virtualFlightController.ts',
      'src/platforms/react-native/protocol/__testUtils__/virtualSession.ts',
      'src/platforms/react-native/protocol/__testUtils__/virtualLedBoard.ts',
      'src/platforms/react-native/protocol/__testUtils__/virtualSensorsFc.ts',
      'src/platforms/react-native/protocol/__testUtils__/virtualCliBoard.ts',
      'src/platforms/react-native/protocol/__testUtils__/virtualPidBoard.ts',
    ];
    const missing = virtualBoards.filter(file => !existsSync(join(REPO_ROOT, file)));
    expect(missing).toEqual([]);
    expect(virtualBoards.every(file => file.includes('__testUtils__'))).toBe(true);

    const scanner = readFileSync(join(REPO_ROOT, 'scripts', 'scan-production-bundle.js'), 'utf8');
    expect(scanner).toContain('__testUtils__');
  });

  it('every physical half says what specifically needs a board, not that one is needed', () => {
    const vague = Object.entries(GATED)
      .filter(([, entry]) => entry.physical.trim().length < 30)
      .map(([name, entry]) => `${name}: "${entry.physical}"`);
    expect(vague).toEqual([]);

    // Eighteen copies of one sentence would satisfy the length rule and
    // say nothing, so the sentences must also differ from each other.
    const sentences = Object.values(GATED).map(entry => entry.physical);
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  it('the gate that produces this split is the one the product actually applies', () => {
    const gate = readFileSync(GATE_SOURCE, 'utf8');
    expect(gate).toContain('export function configurationWorkspaceUnlocked(');
    expect(gate).toContain("'CONNECTED'");
  });

  it('publishes the table', () => {
    const rows = [
      '===== UI-X3B ANDROID DESTINATION REACHABILITY =====',
      `  reachable on an emulator with no hardware : ${deviceReachable().length}`,
      `  behind the connection gate                : ${Object.keys(GATED).length}`,
      `  total                                     : ${destinations().length}`,
      '',
      '  REACHABLE (driven on the device by DestinationInteractionTest.kt):',
      ...deviceReachable().map(name => `    ${name}`),
      '',
      '  GATED - A = PHYSICAL_USB_END_TO_END_REQUIRES_REAL_HARDWARE',
      '          B = UI_AND_STATE_PATH_TESTABLE_WITH_TEST_ONLY_VIRTUAL_FC',
      ...Object.entries(GATED).flatMap(([name, entry]) => [
        `    ${name}`,
        `      A: ${entry.physical}`,
        `      B: ${entry.uiAndState.over} via ${filesOf(entry.uiAndState).join(', ')}`,
        ...(entry.uiAndState.over === 'NO_BOARD_INVOLVED'
          ? [`         (${entry.uiAndState.why})`]
          : []),
      ]),
      '',
      '  A is NOT VERIFIED ON REAL HARDWARE. B is verified off-device.',
      '===================================================',
    ];
    console.log(rows.join('\n'));
    expect(rows.length).toBeGreaterThan(20);
  });
});
