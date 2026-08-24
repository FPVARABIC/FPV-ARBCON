/**
 * M-F2 - THE FINAL MOTORS WORKSPACE, THROUGH THE REAL SCREEN.
 *
 * WHAT THIS FILE PROVES, in the spec's own order:
 *
 *   - the airframe model is PERMANENT orientation context: visible with
 *     the session off, visible at READY, visible while a motor command
 *     is live, visible after the session closes (§4, §55);
 *   - the mixer selector, props control and the two primary tools are on
 *     the primary surface - no advanced disclosure between the operator
 *     and them (§2, §7, §16, §19, §24, §54);
 *   - the expected-rotation marks derive from the transcribed mixer yaw
 *     column plus the STORED props flag, flip with it, never render for
 *     a mixer that does not determine them, and are never labelled as
 *     the current direction (§14, §15, §17, §43);
 *   - the quick mixer/props edits build their drafts from the CURRENT
 *     snapshot with exactly one field changed, so a mixer save preserves
 *     the props flag and a props save preserves the mixer (§11, §56) -
 *     asserted on the exact draft handed to the verified transaction;
 *   - the M-E2/M-E3 truths hold: no invented topology, CUSTOM keeps its
 *     numbered workspace, coaxial aircraft stay coaxial (§40, §41, §42).
 *
 * The live-session scenarios run MainTabsScreen with the real binding,
 * the real MotorTestController and the real MspClient over a scripted
 * board. The session-off and draft-preservation scenarios mount the real
 * MotorsScreenView with an injected configuration port - the same seam
 * the settings panel injects through - because in this jest environment
 * the real configuration controller has no transport to answer it, and a
 * hanging load would prove nothing about drafts.
 *
 * NOTHING HERE IS A HARDWARE CLAIM. Scripted boards are models.
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
import {MotorsScreenView} from './MotorsScreen';
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
import type {
  MotorConfigurationDraft,
  MotorConfigurationSnapshot,
} from '../../core/state/motorConfigurationModel';
import type {MotorTestControllerSnapshot} from '../../core/state/motorTestController';
import type {MotorTestOperatorPort} from '../../platforms/react-native/protocol';
import type {MotorAirframeControlsPort} from './MotorAirframeControls';

const SESSION_ID = 'final-workspace-session';

/** Betaflight `mixerMode_e`, from the pinned firmware's mixer.h. */
const MIXER_TRI = 1;
const MIXER_QUADX = 3;
const MIXER_Y6 = 6;
const MIXER_CUSTOM = 23;

const u16 = (value: number) => [value & 0xff, (value >> 8) & 0xff];

function board(
  mixerMode: number,
  motorCount: number,
  propsOut = false,
): ScriptedMotorFcOptions {
  return {
    payloads: new Map<number, Uint8Array>([
      [MSP_MIXER_CONFIG, Uint8Array.from([mixerMode, propsOut ? 1 : 0])],
      [
        MSP_MOTOR_CONFIG,
        Uint8Array.from([
          ...u16(1070), ...u16(2000), ...u16(1000),
          motorCount,
          14, 0, 0,
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
  const all = (testID: string) =>
    renderer.root.findAll(candidate => candidate.props?.testID === testID);
  const find = (testID: string, handler: 'onPress' | 'onValueChange' | 'onChange') =>
    all(testID).find(candidate => typeof candidate.props?.[handler] === 'function');
  return {
    renderer,
    all,
    has: (testID: string) => all(testID).length > 0,
    press: (testID: string) => {
      const node = find(testID, 'onPress');
      if (node === undefined) throw new Error(`no pressable "${testID}"`);
      ReactTestRenderer.act(() => node.props.onPress());
    },
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

async function liveMotorsScreen(
  mixerMode: number,
  motorCount: number,
  propsOut = false,
) {
  const shell = renderShell();
  renderers.push(shell.renderer);
  ReactTestRenderer.act(() => {
    transport = new FakeMspTransport();
    fc = new ScriptedMotorFc(transport, board(mixerMode, motorCount, propsOut));
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

/* ================================================================== *
 * LIVE SESSION - the real path over a scripted board
 * ================================================================== */

describe('M-F2 - expected rotation, from the yaw column and the stored flag', () => {
  it('a props-in QUAD X marks all four rotors, and speaks them as EXPECTED', async () => {
    const shell = await liveMotorsScreen(MIXER_QUADX, 4, false);
    for (const slot of [1, 2, 3, 4]) {
      expect(shell.has(`motors-expected-rotation-${slot}`)).toBe(true);
    }
    // The selected motor's line says which way, in words, labelled as
    // the EXPECTATION - M1 is REAR_R, props-in, so clockwise.
    const rendered = shell.text();
    expect(rendered).toContain(
      `${ar.motorsScreen.expectedRotationLabel}: ${ar.motorsScreen.expectedRotationCw}`,
    );
    // The one phrase the three-truths model exists to prevent.
    expect(rendered).not.toContain('الاتجاه الحالي هو');
  });

  it('the props-out build flips the words for the same motor', async () => {
    const shell = await liveMotorsScreen(MIXER_QUADX, 4, true);
    expect(shell.text()).toContain(
      `${ar.motorsScreen.expectedRotationLabel}: ${ar.motorsScreen.expectedRotationCcw}`,
    );
  });

  it('a tricopter draws NO rotation marks - its mixer does not determine any', async () => {
    const shell = await liveMotorsScreen(MIXER_TRI, 3);
    expect(shell.has('motors-airframe-stage')).toBe(true);
    for (const slot of [1, 2, 3]) {
      expect(shell.has(`motors-expected-rotation-${slot}`)).toBe(false);
    }
    // No selected-motor expectation line either - the TRI yaw column is
    // all zeros, so there is no source and no claim. (The stage caption
    // may still NAME the label while explaining where arrows come from,
    // so the assertion is the line's testID and the direction words, not
    // a bare label scan.)
    expect(shell.has('motor-identity-expected-rotation')).toBe(false);
    const rendered = shell.text();
    expect(rendered).not.toContain(ar.motorsScreen.expectedRotationCw);
    expect(rendered).not.toContain(ar.motorsScreen.expectedRotationCcw);
    // The tail servo is still named as a servo, never a motor.
    expect(shell.has('motors-diagram-servo')).toBe(true);
  });

  it('a Y6 is SIX independent marked motors: coaxial pairs counter-rotate on one arm', async () => {
    /* M-F3 §24/§26/§51 - the merged "M1/4" disc is gone. Every motor has
     * its own selectable node AND its own expected-rotation mark; the
     * hand-written directions below are the transcribed mixerY6 yaw
     * column [+1,-1,-1,-1,+1,+1] read through the props-in convention
     * (yaw < 0 -> CW), so each coaxial pair shows two OPPOSITE marks. */
    const shell = await liveMotorsScreen(MIXER_Y6, 6);
    expect(shell.has('motors-airframe-stage')).toBe(true);
    const markIcon = (slot: number): string => {
      const marks = shell.all(`motors-expected-rotation-${slot}`);
      expect(marks.length).toBeGreaterThan(0);
      const icons = marks[0].findAll(
        candidate =>
          candidate.props?.name === 'rotate-cw' ||
          candidate.props?.name === 'rotate-ccw',
      );
      expect(icons.length).toBeGreaterThan(0);
      return icons[0].props.name as string;
    };
    expect(markIcon(1)).toBe('rotate-ccw'); // REAR upper, yaw +1
    expect(markIcon(2)).toBe('rotate-cw'); //  RIGHT upper, yaw -1
    expect(markIcon(3)).toBe('rotate-cw'); //  LEFT upper, yaw -1
    expect(markIcon(4)).toBe('rotate-cw'); //  UNDER_REAR, yaw -1
    expect(markIcon(5)).toBe('rotate-ccw'); // UNDER_RIGHT, yaw +1
    expect(markIcon(6)).toBe('rotate-ccw'); // UNDER_LEFT, yaw +1
    // Each motor is its own touch target - M4 selectable without M1.
    for (const slot of [1, 2, 3, 4, 5, 6]) {
      expect(shell.has(`motors-airframe-slot-${slot}`)).toBe(true);
    }
    // The selected motor (M1, REAR upper, yaw +1, default flag) still
    // gets its expectation in words on the identity line.
    expect(shell.text()).toContain(
      `${ar.motorsScreen.expectedRotationLabel}: ${ar.motorsScreen.expectedRotationCcw}`,
    );
  });
});

describe('M-F2 §16 - ONE expected-rotation truth across the whole screen', () => {
  it('the direction tool and the identity line agree on a props-in build', async () => {
    /* THE DEFECT THE MANUAL SCREENSHOT REVIEW FOUND. The direction tool
     * used to print its expectation from the shipped PROPS-OUT template
     * while the drawing derived from the STORED flag - so a props-in
     * Quad X showed "M1 expected CW" beside the aircraft and "M1
     * expected CCW" inside the direction tool, on one screen. Both rows
     * now consume the same derivation; on this props-in board M1's word
     * is CW in both places, and the props-out word appears nowhere. */
    const shell = await liveMotorsScreen(MIXER_QUADX, 4, false);
    shell.press('motors-open-direction');
    const expectedRow = shell
      .all('motor-direction-expected')
      .flatMap(node =>
        typeof node.props.children === 'string' ? [node.props.children] : [],
      )
      .join(' ');
    expect(expectedRow).toContain(ar.motorVerification.direction.CW);
    expect(expectedRow).not.toContain(ar.motorVerification.direction.CCW);
    // And the identity line beside the drawing says the same thing.
    expect(shell.text()).toContain(
      `${ar.motorsScreen.expectedRotationLabel}: ${ar.motorsScreen.expectedRotationCw}`,
    );
  });
});

describe('M-F2 - the primary tools are one click, on the primary surface', () => {
  it('direction and reorder open from their own labelled buttons, no disclosure', async () => {
    const shell = await liveMotorsScreen(MIXER_QUADX, 4);

    expect(shell.has('motors-airframe-controls')).toBe(true);
    expect(shell.has('motors-mixer-select')).toBe(true);
    expect(shell.has('motors-props-direction')).toBe(true);

    expect(shell.has('motor-direction-section')).toBe(false);
    shell.press('motors-open-direction');
    expect(shell.has('motors-direction-tool')).toBe(true);
    expect(shell.has('motor-direction-section')).toBe(true);

    expect(shell.has('motor-output-mapping-section')).toBe(false);
    shell.press('motors-open-reorder');
    expect(shell.has('motors-reorder-tool')).toBe(true);
    expect(shell.has('motor-output-mapping-section')).toBe(true);

    // And the advanced disclosure was never touched to get here.
    expect(shell.has('motors-advanced-verification')).toBe(false);
  });

  it('a CUSTOM mixer keeps the strip, the tools and the numbered workspace', async () => {
    const shell = await liveMotorsScreen(MIXER_CUSTOM, 5);
    expect(shell.has('motors-airframe-controls')).toBe(true);
    expect(shell.has('motors-open-direction')).toBe(true);
    expect(shell.has('motors-open-reorder')).toBe(true);
    expect(shell.has('motors-airframe-stage')).toBe(false);
    expect(shell.has('motor-slider-5')).toBe(true);
    // No expected rotation for rows the firmware keeps CLI-side.
    expect(shell.text()).not.toContain(ar.motorsScreen.expectedRotationLabel);
  });
});

describe('M-F2 §4/§55 - the model is permanent orientation context', () => {
  it('stays on screen at READY, while commanding, and after the session closes', async () => {
    const shell = await liveMotorsScreen(MIXER_QUADX, 4);
    expect(shell.has('motors-airframe-stage')).toBe(true);

    // Motor control granted, master driven - a command may now be live.
    shell.poke('motor-workspace-enable', 'onValueChange', true);
    await settle(10);
    shell.poke('motor-slider-master', 'onChange', 1200);
    await settle(10);
    expect(shell.has('motors-airframe-stage')).toBe(true);

    // Stop, then close the session entirely.
    shell.press('motors-stop-button');
    await settle(20);
    expect(shell.has('motors-airframe-stage')).toBe(true);

    shell.poke('motor-session-toggle', 'onValueChange', false);
    await settle(40);
    /*
     * THE SESSION IS CLOSED AND THE AIRCRAFT IS STILL THERE. The last
     * published snapshot keeps the topology the session read; closing a
     * session removes the ability to command, not the knowledge of what
     * the aircraft is.
     */
    expect(shell.has('motors-airframe-stage')).toBe(true);
  });
});

/* ================================================================== *
 * COMPONENT LEVEL - the real MotorsScreenView with an injected port
 * ================================================================== */

const QUADX_CONFIG_SNAPSHOT = {
  feature: {feature3dEnabled: false, escSensorEnabled: false, motorStopEnabled: true, raw: 0x10},
  mixer: {mixerModeRaw: MIXER_QUADX, yawMotorsReversedConfigured: false, yawMotorsReversedRaw: 0},
  motor: {
    deprecatedMinThrottle: 1070, maxThrottle: 2000, minCommand: 1000,
    motorCount: 4, motorPoleCount: 14,
    dshotTelemetryEnabled: false, escSensorEnabled: false,
  },
  motor3d: {deadband3dLow: 1406, deadband3dHigh: 1514, neutral3d: 1460},
  advanced: {
    gyroSyncDenom: 1, pidProcessDenom: 1, useContinuousUpdate: false,
    motorProtocolRaw: 6, motorPwmRate: 480, motorIdleRaw: 550,
    gyroUse32kHz: false, motorInversion: false, gyroToUse: 0,
    gyroHighFsr: false, gyroMovementCalibrationThreshold: 32,
    gyroCalibrationDuration: 125, gyroOffsetYaw: 0, checkOverflow: 0,
    debugModeRaw: 0, debugModeCount: 60,
  },
} as unknown as MotorConfigurationSnapshot;

function fakeConfigPort(): MotorAirframeControlsPort & {
  savedDrafts: MotorConfigurationDraft[];
  rebootRequests: number[];
} {
  const savedDrafts: MotorConfigurationDraft[] = [];
  const rebootRequests: number[] = [];
  return {
    savedDrafts,
    rebootRequests,
    load: async () => ({kind: 'LOADED', snapshot: QUADX_CONFIG_SNAPSHOT}),
    save: async (_sessionId, _original, draft) => {
      savedDrafts.push(draft);
      return {
        kind: 'SAVED_VERIFIED',
        snapshot: QUADX_CONFIG_SNAPSHOT,
        rebootRequired: true,
        changedGroups: ['MIXER'],
      };
    },
    requestReboot: async () => {
      rebootRequests.push(rebootRequests.length + 1);
      return {kind: 'REBOOT_REQUESTED', acknowledged: true};
    },
  };
}

function mountView(port: MotorAirframeControlsPort) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <MotorsScreenView
        operator={undefined}
        sessionId={SESSION_ID}
        onRequestLeave={() => undefined}
        airframeConfigPort={port}
      />,
    );
  });
  renderers.push(renderer);
  const all = (testID: string) =>
    renderer.root.findAll(candidate => candidate.props?.testID === testID);
  return {
    renderer,
    all,
    has: (testID: string) => all(testID).length > 0,
    press: (testID: string) => {
      const node = all(testID).find(
        candidate => typeof candidate.props?.onPress === 'function',
      );
      if (node === undefined) throw new Error(`no pressable "${testID}"`);
      ReactTestRenderer.act(() => node.props.onPress());
    },
  };
}

async function flush() {
  await ReactTestRenderer.act(async () => {
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 1));
  });
}

describe('M-F2 §32/§60-1 - session OFF, model ON', () => {
  it('renders the QUAD X from the configuration read with no operator at all', async () => {
    const view = mountView(fakeConfigPort());
    await flush();
    // No session, no operator - and the aircraft, its front marker and
    // its rotation marks are on screen from the stored configuration.
    expect(view.has('motors-airframe-stage')).toBe(true);
    expect(view.has('motors-diagram-front')).toBe(true);
    expect(view.has('motors-expected-rotation-1')).toBe(true);
    // The strip shows the stored mixer by name.
    expect(view.has('motors-mixer-select')).toBe(true);
    // And nothing pretends to be commandable: no readiness strip.
    expect(view.has('motors-session-ready')).toBe(false);
  });
});

describe('M-F3 §3-§7/§56 - a tap is a visible draft, ONE save transaction, companions preserved', () => {
  it('a mixer change is a labelled draft first, then ONE transaction carrying the CURRENT props flag', async () => {
    const port = fakeConfigPort();
    const view = mountView(port);
    await flush();

    view.press('motors-mixer-select');
    view.press('motors-mixer-select-option-10'); // HEX6X
    // P0-1's fix, asserted: the tap changed the SCREEN immediately - a
    // dirty save bar exists and nothing has touched the link.
    expect(port.savedDrafts).toHaveLength(0);
    expect(view.has('motors-airframe-savebar')).toBe(true);
    expect(view.has('motors-airframe-savebar-mixer')).toBe(true);
    // §33: while the mixer draft exists the drawing is a labelled preview.
    expect(view.has('motors-topology-preview-label')).toBe(true);
    view.press('motors-airframe-save');
    await flush();

    expect(port.savedDrafts).toHaveLength(1);
    const draft = port.savedDrafts[0];
    expect(draft.mixerModeRaw).toBe(10);
    // THE PRESERVATION CLAIM: props flag and every other owned field come
    // from the loaded snapshot, untouched.
    expect(draft.yawMotorsReversed).toBe(false);
    expect(draft.motorProtocolRaw).toBe(6);
    expect(draft.motorPoleCount).toBe(14);
    // Saved and verified: the bar is gone and the reboot step is offered.
    expect(view.has('motors-airframe-savebar')).toBe(false);
    expect(view.has('motors-airframe-reboot')).toBe(true);
  });

  it('a props tap moves the chip IMMEDIATELY, and the save carries the CURRENT mixer', async () => {
    const port = fakeConfigPort();
    const view = mountView(port);
    await flush();

    view.press('motors-props-out');
    // P0-1: «للخارج» is now the selected chip BEFORE any save - the draft
    // is the display truth of the control that edits it.
    const outChip = view
      .all('motors-props-out')
      .find(node => node.props?.accessibilityState !== undefined);
    expect(outChip?.props.accessibilityState.selected).toBe(true);
    expect(port.savedDrafts).toHaveLength(0);
    expect(view.has('motors-airframe-savebar-props')).toBe(true);
    view.press('motors-airframe-save');
    await flush();

    expect(port.savedDrafts).toHaveLength(1);
    const draft = port.savedDrafts[0];
    expect(draft.yawMotorsReversed).toBe(true);
    expect(draft.mixerModeRaw).toBe(MIXER_QUADX);
  });

  it('mixer AND props drafted together save as ONE transaction with both fields', async () => {
    const port = fakeConfigPort();
    const view = mountView(port);
    await flush();

    view.press('motors-mixer-select');
    view.press('motors-mixer-select-option-10');
    view.press('motors-props-out');
    expect(port.savedDrafts).toHaveLength(0);
    view.press('motors-airframe-save');
    await flush();

    expect(port.savedDrafts).toHaveLength(1);
    expect(port.savedDrafts[0].mixerModeRaw).toBe(10);
    expect(port.savedDrafts[0].yawMotorsReversed).toBe(true);
  });

  it('preserves values that CANNOT be defaults: props-out survives a mixer edit, HEX6X survives a props edit', async () => {
    // The two tests above prove the draft shape, but their preserved
    // values (props-in, QUAD X) are also what a manufactured draft would
    // contain. This board is props-OUT and HEX6X - if either edit reaches
    // the transaction with the other field at its default, preservation
    // is broken and this fails.
    const snapshot = {
      ...QUADX_CONFIG_SNAPSHOT,
      mixer: {
        mixerModeRaw: 10, // HEX6X
        yawMotorsReversedConfigured: true,
        yawMotorsReversedRaw: 1,
      },
      motor: {...(QUADX_CONFIG_SNAPSHOT as {motor: object}).motor, motorCount: 6},
    } as unknown as MotorConfigurationSnapshot;
    const saved: MotorConfigurationDraft[] = [];
    const port: MotorAirframeControlsPort = {
      load: async () => ({kind: 'LOADED', snapshot}),
      save: async (_sessionId, _original, draft) => {
        saved.push(draft);
        return {
          kind: 'SAVED_VERIFIED',
          snapshot,
          rebootRequired: true,
          changedGroups: ['MIXER'],
        };
      },
      requestReboot: async () => ({kind: 'REBOOT_REQUESTED', acknowledged: true}),
    };
    const view = mountView(port);
    await flush();

    // Mixer edit: HEX6X -> QUAD X. The props flag must arrive TRUE.
    view.press('motors-mixer-select');
    view.press(`motors-mixer-select-option-${MIXER_QUADX}`);
    view.press('motors-airframe-save');
    await flush();
    expect(saved).toHaveLength(1);
    expect(saved[0].mixerModeRaw).toBe(MIXER_QUADX);
    expect(saved[0].yawMotorsReversed).toBe(true);

    // Props edit: out -> in. The mixer must arrive as HEX6X.
    view.press('motors-props-in');
    view.press('motors-airframe-save');
    await flush();
    expect(saved).toHaveLength(2);
    expect(saved[1].yawMotorsReversed).toBe(false);
    expect(saved[1].mixerModeRaw).toBe(10);
  });

  it('discard sends nothing at all, and the drafted chip returns to the stored value', async () => {
    const port = fakeConfigPort();
    const view = mountView(port);
    await flush();

    view.press('motors-props-out');
    expect(view.has('motors-airframe-savebar')).toBe(true);
    view.press('motors-airframe-discard');
    await flush();
    expect(port.savedDrafts).toHaveLength(0);
    expect(view.has('motors-airframe-savebar')).toBe(false);
    const inChip = view
      .all('motors-props-in')
      .find(node => node.props?.accessibilityState !== undefined);
    expect(inChip?.props.accessibilityState.selected).toBe(true);
  });

  it('a verified save is PERSISTED_VERIFIED wording plus the explicit reboot step - never "active"', async () => {
    const port = fakeConfigPort();
    const view = mountView(port);
    await flush();
    view.press('motors-props-out');
    view.press('motors-airframe-save');
    await flush();
    const outcome = view
      .all('motors-quick-outcome')
      .flatMap(node => node.findAllByType(Text))
      .map(node => String(node.props.children ?? ''))
      .join(' ');
    expect(outcome).toContain(ar.motorsScreen.quickSavedVerified);
    // §36: the reboot is ITS OWN acknowledged step through the same
    // controller, not a silent side effect of saving.
    expect(port.rebootRequests).toHaveLength(0);
    view.press('motors-airframe-reboot');
    await flush();
    expect(port.rebootRequests).toHaveLength(1);
    const afterReboot = view
      .all('motors-quick-outcome')
      .flatMap(node => node.findAllByType(Text))
      .map(node => String(node.props.children ?? ''))
      .join(' ');
    expect(afterReboot).toContain(ar.motorsScreen.quickRebootRequested);
  });
});

/* ================================================================== *
 * THE SEAM M-F2 MUST NOT CROSS - display fallback vs M-E3 command truth
 * ================================================================== */

describe('M-F2 §40 - the display fallback never leaks into command identity', () => {
  /**
   * THE ONE STATE WHERE THE TWO SOURCES DISAGREE. An ACTIVE session that
   * has read NOTHING (M-E3's CASE A) alongside a configuration read that
   * SUCCEEDED. On the wire this needs a board that answers one path and
   * not the other - a scripted board answers both or neither - so the
   * seam is exercised by injection: a nothing-read operator snapshot plus
   * a LOADED configuration port, both real production shapes.
   *
   * WHAT MUST HOLD, per the frozen M-E3 contract: the configuration read
   * may DRAW the aircraft (§4 - the model is orientation context), and
   * must never make a motor commandable, name one ready, or soften the
   * hold wording. If a refactor routes displaySlots into identitySlots,
   * this test renders four sliders and a live hold label - and fails.
   */
  function nothingReadActiveSnapshot(): MotorTestControllerSnapshot {
    return {
      phase: 'ACTIVE',
      setupStep: 'READY',
      machine: {name: 'Ready', startAcknowledged: false},
      outcome: {kind: 'READY'},
      firmwareCompatibility: undefined,
      // NOTHING READ: no scope, no mixer byte, no diagnostics support.
      motorScope: undefined,
      mixerModeRaw: undefined,
      yawMotorsReversedConfigured: undefined,
      motorDiagnosticsSupport: undefined,
      armedStateEvidence: 'FRESH_DISARMED',
      motorDomain: undefined,
      motorRuntimeScope: undefined,
      telemetryHeld: true,
      // What the real controller publishes for an unread scope: refused
      // activation, reported as link unavailability - "your setup is
      // unsupported" would be a claim about a configuration nobody read
      // (motorTestController, activation step 3).
      activation: {allowed: false, reasons: ['CONTROLLER_LINK_UNAVAILABLE']},
      pulse: {motorNumber: undefined, mayBeLive: false},
      stopExecution: {
        outcome: undefined,
        acknowledged: false,
        mayHaveReachedFc: false,
        attributionAmbiguous: false,
        attributionResolvedByConfirmation: false,
      },
      diagnostics: undefined,
      verificationReceipt: undefined,
    } as unknown as MotorTestControllerSnapshot;
  }

  class NothingReadOperator implements MotorTestOperatorPort {
    readonly pulseCalls: number[] = [];
    snapshot = nothingReadActiveSnapshot();
    beginSession = () => Promise.resolve(this.snapshot);
    getSnapshot = () => this.snapshot;
    subscribe = () => () => {};
    pulseMotor = (motorNumber: number) => {
      this.pulseCalls.push(motorNumber);
      return 'ACCEPTED' as never;
    };
    renewPulseHold = () => 'NO_ACTIVE_PULSE' as never;
    requestStop = () => 'ACCEPTED' as never;
    setEscDirection = () => Promise.resolve(undefined as never);
    refreshDiagnostics = () =>
      Promise.resolve(undefined as never);
    endSession = () => Promise.resolve(this.snapshot);
    setMotorValues = () => undefined as never;
    setMotorValue = () => undefined as never;
    setMaster = () => undefined as never;
    stopAll = () => undefined as never;
  }

  it('draws the configured aircraft, and still refuses to name a commandable motor', async () => {
    const operator = new NothingReadOperator();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <MotorsScreenView
          operator={operator}
          sessionId={SESSION_ID}
          onRequestLeave={() => undefined}
          airframeConfigPort={{
            load: async () => ({
              kind: 'LOADED',
              snapshot: QUADX_CONFIG_SNAPSHOT,
            }),
            save: async () => {
              throw new Error('no save in this scenario');
            },
            requestReboot: async () => {
              throw new Error('no reboot in this scenario');
            },
          }}
        />,
      );
    });
    renderers.push(renderer);
    await ReactTestRenderer.act(async () => {
      await Promise.resolve();
      await new Promise(resolve => setTimeout(resolve, 1));
    });

    const has = (testID: string) =>
      renderer.root.findAll(node => node.props?.testID === testID).length > 0;
    const textOf = () =>
      renderer.root
        .findAllByType(Text)
        .map(node => {
          const value = node.props.children;
          return Array.isArray(value) ? value.join('') : String(value ?? '');
        })
        .join('\n');

    // §4: the stored configuration DRAWS the aircraft.
    expect(has('motors-airframe-stage')).toBe(true);
    expect(has('motors-diagram-front')).toBe(true);

    // M-E3, frozen: no slider exists for a motor the session never read.
    for (const slot of [1, 2, 3, 4]) {
      expect(has(`motor-slider-${slot}`)).toBe(false);
    }
    // The hold keeps its no-scope wording and its count-unread reason.
    const rendered = textOf();
    expect(rendered).toContain(ar.motorsScreen.holdToTestNoScope);
    expect(rendered).toContain(ar.motorsScreen.holdBlockedCountUnread);
    // And no readiness line names M1 ready.
    expect(rendered).not.toContain('جاهزة M1');
    expect(operator.pulseCalls).toEqual([]);
  });
});
