/**
 * THE COMPACTION, PINNED SO IT CANNOT INFLATE BACK.
 *
 * WHAT THE SCREEN LOOKED LIKE BEFORE THIS ROUND, measured in Chromium at
 * 390 with M2 addressed and a receipt outstanding: an identification
 * block 1,956px tall containing TWO airframe drawings, six labelled fact
 * rows, and a verification form that opened with a title, a gold warning,
 * a bordered evidence box, an expected-configuration line, a details
 * link, and then a bordered stage box holding a heading and the question
 * - five framed objects deep before the first thing to tap.
 *
 * Every fact is still on screen. What these tests pin is that it is
 * stated ONCE, in ONE surface, at a nesting depth a person can read.
 *
 * WHAT THEY DELIBERATELY DO NOT PIN: pixels. Heights belong to the
 * geometry sweep, which reruns per width. Structure is what a future edit
 * actually breaks.
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
import {MotorsScreenView} from './MotorsScreen';

const AUTHORITY = {sessionId: 'compaction', generation: 1} as const;
const SESSION_TOKEN = {};

const RECEIPT_M2: MotorTestVerificationReceipt = Object.freeze({
  sessionToken: SESSION_TOKEN,
  attemptId: 4,
  motorNumber: 2,
  stopEpisodeId: 1,
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
  private readonly listeners = new Set<() => void>();
  constructor(private readonly value: MotorTestControllerSnapshot = snapshot()) {}
  getSnapshot() {
    return this.value;
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
  pulseMotor() {
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
  ids(): readonly string[];
  has(testID: string): boolean;
  count(testID: string): number;
  node(testID: string): ReactTestRenderer.ReactTestInstance | undefined;
  press(testID: string): void;
  text(): string;
  unmount(): void;
}

function render(port: Port, sessionId: string | undefined = 'fc-1'): Rendered {
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
  const walk = (node: unknown, out: string[]): void => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(child => walk(child, out));
      return;
    }
    if (node !== null && typeof node === 'object') {
      walk((node as {children?: unknown}).children, out);
      walk((node as {props?: {children?: unknown}}).props?.children, out);
    }
  };
  return {
    tree,
    ids: collect,
    has: (testID: string) => collect().includes(testID),
    count: (testID: string) =>
      tree.root.findAll(
        node =>
          typeof node.type === 'string' && node.props?.testID === testID,
      ).length,
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
    text: () => {
      const out: string[] = [];
      walk(tree.toJSON(), out);
      return out.join(' ');
    },
    unmount: () => act(() => tree.unmount()),
  };
}

/** How many times does `needle` occur in the rendered text? */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/* ================================================================== *
 * ONE CONTEXT, STATED ONCE
 * ================================================================== */

describe('the identification workflow states its context once', () => {
  let r: Rendered;
  beforeEach(() => {
    r = render(new Port(snapshot({verificationReceipt: RECEIPT_M2})));
  });
  afterEach(() => r.unmount());

  it('draws exactly ONE airframe for the whole workflow', () => {
    expect(
      r.tree.root.findAll(
        n =>
          typeof n.type === 'string' &&
          n.props?.testID === 'motors-airframe-diagram',
      ),
    ).toHaveLength(1);
    expect(r.has('motor-verification-mini-diagram')).toBe(false);
  });

  it('states the observation claim once, not once per step', () => {
    // "the position and direction are YOUR observation, not a measurement
    // from the controller" is the claim the whole panel rests on. Said at
    // every stage it stops being read at any of them.
    const claim = ar.motorVerification.truthObservation;
    expect(occurrences(r.text(), claim)).toBe(1);
    r.press('verification-position-FRONT_LEFT');
    expect(occurrences(r.text(), claim)).toBe(1);
  });

  it('keeps expected and confirmed semantically distinct, on two lines', () => {
    // COMPACT IS NOT MERGED. Line one is the template and says so; line
    // two is the observation and says so. Neither borrows from the other.
    r.press('motor-identity-M2');
    expect(r.node('motor-identity-expected')?.props.children).toBe(
      ar.motorVerification.position.FRONT_RIGHT,
    );
    expect(r.node('motor-identity-expected-direction')?.props.children).toBe(
      ar.motorVerification.direction.CW,
    );
    expect(r.node('motor-identity-confirmed')?.props.children).toBe('—');
    expect(r.node('motor-identity-confirmed-direction')?.props.children).toBe(
      '—',
    );
    const badgeText = (id: string) =>
      r.node(id)?.findAll(n => typeof n.props?.children === 'string')[0]?.props
        .children;
    expect(badgeText('motor-identity-expected-direction-badge')).toBe(
      ar.motorsScreen.truthExpected,
    );
    expect(badgeText('motor-identity-confirmed-badge')).toBe(
      ar.motorsScreen.truthUnconfirmed,
    );
  });

  it('reaches the position choices without a nested frame per step', () => {
    // The question is a direct child of the questions block, which is a
    // direct child of the panel. No stage card, no evidence card, no card
    // inside a card.
    const questions = r.node('verification-questions');
    expect(questions).toBeDefined();
    expect(
      questions?.findAll(n => n.props?.testID === 'verification-stage-position'),
    ).not.toHaveLength(0);
    for (const value of [
      'FRONT_LEFT',
      'FRONT_RIGHT',
      'REAR_LEFT',
      'REAR_RIGHT',
    ]) {
      expect(r.has(`verification-position-${value}`)).toBe(true);
    }
  });

  it('follows position with direction, and repeats no context to do it', () => {
    r.press('verification-position-FRONT_LEFT');
    expect(r.has('verification-stage-direction')).toBe(true);
    expect(r.has('verification-stage-position')).toBe(false);
    // The step counter moved on, and there is exactly one of it.
    expect(r.node('verification-stage')?.props.children).toBe(
      ar.motorVerification.stageDirection,
    );
    expect(r.count('verification-stage')).toBe(1);
    // The panel title is still the only place the motor is named inside
    // the form, and it still names it.
    expect(r.node('verification-title')?.props.children).toContain('M2');
  });
});

/* ================================================================== *
 * COMPACT STATES, NOT COMPACT TRUTH
 * ================================================================== */

describe('the quiet states use quiet presentation', () => {
  it('shows READY as a status strip, not an announcement card', () => {
    const r = render(new Port());
    const ready = r.node('motors-session-ready');
    expect(ready).toBeDefined();
    // One line: the state and the addressed motor. The full sentence is
    // still spoken to assistive technology.
    expect(ready?.props.accessibilityLabel).toContain(
      ar.motorsScreen.readyHeading,
    );
    expect(ready?.props.accessibilityLabel).toContain('M1');
    expect(r.text()).toContain(ar.motorsScreen.readyHeading);
    r.unmount();
  });

  it('keeps the long press at 800 ms and a real touch target', () => {
    const r = render(new Port());
    const hold = r.node('motors-hold-button');
    expect(hold?.props.delayLongPress).toBe(800);
    const flatten = (style: unknown): Record<string, unknown> =>
      Array.isArray(style)
        ? Object.assign({}, ...style.filter(Boolean).map(flatten))
        : ((style ?? {}) as Record<string, unknown>);
    const style = flatten(hold?.props.style);
    expect(style.height as number).toBeGreaterThanOrEqual(44);
    expect(style.minHeight as number).toBeGreaterThanOrEqual(44);
    expect(style.minWidth as number).toBeGreaterThanOrEqual(44);
    r.unmount();
  });

  it('surrounds the hold control with one instruction and one consequence', () => {
    const r = render(new Port());
    // What it does on release is a safety statement and stays visible.
    expect(r.text()).toContain(ar.motorsScreen.holdHint);
    // And the step it belongs to is named once, not twice.
    expect(occurrences(r.text(), ar.motorsScreen.identifyHeading)).toBe(1);
    r.unmount();
  });
});

/* ================================================================== *
 * ESC TELEMETRY - COMPACT BOTH WAYS
 * ================================================================== */

describe('ESC telemetry compaction never invents or repeats', () => {
  const noSource = () =>
    snapshot({
      motorDiagnosticsSupport: {
        motorCount: 4,
        dshotTelemetryEnabled: false,
        escSensorEnabled: false,
        escTelemetrySource: 'NONE',
      },
    } as Partial<MotorTestControllerSnapshot>);

  it('renders no per-motor rows and no meters when there is no source', () => {
    const r = render(new Port(noSource()));
    for (const slot of [1, 2, 3, 4]) {
      expect(r.has(`esc-telemetry-${slot}`)).toBe(false);
    }
    expect(r.has('esc-telemetry-empty')).toBe(true);
    r.unmount();
  });

  it('explains the missing source once, in one short line', () => {
    const r = render(new Port(noSource()));
    const text = r.text();
    // The proven fact, and what to turn on. Not two paragraphs saying it
    // twice, and not the "appears only when supported" caption on top.
    expect(text).toContain(ar.motorDiagnostics.source.NONE);
    expect(text).toContain(ar.motorDiagnostics.enableEscTelemetry);
    expect(text).not.toContain(ar.motorDiagnostics.escDetail);
    expect(occurrences(text, ar.motorDiagnostics.enableEscTelemetry)).toBe(1);
    r.unmount();
  });

  it('still maps a live reading to the motor it came from', () => {
    // The compaction changed the SHAPE of the row, never which entry
    // feeds it: entry i renders as M(i+1) and no other.
    const {
      visibleMotorTelemetryMetrics,
    } = require('../../core/state/motorDiagnosticsSemantics');
    const support = {
      motorCount: 4,
      dshotTelemetryEnabled: true,
      escSensorEnabled: false,
      escTelemetrySource: 'BIDIRECTIONAL_DSHOT',
    };
    const entries = [1_234, 2_789, 4_111, 5_678].map((rpm, index) => ({
      rpm,
      invalidPercentRaw: 0,
      temperatureCelsius: [31, 42, 53, 64][index],
      voltageCentivolts: 0,
      currentCentiamps: 0,
      consumptionMah: 0,
    }));
    expect(
      entries.map(e => visibleMotorTelemetryMetrics(e, support).rpm),
    ).toEqual([1_234, 2_789, 4_111, 5_678]);
    expect(
      entries.map(
        e => visibleMotorTelemetryMetrics(e, support).temperatureCelsius,
      ),
    ).toEqual([31, 42, 53, 64]);
  });
});
