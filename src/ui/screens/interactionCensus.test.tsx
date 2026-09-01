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

/** Wraps every function on a port so a call counts as an effect. */
function watched<T extends object>(port: T, record: Recorder, label: string): T {
  return new Proxy(port, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        record.calls += 1;
        record.log.push(`${label}.${String(property)}`);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
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

    const labelled =
      typeof props.testID === 'string' ||
      typeof props.accessibilityLabel === 'string' ||
      typeof props.label === 'string';
    const text = labelled ? '' : textOf(node);
    const id: string =
      props.testID ??
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
      unmeasurable: argument.kind === 'UNKNOWN' ? argument.why : undefined,
      invoke: () => {
        const live = node.props as any;
        return argument.kind === 'VALUE'
          ? live[handler](argument.value)
          : live[handler]();
      },
    };
    /* A composite and the host it renders both carry the handler. The
       INNER one is the control; `findAll` yields parents first, so the
       last writer for a key wins. */
    byKey.set(`${id}::${handler}`, entry);
  }

  for (const entry of byKey.values()) found.push(entry);
  return found;
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

  /* THE PLATFORM'S OWN GUARD IS RESPECTED.
     `<Pressable disabled>` never reaches onPress, and `editable={false}`
     never reaches onChangeText. Calling the prop by hand would sail past
     that and let the census report an interaction no operator can
     perform. The control is recorded in the state it was found in, and
     not pressed. */
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

  /* ONE PRESS, ONE CALL.
     A single press that reaches the same port method twice is a
     double-fire: two writes to the flight controller where the operator
     asked for one. Two DIFFERENT methods in one press is ordinary (save
     then reload); the same one twice is not. */
  const during = record.log.slice(logBefore);
  const repeated = during.filter((entry, at) => during.indexOf(entry) !== at);
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
  return {
    id: control.id,
    handler: control.handler,
    verdict: moved || called ? 'EXECUTED_CORRECT_ACTION' : 'NO_EFFECT',
    detail: `tree=${moved ? 'changed' : 'same'} ports=${
      called ? record.log[record.log.length - 1] : 'none'
    }`,
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
}

const noop = () => undefined;

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
const COVERAGE: Record<string, {discovered: number; notMeasured: number}> = {};

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
              ` ${liveWhenDisabled.length} DISABLED_BUT_RESPONDED,` +
              ` ${unreachable.length + remaining} NOT_MEASURED ---`,
            ...dead.map(r => `  NO_EFFECT    ${r.handler} ${r.id}  [${r.detail}]`),
            ...threw.map(r => `  THREW        ${r.handler} ${r.id}  [${r.detail}]`),
            ...timedOut.map(r => `  TIMEOUT      ${r.handler} ${r.id}  [${r.detail}]`),
            ...twice.map(r => `  FIRED_TWICE  ${r.handler} ${r.id}  [${r.detail}]`),
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
      notMeasured: 0,
      unlabelled: 0,
    };
    const lines: string[] = [];
    for (const [screen, results] of rows) {
      const count = (verdict: Result['verdict']): number =>
        results.filter(row => row.verdict === verdict).length;
      const coverage = COVERAGE[screen] ?? {
        discovered: results.length,
        notMeasured: 0,
      };
      const anon = results.filter(row => !row.labelled).length;
      sum.discovered += coverage.discovered;
      sum.notMeasured += coverage.notMeasured;
      sum.executed += count('EXECUTED_CORRECT_ACTION');
      sum.disabled += count('DISABLED_WITH_VALID_REASON');
      sum.dead += count('NO_EFFECT');
      sum.threw += count('THREW');
      sum.timeout += count('TIMEOUT');
      sum.unlabelled += anon;
      lines.push(
        `  ${screen.padEnd(19)}` +
          ` disc=${String(coverage.discovered).padStart(3)}` +
          ` exec=${String(count('EXECUTED_CORRECT_ACTION')).padStart(3)}` +
          ` disabled=${String(count('DISABLED_WITH_VALID_REASON')).padStart(3)}` +
          ` dead=${String(count('NO_EFFECT')).padStart(3)}` +
          ` threw=${String(count('THREW')).padStart(2)}` +
          ` timeout=${String(count('TIMEOUT')).padStart(2)}` +
          ` notMeasured=${String(coverage.notMeasured).padStart(3)}` +
          ` unlabelled=${String(anon).padStart(3)}`,
      );
    }
    console.log(
      [
        '',
        '===== UI-X1 RUNTIME INTERACTION CENSUS =====',
        ...lines,
        `  TOTAL discovered=${sum.discovered} executed=${sum.executed}` +
          ` disabled=${sum.disabled} dead=${sum.dead} threw=${sum.threw}` +
          ` timeout=${sum.timeout} notMeasured=${sum.notMeasured}` +
          ` unlabelled=${sum.unlabelled}`,
        '============================================',
        '',
      ].join('\n'),
    );
    expect(rows.length).toBe(SCREENS.length);
    expect(sum.executed + sum.disabled).toBeGreaterThan(0);
  });
});
