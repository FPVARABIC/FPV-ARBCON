/* Screenshot fixtures reuse real screens and decoded virtual-board snapshots.
   Only the illustrative values from guide-spec.mjs are substituted. No
   transport is opened, and no flight-controller command can be sent. */
import React from 'react';
import {createRoot} from 'react-dom/client';
import {View, Text} from 'react-native';
import '../../src/i18n';
import {KEY, SCREENS, recorder} from '../../src/ui/screens/__censusFixtures__/censusScreens';
import FirmwareFlasherScreen from '../../src/ui/screens/FirmwareFlasherScreen';

const q = new URLSearchParams(window.location.search);
const number = (name: string, fallback: number) => q.has(name) ? Number(q.get(name)) : fallback;
const screen = q.get('screen') ?? 'receiver';
const gpsPorts = (ports: any[]) => {const selected = ports.find(p => p.identifier === 1) ?? ports.find(p => p.identifier >= 0 && p.identifier < 20); return ports.map(p => p === selected ? {...p, identifier: 1, functionMask: 2} : p);};
const names: Record<string, string> = {
  receiver: 'Receiver', 'pid-feel': 'PID', motors: 'MotorConfiguration',
  failsafe: 'Failsafe', osd: 'OSD', vtx: 'VTX', power: 'Power',
  ports: 'Ports', gps: 'GPS', modes: 'Modes', presets: 'Presets',
};

// The census already confines minimal ports to its fixture layer.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function values(snapshot: any): any {
  switch (screen) {
    case 'receiver': return {...snapshot, rx: {...snapshot.rx, rcSmoothing: 1,
      rcSmoothingAutoFactor: number('autoFactor', 30), rcSmoothingAutoFactorThrottle: number('throttleFactor', 30),
      rcSmoothingSetpointCutoff: number('setpointCutoff', 0), rcSmoothingThrottleCutoff: number('throttleCutoff', 0)}};
    case 'pid-feel': return {...snapshot, idleMinRpm: number('idle', 30),
      feedforwardJitterFactor: number('jitter', 10), feedforwardBoost: number('boost', 15),
      feedforwardAveraging: number('averaging', 0), rcTuning: {...snapshot.rcTuning,
        throttleMid: number('thrMid', 50), throttleHover: number('thrHover', 50), throttleExpo: number('thrExpo', 0)}};
    case 'motors': return {...snapshot, advanced: {...snapshot.advanced, motorProtocolRaw: number('protocol', 7)},
      motor: {...snapshot.motor, motorPoleCount: number('poles', 14), dshotTelemetryRaw: number('bidir', 1)}};
    case 'failsafe': return {...snapshot, config: {...snapshot.config, procedure: number('procedure', 1)},
      supportsGpsRescue: true, gpsRescue: {...snapshot.gpsRescue,
        returnAltitudeM: 30, groundSpeedCmS: 750, descendRate: 150, minSats: 8,
        allowArmingWithoutFix: 0, sanityChecks: 2}};
    case 'power': return {...snapshot, battery: {...snapshot.battery, minCellCentivolts: number('min', 330),
      warningCellCentivolts: number('warn', 350), maxCellCentivolts: number('max', 435), capacityMah: number('capacity', 1300)}};
    case 'osd': return {...snapshot, config: {...snapshot.config, rssiDbmAlarm: number('rssiDbm', -100),
      linkQualityAlarmPercent: number('lq', 60), capacityAlarmMah: number('capacity', 1100), altitudeAlarm: number('altitude', 300)}};
    case 'gps': return {...snapshot, featureMaskRaw: snapshot.featureMaskRaw + ((snapshot.featureMaskRaw & 128) ? 0 : 128), ports: gpsPorts(snapshot.ports), configuration: {...snapshot.configuration, provider: 1, autoConfig: true, homePointOnce: true, useGalileo: true}};
    case 'ports': return {...snapshot, ports: gpsPorts(snapshot.ports)};
    case 'modes': {
      // msp_box.c @ 79065c96: GPS RESCUE has permanent id 46.
      const found = snapshot.definitions.find((d: any) => d.name.includes('GPS') && d.name.includes('RESCUE'));
      const rescue = found ?? {name: 'GPS RESCUE', permanentId: 46, flagIndex: snapshot.definitions.length};
      return {...snapshot, definitions: found ? snapshot.definitions : [...snapshot.definitions, rescue], slots: snapshot.slots.map((slot: any, i: number) => i === 1 ? {...slot, permanentId: rescue.permanentId, auxChannelIndex: 1, start: 1700, end: 2100, logic: 0, linkedTo: 0, outOfRange: false} : slot)};
    }
    case 'vtx': return {...snapshot, powerLevels: [{number: 1, value: 25, label: '25'}, {number: 2, value: 100, label: '100'}, {number: 3, value: 400, label: '400'}, {number: 4, value: 600, label: '600'}], config: {...snapshot.config, band: number('band', 1), channel: number('channel', 1),
      power: number('power', 4), pitMode: number('pit', 0) !== 0, lowPowerDisarm: number('lowPower', 0), tableAvailable: true, powerLevelCount: 4}};
    default: return snapshot;
  }
}

const flasherClient = {
  listDevices: async () => [], listDfuDevices: async () => [],
  onDeviceAttached: () => () => undefined, onDeviceDetached: () => () => undefined,
  onDfuFlashProgress: () => () => undefined, cancelDfuFlash: async () => undefined,
  supportsDevicePicker: () => false, supportsDfuDevicePicker: () => false,
};
const flasherApi = {
  loadTargets: async () => [{target: 'SPEEDYBEEF405V3', group: 'supported', manufacturer: 'SpeedyBee', mcu: 'STM32F405'}],
  loadTargetReleases: async () => ({releases: [{release: '4.6.0', label: '4.6.0', type: 'Stable'}]}),
  loadBuild: async () => ({target: 'SPEEDYBEEF405V3', release: '4.6.0', releaseType: 'Stable', cloudBuild: true}),
  loadOptions: async () => ({radioProtocols: [{name: 'CRSF', value: 'RX_CRSF', default: true}],
    telemetryProtocols: [{name: '[None]', value: '', default: true}], motorProtocols: [{name: 'DShot', value: 'DSHOT', default: true}],
    generalOptions: [{name: 'GPS', value: 'GPS'}, {name: 'OSD', groupedName: 'MSP DisplayPort', value: 'OSD_HD', group: 'OSD', default: true}]}),
  loadCommits: async () => [], loadBuildLog: async () => '',
};
function GuideScene(): React.JSX.Element {
  const [element, setElement] = React.useState<React.ReactElement | null>(null);
  const [failure, setFailure] = React.useState<string>();
  React.useEffect(() => {
    let live = true;
    if (screen === 'flasher') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setElement(<FirmwareFlasherScreen client={flasherClient as any} buildApi={flasherApi as any} />);
      return;
    }
    const found = SCREENS.find(candidate => candidate.name === names[screen]);
    if (!found) {setFailure(`Unknown guide scene: ${screen}`); return;}
    found.mount(recorder()).then(async built => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const original = built as React.ReactElement<any>;
      if (screen === 'presets') {
        const entries = ['Voorbeeld: Freestyle', 'Voorbeeld: Cinematic', 'Voorbeeld: Racing', 'Voorbeeld: Whoop', 'Voorbeeld: Long Range'].map((title, index) => ({
          fullPath: `presets/2025.12/tune/example-${index}.txt`, hash: 'a'.repeat(64), title,
          firmwareVersions: ['2025.12'], category: 'TUNE', status: 'OFFICIAL', rawCategory: 'TUNE',
          rawStatus: 'OFFICIAL', keywords: [], author: 'FPV', forceOptionsReview: true, priority: 1,
        }));
        const repository = {...original.props.repository,
          loadIndex: async () => ({majorVersion: 1, minorVersion: 0, presets: entries, categories: ['TUNE'], rejectedEntries: 0}),
          loadFirmwareVersion: async () => ({yearOffsetRaw: 25, year: 2025, month: 12, patch: 5, versionString: '2025.12.5', suffix: null}),
        };
        if (live) setElement(React.cloneElement(original, {repository}));
        return;
      }
      const controller = original.props.controller;
      if (controller && typeof controller.load === 'function') {
        const loaded = await controller.load(KEY);
        const patched = values(loaded.snapshot);
        const port = Object.create(controller);
        port.load = async () => ({...loaded, snapshot: patched});
        if (live) setElement(React.cloneElement(original, {controller: port}));
      } else if (live) setElement(built);
    }).catch(error => {if (live) setFailure(String(error));});
    return () => {live = false;};
  }, []);
  return <View style={{flex: 1}} testID={element ? 'guide-ready' : 'guide-loading'}>
    <Text style={{fontSize: 11, padding: 6}}>Voorbeeldgegevens — geen aangesloten vluchtcontroller</Text>
    {failure ? <Text>{failure}</Text> : element}
  </View>;
}
createRoot(document.getElementById('root')!).render(<GuideScene />);
