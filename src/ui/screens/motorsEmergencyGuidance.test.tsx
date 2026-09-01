/**
 * FINAL-REVIEW CLOSURE: M-1 AND M-2.
 *
 * M-1. THE LiPo INSTRUCTION MUST SURVIVE ANY SCROLL POSITION. The
 * integrated review measured the emergency banner at ~3100px deep on a
 * 360px phone - below the identity, direction and mapping sections that
 * P1b inserted above it - while the only pinned cues were STOP and the
 * red live strip, neither of which says "disconnect the battery". Two
 * changes close it: the detailed banner renders directly under the status
 * card, first in the content flow; and the SAME sentence is pinned inside
 * the session dock beside STOP, outside the scroller entirely.
 *
 * THE PREDICATE IS DELIBERATELY UNCHANGED: `stopIsGenuinelyUnconfirmed` -
 * a command may be live and no acknowledged, attributable stop exists.
 * An ordinary fault (session died, nothing possibly spinning) keeps its
 * calmer notice and must never gain the battery instruction, because
 * telling operators to pull a LiPo for routine faults teaches them to
 * ignore the one time it matters.
 *
 * M-2. ONE IDENTIFICATION MODEL. The legacy bench card carried a
 * hardcoded X-of-4 observation badge that contradicted the identity
 * summary on non-quad aircraft ("0 of 4" beside "not available for this
 * layout") and copy directing the operator to the strip, the diagram and
 * the turquoise hold - all controls that moved into the identity section
 * in P1b-B. The badge and the tutorial are gone; the card now describes
 * only what it still contains.
 *
 * NOT HARDWARE EVIDENCE. Nothing here reaches MSP or spins a motor.
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import '../../i18n';
import i18n from '../../i18n';
import ar from '../../i18n/locales/ar.json';
import type {MotorTestControllerSnapshot} from '../../core/state/motorTestController';
import type {MotorTestOperatorPort} from '../../platforms/react-native/protocol';
import {openMotorsDirectionTool, openMotorsReorderTool, openMotorsTechnicalDetails} from './__testUtils__/motorsTechnicalDetails';

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await i18n.init();
  }
});

/* ================================================================== *
 * Harness
 * ================================================================== */

function snapshotFor(options: {
  readonly motorCount?: number;
  readonly fault?: 'NONE' | 'PLAIN' | 'STOP_UNCONFIRMED';
}): MotorTestControllerSnapshot {
  const motorCount = options.motorCount ?? 4;
  const fault = options.fault ?? 'NONE';
  const faulted = fault !== 'NONE';
  return {
    phase: faulted ? 'FAULTED' : 'ACTIVE',
    setupStep: 'READY',
    machine: faulted
      ? {name: 'Fault', startAcknowledged: false}
      : {name: 'Ready', startAcknowledged: false},
    outcome: faulted ? {kind: 'FAILED_CLOSED'} : {kind: 'READY'},
    firmwareCompatibility: undefined,
    motorScope: {motorCount, motorProtocolRaw: 7, feature3dEnabled: false},
    motorDiagnosticsSupport: {
      motorCount,
      dshotTelemetryEnabled: true,
      escSensorEnabled: false,
      escTelemetrySource: 'BIDIRECTIONAL_DSHOT',
    },
    armedStateEvidence: faulted ? 'UNKNOWN_OR_STALE' : 'FRESH_DISARMED',
    motorDomain: undefined,
    motorRuntimeScope: undefined,
    telemetryHeld: true,
    activation: {
      allowed: !faulted,
      reasons: faulted ? ['ARMED_STATE_UNKNOWN_OR_STALE'] : [],
    },
    // THE M-1 PREDICATE INPUT: commandMayBeLive() reads
    // pulse.mayHaveReachedFc, and with no acknowledged attributable stop
    // below, stopIsGenuinelyUnconfirmed() is true exactly for
    // STOP_UNCONFIRMED and false for a PLAIN fault.
    pulse: {
      motorNumber: fault === 'STOP_UNCONFIRMED' ? 1 : undefined,
      mayBeLive: fault === 'STOP_UNCONFIRMED',
      mayHaveReachedFc: fault === 'STOP_UNCONFIRMED',
    },
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

class Port implements MotorTestOperatorPort {
  readonly pulseCalls: number[] = [];
  readonly stopCalls: string[] = [];
  readonly directionCalls: unknown[] = [];
  constructor(public snapshot: MotorTestControllerSnapshot) {}
  beginSession = () => Promise.resolve(this.snapshot);
  getSnapshot = () => this.snapshot;
  subscribe = () => () => {};
  pulseMotor = (motorNumber: number) => {
    this.pulseCalls.push(motorNumber);
    return 'ACCEPTED' as never;
  };
  renewPulseHold = () => 'RENEWED' as never;
  setEscDirection = (motorNumber: number, direction: string) => {
    this.directionCalls.push({motorNumber, direction});
    return Promise.resolve(undefined as never);
  };
  refreshDiagnostics = () => Promise.resolve(undefined as never);
  requestStop = (trigger: string) => {
    this.stopCalls.push(trigger);
    return 'ACCEPTED' as never;
  };
  endSession = () => Promise.resolve(this.snapshot);
  setMotorValues = () => undefined as never;
  setMotorValue = () => undefined as never;
  setMaster = () => undefined as never;
  stopAll = () => undefined as never;
}

function mount(port: Port): ReactTestRenderer.ReactTestRenderer {
  const {MotorsScreenView} = require('./MotorsScreen');
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(
      <MotorsScreenView operator={port} sessionId="fc-session" />,
    );
  });
  return tree;
}

const has = (tree: ReactTestRenderer.ReactTestRenderer, id: string): boolean =>
  tree.root.findAllByProps({testID: id}).length > 0;

/** Document order of testIDs, exactly as the renderer will paint them. */
function renderOrder(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  const order: string[] = [];
  const visit = (node: {props?: {testID?: string}; children?: unknown}): void => {
    const id = node.props?.testID;
    if (typeof id === 'string' && !order.includes(id)) {
      order.push(id);
    }
    const children = (node as {children?: unknown}).children;
    if (Array.isArray(children)) {
      for (const child of children) {
        if (child !== null && typeof child === 'object') {
          visit(child as never);
        }
      }
    }
  };
  const root = tree.toJSON();
  if (Array.isArray(root)) {
    root.forEach(node => visit(node as never));
  } else if (root) {
    visit(root as never);
  }
  return order;
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

/* ================================================================== *
 * M-1 A. READY carries no emergency surface
 * ================================================================== */

describe('M-1 A - a healthy session shows no emergency guidance', () => {
  it('renders neither the banner nor the pinned instruction', () => {
    const tree = mount(new Port(snapshotFor({})));
    expect(has(tree, 'motors-fault-banner')).toBe(false);
    expect(has(tree, 'motors-fault-notice')).toBe(false);
    expect(has(tree, 'motors-pinned-fault-guidance')).toBe(false);
    expect(textOf(tree)).not.toContain(ar.motorsScreen.emergencyDisconnect);
    act(() => tree.unmount());
  });
});

/* ================================================================== *
 * M-1 B/C. The dangerous fault is visible at the top AND pinned
 * ================================================================== */

describe('M-1 B/C - the unconfirmed-stop fault is impossible to miss', () => {
  let port: Port;
  let tree: ReactTestRenderer.ReactTestRenderer;

  beforeEach(() => {
    port = new Port(snapshotFor({fault: 'STOP_UNCONFIRMED'}));
    tree = mount(port);
  });
  afterEach(() => act(() => tree.unmount()));

  it('renders the detailed banner BEFORE every core section', () => {
    const order = renderOrder(tree);
    const banner = order.indexOf('motors-fault-banner');
    expect(banner).toBeGreaterThan(-1);
    // Top-adjacent: after the status card, before the workspace and the
    // three P1b sections that used to bury it.
    expect(banner).toBeGreaterThan(order.indexOf('motors-status'));
    for (const below of [
      'motor-workspace',
      'motors-identity-section',
      'motor-direction-section',
      'motor-output-mapping-section',
    ]) {
      const index = order.indexOf(below);
      if (index !== -1) {
        expect(banner).toBeLessThan(index);
      }
    }
  });

  it('pins the SAME instruction beside STOP, outside the scroller', () => {
    expect(has(tree, 'motors-pinned-fault-guidance')).toBe(true);
    // Same sentence, not a paraphrase - the banner and the pinned line
    // must never disagree about what to do.
    const pinned = tree.root.findAllByProps({
      testID: 'motors-pinned-fault-guidance',
    })[0];
    expect(pinned.props.children).toBe(ar.motorsScreen.emergencyDisconnect);

    // Scroll-independent: inside the pinned session dock, and NOT inside
    // any ScrollView.
    const {ScrollView} = require('react-native');
    for (const scroll of tree.root.findAllByType(ScrollView)) {
      expect(
        scroll.findAllByProps({testID: 'motors-pinned-fault-guidance'}).length,
      ).toBe(0);
    }
    const dock = tree.root.findAllByProps({testID: 'motors-session-dock'})[0];
    expect(
      dock.findAllByProps({testID: 'motors-pinned-fault-guidance'}).length,
    ).toBeGreaterThan(0);
  });

  it('keeps STOP present, uncovered by structure, and before nothing new', () => {
    const dock = tree.root.findAllByProps({testID: 'motors-session-dock'})[0];
    expect(
      dock.findAllByProps({testID: 'motors-stop-button'}).length,
    ).toBeGreaterThan(0);
    // The guidance is a sibling ABOVE the stop button in a column layout -
    // never an overlay, never a replacement.
    const order = renderOrder(tree);
    expect(order.indexOf('motors-pinned-fault-guidance')).toBeLessThan(
      order.indexOf('motors-stop-button'),
    );
  });

  it('is plain text: no press handler, no navigation, no command', () => {
    const pinned = tree.root.findAllByProps({
      testID: 'motors-pinned-fault-guidance',
    })[0];
    expect(pinned.props.onPress).toBeUndefined();
    expect(port.pulseCalls).toEqual([]);
    expect(port.stopCalls).toEqual([]);
    expect(port.directionCalls).toEqual([]);
  });
});

/* ================================================================== *
 * M-1 D. An ordinary fault never gains the battery instruction
 * ================================================================== */

describe('M-1 D - a plain fault keeps the calmer message', () => {
  it('shows the notice, not the LiPo instruction, and pins nothing', () => {
    const tree = mount(new Port(snapshotFor({fault: 'PLAIN'})));
    expect(has(tree, 'motors-fault-notice')).toBe(true);
    expect(has(tree, 'motors-fault-banner')).toBe(false);
    expect(has(tree, 'motors-pinned-fault-guidance')).toBe(false);
    expect(textOf(tree)).not.toContain(ar.motorsScreen.emergencyDisconnect);
    // The notice also sits in the top slot - same placement rule. M-E
    // moved the identity WORKFLOW under the technical details disclosure,
    // so the thing the notice must precede in the primary flow is the
    // aircraft, which is what an operator meets first.
    const order = renderOrder(tree);
    expect(order.indexOf('motors-fault-notice')).toBeLessThan(
      order.indexOf('motors-identity-map'),
    );
    act(() => tree.unmount());
  });
});

/* ================================================================== *
 * M-2. One identification model, one progress surface
 * ================================================================== */

describe('M-2 - the bench card no longer competes with identity truth', () => {
  it('renders no X-of-4 badge on a quad', () => {
    const tree = mount(new Port(snapshotFor({})));
    expect(has(tree, 'motors-progress')).toBe(false);
    expect(textOf(tree)).not.toContain('من أصل');
    // The authoritative count still exists, once, in the identity
    // summary - which M-E moved under the technical details disclosure
    // with the rest of the verification workflow it belongs to.
    openMotorsTechnicalDetails(tree);
    expect(has(tree, 'motors-identity-summary-confirmed')).toBe(true);
    act(() => tree.unmount());
  });

  it('renders no 0-of-4 contradiction on a hex', () => {
    const tree = mount(new Port(snapshotFor({motorCount: 6})));
    expect(has(tree, 'motors-progress')).toBe(false);
    expect(textOf(tree)).not.toContain('من أصل');
    // The honest capability statement stands alone, in the verification
    // section where the count it replaces also lives.
    openMotorsTechnicalDetails(tree);
    const rendered = textOf(tree);
    expect(rendered).not.toContain('من أصل');
    expect(rendered).toContain(ar.motorsScreen.summaryConfirmedUnavailable);
    act(() => tree.unmount());
  });

  it('no longer directs the operator to relocated controls', () => {
    const tree = mount(new Port(snapshotFor({})));
    const rendered = textOf(tree);
    // The turquoise-button reference and the old bench tutorial are gone.
    expect(rendered).not.toContain('الزر الفيروزي');
    expect(rendered).not.toContain('اختر مخرجًا من الشريط');
    expect(rendered).not.toContain('اختر M1–M4 ثم اضغط مطولًا');
    act(() => tree.unmount());
  });

  it('removed the dead keys with the dead presentation', () => {
    const ms = ar.motorsScreen as Record<string, unknown>;
    for (const key of [
      'verificationProgress',
      'flowSafety',
      'flowSafetyDetail',
      'flowSession',
      'flowHold',
      'flowHoldReady',
      'flowHoldWaiting',
    ]) {
      expect(ms[key]).toBeUndefined();
    }
  });

  it('describes only what the card still contains', () => {
    const tree = mount(new Port(snapshotFor({})));
    /* The bench moved INSIDE the advanced disclosure, which is collapsed
       by default. Its copy is unchanged and so is this contract - the
       card must still describe only what it contains - so the test opens
       the drawer the operator would open. */
    const toggle = tree.root.findAll(
      node => node.props?.testID === 'motors-advanced-verification-toggle',
    )[0];
    act(() => toggle.props.onPress());
    const rendered = textOf(tree);
    expect(rendered).toContain(ar.motorsScreen.workspaceHeading);
    expect(rendered).toContain(ar.motorsScreen.workspaceSubtitle);
    // The settings summary remains inside it.
    expect(rendered).toContain(ar.motorsScreen.configMotorCount);
    act(() => tree.unmount());
  });

  it('keeps the whole identity workflow reachable, in its M-E place', () => {
    const tree = mount(new Port(snapshotFor({})));
    // The aircraft and the action that spins a motor are in the primary
    // flow; the verification workflow is one press away, entire.
    expect(has(tree, 'motors-identity-map')).toBe(true);
    expect(has(tree, 'motors-hold-button')).toBe(true);
    openMotorsTechnicalDetails(tree);
    expect(has(tree, 'motors-identity-section')).toBe(true);
    // M-F2: direction and reorder are PRIMARY tools with their own
    // one-press entries beside the airframe - closer than before, and
    // still whole.
    openMotorsDirectionTool(tree);
    expect(has(tree, 'motor-direction-section')).toBe(true);
    openMotorsReorderTool(tree);
    expect(has(tree, 'motor-output-mapping-section')).toBe(true);
    act(() => tree.unmount());
  });
});
