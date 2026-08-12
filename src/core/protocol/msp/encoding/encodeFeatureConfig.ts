/**
 * RECEIVER P4 - wire encoder for MSP_SET_FEATURE_CONFIG (37).
 *
 * FIRMWARE FACT - src/main/msp/msp.c:3712-3714 @ pinned Betaflight API
 * 1.47 (79065c96ba0bb5cdc675e67d7093e05dab8b330e):
 *
 *   case MSP_SET_FEATURE_CONFIG:
 *       featureConfigReplace(sbufReadU32(src));
 *
 * REPLACE, not merge. The payload is the COMPLETE 32-bit mask and every
 * bit absent from it is cleared, so a caller that sends only the bits it
 * cares about silently disables everything else on the aircraft. This
 * encoder therefore takes a whole mask and nothing that resembles a
 * per-feature flag; the mask must be built by reading MSP_FEATURE_CONFIG
 * inside the same transaction and mutating only the bits the caller owns
 * (see receiverModeCapability.applyReceiverModeToFeatureMask).
 *
 * UNSIGNED. Bit 31 is a legal feature bit, so values above 0x7fffffff
 * must encode as themselves rather than as a negative number; the range
 * check and `>>> 0` below make that explicit rather than relying on
 * setUint32's coercion.
 *
 * NOTE ON DUPLICATION, stated rather than hidden: GpsConfigurationController
 * writes this command with an equivalent inline DataView. It is not
 * refactored onto this encoder in P4 - touching the GPS save path to
 * tidy a two-line write would put an unrelated screen at risk for no
 * behavioural gain. The gap is recorded, not pretended away.
 */

export function encodeFeatureConfig(mask: number): Uint8Array {
  if (!Number.isInteger(mask) || mask < 0 || mask > 0xffffffff) {
    throw new RangeError(`Feature mask ${mask} is not a u32.`);
  }
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, mask >>> 0, true);
  return payload;
}
