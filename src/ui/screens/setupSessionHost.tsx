/**
 * THE CONNECTION-LIFECYCLE SEAM for the tab-shell era.
 *
 * ENTRY CLEANUP moved the standalone 'Connection' route INSIDE the Setup
 * tab, which raises a boundary question this module answers: SetupScreen
 * and everything under src/ui/components/setup are fenced by SETUP P1
 * (setupPresentationBoundary.test.ts) - they read session truth through
 * the setupPresentation facade and command through fcToolsController,
 * and may not touch the coordinator, a client or a transport. Opening
 * and closing SESSIONS was never Setup's capability; it belonged to
 * UsbConnectionScreen, in this same screens layer. This module keeps
 * that ownership in the same layer, one file over:
 *
 *   - SetupConnectWorkspace: the disconnected configurator's content -
 *     hosts the complete, unmodified UsbConnectionScreen and ADOPTS a
 *     session that is already ACTIVE in the coordinator (Back to Start
 *     deliberately never deactivates - see App.test.tsx - so re-entry
 *     must reattach to the live session rather than offer a second
 *     connect against an already-open port).
 *
 *   - useSetupSessionDisconnect: the intentional disconnect for the top
 *     bar - the same two calls, in the same order, with the same
 *     failure asymmetry UsbConnectionScreen's own قطع الاتصال uses:
 *     close the transport session first, and only a CONFIRMED close
 *     deactivates MSP ownership. Ownership flipping INACTIVE is what
 *     the session-loss redirect watches, so navigation back to the
 *     disconnected configurator happens through that one shared safety
 *     rule. On failure nothing is deactivated (native cleanup
 *     unconfirmed - DISCONNECT_FAILURE's reasoning); the operator gets
 *     the same localized Arabic error, and the coordinator's own
 *     recovery/detach machinery owns the rest.
 *
 * SetupScreen consumes both as plain React building blocks - a
 * component and a callback - so the fenced file itself names no
 * protocol capability at all, exactly as it receives navigation
 * callbacks from the shell without importing the navigator.
 */

import React, { useCallback, useEffect } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { colors, spacing, typography } from '../theme';
import { Icon } from '../icons';
import UsbConnectionScreen from './UsbConnectionScreen';
import { mspSessionCoordinator } from '../../platforms/react-native/protocol';
import type { SetupUiSessionKey } from '../../platforms/react-native/protocol';
import {
  localizeTransportError,
  usbSerialTransportClient,
} from '../../platforms/react-native/transport';
import type { TransportError } from '../../platforms/react-native/transport';

export function SetupConnectWorkspace({
  onSessionEstablished,
  onBack,
}: {
  readonly onSessionEstablished: (key: SetupUiSessionKey) => void;
  /** Leaves the configurator. Absent only in hosts with nowhere to go. */
  readonly onBack?: () => void;
}): React.JSX.Element {
  useEffect(() => {
    for (const sessionId of mspSessionCoordinator.listSessionIds()) {
      if (mspSessionCoordinator.getOwnershipState(sessionId) !== 'INACTIVE') {
        const existingKey = mspSessionCoordinator.getSessionKey(sessionId);
        if (existingKey) {
          onSessionEstablished(existingKey);
          return;
        }
      }
    }
  }, [onSessionEstablished]);

  return (
    <View style={styles.root} testID="setup-connect-workspace">
      {/* THE WAY OUT. Before this, opening the configurator without a
          connected board landed the operator on the connection workspace
          with no visible way back - the tab shell's own back affordance
          belongs to the CONNECTED screen, which this state is not. A
          navigation dead end is a defect regardless of how correct the
          connection logic underneath it is. */}
      {onBack !== undefined ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="العودة"
          onPress={onBack}
          style={styles.backRow}
          testID="setup-connect-back">
          <Icon name="chevron-back" size={22} color={colors.textPrimary} />
          <Text style={styles.backLabel}>العودة</Text>
        </Pressable>
      ) : null}
      {/* autoConnectOnEntry: reaching this workspace IS the request to
          connect - the operator pressed "فتح إعدادات متحكم الطيران" to get
          here. When exactly one authorized board is present it opens by
          itself and the settings appear; anything ambiguous, unauthorized
          or absent still waits for them. See the prop's own comment for
          why this needs no browser gesture. */}
      <UsbConnectionScreen
        onSessionEstablished={onSessionEstablished}
        autoConnectOnEntry
      />
    </View>
  );
}

export function useSetupSessionDisconnect(sessionId: string): () => void {
  const { t } = useTranslation();
  return useCallback(() => {
    (async () => {
      try {
        await usbSerialTransportClient.closeSession(sessionId);
        mspSessionCoordinator.deactivateMspSession(sessionId);
      } catch (error) {
        Alert.alert(
          t('setupTopBar.disconnectFailedTitle'),
          localizeTransportError(t, error as TransportError),
        );
      }
    })();
  }, [sessionId, t]);
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  backRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
  },
  backLabel: { ...typography.bodyStrong, color: colors.textPrimary },
});
