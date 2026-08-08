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
    outcome: {kind: 'READY'}, firmwareCompatibility: undefined, motorScope: undefined,
    motorDiagnosticsSupport: undefined, telemetryHeld: true, warnings: [], stopDescriptors: [], teardown: undefined,
    stopExecution: {attempts: 0, commandDispatched: false, commandAcknowledged: false, physicalStopConfirmed: false, deferredBehindActiveWrite: false, attributionAmbiguous: false, attributionResolvedByConfirmation: false, wirePreemptionClaimed: false, submittedNextOnTransport: false, episodeId: 0, outcome: undefined},
    pulse: {attemptId: 1, motorNumber: live ? 1 : undefined, submitted: live, acknowledged: false, deadlineArmedAtSubmission: live, mayHaveReachedFc: live, outcome: undefined},
    activation: {allowed, reasons: allowed ? [] : ['PULSE_OR_STOP_IN_PROGRESS']}, verificationReceipt: undefined,
    armedStateEvidence: allowed ? 'FRESH_DISARMED' : 'UNKNOWN_OR_STALE',
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
    expect(hold.closest('[data-testid="motors-session-dock"]')).not.toBeNull();
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
