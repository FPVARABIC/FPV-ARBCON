/**
 * THE EIGHT LED STRIP COMMAND IDS, AND NOTHING ELSE.
 *
 * Read from `src/main/msp/msp_protocol.h` and
 * `src/main/msp/msp_protocol_v2_betaflight.h` at the three pinned firmware
 * commits recorded in `../decoding/ledStripWireContract.ts`. All eight
 * handler blocks in `src/main/msp/msp.c` are byte-identical across API 1.47,
 * 1.48 and 1.49, so these ids carry one contract across every version this
 * build understands.
 *
 * NO ALIASES AND NO GUESSES. Betaflight has no LED command beyond these
 * eight. There is no strip-length query, no LED-count query, and no command
 * that reads back a RENDERED colour at any pinned version. Everything the UI
 * eventually needs to know about the strip's effective shape is derived from
 * the bytes these eight return - `state/ledStripTruth.ts` is where that
 * derivation lives, and it is the reason no such command is invented here.
 *
 * WHY A SEPARATE MODULE rather than an addition to `mspCommands.ts`. That
 * file is legitimately part of the Release graph, and the same reasoning
 * already applied to `motorTestCommands.ts` applies here: a subsystem with no
 * consumer yet should not have its identifiers reachable from a module the
 * whole app imports. Declaring them here keeps the LED subsystem out of every
 * bundle until L-C wires a controller to it, and keeps this phase's diff away
 * from a shared file entirely.
 *
 * BUILD GATING IS NOT UNIFORM ACROSS THESE EIGHT, and it matters for the load
 * sequence L-C will write. MSP_LED_STRIP_CONFIG, MSP_SET_LED_STRIP_CONFIG and
 * both MSP2 commands answer under `USE_LED_STRIP`. The palette and
 * mode-colour pairs additionally require `USE_LED_STRIP_STATUS_MODE`; a board
 * without it answers the strip GET with an all-zero array and a zero
 * capability byte, and returns "unknown command" for the other four.
 */

/** GET the sixteen-slot colour palette. Requires status mode. */
export const MSP_LED_COLORS = 46;
/** SET the whole palette in one frame. Requires status mode. */
export const MSP_SET_LED_COLORS = 47;
/** GET the full LED array plus the capability and profile bytes. */
export const MSP_LED_STRIP_CONFIG = 48;
/** SET exactly one LED by index. Five bytes, never six. */
export const MSP_SET_LED_STRIP_CONFIG = 49;
/** GET all forty-eight mode/special/aux tuples. Requires status mode. */
export const MSP_LED_STRIP_MODECOLOR = 127;
/** SET one tuple. There is no bulk form. Requires status mode. */
export const MSP_SET_LED_STRIP_MODECOLOR = 221;

/** MSP v2 function codes - u16 on the wire, not v1 command bytes. */
export const MSP2_GET_LED_STRIP_CONFIG_VALUES = 0x3008;
export const MSP2_SET_LED_STRIP_CONFIG_VALUES = 0x3009;
