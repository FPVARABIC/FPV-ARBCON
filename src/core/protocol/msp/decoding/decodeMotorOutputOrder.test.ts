import { decodeMotorOutputOrder } from './decodeMotorOutputOrder';
import { encodeMotorOutputOrder } from '../encoding/encodeMotorOutputOrder';

describe('decodeMotorOutputOrder', () => {
  it('decodes the API-1.47 count-prefixed order', () => {
    expect(decodeMotorOutputOrder(Uint8Array.from([4, 2, 0, 3, 1]))).toEqual({
      values: [2, 0, 3, 1],
    });
  });

  it('SHOWS a strange stored order, because the operator has to see it to fix it', () => {
    // Betaflight reads these entries with no validation at all (MSPHelper.js
    // case MSP2_MOTOR_OUTPUT_REORDERING). Throwing here locked the operator
    // out of the whole Motors screen over the very value they came to correct.
    expect(decodeMotorOutputOrder(Uint8Array.from([4, 0, 1])).values).toEqual([0, 1]);
    expect(decodeMotorOutputOrder(Uint8Array.from([4, 0, 1, 1, 3])).values).toEqual([0, 1, 1, 3]);
    expect(decodeMotorOutputOrder(Uint8Array.from([4, 0, 1, 2, 8])).values).toEqual([0, 1, 2, 8]);
  });

  it('and the WRITE still refuses to send one back', () => {
    // The safety check did not disappear, it moved to where Betaflight keeps
    // it. A duplicate or out-of-range index can be read and displayed; it can
    // never be written to the flight controller.
    expect(() => encodeMotorOutputOrder([0, 1, 1, 3])).toThrow(/unique/);
    expect(() => encodeMotorOutputOrder([0, 1, 2, 8])).toThrow(/invalid/);
  });
});
