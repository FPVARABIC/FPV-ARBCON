import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import '../../i18n';
import i18n from '../../i18n';
import type {MotorTestControllerSnapshot} from '../../core/state/motorTestController';
import type {MotorTestOperatorPort} from '../../platforms/react-native/protocol';
import {EscDirectionPanel} from './EscDirectionPanel';

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await i18n.init();
  }
});

function operator(allowed: boolean): MotorTestOperatorPort {
  const snapshot = {
    activation: {allowed, reasons: allowed ? [] : ['CONTROLLER_LINK_UNAVAILABLE']},
  } as unknown as MotorTestControllerSnapshot;
  return {
    beginSession: async () => snapshot,
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    pulseMotor: () => 'GATES_NOT_SATISFIED',
    renewPulseHold: () => 'NO_ACTIVE_PULSE',
    setEscDirection: jest.fn(async (motorNumber, direction) => ({
      kind: 'ACKNOWLEDGED' as const,
      motorNumber,
      direction,
      physicallyVerified: false as const,
    })),
    refreshDiagnostics: async () => ({
      outputs: {state: 'WAITING', value: undefined, observedAtMillis: undefined},
      escTelemetry: {state: 'WAITING', value: undefined, observedAtMillis: undefined},
    }),
    requestStop: () => 'ACCEPTED',
    endSession: async () => snapshot,
  };
}

describe('EscDirectionPanel', () => {
  it('requires a ready protected motor-test session', async () => {
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(
        <EscDirectionPanel selectedMotor={1} operator={operator(false)} />,
      );
    });
    expect(
      tree.root.findByProps({testID: 'esc-direction-review'}).props.disabled,
    ).toBe(true);
    expect(
      tree.root.findByProps({testID: 'esc-direction-needs-observation'}),
    ).toBeDefined();
    act(() => tree.unmount());
  });

  it('keeps the same session and forwards the selected motor and direction once', async () => {
    const port = operator(true);
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(
        <EscDirectionPanel selectedMotor={3} operator={port} />,
      );
    });
    act(() => {
      tree.root.findByProps({testID: 'esc-direction-reversed'}).props.onPress();
      tree.root.findByProps({testID: 'esc-direction-review'}).props.onPress();
    });
    expect(
      tree.root.findByProps({testID: 'esc-direction-confirmation'}),
    ).toBeDefined();
    expect(port.setEscDirection).not.toHaveBeenCalled();

    await act(async () => {
      await tree.root.findByProps({testID: 'esc-direction-apply'}).props.onPress();
    });
    expect(port.setEscDirection).toHaveBeenCalledWith(3, 'REVERSED');
    expect(JSON.stringify(tree.toJSON())).toContain(
      'لم يثبت التطبيق الاتجاه ميكانيكيًا',
    );
    act(() => tree.unmount());
  });

  it('never labels an acknowledgement from the previous motor as the new selection', async () => {
    let resolveDirection!: (value: {
      kind: 'ACKNOWLEDGED';
      motorNumber: number;
      direction: 'REVERSED';
      physicallyVerified: false;
    }) => void;
    const pending = new Promise<{
      kind: 'ACKNOWLEDGED';
      motorNumber: number;
      direction: 'REVERSED';
      physicallyVerified: false;
    }>(resolve => {
      resolveDirection = resolve;
    });
    const port = operator(true);
    port.setEscDirection = jest.fn(() => pending);
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(
        <EscDirectionPanel selectedMotor={1} operator={port} />,
      );
    });
    act(() => {
      tree.root.findByProps({testID: 'esc-direction-reversed'}).props.onPress();
      tree.root.findByProps({testID: 'esc-direction-review'}).props.onPress();
    });
    act(() => {
      tree.update(<EscDirectionPanel selectedMotor={2} operator={port} />);
    });
    await act(async () => {
      resolveDirection({
        kind: 'ACKNOWLEDGED',
        motorNumber: 1,
        direction: 'REVERSED',
        physicallyVerified: false,
      });
      await pending;
    });

    const rendered = JSON.stringify(tree.toJSON());
    expect(rendered).not.toContain('أقرّ متحكم الطيران أمر الاتجاه والحفظ');
    expect(rendered).toContain('M2');
    act(() => tree.unmount());
  });
});
