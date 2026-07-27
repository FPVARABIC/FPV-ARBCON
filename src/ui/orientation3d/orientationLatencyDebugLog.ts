/**
 * BOUNDED, development-only latency observability for the Orientation
 * model path, under one stable prefix: [FPV-ORIENT-LATENCY].
 *
 * Same design rules as batteryDebugLog.ts ([FPV-BATT]) and
 * auxTelemetryDebugLog.ts ([FPV-TELEM]), which this module deliberately
 * mirrors rather than inventing a second convention: __DEV__-gated,
 * silenced under Jest, injectable sink for tests, bounded state, never
 * raw frames, no personal data.
 *
 * WHAT IT ANSWERS. One record per GENUINE sample, tracing that sample
 * from the scheduler's publication to the moment its Skia scene was
 * built:
 *
 *   [FPV-ORIENT-LATENCY] session=<id> gen=<n> seq=<n> status=FRESH
 *     hero=+3ms renderer=+3ms scene=+5ms roll=... pitch=... heading=...
 *
 * The offsets are relative to sampleReceivedAt, so the record reads as
 * "this sample reached the model in N ms".
 *
 * CLOCK. Date.now(), deliberately - the scheduler's own production
 * MonotonicClock (RealClock, clock.ts) is Date.now()-based, so
 * `updatedAtMs` on a TelemetryValue and the stamps taken here are in the
 * SAME domain and can be subtracted meaningfully. performance.now()
 * would be marginally better behaved across a wall-clock adjustment but
 * lives in a different origin, and mixing two domains would silently
 * produce nonsense deltas. Injectable for tests.
 *
 * WHAT sceneBuiltAt DOES NOT PROVE. It records when the JS scene was
 * BUILT and handed to Skia - not when a frame became physically visible
 * on the panel. Native surface presentation is downstream of everything
 * measurable from JavaScript. Visible latency must be judged from the
 * device or a video, never from these numbers alone.
 *
 * BOUNDED STATE. At most PENDING_LIMIT samples are tracked at once, and
 * an entry is deleted the instant its record is emitted. A sample that
 * never reaches the scene stage (superseded before it was drawn, which
 * is the normal and CORRECT outcome under latest-wins) is evicted
 * oldest-first rather than accumulating. Nothing here schedules a timer,
 * an interval or an animation frame.
 *
 * On-device filtering:
 *   POSIX:      adb logcat -v time ReactNativeJS:I '*:S' | grep FPV-ORIENT-LATENCY
 *   PowerShell: adb logcat -v time ReactNativeJS:I *:S | Select-String FPV-ORIENT-LATENCY
 */

export const ORIENTATION_LATENCY_LOG_TAG = 'FPV-ORIENT-LATENCY';

/** Small on purpose: only a handful of samples can be in flight between
 * publication and scene build, and anything older is by definition
 * already superseded. */
export const ORIENTATION_LATENCY_PENDING_LIMIT = 8;

declare const __DEV__: boolean | undefined;

function defaultSinkEnabled(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__ === true && typeof jest === 'undefined';
}

export type OrientationLatencySink = (line: string) => void;

export type OrientationLatencySampleIdentity = {
  /** Composite session identity - `${sessionId}:${generation}`. A
   * sampleSeq is only ever comparable within one of these. */
  readonly sessionToken: string;
  readonly sampleSeq: number;
};

type PendingRecord = {
  sessionToken: string;
  sampleSeq: number;
  status: string;
  sampleReceivedAt: number;
  heroReceivedAt?: number;
  rendererReceivedAt?: number;
  rollDeg?: number;
  pitchDeg?: number;
  yawDeg?: number;
};

function keyOf(identity: OrientationLatencySampleIdentity): string {
  return `${identity.sessionToken}#${identity.sampleSeq}`;
}

function round(value: number | undefined): string {
  return value === undefined ? '?' : `${Math.round(value * 10) / 10}`;
}

export interface OrientationLatencyTracker {
  /** The hero observed a genuine sample for the first time.
   * `sampleReceivedAt` is the scheduler's own publication stamp
   * (TelemetryValue.updatedAtMs), NOT a stamp taken here - that is what
   * makes the reported offsets measure real end-to-end UI latency. */
  noteHeroSample(
    identity: OrientationLatencySampleIdentity,
    sampleReceivedAt: number,
    status: string,
    displayed: {rollDeg: number; pitchDeg: number; yawDeg: number},
  ): void;
  /** The renderer received that same sample. */
  noteRendererSample(identity: OrientationLatencySampleIdentity): void;
  /** The Skia scene for that sample finished building - the final stage,
   * which emits the one record and frees the entry. */
  noteSceneBuilt(identity: OrientationLatencySampleIdentity): void;
  /** Diagnostic seam: how many samples are currently mid-flight. */
  pendingCount(): number;
}

class OrientationLatencyTrackerImpl implements OrientationLatencyTracker {
  /** Insertion-ordered (Map semantics), so oldest-first eviction is
   * exact rather than approximate. */
  private readonly pending = new Map<string, PendingRecord>();

  constructor(
    private readonly write: OrientationLatencySink,
    private readonly now: () => number,
  ) {}

  noteHeroSample(
    identity: OrientationLatencySampleIdentity,
    sampleReceivedAt: number,
    status: string,
    displayed: {rollDeg: number; pitchDeg: number; yawDeg: number},
  ): void {
    const key = keyOf(identity);
    if (this.pending.has(key)) {
      return; // at most one record per genuine sample
    }
    this.pending.set(key, {
      sessionToken: identity.sessionToken,
      sampleSeq: identity.sampleSeq,
      status,
      sampleReceivedAt,
      heroReceivedAt: this.now(),
      rollDeg: displayed.rollDeg,
      pitchDeg: displayed.pitchDeg,
      yawDeg: displayed.yawDeg,
    });
    this.evictOverflow();
  }

  noteRendererSample(identity: OrientationLatencySampleIdentity): void {
    const record = this.pending.get(keyOf(identity));
    if (record === undefined || record.rendererReceivedAt !== undefined) {
      return;
    }
    record.rendererReceivedAt = this.now();
  }

  noteSceneBuilt(identity: OrientationLatencySampleIdentity): void {
    const key = keyOf(identity);
    const record = this.pending.get(key);
    if (record === undefined) {
      return; // already emitted, or evicted as superseded
    }
    // Freed BEFORE writing, so a throwing sink cannot leak the entry.
    this.pending.delete(key);
    const sceneBuiltAt = this.now();
    const offset = (at: number | undefined): string =>
      at === undefined ? '?' : `+${Math.round(at - record.sampleReceivedAt)}ms`;
    this.write(
      `[${ORIENTATION_LATENCY_LOG_TAG}] ${record.sessionToken} seq=${record.sampleSeq} status=${record.status} ` +
        `hero=${offset(record.heroReceivedAt)} renderer=${offset(record.rendererReceivedAt)} ` +
        `scene=${offset(sceneBuiltAt)} ` +
        `roll=${round(record.rollDeg)} pitch=${round(record.pitchDeg)} heading=${round(record.yawDeg)}`,
    );
  }

  pendingCount(): number {
    return this.pending.size;
  }

  /** A sample superseded before it was ever drawn is the NORMAL
   * latest-wins outcome, not an error - it is dropped silently rather
   * than logged, so the log stays one line per DRAWN sample. */
  private evictOverflow(): void {
    while (this.pending.size > ORIENTATION_LATENCY_PENDING_LIMIT) {
      const oldest = this.pending.keys().next();
      if (oldest.done === true) {
        return;
      }
      this.pending.delete(oldest.value);
    }
  }
}

/** No-op implementation used in release builds and under Jest: every
 * call site stays unconditional and branch-free, and nothing is
 * allocated or retained when diagnostics are off. */
const DISABLED_TRACKER: OrientationLatencyTracker = Object.freeze({
  noteHeroSample: () => undefined,
  noteRendererSample: () => undefined,
  noteSceneBuilt: () => undefined,
  pendingCount: () => 0,
});

export function createOrientationLatencyTracker(options?: {
  sink?: OrientationLatencySink;
  now?: () => number;
}): OrientationLatencyTracker {
  const sink = options?.sink;
  if (sink === undefined && !defaultSinkEnabled()) {
    return DISABLED_TRACKER;
  }
  const write: OrientationLatencySink =
    sink ??
    ((line: string) => {
      console.log(line);
    });
  return new OrientationLatencyTrackerImpl(write, options?.now ?? Date.now);
}

/** The one tracker the production Orientation path uses. A module
 * singleton, mirroring the other cross-cutting singletons in this
 * codebase - the hero and the renderer are different components
 * observing the SAME sample, so a per-component instance could never
 * join their stamps into one record. */
export const orientationLatencyTracker: OrientationLatencyTracker = createOrientationLatencyTracker();
