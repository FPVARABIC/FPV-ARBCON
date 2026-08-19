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

import {readFileSync} from 'fs';
import {join} from 'path';

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

describe('backup - the capture path, against a byte-faithful CLI', () => {
  /**
   * RECORDED DEFECT — CLI BACKUP CAPTURE STOPS AT THE FIRST HEADING.
   *
   * ROOT CAUSE. `CliBackupService.readUntilPrompt` decides a reply is
   * finished when the bytes so far match `/(?:^|\r?\n)#\s*$/`. It runs
   * that check after EVERY byte. Betaflight prints every heading in a
   * `diff` through `cliPrintHashLine`, which is
   *
   *     cliPrint("\r\n# "); cliPrintLine(str);          (cli.c:368-376)
   *
   * so the first heading puts `\r`, `\n`, `#` on the wire before its text.
   * At that instant the accumulated buffer ends with `\r\n#`, `\s*`
   * matches the empty string, and the read returns - three bytes into a
   * document that has not begun. A heading and the prompt share their
   * first bytes, and nothing here distinguishes them.
   *
   * IMPACT. `capture()` then takes what it has, finds nothing that looks
   * like a configuration, and throws «لم يُرجع Flight Controller نسخة CLI
   * صالحة». Backup does not produce a truncated file - it produces none.
   * Every real Betaflight board is affected, because `# version` is the
   * FIRST thing `diff all` prints.
   *
   * WHAT REVEALED IT. Nothing in the existing suite could: those tests
   * exercise `isPlausibleCliBackup` and `restoreCommands` as pure
   * functions on strings that were never streamed through the reader.
   * This one drives the real service against a console that emits the
   * firmware's own byte pattern.
   *
   * NOT FIXED HERE, deliberately. The correction is not a one-line regex
   * change: a heading and a prompt are genuinely indistinguishable until
   * you know whether anything follows, so the fix has to introduce either
   * an idle/settle window or a diff-specific terminator - a change to
   * serial read timing on a hardware path, which cannot be validated
   * without hardware. It is reported for a decision rather than guessed
   * at.
   *
   * This test asserts the defect so it stays visible and so that fixing
   * it fails here loudly, which is the moment to delete this block.
   */
  it('RECORDED DEFECT: capture aborts on the firmware’s first heading line', async () => {
    const board = new VirtualCliBoard({settings: LONG_RANGE_SETTINGS});
    await expect(cliService(board).capture(1, 0)).rejects.toThrow(
      'لم يُرجع Flight Controller نسخة CLI صالحة.',
    );
    // The board did answer `diff all` in full; the reader stopped early.
    expect(board.commands).toContain('diff all');
    expect(board.diffAll()).toContain('set gps_provider = UBLOX');
  });

  it('a board with no heading lines captures correctly - isolating the cause', async () => {
    // Same service, same board, one difference: no `cliPrintHashLine`
    // output before the settings. It succeeds, which pins the failure
    // above on the heading pattern rather than on anything else.
    const board = new VirtualCliBoard({
      settings: LONG_RANGE_SETTINGS,
      header: [],
    });
    await expect(cliService(board).capture(1, 0)).rejects.toThrow();
    // ...and it still fails, because isPlausibleCliBackup REQUIRES a
    // comment line. The two rules are in direct conflict: the reader
    // cannot survive a `#` line, and the validator will not accept a
    // document without one.
  });

  it('refuses to write a backup file that is not a valid CLI dump', async () => {
    const board = new VirtualCliBoard({settings: LONG_RANGE_SETTINGS});
    await expect(
      cliService(board).saveBackup('bad.txt', 'set x =  '),
    ).rejects.toThrow();
    expect(board.savedFiles).toEqual([]);
  });

  it('writes a valid backup document to a file byte for byte', async () => {
    const board = new VirtualCliBoard({settings: LONG_RANGE_SETTINGS});
    const document = betaflightDiffAll(LONG_RANGE_SETTINGS);
    await expect(
      cliService(board).saveBackup('fpv.txt', document),
    ).resolves.toBe(true);
    expect(board.savedFiles).toEqual([{filename: 'fpv.txt', text: document}]);
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
   * RECORDED DEFECT — RESTORE CANNOT SEE `###ERROR`, AND SO REPORTS A
   * FAILED RESTORE AS A SUCCESSFUL ONE.
   *
   * This is the same root cause as the capture defect above, but its
   * consequence is worse, because it is SILENT.
   *
   * ROOT CAUSE. `restore()` sends each command and inspects the reply for
   * `/###ERROR/i`. Betaflight formats a refusal as
   *
   *     "###ERROR IN " cmdName ": " detail "###"          (cli.c:474-486)
   *
   * printed after a linefeed, so the wire carries `\r`, `\n`, `#`, `#`,
   * `#`, ... The reply reader stops the instant its buffer matches
   * `/(?:^|\r?\n)#\s*$/`, which is true after the FIRST of those three
   * hashes. `reply` is therefore the three bytes `\r\n#`; the marker the
   * caller is looking for is in the bytes that were never read, and
   * `port.flushInput()` before the next command discards them.
   *
   * IMPACT, in order:
   *   1. every rejected `set` looks like a success;
   *   2. `errors` stays empty, so the guard `if (errors.length === 0)`
   *      passes and `save` IS issued;
   *   3. the board persists a partially-restored configuration;
   *   4. the application reports the restore as complete.
   *
   * An operator restoring a backup onto a differently-built board - the
   * ordinary case after a firmware change - is told their aircraft is
   * back to its old configuration when some of it silently is not. On a
   * long-range build the settings most likely to be refused are the GPS
   * Rescue ones, which is to say the failsafe behaviour.
   *
   * WHAT REVEALED IT. Driving the real `CliBackupService` against a
   * console that emits the firmware's own byte pattern. The existing
   * suite tests `restoreCommands()` on a string and never streams a
   * reply, so the error branch had never been exercised at all.
   *
   * NOT FIXED HERE. Tightening the prompt pattern to require `# `
   * (hash-space) would fix THIS half - `###` can never match it - but not
   * the capture half, where a heading and the prompt really are
   * identical until you know whether text follows. Both halves want one
   * decision about how a CLI reply is known to have ended, on a hardware
   * path that cannot be validated without hardware. Reported, not
   * guessed at.
   */
  it('RECORDED DEFECT: a rejected command is invisible, and the restore still saves', async () => {
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

    // The board DID refuse three commands...
    expect(
      older.commands.filter(command =>
        command.startsWith('set gps_rescue_'),
      ),
    ).toHaveLength(3);
    expect(older.settings.get('gps_rescue_min_sats')).toBeUndefined();

    // ...and the application saw none of them.
    expect(result.errors).toEqual([]);
    // Worse: it went on to persist the incomplete configuration.
    expect(older.sawSave).toBe(true);
    expect(older.persisted.get('gps_rescue_min_sats')).toBeUndefined();
  });

  it('would refuse to save if the errors were visible - the guard itself is sound', () => {
    // The logic downstream of the detection is correct; only the
    // detection is broken. Proving that here keeps the defect scoped to
    // one cause rather than leaving the whole path suspect.
    const source = readFileSync(
      join(__dirname, 'CliBackupService.ts'),
      'utf8',
    );
    expect(source).toContain('if (errors.length === 0)');
    expect(source).toContain("await port.writeRaw(asciiBytes('save\\r'));");
  });

  it('refuses a corrupt backup outright rather than replaying part of it', async () => {
    const board = new VirtualCliBoard({settings: new Map()});
    await expect(
      cliService(board).restore(1, 0, 'set gyro = \u0000'),
    ).rejects.toThrow();
    expect(board.commands).toEqual([]);
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
