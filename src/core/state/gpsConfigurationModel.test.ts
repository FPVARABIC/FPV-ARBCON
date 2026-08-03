import {
  GPS_FEATURE_BIT,
  createGpsConfigurationDraft,
  deriveGpsFeatureMask,
  validateGpsDraft,
  type GpsConfigurationSnapshot,
} from './gpsConfigurationModel';

const snapshot: GpsConfigurationSnapshot = {
  featureMaskRaw: 2 ** 31,
  configuration: {
    provider: 1,
    sbasMode: 0,
    autoConfig: true,
    autoBaud: false,
    homePointOnce: false,
    useGalileo: true,
  },
  ports: [],
  apiVersionMajor: 1,
  apiVersionMinor: 47,
};

describe('gpsConfigurationModel', () => {
  it('changes GPS bit 7 while preserving every unrelated u32 bit', () => {
    const enabled = deriveGpsFeatureMask(snapshot.featureMaskRaw, true);
    expect(enabled).toBe(2 ** 31 + GPS_FEATURE_BIT);
    expect(deriveGpsFeatureMask(enabled, false)).toBe(snapshot.featureMaskRaw);
  });

  it('creates wire-truth drafts and validates provider/SBAS ranges', () => {
    expect(createGpsConfigurationDraft(snapshot)).toMatchObject({
      enabled: false,
      provider: 1,
      useGalileo: true,
    });
    expect(
      validateGpsDraft({
        ...createGpsConfigurationDraft(snapshot),
        provider: 99,
        sbasMode: 99,
      }),
    ).toEqual(['INVALID_PROVIDER', 'INVALID_SBAS']);
  });
});
