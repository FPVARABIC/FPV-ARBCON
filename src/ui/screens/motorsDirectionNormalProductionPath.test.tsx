/**
 * M-F3D §5 - A NORMAL-DIRECTION COMMAND ON A DIFFERENT MOTOR.
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
import {
  MSP2_SEND_DSHOT_COMMAND,
  MSP_ADVANCED_CONFIG,
  MSP_MIXER_CONFIG,
  MSP_MOTOR_CONFIG,
  MSP_STATUS_EX,
} from '../../core/protocol/msp/commands/mspCommands';
import {
  DSHOT_COMMAND_DIRECTION_NORMAL,
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
let SESSION_ID = 'direction-normal-production-path-session-0';
beforeEach(() => {
  sessionSeq += 1;
  SESSION_ID = `direction-normal-production-path-session-${sessionSeq}`;
});

/** Betaflight `mixerMode_e` QUADX. */
const MIXER_QUADX = 3;
/** motorProtocolTypes_e: DSHOT600 is inside the 5..8 direction-capable set. */
const PROTOCOL_DSHOT600 = 7;

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

const stateOf = (
  shell: Awaited<ReturnType<typeof commandableSession>>,
  motorNumber: number,
) => shell.textOf(`motor-direction-status-${motorNumber}-state`);

/* ================================================================== *
 * §5 - THE OTHER DIRECTION, AND A DIFFERENT MOTOR
 *
 * ONE COMPLETED COMMAND PER FILE. A test that finishes a direction
 * command leaves the motor test safety monitor watching the board, and
 * under react-test-renderer that outliving observation unmounts the next
 * test's freshly created tree - bisected and documented at length in
 * motorsDirectionProductionPath.test.tsx. This variant therefore gets its
 * own file rather than being dropped: the reverse case proves the command
 * reaches the board, and this one proves the OTHER direction and a
 * DIFFERENT motor are not hard-coded anywhere on that path.
 * ================================================================== */

describe('M-F3D §5 - a NORMAL direction command, on M4', () => {
  it('addresses the selected motor with SPIN_DIRECTION_1 and the in-ESC save', async () => {
    const shell = await commandableSession();
    await openDirectionOn(shell, 4);
    expect(dshotWrites()).toHaveLength(0);

    shell.press('motor-direction-answer-no');
    await settle(6);
    shell.press('esc-direction-normal');
    await settle(6);
    shell.press('esc-direction-review');
    await settle(6);
    shell.press('esc-direction-apply');
    await settle(200);

    const frames = dshotWrites();
    expect(frames).toHaveLength(1);
    // M4 -> zero-based index 3, the NORMAL command, and still the in-ESC
    // save that makes the setting outlive the ESC's power cycle.
    expect(Array.from(frames[0])).toEqual([
      DSHOT_COMMAND_TYPE_BLOCKING,
      3,
      2,
      DSHOT_COMMAND_DIRECTION_NORMAL,
      DSHOT_COMMAND_SAVE_SETTINGS,
    ]);
    expect(fc.acknowledged).toContain(MSP2_SEND_DSHOT_COMMAND);

    // And an acknowledged command still confirmed nothing physical.
    for (const motorNumber of [1, 2, 3, 4]) {
      expect(stateOf(shell, motorNumber)).not.toBe(
        i18n.t('motorsScreen.directionStatusConfirmed'),
      );
    }
  });
});
