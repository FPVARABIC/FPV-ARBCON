import {
  DSHOT_ALL_MOTORS_INDEX,
  DSHOT_COMMAND_MOTOR_STOP,
  DSHOT_COMMAND_TYPE_BLOCKING,
  DSHOT_COMMAND_TYPE_INLINE,
  DshotEscDirectionEncodeError,
  encodeDshotCommand,
  encodeDshotEscDirection,
  encodeDshotMotorStopCommand,
} from './encodeDshotEscDirection';

describe('encodeDshotEscDirection', () => {
  it('encodes one blocking normal command followed by ESC save', () => {
    expect(Array.from(encodeDshotEscDirection(0, 'NORMAL'))).toEqual([
      1, 0, 2, 7, 12,
    ]);
  });

  it('encodes reverse for one exact zero-based motor index', () => {
    expect(Array.from(encodeDshotEscDirection(3, 'REVERSED'))).toEqual([
      1, 3, 2, 8, 12,
    ]);
  });

  it('rejects broadcast, invalid index, and unknown direction', () => {
    expect(() => encodeDshotEscDirection(255, 'NORMAL')).toThrow();
    expect(() => encodeDshotEscDirection(-1, 'NORMAL')).toThrow();
    expect(() => encodeDshotEscDirection(0, 'sideways' as never)).toThrow();
  });
});

/* ===================================================================== *
 * P1-D - the general MSP2_SEND_DSHOT_COMMAND encoder that
 * `encodeDshotEscDirection` is now expressed through, plus the all-outputs
 * motor-stop request. Nothing in this repository sends either; wiring is
 * P2 work.
 * ===================================================================== */
describe('P1-D encodeDshotCommand', () => {
  it('lays out commandType, motorIndex, commandCount then the commands', () => {
    expect(
      Array.from(
        encodeDshotCommand({
          commandType: DSHOT_COMMAND_TYPE_BLOCKING,
          motorIndex: 2,
          commands: [DSHOT_COMMAND_MOTOR_STOP],
        }),
      ),
    ).toEqual([1, 2, 1, 0]);
  });

  it('accepts the inline command type and multi-command lists', () => {
    expect(
      Array.from(
        encodeDshotCommand({
          commandType: DSHOT_COMMAND_TYPE_INLINE,
          motorIndex: DSHOT_ALL_MOTORS_INDEX,
          commands: [7, 12],
        }),
      ),
    ).toEqual([0, 255, 2, 7, 12]);
  });

  it('rejects an unknown command type', () => {
    for (const commandType of [-1, 2, 1.5, Number.NaN]) {
      expect(() =>
        encodeDshotCommand({commandType, motorIndex: 0, commands: [0]}),
      ).toThrow(DshotEscDirectionEncodeError);
    }
  });

  it('rejects an out-of-u8 motor index or command value', () => {
    expect(() =>
      encodeDshotCommand({commandType: 1, motorIndex: 256, commands: [0]}),
    ).toThrow(DshotEscDirectionEncodeError);
    expect(() =>
      encodeDshotCommand({commandType: 1, motorIndex: -1, commands: [0]}),
    ).toThrow(DshotEscDirectionEncodeError);
    expect(() =>
      encodeDshotCommand({commandType: 1, motorIndex: 0, commands: [300]}),
    ).toThrow(DshotEscDirectionEncodeError);
  });

  it('rejects an empty or sparse command list', () => {
    expect(() =>
      encodeDshotCommand({commandType: 1, motorIndex: 0, commands: []}),
    ).toThrow(DshotEscDirectionEncodeError);
    const sparse: number[] = [0, 0];
    delete sparse[1];
    expect(() =>
      encodeDshotCommand({commandType: 1, motorIndex: 0, commands: sparse}),
    ).toThrow(DshotEscDirectionEncodeError);
  });
});

describe('P1-D encodeDshotMotorStopCommand', () => {
  it('defaults to ALL_MOTORS with one blocking DSHOT_CMD_MOTOR_STOP', () => {
    expect(Array.from(encodeDshotMotorStopCommand())).toEqual([1, 255, 1, 0]);
  });

  it('can target a single output index', () => {
    expect(Array.from(encodeDshotMotorStopCommand(3))).toEqual([1, 3, 1, 0]);
  });

  it('rejects an out-of-u8 index', () => {
    expect(() => encodeDshotMotorStopCommand(256)).toThrow(DshotEscDirectionEncodeError);
  });
});

describe('P1-D encodeDshotEscDirection is byte-identical after the refactor', () => {
  it('still produces the five documented bytes', () => {
    expect(Array.from(encodeDshotEscDirection(0, 'NORMAL'))).toEqual([1, 0, 2, 7, 12]);
    expect(Array.from(encodeDshotEscDirection(7, 'REVERSED'))).toEqual([1, 7, 2, 8, 12]);
  });

  it('still rejects an index outside 0..7 and an unknown direction', () => {
    expect(() => encodeDshotEscDirection(8, 'NORMAL')).toThrow(DshotEscDirectionEncodeError);
    expect(() => encodeDshotEscDirection(-1, 'NORMAL')).toThrow(DshotEscDirectionEncodeError);
    expect(() =>
      encodeDshotEscDirection(0, 'SIDEWAYS' as never),
    ).toThrow(DshotEscDirectionEncodeError);
  });

  it('never uses the ALL_MOTORS index for a persistent save-settings write', () => {
    expect(() => encodeDshotEscDirection(DSHOT_ALL_MOTORS_INDEX, 'NORMAL')).toThrow(
      DshotEscDirectionEncodeError,
    );
  });
});
