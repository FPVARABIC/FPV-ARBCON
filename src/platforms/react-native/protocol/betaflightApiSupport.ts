/**
 * WHICH BETAFLIGHT API VERSIONS THE CONFIGURATION SCREENS ACCEPT.
 *
 * ONE PLACE, because eight copies drifted. Failsafe, Power, OSD, PID, VTX,
 * Modes, Configuration and FC Tools each carried their own inline
 * `apiVersionMinor !== 47`, while Ports and GPS carried `>= 46` and
 * Receiver `>= 47`. Nothing reconciled them, so the app's answer to "does
 * this firmware work" depended on which screen you opened. On API 1.48 -
 * Betaflight 4.7 - the eight exact-locked screens all reported
 * UNSUPPORTED_FIRMWARE while the other three kept working: half a dead
 * app, which is worse for an operator than a clean refusal.
 *
 * =====================================================================
 * WHY >= 1.47 IS SAFE, VERIFIED AGAINST THE BETAFLIGHT SOURCES
 * =====================================================================
 *
 * This is not "relax the check and hope". Every payload these screens
 * read or write was compared between API 1.47 and 1.48 in
 * betaflight-configurator's MSPHelper.js (the client contract) and
 * src/main/msp/msp.c plus src/main/cli/settings.c (the firmware
 * contract). There are exactly four differences, and none of them breaks
 * a 1.47-shaped exchange:
 *
 *   MSP_STATUS_EX (read, every screen)
 *     1.48 APPENDS numberOfBatteryProfiles (u8) and batteryProfile (u8)
 *     after numberOfRateProfiles. A tail addition. MspPayloadReader is
 *     length-driven - decodeStatusExReadiness stops at what it knows and
 *     never treats trailing bytes as an error - so the extra bytes are
 *     ignored exactly as Betaflight ignores fields it does not know.
 *
 *   MSP_FILTER_CONFIG (read, PID screen)
 *     1.48 APPENDS gyro_rpm_notch_fade_range_hz (u16), gyro_rpm_notch_q
 *     (u16) and three gyro_rpm_notch_weights (u8). Tail again; same
 *     reasoning.
 *
 *   MSP_SET_FILTER_CONFIG (write, PID screen)
 *     1.48 appends those same seven bytes. We keep writing the 1.47
 *     length, and that is CORRECT rather than merely tolerated: the
 *     firmware's own handler guards each block with
 *     `if (sbufBytesRemaining(src) >= N)` (msp.c, MSP_SET_FILTER_CONFIG),
 *     so a shorter payload leaves the newer fields at their current
 *     values. We never write a field whose contract we have not verified.
 *
 *   MSP_SET_PID_ADVANCED (write, PID screen)
 *     The byte that was abs_control_gain became reserved at 1.48. The
 *     firmware reads and DISCARDS it - `sbufReadU8(src); // was
 *     abs_control_gain` - so the byte's value cannot affect the aircraft
 *     on either version, and the payload length is unchanged.
 *
 * MSP_ADJUSTMENT_RANGES also changed at 1.48 (6 to 10 bytes per item).
 * It is listed here only so a future reader knows it was checked: this
 * app implements no Adjustments screen, so nothing reads or writes it.
 *
 * =====================================================================
 * WHY THE FLOOR IS 1.47 AND NOT LOWER
 * =====================================================================
 *
 * 1.46 is a genuine, deliberate refusal rather than an oversight. The PID
 * screen needs numberOfRateProfiles, which MSP_STATUS_EX only carries
 * from 1.47 (MSPHelper.js gates it on API_VERSION_1_47), and the screens
 * here were verified field-by-field against the 1.47 contract. Ports and
 * GPS keep their own `>= 46` floors because their payloads were verified
 * at 1.46 as well; those are not changed by this module.
 *
 * =====================================================================
 * WHAT THIS DOES NOT DO
 * =====================================================================
 *
 * It does not promise that a version above 1.48 is understood. It
 * promises the OPPOSITE of a hard lock: read leniently, write only the
 * fields whose contract is verified, and let the existing readback
 * comparison catch anything the firmware did not accept. A newer
 * firmware that changes an EXISTING field's meaning in place - rather
 * than appending - would defeat any version predicate; the readback
 * check is what stands behind this, and it is unchanged.
 */

import {
  isSupportedConfigurationIdentity,
  MINIMUM_CONFIGURATION_API_MINOR,
  SUPPORTED_FIRMWARE_IDENTIFIER,
  SUPPORTED_MSP_API_MAJOR,
} from '../../../core/protocol/msp/identification/betaflightApiFloor';
import type {MspIdentificationState} from './MspSessionCoordinator';

/**
 * The numbers live in core/protocol/msp/identification/betaflightApiFloor
 * because core's own setup diagnostics need the same verdict and must not
 * import from platform. Re-exported here so the eight controllers and the
 * matrix keep one import site.
 */
export {MINIMUM_CONFIGURATION_API_MINOR, SUPPORTED_FIRMWARE_IDENTIFIER, SUPPORTED_MSP_API_MAJOR};

/**
 * Whether the configuration screens may read and write this board.
 *
 * A TYPE GUARD, not a plain boolean, and deliberately so: the eight
 * inline gates this replaces each did double duty - they rejected the
 * board AND narrowed `identification` to its SUCCEEDED shape for the
 * code that followed. Returning a bare boolean would have silently cost
 * every caller that narrowing.
 *
 * Deliberately NOT an upper bound - see the header. `false` here means a
 * screen reports UNSUPPORTED_FIRMWARE and refuses both load and save,
 * which stays the correct answer for a non-Betaflight board or an API
 * older than the contract we verified.
 */
export function isSupportedConfigurationApi(
  identification: MspIdentificationState,
): identification is Extract<MspIdentificationState, {status: 'SUCCEEDED'}> {
  if (identification.status !== 'SUCCEEDED') {
    return false;
  }
  return isSupportedConfigurationIdentity(identification.identity);
}

/**
 * Whether this board's MSP_PID_ADVANCED still carries a meaningful
 * absolute-control gain.
 *
 * At 1.48 the firmware turned that byte into a discarded reserved slot.
 * The value we decode from a 1.48 board is therefore not a setting, and
 * a screen must not present it as one. The byte is still WRITTEN at its
 * fixed offset on every version - the firmware ignores it at 1.48 - so
 * the payload length and every other field's offset are unchanged.
 */
export function supportsAbsoluteControlGain(
  identification: MspIdentificationState,
): boolean {
  if (identification.status !== 'SUCCEEDED') {
    return false;
  }
  const {apiVersion} = identification.identity;
  return apiVersion.apiVersionMajor === 1 && apiVersion.apiVersionMinor < 48;
}
