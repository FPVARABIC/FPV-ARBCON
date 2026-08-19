/* eslint-disable no-bitwise -- seeded pseudo-random chunk splitting. */
/**
 * WHAT THE FIVE AIRCRAFT DO WHEN THINGS GO WRONG.
 *
 * The acceptance suite proves the app can configure a board. This one
 * proves the harder half: that when it CANNOT, it says so.
 *
 * Every case below is a way an application could tell an operator their
 * aircraft is configured when it is not, and each is run against a board
 * that really holds state - so "the app claimed success" and "the board
 * holds the value" are two separate, separately-checked facts.
 *
 * Nothing here is evidence about hardware.
 */

import {
  MSP_BOARD_ALIGNMENT_CONFIG,
  MSP_EEPROM_WRITE,
  MSP_FAILSAFE_CONFIG,
  MSP_SET_BOARD_ALIGNMENT_CONFIG,
  MSP_SET_FAILSAFE_CONFIG,
} from '../../../core/protocol/msp/commands/mspCommands';
import {createFailsafeConfigurationDraft} from '../../../core/state/failsafeConfigurationModel';
import {decodeBoardAlignment} from '../../../core/protocol/msp/decoding/decodeBoardAlignment';
import {BoardAlignmentController} from './BoardAlignmentController';
import {FailsafeConfigurationController} from './FailsafeConfigurationController';
import {CliBackupService, restoreCommands} from './CliBackupService';
import type {UsbSerialTransportClient} from '../transport/UsbSerialTransportClient';
import {
  DRONE_SPECS,
  buildFactoryBoard,
  type DroneSpec,
} from './__testUtils__/virtualDroneFixtures';
import {VirtualCliBoard} from './__testUtils__/virtualCliBoard';
import {VirtualFlightController} from './__testUtils__/virtualFlightController';
import {VirtualSession} from './__testUtils__/virtualSession';

jest.mock('../transport/native/NativeUsbSerialTransport');

const NEUTRAL = {rollDegrees: 0, pitchDegrees: 0, yawDegrees: 0};
const ROTATED = {rollDegrees: 0, pitchDegrees: 0, yawDegrees: 90};

type Outcome = {kind: string; reason?: string; stage?: unknown};

function spec(key: string): DroneSpec {
  const found = DRONE_SPECS.find(candidate => candidate.key === key);
  if (found === undefined) throw new Error(`no spec ${key}`);
  return found;
}

function rig(key = 'LONG_RANGE', apiMinor = 47) {
  const droneSpec = spec(key);
  const board = new VirtualFlightController({
    parameters: buildFactoryBoard(droneSpec),
  });
  const session = new VirtualSession({
    sessionId: `fail-${key}-${apiMinor}`,
    board,
    apiMinor,
  });
  return {droneSpec, board, session};
}

/** Loads board alignment and returns the controller ready to save. */
async function alignmentRig(key = 'LONG_RANGE') {
  const {board, session} = rig(key);
  const controller = new BoardAlignmentController(session.options);
  const loaded = await controller.load(session.key);
  if (loaded.kind !== 'LOADED') throw new Error(loaded.kind);
  return {board, session, controller, original: loaded.snapshot};
}

describe('failure injection - the app never claims what it cannot prove', () => {
  it('ARMED: refuses, writes nothing, and the board is untouched', async () => {
    const {board, session, controller, original} = await alignmentRig();
    board.setArmed(true);
    const outcome = (await controller.save(
      session.key,
      original,
      ROTATED,
    )) as Outcome;
    expect(outcome).toEqual({kind: 'REJECTED', reason: 'FC_ARMED'});
    expect(board.requests.map(r => r.command)).not.toContain(
      MSP_SET_BOARD_ALIGNMENT_CONFIG,
    );
    expect(decodeBoardAlignment(
      board.readParameter(MSP_BOARD_ALIGNMENT_CONFIG) as Uint8Array,
    )).toEqual(NEUTRAL);
  });

  it('ACK failure: the board refuses the write, so the app FAILS and never persists', async () => {
    const {board, session, controller, original} = await alignmentRig();
    board.injectFault({
      command: MSP_SET_BOARD_ALIGNMENT_CONFIG,
      fault: {kind: 'REMOTE_ERROR'},
    });
    const outcome = (await controller.save(
      session.key,
      original,
      ROTATED,
    )) as Outcome;
    expect(outcome.kind).toBe('FAILED');
    expect(board.requests.map(r => r.command)).not.toContain(MSP_EEPROM_WRITE);
    expect(board.hasUnsavedChanges()).toBe(false);
  });

  it('TIMEOUT on the write: UNCONFIRMED, no retry, no EEPROM', async () => {
    const {board, session, controller, original} = await alignmentRig();
    board.injectFault({
      command: MSP_SET_BOARD_ALIGNMENT_CONFIG,
      fault: {kind: 'TIMEOUT'},
    });
    const outcome = (await controller.save(
      session.key,
      original,
      ROTATED,
    )) as Outcome;
    expect(outcome).toEqual({
      kind: 'UNCONFIRMED',
      stage: 'BOARD_ALIGNMENT',
    });
    expect(
      board.requests.filter(r => r.command === MSP_SET_BOARD_ALIGNMENT_CONFIG),
    ).toHaveLength(1);
    expect(board.requests.map(r => r.command)).not.toContain(MSP_EEPROM_WRITE);
  });

  it('EEPROM failure: UNCONFIRMED at the EEPROM stage, not a success', async () => {
    const {board, session, controller, original} = await alignmentRig();
    board.injectFault({command: MSP_EEPROM_WRITE, fault: {kind: 'TIMEOUT'}});
    const outcome = (await controller.save(
      session.key,
      original,
      ROTATED,
    )) as Outcome;
    expect(outcome).toEqual({kind: 'UNCONFIRMED', stage: 'EEPROM'});
    // The angles reached RAM but were never persisted: exactly the state
    // the operator must be told about, and the board proves it.
    expect(board.hasUnsavedChanges()).toBe(true);
  });

  it('DISCONNECT mid-transaction: nothing is reported as saved', async () => {
    const {board, session, controller, original} = await alignmentRig();
    board.detach();
    const outcome = (await controller.save(
      session.key,
      original,
      ROTATED,
    )) as Outcome;
    expect(['SESSION_ENDED', 'UNCONFIRMED', 'FAILED', 'REJECTED']).toContain(
      outcome.kind,
    );
    expect(board.hasUnsavedChanges()).toBe(false);
  });

  it('STALE BASE: a value that moved under the operator is not overwritten', async () => {
    const {board, session, controller, original} = await alignmentRig();
    // Something else changed the board between the read and the save.
    await board.request(
      MSP_SET_BOARD_ALIGNMENT_CONFIG,
      Uint8Array.from([0, 0, 0, 0, 45, 0]),
      {wireFormat: 'v1'},
    );
    const outcome = (await controller.save(
      session.key,
      original,
      ROTATED,
    )) as Outcome;
    expect(outcome).toEqual({kind: 'REJECTED', reason: 'STALE_BASE'});
    // The other change stands; ours was refused rather than clobbering it.
    expect(decodeBoardAlignment(
      board.readParameter(MSP_BOARD_ALIGNMENT_CONFIG) as Uint8Array,
    ).yawDegrees).toBe(45);
  });

  it('READBACK MISMATCH: a board that reports something else is UNVERIFIED', async () => {
    const {board, session, controller, original} = await alignmentRig();
    // Truncating the readback makes the comparison impossible, which is
    // the same class of event as a board answering with the wrong value.
    board.injectFault({
      command: MSP_BOARD_ALIGNMENT_CONFIG,
      fault: {kind: 'TRUNCATE', bytes: 2},
      occurrence: 3, // the post-EEPROM readback
    });
    const outcome = (await controller.save(
      session.key,
      original,
      ROTATED,
    )) as Outcome;
    expect(outcome.kind).toBe('SAVED_UNVERIFIED');
  });

  it('RECONNECT: a save aimed at the previous session is refused outright', async () => {
    const {board, session, controller, original} = await alignmentRig();
    const staleKey = session.key;
    session.reconnect();
    const outcome = (await controller.save(
      staleKey,
      original,
      ROTATED,
    )) as Outcome;
    expect(outcome).toEqual({kind: 'REJECTED', reason: 'DISCONNECTED'});
    expect(board.requests.map(r => r.command)).not.toContain(
      MSP_SET_BOARD_ALIGNMENT_CONFIG,
    );
  });

  it('OUT OF RANGE: refused before anything reaches the wire', async () => {
    const {board, session, controller, original} = await alignmentRig();
    const before = board.requests.length;
    const outcome = (await controller.save(session.key, original, {
      rollDegrees: 400,
      pitchDegrees: 0,
      yawDegrees: 0,
    })) as Outcome;
    expect(outcome).toEqual({
      kind: 'REJECTED',
      reason: 'INVALID_CONFIGURATION',
    });
    expect(board.requests.length).toBe(before);
  });

  it('TRUNCATED PAYLOAD on load: the app reports a failure, not a default', async () => {
    // A short frame must never be padded into "mounted flat".
    const {board, session} = rig();
    board.injectFault({
      command: MSP_BOARD_ALIGNMENT_CONFIG,
      fault: {kind: 'TRUNCATE', bytes: 3},
    });
    const controller = new BoardAlignmentController(session.options);
    const outcome = (await controller.load(session.key)) as Outcome;
    expect(outcome.kind).toBe('FAILED');
  });

  it('UNSUPPORTED FIRMWARE: refused with a reason, and the link stays silent', async () => {
    const {board, session} = rig('RACING', 46);
    const controller = new FailsafeConfigurationController(session.options);
    await expect(controller.load(session.key)).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'UNSUPPORTED_FIRMWARE',
    });
    expect(board.requests).toEqual([]);
  });

  it('runs the whole failure set against all five aircraft', async () => {
    // Independence under failure too: a fault injected into one board
    // must not change what another reports.
    const results: Array<{key: string; armed: string; timeout: string}> = [];
    for (const droneSpec of DRONE_SPECS) {
      const {board, session} = rig(droneSpec.key);
      const failsafe = new FailsafeConfigurationController(session.options);
      const loaded = await failsafe.load(session.key);
      if (loaded.kind !== 'LOADED') throw new Error(loaded.kind);
      const draft = {
        ...createFailsafeConfigurationDraft(loaded.snapshot),
        delayDeciseconds: 20,
      };

      board.setArmed(true);
      const armed = (await failsafe.save(
        session.key,
        loaded.snapshot,
        draft,
      )) as Outcome;

      board.setArmed(false);
      board.injectFault({
        command: MSP_SET_FAILSAFE_CONFIG,
        fault: {kind: 'TIMEOUT'},
      });
      const timeout = (await failsafe.save(
        session.key,
        loaded.snapshot,
        draft,
      )) as Outcome;

      results.push({
        key: droneSpec.key,
        armed: `${armed.kind}:${armed.reason ?? ''}`,
        timeout: timeout.kind,
      });
      // In no case did the aircraft end up with the value.
      expect(board.readParameter(MSP_FAILSAFE_CONFIG)?.[0]).not.toBe(20);
    }
    expect(results).toEqual(
      DRONE_SPECS.map(droneSpec => ({
        key: droneSpec.key,
        armed: 'REJECTED:FC_ARMED',
        timeout: 'UNCONFIRMED',
      })),
    );
  });
});

/* ==================================================================== *
 * BACKUP AND RESTORE, over a real CLI conversation
 * ==================================================================== */

/** The settings a long-range build would actually carry. */
const LONG_RANGE_SETTINGS = new Map<string, string>([
  ['gps_provider', 'UBLOX'],
  ['gps_sbas_mode', 'AUTO'],
  ['gps_set_home_point_once', 'ON'],
  ['gps_ublox_use_galileo', 'ON'],
  ['failsafe_procedure', 'GPS-RESCUE'],
  ['failsafe_delay', '15'],
  ['gps_rescue_min_start_dist', '30'],
  ['gps_rescue_return_alt', '60'],
  ['gps_rescue_min_sats', '8'],
  ['align_board_yaw', '0'],
  ['vbat_min_cell_voltage', '320'],
  ['vbat_warning_cell_voltage', '350'],
  ['battery_capacity', '5000'],
  ['motor_pwm_protocol', 'DSHOT300'],
  ['serialrx_provider', 'CRSF'],
  ['osd_alt_alarm', '120'],
]);

function cliService(board: VirtualCliBoard): CliBackupService {
  return new CliBackupService(board as unknown as UsbSerialTransportClient);
}

/**
 * A backup document in exactly the shape Betaflight emits, built here
 * rather than captured, so the RESTORE half can be proven even though the
 * CAPTURE half is currently defective (see the recorded defect below).
 */
function betaflightDiffAll(settings: ReadonlyMap<string, string>): string {
  const lines = [
    '# version',
    '# Betaflight / STM32F405 (S405) 4.5.1',
    '# start the command batch',
    'batch start',
    ...[...settings].map(([name, value]) => `set ${name} = ${value}`),
    '# end the command batch',
    'batch end',
  ];
  return lines.join('\n');
}

describe('backup capture - REGRESSION for the heading-truncation defect', () => {
  /**
   * WAS: capture aborted three bytes into the document.
   *
   * readUntilPrompt ended a reply on `/(?:^|\r?\n)#\s*$/`, checked after
   * every byte. Betaflight prints every diff heading through
   * cliPrintHashLine - `cliPrint("\r\n# "); cliPrintLine(str);`
   * (cli.c:368-376) - so `# version`, the FIRST thing `diff all` emits,
   * put `\r \n #` on the wire and the reader returned. capture() then
   * threw, and backup produced no file on any real board.
   *
   * NOW: the reader knows `diff` prints headings, so a prompt-shaped tail
   * is provisional until the batch terminator `batch end` (cli.c:8184-
   * 8187) has been seen. See cliReplyReader.
   */
  it('captures the whole document across four heading lines', async () => {
    const board = new VirtualCliBoard({settings: LONG_RANGE_SETTINGS});
    const backup = await cliService(board).capture(1, 0);

    // Every heading survived, including the one that used to end the read.
    expect(backup).toContain('# version');
    expect(backup).toContain('# start the command batch');
    expect(backup).toContain('# end the command batch');
    // And so did every setting.
    for (const [name, value] of LONG_RANGE_SETTINGS) {
      expect(backup).toContain(`set ${name} = ${value}`);
    }
    expect(restoreCommands(backup).length).toBeGreaterThanOrEqual(
      LONG_RANGE_SETTINGS.size,
    );
  });

  it('gives the identical document byte-by-byte, in fixed chunks and whole', async () => {
    // Chunk boundaries belong to USB, not to the protocol. If the answer
    // moved with them, the reader would be reading the transport.
    const captures: string[] = [];
    for (const chunking of [1, 3, 7, 64, 'whole'] as const) {
      const board = new VirtualCliBoard({
        settings: LONG_RANGE_SETTINGS,
        chunking,
      });
      captures.push(await cliService(board).capture(1, 0));
    }
    expect(new Set(captures).size).toBe(1);
  });

  it('is unchanged under a pseudo-random split of every reply', async () => {
    // A deterministic generator, so a failure is reproducible.
    let seed = 20260819;
    const next = (remaining: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return 1 + (seed % Math.max(1, Math.min(remaining, 11)));
    };
    const board = new VirtualCliBoard({
      settings: LONG_RANGE_SETTINGS,
      chunking: next,
    });
    const reference = new VirtualCliBoard({settings: LONG_RANGE_SETTINGS});
    expect(await cliService(board).capture(1, 0)).toBe(
      await cliService(reference).capture(1, 0),
    );
  });

  it('captures identically from a board that speaks LF instead of CRLF', async () => {
    const crlf = await cliService(
      new VirtualCliBoard({settings: LONG_RANGE_SETTINGS}),
    ).capture(1, 0);
    const lf = await cliService(
      new VirtualCliBoard({settings: LONG_RANGE_SETTINGS, lineEnding: '\n'}),
    ).capture(1, 0);
    expect(lf).toBe(crlf);
  });

  it('keeps the batch framing that makes the document replayable', async () => {
    const backup = await cliService(
      new VirtualCliBoard({settings: LONG_RANGE_SETTINGS}),
    ).capture(1, 0);
    const lines = backup.split('\n').map(line => line.trim());
    expect(lines).toContain('batch start');
    expect(lines).toContain('batch end');
    expect(lines.indexOf('batch start')).toBeLessThan(
      lines.indexOf('batch end'),
    );
  });

  it('times out rather than returning a partial document', async () => {
    // A board that stops talking mid-reply must not produce a backup.
    const board = new VirtualCliBoard({settings: LONG_RANGE_SETTINGS});
    board.silent = true;
    await expect(cliService(board).capture(1, 0)).rejects.toThrow();
    expect(board.savedFiles).toEqual([]);
  });

  it('refuses a diff that arrives without its terminator', async () => {
    // The dangerous case, and the reason the deadline fallback is
    // refused for `diff`: a truncated document still ends with a prompt
    // and still LOOKS like a configuration - `# version`, `batch start`,
    // a run of `set` lines. Only the missing `batch end` says it is half
    // of one. It must not become a backup file.
    //
    // This one costs the service's own 30s read budget, because proving
    // "the board stopped and we still refused" means waiting it out.
    const board = new VirtualCliBoard({
      settings: LONG_RANGE_SETTINGS,
      truncateDiffAfter: 6,
    });
    await expect(cliService(board).capture(1, 0)).rejects.toThrow();
    expect(board.savedFiles).toEqual([]);
  }, 45_000);

  it('captures a complete but EMPTY diff truthfully', async () => {
    // A board with nothing off-default emits the batch framing and no
    // `set` lines. That document is complete, not truncated, and the
    // difference matters: this must be accepted where the truncated one
    // above is refused.
    const board = new VirtualCliBoard({settings: new Map(), header: []});
    const backup = await cliService(board).capture(1, 0);
    expect(backup).toContain('batch start');
    expect(backup).toContain('batch end');
    expect(
      restoreCommands(backup).filter(line => line.startsWith('set ')),
    ).toEqual([]);
  });

  it('refuses to write a backup file that is not a valid CLI dump', async () => {
    const board = new VirtualCliBoard({settings: LONG_RANGE_SETTINGS});
    await expect(
      cliService(board).saveBackup('bad.txt', 'set x =  '),
    ).rejects.toThrow();
    expect(board.savedFiles).toEqual([]);
  });

  it('writes the captured document to a file byte for byte', async () => {
    const board = new VirtualCliBoard({settings: LONG_RANGE_SETTINGS});
    const service = cliService(board);
    const backup = await service.capture(1, 0);
    await expect(service.saveBackup('fpv.txt', backup)).resolves.toBe(true);
    expect(board.savedFiles).toEqual([{filename: 'fpv.txt', text: backup}]);
  });

  it('captures a DIFFERENT document for a different aircraft', async () => {
    const whoop = await cliService(
      new VirtualCliBoard({
        settings: new Map([
          ['battery_capacity', '300'],
          ['motor_pwm_protocol', 'DSHOT300'],
        ]),
      }),
    ).capture(1, 0);
    const longRange = await cliService(
      new VirtualCliBoard({settings: LONG_RANGE_SETTINGS}),
    ).capture(1, 0);
    expect(whoop).not.toBe(longRange);
    expect(whoop).toContain('set battery_capacity = 300');
    expect(longRange).toContain('set battery_capacity = 5000');
    expect(whoop).not.toContain('gps_provider');
  });
});

describe('restore - replaying a long-range backup onto a wiped board', () => {
  it('puts every setting back, then saves, and the board persists them', async () => {
    const document = betaflightDiffAll(LONG_RANGE_SETTINGS);
    // A freshly flashed, factory-reset board: three defaults, nothing else.
    const wiped = new VirtualCliBoard({
      settings: new Map([
        ['gps_provider', 'NONE'],
        ['failsafe_procedure', 'DROP'],
        ['motor_pwm_protocol', 'PWM'],
      ]),
    });
    const progress: Array<[number, number]> = [];
    const result = await cliService(wiped).restore(
      1,
      0,
      document,
      undefined,
      (done, total) => progress.push([done, total]),
    );

    expect(result.errors).toEqual([]);
    expect(result.commandCount).toBe(restoreCommands(document).length);
    expect(progress.at(-1)).toEqual([result.commandCount, result.commandCount]);
    expect(wiped.sawSave).toBe(true);

    // The comparison the whole exercise exists for: the board's PERSISTED
    // configuration equals the backup, setting for setting.
    for (const [name, value] of LONG_RANGE_SETTINGS) {
      expect(`${name}=${wiped.persisted.get(name)}`).toBe(`${name}=${value}`);
    }
  });

  it('strips `save` from the replay so the app controls when it happens', () => {
    const document = betaflightDiffAll(LONG_RANGE_SETTINGS);
    const commands = restoreCommands(`${document}\nsave`);
    expect(commands).not.toContain('save');
    expect(commands.some(line => line.startsWith('#'))).toBe(false);
  });

  /**
   * WAS: every rejected command was invisible, and the restore saved.
   *
   * restore() scans each reply for `/###ERROR/i`. The firmware writes a
   * refusal as `"###ERROR IN " cmd ": " detail "###"` (cli.c:474-486)
   * after a linefeed, so the wire carries `\r \n # # #` - and the old
   * reader stopped at the FIRST of those hashes, three bytes before the
   * word ERROR. `errors` stayed empty, the `errors.length === 0` guard
   * passed, `save` was issued, and the board persisted a partially
   * restored configuration while the UI reported success.
   *
   * NOW: the prompt requires hash-SPACE. `###` cannot match it, at any
   * chunking, with no timing involved - so the whole error line reaches
   * the caller. See cliReplyReader.
   */
  it('sees every rejected command, sends no save, and persists nothing', async () => {
    const document = betaflightDiffAll(LONG_RANGE_SETTINGS);
    // A replacement board on an older build with no GPS Rescue: three of
    // the backed-up settings do not exist on it. This is the real
    // scenario - a backup taken from one firmware, restored onto another.
    const older = new VirtualCliBoard({
      settings: new Map([['gps_provider', 'NONE']]),
      unknownSettings: new Set([
        'gps_rescue_min_start_dist',
        'gps_rescue_return_alt',
        'gps_rescue_min_sats',
      ]),
    });
    const result = await cliService(older).restore(1, 0, document);

    // The three refusals reached the caller, with the marker intact.
    expect(result.errors).toHaveLength(3);
    for (const error of result.errors) {
      expect(error).toContain('###ERROR');
      expect(error).toContain('INVALID NAME');
    }
    // THE NON-NEGOTIABLE RULE: one failed command means no save.
    expect(older.sawSave).toBe(false);
    expect(older.commands).not.toContain('save');
    expect(older.persisted.get('failsafe_procedure')).toBeUndefined();
  });

  it('sees the rejection at every chunking, including one byte at a time', async () => {
    const document = betaflightDiffAll(LONG_RANGE_SETTINGS);
    for (const chunking of [1, 2, 5, 'whole'] as const) {
      const board = new VirtualCliBoard({
        settings: new Map(),
        unknownSettings: new Set(['gps_rescue_min_sats']),
        chunking,
      });
      const result = await cliService(board).restore(1, 0, document);
      expect(`${chunking}: ${result.errors.length}`).toBe(`${chunking}: 1`);
      expect(`${chunking}: ${board.sawSave}`).toBe(`${chunking}: false`);
    }
  });

  it('refuses to save when only the LAST command fails', async () => {
    // The ordering trap: everything succeeded until the final line, so a
    // naive implementation has already convinced itself the job is done.
    const settings = new Map(LONG_RANGE_SETTINGS);
    const lastName = [...settings.keys()].at(-1) as string;
    const board = new VirtualCliBoard({
      settings: new Map(),
      unknownSettings: new Set([lastName]),
    });
    const result = await cliService(board).restore(
      1,
      0,
      betaflightDiffAll(settings),
    );
    expect(result.errors).toHaveLength(1);
    expect(board.sawSave).toBe(false);
    expect(board.persisted.size).toBe(0);
  });

  it('refuses a corrupt backup outright rather than replaying part of it', async () => {
    const board = new VirtualCliBoard({settings: new Map()});
    await expect(
      cliService(board).restore(1, 0, 'set gyro = \u0000'),
    ).rejects.toThrow();
    expect(board.commands).toEqual([]);
  });

  /**
   * THE FULL ROUND TRIP the acceptance brief asks for, end to end through
   * the real service, with nothing hand-fed in the middle:
   *
   *   configured board -> `diff all` capture -> simulated flash/reset ->
   *   reconnect -> restore -> save -> reconnect -> compare
   *
   * The comparison at the end is against the CAPTURED document, not
   * against the fixture, so a capture that quietly lost half the
   * settings would show up as a board that came back missing them.
   */
  it('ROUND TRIP: long-range board survives a flash and comes back identical', async () => {
    // 1. A configured long-range aircraft.
    const original = new VirtualCliBoard({settings: LONG_RANGE_SETTINGS});

    // 2. Back it up through the real service.
    const backup = await cliService(original).capture(1, 0);
    expect(backup).toContain('batch end');

    // 3. Flash and factory reset: a new board object with firmware
    //    defaults and none of the aircraft's settings.
    const afterFlash = new VirtualCliBoard({
      settings: new Map([
        ['gps_provider', 'NONE'],
        ['failsafe_procedure', 'DROP'],
        ['motor_pwm_protocol', 'PWM'],
      ]),
    });
    expect(afterFlash.persisted.get('battery_capacity')).toBeUndefined();

    // 4. Reconnect and restore.
    const result = await cliService(afterFlash).restore(1, 0, backup);
    expect(result.errors).toEqual([]);
    expect(afterFlash.sawSave).toBe(true);

    // 5. Reconnect again and read the board back the same way an
    //    operator would - another `diff all` through the same service.
    const afterRestore = await cliService(
      new VirtualCliBoard({settings: afterFlash.persisted}),
    ).capture(1, 0);

    // 6. Compare. Every setting the backup carried is on the board.
    const wanted = restoreCommands(backup).filter(line =>
      line.startsWith('set '),
    );
    expect(wanted.length).toBe(LONG_RANGE_SETTINGS.size);
    for (const line of wanted) {
      expect(afterRestore).toContain(line);
    }
    // And the settings the flash left behind did not survive as strays -
    // every one of them was overwritten by the backup.
    expect(afterRestore).toContain('set motor_pwm_protocol = DSHOT300');
    expect(afterRestore).toContain('set failsafe_procedure = GPS-RESCUE');
    expect(afterRestore).toContain('set gps_provider = UBLOX');
  });

  /**
   * The same round trip with ONE command deliberately refused. This is
   * the rule that is not negotiable: one failure means no save, and no
   * claim of success.
   */
  it('ROUND TRIP WITH A REJECTION: no save, no success, nothing persisted', async () => {
    const backup = await cliService(
      new VirtualCliBoard({settings: LONG_RANGE_SETTINGS}),
    ).capture(1, 0);

    const afterFlash = new VirtualCliBoard({
      settings: new Map([['motor_pwm_protocol', 'PWM']]),
      // One setting this build does not have - the single injected
      // rejection.
      unknownSettings: new Set(['gps_rescue_min_start_dist']),
    });
    const result = await cliService(afterFlash).restore(1, 0, backup);

    // The error was DETECTED, with the firmware's marker intact.
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('###ERROR');
    expect(result.errors[0]).toContain('gps_rescue_min_start_dist');
    // NO save was sent.
    expect(afterFlash.sawSave).toBe(false);
    expect(afterFlash.commands).not.toContain('save');
    // NOTHING was persisted, so a power cycle leaves the board as the
    // flash left it rather than half-configured.
    expect(afterFlash.persisted.get('gps_provider')).toBeUndefined();
    expect(afterFlash.persisted.get('failsafe_procedure')).toBeUndefined();
    // And the caller is told, so no UI can report success: both call
    // sites in FirmwareFlasherScreen throw on a non-empty `errors`.
    expect(result.errors.length > 0).toBe(true);
  });

  it('restores two different aircraft to two different configurations', async () => {
    const whoopSettings = new Map<string, string>([
      ['vbat_min_cell_voltage', '330'],
      ['vbat_max_cell_voltage', '435'],
      ['battery_capacity', '300'],
      ['motor_pwm_protocol', 'DSHOT300'],
    ]);
    const whoop = new VirtualCliBoard({settings: new Map()});
    const longRange = new VirtualCliBoard({settings: new Map()});
    await cliService(whoop).restore(1, 0, betaflightDiffAll(whoopSettings));
    await cliService(longRange).restore(
      1,
      0,
      betaflightDiffAll(LONG_RANGE_SETTINGS),
    );
    expect(whoop.persisted.get('battery_capacity')).toBe('300');
    expect(longRange.persisted.get('battery_capacity')).toBe('5000');
    expect(whoop.persisted.get('gps_provider')).toBeUndefined();
    expect(longRange.persisted.get('gps_provider')).toBe('UBLOX');
  });
});
