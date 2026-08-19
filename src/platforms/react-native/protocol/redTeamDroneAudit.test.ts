/**
 * TWELVE NEW AIRCRAFT, DRIVEN UNTIL SOMETHING BREAKS.
 *
 * This is not the acceptance suite run again with different names. The
 * acceptance suite asks "can the app configure an aircraft"; this one asks
 * "what can the app be made to claim that is not true".
 *
 * Every value in redTeamDroneFixtures.ts differs from the five originals,
 * so nothing here can pass because a number happened to be shared, and the
 * spread is chosen for edges - the smallest legal battery, the sparsest
 * UART map, two nearly-identical whoops, GPS hardware with rescue
 * deliberately NOT selected, and a build with no GPS at all.
 *
 * THE QUESTION EVERY SCENARIO IS A FORM OF: can this application report
 * success for something the aircraft does not hold? A save that is refused
 * is a good outcome. A save that fails and says so is a good outcome. The
 * only bad outcome is a save that says SAVED_VERIFIED over a board whose
 * EEPROM disagrees - and every assertion below reads the board rather than
 * the app's own account of it.
 *
 * WHAT IS STILL NOT PROVEN HERE: nothing in this file has been near a
 * flight controller. The byte layouts are the app's own codecs on both
 * sides of the wire; they are pinned against the firmware's handlers by
 * the decode/encode suites, not here.
 */

import {
  MSP_ADVANCED_CONFIG,
  MSP_BOARD_ALIGNMENT_CONFIG,
  MSP_EEPROM_WRITE,
  MSP_FAILSAFE_CONFIG,
  MSP_FEATURE_CONFIG,
  MSP_MOTOR_3D_CONFIG,
  MSP_SET_FEATURE_CONFIG,
  MSP_STATUS_EX,
} from '../../../core/protocol/msp/commands/mspCommands';
import {decodeAdvancedConfig} from '../../../core/protocol/msp/decoding/decodeAdvancedConfig';
import {decodeBoardAlignment} from '../../../core/protocol/msp/decoding/decodeBoardAlignment';
import {decodeFeatureConfig} from '../../../core/protocol/msp/decoding/decodeFeatureConfig';
import {decodeMotor3dConfig} from '../../../core/protocol/msp/decoding/decodeMotor3dConfig';
import {createBoardAlignmentDraft} from '../../../core/state/boardAlignmentModel';
import {createFailsafeConfigurationDraft} from '../../../core/state/failsafeConfigurationModel';
import {createMotorConfigurationDraft} from '../../../core/state/motorConfigurationModel';
import {createPidTuningDraft} from '../../../core/state/pidTuningModel';
import {createPowerConfigurationDraft} from '../../../core/state/powerConfigurationModel';
import {BoardAlignmentController} from './BoardAlignmentController';
import {FailsafeConfigurationController} from './FailsafeConfigurationController';
import {MotorConfigurationController} from './MotorConfigurationController';
import {PidTuningController} from './PidTuningController';
import {PowerConfigurationController} from './PowerConfigurationController';
import {buildFactoryBoard, type DroneSpec} from './__testUtils__/virtualDroneFixtures';
import {
  FIRMWARE_STOCK_3D_BAND,
  RED_TEAM_SPECS,
  redTeamSpec,
} from './__testUtils__/redTeamDroneFixtures';
import {VirtualFlightController} from './__testUtils__/virtualFlightController';
import {VirtualSession} from './__testUtils__/virtualSession';

type Outcome = {kind: string; reason?: string; error?: unknown};

/**
 * Every board built by this file, so the report can quote real counters
 * instead of estimating them. Registered on construction; totalled by the
 * last test in the file.
 */
const FLEET: VirtualFlightController[] = [];

interface Rig {
  readonly spec: DroneSpec;
  readonly board: VirtualFlightController;
  readonly session: VirtualSession;
}

function rig(spec: DroneSpec, apiMinor = spec.hardware.apiMinor): Rig {
  const board = new VirtualFlightController({
    parameters: buildFactoryBoard(spec),
  });
  FLEET.push(board);
  const session = new VirtualSession({
    sessionId: `redteam-${spec.key}-${apiMinor}`,
    board,
    apiMinor,
  });
  return {spec, board, session};
}

function describeOutcome(outcome: Outcome): string {
  const detail =
    outcome.reason ??
    (outcome.error instanceof Error ? outcome.error.message : '');
  return detail ? `${outcome.kind} (${detail})` : outcome.kind;
}

/** A save the board must actually be holding afterwards. */
function expectPersisted(
  outcome: Outcome,
  board: VirtualFlightController,
  label: string,
): void {
  expect(`${label}: ${describeOutcome(outcome)}`).toBe(
    `${label}: SAVED_VERIFIED`,
  );
  expect(`${label} unsaved`).toBe(
    `${label} unsaved${board.hasUnsavedChanges() ? ' RAM-ONLY' : ''}`,
  );
}

/* ==================================================================== *
 * PART 1 - THE FULL JOURNEY, ALL TWELVE
 *
 *   load two screens -> edit both -> save both -> EEPROM -> power cycle
 *   -> reconnect -> load again -> compare against the board's EEPROM
 * ==================================================================== */

describe('red team: the whole journey, twelve aircraft', () => {
  it.each(RED_TEAM_SPECS.map(s => [s.key, s] as const))(
    '%s: two screens configured, then proven across a power cycle',
    async (_key, spec) => {
      const {board, session} = rig(spec);
      const label = spec.key;

      // ---- SCREEN ONE: failsafe -----------------------------------
      const failsafe = new FailsafeConfigurationController(session.options);
      const failsafeLoad = await failsafe.load(session.key);
      expect(`${label} failsafe load`).toBe(
        `${label} failsafe load${failsafeLoad.kind === 'LOADED' ? '' : ` FAILED ${failsafeLoad.kind}`}`,
      );
      if (failsafeLoad.kind !== 'LOADED') return;

      const wanted = spec.target.failsafe;
      const failsafeSave = (await failsafe.save(
        session.key,
        failsafeLoad.snapshot,
        {
          ...createFailsafeConfigurationDraft(failsafeLoad.snapshot),
          delayDeciseconds: wanted.delayDeciseconds,
          landingTimeSeconds: wanted.landingTimeSeconds,
          procedure: wanted.procedure as 0 | 1 | 2,
          switchMode: wanted.switchMode as 0 | 1 | 2,
        },
      )) as Outcome;
      expectPersisted(failsafeSave, board, `${label} failsafe`);

      // ---- SCREEN TWO: board alignment ----------------------------
      const [roll, pitch, yaw] = spec.target.boardAlignment;
      const alignment = new BoardAlignmentController(session.options);
      const alignmentLoad = await alignment.load(session.key);
      if (alignmentLoad.kind !== 'LOADED') {
        throw new Error(`${label} alignment load: ${alignmentLoad.kind}`);
      }
      const alignmentSave = (await alignment.save(
        session.key,
        alignmentLoad.snapshot,
        {
          ...createBoardAlignmentDraft(alignmentLoad.snapshot),
          rollDegrees: roll,
          pitchDegrees: pitch,
          yawDegrees: yaw,
        },
      )) as Outcome;
      const alignmentIsStock = roll === 0 && pitch === 0 && yaw === 0;
      expect(`${label} alignment: ${describeOutcome(alignmentSave)}`).toBe(
        `${label} alignment: ${alignmentIsStock ? 'NO_CHANGES' : 'SAVED_VERIFIED'}`,
      );

      // ---- POWER CYCLE, then read the board back ------------------
      // Anything that only ever reached RAM is gone at this point.
      session.reconnect();

      expect(`${label} failsafe delay`).toBe(`${label} failsafe delay`);
      expect(board.readPersisted(MSP_FAILSAFE_CONFIG)?.[0]).toBe(
        wanted.delayDeciseconds,
      );
      const persistedAlignment = decodeBoardAlignment(
        board.readPersisted(MSP_BOARD_ALIGNMENT_CONFIG) as Uint8Array,
      );
      expect([
        persistedAlignment.rollDegrees,
        persistedAlignment.pitchDegrees,
        persistedAlignment.yawDegrees,
      ]).toEqual([roll, pitch, yaw]);

      // ---- RECONNECT AND RELOAD -----------------------------------
      const reloaded = await new FailsafeConfigurationController(
        session.options,
      ).load(session.key);
      if (reloaded.kind !== 'LOADED') {
        throw new Error(`${label} reload: ${reloaded.kind}`);
      }
      expect(
        createFailsafeConfigurationDraft(reloaded.snapshot).delayDeciseconds,
      ).toBe(wanted.delayDeciseconds);
    },
  );
});

/* ==================================================================== *
 * PART 2 - INDEPENDENCE: TWELVE BOARDS, TWELVE CONFIGURATIONS
 * ==================================================================== */

describe('red team: nothing leaks between aircraft', () => {
  /**
   * The two whoops are the point of this test. TINY65_1S and TINY75_1S are
   * the same airframe class, the same cell count and the same channel
   * count, and differ in exactly one piece of hardware and every tuning
   * number. A cache keyed on anything but the session would put one
   * aircraft's power profile on the other, and nothing else in the suite
   * would notice.
   */
  it('configures all twelve in one run and each board holds only its own', async () => {
    const rigs = RED_TEAM_SPECS.map(spec => rig(spec));

    for (const {spec, session} of rigs) {
      const power = new PowerConfigurationController(session.options);
      const loaded = await power.load(session.key);
      if (loaded.kind !== 'LOADED') {
        throw new Error(`${spec.key} power load: ${loaded.kind}`);
      }
      const wanted = spec.target.battery;
      const outcome = (await power.save(session.key, loaded.snapshot, {
        ...createPowerConfigurationDraft(loaded.snapshot),
        capacityMah: wanted.capacityMah,
        minCellCentivolts: wanted.minCellCentivolts,
        warningCellCentivolts: wanted.warningCellCentivolts,
        maxCellCentivolts: wanted.maxCellCentivolts,
      })) as Outcome;
      expect(`${spec.key} power: ${describeOutcome(outcome)}`).toBe(
        `${spec.key} power: SAVED_VERIFIED`,
      );
    }

    // Now read every board back, after every other board was configured.
    for (const {spec, board, session} of rigs) {
      board.powerCycle();
      const reloaded = await new PowerConfigurationController(
        session.options,
      ).load(session.key);
      if (reloaded.kind !== 'LOADED') {
        throw new Error(`${spec.key} power reload: ${reloaded.kind}`);
      }
      const held = createPowerConfigurationDraft(reloaded.snapshot);
      expect(`${spec.key}: ${held.capacityMah}mAh @ ${held.warningCellCentivolts}cV`).toBe(
        `${spec.key}: ${spec.target.battery.capacityMah}mAh @ ${spec.target.battery.warningCellCentivolts}cV`,
      );
    }
  });

  it('gives each aircraft its own PID tune and no other', async () => {
    const rigs = RED_TEAM_SPECS.map(spec => rig(spec));
    for (const {spec, session} of rigs) {
      const pid = new PidTuningController(session.options);
      const loaded = await pid.load(session.key);
      if (loaded.kind !== 'LOADED') {
        throw new Error(`${spec.key} pid load: ${loaded.kind}`);
      }
      const base = createPidTuningDraft(loaded.snapshot);
      const want = spec.target.pid;
      const outcome = (await pid.save(session.key, loaded.snapshot, {
        ...base,
        roll: {...base.roll, p: want.rollP, i: want.rollI, d: want.rollD},
        pitch: {...base.pitch, p: want.pitchP, i: want.pitchI, d: want.pitchD},
        yaw: {...base.yaw, p: want.yawP, i: want.yawI, d: want.yawD},
      })) as Outcome;
      expect(`${spec.key} pid: ${describeOutcome(outcome)}`).toBe(
        `${spec.key} pid: SAVED_VERIFIED`,
      );
    }
    for (const {spec, board, session} of rigs) {
      board.powerCycle();
      const reloaded = await new PidTuningController(session.options).load(
        session.key,
      );
      if (reloaded.kind !== 'LOADED') {
        throw new Error(`${spec.key} pid reload: ${reloaded.kind}`);
      }
      const held = createPidTuningDraft(reloaded.snapshot);
      expect(`${spec.key} P ${held.roll.p}/${held.pitch.p}/${held.yaw.p}`).toBe(
        `${spec.key} P ${spec.target.pid.rollP}/${spec.target.pid.pitchP}/${spec.target.pid.yawP}`,
      );
    }
  });
});

/* ==================================================================== *
 * PART 3 - SCREEN INTERLEAVING AND STALE DRAFTS
 * ==================================================================== */

describe('red team: an old draft must not win', () => {
  /**
   * Screen A loads. Screen B changes the SAME field. Screen A saves with
   * the value it loaded. If that write lands, the app has silently undone
   * a change the operator made two screens ago.
   */
  it('refuses a failsafe save whose base another screen already moved', async () => {
    const spec = redTeamSpec('LR7_HEAVY');
    const {board, session} = rig(spec);

    const screenA = new FailsafeConfigurationController(session.options);
    const loadedA = await screenA.load(session.key);
    if (loadedA.kind !== 'LOADED') throw new Error('A load failed');

    // Screen B - a second instance of the same controller is exactly what
    // a second visit to the screen is.
    const screenB = new FailsafeConfigurationController(session.options);
    const loadedB = await screenB.load(session.key);
    if (loadedB.kind !== 'LOADED') throw new Error('B load failed');
    const savedB = (await screenB.save(session.key, loadedB.snapshot, {
      ...createFailsafeConfigurationDraft(loadedB.snapshot),
      delayDeciseconds: 19,
    })) as Outcome;
    expectPersisted(savedB, board, 'screen B failsafe');

    // Screen A now saves from the base it loaded BEFORE B moved it.
    const savedA = (await screenA.save(session.key, loadedA.snapshot, {
      ...createFailsafeConfigurationDraft(loadedA.snapshot),
      landingTimeSeconds: 22,
    })) as Outcome;

    expect(describeOutcome(savedA)).toBe('REJECTED (STALE_BASE)');
    // B's value is what the aircraft still holds.
    expect(board.readPersisted(MSP_FAILSAFE_CONFIG)?.[0]).toBe(19);
  });

  /**
   * A draft carried across a RECONNECT is a draft that belongs to a board
   * that may no longer be there. The generation guard has to refuse it
   * even when the values would have been perfectly valid.
   */
  it('refuses a draft held across a reconnect to a different board', async () => {
    const first = rig(redTeamSpec('RACE5_SPEC'));
    const alignment = new BoardAlignmentController(first.session.options);
    const loaded = await alignment.load(first.session.key);
    if (loaded.kind !== 'LOADED') throw new Error('load failed');
    const staleKey = first.session.key;

    // The cable is pulled and a DIFFERENT aircraft is plugged in.
    first.session.board = new VirtualFlightController({
      parameters: buildFactoryBoard(redTeamSpec('WHOOP3_DUCT')),
    });
    FLEET.push(first.session.board);
    first.session.generation += 1;

    const outcome = (await alignment.save(staleKey, loaded.snapshot, {
      ...createBoardAlignmentDraft(loaded.snapshot),
      yawDegrees: 90,
    })) as Outcome;

    expect(outcome.kind).not.toBe('SAVED_VERIFIED');
    // And the new board is untouched - not even a probe write.
    expect(first.session.board.counts.writes).toBe(0);
  });

  /**
   * Two DIFFERENT screens, one shared MSP payload. Motors owns three bits
   * of the feature mask; everything else in it belongs to somebody else.
   */
  it('does not revert another screen s feature bit through a Motors save', async () => {
    const spec = redTeamSpec('GPS_NO_RESCUE');
    const {board, session} = rig(spec);

    const motors = new MotorConfigurationController(session.options);
    const loaded = await motors.load(session.sessionId);
    if (loaded.kind !== 'LOADED') throw new Error('motors load failed');

    // Another screen enables GPS while the Motors editor is open.
    const mask = new Uint8Array(4);
    new DataView(mask.buffer).setUint32(
      0,
      // eslint-disable-next-line no-bitwise -- setting FEATURE_GPS (1 << 7).
      loaded.snapshot.feature.enabledFeaturesRaw | (1 << 7),
      true,
    );
    await board.request(MSP_SET_FEATURE_CONFIG, mask, {wireFormat: 'v1'});

    const outcome = (await motors.save(session.sessionId, loaded.snapshot, {
      ...createMotorConfigurationDraft(loaded.snapshot),
      motorStopEnabled: true,
    })) as Outcome;

    const live = decodeFeatureConfig(
      board.readParameter(MSP_FEATURE_CONFIG) as Uint8Array,
    ).enabledFeaturesRaw;
    expect({
      outcome: outcome.kind,
      // eslint-disable-next-line no-bitwise -- reading FEATURE_GPS back.
      gps: (live & (1 << 7)) !== 0,
    }).toEqual({outcome: outcome.kind, gps: true});
  });
});

/* ==================================================================== *
 * PART 4 - CHAOS. THE BOARD STOPS COOPERATING.
 * ==================================================================== */

describe('red team: chaos injection, and never a false success', () => {
  const CHAOS_SPEC = 'FREE5_TUNED';

  /** Every one of these must end with the app NOT claiming success. */
  it.each([
    ['a rejected parameter write', {command: MSP_FAILSAFE_CONFIG, fault: {kind: 'REMOTE_ERROR' as const}}],
    ['a timed-out parameter write', {command: MSP_FAILSAFE_CONFIG, fault: {kind: 'TIMEOUT' as const}}],
    ['a truncated read', {command: MSP_FAILSAFE_CONFIG, fault: {kind: 'TRUNCATE' as const, bytes: 3}}],
    ['an error frame', {command: MSP_FAILSAFE_CONFIG, fault: {kind: 'ERROR_FRAME' as const}}],
  ])('%s never becomes SAVED_VERIFIED', async (_label, plan) => {
    const spec = redTeamSpec(CHAOS_SPEC);
    const {board, session} = rig(spec);
    const failsafe = new FailsafeConfigurationController(session.options);
    const loaded = await failsafe.load(session.key);
    if (loaded.kind !== 'LOADED') throw new Error('load failed');

    board.injectFault(plan);
    const outcome = (await failsafe.save(session.key, loaded.snapshot, {
      ...createFailsafeConfigurationDraft(loaded.snapshot),
      delayDeciseconds: 17,
    })) as Outcome;

    expect(outcome.kind).not.toBe('SAVED_VERIFIED');
    expect(outcome.kind).not.toBe('NO_CHANGES');
  });

  it('never claims success when the EEPROM commit itself fails', async () => {
    const {board, session} = rig(redTeamSpec(CHAOS_SPEC));
    const failsafe = new FailsafeConfigurationController(session.options);
    const loaded = await failsafe.load(session.key);
    if (loaded.kind !== 'LOADED') throw new Error('load failed');

    board.injectFault({
      command: MSP_EEPROM_WRITE,
      fault: {kind: 'REMOTE_ERROR'},
    });
    const outcome = (await failsafe.save(session.key, loaded.snapshot, {
      ...createFailsafeConfigurationDraft(loaded.snapshot),
      delayDeciseconds: 17,
    })) as Outcome;

    expect(outcome.kind).not.toBe('SAVED_VERIFIED');
    // The proof: the value is in RAM and NOT in EEPROM, and a power cycle
    // takes it away. An app that had reported success would have lied.
    expect(board.hasUnsavedChanges()).toBe(true);
    board.powerCycle();
    expect(board.readPersisted(MSP_FAILSAFE_CONFIG)?.[0]).not.toBe(17);
  });

  it('never claims success when the link drops after the write', async () => {
    const {board, session} = rig(redTeamSpec(CHAOS_SPEC));
    const failsafe = new FailsafeConfigurationController(session.options);
    const loaded = await failsafe.load(session.key);
    if (loaded.kind !== 'LOADED') throw new Error('load failed');

    // The board answers the parameter write and then vanishes, so the
    // EEPROM commit and the readback both hit a dead link. That is the
    // genuinely ambiguous case and it must NOT be called verified.
    board.injectFault({
      command: MSP_EEPROM_WRITE,
      fault: {kind: 'TIMEOUT'},
    });
    const outcome = (await failsafe.save(session.key, loaded.snapshot, {
      ...createFailsafeConfigurationDraft(loaded.snapshot),
      delayDeciseconds: 17,
    })) as Outcome;

    expect(outcome.kind).not.toBe('SAVED_VERIFIED');
  });

  it('refuses every write to an ARMED aircraft, on all twelve', async () => {
    for (const spec of RED_TEAM_SPECS) {
      const {board, session} = rig(spec);
      const failsafe = new FailsafeConfigurationController(session.options);
      const loaded = await failsafe.load(session.key);
      if (loaded.kind !== 'LOADED') {
        throw new Error(`${spec.key} load: ${loaded.kind}`);
      }
      board.setArmed(true);
      const outcome = (await failsafe.save(session.key, loaded.snapshot, {
        ...createFailsafeConfigurationDraft(loaded.snapshot),
        delayDeciseconds: 18,
      })) as Outcome;

      expect(`${spec.key}: ${describeOutcome(outcome)}`).toBe(
        `${spec.key}: REJECTED (FC_ARMED)`,
      );
      // Nothing was written, and the armed proof came from STATUS_EX.
      expect(
        board.requests.some(request => request.command === MSP_STATUS_EX),
      ).toBe(true);
      expect(board.counts.writes).toBe(0);
    }
  });

  /**
   * ARMING BETWEEN THE LOAD AND THE SAVE. The operator opened the editor
   * on a disarmed aircraft and armed it while typing. The check that
   * matters is the one immediately before the first write, not the one at
   * admission.
   */
  it('refuses when the aircraft arms between opening the editor and saving', async () => {
    const {board, session} = rig(redTeamSpec('LR4_LIGHT'));
    const failsafe = new FailsafeConfigurationController(session.options);
    const loaded = await failsafe.load(session.key);
    if (loaded.kind !== 'LOADED') throw new Error('load failed');

    board.setArmed(true); // <- after the load, before the save

    const outcome = (await failsafe.save(session.key, loaded.snapshot, {
      ...createFailsafeConfigurationDraft(loaded.snapshot),
      delayDeciseconds: 16,
    })) as Outcome;
    expect(describeOutcome(outcome)).toBe('REJECTED (FC_ARMED)');
    expect(board.counts.writes).toBe(0);
  });
});

/* ==================================================================== *
 * PART 5 - THE 3D BAND, WHICH IS WHERE THE RANGE AUDIT LANDED
 * ==================================================================== */

describe('red team: the 3D band cannot be driven out of the firmware range', () => {
  /**
   * `neutral3d` is the DISARMED motor pulse in 3D mode
   * (drivers/pwm_output.c:38). The triple below satisfies the ordering
   * rule, encodes cleanly and would have been stored - and it hands the
   * ESCs a one-microsecond disarm pulse.
   */
  it('refuses the ordered-but-impossible band and writes nothing', async () => {
    const {board, session} = rig(redTeamSpec('CINE5_SMOOTH'));
    const motors = new MotorConfigurationController(session.options);
    const loaded = await motors.load(session.sessionId);
    if (loaded.kind !== 'LOADED') throw new Error('load failed');
    const writesBefore = board.counts.writes;

    const outcome = (await motors.save(session.sessionId, loaded.snapshot, {
      ...createMotorConfigurationDraft(loaded.snapshot),
      deadband3dLow: 0,
      neutral3d: 1,
      deadband3dHigh: 2,
    })) as Outcome;

    expect(describeOutcome(outcome)).toBe('REJECTED (INVALID_DRAFT)');
    expect(board.counts.writes).toBe(writesBefore);
    // The board still holds Betaflight's own defaults.
    const held = decodeMotor3dConfig(
      board.readParameter(MSP_MOTOR_3D_CONFIG) as Uint8Array,
    );
    expect([held.deadband3dLow, held.neutral3d, held.deadband3dHigh]).toEqual([
      FIRMWARE_STOCK_3D_BAND.low,
      FIRMWARE_STOCK_3D_BAND.neutral,
      FIRMWARE_STOCK_3D_BAND.high,
    ]);
  });

  it('refuses a PWM rate of zero and one beyond the timer range', async () => {
    const {board, session} = rig(redTeamSpec('MICRO2_TOY'));
    const motors = new MotorConfigurationController(session.options);
    const loaded = await motors.load(session.sessionId);
    if (loaded.kind !== 'LOADED') throw new Error('load failed');

    for (const rate of [0, 65535]) {
      const outcome = (await motors.save(session.sessionId, loaded.snapshot, {
        ...createMotorConfigurationDraft(loaded.snapshot),
        motorPwmRate: rate,
      })) as Outcome;
      expect(`${rate}Hz: ${describeOutcome(outcome)}`).toBe(
        `${rate}Hz: REJECTED (INVALID_DRAFT)`,
      );
    }
    expect(board.counts.writes).toBe(0);
  });

  it('accepts a real in-range motor configuration on the same aircraft', async () => {
    // The control: the refusals above are not the validator refusing
    // everything.
    const {board, session} = rig(redTeamSpec('MICRO2_TOY'));
    const motors = new MotorConfigurationController(session.options);
    const loaded = await motors.load(session.sessionId);
    if (loaded.kind !== 'LOADED') throw new Error('load failed');

    const spec = redTeamSpec('MICRO2_TOY');
    const outcome = (await motors.save(session.sessionId, loaded.snapshot, {
      ...createMotorConfigurationDraft(loaded.snapshot),
      motorProtocolRaw: spec.target.motorProtocol,
      motorIdleRaw: spec.target.motorIdlePercent,
      motorPwmRate: 480,
    })) as Outcome;

    expectPersisted(outcome, board, 'MICRO2_TOY motors');
    expect(
      decodeAdvancedConfig(board.readPersisted(MSP_ADVANCED_CONFIG) as Uint8Array)
        .motorProtocolRaw,
    ).toBe(spec.target.motorProtocol);
  });
});

/* ==================================================================== *
 * PART 6 - PAYLOAD SHAPES THE BOARD MIGHT ACTUALLY SEND
 * ==================================================================== */

/**
 * MSP grows by APPENDING. A newer firmware answers a command this build
 * knows with MORE bytes than this build expects, and every decoder here
 * has to read its known prefix and ignore the rest - otherwise a board
 * one release ahead breaks a screen that would have worked.
 *
 * The opposite case must fail LOUDLY: a payload shorter than the prefix
 * is not a payload with defaults, it is a truncation, and decoding it as
 * zeroes would put fabricated values on screen.
 */
describe('red team: payloads longer, shorter and stranger than expected', () => {
  it('reads a board that answers with MORE bytes than this build knows', async () => {
    const spec = redTeamSpec('LR7_HEAVY');
    const board = new VirtualFlightController({
      parameters: buildFactoryBoard(spec),
    });
    FLEET.push(board);
    // Append eight bytes of a hypothetical future field to every motor
    // group the Motors page reads.
    for (const command of [MSP_ADVANCED_CONFIG, MSP_MOTOR_3D_CONFIG]) {
      const current = board.readParameter(command) as Uint8Array;
      const longer = new Uint8Array(current.length + 8);
      longer.set(current, 0);
      longer.fill(0xab, current.length);
      board.overwriteParameter(command, longer);
    }
    const session = new VirtualSession({
      sessionId: 'redteam-longer',
      board,
      apiMinor: 48,
    });

    const loaded = await new MotorConfigurationController(
      session.options,
    ).load(session.sessionId);
    expect(loaded.kind).toBe('LOADED');
    if (loaded.kind !== 'LOADED') return;
    // The known prefix decoded correctly; the trailing bytes changed
    // nothing.
    expect(loaded.snapshot.advanced.motorProtocolRaw).toBe(0);
    expect(loaded.snapshot.motor3d.neutral3d).toBe(
      FIRMWARE_STOCK_3D_BAND.neutral,
    );
  });

  it.each([1, 2, 5])(
    'fails loudly on a payload truncated to %i bytes rather than defaulting',
    async bytes => {
      const spec = redTeamSpec('RACE5_SPEC');
      const {board, session} = rig(spec);
      board.injectFault({
        command: MSP_ADVANCED_CONFIG,
        fault: {kind: 'TRUNCATE', bytes},
      });
      const loaded = await new MotorConfigurationController(
        session.options,
      ).load(session.sessionId);
      expect(loaded.kind).toBe('FAILED');
    },
  );

  /**
   * An enum value this build has no name for is not an error. The
   * firmware's motorProtocolTypes_e can gain an entry, and a board using
   * it must still be READABLE - the raw number is carried through so the
   * operator sees what the aircraft actually has rather than a wrong
   * name or an empty screen.
   */
  it('carries an unknown motor protocol through as its raw value', async () => {
    const spec = redTeamSpec('CINE5_SMOOTH');
    const {board, session} = rig(spec);
    const advanced = board.readParameter(MSP_ADVANCED_CONFIG) as Uint8Array;
    const future = Uint8Array.from(advanced);
    future[3] = 9; // MOTOR_PROTOCOL_DISABLED - the top of the enum.
    board.overwriteParameter(MSP_ADVANCED_CONFIG, future);

    const loaded = await new MotorConfigurationController(
      session.options,
    ).load(session.sessionId);
    expect(loaded.kind).toBe('LOADED');
    if (loaded.kind !== 'LOADED') return;
    expect(loaded.snapshot.advanced.motorProtocolRaw).toBe(9);
  });

  it('refuses to WRITE a protocol number the enum does not contain', async () => {
    // Reading leniently and writing strictly are different policies on
    // purpose: an unknown value read off a board is information, the same
    // value written to one is a guess.
    const {board, session} = rig(redTeamSpec('CINE5_SMOOTH'));
    const motors = new MotorConfigurationController(session.options);
    const loaded = await motors.load(session.sessionId);
    if (loaded.kind !== 'LOADED') throw new Error('load failed');

    const outcome = (await motors.save(session.sessionId, loaded.snapshot, {
      ...createMotorConfigurationDraft(loaded.snapshot),
      motorProtocolRaw: 10, // MOTOR_PROTOCOL_MAX - one past the last real one
    })) as Outcome;
    expect(describeOutcome(outcome)).toBe('REJECTED (INVALID_DRAFT)');
    expect(board.counts.writes).toBe(0);
  });
});

/* ==================================================================== *
 * PART 6 - THE COUNTERS THE REPORT QUOTES
 * ==================================================================== */

describe('red team: fleet totals', () => {
  it('reports what the fleet actually did', () => {
    const totals = FLEET.reduce(
      (sum, board) => ({
        boards: sum.boards + 1,
        transactions: sum.transactions + board.requests.length,
        reads: sum.reads + board.counts.reads,
        writes: sum.writes + board.counts.writes,
        eeprom: sum.eeprom + board.counts.eepromWrites,
        reboots: sum.reboots + board.counts.reboots,
      }),
      {boards: 0, transactions: 0, reads: 0, writes: 0, eeprom: 0, reboots: 0},
    );

    // Not a threshold dressed up as a test: these assert the suite really
    // exercised the fleet rather than short-circuiting somewhere early.
    expect(totals.boards).toBeGreaterThanOrEqual(RED_TEAM_SPECS.length);
    expect(totals.transactions).toBeGreaterThan(500);
    expect(totals.writes).toBeGreaterThan(20);
    expect(totals.eeprom).toBeGreaterThan(20);
    expect(totals.reboots).toBeGreaterThan(10);

    // Printed so the audit report can quote measured counters.
    console.log(`RED TEAM FLEET TOTALS ${JSON.stringify(totals)}`);
  });
});
