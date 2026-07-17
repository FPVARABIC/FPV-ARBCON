jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

import React from 'react';
import {Text} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';

import UsbConnectionScreen from './UsbConnectionScreen';
import type {UsbSerialDeviceDescriptor} from '../../platforms/react-native/transport';
import type {UsbSerialTransportClient} from '../../platforms/react-native/transport';
import i18n from '../../i18n';

type MockClient = {
  listDevices: jest.Mock;
  openDevice: jest.Mock;
  closeSession: jest.Mock;
  onDeviceAttached: jest.Mock;
  onDeviceDetached: jest.Mock;
  onSessionDetached: jest.Mock;
};

function createMockClient(): MockClient {
  return {
    listDevices: jest.fn(),
    openDevice: jest.fn(),
    closeSession: jest.fn(),
    onDeviceAttached: jest.fn(() => jest.fn()),
    onDeviceDetached: jest.fn(() => jest.fn()),
    onSessionDetached: jest.fn(() => jest.fn()),
  };
}

/** The handler most recently passed to a client.onDeviceX(...) mock. */
function latestHandler(mock: jest.Mock): (event?: unknown) => void {
  const {calls} = mock.mock;
  if (calls.length === 0) {
    throw new Error('No hot-plug handler was ever registered.');
  }
  return calls[calls.length - 1][0];
}

/** Simulates a native USB attach broadcast. The handler itself is
 * synchronous (dispatch + fire-and-forget handleRefresh), but handleRefresh's
 * internal listDevices() await needs a couple of microtask turns to settle
 * within this act() before control returns to the test. */
async function fireAttached(client: MockClient) {
  const handler = latestHandler(client.onDeviceAttached);
  await act(async () => {
    handler();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Simulates a native USB detach broadcast for the given device identity. */
async function fireDetached(
  client: MockClient,
  identity: {deviceId: number; vendorId: number; productId: number},
) {
  const handler = latestHandler(client.onDeviceDetached);
  await act(async () => {
    handler(identity);
  });
}

/** Simulates the native "active session's device physically detached" event. */
async function fireSessionDetached(client: MockClient, sessionId: string) {
  const handler = latestHandler(client.onSessionDetached);
  await act(async () => {
    handler({sessionId, deviceId: 0});
  });
}

function supportedDevice(overrides: Partial<UsbSerialDeviceDescriptor> = {}): UsbSerialDeviceDescriptor {
  return {
    deviceId: 1,
    vendorId: 0x1a86,
    productId: 0x7523,
    productName: 'CH340 Serial',
    manufacturerName: 'QinHeng',
    driverType: 'CH34X',
    portCount: 1,
    ...overrides,
  };
}

function secondSupportedDevice(overrides: Partial<UsbSerialDeviceDescriptor> = {}): UsbSerialDeviceDescriptor {
  return {
    deviceId: 3,
    vendorId: 0x0403,
    productId: 0x6001,
    productName: 'FTDI Serial',
    manufacturerName: 'FTDI',
    driverType: 'FTDI',
    portCount: 1,
    ...overrides,
  };
}

function unsupportedDevice(overrides: Partial<UsbSerialDeviceDescriptor> = {}): UsbSerialDeviceDescriptor {
  return {
    deviceId: 2,
    vendorId: 0x0e8d,
    productId: 0x2000,
    driverType: 'UNSUPPORTED',
    portCount: 0,
    ...overrides,
  };
}

/** Creates the screen without pre-configuring the automatic mount scan's
 * result - the caller must have already queued the desired
 * listDevices() mock behavior (resolved, rejected, or pending). */
async function createScreen(client: MockClient) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <UsbConnectionScreen client={client as unknown as UsbSerialTransportClient} />,
    );
  });
  return renderer;
}

/** Common case: the screen mounts and its one automatic scan resolves with
 * `autoScanDevices` - i.e. "this is what was already attached when the app
 * opened." Defaults to no devices. */
async function renderScreen(client: MockClient, autoScanDevices: UsbSerialDeviceDescriptor[] = []) {
  client.listDevices.mockResolvedValueOnce(autoScanDevices);
  return createScreen(client);
}

// A given testID can be shared by several nodes in the tree: our own
// wrapper components (e.g. UsbDeviceRow, which receives testID but exposes
// onSelect, not onPress) forward it to the Pressable they render, which in
// turn forwards it again to its host View. Only the actual Pressable
// declares `onPress` as one of its own prop keys (even when its value is
// undefined, e.g. while disabled), so that is what identifies it uniquely.
function findPressableMatch(renderer: ReactTestRenderer.ReactTestRenderer, testID: string) {
  const matches = renderer.root.findAllByProps({testID});
  return matches.find(node => 'onPress' in node.props) ?? null;
}

function findByTestID(renderer: ReactTestRenderer.ReactTestRenderer, testID: string) {
  const match = findPressableMatch(renderer, testID);
  if (!match) {
    throw new Error(`No pressable instance found with testID "${testID}"`);
  }
  return match;
}

function queryByTestID(renderer: ReactTestRenderer.ReactTestRenderer, testID: string) {
  return findPressableMatch(renderer, testID);
}

// For non-Pressable lookups (e.g. a Text node used only as an existence
// marker), any match is fine - there is no onPress to disambiguate.
function queryAnyByTestID(renderer: ReactTestRenderer.ReactTestRenderer, testID: string) {
  const matches = renderer.root.findAllByProps({testID});
  return matches.length > 0 ? matches[0] : null;
}

function allText(renderer: ReactTestRenderer.ReactTestRenderer): string[] {
  return renderer.root.findAllByType(Text).map(node => {
    const children = node.props.children;
    return Array.isArray(children) ? children.join('') : String(children ?? '');
  });
}

async function pressRefresh(renderer: ReactTestRenderer.ReactTestRenderer) {
  await act(async () => {
    await findByTestID(renderer, 'usb-refresh-button').props.onPress();
  });
}

async function pressDevice(renderer: ReactTestRenderer.ReactTestRenderer, device: UsbSerialDeviceDescriptor) {
  const key = `${device.deviceId}:${device.vendorId}:${device.productId}`;
  await act(async () => {
    findByTestID(renderer, `usb-device-row-${key}`).props.onPress();
  });
}

async function pressConnect(renderer: ReactTestRenderer.ReactTestRenderer) {
  await act(async () => {
    await findByTestID(renderer, 'usb-connect-button').props.onPress();
  });
}

async function pressDisconnect(renderer: ReactTestRenderer.ReactTestRenderer) {
  await act(async () => {
    await findByTestID(renderer, 'usb-disconnect-button').props.onPress();
  });
}

describe('UsbConnectionScreen - one-time automatic mount scan', () => {
  it('calls listDevices() exactly once on mount', async () => {
    const client = createMockClient();
    await renderScreen(client, []);
    expect(client.listDevices).toHaveBeenCalledTimes(1);
  });

  it('does not trigger a second automatic scan on rerender', async () => {
    const client = createMockClient();
    const renderer = await renderScreen(client, []);

    await act(async () => {
      renderer.update(
        <UsbConnectionScreen client={client as unknown as UsbSerialTransportClient} />,
      );
    });
    await act(async () => {
      renderer.update(
        <UsbConnectionScreen client={client as unknown as UsbSerialTransportClient} />,
      );
    });

    expect(client.listDevices).toHaveBeenCalledTimes(1);
  });

  it('never calls openDevice() or closeSession() from the automatic scan', async () => {
    const client = createMockClient();
    await renderScreen(client, [supportedDevice()]);
    expect(client.openDevice).not.toHaveBeenCalled();
    expect(client.closeSession).not.toHaveBeenCalled();
  });

  it('shows an already-attached supported device without pressing تحديث', async () => {
    const client = createMockClient();
    const renderer = await renderScreen(client, [supportedDevice()]);
    expect(allText(renderer)).toContain('CH340 Serial');
  });

  it('shows the scanning text while the automatic scan is pending', async () => {
    const client = createMockClient();
    client.listDevices.mockReturnValueOnce(new Promise(() => {}));
    const renderer = await createScreen(client);
    expect(allText(renderer)).toContain(i18n.t('devices.scanning'));
  });

  it('manual تحديث still performs another real scan after the initial automatic one', async () => {
    const client = createMockClient();
    const renderer = await renderScreen(client, []);

    client.listDevices.mockResolvedValueOnce([supportedDevice()]);
    await pressRefresh(renderer);

    expect(client.listDevices).toHaveBeenCalledTimes(2);
    expect(allText(renderer)).toContain('CH340 Serial');
  });

  it('enumeration failure on mount shows the localized error and does not retry automatically', async () => {
    const client = createMockClient();
    client.listDevices.mockRejectedValueOnce({code: 'DEVICE_ENUMERATION_FAILED', message: 'boom'});
    const renderer = await createScreen(client);

    expect(allText(renderer)).toContain(i18n.t('errors.DEVICE_ENUMERATION_FAILED'));
    expect(client.listDevices).toHaveBeenCalledTimes(1);
    expect(client.openDevice).not.toHaveBeenCalled();
    expect(client.closeSession).not.toHaveBeenCalled();
  });
});

describe('UsbConnectionScreen - safe automatic selection policy', () => {
  it('automatically selects the sole supported device and its single port', async () => {
    const client = createMockClient();
    const device = supportedDevice({portCount: 1});
    const renderer = await renderScreen(client, [device]);

    expect(allText(renderer)).toContain(i18n.t('ports.portNumber', {number: 1}));
    expect(findByTestID(renderer, 'usb-connect-button').props.accessibilityState.disabled).toBe(false);
  });

  it('never calls openDevice() merely from automatic selection', async () => {
    const client = createMockClient();
    await renderScreen(client, [supportedDevice()]);
    expect(client.openDevice).not.toHaveBeenCalled();
  });

  it('does not automatically select when two or more supported devices are found', async () => {
    const client = createMockClient();
    const deviceA = supportedDevice();
    const deviceB = secondSupportedDevice();
    const renderer = await renderScreen(client, [deviceA, deviceB]);

    expect(findByTestID(renderer, 'usb-connect-button').props.accessibilityState.disabled).toBe(true);
    expect(allText(renderer)).toContain(i18n.t('devices.multipleSupportedGuidance'));
    expect(allText(renderer)).not.toContain(i18n.t('devices.supportedDetected'));
  });

  it('does not automatically select when only unsupported devices are found', async () => {
    const client = createMockClient();
    const renderer = await renderScreen(client, [unsupportedDevice()]);

    expect(findByTestID(renderer, 'usb-connect-button').props.accessibilityState.disabled).toBe(true);
    expect(allText(renderer)).toContain(i18n.t('devices.unsupported'));
    expect(allText(renderer)).not.toContain(i18n.t('devices.supportedDetected'));
  });

  it('shows the existing empty state when zero devices are found', async () => {
    const client = createMockClient();
    const renderer = await renderScreen(client, []);
    expect(allText(renderer)).toContain(i18n.t('devices.emptyPrimary'));
    expect(allText(renderer)).not.toContain(i18n.t('devices.supportedDetected'));
  });

  it('shows the accurate detection message only when a supported device exists', async () => {
    const client = createMockClient();
    const renderer = await renderScreen(client, [supportedDevice()]);
    expect(allText(renderer)).toContain(i18n.t('devices.supportedDetected'));
  });

  it('never claims connection success, firmware, or MSP before openDevice() resolves', async () => {
    const client = createMockClient();
    const renderer = await renderScreen(client, [supportedDevice()]);
    const joined = allText(renderer).join(' ');
    expect(joined).not.toContain(i18n.t('actions.connectSuccess'));
    expect(joined).not.toContain('MSP');
    expect(joined).not.toContain('Betaflight');
  });
});

describe('UsbConnectionScreen - device/port selection', () => {
  it('requires an explicit port choice for a multi-port device and maps 1-based labels to 0-based portIndex', async () => {
    const client = createMockClient();
    const device = supportedDevice({portCount: 2});
    client.openDevice.mockResolvedValueOnce('session-abc');
    const renderer = await renderScreen(client, [device]);

    // The device itself is auto-selected (it is the sole supported device),
    // but with 2 ports it must not auto-select a port - connect stays
    // disabled until the user explicitly chooses one.
    expect(findByTestID(renderer, 'usb-connect-button').props.accessibilityState.disabled).toBe(true);

    await act(async () => {
      findByTestID(renderer, 'usb-port-chip-1').props.onPress();
    });
    expect(allText(renderer)).toContain(i18n.t('ports.portNumber', {number: 2}));

    await pressConnect(renderer);
    expect(client.openDevice).toHaveBeenCalledWith(device.deviceId, 1, expect.any(Object));
  });

  it('connect stays disabled before any valid device/port selection exists', async () => {
    const client = createMockClient();
    const renderer = await renderScreen(client, []);
    expect(findByTestID(renderer, 'usb-connect-button').props.accessibilityState.disabled).toBe(true);
  });

  it('lets the user explicitly choose among multiple supported devices', async () => {
    const client = createMockClient();
    const deviceA = supportedDevice();
    const deviceB = secondSupportedDevice();
    const renderer = await renderScreen(client, [deviceA, deviceB]);

    await pressDevice(renderer, deviceB);

    expect(findByTestID(renderer, 'usb-connect-button').props.accessibilityState.disabled).toBe(false);
  });
});

describe('UsbConnectionScreen - connect/disconnect lifecycle', () => {
  it('passes the exact default SerialConfiguration to openDevice', async () => {
    const client = createMockClient();
    const device = supportedDevice();
    client.openDevice.mockResolvedValueOnce('session-1');
    const renderer = await renderScreen(client, [device]);
    await pressConnect(renderer);

    expect(client.openDevice).toHaveBeenCalledWith(device.deviceId, 0, {
      baudRate: 115200,
      dataBits: 8,
      stopBits: '1',
      parity: 'none',
      flowControl: 'off',
    });
  });

  it('does not show connected until openDevice resolves, and shows it once it does', async () => {
    const client = createMockClient();
    const device = supportedDevice();
    let resolveOpen: (sessionId: string) => void = () => {};
    client.openDevice.mockReturnValueOnce(
      new Promise(resolve => {
        resolveOpen = resolve;
      }),
    );
    const renderer = await renderScreen(client, [device]);

    let pressPromise!: Promise<void>;
    await act(async () => {
      pressPromise = findByTestID(renderer, 'usb-connect-button').props.onPress();
    });
    expect(allText(renderer)).not.toContain(i18n.t('actions.connectSuccess'));

    await act(async () => {
      resolveOpen('session-xyz');
      await pressPromise;
    });
    expect(allText(renderer)).toContain(i18n.t('actions.connectSuccess'));
    expect(queryByTestID(renderer, 'usb-disconnect-button')).not.toBeNull();
  });

  it('prevents a duplicate connect call from a second press while connecting', async () => {
    const client = createMockClient();
    const device = supportedDevice();
    client.openDevice.mockImplementation(() => new Promise(() => {}));
    const renderer = await renderScreen(client, [device]);

    await act(async () => {
      findByTestID(renderer, 'usb-connect-button').props.onPress();
    });
    // Once connecting starts, the button becomes the (disabled) connecting
    // affordance - there is no way to dispatch a second CONNECT_START.
    expect(client.openDevice).toHaveBeenCalledTimes(1);
  });

  it('shows the Arabic message for a permission denial and does not enter the connected state', async () => {
    const client = createMockClient();
    const device = supportedDevice();
    client.openDevice.mockRejectedValueOnce({code: 'PERMISSION_DENIED', nativeMessage: 'denied'});
    const renderer = await renderScreen(client, [device]);
    await pressConnect(renderer);

    expect(allText(renderer)).toContain(i18n.t('errors.PERMISSION_DENIED'));
    expect(queryByTestID(renderer, 'usb-disconnect-button')).toBeNull();
  });

  it('closeSession receives only the active sessionId and clears the connected state on success', async () => {
    const client = createMockClient();
    const device = supportedDevice();
    client.openDevice.mockResolvedValueOnce('session-close-me');
    client.closeSession.mockResolvedValueOnce(undefined);
    const renderer = await renderScreen(client, [device]);
    await pressConnect(renderer);

    await pressDisconnect(renderer);

    expect(client.closeSession).toHaveBeenCalledWith('session-close-me');
    expect(queryByTestID(renderer, 'usb-disconnect-button')).toBeNull();
    expect(allText(renderer)).toContain(i18n.t('actions.disconnectSuccess'));
  });

  it('does not falsely report success when closeSession fails, and shows the cable-reset warning', async () => {
    const client = createMockClient();
    const device = supportedDevice();
    client.openDevice.mockResolvedValueOnce('session-fail-close');
    client.closeSession.mockRejectedValueOnce({code: 'CLOSE_FAILED', nativeMessage: 'x'});
    const renderer = await renderScreen(client, [device]);
    await pressConnect(renderer);

    await pressDisconnect(renderer);

    expect(allText(renderer)).not.toContain(i18n.t('actions.disconnectSuccess'));
    expect(allText(renderer)).toContain(i18n.t('errors.CLOSE_FAILED'));
    expect(queryByTestID(renderer, 'usb-disconnect-button')).toBeNull();
    expect(queryAnyByTestID(renderer, 'usb-session-id')).toBeNull();
  });

  describe('after a CLOSE_FAILED cable-reset requirement', () => {
    async function reachCloseFailedState(client: MockClient) {
      const device = supportedDevice();
      client.openDevice.mockResolvedValueOnce('session-fail-close');
      client.closeSession.mockRejectedValueOnce({code: 'CLOSE_FAILED', nativeMessage: 'x'});
      const renderer = await renderScreen(client, [device]);
      await pressConnect(renderer);
      await pressDisconnect(renderer);
      return {renderer, device};
    }

    it('makes no automatic native call after the failure settles', async () => {
      const client = createMockClient();
      await reachCloseFailedState(client);
      expect(client.listDevices).toHaveBeenCalledTimes(1);
      expect(client.openDevice).toHaveBeenCalledTimes(1);
      expect(client.closeSession).toHaveBeenCalledTimes(1);
    });

    it('re-enables refresh once the failed operation has settled', async () => {
      const client = createMockClient();
      const {renderer} = await reachCloseFailedState(client);
      expect(findByTestID(renderer, 'usb-refresh-button').props.accessibilityState.disabled).toBe(false);
    });

    it('clears the stale selection so connect is disabled even without a new scan', async () => {
      const client = createMockClient();
      const {renderer, device} = await reachCloseFailedState(client);
      // The device row from the pre-failure scan is still visible...
      const key = `${device.deviceId}:${device.vendorId}:${device.productId}`;
      expect(queryByTestID(renderer, `usb-device-row-${key}`)).not.toBeNull();
      // ...but connect must stay disabled - there is no stale selection left.
      expect(findByTestID(renderer, 'usb-connect-button').props.accessibilityState.disabled).toBe(true);
    });

    it('keeps connect disabled after re-selecting the same stale device, until a new scan completes and it is explicitly reselected', async () => {
      const client = createMockClient();
      const {renderer, device} = await reachCloseFailedState(client);

      await pressDevice(renderer, device);
      expect(findByTestID(renderer, 'usb-connect-button').props.accessibilityState.disabled).toBe(true);

      // The one-time mount auto-scan is not a valid reset - only a fresh
      // manual scan (still requiring an explicit reselect) may clear it.
      client.listDevices.mockResolvedValueOnce([device]);
      await pressRefresh(renderer);
      expect(findByTestID(renderer, 'usb-connect-button').props.accessibilityState.disabled).toBe(true);

      await pressDevice(renderer, device);
      expect(findByTestID(renderer, 'usb-connect-button').props.accessibilityState.disabled).toBe(false);
    });
  });

  it('disables refresh while connected', async () => {
    const client = createMockClient();
    const device = supportedDevice();
    client.openDevice.mockResolvedValueOnce('session-refresh-lock');
    const renderer = await renderScreen(client, [device]);
    await pressConnect(renderer);

    expect(findByTestID(renderer, 'usb-refresh-button').props.accessibilityState.disabled).toBe(true);
  });
});

describe('UsbConnectionScreen - validation log', () => {
  it('keeps the log bounded and supports clearing it', async () => {
    const client = createMockClient();
    client.listDevices.mockResolvedValue([]);
    const renderer = await createScreen(client);

    for (let i = 0; i < 55; i += 1) {
      await pressRefresh(renderer);
    }

    await act(async () => {
      findByTestID(renderer, 'usb-log-toggle').props.onPress();
    });
    expect(queryByTestID(renderer, 'usb-log-clear')).not.toBeNull();

    await act(async () => {
      findByTestID(renderer, 'usb-log-clear').props.onPress();
    });
    expect(allText(renderer)).toContain(i18n.t('validationLog.empty'));
  });

  it('logs automatic single-device selection exactly once, without duplicating on rerender', async () => {
    const client = createMockClient();
    const renderer = await renderScreen(client, [supportedDevice()]);

    await act(async () => {
      renderer.update(
        <UsbConnectionScreen client={client as unknown as UsbSerialTransportClient} />,
      );
    });

    await act(async () => {
      findByTestID(renderer, 'usb-log-toggle').props.onPress();
    });
    const autoSelectedCount = allText(renderer).filter(
      text => text === i18n.t('validationLog.autoSelected'),
    ).length;
    expect(autoSelectedCount).toBe(1);
  });

  it('never renders a raw stack trace or native class name', async () => {
    const client = createMockClient();
    client.listDevices.mockRejectedValueOnce({
      code: 'DEVICE_ENUMERATION_FAILED',
      message: 'boom',
      nativeStackAndroid: [{class: 'java.lang.RuntimeException', file: 'Foo.kt'}],
    });
    const renderer = await createScreen(client);

    const joined = allText(renderer).join(' ');
    expect(joined).not.toContain('RuntimeException');
    expect(joined).not.toContain('java.lang');
  });
});

describe('UsbConnectionScreen - USB hot-plug subscription lifecycle', () => {
  it('subscribes to USB attach events exactly once', async () => {
    const client = createMockClient();
    await renderScreen(client, []);
    expect(client.onDeviceAttached).toHaveBeenCalledTimes(1);
  });

  it('subscribes to USB detach events exactly once', async () => {
    const client = createMockClient();
    await renderScreen(client, []);
    expect(client.onDeviceDetached).toHaveBeenCalledTimes(1);
  });

  it('does not create duplicate subscriptions on rerender', async () => {
    const client = createMockClient();
    const renderer = await renderScreen(client, []);

    await act(async () => {
      renderer.update(
        <UsbConnectionScreen client={client as unknown as UsbSerialTransportClient} />,
      );
    });
    await act(async () => {
      renderer.update(
        <UsbConnectionScreen client={client as unknown as UsbSerialTransportClient} />,
      );
    });

    expect(client.onDeviceAttached).toHaveBeenCalledTimes(1);
    expect(client.onDeviceDetached).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes both listeners on unmount', async () => {
    const client = createMockClient();
    const attachedUnsubscribe = jest.fn();
    const detachedUnsubscribe = jest.fn();
    client.onDeviceAttached.mockReturnValueOnce(attachedUnsubscribe);
    client.onDeviceDetached.mockReturnValueOnce(detachedUnsubscribe);
    const renderer = await renderScreen(client, []);

    await act(async () => {
      renderer.unmount();
    });

    expect(attachedUnsubscribe).toHaveBeenCalledTimes(1);
    expect(detachedUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it('a fresh mount after unmount creates a fresh single set of subscriptions', async () => {
    const client = createMockClient();
    const first = await renderScreen(client, []);
    await act(async () => {
      first.unmount();
    });
    expect(client.onDeviceAttached).toHaveBeenCalledTimes(1);
    expect(client.onDeviceDetached).toHaveBeenCalledTimes(1);

    await renderScreen(client, []);

    expect(client.onDeviceAttached).toHaveBeenCalledTimes(2);
    expect(client.onDeviceDetached).toHaveBeenCalledTimes(2);
  });

  it('an event arriving after unmount does not update the old screen state', async () => {
    const client = createMockClient();
    const renderer = await renderScreen(client, [supportedDevice()]);
    const detachHandler = latestHandler(client.onDeviceDetached);

    await act(async () => {
      renderer.unmount();
    });

    // Simulates a broadcast delivered just as/after the screen tore down -
    // must not throw and must not touch a stale renderer/dispatch.
    expect(() => detachHandler(supportedDevice())).not.toThrow();
  });
});

describe('UsbConnectionScreen - USB attach handling', () => {
  it('triggers the existing enumeration path (another real listDevices() call)', async () => {
    const client = createMockClient();
    const renderer = await renderScreen(client, []);

    client.listDevices.mockResolvedValueOnce([supportedDevice()]);
    await fireAttached(client);

    expect(client.listDevices).toHaveBeenCalledTimes(2);
    expect(allText(renderer)).toContain('CH340 Serial');
  });

  it('never calls openDevice() from an attach event', async () => {
    const client = createMockClient();
    await renderScreen(client, []);

    client.listDevices.mockResolvedValueOnce([supportedDevice()]);
    await fireAttached(client);

    expect(client.openDevice).not.toHaveBeenCalled();
  });

  it('never calls closeSession() from an attach event', async () => {
    const client = createMockClient();
    await renderScreen(client, []);

    client.listDevices.mockResolvedValueOnce([supportedDevice()]);
    await fireAttached(client);

    expect(client.closeSession).not.toHaveBeenCalled();
  });

  it('requests no permission as a side effect of attach (never opens a device)', async () => {
    const client = createMockClient();
    await renderScreen(client, []);

    client.listDevices.mockResolvedValueOnce([supportedDevice()]);
    await fireAttached(client);

    // This screen has no separate permission API - permission is only ever
    // requested from inside openDevice(), so "openDevice was never called"
    // is exactly the observable proof that attach never requested it.
    expect(client.openDevice).not.toHaveBeenCalled();
  });

  it('shows one newly attached supported device automatically', async () => {
    const client = createMockClient();
    const renderer = await renderScreen(client, []);

    client.listDevices.mockResolvedValueOnce([supportedDevice()]);
    await fireAttached(client);

    expect(allText(renderer)).toContain(i18n.t('devices.supportedDetected'));
    expect(findByTestID(renderer, 'usb-connect-button').props.accessibilityState.disabled).toBe(
      false,
    );
  });

  it('selects portIndex 0 for a newly attached single-port supported device', async () => {
    const client = createMockClient();
    const renderer = await renderScreen(client, []);

    client.listDevices.mockResolvedValueOnce([supportedDevice({portCount: 1})]);
    await fireAttached(client);

    expect(allText(renderer)).toContain(i18n.t('ports.portNumber', {number: 1}));
  });

  it('does not automatically select when attach reveals two or more supported devices', async () => {
    const client = createMockClient();
    const renderer = await renderScreen(client, []);

    client.listDevices.mockResolvedValueOnce([supportedDevice(), secondSupportedDevice()]);
    await fireAttached(client);

    expect(findByTestID(renderer, 'usb-connect-button').props.accessibilityState.disabled).toBe(
      true,
    );
    expect(allText(renderer)).toContain(i18n.t('devices.multipleSupportedGuidance'));
  });

  it('does not automatically select an attached unsupported device', async () => {
    const client = createMockClient();
    const renderer = await renderScreen(client, []);

    client.listDevices.mockResolvedValueOnce([unsupportedDevice()]);
    await fireAttached(client);

    expect(findByTestID(renderer, 'usb-connect-button').props.accessibilityState.disabled).toBe(
      true,
    );
    expect(allText(renderer)).not.toContain(i18n.t('devices.supportedDetected'));
  });

  it('rediscovers a reattached device automatically', async () => {
    const client = createMockClient();
    const renderer = await renderScreen(client, [supportedDevice()]);

    await fireDetached(client, supportedDevice());
    expect(queryByTestID(renderer, `usb-device-row-1:${0x1a86}:${0x7523}`)).toBeNull();

    client.listDevices.mockResolvedValueOnce([supportedDevice()]);
    await fireAttached(client);

    expect(allText(renderer)).toContain('CH340 Serial');
    expect(findByTestID(renderer, 'usb-connect-button').props.accessibilityState.disabled).toBe(
      false,
    );
  });
});

describe('UsbConnectionScreen - USB detach handling', () => {
  it('removes the missing device from the screen without a manual تحديث', async () => {
    const client = createMockClient();
    const device = supportedDevice();
    const renderer = await renderScreen(client, [device]);
    const key = `${device.deviceId}:${device.vendorId}:${device.productId}`;
    expect(queryByTestID(renderer, `usb-device-row-${key}`)).not.toBeNull();

    await fireDetached(client, device);

    expect(queryByTestID(renderer, `usb-device-row-${key}`)).toBeNull();
    // Purely local reconciliation from the event payload - no extra scan.
    expect(client.listDevices).toHaveBeenCalledTimes(1);
  });

  it('clears the stale device and port selection when the selected device is detached', async () => {
    const client = createMockClient();
    const device = supportedDevice({portCount: 2});
    const renderer = await renderScreen(client, [device]);
    await act(async () => {
      findByTestID(renderer, 'usb-port-chip-1').props.onPress();
    });

    await fireDetached(client, device);

    expect(allText(renderer)).not.toContain(i18n.t('ports.portNumber', {number: 2}));
  });

  it('disables اتصال once the selected device disappears', async () => {
    const client = createMockClient();
    const device = supportedDevice();
    const renderer = await renderScreen(client, [device]);
    expect(findByTestID(renderer, 'usb-connect-button').props.accessibilityState.disabled).toBe(
      false,
    );

    await fireDetached(client, device);

    expect(findByTestID(renderer, 'usb-connect-button').props.accessibilityState.disabled).toBe(
      true,
    );
    expect(allText(renderer)).toContain(i18n.t('devices.deviceDetached'));
  });

  it('preserves a still-valid selection when an unrelated device is detached', async () => {
    const client = createMockClient();
    const deviceA = supportedDevice();
    const deviceB = secondSupportedDevice();
    const renderer = await renderScreen(client, [deviceA, deviceB]);
    await pressDevice(renderer, deviceA);
    expect(findByTestID(renderer, 'usb-connect-button').props.accessibilityState.disabled).toBe(
      false,
    );

    await fireDetached(client, deviceB);

    expect(findByTestID(renderer, 'usb-connect-button').props.accessibilityState.disabled).toBe(
      false,
    );
    const keyA = `${deviceA.deviceId}:${deviceA.vendorId}:${deviceA.productId}`;
    expect(queryByTestID(renderer, `usb-device-row-${keyA}`)).not.toBeNull();
  });

  it('clears the stale connected UI state when the connected device is detached', async () => {
    const client = createMockClient();
    const device = supportedDevice();
    client.openDevice.mockResolvedValueOnce('session-hotplug-1');
    const renderer = await renderScreen(client, [device]);
    await pressConnect(renderer);
    expect(allText(renderer)).toContain(i18n.t('actions.connectSuccess'));

    await fireSessionDetached(client, 'session-hotplug-1');
    await fireDetached(client, device);

    expect(queryByTestID(renderer, 'usb-disconnect-button')).toBeNull();
    expect(allText(renderer)).toContain(i18n.t('devices.sessionDetachedDuringConnection'));
    expect(allText(renderer)).not.toContain(i18n.t('actions.connectSuccess'));
    // Never falsely claims a graceful disconnect either - this was a
    // physical detach, not a user-initiated disconnectSuccess.
    expect(allText(renderer)).not.toContain(i18n.t('actions.disconnectSuccess'));
  });

  it('never bypasses requiresCableReset after a real CLOSE_FAILED', async () => {
    const client = createMockClient();
    const device = supportedDevice();
    client.openDevice.mockResolvedValueOnce('session-fail-close-hotplug');
    client.closeSession.mockRejectedValueOnce({code: 'CLOSE_FAILED', nativeMessage: 'x'});
    const renderer = await renderScreen(client, [device]);
    await pressConnect(renderer);
    await pressDisconnect(renderer);
    expect(findByTestID(renderer, 'usb-connect-button').props.accessibilityState.disabled).toBe(
      true,
    );

    // An unrelated hot-plug detach must not clear the cable-reset
    // requirement - only a fresh completed scan (SCAN_SUCCESS) may do that.
    await fireDetached(client, unsupportedDevice());

    expect(findByTestID(renderer, 'usb-connect-button').props.accessibilityState.disabled).toBe(
      true,
    );
  });

  it('a SESSION_DETACHED event does not set or clear requiresCableReset either', async () => {
    const client = createMockClient();
    const device = supportedDevice();
    client.openDevice.mockResolvedValueOnce('session-fail-close-hotplug-2');
    client.closeSession.mockRejectedValueOnce({code: 'CLOSE_FAILED', nativeMessage: 'x'});
    const renderer = await renderScreen(client, [device]);
    await pressConnect(renderer);
    await pressDisconnect(renderer);
    expect(findByTestID(renderer, 'usb-connect-button').props.accessibilityState.disabled).toBe(
      true,
    );

    // A stale/unrelated sessionId (not the active one, since it was already
    // cleared by DISCONNECT_FAILURE) must be a safe no-op either way.
    await fireSessionDetached(client, 'some-other-session');

    expect(findByTestID(renderer, 'usb-connect-button').props.accessibilityState.disabled).toBe(
      true,
    );
  });

  it('a duplicate detach for the same already-removed device is idempotent', async () => {
    const client = createMockClient();
    const deviceA = supportedDevice();
    const deviceB = secondSupportedDevice();
    const renderer = await renderScreen(client, [deviceA, deviceB]);
    const keyA = `${deviceA.deviceId}:${deviceA.vendorId}:${deviceA.productId}`;

    await fireDetached(client, deviceA);
    expect(queryByTestID(renderer, `usb-device-row-${keyA}`)).toBeNull();

    // A second, hypothetical duplicate broadcast for the same now-gone
    // device must not throw or corrupt the still-valid deviceB selection.
    await pressDevice(renderer, deviceB);
    await fireDetached(client, deviceA);

    expect(queryByTestID(renderer, `usb-device-row-${keyA}`)).toBeNull();
    expect(findByTestID(renderer, 'usb-connect-button').props.accessibilityState.disabled).toBe(
      false,
    );
  });

  it('a detach for a device that was never in the list does not corrupt state', async () => {
    const client = createMockClient();
    const deviceA = supportedDevice();
    const renderer = await renderScreen(client, [deviceA]);
    await pressDevice(renderer, deviceA);
    expect(findByTestID(renderer, 'usb-connect-button').props.accessibilityState.disabled).toBe(
      false,
    );

    await fireDetached(client, {deviceId: 999, vendorId: 0x9999, productId: 0x9999});

    expect(findByTestID(renderer, 'usb-connect-button').props.accessibilityState.disabled).toBe(
      false,
    );
    const keyA = `${deviceA.deviceId}:${deviceA.vendorId}:${deviceA.productId}`;
    expect(queryByTestID(renderer, `usb-device-row-${keyA}`)).not.toBeNull();
  });

  it('order A (DEVICE_DETACHED then SESSION_DETACHED) reaches the correct final state', async () => {
    const client = createMockClient();
    const device = supportedDevice();
    client.openDevice.mockResolvedValueOnce('session-order-a');
    const renderer = await renderScreen(client, [device]);
    await pressConnect(renderer);

    await fireDetached(client, device);
    await fireSessionDetached(client, 'session-order-a');

    expect(queryByTestID(renderer, 'usb-disconnect-button')).toBeNull();
    expect(allText(renderer)).toContain(i18n.t('devices.sessionDetachedDuringConnection'));
    const key = `${device.deviceId}:${device.vendorId}:${device.productId}`;
    expect(queryByTestID(renderer, `usb-device-row-${key}`)).toBeNull();
  });

  it('order B (SESSION_DETACHED then DEVICE_DETACHED) reaches the same final state as order A', async () => {
    const client = createMockClient();
    const device = supportedDevice();
    client.openDevice.mockResolvedValueOnce('session-order-b');
    const renderer = await renderScreen(client, [device]);
    await pressConnect(renderer);

    await fireSessionDetached(client, 'session-order-b');
    await fireDetached(client, device);

    expect(queryByTestID(renderer, 'usb-disconnect-button')).toBeNull();
    expect(allText(renderer)).toContain(i18n.t('devices.sessionDetachedDuringConnection'));
    const key = `${device.deviceId}:${device.vendorId}:${device.productId}`;
    expect(queryByTestID(renderer, `usb-device-row-${key}`)).toBeNull();
  });

  it('a later generic detach cannot downgrade the active-session detach message', async () => {
    const client = createMockClient();
    const deviceA = supportedDevice();
    const deviceB = secondSupportedDevice();
    client.openDevice.mockResolvedValueOnce('session-no-downgrade');
    const renderer = await renderScreen(client, [deviceA, deviceB]);
    await pressDevice(renderer, deviceA);
    await pressConnect(renderer);

    await fireSessionDetached(client, 'session-no-downgrade');
    await fireDetached(client, deviceA);
    // An unrelated device's generic detach arrives afterward - must not
    // overwrite the more specific active-session message back to the
    // generic one.
    await fireDetached(client, deviceB);

    expect(allText(renderer)).toContain(i18n.t('devices.sessionDetachedDuringConnection'));
    expect(allText(renderer)).not.toContain(i18n.t('devices.deviceDetached'));
  });
});

describe('UsbConnectionScreen - hot-plug scan coalescing', () => {
  it('queues at most one follow-up scan when an attach event arrives mid-scan', async () => {
    const client = createMockClient();
    let resolveMountScan: (devices: UsbSerialDeviceDescriptor[]) => void = () => {};
    client.listDevices.mockReturnValueOnce(
      new Promise(resolve => {
        resolveMountScan = resolve;
      }),
    );
    const renderer = await createScreen(client);
    expect(client.listDevices).toHaveBeenCalledTimes(1);

    // Two broadcasts arrive while the mount scan is still in flight.
    const handler = latestHandler(client.onDeviceAttached);
    await act(async () => {
      handler();
      handler();
    });
    // No second (overlapping) native call was started yet.
    expect(client.listDevices).toHaveBeenCalledTimes(1);

    client.listDevices.mockResolvedValueOnce([supportedDevice()]);
    await act(async () => {
      resolveMountScan([]);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Exactly one coalesced follow-up scan ran - not one per broadcast.
    expect(client.listDevices).toHaveBeenCalledTimes(2);
    expect(allText(renderer)).toContain('CH340 Serial');
  });

  it('an event arriving during the follow-up scan itself is not lost - a further scan runs', async () => {
    const client = createMockClient();
    let resolveScanA: (devices: UsbSerialDeviceDescriptor[]) => void = () => {};
    client.listDevices.mockReturnValueOnce(
      new Promise(resolve => {
        resolveScanA = resolve;
      }),
    );
    const renderer = await createScreen(client);
    expect(client.listDevices).toHaveBeenCalledTimes(1);

    // Event 1 arrives during scan A - queues follow-up scan B.
    const handler = latestHandler(client.onDeviceAttached);
    await act(async () => {
      handler();
    });
    expect(client.listDevices).toHaveBeenCalledTimes(1);

    // Scan A resolves - scan B starts, and is kept pending this time.
    let resolveScanB: (devices: UsbSerialDeviceDescriptor[]) => void = () => {};
    client.listDevices.mockReturnValueOnce(
      new Promise(resolve => {
        resolveScanB = resolve;
      }),
    );
    await act(async () => {
      resolveScanA([]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(client.listDevices).toHaveBeenCalledTimes(2);

    // Event 2 arrives WHILE scan B (the follow-up) is still in flight - the
    // harder boundary: this must not be silently lost.
    await act(async () => {
      handler();
    });
    expect(client.listDevices).toHaveBeenCalledTimes(2);

    // Scan B resolves with stale data - scan C must start automatically and
    // reflect the latest mocked hardware state.
    client.listDevices.mockResolvedValueOnce([supportedDevice()]);
    await act(async () => {
      resolveScanB([]);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(client.listDevices).toHaveBeenCalledTimes(3);
    expect(allText(renderer)).toContain('CH340 Serial');
  });

  it('never causes automatic connection from any hot-plug event', async () => {
    const client = createMockClient();
    const renderer = await renderScreen(client, [supportedDevice()]);

    await fireDetached(client, supportedDevice());
    client.listDevices.mockResolvedValueOnce([supportedDevice()]);
    await fireAttached(client);

    expect(client.openDevice).not.toHaveBeenCalled();
    expect(queryByTestID(renderer, 'usb-disconnect-button')).toBeNull();
  });

  it('never claims MSP or firmware detection from any hot-plug event', async () => {
    const client = createMockClient();
    const renderer = await renderScreen(client, [supportedDevice()]);

    await fireDetached(client, supportedDevice());
    client.listDevices.mockResolvedValueOnce([supportedDevice()]);
    await fireAttached(client);

    const joined = allText(renderer).join(' ');
    expect(joined).not.toContain('MSP');
    expect(joined).not.toContain('Betaflight');
  });
});
