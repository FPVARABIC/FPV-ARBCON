/**
 * FLASH TRUTH, TARGET RULES AND ACTION HIERARCHY.
 *
 * A real Pavo/BetaFPV F405 was flashed and byte-for-byte verified, and
 * the product told the operator the board had not restarted and that
 * they should unplug it. Two separate defects met there: the engine let
 * an unobserved reset rewrite a proven write, and the screen presented
 * every failure - including a catalogue download that never touched the
 * board - under «فشل التفليش».
 *
 * This suite pins the corrected product contract:
 *
 *  - the destructive verdict belongs to the destructive operation ALONE;
 *  - an unreadable identity in DFU is a WARNING, never a gate (UNKNOWN
 *    is not MISMATCH), while a READ identity that disagrees still blocks;
 *  - a reset that was not observed still leaves a successful flash;
 *  - the one irreversible action looks irreversible, and the supporting
 *    actions are not full-width slabs competing with it.
 */

jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

import React from 'react';
import {Alert, Text} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';
import '../../i18n';

import {betaflightBuildApi, CloudBuildCoordinator} from '../../core/firmware-flasher';
import {FirmwareBootloaderController} from '../../platforms/react-native/protocol/FirmwareBootloaderController';
import type {UsbSerialTransportClient} from '../../platforms/react-native/transport';
import type {
  DfuDeviceDescriptor,
  UsbSerialDeviceDescriptor,
} from '../../platforms/react-native/transport';
import type {DfuFlashProgressEvent} from '../../platforms/react-native/transport/native/NativeUsbSerialTransport';
import FirmwareFlasherSimpleScreen, {PROBLEM_TITLES} from './FirmwareFlasherSimpleScreen';

const VALID_HEX = ':020000040800F2\n:0400000001020304F2\n:00000001FF\n';
const HEX_BYTES = Uint8Array.from(VALID_HEX, character => character.charCodeAt(0));
const F4_LAYOUT = '@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg';
const FLASH_FAILED_TITLE = 'فشل التفليش';

const SERIAL_A: UsbSerialDeviceDescriptor = {
  deviceId: 41,
  vendorId: 0x0483,
  productId: 0x5740,
  productName: 'FC (normal mode)',
  manufacturerName: 'Vendor',
  driverType: 'CDC_ACM',
  portCount: 1,
};

const DFU_B: DfuDeviceDescriptor = {
  deviceId: 1_000_001,
  vendorId: 0x0483,
  productId: 0xdf11,
  productName: 'STM32 BOOTLOADER',
  manufacturerName: 'STMicroelectronics',
  interfaceNumber: 0,
  alternateSetting: 0,
  memoryLayout: F4_LAYOUT,
};

const IDENTITY = {
  firmware: {knownFamily: 'BETAFLIGHT'},
  board: {
    targetName: 'TARGETA',
    boardName: 'TARGETA',
    boardIdentifier: 'TGTA',
    targetCapabilities: 0,
  },
} as const;

type Scripted = ReturnType<typeof scriptedClient>;

function scriptedClient() {
  const state = {
    serial: [SERIAL_A] as UsbSerialDeviceDescriptor[],
    dfu: [] as DfuDeviceDescriptor[],
  };
  let progressListener: ((event: DfuFlashProgressEvent) => void) | undefined;
  return {
    get serial(): UsbSerialDeviceDescriptor[] {
      return state.serial;
    },
    set serial(value: UsbSerialDeviceDescriptor[]) {
      state.serial = value;
    },
    get dfu(): DfuDeviceDescriptor[] {
      return state.dfu;
    },
    set dfu(value: DfuDeviceDescriptor[]) {
      state.dfu = value;
    },
    supportsDevicePicker: jest.fn(() => true),
    requestDevicePermission: jest.fn(async () => null),
    listDevices: jest.fn(async () => [...state.serial]),
    listDfuDevices: jest.fn(async () => [...state.dfu]),
    onDeviceAttached: jest.fn(() => jest.fn()),
    onDeviceDetached: jest.fn(() => jest.fn()),
    onSessionDetached: jest.fn(() => jest.fn()),
    onDfuFlashProgress: jest.fn((callback: (event: DfuFlashProgressEvent) => void) => {
      progressListener = callback;
      return jest.fn();
    }),
    flashDfuFirmware: jest.fn(
      async (_deviceId: number, _hexBase64: string, _fullErase: boolean): Promise<void> => undefined,
    ),
    cancelDfuFlash: jest.fn(async () => undefined),
    requestDfuDevicePermission: jest.fn(async (): Promise<DfuDeviceDescriptor | null> => DFU_B),
    emitDfuProgress: (event: DfuFlashProgressEvent) => progressListener?.(event),
  };
}

function installBuildApiFixtures() {
  jest.spyOn(betaflightBuildApi, 'loadTargets').mockResolvedValue([
    {target: 'TARGETA', manufacturer: 'Vendor', mcu: 'STM32F405'},
    {target: 'TARGETB', manufacturer: 'Vendor', mcu: 'STM32F405'},
  ] as never);
  jest.spyOn(betaflightBuildApi, 'loadTargetReleases').mockResolvedValue({
    releases: [{release: '4.5.2', type: 'stable'}],
  });
  // Target-agnostic: the detail document always describes whichever
  // target was asked for, so a test may select either board.
  jest
    .spyOn(betaflightBuildApi, 'loadBuild')
    .mockImplementation(async (target: string, release: string) => ({
      target,
      release,
      releaseType: 'stable',
      cloudBuild: true,
    }) as never);
  jest.spyOn(betaflightBuildApi, 'loadOptions').mockResolvedValue({
    generalOptions: [],
    radioProtocols: [],
    telemetryProtocols: [],
    motorProtocols: [],
  });
}

function installCloudBuild() {
  return jest
    .spyOn(CloudBuildCoordinator.prototype, 'buildAndDownload')
    .mockImplementation(async () => ({
      response: {file: 'betaflight_4.5.2_TARGETA.hex', url: 'https://build/x.hex'},
      firmware: HEX_BYTES,
      configuration: null,
    }) as never);
}

function installDetector(identity: typeof IDENTITY = IDENTITY) {
  const rebootToBootloader = jest.fn(async () => 1 as const);
  const release = jest.fn(async () => undefined);
  jest
    .spyOn(FirmwareBootloaderController.prototype, 'detectFlightController')
    .mockImplementation(async () => ({
      device: SERIAL_A,
      sessionId: 'session-a',
      identity,
      targetMatches: (selected: string) =>
        [identity.board.targetName, identity.board.boardName, identity.board.boardIdentifier]
          .map(value => value.toUpperCase())
          .includes(selected.trim().toUpperCase()),
      rebootToBootloader,
      release,
    }) as never);
  return {rebootToBootloader, release};
}

function installAutoConfirm() {
  return jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
    buttons?.find(button => button.style === 'destructive')?.onPress?.();
  });
}

type Renderer = ReactTestRenderer.ReactTestRenderer;

function press(renderer: Renderer, testID: string): Promise<void> {
  const node = renderer.root
    .findAllByProps({testID})
    .find(item => typeof item.props.onPress === 'function');
  if (!node) throw new Error(`Missing pressable ${testID}`);
  return act(async () => {
    await node.props.onPress();
    await Promise.resolve();
  });
}

function has(renderer: Renderer, testID: string): boolean {
  return renderer.root.findAllByProps({testID}).length > 0;
}

function screenText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => {
      const value = node.props.children;
      return Array.isArray(value) ? value.join('') : String(value ?? '');
    })
    .join('\n');
}

/** The rendered style of a control, flattened across arrays. */
function styleOf(renderer: Renderer, testID: string): Record<string, unknown> {
  const node = renderer.root
    .findAllByProps({testID})
    .find(item => item.props.style !== undefined && typeof item.type !== 'string');
  if (!node) throw new Error(`Missing control ${testID}`);
  const raw =
    typeof node.props.style === 'function'
      ? node.props.style({pressed: false})
      : node.props.style;
  const flatten = (value: unknown): Record<string, unknown> => {
    if (Array.isArray(value)) {
      return value.reduce<Record<string, unknown>>(
        (accumulator, item) => ({...accumulator, ...flatten(item)}),
        {},
      );
    }
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  };
  return flatten(raw);
}

function isDisabled(renderer: Renderer, testID: string): boolean {
  const node = renderer.root
    .findAllByProps({testID})
    .find(item => typeof item.props.onPress === 'function');
  return node?.props.disabled === true;
}

async function flush(rounds = 16): Promise<void> {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) {
      await Promise.resolve();
    }
  });
}

async function renderScreen(client: Scripted) {
  let renderer!: Renderer;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <FirmwareFlasherSimpleScreen client={client as unknown as UsbSerialTransportClient} />,
    );
    await Promise.resolve();
  });
  await flush();
  return renderer;
}

async function selectTarget(renderer: Renderer, target = 'TARGETA'): Promise<void> {
  await press(renderer, 'simple-target-selector');
  await press(renderer, `simple-target-${target}`);
  await flush();
}

async function prepareFirmware(renderer: Renderer): Promise<void> {
  await press(renderer, 'simple-load-firmware');
  await flush();
}

const trackedRenderers: Renderer[] = [];

afterEach(() => {
  trackedRenderers.splice(0).forEach(renderer => {
    act(() => {
      renderer.unmount();
    });
  });
  jest.restoreAllMocks();
});

/* ================================================================== *
 * ERROR TRUTH - only the flash may report a flash failure.
 * ================================================================== */

describe('a failure before any destructive command is never «فشل التفليش»', () => {
  it('a catalogue download failure names the catalogue, not the flash', async () => {
    jest
      .spyOn(betaflightBuildApi, 'loadTargets')
      .mockRejectedValue(new Error('network down'));
    const client = scriptedClient();

    const renderer = await renderScreen(client);
    trackedRenderers.push(renderer);

    const text = screenText(renderer);
    expect(text).toContain(PROBLEM_TITLES.CATALOGUE);
    expect(text).not.toContain(FLASH_FAILED_TITLE);
    expect(has(renderer, 'simple-problem-notice')).toBe(true);
    expect(client.flashDfuFirmware).not.toHaveBeenCalled();
  });

  it('a USB permission failure names the connection, not the flash', async () => {
    installBuildApiFixtures();
    const client = scriptedClient();
    client.requestDevicePermission.mockRejectedValue(new Error('permission denied'));

    const renderer = await renderScreen(client);
    trackedRenderers.push(renderer);
    await press(renderer, 'simple-choose-serial');
    await flush();

    const text = screenText(renderer);
    expect(text).toContain(PROBLEM_TITLES.SERIAL);
    expect(text).not.toContain(FLASH_FAILED_TITLE);
  });

  it('a firmware preparation failure names the preparation, not the flash', async () => {
    installBuildApiFixtures();
    jest
      .spyOn(CloudBuildCoordinator.prototype, 'buildAndDownload')
      .mockRejectedValue(new Error('build queue rejected the request'));
    const client = scriptedClient();

    const renderer = await renderScreen(client);
    trackedRenderers.push(renderer);
    await selectTarget(renderer);
    await prepareFirmware(renderer);

    const text = screenText(renderer);
    expect(text).toContain(PROBLEM_TITLES.PREPARE);
    expect(text).not.toContain(FLASH_FAILED_TITLE);
    expect(client.flashDfuFirmware).not.toHaveBeenCalled();
  });

  it('a DFU chooser failure names DFU access, not the flash', async () => {
    installBuildApiFixtures();
    const client = scriptedClient();
    client.requestDfuDevicePermission.mockRejectedValue(new Error('chooser exploded'));

    const renderer = await renderScreen(client);
    trackedRenderers.push(renderer);
    await press(renderer, 'simple-choose-dfu-device');
    await flush();

    const text = screenText(renderer);
    expect(text).toContain(PROBLEM_TITLES.DFU_ACCESS);
    expect(text).not.toContain(FLASH_FAILED_TITLE);
  });

  it('but a REAL engine write failure IS «فشل التفليش»', async () => {
    installBuildApiFixtures();
    installCloudBuild();
    installAutoConfirm();
    const client = scriptedClient();
    client.dfu = [DFU_B];
    client.flashDfuFirmware.mockRejectedValue(
      Object.assign(new Error('DFU download transfer failed or was incomplete.'), {
        code: 'DFU_TRANSFER_FAILED',
      }),
    );

    const renderer = await renderScreen(client);
    trackedRenderers.push(renderer);
    await selectTarget(renderer);
    await prepareFirmware(renderer);
    await press(renderer, 'simple-flash-firmware');
    await flush(24);

    const text = screenText(renderer);
    expect(text).toContain(FLASH_FAILED_TITLE);
    // And in Arabic, not the engine's raw English sentence.
    expect(text).toContain('انقطع نقل البيانات مع جهاز DFU');
    expect(text).not.toContain('DFU download transfer failed');
  });
});

/* ================================================================== *
 * TARGET RULES - UNKNOWN is not MISMATCH.
 * ================================================================== */

describe('target verification', () => {
  it('UNKNOWN identity (DFU-only): warns, offers the flash, and needs no checkbox', async () => {
    installBuildApiFixtures();
    installCloudBuild();
    installAutoConfirm();
    const client = scriptedClient();
    client.serial = [];
    client.dfu = [DFU_B];

    const renderer = await renderScreen(client);
    trackedRenderers.push(renderer);
    await selectTarget(renderer);
    await prepareFirmware(renderer);

    // The gate the product owner rejected must not exist in any form.
    expect(has(renderer, 'simple-accept-unverified-dfu')).toBe(false);
    expect(screenText(renderer)).toContain('لا يمكن قراءة هويتها');
    expect(isDisabled(renderer, 'simple-flash-firmware')).toBe(false);

    await press(renderer, 'simple-flash-firmware');
    await flush(24);

    expect(client.flashDfuFirmware).toHaveBeenCalledTimes(1);
    expect(screenText(renderer)).not.toContain(FLASH_FAILED_TITLE);
  });

  it('VERIFIED_MATCH: the identity is stated and the flash runs', async () => {
    installBuildApiFixtures();
    installCloudBuild();
    installAutoConfirm();
    installDetector();
    const client = scriptedClient();
    client.dfu = [DFU_B];

    const renderer = await renderScreen(client);
    trackedRenderers.push(renderer);
    await selectTarget(renderer);
    await press(renderer, 'simple-auto-detect');
    await flush();
    await prepareFirmware(renderer);

    expect(screenText(renderer)).toContain('هويتها مطابقة');
    await press(renderer, 'simple-flash-firmware');
    await flush(24);
    expect(client.flashDfuFirmware).toHaveBeenCalledTimes(1);
  });

  it('VERIFIED_MISMATCH: a board that ANSWERED with a different identity is blocked', async () => {
    installBuildApiFixtures();
    installCloudBuild();
    installAutoConfirm();
    installDetector();
    const client = scriptedClient();
    // No DFU device: the flash must go through serial identification,
    // where the board's own answer contradicts the selection.
    client.dfu = [];

    const renderer = await renderScreen(client);
    trackedRenderers.push(renderer);
    await selectTarget(renderer, 'TARGETB');
    await prepareFirmware(renderer);
    await press(renderer, 'simple-flash-firmware');
    await flush(24);

    expect(client.flashDfuFirmware).not.toHaveBeenCalled();
    expect(screenText(renderer)).toContain('لا يطابق اللوحة');
  });
});

/* ================================================================== *
 * RESET TRUTH - reported, never allowed to rewrite the write.
 * ================================================================== */

describe('the reset observation is a second, separate truth', () => {
  async function flashWith(resetConfirmed: boolean | undefined) {
    installBuildApiFixtures();
    installCloudBuild();
    installAutoConfirm();
    const client = scriptedClient();
    client.dfu = [DFU_B];
    client.flashDfuFirmware.mockImplementation(async () => {
      client.emitDfuProgress({
        phase: 'complete',
        percent: 100,
        bytesProcessed: 4,
        totalBytes: 4,
        ...(resetConfirmed === undefined ? {} : {resetConfirmed}),
      } as DfuFlashProgressEvent);
    });

    const renderer = await renderScreen(client);
    trackedRenderers.push(renderer);
    await selectTarget(renderer);
    await prepareFirmware(renderer);
    await press(renderer, 'simple-flash-firmware');
    await flush(24);
    return {renderer, client};
  }

  it('an OBSERVED reset says the board reconnected', async () => {
    const {renderer} = await flashWith(true);
    const text = screenText(renderer);
    expect(text).toContain('تمت كتابة Firmware والتحقق منه بنجاح');
    expect(text).toContain('أعادت اللوحة الاتصال بنجاح');
    expect(text).not.toContain(FLASH_FAILED_TITLE);
  });

  it('an UNOBSERVED reset is still a success - it never claims the board came back', async () => {
    const {renderer} = await flashWith(false);
    const text = screenText(renderer);
    expect(text).toContain('تمت كتابة Firmware والتحقق منه بنجاح');
    expect(text).toContain('لم نتمكن من تأكيد عودة اللوحة');
    expect(text).not.toContain('أعادت اللوحة الاتصال بنجاح');
    expect(text).not.toContain(FLASH_FAILED_TITLE);
    expect(has(renderer, 'simple-flash-success')).toBe(true);
  });

  it('a silent engine (no reset field at all) still reports the verified success', async () => {
    const {renderer} = await flashWith(undefined);
    const text = screenText(renderer);
    expect(text).toContain('تمت كتابة Firmware والتحقق منه بنجاح');
    expect(text).not.toContain(FLASH_FAILED_TITLE);
  });

  it('the normal success path never instructs an unplug/replug', async () => {
    const {renderer} = await flashWith(true);
    const text = screenText(renderer);
    expect(text).not.toContain('افصل USB وأعد توصيله');
    expect(text).not.toContain('افصل اللوحة وأعد توصيلها');
  });
});

/* ================================================================== *
 * ACTION HIERARCHY - the irreversible action looks irreversible.
 * ================================================================== */

describe('action hierarchy', () => {
  async function readyScreen({dfuPresent = true}: {dfuPresent?: boolean} = {}) {
    installBuildApiFixtures();
    installCloudBuild();
    const client = scriptedClient();
    if (dfuPresent) client.dfu = [DFU_B];
    const renderer = await renderScreen(client);
    trackedRenderers.push(renderer);
    await selectTarget(renderer);
    await prepareFirmware(renderer);
    return renderer;
  }

  it('the flash button is the only destructive-toned control on the screen', async () => {
    // No DFU device yet, so the DFU tools are on screen beside the
    // destructive action - exactly the crowd the operator must be able
    // to tell apart at a glance.
    const renderer = await readyScreen({dfuPresent: false});
    const flash = styleOf(renderer, 'simple-flash-firmware');
    for (const testID of [
      'simple-load-firmware',
      'simple-enter-dfu',
      'simple-choose-dfu-device',
      'simple-auto-detect',
    ]) {
      expect(styleOf(renderer, testID).backgroundColor).not.toBe(flash.backgroundColor);
    }
  });

  it('prepare and flash are not pixel-identical any more', async () => {
    const renderer = await readyScreen();
    const flash = styleOf(renderer, 'simple-flash-firmware');
    const prepare = styleOf(renderer, 'simple-load-firmware');
    expect({
      background: prepare.backgroundColor,
      alignSelf: prepare.alignSelf,
    }).not.toEqual({background: flash.backgroundColor, alignSelf: flash.alignSelf});
  });

  it('supporting actions are compact, not full-width bars', async () => {
    const renderer = await readyScreen({dfuPresent: false});
    for (const testID of [
      'simple-auto-detect',
      'simple-choose-serial',
      'simple-load-firmware',
      'simple-enter-dfu',
      'simple-choose-dfu-device',
    ]) {
      expect(styleOf(renderer, testID).alignSelf).toBe('flex-start');
    }
    // The destructive action stays full width - it is the one thing the
    // step exists to do.
    //
    // It now SAYS so. This used to assert `undefined`, i.e. full width
    // inherited from the parent column's stretch - which is exactly how
    // buttons all over the app became screen-wide bars nobody intended.
    // An action that means to fill declares it, so the deliberate case
    // can be told apart from the accidental one.
    expect(styleOf(renderer, 'simple-flash-firmware').alignSelf).toBe('stretch');
  });

  it('every visible action keeps a >=44px touch target', async () => {
    const renderer = await readyScreen({dfuPresent: false});
    for (const testID of [
      'simple-auto-detect',
      'simple-choose-serial',
      'simple-load-firmware',
      'simple-enter-dfu',
      'simple-choose-dfu-device',
      'simple-flash-firmware',
    ]) {
      expect(Number(styleOf(renderer, testID).minHeight)).toBeGreaterThanOrEqual(44);
    }
  });

  it('an unsupported image kind disables the flash before any confirmation dialog', async () => {
    installBuildApiFixtures();
    installAutoConfirm();
    const alertSpy = installAutoConfirm();
    jest
      .spyOn(CloudBuildCoordinator.prototype, 'buildAndDownload')
      .mockImplementation(async () => ({
        response: {file: 'firmware.uf2', url: 'https://build/x.uf2'},
        firmware: Uint8Array.from([0x55, 0x46, 0x32, 0x0a]),
        configuration: null,
      }) as never);
    const client = scriptedClient();
    client.dfu = [DFU_B];

    const renderer = await renderScreen(client);
    trackedRenderers.push(renderer);
    await selectTarget(renderer);
    await prepareFirmware(renderer);

    expect(isDisabled(renderer, 'simple-flash-firmware')).toBe(true);
    expect(alertSpy).not.toHaveBeenCalled();
    expect(client.flashDfuFirmware).not.toHaveBeenCalled();
  });

  it('the back control is absent rather than inert when there is nowhere to go back to', async () => {
    const renderer = await readyScreen();
    expect(has(renderer, 'simple-back')).toBe(false);
  });
});
