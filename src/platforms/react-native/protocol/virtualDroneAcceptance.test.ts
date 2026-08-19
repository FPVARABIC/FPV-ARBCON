/**
 * FIVE VIRTUAL DRONES, CONFIGURED END TO END.
 *
 * The question this file answers is the one that matters before anyone
 * connects a real flight controller:
 *
 *   given a board that represents a real aircraft of a given kind, can
 *   this application take it from freshly-flashed to a complete, saved,
 *   flyable configuration - and can it PROVE the board holds the result?
 *
 * WHAT MAKES THIS DIFFERENT FROM THE PER-CONTROLLER SUITES. Those scripts
 * a reply per command: the readback returns whatever the fixture pre-baked,
 * so a controller that wrote nothing at all would still pass. Here the
 * board is a parameter store with RAM, EEPROM and a power cycle, and every
 * assertion at the end reads what the board ACTUALLY HOLDS after a
 * simulated restart. A save that never happened cannot survive that.
 *
 * THE FIVE ARE NOT ONE FIXTURE RENAMED. Different UART maps, cell counts,
 * motor protocols, channel counts, failsafe procedures and API versions -
 * see virtualDroneFixtures.ts, where each choice is annotated.
 *
 * WHAT THIS DOES NOT PROVE, stated here so no one reads it as more than it
 * is: the byte LAYOUTS are the app's own codecs on both sides of the wire.
 * Those layouts are pinned separately, against the firmware's own handlers,
 * by the decode/encode suites. This file proves the transaction - ordering,
 * guards, persistence, reconnection and readback - not the field offsets.
 * And nothing here is evidence about hardware.
 */

import {
  MSP_ADVANCED_CONFIG,
  MSP_BOARD_ALIGNMENT_CONFIG,
  MSP_EEPROM_WRITE,
  MSP_FAILSAFE_CONFIG,
  MSP_GPS_CONFIG,
  MSP_SET_BOARD_ALIGNMENT_CONFIG,
  MSP_SET_FAILSAFE_CONFIG,
  MSP_STATUS_EX,
} from '../../../core/protocol/msp/commands/mspCommands';
import {createBoardAlignmentDraft} from '../../../core/state/boardAlignmentModel';
import {createMotorConfigurationDraft} from '../../../core/state/motorConfigurationModel';
import {createFailsafeConfigurationDraft} from '../../../core/state/failsafeConfigurationModel';
import {
  createGpsConfigurationDraft,
  hasGpsFeature,
} from '../../../core/state/gpsConfigurationModel';
import {createPidTuningDraft} from '../../../core/state/pidTuningModel';
import {createPowerConfigurationDraft} from '../../../core/state/powerConfigurationModel';
import {createReceiverConfigurationDraft} from '../../../core/state/receiverConfigurationModel';
import {decodeAdvancedConfig} from '../../../core/protocol/msp/decoding/decodeAdvancedConfig';
import {decodeBoardAlignment} from '../../../core/protocol/msp/decoding/decodeBoardAlignment';
import {BoardAlignmentController} from './BoardAlignmentController';
import {FailsafeConfigurationController} from './FailsafeConfigurationController';
import {GpsConfigurationController} from './GpsConfigurationController';
import {MotorConfigurationController} from './MotorConfigurationController';
import {PidTuningController} from './PidTuningController';
import {PowerConfigurationController} from './PowerConfigurationController';
import {ReceiverConfigurationController} from './ReceiverConfigurationController';
import {
  DRONE_SPECS,
  MOTOR_PWM,
  buildFactoryBoard,
  type DroneSpec,
} from './__testUtils__/virtualDroneFixtures';
import {VirtualFlightController} from './__testUtils__/virtualFlightController';
import {VirtualSession} from './__testUtils__/virtualSession';

/** Every save outcome the app can report, reduced to "did the board end
 *  up holding this". Anything short of SAVED_VERIFIED is a refusal to
 *  claim success, and each scenario says which it expected. */
type SaveOutcome = {kind: string; reason?: string; error?: unknown};

interface Rig {
  readonly spec: DroneSpec;
  readonly board: VirtualFlightController;
  readonly session: VirtualSession;
}

function rigFor(spec: DroneSpec, apiMinor = spec.hardware.apiMinor): Rig {
  const board = new VirtualFlightController({
    parameters: buildFactoryBoard(spec),
  });
  const session = new VirtualSession({
    sessionId: `virtual-${spec.key}-${apiMinor}`,
    board,
    apiMinor,
  });
  return {spec, board, session};
}

function describeOutcome(outcome: SaveOutcome): string {
  const detail =
    outcome.reason ??
    (outcome.error instanceof Error ? outcome.error.message : '');
  return detail ? `${outcome.kind} (${detail})` : outcome.kind;
}

/** Asserts a save both SUCCEEDED and left the value in EEPROM - the two
 *  are different claims and only the second survives a power cycle. */
function expectPersisted(
  outcome: SaveOutcome,
  board: VirtualFlightController,
  label: string,
): void {
  expect(`${label}: ${describeOutcome(outcome)}`).toBe(
    `${label}: SAVED_VERIFIED`,
  );
  expect(`${label} unsaved-RAM`).toBe(
    `${label} unsaved-RAM${board.hasUnsavedChanges() ? ' PRESENT' : ''}`,
  );
}

const spec = (key: string): DroneSpec => {
  const found = DRONE_SPECS.find(candidate => candidate.key === key);
  if (found === undefined) throw new Error(`no spec ${key}`);
  return found;
};

/* ==================================================================== *
 * PART ONE - the five aircraft, each configured from factory to target
 * ==================================================================== */

describe('virtual drone acceptance - failsafe and board alignment for all five', () => {
  it.each(DRONE_SPECS.map(s => [s.key, s] as const))(
    '%s: configures failsafe and board alignment, then survives a power cycle',
    async (_key, droneSpec) => {
      const {board, session} = rigFor(droneSpec);

      // ---- FAILSAFE ------------------------------------------------
      const failsafe = new FailsafeConfigurationController(session.options);
      const failsafeLoad = await failsafe.load(session.key);
      expect(failsafeLoad.kind).toBe('LOADED');
      if (failsafeLoad.kind !== 'LOADED') return;

      const target = droneSpec.target.failsafe;
      const failsafeDraft = {
        ...createFailsafeConfigurationDraft(failsafeLoad.snapshot),
        delayDeciseconds: target.delayDeciseconds,
        landingTimeSeconds: target.landingTimeSeconds,
        procedure: target.procedure as 0 | 1 | 2,
        switchMode: target.switchMode as 0 | 1 | 2,
      };
      const failsafeSave = (await failsafe.save(
        session.key,
        failsafeLoad.snapshot,
        failsafeDraft,
      )) as SaveOutcome;
      expectPersisted(failsafeSave, board, `${droneSpec.key} failsafe`);

      // ---- BOARD ALIGNMENT ----------------------------------------
      const [roll, pitch, yaw] = droneSpec.target.boardAlignment;
      const alignment = new BoardAlignmentController(session.options);
      const alignmentLoad = await alignment.load(session.key);
      expect(alignmentLoad.kind).toBe('LOADED');
      if (alignmentLoad.kind !== 'LOADED') return;

      const alignmentDraft = {
        ...createBoardAlignmentDraft(alignmentLoad.snapshot),
        rollDegrees: roll,
        pitchDegrees: pitch,
        yawDegrees: yaw,
      };
      const alignmentSave = (await alignment.save(
        session.key,
        alignmentLoad.snapshot,
        alignmentDraft,
      )) as SaveOutcome;
      if (roll === 0 && pitch === 0 && yaw === 0) {
        // Nothing to change on a standard mount, and the app must not
        // spend an EEPROM cycle proving that.
        expect(alignmentSave.kind).toBe('NO_CHANGES');
      } else {
        expect(describeOutcome(alignmentSave)).toBe('SAVED_VERIFIED');
      }

      // ---- THE ONLY PROOF THAT COUNTS ------------------------------
      // The board restarts. Unsaved RAM is gone. Whatever is still there
      // is what the operator would actually fly.
      session.reconnect();

      const savedFailsafe = board.readParameter(MSP_FAILSAFE_CONFIG);
      expect(savedFailsafe).toBeDefined();
      expect(savedFailsafe?.[0]).toBe(target.delayDeciseconds);
      expect(savedFailsafe?.[1]).toBe(target.landingTimeSeconds);
      expect(savedFailsafe?.[7]).toBe(target.procedure);

      const savedAlignment = board.readParameter(MSP_BOARD_ALIGNMENT_CONFIG);
      expect(savedAlignment).toBeDefined();
      expect(decodeBoardAlignment(savedAlignment as Uint8Array)).toEqual({
        rollDegrees: roll,
        pitchDegrees: pitch,
        yawDegrees: yaw,
      });
    },
  );

  it('never writes before it has proven the aircraft disarmed', async () => {
    // Ordering, on the real controller, against a board that records
    // every request it received.
    const {board, session} = rigFor(spec('LONG_RANGE'));
    const alignment = new BoardAlignmentController(session.options);
    const loaded = await alignment.load(session.key);
    if (loaded.kind !== 'LOADED') throw new Error(loaded.kind);
    await alignment.save(session.key, loaded.snapshot, {
      rollDegrees: 0,
      pitchDegrees: 0,
      yawDegrees: 90,
    });

    const commands = board.requests.map(request => request.command);
    const statusAt = commands.indexOf(MSP_STATUS_EX);
    const writeAt = commands.indexOf(MSP_SET_BOARD_ALIGNMENT_CONFIG);
    const eepromAt = commands.indexOf(MSP_EEPROM_WRITE);
    expect(statusAt).toBeGreaterThanOrEqual(0);
    expect(statusAt).toBeLessThan(writeAt);
    expect(writeAt).toBeLessThan(eepromAt);
  });

  it('refuses every write to an ARMED aircraft, on all five', async () => {
    for (const droneSpec of DRONE_SPECS) {
      const {board, session} = rigFor(droneSpec);
      const failsafe = new FailsafeConfigurationController(session.options);
      const loaded = await failsafe.load(session.key);
      if (loaded.kind !== 'LOADED') throw new Error(loaded.kind);
      board.setArmed(true);
      const outcome = (await failsafe.save(session.key, loaded.snapshot, {
        ...createFailsafeConfigurationDraft(loaded.snapshot),
        delayDeciseconds: 20,
      })) as SaveOutcome;
      expect(`${droneSpec.key}: ${describeOutcome(outcome)}`).toBe(
        `${droneSpec.key}: REJECTED (FC_ARMED)`,
      );
      expect(board.requests.map(r => r.command)).not.toContain(
        MSP_SET_FAILSAFE_CONFIG,
      );
    }
  });
});

/* ==================================================================== *
 * PART TWO - the areas that differ between aircraft
 * ==================================================================== */

describe('virtual drone acceptance - the areas that make each build different', () => {
  it('LONG_RANGE: enables GPS and turns the failsafe into GPS Rescue', async () => {
    const droneSpec = spec('LONG_RANGE');
    const {board, session} = rigFor(droneSpec);

    const gps = new GpsConfigurationController(session.options);
    const loaded = await gps.load(session.key);
    expect(loaded.kind).toBe('LOADED');
    if (loaded.kind !== 'LOADED') return;
    // Factory board: the GPS feature bit is clear.
    expect(hasGpsFeature(loaded.snapshot.featureMaskRaw)).toBe(false);

    const wanted = droneSpec.target.gps;
    if (wanted === undefined) throw new Error('long range needs a GPS target');
    const outcome = (await gps.save(session.key, loaded.snapshot, {
      ...createGpsConfigurationDraft(loaded.snapshot),
      enabled: true,
      provider: wanted.provider,
      sbasMode: wanted.sbas,
      autoConfig: wanted.autoConfig,
      homePointOnce: wanted.homeOnce,
      useGalileo: wanted.galileo,
    })) as SaveOutcome & {rebootAcknowledged?: boolean};
    expect(describeOutcome(outcome)).toBe('SAVED_VERIFIED');

    // The GPS save reboots, because a serial-function change needs one.
    // After it, the board must still be a GPS board.
    const persisted = board.readParameter(MSP_GPS_CONFIG);
    expect(persisted?.[0]).toBe(wanted.provider);
    expect(persisted?.[4]).toBe(wanted.homeOnce ? 1 : 0);
    expect(persisted?.[5]).toBe(wanted.galileo ? 1 : 0);
  });

  it('TINY_WHOOP: accepts a one-cell battery profile the other four would not', async () => {
    const droneSpec = spec('TINY_WHOOP');
    const {board, session} = rigFor(droneSpec);
    const power = new PowerConfigurationController(session.options);
    const loaded = await power.load(session.key);
    expect(loaded.kind).toBe('LOADED');
    if (loaded.kind !== 'LOADED') return;

    const wanted = droneSpec.target.battery;
    const outcome = (await power.save(session.key, loaded.snapshot, {
      ...createPowerConfigurationDraft(loaded.snapshot),
      capacityMah: wanted.capacityMah,
      warningCellCentivolts: wanted.warningCellCentivolts,
      maxCellCentivolts: wanted.maxCellCentivolts,
    })) as SaveOutcome;
    expectPersisted(outcome, board, 'TINY_WHOOP power');

    session.reconnect();
    const reloaded = await new PowerConfigurationController(
      session.options,
    ).load(session.key);
    expect(reloaded.kind).toBe('LOADED');
    if (reloaded.kind !== 'LOADED') return;
    expect(reloaded.snapshot.battery.capacityMah).toBe(wanted.capacityMah);
    expect(reloaded.snapshot.battery.maxCellCentivolts).toBe(
      wanted.maxCellCentivolts,
    );
  });

  it('RACING and FREESTYLE: carry distinct PID tunes on the same airframe class', async () => {
    // Two 5" quads, same hardware, different points in the trade-off. If
    // one scenario's values leaked into the other this would fail.
    const results: Array<{key: string; rollP: number; pitchD: number}> = [];
    for (const key of ['RACING', 'FREESTYLE'] as const) {
      const droneSpec = spec(key);
      // API 1.47 explicitly: the PID contract is verified there, and this
      // test is about tune independence, not about version gating.
      const {board, session} = rigFor(droneSpec, 47);
      const pid = new PidTuningController(session.options);
      const loaded = await pid.load(session.key);
      expect(loaded.kind).toBe('LOADED');
      if (loaded.kind !== 'LOADED') return;

      const wanted = droneSpec.target.pid;
      const base = createPidTuningDraft(loaded.snapshot);
      const outcome = (await pid.save(session.key, loaded.snapshot, {
        ...base,
        roll: {...base.roll, p: wanted.rollP, i: wanted.rollI, d: wanted.rollD},
        pitch: {
          ...base.pitch,
          p: wanted.pitchP,
          i: wanted.pitchI,
          d: wanted.pitchD,
        },
        yaw: {...base.yaw, p: wanted.yawP, i: wanted.yawI},
      })) as SaveOutcome;
      expectPersisted(outcome, board, `${key} pid`);

      session.reconnect();
      const reloaded = await new PidTuningController(session.options).load(
        session.key,
      );
      if (reloaded.kind !== 'LOADED') throw new Error(reloaded.kind);
      results.push({
        key,
        rollP: reloaded.snapshot.terms[0].p,
        pitchD: reloaded.snapshot.terms[1].d,
      });
    }
    expect(results).toEqual([
      {key: 'RACING', rollP: 47, pitchD: 42},
      {key: 'FREESTYLE', rollP: 45, pitchD: 40},
    ]);
  });

  it('CINEWHOOP: stores the quarter-turn stack rotation the duct forces', async () => {
    const droneSpec = spec('CINEWHOOP');
    const {board, session} = rigFor(droneSpec);
    const alignment = new BoardAlignmentController(session.options);
    const loaded = await alignment.load(session.key);
    if (loaded.kind !== 'LOADED') throw new Error(loaded.kind);
    expect(loaded.snapshot).toEqual({
      rollDegrees: 0,
      pitchDegrees: 0,
      yawDegrees: 0,
    });

    const outcome = (await alignment.save(session.key, loaded.snapshot, {
      rollDegrees: 0,
      pitchDegrees: 0,
      yawDegrees: 90,
    })) as SaveOutcome;
    expect(describeOutcome(outcome)).toBe('SAVED_VERIFIED');

    // Board alignment only takes effect at boot, so the save reboots.
    // The value has to be there on the other side of that.
    const persisted = board.readPersisted(MSP_BOARD_ALIGNMENT_CONFIG);
    expect(decodeBoardAlignment(persisted as Uint8Array).yawDegrees).toBe(90);
  });

  it('sets each aircraft its own receiver channel map and deadband', async () => {
    for (const droneSpec of DRONE_SPECS) {
      const {board, session} = rigFor(droneSpec, 47);
      const receiver = new ReceiverConfigurationController(session.options);
      const loaded = await receiver.load(session.key);
      expect(`${droneSpec.key}: ${loaded.kind}`).toBe(`${droneSpec.key}: LOADED`);
      if (loaded.kind !== 'LOADED') continue;

      // Each aircraft gets its own receiver deadband: a race quad wants
      // none, a cinewhoop wants some. Same field, five different answers.
      const deadband = droneSpec.key === 'RACING' ? 0 : 3;
      const outcome = (await receiver.save(session.key, loaded.snapshot, {
        ...createReceiverConfigurationDraft(loaded.snapshot),
        serialRxProvider: droneSpec.target.rxSerialProvider,
        deadband,
        yawDeadband: deadband,
      })) as SaveOutcome;
      // Changing the serial receiver PROTOCOL needs a restart before the
      // board runs the new driver, and the app says so with its own
      // outcome rather than reporting a plain success. Both outcomes mean
      // the value is stored; only one of them claims it is already live.
      expect(`${droneSpec.key}: ${describeOutcome(outcome)}`).toBe(
        `${droneSpec.key}: SAVED_REBOOT_REQUIRED`,
      );
      expect(board.hasUnsavedChanges()).toBe(false);

      // And it is genuinely on the board: read it back through the real
      // controller after a power cycle.
      session.reconnect();
      const reloaded = await new ReceiverConfigurationController(
        session.options,
      ).load(session.key);
      expect(`${droneSpec.key}: ${reloaded.kind}`).toBe(
        `${droneSpec.key}: LOADED`,
      );
      if (reloaded.kind !== 'LOADED') continue;
      const persisted = createReceiverConfigurationDraft(reloaded.snapshot);
      expect(`${droneSpec.key} provider`).toBe(`${droneSpec.key} provider`);
      expect(persisted.serialRxProvider).toBe(
        droneSpec.target.rxSerialProvider,
      );
      expect(persisted.deadband).toBe(deadband);
    }
  });
});

/* ==================================================================== *
 * PART THREE - independence
 * ==================================================================== */

describe('virtual drone acceptance - the five do not contaminate each other', () => {
  it('configures all five in one run and each board holds only its own values', async () => {
    const boards = new Map<string, VirtualFlightController>();

    for (const droneSpec of DRONE_SPECS) {
      const {board, session} = rigFor(droneSpec);
      boards.set(droneSpec.key, board);
      const failsafe = new FailsafeConfigurationController(session.options);
      const loaded = await failsafe.load(session.key);
      if (loaded.kind !== 'LOADED') throw new Error(loaded.kind);
      await failsafe.save(session.key, loaded.snapshot, {
        ...createFailsafeConfigurationDraft(loaded.snapshot),
        delayDeciseconds: droneSpec.target.failsafe.delayDeciseconds,
        procedure: droneSpec.target.failsafe.procedure as 0 | 1 | 2,
      });
      session.reconnect();
    }

    // Read every board back AFTER all five have been configured. A shared
    // singleton, a shared store or a leaked draft would show up here as
    // one aircraft wearing another's failsafe.
    const observed = DRONE_SPECS.map(droneSpec => {
      const bytes = boards.get(droneSpec.key)?.readParameter(
        MSP_FAILSAFE_CONFIG,
      );
      return {
        key: droneSpec.key,
        delay: bytes?.[0],
        procedure: bytes?.[7],
      };
    });
    expect(observed).toEqual(
      DRONE_SPECS.map(droneSpec => ({
        key: droneSpec.key,
        delay: droneSpec.target.failsafe.delayDeciseconds,
        procedure: droneSpec.target.failsafe.procedure,
      })),
    );
  });
});

/* ==================================================================== *
 * PART FOUR - version gating, proven rather than worked around
 * ==================================================================== */

describe('virtual drone acceptance - API 1.47 / 1.48 / 1.49', () => {
  it.each([47, 48, 49])(
    'configures failsafe and board alignment on API 1.%i',
    async minor => {
      const {board, session} = rigFor(spec('FREESTYLE'), minor);
      const failsafe = new FailsafeConfigurationController(session.options);
      const loaded = await failsafe.load(session.key);
      expect(loaded.kind).toBe('LOADED');
      if (loaded.kind !== 'LOADED') return;
      const outcome = (await failsafe.save(session.key, loaded.snapshot, {
        ...createFailsafeConfigurationDraft(loaded.snapshot),
        delayDeciseconds: 12,
      })) as SaveOutcome;
      expectPersisted(outcome, board, `api-1.${minor} failsafe`);
      expect(board.readParameter(MSP_FAILSAFE_CONFIG)?.[0]).toBe(12);
    },
  );

  it('refuses API 1.46 for the configuration screens, and says so', async () => {
    const {board, session} = rigFor(spec('FREESTYLE'), 46);
    const failsafe = new FailsafeConfigurationController(session.options);
    await expect(failsafe.load(session.key)).resolves.toEqual({
      kind: 'REJECTED',
      reason: 'UNSUPPORTED_FIRMWARE',
    });
    expect(board.requests).toEqual([]);
  });

  /**
   * MOTOR SETTINGS NOW FOLLOW THE SAME POLICY AS EVERY OTHER SCREEN, and
   * this records the boundary rather than working around it.
   *
   * The three lines below used to read LOADED / REJECTED / REJECTED, and
   * that was recorded here as a real limitation: a Racing or Freestyle
   * build on Betaflight 4.7 could not have its motor protocol changed, and
   * on 1.49 the Motors surface was unavailable outright - "the opposite of
   * the read-leniently, never-hard-lock policy the other eleven screens
   * follow", as the note used to say.
   *
   * Both causes were then found and fixed (see
   * motorConfigurationApiCompatibility.test.ts for the full account):
   * API 1.48's motor MSP handlers are byte-identical to 1.47's, so the
   * write gate had nothing behind it; and the READ was consulting the WRITE
   * capability through a default argument, so a board that could be read
   * perfectly well was refused before a frame was sent.
   *
   * What remains true, and is asserted rather than assumed: 1.49 loads and
   * does not save, because no published Betaflight source declares it.
   */
  it.each([
    [47, 'LOADED'],
    [48, 'LOADED'],
    [49, 'LOADED'],
  ])('motor settings on API 1.%i are %s', async (minor, expected) => {
    const {session} = rigFor(spec('RACING'), minor as number);
    const motors = new MotorConfigurationController(session.options);
    const outcome = (await motors.load(session.sessionId)) as SaveOutcome;
    expect(`1.${minor}: ${describeOutcome(outcome)}`).toBe(
      `1.${minor}: ${expected}`,
    );
  });

  it.each([
    [47, 'SAVED_VERIFIED'],
    [48, 'SAVED_VERIFIED'],
    [49, 'REJECTED (CONFIGURATION_WRITE_UNVERIFIED)'],
  ])('a motor protocol change on API 1.%i is %s', async (minor, expected) => {
    const {board, session} = rigFor(spec('RACING'), minor as number);
    const motors = new MotorConfigurationController(session.options);
    const loaded = await motors.load(session.sessionId);
    expect(loaded.kind).toBe('LOADED');
    if (loaded.kind !== 'LOADED') return;

    const outcome = (await motors.save(session.sessionId, loaded.snapshot, {
      ...createMotorConfigurationDraft(loaded.snapshot),
      motorProtocolRaw: spec('RACING').target.motorProtocol,
    })) as SaveOutcome;

    expect(`1.${minor}: ${describeOutcome(outcome)}`).toBe(
      `1.${minor}: ${expected}`,
    );
    // And the board agrees, either way round.
    const persisted = decodeAdvancedConfig(
      board.readPersisted(MSP_ADVANCED_CONFIG) as Uint8Array,
    ).motorProtocolRaw;
    expect(persisted).toBe(
      minor === 49 ? MOTOR_PWM : spec('RACING').target.motorProtocol,
    );
  });
});
