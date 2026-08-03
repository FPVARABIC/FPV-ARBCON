/**
 * A display-only, read-only analysis of a short MSP_ATTITUDE capture.
 *
 * This module deliberately does not call a "stable" result a healthy
 * accelerometer or a successful calibration.  It only describes what the
 * samples did during the capture window.  That distinction matters because
 * a perfectly quiet but consistently tilted controller is stable and still
 * not level.
 */

export const ORIENTATION_STABILITY_WINDOW_MS = 8_000;
// The real serialized link can legitimately settle near 250-320ms while
// slower auxiliary polls share it. Requiring 40 samples in eight seconds
// made an otherwise complete capture fail on those supported links. Three
// genuine samples per second is sufficient for this descriptive (not
// safety-certifying) span/mean check and remains well above the five-sample
// endpoint windows used below.
export const ORIENTATION_STABILITY_MIN_SAMPLES = 24;

/** Product-facing display thresholds, not flight-safety limits. */
export const ORIENTATION_STABILITY_LIMITS = Object.freeze({
  /** Maximum peak-to-peak movement on either axis for a quiet capture. */
  quietSpanDeg: 1,
  /** Maximum first-to-last-window change before it is described as drift. */
  driftDeg: 0.6,
  /** Maximum absolute mean on either axis for a level-looking capture. */
  levelOffsetDeg: 1,
});

export interface OrientationStabilitySample {
  readonly atMs: number;
  readonly rollDeg: number;
  readonly pitchDeg: number;
}

export type OrientationStabilityResult =
  | {
      readonly kind: 'INSUFFICIENT';
      readonly sampleCount: number;
      readonly durationMs: number;
    }
  | {
      readonly kind:
        | 'STABLE_LEVEL'
        | 'STABLE_OFFSET'
        | 'DRIFTING'
        | 'MOVING_OR_NOISY';
      readonly sampleCount: number;
      readonly durationMs: number;
      readonly meanRollDeg: number;
      readonly meanPitchDeg: number;
      readonly rollSpanDeg: number;
      readonly pitchSpanDeg: number;
      readonly rollDriftDeg: number;
      readonly pitchDriftDeg: number;
    };

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function span(values: readonly number[]): number {
  return Math.max(...values) - Math.min(...values);
}

function finiteSample(sample: OrientationStabilitySample): boolean {
  return (
    Number.isFinite(sample.atMs) &&
    Number.isFinite(sample.rollDeg) &&
    Number.isFinite(sample.pitchDeg)
  );
}

/**
 * Analyses genuine samples in timestamp order. Invalid samples are ignored;
 * duplicate timestamps are allowed because sample identity is enforced by
 * the UI boundary before this function is called.
 */
export function analyzeOrientationStability(
  input: readonly OrientationStabilitySample[],
): OrientationStabilityResult {
  const samples = input
    .filter(finiteSample)
    .slice()
    .sort((a, b) => a.atMs - b.atMs);
  const sampleCount = samples.length;
  const durationMs =
    sampleCount < 2 ? 0 : samples[sampleCount - 1].atMs - samples[0].atMs;

  if (
    sampleCount < ORIENTATION_STABILITY_MIN_SAMPLES ||
    durationMs < ORIENTATION_STABILITY_WINDOW_MS
  ) {
    return { kind: 'INSUFFICIENT', sampleCount, durationMs };
  }

  const roll = samples.map(sample => sample.rollDeg);
  const pitch = samples.map(sample => sample.pitchDeg);
  const windowSize = Math.max(5, Math.floor(sampleCount / 5));
  const first = samples.slice(0, windowSize);
  const last = samples.slice(-windowSize);
  const meanRollDeg = mean(roll);
  const meanPitchDeg = mean(pitch);
  const rollSpanDeg = span(roll);
  const pitchSpanDeg = span(pitch);
  const rollDriftDeg =
    mean(last.map(sample => sample.rollDeg)) -
    mean(first.map(sample => sample.rollDeg));
  const pitchDriftDeg =
    mean(last.map(sample => sample.pitchDeg)) -
    mean(first.map(sample => sample.pitchDeg));

  const shared = {
    sampleCount,
    durationMs,
    meanRollDeg,
    meanPitchDeg,
    rollSpanDeg,
    pitchSpanDeg,
    rollDriftDeg,
    pitchDriftDeg,
  } as const;

  if (
    Math.abs(rollDriftDeg) > ORIENTATION_STABILITY_LIMITS.driftDeg ||
    Math.abs(pitchDriftDeg) > ORIENTATION_STABILITY_LIMITS.driftDeg
  ) {
    return { kind: 'DRIFTING', ...shared };
  }
  if (
    rollSpanDeg > ORIENTATION_STABILITY_LIMITS.quietSpanDeg ||
    pitchSpanDeg > ORIENTATION_STABILITY_LIMITS.quietSpanDeg
  ) {
    return { kind: 'MOVING_OR_NOISY', ...shared };
  }
  if (
    Math.abs(meanRollDeg) > ORIENTATION_STABILITY_LIMITS.levelOffsetDeg ||
    Math.abs(meanPitchDeg) > ORIENTATION_STABILITY_LIMITS.levelOffsetDeg
  ) {
    return { kind: 'STABLE_OFFSET', ...shared };
  }
  return { kind: 'STABLE_LEVEL', ...shared };
}
