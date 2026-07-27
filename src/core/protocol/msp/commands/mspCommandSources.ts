/**
 * Centralized citation for the exact upstream firmware source this pass's
 * (Pass 6.4a Step 0) MSP command values and MSP_BOARD_INFO wire-format
 * understanding were verified against - each a PINNED commit, never
 * `master`/any moving branch or tag, so this record stays accurate even as
 * each upstream project continues to change after this pass.
 *
 * BETAFLIGHT (primary verification - command numbers, MSP_API_VERSION/
 * MSP_FC_VARIANT/MSP_BOARD_INFO wire layout):
 *   Repository: https://github.com/betaflight/betaflight
 *   Pinned commit: 0ccf59553351860fcedbaed952dbf3694f10f768
 *     (was HEAD of `master` at verification time, 2026-07-22)
 *   Files read at that commit:
 *     - src/main/msp/msp_protocol.h
 *         MSP_API_VERSION=1, MSP_FC_VARIANT=2, MSP_BOARD_INFO=4;
 *         MSP_PROTOCOL_VERSION=0, API_VERSION_MAJOR=1, API_VERSION_MINOR=48;
 *         FLIGHT_CONTROLLER_IDENTIFIER_LENGTH=4, BOARD_IDENTIFIER_LENGTH=4.
 *     - src/main/msp/msp.c
 *         The real `case MSP_API_VERSION/MSP_FC_VARIANT/MSP_BOARD_INFO:`
 *         response-encoding blocks inside mspFcProcessOutCommand() - the
 *         actual, current field-by-field wire layout the decoders in
 *         ../decoding mirror. Confirms flightControllerIdentifier =
 *         FC_FIRMWARE_IDENTIFIER.
 *     - src/main/build/version.h
 *         FC_FIRMWARE_IDENTIFIER = "BTFL" (the real 4-byte value sent by
 *         MSP_FC_VARIANT, not assumed).
 *     - src/main/pg/board.h
 *         SIGNATURE_LENGTH=32 (NOT co-located with the other MSP length
 *         constants in msp_protocol.h - required checking three files to
 *         locate).
 *
 * INAV (secondary verification - MSP_FC_VARIANT family identifier only):
 *   Repository: https://github.com/iNavFlight/inav
 *   Pinned commit: c5c593d71d33c8e284bf9cd34381588fda7a98c8
 *     (was HEAD of `master` at verification time, 2026-07-22)
 *   File read at that commit:
 *     - src/main/msp/msp_protocol.h -> INAV_IDENTIFIER = "INAV"
 *
 * EMUFLIGHT (secondary verification - MSP_FC_VARIANT family identifier
 * only):
 *   Repository: https://github.com/emuflight/EmuFlight
 *   Pinned commit: 0a569000b9dfa5b6d8f807bd2e56b634027d84cd
 *     (was HEAD of `master` at verification time, 2026-07-22)
 *   Files read at that commit:
 *     - src/main/interface/msp_protocol.h -> BUTTERFLIGHT_IDENTIFIER = "EMUF"
 *         (EmuFlight's MSP files live under src/main/interface/, a
 *         genuinely different layout from Betaflight's src/main/msp/ -
 *         found only by browsing the repository tree, not guessed.)
 *     - src/main/interface/msp.c
 *         Confirms flightControllerIdentifier = BUTTERFLIGHT_IDENTIFIER,
 *         i.e. this constant is actually sent on the wire, not dead code.
 *
 * IMPORTANT, VERIFIED FINDING (Step 0): the "Added in API version X.Y"
 * comments throughout msp.c's MSP_BOARD_INFO case are historical/
 * documentation notes about when Betaflight's OWN codebase added each
 * field over successive releases - they are NOT runtime
 * `if (apiVersion >= ...)` conditionals. Current firmware writes every
 * field unconditionally; a field is only actually absent on the wire when
 * talking to an older COMPILED firmware build that predates that field's
 * addition. A decoder can only detect that by how many bytes actually
 * arrived, never by cross-referencing a separately-fetched API version
 * number - see decodeBoardInfo.ts's own doc comment for how this is
 * handled.
 *
 * MSP_ATTITUDE (Pass 7.0 - hardware polling-capacity audit measurement
 * harness): verified against the SAME BETAFLIGHT_PINNED_COMMIT above (no
 * separate/newer pin needed - the command definition and encoding were
 * both read at that exact commit, same as everything else in this file).
 *   Files read at that commit:
 *     - src/main/msp/msp_protocol.h
 *         `#define MSP_ATTITUDE 108  // out message: 2 angles 1 heading`
 *     - src/main/msp/msp.c, the real `case MSP_ATTITUDE:` block inside
 *       mspProcessOutCommand() - verbatim:
 *         sbufWriteU16(dst, attitude.values.roll);
 *         sbufWriteU16(dst, attitude.values.pitch);
 *         sbufWriteU16(dst, DECIDEGREES_TO_DEGREES(attitude.values.yaw));
 *       Unconditionally 6 bytes total - no "Added in API version" comment
 *       or `if (apiVersion >= ...)` conditional anywhere near this case,
 *       unlike MSP_BOARD_INFO's fields; this command has no version-gating
 *       history to account for at all.
 *     - src/main/flight/imu.h
 *         attitudeEulerAngles_t's `values` struct declares roll/pitch/yaw
 *         as signed `int16_t`, in DECIDEGREES (comment: "eg
 *         attitude.values.yaw 180 deg = 1800").
 *     - src/main/common/maths.h
 *         `#define DECIDEGREES_TO_DEGREES(angle) ((angle) / 10)` - plain
 *         integer division by 10.
 *     - src/main/flight/imu.c
 *         `if (attitude.values.yaw < 0) { attitude.values.yaw += 3600; }`
 *         - yaw is normalized to [0, 3600) decidegrees before the case
 *         block's /10 conversion, so it is always non-negative (0-359) on
 *         the wire in practice, despite being declared int16_t.
 *   VERIFIED FINDING, NOT ASSUMED FROM MEMORY: roll and pitch are NOT the
 *   same unit as yaw on the wire. roll/pitch are sent as their raw signed
 *   int16_t decidegree value (0.1 degree units) - sbufWriteU16 is only the
 *   byte-writing primitive's name, not a claim the value is unsigned; a
 *   decoder must treat them as signed since bank/pitch angle can be either
 *   direction. yaw, in contrast, is converted to WHOLE DEGREES
 *   (DECIDEGREES_TO_DEGREES) before being written, and is functionally
 *   always non-negative given the imu.c normalization above - a
 *   fundamentally different unit from roll/pitch, not merely a different
 *   sign convention. See decodeAttitude.ts's own doc comment.
 *
 * MSP_BATTERY_STATE (Pass 7.6a - battery telemetry foundation): verified
 * against the SAME BETAFLIGHT_PINNED_COMMIT above.
 *   Files read at that commit:
 *     - src/main/msp/msp_protocol.h:197
 *         `#define MSP_BATTERY_STATE 130  // out message: Connected/
 *         Disconnected, Voltage, Current Used`
 *     - src/main/msp/msp.c:818-833, the real `case MSP_BATTERY_STATE:`
 *       block - exactly 11 bytes, in order:
 *         sbufWriteU8(getBatteryCellCount())   // "0 indicates battery not detected."
 *         sbufWriteU16(batteryCapacity)        // CONFIGURED capacity, mAh
 *         sbufWriteU8(getLegacyBatteryVoltage()) // 0.1V steps, saturates at 25.5V
 *         sbufWriteU16(getMAhDrawn())          // consumed, mAh
 *         sbufWriteU16((int16_t)getAmperage()) // SIGNED int16, 0.01A steps,
 *                                              // "range is -320A to 320A"
 *         sbufWriteU8(getBatteryState())       // batteryState_e enum
 *         sbufWriteU16(getBatteryVoltage())    // 0.01V steps - the canonical field
 *     - src/main/sensors/battery.h:99-105
 *         batteryState_e: BATTERY_OK=0, BATTERY_WARNING=1,
 *         BATTERY_CRITICAL=2, BATTERY_NOT_PRESENT=3, BATTERY_INIT=4.
 *     - src/main/sensors/battery.c
 *         getBatteryCellCount()/getBatteryVoltage()/getLegacyBatteryVoltage()/
 *         getAmperage()/getMAhDrawn() - the wire carries NO current-meter-
 *         presence flag, so a raw 0.00A cannot be distinguished from a
 *         disabled/absent current sensor by this command alone (see
 *         batteryTelemetry.ts's SENSOR_VALIDITY semantics).
 *   CROSS-VERSION GUARANTEE (this app accepts MSP API >= 1.42 only, see
 *   mspCompatibility.ts): the identical 11-byte layout INCLUDING the
 *   trailing 0.01V uint16 was additionally verified at release tags
 *   4.1.0 (commit c37a7c91a24d2828e0824225a52851bd0cfa40a6, msp_protocol.h
 *   API_VERSION 1.42, msp.c:658-673) and 4.2.11 (commit
 *   948ba6339766851806d7637370829ea0ff74c690, API 1.43, msp.c:730-745) -
 *   every accepted Betaflight API version emits all 11 bytes; no accepted
 *   version has a shorter payload. Betaflight-only: INAV/EmuFlight also
 *   define command 130 but their payload contracts were deliberately NOT
 *   verified or adopted in this pass - the battery poll is gated to
 *   identified BETAFLIGHT sessions (see MspSessionCoordinator.ts).
 *
 * PASS 7.6c CLOSURE CORRECTION - auxiliary Region 3 telemetry
 * (MSP_ANALOG, MSP_RAW_GPS, MSP_STATUS_EX): every layout below was
 * verified DIRECTLY against an immutable Betaflight source revision that
 * itself declares MSP API 1.47 - the API version the bench flight
 * controller reports:
 *
 *   PRIMARY AUTHORITY (BETAFLIGHT_API147_COMMIT below): release tag
 *   2025.12.5 of the 2025.12.x release family = commit
 *   7348054f268f0058574719c134e9f149565bb8ea, whose
 *   src/main/msp/msp_protocol.h declares API_VERSION_MAJOR 1 /
 *   API_VERSION_MINOR 47 at lines 61-62. Immutable permalink form:
 *   https://github.com/betaflight/betaflight/blob/7348054f268f0058574719c134e9f149565bb8ea/src/main/msp/msp.c
 *
 *   BENCH-BUILD QUALIFICATION (honest scope): the app's identification
 *   records only the FC variant ("BTFL"), the MSP API version (1.47 on
 *   the bench), and MSP_BOARD_INFO - it never requests MSP_FC_VERSION or
 *   MSP_BUILD_INFO, so the bench's exact patch version / build date /
 *   Git revision are UNKNOWN and the exact bench build could not be
 *   resolved to a public commit. The pinned 2025.12.5 source is
 *   therefore the PUBLIC API-1.47 CONTRACT AUTHORITY; exact-bench-build
 *   compatibility remains HARDWARE-PENDING and is deliberately not
 *   claimed. Matching layouts at OTHER API versions (1.46 release 4.5.5
 *   commit 4adbd3ef7cb546947600e5f747bd5453c9573063, and 1.48 at
 *   BETAFLIGHT_PINNED_COMMIT) were ALSO read, but strictly as SECONDARY
 *   REGRESSION COMPARISONS - agreement at surrounding versions is NOT
 *   proof of an intermediate revision and is not presented as such.
 *
 * MSP_ANALOG (110 - msp_protocol.h:181) - msp.c:764-770 @ 2025.12.5 -
 * exactly 9 mandatory little-endian bytes, in order:
 *     sbufWriteU8(constrain(getLegacyBatteryVoltage(), 0, 255))
 *                                       // 0.1V steps, saturates at 25.5V
 *     sbufWriteU16(constrain(getMAhDrawn(), 0, 0xFFFF))  // consumed mAh
 *     sbufWriteU16(getRssi())           // UNSIGNED, 0..1023 -
 *                                       // RSSI_MAX_VALUE, rx/rx.h:188 @
 *                                       // 2025.12.5. RSSI, NOT link
 *                                       // quality; not dBm.
 *     sbufWriteU16((int16_t)constrain(getAmperage(), -0x8000, 0x7FFF))
 *                                       // SIGNED two's complement,
 *                                       // 0.01A ("range is -320A to 320A")
 *     sbufWriteU16(getBatteryVoltage()) // UNSIGNED, 0.01V
 *   Trailing bytes beyond 9: none emitted at 2025.12.5; the decoder
 *   still ignores any (forward compatibility). Sentinel/availability
 *   caveat verified from the same source: the wire carries NO
 *   "RSSI source configured" flag - a raw 0 cannot be distinguished from
 *   an unconfigured source by this command alone (see
 *   auxTelemetrySemantics.ts's NOT_DISTINGUISHABLE policy). Command
 *   support (a response arrives) never proves a live receiver link.
 *
 * MSP_RAW_GPS (106 - msp_protocol.h:177) - msp.c:1511-1521 @ 2025.12.5 -
 * 16 mandatory little-endian bytes, then one trailing field:
 *     sbufWriteU8(STATE(GPS_FIX))       // RAW stateFlags bit: GPS_FIX =
 *                                       // (1 << 1) = 2, fc/runtime_config.h:121
 *                                       // @ 2025.12.5 - the byte is 0 or
 *                                       // 2, NEVER assume 1; decode as
 *                                       // `!== 0`. A generic fix flag -
 *                                       // no 2D/3D distinction exists on
 *                                       // this wire.
 *     sbufWriteU8(gpsSol.numSat)        // u8, 0..255 verbatim
 *     sbufWriteU32(lat) / sbufWriteU32(lon)  // decoded past for
 *                                       // structural integrity, NEVER
 *                                       // retained - privacy enforced by
 *                                       // model shape (decodeRawGps.ts).
 *     sbufWriteU16(constrain(altCm / 100, 0, UINT16_MAX)) // meters
 *     sbufWriteU16(groundSpeed) / sbufWriteU16(groundCourse)
 *     sbufWriteU16(gpsSol.dop.pdop)     // trailing - the "Added in API
 *                                       // version 1.44" comment is
 *                                       // historical documentation, not
 *                                       // a runtime conditional; at
 *                                       // API 1.47 it is always emitted,
 *                                       // and the decoder ignores it.
 *   Availability caveat: a valid response with numSat 0 / fix 0 means
 *   "GPS present, no fix" only when presence is separately proven (the
 *   MSP_STATUS_EX sensor bit); the response alone proves only command
 *   support.
 *
 * MSP_STATUS_EX (150 - msp_protocol.h:217) - msp.c:1094-1110 @ 2025.12.5
 * - only the FIXED 13-byte little-endian prefix is consumed:
 *     u16 getTaskDeltaTimeUs(TASK_PID)  // cycle time, microseconds
 *     u16 i2cGetErrorCounter()          // CUMULATIVE since boot; builds
 *                                       // without USE_I2C emit a
 *                                       // CONSTANT 0 (verified sentinel:
 *                                       // 0 can mean "no i2c support
 *                                       // compiled in", never proof of a
 *                                       // healthy bus)
 *     u16 sensor-presence mask          // ACC=1, BARO=2<<0... exactly:
 *                                       // ACC | BARO<<1 | MAG<<2 |
 *                                       // GPS<<3 | RANGEFINDER<<4 |
 *                                       // GYRO<<5 | OPTICALFLOW<<6 -
 *                                       // GPS bit = 8; a set bit means
 *                                       // DETECTED, never "healthy"
 *     u32 flightModeFlags (low 32)      // skipped, not consumed
 *     u8  getCurrentPidProfileIndex()   // skipped, not consumed
 *     u16 constrain(getAverageSystemLoadPercent(), 0, LOAD_PERCENTAGE_ONE)
 *                                       // 0..100 (fc/core.h @ 2025.12.5)
 *   Everything past offset 12 (PID_PROFILE_COUNT, rate profile index,
 *   the variable-length flight-mode tail, arming-disable flags, config
 *   state) is version-variable trailing data and is deliberately
 *   ignored.
  */

export const BETAFLIGHT_SOURCE_REPO = 'https://github.com/betaflight/betaflight';
export const BETAFLIGHT_PINNED_COMMIT = '0ccf59553351860fcedbaed952dbf3694f10f768';

/** Pass 7.6c closure: the immutable commit of release tag 2025.12.5 -
 * the DIRECT public authority for the MSP API 1.47 contract (its
 * msp_protocol.h declares API_VERSION_MINOR 47). Resolved via
 * `git ls-remote refs/tags/2025.12.5` and audited at this exact SHA. */
export const BETAFLIGHT_API147_COMMIT = '7348054f268f0058574719c134e9f149565bb8ea';

/**
 * Motor read-capability pass: the immutable commit of release tag
 * 2025.12.2 - the exact firmware the bench flight controller reports, and
 * therefore the authority every motor-related schema in this codebase is
 * verified against. Resolved via
 * `git ls-remote --tags https://github.com/betaflight/betaflight 2025.12.2`
 * -> 79065c96ba0bb5cdc675e67d7093e05dab8b330e, and every line cited below
 * was read at that SHA (not at the tag name, which is a movable ref).
 *
 * WHY A SECOND API-1.47 CONSTANT RATHER THAN REUSING BETAFLIGHT_API147_COMMIT.
 * 2025.12.5 (above) and 2025.12.2 are different releases of the same
 * 2025.12.x family; both declare API_VERSION_MAJOR 1 / API_VERSION_MINOR
 * 47. The existing constant is left completely untouched so no previously
 * audited citation silently changes its authority. For the six commands
 * this pass decodes, the two releases were compared directly and every
 * encoder block is BYTE-IDENTICAL between them - so the pre-existing
 * decoders keep their own pinned authority and this pass gains a
 * verifiable one, with no contradiction between the two.
 */
export const BETAFLIGHT_2025_12_2_COMMIT = '79065c96ba0bb5cdc675e67d7093e05dab8b330e';

export const INAV_SOURCE_REPO = 'https://github.com/iNavFlight/inav';
export const INAV_PINNED_COMMIT = 'c5c593d71d33c8e284bf9cd34381588fda7a98c8';

export const EMUFLIGHT_SOURCE_REPO = 'https://github.com/emuflight/EmuFlight';
export const EMUFLIGHT_PINNED_COMMIT = '0a569000b9dfa5b6d8f807bd2e56b634027d84cd';

/**
 * ==========================================================================
 * PASS 7.7, REGION 5 - FC-TOOL WRITE CONTRACT AND PERSISTENCE AUDIT
 * ==========================================================================
 * Every line below was read at BETAFLIGHT_API147_COMMIT
 * (7348054f268f0058574719c134e9f149565bb8ea, release tag 2025.12.5,
 * whose src/main/msp/msp_protocol.h:61-62 declares API_VERSION_MAJOR 1 /
 * API_VERSION_MINOR 47). No master, no neighbouring release, no
 * "sandwich" inference, no Configurator-derived behavior.
 *
 * 1. MSP_ACC_CALIBRATION (205)
 *    Request payload: NONE.
 *    Handler (src/main/msp/msp.c:3313-3317, inside mspProcessInCommand):
 *      case MSP_ACC_CALIBRATION:
 *          if (!ARMING_FLAG(ARMED))
 *              accStartCalibration();
 *          break;
 *    Response: mspProcessInCommand returns MSP_RESULT_ACK - an EMPTY ack
 *    frame - and it does so even when ARMED, in which case the guard
 *    skipped the call entirely and nothing was started. Therefore an ack
 *    proves ONLY that the command was received and parsed.
 *    accStartCalibration() (src/main/sensors/acceleration_init.c:388-391)
 *    merely sets `accelerationRuntime.calibratingA = CALIBRATING_ACC_CYCLES`;
 *    the calibration itself runs over subsequent gyro/acc task cycles.
 *    PERSISTENCE: performed BY THE FIRMWARE on the final cycle -
 *    acceleration_init.c:435-437 calls setConfigCalibrationCompleted()
 *    and then saveConfigAndNotify(). No MSP_EEPROM_WRITE and no CLI is
 *    required from this app, so the operation is offerable.
 *
 * 2. MSP_MAG_CALIBRATION (206)
 *    Request payload: NONE.
 *    Handler (src/main/msp/msp.c:3319-3326):
 *      case MSP_MAG_CALIBRATION:
 *          if (!ARMING_FLAG(ARMED)) {
 *              compassStartCalibration();
 *          }
 *    Response: MSP_RESULT_ACK, with the same armed-guard caveat as above.
 *    compassStartCalibration() (src/main/sensors/compass.c:407-416) starts
 *    a TIME-LIMITED process, and the limits are source-proven, not
 *    invented: CALIBRATION_WAIT_US = 15s (compass.c:79) to begin moving
 *    the craft, then CALIBRATION_TIME_US = 30s (compass.c:82) of movement
 *    once motion is detected (compass.c:478-479).
 *    PERSISTENCE: performed BY THE FIRMWARE - compass.c:490-496 writes the
 *    new magZero values and calls saveConfigAndNotify(); if no movement
 *    was detected it beeps a failure and saves NOTHING (compass.c:497-499).
 *    No MSP_EEPROM_WRITE and no CLI is required, so the operation is
 *    offerable - but the FC never reports progress or completion over
 *    MSP, so this app must not display either.
 *
 * 3. MSP_REBOOT (68)
 *    Request payload: OPTIONAL u8 reboot mode. msp.c:2342-2357 reads it
 *    only `if (sbufBytesRemaining(src))`, rejects a mode >= MSP_REBOOT_COUNT
 *    (and MSC modes on builds without USE_USB_MSC) with MSP_RESULT_ERROR,
 *    and otherwise defaults to `rebootMode = MSP_REBOOT_FIRMWARE` (0) when
 *    the payload is EMPTY. This app sends an empty payload, so a normal
 *    firmware reboot is the only mode it can ever request.
 *    Response: the accepted mode is echoed back (sbufWriteU8(dst,
 *    rebootMode)), and the actual reboot happens afterwards through
 *    mspPostProcessFn = mspRebootFn. The link therefore drops immediately
 *    after (or racing with) the ack: a MISSING ack does not prove the
 *    reboot failed, and the app must never resend it automatically.
 *
 * 4. MSP_EEPROM_WRITE (250) remains PROHIBITED by this project. Neither
 *    calibration needs it (both persist FC-side, as recorded above), so
 *    nothing in Region 5 sends it.
 */

/**
 * ==========================================================================
 * MOTOR READ-CAPABILITY PASS - THE SIX READ-ONLY MOTOR/MIXER COMMANDS
 * ==========================================================================
 * Every line below was read at BETAFLIGHT_2025_12_2_COMMIT
 * (79065c96ba0bb5cdc675e67d7093e05dab8b330e, release tag 2025.12.2,
 * whose src/main/msp/msp_protocol.h:61-62 declares API_VERSION_MAJOR 1 /
 * API_VERSION_MINOR 47 - the bench firmware's own reported API).
 *
 * SCOPE, STATED ONCE: every command here is an OUT (read) message. No
 * write/set motor command is defined, encoded or exported anywhere in
 * this pass - deliberately, because sending motor values is a separate,
 * safety-critical decision that has not been taken. In particular
 * MSP_SET_MOTOR (214) is NOT defined here even though it was read during
 * the audit.
 *
 * MSP_FEATURE_CONFIG (36 - msp_protocol.h) - msp.c:784-786 @ 2025.12.2 -
 * 4 bytes:
 *   sbufWriteU32(dst, featureConfig()->enabledFeatures);
 *   FEATURE_3D is bit 12 (src/main/config/feature.h:56,
 *   `FEATURE_3D = 1 << 12`). The mask is genuinely UNSIGNED 32-bit; bit
 *   31 is a legal set bit and must survive decoding as a positive
 *   number, which is why the reader's readU32LE() (>>> 0) is used.
 *
 * MSP_MIXER_CONFIG (42 - msp_protocol.h) - msp.c @ 2025.12.2 - 2 bytes:
 *   sbufWriteU8(dst, mixerConfig()->mixerMode);
 *   sbufWriteU8(dst, mixerConfig()->yaw_motors_reversed);
 *   mixerMode is mixerMode_e (src/main/flight/mixer.h): MIXER_TRI = 1,
 *   MIXER_QUADX = 3, ... MIXER_CUSTOM = 23, MIXER_QUADX_1234 = 26.
 *   MIXER_QUADX and MIXER_QUADX_1234 are DISTINCT mixers with different
 *   motor-output ordering - one may never be treated as the other.
 *   yaw_motors_reversed is FC CONFIGURATION. mixer.c uses it only to flip
 *   the sign of the yaw PID term
 *   (`if (!mixerConfig()->yaw_motors_reversed) { scaledAxisPidYaw =
 *   -scaledAxisPidYaw; }`); it does NOT remap outputs to positions and is
 *   NOT proof of any physical propeller rotation direction.
 *
 * MSP_ADVANCED_CONFIG (90 - msp_protocol.h) - msp.c:1846-1864 @ 2025.12.2
 * - 20 bytes, in this exact order:
 *   sbufWriteU8 (1)                                  // was gyro_sync_denom, removed in API 1.43
 *   sbufWriteU8 (pidConfig()->pid_process_denom)
 *   sbufWriteU8 (motorConfig()->dev.useContinuousUpdate)
 *   sbufWriteU8 (motorConfig()->dev.motorProtocol)
 *   sbufWriteU16(motorConfig()->dev.motorPwmRate)
 *   sbufWriteU16(motorConfig()->motorIdle)
 *   sbufWriteU8 (0)                                  // DEPRECATED: gyro_use_32kHz
 *   sbufWriteU8 (motorConfig()->dev.motorInversion)
 *   sbufWriteU8 (0)                                  // deprecated gyro_to_use
 *   sbufWriteU8 (gyroConfig()->gyro_high_fsr)
 *   sbufWriteU8 (gyroConfig()->gyroMovementCalibrationThreshold)
 *   sbufWriteU16(gyroConfig()->gyroCalibrationDuration)
 *   sbufWriteU16(gyroConfig()->gyro_offset_yaw)
 *   sbufWriteU8 (gyroConfig()->checkOverflow)
 *   sbufWriteU8 (systemConfig()->debug_mode)         // added in MSP API 1.42
 *   sbufWriteU8 (DEBUG_COUNT)
 *
 *   gyro_offset_yaw IS SIGNED. src/main/sensors/gyro.h:164 declares
 *   `int16_t gyro_offset_yaw;` - sbufWriteU16 is only the byte-writing
 *   primitive's name, exactly the MSP_ATTITUDE/MSP_BATTERY_STATE lesson
 *   already recorded in this file. It is therefore read with readS16LE().
 *
 *   motorProtocol is motorProtocolTypes_e
 *   (src/main/drivers/motor_types.h @ 2025.12.2), by declaration order:
 *     0 PWM, 1 ONESHOT125, 2 ONESHOT42, 3 MULTISHOT, 4 BRUSHED,
 *     5 DSHOT150, 6 DSHOT300, 7 DSHOT600,
 *     (DSHOT1200 is REMOVED at this tag - the enum comment says so
 *      explicitly, which is why 8 is PROSHOT1000 and not DSHOT1200)
 *     8 PROSHOT1000, 9 DISABLED, 10 MAX.
 *   So raw 7 == DSHOT600 AT THIS TAG. The value is version-sensitive and
 *   is therefore stored raw; any name is a local interpretation, never a
 *   claim about an "official" identifier.
 *
 *   motorIdle is stored in hundredths of a percent: raw 550 == 5.5%.
 *   IT IS NOT A PULSE VALUE AND NO PULSE MAY BE DERIVED FROM IT.
 *   dshotInitEndpoints() uses motorIdle only to compute the ARMED
 *   throttle curve's lower endpoint; dshotConvertFromExternal() - the
 *   function an MSP motor value would actually pass through - does not
 *   reference motorIdle at all.
 *
 *   motorInversion is electrical output-signal inversion
 *   (motorConfig()->dev.motorInversion). It is NOT props-out
 *   configuration and NOT physical CW/CCW rotation.
 *
 * MSP_MOTOR (104 - msp_protocol.h) - msp.c:1198-1211 @ 2025.12.2 -
 * 16 bytes:
 *   for (unsigned i = 0; i < 8; i++) {
 *       if (!motorIsEnabled() || i >= MAX_SUPPORTED_MOTORS || !motorIsMotorEnabled(i)) {
 *           sbufWriteU16(dst, 0);
 *           continue;
 *       }
 *       sbufWriteU16(dst, motorConvertToExternal(motor[i]));
 *   }
 *   ALWAYS exactly 8 values regardless of the airframe's motor count; a
 *   disabled/absent output writes 0. Zero is therefore a legal value and
 *   the number of non-zero entries is NOT a motor count - the only
 *   authority for motor count is MSP_MOTOR_CONFIG's own field.
 *   These are DYNAMIC FC-side output values, not configuration, and not
 *   proof of physical motion or of physical stop.
 *
 * MSP_MOTOR_3D_CONFIG (124 - msp_protocol.h) - msp.c @ 2025.12.2 -
 * 6 bytes:
 *   sbufWriteU16(dst, flight3DConfig()->deadband3d_low);
 *   sbufWriteU16(dst, flight3DConfig()->deadband3d_high);
 *   sbufWriteU16(dst, flight3DConfig()->neutral3d);
 *   These are 3D TUNING values and are present whether or not 3D is
 *   enabled. Whether 3D is active is decided ONLY by FEATURE_3D in
 *   MSP_FEATURE_CONFIG - never inferred from these numbers.
 *
 * MSP_MOTOR_CONFIG (131 - msp_protocol.h) - msp.c @ 2025.12.2 -
 * 10 bytes:
 *   sbufWriteU16(dst, 0);                            // was minthrottle until after 4.5
 *   sbufWriteU16(dst, motorConfig()->maxthrottle);
 *   sbufWriteU16(dst, motorConfig()->mincommand);
 *   sbufWriteU8 (getMotorCount());
 *   sbufWriteU8 (motorConfig()->motorPoleCount);
 *   sbufWriteU8 (useDshotTelemetry);                 // 0 when built without USE_DSHOT_TELEMETRY
 *   sbufWriteU8 (featureIsEnabled(FEATURE_ESC_SENSOR)); // 0 when built without USE_ESC_SENSOR
 *   The first field is a REMOVED value hard-coded to 0 - it is not a
 *   minimum throttle and must never be used as one. The DShot-telemetry
 *   byte is the raw firmware state; a 0 can mean either "disabled" or
 *   "not compiled in", so it is stored raw and interpreted nowhere here.
 */
