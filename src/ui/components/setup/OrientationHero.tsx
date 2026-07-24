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
import type {OrientationViewState} from '../../../core';
import {describeOrientationForAccessibility} from '../../../core';
import {colors, radii, spacing, typography} from '../../theme';

const HERO_SIZE = 260;

export interface OrientationHeroProps {
  orientationView: OrientationViewState;
  hasSeenResetHint: boolean;
  onResetView: () => void;
  onResetHintShown: () => void;
}

export default function OrientationHero({
  orientationView,
  hasSeenResetHint,
  onResetView,
  onResetHintShown,
}: OrientationHeroProps): React.JSX.Element {
  const {t} = useTranslation();
  const [hintVisible, setHintVisible] = useState(false);

  const handleReset = () => {
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

  return (
    <View style={styles.container} testID="orientation-hero">
      <View
        style={styles.rendererWrapper}
        accessible
        accessibilityLabel={accessibilityText}
        testID="orientation-hero-renderer-wrapper">
        <OrientationRenderer
          orientation={{rollDeg: orientationView.rollDeg, pitchDeg: orientationView.pitchDeg, yawDeg: orientationView.yawDeg}}
          width={HERO_SIZE}
          height={HERO_SIZE}
          stale={isStale}
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
          <Text style={styles.readoutValue}>{`${Math.round(orientationView.rollDeg)}°`}</Text>
        </View>
        <View style={styles.readout} testID="orientation-hero-pitch">
          <Text style={styles.readoutLabel}>{t('orientationHero.pitchLabel')}</Text>
          <Text style={styles.readoutValue}>{`${Math.round(orientationView.pitchDeg)}°`}</Text>
        </View>
        <View style={styles.readout} testID="orientation-hero-heading">
          <Text style={styles.readoutLabel}>{t('orientationHero.headingLabel')}</Text>
          <Text style={styles.readoutValue}>{`${Math.round(orientationView.yawDeg)}°`}</Text>
        </View>
      </View>

      <Pressable
        onPress={handleReset}
        accessibilityRole="button"
        accessibilityLabel={t('orientationHero.resetButton')}
        style={styles.resetButton}
        testID="orientation-hero-reset-button">
        <Text style={styles.resetButtonText}>{t('orientationHero.resetButton')}</Text>
      </Pressable>

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
