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
