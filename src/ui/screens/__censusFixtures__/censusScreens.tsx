/**
 * THE SCREEN FIXTURES THE UI CENSUSES SHARE.
 *
 * Every UI-X1 measurement - control census, icon census, indicator
 * truth, the toggle/slider/stepper/selector sweeps, the sequencing
 * re-runs - has to mount the SAME screens in the SAME source-realistic
 * states, or the numbers they report are not about one application.
 * Keeping the registry in one census file and copying it into the next
 * is how two harnesses end up disagreeing about how many controls a
 * screen has.
 *
 * So the fixture layer lives here and the measuring lives in the test
 * files. Nothing in this module measures anything or asserts anything;
 * it builds real snapshots through the real controllers over virtual
 * boards, and hands each screen a port that records what it is asked to
 * do.
 *
 * TWO THINGS EVERY IMPORTER MUST STILL DECLARE ITSELF, because
 * `jest.mock` is per-test-file and cannot be re-exported:
 *
 *   jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');
 *   jest.mock('../../platforms/react-native/protocol/useMspSessionState', () => ({
 *     ...jest.requireActual('../../platforms/react-native/protocol/useMspSessionState'),
 *     useMspOwnershipState: () => 'ACTIVE',
 *     useMspIdentificationState: () => IDENTITY,
 *     useMspRecoveryState: () => 'READY',
 *   }));
 *
 * Without the second one every screen sits in IDLE and never loads, and
 * a census over that measures an empty application.
 */

/*
 * The registry drives twenty screens through deliberately minimal
 * doubles. Each port's real shape is enforced by the screen and by tsc,
 * not here; the `any` casts below are confined to the harness.
 */

import React from 'react';
/* TYPE ONLY. This registry is mounted by Jest AND, through the browser
   fixture, by a real Chromium build - and `react-test-renderer` has no
   business in a browser bundle. The type import is erased; the one place
   that needed `act` takes it by injection instead (see `installAct`). */
import type ReactTestRenderer from 'react-test-renderer';

import FailsafeScreen from '../FailsafeScreen';
import PowerBatteryScreen from '../PowerBatteryScreen';
import GpsScreen from '../GpsScreen';
import PidTuningScreen from '../PidTuningScreen';
import OsdScreen from '../OsdScreen';
import ModesScreen from '../ModesScreen';
import PortsScreen from '../PortsScreen';
import ReceiverScreen from '../ReceiverScreen';
import ConfigurationsScreen from '../ConfigurationsScreen';
import VideoTransmitterScreen from '../VideoTransmitterScreen';
import {MotorConfigurationPanel} from '../MotorConfigurationPanel';
import FlightStyleGuideScreen from '../FlightStyleGuideScreen';
import FlightStyleCornerScreen from '../FlightStyleCornerScreen';
import StartScreen from '../StartScreen';
import LedStripScreen from '../LedStripScreen';
import SensorsScreen from '../SensorsScreen';
import BlackboxScreen from '../BlackboxScreen';
import PresetsScreen from '../PresetsScreen';
import CliScreen from '../CliScreen';
import {MotorsScreenView} from '../MotorsScreen';
import {LedStripConfigurationController} from '../../../platforms/react-native/protocol/LedStripConfigurationController';
import {SensorsConfigurationController} from '../../../platforms/react-native/protocol/SensorsConfigurationController';
import {VirtualLedBoard} from '../../../platforms/react-native/protocol/__testUtils__/virtualLedBoard';
import {
  LedBaseFunction,
  LedDirectionBit,
  encodeLedEntry,
} from '../../../core/protocol/msp/decoding/ledStripWireContract';
import {VirtualSensorsFc} from '../../../platforms/react-native/protocol/__testUtils__/virtualSensorsFc';
import {MspSessionCoordinator} from '../../../platforms/react-native/protocol';
import {
  classifyBlackboxConfig,
  classifyDataflash,
  classifySdcard,
} from '../../../core/state/blackboxStorageSemantics';
import {FailsafeConfigurationController} from '../../../platforms/react-native/protocol/FailsafeConfigurationController';
import {GpsConfigurationController} from '../../../platforms/react-native/protocol/GpsConfigurationController';
import {ModesConfigurationController} from '../../../platforms/react-native/protocol/ModesConfigurationController';
import {MotorConfigurationController} from '../../../platforms/react-native/protocol/MotorConfigurationController';
import {OsdConfigurationController} from '../../../platforms/react-native/protocol/OsdConfigurationController';
import {PidTuningController} from '../../../platforms/react-native/protocol/PidTuningController';
import {PortsConfigurationController} from '../../../platforms/react-native/protocol/PortsConfigurationController';
import {PowerConfigurationController} from '../../../platforms/react-native/protocol/PowerConfigurationController';
import {ReceiverConfigurationController} from '../../../platforms/react-native/protocol/ReceiverConfigurationController';
import {GeneralConfigurationController} from '../../../platforms/react-native/protocol/GeneralConfigurationController';
import {VtxConfigurationController} from '../../../platforms/react-native/protocol/VtxConfigurationController';
import {MSP_MODE_RANGES} from '../../../core/protocol/msp/commands/mspCommands';
import {
  DRONE_SPECS,
  buildFactoryBoard,
} from '../../../platforms/react-native/protocol/__testUtils__/virtualDroneFixtures';
import {VirtualFlightController} from '../../../platforms/react-native/protocol/__testUtils__/virtualFlightController';
import {VirtualSession} from '../../../platforms/react-native/protocol/__testUtils__/virtualSession';

/**
 * The `act` of whichever renderer is driving this registry.
 *
 * Jest injects React's own; the browser fixture leaves the default,
 * where a plain call is correct because React 18's `createRoot` batches
 * on its own and there is no act environment to satisfy.
 */
type Act = (body: () => Promise<void>) => Promise<unknown>;
let currentAct: Act = async body => {
  await body();
};
export function installAct(impl: Act): void {
  currentAct = impl;
}

/**
 * The identified session every screen is mounted under.
 *
 * Declared here AND, unavoidably, again inside each importing test file:
 * `jest.mock` factories are statically checked and may not close over an
 * imported binding, so the copy the mock returns has to be local to the
 * file that installs the mock. This one is what `cliPort` reports.
 */
export const IDENTITY = {
  status: 'SUCCEEDED',
  identity: {
    firmware: {identifier: 'BTFL', knownFamily: 'BETAFLIGHT'},
    apiVersion: {mspProtocolVersion: 0, apiVersionMajor: 1, apiVersionMinor: 47},
    board: {},
  },
};

export const KEY = {sessionId: 'census', generation: 1} as const;

/* ==================================================================== *
 * REAL SNAPSHOTS, THROUGH REAL CONTROLLERS
 * ==================================================================== */

export function board(): VirtualFlightController {
  const spec = DRONE_SPECS.find(candidate => candidate.key === 'LONG_RANGE');
  if (spec === undefined) throw new Error('no LONG_RANGE spec');
  const built = new VirtualFlightController({parameters: buildFactoryBoard(spec)});
  /* Modes draws its editor only when a range exists. */
  const ranges = new Uint8Array(4 * 20);
  ranges[2] = (1300 - 900) / 25;
  ranges[3] = (1700 - 900) / 25;
  built.overwriteParameter(MSP_MODE_RANGES, ranges);
  return built;
}

export async function snapshotVia(
  make: (options: any) => {load: (key: any) => Promise<any>},
): Promise<any> {
  const session = new VirtualSession({
    sessionId: KEY.sessionId,
    board: board(),
    apiMinor: 47,
  });
  const outcome = await make(session.options as any).load(session.key);
  if (outcome.kind !== 'LOADED') {
    throw new Error(`census: expected LOADED, got ${outcome.kind}`);
  }
  return outcome.snapshot ?? outcome;
}

/**
 * The load outcome over a subsystem's OWN virtual board, whatever it is.
 *
 * LED, Sensors and Blackbox do not answer over the shared quad board -
 * they have their own. Where a subsystem still cannot reach LOADED, the
 * honest thing is to hand the screen the REAL refusal and census the
 * state it actually draws for it. A screen's unsupported/failed surface
 * is a state operators see, and its controls deserve pressing too.
 */
const OUTCOME_CACHE = new Map<string, any>();

/**
 * THE SNAPSHOT MUST BELONG TO THE SESSION THE SCREEN IS BOUND TO.
 *
 * U-R3 made every screen refuse a snapshot minted under a different
 * session, which is the entire point of that work. A cache key is not a
 * session id, and using one as the other produced two screens -
 * Sensors and Blackbox - that quietly declined everything handed to
 * them and rendered a single control each. The census then reported
 * "1 control, clean", which is not a clean screen; it is a screen that
 * never opened. The label below is the cache key; the session is always
 * this census's own.
 */
export async function outcomeVia(
  make: (options: any) => {load: (key: any) => Promise<any>},
  virtualBoard: unknown,
  apiMinor: number,
  label: string,
): Promise<any> {
  /* Each screen is mounted once per pass. Driving a virtual board ten
     times over is the difference between a fast census and one that
     exceeds its own budget, and the outcome is identical every time. */
  const cached = OUTCOME_CACHE.get(label);
  if (cached !== undefined) return cached;
  const session = new VirtualSession({
    sessionId: KEY.sessionId,
    board: virtualBoard as never,
    apiMinor,
  });
  /* A THROW HERE IS THE HARNESS FAILING, NOT THE SCREEN.
     It used to be caught and handed to the screen as a `THREW` outcome,
     which the screen correctly rendered as "nothing to show" - and the
     census then counted that as a clean screen with one control. Two
     screens sat like that for a whole pass. A fixture that cannot be
     built is a loud failure now, with the name of the screen on it. */
  const outcome = await make(session.options as any)
    .load(session.key)
    .catch((error: unknown) => {
      throw new Error(
        `census fixture for "${label}" could not be built: ${String(error).slice(0, 160)}`,
      );
    });
  OUTCOME_CACHE.set(label, outcome);
  return outcome;
}

/**
 * SENSORS OPENS A REAL SESSION, BECAUSE IT HAS TO.
 *
 * `VirtualSensorsFc` is not a board - it is a device that exposes a
 * `.client`, and it is meant to be opened on a real
 * `MspSessionCoordinator`, exactly as `sensorsScreenProductionPath`
 * does. Handing it to `VirtualSession` as if it were a board threw
 * `client.getEpoch is not a function`, the census swallowed that, and
 * the screen was censused over an outcome no firmware ever produced.
 */
async function sensorsOutcome(
  label: string,
): Promise<{outcome: any; key: any}> {
  const cached = OUTCOME_CACHE.get(label);
  if (cached !== undefined) return cached;
  const sessionId = `${KEY.sessionId}-sensors`;
  const fc = new VirtualSensorsFc(sessionId);
  const coordinator = new MspSessionCoordinator();
  coordinator.openSession(fc.client, sessionId);
  /* LET IDENTIFICATION FINISH, don't just wait for a key to exist.
     The session key appears as soon as the session is registered, which
     is well before the board has answered the reads the controller needs.
     Loading at that moment returns REJECTED - and the previous pass
     recorded that refusal as if the board had meant it. The production
     path suite waits a fixed settle before taking the key; so does this. */
  await new Promise(resolve => setTimeout(resolve, 600));
  const key = coordinator.getSessionKey(sessionId);
  if (key === undefined) {
    throw new Error('census fixture for "Sensors": no session key after identification');
  }
  const controller = new SensorsConfigurationController({
    coordinator,
    appStateOwner: {getPhase: () => 'ACTIVE'},
    rebootLifecycle: {expectReboot: () => undefined},
  } as never);
  const outcome = await controller.load(key);
  coordinator.deactivateMspSession(sessionId);
  const built = {outcome, key};
  OUTCOME_CACHE.set(label, built);
  return built;
}

/**
 * SENSORS' WHOLE PORT, ANSWERED DETERMINISTICALLY.
 *
 * The snapshot above is real - read from a real board over a real
 * coordinator - but the PORT the screen is given must be steady, and the
 * live controller is not: it keeps reading in the background, so the
 * rendered tree differs from one flush to the next with nobody touching
 * anything, and a census that decides "did this press change the screen"
 * by comparing trees cannot work on a surface that redraws by itself.
 *
 * Seven methods, because the screen calls seven. The two calibration
 * lifecycles matter most: each returns an observation whose `result`
 * stays PENDING until `cancel()` is called, which is what makes the Stop
 * button a control with real work to do. Answering only `load` and
 * `save` leaves Stop with nothing to cancel and scores it dead.
 */
function sensorsPort(outcome: any, record: Recorder): any {
  const snapshot = outcome?.snapshot;
  let cancelled: (() => void) | undefined;
  const observation = () => {
    let settle!: (value: unknown) => void;
    const result = new Promise(resolve => {
      settle = resolve;
    });
    cancelled = () => settle({kind: 'CANCELLED'});
    return {
      result,
      cancel: () => {
        record.calls += 1;
        record.log.push('sensors.calibration.cancel');
        cancelled?.();
      },
    };
  };
  const saved = async () => ({kind: 'NO_CHANGES', snapshot});
  return watched(
    {
      load: async () => outcome,
      saveHardwareSelection: saved,
      verifyHardwarePersistence: saved,
      saveMagAlignment: saved,
      saveAccTrim: saved,
      saveCompassDeclination: saved,
      calibrateAccelerometer: observation,
      calibrateMagnetometer: observation,
    },
    record,
    'sensors',
  );
}

/** A controller double that replays one real outcome and refuses writes. */
function replay(outcome: any, record: Recorder, label: string): any {
  return watched(
    {
      load: async () => outcome,
      save: async () => ({kind: 'NO_CHANGES', snapshot: outcome.snapshot}),
    },
    record,
    label,
  );
}

/* ==================================================================== *
 * THE RECORDER
 *
 * Everything a control could legitimately do, other than change the
 * tree, funnels through one counter. A press that reaches the flight
 * controller, opens a dialog, navigates, or opens a map is not dead - it
 * simply had its effect somewhere the rendered tree cannot show.
 * ==================================================================== */

export interface Recorder {
  calls: number;
  readonly log: string[];
}

export function recorder(): Recorder {
  return {calls: 0, log: []};
}

/**
 * OPEN SUBSCRIPTIONS, WHILE ANYONE IS COUNTING.
 *
 * A screen that subscribes to a port and never calls the teardown it was
 * handed keeps receiving updates into a component that no longer exists.
 * `watched` already sits on every port, so it is the one place that can
 * see a `subscribe` handed out and the returned unsubscribe never used.
 * Off by default - only the lifecycle pass installs a ledger.
 */
let subscriptions: Map<number, string> | undefined;
/** Start counting handed-out subscriptions. */
export function openSubscriptionLedger(): void {
  subscriptions = new Map();
  subscriptionSeq = 0;
}
/** What is still subscribed right now. Throws if no ledger is open, so a
 *  pass can never read an empty map and call it proof. */
export function readSubscriptionLedger(): ReadonlyMap<number, string> {
  if (subscriptions === undefined) {
    throw new Error('subscription ledger is not open');
  }
  return subscriptions;
}
/** Stop counting. */
export function closeSubscriptionLedger(): void {
  subscriptions = undefined;
}
let subscriptionSeq = 0;
const SUBSCRIBES = /^(subscribe|addListener|addEventListener|on[A-Z])/;

/** Wraps every function on a port so a call counts as an effect. */
export function watched<T extends object>(port: T, record: Recorder, label: string): T {
  return new Proxy(port, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        record.calls += 1;
        const name = String(property);
        record.log.push(`${label}.${name}`);
        const outcome = (value as (...a: unknown[]) => unknown).apply(
          target,
          args,
        );
        if (
          subscriptions === undefined ||
          typeof outcome !== 'function' ||
          !SUBSCRIBES.test(name)
        ) {
          return outcome;
        }
        const ticket = (subscriptionSeq += 1);
        subscriptions.set(ticket, `${label}.${name}`);
        const ledger = subscriptions;
        return (...teardown: unknown[]) => {
          ledger.delete(ticket);
          return (outcome as (...a: unknown[]) => unknown)(...teardown);
        };
      };
    },
  });
}

/* ==================================================================== *
 * THE SCREENS
 * ==================================================================== */

export interface ScreenCase {
  readonly name: string;
  readonly mount: (record: Recorder) => Promise<React.ReactElement>;
  /**
   * State a control needs before pressing it means anything.
   *
   * Some controls are gated on something else being true first - the LED
   * grid's empty cells MOVE the selected LED, so with no selection they
   * correctly do nothing. Pressing them in that state and calling them
   * dead would be a false finding; the honest answer is to establish the
   * precondition the product itself requires, then press. Runs once per
   * mount, before discovery.
   */
  readonly precondition?: (
    tree: ReactTestRenderer.ReactTestRenderer,
  ) => Promise<void>;
}

/** Presses one control by testID, for use as a precondition. */
export async function pressById(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): Promise<boolean> {
  const nodes = tree.root.findAll(
    node =>
      (node.props as any)?.testID === testID &&
      typeof (node.props as any)?.onPress === 'function',
    {deep: true},
  );
  if (nodes.length === 0) return false;
  await currentAct(async () => {
    (nodes[nodes.length - 1].props as any).onPress();
    await Promise.resolve();
  });
  return true;
}

const noop = () => undefined;

/**
 * The CLI screen reads a live phase, an output buffer and a subscription
 * - it is not a request/response port. A double that answers only
 * `send` makes the screen throw before it draws anything.
 */
function cliPort(record: Recorder): any {
  let phase: 'IDLE' | 'ACTIVE' | 'SENDING' = 'IDLE';
  let output = '';
  const listeners = new Set<() => void>();
  const publish = (): void => listeners.forEach(listener => listener());
  return watched(
    {
      getPhase: () => phase,
      getOutput: () => output,
      getIdentification: () => IDENTITY,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      begin: async () => {
        phase = 'ACTIVE';
        output = 'Entering CLI Mode\n# ';
        publish();
      },
      execute: async () => {
        phase = 'ACTIVE';
        output += 'ok\n# ';
        publish();
      },
      saveAndClose: async () => {
        phase = 'IDLE';
        publish();
      },
      exitWithoutSave: async () => {
        phase = 'IDLE';
        publish();
      },
    },
    record,
    'cli',
  );
}

/**
 * A navigation collaborator that RECORDS.
 *
 * A "go to Ports" button has its entire effect outside the screen: it
 * calls the callback its host passed in and changes nothing locally.
 * Handing those callbacks a bare no-op would score every working
 * cross-screen link as a dead control - a false finding, and exactly the
 * class of harness error this pass is required not to publish.
 */
export function navigateTo(record: Recorder, label: string): () => void {
  return () => {
    record.calls += 1;
    record.log.push(`navigate.${label}`);
  };
}

/**
 * BLACKBOX, WITH STORAGE THAT EXISTS.
 *
 * The shared virtual board answers none of the Blackbox messages - every
 * one of the five drone fixtures returns FAILED - so the screen drew its
 * "cannot read" state and the census saw a single control. The snapshot
 * below is assembled the way this subsystem's own screen suite assembles
 * one: raw firmware fields put through the PRODUCTION classifiers, so
 * nothing here is a capability the app invented. It describes a board
 * with onboard flash present, ready, and half full - the state in which
 * the screen has something to show and something to erase.
 */
const SIXTEEN_MIB = 16777216;
const EIGHT_MIB = 8388608;

function blackboxSnapshot(): any {
  const config = {
    supported: true,
    supportedRaw: 1,
    deviceRaw: 1,
    legacyRateNumerator: 1,
    legacyRateDenominator: 1,
    pRatio: 32,
    sampleRateRaw: 0,
    disabledFieldsMask: 0,
  };
  return {
    config,
    configuration: classifyBlackboxConfig(config as never),
    dataflash: classifyDataflash({
      flagsRaw: 3,
      supported: true,
      ready: true,
      sectorCount: 256,
      totalBytes: SIXTEEN_MIB,
      usedBytes: EIGHT_MIB,
    } as never),
    sdcard: classifySdcard({
      flagsRaw: 0,
      configured: false,
      stateRaw: 0,
      filesystemLastError: 0,
      freeKilobytes: 0,
      totalKilobytes: 0,
    } as never),
    debugMode: 0,
    debugModeCount: 60,
    pidProcessDenom: 4,
  };
}

/** The whole Blackbox port, including an erase a Cancel can stop. */
function blackboxPort(record: Recorder): any {
  const snapshot = blackboxSnapshot();
  let stop: (() => void) | undefined;
  return watched(
    {
      load: async () => ({kind: 'LOADED', snapshot}),
      save: async () => ({kind: 'NO_CHANGES', snapshot}),
      verifyPersistence: async () => ({kind: 'SUCCEEDED', snapshot}),
      eraseDataflash: () => {
        let settle!: (value: unknown) => void;
        const result = new Promise(resolve => {
          settle = resolve;
        });
        stop = () => settle({kind: 'CANCELLED'});
        return {
          result,
          cancel: () => {
            record.calls += 1;
            record.log.push('blackbox.erase.cancel');
            stop?.();
          },
        };
      },
    },
    record,
    'blackbox',
  );
}

export const SCREENS: readonly ScreenCase[] = [
  {
    name: 'Failsafe',
    mount: async record => {
      const snapshot = await snapshotVia(o => new FailsafeConfigurationController(o));
      return (
        <FailsafeScreen
          sessionKey={KEY}
          active
          onOpenReceiver={navigateTo(record, 'Receiver')}
          onOpenMotors={navigateTo(record, 'Motors')}
          controller={
            watched(
              {
                load: async () => ({kind: 'LOADED', snapshot}),
                save: async () => ({kind: 'NO_CHANGES', snapshot}),
              },
              record,
              'failsafe',
            ) as any
          }
        />
      );
    },
  },
  {
    name: 'Power',
    mount: async record => {
      const snapshot = await snapshotVia(o => new PowerConfigurationController(o));
      return (
        <PowerBatteryScreen
          sessionKey={KEY}
          active
          onOpenMotors={navigateTo(record, 'Motors')}
          controller={
            watched(
              {
                load: async () => ({kind: 'LOADED', snapshot}),
                save: async () => ({kind: 'NO_CHANGES', snapshot}),
              },
              record,
              'power',
            ) as any
          }
        />
      );
    },
  },
  {
    name: 'GPS',
    mount: async record => {
      const snapshot = await snapshotVia(o => new GpsConfigurationController(o));
      return (
        <GpsScreen
          sessionKey={KEY}
          active
          onOpenPorts={navigateTo(record, 'Ports')}
          controller={
            watched(
              {
                load: async () => ({kind: 'LOADED', snapshot}),
                save: async () => ({kind: 'NO_CHANGES', snapshot}),
              },
              record,
              'gps',
            ) as any
          }
        />
      );
    },
  },
  {
    name: 'PID',
    mount: async record => {
      const snapshot = await snapshotVia(o => new PidTuningController(o));
      return (
        <PidTuningScreen
          sessionKey={KEY}
          active
          onOpenMotors={navigateTo(record, 'Motors')}
          controller={
            watched(
              {
                load: async () => ({kind: 'LOADED', snapshot}),
                save: async () => ({kind: 'NO_CHANGES', snapshot}),
              },
              record,
              'pid',
            ) as any
          }
        />
      );
    },
  },
  {
    name: 'OSD',
    mount: async record => {
      const snapshot = await snapshotVia(o => new OsdConfigurationController(o));
      return (
        <OsdScreen
          sessionKey={KEY}
          active
          controller={
            watched(
              {
                load: async () => ({kind: 'LOADED', snapshot}),
                save: async () => ({kind: 'NO_CHANGES', snapshot}),
              },
              record,
              'osd',
            ) as any
          }
        />
      );
    },
  },
  {
    name: 'Modes',
    mount: async record => {
      const snapshot = await snapshotVia(o => new ModesConfigurationController(o));
      return (
        <ModesScreen
          sessionKey={KEY}
          active
          onOpenMotors={navigateTo(record, 'Motors')}
          controller={
            watched(
              {
                load: async () => ({kind: 'LOADED', snapshot}),
                save: async () => ({kind: 'NO_CHANGES', snapshot}),
              },
              record,
              'modes',
            ) as any
          }
        />
      );
    },
  },
  {
    name: 'Ports',
    mount: async record => {
      const snapshot = await snapshotVia(o => new PortsConfigurationController(o));
      return (
        <PortsScreen
          sessionKey={KEY}
          controller={
            watched(
              {
                load: async () => ({kind: 'LOADED', snapshot}),
                save: async () => ({kind: 'NO_CHANGES', snapshot}),
              },
              record,
              'ports',
            ) as any
          }
        />
      );
    },
  },
  {
    name: 'Receiver',
    mount: async record => {
      const snapshot = await snapshotVia(o => new ReceiverConfigurationController(o));
      return (
        <ReceiverScreen
          sessionKey={KEY}
          active
          onOpenPorts={navigateTo(record, 'Ports')}
          onOpenMotors={navigateTo(record, 'Motors')}
          controller={
            watched(
              {
                load: async () => ({kind: 'LOADED', snapshot}),
                save: async () => ({kind: 'NO_CHANGES', snapshot}),
              },
              record,
              'receiver',
            ) as any
          }
        />
      );
    },
  },
  {
    name: 'Configurations',
    mount: async record => {
      const snapshot = await snapshotVia(o => new GeneralConfigurationController(o));
      return (
        <ConfigurationsScreen
          sessionKey={KEY}
          active
          onOpenSetup={navigateTo(record, 'Setup')}
          onOpenMotors={navigateTo(record, 'Motors')}
          onOpenPorts={navigateTo(record, 'Ports')}
          onOpenGps={navigateTo(record, 'Gps')}
          controller={
            watched(
              {
                load: async () => ({kind: 'LOADED', snapshot}),
                save: async () => ({kind: 'NO_CHANGES', snapshot}),
              },
              record,
              'general',
            ) as any
          }
        />
      );
    },
  },
  {
    name: 'VTX',
    mount: async record => {
      const snapshot = await snapshotVia(o => new VtxConfigurationController(o));
      return (
        <VideoTransmitterScreen
          sessionKey={KEY}
          active
          onOpenMotors={navigateTo(record, 'Motors')}
          controller={
            watched(
              {
                load: async () => ({kind: 'LOADED', snapshot}),
                save: async () => ({kind: 'NO_CHANGES', snapshot}),
              },
              record,
              'vtx',
            ) as any
          }
        />
      );
    },
  },
  {
    name: 'MotorConfiguration',
    mount: async record => {
      const snapshot = await snapshotVia(o => new MotorConfigurationController(o));
      return (
        <MotorConfigurationPanel
          sessionKey={KEY}
          controller={
            watched(
              {
                load: async () => ({kind: 'LOADED', snapshot}),
                save: async () => ({
                  kind: 'SAVED_VERIFIED',
                  snapshot,
                  rebootRequired: true,
                  changedGroups: ['ADVANCED'],
                }),
              },
              record,
              'motors',
            ) as any
          }
        />
      );
    },
  },
  {
    name: 'Start',
    mount: async record =>
      (
        <StartScreen
          navigation={
            watched({navigate: noop, goBack: noop}, record, 'nav') as any
          }
          route={{params: {}} as any}
        />
      ),
  },
  {
    name: 'Motors',
    mount: async record => {
      const snapshot = await snapshotVia(o => new MotorConfigurationController(o));
      return (
        <MotorsScreenView
          sessionKey={KEY}
          sessionId={KEY.sessionId}
          active
          operator={undefined}
          onRequestLeave={navigateTo(record, 'Leave')}
          airframeConfigPort={
            watched(
              {
                load: async () => ({kind: 'LOADED', snapshot}),
                save: async () => ({kind: 'NO_CHANGES', snapshot}),
                requestReboot: async () => ({kind: 'REBOOT_ACCEPTED'}),
              },
              record,
              'motors',
            ) as any
          }
        />
      );
    },
  },
  {
    name: 'LED',
    mount: async record => {
      const outcome = await outcomeVia(
        o => new LedStripConfigurationController(o),
        new VirtualLedBoard({
          maxLength: 32,
          advancedRaw: 1,
          profile: 0,
          /* A strip with real LEDs on it. An EMPTY strip is not a
             neutral fixture here: the grid's empty-cell handler moves
             the selected LED, so with nothing to select every cell in
             the canvas is correctly inert and the census would report
             four hundred dead controls that are nothing of the kind. */
          entries: [0, 1, 2].map(index =>
            encodeLedEntry({
              x: index * 5,
              y: index * 3,
              baseFunction: LedBaseFunction.COLOR,
              overlayMask: 0,
              colorIndex: index + 1,
              /* eslint-disable-next-line no-bitwise -- one firmware bit. */
              directionMask: 1 << LedDirectionBit.NORTH,
            }),
          ),
        }),
        48,
        'census-led',
      );
      return (
        <LedStripScreen
          sessionKey={KEY}
          active
          onOpenSetup={navigateTo(record, 'Setup')}
          controller={replay(outcome, record, 'led')}
        />
      );
    },
    /* Select an LED that exists, so the grid's empty cells have
       something to move and can be measured for what they really do. */
    precondition: async tree => {
      await pressById(tree, 'led-cell-0-0');
      await pressById(tree, 'led-cell-5-3');
    },
  },
  {
    name: 'Sensors',
    mount: async record => {
      const {outcome, key} = await sensorsOutcome('census-sensors');
      return (
        <SensorsScreen
          sessionKey={key}
          active
          onOpenSetup={navigateTo(record, 'Setup')}
          controller={sensorsPort(outcome, record)}
          now={() => 0}
        />
      );
    },
  },
  {
    name: 'Blackbox',
    mount: async record => {
      /* No exported virtual board for this subsystem: the one that
         exists lives inside its own production-path suite. The screen is
         censused over the shared board's REAL refusal rather than a
         snapshot nobody's firmware produced. */
      return (
        <BlackboxScreen
          sessionKey={KEY}
          active
          controller={blackboxPort(record)}
          now={() => 0}
        />
      );
    },
  },
  {
    name: 'Presets',
    mount: async record =>
      (
        <PresetsScreen
          sessionKey={KEY}
          active
          onCliBusyChange={noop}
          repository={
            watched(
              {
                loadIndex: async () => ({presets: [], categories: []}),
                loadFirmwareVersion: async () => undefined,
                loadPreset: async () => undefined,
                commands: () => [],
              },
              record,
              'presets',
            ) as any
          }
          cli={
            watched(
              {
                getPhase: () => 'IDLE' as const,
                begin: async () => undefined,
                captureDiffAll: async () => '# diff all\n',
                saveTextFile: async () => true,
                executeBatch: async () => ({commandCount: 0, errors: []}),
                saveAndClose: async () => undefined,
                exitWithoutSave: async () => undefined,
              },
              record,
              'presetsCli',
            ) as any
          }
        />
      ),
  },
  {
    name: 'CLI',
    mount: async record =>
      (
        <CliScreen
          sessionKey={KEY}
          active
          onCliBusyChange={noop}
          cli={cliPort(record)}
        />
      ),
  },
  {
    name: 'FlightStyleGuide',
    mount: async record =>
      (
        <FlightStyleGuideScreen
          navigation={
            watched({navigate: noop, goBack: noop}, record, 'nav') as any
          }
          route={{params: {}} as any}
        />
      ),
  },
  {
    name: 'FlightStyleCorner',
    mount: async record =>
      (
        <FlightStyleCornerScreen
          navigation={
            watched({navigate: noop, goBack: noop}, record, 'nav') as any
          }
          route={{params: {styleId: 'freestyle'}} as any}
        />
      ),
  },
];
