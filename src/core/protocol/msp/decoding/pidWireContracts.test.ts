import {
  MSP_PID_ADVANCED_BYTES,
  MSP_PID_BYTES,
  MSP_RC_TUNING_BYTES,
  MSP_SIMPLIFIED_TUNING_BYTES,
  MSP_FILTER_CONFIG_BYTES_API147,
  MSP_FILTER_CONFIG_BYTES_API148,
  FILTER_CONFIG_RPM_TAIL_BYTES,
  NEWEST_SOURCE_VERIFIED_CONTRACT,
  PID_SOURCE_COMPARISONS,
  PID_SOURCE_PINS,
  NEWEST_SOURCE_VERIFIED_MINOR,
  OLDEST_SUPPORTED_MINOR,
  absControlLifetime,
  filterConfigBytesFor,
  integratedYawLifetime,
  pidWriteAuthority,
  resolvePidApi,
  sourceVerifiedContract,
  type PidApiContract,
} from './pidWireContracts';
import {decodePidTerms, PID_ITEM_COUNT} from './decodePidTuning';
import {MSP_PID_FIXTURE} from '../../__testUtils__/pidWireFixtures';

const ALL: readonly PidApiContract[] = ['API_1_47', 'API_1_48', 'API_1_49'];

describe('P-C - which contract a board speaks, and whether we may write', () => {
  it('resolves the three pinned versions as source-verified', () => {
    expect(resolvePidApi({major: 1, minor: 47})).toEqual({kind: 'SOURCE_VERIFIED', contract: 'API_1_47'});
    expect(resolvePidApi({major: 1, minor: 48})).toEqual({kind: 'SOURCE_VERIFIED', contract: 'API_1_48'});
    expect(resolvePidApi({major: 1, minor: 49})).toEqual({kind: 'SOURCE_VERIFIED', contract: 'API_1_49'});
  });

  it('refuses anything below the floor and anything that is not this API', () => {
    expect(resolvePidApi({major: 1, minor: 46})).toEqual({kind: 'BELOW_SUPPORTED_FLOOR', minor: 46});
    expect(resolvePidApi({major: 2, minor: 0})).toEqual({kind: 'NOT_A_BETAFLIGHT_API'});
    expect(resolvePidApi({major: Number.NaN, minor: 47})).toEqual({kind: 'NOT_A_BETAFLIGHT_API'});
    expect(resolvePidApi({major: 1, minor: 47.5})).toEqual({kind: 'NOT_A_BETAFLIGHT_API'});
  });

  it('NEVER normalises a future API to 1.49', () => {
    // P-B originally folded 1.50+ into the 1.49 contract. As a write
    // authority that is unsafe: the field meanings inside a 61-byte
    // structure and the length of FILTER_CONFIG would both be guesses.
    const future = resolvePidApi({major: 1, minor: 50});
    expect(future).toEqual({kind: 'UNVERIFIED_FUTURE_API', minor: 50, newestVerified: 'API_1_49'});
    expect(resolvePidApi({major: 1, minor: 55}).kind).toBe('UNVERIFIED_FUTURE_API');
    expect(sourceVerifiedContract(future)).toBeUndefined();
  });

  it('allows writes only on a source-verified layout', () => {
    expect(pidWriteAuthority(resolvePidApi({major: 1, minor: 47})))
      .toEqual({kind: 'ALLOWED', contract: 'API_1_47'});
    expect(pidWriteAuthority(resolvePidApi({major: 1, minor: 49})))
      .toEqual({kind: 'ALLOWED', contract: 'API_1_49'});
    expect(pidWriteAuthority(resolvePidApi({major: 1, minor: 50})))
      .toEqual({kind: 'REFUSED', reason: 'UNVERIFIED_FUTURE_API'});
    expect(pidWriteAuthority(resolvePidApi({major: 1, minor: 46})))
      .toEqual({kind: 'REFUSED', reason: 'BELOW_SUPPORTED_FLOOR'});
    expect(pidWriteAuthority(resolvePidApi({major: 2, minor: 0})))
      .toEqual({kind: 'REFUSED', reason: 'NOT_A_BETAFLIGHT_API'});
  });

  it('names the newest layout it has actually read', () => {
    expect(NEWEST_SOURCE_VERIFIED_CONTRACT).toBe('API_1_49');
    expect(NEWEST_SOURCE_VERIFIED_MINOR).toBe(49);
    expect(OLDEST_SUPPORTED_MINOR).toBe(47);
  });
});

describe('P-B - version matrix across the three pinned trees', () => {
  it('MSP_PID is 15 bytes at every version', () => {
    expect(MSP_PID_BYTES).toBe(15);
    expect(MSP_PID_FIXTURE).toHaveLength(15);
  });

  it('MSP_RC_TUNING is 24 bytes at every version', () => {
    expect(MSP_RC_TUNING_BYTES).toBe(24);
  });

  it('MSP_SIMPLIFIED_TUNING is 53 bytes at every version', () => {
    expect(MSP_SIMPLIFIED_TUNING_BYTES).toBe(53);
  });

  it('MSP_PID_ADVANCED keeps its length while three fields retire', () => {
    expect(MSP_PID_ADVANCED_BYTES).toBe(61);
    // The length is constant; only the meaning of three bytes moves.
    expect(absControlLifetime('API_1_47')).toBe('LIVE');
    expect(absControlLifetime('API_1_48')).toBe('RETIRED');
    expect(absControlLifetime('API_1_49')).toBe('RETIRED');
    expect(integratedYawLifetime('API_1_47')).toBe('LIVE');
    expect(integratedYawLifetime('API_1_48')).toBe('LIVE');
    expect(integratedYawLifetime('API_1_49')).toBe('RETIRED');
  });

  it('MSP_FILTER_CONFIG grows by exactly the RPM tail at 1.48', () => {
    expect(MSP_FILTER_CONFIG_BYTES_API147).toBe(49);
    expect(MSP_FILTER_CONFIG_BYTES_API148).toBe(56);
    expect(FILTER_CONFIG_RPM_TAIL_BYTES).toBe(7);
    expect(MSP_FILTER_CONFIG_BYTES_API147 + FILTER_CONFIG_RPM_TAIL_BYTES)
      .toBe(MSP_FILTER_CONFIG_BYTES_API148);
    expect(filterConfigBytesFor('API_1_47')).toBe(49);
    expect(filterConfigBytesFor('API_1_48')).toBe(56);
    expect(filterConfigBytesFor('API_1_49')).toBe(56);
  });

  it('no contract is decided by a product version string', () => {
    // resolvePidApi takes numbers, not names. This test exists so a future
    // "if (version.startsWith('4.6'))" cannot be added quietly.
    for (const contract of ALL) {
      expect(['API_1_47', 'API_1_48', 'API_1_49']).toContain(contract);
    }
  });
});

describe('P-B - MSP_PID carries five items and all of them survive', () => {
  it('decodes every one of the five, LEVEL and MAG included', () => {
    expect(PID_ITEM_COUNT).toBe(5);
    const terms = decodePidTerms(MSP_PID_FIXTURE);
    expect(terms).toHaveLength(5);
    // Hand-written expectations, read straight off the fixture comments.
    expect(terms[0]).toEqual({p: 41, i: 83, d: 29});
    expect(terms[1]).toEqual({p: 43, i: 89, d: 31});
    expect(terms[2]).toEqual({p: 47, i: 97, d: 0});
    expect(terms[3]).toEqual({p: 53, i: 101, d: 37});
    expect(terms[4]).toEqual({p: 59, i: 103, d: 41});
  });

  it('a payload short of 15 bytes cannot silently yield a shorter tune', () => {
    // The firmware's own setter has no length guard, so a shortened payload
    // would be read as whatever follows it in the board's buffer. Our encoder
    // must therefore always produce the full 15, and this asserts the shape
    // the decoder expects to round-trip.
    expect(MSP_PID_FIXTURE.length).toBe(MSP_PID_BYTES);
    const short = MSP_PID_FIXTURE.slice(0, 12);
    const terms = decodePidTerms(short);
    // Lenient by design (matching Betaflight), but the tail is then zeros -
    // which is exactly why a write must never be built from a short read.
    expect(terms[4]).toEqual({p: 0, i: 0, d: 0});
  });

  /* ------------------------------------------------------------------ */
  /* P-E2 §1/§2 - THE SOURCE IDENTITY, MADE CHECKABLE                    */
  /* ------------------------------------------------------------------ */

  describe('the pinned firmware identity', () => {
    it('names the exact commit each contract was read from', () => {
      expect(PID_SOURCE_PINS).toEqual({
        configurator: '14a057ffc58417c5128199fc1233284982a64be3',
        firmwareApi147: '7348054f268f0058574719c134e9f149565bb8ea',
        firmwareApi148: '6dbc4218fd6bc33bf16ea32c670304d4f89321d5',
        firmwareApi149: 'e72a8e93695270d54897a8f128cffdf8f74a0245',
      });
    });

    it('keeps the additional 1.49 comparison OUT of the pins', () => {
      /* Two commits both announce API_VERSION_MINOR 49. Only one of them is
         the tree this subsystem's bounds and offsets were read from, and
         the other is a comparison point. Letting the second quietly become
         "our 1.49" is the drift §2 forbids - so it lives in its own table
         and is asserted never to appear among the pins. */
      expect(PID_SOURCE_COMPARISONS.api149AdditionalComparison)
        .toBe('d26516289e7e39aee53626beb91d51725ee0677f');
      expect(Object.values(PID_SOURCE_PINS))
        .not.toContain(PID_SOURCE_COMPARISONS.api149AdditionalComparison);
    });

    it('states four distinct full-length commit ids', () => {
      const pins = Object.values(PID_SOURCE_PINS);
      expect(new Set(pins).size).toBe(pins.length);
      for (const pin of [...pins, ...Object.values(PID_SOURCE_COMPARISONS)]) {
        expect(pin).toMatch(/^[0-9a-f]{40}$/);
      }
    });
  });
});
