/**
 * The real Setup screen. SETUP R9 rebuilt its information hierarchy:
 *
 *   48px chrome            back, title, connection dot, disconnect
 *   compact status area    connection, board, firmware, MSP API, arming,
 *                          battery, and every sensor the FC's own
 *                          presence mask reports
 *   safety strip           ONLY when ARMED or genuinely BLOCKED
 *   3D attitude hero       live heading/pitch/roll with the model, and
 *                          the accelerometer calibration action
 *   information grid       Status / GPS / Build, three dense columns
 *   board alignment        a full feature, after the live information
 *   advanced               notices, stability check, diagnostics, FC
 *                          tools, telemetry report
 *
 * WHAT THAT REPLACED, measured on a 1920px desktop with a populated
 * board: a 139px teal bar, an 84px section heading, the model at y=186,
 * and the aircraft's own state scattered from y=1403 (battery) to
 * y=1849 (sensors) across four elevated cards, over 3353px of scroll.
 * The same board now measures 2441px with every one of those facts in
 * the first viewport.
 *
 * Protocol ownership stays in the coordinator; this screen only
 * subscribes to its existing stores and dispatches through the
 * established tool controller.
 *
 * THIS SCREEN ONLY EXISTS WITH A BOARD BEHIND IT. The 'Setup' route is
 * registered in the navigator only while a flight controller is
 * verified, so there is no disconnected posture to render here and no
 * connection workspace hosted underneath - connecting happens on Home
 * (ui/session/useDirectConnect), before this route exists at all.
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
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import type { RootStackParamList } from '../../navigation/types';
import {
  PROSE_MEASURE,
  colors,
  isDesktopTier,
  spacing,
  typography,
  useContentEnvelope,
} from '../theme';
import {
  SetupChromeBar,
  SetupStatusBar,
  SetupInfoGrid,
  OrientationHero,
  OrientationCalibrationCard,
  BoardAlignmentCard,
  OrientationStabilityPanel,
  SafetyStrip,
  SetupSafetyNotices,
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
// The top bar's intentional disconnect lives in setupSessionHost.tsx -
// the connection-lifecycle seam in this same screens layer - because
// SETUP P1 (setupPresentationBoundary.test.ts) fences this file away
// from the coordinator, clients and transports. This screen consumes a
// callback; it holds no session authority of its own.
import { useSetupSessionDisconnect } from './setupSessionHost';
import { orientationRenderObserver } from '../orientation3d/orientationRenderObserver';
import { sceneAirframeFor } from '../orientation3d/airframeSceneModel';
import { useObservedAirframe } from '../session/useObservedAirframe';
import {
  deriveBatterySemantics,
  deriveOrientationViewState,
  deriveSetupArmingReadiness,
  deriveSetupBatterySummary,
  deriveSetupSafetyFlags,
  deriveSetupRebootRequired,
  deriveSetupSensorSummary,
  deriveSetupWarnings,
  isGpsPresent,
  isSetupSafetyStripWarranted,
  deriveSetupDiagnostics,
} from '../../core';
import type { OrientationViewOffset } from '../../core';

/**
 * SETUP P2: the navigation seam. Each callback opens the screen that OWNS
 * the corresponding configuration; Setup itself never writes any of it.
 * They are plain callbacks supplied by the tab shell (MainTabsScreen), so
 * this screen imports no navigator internals and no owner-screen
 * authority. Undefined means "no owner screen reachable in this host",
 * and the shortcut is then not rendered at all - never rendered inert.
 * The information itself is unaffected: it lives in the status area and
 * the grid, not in the link.
 */
type Props = NativeStackScreenProps<RootStackParamList, 'Setup'> & {
  readonly onOpenGps?: () => void;
  readonly onOpenReceiver?: () => void;
  readonly onOpenPower?: () => void;
  readonly onOpenSensors?: () => void;
  readonly active?: boolean;
};

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
   * NO SESSION MEANS NO SCREEN, and that is the wall rather than a bug.
   *
   * This route is registered in the navigator only while a flight
   * controller is verified (App.tsx), so arriving here without a key is
   * not a state the product has - it is the single render between a
   * board going away and react-navigation unmounting this route. There
   * used to be a whole connection workspace behind this branch; it was a
   * second place the application could strand somebody, and it is gone.
   * Rendering nothing for that one frame is the honest answer: there is
   * nothing to show about a board that is not there.
   */
  if (!sessionKey) {
    return <View testID="setup-awaiting-unmount" />;
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
  // Desktop tiers get the wider workspace envelope; narrower tiers keep
  // the 1180px reading cap. See useContentEnvelope.ts.
  const { tier, maxWidth: contentMaxWidth } = useContentEnvelope(true);
  /**
   * THE DESKTOP GUTTER, AND WHY IT IS NOT IN THE STYLESHEET.
   *
   * This screen's sections carry their own `marginHorizontal`, which was
   * the entire gutter while the container was capped and centred - there
   * was always dead ground outside it. Once the workspace reaches the
   * viewport edge, 12px stops reading as a margin.
   *
   * Applied at desktop tiers ONLY, and that is a measured decision, not
   * caution: put in the StyleSheet it took 16px off the content at 360,
   * 390, 430 and 768 as well, which is exactly the phone reflow this
   * change is not allowed to cause.
   */
  const workspaceGutter = isDesktopTier(tier) ? spacing.sm : 0;

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
  // Computed ONCE and threaded to the status area's arming chip, the
  // safety strip, the information grid and the FC-tool gate, so those
  // four surfaces cannot diverge - the same design Step 4 established,
  // now fed by evidence that actually exists.
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
  // The firmware's own battery enum, via the SAME semantics the status
  // chip and the grid render - no second mapping table. An unrecognised
  // raw value stays
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
  // SETUP R9: the battery, compressed to one chip and one grid column
  // without losing the HW-002 guard that keeps a residual
  // voltage-divider reading out of the pack-voltage slot. The rule lives
  // in core (setupStatusModel.ts) so a chip cannot quietly drop it.
  const batterySummary = deriveSetupBatterySummary(battery);
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
      {/* THE ONLY FIXED CHROME: 48px, back + title + connection dot +
          disconnect. The 139px teal bar that used to sit here is gone,
          and so is every fact it carried that was not chrome - those are
          in SetupStatusBar, the first thing inside the scroll below. */}
      <SetupChromeBar
        sessionId={sessionId}
        onBack={onBack}
        onDisconnect={handleDisconnect}
      />
      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { maxWidth: contentMaxWidth, paddingHorizontal: workspaceGutter },
        ]}>
        {/* ==============================================================
            SETUP R9 - THE ORDER, AND THE MEASUREMENT BEHIND IT.

            The previous revision opened with 139px of teal chrome, a
            52px readiness strip and an 84px section heading, put the 3D
            model at y=186, and then spent the next 1200px before
            reaching the aircraft's own state: Battery at y=1403,
            Sensors at y=1849, on a 1920px desktop with a fully
            populated board - 3353px of scroll in total. The same board
            now measures 2441px with the model at y=96.

            The order below puts every fact an operator checks on
            connecting ABOVE the model, and every measured value
            immediately BELOW it:

              1. compact status  - connection, board, firmware, API,
                                   arming, battery, detected sensors
              2. safety strip    - ONLY when armed or genuinely blocked
              3. 3D attitude hero with live heading/pitch/roll and the
                 accelerometer calibration action
              4. dense info grid - Status / GPS / Build, three columns
              5. board alignment - a feature, kept, but after the live
                 information rather than between the model and it
              6. advanced: safety notices, stability check, diagnostics,
                 FC tools, telemetry report

            Nothing was deleted from the product. Battery, RSSI, GPS and
            the FC status counters all live in the grid at step 4; the
            sensor mask lives in the status area at step 1 AND stays in
            the diagnostics disclosure at step 6, which is the one place
            the same fact appears twice - deliberately, because the
            disclosure is the detail view of it, not a second summary.
            ============================================================== */}

        {/* 1. THE COMPACT STATUS AREA. First content, not sticky chrome:
               on a phone an operator scrolls past it to the model, and
               on a desktop it never leaves the first viewport. */}
        <SetupStatusBar
          sessionId={sessionId}
          armingReadiness={armingReadiness}
          battery={batterySummary}
          sensors={sensorSummary}
          diagnostics={diagnosticsView}
        />

        {/* 2. THE SAFETY STRIP IS NOW AN ALERT, so it appears only when
               there is something to alert about (isSetupSafetyStripWarranted:
               ARMED or BLOCKED). READY and UNKNOWN are steady-state facts
               and read as a chip in the status area above - a permanent
               74px warning saying "arming state not confirmed" on a
               healthy board taught operators to ignore the strip. The
               readiness object itself is unchanged and still drives the
               chip, the FC-tool gate and the diagnostics list. */}
        {isSetupSafetyStripWarranted(armingReadiness) ? (
          <SafetyStrip readiness={armingReadiness} />
        ) : null}

        {/* 3. THE MODEL. Its 84px section heading is gone: the hero
               carries its own eyebrow and title, so the heading restated
               what the card beneath it already said, at the cost of a
               tenth of a phone viewport. */}
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

        {/* 4. THE DENSE GRID, directly under the model - Status, GPS and
               Build side by side on a desktop, stacking on a phone. This
               is what the four elevated telemetry cards became. */}
        <SetupInfoGrid
          armingReadiness={armingReadiness}
          battery={batterySummary}
          connected={connected}
          receiver={receiver}
          receiverChannelState={receiverChannelState}
          gps={gps}
          gpsChannelState={gpsChannelState}
          gpsPresent={gpsPresent}
          fcStatus={fcStatus}
          fcChannelState={fcChannelState}
          diagnostics={diagnosticsView}
          onOpenPower={onOpenPower}
          onOpenReceiver={onOpenReceiver}
          onOpenGps={onOpenGps}
          onOpenSensors={onOpenSensors}
        />

        {/* 5. BOARD ALIGNMENT stays a full feature and moves BELOW the
               live information. It used to sit between the model and
               everything measured, which put a configuration form in the
               middle of a reading surface. The reasoning that placed it
               near the model is unchanged - the model shows attitude the
               firmware has ALREADY corrected with these angles, so it can
               never reveal that they are wrong - and the card still says
               so in words; it simply no longer interrupts. */}
        <BoardAlignmentCard sessionKey={sessionKey} active={active} />

        {/* 6. ADVANCED, from here down. */}
        <SetupSectionHeading
          eyebrow={t('setupSections.maintenance.eyebrow')}
          title={t('setupSections.maintenance.title')}
          description={t('setupSections.maintenance.description')}
          testID="setup-maintenance-heading"
        />
        {/* DIAGNOSTICS, SECOND - not deleted, relocated.

            The full warning stack and the stability check used to open
            the page. They are still here in full, with the same
            component, the same canonical truth and the same wording; what
            changed is that the operator reaches their aircraft's state
            first and the analysis of it after. ARMING_DISABLED and every
            other blocker still surface at the top too, in the compact
            readiness strip beside the model. */}
        <SetupSafetyNotices warnings={setupWarnings} />
        <LiveOrientationStabilityPanel
          sessionKey={sessionKey}
          active={active}
        />
        <DiagnosticsSection view={diagnosticsView} />
        <FcToolsSection
          sessionId={sessionId}
          gate={fcToolGate}
          tools={['MAG_CALIBRATION', 'REBOOT']}
        />
        {/* THE TELEMETRY REPORT IS NOT AN OPERATOR CONTROL, and it is
            gone from this screen. It copied an engineering snapshot -
            poll ids, scheduler counters, render statistics - onto the
            clipboard of somebody flying a quadcopter. Nothing on it is
            actionable to them, and it occupied the foot of the one
            screen they use most.

            The REPORT ITSELF IS KEPT (platforms/telemetryReport.ts) for
            diagnostics and for the suites that assert its contents; what
            is gone is the button. */}
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
  /* M-F3F P0-B/§15 - THE AIRCRAFT, READ HERE.
     Setup does not go through Motors for this and does not import
     anything from it: it mounts the shared reader, which publishes into
     the one observed-airframe record and issues a read only if nobody
     has read this session yet. An operator who opens Setup first and
     never visits Motors still sees their own aircraft. */
  const observedAirframe = useObservedAirframe(
    connected ? sessionKey.sessionId : undefined,
  );
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
      airframe={sceneAirframeFor(observedAirframe)}
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
    /* No horizontal padding here: the desktop gutter is applied inline
       so it cannot reach a phone. See `workspaceGutter` above. */
    width: '100%',
    /* NO STATIC maxWidth. The cap is applied inline from
       useContentEnvelope, and on a desktop tier that value is
       `undefined` - which cannot override a StyleSheet entry, so a
       "fallback" here would silently pin the workspace at 1180. */
    alignSelf: 'center',
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
    marginTop: spacing.xs, maxWidth: PROSE_MEASURE},
});
