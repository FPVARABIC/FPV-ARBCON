import {MspPayloadReader} from './MspPayloadReader';

/**
 * Motor read-capability pass - wire decoder for MSP_MOTOR (104),
 * verified verbatim against src/main/msp/msp.c:1198-1211 @
 * BETAFLIGHT_2025_12_2_COMMIT:
 *
 *   for (unsigned i = 0; i < 8; i++) {
 *       if (!motorIsEnabled() || i >= MAX_SUPPORTED_MOTORS || !motorIsMotorEnabled(i)) {
 *           sbufWriteU16(dst, 0);
 *           continue;
 *       }
 *       sbufWriteU16(dst, motorConvertToExternal(motor[i]));
 *   }
 *
 * ALWAYS exactly eight u16 values = 16 bytes, whatever the airframe.
 * All 16 bytes are REQUIRED; trailing bytes are permitted and ignored.
 *
 * ZERO IS A LEGAL VALUE, not a sentinel for "missing". A disabled or
 * absent output writes 0, so the count of non-zero entries is NOT a
 * motor count - MSP_MOTOR_CONFIG's own field is the only authority for
 * that (decodeMotorConfig.ts).
 *
 * THIS IS DYNAMIC STATE, NOT CONFIGURATION, and it is deliberately kept
 * out of the static FC-facts model (../../../state/motorStaticFacts.ts).
 * It is also NOT proof of anything physical: it reports the values the
 * firmware currently holds for its outputs, which is not the same claim
 * as "the propellers are turning" or "the propellers have stopped".
 */

/** src/main/msp/msp.c @ BETAFLIGHT_2025_12_2_COMMIT hard-codes this loop
 * bound - it is a property of the command, not of the airframe. */
export const MSP_MOTOR_OUTPUT_COUNT = 8;

export interface MspMotorOutputs {
  /** Exactly eight u16 values in firmware output order. Frozen so a
   * caller cannot mutate decoded wire data in place. */
  readonly values: readonly number[];
}

export function decodeMotorOutputs(payload: Uint8Array): MspMotorOutputs {
  const reader = new MspPayloadReader(payload);
  const values: number[] = [];
  for (let i = 0; i < MSP_MOTOR_OUTPUT_COUNT; i++) {
    values.push(reader.readU16LE());
  }
  return Object.freeze({values: Object.freeze(values)});
}
