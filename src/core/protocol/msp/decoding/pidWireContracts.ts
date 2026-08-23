/**
 * WHICH WIRE CONTRACT A BOARD IS SPEAKING, and how we decide.
 *
 * P-B pins three firmware trees, and they do not agree with each other about
 * what the PID page's payloads contain:
 *
 *   API 1.47  7348054f268f0058574719c134e9f149565bb8ea
 *   API 1.48  6dbc4218fd6bc33bf16ea32c670304d4f89321d5   (firmware tag 2026.6.1)
 *   API 1.49  e72a8e93695270d54897a8f128cffdf8f74a0245   (master)
 *
 * The differences are small and entirely real:
 *
 *   MSP_PID                 15 bytes at all three
 *   MSP_RC_TUNING           24 bytes at all three
 *   MSP_SIMPLIFIED_TUNING   53 bytes at all three
 *   MSP_PID_ADVANCED        61 bytes at all three, but three FIELDS retire
 *   MSP_FILTER_CONFIG       49 bytes at 1.47, 56 from 1.48 (a 7-byte RPM tail)
 *
 * NO BRANCH IS KEYED TO A MARKETING VERSION STRING. A contract is resolved
 * from the numeric API version the identification already proved, and a
 * decoder that can additionally tell from the payload ITSELF (FILTER_CONFIG
 * can - its length changed) prefers that observation, because the bytes in
 * hand outrank a version number in a different response.
 */

/** The three pinned contracts. Nothing else is speakable. */
export type PidApiContract = 'API_1_47' | 'API_1_48' | 'API_1_49';

export interface PidApiVersion {
  readonly major: number;
  readonly minor: number;
}

/** Fixed across all three pinned trees. */
export const MSP_PID_BYTES = 15;
export const MSP_RC_TUNING_BYTES = 24;
export const MSP_SIMPLIFIED_TUNING_BYTES = 53;
export const MSP_PID_ADVANCED_BYTES = 61;

/** MSP_FILTER_CONFIG is the one payload whose LENGTH moved. */
export const MSP_FILTER_CONFIG_BYTES_API147 = 49;
export const MSP_FILTER_CONFIG_BYTES_API148 = 56;
/** The 1.48 addition: u16 fade range, u16 q, RPM_FILTER_HARMONICS_MAX u8 weights. */
export const RPM_FILTER_HARMONICS_MAX = 3;
export const FILTER_CONFIG_RPM_TAIL_BYTES = 2 + 2 + RPM_FILTER_HARMONICS_MAX;

/**
 * Resolve the contract from a proven API version.
 *
 * Anything below 1.47 is not a contract this module speaks - the caller is
 * expected to have refused the board before reaching here, exactly as
 * `isSupportedConfigurationApi` already does for the existing PID path.
 * Anything ABOVE 1.49 is treated as 1.49: that is the newest layout we have
 * read, and the decoders below preserve unrecognised trailing bytes rather
 * than rejecting them.
 */
export function resolvePidApiContract(version: PidApiVersion): PidApiContract | undefined {
  if (!Number.isInteger(version.major) || !Number.isInteger(version.minor)) return undefined;
  if (version.major !== 1) return undefined;
  if (version.minor < 47) return undefined;
  if (version.minor === 47) return 'API_1_47';
  if (version.minor === 48) return 'API_1_48';
  return 'API_1_49';
}

/** How many bytes MSP_FILTER_CONFIG carries under a given contract. */
export function filterConfigBytesFor(contract: PidApiContract): number {
  return contract === 'API_1_47' ? MSP_FILTER_CONFIG_BYTES_API147 : MSP_FILTER_CONFIG_BYTES_API148;
}

/**
 * A field that the wire still carries but the firmware no longer reads.
 *
 * The byte does not disappear when a feature is retired - the firmware
 * writes a literal 0 into it and ignores it on the way back in. So the
 * SEMANTIC state of these fields is versioned even though the LENGTH is not,
 * and a decoder that reports 0 without saying "this is retired here" would
 * be handing the UI a number that means nothing.
 */
export type PidAdvancedFieldLifetime = 'LIVE' | 'RETIRED';

/** absolute control: live at 1.47, written as literal 0 from 1.48. */
export function absControlLifetime(contract: PidApiContract): PidAdvancedFieldLifetime {
  return contract === 'API_1_47' ? 'LIVE' : 'RETIRED';
}

/** integrated yaw + its relax: live through 1.48, written as literal 0 at 1.49. */
export function integratedYawLifetime(contract: PidApiContract): PidAdvancedFieldLifetime {
  return contract === 'API_1_49' ? 'RETIRED' : 'LIVE';
}
