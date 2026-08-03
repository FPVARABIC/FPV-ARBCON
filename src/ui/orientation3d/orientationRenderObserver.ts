/**
 * Checkpoint F - THE LAST TWO BOUNDARIES, OBSERVED IN A REAL BUILD.
 *
 * WHY THIS IS NOT orientationLatencyDebugLog.ts. That module answers a
 * different question (how many milliseconds a sample took to reach the
 * scene) and is deliberately `__DEV__`-gated, so in the build a user
 * actually runs it resolves to DISABLED_TRACKER and records nothing at
 * all. When a real flight controller reported a frozen Setup model
 * through the published preview, that gate meant the two boundaries
 * closest to the symptom - "did the hero receive a sample" and "did the
 * renderer receive a CHANGED pose" - were the only ones in the whole
 * pipeline with no field evidence whatsoever.
 *
 * THE ONE FACT THIS EXISTS FOR: `distinctPoseCount`. A scheduler that
 * reports thousands of successful MSP_ATTITUDE responses while the
 * renderer has seen exactly ONE distinct pose is a flight controller
 * reporting a constant attitude - not a broken app. The reverse (many
 * distinct poses published, one renderer render) is a broken app. Those
 * two are indistinguishable from a motionless model on screen, and
 * distinguishing them is the entire point.
 *
 * BOUNDED BY CONSTRUCTION. This is a fixed-size record of counters and
 * one last pose - not a list, not a ring buffer, not a Map. It cannot
 * grow, it allocates nothing per sample beyond number assignments, it
 * schedules no timer and no animation frame, and it holds no reference
 * to a session, a client or a frame. Recording is a handful of numeric
 * comparisons on a path that already runs per render.
 *
 * NO PAYLOAD. Angles in DISPLAY degrees (already offset-applied and
 * rounded upstream by the view model) and counters. Never wire bytes,
 * never a raw frame, never an error message.
 */

export type OrientationRenderObservation = {
  /** `${sessionId}:${generation}` of the last observed sample - a
   * sampleSeq only means anything inside one of these. */
  readonly sessionToken: string | undefined;
  readonly lastSampleSeq: number | undefined;
  /** The OrientationViewState status the hero rendered ('LIVE',
   * 'STALE', 'WAITING', 'ERROR') - so a report can never claim a live
   * model while the hero was actually drawing a stale one. */
  readonly lastStatus: string | undefined;
  readonly lastRollDeg: number | undefined;
  readonly lastPitchDeg: number | undefined;
  readonly lastYawDeg: number | undefined;
  /** How many times the hero rendered a drawable (LIVE/STALE) sample. */
  readonly heroSampleCount: number;
  /** How many times the platform renderer was handed a pose. */
  readonly rendererSampleCount: number;
  /** How many times that pose was DIFFERENT from the previous one.
   * Starts at 0 and becomes 1 on the very first pose. */
  readonly distinctPoseCount: number;
  /** Milliseconds-since-page-load stamp of the most recent pose CHANGE,
   * or undefined if the pose has never changed. Same clock as
   * connectionDiagnostics.ts (performance.now()), so the two reports
   * are directly comparable. */
  readonly lastPoseChangeAtMs: number | undefined;
};

const EMPTY: OrientationRenderObservation = Object.freeze({
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

function nowMs(): number {
  return typeof performance !== 'undefined' ? Math.round(performance.now()) : 0;
}

export interface OrientationRenderObserver {
  /**
   * Called by OrientationHero on EVERY render, including the WAITING and
   * ERROR branches that draw no pose at all (`pose: undefined`).
   *
   * Recording only the drawable branches was tried first and reverted:
   * the hero passes through STALE on its way to ERROR, so the last
   * recorded status stayed 'STALE' while the screen was actually showing
   * the error state - a report that contradicts the screen is worse than
   * no report. A pose-less status therefore CLEARS the recorded angles
   * rather than leaving an older sample's angles standing next to a
   * status they do not belong to.
   */
  noteHeroSample(
    sessionToken: string | undefined,
    sampleSeq: number | undefined,
    status: string,
    pose: {rollDeg: number; pitchDeg: number; yawDeg: number} | undefined,
  ): void;
  /** Called by the platform renderer with the pose it was handed. This
   * is the boundary that decides whether the SVG (or Skia) surface ever
   * received changed orientation props. */
  noteRendererPose(pose: {rollDeg: number; pitchDeg: number; yawDeg: number}): void;
  read(): OrientationRenderObservation;
  /** Test seam, and the reset a new physical session deserves so counts
   * from a previous connection can never be read as this one's. */
  reset(): void;
}

class OrientationRenderObserverImpl implements OrientationRenderObserver {
  private state: OrientationRenderObservation = EMPTY;
  /** Kept separately from `state` so the pose comparison never depends
   * on which of the two call sites ran most recently. */
  private lastRendererPose: {rollDeg: number; pitchDeg: number; yawDeg: number} | undefined;

  constructor(private readonly now: () => number) {}

  noteHeroSample(
    sessionToken: string | undefined,
    sampleSeq: number | undefined,
    status: string,
    pose: {rollDeg: number; pitchDeg: number; yawDeg: number} | undefined,
  ): void {
    this.state = {
      ...this.state,
      sessionToken,
      lastSampleSeq: sampleSeq,
      lastStatus: status,
      lastRollDeg: pose?.rollDeg,
      lastPitchDeg: pose?.pitchDeg,
      lastYawDeg: pose?.yawDeg,
      // Only a DRAWABLE sample counts as one the hero rendered.
      heroSampleCount:
        pose === undefined ? this.state.heroSampleCount : this.state.heroSampleCount + 1,
    };
  }

  noteRendererPose(pose: {rollDeg: number; pitchDeg: number; yawDeg: number}): void {
    const previous = this.lastRendererPose;
    // Exact equality on purpose: the view model already normalized and
    // offset-applied these, and "the FC reported the identical
    // decidegree triple again" is exactly the fact being counted. A
    // tolerance here would hide a genuinely frozen source.
    const changed =
      previous === undefined ||
      previous.rollDeg !== pose.rollDeg ||
      previous.pitchDeg !== pose.pitchDeg ||
      previous.yawDeg !== pose.yawDeg;
    this.lastRendererPose = {rollDeg: pose.rollDeg, pitchDeg: pose.pitchDeg, yawDeg: pose.yawDeg};
    this.state = {
      ...this.state,
      rendererSampleCount: this.state.rendererSampleCount + 1,
      distinctPoseCount: changed ? this.state.distinctPoseCount + 1 : this.state.distinctPoseCount,
      lastPoseChangeAtMs: changed ? this.now() : this.state.lastPoseChangeAtMs,
    };
  }

  read(): OrientationRenderObservation {
    return this.state;
  }

  reset(): void {
    this.state = EMPTY;
    this.lastRendererPose = undefined;
  }
}

export function createOrientationRenderObserver(now: () => number = nowMs): OrientationRenderObserver {
  return new OrientationRenderObserverImpl(now);
}

/** The one observer the production Orientation path uses - a module
 * singleton for the same reason orientationLatencyTracker is one: the
 * hero and the renderer are different components observing the SAME
 * sample, and a per-component instance could never join them. */
export const orientationRenderObserver: OrientationRenderObserver = createOrientationRenderObserver();
