import { decodeGpsConfiguration } from './decodeGpsConfiguration';
import { encodeGpsConfiguration } from '../encoding/encodeGpsConfiguration';

describe('GPS configuration wire contract', () => {
  it('round-trips all six official bytes without normalization', () => {
    const config = decodeGpsConfiguration(Uint8Array.from([1, 4, 1, 0, 1, 1]));
    expect(config).toEqual({
      provider: 1,
      sbasMode: 4,
      autoConfig: true,
      autoBaud: false,
      homePointOnce: true,
      useGalileo: true,
    });
    expect(encodeGpsConfiguration(config)).toEqual(
      Uint8Array.from([1, 4, 1, 0, 1, 1]),
    );
  });

  it('rejects values that cannot be represented as u8', () => {
    expect(() =>
      encodeGpsConfiguration({
        provider: 256,
        sbasMode: 0,
        autoConfig: false,
        autoBaud: false,
        homePointOnce: false,
        useGalileo: false,
      }),
    ).toThrow(RangeError);
  });
});
