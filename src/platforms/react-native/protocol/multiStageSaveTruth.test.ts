/**
 * A SAVE IS A SEQUENCE, AND THE SEQUENCE CAN STOP HALF-WAY.
 *
 * =====================================================================
 * THE TWO DEFECTS THESE TESTS EXIST TO KEEP CLOSED
 * =====================================================================
 *
 * A configuration save sends N mutating frames and then commits:
 *
 *     SET group A  ->  SET group B  ->  ...  ->  EEPROM_WRITE
 *
 * The flight controller applies each frame to its RAM the moment it
 * acknowledges it, and the commit is what makes the lot permanent. Two
 * things went wrong with treating that sequence as one operation.
 *
 * THE FIRST. Liveness was checked ONCE, before the first frame. If the
 * flight controller restarted in the middle - a brownout, a knock on
 * the USB plug, a watchdog - the later frames were sent anyway, to a
 * board that had come back holding its STORED configuration. The EEPROM
 * write at the end then persisted that mixture: half the operator's
 * edit from before the restart, half from after, made permanent, and
 * reported as a save. One aircraft, one intent, split durably across
 * two FC lifetimes.
 *
 * THE SECOND. When the EEPROM write itself was REFUSED, the save was
 * reported as an ordinary failure - which every operator reads as
 * "nothing happened". The SET frames before it had already been
 * acknowledged, so the aircraft was flying the new values, unpersisted,
 * until its next power cycle. The truth was the opposite of the message.
 *
 * =====================================================================
 * HOW THESE TESTS JUDGE
 * =====================================================================
 *
 * On BOARD-SIDE STATE, not on the outcome label. Each case asserts what
 * the virtual flight controller's RAM and EEPROM actually hold, what
 * frames actually reached it, and only then what the app said. A test
 * that checked the label alone would pass against an implementation
 * that persisted a half-configured aircraft and simply named it
 * differently.
 *
 * Every injected restart also PROVES it fired. A restart that never
 * happened produces a row that looks like a clean pass - which is how
 * an earlier audit harness manufactured false evidence.
 *
 * Nothing here is evidence about real hardware.
 */

import {
  MSP2_COMMON_SERIAL_CONFIG,
  MSP2_COMMON_SET_SERIAL_CONFIG,
  MSP_EEPROM_WRITE,
  MSP_FEATURE_CONFIG,
  MSP_REBOOT,
  MSP_SET_FEATURE_CONFIG,
  MSP_SET_MOTOR_3D_CONFIG,
  MSP_SET_MOTOR_CONFIG,
  MSP_STATUS_EX,
} from '../../../core/protocol/msp/commands/mspCommands';
import {
  SERIAL_ROLE_DEFINITIONS,
  deriveSerialPortsFeatureMask,
  hasSerialRole,
  serialRoleIsAvailable,
  setSerialRole,
  type SerialPortsSnapshot,
} from '../../../core/state/serialPortsModel';
import { createMotorConfigurationDraft } from '../../../core/state/motorConfigurationModel';
import { MotorConfigurationController } from './MotorConfigurationController';
import type { MotorConfigurationSaveOutcome } from './MotorConfigurationController';
import { PortsConfigurationController } from './PortsConfigurationController';
import type { PortsSaveOutcome } from './PortsConfigurationController';
import {
  DRONE_SPECS,
  buildFactoryBoard,
  type DroneSpec,
} from './__testUtils__/virtualDroneFixtures';
import { VirtualFlightController } from './__testUtils__/virtualFlightController';
import { VirtualSession } from './__testUtils__/virtualSession';

jest.mock('../transport/native/NativeUsbSerialTransport');

/**
 * Ports is the sharpest case in the repository and the one the original
 * defect was reproduced on: its save writes the serial-port table and
 * then the feature mask - two DIFFERENT settings groups, either of
 * which can be the survivor of a mid-sequence restart.
 */
const PORTS = 'LONG_RANGE';

function spec(key: string): DroneSpec {
  const found = DRONE_SPECS.find(candidate => candidate.key === key);
  if (found === undefined) {
    throw new Error(`no spec ${key}`);
  }
  return found;
}

function hex(bytes: Uint8Array | undefined): string {
  return bytes === undefined
    ? 'undefined'
    : Array.from(bytes)
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
}

/** RAM and EEPROM for one settings group, as the board itself holds them. */
function store(board: VirtualFlightController, command: number) {
  return {
    ram: hex(board.readParameter(command)),
    eeprom: hex(board.readPersisted(command)),
  };
}

/**
 * Run `action` immediately after the board answers the nth frame among
 * `commands`. This is what places an event INSIDE a transaction rather
 * than between transactions.
 *
 * `fired()` is the instrument check: a test whose injected event never
 * happened has proven nothing, and must say so rather than pass.
 *
 * The instance is wrapped, never the class, so no production code is
 * patched and no other board in the run is affected.
 */
function afterFrame(
  board: VirtualFlightController,
  commands: readonly number[],
  nth: number,
  action: () => void,
): { fired: () => boolean } {
  const wanted = new Set(commands);
  let toSkip = nth - 1;
  let didFire = false;
  const original = board.request.bind(board);
  (board as unknown as { request: typeof board.request }).request = async (
    command: number,
    payload: Uint8Array,
    options: never,
  ) => {
    const isTarget = !didFire && wanted.has(command) && toSkip-- <= 0;
    try {
      return await original(command, payload, options);
    } finally {
      if (isTarget) {
        didFire = true;
        action();
      }
    }
  };
  return { fired: () => didFire };
}

async function portsRig(tag: string) {
  const board = new VirtualFlightController({
    parameters: buildFactoryBoard(spec(PORTS)),
  });
  const session = new VirtualSession({
    sessionId: `multistage-${tag}`,
    board,
    apiMinor: 47,
  });
  const controller = new PortsConfigurationController(session.options);
  const loaded = await controller.load(session.key);
  if (loaded.kind !== 'LOADED') {
    throw new Error(`load ${loaded.kind}`);
  }
  return { board, session, controller, original: loaded.snapshot };
}

/**
 * A REAL edit that genuinely produces BOTH mutating frames.
 *
 * This matters more than it looks. The port table and the feature mask
 * are two separate MSP writes, and the whole point of these tests is a
 * sequence that can stop BETWEEN them - so the edit has to be one that
 * really moves both. Enabling a telemetry role on a UART does: the port
 * record changes, and `deriveSerialPortsFeatureMask` (the production
 * derivation, used here rather than a hand-computed mask) then raises
 * the telemetry feature bit.
 *
 * The USB VCP port (identifier 20) is deliberately untouched - the
 * screen correctly refuses to drop MSP from it, and an edit that fought
 * that guard would be exercising a product that does not exist.
 *
 * If a future fixture already has telemetry enabled everywhere, this
 * throws rather than silently degrading to a single-write edit that
 * would make these tests quietly stop testing what they claim to.
 */
function editPorts(snapshot: SerialPortsSnapshot) {
  for (const port of snapshot.ports) {
    if (port.identifier === 20) {
      continue;
    }
    for (const definition of SERIAL_ROLE_DEFINITIONS) {
      /* Only roles this firmware DECLARES it was built with. The screen
         refuses the rest as ROLE_NOT_COMPILED, and an edit that fought
         that guard would never reach the write phase at all - which is
         exactly how an earlier draft of this file passed its restart
         assertions while sending nothing. */
      if (
        hasSerialRole(port, definition.key) ||
        !serialRoleIsAvailable(snapshot, definition.key)
      ) {
        continue;
      }
      const next = setSerialRole(
        snapshot.ports,
        port.identifier,
        definition.key,
        true,
      );
      if (
        deriveSerialPortsFeatureMask(snapshot.featureMaskRaw, next) !==
        snapshot.featureMaskRaw
      ) {
        return next;
      }
    }
  }
  throw new Error(
    'fixture offers no edit that moves BOTH the port table and the feature mask',
  );
}

const commandsOf = (board: VirtualFlightController, from: number) =>
  board.requests.slice(from).map(request => request.command);

/** The Motors SET frames this file's edits can produce. */
const MOTOR_SET_COMMANDS: readonly number[] = [
  MSP_SET_MOTOR_CONFIG,
  MSP_SET_MOTOR_3D_CONFIG,
];

describe('a multi-stage save that stops half-way tells the truth about it', () => {
  /* =================================================================
   * THE RESTART BETWEEN TWO WRITES
   * ================================================================= */

  it('stops at a flight controller restart between two SET frames, and persists NOTHING', async () => {
    const { board, session, controller, original } = await portsRig('restart');
    const draft = editPorts(original);

    /* The restart lands after the FIRST mutating frame is answered -
       the serial table is in the board's RAM, the feature mask is not,
       and the board then comes back holding its stored configuration. */
    const restart = afterFrame(
      board,
      [MSP2_COMMON_SET_SERIAL_CONFIG, MSP_SET_FEATURE_CONFIG],
      1,
      () => board.powerCycle(),
    );

    const from = board.requests.length;
    const outcome = (await controller.save(
      session.key,
      original,
      draft,
    )) as PortsSaveOutcome;
    const sent = commandsOf(board, from);

    // The instrument first: without a restart this proves nothing.
    expect(restart.fired()).toBe(true);

    /* THE HARD INVARIANT. Liveness was lost after a write was
       acknowledged, so the commit must not have been attempted. Nothing
       half-applied is ever made permanent. */
    expect(sent).not.toContain(MSP_EEPROM_WRITE);
    expect(sent).not.toContain(MSP_REBOOT);

    /* And the sequence stopped rather than writing on down the link:
       the first SET went out, the second did not. */
    expect(
      sent.filter(command => command === MSP2_COMMON_SET_SERIAL_CONFIG),
    ).toHaveLength(1);
    expect(sent).not.toContain(MSP_SET_FEATURE_CONFIG);

    /* The board's own state, which is what the operator will meet: the
       restart discarded the unsaved RAM, so flash still holds the
       original feature mask. It was never written. */
    const features = store(board, MSP_FEATURE_CONFIG);
    expect(features.ram).toBe(features.eeprom);

    /* Neither «تم الحفظ» nor «فشل الحفظ». The result names the stage it
       stopped at and the groups the board had acknowledged. */
    expect(outcome.kind).toBe('PARTIAL_UNPERSISTED');
    if (outcome.kind !== 'PARTIAL_UNPERSISTED') {
      throw new Error('unreachable');
    }
    expect(outcome.confirmedStages).toEqual(['SERIAL_CONFIG']);
    expect(outcome.definitelyNotSent).toBe(true);
  });

  it('stops at a restart after ALL the SET frames, and still persists NOTHING', async () => {
    const { board, session, controller, original } = await portsRig('preeeprom');
    const draft = editPorts(original);

    /* The distinct case from the one above: every RAM write is already
       acknowledged and only the commit is left. The sequence has no
       further SET to refuse, so ONLY the check that guards the EEPROM
       write itself can stop it - which is exactly the guard a mid-
       sequence check would not cover. */
    const restart = afterFrame(
      board,
      [MSP2_COMMON_SET_SERIAL_CONFIG, MSP_SET_FEATURE_CONFIG],
      2,
      () => board.powerCycle(),
    );

    const from = board.requests.length;
    const outcome = (await controller.save(
      session.key,
      original,
      draft,
    )) as PortsSaveOutcome;
    const sent = commandsOf(board, from);

    expect(restart.fired()).toBe(true);
    // Both RAM writes went out; the commit did not.
    expect(
      sent.filter(command => command === MSP2_COMMON_SET_SERIAL_CONFIG),
    ).toHaveLength(1);
    expect(sent.filter(command => command === MSP_SET_FEATURE_CONFIG)).toHaveLength(
      1,
    );
    expect(sent).not.toContain(MSP_EEPROM_WRITE);
    expect(sent).not.toContain(MSP_REBOOT);

    expect(outcome.kind).toBe('PARTIAL_UNPERSISTED');
    if (outcome.kind !== 'PARTIAL_UNPERSISTED') {
      throw new Error('unreachable');
    }
    /* Everything the operator asked for reached the board, and none of
       it was stored - the "all of it is live, unsaved" half of the
       vocabulary. */
    expect(outcome.confirmedStages).toEqual([
      'SERIAL_CONFIG',
      'FEATURE_CONFIG',
    ]);
    expect(outcome.failedStage).toBe('EEPROM');
  });

  it('a restart BEFORE the first write is an ordinary refusal - nothing was touched', async () => {
    const { board, session, controller, original } = await portsRig('early');
    const draft = editPorts(original);

    /* Anchored to the armed-state proof - the LAST awaited read before
       the first mutating frame, and therefore the tightest window in
       which a restart can still precede every write. Anchoring anywhere
       earlier would leave a later preflight guard to catch it, and the
       test would then pass without exercising the write-time check at
       all. */
    const restart = afterFrame(board, [MSP_STATUS_EX], 1, () =>
      board.powerCycle(),
    );

    const from = board.requests.length;
    const outcome = (await controller.save(
      session.key,
      original,
      draft,
    )) as PortsSaveOutcome;
    const sent = commandsOf(board, from);

    expect(restart.fired()).toBe(true);
    expect(sent).not.toContain(MSP2_COMMON_SET_SERIAL_CONFIG);
    expect(sent).not.toContain(MSP_SET_FEATURE_CONFIG);
    expect(sent).not.toContain(MSP_EEPROM_WRITE);

    /* THE CONTROL THAT KEEPS THE OTHER TESTS HONEST. With nothing
       acknowledged there is no partial application to report, and
       claiming one would be its own lie. */
    expect(outcome.kind).not.toBe('PARTIAL_UNPERSISTED');
    expect(board.hasUnsavedChanges()).toBe(false);
  });

  /* =================================================================
   * THE REFUSED COMMIT
   * ================================================================= */

  it('a REFUSED EEPROM write after acknowledged SETs is not a failure - the RAM moved', async () => {
    const { board, session, controller, original } = await portsRig('eeprom');
    const draft = editPorts(original);

    board.injectFault({
      command: MSP_EEPROM_WRITE,
      fault: { kind: 'REMOTE_ERROR' },
    });

    const from = board.requests.length;
    const outcome = (await controller.save(
      session.key,
      original,
      draft,
    )) as PortsSaveOutcome;
    const sent = commandsOf(board, from);

    /* The SET frames were NOT faulted and were acknowledged - this case
       is only meaningful because the writes really landed. */
    expect(
      sent.filter(command => command === MSP2_COMMON_SET_SERIAL_CONFIG),
    ).toHaveLength(1);
    expect(sent.filter(command => command === MSP_SET_FEATURE_CONFIG)).toHaveLength(
      1,
    );
    // The commit was attempted, and refused.
    expect(sent.filter(command => command === MSP_EEPROM_WRITE)).toHaveLength(1);

    /* THE BOARD'S OWN ANSWER to "is my RAM different from my EEPROM".
       This single fact is the whole defect: the aircraft is running the
       new configuration and will lose it at the next power cycle. */
    expect(board.hasUnsavedChanges()).toBe(true);
    const ports = store(board, MSP2_COMMON_SERIAL_CONFIG);
    expect(ports.ram).not.toBe(ports.eeprom);

    /* So the answer may not be a bare failure, and may not be a save. */
    expect(outcome.kind).not.toBe('FAILED');
    expect(outcome.kind).not.toBe('SAVED_VERIFIED');
    expect(outcome.kind).toBe('PARTIAL_UNPERSISTED');
    if (outcome.kind !== 'PARTIAL_UNPERSISTED') {
      throw new Error('unreachable');
    }
    expect(outcome.failedStage).toBe('EEPROM');
    expect(outcome.confirmedStages).toEqual([
      'SERIAL_CONFIG',
      'FEATURE_CONFIG',
    ]);
  });

  it('an UNANSWERED EEPROM write stays ambiguous - it is never downgraded to not-applied', async () => {
    const { board, session, controller, original } = await portsRig('ambiguous');
    const draft = editPorts(original);

    board.injectFault({
      command: MSP_EEPROM_WRITE,
      fault: { kind: 'TIMEOUT' },
    });

    const outcome = (await controller.save(
      session.key,
      original,
      draft,
    )) as PortsSaveOutcome;

    /* A frame whose reply never came MAY have been applied. Calling it
       a partial application would assert that persistence did not
       happen, which nobody knows. It stays the third state, and still
       reports which groups the board did acknowledge. */
    expect(outcome.kind).toBe('UNCONFIRMED');
    if (outcome.kind !== 'UNCONFIRMED') {
      throw new Error('unreachable');
    }
    expect(outcome.stage).toBe('EEPROM');
    expect(outcome.confirmedStages).toEqual([
      'SERIAL_CONFIG',
      'FEATURE_CONFIG',
    ]);
  });

  /* =================================================================
   * THE SUCCESS PATH IS UNCHANGED
   * ================================================================= */

  it('a healthy save still writes both groups, commits once, and verifies', async () => {
    const { board, session, controller, original } = await portsRig('healthy');
    const draft = editPorts(original);

    const from = board.requests.length;
    const outcome = (await controller.save(
      session.key,
      original,
      draft,
    )) as PortsSaveOutcome;
    const sent = commandsOf(board, from);

    expect(
      sent.filter(command => command === MSP2_COMMON_SET_SERIAL_CONFIG),
    ).toHaveLength(1);
    expect(sent.filter(command => command === MSP_EEPROM_WRITE)).toHaveLength(1);
    /* Per-stage liveness must not add frames, drop frames or reorder
       them: the commit still comes last and still comes once. */
    expect(sent.indexOf(MSP_EEPROM_WRITE)).toBeGreaterThan(
      sent.indexOf(MSP2_COMMON_SET_SERIAL_CONFIG),
    );
    expect(board.hasUnsavedChanges()).toBe(false);
    expect(['SAVED_VERIFIED', 'SAVED_UNVERIFIED']).toContain(outcome.kind);
  });
});

/* ===================================================================
 * THE SAME INVARIANT ON THE SCREEN THAT CAN SPIN PROPELLERS
 * =================================================================== */

/**
 * Motors is covered separately and deliberately.
 *
 * It is the one save whose half-applied result is a flight-safety fact
 * rather than a configuration inconvenience: the groups it writes carry
 * the motor protocol, the idle throttle, the 3D deadband and the mixer.
 * An aircraft persisted half-way between two motor configurations is
 * not merely misconfigured.
 *
 * It also reaches the guard by a DIFFERENT route from Ports - its own
 * preflight predicate, its own ledger field name - so a repair proven
 * only on Ports would not prove anything here.
 */
async function motorsRig(tag: string) {
  const board = new VirtualFlightController({
    parameters: buildFactoryBoard(spec(PORTS)),
  });
  const session = new VirtualSession({
    sessionId: `multistage-motors-${tag}`,
    board,
    apiMinor: 47,
  });
  const controller = new MotorConfigurationController(session.options);
  const loaded = await controller.load(session.sessionId);
  if (loaded.kind !== 'LOADED') {
    throw new Error(`motors load ${loaded.kind}`);
  }
  const base = createMotorConfigurationDraft(loaded.snapshot);
  return {
    board,
    session,
    controller,
    original: loaded.snapshot,
    /* A real, operator-visible field: the motor pole count, which the
       ESC RPM telemetry depends on. */
    draft: {
      ...base,
      motorPoleCount: (base.motorPoleCount ?? 14) === 12 ? 14 : 12,
    },
    /* TWO settings groups, deliberately. The pole count is MSP_SET_
       MOTOR_CONFIG and the 3D deadband is MSP_SET_MOTOR_3D_CONFIG, so
       this draft produces a sequence with a SECOND mutating frame - the
       only shape in which a mid-loop liveness check is load-bearing
       rather than defence in depth. A one-group edit cannot tell the
       two apart. */
    twoGroupDraft: {
      ...base,
      motorPoleCount: (base.motorPoleCount ?? 14) === 12 ? 14 : 12,
      deadband3dLow: base.deadband3dLow - 1,
    },
  };
}

describe('the Motors save obeys the same invariant', () => {
  it('never commits to flash after the flight controller restarted mid-save', async () => {
    const { board, session, controller, original, draft } =
      await motorsRig('restart');

    const restart = afterFrame(board, [MSP_SET_MOTOR_CONFIG], 1, () =>
      board.powerCycle(),
    );

    const from = board.requests.length;
    const outcome = (await controller.save(
      session.sessionId,
      original,
      draft,
    )) as MotorConfigurationSaveOutcome;
    const sent = commandsOf(board, from);

    expect(restart.fired()).toBe(true);
    expect(sent.filter(command => command === MSP_SET_MOTOR_CONFIG)).toHaveLength(
      1,
    );

    /* THE HARD INVARIANT, on the screen where it matters most. */
    expect(sent).not.toContain(MSP_EEPROM_WRITE);
    expect(sent).not.toContain(MSP_REBOOT);

    /* And no «تم الحفظ» of any kind: the previous behaviour reported
       SAVED_UNVERIFIED here, on a board that had been power-cycled. */
    expect(outcome.kind).not.toBe('SAVED_VERIFIED');
    expect(outcome.kind).not.toBe('SAVED_UNVERIFIED');
    expect(outcome.kind).toBe('PARTIAL_UNPERSISTED');
    if (outcome.kind !== 'PARTIAL_UNPERSISTED') {
      throw new Error('unreachable');
    }
    expect(outcome.acknowledgedGroups).toEqual(['MOTOR']);
  });

  it('stops BETWEEN two motor settings groups when the board restarts', async () => {
    const { board, session, controller, original, twoGroupDraft } =
      await motorsRig('midloop');

    /* Confirm the premise before relying on it: this edit really does
       issue two SET frames. Without that, the assertions below would
       pass against a sequence that never had a second write to stop. */
    const dry = await motorsRig('midloop-dry');
    const dryFrom = dry.board.requests.length;
    await dry.controller.save(
      dry.session.sessionId,
      dry.original,
      dry.twoGroupDraft,
    );
    const plannedSets = commandsOf(dry.board, dryFrom).filter(command =>
      MOTOR_SET_COMMANDS.includes(command),
    );
    expect(plannedSets).toHaveLength(2);

    const restart = afterFrame(board, MOTOR_SET_COMMANDS, 1, () =>
      board.powerCycle(),
    );

    const from = board.requests.length;
    const outcome = (await controller.save(
      session.sessionId,
      original,
      twoGroupDraft,
    )) as MotorConfigurationSaveOutcome;
    const sent = commandsOf(board, from);

    expect(restart.fired()).toBe(true);
    /* ONE of the two groups went out, and the second did not follow it
       onto a board that is no longer the one the first landed on. */
    expect(
      sent.filter(command => MOTOR_SET_COMMANDS.includes(command)),
    ).toHaveLength(1);
    expect(sent).not.toContain(MSP_EEPROM_WRITE);

    expect(outcome.kind).toBe('PARTIAL_UNPERSISTED');
    if (outcome.kind !== 'PARTIAL_UNPERSISTED') {
      throw new Error('unreachable');
    }
    expect(outcome.acknowledgedGroups).toHaveLength(1);
  });

  it('reports a REFUSED commit as unpersisted, not as a failure', async () => {
    const { board, session, controller, original, draft } =
      await motorsRig('eeprom');
    board.injectFault({
      command: MSP_EEPROM_WRITE,
      fault: { kind: 'REMOTE_ERROR' },
    });

    const from = board.requests.length;
    const outcome = (await controller.save(
      session.sessionId,
      original,
      draft,
    )) as MotorConfigurationSaveOutcome;
    const sent = commandsOf(board, from);

    expect(sent.filter(command => command === MSP_SET_MOTOR_CONFIG)).toHaveLength(
      1,
    );
    expect(sent.filter(command => command === MSP_EEPROM_WRITE)).toHaveLength(1);
    // The board itself confirms the motor settings are live and unsaved.
    expect(board.hasUnsavedChanges()).toBe(true);

    expect(outcome.kind).not.toBe('FAILED');
    expect(outcome.kind).toBe('PARTIAL_UNPERSISTED');
    if (outcome.kind !== 'PARTIAL_UNPERSISTED') {
      throw new Error('unreachable');
    }
    expect(outcome.acknowledgedGroups).toEqual(['MOTOR']);
    expect(outcome.failedStage).toBe('EEPROM');
  });

  it('a healthy Motors save is unchanged: writes, commits, verifies', async () => {
    const { board, session, controller, original, draft } =
      await motorsRig('healthy');
    const from = board.requests.length;
    const outcome = (await controller.save(
      session.sessionId,
      original,
      draft,
    )) as MotorConfigurationSaveOutcome;
    const sent = commandsOf(board, from);

    expect(sent.filter(command => command === MSP_SET_MOTOR_CONFIG)).toHaveLength(
      1,
    );
    expect(sent.filter(command => command === MSP_EEPROM_WRITE)).toHaveLength(1);
    expect(board.hasUnsavedChanges()).toBe(false);
    expect(outcome.kind).toBe('SAVED_VERIFIED');
  });
});

/* ===================================================================
 * EVERY RESULT A SCREEN CAN BE HANDED HAS A SENTENCE
 * =================================================================== */

describe('the partial-apply vocabulary distinguishes the two RAM-moved cases', () => {
  /* Imported lazily so this block reads as what it is: a check on the
     words, independent of the protocol above. */
  const { partialApplyMessage } = require('../../../ui/presentation/writeStageNames') as {
    partialApplyMessage: (everythingApplied: boolean) => string;
  };

  const everything = partialApplyMessage(true);
  const some = partialApplyMessage(false);

  it('never says the save failed, and never says it succeeded', () => {
    for (const text of [everything, some]) {
      /* «فشل الحفظ» means nothing happened. Something did. */
      expect(text).not.toContain('فشل الحفظ');
      /* «تم الحفظ» claims permanence that does not exist. */
      expect(text).not.toContain('تم الحفظ');
    }
  });

  it('names working memory against permanent storage in both', () => {
    for (const text of [everything, some]) {
      expect(text).toContain('الذاكرة العاملة');
      expect(text).toContain('لا تكرر الحفظ');
    }
  });

  it('separates "all of it is live" from "some of it is live"', () => {
    expect(everything).not.toBe(some);
    // Only the mixed case may warn about a mixture.
    expect(some).toContain('خليط');
    expect(everything).not.toContain('خليط');
  });
});

/* ===================================================================
 * NO SCREEN MAY QUIETLY FALL BACK TO «فشل الحفظ»
 * =================================================================== */

describe('every screen that renders a save outcome handles the partial case', () => {
  /**
   * WHY THIS IS A FILE SCAN AND NOT A TYPE CHECK.
   *
   * TypeScript already enforces exhaustiveness on a switch with no
   * `default` - adding a variant to the union breaks compilation, which
   * is how the rest of this repair was found screen by screen. But two
   * of these consumers legitimately end in `default:` (a Motors quick
   * save, a Setup alignment card), and a `default` swallows a new
   * variant SILENTLY: the screen keeps compiling and starts telling
   * operators a save failed when the aircraft's RAM has moved. That is
   * the exact defect this phase exists to close, re-introduced by the
   * one construct the compiler cannot see through.
   *
   * So: every UI file that consumes a save-outcome union carrying
   * PARTIAL_UNPERSISTED must name it. The scan reads the tracked source
   * rather than a hand-maintained list, so a NEW screen is covered the
   * day it is written.
   */
  const { readFileSync, readdirSync } = require('fs') as typeof import('fs');
  const { join } = require('path') as typeof import('path');

  const PROTOCOL = join(__dirname);
  const UI = join(__dirname, '..', '..', '..', 'ui');

  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        return walk(full);
      }
      return entry.isFile() && /\.tsx?$/.test(entry.name) ? [full] : [];
    });
  }

  /** The outcome type names whose union carries a partial-apply variant. */
  const partialUnions = readdirSync(PROTOCOL)
    .filter(name => name.endsWith('Controller.ts'))
    .flatMap(name => {
      const source = readFileSync(join(PROTOCOL, name), 'utf8');
      if (!source.includes("kind: 'PARTIAL_UNPERSISTED'")) {
        return [];
      }
      return Array.from(
        source.matchAll(/export type (\w*(?:Save|Write)Outcome)\s*=/g),
      ).map(match => match[1]);
    });

  it('finds the outcome unions that carry a partial-apply variant', () => {
    /* If this ever reads zero, every assertion below would pass
       vacuously - the shape of failure a scan-based test must rule out
       before it is allowed to prove anything. */
    expect(partialUnions.length).toBeGreaterThan(0);
  });

  it.each(
    walk(UI)
      .filter(file => !file.endsWith('.test.tsx') && !file.endsWith('.test.ts'))
      .map(file => [file, readFileSync(file, 'utf8')] as const)
      .filter(([, source]) => partialUnions.some(union => source.includes(union)))
      .map(([file, source]) => [file.slice(file.indexOf('src/')), source]),
  )('%s names PARTIAL_UNPERSISTED', (_file, source) => {
    expect(source as string).toContain('PARTIAL_UNPERSISTED');
  });
});
