/**
 * THREE DIRECTION TRUTHS, AND NOT ONE OF THEM MAY BECOME ANOTHER.
 *
 *   EXPECTED   an airframe TEMPLATE constant. Shown only where the
 *              template describes this aircraft at all.
 *   COMMANDED  what this session asked an ESC to become, and how the
 *              flight controller answered. Never a readback: the audited
 *              MSP surface has no command that reports ESC spin
 *              direction, so "what we asked for" is the ceiling of what
 *              this application can know.
 *   OBSERVED   what a person watched the motor do, through the existing
 *              identification workflow. The only physical truth.
 *
 * THE COMPARISON RULE, and the reason it is narrower than it looks.
 * Expected and observed both speak clockwise/anticlockwise, so comparing
 * them means something. Normal/Reverse selects which of an ESC's two
 * stored directions is active, and which physical rotation that produces
 * also depends on how the motor's three phases are wired - so a
 * commanded value and an observed value are statements in two different
 * vocabularies. This suite proves the app never bridges them.
 *
 * NOT HARDWARE EVIDENCE. Nothing here reaches MSP or turns a motor. Which
 * way a motor physically spins remains an operator observation on both
 * platforms, and the ESC's stored setting remains unreadable.
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import '../../i18n';
import i18n from '../../i18n';
import ar from '../../i18n/locales/ar.json';
import {
  evaluateMotorDirectionCommandCapability,
  MOTOR_DIRECTION_COMMAND_MAX_MOTORS,
} from '../../core/state/motorDirectionCapability';
import {
  beginDirectionCommandLog,
  clearDirectionCommands,
  directionCommandFor,
  EMPTY_DIRECTION_COMMAND_LOG,
  recordDirectionCommand,
} from '../../core/state/motorDirectionCommandRecord';
import type {
  MotorTestControllerSnapshot,
  MotorTestVerificationReceipt,
} from '../../core/state/motorTestController';
import type {MotorTestOperatorPort} from '../../platforms/react-native/protocol';

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await i18n.init();
  }
});

/* ================================================================== *
 * Harness
 * ================================================================== */

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

function snapshotFor(options: {
  readonly motorCount?: number;
  readonly protocolRaw?: number;
  readonly feature3d?: boolean;
  readonly allowed?: boolean;
  readonly receipt?: MotorTestVerificationReceipt;
}): MotorTestControllerSnapshot {
  const motorCount = options.motorCount ?? 4;
  const allowed = options.allowed ?? true;
  return {
    phase: 'ACTIVE',
    setupStep: 'READY',
    machine: {name: 'Ready', startAcknowledged: false},
    outcome: {kind: 'READY'},
    firmwareCompatibility: undefined,
    motorScope: {
      motorCount,
      motorProtocolRaw: options.protocolRaw ?? 7,
      feature3dEnabled: options.feature3d ?? false,
    },
    motorDiagnosticsSupport: {
      motorCount,
      dshotTelemetryEnabled: true,
      escSensorEnabled: false,
      escTelemetrySource: 'BIDIRECTIONAL_DSHOT',
    },
    armedStateEvidence: allowed ? 'FRESH_DISARMED' : 'UNKNOWN_OR_STALE',
    motorDomain: undefined,
    motorRuntimeScope: undefined,
    telemetryHeld: true,
    activation: {allowed, reasons: allowed ? [] : ['FC_ARMED']},
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

type DirectionOutcome =
  | {kind: 'ACKNOWLEDGED'; motorNumber: number; direction: string; physicallyVerified: false}
  | {kind: 'UNCONFIRMED'}
  | {kind: 'REJECTED'; reason: string};

class Port implements MotorTestOperatorPort {
  readonly pulseCalls: number[] = [];
  readonly stopCalls: string[] = [];
  readonly directionCalls: {motor: number; direction: string}[] = [];
  outcome: DirectionOutcome = {
    kind: 'ACKNOWLEDGED',
    motorNumber: 0,
    direction: 'NORMAL',
    physicallyVerified: false,
  };
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
  setEscDirection = (motorNumber: number, direction: string) => {
    this.directionCalls.push({motor: motorNumber, direction});
    const outcome =
      this.outcome.kind === 'ACKNOWLEDGED'
        ? {...this.outcome, motorNumber, direction}
        : this.outcome;
    return Promise.resolve(outcome as never);
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
const first = (tree: ReactTestRenderer.ReactTestRenderer, id: string) =>
  tree.root.findAllByProps({testID: id})[0];
/**
 * The rendered STRING for a testID. `findAllByProps` also matches the
 * wrapper component the id was passed to, whose own children prop is the
 * element tree rather than the text, so the first node with string
 * children is the one that actually says something.
 */
const valueOf = (
  tree: ReactTestRenderer.ReactTestRenderer,
  id: string,
): string | undefined =>
  tree.root
    .findAllByProps({testID: id})
    .map(node => node.props.children)
    .find((children): children is string => typeof children === 'string');

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

/**
 * P1b-C.1: authoring is collapsed by default, so every command path goes
 * through the explicit open action first. Opening sends nothing.
 */
function openAuthoring(tree: ReactTestRenderer.ReactTestRenderer): void {
  if (!has(tree, 'esc-direction-panel')) {
    act(() => first(tree, 'motor-direction-authoring-open').props.onPress());
  }
}

/** Drives the real two-step authoring flow to completion. */
async function sendDirection(
  tree: ReactTestRenderer.ReactTestRenderer,
  target: 'normal' | 'reversed',
): Promise<void> {
  openAuthoring(tree);
  await act(async () => {
    first(tree, `esc-direction-${target}`).props.onPress();
  });
  await act(async () => {
    first(tree, 'esc-direction-review').props.onPress();
  });
  await act(async () => {
    await first(tree, 'esc-direction-apply').props.onPress();
  });
}

/** Confirms one observation through the real identification wizard. */
function observe(
  tree: ReactTestRenderer.ReactTestRenderer,
  position: string,
  direction: string,
): void {
  act(() => first(tree, `verification-position-${position}`).props.onPress());
  act(() => first(tree, `verification-direction-${direction}`).props.onPress());
  act(() => first(tree, 'verification-confirm').props.onPress());
}

/* ================================================================== *
 * 31/32. THE THREE-TRUTH MODEL, AND NO FAKE READBACK
 * ================================================================== */

describe('31/32 - expected exists alone, and nothing pretends to read the ESC', () => {
  let port: Port;
  let tree: ReactTestRenderer.ReactTestRenderer;

  beforeEach(() => {
    port = new Port(snapshotFor({}));
    tree = mount(port);
    act(() => first(tree, 'motor-identity-M3').props.onPress());
  });
  afterEach(() => act(() => tree.unmount()));

  it('shows the template expectation, marked as expectation', () => {
    // M3's template direction is CW.
    expect(valueOf(tree, 'motor-direction-expected')).toBe(
      ar.motorVerification.direction.CW,
    );
    expect(has(tree, 'motor-direction-expected-badge')).toBe(true);
    expect(textOf(tree)).toContain(ar.motorsScreen.truthExpected);
  });

  it('reports NO commanded direction before anything was sent', () => {
    expect(valueOf(tree, 'motor-direction-commanded')).toBe(
      ar.motorsScreen.directionCommandedNone,
    );
    expect(has(tree, 'motor-direction-commanded-badge')).toBe(false);
  });

  it('reports NO observed direction before anyone looked', () => {
    expect(valueOf(tree, 'motor-direction-observed')).toBe(
      ar.motorsScreen.directionObservedNone,
    );
    expect(has(tree, 'motor-direction-observed-badge')).toBe(false);
  });

  it('never labels any of the three as the ESC current direction', () => {
    const rendered = textOf(tree);
    // The one phrase this whole model exists to prevent.
    expect(rendered).not.toContain('الاتجاه الحالي هو');
    // And the section states outright that it cannot be read - with
    // authoring collapsed and nothing opened.
    expect(rendered).toContain(ar.motorsScreen.directionNoReadback);
  });

  it('keeps the two vocabularies explicitly apart', () => {
    expect(textOf(tree)).toContain(ar.motorsScreen.directionVocabularyShort);
  });
});

describe('31 - each source updates only itself', () => {
  let port: Port;
  let tree: ReactTestRenderer.ReactTestRenderer;

  beforeEach(async () => {
    port = new Port(snapshotFor({receipt: receiptFor(3)}));
    tree = mount(port);
    act(() => first(tree, 'motor-identity-M3').props.onPress());
  });
  afterEach(() => act(() => tree.unmount()));

  it('a command updates COMMANDED and leaves expected and observed alone', async () => {
    await sendDirection(tree, 'reversed');
    expect(port.directionCalls).toEqual([{motor: 3, direction: 'REVERSED'}]);

    expect(valueOf(tree, 'motor-direction-commanded')).toContain(
      ar.escDirection.reversed,
    );
    // EXPECTED untouched...
    expect(valueOf(tree, 'motor-direction-expected')).toBe(
      ar.motorVerification.direction.CW,
    );
    // ...and OBSERVED still absent. This is the whole point.
    expect(valueOf(tree, 'motor-direction-observed')).toBe(
      ar.motorsScreen.directionObservedNone,
    );
    expect(has(tree, 'motor-direction-observed-badge')).toBe(false);
  });

  it('an observation updates OBSERVED and leaves the command record alone', async () => {
    await sendDirection(tree, 'reversed');
    observe(tree, 'REAR_LEFT', 'CW');

    expect(valueOf(tree, 'motor-direction-observed')).toBe(
      ar.motorVerification.direction.CW,
    );
    expect(has(tree, 'motor-direction-observed-badge')).toBe(true);
    // COMMANDED survives untouched.
    expect(valueOf(tree, 'motor-direction-commanded')).toContain(
      ar.escDirection.reversed,
    );
  });

  it('reports an unconfirmed command as unconfirmed, not as success', async () => {
    port.outcome = {kind: 'UNCONFIRMED'};
    await sendDirection(tree, 'normal');
    expect(valueOf(tree, 'motor-direction-commanded')).toContain(
      ar.escDirection.normal,
    );
    expect(textOf(tree)).toContain(ar.escDirection.unconfirmed);
  });

  it('records nothing at all when the command is rejected', async () => {
    port.outcome = {kind: 'REJECTED', reason: 'NOT_READY'};
    await sendDirection(tree, 'normal');
    expect(valueOf(tree, 'motor-direction-commanded')).toBe(
      ar.motorsScreen.directionCommandedNone,
    );
  });
});

/* ================================================================== *
 * 33. COMMAND TARGETS AND CROSS-MOTOR EVIDENCE
 * ================================================================== */

describe('33 - a target is not a command, and evidence stays on its motor', () => {
  let port: Port;
  let tree: ReactTestRenderer.ReactTestRenderer;

  beforeEach(() => {
    port = new Port(snapshotFor({}));
    tree = mount(port);
  });
  afterEach(() => act(() => tree.unmount()));

  it('sends nothing when a target is merely chosen', () => {
    openAuthoring(tree);
    act(() => first(tree, 'esc-direction-normal').props.onPress());
    act(() => first(tree, 'esc-direction-reversed').props.onPress());
    expect(port.directionCalls).toEqual([]);
    expect(port.pulseCalls).toEqual([]);
  });

  it('needs an explicit review and apply, and then sends exactly one', async () => {
    await sendDirection(tree, 'reversed');
    expect(port.directionCalls).toHaveLength(1);
  });

  it('does not carry an UNSENT target to another motor', () => {
    act(() => first(tree, 'motor-identity-M3').props.onPress());
    openAuthoring(tree);
    act(() => first(tree, 'esc-direction-reversed').props.onPress());
    act(() => first(tree, 'motor-identity-M2').props.onPress());
    // Authoring closes with the motor change, so the unsent target goes
    // with the form that held it.
    expect(has(tree, 'esc-direction-panel')).toBe(false);
    // Reopening for M2 starts neutral - not REVERSED inherited from M3.
    openAuthoring(tree);
    expect(
      first(tree, 'esc-direction-reversed').props.accessibilityState.selected,
    ).toBe(false);
    expect(
      first(tree, 'esc-direction-normal').props.accessibilityState.selected,
    ).toBe(false);
    expect(port.directionCalls).toEqual([]);
  });

  it('keeps an acknowledged command attached to the motor it was sent to', async () => {
    act(() => first(tree, 'motor-identity-M3').props.onPress());
    await sendDirection(tree, 'reversed');
    expect(valueOf(tree, 'motor-direction-commanded')).toContain(
      ar.escDirection.reversed,
    );

    act(() => first(tree, 'motor-identity-M2').props.onPress());
    expect(valueOf(tree, 'motor-direction-commanded')).toBe(
      ar.motorsScreen.directionCommandedNone,
    );

    act(() => first(tree, 'motor-identity-M3').props.onPress());
    expect(valueOf(tree, 'motor-direction-commanded')).toContain(
      ar.escDirection.reversed,
    );
  });
});

/* ================================================================== *
 * 34. THE GATES, EACH WITH ITS OWN REASON
 * ================================================================== */

describe('34 - a blocked command says why, and offers no control', () => {
  const cases: readonly {
    readonly name: string;
    readonly snapshot: MotorTestControllerSnapshot;
    readonly reason: keyof typeof ar.motorsScreen.directionBlocked;
  }[] = [
    {
      name: '3D enabled',
      snapshot: snapshotFor({feature3d: true}),
      reason: 'THREE_D_ENABLED',
    },
    {
      // M-C: a HEXACOPTER is no longer blocked - the four-motor limit was
      // never a firmware fact. What is still out of scope is a count
      // outside 1..MAX_SUPPORTED_MOTORS, which is a corrupt runtime
      // result rather than an airframe.
      name: 'motor count outside the firmware bound',
      snapshot: snapshotFor({motorCount: 9}),
      reason: 'MOTOR_COUNT_OUT_OF_SCOPE',
    },
    {
      name: 'analog protocol',
      snapshot: snapshotFor({protocolRaw: 0}),
      reason: 'PROTOCOL_UNSUPPORTED',
    },
    {
      name: 'safety gate closed',
      snapshot: snapshotFor({allowed: false}),
      reason: 'NOT_READY',
    },
  ];

  it.each(cases.map(c => [c.name, c] as const))(
    '%s: names the cause and hides the authoring control',
    (_name, scenario) => {
      const tree = mount(new Port(scenario.snapshot));
      expect(has(tree, 'motor-direction-unavailable')).toBe(true);
      expect(valueOf(tree, 'motor-direction-unavailable-reason')).toBe(
        ar.motorsScreen.directionBlocked[scenario.reason],
      );
      // No inert control: the authoring entry itself is replaced by the
      // reason, so there is nothing to press that would do nothing.
      expect(has(tree, 'motor-direction-authoring-open')).toBe(false);
      expect(has(tree, 'esc-direction-panel')).toBe(false);
      expect(has(tree, 'esc-direction-apply')).toBe(false);
      act(() => tree.unmount());
    },
  );

  it('still shows expected and observed while the command is blocked', () => {
    const tree = mount(new Port(snapshotFor({allowed: false})));
    expect(has(tree, 'motor-direction-expected')).toBe(true);
    expect(has(tree, 'motor-direction-observed')).toBe(true);
    act(() => tree.unmount());
  });
});

describe('34 - the capability rule mirrors the gates that actually run', () => {
  const scope = {motorCount: 4, motorProtocolRaw: 7, feature3dEnabled: false};
  const base = {
    hasSession: true,
    motorNumber: 1,
    scope,
    activationAllowed: true,
  } as const;

  it('admits a reviewed quad on a DShot protocol', () => {
    expect(evaluateMotorDirectionCommandCapability(base)).toEqual({
      kind: 'AVAILABLE',
    });
  });

  it.each([
    ['NO_SESSION', {...base, hasSession: false}],
    ['SCOPE_UNKNOWN', {...base, scope: undefined}],
    ['THREE_D_ENABLED', {...base, scope: {...scope, feature3dEnabled: true}}],
    ['MOTOR_COUNT_OUT_OF_SCOPE', {...base, scope: {...scope, motorCount: 9}}],
    ['MOTOR_COUNT_OUT_OF_SCOPE', {...base, scope: {...scope, motorCount: 0}}],
    ['PROTOCOL_UNSUPPORTED', {...base, scope: {...scope, motorProtocolRaw: 0}}],
    ['MOTOR_OUT_OF_RANGE', {...base, motorNumber: 5}],
    ['NOT_READY', {...base, activationAllowed: false}],
  ])('reports %s', (reason, input) => {
    expect(evaluateMotorDirectionCommandCapability(input as never)).toEqual({
      kind: 'UNAVAILABLE',
      reason,
    });
  });

  it('admits a HEXACOPTER, and bounds the motor number by ITS count', () => {
    // M-C: the direction command widened with the rest of the motor path.
    const hex = {...scope, motorCount: 6};
    expect(
      evaluateMotorDirectionCommandCapability({...base, scope: hex, motorNumber: 6}),
    ).toEqual({kind: 'AVAILABLE'});
    // Output seven is out of range on a hexacopter even though eight
    // outputs are theoretically addressable - the bound is THIS aircraft's
    // count, not the firmware maximum.
    expect(
      evaluateMotorDirectionCommandCapability({...base, scope: hex, motorNumber: 7}),
    ).toEqual({kind: 'UNAVAILABLE', reason: 'MOTOR_OUT_OF_RANGE'});
  });

  it('takes its motor bound from the command path, not from a literal', () => {
    // MAX_SUPPORTED_MOTORS, not the shipping product's old quad scope.
    expect(MOTOR_DIRECTION_COMMAND_MAX_MOTORS).toBe(8);
    expect(
      evaluateMotorDirectionCommandCapability({
        ...base,
        scope: {...scope, motorCount: MOTOR_DIRECTION_COMMAND_MAX_MOTORS},
        motorNumber: MOTOR_DIRECTION_COMMAND_MAX_MOTORS,
      }),
    ).toEqual({kind: 'AVAILABLE'});
    // Zero-based encoding happens in the encoder; the bound here is
    // one-based, and off-by-one in either direction is refused.
    expect(
      evaluateMotorDirectionCommandCapability({...base, motorNumber: 0}).kind,
    ).toBe('UNAVAILABLE');
  });
});

/* ================================================================== *
 * 35. AN ACKNOWLEDGEMENT IS NEVER PHYSICAL
 * ================================================================== */

describe('35 - a command acknowledgement creates no physical evidence', () => {
  let port: Port;
  let tree: ReactTestRenderer.ReactTestRenderer;

  beforeEach(async () => {
    port = new Port(snapshotFor({receipt: receiptFor(1)}));
    tree = mount(port);
    await sendDirection(tree, 'reversed');
  });
  afterEach(() => act(() => tree.unmount()));

  it('leaves the physical observation untouched', () => {
    expect(valueOf(tree, 'motor-direction-observed')).toBe(
      ar.motorsScreen.directionObservedNone,
    );
    expect(first(tree, 'motor-identity-confirmed').props.children).toBe('—');
    expect(
      first(tree, 'motor-identity-confirmed-badge').findAll(
        node => typeof node.props?.children === 'string',
      )[0].props.children,
    ).toBe(ar.motorsScreen.truthUnconfirmed);
  });

  it('spins no motor and requests no stop', () => {
    expect(port.pulseCalls).toEqual([]);
    expect(port.stopCalls).toEqual([]);
  });

  it('offers verification rather than claiming it', () => {
    expect(has(tree, 'motor-direction-verify')).toBe(true);
    expect(textOf(tree)).toContain(ar.motorsScreen.directionVerifyCompact);
    // Still nothing spun by merely offering.
    expect(port.pulseCalls).toEqual([]);
  });
});

/* ================================================================== *
 * 36/37. OBSERVED, AND THE ONE LEGITIMATE COMPARISON
 * ================================================================== */

describe('36/37 - expected versus observed, and nothing else', () => {
  function mountAt(motor: number): {
    port: Port;
    tree: ReactTestRenderer.ReactTestRenderer;
  } {
    const port = new Port(snapshotFor({receipt: receiptFor(motor)}));
    const tree = mount(port);
    act(() => first(tree, `motor-identity-M${motor}`).props.onPress());
    return {port, tree};
  }

  it('agrees when the observation matches the template', () => {
    // M3 expects CW.
    const {tree} = mountAt(3);
    observe(tree, 'REAR_LEFT', 'CW');
    expect(has(tree, 'motor-direction-match')).toBe(true);
    expect(has(tree, 'motor-direction-mismatch')).toBe(false);
    act(() => tree.unmount());
  });

  it('warns when it does not, and writes nothing to the ESC', () => {
    const {port, tree} = mountAt(3);
    observe(tree, 'REAR_LEFT', 'CCW');
    expect(has(tree, 'motor-direction-mismatch')).toBe(true);
    expect(textOf(tree)).toContain(ar.motorsScreen.directionMismatch);
    // A mismatch is evidence, never an authorization.
    expect(port.directionCalls).toEqual([]);
    expect(port.pulseCalls).toEqual([]);
    act(() => tree.unmount());
  });

  it('never compares a commanded target with an observation', async () => {
    const {tree} = mountAt(3);
    await sendDirection(tree, 'reversed');
    observe(tree, 'REAR_LEFT', 'CW');
    // Both rows are present and both are labelled, but the only verdict
    // on screen is the expected-versus-observed one.
    expect(has(tree, 'motor-direction-commanded-badge')).toBe(true);
    expect(has(tree, 'motor-direction-observed-badge')).toBe(true);
    expect(has(tree, 'motor-direction-match')).toBe(true);
    expect(textOf(tree)).toContain(ar.motorsScreen.directionVocabularyShort);
    act(() => tree.unmount());
  });

  it('shows an uncertain answer as uncertain, never as a direction', () => {
    const {tree} = mountAt(3);
    act(() => first(tree, 'verification-uncertain-toggle').props.onPress());
    act(() =>
      first(tree, 'verification-exception-DIRECTION_UNCERTAIN').props.onPress(),
    );
    expect(valueOf(tree, 'motor-direction-observed')).toBe(
      ar.motorsScreen.directionObservedUncertain,
    );
    expect(has(tree, 'motor-direction-match')).toBe(false);
    expect(has(tree, 'motor-direction-mismatch')).toBe(false);
    act(() => tree.unmount());
  });

  it('returns observed to unknown when the observation is corrected', async () => {
    const {port, tree} = mountAt(3);
    await sendDirection(tree, 'reversed');
    observe(tree, 'REAR_LEFT', 'CW');
    act(() => first(tree, 'motor-identity-clear').props.onPress());

    expect(valueOf(tree, 'motor-direction-observed')).toBe(
      ar.motorsScreen.directionObservedNone,
    );
    // COMMANDED and EXPECTED both survive the correction.
    expect(valueOf(tree, 'motor-direction-commanded')).toContain(
      ar.escDirection.reversed,
    );
    expect(valueOf(tree, 'motor-direction-expected')).toBe(
      ar.motorVerification.direction.CW,
    );
    // And clearing an observation commands nothing.
    expect(port.directionCalls).toHaveLength(1);
    expect(port.pulseCalls).toEqual([]);
    act(() => tree.unmount());
  });
});

/* ================================================================== *
 * 38. NON-QUAD - THE RIGHT REASON, NOT A BORROWED ONE
 * ================================================================== */

describe('38 - a hex keeps numbered control while the POSITION model stays quad', () => {
  let tree: ReactTestRenderer.ReactTestRenderer;

  beforeEach(() => {
    tree = mount(new Port(snapshotFor({motorCount: 6})));
  });
  afterEach(() => act(() => tree.unmount()));

  it('invents no expected direction for an airframe it cannot describe', () => {
    expect(valueOf(tree, 'motor-direction-expected')).toBe(
      ar.motorsScreen.directionExpectedUnavailable,
    );
    expect(has(tree, 'motor-direction-expected-badge')).toBe(false);
  });

  it('is NOT blocked from commanding direction any more', () => {
    // M-C: the command path used to refuse any count but four, and this
    // test asserted that a hexacopter was told so. That limit was never a
    // firmware fact - a DShot ESC on output six takes a direction command
    // exactly as one on output two does - and it is gone.
    //
    // The separation this block exists to protect is UNCHANGED and is now
    // proven the strong way round: the POSITION model did not widen (the
    // test above still gets no expected direction), while numbered CONTROL
    // did. Neither limitation borrows the other's explanation, because
    // only one limitation is left.
    expect(has(tree, 'motor-direction-unavailable')).toBe(false);
    expect(has(tree, 'motor-direction-unavailable-reason')).toBe(false);
  });

  it('still lets every motor be addressed', () => {
    act(() => first(tree, 'motor-identity-M6').props.onPress());
    // The heading names the motor now, instead of a bare number on its
    // own line under a title and an eyebrow saying the same thing.
    expect(first(tree, 'motor-direction-motor').props.children).toContain('M6');
  });

  it('fabricates no observation', () => {
    expect(valueOf(tree, 'motor-direction-observed')).toBe(
      ar.motorsScreen.directionObservedNone,
    );
  });
});

/* ================================================================== *
 * The commanded record, directly
 * ================================================================== */

describe('the commanded record is session-bound and per-motor', () => {
  it('starts empty and refuses a record without a session', () => {
    expect(EMPTY_DIRECTION_COMMAND_LOG.records).toEqual([]);
    const rejected = recordDirectionCommand(
      EMPTY_DIRECTION_COMMAND_LOG,
      TOKEN,
      {motorNumber: 1, target: 'NORMAL', status: 'ACKNOWLEDGED'},
    );
    expect(rejected.records).toEqual([]);
  });

  it('refuses a record minted under a replaced session', () => {
    const log = beginDirectionCommandLog(TOKEN);
    const other = {};
    const rejected = recordDirectionCommand(log, other, {
      motorNumber: 1,
      target: 'NORMAL',
      status: 'ACKNOWLEDGED',
    });
    expect(rejected).toBe(log);
  });

  it('keeps one record per motor, replacing only that motor', () => {
    let log = beginDirectionCommandLog(TOKEN);
    log = recordDirectionCommand(log, TOKEN, {
      motorNumber: 1,
      target: 'NORMAL',
      status: 'ACKNOWLEDGED',
    });
    log = recordDirectionCommand(log, TOKEN, {
      motorNumber: 3,
      target: 'REVERSED',
      status: 'ACKNOWLEDGED',
    });
    log = recordDirectionCommand(log, TOKEN, {
      motorNumber: 1,
      target: 'REVERSED',
      status: 'UNCONFIRMED',
    });

    expect(log.records).toHaveLength(2);
    expect(directionCommandFor(log, 1)).toEqual({
      motorNumber: 1,
      target: 'REVERSED',
      status: 'UNCONFIRMED',
    });
    expect(directionCommandFor(log, 3)).toEqual({
      motorNumber: 3,
      target: 'REVERSED',
      status: 'ACKNOWLEDGED',
    });
    expect(directionCommandFor(log, 2)).toBeUndefined();
  });

  it('forgets what was asked without claiming to revert anything', () => {
    let log = beginDirectionCommandLog(TOKEN);
    log = recordDirectionCommand(log, TOKEN, {
      motorNumber: 2,
      target: 'NORMAL',
      status: 'ACKNOWLEDGED',
    });
    const cleared = clearDirectionCommands(log);
    expect(cleared.records).toEqual([]);
    // The session survives, so later commands can still be recorded.
    expect(cleared.sessionToken).toBe(TOKEN);
  });
});

/* ================================================================== *
 * 39. THE MIXER YAW FLAG IS NOT A MOTOR DIRECTION
 * ================================================================== */

describe('39 - yaw_motors_reversed never becomes a per-motor direction', () => {
  it('is absent from every direction surface', () => {
    const executable = require('fs')
      .readFileSync(
        require('path').join(__dirname, 'MotorDirectionSection.tsx'),
        'utf8',
      )
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    for (const forbidden of [
      'yawMotorsReversed',
      'yaw_motors_reversed',
      'mixerModeRaw',
    ]) {
      expect(executable).not.toContain(forbidden);
    }
  });

  it('keeps its own truthful home in the configuration panel', () => {
    const panel = require('fs').readFileSync(
      require('path').join(__dirname, 'MotorConfigurationPanel.tsx'),
      'utf8',
    );
    expect(panel).toContain('yawMotorsReversed');
    expect(ar.motorConfiguration.propsDirectionDetail).toContain(
      'لا يثبت الاتجاه الميكانيكي الفعلي للمحركات',
    );
  });
});

/* ================================================================== *
 * 22-28. P1b-C.1 - AUTHORING ON DEMAND
 *
 * The truth rows are what an operator READS; the Normal/Reverse form is
 * what they occasionally DO. Measured at 360px, that form owned 562 of
 * the section's 855 pixels at rest and 718 of 1187 after a command. It is
 * now collapsed until asked for - and every truth it used to carry has a
 * home above it that needs no interaction.
 * ================================================================== */

describe('22 - the resting state is truth only', () => {
  let port: Port;
  let tree: ReactTestRenderer.ReactTestRenderer;

  beforeEach(() => {
    port = new Port(snapshotFor({}));
    tree = mount(port);
  });
  afterEach(() => act(() => tree.unmount()));

  it('shows all three sources with nothing opened', () => {
    expect(has(tree, 'motor-direction-expected')).toBe(true);
    expect(has(tree, 'motor-direction-commanded')).toBe(true);
    expect(has(tree, 'motor-direction-observed')).toBe(true);
  });

  it('shows both safety truths with nothing opened', () => {
    const rendered = textOf(tree);
    expect(has(tree, 'motor-direction-no-readback')).toBe(true);
    expect(rendered).toContain(ar.motorsScreen.directionNoReadback);
    expect(has(tree, 'motor-direction-vocabulary')).toBe(true);
    expect(rendered).toContain(ar.motorsScreen.directionVocabularyShort);
  });

  it('offers the authoring entry and mounts no authoring control', () => {
    expect(has(tree, 'motor-direction-authoring-open')).toBe(true);
    // Not merely hidden: the target radios and the send action do not
    // exist in the tree at all.
    expect(has(tree, 'esc-direction-panel')).toBe(false);
    expect(has(tree, 'esc-direction-normal')).toBe(false);
    expect(has(tree, 'esc-direction-reversed')).toBe(false);
    expect(has(tree, 'esc-direction-review')).toBe(false);
    expect(has(tree, 'esc-direction-apply')).toBe(false);
  });

  it('keeps the long explanations reachable rather than deleted', () => {
    act(() => first(tree, 'motor-direction-details-toggle').props.onPress());
    const rendered = textOf(tree);
    expect(rendered).toContain(ar.motorsScreen.directionVocabularyNote);
    expect(rendered).toContain(ar.escDirection.currentUnknown);
    expect(rendered).toContain(ar.escDirection.physicalCaveat);
    // Reading is never commanding.
    expect(port.directionCalls).toEqual([]);
    expect(port.pulseCalls).toEqual([]);
  });
});

describe('23/24 - opening and closing authoring commands nothing', () => {
  let port: Port;
  let tree: ReactTestRenderer.ReactTestRenderer;

  beforeEach(() => {
    port = new Port(snapshotFor({}));
    tree = mount(port);
  });
  afterEach(() => act(() => tree.unmount()));

  it('reveals the existing workflow, and sends nothing to do it', () => {
    act(() => first(tree, 'motor-direction-authoring-open').props.onPress());
    expect(has(tree, 'esc-direction-panel')).toBe(true);
    expect(has(tree, 'esc-direction-normal')).toBe(true);
    expect(has(tree, 'esc-direction-reversed')).toBe(true);
    expect(port.directionCalls).toEqual([]);
    expect(port.pulseCalls).toEqual([]);
    expect(port.stopCalls).toEqual([]);
  });

  it('starts with NEITHER target selected, every time it opens', () => {
    act(() => first(tree, 'motor-direction-authoring-open').props.onPress());
    expect(
      first(tree, 'esc-direction-normal').props.accessibilityState.selected,
    ).toBe(false);
    expect(
      first(tree, 'esc-direction-reversed').props.accessibilityState.selected,
    ).toBe(false);
  });

  it('discards an UNSENT target when authoring is closed', () => {
    act(() => first(tree, 'motor-direction-authoring-open').props.onPress());
    act(() => first(tree, 'esc-direction-reversed').props.onPress());
    act(() => first(tree, 'motor-direction-authoring-cancel').props.onPress());
    expect(has(tree, 'esc-direction-panel')).toBe(false);
    expect(port.directionCalls).toEqual([]);

    // Reopening is neutral - the withdrawn target did not survive.
    act(() => first(tree, 'motor-direction-authoring-open').props.onPress());
    expect(
      first(tree, 'esc-direction-reversed').props.accessibilityState.selected,
    ).toBe(false);
  });

  it('leaves acknowledged COMMANDED evidence alone when closing', async () => {
    await sendDirection(tree, 'reversed');
    const before = valueOf(tree, 'motor-direction-commanded');
    act(() => first(tree, 'motor-direction-authoring-open').props.onPress());
    act(() => first(tree, 'motor-direction-authoring-cancel').props.onPress());
    expect(valueOf(tree, 'motor-direction-commanded')).toBe(before);
    expect(before).toContain(ar.escDirection.reversed);
  });
});

describe('26 - an acknowledgement collapses the form and leaves a result', () => {
  let port: Port;
  let tree: ReactTestRenderer.ReactTestRenderer;

  beforeEach(async () => {
    port = new Port(snapshotFor({receipt: receiptFor(1)}));
    tree = mount(port);
    await sendDirection(tree, 'reversed');
  });
  afterEach(() => act(() => tree.unmount()));

  it('ran exactly one controller operation', () => {
    expect(port.directionCalls).toEqual([{motor: 1, direction: 'REVERSED'}]);
  });

  it('collapses the authoring form', () => {
    expect(has(tree, 'esc-direction-panel')).toBe(false);
    expect(has(tree, 'esc-direction-apply')).toBe(false);
    expect(has(tree, 'motor-direction-authoring-open')).toBe(true);
  });

  it('keeps a compact result the operator can still read', () => {
    expect(has(tree, 'motor-direction-result')).toBe(true);
    expect(valueOf(tree, 'motor-direction-result')).toBe(
      ar.escDirection.acknowledged,
    );
  });

  it('updates COMMANDED and leaves EXPECTED and OBSERVED alone', () => {
    expect(valueOf(tree, 'motor-direction-commanded')).toContain(
      ar.escDirection.reversed,
    );
    expect(valueOf(tree, 'motor-direction-expected')).toBe(
      ar.motorVerification.direction.CCW,
    );
    expect(valueOf(tree, 'motor-direction-observed')).toBe(
      ar.motorsScreen.directionObservedNone,
    );
  });

  it('offers physical verification without performing any of it', () => {
    expect(has(tree, 'motor-direction-verify')).toBe(true);
    expect(textOf(tree)).toContain(ar.motorsScreen.directionVerifyCompact);
    // The offer is a statement, not a control that could spin anything.
    expect(port.pulseCalls).toEqual([]);
    expect(port.stopCalls).toEqual([]);
    expect(port.directionCalls).toHaveLength(1);
  });
});

describe('27 - an unconfirmed outcome stays unconfirmed', () => {
  let port: Port;
  let tree: ReactTestRenderer.ReactTestRenderer;

  beforeEach(async () => {
    port = new Port(snapshotFor({}));
    port.outcome = {kind: 'UNCONFIRMED'};
    tree = mount(port);
    await sendDirection(tree, 'normal');
  });
  afterEach(() => act(() => tree.unmount()));

  it('says the outcome is unconfirmed, not that it failed', () => {
    expect(valueOf(tree, 'motor-direction-result')).toBe(
      ar.escDirection.unconfirmed,
    );
    expect(valueOf(tree, 'motor-direction-commanded')).toBe(
      ar.motorsScreen.directionCommandedUnconfirmed.replace(
        '{{target}}',
        ar.escDirection.normal,
      ),
    );
  });

  it('retries nothing on its own', () => {
    expect(port.directionCalls).toHaveLength(1);
  });

  it('creates no observation', () => {
    expect(valueOf(tree, 'motor-direction-observed')).toBe(
      ar.motorsScreen.directionObservedNone,
    );
  });
});

describe('27 - a rejected command leaves no evidence but is still reported', () => {
  it('shows the result and records nothing', async () => {
    const port = new Port(snapshotFor({}));
    port.outcome = {kind: 'REJECTED', reason: 'BUSY'};
    const tree = mount(port);
    await sendDirection(tree, 'normal');

    expect(has(tree, 'motor-direction-result')).toBe(true);
    expect(valueOf(tree, 'motor-direction-commanded')).toBe(
      ar.motorsScreen.directionCommandedNone,
    );
    expect(has(tree, 'motor-direction-verify')).toBe(false);
    expect(port.directionCalls).toHaveLength(1);
    act(() => tree.unmount());
  });
});

describe('30 - nothing in the direction surface can command a motor', () => {
  it('opens, reads, selects, closes and reselects with zero pulses', () => {
    const port = new Port(snapshotFor({receipt: receiptFor(1)}));
    const tree = mount(port);

    act(() => first(tree, 'motor-direction-details-toggle').props.onPress());
    act(() => first(tree, 'motor-direction-authoring-open').props.onPress());
    act(() => first(tree, 'esc-direction-reversed').props.onPress());
    act(() => first(tree, 'motor-direction-authoring-cancel').props.onPress());
    act(() => first(tree, 'motor-identity-M2').props.onPress());
    act(() => first(tree, 'motor-direction-authoring-open').props.onPress());

    expect(port.pulseCalls).toEqual([]);
    expect(port.stopCalls).toEqual([]);
    expect(port.directionCalls).toEqual([]);
    act(() => tree.unmount());
  });
});
