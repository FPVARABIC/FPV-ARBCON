import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import type { DshotEscDirection } from '../../core';
import type { MotorVerificationState } from '../../core/state/motorVerificationModel';
import {
  motorConfigurationController,
  type EscDirectionOutcome,
} from '../../platforms/react-native/protocol';
import { colors, radii, spacing, typography } from '../theme';

export interface EscDirectionControllerPort {
  setEscDirection(
    sessionId: string,
    motorNumber: number,
    direction: DshotEscDirection,
  ): Promise<EscDirectionOutcome>;
}

export interface EscDirectionPanelProps {
  readonly sessionId: string;
  readonly verification: MotorVerificationState;
  readonly onEndMotorTestSession: () => Promise<void>;
  readonly controller?: EscDirectionControllerPort;
}

function resultText(
  t: (key: string) => string,
  outcome: EscDirectionOutcome,
): { text: string; danger: boolean } {
  switch (outcome.kind) {
    case 'ACKNOWLEDGED':
      return { text: t('escDirection.acknowledged'), danger: false };
    case 'UNCONFIRMED':
      return { text: t('escDirection.unconfirmed'), danger: true };
    case 'REJECTED':
      return {
        text:
          outcome.reason === 'ESC_DIRECTION_UNSUPPORTED'
            ? t('escDirection.unsupported')
            : t('escDirection.rejected'),
        danger: true,
      };
    case 'SESSION_ENDED':
      return { text: t('escDirection.sessionEnded'), danger: true };
    case 'FAILED':
      return { text: t('escDirection.failed'), danger: true };
  }
}

export function EscDirectionPanel({
  sessionId,
  verification,
  onEndMotorTestSession,
  controller = motorConfigurationController,
}: EscDirectionPanelProps): React.JSX.Element {
  const { t } = useTranslation();
  const observedMotors = useMemo(
    () =>
      verification.entries
        .filter(entry => entry.observation?.kind === 'OBSERVED')
        .map(entry => entry.motorNumber),
    [verification.entries],
  );
  const [motorNumber, setMotorNumber] = useState(observedMotors[0] ?? 1);
  const [direction, setDirection] = useState<DshotEscDirection>('NORMAL');
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    { text: string; danger: boolean } | undefined
  >();
  const selectedObserved = observedMotors.includes(motorNumber);

  const apply = useCallback(async () => {
    if (!reviewing || busy || !selectedObserved) {
      return;
    }
    setBusy(true);
    setResult(undefined);
    try {
      await onEndMotorTestSession();
      const outcome = await controller.setEscDirection(
        sessionId,
        motorNumber,
        direction,
      );
      setResult(resultText(t, outcome));
      setReviewing(false);
    } catch {
      setResult({ text: t('escDirection.failed'), danger: true });
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    controller,
    direction,
    motorNumber,
    onEndMotorTestSession,
    reviewing,
    selectedObserved,
    sessionId,
    t,
  ]);

  return (
    <View style={styles.root} testID="esc-direction-panel">
      <Text style={styles.eyebrow}>{t('escDirection.eyebrow')}</Text>
      <Text style={styles.title}>{t('escDirection.title')}</Text>
      <Text style={styles.caption}>{t('escDirection.subtitle')}</Text>
      <Text style={styles.warning}>{t('escDirection.physicalCaveat')}</Text>

      <Text style={styles.sectionTitle}>{t('escDirection.motor')}</Text>
      <View style={styles.optionRow}>
        {[1, 2, 3, 4].map(slot => {
          const available = observedMotors.includes(slot);
          return (
            <Pressable
              key={slot}
              onPress={() => {
                if (available && !busy) {
                  setMotorNumber(slot);
                  setReviewing(false);
                  setResult(undefined);
                }
              }}
              disabled={!available || busy}
              accessibilityRole="radio"
              accessibilityState={{
                selected: motorNumber === slot,
                disabled: !available || busy,
              }}
              style={[
                styles.option,
                motorNumber === slot && styles.optionSelected,
                !available && styles.optionDisabled,
              ]}
              testID={`esc-direction-motor-${slot}`}
            >
              <Text style={styles.optionText}>{`M${slot}`}</Text>
            </Pressable>
          );
        })}
      </View>

      <Text style={styles.sectionTitle}>{t('escDirection.target')}</Text>
      <View style={styles.optionRow}>
        {(['NORMAL', 'REVERSED'] as const).map(value => (
          <Pressable
            key={value}
            onPress={() => {
              if (!busy) {
                setDirection(value);
                setReviewing(false);
                setResult(undefined);
              }
            }}
            disabled={busy}
            accessibilityRole="radio"
            accessibilityState={{ selected: direction === value }}
            style={[
              styles.directionOption,
              direction === value && styles.optionSelected,
            ]}
            testID={`esc-direction-${value.toLowerCase()}`}
          >
            <Text style={styles.optionText}>
              {value === 'NORMAL'
                ? t('escDirection.normal')
                : t('escDirection.reversed')}
            </Text>
          </Pressable>
        ))}
      </View>

      {reviewing ? (
        <View style={styles.confirmation} testID="esc-direction-confirmation">
          <Text style={styles.sectionTitle}>
            {t('escDirection.confirmTitle', {
              motor: motorNumber,
              direction:
                direction === 'NORMAL'
                  ? t('escDirection.normal')
                  : t('escDirection.reversed'),
            })}
          </Text>
          <Text style={styles.caption}>{t('escDirection.confirmBody')}</Text>
          <Pressable
            onPress={apply}
            disabled={busy}
            accessibilityRole="button"
            style={styles.dangerButton}
            testID="esc-direction-apply"
          >
            <Text style={styles.dangerButtonText}>
              {busy ? t('escDirection.sending') : t('escDirection.confirm')}
            </Text>
          </Pressable>
        </View>
      ) : (
        <Pressable
          onPress={() => setReviewing(true)}
          disabled={!selectedObserved || busy}
          accessibilityRole="button"
          accessibilityState={{ disabled: !selectedObserved || busy }}
          style={[
            styles.primaryButton,
            (!selectedObserved || busy) && styles.optionDisabled,
          ]}
          testID="esc-direction-review"
        >
          <Text style={styles.primaryButtonText}>
            {t('escDirection.review')}
          </Text>
        </Pressable>
      )}

      {observedMotors.length === 0 ? (
        <Text style={styles.caption} testID="esc-direction-needs-observation">
          {t('escDirection.needsObservation')}
        </Text>
      ) : null}
      {result !== undefined ? (
        <Text
          style={result.danger ? styles.resultDanger : styles.resultGood}
          testID="esc-direction-result"
        >
          {result.text}
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
    color: colors.accent,
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
  warning: {
    ...typography.body,
    color: colors.warning,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  sectionTitle: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '800',
    writingDirection: 'rtl',
  },
  optionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  option: {
    minWidth: 56,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: colors.borderSoft,
    borderWidth: 1,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceAlt,
    padding: spacing.sm,
  },
  directionOption: {
    flex: 1,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: colors.borderSoft,
    borderWidth: 1,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceAlt,
    padding: spacing.sm,
  },
  optionSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
  },
  optionDisabled: { opacity: 0.4 },
  optionText: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '800',
    writingDirection: 'rtl',
  },
  confirmation: {
    gap: spacing.sm,
    padding: spacing.md,
    borderColor: colors.warning,
    borderWidth: 1,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceAlt,
  },
  primaryButton: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    backgroundColor: colors.accent,
    padding: spacing.md,
  },
  primaryButtonText: {
    ...typography.body,
    color: colors.background,
    fontWeight: '900',
    writingDirection: 'rtl',
  },
  dangerButton: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    backgroundColor: colors.warning,
    padding: spacing.md,
  },
  dangerButtonText: {
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
});
