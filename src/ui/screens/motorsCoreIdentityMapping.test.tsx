/**
 * MOTOR IDENTITY AND OUTPUT MAPPING ARE CORE WORKFLOWS.
 *
 * WHAT CHANGED, AND WHY IT NEEDED PROVING. Both answers an operator needs
 * most - which motor is this, and which output drives it - used to live at
 * the bottom of the page behind a collapsed "advanced" disclosure. Reading
 * the flight controller's output mapping, a fact the firmware will simply
 * tell you, took ten steps: session, control, select, hold, release,
 * observe, open the disclosure, confirm - four times - then prepare. Every
 * one of those steps exists to support a WRITE. None is needed to LOOK.
 *
 * THE FOUR STATEMENTS THESE TESTS KEEP APART:
 *
 *   LOGICAL NUMBER     addressing. No claim about position.
 *   EXPECTED POSITION  a template. Shown only where it applies.
 *   CONFIRMED POSITION what a person saw and confirmed. The only position
 *                      truth, and never produced by software.
 *   FC OUTPUT          read from the flight controller, or absent.
 *
 * THE RULE THAT OUTRANKS EVERY LAYOUT CONCERN HERE:
 *
 *     A PULSE PROVES THE FLIGHT CONTROLLER ACCEPTED A COMMAND.
 *     IT NEVER PROVES WHICH MOTOR A PERSON SAW MOVE.
 *
 * NOT HARDWARE EVIDENCE. No MSP exchange happens in this file and no motor
 * turns. Real motor movement, on Web and on Android alike, and the true
 * physical position of any motor, remain things only a person standing
 * next to the aircraft can establish.
 */

import React from 'react';
import {Text} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';

import '../../i18n';
import i18n from '../../i18n';
import ar from '../../i18n/locales/ar.json';
import {
  clearObservation,
  confirmObservation,
  EMPTY_VERIFICATION_STATE,
  findPositionConflicts,
  beginVerification,
  type MotorVerificationState,
} from '../../core/state/motorVerificationModel';
import {expectedMotorRotation} from '../../core/state/motorExpectedRotation';
import {evaluateMotorIdentificationCapability} from '../../core/state/motorIdentificationCapability';

/** Betaflight `mixerMode_e` QUADX - the airframe the shipped
 *  identification model describes. */
const MIXER_QUADX = 3;
import type {
  MotorTestControllerSnapshot,
  MotorTestVerificationReceipt,
} from '../../core/state/motorTestController';
import type {MotorTestOperatorPort} from '../../platforms/react-native/protocol';
import {MotorOutputMappingSection} from './MotorOutputMappingSection';
import {MotorIdentitySection} from './MotorIdentitySection';
import {openMotorsTechnicalDetails} from './__testUtils__/motorsTechnicalDetails';

/* M-D §46 - `NOT_OBSERVED` REPLACED THE EM DASH.
   These assertions read `.toBe('—')`. The property each one is named for
   is unchanged: nothing has been observed, and the screen must not borrow
   a value from the expected row above. What changed is that an unobserved
   value now SAYS it is unobserved instead of drawing a dash, which reads
   as zero, or broken, or still loading. Keyed rather than quoted so the
   test and the catalogue cannot drift apart. */
const NOT_OBSERVED = String(i18n.t('motorsScreen.valueNotObserved'));


beforeAll(async () => {
  if (!i18n.isInitialized) {
    await i18n.init();
  }
});

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

const has = (tree: ReactTestRenderer.ReactTestRenderer, id: string): boolean =>
  tree.root.findAllByProps({testID: id}).length > 0;

const first = (tree: ReactTestRenderer.ReactTestRenderer, id: string) =>
  tree.root.findAllByProps({testID: id})[0];

/** Host nodes only, so one component is never counted as two. */
const hostCount = (
  tree: ReactTestRenderer.ReactTestRenderer,
  id: string,
): number =>
  tree.root
    .findAllByProps({testID: id})
    .filter(node => typeof node.type === 'string').length;

/* ================================================================== *
 * A screen-level port that can publish a new snapshot, so a second
 * receipt can arrive the way the controller really delivers one.
 * ================================================================== */

const TOKEN = {};

function receiptFor(motorNumber: number, attemptId: number): MotorTestVerificationReceipt {
  return {
    sessionToken: TOKEN,
    attemptId,
    motorNumber,
    stopEpisodeId: attemptId,
    pulseAcknowledged: true,
    stopAcknowledged: true,
    attributionAmbiguous: false,
    stopUnsafe: false,
  } as unknown as MotorTestVerificationReceipt;
}

function snapshotFor(options: {
  readonly motorCount: number;
  readonly receipt?: MotorTestVerificationReceipt;
}): MotorTestControllerSnapshot {
  return {
    phase: 'ACTIVE',
    setupStep: 'READY',
    machine: {name: 'Ready', startAcknowledged: false},
    outcome: {kind: 'READY'},
    firmwareCompatibility: undefined,
    motorScope: {
      motorCount: options.motorCount,
      motorProtocolRaw: 7,
      feature3dEnabled: false,
    },
    // A READY snapshot always carries the mixer byte - the motor-test
    // setup reads MSP_MIXER_CONFIG (42) before it publishes READY - and
    // these fixtures have always described a Quad X. It is stated here
    // rather than inferred from the count, because four motors is not
    // four corners.
    mixerModeRaw: MIXER_QUADX,
    motorDiagnosticsSupport: {
      motorCount: options.motorCount,
      dshotTelemetryEnabled: true,
      escSensorEnabled: false,
      escTelemetrySource: 'BIDIRECTIONAL_DSHOT',
    },
    armedStateEvidence: 'FRESH_DISARMED',
    motorDomain: undefined,
    motorRuntimeScope: undefined,
    telemetryHeld: true,
    activation: {allowed: true, reasons: []},
    pulse: {motorNumber: undefined, mayBeLive: false},
    stopExecution: {
      outcome: undefined,
      acknowledged: false,
      mayHaveReachedFc: false,
      attributionAmbiguous: false,
      attributionResolvedByConfirmation: false,
    },
    diagnostics: undefined,
    verificationReceipt: options.receipt,
  } as unknown as MotorTestControllerSnapshot;
}

class ScreenPort implements MotorTestOperatorPort {
  readonly pulseCalls: number[] = [];
  readonly stopCalls: string[] = [];
  private listeners: Array<(s: MotorTestControllerSnapshot) => void> = [];
  constructor(public snapshot: MotorTestControllerSnapshot) {}
  publish(next: MotorTestControllerSnapshot): void {
    this.snapshot = next;
    this.listeners.forEach(listener => listener(next));
  }
  beginSession = () => Promise.resolve(this.snapshot);
  getSnapshot = () => this.snapshot;
  subscribe = (listener: (s: MotorTestControllerSnapshot) => void) => {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  };
  pulseMotor = (motorNumber: number) => {
    this.pulseCalls.push(motorNumber);
    return 'ACCEPTED' as never;
  };
  renewPulseHold = () => 'RENEWED' as never;
  setEscDirection = () => Promise.resolve(undefined as never);
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

function mountScreen(port: ScreenPort): ReactTestRenderer.ReactTestRenderer {
  const {MotorsScreenView} = require('./MotorsScreen');
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(
      <MotorsScreenView operator={port} sessionId="fc-session" />,
    );
  });
  return tree;
}

/* ================================================================== *
 * 26. IDENTITY - THROUGH THE REAL SCREEN, ADVANCED NEVER OPENED
 * ================================================================== */

/** The screen with the technical details section open - M-E §44 put the
 *  verification workflow there, and these describes exercise it. */
function mountVerification(port: ScreenPort): ReactTestRenderer.ReactTestRenderer {
  const tree = mountScreen(port);
  openMotorsTechnicalDetails(tree);
  return tree;
}

/* The observation fixtures below describe the shipped PROPS-OUT Quad X
   build; the derivation reproduces exactly those expectations. */
const propsOutExpected = (motorNumber: number) =>
  expectedMotorRotation(3, motorNumber, true);

describe('26 - selecting a motor is addressing, and nothing else', () => {
  let port: ScreenPort;
  let tree: ReactTestRenderer.ReactTestRenderer;

  beforeEach(() => {
    port = new ScreenPort(snapshotFor({motorCount: 4}));
    tree = mountVerification(port);
  });
  afterEach(() => act(() => tree.unmount()));

  it('changes the addressed motor when a numbered node is tapped', () => {
    act(() => first(tree, 'motor-identity-M3').props.onPress());
    expect(first(tree, 'motor-identity-number').props.children).toBe('M3');
  });

  it('commands nothing on selection alone', () => {
    act(() => first(tree, 'motor-identity-M3').props.onPress());
    act(() => first(tree, 'motor-identity-M2').props.onPress());
    expect(port.pulseCalls).toEqual([]);
  });

  it('activates exactly the selected motor, exactly once, on a valid hold', () => {
    act(() => first(tree, 'motor-identity-M3').props.onPress());
    act(() => {
      const hold = first(tree, 'motors-hold-button');
      hold.props.onPressIn();
      hold.props.onLongPress();
    });
    expect(port.pulseCalls).toEqual([3]);
  });

  it('leaves the physical position UNCONFIRMED after a pulse', () => {
    // The exact non-negotiable: a receipt is not an observation.
    act(() => {
      const hold = first(tree, 'motors-hold-button');
      hold.props.onPressIn();
      hold.props.onLongPress();
    });
    act(() => port.publish(snapshotFor({motorCount: 4, receipt: receiptFor(1, 1)})));
    // COMPACT, NOT WEAKER. The confirmed VALUE is an em-dash because
    // nothing was observed - it is never borrowed from the template row
    // above it - and the badge on the same line still says so in words.
    expect(first(tree, 'motor-identity-confirmed').props.children).toBe(NOT_OBSERVED);
    expect(
      first(tree, 'motor-identity-confirmed-badge').findAll(
        node => typeof node.props?.children === 'string',
      )[0].props.children,
    ).toBe(ar.motorsScreen.truthUnconfirmed);
    expect(textOf(tree)).toContain(ar.motorsScreen.truthUnconfirmed);
  });

  it('shows the expected template and the confirmed observation as separate rows', () => {
    expect(has(tree, 'motor-identity-expected')).toBe(true);
    expect(has(tree, 'motor-identity-confirmed')).toBe(true);
    expect(textOf(tree)).toContain(ar.motorsScreen.truthExpected);
  });
});

describe('26 - only an operator observation confirms a position', () => {
  let port: ScreenPort;
  let tree: ReactTestRenderer.ReactTestRenderer;

  /** Drives the real wizard: choose a position, a direction, confirm. */
  function observe(position: string, direction: string): void {
    act(() => first(tree, `verification-position-${position}`).props.onPress());
    act(() => first(tree, `verification-direction-${direction}`).props.onPress());
    act(() => first(tree, 'verification-confirm').props.onPress());
  }

  beforeEach(() => {
    port = new ScreenPort(snapshotFor({motorCount: 4, receipt: receiptFor(1, 1)}));
    tree = mountVerification(port);
  });
  afterEach(() => act(() => tree.unmount()));

  it('records the confirmed position once the operator answers', () => {
    observe('REAR_RIGHT', 'CCW');
    expect(first(tree, 'motor-identity-confirmed').props.children).toBe(
      ar.motorVerification.position.REAR_RIGHT,
    );
    expect(textOf(tree)).toContain(ar.motorsScreen.truthConfirmed);
  });

  it('names a disagreement with the template instead of rewriting it', () => {
    // M1's template position is REAR_RIGHT; the operator saw FRONT_LEFT.
    observe('FRONT_LEFT', 'CCW');
    expect(has(tree, 'motor-identity-mismatch')).toBe(true);
    expect(textOf(tree)).toContain(ar.motorsScreen.identityMismatch);
    // The template row is untouched - the app does not learn a new layout
    // from one observation.
    expect(first(tree, 'motor-identity-expected').props.children).toBe(
      ar.motorVerification.position.REAR_RIGHT,
    );
  });

  it('surfaces which motors collide when two claim one arm', () => {
    observe('FRONT_LEFT', 'CCW');
    // A second attempt, on a second motor, reported at the SAME arm.
    act(() => port.publish(snapshotFor({motorCount: 4, receipt: receiptFor(2, 2)})));
    act(() => first(tree, 'motor-identity-M2').props.onPress());
    observe('FRONT_LEFT', 'CW');

    expect(has(tree, 'motor-identity-conflicts')).toBe(true);
    expect(has(tree, 'motor-identity-conflict-FRONT_LEFT')).toBe(true);
    const rendered = textOf(tree);
    expect(rendered).toContain('M1');
    expect(rendered).toContain('M2');
  });
});

describe('26 - correcting a mistaken observation', () => {
  let port: ScreenPort;
  let tree: ReactTestRenderer.ReactTestRenderer;

  beforeEach(() => {
    port = new ScreenPort(snapshotFor({motorCount: 4, receipt: receiptFor(1, 1)}));
    tree = mountVerification(port);
    act(() => first(tree, 'verification-position-FRONT_LEFT').props.onPress());
    act(() => first(tree, 'verification-direction-CCW').props.onPress());
    act(() => first(tree, 'verification-confirm').props.onPress());
  });
  afterEach(() => act(() => tree.unmount()));

  it('offers a correction only once something has been confirmed', () => {
    expect(has(tree, 'motor-identity-clear')).toBe(true);
  });

  it('clears that observation and nothing else', () => {
    act(() => first(tree, 'motor-identity-clear').props.onPress());
    // COMPACT, NOT WEAKER. The confirmed VALUE is an em-dash because
    // nothing was observed - it is never borrowed from the template row
    // above it - and the badge on the same line still says so in words.
    expect(first(tree, 'motor-identity-confirmed').props.children).toBe(NOT_OBSERVED);
    expect(
      first(tree, 'motor-identity-confirmed-badge').findAll(
        node => typeof node.props?.children === 'string',
      )[0].props.children,
    ).toBe(ar.motorsScreen.truthUnconfirmed);
    // The mismatch it produced goes with it.
    expect(has(tree, 'motor-identity-mismatch')).toBe(false);
    // And the correction control retires, because there is nothing to fix.
    expect(has(tree, 'motor-identity-clear')).toBe(false);
  });

  it('sends no motor command and requests no stop', () => {
    const pulsesBefore = port.pulseCalls.length;
    const stopsBefore = port.stopCalls.length;
    act(() => first(tree, 'motor-identity-clear').props.onPress());
    expect(port.pulseCalls).toHaveLength(pulsesBefore);
    expect(port.stopCalls).toHaveLength(stopsBefore);
  });

  it('leaves the flight controller output mapping exactly where it was', () => {
    // Nothing was read, so nothing may appear. A correction must not
    // conjure a mapping, and must not clear one either.
    const before = first(tree, 'motor-identity-output').props.children;
    act(() => first(tree, 'motor-identity-clear').props.onPress());
    expect(first(tree, 'motor-identity-output').props.children).toBe(before);
    expect(before).toBe(
      `${ar.motorsScreen.identityOutput}: ${ar.motorsScreen.identityOutputUnavailable}`,
    );
  });
});

describe('26 - the correction transition, at the domain level', () => {
  function confirmed(): MotorVerificationState {
    const state = beginVerification(TOKEN);
    const result = confirmObservation(state, receiptFor(1, 1), {
      kind: 'OBSERVED',
      position: 'REAR_RIGHT',
      direction: 'CCW',
    }, propsOutExpected(1));
    if (result.kind !== 'ACCEPTED') {
      throw new Error('setup failed');
    }
    return result.state;
  }

  it('returns exactly one entry to UNTESTED', () => {
    const result = clearObservation(confirmed(), 1);
    expect(result.kind).toBe('ACCEPTED');
    if (result.kind !== 'ACCEPTED') return;
    const entry = result.state.entries.find(e => e.motorNumber === 1);
    expect(entry?.outcome).toBe('UNTESTED');
    expect(entry?.observation).toBeUndefined();
    // The attempt binding goes with the observation it described.
    expect(entry?.attemptId).toBeUndefined();
  });

  it('does not touch any other entry', () => {
    const before = confirmed();
    const result = clearObservation(before, 1);
    if (result.kind !== 'ACCEPTED') throw new Error('unexpected');
    for (const motorNumber of [2, 3, 4]) {
      expect(result.state.entries.find(e => e.motorNumber === motorNumber)).toEqual(
        before.entries.find(e => e.motorNumber === motorNumber),
      );
    }
  });

  it('refuses to edit a finalized or aborted report', () => {
    const state = confirmed();
    expect(
      clearObservation({...state, finalized: true} as MotorVerificationState, 1),
    ).toEqual({kind: 'REJECTED', reason: 'FINALIZED'});
    expect(
      clearObservation({...state, aborted: true} as MotorVerificationState, 1),
    ).toEqual({kind: 'REJECTED', reason: 'ABORTED'});
  });

  it('refuses an output it does not know, and one with nothing to clear', () => {
    expect(clearObservation(confirmed(), 9).kind).toBe('REJECTED');
    expect(clearObservation(confirmed(), 2)).toEqual({
      kind: 'REJECTED',
      reason: 'ALREADY_CONFIRMED',
    });
  });

  it('reports duplicate positions without inventing a rule', () => {
    let state = beginVerification(TOKEN);
    for (const motorNumber of [1, 2]) {
      const result = confirmObservation(state, receiptFor(motorNumber, motorNumber), {
        kind: 'OBSERVED',
        position: 'FRONT_LEFT',
        direction: 'CCW',
      }, propsOutExpected(motorNumber));
      if (result.kind !== 'ACCEPTED') throw new Error('setup failed');
      state = result.state;
    }
    expect(findPositionConflicts(state)).toEqual([
      {position: 'FRONT_LEFT', motorNumbers: [1, 2]},
    ]);
    expect(findPositionConflicts(EMPTY_VERIFICATION_STATE)).toEqual([]);
  });
});

/* ================================================================== *
 * 27. NON-QUAD
 * ================================================================== */

describe('27 - a six-motor aircraft is addressed truthfully', () => {
  let port: ScreenPort;
  let tree: ReactTestRenderer.ReactTestRenderer;

  beforeEach(() => {
    port = new ScreenPort(snapshotFor({motorCount: 6, receipt: receiptFor(1, 1)}));
    tree = mountVerification(port);
  });
  afterEach(() => act(() => tree.unmount()));

  it('lists every motor the flight controller reports', () => {
    for (const slot of [1, 2, 3, 4, 5, 6]) {
      expect(has(tree, `motor-identity-M${slot}`)).toBe(true);
    }
    expect(has(tree, 'motor-identity-M7')).toBe(false);
  });

  it('lets a motor beyond the fourth be addressed', () => {
    act(() => first(tree, 'motor-identity-M6').props.onPress());
    expect(first(tree, 'motor-identity-number').props.children).toBe('M6');
  });

  it('draws no Quad-X airframe', () => {
    expect(has(tree, 'motors-diagram-cell-FRONT-LEFT')).toBe(false);
    expect(has(tree, 'motors-diagram-cell-REAR-RIGHT')).toBe(false);
  });

  it('offers no Quad-X position to confirm', () => {
    for (const position of ['FRONT_LEFT', 'FRONT_RIGHT', 'REAR_LEFT', 'REAR_RIGHT']) {
      expect(has(tree, `verification-position-${position}`)).toBe(false);
    }
    expect(has(tree, 'verification-wizard')).toBe(false);
  });

  /**
   * The reason and the count are still stated, in ONE block rather than
   * two. `motors-identification-unsupported` used to repeat, title and
   * body, what `motor-identification-unavailable` had already said
   * directly above it; the duplicate is gone and the count folded into
   * the survivor.
   */
  it('says why physical identification is unavailable, naming the count', () => {
    expect(has(tree, 'motor-identification-unavailable')).toBe(true);
    const rendered = textOf(tree);
    expect(rendered).toContain(ar.motorsScreen.identifyUnavailableTitle);
    expect(rendered).toContain('6');
    // What still works is named in the same block.
    expect(rendered).toContain(ar.motorsScreen.identifyUnavailableRemains);
    // And the block that used to repeat it is not rendered twice.
    expect(has(tree, 'motors-identification-unsupported')).toBe(false);
  });

  it('keeps numbered motor control and STOP available', () => {
    expect(has(tree, 'motor-workspace')).toBe(true);
    expect(has(tree, 'motor-workspace-stop')).toBe(true);
  });

  it('offers the identify action, and withholds every claim it cannot make', () => {
    // P1b-B.1 withdrew the hold on a hex, because it stood inside a
    // workflow this airframe has no model for. M-E §17 separated the two:
    //
    //   SPINNING ONE MOTOR needs no model. The operator watches the
    //   aircraft, not the screen, and the command is the same fixed
    //   eight-slot write the sliders on this very page already send on a
    //   hexacopter. The hold now lives with those sliders.
    //
    //   CLAIMING WHERE THE MOTOR IS needs a model, and there is none for
    //   a hex. The wizard, the expected position and rotation, and the
    //   observation-derived reorder are all still withheld, and the
    //   screen still says so and says what remains available.
    expect(has(tree, 'motors-hold-button')).toBe(true);
    expect(has(tree, 'motor-identification-start')).toBe(false);
    expect(has(tree, 'verification-wizard')).toBe(false);
    expect(has(tree, 'motor-identification-unavailable')).toBe(true);
    expect(textOf(tree)).toContain(
      ar.motorsScreen.identifyUnavailableRemains,
    );
  });

  it('still offers to READ the flight controller output mapping', () => {
    // M-F2: the mapping tool sits behind its own primary button now.
    act(() => first(tree, 'motors-open-reorder').props.onPress());
    expect(has(tree, 'motor-output-mapping-section')).toBe(true);
    expect(has(tree, 'motor-output-mapping-read')).toBe(true);
  });

  it('offers no observation-derived write, and explains that too', () => {
    act(() => first(tree, 'motors-open-reorder').props.onPress());
    expect(has(tree, 'motor-output-edit')).toBe(false);
    expect(has(tree, 'motor-output-reorder-panel')).toBe(false);
    expect(has(tree, 'motor-output-edit-unavailable')).toBe(true);
  });
});

/* ================================================================== *
 * 28/29. OUTPUT MAPPING - READ FIRST, WRITE UNCHANGED
 * ================================================================== */

/** A controller stub. Nothing here reaches MSP or a flight controller. */
function mappingController(
  load: () => Promise<unknown>,
): {
  loadOutputOrder: jest.Mock;
  saveOutputOrder: jest.Mock;
} {
  return {
    loadOutputOrder: jest.fn(load) as jest.Mock,
    saveOutputOrder: jest.fn(async () => ({
      kind: 'NO_CHANGES',
      values: [],
    })) as jest.Mock,
  };
}

async function mountMapping(
  controller: ReturnType<typeof mappingController>,
  options: {motorCount?: number; verification?: MotorVerificationState} = {},
): Promise<ReactTestRenderer.ReactTestRenderer> {
  const motorCount = options.motorCount ?? 4;
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <MotorOutputMappingSection
        sessionId="fc-session"
        motorCount={motorCount}
        verification={options.verification ?? EMPTY_VERIFICATION_STATE}
        capability={evaluateMotorIdentificationCapability(
          MIXER_QUADX,
          Array.from({length: motorCount}, (_, index) => index + 1),
        )}
        onEndMotorTestSession={async () => {}}
        controller={controller as never}
      />,
    );
  });
  return tree;
}

describe('28 - the current mapping is read, never assumed', () => {
  it('loads with no observation, no receipt and no verification at all', async () => {
    const controller = mappingController(async () => ({
      kind: 'LOADED',
      values: [2, 0, 3, 1, 4, 5, 6, 7],
    }));
    const tree = await mountMapping(controller);
    await act(async () => {
      await first(tree, 'motor-output-mapping-read').props.onPress();
    });
    expect(controller.loadOutputOrder).toHaveBeenCalledWith('fc-session');
    expect(has(tree, 'motor-output-mapping-rows')).toBe(true);
    act(() => tree.unmount());
  });

  it('displays a NON-identity mapping exactly as the controller reported it', async () => {
    const controller = mappingController(async () => ({
      kind: 'LOADED',
      values: [2, 0, 3, 1, 4, 5, 6, 7],
    }));
    const tree = await mountMapping(controller);
    await act(async () => {
      await first(tree, 'motor-output-mapping-read').props.onPress();
    });
    // values[i] is the resource driven by logical motor i+1, displayed
    // one-based. M1 -> 3, M2 -> 1, M3 -> 4, M4 -> 2.
    for (const [motor, resource] of [[1, 3], [2, 1], [3, 4], [4, 2]]) {
      expect(
        first(tree, `motor-output-row-M${motor}-value`).props.children,
      ).toContain(String(resource));
    }
    act(() => tree.unmount());
  });

  it('keeps M-numbers as motor labels rather than renaming them to outputs', async () => {
    const controller = mappingController(async () => ({
      kind: 'LOADED',
      values: [2, 0, 3, 1, 4, 5, 6, 7],
    }));
    const tree = await mountMapping(controller);
    await act(async () => {
      await first(tree, 'motor-output-mapping-read').props.onPress();
    });
    // The row still says M1 even though M1 is driven by resource 3.
    expect(textOf(tree)).toContain('M1');
    expect(first(tree, 'motor-output-row-M1-value').props.children).not.toBe(
      'M1',
    );
    act(() => tree.unmount());
  });

  it('retains the full firmware vector and says what it is not showing', async () => {
    const controller = mappingController(async () => ({
      kind: 'LOADED',
      values: [0, 1, 2, 3, 4, 5, 6, 7],
    }));
    const tree = await mountMapping(controller);
    await act(async () => {
      await first(tree, 'motor-output-mapping-read').props.onPress();
    });
    // Four logical motors, eight firmware entries: rows for the motors,
    // and an explicit note that the rest are carried through untouched.
    expect(has(tree, 'motor-output-row-M4')).toBe(true);
    expect(has(tree, 'motor-output-row-M5')).toBe(false);
    expect(has(tree, 'motor-output-mapping-tail')).toBe(true);
    act(() => tree.unmount());
  });

  it.each([
    ['REJECTED', {kind: 'REJECTED', reason: 'FC_ARMED'}],
    ['FAILED', {kind: 'FAILED', error: new Error('link')}],
    ['SESSION_ENDED', {kind: 'SESSION_ENDED'}],
  ])('shows %s honestly instead of falling back to identity', async (_name, outcome) => {
    const controller = mappingController(async () => outcome);
    const tree = await mountMapping(controller);
    await act(async () => {
      await first(tree, 'motor-output-mapping-read').props.onPress();
    });
    expect(has(tree, 'motor-output-mapping-error')).toBe(true);
    // The precise trap: an unread mapping must not render as 1->1, 2->2,
    // which is indistinguishable from a genuinely unmodified aircraft.
    expect(has(tree, 'motor-output-mapping-rows')).toBe(false);
    expect(has(tree, 'motor-output-row-M1')).toBe(false);
    act(() => tree.unmount());
  });
});

describe('29 - the write path is reached from core, and is the same path', () => {
  it('M-F3 §13: opening the tool IS the read - no second press to begin', async () => {
    const controller = mappingController(async () => ({
      kind: 'LOADED',
      values: [2, 0, 3, 1, 4, 5, 6, 7],
    }));
    const tree = await mountMapping(controller);
    // The mount itself performed the read, and the rows show it.
    expect(controller.loadOutputOrder).toHaveBeenCalledTimes(1);
    expect(has(tree, 'motor-output-mapping-rows')).toBe(true);
    act(() => tree.unmount());
  });

  it('M-F3 §12: the M-number is the LOGICAL motor, never renamed to its output', async () => {
    /* A remapped board: M1 is fed by resource 3. The row must still be
       LABELLED M1 - printing "M3" there renames the motor to its output
       and destroys the one identity everything else keys on. Asserted on
       a vector where every label would differ from every value. */
    const controller = mappingController(async () => ({
      kind: 'LOADED',
      values: [2, 0, 3, 1, 4, 5, 6, 7],
    }));
    const tree = await mountMapping(controller);
    for (let motor = 1; motor <= 4; motor += 1) {
      const row = tree.root.findAllByProps({
        testID: `motor-output-row-M${motor}`,
      })[0];
      expect(row).toBeDefined();
      const labels = row
        .findAllByType(Text)
        .map(node => String(node.props.children ?? ''));
      expect(labels).toContain(`M${motor}`);
      // And the value cell names the RESOURCE, not a second motor number.
      const value = tree.root.findAllByProps({
        testID: `motor-output-row-M${motor}-value`,
      })[0];
      expect(String(value.props.children)).toContain(
        String([2, 0, 3, 1][motor - 1] + 1),
      );
    }
    act(() => tree.unmount());
  });

  it('M-F3 §11: the DIRECT editor opens over the read vector - two taps swap two outputs', async () => {
    const controller = mappingController(async () => ({
      kind: 'LOADED',
      values: [0, 1, 2, 3, 4, 5, 6, 7],
    }));
    const tree = await mountMapping(controller);
    await act(async () => {
      first(tree, 'motor-output-edit').props.onPress();
    });
    expect(has(tree, 'motor-output-editor')).toBe(true);
    // Swap M1 <-> M2: tap the two rows. The values exchange, the editor
    // reports DIRTY, and nothing has been written.
    await act(async () => {
      first(tree, 'motor-output-editor-row-M1').props.onPress();
    });
    await act(async () => {
      first(tree, 'motor-output-editor-row-M2').props.onPress();
    });
    const rowValue = (id: string): string =>
      String(first(tree, id).props.children);
    expect(rowValue('motor-output-editor-row-M1-value')).toContain('2');
    expect(rowValue('motor-output-editor-row-M2-value')).toContain('1');
    expect(has(tree, 'motor-output-editor-dirty')).toBe(true);
    expect(controller.saveOutputOrder).not.toHaveBeenCalled();
    // Save hands the SAME controller transaction the read base and the
    // swapped draft - full vector, tail intact.
    await act(async () => {
      first(tree, 'motor-output-editor-save').props.onPress();
    });
    expect(controller.saveOutputOrder).toHaveBeenCalledTimes(1);
    const [, base, desired] = controller.saveOutputOrder.mock.calls[0];
    expect(base).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(desired).toEqual([1, 0, 2, 3, 4, 5, 6, 7]);
    act(() => tree.unmount());
  });

  it('the guided observation-derived panel is its own entry, and refuses without observations', async () => {
    const controller = mappingController(async () => ({
      kind: 'LOADED',
      values: [0, 1, 2, 3, 4, 5, 6, 7],
    }));
    const tree = await mountMapping(controller);
    expect(has(tree, 'motor-output-reorder-panel')).toBe(false);
    await act(async () => {
      first(tree, 'motor-output-guided').props.onPress();
    });
    // The SAME panel, therefore the same controller transaction: full
    // vector, stale-base detection, disarmed proof, EEPROM write and
    // readback all still live in MotorConfigurationController. Deriving
    // a PHYSICAL correction still needs the observations, and the panel
    // says so rather than guessing.
    expect(has(tree, 'motor-output-reorder-panel')).toBe(true);
    expect(has(tree, 'motor-output-reorder-incomplete')).toBe(true);
    expect(first(tree, 'motor-output-reorder-prepare').props.disabled).toBe(true);
    act(() => tree.unmount());
  });
});

/* ================================================================== *
 * 30. WHAT THE FIRST VIEWPORT HOLDS, AND WHAT IS ONE PRESS AWAY
 *
 * M-D put the verification wizard and the output-order transaction in the
 * core column and pinned that with "neither workflow needs the advanced
 * disclosure". M-E MEASURED the result: on a 390px phone the column those
 * two workflows lived in was 1,880px tall, and because it renders before
 * the control column when the two stack, the first control that starts a
 * motor test sat 1,288px down the page - a screen and a half below the
 * fold, on a screen whose entire purpose is below it.
 *
 * So the contract is reversed, deliberately and with the measurement in
 * hand. What the first viewport holds is what an operator needs in order
 * to spin a motor: the aircraft, the motor they have selected, the Motor
 * Test controls and the identify action. What moved is the VERIFICATION
 * work - answering where a motor turned out to be, comparing that against
 * a Quad X expectation, and writing an output order derived from the
 * answers. That is a separate task, and it is one press away, whole.
 * ================================================================== */

describe('30 - the first viewport holds the tool, the paperwork is one press away', () => {
  let tree: ReactTestRenderer.ReactTestRenderer;

  beforeEach(() => {
    tree = mountScreen(
      new ScreenPort(snapshotFor({motorCount: 4, receipt: receiptFor(1, 1)})),
    );
  });
  afterEach(() => act(() => tree.unmount()));

  it('reaches the aircraft, the selected motor and the identify action with nothing opened', () => {
    expect(has(tree, 'motors-advanced-verification')).toBe(false);
    expect(has(tree, 'motors-identity-map')).toBe(true);
    expect(has(tree, 'motors-airframe-diagram')).toBe(true);
    expect(has(tree, 'motor-identity-selected-brief')).toBe(true);
    expect(has(tree, 'motors-identify-action')).toBe(true);
    expect(has(tree, 'motors-hold-button')).toBe(true);
  });

  it('keeps the verification wizard and the output mapping out of the first viewport', () => {
    expect(has(tree, 'verification-wizard')).toBe(false);
    expect(has(tree, 'motor-output-mapping-section')).toBe(false);
  });

  it('opens onto the whole of both workflows, not a summary of them', () => {
    /* M-F2: direction and reorder are PRIMARY tools now - each behind its
       own labelled button beside the airframe, not inside the disclosure.
       The disclosure still opens onto the whole verification layer. Every
       workflow below is the SAME component it always was; only the mount
       moved, and each is still whole rather than summarised. */
    act(() =>
      first(tree, 'motors-advanced-verification-toggle').props.onPress(),
    );
    expect(has(tree, 'motors-advanced-verification')).toBe(true);
    expect(has(tree, 'motors-identity-section')).toBe(true);
    expect(has(tree, 'verification-wizard')).toBe(true);
    expect(has(tree, 'motor-test-report')).toBe(true);
    act(() => first(tree, 'motors-open-direction').props.onPress());
    // M-F3: the direction button opens the WHOLE guided workflow - the
    // three-truths section embedded inside it - in the airframe column.
    expect(has(tree, 'motor-direction-workflow')).toBe(true);
    expect(has(tree, 'motor-direction-section')).toBe(true);
    act(() => first(tree, 'motors-open-reorder').props.onPress());
    expect(has(tree, 'motor-output-mapping-section')).toBe(true);
    expect(has(tree, 'motor-output-mapping-read')).toBe(true);
    // The direct-edit entry exists in some truthful form: the button once
    // the auto-read lands, or the "read first" explanation while it has
    // not (this harness has no live configuration link to answer it).
    expect(
      has(tree, 'motor-output-edit') || has(tree, 'motor-output-edit-needs-read'),
    ).toBe(true);
  });

  it('holds no second copy of either core workflow', () => {
    act(() =>
      first(tree, 'motors-advanced-verification-toggle').props.onPress(),
    );
    // With BOTH the disclosure and both primary tools open at once,
    // still exactly one of each workflow anywhere on the page.
    act(() => first(tree, 'motors-open-direction').props.onPress());
    act(() => first(tree, 'motors-open-reorder').props.onPress());
    expect(hostCount(tree, 'motor-direction-section')).toBe(1);
    // Exactly one wizard and one mapping section on the screen - the ones
    // in the core sections. Counted over HOST nodes only: the test
    // renderer reports a composite and its host element separately, and
    // counting both would read one component as two.
    expect(hostCount(tree, 'verification-wizard')).toBe(1);
    expect(hostCount(tree, 'motor-output-mapping-section')).toBe(1);
    expect(hostCount(tree, 'motor-output-reorder-panel')).toBe(0);
  });
});

/* ================================================================== *
 * The identity section's own contract, driven directly
 * ================================================================== */

describe('the identity section names an output only when one was read', () => {
  function mountIdentity(outputOrder: readonly number[] | undefined) {
    let tree!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      tree = ReactTestRenderer.create(
        <MotorIdentitySection
          slots={[1, 2, 3, 4]}
          selectedSlot={2}
          onSelectSlot={() => {}}
          capability={evaluateMotorIdentificationCapability(MIXER_QUADX, [1, 2, 3, 4])}
          mixerModeRaw={undefined}
          diagramMotorNumbers={[1, 2, 3, 4]}
          active={false}
          verification={EMPTY_VERIFICATION_STATE}
          receipt={undefined}
          onConfirm={() => {}}
          onClearObservation={() => {}}
          outputOrder={outputOrder}
          holdControl={null}
        />,
      );
    });
    return tree;
  }

  it('says unavailable when nothing has been read', () => {
    const tree = mountIdentity(undefined);
    // The output line now carries its own label, because it is a caption
    // rather than a labelled row. The value it reports is unchanged.
    expect(first(tree, 'motor-identity-output').props.children).toBe(
      `${ar.motorsScreen.identityOutput}: ${ar.motorsScreen.identityOutputUnavailable}`,
    );
    expect(textOf(tree)).toContain(ar.motorsScreen.summaryOutputsUnread);
    act(() => tree.unmount());
  });

  it('names the resource for the SELECTED logical motor, by index', () => {
    // M2 is index 1, whose value is 0 -> resource 1. Not the motor number.
    const tree = mountIdentity([2, 0, 3, 1]);
    expect(first(tree, 'motor-identity-output').props.children).toContain('1');
    expect(textOf(tree)).toContain(ar.motorsScreen.truthRead);
    expect(textOf(tree)).toContain(ar.motorsScreen.summaryOutputsRead);
    act(() => tree.unmount());
  });
});
