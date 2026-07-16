import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {useTranslation} from 'react-i18next';

import {colors, radii, spacing, typography} from '../../theme';
import type {ConnectionState} from './connectionTypes';
import {connectionStateLabelKey} from './connectionTypes';

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

/** Compact technical top bar - no hero area, no logo treatment. */
export default function ConnectionHeader({connectionState}: Props): React.JSX.Element {
  const {t} = useTranslation();

  return (
    <View style={styles.container}>
      <View style={styles.titleRow}>
        <Text style={styles.appName}>{t('app.name')}</Text>
        <View
          style={[styles.stateBadge, {borderColor: STATE_COLOR[connectionState]}]}
          accessibilityRole="text">
          <View style={[styles.stateDot, {backgroundColor: STATE_COLOR[connectionState]}]} />
          <Text style={[styles.stateText, {color: STATE_COLOR[connectionState]}]}>
            {t(connectionStateLabelKey(connectionState))}
          </Text>
        </View>
      </View>
      <Text style={styles.subtitle}>{t('connection.screenTitle')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  appName: {
    ...typography.title,
    color: colors.textPrimary,
  },
  subtitle: {
    ...typography.body,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
  stateBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs / 2,
  },
  stateDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginEnd: spacing.xs,
  },
  stateText: {
    ...typography.caption,
    fontWeight: '600',
  },
});
