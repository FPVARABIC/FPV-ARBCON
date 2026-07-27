/**
 * The renderer's LATENCY contract - not its looks.
 *
 * OrientationRenderer.tsx's own doc comment explains why it has no
 * appearance test: its geometry lives in droneSceneGeometry.ts (already
 * covered GPU-free) and everything left is Skia draw calls that only the
 * eye can judge. What this file tests is different and newly load-
 * bearing: HOW OFTEN the scene is built, whether the native Canvas
 * survives a burst of samples, and that no animation frame is scheduled.
 * Those are the properties that decide whether the model keeps up with
 * the aircraft on a real device.
 *
 * @shopify/react-native-skia is replaced with a minimal stub rather than
 * using the package's own jestSetup mock: that mock's Skia.Path API is
 * built from a real CanvasKit instance, so Skia.Path.Make() throws
 * without one (verified, see OrientationRenderer.tsx's doc comment). A
 * stub also keeps library internals from contaminating the "did the
 * application schedule a frame?" assertions below.
 */

jest.mock('@shopify/react-native-skia', () => {
  const ReactModule = require('react');
  const {View} = require('react-native');
  const makePath = () => ({
    moveTo: jest.fn(),
    lineTo: jest.fn(),
    close: jest.fn(),
  });
  // Counts native-surface lifecycle events. A real Canvas mount creates
  // an Android surface and an unmount destroys it, so "how many times
  // was the Canvas mounted" is the closest thing Jest can observe to
  // "how many times was the native surface recreated".
  const canvasLifecycle = {mounts: 0, unmounts: 0};
  const Canvas = ({children}: {children?: React.ReactNode}) => {
    ReactModule.useEffect(() => {
      canvasLifecycle.mounts += 1;
      return () => {
        canvasLifecycle.unmounts += 1;
      };
    }, []);
    return <View testID="skia-canvas">{children}</View>;
  };
  return {
    Canvas,
    Path: () => <View testID="skia-path" />,
    Skia: {Path: {Make: makePath}},
    __canvasLifecycle: canvasLifecycle,
  };
});

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import {OrientationRenderer} from './OrientationRenderer';
import * as geometry from './droneSceneGeometry';
import type {DroneOrientationDeg} from './droneSceneGeometry';

const SIZE = 260;

const canvasLifecycle = (
  jest.requireMock('@shopify/react-native-skia') as {__canvasLifecycle: {mounts: number; unmounts: number}}
).__canvasLifecycle;

/** findAllByProps() matches BOTH a logical element and the host instance
 * that forwards the same testID, so every count here filters to host
 * nodes - the same disambiguation SetupScreen.test.tsx already documents. */
function findAllByTestID(renderer: ReactTestRenderer.ReactTestRenderer, testID: string) {
  return renderer.root.findAllByProps({testID}).filter(node => typeof node.type === 'string');
}

/** Counts REAL scene builds - the expensive work (38 primitives, 511
 * points, one SkPath each) this pass exists to bound. */
function spyOnSceneBuilds() {
  return jest.spyOn(geometry, 'computeDroneScene');
}

describe('OrientationRenderer - scene-build bound', () => {
  let buildSpy: jest.SpyInstance;
  const mounted: ReactTestRenderer.ReactTestRenderer[] = [];

  beforeEach(() => {
    buildSpy = spyOnSceneBuilds();
  });

  afterEach(() => {
    act(() => {
      for (const renderer of mounted.splice(0)) {
        renderer.unmount();
      }
    });
    buildSpy.mockRestore();
  });

  function mount(orientation: DroneOrientationDeg) {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <OrientationRenderer orientation={orientation} width={SIZE} height={SIZE} />,
      );
    });
    mounted.push(renderer);
    const update = (next: DroneOrientationDeg, stale = false) => {
      act(() => {
        renderer.update(<OrientationRenderer orientation={next} width={SIZE} height={SIZE} stale={stale} />);
      });
    };
    return {renderer, update};
  }

  it('builds exactly ONE scene per committed pose across a 100-sample burst', () => {
    const {update} = mount({rollDeg: 0, pitchDeg: 0, yawDeg: 0});
    expect(buildSpy).toHaveBeenCalledTimes(1);

    for (let i = 1; i <= 100; i++) {
      update({rollDeg: i % 40, pitchDeg: -(i % 25), yawDeg: (i * 3) % 360});
    }

    // 1 mount + 100 distinct poses. Never a build per display frame,
    // which is what the retired animation loop caused.
    expect(buildSpy).toHaveBeenCalledTimes(101);
  });

  it('does NOT rebuild when the pose is unchanged - a re-render is not a new sample', () => {
    const pose = {rollDeg: 7, pitchDeg: -3, yawDeg: 120};
    const {update} = mount(pose);
    expect(buildSpy).toHaveBeenCalledTimes(1);

    update({...pose});
    update({...pose});
    update({...pose});

    expect(buildSpy).toHaveBeenCalledTimes(1);
  });

  it('rebuilds for a genuine LAYOUT change, which is a different scene and must not be memoized away', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    const pose = {rollDeg: 4, pitchDeg: 4, yawDeg: 4};
    act(() => {
      renderer = ReactTestRenderer.create(<OrientationRenderer orientation={pose} width={SIZE} height={SIZE} />);
    });
    mounted.push(renderer);
    expect(buildSpy).toHaveBeenCalledTimes(1);

    act(() => {
      renderer.update(<OrientationRenderer orientation={pose} width={SIZE * 2} height={SIZE} />);
    });
    expect(buildSpy).toHaveBeenCalledTimes(2);
  });

  it('the LAST built scene carries the LAST pose - never an earlier one', () => {
    const {update} = mount({rollDeg: 0, pitchDeg: 0, yawDeg: 0});
    for (let i = 1; i <= 20; i++) {
      update({rollDeg: i, pitchDeg: -i, yawDeg: i * 5});
    }
    const lastCall = buildSpy.mock.calls[buildSpy.mock.calls.length - 1];
    expect(lastCall[0]).toEqual({rollDeg: 20, pitchDeg: -20, yawDeg: 100});
  });

  it('a STALE flag alone re-renders but does not rebuild the scene - dimming is not new geometry', () => {
    const pose = {rollDeg: 9, pitchDeg: 2, yawDeg: 300};
    const {update} = mount(pose);
    expect(buildSpy).toHaveBeenCalledTimes(1);

    update({...pose}, true);

    expect(buildSpy).toHaveBeenCalledTimes(1);
  });
});

describe('OrientationRenderer - Canvas stability and no app-owned frame loop', () => {
  const mounted: ReactTestRenderer.ReactTestRenderer[] = [];
  let rafSpy: jest.SpyInstance;
  let intervalSpy: jest.SpyInstance;
  let timeoutSpy: jest.SpyInstance;

  beforeEach(() => {
    canvasLifecycle.mounts = 0;
    canvasLifecycle.unmounts = 0;
    // The Skia stub above draws nothing, so anything these record was
    // scheduled by the application's own Orientation path.
    rafSpy = jest.spyOn(globalThis, 'requestAnimationFrame');
    intervalSpy = jest.spyOn(globalThis, 'setInterval');
    timeoutSpy = jest.spyOn(globalThis, 'setTimeout');
  });

  afterEach(() => {
    act(() => {
      for (const renderer of mounted.splice(0)) {
        renderer.unmount();
      }
    });
    rafSpy.mockRestore();
    intervalSpy.mockRestore();
    timeoutSpy.mockRestore();
  });

  it('updating samples schedules NO animation frame, interval or delayed timer', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <OrientationRenderer orientation={{rollDeg: 0, pitchDeg: 0, yawDeg: 0}} width={SIZE} height={SIZE} />,
      );
    });
    mounted.push(renderer);

    for (let i = 1; i <= 30; i++) {
      act(() => {
        renderer.update(
          <OrientationRenderer
            orientation={{rollDeg: i, pitchDeg: -i, yawDeg: (i * 11) % 360}}
            width={SIZE}
            height={SIZE}
          />,
        );
      });
    }

    expect(rafSpy).not.toHaveBeenCalled();
    expect(intervalSpy).not.toHaveBeenCalled();
    expect(timeoutSpy).not.toHaveBeenCalled();
  });

  it('keeps ONE Canvas mounted across a burst - the native surface is never recreated per sample', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <OrientationRenderer orientation={{rollDeg: 0, pitchDeg: 0, yawDeg: 0}} width={SIZE} height={SIZE} />,
      );
    });
    mounted.push(renderer);

    expect(findAllByTestID(renderer, 'skia-canvas')).toHaveLength(1);
    expect(canvasLifecycle.mounts).toBe(1);

    for (let i = 1; i <= 50; i++) {
      act(() => {
        renderer.update(
          <OrientationRenderer
            orientation={{rollDeg: i % 30, pitchDeg: 0, yawDeg: i * 7}}
            width={SIZE}
            height={SIZE}
          />,
        );
      });
    }

    expect(findAllByTestID(renderer, 'skia-canvas')).toHaveLength(1);
    // Still the ORIGINAL mount: React reconciled the Canvas through all
    // 50 updates rather than unmounting and remounting it, which is what
    // a sample-dependent key would have caused.
    expect(canvasLifecycle.mounts).toBe(1);
    expect(canvasLifecycle.unmounts).toBe(0);
  });

  it('draws every primitive of the scene, plus one outline pass for the airframe materials', () => {
    const pose = {rollDeg: 5, pitchDeg: 5, yawDeg: 45};
    const primitives = geometry.computeDroneScene(pose, {width: SIZE, height: SIZE}).primitives;
    // FINAL-POLISH PASS: the visibility outline is a SECOND draw of the
    // same memoized path for the airframe materials only - the prop
    // discs and the level grid are deliberately not outlined. So the
    // expected draw count is fills + outlines, and this test still
    // fails if any primitive is dropped.
    const OUTLINED = new Set(['HUB', 'ARM', 'ARROW', 'MOTOR_FRONT', 'MOTOR_REAR', 'PROP_RING_FRONT', 'PROP_RING_REAR']);
    const outlineCount = primitives.filter(p => OUTLINED.has(p.material)).length;
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<OrientationRenderer orientation={pose} width={SIZE} height={SIZE} />);
    });
    mounted.push(renderer);

    expect(primitives.length).toBeGreaterThan(0);
    expect(outlineCount).toBeGreaterThan(0);
    expect(findAllByTestID(renderer, 'skia-path')).toHaveLength(primitives.length + outlineCount);
  });

  it('the outline reuses the SAME memoized path object as its fill - no second geometry build', () => {
    const pose = {rollDeg: 3, pitchDeg: -2, yawDeg: 15};
    const buildSpy = jest.spyOn(geometry, 'computeDroneScene');
    try {
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      act(() => {
        renderer = ReactTestRenderer.create(<OrientationRenderer orientation={pose} width={SIZE} height={SIZE} />);
      });
      mounted.push(renderer);
      // One scene build for the whole draw, outlines included.
      expect(buildSpy).toHaveBeenCalledTimes(1);
    } finally {
      buildSpy.mockRestore();
    }
  });
});
