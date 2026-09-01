/* eslint-disable no-bitwise -- the rate-profile discriminator IS a bit in
   a firmware payload byte; expressing it as arithmetic would hide that. */
/**
 * MSP_SELECT_SETTING's single payload byte.
 *
 * One byte, and the encoding is NOT symmetric between the two things it
 * can select:
 *
 *   PID profile    the zero-based index, sent as-is
 *   RATE profile   the zero-based index OR'd with 0x80
 *
 * Verified in betaflight-configurator's own PidTuningTab.vue:
 *
 *   MSP.promise(MSPCodes.MSP_SELECT_SETTING, [currentProfile.value]);
 *   MSP.promise(MSPCodes.MSP_SELECT_SETTING, [currentRateProfile.value | 128]);
 *
 * WHY THIS IS ITS OWN MODULE. The discriminator is a payload bit, not a
 * command id, and it was briefly declared alongside the command ids where
 * it collided with MSP_VOLTAGE_METERS (128). Keeping the bit math here
 * also means the controller states an intent - "select this rate
 * profile" - instead of performing an OR whose meaning lives elsewhere.
 *
 * THE HIGH BIT IS A DISCRIMINATOR, NOT PART OF THE INDEX, so an index of
 * 128 or more is not representable at all: it would arrive at the board
 * as a rate profile. That is a refusal, not a clamp.
 */

/** Marks a MSP_SELECT_SETTING index as a RATE profile. */
export const SELECT_SETTING_RATE_PROFILE_FLAG = 0x80;

/** The largest index the one-byte encoding can carry. */
export const SELECT_SETTING_MAX_INDEX = SELECT_SETTING_RATE_PROFILE_FLAG - 1;

export type SelectSettingProfileKind = 'PID' | 'RATE';

export function isEncodableProfileIndex(index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index <= SELECT_SETTING_MAX_INDEX;
}

export function encodeSelectSetting(kind: SelectSettingProfileKind, index: number): Uint8Array {
  if (!isEncodableProfileIndex(index)) {
    throw new RangeError(`Profile index ${index} cannot be encoded for MSP_SELECT_SETTING.`);
  }
  return Uint8Array.from([kind === 'RATE' ? index | SELECT_SETTING_RATE_PROFILE_FLAG : index]);
}
