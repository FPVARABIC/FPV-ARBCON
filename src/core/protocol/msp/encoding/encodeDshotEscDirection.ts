export type DshotEscDirection = 'NORMAL' | 'REVERSED';

export class DshotEscDirectionEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DshotEscDirectionEncodeError';
  }
}

const DSHOT_COMMAND_TYPE_BLOCKING = 1;
const DSHOT_COMMAND_COUNT = 2;
const DSHOT_COMMAND_DIRECTION_NORMAL = 7;
const DSHOT_COMMAND_DIRECTION_REVERSED = 8;
const DSHOT_COMMAND_SAVE_SETTINGS = 12;

/**
 * Official Configurator payload for one persistent ESC direction change:
 * blocking mode, zero-based motor index, two DShot commands, direction,
 * save-settings. This is one MSP request; no command in it is retried.
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
  return Uint8Array.from([
    DSHOT_COMMAND_TYPE_BLOCKING,
    motorIndex,
    DSHOT_COMMAND_COUNT,
    direction === 'NORMAL'
      ? DSHOT_COMMAND_DIRECTION_NORMAL
      : DSHOT_COMMAND_DIRECTION_REVERSED,
    DSHOT_COMMAND_SAVE_SETTINGS,
  ]);
}
