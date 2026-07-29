/**
 * Repair Pass R2 - MOTOR-ONLY MSP command ids.
 *
 * This module exists purely so that command ids used ONLY by the
 * motor-test engine are declared outside `mspCommands.ts`, which is
 * legitimately part of the Release dependency graph for the read-only
 * telemetry commands. An export name declared in a Release-reachable
 * module survives minification as a property key, so declaring
 * `MSP_SET_MOTOR` there put the name into every shipped bundle even once
 * the engine itself was excluded.
 *
 * NOTHING ABOUT THE COMMAND CHANGED. Same id, same encoding, same
 * vectors, same behaviour, same consumers. Only the declaration site
 * moved, and `mspCommands.ts` re-exports it so every existing source
 * import keeps working unchanged.
 *
 * DECLARATION ONLY - as it always was. This module adds no caller, no
 * frame construction, no transport path and no authorization to spin a
 * motor. Betaflight 2025.12.2, MSP API 1.47, pinned commit
 * 79065c96ba0bb5cdc675e67d7093e05dab8b330e:
 *   `#define MSP_SET_MOTOR 214  // in message: PropBalance function`
 */

export const MSP_SET_MOTOR = 214;
