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
/* Mounted directly by the lifecycle pass rather than through the shared
   registry: the subject there is the repeating device probe the flasher
   starts, which needs its own client double to exist at all. */
import FirmwareFlasherSimpleScreen from './FirmwareFlasherSimpleScreen';
/* THE FIXTURES ARE SHARED, ON PURPOSE.
   Every UI-X1 pass that mounts a screen mounts the one this registry
   builds, so two harnesses cannot disagree about what the application
   renders. See __censusFixtures__/censusScreens.tsx. */
import {
  SCREENS,
  closeSubscriptionLedger,
  openSubscriptionLedger,
  readSubscriptionLedger,
  recorder,
  installAct,
  watched,
} from './__censusFixtures__/censusScreens';
import type {Recorder} from './__censusFixtures__/censusScreens';


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
 *   SCREEN_BUDGET_MS  the widest screen measured so far - LED - draws
 *                     412 controls, and this sweep shares four cores
 *                     with every other suite in the run. Sixty seconds
 *                     was enough while this file was one of ~458; it is
 *                     not enough now that the UI-X1D family has grown by
 *                     a dozen heavy browser-and-registry suites, and the
 *                     LED sweep began reporting 28 controls it simply
 *                     ran out of time to press. That is a harness limit,
 *                     and the assertion below is right to fail on it
 *                     rather than call the remainder coverage - so the
 *                     budget moves to match the machine, not the
 *                     assertion to match the budget.
 *   jest.setTimeout   screen budget + snapshot load over the virtual
 *                     board + margin.
 * ==================================================================== */
const PRESS_BUDGET_MS = 2000;
const SCREEN_BUDGET_MS = 150000;
/**
 * The second pass mounts a whole screen per target and walks a
 * disclosure path before each press, so its unit cost is far above the
 * sweep's. The budget is per screen, and running out is reported as
 * STILL_NOT_MEASURED with that reason attached - never as coverage.
 */
const RERUN_BUDGET_MS = 240000;
/** How far the second pass will explore a screen looking for one control
 *  the recorded disclosure path did not produce. Bounded so a screen that
 *  simply never renders it reports that, rather than walking for ever. */
const EXPLORE_PRESSES = 40;
jest.setTimeout(600000);

/* The registry's preconditions press controls; give them React's act. */
installAct(act);

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
    /* A COMPOSITION SEAM IS NOT A CONTROL.
       `<ProfileSelector onSelect=…>` and `<ColorSlotRow onSelect=…>` carry
       a callback prop, but nobody touches a ProfileSelector: the thing an
       operator presses is one of the Pressables it renders, each with its
       own identity, each already in this census. Calling the wrapper's
       prop directly would need an argument invented for a gesture that
       does not exist.
       So a non-gesture handler with no argument readable from its own
       props, on a node that RENDERS other discovered controls, is named
       for what it is - and the controls beneath it are named too, which
       is what makes this a statement of coverage rather than an excuse. */
    let seam: string | undefined;
    if (argument.kind === 'UNKNOWN' && !gesture) {
      const beneath = node
        .findAll(
          child =>
            child !== node &&
            child.props !== undefined &&
            HANDLERS.some(
              candidate => typeof (child.props as any)[candidate] === 'function',
            ),
          {deep: true},
        )
        .map(child => {
          const own = (child.props as any)?.testID;
          return typeof own === 'string' ? own : inheritedTestID(child);
        })
        .filter((value): value is string => typeof value === 'string');
      const named = [...new Set(beneath)];
      /* A COMPOSITE, not a host: nothing here receives a gesture. Whether
         it currently renders controls or not is a fact about the state,
         not about the seam - a selector whose board reports no options
         renders none, and there is then nothing on screen to press. Both
         are named, and neither is silently counted as covered. */
      if (typeof node.type !== 'string') {
        seam =
          named.length > 0
            ? 'SOURCE_REALISTIC_NOT_APPLICABLE: a composition seam, not an' +
              ' operator control - the controls it renders are measured in' +
              ` their own right (${named.slice(0, 4).join(', ')}${
                named.length > 4 ? `, +${named.length - 4} more` : ''
              })`
            : 'SOURCE_REALISTIC_NOT_APPLICABLE: a composition seam that, in' +
              ' the state this board puts it in, renders no interactive' +
              ' control at all - there is nothing on screen for an operator' +
              ' to press here';
      }
    }
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
      unmeasurable:
        refusedPress(id) ??
        seam ??
        (argument.kind === 'UNKNOWN' ? argument.why : undefined),
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
    why: 'SAFETY_CONTROLLED_NOT_MEASURED: opens the motor-test session, which arms outputs. Driven for real in motorsFinalWorkspace.test.tsx (onValueChange(true) over a scripted board, then a live workspace) and refused for every blocking reason in motorsBlockedStateMatrix.test.tsx - not by a generic presser',
  },
  {
    id: /^motors-stop-button$/,
    why: 'SAFETY_CONTROLLED_NOT_MEASURED: the emergency stop is deliberately always enabled and acts on a live session. Pressed for real in motorsNoCountCommandTruth.test.tsx, which asserts the STOP FRAMES it puts on the wire - every command slot, not an ordinary drive',
  },
  {
    id: /^motor-output-mapping-read$/,
    why: 'SAFETY_CONTROLLED_NOT_MEASURED: reads diagnostics from a live motor-test session. Pressed for real in motorsCoreIdentityMapping.test.tsx, which asserts loadOutputOrder was called with the session key and the rows it returned are rendered',
  },
  {
    id: /^motor-config-refresh$/,
    why: 'SAFETY_CONTROLLED_NOT_MEASURED: refreshes against a live motor-test session. Pressed for real in MotorConfigurationPanel.test.tsx, which asserts the controller load - including the second load behind the discard confirmation',
  },
  {
    id: /^home-connect-retry$/,
    why: 'SOURCE_REALISTIC_NOT_APPLICABLE: under Jest there is no USB transport, so the attempt this button repeats fails the same way every time and the settled screen is byte-identical - "did anything happen" is not answerable by comparing renders here. Measured in homeConnectRetry.test.tsx instead, over a transport that answers: the press scans again (once per press), passes through the in-progress state, and stops reporting the old failure when the second scan finds a board',
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
    /* THE OTHER SHAPES THIS PRODUCT ACTUALLY USES.
       Each is read off props the component already declares - a range and
       a current position - so the value handed back is one the control
       itself says exists. Nothing here invents a range.

         palette + value   the LED colour rows (ColorSlotRow,
                           ColorIndexPicker): a palette of swatches and
                           the index currently shown.
         count + active    the PID profile badges (ProfileSelector): how
                           many profiles the board reports and which one
                           is live.
         roles + selected  the Ports role groups (ChoiceGroup): the roles
                           this category offers and the one assigned. */
    if (Array.isArray(props.palette) && props.palette.length > 1) {
      const current = typeof props.value === 'number' ? props.value : 0;
      return {kind: 'VALUE', value: (current + 1) % props.palette.length};
    }
    if (typeof props.count === 'number' && props.count > 1) {
      const current = typeof props.active === 'number' ? props.active : 0;
      return {kind: 'VALUE', value: (current + 1) % props.count};
    }
    if (Array.isArray(props.roles) && props.roles.length > 0) {
      const other = props.roles.find(
        (role: any) => (role?.key ?? role) !== props.selected,
      );
      if (other !== undefined) {
        return {kind: 'VALUE', value: other?.key ?? other};
      }
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

/* ==================================================================== *
 * THE CONFIRMATION IS PART OF THE SAVE
 *
 * Several screens gate a write behind `Alert.alert` - GPS and
 * Configurations do, deliberately, because the write goes to a flight
 * controller and the operator should be asked first. To a census that
 * only watches ports, pressing Save then "does something that is not a
 * write" reads as WRONG_ACTION, and reporting that would be reporting
 * the safety gate as a defect.
 *
 * The answer is not to soften the SAVE contract into "or it opened a
 * dialog" - that would let a Save button which asks a question and then
 * does nothing pass. The answer is to FOLLOW THE OPERATOR'S PATH: press
 * Save, take the confirm button out of the dialog the product raised,
 * press that too, and then require the write. A dialog with no confirm
 * action, or a confirm action that writes nothing, still fails.
 * ==================================================================== */

interface DialogButton {
  readonly text?: string;
  readonly style?: string;
  readonly onPress?: () => unknown;
}

let lastDialog: readonly DialogButton[] | undefined;

/** Dialogs and external links are effects, not tree changes. */
function watchEffects(record: Recorder): () => void {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(
    (_title?: string, _body?: string, buttons?: readonly DialogButton[]) => {
      record.calls += 1;
      record.log.push('Alert.alert');
      lastDialog = buttons;
    },
  );
  const open = jest.spyOn(Linking, 'openURL').mockImplementation(async () => {
    record.calls += 1;
    record.log.push('Linking.openURL');
    return true;
  });
  return () => {
    alert.mockRestore();
    open.mockRestore();
  };
}

/** The button a person would press to go through with it. */
function confirmButton(): DialogButton | undefined {
  return lastDialog?.find(
    button => button.style !== 'cancel' && typeof button.onPress === 'function',
  );
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
  let mark2 = 0;

  mark = Date.now();
  const bound = deadline(PRESS_BUDGET_MS);
  /* TWO LOOKS, NOT ONE.
     A press whose whole answer is asynchronous can pass through a state
     and come back to where it started. Home's Retry does exactly that:
     `begin()` sets OPENING synchronously, the scan fails on the next
     microtask, and the screen is back on the same failure message. A
     before/after comparison sees two identical trees and calls a working
     control dead - which is what it did, until this split.
       IMMEDIATE  what the press changed by itself, once React has
                  flushed the synchronous part.
       SETTLED    where the screen came to rest.
     Either one differing from `before` is the control having acted. A
     control that changes nothing at either point is still dead: the
     D1 plant (`onPress={() => undefined}`) moves neither. */
  let pending: unknown;
  await act(async () => {
    try {
      pending = control.invoke();
    } catch (error) {
      threw = String(error).slice(0, 90);
    }
  });
  mark2 = Date.now();
  const midway = JSON.stringify(tree.toJSON());
  spent.serialise += Date.now() - mark2;
  await act(async () => {
    try {
      const outcome = await Promise.race([
        Promise.resolve(pending),
        bound.promise,
      ]);
      if (outcome === 'TIMEOUT') expired = true;
    } catch (error) {
      threw ??= String(error).slice(0, 90);
    }
    await Promise.resolve();
  });
  bound.cancel();
  spent.invoke += Date.now() - mark;

  /* SAVE IS GATED BEHIND A QUESTION ON SOME SCREENS. Go through it, the
     way an operator does. Only for SAVE: a destructive CONFIRM is
     answered by the suites that own that action, and pressing "yes,
     erase" here would be the census taking a decision on its own. */
  const promise = expectedActionFor(control.id).expected;
  let confirmed = false;
  if (
    promise === 'SAVE' &&
    record.log.slice(logBefore).includes('Alert.alert')
  ) {
    const button = confirmButton();
    if (button?.onPress !== undefined) {
      confirmed = true;
      await act(async () => {
        try {
          await button.onPress?.();
        } catch (error) {
          threw ??= String(error).slice(0, 90);
        }
        for (let round = 0; round < 4; round += 1) await Promise.resolve();
      });
    }
  }
  lastDialog = undefined;

  mark = Date.now();
  const after = JSON.stringify(tree.toJSON());
  spent.serialise += Date.now() - mark;
  const moved = before !== after || before !== midway;
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
  const expected = promise;
  const evidence: Evidence = {
    moved,
    calls: during,
    selectedAfter: expected === 'SELECT' ? selectedNow(tree, control.id) : undefined,
  };
  const satisfied = actionSatisfied(expected, evidence);
  const detail =
    `expected=${expected}${confirmed ? ' (through its confirmation)' : ''}` +
    ` tree=${
      before === after && moved ? 'changed and returned' : moved ? 'changed' : 'same'
    }` +
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
/**
 * EVERY SUBJECT THIS SCREEN EVER SHOWED, BY NAME.
 *
 * `COVERAGE.discovered` is only the SIZE of this set, and a size cannot
 * be reconciled: it cannot say whether a subject was counted twice, or
 * not at all. The reconciliation at the end of this file needs the names
 * themselves, so it keeps them.
 */
const DISCOVERED_KEYS: Record<string, Set<string>> = {};

/**
 * WHAT THE FIRST SWEEP COULD NOT REACH, AND HOW TO REACH IT.
 *
 * `UNREACHED` is every control this screen rendered at some point and
 * never got to press, with the reason. `REVEALED_BY` is the press that
 * put each control on the screen, observed during the sweep itself.
 * Together they are the input to the second pass below, which mounts the
 * screen again, walks the product's own disclosure path to the control,
 * and presses it there. Neither map is a maintained list: both are
 * written by the sweep, from what the application actually did.
 */
const HIDDEN_FIRST = 'hidden by an earlier press before its turn came';

/* ==================================================================== *
 * NOTHING REACHES THE FLIGHT CONTROLLER UNTIL SAVE
 *
 * Every editing screen in this application is a DRAFT: a toggle, a
 * slider, a stepper, a chip moves a local value, and the board hears
 * nothing until the operator presses Save. That is not a style choice -
 * it is what makes a half-finished edit survivable, and it is the
 * property every one of the control censuses below shares.
 *
 * So it is checked once, over every control on every screen, from the
 * ports' own call log: any write that happened during a press of a
 * control that is not a Save is a wire mutation the operator did not
 * ask for.
 *
 * A few operations ARE live by design and say so here, each with the
 * reason it cannot be a draft. Anything not on this list and not a Save
 * fails, by name, with the control that caused it.
 * ==================================================================== */
const WRITE_CALL = /\.(save[A-Z]?\w*|erase\w*|write\w*|set[A-Z]\w*|select[A-Z]\w*)$/;

const LIVE_BY_DESIGN: readonly {readonly call: RegExp; readonly why: string}[] = [
  {
    call: /\.calibrate[A-Z]\w*$/,
    why: 'a calibration runs ON the board; there is no draft of a gyro bias',
  },
  {
    call: /\.eraseDataflash$/,
    why: 'erasing the log is the action itself, and it is behind a confirmation',
  },
  {
    call: /\.selectProfile$/,
    why: 'switching the active PID or rate profile changes what the board is flying with; it is an operation, not an edit',
  },
  {
    call: /^cli\./,
    why: 'the CLI is a live terminal - every line is sent as it is typed',
  },
  {
    call: /\.verifyPersistence$/,
    why: 'a read-back after a write, not a write',
  },
  {
    call: /\.setEscDirection$/,
    why: 'writing an ESC direction is the action; it is inside the motor-test session and behind its safety gate',
  },
];

function liveByDesign(call: string): string | undefined {
  return LIVE_BY_DESIGN.find(rule => rule.call.test(call))?.why;
}

/** Every wire write the sweep saw, and the control that caused it. */
const WRITES: {screen: string; control: string; call: string; expected: string}[] = [];
const UNREACHED: Record<string, Map<string, string>> = {};
const REVEALED_BY: Record<string, Map<string, string>> = {};
/** The verdict the second pass reached, per control. */
const RERUN: Record<string, Result[]> = {};
/** For a control the second pass reached but still could not press: the
 *  reason it found there, which is more precise than "the sweep never got
 *  to it". Keyed `screen::control::handler`. */
const STILL: Record<string, string> = {};

describe('every rendered control is pressed, and every press does something', () => {
  it.each(SCREENS.map(screen => [screen.name, screen] as const))(
    '%s',
    async (name, screen) => {
      const record = recorder();
      const reveals = (REVEALED_BY[name] ??= new Map<string, string>());
      const stopWatching = watchEffects(record);

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
        /* WHICH PRESS PUT THIS CONTROL ON THE SCREEN.
           Recorded from the diff the loop already computes for free: the
           set discovered at the top of one iteration, against the set
           discovered at the top of the previous one. A control that was
           not there before the last press and is there after it was
           REVEALED by that press - which is the precondition a later
           pass needs in order to measure it on a mount of its own. Reset
           per mount: a diff across a remount says nothing. */
        let visibleBefore: Set<string> | undefined;
        let lastPressed: string | undefined;
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
          const visibleNow = new Set(
            all.map(control => `${control.id}::${control.handler}`),
          );
          if (visibleBefore !== undefined && lastPressed !== undefined) {
            for (const key of visibleNow) {
              if (!visibleBefore.has(key) && !reveals.has(key)) {
                reveals.set(key, lastPressed);
              }
            }
          }
          visibleBefore = visibleNow;
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
          lastPressed = `${next.id}::${next.handler}`;
          if (next.unmeasurable !== undefined) {
            /* Pressed with a value the harness would have had to invent.
               Named as NOT_MEASURED instead - a guess here manufactures
               dead controls out of working ones. */
            unmeasured.set(`${next.id}::${next.handler}`, next.unmeasurable);
            continue;
          }
          {
            const from = record.log.length;
            results.push(await press(tree, next, record, spent));
            for (const call of record.log.slice(from)) {
              if (!WRITE_CALL.test(call)) continue;
              WRITES.push({
                screen: name,
                control: `${next.id}::${next.handler}`,
                call,
                expected: expectedActionFor(next.id).expected,
              });
            }
          }
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
      stopWatching();
      /* Discovered in some tree, but gone before its turn came. Named,
         never silently dropped. */
      const unreachable = [...everSeen].filter(
        key => !seen.has(key) || unmeasured.has(key),
      );
      UNREACHED[name] = new Map(
        unreachable.map(key => [key, unmeasured.get(key) ?? HIDDEN_FIRST]),
      );
      DISCOVERED_KEYS[name] = new Set(everSeen);
      COVERAGE[name] = {
        discovered: everSeen.size,
        /* `unreachable` ALREADY CONTAINS the budget remainder: a control
           left pending when the budget ran out was never added to
           `seen`, so it is unreachable by this filter's first clause.
           Adding `remaining` on top of it counted those controls twice.
           It has always been zero here - the per-screen assertion below
           requires it - so no published number was ever wrong, but the
           reconciliation at the end of this file has to be able to trust
           the formula and not just the value. */
        notMeasured: unreachable.length,
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
              ` ${unreachable.length} NOT_MEASURED ---`,
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
                  : `  [${HIDDEN_FIRST}]`),
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
      /* PRINTED BECAUSE THEY EXIST, not because they are non-zero. The
         three verdicts below were absent from this line, so the totals
         it printed could never be added up - see the arithmetic
         reconciliation at the end of this file. */
      already: 0,
      twice: 0,
      liveWhenDisabled: 0,
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
      sum.already += count('ALREADY_IN_TARGET_STATE');
      sum.twice += count('FIRED_TWICE');
      sum.liveWhenDisabled += count('DISABLED_BUT_RESPONDED');
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
          ` firedTwice=${sum.twice}` +
          ` disabledButResponded=${sum.liveWhenDisabled}` +
          ` alreadyInTargetState=${sum.already}` +
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

  it('nothing reached the flight controller except a Save or a declared live action', () => {
    const unexplained = WRITES.filter(
      row => row.expected !== 'SAVE' && liveByDesign(row.call) === undefined,
    );
    const declared = WRITES.filter(
      row => row.expected !== 'SAVE' && liveByDesign(row.call) !== undefined,
    );
    console.log(
      [
        '',
        '===== UI-X1D WIRE WRITES DURING THE SWEEP =====',
        `  writes observed                    : ${WRITES.length}`,
        `  from a Save                        : ${
          WRITES.filter(row => row.expected === 'SAVE').length
        }`,
        `  live by design (declared)          : ${declared.length}`,
        `  from something else                : ${unexplained.length}`,
        '',
        ...[
          ...new Set(
            declared.map(
              row =>
                `    ${row.screen.padEnd(19)} ${row.control.padEnd(46)} ${row.call}` +
                `\n        ${liveByDesign(row.call)}`,
            ),
          ),
        ],
        ...(unexplained.length > 0
          ? [
              '',
              '  A CONTROL THAT IS NOT A SAVE WROTE TO THE BOARD:',
              ...unexplained.map(
                row => `    ${row.screen} ${row.control} -> ${row.call}`,
              ),
            ]
          : []),
        '==============================================',
        '',
      ].join('\n'),
    );
    expect(
      unexplained.map(row => `${row.screen} ${row.control} -> ${row.call}`),
    ).toEqual([]);
    /* THE SUBJECT EXISTS. If the sweep never pressed a Save at all, the
       clean answer above would be the answer of an empty set. */
    expect(WRITES.filter(row => row.expected === 'SAVE').length).toBeGreaterThan(0);
  });
});

/* ==================================================================== *
 * THE SECOND PASS: EVERY CONTROL THE SWEEP COULD NOT REACH, ON A MOUNT
 * OF ITS OWN.
 *
 * The sweep above walks a live screen and presses whatever it finds. On
 * a screen with disclosure - a palette that opens over the grid, a port
 * card that expands, an inspector that replaces its neighbour - one
 * press closes what the next press was going to reach, and the control
 * underneath never gets its turn. 347 controls ended the first sweep
 * that way.
 *
 * "An earlier press hid it" is a statement about the ORDER THIS HARNESS
 * CHOSE. It is not a fact about the application, and reporting it as
 * coverage would be reporting a harness limitation as a product limit.
 * So each one is measured again, alone:
 *
 *   FRESH MOUNT      nothing carried over from the sweep.
 *   PRECONDITION     the disclosure path the PRODUCT itself requires,
 *                    taken from `REVEALED_BY` - the press the sweep
 *                    OBSERVED putting this control on the screen, walked
 *                    back to a control that is there at mount. Nothing
 *                    here is a hand-written route; if the application
 *                    changes its disclosure, the recorded path changes
 *                    with it.
 *   ONE TARGET       the control this run exists for, located in the
 *                    tree it now lives in.
 *   REAL PRESS       through `press()` - the same oracle, the same
 *                    semantic action contract, the same disabled
 *                    real-touch path as the sweep.
 *   UNMOUNT          so the next target starts from a clean screen.
 *
 * A control that STILL cannot be reached is not quietly dropped: it is
 * reported with the exact path that was tried, and it fails.
 * ==================================================================== */

/** The disclosure path to a control, outermost press first. */
function revealPath(screen: string, target: string): string[] {
  const map = REVEALED_BY[screen];
  if (map === undefined) return [];
  const path: string[] = [];
  const guard = new Set<string>([target]);
  let cursor = target;
  /* Bounded: a reveal graph with a cycle in it would otherwise walk for
     ever, and depth beyond a handful means the recorded path has stopped
     describing a disclosure a person could follow. */
  for (let depth = 0; depth < 8; depth += 1) {
    const parent = map.get(cursor);
    if (parent === undefined || guard.has(parent)) break;
    guard.add(parent);
    path.unshift(parent);
    cursor = parent;
  }
  return path;
}

function findControl(
  tree: ReactTestRenderer.ReactTestRenderer,
  key: string,
): Discovered | undefined {
  return discover(tree).find(
    control => `${control.id}::${control.handler}` === key,
  );
}

describe('a control an earlier press hid is measured on a mount of its own', () => {
  it.each(SCREENS.map(screen => [screen.name, screen] as const))(
    '%s',
    async (name, screen) => {
      const unreached = UNREACHED[name];
      /* Nothing to re-run is a legitimate outcome, not a skip: it means
         the sweep reached everything this screen rendered. */
      if (unreached === undefined || unreached.size === 0) {
        RERUN[name] = [];
        expect(true).toBe(true);
        return;
      }
      const targets = [...unreached.entries()].filter(
        ([, why]) => why === HIDDEN_FIRST,
      );
      const record = recorder();
      const stopWatching = watchEffects(record);

      const spent = cost();
      const results: Result[] = [];
      const unreachable: string[] = [];
      const opened = Date.now();
      trace(`RERUN_START ${name} targets=${targets.length}`);

      for (const [key] of targets) {
        if (Date.now() - opened > RERUN_BUDGET_MS) {
          unreachable.push(`${key}  [re-run budget exhausted before its turn]`);
          continue;
        }
        const path = revealPath(name, key);
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
        /* WALK THE PRODUCT'S OWN DISCLOSURE PATH.
           Each step is pressed exactly as a person would press it; its
           verdict is deliberately discarded, because this run is about
           the target. A step that is not there is not fatal on its own -
           a later step may already be reachable - so the walk continues
           and the TARGET decides the outcome. */
        const walked: string[] = [];
        for (const step of path) {
          const control = findControl(tree, step);
          if (control === undefined || control.unmeasurable !== undefined) {
            walked.push(`${step}(absent)`);
            continue;
          }
          await press(tree, control, record, spent);
          walked.push(step);
        }
        let target = findControl(tree, key);
        /* THE RECORDED PATH IS ONE ROUTE, NOT THE ONLY ROUTE.
           `modes-save-bar-save` appears when the draft becomes dirty, and
           the press the sweep happened to record last was a DELETE that
           made it dirty a second time; replaying add-then-delete lands on
           a draft where the bar is gone again. So when the recorded route
           misses, walk the screen instead: press whatever is in front of
           us, one control at a time, and stop the moment the target shows
           up. That is a person finding it by using the screen, and the
           steps taken are printed with the verdict. */
        if (target === undefined) {
          /* START OVER, CLEAN. The recorded route did not land, and the
             tree in front of us now carries whatever that route did -
             Modes' route adds a condition and then deletes it again,
             which is exactly the state where the save bar is gone. So
             the exploration gets its own mount and its own record of
             what it has tried; otherwise it would skip the very control
             the failed route already pressed. */
          await act(async () => tree.unmount());
          const again = await screen.mount(record);
          await act(async () => {
            tree = ReactTestRenderer.create(again);
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
          walked.length = 0;
          walked.push('(explored)');
          /* TWO ORDERS, BECAUSE ORDER IS THE WHOLE PROBLEM.
             Walking the screen top to bottom reaches Modes' Reload before
             it reaches the control that makes the draft dirty - and
             Reload throws the draft away, so the save bar can never
             appear no matter how long the walk continues. Running the
             same walk from the BOTTOM presses the deep control first.
             Two orders is not a guess about this screen; it is the
             minimum that makes the search independent of the direction
             the tree happens to be built in. */
          const tried = new Set<string>();
          for (const backwards of [false, true]) {
            if (target !== undefined) break;
            if (backwards) {
              await act(async () => tree.unmount());
              const afresh = await screen.mount(record);
              await act(async () => {
                tree = ReactTestRenderer.create(afresh);
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
              tried.clear();
              walked.push('(re-explored from the far end)');
            }
            for (let step = 0; step < EXPLORE_PRESSES; step += 1) {
              const options = discover(tree).filter(
                control =>
                  `${control.id}::${control.handler}` !== key &&
                  !control.disabled &&
                  control.unmeasurable === undefined &&
                  !tried.has(`${control.id}::${control.handler}`),
              );
              if (options.length === 0) break;
              const option = backwards
                ? options[options.length - 1]
                : options[0];
              tried.add(`${option.id}::${option.handler}`);
              await press(tree, option, record, spent);
              walked.push(`${option.id}::${option.handler}`);
              target = findControl(tree, key);
              if (target !== undefined) break;
            }
          }
        }
        if (target === undefined) {
          unreachable.push(
            `${key}  [not on the screen after walking ${
              walked.length === 0 ? '(no recorded disclosure path)' : walked.join(' -> ')
            }]`,
          );
          await act(async () => tree.unmount());
          continue;
        }
        if (target.unmeasurable !== undefined) {
          STILL[`${name}::${key}`] = target.unmeasurable;
          unreachable.push(`${key}  [${target.unmeasurable}]`);
          await act(async () => tree.unmount());
          continue;
        }
        let outcome = await press(tree, target, record, spent);
        /* ASKING A CONTROL FOR WHAT IT ALREADY HAS IS NOT A DEAD CONTROL.
           The disclosure path frequently SETS the very thing the target
           selects - opening the palette lands on slot 0, choosing the GPS
           role sets its default baud - so the target's post-condition
           already holds and a correct control does nothing. The sweep has
           a second chance for exactly this; so does this pass. Move the
           group with a sibling, then ask again. */
        if (outcome.verdict === 'NO_EFFECT') {
          const cut = target.id.lastIndexOf('-');
          const sibling =
            cut <= 0
              ? undefined
              : discover(tree).find(
                  control =>
                    control.id !== target!.id &&
                    control.handler === target!.handler &&
                    control.id.startsWith(target!.id.slice(0, cut + 1)) &&
                    !control.disabled &&
                    control.unmeasurable === undefined,
                );
          if (sibling !== undefined) {
            await press(tree, sibling, record, spent);
            const again = findControl(tree, key);
            if (again !== undefined && !again.disabled) {
              const retried = await press(tree, again, record, spent);
              if (retried.verdict !== 'NO_EFFECT') {
                outcome = {
                  ...retried,
                  detail: `${retried.detail} (on retry after ${sibling.id} took the selection)`,
                };
              }
            }
          } else if (target.selected) {
            outcome = {
              ...outcome,
              verdict: 'ALREADY_IN_TARGET_STATE',
              detail:
                'already selected by the disclosure path that reached it;' +
                ' no other option in its group is available',
            };
          }
        }
        results.push(
          walked.length === 0
            ? outcome
            : {...outcome, detail: `${outcome.detail} (after ${walked.join(' -> ')})`},
        );
        await act(async () => tree.unmount());
      }

      RERUN[name] = results;
      stopWatching();
      const dead = results.filter(row => row.verdict === 'NO_EFFECT');
      const threw = results.filter(row => row.verdict === 'THREW');
      const timedOut = results.filter(row => row.verdict === 'TIMEOUT');
      const twice = results.filter(row => row.verdict === 'FIRED_TWICE');
      const wrong = results.filter(row => row.verdict === 'WRONG_ACTION');
      const live = results.filter(row => row.verdict === 'DISABLED_BUT_RESPONDED');
      trace(
        `RERUN_DONE ${name} measured=${results.length}` +
          ` unreachable=${unreachable.length}`,
      );
      if (
        dead.length + threw.length + timedOut.length + twice.length +
          wrong.length + live.length + unreachable.length > 0
      ) {
        console.log(
          [
            '',
            `--- ${name} SECOND PASS: ${results.length} measured on their own mount,` +
              ` ${dead.length} NO_EFFECT, ${threw.length} THREW,` +
              ` ${timedOut.length} TIMEOUT, ${twice.length} FIRED_TWICE,` +
              ` ${wrong.length} WRONG_ACTION,` +
              ` ${live.length} DISABLED_BUT_RESPONDED,` +
              ` ${unreachable.length} STILL_NOT_MEASURED ---`,
            ...dead.map(r => `  NO_EFFECT    ${r.handler} ${r.id}  [${r.detail}]`),
            ...threw.map(r => `  THREW        ${r.handler} ${r.id}  [${r.detail}]`),
            ...timedOut.map(r => `  TIMEOUT      ${r.handler} ${r.id}  [${r.detail}]`),
            ...twice.map(r => `  FIRED_TWICE  ${r.handler} ${r.id}  [${r.detail}]`),
            ...wrong.map(r => `  WRONG_ACTION ${r.handler} ${r.id}  [${r.detail}]`),
            ...live.map(
              r => `  DISABLED_BUT_RESPONDED ${r.handler} ${r.id}  [${r.detail}]`,
            ),
            ...unreachable.map(row => `  STILL_NOT_MEASURED ${row}`),
          ].join('\n'),
        );
      }
      /* THE POINT OF THE PASS. A control the sweep could not reach and
         this pass could not reach either is still unmeasured, and saying
         so is the requirement - not tolerating it. */
      expect({screen: name, stillNotMeasured: unreachable}).toEqual({
        screen: name,
        stillNotMeasured: [],
      });
      expect({screen: name, dead: dead.map(r => `${r.id}: ${r.detail}`)}).toEqual({
        screen: name,
        dead: [],
      });
      expect({screen: name, wrong: wrong.map(r => `${r.id}: ${r.detail}`)}).toEqual({
        screen: name,
        wrong: [],
      });
      expect({screen: name, threw: threw.map(r => `${r.id}: ${r.detail}`)}).toEqual({
        screen: name,
        threw: [],
      });
      expect({screen: name, timedOut: timedOut.map(r => `${r.id}: ${r.detail}`)}).toEqual(
        {screen: name, timedOut: []},
      );
      expect({screen: name, firedTwice: twice.map(r => `${r.id}: ${r.detail}`)}).toEqual({
        screen: name,
        firedTwice: [],
      });
      expect({
        screen: name,
        liveWhenDisabled: live.map(r => `${r.id}: ${r.detail}`),
      }).toEqual({screen: name, liveWhenDisabled: []});
    },
  );

  /**
   * THE THREE THINGS A REMAINING NOT_MEASURED IS ALLOWED TO BE.
   *
   * Anything else - and "the harness pressed something else first" above
   * all - is a gap in this pass, not a property of the application.
   */
  const CLASSES = [
    'SOURCE_REALISTIC_NOT_APPLICABLE',
    'PLATFORM_UNAVAILABLE',
    'SAFETY_CONTROLLED_NOT_MEASURED',
  ] as const;

  function classifyRemaining(why: string): string | undefined {
    return CLASSES.find(name => why.startsWith(name));
  }

  it('prints the closing NOT_MEASURED ledger', () => {
    const rows: string[] = [];
    const unclassified: string[] = [];
    const perClass = new Map<string, number>();
    let sequencing = 0;
    let measuredHere = 0;
    let remaining = 0;
    for (const [screen, unreached] of Object.entries(UNREACHED)) {
      const rerun = RERUN[screen] ?? [];
      const measured = new Map(
        rerun.map(row => [`${row.id}::${row.handler}`, row]),
      );
      for (const [key, why] of unreached) {
        if (why === HIDDEN_FIRST) {
          sequencing += 1;
          if (measured.has(key)) {
            measuredHere += 1;
            continue;
          }
        }
        remaining += 1;
        /* The reason the SECOND pass gave, where it reached the control
           and found a real reason not to press it - that is more precise
           than "the sweep never got here". */
        const settled = STILL[`${screen}::${key}`] ?? why;
        const kind = classifyRemaining(settled);
        perClass.set(kind ?? 'UNCLASSIFIED', (perClass.get(kind ?? 'UNCLASSIFIED') ?? 0) + 1);
        if (kind === undefined) unclassified.push(`${screen} ${key}: ${settled}`);
        rows.push(
          `  ${screen.padEnd(19)} ${key.padEnd(44)} ${kind ?? 'UNCLASSIFIED'}` +
            `\n      ${settled}`,
        );
      }
    }
    console.log(
      [
        '',
        '===== UI-X1D CLOSING NOT_MEASURED LEDGER =====',
        `  sequencing NOT_MEASURED after the first sweep : ${sequencing}`,
        `  measured on a mount of their own             : ${measuredHere}`,
        `  SEQUENCING NOT_MEASURED REMAINING            : ${sequencing - measuredHere}`,
        `  NOT_MEASURED for a reason that is not order  : ${remaining}`,
        ...[...perClass.entries()].map(
          ([kind, count]) => `    ${kind.padEnd(34)} ${count}`,
        ),
        ...(rows.length > 0 ? ['', ...rows] : []),
        '==============================================',
        '',
      ].join('\n'),
    );
    /* SEQUENCING_NOT_MEASURED = 0. Every control the first sweep lost to
       its own press order was pressed on a mount of its own. */
    expect(sequencing - measuredHere).toBe(0);
    /* And every row that is left says which of the three it is. */
    expect(unclassified).toEqual([]);
  });

  /* ================================================================== *
   * EVERY DISCOVERED SUBJECT LANDS IN EXACTLY ONE BUCKET
   *
   * The census used to print `discovered`, `executed`, `disabled` and
   * `notMeasured` on one line, and those four do not add up:
   *
   *     1878 - 1380 - 140 - 355 = 3
   *
   * The three were real and were not lost - they are
   * `ALREADY_IN_TARGET_STATE`, a ninth verdict the TOTAL line simply did
   * not print. `FIRED_TWICE` and `DISABLED_BUT_RESPONDED` were missing
   * from it too; they happen to be zero, so the line was arithmetically
   * broken without ever being visibly wrong.
   *
   * A count nobody can add up is a count nobody can check. So this does
   * not print a summary: it assigns EVERY subject the sweep ever
   * discovered, by name, to exactly one bucket, and fails on a subject
   * that lands in two or in none.
   * ================================================================== */
  const BUCKET_OF: Record<Result['verdict'], string> = {
    EXECUTED_CORRECT_ACTION: 'EXECUTED',
    DISABLED_WITH_VALID_REASON: 'DISABLED_VALID',
    ALREADY_IN_TARGET_STATE: 'ALREADY_IN_TARGET_STATE',
    NO_EFFECT: 'NO_EFFECT',
    THREW: 'THREW',
    TIMEOUT: 'TIMEOUT',
    FIRED_TWICE: 'FIRED_TWICE',
    WRONG_ACTION: 'WRONG_ACTION',
    DISABLED_BUT_RESPONDED: 'DISABLED_BUT_RESPONDED',
  };
  /** Printed in this order, so a defect bucket cannot hide at the end. */
  const BUCKET_ORDER = [
    'EXECUTED',
    'EXECUTED_ON_ITS_OWN_MOUNT',
    'DISABLED_VALID',
    'ALREADY_IN_TARGET_STATE',
    'SAFETY_CONTROLLED_NOT_MEASURED',
    'SOURCE_REALISTIC_NOT_APPLICABLE',
    'PLATFORM_UNAVAILABLE',
    'SEQUENCING_NOT_MEASURED',
    'UNCLASSIFIED_NOT_MEASURED',
    'NO_EFFECT',
    'THREW',
    'TIMEOUT',
    'FIRED_TWICE',
    'WRONG_ACTION',
    'DISABLED_BUT_RESPONDED',
  ] as const;
  /** Buckets that are findings. Any of them non-zero is a defect. */
  const DEFECT_BUCKETS = [
    'NO_EFFECT',
    'THREW',
    'TIMEOUT',
    'FIRED_TWICE',
    'WRONG_ACTION',
    'DISABLED_BUT_RESPONDED',
    'SEQUENCING_NOT_MEASURED',
    'UNCLASSIFIED_NOT_MEASURED',
  ];

  it('every discovered subject lands in exactly one bucket', () => {
    const bucketed = new Map<string, string[]>();
    const collisions: string[] = [];
    const orphans: string[] = [];
    const assign = (subject: string, bucket: string): void => {
      const already = bucketed.get(subject);
      if (already !== undefined) {
        collisions.push(`${subject}: ${already.join(' + ')} + ${bucket}`);
        already.push(bucket);
        return;
      }
      bucketed.set(subject, [bucket]);
    };

    for (const [screen, discovered] of Object.entries(DISCOVERED_KEYS)) {
      /* The first sweep pressed these and has a verdict for each. */
      for (const row of CENSUS[screen] ?? []) {
        assign(`${screen}::${row.id}::${row.handler}`, BUCKET_OF[row.verdict]);
      }
      /* The second pass pressed these, on a mount of their own. Its
         EXECUTED rows get their own bucket so that "reached by the sweep"
         and "reached only by replaying the disclosure path" stay
         distinguishable in the total. */
      for (const row of RERUN[screen] ?? []) {
        const key = `${screen}::${row.id}::${row.handler}`;
        assign(
          key,
          row.verdict === 'EXECUTED_CORRECT_ACTION'
            ? 'EXECUTED_ON_ITS_OWN_MOUNT'
            : BUCKET_OF[row.verdict],
        );
      }
      /* And whatever neither pass pressed, with the reason. */
      const rerunKeys = new Set(
        (RERUN[screen] ?? []).map(row => `${row.id}::${row.handler}`),
      );
      for (const [key, why] of UNREACHED[screen] ?? []) {
        if (rerunKeys.has(key)) continue;
        const settled = STILL[`${screen}::${key}`] ?? why;
        const kind = classifyRemaining(settled);
        assign(
          `${screen}::${key}`,
          kind ??
            (settled === HIDDEN_FIRST
              ? 'SEQUENCING_NOT_MEASURED'
              : 'UNCLASSIFIED_NOT_MEASURED'),
        );
      }
      /* A subject that was discovered and reached neither a verdict nor
         a reason would be invisible in every ledger above. */
      for (const key of discovered) {
        if (!bucketed.has(`${screen}::${key}`)) {
          orphans.push(`${screen}::${key}`);
        }
      }
    }

    const totals = new Map<string, number>();
    for (const [, buckets] of bucketed) {
      totals.set(buckets[0], (totals.get(buckets[0]) ?? 0) + 1);
    }
    const discoveredTotal = Object.values(DISCOVERED_KEYS).reduce(
      (sum, set) => sum + set.size,
      0,
    );
    const bucketTotal = [...totals.values()].reduce((sum, n) => sum + n, 0);

    console.log(
      [
        '',
        '===== UI-X1D CENSUS ARITHMETIC (MUTUALLY EXCLUSIVE BUCKETS) =====',
        ...BUCKET_ORDER.filter(name => (totals.get(name) ?? 0) > 0).map(
          name => `  ${name.padEnd(34)} ${String(totals.get(name)).padStart(5)}`,
        ),
        `  ${'-'.repeat(34)} ${'-'.repeat(5)}`,
        `  ${'SUM OF ALL BUCKETS'.padEnd(34)} ${String(bucketTotal).padStart(5)}`,
        `  ${'TOTAL DISCOVERED'.padEnd(34)} ${String(discoveredTotal).padStart(5)}`,
        `  ${'REMAINDER'.padEnd(34)} ${String(
          discoveredTotal - bucketTotal,
        ).padStart(5)}`,
        '=================================================================',
        '',
      ].join('\n'),
    );

    /* NO SUBJECT IN TWO BUCKETS. */
    expect(collisions).toEqual([]);
    /* NO SUBJECT IN NONE. */
    expect(orphans).toEqual([]);
    /* AND THE ARITHMETIC INVARIANT ITSELF. */
    expect({sum: bucketTotal}).toEqual({sum: discoveredTotal});
    /* Every bucket that is a finding is empty. */
    for (const name of DEFECT_BUCKETS) {
      expect({bucket: name, count: totals.get(name) ?? 0}).toEqual({
        bucket: name,
        count: 0,
      });
    }
    /* And no bucket outside the printed order exists, which would mean a
       verdict was added without being reconciled. */
    expect(
      [...totals.keys()].filter(
        name => !(BUCKET_ORDER as readonly string[]).includes(name),
      ),
    ).toEqual([]);
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
      openSubscriptionLedger();
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
        const mountedSubscriptions = readSubscriptionLedger().size;

        await act(async () => {
          tree.unmount();
        });
        await act(async () => {
          await Promise.resolve();
        });

        const stillRunning = timers.live();
        const stillSubscribed = [...readSubscriptionLedger().values()];
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
        closeSubscriptionLedger();
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
    openSubscriptionLedger();
    try {
      const teardown = port.subscribe(() => undefined);
      expect(readSubscriptionLedger().size).toBe(1);
      teardown();
      expect(readSubscriptionLedger().size).toBe(0);
      port.subscribe(() => undefined);
      expect([...readSubscriptionLedger().values()]).toEqual(['probe.subscribe']);
    } finally {
      closeSubscriptionLedger();
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
