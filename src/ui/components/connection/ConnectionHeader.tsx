import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { colors, radii, spacing, typography } from '../../theme';
import type { ConnectionState } from './connectionTypes';
import { connectionStateLabelKey } from './connectionTypes';

const STATE_COLOR: Record<ConnectionState, string> = {
  idle: colors.textSecondary,
  ready: colors.textSecondary,
  scanning: colors.accent,
  connecting: colors.accent,
  connected: colors.success,
  disconnecting: colors.warning,
  error: colors.error,
};

interface Props {
  connectionState: ConnectionState;
}

export default function ConnectionHeader({
  connectionState,
}: Props): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <View style={styles.container}>
      <View style={styles.brandRow}>
        <View style={styles.brandMark} accessibilityElementsHidden>
          <Text style={styles.brandMarkText}>FPV</Text>
        </View>
        <View style={styles.brandCopy}>
          <Text style={styles.appName} numberOfLines={1}>
            {t('app.name')}
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {t('connection.screenTitle')}
          </Text>
        </View>
        <View
          style={[
            styles.stateBadge,
            {
              borderColor: STATE_COLOR[connectionState],
              backgroundColor:
                connectionState === 'connected'
                  ? colors.accentSoft
                  : colors.backgroundRaised,
            },
          ]}
          accessibilityRole="text"
        >
          <View
            style={[
              styles.stateDot,
              { backgroundColor: STATE_COLOR[connectionState] },
            ]}
          />
          <Text
            style={[styles.stateText, { color: STATE_COLOR[connectionState] }]}
            numberOfLines={1}
          >
            {t(connectionStateLabelKey(connectionState))}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSoft,
    backgroundColor: colors.backgroundRaised,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  brandMark: {
    width: 48,
    height: 48,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
    shadowColor: colors.shadow,
    shadowOpacity: 0.3,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 5,
  },
  brandMarkText: {
    ...typography.eyebrow,
    color: colors.accentText,
    letterSpacing: 1.2,
  },
  brandCopy: {
    flex: 1,
    minWidth: 0,
  },
  appName: {
    ...typography.title,
    color: colors.textPrimary,
  },
  subtitle: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 1,
  },
  stateBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    flexShrink: 0,
  },
  stateDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    marginEnd: spacing.sm,
  },
  stateText: {
    ...typography.caption,
    fontWeight: '700',
  },
});
