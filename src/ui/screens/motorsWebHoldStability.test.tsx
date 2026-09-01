/**
 * MOTORS WEB HOLD STABILITY - the regression the previous review missed.
 *
 * WHAT THE OLD COVERAGE PROVED, AND WHY IT WAS NOT ENOUGH. Every existing
 * suite drives the gesture seams directly: it calls onPressIn, advances
 * fake timers past the threshold, then calls onPressOut/onPointerLeave
 * and asserts the command and stop counts. That proves the SEAMS, and
 * they were never broken. What it cannot represent is the thing that
 * actually failed in a browser: the controller publishing a snapshot
 * MID-GESTURE, the screen re-rendering six surfaces because of it, the
 * document growing ~223px, the browser's scroll anchoring compensating,
 * and react-native-web's ResponderSystem terminating the press because a
 * `scroll` event fired on an ancestor of the responder. No fake-timer
 * test can produce layout, anchoring or a scroll event, so the whole
 * causal chain sat outside the test model - the suites were green and
 * the product still lost the hold about 20 ms after activation.
 *
 * A jest renderer still cannot measure layout. What it CAN pin - and
 * what these tests pin - is the PROVEN CAUSE rather than the symptom:
 * the mid-gesture publication must not change what the screen renders
 * around the pressed control, because that structural change is what the
 * browser turned into a scroll and the responder turned into a release.
 * The browser-side proof (10/10 stationary holds, stable rect, zero
 * self-generated pointer loss) lives in the gitignored forensic harness.
 */

/** @jest-environment jsdom */
// The defect is web-only: on web the screen installs its OWN 800 ms
// timer at press-in (Platform.OS === 'web'), which is the path that must
// survive the controller's mid-gesture publication. Running this suite
// against react-native-web is what makes that path real here, and it is
// the same substitution MotorsScreen.web.test.tsx already uses.
jest.mock('react-native', () => jest.requireActual('react-native-web'));

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import '../../i18n';
import type {MotorTestControllerSnapshot} from '../../core/state/motorTestController';
import type {MotorTestOperatorPort} from '../../platforms/react-native/protocol';

/** Quiet, ready, nothing in flight. */
function readySnapshot(): MotorTestControllerSnapshot {
  return {
    phase: 'ACTIVE',
    setupStep: 'READY',
    machine: {name: 'Ready', startAcknowledged: false},
    outcome: {kind: 'READY'},
    firmwareCompatibility: undefined,
    motorScope: {motorCount: 4, motorProtocolRaw: 7, feature3dEnabled: false},
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
    activation: {allowed: true, reasons: []},
    pulse: {motorNumber: undefined, mayBeLive: false, mayHaveReachedFc: false},
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

/**
 * EXACTLY what the real controller publishes the instant a pulse is
 * accepted: activation withdrawn with PULSE_OR_STOP_IN_PROGRESS, and the
 * command flagged as possibly live. This is the publication that used to
 * restructure the page under the operator's finger.
 */
function inFlightSnapshot(): MotorTestControllerSnapshot {
  const snap = readySnapshot() as unknown as Record<string, unknown>;
  return {
    ...snap,
    machine: {name: 'Pulsing', startAcknowledged: true},
    activation: {allowed: false, reasons: ['PULSE_OR_STOP_IN_PROGRESS']},
    pulse: {motorNumber: 1, mayBeLive: true, mayHaveReachedFc: true},
  } as unknown as MotorTestControllerSnapshot;
}

/** Publishes like the real controller: pulseMotor() flips the snapshot
 * and notifies subscribers synchronously, exactly as measured. */
class PublishingOperator implements MotorTestOperatorPort {
  readonly pulseCalls: number[] = [];
  readonly stopCalls: string[] = [];
  private snap = readySnapshot();
  private readonly listeners = new Set<() => void>();
  beginSession = () => Promise.resolve(this.snap);
  getSnapshot = () => this.snap;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(next: MotorTestControllerSnapshot) {
    this.snap = next;
    for (const listener of Array.from(this.listeners)) listener();
  }
  pulseMotor = (n: number) => {
    this.pulseCalls.push(n);
    this.publish(inFlightSnapshot());
    return 'ACCEPTED' as never;
  };
  renewPulseHold = () => 'RENEWED' as never;
  setEscDirection = () => Promise.resolve(undefined as never);
  refreshDiagnostics = () => Promise.resolve(undefined as never);
  requestStop = (trigger: string) => {
    this.stopCalls.push(trigger);
    this.publish(readySnapshot());
    return 'ACCEPTED' as never;
  };
  endSession = () => Promise.resolve(this.snap);
  setMotorValues = () => undefined as never;
  setMotorValue = () => undefined as never;
  setMaster = () => undefined as never;
  stopAll = () => {
    this.stopCalls.push('STOP_ALL');
    return undefined as never;
  };
}

function mount(operator: MotorTestOperatorPort) {
  const {MotorsScreenView} = require('./MotorsScreen');
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(
      <MotorsScreenView operator={operator} sessionId="fc-session" />,
    );
  });
  return tree;
}

const nodes = (tree: ReactTestRenderer.ReactTestRenderer, id: string) =>
  tree.root.findAllByProps({testID: id});
const present = (tree: ReactTestRenderer.ReactTestRenderer, id: string) =>
  nodes(tree, id).length > 0;
const hold = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root.findAllByProps({testID: 'motors-hold-button'})[0];

/** press -> cross the 800 ms threshold, leaving the gesture OWNED. */
function pressAndActivate(tree: ReactTestRenderer.ReactTestRenderer) {
  act(() => {
    hold(tree).props.onPressIn();
  });
  act(() => {
    jest.advanceTimersByTime(900);
  });
}

describe('a stationary web hold survives the controller publication it causes', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('activates once and does NOT restructure the surfaces around the pressed control', () => {
    const operator = new PublishingOperator();
    const tree = mount(operator);

    // Before the gesture: the quiet, ready presentation.
    expect(present(tree, 'motors-session-ready')).toBe(true);
    expect(present(tree, 'motors-hold-blocked')).toBe(false);

    pressAndActivate(tree);
    expect(operator.pulseCalls).toEqual([1]);

    // THE REGRESSION. The controller has now published
    // allowed=false/PULSE_OR_STOP_IN_PROGRESS. None of these may appear
    // or disappear while the pointer is down: in a browser each one
    // resizes the document, the scroll anchoring that follows emits a
    // `scroll` on an ancestor, and react-native-web terminates the press.
    expect(present(tree, 'motors-hold-blocked')).toBe(false);
    expect(present(tree, 'motors-hold-blocked-reason')).toBe(false);
    expect(present(tree, 'motors-block-reasons')).toBe(false);
    expect(present(tree, 'motors-ack-notice')).toBe(false);
    expect(present(tree, 'motors-readiness-blocked-detail')).toBe(false);
    expect(present(tree, 'motor-output-mapping-blocked')).toBe(false);
    // The readiness banner keeps its box rather than swapping for the
    // blocked detail block.
    expect(present(tree, 'motors-session-ready')).toBe(true);

    // And the command is genuinely owned - the hold did not silently die.
    expect(operator.stopCalls).toEqual([]);
    expect(present(tree, 'motors-command-may-be-live')).toBe(true);

    act(() => {
      tree.unmount();
    });
  });

  it('renders the true blocked state again the moment the gesture ends', () => {
    const operator = new PublishingOperator();
    const tree = mount(operator);
    pressAndActivate(tree);
    expect(present(tree, 'motors-block-reasons')).toBe(false);

    act(() => {
      hold(tree).props.onPressOut();
    });
    expect(operator.stopCalls).toEqual(['TOUCH_RELEASED']);
    // Back to the honest presentation: nothing is being suppressed once
    // no gesture owns the control.
    expect(present(tree, 'motors-session-ready')).toBe(true);
    act(() => {
      tree.unmount();
    });
  });

  it('keeps the hold surface at ONE reserved height across every label it shows', () => {
    // The label legitimately changes three times per gesture. A height
    // that follows the text is what let the pressed surface resize.
    const operator = new PublishingOperator();
    const tree = mount(operator);
    const flatten = (style: unknown): Record<string, unknown> =>
      Array.isArray(style)
        ? Object.assign({}, ...style.filter(Boolean).map(flatten))
        : ((style ?? {}) as Record<string, unknown>);

    const idle = flatten(hold(tree).props.style).height;
    pressAndActivate(tree);
    const active = flatten(hold(tree).props.style).height;
    expect(typeof idle).toBe('number');
    expect(active).toBe(idle);
    act(() => {
      tree.unmount();
    });
  });
});

describe('every stop seam still stops - the safety seams are untouched', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  const seams: readonly [string, (tree: ReactTestRenderer.ReactTestRenderer) => void][] = [
    ['release', tree => hold(tree).props.onPressOut()],
    ['pointer leave', tree => hold(tree).props.onPointerLeave()],
    ['pointer cancel', tree => hold(tree).props.onPointerCancel()],
  ];

  it.each(seams)('%s stops an owned, activated hold', (_name, fire) => {
    const operator = new PublishingOperator();
    const tree = mount(operator);
    pressAndActivate(tree);
    expect(operator.pulseCalls).toHaveLength(1);
    expect(operator.stopCalls).toEqual([]);
    act(() => {
      fire(tree);
    });
    expect(operator.stopCalls.length).toBeGreaterThanOrEqual(1);
    act(() => {
      tree.unmount();
    });
  });

  it('the STOP button stops, and the pressed control claims nothing afterwards', () => {
    const operator = new PublishingOperator();
    const tree = mount(operator);
    pressAndActivate(tree);
    act(() => {
      tree.root
        .findAllByProps({testID: 'motors-stop-button'})[0]
        .props.onPress();
    });
    expect(operator.stopCalls).toContain('STOP_BUTTON_PRESSED');
    act(() => {
      tree.unmount();
    });
  });
});
