import {checkMspCompatibility, MSP_MIN_REQUIRED_API_VERSION_MAJOR, MSP_MIN_REQUIRED_API_VERSION_MINOR} from './mspCompatibility';

function apiVersion(apiVersionMajor: number, apiVersionMinor: number) {
  return {mspProtocolVersion: 0, apiVersionMajor, apiVersionMinor};
}

describe('checkMspCompatibility', () => {
  it('is compatible at exactly the minimum required version', () => {
    expect(
      checkMspCompatibility(apiVersion(MSP_MIN_REQUIRED_API_VERSION_MAJOR, MSP_MIN_REQUIRED_API_VERSION_MINOR)),
    ).toEqual({compatible: true});
  });

  it('is compatible above the minimum minor version', () => {
    expect(checkMspCompatibility(apiVersion(1, 48))).toEqual({compatible: true});
  });

  it('is compatible with a higher major version regardless of minor', () => {
    expect(checkMspCompatibility(apiVersion(2, 0))).toEqual({compatible: true});
  });

  it('is incompatible one minor version below the minimum, with a clear reason', () => {
    const result = checkMspCompatibility(apiVersion(1, MSP_MIN_REQUIRED_API_VERSION_MINOR - 1));
    expect(result.compatible).toBe(false);
    expect((result as {reason: string}).reason).toContain('1.41');
    expect((result as {reason: string}).reason).toContain('1.42');
  });

  it('is incompatible with a lower major version regardless of minor', () => {
    const result = checkMspCompatibility(apiVersion(0, 99));
    expect(result.compatible).toBe(false);
  });
});
