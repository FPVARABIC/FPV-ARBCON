import type {MspApiVersion} from '../decoding/decodeApiVersion';

/**
 * Minimum MSP API version this project requires going forward: 1.42.
 * Not an arbitrary number - grounded in Pass 6.4a Step 0's own verified
 * reading of src/main/msp/msp.c's MSP_BOARD_INFO case (see
 * ../commands/mspCommandSources.ts): 1.42 is the first API version that
 * adds the configurationState field, which this project's future
 * ownership/reconfiguration-state UI (Pass 6.4b+) will depend on. Firmware
 * older than this can still be identified (MSP_API_VERSION/MSP_FC_VARIANT/
 * MSP_BOARD_INFO's guaranteed prefix all still decode fine), but is
 * reported incompatible so callers can surface a clear message rather than
 * silently proceeding without a field a later pass will assume exists.
 */
export const MSP_MIN_REQUIRED_API_VERSION_MAJOR = 1;
export const MSP_MIN_REQUIRED_API_VERSION_MINOR = 42;

export type MspCompatibilityResult = {compatible: true} | {compatible: false; reason: string};

/**
 * Pure validation - returns a discriminated union rather than throwing.
 * MspIdentificationService (the only current caller) decides how to
 * surface an incompatibility as its own typed error; this function makes
 * no assumption about what a caller wants to do with a "false" result.
 */
export function checkMspCompatibility(apiVersion: MspApiVersion): MspCompatibilityResult {
  const {apiVersionMajor, apiVersionMinor} = apiVersion;

  if (apiVersionMajor > MSP_MIN_REQUIRED_API_VERSION_MAJOR) {
    return {compatible: true};
  }
  if (
    apiVersionMajor === MSP_MIN_REQUIRED_API_VERSION_MAJOR &&
    apiVersionMinor >= MSP_MIN_REQUIRED_API_VERSION_MINOR
  ) {
    return {compatible: true};
  }

  return {
    compatible: false,
    reason:
      `Flight controller reports MSP API ${apiVersionMajor}.${apiVersionMinor}, but this app requires ` +
      `at least ${MSP_MIN_REQUIRED_API_VERSION_MAJOR}.${MSP_MIN_REQUIRED_API_VERSION_MINOR}.`,
  };
}
