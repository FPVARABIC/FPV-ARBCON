jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

import React from 'react';
import {Text} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';

import type {BetaflightTarget} from '../../core/firmware-flasher';
import {bytesToBase64} from '../../platforms/react-native/protocol/base64';
import type {UsbSerialTransportClient} from '../../platforms/react-native/transport';
import type {DfuDeviceDescriptor} from '../../platforms/react-native/transport/native/NativeUsbSerialTransport';
import FirmwareFlasherScreen from './FirmwareFlasherScreen';

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

describe('FirmwareFlasherScreen', () => {
  it('loads a local HEX after active interactions, validates it and selects the DFU path', async () => {
    const {renderer, client} = await renderScreen();
    await press(renderer, 'firmware-source-local');
    await press(renderer, 'pick-local-firmware');
    expect(client.pickFirmwareFile).toHaveBeenCalledTimes(1);
    expect(allText(renderer)).toContain('HEX • verified.hex');
    expect(allText(renderer)).toContain('STM32 DFU (DfuSe)');
    expect(allText(renderer)).toContain('بوابة الأمان');
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
    const search = renderer.root.findAllByProps({testID: 'target-search'})[0];
    await act(async () => {
      search.props.onFocus();
      await Promise.resolve();
    });
    const mountedTargetRows = renderer.root.findAll(node =>
      typeof node.props.testID === 'string' && node.props.testID.startsWith('target-'),
    );
    expect(mountedTargetRows.length).toBeGreaterThan(0);
    expect(mountedTargetRows.length).toBeLessThan(2000);
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
});
