/**
 * THE DISCONNECTED APPLICATION. One screen, and it is the whole app.
 *
 * WHAT THIS REPLACES. The connection workspace used to be a child of the
 * Setup tab, which meant reaching it also produced the tab shell, the
 * navigation rail and fifteen configuration destinations - all present,
 * all reachable, and each one answering with a card saying no board was
 * connected. That is the wrong shape: the operator was shown an
 * application that looked configurable and then told, screen by screen,
 * that it was not.
 *
 * Now the configuration workspace is registered in the navigator ONLY
 * while a flight controller is verified (App.tsx). Before that this
 * route is the only destination for the configuration path, there is no
 * shell around it, and no protected screen exists to be deep-linked,
 * restored, or briefly mounted.
 *
 * THE REBOOT CASE IS NOT THE DISCONNECTED CASE. A CLI `save` reboots the
 * board on purpose; the session dies because the app asked it to. The
 * operator gets one transitional line and no connect button, because the
 * recovery is already running and pressing "connect" would fight it. If
 * it times out, fcRebootRecovery leaves that phase on its own and this
 * screen becomes the ordinary connection workspace again.
 */

import React, {useCallback} from 'react';
import {ActivityIndicator, StyleSheet, Text, View} from 'react-native';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import {useTranslation} from 'react-i18next';

import type {RootStackParamList} from '../../navigation/types';
import type {SetupUiSessionKey} from '../../platforms/react-native/protocol';
import {SetupConnectWorkspace} from './setupSessionHost';
import {useVerifiedFcConnection} from '../session';
import {colors, radii, spacing, typography} from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Connect'>;

export default function ConnectWorkspaceScreen({
  navigation,
  route,
}: Props): React.JSX.Element {
  const {t} = useTranslation();
  const connection = useVerifiedFcConnection();

  /**
   * NOTHING TO DO HERE ON SUCCESS.
   *
   * App.tsx watches the same connection state and registers the
   * configuration workspace the moment it is verified; this screen does
   * not navigate anywhere itself. Two things deciding when the workspace
   * opens is how you get a half-open one.
   */
  const noteSessionEstablished = useCallback((_key: SetupUiSessionKey) => {
    // Intentionally empty - see above.
  }, []);

  if (connection.kind === 'REBOOTING') {
    return (
      <View style={styles.transitional} testID="connect-rebooting">
        <View style={styles.card}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.title}>{t('connectWorkspace.rebootingTitle')}</Text>
          <Text style={styles.body} testID="connect-rebooting-message">
            {t('connectWorkspace.rebooting')}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.root} testID="connect-workspace-screen">
      <SetupConnectWorkspace
        onSessionEstablished={noteSessionEstablished}
        /* Arriving by choice is a request to connect; being returned
           here because a link died is not - that would reopen the port,
           lose it again, and loop. */
        autoConnectOnEntry={route.params?.afterSessionLoss !== true}
        onBack={
          navigation?.canGoBack?.() === true
            ? () => navigation.goBack()
            : undefined
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.background},
  transitional: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
    backgroundColor: colors.background,
  },
  card: {
    maxWidth: 420,
    width: '100%',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  title: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
  body: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
    writingDirection: 'rtl',
  },
});
