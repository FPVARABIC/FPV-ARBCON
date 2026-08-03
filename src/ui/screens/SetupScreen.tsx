/**
 * The real Setup screen: connection state, live orientation model and
 * instruments, calibration/maintenance tools, read-only stability check,
 * arming readiness, telemetry summaries and detailed diagnostics. Protocol
 * ownership stays in the coordinator; this screen only subscribes to its
 * existing stores and dispatches through the established tool controller.
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

import React, { useCallback, useEffect, useState } from 'react';
import {
  ScrollView,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import type { RootStackParamList } from '../../navigation/types';
import { colors, spacing, typography } from '../theme';
import {
  TopSystemBar,
  OrientationHero,
  OrientationStabilityPanel,
  SafetyStrip,
  BatteryCard,
  ReceiverCard,
  GpsCard,
  FlightControllerCard,
  DiagnosticsSection,
  FcToolsSection,
} from '../components/setup';
import {
  useTelemetryValue,
  useMspOwnershipState,
  useMspIdentificationState,
  useMspRecoveryState,
  useSetupAppStatePhase,
  useFcToolArmedState,
  useFcToolPublication,
  fcToolsController,
  useAuxTelemetryChannelState,
  useBatteryLatchedValue,
  setupAppStateTelemetryOwner,
  setupUiSessionStore,
  mspSessionCoordinator,
  ATTITUDE_TELEMETRY_POLL_ID,
  ARMED_TELEMETRY_POLL_ID,
  ARMING_BLOCKERS_TELEMETRY_POLL_ID,
  BATTERY_TELEMETRY_POLL_ID,
  RECEIVER_TELEMETRY_POLL_ID,
  GPS_TELEMETRY_POLL_ID,
  FC_STATUS_TELEMETRY_POLL_ID,
} from '../../platforms/react-native/protocol';
import type { SetupUiSessionKey } from '../../platforms/react-native/protocol';
import {
  deriveOrientationViewState,
  deriveArmingReadiness,
  isGpsPresent,
  deriveSetupDiagnostics,
} from '../../core';
import type {
  MspAttitude,
  MspBatteryState,
  MspAnalog,
  MspRawGpsCompact,
  MspStatusExDiagnostics,
  ArmingBlockReason,
  OrientationViewOffset,
} from '../../core';

type Props = NativeStackScreenProps<RootStackParamList, 'Setup'> & {
  readonly onOpenGps?: () => void;
};

export function shouldUseSingleColumnTelemetryCards(
  windowWidth: number,
  fontScale: number,
): boolean {
  return windowWidth / Math.max(fontScale, 1) < 360;
}

export default function SetupScreen({
  route,
  navigation,
  onOpenGps,
}: Props): React.JSX.Element {
  const { t } = useTranslation();
  const sessionKey = route.params?.sessionKey;

  if (!sessionKey) {
    return (
      <View style={styles.missingSessionRoot}>
        <Text
          style={styles.missingSessionTitle}
          testID="setup-screen-missing-session"
        >
          {t('setupMissingSession.title')}
        </Text>
        <Text style={styles.placeholderText}>
          {t('setupMissingSession.message')}
        </Text>
        <Pressable
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          style={styles.missingSessionButton}
          testID="setup-screen-missing-session-back"
        >
          <Text style={styles.missingSessionButtonText}>
            {t('setupMissingSession.back')}
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <SetupScreenContent
      sessionKey={sessionKey}
      onBack={() => navigation.goBack()}
      onOpenGps={onOpenGps}
    />
  );
}

function SetupScreenContent({
  sessionKey,
  onBack,
  onOpenGps,
}: {
  sessionKey: SetupUiSessionKey;
  onBack: () => void;
  onOpenGps?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { sessionId } = sessionKey;
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const useSingleColumnCards = shouldUseSingleColumnTelemetryCards(
    windowWidth,
    fontScale,
  );

  const armed = useTelemetryValue<boolean>(sessionId, ARMED_TELEMETRY_POLL_ID);
  const blockers = useTelemetryValue<ArmingBlockReason[]>(
    sessionId,
    ARMING_BLOCKERS_TELEMETRY_POLL_ID,
  );
  // Pass 7.6b: the same generic hook/scheduler path attitude uses - the
  // poll itself exists only for identified-compatible Betaflight sessions
  // (Pass 7.6a), so every other session renders the card's honest
  // "unavailable" state through the exact same UNAVAILABLE mechanism.
  const batteryPolled = useTelemetryValue<MspBatteryState>(
    sessionId,
    BATTERY_TELEMETRY_POLL_ID,
  );
  // Pass 7.7: once the one-strike battery timeout breaker has fired, the
  // poll is unregistered (scheduler reports UNAVAILABLE). The latch is the
  // truthful replacement: the pre-timeout reading frozen as STALE (no
  // longer updating), or a read-timeout ERROR when nothing ever succeeded.
  const batteryLatched = useBatteryLatchedValue(sessionId);
  const battery = batteryLatched ?? batteryPolled;

  // Pass 7.6c: Region 3's remaining channels - the same generic hook/
  // scheduler path, plus the per-channel circuit-breaker verdicts from
  // the coordinator.
  const receiver = useTelemetryValue<MspAnalog>(
    sessionId,
    RECEIVER_TELEMETRY_POLL_ID,
  );
  const gps = useTelemetryValue<MspRawGpsCompact>(
    sessionId,
    GPS_TELEMETRY_POLL_ID,
  );
  const fcStatus = useTelemetryValue<MspStatusExDiagnostics>(
    sessionId,
    FC_STATUS_TELEMETRY_POLL_ID,
  );
  const receiverChannelState = useAuxTelemetryChannelState(
    sessionId,
    RECEIVER_TELEMETRY_POLL_ID,
  );
  const gpsChannelState = useAuxTelemetryChannelState(
    sessionId,
    GPS_TELEMETRY_POLL_ID,
  );
  const fcChannelState = useAuxTelemetryChannelState(
    sessionId,
    FC_STATUS_TELEMETRY_POLL_ID,
  );
  const ownershipState = useMspOwnershipState(sessionId);
  const connected = ownershipState === 'ACTIVE';

  const freshStatusValue =
    fcStatus.status === 'FRESH' || fcStatus.status === 'STALE'
      ? fcStatus.value
      : undefined;

  // Pass 7.7, Region 4: derived from the SAME identification state
  // Region 1 already reads and the SAME single FC-status poll Region 3
  // already renders - no second reader, no extra command.
  const identification = useMspIdentificationState(sessionId);
  const diagnosticsView = deriveSetupDiagnostics({
    connected,
    channelState: fcChannelState,
    status: fcStatus.status,
    value: freshStatusValue,
    identificationStatus: identification.status,
    identity:
      identification.status === 'SUCCEEDED'
        ? identification.identity
        : undefined,
  });

  // Pass 7.7, Region 5 inputs. The armed state is read ONLY from the
  // at-most-once BOXIDS mapping (never from the blocker mask, never
  // guessed); the effect below starts that one acquisition after a
  // compatible identification, and never polls it.
  const recoveryState = useMspRecoveryState(sessionId);
  const appStatePhase = useSetupAppStatePhase();
  const cachedArmedState = useFcToolArmedState(sessionId, freshStatusValue);
  // Deliberately dependency-free: the composite readiness identity is
  // (physicalGeneration, mspEpoch), and the epoch can change without any
  // rendered value changing with it (a desync/recovery cycle that
  // settles back to READY within one batch). ensureBoxIdsMapping() is
  // idempotent and returns immediately when the CURRENT identity has
  // already settled or is already in flight, so this is at most ONE
  // MSP_BOXIDS request per identity - never a poll, and never a retry
  // inside an identity.
  useEffect(() => {
    fcToolsController.ensureBoxIdsMapping(sessionId);
  });

  // GPS presence proof comes from the SHARED MSP_STATUS_EX decode (a
  // stale sensor mask still proves the FC detected the hardware);
  // undefined = not provable right now.
  const gpsPresent =
    freshStatusValue === undefined ? undefined : isGpsPresent(freshStatusValue);

  // Pass 7.7: the ONE AppState owner (module singleton) pauses/resumes
  // telemetry through the scheduler's own lease API. The screen only
  // starts it and registers this session; it never becomes a second
  // AppState listener or a second polling owner, and unmounting the
  // screen does NOT close the coordinator-owned physical session.
  useEffect(() => {
    setupAppStateTelemetryOwner.start();
    setupAppStateTelemetryOwner.track(sessionId);
  }, [sessionId]);

  const [uiState, setUiState] = useState(() =>
    setupUiSessionStore.getState(sessionKey),
  );

  // Computed ONCE, threaded to both SafetyStrip and TopSystemBar's Row 2
  // arming badge - per Step 4's own established design, avoiding two
  // independently-derived ArmingReadiness values that could diverge by
  // a render tick.
  const armingReadiness = deriveArmingReadiness(armed, blockers);

  const handleResetView = useCallback(() => {
    // Read the AUTHORITATIVE state at press time, from the coordinator
    // and the scheduler themselves rather than from this callback's own
    // render closure. A press handler captured before a disconnect - a
    // tap already in flight, or a stale reference held by a queued event
    // - would otherwise capture a sample belonging to a session that has
    // since ended, and store it as this session's heading reference.
    if (mspSessionCoordinator.getOwnershipState(sessionId) !== 'ACTIVE') {
      return;
    }
    const current = mspSessionCoordinator
      .getTelemetryScheduler(sessionId)
      ?.getValue<MspAttitude>(ATTITUDE_TELEMETRY_POLL_ID);
    if (current === undefined || current.status !== 'FRESH') {
      return;
    }
    setupUiSessionStore.resetOrientationViewOffset(
      sessionKey,
      current.value.yawDegrees,
    );
    setUiState(setupUiSessionStore.getState(sessionKey));
  }, [sessionKey, sessionId]);

  const handleResetHintShown = useCallback(() => {
    setupUiSessionStore.update(sessionKey, {
      hasSeenOrientationResetHint: true,
    });
    setUiState(setupUiSessionStore.getState(sessionKey));
  }, [sessionKey]);

  return (
    <View style={styles.root} testID="setup-screen">
      <TopSystemBar
        sessionId={sessionId}
        onBack={onBack}
        armingReadiness={armingReadiness}
      />
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <LiveOrientationHero
          sessionKey={sessionKey}
          orientationViewOffset={uiState.orientationViewOffset}
          hasSeenResetHint={uiState.hasSeenOrientationResetHint}
          onResetView={handleResetView}
          onResetHintShown={handleResetHintShown}
        />
        {/* FINAL-POLISH PASS: "أدوات وحدة التحكم" moved to sit directly
            below the COMPLETE Orientation section (model, instruments,
            readouts, note, reset button) - calibration and reboot controls
            belong next to the thing they act on, not below the
            diagnostics. This is the SAME component invocation with the
            same props, relocated; nothing about its gating, its
            confirmation flow or its commands changed, and no status
            strip, telemetry card or diagnostic block may sit between
            the two. Everything below keeps its previous relative
            order. */}
        <FcToolsSection
          sessionId={sessionId}
          gate={{
            connected,
            appActive: appStatePhase === 'ACTIVE',
            recovering:
              recoveryState !== undefined && recoveryState !== 'READY',
            compatibility: diagnosticsView.compatibility,
            dataState: diagnosticsView.dataState,
            readingMalformed:
              freshStatusValue?.readiness.malformedTail === true,
            armedState: cachedArmedState,
            sensors:
              diagnosticsView.sensors.kind === 'REPORTED'
                ? diagnosticsView.sensors.bits
                : undefined,
          }}
        />
        <LiveOrientationStabilityPanel sessionKey={sessionKey} />
        <SetupSectionHeading
          eyebrow={t('setupSections.readiness.eyebrow')}
          title={t('setupSections.readiness.title')}
          description={t('setupSections.readiness.description')}
          testID="setup-readiness-heading"
        />
        <SafetyStrip readiness={armingReadiness} />
        {/* Pass 7.6c: the complete Region 3 2x2 card grid at the audited
            insertion point (after the approved Region 1+2 sequence).
            Tree/accessibility order is the approved diagnostic order
            Battery -> Receiver -> GPS -> FC; under the app's RTL layout,
            row-wrapping renders row 1 as Battery (right) / Receiver
            (left) and row 2 as GPS (right) / FC (left). Display-only -
            no press actions, no navigation, no horizontal scroll. */}
        <SetupSectionHeading
          eyebrow={t('setupSections.overview.eyebrow')}
          title={t('setupSections.overview.title')}
          description={t('setupSections.overview.description')}
          testID="setup-overview-heading"
        />
        <View style={styles.cardGrid} testID="telemetry-card-grid">
          <View
            style={[
              styles.cardCell,
              useSingleColumnCards && styles.cardCellFull,
            ]}
          >
            <BatteryCard telemetry={battery} />
          </View>
          <View
            style={[
              styles.cardCell,
              useSingleColumnCards && styles.cardCellFull,
            ]}
          >
            <ReceiverCard
              connected={connected}
              channelState={receiverChannelState}
              telemetry={receiver}
            />
          </View>
          <View
            style={[
              styles.cardCell,
              useSingleColumnCards && styles.cardCellFull,
            ]}
          >
            <Pressable
              disabled={onOpenGps === undefined}
              onPress={onOpenGps}
              accessibilityRole="button"
              accessibilityLabel={t('gpsSystem.openFromSetup')}
              testID="setup-open-gps"
            >
              <GpsCard
                connected={connected}
                channelState={gpsChannelState}
                telemetry={gps}
                gpsPresent={gpsPresent}
              />
            </Pressable>
          </View>
          <View
            style={[
              styles.cardCell,
              useSingleColumnCards && styles.cardCellFull,
            ]}
          >
            <FlightControllerCard
              connected={connected}
              channelState={fcChannelState}
              telemetry={fcStatus}
            />
          </View>
        </View>
        {/* Pass 7.7: Region 4 immediately after Region 3. Region 5
            ("أدوات وحدة التحكم") used to follow here; the final-polish
            pass moved that one section up to sit directly under the
            Orientation hero. Nothing else in this order changed. */}
        <DiagnosticsSection view={diagnosticsView} />
      </ScrollView>
    </View>
  );
}

function SetupSectionHeading({
  eyebrow,
  title,
  description,
  testID,
}: {
  eyebrow: string;
  title: string;
  description: string;
  testID: string;
}): React.JSX.Element {
  return (
    <View style={styles.sectionHeading} testID={testID}>
      <View style={styles.sectionHeadingMark} />
      <View style={styles.sectionHeadingCopy}>
        <Text style={styles.sectionEyebrow}>{eyebrow}</Text>
        <Text style={styles.sectionTitle} accessibilityRole="header">
          {title}
        </Text>
        <Text style={styles.sectionDescription}>{description}</Text>
      </View>
    </View>
  );
}

/**
 * Owns the high-frequency attitude subscription so a 20Hz orientation
 * stream only re-renders the model/readouts subtree. Before this boundary,
 * every genuine attitude sample re-executed the complete Setup screen,
 * including diagnostics, FC tools and all telemetry cards, even though
 * none of them consumed that sample.
 */
function LiveOrientationHero({
  sessionKey,
  orientationViewOffset,
  hasSeenResetHint,
  onResetView,
  onResetHintShown,
}: {
  sessionKey: SetupUiSessionKey;
  orientationViewOffset: OrientationViewOffset;
  hasSeenResetHint: boolean;
  onResetView: () => void;
  onResetHintShown: () => void;
}): React.JSX.Element {
  const attitude = useTelemetryValue<MspAttitude>(
    sessionKey.sessionId,
    ATTITUDE_TELEMETRY_POLL_ID,
  );
  const ownershipState = useMspOwnershipState(sessionKey.sessionId);
  const orientationView = deriveOrientationViewState(
    attitude,
    orientationViewOffset,
  );
  const hasSample = attitude.status === 'FRESH' || attitude.status === 'STALE';

  const sampleSeq = hasSample ? attitude.sampleSeq : undefined;
  const sampleReceivedAt = hasSample ? attitude.updatedAtMs : undefined;

  return (
    <OrientationHero
      orientationView={orientationView}
      hasSeenResetHint={hasSeenResetHint}
      // Diagnostics scope + sample identity. A sampleSeq is only
      // comparable within one physical session, so it travels with the
      // composite key; neither value affects what is drawn.
      sessionToken={`${sessionKey.sessionId}:${sessionKey.generation}`}
      sampleSeq={sampleSeq}
      sampleReceivedAt={sampleReceivedAt}
      canReset={attitude.status === 'FRESH' && ownershipState === 'ACTIVE'}
      onResetView={onResetView}
      onResetHintShown={onResetHintShown}
    />
  );
}

/** A second narrow 20Hz boundary: it observes the same scheduler cache as
 * the model (no duplicate MSP poll) and keeps capture progress away from
 * the rest of Setup. */
function LiveOrientationStabilityPanel({
  sessionKey,
}: {
  sessionKey: SetupUiSessionKey;
}): React.JSX.Element {
  const attitude = useTelemetryValue<MspAttitude>(
    sessionKey.sessionId,
    ATTITUDE_TELEMETRY_POLL_ID,
  );
  const orientationView = deriveOrientationViewState(attitude);
  const hasSample = attitude.status === 'FRESH' || attitude.status === 'STALE';
  const outcome = useFcToolPublication(sessionKey.sessionId);
  const autoStartSignal =
    outcome?.kind === 'ACCEPTED' && outcome.tool === 'ACC_CALIBRATION'
      ? outcome
      : undefined;

  return (
    <OrientationStabilityPanel
      key={`${sessionKey.sessionId}:${sessionKey.generation}`}
      orientationView={orientationView}
      sampleSeq={hasSample ? attitude.sampleSeq : undefined}
      sampleReceivedAt={hasSample ? attitude.updatedAtMs : undefined}
      autoStartSignal={autoStartSignal}
    />
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
    paddingBottom: spacing.xxl,
    width: '100%',
    maxWidth: 1180,
    alignSelf: 'center',
  },
  cardGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  sectionHeading: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: spacing.md,
    marginTop: spacing.xl,
    marginHorizontal: spacing.md,
    paddingHorizontal: spacing.xs,
  },
  sectionHeadingMark: {
    width: 3,
    borderRadius: 2,
    backgroundColor: colors.accent,
  },
  sectionHeadingCopy: { flex: 1 },
  sectionEyebrow: { ...typography.eyebrow, color: colors.accent },
  sectionTitle: {
    ...typography.title,
    color: colors.textPrimary,
    marginTop: 2,
  },
  sectionDescription: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
  cardCell: {
    width: '50%',
    padding: spacing.xs,
  },
  cardCellFull: {
    width: '100%',
  },
  placeholderText: {
    ...typography.body,
    color: colors.textPrimary,
    marginTop: spacing.md,
    textAlign: 'center',
  },
  missingSessionTitle: {
    ...typography.title,
    color: colors.textPrimary,
    textAlign: 'center',
  },
  missingSessionButton: {
    minHeight: 48,
    marginTop: spacing.lg,
    paddingHorizontal: spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    backgroundColor: colors.accent,
  },
  missingSessionButtonText: {
    ...typography.body,
    color: colors.accentText,
    fontWeight: '700',
  },
});
