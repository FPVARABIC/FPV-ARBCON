import {MspPayloadReader} from './MspPayloadReader';

/**
 * Motor read-capability pass - wire decoder for MSP_MIXER_CONFIG (42),
 * verified verbatim against src/main/msp/msp.c @
 * BETAFLIGHT_2025_12_2_COMMIT:
 *
 *   offset 0  u8   mixerMode (mixerMode_e)
 *   offset 1  u8   yaw_motors_reversed
 *
 * Exactly 2 bytes are REQUIRED; trailing bytes are permitted and ignored.
 *
 * yaw_motors_reversed IS FC CONFIGURATION, NOT PHYSICAL TRUTH. At this
 * tag mixer.c uses it in exactly one place - to flip the sign of the yaw
 * PID term - and it does NOT remap outputs to airframe positions. It is
 * therefore never evidence of which way any propeller actually turns;
 * only a human looking at the aircraft can establish that.
 */

/** src/main/flight/mixer.h:42 @ BETAFLIGHT_2025_12_2_COMMIT:
 * `MIXER_QUADX = 3`. */
export const MIXER_MODE_QUADX = 3;

/** src/main/flight/mixer.h:65 @ BETAFLIGHT_2025_12_2_COMMIT:
 * `MIXER_QUADX_1234 = 26`. A GENUINELY DIFFERENT MIXER from
 * MIXER_QUADX: same airframe, different motor-output ordering. Exported
 * so callers can reject it explicitly instead of accidentally treating
 * any "quad X" as interchangeable. */
export const MIXER_MODE_QUADX_1234 = 26;

export interface MspMixerConfig {
  /** u8, raw mixerMode_e. Kept raw: the enum is version-sensitive and
   * this decoder asserts no policy about which mixers are acceptable. */
  readonly mixerModeRaw: number;
  /** u8 as sent. Non-zero means the FC is configured for reversed yaw
   * motors ("props out"). CONFIGURATION ONLY - see the file comment. */
  readonly yawMotorsReversed: boolean;
  /** The raw byte behind `yawMotorsReversed`, preserved because the
   * firmware field is a uint8 and a future release could give it values
   * beyond 0/1 that a boolean would silently flatten. */
  readonly yawMotorsReversedRaw: number;
}

export function decodeMixerConfig(payload: Uint8Array): MspMixerConfig {
  const reader = new MspPayloadReader(payload);
  const mixerModeRaw = reader.readU8();
  const yawMotorsReversedRaw = reader.readU8();
  return Object.freeze({
    mixerModeRaw,
    yawMotorsReversed: yawMotorsReversedRaw !== 0,
    yawMotorsReversedRaw,
  });
}
