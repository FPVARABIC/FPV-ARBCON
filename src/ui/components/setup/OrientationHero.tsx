/**
 * Pass 7.4, Step 5 - Setup Region 2's hero: the live 3D orientation model
 * (OrientationRenderer.tsx, Step 2) + its 3 plain numeric readouts (roll/
 * pitch/heading, no timing metadata) + the "إعادة ضبط عرض الاتجاه" reset
 * button + its one-time hint. All orientation math already happened
 * upstream (deriveOrientationViewState() - Step 1); this component only
 * renders whatever OrientationViewState it is given.
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

import React, {useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useTranslation} from 'react-i18next';

import {OrientationRenderer} from '../../orientation3d';
// Imported from its own module, not the orientation3d barrel: several
// screen-level suites jest.mock() that barrel down to OrientationRenderer
// alone (the Skia component cannot mount under Jest), and the
// diagnostics tracker must keep working in exactly those tests.
import {orientationLatencyTracker} from '../../orientation3d/orientationLatencyDebugLog';
import type {OrientationViewState} from '../../../core';
import {describeOrientationForAccessibility} from '../../../core';
import {colors, radii, spacing, typography} from '../../theme';

const HERO_SIZE = 260;

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
}: OrientationHeroProps): React.JSX.Element {
  const {t} = useTranslation();
  const [hintVisible, setHintVisible] = useState(false);

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

  if (orientationView.status === 'WAITING') {
    return (
      <View style={styles.container} testID="orientation-hero-waiting">
        <Text style={styles.messageText}>{t('orientationHero.waiting')}</Text>
      </View>
    );
  }

  if (orientationView.status === 'ERROR') {
    return (
      <View style={styles.container} testID="orientation-hero-error">
        <Text style={[styles.messageText, {color: colors.error}]}>{t('orientationHero.error')}</Text>
      </View>
    );
  }

  const isStale = orientationView.status === 'STALE';
  const accessibilityText = describeOrientationForAccessibility(orientationView);

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
    sessionToken !== undefined && sampleSeq !== undefined ? {sessionToken, sampleSeq} : undefined;
  if (sampleIdentity !== undefined) {
    orientationLatencyTracker.noteHeroSample(
      sampleIdentity,
      sampleReceivedAt ?? 0,
      orientationView.status,
      displayed,
    );
  }

  return (
    <View style={styles.container} testID="orientation-hero">
      <View
        style={styles.rendererWrapper}
        accessible
        accessibilityLabel={accessibilityText}
        testID="orientation-hero-renderer-wrapper">
        <OrientationRenderer
          // The latest GENUINE sample, directly. No animation, no queue,
          // no pending target: a newer sample simply replaces this prop,
          // so an older pose can never be drawn after a newer one.
          orientation={displayed}
          width={HERO_SIZE}
          height={HERO_SIZE}
          stale={isStale}
          sampleIdentity={sampleIdentity}
        />
      </View>

      {isStale && (
        <Text style={styles.staleLabel} testID="orientation-hero-stale-label">
          {t('orientationHero.staleLabel')}
        </Text>
      )}

      <View style={styles.readoutsRow}>
        <View style={styles.readout} testID="orientation-hero-roll">
          <Text style={styles.readoutLabel}>{t('orientationHero.rollLabel')}</Text>
          <Text style={styles.readoutValue}>{`${Math.round(displayed.rollDeg)}°`}</Text>
        </View>
        <View style={styles.readout} testID="orientation-hero-pitch">
          <Text style={styles.readoutLabel}>{t('orientationHero.pitchLabel')}</Text>
          <Text style={styles.readoutValue}>{`${Math.round(displayed.pitchDeg)}°`}</Text>
        </View>
        <View style={styles.readout} testID="orientation-hero-heading">
          <Text style={styles.readoutLabel}>{t('orientationHero.headingLabel')}</Text>
          <Text style={styles.readoutValue}>{`${Math.round(displayed.yawDeg)}°`}</Text>
        </View>
      </View>

      {/* Heading here is a RELATIVE direction, not magnetic north: this
          app never claims a compass it cannot prove, and after the
          display-only reset the number is explicitly relative to the
          captured reference. */}
      <Text style={styles.headingNoteText} testID="orientation-hero-heading-note">
        {t('orientationHero.headingRelativeNote')}
      </Text>

      <Pressable
        onPress={handleReset}
        disabled={!canReset}
        accessibilityRole="button"
        accessibilityState={{disabled: !canReset}}
        accessibilityLabel={t('orientationHero.resetButton')}
        style={canReset ? styles.resetButton : [styles.resetButton, styles.resetButtonDisabled]}
        testID="orientation-hero-reset-button">
        <Text style={canReset ? styles.resetButtonText : [styles.resetButtonText, styles.resetButtonTextDisabled]}>
          {t('orientationHero.resetButton')}
        </Text>
      </Pressable>
      {!canReset && (
        <Text style={styles.resetUnavailableText} testID="orientation-hero-reset-unavailable">
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
            testID="orientation-hero-reset-hint-dismiss">
            <Text style={styles.hintDismissText}>{t('orientationHero.resetHintDismiss')}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.lg,
  },
  messageText: {
    ...typography.body,
    color: colors.textSecondary,
  },
  rendererWrapper: {
    width: HERO_SIZE,
    height: HERO_SIZE,
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
    marginTop: spacing.md,
  },
  readout: {
    alignItems: 'center',
    flex: 1,
  },
  readoutLabel: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  readoutValue: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
    marginTop: spacing.xs / 2,
  },
  resetButton: {
    marginTop: spacing.md,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radii.sm,
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
    color: colors.accent,
    fontWeight: '600',
  },
  hintBanner: {
    marginTop: spacing.sm,
    width: '100%',
    padding: spacing.md,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radii.sm,
  },
  hintText: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  hintDismiss: {
    marginTop: spacing.sm,
    alignSelf: 'flex-end',
    minHeight: 44,
    justifyContent: 'center',
  },
  hintDismissText: {
    ...typography.caption,
    color: colors.accent,
    fontWeight: '600',
  },
});
