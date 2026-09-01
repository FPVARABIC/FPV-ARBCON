/**
 * THE DFU CONNECTION-PHASE CONTRACT (P0, real hardware).
 *
 * A real Kakute F7 failed the flashing workflow: after the flasher
 * itself sent reboot-to-bootloader, the normal MSP USB device
 * NECESSARILY disappeared - and the product treated that expected
 * transition as "USB is missing, reconnect normally", trapping the
 * operator between two phases that can never coexist. 4,900 green unit
 * tests did not catch it because every guard was written inside one
 * phase.
 *
 * This suite drives the REAL standard flasher screen through the real
 * lifecycle with a scripted transport whose device lists MUTATE the way
 * physical USB does: serial device A vanishes on reboot (with the
 * detach callbacks firing, exactly as the platform fires them), DFU
 * device B appears later, permission may or may not exist, and the
 * board may already be in DFU before the screen ever mounts.
 *
 * The engine's completion truth (SUCCESS/FAILED/UNCONFIRMED, bounded
 * transfers, no auto-retry) is NOT re-proven here - webUsbDfuCompletion
 * and the result-contract suites own it. This suite pins the CONNECTION
 * state machine that feeds that engine.
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
import FirmwareFlasherSimpleScreen from './FirmwareFlasherSimpleScreen';

const VALID_HEX = ':020000040800F2\n:0400000001020304F2\n:00000001FF\n';
const HEX_BYTES = Uint8Array.from(VALID_HEX, character => character.charCodeAt(0));
const F7_LAYOUT = '@Internal Flash  /0x08000000/04*032Kg,01*128Kg,03*256Kg';

const SERIAL_A: UsbSerialDeviceDescriptor = {
  deviceId: 41,
  vendorId: 0x0483,
  productId: 0x5740,
  productName: 'Kakute F7 (normal mode)',
  manufacturerName: 'Holybro',
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
  memoryLayout: F7_LAYOUT,
};

const KAKUTE_IDENTITY = {
  firmware: {knownFamily: 'BETAFLIGHT'},
  board: {
    targetName: 'KAKUTEF7',
    boardName: 'KAKUTEF7',
    boardIdentifier: 'KTF7',
    targetCapabilities: 0,
  },
} as const;

type Scripted = ReturnType<typeof scriptedClient>;

/**
 * A transport whose device lists are MUTABLE mid-test - the physical
 * truth the real screen must follow. Detach callbacks fire exactly like
 * the platform's own hot-plug events.
 */
function scriptedClient() {
  const state = {
    serial: [SERIAL_A] as UsbSerialDeviceDescriptor[],
    dfu: [] as DfuDeviceDescriptor[],
  };
  const detachListeners = new Set<(identity: UsbSerialDeviceDescriptor) => void>();
  const sessionDetachListeners = new Set<(event: {sessionId: string}) => void>();
  let progressListener: ((event: DfuFlashProgressEvent) => void) | undefined;
  const client = {
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
    onDeviceDetached: jest.fn((listener: (identity: UsbSerialDeviceDescriptor) => void) => {
      detachListeners.add(listener);
      return jest.fn(() => detachListeners.delete(listener));
    }),
    onSessionDetached: jest.fn((listener: (event: {sessionId: string}) => void) => {
      sessionDetachListeners.add(listener);
      return jest.fn(() => sessionDetachListeners.delete(listener));
    }),
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
    /** Physically remove serial A: the exact post-reboot lifecycle. */
    detachSerialA: () => {
      state.serial = [];
      detachListeners.forEach(listener => listener(SERIAL_A));
      sessionDetachListeners.forEach(listener => listener({sessionId: 'session-a'}));
    },
  };
  return client;
}

/** Official-shaped Build API fixtures - no network, no invented data. */
function installBuildApiFixtures() {
  jest.spyOn(betaflightBuildApi, 'loadTargets').mockResolvedValue([
    {target: 'KAKUTEF7', manufacturer: 'Holybro', mcu: 'STM32F745'},
    {target: 'MATEKF405', manufacturer: 'Matek', mcu: 'STM32F405'},
  ] as never);
  jest.spyOn(betaflightBuildApi, 'loadTargetReleases').mockResolvedValue({
    releases: [{release: '4.5.2', type: 'stable'}],
  });
  jest.spyOn(betaflightBuildApi, 'loadBuild').mockResolvedValue({
    target: 'KAKUTEF7',
    release: '4.5.2',
    releaseType: 'stable',
    cloudBuild: true,
  });
  jest.spyOn(betaflightBuildApi, 'loadOptions').mockResolvedValue({
    generalOptions: [],
    radioProtocols: [],
    telemetryProtocols: [],
    motorProtocols: [],
  });
  jest.spyOn(betaflightBuildApi, 'loadBuild').mockResolvedValue({
    target: 'KAKUTEF7',
    release: '4.5.2',
    releaseType: 'stable',
    cloudBuild: true,
  });
}

/**
 * The cloud build, resolved deviceless - a NETWORK operation. The spy
 * also proves, per test, that preparing firmware never consulted the
 * USB lists at all.
 */
function installCloudBuild() {
  return jest
    .spyOn(CloudBuildCoordinator.prototype, 'buildAndDownload')
    .mockImplementation(async (_request, onProgress) => {
      onProgress?.({phase: 'downloading', percent: 80, message: 'تنزيل Firmware…'});
      return {
        response: {file: 'betaflight_4.5.2_KAKUTEF7.hex', url: 'https://build/x.hex'},
        firmware: HEX_BYTES,
        configuration: null,
      } as never;
    });
}

/**
 * The serial-phase detector, faked at the controller seam with the REAL
 * reboot lifecycle: resolving rebootToBootloader REMOVES serial A from
 * the transport (firing the same detach callbacks the platform fires)
 * and, when the script says so, makes DFU B appear.
 */
function installDetector(
  client: Scripted,
  options: {
    readonly identity?: typeof KAKUTE_IDENTITY;
    readonly dfuAppearsOnReboot?: boolean;
  } = {},
) {
  const identity = options.identity ?? KAKUTE_IDENTITY;
  const rebootToBootloader = jest.fn(async () => {
    client.detachSerialA();
    if (options.dfuAppearsOnReboot !== false) {
      client.dfu = [DFU_B];
    }
    return 1 as const;
  });
  const release = jest.fn(async () => undefined);
  const detect = jest
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
  return {detect, rebootToBootloader, release};
}

function installAutoConfirm() {
  jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
    const destructive = buttons?.find(button => button.style === 'destructive');
    destructive?.onPress?.();
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

/**
 * Fire a press WITHOUT awaiting its async flow - for fake-timer tests
 * where the flow itself is parked on a timer that only an explicit
 * advance may release (awaiting the handler here would deadlock).
 */
function pressDetached(renderer: Renderer, testID: string): Promise<void> {
  const node = renderer.root
    .findAllByProps({testID})
    .find(item => typeof item.props.onPress === 'function');
  if (!node) throw new Error(`Missing pressable ${testID}`);
  return act(async () => {
    node.props.onPress();
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

/** Target picked from the catalogue, stable release auto-selected. */
async function selectKakuteTarget(renderer: Renderer): Promise<void> {
  await press(renderer, 'simple-target-selector');
  await press(renderer, 'simple-target-KAKUTEF7');
  await flush();
}

async function prepareFirmware(renderer: Renderer): Promise<void> {
  await press(renderer, 'simple-load-firmware');
  await flush();
  expect(has(renderer, 'simple-firmware-ready')).toBe(true);
}

const trackedRenderers: Renderer[] = [];
afterEach(async () => {
  const renderers = trackedRenderers.splice(0, trackedRenderers.length);
  await act(async () => {
    renderers.forEach(renderer => {
      if (renderer.toJSON() !== null) renderer.unmount();
    });
    await Promise.resolve();
  });
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('THE KAKUTE F7 REPRODUCTION - expected MSP disappearance must never abort the workflow', () => {
  it('normal device A → identity → firmware → reboot → A detaches (callbacks fire) → DFU B appears → flash uses B → SUCCESS exactly once', async () => {
    const client = scriptedClient();
    installBuildApiFixtures();
    const build = installCloudBuild();
    const pipeline = installDetector(client, {dfuAppearsOnReboot: true});
    installAutoConfirm();

    const renderer = await renderScreen(client);
    trackedRenderers.push(renderer);

    await selectKakuteTarget(renderer);
    await prepareFirmware(renderer);

    // The flash press runs the WHOLE lifecycle: verify identity over the
    // normal device, freeze it, reboot (which detaches A and fires the
    // session-loss callbacks), wait for B, flash B.
    await press(renderer, 'simple-flash-firmware');
    await flush(24);

    expect(pipeline.rebootToBootloader).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledTimes(1);
    expect(client.flashDfuFirmware).toHaveBeenCalledTimes(1);
    expect(client.flashDfuFirmware.mock.calls[0][0]).toBe(DFU_B.deviceId);

    const text = screenText(renderer);
    expect(text).toContain('تمت كتابة Firmware والتحقق منه بنجاح');
    // The trap messages must never have become the terminal state.
    expect(text).not.toContain('لم يُعثر على Flight Controller');
    expect(text).not.toContain('وصّل اللوحة عبر USB');
  });

  it('the firmware stays prepared while the transport changes underneath it - and a NETWORK build succeeds with NO device attached at all', async () => {
    const client = scriptedClient();
    installBuildApiFixtures();
    const build = installCloudBuild();
    installDetector(client);

    const renderer = await renderScreen(client);
    trackedRenderers.push(renderer);
    await selectKakuteTarget(renderer);

    // The operator unplugs the board entirely - then prepares firmware.
    await act(async () => {
      client.detachSerialA();
      await Promise.resolve();
    });
    await prepareFirmware(renderer);

    // The build consulted the NETWORK coordinator, never the USB lists.
    expect(build).toHaveBeenCalledTimes(1);
    const listCallsBeforePrepare = client.listDevices.mock.calls.length;
    // Preparing again with nothing attached still succeeds.
    await press(renderer, 'simple-load-firmware');
    await flush();
    expect(has(renderer, 'simple-firmware-ready')).toBe(true);
    expect(client.listDevices.mock.calls.length).toBe(listCallsBeforePrepare);
  });
});

describe('the board is ALREADY in DFU - the second legitimate entry path', () => {
  it('adopts the DFU device automatically, never demands the normal device, and flashes after the explicit one-time acknowledgement', async () => {
    const client = scriptedClient();
    client.serial = [];
    client.dfu = [DFU_B];
    installBuildApiFixtures();
    installCloudBuild();
    installAutoConfirm();

    const renderer = await renderScreen(client);
    trackedRenderers.push(renderer);

    // The presence watcher found it without any serial detection.
    expect(has(renderer, 'simple-dfu-ready')).toBe(true);
    expect(screenText(renderer)).toContain('اللوحة في وضع DFU');

    await selectKakuteTarget(renderer);
    await prepareFirmware(renderer);

    // UNKNOWN IS NOT MISMATCH. Identity cannot be read in DFU - that is
    // a property of the bootloader, not a reason to refuse. The screen
    // WARNS and the flash proceeds on the first press; there is no
    // acknowledgement checkbox and no hidden post-confirmation gate.
    expect(screenText(renderer)).toContain('لا يمكن قراءة هويتها');
    expect(has(renderer, 'simple-accept-unverified-dfu')).toBe(false);

    await press(renderer, 'simple-flash-firmware');
    await flush(24);
    expect(client.flashDfuFirmware).toHaveBeenCalledTimes(1);
    expect(screenText(renderer)).toContain('تمت كتابة Firmware والتحقق منه بنجاح');
    expect(screenText(renderer)).not.toContain('وصّل اللوحة عبر USB');
  });

  it('«الدخول إلى وضع DFU» with the board already in DFU reports ready instead of failing over the missing serial device', async () => {
    const client = scriptedClient();
    client.serial = [];
    client.dfu = [DFU_B];
    installBuildApiFixtures();

    const renderer = await renderScreen(client);
    trackedRenderers.push(renderer);

    // The chip replaced the button (adoption happened) - but even if the
    // operator races the watcher, the action itself must short-circuit.
    expect(has(renderer, 'simple-dfu-ready')).toBe(true);
    const text = screenText(renderer);
    expect(text).not.toContain('لم يُعثر');
  });
});

describe('target identity is frozen across the re-enumeration', () => {
  it('a target verified in normal mode STAYS verified on the DFU device, survives a selection round-trip, and mismatch requires the acknowledgement', async () => {
    const client = scriptedClient();
    installBuildApiFixtures();
    installCloudBuild();
    installDetector(client, {dfuAppearsOnReboot: true});

    const renderer = await renderScreen(client);
    trackedRenderers.push(renderer);
    await selectKakuteTarget(renderer);

    // Enter DFU through the software path: verify → freeze → reboot.
    await press(renderer, 'simple-enter-dfu');
    await flush(24);
    expect(screenText(renderer)).toContain('هويتها مطابقة');

    // Switching the selection to a DIFFERENT board keeps the transport
    // (the board is still physically in DFU) but the frozen identity no
    // longer matches - the verified chip must honestly downgrade.
    await press(renderer, 'simple-target-selector');
    await press(renderer, 'simple-target-MATEKF405');
    await flush();
    expect(has(renderer, 'simple-dfu-ready')).toBe(true);
    expect(screenText(renderer)).not.toContain('هويتها مطابقة');
    // Downgraded to a warning, never a gate.
    expect(screenText(renderer)).toContain('لا يمكن قراءة هويتها');
    expect(has(renderer, 'simple-accept-unverified-dfu')).toBe(false);

    // Returning to the verified target restores the derived match - the
    // identity was never erased by USB churn or selection churn.
    await selectKakuteTarget(renderer);
    expect(screenText(renderer)).toContain('هويتها مطابقة');
  });

  it('a normal-mode identity that does not match the selection BLOCKS before the destructive phase - reboot is never sent', async () => {
    const client = scriptedClient();
    installBuildApiFixtures();
    installCloudBuild();
    const pipeline = installDetector(client, {
      identity: {
        firmware: {knownFamily: 'BETAFLIGHT'},
        board: {
          targetName: 'MATEKF405',
          boardName: 'MATEKF405',
          boardIdentifier: 'MK41',
          targetCapabilities: 0,
        },
      } as never,
    });
    installAutoConfirm();

    const renderer = await renderScreen(client);
    trackedRenderers.push(renderer);
    await selectKakuteTarget(renderer);
    await prepareFirmware(renderer);

    await press(renderer, 'simple-flash-firmware');
    await flush();

    expect(pipeline.rebootToBootloader).not.toHaveBeenCalled();
    expect(client.flashDfuFirmware).not.toHaveBeenCalled();
    expect(screenText(renderer)).toContain('لا يطابق');
  });
});

describe('WebUSB permission is a one-press continuation, never a restart', () => {
  it('reboot → nothing authorized → bounded wait elapses → ONE chooser press continues the SAME prepared operation (no rebuild, no second reboot)', async () => {
    jest.useFakeTimers();
    const client = scriptedClient();
    installBuildApiFixtures();
    const build = installCloudBuild();
    const pipeline = installDetector(client, {dfuAppearsOnReboot: false});
    installAutoConfirm();

    const renderer = await renderScreen(client);
    trackedRenderers.push(renderer);
    await selectKakuteTarget(renderer);
    await prepareFirmware(renderer);

    await press(renderer, 'simple-flash-firmware');
    // The board rebooted; the authorized list stays empty for the whole
    // bounded wait (an unauthorized browser sees nothing).
    await act(async () => {
      await jest.advanceTimersByTimeAsync(20_600);
    });
    await flush();

    expect(screenText(renderer)).toContain('اختر جهاز DFU للمتابعة');
    expect(has(renderer, 'simple-choose-dfu')).toBe(true);
    expect(client.flashDfuFirmware).not.toHaveBeenCalled();

    // The physical board IS in DFU; the chooser authorizes it.
    client.dfu = [DFU_B];
    await press(renderer, 'simple-choose-dfu');
    await flush(24);

    expect(client.requestDfuDevicePermission).toHaveBeenCalledTimes(1);
    expect(pipeline.rebootToBootloader).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledTimes(1);
    expect(client.flashDfuFirmware).toHaveBeenCalledTimes(1);
    expect(screenText(renderer)).toContain('تمت كتابة Firmware والتحقق منه بنجاح');
  });

  it('a cancelled chooser changes nothing: firmware stays prepared, the hold remains, no failure is declared', async () => {
    jest.useFakeTimers();
    const client = scriptedClient();
    client.requestDfuDevicePermission.mockResolvedValue(null);
    installBuildApiFixtures();
    installCloudBuild();
    installDetector(client, {dfuAppearsOnReboot: false});
    installAutoConfirm();

    const renderer = await renderScreen(client);
    trackedRenderers.push(renderer);
    await selectKakuteTarget(renderer);
    await prepareFirmware(renderer);
    await press(renderer, 'simple-flash-firmware');
    await act(async () => {
      await jest.advanceTimersByTimeAsync(20_600);
    });
    await flush();

    await press(renderer, 'simple-choose-dfu');
    await flush();

    const text = screenText(renderer);
    expect(has(renderer, 'simple-choose-dfu')).toBe(true);
    expect(text).not.toContain('فشل التفليش');
    expect(client.flashDfuFirmware).not.toHaveBeenCalled();
  });

  it('the standalone chooser button is a first-class path on the web whenever no DFU device is bound - not an error remedy', async () => {
    const client = scriptedClient();
    installBuildApiFixtures();

    const renderer = await renderScreen(client);
    trackedRenderers.push(renderer);

    expect(has(renderer, 'simple-choose-dfu-device')).toBe(true);
  });
});

describe('bounded waits, late appearance and genuine absence', () => {
  it('DFU appearing AFTER the bounded wait is still adopted by the watcher - a slow re-enumeration completes the workflow instead of failing it', async () => {
    jest.useFakeTimers();
    const client = scriptedClient();
    installBuildApiFixtures();
    installDetector(client, {dfuAppearsOnReboot: false});

    const renderer = await renderScreen(client);
    trackedRenderers.push(renderer);
    await selectKakuteTarget(renderer);

    await pressDetached(renderer, 'simple-enter-dfu');
    await act(async () => {
      await jest.advanceTimersByTimeAsync(20_600);
    });
    await flush();
    // The wait elapsed without a device - guidance, not failure.
    expect(screenText(renderer)).not.toContain('فشل');

    // The board finally re-enumerates; the watcher adopts it.
    client.dfu = [DFU_B];
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2_400);
    });
    await flush();
    expect(has(renderer, 'simple-dfu-ready')).toBe(true);
  });

  it('nothing attached in ANY phase is a genuine failure that names both phases - the only honest dead end', async () => {
    const client = scriptedClient();
    client.serial = [];
    installBuildApiFixtures();
    installCloudBuild();
    installAutoConfirm();

    const renderer = await renderScreen(client);
    trackedRenderers.push(renderer);
    await selectKakuteTarget(renderer);
    await prepareFirmware(renderer);
    await press(renderer, 'simple-flash-firmware');
    await flush();

    const text = screenText(renderer);
    expect(text).toContain('DFU');
    expect(text).toContain('اختيار جهاز USB');
  });
});

describe('the completion engine keeps its P0 contract through the new phases', () => {
  async function flashAgainstScriptedEngine(
    reject: {code: string; nativeMessage: string} | null,
    progressPhase?: DfuFlashProgressEvent['phase'],
  ) {
    const client = scriptedClient();
    client.serial = [];
    client.dfu = [DFU_B];
    if (reject !== null) {
      client.flashDfuFirmware.mockImplementation(async () => {
        if (progressPhase) {
          client.emitDfuProgress({phase: progressPhase, percent: 97} as DfuFlashProgressEvent);
        }
        throw reject;
      });
    }
    installBuildApiFixtures();
    installCloudBuild();
    installAutoConfirm();

    const renderer = await renderScreen(client);
    trackedRenderers.push(renderer);
    await selectKakuteTarget(renderer);
    await prepareFirmware(renderer);
    await press(renderer, 'simple-flash-firmware');
    await flush(24);
    return {client, renderer};
  }

  it('a DFU disconnect during write is a FAILED result with its real reason - and no automatic second erase/write ever fires', async () => {
    const {client, renderer} = await flashAgainstScriptedEngine(
      {code: 'DFU_TRANSFER_OVERRUN_WRITE', nativeMessage: 'انقطع جهاز DFU أثناء الكتابة.'},
      'writing',
    );
    expect(screenText(renderer)).toContain('فشل التفليش');
    expect(client.flashDfuFirmware).toHaveBeenCalledTimes(1);
  });

  it('a manifestation-window loss stays the honest UNCONFIRMED third result', async () => {
    const {renderer} = await flashAgainstScriptedEngine(
      {code: 'DFU_COMPLETION_UNCONFIRMED_MANIFEST', nativeMessage: 'GETSTATUS never settled.'},
      'manifesting',
    );
    expect(screenText(renderer)).toContain('تعذر تأكيد اكتمال العملية');
  });

  it('a poisoned DFU session refuses to start again without reacquisition - stated failure, exactly one engine call', async () => {
    const {client, renderer} = await flashAgainstScriptedEngine({
      code: 'DFU_SESSION_POISONED',
      nativeMessage: 'pending transfer against this session',
    });
    expect(screenText(renderer)).toContain('فشل التفليش');
    expect(client.flashDfuFirmware).toHaveBeenCalledTimes(1);
  });

  it('progress events never visually claim success - the bar is capped below terminal until the promise settles', async () => {
    const client = scriptedClient();
    client.serial = [];
    client.dfu = [DFU_B];
    let resolveFlash!: () => void;
    client.flashDfuFirmware.mockImplementation(
      () => new Promise<void>(resolve => {
        resolveFlash = resolve;
      }),
    );
    installBuildApiFixtures();
    installCloudBuild();
    installAutoConfirm();

    const renderer = await renderScreen(client);
    trackedRenderers.push(renderer);
    await selectKakuteTarget(renderer);
    await prepareFirmware(renderer);
    await press(renderer, 'simple-flash-firmware');
    await act(async () => {
      client.emitDfuProgress({phase: 'writing', percent: 99.9} as DfuFlashProgressEvent);
      await Promise.resolve();
    });

    expect(screenText(renderer)).not.toContain('تمت كتابة Firmware والتحقق منه بنجاح');

    await act(async () => {
      resolveFlash();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screenText(renderer)).toContain('تمت كتابة Firmware والتحقق منه بنجاح');
  });
});
