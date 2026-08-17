import { MspPayloadReader } from './MspPayloadReader';

export const MOTOR_OUTPUT_ORDER_MAX_COUNT = 8;

export interface MspMotorOutputOrder {
  readonly values: readonly number[];
}

export function decodeMotorOutputOrder(
  payload: Uint8Array,
): MspMotorOutputOrder {
  const reader = new MspPayloadReader(payload, {lenient: true});
  // Betaflight reads `data.read8()` entries with no validation at all
  // (src/js/msp/MSPHelper.js case MSP2_MOTOR_OUTPUT_REORDERING). Duplicate and
  // out-of-range checks live on the WRITE, where encodeMotorOutputOrder still
  // enforces both - a board that reports a strange stored order must let the
  // operator SEE and correct it, not lock them out of the Motors screen.
  const count = Math.min(
    reader.readU8(),
    MOTOR_OUTPUT_ORDER_MAX_COUNT,
    reader.remaining(),
  );
  const values: number[] = [];
  for (let index = 0; index < count; index++) {
    values.push(reader.readU8());
  }
  return Object.freeze({ values: Object.freeze(values) });
}
