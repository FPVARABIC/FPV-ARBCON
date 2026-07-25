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

export const INAV_SOURCE_REPO = 'https://github.com/iNavFlight/inav';
export const INAV_PINNED_COMMIT = 'c5c593d71d33c8e284bf9cd34381588fda7a98c8';

export const EMUFLIGHT_SOURCE_REPO = 'https://github.com/emuflight/EmuFlight';
export const EMUFLIGHT_PINNED_COMMIT = '0a569000b9dfa5b6d8f807bd2e56b634027d84cd';
