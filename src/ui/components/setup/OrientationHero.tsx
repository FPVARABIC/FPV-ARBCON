/**
 * Pass 7.4, Step 5 - Setup Region 2's hero: the live 3D orientation model
 * (OrientationRenderer.tsx, Step 2) + an artificial horizon and relative
 * direction compass + its 3 plain numeric readouts (roll/pitch/heading,
 * no timing metadata) + the "إعادة ضبط عرض الاتجاه" reset button + its
 * one-time hint. Every visual receives the SAME displayed sample; no
 * instrument owns a poll, timer, interpolation or protocol path. All
 * orientation math already happened upstream (deriveOrientationViewState()
 * - Step 1); this component only renders that OrientationViewState.
 *
 * STALE freezes the 3D model and readouts at their last LIVE values
 * (dimmed via OrientationRenderer's own `stale` prop) and shows
 * "البيانات متأخرة" - never fakes/interpolates, per this pass's own
 * explicit rule.
 *
 * LATEST SAMPLE WINS, WITH NO ANIMATION IN BETWEEN. The model is handed
 * the same `displayed` object the numeric readouts render, taken
 * straight from the newest genuine OrientationViewState. There is no
 * frame loop, no tween, no queue of pending poses and nothing that can
 * commit an older sample after a newer one has arrived. An earlier
 * revision eased the model between samples with requestAnimationFrame;
 * every frame of that easing rebuilt the whole 38-primitive Skia scene,
 * so on a real device the model fell progressively behind the readouts
 * instead of merely looking smoother. Truthful and current beats
 * smooth: see this pass's own commit message.
 *
 * hasSeenResetHint/onResetHintShown are OWNED BY THE CALLER (SetupScreen,
 * backed by SetupUiSessionStore) - this component only owns the
 * TRANSIENT "is the hint bubble currently visible" state, which does not
 * need to persist across remounts. This keeps the component decoupled
 * from SetupUiSessionStore entirely, testable via props alone - the same
 * pattern SafetyStrip.tsx/TopSystemBar.tsx already established.
 */

import React, { useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import { OrientationRenderer } from '../../orientation3d';
// Imported from its own module, not the orientation3d barrel: several
// screen-level suites jest.mock() that barrel down to OrientationRenderer
// alone (the Skia component cannot mount under Jest), and the
// diagnostics tracker must keep working in exactly those tests.
import { orientationLatencyTracker } from '../../orientation3d/orientationLatencyDebugLog';
// Checkpoint F: the ALWAYS-ON counterpart to the tracker above, which is
// __DEV__-gated and therefore silent in the build a user runs. Imported
// from its own module for the same reason the tracker is - screen suites
// jest.mock() the orientation3d barrel down to OrientationRenderer alone.
import { orientationRenderObserver } from '../../orientation3d/orientationRenderObserver';
import type { OrientationViewState } from '../../../core';
import { describeOrientationForAccessibility } from '../../../core';
import { colors, radii, spacing, typography } from '../../theme';
import {PROSE_MEASURE} from '../../theme';
import FlightInstruments, { roundHeadingDegrees } from './FlightInstruments';
import { ORIENTATION_DESKTOP_WORKSPACE_ENABLED } from './orientationHeroDesktopWorkspace';

const HERO_MAX_SIZE = 340;
/**
 * SETUP FINAL UI CORRECTION - THE PHONE COMPOSITION, DECIDED AGAIN.
 *
 * P3 put a 196px stage beside a 126px instrument rail to shrink the
 * hero's height. The accepted final direction reverses that priority:
 * the model is the primary orientation instrument and must be visually
 * dominant, with the horizon and relative-direction dials directly under
 * it and the accelerometer-calibration action immediately after - all
 * reachable without scrolling on a phone.
 *
 * So the phone stage is the full card width again (300px at 360,
 * 330px at 390, capped at 340), and the two dials sit side by side
 * BELOW it via the instruments' own 'row' layout - which also renders
 * them larger than the old 126px rail did. The model is still NOT
 * scaled: scene geometry, maths and rendering are untouched (P0's
 * explicit warning); only the box it is drawn into grew.
 */
const HERO_TABLET_MAX_SIZE = 410;
const HERO_MIN_SIZE = 180;
const SIDEBAR_LAYOUT_MIN_WIDTH = 620;
const DESKTOP_WORKSPACE_MIN_WIDTH = 1024;
/**
 * 430, not 512: at 1024x768 the old 512px stage alone consumed the fold,
 * pushing the dials and the calibration action off screen. 430 keeps the
 * model unmistakably dominant while the calibration card that now
 * follows the hero stays reachable without scrolling on the shortest
 * desktop tier.
 */
const DESKTOP_STAGE_MAX_HEIGHT = 430;
const DESKTOP_INSTRUMENT_RAIL_WIDTH = 128;
const DESKTOP_WORKSPACE_GAP = 12;
const DESKTOP_MODEL_SCALE = 0.56 / 0.37;

/**
 * Keeps the model inside a narrow phone while letting it breathe on the
 * tablet used for the real bench. The 60px allowance is the card's own
 * horizontal margin and padding; the upper bound avoids an oversized GPU
 * surface on a wide tablet.
 */
export function shouldUseOrientationSidebar(
  windowWidth: number,
  fontScale = 1,
): boolean {
  const safeScale =
    Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  return Number.isFinite(windowWidth) && windowWidth / safeScale >= SIDEBAR_LAYOUT_MIN_WIDTH;
}

export function computeOrientationHeroSize(
  windowWidth: number,
  sidebar = false,
): number {
  const usableWidth = Number.isFinite(windowWidth)
    ? windowWidth - (sidebar ? 220 : 60)
    : 260;
  return Math.min(
    sidebar ? HERO_TABLET_MAX_SIZE : HERO_MAX_SIZE,
    Math.max(HERO_MIN_SIZE, usableWidth),
  );
}

export interface OrientationWorkspaceLayout {
  readonly expanded: boolean;
  readonly stageWidth: number;
  readonly stageHeight: number;
  readonly presentationScale: number | undefined;
}

export function computeOrientationWorkspaceLayout(
  windowWidth: number,
  fontScale: number,
  measuredVisualsWidth: number | undefined,
  desktopEnabled = ORIENTATION_DESKTOP_WORKSPACE_ENABLED,
): OrientationWorkspaceLayout {
  const safeScale = Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  const effective = Number.isFinite(windowWidth) ? windowWidth / safeScale : 0;
  const sidebar = shouldUseOrientationSidebar(windowWidth, fontScale);
  const compactSize = computeOrientationHeroSize(windowWidth, sidebar);
  const estimatedWidth = Math.min(1540, Math.max(0, Number.isFinite(windowWidth) ? windowWidth - 60 : 0));
  const measured = measuredVisualsWidth !== undefined && Number.isFinite(measuredVisualsWidth) && measuredVisualsWidth > 0
    ? Math.min(measuredVisualsWidth, estimatedWidth)
    : estimatedWidth;
  const minimumRowWidth = HERO_TABLET_MAX_SIZE + DESKTOP_INSTRUMENT_RAIL_WIDTH + DESKTOP_WORKSPACE_GAP;
  if (!desktopEnabled || effective < DESKTOP_WORKSPACE_MIN_WIDTH || measured < minimumRowWidth) {
    return { expanded: false, stageWidth: compactSize, stageHeight: compactSize, presentationScale: undefined };
  }
  const stageWidth = Math.floor(measured - DESKTOP_INSTRUMENT_RAIL_WIDTH - DESKTOP_WORKSPACE_GAP);
  return { expanded: true, stageWidth, stageHeight: Math.min(stageWidth, DESKTOP_STAGE_MAX_HEIGHT), presentationScale: DESKTOP_MODEL_SCALE };
}

/** Roll/pitch arrive in 0.1 degree units. Keeping that one decimal makes
 * a small visible model tilt explainable instead of showing a rounded 0°.
 * Heading is still whole-degree wire data and is formatted separately. */
export function formatTiltDegrees(value: number): string {
  const normalized = Math.abs(value) < 0.05 ? 0 : value;
  const oneDecimal = Math.round(normalized * 10) / 10;
  return Number.isInteger(oneDecimal)
    ? `${oneDecimal}°`
    : `${oneDecimal.toFixed(1)}°`;
}

export interface OrientationHeroProps {
  orientationView: OrientationViewState;
  hasSeenResetHint: boolean;
  /** Composite session identity ({sessionId}:{generation}), used only to
   * scope the development-only latency diagnostics - a sample sequence
   * is meaningless across sessions. Nothing about what is drawn depends
   * on it. */
  sessionToken?: string;
  /** Which genuine sample `orientationView` came from
   * (TelemetryValue.sampleSeq). Diagnostics only. */
  sampleSeq?: number;
  /** The scheduler's own publication stamp for that sample
   * (TelemetryValue.updatedAtMs). Diagnostics only. */
  sampleReceivedAt?: number;
  /** The display-only Heading reset needs a FRESH sample from a session
   * that is still active in order to capture a reference. Optional and
   * defaulting to true so existing callers/tests are unaffected; the real
   * screen passes the computed availability. */
  canReset?: boolean;
  onResetView: () => void;
  onResetHintShown: () => void;
  /**
   * FINAL UI CORRECTION: the accelerometer-calibration surface, rendered
   * DIRECTLY after the model and dials so leveling the aircraft while
   * watching the model and pressing calibrate happens in one screenful.
   * An opaque slot on purpose - this component stays presentational and
   * controller-free; SetupScreen owns what goes here
   * (OrientationCalibrationCard). Rendered in every status branch, so a
   * blocked calibration still shows its causal reason before telemetry
   * flows.
   */
  calibrationSlot?: React.ReactNode;
}

export default function OrientationHero({
  orientationView,
  hasSeenResetHint,
  sessionToken,
  sampleSeq,
  sampleReceivedAt,
  canReset = true,
  onResetView,
  onResetHintShown,
  calibrationSlot,
}: OrientationHeroProps): React.JSX.Element {
  const { t } = useTranslation();
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const sidebar = shouldUseOrientationSidebar(windowWidth, fontScale);
  const [measuredVisualsWidth, setMeasuredVisualsWidth] = useState<number>();
  const workspace = computeOrientationWorkspaceLayout(windowWidth, fontScale, measuredVisualsWidth);
  // FINAL UI CORRECTION: on a phone the stage is the full card width
  // (dominant), with the dials on their own row directly beneath it.
  const heroSize = workspace.stageWidth;
  const heroHeight = workspace.stageHeight;
  const instrumentStageWidth = sidebar ? 156 : heroSize;
  const instrumentsLayout = sidebar ? 'sidebar' : 'row';
  const [hintVisible, setHintVisible] = useState(false);
  const handleVisualsLayout = (event: LayoutChangeEvent) => {
    const measured = event.nativeEvent.layout.width;
    setMeasuredVisualsWidth(current => current === measured ? current : measured);
  };
  const visualsStyle = [
    styles.visuals,
    sidebar && styles.visualsSidebar,
    workspace.expanded && styles.visualsDesktop,
  ];

  const handleReset = () => {
    // Rejected, not merely visually disabled: a press delivered while the
    // control is unavailable must capture nothing at all.
    if (!canReset) {
      return;
    }
    onResetView();
    if (!hasSeenResetHint) {
      setHintVisible(true);
      onResetHintShown();
    }
  };

  const renderHeader = (status: 'LIVE' | 'STALE' | 'WAITING' | 'ERROR') => {
    const labelKey =
      status === 'LIVE'
        ? 'orientationHero.live'
        : status === 'STALE'
        ? 'orientationHero.staleLabel'
        : status === 'WAITING'
        ? 'orientationHero.waitingLabel'
        : 'orientationHero.unavailableLabel';
    const isStaleStatus = status === 'STALE';
    const isErrorStatus = status === 'ERROR';

    return (
      <View style={styles.headerRow}>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>{t('orientationHero.eyebrow')}</Text>
          <Text style={styles.title}>{t('orientationHero.title')}</Text>
        </View>
        <View
          style={[
            styles.liveBadge,
            status !== 'LIVE' && styles.inactiveBadge,
            isStaleStatus && styles.staleBadge,
            isErrorStatus && styles.errorBadge,
          ]}
          testID="orientation-hero-status-badge"
        >
          <View
            style={[
              styles.liveDot,
              status !== 'LIVE' && styles.inactiveDot,
              isStaleStatus && styles.staleDot,
              isErrorStatus && styles.errorDot,
            ]}
          />
          <Text
            style={[
              styles.liveText,
              status !== 'LIVE' && styles.inactiveText,
              isStaleStatus && styles.staleText,
              isErrorStatus && styles.errorText,
            ]}
          >
            {t(labelKey)}
          </Text>
        </View>
      </View>
    );
  };

  // Checkpoint F: recorded BEFORE the two pose-less early returns below,
  // so a report can never say "STALE" while this component is actually
  // rendering the error state (see orientationRenderObserver.ts's own
  // noteHeroSample doc comment - that exact contradiction was observed
  // and is what this placement fixes).
  orientationRenderObserver.noteHeroSample(
    sessionToken,
    sampleSeq,
    orientationView.status,
    orientationView.status === 'LIVE' || orientationView.status === 'STALE'
      ? {
          rollDeg: orientationView.rollDeg,
          pitchDeg: orientationView.pitchDeg,
          yawDeg: orientationView.yawDeg,
        }
      : undefined,
  );

  if (orientationView.status === 'WAITING') {
    return (
      <View style={styles.container} testID="orientation-hero-waiting">
        {renderHeader('WAITING')}
        <View style={visualsStyle} onLayout={handleVisualsLayout}>
          <View
            style={[
              styles.rendererWrapper,
              { width: heroSize, height: heroHeight },
            ]}
          >
            <Text style={styles.messageText}>{t('orientationHero.waiting')}</Text>
          </View>
          <FlightInstruments
            status="WAITING"
            stageWidth={instrumentStageWidth}
            fontScale={fontScale}
            layout={instrumentsLayout}
            sizeScale={sidebar ? 0.8 : 1}
          />
        </View>
        {calibrationSlot}
      </View>
    );
  }

  if (orientationView.status === 'ERROR') {
    return (
      <View style={styles.container} testID="orientation-hero-error">
        {renderHeader('ERROR')}
        <View style={visualsStyle} onLayout={handleVisualsLayout}>
          <View
            style={[
              styles.rendererWrapper,
              { width: heroSize, height: heroHeight },
            ]}
          >
            <Text style={[styles.messageText, { color: colors.error }]}>
              {t('orientationHero.error')}
            </Text>
          </View>
          <FlightInstruments
            status="ERROR"
            stageWidth={instrumentStageWidth}
            fontScale={fontScale}
            layout={instrumentsLayout}
            sizeScale={sidebar ? 0.8 : 1}
          />
        </View>
        {calibrationSlot}
      </View>
    );
  }

  const isStale = orientationView.status === 'STALE';
  const accessibilityText =
    describeOrientationForAccessibility(orientationView);

  // THE displayed sample. One object, built once, handed to the model
  // and read by the numeric readouts below - so "the number and the
  // model disagree" is not a state this component can even represent.
  const displayed = {
    rollDeg: orientationView.rollDeg,
    pitchDeg: orientationView.pitchDeg,
    yawDeg: orientationView.yawDeg,
  };

  // Development-only latency stamp. Deliberately during render rather
  // than in an effect: an effect would measure when React got round to
  // running effects, not when this sample reached the model. The tracker
  // is a no-op outside __DEV__, is idempotent per sample, and schedules
  // nothing.
  const sampleIdentity =
    sessionToken !== undefined && sampleSeq !== undefined
      ? { sessionToken, sampleSeq }
      : undefined;
  if (sampleIdentity !== undefined) {
    orientationLatencyTracker.noteHeroSample(
      sampleIdentity,
      sampleReceivedAt ?? 0,
      orientationView.status,
      displayed,
    );
  }

  /** The three numeric truths, on their own full-width row under the
   * visuals on every tier. */
  const renderReadouts = () => (
    <View style={styles.readoutsRow}>
      <View style={styles.readout} testID="orientation-hero-roll">
        <Text style={styles.readoutLabel}>
          {t('orientationHero.rollLabel')}
        </Text>
        <Text style={styles.readoutValue}>
          {formatTiltDegrees(displayed.rollDeg)}
        </Text>
      </View>
      <View style={styles.readout} testID="orientation-hero-pitch">
        <Text style={styles.readoutLabel}>
          {t('orientationHero.pitchLabel')}
        </Text>
        <Text style={styles.readoutValue}>
          {formatTiltDegrees(displayed.pitchDeg)}
        </Text>
      </View>
      <View style={styles.readout} testID="orientation-hero-heading">
        <Text style={styles.readoutLabel}>
          {t('orientationHero.headingLabel')}
        </Text>
        <Text style={styles.readoutValue}>{`${roundHeadingDegrees(
          displayed.yawDeg,
        )}°`}</Text>
      </View>
    </View>
  );

  return (
    <View style={styles.container} testID="orientation-hero">
      {renderHeader(isStale ? 'STALE' : 'LIVE')}
      <View style={visualsStyle} onLayout={handleVisualsLayout}>
        <View
          style={[
            styles.rendererWrapper,
            { width: heroSize, height: heroHeight },
          ]}
          accessible
          accessibilityLabel={accessibilityText}
          testID="orientation-hero-renderer-wrapper"
        >
          <OrientationRenderer
            // The latest GENUINE sample, directly. No animation, no
            // queue, no pending target: a newer sample simply replaces
            // this prop, so an older pose can never be drawn after a
            // newer one.
            orientation={displayed}
            width={heroSize}
            height={heroHeight}
            presentationScale={workspace.presentationScale}
            stale={isStale}
            sampleIdentity={sampleIdentity}
          />
        </View>

        <FlightInstruments
          status={isStale ? 'STALE' : 'LIVE'}
          stageWidth={instrumentStageWidth}
          fontScale={fontScale}
          layout={instrumentsLayout}
          sizeScale={sidebar ? 0.8 : 1}
          rollDeg={displayed.rollDeg}
          pitchDeg={displayed.pitchDeg}
          headingDeg={displayed.yawDeg}
        />
      </View>

      {/* The one action that belongs to this view: level, watch, press. */}
      {calibrationSlot}

      {isStale && (
        <Text style={styles.staleLabel} testID="orientation-hero-stale-label">
          {t('orientationHero.staleLabel')}
        </Text>
      )}

      {renderReadouts()}

      {/* Heading here is a RELATIVE direction, not magnetic north: this
          app never claims a compass it cannot prove, and after the
          display-only reset the number is explicitly relative to the
          captured reference. */}
      <Text
        style={styles.headingNoteText}
        testID="orientation-hero-heading-note"
      >
        {t('orientationHero.headingRelativeNote')}
      </Text>

      <Pressable
        onPress={handleReset}
        disabled={!canReset}
        accessibilityRole="button"
        accessibilityState={{ disabled: !canReset }}
        accessibilityLabel={t('orientationHero.resetButton')}
        style={
          canReset
            ? styles.resetButton
            : [styles.resetButton, styles.resetButtonDisabled]
        }
        testID="orientation-hero-reset-button"
      >
        <Text
          style={
            canReset
              ? styles.resetButtonText
              : [styles.resetButtonText, styles.resetButtonTextDisabled]
          }
        >
          {t('orientationHero.resetButton')}
        </Text>
      </Pressable>
      {!canReset && (
        <Text
          style={styles.resetUnavailableText}
          testID="orientation-hero-reset-unavailable"
        >
          {t('orientationHero.resetUnavailable')}
        </Text>
      )}

      {hintVisible && (
        <View style={styles.hintBanner} testID="orientation-hero-reset-hint">
          <Text style={styles.hintText}>{t('orientationHero.resetHint')}</Text>
          <Pressable
            onPress={() => setHintVisible(false)}
            accessibilityRole="button"
            accessibilityLabel={t('orientationHero.resetHintDismiss')}
            style={styles.hintDismiss}
            testID="orientation-hero-reset-hint-dismiss"
          >
            <Text style={styles.hintDismissText}>
              {t('orientationHero.resetHintDismiss')}
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    marginHorizontal: spacing.md,
    marginTop: spacing.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    shadowColor: colors.shadow,
    shadowOpacity: 0.22,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 7 },
    elevation: 4,
  },
  messageText: {
    ...typography.body,
    color: colors.textSecondary, maxWidth: PROSE_MEASURE},
  rendererWrapper: {
    marginTop: spacing.sm,
    flexShrink: 0,
    borderRadius: radii.lg,
    overflow: 'hidden',
    backgroundColor: colors.backgroundRaised,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  visuals: {
    width: '100%',
    alignItems: 'center',
  },
  visualsSidebar: {
    /* `direction` was here too. react-native-web rejects it outright
       ("Invalid style property of 'direction'"), so it only ever applied
       on Android and the two platforms disagreed. A plain row follows the
       surrounding layout consistently on both. */
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.md,
  },
  visualsDesktop: { justifyContent: 'flex-start' },
  headerRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  headerCopy: {
    flex: 1,
    minWidth: 0,
  },
  eyebrow: {
    ...typography.eyebrow,
    color: colors.accentStrong,
  },
  title: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    marginTop: 1,
  },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.accentStrong,
  },
  staleBadge: {
    backgroundColor: colors.backgroundRaised,
    borderColor: colors.warning,
  },
  inactiveBadge: {
    backgroundColor: colors.backgroundRaised,
    borderColor: colors.border,
  },
  errorBadge: {
    borderColor: colors.error,
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    marginEnd: spacing.sm,
    backgroundColor: colors.success,
  },
  staleDot: {
    backgroundColor: colors.warning,
  },
  inactiveDot: {
    backgroundColor: colors.textMuted,
  },
  errorDot: {
    backgroundColor: colors.error,
  },
  liveText: {
    ...typography.caption,
    color: colors.accentStrong,
    fontWeight: '700',
  },
  staleText: {
    color: colors.warning,
  },
  inactiveText: {
    color: colors.textSecondary,
  },
  errorText: {
    color: colors.error,
  },
  staleLabel: {
    ...typography.caption,
    color: colors.warning,
    marginTop: spacing.xs,
    fontWeight: '600',
  },
  readoutsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
    marginTop: spacing.lg,
    gap: spacing.sm,
  },
  readout: {
    alignItems: 'center',
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radii.sm,
    backgroundColor: colors.backgroundRaised,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  readoutLabel: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  readoutValue: {
    ...typography.title,
    color: colors.accentStrong,
    marginTop: spacing.xs / 2,
  },
  resetButton: {
    marginTop: spacing.lg,
    minHeight: 44,
    width: '100%',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.accentStrong,
    borderRadius: radii.md,
    backgroundColor: colors.accentSoft,
  },
  headingNoteText: {
    ...typography.caption,
    color: colors.textSecondary,
    textAlign: 'center',
    marginTop: spacing.xs,
  },
  resetButtonDisabled: {
    opacity: 0.45,
  },
  resetButtonTextDisabled: {
    color: colors.textSecondary,
  },
  resetUnavailableText: {
    ...typography.caption,
    color: colors.textSecondary,
    textAlign: 'center',
    marginTop: spacing.xs,
  },
  resetButtonText: {
    ...typography.body,
    color: colors.accentStrong,
    fontWeight: '700',
  },
  hintBanner: {
    marginTop: spacing.sm,
    width: '100%',
    padding: spacing.md,
    backgroundColor: colors.backgroundRaised,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderSoft,
  },
  hintText: {
    ...typography.caption,
    color: colors.textSecondary, maxWidth: PROSE_MEASURE},
  hintDismiss: {
    marginTop: spacing.sm,
    alignSelf: 'flex-end',
    minHeight: 44,
    justifyContent: 'center',
  },
  hintDismissText: {
    ...typography.caption,
    color: colors.accentStrong,
    fontWeight: '600', maxWidth: PROSE_MEASURE},
});
