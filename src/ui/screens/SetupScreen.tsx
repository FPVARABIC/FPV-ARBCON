/**
 * The real Setup screen: connection state, live orientation model and
 * instruments, calibration/maintenance tools, read-only stability check,
 * arming readiness, telemetry summaries and detailed diagnostics. Protocol
 * ownership stays in the coordinator; this screen only subscribes to its
 * existing stores and dispatches through the established tool controller.
 *
 * ENTRY CLEANUP - the missing-sessionKey branch is now the PRODUCT, not
 * a defensive fallback. Start opens the 'Setup' route directly with no
 * params (see navigation/types.ts); this screen then renders the real
 * USB connection workspace (UsbConnectionScreen, hosted as a child
 * rather than a stack route) and re-parameterizes the route in place -
 * navigation.setParams({sessionKey}) - the moment a session genuinely
 * activates. No connection step is skipped and none is faked: the same
 * scan, the same explicit browser device chooser under a real user
 * gesture, the same MSP activation, the same ownership rules.
 *
 * If a session is ALREADY ACTIVE when the workspace mounts (the operator
 * pressed Back to Start - which deliberately does NOT deactivate - and
 * re-entered), the workspace ADOPTS the coordinator's real session
 * instead of offering a second connect against an already-open port:
 * a pure read of listSessionIds()/getOwnershipState()/getSessionKey(),
 * written straight back into the route params. Truthful both ways.
 *
 * SetupUiSessionStore (Pass 7.1) is a PLAIN, non-reactive store (by its
 * own explicit design - "no useSyncExternalStore hook, no subscribe/
 * notify machinery") - reading it once via a lazy useState initializer
 * and re-reading+setState()-ing it after every write (resetView/
 * hintShown below) is what makes this screen's UI actually reflect
 * store writes, without adding new reactive machinery to the store
 * itself. The old doc here justified the lazy mount-time read by "no
 * in-place re-parameterization anywhere in this codebase"; setParams
 * above made that argument stale, so the guarantee is now STRUCTURAL
 * instead: SetupScreenContent is keyed by sessionKey.sessionId at its
 * one render site below, so a param change is a fresh mount with fresh
 * lazy reads - the same pattern MotorsScreen already uses for exactly
 * this reason. Two concurrent instances for one session remain
 * impossible (single stack route, no getId()), so the Pass 7.4 latent
 * gap stays unreachable.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import type { RootStackParamList } from '../../navigation/types';
import {
  CONTENT_MAX_WIDTH,
  colors,
  spacing,
  typography,
  useContentEnvelope,
} from '../theme';
import { Button } from '../components/controls';
import {
  TopSystemBar,
  OrientationHero,
  OrientationCalibrationCard,
  OrientationStabilityPanel,
  SafetyStrip,
  SetupSafetyNotices,
  SetupSummaryLink,
  SensorsCard,
  BatteryCard,
  ReceiverCard,
  GpsCard,
  FlightControllerCard,
  DiagnosticsSection,
  FcToolsSection,
} from '../components/setup';
// SETUP P1: every protocol/session read now goes through the read-only
// Setup presentation boundary. `mspSessionCoordinator` and the raw
// telemetry poll ids are no longer reachable from this file - which is
// what makes the P0 defect unrepresentable rather than merely fixed: a
// screen that cannot name a poll id cannot subscribe to one that nothing
// registers. Commands remain a separate, explicit import
// (fcToolsController), so Setup's own capability stays visible.
import {
  useSetupAttitude,
  useSetupBattery,
  useSetupReceiver,
  useSetupGps,
  useSetupStatus,
  useSetupChannelState,
  useSetupConnected,
  useSetupIdentificationState,
  useSetupRecoveryState,
  useSetupAppStatePhase,
  useSetupArmedState,
  readSetupFreshAttitude,
  readSetupOwnershipState,
  readSetupIdentificationStatus,
  readSetupTelemetryDiagnostics,
  readSetupAppStatePhase,
  startSetupTelemetryOwnership,
  ensureSetupArmedStateAvailable,
} from '../../platforms/react-native/protocol/setupPresentation';
// SETUP P3: the ONE lifecycle action Setup performs on the protocol
// layer. It is imported from the protocol barrel rather than from the
// read-only presentation facade above, deliberately - acquiring a lease
// has a side effect on the scheduler, and hiding that behind a facade
// whose contract is "Setup only reads" would make the contract false.
import {
  useFcToolPublication,
  setupUiSessionStore,
  acquireSetupHiddenAttitudeSuppression,
} from '../../platforms/react-native/protocol';
import type { SetupUiSessionKey } from '../../platforms/react-native/protocol';
// ENTRY CLEANUP: the disconnected state renders the real connection
// workspace, and the top bar carries the intentional disconnect. BOTH
// capabilities live in setupSessionHost.tsx - the connection-lifecycle
// seam in this same screens layer - because SETUP P1
// (setupPresentationBoundary.test.ts) fences this file away from the
// coordinator, clients and transports. This screen consumes a component
// and a callback; it holds no session authority of its own.
import {
  SetupConnectWorkspace,
  useSetupSessionDisconnect,
} from './setupSessionHost';
// Checkpoint F - "نسخ تقرير التليمترية". Web-only by the same file
// extension seam the connection report uses; on Android
// isTelemetryReportSupported() is false and no button is rendered.
import {
  copyTelemetryReportToClipboard,
  isTelemetryReportSupported,
} from '../../platforms/telemetryReport';
import { orientationRenderObserver } from '../orientation3d/orientationRenderObserver';
import {
  deriveBatterySemantics,
  deriveOrientationViewState,
  deriveSetupArmingReadiness,
  deriveSetupSafetyFlags,
  deriveSetupRebootRequired,
  deriveSetupSensorSummary,
  deriveSetupWarnings,
  isGpsPresent,
  deriveSetupDiagnostics,
} from '../../core';
import type { OrientationViewOffset } from '../../core';

/**
 * SETUP P2: the navigation seam. Each callback opens the screen that OWNS
 * the corresponding configuration; Setup itself never writes any of it.
 * They are plain callbacks supplied by the tab shell (MainTabsScreen), so
 * this screen imports no navigator internals and no owner-screen
 * authority. Undefined means "no owner screen reachable in this host",
 * and the card then renders non-interactive rather than pretending.
 */
type Props = NativeStackScreenProps<RootStackParamList, 'Setup'> & {
  readonly onOpenGps?: () => void;
  readonly onOpenReceiver?: () => void;
  readonly onOpenPower?: () => void;
  readonly onOpenSensors?: () => void;
  readonly active?: boolean;
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
  onOpenReceiver,
  onOpenPower,
  onOpenSensors,
  active = true,
}: Props): React.JSX.Element {
  const sessionKey = route.params?.sessionKey;

  /**
   * The one place a session enters or leaves this route's params.
   * setParams (never navigate/push): the route is already focused, so
   * establishing a session is a param handoff - the navigation stack
   * does not move, Back still leads Home, and the session-loss redirect
   * (useSessionLossRedirect.ts) picks the new key up from its own
   * onStateChange, which react-navigation fires for setParams too.
   */
  const handleSessionEstablished = useCallback(
    (key: SetupUiSessionKey) => {
      navigation.setParams({ sessionKey: key });
    },
    [navigation],
  );

  if (!sessionKey) {
    return (
      <SetupConnectWorkspace onSessionEstablished={handleSessionEstablished} />
    );
  }

  return (
    <SetupScreenContent
      /* Keyed by session: a re-parameterization is a FRESH mount, which
         is what keeps this component's lazy mount-time store reads
         correct - see the header comment. */
      key={sessionKey.sessionId}
      sessionKey={sessionKey}
      onBack={() => navigation.goBack()}
      onOpenGps={onOpenGps}
      onOpenReceiver={onOpenReceiver}
      onOpenPower={onOpenPower}
      onOpenSensors={onOpenSensors}
      active={active}
    />
  );
}

function SetupScreenContent({
  sessionKey,
  onBack,
  onOpenGps,
  onOpenReceiver,
  onOpenPower,
  onOpenSensors,
  active,
}: {
  sessionKey: SetupUiSessionKey;
  onBack: () => void;
  onOpenGps?: () => void;
  onOpenReceiver?: () => void;
  onOpenPower?: () => void;
  onOpenSensors?: () => void;
  active: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { sessionId } = sessionKey;
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const useSingleColumnCards = shouldUseSingleColumnTelemetryCards(
    windowWidth,
    fontScale,
  );
  // Desktop tiers get the wider workspace envelope; narrower tiers keep
  // the 1180px reading cap. See useContentEnvelope.ts.
  const { maxWidth: contentMaxWidth } = useContentEnvelope(true);

  // SETUP P1: the `armed` and `armingBlockers` subscriptions are GONE.
  // Nothing in this application registers those two poll ids (the
  // coordinator documents both as reserved placeholders), so they
  // returned UNAVAILABLE forever and pinned the safety strip and the
  // top-bar badge to "arming state not confirmed" - while the FC tools on
  // this same screen correctly reported the aircraft as ARMED. The armed
  // truth now comes from the one authoritative source, below.

  // Pass 7.6b: the poll exists only for identified-compatible Betaflight
  // sessions (Pass 7.6a), so every other session renders the card's
  // honest "unavailable" state through the same UNAVAILABLE mechanism.
  // The one-strike timeout latch is applied inside the facade.
  const battery = useSetupBattery(sessionId, active);

  // INTENTIONAL DISCONNECT for the top bar. The capability itself lives
  // in setupSessionHost.tsx (the connection-lifecycle seam) - this
  // fenced screen only threads the resulting callback to the bar, the
  // same way it threads the shell's navigation callbacks.
  const handleDisconnect = useSetupSessionDisconnect(sessionId);

  // Pass 7.6c: Region 3's remaining channels, plus the per-channel
  // circuit-breaker verdicts.
  const receiver = useSetupReceiver(sessionId, active);
  const gps = useSetupGps(sessionId, active);
  const fcStatus = useSetupStatus(sessionId, active);
  const receiverChannelState = useSetupChannelState(sessionId, 'RECEIVER');
  const gpsChannelState = useSetupChannelState(sessionId, 'GPS');
  const fcChannelState = useSetupChannelState(sessionId, 'FC_STATUS');
  const connected = useSetupConnected(sessionId);

  const freshStatusValue =
    fcStatus.status === 'FRESH' || fcStatus.status === 'STALE'
      ? fcStatus.value
      : undefined;

  // Pass 7.7, Region 4: derived from the SAME identification state
  // Region 1 already reads and the SAME single FC-status poll Region 3
  // already renders - no second reader, no extra command.
  const identification = useSetupIdentificationState(sessionId);
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
  const recoveryState = useSetupRecoveryState(sessionId);
  const appStatePhase = useSetupAppStatePhase();
  // SETUP P1: THE single armed source on this screen. The FC tools gate
  // on this exact value, so the safety strip, the top-bar badge and the
  // tool buttons cannot contradict one another about ARMED.
  const armedState = useSetupArmedState(sessionId, freshStatusValue);
  // Deliberately dependency-free: the composite readiness identity is
  // (physicalGeneration, mspEpoch), and the epoch can change without any
  // rendered value changing with it (a desync/recovery cycle that
  // settles back to READY within one batch). The acquisition is
  // idempotent and returns immediately when the CURRENT identity has
  // already settled or is already in flight, so this is at most ONE
  // MSP_BOXIDS request per identity - never a poll, and never a retry
  // inside an identity.
  useEffect(() => {
    ensureSetupArmedStateAvailable(sessionId);
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
    startSetupTelemetryOwnership(sessionId);
  }, [sessionId]);

  // SETUP P3 - stop polling the orientation model nobody is looking at.
  //
  // MainTabsScreen keeps every opened tab MOUNTED behind display:'none'
  // rather than unmounting it (deliberately - see that file's header on
  // the Motors stop-bridge), so `active === false` is this screen's only
  // signal that its 20Hz model is off screen. MSP_ATTITUDE is registered
  // for the whole session and read by nothing outside this screen, so a
  // user who opened Setup once and moved to another tab was paying 20
  // requests a second, on a single-flight link, for pixels nobody could
  // see.
  //
  // The lease is taken while HIDDEN and released on the way back, so the
  // visible cadence is untouched. Effect ordering makes the return
  // seamless: React runs this cleanup before the newly-visible frame's
  // effects, so the poll is dispatchable again by the time the hero
  // subscribes. Depending on `sessionKey` (not just `sessionId`) means a
  // new generation re-acquires against its own scheduler instead of
  // silently holding a lease on a dead one.
  useEffect(() => {
    if (active) {
      return;
    }
    return acquireSetupHiddenAttitudeSuppression(sessionKey);
  }, [active, sessionKey]);

  // A new PHYSICAL session (new coordinator generation) must never read
  // the previous connection's render counts. The observer also self-heals
  // on a changed sessionToken; this effect covers the window before the
  // first sample of a new session has rendered at all.
  useEffect(() => {
    orientationRenderObserver.reset();
  }, [sessionId, sessionKey.generation]);

  const [uiState, setUiState] = useState(() =>
    setupUiSessionStore.getState(sessionKey),
  );

  // SETUP P1 - THE ONE SAFETY MODEL.
  //
  // Computed ONCE and threaded to both SafetyStrip and TopSystemBar's
  // arming badge, so the two surfaces cannot diverge - the same design
  // Step 4 established, now fed by evidence that actually exists.
  //
  // ARMED comes from the canonical BOXIDS + STATUS_EX path; the blocker
  // verdict comes from the SAME diagnostics view Region 4 renders, so
  // "the strip says blocked" and "the diagnostics list says blocked" are
  // by construction the same reading. No second decode, no second poll.
  const armingReadiness = deriveSetupArmingReadiness(
    armedState,
    diagnosticsView.blockers,
  );
  // RXLOSS / FAILSAFE / BOXFAILSAFE stay three SEPARATE facts, from that
  // same blocker evidence - never merged into one vague receiver problem.
  const safetyFlags = deriveSetupSafetyFlags(diagnosticsView.blockers);
  // The firmware's own reboot-required bit, off the STATUS_EX frame Setup
  // already polls. Only a FRESH reading may assert either answer: a stale
  // frame must not leave the warning glowing as though it were current.
  const rebootRequired = deriveSetupRebootRequired(
    freshStatusValue?.readiness.rebootRequired,
    diagnosticsView.dataState,
    freshStatusValue?.readiness.malformedTail === true,
  );
  // The firmware's own battery enum, via the SAME semantics BatteryCard
  // renders - no second mapping table. An unrecognised raw value stays
  // {kind:'UNKNOWN'} and is deliberately dropped here rather than
  // degrading to a false all-clear or a fabricated warning.
  const batterySemantics =
    battery.status === 'FRESH' ? deriveBatterySemantics(battery.value) : undefined;
  const batteryFirmwareState =
    typeof batterySemantics?.firmwareState === 'string'
      ? batterySemantics.firmwareState
      : undefined;
  // SETUP P2: the sensor detection summary now feeds a real dashboard
  // card as well as the diagnostics list below. ONE derivation, two
  // presentations - the chip and the detail line cannot disagree.
  const sensorSummary = deriveSetupSensorSummary(diagnosticsView.sensors);
  // P1 builds the warning model; P2 owns rendering a warning region.
  // Deriving it here now means the truth is proven and tested before any
  // layout depends on it.
  const setupWarnings = deriveSetupWarnings({
    connected,
    recovering: recoveryState !== undefined && recoveryState !== 'READY',
    armed: armedState,
    readinessStatus: armingReadiness.status,
    flags: safetyFlags,
    rebootRequired,
    receiverSignalUnavailable:
      connected &&
      (receiverChannelState !== 'ACTIVE' ||
        receiver.status === 'ERROR' ||
        receiver.status === 'UNAVAILABLE'),
    batteryState: batteryFirmwareState,
  });

  const handleResetView = useCallback(() => {
    // Read the AUTHORITATIVE state at press time, from the coordinator
    // and the scheduler themselves rather than from this callback's own
    // render closure. A press handler captured before a disconnect - a
    // tap already in flight, or a stale reference held by a queued event
    // - would otherwise capture a sample belonging to a session that has
    // since ended, and store it as this session's heading reference.
    const current = readSetupFreshAttitude(sessionId);
    if (current === undefined) {
      return;
    }
    setupUiSessionStore.resetOrientationViewOffset(
      sessionKey,
      current.yawDegrees,
    );
    setUiState(setupUiSessionStore.getState(sessionKey));
  }, [sessionKey, sessionId]);

  /**
   * Checkpoint F - "نسخ تقرير التليمترية".
   *
   * Everything is read AT PRESS TIME from the authoritative sources
   * (the coordinator, that session's real scheduler, the render
   * observer), never from this closure's render snapshot: a report is
   * evidence about the moment the user asked for it. A session with no
   * scheduler yields `scheduler: undefined`, which the report prints as
   * a stated fact rather than as zeros - "telemetry never started" and
   * "telemetry started and sent nothing" are different findings and must
   * not be collapsed.
   */
  const [telemetryReportCopied, setTelemetryReportCopied] = useState<
    'idle' | 'copied' | 'failed'
  >('idle');
  const handleCopyTelemetryReport = useCallback(() => {
    copyTelemetryReportToClipboard({
      sessionId,
      generation: sessionKey.generation,
      ownershipState: readSetupOwnershipState(sessionId),
      identificationStatus: readSetupIdentificationStatus(sessionId),
      appStatePhase: readSetupAppStatePhase(),
      setupActive: active,
      scheduler: readSetupTelemetryDiagnostics(sessionId),
      render: orientationRenderObserver.read(),
      wallClockMs: Date.now(),
    })
      .then(copied => setTelemetryReportCopied(copied ? 'copied' : 'failed'))
      .catch(() => setTelemetryReportCopied('failed'));
  }, [active, sessionId, sessionKey.generation]);

  const handleResetHintShown = useCallback(() => {
    setupUiSessionStore.update(sessionKey, {
      hasSeenOrientationResetHint: true,
    });
    setUiState(setupUiSessionStore.getState(sessionKey));
  }, [sessionKey]);

  // FINAL UI CORRECTION: ONE gate object for BOTH FC-tool surfaces (the
  // orientation-adjacent accelerometer card and the maintenance section
  // below), so their enablement can never diverge.
  const fcToolGate = {
    connected,
    appActive: appStatePhase === 'ACTIVE',
    recovering: recoveryState !== undefined && recoveryState !== 'READY',
    compatibility: diagnosticsView.compatibility,
    dataState: diagnosticsView.dataState,
    readingMalformed: freshStatusValue?.readiness.malformedTail === true,
    armedState,
    sensors:
      diagnosticsView.sensors.kind === 'REPORTED'
        ? diagnosticsView.sensors.bits
        : undefined,
  };

  return (
    <View style={styles.root} testID="setup-screen">
      <TopSystemBar
        sessionId={sessionId}
        onBack={onBack}
        armingReadiness={armingReadiness}
        onDisconnect={handleDisconnect}
      />
      <ScrollView contentContainerStyle={[styles.scrollContent, { maxWidth: contentMaxWidth }]}>
        {/* SETUP FINAL UI CORRECTION - THE ACCEPTED DASHBOARD ORDER.
            The product decision reversed P2's "live summary first" call:
            the orientation tools ARE the primary Setup instrument, so the
            3D model, the artificial horizon, the relative-direction dial
            and the accelerometer-calibration action now open the page -
            reachable without scrolling - with the stability check that
            calibration auto-starts directly beneath them.

            The order below is the accepted one:
              1. connection + identity (TopSystemBar, above this scroll)
              2. critical safety notices  - only when something is true
              3. arming readiness
              4. orientation: model + horizon + direction + calibration
              5. orientation stability check
              6. live aircraft summary    - Battery, Receiver/RSSI, GPS,
                 Sensors - immediately after the orientation block
              7. system diagnostics
              8. FC tools (maintenance: compass calibration + reboot;
                 the accelerometer action lives beside the model above) */}

        {/* 2. Conditional, and genuinely absent when nothing is true -
               a healthy aircraft costs zero vertical space here. */}
        <SetupSafetyNotices warnings={setupWarnings} />

        {/* 3. Arming readiness. Same canonical P1 truth, same component,
               same dimensions - only its position changed.

               Its 106px section heading is deliberately gone. Above the
               fold that heading cost more vertical space than the 52px
               strip it introduced, to explain a state that reads itself:
               "مسلّحة" / "✓ جاهزة للتسليح" needs no preamble. The
               explanatory headings that remain sit further down, where
               they orient rather than delay. */}
        <SafetyStrip readiness={armingReadiness} />

        {/* 4. ORIENTATION FIRST. The hero (dominant model + horizon +
               relative direction) opens the page, and the accelerometer
               calibration action sits directly under it so the operator
               levels the aircraft while watching the model - no scroll
               between seeing and acting. */}
        <SetupSectionHeading
          eyebrow={t('setupSections.orientationSection.eyebrow')}
          title={t('setupSections.orientationSection.title')}
          description={t('setupSections.orientationSection.description')}
          testID="setup-orientation-heading"
        />
        <LiveOrientationHero
          sessionKey={sessionKey}
          active={active}
          orientationViewOffset={uiState.orientationViewOffset}
          hasSeenResetHint={uiState.hasSeenOrientationResetHint}
          onResetView={handleResetView}
          onResetHintShown={handleResetHintShown}
          calibrationSlot={
            <OrientationCalibrationCard
              sessionId={sessionId}
              gate={fcToolGate}
              variant="inline"
            />
          }
        />

        {/* 5. The read-only stability check stays with the thing it
               measures - and with the calibration that auto-starts it. */}
        <LiveOrientationStabilityPanel
          sessionKey={sessionKey}
          active={active}
        />

        {/* 6. THE LIVE SUMMARY, immediately after orientation. Every card
               reads the snapshot this screen already derived - no card
               acquires telemetry of its own. Battery leads (the number an
               operator reads first), then Receiver/RSSI, GPS, Sensors. */}
        <SetupSectionHeading
          eyebrow={t('setupSections.live.eyebrow')}
          title={t('setupSections.live.title')}
          description={t('setupSections.live.description')}
          testID="setup-live-heading"
        />
        <View style={styles.cardGrid} testID="telemetry-card-grid">
          {/* Battery and Sensors take the full row. Measured reason, not
              taste: in a half-width 179px column the seven sensor chips
              stack vertically into a 534px tower that pushes the whole
              page down, and the battery's voltage - the number an
              operator reads first - competes with it for height. Across
              the row the chips flow horizontally and both cards shrink. */}
          <View style={[styles.cardCell, styles.cardCellFull]}>
            <SetupSummaryLink
              onPress={onOpenPower}
              accessibilityLabel={t('setupNavigation.openPower')}
              testID="setup-open-power"
            >
              <BatteryCard telemetry={battery} />
            </SetupSummaryLink>
          </View>
          <View
            style={[styles.cardCell, useSingleColumnCards && styles.cardCellFull]}
          >
            <SetupSummaryLink
              onPress={onOpenReceiver}
              accessibilityLabel={t('setupNavigation.openReceiver')}
              testID="setup-open-receiver"
            >
              <ReceiverCard
                connected={connected}
                channelState={receiverChannelState}
                telemetry={receiver}
              />
            </SetupSummaryLink>
          </View>
          <View
            style={[styles.cardCell, useSingleColumnCards && styles.cardCellFull]}
          >
            <SetupSummaryLink
              onPress={onOpenGps}
              accessibilityLabel={t('setupNavigation.openGps')}
              testID="setup-open-gps"
            >
              <GpsCard
                connected={connected}
                channelState={gpsChannelState}
                telemetry={gps}
                gpsPresent={gpsPresent}
              />
            </SetupSummaryLink>
          </View>
          <View style={[styles.cardCell, styles.cardCellFull]}>
            <SetupSummaryLink
              onPress={onOpenSensors}
              accessibilityLabel={t('setupNavigation.openSensors')}
              testID="setup-open-sensors"
            >
              <SensorsCard summary={sensorSummary} />
            </SetupSummaryLink>
          </View>
        </View>

        {/* 7-8. Maintenance. Deep diagnostics and the remaining protected
                 tools (compass calibration, reboot) keep their full
                 surface here; the accelerometer action moved beside the
                 model above with identical gating and identical flow. */}
        <SetupSectionHeading
          eyebrow={t('setupSections.maintenance.eyebrow')}
          title={t('setupSections.maintenance.title')}
          description={t('setupSections.maintenance.description')}
          testID="setup-maintenance-heading"
        />
        <View style={styles.cardGrid} testID="setup-system-grid">
          <View
            style={[styles.cardCell, styles.cardCellFull]}
          >
            <FlightControllerCard
              connected={connected}
              channelState={fcChannelState}
              telemetry={fcStatus}
            />
          </View>
        </View>
        <DiagnosticsSection view={diagnosticsView} />
        <FcToolsSection
          sessionId={sessionId}
          gate={fcToolGate}
          tools={['MAG_CALIBRATION', 'REBOOT']}
        />
        {isTelemetryReportSupported() ? (
          <View style={styles.telemetryReportRow}>
            <Button
              label={t('diagnostics.copyTelemetryReport')}
              onPress={handleCopyTelemetryReport}
              variant="secondary"
              icon="copy"
              testID="copy-telemetry-report"
            />
            <Text style={styles.telemetryReportHint}>
              {t('diagnostics.copyTelemetryReportHint')}
            </Text>
            {telemetryReportCopied !== 'idle' ? (
              <Text
                style={styles.telemetryReportHint}
                testID="copy-telemetry-report-result"
              >
                {t(
                  telemetryReportCopied === 'copied'
                    ? 'diagnostics.copyTelemetryReportDone'
                    : 'diagnostics.copyTelemetryReportFailed',
                )}
              </Text>
            ) : null}
          </View>
        ) : null}
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
  active,
  orientationViewOffset,
  hasSeenResetHint,
  onResetView,
  onResetHintShown,
  calibrationSlot,
}: {
  sessionKey: SetupUiSessionKey;
  active: boolean;
  orientationViewOffset: OrientationViewOffset;
  hasSeenResetHint: boolean;
  onResetView: () => void;
  onResetHintShown: () => void;
  calibrationSlot?: React.ReactNode;
}): React.JSX.Element {
  const attitude = useSetupAttitude(sessionKey.sessionId, active);
  const connected = useSetupConnected(sessionKey.sessionId);
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
      canReset={attitude.status === 'FRESH' && connected}
      onResetView={onResetView}
      onResetHintShown={onResetHintShown}
      calibrationSlot={calibrationSlot}
    />
  );
}

/** A second narrow 20Hz boundary: it observes the same scheduler cache as
 * the model (no duplicate MSP poll) and keeps capture progress away from
 * the rest of Setup. */
function LiveOrientationStabilityPanel({
  sessionKey,
  active,
}: {
  sessionKey: SetupUiSessionKey;
  active: boolean;
}): React.JSX.Element {
  const attitude = useSetupAttitude(sessionKey.sessionId, active);
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
  scrollContent: {
    paddingBottom: spacing.xxl,
    width: '100%',
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: 'center',
  },
  cardGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  telemetryReportRow: {
    marginTop: spacing.md,
    marginHorizontal: spacing.md,
    gap: spacing.xs,
  },
  telemetryReportButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: 10,
    backgroundColor: colors.surface,
  },
  telemetryReportHint: {
    ...typography.caption,
    color: colors.textSecondary,
    textAlign: 'center',
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
  sectionEyebrow: { ...typography.eyebrow, color: colors.accentStrong },
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
});
