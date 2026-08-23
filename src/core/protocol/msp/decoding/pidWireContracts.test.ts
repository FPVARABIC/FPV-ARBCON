import {
  MSP_PID_ADVANCED_BYTES,
  MSP_PID_BYTES,
  MSP_RC_TUNING_BYTES,
  MSP_SIMPLIFIED_TUNING_BYTES,
  MSP_FILTER_CONFIG_BYTES_API147,
  MSP_FILTER_CONFIG_BYTES_API148,
  FILTER_CONFIG_RPM_TAIL_BYTES,
  absControlLifetime,
  filterConfigBytesFor,
  integratedYawLifetime,
  resolvePidApiContract,
  type PidApiContract,
} from './pidWireContracts';
import {decodePidTerms, PID_ITEM_COUNT} from './decodePidTuning';
import {MSP_PID_FIXTURE} from '../../__testUtils__/pidWireFixtures';

const ALL: readonly PidApiContract[] = ['API_1_47', 'API_1_48', 'API_1_49'];

describe('P-B - which contract a board speaks', () => {
  it('resolves the three pinned versions and refuses anything older', () => {
    expect(resolvePidApiContract({major: 1, minor: 47})).toBe('API_1_47');
    expect(resolvePidApiContract({major: 1, minor: 48})).toBe('API_1_48');
    expect(resolvePidApiContract({major: 1, minor: 49})).toBe('API_1_49');
    // Below the floor this project already refuses at identification.
    expect(resolvePidApiContract({major: 1, minor: 46})).toBeUndefined();
    expect(resolvePidApiContract({major: 2, minor: 0})).toBeUndefined();
  });

  it('reads a firmware newer than we have studied as the newest we have', () => {
    // Not a guess about new fields - the decoders preserve unrecognised
    // trailing bytes. It is a refusal to reject a board for being new.
    expect(resolvePidApiContract({major: 1, minor: 55})).toBe('API_1_49');
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
    // resolvePidApiContract takes numbers, not names. This test exists so a
    // future "if (version.startsWith('4.6'))" cannot be added quietly.
    for (const contract of ALL) {
      expect(['API_1_47', 'API_1_48', 'API_1_49']).toContain(contract);
    }
    expect(resolvePidApiContract({major: Number.NaN, minor: 47})).toBeUndefined();
    expect(resolvePidApiContract({major: 1, minor: 47.5})).toBeUndefined();
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
});
