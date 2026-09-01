/**
 * EVERY VISIBLE MOTORS CONTROL MUST DO SOMETHING VISIBLE.
 *
 * WHY. The operator's field report was not only "the motor did not turn".
 * It was "I pressed things and nothing happened" - a hold control that
 * received no pointer event because it was disabled, and an advanced
 * disclosure that expanded into an empty container. Both looked
 * identical to a broken screen. This suite pins the general rule those
 * two defects violated:
 *
 *     NO VISIBLE INTERACTIVE CONTROL SILENTLY DOES NOTHING.
 *
 * A disclosure may legitimately only change UI state. A blocked feature
 * may legitimately issue zero commands. What neither may do is absorb a
 * press and leave the screen unchanged with no explanation.
 *
 * SEAM. `MotorsScreenView` is exported and takes `operator` as a plain
 * prop, so the real production surface mounts directly against a
 * deterministic port. Nothing is forked and no module is mocked.
 *
 * WHAT THIS IS NOT. The port is a counter, not a flight controller. A
 * green run proves the UI and the command gate behave; it proves nothing
 * about a motor turning. That remains a hardware test on both platforms.
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import '../../i18n';
import type {MotorTestControllerSnapshot} from '../../core/state/motorTestController';
import type {MotorTestOperatorPort} from '../../platforms/react-native/protocol';

/** The same minimal snapshot shape the blocked-state matrix uses. */
function snapshot(allowed: boolean): MotorTestControllerSnapshot {
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
    armedStateEvidence: allowed ? 'FRESH_DISARMED' : 'UNKNOWN_OR_STALE',
    motorDomain: undefined,
    motorRuntimeScope: undefined,
    telemetryHeld: true,
    activation: {allowed, reasons: allowed ? [] : ['FC_ARMED']},
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

class CountingOperator implements MotorTestOperatorPort {
  readonly pulseCalls: number[] = [];
  readonly stopCalls: string[] = [];
  endCalls = 0;
  constructor(public snap: MotorTestControllerSnapshot) {}
  beginSession = () => Promise.resolve(this.snap);
  getSnapshot = () => this.snap;
  subscribe = () => () => {};
  pulseMotor = (n: number) => {
    this.pulseCalls.push(n);
    return 'ACCEPTED' as never;
  };
  renewPulseHold = () => 'RENEWED' as never;
  setEscDirection = () => Promise.resolve(undefined as never);
  refreshDiagnostics = () => Promise.resolve(undefined as never);
  requestStop = (trigger: string) => {
    this.stopCalls.push(trigger);
    return 'ACCEPTED' as never;
  };
  endSession = () => {
    this.endCalls += 1;
    return Promise.resolve(this.snap);
  };
  setMotorValues = () => undefined as never;
  setMotorValue = () => undefined as never;
  setMaster = () => undefined as never;
  stopAll = () => {
    this.stopCalls.push('STOP_ALL');
    return undefined as never;
  };
}

function mount(operator: MotorTestOperatorPort | undefined) {
  const {MotorsScreenView} = require('./MotorsScreen');
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(
      <MotorsScreenView operator={operator} sessionId="fc-session" />,
    );
  });
  return tree;
}

const find = (tree: ReactTestRenderer.ReactTestRenderer, id: string) =>
  tree.root.findAllByProps({testID: id});
const present = (tree: ReactTestRenderer.ReactTestRenderer, id: string) =>
  find(tree, id).length > 0;

/* ==================================================================== *
 * CONTROL SMOKE MATRIX
 * ==================================================================== */

describe('every visible disclosure produces a visible response', () => {
  let tree: ReactTestRenderer.ReactTestRenderer;
  let operator: CountingOperator;

  beforeEach(() => {
    operator = new CountingOperator(snapshot(true));
    tree = mount(operator);
  });

  afterEach(() => {
    act(() => tree.unmount());
  });

  it('advanced verification: closed -> open -> closed, never blank', () => {
    expect(present(tree, 'motors-advanced-verification')).toBe(false);
    const toggle = find(tree, 'motors-advanced-verification-toggle')[0];

    act(() => toggle.props.onPress());
    expect(present(tree, 'motors-advanced-verification')).toBe(true);
    // The exact regression the operator hit: expanded, but empty.
    expect(present(tree, 'motors-advanced-empty')).toBe(true);

    act(() => toggle.props.onPress());
    expect(present(tree, 'motors-advanced-verification')).toBe(false);
  });

  it('diagnostics disclosure toggles a visible panel', () => {
    const toggle = find(tree, 'motors-diagnostics-toggle')[0];
    const before = present(tree, 'motors-diagnostics');
    act(() => toggle.props.onPress());
    expect(present(tree, 'motors-diagnostics')).toBe(!before);
  });

  it('motor settings entry opens the configuration surface', () => {
    const entry = find(tree, 'motors-open-settings')[0];
    expect(entry).toBeDefined();
    act(() => entry.props.onPress());
    // The entry replaces itself with the panel, so its disappearance IS
    // the visible response.
    expect(present(tree, 'motors-open-settings')).toBe(false);
  });

  it('issues no motor command from any disclosure press', () => {
    for (const id of [
      'motors-advanced-verification-toggle',
      'motors-diagnostics-toggle',
      'motors-open-settings',
    ]) {
      const control = find(tree, id)[0];
      if (control !== undefined) act(() => control.props.onPress());
    }
    expect(operator.pulseCalls).toEqual([]);
  });
});

/* ==================================================================== *
 * NATIVE / SHARED COMMAND-PATH REGRESSION
 * ==================================================================== */

describe('the native command path is unchanged by the web fail-safes', () => {
  let tree: ReactTestRenderer.ReactTestRenderer;
  let operator: CountingOperator;

  beforeEach(() => {
    operator = new CountingOperator(snapshot(true));
    tree = mount(operator);
  });

  afterEach(() => {
    act(() => tree.unmount());
  });

  it('an ordinary tap emits no pulse', () => {
    const hold = find(tree, 'motors-hold-button')[0];
    act(() => {
      hold.props.onPressIn();
      hold.props.onPressOut();
    });
    expect(operator.pulseCalls).toEqual([]);
  });

  it('the native long-press path still activates exactly once', () => {
    const hold = find(tree, 'motors-hold-button')[0];
    act(() => {
      hold.props.onPressIn();
      hold.props.onLongPress();
    });
    expect(operator.pulseCalls).toHaveLength(1);
  });

  it('release after activation requests the canonical stop', () => {
    const hold = find(tree, 'motors-hold-button')[0];
    act(() => {
      hold.props.onPressIn();
      hold.props.onLongPress();
      hold.props.onPressOut();
    });
    expect(operator.stopCalls).toContain('TOUCH_RELEASED');
  });

  it('responder termination requests the canonical stop', () => {
    const hold = find(tree, 'motors-hold-button')[0];
    act(() => {
      hold.props.onPressIn();
      hold.props.onLongPress();
      hold.props.onResponderTerminate({} as never);
    });
    expect(operator.stopCalls).toContain('TOUCH_RELEASED');
  });

  it('keeps the native hooks wired alongside the web ones', () => {
    // The web seams are ADDITIVE. If a future change swapped the native
    // responder for a pointer event, this is what would catch it.
    const hold = find(tree, 'motors-hold-button')[0];
    expect(typeof hold.props.onLongPress).toBe('function');
    expect(typeof hold.props.onResponderTerminate).toBe('function');
    expect(typeof hold.props.onPointerLeave).toBe('function');
    expect(typeof hold.props.onPointerCancel).toBe('function');
  });

  it('pointer leave after activation requests the canonical stop', () => {
    const hold = find(tree, 'motors-hold-button')[0];
    act(() => {
      hold.props.onPressIn();
      hold.props.onLongPress();
      hold.props.onPointerLeave();
    });
    expect(operator.stopCalls).toContain('TOUCH_RELEASED');
  });

  it('pointer cancel after activation requests the canonical stop', () => {
    const hold = find(tree, 'motors-hold-button')[0];
    act(() => {
      hold.props.onPressIn();
      hold.props.onLongPress();
      hold.props.onPointerCancel();
    });
    expect(operator.stopCalls).toContain('TOUCH_RELEASED');
  });

  it('pointer leave with no gesture owned does nothing at all', () => {
    const hold = find(tree, 'motors-hold-button')[0];
    act(() => hold.props.onPointerLeave());
    expect(operator.stopCalls).toEqual([]);
    expect(operator.pulseCalls).toEqual([]);
  });

  it('collapses leave + release into a single stop episode', () => {
    const hold = find(tree, 'motors-hold-button')[0];
    act(() => {
      hold.props.onPressIn();
      hold.props.onLongPress();
      hold.props.onPointerLeave();
      hold.props.onPointerCancel();
      hold.props.onPressOut();
    });
    // Ownership is torn down by the first terminator, so the later ones
    // find nothing live. One request, not three.
    expect(operator.stopCalls).toHaveLength(1);
  });

  it('unmounting while a command may be live does not throw', () => {
    const hold = find(tree, 'motors-hold-button')[0];
    act(() => {
      hold.props.onPressIn();
      hold.props.onLongPress();
    });
    expect(() => act(() => tree.unmount())).not.toThrow();
    // Re-mount so afterEach has something to unmount.
    tree = mount(new CountingOperator(snapshot(true)));
  });
});

/* ==================================================================== *
 * RESPONSIVE — structural, at every required width
 * ==================================================================== */

describe.each([360, 390, 412, 768, 1024, 1366])(
  'at %ipx the primary motor controls survive the breakpoint',
  width => {
    let tree: ReactTestRenderer.ReactTestRenderer;

    beforeEach(() => {
      jest
        .spyOn(require('react-native'), 'useWindowDimensions')
        .mockReturnValue({width, height: 800, scale: 2, fontScale: 1});
      tree = mount(new CountingOperator(snapshot(true)));
    });

    afterEach(() => {
      act(() => tree.unmount());
      jest.restoreAllMocks();
    });

    it('renders the hold control', () => {
      expect(present(tree, 'motors-hold-button')).toBe(true);
    });

    it('renders the propeller warning', () => {
      expect(present(tree, 'motors-propeller-warning')).toBe(true);
    });

    it('keeps the pinned STOP outside the scrolling body', () => {
      const {ScrollView} = require('react-native');
      for (const scroll of tree.root.findAllByType(ScrollView)) {
        expect(scroll.findAllByProps({testID: 'motors-sticky-stop'}).length).toBe(
          0,
        );
      }
    });

    it('keeps the advanced disclosure reachable and non-empty when opened', () => {
      const toggle = find(tree, 'motors-advanced-verification-toggle')[0];
      expect(toggle).toBeDefined();
      act(() => toggle.props.onPress());
      expect(present(tree, 'motors-advanced-empty')).toBe(true);
    });
  },
);

describe.each([360, 390, 412])(
  'at %ipx a blocked hold still explains itself',
  width => {
    it('renders the causal reason rather than dropping it at narrow widths', () => {
      jest
        .spyOn(require('react-native'), 'useWindowDimensions')
        .mockReturnValue({width, height: 800, scale: 2, fontScale: 1});
      const tree = mount(new CountingOperator(snapshot(false)));
      expect(present(tree, 'motors-hold-blocked')).toBe(true);
      const reason = find(tree, 'motors-hold-blocked-reason')[0];
      expect((reason.props.children as string).length).toBeGreaterThan(0);
      act(() => tree.unmount());
      jest.restoreAllMocks();
    });
  },
);
