import { MOTOR_OUTPUT_ORDER_MAX_COUNT } from '../decoding/decodeMotorOutputOrder';

export class MotorOutputOrderEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MotorOutputOrderEncodeError';
  }
}

export function encodeMotorOutputOrder(values: readonly number[]): Uint8Array {
  if (values.length < 1 || values.length > MOTOR_OUTPUT_ORDER_MAX_COUNT) {
    throw new MotorOutputOrderEncodeError(
      `Motor output order must contain 1..${MOTOR_OUTPUT_ORDER_MAX_COUNT} entries.`,
    );
  }
  if (
    values.some(
      value =>
        !Number.isInteger(value) ||
        value < 0 ||
        value >= MOTOR_OUTPUT_ORDER_MAX_COUNT,
    )
  ) {
    throw new MotorOutputOrderEncodeError(
      'Motor output order contains an invalid physical output index.',
    );
  }
  if (new Set(values).size !== values.length) {
    throw new MotorOutputOrderEncodeError(
      'Motor output order must contain unique physical output indices.',
    );
  }
  return Uint8Array.from([values.length, ...values]);
}
