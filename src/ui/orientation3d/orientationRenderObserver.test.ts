/**
 * The one fact this observer exists to establish: whether the renderer
 * was ever handed a CHANGED pose. A flight controller reporting a
 * constant attitude and an app that stopped repainting look identical on
 * screen; distinctPoseCount is what separates them, so its counting rule
 * is pinned here rather than left to the integration suite alone.
 */

import {createOrientationRenderObserver} from './orientationRenderObserver';

function makeObserver() {
  let clock = 0;
  const observer = createOrientationRenderObserver(() => (clock += 10));
  return observer;
}

describe('orientationRenderObserver', () => {
  it('starts completely empty - it never reports a sample it has not seen', () => {
    expect(makeObserver().read()).toEqual({
      sessionToken: undefined,
      lastSampleSeq: undefined,
      lastStatus: undefined,
      lastRollDeg: undefined,
      lastPitchDeg: undefined,
      lastYawDeg: undefined,
      heroSampleCount: 0,
      rendererSampleCount: 0,
      distinctPoseCount: 0,
      lastPoseChangeAtMs: undefined,
    });
  });

  it('counts the FIRST pose as a change, and identical repeats as none', () => {
    const observer = makeObserver();
    observer.noteRendererPose({rollDeg: 1, pitchDeg: 2, yawDeg: 3});
    expect(observer.read()).toMatchObject({rendererSampleCount: 1, distinctPoseCount: 1});

    observer.noteRendererPose({rollDeg: 1, pitchDeg: 2, yawDeg: 3});
    observer.noteRendererPose({rollDeg: 1, pitchDeg: 2, yawDeg: 3});
    expect(observer.read()).toMatchObject({rendererSampleCount: 3, distinctPoseCount: 1});
  });

  it('counts a change in ANY axis - a yaw-only movement is still movement', () => {
    const observer = makeObserver();
    observer.noteRendererPose({rollDeg: 0, pitchDeg: 0, yawDeg: 0});
    observer.noteRendererPose({rollDeg: 0, pitchDeg: 0, yawDeg: 1});
    observer.noteRendererPose({rollDeg: 0, pitchDeg: 0.1, yawDeg: 1});
    observer.noteRendererPose({rollDeg: -0.1, pitchDeg: 0.1, yawDeg: 1});
    expect(observer.read().distinctPoseCount).toBe(4);
  });

  it('stamps only genuine changes, so the last-change time never drifts forward on repeats', () => {
    const observer = makeObserver();
    observer.noteRendererPose({rollDeg: 1, pitchDeg: 0, yawDeg: 0});
    const firstChange = observer.read().lastPoseChangeAtMs;
    observer.noteRendererPose({rollDeg: 1, pitchDeg: 0, yawDeg: 0});
    observer.noteRendererPose({rollDeg: 1, pitchDeg: 0, yawDeg: 0});
    expect(observer.read().lastPoseChangeAtMs).toBe(firstChange);

    observer.noteRendererPose({rollDeg: 2, pitchDeg: 0, yawDeg: 0});
    expect(observer.read().lastPoseChangeAtMs).not.toBe(firstChange);
  });

  it('a pose-less status CLEARS the angles rather than leaving them beside a status they do not belong to', () => {
    const observer = makeObserver();
    observer.noteHeroSample('s:1', 4, 'LIVE', {rollDeg: 12.5, pitchDeg: -7, yawDeg: 214});
    expect(observer.read()).toMatchObject({
      lastStatus: 'LIVE',
      lastRollDeg: 12.5,
      heroSampleCount: 1,
    });

    observer.noteHeroSample('s:1', undefined, 'ERROR', undefined);
    expect(observer.read()).toMatchObject({
      lastStatus: 'ERROR',
      lastRollDeg: undefined,
      lastPitchDeg: undefined,
      lastYawDeg: undefined,
      // A pose-less render is not a sample the hero drew.
      heroSampleCount: 1,
    });
  });

  it('reset() clears everything, so a new physical session can never inherit the previous one\'s counts', () => {
    const observer = makeObserver();
    observer.noteHeroSample('s:1', 4, 'LIVE', {rollDeg: 1, pitchDeg: 1, yawDeg: 1});
    observer.noteRendererPose({rollDeg: 1, pitchDeg: 1, yawDeg: 1});
    observer.reset();
    expect(observer.read()).toMatchObject({
      heroSampleCount: 0,
      rendererSampleCount: 0,
      distinctPoseCount: 0,
      sessionToken: undefined,
    });
    // ...including the pose comparison baseline: the first pose after a
    // reset must count as a change again.
    observer.noteRendererPose({rollDeg: 1, pitchDeg: 1, yawDeg: 1});
    expect(observer.read().distinctPoseCount).toBe(1);
  });
});
