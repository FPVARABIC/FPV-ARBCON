/**
 * BACKUP AND RESTORE, ATTACKED RATHER THAN DEMONSTRATED.
 *
 * The previous round proved the reply-termination contract byte by byte
 * and closed two defects. Passing those same fixtures again proves
 * nothing new, so every scenario here is one that was NOT run before:
 *
 *   - a full round trip through a FACTORY RESET with a DIFFERENT
 *     configuration written in between, so restoring cannot be confused
 *     with never having changed anything;
 *   - a rejected command at the FIRST, MIDDLE and LAST position, because
 *     "one command failed" is three different code paths;
 *   - documents an order of magnitude larger than the earlier fixtures;
 *   - CRLF and LF, and chunkings from one byte up to whole-reply.
 *
 * THE NON-NEGOTIABLE RULE, restated as an assertion in several places: if
 * a single restore command fails, `save` is never sent and success is
 * never reported. A restore that half-applied and then persisted itself
 * is worse than one that failed outright, because the aircraft looks
 * configured.
 */

import type {UsbSerialTransportClient} from '../transport/UsbSerialTransportClient';
import {CliBackupService, restoreCommands} from './CliBackupService';
import {VirtualCliBoard} from './__testUtils__/virtualCliBoard';

function service(board: VirtualCliBoard): CliBackupService {
  return new CliBackupService(board as unknown as UsbSerialTransportClient);
}

/**
 * A configuration of `size` settings, named and valued deterministically
 * so two boards can be compared field by field.
 */
function configuration(
  prefix: string,
  size: number,
): Map<string, string> {
  const settings = new Map<string, string>();
  for (let index = 0; index < size; index += 1) {
    settings.set(`${prefix}_setting_${index}`, String(1000 + index));
  }
  return settings;
}

/** A realistic Betaflight configuration, using its own setting names. */
const CONFIG_A = new Map<string, string>([
  ['gps_provider', 'UBLOX'],
  ['gps_sbas_mode', 'EGNOS'],
  ['failsafe_procedure', 'GPS-RESCUE'],
  ['failsafe_delay', '15'],
  ['gps_rescue_min_sats', '10'],
  ['gps_rescue_return_alt', '80'],
  ['motor_pwm_protocol', 'DSHOT300'],
  ['motor_poles', '14'],
  ['align_board_yaw', '0'],
  ['vbat_max_cell_voltage', '435'],
  ['vbat_min_cell_voltage', '320'],
  ['bat_capacity', '6000'],
  ['serialrx_provider', 'CRSF'],
  ['deadband', '2'],
  ['yaw_deadband', '3'],
]);

/** A DIFFERENT aircraft entirely - not config A with one value moved. */
const CONFIG_B = new Map<string, string>([
  ['gps_provider', 'NMEA'],
  ['gps_sbas_mode', 'NONE'],
  ['failsafe_procedure', 'DROP'],
  ['failsafe_delay', '4'],
  ['gps_rescue_min_sats', '8'],
  ['gps_rescue_return_alt', '30'],
  ['motor_pwm_protocol', 'DSHOT600'],
  ['motor_poles', '12'],
  ['align_board_yaw', '270'],
  ['vbat_max_cell_voltage', '420'],
  ['vbat_min_cell_voltage', '330'],
  ['bat_capacity', '850'],
  ['serialrx_provider', 'SBUS'],
  ['deadband', '0'],
  ['yaw_deadband', '0'],
]);

/* ==================================================================== *
 * 1. THE ROUND TRIP THROUGH A FACTORY RESET
 * ==================================================================== */

describe('cli red team: A -> backup -> wipe -> B -> restore A', () => {
  /**
   * THE SCENARIO THAT MATTERS ON A BENCH. An operator backs up a working
   * aircraft, reflashes, configures something else by mistake, then
   * restores. Every value the backup carried must end up as A's, and
   * nothing of B's may survive where A specifies a value.
   *
   * The earlier round trip started from a board that had never held a
   * second configuration, so "restore worked" and "nothing ever changed"
   * were indistinguishable. Here B is genuinely on the board first.
   */
  it('leaves nothing of B where A specifies a value', async () => {
    const source = new VirtualCliBoard({settings: CONFIG_A});
    const backup = await service(source).capture(1, 0);

    // Every one of A's settings has to be IN the document, or the rest of
    // this test would be asserting over a backup that never carried them.
    for (const [name, value] of CONFIG_A) {
      expect(`${name} in backup`).toBe(
        `${name}${backup.includes(`set ${name} = ${value}`) ? ' in backup' : ' MISSING'}`,
      );
    }

    // ---- the flash, and a different configuration afterwards --------
    const target = new VirtualCliBoard({settings: CONFIG_B});
    expect(target.settings.get('failsafe_procedure')).toBe('DROP');

    const result = await service(target).restore(1, 0, backup);
    expect(result.errors).toEqual([]);
    expect(target.sawSave).toBe(true);

    // ---- the comparison, value by value -----------------------------
    for (const [name, value] of CONFIG_A) {
      expect(`${name}=${target.persisted.get(name)}`).toBe(`${name}=${value}`);
    }
    // And specifically: none of B's distinctive values are left.
    expect(target.persisted.get('failsafe_procedure')).not.toBe('DROP');
    expect(target.persisted.get('align_board_yaw')).not.toBe('270');
    expect(target.persisted.get('bat_capacity')).not.toBe('850');
  });

  it('survives the round trip identically under every chunking', async () => {
    const reference = await service(
      new VirtualCliBoard({settings: CONFIG_A}),
    ).capture(1, 0);

    for (const chunking of [1, 2, 7, 64, 'whole' as const]) {
      const board = new VirtualCliBoard({settings: CONFIG_A, chunking});
      expect(`${String(chunking)}: identical`).toBe(
        `${String(chunking)}: ${
          (await service(board).capture(1, 0)) === reference
            ? 'identical'
            : 'DIFFERENT'
        }`,
      );
    }
  });

  it('survives the round trip with LF line endings as well as CRLF', async () => {
    const crlf = new VirtualCliBoard({settings: CONFIG_A, lineEnding: '\r\n'});
    const lf = new VirtualCliBoard({settings: CONFIG_A, lineEnding: '\n'});
    const fromCrlf = await service(crlf).capture(1, 0);
    const fromLf = await service(lf).capture(1, 0);

    // The documents differ only in their line endings; both must restore
    // to the same configuration.
    for (const document of [fromCrlf, fromLf]) {
      const target = new VirtualCliBoard({settings: CONFIG_B});
      const result = await service(target).restore(1, 0, document);
      expect(result.errors).toEqual([]);
      expect(target.persisted.get('failsafe_procedure')).toBe('GPS-RESCUE');
    }
  });

  it('handles a document an order of magnitude larger than the earlier ones', async () => {
    // A real `diff all` on a fully-configured board runs to hundreds of
    // lines with many headings. This is 400 settings and eight headings.
    const big = configuration('big', 400);
    const board = new VirtualCliBoard({
      settings: big,
      header: [
        'version',
        'Betaflight / STM32F7X2 (S7X2) 4.6.0',
        'start the command batch',
        'board_name S7X2',
        'manufacturer_id ABCD',
        'resources',
        'mixer',
        'feature',
      ],
      chunking: 13,
    });

    const backup = await service(board).capture(1, 0);
    // 400 settings plus the two batch-framing lines. `batch start` and
    // `batch end` are commands the firmware expects replayed, not
    // decoration, so restoreCommands keeps them - see cli.c's
    // USE_CLI_BATCH handling.
    expect(restoreCommands(backup)).toHaveLength(402);

    const target = new VirtualCliBoard({settings: configuration('big', 400)});
    // Move every value on the target first, so a restore that did nothing
    // could not pass.
    for (const key of target.settings.keys()) target.settings.set(key, '1');
    const result = await service(target).restore(1, 0, backup);

    expect(result.commandCount).toBe(402);
    expect(result.errors).toEqual([]);
    expect(target.persisted.get('big_setting_0')).toBe('1000');
    expect(target.persisted.get('big_setting_399')).toBe('1399');
  });
});

/* ==================================================================== *
 * 2. ONE COMMAND FAILS - AT THE FRONT, THE MIDDLE, AND THE END
 * ==================================================================== */

describe('cli red team: a failed command never becomes a successful restore', () => {
  /**
   * The position matters because the code paths differ: a failure on the
   * first command happens before anything was applied, one in the middle
   * leaves the board half-configured, and one on the LAST command is the
   * dangerous one - every earlier command succeeded, the loop is over,
   * and the only thing standing between that and a `save` is the error
   * list being checked rather than the loop having finished.
   */
  const names = [...CONFIG_A.keys()];
  it.each([
    ['first', names[0]],
    ['middle', names[Math.floor(names.length / 2)]],
    ['last', names[names.length - 1]],
  ])('refuses to save when the %s command is rejected', async (_where, name) => {
    const backup = await service(
      new VirtualCliBoard({settings: CONFIG_A}),
    ).capture(1, 0);

    const target = new VirtualCliBoard({
      settings: CONFIG_B,
      unknownSettings: new Set([name]),
    });
    const result = await service(target).restore(1, 0, backup);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(name);
    expect(result.errors[0]).toMatch(/###ERROR/i);
    // THE RULE: no save, and therefore nothing persisted.
    expect(target.sawSave).toBe(false);
    // The board's RAM holds a half-applied mixture; its EEPROM does not.
    expect(target.persisted.get('failsafe_procedure')).toBe('DROP');
  });

  it('reports every rejected command, not just the first', async () => {
    const backup = await service(
      new VirtualCliBoard({settings: CONFIG_A}),
    ).capture(1, 0);
    const rejected = new Set([names[1], names[5], names[9]]);
    const target = new VirtualCliBoard({
      settings: CONFIG_B,
      unknownSettings: rejected,
    });

    const result = await service(target).restore(1, 0, backup);
    expect(result.errors).toHaveLength(3);
    for (const name of rejected) {
      expect(result.errors.some(error => error.includes(name))).toBe(true);
    }
    expect(target.sawSave).toBe(false);
  });

  it('surfaces the whole ###ERROR line, not a summary of it', async () => {
    const backup = await service(
      new VirtualCliBoard({settings: CONFIG_A}),
    ).capture(1, 0);
    const target = new VirtualCliBoard({
      settings: CONFIG_B,
      unknownSettings: new Set(['gps_rescue_min_sats']),
    });
    const result = await service(target).restore(1, 0, backup);

    // The operator needs the firmware's own words to know WHY.
    expect(result.errors[0]).toContain('INVALID NAME');
    expect(result.errors[0]).toContain('gps_rescue_min_sats');
  });
});

/* ==================================================================== *
 * 3. THE LINK MISBEHAVES
 * ==================================================================== */

describe('cli red team: an incomplete capture is never a backup', () => {
  it('refuses a diff that stops before its batch terminator', async () => {
    // The bytes look exactly like a configuration - headings, batch
    // start, a run of `set` lines - and the only thing missing is the
    // terminator. Accepting it would produce a backup that restores an
    // aircraft to a configuration it never had.
    const board = new VirtualCliBoard({
      settings: CONFIG_A,
      truncateDiffAfter: 6,
    });
    await expect(service(board).capture(1, 0)).rejects.toThrow();
    // The production `diff all` budget is 30 s and this test waits the
    // whole of it on purpose. Shortening it would mean asserting against
    // a timeout invented for the test rather than the one the app ships,
    // which is precisely the substitution the reader was written to
    // avoid. The byte-level proof that a terminator-bearing reply is
    // never settled by silence lives in cliReplyReader.test.ts and costs
    // nothing; this one proves the service actually wires it in.
  }, 45_000);

  it('refuses a board that stops answering entirely', async () => {
    const board = new VirtualCliBoard({settings: CONFIG_A, silent: true});
    await expect(service(board).capture(1, 0)).rejects.toThrow();
  });

  it('stops a restore when the link goes silent partway through', async () => {
    const backup = await service(
      new VirtualCliBoard({settings: CONFIG_A}),
    ).capture(1, 0);
    const target = new VirtualCliBoard({settings: CONFIG_B});

    // The board answers a few commands and then stops. Nothing after that
    // point can be confirmed, so the restore must not finish quietly.
    const original = target.writeBytes.bind(target);
    let answered = 0;
    (target as unknown as {writeBytes: typeof original}).writeBytes = async (
      sessionId: string,
      dataBase64: string,
    ) => {
      answered += 1;
      if (answered > 5) target.silent = true;
      return original(sessionId, dataBase64);
    };

    await expect(service(target).restore(1, 0, backup)).rejects.toThrow();
    expect(target.sawSave).toBe(false);
  });
});

describe('cli red team: a malformed document is refused before the link opens', () => {
  it.each([
    ['empty', ''],
    ['whitespace only', '   \r\n\r\n  '],
    ['no comment line at all', 'set a = 1\r\nset b = 2\r\n'],
    ['binary', 'set a = 1\r\n \r\n# x\r\n'],
  ])('refuses a %s document', (_label, text) => {
    expect(() => restoreCommands(text)).toThrow();
  });

  it('refuses a document with more commands than the safe limit', () => {
    const lines = ['# version'];
    for (let index = 0; index < 20_000; index += 1) {
      lines.push(`set overflow_${index} = 1`);
    }
    expect(() => restoreCommands(lines.join('\r\n'))).toThrow();
  });

  it('never replays a save line that was inside the backup', async () => {
    // `diff all` documents do not contain `save`, but a hand-edited or
    // concatenated one might, and replaying it mid-restore would persist
    // a half-applied configuration.
    const document = '# version\r\nset deadband = 2\r\nsave\r\nset yaw_deadband = 3\r\n';
    expect(restoreCommands(document)).toEqual([
      'set deadband = 2',
      'set yaw_deadband = 3',
    ]);

    const target = new VirtualCliBoard({settings: CONFIG_B});
    const result = await service(target).restore(1, 0, document);
    expect(result.errors).toEqual([]);
    // Exactly one save, sent by the service at the end - not two.
    expect(target.commands.filter(c => c.toLowerCase() === 'save')).toHaveLength(1);
  });
});
