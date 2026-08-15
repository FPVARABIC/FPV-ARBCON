/**
 * THE SCREEN MUST NOT PRESENT AN ASSUMPTION AS A READING.
 *
 * Three separate claims were being made without evidence, and each one is
 * pinned here.
 *
 * 1. ESC DIRECTION. The panel opened with NORMAL already selected. Nothing
 *    had read NORMAL: the audited firmware has no command that reports ESC
 *    spin direction, the setting lives inside the ESC rather than in flight
 *    controller configuration, and `MSP2_SEND_DSHOT_COMMAND` returns none.
 *    A preselected option on a write-only control is a default impersonating
 *    a state, on the one control that decides which way a propeller turns.
 *
 * 2. M-NUMBER IDENTITY. The screen said M numbers match flight controller
 *    outputs in the same order. That holds only while the output reordering
 *    array is identity - which is exactly the thing the reorder workflow
 *    exists to change - and the screen never reads it.
 *
 * 3. QUAD-X PHYSICAL IDENTITY. Motor CONTROL is already dynamic, but the
 *    identification model describes four arms of a Quad X. On a hex or an
 *    octo the screen asked which of four Quad-X arms a motor sat on, and
 *    then offered to write an output map derived from those answers.
 *
 * WHAT THESE TESTS DO NOT CLAIM. Nothing here is hardware evidence. No MSP
 * exchange happens, no motor turns, and the ESC direction path in
 * particular remains unverifiable by any software: whether an ESC applied a
 * command, and which way a motor physically turns, stays a hardware test on
 * both platforms.
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import '../../i18n';
import i18n from '../../i18n';
import ar from '../../i18n/locales/ar.json';
import {
  evaluateMotorIdentificationCapability,
  MOTOR_IDENTIFICATION_MODEL_OUTPUT_COUNT,
} from '../../core/state/motorIdentificationCapability';
import {deriveMotorOutputOrder} from '../../core/state/motorOutputReordering';
import {EMPTY_VERIFICATION_STATE} from '../../core/state/motorVerificationModel';
import type {
  MotorTestControllerSnapshot,
  MotorTestVerificationReceipt,
} from '../../core/state/motorTestController';
import type {MotorTestOperatorPort} from '../../platforms/react-native/protocol';
import {EscDirectionPanel} from './EscDirectionPanel';

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await i18n.init();
  }
});

function textOf(tree: ReactTestRenderer.ReactTestRenderer): string {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node !== null && typeof node === 'object') {
      visit((node as {children?: unknown}).children);
    }
  };
  visit(tree.toJSON());
  return out.join(' ');
}

/* ================================================================== *
 * 1. ESC DIRECTION - UNKNOWN IS THE STARTING STATE
 * ================================================================== */

function directionPort(): MotorTestOperatorPort {
  const snapshot = {
    activation: {allowed: true, reasons: []},
  } as unknown as MotorTestControllerSnapshot;
  return {
    beginSession: async () => snapshot,
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    pulseMotor: () => 'GATES_NOT_SATISFIED',
    renewPulseHold: () => 'NO_ACTIVE_PULSE',
    setEscDirection: jest.fn(async (motorNumber, direction) => ({
      kind: 'ACKNOWLEDGED' as const,
      motorNumber,
      direction,
      physicallyVerified: false as const,
    })),
    refreshDiagnostics: async () => ({
      outputs: {state: 'WAITING', value: undefined, observedAtMillis: undefined},
      escTelemetry: {
        state: 'WAITING',
        value: undefined,
        observedAtMillis: undefined,
      },
    }),
    requestStop: () => 'ACCEPTED',
    setMotorValues: () => ({kind: 'REFUSED' as const, reason: 'NOT_COMMANDABLE' as const}),
    setMotorValue: () => ({kind: 'REFUSED' as const, reason: 'NOT_COMMANDABLE' as const}),
    setMaster: () => ({kind: 'REFUSED' as const, reason: 'NOT_COMMANDABLE' as const}),
    stopAll: () => 'ACCEPTED' as const,
    endSession: async () => snapshot,
  } as unknown as MotorTestOperatorPort;
}

async function mountDirection(
  motor = 1,
  port: MotorTestOperatorPort = directionPort(),
): Promise<{tree: ReactTestRenderer.ReactTestRenderer; port: MotorTestOperatorPort}> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <EscDirectionPanel selectedMotor={motor} operator={port} />,
    );
  });
  return {tree, port};
}

function optionSelected(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): boolean | undefined {
  return tree.root.findByProps({testID}).props.accessibilityState?.selected;
}

describe('A/B - ESC direction starts UNKNOWN and claims no firmware read', () => {
  it('preselects NEITHER direction on mount', async () => {
    const {tree} = await mountDirection();
    // The precise regression: `useState('NORMAL')` made this true.
    expect(optionSelected(tree, 'esc-direction-normal')).toBe(false);
    expect(optionSelected(tree, 'esc-direction-reversed')).toBe(false);
    act(() => tree.unmount());
  });

  it('says outright that the current direction cannot be read', async () => {
    const {tree} = await mountDirection();
    expect(
      tree.root.findAllByProps({testID: 'esc-direction-current-unknown'}).length,
    ).toBeGreaterThan(0);
    expect(textOf(tree)).toContain(ar.escDirection.currentUnknown);
    act(() => tree.unmount());
  });

  it('offers no commanded record before any command has been sent', async () => {
    const {tree} = await mountDirection();
    expect(
      tree.root.findAllByProps({testID: 'esc-direction-commanded'}).length,
    ).toBe(0);
    act(() => tree.unmount());
  });

  it('cannot be sent until a target is chosen', async () => {
    const {tree} = await mountDirection();
    expect(
      tree.root.findByProps({testID: 'esc-direction-review'}).props.disabled,
    ).toBe(true);
    expect(textOf(tree)).toContain(ar.escDirection.targetNotSelected);
    act(() => tree.unmount());
  });

  it('sends nothing if apply is somehow reached with no target', async () => {
    const {tree, port} = await mountDirection();
    // Belt and braces: the button is disabled, and the handler refuses too.
    await act(async () => {
      await tree.root
        .findByProps({testID: 'esc-direction-review'})
        .props.onPress();
    });
    expect(port.setEscDirection).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });
});

describe('C/E - each direction is an explicit operator choice', () => {
  it.each([
    ['esc-direction-normal', 'esc-direction-reversed', 'NORMAL'],
    ['esc-direction-reversed', 'esc-direction-normal', 'REVERSED'],
  ])('selecting %s selects only it', async (chosen, other) => {
    const {tree} = await mountDirection();
    act(() => tree.root.findByProps({testID: chosen}).props.onPress());
    expect(optionSelected(tree, chosen)).toBe(true);
    expect(optionSelected(tree, other)).toBe(false);
    // And only now may a command be prepared.
    expect(
      tree.root.findByProps({testID: 'esc-direction-review'}).props.disabled,
    ).toBe(false);
    act(() => tree.unmount());
  });
});

describe('D - an acknowledgement is a COMMAND fact, never a physical one', () => {
  it('records what was commanded, under a heading that is not "current"', async () => {
    const {tree, port} = await mountDirection(2);
    act(() => {
      tree.root.findByProps({testID: 'esc-direction-normal'}).props.onPress();
      tree.root.findByProps({testID: 'esc-direction-review'}).props.onPress();
    });
    await act(async () => {
      await tree.root
        .findByProps({testID: 'esc-direction-apply'})
        .props.onPress();
    });
    expect(port.setEscDirection).toHaveBeenCalledWith(2, 'NORMAL');

    const rendered = textOf(tree);
    expect(
      tree.root.findAllByProps({testID: 'esc-direction-commanded'}).length,
    ).toBeGreaterThan(0);
    expect(rendered).toContain(ar.escDirection.commandedTitle);
    // The commanded copy must itself deny being a reading or a measurement.
    expect(ar.escDirection.commandedBody).toContain('وليس قراءة للاتجاه الحالي');
    expect(ar.escDirection.commandedBody).toContain('ولا إثباتًا لدوران فعلي');
    // The unreadable-state notice does not disappear once a command lands.
    expect(rendered).toContain(ar.escDirection.currentUnknown);
    act(() => tree.unmount());
  });

  it('discards target and commanded record when the output changes', async () => {
    const port = directionPort();
    const {tree} = await mountDirection(1, port);
    act(() => {
      tree.root.findByProps({testID: 'esc-direction-reversed'}).props.onPress();
    });
    await act(async () => {
      tree.root.findByProps({testID: 'esc-direction-review'}).props.onPress();
    });
    await act(async () => {
      await tree.root
        .findByProps({testID: 'esc-direction-apply'})
        .props.onPress();
    });
    expect(
      tree.root.findAllByProps({testID: 'esc-direction-commanded'}).length,
    ).toBeGreaterThan(0);

    await act(async () => {
      tree.update(<EscDirectionPanel selectedMotor={2} operator={port} />);
    });
    // A command acknowledged for M1 is not a fact about M2, and a target
    // chosen for M1 is not one either.
    expect(
      tree.root.findAllByProps({testID: 'esc-direction-commanded'}).length,
    ).toBe(0);
    expect(optionSelected(tree, 'esc-direction-normal')).toBe(false);
    expect(optionSelected(tree, 'esc-direction-reversed')).toBe(false);
    act(() => tree.unmount());
  });
});

describe('F - the unsupported message describes the real gate', () => {
  it('no longer claims the feature requires four motors', () => {
    expect(ar.escDirection.unsupported).not.toContain('أربعة محركات');
  });

  it('names the conditions the controller actually checks', () => {
    const copy = ar.escDirection.unsupported;
    // Motor within the reported count, DShot family, 3D off, session,
    // disarmed - the five things setEscDirection actually requires.
    expect(copy).toContain('عدد المحركات');
    expect(copy).toContain('DSHOT600');
    expect(copy).toContain('3D');
    expect(copy).toContain('جلسة');
    expect(copy).toContain('غير مسلّح');
  });
});

/* ================================================================== *
 * 2. M-NUMBER / OUTPUT IDENTITY
 * ================================================================== */

describe('G - M numbers are addressing, not an output-assignment claim', () => {
  it('no longer asserts that M numbers match FC outputs in the same order', () => {
    expect(ar.motorsScreen.numberingNotice).not.toContain(
      'تطابق مخارج متحكم الطيران بالترتيب نفسه',
    );
  });

  it('names the two concepts separately, and says the mapping may differ', () => {
    const copy = ar.motorsScreen.numberingNotice;
    expect(copy).toContain('منطقية');
    expect(copy).toContain('تخطيط منفصل');
    expect(copy).toContain('مُعاد ترتيبه');
  });
});

/* ================================================================== *
 * 3. THE QUAD-X CAPABILITY GATE
 * ================================================================== */

describe('the identification capability rule', () => {
  it('describes exactly the four outputs the shipped model covers', () => {
    expect(MOTOR_IDENTIFICATION_MODEL_OUTPUT_COUNT).toBe(4);
  });

  it('treats a missing count as UNKNOWN, never as a quad', () => {
    expect(evaluateMotorIdentificationCapability(undefined)).toEqual({
      kind: 'UNSUPPORTED',
      reason: 'MOTOR_COUNT_UNKNOWN',
    });
  });

  it.each([0, -1, 4.5, Number.NaN])(
    'treats %p as UNKNOWN rather than coercing it',
    value => {
      expect(evaluateMotorIdentificationCapability(value).kind).toBe(
        'UNSUPPORTED',
      );
    },
  );

  it('supports exactly four', () => {
    expect(evaluateMotorIdentificationCapability(4)).toEqual({
      kind: 'SUPPORTED',
    });
  });

  it.each([1, 2, 3, 5, 6, 8])('reports %i as a mismatch, with the count', n => {
    expect(evaluateMotorIdentificationCapability(n)).toEqual({
      kind: 'UNSUPPORTED',
      reason: 'MOTOR_COUNT_MISMATCH',
      motorCount: n,
    });
  });
});

/* ------------------------------------------------------------------ *
 * The gate, driven through the real screen
 * ------------------------------------------------------------------ */

const SESSION_TOKEN = {};

const RECEIPT: MotorTestVerificationReceipt = {
  sessionToken: SESSION_TOKEN,
  attemptId: 1,
  motorNumber: 1,
  stopEpisodeId: 1,
  pulseAcknowledged: true,
  stopAcknowledged: true,
  attributionAmbiguous: false,
  stopUnsafe: false,
} as unknown as MotorTestVerificationReceipt;

function snapshotWithMotors(motorCount: number): MotorTestControllerSnapshot {
  return {
    phase: 'ACTIVE',
    setupStep: 'READY',
    machine: {name: 'Ready', startAcknowledged: false},
    outcome: {kind: 'READY'},
    firmwareCompatibility: undefined,
    motorScope: {motorCount, motorProtocolRaw: 7, feature3dEnabled: false},
    motorDiagnosticsSupport: {
      motorCount,
      dshotTelemetryEnabled: true,
      escSensorEnabled: false,
      escTelemetrySource: 'BIDIRECTIONAL_DSHOT',
    },
    armedStateEvidence: 'FRESH_DISARMED',
    motorDomain: undefined,
    motorRuntimeScope: undefined,
    telemetryHeld: true,
    activation: {allowed: true, reasons: []},
    pulse: {motorNumber: undefined, mayBeLive: false},
    stopExecution: {
      outcome: undefined,
      acknowledged: false,
      mayHaveReachedFc: false,
      attributionAmbiguous: false,
      attributionResolvedByConfirmation: false,
    },
    diagnostics: undefined,
    verificationReceipt: RECEIPT,
  } as unknown as MotorTestControllerSnapshot;
}

class ScreenPort implements MotorTestOperatorPort {
  readonly pulseCalls: number[] = [];
  constructor(public snapshot: MotorTestControllerSnapshot) {}
  beginSession = () => Promise.resolve(this.snapshot);
  getSnapshot = () => this.snapshot;
  subscribe = () => () => {};
  pulseMotor = (motorNumber: number) => {
    this.pulseCalls.push(motorNumber);
    return 'ACCEPTED' as never;
  };
  renewPulseHold = () => 'RENEWED' as never;
  setEscDirection = () => Promise.resolve(undefined as never);
  refreshDiagnostics = () => Promise.resolve(undefined as never);
  requestStop = () => 'ACCEPTED' as never;
  endSession = () => Promise.resolve(this.snapshot);
  setMotorValues = () => undefined as never;
  setMotorValue = () => undefined as never;
  setMaster = () => undefined as never;
  stopAll = () => undefined as never;
}

/** Mounts the real screen at a given output count, advanced disclosure open. */
function mountScreen(motorCount: number): ReactTestRenderer.ReactTestRenderer {
  const {MotorsScreenView} = require('./MotorsScreen');
  const port = new ScreenPort(snapshotWithMotors(motorCount));
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(
      <MotorsScreenView operator={port} sessionId="fc-session" />,
    );
  });
  act(() =>
    tree.root
      .findAllByProps({testID: 'motors-advanced-verification-toggle'})[0]
      .props.onPress(),
  );
  return tree;
}

describe('H - a four-output aircraft keeps the existing workflow', () => {
  let tree: ReactTestRenderer.ReactTestRenderer;
  beforeEach(() => {
    tree = mountScreen(4);
  });
  afterEach(() => act(() => tree.unmount()));

  it('renders the observation wizard', () => {
    expect(
      tree.root.findAllByProps({testID: 'verification-wizard'}).length,
    ).toBeGreaterThan(0);
  });

  it('shows no unsupported notice', () => {
    expect(
      tree.root.findAllByProps({testID: 'motors-identification-unsupported'})
        .length,
    ).toBe(0);
  });

  it('still states the expected Quad-X reference for the selected output', () => {
    expect(
      tree.root.findAllByProps({
        testID: 'motors-selected-expected-unavailable',
      }).length,
    ).toBe(0);
  });
});

describe('I - a non-quad aircraft is not asked about Quad-X arms', () => {
  let tree: ReactTestRenderer.ReactTestRenderer;
  beforeEach(() => {
    tree = mountScreen(6);
  });
  afterEach(() => act(() => tree.unmount()));

  it('does not render the four-position observation wizard', () => {
    expect(
      tree.root.findAllByProps({testID: 'verification-wizard'}).length,
    ).toBe(0);
  });

  it('explains why, rather than rendering nothing', () => {
    expect(
      tree.root.findAllByProps({testID: 'motors-identification-unsupported'})
        .length,
    ).toBeGreaterThan(0);
    const rendered = textOf(tree);
    expect(rendered).toContain(ar.motorsScreen.identificationQuadOnlyTitle);
    // The reason names the count that was actually read.
    expect(rendered).toContain('6');
  });

  it('withholds the expected Quad-X position for the selected output', () => {
    expect(
      tree.root.findAllByProps({
        testID: 'motors-selected-expected-unavailable',
      }).length,
    ).toBeGreaterThan(0);
    expect(textOf(tree)).toContain(
      ar.motorsScreen.selectedMotorExpectedUnavailable,
    );
  });
});

describe('J - numbered motor control survives an unsupported airframe', () => {
  let tree: ReactTestRenderer.ReactTestRenderer;
  beforeEach(() => {
    tree = mountScreen(6);
  });
  afterEach(() => act(() => tree.unmount()));

  it('keeps the professional workspace mounted', () => {
    expect(
      tree.root.findAllByProps({testID: 'motor-workspace'}).length,
    ).toBeGreaterThan(0);
  });

  it('keeps the session and control rows reachable', () => {
    expect(
      tree.root.findAllByProps({testID: 'motor-session-row'}).length,
    ).toBeGreaterThan(0);
    expect(
      tree.root.findAllByProps({testID: 'motor-workspace-enable'}).length,
    ).toBeGreaterThan(0);
  });

  it('keeps STOP available', () => {
    expect(
      tree.root.findAllByProps({testID: 'motor-workspace-stop'}).length,
    ).toBeGreaterThan(0);
  });

  it('keeps the hold control mounted rather than hard-disabling the screen', () => {
    expect(
      tree.root.findAllByProps({testID: 'motors-hold-button'}).length,
    ).toBeGreaterThan(0);
  });
});

describe('K - no Quad-X output map can be derived on a non-quad aircraft', () => {
  it('does not mount the verification-driven reorder panel at all', () => {
    const tree = mountScreen(6);
    expect(
      tree.root.findAllByProps({testID: 'motor-output-reorder-panel'}).length,
    ).toBe(0);
    // Not merely disabled - there is no prepare action to press.
    expect(
      tree.root.findAllByProps({testID: 'motor-output-reorder-prepare'}).length,
    ).toBe(0);
    act(() => tree.unmount());
  });

  it('does not render the report that compares against Quad-X expectations', () => {
    const tree = mountScreen(6);
    expect(
      tree.root.findAllByProps({testID: 'verification-report'}).length,
    ).toBe(0);
    act(() => tree.unmount());
  });
});

/* ================================================================== *
 * L. THE FULL-VECTOR RULE IS UNCHANGED
 * ================================================================== */

describe('L - outputs beyond the observed four are still carried through', () => {
  it('returns a full-length permutation, never a four-entry short write', () => {
    // Four confirmed observations that happen to be the identity mapping,
    // against an eight-output flight controller.
    const verification = {
      ...EMPTY_VERIFICATION_STATE,
      sessionToken: SESSION_TOKEN,
      entries: [
        {motorNumber: 1, outcome: 'MATCH', attemptId: 1,
          observation: {kind: 'OBSERVED', position: 'REAR_RIGHT', direction: 'CCW'}},
        {motorNumber: 2, outcome: 'MATCH', attemptId: 2,
          observation: {kind: 'OBSERVED', position: 'FRONT_RIGHT', direction: 'CW'}},
        {motorNumber: 3, outcome: 'MATCH', attemptId: 3,
          observation: {kind: 'OBSERVED', position: 'REAR_LEFT', direction: 'CW'}},
        {motorNumber: 4, outcome: 'MATCH', attemptId: 4,
          observation: {kind: 'OBSERVED', position: 'FRONT_LEFT', direction: 'CCW'}},
      ],
    } as never;

    const derived = deriveMotorOutputOrder([0, 1, 2, 3, 4, 5, 6, 7], verification);
    expect(derived.kind).toBe('READY');
    if (derived.kind !== 'READY') {
      return;
    }
    // Full length: a shorter payload would make the firmware reset outputs
    // 5..8 to identity, destroying a mapping this workflow never examined.
    expect(derived.values).toHaveLength(8);
    expect([...derived.values].slice(4)).toEqual([4, 5, 6, 7]);
    expect(new Set(derived.values).size).toBe(8);
  });
});
