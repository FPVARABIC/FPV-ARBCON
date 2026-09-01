/**
 * THE FLASHER'S RECOVERY SURFACE - four defects found by red-teaming the
 * SHIPPED web bundle in Chromium with no board attached and the build
 * server unreachable, which is a state no unit suite had ever put the
 * screen into.
 *
 * What the sweep saw, and what each test now holds:
 *
 *   1. "تحقّق من الاتصال بالإنترنت ثم أعد المحاولة" with nothing to press.
 *      The boards download runs from a useEffect whose dependencies could
 *      never change, so the advice was unfollowable: leaving the screen
 *      and coming back was the only cure, and nothing said so.
 *
 *   2. Step ٢ rendered as a number, a heading and an empty box. Every
 *      other step on the page says what it is waiting for.
 *
 *   3. The build-options spinner could run forever. Its flag was cleared
 *      only in `.finally()`, which declines to fire on an aborted
 *      request - and one dependency change aborts the request AND takes
 *      an early return that cleared nothing.
 *
 *   4. "…اسم اللوحة غير موجود في قائمة Targets الرسمية. اختر Target
 *      يدويًا" stayed on screen after the operator picked a target by
 *      hand, still telling them to do the thing they had just done.
 *
 * Each test drives the real screen through the same press sequence a
 * person would.
 */

jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

import React from 'react';
import {ActivityIndicator, Text} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';
import '../../i18n';

import {betaflightBuildApi} from '../../core/firmware-flasher/buildApi';
import {FirmwareBootloaderController} from '../../platforms/react-native/protocol/FirmwareBootloaderController';
import type {UsbSerialTransportClient} from '../../platforms/react-native/transport';
import FirmwareFlasherSimpleScreen, {
  RETRYABLE_PROBLEM_CATEGORIES,
} from './FirmwareFlasherSimpleScreen';

const TARGETS = [
  {target: 'KAKUTEH7', group: 'supported', manufacturer: 'HBRO', mcu: 'STM32H743'},
  /* A REAL SHAPE, not a convenience: the API does publish targets whose
     release list comes back empty, and that is the input that made the
     spinner stick. */
  {target: 'EMPTYRELEASES', group: 'supported', manufacturer: 'ZZZQ', mcu: 'STM32F722'},
];

const RELEASES = [
  {release: '4.6.0', label: '2026-06-01', type: 'Stable'},
  {release: '4.5.1', label: '2026-01-01', type: 'Stable'},
];

const OPTIONS = {
  radioProtocols: [{name: 'CRSF', value: 'RX_CRSF', default: true, includesTelemetry: true}],
  telemetryProtocols: [{name: '[None]', value: '', default: true}],
  motorProtocols: [{name: 'DShot', value: 'USE_DSHOT', default: true}],
  generalOptions: [{name: 'GPS', value: 'USE_GPS'}],
};

const BUILD_DETAIL = {
  target: 'KAKUTEH7',
  release: '4.6.0',
  releaseType: 'Stable',
  cloudBuild: true,
  manufacturer: 'HBRO',
  mcu: 'STM32H743',
};

const SERIAL_DEVICE = {
  deviceId: 41,
  vendorId: 0x0483,
  productId: 0x5740,
  productName: 'Flight Controller',
  manufacturerName: 'FPV',
  driverType: 'CDC_ACM',
  portCount: 1,
} as const;

type Renderer = ReactTestRenderer.ReactTestRenderer;

interface ApiBehaviour {
  /** Reject the boards download this many times before succeeding. */
  readonly targetsFailures?: number;
  /**
   * Hold the build document open instead of resolving it.
   *
   * NOT A CONVENIENCE - it is the defect's precondition. The stuck
   * spinner needs the options request to still be OUTSTANDING when the
   * selection collapses, and on a real link it is: fetching the build
   * document and then its options is two sequential round trips against
   * the build server, while the release list is one. A fixture that
   * resolves everything on the next microtask cannot express that, and a
   * test written against it passes with the defect still in place -
   * which is exactly what the first draft of this test did.
   */
  readonly holdBuildDocument?: boolean;
}

function installBuildApi(behaviour: ApiBehaviour = {}) {
  let targetsCalls = 0;
  const failuresLeft = {value: behaviour.targetsFailures ?? 0};
  const held: (() => void)[] = [];

  const loadTargets = jest
    .spyOn(betaflightBuildApi, 'loadTargets')
    .mockImplementation(async () => {
      targetsCalls += 1;
      if (failuresLeft.value > 0) {
        failuresLeft.value -= 1;
        throw new Error('Failed to fetch');
      }
      return TARGETS as never;
    });

  jest
    .spyOn(betaflightBuildApi, 'loadTargetReleases')
    .mockImplementation(async (target: string) =>
      (target === 'EMPTYRELEASES' ? {releases: []} : {releases: RELEASES}) as never,
    );
  jest.spyOn(betaflightBuildApi, 'loadBuild').mockImplementation(
    (async () => {
      if (behaviour.holdBuildDocument !== true) return BUILD_DETAIL as never;
      return new Promise(resolve => {
        held.push(() => resolve(BUILD_DETAIL as never));
      });
    }) as never,
  );
  jest
    .spyOn(betaflightBuildApi, 'loadOptions')
    .mockImplementation(async () => OPTIONS as never);

  return {
    loadTargets,
    targetsCalls: () => targetsCalls,
    heldRequests: () => held.length,
    releaseHeld: () => {
      for (const resolve of held.splice(0)) resolve();
    },
  };
}

function fakeClient(over: Record<string, unknown> = {}) {
  return {
    listDevices: jest.fn(async () => [SERIAL_DEVICE]),
    listDfuDevices: jest.fn(async () => []),
    supportsDevicePicker: jest.fn(() => false),
    supportsDfuDevicePicker: jest.fn(() => false),
    requestDevicePermission: jest.fn(async () => null),
    requestDfuDevicePermission: jest.fn(async () => null),
    onDfuFlashProgress: jest.fn(() => jest.fn()),
    cancelDfuFlash: jest.fn(async () => undefined),
    flashDfuFirmware: jest.fn(async () => undefined),
    ...over,
  };
}

function node(renderer: Renderer, testID: string) {
  return renderer.root
    .findAllByProps({testID})
    .find(item => typeof item.props.onPress === 'function');
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

function spinnerCount(renderer: Renderer): number {
  return renderer.root.findAllByType(ActivityIndicator).length;
}

async function flush(rounds = 20): Promise<void> {
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

afterEach(() => {
  jest.restoreAllMocks();
});

describe('a failed download offers the retry its own sentence promises', () => {
  it('re-runs the boards download when the operator presses it, and clears the notice', async () => {
    const api = installBuildApi({targetsFailures: 1});
    const {renderer} = await renderScreen();

    // The defect state: the notice is up and the catalogue is empty.
    expect(exists(renderer, 'simple-problem-notice')).toBe(true);
    expect(screenText(renderer)).toContain('تعذّر تحميل قائمة اللوحات');
    expect(api.targetsCalls()).toBe(1);

    // The control the sentence implies exists, and does what it says.
    expect(exists(renderer, 'simple-retry-catalogue')).toBe(true);
    await press(renderer, 'simple-retry-catalogue');
    await flush(24);

    expect(api.targetsCalls()).toBe(2);
    expect(exists(renderer, 'simple-problem-notice')).toBe(false);
    expect(screenText(renderer)).not.toContain('تعذّر تحميل قائمة اللوحات');

    // And the retry actually produced the catalogue, not just a cleared
    // banner: the boards are selectable now.
    await press(renderer, 'simple-target-selector');
    expect(exists(renderer, 'simple-target-KAKUTEH7')).toBe(true);
    act(() => renderer.unmount());
  });

  it('does not repeat a control that already exists elsewhere on the page', async () => {
    installBuildApi();
    // A detection failure: its retry is the button in step ١, which is
    // still right there, so the notice must not grow a second one.
    const {renderer} = await renderScreen(
      fakeClient({listDevices: jest.fn(async () => [])}),
    );
    await press(renderer, 'simple-auto-detect');
    await flush(24);

    expect(exists(renderer, 'simple-problem-notice')).toBe(true);
    expect(exists(renderer, 'simple-retry-catalogue')).toBe(false);
    expect(exists(renderer, 'simple-auto-detect')).toBe(true);

    expect(RETRYABLE_PROBLEM_CATEGORIES).not.toContain('SERIAL');
    expect(RETRYABLE_PROBLEM_CATEGORIES).toContain('CATALOGUE');
    act(() => renderer.unmount());
  });
});

describe('every numbered step says what it is waiting for', () => {
  it('explains the empty version step before a board is chosen, and drops the line once releases arrive', async () => {
    installBuildApi();
    const {renderer} = await renderScreen();

    expect(exists(renderer, 'simple-release-placeholder')).toBe(true);
    expect(screenText(renderer)).toContain('اختر اللوحة أولًا لعرض الإصدارات المتاحة.');

    await press(renderer, 'simple-target-selector');
    await press(renderer, 'simple-target-KAKUTEH7');
    await flush(24);

    expect(exists(renderer, 'simple-release-4.6.0')).toBe(true);
    expect(exists(renderer, 'simple-release-placeholder')).toBe(false);
    act(() => renderer.unmount());
  });

  it('says so rather than showing an empty box when a board publishes no release', async () => {
    installBuildApi();
    const {renderer} = await renderScreen();

    await press(renderer, 'simple-target-selector');
    await press(renderer, 'simple-target-EMPTYRELEASES');
    await flush(24);

    expect(exists(renderer, 'simple-release-placeholder')).toBe(true);
    expect(screenText(renderer)).toContain(
      'لا توجد إصدارات معروضة لهذه اللوحة في القناة الحالية.',
    );
    act(() => renderer.unmount());
  });
});

describe('no spinner outlives the request it describes', () => {
  it('stops the build-options spinner when the selection collapses mid-load', async () => {
    const api = installBuildApi({holdBuildDocument: true});
    const {renderer} = await renderScreen();

    /*
     * THE EXACT SEQUENCE THAT USED TO STICK:
     *
     *   1. a board with releases -> a release is auto-selected -> the
     *      build document is requested and is STILL IN FLIGHT;
     *   2. the operator switches to a board that publishes nothing, so
     *      the release list comes back empty and selectedRelease is
     *      cleared;
     *   3. the effect re-runs: it aborts (1) - whose `.finally` then
     *      declines to clear the flag - and takes its early return.
     *
     * Before the fix the early return cleared nothing either, so the
     * options card kept an ActivityIndicator spinning for the rest of
     * the session with no request behind it.
     */
    await press(renderer, 'simple-target-selector');
    await press(renderer, 'simple-target-KAKUTEH7');
    await flush(24);

    // The precondition the defect needs: a request genuinely outstanding
    // and a spinner genuinely on screen.
    expect(api.heldRequests()).toBe(1);
    expect(spinnerCount(renderer)).toBe(1);

    await press(renderer, 'simple-target-selector');
    await press(renderer, 'simple-target-EMPTYRELEASES');
    await flush(30);

    expect(spinnerCount(renderer)).toBe(0);

    // And a late answer to the abandoned request does not revive it.
    api.releaseHeld();
    await flush(24);
    expect(spinnerCount(renderer)).toBe(0);
    act(() => renderer.unmount());
  });
});

describe('advice that has been followed stops being shown', () => {
  it('clears the "choose a target by hand" note once a target is chosen by hand', async () => {
    installBuildApi();
    /* A board that answers, and whose name is not a catalogue target -
       the case that produces the note. */
    jest
      .spyOn(FirmwareBootloaderController.prototype, 'detectFlightController')
      .mockResolvedValue({
        device: SERIAL_DEVICE,
        identity: {
          firmware: {knownFamily: 'BETAFLIGHT'},
          board: {
            targetName: 'STM32F7X2',
            boardName: 'NOT_IN_CATALOGUE_V1',
            boardIdentifier: 'NIC1',
          },
        },
        targetMatches: () => true,
        rebootToBootloader: jest.fn(async () => 1 as const),
        release: jest.fn(async () => undefined),
      } as never);

    const {renderer} = await renderScreen();
    await press(renderer, 'simple-auto-detect');
    await flush(24);

    expect(exists(renderer, 'simple-detection-note')).toBe(true);
    expect(screenText(renderer)).toContain('اختر Target يدويًا');

    await press(renderer, 'simple-target-selector');
    await press(renderer, 'simple-target-KAKUTEH7');
    await flush(24);

    expect(exists(renderer, 'simple-detection-note')).toBe(false);
    expect(screenText(renderer)).not.toContain('اختر Target يدويًا');
    act(() => renderer.unmount());
  });
});
