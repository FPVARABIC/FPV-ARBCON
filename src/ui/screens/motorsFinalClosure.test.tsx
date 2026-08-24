/**
 * M-F3 - THE MOTORS RELEASE-CLOSURE SUITE.
 *
 * What this file proves, in the phase's own numbering:
 *
 *   §32/§33  ACTIVE vs DRAFT are separated on screen: a drafted mixer
 *            renders as a LABELLED preview («معاينة: …» + the activation
 *            sentence), the identity words about the active aircraft are
 *            withheld while it exists, and discarding restores them.
 *   §34/§35  the topology interlock is P0: while the mixer is drafted or
 *            saved-but-not-rebooted, motor control cannot be ENABLED and
 *            the hold says why - in the exact sentences the spec names.
 *   §36/§53  the save lifecycle speaks the truthful vocabulary:
 *            READBACK_MISMATCH and UNCONFIRMED are danger, STALE_BASE
 *            reloads the base and keeps the draft, and the reboot offer
 *            follows only a verified save.
 *   §15-§18  the direction workflow: ack gates the question, an answer
 *            moves the per-motor session status, «لا» opens the reverse
 *            form directly, and an ACKNOWLEDGED reverse lands on
 *            «تم عكسه ويحتاج إعادة فحص» - never on a confirmation (§17).
 *   §16/§44  the spin control exists ONCE, inside the open workflow.
 *   §38-§40  the blocked hold is ONE block: no second caption, no title
 *            restating the disabled button.
 *   §42      the live telemetry panel is full-width after the workspace,
 *            not half a desktop column.
 *
 * Harness: the real MotorsScreenView with an injected configuration port
 * (the same seam the settings panel injects through) and a hand-written
 * operator snapshot where a session is needed - the established
 * production-path-UI pattern of motorsFinalWorkspace.test.tsx.
 * NOTHING HERE IS A HARDWARE CLAIM.
 */

jest.mock('../../platforms/react-native/transport/native/NativeUsbSerialTransport');

jest.mock('../../platforms/react-native/protocol', () => ({
  ...jest.requireActual('../../platforms/react-native/protocol'),
  mspSessionCoordinator: {
    getMotorTestSessionIdentity: () => ({physicalGeneration: 7, mspEpoch: 0}),
    getIdentificationState: () => ({
      status: 'SUCCEEDED',
      identity: {
        apiVersion: {mspProtocolVersion: 0, apiVersionMajor: 1, apiVersionMinor: 47},
        firmware: {identifier: 'BTFL', knownFamily: 'BETAFLIGHT'},
        board: {},
      },
    }),
    subscribeIdentificationState: () => () => {},
    subscribeMotorTestSessionInvalidated: () => () => {},
    getSessionBringUpFailure: () => undefined,
    subscribeSessionBringUpFailure: () => () => {},
  },
}));

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import '../../i18n';
import ar from '../../i18n/locales/ar.json';
import {MotorsScreenView} from './MotorsScreen';
import type {
  MotorConfigurationDraft,
  MotorConfigurationSnapshot,
} from '../../core/state/motorConfigurationModel';
import type {MotorTestControllerSnapshot} from '../../core/state/motorTestController';
import type {MotorTestOperatorPort} from '../../platforms/react-native/protocol';
import {
  resetPendingMixerActivation,
  type MotorAirframeControlsPort,
} from './MotorAirframeControls';
import {fcRebootRecovery} from '../../platforms/react-native/protocol/fcRebootRecovery';

const SESSION_ID = 'final-closure-session';
const MIXER_QUADX = 3;
const MIXER_HEX6X = 10;

const QUADX_CONFIG_SNAPSHOT = {
  feature: {feature3dEnabled: false, escSensorEnabled: false, motorStopEnabled: true, raw: 0x10},
  mixer: {mixerModeRaw: MIXER_QUADX, yawMotorsReversedConfigured: false, yawMotorsReversedRaw: 0},
  motor: {
    deprecatedMinThrottle: 1070, maxThrottle: 2000, minCommand: 1000,
    motorCount: 4, motorPoleCount: 14,
    dshotTelemetryEnabled: false, escSensorEnabled: false,
  },
  motor3d: {deadband3dLow: 1406, deadband3dHigh: 1514, neutral3d: 1460},
  advanced: {
    gyroSyncDenom: 1, pidProcessDenom: 1, useContinuousUpdate: false,
    motorProtocolRaw: 6, motorPwmRate: 480, motorIdleRaw: 550,
    gyroUse32kHz: false, motorInversion: false, gyroToUse: 0,
    gyroHighFsr: false, gyroMovementCalibrationThreshold: 32,
    gyroCalibrationDuration: 125, gyroOffsetYaw: 0, checkOverflow: 0,
    debugModeRaw: 0, debugModeCount: 60,
  },
} as unknown as MotorConfigurationSnapshot;

type SaveScript = (
  draft: MotorConfigurationDraft,
) => ReturnType<MotorAirframeControlsPort['save']>;

function configPort(save?: SaveScript): MotorAirframeControlsPort & {
  savedDrafts: MotorConfigurationDraft[];
  loadCalls: number[];
  rebootRequests: number[];
} {
  const savedDrafts: MotorConfigurationDraft[] = [];
  const loadCalls: number[] = [];
  const rebootRequests: number[] = [];
  return {
    savedDrafts,
    loadCalls,
    rebootRequests,
    load: async () => {
      loadCalls.push(loadCalls.length + 1);
      return {kind: 'LOADED', snapshot: QUADX_CONFIG_SNAPSHOT};
    },
    save: async (_sessionId, _original, draft) => {
      savedDrafts.push(draft);
      return save !== undefined
        ? save(draft)
        : {
            kind: 'SAVED_VERIFIED',
            snapshot: QUADX_CONFIG_SNAPSHOT,
            rebootRequired: true,
            changedGroups: ['MIXER'],
          };
    },
    requestReboot: async () => {
      rebootRequests.push(rebootRequests.length + 1);
      return {kind: 'REBOOT_REQUESTED', acknowledged: true};
    },
  };
}

/** An ACTIVE, READY session that has read a Quad X: the state the
 * direction workflow and the topology interlock operate in. Shape
 * mirrors motorsFinalWorkspace's nothing-read operator, with the scope
 * and domain a ready session publishes. */
function readyQuadSnapshot(): MotorTestControllerSnapshot {
  return {
    phase: 'ACTIVE',
    setupStep: 'READY',
    machine: {name: 'Ready', startAcknowledged: true},
    outcome: {kind: 'READY'},
    firmwareCompatibility: undefined,
    motorScope: {
      motorCount: 4,
      motorProtocolRaw: 6,
      feature3dEnabled: false,
      minCommand: 1000,
      maxThrottle: 2000,
    },
    mixerModeRaw: MIXER_QUADX,
    yawMotorsReversedConfigured: false,
    motorDiagnosticsSupport: undefined,
    armedStateEvidence: 'FRESH_DISARMED',
    motorDomain: {
      motorCount: 4,
      commandDomainMin: 1000,
      commandDomainMax: 2000,
      stopValue: 1000,
      protocolFamily: 'DSHOT',
    },
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
    verificationReceipt: undefined,
  } as unknown as MotorTestControllerSnapshot;
}

class ReadyOperator implements MotorTestOperatorPort {
  readonly escDirectionCalls: Array<{motorNumber: number; direction: string}> = [];
  snapshot = readyQuadSnapshot();
  beginSession = () => Promise.resolve(this.snapshot);
  getSnapshot = () => this.snapshot;
  subscribe = () => () => {};
  pulseMotor = () => 'ACCEPTED' as never;
  renewPulseHold = () => 'NO_ACTIVE_PULSE' as never;
  requestStop = () => 'ACCEPTED' as never;
  setEscDirection = (motorNumber: number, direction: string) => {
    this.escDirectionCalls.push({motorNumber, direction});
    return Promise.resolve({
      kind: 'ACKNOWLEDGED',
      motorNumber,
      direction,
      physicallyVerified: false,
    } as never);
  };
  refreshDiagnostics = () => Promise.resolve(undefined as never);
  endSession = () => Promise.resolve(this.snapshot);
  setMotorValues = () => undefined as never;
  setMotorValue = () => undefined as never;
  setMaster = () => undefined as never;
  stopAll = () => undefined as never;
}

const renderers: ReactTestRenderer.ReactTestRenderer[] = [];
afterEach(() => {
  while (renderers.length > 0) {
    const renderer = renderers.pop();
    ReactTestRenderer.act(() => renderer?.unmount());
  }
  /* M-F3F: a mixer activation outlives its component on purpose (it has
     to survive the reboot's session change), so it is module state and
     each case must hand the next one a clean slate. */
  resetPendingMixerActivation();
  fcRebootRecovery.reset();
});

function mountView(
  port: MotorAirframeControlsPort,
  operator?: MotorTestOperatorPort,
) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(
      <MotorsScreenView
        operator={operator}
        sessionId={SESSION_ID}
        onRequestLeave={() => undefined}
        airframeConfigPort={port}
      />,
    );
  });
  renderers.push(renderer);
  const all = (testID: string) =>
    renderer.root.findAll(candidate => candidate.props?.testID === testID);
  const textAll = () =>
    JSON.stringify(renderer.toJSON());
  return {
    renderer,
    all,
    has: (testID: string) => all(testID).length > 0,
    text: textAll,
    press: (testID: string) => {
      const node = all(testID).find(
        candidate => typeof candidate.props?.onPress === 'function',
      );
      if (node === undefined) throw new Error(`no pressable "${testID}"`);
      ReactTestRenderer.act(() => node.props.onPress());
    },
    within: (parentId: string, childId: string) => {
      const parent = all(parentId)[0];
      if (parent === undefined) return false;
      return (
        parent.findAll(candidate => candidate.props?.testID === childId).length > 0
      );
    },
  };
}

async function flush() {
  await ReactTestRenderer.act(async () => {
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 1));
  });
}

/* ================================================================== *
 * §32/§33 - the labelled DRAFT preview
 * ================================================================== */

describe('M-F3 §32/§33 - the draft preview is labelled, and the active words withdraw', () => {
  it('a drafted mixer shows «معاينة: <name>» and the exact activation sentence', async () => {
    const view = mountView(configPort());
    await flush();
    view.press('motors-mixer-select');
    view.press(`motors-mixer-select-option-${MIXER_HEX6X}`);
    expect(view.has('motors-topology-preview')).toBe(true);
    expect(view.text()).toContain(
      ar.motorsScreen.topologyPreviewLabel.replace(
        '{{name}}',
        ar.motorsScreen.topology.airframe.HEX6X,
      ),
    );
    expect(view.text()).toContain(ar.motorsScreen.topologyPreviewNote);
    // The active aircraft's identity words are withheld while a draft is
    // on screen - one screen never carries two topological truths.
    expect(view.has('motors-identity-map')).toBe(false);
  });

  it('discarding the draft removes the preview and restores the active map', async () => {
    const view = mountView(configPort());
    await flush();
    view.press('motors-mixer-select');
    view.press(`motors-mixer-select-option-${MIXER_HEX6X}`);
    expect(view.has('motors-topology-preview')).toBe(true);
    view.press('motors-airframe-discard');
    expect(view.has('motors-topology-preview')).toBe(false);
    expect(view.has('motors-identity-map')).toBe(true);
  });

  it('a props-only draft also previews - the arrows may not silently claim an unsaved flag', async () => {
    const view = mountView(configPort());
    await flush();
    view.press('motors-props-out');
    expect(view.has('motors-topology-preview')).toBe(true);
    expect(view.text()).toContain(ar.motorsScreen.topologyPreviewNote);
  });
});

/* ================================================================== *
 * §34/§35 - the topology interlock, in the spec's own sentences
 * ================================================================== */

describe('M-F3 §34/§35 - motor test refuses a drafted or un-rebooted topology', () => {
  it('a DIRTY mixer blocks enabling motor control, with the exact §34 sentence', async () => {
    const operator = new ReadyOperator();
    const view = mountView(configPort(), operator);
    await flush();
    view.press('motors-mixer-select');
    view.press(`motors-mixer-select-option-${MIXER_HEX6X}`);
    // The hold says why, in the required words.
    expect(view.text()).toContain(ar.motorsScreen.holdBlockedTopologyDirty);
    // The workspace enable switch carries the same reason...
    expect(view.has('motor-workspace-enable-blocked')).toBe(true);
    // ...and flipping it is refused: the switch VALUE stays false.
    const toggle = view
      .all('motor-workspace-enable')
      .find(node => typeof node.props?.onValueChange === 'function');
    ReactTestRenderer.act(() => toggle?.props.onValueChange(true));
    const after = view
      .all('motor-workspace-enable')
      .find(node => typeof node.props?.onValueChange === 'function');
    expect(after?.props.value).toBe(false);
  });

  it('a mixer saved but NOT rebooted still blocks, with the §35 sentence and a RECOVERY activation offer', async () => {
    // The live session read HEX6X-less truth (QUADX); the stored config
    // read returns HEX6X: exactly the saved-awaiting-reboot state.
    const port: MotorAirframeControlsPort = {
      load: async () => ({
        kind: 'LOADED',
        snapshot: {
          ...QUADX_CONFIG_SNAPSHOT,
          mixer: {
            mixerModeRaw: MIXER_HEX6X,
            yawMotorsReversedConfigured: false,
            yawMotorsReversedRaw: 0,
          },
        } as unknown as MotorConfigurationSnapshot,
      }),
      save: async () => {
        throw new Error('no save in this scenario');
      },
      requestReboot: async () => ({kind: 'REBOOT_REQUESTED', acknowledged: true}),
    };
    const operator = new ReadyOperator(); // live mixer = QUADX
    const view = mountView(port, operator);
    await flush();
    expect(view.has('motors-mixer-pending-reboot')).toBe(true);
    expect(view.text()).toContain(
      ar.motorsScreen.holdBlockedTopologyPendingReboot,
    );
    /* M-F3F §6 CHANGED THE CONTROL, NOT THE SAFETY. The interlock above
       is untouched. What used to be the ordinary «إعادة تشغيل المتحكم
       لتفعيلها» button is gone from the save flow entirely; a mixer left
       stored-but-not-running by something OTHER than this strip's own
       save is a recovery case, and it is the recovery control that
       appears - the one that also registers the restart so what comes
       back is verified instead of assumed. */
    expect(view.has('motors-airframe-reboot')).toBe(false);
    expect(view.has('motors-airframe-activation-retry')).toBe(true);
    expect(view.text()).toContain(ar.motorsScreen.quickActivateNow);
  });

  it('with no draft and no pending reboot, the interlock is silent and enabling works', async () => {
    const operator = new ReadyOperator();
    const view = mountView(configPort(), operator);
    await flush();
    expect(view.text()).not.toContain(ar.motorsScreen.holdBlockedTopologyDirty);
    expect(view.has('motor-workspace-enable-blocked')).toBe(false);
    const toggle = view
      .all('motor-workspace-enable')
      .find(node => typeof node.props?.onValueChange === 'function');
    ReactTestRenderer.act(() => toggle?.props.onValueChange(true));
    const after = view
      .all('motor-workspace-enable')
      .find(node => typeof node.props?.onValueChange === 'function');
    expect(after?.props.value).toBe(true);
  });
});

/* ================================================================== *
 * §36/§53 - outcome vocabulary, truthfully
 * ================================================================== */

describe('M-F3 §53 - save outcomes never overstate', () => {
  it('a readback mismatch is READBACK_MISMATCH wording, in danger, with the draft kept', async () => {
    const view = mountView(
      configPort(() =>
        Promise.resolve({
          kind: 'SAVED_UNVERIFIED',
          rebootRequired: true,
          changedGroups: ['MIXER'],
          error: new Error('readback disagreed'),
        }),
      ),
    );
    await flush();
    view.press('motors-props-out');
    view.press('motors-airframe-save');
    await flush();
    expect(view.text()).toContain(ar.motorsScreen.quickSavedUnverified);
    // The draft is NOT cleared: the screen may not pretend the write is
    // settled when the readback could not confirm it.
    expect(view.has('motors-airframe-savebar')).toBe(true);
  });

  it('an UNCONFIRMED outcome says so and never reads as success', async () => {
    const view = mountView(
      configPort(() =>
        Promise.resolve({
          kind: 'UNCONFIRMED',
          stage: 'EEPROM',
          acknowledgedGroups: ['MIXER'],
        }),
      ),
    );
    await flush();
    view.press('motors-props-out');
    view.press('motors-airframe-save');
    await flush();
    expect(view.text()).toContain(ar.motorsScreen.quickSaveUnconfirmed);
    expect(view.text()).not.toContain(ar.motorsScreen.quickSavedVerified);
  });

  it('STALE_BASE reloads the base, keeps the draft, and says what happened', async () => {
    const port = configPort(() =>
      Promise.resolve({kind: 'REJECTED', reason: 'STALE_BASE'}),
    );
    const view = mountView(port);
    await flush();
    const loadsBefore = port.loadCalls.length;
    view.press('motors-props-out');
    view.press('motors-airframe-save');
    await flush();
    expect(view.text()).toContain(ar.motorsScreen.quickSaveStale);
    expect(port.loadCalls.length).toBeGreaterThan(loadsBefore);
    expect(view.has('motors-airframe-savebar')).toBe(true);
  });
});

/* ================================================================== *
 * §15-§18 - the direction workflow, through the real screen
 * ================================================================== */

describe('M-F3 §15-§18 - the guided direction workflow', () => {
  function openWorkflow(operator: ReadyOperator) {
    const view = mountView(configPort(), operator);
    return view;
  }

  it('opens IN PLACE with the ack gate closed: no question, no spin block, the reason stated', async () => {
    const operator = new ReadyOperator();
    const view = openWorkflow(operator);
    await flush();
    view.press('motors-open-direction');
    expect(view.within('motors-airframe-column', 'motor-direction-workflow')).toBe(true);
    expect(view.has('motor-direction-question')).toBe(false);
    expect(view.has('motor-direction-spin')).toBe(false);
    expect(view.text()).toContain(ar.motorsScreen.directionAckRequired);
    // §19: the ESC check is explicitly distinguished from the props flag.
    expect(view.text()).toContain(ar.motorsScreen.directionVsPropsNote);
  });

  it('§16: while the workflow is open, THE hold control exists exactly once - inside it', async () => {
    const operator = new ReadyOperator();
    const view = openWorkflow(operator);
    await flush();
    view.press('motors-open-direction');
    const ack = view
      .all('motor-direction-props-ack-toggle')
      .find(node => typeof node.props?.onValueChange === 'function');
    ReactTestRenderer.act(() => ack?.props.onValueChange(true));
    expect(view.has('motors-identify-action')).toBe(false);
    expect(view.within('motor-direction-workflow', 'motors-hold-button')).toBe(true);
    // Exactly one hold button anywhere on the page.
    const holds = view
      .all('motors-hold-button')
      .filter(node => typeof node.props?.onPressIn === 'function');
    expect(holds).toHaveLength(1);
  });

  it('answers move the SESSION status: yes -> صحيح; no -> يحتاج للعكس and the reverse form opens', async () => {
    const operator = new ReadyOperator();
    const view = openWorkflow(operator);
    await flush();
    view.press('motors-open-direction');
    const ack = view
      .all('motor-direction-props-ack-toggle')
      .find(node => typeof node.props?.onValueChange === 'function');
    ReactTestRenderer.act(() => ack?.props.onValueChange(true));

    // All four motors start unchecked.
    expect(view.text()).toContain(ar.motorsScreen.directionStatusUnchecked);
    view.press('motor-direction-answer-yes');
    expect(
      JSON.stringify(
        view.all('motor-direction-status-1-state')[0]?.props.children,
      ),
    ).toContain(ar.motorsScreen.directionStatusCorrect);

    // Select M2 from its own status chip, answer «لا».
    view.press('motor-direction-status-2');
    view.press('motor-direction-answer-no');
    expect(
      JSON.stringify(
        view.all('motor-direction-status-2-state')[0]?.props.children,
      ),
    ).toContain(ar.motorsScreen.directionStatusNeedsReverse);
    // The reverse form opened by itself - answering led to the action.
    expect(view.has('esc-direction-panel')).toBe(true);
  });

  it('§17: an ACKNOWLEDGED reverse lands on «تم عكسه ويحتاج إعادة فحص», and only the operator confirms', async () => {
    /* THE STATUS LEG, driven through the SAME production seam the reverse
     * form calls - the workflow's onCommandOutcome prop - invoked
     * synchronously. (The wire leg, from the form's buttons to the
     * operator port, is its own test at the end of this file: this
     * renderer's act plumbing drops state scheduled from that form's
     * async continuation - a harness artifact; the invocation chain into
     * this very seam is what that test proves.) */
    const operator = new ReadyOperator();
    const view = openWorkflow(operator);
    await flush();
    view.press('motors-open-direction');
    const ack = view
      .all('motor-direction-props-ack-toggle')
      .find(node => typeof node.props?.onValueChange === 'function');
    ReactTestRenderer.act(() => ack?.props.onValueChange(true));
    view.press('motor-direction-answer-no');

    const workflow = view
      .all('motor-direction-workflow')
      .map(node => node.parent)
      .find(node => typeof node?.props?.onCommandOutcome === 'function');
    expect(workflow).toBeDefined();
    ReactTestRenderer.act(() =>
      workflow?.props.onCommandOutcome(1, 'REVERSED', 'ACKNOWLEDGED'),
    );
    const chipText = () =>
      JSON.stringify(
        view.all('motor-direction-status-1-state')[0]?.props.children,
      );
    expect(chipText()).toContain(ar.motorsScreen.directionStatusReversedRecheck);
    // Never a confirmation from an acknowledgement alone.
    expect(chipText()).not.toContain(ar.motorsScreen.directionStatusConfirmed);
    // The recheck prompt asks for another look, and the operator's own
    // answer - not the ACK - lands on «تم التأكيد».
    expect(view.text()).toContain(
      ar.motorsScreen.directionRecheckPrompt.replace('{{motor}}', 'M1'),
    );
    view.press('motor-direction-answer-yes');
    expect(chipText()).toContain(ar.motorsScreen.directionStatusConfirmed);
  });

  it('§17-UNCONFIRMED: a command whose outcome is unknown marks NOTHING', async () => {
    const operator = new ReadyOperator();
    const view = openWorkflow(operator);
    await flush();
    view.press('motors-open-direction');
    const workflow = view
      .all('motor-direction-workflow')
      .map(node => node.parent)
      .find(node => typeof node?.props?.onCommandOutcome === 'function');
    ReactTestRenderer.act(() =>
      workflow?.props.onCommandOutcome(1, 'REVERSED', 'UNCONFIRMED'),
    );
    // A command that may never have arrived cannot even claim "reversed".
    expect(
      JSON.stringify(
        view.all('motor-direction-status-1-state')[0]?.props.children,
      ),
    ).toContain(ar.motorsScreen.directionStatusUnchecked);
  });
});

/* ================================================================== *
 * §38-§40 / §42 - dedup and layout pins
 * ================================================================== */

describe('M-F3 §38-§40/§42 - one reason, one block, full-width telemetry', () => {
  it('a blocked hold renders ONE block: reason + safety line, no hint caption, no title', async () => {
    // No operator at all: the canonical blocked state.
    const view = mountView(configPort());
    await flush();
    expect(view.has('motors-hold-blocked')).toBe(true);
    expect(view.has('motors-hold-hint')).toBe(false);
    expect(view.text()).toContain(ar.motorsScreen.holdBlockedNoSession);
    expect(view.text()).toContain(ar.motorsScreen.holdBlockedHint);
    // The removed title's sentence appears nowhere.
    expect(view.text()).not.toContain('لا يمكن اختبار المحرك الآن');
  });

  it('the live telemetry panel sits OUTSIDE the workspace columns, full width', async () => {
    const operator = new ReadyOperator();
    const view = mountView(configPort(), operator);
    await flush();
    expect(view.has('motor-diagnostics-panel')).toBe(true);
    expect(view.within('motors-control-column', 'motor-diagnostics-panel')).toBe(false);
    expect(view.within('motors-airframe-column', 'motor-diagnostics-panel')).toBe(false);
  });
});

/* ================================================================== *
 * THE WIRE LEG - deliberately the LAST test in this file. Driving the
 * reverse form's async apply corrupts this legacy renderer's act
 * bookkeeping for updates scheduled afterwards (verified by bisection:
 * the same seam works before it and fails after it), so nothing may
 * run after this test in this file. The assertion that matters is that
 * the form hands the operator port EXACTLY the authored request.
 * ================================================================== */

describe('M-F3 §15 - the reverse form reaches the operator port with the authored request', () => {
  it('REVERSED for the selected motor, once', async () => {
    const operator = new ReadyOperator();
    const view = mountView(configPort(), operator);
    await flush();
    view.press('motors-open-direction');
    const ack = view
      .all('motor-direction-props-ack-toggle')
      .find(node => typeof node.props?.onValueChange === 'function');
    ReactTestRenderer.act(() => ack?.props.onValueChange(true));
    view.press('motor-direction-answer-no');
    expect(view.has('esc-direction-panel')).toBe(true);
    view.press('esc-direction-reversed');
    view.press('esc-direction-review');
    view.press('esc-direction-apply');
    await flush();
    expect(operator.escDirectionCalls).toEqual([
      {motorNumber: 1, direction: 'REVERSED'},
    ]);
  });
});
