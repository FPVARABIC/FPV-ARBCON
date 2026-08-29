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
import { View } from 'react-native';

import '../../src/i18n';
import { MotorAirframeControls } from '../../src/ui/screens/MotorAirframeControls';
import { FirmwareChoice } from '../../src/ui/components/firmware';
import FirmwareFlasherScreen from '../../src/ui/screens/FirmwareFlasherScreen';
import ModesScreen from '../../src/ui/screens/ModesScreen';
import OsdScreen from '../../src/ui/screens/OsdScreen';
import PresetsScreen from '../../src/ui/screens/PresetsScreen';
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

const SCENES: Record<string, () => React.JSX.Element> = {
  motors: () => (
    <MotorAirframeControls
      sessionId="touch-fixture"
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
