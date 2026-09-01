/**
 * CONNECTING FROM HOME, WITH NO PAGE IN BETWEEN.
 *
 * These are the contracts that used to belong to a connection screen.
 * The screen is gone; the contracts are not, because none of them were
 * about pixels:
 *
 *   - a press is the request to connect, and connects;
 *   - NOTHING ELSE connects - not a mount, not a re-render, not a cable
 *     being plugged in. A port must never be seized, and Android's
 *     permission dialog must never be raised, as a side effect;
 *   - the browser chooser opens on the gesture and only on the gesture;
 *   - an ambiguous bench is a question, not a guess;
 *   - a dismissed chooser is a decision, not a failure;
 *   - a live session is adopted, never duplicated.
 *
 * They are asserted against the service itself (useDirectConnect), which
 * is where they now live.
 */

jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

import React from 'react';
import {Text} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';

import '../../i18n';
import type {
  UsbSerialDeviceDescriptor,
  UsbSerialTransportClient,
} from '../../platforms/react-native/transport';
import {mspSessionCoordinator} from '../../platforms/react-native/protocol';
import {useDirectConnect} from './useDirectConnect';
import type {ConnectOption, ConnectPhase} from './connectFlow';

function createMockClient(supportsPicker: boolean) {
  return {
    listDevices: jest.fn(async (): Promise<UsbSerialDeviceDescriptor[]> => []),
    openDevice: jest.fn(
      async (
        _deviceId: number,
        _portIndex: number,
        _configuration: unknown,
      ): Promise<string> => 'session-1',
    ),
    closeSession: jest.fn(async () => undefined),
    requestDevicePermission: jest.fn(
      async (): Promise<UsbSerialDeviceDescriptor | null> => null,
    ),
    supportsDevicePicker: jest.fn(() => supportsPicker),
    onDeviceAttached: jest.fn(() => jest.fn()),
    onDeviceDetached: jest.fn(() => jest.fn()),
    onSessionDetached: jest.fn(() => jest.fn()),
    onDataReceived: jest.fn(() => jest.fn()),
    onError: jest.fn(() => jest.fn()),
    // Permanently pending, so the real MSP session opened by a successful
    // connect can never arm a response timeout that outlives the test.
    writeBytes: jest.fn(() => new Promise<void>(() => undefined)),
    stopReading: jest.fn(() => new Promise<void>(() => undefined)),
    startReading: jest.fn(() => new Promise<void>(() => undefined)),
  };
}
type MockClient = ReturnType<typeof createMockClient>;

function device(
  overrides: Partial<UsbSerialDeviceDescriptor> = {},
): UsbSerialDeviceDescriptor {
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

/** A probe that exposes the service's whole surface to a test. */
let harness: {
  phase: ConnectPhase;
  begin: () => void;
  choose: (option: ConnectOption) => void;
  dismiss: () => void;
};

function Probe({client}: {readonly client: MockClient}) {
  const connect = useDirectConnect(client as unknown as UsbSerialTransportClient);
  harness = connect as typeof harness;
  return <Text>{connect.phase.kind}</Text>;
}

const renderers: ReactTestRenderer.ReactTestRenderer[] = [];
afterEach(() => {
  act(() => {
    for (const renderer of renderers.splice(0, renderers.length)) {
      try {
        renderer.unmount();
      } catch {
        // Already torn down by the test itself - a documented no-op.
      }
    }
  });
  jest.restoreAllMocks();
});

async function mount(client: MockClient) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = ReactTestRenderer.create(<Probe client={client} />);
  });
  renderers.push(renderer);
  return renderer;
}

/** Presses the door and lets every microtask in the chain settle. */
async function press() {
  await act(async () => {
    harness.begin();
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** No board anywhere, so nothing is ever adopted by accident. */
function presentNoLiveSession() {
  jest
    .spyOn(mspSessionCoordinator, 'listSessionIds')
    .mockImplementation(() => []);
}

beforeEach(() => {
  presentNoLiveSession();
});

describe('nothing connects until the operator asks', () => {
  it('mounting the service opens no chooser and no port', async () => {
    const client = createMockClient(true);
    await mount(client);
    expect(client.requestDevicePermission).not.toHaveBeenCalled();
    expect(client.openDevice).not.toHaveBeenCalled();
    expect(client.listDevices).not.toHaveBeenCalled();
  });

  it('a re-render is not a request either', async () => {
    const client = createMockClient(true);
    const renderer = await mount(client);
    await act(async () => {
      renderer.update(<Probe client={client} />);
    });
    expect(client.requestDevicePermission).not.toHaveBeenCalled();
    expect(client.openDevice).not.toHaveBeenCalled();
  });
});

describe('the press is the request, and it connects', () => {
  it('opens the board the operator chose in the browser chooser', async () => {
    const client = createMockClient(true);
    const chosen = device();
    client.requestDevicePermission.mockResolvedValue(chosen);
    client.listDevices.mockResolvedValue([chosen]);
    await mount(client);
    await press();

    expect(client.requestDevicePermission).toHaveBeenCalledTimes(1);
    expect(client.openDevice).toHaveBeenCalledTimes(1);
    expect(client.openDevice.mock.calls[0][0]).toBe(chosen.deviceId);
    expect(client.openDevice.mock.calls[0][1]).toBe(0);
    expect(harness.phase.kind).toBe('IDENTIFYING');
  });

  /**
   * ANDROID HAS NO CHOOSER, and asking for one would be asking for a
   * capability the platform does not have. The system raises its own
   * permission dialog inside open(), which is not gesture-bound.
   */
  it('goes straight to the scan when the client offers no picker', async () => {
    const client = createMockClient(false);
    client.listDevices.mockResolvedValue([device()]);
    await mount(client);
    await press();

    expect(client.requestDevicePermission).not.toHaveBeenCalled();
    expect(client.openDevice).toHaveBeenCalledTimes(1);
  });

  /**
   * ZERO AUTHORIZED PORTS IS A PERMISSION STATE, NOT A MISSING BOARD.
   *
   * navigator.serial.getPorts() returns only what the operator has
   * already authorized, so a first visit legitimately enumerates
   * nothing. The old connection page answered that with "no device
   * found" - a verdict about the hardware, drawn from a fact about the
   * browser. Opening the chooser FIRST makes that misreading
   * structurally impossible: the scan only ever runs against a board the
   * operator has just granted.
   */
  it('asks the browser before it ever concludes there is no board', async () => {
    const client = createMockClient(true);
    const chosen = device();
    client.requestDevicePermission.mockResolvedValue(chosen);
    client.listDevices.mockResolvedValue([chosen]);
    await mount(client);
    await press();

    const chooserCall = client.requestDevicePermission.mock
      .invocationCallOrder[0];
    const scanCall = client.listDevices.mock.invocationCallOrder[0];
    expect(chooserCall).toBeLessThan(scanCall);
    expect(harness.phase.kind).not.toBe('FAILED');
  });

  it('opens exactly one port for a double press', async () => {
    const client = createMockClient(false);
    client.listDevices.mockResolvedValue([device()]);
    await mount(client);
    await act(async () => {
      harness.begin();
      harness.begin();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(client.openDevice).toHaveBeenCalledTimes(1);
  });
});

describe('what it refuses to guess', () => {
  it('asks when two boards are attached', async () => {
    const client = createMockClient(false);
    client.listDevices.mockResolvedValue([
      device({deviceId: 1}),
      device({deviceId: 2, productName: 'FTDI'}),
    ]);
    await mount(client);
    await press();

    expect(client.openDevice).not.toHaveBeenCalled();
    expect(harness.phase.kind).toBe('PICKING');
  });

  it('asks when one board leaves the port ambiguous', async () => {
    const client = createMockClient(false);
    client.listDevices.mockResolvedValue([device({portCount: 2})]);
    await mount(client);
    await press();

    expect(client.openDevice).not.toHaveBeenCalled();
    expect(harness.phase.kind).toBe('PICKING');
  });

  it('opens what the operator picks out of an ambiguous bench', async () => {
    const client = createMockClient(false);
    client.listDevices.mockResolvedValue([
      device({deviceId: 1}),
      device({deviceId: 2}),
    ]);
    await mount(client);
    await press();
    const picking = harness.phase;
    expect(picking.kind).toBe('PICKING');
    if (picking.kind !== 'PICKING') throw new Error('unreachable');

    await act(async () => {
      harness.choose(picking.options[1]);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(client.openDevice).toHaveBeenCalledTimes(1);
    expect(client.openDevice.mock.calls[0][0]).toBe(2);
  });

  it('reports an empty bench rather than opening something else', async () => {
    const client = createMockClient(false);
    client.listDevices.mockResolvedValue([]);
    await mount(client);
    await press();

    expect(client.openDevice).not.toHaveBeenCalled();
    expect(harness.phase.kind).toBe('FAILED');
  });

  it('treats an unsupported device as no device', async () => {
    const client = createMockClient(false);
    client.listDevices.mockResolvedValue([
      device({driverType: 'UNSUPPORTED', portCount: 0}),
    ]);
    await mount(client);
    await press();

    expect(client.openDevice).not.toHaveBeenCalled();
    expect(harness.phase.kind).toBe('FAILED');
  });
});

describe('cancelling and failing both leave the operator where they are', () => {
  /**
   * A DISMISSED CHOOSER IS A DECISION. It is not an error, and above all
   * it is not "this flight controller is unsupported" - so it leaves no
   * message behind at all.
   */
  it('a dismissed chooser returns to idle with nothing to dismiss', async () => {
    const client = createMockClient(true);
    client.requestDevicePermission.mockResolvedValue(null);
    await mount(client);
    await press();

    expect(client.openDevice).not.toHaveBeenCalled();
    expect(harness.phase.kind).toBe('IDLE');
  });

  it('a failed open is reported in Arabic, not swallowed', async () => {
    const client = createMockClient(false);
    client.listDevices.mockResolvedValue([device()]);
    client.openDevice.mockRejectedValue({
      code: 'DEVICE_NOT_FOUND',
      nativeMessage: 'gone',
    });
    await mount(client);
    await press();

    const phase = harness.phase;
    expect(phase.kind).toBe('FAILED');
    if (phase.kind !== 'FAILED') throw new Error('unreachable');
    expect(phase.message.length).toBeGreaterThan(0);
    expect(phase.message).not.toContain('DEVICE_NOT_FOUND');
  });

  it('a failure can be retried, and the retry really re-scans', async () => {
    const client = createMockClient(false);
    client.listDevices.mockResolvedValueOnce([]);
    await mount(client);
    await press();
    expect(harness.phase.kind).toBe('FAILED');

    client.listDevices.mockResolvedValue([device()]);
    await press();
    expect(client.openDevice).toHaveBeenCalledTimes(1);
  });
});

describe('a live session is adopted, never duplicated', () => {
  it('opens no second port when a session is already active', async () => {
    jest
      .spyOn(mspSessionCoordinator, 'listSessionIds')
      .mockImplementation(() => ['live-1']);
    jest
      .spyOn(mspSessionCoordinator, 'getOwnershipState')
      .mockImplementation(() => 'ACTIVE');
    jest
      .spyOn(mspSessionCoordinator, 'getSessionKey')
      .mockImplementation(() => ({sessionId: 'live-1', generation: 1}));

    const client = createMockClient(true);
    await mount(client);
    await press();

    expect(client.requestDevicePermission).not.toHaveBeenCalled();
    expect(client.openDevice).not.toHaveBeenCalled();
    expect(harness.phase.kind).toBe('IDENTIFYING');
  });

  /**
   * A KEY WITH NO sessionId NAMES NOTHING. Adopting one was an infinite
   * loop: the malformed key went into the route, the redirect read it
   * back, found the ownership of `undefined` reported INACTIVE, and
   * reset straight back - forever.
   */
  it('never adopts a session key that names no session', async () => {
    jest
      .spyOn(mspSessionCoordinator, 'listSessionIds')
      .mockImplementation(() => ['live-1']);
    jest
      .spyOn(mspSessionCoordinator, 'getOwnershipState')
      .mockImplementation(() => 'ACTIVE');
    jest
      .spyOn(mspSessionCoordinator, 'getSessionKey')
      .mockImplementation(() => ({generation: 1}) as never);

    const client = createMockClient(true);
    client.requestDevicePermission.mockResolvedValue(null);
    await mount(client);
    await press();

    // It fell through to a real connection attempt instead of adopting.
    expect(client.requestDevicePermission).toHaveBeenCalledTimes(1);
  });
});
