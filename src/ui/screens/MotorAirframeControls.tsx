/**
 * M-F3 - THE AIRFRAME'S OWN CONTROL STRIP: MIXER, PROPS DIRECTION, THE
 * SAVE LIFECYCLE, AND THE TWO PRIMARY MOTOR TOOLS.
 *
 * WHAT THIS IS FOR. The things a pilot reaches for around the aircraft
 * drawing - which airframe this is, which way the propellers are built,
 * the motor-direction workflow, the output-reorder workflow - live in
 * one compact strip directly under the model.
 *
 * THE DRAFT MODEL - M-F3 §3-§7, and the P0-1 root cause. The M-F2 strip
 * bound its chips to the SAVED value and hung a detached confirm dialog
 * off every tap, so tapping «للخارج» visibly changed nothing. Now a tap
 * IS a draft edit: the control moves immediately, a save bar appears
 * («لديك تغييرات غير محفوظة») naming exactly what changed, and nothing
 * touches the link until «حفظ التغييرات». Both fields accumulate into
 * ONE draft and save in ONE transaction, so changing mixer and props
 * together costs one verified write cycle.
 *
 * WHAT THIS IS NOT. It is not a second write path. Saving goes through
 * the SAME MotorConfigurationController transaction the full settings
 * panel uses: fresh re-read under the exclusive lease, stale-base
 * comparison, armed preflight, changed-groups-only writes, EEPROM
 * commit, readback. The draft is applied to a base built from the
 * CURRENT snapshot, so an untouched field always carries the live value
 * and can never be clobbered by a stale one.
 *
 * THE SAVE LIFECYCLE SPEAKS §53's VOCABULARY, truthfully: a dirty draft
 * is DIRTY; while the transaction runs it is APPLYING; SAVED_VERIFIED
 * (write + EEPROM + readback match) is PERSISTED_VERIFIED; a readback
 * that fails or disagrees is READBACK_MISMATCH, never success. No ACK is
 * ever called "applied".
 *
 * M-F3F P0-A - ONE CLICK, THE WHOLE WAY. A saved mixer is still not the
 * ACTIVE mixer, because mixerInit() runs at boot. The strip used to stop
 * there and hand the operator a second button; it does not any more. A
 * verified mixer save continues by itself: restart -> the link drops as
 * predicted -> the app's one reboot lifecycle brings the board back ->
 * the strip re-reads it -> and only if BOTH the mixer and the runtime
 * motor count come back as the ones asked for does it say «تم تفعيل …».
 * A manual control exists solely for recovery, when one of those steps
 * actually failed. A props-only save keeps the old offer, because the
 * firmware does not need a restart for it (§9).
 *
 * NOTHING HERE IS A PHYSICAL CLAIM. The props control edits the stored
 * yaw_motors_reversed flag; whether any propeller is actually mounted
 * that way is only establishable by the person standing at the aircraft.
 */

import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useTranslation} from 'react-i18next';

import {
  BETAFLIGHT_MIXER_REFERENCE_V147,
} from '../../core/firmware-adapters/betaflightMixerReferenceV147';
import {
  createMotorConfigurationDraft,
  type MotorConfigurationDraft,
  type MotorConfigurationSnapshot,
} from '../../core/state/motorConfigurationModel';
import {fcRebootRecovery} from '../../platforms/react-native/protocol/fcRebootRecovery';
import {observedAirframeTruth} from '../../core/state/observedAirframeTruth';
import {connectionNotice} from '../session/connectionNotice';
import {
  motorConfigurationController,
  type MotorConfigurationLoadOutcome,
  type MotorConfigurationSaveOutcome,
  type MotorRebootOutcome,
} from '../../platforms/react-native/protocol';
import {MIN_TOUCH_TARGET} from '../components/controls';
import {SelectField} from '../components/controls/SelectField';
import {Icon} from '../icons';
import {PROSE_MEASURE, colors, radii, spacing, typography} from '../theme';

/** The same port shape the full settings panel injects, plus the
 * explicit reboot step of the §36 lifecycle. */
export interface MotorAirframeControlsPort {
  load(sessionId: string): Promise<MotorConfigurationLoadOutcome>;
  save(
    sessionId: string,
    original: MotorConfigurationSnapshot,
    draft: MotorConfigurationDraft,
  ): Promise<MotorConfigurationSaveOutcome>;
  requestReboot(sessionId: string): Promise<MotorRebootOutcome>;
}

/** What the strip learned from the configuration read, reported up so
 * the aircraft can render BEFORE any motor-test session exists. Values
 * are the flight controller's stored configuration, read through the
 * verified transaction - never invented. */
export interface AirframeConfigTopology {
  readonly mixerModeRaw: number;
  readonly yawMotorsReversed: boolean;
  readonly motorCount: number;
}

/**
 * The strip's edit state, reported up on every change - M-F3 §32/§33/§34.
 *
 * The screen needs it for two things it owns: drawing the DRAFT preview
 * (labelled «معاينة», never presented as the active aircraft) and the
 * motor-test topology interlock (a dirty or saved-but-not-rebooted mixer
 * must not be motor-tested as if it were active).
 */
export interface AirframeEditState {
  /** The mixer draft differs from the stored configuration. */
  readonly dirtyMixer: boolean;
  /** The props-flag draft differs from the stored configuration. */
  readonly dirtyProps: boolean;
  /** The draft mixer id, ONLY while dirtyMixer. */
  readonly draftMixerModeRaw: number | undefined;
  /** The draft props flag, ONLY while dirtyProps. */
  readonly draftYawMotorsReversed: boolean | undefined;
  /** Stored mixer differs from what the live session read at bring-up:
   * saved, verified, and waiting for the reboot to govern. */
  readonly mixerPendingReboot: boolean;
  readonly propsPendingReboot: boolean;
  /**
   * M-F3F §8 - A MIXER ACTIVATION IS IN FLIGHT.
   *
   * True from the moment a mixer save is committed until the board has
   * come back and BOTH post-restart facts have been re-read and checked:
   * the mixer it now reports, and the runtime motor count it now reports.
   * It spans the restart, the dropped link and the reconnect, none of
   * which `mixerPendingReboot` can see - that flag compares against a
   * live session's read, and during those seconds there is no session.
   *
   * The motor-test interlock consumes it, so «تشغيل المحركات» cannot be
   * enabled anywhere inside the window where the aircraft on screen and
   * the aircraft the firmware is mixing for may differ.
   */
  readonly mixerActivationInFlight: boolean;
}

export interface MotorAirframeControlsProps {
  readonly sessionId: string | undefined;
  /** The LIVE session's values, when a session has read them. They name
   * what the running firmware is actually flying with - the strip's
   * pending-reboot notes compare against them. */
  readonly liveMixerModeRaw: number | undefined;
  readonly liveYawMotorsReversed: boolean | undefined;
  /** True while a motor may be live or a hold is owned - every write
   * control in the strip locks, exactly like the settings panel's own
   * busy interlock in the other direction. */
  readonly writesLocked: boolean;
  readonly onTopology: (topology: AirframeConfigTopology | undefined) => void;
  readonly onEditState?: (state: AirframeEditState) => void;
  readonly onBusyChange?: (busy: boolean) => void;
  /** The two primary tools this strip opens. Rendering them is the
   * screen's job; this strip only owns the entry buttons' state. */
  readonly directionOpen: boolean;
  readonly reorderOpen: boolean;
  readonly onToggleDirection: () => void;
  readonly onToggleReorder: () => void;
  readonly controller?: MotorAirframeControlsPort;
}

interface AirframeDraft {
  readonly mixerModeRaw?: number;
  readonly yawMotorsReversed?: boolean;
}

/**
 * M-F3F: the mixer save now owns the whole restart.
 *
 * RESTARTING  the reboot command has gone out and the link is expected
 *             to drop.
 * RECONNECTING the app is re-enumerating and reopening the board - driven
 *             by the root's useRebootReconnect, not by this component.
 * VERIFYING   a new session exists and the board is being re-read.
 *
 * SAVING and REBOOTING remain what they were, so a props-only save (which
 * the source does not require a reboot for) is unchanged.
 */
type EditPhase =
  | 'IDLE'
  | 'SAVING'
  | 'REBOOTING'
  | 'RESTARTING'
  | 'RECONNECTING'
  | 'VERIFYING';

/**
 * A MIXER ACTIVATION THAT IS STILL IN FLIGHT ACROSS A REBOOT.
 *
 * MODULE SCOPE ON PURPOSE. The restart destroys the session, and this
 * component resets all of its state when the sessionId changes - which is
 * correct for every other purpose and fatal for this one. The requested
 * mixer has to outlive that reset to be checked against what the board
 * reports when it comes back, so it lives beside the component rather
 * than inside it. One record: a second activation replaces the first.
 */
interface PendingMixerActivation {
  readonly requestedMixerModeRaw: number;
  /** The session the write happened on. A readback on THAT session proves
   *  nothing about the restart, so verification requires a different one. */
  readonly writtenOnSessionId: string;
}
let pendingMixerActivation: PendingMixerActivation | undefined;

/** Test seam: clears the cross-session record between cases. */
export function resetPendingMixerActivation(): void {
  pendingMixerActivation = undefined;
}

/**
 * WHAT THE OPERATOR MAY RETRY - AND ONLY AS RECOVERY (§6).
 *
 * RESTART   the board REFUSED the restart (armed, busy, unsupported), so
 *           the configuration is on the board and not governing. Nothing
 *           dropped; asking again is the whole recovery.
 * RECONNECT the restart happened and the link did not come back inside
 *           the lifecycle's deadline. The retry looks for the board
 *           again. IT NEVER RESENDS THE MIXER WRITE (§7).
 *
 * `undefined` is the normal case, and the normal case has no button.
 */
type ActivationRecovery = 'RESTART' | 'RECONNECT';

type Outcome = {readonly text: string; readonly danger: boolean};

const NO_DRAFT: AirframeDraft = Object.freeze({});

export function MotorAirframeControls({
  sessionId,
  liveMixerModeRaw,
  liveYawMotorsReversed,
  writesLocked,
  onTopology,
  onEditState,
  onBusyChange,
  directionOpen,
  reorderOpen,
  onToggleDirection,
  onToggleReorder,
  controller = motorConfigurationController,
}: MotorAirframeControlsProps): React.JSX.Element {
  const {t} = useTranslation();
  const [snapshot, setSnapshot] = useState<MotorConfigurationSnapshot>();
  /**
   * WHICH SESSION THE SNAPSHOT ON SCREEN WAS READ ON.
   *
   * A snapshot does not stop existing when the session does - React holds
   * the last one through the re-render that carries the new session id,
   * and the read for the new session has not returned yet. Judging a
   * post-restart activation against that snapshot would be judging the
   * board BEFORE it restarted, and would call an activation verified on
   * the strength of the very value that was written pre-restart. So the
   * snapshot carries the session it came from and the verification
   * refuses to run until those agree.
   */
  const [snapshotSessionId, setSnapshotSessionId] = useState<string>();
  const [loadState, setLoadState] = useState<'LOADING' | 'READY' | 'UNAVAILABLE'>(
    'LOADING',
  );
  const [draft, setDraft] = useState<AirframeDraft>(NO_DRAFT);
  const [phase, setPhase] = useState<EditPhase>('IDLE');
  const [outcome, setOutcome] = useState<Outcome>();
  /** A verified save happened and no reboot has been requested since -
   * the reboot offer's memory for the session-off case, where there is
   * no live value to compare against. */
  const [savedNeedsReboot, setSavedNeedsReboot] = useState(false);
  /**
   * §8 - THE INTERLOCK'S OWN MEMORY OF THE ACTIVATION WINDOW.
   *
   * DELIBERATELY NOT RESET ON A SESSION CHANGE. Every other piece of this
   * component's state is, and must be: a new connection is a new
   * aircraft. This one exists precisely to survive the session change,
   * because the session change IS the reboot. It is cleared only where
   * the activation actually concludes - verified, contradicted, refused
   * by the board, or given up on.
   */
  const [activationInFlight, setActivationInFlight] = useState(false);
  /** Set only when an automatic step failed and a human retry is the way
   *  out. Drives the ONLY manual restart/reconnect control this strip
   *  still has (§6). */
  const [activationRecovery, setActivationRecovery] =
    useState<ActivationRecovery>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reportBusy = useCallback(
    (busy: boolean) => {
      onBusyChange?.(busy);
    },
    [onBusyChange],
  );

  const applySnapshot = useCallback(
    (next: MotorConfigurationSnapshot | undefined) => {
      setSnapshot(next);
      setSnapshotSessionId(next === undefined ? undefined : sessionId);
      if (next === undefined) {
        onTopology(undefined);
        return;
      }
      onTopology(
        Object.freeze({
          mixerModeRaw: next.mixer.mixerModeRaw,
          yawMotorsReversed: next.mixer.yawMotorsReversedConfigured,
          motorCount: next.motor.motorCount,
        }),
      );
      /* M-F3F §10/§11 - THE ONE ANSWER, PUBLISHED ONCE.
         This is the only place in the app that has just read the mixer
         and the runtime motor count off the board together, so it is the
         place that tells everyone else. Setup's aircraft model subscribes
         to this; it draws no airframe of its own invention. Only READ
         values reach here - a draft never does. */
      if (sessionId !== undefined) {
        observedAirframeTruth.publish({
          mixerModeRaw: next.mixer.mixerModeRaw,
          motorCount: next.motor.motorCount,
          sessionId,
        });
      }
    },
    [onTopology, sessionId],
  );

  const load = useCallback(async () => {
    if (sessionId === undefined) {
      setLoadState('UNAVAILABLE');
      applySnapshot(undefined);
      return;
    }
    setLoadState('LOADING');
    reportBusy(true);
    try {
      const result = await controller.load(sessionId);
      if (!mounted.current) {
        return;
      }
      if (result.kind === 'LOADED') {
        applySnapshot(result.snapshot);
        setLoadState('READY');
      } else {
        applySnapshot(undefined);
        setLoadState('UNAVAILABLE');
      }
    } catch {
      if (mounted.current) {
        applySnapshot(undefined);
        setLoadState('UNAVAILABLE');
      }
    } finally {
      if (mounted.current) {
        reportBusy(false);
      }
    }
  }, [applySnapshot, controller, reportBusy, sessionId]);

  useEffect(() => {
    // A new connection is a new aircraft: whatever was drafted against
    // the old one is meaningless against it.
    setDraft(NO_DRAFT);
    setSavedNeedsReboot(false);
    setOutcome(undefined);
    load().catch(() => undefined);
  }, [load]);

  /* ---- truth layers ------------------------------------------------- */
  const configuredMixer = snapshot?.mixer.mixerModeRaw;
  const configuredReversed = snapshot?.mixer.yawMotorsReversedConfigured;

  /* The strip's controls EDIT THE STORED CONFIGURATION, so they display
   * draft-first over configured - never the live session value. The live
   * value appears in the pending-reboot notes, by name, where the two
   * disagree. */
  const shownMixer = draft.mixerModeRaw ?? configuredMixer;
  const shownReversed = draft.yawMotorsReversed ?? configuredReversed;

  const dirtyMixer =
    draft.mixerModeRaw !== undefined &&
    configuredMixer !== undefined &&
    draft.mixerModeRaw !== configuredMixer;
  const dirtyProps =
    draft.yawMotorsReversed !== undefined &&
    configuredReversed !== undefined &&
    draft.yawMotorsReversed !== configuredReversed;
  const dirty = dirtyMixer || dirtyProps;

  /* The saved-but-not-active facts: the strip's own readback differs
   * from what the running session read at bring-up. True exactly between
   * a verified save and the reboot that applies it. */
  const mixerPendingReboot =
    liveMixerModeRaw !== undefined &&
    configuredMixer !== undefined &&
    configuredMixer !== liveMixerModeRaw;
  const propsPendingReboot =
    liveYawMotorsReversed !== undefined &&
    configuredReversed !== undefined &&
    configuredReversed !== liveYawMotorsReversed;

  useEffect(() => {
    onEditState?.(
      Object.freeze({
        dirtyMixer,
        dirtyProps,
        draftMixerModeRaw: dirtyMixer ? draft.mixerModeRaw : undefined,
        draftYawMotorsReversed: dirtyProps ? draft.yawMotorsReversed : undefined,
        mixerPendingReboot,
        propsPendingReboot,
        mixerActivationInFlight: activationInFlight,
      }),
    );
  }, [
    activationInFlight,
    dirtyMixer,
    dirtyProps,
    draft.mixerModeRaw,
    draft.yawMotorsReversed,
    mixerPendingReboot,
    propsPendingReboot,
    onEditState,
  ]);

  /** The verified mixer list, minus modes validateAndFixConfig would
   * rewrite before anything could read them back - same rule and same
   * derivation as the full settings panel. */
  const mixerOptions = BETAFLIGHT_MIXER_REFERENCE_V147.filter(
    row => row.configValidationRewrite === undefined,
  ).map(row => ({
    key: String(row.mixerId),
    label: t(`motorsScreen.topology.airframe.${row.firmwareName}`),
  }));

  /* Memoised because the post-restart verification effect names the
     activated airframe with it, and an effect dependency that changed
     identity on every render would re-run the verification. */
  const mixerValueLabel = useCallback(
    (mixerId: number | undefined): string => {
      if (mixerId === undefined) {
        return t('motorsScreen.mixerUnreadValue');
      }
      const row = BETAFLIGHT_MIXER_REFERENCE_V147.find(
        candidate => candidate.mixerId === mixerId,
      );
      return row === undefined
        ? t('motorsScreen.mixerUnknownValue', {id: mixerId})
        : t(`motorsScreen.topology.airframe.${row.firmwareName}`);
    },
    [t],
  );

  const editingLocked =
    writesLocked || phase !== 'IDLE' || loadState !== 'READY' || snapshot === undefined;

  const editMixer = useCallback((mixerModeRaw: number) => {
    setOutcome(undefined);
    setDraft(current => Object.freeze({...current, mixerModeRaw}));
  }, []);

  const editProps = useCallback((yawMotorsReversed: boolean) => {
    setOutcome(undefined);
    setDraft(current => Object.freeze({...current, yawMotorsReversed}));
  }, []);

  const discardDraft = useCallback(() => {
    setDraft(NO_DRAFT);
    setOutcome(undefined);
  }, []);

  /**
   * ISSUES THE RESTART AND HANDS THE RECONNECT TO THE APP'S ONE
   * LIFECYCLE.
   *
   * `fcRebootRecovery.expectReboot` is recorded BEFORE the command goes
   * out, exactly as that module's own contract demands: a link that dies
   * between the write and the next statement must still read as expected
   * rather than as a cable being pulled. From there the root-mounted
   * `useRebootReconnect` owns the rescan, the reopen and the new verified
   * session - this component starts the lifecycle and then watches it. No
   * second reconnect driver is created here (§3).
   */
  const restartForActivation = useCallback(
    async (activeSessionId: string) => {
      setPhase('RESTARTING');
      setActivationRecovery(undefined);
      setOutcome({text: t('motorsScreen.quickRestarting'), danger: false});
      fcRebootRecovery.expectReboot(activeSessionId, 'MIXER_SAVE');
      try {
        const result = await controller.requestReboot(activeSessionId);
        if (
          result.kind !== 'REBOOT_REQUESTED' &&
          result.kind !== 'SESSION_ENDED' &&
          result.kind !== 'UNCONFIRMED'
        ) {
          /* A REFUSAL IS NOT A RESTART. The board said no - armed, busy,
             unsupported - so nothing is going to drop and nothing is
             going to come back. Stand the expectation down rather than
             leaving the app waiting for a reconnect that cannot happen,
             and keep the saved configuration: it IS on the board, it is
             simply not active yet.

             THE ACTIVATION IS STILL IN FLIGHT. The stored mixer and the
             running mixer disagree until something restarts the board,
             so the §8 interlock stays shut and the pending record stays
             set - a retry, or a restart from anywhere else, still has to
             be verified when the board comes back. */
          fcRebootRecovery.reset();
          if (mounted.current) {
            setPhase('IDLE');
            setSavedNeedsReboot(false);
            setActivationRecovery('RESTART');
            setOutcome({
              text: t('motorsScreen.quickRestartRejected'),
              danger: true,
            });
          }
          return;
        }
      } catch {
        /* The throw itself is the expected shape when the link dies
           mid-command: the reboot was almost certainly delivered. The
           lifecycle's own deadline decides, not a guess here. */
      }
    },
    [controller, t],
  );

  const saveDraft = useCallback(async () => {
    if (!dirty || snapshot === undefined || sessionId === undefined) {
      return;
    }
    // ONE transaction for everything drafted; every untouched field comes
    // from the current snapshot's own draft projection.
    const base = createMotorConfigurationDraft(snapshot);
    const payload: MotorConfigurationDraft = Object.freeze({
      ...base,
      ...(dirtyMixer ? {mixerModeRaw: draft.mixerModeRaw} : {}),
      ...(dirtyProps ? {yawMotorsReversed: draft.yawMotorsReversed} : {}),
    });
    setPhase('SAVING');
    setActivationRecovery(undefined);
    setOutcome(undefined);
    reportBusy(true);
    /* THE RESTART OUTLIVES THIS FUNCTION. When the save hands over to the
       activation lifecycle, the phase belongs to that lifecycle - the
       `finally` below must not drop it back to IDLE and blank «جارٍ
       إعادة تشغيل متحكم الطيران…» the instant it is shown. */
    let handedToActivation = false;
    try {
      const result = await controller.save(sessionId, snapshot, payload);
      if (!mounted.current) {
        return;
      }
      switch (result.kind) {
        case 'SAVED_VERIFIED':
          applySnapshot(result.snapshot);
          setDraft(NO_DRAFT);
          if (dirtyMixer && draft.mixerModeRaw !== undefined) {
            /* M-F3F P0-A - ONE CLICK COMPLETES THE WHOLE LIFECYCLE.
               The pinned Configurator's own Motors tab defaults to
               rebooting (MotorsTab.vue `handleSave(reboot = true)` ->
               saveAndReboot -> reinitializeConnection), so the
               application owns the restart and the reconnect. The
               operator pressed Save; they do not press anything else. */
            pendingMixerActivation = {
              requestedMixerModeRaw: draft.mixerModeRaw,
              writtenOnSessionId: sessionId,
            };
            setSavedNeedsReboot(false);
            setActivationInFlight(true);
            handedToActivation = true;
            await restartForActivation(sessionId);
          } else {
            /* §9 - A PROPS CHANGE IS NOT A TOPOLOGY CHANGE. The stored
               yaw flag is read by the mixer at run time and the source
               requires no restart to make it take effect, so this path
               keeps the honest pending-reboot note rather than power
               cycling an aircraft for no reason. */
            setSavedNeedsReboot(true);
            setOutcome({
              text: t('motorsScreen.quickSavedVerified'),
              danger: false,
            });
          }
          break;
        case 'NO_CHANGES':
          applySnapshot(result.snapshot);
          setDraft(NO_DRAFT);
          setOutcome(undefined);
          break;
        case 'SAVED_UNVERIFIED':
          // EEPROM was acknowledged but the readback failed or disagreed:
          // READBACK_MISMATCH, never success. The draft stays, and the
          // stored truth on screen is suspect until re-read.
          setSavedNeedsReboot(true);
          setOutcome({text: t('motorsScreen.quickSavedUnverified'), danger: true});
          break;
        case 'REJECTED':
          if (result.reason === 'STALE_BASE') {
            // Another writer changed the FC since our read. Reload the
            // base; the draft is kept so the operator can re-judge it
            // against the fresh values.
            setOutcome({text: t('motorsScreen.quickSaveStale'), danger: true});
            load().catch(() => undefined);
          } else {
            setOutcome({text: t('motorsScreen.quickSaveRejected'), danger: true});
          }
          break;
        case 'UNCONFIRMED':
          setOutcome({text: t('motorsScreen.quickSaveUnconfirmed'), danger: true});
          break;
        default:
          setOutcome({text: t('motorsScreen.quickSaveFailed'), danger: true});
          break;
      }
    } catch {
      if (mounted.current) {
        setOutcome({text: t('motorsScreen.quickSaveFailed'), danger: true});
      }
    } finally {
      if (mounted.current) {
        if (!handedToActivation) {
          setPhase('IDLE');
        }
        reportBusy(false);
      }
    }
  }, [
    applySnapshot,
    controller,
    dirty,
    dirtyMixer,
    dirtyProps,
    draft.mixerModeRaw,
    draft.yawMotorsReversed,
    load,
    reportBusy,
    restartForActivation,
    sessionId,
    snapshot,
    t,
  ]);

  /* ------------------------------------------------------------------ *
   * WATCHING THE RESTART, AND VERIFYING WHAT CAME BACK
   * ------------------------------------------------------------------ */

  /**
   * Mirrors the app-wide reboot lifecycle into this strip's own phase, so
   * the operator sees «جارٍ إعادة تشغيل متحكم الطيران…» and then «جارٍ
   * إعادة الاتصال…» from the SAME state machine that is actually doing
   * the work - not from a timer imitating it.
   *
   * Only while an activation of OURS is pending: a CLI save reboot must
   * not repaint the airframe strip.
   */
  useEffect(() => {
    /* The phase is passed IN because a subscriber woken after another
       subscriber has already moved the lifecycle on must still be told
       what it was woken for - see the note on the store's Listener type.
       The default covers a caller that supplies nothing (the mount call
       below, and test doubles): the current phase is then the only
       answer there is. */
    const apply = (lifecycle = fcRebootRecovery.getPhase()) => {
      if (pendingMixerActivation === undefined) return;
      switch (lifecycle.kind) {
        case 'EXPECTED':
          setPhase('RESTARTING');
          setOutcome({text: t('motorsScreen.quickRestarting'), danger: false});
          break;
        case 'WAITING_FOR_LINK':
        case 'RECONNECTING':
          setPhase('RECONNECTING');
          setActivationRecovery(undefined);
          setOutcome({text: t('motorsScreen.quickReconnecting'), danger: false});
          break;
        case 'FAILED':
          /* §7 - THE CONFIGURATION IS SAVED; THE LINK IS NOT BACK. Say
             both, offer a reconnect retry, and never resend the mixer
             write: a second EEPROM commit for a save that already
             succeeded is a bug, not a recovery.
             NO INDEFINITE SPINNER: this is a terminal, worded state.
             The pending record is KEPT - if the board does come back,
             whether by retry or by hand, the activation still has to be
             verified before anything calls it active. */
          setPhase('IDLE');
          setActivationRecovery('RECONNECT');
          setOutcome({
            text: t('motorsScreen.quickActivationNoLink'),
            danger: true,
          });
          break;
        default:
          break;
      }
    };
    apply();
    return fcRebootRecovery.subscribe(apply);
  }, [t]);

  /**
   * A MIXER IS ON THE BOARD AND IS NOT THE ONE RUNNING - and no activation
   * of ours is in flight.
   *
   * This is not the save path. It is the state a board is left in when a
   * mixer was written somewhere else (the CLI, an earlier session) and
   * nothing restarted it. The strip's own note already says which value is
   * live; the operator still needs a way to make the stored one govern,
   * and §6 allows exactly one shape for that - a recovery action.
   */
  const strandedMixer =
    mixerPendingReboot &&
    !activationInFlight &&
    !dirty &&
    phase === 'IDLE' &&
    sessionId !== undefined;

  /** What the recovery control would do, explicit failures first. */
  const recoveryKind: ActivationRecovery | undefined =
    activationRecovery ?? (strandedMixer ? 'RESTART' : undefined);

  /**
   * THE RECOVERY ACTION - THE ONLY MANUAL RESTART LEFT ON THE MIXER PATH.
   *
   * RESTART   ask the board again. It refused the first time (or nobody
   *           ever asked), nothing was lost, and NOTHING IS REWRITTEN -
   *           the configuration is already committed. The restart is
   *           registered as an activation so that what comes back is
   *           verified rather than assumed.
   * RECONNECT re-enter the SAME reboot lifecycle at WAITING_FOR_LINK with
   *           a fresh deadline, which is what the root's reconnect driver
   *           already watches for. No device is opened here, and no
   *           configuration is written here - §7.
   */
  const retryActivation = useCallback(() => {
    if (recoveryKind === 'RESTART') {
      if (sessionId === undefined) return;
      const requested =
        pendingMixerActivation?.requestedMixerModeRaw ?? configuredMixer;
      if (requested === undefined) return;
      pendingMixerActivation = {
        requestedMixerModeRaw: requested,
        writtenOnSessionId: sessionId,
      };
      setActivationInFlight(true);
      setActivationRecovery(undefined);
      restartForActivation(sessionId).catch(() => undefined);
      return;
    }
    const pending = pendingMixerActivation;
    if (pending === undefined) return;
    /* A previous attempt already announced itself on Home; a new attempt
       is not the place to keep showing the old one's verdict. */
    connectionNotice.clear();
    setActivationRecovery(undefined);
    setPhase('RECONNECTING');
    setOutcome({text: t('motorsScreen.quickReconnecting'), danger: false});
    if (!fcRebootRecovery.retryReconnect(pending.writtenOnSessionId, 'MIXER_SAVE')) {
      // The lifecycle is busy with something else - say nothing false and
      // leave the retry available rather than pretending it ran.
      setPhase('IDLE');
      setActivationRecovery('RECONNECT');
    }
  }, [configuredMixer, recoveryKind, restartForActivation, sessionId, t]);

  /**
   * THE ONLY PATH TO «تم تفعيل …».
   *
   * A new session exists and this strip has re-read the board on it. The
   * activation is judged HERE, against two facts that both had to survive
   * the power cycle: the mixer the board now reports, and the runtime
   * motor count it now reports. An acknowledgement, an EEPROM commit and
   * even a completed reboot are all insufficient on their own (§5).
   */
  useEffect(() => {
    const pending = pendingMixerActivation;
    if (pending === undefined) return;
    if (sessionId === undefined || sessionId === pending.writtenOnSessionId) {
      // Still the session the write happened on: nothing has restarted
      // yet, so there is nothing to verify.
      return;
    }
    if (loadState === 'UNAVAILABLE') {
      /* The board is back and will not tell us what it is. That is not a
         mismatch - we do not know - and it is certainly not an
         activation. Say exactly that, and leave the interlock shut. */
      pendingMixerActivation = undefined;
      fcRebootRecovery.reset();
      setPhase('IDLE');
      setActivationRecovery(undefined);
      setOutcome({
        text: t('motorsScreen.quickActivationUnreadable'),
        danger: true,
      });
      return;
    }
    if (
      loadState !== 'READY' ||
      snapshot === undefined ||
      snapshotSessionId !== sessionId
    ) {
      /* Either the read is still running, or the snapshot on screen is
         the one from before the restart. Both are "not yet". */
      setPhase('VERIFYING');
      setOutcome({text: t('motorsScreen.quickVerifying'), danger: false});
      return;
    }
    pendingMixerActivation = undefined;
    fcRebootRecovery.reset();
    setPhase('IDLE');
    setActivationRecovery(undefined);
    const activeMixer = snapshot.mixer.mixerModeRaw;
    const runtimeCount = snapshot.motor.motorCount;
    if (activeMixer !== pending.requestedMixerModeRaw) {
      /* The board came back reporting the OLD airframe. Whatever
         happened, the requested topology is not what is running.
         THE INTERLOCK RELEASES HERE, and that is not a concession: this
         strip has just re-read the board, so the aircraft on screen IS
         the aircraft being mixed for. The requested one is simply not
         it, and the sentence says so. */
      setActivationInFlight(false);
      setOutcome({
        text: t('motorsScreen.quickActivationMismatch'),
        danger: true,
      });
      return;
    }
    if (runtimeCount === undefined) {
      /* The mixer matches but the board did not report a motor count, so
         the count this screen would command with is unknown. §8: motor
         test stays shut until it is not - the activation is NOT settled
         while half of what had to survive the restart is missing. */
      setOutcome({
        text: t('motorsScreen.quickActivationCountUnknown'),
        danger: true,
      });
      return;
    }
    setActivationInFlight(false);
    setSavedNeedsReboot(false);
    setOutcome({
      text: t('motorsScreen.quickActivated', {
        name: mixerValueLabel(activeMixer),
      }),
      danger: false,
    });
  }, [loadState, mixerValueLabel, sessionId, snapshot, snapshotSessionId, t]);

  const requestReboot = useCallback(async () => {
    if (sessionId === undefined) {
      return;
    }
    setPhase('REBOOTING');
    setOutcome(undefined);
    reportBusy(true);
    try {
      const result = await controller.requestReboot(sessionId);
      if (!mounted.current) {
        return;
      }
      switch (result.kind) {
        case 'REBOOT_REQUESTED':
          setSavedNeedsReboot(false);
          setOutcome({text: t('motorsScreen.quickRebootRequested'), danger: false});
          break;
        case 'UNCONFIRMED':
        case 'SESSION_ENDED':
          setOutcome({
            text: t('motorsScreen.quickRebootUnconfirmed'),
            danger: true,
          });
          break;
        default:
          setOutcome({text: t('motorsScreen.quickRebootRejected'), danger: true});
          break;
      }
    } catch {
      if (mounted.current) {
        setOutcome({text: t('motorsScreen.quickRebootRejected'), danger: true});
      }
    } finally {
      if (mounted.current) {
        setPhase('IDLE');
        reportBusy(false);
      }
    }
  }, [controller, reportBusy, sessionId, t]);

  /**
   * M-F3F §6 - THE MIXER SAVE NO LONGER ASKS FOR A SECOND PRESS.
   *
   * `mixerPendingReboot` USED TO APPEAR HERE, and that was the defect:
   * one click on «حفظ التغييرات» produced a verified save and then a
   * second button the operator had to find and press before the aircraft
   * they had just chosen was the aircraft the firmware was mixing for.
   * The application owns that restart now - the pinned Configurator's own
   * Motors tab does the same by default - so the mixer path reaches
   * «تم تفعيل …» with no further input, and this control is simply not
   * part of it.
   *
   * WHAT IS LEFT HERE IS NOT THE MIXER PATH:
   *  - `savedNeedsReboot`, set by the props save (§9 - the source does
   *    not restart for a props change, so this stays an offer) and by
   *    SAVED_UNVERIFIED;
   *  - `propsPendingReboot`, the same fact seen against a live session.
   *
   * And it is suppressed entirely while an activation is in flight, so a
   * restart can never be requested underneath one that is already
   * running.
   */
  const offerReboot =
    !dirty &&
    phase === 'IDLE' &&
    loadState === 'READY' &&
    sessionId !== undefined &&
    !activationInFlight &&
    recoveryKind === undefined &&
    (savedNeedsReboot || propsPendingReboot);

  /** §6/§7 - RECOVERY ONLY. Present when an automatic step actually
   *  failed, or when a stored mixer was left stranded by something that
   *  never restarted the board. Never as a normal second step. */
  const offerActivationRecovery =
    recoveryKind !== undefined &&
    (recoveryKind === 'RECONNECT' || sessionId !== undefined);

  const propsChip = (
    reversed: boolean,
    labelKey: string,
    testID: string,
  ): React.JSX.Element => {
    const selected = shownReversed === reversed;
    const draftHere = selected && dirtyProps;
    return (
      <Pressable
        onPress={() => editProps(reversed)}
        disabled={editingLocked || selected}
        accessibilityRole="radio"
        accessibilityState={{selected, disabled: editingLocked}}
        style={[
          styles.propsChip,
          selected && styles.propsChipSelected,
          draftHere && styles.propsChipDraft,
          editingLocked && !selected && styles.propsChipDisabled,
        ]}
        testID={testID}
      >
        <Text
          style={[styles.propsChipText, selected && styles.propsChipTextSelected]}
        >
          {t(labelKey)}
        </Text>
      </Pressable>
    );
  };

  return (
    <View style={styles.root} testID="motors-airframe-controls">
      {/* ---- the mixer, one compact control --------------------------- */}
      <SelectField
        label={t('motorConfiguration.mixerLabel')}
        options={mixerOptions}
        selectedKey={shownMixer === undefined ? null : String(shownMixer)}
        // An unread or unrecognised mixer shows AS ITSELF in the trigger,
        // never snapped to a neighbouring option - the placeholder carries
        // the truthful text when no option matches.
        placeholder={mixerValueLabel(shownMixer)}
        disabled={editingLocked}
        onSelect={value => editMixer(Number(value))}
        testID="motors-mixer-select"
      />
      {mixerPendingReboot ? (
        <Text style={styles.pendingNote} testID="motors-mixer-pending-reboot">
          {t('motorsScreen.quickPendingReboot', {
            active: mixerValueLabel(liveMixerModeRaw),
          })}
        </Text>
      ) : null}

      {/* ---- props direction ------------------------------------------ */}
      <View style={styles.propsRow} testID="motors-props-direction">
        <Text style={styles.propsLabel}>{t('motorsScreen.propsQuickLabel')}</Text>
        <View style={styles.propsChips} accessibilityRole="radiogroup">
          {propsChip(false, 'motorsScreen.propsIn', 'motors-props-in')}
          {propsChip(true, 'motorsScreen.propsOut', 'motors-props-out')}
        </View>
      </View>
      <Text style={styles.propsDetail}>{t('motorsScreen.propsQuickDetail')}</Text>
      {propsPendingReboot ? (
        <Text style={styles.pendingNote} testID="motors-props-pending-reboot">
          {t('motorsScreen.quickPendingReboot', {
            active: t(
              liveYawMotorsReversed
                ? 'motorsScreen.propsOut'
                : 'motorsScreen.propsIn',
            ),
          })}
        </Text>
      ) : null}

      {loadState === 'LOADING' ? (
        <Text style={styles.stateNote} testID="motors-airframe-config-loading">
          {t('motorsScreen.quickLoading')}
        </Text>
      ) : null}
      {/* A failed read is a visible, recoverable state - never silently
          greyed controls (M-F3 §3). The reason sits at the controls it
          disables, with the retry beside it. */}
      {loadState === 'UNAVAILABLE' ? (
        <View style={styles.unavailableRow}>
          <Text style={styles.stateNote} testID="motors-airframe-config-unavailable">
            {t('motorsScreen.quickUnavailable')}
          </Text>
          {sessionId === undefined ? null : (
            <Pressable
              onPress={() => {
                load().catch(() => undefined);
              }}
              accessibilityRole="button"
              style={styles.retryButton}
              testID="motors-airframe-retry"
            >
              <Text style={styles.retryText}>{t('motorsScreen.quickRetry')}</Text>
            </Pressable>
          )}
        </View>
      ) : null}

      {/* ---- the save bar: DIRTY, said out loud ----------------------- */}
      {dirty ? (
        <View style={styles.saveBar} testID="motors-airframe-savebar">
          <Text style={styles.saveBarTitle}>
            {t('motorsScreen.quickDirtyTitle')}
          </Text>
          {dirtyMixer ? (
            <Text style={styles.saveBarLine} testID="motors-airframe-savebar-mixer">
              {t('motorsScreen.quickDirtyMixerLine', {
                from: mixerValueLabel(configuredMixer),
                to: mixerValueLabel(draft.mixerModeRaw),
              })}
            </Text>
          ) : null}
          {dirtyProps ? (
            <Text style={styles.saveBarLine} testID="motors-airframe-savebar-props">
              {t('motorsScreen.quickDirtyPropsLine', {
                from: t(
                  configuredReversed === true
                    ? 'motorsScreen.propsOut'
                    : 'motorsScreen.propsIn',
                ),
                to: t(
                  draft.yawMotorsReversed === true
                    ? 'motorsScreen.propsOut'
                    : 'motorsScreen.propsIn',
                ),
              })}
            </Text>
          ) : null}
          <Text style={styles.saveBarBody}>
            {t('motorsScreen.quickDirtyBody')}
          </Text>
          <View style={styles.saveBarRow}>
            <Pressable
              onPress={discardDraft}
              disabled={phase !== 'IDLE'}
              accessibilityRole="button"
              style={[styles.barButton, styles.barCancel]}
              testID="motors-airframe-discard"
            >
              <Text style={styles.barCancelText}>
                {t('motorsScreen.quickDirtyDiscard')}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => {
                saveDraft().catch(() => undefined);
              }}
              disabled={phase !== 'IDLE' || writesLocked}
              accessibilityRole="button"
              style={[styles.barButton, styles.barApply]}
              testID="motors-airframe-save"
            >
              <Text style={styles.barApplyText}>
                {t('motorsScreen.quickDirtySave')}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {phase === 'SAVING' ? (
        <Text style={styles.stateNote} testID="motors-airframe-saving">
          {t('motorsScreen.quickSaving')}
        </Text>
      ) : null}
      {phase === 'REBOOTING' ? (
        <Text style={styles.stateNote} testID="motors-airframe-rebooting">
          {t('motorsScreen.quickRebooting')}
        </Text>
      ) : null}
      {/* The activation phases carry their words in the outcome line
          below - one sentence at a time, each naming the step that is
          actually running. These markers exist so a test can assert the
          phase itself rather than the string it produced. */}
      {phase === 'RESTARTING' ? (
        <View testID="motors-airframe-restarting" />
      ) : null}
      {phase === 'RECONNECTING' ? (
        <View testID="motors-airframe-reconnecting" />
      ) : null}
      {phase === 'VERIFYING' ? (
        <View testID="motors-airframe-verifying" />
      ) : null}
      {outcome !== undefined ? (
        <Text
          style={[styles.outcome, outcome.danger && styles.outcomeDanger]}
          testID="motors-quick-outcome"
        >
          {outcome.text}
        </Text>
      ) : null}
      {offerReboot ? (
        <Pressable
          onPress={() => {
            requestReboot().catch(() => undefined);
          }}
          disabled={writesLocked}
          accessibilityRole="button"
          style={[styles.rebootButton, writesLocked && styles.propsChipDisabled]}
          testID="motors-airframe-reboot"
        >
          <Icon name="power" size={16} color={colors.textPrimary} />
          <Text style={styles.rebootText}>
            {t('motorsScreen.quickRebootNow')}
          </Text>
        </Pressable>
      ) : null}
      {offerActivationRecovery ? (
        <Pressable
          onPress={retryActivation}
          disabled={writesLocked}
          accessibilityRole="button"
          style={[styles.rebootButton, writesLocked && styles.propsChipDisabled]}
          testID="motors-airframe-activation-retry"
        >
          <Icon name="refresh-cw" size={16} color={colors.textPrimary} />
          <Text style={styles.rebootText}>
            {t(
              recoveryKind === 'RECONNECT'
                ? 'motorsScreen.quickActivationRetry'
                : activationRecovery === 'RESTART'
                ? // The board refused a restart we asked for: try again.
                  'motorsScreen.quickRetry'
                : // Nobody ever asked: activate what is already stored.
                  'motorsScreen.quickActivateNow',
            )}
          </Text>
        </Pressable>
      ) : null}

      {/* ---- the two primary tools ------------------------------------ */}
      <View style={styles.toolsRow}>
        <Pressable
          onPress={onToggleDirection}
          accessibilityRole="button"
          accessibilityState={{expanded: directionOpen}}
          style={[styles.toolButton, directionOpen && styles.toolButtonOpen]}
          testID="motors-open-direction"
        >
          <Icon
            name={directionOpen ? 'rotate-ccw' : 'rotate-cw'}
            size={16}
            color={colors.textPrimary}
          />
          <Text style={styles.toolButtonText}>
            {t('motorsScreen.openDirectionTool')}
          </Text>
        </Pressable>
        <Pressable
          onPress={onToggleReorder}
          accessibilityRole="button"
          accessibilityState={{expanded: reorderOpen}}
          style={[styles.toolButton, reorderOpen && styles.toolButtonOpen]}
          testID="motors-open-reorder"
        >
          <Icon name="arrow-up-down" size={16} color={colors.textPrimary} />
          <Text style={styles.toolButtonText}>
            {t('motorsScreen.openReorderTool')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {gap: spacing.xs},
  propsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  propsLabel: {
    ...typography.label,
    color: colors.textPrimary,
    fontWeight: '600',
    writingDirection: 'rtl',
  },
  propsChips: {flexDirection: 'row', gap: spacing.xs},
  propsChip: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surfaceAlt,
  },
  propsChipSelected: {
    borderColor: colors.accent,
    borderWidth: 2,
    backgroundColor: colors.accentSoft,
  },
  /* The value on this chip is a DRAFT: chosen, visible, not yet on the
     flight controller. The dashed border says so at the point of change;
     the save bar says it in words. */
  propsChipDraft: {
    borderStyle: 'dashed',
    borderColor: colors.warning,
  },
  propsChipDisabled: {opacity: 0.5},
  propsChipText: {
    ...typography.caption,
    color: colors.textPrimary,
    writingDirection: 'rtl',
  },
  propsChipTextSelected: {fontWeight: '700'},
  propsDetail: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl',
    maxWidth: PROSE_MEASURE,
  },
  pendingNote: {
    ...typography.caption,
    color: colors.warning,
    fontWeight: '600',
    writingDirection: 'rtl',
    maxWidth: PROSE_MEASURE,
  },
  stateNote: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl',
  },
  unavailableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  retryButton: {
    /* 44, not 36. Measured 97x36 in Chromium at 390/430/768/1024/1366/
       1920 - the height was declared, not incidental, so the control
       missed the touch floor identically at every width. The label and
       the row around it are unchanged; only the minimum height moved. */
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  retryText: {...typography.caption, color: colors.textPrimary, fontWeight: '600'},
  saveBar: {
    gap: spacing.xs,
    padding: spacing.sm,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.surfaceAlt,
  },
  saveBarTitle: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  saveBarLine: {
    ...typography.caption,
    color: colors.textPrimary,
    writingDirection: 'rtl',
    maxWidth: PROSE_MEASURE,
  },
  saveBarBody: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl',
    maxWidth: PROSE_MEASURE,
  },
  saveBarRow: {flexDirection: 'row', gap: spacing.sm},
  barButton: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  barCancel: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  barCancelText: {...typography.label, color: colors.textPrimary},
  barApply: {backgroundColor: colors.accentStrong},
  barApplyText: {...typography.label, color: colors.white, fontWeight: '700'},
  outcome: {
    ...typography.caption,
    color: colors.success,
    fontWeight: '600',
    writingDirection: 'rtl',
    maxWidth: PROSE_MEASURE,
  },
  outcomeDanger: {color: colors.warning},
  rebootButton: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.surface,
  },
  rebootText: {
    ...typography.label,
    color: colors.textPrimary,
    fontWeight: '600',
    writingDirection: 'rtl',
  },
  toolsRow: {flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm},
  toolButton: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  toolButtonOpen: {
    borderColor: colors.accent,
    borderWidth: 2,
    backgroundColor: colors.accentSoft,
  },
  toolButtonText: {
    ...typography.label,
    color: colors.textPrimary,
    fontWeight: '600',
    writingDirection: 'rtl',
  },
});
