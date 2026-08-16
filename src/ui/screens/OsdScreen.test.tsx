import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import '../../i18n';

import type {MspOsdSnapshot} from '../../core';
import OsdScreen, {type OsdControllerPort} from './OsdScreen';

const snapshot: MspOsdSnapshot = {
  canvas: {columns: 53, rows: 20},
  config: {
    flags: 1,
    videoSystem: 3,
    units: 1,
    rssiAlarmPercent: 30,
    capacityAlarmMah: 1400,
    altitudeAlarm: 120,
    elementPositions: [0x0805, 0x0826],
    statistics: [true, false],
    timers: [0x0a21, 0x1422],
    warningCount: 4,
    enabledWarnings: 1,
    profileCount: 3,
    selectedProfile: 1,
    overlayRadioMode: 0,
    cameraFrameWidth: 24,
    cameraFrameHeight: 11,
    linkQualityAlarmPercent: 70,
    rssiDbmAlarm: -95,
  },
};

describe('OsdScreen', () => {
  it('renders the live canvas, the element list and the fine position controls', async () => {
    const controller: OsdControllerPort = {
      load: jest.fn(async () => ({kind: 'LOADED' as const, snapshot})),
      save: jest.fn(),
    };
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <OsdScreen sessionKey={{sessionId: 'fc', generation: 1}} active controller={controller} />,
      );
      await Promise.resolve();
    });

    expect(renderer.root.findByProps({testID: 'osd-canvas'})).toBeDefined();
    expect(renderer.root.findByProps({testID: 'osd-preview-background'})).toBeDefined();
    expect(renderer.root.findAllByProps({testID: 'osd-element-0'}).length).toBeGreaterThan(0);

    // The steppers stay as the precise way to nudge one cell; dragging is
    // covered end-to-end in osdDragInteraction.test.tsx.
    act(() => {
      renderer.root.findByProps({testID: 'osd-element-x-plus'}).props.onPress();
    });
    expect(renderer.root.findByProps({testID: 'osd-save-bar'}).props.visible).toBe(true);
    act(() => renderer.unmount());
  });

  it('says why it cannot read, and offers the way out', async () => {
    const controller: OsdControllerPort = {
      load: jest.fn(async () => ({kind: 'REJECTED' as const, reason: 'MOTOR_TEST_ACTIVE' as const})),
      save: jest.fn(),
    };
    const onOpenMotors = jest.fn();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <OsdScreen
          sessionKey={{sessionId: 'fc', generation: 1}}
          active
          controller={controller}
          onOpenMotors={onOpenMotors}
        />,
      );
      await Promise.resolve();
    });

    expect(renderer.root.findByProps({testID: 'osd-load-message'})).toBeDefined();
    expect(renderer.root.findAllByProps({testID: 'osd-canvas'})).toHaveLength(0);
    act(() => renderer.unmount());
  });
});
