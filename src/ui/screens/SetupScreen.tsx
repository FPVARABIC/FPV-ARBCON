/**
 * Pass 7.1 - minimal stub only. Renders nothing but the received
 * SetupUiSessionKey (so navigation wiring is visibly verifiable) plus a
 * placeholder message. No real Setup UI, no reads from
 * SetupUiSessionStore, no MSP requests - that is Pass 7.3's work, once
 * this navigation foundation is confirmed correct.
 */

import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';

import type {RootStackParamList} from '../../navigation/types';
import {colors, spacing, typography} from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Setup'>;

export default function SetupScreen({route}: Props): React.JSX.Element {
  // Defense-in-depth (mspClient.ts/RNMspTransport.ts precedent): the only
  // call site today (UsbConnectionScreen.tsx) always supplies sessionKey,
  // TypeScript-enforced - but that guarantee is compile-time only, and
  // nothing at runtime stops a future linking config or another call site
  // from reaching this screen without it. Render an honest fallback
  // instead of crashing on a missing param.
  const sessionKey = route.params?.sessionKey;

  if (!sessionKey) {
    return (
      <View style={styles.root}>
        <Text style={styles.placeholderText} testID="setup-screen-missing-session">
          شاشة الإعداد (قيد الإنشاء)
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <Text style={styles.sessionKeyText} testID="setup-screen-session-key">
        {`${sessionKey.sessionId}:${sessionKey.generation}`}
      </Text>
      <Text style={styles.placeholderText}>شاشة الإعداد (قيد الإنشاء)</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
    padding: spacing.lg,
  },
  sessionKeyText: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  placeholderText: {
    ...typography.body,
    color: colors.textPrimary,
    marginTop: spacing.md,
    textAlign: 'center',
  },
});
