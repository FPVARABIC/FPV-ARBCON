import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';

import '../../i18n';
import i18n from '../../i18n';
import type {
  MotorPhysicalPosition,
  MotorVerificationState,
} from '../../core/state/motorVerificationModel';
import {
  MotorOutputReorderPanel,
  type MotorOutputOrderControllerPort,
} from './MotorOutputReorderPanel';

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await i18n.init();
  }
});

function verification(
  positions: readonly MotorPhysicalPosition[],
): MotorVerificationState {
  return Object.freeze({
    sessionToken: {},
    finalized: false,
    aborted: false,
    entries: Object.freeze(
      positions.map((position, index) =>
        Object.freeze({
          motorNumber: index + 1,
          outcome: 'MATCH' as const,
          observation: Object.freeze({
            kind: 'OBSERVED' as const,
            position,
            direction: 'CW' as const,
          }),
          attemptId: index + 1,
        }),
      ),
    ),
  });
}

function controller(): MotorOutputOrderControllerPort {
  return {
    loadOutputOrder: jest.fn(async () => ({
      kind: 'LOADED' as const,
      values: [6, 4, 2, 0],
    })),
    saveOutputOrder: jest.fn(async (_sessionId, _original, desired) => ({
      kind: 'SAVED_VERIFIED' as const,
      values: desired,
    })),
  };
}

describe('MotorOutputReorderPanel', () => {
  it('keeps preparation disabled until all four positions are unambiguous', async () => {
    const incomplete = verification([
      'REAR_RIGHT',
      'FRONT_RIGHT',
      'REAR_LEFT',
      'FRONT_LEFT',
    ]);
    const entries = [...incomplete.entries];
    entries[3] = Object.freeze({
      motorNumber: 4,
      outcome: 'UNTESTED' as const,
      observation: undefined,
      attemptId: undefined,
    });
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(
        <MotorOutputReorderPanel
          sessionId="fc-1"
          verification={{ ...incomplete, entries }}
          onEndMotorTestSession={jest.fn(async () => undefined)}
          controller={controller()}
        />,
      );
    });
    expect(
      tree.root.findByProps({ testID: 'motor-output-reorder-prepare' }).props
        .disabled,
    ).toBe(true);
    act(() => tree.unmount());
  });

  it('ends the pulse session, reads the live order, reviews, then saves once', async () => {
    const port = controller();
    const endSession = jest.fn(async () => undefined);
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(
        <MotorOutputReorderPanel
          sessionId="fc-1"
          verification={verification([
            'FRONT_LEFT',
            'REAR_LEFT',
            'FRONT_RIGHT',
            'REAR_RIGHT',
          ])}
          onEndMotorTestSession={endSession}
          controller={port}
        />,
      );
    });
    await act(async () => {
      await tree.root
        .findByProps({
          testID: 'motor-output-reorder-prepare',
        })
        .props.onPress();
    });
    expect(endSession).toHaveBeenCalledTimes(1);
    expect(port.loadOutputOrder).toHaveBeenCalledWith('fc-1');
    expect(
      tree.root.findByProps({ testID: 'motor-output-reorder-review' }),
    ).toBeDefined();

    await act(async () => {
      await tree.root
        .findByProps({
          testID: 'motor-output-reorder-save',
        })
        .props.onPress();
    });
    expect(port.saveOutputOrder).toHaveBeenCalledWith(
      'fc-1',
      [6, 4, 2, 0],
      [0, 2, 4, 6],
    );
    expect(JSON.stringify(tree.toJSON())).toContain(
      'تم حفظ ترتيب المخارج والتحقق منه',
    );
    act(() => tree.unmount());
  });
});
