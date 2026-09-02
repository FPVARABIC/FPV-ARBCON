/**
 * AN OPERATION THAT STARTS MUST FINISH - OR SAY IT FAILED.
 *
 * Every configuration screen in this application runs the same shape of
 * work: it enters a phase (`LOADING`, `SAVING`), disables the controls
 * that would collide with that work, shows the operator that something
 * is happening, and then leaves the phase. The defect this file exists
 * for is the third step going missing - one branch that returns without
 * clearing the phase. The screen then sits with its controls dead and a
 * spinner turning, forever, and no amount of waiting helps because
 * nothing is still running.
 *
 * It is invisible to an ordinary screen test, because an ordinary screen
 * test lets the operation finish before it looks. The only way to see a
 * busy state at all is to HOLD THE OPERATION OPEN, look, and then let it
 * go - which is what this file does, through a controller double whose
 * promise is resolved by hand.
 *
 * WHAT "BUSY" IS MEASURED FROM. Not from `accessibilityState.busy` -
 * this application does not use that key, and a detector keyed on it
 * would report "no busy state anywhere" while every screen has one. It
 * is measured from the RENDERED PRODUCT STATE that the phase actually
 * drives:
 *
 *   - an <ActivityIndicator> mounted,
 *   - a component told `busy` (the save bar takes `busy` + `busyLabel`),
 *   - controls disabled that were enabled a moment earlier - GpsScreen
 *     line 399, `const busy = phase === 'LOADING' || phase === 'SAVING'`,
 *     feeding `disabled={busy}` on eleven controls.
 *
 * Each screen is driven through four endings, because a phase machine
 * can leak on any one of them and pass on the others:
 *
 *   started -> success   -> settles
 *   started -> failure   -> settles
 *   started -> rejection -> settles      (a thrown error, not a result)
 *   started -> unmount   -> no late work
 */
import React from 'react';
import {act} from 'react-test-renderer';
import * as ReactTestRenderer from 'react-test-renderer';

import FailsafeScreen from './FailsafeScreen';
import GpsScreen from './GpsScreen';
import ModesScreen from './ModesScreen';
import PowerBatteryScreen from './PowerBatteryScreen';
import VideoTransmitterScreen from './VideoTransmitterScreen';
import ConfigurationsScreen from './ConfigurationsScreen';
import PidTuningScreen from './PidTuningScreen';

import {FailsafeConfigurationController} from '../../platforms/react-native/protocol/FailsafeConfigurationController';
import {GpsConfigurationController} from '../../platforms/react-native/protocol/GpsConfigurationController';
import {ModesConfigurationController} from '../../platforms/react-native/protocol/ModesConfigurationController';
import {PowerConfigurationController} from '../../platforms/react-native/protocol/PowerConfigurationController';
import {VtxConfigurationController} from '../../platforms/react-native/protocol/VtxConfigurationController';
import {GeneralConfigurationController} from '../../platforms/react-native/protocol/GeneralConfigurationController';
import {PidTuningController} from '../../platforms/react-native/protocol/PidTuningController';

import {
  DRONE_SPECS,
  buildFactoryBoard,
} from '../../platforms/react-native/protocol/__testUtils__/virtualDroneFixtures';
import {VirtualFlightController} from '../../platforms/react-native/protocol/__testUtils__/virtualFlightController';
import {VirtualSession} from '../../platforms/react-native/protocol/__testUtils__/virtualSession';

jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

jest.setTimeout(120000);

const KEY = {sessionId: 'busy-census', generation: 1} as const;

/* ==================================================================== *
 * AN OPERATION HELD OPEN
 * ==================================================================== */

interface Held<T> {
  readonly promise: Promise<T>;
  readonly settle: (value: T) => void;
  readonly fail: (error: unknown) => void;
}

function held<T>(): Held<T> {
  let settle!: (value: T) => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  /* Nothing waits on this promise until the screen does, and a rejection
     that arrives before then is an unhandled rejection in Node. */
  promise.catch(() => undefined);
  return {promise, settle, fail};
}

/* ==================================================================== *
 * WHAT BUSY LOOKS LIKE, FROM THE RENDERED TREE
 * ==================================================================== */

interface Busy {
  readonly spinners: number;
  readonly flagged: number;
  readonly disabled: number;
}

const nameOf = (type: unknown): string =>
  typeof type === 'string'
    ? type
    : ((type as {displayName?: string; name?: string})?.displayName ??
      (type as {name?: string})?.name ??
      '');

function busyOf(tree: ReactTestRenderer.ReactTestRenderer): Busy {
  const all = tree.root.findAll(node => node.props !== undefined, {deep: true});
  let spinners = 0;
  let flagged = 0;
  let disabled = 0;
  for (const node of all) {
    const props = node.props as any;
    if (/ActivityIndicator/.test(nameOf(node.type))) spinners += 1;
    if (props.busy === true) flagged += 1;
    if (
      typeof node.type !== 'string' &&
      typeof props.onPress === 'function' &&
      props.disabled === true
    ) {
      disabled += 1;
    }
  }
  return {spinners, flagged, disabled};
}

async function flush(rounds = 8): Promise<void> {
  await act(async () => {
    for (let round = 0; round < rounds; round += 1) await Promise.resolve();
  });
}

/* ==================================================================== *
 * THE SCREENS
 * ==================================================================== */

/** The same source-realistic board the interaction census drives. */
function board(): VirtualFlightController {
  const spec = DRONE_SPECS.find(candidate => candidate.key === 'LONG_RANGE');
  if (spec === undefined) throw new Error('no LONG_RANGE spec');
  return new VirtualFlightController({parameters: buildFactoryBoard(spec)});
}

/**
 * A snapshot minted under THIS screen's session.
 *
 * Not a detail: U-R3 makes a screen refuse a snapshot that belongs to a
 * different session, which is the whole point of that work. Building the
 * fixture under some other id and handing it over produces a screen that
 * silently declines to adopt anything and renders its empty state
 * forever - which reads exactly like a stuck loading state and is not
 * one. This harness reported precisely that false finding until the ids
 * were made to match.
 */
async function snapshotVia(
  make: (options: any) => {load: (key: any) => Promise<any>},
): Promise<any> {
  const session = new VirtualSession({
    sessionId: KEY.sessionId,
    board: board() as never,
    apiMinor: 47,
  });
  const outcome = await make(session.options as any).load(session.key);
  return (outcome as {snapshot?: unknown}).snapshot;
}

interface AsyncScreen {
  readonly name: string;
  /** The real controller, used once to get a source-realistic snapshot. */
  readonly snapshot: () => Promise<unknown>;
  readonly render: (controller: unknown) => React.ReactElement;
  /** A load result the screen treats as a completed failure. */
  readonly failure: unknown;
}

const SCREENS: readonly AsyncScreen[] = [
  {
    name: 'Failsafe',
    snapshot: () =>
      snapshotVia(o => new FailsafeConfigurationController(o)),
    render: controller => (
      <FailsafeScreen
        sessionKey={KEY}
        active
        onOpenReceiver={() => undefined}
        onOpenMotors={() => undefined}
        controller={controller as never}
      />
    ),
    failure: {kind: 'FAILED', error: new Error('link lost')},
  },
  {
    name: 'GPS',
    snapshot: () => snapshotVia(o => new GpsConfigurationController(o)),
    render: controller => (
      <GpsScreen
        sessionKey={KEY}
        active
        onOpenPorts={() => undefined}
        controller={controller as never}
      />
    ),
    failure: {kind: 'FAILED', error: new Error('link lost')},
  },
  {
    name: 'Modes',
    snapshot: () =>
      snapshotVia(o => new ModesConfigurationController(o)),
    render: controller => (
      <ModesScreen
        sessionKey={KEY}
        active
        onOpenMotors={() => undefined}
        controller={controller as never}
      />
    ),
    failure: {kind: 'FAILED', error: new Error('link lost')},
  },
  {
    name: 'Power',
    snapshot: () =>
      snapshotVia(o => new PowerConfigurationController(o)),
    render: controller => (
      <PowerBatteryScreen
        sessionKey={KEY}
        active
        onOpenMotors={() => undefined}
        controller={controller as never}
      />
    ),
    failure: {kind: 'FAILED', error: new Error('link lost')},
  },
  {
    name: 'VTX',
    snapshot: () => snapshotVia(o => new VtxConfigurationController(o)),
    render: controller => (
      <VideoTransmitterScreen
        sessionKey={KEY}
        active
        controller={controller as never}
      />
    ),
    failure: {kind: 'FAILED', error: new Error('link lost')},
  },
  {
    name: 'Configurations',
    snapshot: () => snapshotVia(o => new GeneralConfigurationController(o)),
    render: controller => (
      <ConfigurationsScreen
        sessionKey={KEY}
        active
        onOpenSetup={() => undefined}
        onOpenMotors={() => undefined}
        onOpenPorts={() => undefined}
        onOpenGps={() => undefined}
        controller={controller as never}
      />
    ),
    failure: {kind: 'FAILED', error: new Error('link lost')},
  },
  {
    name: 'PID',
    snapshot: () => snapshotVia(o => new PidTuningController(o)),
    render: controller => (
      <PidTuningScreen
        sessionKey={KEY}
        active
        onOpenMotors={() => undefined}
        controller={controller as never}
      />
    ),
    failure: {kind: 'FAILED', error: new Error('link lost')},
  },
];

/** One held load, and the tree it is holding open. */
async function openWithHeldLoad(screen: AsyncScreen): Promise<{
  tree: ReactTestRenderer.ReactTestRenderer;
  gate: Held<unknown>;
  idle: Busy;
  duringLoad: Busy;
  snapshot: unknown;
}> {
  const snapshot = await screen.snapshot();
  const gate = held<unknown>();
  const controller = {
    load: async () => gate.promise,
    save: async () => ({kind: 'NO_CHANGES', snapshot}),
  };
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(screen.render(controller));
  });
  await flush();
  const duringLoad = busyOf(tree);
  /* IDLE is the same screen with nothing outstanding - measured after
     the operation settles, in each case below. Here we only need a
     zeroed baseline to compare the held state against. */
  return {tree, gate, idle: {spinners: 0, flagged: 0, disabled: 0}, duringLoad, snapshot};
}

const REPORT: string[] = [];

/**
 * THE SETTLE RULE.
 *
 * A screen is "still working" while its operation is outstanding, and
 * every screen shows that differently: GPS greys eleven controls out,
 * the flasher turns a spinner, and most of the configuration screens
 * simply do not draw their body yet. There is no single property to
 * read - which is exactly why keying a detector on `accessibilityState
 * .busy` found nothing and concluded, wrongly, that nothing was there.
 *
 * What is common to all of them is the TRANSITION. Whatever the screen
 * looks like while the work is outstanding, it must look different once
 * the work ends - and it must end with no spinner turning and nothing
 * still flagged busy. A screen that renders identically before and after
 * its operation completes never left the loading state; that is the
 * defect, and it is visible without knowing how any one screen chooses
 * to draw "working".
 */
async function settlesAfter(
  screen: AsyncScreen,
  ending: (gate: Held<unknown>, snapshot: unknown) => Promise<void> | void,
): Promise<{
  before: string;
  after: string;
  busyBefore: Busy;
  busyAfter: Busy;
}> {
  const {tree, gate, duringLoad, snapshot} = await openWithHeldLoad(screen);
  const before = JSON.stringify(tree.toJSON());
  await act(async () => {
    await ending(gate, snapshot);
    await Promise.resolve();
  });
  await flush();
  const after = JSON.stringify(tree.toJSON());
  const busyAfter = busyOf(tree);
  await act(async () => tree.unmount());
  return {before, after, busyBefore: duringLoad, busyAfter};
}

/**
 * SCREENS WHOSE TRANSITION THIS FIXTURE CANNOT SHOW.
 *
 * Two screens render the same thing while their read is outstanding as
 * they do once it lands, on this board, because the answer contains
 * nothing that changes the view: the LONG_RANGE fixture has GPS switched
 * off with no port assigned, so GpsScreen draws its "not set up" state
 * either way, and ConfigurationsScreen's body is unchanged by the values
 * it receives.
 *
 * That is a MISSING SIGNAL, not a stuck screen, and the difference
 * matters: asserting a settle on a screen with no observable transition
 * would fail it for a defect it has not been shown to have. They are
 * named here and excluded from the settle assertion - never silently
 * passed, never reported as stuck.
 *
 * It does leave a real question open, recorded and NOT repaired because
 * it is not reproduced: while the read is outstanding GpsScreen already
 * shows `featureOff` / `noFix` / `noPort`, which are settled negative
 * facts it does not yet have. Establishing whether that is an
 * unknown-rendered-as-off defect needs a fixture where GPS is enabled
 * and a port assigned, which this pass did not build.
 */
const NO_OBSERVABLE_TRANSITION: Readonly<Record<string, string>> = {
  GPS: 'on this fixture GPS is off with no port, so the "not set up" view is identical before and after the read lands',
  Configurations:
    'the rendered body does not change with the values this fixture returns, so the read landing is not observable',
};

function expectSettled(
  name: string,
  ending: string,
  outcome: {before: string; after: string; busyAfter: Busy},
): void {
  const excused = NO_OBSERVABLE_TRANSITION[name];
  if (excused !== undefined) {
    /* Still asserted: whatever it shows, nothing may be left spinning. */
    expect({screen: name, ending, spinners: outcome.busyAfter.spinners}).toEqual({
      screen: name,
      ending,
      spinners: 0,
    });
    return;
  }
  expect({
    screen: name,
    ending,
    leftTheLoadingState: outcome.before !== outcome.after,
    spinnersLeftTurning: outcome.busyAfter.spinners,
    stillFlaggedBusy: outcome.busyAfter.flagged,
  }).toEqual({
    screen: name,
    ending,
    leftTheLoadingState: true,
    spinnersLeftTurning: 0,
    stillFlaggedBusy: 0,
  });
}

describe('a screen that starts an operation always leaves the busy state', () => {
  it.each(SCREENS.map(screen => [screen.name, screen] as const))(
    '%s: a held load settles when the answer SUCCEEDS',
    async (name, screen) => {
      const outcome = await settlesAfter(screen, (gate, snapshot) => {
        gate.settle({kind: 'LOADED', snapshot});
      });
      REPORT.push(
        `  ${name.padEnd(15)} whileWorking{spin=${outcome.busyBefore.spinners}` +
          ` busy=${outcome.busyBefore.flagged} off=${outcome.busyBefore.disabled}}` +
          `  settled{spin=${outcome.busyAfter.spinners}` +
          ` busy=${outcome.busyAfter.flagged} off=${outcome.busyAfter.disabled}}` +
          `  treeChanged=${outcome.before !== outcome.after}`,
      );
      expectSettled(name, 'SUCCESS', outcome);
    },
  );

  it.each(SCREENS.map(screen => [screen.name, screen] as const))(
    '%s: a held load settles when the answer is a FAILURE',
    async (name, screen) => {
      expectSettled(
        name,
        'FAILURE',
        await settlesAfter(screen, gate => {
          gate.settle(screen.failure);
        }),
      );
    },
  );

  it.each(SCREENS.map(screen => [screen.name, screen] as const))(
    '%s: a held load settles when the controller THROWS',
    async (name, screen) => {
      /* Not a failure RESULT - an exception out of the controller. A
         phase machine that only clears itself on the result path leaks
         here and nowhere else. */
      expectSettled(
        name,
        'REJECTION',
        await settlesAfter(screen, gate => {
          gate.fail(new Error('transport exploded'));
        }),
      );
    },
  );

  it.each(SCREENS.map(screen => [screen.name, screen] as const))(
    '%s: an operation still outstanding at unmount does no late work',
    async (name, screen) => {
      const {tree, gate, snapshot} = await openWithHeldLoad(screen);
      const complaints: string[] = [];
      const realError = console.error;
      const realWarn = console.warn;
      console.error = (...args: unknown[]) => complaints.push(String(args[0]));
      console.warn = (...args: unknown[]) => complaints.push(String(args[0]));
      try {
        await act(async () => tree.unmount());
        /* The answer arrives after the screen is gone. Nothing may
           reach into an unmounted tree. */
        await act(async () => {
          gate.settle({kind: 'LOADED', snapshot});
          await Promise.resolve();
        });
        await flush();
      } finally {
        console.error = realError;
        console.warn = realWarn;
      }
      expect({
        screen: name,
        lateWork: complaints.filter(line =>
          /unmounted|not wrapped in act|Cannot update/i.test(line),
        ),
      }).toEqual({screen: name, lateWork: []});
    },
  );

  it('prints the busy ledger, and has enough real subjects to mean anything', () => {
    const measured = SCREENS.filter(
      screen => NO_OBSERVABLE_TRANSITION[screen.name] === undefined,
    );
    console.log(
      [
        '',
        '===== UI-X1C ASYNC BUSY / LOADING LEDGER =====',
        ...REPORT,
        ...Object.entries(NO_OBSERVABLE_TRANSITION).map(
          ([screen, why]) => `  NOT_MEASURED ${screen}: ${why}`,
        ),
        `  ${measured.length} of ${SCREENS.length} screens have an observable` +
          ` transition, each driven through 4 endings` +
          ` (success, failure, rejection, unmount)`,
        '==============================================',
        '',
      ].join('\n'),
    );
    expect(REPORT.length).toBe(SCREENS.length);
    /* The settle rule is only worth anything if it is actually applied
       to screens that transition. */
    expect(measured.length).toBeGreaterThanOrEqual(5);
  });
});
