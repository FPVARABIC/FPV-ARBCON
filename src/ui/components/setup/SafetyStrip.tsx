/**
 * Pass 7.4, Step 3 - Setup Region 2's Safety Strip. Purely a renderer of
 * ArmingReadiness (src/core/state/armingReadiness.ts) - all safety logic
 * (the ARMED/READY/BLOCKED/UNKNOWN derivation, the ranking of blocked
 * reasons) already lives there, fully unit-tested without any rendering
 * concern; this file only decides layout, color, and Arabic copy.
 *
 * Compact for ARMED/READY/UNKNOWN (nothing actionable to show). Auto-
 * expands ONLY for BLOCKED, showing the top-ranked reasons plus a
 * "عرض جميع الأسباب" link when more exist - per this pass's own explicit
 * instruction. Expand/collapse is local component state: nothing in
 * SetupUiSessionState (Pass 7.1) reserves a field for it, and there is no
 * cross-render reason a user's "show all" tap needs to survive a
 * remount.
 *
 * ARMED is rendered in the same danger color as BLOCKED (colors.error),
 * a stated decision: real flight controller configurators (Betaflight/
 * INAV) render their own armed indicator in a hazard color once armed -
 * props may be spinning, this is a genuine physical-danger state, not
 * merely an informational one.
 */

import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import type { ArmingBlockReason, ArmingReadiness } from '../../../core';
import {
  rankArmingBlockReasons,
  selectTopArmingBlockReasons,
} from '../../../core';
import { colors, radii, spacing, typography } from '../../theme';

/** Never color-alone (per this pass's own accessibility requirement) -
 * every compact status also carries distinct Arabic text, and every
 * blocked reason row carries both a severity-tinted dot AND its own
 * message text. */
const SEVERITY_COLOR: Record<ArmingBlockReason['severity'], string> = {
  CRITICAL_DANGER: colors.error,
  ARMING_BLOCKER: colors.warning,
  WARNING: colors.warning,
  INFO: colors.textSecondary,
};

/** Minimum touch target height (iOS/Android accessibility guidelines) -
 * per this pass's own "adequate touch targets" requirement. */
const MIN_TOUCH_TARGET = 44;

export interface SafetyStripProps {
  readiness: ArmingReadiness;
}

export default function SafetyStrip({
  readiness,
}: SafetyStripProps): React.JSX.Element {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  if (readiness.status === 'ARMED') {
    return (
      <View
        style={[
          styles.container,
          styles.compact,
          { borderColor: colors.error },
        ]}
        accessibilityRole="text"
        testID="safety-strip-armed"
      >
        <Text style={[styles.statusText, { color: colors.error }]}>
          {t('safetyStrip.armed')}
        </Text>
      </View>
    );
  }

  if (readiness.status === 'READY') {
    return (
      <View
        style={[
          styles.container,
          styles.compact,
          { borderColor: colors.success },
        ]}
        accessibilityRole="text"
        testID="safety-strip-ready"
      >
        <Text style={[styles.statusText, { color: colors.success }]}>
          {t('safetyStrip.ready')}
        </Text>
      </View>
    );
  }

  if (readiness.status === 'UNKNOWN') {
    // Deliberately the SAME text/rendering for every cause (WAITING/
    // STALE/ERROR/UNAVAILABLE) - per this pass's own explicit STALE
    // rule ("never continues showing previous state"), which this type
    // structurally enforces anyway: UNKNOWN carries no reasons field at
    // all, so there is nothing stale left to accidentally render.
    return (
      <View
        style={[
          styles.container,
          styles.compact,
          { borderColor: colors.warning },
        ]}
        accessibilityRole="text"
        testID="safety-strip-unknown"
      >
        <Text style={[styles.statusText, { color: colors.warning }]}>
          {t('safetyStrip.unknown')}
        </Text>
      </View>
    );
  }

  // BLOCKED - auto-expanded per spec.
  const { shown, remainingCount } = selectTopArmingBlockReasons(
    readiness.reasons,
  );
  const visibleReasons = expanded
    ? rankArmingBlockReasons(readiness.reasons)
    : shown;

  return (
    <View
      style={[styles.container, { borderColor: colors.error }]}
      testID="safety-strip-blocked"
    >
      <Text
        style={[styles.statusText, { color: colors.error }]}
        accessibilityRole="header"
      >
        {t('safetyStrip.blockedHeading')}
      </Text>
      {visibleReasons.map(reason => (
        <View
          key={reason.code}
          style={styles.reasonRow}
          testID={`safety-strip-reason-${reason.code}`}
        >
          <View
            style={[
              styles.reasonDot,
              { backgroundColor: SEVERITY_COLOR[reason.severity] },
            ]}
          />
          <Text style={styles.reasonText}>{reason.message}</Text>
        </View>
      ))}
      {!expanded && remainingCount > 0 && (
        <Pressable
          onPress={() => setExpanded(true)}
          accessibilityRole="button"
          accessibilityLabel={t(
            'safetyStrip.showAllReasonsAccessibilityLabel',
            { count: remainingCount },
          )}
          style={styles.showAllLink}
          testID="safety-strip-show-all"
        >
          <Text style={styles.showAllText}>
            {t('safetyStrip.showAllReasons')}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: spacing.md,
    marginTop: spacing.md,
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    shadowColor: colors.shadow,
    shadowOpacity: 0.14,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  compact: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusText: {
    ...typography.body,
    fontWeight: '600',
  },
  reasonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.xs,
  },
  reasonDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginEnd: spacing.sm,
  },
  reasonText: {
    ...typography.body,
    color: colors.textPrimary,
    flexShrink: 1,
  },
  showAllLink: {
    marginTop: spacing.sm,
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
  },
  showAllText: {
    ...typography.body,
    color: colors.accent,
    fontWeight: '600',
  },
});
