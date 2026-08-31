/* The fixture wires real screens to deliberately minimal test doubles;
   the port shapes are asserted by the screens themselves and by
   tsconfig.web.json, not by this file, so `any` is used deliberately
   below. */
/**
 * THE REAL-RENDER BROWSER FIXTURE.
 *
 * `scripts/verify-touch-targets.mjs` and `scripts/verify-osd-labels.mjs`
 * measure this page. It exists because both contracts they check - a
 * 44px hit target, and whether a label is actually ellipsized - are
 * about a RENDERED rect, and neither a source scan nor a jsdom render
 * can produce one: jsdom has no layout engine, so
 * `getBoundingClientRect` there returns zeros and proves nothing.
 *
 * Every group mounts the REAL production component in the REAL state
 * that draws the control in question. Two of them are only reachable in
 * states no ordinary fixture produces:
 *
 *   - the Motors retry renders only while the airframe read has FAILED,
 *     so the injected controller throws;
 *   - the Modes remove control renders only when an AUX range already
 *     exists, so the fixture carries a configured range.
 *
 * The long-label variants use the longest Arabic strings the product
 * itself ships, not invented ones.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { View, useWindowDimensions } from 'react-native';

import '../../src/i18n';
import { MotorAirframeControls } from '../../src/ui/screens/MotorAirframeControls';
import { FirmwareChoice } from '../../src/ui/components/firmware';
import FirmwareFlasherScreen from '../../src/ui/screens/FirmwareFlasherScreen';
import ModesScreen from '../../src/ui/screens/ModesScreen';
import OsdScreen from '../../src/ui/screens/OsdScreen';
import PresetsScreen from '../../src/ui/screens/PresetsScreen';
import PortsScreen from '../../src/ui/screens/PortsScreen';
import PidTuningScreen from '../../src/ui/screens/PidTuningScreen';
import LedStripScreen from '../../src/ui/screens/LedStripScreen';
import BlackboxScreen from '../../src/ui/screens/BlackboxScreen';
import SetupScreen from '../../src/ui/screens/SetupScreen';
import { MotorsScreenView } from '../../src/ui/screens/MotorsScreen';
import BrandTopChrome from '../../src/ui/brand/BrandTopChrome';
import SideNavigationRail from '../../src/ui/components/navigation/SideNavigationRail';
import BottomTabBar from '../../src/ui/components/navigation/BottomTabBar';
import { MAIN_TABS_SHELL } from '../../src/ui/screens/mainTabsShellLayout';
import { isDesktopTier, resolveLayoutTier } from '../../src/ui/theme/layout';
import {
  OSD_ELEMENT_NAMES_AR,
  setOsdPosition,
  setOsdProfileVisibility,
} from '../../src/core/state/osdConfigurationModel';

const KEY = { sessionId: 'touch-fixture', generation: 1 } as const;

/* ---------------- Motors: the UNAVAILABLE retry ------------------- */

const motorsController = {
  load: async () => {
    throw new Error('link down');
  },
  save: async () => ({ kind: 'NO_CHANGES' }) as any,
  requestReboot: async () => ({ kind: 'REJECTED' }) as any,
} as any;

/* ---------------- Modes: a configured AUX range ------------------- */

const emptySlot = () => ({
  permanentId: 0, auxChannelIndex: 0, start: 900, end: 900,
  logic: 0, linkedTo: 0, outOfRange: false,
});
const modesSnapshot: any = {
  definitions: [
    { name: 'ARM', permanentId: 0, flagIndex: 0 },
    { name: 'ANGLE', permanentId: 1, flagIndex: 1 },
    { name: 'BEEPER', permanentId: 13, flagIndex: 2 },
  ],
  capacity: 20,
  unknownIds: [],
  slots: [
    {
      permanentId: 1, auxChannelIndex: 0, start: 1300, end: 1700,
      logic: 0, linkedTo: 0, outOfRange: false,
    },
    ...Array.from({ length: 19 }, emptySlot),
  ],
};
const modesController = {
  load: async () => ({ kind: 'LOADED', snapshot: modesSnapshot }),
  save: async () => ({ kind: 'NO_CHANGES', snapshot: modesSnapshot }),
} as any;

/* ---------------- Presets: the eleven category chips -------------- */

const PRESET_SUMMARY: any = {
  fullPath: 'presets/2025.12/tune/test.txt',
  hash: 'a'.repeat(64),
  title: 'Verified tune',
  firmwareVersions: ['2025.12'],
  category: 'TUNE',
  status: 'OFFICIAL',
  rawCategory: 'TUNE',
  rawStatus: 'OFFICIAL',
  keywords: ['five-inch'],
  author: 'Betaflight',
  forceOptionsReview: true,
  priority: 10,
};
const presetsRepository = {
  loadIndex: async () => ({
    majorVersion: 1, minorVersion: 0,
    presets: [PRESET_SUMMARY], rejectedCount: 0,
  }),
  loadFirmwareVersion: async () => ({
    year: 2025, month: 12, patch: 5, versionString: '2025.12.5', suffix: null,
  }),
  loadPreset: async () => undefined,
  commands: () => [],
} as any;
const presetsCli = {
  getPhase: () => 'IDLE',
  begin: async () => undefined,
  captureDiffAll: async () => '# diff all\n',
  saveTextFile: async () => true,
  executeBatch: async () => ({ commandCount: 0, errors: [] }),
  saveAndClose: async () => undefined,
  exitWithoutSave: async () => undefined,
} as any;

/* ---------------- FirmwareChoice: every rendered state ------------ */

/** The longest source label the Flasher itself ships. */
const LONG_LABEL = 'Firmware الرسمي عبر الإنترنت';
const SHORT_LABEL = 'ملف';

function ChoiceMatrix(): React.JSX.Element {
  const [value, setValue] = React.useState<'online' | 'local'>('online');
  return (
    <View>
      <div data-fixture="choice-enabled">
        <FirmwareChoice
          value={value}
          testIDPrefix="choice-enabled"
          choices={[
            { value: 'online', label: LONG_LABEL },
            { value: 'local', label: SHORT_LABEL },
          ]}
          onChange={setValue}
        />
      </div>
      <div data-fixture="choice-disabled">
        <FirmwareChoice
          value="online"
          disabled
          testIDPrefix="choice-disabled"
          choices={[
            { value: 'online', label: LONG_LABEL },
            { value: 'local', label: SHORT_LABEL },
          ]}
          onChange={() => undefined}
        />
      </div>
    </View>
  );
}

/* ---------------- Flasher: the real screen, no board -------------- */

/**
 * The step tabs and the firmware-source chips are only reachable on the
 * Flasher screen itself, so the screen is mounted whole rather than
 * approximated. Nothing here touches geometry: the USB client answers
 * "no devices" and the build API answers a small catalogue, which is the
 * ordinary state of the screen on a machine with nothing plugged in.
 *
 * Both dependencies are injected props with production defaults, so this
 * substitution changes what the screen TALKS TO and not what it draws.
 */
const flasherClient = {
  listDevices: async () => [],
  listDfuDevices: async () => [],
  onDeviceAttached: () => () => undefined,
  onDeviceDetached: () => () => undefined,
  onDfuFlashProgress: () => () => undefined,
  cancelDfuFlash: async () => undefined,
  supportsDevicePicker: () => false,
  supportsDfuDevicePicker: () => false,
} as any;
const flasherBuildApi = {
  loadTargets: async () => [
    { target: 'STM32F405', manufacturer: 'Betaflight', mcu: 'STM32F405', group: 'OFFICIAL' },
  ],
  loadTargetReleases: async () => [],
  loadOptions: async () => [],
  loadBuild: async () => undefined,
  loadCommits: async () => [],
  loadBuildLog: async () => '',
} as any;

/* ---------------- OSD: the full element list ---------------------- */

/**
 * A production-SHAPED OSD snapshot: one entry per element the firmware
 * actually names, so the element grid renders the real Arabic labels at
 * their real lengths rather than a convenient short sample.
 *
 * The positions are ordinary in-canvas coordinates and the visibility
 * bits are set through the model's own encoders, so nothing here invents
 * a wire value the product could not receive.
 */
const OSD_ELEMENT_POSITIONS = OSD_ELEMENT_NAMES_AR.map((_name, index) => {
  const withPosition = setOsdPosition(0, index % 30, index % 15);
  return setOsdProfileVisibility(withPosition, 1, index % 3 !== 0);
});

const OSD_SNAPSHOT: any = {
  canvas: {columns: 53, rows: 20},
  config: {
    flags: 1,
    videoSystem: 3,
    units: 1,
    rssiAlarmPercent: 30,
    capacityAlarmMah: 1400,
    altitudeAlarm: 120,
    elementPositions: OSD_ELEMENT_POSITIONS,
    statistics: [true, false, true],
    timers: [0x0a21, 0x0b42],
    warningCount: 2,
    enabledWarnings: 1,
    profileCount: 3,
    selectedProfile: 1,
    overlayRadioMode: 0,
    cameraFrameWidth: 24,
    cameraFrameHeight: 11,
    linkQualityAlarmPercent: 70,
    rssiDbmAlarm: -95,
  },
};
const osdController = {
  load: async () => ({kind: 'LOADED', snapshot: OSD_SNAPSHOT}),
  save: async () => ({kind: 'SAVED_VERIFIED', snapshot: OSD_SNAPSHOT}),
} as any;

/* ---------------- THE SHELL, as the browser actually assembles it ---- */

/**
 * WHY THE SHELL IS HERE AT ALL. Every other scene in this file mounts one
 * screen on a bare page, which is the right frame for a question about a
 * control inside that screen. The desktop-workspace question is not that
 * question: it is about how much of the MONITOR the application occupies,
 * and the answer depends on the brand strip above the navigator, the
 * navigation rail beside the workspace, and the screen's own envelope -
 * three owners in two files that only meet at runtime.
 *
 * THE COMPOSITION IS COPIED FROM PRODUCTION, NOT INVENTED:
 *
 *   App.web.tsx      container flex:1 > BrandTopChrome + navigator flex:1
 *   MainTabsScreen   root flex:1 (+ row when the rail shows)
 *                      > SideNavigationRail | content flex:1
 *                      > BottomTabBar when it does not
 *   TabPanel         visible flex:1
 *
 * and `useSideRail` is the SAME predicate MainTabsScreen uses, imported
 * from the same module rather than re-derived, so the rail appears at
 * exactly the width production shows it.
 */
/* `root`/`rootDesktop`/`content`/`visible` are the SAME OBJECTS
   MainTabsScreen renders, imported rather than copied, so a change to
   the shell's geometry is measured here instead of being missed.
   `container`/`navigator` are App.web.tsx's two wrappers, which are
   `flex: 1` and nothing else. */
const shellLayout = {
  container: {flex: 1} as const,
  navigator: {flex: 1} as const,
  ...MAIN_TABS_SHELL,
};

function Shell({children}: {children: React.ReactNode}): React.JSX.Element {
  const {width, fontScale} = useWindowDimensions();
  const useSideRail = isDesktopTier(resolveLayoutTier(width, fontScale));
  return (
    <View style={shellLayout.container} testID="shell-container">
      <BrandTopChrome />
      <View style={shellLayout.navigator}>
        <View
          style={[shellLayout.root, useSideRail && shellLayout.rootDesktop]}
          testID="main-tabs"
        >
          {useSideRail ? (
            <SideNavigationRail activeTab="SETUP" onSelectTab={() => undefined} />
          ) : null}
          <View style={shellLayout.content} testID="shell-content">
            <View style={shellLayout.visible}>{children}</View>
          </View>
          {useSideRail ? null : (
            <BottomTabBar activeTab="SETUP" onSelectTab={() => undefined} />
          )}
        </View>
      </View>
    </View>
  );
}

/* ---------------- Ports: a loaded three-port board ----------------- */

/** Shaped exactly like the double PortsScreen.test.tsx already uses. */
const portRecord = (identifier: number, functionMask: number) => ({
  identifier,
  functionMask,
  mspBaudIndex: 5,
  gpsBaudIndex: 4,
  telemetryBaudIndex: 0,
  blackboxBaudIndex: 5,
  extensionBytes: Uint8Array.from([0xa5]),
});
const PORTS_SNAPSHOT: any = {
  ports: [portRecord(20, 1), portRecord(0, 0), portRecord(1, 0)],
  featureMaskRaw: 0,
  apiVersionMajor: 1,
  apiVersionMinor: 48,
  serialRxProvider: {kind: 'OBSERVED', value: 7},
  buildOptionIds: {kind: 'OBSERVED', value: new Set<number>()},
  vtxTable: {
    kind: 'OBSERVED',
    value: {tableAvailable: true, tableConfigured: true},
  },
};
const portsController = {
  load: async () => ({kind: 'LOADED', snapshot: PORTS_SNAPSHOT}),
  save: async (_key: unknown, original: unknown) => ({
    kind: 'NO_CHANGES',
    snapshot: original,
  }),
} as any;

/* ---------------- Motors: the operator facade, at rest ------------- */

/**
 * The same snapshot shape MotorsScreen.web.test.tsx drives the real screen
 * with - a disarmed four-motor board with nothing spinning. Copied rather
 * than re-imagined so the fixture cannot state a motor condition the
 * product's own tests do not already state.
 */
const motorSnapshot: any = {
  phase: 'ACTIVE',
  setupStep: 'READY',
  machine: {name: 'Ready', authority: {}},
  outcome: {kind: 'READY'},
  firmwareCompatibility: undefined,
  motorScope: {motorCount: 4, motorProtocolRaw: 6, feature3dEnabled: false},
  mixerModeRaw: 3,
  motorDiagnosticsSupport: undefined,
  telemetryHeld: true,
  warnings: [],
  stopDescriptors: [],
  teardown: undefined,
  outputMayBeLive: false,
  stopExecution: {
    attempts: 0, commandDispatched: false, commandAcknowledged: false,
    physicalStopConfirmed: false, deferredBehindActiveWrite: false,
    attributionAmbiguous: false, attributionResolvedByConfirmation: false,
    wirePreemptionClaimed: false, submittedNextOnTransport: false,
    episodeId: 0, outcome: undefined,
  },
  pulse: {
    attemptId: 1, motorNumber: undefined, submitted: false,
    acknowledged: false, deadlineArmedAtSubmission: false,
    mayHaveReachedFc: false, outcome: undefined,
  },
  activation: {allowed: true, reasons: []},
  verificationReceipt: undefined,
  armedStateEvidence: 'FRESH_DISARMED',
  motorDomain: undefined,
  motorRuntimeScope: undefined,
};
const motorOperator = {
  beginSession: async () => motorSnapshot,
  getSnapshot: () => motorSnapshot,
  subscribe: () => () => undefined,
  pulseMotor: () => 'REFUSED' as const,
  renewPulseHold: () => 'RENEWED' as const,
  setEscDirection: async () => ({kind: 'REJECTED'}),
  refreshDiagnostics: async () => undefined,
  requestStop: () => 'ACCEPTED' as const,
  endSession: async () => motorSnapshot,
  setMotorValues: () => ({kind: 'REFUSED', reason: 'NOT_COMMANDABLE'}),
  setMotorValue: () => ({kind: 'REFUSED', reason: 'NOT_COMMANDABLE'}),
  setMaster: () => ({kind: 'REFUSED', reason: 'NOT_COMMANDABLE'}),
  stopAll: () => 'ACCEPTED' as const,
} as any;

const SCENES: Record<string, () => React.JSX.Element> = {
  /* The shell scenes. Each mounts the REAL screen inside the REAL
     browser composition; `verify-desktop-workspace.mjs` measures these. */
  /* Setup is a ROUTE component: it reads its session from
     `route.params.sessionKey` and renders an empty view without one, so
     the fixture hands it the same shape react-navigation would. */
  'shell-setup': () => (
    <Shell>
      <SetupScreen
        route={{params: {sessionKey: KEY}} as any}
        navigation={{goBack: () => undefined} as any}
        active
      />
    </Shell>
  ),
  'shell-motors': () => (
    <Shell>
      <MotorsScreenView operator={motorOperator} sessionId="touch-fixture" active />
    </Shell>
  ),
  'shell-ports': () => (
    <Shell>
      <PortsScreen sessionKey={KEY as any} controller={portsController} />
    </Shell>
  ),
  'shell-osd': () => (
    <Shell>
      <OsdScreen sessionKey={KEY as any} active controller={osdController} />
    </Shell>
  ),
  'shell-pid': () => (
    <Shell>
      <PidTuningScreen
        sessionKey={KEY as any}
        active
        onOpenMotors={() => undefined}
      />
    </Shell>
  ),
  'shell-modes': () => (
    <Shell>
      <ModesScreen
        sessionKey={KEY as any}
        active
        onOpenMotors={() => undefined}
        controller={modesController}
      />
    </Shell>
  ),
  'shell-led': () => (
    <Shell>
      <LedStripScreen
        sessionKey={KEY as any}
        active
        onOpenSetup={() => undefined}
      />
    </Shell>
  ),
  'shell-blackbox': () => (
    <Shell>
      <BlackboxScreen sessionKey={KEY as any} active />
    </Shell>
  ),
  motors: () => (
    <MotorAirframeControls
      sessionId="touch-fixture"
      sessionKey={{sessionId: 'touch-fixture', generation: 1}}
      liveMixerModeRaw={3}
      liveYawMotorsReversed={false}
      writesLocked={false}
      directionOpen={false}
      reorderOpen={false}
      onToggleDirection={() => undefined}
      onToggleReorder={() => undefined}
      onTopology={() => undefined}
      controller={motorsController}
    />
  ),
  modes: () => (
    <ModesScreen
      sessionKey={KEY as any}
      active
      onOpenMotors={() => undefined}
      controller={modesController}
    />
  ),
  presets: () => (
    <PresetsScreen
      sessionKey={KEY as any}
      active
      repository={presetsRepository}
      cli={presetsCli}
      onCliBusyChange={() => undefined}
    />
  ),
  choice: () => <ChoiceMatrix />,
  flasher: () => (
    <FirmwareFlasherScreen client={flasherClient} buildApi={flasherBuildApi} />
  ),
  osd: () => (
    <OsdScreen sessionKey={KEY as any} active controller={osdController} />
  ),
};

const scene = new URLSearchParams(window.location.search).get('s') ?? 'motors';
const render = SCENES[scene];
const root = createRoot(document.getElementById('root')!);
root.render(
  render === undefined ? (
    <div data-fixture="unknown-scene">unknown scene: {scene}</div>
  ) : (
    render()
  ),
);
