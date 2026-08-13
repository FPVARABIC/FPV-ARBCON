/**
 * SETUP P2 - the sensor summary, promoted out of the diagnostics
 * disclosure and into the dashboard.
 *
 * P0 measured the sensor mask arriving at Setup only through
 * DiagnosticsSection, at y=3241 on a 390px phone and behind a "عرض
 * التفاصيل" toggle. A missing gyro - the single most consequential thing
 * a flight controller can report about itself - was three screens down
 * and collapsed. P1 made the truth exhaustive; P2 makes it visible.
 *
 * DETECTION, NEVER HEALTH. The chips say مكتشف / غير مكتشف / غير معروف
 * and nothing else. The firmware mask proves the FC found the hardware
 * and says nothing about whether it works, so there is deliberately no
 * HEALTHY/GOOD/WORKING vocabulary here and no aggregate score.
 *
 * It renders the shared P1 derivation (deriveSetupSensorSummary) - the
 * same object DiagnosticsSection renders below - so the dashboard chip
 * and the detail list cannot disagree about the same bit.
 */

import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {useTranslation} from 'react-i18next';

import type {SetupSensorState, SetupSensorSummary} from '../../../core';
import {colors, radii, spacing, typography} from '../../theme';

const STATE_KEY: Record<SetupSensorState, string> = {
  DETECTED: 'diagnostics.sensorDetected',
  NOT_DETECTED: 'diagnostics.sensorNotDetected',
  UNKNOWN: 'diagnostics.sensorUnknown',
};

/** Never colour-alone: each chip also carries its state as TEXT beneath
 * the token, so the distinction survives a monochrome screen and a
 * screen reader alike. */
const STATE_STYLE: Record<
  SetupSensorState,
  {chip: object; token: object; state: object}
> = {
  DETECTED: {
    chip: {borderColor: colors.success, backgroundColor: colors.surface},
    token: {color: colors.textPrimary},
    state: {color: colors.success},
  },
  NOT_DETECTED: {
    chip: {borderColor: colors.borderSoft, backgroundColor: colors.surface},
    token: {color: colors.textSecondary},
    state: {color: colors.textSecondary},
  },
  UNKNOWN: {
    chip: {borderColor: colors.warning, backgroundColor: colors.surface},
    token: {color: colors.textSecondary},
    state: {color: colors.warning},
  },
};

export interface SensorsCardProps {
  summary: SetupSensorSummary;
}

export default function SensorsCard({
  summary,
}: SensorsCardProps): React.JSX.Element {
  const {t} = useTranslation();
  const title = t('setupSensorsCard.title');

  const accessibilityLabel = [
    title,
    ...summary.entries.map(
      entry => `${entry.token} ${t(STATE_KEY[entry.state])}`,
    ),
  ].join('، ');

  return (
    <View
      style={styles.container}
      accessible
      accessibilityLabel={accessibilityLabel}
      testID="sensors-card"
    >
      <Text style={styles.title}>{title}</Text>
      {summary.unconfirmed ? (
        <Text style={styles.unconfirmed} testID="sensors-card-unconfirmed">
          {t('diagnostics.sensorsUnconfirmed')}
        </Text>
      ) : null}
      <View style={styles.chipRow}>
        {summary.entries.map(entry => {
          const variant = STATE_STYLE[entry.state];
          return (
            <View
              key={entry.token}
              style={[styles.chip, variant.chip]}
              testID={`sensors-card-${entry.token}`}
            >
              {/* Latin technical token, pinned LTR so it cannot be
                  re-ordered by the surrounding Arabic paragraph. */}
              <Text style={[styles.chipToken, variant.token]}>
                {entry.token}
              </Text>
              <Text style={[styles.chipState, variant.state]}>
                {t(STATE_KEY[entry.state])}
              </Text>
            </View>
          );
        })}
      </View>
      {summary.unknownBits.length > 0 ? (
        <Text style={styles.unknownBits} testID="sensors-card-unknown-bits">
          {summary.unknownBits
            .map(bit => t('diagnostics.sensorsUnknownBit', {hex: bit.hex}))
            .join('، ')}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    flex: 1,
    shadowColor: colors.shadow,
    shadowOpacity: 0.14,
    shadowRadius: 8,
    shadowOffset: {width: 0, height: 4},
    elevation: 2,
  },
  title: {
    ...typography.sectionTitle,
    color: colors.accentStrong,
  },
  unconfirmed: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  chip: {
    borderWidth: 1,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    alignItems: 'center',
    minWidth: 76,
  },
  chipToken: {
    ...typography.caption,
    fontWeight: '700',
    writingDirection: 'ltr',
  },
  chipState: {
    ...typography.caption,
    fontWeight: '600',
  },
  unknownBits: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
});
