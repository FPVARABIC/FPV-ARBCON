import { decodeMotorOutputOrder } from './decodeMotorOutputOrder';

describe('decodeMotorOutputOrder', () => {
  it('decodes the API-1.47 count-prefixed order', () => {
    expect(decodeMotorOutputOrder(Uint8Array.from([4, 2, 0, 3, 1]))).toEqual({
      values: [2, 0, 3, 1],
    });
  });

  it('rejects truncation, duplicates, and out-of-range resources', () => {
    expect(() => decodeMotorOutputOrder(Uint8Array.from([4, 0, 1]))).toThrow();
    expect(() =>
      decodeMotorOutputOrder(Uint8Array.from([4, 0, 1, 1, 3])),
    ).toThrow(/duplicate/);
    expect(() =>
      decodeMotorOutputOrder(Uint8Array.from([4, 0, 1, 2, 8])),
    ).toThrow(/out-of-range/);
  });
});
