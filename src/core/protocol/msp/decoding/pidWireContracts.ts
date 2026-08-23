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
export type PidApiResolution =
  | {readonly kind: 'SOURCE_VERIFIED'; readonly contract: PidApiContract}
  /**
   * A firmware newer than anything we have read. It is NOT 1.49 with extra
   * bytes - it is a layout nobody here has seen. P-B originally folded this
   * into 1.49, and that was wrong as a WRITE authority: it would have let
   * this app patch a 61-byte structure whose field meanings it cannot know,
   * and send a FILTER_CONFIG whose length it is only guessing.
   */
  | {readonly kind: 'UNVERIFIED_FUTURE_API'; readonly minor: number; readonly newestVerified: PidApiContract}
  | {readonly kind: 'BELOW_SUPPORTED_FLOOR'; readonly minor: number}
  | {readonly kind: 'NOT_A_BETAFLIGHT_API'};

/** The newest layout this build has actually read from firmware source. */
export const NEWEST_SOURCE_VERIFIED_CONTRACT: PidApiContract = 'API_1_49';
export const NEWEST_SOURCE_VERIFIED_MINOR = 49;
export const OLDEST_SUPPORTED_MINOR = 47;

export function resolvePidApi(version: PidApiVersion): PidApiResolution {
  if (!Number.isInteger(version.major) || !Number.isInteger(version.minor)) {
    return Object.freeze({kind: 'NOT_A_BETAFLIGHT_API'});
  }
  if (version.major !== 1) return Object.freeze({kind: 'NOT_A_BETAFLIGHT_API'});
  if (version.minor < OLDEST_SUPPORTED_MINOR) {
    return Object.freeze({kind: 'BELOW_SUPPORTED_FLOOR', minor: version.minor});
  }
  if (version.minor === 47) return Object.freeze({kind: 'SOURCE_VERIFIED', contract: 'API_1_47'});
  if (version.minor === 48) return Object.freeze({kind: 'SOURCE_VERIFIED', contract: 'API_1_48'});
  if (version.minor === 49) return Object.freeze({kind: 'SOURCE_VERIFIED', contract: 'API_1_49'});
  return Object.freeze({
    kind: 'UNVERIFIED_FUTURE_API',
    minor: version.minor,
    newestVerified: NEWEST_SOURCE_VERIFIED_CONTRACT,
  });
}

/**
 * The contract to decode with, or nothing.
 *
 * Deliberately returns `undefined` for an unverified future API rather than
 * the newest one we know. A caller that wants to attempt a best-effort READ
 * of a known prefix must ask for `newestVerified` by name, so that choice is
 * visible at the call site instead of hidden in a fallback.
 */
export function sourceVerifiedContract(resolution: PidApiResolution): PidApiContract | undefined {
  return resolution.kind === 'SOURCE_VERIFIED' ? resolution.contract : undefined;
}

/**
 * WHETHER THIS APP MAY WRITE TUNING TO THIS BOARD AT ALL.
 *
 * Fail-closed, and the only `ALLOWED` is a layout read from pinned firmware
 * source. Everything else refuses: a board older than the floor, a board
 * newer than anything studied, and anything that is not a Betaflight API
 * version. There is no "probably compatible".
 */
export type PidWriteAuthority =
  | {readonly kind: 'ALLOWED'; readonly contract: PidApiContract}
  | {readonly kind: 'REFUSED'; readonly reason: 'UNVERIFIED_FUTURE_API' | 'BELOW_SUPPORTED_FLOOR' | 'NOT_A_BETAFLIGHT_API'};

export function pidWriteAuthority(resolution: PidApiResolution): PidWriteAuthority {
  return resolution.kind === 'SOURCE_VERIFIED'
    ? Object.freeze({kind: 'ALLOWED', contract: resolution.contract})
    : Object.freeze({kind: 'REFUSED', reason: resolution.kind});
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
