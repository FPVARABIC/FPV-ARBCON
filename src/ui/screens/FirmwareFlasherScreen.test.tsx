jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

import React from 'react';
import {Text} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';
import '../../i18n';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import type {BetaflightTarget} from '../../core/firmware-flasher';
import {bytesToBase64} from '../../platforms/react-native/protocol/base64';
import {FirmwareBootloaderController} from '../../platforms/react-native/protocol/FirmwareBootloaderController';
import type {UsbSerialTransportClient} from '../../platforms/react-native/transport';
import type {DfuDeviceDescriptor} from '../../platforms/react-native/transport/native/NativeUsbSerialTransport';
import FirmwareFlasherScreen, {
  resolveDfuSelection,
  resolveSerialSelection,
} from './FirmwareFlasherScreen';

const VALID_HEX = ':020000040800F2\n:0400000001020304F2\n:00000001FF\n';

function fakeClient() {
  return {
    listDevices: jest.fn(async () => []),
    listDfuDevices: jest.fn(async (): Promise<DfuDeviceDescriptor[]> => []),
    pickFirmwareFile: jest.fn(async () => ({
      name: 'verified.hex',
      sizeBytes: VALID_HEX.length,
      dataBase64: bytesToBase64(Uint8Array.from(VALID_HEX, character => character.charCodeAt(0))),
    })),
    saveFirmwareFile: jest.fn(async () => true),
    onDeviceAttached: jest.fn(() => jest.fn()),
    onDeviceDetached: jest.fn(() => jest.fn()),
    onDfuFlashProgress: jest.fn(() => jest.fn()),
    cancelDfuFlash: jest.fn(async () => undefined),
    unprotectDfuDevice: jest.fn(async () => undefined),
  };
}

function fakeApi(targets: readonly BetaflightTarget[] = []) {
  return {
    loadTargets: jest.fn(async () => targets),
    loadTargetReleases: jest.fn(),
    loadBuild: jest.fn(),
    loadOptions: jest.fn(),
    loadCommits: jest.fn(),
    requestBuild: jest.fn(),
    requestBuildStatus: jest.fn(),
    loadBuildLog: jest.fn(async () => 'Build complete'),
    loadFirmware: jest.fn(),
  };
}

function press(renderer: ReactTestRenderer.ReactTestRenderer, testID: string): Promise<void> {
  const node = renderer.root.findAllByProps({testID}).find(item => typeof item.props.onPress === 'function');
  if (!node) throw new Error(`Missing pressable ${testID}`);
  return act(async () => {
    await node.props.onPress();
    await Promise.resolve();
  });
}

function allText(renderer: ReactTestRenderer.ReactTestRenderer): string {
  return renderer.root.findAllByType(Text).map(node => {
    const value = node.props.children;
    return Array.isArray(value) ? value.join('') : String(value ?? '');
  }).join('\n');
}

async function renderScreen(client = fakeClient(), api = fakeApi()) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <FirmwareFlasherScreen
        client={client as unknown as UsbSerialTransportClient}
        buildApi={api as never}
      />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return {renderer, client, api};
}

async function flushAsyncEffects(rounds = 8): Promise<void> {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) {
      await Promise.resolve();
    }
  });
}

describe('FirmwareFlasherScreen', () => {
  it('recovers a stale Android USB id only when one serial device is unambiguous', () => {
    const only = {
      deviceId: 41,
      vendorId: 0x0483,
      productId: 0x5740,
      productName: 'Flight Controller',
      manufacturerName: 'FPV',
      driverType: 'CDC_ACM',
      portCount: 1,
    } as const;
    expect(resolveSerialSelection([only], 12)).toBe(only);
    expect(resolveSerialSelection([only, {...only, deviceId: 42}], 12)).toBeUndefined();
  });

  it('recovers a stale DFU id only when one bootloader is unambiguous', () => {
    const only = {
      deviceId: 77,
      vendorId: 0x0483,
      productId: 0xdf11,
      productName: 'STM32 BOOTLOADER',
      manufacturerName: 'STMicroelectronics',
      interfaceNumber: 0,
      alternateSetting: 0,
    } as DfuDeviceDescriptor;
    expect(resolveDfuSelection([only], 10)).toBe(only);
    expect(resolveDfuSelection([only, {...only, deviceId: 78}], 10)).toBeUndefined();
  });

  it('shows the build-configuration contract before a board is selected', async () => {
    const {renderer} = await renderScreen();
    expect(renderer.root.findAllByProps({testID: 'build-configuration'}).length).toBeGreaterThan(0);
    expect(allText(renderer)).toContain('Radio وTelemetry وOSD وMotor');
    expect(renderer.root.findByProps({testID: 'build-firmware'}).props.disabled).toBe(true);
    act(() => renderer.unmount());
  });

  it('loads a local HEX after active interactions, validates it and selects the DFU path', async () => {
    const {renderer, client} = await renderScreen();
    await press(renderer, 'firmware-source-local');
    await press(renderer, 'pick-local-firmware');
    expect(client.pickFirmwareFile).toHaveBeenCalledTimes(1);
    expect(allText(renderer)).toContain('HEX • verified.hex');
    expect(allText(renderer)).toContain('STM32 DFU (DfuSe)');
    expect(allText(renderer)).toContain('بوابة الأمان');
    expect(allText(renderer)).toContain('الإعداد الآمن الموصى به');
    expect(allText(renderer)).toContain('المسار البسيط جاهز');
    expect(renderer.root.findAllByProps({testID: 'unprotect-dfu-device'})).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('virtualizes a very large target catalogue instead of mounting every row', async () => {
    const targets = Array.from({length: 2000}, (_, index) => ({
      target: `TARGET_${String(index).padStart(4, '0')}`,
      group: index % 3 === 0 ? 'supported' : 'unsupported',
      manufacturer: 'FPV',
      mcu: 'STM32',
    }));
    const {renderer} = await renderScreen(fakeClient(), fakeApi(targets));
    await press(renderer, 'target-selector');
    const mountedTargetRows = renderer.root.findAll(node =>
      typeof node.props.testID === 'string' && node.props.testID.startsWith('target-TARGET_'),
    );
    expect(mountedTargetRows.length).toBeGreaterThan(0);
    expect(mountedTargetRows.length).toBeLessThan(2000);
    act(() => renderer.unmount());
  });

  it('shows the complete online board, release and Cloud Build configuration with the official empty None option', async () => {
    const api = fakeApi([{target: 'S405', group: 'supported', manufacturer: 'FPV', mcu: 'STM32F405'}]);
    api.loadTargetReleases.mockResolvedValue({releases: [
      {release: '4.6.0', label: '2026-06-01', type: 'Stable'},
      {release: '4.7.0-RC1', label: '2026-07-01', type: 'ReleaseCandidate'},
    ]});
    api.loadBuild.mockResolvedValue({
      target: 'S405',
      release: '4.6.0',
      releaseType: 'Stable',
      cloudBuild: true,
      manufacturer: 'FPV',
      mcu: 'STM32F405',
      date: '2026-06-01',
    });
    api.loadOptions.mockResolvedValue({
      radioProtocols: [{name: 'CRSF', value: 'RX_CRSF', default: true}],
      telemetryProtocols: [
        {name: '[None]', value: '', default: true},
        {name: 'SmartPort', value: 'TELEMETRY_SMARTPORT'},
      ],
      motorProtocols: [{name: 'DShot', value: 'DSHOT', default: true}],
      generalOptions: [
        {name: 'GPS', value: 'GPS'},
        {name: 'OSD', groupedName: 'MSP DisplayPort', value: 'OSD_HD', group: 'OSD', default: true},
      ],
    });

    const {renderer} = await renderScreen(fakeClient(), api);
    await press(renderer, 'target-selector');
    await press(renderer, 'target-S405');
    await flushAsyncEffects();

    expect(renderer.root.findAllByProps({testID: 'build-configuration'}).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({testID: 'release-channel-stable'}).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({testID: 'build-mode-cloud'}).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({testID: 'radio-protocol-selector'}).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({testID: 'telemetry-protocol-selector'}).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({testID: 'osd-protocol-selector'}).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({testID: 'motor-protocol-selector'}).length).toBeGreaterThan(0);
    expect(allText(renderer)).toContain('[None]');
    expect(allText(renderer)).toContain('المعلومات داخل FPV-ARBCON');
    expect(api.loadBuild).toHaveBeenCalledWith('S405', '4.6.0', expect.any(AbortSignal));
    act(() => renderer.unmount());
  });

  it('keeps local flashing available when the online target service fails', async () => {
    const api = fakeApi();
    api.loadTargets.mockRejectedValueOnce(new Error('offline'));
    const {renderer} = await renderScreen(fakeClient(), api);
    expect(allText(renderer)).toContain('المسار المحلي ما زال متاحاً');
    await press(renderer, 'firmware-source-local');
    expect(renderer.root.findAllByProps({testID: 'pick-local-firmware'}).length).toBeGreaterThan(0);
    act(() => renderer.unmount());
  });

  it('honours the manually selected USB device and port during auto detection', async () => {
    const client = fakeClient();
    const serialDevice = {
      deviceId: 41,
      vendorId: 0x0483,
      productId: 0x5740,
      productName: 'Flight Controller',
      manufacturerName: 'FPV',
      driverType: 'CDC',
      portCount: 2,
    };
    client.listDevices.mockResolvedValue([serialDevice] as never);
    const release = jest.fn(async () => undefined);
    const detect = jest.spyOn(FirmwareBootloaderController.prototype, 'detectFlightController')
      .mockResolvedValue({
        device: serialDevice,
        identity: {
          firmware: {knownFamily: 'Betaflight'},
          board: {targetName: 'S405', boardName: 'S405', boardIdentifier: 'S405'},
        },
        release,
      } as never);

    const api = fakeApi([{target: 'S405'}]);
    api.loadTargetReleases.mockResolvedValue({releases: []});
    const {renderer} = await renderScreen(client, api);
    await press(renderer, 'detect-port-1');
    await press(renderer, 'auto-detect-fc');

    expect(detect).toHaveBeenCalledWith(expect.any(AbortSignal), {deviceId: 41, portIndex: 1});
    expect(release).toHaveBeenCalledTimes(1);
    expect(allText(renderer)).toContain('تم التعرف واختيار S405');
    detect.mockRestore();
    act(() => renderer.unmount());
  });

  it('re-enumerates and safely recovers a changed Android USB id before auto detection', async () => {
    const client = fakeClient();
    const previous = {
      deviceId: 12,
      vendorId: 0x0483,
      productId: 0x5740,
      productName: 'Flight Controller',
      manufacturerName: 'FPV',
      driverType: 'CDC',
      portCount: 1,
    };
    const current = {...previous, deviceId: 41};
    client.listDevices.mockResolvedValue([previous] as never);
    const release = jest.fn(async () => undefined);
    const detect = jest
      .spyOn(FirmwareBootloaderController.prototype, 'detectFlightController')
      .mockResolvedValue({
        device: current,
        identity: {
          firmware: {knownFamily: 'BETAFLIGHT'},
          board: {
            targetName: 'SPEEDYBEEF405V5',
            boardName: 'SPEEDYBEEF405V5',
            boardIdentifier: 'S405',
          },
        },
        release,
      } as never);

    const {renderer} = await renderScreen(client);
    client.listDevices.mockResolvedValue([current] as never);
    await press(renderer, 'auto-detect-fc');

    expect(detect).toHaveBeenCalledWith(expect.any(AbortSignal), {
      deviceId: 41,
      portIndex: 0,
    });
    expect(allText(renderer)).toContain('أُعيد ربط المتحكم الوحيد');
    expect(release).toHaveBeenCalledTimes(1);
    detect.mockRestore();
    act(() => renderer.unmount());
  });

  it('loads and labels a local Unified Config independently of the firmware file', async () => {
    const client = fakeClient();
    const config = '# target defaults\nset motor_pwm_protocol = DSHOT300\n';
    client.pickFirmwareFile.mockResolvedValueOnce({
      name: 'S405.config',
      sizeBytes: config.length,
      dataBase64: bytesToBase64(Uint8Array.from(config, character => character.charCodeAt(0))),
    });
    const {renderer} = await renderScreen(client);
    await press(renderer, 'pick-unified-config');
    expect(allText(renderer)).toContain('S405.config');
    expect(allText(renderer)).toContain('سيُتحقق من مؤشري البداية والنهاية والتداخل');
    expect(renderer.root.findByProps({testID: 'clear-unified-config'}).props.disabled).toBe(false);
    act(() => renderer.unmount());
  });

  it('rejects a bridge payload whose decoded size does not match the native file size', async () => {
    const client = fakeClient();
    client.pickFirmwareFile.mockResolvedValueOnce({
      name: 'truncated.hex',
      sizeBytes: VALID_HEX.length + 1,
      dataBase64: bytesToBase64(Uint8Array.from(VALID_HEX, character => character.charCodeAt(0))),
    });
    const {renderer} = await renderScreen(client);
    await press(renderer, 'firmware-source-local');
    await press(renderer, 'pick-local-firmware');
    expect(allText(renderer)).toContain('حجم ملف Firmware لا يطابق بياناته المستلمة');
    expect(allText(renderer)).not.toContain('HEX • truncated.hex');
    act(() => renderer.unmount());
  });

  it('keeps read-unprotect disabled until explicit erase consent, then uses the selected DFU device once', async () => {
    const client = fakeClient();
    client.listDfuDevices.mockResolvedValue([{
      deviceId: 17,
      vendorId: 0x0483,
      productId: 0xdf11,
      interfaceNumber: 0,
      alternateSetting: 0,
      productName: 'STM32 BOOTLOADER',
    }]);
    const {renderer} = await renderScreen(client);
    await press(renderer, 'firmware-source-local');
    await press(renderer, 'pick-local-firmware');
    await press(renderer, 'toggle-advanced-usb-recovery');

    expect(renderer.root.findByProps({testID: 'unprotect-dfu-device'}).props.disabled).toBe(true);
    await act(async () => {
      renderer.root.findByProps({testID: 'confirm-dfu-read-unprotect'}).props.onValueChange(true);
      await Promise.resolve();
    });
    expect(renderer.root.findByProps({testID: 'unprotect-dfu-device'}).props.disabled).toBe(false);
    await press(renderer, 'unprotect-dfu-device');
    expect(client.unprotectDfuDevice).toHaveBeenCalledTimes(1);
    expect(client.unprotectDfuDevice).toHaveBeenCalledWith(17);
    expect(allText(renderer)).toContain('أزيلت Read Protection');
    act(() => renderer.unmount());
  });

  it('keeps every help and build-log action inside FPV-ARBCON and lazy-loads the flasher outside the Motors startup graph', () => {
    const screenSource = readFileSync(join(__dirname, 'FirmwareFlasherScreen.tsx'), 'utf8');
    const appSource = readFileSync(join(__dirname, '../../../App.tsx'), 'utf8');
    expect(screenSource).not.toMatch(/\bLinking\b|openURL|betaflight\.com\/docs|github\.com\/betaflight/);
    expect(screenSource).toContain("navigation?.addListener('beforeRemove'");
    expect(screenSource).toContain('client.cancelDfuFlash().catch');
    expect(appSource).not.toMatch(/import\s*\{[^}]*FirmwareFlasherScreen/s);
    expect(appSource).toContain('<Stack.Screen name="FirmwareFlasher" getComponent={getFirmwareFlasherScreen} />');
  });
});
