/**
 * THE OPERATOR-FACING SESSION CONTRACT (PART Y).
 *
 * Driven through the REAL MotorsScreenView and the REAL session path, not
 * through the pure derivation - the point is that pressing the control the
 * operator actually sees produces the behaviour promised, including the
 * two sentences that matter most:
 *
 *   turning the SESSION on never spins a motor;
 *   turning MOTOR CONTROL off stops one.
 */
import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import '../../i18n';
import {MotorsScreenView} from './MotorsScreen';
import type {MotorTestOperatorPort} from '../../platforms/react-native/protocol';
import type {MotorTestControllerSnapshot} from '../../core/state/motorTestController';

type Phase = MotorTestControllerSnapshot['phase'];

function snapshotFor(over: {
  phase?: Phase;
  outcome?: 'READY' | 'PENDING' | 'FAILED_CLOSED';
  teardownComplete?: boolean;
  motorCount?: number;
}): MotorTestControllerSnapshot {
  const motorCount = over.motorCount ?? 4;
  const kind = over.outcome ?? 'READY';
  const domain = {
    motorCount,
    protocolFamily: 'DSHOT' as const,
    feature3dEnabled: false,
    commandDomainMin: 1000,
    commandDomainMax: 2000,
    domainSource: 'FIRMWARE_CONSTRAIN' as const,
    stopValue: 1000,
    notKnowableFromMsp: [] as readonly string[],
  };
  return {
    phase: over.phase ?? 'ACTIVE',
    setupStep: 'READY',
    machine: {name: 'Ready'},
    outcome:
      kind === 'FAILED_CLOSED'
        ? {kind, reason: 'TEARDOWN_INCOMPLETE', requiresNewSession: true}
        : {kind},
    firmwareCompatibility: undefined,
    motorScope: {motorCount, motorProtocolRaw: 7, feature3dEnabled: false},
    motorDiagnosticsSupport: undefined,
    telemetryHeld: true,
    warnings: [],
    stopDescriptors: [],
    ...(over.teardownComplete === undefined
      ? {teardown: undefined}
      : {teardown: {complete: over.teardownComplete, steps: []}}),
    stopExecution: {attempts: 0},
    pulse: {attemptId: 0},
    activation: {allowed: true, reasons: []},
    verificationReceipt: undefined,
    armedStateEvidence: 'FRESH_DISARMED',
    motorDomain: domain,
    motorRuntimeScope: {eligible: true, domain},
  } as unknown as MotorTestControllerSnapshot;
}

/** Records every facade call so "never spins a motor" can be asserted. */
class Operator implements Partial<MotorTestOperatorPort> {
  snapshot: MotorTestControllerSnapshot;
  beginCalls = 0;
  endCalls = 0;
  readonly stopCalls: string[] = [];
  readonly setMotorCalls: Array<[number, number]> = [];
  readonly setMasterCalls: number[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(snapshot: MotorTestControllerSnapshot) {
    this.snapshot = snapshot;
  }
  beginSession() {
    this.beginCalls += 1;
    return Promise.resolve(this.snapshot);
  }
  endSession() {
    this.endCalls += 1;
    this.publish(snapshotFor({phase: 'CLOSED', teardownComplete: true}));
    return Promise.resolve(this.snapshot);
  }
  getSnapshot() {
    return this.snapshot;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  requestStop(trigger: string) {
    this.stopCalls.push(trigger);
    return 'ACCEPTED' as const;
  }
  stopAll() {
    this.stopCalls.push('STOP_ALL');
    return 'ACCEPTED' as const;
  }
  setMotorValue(index: number, value: number) {
    this.setMotorCalls.push([index, value]);
    return {kind: 'ACCEPTED' as const, coalesced: false};
  }
  setMaster(value: number) {
    this.setMasterCalls.push(value);
    return {kind: 'ACCEPTED' as const, coalesced: false};
  }
  setMotorValues() {
    return {kind: 'ACCEPTED' as const, coalesced: false};
  }
  pulseMotor() {
    return 'ACCEPTED' as const;
  }
  renewPulseHold() {
    return 'NO_ACTIVE_PULSE' as const;
  }
  publish(next: MotorTestControllerSnapshot) {
    this.snapshot = next;
    act(() => {
      for (const listener of [...this.listeners]) listener();
    });
  }
}

function render(operator: Operator | undefined) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(
      <MotorsScreenView operator={operator as never} />,
    );
  });
  /**
   * ONE testID, THREE nodes - and they carry different props.
   *
   * A `ToggleSwitch` forwards its testID to the `Pressable` it renders, so
   * the tree holds the ToggleSwitch composite (value/onValueChange), the
   * Pressable composite (onPress, aria-*) and the host View (the RESOLVED
   * accessibilityState). Reading the first match returns whichever happens
   * to be outermost, which is how an earlier version of this file asserted
   * `undefined` and passed nothing. Each accessor asks for the node that
   * actually owns the prop it needs.
   */
  const all = (testID: string) =>
    tree.root.findAll(node => node.props?.testID === testID);
  const host = (testID: string) =>
    tree.root.findAll(
      node => typeof node.type === 'string' && node.props?.testID === testID,
    )[0];
  return {
    tree,
    query: host,
    find: (testID: string) => {
      const node = host(testID);
      if (node === undefined) throw new Error(`no node with testID "${testID}"`);
      return node;
    },
    /** The RESOLVED accessibility state, from the host element. */
    checked: (testID: string): boolean | undefined =>
      host(testID)?.props?.accessibilityState?.checked as boolean | undefined,
    disabled: (testID: string): boolean | undefined =>
      host(testID)?.props?.accessibilityState?.disabled as boolean | undefined,
    label: (testID: string): string =>
      String(host(testID)?.props?.accessibilityLabel ?? ''),
    press: (testID: string) => {
      const node = all(testID).find(
        candidate => typeof candidate.props?.onPress === 'function',
      );
      if (node === undefined) {
        throw new Error(`no pressable node with testID "${testID}"`);
      }
      act(() => {
        node.props.onPress();
      });
    },
    text: () => JSON.stringify(tree.toJSON()),
  };
}

/** The rendered text of the session state chip. */
/** The rendered tree, which contains the state chip's own text. React
 * ELEMENTS cannot be stringified - their props.children close a cycle - so
 * the serialised output is the thing to search. */
const stateText = (r: ReturnType<typeof render>): string => r.text();

/* ==================================================== 1. STATE TRUTH */
describe('PART Y: the toggle represents REAL persistent session state', () => {
  it('reads OFF for an idle controller and ON for an active one', () => {
    const idle = render(new Operator(snapshotFor({phase: 'IDLE'})));
    expect(idle.checked('motor-session-toggle')).toBe(false);
    const active = render(new Operator(snapshotFor({phase: 'ACTIVE'})));
    expect(active.checked('motor-session-toggle')).toBe(true);
  });

  it('THE REPORTED DEFECT: a session closed elsewhere stops reading ON', () => {
    const operator = new Operator(snapshotFor({phase: 'ACTIVE'}));
    const r = render(operator);
    expect(r.checked('motor-session-toggle')).toBe(true);
    // A tab departure, an app background or a USB drop - the operator
    // touched nothing on this screen.
    operator.publish(snapshotFor({phase: 'CLOSED', teardownComplete: true}));
    expect(r.checked('motor-session-toggle')).toBe(false);
    expect(stateText(r)).toContain('متوقفة');
  });

  it('an incomplete teardown looks like NEITHER on nor a proven off', () => {
    const operator = new Operator(snapshotFor({phase: 'ACTIVE'}));
    const r = render(operator);
    operator.publish(snapshotFor({phase: 'CLOSED', teardownComplete: false}));
    expect(r.checked('motor-session-toggle')).toBe(false);
    // ...and it says so, in text, not only in a colour.
    expect(stateText(r)).toContain('غير مؤكدة');
    expect(r.query('motor-session-error-detail')).toBeDefined();
  });

  it('announces its state to a screen reader, not just its name', () => {
    const r = render(new Operator(snapshotFor({phase: 'ACTIVE'})));
    const label = r.label('motor-session-toggle');
    expect(label).toContain('جلسة المحركات');
    expect(label).toContain('مفتوحة');
  });

  it('refuses a new instruction while a transition owns the session', () => {
    const r = render(new Operator(snapshotFor({phase: 'CLOSING'})));
    expect(r.disabled('motor-session-toggle')).toBe(true);
  });
});

/* ============================================= 2. OPEN / CLOSE PATHS */
describe('PART Y: opening and closing go through the ONE canonical path', () => {
  it('OFF -> ON opens exactly one session', () => {
    const operator = new Operator(snapshotFor({phase: 'IDLE'}));
    const r = render(operator);
    r.press('motor-session-toggle');
    expect(operator.beginCalls).toBe(1);
  });

  it('repeated ON does not open a second session', () => {
    const operator = new Operator(snapshotFor({phase: 'IDLE'}));
    const r = render(operator);
    r.press('motor-session-toggle');
    operator.publish(snapshotFor({phase: 'ACTIVE'}));
    r.press('motor-session-toggle');
    r.press('motor-session-toggle');
    expect(operator.beginCalls).toBe(1);
  });

  it('turning the SESSION on never commands a motor', () => {
    const operator = new Operator(snapshotFor({phase: 'IDLE'}));
    const r = render(operator);
    r.press('motor-session-toggle');
    operator.publish(snapshotFor({phase: 'ACTIVE'}));
    expect(operator.setMotorCalls).toEqual([]);
    expect(operator.setMasterCalls).toEqual([]);
  });

  it('ON -> OFF requests STOP before it ever asks to end the session', () => {
    const operator = new Operator(snapshotFor({phase: 'ACTIVE'}));
    const r = render(operator);
    r.press('motor-session-toggle');
    // endMotorTestSessionSafely's contract: stop first, settle, then close.
    expect(operator.stopCalls.length).toBeGreaterThan(0);
    expect(operator.stopCalls[0]).toBe('STOP_BUTTON_PRESSED');
  });

  it('a double OFF is safe and does not fan out into two teardowns', () => {
    const operator = new Operator(snapshotFor({phase: 'ACTIVE'}));
    const r = render(operator);
    r.press('motor-session-toggle');
    r.press('motor-session-toggle');
    expect(operator.endCalls).toBeLessThanOrEqual(1);
  });

  it('an idle session has nothing to close, and tries nothing', () => {
    const operator = new Operator(snapshotFor({phase: 'IDLE'}));
    const r = render(operator);
    // Already OFF: pressing turns it ON, so drive the OFF path directly by
    // publishing IDLE again after an open attempt.
    r.press('motor-session-toggle');
    operator.publish(snapshotFor({phase: 'IDLE'}));
    const before = operator.endCalls;
    r.press('motor-session-toggle');
    expect(operator.endCalls).toBe(before);
  });
});

/* =========================================== 3. THE SECOND AUTHORITY */
describe('PART Y: motor control is separate from the session', () => {
  it('is not operational without a session', () => {
    const r = render(new Operator(snapshotFor({phase: 'IDLE'})));
    expect(r.disabled('motor-workspace-enable')).toBe(true);
    expect(r.text()).toContain('افتح جلسة المحركات أولًا');
  });

  it('turning motor control ON never implies a value above stop', () => {
    const operator = new Operator(snapshotFor({phase: 'ACTIVE'}));
    const r = render(operator);
    r.press('motor-workspace-enable');
    expect(operator.setMotorCalls).toEqual([]);
    expect(operator.setMasterCalls).toEqual([]);
  });

  it('turning motor control OFF stops - authority is never withdrawn silently', () => {
    const operator = new Operator(snapshotFor({phase: 'ACTIVE'}));
    const r = render(operator);
    r.press('motor-workspace-enable');
    const before = operator.stopCalls.length;
    r.press('motor-workspace-enable');
    expect(operator.stopCalls.length).toBeGreaterThan(before);
  });

  it('a session that ends elsewhere withdraws motor control with it', () => {
    const operator = new Operator(snapshotFor({phase: 'ACTIVE'}));
    const r = render(operator);
    r.press('motor-workspace-enable');
    expect(r.checked('motor-workspace-enable')).toBe(true);
    operator.publish(snapshotFor({phase: 'CLOSED', teardownComplete: true}));
    expect(r.checked('motor-workspace-enable')).toBe(false);
  });

  it('shows both authorities, separately, in the required order', () => {
    const r = render(new Operator(snapshotFor({phase: 'ACTIVE'})));
    const ids = r.tree.root
      .findAll(node => typeof node.props?.testID === 'string')
      .map(node => node.props.testID as string);
    expect(ids.indexOf('motor-session-row')).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf('motor-session-row')).toBeLessThan(
      ids.indexOf('motor-workspace-enable'),
    );
  });
});

/* ============================================ 4. NOTHING BOUND YET */
describe('PART Y: an unbound screen says UNKNOWN, not OFF', () => {
  it('distinguishes "no session" from "cannot see one"', () => {
    const r = render(undefined);
    expect(stateText(r)).toContain('غير معروفة');
    expect(r.query('motor-session-unknown-detail')).toBeDefined();
    expect(r.checked('motor-session-toggle')).toBe(false);
  });
});

/* ================================================ 5. ACCESSIBILITY */
describe('PART AE: everything states itself, without relying on colour', () => {
  it('every motor announces its M-number AND its current value', () => {
    const r = render(new Operator(snapshotFor({phase: 'ACTIVE', motorCount: 4})));
    for (const slot of [1, 2, 3, 4]) {
      const track = r.tree.root
        .findAll(
          node =>
            typeof node.type === 'string' &&
            node.props?.accessibilityRole === 'adjustable' &&
            String(node.props?.accessibilityLabel ?? '').includes(`M${slot}`),
        )[0];
      expect(track).toBeDefined();
      // A number a screen reader can read, not just a slider it can find.
      expect(track.props.accessibilityValue).toMatchObject({
        min: 1000,
        max: 2000,
        now: 1000,
      });
    }
  });

  it('the master control announces itself distinctly from a motor', () => {
    const r = render(new Operator(snapshotFor({phase: 'ACTIVE'})));
    expect(r.text()).toContain('الكل — جميع المحركات');
  });

  it('every session state carries TEXT, so greyscale loses nothing', () => {
    for (const [phase, word] of [
      ['IDLE', 'متوقفة'],
      ['ACTIVE', 'مفتوحة'],
      ['CLOSING', 'جارٍ الإغلاق'],
    ] as const) {
      const r = render(new Operator(snapshotFor({phase})));
      expect(stateText(r)).toContain(word);
    }
  });

  it('STOP is reachable and labelled whenever the screen is rendered', () => {
    const r = render(new Operator(snapshotFor({phase: 'ACTIVE'})));
    expect(r.label('motor-workspace-stop')).toContain('إيقاف المحركات');
  });
});

/* ====================================== 6. THE LEGACY CONTROLS ARE GONE */
/**
 * FINAL CLOSURE. The Hardware/UX pass left the two old rectangles in place
 * as secondary entry points into the single session path. That was the
 * wrong call: the operator's original complaint was precisely that session
 * lifecycle was represented by large, remote rectangular actions with no
 * obvious way to end the session later. Keeping them preserved exactly the
 * confusion the toggle exists to remove.
 *
 * These assertions pin the removal, and pin that removing them did not
 * quietly remove the behaviour they used to exercise.
 */
describe('FINAL: exactly ONE user-facing session lifecycle control', () => {
  const legacyIds = ['motors-begin-session-button', 'motors-end-session-button'];

  it.each(legacyIds)('%s no longer exists anywhere in the Motors UI', testID => {
    for (const phase of ['IDLE', 'ACTIVE', 'CLOSING', 'CLOSED'] as const) {
      const r = render(new Operator(snapshotFor({phase})));
      expect(
        r.tree.root.findAll(node => node.props?.testID === testID),
      ).toHaveLength(0);
    }
    // ...and not for an unbound screen either.
    const unbound = render(undefined);
    expect(
      unbound.tree.root.findAll(node => node.props?.testID === testID),
    ).toHaveLength(0);
  });

  it('the removed rectangles are not reachable through the accessibility tree', () => {
    const r = render(new Operator(snapshotFor({phase: 'ACTIVE'})));
    // A button role is how a rectangle presents. None of them may carry
    // the removed labels, under any testID or none.
    const labels = r.tree.root
      .findAll(
        node =>
          typeof node.type === 'string' &&
          node.props?.accessibilityRole === 'button',
      )
      .map(node => String(node.props?.accessibilityLabel ?? ''));
    const body = r.text();
    for (const gone of ['بدء جلسة اختبار المحركات', 'إنهاء جلسة الاختبار']) {
      expect(labels.some(label => label.includes(gone))).toBe(false);
      expect(body).not.toContain(gone);
    }
  });

  it('exactly ONE switch owns session lifecycle', () => {
    const r = render(new Operator(snapshotFor({phase: 'ACTIVE'})));
    const switches = r.tree.root.findAll(
      node =>
        typeof node.type === 'string' &&
        node.props?.accessibilityRole === 'switch',
    );
    const ids = switches.map(node => String(node.props?.testID ?? ''));
    // Two switches on the screen, and they are the two DIFFERENT
    // authorities - never two controls for the same one.
    expect(ids.sort()).toEqual(['motor-session-toggle', 'motor-workspace-enable']);
    expect(ids.filter(id => id === 'motor-session-toggle')).toHaveLength(1);
  });

  it('the session switch still reaches the real begin path', () => {
    const operator = new Operator(snapshotFor({phase: 'IDLE'}));
    const r = render(operator);
    r.press('motor-session-toggle');
    expect(operator.beginCalls).toBe(1);
  });

  it('the session switch still reaches the canonical safe shutdown', () => {
    const operator = new Operator(snapshotFor({phase: 'ACTIVE'}));
    const r = render(operator);
    r.press('motor-session-toggle');
    // STOP first, then the teardown - unchanged from the rectangle's path,
    // because it is literally the same function.
    expect(operator.stopCalls[0]).toBe('STOP_BUTTON_PRESSED');
    expect(operator.endCalls).toBeGreaterThan(0);
  });

  it('motor control cannot stand in for session lifecycle', () => {
    const operator = new Operator(snapshotFor({phase: 'IDLE'}));
    const r = render(operator);
    // No session: the control switch is inert and opens nothing.
    r.press('motor-workspace-enable');
    expect(operator.beginCalls).toBe(0);
    expect(r.checked('motor-workspace-enable')).toBe(false);
  });

  it('STOP is still pinned, and is NOT a lifecycle control', () => {
    const operator = new Operator(snapshotFor({phase: 'ACTIVE'}));
    const r = render(operator);
    expect(r.query('motors-stop-button')).toBeDefined();
    const before = operator.endCalls;
    r.press('motors-stop-button');
    // Stopping must never close the session out from under the operator.
    expect(operator.endCalls).toBe(before);
    expect(operator.stopCalls.length).toBeGreaterThan(0);
  });
});
