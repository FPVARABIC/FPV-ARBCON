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
 * PASS 7.6c (auxiliary Region 3 telemetry: MSP_ANALOG, MSP_RAW_GPS,
 * MSP_STATUS_EX, and the one-shot MSP_BATTERY_CONFIG) - VERIFICATION
 * STRATEGY: every layout below was read at TWO fixed points and found
 * IDENTICAL for all consumed fields:
 *   (a) BETAFLIGHT_PINNED_COMMIT above (master, API_VERSION 1.48), and
 *   (b) release tag 4.5.5 = commit 4adbd3ef7cb546947600e5f747bd5453c9573063
 *       (msp_protocol.h API_VERSION 1.46 - 4.5.x is the latest release
 *       line; a 4.6.0 tag does not exist upstream).
 * The bench flight controller reports API 1.47, strictly between the two
 * verified endpoints, so its layouts for these commands necessarily
 * match. All four commands are Betaflight-gated exactly like
 * MSP_BATTERY_STATE.
 *
 * MSP_ANALOG (110) - msp.c:786-792 @ pin, msp.c:757-763 @ 4.5.5 -
 * exactly 9 mandatory bytes, in order:
 *     sbufWriteU8(...getLegacyBatteryVoltage...)   // 0.1V, saturates 25.5V
 *     sbufWriteU16(getMAhDrawn())                  // consumed mAh
 *     sbufWriteU16(getRssi())                      // 0..1023 - RSSI_MAX_VALUE,
 *                                                  // rx/rx.h:193 @ pin. RSSI,
 *                                                  // NOT link quality.
 *     sbufWriteU16((int16_t)getAmperage())         // SIGNED, 0.01A
 *     sbufWriteU16(getBatteryVoltage())            // 0.01V
 *   The wire carries NO RSSI-source-configured flag: a raw 0 cannot be
 *   distinguished from "no RSSI source configured" by this command alone
 *   (see auxTelemetrySemantics.ts's NOT_DISTINGUISHABLE policy). Only the
 *   RSSI field feeds the Receiver card; the duplicate battery fields
 *   never replace the verified MSP_BATTERY_STATE channel.
 *
 * MSP_RAW_GPS (106) - msp.c:1569-1579 @ pin, msp.c:1508-1518 @ 4.5.5 -
 * 16 mandatory bytes, in order:
 *     sbufWriteU8(STATE(GPS_FIX))       // RAW stateFlags bit: GPS_FIX =
 *                                       // (1 << 1) = 2, fc/runtime_config.h:124
 *                                       // @ pin - the byte is 0 or 2, NEVER
 *                                       // assume 1; decode as `!== 0`. A
 *                                       // generic fix flag - no 2D/3D
 *                                       // distinction exists on this wire.
 *     sbufWriteU8(gpsSol.numSat)
 *     sbufWriteU32(lat) / sbufWriteU32(lon)  // decoded past for structural
 *                                       // integrity, NEVER retained -
 *                                       // privacy enforced by model shape
 *                                       // (decodeRawGps.ts).
 *     sbufWriteU16(altitude) / sbufWriteU16(groundSpeed) / sbufWriteU16(groundCourse)
 *   Trailing u16 pdop: "Added in API version 1.44" - historical note, and
 *   the app's minimum accepted API is 1.42, so it is treated as optional
 *   trailing data and ignored.
 *
 * MSP_STATUS_EX (150) - msp.c:1131-1147 @ pin, msp.c:1080-1096 @ 4.5.5 -
 * only the fixed 13-byte prefix is consumed:
 *     u16 cycle time (us); u16 i2c error counter (CUMULATIVE since boot);
 *     u16 sensor-presence mask (ACC=1, BARO=2, MAG=4, GPS=8,
 *     RANGEFINDER=16, GYRO=32; the pin adds OPTICALFLOW=64 - an ADDITIVE
 *     bit, prefix layout unchanged; a set bit means DETECTED, never
 *     "healthy"); u32 flight mode flags (skipped); u8 pid profile index
 *     (skipped); u16 average system load percent, constrained
 *     0..LOAD_PERCENTAGE_ONE=100 (fc/core.h:33 @ pin).
 *   Everything past offset 12 is version-variable tail and ignored
 *   (decodeStatusEx.ts).
 *
 * MSP_BATTERY_CONFIG (32) - msp.c:926-936 @ pin, msp.c:898-908 @ 4.5.5 -
 * 7 mandatory bytes (+ 3x u16 high-resolution trailing, ignored):
 *     u8 min/max/warning cell voltage (0.1V); u16 CONFIGURED capacity mAh
 *     (CLI `bat_capacity`, u16, range 0..20000 - cli/settings.c:996 @
 *     pin); u8 voltageMeterSource; u8 currentMeterSource -
 *     currentMeterSource_e, sensors/current.h:26-33 @ pin: NONE=0, ADC=1,
 *     VIRTUAL=2, ESC=3, MSP=4.
 *   ONE-SHOT read per session, never polled - consumed exclusively by the
 *   charge-estimate prerequisites (batteryChargeEstimate.ts).
 */

export const BETAFLIGHT_SOURCE_REPO = 'https://github.com/betaflight/betaflight';
export const BETAFLIGHT_PINNED_COMMIT = '0ccf59553351860fcedbaed952dbf3694f10f768';

export const INAV_SOURCE_REPO = 'https://github.com/iNavFlight/inav';
export const INAV_PINNED_COMMIT = 'c5c593d71d33c8e284bf9cd34381588fda7a98c8';

export const EMUFLIGHT_SOURCE_REPO = 'https://github.com/emuflight/EmuFlight';
export const EMUFLIGHT_PINNED_COMMIT = '0a569000b9dfa5b6d8f807bd2e56b634027d84cd';
