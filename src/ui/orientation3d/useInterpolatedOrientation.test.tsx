/**
 * Model-only visual interpolation - the hook's whole contract, including
 * every cancellation path that keeps it from leaking a frame or bleeding
 * one session's attitude into the next.
 *
 * requestAnimationFrame is driven deterministically here: the real one is
 * replaced by a queue this test steps by hand, so nothing depends on wall
 * clock, frame rate or machine load, and an uncancelled frame is directly
 * observable as a leftover queue entry rather than as flakiness.
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';

import {
  useInterpolatedOrientation,
  shortestAngleDelta,
  ORIENTATION_INTERPOLATION_MS,
} from './useInterpolatedOrientation';
import type {InterpolatedOrientation} from './useInterpolatedOrientation';

type Frame = {id: number; callback: (timestamp: number) => void};

let pending: Frame[] = [];
let nextFrameId = 1;
let cancelledIds: number[] = [];
let originalRaf: typeof globalThis.requestAnimationFrame;
let originalCancel: typeof globalThis.cancelAnimationFrame;

beforeEach(() => {
  pending = [];
  cancelledIds = [];
  nextFrameId = 1;
  originalRaf = globalThis.requestAnimationFrame;
  originalCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = ((callback: (timestamp: number) => void) => {
    const id = nextFrameId++;
    pending.push({id, callback});
    return id;
  }) as unknown as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => {
    cancelledIds.push(id);
    pending = pending.filter(frame => frame.id !== id);
  }) as unknown as typeof globalThis.cancelAnimationFrame;
});

afterEach(() => {
  globalThis.requestAnimationFrame = originalRaf;
  globalThis.cancelAnimationFrame = originalCancel;
});

/** Runs every frame currently queued, at `timestamp`. Frames scheduled BY
 * those callbacks land in the next batch, exactly like a real vsync. */
function runQueuedFrames(timestamp: number): void {
  const batch = pending;
  pending = [];
  for (const frame of batch) {
    frame.callback(timestamp);
  }
}

/** A probe that renders the hook's output so the test can read the pose
 * the MODEL would receive, separately from any numeric readout. */
function Probe({
  target,
  resetToken,
  onRender,
}: {
  target: InterpolatedOrientation | null;
  resetToken?: string;
  onRender: (value: InterpolatedOrientation | null) => void;
}): React.JSX.Element {
  const value = useInterpolatedOrientation(target, {resetToken});
  onRender(value);
  return <Text>{value ? `${value.rollDeg},${value.pitchDeg},${value.yawDeg}` : 'none'}</Text>;
}

function mount(props: {target: InterpolatedOrientation | null; resetToken?: string}) {
  const rendered: Array<InterpolatedOrientation | null> = [];
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    renderer = ReactTestRenderer.create(
      <Probe {...props} onRender={value => rendered.push(value)} />,
    );
  });
  const update = (next: {target: InterpolatedOrientation | null; resetToken?: string}) => {
    act(() => {
      renderer.update(<Probe {...next} onRender={value => rendered.push(value)} />);
    });
  };
  const latest = () => rendered[rendered.length - 1];
  return {renderer, rendered, update, latest};
}

describe('shortestAngleDelta', () => {
  it('crosses 359 -> 1 the short way (+2), never the long way (-358)', () => {
    expect(shortestAngleDelta(359, 1)).toBe(2);
  });

  it('crosses 1 -> 359 the short way (-2)', () => {
    expect(shortestAngleDelta(1, 359)).toBe(-2);
  });

  it('handles the exact half turn deterministically and ordinary deltas unchanged', () => {
    expect(Math.abs(shortestAngleDelta(0, 180))).toBe(180);
    expect(shortestAngleDelta(10, 40)).toBe(30);
  });
});

describe('useInterpolatedOrientation', () => {
  const A: InterpolatedOrientation = {rollDeg: 0, pitchDeg: 0, yawDeg: 0};

  it('snaps to the very first sample of a session - there is no previous genuine pose to ease from', () => {
    const {latest} = mount({target: A, resetToken: 's:1'});
    expect(latest()).toEqual(A);
    expect(pending).toHaveLength(0);
  });

  it('eases between two genuine samples and lands exactly on the newest one', () => {
    const {update, latest} = mount({target: A, resetToken: 's:1'});
    update({target: {rollDeg: 20, pitchDeg: 10, yawDeg: 40}, resetToken: 's:1'});

    act(() => runQueuedFrames(0)); // establishes the frame baseline
    act(() => runQueuedFrames(ORIENTATION_INTERPOLATION_MS / 2));
    const midway = latest()!;
    // Strictly between the two GENUINE samples - never past the target.
    expect(midway.rollDeg).toBeGreaterThan(0);
    expect(midway.rollDeg).toBeLessThan(20);
    expect(midway.yawDeg).toBeGreaterThan(0);
    expect(midway.yawDeg).toBeLessThan(40);

    act(() => runQueuedFrames(ORIENTATION_INTERPOLATION_MS * 2));
    expect(latest()).toEqual({rollDeg: 20, pitchDeg: 10, yawDeg: 40});
    // Arrived: the loop stopped scheduling.
    expect(pending).toHaveLength(0);
  });

  it('takes the SHORTEST path across 359 -> 0 rather than sweeping backwards through the compass', () => {
    const {update, latest} = mount({target: {rollDeg: 0, pitchDeg: 0, yawDeg: 359}, resetToken: 's:1'});
    update({target: {rollDeg: 0, pitchDeg: 0, yawDeg: 1}, resetToken: 's:1'});

    act(() => runQueuedFrames(0));
    act(() => runQueuedFrames(ORIENTATION_INTERPOLATION_MS / 2));
    const midway = latest()!.yawDeg;
    // Halfway on the short path is ~0 (i.e. >=359 or <=1), never ~180.
    expect(midway >= 358 || midway <= 2).toBe(true);
    expect(Math.abs(midway - 180)).toBeGreaterThan(100);
  });

  it('STOPS on STALE: a null target cancels the in-flight frame and freezes on the last genuine pose', () => {
    const {update, latest} = mount({target: A, resetToken: 's:1'});
    update({target: {rollDeg: 30, pitchDeg: 0, yawDeg: 0}, resetToken: 's:1'});
    act(() => runQueuedFrames(0));
    expect(pending.length).toBeGreaterThan(0);

    const frozen = latest();
    update({target: null, resetToken: 's:1'}); // STALE / WAITING / ERROR
    expect(pending).toHaveLength(0); // the frame was cancelled, not left running
    expect(cancelledIds.length).toBeGreaterThan(0);
    expect(latest()).toEqual(frozen); // frozen on a real sample, not an invented one
  });

  it('SNAPS across a session replacement - a new generation never sweeps in from the old one attitude', () => {
    const {update, latest} = mount({target: {rollDeg: 0, pitchDeg: 0, yawDeg: 350}, resetToken: 's:1'});
    // Replacement generation, wildly different attitude.
    update({target: {rollDeg: 0, pitchDeg: 0, yawDeg: 10}, resetToken: 's:2'});
    expect(latest()).toEqual({rollDeg: 0, pitchDeg: 0, yawDeg: 10});
    expect(pending).toHaveLength(0);
  });

  it('a frame left over from the OLD session cannot move the NEW session model', () => {
    const {update, latest} = mount({target: A, resetToken: 's:1'});
    update({target: {rollDeg: 40, pitchDeg: 0, yawDeg: 0}, resetToken: 's:1'});
    act(() => runQueuedFrames(0));
    const staleFrames = [...pending];
    expect(staleFrames.length).toBeGreaterThan(0);

    // Session replaced while that frame was still queued.
    update({target: {rollDeg: -5, pitchDeg: 0, yawDeg: 0}, resetToken: 's:2'});
    // The new session snapped, so it owns no running animation of its own.
    expect(latest()).toEqual({rollDeg: -5, pitchDeg: 0, yawDeg: 0});

    // Even if the runtime delivered the OLD session's frame anyway, it
    // must change nothing and must not resurrect the animation.
    act(() => {
      for (const frame of staleFrames) {
        frame.callback(ORIENTATION_INTERPOLATION_MS);
      }
    });
    expect(latest()).toEqual({rollDeg: -5, pitchDeg: 0, yawDeg: 0});
    expect(pending).toHaveLength(0);
  });

  it('leaves NO frame scheduled after unmount', () => {
    const {renderer, update} = mount({target: A, resetToken: 's:1'});
    update({target: {rollDeg: 25, pitchDeg: 0, yawDeg: 0}, resetToken: 's:1'});
    act(() => runQueuedFrames(0));
    expect(pending.length).toBeGreaterThan(0);

    act(() => {
      renderer.unmount();
    });
    expect(pending).toHaveLength(0);
  });

  it('never schedules a frame at all while the target stays null', () => {
    const {update} = mount({target: null, resetToken: 's:1'});
    update({target: null, resetToken: 's:1'});
    expect(pending).toHaveLength(0);
  });
});
