/** @jest-environment jsdom */
jest.mock('react-native', () => jest.requireActual('react-native-web'));

import React, {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import '../../i18n';
import {MotorsScreenView} from './MotorsScreen';
import type {MotorTestControllerSnapshot} from '../../core/state/motorTestController';
import type {MotorTestOperatorPort} from '../../platforms/react-native/protocol';

function snapshot(machine: 'Ready' | 'Pulsing', allowed: boolean, live = false): MotorTestControllerSnapshot {
  return {
    phase: 'ACTIVE', setupStep: 'READY',
    machine: machine === 'Ready' ? ({name: 'Ready', authority: {}} as never) : ({name: 'Pulsing', authority: {}, pulseDeadlineArmed: true, startAcknowledged: false} as never),
    outcome: {kind: 'READY'}, firmwareCompatibility: undefined,
    // M-D: a real quad, stated. It used to carry no count and lean on the
    // screen's four-slot placeholder, which no longer exists.
    motorScope: {motorCount: 4, motorProtocolRaw: 6, feature3dEnabled: false},
    mixerModeRaw: 3,
    motorDiagnosticsSupport: undefined, telemetryHeld: true, warnings: [], stopDescriptors: [], teardown: undefined,
    outputMayBeLive: false,
    stopExecution: {attempts: 0, commandDispatched: false, commandAcknowledged: false, physicalStopConfirmed: false, deferredBehindActiveWrite: false, attributionAmbiguous: false, attributionResolvedByConfirmation: false, wirePreemptionClaimed: false, submittedNextOnTransport: false, episodeId: 0, outcome: undefined},
    pulse: {attemptId: 1, motorNumber: live ? 1 : undefined, submitted: live, acknowledged: false, deadlineArmedAtSubmission: live, mayHaveReachedFc: live, outcome: undefined},
    activation: {allowed, reasons: allowed ? [] : ['PULSE_OR_STOP_IN_PROGRESS']}, verificationReceipt: undefined,
    armedStateEvidence: allowed ? 'FRESH_DISARMED' : 'UNKNOWN_OR_STALE',
    motorDomain: undefined,
    motorRuntimeScope: undefined,
  } as MotorTestControllerSnapshot;
}

class WebOperator implements MotorTestOperatorPort {
  current = snapshot('Ready', true);
  pulseCalls = 0;
  stopCalls: string[] = [];
  listeners = new Set<() => void>();
  beginSession = async () => this.current;
  getSnapshot = () => this.current;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  pulseMotor = () => { this.pulseCalls += 1; this.current = snapshot('Pulsing', false, true); for (const listener of [...this.listeners]) listener(); return 'ACCEPTED' as const; };
  renewPulseHold = () => 'RENEWED' as const;
  setEscDirection = async () => ({kind: 'REJECTED'} as never);
  refreshDiagnostics = async () => this.current.diagnostics!;
  requestStop = (trigger: string) => { this.stopCalls.push(trigger); return 'ACCEPTED' as const; };
  endSession = async () => this.current;
  // P3 facade stubs.
  setMotorValues = () =>
    ({kind: 'REFUSED', reason: 'NOT_COMMANDABLE'}) as const;
  setMotorValue = () =>
    ({kind: 'REFUSED', reason: 'NOT_COMMANDABLE'}) as const;
  setMaster = () => ({kind: 'REFUSED', reason: 'NOT_COMMANDABLE'}) as const;
  stopAll = () => 'ACCEPTED' as const;
}

describe('MotorsScreen real react-native-web hold responder', () => {
  let host: HTMLDivElement; let root: Root; let operator: WebOperator;
  beforeEach(() => {
    jest.useFakeTimers(); host = document.createElement('div'); document.body.appendChild(host);
    root = createRoot(host); operator = new WebOperator();
    act(() => { root.render(<MotorsScreenView operator={operator} />); });
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); jest.useRealTimers(); });

  it('fires after the real delay and keeps ownership when the gate closes', () => {
    const hold = host.querySelector('[data-testid="motors-hold-button"]')!;
    // P3: the hold control moved out of the pinned dock into the tools
    // bench - the responder contract below is unchanged.
    expect(hold.closest('[data-testid="motors-session-dock"]')).toBeNull();
    act(() => { hold.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, buttons: 1})); jest.advanceTimersByTime(799); });
    expect(operator.pulseCalls).toBe(0);
    act(() => jest.advanceTimersByTime(101));
    expect(operator.pulseCalls).toBe(1);
    expect(operator.stopCalls).toEqual([]);
    act(() => { hold.dispatchEvent(new MouseEvent('mouseup', {bubbles: true})); });
    expect(operator.stopCalls).toEqual(['TOUCH_RELEASED']);
  });

  it('cancels the web-owned timer when the operator releases early', () => {
    const hold = host.querySelector('[data-testid="motors-hold-button"]')!;
    act(() => {
      hold.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, buttons: 1}));
      jest.advanceTimersByTime(600);
      hold.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
      jest.advanceTimersByTime(1000);
    });
    expect(operator.pulseCalls).toBe(0);
    expect(operator.stopCalls).toEqual([]);
  });

  it('routes browser blur through the release stop path', () => {
    const hold = host.querySelector('[data-testid="motors-hold-button"]')!;
    act(() => { hold.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, buttons: 1})); jest.advanceTimersByTime(900); });
    act(() => window.dispatchEvent(new Event('blur')));
    expect(operator.stopCalls).toEqual(['TOUCH_RELEASED']);
  });
});

/**
 * PART AD - THE SAME MOTORS SCREEN IN A BROWSER.
 *
 * There is no separate Web implementation and none is created here: this
 * renders the SAME MotorsScreenView through real react-native-web, which
 * is the only way to catch the class of defect that has bitten this repo
 * twice - a React Native style property the web renderer silently drops
 * (`direction` on a View), which no assertion against the style OBJECT can
 * see because the object is perfectly well-formed.
 */
describe('PART AD: Motors web parity', () => {
  let host: HTMLDivElement;
  let root: Root;
  let operator: WebOperator;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    operator = new WebOperator();
    act(() => {
      root.render(<MotorsScreenView operator={operator} />);
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const q = (testID: string) => host.querySelector(`[data-testid="${testID}"]`);

  it('renders BOTH authorities, as two separate switches', () => {
    const session = q('motor-session-toggle');
    const control = q('motor-workspace-enable');
    expect(session).not.toBeNull();
    expect(control).not.toBeNull();
    expect(session).not.toBe(control);
    expect(session!.getAttribute('role')).toBe('switch');
    expect(control!.getAttribute('role')).toBe('switch');
  });

  it('announces each switch state in the browser accessibility tree', () => {
    // aria-checked specifically: react-native-web renders
    // accessibilityState.checked as NOTHING, which is why ToggleSwitch
    // sets both channels. A regression here is silent on native.
    expect(q('motor-session-toggle')!.getAttribute('aria-checked')).toBe('true');
    expect(q('motor-workspace-enable')!.getAttribute('aria-checked')).toBe('false');
  });

  it('prints M1..M4 in the browser build', () => {
    const text = host.textContent ?? '';
    for (const slot of [1, 2, 3, 4]) {
      expect(text).toContain(`M${slot}`);
    }
  });

  it('does NOT mirror the physical airframe under RTL', () => {
    // M-E: the drawing places each motor by absolute offset rather than by
    // document order in a flex row, which makes this stronger than it was.
    // `left` is a PHYSICAL CSS offset - it is measured from the left edge
    // of the box under `direction: rtl` exactly as it is under ltr - so
    // comparing the two offsets asks the real question: on a QUADX, does
    // the front-right motor (M2) sit to the right of the front-left one
    // (M4) in an Arabic interface?
    // The offsets below hold whichever direction the host reports, which
    // is the point: the aircraft is not a function of the writing system.
    const frontRight = q('motors-airframe-slot-2');
    const frontLeft = q('motors-airframe-slot-4');
    expect(frontRight).not.toBeNull();
    expect(frontLeft).not.toBeNull();
    const offset = (element: Element): number =>
      Number.parseFloat((element as HTMLElement).style.left);
    expect(Number.isFinite(offset(frontRight!))).toBe(true);
    expect(Number.isFinite(offset(frontLeft!))).toBe(true);
    expect(offset(frontRight!)).toBeGreaterThan(offset(frontLeft!));
    // ...and the rear pair keeps the same handedness, so the aircraft has
    // not simply been rotated.
    expect(offset(q('motors-airframe-slot-1')!)).toBeGreaterThan(
      offset(q('motors-airframe-slot-3')!),
    );
  });

  /** Was "exactly one per motor" - correct while a CW/CCW/؟ token was
   *  printed, and now stronger: an authored layout carries no direction,
   *  so the browser build shows no rotation glyph at all. The motor node
   *  itself is still asserted present, so this cannot pass on an empty
   *  diagram. */
  it('shows NO rotation indicator per motor, and still shows the motor', () => {
    for (const slot of [1, 2, 3, 4]) {
      expect(
        host.querySelectorAll(`[data-testid="motors-diagram-slot-${slot}"]`),
      ).toHaveLength(1);
      expect(
        host.querySelectorAll(`[data-testid="motors-diagram-direction-${slot}"]`),
      ).toHaveLength(0);
    }
  });

  it('keeps STOP reachable in the browser', () => {
    expect(q('motor-workspace-stop')).not.toBeNull();
    expect(q('motors-stop-button')).not.toBeNull();
  });

  it('leaks no raw motor MSP authority into the browser bundle path', () => {
    const html = host.innerHTML;
    for (const token of ['MSP_SET_MOTOR', 'MSP2_SET_MOTOR_OUTPUT_REORDERING']) {
      expect(html).not.toContain(token);
    }
  });
});
