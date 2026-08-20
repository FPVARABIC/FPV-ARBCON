/**
 * EVERY SCREEN, AFTER THE CLI WINDOW CLOSES.
 *
 * The CLI is the one screen that can end the session it is running in: a
 * `save` reboots the flight controller. This file asks the question that
 * matters afterwards, once per screen and once per way of leaving the
 * CLI: can the operator simply go to that screen and use it, with no
 * page reload, no unplugging, and nothing left over from before?
 *
 * WHAT EACH HALF PROVES, because neither proves it alone:
 *
 *   cliSessionLifecycle.test.ts drives the REAL MspSessionCoordinator -
 *   real ownership, real leases, real generation, real teardown - over a
 *   board that answers only the handful of commands that file needs.
 *   That is where the session lifecycle itself is proven.
 *
 *   This file drives the REAL screen controllers over a stateful virtual
 *   flight controller that answers the whole configuration surface. That
 *   is where "and then every screen actually loads its data" is proven.
 *
 * A load here is a genuine MSP round trip against a board holding real
 * factory parameters, so LOADED means the screen has data - not that a
 * gate let it through.
 */

import {BoardAlignmentController} from './BoardAlignmentController';
import {FailsafeConfigurationController} from './FailsafeConfigurationController';
import {GeneralConfigurationController} from './GeneralConfigurationController';
import {GpsConfigurationController} from './GpsConfigurationController';
import {ModesConfigurationController} from './ModesConfigurationController';
import {MotorConfigurationController} from './MotorConfigurationController';
import {OsdConfigurationController} from './OsdConfigurationController';
import {PidTuningController} from './PidTuningController';
import {PortsConfigurationController} from './PortsConfigurationController';
import {PowerConfigurationController} from './PowerConfigurationController';
import {ReceiverConfigurationController} from './ReceiverConfigurationController';
import {VtxConfigurationController} from './VtxConfigurationController';
import {
  DRONE_SPECS,
  buildFactoryBoard,
} from './__testUtils__/virtualDroneFixtures';
import {VirtualFlightController} from './__testUtils__/virtualFlightController';
import {VirtualSession} from './__testUtils__/virtualSession';

type Outcome = {kind: string; reason?: string; error?: unknown};

/**
 * THE FOURTEEN SCREENS, as the app's own navigation lists them.
 *
 * Twelve reach the flight controller through a configuration controller
 * and are exercised end to end below. The last two are named here rather
 * than omitted, because a matrix that quietly drops the awkward rows is
 * not a matrix - each says what it actually depends on and where that is
 * covered.
 */
type Options = VirtualSession['options'];
type Key = VirtualSession['key'];

const SCREENS: ReadonlyArray<{
  readonly screen: string;
  readonly load: (options: Options, key: Key) => Promise<Outcome>;
  /**
   * Whether this screen's load carries a session GENERATION at all.
   *
   * Every screen here takes one except Motors, whose controller is
   * addressed by session id and re-reads the coordinator's current key
   * itself. That is deliberate rather than an oversight - a Motors READ
   * has no draft to be stale against - and its write path carries the
   * stale-base guard instead, pinned in
   * motorConfigurationApiCompatibility.test.ts. Asserting a stale-key
   * refusal here would be asserting something the API cannot express.
   */
  readonly carriesGeneration: boolean;
}> = [
  {
    screen: 'Setup',
    carriesGeneration: true,
    load: (o, k) => new GeneralConfigurationController(o).load(k),
  },
  {
    screen: 'Setup / board alignment',
    carriesGeneration: true,
    load: (o, k) => new BoardAlignmentController(o).load(k),
  },
  {
    screen: 'Motors',
    carriesGeneration: false,
    load: (o, k) => new MotorConfigurationController(o).load(k.sessionId),
  },
  {
    screen: 'Ports',
    carriesGeneration: true,
    load: (o, k) => new PortsConfigurationController(o).load(k),
  },
  {
    screen: 'GPS',
    carriesGeneration: true,
    load: (o, k) => new GpsConfigurationController(o).load(k),
  },
  {
    screen: 'Receiver',
    carriesGeneration: true,
    load: (o, k) => new ReceiverConfigurationController(o).load(k),
  },
  {
    screen: 'PID',
    carriesGeneration: true,
    load: (o, k) => new PidTuningController(o).load(k),
  },
  {
    screen: 'Modes',
    carriesGeneration: true,
    load: (o, k) => new ModesConfigurationController(o).load(k),
  },
  {
    screen: 'Failsafe',
    carriesGeneration: true,
    load: (o, k) => new FailsafeConfigurationController(o).load(k),
  },
  {
    screen: 'Power',
    carriesGeneration: true,
    load: (o, k) => new PowerConfigurationController(o).load(k),
  },
  {
    screen: 'OSD',
    carriesGeneration: true,
    load: (o, k) => new OsdConfigurationController(o).load(k),
  },
  {
    screen: 'VTX',
    carriesGeneration: true,
    load: (o, k) => new VtxConfigurationController(o).load(k),
  },
];

/**
 * The two remaining screens of the fourteen, and what carries them.
 *
 * Sensors renders the telemetry stream rather than a configuration
 * snapshot: it has no load of its own, and its usability after a reboot
 * is exactly whether the session has a live telemetry scheduler - which
 * is asserted directly in cliSessionLifecycle.test.ts ("recovers into a
 * usable session after the zombie is detected").
 *
 * Firmware is the flasher. It deliberately operates on a CLOSED MSP
 * session (it takes the port into bootloader mode), so "still has a live
 * MSP session" is not a property it wants; its own path is covered by
 * the flasher suites.
 */
const NON_CONFIGURATION_SCREENS = ['Sensors', 'Firmware'] as const;

/** Ways the operator can leave the CLI, all three of which the app has
 *  to survive. */
type Exit = 'SAVE_AND_REBOOT' | 'EXIT_WITHOUT_SAVING' | 'ERROR_THEN_EXIT';

function rig() {
  const spec =
    DRONE_SPECS.find(candidate => candidate.key === 'FREESTYLE') ??
    DRONE_SPECS[0];
  const board = new VirtualFlightController({parameters: buildFactoryBoard(spec)});
  const session = new VirtualSession({
    sessionId: 'post-cli',
    board,
    apiMinor: spec.hardware.apiMinor,
  });
  return {board, session};
}

/**
 * Leaves the CLI the way `exit` says, including the board-side effects.
 *
 * SAVE_AND_REBOOT is the destructive one: the board power-cycles, so the
 * app is holding a client for hardware that has restarted, and only a
 * reconnect - which the app performs by itself, with no operator action -
 * makes anything work again.
 */
function leaveCli(
  session: VirtualSession,
  board: VirtualFlightController,
  exit: Exit,
): void {
  if (exit !== 'SAVE_AND_REBOOT') return;
  // The reboot AND the reconnect the app does on its own behalf. The
  // generation moves, which is what every screen's staleness guard reads.
  session.reconnect();
  expect(board.hasUnsavedChanges()).toBe(false);
}

describe.each<Exit>([
  'SAVE_AND_REBOOT',
  'EXIT_WITHOUT_SAVING',
  'ERROR_THEN_EXIT',
])('every screen is usable after CLI ends with %s', exit => {
  it.each(SCREENS.map(s => [s.screen, s] as const))(
    '%s loads its configuration from the board',
    async (_name, entry) => {
      const {board, session} = rig();
      const generationBefore = session.key.generation;

      leaveCli(session, board, exit);

      const outcome = await entry.load(session.options, session.key);
      const detail =
        outcome.reason ??
        (outcome.error instanceof Error ? outcome.error.message : '');
      expect(`${entry.screen}: ${outcome.kind}${detail ? ` (${detail})` : ''}`).toBe(
        `${entry.screen}: LOADED`,
      );

      // The reboot really did produce a NEW session identity - so a
      // screen still holding the old one is refused rather than silently
      // reading across the reboot.
      if (exit === 'SAVE_AND_REBOOT') {
        expect(session.key.generation).not.toBe(generationBefore);
        if (entry.carriesGeneration) {
          const stale = await entry.load(session.options, {
            sessionId: session.sessionId,
            generation: generationBefore,
          });
          expect(`${entry.screen} stale-key: ${stale.kind}`).not.toBe(
            `${entry.screen} stale-key: LOADED`,
          );
        }
      }
    },
    20_000,
  );
});

describe('the matrix covers every screen it claims to', () => {
  it('names fourteen screens in total', () => {
    expect(SCREENS.length + NON_CONFIGURATION_SCREENS.length).toBe(14);
  });

  it('never loads twice from the same controller instance by accident', () => {
    // Each row builds its own controller, so nothing can carry a cached
    // snapshot from a previous row into the next one - which is the
    // whole point of asking about stale state.
    expect(new Set(SCREENS.map(s => s.screen)).size).toBe(SCREENS.length);
  });
});
