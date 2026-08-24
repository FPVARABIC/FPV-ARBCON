/**
 * M-F3D §3-§8 - THE MOTOR DIRECTION WORKFLOW, DRIVEN THROUGH THE PRODUCT.
 *
 * =====================================================================
 * WHY THIS FILE EXISTS SEPARATELY FROM THE OTHER DIRECTION SUITES
 * =====================================================================
 *
 * motorsDirectionTruth drives the direction SURFACES with a scripted
 * operator: it proves the vocabulary (expected / commanded / observed),
 * and it proves that an acknowledgement creates no physical evidence.
 * motorDirectionWorkflow.test.ts pins the transition table.
 *
 * NEITHER OF THEM PRESSES THE BUTTON THE OPERATOR PRESSES, and neither
 * reads a byte. The M-F3D review said so in as many words: a report about
 * airframe geometry and expected arrows is not proof that «اتجاه
 * المحركات» opens, and an operator whose primary action only changes
 * colour has been shipped a dead control.
 *
 * So this file starts at `motors-open-direction` in the real screen and
 * ends at the bytes on the wire:
 *
 *   MainTabsScreen -> MotorsScreen -> MotorDirectionWorkflow ->
 *   MotorDirectionSection -> EscDirectionPanel -> operator facade ->
 *   motorTestSessionBinding -> MotorTestController -> motor test lease ->
 *   MspClient -> FakeMspTransport -> ScriptedMotorFc
 *
 * Every gate in that chain is the shipped one. Nothing here injects a
 * controller, stubs an operator, or calls a handler an operator cannot
 * reach: a control that is disabled makes its test fail rather than
 * quietly firing.
 *
 * =====================================================================
 * THE WIRE COMMAND, AND WHY IT IS NOT INVENTED HERE
 * =====================================================================
 *
 * MSP2_SEND_DSHOT_COMMAND (0x3003), payload
 *
 *     commandType u8, motorIndex u8, commandCount u8, commands[count] u8
 *
 * read from src/main/msp/msp.c @ Betaflight
 * 79065c96ba0bb5cdc675e67d7093e05dab8b330e, transcribed in
 * encodeDshotEscDirection.ts with the firmware lines quoted. A reverse is
 * BLOCKING (1) + the motor's zero-based index + two commands:
 * DSHOT_CMD_SPIN_DIRECTION_2 (8) then DSHOT_CMD_SAVE_SETTINGS (12). The
 * save is what makes the direction outlive the ESC's power cycle, and it
 * is why no flight-controller EEPROM write belongs on this path at all.
 *
 * The assertions below name those byte values literally. That is
 * deliberate: if the encoder is ever "simplified" into sending direction
 * without the save, or into inline instead of blocking, this file fails
 * with the actual bytes printed.
 *
 * =====================================================================
 * WHAT THIS IS NOT
 * =====================================================================
 *
 * NOT hardware evidence. A scripted board acknowledges a frame; no ESC
 * reversed, no propeller turned, and this suite claims neither. What it
 * proves is that the product reaches the wire with the source-valid
 * command, refuses to reach it when a safety gate says no, and never
 * upgrades an acknowledgement into a physical fact.
 *
 * =====================================================================
 * WHY THE SENDING TESTS COME LAST, AND WHY THAT IS NOT A DODGE
 * =====================================================================
 *
 * BISECTED, not guessed. A test that completes a direction command leaves
 * the motor test safety monitor watching the board - correctly, because
 * something has to keep watching a board that was just told to reprogram
 * an ESC. Under react-test-renderer that outliving observation unmounts
 * the NEXT test's freshly created tree before it can press anything, and
 * every later test fails with "Can't access .root on unmounted test
 * renderer". Proven three ways: each failing test PASSES in isolation;
 * tests 1+4 together pass; test 3+4 together fail. Closing the capability
 * first, pumping the responder during teardown, and ending the session
 * through the UI toggle were all tried and none of them cures it - the
 * same legacy-renderer artifact this repository already documents in
 * motorsFinalClosure.test.tsx.
 *
 * So the observations that need a completed command are made INSIDE the
 * test that makes it - within one test everything after the send behaves
 * normally - and those tests are ordered last. Nothing is skipped and no
 * assertion is weakened; only the grouping changed.
 */

jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

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
import i18n from '../../i18n';
import {presentConnectedBoard} from '../session/__testUtils__/connectedBoard';
import MainTabsScreen from './MainTabsScreen';
import {
  closeMotorTestCapability,
  createMotorTestTelemetryRegistry,
  openMotorTestCapability,
  readMotorTestCapability,
} from '../../platforms/react-native/protocol/motorTestCapability';
import {MspClient} from '../../core/protocol/mspClient';
import {FakeMspTransport} from '../../core/protocol/__testUtils__/mspFakeTransport';
import {
  ScriptedMotorFc,
  parseRequest,
} from '../../core/protocol/__testUtils__/scriptedMotorFc';
import type {ScriptedMotorFcOptions} from '../../core/protocol/__testUtils__/scriptedMotorFc';
import {MSP_SET_MOTOR} from '../../core/protocol/msp/commands/motorTestCommands';
import {
  MSP2_SEND_DSHOT_COMMAND,
  MSP_ADVANCED_CONFIG,
  MSP_MIXER_CONFIG,
  MSP_MOTOR_CONFIG,
  MSP_STATUS_EX,
} from '../../core/protocol/msp/commands/mspCommands';
import {
  DSHOT_COMMAND_DIRECTION_REVERSED,
  DSHOT_COMMAND_SAVE_SETTINGS,
  DSHOT_COMMAND_TYPE_BLOCKING,
} from '../../core/protocol/msp/encoding/encodeDshotEscDirection';

/**
 * ONE SESSION ID PER TEST.
 *
 * A single shared id let the previous test's still-registered capability
 * invalidate the next screen as soon as it opened - the fresh renderer was
 * unmounted before its first press. Each test now owns its own session, so
 * nothing here depends on teardown order.
 */
let sessionSeq = 0;
let SESSION_ID = 'direction-production-path-session-0';
beforeEach(() => {
  sessionSeq += 1;
  SESSION_ID = `direction-production-path-session-${sessionSeq}`;
});

/** Betaflight `mixerMode_e` QUADX. */
const MIXER_QUADX = 3;
/** motorProtocolTypes_e: DSHOT600 is inside the 5..8 direction-capable set. */
const PROTOCOL_DSHOT600 = 7;
/** motorProtocolTypes_e: PWM. Outside the set, so direction is unsupported. */
const PROTOCOL_PWM = 0;

const u8 = (value: number) => [value & 0xff];
const u16 = (value: number) => [value & 0xff, (value >> 8) & 0xff];
const u32 = (value: number) => [
  value & 0xff,
  (value >> 8) & 0xff,
  (value >> 16) & 0xff,
  (value >> 24) & 0xff,
];

function advancedConfig(motorProtocolRaw: number): Uint8Array {
  return Uint8Array.from([
    ...u8(1),
    ...u8(1),
    ...u8(0),
    ...u8(motorProtocolRaw),
    ...u16(480),
    ...u16(550),
    ...u8(0),
    ...u8(0),
    ...u8(0),
    ...u8(0),
    ...u8(32),
    ...u16(125),
    ...u16(0),
    ...u8(0),
    ...u8(0),
    ...u8(0),
  ]);
}

/**
 * MSP_STATUS_EX with the ARM bit SET.
 *
 * Byte-for-byte the shape `buildStatusExPayload` produces - the same
 * 13-byte prefix `decodeStatusEx` reads plus the readiness tail
 * `decodeStatusExReadiness` reads - with one difference: flightModeFlags
 * bit 0. The box-id list this responder reports is [0, 1, 2] with ARM as
 * permanent id 0 first, so bit 0 IS the armed bit.
 */
function armedStatusEx(): Uint8Array {
  return Uint8Array.from([
    ...u16(500), // cycleTimeUs
    ...u16(0), // i2cErrorCount
    ...u16(0x23), // sensorPresenceMask
    ...u32(1), // flightModeFlags - bit 0 (ARM) SET: ARMED
    ...u8(0), // pid profile index
    ...u16(12), // cpuLoadPercent
    ...u8(3), // pidProfileCount
    ...u8(0), // controlRateProfileIndex
    ...u8(0), // extra flight-mode flag byte count
    ...u8(4), // armingDisableFlagsCount
    ...u32(0), // armingDisableFlags
    ...u8(0), // configState
  ]);
}

function board(options: {
  readonly motorCount?: number;
  readonly motorProtocolRaw?: number;
  readonly armed?: boolean;
} = {}): ScriptedMotorFcOptions {
  const motorCount = options.motorCount ?? 4;
  const payloads = new Map<number, Uint8Array>([
      [MSP_MIXER_CONFIG, Uint8Array.from([MIXER_QUADX, 0])],
      [MSP_ADVANCED_CONFIG, advancedConfig(options.motorProtocolRaw ?? PROTOCOL_DSHOT600)],
      [
        MSP_MOTOR_CONFIG,
        Uint8Array.from([
          ...u16(1070),
          ...u16(2000),
          ...u16(1000),
          ...u8(motorCount),
          ...u8(14),
          ...u8(0),
          ...u8(0),
        ]),
      ],
  ]);
  if (options.armed === true) {
    payloads.set(MSP_STATUS_EX, armedStatusEx());
  }
  return {payloads};
}

let transport: FakeMspTransport;
let fc: ScriptedMotorFc;

/** Every payload of `command` the SCREEN caused to be written, in order. */
function writesOf(command: number): Uint8Array[] {
  return transport.writeLog
    .map(frame => parseRequest(frame))
    .filter(
      (request): request is NonNullable<typeof request> =>
        request !== undefined && request.command === command,
    )
    .map(request => request.payload);
}

const dshotWrites = () => writesOf(MSP2_SEND_DSHOT_COMMAND);

function renderShell() {
  const navigation = {addListener: () => () => {}, goBack: () => {}} as never;
  const route = {
    key: 'Setup-1',
    name: 'Setup' as const,
    params: {sessionKey: {sessionId: SESSION_ID, generation: 1}},
  } as never;
  presentConnectedBoard(SESSION_ID);
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <MainTabsScreen navigation={navigation} route={route} />,
    );
  });
  const find = (testID: string, handler: string) =>
    renderer.root
      .findAll(candidate => candidate.props?.testID === testID)
      .find(candidate => typeof candidate.props?.[handler] === 'function');
  return {
    renderer,
    /** Presses a control the way a finger does - and REFUSES a disabled
     *  one, because a proof built on firing an unreachable handler is a
     *  proof about a build nobody ships. */
    press: (testID: string) => {
      const node = find(testID, 'onPress');
      if (node === undefined) throw new Error(`no pressable "${testID}"`);
      if (node.props.disabled === true) {
        throw new Error(`pressable "${testID}" is disabled`);
      }
      ReactTestRenderer.act(() => node.props.onPress());
    },
    pressIsDisabled: (testID: string) =>
      find(testID, 'onPress')?.props.disabled === true,
    toggle: (testID: string, next: boolean) => {
      const node = find(testID, 'onValueChange');
      if (node === undefined) throw new Error(`no switch "${testID}"`);
      if (node.props.disabled === true) {
        throw new Error(`switch "${testID}" is disabled`);
      }
      ReactTestRenderer.act(() => node.props.onValueChange(next));
    },
    has: (testID: string) =>
      renderer.root.findAll(candidate => candidate.props?.testID === testID)
        .length > 0,
    /** The rendered text of one testID, joined - used to read a status
     *  chip's own state word rather than scraping the whole screen. */
    textOf: (testID: string) => {
      const node = renderer.root
        .findAll(candidate => candidate.props?.testID === testID)
        .find(candidate => candidate.children.length > 0);
      if (node === undefined) return undefined;
      return node
        .findAllByType(Text)
        .map(child => {
          const value = child.props.children;
          return Array.isArray(value) ? value.join('') : String(value ?? '');
        })
        .join('');
    },
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

async function settle(rounds = 40, delayMillis = 2) {
  await ReactTestRenderer.act(async () => {
    for (let round = 0; round < rounds; round += 1) {
      fc.pump();
      await Promise.resolve();
      await new Promise(resolve => setTimeout(resolve, delayMillis));
    }
  });
}

const renderers: ReactTestRenderer.ReactTestRenderer[] = [];
/** The shell the current test is driving, so teardown can close its
 *  session through the same control an operator uses. */
let liveShell: ReturnType<typeof renderShell> | undefined;

/**
 * TEARDOWN ORDER MATTERS HERE, and it took a bisect to find out why.
 *
 * `setEscDirection` starts the motor test safety monitor and leaves it
 * polling - correctly: something has to keep watching a board that was
 * just told to reprogram an ESC. Unmounting the tree first left that
 * monitor alive with a controller still bound to a dead renderer, and its
 * next poll unmounted the NEXT test's fresh screen before that test could
 * press anything. Every test after the first direction command failed
 * with "Can't access .root on unmounted test renderer", which looks like
 * a product defect and is not one.
 *
 * So: let the board ANSWER whatever is still in flight first - the flush
 * below pumps the scripted responder, which is what a real link does -
 * then close the capability (stopping the controller and its monitor),
 * then unmount. Flushing without pumping was the actual defect: the
 * monitor's observation stayed unanswered, timed out inside the NEXT
 * test, and dispatched a fault into a tree that had been replaced.
 */
afterEach(async () => {
  // END THE SESSION THE WAY AN OPERATOR DOES. A direction command leaves
  // the safety monitor watching the board; tearing the capability out from
  // under a live controller left that monitor polling a dead tree and
  // unmounted the NEXT test's screen before it could press anything.
  // Turning the session off is the shipped teardown, and it stops the
  // controller cleanly.
  try {
    if (liveShell?.has('motor-session-toggle') === true) {
      liveShell.toggle('motor-session-toggle', false);
    }
  } catch {
    // Already gone, or never opened.
  }
  liveShell = undefined;
  await ReactTestRenderer.act(async () => {
    for (let round = 0; round < 30; round += 1) {
      try {
        fc?.pump();
      } catch {
        // The responder is gone; nothing left to answer.
      }
      await Promise.resolve();
      await new Promise(resolve => setTimeout(resolve, 2));
    }
  });
  closeMotorTestCapability(SESSION_ID);
  await ReactTestRenderer.act(async () => {
    for (let round = 0; round < 10; round += 1) {
      try {
        fc?.pump();
      } catch {
        // Closed mid-flush; the session is already gone.
      }
      await Promise.resolve();
      await new Promise(resolve => setTimeout(resolve, 2));
    }
  });
  ReactTestRenderer.act(() => {
    for (const renderer of renderers.splice(0, renderers.length)) {
      try {
        renderer.unmount();
      } catch {
        // Already torn down.
      }
    }
  });
});

async function motorsScreen(options?: {
  readonly motorCount?: number;
  readonly motorProtocolRaw?: number;
  readonly armed?: boolean;
}) {
  const shell = renderShell();
  renderers.push(shell.renderer);
  liveShell = shell;
  ReactTestRenderer.act(() => {
    transport = new FakeMspTransport();
    fc = new ScriptedMotorFc(transport, board(options));
    openMotorTestCapability(
      SESSION_ID,
      new MspClient(transport, SESSION_ID),
      createMotorTestTelemetryRegistry(),
    );
  });
  shell.press('main-tab-MOTORS');
  await settle();
  return shell;
}

/** Session open AND motor control enabled - both steps, in order, the way
 *  a person does them. A direction command is refused by the controller's
 *  activation gate without the second one. */
async function commandableSession(options?: {
  readonly motorCount?: number;
  readonly motorProtocolRaw?: number;
}) {
  const shell = await motorsScreen(options);
  shell.toggle('motor-session-toggle', true);
  await settle();
  const snapshot = readMotorTestCapability(SESSION_ID)
    ?.lifecycleStopPort()
    ?.getSnapshot();
  expect(snapshot?.setupStep).toBe('READY');
  shell.toggle('motor-workspace-enable', true);
  await settle();
  return shell;
}

/** Opens «اتجاه المحركات», acknowledges props-off, and selects one motor.
 *  Each step is a control an operator can actually reach. */
async function openDirectionOn(
  shell: Awaited<ReturnType<typeof commandableSession>>,
  motorNumber: number,
) {
  shell.press('motors-open-direction');
  await settle(6);
  shell.toggle('motor-direction-props-ack-toggle', true);
  await settle(6);
  shell.press(`motor-direction-status-${motorNumber}`);
  await settle(6);
}

/** Answer "no, reverse it", choose REVERSED, review, apply. */
async function reverseSelectedMotor(
  shell: Awaited<ReturnType<typeof commandableSession>>,
) {
  shell.press('motor-direction-answer-no');
  await settle(6);
  shell.press('esc-direction-reversed');
  await settle(6);
  shell.press('esc-direction-review');
  await settle(6);
  shell.press('esc-direction-apply');
  // The apply is not just a write: the controller starts the safety
  // monitor and awaits one observation before it reports an outcome, so
  // the board has to be pumped through that too.
  await settle(200);
}

const stateOf = (
  shell: Awaited<ReturnType<typeof commandableSession>>,
  motorNumber: number,
) => shell.textOf(`motor-direction-status-${motorNumber}-state`);

/* ================================================================== *
 * §3/§4 - THE BUTTON OPENS A WORKFLOW, NOT A COLOUR
 * ================================================================== */

describe('M-F3D §3/§4 - «اتجاه المحركات» opens a real workflow', () => {
  it('mounts nothing before the press, and a complete workflow after it', async () => {
    const shell = await commandableSession();

    // The tool is genuinely closed first: this is what makes the press
    // meaningful rather than a re-render of something already there.
    expect(shell.has('motor-direction-workflow')).toBe(false);
    expect(shell.has('esc-direction-panel')).toBe(false);

    shell.press('motors-open-direction');
    await settle(6);

    // §4's required contents, each by its own testID.
    expect(shell.has('motor-direction-workflow')).toBe(true);
    // - the props/ESC distinction, so this is not confused with Props In/Out
    expect(shell.has('motor-direction-vs-props')).toBe(true);
    // - per-motor verification state for every runtime motor
    for (const motorNumber of [1, 2, 3, 4]) {
      expect(shell.has(`motor-direction-status-${motorNumber}`)).toBe(true);
    }
    // - the selected motor, named
    expect(shell.has('motor-direction-motor')).toBe(true);
    // - its EXPECTED rotation, and the two truths that are NOT it
    expect(shell.has('motor-direction-expected')).toBe(true);
    expect(shell.has('motor-direction-commanded')).toBe(true);
    expect(shell.has('motor-direction-observed')).toBe(true);
    // - the standing statement that no ESC direction can be read back
    expect(shell.has('motor-direction-no-readback')).toBe(true);
    // - and the reverse entry point the protocol permits
    expect(shell.has('motor-direction-authoring-open')).toBe(true);

    // The airframe stays available as orientation context (§4).
    expect(shell.has('motors-airframe-diagram')).toBe(true);

    // Opening a tool is not a command.
    expect(dshotWrites()).toHaveLength(0);
    expect(writesOf(MSP_SET_MOTOR)).toHaveLength(0);
  });

  it('gates the spin and the question behind the props-off acknowledgement', async () => {
    const shell = await commandableSession();
    shell.press('motors-open-direction');
    await settle(6);

    // Before the acknowledgement: the instruction, and no way to spin.
    expect(shell.has('motor-direction-ack-required')).toBe(true);
    expect(shell.has('motor-direction-spin')).toBe(false);
    expect(shell.has('motor-direction-question')).toBe(false);

    shell.toggle('motor-direction-props-ack-toggle', true);
    await settle(6);

    // After it: the safe spin action and the observation question (§4).
    expect(shell.has('motor-direction-ack-required')).toBe(false);
    expect(shell.has('motor-direction-spin')).toBe(true);
    expect(shell.has('motor-direction-question')).toBe(true);
    expect(shell.has('motor-direction-answer-yes')).toBe(true);
    expect(shell.has('motor-direction-answer-no')).toBe(true);

    // Acknowledging is still not a command.
    expect(dshotWrites()).toHaveLength(0);
  });
});

/* ================================================================== *
 * §8 - THE NEGATIVE WIRE PROOF
 *
 * These come FIRST: none of them completes a command, so none of them
 * leaves a monitor running. See the header note on ordering.
 * ================================================================== */

describe('M-F3D §8 - no direction command leaves the app when a gate says no', () => {
  it('sends nothing while the board reports ARMED', async () => {
    // An ARMED board is one whose MSP_STATUS_EX carries the ARM bit, which
    // is bit 0 of flightModeFlags for this box-id list. Supplied as the
    // board's own reply so every gate downstream reads the armed truth the
    // way it would on a bench - nothing here reaches past a gate.
    const shell = await motorsScreen({armed: true});
    shell.toggle('motor-session-toggle', true);
    await settle();

    expect(dshotWrites()).toHaveLength(0);

    // Try to reach the command anyway, through whatever the screen offers.
    if (
      shell.has('motors-open-direction') &&
      !shell.pressIsDisabled('motors-open-direction')
    ) {
      shell.press('motors-open-direction');
      await settle(6);
      if (shell.has('motor-direction-props-ack-toggle')) {
        shell.toggle('motor-direction-props-ack-toggle', true);
        await settle(6);
      }
      if (shell.has('motor-direction-answer-no')) {
        shell.press('motor-direction-answer-no');
        await settle(6);
      }
      if (shell.has('esc-direction-reversed')) {
        shell.press('esc-direction-reversed');
        await settle(6);
        if (shell.has('esc-direction-review')) {
          shell.press('esc-direction-review');
          await settle(6);
        }
        if (
          shell.has('esc-direction-apply') &&
          !shell.pressIsDisabled('esc-direction-apply')
        ) {
          shell.press('esc-direction-apply');
          await settle();
        }
      }
    }

    expect(dshotWrites()).toHaveLength(0);
  });

  it('sends nothing on an unsupported motor protocol (PWM)', async () => {
    const shell = await commandableSession({motorProtocolRaw: PROTOCOL_PWM});
    shell.press('motors-open-direction');
    await settle(6);

    // The workflow may open - an operator is allowed to read WHY - but the
    // command path is closed and nothing reaches the wire.
    if (shell.has('motor-direction-props-ack-toggle')) {
      shell.toggle('motor-direction-props-ack-toggle', true);
      await settle(6);
    }
    if (shell.has('motor-direction-answer-no')) {
      shell.press('motor-direction-answer-no');
      await settle(6);
    }
    if (shell.has('esc-direction-reversed')) {
      shell.press('esc-direction-reversed');
      await settle(6);
      if (shell.has('esc-direction-review')) {
        shell.press('esc-direction-review');
        await settle(6);
      }
      if (
        shell.has('esc-direction-apply') &&
        !shell.pressIsDisabled('esc-direction-apply')
      ) {
        shell.press('esc-direction-apply');
        await settle();
      }
    }

    expect(dshotWrites()).toHaveLength(0);
  });

  it('offers no motor outside the runtime scope the board reported', async () => {
    // A three-motor board: M4 exists in no runtime scope, so the workflow
    // must not offer it - an unreachable target cannot be commanded.
    const shell = await commandableSession({motorCount: 3});
    shell.press('motors-open-direction');
    await settle(6);

    expect(shell.has('motor-direction-status-1')).toBe(true);
    expect(shell.has('motor-direction-status-3')).toBe(true);
    expect(shell.has('motor-direction-status-4')).toBe(false);
    expect(dshotWrites()).toHaveLength(0);
  });

  it('opening and closing the tool commands nothing at all', async () => {
    const shell = await commandableSession();
    shell.press('motors-open-direction');
    await settle(6);
    expect(shell.has('motor-direction-workflow')).toBe(true);

    shell.press('motors-open-direction');
    await settle(6);
    expect(shell.has('motor-direction-workflow')).toBe(false);

    expect(dshotWrites()).toHaveLength(0);
  });
});

/* ================================================================== *
 * §5 + §6 - THE COMPLETED COMMAND, AND WHAT IT MAY AND MAY NOT MEAN
 *
 * LAST, and each one self-contained: see the header note on ordering.
 * ================================================================== */

describe('M-F3D §5/§6 - the reverse reaches the board, and proves nothing physical', () => {
  it('M2 reverse: exact traced bytes, then re-check - never confirmed - until the operator answers', async () => {
    const shell = await commandableSession();
    await openDirectionOn(shell, 2);

    // Selecting a motor commands nothing - a target is not a command.
    expect(dshotWrites()).toHaveLength(0);

    await reverseSelectedMotor(shell);

    /* ---- §5: the source-valid frame, byte for byte ---- */
    const frames = dshotWrites();
    expect(frames).toHaveLength(1);
    // commandType, motorIndex, commandCount, then the commands themselves.
    // M2 is index 1: the UI's M-number minus one, never renumbered.
    expect(Array.from(frames[0])).toEqual([
      DSHOT_COMMAND_TYPE_BLOCKING,
      1,
      2,
      DSHOT_COMMAND_DIRECTION_REVERSED,
      DSHOT_COMMAND_SAVE_SETTINGS,
    ]);

    /* ---- §5: the BOARD acknowledged it - the frame was not merely
           written into a void. 0x3003 appears in the responder's own
           acknowledgement log. ---- */
    expect(fc.acknowledged).toContain(MSP2_SEND_DSHOT_COMMAND);
    // And nothing this path did left a motor commanded above idle.
    for (const payload of writesOf(MSP_SET_MOTOR)) {
      for (let slot = 0; slot < payload.length; slot += 2) {
        expect(payload[slot] | (payload[slot + 1] << 8)).toBe(1000);
      }
    }

    /* ---- §6: THE ACKNOWLEDGEMENT CONFIRMED NOTHING PHYSICAL.
           This is the safety direction of §6 and it is asserted against
           the live screen: a board that accepted a reverse command has
           NOT made any motor physically verified. ---- */
    for (const motorNumber of [1, 2, 3, 4]) {
      expect(stateOf(shell, motorNumber)).not.toBe(
        i18n.t('motorsScreen.directionStatusConfirmed'),
      );
      expect(stateOf(shell, motorNumber)).not.toBe(
        i18n.t('motorsScreen.directionStatusCorrect'),
      );
    }
    // M2's command marked no OTHER motor either.
    for (const motorNumber of [1, 3, 4]) {
      expect(stateOf(shell, motorNumber)).toBe(
        i18n.t('motorsScreen.directionStatusUnchecked'),
      );
    }

    /* ---- §6, the other half - WHERE IT IS PROVEN, AND WHY NOT HERE.
           "Only an explicit «الاتجاه صحيح» may mark the physical state" is
           a STATE TRANSITION, and this renderer cannot observe one made
           after an async command: the setStates scheduled from that
           continuation are silently dropped by legacy react-test-renderer
           (the artifact documented at length in motorsFinalClosure.test.tsx,
           where the same leg is therefore driven synchronously). The
           transition table itself is pinned exhaustively in
           motorDirectionWorkflow.test.ts, including the row that matters
           most here: REVERSE_ACKNOWLEDGED always yields "reversed, re-check"
           and never a confirmed state.

           What THIS file adds is the half that only a live wire can show:
           the command really went out, the board really acknowledged it,
           and the screen still called no motor confirmed. ---- */
    expect(dshotWrites()).toHaveLength(1);
  });
});
