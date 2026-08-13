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
 *  - current / consumed-mAh are rendered only when the FC reports both a
 *    detected pack and a non-zero value, explicitly labelled as reported.
 *    Zero and not-present states remain hidden because this command cannot
 *    distinguish residual registers from an absent meter;
 *  - no percentage, level bar, state-of-charge estimate, thresholds, or
 *    app-derived health - the approved "نسبة الشحن غير متاحة" line
 *    honestly replaces the reference mock's percentage bar;
 *  - STALE freezes the last real values, dimmed, with the approved stale
 *    label - mirroring OrientationHero's established stale treatment.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import type {
  MspBatteryState,
  TelemetryValue,
  BatteryFirmwareState,
} from '../../../core';
import { deriveBatterySemantics } from '../../../core';
import { colors, radii, spacing, typography } from '../../theme';

const STALE_OPACITY = 0.45;

export interface BatteryCardProps {
  telemetry: TelemetryValue<MspBatteryState>;
}

function firmwareStateKey(state: BatteryFirmwareState): string | undefined {
  return typeof state === 'string' ? `batteryCard.state.${state}` : undefined;
}

export default function BatteryCard({
  telemetry,
}: BatteryCardProps): React.JSX.Element {
  const { t } = useTranslation();

  if (telemetry.status === 'UNAVAILABLE') {
    return renderMessage(
      t('batteryCard.title'),
      t('batteryCard.unavailable'),
      'battery-card-unavailable',
    );
  }
  if (telemetry.status === 'WAITING') {
    return renderMessage(
      t('batteryCard.title'),
      t('batteryCard.waiting'),
      'battery-card-waiting',
    );
  }
  if (telemetry.status === 'ERROR') {
    return renderMessage(
      t('batteryCard.title'),
      t('batteryCard.error'),
      'battery-card-error',
    );
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
  /**
   * Checkpoint F (HW-002). A real board reported ~0.17 V while a LiPo
   * appeared connected, and this card printed "0.17 V" in its primary
   * value slot - a number that reads as a live pack voltage and is not
   * one.
   *
   * The discriminator is the FIRMWARE'S OWN, not an app-invented
   * threshold: `cellCount === 0` is Betaflight's verified "battery not
   * detected" (msp.c's own encoder comment, see decodeBatteryState.ts)
   * and `BATTERY_NOT_PRESENT` is its own enum member. NO minimum-valid-
   * voltage constant is introduced anywhere - this card still cannot,
   * and does not, judge a voltage.
   *
   * When the firmware says there is no pack, the measured value is a
   * residual voltage-divider reading. It is still shown - hiding a real
   * reading was never acceptable and is not now - but it moves OUT of
   * the primary slot into an explicitly labelled diagnostic line, and
   * the headline states that no battery measurement is available. No
   * replacement voltage is guessed, and nothing is zeroed.
   */
  const measurementProven =
    semantics.detection === 'DETECTED' &&
    semantics.firmwareState !== 'NOT_PRESENT';
  // A NOT_DETECTED pack can leave non-zero measurement registers behind.
  // Keep the real voltage visible for diagnosis, but do not present those
  // residual registers as current/consumption for a battery the FC itself
  // says it has not detected.
  const canShowReportedDetails = measurementProven;
  const currentText =
    canShowReportedDetails &&
    semantics.current.sensorValidity === 'REPORTED_NONZERO'
      ? t('batteryCard.reportedCurrent', {
          value: (semantics.current.centiamps / 100).toFixed(2),
        })
      : undefined;
  const consumedText =
    canShowReportedDetails &&
    semantics.consumed.sensorValidity === 'REPORTED_NONZERO'
      ? t('batteryCard.reportedConsumed', {
          value: semantics.consumed.mah,
        })
      : undefined;
  const reportedDetails = [currentText, consumedText].filter(
    (value): value is string => value !== undefined,
  );

  const rawVoltageText = t('batteryCard.reportedRawVoltage', {
    value: semantics.voltageVolts.toFixed(2),
  });
  const cellText =
    measurementProven && semantics.cellCount > 0
      ? t('batteryCard.cellCount', {count: semantics.cellCount})
      : undefined;
  const accessibilityLabel = measurementProven
    ? `${t('batteryCard.title')}، ${t(
        'batteryCard.voltageLabel',
      )} ${voltageText}، ${stateText}${
        cellText !== undefined ? `، ${cellText}` : ''
      }${isStale ? `، ${t('batteryCard.stale')}` : ''}${
        reportedDetails.length > 0 ? `، ${reportedDetails.join('، ')}` : ''
      }`
    : `${t('batteryCard.title')}، ${t(
        'batteryCard.noMeasurement',
      )}، ${stateText}، ${rawVoltageText}${
        isStale ? `، ${t('batteryCard.stale')}` : ''
      }`;

  return (
    <View
      style={styles.container}
      accessible
      accessibilityLabel={accessibilityLabel}
      testID={isStale ? 'battery-card-stale' : 'battery-card-live'}
    >
      <View style={isStale ? styles.staleContent : undefined}>
        <Text style={styles.title}>{t('batteryCard.title')}</Text>
        {measurementProven ? (
          <View style={styles.valueRow}>
            <Text style={styles.valueLabel}>
              {t('batteryCard.voltageLabel')}
            </Text>
            <Text style={styles.valueText} testID="battery-card-voltage">
              {voltageText}
            </Text>
          </View>
        ) : (
          <Text
            style={styles.noMeasurementText}
            testID="battery-card-no-measurement"
          >
            {t('batteryCard.noMeasurement')}
          </Text>
        )}
        <Text style={styles.stateText} testID="battery-card-state">
          {stateText}
        </Text>
        {measurementProven ? null : (
          <Text
            style={styles.captionText}
            testID="battery-card-raw-voltage"
          >
            {rawVoltageText}
          </Text>
        )}
        {/* SETUP P2: cell count, shown ONLY when the firmware itself
            proved a pack. cellCount === 0 is Betaflight's own "battery
            not detected", which the measurementProven gate above already
            routes to the no-measurement headline - so a count can never
            appear next to a reading the FC does not stand behind. */}
        {measurementProven && semantics.cellCount > 0 ? (
          <Text style={styles.captionText} testID="battery-card-cells">
            {t('batteryCard.cellCount', {count: semantics.cellCount})}
          </Text>
        ) : null}
        {reportedDetails.map((detail, index) => (
          <Text
            key={detail}
            style={styles.reportedText}
            testID={`battery-card-reported-${index}`}
          >
            {detail}
          </Text>
        ))}
        {/* SETUP P2: the permanent "نسبة الشحن غير متاحة" line is GONE.
            It spent a line of every phone viewport, in every state, to
            announce the absence of a number this app deliberately never
            computes. Saying nothing is the honest use of that space; the
            refusal to invent a percentage is unchanged and is enforced by
            batteryTelemetry.ts, not by a caption. */}
      </View>
      {isStale && (
        <Text style={styles.staleLabel} testID="battery-card-stale-label">
          {t('batteryCard.stale')}
        </Text>
      )}
    </View>
  );
}

function renderMessage(
  title: string,
  message: string,
  testID: string,
): React.JSX.Element {
  return (
    <View
      style={styles.container}
      accessible
      accessibilityLabel={`${title}، ${message}`}
      testID={testID}
    >
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.messageText}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    // Pass 7.6c: outer placement margins moved to SetupScreen's card
    // grid cells (the card now lives in the 2x2 grid); flex: 1 lets all
    // four cards in a grid row stretch to equal height.
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    flex: 1,
    shadowColor: colors.shadow,
    shadowOpacity: 0.14,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  title: {
    ...typography.sectionTitle,
    color: colors.accentStrong,
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
  /* The headline when the FC itself reports no pack. Deliberately the
     same weight the voltage used to occupy, so nothing else on the card
     can out-shout it. */
  noMeasurementText: {
    ...typography.sectionTitle,
    color: colors.textSecondary,
    marginTop: spacing.sm,
  },
  captionText: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
  reportedText: {
    ...typography.caption,
    color: colors.info,
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
