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

/** Build feature identifiers compiled into the connected target. */
export const MSP_BUILD_INFO = 5;

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

/** Betaflight 2025.12.2: distance and direction from the armed/home point. */
export const MSP_COMP_GPS = 107;

/** Betaflight 2025.12.2: six-byte GPS provider/SBAS/automation config. */
export const MSP_GPS_CONFIG = 132;

/** Betaflight 2025.12.2: per-satellite channel, id, quality and C/N0. */
export const MSP_GPS_SV_INFO = 164;

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

/** src/main/msp/msp_protocol.h:230 @ the pinned Betaflight API 1.47
 * authority (79065c96ba0bb5cdc675e67d7093e05dab8b330e):
 * `#define MSP_TX_INFO 187`. Receiver P2 reads it for the firmware's
 * rssiSource enum (msp.c:2164-2176); see decodeTxInfo.ts. It carries no
 * link-quality value - the pinned firmware serialises none. */
export const MSP_TX_INFO = 187;

/** src/main/msp/msp_protocol.h:187 @ BETAFLIGHT_API147_COMMIT (Pass 7.7):
 * `#define MSP_BOXIDS 119  // out message: Get the permanent IDs
 * associated to BOXes` - msp.c:2336-2341 serializes the permanent IDs in
 * the SAME active-box order packFlightModeFlags() packs its bits, which is
 * what makes bit->BOXARM resolution possible. ONE-SHOT per composite
 * readiness identity; never polled (BoxIdsAcquisition.ts). */
export const MSP_BOXIDS = 119;

/** Betaflight 2025.12.2 / MSP API 1.47 AUX mode configuration.
 * MSP_MODE_RANGES returns the complete fixed-size activation-condition table,
 * MSP_MODE_RANGES_EXTRA supplies OR/AND plus linked-mode metadata, and
 * MSP_SET_MODE_RANGE writes one indexed table row. A save transaction must
 * rewrite every row so deleted conditions are cleared on the FC. */
export const MSP_MODE_RANGES = 34;
export const MSP_SET_MODE_RANGE = 35;
export const MSP_BOXNAMES = 116;
export const MSP_MODE_RANGES_EXTRA = 238;

/** Betaflight 2025.12.2 / MSP API 1.47 failsafe configuration. */
export const MSP_FAILSAFE_CONFIG = 75;
export const MSP_SET_FAILSAFE_CONFIG = 76;
export const MSP_RXFAIL_CONFIG = 77;
export const MSP_SET_RXFAIL_CONFIG = 78;

/**
 * GPS Rescue - the stage-2 procedure's own parameters.
 *
 * `#define MSP_GPS_RESCUE 135` / `#define MSP_SET_GPS_RESCUE 225`, from
 * betaflight-configurator's src/js/msp/MSPCodes.js and the firmware's
 * src/main/msp/msp_protocol.h.
 *
 * BOTH ARE OPTIONAL COMMANDS. The firmware wraps them in
 * `#ifdef USE_GPS_RESCUE` and `#ifndef USE_WING`, so a build without GPS
 * Rescue - and every wing build - answers MSP_RESULT_CMD_UNKNOWN. A caller
 * must treat "this board does not answer" as an absent capability, not as
 * a failed read.
 */
export const MSP_GPS_RESCUE = 135;
export const MSP_SET_GPS_RESCUE = 225;

/** Betaflight 2025.12.2 / MSP API 1.47 power configuration and meters. */
export const MSP_BATTERY_CONFIG = 32;
export const MSP_SET_BATTERY_CONFIG = 33;
export const MSP_CURRENT_METER_CONFIG = 40;
export const MSP_SET_CURRENT_METER_CONFIG = 41;
export const MSP_VOLTAGE_METER_CONFIG = 56;
export const MSP_SET_VOLTAGE_METER_CONFIG = 57;
export const MSP_VOLTAGE_METERS = 128;
export const MSP_CURRENT_METERS = 129;

/**
 * Blackbox / onboard-logging reads and the one configuration write.
 *
 * Command ids and payload shapes verified at the pinned Betaflight commit
 * 7348054f268f0058574719c134e9f149565bb8ea (API 1.47) and re-checked
 * byte-for-byte against master (API 1.49). API 1.48 has no reachable
 * source and is NOT VERIFIED for this group.
 *
 * MSP_DATAFLASH_ERASE (72) is DELIBERATELY ABSENT. It is a destructive
 * asynchronous operation whose completion is only observable by polling
 * MSP_DATAFLASH_SUMMARY, and it will be declared alongside the controller
 * that owns its lifecycle - not ahead of it, where anything could send it.
 */
export const MSP_DATAFLASH_SUMMARY = 70;
export const MSP_SDCARD_SUMMARY = 79;
export const MSP_BLACKBOX_CONFIG = 80;
export const MSP_SET_BLACKBOX_CONFIG = 81;

/** Betaflight 2025.12.2 / MSP API 1.47 on-screen-display configuration.
 * MSP_OSD_CONFIG returns the complete layout/settings snapshot,
 * MSP_SET_OSD_CONFIG writes one changed group, and MSP_OSD_CANVAS reports
 * the display's character grid. */
export const MSP_OSD_CONFIG = 84;
export const MSP_SET_OSD_CONFIG = 85;
export const MSP_OSD_CANVAS = 189;

/** Betaflight 2025.12.2 / MSP API 1.47 video-transmitter configuration. */
export const MSP_SET_VTX_CONFIG = 89;
export const MSP_VTXTABLE_BAND = 137;
export const MSP_VTXTABLE_POWERLEVEL = 138;
export const MSP_SET_VTXTABLE_BAND = 227;
export const MSP_SET_VTXTABLE_POWERLEVEL = 228;

/** Live sensor samples used by the Sensors workspace. */
export const MSP_RAW_IMU = 102;
export const MSP_ALTITUDE = 109;

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

/**
 * BOARD ALIGNMENT - the mounting angles of the whole flight controller.
 *
 * `#define MSP_BOARD_ALIGNMENT_CONFIG 38` / `MSP_SET_BOARD_ALIGNMENT_CONFIG 39`,
 * matching betaflight-configurator's MSPCodes.js:18-19. Six bytes each
 * way: three little-endian 16-bit values, roll then pitch then yaw, in
 * WHOLE DEGREES over -180..360 (cli/settings.c:995-997).
 *
 * NOT to be confused with MSP_SENSOR_ALIGNMENT (126) /
 * MSP_SET_SENSOR_ALIGNMENT (220), which carry per-sensor orientation
 * ENUMS rather than whole-board angles. Those are declared in the sensor
 * block at the foot of this file; the two names have caused confusion
 * before, so each block names the other explicitly.
 */
export const MSP_BOARD_ALIGNMENT_CONFIG = 38;
export const MSP_SET_BOARD_ALIGNMENT_CONFIG = 39;

/** General configuration groups used by the integrated Configurations area.
 * Values and payload layouts are pinned to Betaflight 2025.12.2 / MSP 1.47.
 * The SET commands are consumed only by the guarded configuration
 * transaction; declaring them here does not create an unguarded write path. */
export const MSP_NAME = 10;
export const MSP_SET_NAME = 11;
export const MSP_RX_CONFIG = 44;
export const MSP_SET_RX_CONFIG = 45;
export const MSP_RSSI_CONFIG = 50;
export const MSP_SET_RSSI_CONFIG = 51;
export const MSP_RX_MAP = 64;
export const MSP_SET_RX_MAP = 65;
export const MSP_ARMING_CONFIG = 61;
export const MSP_SET_ARMING_CONFIG = 62;
export const MSP_BEEPER_CONFIG = 184;
export const MSP_SET_BEEPER_CONFIG = 185;
export const MSP2_GET_TEXT = 0x3006;
export const MSP2_SET_TEXT = 0x3007;

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
export const MSP_RC = 105;

/** Betaflight 2025.12.2 / MSP API 1.47 PID tuning groups. */
export const MSP_RC_TUNING = 111;
export const MSP_PID = 112;
export const MSP_FILTER_CONFIG = 92;
export const MSP_PID_ADVANCED = 94;
export const MSP_SET_FILTER_CONFIG = 93;
export const MSP_SET_PID_ADVANCED = 95;
export const MSP_SET_PID = 202;

/**
 * `#define MSP_SELECT_SETTING 210` - the profile selector, and the ONE
 * command that changes which PID or rate profile the board is running.
 *
 * ONE PAYLOAD BYTE, and the encoding is not symmetric:
 *
 *   PID profile   the zero-based index, sent as-is
 *   RATE profile  the zero-based index OR'd with 0x80
 *
 * Verified in betaflight-configurator's own PidTuningTab.vue:
 *
 *   MSP.promise(MSPCodes.MSP_SELECT_SETTING, [currentProfile.value]);
 *   MSP.promise(MSPCodes.MSP_SELECT_SETTING, [currentRateProfile.value | 128]);
 *
 * The high bit is therefore a DISCRIMINATOR, not part of the index, and
 * an index of 128 or more is not representable - which is also why the
 * count the board reports is validated before anything is sent.
 *
 * NOT a settings write: it selects the active profile and does not need
 * an EEPROM write to take effect. Betaflight re-reads every profile-
 * dependent group afterwards rather than assuming, and so does this app.
 *
 * The 0x80 discriminator itself lives in encoding/encodeSelectSetting.ts,
 * NOT here. Every number in this module is a command id, and a test
 * enforces that they are all distinct - a payload bit-flag sitting among
 * them would collide with MSP_VOLTAGE_METERS (128) and make that
 * invariant meaningless.
 */
export const MSP_SELECT_SETTING = 210;
export const MSP_SET_RC_TUNING = 204;

/** src/main/msp/msp_protocol.h @ BETAFLIGHT_2025_12_2_COMMIT:
 * `#define MSP_MOTOR_3D_CONFIG 124` - msp.c, 6 bytes: three u16 3D
 * tuning values. Present whether or not 3D is enabled - they never
 * determine 3D state. */
export const MSP_MOTOR_3D_CONFIG = 124;
export const MSP_RC_DEADBAND = 125;

/** src/main/msp/msp_protocol.h @ BETAFLIGHT_2025_12_2_COMMIT:
 * `#define MSP_MOTOR_CONFIG 131` - msp.c, 10 bytes. The ONLY authority
 * for motor count. Its first u16 is a removed field hard-coded to 0, not
 * a minimum throttle. */
export const MSP_MOTOR_CONFIG = 131;

/** API-1.47 per-ESC telemetry: u8 count followed by 13 bytes per motor
 * (RPM, invalid %, temperature, voltage, current, consumption). */
export const MSP_MOTOR_TELEMETRY = 139;

/** API-1.47 MSP v2 motor resource ordering. The GET returns u8 count then
 * count physical output indices. The SET accepts the same shape. */
export const MSP2_MOTOR_OUTPUT_REORDERING = 0x3001;
export const MSP2_SET_MOTOR_OUTPUT_REORDERING = 0x3002;
export const MSP2_SEND_DSHOT_COMMAND = 0x3003;

/**
 * Motor-configuration WRITE commands for the API-1.47 transaction.
 *
 * These constants do not authorize a write on their own. The only runtime
 * consumer is the dedicated motor-configuration transaction, which pauses
 * telemetry, proves a fresh disarmed state, rejects an active motor-test
 * lifecycle, captures the canonical session identity, and never retries an
 * ambiguous write automatically.
 *
 * Values and payloads were checked against Betaflight Configurator 2025.12.2
 * (`MSPCodes.js` and `MSPHelper.crunch`) and the matching firmware MSP
 * handlers. Keeping them beside their READ counterparts makes each read / set
 * pair auditable without importing the motor-test command module.
 */
export const MSP_SET_FEATURE_CONFIG = 37;
export const MSP_SET_MIXER_CONFIG = 43;
export const MSP_SET_ADVANCED_CONFIG = 91;
export const MSP_SET_MOTOR_3D_CONFIG = 217;
export const MSP_SET_RC_DEADBAND = 218;
export const MSP_SET_MOTOR_CONFIG = 222;

/** Writes the complete six-byte MSP_GPS_CONFIG payload. */
export const MSP_SET_GPS_CONFIG = 223;

/**
 * Persists previously acknowledged MSP_SET_* values. Unlike accelerometer
 * and magnetometer calibration (which persist internally), a configuration
 * edit is not durable until this command is acknowledged. It is therefore
 * scoped only to MotorConfigurationTransaction; Setup calibration and reboot
 * paths remain forbidden from sending it.
 */
export const MSP_EEPROM_WRITE = 250;

/** Read-only VTX state/table availability used by Ports. */
export const MSP_VTX_CONFIG = 88;

/** Betaflight's versioned MSP v2 serial-port read and write commands. */
export const MSP2_COMMON_SERIAL_CONFIG = 0x1009;
export const MSP2_COMMON_SET_SERIAL_CONFIG = 0x100a;

/* ------------------------------------------------------------------ *
 * SENSORS.
 *
 * Every value below was read out of src/main/msp/msp_protocol.h and
 * src/main/msp/msp_protocol_v2_betaflight.h at the pinned API-1.47
 * firmware revision 7348054f268f0058574719c134e9f149565bb8ea, not copied
 * from a client. Where the reference configurator uses a shortened name
 * for the same opcode, the FIRMWARE name wins here and the divergence is
 * written down beside it, so a future reader never has to guess which of
 * two spellings is the real one.
 *
 * Declaring a constant is not a write path. The SET opcodes below have no
 * caller in this pass: B-1 builds wire codecs only, and the controller
 * that would be allowed to send them does not exist yet.
 * ------------------------------------------------------------------ */

/**
 * CONFIGURED sensor hardware - what the operator asked the board to use.
 *
 * `#define MSP_SENSOR_CONFIG 96` / `MSP_SET_SENSOR_CONFIG 97`.
 *
 * THERE IS NO GYRO BYTE. The firmware's own comment above the handler
 * claims "0:GyroHardware, 1:AccHardware, ..." and the executable code
 * immediately below it writes `accelerometerConfig()->acc_hardware`
 * first. The code is the contract; the comment is stale. Byte 0 is ACC.
 */
export const MSP_SENSOR_CONFIG = 96;
export const MSP_SET_SENSOR_CONFIG = 97;

/**
 * PER-SENSOR ORIENTATION - not the board angles (those are 38/39 above).
 *
 * `#define MSP_SENSOR_ALIGNMENT 126` / `MSP_SET_SENSOR_ALIGNMENT 220`.
 *
 * THE READ AND THE WRITE ARE DIFFERENT SHAPES, and byte 3 changes meaning
 * between them - see decodeSensorAlignment.ts / encodeSensorAlignment.ts.
 * Echoing a read payload back as a write corrupts the gyro enable mask.
 */
export const MSP_SENSOR_ALIGNMENT = 126;
export const MSP_SET_SENSOR_ALIGNMENT = 220;

/**
 * MAGNETIC DECLINATION, and nothing else.
 *
 * `#define MSP_COMPASS_CONFIG 133` / `#define MSP_SET_COMPASS_CONFIG 224`.
 * A single value each way, in tenths of a degree.
 */
export const MSP_COMPASS_CONFIG = 133;
export const MSP_SET_COMPASS_CONFIG = 224;

/**
 * ACCELEROMETER ANGLE TRIM. Note the opcode ordering: the SET is the
 * LOWER number.
 *
 * `#define MSP_SET_ACC_TRIM 239` / `#define MSP_ACC_TRIM 240`.
 */
export const MSP_SET_ACC_TRIM = 239;
export const MSP_ACC_TRIM = 240;

/**
 * DETECTED sensor hardware - what the board actually found at boot. A
 * different question from MSP_SENSOR_CONFIG, and the two disagree often
 * enough that the semantic layer keeps them apart permanently.
 *
 * `#define MSP2_SENSOR_CONFIG_ACTIVE 0x300A`.
 */
export const MSP2_SENSOR_CONFIG_ACTIVE = 0x300a;

/**
 * PER-GYRO detection results on a multi-gyro board.
 *
 * `#define MSP2_GYRO_SENSOR_ACTIVE 0x300D`.
 *
 * NAME DIVERGENCE, deliberate: betaflight-configurator calls this opcode
 * `MSP2_GYRO_SENSOR` (src/js/msp/MSPCodes.js). The firmware name carries
 * the "_ACTIVE" that distinguishes detection from configuration, which is
 * the whole distinction this layer exists to keep, so the firmware name is
 * the one used here.
 */
export const MSP2_GYRO_SENSOR_ACTIVE = 0x300d;

/**
 * `#define MSP_SONAR_ALTITUDE 58   // out message: Get sonar altitude [cm]`
 *
 * NAME DIVERGENCE, deliberate: betaflight-configurator calls this
 * `MSP_SONAR` and annotates it "notice, in firmware named as
 * MSP_SONAR_ALTITUDE" (src/js/msp/MSPCodes.js). The firmware name is used
 * here.
 *
 * DECLARED, NOT DECODED. A rangefinder-free build answers this with a
 * hard-coded `sbufWriteU32(dst, 0)`, so the number alone cannot tell a
 * real zero-centimetre reading from "there is no rangefinder". Reading it
 * without the presence and capability facts beside it would manufacture a
 * measurement, so no decoder is offered for it in this pass.
 */
export const MSP_SONAR_ALTITUDE = 58;

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
/* R2 RELOCATION. The constant itself now lives in the motor-only module
 * `motorTestCommands.ts`, re-exported below for source compatibility.
 *
 * WHY: this file is legitimately part of the Release graph (MSP_STATUS_EX,
 * MSP_RAW_GPS and friends), so an export named `MSP_SET_MOTOR` declared
 * HERE survived into every Release bundle as a property key even after the
 * whole motor engine was excluded. Declaring it in a motor-only module
 * keeps the name out of Release while the VALUE, the command id 214, the
 * encoding, the vectors and every consumer's behaviour stay byte-for-byte
 * identical - nothing was renamed and nothing was split. */
/* Deliberately NOT re-exported here. A re-export is a RUNTIME import: it
 * pulls `motorTestCommands.ts` straight back into the Release graph, which
 * measurably made containment worse (the token count rose from 2 to 4).
 * Consumers import it from `./motorTestCommands` directly. */
