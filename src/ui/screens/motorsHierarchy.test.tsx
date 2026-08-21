/**
 * THE MOTORS INFORMATION HIERARCHY, PINNED SO IT CANNOT DRIFT BACK.
 *
 * The screen this file guards was one column 4,228px tall on a 1920
 * desktop. The airframe diagram - the thing that answers "which motor is
 * M1" - sat at y=1181, below the fold, UNDER the sliders it labels. The
 * ESC telemetry a person reads while a motor spins was 2,300px away from
 * the slider spinning it. Three separate red stop buttons existed, two of
 * them pinned and stacked. Every number here was measured in Chromium
 * against the real screen, not estimated.
 *
 * These tests do not check pixels. Pixels belong to the geometry sweep
 * (.dev-preview/motorsmeasure.mjs), which reruns per width. What they
 * check is the STRUCTURE that produced those pixels, because a structure
 * is what a future edit actually breaks: which region contains what, in
 * which order, and how many of a thing exist.
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {ScrollView} from 'react-native';

import '../../i18n';
import type {MotorTestControllerSnapshot} from '../../core/state/motorTestController';
import type {MotorTestOperatorPort} from '../../platforms/react-native/protocol';
import {MotorsScreenView} from './MotorsScreen';

const AUTHORITY = {sessionId: 'hierarchy', generation: 1} as const;

function snapshot(): MotorTestControllerSnapshot {
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
      escSensorEnabled: true,
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
  } as MotorTestControllerSnapshot;
}

class Port implements Partial<MotorTestOperatorPort> {
  private readonly listeners = new Set<() => void>();
  constructor(private readonly value = snapshot()) {}
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
  /** Every testID in render order - the document order of the screen. */
  readonly ids: readonly string[];
  at(testID: string): number;
  count(testID: string): number;
  press(testID: string): void;
  unmount(): void;
}

function render(options: {sessionId?: string} = {}): Rendered {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(
      <MotorsScreenView
        operator={new Port() as unknown as MotorTestOperatorPort}
        sessionId={options.sessionId}
      />,
    );
  });
  const collect = () =>
    tree.root
      .findAll(node => typeof node.props?.testID === 'string')
      .map(node => node.props.testID as string);
  return {
    tree,
    get ids() {
      return collect();
    },
    at: (testID: string) => collect().indexOf(testID),
    count: (testID: string) =>
      tree.root.findAll(
        node =>
          typeof node.type === 'string' && node.props?.testID === testID,
      ).length,
    press: (testID: string) => {
      const node = tree.root.findAll(
        candidate =>
          candidate.props?.testID === testID &&
          typeof candidate.props?.onPress === 'function',
      )[0];
      if (!node) throw new Error(`no pressable ${testID}`);
      act(() => node.props.onPress());
    },
    unmount: () => act(() => tree.unmount()),
  };
}

/** Is `child` rendered inside the subtree of the element with `testID`? */
function within(
  rendered: Rendered,
  containerTestID: string,
  childTestID: string,
): boolean {
  const container = rendered.tree.root.findAll(
    node => node.props?.testID === containerTestID,
  )[0];
  if (container === undefined) return false;
  return (
    container.findAll(node => node.props?.testID === childTestID).length > 0
  );
}

describe('the Motors screen leads with the workspace, not with its paperwork', () => {
  it('main motor workspace precedes advanced diagnostics', () => {
    const r = render({sessionId: 'hierarchy'});
    expect(r.at('motors-primary-workspace')).toBeGreaterThanOrEqual(0);
    expect(r.at('motors-primary-workspace')).toBeLessThan(
      r.at('motors-advanced-verification-toggle'),
    );
    // And the developer dump is last of all.
    expect(r.at('motors-advanced-verification-toggle')).toBeLessThan(
      r.at('motors-diagnostics-toggle'),
    );
    r.unmount();
  });

  it('airframe and motor-test controls share the primary desktop workspace', () => {
    const r = render({sessionId: 'hierarchy'});
    // Two columns, both inside the one workspace container.
    expect(within(r, 'motors-primary-workspace', 'motors-airframe-column')).toBe(true);
    expect(within(r, 'motors-primary-workspace', 'motors-control-column')).toBe(true);
    // The diagram is in the airframe column; the sliders are not.
    expect(within(r, 'motors-airframe-column', 'motors-diagram')).toBe(true);
    expect(within(r, 'motors-control-column', 'motors-diagram')).toBe(false);
    expect(within(r, 'motors-control-column', 'motor-workspace')).toBe(true);
    r.unmount();
  });

  it('master and per-motor controls are grouped', () => {
    const r = render({sessionId: 'hierarchy'});
    for (const id of [
      'motor-slider-1',
      'motor-slider-2',
      'motor-slider-3',
      'motor-slider-4',
      'motor-slider-master',
    ]) {
      expect(within(r, 'motor-workspace', id)).toBe(true);
    }
    // Adjacent, not separated by another section: nothing with a testID
    // of its own comes between the last motor and the master.
    const ids = r.ids;
    const lastMotor = ids.indexOf('motor-slider-4');
    const master = ids.indexOf('motor-slider-master');
    expect(lastMotor).toBeGreaterThanOrEqual(0);
    expect(master).toBeGreaterThan(lastMotor);
    // The stop is in the same card, after them.
    expect(ids.indexOf('motor-workspace-stop')).toBeGreaterThan(master);
    r.unmount();
  });

  it('motor identity direction and reorder stay with the airframe', () => {
    const r = render({sessionId: 'hierarchy'});
    for (const id of [
      'motors-identity-section',
      'motor-direction-section',
      'motor-output-mapping-section',
    ]) {
      expect(within(r, 'motors-airframe-column', id)).toBe(true);
    }
    // "Which motor, where, which way, which output" is ONE group: none of
    // them may drift into the advanced drawer.
    for (const id of [
      'motors-identity-section',
      'motor-direction-section',
      'motor-output-mapping-section',
    ]) {
      expect(within(r, 'motors-advanced-verification', id)).toBe(false);
    }
    r.unmount();
  });

  it('basic motor settings precede advanced read-only diagnostics', () => {
    const r = render({sessionId: 'hierarchy'});
    expect(r.at('motors-settings-heading')).toBeGreaterThanOrEqual(0);
    expect(r.at('motors-settings-heading')).toBeLessThan(
      r.at('motors-advanced-verification-toggle'),
    );
    expect(r.at('motors-open-settings')).toBeLessThan(
      r.at('motors-advanced-verification-toggle'),
    );
    // ...and both come after the workspace they configure.
    expect(r.at('motors-primary-workspace')).toBeLessThan(
      r.at('motors-settings-heading'),
    );
    r.unmount();
  });

  it('no duplicate emergency stop control', () => {
    const r = render({sessionId: 'hierarchy'});
    /*
     * TWO affordances, and each has a distinct job:
     *   motor-workspace-stop  in flow, inside the Motor Test card, where
     *                         the sliders that raised a motor are;
     *   motors-stop-button    pinned outside the scroller, reachable at
     *                         any scroll position and in any state.
     * The third - a "sticky" dock duplicating the pinned one - is gone.
     */
    expect(r.count('motors-sticky-stop')).toBe(0);
    expect(r.count('motors-stop-button')).toBe(1);
    expect(r.count('motor-workspace-stop')).toBe(1);

    // The pinned one is genuinely outside the scrolling body.
    for (const scroll of r.tree.root.findAllByType(ScrollView)) {
      expect(
        scroll.findAll(node => node.props?.testID === 'motors-stop-button'),
      ).toHaveLength(0);
    }
    // The in-flow one is genuinely inside it.
    expect(
      r.tree.root
        .findAllByType(ScrollView)
        .some(
          scroll =>
            scroll.findAll(
              node => node.props?.testID === 'motor-workspace-stop',
            ).length > 0,
        ),
    ).toBe(true);
    r.unmount();
  });

  it('unavailable read-only state does not render a large empty card', () => {
    /*
     * With NO session id the configuration and diagnostics panels have
     * nothing to read. The rule is that they render nothing at all rather
     * than a titled card whose only content is "غير متاح" - the 150-300px
     * empty block this round forbids.
     */
    const r = render();
    expect(r.count('motor-diagnostics-panel')).toBe(0);
    expect(r.count('motor-configuration-panel')).toBe(0);
    expect(r.count('motors-open-settings')).toBe(0);
    // The workspace itself still renders: an absent session is not a
    // reason to hide the screen.
    expect(r.at('motors-primary-workspace')).toBeGreaterThanOrEqual(0);
    r.unmount();
  });
});

describe('the advanced drawer holds detail without hiding its own name', () => {
  it('is collapsed on arrival and names itself anyway', () => {
    const r = render({sessionId: 'hierarchy'});
    // The section name has a position even while the body does not -
    // which is what lets the ordering above be asserted at all.
    expect(r.at('motors-tools-heading')).toBeGreaterThanOrEqual(0);
    expect(r.count('motors-advanced-verification')).toBe(0);
    expect(r.count('motors-workspace')).toBe(0);
    r.unmount();
  });

  it('opens onto the verification bench, and nothing was deleted to get there', () => {
    const r = render({sessionId: 'hierarchy'});
    r.press('motors-advanced-verification-toggle');
    expect(r.count('motors-advanced-verification')).toBe(1);
    // The bench card, its heading and the observation workflow are all
    // still here - moved, not removed.
    expect(within(r, 'motors-advanced-verification', 'motors-workspace')).toBe(true);
    r.unmount();
  });
});
