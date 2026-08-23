/**
 * THE DRAWING OWNS ITS RECTANGLE.
 *
 * THE DEFECT THIS FILE EXISTS FOR. `computeAirframeStageWidth` reads the
 * WINDOW. On a 1366 desktop it returned a 400px stage - and the stage was
 * mounted in a 188px column, centred, and spilled 106px out of each side
 * straight across the verification controls beside it. Measured in
 * Chromium at 1366 before the fix:
 *
 *   diagram rect  1147,-3  188x717
 *   stage  rect   1041,120 400x400     <- 106px outside its own parent
 *
 *   verification-details-toggle      4136px inside the drawing
 *   verification-position-FRONT_LEFT 4048px inside the drawing
 *   verification-position-FRONT_RIGHT   92px inside the drawing
 *   verification-exception-NO_MOVEMENT 4136px inside the drawing
 *   verification-uncertain-toggle    4136px inside the drawing
 *
 * 28 such intersections across 1280, 1366, 1440, 1920 and 768. The
 * previous round's sweep reported "0 covered" and was not wrong - it was
 * asking whether an element escaped the VIEWPORT or sat under the PINNED
 * dock. Neither question is "does a control intersect the airframe".
 *
 * A jest renderer cannot measure layout, so the pixel proof lives in
 * .dev-preview/r7collision.mjs, which drives the real screen in Chromium
 * at 390, 768, 1024, 1280, 1366, 1440 and 1920 with M2 addressed and the
 * verification open, and reports 0.
 *
 * What THIS file pins is the two structural facts that made the pixels
 * possible, because a structure is what a future edit actually breaks:
 *
 *   1. no interactive control other than the four motor nodes is rendered
 *      INSIDE the diagram's subtree, and
 *   2. the stage's size is derived from the container it was measured in,
 *      not from the window - so it cannot be wider than its own box.
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import '../../i18n';
import type {
  MotorTestControllerSnapshot,
  MotorTestVerificationReceipt,
} from '../../core/state/motorTestController';
import type {MotorTestOperatorPort} from '../../platforms/react-native/protocol';
import {MotorsScreenView} from './MotorsScreen';
import {
  MotorAirframeDiagram,
  MOTOR_AIRFRAME_STAGE_MIN_WIDTH,
  type MotorAirframeEntry,
} from './MotorAirframeDiagram';

const AUTHORITY = {sessionId: 'diagram-space', generation: 1} as const;
const SESSION_TOKEN = {};

const RECEIPT_M2: MotorTestVerificationReceipt = Object.freeze({
  sessionToken: SESSION_TOKEN,
  attemptId: 9,
  motorNumber: 2,
  stopEpisodeId: 2,
  pulseAcknowledged: true as const,
  stopAcknowledged: true as const,
  attributionAmbiguous: false as const,
  stopUnsafe: false as const,
  physicalStopConfirmed: false as const,
});

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
    verificationReceipt: RECEIPT_M2,
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
  private readonly value = snapshot();
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

const ENTRIES: readonly MotorAirframeEntry[] = Object.freeze([
  {slot: 1, position: 'REAR_RIGHT', direction: 'CCW'},
  {slot: 2, position: 'FRONT_RIGHT', direction: 'CW'},
  {slot: 3, position: 'REAR_LEFT', direction: 'CW'},
  {slot: 4, position: 'FRONT_LEFT', direction: 'CCW'},
] as MotorAirframeEntry[]);

const flatten = (style: unknown): Record<string, unknown> =>
  Array.isArray(style)
    ? Object.assign({}, ...style.filter(Boolean).map(flatten))
    : ((style ?? {}) as Record<string, unknown>);

describe('nothing interactive lives inside the airframe drawing', () => {
  let tree: ReactTestRenderer.ReactTestRenderer;

  beforeEach(() => {
    act(() => {
      tree = ReactTestRenderer.create(
        <MotorsScreenView
          operator={new Port() as unknown as MotorTestOperatorPort}
          sessionId="fc-1"
        />,
      );
    });
  });
  afterEach(() => act(() => tree.unmount()));

  /**
   * M-D §22 - THE MOTOR NODES, WHICHEVER REPRESENTATION IS DRAWN.
   *
   * This used to name the four `motors-airframe-slot-N` nodes, which
   * assumed the positional Quad X drawing was always rendered. It is not:
   * a drawing is shown only for an airframe this project has authored a
   * layout for, and only once the mixer read has landed. Before that -
   * and on every other airframe - the numbered list is what is on screen.
   *
   * The property under test is unchanged and is the one that matters: the
   * ONLY interactive things inside the diagram container are motor nodes.
   * No slider, no long-press, no verification control leaks in.
   */
  it('contains only motor nodes as pressables', () => {
    // Either representation is legitimate; the container id differs.
    const diagram = tree.root.findAll(
      n =>
        n.props?.testID === 'motors-airframe-diagram' ||
        n.props?.testID === 'motors-generic-outputs',
    )[0];
    expect(diagram).toBeDefined();
    const pressables = [
      ...new Set(
        diagram
          .findAll(
            n =>
              typeof n.props?.onPress === 'function' ||
              n.props?.accessibilityRole === 'radio' ||
              n.props?.accessibilityRole === 'button',
          )
          .map(n => (n.props?.testID as string) ?? '(unnamed)'),
      ),
    ].sort();
    expect(pressables.length).toBeGreaterThan(0);
    for (const testID of pressables) {
      expect(testID).toMatch(/^motors-(airframe|generic)-slot-\d+$/);
    }
  });

  it('keeps the long press and every verification control outside it', () => {
    const diagram = tree.root.findAll(
      n =>
        n.props?.testID === 'motors-airframe-diagram' ||
        n.props?.testID === 'motors-generic-outputs',
    )[0];
    expect(diagram).toBeDefined();
    const inside = (testID: string) =>
      diagram.findAll(n => n.props?.testID === testID).length > 0;
    for (const control of [
      'motors-hold-button',
      'motors-hold-block',
      'verification-wizard',
      'verification-stage-position',
      'verification-position-FRONT_LEFT',
      'verification-position-FRONT_RIGHT',
      'verification-position-REAR_LEFT',
      'verification-position-REAR_RIGHT',
      'verification-details-toggle',
      'verification-uncertain-toggle',
      'verification-exception-NO_MOVEMENT',
      'motor-identification-summary',
      'motor-identity-selected',
      'motor-direction-section',
    ]) {
      expect([control, inside(control)]).toEqual([control, false]);
    }
  });
});

describe('the stage is sized by its container, not by the window', () => {
  it('never exceeds the width it was measured in', () => {
    let tree!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      tree = ReactTestRenderer.create(
        <MotorAirframeDiagram
          mixerModeRaw={3}
          selectedSlot={2}
          onSelectSlot={() => undefined}
          motorNumbers={[1, 2, 3, 4]}
        />,
      );
    });
    const root = tree.root.findAll(
      n => n.props?.testID === 'motors-airframe-diagram',
    )[0];
    const stageWidth = () =>
      flatten(
        tree.root.findAll(n => n.props?.testID === 'motors-airframe-stage')[0]
          .props.style,
      ).width as number;

    // THE COLUMN THAT CAUSED THE DEFECT. 188px is the exact basis the
    // context column carried while the window tier wanted 400.
    act(() => {
      root.props.onLayout({nativeEvent: {layout: {width: 188, height: 400}}});
    });
    expect(stageWidth()).toBeLessThanOrEqual(188);

    // A wider box gives a wider drawing, still bounded by the box.
    act(() => {
      root.props.onLayout({nativeEvent: {layout: {width: 320, height: 400}}});
    });
    expect(stageWidth()).toBeLessThanOrEqual(320);

    // And a box narrower than the audited minimum does not shrink the
    // drawing below the size that keeps real 44dp touch targets.
    act(() => {
      root.props.onLayout({nativeEvent: {layout: {width: 40, height: 400}}});
    });
    expect(stageWidth()).toBe(MOTOR_AIRFRAME_STAGE_MIN_WIDTH);
    act(() => tree.unmount());
  });

  it('still honours the viewport ceiling when the container is generous', () => {
    // A container is a CEILING, not a target: a very wide column must not
    // turn the diagram into a poster.
    let tree!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      tree = ReactTestRenderer.create(
        <MotorAirframeDiagram
          mixerModeRaw={3}
          selectedSlot={2}
          onSelectSlot={() => undefined}
          motorNumbers={[1, 2, 3, 4]}
        />,
      );
    });
    const root = tree.root.findAll(
      n => n.props?.testID === 'motors-airframe-diagram',
    )[0];
    const stageWidth = () =>
      flatten(
        tree.root.findAll(n => n.props?.testID === 'motors-airframe-stage')[0]
          .props.style,
      ).width as number;
    // Before any measurement the size is the viewport's own answer.
    const fromViewport = stageWidth();
    expect(fromViewport).toBeGreaterThanOrEqual(MOTOR_AIRFRAME_STAGE_MIN_WIDTH);
    act(() => {
      root.props.onLayout({nativeEvent: {layout: {width: 4000, height: 400}}});
    });
    expect(stageWidth()).toBe(fromViewport);
    act(() => tree.unmount());
  });

  it('cannot paint outside its box even before the first layout pass', () => {
    // The second lock. Until onLayout fires the stage still carries the
    // window-derived size, so the style itself has to clamp.
    let tree!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      tree = ReactTestRenderer.create(
        <MotorAirframeDiagram
          mixerModeRaw={3}
          selectedSlot={2}
          onSelectSlot={() => undefined}
          motorNumbers={[1, 2, 3, 4]}
        />,
      );
    });
    const style = flatten(
      tree.root.findAll(n => n.props?.testID === 'motors-airframe-stage')[0]
        .props.style,
    );
    expect(style.maxWidth).toBe('100%');
    act(() => tree.unmount());
  });
});
