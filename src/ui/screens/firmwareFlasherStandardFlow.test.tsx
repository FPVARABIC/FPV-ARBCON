/**
 * THE STANDARD FLASHER FLOW - capability restored, safety kept.
 *
 * The product question these tests answer is the one the rework was
 * commissioned for: can a normal Betaflight user build the same
 * meaningful firmware configuration in the standard Arabic flow, without
 * dropping into the legacy engineering screen? Every category the
 * selected release exposes must be rendered FROM the official options
 * document, every visible choice must reach the official build request,
 * the board must still be identified and verified, and software entry
 * into DFU must be offered when - and only when - the firmware supports
 * it.
 *
 * Nothing here asserts a hardcoded protocol list: the fixtures are the
 * API's own shape, and the screen renders whatever they contain.
 */

jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

import React from 'react';
import {Text} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';
import '../../i18n';

import {
  BetaflightBuildApi,
  betaflightBuildApi,
} from '../../core/firmware-flasher/buildApi';
import {CloudBuildCoordinator} from '../../core/firmware-flasher/cloudBuildCoordinator';
import type {CloudBuildResult} from '../../core/firmware-flasher/cloudBuildCoordinator';
import {
  DfuPermissionRequiredError,
  FirmwareBootloaderController,
} from '../../platforms/react-native/protocol/FirmwareBootloaderController';
import type {UsbSerialTransportClient} from '../../platforms/react-native/transport';
import FirmwareFlasherSimpleScreen from './FirmwareFlasherSimpleScreen';

/* ------------------------------------------------------------------ *
 * Official-shaped fixtures
 * ------------------------------------------------------------------ */

const TARGETS = [
  {target: 'KAKUTEH7', group: 'supported', manufacturer: 'HBRO', mcu: 'STM32H743'},
  {target: 'SPEEDYBEEF405V3', group: 'supported', manufacturer: 'SPBE', mcu: 'STM32F405'},
  {target: 'MATEKH743', group: 'supported', manufacturer: 'MTKS', mcu: 'STM32H743'},
  {target: 'ZZZ_UNLISTED_VENDOR_F722', group: 'unsupported', manufacturer: 'ZZZQ', mcu: 'STM32F722'},
];

const RELEASES = {
  releases: [
    {release: '4.6.0', label: '2026-06-01', type: 'Stable'},
    {release: '4.5.1', label: '2026-01-01', type: 'Stable'},
    {release: '4.7.0-RC1', label: '2026-07-01', type: 'ReleaseCandidate'},
    {release: '4.8.0-dev', label: '2026-08-01', type: 'Unstable'},
  ],
};

const OPTIONS = {
  radioProtocols: [
    {name: 'CRSF', value: 'RX_CRSF', default: true, includesTelemetry: true},
    {name: 'SBUS', value: 'RX_SBUS'},
  ],
  telemetryProtocols: [
    {name: '[None]', value: '', default: true},
    {name: 'SmartPort', value: 'TELEMETRY_SMARTPORT'},
  ],
  motorProtocols: [
    {name: 'DShot', value: 'USE_DSHOT', default: true},
    {name: 'Multishot', value: 'USE_MULTISHOT'},
  ],
  generalOptions: [
    {name: 'OSD', groupedName: 'MSP DisplayPort', value: 'OSD_HD', group: 'OSD', default: true},
    {name: 'OSD', groupedName: 'Analogue', value: 'OSD_SD_MAX7456', group: 'OSD'},
    {name: 'GPS', value: 'USE_GPS'},
    {name: 'LED Strip', value: 'USE_LED_STRIP', default: true},
  ],
};

const BUILD_DETAIL = {
  target: 'KAKUTEH7',
  release: '4.6.0',
  releaseType: 'Stable',
  cloudBuild: true,
  manufacturer: 'HBRO',
  mcu: 'STM32H743',
};

const HEX = ':020000040800F2\n:0400000001020304F2\n:00000001FF\n';

const SERIAL_DEVICE = {
  deviceId: 41,
  vendorId: 0x0483,
  productId: 0x5740,
  productName: 'Flight Controller',
  manufacturerName: 'FPV',
  driverType: 'CDC_ACM',
  portCount: 1,
} as const;

const DFU_DESCRIPTOR = {
  deviceId: 1_000_000,
  vendorId: 0x0483,
  productId: 0xdf11,
  interfaceNumber: 0,
  alternateSetting: 0,
  memoryLayout: '@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg',
} as const;

/** Serves the official endpoints from the fixtures above. */
function installBuildApi(overrides: Partial<Record<string, unknown>> = {}) {
  const requested: string[] = [];
  const impl: typeof fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    const body = (() => {
      if (url.endsWith('/api/targets')) return overrides.targets ?? TARGETS;
      if (url.includes('/api/targets/')) return overrides.releases ?? RELEASES;
      if (url.includes('/api/options/')) {
        if (overrides.optionsFail === true) throw new Error('options unavailable');
        return overrides.options ?? OPTIONS;
      }
      if (url.includes('/api/builds/')) return overrides.detail ?? BUILD_DETAIL;
      return {};
    })();
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {'content-type': 'application/json'},
    });
  }) as typeof fetch;
  const api = new BetaflightBuildApi(impl);
  // Forwarded one method at a time, with their real signatures: a loop
  // over method names cannot be typed here (the union of parameter
  // tuples collapses to never), and an untyped loop would hide a real
  // signature drift instead of failing the build.
  jest
    .spyOn(betaflightBuildApi, 'loadTargets')
    .mockImplementation(signal => api.loadTargets(signal));
  jest
    .spyOn(betaflightBuildApi, 'loadTargetReleases')
    .mockImplementation((target, signal) => api.loadTargetReleases(target, signal));
  jest
    .spyOn(betaflightBuildApi, 'loadBuild')
    .mockImplementation((target, release, signal) => api.loadBuild(target, release, signal));
  jest
    .spyOn(betaflightBuildApi, 'loadOptions')
    .mockImplementation((release, signal) => api.loadOptions(release, signal));
  return {requested};
}

function fakeClient(over: Record<string, unknown> = {}) {
  return {
    listDevices: jest.fn(async () => [SERIAL_DEVICE]),
    listDfuDevices: jest.fn(async () => []),
    supportsDevicePicker: jest.fn(() => false),
    supportsDfuDevicePicker: jest.fn(() => false),
    requestDevicePermission: jest.fn(async () => null),
    requestDfuDevicePermission: jest.fn(async () => DFU_DESCRIPTOR),
    onDfuFlashProgress: jest.fn(() => jest.fn()),
    cancelDfuFlash: jest.fn(async () => undefined),
    flashDfuFirmware: jest.fn(async () => undefined),
    ...over,
  };
}

type Renderer = ReactTestRenderer.ReactTestRenderer;

function node(renderer: Renderer, testID: string) {
  return renderer.root
    .findAllByProps({testID})
    .find(item => typeof item.props.onPress === 'function' || typeof item.props.onChangeText === 'function');
}

function press(renderer: Renderer, testID: string): Promise<void> {
  const target = node(renderer, testID);
  if (!target) throw new Error(`Missing pressable ${testID}`);
  return act(async () => {
    await target.props.onPress();
    await Promise.resolve();
  });
}

function exists(renderer: Renderer, testID: string): boolean {
  return renderer.root.findAllByProps({testID}).length > 0;
}

function screenText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(item => {
      const value = item.props.children;
      return Array.isArray(value) ? value.join('') : String(value ?? '');
    })
    .join('\n');
}

async function flush(rounds = 14): Promise<void> {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) {
      await Promise.resolve();
    }
  });
}

async function renderScreen(client = fakeClient()) {
  let renderer!: Renderer;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <FirmwareFlasherSimpleScreen client={client as unknown as UsbSerialTransportClient} />,
    );
    await Promise.resolve();
  });
  await flush();
  return {renderer, client};
}

/** Board -> version -> options loaded, the normal starting position. */
async function selectKakuteH7(renderer: Renderer): Promise<void> {
  await press(renderer, 'simple-target-selector');
  await press(renderer, 'simple-target-KAKUTEH7');
  await flush(20);
}

function mockDetectedBoard(over: {target?: string; family?: string} = {}) {
  const release = jest.fn(async () => undefined);
  const rebootToBootloader = jest.fn(async () => 1 as const);
  const target = over.target ?? 'KAKUTEH7';
  jest
    .spyOn(FirmwareBootloaderController.prototype, 'detectFlightController')
    .mockResolvedValue({
      device: SERIAL_DEVICE,
      identity: {
        firmware: {knownFamily: over.family ?? 'BETAFLIGHT'},
        board: {targetName: target, boardName: target, boardIdentifier: target},
      },
      targetMatches: (selected: string) =>
        selected.trim().length === 0 || selected.toUpperCase() === target.toUpperCase(),
      rebootToBootloader,
      release,
    } as never);
  return {release, rebootToBootloader};
}

beforeEach(() => {
  installBuildApi();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the whole official catalogue is reachable from the standard screen', () => {
  it('lists every vendor family the API returned, including an unlisted one', async () => {
    const {renderer} = await renderScreen();
    await press(renderer, 'simple-target-selector');

    for (const target of TARGETS) {
      expect(exists(renderer, `simple-target-${target.target}`)).toBe(true);
    }
    act(() => renderer.unmount());
  });
});

describe('build configuration is rendered from the official options document', () => {
  it('shows every category the release exposes, with the API defaults chosen', async () => {
    const {renderer} = await renderScreen();
    await selectKakuteH7(renderer);

    expect(exists(renderer, 'simple-build-configuration')).toBe(true);
    for (const category of ['radio', 'telemetry', 'osd', 'motor', 'general']) {
      expect(exists(renderer, `simple-build-${category}-group`)).toBe(true);
    }
    const text = screenText(renderer);
    // The official default radio protocol and its telemetry consequence.
    expect(text).toContain('CRSF');
    expect(text).toContain('مضمّن تلقائياً مع بروتوكول الراديو');
    // OSD arrives inside generalOptions with group OSD and a grouped name.
    expect(text).toContain('MSP DisplayPort');
    expect(text).toContain('DShot');
    act(() => renderer.unmount());
  });

  it('renders the exact option values the API returned - no invented protocol', async () => {
    const {renderer} = await renderScreen();
    await selectKakuteH7(renderer);
    await press(renderer, 'simple-build-radio-selector');

    expect(exists(renderer, 'simple-build-radio-option-RX_CRSF')).toBe(true);
    expect(exists(renderer, 'simple-build-radio-option-RX_SBUS')).toBe(true);
    // A protocol the release never returned must not exist on screen.
    expect(exists(renderer, 'simple-build-radio-option-RX_IBUS')).toBe(false);
    act(() => renderer.unmount());
  });

  it('omits a category the release does not expose at all', async () => {
    jest.restoreAllMocks();
    installBuildApi({options: {...OPTIONS, motorProtocols: []}});
    const {renderer} = await renderScreen();
    await selectKakuteH7(renderer);

    expect(exists(renderer, 'simple-build-radio-group')).toBe(true);
    expect(exists(renderer, 'simple-build-motor-group')).toBe(false);
    act(() => renderer.unmount());
  });

  it('falls back to an honest core build when the options document fails', async () => {
    jest.restoreAllMocks();
    installBuildApi({optionsFail: true});
    const {renderer} = await renderScreen();
    await selectKakuteH7(renderer);

    expect(exists(renderer, 'simple-build-options-error')).toBe(true);
    expect(exists(renderer, 'simple-build-radio-group')).toBe(false);
    act(() => renderer.unmount());
  });

  it('offers Custom Defines inside the standard flow', async () => {
    const {renderer} = await renderScreen();
    await selectKakuteH7(renderer);
    expect(exists(renderer, 'simple-custom-defines-toggle')).toBe(true);
    await press(renderer, 'simple-custom-defines-toggle');
    expect(exists(renderer, 'simple-custom-defines')).toBe(true);
    act(() => renderer.unmount());
  });
});

describe('every visible selection reaches the official build request', () => {
  async function prepareAndCaptureRequest(
    mutate?: (renderer: Renderer) => Promise<void>,
  ): Promise<Record<string, unknown>> {
    const captured: Record<string, unknown>[] = [];
    jest
      .spyOn(CloudBuildCoordinator.prototype, 'buildAndDownload')
      .mockImplementation(async (request): Promise<CloudBuildResult> => {
        captured.push(request as unknown as Record<string, unknown>);
        return {
          response: {file: 'betaflight_4.6.0_KAKUTEH7.hex', url: '/x.hex'},
          firmware: Uint8Array.from(HEX, character => character.charCodeAt(0)),
        };
      });
    const {renderer} = await renderScreen();
    await selectKakuteH7(renderer);
    if (mutate) await mutate(renderer);
    await press(renderer, 'simple-load-firmware');
    await flush(20);
    act(() => renderer.unmount());
    expect(captured).toHaveLength(1);
    return captured[0];
  }

  it('sends the official defaults as a CLOUD_BUILD with the API values', async () => {
    const request = await prepareAndCaptureRequest();
    expect(request.target).toBe('KAKUTEH7');
    expect(request.release).toBe('4.6.0');
    expect(request.options).toEqual([
      'CLOUD_BUILD',
      'RX_CRSF',
      'OSD_HD',
      'USE_DSHOT',
      'USE_LED_STRIP',
    ]);
  });

  it('a changed protocol changes the payload - the control is not decorative', async () => {
    const request = await prepareAndCaptureRequest(async renderer => {
      await press(renderer, 'simple-build-radio-selector');
      await press(renderer, 'simple-build-radio-option-RX_SBUS');
      await press(renderer, 'simple-build-motor-selector');
      await press(renderer, 'simple-build-motor-option-USE_MULTISHOT');
    });
    const options = request.options as string[];
    expect(options).toContain('RX_SBUS');
    expect(options).toContain('USE_MULTISHOT');
    expect(options).not.toContain('RX_CRSF');
    expect(options).not.toContain('USE_DSHOT');
  });

  it('a toggled other-option changes the payload', async () => {
    const request = await prepareAndCaptureRequest(async renderer => {
      await press(renderer, 'simple-build-general-selector');
      await press(renderer, 'simple-build-general-option-USE_GPS');
    });
    expect(request.options as string[]).toContain('USE_GPS');
  });

  it('custom defines typed in the standard flow reach the request', async () => {
    const request = await prepareAndCaptureRequest(async renderer => {
      await press(renderer, 'simple-custom-defines-toggle');
      const input = node(renderer, 'simple-custom-defines');
      await act(async () => {
        input!.props.onChangeText('USE_CUSTOM_THING');
        await Promise.resolve();
      });
    });
    expect(request.options as string[]).toContain('USE_CUSTOM_THING');
  });
});

describe('versions: stable by default, other channels reachable', () => {
  it('starts on the newest stable release and offers the other channels', async () => {
    const {renderer} = await renderScreen();
    await selectKakuteH7(renderer);

    expect(exists(renderer, 'simple-release-4.6.0')).toBe(true);
    // Release candidates and development builds are not shown by default.
    expect(exists(renderer, 'simple-release-4.7.0-RC1')).toBe(false);
    expect(exists(renderer, 'simple-channel-toggle')).toBe(true);

    await press(renderer, 'simple-channel-toggle');
    await press(renderer, 'simple-channel-candidate');
    await flush();
    expect(exists(renderer, 'simple-release-4.7.0-RC1')).toBe(true);
    act(() => renderer.unmount());
  });

  it('says so truthfully when a target publishes no stable release', async () => {
    jest.restoreAllMocks();
    installBuildApi({
      releases: {releases: [{release: '4.8.0-dev', label: 'x', type: 'Unstable'}]},
    });
    const {renderer} = await renderScreen();
    await selectKakuteH7(renderer);

    expect(exists(renderer, 'simple-no-stable')).toBe(true);
    expect(screenText(renderer)).toContain('لا يوجد إصدار مستقر');
    act(() => renderer.unmount());
  });
});

describe('board identity: detected, matched, and verified before flashing', () => {
  it('identifies the connected board and preselects its catalogue target', async () => {
    mockDetectedBoard({target: 'MATEKH743'});
    const {renderer} = await renderScreen();

    await press(renderer, 'simple-auto-detect');
    await flush(20);

    expect(screenText(renderer)).toContain('تم التعرف على اللوحة MATEKH743');
    expect(exists(renderer, 'simple-detected-target')).toBe(true);
    act(() => renderer.unmount());
  });

  it('keeps manual selection usable when the identity is not a catalogue target', async () => {
    mockDetectedBoard({target: 'NOT_IN_CATALOGUE_BOARD'});
    const {renderer} = await renderScreen();

    await press(renderer, 'simple-auto-detect');
    await flush(20);

    const text = screenText(renderer);
    expect(text).toContain('NOT_IN_CATALOGUE_BOARD');
    // The outcome must be READABLE while the screen sits idle - the
    // progress line only exists during an operation.
    expect(exists(renderer, 'simple-detection-note')).toBe(true);
    expect(text).toContain('اختر Target يدويًا');
    expect(exists(renderer, 'simple-target-selector')).toBe(true);
    act(() => renderer.unmount());
  });

  it('BLOCKS the flash when the connected board is a different target', async () => {
    const {rebootToBootloader} = mockDetectedBoard({target: 'SPEEDYBEEF405V3'});
    jest
      .spyOn(CloudBuildCoordinator.prototype, 'buildAndDownload')
      .mockResolvedValue({
        response: {file: 'betaflight_4.6.0_KAKUTEH7.hex', url: '/x.hex'},
        firmware: Uint8Array.from(HEX, character => character.charCodeAt(0)),
      });
    const {renderer, client} = await renderScreen();
    await selectKakuteH7(renderer);
    await press(renderer, 'simple-load-firmware');
    await flush(20);

    // Flash without the confirmation dialog: the guard lives in the flow.
    await press(renderer, 'simple-flash-firmware');
    await flush(20);

    expect(client.flashDfuFirmware).not.toHaveBeenCalled();
    expect(rebootToBootloader).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });
});

describe('entering DFU is offered - and honest when it cannot work', () => {
  it('reboots a Betaflight board into DFU from a single press', async () => {
    const {rebootToBootloader} = mockDetectedBoard();
    jest
      .spyOn(FirmwareBootloaderController.prototype, 'waitForOneDfuDevice')
      .mockResolvedValue(DFU_DESCRIPTOR as never);
    const {renderer} = await renderScreen();
    await selectKakuteH7(renderer);

    await press(renderer, 'simple-enter-dfu');
    await flush(20);

    expect(rebootToBootloader).toHaveBeenCalledTimes(1);
    expect(exists(renderer, 'simple-dfu-ready')).toBe(true);
    expect(screenText(renderer)).toContain('وضع DFU');
    act(() => renderer.unmount());
  });

  it('falls back to a short manual instruction when the firmware cannot reboot itself', async () => {
    const {rebootToBootloader} = mockDetectedBoard({family: 'INAV'});
    const {renderer} = await renderScreen();
    await selectKakuteH7(renderer);

    await press(renderer, 'simple-enter-dfu');
    await flush(20);

    expect(rebootToBootloader).not.toHaveBeenCalled();
    expect(exists(renderer, 'simple-manual-dfu')).toBe(true);
    expect(screenText(renderer)).toContain('ادخل وضع DFU يدويًا');
    act(() => renderer.unmount());
  });

  it('asks for the browser DFU permission only when the board is already in DFU', async () => {
    mockDetectedBoard();
    jest
      .spyOn(FirmwareBootloaderController.prototype, 'waitForOneDfuDevice')
      .mockRejectedValue(new DfuPermissionRequiredError());
    const client = fakeClient({supportsDevicePicker: jest.fn(() => true)});
    const {renderer} = await renderScreen(client);
    await selectKakuteH7(renderer);

    await press(renderer, 'simple-enter-dfu');
    await flush(20);

    expect(exists(renderer, 'simple-manual-dfu')).toBe(true);
    expect(screenText(renderer)).toContain('للسماح للمتصفح');
    // One chooser, offered once, from a real press.
    expect(client.requestDfuDevicePermission).not.toHaveBeenCalled();
    await press(renderer, 'simple-choose-dfu-device');
    await flush();
    expect(client.requestDfuDevicePermission).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('does not show the manual BOOT-button instruction before anything failed', async () => {
    const {renderer} = await renderScreen();
    await selectKakuteH7(renderer);

    expect(exists(renderer, 'simple-manual-dfu')).toBe(false);
    expect(screenText(renderer)).not.toContain('ادخل وضع DFU يدويًا');
    act(() => renderer.unmount());
  });
});

describe('the standard screen is usable without opening Advanced', () => {
  it('carries the whole flow: board, version, configuration, prepare, flash', async () => {
    const {renderer} = await renderScreen();
    await selectKakuteH7(renderer);

    for (const id of [
      'simple-target-selector',
      'simple-build-configuration',
      'simple-load-firmware',
      'simple-enter-dfu',
      'simple-flash-firmware',
    ]) {
      expect(exists(renderer, id)).toBe(true);
    }
    // Advanced exists, but as a secondary link only.
    expect(exists(renderer, 'flasher-advanced-mode')).toBe(true);
    act(() => renderer.unmount());
  });

  it('keeps specialist controls OUT of the standard surface', async () => {
    const {renderer} = await renderScreen();
    await selectKakuteH7(renderer);

    for (const id of [
      'confirm-props-removed',
      'confirm-usb-power-only',
      'toggle-advanced-flash-options',
      'toggle-advanced-usb-recovery',
      'unprotect-dfu-device',
      'pick-local-firmware',
    ]) {
      expect(exists(renderer, id)).toBe(false);
    }
    act(() => renderer.unmount());
  });

  it('shows no wall of warnings before the operator has done anything', async () => {
    const {renderer} = await renderScreen();
    const text = screenText(renderer);
    expect(text).not.toContain('تحذير');
    expect(text).not.toContain('ادخل وضع DFU يدويًا');
    expect(exists(renderer, 'simple-manual-dfu')).toBe(false);
    act(() => renderer.unmount());
  });
});
