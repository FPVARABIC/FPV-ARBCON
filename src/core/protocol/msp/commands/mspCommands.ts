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

/**
 * Pass 1C-P2. src/main/msp/msp_protocol.h:96 @
 * BETAFLIGHT_2025_12_2_COMMIT:
 * `#define MSP_FC_VERSION 3    // out message: Get flight controller version`
 *
 * The FIRMWARE version - neither MSP_FC_VARIANT nor MSP_API_VERSION.
 * API 1.47 is reported by every 2025.12.x release and "BTFL" names the
 * project, so this is the only command that distinguishes 2025.12.2 from
 * 2025.12.5. Empty request payload; see ../decoding/decodeFcVersion.ts
 * for the verbatim handler, the Pascal-string layout and the official
 * suffix contract.
 *
 * DELIBERATELY NOT PART OF GLOBAL IDENTIFICATION. MspIdentificationService
 * still requests exactly MSP_API_VERSION -> MSP_FC_VARIANT ->
 * MSP_BOARD_INFO. Making this a fourth mandatory step would let a
 * missing or malformed version response fail identification outright for
 * consumers that never needed it (the top bar, telemetry ownership, FC
 * tools). It is acquired instead by a narrow, motor-scoped, session-bound
 * path - ../../../state/motorFcFirmwareVersion.ts - which fails closed
 * for the future motor gate while staying non-fatal to the rest of the
 * application.
 */
export const MSP_FC_VERSION = 3;

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
 * MSP_SET_MOTOR (214) was deliberately omitted by that read-only pass and
 * is declared at the bottom of this file by Pass 1B, under an explicit,
 * narrowly scoped authorization. Its declaration is a CONSTANT ONLY:
 * nothing in this repository calls it, encodes a complete frame for it,
 * or reaches a transport with it. See its own doc comment.
 *
 * STILL DELIBERATELY ABSENT: MSP_SET_ARMING_DISABLED (99). It is not an
 * interlock for MSP_SET_MOTOR (msp.c:3623-3652 @ the pinned commit sets
 * ARMING_DISABLED_MSP and disarms, but nothing in the MSP_SET_MOTOR path
 * consults it), and declaring it is a separate decision that has not
 * been taken.
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

/**
 * THE ONLY MOTOR *WRITE* COMMAND IN THIS REPOSITORY, AND A CONSTANT ONLY.
 *
 * src/main/msp/msp_protocol.h:246 @ BETAFLIGHT_2025_12_2_COMMIT:
 * `#define MSP_SET_MOTOR 214  // in message:  PropBalance function`
 *
 * Handler, verbatim, msp.c:2927-2931 @ the same commit:
 *
 *     case MSP_SET_MOTOR:
 *         for (int i = 0; i < getMotorCount(); i++) {
 *             motor_disarmed[i] = motorConvertFromExternal(sbufReadU16(src));
 *         }
 *         break;
 *
 * FOUR PROPERTIES THAT MAKE THIS COMMAND DANGEROUS, all read from source:
 *
 *  1. NO LENGTH VALIDATION. Unlike its neighbours (MSP_SET_SERVO_
 *     CONFIGURATION checks dataSize), this case reads getMotorCount()
 *     u16 values unconditionally, and sbufReadU16 (common/streambuf.c:
 *     103-109) is two bare `*src->ptr++` dereferences with no bounds
 *     check. A short payload reads past the buffer ON THE FLIGHT
 *     CONTROLLER. A caller must always send exactly motorCount * 2
 *     bytes, with motorCount taken from MSP_MOTOR_CONFIG offset 6.
 *
 *  2. NO EXPIRY. motor_disarmed[] keeps whatever value it was last given
 *     until something else overwrites it. Losing USB, losing the app, or
 *     losing power to the phone does NOT stop a motor.
 *
 *  3. STOP IS A VALUE, NOT A COMMAND. There is no MSP_MOTOR_STOP;
 *     msp_protocol.h has no motor-stop opcode at all. In NON-3D DShot,
 *     stop is external exactly 1000 (drivers/dshot.c:90). FEATURE_
 *     MOTOR_STOP (config/feature.h:49, bit 4) is an unrelated
 *     flight-control feature and is NOT an emergency stop.
 *
 *  4. ACK IS NOT A STOP. The case falls through mspProcessInCommand,
 *     which returns MSP_RESULT_ACK. That proves the frame was parsed -
 *     never that a DShot frame reached an ESC, never that a propeller
 *     stopped turning.
 *
 * DECLARATION ONLY. Pass 1B adds this constant plus pure, unreachable
 * payload/vector functions. It deliberately adds NO caller, NO complete
 * frame construction, NO transport path, and NO runtime registration,
 * and it is NOT authorization to spin a motor.
 */
export const MSP_SET_MOTOR = 214;
