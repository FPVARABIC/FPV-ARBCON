/**
 * Pass 7.7 - Setup Region 5: أدوات وحدة التحكم.
 *
 * Only the three operations whose MSP contract AND persistence behavior
 * are proven safe at the pinned API-1.47 authority are offered (see
 * mspCommandSources.ts §"PASS 7.7, REGION 5"). There is no dead
 * placeholder here: every control shown can actually run.
 *
 * This component owns NO protocol logic. Enablement comes from the pure
 * resolveFcToolAvailability() gate, and the write itself runs through
 * FcToolsController's single exclusive transaction (which re-proves
 * every precondition against a FRESH reading before dispatching).
 *
 * UI contract:
 *  - one explicit Arabic confirmation whose positive label itself states
 *    that the propellers are removed; cancelling sends nothing;
 *  - the exact reason is shown for every disabled control, in text -
 *    never by color alone;
 *  - 44dp minimum touch targets;
 *  - a double tap cannot start two actions: the shared mutex refuses the
 *    second one, and the control is disabled while busy;
 *  - the outcome is announced as an alert and never overstates what the
 *    firmware actually confirmed.
 */

import React, { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../controls';
import { readInteraction } from '../controls/interaction';

import { FC_TOOL_IDS, resolveFcToolAvailability } from '../../../core';
import {
  describeCalibrationOutcome,
  type SensorCalibrationOutcomeId,
} from '../../../core/state/sensorPresentation';
import type { FcToolGateInput, FcToolId } from '../../../core';
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
import {PROSE_MEASURE} from '../../theme';

/** Android's minimum recommended touch target. */
const MIN_TOUCH_TARGET = 44;

export interface FcToolsSectionProps {
  sessionId: string;
  /** Everything the pure gate needs except `busy`, which this component
   * reads from the shared mutex itself. */
  gate: Omit<FcToolGateInput, 'busy'>;
  /** Injectable for tests; defaults to the app-wide singleton. */
  controller?: FcToolsController;
  /**
   * FINAL UI CORRECTION: which tools THIS surface presents. Defaults to
   * all of them so existing callers/tests are unchanged. SetupScreen now
   * hosts ACC_CALIBRATION beside the orientation hero (see
   * OrientationCalibrationCard), so it passes the remaining two here -
   * one tool, one surface, and the shared phase/outcome banners below
   * only render for a tool this instance actually owns.
   */
  tools?: readonly FcToolId[];
}

/** True when this surface owns the tool an outcome/phase refers to. */
function ownsOutcomeTool(
  tools: readonly FcToolId[],
  outcome: FcToolOutcome,
): boolean {
  return outcome.kind === 'REBOOT_REQUESTED'
    ? tools.includes('REBOOT')
    : tools.includes(outcome.tool);
}

export default function FcToolsSection({
  sessionId,
  gate,
  controller,
  tools = FC_TOOL_IDS,
}: FcToolsSectionProps): React.JSX.Element {
  const { t } = useTranslation();
  const active = controller ?? fcToolsController;
  const phase = useFcToolPhase(active);
  // Scoped to THIS session and THIS mounted instance (A-1): a
  // replacement generation/epoch revokes it, and a remount never
  // replays or re-announces an older result.
  const outcome = useFcToolPublication(sessionId, active);
  const busy = phase.kind !== 'IDLE';

  const onRequest = useCallback(
    (tool: FcToolId) => {
      active.requestConfirmation(sessionId, tool);
    },
    [active, sessionId],
  );

  const onCancel = useCallback(() => {
    active.cancel();
  }, [active]);

  const onConfirm = useCallback(() => {
    // Fire-and-forget by design: the outcome is published through the
    // controller's own subscribe()/getLastOutcome(), never awaited here.
    active.confirm().catch(() => undefined);
  }, [active]);

  return (
    <View style={styles.section} testID="fc-tools-section">
      <View style={styles.sectionHeader}>
        <View style={styles.sectionHeaderCopy}>
          <Text style={styles.eyebrow}>{t('fcTools.title')}</Text>
          <Text
            style={styles.sectionTitle}
            accessibilityRole="header"
            testID="fc-tools-title"
          >
            {t('fcTools.sectionTitle')}
          </Text>
        </View>
        <View style={styles.protectedPill}>
          <Text style={styles.protectedPillText}>{t('fcTools.protected')}</Text>
        </View>
      </View>
      <Text style={styles.sectionDescription}>
        {t('fcTools.sectionDescription')}
      </Text>

      <View style={styles.workflow} testID="fc-tools-workflow">
        {(['prepare', 'calibrate', 'verify'] as const).map((step, index) => (
          <View key={step} style={styles.workflowStep}>
            <View style={styles.workflowNumber}>
              <Text style={styles.workflowNumberText}>{index + 1}</Text>
            </View>
            <View style={styles.workflowCopy}>
              <Text style={styles.workflowTitle}>
                {t(`fcTools.workflow.${step}.title`)}
              </Text>
              <Text style={styles.workflowBody}>
                {t(`fcTools.workflow.${step}.body`)}
              </Text>
            </View>
          </View>
        ))}
      </View>

      {tools.map(tool => {
        const availability = resolveFcToolAvailability(tool, { ...gate, busy });
        const name = t(`fcTools.toolNames.${tool}`);
        const description = t(`fcTools.toolDescriptions.${tool}`);
        const reasonText =
          availability.reason === undefined
            ? undefined
            : t(`fcTools.disabledReasons.${availability.reason}`);
        return (
          <View
            key={tool}
            style={[
              styles.tool,
              tool === 'REBOOT' ? styles.maintenanceTool : undefined,
            ]}
            testID={`fc-tool-${tool}`}
          >
            <View style={styles.toolHeadingRow}>
              <View
                style={[
                  styles.toolMark,
                  tool === 'ACC_CALIBRATION'
                    ? styles.toolMarkPrimary
                    : tool === 'MAG_CALIBRATION'
                    ? styles.toolMarkInfo
                    : styles.toolMarkMaintenance,
                ]}
              >
                <Text style={styles.toolMarkText}>
                  {t(`fcTools.toolMarks.${tool}`)}
                </Text>
              </View>
              <View style={styles.toolHeadingCopy}>
                <Text style={styles.toolHeading}>{name}</Text>
                <Text
                  style={styles.toolDescription}
                  testID={`fc-tool-${tool}-description`}
                >
                  {description}
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
                  {t(
                    availability.enabled
                      ? 'fcTools.available'
                      : 'fcTools.unavailable',
                  )}
                </Text>
              </View>
            </View>
            <Pressable
              onPress={() => onRequest(tool)}
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
                const {pressed, hovered} = readInteraction(state);
                return [
                  styles.toolButton,
                  availability.enabled
                    ? styles.toolButtonEnabled
                    : styles.toolButtonDisabled,
                  (hovered || pressed) &&
                    availability.enabled &&
                    styles.toolButtonActive,
                ];
              }}
              testID={`fc-tool-${tool}-button`}
            >
              <Text
                style={
                  availability.enabled
                    ? styles.toolNameEnabled
                    : styles.toolNameDisabled
                }
              >
                {t(`fcTools.toolActions.${tool}`)}
              </Text>
            </Pressable>
            {reasonText !== undefined && (
              <Text style={styles.toolReason} testID={`fc-tool-${tool}-reason`}>
                {reasonText}
              </Text>
            )}
          </View>
        );
      })}

      {phase.kind === 'RUNNING' && tools.includes(phase.tool) && (
        <View style={styles.runningBanner} testID="fc-tools-running">
          <View style={styles.runningDot} />
          <View style={styles.runningCopy}>
            <Text style={styles.runningTitle}>{t('fcTools.runningTitle')}</Text>
            <Text style={styles.runningBody}>
              {t(`fcTools.runningBodies.${phase.tool}`)}
            </Text>
          </View>
        </View>
      )}

      {phase.kind === 'CONFIRMING' && tools.includes(phase.tool) && (
        <View
          style={styles.confirmation}
          accessibilityRole="alert"
          testID="fc-tools-confirmation"
        >
          <Text style={styles.confirmTitle}>{t('fcTools.confirmTitle')}</Text>
          <Text style={styles.confirmBody} testID="fc-tools-confirmation-body">
            {t(`fcTools.confirmBodies.${phase.tool}`)}
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

      {outcome !== undefined && ownsOutcomeTool(tools, outcome) && (
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
        </View>
      )}
    </View>
  );
}

type Translate = ReturnType<typeof useTranslation>['t'];

/** Never claims more than the firmware actually confirmed. Exported so
 * OrientationCalibrationCard announces the SAME wording for the same
 * outcome - two surfaces, one truth. */
export function describeFcToolOutcome(
  outcome: FcToolOutcome,
  t: Translate,
): string {
  switch (outcome.kind) {
    /**
     * A WATCHED CALIBRATION REPORTS WHAT WAS WATCHED. The wording comes
     * from the Sensors presentation layer, so this surface and the
     * Sensors screen say the same sentence for the same observation -
     * there is one definition of "calibrated" in this application and
     * both screens read it from the same place.
     */
    case 'CALIBRATION_OBSERVED': {
      const target =
        outcome.tool === 'ACC_CALIBRATION' ? 'ACCELEROMETER' : 'MAGNETOMETER';
      const phrase = describeCalibrationOutcome(
        target,
        outcome.outcome.kind as SensorCalibrationOutcomeId,
      );
      return t(phrase.key, phrase.params ?? {});
    }
    case 'ACCEPTED':
      return t('fcTools.outcomeAccepted');
    case 'REBOOT_REQUESTED':
      return t('fcTools.outcomeRebootRequested');
    case 'UNCONFIRMED':
      return t('fcTools.outcomeUnconfirmed');
    case 'FAILED':
      return t('fcTools.outcomeFailed');
    case 'REJECTED':
      return t('fcTools.outcomeRejected', {
        reason: t(`fcTools.disabledReasons.${outcome.reason}`),
      });
    case 'CANCELLED':
      return t('fcTools.outcomeCancelled');
    default:
      return t('fcTools.outcomeSessionEnded');
  }
}

const styles = StyleSheet.create({
  section: {
    marginTop: spacing.md,
    marginHorizontal: spacing.md,
    marginBottom: spacing.md,
    padding: spacing.lg,
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
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  sectionHeaderCopy: { flex: 1 },
  eyebrow: { ...typography.eyebrow, color: colors.accentStrong },
  sectionTitle: {
    ...typography.title,
    color: colors.textPrimary,
    marginTop: 2,
  },
  protectedPill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.pill,
    backgroundColor: colors.accentSoft,
  },
  protectedPillText: {
    ...typography.caption,
    color: colors.accentStrong,
    fontWeight: '700',
  },
  sectionDescription: {
    ...typography.body,
    color: colors.textSecondary,
    marginTop: spacing.sm, maxWidth: PROSE_MEASURE},
  workflow: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.backgroundRaised,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    gap: spacing.sm,
  },
  workflowStep: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  workflowNumber: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: colors.accentSoft,
  },
  workflowNumberText: {
    ...typography.caption,
    color: colors.accentStrong,
    fontWeight: '700',
  },
  workflowCopy: { flex: 1 },
  workflowTitle: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  workflowBody: { ...typography.caption, color: colors.textSecondary, maxWidth: PROSE_MEASURE},
  tool: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceAlt,
  },
  maintenanceTool: { backgroundColor: colors.backgroundRaised },
  toolHeadingRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  toolMark: {
    minWidth: 42,
    height: 34,
    paddingHorizontal: spacing.xs,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.sm,
  },
  toolMarkPrimary: { backgroundColor: colors.accentSoft },
  toolMarkInfo: { backgroundColor: colors.infoSoft },
  toolMarkMaintenance: { backgroundColor: colors.surfaceAlt },
  toolMarkText: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '700',
    writingDirection: 'ltr',
  },
  toolHeadingCopy: { flex: 1 },
  toolHeading: { ...typography.sectionTitle, color: colors.textPrimary },
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
  toolButton: {
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  toolButtonEnabled: {
    borderColor: colors.accentStrong,
    backgroundColor: colors.accentSoft,
  },
  toolButtonDisabled: {
    borderColor: colors.borderSoft,
    backgroundColor: colors.backgroundRaised,
  },
  toolNameEnabled: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  toolNameDisabled: {
    ...typography.body,
    color: colors.textSecondary,
  },
  toolDescription: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 2, maxWidth: PROSE_MEASURE},
  toolReason: {
    ...typography.caption,
    color: colors.warning,
    marginTop: spacing.xs,
    fontWeight: '600', maxWidth: PROSE_MEASURE},
  confirmation: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.warning,
    backgroundColor: colors.backgroundRaised,
  },
  confirmTitle: {
    ...typography.sectionTitle,
    color: colors.warning,
  },
  confirmBody: {
    ...typography.body,
    color: colors.textPrimary,
    marginTop: spacing.sm, maxWidth: PROSE_MEASURE},
  toolButtonActive: { backgroundColor: colors.surfaceHover },
  outcome: {
    ...typography.body,
    color: colors.textPrimary,
  },
  outcomeCard: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.backgroundRaised,
  },
  nextStepText: {
    ...typography.caption,
    color: colors.accentStrong,
    fontWeight: '700',
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
    marginTop: 2, maxWidth: PROSE_MEASURE},
});
