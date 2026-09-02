/**
 * EVERY CONTROL THE PRODUCT DRAWS, DISCOVERED FROM THE RENDER AND
 * ACTUALLY PRESSED.
 *
 * =====================================================================
 * WHY A HANDLER IS NOT PROOF
 * =====================================================================
 *
 * `onPress={doThing}` in source proves a function is attached. It does
 * not prove the control is reachable, that it is enabled when it looks
 * enabled, that pressing it changes anything, or that what it changes is
 * what its label promises. Every one of those has shipped broken in a
 * real product, and none of them is visible to a source scan.
 *
 * So this suite mounts the REAL screens and:
 *
 *   DISCOVERS   every interactive node from the rendered tree - not from
 *               a maintained list. A control that stops rendering
 *               disappears from the census, and a control that starts
 *               rendering joins it without anyone updating a table.
 *   PRESSES     each one, inside act(), through the same handler prop a
 *               human press would reach.
 *   MEASURES    the consequence three ways: the rendered tree changed,
 *               a port the screen talks to was called, or a navigation
 *               or dialog was requested.
 *
 * An ENABLED control that produces none of the three is a DEAD CONTROL,
 * and this suite fails on it.
 *
 * =====================================================================
 * WHAT THE SCREENS ARE GIVEN
 * =====================================================================
 *
 * Real snapshots, loaded through the real controllers over a
 * `VirtualFlightController`. A hand-written snapshot would test the
 * fixture; a screen that never leaves its loading state draws almost no
 * controls at all. Where the shared virtual board cannot serve a
 * subsystem, that screen is measured in the state it CAN reach and the
 * gap is named in `NOT_MEASURED` rather than papered over.
 *
 * The session hooks are answered as an ACTIVE, identified session,
 * because they read a process-wide coordinator singleton this suite does
 * not open. That substitution decides whether a screen renders its
 * workspace at all; it does not decide what any control does.
 */

/*
 * The census drives thirteen screens through deliberately minimal
 * doubles. Each port's real shape is enforced by the screen and by tsc,
 * not here; the `any` casts below are confined to the harness.
 */

const IDENTITY = {
  status: 'SUCCEEDED',
  identity: {
    firmware: {identifier: 'BTFL', knownFamily: 'BETAFLIGHT'},
    apiVersion: {mspProtocolVersion: 0, apiVersionMajor: 1, apiVersionMinor: 47},
    board: {},
  },
};

/* StartScreen reaches the session layer, which reaches the native USB
   TurboModule. There is no native binary under Jest, and this census is
   about what the screens DRAW, not about the transport. */
jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

jest.mock('../../platforms/react-native/protocol/useMspSessionState', () => ({
  ...jest.requireActual('../../platforms/react-native/protocol/useMspSessionState'),
  useMspOwnershipState: () => 'ACTIVE',
  useMspIdentificationState: () => IDENTITY,
  useMspRecoveryState: () => 'READY',
}));

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {Alert, Linking} from 'react-native';

import '../../i18n';
import i18n from '../../i18n';
import FailsafeScreen from './FailsafeScreen';
import PowerBatteryScreen from './PowerBatteryScreen';
import GpsScreen from './GpsScreen';
import PidTuningScreen from './PidTuningScreen';
import OsdScreen from './OsdScreen';
import ModesScreen from './ModesScreen';
import PortsScreen from './PortsScreen';
import ReceiverScreen from './ReceiverScreen';
import ConfigurationsScreen from './ConfigurationsScreen';
import VideoTransmitterScreen from './VideoTransmitterScreen';
import {MotorConfigurationPanel} from './MotorConfigurationPanel';
import FlightStyleGuideScreen from './FlightStyleGuideScreen';
import FlightStyleCornerScreen from './FlightStyleCornerScreen';
import StartScreen from './StartScreen';
import FirmwareFlasherSimpleScreen from './FirmwareFlasherSimpleScreen';
import LedStripScreen from './LedStripScreen';
import SensorsScreen from './SensorsScreen';
import BlackboxScreen from './BlackboxScreen';
import PresetsScreen from './PresetsScreen';
import CliScreen from './CliScreen';
import {MotorsScreenView} from './MotorsScreen';
import {LedStripConfigurationController} from '../../platforms/react-native/protocol/LedStripConfigurationController';
import {SensorsConfigurationController} from '../../platforms/react-native/protocol/SensorsConfigurationController';
import {VirtualLedBoard} from '../../platforms/react-native/protocol/__testUtils__/virtualLedBoard';
import {
  LedBaseFunction,
  LedDirectionBit,
  encodeLedEntry,
} from '../../core/protocol/msp/decoding/ledStripWireContract';
import {VirtualSensorsFc} from '../../platforms/react-native/protocol/__testUtils__/virtualSensorsFc';
import {MspSessionCoordinator} from '../../platforms/react-native/protocol';
import {
  classifyBlackboxConfig,
  classifyDataflash,
  classifySdcard,
} from '../../core/state/blackboxStorageSemantics';
import {FailsafeConfigurationController} from '../../platforms/react-native/protocol/FailsafeConfigurationController';
import {GpsConfigurationController} from '../../platforms/react-native/protocol/GpsConfigurationController';
import {ModesConfigurationController} from '../../platforms/react-native/protocol/ModesConfigurationController';
import {MotorConfigurationController} from '../../platforms/react-native/protocol/MotorConfigurationController';
import {OsdConfigurationController} from '../../platforms/react-native/protocol/OsdConfigurationController';
import {PidTuningController} from '../../platforms/react-native/protocol/PidTuningController';
import {PortsConfigurationController} from '../../platforms/react-native/protocol/PortsConfigurationController';
import {PowerConfigurationController} from '../../platforms/react-native/protocol/PowerConfigurationController';
import {ReceiverConfigurationController} from '../../platforms/react-native/protocol/ReceiverConfigurationController';
import {GeneralConfigurationController} from '../../platforms/react-native/protocol/GeneralConfigurationController';
import {VtxConfigurationController} from '../../platforms/react-native/protocol/VtxConfigurationController';
import {MSP_MODE_RANGES} from '../../core/protocol/msp/commands/mspCommands';
import {
  DRONE_SPECS,
  buildFactoryBoard,
} from '../../platforms/react-native/protocol/__testUtils__/virtualDroneFixtures';
import {VirtualFlightController} from '../../platforms/react-native/protocol/__testUtils__/virtualFlightController';
import {VirtualSession} from '../../platforms/react-native/protocol/__testUtils__/virtualSession';

/* ==================================================================== *
 * HARD TIME BOUNDS
 *
 * Nothing here is allowed to wait forever, and no timeout is allowed to
 * become a pass. A press that has not finished inside PRESS_BUDGET_MS is
 * recorded as TIMEOUT and fails its screen; a screen that has not
 * finished its controls inside SCREEN_BUDGET_MS reports the remainder as
 * NOT_MEASURED and fails. The Jest per-test limit sits above both so it
 * is the harness, not the runner, that reports the reason.
 *
 *   PRESS_BUDGET_MS   a handler runs against in-memory doubles and a
 *                     virtual board; two seconds is orders of magnitude
 *                     over anything legitimate.
 *   SCREEN_BUDGET_MS  the widest screen measured so far draws 172
 *                     controls; sixty seconds is ~350ms each.
 *   jest.setTimeout   screen budget + snapshot load over the virtual
 *                     board + margin.
 * ==================================================================== */
const PRESS_BUDGET_MS = 2000;
const SCREEN_BUDGET_MS = 60000;
jest.setTimeout(120000);

/**
 * Harness-only progress trace. Off by default; UIX1_TRACE=1 turns it on.
 *
 * Written to stderr rather than through `console`, deliberately: Jest
 * BUFFERS captured console output until a test file finishes, which is
 * precisely when a stalled run tells you nothing. Progress instrumentation
 * that only prints after the run completes cannot locate a hang.
 */
const TRACE = process.env.UIX1_TRACE === '1';
const started = Date.now();
function trace(line: string): void {
  if (!TRACE) return;
  const elapsed = ((Date.now() - started) / 1000).toFixed(1).padStart(7);
  process.stderr.write(`[UI-X1 ${elapsed}s] ${line}\n`);
}

/** A cancellable deadline. Unref'd so a live timer cannot hold Jest open. */
function deadline(ms: number): {
  readonly promise: Promise<'TIMEOUT'>;
  readonly cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<'TIMEOUT'>(resolve => {
    timer = setTimeout(() => resolve('TIMEOUT'), ms);
    (timer as unknown as {unref?: () => void}).unref?.();
  });
  return {promise, cancel: () => clearTimeout(timer)};
}

/** Where the wall clock actually goes, per screen. */
interface Cost {
  discover: number;
  serialise: number;
  invoke: number;
}
const cost = (): Cost => ({discover: 0, serialise: 0, invoke: 0});

beforeAll(async () => {
  if (!i18n.isInitialized) await i18n.init();
});

const KEY = {sessionId: 'census', generation: 1} as const;

/* ==================================================================== *
 * REAL SNAPSHOTS, THROUGH REAL CONTROLLERS
 * ==================================================================== */

function board(): VirtualFlightController {
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

async function snapshotVia(
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
async function outcomeVia(
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

interface Recorder {
  calls: number;
  readonly log: string[];
}

function recorder(): Recorder {
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
let subscriptionSeq = 0;
const SUBSCRIBES = /^(subscribe|addListener|addEventListener|on[A-Z])/;

/** Wraps every function on a port so a call counts as an effect. */
function watched<T extends object>(port: T, record: Recorder, label: string): T {
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
 * DISCOVERY
 * ==================================================================== */

/** Every prop through which this application delivers an interaction. */
const HANDLERS = [
  'onPress',
  'onLongPress',
  'onValueChange',
  'onChangeText',
  'onSelect',
  'onSubmitEditing',
] as const;

interface Discovered {
  readonly id: string;
  readonly handler: (typeof HANDLERS)[number];
  readonly disabled: boolean;
  /**
   * The PLATFORM refuses the interaction: `disabled` on a Pressable, or
   * `editable={false}` on an input. React Native never calls the handler
   * in that state, so neither may this census - invoking the prop
   * directly would walk straight past a guard no user can walk past, and
   * report a defect that cannot happen.
   */
  readonly guarded: boolean;
  /**
   * The control SAYS it is disabled - to a screen reader - while nothing
   * actually stops it. That gap is a real defect, and the only one the
   * census is entitled to press for.
   */
  readonly declaredDisabledOnly: boolean;
  readonly labelled: boolean;
  /** Already the chosen option in its group, right now. */
  readonly selected: boolean;
  /** Why the harness cannot press it honestly, when it cannot. */
  readonly unmeasurable?: string;
  readonly invoke: () => unknown;
  /**
   * Drives the real touch responder chain, for controls that have one.
   * `undefined` where the interaction is not a press at all - a Switch's
   * `onValueChange` and a TextInput's `onChangeText` are not gestures.
   */
  readonly touch?: () => Touch;
  /**
   * IT CAN BE REACHED WITHOUT A POINTER.
   *
   * React Native and react-native-web both decide focus order from the
   * host view's `accessible` and `focusable` props: `accessible={false}`
   * takes a control out of the accessibility tree, `focusable={false}`
   * takes it out of the tab order, and either one leaves a control that
   * a mouse can use and a keyboard or a screen reader cannot. Measured
   * on the rendered host, not inferred from the component.
   *
   * `undefined` where the question does not apply - a control with no
   * touch-handling host, or one that is disabled and correctly absent
   * from the tab order.
   */
  readonly keyboardReachable?: boolean;
}

/* ==================================================================== *
 * A REAL PRESS, NOT A PROP CALL
 *
 * Calling `props.onPress()` is not what a finger does. React Native
 * decides whether a press happens at the TOUCH RESPONDER layer: the host
 * view that `Pressable` renders is asked `onStartShouldSetResponder`, and
 * a disabled Pressable answers false - the handler is never reached, no
 * matter what the props say.
 *
 * That distinction is the whole of the "disabled but activatable" defect
 * class. A control that carries `disabled` is genuinely unreachable. A
 * control that carries only `accessibilityState={{disabled: true}}` tells
 * a screen reader the action is unavailable and then performs it anyway -
 * and the only instrument that can tell those two apart is one that goes
 * through the responder chain instead of around it. Measured, not
 * assumed:
 *
 *   <Pressable disabled>                         claimed=false fired=0
 *   <Pressable>                                  claimed=true  fired=1
 *   <Pressable accessibilityState={{disabled}}>  claimed=true  fired=1  <- the defect
 * ==================================================================== */

/** A synthetic touch, shaped the way Pressability reads it. */
function touchEvent(): any {
  const at = Date.now();
  return {
    nativeEvent: {
      locationX: 1,
      locationY: 1,
      pageX: 1,
      pageY: 1,
      timestamp: at,
      touches: [],
      changedTouches: [],
      identifier: 1,
      target: 1,
    },
    currentTarget: 1,
    target: 1,
    timeStamp: at,
    persist: () => undefined,
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  };
}

interface Touch {
  /** A host view underneath this control accepts touches at all. */
  readonly reachable: boolean;
  /** The responder chain agreed to take the gesture. */
  readonly claimed: boolean;
}

/** The touch-handling host view this control renders, if it renders one. */
function responderHost(
  node: ReactTestRenderer.ReactTestInstance,
): ReactTestRenderer.ReactTestInstance | undefined {
  const wired = (candidate: ReactTestRenderer.ReactTestInstance): boolean =>
    typeof candidate.type === 'string' &&
    typeof (candidate.props as any)?.onStartShouldSetResponder === 'function';
  if (wired(node)) return node;
  try {
    return node.findAll(wired, {deep: true})[0];
  } catch {
    return undefined;
  }
}

/** Presses through the responder chain, exactly as a finger would. */
function touchThrough(node: ReactTestRenderer.ReactTestInstance): Touch {
  const host = responderHost(node);
  if (host === undefined) return {reachable: false, claimed: false};
  const props = host.props as any;
  const claimed = props.onStartShouldSetResponder() !== false;
  if (!claimed) return {reachable: true, claimed: false};
  const event = touchEvent();
  props.onResponderGrant?.(event);
  props.onResponderMove?.(event);
  props.onResponderRelease?.(event);
  return {reachable: true, claimed: true};
}

/** The nearest testID at or above a node, within a few generations. */
function inheritedTestID(
  node: ReactTestRenderer.ReactTestInstance,
): string | undefined {
  let current: ReactTestRenderer.ReactTestInstance | null = node;
  for (let up = 0; up < 3 && current !== null; up += 1) {
    const own = (current.props as any)?.testID;
    if (typeof own === 'string') return own;
    try {
      current = current.parent;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** The text a control carries, for controls with neither id nor label. */
function textOf(node: ReactTestRenderer.ReactTestInstance): string {
  const parts: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') parts.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
  };
  try {
    for (const text of node.findAllByType('Text' as never)) {
      walk((text as {props: {children?: unknown}}).props.children);
    }
  } catch {
    /* A host node with no Text descendant. Nothing to add. */
  }
  return parts.join(' ').trim().slice(0, 40);
}

function discover(tree: ReactTestRenderer.ReactTestRenderer): Discovered[] {
  const found: Discovered[] = [];
  const nodes = tree.root.findAll(
    node =>
      node.props !== undefined &&
      HANDLERS.some(handler => typeof (node.props as any)[handler] === 'function'),
    {deep: true},
  );

  let anonymous = 0;
  const byKey = new Map<string, Discovered>();

  for (const node of nodes) {
    const props = node.props as any;
    const handler = HANDLERS.find(
      candidate => typeof props[candidate] === 'function',
    );
    if (handler === undefined) continue;

    /* ONE CONTROL, ONE IDENTITY.
       A Pressable and the host view it renders both carry the handler,
       and they do not always carry the same identifying props - the LED
       grid's cells surfaced twice, once as `led-cell-7-3` and once as
       the Arabic label on the inner node. Two identities for one control
       means two census rows, two verdicts, and an action contract that
       matches only one of them. So a node with no testID of its own
       borrows the nearest one above it. */
    const ownedTestID =
      typeof props.testID === 'string' ? props.testID : inheritedTestID(node);
    const labelled =
      typeof ownedTestID === 'string' ||
      typeof props.accessibilityLabel === 'string' ||
      typeof props.label === 'string';
    const text = labelled ? '' : textOf(node);
    const id: string =
      ownedTestID ??
      props.accessibilityLabel ??
      (typeof props.label === 'string' ? props.label : undefined) ??
      (text.length > 0
        ? `text:${text}`
        : /* No testID, no accessibility label, no text of its own: an
             icon-only control with no accessible name. Identified by its
             component type and order so the census can address it, and
             counted as UNLABELLED so it is reported rather than lost. */
          `unnamed:${String(
            typeof node.type === 'string'
              ? node.type
              : ((node.type as {displayName?: string; name?: string})
                  ?.displayName ??
                  (node.type as {name?: string})?.name ??
                  'Component'),
          )}#${(anonymous += 1)}`);

    const guarded = props.disabled === true || props.editable === false;
    const declaredDisabled = props.accessibilityState?.disabled === true;
    const disabled = guarded || declaredDisabled;
    const argument = argumentFor(handler, props);
    const gesture = handler === 'onPress' || handler === 'onLongPress';
    const host = gesture && !disabled ? responderHost(node) : undefined;
    const hostProps = host?.props as any;

    const entry: Discovered = {
      id,
      handler,
      disabled,
      guarded,
      declaredDisabledOnly: declaredDisabled && !guarded,
      labelled,
      selected:
        props.accessibilityState?.selected === true ||
        props['aria-checked'] === true,
      unmeasurable: refusedPress(id) ?? (argument.kind === 'UNKNOWN' ? argument.why : undefined),
      invoke: () => {
        const live = node.props as any;
        return argument.kind === 'VALUE'
          ? live[handler](argument.value)
          : live[handler]();
      },
      touch: gesture ? () => touchThrough(node) : undefined,
      keyboardReachable:
        hostProps === undefined
          ? undefined
          : hostProps.accessible !== false && hostProps.focusable !== false,
    };
    /* A composite and the host it renders both carry the handler. The
       INNER one is the control; `findAll` yields parents first, so the
       last writer for a key wins. */
    byKey.set(`${id}::${handler}`, entry);
  }

  for (const entry of byKey.values()) found.push(entry);
  return found;
}

/**
 * CONTROLS THIS CENSUS DELIBERATELY WILL NOT PRESS.
 *
 * Not because pressing them is hard - because pressing them means
 * driving a motor-test session, and a generic presser is the wrong
 * instrument for the one subsystem in this application that can spin a
 * propeller. Their behaviour is already proven, per control, by the
 * Motors production-path suites; what would be added here is risk, not
 * evidence. Each is reported NOT_MEASURED with this reason attached,
 * never as an executed control and never as a dead one.
 */
const NOT_PRESSED: readonly {readonly id: RegExp; readonly why: string}[] = [
  {
    id: /^motor-session-toggle$/,
    why: 'opens the motor-test session; exercised by the Motors production-path suites, not by a generic presser',
  },
  {
    id: /^motors-stop-button$/,
    why: 'the emergency stop is deliberately always enabled and acts only on a live session; its stop path is proven in the Motors safety suites',
  },
  {
    id: /^motor-output-mapping-read$/,
    why: 'reads diagnostics from a live motor-test session',
  },
  {
    id: /^motor-config-refresh$/,
    why: 'refreshes against a live motor-test session',
  },
  {
    id: /^home-connect-retry$/,
    why: 'retries a failed connection attempt; requires a prior transport failure this census does not stage',
  },
];

function refusedPress(id: string): string | undefined {
  return NOT_PRESSED.find(rule => rule.id.test(id))?.why;
}

/** The argument a handler needs, or an honest refusal to invent one. */
type Argument =
  | {readonly kind: 'NONE'}
  | {readonly kind: 'VALUE'; readonly value: unknown}
  | {readonly kind: 'UNKNOWN'; readonly why: string};

/**
 * A plausible argument for handlers that take one - deliberately a
 * DIFFERENT value from the one the control already holds, and NEVER a
 * value invented out of nothing.
 *
 * Two ways to manufacture a fake dead control, both learned here:
 *
 *   Hand a select its CURRENT key, or a text field its current text, and
 *   the control correctly does nothing. That is a request for no change,
 *   not a defect - so the argument asks for something new.
 *
 *   Hand a numeric callback a STRING and it can silently miss. The OSD
 *   preview's onSelect is `(index: number) => void`; called with '0' it
 *   sets the selected element to the string "0", after which
 *   `itemIndex === index` is false for every element and the whole
 *   element editor goes inert. No user can produce that input - tsc
 *   forbids it outside this `any`-typed harness - so the census must not
 *   produce it either. Where the shape cannot be read off the props, the
 *   control is reported NOT_MEASURED rather than pressed with a guess.
 */
function argumentFor(handler: (typeof HANDLERS)[number], props: any): Argument {
  if (handler === 'onValueChange') {
    return {kind: 'VALUE', value: props.value !== true};
  }
  if (handler === 'onChangeText') {
    /* A numeric field holding "1.00" is unchanged by the text "1". Ask
       for a number it is not already showing. */
    const current = String(props.value ?? '');
    const asNumber = Number(current);
    if (current.trim() !== '' && Number.isFinite(asNumber)) {
      /* DOWNWARDS by default. These fields carry a maximum and several
         of them sit ON it (throttle limit 100%, RPM harmonics 3), where
         asking for one more is clamped straight back and looks like a
         dead field. One less is inside the range wherever the range has
         any width at all. */
      return {kind: 'VALUE', value: String(asNumber > 0 ? asNumber - 1 : asNumber + 1)};
    }
    return {kind: 'VALUE', value: current === '1' ? '2' : '1'};
  }
  if (handler === 'onSelect') {
    const options: any[] = Array.isArray(props.options) ? props.options : [];
    if (options.length > 0) {
      const current = props.selectedKey ?? props.value;
      const other =
        options.find(option => (option?.key ?? option?.value) !== current) ??
        options[0];
      return {kind: 'VALUE', value: other?.key ?? other?.value};
    }
    /* An index-shaped selector: answer in its own type, and pick an
       index that is certainly different from the current one. */
    if (typeof props.selectedIndex === 'number') {
      return {kind: 'VALUE', value: props.selectedIndex === 0 ? 1 : 0};
    }
    return {
      kind: 'UNKNOWN',
      why: 'onSelect exposes neither options nor a numeric selectedIndex',
    };
  }
  return {kind: 'NONE'};
}

/* ==================================================================== *
 * WHAT THE CONTROL PROMISED
 *
 * "Something changed" is not proof that a control did its job. A Refresh
 * wired to navigation changes plenty and refreshes nothing; an
 * effect-only oracle waves it through. So each control is read for the
 * action CLASS its own name commits it to, and the evidence has to match
 * that class - not merely be non-empty.
 *
 * The classes are deliberately few and derived from the identifiers the
 * product already uses. Where a control makes no such promise it is
 * ANY, and the old rule applies: do something observable, or be dead.
 * ==================================================================== */

type ActionClass =
  | 'READ'
  | 'SAVE'
  | 'NAVIGATE'
  | 'SELECT'
  | 'CONFIRM'
  | 'REVEAL'
  | 'ANY';

/**
 * WHAT EACH CONTROL IS FOR, TAKEN FROM THE PRODUCT - NOT FROM ITS NAME.
 *
 * Guessing the class from a testID suffix is how an oracle invents
 * defects. Every one of these entries was written after reading what the
 * control actually does, and the first pass at this table is the proof:
 * suffix rules flagged ten controls as wrong-action, and all ten were
 * correct products behaving exactly as designed - a Save that asks
 * before it writes, a "cancel-save" that cancels, tools that open in
 * place rather than navigate, and a Presets reload whose read is called
 * `loadIndex`.
 */
const ACTION_CONTRACT: readonly {
  readonly id: RegExp;
  readonly expected: ActionClass;
  readonly why: string;
}[] = [
  {
    id: /^(gps|configurations)-(save|reload)$/,
    expected: 'CONFIRM',
    why: 'guarded by a confirmation dialog before it touches the board',
  },
  {
    id: /^motors-open-(settings|reorder|direction)$/,
    expected: 'REVEAL',
    why: 'Motors tools open IN PLACE; they are disclosures, not routes',
  },
  {
    id: /^motor-config-(review|cancel)-save$/,
    expected: 'REVEAL',
    why: 'enters and leaves the review step; the write is a later press',
  },
  {
    id: /^presets-reload$/,
    expected: 'READ',
    why: 'reads the preset index and the firmware version',
  },
  {id: /^led-cell-\d+-\d+$/, expected: 'SELECT', why: 'selects that position'},
  {id: /-save$/, expected: 'SAVE', why: 'writes the draft through the controller'},
  {id: /(reload|refresh)$/i, expected: 'READ', why: 're-reads from the board'},
  {id: /-open-/, expected: 'NAVIGATE', why: 'hands off to another screen'},
];

function expectedActionFor(id: string): {expected: ActionClass; why: string} {
  for (const rule of ACTION_CONTRACT) {
    if (rule.id.test(id)) return {expected: rule.expected, why: rule.why};
  }
  return {expected: 'ANY', why: 'no action class this control commits to'};
}

interface Evidence {
  readonly moved: boolean;
  readonly calls: readonly string[];
  readonly selectedAfter: boolean | undefined;
}

const READ_CALL = /\.(load|loadIndex|loadFirmwareVersion|loadPreset|read|refresh|capture)/i;

function actionSatisfied(expected: ActionClass, evidence: Evidence): boolean {
  const {moved, calls, selectedAfter} = evidence;
  switch (expected) {
    case 'READ':
      return calls.some(call => READ_CALL.test(call)) && !calls.some(c => /\.save$/.test(c));
    case 'SAVE':
      /* Not every write is called `save`. Sensors owns four separate
         write paths - `saveAccTrim`, `saveMagAlignment`,
         `saveCompassDeclination`, `saveHardwareSelection` - because the
         firmware takes them as four different messages, and a rule that
         only matched `.save` scored all three visible Save buttons as
         WRONG_ACTION while their evidence showed the correct write. */
      return calls.some(call => /\.save([A-Z]\w*)?$/.test(call));
    case 'NAVIGATE':
      return calls.some(
        call => call.startsWith('navigate.') || call === 'Linking.openURL',
      );
    case 'SELECT':
      return selectedAfter === true;
    case 'CONFIRM':
      /* Asking first IS the action. What it must not do is write
         silently, or wander off somewhere else entirely. */
      return calls.includes('Alert.alert');
    case 'REVEAL':
      /* It opens something in place: the tree moves and nothing is
         written to the board. */
      return moved && !calls.some(call => /\.save$/.test(call));
    default:
      return moved || calls.length > 0;
  }
}

/** Whether a control now reports itself selected, by testID. */
function selectedNow(
  tree: ReactTestRenderer.ReactTestRenderer,
  id: string,
): boolean | undefined {
  const nodes = tree.root.findAll(
    node => (node.props as any)?.testID === id,
    {deep: true},
  );
  if (nodes.length === 0) return undefined;
  return nodes.some(
    node => (node.props as any)?.accessibilityState?.selected === true,
  );
}

/* ==================================================================== *
 * THE PRESS
 * ==================================================================== */

interface Result {
  readonly id: string;
  readonly handler: string;
  readonly verdict:
    | 'EXECUTED_CORRECT_ACTION'
    | 'DISABLED_WITH_VALID_REASON'
    | 'NO_EFFECT'
    | 'THREW'
    | 'TIMEOUT'
    | 'FIRED_TWICE'
    | 'DISABLED_BUT_RESPONDED'
    /** It did something - but not the thing its name promises. */
    | 'WRONG_ACTION'
    /** Its group already holds this value and offers nowhere else to go. */
    | 'ALREADY_IN_TARGET_STATE';
  readonly detail: string;
  readonly labelled: boolean;
  readonly ms: number;
}

async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  control: Discovered,
  record: Recorder,
  spent: Cost,
): Promise<Result> {
  trace(
    `CONTROL_ACTION_START ${control.id}::${control.handler}` +
      ` enabled=${!control.disabled}`,
  );
  const t0 = Date.now();

  /* A DISABLED CONTROL IS PRESSED FOR REAL, THROUGH THE RESPONDER CHAIN.
     Calling `props.onPress()` by hand would sail straight past a guard no
     operator can sail past, and report an interaction nobody can perform.
     Driving `onStartShouldSetResponder` -> grant -> release is what a
     finger does, so a refusal here is EVIDENCE the control is inert
     rather than an assumption that it must be. It also makes the opposite
     visible: a control carrying only `accessibilityState={{disabled}}`
     claims the gesture and fires, which is the defect. */
  if (control.disabled && control.touch !== undefined) {
    /* A NEGATIVE CONTROL FIRST: does this screen redraw on its own?
       Sensors paints live traces, so its tree differs from one flush to
       the next with nobody touching anything. Comparing a before and an
       after across a touch on a screen like that reports every disabled
       control as having acted - which is how `sensors-alignment-preset`
       came out as DISABLED_BUT_RESPONDED while `SelectField` puts
       `disabled` straight on its trigger Pressable and React Native
       refuses the gesture. Measure the drift, then subtract it: on a
       drifting screen only a PORT CALL counts as having acted. */
    const settle = JSON.stringify(tree.toJSON());
    await act(async () => {
      await Promise.resolve();
    });
    const drifts = JSON.stringify(tree.toJSON()) !== settle;
    const wasCalls = record.calls;
    const wasTree = JSON.stringify(tree.toJSON());
    let outcome: Touch = {reachable: false, claimed: false};
    let blew: string | undefined;
    await act(async () => {
      try {
        outcome = control.touch!();
      } catch (error) {
        blew = String(error).slice(0, 90);
      }
      await Promise.resolve();
    });
    const acted =
      record.calls > wasCalls ||
      (!drifts && JSON.stringify(tree.toJSON()) !== wasTree);
    const ms = Date.now() - t0;
    trace(
      `CONTROL_ACTION_END   ${control.id}::${control.handler} disabled` +
        ` reachable=${outcome.reachable} claimed=${outcome.claimed}` +
        ` acted=${acted} ambientDrift=${drifts}`,
    );
    if (blew !== undefined) {
      return {
        id: control.id,
        handler: control.handler,
        verdict: 'THREW',
        detail: blew,
        labelled: control.labelled,
        ms,
      };
    }
    if (acted) {
      return {
        id: control.id,
        handler: control.handler,
        verdict: 'DISABLED_BUT_RESPONDED',
        detail: control.guarded
          ? 'carries `disabled` yet a real touch still reached its action'
          : 'declares itself disabled to assistive technology, and a real touch performed the action anyway',
        labelled: control.labelled,
        ms,
      };
    }
    return {
      id: control.id,
      handler: control.handler,
      verdict: 'DISABLED_WITH_VALID_REASON',
      detail: outcome.reachable
        ? `a real touch was refused by the responder chain (claimed=${outcome.claimed})`
        : 'renders no touch-handling host - unreachable by gesture',
      labelled: control.labelled,
      ms,
    };
  }

  /* No responder chain to drive: a Switch's `onValueChange` and a
     TextInput's `onChangeText` are not gestures, and `disabled` /
     `editable={false}` are enforced by the native component itself. */
  if (control.guarded) {
    trace(`CONTROL_ACTION_END   ${control.id}::${control.handler} guarded, not pressed`);
    return {
      id: control.id,
      handler: control.handler,
      verdict: 'DISABLED_WITH_VALID_REASON',
      detail: 'the platform refuses the interaction',
      labelled: control.labelled,
      ms: 0,
    };
  }

  let mark = Date.now();
  const before = JSON.stringify(tree.toJSON());
  spent.serialise += Date.now() - mark;
  const callsBefore = record.calls;
  const logBefore = record.log.length;
  let threw: string | undefined;
  let expired = false;

  mark = Date.now();
  const bound = deadline(PRESS_BUDGET_MS);
  await act(async () => {
    try {
      const outcome = await Promise.race([
        (async () => control.invoke())(),
        bound.promise,
      ]);
      if (outcome === 'TIMEOUT') expired = true;
    } catch (error) {
      threw = String(error).slice(0, 90);
    }
    await Promise.resolve();
  });
  bound.cancel();
  spent.invoke += Date.now() - mark;

  mark = Date.now();
  const after = JSON.stringify(tree.toJSON());
  spent.serialise += Date.now() - mark;
  const moved = before !== after;
  const called = record.calls > callsBefore;
  const ms = Date.now() - t0;
  trace(
    `CONTROL_ACTION_END   ${control.id}::${control.handler}` +
      ` ${ms}ms tree=${moved ? 'changed' : 'same'} ports=${called ? 'called' : 'none'}` +
      `${expired ? ' TIMEOUT' : ''}${threw === undefined ? '' : ' THREW'}`,
  );

  /* A press that never returned is a harness-visible failure, not a
     pass, and not a dead control either - we do not know what it did. */
  if (expired) {
    return {
      id: control.id,
      handler: control.handler,
      verdict: 'TIMEOUT',
      detail: `did not settle within ${PRESS_BUDGET_MS}ms`,
      labelled: control.labelled,
      ms,
    };
  }

  if (control.declaredDisabledOnly) {
    /* It announces itself disabled to assistive technology while nothing
       actually stops it - so it tells the operator the action is
       unavailable and then performs it. */
    return {
      id: control.id,
      handler: control.handler,
      verdict:
        moved || called ? 'DISABLED_BUT_RESPONDED' : 'DISABLED_WITH_VALID_REASON',
      detail: moved || called ? 'declares itself disabled yet acted' : 'inert',
      labelled: control.labelled,
      ms,
    };
  }

  /* ONE PRESS, ONE COMMAND.
     A single press that issues the same COMMAND twice is a double-fire:
     two writes where the operator asked for one. Two different commands
     in one press is ordinary (save then reload).

     Accessors are excluded, and not as a convenience: `getPhase` and
     `getOutput` are pure reads that React calls again on every render a
     press causes. Counting those as a double-fire flagged eight healthy
     CLI buttons at once - a getter is idempotent by definition, and
     reading state twice is what rendering IS. */
  const during = record.log.slice(logBefore);
  const commands = during.filter(
    entry => !/\.(get[A-Z]\w*|subscribe|is[A-Z]\w*|has[A-Z]\w*)$/.test(entry),
  );
  const repeated = commands.filter((entry, at) => commands.indexOf(entry) !== at);
  if (repeated.length > 0) {
    return {
      id: control.id,
      handler: control.handler,
      verdict: 'FIRED_TWICE',
      detail: `one press called ${repeated[0]} more than once`,
      labelled: control.labelled,
      ms,
    };
  }
  if (threw !== undefined) {
    return {
      id: control.id,
      handler: control.handler,
      verdict: 'THREW',
      detail: threw,
      labelled: control.labelled,
      ms,
    };
  }
  const {expected} = expectedActionFor(control.id);
  const evidence: Evidence = {
    moved,
    calls: during,
    selectedAfter: expected === 'SELECT' ? selectedNow(tree, control.id) : undefined,
  };
  const satisfied = actionSatisfied(expected, evidence);
  const detail =
    `expected=${expected} tree=${moved ? 'changed' : 'same'}` +
    ` ports=${during.length === 0 ? 'none' : during.join(',')}` +
    (evidence.selectedAfter === undefined
      ? ''
      : ` selected=${evidence.selectedAfter}`);

  if (satisfied) {
    return {
      id: control.id,
      handler: control.handler,
      verdict: 'EXECUTED_CORRECT_ACTION',
      detail,
      labelled: control.labelled,
      ms,
    };
  }
  /* It acted - just not as promised. That is a different defect from a
     control that does nothing, and it is the one an effect-only oracle
     can never see. */
  if (expected !== 'ANY' && (moved || called)) {
    return {
      id: control.id,
      handler: control.handler,
      verdict: 'WRONG_ACTION',
      detail,
      labelled: control.labelled,
      ms,
    };
  }
  return {
    id: control.id,
    handler: control.handler,
    verdict: 'NO_EFFECT',
    detail,
    labelled: control.labelled,
    ms,
  };
}

/* ==================================================================== *
 * THE SCREENS
 * ==================================================================== */

interface ScreenCase {
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
async function pressById(
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
  await act(async () => {
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
function navigateTo(record: Recorder, label: string): () => void {
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

const SCREENS: readonly ScreenCase[] = [
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

/* ==================================================================== *
 * THE CENSUS
 * ==================================================================== */

const CENSUS: Record<string, Result[]> = {};
/** DISCOVERED vs what each verdict accounts for, per screen. */
const COVERAGE: Record<
  string,
  {
    discovered: number;
    notMeasured: number;
    keyboard: number;
    noKeyboard: number;
  }
> = {};

describe('every rendered control is pressed, and every press does something', () => {
  it.each(SCREENS.map(screen => [screen.name, screen] as const))(
    '%s',
    async (name, screen) => {
      const record = recorder();
      /* Dialogs and external links are effects, not tree changes. */
      const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {
        record.calls += 1;
        record.log.push('Alert.alert');
      });
      const open = jest
        .spyOn(Linking, 'openURL')
        .mockImplementation(async () => {
          record.calls += 1;
          record.log.push('Linking.openURL');
          return true;
        });

      trace(`SCREEN_START ${name}`);
      const spent = cost();
      const results: Result[] = [];
      const seen = new Set<string>();
      const everSeen = new Set<string>();
      /* KEYBOARD REACH, measured on every enabled gesture control this
         screen ever rendered - not only the ones that got pressed. */
      const reachable = new Set<string>();
      const unreachableByKeyboard = new Set<string>();
      const unmeasured = new Map<string, string>();
      const opened = Date.now();
      let remaining = 0;
      let exhausted = false;
      let firstCount = 0;

      /* MEASURED OVER SEVERAL FRESH MOUNTS.
         One press can hide the controls after it - deleting the only
         mode range collapses the Modes editor, and everything below it
         stops rendering. Enumerating once inside one tree would leave
         those controls permanently unmeasured while reporting a clean
         screen. So each pass remounts from scratch and starts with the
         first control this screen has not measured yet, which puts that
         control at the top of a tree where it still exists. Passes stop
         as soon as one adds nothing. */
      for (let pass = 0; pass < 10 && !exhausted; pass += 1) {
        const element = await screen.mount(record);
        let tree!: ReactTestRenderer.ReactTestRenderer;
        await act(async () => {
          tree = ReactTestRenderer.create(element);
        });
        await act(async () => {
          await Promise.resolve();
        });
        if (screen.precondition !== undefined) {
          await screen.precondition(tree);
          await act(async () => {
            await Promise.resolve();
          });
        }
        if (pass === 0) trace(`SCREEN_RENDERED ${name}`);
        const before = results.length;

        /* RE-DISCOVERED BEFORE EVERY SINGLE PRESS.
           A press re-renders, and a node instance captured beforehand
           then belongs to a tree that no longer exists - invoking
           through it throws "unable to find node on an unmounted
           component", which is the harness failing, not the control. */
        for (let pressed = 0; pressed < 400; pressed += 1) {
          const mark = Date.now();
          const all = discover(tree);
          spent.discover += Date.now() - mark;
          for (const control of all) {
            everSeen.add(`${control.id}::${control.handler}`);
            if (control.keyboardReachable === true) {
              reachable.add(`${control.id}::${control.handler}`);
            } else if (control.keyboardReachable === false) {
              unreachableByKeyboard.add(`${control.id}::${control.handler}`);
            }
          }
          if (pass === 0 && pressed === 0) {
            firstCount = all.length;
            trace(`CONTROL_DISCOVERED ${name} count=${all.length}`);
          }
          const pending = all.filter(
            control => !seen.has(`${control.id}::${control.handler}`),
          );
          if (pending.length === 0) break;
          /* A screen budget that has run out stops the loop and NAMES
             what it did not reach. It never reports the remainder as
             healthy. */
          if (Date.now() - opened > SCREEN_BUDGET_MS) {
            exhausted = true;
            remaining = pending.length;
            break;
          }
          /* A control that ALREADY holds its group's selection is asked
             last. Pressing "choose the option that is chosen" correctly
             changes nothing, and scoring that as a dead control would be
             a false finding; by the time we come back to it a sibling
             has taken the selection and the press has real work to do. */
          const next = pending.find(control => !control.selected) ?? pending[0];
          seen.add(`${next.id}::${next.handler}`);
          if (next.unmeasurable !== undefined) {
            /* Pressed with a value the harness would have had to invent.
               Named as NOT_MEASURED instead - a guess here manufactures
               dead controls out of working ones. */
            unmeasured.set(`${next.id}::${next.handler}`, next.unmeasurable);
            continue;
          }
          results.push(await press(tree, next, record, spent));
        }

        /* SECOND CHANCE, ON A SCREEN THAT HAS MOVED.
           A control that already holds its group's selection does nothing
           when pressed - correctly. Not every such control announces
           itself through accessibilityState, so deferring by that flag
           alone cannot catch them all. By the end of a pass the screen's
           state has changed underneath them, so a press now has real work
           to do. Anything still inert after that is dead for a reason
           that is not "you asked it for what it already had". */
        for (let index = 0; index < results.length; index += 1) {
          const row = results[index];
          if (row.verdict !== 'NO_EFFECT') continue;
          /* MOVE ITS GROUP FIRST.
             `failsafe-switch-0` and `failsafe-switch-1` are the same
             radio group: ids that differ only in the last segment. If
             the group already sits on this option, pressing it is
             correctly a no-op, and by now a Discard or a reload may have
             put it back there. Press a sibling, THEN ask again - so what
             we finally measure is a control asked to do real work. */
          const cut = row.id.lastIndexOf('-');
          let groupMoved = false;
          if (cut > 0) {
            const prefix = row.id.slice(0, cut + 1);
            const family = discover(tree).filter(
              control =>
                control.id !== row.id &&
                control.handler === row.handler &&
                control.id.startsWith(prefix),
            );
            const sibling = family.find(control => !control.disabled);
            if (sibling !== undefined) {
              trace(`GROUP_MOVE ${sibling.id}::${sibling.handler} before retrying ${row.id}`);
              await press(tree, sibling, record, spent);
              groupMoved = true;
            }
          }
          const again = discover(tree).find(
            control => control.id === row.id && control.handler === row.handler,
          );
          if (again === undefined || again.disabled) continue;
          /* It STILL declares itself the selected option - after every
             other control on the screen has been pressed, and after we
             tried to move its group. Its post-condition already holds, so
             pressing it is correctly a no-op. (Ports proves the case: in
             a telemetry group where every role is absent from the build,
             NONE is the only selectable option there is.) */
          if (!groupMoved && again.selected) {
            results[index] = {
              ...row,
              verdict: 'ALREADY_IN_TARGET_STATE',
              detail: 'already selected; no other option in its group is available',
            };
            continue;
          }
          const retried = await press(tree, again, record, spent);
          if (retried.verdict === 'EXECUTED_CORRECT_ACTION') {
            results[index] = {
              ...retried,
              detail: `${retried.detail} (on retry after the screen moved)`,
            };
          }
        }

        act(() => tree.unmount());
        if (results.length === before) break;
      }

      CENSUS[name] = results;
      alert.mockRestore();
      open.mockRestore();
      /* Discovered in some tree, but gone before its turn came. Named,
         never silently dropped. */
      const unreachable = [...everSeen].filter(
        key => !seen.has(key) || unmeasured.has(key),
      );
      COVERAGE[name] = {
        discovered: everSeen.size,
        notMeasured: unreachable.length + remaining,
        keyboard: reachable.size,
        noKeyboard: unreachableByKeyboard.size,
      };
      trace(
        `SCREEN_DONE ${name} first_render=${firstCount} pressed=${results.length}` +
          ` unreachable=${unreachable.length} budget_left=${remaining}` +
          ` discover=${spent.discover}ms serialise=${spent.serialise}ms` +
          ` invoke=${spent.invoke}ms`,
      );

      const dead = results.filter(row => row.verdict === 'NO_EFFECT');
      const threw = results.filter(row => row.verdict === 'THREW');
      const timedOut = results.filter(row => row.verdict === 'TIMEOUT');
      const twice = results.filter(row => row.verdict === 'FIRED_TWICE');
      const wrong = results.filter(row => row.verdict === 'WRONG_ACTION');
      const liveWhenDisabled = results.filter(
        row => row.verdict === 'DISABLED_BUT_RESPONDED',
      );
      /* Printed as well as asserted: an assertion diff truncates, and
         the whole point of this pass is to read every name. */
      if (
        dead.length +
          threw.length +
          timedOut.length +
          twice.length +
          wrong.length +
          liveWhenDisabled.length +
          unreachable.length >
          0 ||
        exhausted
      ) {
        console.log(
          [
            ``,
            `--- ${name}: ${results.length} pressed,` +
              ` ${dead.length} NO_EFFECT, ${threw.length} THREW,` +
              ` ${timedOut.length} TIMEOUT, ${twice.length} FIRED_TWICE,` +
              ` ${wrong.length} WRONG_ACTION,` +
              ` ${liveWhenDisabled.length} DISABLED_BUT_RESPONDED,` +
              ` ${unreachable.length + remaining} NOT_MEASURED ---`,
            ...dead.map(r => `  NO_EFFECT    ${r.handler} ${r.id}  [${r.detail}]`),
            ...threw.map(r => `  THREW        ${r.handler} ${r.id}  [${r.detail}]`),
            ...timedOut.map(r => `  TIMEOUT      ${r.handler} ${r.id}  [${r.detail}]`),
            ...twice.map(r => `  FIRED_TWICE  ${r.handler} ${r.id}  [${r.detail}]`),
            ...wrong.map(r => `  WRONG_ACTION ${r.handler} ${r.id}  [${r.detail}]`),
            ...liveWhenDisabled.map(
              r => `  DISABLED_BUT_RESPONDED ${r.handler} ${r.id}  [${r.detail}]`,
            ),
            ...unreachable.map(
              key =>
                `  NOT_MEASURED ${key}` +
                (unmeasured.has(key)
                  ? `  [${unmeasured.get(key)}]`
                  : '  [hidden by an earlier press before its turn came]'),
            ),
          ].join('\n'),
        );
      }

      /* EVERY ENABLED CONTROL IS REACHABLE WITHOUT A POINTER.
         A control taken out of the tab order or out of the accessibility
         tree still works for a mouse and stops existing for a keyboard
         and a screen reader. Measured on the rendered host. */
      if (unreachableByKeyboard.size > 0) {
        console.log(
          [
            '',
            `--- ${name}: ${unreachableByKeyboard.size} NOT KEYBOARD REACHABLE ---`,
            ...[...unreachableByKeyboard].map(key => `  NO_KEYBOARD  ${key}`),
          ].join('\n'),
        );
      }
      expect({
        screen: name,
        notKeyboardReachable: [...unreachableByKeyboard],
      }).toEqual({screen: name, notKeyboardReachable: []});

      /* A budget overrun is a harness failure with a name, never a pass. */
      expect({screen: name, notMeasured: remaining}).toEqual({
        screen: name,
        notMeasured: 0,
      });
      expect({
        screen: name,
        timedOut: timedOut.map(row => `${row.id}: ${row.detail}`),
      }).toEqual({screen: name, timedOut: []});
      expect({
        screen: name,
        firedTwice: twice.map(row => `${row.id}: ${row.detail}`),
      }).toEqual({screen: name, firedTwice: []});
      expect({
        screen: name,
        wrongAction: wrong.map(row => `${row.id}: ${row.detail}`),
      }).toEqual({screen: name, wrongAction: []});
      expect({
        screen: name,
        disabledButResponded: liveWhenDisabled.map(row => row.id),
      }).toEqual({screen: name, disabledButResponded: []});
      expect({screen: name, dead: dead.map(row => row.id)}).toEqual({
        screen: name,
        dead: [],
      });
      expect({screen: name, threw: threw.map(row => `${row.id}: ${row.detail}`)}).toEqual({
        screen: name,
        threw: [],
      });
      expect(results.length).toBeGreaterThan(0);
    },
  );

  it('prints the census and holds the totals', () => {
    const rows = Object.entries(CENSUS);
    const sum = {
      discovered: 0,
      executed: 0,
      disabled: 0,
      dead: 0,
      threw: 0,
      timeout: 0,
      wrong: 0,
      notMeasured: 0,
      unlabelled: 0,
      keyboard: 0,
      noKeyboard: 0,
    };
    const lines: string[] = [];
    for (const [screen, results] of rows) {
      const count = (verdict: Result['verdict']): number =>
        results.filter(row => row.verdict === verdict).length;
      const coverage = COVERAGE[screen] ?? {
        discovered: results.length,
        notMeasured: 0,
        keyboard: 0,
        noKeyboard: 0,
      };
      const anon = results.filter(row => !row.labelled).length;
      sum.discovered += coverage.discovered;
      sum.notMeasured += coverage.notMeasured;
      sum.executed += count('EXECUTED_CORRECT_ACTION');
      sum.disabled += count('DISABLED_WITH_VALID_REASON');
      sum.dead += count('NO_EFFECT');
      sum.threw += count('THREW');
      sum.timeout += count('TIMEOUT');
      sum.wrong += count('WRONG_ACTION');
      sum.unlabelled += anon;
      sum.keyboard += coverage.keyboard;
      sum.noKeyboard += coverage.noKeyboard;
      lines.push(
        `  ${screen.padEnd(19)}` +
          ` disc=${String(coverage.discovered).padStart(3)}` +
          ` exec=${String(count('EXECUTED_CORRECT_ACTION')).padStart(3)}` +
          ` disabled=${String(count('DISABLED_WITH_VALID_REASON')).padStart(3)}` +
          ` dead=${String(count('NO_EFFECT')).padStart(3)}` +
          ` threw=${String(count('THREW')).padStart(2)}` +
          ` timeout=${String(count('TIMEOUT')).padStart(2)}` +
          ` wrong=${String(count('WRONG_ACTION')).padStart(2)}` +
          ` notMeasured=${String(coverage.notMeasured).padStart(3)}` +
          ` unlabelled=${String(anon).padStart(3)}` +
          ` keyboard=${String(coverage.keyboard).padStart(3)}` +
          ` noKeyboard=${String(coverage.noKeyboard).padStart(2)}`,
      );
    }
    console.log(
      [
        '',
        '===== UI-X1 RUNTIME INTERACTION CENSUS =====',
        ...lines,
        `  TOTAL discovered=${sum.discovered} executed=${sum.executed}` +
          ` disabled=${sum.disabled} dead=${sum.dead} threw=${sum.threw}` +
          ` timeout=${sum.timeout} wrongAction=${sum.wrong}` +
          ` notMeasured=${sum.notMeasured}` +
          ` unlabelled=${sum.unlabelled}` +
          ` keyboardReachable=${sum.keyboard}` +
          ` notKeyboardReachable=${sum.noKeyboard}`,
        '============================================',
        '',
      ].join('\n'),
    );
    expect(rows.length).toBe(SCREENS.length);
    expect(sum.executed + sum.disabled).toBeGreaterThan(0);
  });
});

/* ==================================================================== *
 * WHAT A SCREEN LEAVES RUNNING AFTER IT IS GONE
 *
 * Every screen here polls something. A screen that starts an interval, a
 * poll or a subscription in an effect and does not tear it down keeps
 * running after the operator has navigated away: it keeps issuing MSP
 * traffic over a link another screen now owns, and it keeps calling
 * setState on a component React has already unmounted. Nothing about that
 * is visible in a render assertion, which is why it survives ordinary
 * screen tests.
 *
 * The oracle is a ledger, not a flag. Node's timer functions are replaced
 * with counting versions for the duration of one mount, every handle is
 * recorded with the source line that created it, and clears and fires
 * remove it again. What is still live after `unmount()` is what the
 * screen leaked - by name, with its creation site.
 *
 * Deliberately NOT `--detectOpenHandles`: that reports the whole process
 * at the end of a run, attributes nothing to a screen, and cannot tell a
 * leak from a timer some library legitimately holds. This attributes.
 * ==================================================================== */

interface Handle {
  readonly kind: 'interval' | 'timeout';
  readonly where: string;
}

/** The first application frame that created a timer. */
function creationSite(): string {
  const frames = (new Error().stack ?? '').split('\n').slice(2);
  const mine = frames.find(
    frame =>
      /[\\/]src[\\/]/.test(frame) && !frame.includes('interactionCensus.test'),
  );
  return (mine ?? frames[0] ?? 'unknown').trim().replace(/^at\s+/, '');
}

function timerLedger(): {
  live: () => Handle[];
  restore: () => void;
} {
  const open = new Map<unknown, Handle>();
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;

  (globalThis as any).setInterval = (
    callback: (...a: unknown[]) => void,
    ms?: number,
    ...rest: unknown[]
  ) => {
    const handle = (realSetInterval as any)(callback, ms, ...rest);
    open.set(handle, {kind: 'interval', where: creationSite()});
    return handle;
  };
  (globalThis as any).setTimeout = (
    callback: (...a: unknown[]) => void,
    ms?: number,
    ...rest: unknown[]
  ) => {
    let handle: unknown;
    const once = (...args: unknown[]): void => {
      open.delete(handle);
      callback(...args);
    };
    handle = (realSetTimeout as any)(once, ms, ...rest);
    open.set(handle, {kind: 'timeout', where: creationSite()});
    return handle;
  };
  (globalThis as any).clearInterval = (handle: unknown) => {
    open.delete(handle);
    return (realClearInterval as any)(handle);
  };
  (globalThis as any).clearTimeout = (handle: unknown) => {
    open.delete(handle);
    return (realClearTimeout as any)(handle);
  };

  return {
    live: () => [...open.values()],
    restore: () => {
      /* Anything still open belongs to nobody now - stop it rather than
         leave real timers running into the next test. */
      for (const handle of open.keys()) {
        (realClearInterval as any)(handle);
        (realClearTimeout as any)(handle);
      }
      open.clear();
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

interface Leak {
  readonly screen: string;
  readonly what: string;
}

const LEAKS: Leak[] = [];
const LIFECYCLE: string[] = [];

describe('a screen that is gone stops working', () => {
  it.each(SCREENS.map(screen => [screen.name, screen] as const))(
    '%s releases its timers and subscriptions on unmount',
    async (name, screen) => {
      const record = recorder();
      const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
      const open = jest
        .spyOn(Linking, 'openURL')
        .mockImplementation(async () => true);

      /* Built BEFORE the ledger is installed: constructing the fixture
         is not the screen's lifecycle, and a timer the virtual board
         starts while answering a snapshot is not a screen leak. */
      const element = await screen.mount(record);

      const timers = timerLedger();
      subscriptions = new Map();
      subscriptionSeq = 0;
      let tree!: ReactTestRenderer.ReactTestRenderer;
      try {
        await act(async () => {
          tree = ReactTestRenderer.create(element);
        });
        await act(async () => {
          await Promise.resolve();
        });
        const mountedIntervals = timers
          .live()
          .filter(handle => handle.kind === 'interval').length;
        const mountedSubscriptions = subscriptions.size;

        await act(async () => {
          tree.unmount();
        });
        await act(async () => {
          await Promise.resolve();
        });

        const stillRunning = timers.live();
        const stillSubscribed = [...subscriptions.values()];
        /* INTERVALS are the assertion. An interval that outlives its
           screen repeats forever, with nobody to receive it - there is no
           reading of that which is correct. Pending TIMEOUTS are
           reported, not asserted: a one-shot that has not fired yet is
           routinely legitimate (a debounce, a retry backoff), and failing
           on those would manufacture defects out of working code. */
        const leakedIntervals = stillRunning.filter(
          handle => handle.kind === 'interval',
        );
        const pendingTimeouts = stillRunning.filter(
          handle => handle.kind === 'timeout',
        );
        LIFECYCLE.push(
          `  ${name.padEnd(19)}` +
            ` intervals=${String(mountedIntervals).padStart(2)}` +
            ` subs=${String(mountedSubscriptions).padStart(2)}` +
            ` leakedIntervals=${String(leakedIntervals.length).padStart(2)}` +
            ` leakedSubs=${String(stillSubscribed.length).padStart(2)}` +
            ` pendingTimeouts=${String(pendingTimeouts.length).padStart(2)}`,
        );
        for (const handle of leakedIntervals) {
          LEAKS.push({screen: name, what: `interval from ${handle.where}`});
        }
        for (const label of stillSubscribed) {
          LEAKS.push({screen: name, what: `subscription to ${label}`});
        }
        if (leakedIntervals.length + stillSubscribed.length > 0) {
          console.log(
            [
              '',
              `--- ${name}: LIFECYCLE LEAK ---`,
              ...leakedIntervals.map(h => `  interval still running: ${h.where}`),
              ...stillSubscribed.map(l => `  subscription never torn down: ${l}`),
            ].join('\n'),
          );
        }
        expect({
          screen: name,
          leakedIntervals: leakedIntervals.map(handle => handle.where),
          leakedSubscriptions: stillSubscribed,
        }).toEqual({screen: name, leakedIntervals: [], leakedSubscriptions: []});
      } finally {
        subscriptions = undefined;
        timers.restore();
        alert.mockRestore();
        open.mockRestore();
      }
    },
  );

  /**
   * A SCREEN THAT REALLY DOES START AN INTERVAL.
   *
   * The twenty screens above all came back with zero live intervals, and
   * a ledger that only ever counts zero proves nothing about the
   * application - only that it was pointed at screens with nothing to
   * count. The firmware flasher is the one route that starts a repeating
   * probe unconditionally the moment it mounts
   * (FirmwareFlasherSimpleScreen.tsx:632, `setInterval(probe, 2_000)`),
   * so it is the subject that makes the clean rows mean something: the
   * ledger must SEE that interval while the screen is up, and must find
   * it gone afterwards.
   */
  it('the flasher starts a real repeating probe, and stops it on unmount', async () => {
    const client = {
      supportsDevicePicker: () => true,
      requestDevicePermission: async () => null,
      listDevices: async () => [],
      listDfuDevices: async () => [],
      onDeviceAttached: () => () => undefined,
      onDeviceDetached: () => () => undefined,
      onSessionDetached: () => () => undefined,
      onDfuFlashProgress: () => () => undefined,
      flashDfuFirmware: async () => undefined,
      cancelDfuFlash: async () => undefined,
      requestDfuDevicePermission: async () => null,
    };
    const timers = timerLedger();
    try {
      let tree!: ReactTestRenderer.ReactTestRenderer;
      await act(async () => {
        tree = ReactTestRenderer.create(
          <FirmwareFlasherSimpleScreen client={client as never} />,
        );
      });
      await act(async () => {
        for (let round = 0; round < 8; round += 1) await Promise.resolve();
      });
      const whileMounted = timers
        .live()
        .filter(handle => handle.kind === 'interval');
      /* The subject exists. Without this the assertion below is vacuous. */
      expect(whileMounted.length).toBeGreaterThanOrEqual(1);

      await act(async () => {
        tree.unmount();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(
        timers
          .live()
          .filter(handle => handle.kind === 'interval')
          .map(handle => handle.where),
      ).toEqual([]);
    } finally {
      timers.restore();
    }
  });

  it('the leak detector catches a screen that forgets to clean up', async () => {
    /* THE ORACLE, ATTACKED.
       If this ever stops finding the leak, every clean row above is
       worthless. Two components, identical except for the one line that
       returns the teardown. */
    function Leaky(): React.ReactElement | null {
      React.useEffect(() => {
        /* Started and deliberately never cleared - the whole plant. */
        setInterval(() => undefined, 25);
      }, []);
      return null;
    }
    function Clean(): React.ReactElement | null {
      React.useEffect(() => {
        const handle = setInterval(() => undefined, 25);
        return () => clearInterval(handle);
      }, []);
      return null;
    }

    const measure = async (
      Component: () => React.ReactElement | null,
    ): Promise<number> => {
      const timers = timerLedger();
      try {
        let tree!: ReactTestRenderer.ReactTestRenderer;
        await act(async () => {
          tree = ReactTestRenderer.create(<Component />);
        });
        await act(async () => {
          tree.unmount();
        });
        return timers.live().filter(handle => handle.kind === 'interval').length;
      } finally {
        timers.restore();
      }
    };

    expect(await measure(Leaky)).toBe(1);
    expect(await measure(Clean)).toBe(0);
  });

  it('the subscription ledger catches a listener that is never torn down', async () => {
    const record = recorder();
    const port = watched(
      {
        subscribe: (listener: () => void) => () => {
          listener();
        },
      },
      record,
      'probe',
    );
    subscriptions = new Map();
    try {
      const teardown = port.subscribe(() => undefined);
      expect(subscriptions.size).toBe(1);
      teardown();
      expect(subscriptions.size).toBe(0);
      port.subscribe(() => undefined);
      expect([...subscriptions.values()]).toEqual(['probe.subscribe']);
    } finally {
      subscriptions = undefined;
    }
  });

  it('prints the lifecycle ledger', () => {
    console.log(
      [
        '',
        '===== UI-X1B SCREEN LIFECYCLE LEDGER =====',
        ...LIFECYCLE,
        `  TOTAL leaks=${LEAKS.length}`,
        '==========================================',
        '',
      ].join('\n'),
    );
    expect(LIFECYCLE.length).toBe(SCREENS.length);
  });
});
