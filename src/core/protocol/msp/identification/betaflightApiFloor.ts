/**
 * THE ONE PLACE THAT DECIDES WHETHER A BOARD'S API IS ONE THIS APP
 * CONFIGURES - stated over a bare identity so BOTH layers can ask it.
 *
 * The platform layer's betaflightApiSupport.ts wraps this in a type guard
 * over MspIdentificationState and carries the payload-by-payload
 * justification for the floor. This module exists because core's own
 * setupDiagnostics.ts needs the same verdict and must not import from
 * platform - and because a second copy of the rule is exactly how the
 * eight-way drift this replaced started.
 *
 * WHY THE FLOOR IS 1.47 AND WHY THERE IS NO CEILING: see
 * betaflightApiSupport.ts. In short - 1.46 is a real contract difference
 * (MSP_STATUS_EX carries no numberOfRateProfiles before 1.47), while
 * everything above is handled by lenient reading plus verified-only
 * writing plus the readback comparison, not by a version whitelist.
 */

/** Betaflight's MSP major version. Anything else is a different protocol. */
export const SUPPORTED_MSP_API_MAJOR = 1;

/**
 * The lowest minor the configuration screens accept.
 *
 * Raising this is a product decision. LOWERING it requires re-verifying
 * every payload against that older contract.
 */
export const MINIMUM_CONFIGURATION_API_MINOR = 47;

/** Firmware identifier this app configures. */
export const SUPPORTED_FIRMWARE_IDENTIFIER = 'BTFL';

/** The shape both callers already have: a settled firmware identity. */
export interface BetaflightApiIdentity {
  readonly firmware: {readonly identifier: string};
  readonly apiVersion: {readonly apiVersionMajor: number; readonly apiVersionMinor: number};
}

export function isSupportedConfigurationIdentity(identity: BetaflightApiIdentity): boolean {
  return (
    identity.firmware.identifier === SUPPORTED_FIRMWARE_IDENTIFIER &&
    identity.apiVersion.apiVersionMajor === SUPPORTED_MSP_API_MAJOR &&
    identity.apiVersion.apiVersionMinor >= MINIMUM_CONFIGURATION_API_MINOR
  );
}
