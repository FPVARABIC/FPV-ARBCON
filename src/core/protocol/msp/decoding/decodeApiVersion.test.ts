import {decodeApiVersion} from './decodeApiVersion';
import {MspPayloadReadError} from './MspPayloadReader';

describe('decodeApiVersion', () => {
  it('decodes a realistic full payload correctly', () => {
    // mspProtocolVersion=0, apiVersionMajor=1, apiVersionMinor=48 - the
    // real values Betaflight sends at BETAFLIGHT_PINNED_COMMIT.
    const payload = Uint8Array.from([0, 1, 48]);
    expect(decodeApiVersion(payload)).toEqual({
      mspProtocolVersion: 0,
      apiVersionMajor: 1,
      apiVersionMinor: 48,
    });
  });

  it('throws MspPayloadReadError for a truncated payload', () => {
    const payload = Uint8Array.from([0, 1]);
    expect(() => decodeApiVersion(payload)).toThrow(MspPayloadReadError);
  });
});
