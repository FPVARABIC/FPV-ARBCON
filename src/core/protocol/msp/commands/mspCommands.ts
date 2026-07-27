/**
 * MSP command numbers this pass uses - each verified against Betaflight's
 * actual source at the pinned commit recorded in mspCommandSources.ts
 * (Pass 6.4a Step 0), not assumed from memory or prior discussion.
 */

/** src/main/msp/msp_protocol.h @ BETAFLIGHT_PINNED_COMMIT:
 * `#define MSP_API_VERSION 1    // out message: Get API version` */
export const MSP_API_VERSION = 1;

/** src/main/msp/msp_protocol.h @ BETAFLIGHT_PINNED_COMMIT:
 * `#define MSP_FC_VARIANT  2    // out message: Get flight controller variant` */
export const MSP_FC_VARIANT = 2;

/** src/main/msp/msp_protocol.h @ BETAFLIGHT_PINNED_COMMIT:
 * `#define MSP_BOARD_INFO  4    // out message: Get board information` */
export const MSP_BOARD_INFO = 4;

/** src/main/msp/msp_protocol.h @ BETAFLIGHT_PINNED_COMMIT (Pass 7.0):
 * `#define MSP_ATTITUDE 108  // out message: 2 angles 1 heading` */
export const MSP_ATTITUDE = 108;

/** src/main/msp/msp_protocol.h:197 @ BETAFLIGHT_PINNED_COMMIT (Pass 7.6a):
 * `#define MSP_BATTERY_STATE 130  // out message: Connected/Disconnected,
 * Voltage, Current Used` - see mspCommandSources.ts for the full payload
 * verification record. */
export const MSP_BATTERY_STATE = 130;

/** src/main/msp/msp_protocol.h:177 @ BETAFLIGHT_API147_COMMIT (Pass 7.6c,
 * the direct API-1.47 authority - release 2025.12.5):
 * `#define MSP_RAW_GPS 106  // out message: Fix, numsat, lat, lon, alt,
 * speed, ground course` - only fix + numsat are consumed; coordinates are
 * never retained (decodeRawGps.ts). */
export const MSP_RAW_GPS = 106;

/** src/main/msp/msp_protocol.h:181 @ BETAFLIGHT_API147_COMMIT (Pass 7.6c,
 * the direct API-1.47 authority - release 2025.12.5):
 * `#define MSP_ANALOG 110  // out message: Vbat, powermetersum, rssi if
 * available on RX` - only the RSSI field is consumed (decodeAnalog.ts);
 * its duplicate battery fields never replace MSP_BATTERY_STATE. */
export const MSP_ANALOG = 110;

/** src/main/msp/msp_protocol.h:217 @ BETAFLIGHT_API147_COMMIT (Pass 7.6c,
 * the direct API-1.47 authority - release 2025.12.5):
 * `#define MSP_STATUS_EX 150  // out message: Cycletime, errors_count,
 * CPU load, sensor present etc` - fixed 13-byte prefix only is consumed
 * (decodeStatusEx.ts). */
export const MSP_STATUS_EX = 150;

/** src/main/msp/msp_protocol.h:187 @ BETAFLIGHT_API147_COMMIT (Pass 7.7):
 * `#define MSP_BOXIDS 119  // out message: Get the permanent IDs
 * associated to BOXes` - msp.c:2336-2341 serializes the permanent IDs in
 * the SAME active-box order packFlightModeFlags() packs its bits, which is
 * what makes bit->BOXARM resolution possible. ONE-SHOT per composite
 * readiness identity; never polled (BoxIdsAcquisition.ts). */
export const MSP_BOXIDS = 119;

/**
 * Pass 7.7, Region 5 - the three FC-tool WRITE commands, each verified
 * DIRECTLY at BETAFLIGHT_API147_COMMIT (release 2025.12.5). See
 * mspCommandSources.ts for the full per-command contract record,
 * including the acknowledgement and persistence audits.
 *
 * `#define MSP_ACC_CALIBRATION 205  // in message: no param`
 * msp.c:3313-3317 (mspProcessInCommand):
 *     case MSP_ACC_CALIBRATION:
 *         if (!ARMING_FLAG(ARMED))
 *             accStartCalibration();
 *         break;
 * Empty request payload. The handler only STARTS calibration and the
 * command acks (MSP_RESULT_ACK) either way - including when the FC is
 * ARMED and nothing at all happened. An ack therefore proves neither
 * completion nor that calibration even began.
 */
export const MSP_ACC_CALIBRATION = 205;

/**
 * `#define MSP_MAG_CALIBRATION 206  // in message: no param`
 * msp.c:3319-3326 (mspProcessInCommand):
 *     case MSP_MAG_CALIBRATION:
 *         if (!ARMING_FLAG(ARMED)) {
 *             compassStartCalibration();
 *         }
 * Empty request payload; same start-only, ack-either-way semantics.
 */
export const MSP_MAG_CALIBRATION = 206;

/**
 * `#define MSP_REBOOT 68  // in message: reboot settings`
 * msp.c:2342-2357: an OPTIONAL u8 reboot mode; when the request payload
 * is empty the firmware itself uses `rebootMode = MSP_REBOOT_FIRMWARE`
 * (0), i.e. a normal reboot. This app always sends an EMPTY payload, so
 * it can never select MSC/bootloader by accident. The FC echoes the
 * accepted mode back (`sbufWriteU8(dst, rebootMode)`) and then reboots
 * via mspPostProcessFn - so the USB/MSP link drops right after the ack,
 * and a missing ack does NOT prove the reboot did not happen.
 */
export const MSP_REBOOT = 68;

/**
 * Motor read-capability pass - the six READ-ONLY motor/mixer commands,
 * each verified DIRECTLY at BETAFLIGHT_2025_12_2_COMMIT
 * (79065c96ba0bb5cdc675e67d7093e05dab8b330e, release tag 2025.12.2 - the
 * bench firmware, whose msp_protocol.h:61-62 declares API_VERSION_MAJOR 1
 * / API_VERSION_MINOR 47). See mspCommandSources.ts for the full
 * field-by-field record and the minimum payload length of each.
 *
 * DELIBERATE OMISSION: MSP_SET_MOTOR (214) is NOT defined in this file.
 * It was read during the audit and is intentionally absent - defining a
 * motor WRITE command is a separate, safety-gated decision that has not
 * been taken, and an unused constant is exactly the kind of thing that
 * later gets picked up by accident.
 */

/** src/main/msp/msp_protocol.h @ BETAFLIGHT_2025_12_2_COMMIT:
 * `#define MSP_FEATURE_CONFIG 36` - msp.c:784-786, 4 bytes: the u32
 * enabled-feature mask. FEATURE_3D is bit 12 and is the ONLY authority
 * for whether 3D mode is active. */
export const MSP_FEATURE_CONFIG = 36;

/** src/main/msp/msp_protocol.h @ BETAFLIGHT_2025_12_2_COMMIT:
 * `#define MSP_MIXER_CONFIG 42` - msp.c, 2 bytes: u8 mixerMode, u8
 * yaw_motors_reversed. MIXER_QUADX (3) and MIXER_QUADX_1234 (26) are
 * distinct mixers with different output ordering. */
export const MSP_MIXER_CONFIG = 42;

/** src/main/msp/msp_protocol.h @ BETAFLIGHT_2025_12_2_COMMIT:
 * `#define MSP_ADVANCED_CONFIG 90` - msp.c:1846-1864, 20 bytes. Carries
 * the raw motor protocol and the raw motor idle (hundredths of a
 * percent). gyro_offset_yaw within it is genuinely SIGNED. */
export const MSP_ADVANCED_CONFIG = 90;

/** src/main/msp/msp_protocol.h @ BETAFLIGHT_2025_12_2_COMMIT:
 * `#define MSP_MOTOR 104  // out message: motors` - msp.c:1198-1211,
 * 16 bytes: ALWAYS eight u16 outputs, 0 for a disabled/absent one.
 * DYNAMIC FC-side state - never configuration, never a motor count, and
 * never proof of physical motion or stop. */
export const MSP_MOTOR = 104;

/** src/main/msp/msp_protocol.h @ BETAFLIGHT_2025_12_2_COMMIT:
 * `#define MSP_MOTOR_3D_CONFIG 124` - msp.c, 6 bytes: three u16 3D
 * tuning values. Present whether or not 3D is enabled - they never
 * determine 3D state. */
export const MSP_MOTOR_3D_CONFIG = 124;

/** src/main/msp/msp_protocol.h @ BETAFLIGHT_2025_12_2_COMMIT:
 * `#define MSP_MOTOR_CONFIG 131` - msp.c, 10 bytes. The ONLY authority
 * for motor count. Its first u16 is a removed field hard-coded to 0, not
 * a minimum throttle. */
export const MSP_MOTOR_CONFIG = 131;
