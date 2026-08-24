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
 * that fails or disagrees is READBACK_MISMATCH, never success. A saved
 * mixer is STILL NOT the active mixer - mixerInit() runs at boot - so
 * after a verified save the strip offers the explicit REBOOT step
 * (MSP_REBOOT through the same controller, disarmed re-verified first)
 * and the pending-reboot notes keep naming the live value until a
 * reconnect actually reads the new one. No ACK is ever called "applied".
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
import {
  motorConfigurationController,
  type MotorConfigurationLoadOutcome,
  type MotorConfigurationSaveOutcome,
  type MotorRebootOutcome,
} from '../../platforms/react-native/protocol';
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

type EditPhase = 'IDLE' | 'SAVING' | 'REBOOTING';

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
    },
    [onTopology],
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
      }),
    );
  }, [
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

  const mixerValueLabel = (mixerId: number | undefined): string => {
    if (mixerId === undefined) {
      return t('motorsScreen.mixerUnreadValue');
    }
    const row = BETAFLIGHT_MIXER_REFERENCE_V147.find(
      candidate => candidate.mixerId === mixerId,
    );
    return row === undefined
      ? t('motorsScreen.mixerUnknownValue', {id: mixerId})
      : t(`motorsScreen.topology.airframe.${row.firmwareName}`);
  };

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
    setOutcome(undefined);
    reportBusy(true);
    try {
      const result = await controller.save(sessionId, snapshot, payload);
      if (!mounted.current) {
        return;
      }
      switch (result.kind) {
        case 'SAVED_VERIFIED':
          applySnapshot(result.snapshot);
          setDraft(NO_DRAFT);
          setSavedNeedsReboot(true);
          setOutcome({text: t('motorsScreen.quickSavedVerified'), danger: false});
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
        setPhase('IDLE');
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
    sessionId,
    snapshot,
    t,
  ]);

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

  /* The reboot offer: a persisted save is waiting for its restart. Shown
   * when the live comparison says so, or - with no session to compare
   * against - when this strip itself verified a save this connection. */
  const offerReboot =
    !dirty &&
    phase === 'IDLE' &&
    loadState === 'READY' &&
    sessionId !== undefined &&
    (savedNeedsReboot || mixerPendingReboot || propsPendingReboot);

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
    minHeight: 36,
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
