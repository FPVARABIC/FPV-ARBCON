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
};

function createMockClient(): MockClient {
  return {
    listDevices: jest.fn(),
    openDevice: jest.fn(),
    closeSession: jest.fn(),
  };
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

async function renderScreen(client: MockClient) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <UsbConnectionScreen client={client as unknown as UsbSerialTransportClient} />,
    );
  });
  return renderer;
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

describe('UsbConnectionScreen - initial state', () => {
  it('renders the Arabic connection instruction before any scan', async () => {
    const client = createMockClient();
    const renderer = await renderScreen(client);
    expect(allText(renderer)).toContain(i18n.t('connection.instructionPrimary'));
    expect(client.listDevices).not.toHaveBeenCalled();
  });

  it('shows the not-scanned-yet prompt and never the no-device-found text before any scan', async () => {
    const client = createMockClient();
    const renderer = await renderScreen(client);
    const texts = allText(renderer);
    expect(texts).toContain(i18n.t('devices.notScannedPrompt'));
    expect(texts).not.toContain(i18n.t('devices.emptyPrimary'));
  });

  it('does not render the device empty-state until a scan has completed', async () => {
    const client = createMockClient();
    const renderer = await renderScreen(client);
    expect(allText(renderer)).not.toContain(i18n.t('devices.emptyPrimary'));
  });
});

describe('UsbConnectionScreen - scanning', () => {
  it('shows the scanning text (and not the not-scanned prompt) while listDevices is pending', async () => {
    const client = createMockClient();
    let resolveList: (devices: UsbSerialDeviceDescriptor[]) => void = () => {};
    client.listDevices.mockReturnValueOnce(
      new Promise(resolve => {
        resolveList = resolve;
      }),
    );
    const renderer = await renderScreen(client);

    let pressPromise!: Promise<void>;
    await act(async () => {
      pressPromise = findByTestID(renderer, 'usb-refresh-button').props.onPress();
    });

    const duringScanTexts = allText(renderer);
    expect(duringScanTexts).toContain(i18n.t('devices.scanning'));
    expect(duringScanTexts).not.toContain(i18n.t('devices.notScannedPrompt'));
    expect(duringScanTexts).not.toContain(i18n.t('devices.emptyPrimary'));

    await act(async () => {
      resolveList([]);
      await pressPromise;
    });
    expect(allText(renderer)).toContain(i18n.t('devices.emptyPrimary'));
  });

  it('calls listDevices exactly once on refresh and shows the empty state only after a completed scan finds zero devices', async () => {
    const client = createMockClient();
    client.listDevices.mockResolvedValueOnce([]);
    const renderer = await renderScreen(client);

    await pressRefresh(renderer);

    expect(client.listDevices).toHaveBeenCalledTimes(1);
    expect(allText(renderer)).toContain(i18n.t('devices.emptyPrimary'));
  });

  it('renders a found device with its VID/PID/driverType/portCount', async () => {
    const client = createMockClient();
    client.listDevices.mockResolvedValueOnce([supportedDevice()]);
    const renderer = await renderScreen(client);

    await pressRefresh(renderer);

    const texts = allText(renderer);
    expect(texts).toContain('CH340 Serial');
    expect(texts).toContain('0x1A86');
    expect(texts).toContain('0x7523');
    expect(texts).toContain('CH34X');
  });

  it('shows an unsupported device but does not allow selecting it', async () => {
    const client = createMockClient();
    const device = unsupportedDevice();
    client.listDevices.mockResolvedValueOnce([device]);
    const renderer = await renderScreen(client);

    await pressRefresh(renderer);

    expect(allText(renderer)).toContain(i18n.t('devices.unsupported'));
    const row = findByTestID(renderer, `usb-device-row-${device.deviceId}:${device.vendorId}:${device.productId}`);
    expect(row.props.onPress).toBeUndefined();
  });
});

describe('UsbConnectionScreen - device/port selection', () => {
  it('auto-selects native portIndex 0 for a single-port device and enables connect', async () => {
    const client = createMockClient();
    const device = supportedDevice({portCount: 1});
    client.listDevices.mockResolvedValueOnce([device]);
    const renderer = await renderScreen(client);
    await pressRefresh(renderer);
    await pressDevice(renderer, device);

    expect(allText(renderer)).toContain(i18n.t('ports.portNumber', {number: 1}));
    expect(findByTestID(renderer, 'usb-connect-button').props.accessibilityState.disabled).toBe(false);
  });

  it('requires an explicit port choice for a multi-port device and maps 1-based labels to 0-based portIndex', async () => {
    const client = createMockClient();
    const device = supportedDevice({portCount: 2});
    client.listDevices.mockResolvedValueOnce([device]);
    client.openDevice.mockResolvedValueOnce('session-abc');
    const renderer = await renderScreen(client);
    await pressRefresh(renderer);
    await pressDevice(renderer, device);

    // Not yet connectable - no port chosen.
    expect(findByTestID(renderer, 'usb-connect-button').props.accessibilityState.disabled).toBe(true);

    await act(async () => {
      findByTestID(renderer, 'usb-port-chip-1').props.onPress();
    });
    expect(allText(renderer)).toContain(i18n.t('ports.portNumber', {number: 2}));

    await pressConnect(renderer);
    expect(client.openDevice).toHaveBeenCalledWith(device.deviceId, 1, expect.any(Object));
  });

  it('connect stays disabled before a valid device/port selection exists', async () => {
    const client = createMockClient();
    const renderer = await renderScreen(client);
    expect(findByTestID(renderer, 'usb-connect-button').props.accessibilityState.disabled).toBe(true);
  });
});

describe('UsbConnectionScreen - connect/disconnect lifecycle', () => {
  it('passes the exact default SerialConfiguration to openDevice', async () => {
    const client = createMockClient();
    const device = supportedDevice();
    client.listDevices.mockResolvedValueOnce([device]);
    client.openDevice.mockResolvedValueOnce('session-1');
    const renderer = await renderScreen(client);
    await pressRefresh(renderer);
    await pressDevice(renderer, device);
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
    client.listDevices.mockResolvedValueOnce([device]);
    let resolveOpen: (sessionId: string) => void = () => {};
    client.openDevice.mockReturnValueOnce(
      new Promise(resolve => {
        resolveOpen = resolve;
      }),
    );
    const renderer = await renderScreen(client);
    await pressRefresh(renderer);
    await pressDevice(renderer, device);

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
    client.listDevices.mockResolvedValueOnce([device]);
    client.openDevice.mockImplementation(() => new Promise(() => {}));
    const renderer = await renderScreen(client);
    await pressRefresh(renderer);
    await pressDevice(renderer, device);

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
    client.listDevices.mockResolvedValueOnce([device]);
    client.openDevice.mockRejectedValueOnce({code: 'PERMISSION_DENIED', nativeMessage: 'denied'});
    const renderer = await renderScreen(client);
    await pressRefresh(renderer);
    await pressDevice(renderer, device);
    await pressConnect(renderer);

    expect(allText(renderer)).toContain(i18n.t('errors.PERMISSION_DENIED'));
    expect(queryByTestID(renderer, 'usb-disconnect-button')).toBeNull();
  });

  it('closeSession receives only the active sessionId and clears the connected state on success', async () => {
    const client = createMockClient();
    const device = supportedDevice();
    client.listDevices.mockResolvedValueOnce([device]);
    client.openDevice.mockResolvedValueOnce('session-close-me');
    client.closeSession.mockResolvedValueOnce(undefined);
    const renderer = await renderScreen(client);
    await pressRefresh(renderer);
    await pressDevice(renderer, device);
    await pressConnect(renderer);

    await pressDisconnect(renderer);

    expect(client.closeSession).toHaveBeenCalledWith('session-close-me');
    expect(queryByTestID(renderer, 'usb-disconnect-button')).toBeNull();
    expect(allText(renderer)).toContain(i18n.t('actions.disconnectSuccess'));
  });

  it('does not falsely report success when closeSession fails, and shows the cable-reset warning', async () => {
    const client = createMockClient();
    const device = supportedDevice();
    client.listDevices.mockResolvedValueOnce([device]);
    client.openDevice.mockResolvedValueOnce('session-fail-close');
    client.closeSession.mockRejectedValueOnce({code: 'CLOSE_FAILED', nativeMessage: 'x'});
    const renderer = await renderScreen(client);
    await pressRefresh(renderer);
    await pressDevice(renderer, device);
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
      client.listDevices.mockResolvedValueOnce([device]);
      client.openDevice.mockResolvedValueOnce('session-fail-close');
      client.closeSession.mockRejectedValueOnce({code: 'CLOSE_FAILED', nativeMessage: 'x'});
      const renderer = await renderScreen(client);
      await pressRefresh(renderer);
      await pressDevice(renderer, device);
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

    it('keeps connect disabled after re-selecting the same stale device, until a new scan completes', async () => {
      const client = createMockClient();
      const {renderer, device} = await reachCloseFailedState(client);

      await pressDevice(renderer, device);
      expect(findByTestID(renderer, 'usb-connect-button').props.accessibilityState.disabled).toBe(true);

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
    client.listDevices.mockResolvedValueOnce([device]);
    client.openDevice.mockResolvedValueOnce('session-refresh-lock');
    const renderer = await renderScreen(client);
    await pressRefresh(renderer);
    await pressDevice(renderer, device);
    await pressConnect(renderer);

    expect(findByTestID(renderer, 'usb-refresh-button').props.accessibilityState.disabled).toBe(true);
  });
});

describe('UsbConnectionScreen - validation log', () => {
  it('keeps the log bounded and supports clearing it', async () => {
    const client = createMockClient();
    client.listDevices.mockResolvedValue([]);
    const renderer = await renderScreen(client);

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

  it('never renders a raw stack trace or native class name', async () => {
    const client = createMockClient();
    client.listDevices.mockRejectedValueOnce({
      code: 'DEVICE_ENUMERATION_FAILED',
      message: 'boom',
      nativeStackAndroid: [{class: 'java.lang.RuntimeException', file: 'Foo.kt'}],
    });
    const renderer = await renderScreen(client);
    await pressRefresh(renderer);

    const joined = allText(renderer).join(' ');
    expect(joined).not.toContain('RuntimeException');
    expect(joined).not.toContain('java.lang');
  });
});
