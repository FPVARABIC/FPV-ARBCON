import {
  GENERAL_FEATURES,
  bitEnabled,
  featureIsAvailable,
  setMaskBit,
} from './generalConfigurationModel';

describe('generalConfigurationModel', () => {
  it('uses unsigned masks for high and low bits', () => {
    const enabled = setMaskBit(0x80000000, 22, true);
    expect(enabled).toBe(0x80400000);
    expect(bitEnabled(enabled, 22)).toBe(true);
    expect(setMaskBit(enabled, 22, false)).toBe(0x80000000);
  });

  it('filters build-dependent controls when build evidence is available', () => {
    const osd = GENERAL_FEATURES.find(item => item.key === 'osd')!;
    expect(featureIsAvailable(osd, new Set())).toBe(true);
    expect(featureIsAvailable(osd, new Set([16416]))).toBe(true);
    expect(featureIsAvailable(osd, new Set([16417]))).toBe(true);
    expect(featureIsAvailable(osd, new Set([16413]))).toBe(false);
  });
});
