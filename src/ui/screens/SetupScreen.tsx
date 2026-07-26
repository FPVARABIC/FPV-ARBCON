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

import React, {useCallback, useEffect, useState} from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';

import type {RootStackParamList} from '../../navigation/types';
import {colors, spacing, typography} from '../theme';
import {
  TopSystemBar,
  OrientationHero,
  SafetyStrip,
  BatteryCard,
  ReceiverCard,
  GpsCard,
  FlightControllerCard,
  DiagnosticsSection,
} from '../components/setup';
import {
  useTelemetryValue,
  useMspOwnershipState,
  useMspIdentificationState,
  useAuxTelemetryChannelState,
  useBatteryLatchedValue,
  setupAppStateTelemetryOwner,
  setupUiSessionStore,
  ATTITUDE_TELEMETRY_POLL_ID,
  ARMED_TELEMETRY_POLL_ID,
  ARMING_BLOCKERS_TELEMETRY_POLL_ID,
  BATTERY_TELEMETRY_POLL_ID,
  RECEIVER_TELEMETRY_POLL_ID,
  GPS_TELEMETRY_POLL_ID,
  FC_STATUS_TELEMETRY_POLL_ID,
} from '../../platforms/react-native/protocol';
import type {SetupUiSessionKey} from '../../platforms/react-native/protocol';
import {deriveOrientationViewState, deriveArmingReadiness, isGpsPresent, deriveSetupDiagnostics} from '../../core';
import type {
  MspAttitude,
  MspBatteryState,
  MspAnalog,
  MspRawGpsCompact,
  MspStatusExDiagnostics,
  ArmingBlockReason,
} from '../../core';

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
  const batteryPolled = useTelemetryValue<MspBatteryState>(sessionId, BATTERY_TELEMETRY_POLL_ID);
  // Pass 7.7: once the one-strike battery timeout breaker has fired, the
  // poll is unregistered (scheduler reports UNAVAILABLE). The latch is the
  // truthful replacement: the pre-timeout reading frozen as STALE (no
  // longer updating), or a read-timeout ERROR when nothing ever succeeded.
  const batteryLatched = useBatteryLatchedValue(sessionId);
  const battery = batteryLatched ?? batteryPolled;

  // Pass 7.6c: Region 3's remaining channels - the same generic hook/
  // scheduler path, plus the per-channel circuit-breaker verdicts from
  // the coordinator.
  const receiver = useTelemetryValue<MspAnalog>(sessionId, RECEIVER_TELEMETRY_POLL_ID);
  const gps = useTelemetryValue<MspRawGpsCompact>(sessionId, GPS_TELEMETRY_POLL_ID);
  const fcStatus = useTelemetryValue<MspStatusExDiagnostics>(sessionId, FC_STATUS_TELEMETRY_POLL_ID);
  const receiverChannelState = useAuxTelemetryChannelState(sessionId, RECEIVER_TELEMETRY_POLL_ID);
  const gpsChannelState = useAuxTelemetryChannelState(sessionId, GPS_TELEMETRY_POLL_ID);
  const fcChannelState = useAuxTelemetryChannelState(sessionId, FC_STATUS_TELEMETRY_POLL_ID);
  const ownershipState = useMspOwnershipState(sessionId);
  const connected = ownershipState === 'ACTIVE';

  // Pass 7.7, Region 4: derived from the SAME identification state
  // Region 1 already reads and the SAME single FC-status poll Region 3
  // already renders - no second reader, no extra command.
  const identification = useMspIdentificationState(sessionId);
  const diagnosticsView = deriveSetupDiagnostics({
    connected,
    channelState: fcChannelState,
    status: fcStatus.status,
    value: fcStatus.status === 'FRESH' || fcStatus.status === 'STALE' ? fcStatus.value : undefined,
    identificationStatus: identification.status,
    identity: identification.status === 'SUCCEEDED' ? identification.identity : undefined,
  });

  // GPS presence proof comes from the SHARED MSP_STATUS_EX decode (a
  // stale sensor mask still proves the FC detected the hardware);
  // undefined = not provable right now.
  const gpsPresent =
    fcStatus.status === 'FRESH' || fcStatus.status === 'STALE' ? isGpsPresent(fcStatus.value) : undefined;

  // Pass 7.7: the ONE AppState owner (module singleton) pauses/resumes
  // telemetry through the scheduler's own lease API. The screen only
  // starts it and registers this session; it never becomes a second
  // AppState listener or a second polling owner, and unmounting the
  // screen does NOT close the coordinator-owned physical session.
  useEffect(() => {
    setupAppStateTelemetryOwner.start();
    setupAppStateTelemetryOwner.track(sessionId);
  }, [sessionId]);

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
        {/* Pass 7.6c: the complete Region 3 2x2 card grid at the audited
            insertion point (after the approved Region 1+2 sequence).
            Tree/accessibility order is the approved diagnostic order
            Battery -> Receiver -> GPS -> FC; under the app's RTL layout,
            row-wrapping renders row 1 as Battery (right) / Receiver
            (left) and row 2 as GPS (right) / FC (left). Display-only -
            no press actions, no navigation, no horizontal scroll. */}
        <View style={styles.cardGrid} testID="telemetry-card-grid">
          <View style={styles.cardCell}>
            <BatteryCard telemetry={battery} />
          </View>
          <View style={styles.cardCell}>
            <ReceiverCard connected={connected} channelState={receiverChannelState} telemetry={receiver} />
          </View>
          <View style={styles.cardCell}>
            <GpsCard connected={connected} channelState={gpsChannelState} telemetry={gps} gpsPresent={gpsPresent} />
          </View>
          <View style={styles.cardCell}>
            <FlightControllerCard connected={connected} channelState={fcChannelState} telemetry={fcStatus} />
          </View>
        </View>
        {/* Pass 7.7: Region 4 immediately after Region 3. */}
        <DiagnosticsSection view={diagnosticsView} />
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
  cardGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  cardCell: {
    width: '50%',
    padding: spacing.xs,
  },
  placeholderText: {
    ...typography.body,
    color: colors.textPrimary,
    marginTop: spacing.md,
    textAlign: 'center',
  },
});
