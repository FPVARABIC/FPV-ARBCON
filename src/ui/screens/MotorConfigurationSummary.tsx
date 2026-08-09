/**
 * Read-only presentation of the three motor facts the accepted bench
 * controller actually reads from the flight controller.
 *
 * This component deliberately receives an already-decoded MotorVectorScope.
 * It performs no MSP request, owns no session, evaluates no safety gate and
 * exposes no control. A missing value stays visibly unavailable rather than
 * being replaced with a plausible default.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import type { MotorVectorScope } from '../../core/firmware-adapters/betaflightMotorVectorsV147';
import { colors, radii, spacing, typography } from '../theme';

const MOTOR_PROTOCOL_NAMES: Readonly<Record<number, string>> = Object.freeze({
  0: 'PWM',
  1: 'ONESHOT125',
  2: 'ONESHOT42',
  3: 'MULTISHOT',
  4: 'BRUSHED',
  5: 'DSHOT150',
  6: 'DSHOT300',
  7: 'DSHOT600',
  8: 'PROSHOT1000',
  9: 'DISABLED',
});

/** Version-scoped display helper. Unknown raw values remain explicit. */
export function formatMotorProtocol(raw: number | undefined): string {
  if (raw === undefined) {
    return '—';
  }
  return MOTOR_PROTOCOL_NAMES[raw] ?? `RAW ${raw}`;
}

export interface MotorConfigurationSummaryProps {
  readonly scope: MotorVectorScope | undefined;
}

export function MotorConfigurationSummary({
  scope,
}: MotorConfigurationSummaryProps): React.JSX.Element {
  const { t } = useTranslation();

  const facts = [
    {
      id: 'count',
      label: t('motorsScreen.configMotorCount'),
      value: scope === undefined ? '—' : String(scope.motorCount),
      tone: styles.factValue,
    },
    {
      id: 'protocol',
      label: t('motorsScreen.configProtocol'),
      value: formatMotorProtocol(scope?.motorProtocolRaw),
      tone: styles.factValue,
    },
    {
      id: '3d',
      label: t('motorsScreen.config3d'),
      value:
        scope === undefined
          ? '—'
          : scope.feature3dEnabled
          ? t('motorsScreen.configEnabled')
          : t('motorsScreen.configDisabled'),
      tone:
        scope === undefined
          ? styles.factValue
          : scope.feature3dEnabled
          ? styles.factValueDanger
          : styles.factValueGood,
    },
  ] as const;

  return (
    <View style={styles.root} testID="motor-configuration-summary">
      <View style={styles.headingRow}>
        <View style={styles.headingCopy}>
          <Text style={styles.title}>{t('motorsScreen.configHeading')}</Text>
          <Text style={styles.caption}>
            {scope === undefined
              ? t('motorsScreen.configWaiting')
              : t('motorsScreen.configLiveSource')}
          </Text>
        </View>
        <View style={styles.readOnlyBadge}>
          <Text style={styles.readOnlyText}>
            {t('motorsScreen.configReadOnly')}
          </Text>
        </View>
      </View>

      <View style={styles.factRow}>
        {facts.map(fact => (
          <View
            key={fact.id}
            style={styles.fact}
            testID={`motor-config-${fact.id}`}
          >
            <Text style={styles.factLabel}>{fact.label}</Text>
            <Text style={fact.tone}>{fact.value}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: spacing.md,
    backgroundColor: colors.backgroundRaised,
    borderColor: colors.borderSoft,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  headingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  headingCopy: { flex: 1, gap: 2 },
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
  readOnlyBadge: {
    borderRadius: radii.pill,
    backgroundColor: colors.accentSoft,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  readOnlyText: {
    ...typography.caption,
    color: colors.accentStrong,
    fontWeight: '700',
    writingDirection: 'rtl',
  },
  factRow: { flexDirection: 'row', gap: spacing.sm },
  fact: {
    flex: 1,
    minHeight: 70,
    justifyContent: 'space-between',
    gap: spacing.xs,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radii.sm,
    padding: spacing.sm,
  },
  factLabel: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
  factValue: {
    ...typography.mono,
    color: colors.textPrimary,
    textAlign: 'center',
    writingDirection: 'ltr',
  },
  factValueGood: {
    ...typography.body,
    color: colors.success,
    fontWeight: '700',
    textAlign: 'center',
    writingDirection: 'rtl',
  },
  factValueDanger: {
    ...typography.body,
    color: colors.error,
    fontWeight: '700',
    textAlign: 'center',
    writingDirection: 'rtl',
  },
});
