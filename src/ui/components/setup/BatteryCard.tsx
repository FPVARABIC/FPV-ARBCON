/**
 * Pass 7.6b - Region 3's first summary card: BATTERY, display-only,
 * driven entirely by the Pass 7.6a foundation
 * (useTelemetryValue(BATTERY_TELEMETRY_POLL_ID) -> decodeBatteryState ->
 * deriveBatterySemantics). Like SafetyStrip/OrientationHero, this
 * component owns no polling, no timers, and no store state - it renders
 * exactly the TelemetryValue snapshot its caller (SetupScreen) passes in.
 *
 * TRUTHFULNESS RULES (the approved Pass 7.6b product contract):
 *  - the canonical high-resolution voltage is the primary value;
 *  - the firmware-reported battery state is the ONLY supporting state
 *    (verified enum; an unknown raw value renders the approved "state
 *    unknown" text, never a false all-clear);
 *  - cellCount 0 renders the approved "battery not detected" text (the
 *    firmware's own verified meaning) while STILL showing the real
 *    measured voltage - a genuine reading is never hidden, and missing
 *    data is never turned into "0.00 V";
 *  - current / consumed-mAh are NOT rendered: MSP_BATTERY_STATE carries
 *    no current-meter-presence flag (SENSOR_VALIDITY UNPROVEN in the
 *    foundation), and the approved copy shows field labels only "when
 *    their values are semantically trustworthy";
 *  - no percentage, level bar, state-of-charge estimate, thresholds, or
 *    app-derived health - the approved "نسبة الشحن غير متاحة" line
 *    honestly replaces the reference mock's percentage bar;
 *  - STALE freezes the last real values, dimmed, with the approved stale
 *    label - mirroring OrientationHero's established stale treatment.
 */

import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {useTranslation} from 'react-i18next';

import type {MspBatteryState, TelemetryValue, BatteryFirmwareState} from '../../../core';
import {deriveBatterySemantics} from '../../../core';
import {colors, radii, spacing, typography} from '../../theme';

const STALE_OPACITY = 0.45;

export interface BatteryCardProps {
  telemetry: TelemetryValue<MspBatteryState>;
}

function firmwareStateKey(state: BatteryFirmwareState): string | undefined {
  return typeof state === 'string' ? `batteryCard.state.${state}` : undefined;
}

export default function BatteryCard({telemetry}: BatteryCardProps): React.JSX.Element {
  const {t} = useTranslation();

  if (telemetry.status === 'UNAVAILABLE') {
    return renderMessage(t('batteryCard.title'), t('batteryCard.unavailable'), 'battery-card-unavailable');
  }
  if (telemetry.status === 'WAITING') {
    return renderMessage(t('batteryCard.title'), t('batteryCard.waiting'), 'battery-card-waiting');
  }
  if (telemetry.status === 'ERROR') {
    return renderMessage(t('batteryCard.title'), t('batteryCard.error'), 'battery-card-error');
  }

  const isStale = telemetry.status === 'STALE';
  const semantics = deriveBatterySemantics(telemetry.value);
  const voltageText = `${semantics.voltageVolts.toFixed(2)} V`;
  const stateKey = firmwareStateKey(semantics.firmwareState);
  const stateText =
    semantics.detection === 'NOT_DETECTED'
      ? t('batteryCard.notDetected')
      : stateKey !== undefined
        ? t(stateKey)
        : t('batteryCard.stateUnknown');

  const accessibilityLabel = `${t('batteryCard.title')}، ${t('batteryCard.voltageLabel')} ${voltageText}، ${stateText}${
    isStale ? `، ${t('batteryCard.stale')}` : ''
  }`;

  return (
    <View
      style={styles.container}
      accessible
      accessibilityLabel={accessibilityLabel}
      testID={isStale ? 'battery-card-stale' : 'battery-card-live'}>
      <View style={isStale ? styles.staleContent : undefined}>
        <Text style={styles.title}>{t('batteryCard.title')}</Text>
        <View style={styles.valueRow}>
          <Text style={styles.valueLabel}>{t('batteryCard.voltageLabel')}</Text>
          <Text style={styles.valueText} testID="battery-card-voltage">
            {voltageText}
          </Text>
        </View>
        <Text style={styles.stateText} testID="battery-card-state">
          {stateText}
        </Text>
        <Text style={styles.captionText}>{t('batteryCard.percentageUnavailable')}</Text>
      </View>
      {isStale && (
        <Text style={styles.staleLabel} testID="battery-card-stale-label">
          {t('batteryCard.stale')}
        </Text>
      )}
    </View>
  );
}

function renderMessage(title: string, message: string, testID: string): React.JSX.Element {
  return (
    <View style={styles.container} accessible accessibilityLabel={`${title}، ${message}`} testID={testID}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.messageText}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: spacing.md,
    marginHorizontal: spacing.lg,
    padding: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceAlt,
  },
  title: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
  },
  valueRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
  },
  valueLabel: {
    ...typography.body,
    color: colors.textSecondary,
  },
  valueText: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    fontVariant: ['tabular-nums'],
    writingDirection: 'ltr',
  },
  stateText: {
    ...typography.body,
    color: colors.textPrimary,
    marginTop: spacing.xs,
  },
  captionText: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
  messageText: {
    ...typography.body,
    color: colors.textSecondary,
    marginTop: spacing.sm,
  },
  staleContent: {
    opacity: STALE_OPACITY,
  },
  staleLabel: {
    ...typography.caption,
    color: colors.warning,
    fontWeight: '600',
    marginTop: spacing.sm,
  },
});
