/**
 * THE PID PAGE'S PROFILE AND SIMPLIFIED-TUNING COMMAND IDS.
 *
 * Kept out of the general command module on purpose. Three of these are
 * genuinely dangerous - one rewrites a whole profile, one resets a profile
 * to factory defaults, one regenerates a tune from sliders - and the
 * production-bundle boundary this project already enforces is easier to hold
 * when the dangerous ids live in a module the reviewed controller imports by
 * path rather than in a barrel anything can reach.
 *
 * Every id below is read from `src/main/msp/msp_protocol.h` at the pinned
 * API 1.47 commit and re-checked at 1.48 and 1.49; none of them moved.
 */

/** `#define MSP_SIMPLIFIED_TUNING 140` - 53 bytes out. */
export const MSP_SIMPLIFIED_TUNING = 140;
/** `#define MSP_SET_SIMPLIFIED_TUNING 141` - 53 bytes in, then the
 *  firmware regenerates PID gains, D Max, feedforward and filter Hz. */
export const MSP_SET_SIMPLIFIED_TUNING = 141;
/** `#define MSP_CALCULATE_SIMPLIFIED_PID 142` - runs on a TEMPORARY copy
 *  of the profile and stores nothing. A calculator, never a write. */
export const MSP_CALCULATE_SIMPLIFIED_PID = 142;
/** `#define MSP_CALCULATE_SIMPLIFIED_GYRO 143` - likewise temporary. */
export const MSP_CALCULATE_SIMPLIFIED_GYRO = 143;
/** `#define MSP_CALCULATE_SIMPLIFIED_DTERM 144` - likewise temporary. */
export const MSP_CALCULATE_SIMPLIFIED_DTERM = 144;
/** `#define MSP_VALIDATE_SIMPLIFIED_TUNING 145` - three u8 booleans: the
 *  firmware's own opinion about whether the stored values still match what
 *  the sliders would generate. One input to a verification, never the
 *  verification. */
export const MSP_VALIDATE_SIMPLIFIED_TUNING = 145;
/** `#define MSP_COPY_PROFILE 183` - `[type, destination, source]`. */
export const MSP_COPY_PROFILE = 183;
/**
 * `#define MSP_SET_RESET_CURR_PID 219` - resets the CURRENT PID profile to
 * firmware defaults, in RAM, and reboots nothing.
 *
 * This is NOT `MSP_RESET_CONF` (208), which resets the entire configuration
 * and forces a reboot. The two ids are deliberately declared in different
 * modules so that no enum, no lookup table and no shared "reset" helper can
 * ever turn a profile reset into a whole-configuration wipe.
 */
export const MSP_SET_RESET_CURR_PID = 219;
