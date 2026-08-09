import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { deriveMotorOutputOrder } from '../../core';
import type { MotorVerificationState } from '../../core/state/motorVerificationModel';
import {
  motorConfigurationController,
  type MotorOutputOrderLoadOutcome,
  type MotorOutputOrderSaveOutcome,
} from '../../platforms/react-native/protocol';
import { colors, radii, spacing, typography } from '../theme';

export interface MotorOutputOrderControllerPort {
  loadOutputOrder(sessionId: string): Promise<MotorOutputOrderLoadOutcome>;
  saveOutputOrder(
    sessionId: string,
    original: readonly number[],
    desired: readonly number[],
  ): Promise<MotorOutputOrderSaveOutcome>;
}

export interface MotorOutputReorderPanelProps {
  readonly sessionId: string;
  readonly verification: MotorVerificationState;
  readonly onEndMotorTestSession: () => Promise<void>;
  readonly controller?: MotorOutputOrderControllerPort;
  readonly onDirtyChange?: (dirty: boolean) => void;
}

type Phase = 'IDLE' | 'PREPARING' | 'REVIEW' | 'SAVING' | 'DONE' | 'ERROR';

function outcomeMessage(
  t: (key: string) => string,
  outcome: MotorOutputOrderSaveOutcome,
): { text: string; danger: boolean } {
  switch (outcome.kind) {
    case 'NO_CHANGES':
      return { text: t('motorOutputReorder.noChanges'), danger: false };
    case 'SAVED_VERIFIED':
      return { text: t('motorOutputReorder.saved'), danger: false };
    case 'SAVED_UNVERIFIED':
      return { text: t('motorOutputReorder.savedUnverified'), danger: true };
    case 'UNCONFIRMED':
      return { text: t('motorOutputReorder.unconfirmed'), danger: true };
    case 'REJECTED':
      return { text: t('motorOutputReorder.rejected'), danger: true };
    case 'SESSION_ENDED':
      return { text: t('motorOutputReorder.sessionEnded'), danger: true };
    case 'FAILED':
      return { text: t('motorOutputReorder.failed'), danger: true };
  }
}

export function MotorOutputReorderPanel({
  sessionId,
  verification,
  onEndMotorTestSession,
  controller = motorConfigurationController,
  onDirtyChange,
}: MotorOutputReorderPanelProps): React.JSX.Element {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('IDLE');
  const [original, setOriginal] = useState<readonly number[]>();
  const [desired, setDesired] = useState<readonly number[]>();
  const [result, setResult] = useState<
    { text: string; danger: boolean } | undefined
  >();

  const evidence = useMemo(
    () => deriveMotorOutputOrder([0, 1, 2, 3], verification),
    [verification],
  );
  const ready = evidence.kind === 'READY';

  useEffect(() => {
    const dirty = phase === 'REVIEW';
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [onDirtyChange, phase]);

  const prepare = useCallback(async () => {
    if (!ready || phase === 'PREPARING' || phase === 'SAVING') {
      return;
    }
    setPhase('PREPARING');
    setResult(undefined);
    try {
      // Reordering cannot race an accepted motor pulse. Finish the existing
      // bench session first; the controller then takes its own exclusive
      // settings lease and fresh DISARMED proof.
      await onEndMotorTestSession();
      const loaded = await controller.loadOutputOrder(sessionId);
      if (loaded.kind !== 'LOADED') {
        setResult({
          text:
            loaded.kind === 'REJECTED'
              ? t('motorOutputReorder.rejected')
              : loaded.kind === 'SESSION_ENDED'
              ? t('motorOutputReorder.sessionEnded')
              : t('motorOutputReorder.failed'),
          danger: true,
        });
        setPhase('ERROR');
        return;
      }
      const derived = deriveMotorOutputOrder(loaded.values, verification);
      if (derived.kind !== 'READY') {
        setResult({ text: t('motorOutputReorder.incomplete'), danger: true });
        setPhase('ERROR');
        return;
      }
      setOriginal(loaded.values);
      setDesired(derived.values);
      setPhase('REVIEW');
    } catch {
      setResult({ text: t('motorOutputReorder.failed'), danger: true });
      setPhase('ERROR');
    }
  }, [
    controller,
    onEndMotorTestSession,
    phase,
    ready,
    sessionId,
    t,
    verification,
  ]);

  const save = useCallback(async () => {
    if (phase !== 'REVIEW' || original === undefined || desired === undefined) {
      return;
    }
    setPhase('SAVING');
    const outcome = await controller.saveOutputOrder(
      sessionId,
      original,
      desired,
    );
    const message = outcomeMessage(t, outcome);
    setResult(message);
    setPhase(
      outcome.kind === 'SAVED_VERIFIED' || outcome.kind === 'NO_CHANGES'
        ? 'DONE'
        : 'ERROR',
    );
  }, [controller, desired, original, phase, sessionId, t]);

  return (
    <View style={styles.root} testID="motor-output-reorder-panel">
      <Text style={styles.eyebrow}>{t('motorOutputReorder.eyebrow')}</Text>
      <Text style={styles.title}>{t('motorOutputReorder.title')}</Text>
      <Text style={styles.caption}>{t('motorOutputReorder.subtitle')}</Text>

      {!ready ? (
        <View style={styles.notice} testID="motor-output-reorder-incomplete">
          <Text style={styles.noticeTitle}>
            {t('motorOutputReorder.incomplete')}
          </Text>
          <Text style={styles.caption}>
            {t('motorOutputReorder.incompleteDetail')}
          </Text>
        </View>
      ) : null}

      {phase === 'REVIEW' && original !== undefined && desired !== undefined ? (
        <View style={styles.review} testID="motor-output-reorder-review">
          <Text style={styles.noticeTitle}>
            {t('motorOutputReorder.reviewTitle')}
          </Text>
          <Text style={styles.caption}>
            {t('motorOutputReorder.reviewWarning')}
          </Text>
          <View style={styles.mapRow}>
            {desired.map((resource, index) => (
              <View key={index} style={styles.mapCell}>
                <Text style={styles.mapMotor}>{`M${index + 1}`}</Text>
                <Text style={styles.mapArrow}>←</Text>
                <Text style={styles.mapResource}>
                  {t('motorOutputReorder.resource', { value: resource + 1 })}
                </Text>
              </View>
            ))}
          </View>
          <Pressable
            onPress={save}
            accessibilityRole="button"
            style={styles.primaryButton}
            testID="motor-output-reorder-save"
          >
            <Text style={styles.primaryButtonText}>
              {t('motorOutputReorder.confirmSave')}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {result !== undefined ? (
        <Text
          style={result.danger ? styles.resultDanger : styles.resultGood}
          testID="motor-output-reorder-result"
        >
          {result.text}
        </Text>
      ) : null}

      {phase === 'IDLE' || phase === 'ERROR' ? (
        <Pressable
          onPress={prepare}
          disabled={!ready}
          accessibilityRole="button"
          accessibilityState={{ disabled: !ready }}
          style={[styles.primaryButton, !ready && styles.buttonDisabled]}
          testID="motor-output-reorder-prepare"
        >
          <Text style={styles.primaryButtonText}>
            {t('motorOutputReorder.prepare')}
          </Text>
        </Pressable>
      ) : null}

      {phase === 'PREPARING' || phase === 'SAVING' ? (
        <Text style={styles.progress} testID="motor-output-reorder-progress">
          {phase === 'PREPARING'
            ? t('motorOutputReorder.preparing')
            : t('motorOutputReorder.saving')}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: spacing.sm,
    backgroundColor: colors.backgroundRaised,
    borderColor: colors.borderSoft,
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
  },
  eyebrow: {
    ...typography.eyebrow,
    color: colors.accentStrong,
    writingDirection: 'rtl',
  },
  title: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    writingDirection: 'rtl',
  },
  caption: {
    ...typography.caption,
    color: colors.textSecondary,
    writingDirection: 'rtl',
  },
  notice: {
    gap: spacing.xs,
    padding: spacing.md,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radii.md,
  },
  noticeTitle: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '800',
    writingDirection: 'rtl',
  },
  review: { gap: spacing.md },
  mapRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  mapCell: {
    flexGrow: 1,
    flexBasis: '46%',
    minWidth: 130,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    padding: spacing.md,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radii.md,
  },
  mapMotor: {
    ...typography.mono,
    color: colors.accentStrong,
    fontWeight: '900',
  },
  mapArrow: { ...typography.body, color: colors.textMuted },
  mapResource: {
    ...typography.caption,
    color: colors.textPrimary,
    writingDirection: 'rtl',
  },
  primaryButton: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  buttonDisabled: { backgroundColor: colors.disabled },
  primaryButtonText: {
    ...typography.body,
    color: colors.background,
    fontWeight: '900',
    writingDirection: 'rtl',
  },
  resultDanger: {
    ...typography.body,
    color: colors.error,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  resultGood: {
    ...typography.body,
    color: colors.success,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  progress: {
    ...typography.body,
    color: colors.accentStrong,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
});
