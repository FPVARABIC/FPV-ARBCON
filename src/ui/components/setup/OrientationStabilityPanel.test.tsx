import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';

import OrientationStabilityPanel from './OrientationStabilityPanel';
import type { OrientationViewState } from '../../../core';
import '../../../i18n';

function find(renderer: ReactTestRenderer.ReactTestRenderer, testID: string) {
  return renderer.root.findAllByProps({ testID })[0];
}

function text(renderer: ReactTestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node =>
      Array.isArray(node.props.children)
        ? node.props.children.join('')
        : String(node.props.children ?? ''),
    )
    .join(' | ');
}

function view(rollDeg = 0, pitchDeg = 0): OrientationViewState {
  return { status: 'LIVE', rollDeg, pitchDeg, yawDeg: 0 };
}

describe('OrientationStabilityPanel', () => {
  it('is explicitly read-only and unavailable without a live sample', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <OrientationStabilityPanel orientationView={{ status: 'WAITING' }} />,
      );
    });
    expect(text(renderer)).toContain('قراءة فقط');
    expect(text(renderer)).toContain('يتطلب الفحص قراءة اتجاه مباشرة');
    expect(find(renderer, 'orientation-stability-start').props.disabled).toBe(
      true,
    );
    act(() => renderer.unmount());
  });

  it('collects the real sample sequence and reports a quiet level capture', () => {
    let seq = 1;
    let atMs = 1_000;
    const element = (orientation: OrientationViewState) => (
      <OrientationStabilityPanel
        orientationView={orientation}
        sampleSeq={seq}
        sampleReceivedAt={atMs}
      />
    );
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(element(view()));
    });
    act(() => {
      find(renderer, 'orientation-stability-start').props.onPress();
    });
    for (let i = 1; i <= 40; i += 1) {
      seq += 1;
      atMs += 200;
      act(() => {
        renderer.update(
          element(view(i % 2 === 0 ? 0.1 : -0.1, i % 3 === 0 ? 0.1 : 0)),
        );
      });
    }
    expect(
      find(renderer, 'orientation-stability-result-STABLE_LEVEL'),
    ).toBeDefined();
    expect(text(renderer)).toContain('متوسط الدوران');
    expect(text(renderer)).toContain('ليست شهادة على سلامة المستشعر');
    act(() => renderer.unmount());
  });

  it('interrupts honestly if the stream stops being live', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <OrientationStabilityPanel
          orientationView={view()}
          sampleSeq={1}
          sampleReceivedAt={1_000}
        />,
      );
    });
    act(() => find(renderer, 'orientation-stability-start').props.onPress());
    act(() => {
      renderer.update(
        <OrientationStabilityPanel
          orientationView={{
            status: 'STALE',
            rollDeg: 0,
            pitchDeg: 0,
            yawDeg: 0,
            ageMs: 600,
          }}
          sampleSeq={1}
          sampleReceivedAt={1_000}
        />,
      );
    });
    expect(find(renderer, 'orientation-stability-interrupted')).toBeDefined();
    act(() => renderer.unmount());
  });

  it('waits after a calibration acknowledgement and then starts automatically', () => {
    jest.useFakeTimers();
    const signal = {};
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <OrientationStabilityPanel
          orientationView={view()}
          sampleSeq={1}
          sampleReceivedAt={1_000}
        />,
      );
    });
    act(() => {
      renderer.update(
        <OrientationStabilityPanel
          orientationView={view()}
          sampleSeq={1}
          sampleReceivedAt={1_000}
          autoStartSignal={signal}
        />,
      );
    });
    expect(find(renderer, 'orientation-stability-settling')).toBeDefined();
    act(() => {
      jest.advanceTimersByTime(2_000);
    });
    // The cached pre-ack sample is deliberately not accepted as proof.
    expect(
      find(renderer, 'orientation-stability-waiting-for-sample'),
    ).toBeDefined();
    act(() => {
      renderer.update(
        <OrientationStabilityPanel
          orientationView={view()}
          sampleSeq={2}
          sampleReceivedAt={3_000}
          autoStartSignal={signal}
        />,
      );
    });
    expect(find(renderer, 'orientation-stability-progress')).toBeDefined();
    expect(text(renderer)).toContain('جارٍ القياس');
    act(() => renderer.unmount());
    jest.useRealTimers();
  });

  it('keeps waiting through a transient stale interval and starts on the next live post-calibration sample', () => {
    jest.useFakeTimers();
    try {
      const signal = {};
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      act(() => {
        renderer = ReactTestRenderer.create(
          <OrientationStabilityPanel
            orientationView={{
              status: 'STALE',
              rollDeg: 1,
              pitchDeg: 2,
              yawDeg: 0,
              ageMs: 600,
            }}
            sampleSeq={1}
            sampleReceivedAt={1_000}
            autoStartSignal={signal}
          />,
        );
      });
      act(() => jest.advanceTimersByTime(2_000));
      expect(
        find(renderer, 'orientation-stability-waiting-for-sample'),
      ).toBeDefined();
      expect(find(renderer, 'orientation-stability-interrupted')).toBeUndefined();

      act(() => {
        renderer.update(
          <OrientationStabilityPanel
            orientationView={view(0.2, -0.1)}
            sampleSeq={2}
            sampleReceivedAt={2_500}
            autoStartSignal={signal}
          />,
        );
      });
      expect(find(renderer, 'orientation-stability-progress')).toBeDefined();
      act(() => renderer.unmount());
    } finally {
      jest.useRealTimers();
    }
  });

  it('ends an automatic wait honestly when no live sample arrives', () => {
    jest.useFakeTimers();
    try {
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      act(() => {
        renderer = ReactTestRenderer.create(
          <OrientationStabilityPanel
            orientationView={{ status: 'WAITING' }}
            autoStartSignal={{}}
          />,
        );
      });
      act(() => jest.advanceTimersByTime(2_000));
      expect(
        find(renderer, 'orientation-stability-waiting-for-sample'),
      ).toBeDefined();
      act(() => jest.advanceTimersByTime(5_000));
      expect(find(renderer, 'orientation-stability-interrupted')).toBeDefined();
      expect(text(renderer)).toContain('لم تصل قراءة اتجاه مباشرة بعد المعايرة');
      act(() => renderer.unmount());
    } finally {
      jest.useRealTimers();
    }
  });

  it('restarts the settling delay when a newer calibration acknowledgement arrives', () => {
    jest.useFakeTimers();
    try {
      const first = {};
      const second = {};
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      act(() => {
        renderer = ReactTestRenderer.create(
          <OrientationStabilityPanel
            orientationView={view()}
            sampleSeq={1}
            sampleReceivedAt={1_000}
            autoStartSignal={first}
          />,
        );
      });
      act(() => jest.advanceTimersByTime(1_500));
      act(() => {
        renderer.update(
          <OrientationStabilityPanel
            orientationView={view()}
            sampleSeq={1}
            sampleReceivedAt={1_000}
            autoStartSignal={second}
          />,
        );
      });
      act(() => jest.advanceTimersByTime(700));
      expect(find(renderer, 'orientation-stability-settling')).toBeDefined();
      expect(find(renderer, 'orientation-stability-progress')).toBeUndefined();
      act(() => jest.advanceTimersByTime(1_300));
      expect(
        find(renderer, 'orientation-stability-waiting-for-sample'),
      ).toBeDefined();
      act(() => {
        renderer.update(
          <OrientationStabilityPanel
            orientationView={view()}
            sampleSeq={2}
            sampleReceivedAt={3_500}
            autoStartSignal={second}
          />,
        );
      });
      expect(find(renderer, 'orientation-stability-progress')).toBeDefined();
      act(() => renderer.unmount());
    } finally {
      jest.useRealTimers();
    }
  });
});
