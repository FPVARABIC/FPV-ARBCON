import { MspPayloadReadError, MspPayloadReader } from './MspPayloadReader';

export const MOTOR_OUTPUT_ORDER_MAX_COUNT = 8;

export interface MspMotorOutputOrder {
  readonly values: readonly number[];
}

export function decodeMotorOutputOrder(
  payload: Uint8Array,
): MspMotorOutputOrder {
  const reader = new MspPayloadReader(payload);
  const count = reader.readU8();
  if (count > MOTOR_OUTPUT_ORDER_MAX_COUNT) {
    throw new MspPayloadReadError(
      `Motor output order count ${count} exceeds ${MOTOR_OUTPUT_ORDER_MAX_COUNT}.`,
    );
  }
  const values: number[] = [];
  for (let index = 0; index < count; index++) {
    values.push(reader.readU8());
  }
  if (new Set(values).size !== values.length) {
    throw new MspPayloadReadError(
      'Motor output order contains duplicate physical output indices.',
    );
  }
  if (values.some(value => value >= MOTOR_OUTPUT_ORDER_MAX_COUNT)) {
    throw new MspPayloadReadError(
      'Motor output order contains an out-of-range physical output index.',
    );
  }
  return Object.freeze({ values: Object.freeze(values) });
}
