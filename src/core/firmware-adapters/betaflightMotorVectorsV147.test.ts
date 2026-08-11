/**
 * Pass 1B - tests for the pure Betaflight API-1.47 motor vector logic.
 *
 * NO HARDWARE OF ANY KIND is required, referenced or simulated: no
 * flight controller, no USB, no transport, no MspClient, no ESC, no
 * motor, no LiPo, no timers, no React Native. Every input is a plain
 * object and every function under test is pure.
 *
 * NOTHING HERE DESCRIBES ANY VALUE AS SAFE, IDLE OR RECOMMENDED. The
 * protocol-floor constant is used only to pin the boundary of the
 * encoding.
 */

import {
  assertSupportedMotorScope,
  buildAllStopVector,
  buildAllStopVectorForDomain,
  buildMotorVector,
  buildSingleMotorVector,
  buildSingleOutputVectorForDomain,
  MotorVectorScopeError,
  MotorVectorValueError,
  MOTOR_EXTERNAL_MAX_VALUE,
  MOTOR_EXTERNAL_PROTOCOL_FLOOR_VALUE,
  MOTOR_EXTERNAL_STOP_VALUE,
  MOTOR_VECTOR_MOTOR_COUNT,
  type MotorVectorScope,
} from './betaflightMotorVectorsV147';
import {resolveMotorTestValueDomain} from './betaflightMotorDomainV147';
import {MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2} from '../protocol/msp/decoding/decodeAdvancedConfig';
import {encodeSetMotorPayload} from '../protocol/msp/encoding/encodeSetMotorPayload';

const inScope = (overrides: Partial<MotorVectorScope> = {}): MotorVectorScope => ({
  motorCount: 4,
  motorProtocolRaw: MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2,
  feature3dEnabled: false,
  ...overrides,
});

describe('betaflightMotorVectorsV147 - constants', () => {
  it('pins stop, protocol floor, maximum and motor count to verified values', () => {
    expect(MOTOR_EXTERNAL_STOP_VALUE).toBe(1000);
    expect(MOTOR_EXTERNAL_PROTOCOL_FLOOR_VALUE).toBe(1001);
    expect(MOTOR_EXTERNAL_MAX_VALUE).toBe(2000);
    expect(MOTOR_VECTOR_MOTOR_COUNT).toBe(4);
  });

  it('reuses the decoded protocol representation rather than a divergent enum', () => {
    // Comparing against the RAW MSP_ADVANCED_CONFIG byte, never a
    // display-adjusted (+1) value.
    expect(MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2).toBe(7);
  });
});

describe('assertSupportedMotorScope', () => {
  it('accepts the one approved configuration', () => {
    expect(() => assertSupportedMotorScope(inScope())).not.toThrow();
  });

  it('REJECTS 3D mode', () => {
    expect(() => assertSupportedMotorScope(inScope({feature3dEnabled: true}))).toThrow(
      MotorVectorScopeError,
    );
  });

  it('rejects 3D BEFORE any other scope problem is considered', () => {
    // Everything else is wrong too; the 3D message must still be the one
    // that surfaces, because 3D inverts stop semantics.
    expect(() =>
      assertSupportedMotorScope({motorCount: 8, motorProtocolRaw: 0, feature3dEnabled: true}),
    ).toThrow(/FEATURE_3D/);
  });

  it('rejects every motor count except four', () => {
    for (const motorCount of [0, -1, 1, 2, 3, 5, 6, 8, 3.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => assertSupportedMotorScope(inScope({motorCount}))).toThrow(MotorVectorScopeError);
    }
  });

  it('accepts the reviewed DShot family and rejects PWM-family/disabled values', () => {
    for (const motorProtocolRaw of [5, 6, 7, 8]) {
      expect(() =>
        assertSupportedMotorScope(inScope({motorProtocolRaw})),
      ).not.toThrow();
    }
    // PWM 0, ONESHOT125 1, ONESHOT42 2, MULTISHOT 3, BRUSHED 4,
    // and DISABLED 9 remain outside this adapter.
    for (const motorProtocolRaw of [0, 1, 2, 3, 4, 9, 255]) {
      expect(() => assertSupportedMotorScope(inScope({motorProtocolRaw}))).toThrow(
        MotorVectorScopeError,
      );
    }
  });
});

describe('buildAllStopVector', () => {
  it('produces exactly four stop values', () => {
    expect(buildAllStopVector(inScope())).toEqual([1000, 1000, 1000, 1000]);
  });

  it('returns a fresh frozen array on every call', () => {
    const first = buildAllStopVector(inScope());
    const second = buildAllStopVector(inScope());
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Reflect.set(first, 0, 2000)).toBe(false);
    expect(first[0]).toBe(1000);
  });

  it('refuses to build a stop vector at all when 3D is enabled', () => {
    // The critical case: a non-3D stop vector would be FULL REVERSE on a
    // 3D-configured aircraft, so no vector is produced.
    expect(() => buildAllStopVector(inScope({feature3dEnabled: true}))).toThrow(
      MotorVectorScopeError,
    );
  });
});

describe('buildSingleMotorVector', () => {
  it('places the supplied value at the supplied index and stop elsewhere', () => {
    expect(buildSingleMotorVector(inScope(), 1, MOTOR_EXTERNAL_PROTOCOL_FLOOR_VALUE)).toEqual([
      1000, 1001, 1000, 1000,
    ]);
    expect(buildSingleMotorVector(inScope(), 0, 1500)).toEqual([1500, 1000, 1000, 1000]);
    expect(buildSingleMotorVector(inScope(), 3, 2000)).toEqual([1000, 1000, 1000, 2000]);
  });

  it('rejects every out-of-range motor index', () => {
    for (const motorIndex of [
      -1,
      -0.5,
      4,
      5,
      8,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(() => buildSingleMotorVector(inScope(), motorIndex, 1500)).toThrow(
        MotorVectorValueError,
      );
    }
  });

  it('requires the active value explicitly - no default, no fallback', () => {
    // Three required parameters; a caller cannot omit the magnitude.
    expect(buildSingleMotorVector).toHaveLength(3);
    expect(() =>
      (buildSingleMotorVector as unknown as (s: MotorVectorScope, i: number) => unknown)(
        inScope(),
        1,
      ),
    ).toThrow(MotorVectorValueError);
  });

  it('rejects stop as an active value', () => {
    expect(() => buildSingleMotorVector(inScope(), 1, MOTOR_EXTERNAL_STOP_VALUE)).toThrow(
      MotorVectorValueError,
    );
  });

  it('rejects out-of-range, fractional, NaN and infinite active values', () => {
    for (const value of [
      0,
      999,
      2001,
      65535,
      1000.5,
      1500.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(() => buildSingleMotorVector(inScope(), 1, value)).toThrow(MotorVectorValueError);
    }
  });

  it('refuses to build any vector when 3D is enabled', () => {
    expect(() =>
      buildSingleMotorVector(inScope({feature3dEnabled: true}), 1, 1500),
    ).toThrow(MotorVectorScopeError);
  });

  it('returns a fresh frozen array and mutates no input', () => {
    const scope = inScope();
    const snapshot = {...scope};
    const vector = buildSingleMotorVector(scope, 2, 1200);
    expect(Object.isFrozen(vector)).toBe(true);
    expect(scope).toEqual(snapshot);
    expect(buildSingleMotorVector(scope, 2, 1200)).not.toBe(vector);
  });
});

describe('vector -> payload composition (still pure, still unreachable)', () => {
  it('encodes the all-stop vector to eight bytes', () => {
    const payload = encodeSetMotorPayload(buildAllStopVector(inScope()), MOTOR_VECTOR_MOTOR_COUNT);
    expect(Array.from(payload)).toEqual([0xe8, 0x03, 0xe8, 0x03, 0xe8, 0x03, 0xe8, 0x03]);
  });

  it('encodes the M2 protocol-floor fixture to its verified bytes', () => {
    // PROTOCOL-FLOOR ENCODING FIXTURE ONLY - it pins output ordering and
    // little-endian byte order. It is NOT a recommended, safe or
    // effective hardware pulse, and no claim is made that it would turn
    // any propeller.
    const vector = buildSingleMotorVector(inScope(), 1, MOTOR_EXTERNAL_PROTOCOL_FLOOR_VALUE);
    expect(vector).toEqual([1000, 1001, 1000, 1000]);
    const payload = encodeSetMotorPayload(vector, MOTOR_VECTOR_MOTOR_COUNT);
    expect(Array.from(payload)).toEqual([0xe8, 0x03, 0xe9, 0x03, 0xe8, 0x03, 0xe8, 0x03]);
  });

  it('every producible single-motor vector satisfies the encoder invariant', () => {
    for (let motorIndex = 0; motorIndex < MOTOR_VECTOR_MOTOR_COUNT; motorIndex++) {
      const vector = buildSingleMotorVector(inScope(), motorIndex, 1500);
      expect(vector.filter(value => value !== MOTOR_EXTERNAL_STOP_VALUE)).toHaveLength(1);
      expect(() => encodeSetMotorPayload(vector, MOTOR_VECTOR_MOTOR_COUNT)).not.toThrow();
    }
  });
});

describe('betaflightMotorVectorsV147 - what it deliberately does NOT do', () => {
  it('derives nothing from motorIdle, KV, battery, ESC firmware or motor model', () => {
    // The scope type carries none of those inputs at all, so no
    // magnitude can be computed from them by construction.
    const scopeKeys = Object.keys(inScope()).sort();
    expect(scopeKeys).toEqual(['feature3dEnabled', 'motorCount', 'motorProtocolRaw']);
    for (const key of scopeKeys) {
      expect(key).not.toMatch(/idle|kv|batt|volt|esc|firmware|model|rpm|temp/i);
    }
  });

  it('makes no physical direction or airframe-position claim', () => {
    const vector = buildSingleMotorVector(inScope(), 0, 1500);
    // A vector is positional indexes only - no CW/CCW, no corner names.
    expect(Array.isArray(vector)).toBe(true);
    expect(vector.every(value => typeof value === 'number')).toBe(true);
  });

  it('never remaps outputs - index N is always position N in the vector', () => {
    for (let motorIndex = 0; motorIndex < MOTOR_VECTOR_MOTOR_COUNT; motorIndex++) {
      const vector = buildSingleMotorVector(inScope(), motorIndex, 1234);
      expect(vector.indexOf(1234)).toBe(motorIndex);
    }
  });
});

/* ===================================================================== *
 * P1-C - the GENERAL vector primitives. The legacy single-pulse helpers
 * above are unchanged; these tests cover the new domain-driven forms that
 * no runtime caller uses yet.
 * ===================================================================== */
describe('P1-C general motor vector primitives', () => {
  const digitalDomain = resolveMotorTestValueDomain({
    motorCount: 4,
    motorProtocolRaw: 7,
    feature3dEnabled: false,
    minCommand: 1000,
    maxThrottle: 2000,
  });
  const analogDomain = resolveMotorTestValueDomain({
    motorCount: 6,
    motorProtocolRaw: 3,
    feature3dEnabled: false,
    minCommand: 900,
    maxThrottle: 1900,
  });
  const threeDomain = resolveMotorTestValueDomain({
    motorCount: 4,
    motorProtocolRaw: 7,
    feature3dEnabled: true,
    minCommand: 1000,
    maxThrottle: 2000,
    motor3d: {deadband3dLow: 1406, deadband3dHigh: 1514, neutral3d: 1460},
  });

  it('builds an all-stop vector at each domain own stop value', () => {
    expect(buildAllStopVectorForDomain(digitalDomain)).toEqual([1000, 1000, 1000, 1000]);
    expect(buildAllStopVectorForDomain(analogDomain)).toEqual([900, 900, 900, 900, 900, 900]);
    expect(buildAllStopVectorForDomain(threeDomain)).toEqual([1500, 1500, 1500, 1500]);
  });

  it('builds a full vector with independently different values', () => {
    expect(buildMotorVector(digitalDomain, [1100, 1200, 1300, 1400])).toEqual([
      1100, 1200, 1300, 1400,
    ]);
  });

  it('builds a master-style vector where every element is equal', () => {
    expect(buildMotorVector(analogDomain, [1200, 1200, 1200, 1200, 1200, 1200])).toEqual([
      1200, 1200, 1200, 1200, 1200, 1200,
    ]);
  });

  it('rejects a wrong-length, sparse, fractional or out-of-domain vector', () => {
    expect(() => buildMotorVector(digitalDomain, [1000, 1000, 1000])).toThrow(
      MotorVectorValueError,
    );
    const sparse: number[] = [1000, 1000, 1000, 1000];
    delete sparse[2];
    expect(() => buildMotorVector(digitalDomain, sparse)).toThrow(MotorVectorValueError);
    expect(() => buildMotorVector(digitalDomain, [1000.5, 1000, 1000, 1000])).toThrow(
      MotorVectorValueError,
    );
    expect(() => buildMotorVector(digitalDomain, [900, 1000, 1000, 1000])).toThrow(
      MotorVectorValueError,
    );
    expect(() => buildMotorVector(analogDomain, [900, 900, 900, 900, 900, 1950])).toThrow(
      MotorVectorValueError,
    );
  });

  it('builds a single-output vector against the domain stop value', () => {
    expect(buildSingleOutputVectorForDomain(digitalDomain, 2, 1100)).toEqual([
      1000, 1000, 1100, 1000,
    ]);
    expect(buildSingleOutputVectorForDomain(analogDomain, 0, 1200)).toEqual([
      1200, 900, 900, 900, 900, 900,
    ]);
    expect(buildSingleOutputVectorForDomain(threeDomain, 1, 1600)).toEqual([
      1500, 1600, 1500, 1500,
    ]);
  });

  it('rejects an out-of-range output index', () => {
    for (const index of [-1, 4, 4.5]) {
      expect(() => buildSingleOutputVectorForDomain(digitalDomain, index, 1100)).toThrow(
        MotorVectorValueError,
      );
    }
  });

  it('returns frozen arrays', () => {
    expect(Object.isFrozen(buildMotorVector(digitalDomain, [1000, 1000, 1000, 1000]))).toBe(true);
    expect(Object.isFrozen(buildAllStopVectorForDomain(digitalDomain))).toBe(true);
  });
});

/* The shipping single-pulse path must stay byte-identical after P1. */
describe('P1-C legacy compatibility wrappers are unchanged', () => {
  const scope = {motorCount: 4, motorProtocolRaw: 7, feature3dEnabled: false};

  it('buildAllStopVector still returns the four-element non-3D stop vector', () => {
    expect(buildAllStopVector(scope)).toEqual([1000, 1000, 1000, 1000]);
  });

  it('buildSingleMotorVector still returns one active output and three stops', () => {
    expect(buildSingleMotorVector(scope, 1, 1050)).toEqual([1000, 1050, 1000, 1000]);
  });

  it('assertSupportedMotorScope still refuses 3D, non-DShot and non-four scopes', () => {
    expect(() => assertSupportedMotorScope({...scope, feature3dEnabled: true})).toThrow();
    expect(() => assertSupportedMotorScope({...scope, motorProtocolRaw: 3})).toThrow();
    expect(() => assertSupportedMotorScope({...scope, motorCount: 6})).toThrow();
  });
});
