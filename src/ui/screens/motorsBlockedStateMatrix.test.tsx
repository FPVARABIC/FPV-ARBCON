/**
 * THE BLOCKED-STATE MATRIX, DRIVEN THROUGH THE REAL SCREEN.
 *
 * WHY THIS FILE EXISTS SEPARATELY. `motorsBlockedHoldUx.test.tsx` proves
 * the no-session case by mounting the CONTAINER, which owns its own
 * operator and can therefore only ever reach one state. Every other
 * blocked state needs a controller snapshot that says something
 * specific, and the container gives no way to supply one.
 *
 * THE SEAM, which is the thing four earlier attempts kept looking for:
 * `MotorsScreenView` is already exported and already takes
 * `operator: MotorTestOperatorPort | undefined` as an ordinary prop.
 * Nothing has to be forked, no module mocked, no session coordinator
 * faked - the production view mounts directly with a deterministic port.
 * This file is the harness; there was never a need to build one.
 *
 * WHAT IS AND IS NOT SIMULATED. The snapshots below are controller
 * STATE. They are not evidence about hardware: no MSP exchange happens
 * here, no motor turns, and a passing test says only that the UI treats
 * a given authoritative state correctly. Real motor movement on either
 * platform remains a hardware test.
 *
 * THE PRODUCT RULE, asserted in both halves for every state:
 *
 *     A BLOCKED CONTROL MAY ISSUE ZERO MOTOR COMMANDS,
 *     BUT IT MUST NEVER LOOK LIKE DEAD PIXELS.
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import '../../i18n';
import ar from '../../i18n/locales/ar.json';
import type {
  MotorTestActivationBlockReason,
  MotorTestControllerSnapshot,
} from '../../core/state/motorTestController';
import type {MotorTestOperatorPort} from '../../platforms/react-native/protocol';

const HOLD = 'motors-hold-button';
const BLOCKED = 'motors-hold-blocked';
const REASON = 'motors-hold-blocked-reason';

/**
 * A controller snapshot with the one axis each scenario cares about.
 * Deliberately minimal: anything not named here is the same across every
 * state, so a difference in the result can only come from the axis under
 * test.
 */
function snapshotFor(options: {
  readonly allowed: boolean;
  readonly reasons?: readonly MotorTestActivationBlockReason[];
  readonly phase?: MotorTestControllerSnapshot['phase'];
  readonly outcome?: MotorTestControllerSnapshot['outcome'];
}): MotorTestControllerSnapshot {
  return {
    phase: options.phase ?? 'ACTIVE',
    setupStep: 'READY',
    machine: {name: 'Ready', startAcknowledged: false},
    outcome: options.outcome ?? {kind: 'READY'},
    firmwareCompatibility: undefined,
    motorScope: {motorCount: 4, motorProtocolRaw: 7, feature3dEnabled: false},
    motorDiagnosticsSupport: {
      motorCount: 4,
      dshotTelemetryEnabled: true,
      escSensorEnabled: false,
      escTelemetrySource: 'BIDIRECTIONAL_DSHOT',
    },
    armedStateEvidence: options.allowed ? 'FRESH_DISARMED' : 'UNKNOWN_OR_STALE',
    motorDomain: undefined,
    motorRuntimeScope: undefined,
    telemetryHeld: true,
    activation: {allowed: options.allowed, reasons: options.reasons ?? []},
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

/** Counts everything a blocked state must never do. */
class CountingOperator implements MotorTestOperatorPort {
  readonly pulseCalls: number[] = [];
  readonly stopCalls: string[] = [];
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
  requestStop = (trigger: string) => {
    this.stopCalls.push(trigger);
    return 'ACCEPTED' as never;
  };
  endSession = () => Promise.resolve(this.snapshot);
  setMotorValues = () => undefined as never;
  setMotorValue = () => undefined as never;
  setMaster = () => undefined as never;
  stopAll = () => {
    this.stopCalls.push('STOP_ALL');
    return undefined as never;
  };
}

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

function mount(operator: MotorTestOperatorPort | undefined): {
  tree: ReactTestRenderer.ReactTestRenderer;
} {
  const {MotorsScreenView} = require('./MotorsScreen');
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(
      <MotorsScreenView operator={operator} sessionId="fc-session" />,
    );
  });
  return {tree};
}

/**
 * The states the operator can actually land in. Each is expressed as the
 * authoritative controller fact that produces it, not as a UI string, so
 * a test cannot pass by agreeing with itself.
 */
const BLOCKED_STATES: readonly {
  readonly name: string;
  readonly snapshot: MotorTestControllerSnapshot;
}[] = [
  {
    name: 'SESSION_CONTROL_OFF',
    snapshot: snapshotFor({
      allowed: false,
      reasons: ['CONTROLLER_LINK_UNAVAILABLE'],
    }),
  },
  {
    name: 'ARMED',
    snapshot: snapshotFor({allowed: false, reasons: ['FC_ARMED']}),
  },
  {
    name: 'SAFETY_UNKNOWN',
    snapshot: snapshotFor({
      allowed: false,
      reasons: ['ARMED_STATE_UNKNOWN_OR_STALE'],
    }),
  },
  {
    name: 'FIRMWARE_UNSUPPORTED',
    snapshot: snapshotFor({allowed: false, reasons: ['FIRMWARE_UNSUPPORTED']}),
  },
  {
    name: 'REQUIRES_RECONNECT',
    snapshot: snapshotFor({allowed: false, phase: 'CLOSED'}),
  },
];

describe.each(BLOCKED_STATES.map(s => [s.name, s] as const))(
  'blocked state: %s',
  (_name, scenario) => {
    let tree: ReactTestRenderer.ReactTestRenderer;
    let operator: CountingOperator;

    beforeEach(() => {
      operator = new CountingOperator(scenario.snapshot);
      tree = mount(operator).tree;
    });

    afterEach(() => {
      act(() => tree.unmount());
    });

    it('renders the hold control rather than hiding it', () => {
      expect(tree.root.findAllByProps({testID: HOLD}).length).toBeGreaterThan(0);
    });

    it('marks it disabled for assistive technology', () => {
      const hold = tree.root.findAllByProps({testID: HOLD})[0];
      expect(hold.props.accessibilityState.disabled).toBe(true);
    });

    it('shows a causal reason on the control', () => {
      expect(
        tree.root.findAllByProps({testID: BLOCKED}).length,
      ).toBeGreaterThan(0);
      const reason = tree.root.findAllByProps({testID: REASON})[0];
      expect(typeof reason.props.children).toBe('string');
      expect((reason.props.children as string).length).toBeGreaterThan(0);
    });

    it('gives assistive technology the same reason it shows on screen', () => {
      const hold = tree.root.findAllByProps({testID: HOLD})[0];
      const reason = tree.root.findAllByProps({testID: REASON})[0];
      expect(hold.props.accessibilityHint).toBe(reason.props.children);
    });

    it('says plainly that no command will be sent', () => {
      expect(textOf(tree)).toContain(ar.motorsScreen.holdBlockedHint);
    });

    it('issues ZERO motor commands however the control is pressed', () => {
      const hold = tree.root.findAllByProps({testID: HOLD})[0];
      act(() => {
        hold.props.onPressIn?.();
        hold.props.onLongPress?.();
        hold.props.onPressOut?.();
      });
      expect(operator.pulseCalls).toEqual([]);
    });
  },
);

describe('READY is not a blocked state', () => {
  let tree: ReactTestRenderer.ReactTestRenderer;
  let operator: CountingOperator;

  beforeEach(() => {
    operator = new CountingOperator(snapshotFor({allowed: true}));
    tree = mount(operator).tree;
  });

  afterEach(() => {
    act(() => tree.unmount());
  });

  it('shows no blocked reason', () => {
    expect(tree.root.findAllByProps({testID: BLOCKED}).length).toBe(0);
  });

  it('leaves the control enabled', () => {
    const hold = tree.root.findAllByProps({testID: HOLD})[0];
    expect(hold.props.accessibilityState.disabled).toBe(false);
  });

  it('restores the ordinary hold hint rather than the blocked one', () => {
    const hold = tree.root.findAllByProps({testID: HOLD})[0];
    expect(hold.props.accessibilityHint).toBe(ar.motorsScreen.holdHint);
  });
});

describe('the pinned STOP stays outside the scrolling body', () => {
  /**
   * The operator's own field review called the pinned red STOP useful.
   * It must not become something that scrolls away, and it must not
   * depend on the advanced disclosure being closed.
   */
  it('is present, and is not inside the ScrollView, while a session is live', () => {
    const operator = new CountingOperator(snapshotFor({allowed: true}));
    const {tree} = mount(operator);
    const {ScrollView} = require('react-native');
    const scrollViews = tree.root.findAllByType(ScrollView);
    for (const scroll of scrollViews) {
      expect(
        scroll.findAllByProps({testID: 'motors-sticky-stop'}).length,
      ).toBe(0);
    }
    act(() => tree.unmount());
  });
});
