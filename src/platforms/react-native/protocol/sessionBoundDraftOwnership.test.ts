/**
 * A DRAFT MADE FOR ONE AIRCRAFT MAY NEVER BE WRITTEN TO ANOTHER.
 *
 * =====================================================================
 * THE MEASURED DEFECT THIS SUITE EXISTS TO KEEP CLOSED
 * =====================================================================
 *
 * Two flight controllers can be the same target, the same firmware, the
 * same API version, the same UART inventory, the same motor count and
 * BYTE-IDENTICAL in RAM and EEPROM - and still be two different
 * aircraft. Every guard this application had before
 * `core/state/configurationSessionOwnership` compared either
 * CONFIGURATION (stale-base) or LIVENESS (is this session still the one
 * I captured). Neither asks which aircraft the operator was editing.
 *
 * The consequence was measured, not imagined: a draft created against
 * board A, submitted with board B's freshly-minted session key, wrote to
 * B on ALL NINE save-capable screens, because every individual check
 * passed. B's key was current, B's link was live, and - in the
 * byte-identical case - B's bytes matched the snapshot exactly, so
 * stale-base had nothing to object to.
 *
 * =====================================================================
 * WHAT IS ASSERTED, AND WHY IT IS ASSERTED THIS WAY
 * =====================================================================
 *
 * Two boards, always. A refusal that only proves "board B was not
 * written" is worth nothing if the frames went to board A instead, so
 * every wrong-device row names the RECEIVING board and checks both:
 * writes, EEPROM commits, reboots and the subsystem's own bytes, on A
 * and on B.
 *
 * The real controllers, always. Nothing here mocks a controller or
 * re-implements a save plan; the drafts come from the production draft
 * factories and the boards are `VirtualFlightController`, so a refusal
 * is measured at the wire rather than asserted about.
 *
 * And the healthy path, always. A guard that refuses everything would
 * pass every wrong-device row here, so each scenario carries its own
 * same-session control that must still write.
 */

import {
  MSP_ADVANCED_CONFIG,
  MSP_BATTERY_CONFIG,
  MSP_FAILSAFE_CONFIG,
  MSP_FEATURE_CONFIG,
  MSP_FILTER_CONFIG,
  MSP_GPS_CONFIG,
  MSP_MODE_RANGES,
  MSP_MOTOR_CONFIG,
  MSP_OSD_CONFIG,
  MSP_PID,
  MSP_RC_TUNING,
  MSP_RX_CONFIG,
  MSP_SET_ADVANCED_CONFIG,
  MSP_SET_BATTERY_CONFIG,
  MSP_SET_FAILSAFE_CONFIG,
  MSP_SET_FEATURE_CONFIG,
  MSP_SET_FILTER_CONFIG,
  MSP_SET_GPS_CONFIG,
  MSP_SET_MIXER_CONFIG,
  MSP_SET_MODE_RANGE,
  MSP_SET_MOTOR_3D_CONFIG,
  MSP_SET_MOTOR_CONFIG,
  MSP_SET_OSD_CONFIG,
  MSP_SET_PID,
  MSP_SET_PID_ADVANCED,
  MSP_SET_RC_DEADBAND,
  MSP_SET_RC_TUNING,
  MSP_SET_RSSI_CONFIG,
  MSP_SET_RX_CONFIG,
  MSP_SET_RX_MAP,
  MSP2_COMMON_SERIAL_CONFIG,
  MSP2_COMMON_SET_SERIAL_CONFIG,
} from '../../../core/protocol/msp/commands/mspCommands';
import {
  createFailsafeConfigurationDraft,
  createGpsConfigurationDraft,
  createModesConfigurationDraft,
  createOsdConfigurationDraft,
  createPidTuningDraft,
  createPowerConfigurationDraft,
  createReceiverConfigurationDraft,
} from '../../../core';
import {createMotorConfigurationDraft} from '../../../core/state/motorConfigurationModel';
import {
  configurationSessionOwnerOf,
  isOwnedByConfigurationSession,
  isOwnedByDifferentConfigurationSession,
  rememberConfigurationSession,
  sameConfigurationSession,
  type ConfigurationSessionOwner,
} from '../../../core/state/configurationSessionOwnership';
import {FailsafeConfigurationController} from './FailsafeConfigurationController';
import {GpsConfigurationController} from './GpsConfigurationController';
import {ModesConfigurationController} from './ModesConfigurationController';
import {MotorConfigurationController} from './MotorConfigurationController';
import {OsdConfigurationController} from './OsdConfigurationController';
import {PidTuningController} from './PidTuningController';
import {PortsConfigurationController} from './PortsConfigurationController';
import {PowerConfigurationController} from './PowerConfigurationController';
import {ReceiverConfigurationController} from './ReceiverConfigurationController';
import type {SetupUiSessionKey} from './MspSessionCoordinator';
import {
  DRONE_SPECS,
  buildFactoryBoard,
  type DroneSpec,
} from './__testUtils__/virtualDroneFixtures';
import {VirtualFlightController} from './__testUtils__/virtualFlightController';
import {VirtualSession} from './__testUtils__/virtualSession';

jest.setTimeout(300000);

/* ==================================================================== *
 * THE NINE SAVE-CAPABLE SCREENS
 *
 * Each one names: the GET whose bytes ARE this subsystem's identity on
 * the board, every SET frame that counts as "this subsystem was
 * written", and a REAL edit built by the production draft factory. The
 * table is deliberately data, not nine copies of one test.
 *
 * LED strip is absent because the virtual board does not model the LED
 * commands. Its controller carries the same guard and is covered by the
 * predicate-level rows; claiming a wire-level proof it does not have
 * would be worse than naming the gap.
 * ==================================================================== */

interface ScreenUnderTest {
  readonly name: string;
  /** The GET whose bytes are this subsystem's state on the board. */
  readonly readCmd: number;
  /** Every SET frame that means "this subsystem was written". */
  readonly setCmds: readonly number[];
  readonly make: (options: never) => {
    load: (key: SetupUiSessionKey) => Promise<{kind: string; snapshot?: object}>;
    save: (
      key: SetupUiSessionKey,
      original: never,
      draft: never,
    ) => Promise<{kind: string; reason?: string; snapshot?: object}>;
  };
  /** A REAL edit, or undefined when this snapshot has nothing to edit. */
  readonly edit: (snapshot: never) => unknown;
  /** The draft a screen holds the instant after a load, with no edit. */
  readonly plainDraft: (snapshot: never) => unknown;
}

const SCREENS: readonly ScreenUnderTest[] = [
  {
    name: 'Failsafe',
    readCmd: MSP_FAILSAFE_CONFIG,
    setCmds: [MSP_SET_FAILSAFE_CONFIG],
    make: o => new FailsafeConfigurationController(o) as never,
    edit: (snapshot: never) => {
      const draft = createFailsafeConfigurationDraft(snapshot);
      return {...draft, delayDeciseconds: draft.delayDeciseconds + 7};
    },
    plainDraft: (snapshot: never) => createFailsafeConfigurationDraft(snapshot),
  },
  {
    name: 'Power',
    readCmd: MSP_BATTERY_CONFIG,
    setCmds: [MSP_SET_BATTERY_CONFIG],
    make: o => new PowerConfigurationController(o) as never,
    edit: (snapshot: never) => {
      const draft = createPowerConfigurationDraft(snapshot);
      return {...draft, capacityMah: draft.capacityMah + 111};
    },
    plainDraft: (snapshot: never) => createPowerConfigurationDraft(snapshot),
  },
  {
    name: 'GPS',
    readCmd: MSP_GPS_CONFIG,
    setCmds: [MSP_SET_GPS_CONFIG, MSP_SET_FEATURE_CONFIG],
    make: o => new GpsConfigurationController(o) as never,
    edit: (snapshot: never) => {
      const draft = createGpsConfigurationDraft(snapshot);
      return {...draft, homePointOnce: !draft.homePointOnce};
    },
    plainDraft: (snapshot: never) => createGpsConfigurationDraft(snapshot),
  },
  {
    name: 'PID',
    readCmd: MSP_PID,
    setCmds: [
      MSP_SET_PID,
      MSP_SET_PID_ADVANCED,
      MSP_SET_RC_TUNING,
      MSP_SET_FILTER_CONFIG,
    ],
    make: o => new PidTuningController(o) as never,
    edit: (snapshot: never) => {
      const draft = createPidTuningDraft(snapshot);
      return {...draft, roll: {...draft.roll, p: draft.roll.p + 6}};
    },
    plainDraft: (snapshot: never) => createPidTuningDraft(snapshot),
  },
  {
    name: 'OSD',
    readCmd: MSP_OSD_CONFIG,
    setCmds: [MSP_SET_OSD_CONFIG],
    make: o => new OsdConfigurationController(o) as never,
    edit: (snapshot: never) => {
      const draft = createOsdConfigurationDraft(snapshot);
      return {
        ...draft,
        rssiAlarmPercent: draft.rssiAlarmPercent === 55 ? 44 : 55,
      };
    },
    plainDraft: (snapshot: never) => createOsdConfigurationDraft(snapshot),
  },
  {
    name: 'Modes',
    readCmd: MSP_MODE_RANGES,
    setCmds: [MSP_SET_MODE_RANGE],
    make: o => new ModesConfigurationController(o) as never,
    edit: (snapshot: never) => {
      const draft = createModesConfigurationDraft(snapshot);
      const first = draft.conditions[0];
      if (first === undefined || first.kind !== 'RANGE') return undefined;
      const start = first.start >= 1000 ? first.start - 100 : first.start + 100;
      if (start === first.start || start >= first.end) return undefined;
      return {
        ...draft,
        conditions: [{...first, start}, ...draft.conditions.slice(1)],
      };
    },
    plainDraft: (snapshot: never) => createModesConfigurationDraft(snapshot),
  },
  {
    name: 'Ports',
    readCmd: MSP2_COMMON_SERIAL_CONFIG,
    setCmds: [MSP2_COMMON_SET_SERIAL_CONFIG, MSP_SET_FEATURE_CONFIG],
    make: o => new PortsConfigurationController(o) as never,
    /* A NON-administrative UART's telemetry baud. The USB VCP port
       (identifier 20) is left alone on purpose: the screen correctly
       refuses to drop MSP from it, and a test that fought that guard
       would be measuring a product that does not exist. */
    edit: (snapshot: never) => {
      const ports = (snapshot as {ports: readonly {identifier: number; telemetryBaudIndex: number}[]}).ports;
      const index = ports.findIndex(port => port.identifier !== 20);
      if (index < 0) return undefined;
      return ports.map((port, at) =>
        at === index
          ? {...port, telemetryBaudIndex: (port.telemetryBaudIndex + 1) % 6}
          : port,
      );
    },
    plainDraft: (snapshot: never) =>
      (snapshot as {ports: readonly unknown[]}).ports,
  },
  {
    name: 'Receiver',
    readCmd: MSP_RX_CONFIG,
    setCmds: [
      MSP_SET_RX_CONFIG,
      MSP_SET_RX_MAP,
      MSP_SET_RSSI_CONFIG,
      MSP_SET_RC_DEADBAND,
      MSP_SET_FEATURE_CONFIG,
    ],
    make: o => new ReceiverConfigurationController(o) as never,
    edit: (snapshot: never) => {
      const draft = createReceiverConfigurationDraft(snapshot);
      return {...draft, deadband: (draft.deadband + 3) % 30};
    },
    plainDraft: (snapshot: never) => createReceiverConfigurationDraft(snapshot),
  },
  {
    name: 'Motors',
    readCmd: MSP_MOTOR_CONFIG,
    setCmds: [
      MSP_SET_MOTOR_CONFIG,
      MSP_SET_ADVANCED_CONFIG,
      MSP_SET_MIXER_CONFIG,
      MSP_SET_MOTOR_3D_CONFIG,
      MSP_SET_FEATURE_CONFIG,
    ],
    make: o => new MotorConfigurationController(o) as never,
    edit: (snapshot: never) => {
      const draft = createMotorConfigurationDraft(snapshot);
      return {...draft, motorPoleCount: draft.motorPoleCount === 12 ? 14 : 12};
    },
    plainDraft: (snapshot: never) => createMotorConfigurationDraft(snapshot),
  },
];

/* Every SET-shaped command any screen in this set can emit, so a row can
   ask "did ANY subsystem get written" rather than only its own. */
const ALL_SET_COMMANDS: readonly number[] = Object.freeze(
  Array.from(new Set(SCREENS.flatMap(screen => [...screen.setCmds]))),
);

/* The GETs whose bytes must not move on an untouched board. */
const ALL_READ_COMMANDS: readonly number[] = Object.freeze([
  MSP_FAILSAFE_CONFIG,
  MSP_BATTERY_CONFIG,
  MSP_GPS_CONFIG,
  MSP_PID,
  MSP_RC_TUNING,
  MSP_FILTER_CONFIG,
  MSP_OSD_CONFIG,
  MSP_MODE_RANGES,
  MSP2_COMMON_SERIAL_CONFIG,
  MSP_RX_CONFIG,
  MSP_MOTOR_CONFIG,
  MSP_ADVANCED_CONFIG,
  MSP_FEATURE_CONFIG,
]);

/* ==================================================================== *
 * BOARDS, SESSIONS AND THE EVIDENCE TAKEN FROM THEM
 * ==================================================================== */

function spec(key: string): DroneSpec {
  const found = DRONE_SPECS.find(candidate => candidate.key === key);
  if (found === undefined) throw new Error(`no drone spec ${key}`);
  return found;
}

/**
 * Modes needs at least one mode range to have anything to edit, and the
 * factory board ships with none. Seeding the SAME range on both boards
 * keeps a byte-identical pair byte-identical.
 */
function seedModeRange(board: VirtualFlightController): void {
  const bytes = new Uint8Array(4 * 20);
  // One RANGE condition: box 0, AUX1, 1300..1700 in 25µs steps.
  bytes[0] = 0;
  bytes[1] = 0;
  bytes[2] = (1300 - 900) / 25;
  bytes[3] = (1700 - 900) / 25;
  board.overwriteParameter(MSP_MODE_RANGES, bytes);
}

function makeBoard(droneKey: string): VirtualFlightController {
  const board = new VirtualFlightController({
    parameters: buildFactoryBoard(spec(droneKey)),
  });
  seedModeRange(board);
  return board;
}

interface Rig {
  readonly board: VirtualFlightController;
  readonly session: VirtualSession;
}

function rig(
  sessionId: string,
  droneKey: string,
  board = makeBoard(droneKey),
): Rig {
  return {
    board,
    session: new VirtualSession({sessionId, board, apiMinor: 47}),
  };
}

/** Everything a board holds, in one comparable shape. */
function boardState(board: VirtualFlightController) {
  const bytes: Record<number, string> = {};
  for (const command of ALL_READ_COMMANDS) {
    const ram = board.readParameter(command);
    const flash = board.readPersisted(command);
    bytes[command] = `${hex(ram)}|${hex(flash)}`;
  }
  return {
    bytes,
    writes: board.counts.writes,
    eepromWrites: board.counts.eepromWrites,
    reboots: board.counts.reboots,
  };
}

function hex(bytes: Uint8Array | undefined): string {
  return bytes === undefined
    ? '-'
    : Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Every mutating frame this board received, by command. */
function mutatingFrames(board: VirtualFlightController): number[] {
  return board.requests
    .map(record => record.command)
    .filter(command => ALL_SET_COMMANDS.includes(command));
}

function describe_(outcome: {kind: string; reason?: string}): string {
  return outcome.reason === undefined
    ? outcome.kind
    : `${outcome.kind} (${outcome.reason})`;
}

async function loadOrThrow(
  screen: ScreenUnderTest,
  session: VirtualSession,
): Promise<object> {
  const controller = screen.make(session.options as never);
  const outcome = await controller.load(session.key);
  if (outcome.kind !== 'LOADED' || outcome.snapshot === undefined) {
    throw new Error(`${screen.name}: expected LOADED, got ${describe_(outcome)}`);
  }
  return outcome.snapshot;
}

/**
 * The whole wrong-device experiment for one screen, as one function so
 * every scenario measures the same things in the same order.
 *
 * `boardB` is the board the save WOULD have reached. `boardA` is the one
 * the draft was made for. Both are inspected, because "not written to B"
 * is only half a result.
 */
async function submitForeignDraft(
  screen: ScreenUnderTest,
  a: Rig,
  b: Rig,
  options: {readonly bOptions?: unknown} = {},
): Promise<{
  outcome: {kind: string; reason?: string};
  editable: boolean;
  before: {a: ReturnType<typeof boardState>; b: ReturnType<typeof boardState>};
  after: {a: ReturnType<typeof boardState>; b: ReturnType<typeof boardState>};
  framesOnB: number[];
  mutatingOnA: number[];
}> {
  const snapshot = await loadOrThrow(screen, a.session);
  const draft = screen.edit(snapshot as never);
  const before = {a: boardState(a.board), b: boardState(b.board)};
  const framesBeforeB = b.board.requests.length;
  const mutatingBeforeA = mutatingFrames(a.board).length;

  if (draft === undefined) {
    return {
      outcome: {kind: 'NOT_EDITABLE'},
      editable: false,
      before,
      after: before,
      framesOnB: [],
      mutatingOnA: [],
    };
  }

  /* The submission itself: A's snapshot and A's draft, handed to a
     controller bound to B, under B's own freshly-minted key. Every
     individual check this application had before U-R3 passes here. */
  const controller = screen.make(
    (options.bOptions ?? b.session.options) as never,
  );
  const outcome = await controller.save(
    b.session.key,
    snapshot as never,
    draft as never,
  );

  return {
    outcome,
    editable: true,
    before,
    after: {a: boardState(a.board), b: boardState(b.board)},
    framesOnB: b.board.requests
      .slice(framesBeforeB)
      .map(record => record.command),
    mutatingOnA: mutatingFrames(a.board).slice(mutatingBeforeA),
  };
}

/**
 * The controller options a session would give, with a board signature
 * pinned to a chosen value.
 *
 * The signature travels on the IDENTIFICATION STATE - `identity.board` -
 * which is the only place any part of this application could read one
 * from. Pinning it here is what makes "the refusal did not change when
 * the signature did" a measurement rather than an argument.
 */
function optionsWithSignature(
  session: VirtualSession,
  signature: Uint8Array | undefined,
) {
  const base = session.options;
  const identification = () => {
    const state = session.identification() as unknown as {
      identity: {board: Record<string, unknown>};
    };
    return {
      ...state,
      identity: {
        ...state.identity,
        board:
          signature === undefined
            ? state.identity.board
            : {...state.identity.board, signature},
      },
    };
  };
  return {
    ...base,
    coordinator: {
      ...session.coordinator,
      getIdentificationState: identification,
    } as never,
  };
}

/** A same-session save that must still reach the wire. */
async function healthySave(
  screen: ScreenUnderTest,
  rigged: Rig,
): Promise<{outcome: {kind: string; reason?: string}; mutating: number[]}> {
  const snapshot = await loadOrThrow(screen, rigged.session);
  const draft = screen.edit(snapshot as never);
  if (draft === undefined) {
    return {outcome: {kind: 'NOT_EDITABLE'}, mutating: []};
  }
  const before = mutatingFrames(rigged.board).length;
  const controller = screen.make(rigged.session.options as never);
  const outcome = await controller.save(
    rigged.session.key,
    snapshot as never,
    draft as never,
  );
  return {outcome, mutating: mutatingFrames(rigged.board).slice(before)};
}

/* ==================================================================== *
 * 1. THE FRESH-KEY REPLACEMENT, ON ALL NINE SCREENS
 * ==================================================================== */

describe('a draft made under one session is never written under another', () => {
  /**
   * BYTE-IDENTICAL IS THE CASE THAT BROKE. Two boards built from one
   * spec hold the same bytes in RAM and in flash, so stale-base has
   * nothing to object to, the link is live, and the key is current.
   * Configuration cannot separate these two aircraft; only the session
   * they were read under can.
   */
  it.each(SCREENS.map(screen => [screen.name, screen] as const))(
    '%s: refuses A\'s draft under a byte-identical board B\'s key',
    async (_name, screen) => {
      const a = rig('fc-a', 'LONG_RANGE');
      const b = rig('fc-b', 'LONG_RANGE');

      /* The premise of this row, asserted rather than assumed: if the
         boards were not byte-identical the refusal could be stale-base
         wearing a different name. */
      expect(boardState(b.board).bytes).toEqual(boardState(a.board).bytes);

      const result = await submitForeignDraft(screen, a, b);
      if (!result.editable) {
        throw new Error(`${screen.name}: nothing editable to submit`);
      }

      expect(describe_(result.outcome)).toBe('REJECTED (SESSION_CHANGED)');

      /* THE RECEIVING BOARD, NAMED. B is the board the frames would have
         reached; it must be untouched in RAM, in flash and in counters. */
      expect(boardState(b.board)).toEqual(result.before.b);
      expect(result.framesOnB).toEqual([]);

      /* AND THE OTHER ONE. A refusal that quietly wrote to A instead
         would satisfy every assertion above. */
      expect(boardState(a.board).bytes).toEqual(result.before.a.bytes);
      expect(a.board.counts.writes).toBe(result.before.a.writes);
      expect(a.board.counts.eepromWrites).toBe(result.before.a.eepromWrites);
      expect(a.board.counts.reboots).toBe(result.before.a.reboots);
    },
  );

  /**
   * DIFFERENT CONFIGURATION, SAME REFUSAL, AND THE SAME REASON.
   *
   * With two genuinely different boards stale-base WOULD also fire - but
   * only after reading B. Ownership is decided first, so the reason must
   * still be SESSION_CHANGED and the save must not have asked B a single
   * question. That ordering is the whole of §20 in one assertion.
   */
  it.each(SCREENS.map(screen => [screen.name, screen] as const))(
    '%s: refuses before it reads the other board at all',
    async (_name, screen) => {
      const a = rig('fc-a', 'LONG_RANGE');
      const b = rig('fc-b', 'TINY_WHOOP');
      expect(boardState(b.board).bytes).not.toEqual(boardState(a.board).bytes);

      const result = await submitForeignDraft(screen, a, b);
      if (!result.editable) {
        throw new Error(`${screen.name}: nothing editable to submit`);
      }

      expect(describe_(result.outcome)).toBe('REJECTED (SESSION_CHANGED)');
      /* No GET either: not one frame reached B. */
      expect(result.framesOnB).toEqual([]);
      expect(boardState(b.board)).toEqual(result.before.b);
      expect(boardState(a.board).bytes).toEqual(result.before.a.bytes);
    },
  );

  /**
   * AN UNEDITED DRAFT IS REFUSED TOO.
   *
   * The no-op shortcut ("nothing changed, nothing to send") sits inside
   * every save. If the ownership guard were placed after it, a foreign
   * draft that happens to match would come back NO_CHANGES - a calm,
   * successful-looking answer to a question nobody was entitled to ask.
   * The guard is first, so the answer is the refusal.
   */
  it.each(SCREENS.map(screen => [screen.name, screen] as const))(
    '%s: an unedited foreign draft is refused, not reported as NO_CHANGES',
    async (_name, screen) => {
      const a = rig('fc-a', 'LONG_RANGE');
      const b = rig('fc-b', 'LONG_RANGE');
      const snapshot = await loadOrThrow(screen, a.session);
      const controller = screen.make(b.session.options as never);
      const outcome = await controller.save(
        b.session.key,
        snapshot as never,
        screen.plainDraft(snapshot as never) as never,
      );
      expect(describe_(outcome)).toBe('REJECTED (SESSION_CHANGED)');
    },
  );

  /**
   * THE CONTROL. Nine rows of "refused" prove nothing on their own - a
   * controller that refused every save would pass them all. Same board,
   * same session, same key: the write must still happen, and it must
   * reach the board.
   */
  it.each(SCREENS.map(screen => [screen.name, screen] as const))(
    '%s: the same session still saves, and the guard is inert',
    async (_name, screen) => {
      const rigged = rig('fc-a', 'LONG_RANGE');
      const {outcome, mutating} = await healthySave(screen, rigged);
      expect(describe_(outcome)).toBe('SAVED_VERIFIED');
      expect(mutating.length).toBeGreaterThan(0);
      expect(rigged.board.counts.eepromWrites).toBeGreaterThan(0);
    },
  );
});

/* ==================================================================== *
 * 2. THE BOARD SIGNATURE IS NOT CONSULTED, IN ANY OF ITS THREE STATES
 *
 * MSP_BOARD_INFO's 32-byte signature reads like an identity and is not
 * one: it lives in a parameter group, so it is SAVED CONFIGURATION, it
 * is written as 32 zero bytes when the feature is not compiled, an
 * unprovisioned board reports the same zeros, and MSP_SET_SIGNATURE lets
 * any client provision it - so two boards restored from one backup carry
 * one signature. These rows prove the refusal does not change when the
 * signature does, in the direction that matters: equal signatures on two
 * different aircraft must NOT authorise the write.
 * ==================================================================== */

describe('the refusal does not depend on the board signature', () => {
  const SIGNATURE_STATES: readonly (readonly [string, Uint8Array | undefined])[] =
    [
      /* PROVISIONED AND IDENTICAL. Reachable with no malice at all: the
         value is write-once but nothing binds it to hardware, so two
         boards provisioned from one configuration backup carry one
         signature. A naive equals() comparator would call these the same
         device - which is the exact case this repair must refuse. */
      [
        'one provisioned signature on both',
        Uint8Array.from({length: 32}, (_, i) => (i * 7 + 3) % 251 || 1),
      ],
      /* ALL ZERO. What a target built without USE_SIGNATURE reports, and
         also what an unprovisioned board reports, indistinguishably. */
      ['all-zero on both', new Uint8Array(32)],
      /* ABSENT. The identity default, when board info never arrived. */
      ['no signature at all', undefined],
    ];

  it.each(SIGNATURE_STATES)(
    'two different aircraft with %s are still two aircraft',
    async (_label, signature) => {
      const a = rig('fc-a', 'LONG_RANGE');
      const b = rig('fc-b', 'LONG_RANGE');
      const screen = SCREENS[0];

      const result = await submitForeignDraft(screen, a, b, {
        bOptions: optionsWithSignature(b.session, signature),
      });
      expect(describe_(result.outcome)).toBe('REJECTED (SESSION_CHANGED)');
      expect(result.framesOnB).toEqual([]);
      expect(result.mutatingOnA).toEqual([]);
    },
  );

  /**
   * And the module never asks. Stated as a property of the comparison
   * itself rather than of one board: ownership is decided from
   * `{sessionId, generation}` and nothing else can move it.
   */
  it('compares nothing but the session key', () => {
    const snapshot = {any: 'configuration at all'};
    rememberConfigurationSession(snapshot, {sessionId: 'fc-a', generation: 1});
    expect(configurationSessionOwnerOf(snapshot)).toEqual({
      sessionId: 'fc-a',
      generation: 1,
    });
    /* Mutating the configuration cannot change who owns the draft... */
    (snapshot as {any: string}).any = 'completely different configuration';
    expect(
      isOwnedByConfigurationSession(snapshot, {sessionId: 'fc-a', generation: 1}),
    ).toBe(true);
    /* ...and no configuration can make a different session own it. */
    expect(
      isOwnedByConfigurationSession(snapshot, {sessionId: 'fc-b', generation: 1}),
    ).toBe(false);
  });
});

/* ==================================================================== *
 * 3. THE SAME PHYSICAL BOARD, RECONNECTED
 *
 * The operator did not swap anything: the cable was pulled and pushed
 * back, or the board rebooted. The application cannot prove it is the
 * same unit - and does not have to. The old draft is still refused,
 * because it was read from a session that no longer exists; but the
 * refusal must not be a lockout. One reload and the screen works again.
 * ==================================================================== */

describe('the same board, reconnected', () => {
  it.each(SCREENS.map(screen => [screen.name, screen] as const))(
    '%s: refuses the pre-reconnect draft, then works again after one reload',
    async (_name, screen) => {
      const rigged = rig('fc-a', 'LONG_RANGE');
      const stale = await loadOrThrow(screen, rigged.session);
      const staleKey = rigged.session.key;
      const staleDraft = screen.edit(stale as never);
      if (staleDraft === undefined) {
        throw new Error(`${screen.name}: nothing editable`);
      }

      /* Same physical board. New session: the coordinator deletes the
         old entry on detach and mints a new generation on open. */
      rigged.session.reconnect();
      seedModeRange(rigged.board);
      expect(rigged.session.key.generation).toBe(staleKey.generation + 1);

      const controller = screen.make(rigged.session.options as never);
      const framesBefore = rigged.board.requests.length;

      /* The old key is gone; the screen submits under the CURRENT one,
         which is exactly the state a mounted screen would be in. */
      const refused = await controller.save(
        rigged.session.key,
        stale as never,
        staleDraft as never,
      );
      expect(describe_(refused)).toBe('REJECTED (SESSION_CHANGED)');
      expect(rigged.board.requests.length).toBe(framesBefore);

      /* NOT A LOCKOUT. One reload and the same screen saves normally. */
      const {outcome, mutating} = await healthySave(screen, rigged);
      expect(describe_(outcome)).toBe('SAVED_VERIFIED');
      expect(mutating.length).toBeGreaterThan(0);
    },
  );

  /**
   * THE HALF A BARE sessionId COULD NEVER CARRY.
   *
   * The native layer is explicitly allowed to reuse a sessionId string -
   * Android's `UsbDevice.deviceId` is documented by our own transport as
   * not guaranteed stable across detach and reattach, and Web Serial
   * hands out page-lifetime ordinals. `generation` is the reason
   * `SetupUiSessionKey` has two fields, and this row is the reason it
   * must be compared.
   */
  it('refuses a draft whose session id was REUSED for a later activation', async () => {
    const rigged = rig('reused-device-id', 'LONG_RANGE');
    const screen = SCREENS[0];
    const stale = await loadOrThrow(screen, rigged.session);
    const draft = screen.edit(stale as never);

    rigged.session.reconnect();
    seedModeRange(rigged.board);
    /* The id is byte-for-byte the one the draft was made under. */
    expect(rigged.session.key.sessionId).toBe('reused-device-id');

    const controller = screen.make(rigged.session.options as never);
    const outcome = await controller.save(
      rigged.session.key,
      stale as never,
      draft as never,
    );
    expect(describe_(outcome)).toBe('REJECTED (SESSION_CHANGED)');
  });
});

/* ==================================================================== *
 * 4. MOTORS: THE STALE GENERATION ITS OLD API COULD NOT EXPRESS
 *
 * Motors used to take a bare `sessionId`, so a caller holding a key from
 * a previous activation had no way to say so and no way to be told. It
 * now takes the same `SetupUiSessionKey` as the other eight.
 * ==================================================================== */

describe('Motors carries the whole session key', () => {
  const motors = SCREENS.find(screen => screen.name === 'Motors');
  if (motors === undefined) throw new Error('Motors screen missing');

  it('refuses a load whose key names an activation that has ended', async () => {
    const rigged = rig('fc-a', 'LONG_RANGE');
    const stale = rigged.session.key;
    rigged.session.reconnect();

    const controller = new MotorConfigurationController(
      rigged.session.options as never,
    );
    const outcome = await controller.load(stale);
    expect(outcome.kind).toBe('REJECTED');
    expect(rigged.board.counts.writes).toBe(0);
  });

  it('refuses a save whose key names an activation that has ended', async () => {
    const rigged = rig('fc-a', 'LONG_RANGE');
    const snapshot = await loadOrThrow(motors, rigged.session);
    const draft = motors.edit(snapshot as never);
    const stale = rigged.session.key;
    rigged.session.reconnect();

    const controller = new MotorConfigurationController(
      rigged.session.options as never,
    );
    const outcome = await controller.save(
      stale,
      snapshot as never,
      draft as never,
    );
    expect(outcome.kind).toBe('REJECTED');
    expect(rigged.board.counts.writes).toBe(0);
    expect(rigged.board.counts.eepromWrites).toBe(0);
  });
});

/* ==================================================================== *
 * 5. NEGATIVE CONTROLS N1-N7
 *
 * Every one of these restores the guard's inputs to a state in which the
 * refusal MUST NOT happen, or isolates one half of the comparison. A
 * guard that simply refuses everything fails N1, N2 and N3; a guard that
 * compares one half of the key fails N4 or N5.
 * ==================================================================== */

describe('negative controls', () => {
  const screen = SCREENS[0];

  it('N1 - same session, same key: the save goes through untouched', async () => {
    const rigged = rig('fc-a', 'LONG_RANGE');
    const {outcome, mutating} = await healthySave(screen, rigged);
    expect(describe_(outcome)).toBe('SAVED_VERIFIED');
    expect(mutating).toContain(MSP_SET_FAILSAFE_CONFIG);
  });

  it('N2 - a snapshot loaded FROM B saves TO B', async () => {
    const a = rig('fc-a', 'LONG_RANGE');
    const b = rig('fc-b', 'LONG_RANGE');
    const snapshot = await loadOrThrow(screen, b.session);
    const draft = screen.edit(snapshot as never);
    const controller = screen.make(b.session.options as never);
    const outcome = await controller.save(
      b.session.key,
      snapshot as never,
      draft as never,
    );
    expect(describe_(outcome)).toBe('SAVED_VERIFIED');
    expect(b.board.counts.eepromWrites).toBeGreaterThan(0);
    /* And board A, which nobody addressed, is untouched. */
    expect(a.board.counts.writes).toBe(0);
  });

  it('N3 - the snapshot a save returns is owned, so the next edit is not refused', async () => {
    const rigged = rig('fc-a', 'LONG_RANGE');
    const first = await loadOrThrow(screen, rigged.session);
    const controller = screen.make(rigged.session.options as never);
    const saved = await controller.save(
      rigged.session.key,
      first as never,
      screen.edit(first as never) as never,
    );
    expect(saved.kind).toBe('SAVED_VERIFIED');
    if (saved.snapshot === undefined) throw new Error('no snapshot returned');

    /* The screen adopts the verified readback as its next baseline. An
       unregistered one would refuse the operator's very next edit. */
    const again = await controller.save(
      rigged.session.key,
      saved.snapshot as never,
      screen.edit(saved.snapshot as never) as never,
    );
    expect(describe_(again)).toBe('SAVED_VERIFIED');
  });

  it('N4 - a different session id is refused even when the generation matches', () => {
    const snapshot = {};
    rememberConfigurationSession(snapshot, {sessionId: 'fc-a', generation: 3});
    expect(
      isOwnedByConfigurationSession(snapshot, {sessionId: 'fc-b', generation: 3}),
    ).toBe(false);
  });

  it('N5 - a different generation is refused even when the session id matches', () => {
    const snapshot = {};
    rememberConfigurationSession(snapshot, {sessionId: 'fc-a', generation: 3});
    expect(
      isOwnedByConfigurationSession(snapshot, {sessionId: 'fc-a', generation: 4}),
    ).toBe(false);
  });

  it('N6 - the two layers disagree about an UNKNOWN snapshot, on purpose', () => {
    const never_issued = {};
    const current: ConfigurationSessionOwner = {sessionId: 'fc-a', generation: 1};
    /* The controller must refuse what it cannot place: it is the last
       thing before the wire. */
    expect(isOwnedByConfigurationSession(never_issued, current)).toBe(false);
    /* A screen must not TELL the operator the session changed when it
       cannot show that it did. */
    expect(isOwnedByDifferentConfigurationSession(never_issued, current)).toBe(
      false,
    );
    /* And for a snapshot that IS placed, both layers agree. */
    const issued = {};
    rememberConfigurationSession(issued, {sessionId: 'fc-b', generation: 1});
    expect(isOwnedByConfigurationSession(issued, current)).toBe(false);
    expect(isOwnedByDifferentConfigurationSession(issued, current)).toBe(true);
  });

  it('N7 - undefined on either side is never a match', () => {
    const owner: ConfigurationSessionOwner = {sessionId: 'fc-a', generation: 1};
    expect(sameConfigurationSession(undefined, owner)).toBe(false);
    expect(sameConfigurationSession(owner, undefined)).toBe(false);
    expect(sameConfigurationSession(undefined, undefined)).toBe(false);
    expect(sameConfigurationSession(owner, {...owner})).toBe(true);
  });
});

/* ==================================================================== *
 * 6. MUTATIONS M1-M10
 *
 * Each mutation is a specific way this repair could be wrong. None is
 * killed by looking at source text: a predicate mutation is run against
 * the same inputs the product's own comparison sees and must disagree
 * with it, and a placement mutation is killed by an observable property
 * of the REAL controller that only the correct placement produces.
 * ==================================================================== */

describe('mutations', () => {
  const A: ConfigurationSessionOwner = {sessionId: 'fc-a', generation: 1};
  const A2: ConfigurationSessionOwner = {sessionId: 'fc-a', generation: 2};
  const B: ConfigurationSessionOwner = {sessionId: 'fc-b', generation: 1};

  /** Runs a mutant comparison over the cases the product must separate. */
  function disagreesWithProduction(
    mutant: (
      owner: ConfigurationSessionOwner | undefined,
      current: ConfigurationSessionOwner | undefined,
    ) => boolean,
  ): boolean {
    const cases: readonly (readonly [
      ConfigurationSessionOwner | undefined,
      ConfigurationSessionOwner | undefined,
    ])[] = [
      [A, A],
      [A, A2],
      [A, B],
      [A2, A],
      [B, A],
      [undefined, A],
      [A, undefined],
      [undefined, undefined],
    ];
    return cases.some(
      ([owner, current]) =>
        mutant(owner, current) !== sameConfigurationSession(owner, current),
    );
  }

  it('M1 - comparing sessionId alone lets a reused id through', () => {
    expect(
      disagreesWithProduction(
        (owner, current) =>
          owner !== undefined &&
          current !== undefined &&
          owner.sessionId === current.sessionId,
      ),
    ).toBe(true);
  });

  it('M2 - comparing generation alone lets a different board through', () => {
    expect(
      disagreesWithProduction(
        (owner, current) =>
          owner !== undefined &&
          current !== undefined &&
          owner.generation === current.generation,
      ),
    ).toBe(true);
  });

  it('M3 - treating an unknown owner as owned fails open', () => {
    expect(
      disagreesWithProduction((owner, current) =>
        owner === undefined
          ? true
          : current !== undefined &&
            owner.sessionId === current.sessionId &&
            owner.generation === current.generation,
      ),
    ).toBe(true);
  });

  it('M4 - treating an absent current key as owned fails open', () => {
    expect(
      disagreesWithProduction((owner, current) =>
        current === undefined
          ? true
          : owner !== undefined &&
            owner.sessionId === current.sessionId &&
            owner.generation === current.generation,
      ),
    ).toBe(true);
  });

  it('M5 - comparing with >= on the generation admits older drafts', () => {
    expect(
      disagreesWithProduction(
        (owner, current) =>
          owner !== undefined &&
          current !== undefined &&
          owner.sessionId === current.sessionId &&
          owner.generation <= current.generation,
      ),
    ).toBe(true);
  });

  /**
   * M6. If the binding were keyed on a COPY of the snapshot rather than
   * on the object itself, every lookup would miss and every save would
   * be refused - including the healthy one. Killed against the real
   * controller: a shallow copy of a legitimately loaded snapshot is a
   * snapshot this module never issued, and it is refused.
   */
  it('M6 - ownership rides on the snapshot OBJECT, not on its contents', async () => {
    const screen = SCREENS[0];
    const rigged = rig('fc-a', 'LONG_RANGE');
    const snapshot = await loadOrThrow(screen, rigged.session);
    const controller = screen.make(rigged.session.options as never);

    const copy = {...(snapshot as object)};
    const refused = await controller.save(
      rigged.session.key,
      copy as never,
      screen.edit(snapshot as never) as never,
    );
    expect(describe_(refused)).toBe('REJECTED (SESSION_CHANGED)');
    expect(rigged.board.counts.writes).toBe(0);

    /* ...and the real object still works, so this is a statement about
       identity and not a controller that refuses everything. */
    const allowed = await controller.save(
      rigged.session.key,
      snapshot as never,
      screen.edit(snapshot as never) as never,
    );
    expect(describe_(allowed)).toBe('SAVED_VERIFIED');
  });

  /**
   * M7. If a load returned an unregistered snapshot, the very first save
   * an operator attempted would be refused. Killed by the healthy path
   * on all nine screens above; restated here as the direct property.
   */
  it.each(SCREENS.map(screen => [screen.name, screen] as const))(
    'M7 - %s registers ownership on the snapshot its load returns',
    async (_name, screen) => {
      const rigged = rig('fc-a', 'LONG_RANGE');
      const snapshot = await loadOrThrow(screen, rigged.session);
      expect(configurationSessionOwnerOf(snapshot)).toEqual({
        sessionId: 'fc-a',
        generation: 1,
      });
    },
  );

  /**
   * M8. If the guard sat AFTER the no-op check, a foreign draft that
   * happens to match would come back NO_CHANGES. Killed by the real
   * controller in section 1; asserted here on the one screen where the
   * two answers are most easily confused.
   */
  it('M8 - the guard precedes the no-op shortcut', async () => {
    const screen = SCREENS[0];
    const a = rig('fc-a', 'LONG_RANGE');
    const b = rig('fc-b', 'LONG_RANGE');
    const snapshot = await loadOrThrow(screen, a.session);
    const controller = screen.make(b.session.options as never);
    const outcome = await controller.save(
      b.session.key,
      snapshot as never,
      screen.plainDraft(snapshot as never) as never,
    );
    expect(outcome.kind).not.toBe('NO_CHANGES');
    expect(describe_(outcome)).toBe('REJECTED (SESSION_CHANGED)');
  });

  /**
   * M9. If the guard sat AFTER the admission gate, a foreign draft
   * submitted while the link is merely busy or backgrounded would report
   * the admission reason instead - a reason that invites the operator to
   * wait and try again, for a submission that can never be right.
   */
  it('M9 - the guard precedes the admission gate', async () => {
    const screen = SCREENS[0];
    const a = rig('fc-a', 'LONG_RANGE');
    const b = rig('fc-b', 'LONG_RANGE');
    const snapshot = await loadOrThrow(screen, a.session);
    const draft = screen.edit(snapshot as never);

    /* The link is ALSO in a state the admission gate refuses. */
    b.session.appPhase = 'BACKGROUND';
    const controller = screen.make(b.session.options as never);
    const outcome = await controller.save(
      b.session.key,
      snapshot as never,
      draft as never,
    );
    expect(describe_(outcome)).toBe('REJECTED (SESSION_CHANGED)');
    expect(describe_(outcome)).not.toBe('REJECTED (APP_BACKGROUNDED)');

    /* The admission gate itself still works - this row proves an order,
       not the removal of a check. */
    const own = await loadOrThrow(screen, b.session).catch(
      (error: Error) => error.message,
    );
    expect(String(own)).toContain('APP_BACKGROUNDED');
  });

  /**
   * M10. If the ownership metadata were "refreshed" onto a snapshot
   * whenever a screen re-rendered under a new key, the whole repair
   * would evaporate silently. The module offers no such operation: the
   * only way a snapshot becomes owned by session B is to be produced by
   * a load or a verified save under B.
   */
  it('M10 - ownership is never re-pointed at the current session', async () => {
    const screen = SCREENS[0];
    const a = rig('fc-a', 'LONG_RANGE');
    const b = rig('fc-b', 'LONG_RANGE');
    const snapshot = await loadOrThrow(screen, a.session);

    /* Whatever else happens to this session, the snapshot's owner does
       not move: it still names A, and B still refuses it. */
    const controller = screen.make(b.session.options as never);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const outcome = await controller.save(
        b.session.key,
        snapshot as never,
        screen.edit(snapshot as never) as never,
      );
      expect(describe_(outcome)).toBe('REJECTED (SESSION_CHANGED)');
      expect(configurationSessionOwnerOf(snapshot)).toEqual({
        sessionId: 'fc-a',
        generation: 1,
      });
    }
    expect(b.board.counts.writes).toBe(0);

    /* Only a real read from B makes a baseline B can write. */
    const fromB = await loadOrThrow(screen, b.session);
    expect(configurationSessionOwnerOf(fromB)).toEqual({
      sessionId: 'fc-b',
      generation: 1,
    });
  });
});
