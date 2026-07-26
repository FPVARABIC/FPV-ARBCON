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

import React, {useCallback} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useTranslation} from 'react-i18next';

import {FC_TOOL_IDS, resolveFcToolAvailability} from '../../../core';
import type {FcToolGateInput, FcToolId} from '../../../core';
import {fcToolsController, useFcToolOutcome, useFcToolPhase} from '../../../platforms/react-native/protocol';
import type {FcToolOutcome, FcToolsController} from '../../../platforms/react-native/protocol';
import {colors, radii, spacing, typography} from '../../theme';

/** Android's minimum recommended touch target. */
const MIN_TOUCH_TARGET = 44;

export interface FcToolsSectionProps {
  sessionId: string;
  /** Everything the pure gate needs except `busy`, which this component
   * reads from the shared mutex itself. */
  gate: Omit<FcToolGateInput, 'busy'>;
  /** Injectable for tests; defaults to the app-wide singleton. */
  controller?: FcToolsController;
}

export default function FcToolsSection({sessionId, gate, controller}: FcToolsSectionProps): React.JSX.Element {
  const {t} = useTranslation();
  const active = controller ?? fcToolsController;
  const phase = useFcToolPhase(active);
  const outcome = useFcToolOutcome(active);
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
      <Text style={styles.sectionTitle} accessibilityRole="header" testID="fc-tools-title">
        {t('fcTools.title')}
      </Text>

      {FC_TOOL_IDS.map(tool => {
        const availability = resolveFcToolAvailability(tool, {...gate, busy});
        const name = t(`fcTools.toolNames.${tool}`);
        const description = t(`fcTools.toolDescriptions.${tool}`);
        const reasonText = availability.reason === undefined ? undefined : t(`fcTools.disabledReasons.${availability.reason}`);
        return (
          <View key={tool} style={styles.tool} testID={`fc-tool-${tool}`}>
            <Pressable
              onPress={() => onRequest(tool)}
              disabled={!availability.enabled}
              accessibilityRole="button"
              accessibilityState={{disabled: !availability.enabled}}
              accessibilityLabel={reasonText === undefined ? name : `${name}، ${reasonText}`}
              accessibilityHint={availability.enabled ? t('fcTools.hint') : undefined}
              style={[styles.toolButton, availability.enabled ? styles.toolButtonEnabled : styles.toolButtonDisabled]}
              testID={`fc-tool-${tool}-button`}>
              <Text style={availability.enabled ? styles.toolNameEnabled : styles.toolNameDisabled}>{name}</Text>
            </Pressable>
            <Text style={styles.toolDescription} testID={`fc-tool-${tool}-description`}>
              {description}
            </Text>
            {reasonText !== undefined && (
              <Text style={styles.toolReason} testID={`fc-tool-${tool}-reason`}>
                {reasonText}
              </Text>
            )}
          </View>
        );
      })}

      {phase.kind === 'CONFIRMING' && (
        <View style={styles.confirmation} accessibilityRole="alert" testID="fc-tools-confirmation">
          <Text style={styles.confirmTitle}>{t('fcTools.confirmTitle')}</Text>
          <Text style={styles.confirmBody} testID="fc-tools-confirmation-body">
            {t(`fcTools.confirmBodies.${phase.tool}`)}
          </Text>
          <Pressable
            onPress={onConfirm}
            accessibilityRole="button"
            accessibilityLabel={t('fcTools.confirmAction')}
            style={[styles.toolButton, styles.confirmButton]}
            testID="fc-tools-confirm">
            <Text style={styles.confirmActionText}>{t('fcTools.confirmAction')}</Text>
          </Pressable>
          <Pressable
            onPress={onCancel}
            accessibilityRole="button"
            accessibilityLabel={t('fcTools.cancelAction')}
            style={[styles.toolButton, styles.cancelButton]}
            testID="fc-tools-cancel">
            <Text style={styles.cancelActionText}>{t('fcTools.cancelAction')}</Text>
          </Pressable>
        </View>
      )}

      {outcome !== undefined && (
        <Text style={styles.outcome} accessibilityRole="alert" testID="fc-tools-outcome">
          {describeOutcome(outcome, t)}
        </Text>
      )}
    </View>
  );
}

type Translate = ReturnType<typeof useTranslation>['t'];

/** Never claims more than the firmware actually confirmed. */
function describeOutcome(outcome: FcToolOutcome, t: Translate): string {
  switch (outcome.kind) {
    case 'ACCEPTED':
      return t('fcTools.outcomeAccepted');
    case 'REBOOT_REQUESTED':
      return t('fcTools.outcomeRebootRequested');
    case 'UNCONFIRMED':
      return t('fcTools.outcomeUnconfirmed');
    case 'FAILED':
      return t('fcTools.outcomeFailed');
    case 'REJECTED':
      return t('fcTools.outcomeRejected', {reason: t(`fcTools.disabledReasons.${outcome.reason}`)});
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
    padding: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceAlt,
  },
  sectionTitle: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
  },
  tool: {
    marginTop: spacing.md,
  },
  toolButton: {
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  toolButtonEnabled: {
    borderColor: colors.accent,
    backgroundColor: colors.surface,
  },
  toolButtonDisabled: {
    borderColor: colors.border,
    backgroundColor: 'transparent',
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
    marginTop: spacing.xs,
  },
  toolReason: {
    ...typography.caption,
    color: colors.warning,
    marginTop: spacing.xs,
    fontWeight: '600',
  },
  confirmation: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.warning,
    backgroundColor: colors.surface,
  },
  confirmTitle: {
    ...typography.sectionTitle,
    color: colors.warning,
  },
  confirmBody: {
    ...typography.body,
    color: colors.textPrimary,
    marginTop: spacing.sm,
  },
  confirmButton: {
    marginTop: spacing.md,
    borderColor: colors.warning,
  },
  cancelButton: {
    marginTop: spacing.sm,
    borderColor: colors.border,
  },
  confirmActionText: {
    ...typography.body,
    color: colors.warning,
    fontWeight: '700',
  },
  cancelActionText: {
    ...typography.body,
    color: colors.textSecondary,
  },
  outcome: {
    ...typography.body,
    color: colors.textPrimary,
    marginTop: spacing.md,
  },
});
