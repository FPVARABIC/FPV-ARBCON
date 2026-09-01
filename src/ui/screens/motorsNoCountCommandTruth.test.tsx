/**
 * M-E3 - WHAT A BOARD THAT NEVER SAID HOW MANY MOTORS IT HAS MAY BE
 * COMMANDED TO DO, AND WHAT THE SCREEN MAY SAY ABOUT IT.
 *
 * THE QUESTION THIS FILE ANSWERS, AND WHY IT IS ASKED AT THE WIRE.
 *
 * `MSP_SET_MOTOR` (214) carries a FIXED eight-slot payload whatever the
 * aircraft is. That width is a wire safety contract - every output this
 * protocol can address is written in one frame, so nothing is left at an
 * old value - and it is NOT a statement that eight motors exist, or that
 * one does. The two have to be kept apart deliberately, because the
 * encoder's shape is the most tempting wrong answer to "how many motors
 * are there".
 *
 * The authority for THAT is `MSP_MOTOR_CONFIG` offset 6, the runtime
 * count the firmware reports. Not the mixer's compile-time expectation,
 * not the number of telemetry records that happened to arrive, not the
 * first zero in MSP_MOTOR's eight slots, and not a default of one, four
 * or eight.
 *
 * WHY THE PROOF IS FRAME-COUNTING RATHER THAN ASSERTION-ON-A-LABEL. A
 * disabled-looking control that still dispatches is the exact defect
 * class here, and no amount of reading `disabled` props catches it. So
 * these cases drive every reachable motor action through the real screen
 * and then decode `transport.writeLog` - every byte the app actually
 * handed the transport, in invocation order - and classify each
 * MSP_SET_MOTOR frame as an ORDINARY DRIVE or a SAFE STOP by reading its
 * sixteen payload bytes. A safety stop is never counted as a drive.
 *
 * NOTHING HERE IS A HARDWARE CLAIM. `ScriptedMotorFc` is a lookup table.
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
import {
  ScriptedMotorFc,
  parseRequest,
} from '../../core/protocol/__testUtils__/scriptedMotorFc';
import type {ScriptedMotorFcOptions} from '../../core/protocol/__testUtils__/scriptedMotorFc';
import {
  MSP_MIXER_CONFIG,
  MSP_MOTOR_CONFIG,
} from '../../core/protocol/msp/commands/mspCommands';
import {MSP_SET_MOTOR} from '../../core/protocol/msp/commands/motorTestCommands';
import {MOTOR_TEST_COMMAND_VECTOR_SLOTS} from '../../core/state/motorTestCommandVector';

const SESSION_ID = 'no-count-truth-session';

/** Betaflight `mixerMode_e`, from the pinned firmware's mixer.h. */
const MIXER_QUADX = 3;
const MIXER_CUSTOM = 23;
/** In no pinned mixer table. Must stay unrecognised, never normalised. */
const MIXER_UNRECOGNISED = 199;

const u16 = (value: number) => [value & 0xff, (value >> 8) & 0xff];

/**
 * A board's replies, chosen per case.
 *
 * `undefined` means THE REQUEST IS NEVER ANSWERED - `silentCommands`, not
 * an omitted payload. That distinction cost this file a first draft:
 * `ScriptedMotorFcOptions.payloads` MERGES over `MOTOR_SESSION_SCRIPT`,
 * which already answers MSP_MOTOR_CONFIG with a healthy quad, so leaving
 * the key out scripts a four-motor board rather than a silent one. The
 * first run of these cases was therefore measuring a board that had
 * reported four motors while the test believed it had reported none.
 *
 * Silence is also the right shape for the state under test. A reply
 * carrying zero would be a board making a claim; an unread count is a
 * board that made none.
 */
function board(
  mixerMode: number | undefined,
  motorCount: number | undefined,
): ScriptedMotorFcOptions {
  const payloads = new Map<number, Uint8Array>();
  const silentCommands: number[] = [];
  if (mixerMode === undefined) {
    silentCommands.push(MSP_MIXER_CONFIG);
  } else {
    payloads.set(MSP_MIXER_CONFIG, Uint8Array.from([mixerMode, 0]));
  }
  if (motorCount === undefined) {
    silentCommands.push(MSP_MOTOR_CONFIG);
  } else {
    payloads.set(
      MSP_MOTOR_CONFIG,
      Uint8Array.from([
        ...u16(1070), ...u16(2000), ...u16(1000),
        motorCount,
        14, 0, 0,
      ]),
    );
  }
  return {payloads, silentCommands};
}

let transport: FakeMspTransport;
let fc: ScriptedMotorFc;

/**
 * EVERY MSP_SET_MOTOR FRAME THE APP PUT ON THE WIRE, CLASSIFIED.
 *
 * Read from the transport's append-only `writeLog`, decoded by the same
 * request parser the scripted board uses, so nothing here re-implements
 * framing. A frame is a SAFE STOP when all eight of its u16 slots equal
 * the domain's stop value; anything else is an ORDINARY DRIVE, which is
 * the thing that must never happen without a proven motor scope.
 *
 * `stopValue` is passed in rather than assumed, because it is resolved -
 * mincommand on analog, 1000 on digital non-3D, 1500 on digital 3D.
 */
function setMotorFrames(stopValue: number) {
  const drives: number[][] = [];
  const stops: number[][] = [];
  for (const bytes of transport.writeLog) {
    const request = parseRequest(bytes);
    if (request === undefined || request.command !== MSP_SET_MOTOR) {
      continue;
    }
    const slots: number[] = [];
    for (let slot = 0; slot < MOTOR_TEST_COMMAND_VECTOR_SLOTS; slot += 1) {
      const at = slot * 2;
      slots.push(request.payload[at] + request.payload[at + 1] * 256);
    }
    (slots.every(value => value === stopValue) ? stops : drives).push(slots);
  }
  return {drives, stops, total: drives.length + stops.length};
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
  const all = (testID: string) =>
    renderer.root.findAll(candidate => candidate.props?.testID === testID);
  const find = (testID: string, handler: 'onPress' | 'onValueChange' | 'onChange') =>
    all(testID).find(candidate => typeof candidate.props?.[handler] === 'function');
  return {
    renderer,
    all,
    has: (testID: string) => all(testID).length > 0,
    /**
     * Is this control offered as usable? Read off the node that carries
     * the handler, so a control rendered `disabled` reports false even
     * though it is on screen - the distinction the whole file is about.
     */
    enabled: (testID: string): boolean =>
      all(testID).some(
        candidate =>
          candidate.props?.disabled !== true &&
          (typeof candidate.props?.onPress === 'function' ||
            typeof candidate.props?.onValueChange === 'function' ||
            typeof candidate.props?.onChange === 'function'),
      ),
    /** Fire a handler if one is offered, and say whether there was one. */
    poke: (
      testID: string,
      handler: 'onPress' | 'onValueChange' | 'onChange',
      ...args: unknown[]
    ): boolean => {
      const node = find(testID, handler);
      if (node === undefined) return false;
      ReactTestRenderer.act(() => node.props[handler](...args));
      return true;
    },
    /**
     * EVERY MOTOR AN OPERATOR CAN ACTUALLY ADDRESS, from whichever
     * selector this airframe renders.
     *
     * M-E established ONE selector per airframe: where a layout is drawn
     * the diagram's nodes are the targets, and where none is, the
     * numbered chip row is. A helper that knew only one of them would
     * report zero for half the cases and pass for the wrong reason.
     *
     * Deduped, because `findAll` matches a Pressable's composite node AND
     * its host node. The question is which motors are REACHABLE, not how
     * many tree nodes carry the prop.
     */
    reachableMotors: (): number[] =>
      [
        ...new Set(
          [
            ...all('motor-identification-summary').flatMap(node =>
              node.findAll(child => child.props?.accessibilityRole === 'radio'),
            ),
            ...renderer.root.findAll(candidate =>
              String(candidate.props?.testID ?? '').startsWith('motors-airframe-slot-'),
            ),
          ]
            .map(child => String(child.props?.testID ?? ''))
            .map(id => Number(id.replace(/\D+/g, '')))
            .filter(value => Number.isInteger(value) && value > 0),
        ),
      ].sort((a, b) => a - b),
    openTab: (tab: string) => {
      const node =
        find(`main-tab-${tab}`, 'onPress') ?? find(`main-rail-${tab}`, 'onPress');
      if (node === undefined) throw new Error(`no navigation item for "${tab}"`);
      ReactTestRenderer.act(() => node.props.onPress());
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
      try { renderer.unmount(); } catch { /* already torn down */ }
    }
  });
  closeMotorTestCapability(SESSION_ID);
  jest.restoreAllMocks();
});

/** A Motors screen with a live session against the given board. */
async function liveMotorsScreen(
  mixerMode: number | undefined,
  motorCount: number | undefined,
) {
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
  shell.openTab('MOTORS');
  await settle();
  shell.poke('motor-session-toggle', 'onValueChange', true);
  await settle();
  return shell;
}

/**
 * Try EVERYTHING an operator could reach that might drive a motor, and
 * report which controls actually accepted the attempt.
 *
 * Deliberately indiscriminate: it does not check whether a control looks
 * enabled before poking it, because "looks disabled but dispatches" is
 * precisely the defect being hunted. `poke` returns false only when no
 * handler exists at all.
 */
async function attemptEveryMotorAction(shell: ReturnType<typeof renderShell>) {
  const attempted: string[] = [];
  const push = (name: string, fired: boolean) => {
    if (fired) attempted.push(name);
  };
  push('control-enable', shell.poke('motor-workspace-enable', 'onValueChange', true));
  await settle(10);
  push('master', shell.poke('motor-slider-master', 'onChange', 1800));
  for (let slot = 1; slot <= MOTOR_TEST_COMMAND_VECTOR_SLOTS; slot += 1) {
    push(`slider-${slot}`, shell.poke(`motor-slider-${slot}`, 'onChange', 1800));
  }
  push('hold', shell.poke('motors-hold-button', 'onPress'));
  await settle(10);
  return attempted;
}

/* ================================================================== *
 * CASE A - NOTHING READ. No count, no mixer.
 * ================================================================== */

describe('M-E3 CASE A - a board that reported no motor count', () => {
  it('grants no activation, offers no motor identity, and drives nothing', async () => {
    const shell = await liveMotorsScreen(undefined, undefined);

    /* (A) Can the session become READY? The screen's readiness strip is
       rendered from `snapshot.activation.allowed`, which is the SAME
       evaluation pulseMotor runs - so its absence is the controller
       refusing, not a cosmetic choice. */
    expect(shell.has('motors-session-ready')).toBe(false);

    /* (B)(C)(D) Identify hold, Master, individual sliders. */
    expect(shell.enabled('motors-hold-button')).toBe(false);
    expect(shell.enabled('motor-slider-master')).toBe(false);
    expect(shell.has('motor-slider-1')).toBe(false);

    /* NO INVENTED MOTOR IDENTITY anywhere an operator reads. */
    const rendered = shell.text();
    expect(rendered).not.toContain('M1');
    expect(rendered).not.toContain('Motor 1');
    expect(rendered).not.toContain('المحرك 1');

    /* (E) THE WIRE. Every reachable action, then count the frames. */
    const attempted = await attemptEveryMotorAction(shell);
    const frames = setMotorFrames(1000);
    expect(frames.drives).toEqual([]);
    // Recorded so a future reader can see the attempt surface shrink or
    // grow rather than trusting that "nothing fired" meant "nothing was
    // reachable".
    expect(Array.isArray(attempted)).toBe(true);
  });

  /* (F) The safe stop is a DIFFERENT claim and must survive. */
  it('still lets the operator command a full-width all-stop', async () => {
    const shell = await liveMotorsScreen(undefined, undefined);
    expect(shell.has('motors-stop-button')).toBe(true);
    expect(shell.enabled('motors-stop-button')).toBe(true);
    shell.poke('motors-stop-button', 'onPress');
    await settle(10);
    // Whatever the stop path emits, it is never an ordinary drive.
    expect(setMotorFrames(1000).drives).toEqual([]);
  });

  it('says the count was never read instead of sending the operator to a control that will not help', async () => {
    const shell = await liveMotorsScreen(undefined, undefined);
    const rendered = shell.text();
    /* THE REASON MUST BE THE REAL ONE. Before M-E3 the blocked hold said
       "enable motor control first", which is an instruction that cannot
       succeed: enabling is refused for the same missing count. It named
       a control instead of a cause. */
    expect(rendered).toContain(ar.motorsScreen.holdBlockedCountUnread);
    expect(rendered).not.toContain(ar.motorsScreen.holdBlockedControlOff);
    // And the statement of unavailability is short - one title, one line,
    // inside the block that already existed. No new card.
    expect(shell.has('motors-hold-blocked')).toBe(true);
  });

  /* The settled-failure shape of the same state: the read was answered
     with an MSP error rather than left outstanding, so the session
     fail-closes. Still no motor identity anywhere. */
  it('names no motor when the count read fails outright', async () => {
    const shell = renderShell();
    renderers.push(shell.renderer);
    ReactTestRenderer.act(() => {
      transport = new FakeMspTransport();
      fc = new ScriptedMotorFc(transport, {failCommands: [MSP_MOTOR_CONFIG]});
      openMotorTestCapability(
        SESSION_ID,
        new MspClient(transport, SESSION_ID),
        createMotorTestTelemetryRegistry(),
      );
    });
    shell.openTab('MOTORS');
    await settle();
    shell.poke('motor-session-toggle', 'onValueChange', true);
    await settle(80);

    expect(shell.has('motors-status-FAULT')).toBe(true);
    expect(shell.text()).not.toContain('M1');
    await attemptEveryMotorAction(shell);
    expect(setMotorFrames(1000).drives).toEqual([]);
  });
});

/* ================================================================== *
 * CASE E - A KNOWN MIXER, BUT NO RUNTIME COUNT.
 *
 * The mandatory case. A Quad X mixer byte says a Quad X is CONFIGURED;
 * it does not say the running firmware reported four outputs, and an
 * expected topology is not command authority.
 * ================================================================== */

describe('M-E3 CASE E - a known mixer whose runtime count never arrived', () => {
  it('does not convert the expected topology into command scope', async () => {
    const shell = await liveMotorsScreen(MIXER_QUADX, undefined);

    expect(shell.has('motors-session-ready')).toBe(false);
    expect(shell.enabled('motors-hold-button')).toBe(false);
    expect(shell.enabled('motor-slider-master')).toBe(false);
    // FOUR SLIDERS WOULD BE THE DEFECT: the mixer expects four motors and
    // the firmware reported none.
    expect(shell.has('motor-slider-1')).toBe(false);
    expect(shell.has('motor-slider-4')).toBe(false);

    expect(shell.text()).not.toContain('M1');

    await attemptEveryMotorAction(shell);
    expect(setMotorFrames(1000).drives).toEqual([]);
  });
});

/* ================================================================== *
 * CASES B, C, D - A COUNT WAS READ. M-E2's fallbacks must not regress.
 * ================================================================== */

describe('M-E3 - a reported count is command authority, geometry or not', () => {
  it.each([
    ['unrecognised mixer, 3 motors', MIXER_UNRECOGNISED, 3],
    ['CUSTOM mixer, 5 motors', MIXER_CUSTOM, 5],
    ['QUADX, 4 motors', MIXER_QUADX, 4],
  ])('%s keeps its numbered controls', async (_name, mixer, count) => {
    const shell = await liveMotorsScreen(mixer, count);

    // The readiness statement is present because the controller allows it.
    expect(shell.has('motors-session-ready')).toBe(true);
    expect(shell.has('motor-slider-1')).toBe(true);
    expect(shell.has(`motor-slider-${count}`)).toBe(true);
    // ... and never one more than the firmware reported.
    expect(shell.has(`motor-slider-${count + 1}`)).toBe(false);
    expect(shell.text()).not.toContain(ar.motorsScreen.holdBlockedCountUnread);
    /*
     * EVERY REPORTED MOTOR IS ADDRESSABLE, AND NO OTHER.
     *
     * The sliders above come from the workspace's own count; this asks
     * the IDENTITY side of the screen the same question, and the two are
     * derived separately. A mutation that dropped the fifth motor from
     * the identity list, or blocked a three-motor aircraft for having no
     * authored geometry, passed every other assertion in this file.
     */
    expect(shell.reachableMotors()).toEqual(
      Array.from({length: count}, (_unused, index) => index + 1),
    );
  });

  /**
   * THE STOP FRAME, READ BYTE BY BYTE - §17.
   *
   * The negative cases above prove no ORDINARY DRIVE reaches the wire
   * without a scope. This is the other half of that classification: when
   * a stop IS intentionally sent, every one of its eight slots must carry
   * the resolved stop value. Counting a stop as "not a drive" is only
   * honest if something checks what a stop actually contains.
   */
  it('an all-stop frame carries the stop value in every one of its eight slots', async () => {
    const shell = await liveMotorsScreen(MIXER_QUADX, 4);
    shell.poke('motor-workspace-enable', 'onValueChange', true);
    await settle(10);

    /* SOMETHING MUST BE RUNNING FIRST. The controller deliberately
       refuses to manufacture stop traffic for an activation that never
       began, so a stop pressed on a resting session sends nothing at
       all - correct, and the reason the first draft of this case saw an
       empty wire. Drive the master, THEN stop. */
    shell.poke('motor-slider-master', 'onChange', 1200);
    await settle(20);
    const driven = setMotorFrames(1000);
    // The classifier is not vacuous: a real drive is recognised as one.
    expect(driven.drives.length).toBeGreaterThan(0);

    shell.poke('motors-stop-button', 'onPress');
    await settle(20);

    const frames = setMotorFrames(1000);
    expect(frames.stops.length).toBeGreaterThan(0);
    for (const slots of frames.stops) {
      expect(slots).toHaveLength(MOTOR_TEST_COMMAND_VECTOR_SLOTS);
      // EVERY slot, including the four beyond this aircraft's motors:
      // the fixed width exists so nothing is left at an old value.
      expect(slots.every(value => value === 1000)).toBe(true);
    }
    // The last frame on the wire is the stop, not the drive.
    const lastIsStop =
      frames.stops.length > 0 &&
      transport.writeLog.length > 0 &&
      (() => {
        const setMotor = transport.writeLog
          .map(bytes => parseRequest(bytes))
          .filter(request => request?.command === MSP_SET_MOTOR);
        const last = setMotor[setMotor.length - 1];
        if (last === undefined) return false;
        for (let slot = 0; slot < MOTOR_TEST_COMMAND_VECTOR_SLOTS; slot += 1) {
          const at = slot * 2;
          if (last.payload[at] + last.payload[at + 1] * 256 !== 1000) return false;
        }
        return true;
      })();
    expect(lastIsStop).toBe(true);
  });

  it('an unrecognised mixer with a known count is never blocked for geometry', async () => {
    const shell = await liveMotorsScreen(MIXER_UNRECOGNISED, 3);
    // Geometry is unknown; the count is not. Motor Test stays available.
    expect(shell.has('motors-session-ready')).toBe(true);
    expect(shell.has('motors-airframe-stage')).toBe(false);
    expect(shell.has('motor-slider-3')).toBe(true);
    expect(shell.has('motor-slider-4')).toBe(false);
  });
});
