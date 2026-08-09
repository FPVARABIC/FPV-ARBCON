const mockReleaseTelemetry = jest.fn();
const mockAcquireTelemetry = jest.fn(
  (_sessionKey: unknown) => mockReleaseTelemetry,
);

jest.mock('../../platforms/react-native/protocol', () => {
  const actual = jest.requireActual('../../platforms/react-native/protocol');
  return {
    ...actual,
    acquireGpsDetailTelemetry: (sessionKey: unknown) =>
      mockAcquireTelemetry(sessionKey),
    useMspOwnershipState: () => 'ACTIVE',
    useMspIdentificationState: () => ({
      status: 'SUCCEEDED',
      identity: {
        firmware: { identifier: 'BTFL', knownFamily: 'BETAFLIGHT' },
        apiVersion: {
          mspProtocolVersion: 0,
          apiVersionMajor: 1,
          apiVersionMinor: 47,
        },
        board: {},
      },
    }),
    useTelemetryValue: (_sessionId: string, pollId: string) => {
      if (pollId === actual.GPS_DETAIL_RAW_POLL_ID) {
        return {
          status: 'FRESH',
          updatedAtMs: 1,
          value: {
            hasFix: true,
            fixFlagRaw: 2,
            satelliteCount: 12,
            latitudeDegrees: 48.1234567,
            longitudeDegrees: 11.7654321,
            altitudeMeters: 544,
            groundSpeedCentimetersPerSecond: 250,
            groundCourseDecidegrees: 910,
            pdopHundredths: 120,
          },
        };
      }
      if (pollId === actual.GPS_DETAIL_HOME_POLL_ID) {
        return {
          status: 'FRESH',
          updatedAtMs: 1,
          value: {
            distanceToHomeMeters: 42,
            directionToHomeDegrees: 275,
            updateToggle: 1,
          },
        };
      }
      return {
        status: 'FRESH',
        updatedAtMs: 1,
        value: {
          usesGnssIdentifiers: false,
          satellites: [
            {
              channelOrGnssId: 1,
              satelliteId: 22,
              qualityRaw: 13,
              quality: 5,
              used: true,
              signalToNoiseDbHz: 38,
              constellation: 'LEGACY',
            },
          ],
        },
      };
    },
  };
});

import React from 'react';
import { Alert, ScrollView } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';

import '../../i18n';
import i18n from '../../i18n';
import type { GpsConfigurationSnapshot } from '../../core';
import GpsScreen from './GpsScreen';

const snapshot: GpsConfigurationSnapshot = {
  featureMaskRaw: 2 ** 7,
  configuration: {
    provider: 1,
    sbasMode: 0,
    autoConfig: true,
    autoBaud: false,
    homePointOnce: false,
    useGalileo: true,
  },
  ports: [
    {
      identifier: 5,
      functionMask: 2,
      mspBaudIndex: 5,
      gpsBaudIndex: 4,
      telemetryBaudIndex: 0,
      blackboxBaudIndex: 0,
      extensionBytes: new Uint8Array(0),
    },
  ],
  apiVersionMajor: 1,
  apiVersionMinor: 47,
};

async function renderScreen() {
  const openPorts = jest.fn();
  const onDirtyChange = jest.fn();
  const controller = {
    load: jest.fn(async () => ({ kind: 'LOADED' as const, snapshot })),
    save: jest.fn(),
  };
  const element = (active: boolean) => (
    <GpsScreen
      sessionKey={{ sessionId: 'gps-session', generation: 2 }}
      active={active}
      onOpenPorts={openPorts}
      onDirtyChange={onDirtyChange}
      controller={controller}
    />
  );
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(element(true));
    await Promise.resolve();
  });
  return { renderer, openPorts, onDirtyChange, controller, element };
}

beforeEach(() => {
  mockAcquireTelemetry.mockClear();
  mockReleaseTelemetry.mockClear();
});

describe('GpsScreen', () => {
  it('does not acquire detail telemetry or read configuration when first mounted hidden', async () => {
    const controller = {
      load: jest.fn(),
      save: jest.fn(),
    };
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <GpsScreen
          sessionKey={{ sessionId: 'gps-hidden', generation: 1 }}
          active={false}
          onOpenPorts={() => {}}
          controller={controller}
        />,
      );
      await Promise.resolve();
    });
    expect(mockAcquireTelemetry).not.toHaveBeenCalled();
    expect(controller.load).not.toHaveBeenCalled();
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('renders live navigation, satellite truth, actual UART and the full official configuration', async () => {
    const screen = await renderScreen();
    for (const testID of [
      'gps-screen',
      'gps-port-integration',
      'gps-live-satellites',
      'gps-open-map',
      'gps-satellite-panel',
      'gps-configuration-panel',
      'gps-provider-ublox',
      'gps-auto-config',
      'gps-galileo',
      'gps-home-once',
    ]) {
      expect(
        screen.renderer.root.findAllByProps({ testID }).length,
      ).toBeGreaterThanOrEqual(1);
    }
    expect(screen.controller.load).toHaveBeenCalledTimes(1);
    expect(mockAcquireTelemetry).toHaveBeenCalledTimes(1);
    ReactTestRenderer.act(() => screen.renderer.unmount());
    expect(mockReleaseTelemetry).toHaveBeenCalledTimes(1);
  });

  it('links directly to Ports without modifying any port itself', async () => {
    const screen = await renderScreen();
    ReactTestRenderer.act(() => {
      screen.renderer.root
        .findByProps({ testID: 'gps-open-ports' })
        .props.onPress();
    });
    expect(screen.openPorts).toHaveBeenCalledTimes(1);
    ReactTestRenderer.act(() => screen.renderer.unmount());
  });

  it('reports an unsaved GPS draft to the shared navigation guard', async () => {
    const screen = await renderScreen();
    expect(screen.onDirtyChange).toHaveBeenLastCalledWith(false);
    ReactTestRenderer.act(() => {
      screen.renderer.root
        .findByProps({ testID: 'gps-provider-nmea' })
        .props.onPress();
    });
    expect(screen.onDirtyChange).toHaveBeenLastCalledWith(true);
    ReactTestRenderer.act(() => screen.renderer.unmount());
    expect(screen.onDirtyChange).toHaveBeenLastCalledWith(false);
  });
  it('does not discard a dirty GPS draft on reload without confirmation', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const screen = await renderScreen();
    ReactTestRenderer.act(() => {
      screen.renderer.root
        .findByProps({testID: 'gps-provider-nmea'})
        .props.onPress();
    });
    ReactTestRenderer.act(() => {
      screen.renderer.root.findByProps({testID: 'gps-reload'}).props.onPress();
    });
    expect(screen.controller.load).toHaveBeenCalledTimes(1);
    await ReactTestRenderer.act(async () => { await alert.mock.calls[0][2]?.[1]?.onPress?.(); await Promise.resolve(); });
    expect(screen.controller.load).toHaveBeenCalledTimes(2);
    alert.mockRestore();
    ReactTestRenderer.act(() => screen.renderer.unmount());
  });

  it('keeps the GPS save action visible outside the telemetry scroll, matching the fixed configurator toolbar', async () => {
    const screen = await renderScreen();
    ReactTestRenderer.act(() => {
      screen.renderer.root
        .findByProps({ testID: 'gps-provider-nmea' })
        .props.onPress();
    });

    expect(
      screen.renderer.root.findAllByProps({
        testID: 'gps-sticky-actions-save',
      }),
    ).not.toHaveLength(0);
    for (const scroll of screen.renderer.root.findAllByType(ScrollView)) {
      expect(
        scroll.findAll(
          node => node.props.testID === 'gps-sticky-actions-save',
        ),
      ).toHaveLength(0);
    }
    ReactTestRenderer.act(() => screen.renderer.unmount());
  });

  it('keeps a rejected GPS save reason in the persistent action surface', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const screen = await renderScreen();
    screen.controller.save.mockResolvedValue({
      kind: 'REJECTED',
      reason: 'LINK_RECOVERING',
    });
    ReactTestRenderer.act(() => {
      screen.renderer.root
        .findByProps({ testID: 'gps-provider-nmea' })
        .props.onPress();
    });
    ReactTestRenderer.act(() => {
      screen.renderer.root
        .findAllByProps({ testID: 'gps-sticky-actions-save' })[0]
        .props.onPress();
    });
    const buttons = alert.mock.calls[0][2];
    await ReactTestRenderer.act(async () => {
      await buttons?.[1]?.onPress?.();
    });

    const status = screen.renderer.root.findByProps({
      testID: 'gps-sticky-actions-status',
    });
    expect(status.props.children).toBe(
      i18n.t('gpsSystem.blockReason.LINK_RECOVERING'),
    );
    alert.mockRestore();
    ReactTestRenderer.act(() => screen.renderer.unmount());
  });

  it('stops detail telemetry while hidden and preserves an unsaved draft when returning', async () => {
    const screen = await renderScreen();
    ReactTestRenderer.act(() => {
      screen.renderer.root
        .findByProps({ testID: 'gps-provider-nmea' })
        .props.onPress();
    });
    await ReactTestRenderer.act(async () => {
      screen.renderer.update(screen.element(false));
      await Promise.resolve();
    });
    await ReactTestRenderer.act(async () => {
      screen.renderer.update(screen.element(true));
      await Promise.resolve();
    });
    expect(screen.controller.load).toHaveBeenCalledTimes(1);
    expect(
      screen.renderer.root.findByProps({ testID: 'gps-provider-nmea' }).props
        .selected,
    ).toBe(true);
    expect(mockReleaseTelemetry).toHaveBeenCalledTimes(1);
    ReactTestRenderer.act(() => screen.renderer.unmount());
  });

  it('lets an in-flight configuration read finish while the mounted tab is briefly hidden', async () => {
    let resolveLoad!: (value: {
      kind: 'LOADED';
      snapshot: GpsConfigurationSnapshot;
    }) => void;
    const controller = {
      load: jest.fn(
        () =>
          new Promise<{ kind: 'LOADED'; snapshot: GpsConfigurationSnapshot }>(
            resolve => {
              resolveLoad = resolve;
            },
          ),
      ),
      save: jest.fn(),
    };
    const props = (active: boolean) => (
      <GpsScreen
        sessionKey={{ sessionId: 'gps-pending', generation: 1 }}
        active={active}
        onOpenPorts={() => {}}
        controller={controller}
      />
    );
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(props(true));
      await Promise.resolve();
    });
    await ReactTestRenderer.act(async () => {
      renderer.update(props(false));
      await Promise.resolve();
    });
    await ReactTestRenderer.act(async () => {
      renderer.update(props(true));
      await Promise.resolve();
    });
    expect(controller.load).toHaveBeenCalledTimes(1);
    await ReactTestRenderer.act(async () => {
      resolveLoad({ kind: 'LOADED', snapshot });
      await Promise.resolve();
    });
    expect(
      renderer.root.findAllByProps({ testID: 'gps-provider-ublox' }).length,
    ).toBeGreaterThan(0);
    ReactTestRenderer.act(() => renderer.unmount());
  });
});
