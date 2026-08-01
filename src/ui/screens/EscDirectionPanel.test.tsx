import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';

import '../../i18n';
import i18n from '../../i18n';
import type { MotorVerificationState } from '../../core/state/motorVerificationModel';
import {
  EscDirectionPanel,
  type EscDirectionControllerPort,
} from './EscDirectionPanel';

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await i18n.init();
  }
});

function state(observed: boolean): MotorVerificationState {
  return Object.freeze({
    sessionToken: {},
    finalized: false,
    aborted: false,
    entries: Object.freeze(
      [1, 2, 3, 4].map(motorNumber =>
        Object.freeze(
          motorNumber === 1 && observed
            ? {
                motorNumber,
                outcome: 'DIRECTION_MISMATCH' as const,
                observation: Object.freeze({
                  kind: 'OBSERVED' as const,
                  position: 'REAR_RIGHT' as const,
                  direction: 'CW' as const,
                }),
                attemptId: 1,
              }
            : {
                motorNumber,
                outcome: 'UNTESTED' as const,
                observation: undefined,
                attemptId: undefined,
              },
        ),
      ),
    ),
  });
}

describe('EscDirectionPanel', () => {
  it('requires a physical observation before direction controls can write', async () => {
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(
        <EscDirectionPanel
          sessionId="fc-1"
          verification={state(false)}
          onEndMotorTestSession={jest.fn(async () => undefined)}
          controller={{ setEscDirection: jest.fn() } as never}
        />,
      );
    });
    expect(
      tree.root.findByProps({ testID: 'esc-direction-review' }).props.disabled,
    ).toBe(true);
    expect(
      tree.root.findByProps({ testID: 'esc-direction-needs-observation' }),
    ).toBeDefined();
    act(() => tree.unmount());
  });

  it('uses review confirmation, ends the test, and forwards one exact ESC command', async () => {
    const controller: EscDirectionControllerPort = {
      setEscDirection: jest.fn(async (_sessionId, motorNumber, direction) => ({
        kind: 'ACKNOWLEDGED' as const,
        motorNumber,
        direction,
        physicallyVerified: false as const,
      })),
    };
    const endSession = jest.fn(async () => undefined);
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(
        <EscDirectionPanel
          sessionId="fc-1"
          verification={state(true)}
          onEndMotorTestSession={endSession}
          controller={controller}
        />,
      );
    });
    act(() => {
      tree.root
        .findByProps({ testID: 'esc-direction-reversed' })
        .props.onPress();
      tree.root.findByProps({ testID: 'esc-direction-review' }).props.onPress();
    });
    expect(
      tree.root.findByProps({ testID: 'esc-direction-confirmation' }),
    ).toBeDefined();
    expect(controller.setEscDirection).not.toHaveBeenCalled();

    await act(async () => {
      await tree.root
        .findByProps({ testID: 'esc-direction-apply' })
        .props.onPress();
    });
    expect(endSession).toHaveBeenCalledTimes(1);
    expect(controller.setEscDirection).toHaveBeenCalledWith(
      'fc-1',
      1,
      'REVERSED',
    );
    const text = JSON.stringify(tree.toJSON());
    expect(text).toContain('لم يثبت التطبيق الاتجاه ميكانيكيًا');
    act(() => tree.unmount());
  });
});
