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
  buildAllStopVectorForDomain,
  buildMotorVector,
  buildSingleOutputVectorForDomain,
  MotorVectorValueError,
  MOTOR_EXTERNAL_MAX_VALUE,
  MOTOR_EXTERNAL_PROTOCOL_FLOOR_VALUE,
  MOTOR_EXTERNAL_STOP_VALUE,
  type MotorVectorScope,
} from './betaflightMotorVectorsV147';
import {resolveMotorTestValueDomain} from './betaflightMotorDomainV147';
import {MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2} from '../protocol/msp/decoding/decodeAdvancedConfig';

/** Two resolved domains the migrated assertions run against. Written out
 * here rather than inside one suite so a hexacopter is available to the
 * "never remaps outputs" proof, which the removed quad helper could not
 * reach past index three. */
const QUAD_DIGITAL = resolveMotorTestValueDomain({
  motorCount: 4,
  motorProtocolRaw: MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2,
  feature3dEnabled: false,
  minCommand: 1000,
  maxThrottle: 2000,
});
const HEX_DIGITAL = resolveMotorTestValueDomain({
  motorCount: 6,
  motorProtocolRaw: MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2,
  feature3dEnabled: false,
  minCommand: 1000,
  maxThrottle: 2000,
});

const inScope = (overrides: Partial<MotorVectorScope> = {}): MotorVectorScope => ({
  motorCount: 4,
  motorProtocolRaw: MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2,
  feature3dEnabled: false,
  ...overrides,
});

describe('betaflightMotorVectorsV147 - constants', () => {
  it('pins stop, protocol floor and maximum to verified values', () => {
    expect(MOTOR_EXTERNAL_STOP_VALUE).toBe(1000);
    expect(MOTOR_EXTERNAL_PROTOCOL_FLOOR_VALUE).toBe(1001);
    expect(MOTOR_EXTERNAL_MAX_VALUE).toBe(2000);
  });

  it('reuses the decoded protocol representation rather than a divergent enum', () => {
    // Comparing against the RAW MSP_ADVANCED_CONFIG byte, never a
    // display-adjusted (+1) value.
    expect(MOTOR_PROTOCOL_RAW_DSHOT600_AT_2025_12_2).toBe(7);
  });
});

/* M-C: the `assertSupportedMotorScope`, `buildAllStopVector` and
 * `buildSingleMotorVector` suites were REMOVED with the functions they
 * covered. Every property they held that is still true of this module is
 * held below against the DOMAIN-DRIVEN primitives, which is where the
 * behaviour lives now:
 *
 *   - "refuses 3D outright"       -> NOT re-asserted, deliberately. It was
 *                                    over-broad: digital 3D is knowable.
 *                                    What survives is analog 3D's refusal,
 *                                    owned by motorControlRuntimeScope and
 *                                    proven in its own suite and in the
 *                                    controller's production paths.
 *   - "rejects every count but 4" -> NOT re-asserted. Never a firmware fact.
 *   - "one active output, rest at stop" -> `builds a single-output vector
 *                                    against the domain stop value`, below.
 *   - "index N is position N"     -> `never remaps outputs`, below, now run
 *                                    against the domain builder.
 *   - "rejects out-of-domain, fractional, sparse and wrong-length input"
 *                                 -> `rejects a wrong-length, sparse,
 *                                    fractional or out-of-domain vector`.
 */

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
    const vector = buildSingleOutputVectorForDomain(QUAD_DIGITAL, 0, 1500);
    // A vector is positional indexes only - no CW/CCW, no corner names.
    expect(Array.isArray(vector)).toBe(true);
    expect(vector.every(value => typeof value === 'number')).toBe(true);
  });

  it('never remaps outputs - index N is always position N in the vector', () => {
    // Run across a HEXACOPTER as well, so the property is proven past the
    // four indexes the removed quad helper could reach.
    for (const domain of [QUAD_DIGITAL, HEX_DIGITAL]) {
      for (let motorIndex = 0; motorIndex < domain.motorCount; motorIndex++) {
        const vector = buildSingleOutputVectorForDomain(domain, motorIndex, 1234);
        expect(vector.indexOf(1234)).toBe(motorIndex);
      }
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

/* M-C: the "legacy compatibility wrappers are unchanged" block was
 * REMOVED with the wrappers. Its three assertions are superseded rather
 * than dropped - see the note above the "what it deliberately does NOT
 * do" suite for where each property now lives, and why the two that are
 * NOT re-asserted were wrong rather than merely narrower.
 */
