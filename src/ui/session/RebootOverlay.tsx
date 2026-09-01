/**
 * AN EXPECTED REBOOT IS A STATE OF THE APPLICATION, NOT A PLACE IN IT.
 *
 * A CLI `save` reboots the board on purpose: the session dies because
 * the app asked it to, and the app knows which board is coming back. The
 * operator should not be sent anywhere for that, and above all should
 * not be made to press "connect" after pressing "save" - that was the
 * defect that left Motors, PID and Ports holding a session id which no
 * longer named anything.
 *
 * So this is an OVERLAY over whatever the navigator is showing, rendered
 * by the application root. It is not a route:
 *
 *   - nothing can navigate to it, because it is not a destination;
 *   - it leaves no history entry, so Back cannot return to it;
 *   - a refresh cannot restore it, because it is derived from the live
 *     recovery lifecycle rather than from navigation state.
 *
 * It covers the screen while it is up, so the configuration workspace
 * underneath - which the wall has already unregistered - cannot be used
 * or even reached by a stray press.
 *
 * WHEN IT ENDS. The recovery lifecycle owns that. Success puts a
 * verified board back and the wall opens the workspace; a timeout drops
 * the phase and the operator is on Home. Either way this stops rendering
 * because the state it reads changed - never because it navigated.
 */

import React from 'react';
import {ActivityIndicator, StyleSheet, Text, View} from 'react-native';
import {useTranslation} from 'react-i18next';

import {colors, radii, spacing, typography} from '../theme';
import type {VerifiedConnection} from './verifiedConnection';

export function RebootOverlay({
  connection,
}: {
  readonly connection: VerifiedConnection;
}): React.JSX.Element | null {
  const {t} = useTranslation();
  if (connection.kind !== 'REBOOTING') return null;
  return (
    <View style={styles.scrim} testID="reboot-overlay">
      <View style={styles.card}>
        <ActivityIndicator color={colors.accent} />
        <Text style={styles.title}>{t('connectWorkspace.rebootingTitle')}</Text>
        <Text style={styles.body} testID="reboot-overlay-message">
          {t('connectWorkspace.rebooting')}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
    backgroundColor: colors.background,
  },
  card: {
    width: '100%',
    maxWidth: 420,
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
