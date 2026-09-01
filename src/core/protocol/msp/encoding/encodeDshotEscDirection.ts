/**
 * MSP2_SEND_DSHOT_COMMAND (0x3003) payload encoding.
 *
 * P1-D EXTENDED this existing module rather than adding a second DShot
 * encoder. `encodeDshotEscDirection` below is unchanged in behaviour and
 * still produces the identical five bytes; it is now expressed through the
 * general `encodeDshotCommand` primitive that the professional motor
 * workspace will need.
 *
 * WIRE LAYOUT, from src/main/msp/msp.c case MSP2_SEND_DSHOT_COMMAND @
 * Betaflight 79065c96ba0bb5cdc675e67d7093e05dab8b330e:
 *
 *     const bool armed = ARMING_FLAG(ARMED);
 *     if (!armed) {
 *         const uint8_t commandType  = sbufReadU8(src);
 *         const uint8_t motorIndex   = sbufReadU8(src);
 *         const uint8_t commandCount = sbufReadU8(src);
 *         if (DSHOT_CMD_TYPE_BLOCKING == commandType) { motorDisable(); }
 *         for (uint8_t i = 0; i < commandCount; i++) {
 *             const uint8_t commandIndex = sbufReadU8(src);
 *             dshotCommandWrite(motorIndex, getMotorCount(), commandIndex, commandType);
 *         }
 *         if (DSHOT_CMD_TYPE_BLOCKING == commandType) { motorEnable(); }
 *     }
 *
 * so: commandType u8, motorIndex u8, commandCount u8, then exactly
 * commandCount command bytes. The firmware ignores the whole request while
 * ARMED - that is a firmware fact, not a substitute for this application's
 * own disarmed evidence.
 *
 * Command and type values, src/main/drivers/dshot_command.h @ the same
 * commit: `DSHOT_CMD_MOTOR_STOP = 0` (first member of dshotCommands_e),
 * `DSHOT_CMD_TYPE_INLINE = 0` ("motors must be enabled"),
 * `DSHOT_CMD_TYPE_BLOCKING` = 1 ("motors must be disabled").
 * `ALL_MOTORS` is 255, src/main/drivers/motor_types.h:27.
 *
 * NO PHYSICAL CLAIMS. Encoding a command produces bytes. This module has
 * no transport and authorises nothing; whether a command reaches an ESC,
 * and what an ESC does with it, remains REQUIRES HARDWARE TEST.
 */

export type DshotEscDirection = 'NORMAL' | 'REVERSED';

export class DshotEscDirectionEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DshotEscDirectionEncodeError';
  }
}

/** dshotCommandType_e @ 79065c96: inline (motors enabled). */
export const DSHOT_COMMAND_TYPE_INLINE = 0;
/** dshotCommandType_e @ 79065c96: blocking (motors disabled). */
export const DSHOT_COMMAND_TYPE_BLOCKING = 1;
/** ALL_MOTORS, src/main/drivers/motor_types.h:27 @ 79065c96. */
export const DSHOT_ALL_MOTORS_INDEX = 255;
/** dshotCommands_e DSHOT_CMD_MOTOR_STOP = 0 @ 79065c96. */
export const DSHOT_COMMAND_MOTOR_STOP = 0;
/** dshotCommands_e DSHOT_CMD_SPIN_DIRECTION_1 = 7 @ 79065c96. */
export const DSHOT_COMMAND_DIRECTION_NORMAL = 7;
/** dshotCommands_e DSHOT_CMD_SPIN_DIRECTION_2 = 8 @ 79065c96. */
export const DSHOT_COMMAND_DIRECTION_REVERSED = 8;
/** dshotCommands_e DSHOT_CMD_SAVE_SETTINGS = 12 @ 79065c96. */
export const DSHOT_COMMAND_SAVE_SETTINGS = 12;

const DSHOT_COMMAND_COUNT = 2;

/** One MSP2_SEND_DSHOT_COMMAND request, described in domain terms. */
export interface DshotCommandRequest {
  /** DSHOT_COMMAND_TYPE_INLINE or DSHOT_COMMAND_TYPE_BLOCKING. */
  readonly commandType: number;
  /** Zero-based output index, or DSHOT_ALL_MOTORS_INDEX for every output. */
  readonly motorIndex: number;
  /** One or more dshotCommands_e values, sent in this order. */
  readonly commands: readonly number[];
}

function rejectUnlessU8(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new DshotEscDirectionEncodeError(
      `${label} must be an integer from 0 through 255, received ${String(value)}.`,
    );
  }
}

/**
 * Encodes one MSP2_SEND_DSHOT_COMMAND payload. Rejects rather than
 * normalises: no default command type, no default motor index, no implicit
 * command list, no padding and no truncation.
 */
export function encodeDshotCommand(request: DshotCommandRequest): Uint8Array {
  if (
    request.commandType !== DSHOT_COMMAND_TYPE_INLINE &&
    request.commandType !== DSHOT_COMMAND_TYPE_BLOCKING
  ) {
    throw new DshotEscDirectionEncodeError(
      `DShot command type must be ${DSHOT_COMMAND_TYPE_INLINE} (inline) or ` +
        `${DSHOT_COMMAND_TYPE_BLOCKING} (blocking), received ${String(request.commandType)}.`,
    );
  }
  rejectUnlessU8(request.motorIndex, 'DShot motor index');
  if (!Array.isArray(request.commands) || request.commands.length === 0) {
    throw new DshotEscDirectionEncodeError(
      'DShot command list must be a non-empty array.',
    );
  }
  for (let index = 0; index < request.commands.length; index++) {
    if (!Object.prototype.hasOwnProperty.call(request.commands, index)) {
      throw new DshotEscDirectionEncodeError(
        `DShot command list index ${index} is a hole; a sparse array is not a valid command list.`,
      );
    }
    rejectUnlessU8(request.commands[index], `DShot command[${index}]`);
  }
  return Uint8Array.from([
    request.commandType,
    request.motorIndex,
    request.commands.length,
    ...request.commands,
  ]);
}

/**
 * The all-outputs DShot motor-stop request: blocking type, ALL_MOTORS,
 * one DSHOT_CMD_MOTOR_STOP command. Both reference configurators issue
 * this when leaving their motor-test surface.
 *
 * DECLARED ONLY IN P1. Nothing in this repository sends it; wiring it into
 * the live controller is explicitly P2 work.
 */
export function encodeDshotMotorStopCommand(
  motorIndex: number = DSHOT_ALL_MOTORS_INDEX,
): Uint8Array {
  return encodeDshotCommand({
    commandType: DSHOT_COMMAND_TYPE_BLOCKING,
    motorIndex,
    commands: [DSHOT_COMMAND_MOTOR_STOP],
  });
}

/**
 * Official Configurator payload for one persistent ESC direction change:
 * blocking mode, zero-based motor index, two DShot commands, direction,
 * save-settings. This is one MSP request; no command in it is retried.
 *
 * UNCHANGED BY P1-D. Same five bytes, same validation, same errors - it is
 * now expressed through `encodeDshotCommand` instead of assembling the
 * array inline. The 0..7 index bound matches MAX_SUPPORTED_MOTORS
 * (target/common_defaults_post.h:351 @ 79065c96); this entry point
 * deliberately does NOT accept ALL_MOTORS, because a persistent
 * save-settings write is a per-ESC operation.
 */
export function encodeDshotEscDirection(
  motorIndex: number,
  direction: DshotEscDirection,
): Uint8Array {
  if (!Number.isInteger(motorIndex) || motorIndex < 0 || motorIndex > 7) {
    throw new DshotEscDirectionEncodeError(
      'DShot ESC motor index must be an integer from 0 through 7.',
    );
  }
  if (direction !== 'NORMAL' && direction !== 'REVERSED') {
    throw new DshotEscDirectionEncodeError('Unknown DShot ESC direction.');
  }
  const payload = encodeDshotCommand({
    commandType: DSHOT_COMMAND_TYPE_BLOCKING,
    motorIndex,
    commands: [
      direction === 'NORMAL'
        ? DSHOT_COMMAND_DIRECTION_NORMAL
        : DSHOT_COMMAND_DIRECTION_REVERSED,
      DSHOT_COMMAND_SAVE_SETTINGS,
    ],
  });
  // The command count byte is structural, not derived at the call site.
  if (payload[2] !== DSHOT_COMMAND_COUNT) {
    throw new DshotEscDirectionEncodeError(
      'DShot ESC direction payload must carry exactly two commands.',
    );
  }
  return payload;
}
