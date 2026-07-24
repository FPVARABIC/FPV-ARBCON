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
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useTranslation} from 'react-i18next';

import {deriveConnectionIndicatorState} from './connectionIndicator';
import type {SetupConnectionIndicatorState} from './connectionIndicator';
import {useTopBarNotice} from './useTopBarNotice';
import {useMspIdentificationState, useMspOwnershipState, useMspRecoveryState} from '../../../platforms/react-native/protocol';
import {deriveFcFamily} from '../../../core';
import type {ArmingReadiness} from '../../../core';
import {colors, radii, spacing, typography} from '../../theme';

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

const NOTICE_BANNER_COLOR: Record<'CRITICAL' | 'ERROR' | 'WARNING' | 'INFO', string> = {
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

export default function TopSystemBar({sessionId, onBack, armingReadiness}: TopSystemBarProps): React.JSX.Element {
  const {t} = useTranslation();
  const ownership = useMspOwnershipState(sessionId);
  const identification = useMspIdentificationState(sessionId);
  const recovery = useMspRecoveryState(sessionId);

  const indicator = deriveConnectionIndicatorState(ownership, recovery);
  const notice = useTopBarNotice(ownership, recovery, identification);

  const boardName = identification.status === 'SUCCEEDED' ? identification.identity.board.boardName : undefined;
  const firmwareLabel =
    identification.status === 'SUCCEEDED'
      ? `${deriveFcFamily(identification.identity.firmware.identifier)} ${identification.identity.apiVersion.apiVersionMajor}.${identification.identity.apiVersion.apiVersionMinor}`
      : undefined;

  return (
    <View style={styles.container} testID="setup-top-bar">
      <View style={styles.row}>
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel={t('setupTopBar.back')}
          style={styles.backButton}
          testID="setup-top-bar-back">
          <Text style={styles.backButtonText}>{'‹'}</Text>
        </Pressable>
        <Text style={styles.title}>{t('setupTopBar.title')}</Text>
        <View
          style={[styles.indicatorBadge, {borderColor: INDICATOR_COLOR[indicator]}]}
          accessibilityRole="text"
          testID="setup-top-bar-connection-indicator">
          <View style={[styles.indicatorDot, {backgroundColor: INDICATOR_COLOR[indicator]}]} />
          <Text style={[styles.indicatorText, {color: INDICATOR_COLOR[indicator]}]}>{t(INDICATOR_LABEL_KEY[indicator])}</Text>
        </View>
      </View>

      <View style={[styles.row, styles.secondRow]}>
        <Text style={styles.identityText} testID="setup-top-bar-board-name">
          {boardName ?? t('setupTopBar.boardPlaceholder')}
        </Text>
        <Text style={styles.identityText} testID="setup-top-bar-firmware">
          {firmwareLabel ?? t('setupTopBar.boardPlaceholder')}
        </Text>
        <View
          style={[styles.armingBadge, {borderColor: ARMING_BADGE_COLOR[armingReadiness.status]}]}
          accessibilityRole="text"
          testID="setup-top-bar-arming-badge">
          <Text style={[styles.armingBadgeText, {color: ARMING_BADGE_COLOR[armingReadiness.status]}]}>
            {t(ARMING_BADGE_LABEL_KEY[armingReadiness.status])}
          </Text>
        </View>
      </View>

      {notice && (
        <View
          style={[styles.noticeBanner, {borderColor: NOTICE_BANNER_COLOR[notice.severity]}]}
          accessibilityRole="alert"
          testID="setup-top-bar-notice">
          <Text style={[styles.noticeTitle, {color: NOTICE_BANNER_COLOR[notice.severity]}]}>{notice.title}</Text>
          {notice.message && <Text style={styles.noticeMessage}>{notice.message}</Text>}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  secondRow: {
    marginTop: spacing.xs,
  },
  backButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backButtonText: {
    ...typography.title,
    color: colors.textPrimary,
  },
  title: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    flex: 1,
    textAlign: 'center',
  },
  indicatorBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs / 2,
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
    color: colors.textSecondary,
  },
  armingBadge: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs / 2,
  },
  armingBadgeText: {
    ...typography.caption,
    fontWeight: '600',
  },
  noticeBanner: {
    marginTop: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surfaceAlt,
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
