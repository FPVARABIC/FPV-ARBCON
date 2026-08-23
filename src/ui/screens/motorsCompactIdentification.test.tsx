/**
 * ONE ACTIVE OBSERVATION FORM, AND AN HONEST CAPABILITY STATEMENT.
 *
 * A CORRECTION FIRST, BECAUSE IT SHAPED THIS FILE. The previous pass
 * reported that the identity section rendered "four full observation forms
 * at once". Reading `MotorVerificationWizard` and then measuring the DOM
 * showed otherwise: it renders exactly ONE form, for `receipt.motorNumber`,
 * and a browser probe counted one wizard, four position options, two
 * direction options and one confirm button. The height came from a single
 * form plus the map's reference prose, not from four forms. These tests
 * pin the property that was assumed rather than proven.
 *
 * THE TWO THINGS THIS SUITE GUARDS:
 *
 *   1. THE ACTIVE FORM BELONGS TO THE RECEIPT, NOT THE SELECTION.
 *      Selecting a different motor must not hand it the pending motor's
 *      receipt. Selection is addressing; it mints no evidence.
 *
 *   2. AN ACTION THAT CANNOT WORK IS NOT OFFERED.
 *      On an airframe the identification model does not describe, the
 *      protected hold is withdrawn from this section and replaced by what
 *      is unavailable, why, and what remains.
 *
 * NOT HARDWARE EVIDENCE. Nothing here spins a motor or reaches MSP.
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import '../../i18n';
import i18n from '../../i18n';
import ar from '../../i18n/locales/ar.json';
import {
  beginVerification,
  confirmObservation,
  EMPTY_VERIFICATION_STATE,
  summarizeMotorIdentification,
} from '../../core/state/motorVerificationModel';
import type {
  MotorTestControllerSnapshot,
  MotorTestVerificationReceipt,
} from '../../core/state/motorTestController';
import type {MotorTestOperatorPort} from '../../platforms/react-native/protocol';

/* M-D §46 - `NOT_OBSERVED` REPLACED THE EM DASH.
   These assertions read `.toBe('—')`. The property each one is named for
   is unchanged: nothing has been observed, and the screen must not borrow
   a value from the expected row above. What changed is that an unobserved
   value now SAYS it is unobserved instead of drawing a dash, which reads
   as zero, or broken, or still loading. Keyed rather than quoted so the
   test and the catalogue cannot drift apart. */
const NOT_OBSERVED = String(i18n.t('motorsScreen.valueNotObserved'));
/* The COMPACT CHIP carries no mark at all. It is ~40px wide and the row's
   height is reserved either way, so an unconfirmed motor simply shows
   nothing - and its accessibilityLabel still speaks the full state, which
   is asserted on the very next line of each case below. */
const EMPTY_MARK = '';


beforeAll(async () => {
  if (!i18n.isInitialized) {
    await i18n.init();
  }
});

const TOKEN = {};

function receiptFor(motorNumber: number): MotorTestVerificationReceipt {
  return {
    sessionToken: TOKEN,
    attemptId: motorNumber,
    motorNumber,
    stopEpisodeId: motorNumber,
    pulseAcknowledged: true,
    stopAcknowledged: true,
    attributionAmbiguous: false,
    stopUnsafe: false,
  } as unknown as MotorTestVerificationReceipt;
}

function snapshotFor(
  motorCount: number,
  receipt?: MotorTestVerificationReceipt,
): MotorTestControllerSnapshot {
  return {
    phase: 'ACTIVE',
    setupStep: 'READY',
    machine: {name: 'Ready', startAcknowledged: false},
    outcome: {kind: 'READY'},
    firmwareCompatibility: undefined,
    motorScope: {motorCount, motorProtocolRaw: 7, feature3dEnabled: false},
    // MIXER_QUADX. A READY snapshot always carries the mixer byte - the
    // motor-test setup reads MSP_MIXER_CONFIG (42) before it publishes
    // READY - and these fixtures have always described a Quad X. It is
    // stated here rather than inferred from the count, because four
    // motors is not four corners.
    mixerModeRaw: 3,
    motorDiagnosticsSupport: {
      motorCount,
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
    verificationReceipt: receipt,
  } as unknown as MotorTestControllerSnapshot;
}

class Port implements MotorTestOperatorPort {
  readonly pulseCalls: number[] = [];
  readonly stopCalls: string[] = [];
  private listeners: Array<(s: MotorTestControllerSnapshot) => void> = [];
  constructor(public snapshot: MotorTestControllerSnapshot) {}
  publish(next: MotorTestControllerSnapshot): void {
    this.snapshot = next;
    this.listeners.forEach(l => l(next));
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
const first = (tree: ReactTestRenderer.ReactTestRenderer, id: string) =>
  tree.root.findAllByProps({testID: id})[0];
const hostCount = (
  tree: ReactTestRenderer.ReactTestRenderer,
  id: string,
): number =>
  tree.root
    .findAllByProps({testID: id})
    .filter(node => typeof node.type === 'string').length;

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
 * 20. THE COMPACT WORKFLOW
 * ================================================================== */

describe('20 - one active form, every motor still represented', () => {
  let port: Port;
  let tree: ReactTestRenderer.ReactTestRenderer;

  beforeEach(() => {
    port = new Port(snapshotFor(4, receiptFor(1)));
    tree = mount(port);
  });
  afterEach(() => act(() => tree.unmount()));

  it('renders a compact summary row for every logical motor', () => {
    expect(has(tree, 'motor-identification-summary')).toBe(true);
    for (const slot of [1, 2, 3, 4]) {
      expect(has(tree, `motor-identification-summary-M${slot}`)).toBe(true);
    }
  });

  it('mounts exactly ONE observation form, not one per motor', () => {
    // The measured fact this file exists to pin.
    expect(hostCount(tree, 'verification-questions')).toBe(1);
    // Four position choices belong to that single form, not to four forms.
    expect(hostCount(tree, 'verification-position-FRONT_LEFT')).toBe(1);
  });

  it('shows only the question being answered right now', () => {
    // P1b-B.2: position first. The direction options and the confirm
    // control are not merely below the fold - they are not mounted.
    expect(hostCount(tree, 'verification-stage-position')).toBe(1);
    expect(hostCount(tree, 'verification-direction-CW')).toBe(0);
    expect(hostCount(tree, 'verification-confirm')).toBe(0);
  });

  it('names the motor the active form belongs to', () => {
    expect(has(tree, 'motor-identification-active-M1')).toBe(true);
  });

  it('switches the addressed motor from a summary row, commanding nothing', () => {
    act(() => first(tree, 'motor-identity-M3').props.onPress());
    expect(first(tree, 'motor-identity-number').props.children).toBe('M3');
    expect(port.pulseCalls).toEqual([]);
    expect(port.stopCalls).toEqual([]);
  });

  it('shows a per-motor state for each motor rather than four forms', () => {
    // COMPACT, NOT SILENT. Every state that says something keeps its
    // word; the resting default - which the summary line under the chips
    // already states for the addressed motor - is a mark, so four copies
    // of "unconfirmed" no longer stand above a line saying "unconfirmed".
    expect(
      first(tree, 'motor-identification-summary-M2').props.children,
    ).toBe(EMPTY_MARK);
    // ...and the full state is still SPOKEN, unchanged.
    expect(first(tree, 'motor-identity-M2').props.accessibilityLabel).toContain(
      ar.motorsScreen.identityStatus.UNCONFIRMED,
    );
    // The motor whose receipt is pending reads as being identified now.
    expect(
      first(tree, 'motor-identification-summary-M1').props.children,
    ).toBe(ar.motorsScreen.identityStatusPending);
  });
});

describe('20 - observations survive switching between motors', () => {
  let port: Port;
  let tree: ReactTestRenderer.ReactTestRenderer;

  function observe(position: string, direction: string): void {
    act(() => first(tree, `verification-position-${position}`).props.onPress());
    act(() => first(tree, `verification-direction-${direction}`).props.onPress());
    act(() => first(tree, 'verification-confirm').props.onPress());
  }

  beforeEach(() => {
    port = new Port(snapshotFor(4, receiptFor(2)));
    tree = mount(port);
    act(() => first(tree, 'motor-identity-M2').props.onPress());
    observe('FRONT_RIGHT', 'CW');
  });
  afterEach(() => act(() => tree.unmount()));

  it('keeps M2 confirmed after selecting M3', () => {
    act(() => first(tree, 'motor-identity-M3').props.onPress());
    expect(
      first(tree, 'motor-identification-summary-M2').props.children,
    ).toBe(ar.motorsScreen.identityStatus.CONFIRMED);
  });

  it('shows M3 as unconfirmed while M2 stays confirmed', () => {
    act(() => first(tree, 'motor-identity-M3').props.onPress());
    expect(
      first(tree, 'motor-identification-summary-M3').props.children,
    ).toBe(EMPTY_MARK)
    // The word itself is still spoken to assistive technology.
    expect(
      first(tree, 'motor-identity-M3').props.accessibilityLabel,
    ).toContain(ar.motorsScreen.identityStatus.UNCONFIRMED);
    // COMPACT, NOT WEAKER. The confirmed VALUE is an em-dash because
    // nothing was observed - it is never borrowed from the template row
    // above it - and the badge on the same line still says so in words.
    expect(first(tree, 'motor-identity-confirmed').props.children).toBe(NOT_OBSERVED);
    expect(
      first(tree, 'motor-identity-confirmed-badge').findAll(
        node => typeof node.props?.children === 'string',
      )[0].props.children,
    ).toBe(ar.motorsScreen.truthUnconfirmed);
  });

  it('updates the summary immediately when M2 is corrected', () => {
    act(() => first(tree, 'motor-identity-clear').props.onPress());
    // The confirmed position is gone...
    // COMPACT, NOT WEAKER. The confirmed VALUE is an em-dash because
    // nothing was observed - it is never borrowed from the template row
    // above it - and the badge on the same line still says so in words.
    expect(first(tree, 'motor-identity-confirmed').props.children).toBe(NOT_OBSERVED);
    expect(
      first(tree, 'motor-identity-confirmed-badge').findAll(
        node => typeof node.props?.children === 'string',
      )[0].props.children,
    ).toBe(ar.motorsScreen.truthUnconfirmed);
    // ...and M2 reads as pending again rather than confirmed, because the
    // M2 receipt is still the outstanding one and may be answered afresh.
    expect(
      first(tree, 'motor-identification-summary-M2').props.children,
    ).toBe(ar.motorsScreen.identityStatusPending);
    expect(
      first(tree, 'motor-identification-summary-M2').props.children,
    ).not.toBe(ar.motorsScreen.identityStatus.CONFIRMED);
    // A correction is metadata only.
    expect(port.pulseCalls).toEqual([]);
    expect(port.stopCalls).toEqual([]);
  });
});

/* ================================================================== *
 * 21. RECEIPT BINDING
 * ================================================================== */

describe('21 - a receipt never migrates to another motor', () => {
  let port: Port;
  let tree: ReactTestRenderer.ReactTestRenderer;

  beforeEach(() => {
    // A pulse on M3 produced an M3 receipt.
    port = new Port(snapshotFor(4));
    tree = mount(port);
    act(() => first(tree, 'motor-identity-M3').props.onPress());
    act(() => {
      const hold = first(tree, 'motors-hold-button');
      hold.props.onPressIn();
      hold.props.onLongPress();
    });
    act(() => port.publish(snapshotFor(4, receiptFor(3))));
  });
  afterEach(() => act(() => tree.unmount()));

  it('binds the active form to the receipt motor', () => {
    expect(port.pulseCalls).toEqual([3]);
    expect(has(tree, 'motor-identification-active-M3')).toBe(true);
  });

  it('keeps the form on M3 after the operator selects M2', () => {
    act(() => first(tree, 'motor-identity-M2').props.onPress());
    // Selection moved; the evidence context did not.
    expect(first(tree, 'motor-identity-number').props.children).toBe('M2');
    expect(has(tree, 'motor-identification-active-M3')).toBe(true);
    expect(has(tree, 'motor-identification-active-M2')).toBe(false);
  });

  it('says out loud that the pending answer belongs to another motor', () => {
    act(() => first(tree, 'motor-identity-M2').props.onPress());
    expect(has(tree, 'motor-identification-pending-elsewhere')).toBe(true);
    const rendered = textOf(tree);
    expect(rendered).toContain('M3');
    expect(rendered).toContain('M2');
  });

  it('confirms M3, never M2, when the answer is given', () => {
    act(() => first(tree, 'motor-identity-M2').props.onPress());
    act(() => first(tree, 'verification-position-REAR_LEFT').props.onPress());
    act(() => first(tree, 'verification-direction-CW').props.onPress());
    act(() => first(tree, 'verification-confirm').props.onPress());
    // THE LEAK THAT MUST NOT HAPPEN: M2 was selected the whole time.
    expect(
      first(tree, 'motor-identification-summary-M3').props.children,
    ).toBe(ar.motorsScreen.identityStatus.CONFIRMED);
    expect(
      first(tree, 'motor-identification-summary-M2').props.children,
    ).toBe(EMPTY_MARK)
    // The word itself is still spoken to assistive technology.
    expect(
      first(tree, 'motor-identity-M2').props.accessibilityLabel,
    ).toContain(ar.motorsScreen.identityStatus.UNCONFIRMED);
  });

  it('offers a way back to the motor the answer belongs to', () => {
    act(() => first(tree, 'motor-identity-M2').props.onPress());
    act(() => first(tree, 'motor-identification-go-pending').props.onPress());
    expect(first(tree, 'motor-identity-number').props.children).toBe('M3');
    expect(has(tree, 'motor-identification-pending-elsewhere')).toBe(false);
    // Returning is navigation, not a command.
    expect(port.pulseCalls).toEqual([3]);
  });
});

/* ================================================================== *
 * 22. M5+ / UNSUPPORTED LAYOUTS
 * ================================================================== */

describe('22 - a six-motor aircraft is told the truth before it acts', () => {
  let port: Port;
  let tree: ReactTestRenderer.ReactTestRenderer;

  beforeEach(() => {
    port = new Port(snapshotFor(6, receiptFor(1)));
    tree = mount(port);
  });
  afterEach(() => act(() => tree.unmount()));

  it('lists all six logical motors', () => {
    for (const slot of [1, 2, 3, 4, 5, 6]) {
      expect(has(tree, `motor-identity-M${slot}`)).toBe(true);
    }
  });

  it('lets M5 be selected, and commands nothing when it is', () => {
    act(() => first(tree, 'motor-identity-M5').props.onPress());
    expect(first(tree, 'motor-identity-number').props.children).toBe('M5');
    expect(port.pulseCalls).toEqual([]);
    expect(port.stopCalls).toEqual([]);
  });

  it('offers no identify action, before the operator can try one', () => {
    act(() => first(tree, 'motor-identity-M5').props.onPress());
    expect(has(tree, 'motor-identification-start')).toBe(false);
    expect(has(tree, 'motors-hold-button')).toBe(false);
    expect(has(tree, 'verification-wizard')).toBe(false);
  });

  it('explains what is unavailable and what still is', () => {
    expect(has(tree, 'motor-identification-unavailable')).toBe(true);
    const rendered = textOf(tree);
    expect(rendered).toContain(ar.motorsScreen.identifyUnavailableTitle);
    expect(rendered).toContain(ar.motorsScreen.identifyUnavailableRemains);
  });

  /**
   * WAS: every chip printed "identification unavailable" as a visible
   * mark. MEASURED ON AN OCTO SCREENSHOT, that is the same sentence eight
   * times under eight identical chips, immediately below a card that has
   * just said it once - the state is a property of the AIRFRAME, so it
   * cannot distinguish one chip from another.
   *
   * The STATE is unchanged and still asserted; it is read from the chip's
   * accessibility label, which is where it now lives and where a screen
   * reader has always found it. The visible mark being blank is asserted
   * too, so the noise cannot come back unnoticed.
   */
  it('carries NOT_APPLICABLE as state, without printing it under every chip', () => {
    for (const slot of [1, 5, 6]) {
      expect(
        first(tree, `motor-identity-M${slot}`).props.accessibilityLabel,
      ).toContain(ar.motorsScreen.identityStatus.NOT_APPLICABLE);
      expect(
        first(tree, `motor-identification-summary-M${slot}`).props.children,
      ).toBe('');
    }
    // And no misleading "2 of 6" physical-verification metric.
    expect(textOf(tree)).toContain(
      ar.motorsScreen.summaryConfirmedUnavailable,
    );
    // Said once in the section, not once per motor.
    const occurrences = textOf(tree).split(
      ar.motorsScreen.identityStatus.NOT_APPLICABLE,
    ).length - 1;
    expect(occurrences).toBeLessThanOrEqual(1);
  });

  it('shows no Quad-X expected position for M5', () => {
    act(() => first(tree, 'motor-identity-M5').props.onPress());
    expect(has(tree, 'motor-identity-expected')).toBe(false);
    expect(has(tree, 'motors-selected-expected-unavailable')).toBe(true);
  });

  it('keeps the numbered workspace, STOP and the mapping read', () => {
    expect(has(tree, 'motor-workspace')).toBe(true);
    expect(has(tree, 'motor-workspace-stop')).toBe(true);
    expect(has(tree, 'motor-output-mapping-read')).toBe(true);
    expect(has(tree, 'motor-output-edit')).toBe(false);
  });
});

/* ================================================================== *
 * 23. QUAD REGRESSION - the compacting changed presentation only
 * ================================================================== */

describe('23 - a quad keeps the whole identification workflow', () => {
  let port: Port;
  let tree: ReactTestRenderer.ReactTestRenderer;

  beforeEach(() => {
    port = new Port(snapshotFor(4));
    tree = mount(port);
  });
  afterEach(() => act(() => tree.unmount()));

  it('still offers the protected hold', () => {
    expect(has(tree, 'motor-identification-start')).toBe(true);
    expect(has(tree, 'motors-hold-button')).toBe(true);
  });

  it('activates exactly once per hold, on the selected motor', () => {
    act(() => first(tree, 'motor-identity-M4').props.onPress());
    act(() => {
      const hold = first(tree, 'motors-hold-button');
      hold.props.onPressIn();
      hold.props.onLongPress();
    });
    expect(port.pulseCalls).toEqual([4]);
  });

  it('does not confirm a position from the pulse alone', () => {
    act(() => {
      const hold = first(tree, 'motors-hold-button');
      hold.props.onPressIn();
      hold.props.onLongPress();
    });
    act(() => port.publish(snapshotFor(4, receiptFor(1))));
    // COMPACT, NOT WEAKER. The confirmed VALUE is an em-dash because
    // nothing was observed - it is never borrowed from the template row
    // above it - and the badge on the same line still says so in words.
    expect(first(tree, 'motor-identity-confirmed').props.children).toBe(NOT_OBSERVED);
    expect(
      first(tree, 'motor-identity-confirmed-badge').findAll(
        node => typeof node.props?.children === 'string',
      )[0].props.children,
    ).toBe(ar.motorsScreen.truthUnconfirmed);
  });

  it('keeps the reference notes reachable in place, not in Advanced', () => {
    expect(has(tree, 'motors-diagram-front-hint')).toBe(false);
    act(() => first(tree, 'motors-diagram-notes-toggle').props.onPress());
    expect(has(tree, 'motors-diagram-front-hint')).toBe(true);
    expect(has(tree, 'motors-diagram-direction-source')).toBe(true);
    // The truthfulness statements themselves are never behind the toggle.
    expect(has(tree, 'motors-numbering-notice')).toBe(true);
    expect(has(tree, 'motors-diagram-notice')).toBe(true);
  });
});

/* ================================================================== *
 * 17. THE PROGRESSIVE WIZARD
 * ================================================================== */

describe('17 - the wizard asks one question at a time', () => {
  let port: Port;
  let tree: ReactTestRenderer.ReactTestRenderer;

  beforeEach(() => {
    port = new Port(snapshotFor(4, receiptFor(3)));
    tree = mount(port);
  });
  afterEach(() => act(() => tree.unmount()));

  it('opens on the POSITION question, and only that', () => {
    expect(has(tree, 'verification-stage-position')).toBe(true);
    expect(has(tree, 'verification-stage-direction')).toBe(false);
    expect(has(tree, 'verification-stage-review')).toBe(false);
    expect(has(tree, 'verification-confirm')).toBe(false);
  });

  it('advances to DIRECTION once a position is chosen', () => {
    act(() => first(tree, 'verification-position-REAR_LEFT').props.onPress());
    expect(has(tree, 'verification-stage-direction')).toBe(true);
    expect(has(tree, 'verification-stage-position')).toBe(false);
    // The answer already given stays in view, and stays undoable.
    expect(has(tree, 'verification-chosen-position')).toBe(true);
    expect(has(tree, 'verification-change-position')).toBe(true);
  });

  it('advances to REVIEW once a direction is chosen', () => {
    act(() => first(tree, 'verification-position-REAR_LEFT').props.onPress());
    act(() => first(tree, 'verification-direction-CW').props.onPress());
    expect(has(tree, 'verification-stage-review')).toBe(true);
    expect(has(tree, 'verification-confirm')).toBe(true);
    const summary = first(tree, 'verification-review-summary').props.children;
    expect(summary).toContain('M3');
    expect(summary).toContain(ar.motorVerification.position.REAR_LEFT);
  });

  it('steps back without confirming anything', () => {
    act(() => first(tree, 'verification-position-REAR_LEFT').props.onPress());
    act(() => first(tree, 'verification-direction-CW').props.onPress());
    act(() => first(tree, 'verification-change-position').props.onPress());
    expect(has(tree, 'verification-stage-position')).toBe(true);
    expect(
      first(tree, 'motor-identification-summary-M3').props.children,
    ).toBe(ar.motorsScreen.identityStatusPending);
  });

  it('confirms through the existing domain path, with no shortcut', () => {
    act(() => first(tree, 'verification-position-REAR_LEFT').props.onPress());
    act(() => first(tree, 'verification-direction-CW').props.onPress());
    // Nothing is confirmed by reaching the review stage.
    expect(
      first(tree, 'motor-identification-summary-M3').props.children,
    ).toBe(ar.motorsScreen.identityStatusPending);
    act(() => first(tree, 'verification-confirm').props.onPress());
    expect(
      first(tree, 'motor-identification-summary-M3').props.children,
    ).toBe(ar.motorsScreen.identityStatus.CONFIRMED);
    expect(port.pulseCalls).toEqual([]);
  });
});

/* ================================================================== *
 * 18. THE EXCEPTIONAL ANSWERS
 * ================================================================== */

describe('18 - every exceptional answer stays reachable', () => {
  let port: Port;
  let tree: ReactTestRenderer.ReactTestRenderer;

  beforeEach(() => {
    port = new Port(snapshotFor(4, receiptFor(1)));
    tree = mount(port);
  });
  afterEach(() => act(() => tree.unmount()));

  it('keeps the two aircraft observations one tap away, never disclosed', () => {
    // MULTIPLE_MOTORS aborts the whole verification. Putting it behind a
    // disclosure would be a safety regression, so it is asserted visible
    // with nothing opened.
    expect(has(tree, 'verification-exception-MULTIPLE_MOTORS')).toBe(true);
    expect(has(tree, 'verification-exception-NO_MOVEMENT')).toBe(true);
  });

  it('keeps them reachable at the direction and review stages too', () => {
    act(() => first(tree, 'verification-position-REAR_RIGHT').props.onPress());
    expect(has(tree, 'verification-exception-MULTIPLE_MOTORS')).toBe(true);
    act(() => first(tree, 'verification-direction-CCW').props.onPress());
    expect(has(tree, 'verification-exception-MULTIPLE_MOTORS')).toBe(true);
  });

  it('reveals the two observer answers behind one labelled toggle', () => {
    expect(has(tree, 'verification-exception-POSITION_UNCERTAIN')).toBe(false);
    act(() => first(tree, 'verification-uncertain-toggle').props.onPress());
    expect(has(tree, 'verification-exception-POSITION_UNCERTAIN')).toBe(true);
    expect(has(tree, 'verification-exception-DIRECTION_UNCERTAIN')).toBe(true);
  });

  it('records an uncertainty answer as evidence, not as a position', () => {
    act(() => first(tree, 'verification-uncertain-toggle').props.onPress());
    act(() =>
      first(tree, 'verification-exception-POSITION_UNCERTAIN').props.onPress(),
    );
    expect(
      first(tree, 'motor-identification-summary-M1').props.children,
    ).toBe(ar.motorsScreen.identityStatus.ANSWERED_WITHOUT_POSITION);
    // COMPACT, NOT WEAKER. The confirmed VALUE is an em-dash because
    // nothing was observed - it is never borrowed from the template row
    // above it - and the badge on the same line still says so in words.
    expect(first(tree, 'motor-identity-confirmed').props.children).toBe(NOT_OBSERVED);
    expect(
      first(tree, 'motor-identity-confirmed-badge').findAll(
        node => typeof node.props?.children === 'string',
      )[0].props.children,
    ).toBe(ar.motorsScreen.truthUnconfirmed);
  });

  it('issues no motor command from any exceptional answer', () => {
    act(() =>
      first(tree, 'verification-exception-NO_MOVEMENT').props.onPress(),
    );
    expect(port.pulseCalls).toEqual([]);
    expect(port.stopCalls).toEqual([]);
  });
});

/* ================================================================== *
 * 20. TRUTHS THAT MUST SURVIVE THE COMPACTION
 * ================================================================== */

describe('20 - no truth claim is behind a disclosure', () => {
  let tree: ReactTestRenderer.ReactTestRenderer;

  beforeEach(() => {
    tree = mount(new Port(snapshotFor(4, receiptFor(1))));
  });
  afterEach(() => act(() => tree.unmount()));

  it('states, with nothing opened, that the map arrows are expected only', () => {
    expect(textOf(tree)).toContain(
      ar.motorsScreen.diagramDirectionSourceShort,
    );
    expect(textOf(tree)).toContain(ar.motorsScreen.diagramNotice);
  });

  it('states that M numbers and FC outputs are different things', () => {
    expect(textOf(tree)).toContain(ar.motorsScreen.numberingNoticeShort);
  });

  it('states that confirmation comes from the operator, not the controller', () => {
    expect(textOf(tree)).toContain(ar.motorVerification.truthObservation);
  });

  it('shows expected and confirmed as separate, differently-labelled facts', () => {
    expect(has(tree, 'motor-identity-expected')).toBe(true);
    expect(has(tree, 'motor-identity-confirmed')).toBe(true);
    expect(textOf(tree)).toContain(ar.motorsScreen.truthExpected);
    expect(textOf(tree)).toContain(ar.motorsScreen.truthUnconfirmed);
  });

  it('keeps the longer explanations reachable rather than deleted', () => {
    act(() => first(tree, 'motors-diagram-notes-toggle').props.onPress());
    expect(textOf(tree)).toContain(ar.motorsScreen.numberingNotice);
    expect(textOf(tree)).toContain(ar.motorsScreen.diagramDirectionSource);
    expect(textOf(tree)).toContain(ar.motorsScreen.diagramFrontHint);

    act(() => first(tree, 'verification-details-toggle').props.onPress());
    const rendered = textOf(tree);
    expect(rendered).toContain(ar.motorVerification.softwareAck);
    expect(rendered).toContain(ar.motorVerification.softwareNotClaim);
    expect(rendered).toContain(ar.motorVerification.disclaimer);
    expect(rendered).toContain(ar.motorVerification.progressNotice);
  });
});

/* ================================================================== *
 * 21. NOTHING BUT THE PROTECTED HOLD MAY COMMAND A MOTOR
 * ================================================================== */

describe('21 - only the protected hold commands a motor', () => {
  it('issues nothing from selection, answering, or any disclosure', () => {
    const port = new Port(snapshotFor(4, receiptFor(1)));
    const tree = mount(port);

    act(() => first(tree, 'motor-identity-M2').props.onPress());
    act(() => first(tree, 'motors-diagram-notes-toggle').props.onPress());
    act(() => first(tree, 'verification-details-toggle').props.onPress());
    act(() => first(tree, 'verification-uncertain-toggle').props.onPress());
    act(() => first(tree, 'verification-position-REAR_RIGHT').props.onPress());
    act(() => first(tree, 'verification-direction-CCW').props.onPress());
    act(() => first(tree, 'verification-confirm').props.onPress());
    act(() => first(tree, 'motor-identity-M3').props.onPress());

    expect(port.pulseCalls).toEqual([]);
    expect(port.stopCalls).toEqual([]);

    // And the hold still does.
    act(() => {
      const hold = first(tree, 'motors-hold-button');
      hold.props.onPressIn();
      hold.props.onLongPress();
    });
    expect(port.pulseCalls).toEqual([3]);
    act(() => tree.unmount());
  });
});

/* ================================================================== *
 * The summary selector, directly
 * ================================================================== */

describe('the identification summary selector', () => {
  it('reports an out-of-model motor as NOT_APPLICABLE, never outstanding', () => {
    expect(
      summarizeMotorIdentification(EMPTY_VERIFICATION_STATE, [1, 5, 6]),
    ).toEqual([
      {motorNumber: 1, status: 'UNCONFIRMED'},
      {motorNumber: 5, status: 'NOT_APPLICABLE'},
      {motorNumber: 6, status: 'NOT_APPLICABLE'},
    ]);
  });

  it('separates a confirmed position from an answer that gave none', () => {
    let state = beginVerification(TOKEN);
    const observed = confirmObservation(state, receiptFor(1), {
      kind: 'OBSERVED',
      position: 'REAR_RIGHT',
      direction: 'CCW',
    });
    if (observed.kind !== 'ACCEPTED') throw new Error('setup failed');
    state = observed.state;
    const uncertain = confirmObservation(state, receiptFor(2), {
      kind: 'POSITION_UNCERTAIN',
    });
    if (uncertain.kind !== 'ACCEPTED') throw new Error('setup failed');

    expect(summarizeMotorIdentification(uncertain.state, [1, 2, 3])).toEqual([
      {motorNumber: 1, status: 'CONFIRMED'},
      {motorNumber: 2, status: 'ANSWERED_WITHOUT_POSITION'},
      {motorNumber: 3, status: 'UNCONFIRMED'},
    ]);
  });

  it('reports a mismatching observation as confirmed, because it is', () => {
    // The position IS confirmed; whether it matches the template is a
    // different question, answered by the mismatch line.
    const result = confirmObservation(beginVerification(TOKEN), receiptFor(1), {
      kind: 'OBSERVED',
      position: 'FRONT_LEFT',
      direction: 'CCW',
    });
    if (result.kind !== 'ACCEPTED') throw new Error('setup failed');
    expect(summarizeMotorIdentification(result.state, [1])).toEqual([
      {motorNumber: 1, status: 'CONFIRMED'},
    ]);
  });
});
