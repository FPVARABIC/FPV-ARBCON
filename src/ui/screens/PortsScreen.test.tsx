import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { Alert, ScrollView } from 'react-native';

import '../../i18n';
import i18n from '../../i18n';
import { serialPortDisplayName } from '../../core/state/serialPortsModel';
import type { MspSerialPortRecord } from '../../core/protocol/msp';
import type { SerialPortsSnapshot } from '../../core/state/serialPortsModel';

jest.mock('../../platforms/react-native/protocol/useMspSessionState', () => ({
  useMspOwnershipState: () => 'ACTIVE',
  useMspIdentificationState: () => ({ status: 'IDLE' }),
  useMspRecoveryState: () => 'READY',
}));

import PortsScreen, { type PortsControllerPort } from './PortsScreen';

const key = { sessionId: 'ports-session', generation: 4 } as const;
const port = (
  identifier: number,
  functionMask: number,
): MspSerialPortRecord => ({
  identifier,
  functionMask,
  mspBaudIndex: 5,
  gpsBaudIndex: 4,
  telemetryBaudIndex: 0,
  blackboxBaudIndex: 5,
  extensionBytes: Uint8Array.from([0xa5]),
});

function snapshot(
  options: Partial<SerialPortsSnapshot> = {},
): SerialPortsSnapshot {
  return Object.freeze({
    ports: Object.freeze([port(20, 1), port(0, 0), port(1, 0)]),
    featureMaskRaw: 0,
    apiVersionMajor: 1,
    apiVersionMinor: 48,
    serialRxProvider: 7,
    buildOptionIds: undefined,
    vtxTableAvailable: true,
    vtxTableConfigured: true,
    ...options,
  });
}

function controllerFor(value = snapshot()): PortsControllerPort & {
  load: jest.MockedFunction<PortsControllerPort['load']>;
  save: jest.MockedFunction<PortsControllerPort['save']>;
} {
  const load = jest.fn<
    ReturnType<PortsControllerPort['load']>,
    Parameters<PortsControllerPort['load']>
  >(async () => ({ kind: 'LOADED', snapshot: value }));
  const save = jest.fn<
    ReturnType<PortsControllerPort['save']>,
    Parameters<PortsControllerPort['save']>
  >(async (_key, original) => ({ kind: 'NO_CHANGES', snapshot: original }));
  return { load, save };
}

async function render(controller: PortsControllerPort, onOpenGps?: () => void) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(
      <PortsScreen
        sessionKey={key}
        controller={controller}
        onOpenGps={onOpenGps}
      />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return {
    renderer,
    find: (testID: string) => renderer.root.findAllByProps({ testID })[0],
    query: (testID: string) => renderer.root.findAllByProps({ testID }),
    press: async (testID: string) => {
      await ReactTestRenderer.act(async () => {
        renderer.root.findAllByProps({ testID })[0].props.onPress();
        await Promise.resolve();
      });
    },
    unmount: () => ReactTestRenderer.act(() => renderer.unmount()),
  };
}

describe('PortsScreen', () => {
  it('shows the assigned GPS port and opens the integrated GPS destination', async () => {
    const onOpenGps = jest.fn();
    const screen = await render(
      controllerFor(
        snapshot({
          ports: Object.freeze([port(20, 1), port(0, 2 ** 1)]),
        }),
      ),
      onOpenGps,
    );
    expect(screen.find('ports-gps-integration')).toBeDefined();
    await screen.press('ports-open-gps');
    expect(onOpenGps).toHaveBeenCalledTimes(1);
    screen.unmount();
  });

  it('renders records loaded from the controller rather than a static port illustration', async () => {
    const controller = controllerFor(
      snapshot({
        ports: Object.freeze([
          port(20, 1),
          port(40, 2 ** 1),
          port(73, 2 ** 10),
        ]),
      }),
    );
    const screen = await render(controller);
    expect(controller.load).toHaveBeenCalledWith(key);
    expect(screen.query('ports-card-20').length).toBeGreaterThan(0);
    expect(screen.query('ports-card-40').length).toBeGreaterThan(0);
    expect(screen.query('ports-card-73').length).toBeGreaterThan(0);
    expect(screen.query('ports-card-0')).toHaveLength(0);
    screen.unmount();
  });

  it('keeps USB MSP enabled and non-editable', async () => {
    const screen = await render(controllerFor());
    await screen.press('ports-card-toggle-20');
    expect(screen.find('ports-20-msp').props.value).toBe(true);
    expect(screen.find('ports-20-msp').props.disabled).toBe(true);
    expect(
      screen.find('ports-20-role-TELEMETRY_SMARTPORT').props.disabled,
    ).toBe(true);
    expect(screen.find('ports-20-role-BLACKBOX').props.disabled).toBe(false);
    expect(screen.find('ports-20-role-BLACKBOX').props.accessibilityRole).toBe(
      'radio',
    );
    expect(
      screen.find('ports-20-role-BLACKBOX').props.accessibilityLabel,
    ).toBeTruthy();
    screen.unmount();
  });

  it('shows the active baud rates without forcing the operator to expand a port', async () => {
    const screen = await render(controllerFor());
    expect(screen.find('ports-baud-summary-20').props.children).toContain(
      '115200',
    );
    screen.unmount();
  });

  it('warns only when the connected firmware has a VTX table that is incomplete', async () => {
    const vtxPorts = Object.freeze([port(20, 1), port(0, 1 + 2 ** 17)]);
    const incomplete = await render(
      controllerFor(
        snapshot({
          ports: vtxPorts,
          vtxTableAvailable: true,
          vtxTableConfigured: false,
        }),
      ),
    );
    expect(incomplete.query('ports-vtx-table-warning').length).toBeGreaterThan(
      0,
    );
    incomplete.unmount();

    const unavailable = await render(
      controllerFor(
        snapshot({
          ports: vtxPorts,
          vtxTableAvailable: false,
          vtxTableConfigured: false,
        }),
      ),
    );
    expect(unavailable.query('ports-vtx-table-warning')).toHaveLength(0);
    unavailable.unmount();
  });

  it('passes an immutable edited port table to the real transaction boundary', async () => {
    const controller = controllerFor();
    const screen = await render(controller);
    await screen.press('ports-card-toggle-0');
    await screen.press('ports-0-role-GPS');
    expect(screen.find('ports-save').props.disabled).toBe(false);
    await screen.press('ports-save');
    expect(controller.save).toHaveBeenCalledTimes(1);
    const desired = controller.save.mock.calls[0][2];
    expect(desired[1].functionMask).toBe(2 ** 1);
    expect(desired[1].extensionBytes).toEqual(Uint8Array.from([0xa5]));
    screen.unmount();
  });

  it('asks before reloading and discarding unsaved changes', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
    const controller = controllerFor();
    const screen = await render(controller);
    await screen.press('ports-card-toggle-0');
    await screen.press('ports-0-role-GPS');

    await screen.press('ports-reload');

    expect(controller.load).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledTimes(1);
    const actions = alert.mock.calls[0][2] ?? [];
    const discard = actions.find(action => action.style === 'destructive');
    expect(discard?.onPress).toBeDefined();
    await ReactTestRenderer.act(async () => {
      discard?.onPress?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(controller.load).toHaveBeenCalledTimes(2);
    alert.mockRestore();
    screen.unmount();
  });

  it('blocks save when one single-instance function is assigned twice', async () => {
    const controller = controllerFor();
    const screen = await render(controller);
    await screen.press('ports-card-toggle-0');
    await screen.press('ports-0-role-GPS');
    await screen.press('ports-card-toggle-1');
    await screen.press('ports-1-role-GPS');
    expect(screen.query('ports-validation-errors').length).toBeGreaterThan(0);
    expect(screen.find('ports-save').props.disabled).toBe(true);
    expect(controller.save).not.toHaveBeenCalled();
    screen.unmount();
  });

  it('disables a role proven absent from the connected firmware build', async () => {
    const screen = await render(
      controllerFor(snapshot({ buildOptionIds: new Set([16412]) })),
    );
    await screen.press('ports-card-toggle-0');
    expect(screen.find('ports-0-role-GPS').props.disabled).toBe(false);
    expect(screen.find('ports-0-role-TBS_SMARTAUDIO').props.disabled).toBe(
      true,
    );
    screen.unmount();
  });
});

/* ================================================================== *
 * THE FIELD BUG: "no visible save action appeared"
 * ================================================================== */

describe('PortsScreen - the persistent save surface', () => {
  /** The bar renders null when nothing is pending, so presence is tested
   * by a control that only exists once it has actually rendered. */
  const barVisible = (screen: {query: (id: string) => unknown[]}) =>
    screen.query('ports-sticky-actions-save').length > 0;

  it('shows nothing to act on until something is genuinely pending', async () => {
    const screen = await render(controllerFor());
    expect(barVisible(screen)).toBe(false);
    screen.unmount();
  });

  it('THE FIELD CASE: assigning GPS to a UART raises a persistent save bar that NAMES the pending change', async () => {
    const screen = await render(
      controllerFor(
        snapshot({ ports: Object.freeze([port(20, 1), port(0, 0)]) }),
      ),
    );
    expect(barVisible(screen)).toBe(false);

    await screen.press('ports-card-toggle-0');
    await screen.press('ports-0-role-GPS');

    expect(barVisible(screen)).toBe(true);
    const summary = screen.find('ports-sticky-actions-summary');
    const summaryText = Array.isArray(summary.props.children)
      ? summary.props.children.join('')
      : String(summary.props.children);
    // It names the port and the role, not a bare "unsaved".
    expect(summaryText).toContain(serialPortDisplayName(0));
    expect(summaryText).toContain(i18n.t('portsConfiguration.roles.GPS'));
    screen.unmount();
  });

  it('the persistent save action reaches the real transaction, exactly like the in-page one', async () => {
    const controller = controllerFor(
      snapshot({ ports: Object.freeze([port(20, 1), port(0, 0)]) }),
    );
    const screen = await render(controller);
    await screen.press('ports-card-toggle-0');
    await screen.press('ports-0-role-GPS');
    await screen.press('ports-sticky-actions-save');
    expect(controller.save).toHaveBeenCalledTimes(1);
    expect(controller.save.mock.calls[0][0]).toEqual(key);
    screen.unmount();
  });

  it('discarding from the persistent bar clears the pending change and the bar with it', async () => {
    const screen = await render(
      controllerFor(
        snapshot({ ports: Object.freeze([port(20, 1), port(0, 0)]) }),
      ),
    );
    await screen.press('ports-card-toggle-0');
    await screen.press('ports-0-role-GPS');
    expect(barVisible(screen)).toBe(true);
    await screen.press('ports-sticky-actions-discard');
    expect(barVisible(screen)).toBe(false);
    screen.unmount();
  });

  it('the bar lives OUTSIDE the scroll view, so no amount of content can push it off screen', async () => {
    const screen = await render(
      controllerFor(
        snapshot({ ports: Object.freeze([port(20, 1), port(0, 0)]) }),
      ),
    );
    await screen.press('ports-card-toggle-0');
    await screen.press('ports-0-role-GPS');
    expect(barVisible(screen)).toBe(true);
    for (const scroll of screen.renderer.root.findAllByType(ScrollView)) {
      expect(
        scroll.findAll(
          node => node.props.testID === 'ports-sticky-actions-save',
        ),
      ).toHaveLength(0);
    }
    screen.unmount();
  });
});
