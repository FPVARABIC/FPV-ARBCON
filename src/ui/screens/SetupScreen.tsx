/**
 * Pass 7.4, Step 5 - the real Setup screen, assembled from Regions 1+2
 * ONLY (TopSystemBar, OrientationHero, SafetyStrip) - Regions 3/4/5 are
 * genuinely absent, not placeholders, per this pass's own scope.
 *
 * The missing-sessionKey fallback (Pass 7.1's own defense-in-depth) is
 * unchanged: the only real call site (UsbConnectionScreen.tsx's
 * navigate('Setup', {sessionKey})) always supplies it, TypeScript-
 * enforced, but nothing at runtime stops a future linking config from
 * reaching this screen without it.
 *
 * SetupUiSessionStore (Pass 7.1) is a PLAIN, non-reactive store (by its
 * own explicit design - "no useSyncExternalStore hook, no subscribe/
 * notify machinery") - reading it once via a lazy useState initializer
 * and re-reading+setState()-ing it after every write (resetView/
 * hintShown below) is what makes this screen's UI actually reflect
 * store writes, without adding new reactive machinery to the store
 * itself. This is safe for exactly the way this screen is actually
 * used: SetupScreen is the ONLY reader/writer of its own session's UI
 * state, and is reached via exactly one navigate('Setup', {sessionKey})
 * call site (UsbConnectionScreen.tsx) with no in-place re-parameterization
 * anywhere in this codebase (verified by search, not assumed) - so a
 * lazy, mount-time read of the store is genuinely correct here, not an
 * unexamined shortcut.
 *
 * KNOWN LATENT GAP IF THIS ASSUMPTION IS EVER VIOLATED (Pass 7.4 final
 * sweep, traced explicitly): if a SECOND SetupScreen instance were ever
 * mounted for the same SetupUiSessionKey while a first is still mounted,
 * a write from one instance's handleResetView()/handleResetHintShown()
 * would update the real store correctly but would NOT be reflected in
 * the other instance's own local `uiState` mirror - that sibling would
 * keep rendering its stale copy until it performs its own write or
 * remounts, since the store itself has no subscribe/notify to propagate
 * the change. NOT reachable today: the app's Stack.Navigator (App.tsx)
 * uses no custom getId(), and the one real call site
 * (UsbConnectionScreen.tsx) calls navigation.navigate() (not .push()),
 * whose default behavior for an already-present route name is to
 * refocus the existing instance rather than mount a second one - so two
 * concurrent instances for the same session cannot occur through any
 * navigation action this codebase performs today. Left unfixed
 * deliberately (per this project's own no-speculative-abstraction
 * convention): a future pass that adds a second entry point, or
 * switches this call site to .push(), must revisit this doc comment and
 * either give SetupUiSessionStore real subscribe/notify machinery or
 * otherwise resolve this before that change ships.
 */

import React, {useCallback, useState} from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';

import type {RootStackParamList} from '../../navigation/types';
import {colors, spacing, typography} from '../theme';
import {TopSystemBar, OrientationHero, SafetyStrip, BatteryCard} from '../components/setup';
import {
  useTelemetryValue,
  setupUiSessionStore,
  ATTITUDE_TELEMETRY_POLL_ID,
  ARMED_TELEMETRY_POLL_ID,
  ARMING_BLOCKERS_TELEMETRY_POLL_ID,
  BATTERY_TELEMETRY_POLL_ID,
} from '../../platforms/react-native/protocol';
import type {SetupUiSessionKey} from '../../platforms/react-native/protocol';
import {deriveOrientationViewState, deriveArmingReadiness} from '../../core';
import type {MspAttitude, MspBatteryState, ArmingBlockReason} from '../../core';

type Props = NativeStackScreenProps<RootStackParamList, 'Setup'>;

export default function SetupScreen({route, navigation}: Props): React.JSX.Element {
  const sessionKey = route.params?.sessionKey;

  if (!sessionKey) {
    return (
      <View style={styles.missingSessionRoot}>
        <Text style={styles.placeholderText} testID="setup-screen-missing-session">
          شاشة الإعداد (قيد الإنشاء)
        </Text>
      </View>
    );
  }

  return <SetupScreenContent sessionKey={sessionKey} onBack={() => navigation.goBack()} />;
}

function SetupScreenContent({
  sessionKey,
  onBack,
}: {
  sessionKey: SetupUiSessionKey;
  onBack: () => void;
}): React.JSX.Element {
  const {sessionId} = sessionKey;

  const attitude = useTelemetryValue<MspAttitude>(sessionId, ATTITUDE_TELEMETRY_POLL_ID);
  const armed = useTelemetryValue<boolean>(sessionId, ARMED_TELEMETRY_POLL_ID);
  const blockers = useTelemetryValue<ArmingBlockReason[]>(sessionId, ARMING_BLOCKERS_TELEMETRY_POLL_ID);
  // Pass 7.6b: the same generic hook/scheduler path attitude uses - the
  // poll itself exists only for identified-compatible Betaflight sessions
  // (Pass 7.6a), so every other session renders the card's honest
  // "unavailable" state through the exact same UNAVAILABLE mechanism.
  const battery = useTelemetryValue<MspBatteryState>(sessionId, BATTERY_TELEMETRY_POLL_ID);

  const [uiState, setUiState] = useState(() => setupUiSessionStore.getState(sessionKey));

  const orientationView = deriveOrientationViewState(attitude, uiState.orientationViewOffset);
  // Computed ONCE, threaded to both SafetyStrip and TopSystemBar's Row 2
  // arming badge - per Step 4's own established design, avoiding two
  // independently-derived ArmingReadiness values that could diverge by
  // a render tick.
  const armingReadiness = deriveArmingReadiness(armed, blockers);

  const handleResetView = useCallback(() => {
    setupUiSessionStore.resetOrientationViewOffset(sessionKey);
    setUiState(setupUiSessionStore.getState(sessionKey));
  }, [sessionKey]);

  const handleResetHintShown = useCallback(() => {
    setupUiSessionStore.update(sessionKey, {hasSeenOrientationResetHint: true});
    setUiState(setupUiSessionStore.getState(sessionKey));
  }, [sessionKey]);

  return (
    <View style={styles.root} testID="setup-screen">
      <TopSystemBar sessionId={sessionId} onBack={onBack} armingReadiness={armingReadiness} />
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <OrientationHero
          orientationView={orientationView}
          hasSeenResetHint={uiState.hasSeenOrientationResetHint}
          onResetView={handleResetView}
          onResetHintShown={handleResetHintShown}
        />
        <SafetyStrip readiness={armingReadiness} />
        {/* Pass 7.6b: Region 3's first summary card, mounted at the
            audited insertion point (after the approved Region 1+2
            sequence, inside the existing scroll content) - the approved
            product sequence places the card grid after SafetyStrip. */}
        <BatteryCard telemetry={battery} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  missingSessionRoot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
    padding: spacing.lg,
  },
  scrollContent: {
    paddingBottom: spacing.xl,
  },
  placeholderText: {
    ...typography.body,
    color: colors.textPrimary,
    marginTop: spacing.md,
    textAlign: 'center',
  },
});
