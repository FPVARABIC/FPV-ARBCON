/**
 * Pass 7.4, Step 4 - Setup Region 1: the persistent sticky top status bar.
 * Row 1: back button + title + connection indicator (exactly 5 states).
 * Row 2: compact board name + firmware/version + arming state.
 * A notice banner appears BELOW both rows only when attention is needed
 * (useTopBarNotice() - which owns the persistent activation-time
 * tracking deriveTopBarNotice() itself cannot, see useTopBarNotice.ts's
 * own doc comment), never showing raw USB/sessionId/internal error codes
 * - every notice string is a fixed Arabic constant, verified by
 * connectionIndicator.test.ts.
 *
 * Wired to the REAL useMspOwnershipState()/useMspIdentificationState()/
 * useMspRecoveryState() hooks - no placeholder connection data. The
 * arming badge is a PROP (armingReadiness), not derived here via its own
 * hook call - mirrors SafetyStrip.tsx's own established pattern: Step 5
 * (assembling the real Setup screen) computes ArmingReadiness ONCE from
 * the real (currently placeholder) armed/blockers telemetry and threads
 * it to both SafetyStrip and this component's Row 2, rather than each
 * independently re-deriving it and risking a one-render divergence.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { deriveConnectionIndicatorState } from './connectionIndicator';
import type { SetupConnectionIndicatorState } from './connectionIndicator';
import { useTopBarNotice } from './useTopBarNotice';
// SETUP P1: through the read-only Setup presentation boundary, like the
// rest of the Setup surface - the top bar reads session truth, it does
// not own protocol access.
import {
  useSetupIdentificationState,
  useSetupOwnershipState,
  useSetupRecoveryState,
} from '../../../platforms/react-native/protocol/setupPresentation';
import type { ArmingReadiness } from '../../../core';
import { colors, radii, spacing, typography } from '../../theme';
import { Icon } from '../../icons';

const INDICATOR_COLOR: Record<SetupConnectionIndicatorState, string> = {
  CONNECTED: colors.success,
  ACTIVATING: colors.accent,
  RECOVERING: colors.warning,
  RECOVERY_FAILED: colors.error,
  DISCONNECTED: colors.textSecondary,
};

const INDICATOR_LABEL_KEY: Record<SetupConnectionIndicatorState, string> = {
  CONNECTED: 'setupTopBar.connectionState.connected',
  ACTIVATING: 'setupTopBar.connectionState.activating',
  RECOVERING: 'setupTopBar.connectionState.recovering',
  RECOVERY_FAILED: 'setupTopBar.connectionState.recoveryFailed',
  DISCONNECTED: 'setupTopBar.connectionState.disconnected',
};

const ARMING_BADGE_COLOR: Record<ArmingReadiness['status'], string> = {
  ARMED: colors.error,
  READY: colors.success,
  BLOCKED: colors.error,
  UNKNOWN: colors.warning,
};

const ARMING_BADGE_LABEL_KEY: Record<ArmingReadiness['status'], string> = {
  ARMED: 'setupTopBar.armingBadge.armed',
  READY: 'setupTopBar.armingBadge.ready',
  BLOCKED: 'setupTopBar.armingBadge.blocked',
  UNKNOWN: 'setupTopBar.armingBadge.unknown',
};

const NOTICE_BANNER_COLOR: Record<
  'CRITICAL' | 'ERROR' | 'WARNING' | 'INFO',
  string
> = {
  CRITICAL: colors.error,
  ERROR: colors.error,
  WARNING: colors.warning,
  INFO: colors.accent,
};

export interface TopSystemBarProps {
  sessionId: string;
  onBack: () => void;
  armingReadiness: ArmingReadiness;
}

export default function TopSystemBar({
  sessionId,
  onBack,
  armingReadiness,
}: TopSystemBarProps): React.JSX.Element {
  const { t } = useTranslation();
  const ownership = useSetupOwnershipState(sessionId);
  const identification = useSetupIdentificationState(sessionId);
  const recovery = useSetupRecoveryState(sessionId);

  const indicator = deriveConnectionIndicatorState(ownership, recovery);
  const notice = useTopBarNotice(ownership, recovery, identification);

  const boardName =
    identification.status === 'SUCCEEDED'
      ? identification.identity.board.boardName
      : undefined;
  const firmwareLabel =
    identification.status === 'SUCCEEDED'
      ? `MSP ${identification.identity.apiVersion.apiVersionMajor}.${identification.identity.apiVersion.apiVersionMinor}`
      : undefined;

  return (
    <View style={styles.container} testID="setup-top-bar">
      <View style={styles.row}>
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel={t('setupTopBar.back')}
          style={styles.backButton}
          testID="setup-top-bar-back"
        >
          <Icon name="chevron-back" size={22} color={colors.textPrimary} />
        </Pressable>
        <View style={styles.titleGroup}>
          <Text style={styles.eyebrow} numberOfLines={1}>
            {t('app.name')}
          </Text>
          <Text style={styles.title} numberOfLines={1}>
            {t('setupTopBar.title')}
          </Text>
        </View>
        <View
          style={[
            styles.indicatorBadge,
            { borderColor: INDICATOR_COLOR[indicator] },
          ]}
          accessibilityRole="text"
          testID="setup-top-bar-connection-indicator"
        >
          <View
            style={[
              styles.indicatorDot,
              { backgroundColor: INDICATOR_COLOR[indicator] },
            ]}
          />
          <Text
            style={[
              styles.indicatorText,
              { color: INDICATOR_COLOR[indicator] },
            ]}
            numberOfLines={1}
          >
            {t(INDICATOR_LABEL_KEY[indicator])}
          </Text>
        </View>
      </View>

      <View style={styles.secondRow}>
        <View style={styles.identityGroup}>
          <View style={styles.identityChip}>
            <Text
              style={styles.identityText}
              numberOfLines={1}
              testID="setup-top-bar-board-name"
            >
              {boardName ?? t('setupTopBar.boardPlaceholder')}
            </Text>
          </View>
          <View style={styles.identityChip}>
            <Text
              style={styles.identityText}
              numberOfLines={1}
              testID="setup-top-bar-firmware"
            >
              {firmwareLabel ?? t('setupTopBar.boardPlaceholder')}
            </Text>
          </View>
        </View>
        <View
          style={[
            styles.armingBadge,
            { borderColor: ARMING_BADGE_COLOR[armingReadiness.status] },
          ]}
          accessibilityRole="text"
          testID="setup-top-bar-arming-badge"
        >
          <Text
            style={[
              styles.armingBadgeText,
              { color: ARMING_BADGE_COLOR[armingReadiness.status] },
            ]}
          >
            {t(ARMING_BADGE_LABEL_KEY[armingReadiness.status])}
          </Text>
        </View>
      </View>

      {notice && (
        <View
          style={[
            styles.noticeBanner,
            { borderColor: NOTICE_BANNER_COLOR[notice.severity] },
          ]}
          accessibilityRole="alert"
          testID="setup-top-bar-notice"
        >
          <Text
            style={[
              styles.noticeTitle,
              { color: NOTICE_BANNER_COLOR[notice.severity] },
            ]}
          >
            {notice.title}
          </Text>
          {notice.message && (
            <Text style={styles.noticeMessage}>{notice.message}</Text>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderBottomWidth: 1,
    borderBottomColor: colors.accentStrong,
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  secondRow: {
    marginTop: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    flexWrap: 'wrap',
  },
  backButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  titleGroup: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: spacing.md,
  },
  eyebrow: {
    ...typography.eyebrow,
    color: colors.accentStrong,
    writingDirection: 'ltr',
  },
  title: {
    ...typography.title,
    color: colors.textPrimary,
  },
  indicatorBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surface,
    flexShrink: 0,
  },
  indicatorDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginEnd: spacing.xs,
  },
  indicatorText: {
    ...typography.caption,
    fontWeight: '600',
  },
  identityText: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '600',
    writingDirection: 'ltr',
  },
  identityGroup: {
    flexDirection: 'row',
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 180,
    gap: spacing.sm,
  },
  identityChip: {
    flexShrink: 1,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  armingBadge: {
    borderWidth: 1,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surface,
  },
  armingBadgeText: {
    ...typography.caption,
    fontWeight: '600',
  },
  noticeBanner: {
    marginTop: spacing.md,
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
  },
  noticeTitle: {
    ...typography.body,
    fontWeight: '600',
  },
  noticeMessage: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
});
