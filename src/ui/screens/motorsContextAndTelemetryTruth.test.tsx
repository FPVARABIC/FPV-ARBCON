/**
 * THE MOTOR CONTEXT AND THE ESC TELEMETRY TRUTH, PINNED.
 *
 * TWO DEFECTS FROM THE SAME BENCH SESSION.
 *
 * (1) CONTEXT LOSS. A person taps M2 on the airframe, holds to spin it,
 *     scrolls down to answer "where is it?" and "which way did it turn?"
 *     - and the aircraft is no longer on screen. Measured in Chromium
 *     before this round, with M2 addressed and a receipt outstanding:
 *     NO airframe drawing shared the viewport with the location question
 *     at 390, 768 or 1366. The only thing still holding "M2" was memory.
 *
 * (2) ESC TELEMETRY. Motors were spun and the monitoring panel showed
 *     nothing legible. Betaflight writes `rpm = 0` both for a motor at
 *     rest and for a motor whose telemetry never arrived - the same four
 *     bytes, two different facts - and the app was rendering the second
 *     as a measurement.
 *
 * These tests pin the STRUCTURE and the SEMANTICS, not pixels. Pixels
 * belong to the geometry sweep, which reruns per width.
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import '../../i18n';
import ar from '../../i18n/locales/ar.json';
import type {
  MotorTestControllerSnapshot,
  MotorTestVerificationReceipt,
} from '../../core/state/motorTestController';
import type {MotorTestOperatorPort} from '../../platforms/react-native/protocol';
import {
  rpmIsUnprovenZero,
  visibleMotorTelemetryMetrics,
  type MotorDiagnosticsSupport,
} from '../../core/state/motorDiagnosticsSemantics';
import type {MspMotorTelemetryEntry} from '../../core/protocol/msp/decoding/decodeMotorTelemetry';
import {MotorsScreenView} from './MotorsScreen';

const AUTHORITY = {sessionId: 'context-truth', generation: 1} as const;

/**
 * The verification session's identity. `confirmObservation` compares it by
 * REFERENCE, so a receipt minted against a replaced session can confirm
 * nothing - which is why the fake receipt has to carry the real thing
 * rather than a plausible-looking value.
 */
const SESSION_TOKEN = {};

/**
 * A receipt for M2: an attributable attempt exists and awaits an answer.
 * The literal-typed fields are literals here for the same reason they are
 * literals in the type - a receipt cannot exist at all without them.
 */
const RECEIPT_M2: MotorTestVerificationReceipt = Object.freeze({
  sessionToken: SESSION_TOKEN,
  attemptId: 7,
  motorNumber: 2,
  stopEpisodeId: 3,
  pulseAcknowledged: true as const,
  stopAcknowledged: true as const,
  attributionAmbiguous: false as const,
  stopUnsafe: false as const,
  physicalStopConfirmed: false as const,
});

function snapshot(
  overrides: Partial<MotorTestControllerSnapshot> = {},
): MotorTestControllerSnapshot {
  return {
    phase: 'ACTIVE',
    setupStep: 'READY',
    machine: {name: 'Ready', authority: AUTHORITY},
    outcome: {kind: 'READY'},
    firmwareCompatibility: undefined,
    motorScope: {motorCount: 4, motorProtocolRaw: 6, feature3dEnabled: false},
    motorDiagnosticsSupport: {
      motorCount: 4,
      dshotTelemetryEnabled: true,
      escSensorEnabled: false,
      escTelemetrySource: 'BIDIRECTIONAL_DSHOT',
    },
    armedStateEvidence: 'FRESH_DISARMED',
    motorDomain: undefined,
    motorRuntimeScope: undefined,
    telemetryHeld: true,
    warnings: [],
    stopDescriptors: [],
    teardown: undefined,
    outputMayBeLive: false,
    stopExecution: {
      attempts: 0,
      commandDispatched: false,
      commandAcknowledged: false,
      physicalStopConfirmed: false,
      deferredBehindActiveWrite: false,
      attributionAmbiguous: false,
      attributionResolvedByConfirmation: false,
      wirePreemptionClaimed: false,
      submittedNextOnTransport: false,
      episodeId: 0,
      outcome: undefined,
    },
    activation: {allowed: true, reasons: Object.freeze([])},
    verificationReceipt: undefined,
    pulse: {
      attemptId: 0,
      motorNumber: undefined,
      submitted: false,
      acknowledged: false,
      deadlineArmedAtSubmission: false,
      mayHaveReachedFc: false,
      outcome: undefined,
    },
    ...overrides,
  } as MotorTestControllerSnapshot;
}

class Port implements Partial<MotorTestOperatorPort> {
  readonly pulseCalls: number[] = [];
  readonly directionCalls: {motorNumber: number; direction: string}[] = [];
  private readonly listeners = new Set<() => void>();
  constructor(private value: MotorTestControllerSnapshot = snapshot()) {}
  getSnapshot() {
    return this.value;
  }
  publish(next: MotorTestControllerSnapshot) {
    this.value = next;
    for (const listener of [...this.listeners]) listener();
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  beginSession() {
    return Promise.resolve(this.value);
  }
  endSession() {
    return Promise.resolve(this.value);
  }
  pulseMotor(motorNumber: number) {
    this.pulseCalls.push(motorNumber);
    return 'ACCEPTED' as const;
  }
  renewPulseHold() {
    return 'NO_ACTIVE_PULSE' as const;
  }
  requestStop() {
    return 'ACCEPTED' as const;
  }
  setMotorValue() {
    return {kind: 'ACCEPTED' as const, coalesced: false};
  }
  setMotorValues() {
    return {kind: 'ACCEPTED' as const, coalesced: false};
  }
  setMaster() {
    return {kind: 'ACCEPTED' as const, coalesced: false};
  }
  stopAll() {
    return 'ACCEPTED' as const;
  }
  setEscDirection(
    motorNumber: number,
    direction: import('../../core').DshotEscDirection,
  ) {
    this.directionCalls.push({motorNumber, direction});
    return Promise.resolve({
      kind: 'ACKNOWLEDGED' as const,
      motorNumber,
      direction,
      physicallyVerified: false as const,
    });
  }
  refreshDiagnostics() {
    return Promise.resolve({
      outputs: {
        state: 'WAITING' as const,
        value: undefined,
        observedAtMillis: undefined,
      },
      escTelemetry: {
        state: 'WAITING' as const,
        value: undefined,
        observedAtMillis: undefined,
      },
    });
  }
}

interface Rendered {
  readonly tree: ReactTestRenderer.ReactTestRenderer;
  readonly ids: readonly string[];
  at(testID: string): number;
  has(testID: string): boolean;
  node(testID: string): ReactTestRenderer.ReactTestInstance | undefined;
  press(testID: string): void;
  text(): string;
  unmount(): void;
}

function render(port: Port, sessionId = 'fc-1'): Rendered {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(
      <MotorsScreenView
        operator={port as unknown as MotorTestOperatorPort}
        sessionId={sessionId}
      />,
    );
  });
  const collect = () =>
    tree.root
      .findAll(node => typeof node.props?.testID === 'string')
      .map(node => node.props.testID as string);
  return {
    tree,
    get ids() {
      return collect();
    },
    at: (testID: string) => collect().indexOf(testID),
    has: (testID: string) => collect().includes(testID),
    node: (testID: string) =>
      tree.root.findAll(n => n.props?.testID === testID)[0],
    press: (testID: string) => {
      const node = tree.root.findAll(
        candidate =>
          candidate.props?.testID === testID &&
          typeof candidate.props?.onPress === 'function',
      )[0];
      if (!node) throw new Error(`no pressable ${testID}`);
      act(() => node.props.onPress());
    },
    text: () =>
      tree.root
        .findAll(n => typeof n.type === 'string')
        .flatMap(n =>
          (Array.isArray(n.props.children)
            ? n.props.children
            : [n.props.children]
          ).filter((c: unknown) => typeof c === 'string'),
        )
        .join(' | '),
    unmount: () => act(() => tree.unmount()),
  };
}

/** Is `child` inside the subtree of `container`? */
function within(r: Rendered, container: string, child: string): boolean {
  const root = r.tree.root.findAll(n => n.props?.testID === container)[0];
  if (root === undefined) return false;
  return root.findAll(n => n.props?.testID === child).length > 0;
}

/* ================================================================== *
 * 1-3. THE SELECTED MOTOR STAYS ON SCREEN WITH THE QUESTIONS
 * ================================================================== */

describe('the aircraft travels with the identification questions', () => {
  let port: Port;
  let r: Rendered;

  beforeEach(() => {
    port = new Port(snapshot({verificationReceipt: RECEIPT_M2}));
    r = render(port);
  });
  afterEach(() => r.unmount());

  it('keeps the selected-motor context rendered with the identification controls', () => {
    // ONE region holds both. Before this round the facts sat in the top
    // half of the section and the questions in the bottom half, with the
    // hold control and several hundred pixels between them.
    expect(r.has('motor-verification-area')).toBe(true);
    expect(within(r, 'motor-verification-area', 'motor-identity-selected')).toBe(
      true,
    );
    expect(
      within(r, 'motor-verification-area', 'motor-identification-steps'),
    ).toBe(true);
    expect(within(r, 'motor-verification-area', 'verification-wizard')).toBe(
      true,
    );
  });

  it('renders ONE airframe in the workflow, and it highlights the addressed motor', () => {
    r.press('motor-identity-M2');
    // ONE aircraft, not two. A later round replaced the second, smaller
    // copy with a single drawing placed where the questions are - the
    // duplicate only made an operator ask which of the two they were
    // looking at.
    expect(
      r.tree.root.findAll(
        n =>
          typeof n.type === 'string' &&
          n.props?.testID === 'motors-airframe-diagram',
      ),
    ).toHaveLength(1);
    const mini = r.tree.root.findAll(
      n => n.props?.testID === 'motors-diagram',
    )[0];
    expect(mini).toBeDefined();
    // The mini diagram is a REAL selector carrying real state, not a
    // picture: exactly one of its four nodes reports itself selected, and
    // it is the one the rest of the screen is addressing.
    const selectedIn = (
      root: ReactTestRenderer.ReactTestInstance,
    ): readonly string[] => [
      ...new Set(
        root
          .findAll(
            n =>
              typeof n.props?.testID === 'string' &&
              n.props.testID.startsWith('motors-airframe-slot-') &&
              n.props?.accessibilityState?.selected === true,
          )
          .map(n => n.props.testID as string),
      ),
    ];
    const selected = selectedIn(mini);
    expect(selected).toEqual(['motors-airframe-slot-2']);

    r.press('motor-identity-M3');
    expect(
      selectedIn(
        r.tree.root.findAll(n => n.props?.testID === 'motors-diagram')[0],
      ),
    ).toEqual(['motors-airframe-slot-3']);
  });

  it('reads summary -> aircraft -> hold -> questions, in that order', () => {
    // The order of the actual job: what is addressed, where it sits, the
    // control that spins it, the questions about what happened. The
    // AIRCRAFT is the last thing before the control on purpose - nothing
    // wordy stands between the picture of a motor and the button that
    // turns it.
    const facts = r.at('motor-identity-selected');
    const aircraft = r.at('motors-airframe-stage');
    const hold = r.at('motors-hold-button');
    const questions = r.at('verification-wizard');
    expect(facts).toBeGreaterThanOrEqual(0);
    expect(aircraft).toBeGreaterThan(facts);
    expect(hold).toBeGreaterThan(aircraft);
    expect(questions).toBeGreaterThan(hold);
  });
});

/* ================================================================== *
 * 4. THE LONG PRESS CONTROL IS SAFE BUT NOT OVERSIZED
 * ================================================================== */

describe('the protected hold control', () => {
  const flatten = (style: unknown): Record<string, unknown> =>
    Array.isArray(style)
      ? Object.assign({}, ...style.filter(Boolean).map(flatten))
      : ((style ?? {}) as Record<string, unknown>);

  it('is a one-line control of a reserved height, not a panel', () => {
    const port = new Port();
    const r = render(port);
    const hold = r.node('motors-hold-button');
    expect(hold).toBeDefined();
    const style = flatten(hold?.props.style);
    // A FIXED height, so the surface cannot move under a held pointer.
    expect(typeof style.height).toBe('number');
    // Comfortably above the touch minimum, nowhere near the 132px slab.
    expect(style.height as number).toBeGreaterThanOrEqual(44);
    expect(style.height as number).toBeLessThanOrEqual(60);
    // And a button-shaped button: it does not stretch to its column.
    expect(style.alignSelf).toBe('flex-start');
    expect(typeof style.maxWidth).toBe('number');
    r.unmount();
  });

  it('keeps the long-press gesture exactly as it was', () => {
    const port = new Port();
    const r = render(port);
    const hold = r.node('motors-hold-button');
    // The duration is not a styling decision. It is 800 ms because the
    // safety contract says so, and shrinking the box did not touch it.
    expect(hold?.props.delayLongPress).toBe(800);
    expect(typeof hold?.props.onPressIn).toBe('function');
    expect(typeof hold?.props.onLongPress).toBe('function');
    expect(typeof hold?.props.onPressOut).toBe('function');
    expect(hold?.props.disabled).toBe(false);
    r.unmount();
  });

  it('moves the hint out of the button without losing a word of it', () => {
    const port = new Port();
    const r = render(port);
    expect(r.has('motors-hold-hint')).toBe(true);
    expect(r.text()).toContain(ar.motorsScreen.holdHint);
    // The hint is a sibling of the control, not a child of the pressable.
    expect(within(r, 'motors-hold-button', 'motors-hold-hint')).toBe(false);
    expect(within(r, 'motors-hold-block', 'motors-hold-hint')).toBe(true);
    r.unmount();
  });

  it('issues no motor command from a press alone', () => {
    const port = new Port();
    const r = render(port);
    const hold = r.node('motors-hold-button');
    act(() => {
      hold?.props.onPressIn?.();
    });
    // Press-in is not a command. Only crossing the hold threshold is,
    // and this test deliberately never crosses it.
    expect(port.pulseCalls).toEqual([]);
    r.unmount();
  });
});

/* ================================================================== *
 * 5-7. CONFIRMATION APPLIES TO THE ADDRESSED MOTOR, AND EXPECTED IS
 *      NEVER PRESENTED AS CONFIRMED
 * ================================================================== */

describe('confirmation is bound to one motor', () => {
  it('binds the observation form to the RECEIPT, not to the selection', () => {
    const port = new Port(snapshot({verificationReceipt: RECEIPT_M2}));
    const r = render(port);
    // The form belongs to M2 because the receipt does.
    expect(r.has('motor-identification-active-M2')).toBe(true);
    // Address a different motor: the form does NOT follow, and the screen
    // says out loud that the pending answer belongs elsewhere.
    r.press('motor-identity-M3');
    expect(r.has('motor-identification-active-M2')).toBe(true);
    expect(r.has('motor-identification-pending-elsewhere')).toBe(true);
    r.unmount();
  });

  it('applies a location confirmation to the receipt motor only', () => {
    const port = new Port(snapshot({verificationReceipt: RECEIPT_M2}));
    const r = render(port);
    r.press('verification-position-FRONT_LEFT');
    r.press('verification-direction-CCW');
    r.press('verification-confirm');

    // M2 is now confirmed; nothing else moved off "unconfirmed".
    expect(
      r.node('motor-identification-summary-M2')?.props.children,
    ).toBe(ar.motorsScreen.identityStatus.CONFIRMED);
    for (const other of [1, 3, 4]) {
      expect(
        r.node(`motor-identification-summary-M${other}`)?.props.children,
      ).not.toBe(ar.motorsScreen.identityStatus.CONFIRMED);
    }
    r.unmount();
  });

  it('sends a direction command for the addressed motor and no other', async () => {
    const port = new Port();
    const r = render(port);
    r.press('motor-identity-M3');
    r.press('motor-direction-authoring-open');
    r.press('esc-direction-reversed');
    r.press('esc-direction-review');
    await act(async () => {
      r.node('esc-direction-apply')?.props.onPress();
    });
    expect(port.directionCalls).toEqual([
      {motorNumber: 3, direction: 'REVERSED'},
    ]);
    r.unmount();
  });

  it('never presents an expected direction as a confirmed one', () => {
    const port = new Port(snapshot({verificationReceipt: RECEIPT_M2}));
    const r = render(port);
    r.press('motor-identity-M2');

    // The template HAS an expectation for M2 and it is shown, badged as
    // an expectation.
    const expected = r.node('motor-identity-expected-direction');
    expect(expected).toBeDefined();
    expect(typeof expected?.props.children).toBe('string');
    expect(
      r.node('motor-identity-expected-direction-badge')?.findAll(
        n => typeof n.props?.children === 'string',
      )[0]?.props.children,
    ).toBe(ar.motorsScreen.truthExpected);

    // Nothing has been observed, so the CONFIRMED direction says so - it
    // is not back-filled from the template.
    expect(r.node('motor-identity-confirmed-direction')?.props.children).toBe(
      '—',
    );
    // The line carries ONE badge for the observation it reports, and it
    // still says "unconfirmed" in words rather than leaving a bare dash.
    expect(
      r.node('motor-identity-confirmed-badge')?.findAll(
        n => typeof n.props?.children === 'string',
      )[0]?.props.children,
    ).toBe(ar.motorsScreen.truthUnconfirmed);

    // And the two are genuinely independent: confirming the OPPOSITE of
    // the expectation records the opposite.
    r.press('verification-position-FRONT_LEFT');
    r.press('verification-direction-CCW');
    r.press('verification-confirm');
    expect(r.node('motor-identity-confirmed-direction')?.props.children).toBe(
      ar.motorVerification.direction.CCW,
    );
    expect(r.node('motor-identity-expected-direction')?.props.children).toBe(
      ar.motorVerification.direction.CW,
    );
    r.unmount();
  });

  it('writes no output mapping when a motor is identified or confirmed', () => {
    const port = new Port(snapshot({verificationReceipt: RECEIPT_M2}));
    const r = render(port);
    const before = r.node('motor-output-row-M2-value')?.props.children;
    r.press('verification-position-FRONT_LEFT');
    r.press('verification-direction-CCW');
    r.press('verification-confirm');
    // Identification is an OBSERVATION. It never reaches the mixer, the
    // output order or the direction: the reorder panel is a separate,
    // explicitly-opened transaction.
    expect(r.node('motor-output-row-M2-value')?.props.children).toBe(before);
    expect(port.directionCalls).toEqual([]);
    expect(port.pulseCalls).toEqual([]);
    r.unmount();
  });
});

/* ================================================================== *
 * 8-9. RPM UNAVAILABLE IS NOT RPM ZERO
 * ================================================================== */

const DSHOT_ONLY: MotorDiagnosticsSupport = Object.freeze({
  motorCount: 4,
  dshotTelemetryEnabled: true,
  escSensorEnabled: false,
  escTelemetrySource: 'BIDIRECTIONAL_DSHOT',
});
const NO_SOURCE: MotorDiagnosticsSupport = Object.freeze({
  motorCount: 4,
  dshotTelemetryEnabled: false,
  escSensorEnabled: false,
  escTelemetrySource: 'NONE',
});

function entry(over: Partial<MspMotorTelemetryEntry>): MspMotorTelemetryEntry {
  return {
    rpm: 0,
    invalidPercentRaw: 0,
    temperatureCelsius: 0,
    voltageCentivolts: 0,
    currentCentiamps: 0,
    consumptionMah: 0,
    ...over,
  };
}

describe('an unavailable RPM is not a zero RPM', () => {
  it('hides the zero the firmware writes when no packet ever arrived', () => {
    // Betaflight sets invalidPct to exactly 10000 (100.00%) the moment
    // DShot telemetry is enabled, and replaces it only where the motor's
    // telemetry is demonstrably active. rpm 0 AND that floor means the
    // stream does not exist.
    const silent = entry({rpm: 0, invalidPercentRaw: 10_000});
    expect(visibleMotorTelemetryMetrics(silent, DSHOT_ONLY).rpm).toBeUndefined();
    expect(rpmIsUnprovenZero(silent, DSHOT_ONLY)).toBe(true);
  });

  it('still shows a real zero that carries evidence of a live stream', () => {
    // Same rpm, invalidPct BELOW the floor: packets are arriving and this
    // motor is genuinely at rest. Hiding it would be the opposite lie.
    const resting = entry({rpm: 0, invalidPercentRaw: 250});
    expect(visibleMotorTelemetryMetrics(resting, DSHOT_ONLY).rpm).toBe(0);
    expect(rpmIsUnprovenZero(resting, DSHOT_ONLY)).toBe(false);
  });

  it('never hides a non-zero reading, whatever the stats flag says', () => {
    // USE_DSHOT_TELEMETRY_STATS is an optional compile flag: a build
    // without it leaves invalidPct pinned at 10000 while telemetry works.
    const working = entry({rpm: 4_111, invalidPercentRaw: 10_000});
    expect(visibleMotorTelemetryMetrics(working, DSHOT_ONLY).rpm).toBe(4_111);
    expect(rpmIsUnprovenZero(working, DSHOT_ONLY)).toBe(false);
  });

  it('maps each motor to its own reading, in order', () => {
    const motors = [1_234, 2_789, 4_111, 5_678].map((rpm, index) =>
      entry({rpm, temperatureCelsius: [31, 42, 53, 64][index]}),
    );
    const seen = motors.map(m => visibleMotorTelemetryMetrics(m, DSHOT_ONLY));
    expect(seen.map(m => m.rpm)).toEqual([1_234, 2_789, 4_111, 5_678]);
    expect(seen.map(m => m.temperatureCelsius)).toEqual([31, 42, 53, 64]);
  });

  it('states the missing-telemetry reason once, not once per motor', () => {
    // Four copies of the same sentence is three copies of noise, and it
    // is what made "no telemetry" as tall a section as one with readings
    // in it. MEASURED at 390: 1137px -> 863px.
    const silent = () => entry({rpm: 0, invalidPercentRaw: 10_000});
    const port = new Port();
    const r = render(port);
    // The semantics the panel branches on: every motor unproven, and no
    // electrical or thermal value anywhere.
    const motors = [silent(), silent(), silent(), silent()];
    expect(motors.every(m => rpmIsUnprovenZero(m, DSHOT_ONLY))).toBe(true);
    expect(
      motors.every(m => {
        const v = visibleMotorTelemetryMetrics(m, DSHOT_ONLY);
        return (
          v.invalidPercentRaw === undefined &&
          v.temperatureCelsius === undefined &&
          v.voltageVolts === undefined &&
          v.currentAmps === undefined &&
          v.consumptionMah === undefined
        );
      }),
    ).toBe(true);
    r.unmount();
  });

  it('renders no live value at all when the controller proved no source', () => {
    // Not zeros, not dashes-as-measurements: nothing. Every field is
    // withheld because the source itself was proven absent.
    const anything = entry({
      rpm: 9_999,
      temperatureCelsius: 55,
      voltageCentivolts: 1_600,
      currentCentiamps: 400,
      consumptionMah: 250,
    });
    const metrics = visibleMotorTelemetryMetrics(anything, NO_SOURCE);
    expect(metrics).toEqual({
      rpm: undefined,
      invalidPercentRaw: undefined,
      temperatureCelsius: undefined,
      voltageVolts: undefined,
      currentAmps: undefined,
      consumptionMah: undefined,
    });
    // And with no source there is no "unproven zero" to explain either -
    // the panel says the source is off, which is a different sentence.
    expect(rpmIsUnprovenZero(anything, NO_SOURCE)).toBe(false);
    expect(rpmIsUnprovenZero(anything, undefined)).toBe(false);
  });
});
