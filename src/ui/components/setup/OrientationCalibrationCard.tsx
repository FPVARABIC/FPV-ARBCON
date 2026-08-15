/**
 * SETUP FINAL UI CORRECTION - the accelerometer calibration action,
 * moved directly under the 3D orientation area so the operator can level
 * the aircraft while WATCHING the live model and calibrate without
 * scrolling. The stability check that auto-starts after an accepted
 * calibration renders immediately below this card, so the whole
 * level -> calibrate -> verify loop happens in one screenful.
 *
 * This is a RELOCATED SURFACE, not a second capability:
 *  - enablement comes from the SAME pure resolveFcToolAvailability()
 *    gate FcToolsSection uses, with the SAME inputs;
 *  - the write runs through the SAME FcToolsController singleton and its
 *    exclusive transaction (double tap refused by the shared mutex);
 *  - the explicit Arabic confirmation - whose body states the propellers
 *    must be off and the aircraft level and still - is unchanged;
 *  - the outcome wording comes from the SAME describeFcToolOutcome().
 *
 * The testIDs are the ones the ACC row has always had
 * (fc-tool-ACC_CALIBRATION*), and the shared flow testIDs
 * (fc-tools-confirmation/-running/-outcome...) render HERE for
 * ACC_CALIBRATION only - FcToolsSection no longer owns that tool (its
 * `tools` prop), so the two surfaces can never render the same id at
 * the same time.
 */

import React, { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../controls';
import { readInteraction } from '../controls/interaction';
import { resolveFcToolAvailability } from '../../../core';
import type { FcToolGateInput } from '../../../core';
import {
  fcToolsController,
  useFcToolPhase,
  useFcToolPublication,
} from '../../../platforms/react-native/protocol';
import type {
  FcToolOutcome,
  FcToolsController,
} from '../../../platforms/react-native/protocol';
import { colors, radii, spacing, typography } from '../../theme';
import { describeFcToolOutcome } from './FcToolsSection';

const MIN_TOUCH_TARGET = 44;

/** This card announces ONLY accelerometer outcomes; every other tool's
 * result (including REBOOT_REQUESTED, which carries no tool field)
 * belongs to the maintenance section. */
function isAccOutcome(
  outcome: FcToolOutcome | undefined,
): outcome is FcToolOutcome & { tool: 'ACC_CALIBRATION' } {
  return (
    outcome !== undefined &&
    outcome.kind !== 'REBOOT_REQUESTED' &&
    outcome.tool === 'ACC_CALIBRATION'
  );
}

export interface OrientationCalibrationCardProps {
  sessionId: string;
  /** The SAME gate inputs SetupScreen hands FcToolsSection. */
  gate: Omit<FcToolGateInput, 'busy'>;
  /** Injectable for tests; defaults to the app-wide singleton. */
  controller?: FcToolsController;
  /**
   * 'inline' renders WITHOUT its own card chrome, for embedding into the
   * orientation hero's calibrationSlot (the accepted placement); 'card'
   * keeps the standalone surface for direct use and for tests.
   */
  variant?: 'card' | 'inline';
}

export default function OrientationCalibrationCard({
  sessionId,
  gate,
  controller,
  variant = 'card',
}: OrientationCalibrationCardProps): React.JSX.Element {
  const { t } = useTranslation();
  const active = controller ?? fcToolsController;
  const phase = useFcToolPhase(active);
  const outcome = useFcToolPublication(sessionId, active);
  const busy = phase.kind !== 'IDLE';
  const availability = resolveFcToolAvailability('ACC_CALIBRATION', {
    ...gate,
    busy,
  });
  const reasonText =
    availability.reason === undefined
      ? undefined
      : t(`fcTools.disabledReasons.${availability.reason}`);
  const name = t('fcTools.toolNames.ACC_CALIBRATION');

  const onRequest = useCallback(() => {
    active.requestConfirmation(sessionId, 'ACC_CALIBRATION');
  }, [active, sessionId]);
  const onCancel = useCallback(() => {
    active.cancel();
  }, [active]);
  const onConfirm = useCallback(() => {
    // Fire-and-forget by design: the outcome is published through the
    // controller's own subscribe()/getLastOutcome(), never awaited here.
    active.confirm().catch(() => undefined);
  }, [active]);

  const ownsOutcome = isAccOutcome(outcome);

  return (
    <View
      style={variant === 'card' ? styles.card : styles.inline}
      testID="orientation-calibration-card"
    >
      <View style={styles.row} testID="fc-tool-ACC_CALIBRATION">
        <View style={styles.headingRow}>
          <View style={styles.headingCopy}>
            <Text style={styles.title}>{name}</Text>
            <Text style={styles.hint} testID="orientation-calibration-hint">
              {t('orientationCalibration.hint')}
            </Text>
          </View>
          <View
            style={[
              styles.availabilityPill,
              availability.enabled
                ? styles.availabilityPillReady
                : styles.availabilityPillBlocked,
            ]}
          >
            <Text
              style={
                availability.enabled
                  ? styles.availabilityReadyText
                  : styles.availabilityBlockedText
              }
            >
              {t(availability.enabled ? 'fcTools.available' : 'fcTools.unavailable')}
            </Text>
          </View>
        </View>
        <Pressable
          onPress={onRequest}
          disabled={!availability.enabled}
          accessibilityRole="button"
          accessibilityState={{ disabled: !availability.enabled }}
          accessibilityLabel={
            reasonText === undefined ? name : `${name}، ${reasonText}`
          }
          accessibilityHint={
            availability.enabled ? t('fcTools.hint') : undefined
          }
          style={state => {
            const { pressed, hovered } = readInteraction(state);
            return [
              styles.actionButton,
              availability.enabled
                ? styles.actionButtonEnabled
                : styles.actionButtonDisabled,
              (hovered || pressed) &&
                availability.enabled &&
                styles.actionButtonActive,
            ];
          }}
          testID="fc-tool-ACC_CALIBRATION-button"
        >
          <Text
            style={
              availability.enabled
                ? styles.actionTextEnabled
                : styles.actionTextDisabled
            }
          >
            {t('fcTools.toolActions.ACC_CALIBRATION')}
          </Text>
        </Pressable>
        {reasonText !== undefined && (
          <Text
            style={styles.reason}
            testID="fc-tool-ACC_CALIBRATION-reason"
          >
            {reasonText}
          </Text>
        )}
        <Text
          style={styles.description}
          testID="fc-tool-ACC_CALIBRATION-description"
        >
          {t('fcTools.toolDescriptions.ACC_CALIBRATION')}
        </Text>
      </View>

      {phase.kind === 'RUNNING' && phase.tool === 'ACC_CALIBRATION' && (
        <View style={styles.runningBanner} testID="fc-tools-running">
          <View style={styles.runningDot} />
          <View style={styles.runningCopy}>
            <Text style={styles.runningTitle}>{t('fcTools.runningTitle')}</Text>
            <Text style={styles.runningBody}>
              {t('fcTools.runningBodies.ACC_CALIBRATION')}
            </Text>
          </View>
        </View>
      )}

      {phase.kind === 'CONFIRMING' && phase.tool === 'ACC_CALIBRATION' && (
        <View
          style={styles.confirmation}
          accessibilityRole="alert"
          testID="fc-tools-confirmation"
        >
          <Text style={styles.confirmTitle}>{t('fcTools.confirmTitle')}</Text>
          <Text style={styles.confirmBody} testID="fc-tools-confirmation-body">
            {t('fcTools.confirmBodies.ACC_CALIBRATION')}
          </Text>
          <Button
            label={t('fcTools.confirmAction')}
            onPress={onConfirm}
            variant="primary"
            icon="circle-check"
            block
            testID="fc-tools-confirm"
          />
          <Button
            label={t('fcTools.cancelAction')}
            onPress={onCancel}
            variant="secondary"
            icon="x"
            block
            testID="fc-tools-cancel"
          />
        </View>
      )}

      {ownsOutcome && (
        <View
          style={styles.outcomeCard}
          accessibilityRole="alert"
          testID="fc-tools-outcome-card"
        >
          <Text
            style={styles.outcome}
            accessibilityRole="alert"
            testID="fc-tools-outcome"
          >
            {describeFcToolOutcome(outcome, t)}
          </Text>
          {outcome.kind === 'ACCEPTED' && (
            <Text style={styles.nextStepText}>
              {t('fcTools.accVerificationStarted')}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  /* Inside the hero card: full width, a soft separation line above, and
   * none of the standalone chrome. */
  inline: {
    width: '100%',
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.borderSoft,
  },
  card: {
    marginTop: spacing.sm,
    marginHorizontal: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    shadowColor: colors.shadow,
    shadowOpacity: 0.16,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 3,
  },
  row: {},
  headingRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  headingCopy: { flex: 1, minWidth: 0 },
  title: { ...typography.sectionTitle, color: colors.textPrimary },
  hint: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 2,
  },
  availabilityPill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radii.pill,
  },
  availabilityPillReady: { backgroundColor: colors.successSoft },
  availabilityPillBlocked: { backgroundColor: colors.warningSoft },
  availabilityReadyText: {
    ...typography.caption,
    color: colors.success,
    fontWeight: '700',
  },
  availabilityBlockedText: {
    ...typography.caption,
    color: colors.warning,
    fontWeight: '700',
  },
  actionButton: {
    marginTop: spacing.sm,
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  actionButtonEnabled: {
    borderColor: colors.accentStrong,
    backgroundColor: colors.accentSoft,
  },
  actionButtonDisabled: {
    borderColor: colors.borderSoft,
    backgroundColor: colors.backgroundRaised,
  },
  actionButtonActive: { backgroundColor: colors.surfaceHover },
  actionTextEnabled: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  actionTextDisabled: {
    ...typography.body,
    color: colors.textSecondary,
  },
  reason: {
    ...typography.caption,
    color: colors.warning,
    marginTop: spacing.xs,
    fontWeight: '600',
  },
  description: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
  confirmation: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.warning,
    backgroundColor: colors.backgroundRaised,
  },
  confirmTitle: { ...typography.sectionTitle, color: colors.warning },
  confirmBody: {
    ...typography.body,
    color: colors.textPrimary,
    marginTop: spacing.sm,
  },
  runningBanner: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.accentStrong,
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'center',
  },
  runningDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: colors.accent,
  },
  runningCopy: { flex: 1 },
  runningTitle: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  runningBody: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 2,
  },
  outcomeCard: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.backgroundRaised,
  },
  outcome: { ...typography.body, color: colors.textPrimary },
  nextStepText: {
    ...typography.caption,
    color: colors.accentStrong,
    fontWeight: '700',
    marginTop: spacing.sm,
  },
});
