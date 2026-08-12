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

import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  MotorsScreenView,
  MOTOR_TEST_LONG_PRESS_DELAY_MILLIS,
  MOTOR_TEST_OUTPUT_SLOTS,
  computeMotorGlyphLayout,
  commandMayBeLive,
  derivePresentation,
  endMotorTestSessionSafely,
} from './MotorsScreen';
import '../../i18n';
import i18n from '../../i18n';
import type {
  MotorTestActivationBlockReason,
  MotorTestControllerSnapshot,
  MotorTestPulseRequestResult,
  MotorTestStopRequestResult,
} from '../../core/state/motorTestController';
import type { MotorTestStopTriggerReason } from '../../core/state/motorTestStateMachine';
import type { MotorTestOperatorPort } from '../../platforms/react-native/protocol';

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
      return { name, authority: AUTHORITY, startSubmitted: true } as const;
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
      return { name, authority: AUTHORITY } as const;
  }
}

function snapshotFor(options: {
  machine?: MachineName;
  startAcknowledged?: boolean;
  allowed?: boolean;
  reasons?: MotorTestActivationBlockReason[];
  mayHaveReachedFc?: boolean;
  attributionAmbiguous?: boolean;
  attributionResolvedByConfirmation?: boolean;
  stopOutcome?: MotorTestControllerSnapshot['stopExecution']['outcome'];
  stopAcknowledged?: boolean;
  receipt?: MotorTestControllerSnapshot['verificationReceipt'];
}): MotorTestControllerSnapshot {
  const machineName = options.machine ?? 'Ready';
  const allowed = options.allowed ?? machineName === 'Ready';
  return {
    phase: 'ACTIVE',
    setupStep: 'READY',
    machine: machineFor(machineName, options.startAcknowledged ?? false),
    outcome: { kind: 'READY' },
    firmwareCompatibility: undefined,
    motorScope: { motorCount: 4, motorProtocolRaw: 7, feature3dEnabled: false },
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
    warnings: [],
    stopDescriptors: [],
    teardown: undefined,
    stopExecution: {
      attempts: 0,
      commandDispatched: false,
      commandAcknowledged: options.stopAcknowledged ?? false,
      physicalStopConfirmed: false,
      deferredBehindActiveWrite: false,
      attributionAmbiguous: options.attributionAmbiguous ?? false,
      attributionResolvedByConfirmation:
        options.attributionResolvedByConfirmation ?? false,
      wirePreemptionClaimed: false,
      submittedNextOnTransport: false,
      episodeId: 0,
      outcome: options.stopOutcome,
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
  } as MotorTestControllerSnapshot;
}

/* ------------------------------------------------------------------ *
 * The operator-port double
 *
 * Exactly the members of the real sealed facade. It CANNOT reach a
 * client, transport, lease, encoder or authority, because the real port
 * cannot either - so a test can never exercise a path production code
 * does not have.
 * ------------------------------------------------------------------ */

class FakeOperator implements MotorTestOperatorPort {
  snapshot: MotorTestControllerSnapshot;
  beginCalls = 0;
  endCalls = 0;
  renewCalls = 0;
  beginResult: Promise<MotorTestControllerSnapshot> | undefined;
  endResult: Promise<MotorTestControllerSnapshot> | undefined;
  endError: Error | undefined;
  readonly pulseCalls: number[] = [];
  readonly stopCalls: MotorTestStopTriggerReason[] = [];
  pulseResult: MotorTestPulseRequestResult = 'ACCEPTED';
  private readonly listeners = new Set<() => void>();

  constructor(snapshot: MotorTestControllerSnapshot) {
    this.snapshot = snapshot;
  }

  beginSession(): Promise<MotorTestControllerSnapshot> {
    this.beginCalls += 1;
    return this.beginResult ?? Promise.resolve(this.snapshot);
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

  renewPulseHold(): 'RENEWED' | 'NO_ACTIVE_PULSE' {
    this.renewCalls += 1;
    return this.snapshot.pulse.mayHaveReachedFc
      ? 'RENEWED'
      : 'NO_ACTIVE_PULSE';
  }

  setEscDirection(
    motorNumber: number,
    direction: import('../../core').DshotEscDirection,
  ): Promise<import('../../core/state/motorTestController').MotorTestEscDirectionOutcome> {
    return Promise.resolve({
      kind: 'ACKNOWLEDGED',
      motorNumber,
      direction,
      physicallyVerified: false,
    });
  }

  refreshDiagnostics() {
    return Promise.resolve(
      this.snapshot.diagnostics ?? {
        outputs: {state: 'WAITING' as const, value: undefined, observedAtMillis: undefined},
        escTelemetry: {state: 'WAITING' as const, value: undefined, observedAtMillis: undefined},
      },
    );
  }

  requestStop(trigger: MotorTestStopTriggerReason): MotorTestStopRequestResult {
    this.stopCalls.push(trigger);
    return 'ACCEPTED';
  }

  // P3: professional facade. The fakes record calls; refusal by default
  // mirrors a session with no engine.
  professionalCalls: Array<{op: string; args: unknown[]}> = [];
  setMotorValues(values: readonly number[]) {
    this.professionalCalls.push({op: 'setMotorValues', args: [values]});
    return {kind: 'ACCEPTED' as const, coalesced: false};
  }
  setMotorValue(motorIndex: number, value: number) {
    this.professionalCalls.push({op: 'setMotorValue', args: [motorIndex, value]});
    return {kind: 'ACCEPTED' as const, coalesced: false};
  }
  setMaster(value: number) {
    this.professionalCalls.push({op: 'setMaster', args: [value]});
    return {kind: 'ACCEPTED' as const, coalesced: false};
  }
  stopAll() {
    this.professionalCalls.push({op: 'stopAll', args: []});
    return this.requestStop('STOP_BUTTON_PRESSED');
  }
  endSession(): Promise<MotorTestControllerSnapshot> {
    this.endCalls += 1;
    if (this.endError !== undefined) throw this.endError;
    return this.endResult ?? Promise.resolve(this.snapshot);
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
      // The node that owns the gesture. `onPress?.()` on the first testID
      // match silently no-ops for a ToggleSwitch, which would let a
      // session test pass while pressing nothing at all.
      const node = tree.root
        .findAll(candidate => candidate.props?.testID === testID)
        .find(candidate => typeof candidate.props?.onPress === 'function');
      if (node === undefined) {
        throw new Error(`no pressable node with testID "${testID}"`);
      }
      act(() => {
        node.props.onPress();
      });
    },
    unmount: () => {
      act(() => {
        tree.unmount();
      });
    },
  };
}

/** Compatibility helper for older flow tests. The checkbox ritual was
 * intentionally removed; the controller is now the only gate. */
function acknowledgeAll(rendered: Rendered): void {
  expect(rendered.query('motors-ack-propellers')).toBeUndefined();
}

function longPress(rendered: Rendered): void {
  act(() => {
    const hold = rendered.find('motors-hold-button');
    hold.props.onPressIn?.();
    hold.props.onLongPress?.();
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
      new FakeOperator(snapshotFor({ machine: machine as MachineName })),
    );
    expect(rendered.query(`motors-status-${expected}`)).toBeDefined();
    rendered.unmount();
  });

  it('distinguishes a submitted-but-unacknowledged pulse from an acknowledged one', () => {
    const preAck = render(
      new FakeOperator(
        snapshotFor({ machine: 'Pulsing', startAcknowledged: false }),
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
        snapshotFor({ machine: 'Pulsing', startAcknowledged: true }),
      ),
    );
    expect(acked.query('motors-status-ACKNOWLEDGED')).toBeDefined();
    // ... and it says explicitly that reception is not rotation.
    expect(acked.query('motors-ack-notice')).toBeDefined();
    acked.unmount();
  });

  /* THE RED BANNER IS NOT "THERE WAS A FAULT".
     On the device, ANY fault printed "stop could not be confirmed -
     disconnect the LiPo", including one caused by a safety read that the
     app's own stop had displaced. An operator whose motor had in fact
     been stopped cleanly was told to pull the battery, which is exactly
     how the one message that must never be ignored stops being read. */

  it('shows the LiPo instruction when a command may be live and the stop is unconfirmed', () => {
    const rendered = render(
      new FakeOperator(
        snapshotFor({
          machine: 'Fault',
          allowed: false,
          mayHaveReachedFc: true,
          stopOutcome: { kind: 'FAILED', reason: 'REQUEST_FAILED' },
        }),
      ),
    );
    const emergency = rendered.find('motors-emergency-text');
    expect(emergency.props.children).toBe(
      'تعذّر تأكيد توقف المحرك — افصل بطارية LiPo فورًا',
    );
    expect(rendered.query('motors-new-session-text')).toBeDefined();
    rendered.unmount();
  });

  it('shows it for an ambiguity that was never resolved', () => {
    const rendered = render(
      new FakeOperator(
        snapshotFor({
          machine: 'Fault',
          allowed: false,
          mayHaveReachedFc: true,
          attributionAmbiguous: true,
          attributionResolvedByConfirmation: false,
          stopOutcome: { kind: 'FAILED', reason: 'ATTRIBUTION_AMBIGUOUS' },
        }),
      ),
    );
    expect(rendered.query('motors-fault-banner')).toBeDefined();
    rendered.unmount();
  });

  it('does NOT show it for a fault whose stop was genuinely acknowledged', () => {
    // The exact device case: a monitoring read displaced by this app's own
    // stop faulted the session, while the stop itself was acknowledged.
    const rendered = render(
      new FakeOperator(
        snapshotFor({
          machine: 'Fault',
          allowed: false,
          mayHaveReachedFc: true,
          stopAcknowledged: true,
          stopOutcome: { kind: 'ACKNOWLEDGED' },
        }),
      ),
    );
    expect(rendered.query('motors-fault-banner')).toBeUndefined();
    expect(rendered.query('motors-emergency-text')).toBeUndefined();
    // The session did end, and the screen says so - without inventing a
    // battery emergency.
    expect(rendered.query('motors-fault-notice')).toBeDefined();
    expect(texts(rendered)).toContain('انتهت جلسة الاختبار.');
    expect(texts(rendered)).not.toContain(
      'تعذّر تأكيد توقف المحرك — افصل بطارية LiPo فورًا',
    );
    rendered.unmount();
  });

  it('does NOT show it when a resolved ambiguity ended in an acknowledged stop', () => {
    const rendered = render(
      new FakeOperator(
        snapshotFor({
          machine: 'Fault',
          allowed: false,
          mayHaveReachedFc: true,
          stopAcknowledged: true,
          attributionAmbiguous: true,
          attributionResolvedByConfirmation: true,
          stopOutcome: { kind: 'ACKNOWLEDGED' },
        }),
      ),
    );
    expect(rendered.query('motors-fault-banner')).toBeUndefined();
    rendered.unmount();
  });

  it('does NOT show it when no motor command was ever submitted', () => {
    const rendered = render(
      new FakeOperator(snapshotFor({ machine: 'Fault', allowed: false })),
    );
    expect(rendered.query('motors-fault-banner')).toBeUndefined();
    expect(rendered.query('motors-fault-notice')).toBeDefined();
    rendered.unmount();
  });

  it('shows the FIRST CAUSAL reason only, with consequences in diagnostics', () => {
    // CONTRACT CHANGED ON DEVICE EVIDENCE.
    // A terminal fault always drags a dead link along with it, and the
    // dead link is not the story. Showing both is what made one failure
    // read as several independent hardware faults on the bench.
    const rendered = render(
      new FakeOperator(
        snapshotFor({
          machine: 'Locked',
          allowed: false,
          reasons: ['REQUIRES_NEW_CONNECTION', 'CONTROLLER_LINK_UNAVAILABLE'],
        }),
      ),
    );
    expect(
      rendered.query('motors-block-REQUIRES_NEW_CONNECTION'),
    ).toBeDefined();
    expect(
      rendered.query('motors-block-CONTROLLER_LINK_UNAVAILABLE'),
    ).toBeUndefined();

    // The full array is not lost - it is one tap away, under diagnostics.
    expect(rendered.query('motors-diagnostics')).toBeUndefined();
    rendered.press('motors-diagnostics-toggle');
    expect(
      rendered.query('motors-diagnostic-CONTROLLER_LINK_UNAVAILABLE'),
    ).toBeDefined();
    expect(
      rendered.query('motors-diagnostic-REQUIRES_NEW_CONNECTION'),
    ).toBeDefined();
    // Complete technical state stays behind the same toggle.
    expect(rendered.query('motors-diagnostic-outcome')).toBeDefined();
    expect(rendered.query('motors-diagnostic-evidence')).toBeDefined();
    rendered.unmount();
  });

  it('never shows a teardown consequence as the headline cause', () => {
    // The exact device presentation: a torn-down session emits its whole
    // consequence set. None of them may become the headline.
    const rendered = render(
      new FakeOperator(
        snapshotFor({
          machine: 'Locked',
          allowed: false,
          reasons: [
            'CONTROLLER_LINK_UNAVAILABLE',
            'REQUIRES_NEW_CONNECTION',
            'PULSE_OR_STOP_IN_PROGRESS',
            'MOTOR_SCOPE_UNSUPPORTED',
          ],
        }),
      ),
    );
    // The real cause wins over every consequence regardless of the order
    // the controller happened to emit them in.
    expect(
      rendered.query('motors-block-MOTOR_SCOPE_UNSUPPORTED'),
    ).toBeDefined();
    for (const consequence of [
      'CONTROLLER_LINK_UNAVAILABLE',
      'REQUIRES_NEW_CONNECTION',
      'PULSE_OR_STOP_IN_PROGRESS',
    ]) {
      expect(rendered.query(`motors-block-${consequence}`)).toBeUndefined();
    }
    rendered.unmount();
  });

  it('shows an ARMED flight controller ahead of everything it caused', () => {
    // An armed reading LOCKS the session, so it always arrives paired with
    // the terminal reason. Being told to reconnect instead of being told
    // the aircraft is armed would be a serious regression.
    const rendered = render(
      new FakeOperator(
        snapshotFor({
          machine: 'Locked',
          allowed: false,
          reasons: ['REQUIRES_NEW_CONNECTION', 'FC_ARMED'],
        }),
      ),
    );
    expect(rendered.query('motors-block-FC_ARMED')).toBeDefined();
    expect(
      rendered.query('motors-block-REQUIRES_NEW_CONNECTION'),
    ).toBeUndefined();
    expect(texts(rendered)).toContain('وحدة التحكم مسلّحة؛ الاختبار ممنوع.');
    rendered.unmount();
  });

  it('distinguishes an unreadable armed state from an armed one', () => {
    const rendered = render(
      new FakeOperator(
        snapshotFor({
          machine: 'Locked',
          allowed: false,
          reasons: ['REQUIRES_NEW_CONNECTION', 'ARMED_STATE_UNKNOWN_OR_STALE'],
        }),
      ),
    );
    expect(
      rendered.query('motors-block-ARMED_STATE_UNKNOWN_OR_STALE'),
    ).toBeDefined();
    expect(texts(rendered)).toContain(
      'تعذّرت قراءة حالة التسليح أو أصبحت القراءة قديمة.',
    );
    // ... and never reported as an armed aircraft, which it is not.
    expect(texts(rendered)).not.toContain(
      'وحدة التحكم مسلّحة؛ الاختبار ممنوع.',
    );
    rendered.unmount();
  });

  it('places the exact terminal readiness failure beside the dim hold control', () => {
    const blocked = {
      ...snapshotFor({
        machine: 'Locked',
        allowed: false,
        reasons: ['REQUIRES_NEW_CONNECTION', 'ARMED_STATE_UNKNOWN_OR_STALE'],
      }),
      phase: 'CLOSED' as const,
      setupStep: 'FIRST_OBSERVATION' as const,
      outcome: {
        kind: 'FAILED_CLOSED' as const,
        reason: 'FIRST_OBSERVATION_UNAVAILABLE' as const,
        faultReason: 'MSP_RESPONSE_TIMEOUT' as const,
        requiresNewSession: true as const,
      },
      teardown: {
        steps: [],
        safetyMonitorStopped: true,
        leaseRelease: 'RELEASED' as const,
        telemetryTokensReleased: true,
      armingRestrictionRelease: 'RELEASED' as const,
        complete: true,
      },
    } satisfies MotorTestControllerSnapshot;
    const rendered = render(new FakeOperator(blocked));

    expect(rendered.query('motors-readiness-blocked-detail')).toBeDefined();
    expect(texts(rendered)).toContain(
      'توقف فحص الجاهزية عند FIRST_OBSERVATION (رمز التشخيص: FIRST_OBSERVATION_UNAVAILABLE). لم يُرسل التطبيق أمر تشغيل للمحرك.',
    );
    expect(rendered.find('motors-hold-button').props.disabled).toBe(true);
    rendered.unmount();
  });

  it('explains the READY-but-barred state captured by browser diagnostics', () => {
    const barredReady = {
      ...snapshotFor({
        machine: 'Ready',
        allowed: false,
        reasons: [
          'REQUIRES_NEW_CONNECTION',
          'ARMED_STATE_UNKNOWN_OR_STALE',
        ],
      }),
      phase: 'ACTIVE' as const,
      setupStep: 'READY' as const,
      outcome: {kind: 'READY' as const},
      armedStateEvidence: 'UNKNOWN_OR_STALE' as const,
      motorDomain: undefined,
      motorRuntimeScope: undefined,
    } satisfies MotorTestControllerSnapshot;
    const rendered = render(new FakeOperator(barredReady));

    expect(rendered.query('motors-readiness-blocked-detail')).toBeDefined();
    expect(texts(rendered)).toContain(
      'توقف فحص الجاهزية عند READY (رمز التشخيص: ARMED_STATE_UNKNOWN_OR_STALE). لم يُرسل التطبيق أمر تشغيل للمحرك.',
    );
    expect(texts(rendered)).toContain(
      'أغلق جلسة الاختبار، افصل USB وأعد توصيله، ثم ابدأ جلسة جديدة بعد معالجة السبب أعلاه.',
    );
    expect(rendered.find('motors-hold-button').props.disabled).toBe(true);
    rendered.unmount();
  });

  it('names 3D specifically rather than as a generic scope refusal', () => {
    const rendered = render(
      new FakeOperator(
        snapshotFor({
          machine: 'Locked',
          allowed: false,
          reasons: ['MOTOR_3D_ENABLED'],
        }),
      ),
    );
    expect(rendered.query('motors-block-MOTOR_3D_ENABLED')).toBeDefined();
    expect(texts(rendered)).toContain('إعداد 3D غير مدعوم.');
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
  it('keeps the safety notice before one integrated motor workspace', () => {
    const rendered = render(new FakeOperator(snapshotFor({ allowed: true })));
    const ids = rendered.tree.root
      .findAll(node => typeof node.props?.testID === 'string')
      .map(node => node.props.testID as string);
    expect(ids.indexOf('motors-acknowledgements')).toBeLessThan(
      ids.indexOf('motors-workspace'),
    );
    expect(ids.indexOf('motors-diagram')).toBeLessThan(
      ids.indexOf('motors-hold-button'),
    );
    rendered.unmount();
  });

  it('keeps the workspace visible without legacy acknowledgement checkboxes', () => {
    const rendered = render(undefined);
    const ids = rendered.tree.root
      .findAll(node => typeof node.props?.testID === 'string')
      .map(node => node.props.testID as string);
    expect(ids).not.toContain('motors-begin-session-card');
    expect(ids).toContain('motors-hold-button');
    rendered.unmount();
  });

  it('does NOT enable activation on Ready alone when the controller bars it', () => {
    // Exactly the Phase 2G finding: a locking safety event while idle
    // leaves the reducer in Ready while activation must stay barred.
    const operator = new FakeOperator(
      snapshotFor({
        machine: 'Ready',
        allowed: false,
        reasons: ['REQUIRES_NEW_CONNECTION'],
      }),
    );
    const rendered = render(operator);
    acknowledgeAll(rendered);
    expect(rendered.find('motors-hold-button').props.disabled).toBe(true);
    longPress(rendered);
    expect(operator.pulseCalls).toEqual([]);
    rendered.unmount();
  });

  it('does not require checkbox rituals when the controller allows', () => {
    const operator = new FakeOperator(snapshotFor({ allowed: true }));
    const rendered = render(operator);
    expect(rendered.find('motors-hold-button').props.disabled).toBe(false);
    expect(rendered.query('motors-ack-propellers')).toBeUndefined();
    longPress(rendered);
    expect(operator.pulseCalls).toEqual([1]);
    rendered.unmount();
  });

  it('keeps warnings informational while lock and fault remain controller gates', () => {
    for (const machine of ['Locked', 'Fault'] as const) {
      const operator = new FakeOperator(snapshotFor({ allowed: true }));
      const rendered = render(operator);
      expect(rendered.find('motors-hold-button').props.disabled).toBe(false);

      act(() => {
        operator.publish(snapshotFor({ machine, allowed: false }));
      });
      act(() => {
        operator.publish(snapshotFor({ allowed: true }));
      });
      expect(rendered.find('motors-hold-button').props.disabled).toBe(false);
      rendered.unmount();
    }
  });

  it('re-reads the authoritative gate at call time, not at render time', () => {
    const operator = new FakeOperator(snapshotFor({ allowed: true }));
    const rendered = render(operator);
    acknowledgeAll(rendered);
    // The gate closes WITHOUT a re-render reaching the handler's closure.
    operator.snapshot = snapshotFor({
      allowed: false,
      reasons: ['CONTROLLER_LINK_UNAVAILABLE'],
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
  function readyRendered(): { operator: FakeOperator; rendered: Rendered } {
    const operator = new FakeOperator(snapshotFor({ allowed: true }));
    const rendered = render(operator);
    acknowledgeAll(rendered);
    return { operator, rendered };
  }

  it('uses an intentional 800ms delay', () => {
    expect(MOTOR_TEST_LONG_PRESS_DELAY_MILLIS).toBe(800);
    const { rendered } = readyRendered();
    expect(rendered.find('motors-hold-button').props.delayLongPress).toBe(800);
    rendered.unmount();
  });

  /**
   * REWRITTEN IN P3. The hold action used to live in the always-pinned
   * dock, which made press-and-hold read as THE way to drive motors. The
   * professional workspace is the primary path now, so the hold control
   * moved into the التحقق والأدوات bench area - still fully functional,
   * no longer pinned teaching.
   *
   * THE DOCK NOW PINS STOP AND NOTHING ELSE. The end-session rectangle it
   * used to carry is gone: session lifecycle belongs to the ONE جلسة
   * المحركات switch at the top of the workspace, and a second remote
   * control for the same authority was the confusion the operator
   * reported. STOP stays pinned because STOP is not a lifecycle action.
   */
  it('pins STOP only; lifecycle lives on the session switch and the hold action in the tools bench', () => {
    const { rendered } = readyRendered();
    const dock = rendered.find('motors-session-dock');
    expect(dock.findAll(node => node.props?.testID === 'motors-hold-button')).toHaveLength(0);
    expect(dock.findAll(node => node.props?.testID === 'motors-stop-button').length).toBeGreaterThan(0);
    // No session lifecycle control in the dock - anywhere.
    expect(
      dock.findAll(node => node.props?.testID === 'motors-end-session-button'),
    ).toHaveLength(0);
    expect(
      dock.findAll(node => node.props?.testID === 'motor-session-toggle'),
    ).toHaveLength(0);
    // The hold action itself remains reachable, after the diagram.
    expect(rendered.find('motors-hold-button')).toBeDefined();
    rendered.unmount();
  });

  it('never activates on press-in, on a tap, or on a plain press', () => {
    const { operator, rendered } = readyRendered();
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

  it('prepares explicitly and never pulses during setup', async () => {
    const initial = {
      ...snapshotFor({allowed: false}),
      phase: 'IDLE' as const,
      setupStep: 'NOT_STARTED' as const,
      machine: undefined,
      telemetryHeld: false,
    } as MotorTestControllerSnapshot;
    const operator = new FakeOperator(initial);
    let resolveBegin!: (snapshot: MotorTestControllerSnapshot) => void;
    operator.beginResult = new Promise(resolve => {
      resolveBegin = resolve;
    });
    const rendered = render(operator);
    rendered.press('motor-session-toggle');
    expect(operator.beginCalls).toBe(1);
    expect(operator.pulseCalls).toEqual([]);
    const ready = snapshotFor({allowed: true});
    await act(async () => {
      operator.publish(ready);
      resolveBegin(ready);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(operator.pulseCalls).toEqual([]);
    longPress(rendered);
    expect(operator.pulseCalls).toEqual([1]);
    rendered.unmount();
  });

  it('uses the resolved official begin result even when no final publish follows', async () => {
    const initial = {
      ...snapshotFor({allowed: false}),
      phase: 'IDLE' as const,
      setupStep: 'NOT_STARTED' as const,
      machine: undefined,
      telemetryHeld: false,
    } as MotorTestControllerSnapshot;
    const operator = new FakeOperator(initial);
    const ready = snapshotFor({allowed: true});
    operator.beginResult = Promise.resolve().then(() => {
      // The controller's getter is authoritative immediately, but it does not
      // emit one extra publication after resolving setup in this regression
      // fixture.
      operator.snapshot = ready;
      return ready;
    });
    const rendered = render(operator);

    rendered.press('motor-session-toggle');
    await act(async () => {
      await operator.beginResult;
      await Promise.resolve();
    });

    expect(rendered.find('motors-hold-button').props.disabled).toBe(false);
    expect(rendered.query('motors-session-ready')).toBeDefined();
    longPress(rendered);
    expect(operator.pulseCalls).toEqual([1]);
    rendered.unmount();
  });

  it('activates exactly the selected output, exactly once per hold', () => {
    const { operator, rendered } = readyRendered();
    rendered.press('motors-slot-3');
    longPress(rendered);
    act(() => {
      const hold = rendered.find('motors-hold-button');
      hold.props.onLongPress?.();
      hold.props.onLongPress?.();
    });
    expect(operator.pulseCalls).toEqual([3]);
    rendered.unmount();
  });

  it('stops on release during the pre-acknowledgement window', () => {
    const { operator, rendered } = readyRendered();
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
    const { operator, rendered } = readyRendered();
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
    const { operator, rendered } = readyRendered();
    longPress(rendered);
    act(() => {
      operator.publish(
        snapshotFor({
          machine: 'Pulsing',
          mayHaveReachedFc: true,
          allowed: false,
        }),
      );
    });
    act(() => {
      rendered.find('motors-hold-button').props.onResponderTerminate?.();
    });
    expect(operator.stopCalls).toEqual(['TOUCH_RELEASED']);
    rendered.unmount();
  });

  it('lets repeated release and Stop callbacks reach the controller, which joins them', () => {
    const { operator, rendered } = readyRendered();
    longPress(rendered);
    act(() => {
      operator.publish(
        snapshotFor({
          machine: 'Pulsing',
          mayHaveReachedFc: true,
          allowed: false,
        }),
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
    const { operator, rendered } = readyRendered();
    rendered.press('motors-slot-1');
    longPress(rendered);
    act(() => {
      operator.publish(
        snapshotFor({
          machine: 'Pulsing',
          mayHaveReachedFc: true,
          allowed: false,
        }),
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
        snapshotFor({ machine, allowed: false, mayHaveReachedFc: true }),
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

describe('MotorsScreen - explicit session ending', () => {
  const closedSnapshot = (complete: boolean) => ({
    ...snapshotFor({allowed: false}),
    phase: 'CLOSED' as const,
    teardown: {complete} as MotorTestControllerSnapshot['teardown'],
  }) as MotorTestControllerSnapshot;

  it('stops, waits for PREPARING to settle, then ends once', async () => {
    const operator = new FakeOperator({...snapshotFor({allowed: false, machine: 'Checking'}), phase: 'PREPARING'} as MotorTestControllerSnapshot);
    const closed = closedSnapshot(true);
    operator.endResult = Promise.resolve(closed);
    const ending = endMotorTestSessionSafely(operator);
    expect(operator.stopCalls).toEqual(['STOP_BUTTON_PRESSED']);
    expect(operator.endCalls).toBe(0);
    operator.publish(snapshotFor({allowed: true}));
    await expect(ending).resolves.toBe(closed);
    expect(operator.endCalls).toBe(1);
    expect(operator.listenerCount).toBe(0);
  });

  it('rejects CLOSED with incomplete teardown', async () => {
    const operator = new FakeOperator(snapshotFor({allowed: true}));
    operator.endResult = Promise.resolve(closedSnapshot(false));
    await expect(endMotorTestSessionSafely(operator)).rejects.toThrow('teardown did not complete');
    expect(operator.listenerCount).toBe(0);
  });

  it('rejects a synchronous close failure and releases its listener', async () => {
    const operator = new FakeOperator(snapshotFor({allowed: true}));
    operator.endError = new Error('synchronous close failure');
    await expect(endMotorTestSessionSafely(operator)).rejects.toThrow(
      'synchronous close failure',
    );
    expect(operator.endCalls).toBe(1);
    expect(operator.listenerCount).toBe(0);
  });
});

describe('MotorsScreen - safety dominance', () => {
  it('surfaces a command-214 attribution ambiguity as Fault, never as success', () => {
    const operator = new FakeOperator(snapshotFor({ allowed: true }));
    const rendered = render(operator);
    acknowledgeAll(rendered);

    act(() => {
      operator.publish(
        snapshotFor({
          machine: 'Fault',
          allowed: false,
          mayHaveReachedFc: true,
          attributionAmbiguous: true,
          reasons: ['REQUIRES_NEW_CONNECTION'],
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
    'REQUIRES_NEW_CONNECTION',
    'CONTROLLER_LINK_UNAVAILABLE',
    'FC_ARMED',
    'ARMED_STATE_UNKNOWN_OR_STALE',
    'MOTOR_3D_ENABLED',
    'MOTOR_SCOPE_UNSUPPORTED',
    'PULSE_OR_STOP_IN_PROGRESS',
  ] as const)('lets %s dominate UI interaction', reason => {
    const operator = new FakeOperator(snapshotFor({ allowed: true }));
    const rendered = render(operator);
    acknowledgeAll(rendered);
    act(() => {
      operator.publish(
        snapshotFor({ machine: 'Locked', allowed: false, reasons: [reason] }),
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
      operator.publish(snapshotFor({ machine: 'Fault' }));
    }).not.toThrow();
  });

  it('binds to the replacement operator and never to the old one', () => {
    const first = new FakeOperator(snapshotFor({ allowed: true }));
    const second = new FakeOperator(
      snapshotFor({ machine: 'Checking', allowed: false }),
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
      first.publish(snapshotFor({ machine: 'Fault' }));
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

  it('renews the live pulse while the original touch is held and clears its only timer', () => {
    jest.useFakeTimers();
    try {
      const operator = new FakeOperator(snapshotFor({ allowed: true }));
      const rendered = render(operator);
      acknowledgeAll(rendered);
      longPress(rendered);
      expect(jest.getTimerCount()).toBe(1);
      operator.snapshot = snapshotFor({
        machine: 'Pulsing',
        mayHaveReachedFc: true,
        allowed: false,
      });
      act(() => {
        jest.advanceTimersByTime(900);
      });
      expect(operator.renewCalls).toBe(3);
      expect(jest.getTimerCount()).toBe(1);
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
    expect(
      computeMotorGlyphLayout().map(cell => [cell.slot, cell.directionKey]),
    ).toEqual([
      [2, 'directionCw'],
      [4, 'directionCcw'],
      [1, 'directionCcw'],
      [3, 'directionCw'],
    ]);
    const rendered = render(new FakeOperator(snapshotFor({})));
    for (const slot of MOTOR_TEST_OUTPUT_SLOTS) {
      expect(rendered.query(`motors-diagram-slot-${slot}`)).toBeDefined();
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

  it('uses the airframe itself as a real selector for the exact output slot', () => {
    const operator = new FakeOperator(snapshotFor({ allowed: true }));
    const rendered = render(operator);
    acknowledgeAll(rendered);

    ReactTestRenderer.act(() => {
      rendered.find('motors-airframe-slot-4').props.onPress();
    });
    expect(
      rendered.find('motors-airframe-slot-4').props.accessibilityState.selected,
    ).toBe(true);

    longPress(rendered);
    expect(operator.pulseCalls).toEqual([4]);
    rendered.unmount();
  });

  it('makes no physical-stop, rotation, RPM or temperature claim', () => {
    const rendered = render(
      new FakeOperator(
        snapshotFor({ machine: 'Pulsing', startAcknowledged: true }),
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
    // Armed state, lease, authority, scope and capability are evaluated
    // once, in the controller. The screen reads the verdict. Battery
    // suitability is deliberately manual, not an invented automatic fact.
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

  it('creates no second session or controller and only the two declared gesture timers', () => {
    expect(executable).not.toContain('createMotorTestController');
    expect(executable.match(/setInterval\(/g) ?? []).toHaveLength(1);
    expect(executable.match(/setTimeout\(/g) ?? []).toHaveLength(1);
    expect(executable).toContain('MOTOR_TEST_LONG_PRESS_DELAY_MILLIS');
    expect(executable).toContain('MOTOR_TEST_HOLD_HEARTBEAT_INTERVAL_MILLIS');
    // The one binding it does use resolves the EXISTING capability -
    // R2 moved that lookup into the build-time containment seam.
    expect(executable).toContain('readMotorTestCapability');
  });
});

/* ================================================================== *
 * Pure derivations
 * ================================================================== */

describe('MotorsScreen - pure derivations', () => {
  it('derives NO_SESSION without a machine', () => {
    expect(derivePresentation(undefined)).toBe('NO_SESSION');
    expect(derivePresentation({ ...snapshotFor({}), machine: undefined })).toBe(
      'NO_SESSION',
    );
  });

  it('reads may-be-live from the controller record only', () => {
    expect(commandMayBeLive(undefined)).toBe(false);
    expect(commandMayBeLive(snapshotFor({ mayHaveReachedFc: false }))).toBe(
      false,
    );
    expect(commandMayBeLive(snapshotFor({ mayHaveReachedFc: true }))).toBe(
      true,
    );
  });
});

/* ================================================================== *
 * REPAIR PASS R1 - THE SCREEN LOCKS WITHOUT CONTINUOUS MONITORING
 *
 * NO HARDWARE. The operator double records calls; nothing reaches a
 * transport, client, lease or device.
 * ================================================================== */

describe('an unproven armed state locks the screen', () => {
  /** Exactly what the real production controller publishes when a
   * satisfied observation ages out mid-session: the reducer is still in
   * `Ready`, and activation is refused solely because nothing currently
   * proves the flight controller disarmed. */
  function monitorBlocked(): MotorTestControllerSnapshot {
    return snapshotFor({
      machine: 'Ready',
      allowed: false,
      reasons: ['ARMED_STATE_UNKNOWN_OR_STALE'],
    });
  }

  it('never presents an actionable READY, and disables the control', () => {
    const rendered = render(new FakeOperator(monitorBlocked()));
    // THE INVARIANT: no actionable ready presentation, and nothing an
    // operator can press, whenever the authoritative gate refuses.
    expect(rendered.query('motors-status-READY')).toBeUndefined();
    expect(rendered.find('motors-hold-button').props.disabled).toBe(true);
    rendered.unmount();
  });

  it('separates "re-reading the armed state" from "this session is locked"', () => {
    // An unread armed state ALONE is the post-release re-verification
    // window - mid-cycle, not broken. Anything terminal alongside it is a
    // genuine lock. Both refuse activation; only one needs operator
    // action; conflating them used to make every ordinary release look like
    // a terminal session failure.
    const rendered = render(new FakeOperator(monitorBlocked()));
    expect(rendered.query('motors-status-VERIFYING')).toBeDefined();
    expect(rendered.query('motors-status-LOCKED')).toBeUndefined();
    rendered.unmount();

    const terminal = render(
      new FakeOperator(
        snapshotFor({
          machine: 'Ready',
          allowed: false,
          reasons: ['ARMED_STATE_UNKNOWN_OR_STALE', 'REQUIRES_NEW_CONNECTION'],
        }),
      ),
    );
    expect(terminal.query('motors-status-LOCKED')).toBeDefined();
    expect(terminal.query('motors-status-VERIFYING')).toBeUndefined();
    terminal.unmount();
  });

  it('renders the exact Arabic blocking explanation', () => {
    const rendered = render(new FakeOperator(monitorBlocked()));
    const node = rendered.find('motors-block-ARMED_STATE_UNKNOWN_OR_STALE');
    expect(JSON.stringify(node.props.children)).toContain(
      'تعذّرت قراءة حالة التسليح أو أصبحت القراءة قديمة.',
    );
    expect(texts(rendered)).toContain(
      'تعذّرت قراءة حالة التسليح أو أصبحت القراءة قديمة.',
    );
    rendered.unmount();
  });

  it('keeps the long-press control disabled even with every manual acknowledgement ticked', () => {
    const operator = new FakeOperator(monitorBlocked());
    const rendered = render(operator);
    acknowledgeAll(rendered);

    expect(rendered.find('motors-hold-button').props.disabled).toBe(true);
    // And a long press still cannot reach activation.
    longPress(rendered);
    expect(operator.pulseCalls).toEqual([]);
    rendered.unmount();
  });

  it('does not activate on tap, press-in or plain press either', () => {
    const operator = new FakeOperator(monitorBlocked());
    const rendered = render(operator);
    acknowledgeAll(rendered);
    const hold = rendered.find('motors-hold-button');
    act(() => {
      hold.props.onPressIn?.();
      hold.props.onPress?.();
      hold.props.onPressOut?.();
    });
    expect(operator.pulseCalls).toEqual([]);
    rendered.unmount();
  });

  it('keeps the emergency Stop control available while locked', () => {
    const operator = new FakeOperator(monitorBlocked());
    const rendered = render(operator);
    const stop = rendered.find('motors-stop-button');
    expect(stop.props.disabled).toBeFalsy();
    rendered.press('motors-stop-button');
    expect(operator.stopCalls).toEqual(['STOP_BUTTON_PRESSED']);
    rendered.unmount();
  });

  it('never describes the missing monitor as available, active or monitored', () => {
    const rendered = render(new FakeOperator(monitorBlocked()));
    const rendering = texts(rendered);
    for (const forbidden of [
      'المراقبة متاحة',
      'المراقبة نشطة',
      'مُراقَب',
      'AVAILABLE_ACCEPTED_SOURCE',
    ]) {
      expect(rendering).not.toContain(forbidden);
    }
    rendered.unmount();
  });

  it('derives the presentation from the authoritative gate, not the reducer name', () => {
    // Pure derivation: same reducer state, opposite gate verdict.
    expect(
      derivePresentation(snapshotFor({ machine: 'Ready', allowed: true })),
    ).toBe('READY');
    // Gate closed for the ONE mid-cycle reason: re-verifying.
    expect(derivePresentation(monitorBlocked())).toBe('VERIFYING');
    // Gate closed for anything else, or for more than that one reason:
    // genuinely locked.
    expect(
      derivePresentation(
        snapshotFor({
          machine: 'Ready',
          allowed: false,
          reasons: ['ARMED_STATE_UNKNOWN_OR_STALE', 'FC_ARMED'],
        }),
      ),
    ).toBe('LOCKED');
    expect(
      derivePresentation(
        snapshotFor({
          machine: 'Ready',
          allowed: false,
          reasons: ['FC_ARMED'],
        }),
      ),
    ).toBe('LOCKED');
  });
});

/* ================================================================== *
 * THE FOUR-MOTOR OPERATOR FLOW
 *
 * SCOPE CORRECTION, RECORDED. The operator must be able to test M1, M2,
 * M3 and M4 in any order, repeatedly, inside ONE session. That is a
 * screen-level contract as much as a controller one: a flow that silently
 * makes somebody re-tick three safety checkboxes after every single
 * release is not the feature, whatever the controller does underneath.
 * ================================================================== */

describe('MotorsScreen - the four-motor flow', () => {
  /** The transient window every normal release passes through: the stop
   * is confirmed and the reducer is back in `Ready`, but monitoring has
   * been restarted and its fresh observation has not landed yet, so the
   * authoritative gate is briefly closed. */
  const reverifying = (): MotorTestControllerSnapshot =>
    snapshotFor({
      machine: 'Ready',
      allowed: false,
      mayHaveReachedFc: true,
      stopAcknowledged: true,
      stopOutcome: { kind: 'ACKNOWLEDGED' },
      reasons: ['ARMED_STATE_UNKNOWN_OR_STALE'],
    });

  const readyAgain = (): MotorTestControllerSnapshot =>
    snapshotFor({
      machine: 'Ready',
      allowed: true,
      mayHaveReachedFc: true,
      stopAcknowledged: true,
      stopOutcome: { kind: 'ACKNOWLEDGED' },
    });

  it('returns directly to the reusable hold flow after a normal release', () => {
    const operator = new FakeOperator(snapshotFor({ allowed: true }));
    const rendered = render(operator);
    expect(rendered.find('motors-hold-button').props.disabled).toBe(false);

    act(() => {
      operator.publish(reverifying());
    });
    act(() => {
      operator.publish(readyAgain());
    });

    expect(rendered.find('motors-hold-button').props.disabled).toBe(false);
    rendered.unmount();
  });

  it('does not present a re-verifying session as LOCKED', () => {
    const rendered = render(new FakeOperator(reverifying()));
    // It is not locked - nothing went wrong. It is confirming the flight
    // controller is still disarmed before it will arm the control again.
    expect(rendered.query('motors-status-LOCKED')).toBeUndefined();
    expect(rendered.query('motors-status-VERIFYING')).toBeDefined();
    // ... and the control stays disabled while that is true.
    expect(rendered.find('motors-hold-button').props.disabled).toBe(true);
    rendered.unmount();
  });

  it('keeps a genuinely ended session blocked without adding checkbox state', () => {
    for (const machine of ['Locked', 'Fault'] as const) {
      const operator = new FakeOperator(snapshotFor({ allowed: true }));
      const rendered = render(operator);
      expect(rendered.find('motors-hold-button').props.disabled).toBe(false);

      act(() => {
        operator.publish(snapshotFor({ machine, allowed: false }));
      });
      act(() => {
        operator.publish(snapshotFor({ allowed: true }));
      });
      expect(rendered.find('motors-hold-button').props.disabled).toBe(false);
      rendered.unmount();
    }
  });

  it.each([1, 2, 3, 4])('pulses M%i from the selected card', slot => {
    const operator = new FakeOperator(snapshotFor({ allowed: true }));
    const rendered = render(operator);
    acknowledgeAll(rendered);
    rendered.press(`motors-slot-${slot}`);
    longPress(rendered);
    // The number on the card IS the number handed to the controller.
    expect(operator.pulseCalls).toEqual([slot]);
    rendered.unmount();
  });

  it('sweeps all four in an arbitrary order without repeating setup ceremony', () => {
    const operator = new FakeOperator(snapshotFor({ allowed: true }));
    const rendered = render(operator);
    acknowledgeAll(rendered);

    for (const slot of [3, 1, 4, 2, 3]) {
      rendered.press(`motors-slot-${slot}`);
      longPress(rendered);
      pressOut(rendered);
      // The release round trip the controller really performs.
      act(() => {
        operator.publish(reverifying());
      });
      act(() => {
        operator.publish(readyAgain());
      });
    }

    // Five deliberate presses, five commands, in the order requested,
    // without any checkbox or explicit-start intermission.
    expect(operator.pulseCalls).toEqual([3, 1, 4, 2, 3]);
    expect(rendered.find('motors-hold-button').props.disabled).toBe(false);
    rendered.unmount();
  });
});

/* ================================================================== *
 * DIRECTION REFERENCE - PHYSICAL CLAIMS REMAIN HONEST
 * ================================================================== */

describe('MotorsScreen - direction handling', () => {
  it('puts a reviewed persistent direction tool in the selected-motor workspace', () => {
    const operator = new FakeOperator(snapshotFor({ allowed: true }));
    const rendered = render(operator);
    acknowledgeAll(rendered);
    expect(rendered.query('esc-direction-panel')).toBeDefined();
    expect(rendered.query('esc-direction-review')).toBeDefined();
    expect(rendered.query('esc-direction-apply')).toBeUndefined();
    rendered.unmount();
  });

  it('removes the obsolete unsupported-direction copy', () => {
    const rendered = render(new FakeOperator(snapshotFor({ allowed: true })));
    const rendering = texts(rendered);
    expect(rendering).not.toContain('عكس اتجاه المحرك غير متاح حاليًا');
    expect(rendering).not.toContain('Betaflight');
    rendered.unmount();
  });

  it('never presents the displayed directions as read from the aircraft', () => {
    const rendered = render(new FakeOperator(snapshotFor({ allowed: true })));
    expect(rendered.query('motors-diagram-direction-source')).toBeDefined();
    expect(texts(rendered)).toContain(
      'اتجاهات الدوران المعروضة مرجع شائع لمخطط Quad X وليست قراءة من متحكم الطيران.',
    );
    rendered.unmount();
  });
});

/* ================================================================== *
 * THE FIELD BUG: a held motor stopped on its own
 * ================================================================== */

describe('MotorsScreen - continuous hold survives the activation gate closing', () => {
  /**
   * Reported on real hardware in a browser: "the motor moved briefly and
   * then stopped while the hold was still intended."
   *
   * The mechanism: submitting a pulse makes evaluateActivation() report
   * PULSE_OR_STOP_IN_PROGRESS, so activation.allowed goes false the
   * instant the motor starts. `disabled` was derived from that, and
   * react-native-web terminates the active responder when a Pressable
   * becomes disabled - firing onResponderTerminate -> handlePressOut ->
   * stopNow while the finger was still down.
   */
  it('does not disable the hold control while the gesture it already owns is live', () => {
    const operator = new FakeOperator(snapshotFor({ allowed: true }));
    const rendered = render(operator);
    expect(rendered.find('motors-hold-button').props.disabled).toBe(false);

    longPress(rendered);
    expect(operator.pulseCalls).toEqual([1]);

    // The controller now reports exactly what it reports in production
    // once a pulse is live: activation is no longer allowed.
    act(() => {
      operator.publish(
        snapshotFor({
          machine: 'Pulsing',
          allowed: false,
          reasons: ['PULSE_OR_STOP_IN_PROGRESS'],
        }),
      );
    });

    // THE ASSERTION: still enabled, so the responder is never terminated
    // and no spurious release is delivered.
    expect(rendered.find('motors-hold-button').props.disabled).toBe(false);
    expect(operator.stopCalls).toEqual([]);

    // A real release still stops, through the one stop route.
    pressOut(rendered);
    expect(operator.stopCalls).toEqual(['TOUCH_RELEASED']);
    rendered.unmount();
  });

  it('re-disables the control after the gesture ends while the gate is still closed', () => {
    const operator = new FakeOperator(snapshotFor({ allowed: true }));
    const rendered = render(operator);
    longPress(rendered);
    act(() => {
      operator.publish(
        snapshotFor({
          machine: 'Stopping',
          allowed: false,
          reasons: ['PULSE_OR_STOP_IN_PROGRESS'],
        }),
      );
    });
    pressOut(rendered);
    expect(rendered.find('motors-hold-button').props.disabled).toBe(true);
    rendered.unmount();
  });

  it('still refuses to start a hold the controller bars, because ownership only protects a gesture already accepted', () => {
    const operator = new FakeOperator(
      snapshotFor({
        machine: 'Ready',
        allowed: false,
        reasons: ['REQUIRES_NEW_CONNECTION'],
      }),
    );
    const rendered = render(operator);
    expect(rendered.find('motors-hold-button').props.disabled).toBe(true);
    longPress(rendered);
    expect(operator.pulseCalls).toEqual([]);
    expect(rendered.find('motors-hold-button').props.disabled).toBe(true);
    rendered.unmount();
  });
});

describe('P3 - sticky professional STOP', () => {
  it('is pinned outside the scroll area while the professional session is READY', async () => {
    const operator = new FakeOperator(snapshotFor({ machine: 'Ready' }));
    const {tree: renderer} = render(operator);
    // Enable through the workspace toggle.
    const toggle = renderer.root.findAll(
      node =>
        (node.props as {testID?: string}).testID === 'motor-workspace-enable' &&
        typeof (node.props as {onValueChange?: unknown}).onValueChange ===
          'function',
    )[0];
    await act(async () => {
      (toggle.props as {onValueChange: (v: boolean) => void}).onValueChange(
        true,
      );
    });
    const sticky = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.props as {testID?: string}).testID === 'motors-sticky-stop',
    );
    expect(sticky).toHaveLength(1);
    expect(JSON.stringify(renderer.toJSON())).toContain('إيقاف المحركات');
  });

  it('does NOT appear while motor control is inactive', () => {
    const operator = new FakeOperator(snapshotFor({ machine: 'Ready' }));
    const {tree: renderer} = render(operator);
    expect(
      renderer.root.findAll(
        node =>
          typeof node.type === 'string' &&
          (node.props as {testID?: string}).testID === 'motors-sticky-stop',
      ),
    ).toHaveLength(0);
  });
});

describe('P3 - final page organization', () => {
  it('renders the professional workspace BEFORE the legacy tools bench', () => {
    const rendered = render(new FakeOperator(snapshotFor({ allowed: true })));
    const ids = rendered.tree.root
      .findAll(node => typeof node.props?.testID === 'string')
      .map(node => node.props.testID as string);
    expect(ids.indexOf('motor-workspace')).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf('motor-workspace')).toBeLessThan(
      ids.indexOf('motors-tools-heading'),
    );
    expect(ids.indexOf('motors-tools-heading')).toBeLessThan(
      ids.indexOf('motors-workspace'),
    );
    rendered.unmount();
  });

  it('labels configuration under إعدادات المحركات and tools under التحقق والأدوات', () => {
    const rendered = render(new FakeOperator(snapshotFor({ allowed: true })));
    const body = JSON.stringify(rendered.tree.toJSON());
    expect(body).toContain('إعدادات المحركات');
    expect(body).toContain('التحقق والأدوات');
    rendered.unmount();
  });

  it('shows the propeller warning exactly ONCE, with no acknowledgement ritual', () => {
    const rendered = render(new FakeOperator(snapshotFor({ allowed: true })));
    const body = JSON.stringify(rendered.tree.toJSON());
    // Exact banner sentence once; the tools bench step may mention props
    // in its own instructions without being a second page warning.
    expect(body.split('أزل المراوح قبل اختبار المحركات.').length - 1).toBe(1);
    // The old checklist/acknowledgement block is gone from the page.
    expect(
      rendered.tree.root.findAll(
        node => node.props?.testID === 'motors-acknowledgements',
      ),
    ).toHaveLength(0);
    rendered.unmount();
  });

  it('the pinned dock no longer teaches press-and-hold while idle', () => {
    const rendered = render(new FakeOperator(snapshotFor({ allowed: true })));
    const dock = rendered.find('motors-session-dock');
    expect(
      JSON.stringify(
        dock.findAll(node => node.props?.testID === 'motors-hold-button'),
      ),
    ).toBe('[]');
    rendered.unmount();
  });
});
