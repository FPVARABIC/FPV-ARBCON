import {
  ORIENTATION_STABILITY_MIN_SAMPLES,
  ORIENTATION_STABILITY_WINDOW_MS,
  analyzeOrientationStability,
} from './orientationStability';

function capture(
  value: (index: number) => { rollDeg: number; pitchDeg: number },
) {
  return Array.from(
    { length: ORIENTATION_STABILITY_MIN_SAMPLES + 1 },
    (_, index) => ({
      atMs:
        (index * ORIENTATION_STABILITY_WINDOW_MS) /
        ORIENTATION_STABILITY_MIN_SAMPLES,
      ...value(index),
    }),
  );
}

describe('analyzeOrientationStability', () => {
  it('accepts the complete eight-second capture produced by a supported ~3Hz serialized link', () => {
    expect(ORIENTATION_STABILITY_MIN_SAMPLES).toBe(24);
    const samples = Array.from(
      { length: ORIENTATION_STABILITY_MIN_SAMPLES + 1 },
      (_, index) => ({
        atMs:
          (index * ORIENTATION_STABILITY_WINDOW_MS) /
          ORIENTATION_STABILITY_MIN_SAMPLES,
        rollDeg: 0,
        pitchDeg: 0,
      }),
    );
    expect(analyzeOrientationStability(samples).kind).toBe('STABLE_LEVEL');
  });

  it('requires both a useful sample count and the complete time window', () => {
    expect(analyzeOrientationStability([])).toEqual({
      kind: 'INSUFFICIENT',
      sampleCount: 0,
      durationMs: 0,
    });
    const tooShort = capture(() => ({ rollDeg: 0, pitchDeg: 0 })).map(
      sample => ({
        ...sample,
        atMs: sample.atMs / 2,
      }),
    );
    expect(analyzeOrientationStability(tooShort).kind).toBe('INSUFFICIENT');
  });

  it('describes a quiet, level capture without claiming sensor health', () => {
    const result = analyzeOrientationStability(
      capture(index => ({
        rollDeg: index % 2 === 0 ? 0.1 : -0.1,
        pitchDeg: index % 3 === 0 ? 0.2 : 0,
      })),
    );
    expect(result.kind).toBe('STABLE_LEVEL');
  });

  it('separates a quiet fixed offset from instability', () => {
    const result = analyzeOrientationStability(
      capture(index => ({
        rollDeg: 2.2 + (index % 2 === 0 ? 0.1 : -0.1),
        pitchDeg: -0.4,
      })),
    );
    expect(result.kind).toBe('STABLE_OFFSET');
  });

  it('detects first-to-last drift before generic movement', () => {
    const result = analyzeOrientationStability(
      capture(index => ({ rollDeg: index * 0.04, pitchDeg: 0 })),
    );
    expect(result.kind).toBe('DRIFTING');
    if (result.kind !== 'INSUFFICIENT') {
      expect(result.rollDriftDeg).toBeGreaterThan(0.6);
    }
  });

  it('detects movement/noise when the endpoint does not drift', () => {
    const result = analyzeOrientationStability(
      capture(index => ({
        rollDeg: index % 2 === 0 ? 0.8 : -0.8,
        pitchDeg: 0,
      })),
    );
    expect(result.kind).toBe('MOVING_OR_NOISY');
  });

  it('sorts timestamps and ignores non-finite samples', () => {
    const clean = capture(() => ({ rollDeg: 0, pitchDeg: 0 }));
    const result = analyzeOrientationStability([
      ...clean.slice().reverse(),
      { atMs: Number.NaN, rollDeg: 99, pitchDeg: 99 },
    ]);
    expect(result.kind).toBe('STABLE_LEVEL');
    expect(result.sampleCount).toBe(clean.length);
  });
});
