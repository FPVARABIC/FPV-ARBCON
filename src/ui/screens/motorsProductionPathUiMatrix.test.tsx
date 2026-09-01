/**
 * M-D §35 / §38 / §40 - WHAT A UI ACTION PUTS ON THE WIRE, AND WHAT
 * HAPPENS WHEN THE SCREEN GOES AWAY.
 *
 * THE OTHER SUITES DRIVE THE CONTROLLER. This one drives the SCREEN, over
 * a scripted board, and reads the bytes. That distinction is the whole
 * point: a controller can be perfectly correct while the screen in front
 * of it never reaches the method that is correct, and this repository has
 * already shipped exactly that defect once - motorSessionReopenProductionPath
 * documents a fix that passed in isolation while the product stayed
 * broken, because two gates in MotorsScreen sat in front of it.
 *
 * §35 - THE COMMAND FRAME IS A FIXED WIDTH, WHATEVER THE AIRCRAFT.
 *   MSP_SET_MOTOR carries MAX_SUPPORTED_MOTORS u16 values, not motorCount
 *   of them (msp.c @ 7348054f). A three-motor tricopter and an
 *   eight-motor octo therefore put the SAME NUMBER OF BYTES on the wire,
 *   and the count decides only which of those slots may be non-idle.
 *   Asserted from a real slider drag, not from a controller call.
 *
 * §38 - LEAVING THE SCREEN STOPS THE MOTORS.
 *   Unmounting is not a tidy-up: a motor may be turning. The teardown has
 *   to reach the wire, and it has to be a FULL-WIDTH all-stop rather than
 *   a stop for the motors this screen happened to know about.
 *
 * §40 - THE INTERLOCK.
 *   The protected hold is refused while activation is not allowed, and it
 *   is refused BY THE SCREEN - the operator cannot reach the command path
 *   at all. Proven by the control's own disabled state plus the absence
 *   of any MSP_SET_MOTOR on the wire, because a control that looks
 *   disabled and still fires is the defect this asserts against.
 *
 * WHICH CONTROL EACH BLOCK DRIVES, AND WHY THAT IS NOT INTERCHANGEABLE.
 * This file's first draft drove the protected hold everywhere and failed
 * on a tricopter with "no hold control" - which looked like a P0 until it
 * was traced. There are TWO command surfaces on this screen and they have
 * different scopes ON PURPOSE:
 *
 *   THE WORKSPACE SLIDERS (`motor-slider-N`, `motor-slider-master`) and
 *   STOP. One per reported output, on EVERY airframe. This is numbered
 *   motor control, and nothing about an airframe may withdraw it - a
 *   numbered output is addressable without knowing which arm it drives.
 *
 *   THE PROTECTED HOLD (`motors-hold-button`). The physical-IDENTIFICATION
 *   action: spin one motor while you watch which arm turns, then record
 *   the answer. MotorIdentitySection deliberately does not render it where
 *   identification cannot happen, because a call to action that cannot
 *   record anything is a control that looks actionable and is not.
 *
 * So §35 and §38 drive the SLIDER - the surface every aircraft has - and
 * §40 drives the HOLD on a Quad X, where it exists. A separate block
 * asserts the split itself, so a future change cannot quietly withdraw
 * numbered control from a hex by widening the identification gate.
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
  MSP_MIXER_CONFIG,
  MSP_MOTOR_CONFIG,
} from '../../core/protocol/msp/commands/mspCommands';

const SESSION_ID = 'production-ui-matrix-session';

/**
 * MAX_SUPPORTED_MOTORS at the pinned firmware, and the reason the frame
 * width is a constant here rather than a function of the aircraft.
 */
const WIRE_SLOTS = 8;
const WIRE_BYTES = WIRE_SLOTS * 2;

/** Betaflight `mixerMode_e`. */
const MIXER_TRI = 1;
const MIXER_OCTOX8 = 11;
const MIXER_QUADX = 3;

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

/** Every MSP_SET_MOTOR payload the SCREEN caused to be written, in order. */
function motorWrites(): Uint8Array[] {
  return transport.writeLog
    .map(frame => parseRequest(frame))
    .filter(
      (request): request is NonNullable<typeof request> =>
        request !== undefined && request.command === MSP_SET_MOTOR,
    )
    .map(request => request.payload);
}

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
    /**
     * A workspace slider, driven the way a thumb drives it. This is the
     * command surface that exists on EVERY airframe - see the note above
     * the §35 block on why the protected hold is not.
     */
    slide: (testID: string, value: number) => {
      const node = find(testID, 'onChange');
      if (node === undefined) throw new Error(`no slider "${testID}"`);
      if (node.props.disabled === true) {
        throw new Error(`slider "${testID}" is disabled`);
      }
      ReactTestRenderer.act(() => node.props.onChange(value));
    },
    sliderIsDisabled: (testID: string) =>
      find(testID, 'onChange')?.props.disabled === true,
    /**
     * The protected hold, driven the way a finger drives it: press in,
     * long press, and (optionally) release. REFUSES a disabled control -
     * a proof built on firing a handler no operator can reach would be a
     * proof about a build nobody ships.
     */
    hold: (testID: string) => {
      const node = find(testID, 'onLongPress');
      if (node === undefined) throw new Error(`no hold control "${testID}"`);
      if (node.props.disabled === true) {
        throw new Error(`hold control "${testID}" is disabled`);
      }
      ReactTestRenderer.act(() => {
        node.props.onPressIn?.();
        node.props.onLongPress();
      });
    },
    release: (testID: string) => {
      const node = find(testID, 'onLongPress');
      if (node === undefined) throw new Error(`no hold control "${testID}"`);
      ReactTestRenderer.act(() => node.props.onPressOut?.());
    },
    holdIsDisabled: (testID: string) =>
      find(testID, 'onLongPress')?.props.disabled === true,
    has: (testID: string) =>
      renderer.root.findAll(candidate => candidate.props?.testID === testID)
        .length > 0,
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
  const snapshot = readMotorTestCapability(SESSION_ID)
    ?.lifecycleStopPort()
    ?.getSnapshot();
  // Every assertion below is worthless on a session that never started.
  expect(snapshot?.setupStep).toBe('READY');
  return shell;
}

/**
 * A session with motor control ENABLED - the second, deliberate step.
 *
 * GRADED SAFETY, AND THIS FILE RESPECTS IT RATHER THAN ROUTING AROUND IT.
 * Opening a session does not make a slider live: `commandable` also
 * requires the operator to turn motor control on, and the sliders stay
 * visibly disabled until they do. Driving `applyMotor` directly would
 * skip exactly the gate that keeps a propeller still, so every command
 * below goes through both steps, in order, the way a person does.
 */
async function commandableSession(mixerMode: number, motorCount: number) {
  const shell = await liveSession(mixerMode, motorCount);
  // Disabled BEFORE the second step: the gate is real, not decorative.
  expect(shell.sliderIsDisabled('motor-slider-1')).toBe(true);
  shell.toggle('motor-workspace-enable', true);
  await settle();
  expect(shell.sliderIsDisabled('motor-slider-1')).toBe(false);
  return shell;
}

/* ================================================================== *
 * §35 - FIXED-WIDTH COMMAND FRAME, FROM A REAL UI ACTION
 * ================================================================== */

describe('§35 - the wire frame is the same width on every aircraft', () => {
  it.each([
    ['TRI', MIXER_TRI, 3],
    ['QUADX', MIXER_QUADX, 4],
    ['OCTOX8', MIXER_OCTOX8, 8],
  ])(
    '%s: moving motor 1 writes eight u16 slots, not one per motor',
    async (_name, mixerMode, motorCount) => {
      const shell = await commandableSession(mixerMode, motorCount);
      const before = motorWrites().length;
      shell.slide('motor-slider-1', 1200);
      await settle();

      const written = motorWrites().slice(before);
      expect(written.length).toBeGreaterThan(0);
      for (const payload of written) {
        expect(payload.length).toBe(WIRE_BYTES);
      }
      // The COUNT is what the aircraft reported; the WIDTH is not.
      expect(motorCount).toBeLessThanOrEqual(WIRE_SLOTS);
    },
  );

  it('a three-motor aircraft never drives a fourth slot off idle', async () => {
    const shell = await commandableSession(MIXER_TRI, 3);
    // The aircraft has three sliders and no fourth to reach for.
    expect(shell.has('motor-slider-3')).toBe(true);
    expect(shell.has('motor-slider-4')).toBe(false);
    const before = motorWrites().length;
    shell.slide('motor-slider-1', 1200);
    await settle();

    const written = motorWrites().slice(before);
    expect(written.length).toBeGreaterThan(0);
    for (const payload of written) {
      expect(payload.length).toBe(WIRE_BYTES);
      // Slots beyond the reported count are PRESENT on the wire and at
      // the idle value. Present-and-idle is the contract; absent would be
      // a short write, and a short write resets the tail (msp.c).
      for (let slot = 3; slot < WIRE_SLOTS; slot += 1) {
        const value = payload[slot * 2] | (payload[slot * 2 + 1] << 8);
        expect(value).toBeLessThanOrEqual(1000);
      }
    }
  });

  it('an eight-motor aircraft still writes eight, not sixteen', async () => {
    const shell = await commandableSession(MIXER_OCTOX8, 8);
    expect(shell.has('motor-slider-8')).toBe(true);
    const before = motorWrites().length;
    shell.slide('motor-slider-8', 1200);
    await settle();

    const written = motorWrites().slice(before);
    expect(written.length).toBeGreaterThan(0);
    for (const payload of written) {
      expect(payload.length).toBe(WIRE_BYTES);
    }
  });

  it('the master control writes the same fixed width', async () => {
    const shell = await commandableSession(MIXER_OCTOX8, 8);
    const before = motorWrites().length;
    shell.slide('motor-slider-master', 1150);
    await settle();

    const written = motorWrites().slice(before);
    expect(written.length).toBeGreaterThan(0);
    for (const payload of written) {
      expect(payload.length).toBe(WIRE_BYTES);
    }
  });
});

/* ================================================================== *
 * §7 / §30 - NUMBERED CONTROL IS NOT AN IDENTIFICATION PRIVILEGE
 * ================================================================== */

describe('§30 - every airframe keeps numbered motor control and STOP', () => {
  it.each([
    ['TRI', MIXER_TRI, 3],
    ['QUADX', MIXER_QUADX, 4],
    ['OCTOX8', MIXER_OCTOX8, 8],
  ])('%s: one live slider per reported output, plus STOP', async (
    _name,
    mixerMode,
    motorCount,
  ) => {
    const shell = await commandableSession(mixerMode, motorCount);
    for (let motor = 1; motor <= motorCount; motor += 1) {
      expect(shell.has(`motor-slider-${motor}`)).toBe(true);
      expect(shell.sliderIsDisabled(`motor-slider-${motor}`)).toBe(false);
    }
    expect(shell.has(`motor-slider-${motorCount + 1}`)).toBe(false);
    expect(shell.has('motor-slider-master')).toBe(true);
    expect(shell.has('motor-workspace-stop')).toBe(true);
  });

  /**
   * RELOCATED FROM motorNumberingAndDiagram, and strengthened on the way.
   *
   * That suite asserted "one chip per reported output, and no more" on the
   * diagram's numbered fallback, rendered alone. The fallback stopped being
   * a selector - it was a second copy of the row above it - so the property
   * is asserted here instead, on the identity selector that every airframe
   * actually gets, through the real screen and a real MSP_MOTOR_CONFIG
   * count. Same property, closer to what an operator touches.
   */
  it.each([
    ['TRI', MIXER_TRI, 3],
    ['QUADX', MIXER_QUADX, 4],
    ['OCTOX8', MIXER_OCTOX8, 8],
  ])('%s: exactly one identity chip per reported output, and no more', async (
    _name,
    mixerMode,
    motorCount,
  ) => {
    const shell = await liveSession(mixerMode, motorCount);
    // M-E: all three of these airframes are DRAWN now, so the selector an
    // operator meets is the aircraft itself - one node per reported
    // output, and no node for an output the board did not report.
    for (let motor = 1; motor <= motorCount; motor += 1) {
      expect(shell.has(`motors-diagram-slot-${motor}`)).toBe(true);
    }
    expect(shell.has(`motors-diagram-slot-${motorCount + 1}`)).toBe(false);
    // And no SECOND selector in the first viewport offering the same
    // numbers again: neither the numbered chips nor a generic list.
    expect(shell.has('motor-identity-M1')).toBe(false);
    expect(shell.has('motors-generic-slot-1')).toBe(false);
  });

  it('a tricopter gets the identify action and commands motors, and still makes no Quad X claim', async () => {
    // THE SPLIT, STATED - and M-E moved the line, deliberately.
    //
    // WITHHELD: the shipped Quad X EXPECTATION and its wizard, because a
    // tricopter is not the airframe that model describes.
    // NOT WITHHELD: spinning one motor to see which propeller moves. It
    // needs no model, and it is the same fixed eight-slot write the
    // sliders below already send on this aircraft.
    // This is the assertion that keeps the two from being merged again.
    const shell = await commandableSession(MIXER_TRI, 3);
    expect(shell.has('motors-hold-button')).toBe(true);
    expect(shell.has('verification-wizard')).toBe(false);
    expect(shell.has('motor-identity-expected')).toBe(false);

    const before = motorWrites().length;
    shell.slide('motor-slider-2', 1200);
    await settle();
    expect(motorWrites().length).toBeGreaterThan(before);
  });

  it('a Quad X gets both', async () => {
    const shell = await liveSession(MIXER_QUADX, 4);
    expect(shell.has('motors-hold-button')).toBe(true);
    expect(shell.has('motor-slider-1')).toBe(true);
  });
});

/* ================================================================== *
 * §38 - THE SCREEN GOING AWAY STOPS THE MOTORS
 * ================================================================== */

describe('§38 - leaving the Motors tab reaches the wire', () => {
  /**
   * WHAT "LEAVING" MEANS HERE, AND WHY IT IS NOT A REACT UNMOUNT.
   *
   * This block's first draft tore the tree down with `renderer.unmount()`
   * and asserted a stop reached the wire. Nothing did, and the reason is
   * architectural rather than a bug: the stop obligation is bound to
   * DEPARTURE - a tab blur, a route `beforeRemove`, Android Back, an
   * AppState change - and the shell holds navigation open on the
   * departure gate until the controller reports a bounded stop verdict.
   * A React unmount is not a departure event; in production the blur
   * always precedes it, which is precisely what makes that wait possible.
   * Asserting on unmount would have been asserting on a path an operator
   * cannot take, so this block drives the one they do take: a tab press.
   */
  it('writes a full-width all-stop when the operator switches tabs', async () => {
    const shell = await commandableSession(MIXER_OCTOX8, 8);
    shell.slide('motor-slider-1', 1200);
    await settle();
    const before = motorWrites().length;

    shell.press('main-tab-SETUP');
    await settle();

    const after = motorWrites().slice(before);
    expect(after.length).toBeGreaterThan(0);
    const last = after[after.length - 1];
    expect(last.length).toBe(WIRE_BYTES);
    // An ALL-stop: every one of the eight slots, not just the ones this
    // aircraft uses. A stop that leaves a slot un-commanded is not a stop.
    for (let slot = 0; slot < WIRE_SLOTS; slot += 1) {
      const value = last[slot * 2] | (last[slot * 2 + 1] << 8);
      expect(value).toBeLessThanOrEqual(1000);
    }
  });

  it('stops on departure even when no motor was ever commanded', async () => {
    // The obligation is unconditional. "We commanded nothing, so there is
    // nothing to stop" is an assumption about a board this app does not
    // own, and the session has already armed the command path.
    const shell = await commandableSession(MIXER_QUADX, 4);
    const before = motorWrites().length;

    shell.press('main-tab-SETUP');
    await settle();

    expect(motorWrites().length).toBeGreaterThan(before);
  });

  it('a tab press that does not leave Motors writes no stop', async () => {
    // The counter-case, so the two assertions above cannot pass on a
    // screen that simply stops the motors at every render.
    const shell = await commandableSession(MIXER_QUADX, 4);
    const before = motorWrites().length;

    shell.press('main-tab-MOTORS');
    await settle();

    expect(motorWrites().length).toBe(before);
  });
});

/* ================================================================== *
 * §40 - THE INTERLOCK
 * ================================================================== */

describe('§40 - the protected hold is unreachable until the session allows it', () => {
  it('is disabled before the session is opened', async () => {
    const shell = await motorsScreen(MIXER_QUADX, 4);
    expect(shell.has('motors-hold-button')).toBe(true);
    expect(shell.holdIsDisabled('motors-hold-button')).toBe(true);
  });

  it('puts NOTHING on the wire while it is disabled', async () => {
    const shell = await motorsScreen(MIXER_QUADX, 4);
    const before = motorWrites().length;
    // Driving it is refused by the harness, which is the assertion: an
    // operator cannot reach this path.
    expect(() => shell.hold('motors-hold-button')).toThrow(/disabled/);
    await settle();
    expect(motorWrites().length).toBe(before);
  });

  it('becomes reachable only after the session reaches READY', async () => {
    const shell = await liveSession(MIXER_QUADX, 4);
    expect(shell.holdIsDisabled('motors-hold-button')).toBe(false);
  });

  it('releasing the hold writes a stop', async () => {
    const shell = await liveSession(MIXER_QUADX, 4);
    shell.hold('motors-hold-button');
    await settle();
    const before = motorWrites().length;

    shell.release('motors-hold-button');
    await settle();

    const after = motorWrites().slice(before);
    expect(after.length).toBeGreaterThan(0);
    const last = after[after.length - 1];
    for (let slot = 0; slot < WIRE_SLOTS; slot += 1) {
      const value = last[slot * 2] | (last[slot * 2 + 1] << 8);
      expect(value).toBeLessThanOrEqual(1000);
    }
  });

  it('closing the session disables it again', async () => {
    const shell = await liveSession(MIXER_QUADX, 4);
    expect(shell.holdIsDisabled('motors-hold-button')).toBe(false);
    shell.toggle('motor-session-toggle', false);
    await settle();
    expect(shell.holdIsDisabled('motors-hold-button')).toBe(true);
  });
});
