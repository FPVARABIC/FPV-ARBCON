import { encodeMotorOutputOrder } from './encodeMotorOutputOrder';

describe('encodeMotorOutputOrder', () => {
  it('writes a count followed by the exact physical resource indices', () => {
    expect(Array.from(encodeMotorOutputOrder([2, 0, 3, 1]))).toEqual([
      4, 2, 0, 3, 1,
    ]);
  });

  it('rejects empty, duplicate, non-integer, and out-of-range maps', () => {
    expect(() => encodeMotorOutputOrder([])).toThrow();
    expect(() => encodeMotorOutputOrder([0, 1, 1, 3])).toThrow(/unique/);
    expect(() => encodeMotorOutputOrder([0, 1.5, 2, 3])).toThrow(/invalid/);
    expect(() => encodeMotorOutputOrder([0, 1, 2, 8])).toThrow(/invalid/);
  });
});
