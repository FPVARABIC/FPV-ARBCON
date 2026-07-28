/**
 * Phase 2H - adversarial tests for the motor-test screen.
 *
 * NO HARDWARE OF ANY KIND. No USB, no flight controller, no ESC, no LiPo,
 * no motor, no emulator, no device. The controller behind these tests is a
 * narrow operator-port double whose calls are recorded; the REAL controller
 * behaviour it stands for is proven exhaustively, against the real request
 * engine, in motorTestController.test.ts.
 *
 * NOTHING HERE IS A PHYSICAL CLAIM. `M1`..`M4` are MSP output slots. No
 * assertion in this file establishes wiring, frame position, rotation
 * direction, RPM or temperature - and one test proves the screen makes no
 * such claim either.
 */

/** The real hook needs a provider that only exists inside a mounted app.
 * Stubbed to a fixed inset so these tests exercise THIS screen rather than
 * react-native-safe-area-context; the safe-area padding itself is layout,
 * not a safety behaviour. */
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({top: 44, bottom: 34, left: 0, right: 0}),
}));

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {readFileSync} from 'fs';
import {join} from 'path';

import {
  MotorsScreenView,
  MOTOR_TEST_LONG_PRESS_DELAY_MILLIS,
  MOTOR_TEST_OUTPUT_SLOTS,
  EXPECTED_QUAD_X_REFERENCE,
  commandMayBeLive,
  derivePresentation,
} from './MotorsScreen';
import '../../i18n';
import i18n from '../../i18n';
import type {
  MotorTestActivationBlockReason,
  MotorTestControllerSnapshot,
  MotorTestPulseRequestResult,
  MotorTestStopRequestResult,
} from '../../core/state/motorTestController';
import type {MotorTestStopTriggerReason} from '../../core/state/motorTestStateMachine';
import type {MotorTestOperatorPort} from '../../platforms/react-native/protocol';

/* ------------------------------------------------------------------ *
 * Snapshot fixtures - plain data, no controller internals
 * ------------------------------------------------------------------ */

const AUTHORITY = {};

type MachineName =
  | 'Checking'
  | 'Locked'
  | 'Ready'
  | 'Starting'
  | 'Pulsing'
  | 'Stopping'
  | 'Fault';

function machineFor(name: MachineName, startAcknowledged = false) {
  switch (name) {
    case 'Starting':
      return {name, authority: AUTHORITY, startSubmitted: true} as const;
    case 'Pulsing':
      return {
        name,
        authority: AUTHORITY,
        pulseDeadlineArmed: true,
        startAcknowledged,
      } as const;
    case 'Stopping':
      return {
        name,
        authority: AUTHORITY,
        stopping: {
          stopReason: 'TOUCH_RELEASED',
          startMayHaveReachedFc: true,
          requiredDisposition: 'Ready',
          authority: AUTHORITY,
          startAcknowledged,
        },
      } as const;
    case 'Fault':
      return {
        name,
        authority: AUTHORITY,
        faultReason: 'STOP_FAILED',
        startMayHaveReachedFc: true,
      } as const;
    default:
      return {name, authority: AUTHORITY} as const;
  }
}

function snapshotFor(options: {
  machine?: MachineName;
  startAcknowledged?: boolean;
  allowed?: boolean;
  reasons?: MotorTestActivationBlockReason[];
  mayHaveReachedFc?: boolean;
  attributionAmbiguous?: boolean;
  receipt?: MotorTestControllerSnapshot['verificationReceipt'];
}): MotorTestControllerSnapshot {
  const machineName = options.machine ?? 'Ready';
  const allowed = options.allowed ?? machineName === 'Ready';
  return {
    phase: 'ACTIVE',
    setupStep: 'READY',
    machine: machineFor(machineName, options.startAcknowledged ?? false),
    outcome: {kind: 'READY'},
    capabilities: undefined,
    staticCompatibility: undefined,
    dynamicEvaluation: undefined,
    armingRestriction: {kind: 'NOT_ATTEMPTED'},
    telemetryHeld: true,
    warnings: [],
    stopDescriptors: [],
    teardown: undefined,
    stopExecution: {
      attempts: 0,
      commandDispatched: false,
      commandAcknowledged: false,
      physicalStopConfirmed: false,
      deferredBehindActiveWrite: false,
      attributionAmbiguous: options.attributionAmbiguous ?? false,
      wirePreemptionClaimed: false,
      submittedNextOnTransport: false,
      episodeId: 0,
      outcome: undefined,
    },
    activation: {
      allowed,
      reasons: Object.freeze(options.reasons ?? []),
    },
    verificationReceipt: options.receipt,
    pulse: {
      attemptId: 0,
      motorNumber: undefined,
      submitted: false,
      acknowledged: options.startAcknowledged ?? false,
      deadlineArmedAtSubmission: false,
      mayHaveReachedFc: options.mayHaveReachedFc ?? false,
      outcome: undefined,
    },
    continuousSafetyMonitoring: 'UNAVAILABLE_NO_ACCEPTED_SOURCE',
  } as MotorTestControllerSnapshot;
}

/* ------------------------------------------------------------------ *
 * The operator-port double
 *
 * Exactly the six members of the real sealed facade. It CANNOT reach a
 * client, transport, lease, encoder or authority, because the real port
 * cannot either - so a test can never exercise a path production code
 * does not have.
 * ------------------------------------------------------------------ */

class FakeOperator implements MotorTestOperatorPort {
  snapshot: MotorTestControllerSnapshot;
  readonly pulseCalls: number[] = [];
  readonly stopCalls: MotorTestStopTriggerReason[] = [];
  pulseResult: MotorTestPulseRequestResult = 'ACCEPTED';
  private readonly listeners = new Set<() => void>();

  constructor(snapshot: MotorTestControllerSnapshot) {
    this.snapshot = snapshot;
  }

  beginSession(): Promise<MotorTestControllerSnapshot> {
    return Promise.resolve(this.snapshot);
  }

  getSnapshot(): MotorTestControllerSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  pulseMotor(motorNumber: number): MotorTestPulseRequestResult {
    this.pulseCalls.push(motorNumber);
    return this.pulseResult;
  }

  requestStop(trigger: MotorTestStopTriggerReason): MotorTestStopRequestResult {
    this.stopCalls.push(trigger);
    return 'ACCEPTED';
  }

  endSession(): Promise<MotorTestControllerSnapshot> {
    return Promise.resolve(this.snapshot);
  }

  /** Publishes a new snapshot exactly as the real controller does. */
  publish(next: MotorTestControllerSnapshot): void {
    this.snapshot = next;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

/* ------------------------------------------------------------------ *
 * Render helpers
 * ------------------------------------------------------------------ */

interface Rendered {
  readonly tree: ReactTestRenderer.ReactTestRenderer;
  find(testID: string): ReactTestRenderer.ReactTestInstance;
  query(testID: string): ReactTestRenderer.ReactTestInstance | undefined;
  press(testID: string): void;
  unmount(): void;
}

function render(operator: MotorTestOperatorPort | undefined): Rendered {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(<MotorsScreenView operator={operator} />);
  });
  const query = (testID: string) =>
    tree.root.findAll(node => node.props?.testID === testID)[0];
  return {
    tree,
    query,
    find: (testID: string) => {
      const node = query(testID);
      if (node === undefined) {
        throw new Error(`no node with testID "${testID}"`);
      }
      return node;
    },
    press: (testID: string) => {
      const node = query(testID);
      if (node === undefined) {
        throw new Error(`no node with testID "${testID}"`);
      }
      act(() => {
        node.props.onPress?.();
      });
    },
    unmount: () => {
      act(() => {
        tree.unmount();
      });
    },
  };
}

/** Ticks every acknowledgement checkbox - the supplemental UI gate. */
function acknowledgeAll(rendered: Rendered): void {
  rendered.press('motors-ack-propellers');
  rendered.press('motors-ack-secured');
  rendered.press('motors-ack-battery');
}

function longPress(rendered: Rendered): void {
  act(() => {
    rendered.find('motors-hold-button').props.onLongPress?.();
  });
}

function pressOut(rendered: Rendered): void {
  act(() => {
    rendered.find('motors-hold-button').props.onPressOut?.();
  });
}

function texts(rendered: Rendered): string {
  return JSON.stringify(rendered.tree.toJSON());
}

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await i18n.init();
  }
});

/* ================================================================== *
 * Presentation
 * ================================================================== */

describe('MotorsScreen - state presentation', () => {
  it.each([
    ['Checking', 'CHECKING'],
    ['Locked', 'LOCKED'],
    ['Ready', 'READY'],
    ['Starting', 'SUBMITTED_AWAITING_RESPONSE'],
    ['Stopping', 'STOPPING'],
    ['Fault', 'FAULT'],
  ] as const)('presents %s as %s', (machine, expected) => {
    const rendered = render(
      new FakeOperator(snapshotFor({machine: machine as MachineName})),
    );
    expect(rendered.query(`motors-status-${expected}`)).toBeDefined();
    rendered.unmount();
  });

  it('distinguishes a submitted-but-unacknowledged pulse from an acknowledged one', () => {
    const preAck = render(
      new FakeOperator(
        snapshotFor({machine: 'Pulsing', startAcknowledged: false}),
      ),
    );
    // The accepted reducer is already in `Pulsing` here, at the write
    // call. Presenting that as confirmed rotation would claim something
    // no evidence supports.
    expect(
      preAck.query('motors-status-SUBMITTED_AWAITING_RESPONSE'),
    ).toBeDefined();
    expect(preAck.query('motors-ack-notice')).toBeUndefined();
    preAck.unmount();

    const acked = render(
      new FakeOperator(
        snapshotFor({machine: 'Pulsing', startAcknowledged: true}),
      ),
    );
    expect(acked.query('motors-status-ACKNOWLEDGED')).toBeDefined();
    // ... and it says explicitly that reception is not rotation.
    expect(acked.query('motors-ack-notice')).toBeDefined();
    acked.unmount();
  });

  it('shows the emergency LiPo instruction and the new-session requirement on Fault', () => {
    const rendered = render(
      new FakeOperator(snapshotFor({machine: 'Fault', allowed: false})),
    );
    const emergency = rendered.find('motors-emergency-text');
    expect(emergency.props.children).toBe(
      'تعذّر تأكيد توقف المحرك — افصل بطارية LiPo فورًا',
    );
    expect(rendered.query('motors-new-session-text')).toBeDefined();
    rendered.unmount();
  });

  it('renders the authoritative blocking reasons, not a generic message', () => {
    const rendered = render(
      new FakeOperator(
        snapshotFor({
          machine: 'Locked',
          allowed: false,
          reasons: ['SAFETY_EVENT_LATCHED', 'ARMING_RESTRICTION_NOT_CURRENT'],
        }),
      ),
    );
    expect(rendered.query('motors-block-SAFETY_EVENT_LATCHED')).toBeDefined();
    expect(
      rendered.query('motors-block-ARMING_RESTRICTION_NOT_CURRENT'),
    ).toBeDefined();
    rendered.unmount();
  });

  it('renders inert with no session and never calls anything', () => {
    const rendered = render(undefined);
    expect(rendered.query('motors-screen')).toBeDefined();
    expect(rendered.query('motors-status-NO_SESSION')).toBeDefined();
    // The Stop control still exists - there is simply nothing to stop.
    expect(rendered.query('motors-stop-button')).toBeDefined();
    rendered.unmount();
  });
});

/* ================================================================== *
 * The activation gate
 * ================================================================== */

describe('MotorsScreen - activation gating', () => {
  it('does NOT enable activation on Ready alone when the controller bars it', () => {
    // Exactly the Phase 2G finding: a locking safety event while idle
    // leaves the reducer in Ready while activation must stay barred.
    const operator = new FakeOperator(
      snapshotFor({
        machine: 'Ready',
        allowed: false,
        reasons: ['SAFETY_EVENT_LATCHED'],
      }),
    );
    const rendered = render(operator);
    acknowledgeAll(rendered);
    expect(rendered.find('motors-hold-button').props.disabled).toBe(true);
    longPress(rendered);
    expect(operator.pulseCalls).toEqual([]);
    rendered.unmount();
  });

  it('requires the manual acknowledgement even when the controller allows', () => {
    const operator = new FakeOperator(snapshotFor({allowed: true}));
    const rendered = render(operator);
    expect(rendered.find('motors-hold-button').props.disabled).toBe(true);
    longPress(rendered);
    expect(operator.pulseCalls).toEqual([]);

    acknowledgeAll(rendered);
    expect(rendered.find('motors-hold-button').props.disabled).toBe(false);
    rendered.unmount();
  });

  it('resets the manual acknowledgement on lock, fault and session loss', () => {
    for (const machine of ['Locked', 'Fault'] as const) {
      const operator = new FakeOperator(snapshotFor({allowed: true}));
      const rendered = render(operator);
      acknowledgeAll(rendered);
      expect(rendered.find('motors-hold-button').props.disabled).toBe(false);

      act(() => {
        operator.publish(snapshotFor({machine, allowed: false}));
      });
      // Back to allowed, but the acknowledgement is GONE - the operator
      // must vouch again after any boundary.
      act(() => {
        operator.publish(snapshotFor({allowed: true}));
      });
      expect(rendered.find('motors-hold-button').props.disabled).toBe(true);
      rendered.unmount();
    }
  });

  it('re-reads the authoritative gate at call time, not at render time', () => {
    const operator = new FakeOperator(snapshotFor({allowed: true}));
    const rendered = render(operator);
    acknowledgeAll(rendered);
    // The gate closes WITHOUT a re-render reaching the handler's closure.
    operator.snapshot = snapshotFor({
      allowed: false,
      reasons: ['AUTHORITY_STALE'],
    });
    longPress(rendered);
    expect(operator.pulseCalls).toEqual([]);
    rendered.unmount();
  });
});

/* ================================================================== *
 * The long-press contract
 * ================================================================== */

describe('MotorsScreen - long-press contract', () => {
  function readyRendered(): {operator: FakeOperator; rendered: Rendered} {
    const operator = new FakeOperator(snapshotFor({allowed: true}));
    const rendered = render(operator);
    acknowledgeAll(rendered);
    return {operator, rendered};
  }

  it('uses an intentional 800ms delay', () => {
    expect(MOTOR_TEST_LONG_PRESS_DELAY_MILLIS).toBe(800);
    const {rendered} = readyRendered();
    expect(rendered.find('motors-hold-button').props.delayLongPress).toBe(800);
    rendered.unmount();
  });

  it('never activates on press-in, on a tap, or on a plain press', () => {
    const {operator, rendered} = readyRendered();
    const hold = rendered.find('motors-hold-button');
    act(() => {
      hold.props.onPressIn?.();
      hold.props.onPress?.();
    });
    expect(operator.pulseCalls).toEqual([]);
    // A short tap and release: no pulse, and no stop either - nothing was
    // ever submitted, so there is nothing to stop.
    pressOut(rendered);
    expect(operator.pulseCalls).toEqual([]);
    expect(operator.stopCalls).toEqual([]);
    rendered.unmount();
  });

  it('activates exactly the selected output, exactly once per hold', () => {
    const {operator, rendered} = readyRendered();
    rendered.press('motors-slot-3');
    longPress(rendered);
    longPress(rendered);
    longPress(rendered);
    expect(operator.pulseCalls).toEqual([3]);
    rendered.unmount();
  });

  it('stops on release during the pre-acknowledgement window', () => {
    const {operator, rendered} = readyRendered();
    longPress(rendered);
    // The controller latches mayHaveReachedFc at activation, BEFORE any
    // acknowledgement - so a release here must still stop.
    act(() => {
      operator.publish(
        snapshotFor({
          machine: 'Pulsing',
          startAcknowledged: false,
          allowed: false,
          mayHaveReachedFc: true,
        }),
      );
    });
    pressOut(rendered);
    expect(operator.stopCalls).toEqual(['TOUCH_RELEASED']);
    rendered.unmount();
  });

  it('stops on release during an acknowledged pulse', () => {
    const {operator, rendered} = readyRendered();
    longPress(rendered);
    act(() => {
      operator.publish(
        snapshotFor({
          machine: 'Pulsing',
          startAcknowledged: true,
          allowed: false,
          mayHaveReachedFc: true,
        }),
      );
    });
    pressOut(rendered);
    expect(operator.stopCalls).toEqual(['TOUCH_RELEASED']);
    rendered.unmount();
  });

  it('follows the same stop route when the gesture is terminated', () => {
    const {operator, rendered} = readyRendered();
    longPress(rendered);
    act(() => {
      operator.publish(
        snapshotFor({machine: 'Pulsing', mayHaveReachedFc: true, allowed: false}),
      );
    });
    act(() => {
      rendered.find('motors-hold-button').props.onResponderTerminate?.();
    });
    expect(operator.stopCalls).toEqual(['TOUCH_RELEASED']);
    rendered.unmount();
  });

  it('lets repeated release and Stop callbacks reach the controller, which joins them', () => {
    const {operator, rendered} = readyRendered();
    longPress(rendered);
    act(() => {
      operator.publish(
        snapshotFor({machine: 'Pulsing', mayHaveReachedFc: true, allowed: false}),
      );
    });
    pressOut(rendered);
    pressOut(rendered);
    rendered.press('motors-stop-button');
    rendered.press('motors-stop-button');
    // The screen does NOT deduplicate - joining is the controller's
    // accepted, proven behaviour, and a UI that filtered here could drop
    // the one call that mattered.
    expect(operator.stopCalls).toEqual([
      'TOUCH_RELEASED',
      'TOUCH_RELEASED',
      'STOP_BUTTON_PRESSED',
      'STOP_BUTTON_PRESSED',
    ]);
    rendered.unmount();
  });

  it('stops the live episode on a motor switch and never auto-starts the second output', () => {
    const {operator, rendered} = readyRendered();
    rendered.press('motors-slot-1');
    longPress(rendered);
    act(() => {
      operator.publish(
        snapshotFor({machine: 'Pulsing', mayHaveReachedFc: true, allowed: false}),
      );
    });

    rendered.press('motors-slot-2');
    expect(operator.stopCalls).toEqual(['MOTOR_SELECTION_CHANGED']);
    // Motor 2 was NOT started. Only the original activation happened.
    expect(operator.pulseCalls).toEqual([1]);
    rendered.unmount();
  });

  it('keeps Stop mounted and enabled in every state where a command may be live', () => {
    for (const machine of [
      'Ready',
      'Starting',
      'Pulsing',
      'Stopping',
      'Fault',
    ] as const) {
      const operator = new FakeOperator(
        snapshotFor({machine, allowed: false, mayHaveReachedFc: true}),
      );
      const rendered = render(operator);
      const stop = rendered.find('motors-stop-button');
      expect(stop.props.disabled).toBeFalsy();
      expect(stop.props.accessibilityState?.disabled).toBe(false);
      rendered.press('motors-stop-button');
      expect(operator.stopCalls).toEqual(['STOP_BUTTON_PRESSED']);
      rendered.unmount();
    }
  });
});

/* ================================================================== *
 * Safety events, ambiguity and lifecycle
 * ================================================================== */

describe('MotorsScreen - safety dominance', () => {
  it('surfaces a command-214 attribution ambiguity as Fault, never as success', () => {
    const operator = new FakeOperator(snapshotFor({allowed: true}));
    const rendered = render(operator);
    acknowledgeAll(rendered);

    act(() => {
      operator.publish(
        snapshotFor({
          machine: 'Fault',
          allowed: false,
          mayHaveReachedFc: true,
          attributionAmbiguous: true,
          reasons: ['STOP_SEALED'],
        }),
      );
    });
    expect(rendered.query('motors-status-FAULT')).toBeDefined();
    expect(rendered.query('motors-emergency-text')).toBeDefined();
    expect(rendered.find('motors-hold-button').props.disabled).toBe(true);
    // No success wording of any kind survives into a fault presentation.
    const rendering = texts(rendered);
    expect(rendering).not.toContain('تم الإيقاف');
    expect(rendering).not.toContain('نجح');
    rendered.unmount();
  });

  it.each([
    'SAFETY_EVENT_LATCHED',
    'AUTHORITY_STALE',
    'ARMING_RESTRICTION_NOT_CURRENT',
    'MOTOR_SCOPE_UNSUPPORTED',
    'TELEMETRY_BARRIER_NOT_HELD',
  ] as const)('lets %s dominate UI interaction', reason => {
    const operator = new FakeOperator(snapshotFor({allowed: true}));
    const rendered = render(operator);
    acknowledgeAll(rendered);
    act(() => {
      operator.publish(
        snapshotFor({machine: 'Locked', allowed: false, reasons: [reason]}),
      );
    });
    expect(rendered.find('motors-hold-button').props.disabled).toBe(true);
    longPress(rendered);
    expect(operator.pulseCalls).toEqual([]);
    expect(rendered.query(`motors-block-${reason}`)).toBeDefined();
    rendered.unmount();
  });
});

describe('MotorsScreen - no leaks, no stale mutation', () => {
  it('unsubscribes on unmount and leaves no listener behind', () => {
    const operator = new FakeOperator(snapshotFor({}));
    const rendered = render(operator);
    expect(operator.listenerCount).toBe(1);
    rendered.unmount();
    expect(operator.listenerCount).toBe(0);
  });

  it('cannot mutate an unmounted screen from a late publish', () => {
    const operator = new FakeOperator(snapshotFor({}));
    const rendered = render(operator);
    rendered.unmount();
    // A publish arriving after unmount must be inert - no setState, no
    // throw, no warning.
    expect(() => {
      operator.publish(snapshotFor({machine: 'Fault'}));
    }).not.toThrow();
  });

  it('binds to the replacement operator and never to the old one', () => {
    const first = new FakeOperator(snapshotFor({allowed: true}));
    const second = new FakeOperator(
      snapshotFor({machine: 'Checking', allowed: false}),
    );
    let tree!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      tree = ReactTestRenderer.create(<MotorsScreenView operator={first} />);
    });
    act(() => {
      tree.update(<MotorsScreenView operator={second} />);
    });
    // The old session's subscription is gone, so a stale publish from it
    // can never reach the screen now showing a different session.
    expect(first.listenerCount).toBe(0);
    expect(second.listenerCount).toBe(1);
    act(() => {
      first.publish(snapshotFor({machine: 'Fault'}));
    });
    // Still showing the REPLACEMENT session's state, not the stale
    // operator's Fault. (findAll matches the composite and its host node,
    // so presence is asserted rather than an exact node count.)
    expect(
      tree.root.findAll(n => n.props?.testID === 'motors-status-CHECKING')
        .length,
    ).toBeGreaterThan(0);
    expect(
      tree.root.findAll(n => n.props?.testID === 'motors-status-FAULT'),
    ).toHaveLength(0);
    act(() => {
      tree.unmount();
    });
  });

  it('creates no timer of its own', () => {
    jest.useFakeTimers();
    try {
      const operator = new FakeOperator(snapshotFor({allowed: true}));
      const rendered = render(operator);
      acknowledgeAll(rendered);
      longPress(rendered);
      // The three-second watchdog belongs to the controller. A UI timer
      // racing it could only ever disagree with it.
      expect(jest.getTimerCount()).toBe(0);
      rendered.unmount();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });
});

/* ================================================================== *
 * Expected reference and containment
 * ================================================================== */

describe('MotorsScreen - expected reference is labelled as expected', () => {
  it('renders the accepted Quad X props-out mapping', () => {
    expect(EXPECTED_QUAD_X_REFERENCE.map(e => [e.slot, e.directionKey])).toEqual(
      [
        [1, 'directionCcw'],
        [2, 'directionCw'],
        [3, 'directionCw'],
        [4, 'directionCcw'],
      ],
    );
    const rendered = render(new FakeOperator(snapshotFor({})));
    for (const slot of MOTOR_TEST_OUTPUT_SLOTS) {
      expect(rendered.query(`motors-expected-${slot}`)).toBeDefined();
    }
    // Explicitly labelled EXPECTED, not confirmed. This test asserts the
    // label only; it establishes NOTHING about real wiring, physical frame
    // position or rotation direction - that is Phase 2I plus the
    // operator's own physical observation.
    const notice = rendered.find('motors-diagram-notice');
    expect(notice.props.children).toContain('المتوقع');
    expect(notice.props.children).toContain('وليس نتيجة مؤكدة');
    rendered.unmount();
  });

  it('makes no physical-stop, rotation, RPM or temperature claim', () => {
    const rendered = render(
      new FakeOperator(
        snapshotFor({machine: 'Pulsing', startAcknowledged: true}),
      ),
    );
    const rendering = texts(rendered);
    for (const forbidden of [
      'دورة في الدقيقة',
      'RPM',
      'rpm',
      'الحرارة',
      'توقف المحرك فعليًا',
      'تم التحقق من الاتجاه',
    ]) {
      expect(rendering).not.toContain(forbidden);
    }
    rendered.unmount();
  });
});

describe('MotorsScreen - containment', () => {
  const source = readFileSync(join(__dirname, 'MotorsScreen.tsx'), 'utf8');
  const executable = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  it('contains no motor command, magnitude, payload or transport call', () => {
    for (const forbidden of [
      'writeBytes',
      'MSP_SET_MOTOR',
      'encodeSetMotorPayload',
      'buildSingleMotorVector',
      'buildAllStopVector',
      'MspClient',
      'MotorTestLease',
      'acquireMotorTestLease',
      'emergencyStop',
      'transport',
    ]) {
      expect(executable).not.toContain(forbidden);
    }
    // No motor magnitude of any kind is named here.
    expect(executable).not.toMatch(/\b214\b/);
    expect(executable).not.toMatch(/\b1050\b/);
    expect(executable).not.toMatch(/\b1000\b/);
  });

  it('re-derives no safety condition of its own', () => {
    // Battery, armed state, lease, authority, scope and capability are
    // evaluated once, in the controller. The screen reads the verdict.
    for (const forbidden of [
      'batteryCellCount',
      'isArmed',
      'feature3dEnabled',
      'motorProtocolRaw',
      'assertSupportedMotorScope',
      'officialSessionAuthority',
    ]) {
      expect(executable).not.toContain(forbidden);
    }
    expect(executable).toContain('activation.allowed');
  });

  it('creates no second session, controller or timer', () => {
    expect(executable).not.toContain('createMotorTestController');
    expect(executable).not.toContain('setInterval');
    expect(executable).not.toContain('setTimeout');
    // The one binding it does use resolves the EXISTING capability.
    expect(executable).toContain('getMotorTestSessionCapability');
  });
});

/* ================================================================== *
 * Pure derivations
 * ================================================================== */

describe('MotorsScreen - pure derivations', () => {
  it('derives NO_SESSION without a machine', () => {
    expect(derivePresentation(undefined)).toBe('NO_SESSION');
    expect(
      derivePresentation({...snapshotFor({}), machine: undefined}),
    ).toBe('NO_SESSION');
  });

  it('reads may-be-live from the controller record only', () => {
    expect(commandMayBeLive(undefined)).toBe(false);
    expect(commandMayBeLive(snapshotFor({mayHaveReachedFc: false}))).toBe(false);
    expect(commandMayBeLive(snapshotFor({mayHaveReachedFc: true}))).toBe(true);
  });
});
