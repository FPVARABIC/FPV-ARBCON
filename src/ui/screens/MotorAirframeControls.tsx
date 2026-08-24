/**
 * M-F2 - THE AIRFRAME'S OWN CONTROL STRIP: MIXER, PROPS DIRECTION, AND
 * THE TWO PRIMARY MOTOR TOOLS.
 *
 * WHAT THIS IS FOR. The four things a pilot reaches for around the
 * aircraft drawing - which airframe this is, which way the propellers
 * are built, the motor-direction workflow, the output-reorder workflow -
 * used to live two disclosures deep. They are one compact strip now,
 * directly under the model, the way a configurator's mixer panel sits
 * beside its aircraft.
 *
 * WHAT THIS IS NOT. It is not a second configuration editor and not a
 * second write path. Reading and writing go through the SAME
 * MotorConfigurationController transaction the full settings panel uses:
 * fresh re-read under the exclusive lease, stale-base comparison, armed
 * preflight, changed-groups-only writes, EEPROM commit, readback, and a
 * reboot-required verdict. This file builds a draft from the CURRENT
 * snapshot with exactly one field changed and hands it to that
 * transaction - so changing the mixer cannot touch the props flag,
 * changing the props flag cannot touch the mixer, and neither can
 * clobber a field some other screen owns.
 *
 * WHAT A SAVED MIXER IS NOT. It is not the active mixer. mixerInit()
 * runs at boot, so the saved byte governs only after a restart - the
 * outcome line says so, the aircraft drawing deliberately keeps
 * following the LIVE session's read, and the session's own drift guard
 * blocks motor commands until a fresh session re-reads the truth. This
 * strip never rebuilds topology from a dropdown.
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
} from '../../platforms/react-native/protocol';
import {SelectField} from '../components/controls/SelectField';
import {Icon} from '../icons';
import {PROSE_MEASURE, colors, radii, spacing, typography} from '../theme';

/** The same port shape the full settings panel injects. */
export interface MotorAirframeControlsPort {
  load(sessionId: string): Promise<MotorConfigurationLoadOutcome>;
  save(
    sessionId: string,
    original: MotorConfigurationSnapshot,
    draft: MotorConfigurationDraft,
  ): Promise<MotorConfigurationSaveOutcome>;
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

export interface MotorAirframeControlsProps {
  readonly sessionId: string | undefined;
  /** The LIVE session's values, when a session has read them. They win
   * over this strip's own read for display, because they are what the
   * running firmware is actually flying with. */
  readonly liveMixerModeRaw: number | undefined;
  readonly liveYawMotorsReversed: boolean | undefined;
  /** True while a motor may be live or a hold is owned - every write
   * control in the strip locks, exactly like the settings panel's own
   * busy interlock in the other direction. */
  readonly writesLocked: boolean;
  readonly onTopology: (topology: AirframeConfigTopology | undefined) => void;
  readonly onBusyChange?: (busy: boolean) => void;
  /** The two primary tools this strip opens. Rendering them is the
   * screen's job; this strip only owns the entry buttons' state. */
  readonly directionOpen: boolean;
  readonly reorderOpen: boolean;
  readonly onToggleDirection: () => void;
  readonly onToggleReorder: () => void;
  readonly controller?: MotorAirframeControlsPort;
}

type PendingEdit =
  | {readonly kind: 'MIXER'; readonly mixerModeRaw: number}
  | {readonly kind: 'PROPS'; readonly yawMotorsReversed: boolean};

type Outcome = {readonly text: string; readonly danger: boolean};

export function MotorAirframeControls({
  sessionId,
  liveMixerModeRaw,
  liveYawMotorsReversed,
  writesLocked,
  onTopology,
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
  const [pending, setPending] = useState<PendingEdit>();
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();
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
    load().catch(() => undefined);
    // A new connection is a new aircraft until proven otherwise.
  }, [load]);

  /* ---- display values: the live session wins ----------------------- */
  const configuredMixer = snapshot?.mixer.mixerModeRaw;
  const displayMixer = liveMixerModeRaw ?? configuredMixer;
  const configuredReversed = snapshot?.mixer.yawMotorsReversedConfigured;
  const displayReversed = liveYawMotorsReversed ?? configuredReversed;

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
    writesLocked || saving || loadState !== 'READY' || snapshot === undefined;

  const beginEdit = useCallback((edit: PendingEdit) => {
    setOutcome(undefined);
    setPending(edit);
  }, []);

  const confirmSave = useCallback(async () => {
    if (pending === undefined || snapshot === undefined || sessionId === undefined) {
      return;
    }
    const base = createMotorConfigurationDraft(snapshot);
    const draft: MotorConfigurationDraft = Object.freeze(
      pending.kind === 'MIXER'
        ? {...base, mixerModeRaw: pending.mixerModeRaw}
        : {...base, yawMotorsReversed: pending.yawMotorsReversed},
    );
    setSaving(true);
    reportBusy(true);
    try {
      const result = await controller.save(sessionId, snapshot, draft);
      if (!mounted.current) {
        return;
      }
      switch (result.kind) {
        case 'SAVED_VERIFIED':
          applySnapshot(result.snapshot);
          setOutcome({text: t('motorsScreen.quickSavedVerified'), danger: false});
          break;
        case 'NO_CHANGES':
          applySnapshot(result.snapshot);
          setOutcome(undefined);
          break;
        case 'SAVED_UNVERIFIED':
          setOutcome({text: t('motorsScreen.quickSavedUnverified'), danger: true});
          break;
        case 'REJECTED':
          setOutcome({text: t('motorsScreen.quickSaveRejected'), danger: true});
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
        setSaving(false);
        setPending(undefined);
        reportBusy(false);
      }
    }
  }, [applySnapshot, controller, pending, reportBusy, sessionId, snapshot, t]);

  /* The saved-but-not-active hint: the strip's own readback differs from
   * what the running session read at bring-up. True exactly between a
   * verified save and the reboot that applies it. */
  const mixerPendingReboot =
    liveMixerModeRaw !== undefined &&
    configuredMixer !== undefined &&
    configuredMixer !== liveMixerModeRaw;
  const propsPendingReboot =
    liveYawMotorsReversed !== undefined &&
    configuredReversed !== undefined &&
    configuredReversed !== liveYawMotorsReversed;

  const propsChip = (
    reversed: boolean,
    labelKey: string,
    testID: string,
  ): React.JSX.Element => {
    const selected = (configuredReversed ?? displayReversed) === reversed;
    return (
      <Pressable
        onPress={() => beginEdit({kind: 'PROPS', yawMotorsReversed: reversed})}
        disabled={editingLocked || selected}
        accessibilityRole="radio"
        accessibilityState={{selected, disabled: editingLocked}}
        style={[
          styles.propsChip,
          selected && styles.propsChipSelected,
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
        selectedKey={displayMixer === undefined ? null : String(displayMixer)}
        // An unread or unrecognised mixer shows AS ITSELF in the trigger,
        // never snapped to a neighbouring option - the placeholder carries
        // the truthful text when no option matches.
        placeholder={mixerValueLabel(displayMixer)}
        disabled={editingLocked}
        onSelect={value => beginEdit({kind: 'MIXER', mixerModeRaw: Number(value)})}
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
      {loadState === 'UNAVAILABLE' ? (
        <Text style={styles.stateNote} testID="motors-airframe-config-unavailable">
          {t('motorsScreen.quickUnavailable')}
        </Text>
      ) : null}

      {/* ---- one confirm, shared by both edits ------------------------ */}
      {pending !== undefined ? (
        <View style={styles.confirm} testID="motors-quick-save-confirm">
          <Text style={styles.confirmTitle}>
            {t('motorsScreen.quickSaveConfirmTitle')}
          </Text>
          <Text style={styles.confirmBody}>
            {t('motorsScreen.quickSaveConfirmBody')}
          </Text>
          <View style={styles.confirmRow}>
            <Pressable
              onPress={() => setPending(undefined)}
              disabled={saving}
              accessibilityRole="button"
              style={[styles.confirmButton, styles.confirmCancel]}
              testID="motors-quick-save-cancel"
            >
              <Text style={styles.confirmCancelText}>
                {t('motorsScreen.quickSaveCancel')}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => {
                confirmSave().catch(() => undefined);
              }}
              disabled={saving}
              accessibilityRole="button"
              style={[styles.confirmButton, styles.confirmApply]}
              testID="motors-quick-save-apply"
            >
              <Text style={styles.confirmApplyText}>
                {t('motorsScreen.quickSaveConfirm')}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {outcome !== undefined ? (
        <Text
          style={[styles.outcome, outcome.danger && styles.outcomeDanger]}
          testID="motors-quick-outcome"
        >
          {outcome.text}
        </Text>
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
  confirm: {
    gap: spacing.xs,
    padding: spacing.sm,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.surfaceAlt,
  },
  confirmTitle: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  confirmBody: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl',
    maxWidth: PROSE_MEASURE,
  },
  confirmRow: {flexDirection: 'row', gap: spacing.sm},
  confirmButton: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmCancel: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  confirmCancelText: {...typography.label, color: colors.textPrimary},
  confirmApply: {backgroundColor: colors.accentStrong},
  confirmApplyText: {...typography.label, color: colors.white, fontWeight: '700'},
  outcome: {
    ...typography.caption,
    color: colors.success,
    fontWeight: '600',
    writingDirection: 'rtl',
    maxWidth: PROSE_MEASURE,
  },
  outcomeDanger: {color: colors.warning},
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
