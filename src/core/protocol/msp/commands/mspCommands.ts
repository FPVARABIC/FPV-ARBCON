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

/** src/main/msp/msp_protocol.h:104 @ BETAFLIGHT_PINNED_COMMIT (Pass 7.6c):
 * `#define MSP_BATTERY_CONFIG 32  // out message: Get battery configuration`
 * - one-shot read only (never polled); see mspCommandSources.ts. */
export const MSP_BATTERY_CONFIG = 32;

/** src/main/msp/msp_protocol.h:177 @ BETAFLIGHT_PINNED_COMMIT (Pass 7.6c):
 * `#define MSP_RAW_GPS 106  // out message: Fix, numsat, lat, lon, alt,
 * speed, ground course` - only fix + numsat are consumed; coordinates are
 * never retained (decodeRawGps.ts). */
export const MSP_RAW_GPS = 106;

/** src/main/msp/msp_protocol.h:181 @ BETAFLIGHT_PINNED_COMMIT (Pass 7.6c):
 * `#define MSP_ANALOG 110  // out message: Vbat, powermetersum, rssi if
 * available on RX` - only the RSSI field is consumed (decodeAnalog.ts);
 * its duplicate battery fields never replace MSP_BATTERY_STATE. */
export const MSP_ANALOG = 110;

/** src/main/msp/msp_protocol.h:217 @ BETAFLIGHT_PINNED_COMMIT (Pass 7.6c):
 * `#define MSP_STATUS_EX 150  // out message: Cycletime, errors_count,
 * CPU load, sensor present etc` - fixed 13-byte prefix only is consumed
 * (decodeStatusEx.ts). */
export const MSP_STATUS_EX = 150;
