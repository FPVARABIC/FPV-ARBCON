/**
 * CLOSE A MOTOR SESSION, OPEN ANOTHER. THROUGH THE REAL SCREEN.
 *
 * REPORTED FROM USE, WITH SCREENSHOTS: after closing a motor session the
 * operator was told
 *
 *   «الجلسة انتهت. افصل كابل USB وأعد توصيله لبدء جلسة جديدة.»
 *
 * with the flight controller still connected. Unplugging a cable to start
 * a second bench session is not a recovery step.
 *
 * THREE LAYERS WERE WRONG, AND EACH WAS FOUND ONLY AFTER THE ONE ABOVE
 * IT WAS FIXED. That is the real lesson of this file.
 *
 *   1. THE BINDING held a spent controller for ever. Fixed first, and
 *      tested in isolation, where it passed - while the product stayed
 *      broken, because the SCREEN never reached `beginSession()`.
 *
 *   2. TWO GATES IN MotorsScreen sat in front of it, both written
 *      against `phase` alone: `requiresNewConnection` fired on every
 *      `phase === 'CLOSED'` - and CLOSED is where a HEALTHY session ends
 *      - while the toggle refused to turn ON unless `phase === 'IDLE'`,
 *      which a controller never returns to. The press did nothing, in
 *      silence. Fixed second. The bug survived.
 *
 *   3. THE ARMING RESTRICTION RECORD, which only an end-to-end run could
 *      reach. `motorArmingRestriction.ts` records an establishment
 *      against the OFFICIAL SESSION AUTHORITY - deliberately outliving an
 *      ordinary lease release - but the RELEASE is performed by the
 *      controller's teardown, which never told it. So the second session
 *      on the same cable was refused with
 *      ARMING_RESTRICTION_ALREADY_ESTABLISHED and failed closed at setup:
 *      the operator saw the same broken reopen, now for a third reason.
 *      `recordMotorArmingRestrictionReleased` closes it.
 *
 * Every layer can be right on its own and the product still broken. Only
 * the whole path proves the whole path.
 *
 * WHAT THIS FILE DRIVES, stated plainly, because a weaker claim was made
 * here once. Everything below the coordinator's session IDENTITY is real:
 * MainTabsScreen, MotorsScreen, the real capability registry, the real
 * binding, the real MotorTestController, the real MspClient, over a fake
 * transport answered by `ScriptedMotorFc`. A session genuinely reaches
 * READY, a teardown genuinely completes every step and releases the
 * lease, and the reopen genuinely runs through `beginSession()`.
 *
 * WHY THE PREVIOUS VERSION OF THIS FILE COULD NOT. It asserted `phase ===
 * 'ACTIVE'` over a transport that answered NOTHING. That assertion passed
 * and meant almost nothing: the phase turns ACTIVE when setup STARTS, and
 * the session was in fact frozen mid-setup at `AUTHORITY_CAPTURE`, its
 * first configuration read outstanding for ever. The screen's canonical
 * shutdown waits for the controller to settle before it will call
 * `endSession()`, so a frozen session could never close and the close →
 * reopen half was untestable. Every assertion here now names the setup
 * step or the teardown report, so a half-started session cannot pass as a
 * live one again.
 *
 * A CONTROLLER'S IDENTITY, PROVEN WITHOUT AN OBJECT REFERENCE. The
 * binding hands out a fresh facade object on every call, so reference
 * equality proves nothing. The lifecycle does it instead: a controller
 * runs IDLE -> PREPARING -> ACTIVE -> CLOSING -> CLOSED and never
 * returns, and a teardown report, once written, is never unwritten. So
 * observing CLOSED-with-a-teardown and then ACTIVE-with-no-teardown means
 * a DIFFERENT controller - the first one cannot have gone back.
 */

jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

/**
 * Only the coordinator's identity read is stubbed. The lease, the barrier,
 * the binding, the capability store and the controller are all real -
 * without an identity the controller refuses to start at all and the
 * screen never leaves its blocked state, which would test nothing.
 */
jest.mock('../../platforms/react-native/protocol', () => ({
  ...jest.requireActual('../../platforms/react-native/protocol'),
  mspSessionCoordinator: {
    getMotorTestSessionIdentity: () => ({physicalGeneration: 7, mspEpoch: 0}),
    getIdentificationState: () => ({
      status: 'SUCCEEDED',
      identity: {
        apiVersion: {mspProtocolVersion: 0, apiVersionMajor: 1, apiVersionMinor: 47},
        firmware: {identifier: 'BTFL', knownFamily: 'BETAFLIGHT'},
        board: {},
      },
    }),
    subscribeIdentificationState: () => () => {},
    subscribeMotorTestSessionInvalidated: () => () => {},
    getSessionBringUpFailure: () => undefined,
    subscribeSessionBringUpFailure: () => () => {},
  },
}));

import React from 'react';
import {Text} from 'react-native';
import ReactTestRenderer from 'react-test-renderer';

import '../../i18n';
import MainTabsScreen from './MainTabsScreen';
import {
  closeMotorTestCapability,
  createMotorTestTelemetryRegistry,
  openMotorTestCapability,
  readMotorTestCapability,
} from '../../platforms/react-native/protocol/motorTestCapability';
import {
  MSP_RESPONSE_TIMEOUT_MILLIS,
  MspClient,
} from '../../core/protocol/mspClient';
import {FakeMspTransport} from '../../core/protocol/__testUtils__/mspFakeTransport';
import {ScriptedMotorFc} from '../../core/protocol/__testUtils__/scriptedMotorFc';
import type {ScriptedMotorFcOptions} from '../../core/protocol/__testUtils__/scriptedMotorFc';
import {MSP_SET_MOTOR} from '../../core/protocol/msp/commands/motorTestCommands';

const SESSION_ID = 'reopen-production-session';

/** The exact string the operator was shown after a healthy close. It is
 * asserted verbatim rather than by test id: the defect was the WORDS - a
 * cable instruction with the cable still attached - and a rename that
 * kept the instruction would be the same bug. */
const USB_RECONNECT_MESSAGE =
  'الجلسة انتهت. افصل كابل USB وأعد توصيله لبدء جلسة جديدة.';

let transport: FakeMspTransport;
let fc: ScriptedMotorFc;

function openRealCapability(options: ScriptedMotorFcOptions = {}): void {
  transport = new FakeMspTransport();
  fc = new ScriptedMotorFc(transport, options);
  const client = new MspClient(transport, SESSION_ID);
  openMotorTestCapability(SESSION_ID, client, createMotorTestTelemetryRegistry());
}

function renderShell() {
  const navigation = {addListener: () => () => {}, goBack: () => {}} as never;
  const route = {
    key: 'Setup-1',
    name: 'Setup' as const,
    params: {sessionKey: {sessionId: SESSION_ID, generation: 1}},
  } as never;
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <MainTabsScreen navigation={navigation} route={route} />,
    );
  });
  const find = (testID: string, handler: 'onPress' | 'onValueChange') =>
    renderer.root
      .findAll(candidate => candidate.props?.testID === testID)
      .find(candidate => typeof candidate.props?.[handler] === 'function');
  return {
    renderer,
    press: (testID: string) => {
      const node = find(testID, 'onPress');
      if (node === undefined) throw new Error(`no pressable "${testID}"`);
      ReactTestRenderer.act(() => node.props.onPress());
    },
    /**
     * REFUSES A DISABLED CONTROL, deliberately. Calling `onValueChange` on
     * a switch the screen has disabled is something no operator can do,
     * and a proof built on it would be a proof about a build nobody ships.
     */
    toggle: (testID: string, next: boolean) => {
      const node = find(testID, 'onValueChange');
      if (node === undefined) throw new Error(`no switch "${testID}"`);
      if (node.props.disabled === true) {
        throw new Error(`switch "${testID}" is disabled - an operator could not press it`);
      }
      ReactTestRenderer.act(() => node.props.onValueChange(next));
    },
    toggleIsEnabled: (testID: string) => find(testID, 'onValueChange')?.props.disabled !== true,
    text: () =>
      renderer.root
        .findAllByType(Text)
        .map(node => {
          const value = node.props.children;
          return Array.isArray(value) ? value.join('') : String(value ?? '');
        })
        .join('\n'),
  };
}

/**
 * Runs the scripted board and the React scheduler until both are quiet.
 *
 * Bounded rather than "until idle": a lifecycle that genuinely stalls must
 * fail an assertion, not hang a suite. Forty rounds is roughly four times
 * what the longest path here needs.
 */
async function settle(rounds = 40, delayMillis = 2) {
  await ReactTestRenderer.act(async () => {
    for (let round = 0; round < rounds; round += 1) {
      fc.pump();
      await Promise.resolve();
      await new Promise(resolve => setTimeout(resolve, delayMillis));
    }
  });
}

/**
 * Waits past the MSP client's own response timeout.
 *
 * A request nobody answers is not resolved by pumping harder - the client
 * decides it timed out on a real clock, and only then does the lifecycle
 * reach a terminal state. The bound comes from the client rather than
 * from a number typed here, so retuning the client cannot silently turn
 * these into tests that stop before the thing they are asserting happens.
 */
async function settleThroughResponseTimeout() {
  const rounds = Math.ceil((MSP_RESPONSE_TIMEOUT_MILLIS + 600) / 25);
  await settle(rounds, 25);
}

const renderers: ReactTestRenderer.ReactTestRenderer[] = [];
afterEach(() => {
  ReactTestRenderer.act(() => {
    for (const renderer of renderers.splice(0, renderers.length)) {
      try {
        renderer.unmount();
      } catch {
        // Already torn down.
      }
    }
  });
  closeMotorTestCapability(SESSION_ID);
});

function snapshot() {
  return readMotorTestCapability(SESSION_ID)?.lifecycleStopPort()?.getSnapshot();
}

/** A session that actually reached READY, not one that merely started. */
function expectLiveSession() {
  const live = snapshot();
  expect(live?.phase).toBe('ACTIVE');
  expect(live?.setupStep).toBe('READY');
  // A fresh controller has written no teardown report. This is what makes
  // the reopen assertions identity proofs rather than phase readings.
  expect(live?.teardown).toBeUndefined();
}

/** A session that ended the way a healthy one ends. */
function expectCleanlyClosedSession() {
  const closed = snapshot();
  expect(closed?.phase).toBe('CLOSED');
  expect(closed?.teardown?.complete).toBe(true);
  // The two facts that make it CLEAN rather than merely finished: the
  // exclusive lease went back, and the FC-side arming restriction this
  // session established was released rather than abandoned on the board.
  expect(closed?.teardown?.leaseRelease).toBe('RELEASED');
  expect(closed?.teardown?.armingRestrictionRelease).toBe('RELEASED');
}

async function motorsScreen(options: ScriptedMotorFcOptions = {}) {
  const shell = renderShell();
  renderers.push(shell.renderer);
  ReactTestRenderer.act(() => openRealCapability(options));
  shell.press('main-tab-MOTORS');
  await settle();
  return shell;
}

describe('open, close cleanly, open again - no cable involved', () => {
  it('opens a session that reaches READY through the screen toggle', async () => {
    // The precondition for every other proof here: the production path
    // really does reach a fully set-up controller, so a later assertion
    // is not passing on a session that never started.
    const shell = await motorsScreen();
    shell.toggle('motor-session-toggle', true);
    await settle();

    expectLiveSession();
  });

  it('closes it with a COMPLETE teardown', async () => {
    const shell = await motorsScreen();
    shell.toggle('motor-session-toggle', true);
    await settle();
    shell.toggle('motor-session-toggle', false);
    await settle();

    expectCleanlyClosedSession();
    // The all-stop really was put on the wire and really was answered.
    // Teardown's own contract is that a session may not close cleanly
    // without one, and this is the evidence that contract was met rather
    // than skipped.
    expect(fc.acknowledged).toContain(MSP_SET_MOTOR);
  });

  it('opens a SECOND session from the same connection', async () => {
    // The reported defect, end to end.
    const shell = await motorsScreen();
    shell.toggle('motor-session-toggle', true);
    await settle();
    shell.toggle('motor-session-toggle', false);
    await settle();
    expectCleanlyClosedSession();

    shell.toggle('motor-session-toggle', true);
    await settle();

    // ACTIVE again, at READY again, with NO teardown report - which the
    // closed controller can never show, so this is a new one.
    expectLiveSession();
  });

  it('survives open, close, open, close, open', async () => {
    const shell = await motorsScreen();
    for (const cycle of [1, 2]) {
      shell.toggle('motor-session-toggle', true);
      await settle();
      expectLiveSession();
      shell.toggle('motor-session-toggle', false);
      await settle();
      expectCleanlyClosedSession();
      expect(cycle).toBeLessThan(3);
    }
    shell.toggle('motor-session-toggle', true);
    await settle();

    expectLiveSession();
  });

  it('never closes the flight-controller connection to do it', async () => {
    // Reopening must not depend on tearing the link down - that is the
    // whole complaint. The capability is the link's lifetime here.
    const shell = await motorsScreen();
    shell.toggle('motor-session-toggle', true);
    await settle();
    expect(readMotorTestCapability(SESSION_ID)?.isOpen()).toBe(true);

    shell.toggle('motor-session-toggle', false);
    await settle();
    expect(readMotorTestCapability(SESSION_ID)?.isOpen()).toBe(true);

    shell.toggle('motor-session-toggle', true);
    await settle();
    expect(readMotorTestCapability(SESSION_ID)?.isOpen()).toBe(true);
  });

  it('leaves the toggle usable after a clean close', async () => {
    // The mechanism of the original bug: the press was swallowed, so the
    // control looked alive and did nothing. `toggle()` above refuses a
    // disabled switch, so the reopen tests already prove it is pressable;
    // this states it directly.
    const shell = await motorsScreen();
    shell.toggle('motor-session-toggle', true);
    await settle();
    shell.toggle('motor-session-toggle', false);
    await settle();

    expect(shell.toggleIsEnabled('motor-session-toggle')).toBe(true);
  });
});

describe('the cable message means a cable, and nothing else', () => {
  it('is absent while a session is healthy', async () => {
    const shell = await motorsScreen();
    shell.toggle('motor-session-toggle', true);
    await settle();

    expect(shell.text()).not.toContain(USB_RECONNECT_MESSAGE);
  });

  it('is absent after a clean close - the reported defect', async () => {
    const shell = await motorsScreen();
    shell.toggle('motor-session-toggle', true);
    await settle();
    shell.toggle('motor-session-toggle', false);
    await settle();

    expectCleanlyClosedSession();
    expect(shell.text()).not.toContain(USB_RECONNECT_MESSAGE);
  });

  it('is absent after a clean close AND a reopen', async () => {
    const shell = await motorsScreen();
    shell.toggle('motor-session-toggle', true);
    await settle();
    shell.toggle('motor-session-toggle', false);
    await settle();
    shell.toggle('motor-session-toggle', true);
    await settle();

    expect(shell.text()).not.toContain(USB_RECONNECT_MESSAGE);
  });

  it('IS shown when the board actually goes away', async () => {
    // The counterpart, and the reason the message exists at all. Removing
    // it wholesale would have "fixed" the complaint by deleting a true
    // instruction; a real detach must still say exactly this.
    const shell = await motorsScreen();
    shell.toggle('motor-session-toggle', true);
    await settle();
    expectLiveSession();

    ReactTestRenderer.act(() => fc.disconnect(SESSION_ID));
    await settle();

    expect(shell.text()).toContain(USB_RECONNECT_MESSAGE);
  });
});

/**
 * FAIL-CLOSED IS NOT NEGOTIABLE.
 *
 * The reopen fix hangs entirely off `teardown.complete`. These prove the
 * other half: when a close CANNOT be shown to have completed, the session
 * stays blocked and a new connection really is required. If a future
 * change made reopening easier by relaxing that, one of these fails.
 */
describe('a close that could not complete stays closed', () => {
  it('refuses to reopen when the all-stop was never acknowledged', async () => {
    // The board accepts everything except the stop, which it silently
    // drops - the worst realistic case, because an output may be
    // commanded and nothing can prove otherwise. Nothing here can be
    // hurried: the client's own response timeout is what turns an
    // unanswered request into a terminal one.
    const shell = await motorsScreen({silentCommands: [MSP_SET_MOTOR]});
    shell.toggle('motor-session-toggle', true);
    await settle();
    expectLiveSession();

    shell.toggle('motor-session-toggle', false);
    await settleThroughResponseTimeout();

    const closed = snapshot();
    expect(closed?.phase).toBe('CLOSED');
    expect(closed?.teardown?.complete).toBe(false);
    // The arming restriction is deliberately NOT released: re-permitting
    // arming while an output may be live is strictly worse than leaving a
    // board that cannot arm until it is reconnected.
    expect(closed?.teardown?.armingRestrictionRelease).toBe(
      'WITHHELD_STOP_UNPROVEN',
    );
  });

  it('demands a new connection after a close that did not complete', async () => {
    const shell = await motorsScreen({silentCommands: [MSP_SET_MOTOR]});
    shell.toggle('motor-session-toggle', true);
    await settle();
    shell.toggle('motor-session-toggle', false);
    await settleThroughResponseTimeout();

    // Here the cable instruction is CORRECT: exclusivity and motor state
    // are both unproven, and only a fresh physical session can settle
    // them. Same words, opposite verdict - which is the point.
    expect(shell.text()).toContain(USB_RECONNECT_MESSAGE);
  });

  it('does not build a second controller over an unproven close', async () => {
    const shell = await motorsScreen({silentCommands: [MSP_SET_MOTOR]});
    shell.toggle('motor-session-toggle', true);
    await settle();
    shell.toggle('motor-session-toggle', false);
    await settleThroughResponseTimeout();
    expect(snapshot()?.teardown?.complete).toBe(false);

    // The toggle may still be pressable - the screen explains rather than
    // hides - but the press must not start a session.
    if (shell.toggleIsEnabled('motor-session-toggle')) {
      shell.toggle('motor-session-toggle', true);
      await settle();
    }

    // Still the SAME spent controller: CLOSED, and still carrying the
    // incomplete teardown report a fresh one could not have.
    expect(snapshot()?.phase).toBe('CLOSED');
    expect(snapshot()?.teardown?.complete).toBe(false);
  });

  it('treats a REFUSED all-stop the same as a missing one', async () => {
    // The board answers, but with an MSP error frame. An answer is not an
    // acknowledgement, and this must not read as a completed stop.
    const shell = await motorsScreen({failCommands: [MSP_SET_MOTOR]});
    shell.toggle('motor-session-toggle', true);
    await settle();
    expectLiveSession();

    shell.toggle('motor-session-toggle', false);
    await settle();

    expect(snapshot()?.phase).toBe('CLOSED');
    expect(snapshot()?.teardown?.complete).toBe(false);
  });

  it('does not call a close complete while the acknowledgement is outstanding', async () => {
    // The window BEFORE the timeout, where the stop is neither answered
    // nor abandoned. The session must not present itself as cleanly
    // finished during it.
    const shell = await motorsScreen({silentCommands: [MSP_SET_MOTOR]});
    shell.toggle('motor-session-toggle', true);
    await settle();
    shell.toggle('motor-session-toggle', false);
    await settle(4);

    expect(snapshot()?.teardown?.complete).not.toBe(true);
  });

  it('completes the close when the acknowledgement arrives LATE', async () => {
    // A late ack is not a missing one. The board withholds the all-stop,
    // the teardown waits, and then the answer arrives inside the client's
    // window - at which point this is an ordinary clean close and the
    // operator may open another session.
    const shell = await motorsScreen({silentCommands: [MSP_SET_MOTOR]});
    shell.toggle('motor-session-toggle', true);
    await settle();
    shell.toggle('motor-session-toggle', false);
    await settle(4);
    expect(snapshot()?.teardown?.complete).not.toBe(true);

    await ReactTestRenderer.act(async () => {
      fc.releaseSilence(MSP_SET_MOTOR);
      await Promise.resolve();
    });
    await settle();

    expectCleanlyClosedSession();
    shell.toggle('motor-session-toggle', true);
    await settle();
    expectLiveSession();
  });
});
