/**
 * M-D §45 - THE PICTURE AND THE WORDS MUST AGREE. THROUGH THE REAL SCREEN.
 *
 * WHAT THE VISUAL INSPECTION FOUND. M-D3 made the DRAWING airframe-aware:
 * `MotorAirframeDiagram` asks `authoredAirframeLayout(mixerModeRaw,
 * motorNumbers)` and falls back to a numbered list when this project has
 * authored no artwork for that mixer. The PHYSICAL IDENTITY CLAIMS beside
 * it did not move. `evaluateMotorIdentificationCapability` still answered
 * one question - "is the reported count four?" - and `expectedFor()` still
 * read the hard-coded Quad X table. So on the production path:
 *
 *   QUADX_1234 (mixer 26, four motors). The drawing places M1 FRONT LEFT,
 *   which is what `mixer_init.c` says. The identity line one region above
 *   it said M1 is REAR RIGHT, which is what Quad X says. THE SAME SCREEN
 *   CONTRADICTED ITSELF ABOUT THE SAME MOTOR - and an operator following
 *   the words would have reached for the wrong arm.
 *
 *   VTAIL4 (mixer 17, four motors). No authored artwork, so the drawing
 *   correctly refused to place anything. The identity line above it
 *   nevertheless offered a Quad X position and a Quad X rotation for the
 *   selected motor, with an EXPECTED badge beside it.
 *
 * Four motors is not four corners. QUADP, Y4, VTAIL4 and ATAIL4 all report
 * four and are not X frames, and QUADX_1234 is an X frame whose motor 1
 * sits where the Quad X drawing puts motor 4. The count was never the
 * question.
 *
 * WHY THIS FILE DRIVES THE WHOLE PATH. The defect is invisible in a unit
 * test of either module: the capability evaluator is correct about counts
 * and the layout table is correct about mixers. It only appears when the
 * screen renders both from one snapshot. So this file runs MainTabsScreen,
 * the real capability registry, the real binding, the real
 * MotorTestController and the real MspClient over a scripted board, and
 * reads what a person would read.
 *
 * NO NEW TRUTH IS INVENTED HERE. The fix routes the identity claim through
 * the SAME authored layout the drawing already uses - one owner, not two -
 * and the rotation reference stays the position-derived props-out
 * convention this app has always labelled EXPECTED rather than measured.
 * Where there is no authored layout there is no claim.
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
import ar from '../../i18n/locales/ar.json';
import {presentConnectedBoard} from '../session/__testUtils__/connectedBoard';
import MainTabsScreen from './MainTabsScreen';
import {
  closeMotorTestCapability,
  createMotorTestTelemetryRegistry,
  openMotorTestCapability,
} from '../../platforms/react-native/protocol/motorTestCapability';
import {MspClient} from '../../core/protocol/mspClient';
import {FakeMspTransport} from '../../core/protocol/__testUtils__/mspFakeTransport';
import {ScriptedMotorFc} from '../../core/protocol/__testUtils__/scriptedMotorFc';
import type {ScriptedMotorFcOptions} from '../../core/protocol/__testUtils__/scriptedMotorFc';
import {
  MSP_MIXER_CONFIG,
  MSP_MOTOR_CONFIG,
} from '../../core/protocol/msp/commands/mspCommands';

const SESSION_ID = 'airframe-identity-session';

/** Betaflight `mixerMode_e`, from the pinned firmware's mixer.h. */
const MIXER_QUADX = 3;
const MIXER_QUADX_1234 = 26;
const MIXER_VTAIL4 = 17;
const MIXER_HEX6X = 10;

const u16 = (value: number) => [value & 0xff, (value >> 8) & 0xff];

/**
 * A board that reports a given airframe and a given motor count, with
 * every other reply left exactly as the shared script has it.
 */
function board(mixerMode: number, motorCount: number): ScriptedMotorFcOptions {
  return {
    payloads: new Map<number, Uint8Array>([
      [MSP_MIXER_CONFIG, Uint8Array.from([mixerMode, 0])],
      [
        MSP_MOTOR_CONFIG,
        Uint8Array.from([
          ...u16(1070), // deprecatedMinThrottle
          ...u16(2000), // maxThrottle
          ...u16(1000), // minCommand
          motorCount,
          14, // motorPoleCount
          0, // dshotTelemetryRaw
          0, // escSensorRaw
        ]),
      ],
    ]),
  };
}

let transport: FakeMspTransport;
let fc: ScriptedMotorFc;

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
    textOf: (testID: string): string | undefined => {
      const node = renderer.root
        .findAll(candidate => candidate.props?.testID === testID)
        .find(candidate => candidate.type === Text);
      if (node === undefined) return undefined;
      const value = node.props.children;
      return Array.isArray(value) ? value.join('') : String(value ?? '');
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

/** A live motor session on a board reporting the given airframe. */
async function liveMotorsScreen(mixerMode: number, motorCount: number) {
  const shell = renderShell();
  renderers.push(shell.renderer);
  ReactTestRenderer.act(() => {
    transport = new FakeMspTransport();
    fc = new ScriptedMotorFc(transport, board(mixerMode, motorCount));
    openMotorTestCapability(
      SESSION_ID,
      new MspClient(transport, SESSION_ID),
      createMotorTestTelemetryRegistry(),
    );
  });
  shell.press('main-tab-MOTORS');
  await settle();
  shell.toggle('motor-session-toggle', true);
  await settle();
  return shell;
}

/**
 * Which corner the DRAWING put a motor in, read off the rendered tree the
 * way a person reads it off the screen: the cell test id names the
 * position, and the slot label sits inside that cell.
 */
function drawnPositionOf(
  shell: ReturnType<typeof renderShell>,
  slot: number,
): string | undefined {
  const positions = ['FRONT-LEFT', 'FRONT-RIGHT', 'REAR-LEFT', 'REAR-RIGHT'];
  for (const position of positions) {
    const cells = shell.renderer.root.findAll(
      candidate => candidate.props?.testID === `motors-diagram-cell-${position}`,
    );
    for (const cell of cells) {
      const found = cell.findAll(
        candidate =>
          candidate.props?.testID === `motors-diagram-slot-${slot}`,
      );
      if (found.length > 0) return position;
    }
  }
  return undefined;
}

const POSITION_TEXT: Record<string, string> = {
  'FRONT-LEFT': ar.motorsScreen.positionFrontLeft,
  'FRONT-RIGHT': ar.motorsScreen.positionFrontRight,
  'REAR-LEFT': ar.motorsScreen.positionRearLeft,
  'REAR-RIGHT': ar.motorsScreen.positionRearRight,
};

describe('QUADX_1234 - the drawing and the identity line describe the same motor', () => {
  it('draws M1 front left, because that is what the firmware mixer table says', async () => {
    const shell = await liveMotorsScreen(MIXER_QUADX_1234, 4);
    // The precondition: this airframe HAS authored artwork, so the aircraft
    // is drawn rather than falling back to a numbered list. Without this
    // the next assertion could pass vacuously.
    expect(shell.has('motors-airframe-diagram')).toBe(true);
    expect(drawnPositionOf(shell, 1)).toBe('FRONT-LEFT');
  });

  it('does not tell the operator M1 is on the opposite corner', async () => {
    const shell = await liveMotorsScreen(MIXER_QUADX_1234, 4);
    const drawn = drawnPositionOf(shell, 1);
    expect(drawn).toBeDefined();

    // Motor 1 is the screen's initial selection, so this is the claim an
    // operator sees without touching anything.
    const claimed = shell.textOf('motor-identity-expected');
    if (claimed !== undefined) {
      expect(claimed).toBe(POSITION_TEXT[drawn as string]);
    }
    // And whatever it says, it must not say the Quad X answer for a frame
    // that is not Quad X.
    expect(claimed).not.toBe(ar.motorsScreen.positionRearRight);
  });
});

describe('VTAIL4 - four motors, and not four corners', () => {
  it('falls back to numbered outputs, because there is no authored V-tail artwork', async () => {
    const shell = await liveMotorsScreen(MIXER_VTAIL4, 4);
    expect(shell.has('motors-generic-outputs')).toBe(true);
    expect(shell.has('motors-airframe-diagram')).toBe(false);
  });

  it('makes no Quad X position claim beside a drawing that refused to make one', async () => {
    const shell = await liveMotorsScreen(MIXER_VTAIL4, 4);
    // The withheld-claim block is the correct answer here, exactly as it
    // already is for a hex.
    expect(shell.has('motors-selected-expected-unavailable')).toBe(true);
    expect(shell.textOf('motor-identity-expected')).toBeUndefined();
    expect(shell.textOf('motor-identity-expected-direction')).toBeUndefined();
  });

  it('does not offer the four-arm verification questions', async () => {
    const shell = await liveMotorsScreen(MIXER_VTAIL4, 4);
    // The wizard asks which arm a motor spun on. On a V-tail those arms do
    // not exist, and an answer would be written into a reorder proposal.
    expect(shell.text()).not.toContain(ar.motorsScreen.positionRearRight);
  });
});

describe('the airframes that were already right stay right', () => {
  it('QUADX still draws M1 rear right and says so', async () => {
    const shell = await liveMotorsScreen(MIXER_QUADX, 4);
    expect(shell.has('motors-airframe-diagram')).toBe(true);
    expect(drawnPositionOf(shell, 1)).toBe('REAR-RIGHT');
    expect(shell.textOf('motor-identity-expected')).toBe(
      ar.motorsScreen.positionRearRight,
    );
  });

  it('HEX6X still withholds every position claim', async () => {
    const shell = await liveMotorsScreen(MIXER_HEX6X, 6);
    expect(shell.has('motors-generic-outputs')).toBe(true);
    expect(shell.has('motors-selected-expected-unavailable')).toBe(true);
    expect(shell.textOf('motor-identity-expected')).toBeUndefined();
  });
});
