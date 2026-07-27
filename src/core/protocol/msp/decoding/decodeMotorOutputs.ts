import {MspPayloadReader} from './MspPayloadReader';

/**
 * Motor read-capability pass - wire decoder for MSP_MOTOR (104),
 * verified against src/main/msp/msp.c:1199-1211 @
 * BETAFLIGHT_2025_12_2_COMMIT. Quoted here VERBATIM AND IN FULL,
 * including the build-time conditional (preprocessor directives are at
 * column 0 upstream, as reproduced), so the excerpt cannot be read as
 * saying more than the firmware does:
 *
 *       for (unsigned i = 0; i < 8; i++) {
 *   #ifdef USE_MOTOR
 *           if (!motorIsEnabled() || i >= MAX_SUPPORTED_MOTORS || !motorIsMotorEnabled(i)) {
 *               sbufWriteU16(dst, 0);
 *               continue;
 *           }
 *
 *           sbufWriteU16(dst, motorConvertToExternal(motor[i]));
 *   #else
 *           sbufWriteU16(dst, 0);
 *   #endif
 *       }
 *
 * Both arms of that #ifdef write exactly one u16 per iteration, so the
 * payload length is identical whether or not the firmware was built with
 * USE_MOTOR; a build without it simply reports eight zeros.
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
 * bound - it is a property of the COMMAND, not of the airframe.
 *
 * NAMED "...SLOT_COUNT", NOT "...COUNT": this is the number of output
 * SLOTS the MSP_MOTOR response always carries, and it is emphatically
 * not a motor count. Confusing the two is the precise mistake this
 * decoder exists to prevent - MSP_MOTOR_CONFIG's own field is the only
 * authority for how many motors the airframe has. */
export const MSP_MOTOR_OUTPUT_SLOT_COUNT = 8;

export interface MspMotorOutputs {
  /** Exactly eight u16 slot values in firmware output order. Frozen so a
   * caller cannot mutate decoded wire data in place. */
  readonly values: readonly number[];
}

export function decodeMotorOutputs(payload: Uint8Array): MspMotorOutputs {
  const reader = new MspPayloadReader(payload);
  const values: number[] = [];
  for (let i = 0; i < MSP_MOTOR_OUTPUT_SLOT_COUNT; i++) {
    values.push(reader.readU16LE());
  }
  return Object.freeze({values: Object.freeze(values)});
}
