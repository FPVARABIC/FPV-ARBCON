import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { TextInput } from 'react-native';

import '../../i18n';
import i18n from '../../i18n';
import type { MotorConfigurationSnapshot } from '../../core/state/motorConfigurationModel';
import {
  MotorConfigurationPanel,
  type MotorConfigurationControllerPort,
} from './MotorConfigurationPanel';

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await i18n.init();
  }
});

function snapshot(idle = 550): MotorConfigurationSnapshot {
  return Object.freeze({
    mixer: Object.freeze({
      mixerModeRaw: 3,
      yawMotorsReversedConfigured: false,
      yawMotorsReversedRaw: 0,
    }),
    advanced: Object.freeze({
      deprecatedGyroSyncDenom: 1,
      pidProcessDenom: 2,
      useContinuousUpdate: 0,
      motorProtocolRaw: 7,
      motorPwmRate: 480,
      motorIdleRaw: idle,
      deprecatedGyroUse32kHz: 0,
      motorInversionRaw: 0,
      deprecatedGyroToUse: 0,
      gyroHighFsr: 1,
      gyroMovementCalibrationThreshold: 48,
      gyroCalibrationDuration: 125,
      gyroYawOffset: -17,
      checkOverflow: 2,
      debugMode: 9,
      debugModeCount: 77,
    }),
    motor: Object.freeze({
      deprecatedMinThrottle: 0,
      maxThrottle: 2000,
      minCommand: 1000,
      motorCount: 4,
      motorPoleCount: 14,
      dshotTelemetryRaw: 0,
      escSensorRaw: 0,
    }),
    motor3d: Object.freeze({
      deadband3dLow: 1406,
      deadband3dHigh: 1514,
      neutral3d: 1460,
    }),
    feature: Object.freeze({
      enabledFeaturesRaw: 0,
      feature3dEnabled: false,
    }),
  });
}

function controllerDouble(
  loadResult: Awaited<ReturnType<MotorConfigurationControllerPort['load']>> = {
    kind: 'LOADED',
    snapshot: snapshot(),
  },
) {
  const controller: MotorConfigurationControllerPort = {
    load: jest.fn(async () => loadResult),
    save: jest.fn(async (_sessionId, _original, draft) => ({
      kind: 'SAVED_VERIFIED' as const,
      snapshot: snapshot(draft.motorIdleRaw),
      rebootRequired: true as const,
      changedGroups: ['ADVANCED'] as const,
    })),
  };
  return controller;
}

async function render(controller: MotorConfigurationControllerPort) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <MotorConfigurationPanel sessionId="fc-1" controller={controller} />,
    );
  });
  return tree;
}

describe('MotorConfigurationPanel', () => {
  it('loads the real FC snapshot and presents the full independent settings groups', async () => {
    const controller = controllerDouble();
    const tree = await render(controller);
    const text = JSON.stringify(tree.toJSON());

    expect(controller.load).toHaveBeenCalledWith('fc-1');
    expect(text).toContain('بروتوكول خرج ESC');
    expect(text).toContain('ميزات ESC وسلوك الخمول');
    expect(text).toContain('وضع 3D');
    expect(
      tree.root.findByProps({ testID: 'motor-config-protocol-7' }).props
        .accessibilityState.selected,
    ).toBe(true);
    act(() => tree.unmount());
  });

  it('requires a review step before save and forwards the exact edited draft', async () => {
    const controller = controllerDouble();
    const tree = await render(controller);

    await act(async () => {
      tree.root
        .findByProps({ testID: 'motor-config-idle' })
        .findByType(TextInput)
        .props.onChangeText('600');
    });
    expect(
      tree.root.findByProps({ testID: 'motor-config-review-save' }).props
        .disabled,
    ).toBe(false);

    act(() => {
      tree.root
        .findByProps({ testID: 'motor-config-review-save' })
        .props.onPress();
    });
    expect(
      tree.root.findByProps({ testID: 'motor-config-confirmation' }),
    ).toBeDefined();
    expect(controller.save).not.toHaveBeenCalled();

    await act(async () => {
      tree.root
        .findByProps({ testID: 'motor-config-confirm-save' })
        .props.onPress();
    });
    expect(controller.save).toHaveBeenCalledTimes(1);
    expect(controller.save).toHaveBeenCalledWith(
      'fc-1',
      expect.any(Object),
      expect.objectContaining({ motorIdleRaw: 600, motorProtocolRaw: 7 }),
    );
    expect(JSON.stringify(tree.toJSON())).toContain('تم حفظ الإعدادات');
    act(() => tree.unmount());
  });

  it('keeps save disabled for an incomplete numeric value', async () => {
    const tree = await render(controllerDouble());
    await act(async () => {
      tree.root
        .findByProps({ testID: 'motor-config-idle' })
        .findByType(TextInput)
        .props.onChangeText('');
    });
    expect(
      tree.root.findByProps({ testID: 'motor-config-invalid' }),
    ).toBeDefined();
    expect(
      tree.root.findByProps({ testID: 'motor-config-review-save' }).props
        .disabled,
    ).toBe(true);
    act(() => tree.unmount());
  });

  it('shows a truthful block reason and no editable form when load is rejected', async () => {
    const tree = await render(
      controllerDouble({ kind: 'REJECTED', reason: 'MOTOR_TEST_ACTIVE' }),
    );
    expect(JSON.stringify(tree.toJSON())).toContain(
      'أوقف جلسة اختبار دوران المحركات',
    );
    expect(
      tree.root.findAllByProps({ testID: 'motor-config-review-save' }),
    ).toHaveLength(0);
    act(() => tree.unmount());
  });

  it('recovers from an unexpected load throw instead of leaving a permanent spinner', async () => {
    const controller: MotorConfigurationControllerPort = {
      load: jest.fn(async () => {
        throw new Error('unexpected');
      }),
      save: jest.fn(),
    };
    const tree = await render(controller);
    const text = JSON.stringify(tree.toJSON());
    expect(text).toContain('تعذّرت قراءة الإعدادات');
    expect(
      tree.root.findAllByProps({ testID: 'motor-config-loading' }),
    ).toHaveLength(0);
    expect(
      tree.root.findByProps({ testID: 'motor-config-refresh' }).props.disabled,
    ).toBe(false);
    act(() => tree.unmount());
  });
});
