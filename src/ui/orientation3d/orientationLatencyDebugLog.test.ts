/**
 * The diagnostics must never become a second defect: no unbounded map,
 * no duplicate lines, no work scheduled of its own, and nothing at all
 * in a release build.
 */

import {
  createOrientationLatencyTracker,
  orientationLatencyTracker,
  ORIENTATION_LATENCY_LOG_TAG,
  ORIENTATION_LATENCY_PENDING_LIMIT,
} from './orientationLatencyDebugLog';

const SESSION = 'usb-1:3';

function makeTracker() {
  const lines: string[] = [];
  let clock = 1_000;
  const tracker = createOrientationLatencyTracker({
    sink: line => lines.push(line),
    now: () => clock,
  });
  return {
    tracker,
    lines,
    advance: (ms: number) => {
      clock += ms;
    },
    at: () => clock,
  };
}

const POSE = {rollDeg: 4.25, pitchDeg: -2.5, yawDeg: 271.4};

describe('orientation latency diagnostics', () => {
  it('emits ONE record per genuine sample, with offsets measured from the scheduler publication stamp', () => {
    const {tracker, lines, advance} = makeTracker();
    const identity = {sessionToken: SESSION, sampleSeq: 7};

    // Published at 980; the hero sees it 20ms later on this same clock.
    tracker.noteHeroSample(identity, 980, 'LIVE', POSE);
    advance(4);
    tracker.noteRendererSample(identity);
    advance(6);
    tracker.noteSceneBuilt(identity);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`[${ORIENTATION_LATENCY_LOG_TAG}]`);
    expect(lines[0]).toContain(`${SESSION} seq=7 status=LIVE`);
    expect(lines[0]).toContain('hero=+20ms');
    expect(lines[0]).toContain('renderer=+24ms');
    expect(lines[0]).toContain('scene=+30ms');
    expect(lines[0]).toContain('roll=4.3 pitch=-2.5 heading=271.4');
  });

  it('a repeated observation of the SAME sample cannot produce a second record', () => {
    const {tracker, lines} = makeTracker();
    const identity = {sessionToken: SESSION, sampleSeq: 2};

    tracker.noteHeroSample(identity, 0, 'LIVE', POSE);
    tracker.noteHeroSample(identity, 0, 'LIVE', POSE); // a re-render, not a new sample
    tracker.noteRendererSample(identity);
    tracker.noteRendererSample(identity);
    tracker.noteSceneBuilt(identity);
    tracker.noteSceneBuilt(identity);

    expect(lines).toHaveLength(1);
  });

  it('records are session-scoped: the same seq in a replacement session is a DIFFERENT sample', () => {
    const {tracker, lines} = makeTracker();
    const first = {sessionToken: 'usb-1:1', sampleSeq: 1};
    const replacement = {sessionToken: 'usb-1:2', sampleSeq: 1};

    tracker.noteHeroSample(first, 0, 'LIVE', POSE);
    tracker.noteHeroSample(replacement, 0, 'LIVE', {rollDeg: 0, pitchDeg: 0, yawDeg: 0});
    tracker.noteSceneBuilt(first);
    tracker.noteSceneBuilt(replacement);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('usb-1:1 seq=1');
    expect(lines[1]).toContain('usb-1:2 seq=1');
  });

  it('storage is BOUNDED - a flood of samples that are never drawn cannot grow without limit', () => {
    const {tracker, lines} = makeTracker();

    // Every sample superseded before its scene was built: the normal
    // latest-wins outcome under a fast aircraft and a busy thread.
    for (let seq = 1; seq <= ORIENTATION_LATENCY_PENDING_LIMIT * 20; seq++) {
      tracker.noteHeroSample({sessionToken: SESSION, sampleSeq: seq}, seq, 'LIVE', POSE);
    }

    expect(tracker.pendingCount()).toBe(ORIENTATION_LATENCY_PENDING_LIMIT);
    // Superseded samples are dropped silently, not logged - the log stays
    // one line per DRAWN sample.
    expect(lines).toHaveLength(0);
  });

  it('a completed record frees its entry immediately', () => {
    const {tracker} = makeTracker();
    const identity = {sessionToken: SESSION, sampleSeq: 5};

    tracker.noteHeroSample(identity, 0, 'LIVE', POSE);
    expect(tracker.pendingCount()).toBe(1);

    tracker.noteSceneBuilt(identity);
    expect(tracker.pendingCount()).toBe(0);
  });

  it('a scene built for a sample that was evicted or never observed is silently ignored', () => {
    const {tracker, lines} = makeTracker();

    tracker.noteSceneBuilt({sessionToken: SESSION, sampleSeq: 999});
    tracker.noteRendererSample({sessionToken: SESSION, sampleSeq: 999});

    expect(lines).toHaveLength(0);
    expect(tracker.pendingCount()).toBe(0);
  });

  it('schedules NO work of its own - no frame, no interval, no timer', () => {
    const raf = jest.spyOn(globalThis, 'requestAnimationFrame');
    const interval = jest.spyOn(globalThis, 'setInterval');
    const timeout = jest.spyOn(globalThis, 'setTimeout');
    try {
      const {tracker} = makeTracker();
      for (let seq = 1; seq <= 30; seq++) {
        const identity = {sessionToken: SESSION, sampleSeq: seq};
        tracker.noteHeroSample(identity, seq, 'LIVE', POSE);
        tracker.noteRendererSample(identity);
        tracker.noteSceneBuilt(identity);
      }
      expect(raf).not.toHaveBeenCalled();
      expect(interval).not.toHaveBeenCalled();
      expect(timeout).not.toHaveBeenCalled();
    } finally {
      raf.mockRestore();
      interval.mockRestore();
      timeout.mockRestore();
    }
  });

  it('the PRODUCTION singleton emits nothing here - it is development-only and silenced under Jest', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const identity = {sessionToken: SESSION, sampleSeq: 1};
      orientationLatencyTracker.noteHeroSample(identity, 0, 'LIVE', POSE);
      orientationLatencyTracker.noteRendererSample(identity);
      orientationLatencyTracker.noteSceneBuilt(identity);

      expect(log).not.toHaveBeenCalled();
      // Not merely silent: it retains nothing either.
      expect(orientationLatencyTracker.pendingCount()).toBe(0);
    } finally {
      log.mockRestore();
    }
  });
});
