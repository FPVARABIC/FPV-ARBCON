/**
 * A STALE ATTEMPT MUST NOT OVERWRITE THE ACTIVE ONE.
 *
 * The screen's backstop freezes an attempt after 150 s of total progress
 * silence and bumps the attempt serial. The operator then starts a second
 * attempt, which succeeds. Only afterwards does the frozen first attempt
 * finally settle - and its settlement must be discarded, because the truth
 * on screen belongs to the run that is actually current.
 *
 * TIMER MODE: FAKE TIMERS ONLY, for the whole file. Reaching a 150 s
 * production deadline with real timers would make the suite take longer
 * than the deadline it tests. No real timer is awaited anywhere here, so
 * the two clocks are never mixed: every wait is `advanceTimersByTime`
 * inside `act`.
 */
jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport', () => ({
  __esModule: true,
  default: new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`native leaf touched ("${String(property)}")`);
      },
    },
  ),
}));
jest.mock('../orientation3d', () => ({OrientationRenderer: () => null}));

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import '../../i18n';
import FirmwareFlasherScreen from './FirmwareFlasherScreen';
import {bytesToBase64} from '../../platforms/react-native/protocol/base64';
import {
  createStm32Device,
  makeHexImage,
} from '../../platforms/react-native/protocol/__testUtils__/stm32Bootloader';
import type {UsbSerialTransportClient} from '../../platforms/react-native/transport';

type Renderer = ReactTestRenderer.ReactTestRenderer;

const IMAGE = makeHexImage(64);
const SUCCESS_TITLE = "✓ Firmware geschreven en geverifieerd";
const NEVER_STARTED =
  "De voortgang stopte voordat gegevens werden overgedragen. De inhoud van de printplaat is niet gewijzigd. Koppel USB los, sluit opnieuw aan en start opnieuw.";

async function flush(ms = 0, rounds = 12): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      jest.advanceTimersByTime(round === 0 ? ms : 0);
      await Promise.resolve();
    });
  }
}

function press(renderer: Renderer, testID: string): boolean {
  const found = renderer.root.findAll(
    node => node.props?.testID === testID && typeof node.props?.onPress === 'function',
    {deep: true},
  );
  if (found.length === 0) return false;
  act(() => {
    found[0].props.onPress();
  });
  return true;
}

function pressLabel(renderer: Renderer, label: string): boolean {
  const found = renderer.root.findAll(
    node =>
      node.props?.accessibilityLabel === label &&
      typeof node.props?.onPress === 'function' &&
      node.props?.disabled !== true,
    {deep: true},
  );
  if (found.length === 0) return false;
  act(() => {
    found[0].props.onPress();
  });
  return true;
}

function readTestId(renderer: Renderer, testID: string): string | undefined {
  const found = renderer.root.findAll(
    node => node.props?.testID === testID && typeof node.type === 'string',
    {deep: true},
  );
  if (found.length === 0) return undefined;
  const flatten = (value: unknown): string => {
    if (value === null || value === undefined || typeof value === 'boolean') return '';
    if (Array.isArray(value)) return value.map(flatten).join('');
    if (typeof value === 'object' && 'props' in (value as {props?: unknown})) {
      return flatten((value as {props: {children?: unknown}}).props.children);
    }
    return String(value);
  };
  return flatten(found[found.length - 1].props.children).trim();
}

describe('a stale attempt cannot overwrite the active one', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('attempt 1 is frozen, attempt 2 succeeds, and attempt 1 settles too late to matter', async () => {
    const DEVICES = [
      {
        deviceId: 7,
        vendorId: 0x0483,
        productId: 0x5740,
        productName: 'STM32 Virtual COM',
        manufacturerName: 'STMicroelectronics',
        driverType: 'CDC_ACM',
        portCount: 1,
      },
    ];
    const {client: serial, transcript} = createStm32Device({});
    const bytes = Uint8Array.from([...IMAGE].map(character => character.charCodeAt(0)));
    let releaseEnumeration: (() => void) | undefined;
    let holdEnumeration = false;

    const client = {
      ...(serial as unknown as Record<string, unknown>),
      supportsDevicePicker: () => false,
      supportsDfuDevicePicker: () => false,
      /* Held only while the flag is set, so the FIRST attempt stalls before
       * any transfer - the only backstop branch the serial route can reach,
       * since the backstop refuses to freeze a transfer already begun. */
      listDevices: () =>
        holdEnumeration
          ? new Promise<typeof DEVICES>(resolve => {
              releaseEnumeration = () => resolve(DEVICES);
            })
          : Promise.resolve(DEVICES),
      listDfuDevices: async () => [],
      saveFirmwareFile: async () => true,
      pickFirmwareFile: async () => ({
        name: 'stale.hex',
        sizeBytes: bytes.length,
        mimeType: 'application/octet-stream',
        dataBase64: bytesToBase64(bytes),
      }),
      cancelDfuFlash: async () => undefined,
      onDeviceAttached: () => () => undefined,
      onDeviceDetached: () => () => undefined,
      onDfuFlashProgress: () => () => undefined,
    } as unknown as UsbSerialTransportClient;

    let renderer!: Renderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <FirmwareFlasherScreen
          client={client}
          buildApi={{loadTargets: async () => [], loadReleases: async () => []} as never}
        />,
      );
    });
    await flush(1);

    expect(press(renderer, 'firmware-source-local')).toBe(true);
    await flush(1);
    expect(press(renderer, 'pick-local-firmware')).toBe(true);
    await flush(300);
    expect(press(renderer, 'hex-method-serial')).toBe(true);
    await flush(1);
    expect(press(renderer, 'toggle-advanced-flash-options')).toBe(true);
    await flush(1);
    expect(pressLabel(renderer, "Zonder herstartprocedure")).toBe(true);
    await flush(1);
    expect(press(renderer, 'confirm-props-removed')).toBe(true);
    expect(press(renderer, 'confirm-usb-power-only')).toBe(true);
    await flush(1);
    expect(pressLabel(renderer, "Ik heb de Target en bootloader handmatig gecontroleerd.")).toBe(true);
    await flush(1);

    /* ---- attempt 1 stalls before any transfer ---- */
    holdEnumeration = true;
    expect(press(renderer, 'start-safe-flash')).toBe(true);
    await flush(1);
    expect(releaseEnumeration).toBeDefined();

    for (let elapsed = 0; elapsed < 160_000; elapsed += 5_000) {
      // eslint-disable-next-line no-await-in-loop
      await flush(5_000, 3);
    }
    expect(readTestId(renderer, 'flash-result-reason')).toBe(NEVER_STARTED);

    /* ---- attempt 2 is the ACTIVE run, and it succeeds ---- */
    holdEnumeration = false;
    expect(press(renderer, 'start-safe-flash')).toBe(true);
    await flush(50, 40);
    expect(readTestId(renderer, 'flash-result-title')).toBe(SUCCESS_TITLE);
    expect(transcript.eraseAcknowledged).toBe(true);

    /* ---- attempt 1 finally settles, long after being superseded ---- */
    await act(async () => {
      releaseEnumeration?.();
      await Promise.resolve();
    });
    await flush(2_000, 30);

    expect(readTestId(renderer, 'flash-result-title')).toBe(SUCCESS_TITLE);
    expect(readTestId(renderer, 'flash-result-reason')).toBeUndefined();

    await act(async () => {
      renderer.unmount();
    });
  });

  it('the native leaf sentinel never fired', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const module_ = require('../../platforms/react-native/transport/native/NativeUsbSerialTransport');
    expect(() => (module_.default as {listDevices: unknown}).listDevices).toThrow(
      /native leaf touched/,
    );
  });
});
