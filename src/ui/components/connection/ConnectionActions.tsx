import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import { colors, radii, spacing, typography } from '../../theme';
import type { ConnectionState } from './connectionTypes';

interface Props {
  connectionState: ConnectionState;
  canConnect: boolean;
  lastResult: 'connectSuccess' | 'disconnectSuccess' | null;
  shortSessionId: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
}

export default function ConnectionActions({
  connectionState,
  canConnect,
  lastResult,
  shortSessionId,
  onConnect,
  onDisconnect,
}: Props): React.JSX.Element {
  const { t } = useTranslation();
  const showDisconnect =
    connectionState === 'connected' || connectionState === 'disconnecting';

  return (
    <View style={styles.container}>
      {showDisconnect ? (
        <Pressable
          testID="usb-disconnect-button"
          onPress={
            connectionState === 'disconnecting' ? undefined : onDisconnect
          }
          disabled={connectionState === 'disconnecting'}
          accessibilityRole="button"
          accessibilityLabel={t('accessibility.disconnect')}
          accessibilityState={{ disabled: connectionState === 'disconnecting' }}
          style={[styles.button, styles.disconnectButton]}
        >
          {connectionState === 'disconnecting' ? (
            <ActivityIndicator color={colors.textPrimary} size="small" />
          ) : null}
          <Text style={styles.buttonText}>
            {connectionState === 'disconnecting'
              ? t('actions.disconnecting')
              : t('actions.disconnect')}
          </Text>
        </Pressable>
      ) : (
        <Pressable
          testID="usb-connect-button"
          onPress={canConnect ? onConnect : undefined}
          disabled={!canConnect}
          accessibilityRole="button"
          accessibilityLabel={t('accessibility.connect')}
          accessibilityState={{ disabled: !canConnect }}
          style={[
            styles.button,
            styles.connectButton,
            !canConnect && styles.buttonDisabled,
          ]}
        >
          {connectionState === 'connecting' ? (
            <ActivityIndicator color={colors.background} size="small" />
          ) : null}
          <Text style={[styles.buttonText, styles.connectButtonText]}>
            {connectionState === 'connecting'
              ? t('actions.connecting')
              : t('actions.connect')}
          </Text>
        </Pressable>
      )}

      {lastResult ? (
        <Text testID="usb-last-result" style={styles.resultText}>
          {lastResult === 'connectSuccess'
            ? t('actions.connectSuccess')
            : t('actions.disconnectSuccess')}
        </Text>
      ) : null}

      {connectionState === 'connected' && shortSessionId ? (
        <Text testID="usb-session-id" style={styles.sessionIdText}>
          {t('connection.sessionIdLabel')}:{' '}
          <Text style={styles.sessionIdValue}>{shortSessionId}</Text>
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    minHeight: 54,
  },
  connectButton: {
    backgroundColor: colors.accent,
    shadowColor: colors.accent,
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4,
  },
  disconnectButton: {
    borderWidth: 1,
    borderColor: colors.error,
    backgroundColor: colors.surface,
  },
  buttonDisabled: {
    backgroundColor: colors.surfaceRaised,
    shadowOpacity: 0,
    elevation: 0,
  },
  buttonText: {
    ...typography.body,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  connectButtonText: {
    color: colors.accentText,
  },
  resultText: {
    ...typography.caption,
    color: colors.success,
    marginTop: spacing.sm,
    textAlign: 'center',
  },
  sessionIdText: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: spacing.xs,
    textAlign: 'center',
  },
  sessionIdValue: {
    writingDirection: 'ltr',
  },
});
