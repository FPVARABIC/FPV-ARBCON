/**
 * M-F3F P0-A - ONE CLICK ON «حفظ التغييرات» ACTIVATES THE AIRFRAME.
 *
 * =====================================================================
 * THE DEFECT THIS FILE EXISTS TO PIN DOWN
 * =====================================================================
 *
 * Reported from use: choosing Y6, pressing Save, and being told the save
 * was verified - and then having to find and press a SECOND control
 * before the aircraft chosen was the aircraft the firmware was mixing
 * for. A configuration that is stored but not governing is not a
 * finished action, and the operator had no way to know that except by
 * reading the small print.
 *
 * The pinned Betaflight Configurator's own Motors tab does not work that
 * way: `const handleSave = (reboot = true)` (MotorsTab.vue:1397) writes
 * MSP_SET_MIXER_CONFIG and then calls saveAndReboot(), which reboots the
 * board and drives the reconnect itself. The application owns the whole
 * lifecycle. This file asserts that ours now does too, and - just as
 * importantly - that it never claims more than it has proved.
 *
 * =====================================================================
 * WHAT IS ASSERTED, AND WHY IT IS NOT CIRCULAR
 * =====================================================================
 *
 * The board is a MODEL WITH A MEMORY, not a stub that echoes: it holds a
 * mixer, refuses to change it except through a restart, and reports a
 * DIFFERENT session id afterwards - so "the new mixer is active" can only
 * become true by the restart actually happening. Every failure case is a
 * board that behaves differently, never a component told to pretend.
 *
 *   §3   the restart goes through the app's ONE reboot lifecycle
 *        (fcRebootRecovery), armed BEFORE the command, with the reason
 *        that lifecycle records for a mixer save.
 *   §5   an ACK is not activation, an EEPROM commit is not activation,
 *        and a completed reboot is not activation. «تم تفعيل …» requires
 *        the board, on a NEW session, to report the requested mixer AND
 *        a runtime motor count.
 *   §6   the manual reboot control is GONE from the successful path.
 *   §7   a reconnect that fails is said out loud, with a retry - and the
 *        mixer write is never sent twice.
 *   §8   the motor-test interlock holds across save, restart, reconnect
 *        and verification.
 *
 * NOTHING HERE IS A HARDWARE CLAIM. The board is a model.
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
import {Text} from 'react-native';
import ReactTestRenderer from 'react-test-renderer';

import '../../i18n';
import ar from '../../i18n/locales/ar.json';
import {MotorsScreenView} from './MotorsScreen';
import {
  resetPendingMixerActivation,
  type MotorAirframeControlsPort,
} from './MotorAirframeControls';
import {fcRebootRecovery} from '../../platforms/react-native/protocol/fcRebootRecovery';
import type {
  MotorConfigurationDraft,
  MotorConfigurationSnapshot,
} from '../../core/state/motorConfigurationModel';
import type {
  MotorRebootOutcome,
  MotorTestOperatorPort,
} from '../../platforms/react-native/protocol';
import type {MotorTestControllerSnapshot} from '../../core/state/motorTestController';

const SESSION_BEFORE = 'activation-session-before';
const SESSION_AFTER = 'activation-session-after';

/** Betaflight mixerMode_e, from the pinned firmware's mixer.h. */
const MIXER_QUADX = 3;
const MIXER_Y6 = 6;

function snapshotWith(
  mixerModeRaw: number,
  motorCount: number | undefined,
): MotorConfigurationSnapshot {
  return {
    feature: {
      feature3dEnabled: false,
      escSensorEnabled: false,
      motorStopEnabled: true,
      raw: 0x10,
    },
    mixer: {
      mixerModeRaw,
      yawMotorsReversedConfigured: false,
      yawMotorsReversedRaw: 0,
    },
    motor: {
      deprecatedMinThrottle: 1070,
      maxThrottle: 2000,
      minCommand: 1000,
      motorCount,
      motorPoleCount: 14,
      dshotTelemetryEnabled: false,
      escSensorEnabled: false,
    },
    motor3d: {deadband3dLow: 1406, deadband3dHigh: 1514, neutral3d: 1460},
    advanced: {
      gyroSyncDenom: 1,
      pidProcessDenom: 1,
      useContinuousUpdate: false,
      motorProtocolRaw: 6,
      motorPwmRate: 480,
      motorIdleRaw: 550,
      gyroUse32kHz: false,
      motorInversion: false,
      gyroToUse: 0,
      gyroHighFsr: false,
      gyroMovementCalibrationThreshold: 32,
      gyroCalibrationDuration: 125,
      gyroOffsetYaw: 0,
      checkOverflow: 0,
      debugModeRaw: 0,
      debugModeCount: 60,
    },
  } as unknown as MotorConfigurationSnapshot;
}

/**
 * A BOARD THAT ONLY CHANGES SHAPE WHEN IT RESTARTS.
 *
 * `stored` is what a save writes and a load reads back - EEPROM. `active`
 * is what the running firmware is mixing for, and it moves to `stored`
 * only inside `restart()`, exactly as mixerInit() at boot is the only
 * thing that reads the stored mixer into the running one. A component
 * that skipped the restart could therefore never make this board report
 * the new airframe, however many acknowledgements it collected.
 */
function boardModel(
  options: {
    /** What the restart does, if anything. */
    restart?: 'APPLIES' | 'REFUSED' | 'NO_EFFECT';
    /** Motor count reported AFTER the restart. */
    countAfterRestart?: number | undefined;
  } = {},
) {
  const behaviour = options.restart ?? 'APPLIES';
  let stored = MIXER_QUADX;
  let active = MIXER_QUADX;
  let count: number | undefined = 4;
  const saves: MotorConfigurationDraft[] = [];
  const rebootRequests: string[] = [];
  const loads: string[] = [];
  const port: MotorAirframeControlsPort = {
    load: async sessionId => {
      loads.push(sessionId);
      return {kind: 'LOADED', snapshot: snapshotWith(active, count)};
    },
    save: async (_sessionId, _original, draft) => {
      saves.push(draft);
      if (draft.mixerModeRaw !== undefined) stored = draft.mixerModeRaw;
      /* The readback a real transaction performs reads EEPROM, so the
         SAVED snapshot carries the stored value - and the running mixer
         is untouched. This is the whole reason a restart is needed. */
      return {
        kind: 'SAVED_VERIFIED',
        snapshot: snapshotWith(stored, count),
        rebootRequired: true,
        changedGroups: ['MIXER'],
      };
    },
    requestReboot: async (sessionId): Promise<MotorRebootOutcome> => {
      rebootRequests.push(sessionId);
      if (behaviour === 'REFUSED') {
        return {kind: 'REJECTED', reason: 'FC_ARMED'} as MotorRebootOutcome;
      }
      return {kind: 'REBOOT_REQUESTED', acknowledged: true};
    },
  };
  return {
    port,
    saves,
    rebootRequests,
    loads,
    /** The board actually restarting - what the operator's power cycle
     *  does, modelled explicitly so no test can skip it by accident. */
    restart: () => {
      if (behaviour === 'APPLIES') {
        active = stored;
        /* `in`, not `??`: the whole point of one case is a board that
           reports NO motor count after the restart, and `??` would read
           that as "unspecified" and keep the old one. */
        if ('countAfterRestart' in options) {
          count = options.countAfterRestart;
        }
      }
    },
    activeMixer: () => active,
  };
}

/**
 * A READY session that has read the board - the state the motor-test
 * interlock actually operates in.
 *
 * It exists so §8 can be asserted where it matters: the enable control
 * only renders once a session is present, so an interlock claim made
 * without one would be a claim about a control that is not there.
 */
function readyOperator(mixerModeRaw: number, motorCount: number): MotorTestOperatorPort {
  const snapshot = {
    phase: 'ACTIVE',
    setupStep: 'READY',
    machine: {name: 'Ready', startAcknowledged: true},
    outcome: {kind: 'READY'},
    firmwareCompatibility: undefined,
    motorScope: {
      motorCount,
      motorProtocolRaw: 6,
      feature3dEnabled: false,
      minCommand: 1000,
      maxThrottle: 2000,
    },
    mixerModeRaw,
    yawMotorsReversedConfigured: false,
    motorDiagnosticsSupport: undefined,
    armedStateEvidence: 'FRESH_DISARMED',
    motorDomain: {
      motorCount,
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
  return {
    beginSession: () => Promise.resolve(snapshot),
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    pulseMotor: () => 'ACCEPTED' as never,
    renewPulseHold: () => 'NO_ACTIVE_PULSE' as never,
    requestStop: () => 'ACCEPTED' as never,
    /* Turning motor control OFF calls this. It is on the port because
       withdrawing permission must always be able to stop. */
    stopAll: () => 'ACCEPTED' as never,
    setEscDirection: () => Promise.resolve(undefined as never),
    refreshDiagnostics: () => Promise.resolve(undefined as never),
    endSession: () => Promise.resolve(snapshot),
  } as unknown as MotorTestOperatorPort;
}

const renderers: ReactTestRenderer.ReactTestRenderer[] = [];
afterEach(() => {
  while (renderers.length > 0) {
    const renderer = renderers.pop();
    ReactTestRenderer.act(() => renderer?.unmount());
  }
  /* The activation record and the reboot lifecycle are BOTH module state,
     deliberately - an activation has to survive the session change that
     is the reboot. Each case hands the next one a clean slate. */
  resetPendingMixerActivation();
  fcRebootRecovery.reset();
});

function mountView(
  port: MotorAirframeControlsPort,
  operator?: MotorTestOperatorPort,
) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  const element = (sessionId: string, live?: MotorTestOperatorPort) => (
    <MotorsScreenView
      operator={live}
      sessionId={sessionId}
      onRequestLeave={() => undefined}
      airframeConfigPort={port}
    />
  );
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(element(SESSION_BEFORE, operator));
  });
  renderers.push(renderer);
  const all = (testID: string) =>
    renderer.root.findAll(candidate => candidate.props?.testID === testID);
  return {
    has: (testID: string) => all(testID).length > 0,
    /* Text nodes only. A whole-tree JSON dump would "contain" any
       string that happened to be a style value, and would bury a real
       failure under a hundred kilobytes of props. */
    text: () =>
      renderer.root
        .findAllByType(Text)
        .map(node => {
          const value = node.props.children;
          return Array.isArray(value) ? value.join('') : String(value ?? '');
        })
        .join('\n'),
    press: (testID: string) => {
      const node = all(testID).find(
        candidate => typeof candidate.props?.onPress === 'function',
      );
      if (node === undefined) throw new Error(`no pressable "${testID}"`);
      ReactTestRenderer.act(() => node.props.onPress());
    },
    /**
     * TRY TO TURN MOTOR CONTROL ON, AND REPORT WHETHER IT WENT ON.
     *
     * The point of §8 is not that a sentence appears - it is that the
     * control REFUSES. A test that only read the sentence would pass
     * against a build whose interlock had been removed and whose caption
     * had been left behind, so this drives the real handler and reads the
     * real switch value back.
     */
    tryEnable: (): boolean => {
      const before = all('motor-workspace-enable').find(
        candidate => typeof candidate.props?.onValueChange === 'function',
      );
      if (before === undefined) return false;
      ReactTestRenderer.act(() => before.props.onValueChange(true));
      const after = all('motor-workspace-enable').find(
        candidate => typeof candidate.props?.onValueChange === 'function',
      );
      return after?.props.value === true;
    },
    /** Withdraw permission again. Turning motor control OFF is never
     *  blocked - that is its own safety rule - so this always works. */
    disable: () => {
      const node = all('motor-workspace-enable').find(
        candidate => typeof candidate.props?.onValueChange === 'function',
      );
      if (node !== undefined) {
        ReactTestRenderer.act(() => node.props.onValueChange(false));
      }
    },
    /** The new connection the reconnect produces: a DIFFERENT session id,
     *  which is what makes the verification non-trivial. */
    reconnectAs: (sessionId: string, live?: MotorTestOperatorPort) => {
      ReactTestRenderer.act(() => renderer.update(element(sessionId, live)));
    },
    /** The link dying, with no session anywhere - what the seconds
     *  between the restart and the reconnect actually look like. */
    linkDown: () => {
      ReactTestRenderer.act(() => renderer.update(element(SESSION_BEFORE)));
    },
  };
}

async function flush() {
  await ReactTestRenderer.act(async () => {
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 1));
  });
}

/**
 * The exact «تم تفعيل …» sentence, built the way the strip builds it.
 *
 * A bare `not.toContain('تم تفعيل')` would be wrong: the count-unknown
 * sentence legitimately begins with those words - the mixer IS active,
 * the count is what is missing - so the negative has to name the whole
 * claim, not a prefix of it.
 */
const ACTIVATED_Y6 = ar.motorsScreen.quickActivated.replace(
  '{{name}}',
  ar.motorsScreen.topology.airframe.Y6,
);

/** Draft Y6 and press Save - the operator's single click. */
function chooseY6AndSave(view: ReturnType<typeof mountView>) {
  view.press('motors-mixer-select');
  view.press(`motors-mixer-select-option-${MIXER_Y6}`);
  view.press('motors-airframe-save');
}

describe('M-F3F P0-A - the mixer save runs the whole restart itself', () => {
  it('one click reaches «تم تفعيل …» through restart, reconnect and a re-read - and asks for nothing else', async () => {
    const board = boardModel();
    const view = mountView(board.port);
    await flush();

    chooseY6AndSave(view);
    await flush();

    // The transaction ran exactly once, carrying the drafted mixer.
    expect(board.saves).toHaveLength(1);
    expect(board.saves[0].mixerModeRaw).toBe(MIXER_Y6);

    /* §3 - the app's ONE lifecycle is armed, for this session, with the
       reason it records for a mixer save. Not a second reboot system. */
    const armed = fcRebootRecovery.getPhase();
    expect(armed.kind).toBe('EXPECTED');
    expect(armed.kind === 'EXPECTED' ? armed.sessionId : undefined).toBe(
      SESSION_BEFORE,
    );
    expect(armed.kind === 'EXPECTED' ? armed.reason : undefined).toBe(
      'MIXER_SAVE',
    );
    // The restart was requested, once, on that same session.
    expect(board.rebootRequests).toEqual([SESSION_BEFORE]);

    // §6 - and the operator is asked for NOTHING. No manual reboot.
    expect(view.has('motors-airframe-reboot')).toBe(false);
    expect(view.has('motors-airframe-restarting')).toBe(true);
    expect(view.text()).toContain(ar.motorsScreen.quickRestarting);
    // §5 - nothing calls this activated yet.
    expect(view.text()).not.toContain(ACTIVATED_Y6);

    // The link drops, exactly as predicted, and the board restarts.
    ReactTestRenderer.act(() => {
      fcRebootRecovery.noteSessionLost(SESSION_BEFORE);
    });
    board.restart();
    expect(view.has('motors-airframe-reconnecting')).toBe(true);
    expect(view.text()).toContain(ar.motorsScreen.quickReconnecting);
    expect(view.text()).not.toContain(ACTIVATED_Y6);

    // The board comes back as a new session and the strip re-reads it.
    view.reconnectAs(SESSION_AFTER);
    await flush();

    /* §5 - THE CLAIM, EARNED. The board reports Y6 on a session the write
       never happened on, with a runtime motor count. */
    expect(board.activeMixer()).toBe(MIXER_Y6);
    expect(view.text()).toContain(ACTIVATED_Y6);
    expect(view.has('motors-airframe-restarting')).toBe(false);
    expect(view.has('motors-airframe-reconnecting')).toBe(false);
    // §7 - and the mixer was written exactly once, start to finish.
    expect(board.saves).toHaveLength(1);
    expect(board.rebootRequests).toHaveLength(1);
    // §6 - still no manual reboot control anywhere in the flow.
    expect(view.has('motors-airframe-reboot')).toBe(false);
  });

  it('a reboot that never comes back says so, offers a reconnect retry, and NEVER rewrites the mixer', async () => {
    const board = boardModel();
    const view = mountView(board.port);
    await flush();
    chooseY6AndSave(view);
    await flush();

    ReactTestRenderer.act(() => {
      fcRebootRecovery.noteSessionLost(SESSION_BEFORE);
    });
    // The device came back and would not open: the lifecycle's own
    // terminal verdict, reached the way the root's driver reaches it.
    ReactTestRenderer.act(() => {
      fcRebootRecovery.noteReopenFailed();
    });

    // §7 - one sentence, both facts, and a way forward.
    expect(view.text()).toContain(ar.motorsScreen.quickActivationNoLink);
    expect(view.has('motors-airframe-activation-retry')).toBe(true);
    expect(view.text()).toContain(ar.motorsScreen.quickActivationRetry);
    // No indefinite spinner: the transient phases are gone.
    expect(view.has('motors-airframe-reconnecting')).toBe(false);
    expect(view.has('motors-airframe-verifying')).toBe(false);
    // §5 - and nothing was activated.
    expect(view.text()).not.toContain(ACTIVATED_Y6);

    // §7 - pressing the retry looks for the board again. It does NOT
    // resend the configuration and it does NOT reboot anything again.
    view.press('motors-airframe-activation-retry');
    expect(board.saves).toHaveLength(1);
    expect(board.rebootRequests).toHaveLength(1);
    expect(fcRebootRecovery.getPhase().kind).toBe('WAITING_FOR_LINK');

    // And when the board does come back, the activation is still judged.
    board.restart();
    view.reconnectAs(SESSION_AFTER);
    await flush();
    expect(view.text()).toContain(ACTIVATED_Y6);
    expect(board.saves).toHaveLength(1);
  });

  it('a board that comes back reporting the OLD airframe is a mismatch, never an activation', async () => {
    // The restart happens and changes nothing - a firmware that rejected
    // the mixer, or an EEPROM that did not take.
    const board = boardModel({restart: 'NO_EFFECT'});
    const view = mountView(board.port);
    await flush();
    chooseY6AndSave(view);
    await flush();

    ReactTestRenderer.act(() => {
      fcRebootRecovery.noteSessionLost(SESSION_BEFORE);
    });
    board.restart();
    view.reconnectAs(SESSION_AFTER);
    await flush();

    expect(board.activeMixer()).toBe(MIXER_QUADX);
    expect(view.text()).toContain(ar.motorsScreen.quickActivationMismatch);
    expect(view.text()).not.toContain(ACTIVATED_Y6);
    // The save is not retried on a mismatch: it succeeded, and repeating
    // an EEPROM commit that worked is not a recovery.
    expect(board.saves).toHaveLength(1);
  });

  it('a board that comes back with no runtime motor count is not a finished activation', async () => {
    const board = boardModel({countAfterRestart: undefined});
    const view = mountView(board.port);
    await flush();
    chooseY6AndSave(view);
    await flush();
    ReactTestRenderer.act(() => {
      fcRebootRecovery.noteSessionLost(SESSION_BEFORE);
    });
    board.restart();
    view.reconnectAs(SESSION_AFTER);
    await flush();

    /* The mixer matches. The count does not exist. §5 says both had to
       survive, so this is NOT «تم تفعيل …» - and §8 keeps motor test
       shut, because the count it would command with is unknown. */
    expect(board.activeMixer()).toBe(MIXER_Y6);
    expect(view.text()).toContain(ar.motorsScreen.quickActivationCountUnknown);
    expect(view.text()).not.toContain(ACTIVATED_Y6);
  });

  it('a board that refuses the restart keeps the saved value, says why, and offers ONE retry', async () => {
    const board = boardModel({restart: 'REFUSED'});
    const view = mountView(board.port);
    await flush();
    chooseY6AndSave(view);
    await flush();

    expect(board.saves).toHaveLength(1);
    expect(board.rebootRequests).toHaveLength(1);
    expect(view.text()).toContain(ar.motorsScreen.quickRestartRejected);
    // The expectation is stood down: nothing is going to drop, so the app
    // must not sit waiting for a reconnect that cannot happen.
    expect(fcRebootRecovery.getPhase().kind).toBe('IDLE');
    // Recovery, not a normal second step - and it does not rewrite.
    expect(view.has('motors-airframe-activation-retry')).toBe(true);
    expect(view.has('motors-airframe-reboot')).toBe(false);
    view.press('motors-airframe-activation-retry');
    await flush();
    expect(board.saves).toHaveLength(1);
    expect(board.rebootRequests).toHaveLength(2);
  });
});

describe('M-F3F §8 - motor test stays shut for the whole activation', () => {
  it('the interlock holds from the save through the restart, the dead link and the re-read', async () => {
    const board = boardModel();
    const view = mountView(board.port, readyOperator(MIXER_QUADX, 4));
    await flush();

    // Before anything is drafted the interlock is silent - and motor
    // control can actually be enabled, so the refusals below mean
    // something. (Put back off again: nothing else here needs it on.)
    expect(view.has('motor-workspace-enable-blocked')).toBe(false);
    expect(view.tryEnable()).toBe(true);
    view.disable();

    view.press('motors-mixer-select');
    view.press(`motors-mixer-select-option-${MIXER_Y6}`);
    // DIRTY: refused, with the reason in words.
    expect(view.tryEnable()).toBe(false);
    expect(view.has('motor-workspace-enable-blocked')).toBe(true);

    view.press('motors-airframe-save');
    await flush();
    /* SAVED AND RESTARTING - and the draft is gone, so the old rule that
       compared a draft against the stored value no longer blocks. */
    expect(view.has('motors-airframe-restarting')).toBe(true);
    expect(view.tryEnable()).toBe(false);

    /* The link goes, and with it the session: there is no enable control
       to block while nothing is connected, which is why the claim below
       is made at the moment one exists again. */
    ReactTestRenderer.act(() => {
      fcRebootRecovery.noteSessionLost(SESSION_BEFORE);
    });
    view.linkDown();

    /* THE WINDOW THE OLD RULE COULD NOT SEE. The board is back, a live
       session exists, and the strip has NOT re-read it yet. Both of the
       old conditions are false here - the draft is gone, and the live
       session's mixer already matches the stored one - so this is exactly
       where motor test used to become enableable on an aircraft nobody
       had verified. */
    board.restart();
    view.reconnectAs(SESSION_AFTER, readyOperator(MIXER_Y6, 6));
    expect(view.tryEnable()).toBe(false);
    expect(view.has('motor-workspace-enable-blocked')).toBe(true);
    expect(view.text()).toContain(
      ar.motorsScreen.holdBlockedTopologyActivating,
    );

    await flush();

    // Verified: the aircraft on screen is the aircraft being mixed for,
    // and only now does the interlock release.
    expect(view.text()).toContain(ACTIVATED_Y6);
    expect(view.has('motor-workspace-enable-blocked')).toBe(false);
    expect(view.tryEnable()).toBe(true);
  });

  it('an activation that ends with no runtime motor count leaves the interlock shut', async () => {
    const board = boardModel({countAfterRestart: undefined});
    const view = mountView(board.port, readyOperator(MIXER_QUADX, 4));
    await flush();
    chooseY6AndSave(view);
    await flush();
    ReactTestRenderer.act(() => {
      fcRebootRecovery.noteSessionLost(SESSION_BEFORE);
    });
    board.restart();
    view.reconnectAs(SESSION_AFTER, readyOperator(MIXER_Y6, 6));
    await flush();

    expect(view.text()).toContain(ar.motorsScreen.quickActivationCountUnknown);
    expect(view.has('motor-workspace-enable-blocked')).toBe(true);
    expect(view.tryEnable()).toBe(false);
  });
});
