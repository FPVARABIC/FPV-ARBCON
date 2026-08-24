/**
 * M-E - WHAT THE OPERATOR MEETS FIRST, THROUGH THE REAL SCREEN.
 *
 * M-E is a UX phase, and its claims are about ORDER and PRESENCE rather
 * than about bytes: which things an operator sees before they have
 * scrolled or opened anything, which single control selects a motor, and
 * how loud the emergency stop is in a state where nothing can move. Those
 * are exactly the claims a component rendered alone cannot make, so every
 * one of them is asserted here through MainTabsScreen, a scripted flight
 * controller and a real MSP_MOTOR_CONFIG count.
 *
 * WHAT IT DELIBERATELY DOES NOT DUPLICATE. The command surface is proved
 * in motorsProductionPathUiMatrix.test.tsx - fixed eight-slot frames,
 * graded activation, the departure stop. Pixel geometry is measured in
 * Chromium by .dev-preview/mescan.mjs, which a jest renderer cannot do.
 * This file sits between them: the composition of the screen.
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

const SESSION_ID = 'motors-ux-hierarchy-session';

/** mixerMode_e, from the pinned firmware's mixer.h. */
const MIXER_TRI = 1;
const MIXER_QUADP = 2;
const MIXER_QUADX = 3;
const MIXER_Y6 = 6;
const MIXER_FLYING_WING = 8;
const MIXER_Y4 = 9;
const MIXER_HEX6X = 10;
const MIXER_OCTOX8 = 11;
const MIXER_AIRPLANE = 14;
const MIXER_HEX6H = 18;
const MIXER_CUSTOM = 23;
const MIXER_QUADX_1234 = 26;
/** Not in mixerMode_e at this pin: an unknown byte, never normalised. */
const MIXER_UNKNOWN = 250;

const u16 = (value: number) => [value & 0xff, (value >> 8) & 0xff];

function board(mixerMode: number, motorCount: number): ScriptedMotorFcOptions {
  return {
    payloads: new Map<number, Uint8Array>([
      [MSP_MIXER_CONFIG, Uint8Array.from([mixerMode, 0])],
      [
        MSP_MOTOR_CONFIG,
        Uint8Array.from([
          ...u16(1070),
          ...u16(2000),
          ...u16(1000),
          motorCount,
          14,
          0,
          0,
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
  const find = (testID: string, handler: string) =>
    renderer.root
      .findAll(candidate => candidate.props?.testID === testID)
      .find(candidate => typeof candidate.props?.[handler] === 'function');
  /** Emission order of every testID on screen: the reading order. */
  const ids = (): readonly string[] =>
    renderer.root
      .findAll(candidate => typeof candidate.props?.testID === 'string')
      .map(candidate => candidate.props.testID as string);
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
      ReactTestRenderer.act(() => node.props.onValueChange(next));
    },
    has: (testID: string) =>
      renderer.root.findAll(candidate => candidate.props?.testID === testID)
        .length > 0,
    at: (testID: string) => ids().indexOf(testID),
    ids,
    styleOf: (testID: string) =>
      renderer.root.findAll(
        candidate =>
          typeof candidate.type === 'string' &&
          candidate.props?.testID === testID,
      )[0]?.props.style,
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

async function motorsScreen(mixerMode: number, motorCount: number) {
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
  return shell;
}

async function liveSession(mixerMode: number, motorCount: number) {
  const shell = await motorsScreen(mixerMode, motorCount);
  shell.toggle('motor-session-toggle', true);
  await settle();
  return shell;
}

/* ================================================================== *
 * §11 / §41 / §57 - WHAT IS ABOVE THE MOTOR TEST CONTROLS
 * ================================================================== */

describe('M-E §11 / §57 - the first viewport is the tool', () => {
  /**
   * THE MEASUREMENT THIS ENFORCES. In Chromium at 390px, before M-E, the
   * first control that starts a motor test sat 1,288px down the page on a
   * Quad X and 1,910px down on an airframe with no drawing - because the
   * airframe column rendered first and carried the whole verification
   * workflow. A jest renderer cannot measure pixels, but it CAN assert
   * the composition that produced them: what stands between the top of
   * the page and the session control, and what does not.
   */
  it.each([
    ['QUADX', MIXER_QUADX, 4],
    ['TRI', MIXER_TRI, 3],
    ['HEX6X', MIXER_HEX6X, 6],
    ['OCTOX8', MIXER_OCTOX8, 8],
    ['UNKNOWN', MIXER_UNKNOWN, 3],
  ])('%s: nothing but the aircraft stands above the session control', async (
    _name,
    mixerMode,
    motorCount,
  ) => {
    // A LIVE session, because the airframe summary states what the flight
    // controller reported and there is nothing to report before the
    // session has read it.
    const shell = await liveSession(mixerMode, motorCount);
    const control = shell.at('motor-session-toggle');
    expect(control).toBeGreaterThan(0);
    // The verification workflow, the direction authoring and the
    // output-order transaction are not merely below it - they are not on
    // the page until the operator asks for them.
    for (const id of [
      'motors-identity-section',
      'verification-wizard',
      'motor-direction-section',
      'motor-output-mapping-section',
      'motors-readiness-blocked-detail',
    ]) {
      expect([id, shell.has(id)]).toEqual([id, false]);
    }
    // What IS above it: the title, the propeller warning, the airframe
    // summary and the aircraft.
    for (const id of [
      'motors-title',
      'motors-propeller-warning',
      'motors-airframe-summary',
      'motors-identity-map',
    ]) {
      const index = shell.at(id);
      expect([id, index >= 0 && index < control]).toEqual([id, true]);
    }
  });

  it('opens onto the whole verification workflow in one press', async () => {
    const shell = await liveSession(MIXER_QUADX, 4);
    shell.press('motors-advanced-verification-toggle');
    // The wizard itself renders only once there is an observation to
    // answer, so what is asserted here is that the identity workflow is
    // present in its resting state: the identity section with its
    // instruction and its summary.
    for (const id of [
      'motors-identity-section',
      'motor-identification-steps',
      'motor-identification-summary',
      'motors-diagram-reference',
    ]) {
      expect([id, shell.has(id)]).toEqual([id, true]);
    }
    // M-F2 §18/§24: the direction workflow and the output transaction are
    // PRIMARY tools now - each one press away beside the aircraft, no
    // longer buried behind the same advanced toggle. Still one press.
    shell.press('motors-open-direction');
    expect(shell.has('motor-direction-section')).toBe(true);
    shell.press('motors-open-reorder');
    expect(shell.has('motor-output-mapping-section')).toBe(true);
  });
});

/* ================================================================== *
 * §16 / §50 - ONE SELECTOR, ONE SELECTION
 * ================================================================== */

describe('M-E §16 / §50 - one selector per airframe, one selected motor', () => {
  it('a drawn airframe selects from the aircraft, and offers no chip row', async () => {
    const shell = await liveSession(MIXER_HEX6X, 6);
    for (let motor = 1; motor <= 6; motor += 1) {
      expect(shell.has(`motors-diagram-slot-${motor}`)).toBe(true);
    }
    expect(shell.has('motor-identity-M1')).toBe(false);
    expect(shell.has('motors-generic-outputs')).toBe(false);
  });

  it('an undrawable airframe selects from the numbers, and offers no aircraft', async () => {
    // HEX6H's own mixer table gives two of its motors { roll 0, pitch 0 }
    // - no arm, no position - so there is nothing honest to draw.
    const shell = await liveSession(MIXER_HEX6H, 6);
    expect(shell.has('motors-airframe-stage')).toBe(false);
    expect(shell.has('motors-generic-outputs')).toBe(true);
    for (let motor = 1; motor <= 6; motor += 1) {
      expect(shell.has(`motor-identity-M${motor}`)).toBe(true);
    }
  });

  it('the drawing, the addressed line and the identify action name one motor', async () => {
    const shell = await liveSession(MIXER_QUADX, 4);
    shell.press('motors-airframe-slot-3');
    const spoken = shell.renderer.root.findAll(
      candidate => candidate.props?.testID === 'motors-airframe-slot-3',
    )[0].props.accessibilityState;
    expect(spoken.selected).toBe(true);
    // The line under the aircraft and the hold's own label follow it.
    expect(shell.text()).toContain('M3');
    expect(
      shell.renderer.root.findAll(
        candidate =>
          candidate.props?.testID === 'motors-airframe-slot-1' &&
          candidate.props?.accessibilityState?.selected === true,
      ),
    ).toHaveLength(0);
  });

  it('walks a coaxial arm rather than giving each rotor its own target', async () => {
    const shell = await liveSession(MIXER_OCTOX8, 8);
    // Four arms, eight motors: the arm bearing 1 and 5 is one node.
    expect(shell.has('motors-diagram-slot-1')).toBe(true);
    expect(shell.has('motors-diagram-slot-5')).toBe(true);
    shell.press('motors-airframe-slot-1');
    const selected = shell.renderer.root
      .findAll(
        candidate =>
          typeof candidate.props?.testID === 'string' &&
          candidate.props.testID.startsWith('motors-airframe-slot-') &&
          candidate.props?.accessibilityState?.selected === true,
      )
      .map(candidate => candidate.props.testID as string);
    expect([...new Set(selected)]).toEqual(['motors-airframe-slot-1']);
  });
});

/* ================================================================== *
 * §35 / §36 - THE EMERGENCY STOP IS PROPORTIONAL TO THE DANGER
 * ================================================================== */

describe('M-E §35 - the stop is compact until something can move', () => {
  const flat = (style: unknown): Record<string, unknown> =>
    Array.isArray(style)
      ? Object.assign({}, ...style.filter(Boolean).map(flat))
      : ((style ?? {}) as Record<string, unknown>);

  it('is present, enabled and quiet before motor control is enabled', async () => {
    const shell = await liveSession(MIXER_QUADX, 4);
    expect(shell.has('motors-stop-button')).toBe(true);
    const node = shell.renderer.root
      .findAll(candidate => candidate.props?.testID === 'motors-stop-button')
      .find(candidate => typeof candidate.props?.onPress === 'function');
    expect(node).toBeDefined();
    // NEVER DISABLED. The whole point of a pinned stop is that it works
    // in every state, including the ones where the app is confused.
    expect(node?.props.accessibilityState?.disabled).toBe(false);
    const calm = flat(shell.styleOf('motors-stop-button'));
    expect(calm.minHeight).toBe(44);
  });

  it('takes full weight once a command can reach a motor', async () => {
    const shell = await liveSession(MIXER_QUADX, 4);
    const calm = flat(shell.styleOf('motors-stop-button'));
    shell.toggle('motor-workspace-enable', true);
    await settle();
    const urgent = flat(shell.styleOf('motors-stop-button'));
    expect(Number(urgent.minHeight)).toBeGreaterThan(Number(calm.minHeight));
    expect(Number(urgent.paddingVertical ?? urgent.padding ?? 0)).toBeGreaterThan(
      Number(calm.paddingVertical ?? 0),
    );
  });

  it('covers nothing: it is a sibling of the list, never an overlay', async () => {
    const shell = await liveSession(MIXER_QUADX, 4);
    const dock = flat(shell.styleOf('motors-session-dock'));
    // An absolutely-positioned dock would paint over whatever is under
    // it, which is the failure §36 names. This one takes its height out
    // of the column before the scroll view gets what is left.
    expect(dock.position).toBeUndefined();
  });
});

/* ================================================================== *
 * §12 - THE PRIMARY UI SPEAKS ABOUT THE AIRCRAFT
 * ================================================================== */

describe('M-E §12 - no implementation vocabulary above the controls', () => {
  /**
   * The exact sentences M-E removed from the first viewport, measured off
   * a 1366 screenshot of a hexacopter. Every one is still in the app, in
   * the technical details section; none of them is what an operator meets
   * when they arrive to spin a motor.
   */
  const RELOCATED: readonly string[] = [
    ar.motorsScreen.numberingNoticeShort,
    ar.motorsScreen.diagramDirectionSource,
    ar.motorsScreen.diagramFrontHint,
  ];

  it.each([
    ['HEX6X', MIXER_HEX6X, 6],
    ['CUSTOM', MIXER_CUSTOM, 5],
    ['UNKNOWN', MIXER_UNKNOWN, 3],
  ])('%s: says none of it before anything is opened', async (
    _name,
    mixerMode,
    motorCount,
  ) => {
    const shell = await liveSession(mixerMode, motorCount);
    const visible = shell.text();
    for (const phrase of RELOCATED) {
      expect([phrase.slice(0, 24), visible.includes(phrase)]).toEqual([
        phrase.slice(0, 24),
        false,
      ]);
    }
  });

  it('keeps every one of them one press away', async () => {
    const shell = await liveSession(MIXER_QUADX, 4);
    shell.press('motors-advanced-verification-toggle');
    shell.press('motors-diagram-notes-toggle');
    const visible = shell.text();
    for (const phrase of RELOCATED) {
      expect([phrase.slice(0, 24), visible.includes(phrase)]).toEqual([
        phrase.slice(0, 24),
        true,
      ]);
    }
  });
});

/* ================================================================== *
 * §59 - THE REQUIRED SCREEN STATES, EACH RENDERED FOR REAL
 * ================================================================== */

describe('M-E §59 - every required screen state renders truthfully', () => {
  /** Airframe, mixer byte, reported motor count, drawn or numbered. */
  const STATES: ReadonlyArray<readonly [string, number, number, boolean]> = [
    ['QUADX', MIXER_QUADX, 4, true],
    ['QUADX_1234', MIXER_QUADX_1234, 4, true],
    ['TRI', MIXER_TRI, 3, true],
    ['QUADP', MIXER_QUADP, 4, true],
    ['Y4', MIXER_Y4, 4, true],
    ['HEX6X', MIXER_HEX6X, 6, true],
    ['Y6', MIXER_Y6, 6, true],
    ['OCTOX8', MIXER_OCTOX8, 8, true],
    ['FLYING_WING', MIXER_FLYING_WING, 1, true],
    ['AIRPLANE', MIXER_AIRPLANE, 1, true],
    ['CUSTOM_5', MIXER_CUSTOM, 5, false],
    ['UNKNOWN_3', MIXER_UNKNOWN, 3, false],
  ];

  it.each(STATES)('%s renders, and draws exactly what it can prove', async (
    _name,
    mixerMode,
    motorCount,
    drawn,
  ) => {
    const shell = await liveSession(mixerMode, motorCount);
    expect(shell.has('motors-screen')).toBe(true);
    expect(shell.has('motors-airframe-stage')).toBe(drawn);
    expect(shell.has('motors-generic-outputs')).toBe(!drawn);
    // The FRONT marker is not optional on any drawn airframe.
    expect(shell.has('motors-diagram-front')).toBe(drawn);
    // Every reported motor has a control, and no eleventh one appears.
    for (let motor = 1; motor <= motorCount; motor += 1) {
      expect(shell.has(`motor-slider-${motor}`)).toBe(true);
    }
    expect(shell.has(`motor-slider-${motorCount + 1}`)).toBe(false);
    // And the stop is pinned in every one of them.
    expect(shell.has('motors-stop-button')).toBe(true);
  });

  it('an inactive Motor Test offers the activation, and no live controls', async () => {
    const shell = await motorsScreen(MIXER_QUADX, 4);
    expect(shell.has('motor-session-toggle')).toBe(true);
    expect(shell.has('motor-slider-1')).toBe(false);
  });

  it('an active Motor Test exposes Master and every motor', async () => {
    const shell = await liveSession(MIXER_QUADX, 4);
    expect(shell.has('motor-slider-master')).toBe(true);
    expect(shell.has('motor-workspace-stop')).toBe(true);
  });
});
