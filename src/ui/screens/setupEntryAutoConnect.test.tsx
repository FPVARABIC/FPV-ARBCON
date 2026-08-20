/**
 * OPENING THE CONFIGURATOR IS THE REQUEST TO CONNECT.
 *
 * Pressing "فتح إعدادات متحكم الطيران" used to land the operator on a full
 * connection page that had already found the one board attached, already
 * selected it, and still waited to be told to connect. The press that got
 * them there was the decision; everything between it and the settings was
 * the app asking again.
 *
 * These tests hold BOTH halves of the fix, because the second is what keeps
 * the first honest:
 *
 *   - the setup workspace connects to an unambiguous board by itself;
 *   - the connection screen on its own still opens nothing without a press.
 *
 * That second contract is why `autoConnectOnEntry` is a prop rather than
 * new default behaviour. A scan, a re-render or a cable being plugged in
 * must never seize a port or raise Android's permission dialog. Only a
 * caller that knows the operator asked to connect may ask for it, and only
 * one caller does.
 */

jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import '../../i18n';
import UsbConnectionScreen from './UsbConnectionScreen';
import type {
  UsbSerialDeviceDescriptor,
  UsbSerialTransportClient,
} from '../../platforms/react-native/transport';

function createMockClient() {
  return {
    listDevices: jest.fn(),
    // Argument types are declared so the assertions below can read
    // .mock.calls[0][0]; an argless jest.fn() infers an empty tuple.
    openDevice: jest.fn(
      async (
        _deviceId: number,
        _portIndex: number,
        _configuration: unknown,
      ): Promise<string> => 'session-1',
    ),
    closeSession: jest.fn(async () => undefined),
    onDeviceAttached: jest.fn((_listener: () => void) => jest.fn()),
    onDeviceDetached: jest.fn((_listener: (event?: unknown) => void) => jest.fn()),
    onSessionDetached: jest.fn((_listener: (event?: unknown) => void) => jest.fn()),
    onDataReceived: jest.fn(() => jest.fn()),
    onError: jest.fn(() => jest.fn()),
    // Permanently pending, so the real MSP session opened on a successful
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
});

async function mount(
  client: MockClient,
  options: {
    readonly devices?: readonly UsbSerialDeviceDescriptor[];
    readonly autoConnect?: boolean;
    readonly onSessionEstablished?: (key: unknown) => void;
  } = {},
) {
  client.listDevices.mockResolvedValueOnce(options.devices ?? []);
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <UsbConnectionScreen
        client={client as unknown as UsbSerialTransportClient}
        autoConnectOnEntry={options.autoConnect ?? false}
        onSessionEstablished={
          options.onSessionEstablished as never | undefined
        }
      />,
    );
  });
  // The entry scan resolves, the auto-connect effect runs, and openDevice
  // settles - all microtasks.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  renderers.push(renderer);
  return renderer;
}

describe('entering the configurator connects to an unambiguous board', () => {
  it('opens the single authorized device with no press at all', async () => {
    const client = createMockClient();
    await mount(client, {devices: [device()], autoConnect: true});

    expect(client.openDevice).toHaveBeenCalledTimes(1);
    // The exact device and its only port - not a guess.
    expect(client.openDevice.mock.calls[0][0]).toBe(1);
    expect(client.openDevice.mock.calls[0][1]).toBe(0);
  });

  it('hands the established session to the host, which is what shows the settings', async () => {
    // Without this the operator would connect and still be looking at the
    // connection workspace - the intermediate screen the fix removes.
    const client = createMockClient();
    const onSessionEstablished = jest.fn();
    await mount(client, {
      devices: [device()],
      autoConnect: true,
      onSessionEstablished,
    });

    expect(onSessionEstablished).toHaveBeenCalledTimes(1);
  });

  it('needs no browser chooser, so no user gesture is required', async () => {
    // getPorts() already returned the device, which on web means the
    // operator authorized it in an earlier visit. requestPort() - the only
    // gesture-bound call - is never reached on this path.
    const client = createMockClient();
    await mount(client, {devices: [device()], autoConnect: true});

    expect(client.listDevices).toHaveBeenCalled();
    expect(
      (client as unknown as {requestPort?: unknown}).requestPort,
    ).toBeUndefined();
  });
});

describe('what it still refuses to do by itself', () => {
  it('opens nothing when the caller did not ask - the standalone contract', async () => {
    const client = createMockClient();
    await mount(client, {devices: [device()]});

    expect(client.openDevice).not.toHaveBeenCalled();
  });

  it('opens nothing when two boards are attached', async () => {
    // Which board is a decision only the operator can make, and picking
    // one for them could energise the wrong aircraft.
    const client = createMockClient();
    await mount(client, {
      devices: [device(), device({deviceId: 3, vendorId: 0x0403, productId: 0x6001})],
      autoConnect: true,
    });

    expect(client.openDevice).not.toHaveBeenCalled();
  });

  it('opens nothing when a multi-port device leaves the port ambiguous', async () => {
    const client = createMockClient();
    await mount(client, {devices: [device({portCount: 4})], autoConnect: true});

    expect(client.openDevice).not.toHaveBeenCalled();
  });

  it('opens nothing when no board is attached on entry', async () => {
    const client = createMockClient();
    await mount(client, {devices: [], autoConnect: true});

    expect(client.openDevice).not.toHaveBeenCalled();
  });

  it('does not connect to a board plugged in AFTER entry', async () => {
    // A cable moving must never raise Android's permission dialog or seize
    // a port. Auto-connect belongs to the operator arriving, not to the
    // hardware changing underneath them.
    const client = createMockClient();
    await mount(client, {devices: [], autoConnect: true});
    expect(client.openDevice).not.toHaveBeenCalled();

    // The attach handler re-scans; this time a device is there.
    client.listDevices.mockResolvedValueOnce([device()]);
    const attach = client.onDeviceAttached.mock.calls.at(-1)?.[0] as
      | (() => void)
      | undefined;
    expect(attach).toBeDefined();
    await act(async () => {
      attach?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(client.openDevice).not.toHaveBeenCalled();
  });

  it('connects at most once, so a deliberate disconnect stays disconnected', async () => {
    // Reconnecting a frame after «قطع الاتصال» would make the control look
    // broken, and could reopen a port the operator closed in order to
    // unplug the board.
    const client = createMockClient();
    const renderer = await mount(client, {
      devices: [device()],
      autoConnect: true,
    });
    expect(client.openDevice).toHaveBeenCalledTimes(1);

    // Any number of further scans must not produce a second open.
    client.listDevices.mockResolvedValue([device()]);
    await act(async () => {
      renderer.update(
        <UsbConnectionScreen
          client={client as unknown as UsbSerialTransportClient}
          autoConnectOnEntry
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(client.openDevice).toHaveBeenCalledTimes(1);
  });
});

describe('the production wiring, not the prop in isolation', () => {
  it('the setup workspace is the caller that asks for it', () => {
    // A component test would pass whether or not the real host passes the
    // flag, so this reads the shipped module.
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const host = fs
      .readFileSync(path.join(__dirname, 'setupSessionHost.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    expect(host).toContain('autoConnectOnEntry');
    expect(host).toContain('UsbConnectionScreen');
  });
});

/**
 * THE RECONNECT LOOP, AND WHY IT IS A SAFETY MATTER RATHER THAN TIDINESS.
 *
 * Auto-connect on entry has one dangerous neighbour: the session-loss
 * redirect, which returns the operator to this same workspace whenever a
 * tracked session dies. Connect on THAT arrival and the shape is a loop -
 * reopen the port, the link dies again, the redirect fires again - which
 * hammers the port, re-raises Android's permission dialog every cycle,
 * and (observed) allocates React fibers until the process is killed.
 *
 * Two independent guards stop it, and both are held here:
 *
 *   1. the redirect marks its own arrival, and a marked arrival does not
 *      auto-connect;
 *   2. a session key with no sessionId names nothing and is never adopted
 *      - the malformed key was what kept re-arming the redirect.
 */
describe('being returned here by a dead link is not a request to reconnect', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const read = (file: string): string =>
    fs
      .readFileSync(path.join(__dirname, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  /**
   * THE STAMP IS NOW CONDITIONAL, AND THE CONDITION IS THE WHOLE POINT.
   *
   * This used to assert the params literal unconditionally, because every
   * session loss was treated identically. That was the defect behind the
   * CLI report: pressing `save` in the CLI makes the flight controller
   * reboot, the session dies BECAUSE THE APPLICATION ASKED IT TO, and the
   * operator was then stamped as a fault victim and made to press Connect
   * - leaving Motors, PID, Ports and the rest holding a session id that
   * named nothing.
   *
   * Both halves are asserted, because dropping either one is a real
   * regression: a fault must still be stamped (or the loop this whole
   * describe block exists to prevent comes back), and an expected reboot
   * must not be (or the original defect comes back).
   */
  it('the redirect stamps a FAULT and does not stamp a reboot we caused', () => {
    const redirect = fs
      .readFileSync(
        path.join(__dirname, '..', '..', 'navigation', 'useSessionLossRedirect.ts'),
        'utf8',
      )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    // The decision is asked of the one module that owns it...
    expect(redirect).toContain(
      'fcRebootRecovery.noteSessionLost(trackedSessionId)',
    );
    // ...it is recorded AT THE MOMENT OF LOSS rather than at the moment
    // of navigation, so a navigator that is not ready yet cannot make a
    // fault look like a reboot (or lose the verdict altogether)...
    expect(redirect).toContain('setPendingReturn({expected})');
    // ...and an unexpected loss is still stamped exactly as before.
    expect(redirect.replace(/\s+/g, ' ')).toContain(
      'params: pendingReturn.expected ? {} : {afterSessionLoss: true}',
    );
  });

  it('a stamped arrival turns auto-connect OFF', () => {
    const setup = read('SetupScreen.tsx');
    expect(setup).toContain(
      'autoConnectOnEntry={route.params?.afterSessionLoss !== true}',
    );
  });

  it('the workspace forwards the caller decision instead of hardcoding it', () => {
    // It used to pass the flag unconditionally, which is what made the
    // redirect's arrival indistinguishable from a chosen one.
    const host = read('setupSessionHost.tsx');
    expect(host).toContain('autoConnectOnEntry={autoConnectOnEntry}');
    expect(host).not.toMatch(/<UsbConnectionScreen[^>]*\n\s*autoConnectOnEntry\s*\n/);
  });

  it('a session key with no sessionId is never adopted', () => {
    // `if (existingKey)` accepted {generation: 1}. Written into the route
    // params, the redirect read it back, found the ownership of undefined
    // INACTIVE, and reset straight back here - for ever.
    const host = read('setupSessionHost.tsx');
    expect(host).toContain("typeof existingKey?.sessionId === 'string'");
    expect(host).toContain('existingKey.sessionId.length > 0');
    expect(host).not.toContain('if (existingKey) {');
  });

  it('the redirect will not track a session id it does not have', () => {
    const redirect = fs
      .readFileSync(
        path.join(__dirname, '..', '..', 'navigation', 'useSessionLossRedirect.ts'),
        'utf8',
      )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(redirect).toContain("typeof params?.sessionKey?.sessionId === 'string'");
    expect(redirect).not.toContain('if (params?.sessionKey) {');
  });
});
