import {
  FILTER_CONFIG_OFFSETS,
  decodeFilterConfigFull,
  filterFieldScope,
  patchGyroLpf1StaticHz,
} from './decodeFilterConfigFull';
import {MspPayloadReadError} from './MspPayloadReader';
import {
  FILTER_CONFIG_API147_FIXTURE,
  FILTER_CONFIG_API148_FIXTURE,
} from '../../__testUtils__/pidWireFixtures';

describe('P-B - MSP_FILTER_CONFIG at API 1.47 (49 bytes)', () => {
  const decoded = decodeFilterConfigFull(FILTER_CONFIG_API147_FIXTURE, 'API_1_47');

  it('reads every gyro-side field', () => {
    expect(decoded.gyroLpf1StaticHz).toBe(300);
    expect(decoded.gyroLpf2StaticHz).toBe(412);
    expect(decoded.gyroLpf1Type).toBe(1);
    expect(decoded.gyroLpf2Type).toBe(2);
    expect(decoded.gyroLpf1DynMinHz).toBe(213);
    expect(decoded.gyroLpf1DynMaxHz).toBe(517);
    expect(decoded.gyroHardwareLpf).toBe(1);
    expect(decoded.gyroSoftNotchHz1).toBe(233);
    expect(decoded.gyroSoftNotchCutoff1).toBe(147);
    expect(decoded.gyroSoftNotchHz2).toBe(334);
    expect(decoded.gyroSoftNotchCutoff2).toBe(224);
  });

  it('reads every D-term-side field', () => {
    expect(decoded.dtermLpf1StaticHz).toBe(111);
    expect(decoded.dtermLpf2StaticHz).toBe(176);
    expect(decoded.dtermLpf1Type).toBe(2);
    expect(decoded.dtermLpf2Type).toBe(1);
    expect(decoded.dtermLpf1DynMinHz).toBe(79);
    expect(decoded.dtermLpf1DynMaxHz).toBe(163);
    expect(decoded.dtermLpf1DynExpo).toBe(5);
    expect(decoded.dtermNotchHz).toBe(260);
    expect(decoded.dtermNotchCutoff).toBe(160);
    expect(decoded.yawLowpassHz).toBe(123);
  });

  it('reads the dynamic notch and the 1.47 RPM fields', () => {
    expect(decoded.dynNotchQ).toBe(307);
    expect(decoded.dynNotchMinHz).toBe(91);
    expect(decoded.dynNotchMaxHz).toBe(593);
    expect(decoded.dynNotchCount).toBe(4);
    expect(decoded.rpmFilterHarmonics).toBe(3);
    expect(decoded.rpmFilterMinHz).toBe(87);
  });

  it('reports the 1.48 RPM tail as absent rather than as zeros', () => {
    // Those fields exist in the 1.47 firmware struct but are CLI-only there.
    // Reporting 0 would be claiming the board told us something it did not.
    expect(decoded.rpmTail).toBeUndefined();
  });

  it('refuses a payload shorter than the contract', () => {
    expect(() => decodeFilterConfigFull(FILTER_CONFIG_API147_FIXTURE.slice(0, 48), 'API_1_47'))
      .toThrow(MspPayloadReadError);
  });
});

describe('P-B - the duplicated gyro LPF1 field', () => {
  it('takes its value from the u16 at offset 20, never the u8 at offset 0', () => {
    const decoded = decodeFilterConfigFull(FILTER_CONFIG_API147_FIXTURE, 'API_1_47');
    // The fixture stores 300 Hz. The legacy byte can only hold 300 - 256.
    expect(decoded.gyroLpf1StaticHz).toBe(300);
    expect(decoded.gyroLpf1StaticHzLegacyU8).toBe(44);
    expect(decoded.gyroLpf1StaticHzLegacyTruncated).toBe(true);
    // If a decoder ever read offset 0 it would report 44 Hz - a filter six
    // times tighter than the one the board is actually running.
    expect(decoded.gyroLpf1StaticHz).not.toBe(decoded.gyroLpf1StaticHzLegacyU8);
  });

  it('does not cry truncation when the value genuinely fits in a byte', () => {
    const payload = FILTER_CONFIG_API147_FIXTURE.slice();
    patchGyroLpf1StaticHz(payload, 120);
    const decoded = decodeFilterConfigFull(payload, 'API_1_47');
    expect(decoded.gyroLpf1StaticHz).toBe(120);
    expect(decoded.gyroLpf1StaticHzLegacyU8).toBe(120);
    expect(decoded.gyroLpf1StaticHzLegacyTruncated).toBe(false);
  });

  it('writes both copies so they can never disagree', () => {
    const payload = FILTER_CONFIG_API147_FIXTURE.slice();
    patchGyroLpf1StaticHz(payload, 300);
    // Hand-written expectation: 300 = 0x012C.
    expect(payload[FILTER_CONFIG_OFFSETS.gyroLpf1StaticHzLegacyU8]).toBe(0x2c);
    expect(payload[FILTER_CONFIG_OFFSETS.gyroLpf1StaticHz]).toBe(0x2c);
    expect(payload[FILTER_CONFIG_OFFSETS.gyroLpf1StaticHz + 1]).toBe(0x01);
  });

  it('touches nothing else in the payload', () => {
    const payload = FILTER_CONFIG_API147_FIXTURE.slice();
    patchGyroLpf1StaticHz(payload, 300);
    for (let index = 0; index < payload.length; index += 1) {
      const isPatched = index === FILTER_CONFIG_OFFSETS.gyroLpf1StaticHzLegacyU8
        || index === FILTER_CONFIG_OFFSETS.gyroLpf1StaticHz
        || index === FILTER_CONFIG_OFFSETS.gyroLpf1StaticHz + 1;
      if (!isPatched) expect(payload[index]).toBe(FILTER_CONFIG_API147_FIXTURE[index]);
    }
  });
});

describe('P-B - MSP_FILTER_CONFIG at API 1.48 and 1.49 (56 bytes)', () => {
  it('reads the RPM tail at its exact offsets', () => {
    const decoded = decodeFilterConfigFull(FILTER_CONFIG_API148_FIXTURE, 'API_1_48');
    expect(decoded.rpmTail).toEqual({fadeRangeHz: 55, q: 507, weights: [100, 80, 60]});
  });

  it('reads 1.49 with the same layout as 1.48', () => {
    const at148 = decodeFilterConfigFull(FILTER_CONFIG_API148_FIXTURE, 'API_1_48');
    const at149 = decodeFilterConfigFull(FILTER_CONFIG_API148_FIXTURE, 'API_1_49');
    expect(at149.rpmTail).toEqual(at148.rpmTail);
    expect(at149.gyroLpf1StaticHz).toBe(at148.gyroLpf1StaticHz);
  });

  it('does not read a 1.48 tail out of a 1.47 payload', () => {
    // The 49-byte payload has nothing at offset 49. Demanding the longer
    // contract must fail loudly rather than read past the end.
    expect(() => decodeFilterConfigFull(FILTER_CONFIG_API147_FIXTURE, 'API_1_48'))
      .toThrow(MspPayloadReadError);
  });

  it('does not discard a 1.48 tail when it is present', () => {
    const decoded = decodeFilterConfigFull(FILTER_CONFIG_API148_FIXTURE, 'API_1_48');
    expect(decoded.rpmTail).toBeDefined();
    expect(decoded.trailingBytes).toHaveLength(0);
  });

  it('preserves bytes past the newest contract it knows', () => {
    const longer = Uint8Array.from([...FILTER_CONFIG_API148_FIXTURE, 0x7a, 0x7b]);
    const decoded = decodeFilterConfigFull(longer, 'API_1_49');
    expect(Array.from(decoded.trailingBytes)).toEqual([0x7a, 0x7b]);
    expect(Array.from(decoded.raw)).toEqual(Array.from(longer));
  });
});

describe('P-B - one payload, three configuration scopes', () => {
  it('keeps D-term filters in the PID profile', () => {
    for (const field of [
      'dtermLpf1StaticHz', 'dtermLpf2StaticHz', 'dtermLpf1Type', 'dtermLpf2Type',
      'dtermLpf1DynMinHz', 'dtermLpf1DynMaxHz', 'dtermLpf1DynExpo',
      'dtermNotchHz', 'dtermNotchCutoff', 'yawLowpassHz',
    ] as const) {
      expect(filterFieldScope(field)).toBe('PID_PROFILE');
    }
  });

  it('keeps gyro, dynamic-notch and RPM fields global', () => {
    for (const field of [
      'gyroLpf1StaticHz', 'gyroLpf2StaticHz', 'gyroLpf1Type', 'gyroLpf2Type',
      'gyroLpf1DynMinHz', 'gyroLpf1DynMaxHz', 'gyroHardwareLpf',
      'gyroSoftNotchHz1', 'gyroSoftNotchCutoff1', 'gyroSoftNotchHz2', 'gyroSoftNotchCutoff2',
      'dynNotchQ', 'dynNotchMinHz', 'dynNotchMaxHz', 'dynNotchCount',
      'rpmFilterHarmonics', 'rpmFilterMinHz', 'rpmFilterFadeRangeHz', 'rpmFilterQ', 'rpmFilterWeights',
    ] as const) {
      expect(filterFieldScope(field)).toBe('GLOBAL');
    }
  });

  it('does not bind the whole payload to the PID profile', () => {
    // The mistake this guards against: treating MSP_FILTER_CONFIG as
    // profile-scoped because the screen happens to be showing a PID profile.
    // Half of it belongs to no profile at all.
    expect(filterFieldScope('gyroLpf1StaticHz')).not.toBe(filterFieldScope('dtermLpf1StaticHz'));
  });
});
