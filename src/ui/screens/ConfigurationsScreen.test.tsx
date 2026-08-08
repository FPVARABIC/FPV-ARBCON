jest.mock('../../platforms/react-native/protocol', () => {
  const actual = jest.requireActual('../../platforms/react-native/protocol');
  return {
    ...actual,
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
        board: { gyroSampleRateHz: 8000 },
      },
    }),
    useTelemetryValue: () => ({
      status: 'FRESH',
      updatedAtMs: 1,
      value: {
        cycleTimeUs: 125,
        i2cErrorCount: 0,
        sensorPresenceMask: 41,
        cpuLoadPercent: 18,
        flightModeFlagsLow32: 0,
        readiness: { malformedTail: false, extraFlightModeFlagBytes: [] },
      },
    }),
  };
});

import React from 'react';
import { Alert } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import { readFileSync } from 'node:fs';

import '../../i18n';
import i18n from '../../i18n';
import type { GeneralConfigurationSnapshot } from '../../core';
import ConfigurationsScreen from './ConfigurationsScreen';

function snapshot(): GeneralConfigurationSnapshot {
  const rx = new Uint8Array(39);
  rx[22] = 20;
  return {
    featureMaskRaw: 2 ** 22,
    arming: {
      autoDisarmDelaySeconds: 5,
      deprecatedDisarmKillsSwitch: 0,
      smallAngleDegrees: 25,
      gyroCalibrationOnFirstArm: false,
    },
    beeper: {
      disabledMask: 0,
      disabledDshotBeaconMask: 0,
      dshotBeaconTone: 1,
    },
    advanced: {
      deprecatedGyroSyncDenom: 1,
      pidProcessDenom: 2,
      useContinuousUpdate: 1,
      motorProtocolRaw: 7,
      motorPwmRate: 480,
      motorIdleRaw: 550,
      deprecatedGyroUse32kHz: 0,
      motorInversionRaw: 0,
      deprecatedGyroToUse: 0,
      gyroHighFsr: 0,
      gyroMovementCalibrationThreshold: 48,
      gyroCalibrationDuration: 125,
      gyroYawOffset: 0,
      checkOverflow: 0,
      debugMode: 0,
      debugModeCount: 70,
    },
    rx: { serialRxProvider: 9, fpvCameraAngleDegrees: 20, raw: rx },
    craftName: 'FPV-QUAD',
    pilotName: 'PILOT',
    buildOptionIds: new Set([16413, 16416, 16423]),
    gyroSampleRateHz: 8000,
  };
}

async function renderScreen() {
  const onOpenSetup = jest.fn();
  const onOpenMotors = jest.fn();
  const onOpenPorts = jest.fn();
  const onOpenGps = jest.fn();
  const onDirtyChange = jest.fn();
  const controller = {
    load: jest.fn(async () => ({ kind: 'LOADED' as const, snapshot: snapshot() })),
    save: jest.fn(async () => ({
      kind: 'SAVED_VERIFIED' as const,
      snapshot: snapshot(),
      rebootAcknowledged: true,
    })),
  };
  const element = (active: boolean) => (
    <ConfigurationsScreen
      sessionKey={{ sessionId: 'configuration-session', generation: 3 }}
      active={active}
      onOpenSetup={onOpenSetup}
      onOpenMotors={onOpenMotors}
      onOpenPorts={onOpenPorts}
      onOpenGps={onOpenGps}
      onDirtyChange={onDirtyChange}
      controller={controller}
    />
  );
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(element(true));
    await Promise.resolve();
  });
  return {
    renderer,
    element,
    controller,
    onDirtyChange,
    onOpenSetup,
    onOpenMotors,
    onOpenPorts,
    onOpenGps,
  };
}

describe('ConfigurationsScreen', () => {
  it('contains no external configurator navigation or user-visible competitor branding', () => {
    const source = readFileSync(
      require.resolve('./ConfigurationsScreen.tsx'),
      'utf8',
    );
    expect(source).not.toMatch(/\bLinking\b|openURL|betaflight\.com|inavflight\.com/i);
    expect(
      JSON.stringify(require('../../i18n/locales/ar.json').configurationsSystem),
    ).not.toMatch(/betaflight|inav/i);
  });

  it('stays inert when first mounted as a hidden tab', async () => {
    const controller = { load: jest.fn(), save: jest.fn() };
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <ConfigurationsScreen
          sessionKey={{ sessionId: 'hidden', generation: 1 }}
          active={false}
          onOpenSetup={() => {}}
          onOpenMotors={() => {}}
          onOpenPorts={() => {}}
          onOpenGps={() => {}}
          controller={controller}
        />,
      );
      await Promise.resolve();
    });
    expect(controller.load).not.toHaveBeenCalled();
    ReactTestRenderer.act(() => renderer.unmount());
  });

  it('renders all owned sections and filters unsupported compiled features', async () => {
    const screen = await renderScreen();
    for (const testID of [
      'configurations-screen',
      'configurations-system-summary',
      'configurations-craft-name',
      'configurations-camera-angle-value',
      'configurations-small-angle-value',
      'configurations-pid-denom-value',
      'configurations-features',
      'configurations-feature-ledStrip',
      'configurations-feature-osd',
      'configurations-feature-softSerial',
      'configurations-beeper-rxLost',
      'configurations-dshot-tone-1',
      'configurations-destinations',
    ]) {
      expect(screen.renderer.root.findAllByProps({ testID })).not.toHaveLength(
        0,
      );
    }
    expect(
      screen.renderer.root.findAllByProps({
        testID: 'configurations-feature-rangefinder',
      }),
    ).toHaveLength(0);
    ReactTestRenderer.act(() => screen.renderer.unmount());
  });

  it('reports a dirty draft, preserves it while hidden and can reset it', async () => {
    const screen = await renderScreen();
    expect(screen.onDirtyChange).toHaveBeenLastCalledWith(false);
    ReactTestRenderer.act(() => {
      const toggle = screen.renderer.root
        .findAllByProps({ testID: 'configurations-feature-airmode' })
        .find(node => typeof node.props.onValueChange === 'function');
      toggle?.props.onValueChange(false);
    });
    expect(screen.onDirtyChange).toHaveBeenLastCalledWith(true);
    await ReactTestRenderer.act(async () => {
      screen.renderer.update(screen.element(false));
      await Promise.resolve();
      screen.renderer.update(screen.element(true));
      await Promise.resolve();
    });
    expect(screen.controller.load).toHaveBeenCalledTimes(1);
    expect(
      screen.renderer.root
        .findAllByProps({ testID: 'configurations-feature-airmode' })
        .find(node => typeof node.props.onValueChange === 'function')?.props
        .value,
    ).toBe(false);
    ReactTestRenderer.act(() => {
      screen.renderer.root
        .findByProps({ testID: 'configurations-reset' })
        .props.onPress();
    });
    expect(screen.onDirtyChange).toHaveBeenLastCalledWith(false);
    ReactTestRenderer.act(() => screen.renderer.unmount());
  });
  it('does not discard dirty configuration on reload without confirmation', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const screen = await renderScreen();
    ReactTestRenderer.act(() => {
      screen.renderer.root
        .findByProps({testID: 'configurations-camera-angle-increment'})
        .props.onPress();
    });
    ReactTestRenderer.act(() => {
      screen.renderer.root.findByProps({testID: 'configurations-reload'}).props.onPress();
    });
    expect(screen.controller.load).toHaveBeenCalledTimes(1);
    await ReactTestRenderer.act(async () => { await alert.mock.calls[0][2]?.[1]?.onPress?.(); await Promise.resolve(); });
    expect(screen.controller.load).toHaveBeenCalledTimes(2);
    alert.mockRestore();
    ReactTestRenderer.act(() => screen.renderer.unmount());
  });

  it('routes to every integrated owner without an external link', async () => {
    const screen = await renderScreen();
    for (const [testID, callback] of [
      ['configurations-open-setup', screen.onOpenSetup],
      ['configurations-open-motors', screen.onOpenMotors],
      ['configurations-open-ports', screen.onOpenPorts],
      ['configurations-open-gps', screen.onOpenGps],
    ] as const) {
      ReactTestRenderer.act(() => {
        screen.renderer.root.findByProps({ testID }).props.onPress();
      });
      expect(callback).toHaveBeenCalledTimes(1);
    }
    ReactTestRenderer.act(() => screen.renderer.unmount());
  });

  it('requires confirmation before handing one draft to the controller', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const screen = await renderScreen();
    ReactTestRenderer.act(() => {
      screen.renderer.root
        .findByProps({ testID: 'configurations-camera-angle-increment' })
        .props.onPress();
    });
    ReactTestRenderer.act(() => {
      screen.renderer.root
        .findByProps({ testID: 'configurations-save' })
        .props.onPress();
    });
    expect(screen.controller.save).not.toHaveBeenCalled();
    const buttons = alert.mock.calls[0][2];
    await ReactTestRenderer.act(async () => {
      await buttons?.[1]?.onPress?.();
    });
    expect(screen.controller.save).toHaveBeenCalledTimes(1);
    alert.mockRestore();
    ReactTestRenderer.act(() => screen.renderer.unmount());
  });

  it('keeps a rejected save reason visible in the persistent action surface', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const screen = await renderScreen();
    screen.controller.save.mockResolvedValue({
      kind: 'REJECTED',
      reason: 'LINK_RECOVERING',
    } as never);
    ReactTestRenderer.act(() => {
      screen.renderer.root
        .findByProps({ testID: 'configurations-camera-angle-increment' })
        .props.onPress();
    });
    ReactTestRenderer.act(() => {
      screen.renderer.root
        .findAllByProps({ testID: 'configurations-sticky-actions-save' })[0]
        .props.onPress();
    });
    const buttons = alert.mock.calls[alert.mock.calls.length - 1][2];
    await ReactTestRenderer.act(async () => {
      await buttons?.[1]?.onPress?.();
    });

    const status = screen.renderer.root.findByProps({
      testID: 'configurations-sticky-actions-status',
    });
    expect(status.props.children).toBe(
      i18n.t('configurationsSystem.blockReason.LINK_RECOVERING'),
    );
    alert.mockRestore();
    ReactTestRenderer.act(() => screen.renderer.unmount());
  });
});
