/**
 * SETUP R9 - the whole of Setup's fixed chrome, in one 48px row.
 *
 * =====================================================================
 * WHAT THIS REPLACES
 * =====================================================================
 *
 * TopSystemBar was 139px tall at every measured width (1920, 1366 and
 * 390 alike) and carried six things: a back button, the app name, the
 * screen title, a connection chip, a board/firmware pair and an arming
 * badge - plus an occasional notice banner. It was painted in
 * colors.accent across the full width, so it read as the page's masthead
 * rather than as a toolbar.
 *
 * Only TWO of those six are chrome in the sense that they must survive
 * scrolling: the way back, and the way to disconnect. Everything else is
 * CONTENT about the aircraft, and content belongs in the document where
 * the operator can scroll past it. So this row keeps back, an identifying
 * title, a connection dot and disconnect; the board, the firmware, the
 * arming state, the battery and the sensors all moved into
 * SetupStatusBar, which is the first thing inside the scroll view.
 *
 * WHY THE CONNECTION DOT IS HERE TOO, when SetupStatusBar names the
 * connection state in words a few pixels below. Disconnect is a
 * destructive control and it lives in this row; a destructive control
 * with no indication of what it will act on is worse than a duplicated
 * six-pixel dot. The dot carries no text of its own - the words are
 * stated once, below - so this is not the duplicated-information defect
 * the round set out to remove.
 *
 * NOTHING WAS SCALED UP TO FILL SPACE. The back and disconnect controls
 * keep the 44px minimum touch target they had in the bar they came from;
 * the row is 48px because 44 + a hairline border + 2px of breathing room
 * is what a 44px control needs, not because a number was chosen.
 */

import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useTranslation} from 'react-i18next';

import {deriveConnectionIndicatorState} from './connectionIndicator';
import type {SetupConnectionIndicatorState} from './connectionIndicator';
import {
  useSetupOwnershipState,
  useSetupRecoveryState,
} from '../../../platforms/react-native/protocol/setupPresentation';
import {colors, radii, spacing, typography} from '../../theme';
import {Icon} from '../../icons';

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

export interface SetupChromeBarProps {
  sessionId: string;
  onBack: () => void;
  /**
   * Optional for the same reason it always was: a host that cannot
   * disconnect (a test, a preview) renders no control rather than an
   * inert one. Offered only while genuinely CONNECTED - a session already
   * recovering or gone has nothing intentional left to close.
   */
  onDisconnect?: () => void;
}

export default function SetupChromeBar({
  sessionId,
  onBack,
  onDisconnect,
}: SetupChromeBarProps): React.JSX.Element {
  const {t} = useTranslation();
  const ownership = useSetupOwnershipState(sessionId);
  const recovery = useSetupRecoveryState(sessionId);
  const indicator = deriveConnectionIndicatorState(ownership, recovery);

  return (
    <View style={styles.container} testID="setup-chrome-bar">
      <Pressable
        onPress={onBack}
        accessibilityRole="button"
        accessibilityLabel={t('setupTopBar.back')}
        style={styles.control}
        testID="setup-chrome-back"
      >
        <Icon name="chevron-back" size={20} color={colors.textPrimary} />
      </Pressable>
      <Text style={styles.title} numberOfLines={1}>
        {t('setupTopBar.title')}
      </Text>
      <View
        style={[styles.dot, {backgroundColor: INDICATOR_COLOR[indicator]}]}
        accessibilityRole="text"
        accessibilityLabel={t(INDICATOR_LABEL_KEY[indicator])}
        testID="setup-chrome-connection-dot"
      />
      {onDisconnect && indicator === 'CONNECTED' ? (
        <Pressable
          onPress={onDisconnect}
          accessibilityRole="button"
          accessibilityLabel={t('setupTopBar.disconnect')}
          style={styles.control}
          testID="setup-chrome-disconnect"
        >
          <Icon name="unplug" size={18} color={colors.textPrimary} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 48,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSoft,
    backgroundColor: colors.backgroundRaised,
  },
  control: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.sm,
  },
  title: {
    ...typography.label,
    color: colors.textPrimary,
    flex: 1,
    minWidth: 0,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});
