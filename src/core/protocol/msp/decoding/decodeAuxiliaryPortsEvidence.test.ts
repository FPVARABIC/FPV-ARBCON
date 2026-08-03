import { decodeBuildOptions } from './decodeBuildOptions';
import { decodeSerialRxProvider } from './decodeSerialRxProvider';
import { decodeVtxTableStatus } from './decodeVtxTableStatus';

describe('Ports auxiliary evidence decoders', () => {
  it('reads build option ids after the fixed header', () => {
    const payload = Uint8Array.from([
      ...new Array(26).fill(7),
      0x1c,
      0x40,
      0x17,
      0x30,
      0,
      0,
    ]);
    expect([...decodeBuildOptions(payload).optionIds]).toEqual([
      16400 + 12,
      12311,
    ]);
  });

  it('reads the current receiver provider without interpreting trailing fields', () => {
    expect(decodeSerialRxProvider(Uint8Array.from([9, 88]))).toBe(9);
  });

  it('reads VTX table availability from the fixed response prefix', () => {
    const payload = Uint8Array.from([
      3, 1, 2, 3, 0, 0x21, 0x16, 1, 0, 0, 0, 1, 6, 8, 4,
    ]);
    expect(decodeVtxTableStatus(payload)).toEqual({
      deviceType: 3,
      ready: true,
      tableAvailable: true,
      bands: 6,
      channels: 8,
      powerLevels: 4,
    });
  });
});
