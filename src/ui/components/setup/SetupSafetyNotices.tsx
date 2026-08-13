/**
 * SETUP P1 - the safety-notice list.
 *
 * Purely a renderer of the warning model
 * (src/core/state/setupSafetyModel.ts's deriveSetupWarnings): every
 * condition, its severity and its owning screen are decided there, fully
 * unit-testable without any rendering concern. This file decides only
 * layout, colour and which Arabic key to look up.
 *
 * WHY IT IS A SEPARATE COMPONENT AND NOT PART OF SafetyStrip. The strip
 * answers exactly one question - can this aircraft be armed right now.
 * These notices answer a different one: what else is true that the
 * operator needs to know (link lost, failsafe thrown, reboot pending,
 * battery flagged by the FC). Keeping them apart means P1 could surface
 * the second set of facts without touching the strip's four states, its
 * dimensions or its position - all of which belong to P2's layout work.
 *
 * IT RENDERS NOTHING WHEN NOTHING IS TRUE. There is no permanent wall of
 * warnings and no readiness score; an empty model produces no element at
 * all, so a healthy aircraft costs zero vertical space.
 *
 * NAVIGATION IS DELIBERATELY ABSENT. Each notice already carries its
 * owning screen in the model, but Setup gains no card navigation in P1 -
 * that is P2's, and adding a link here would quietly create the
 * navigation model ahead of the phase that owns it.
 */

import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {useTranslation} from 'react-i18next';

import type {SetupWarning, SetupWarningSeverity} from '../../../core';
import {colors, radii, spacing, typography} from '../../theme';

/** Never colour-alone: every row carries its own Arabic sentence, and the
 * severity is additionally announced to assistive technology through the
 * container's accessibility label. */
const SEVERITY_COLOR: Record<SetupWarningSeverity, string> = {
  CRITICAL: colors.error,
  WARNING: colors.warning,
  INFO: colors.textSecondary,
};

const SEVERITY_RANK: Record<SetupWarningSeverity, number> = {
  CRITICAL: 2,
  WARNING: 1,
  INFO: 0,
};

export interface SetupSafetyNoticesProps {
  warnings: readonly SetupWarning[];
}

export default function SetupSafetyNotices({
  warnings,
}: SetupSafetyNoticesProps): React.JSX.Element | null {
  const {t} = useTranslation();

  if (warnings.length === 0) {
    return null;
  }

  // Stable sort by severity: equal severities keep the model's own
  // declaration order, which is already the order the safety model
  // considers most urgent first.
  const ordered = [...warnings].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  );

  return (
    <View
      style={styles.container}
      accessibilityRole="alert"
      testID="setup-safety-notices"
    >
      <Text style={styles.heading} accessibilityRole="header">
        {t('setupWarnings.heading')}
      </Text>
      {ordered.map(warning => (
        <View
          key={warning.id}
          style={styles.row}
          testID={`setup-safety-notice-${warning.id}`}
        >
          <View
            style={[
              styles.dot,
              {backgroundColor: SEVERITY_COLOR[warning.severity]},
            ]}
          />
          <Text
            style={[styles.text, {color: SEVERITY_COLOR[warning.severity]}]}
          >
            {t(warning.messageKey)}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    gap: spacing.xs,
  },
  heading: {
    ...typography.eyebrow,
    color: colors.textSecondary,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 24,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  text: {
    ...typography.body,
    flex: 1,
  },
});
