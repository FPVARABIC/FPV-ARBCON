/**
 * THE FLASH RESULT CONTRACT, at the screen (P0-B/E/F).
 *
 * A real operator watched flashing sit near 98% forever with no result.
 * The engine now guarantees settlement; THIS suite pins what the screen
 * does with each settlement:
 *
 *  - every attempt ends with exactly ONE visible result: the SUCCESS
 *    line, the FAILED line with its real stated reason, or the
 *    UNCONFIRMED line with a safe next action - never an eternally
 *    "flashing" screen;
 *  - firmware flash and post-flash settings restore are TWO truths: a
 *    restore failure after a verified flash never becomes "فشل التفليش";
 *  - the permission-hold path claims NOTHING (it used to claim 100% +
 *    success without flashing);
 *  - the resumed flash reaches a terminal result (its await used to end
 *    in silence, leaving the operation flashing forever);
 *  - the last-resort backstop settles a silent web flash as UNCONFIRMED.
 */

jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

import React from 'react';
import {Text} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';
import '../../i18n';

import {bytesToBase64} from '../../platforms/react-native/protocol/base64';
import {
  DfuPermissionRequiredError,
  FirmwareBootloaderController,
} from '../../platforms/react-native/protocol/FirmwareBootloaderController';
import {CliBackupService} from '../../platforms/react-native/protocol/CliBackupService';
import type {UsbSerialTransportClient} from '../../platforms/react-native/transport';
import type {DfuFlashProgressEvent} from '../../platforms/react-native/transport/native/NativeUsbSerialTransport';
import FirmwareFlasherScreen from './FirmwareFlasherScreen';

const VALID_HEX = ':020000040800F2\n:0400000001020304F2\n:00000001FF\n';
const F405_LAYOUT = '@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg';

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
  productName: 'STM32 BOOTLOADER',
  manufacturerName: 'STMicroelectronics',
  interfaceNumber: 0,
  alternateSetting: 0,
  memoryLayout: F405_LAYOUT,
} as const;

function fakeClient() {
  let progressListener: ((event: DfuFlashProgressEvent) => void) | undefined;
  const client = {
    listDevices: jest.fn(async () => [SERIAL_DEVICE]),
    listDfuDevices: jest.fn(async () => []),
    pickFirmwareFile: jest.fn(async () => ({
      name: 'verified.hex',
      sizeBytes: VALID_HEX.length,
      dataBase64: bytesToBase64(Uint8Array.from(VALID_HEX, character => character.charCodeAt(0))),
    })),
    saveFirmwareFile: jest.fn(async () => true),
    onDeviceAttached: jest.fn(() => jest.fn()),
    onDeviceDetached: jest.fn(() => jest.fn()),
    onDfuFlashProgress: jest.fn((callback: (event: DfuFlashProgressEvent) => void) => {
      progressListener = callback;
      return jest.fn();
    }),
    cancelDfuFlash: jest.fn(async () => undefined),
    unprotectDfuDevice: jest.fn(async () => undefined),
    flashDfuFirmware: jest.fn(async () => undefined),
    requestDfuDevicePermission: jest.fn(async () => DFU_DESCRIPTOR),
    emitDfuProgress: (event: DfuFlashProgressEvent) => progressListener?.(event),
  };
  return client;
}

function fakeApi() {
  return {
    loadTargets: jest.fn(async () => []),
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

function toggleOn(renderer: Renderer, testID: string): Promise<void> {
  const node = renderer.root
    .findAllByProps({testID})
    .find(item => typeof item.props.onValueChange === 'function');
  if (!node) throw new Error(`Missing toggle ${testID}`);
  return act(async () => {
    node.props.onValueChange(true);
    await Promise.resolve();
  });
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

async function flush(rounds = 12): Promise<void> {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) {
      await Promise.resolve();
    }
  });
}

async function renderScreen(client = fakeClient(), api = fakeApi()) {
  let renderer!: Renderer;
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

/** Loads the local HEX and arms both safety acknowledgements. */
async function armLocalHexFlash(renderer: Renderer): Promise<void> {
  await press(renderer, 'firmware-source-local');
  await press(renderer, 'pick-local-firmware');
  await toggleOn(renderer, 'confirm-props-removed');
  await toggleOn(renderer, 'confirm-usb-power-only');
}

/** Prototype spies for the serial->DFU reboot pipeline, so a full flash
 * attempt runs against fakes with no real transport. */
function spyBootloaderPipeline() {
  const rebootToBootloader = jest.fn(async () => 1 as const);
  const release = jest.fn(async () => undefined);
  const detect = jest
    .spyOn(FirmwareBootloaderController.prototype, 'detectFlightController')
    .mockResolvedValue({
      device: SERIAL_DEVICE,
      identity: {
        firmware: {knownFamily: 'Betaflight'},
        board: {targetName: 'S405', boardName: 'S405', boardIdentifier: 'S405'},
      },
      targetMatches: () => true,
      rebootToBootloader,
      release,
    } as never);
  const waitDfu = jest
    .spyOn(FirmwareBootloaderController.prototype, 'waitForOneDfuDevice')
    .mockResolvedValue(DFU_DESCRIPTOR as never);
  const waitSerial = jest
    .spyOn(FirmwareBootloaderController.prototype, 'waitForOneSerialDevice')
    .mockResolvedValue(SERIAL_DEVICE as never);
  const capture = jest
    .spyOn(CliBackupService.prototype, 'capture')
    .mockResolvedValue('diff all\nset motor_pwm_protocol = DSHOT600\nsave\n');
  const saveBackup = jest
    .spyOn(CliBackupService.prototype, 'saveBackup')
    .mockResolvedValue(true);
  const restore = jest
    .spyOn(CliBackupService.prototype, 'restore')
    .mockResolvedValue({errors: [], commandCount: 3} as never);
  return {detect, rebootToBootloader, release, waitDfu, waitSerial, capture, saveBackup, restore};
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('the flash result contract', () => {
  it('a completed, verified flash shows the ONE success line plus the restore truth', async () => {
    const pipeline = spyBootloaderPipeline();
    const {renderer, client} = await renderScreen();
    await armLocalHexFlash(renderer);

    await press(renderer, 'start-safe-flash');
    await flush();

    expect(client.flashDfuFirmware).toHaveBeenCalledTimes(1);
    expect(renderer.root.findAllByProps({testID: 'flash-result'}).length).toBeGreaterThan(0);
    const text = screenText(renderer);
    expect(text).toContain('تمت كتابة Firmware والتحقق منه بنجاح');
    expect(text).toContain('أُعيد إرسال إعدادات CLI بعد التفليش، وأُرسل أمر save.');
    expect(pipeline.restore).toHaveBeenCalledTimes(1);
    // Terminal: a new attempt is startable again.
    expect(
      renderer.root.findByProps({testID: 'start-safe-flash'}).props.disabled,
    ).toBe(false);
    act(() => renderer.unmount());
  });

  it('TWO TRUTHS: a restore failure after a verified flash never becomes "فشل التفليش"', async () => {
    const pipeline = spyBootloaderPipeline();
    // The board never re-enumerates for the restore step.
    pipeline.waitSerial.mockRejectedValue(
      new Error('لم يظهر جهاز serial خلال المهلة.'),
    );
    const {renderer} = await renderScreen();
    await armLocalHexFlash(renderer);

    await press(renderer, 'start-safe-flash');
    await flush();

    const text = screenText(renderer);
    // The firmware truth stands...
    expect(text).toContain('تمت كتابة Firmware والتحقق منه بنجاح');
    // ...the restore truth is stated separately...
    expect(text).toContain('لكن فشلت استعادة الإعدادات');
    // ...and the failure line of the flash itself is NOT shown.
    const title = renderer.root.findByProps({testID: 'flash-result-title'});
    const titleText = Array.isArray(title.props.children)
      ? title.props.children.join('')
      : String(title.props.children);
    expect(titleText).not.toContain('فشل التفليش');
    act(() => renderer.unmount());
  });

  it('an engine UNCONFIRMED settlement shows the honest third result with a next step', async () => {
    spyBootloaderPipeline();
    const {renderer, client} = await renderScreen();
    // The client boundary rejects with a PLAIN {code, nativeMessage}
    // object - normalizeNativeError's real shape, not an Error.
    client.flashDfuFirmware.mockRejectedValue({
      code: 'DFU_COMPLETION_UNCONFIRMED_MANIFEST',
      nativeMessage: 'WebUSB GETSTATUS did not settle within its 60000ms observation window.',
    });
    await armLocalHexFlash(renderer);

    await press(renderer, 'start-safe-flash');
    await flush();

    const text = screenText(renderer);
    expect(text).toContain('تعذر تأكيد اكتمال العملية');
    expect(text).toContain('افصل USB وأعد توصيله');
    expect(text).not.toContain('تمت كتابة Firmware والتحقق منه بنجاح');
    // Terminal and restartable - not busy, not cancellable, not pending.
    expect(
      renderer.root.findByProps({testID: 'start-safe-flash'}).props.disabled,
    ).toBe(false);
    expect(renderer.root.findAllByProps({testID: 'cancel-firmware-operation'})).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('a real failure names its REAL reason - not the generic unexpected-error text', async () => {
    spyBootloaderPipeline();
    const {renderer, client} = await renderScreen();
    client.flashDfuFirmware.mockRejectedValue({
      code: 'DFU_VERIFY_FAILED',
      nativeMessage: 'DFU read-back mismatch at 0x8000010.',
    });
    await armLocalHexFlash(renderer);

    await press(renderer, 'start-safe-flash');
    await flush();

    const text = screenText(renderer);
    expect(text).toContain('فشل التفليش');
    expect(text).toContain('فشل التحقق بالقراءة الراجعة');
    expect(text).not.toContain('حدث خطأ غير متوقع في Firmware Flasher.');
    act(() => renderer.unmount());
  });

  it('the permission HOLD claims nothing: no success line, no 100%, no flash call', async () => {
    const pipeline = spyBootloaderPipeline();
    pipeline.waitDfu.mockRejectedValue(new DfuPermissionRequiredError());
    const {renderer, client} = await renderScreen();
    await armLocalHexFlash(renderer);

    await press(renderer, 'start-safe-flash');
    await flush();

    // Pre-fix, this exact state reported "اكتملت العملية بنجاح مع verify"
    // and operation success while NOTHING had been flashed.
    expect(client.flashDfuFirmware).not.toHaveBeenCalled();
    expect(renderer.root.findAllByProps({testID: 'flash-result'})).toHaveLength(0);
    const text = screenText(renderer);
    expect(text).not.toContain('تمت كتابة Firmware والتحقق منه بنجاح');
    expect(text).not.toContain('اكتمل التفليش والتحقق');
    expect(
      renderer.root.findAllByProps({testID: 'flasher-awaiting-dfu-permission'}).length,
    ).toBeGreaterThan(0);
    act(() => renderer.unmount());
  });

  it('the RESUMED flash reaches a terminal result - the orphan await is gone', async () => {
    const pipeline = spyBootloaderPipeline();
    pipeline.waitDfu.mockRejectedValue(new DfuPermissionRequiredError());
    const {renderer, client} = await renderScreen();
    await armLocalHexFlash(renderer);
    await press(renderer, 'start-safe-flash');
    await flush();
    expect(renderer.root.findAllByProps({testID: 'choose-dfu-and-continue'}).length).toBeGreaterThan(0);

    await press(renderer, 'choose-dfu-and-continue');
    await flush(20);

    // The resumed attempt flashed and CONCLUDED: success line, restore
    // truth, operation terminal. Pre-fix the await at the end of the
    // permission chain had no continuation at all.
    expect(client.flashDfuFirmware).toHaveBeenCalledTimes(1);
    const text = screenText(renderer);
    expect(text).toContain('تمت كتابة Firmware والتحقق منه بنجاح');
    expect(
      renderer.root.findByProps({testID: 'start-safe-flash'}).props.disabled,
    ).toBe(false);
    act(() => renderer.unmount());
  });

  it('the last-resort backstop settles a silent web flash as UNCONFIRMED, never success', async () => {
    spyBootloaderPipeline();
    const {renderer, client} = await renderScreen();
    client.flashDfuFirmware.mockImplementation(() => new Promise(() => {}));
    await armLocalHexFlash(renderer);

    jest.useFakeTimers();
    const start = renderer.root
      .findAllByProps({testID: 'start-safe-flash'})
      .find(item => typeof item.props.onPress === 'function');
    // Deliberately NOT awaited: this attempt never settles on its own -
    // that is the scenario. The backstop is what must end it.
    let pendingAttempt: Promise<unknown> | undefined;
    act(() => {
      pendingAttempt = start!.props.onPress() as Promise<unknown>;
    });
    expect(pendingAttempt).toBeDefined();
    await flush();
    // The engine reported web progress once (98%, verifying), then went
    // permanently silent with its transfer pending.
    act(() => {
      client.emitDfuProgress({
        phase: 'verifying',
        percent: 98,
        bytesProcessed: 2900,
        totalBytes: 3000,
      });
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(160_000);
    });

    const text = screenText(renderer);
    expect(text).toContain('تعذر تأكيد اكتمال العملية');
    expect(text).not.toContain('تمت كتابة Firmware والتحقق منه بنجاح');
    expect(
      renderer.root.findByProps({testID: 'start-safe-flash'}).props.disabled,
    ).toBe(false);
    act(() => renderer.unmount());
  });
});
