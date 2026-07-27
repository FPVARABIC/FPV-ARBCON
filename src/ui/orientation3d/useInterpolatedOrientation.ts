/**
 * Visual-only interpolation between two GENUINE MSP attitude samples.
 *
 * WHY THIS EXISTS, AND THE LINE IT DOES NOT CROSS. Attitude is polled at
 * the hardware-audited ~220 ms cadence (ATTITUDE_POLL_INTERVAL_MS), which
 * is a real ceiling, not a tuning knob - this hook does NOT raise it and
 * nothing here asks for more samples. Stepping the 3D model straight from
 * one sample to the next at that cadence reads as visibly jerky, so the
 * MODEL is eased between the last two real samples.
 *
 * What is interpolated: the pose handed to the renderer, and nothing
 * else. The numeric Roll/Pitch/Heading readouts, the accessibility
 * description and every decision the app makes stay bound to the latest
 * genuine sample - an animation frame is never a data source. This
 * narrows, and supersedes, the earlier blanket "never interpolates" note
 * on OrientationHero/OrientationRenderer: the prohibition that still
 * stands is on inventing DATA, and this hook invents none.
 *
 * It never predicts. Interpolation only ever runs BETWEEN two samples the
 * FC actually produced, easing from where the model currently is toward
 * the newest real pose. It never extrapolates past that pose, so the
 * model can lag a real movement by up to one animation duration but can
 * never show an attitude the aircraft has not reported.
 *
 * CANCELLATION is the whole safety story. The animation is a frame loop,
 * not a permanent interval, and it is cancelled - with the pose snapped
 * to the last genuine target - whenever:
 *   - `target` becomes null (the caller passes null for STALE, WAITING
 *     and ERROR, so a frozen model is always a real last sample);
 *   - `resetToken` changes (disconnect, session replacement, a different
 *     FC): the pose snaps rather than sweeping across from the previous
 *     session's attitude;
 *   - the component unmounts.
 * Every scheduled frame is cancelled in the effect's own cleanup, and the
 * loop stops scheduling as soon as it reaches the target, so nothing is
 * left running for Jest (or a real device) to leak.
 *
 * A late frame from an old session cannot affect a new one: the frame
 * callback is owned by the effect that scheduled it, that effect is
 * re-run on every `resetToken` change, and its cleanup cancels the
 * pending frame before the new one schedules anything.
 */

import {useEffect, useRef, useState} from 'react';

export type InterpolatedOrientation = {rollDeg: number; pitchDeg: number; yawDeg: number};

/** Bounded, and deliberately shorter than the ~220 ms sample cadence: a
 * duration at or above the cadence would still be catching up when the
 * next sample lands, compounding lag indefinitely. 160 ms leaves the
 * model settled on each genuine sample before the next one arrives. */
export const ORIENTATION_INTERPOLATION_MS = 160;

/** Shortest signed path from a to b, in (-180, 180]. 359 -> 1 is +2, not
 * -358: the model must never sweep the long way round the compass. */
export function shortestAngleDelta(from: number, to: number): number {
  let delta = (to - from) % 360;
  if (delta > 180) {
    delta -= 360;
  }
  if (delta <= -180) {
    delta += 360;
  }
  return delta;
}

function normalize360(value: number): number {
  return ((value % 360) + 360) % 360;
}

/** Linear ease is deliberate: the samples are evenly spaced, so a
 * constant-rate sweep between them is the honest visual, and an
 * easing curve would imply acceleration the FC never reported. */
function stepToward(current: InterpolatedOrientation, target: InterpolatedOrientation, t: number): InterpolatedOrientation {
  return {
    rollDeg: current.rollDeg + (target.rollDeg - current.rollDeg) * t,
    pitchDeg: current.pitchDeg + (target.pitchDeg - current.pitchDeg) * t,
    yawDeg: normalize360(current.yawDeg + shortestAngleDelta(current.yawDeg, target.yawDeg) * t),
  };
}

function sameOrientation(a: InterpolatedOrientation, b: InterpolatedOrientation): boolean {
  return a.rollDeg === b.rollDeg && a.pitchDeg === b.pitchDeg && a.yawDeg === b.yawDeg;
}

export type UseInterpolatedOrientationOptions = {
  /** Changing this snaps instead of animating - pass the composite
   * session identity so a replacement generation never sweeps across
   * from the previous one's attitude. */
  resetToken?: string;
  durationMs?: number;
};

/**
 * Returns the pose the MODEL should draw this frame. `target` is the
 * latest genuine sample, or null when there is nothing live to move
 * toward (STALE/WAITING/ERROR) - in which case the last genuine pose is
 * held, frozen, with no frames scheduled.
 */
export function useInterpolatedOrientation(
  target: InterpolatedOrientation | null,
  options: UseInterpolatedOrientationOptions = {},
): InterpolatedOrientation | null {
  const {resetToken, durationMs = ORIENTATION_INTERPOLATION_MS} = options;
  const [displayed, setDisplayed] = useState<InterpolatedOrientation | null>(target);

  // Snap (never sweep) across a session boundary. Done as a RENDER-PHASE
  // adjustment rather than in an effect, deliberately: an effect would
  // run after the interpolation effect below had already scheduled a
  // frame easing out of the OLD session's attitude. React re-renders
  // immediately on a render-phase setState of this same component, so
  // every effect in the committed render already sees the snapped pose.
  const lastTokenRef = useRef<string | undefined>(resetToken);
  if (lastTokenRef.current !== resetToken) {
    lastTokenRef.current = resetToken;
    setDisplayed(target);
  }

  // Read inside the frame loop so a frame never depends on a stale
  // render closure, and so the loop can stop the instant it arrives.
  const displayedRef = useRef<InterpolatedOrientation | null>(displayed);
  displayedRef.current = displayed;

  // Monotonic id for the CURRENT animation. A frame callback captures the
  // id it was scheduled under and does nothing if that id is no longer
  // current - so even a late callback the runtime delivers after
  // cancelAnimationFrame (or after a session change) cannot move the
  // model or schedule another frame.
  const runIdRef = useRef(0);

  useEffect(() => {
    runIdRef.current += 1;
    if (target === null) {
      return; // frozen on the last genuine pose; nothing scheduled
    }
    const from = displayedRef.current;
    if (from === null || durationMs <= 0) {
      setDisplayed(target);
      return;
    }
    if (sameOrientation(from, target)) {
      return;
    }

    const start = from;
    const runId = runIdRef.current;
    let frame: number | undefined;
    let elapsed = 0;
    let previousTimestamp: number | undefined;

    const tick = (timestamp: number) => {
      if (runIdRef.current !== runId) {
        return; // retired animation - a newer target or session owns the model now
      }
      // Frame deltas, not wall-clock arithmetic against a captured start:
      // a paused/backgrounded JS thread must resume easing, not jump.
      elapsed += previousTimestamp === undefined ? 0 : Math.max(0, timestamp - previousTimestamp);
      previousTimestamp = timestamp;
      const progress = Math.min(1, elapsed / durationMs);
      setDisplayed(progress >= 1 ? target : stepToward(start, target, progress));
      if (progress < 1) {
        frame = requestAnimationFrame(tick);
      } else {
        frame = undefined;
      }
    };
    frame = requestAnimationFrame(tick);

    return () => {
      // Retire this animation first, so a callback already handed to the
      // runtime is inert even if cancelAnimationFrame comes too late.
      runIdRef.current += 1;
      if (frame !== undefined) {
        cancelAnimationFrame(frame);
        frame = undefined;
      }
    };
  }, [target, durationMs]);

  return displayed;
}
